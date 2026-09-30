/**
 * D5-03 Batch14 · D5-01 真机门禁 S0a 只读诊断。
 *
 * 目的：在**真实 `electron .`** 上如实记录"设置入口点击 → 设置窗口是否打开 → 关键控件是否齐"，
 * 判定 S0a 的 FAIL 出在哪一步。本脚本**只读**：不写库、不设 plan、不点任何会产生副作用的控件。
 *
 * 启动方式与 experiments/d5-01/browser-control-e2e.mjs 完全一致（同一 spawn 参数、同一 env），
 * 因此诊断结论可以直接搬到该门禁。外部须 `env -u ELECTRON_RUN_AS_NODE`。
 */
import { chromium } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const CDP_PORT = Number(process.env.OA_D501_CTRL_CDP_PORT || 9793);
const ADMIN = { id: "admin@d501-ctrl.test", pw: "admin-password-1" };
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(ROOT, "dist", "index.html"))) { console.error("缺少 dist/index.html —— 请先 npm run build"); process.exit(1); }

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d501-ctrl-diag-"));
const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d501-ctrl-diag-dl-"));

const FINDINGS = {
  phase: "D5-03 Batch14 · S0a 只读真机诊断",
  at: new Date().toISOString(),
  env: {
    ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null,
    cdpPort: CDP_PORT, userData,
    electron: require("electron/package.json").version,
    node: process.version, platform: process.platform, arch: process.arch,
  },
  consoleErrors: [], pageErrors: [], launch: null, attempts: [],
};

let child = null;
let browser = null;
let page = null;
let stderrBuf = "";

function killOurElectron() { try { spawnSync("pkill", ["-f", userData], { stdio: "ignore" }); } catch { /* ignore */ } }
function killStaleRuns() { try { spawnSync("pkill", ["-f", "oa-d501-ctrl-diag-"], { stdio: "ignore" }); } catch { /* ignore */ } }

async function launch() {
  for (let i = 0; i < 40; i += 1) {
    if (!(await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version").then(() => true).catch(() => false))) break;
    killStaleRuns();
    await sleep(250);
  }
  child = spawn(electronPath, [".", "--user-data-dir=" + userData, "--remote-debugging-port=" + CDP_PORT, ...extraArgs], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OPENARC_IDENTITY_ADMIN: "1", OPENARC_DOWNLOADS_DIR: downloadsDir },
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { stderrBuf += String(d); });
  let version = null;
  const deadline = Date.now() + 60000;
  while (!version && Date.now() < deadline) { try { version = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json(); } catch { await sleep(300); } }
  if (!version) throw new Error("CDP 未就绪：" + stderrBuf.slice(-400));
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);
  const context = browser.contexts()[0];
  const isUI = (p) => p.url().includes("dist/index.html");
  const end = Date.now() + 40000;
  while (!page && Date.now() < end) { page = context.pages().find(isUI) || null; if (!page) await sleep(300); }
  if (!page) throw new Error("未找到界面页面");
  page.on("pageerror", (e) => { FINDINGS.pageErrors.push(String((e && e.stack) || (e && e.message) || e).slice(0, 800)); });
  page.on("console", (m) => { if (m.type() === "error") FINDINGS.consoleErrors.push(String(m.text()).slice(0, 500)); });
  return version;
}

const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const click = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");
const setInput = (sel, value) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : (el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype); const setter = Object.getOwnPropertyDescriptor(proto, 'value').set; setter.call(el, " + JSON.stringify(value) + "); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
async function waitFor(fn, timeout = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await Promise.resolve(fn())) return true; } catch { /* retry */ } await sleep(100); } return false; }
const waitSel = (sel, ms) => waitFor(() => has(sel), ms || 20000);
const waitGate = (want, ms) => waitFor(async () => (await gate()) === want, ms || 30000);

const PROBE_SELECTORS = [
  '[data-settings-pane="model"]', '[data-d4-01="settings"]', '[data-d4-01-provider-name]',
  '[data-d4-01-provider-create]', '[data-d4-01-tab="models"]', '[data-d4-01-default-personal-chat]',
];

/** 每次观测都独立采集，绝不在两次点击之间复用上一次的快照。 */
async function observe(label) {
  const snap = {
    label,
    href: await js("return location.href"),
    identityGate: await gate(),
    documentTitle: await js("return document.title"),
    windowTitles: await js("return Array.from(document.querySelectorAll('[data-window-id]')).map((e) => e.getAttribute('aria-label') + '|' + e.getAttribute('data-window-id'))"),
    bodyText400: (await js("return String(document.body.innerText || '')")).slice(0, 400),
    ariaLabelWithSettings: await js("return Array.from(document.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label')).filter((s) => s && s.includes('设置'))"),
    settingsPaneIds: await js("return Array.from(document.querySelectorAll('[data-settings-pane]')).map((e) => e.getAttribute('data-settings-pane'))"),
    settingsActive: await js("return document.querySelector('[data-settings-active]')?.getAttribute('data-settings-active') || ''"),
    controls: {},
  };
  for (const sel of PROBE_SELECTORS) snap.controls[sel] = !!(await has(sel));
  snap.settingsWindowOpen = await has('[data-window-id][aria-label="系统设置窗口"]');
  return snap;
}

async function login(who) {
  if (!(await waitSel('[data-d3-id="login-identifier"]', 20000))) return false;
  await setInput('[data-d3-id="login-identifier"]', who.id);
  await setInput('[data-d3-id="login-password"]', who.pw);
  await click('[data-d3-id="login-submit"]');
  return waitGate("ready", 90000);
}

async function main() {
  killStaleRuns();
  const version = await launch();
  FINDINGS.launch = { cdpVersion: version, electronProcessAlive: !!child, stderrHead: stderrBuf.slice(0, 800) };
  console.log("[1] electron . 已启动，CDP 版本：" + JSON.stringify(version.Browser || version));

  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized" && (await waitSel('[data-d3-id="setup-name"]', 30000))) {
    const setupNext = async () => {
      await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b && !b.disabled;"), 10000);
      await click('[data-d3-id="setup-next"]');
    };
    await setInput('[data-d3-id="setup-name"]', "D5-01 Ctrl Admin");
    await setupNext();
    await waitSel('[data-d3-id="setup-identifier"]', 10000);
    await setInput('[data-d3-id="setup-identifier"]', ADMIN.id);
    await setupNext();
    await waitSel('[data-d3-id="setup-password"]', 10000);
    await setInput('[data-d3-id="setup-password"]', ADMIN.pw);
    await setInput('[data-d3-id="setup-confirm"]', ADMIN.pw);
    await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-submit\"]'); return !!b && !b.disabled;"), 10000);
    await click('[data-d3-id="setup-submit"]');
    await waitGate("unauthenticated", 30000);
  }
  const loggedIn = await login(ADMIN);
  FINDINGS.launch.loginOk = loggedIn;
  FINDINGS.launch.gateAfterLogin = await gate();
  console.log("[2] admin 登录：" + loggedIn + "，gate=" + FINDINGS.launch.gateAfterLogin);
  if (!loggedIn) throw new Error("登录失败，无法进入 S0a 诊断");

  /* ── 观测点 A：点击之前（Dock 现状）── */
  const dockBefore = {
    dockItemCount: await js("return document.querySelectorAll('.dock-item').length"),
    dockIds: await js("return Array.from(document.querySelectorAll('.dock-item')).map((e) => e.getAttribute('data-dock-id'))"),
    appIdCount: await js("return document.querySelectorAll('[data-app-id]').length"),
    dockIdSettingsExists: await has('[data-dock-id="settings"]'),
    appIdSettingsExists: await has('[data-app-id="settings"]'),
  };
  FINDINGS.dock = dockBefore;
  console.log("[3] Dock 现状：" + JSON.stringify(dockBefore, null, 2));
  FINDINGS.attempts.push({ step: "A. 点击前基线", observe: await observe("before") });

  /* ── 观测点 B：只点 [data-dock-id="settings"] ── */
  const clickDockIdReturn = await click('[data-dock-id="settings"]');
  console.log("[4] click([data-dock-id=\"settings\"]) → " + JSON.stringify(clickDockIdReturn));
  const openedByDockId = await waitSel('[data-settings-pane="model"]', 20000);
  FINDINGS.attempts.push({
    step: "B. 只点 [data-dock-id=\"settings\"]",
    selector: '[data-dock-id="settings"]',
    elementExists: dockBefore.dockIdSettingsExists,
    clickReturn: clickDockIdReturn,
    settingsPaneAppeared: openedByDockId,
    observe: await observe("after-dock-id"),
  });

  /* ── 观测点 C：再点 [data-app-id="settings"]（旧选择器，期望 missing）── */
  const appIdExistsNow = await has('[data-app-id="settings"]');
  const clickAppIdReturn = await click('[data-app-id="settings"]');
  console.log("[5] click([data-app-id=\"settings\"]) → " + JSON.stringify(clickAppIdReturn) + "，此刻 !!el=" + appIdExistsNow);
  FINDINGS.attempts.push({
    step: "C. 再点 [data-app-id=\"settings\"]（旧选择器）",
    selector: '[data-app-id="settings"]',
    elementExists: appIdExistsNow,
    clickReturn: clickAppIdReturn,
    observe: await observe("after-app-id"),
  });

  /* ── 观测点 D：切到「模型 / AI」pane，看关键控件是否齐 ── */
  const paneClick = await click('[data-settings-pane="model"]');
  const d401Appeared = await waitSel('[data-d4-01="settings"]', 20000);
  console.log("[6] click([data-settings-pane=\"model\"]) → " + JSON.stringify(paneClick) + "，[data-d4-01=settings] 出现=" + d401Appeared);
  FINDINGS.attempts.push({
    step: "D. 打开设置后切到 模型/AI pane",
    selector: '[data-settings-pane="model"]',
    clickReturn: paneClick,
    d401Appeared,
    observe: await observe("after-model-pane"),
  });

  /* ── 逐 tab 覆盖 S0a 驱动要用的全部选择器（D4-01 面板按 tab 条件渲染）── */
  const S0A_COMMON = [
    '[data-dock-id="settings"]', '[data-app-id="settings"]', '[data-settings-pane="model"]',
    '[data-d4-01="settings"]', '[data-d4-01-provider-name]', '[data-d4-01-provider-scope]',
    '[data-d4-01-provider-url]', '[data-d4-01-provider-secret]', '[data-d4-01-provider-create]',
    '[data-d4-01-tab="models"]', '[data-d4-01-tab="defaults"]', '[data-d4-01-tab="providers"]',
    '[data-d4-01-pane="providers"]',
  ];
  // 顺序必须与初始 tab 一致：providers 是默认 tab，先采它再切走。
  const S0A_BY_TAB = {
    providers: ['[data-d4-01-pane="providers"]'],
    models: ['[data-d4-01-pane="models"]', '[data-d4-01-model-provider]', '[data-d4-01-model-scope]', '[data-d4-01-model-remote]', '[data-d4-01-model-name]', '[data-d4-01-model-create]'],
    defaults: ['[data-d4-01-pane="defaults"]', '[data-d4-01-default-personal-chat]', '[data-d4-01-default-org-chat]'],
  };
  const s0aPresence = { common: {}, byTab: {} };
  for (const sel of S0A_COMMON) s0aPresence.common[sel] = !!(await has(sel));
  for (const [pane, sels] of Object.entries(S0A_BY_TAB)) {
    const tabReturn = pane === "providers" ? "n/a（初始 tab）" : await click('[data-d4-01-tab="' + pane + '"]');
    await waitSel('[data-d4-01-pane="' + pane + '"]', 15000);
    const row = { tabClick: tabReturn, selectors: {} };
    for (const sel of sels) row.selectors[sel] = !!(await has(sel));
    s0aPresence.byTab[pane] = row;
  }
  FINDINGS.s0aSelectorPresence = s0aPresence;
  console.log("[7] S0a 驱动全部选择器存在性（按 tab）：" + JSON.stringify(s0aPresence, null, 2));
  const byTabMissing = Object.entries(s0aPresence.byTab).flatMap(([pane, r]) => Object.entries(r.selectors).filter(([k, v]) => !v && !k.endsWith('=""]')).map(([k]) => pane + ":" + k));
  FINDINGS.byTabMissing = byTabMissing;
  console.log("[7b] 按 tab 实测缺失的控件：" + JSON.stringify(byTabMissing));

  FINDINGS.stderrTail = stderrBuf.split("\n").slice(-40).join("\n");
  console.log("[8] 主进程 stderr 尾部：\n" + FINDINGS.stderrTail);

  const dockOk = clickDockIdReturn === "ok" && openedByDockId;
  const controlsOk = Object.entries(s0aPresence.common).filter(([k]) => !k.includes('data-app-id')).every(([, v]) => v) && byTabMissing.length === 0;
  FINDINGS.conclusion = {
    settingsEntryClickOk: clickDockIdReturn === "ok",
    settingsEntryOldSelectorExists: dockBefore.appIdSettingsExists,
    settingsWindowOpenedByDockId: openedByDockId,
    settingsWindowOpenedByAppId: null,
    settingsWindowOpened: openedByDockId,
    s0aControlsComplete: controlsOk,
    failureStep: dockOk ? (controlsOk ? "无（设置入口与控件均正常）" : "关键控件缺失：" + JSON.stringify(byTabMissing)) : (clickDockIdReturn !== "ok" ? "设置入口点击未成功（" + clickDockIdReturn + "）" : "点击成功但设置窗口未打开"),
    pageErrors: FINDINGS.pageErrors.length,
    consoleErrors: FINDINGS.consoleErrors.length,
  };
  console.log("[9] 结论：" + JSON.stringify(FINDINGS.conclusion, null, 2));
  return 0;
}

let exitCode = 2;
try {
  exitCode = await main();
} catch (e) {
  console.error("诊断脚本异常：" + String((e && e.stack) || e));
  console.error("--- main stderr tail ---\n" + stderrBuf.split("\n").slice(-40).join("\n"));
  FINDINGS.fatal = String((e && e.stack) || e);
  exitCode = 2;
}
FINDINGS.stderrTail = FINDINGS.stderrTail || stderrBuf.split("\n").slice(-40).join("\n");
const outDir = path.join(ROOT, "experiments", "d5-03", "batch14", "diagnose");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "10-diagnose-findings.json"), JSON.stringify(FINDINGS, null, 2));
console.log("\n[findings] " + path.join(outDir, "10-diagnose-findings.json"));
try { if (browser) await browser.close().catch(() => {}); } catch { /* ignore */ }
try { if (child) child.kill("SIGKILL"); } catch { /* ignore */ }
killOurElectron();
process.exit(exitCode);
