/**
 * D5-03 第六批 · 矩阵会话状态机诊断 v2（逐字复现矩阵单元格转场）。
 *
 * 待判定问题：auth-error-matrix.cjs 的「设置面测完 → 换壁纸 → reset-installation → reload」
 * 之后落地页不是初始化向导而是登录页（gate=unauthenticated）。v1 诊断证明「换配置前不点壁纸」
 * 的 reset+reload 稳定得到 uninitialized；本版把**壁纸那一步**补进去，逐步记录相位与
 * identity/status，定位差异到底出在哪一步。
 *
 * 边界：真机 electron .（隔离 userData）；查库只读；不连第三方；不改产品代码。
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

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
const ADMIN = { id: "admin@d503f-diag2.test", pw: "diag-admin-1" };
const CDP_BASE = Number(process.env.OA_D503F_DIAG_CDP_PORT || 9911);
let RUN = null, STEPS = [];

const byId = (id) => "[data-d3-id=" + JSON.stringify(id) + "]";

async function main() {
  RUN = await RUN_ARTIFACTS.createRun({ root: ROOT, script: "batch6-matrix-diag2", basePort: CDP_BASE, envBaseVar: "OA_D503F_DIAG_CDP_PORT", userDataPrefixBase: "oa-d503b-" });
  const dir = OWNERSHIP.createOwnedDir({ prefix: RUN.userDataPrefix, kind: "electron-userdata/diag2", runId: RUN.runId });
  const reservation = await RUN.acquirePort(CDP_BASE);
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
  let navigations = 0;
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigations += 1; });

  const js = (code) => page.evaluate("(async () => { " + code + " })()");
  const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
  const textOf = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? (el.textContent || '') : '';");
  const waitFor = async (fn, timeout = 20000, iv = 120) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return true; } catch { /* retry */ } if (Date.now() - t0 >= timeout) return false; await sleep(iv); } };
  const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
  const status = () => js("return await window.openarc.identity.command({ type: 'identity/status' });");
  const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
  const clickSel = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");
  const waitGate = (want, ms) => waitFor(async () => (await gate()) === want, ms, 200);
  const shape = async () => ({ gate: await gate(), setup: await has(byId("setup-name")), login: await has(byId("login-identifier")), settings: await has("[data-settings-active]"), authError: ((await textOf(byId("auth-error"))).trim() || null), wall: await js("return document.querySelector('.desktop')?.getAttribute('data-wallpaper') || null;"), dark: await js("return !!document.querySelector('.desktop')?.classList.contains('dark');"), nav: navigations });
  const st = async () => { const s = await status(); return { initialized: s.initialized, initStatus: s.initStatus, userCount: s.userCount }; };
  const rec = async (id, note) => { const row = { id, note, shape: await shape(), status: await st(), at: new Date().toISOString() }; STEPS.push(row); console.log("· " + id + " " + note + " " + JSON.stringify({ shape: row.shape, status: row.status })); return row; };

  await waitGate("uninitialized", 30000);
  await rec("D0", "首启 uninitialized");

  /* 初始化 + 登录 */
  await waitFor(() => has(byId("setup-name")), 30000, 200);
  await setInput(byId("setup-name"), "D5-03F 诊断2");
  await clickSel(byId("setup-next")); await sleep(500);
  await waitFor(() => has(byId("setup-identifier")), 10000, 200);
  await setInput(byId("setup-identifier"), ADMIN.id);
  await clickSel(byId("setup-next")); await sleep(500);
  await waitFor(() => has(byId("setup-password")), 10000, 200);
  await setInput(byId("setup-password"), ADMIN.pw);
  await setInput(byId("setup-confirm"), ADMIN.pw);
  await waitFor(() => js("const b = document.querySelector(" + JSON.stringify(byId("setup-submit")) + "); return !!b && !b.disabled;"), 10000, 150);
  await clickSel(byId("setup-submit"));
  await waitGate("unauthenticated", 30000);
  await setInput(byId("login-identifier"), ADMIN.id);
  await setInput(byId("login-password"), ADMIN.pw);
  await clickSel(byId("login-submit"));
  const ok1 = await waitGate("ready", 60000);
  await rec("D1", "登录成功=" + ok1);

  /* 设置面：制造错误行（矩阵同路径） */
  await js("const el = document.querySelector('.dock-item[data-dock-id=\"settings\"]'); if (el) el.click(); return !!el;");
  await waitFor(() => has("[data-settings-active]"), 15000, 200);
  await setInput(byId("settings-name"), "很长的显示名".repeat(20));
  await waitFor(() => js("const b = document.querySelector(" + JSON.stringify(byId("settings-save")) + "); return !!b && !b.disabled;"), 6000, 120);
  await clickSel(byId("settings-save"));
  await waitFor(async () => (await textOf(byId("settings-error"))).trim().length > 0, 8000, 150);
  await rec("D2", "设置面错误行：" + (await textOf(byId("settings-error"))).trim());

  /* ★ 关键一步：真实设置面板换壁纸 theme-dark → theme-light（矩阵 applyCell 的同一步） */
  const navBefore = navigations;
  const clickWall = await js("const w = document.querySelector('[data-settings-active]')?.closest('.window'); if (!w) return 'missing'; const b = w.querySelector(" + JSON.stringify('.wallpaper-option[data-wallpaper="theme-light"]') + "); if (!b) return 'no-tile'; b.click(); return 'ok';");
  const wallOk = await waitFor(async () => (await js("return document.querySelector('.desktop')?.getAttribute('data-wallpaper');")) === "theme-light", 6000, 150);
  await sleep(400);
  const afterWall = await rec("D3", "点壁纸格子（clicked=" + clickWall + "，换成功=" + wallOk + "，导航次数增量=" + (navigations - navBefore) + "）");

  /* ★ reset + reload（矩阵同一步） */
  const resetRes = await js("return await window.openarc.identity.command({ type: 'identity/reset-installation', confirm: 'DELETE-ALL-IDENTITY-DATA' });");
  console.log("   reset → " + JSON.stringify({ ok: resetRes.ok, status: resetRes.status }));
  const afterReset = await rec("D4", "reset 之后（未 reload）");
  await page.reload().catch(() => {});
  const back = await waitGate("uninitialized", 25000);
  const afterReload = await rec("D5", "reload 之后（uninitialized=" + back + "）");
  if (!back) { await page.reload().catch(() => {}); const again = await waitGate("uninitialized", 20000); await rec("D6", "再 reload（uninitialized=" + again + "）"); }

  const cleanup = { strategy: "own-pid-tree-only", pkillUsed: false, targets: [], leftovers: [] };
  try { child.kill("SIGKILL"); } catch { /* ignore */ }
  await sleep(1200);
  cleanup.targets.push({ kind: "electron", rootPid: child.pid, tree: [child.pid], leftovers: [] });
  try { await browser.close(); } catch { /* ignore */ }
  cleanup.userDataDirsRemoved = OWNERSHIP.cleanupOwnedDirs({ log: (l) => console.log("   " + l) });

  const out = {
    phase: "D5-03 第六批", title: "矩阵会话状态机诊断 v2（壁纸 + reset 转场）",
    runId: RUN.runId, runDir: RUN.runDirRel, cdpPort, userData: path.basename(dir),
    conclusion: back ? "换壁纸 + reset + reload 仍然得到 uninitialized —— 矩阵那次失败不是这条路径本身的必然结果" : "换壁纸 + reset + reload 落到非 uninitialized —— 复现了矩阵的失败",
    resetResult: resetRes, wallClick: clickWall, wallOk, navigations,
    steps: STEPS, stderrSample: stderr.split("\n").filter((l) => /error|Error/.test(l)).slice(0, 5),
    boundary: { thirdPartyServices: false, userDataSent: false, productCodeChanged: false, databaseWritesByProbe: false },
    at: new Date().toISOString(),
  };
  const fin = await RUN.finalize({ out, exitCode: 0, logLines: LOG, cleanup });
  console.log("结论：" + out.conclusion);
  console.log("产物：" + fin.artifactPath + "（sha256 " + fin.artifactSha256.slice(0, 16) + "）");
  return 0;
}
process.exit(await main().catch((e) => { console.error("诊断异常：" + String((e && e.stack) || e)); return 2; }));
