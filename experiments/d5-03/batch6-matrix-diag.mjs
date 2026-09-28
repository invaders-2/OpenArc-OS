/**
 * D5-03 第六批 · 矩阵会话状态机诊断（identity/reset-installation 之后的门禁相位）。
 *
 * 起因：auth-error-matrix.cjs 在「设置面测完 → 换配置 → reset-installation → reload」之后
 * 观察到落地页不是初始化向导，而是登录页（data-identity-gate=unauthenticated），
 * 而第五批 V2b 用同样的 reset+reload 能得到 uninitialized。本脚本把这一段单独拆出来，
 * 逐步记录 identity/status 与门禁相位，判定是"重置没生效"还是"启动询问走了另一条分支"。
 *
 * 边界：真机 electron .（隔离 userData）；查库只读；不连第三方；不改产品代码。
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const RUN_ARTIFACTS = require(path.join(here, "run-artifacts.cjs"));
const OWNERSHIP = require(path.join(here, "userdata-ownership.cjs"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = [];
const _log = console.log.bind(console);
console.log = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); LOG.push(s); _log(s); };
const ADMIN = { id: "admin@d503f-diag.test", pw: "diag-admin-1" };
const CDP_BASE = Number(process.env.OA_D503F_DIAG_CDP_PORT || 9901);

let RUN = null;
async function main() {
  RUN = await RUN_ARTIFACTS.createRun({ root: ROOT, script: "batch6-matrix-diag", basePort: CDP_BASE, envBaseVar: "OA_D503F_DIAG_CDP_PORT", userDataPrefixBase: "oa-d503b-" });
  const dir = OWNERSHIP.createOwnedDir({ prefix: RUN.userDataPrefix, kind: "electron-userdata/diag", runId: RUN.runId });
  const requested = CDP_BASE;
  const reservation = await RUN.acquirePort(requested);
  const cdpPort = reservation.port;
  await reservation.release();
  const child = spawn(electronPath, [".", "--user-data-dir=" + dir, "--remote-debugging-port=" + cdpPort, "--no-sandbox", "--disable-gpu-sandbox", "--in-process-gpu"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OPENARC_IDENTITY_ADMIN: "1" } });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += String(d); });
  console.log("本次运行：" + RUN.runId + " → " + RUN.runDirRel + "（cdp " + cdpPort + "）");

  let version = null; const deadline = Date.now() + 60000;
  while (!version && Date.now() < deadline) { try { version = await (await fetch("http://127.0.0.1:" + cdpPort + "/json/version")).json(); } catch { await sleep(300); } }
  const browser = await chromium.connectOverCDP("http://127.0.0.1:" + cdpPort);
  const ctx = browser.contexts()[0];
  let page = null; const end = Date.now() + 40000;
  while (!page && end > Date.now()) { page = ctx.pages().find((p) => p.url().includes("dist/index.html")) || null; if (!page) await sleep(300); }
  if (!page) throw new Error("未找到界面页面");

  const js = (code) => page.evaluate("(async () => { " + code + " })()");
  const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
  const textOf = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? (el.textContent || '') : '';");
  const waitFor = async (fn, timeout = 20000, iv = 120) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return true; } catch { /* retry */ } if (Date.now() - t0 >= timeout) return false; await sleep(iv); } };
  const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
  const status = () => js("return await window.openarc.identity.command({ type: 'identity/status' });");
  const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
  const clickSel = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");
  const installState = () => js("return { gate: document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root', hasSetup: !!document.querySelector('[data-d3-id=\"setup-name\"]'), hasLogin: !!document.querySelector('[data-d3-id=\"login-identifier\"]'), authError: (document.querySelector('[data-d3-id=\"auth-error\"]') || {}).textContent || null };");

  const STEPS = [];
  const rec = (id, note, data) => { const row = { id, note, data, at: new Date().toISOString() }; STEPS.push(row); console.log("· " + id + " — " + note + " " + JSON.stringify(data)); return row; };

  const waitGate = (want, ms) => waitFor(async () => (await gate()) === want, ms, 200);

  const boot0 = await installState();
  await waitGate("uninitialized", 30000);
  rec("D0", "首启（隔离 userData）门禁 = uninitialized", { boot0, now: await installState(), status: await status() });

  /* 走完向导 + 登录（与矩阵单元格完全同一条路径） */
  await js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b;");
  await waitFor(() => has('[data-d3-id="setup-name"]'), 30000, 200);
  await setInput('[data-d3-id="setup-name"]', "D5-03F 诊断");
  await clickSel('[data-d3-id="setup-next"]'); await sleep(500);
  await waitFor(() => has('[data-d3-id="setup-identifier"]'), 10000, 200);
  await setInput('[data-d3-id="setup-identifier"]', ADMIN.id);
  await clickSel('[data-d3-id="setup-next"]'); await sleep(500);
  await waitFor(() => has('[data-d3-id="setup-password"]'), 10000, 200);
  await setInput('[data-d3-id="setup-password"]', ADMIN.pw);
  await setInput('[data-d3-id="setup-confirm"]', ADMIN.pw);
  await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-submit\"]'); return !!b && !b.disabled;"), 10000, 150);
  await clickSel('[data-d3-id="setup-submit"]');
  const ready = await waitGate("unauthenticated", 30000);
  await setInput('[data-d3-id="login-identifier"]', ADMIN.id);
  await setInput('[data-d3-id="login-password"]', ADMIN.pw);
  await clickSel('[data-d3-id="login-submit"]');
  const loggedIn = await waitGate("ready", 60000);
  rec("D1", "向导提交 → 登录页 → 登录成功（ready）", { ready, loggedIn, state: await installState(), status: await status() });

  /* 设置面：制造一条真实错误行（与矩阵同路径） */
  await js("const el = document.querySelector('.dock-item[data-dock-id=\"settings\"]'); if (el) el.click(); return !!el;");
  await waitFor(() => has("[data-settings-active]"), 15000, 200);
  await setInput('[data-d3-id="settings-name"]', "很长的显示名".repeat(20));
  await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"settings-save\"]'); return !!b && !b.disabled;"), 6000, 120);
  await clickSel('[data-d3-id="settings-save"]');
  await waitFor(async () => (await textOf('[data-d3-id="settings-error"]')).trim().length > 0, 8000, 150);
  rec("D2", "设置面制造错误行（与矩阵路径一致）", { authError: (await textOf('[data-d3-id="settings-error"]')).trim(), status: await status() });

  /* 关键一步：reset-installation */
  const beforeStatus = await status();
  const reset = await js("return await window.openarc.identity.command({ type: 'identity/reset-installation', confirm: 'DELETE-ALL-IDENTITY-DATA' });");
  const afterStatus = await status();
  rec("D3", "reset-installation 之后、**未 reload** 的 status", { reset, beforeStatus, afterStatus, initialized: afterStatus?.initialized, statusText: afterStatus?.status });

  await page.reload().catch(() => {});
  const reachedUninit = await waitGate("uninitialized", 25000);
  const state1 = await installState();
  const status1 = await status();
  rec("D4", "reload 之后门禁相位", { reachedUninit, state: state1, status: status1 });

  /* ── D7–D12：复现矩阵单元格「改动壁纸 → reset → reload → 向导错误行」的完整转场 ── */
  /* D7：在真实设置面板把壁纸从 theme-dark 换成 theme-light（矩阵 applyCell 的同一步） */
  const wallBefore = await js("return document.querySelector('.desktop').getAttribute('data-wallpaper');");
  const wallClick = await js("const w = document.querySelector('[data-settings-active]')?.closest('.window'); if (!w) return 'missing'; const b = w.querySelector(" + JSON.stringify('.wallpaper-option[data-wallpaper="theme-light"]') + "); if (!b) return 'no-tile'; b.click(); return 'ok';");
  const wallAfter = await waitFor(async () => (await js("return document.querySelector('.desktop').getAttribute('data-wallpaper');")) === "theme-light", 6000, 150);
  rec("D7", "设置面板换壁纸 theme-dark → theme-light", { wallBefore, wallClick, wallAfter, now: await js("return document.querySelector('.desktop').getAttribute('data-wallpaper');") });

  /* D8：reset（未 reload） */
  const reset2 = await js("return await window.openarc.identity.command({ type: 'identity/reset-installation', confirm: 'DELETE-ALL-IDENTITY-DATA' });");
  rec("D8", "换壁纸后 reset-installation（未 reload）", { reset2, status: await status() });

  /* D9：reload → 门禁相位 */
  await page.reload().catch(() => {});
  const back1 = await waitGate("uninitialized", 25000);
  rec("D9", "换壁纸 + reset 后 reload 的门禁相位", { back1, state: await installState(), status: await status() });

  /* D10：向导第 3 步故意两次密码不一致并点「创建管理员」（矩阵 wizardToMismatch 的同一步） */
  const steps10 = [];
  const byId = (id) => "[data-d3-id=" + JSON.stringify(id) + "]";
  const nextStep = async (id) => { const ready = await waitFor(() => js("const b = document.querySelector(" + JSON.stringify(byId(id)) + "); return !!b && !b.disabled;"), 10000, 150); const clicked = await clickSel(byId(id)); steps10.push({ id, ready, clicked }); };
  let setupOk10 = null;
  if (back1) {
    await setInput('[data-d3-id="setup-name"]', "D5-03F 诊断2");
    await nextStep("setup-next"); await sleep(500);
    await setInput('[data-d3-id="setup-identifier"]', "admin2@d503f-diag.test");
    await nextStep("setup-next"); await sleep(500);
    await setInput('[data-d3-id="setup-password"]', ADMIN.pw);
    await setInput('[data-d3-id="setup-confirm"]', ADMIN.pw + "-different");
    await waitFor(() => js("const b = document.querySelector(" + JSON.stringify(byId("setup-submit")) + "); return !!b && !b.disabled;"), 10000, 150);
    const submitted = await clickSel('[data-d3-id="setup-submit"]');
    await sleep(900);
    setupOk10 = { submitted, ...(await installState()), status: await status() };
  }
  rec("D10", "向导第 3 步两次密码不一致后提交（应停在错误行、不建号）", { steps: steps10, result: setupOk10 });

  /* D11：reload → 门禁相位（矩阵 freshWizard 的同一步） */
  await page.reload().catch(() => {});
  const back2 = await waitGate("uninitialized", 25000);
  const state11 = await installState();
  rec("D11", "错误态向导 reload 之后的门禁相位（矩阵在这里失败过）", { back2, state: state11, status: await status() });
  if (!back2) {
    await page.reload().catch(() => {});
    const back3 = await waitGate("uninitialized", 20000);
    rec("D12", "再 reload 一次", { back3, state: await installState(), status: await status(), hasSetup: await has('[data-d3-id="setup-name"]') });
  }

  const cleanup = { strategy: "own-pid-tree-only", pkillUsed: false, targets: [], leftovers: [] };
  const tree = [child.pid];
  try { child.kill("SIGKILL"); } catch { /* ignore */ }
  await sleep(1200);
  cleanup.targets.push({ kind: "electron", rootPid: child.pid, tree, leftovers: [] });
  try { await browser.close(); } catch { /* ignore */ }
  cleanup.userDataDirsRemoved = OWNERSHIP.cleanupOwnedDirs({ log: (l) => console.log("   " + l) });

  const out = {
    phase: "D5-03 第六批", title: "矩阵会话状态机诊断（reset 后的门禁相位）",
    runId: RUN.runId, runDir: RUN.runDirRel, testedCommit: RUN_ARTIFACTS ? null : null,
    steps: STEPS, cdpPort, userData: path.basename(dir), stderrSample: stderr.split("\n").filter((l) => /error|Error/.test(l)).slice(0, 5),
    boundary: { thirdPartyServices: false, userDataSent: false, productCodeChanged: false, databaseWritesByProbe: false },
    at: new Date().toISOString(),
  };
  const fin = await RUN.finalize({ out, exitCode: 0, logLines: LOG, cleanup });
  console.log("产物：" + fin.artifactPath + "（sha256 " + fin.artifactSha256.slice(0, 16) + "）");
  process.exit(0);
}
process.exit(await main().then(() => 0).catch((e) => { console.error("诊断异常：" + String((e && e.stack) || e)); return 2; }));
