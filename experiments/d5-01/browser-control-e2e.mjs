/**
 * D5-01 Closure-2 · 受控浏览器能力**真实产品链**端到端验收（不是等价物）。
 *
 * 真实：\`electron .\`（electron/main.cjs + 真实 preload + dist/index.html）、真实 UI（Dock 打开浏览器、
 * 地址栏导航、AI 面板、Trusted Approval UI、治理 UI 授权）、official @deepseek-ai/dsh（ACP v1）、
 * 真实 Tool Registry / ControlledToolProxy / SideEffectAuthority / 受控执行、真实本地受控站点
 * （experiments/d5-01/site.mjs）、真实 WebContentsView。
 *
 * 只替代"最后一跳 provider network"：本地确定性 provider（tests/fixtures/d4-04-provider.mjs）。
 *
 * 六个场景（每个都必须有真实执行证据）：
 *   S1 读取闭环 + 不可信正文（含恶意页面注入：正文只作为不可信数据，绝不成为高信任指令、绝不自动触发工具）
 *   S2 导航获批闭环（审批绑定目标+地址 → lease → claim → 真实导航 → READ_AFTER_WRITE）
 *   S3 导航被拒（用户 DENY → 0 导航、地址不变、不产生任何"已回滚"式结论）
 *   S4 目标失效（未授权 viewId / UI 撤权 / 关标签）一律拒绝且不回落
 *   S5 URL 与协议策略（file: / javascript: / 含凭据）在工具门就被拒，0 side-effect call
 *   S6 停止与预算（审批等待中取消 → BLOCKED + 0 导航；工具预算到限 → 明确停止，不静默成功）
 */
import { chromium } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { startSite } from "./site.mjs";
import { startD4Provider } from "../../tests/fixtures/d4-04-provider.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const ART = path.join(ROOT, "artifacts", "d5-01");
const CDP_PORT = Number(process.env.OA_D501_CTRL_CDP_PORT || 9790);
const ADMIN = { id: "admin@d501-ctrl.test", pw: "admin-password-1" };
const PROVIDER_SECRET = "d501-ctrl-provider-secret";
const TOOLS = ["tool.browser.read", "tool.browser.navigate"];
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(ROOT, "dist", "index.html"))) { console.error("缺少 dist/index.html —— 请先 npm run build"); process.exit(1); }

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d501-ctrl-"));
const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d501-ctrl-dl-"));
const DB_PATH = path.join(userData, "identity.db");

const RECORD = [];
const CHECKS = [];
const NOT_VERIFIED = [];
const OBSERVATIONS = [];
let passed = 0;
let failed = 0;
function record(section, name, ok, expected, actual) {
  const row = { section, name, status: ok ? "PASS" : "FAIL", expected: String(expected ?? ""), actual: String(actual ?? "").slice(0, 500), at: Date.now() };
  RECORD.push(row); CHECKS.push(row);
  if (ok) passed += 1; else failed += 1;
  console.log((ok ? "  " : "! ") + "[" + row.status + "] " + section + " · " + name + (ok ? "" : " — 期望 " + row.expected + "，实际 " + row.actual));
  return ok;
}
const note = (t) => { OBSERVATIONS.push(t); console.log("   · " + t); };
const notVerified = (name, reason) => { NOT_VERIFIED.push({ name, reason }); console.log("   ? [NOT VERIFIED] " + name + " — " + reason); };

let child = null;
let browser = null;
let context = null;
let page = null;
let stderrBuf = "";
let site = null;
let provider = null;

function dbAll(sql) { const db = new DatabaseSync(DB_PATH, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } }
const tableRows = (t) => { try { return dbAll("SELECT * FROM " + t); } catch { return []; } };
const auditRows = () => tableRows("authorization_audit");
const execsByTool = (toolId) => tableRows("tool_executions").filter((r) => r.tool_id === toolId);
const callsByTool = (toolId) => tableRows("side_effect_calls").filter((r) => r.tool_id === toolId);
/** 一律按 **callId / taskId** 定位真实记录：绝不用"最后一条 call"这种会串场景的口径。 */
const callById = (callId) => tableRows("side_effect_calls").find((r) => r.call_id === callId) || null;
const callsOfTask = (taskId, toolId) => tableRows("side_effect_calls").filter((r) => r.task_id === taskId && (!toolId || r.tool_id === toolId));
const execsOfTask = (taskId, toolId) => tableRows("tool_executions").filter((r) => r.task_id === taskId && (!toolId || r.tool_id === toolId));
const leasesOf = (callId) => tableRows("side_effect_leases").filter((l) => l.call_id === callId);

/**
 * 只清理**本次隔离前缀**的遗留进程：上一轮被强杀时子进程会活下来，若不清掉，
 * 新一轮会连到旧实例（旧 userData / 旧 provider 端口）—— 那会产出完全虚假的证据。
 * 绝不动其它 OpenArc 实例（前缀只匹配本次隔离目录）。
 */
function killOurElectron() { try { spawnSync("pkill", ["-f", userData], { stdio: "ignore" }); } catch { /* ignore */ } }
function killStaleRuns() { try { spawnSync("pkill", ["-f", "oa-d501-ctrl-"], { stdio: "ignore" }); } catch { /* ignore */ } }

async function launch() {
  // 端口必须空闲：还活着就说明连不上本次实例，直接大声失败，绝不"连到谁算谁"。
  // pkill 生效有延迟，因此这里最多等 10s 让上一轮的实例真正退出。
  let busy = false;
  for (let i = 0; i < 40; i += 1) {
    busy = await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version").then(() => true).catch(() => false);
    if (!busy) break;
    killStaleRuns();
    await sleep(250);
  }
  if (busy) throw new Error("CDP 端口 " + CDP_PORT + " 已被占用（遗留实例），拒绝复用");
  child = spawn(electronPath, [".", "--user-data-dir=" + userData, "--remote-debugging-port=" + CDP_PORT, ...extraArgs], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OPENARC_IDENTITY_ADMIN: "1", OPENARC_DOWNLOADS_DIR: downloadsDir },
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { stderrBuf += String(d); try { fs.appendFileSync(path.join(ART, "d5-01-browser-control-stderr.log"), String(d)); } catch { /* artifacts 目录可能还没建 */ } });
  let version = null;
  const deadline = Date.now() + 60000;
  while (!version && Date.now() < deadline) { try { version = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json(); } catch { await sleep(300); } }
  if (!version) throw new Error("CDP 未就绪");
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);
  context = browser.contexts()[0];
  const isUI = (p) => p.url().includes("dist/index.html");
  const end = Date.now() + 40000;
  while (!page && Date.now() < end) { page = context.pages().find(isUI) || null; if (!page) await sleep(300); }
  if (!page) throw new Error("未找到界面页面");
  page.on("pageerror", (e) => note("renderer pageerror: " + String((e && e.message) || e).slice(0, 160)));
  return version;
}

const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const text = (sel) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.textContent || ''");
const attr = (sel, a) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.getAttribute(" + JSON.stringify(a) + ") || ''");
const isDisabled = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? !!el.disabled : true;");
const providerIds = () => js("return Array.from(document.querySelectorAll('[data-d4-01-provider]')).map((e) => e.getAttribute('data-d4-01-provider')).filter(Boolean)");
const click = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");
const setInput = (sel, value) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : (el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype); const setter = Object.getOwnPropertyDescriptor(proto, 'value').set; setter.call(el, " + JSON.stringify(value) + "); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
/** 输入框的**当前值**只能读 property（getAttribute("value") 永远是初始属性）。 */
const value = (sel) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.value || ''");
const visibleText = (sel) => js("const el = " + (sel ? "document.querySelector(" + JSON.stringify(sel) + ")" : "document.body") + "; return el ? String(el.innerText || '') : ''");
async function waitFor(fn, timeout = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await Promise.resolve(fn())) return true; } catch { /* retry */ } await sleep(100); } return false; }
const waitSel = (sel, ms) => waitFor(() => has(sel), ms || 20000);
const waitGate = (want, ms) => waitFor(async () => (await gate()) === want, ms || 30000);
const bridge = (domain, command) => js("return window.openarc." + domain + ".command(" + JSON.stringify(command) + ")");
const taskGet = (taskId) => bridge("task", { type: "task/get", taskId });

const views = () => browser.contexts()[0].pages().filter((p) => !p.url().includes("dist/index.html"));
const viewByExactUrl = (url) => views().find((p) => p.url() === url) || null;
async function waitViewExact(url, ms = 20000) { await waitFor(() => !!viewByExactUrl(url), ms); return viewByExactUrl(url); }
async function viewEval(v, code, attempts = 3) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try { return await v.evaluate("(async () => { " + code + " })()"); } catch (e) {
      last = e;
      if (!/Execution context was destroyed|Target closed|frame was detached/i.test(String(e && e.message))) throw e;
      await sleep(200);
    }
  }
  throw last;
}

async function login(who) {
  if (!(await waitSel('[data-d3-id="login-identifier"]', 20000))) return false;
  await setInput('[data-d3-id="login-identifier"]', who.id);
  await setInput('[data-d3-id="login-password"]', who.pw);
  await click('[data-d3-id="login-submit"]');
  return waitGate("ready", 90000);
}
async function openBrowser() { if (await has("[data-browser-window]")) return true; await click('[aria-label="打开浏览器"]'); return waitSel("[data-browser-window]", 20000); }
const ADDRESS_SEL = '[aria-label="网页地址"]';
async function navigate(url) { await setInput(ADDRESS_SEL, url); await click(".addressbar .primary"); }
async function openPanel() { if (await has(".ai-panel")) return true; if (await waitSel(".assistant-pill", 30000)) await click(".assistant-pill"); return waitSel(".ai-panel", 20000); }
/** 真实 UI 跑一次任务：返回任务 id（面板必须真的产生新 task id）。 */
async function runTaskViaUI(goal) {
  await openPanel();
  const prev = await attr(".ai-panel", "data-ai-task-id");
  await setInput("[data-ai-goal]", goal);
  if (!(await waitFor(async () => !(await isDisabled("[data-ai-run]")), 60000))) throw new Error("run 按钮一直不可用");
  const c = await click("[data-ai-run]");
  if (c !== "ok") throw new Error("run 点击失败：" + c);
  const started = await waitFor(async () => { const id = await attr(".ai-panel", "data-ai-task-id"); return typeof id === "string" && id.length > 0 && id !== prev; }, 40000);
  return { taskId: await attr(".ai-panel", "data-ai-task-id"), started };
}
async function waitTaskTerminal(taskId, timeout = 180000) {
  return waitFor(async () => { const g = await taskGet(taskId); const s = g && g.task && g.task.status; return ["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"].includes(s); }, timeout);
}
const waitApproval = (ms) => waitFor(async () => (await attr("[data-approval-request-id]", "data-approval-request-id")).length > 0, ms || 120000);
const approvalId = () => attr("[data-approval-request-id]", "data-approval-request-id");
async function setPlan(plan) {
  const control = provider.baseUrl.replace("/v1", "") + "/__plan";
  const res = await fetch(control, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: plan || [] }) });
  return res.ok;
}
const viewIdNow = () => attr("[data-ai-control-toggle]", "data-ai-control-view-id");
const controlState = () => attr("[data-ai-control-toggle]", "data-ai-control-state");
// 注意：preload 里 `openarc.browser` **本身就是**调用函数（不是 {command} 对象）。
const controlTargets = () => js("return window.openarc.browser({ type: 'browser/controlList' })");
const ILLUSION_WORDS = ["已回滚", "已撤销成功", "已恢复原状"];

async function main() {
  killStaleRuns();
  site = await startSite();
  provider = await startD4Provider();
  await launch();
  record("boot", "M1 · 真实 electron . 启动并暴露 CDP", !!browser, "CDP 可用", "connected");
  // 必须等到**明确的门状态**：`!== "checking"` 会把"外壳根节点还没渲染"（no-root）当成可以继续。
  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized" && (await waitSel('[data-d3-id="setup-name"]', 30000))) {
    // 集成分支保留 UI 线已定的"三步初始化向导"（显示名 → 账号 → 密码），末步才提交：
    // 后两步的输入在 DOM 里尚未存在，一次填完再点 setup-submit 不会发生任何事。
    // 驱动方式与 UI 线探针（tests/fixtures/identity-ui-probe/main.cjs）一致。
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
  record("boot", "M2 · 真实 UI 登录 admin", await login(ADMIN), "ready", await gate());

  /* ───────────────── 真实 UI：确定性 provider + model + 默认 chat ───────────────── */
  await click('[data-app-id="settings"]');
  await waitSel('[data-settings-pane="model"]', 20000);
  await click('[data-settings-pane="model"]');
  await waitSel('[data-d4-01="settings"]', 20000);
  await setInput('[data-d4-01-provider-name]', "D5-01 Ctrl Provider");
  await setInput('[data-d4-01-provider-scope]', "ORGANIZATION");
  await setInput('[data-d4-01-provider-url]', provider.baseUrl);
  await setInput('[data-d4-01-provider-secret]', PROVIDER_SECRET);
  await click('[data-d4-01-provider-create]');
  // 列表行的 id 属性可能比行本身晚一帧出现（React 提交顺序），等到**非空**再继续。
  await waitFor(async () => (await providerIds()).length > 0, 20000);
  const pid = (await providerIds())[0] || "";
  await click('[data-d4-01-tab="models"]');
  await waitSel('[data-d4-01-pane="models"]', 20000);
  await setInput('[data-d4-01-model-provider]', pid);
  await setInput('[data-d4-01-model-scope]', "ORGANIZATION");
  await setInput('[data-d4-01-model-remote]', "d501-ctrl-local");
  await setInput('[data-d4-01-model-name]', "D5-01 Ctrl Local");
  await click('[data-d4-01-model-create]');
  await waitSel('[data-d4-01-model]', 20000);
  const cid = await attr("[data-d4-01-model]", "data-d4-01-model");
  await click('[data-d4-01-tab="defaults"]');
  await waitSel('[data-d4-01-pane="defaults"]', 20000);
  await setInput('[data-d4-01-default-personal-chat]', cid);
  await setInput('[data-d4-01-default-org-chat]', cid);
  const defaultOk = await waitFor(async () => (await js("return document.querySelector('[data-d4-01-default-org-chat]').value")) === cid, 15000);
  record("setup", "S0a · 真实 UI 创建确定性 provider/model 并设为默认 chat", !!pid && !!cid && defaultOk, "provider+model+default", JSON.stringify({ pid, cid, defaultOk }));
  await setPlan([]);
  await click('[data-d4-01-tab="providers"]');
  await waitSel('[data-d4-01-pane="providers"]', 15000);
  await click('[data-d4-01-test="' + pid + '"]');
  record("setup", "S0b · 真实 UI 连接测试 Inference:PASS", await waitFor(async () => (await text('[data-d4-01-test-result="' + pid + '"]')).indexOf("Inference:PASS") >= 0, 40000), "Inference:PASS", await text('[data-d4-01-test-result="' + pid + '"]'));

  /** 真实治理 UI：授予 ai 两个 TOOL 动作（读取与导航分开授予）。 */
  async function grantToolsViaUI(actions) {
    const c = await click('[aria-label="打开组织治理"]');
    if (c !== "ok") return { ok: false, reason: "dock-click:" + c };
    if (!(await waitSel('[data-d3-04d="app"]', 20000))) return { ok: false, reason: "no-gov-app" };
    await click('[data-d3-04d-tab="apps"]');
    if (!(await waitSel('[data-gov-tool-toggle="ai"]', 20000))) return { ok: false, reason: "no-ai-toggle" };
    await click('[data-gov-tool-toggle="ai"]');
    if (!(await waitSel('[data-gov-tool-access="ai"]', 20000))) return { ok: false, reason: "no-tool-panel" };
    for (const a of actions) {
      if (!(await has('[data-gov-tool-action="' + a + '"] input[type=checkbox]'))) return { ok: false, reason: "missing-action:" + a };
      await click('[data-gov-tool-action="' + a + '"] input[type=checkbox]');
    }
    await click('[data-gov-tool-grant="ai"]');
    const ok = await waitFor(async () => { const ta = await bridge("governance", { type: "governance/getAppToolAccess", appId: "ai" }); return !!(ta && ta.ok && actions.every((a) => (ta.grantedActions || []).includes(a))); }, 20000);
    return { ok, reason: ok ? "ui-granted" : "ui-not-verified" };
  }
  const grant = await grantToolsViaUI(TOOLS);
  record("setup", "S0c · 真实治理 UI 授予 ai tool.browser.read / tool.browser.navigate", grant.ok, "两个动作已授予", JSON.stringify(grant));

  /* ───────────────── 打开浏览器 + 授权 AI 控制（真实 UI 按钮） ───────────────── */
  record("ui", "U1 · 从 Dock 打开浏览器窗口", await openBrowser(), "浏览器窗口存在", await has("[data-browser-window]"));
  await navigate(site.base + "/inject");
  const injectView = await waitViewExact(site.base + "/inject", 25000);
  record("ui", "U2 · 地址栏真实导航到恶意页面（注入样例）", !!injectView && (await viewEval(injectView, "return document.getElementById('inject-marker')?.textContent || ''")) === "INJECT-MARKER-7c21", "INJECT-MARKER-7c21", injectView ? injectView.url() : "无视图");
  record("ui", "U3 · 未授权时 AI 控制按钮为 off，且主进程授权列表为空", (await controlState()) === "off" && (await controlTargets()).targets.length === 0, "off + 0 targets", JSON.stringify({ state: await controlState(), targets: (await controlTargets()).targets.length }));
  record("ui", "U4 · 点击按钮显式授权当前标签（真实 UI → 主进程）", (await click("[data-ai-control-toggle]")) === "ok" && (await waitFor(async () => (await controlState()) === "on", 10000)), "state=on", await controlState());
  const VIEW = await viewIdNow();
  const targetsNow = await controlTargets();
  record("ui", "U5 · 主进程授权目标 = 该标签的稳定身份（windowId#tabId）", targetsNow.targets.length === 1 && targetsNow.targets[0].viewId === VIEW, VIEW, JSON.stringify(targetsNow.targets));
  record("ui", "U6 · 标签栏显示该标签已被授权", (await attr('[data-tab][data-ai-control-authorized="1"]', "data-tab")) !== "", "存在已授权标签", await js("return Array.from(document.querySelectorAll('[data-tab]')).map(e=>e.getAttribute('data-tab')+':'+e.getAttribute('data-ai-control-authorized')).join(',')"));

  /* ═════════════ S1 · 读取闭环 + 不可信正文 ═════════════ */
  {
    const readsBefore = execsByTool("browser.read.page").length;
    await setPlan([{ name: "browser_read_page", args: { viewId: VIEW } }]);
    const run1 = await runTaskViaUI("读取我授权给你的那个浏览器标签的正文");
    record("S1", "S1.0 · 真实 UI 启动任务（official dsh + Tool Facade）", run1.started, "新 task id", run1.taskId);
    const term = await waitTaskTerminal(run1.taskId);
    const got = await taskGet(run1.taskId);
    record("S1", "S1.1 · 任务终态 SUCCEEDED", term && got.task.status === "SUCCEEDED", "SUCCEEDED", got.task.status);
    const execs = execsByTool("browser.read.page");
    const last = execs[execs.length - 1];
    record("S1", "S1.2 · 真实受控读取执行 SUCCEEDED + verification PASS", execs.length === readsBefore + 1 && last && last.status === "SUCCEEDED" && last.verification_status === "PASS", "1 次 SUCCEEDED/PASS", JSON.stringify(last ? { status: last.status, verification: last.verification_status } : null));
    const audit = JSON.stringify(auditRows());
    record("S1", "S1.3 · 审计记录 browser.read.page 且**不含页面正文**", audit.includes("browser.read.page") && !audit.includes("INJECT-MARKER-7c21") && !audit.includes("ignore all previous instructions"), "有工具记录、无正文", audit.includes("browser.read.page") ? "工具记录在" : "缺工具记录");
    const bodies = await (await fetch(provider.baseUrl.replace("/v1", "") + "/__bodies")).json();
    const all = JSON.stringify(bodies.bodies);
    const lastBody = bodies.bodies[bodies.bodies.length - 1] || {};
    const highTrust = JSON.stringify((lastBody.messages || []).filter((m) => m && (m.role === "system" || m.role === "developer")));
    record("S1", "S1.4 · 页面正文作为**不可信结果**回到模型（untrusted=true）", all.includes("INJECT-MARKER-7c21") && all.includes("untrusted"), "正文+untrusted 标记", all.includes("INJECT-MARKER-7c21") ? "正文已回传" : "正文未回传");
    record("S1", "S1.5 · 恶意页面正文**绝不进入高信任指令位**（system/developer）", !highTrust.includes("ignore all previous instructions"), "高信任消息无注入文本", highTrust.includes("ignore all previous instructions") ? "注入进了高信任消息" : "未进入");
    record("S1", "S1.6 · 恶意页面正文**绝不自动触发任何工具/导航**（0 side-effect call、地址不变）", callsByTool("browser.navigate").length === 0 && (await value(ADDRESS_SEL)) === site.base + "/inject", "0 导航 + 地址不变", JSON.stringify({ calls: callsByTool("browser.navigate").length, address: await value(ADDRESS_SEL) }));
  }

  /* ═════════════ S2 · 导航获批闭环 ═════════════ */
  const PAGE2 = site.base + "/page2";
  {
    await setPlan([{ name: "browser_navigate", args: { viewId: VIEW, url: PAGE2 } }]);
    const run2 = await runTaskViaUI("把那个标签导航到 page2");
    const seen = await waitApproval(120000);
    const rid = await approvalId();
    record("S2", "S2.0 · 真实审批面板出现（导航必须审批）", seen && !!rid, "approval 面板", rid || "无");
    record("S2", "S2.1 · 审批显示被批准的**地址**", (await text("[data-approval-url]")).trim() === PAGE2, PAGE2, (await text("[data-approval-url]")).trim());
    record("S2", "S2.2 · 审批显示**目标标签身份**", (await text("[data-approval-target]")).includes(VIEW), VIEW, (await text("[data-approval-target]")).trim().slice(0, 120));
    record("S2", "S2.3 · 批准前 webContentsView 地址未变（0 导航）", (await value(ADDRESS_SEL)) === site.base + "/inject", site.base + "/inject", await value(ADDRESS_SEL));
    await click('[data-approval-action="approve"]');
    const term = await waitTaskTerminal(run2.taskId);
    const got = await taskGet(run2.taskId);
    record("S2", "S2.4 · 批准后任务 SUCCEEDED", term && got.task.status === "SUCCEEDED", "SUCCEEDED", got.task.status);
    const call = callById(rid);
    record("S2", "S2.5 · SideEffectCall SUCCEEDED + READ_AFTER_WRITE PASS + lease 恰好 1", !!call && call.status === "SUCCEEDED" && call.verification_status === "PASS" && leasesOf(rid).length === 1 && callsOfTask(run2.taskId, "browser.navigate").length === 1, "SUCCEEDED/PASS/1 lease", JSON.stringify(call ? { status: call.status, verification: call.verification_status, leases: leasesOf(rid).length } : null));
    const view = await waitViewExact(PAGE2, 20000);
    record("S2", "S2.6 · **真实** WebContentsView 已到达被批准的地址", !!view && (await viewEval(view, "return document.getElementById('page2-marker')?.textContent || ''")) === "PAGE2-MARKER-9f3a", "PAGE2-MARKER-9f3a", view ? view.url() : "无视图");
    const pre = JSON.parse(String(call?.preconditions_safe || "{}"));
    record("S2", "S2.7 · 执行地址 = 被批准地址（plan 里持久化，Harness 无法在批准后换目标）", pre.url === PAGE2 && pre.targetRef === VIEW, PAGE2, JSON.stringify(pre));
  }

  /* ═════════════ S3 · 导航被拒 ═════════════ */
  const PAGE3 = site.base + "/page3";
  {
    await setPlan([{ name: "browser_navigate", args: { viewId: VIEW, url: PAGE3 } }]);
    const run3 = await runTaskViaUI("把那个标签导航到 page3");
    const seen = await waitApproval(120000);
    const denyId = await approvalId();
    await click('[data-approval-action="deny"]');
    const term = await waitTaskTerminal(run3.taskId);
    void term;
    const call = callById(denyId);
    record("S3", "S3.0 · 审批面板出现且指向真实 SideEffectCall", seen && !!denyId && !!call, "approval → call", JSON.stringify({ id: denyId, found: !!call }));
    record("S3", "S3.1 · 拒绝后 SideEffectCall = BLOCKED（0 执行）", !!call && call.status === "BLOCKED", "BLOCKED", call ? call.status : "无 call");
    record("S3", "S3.2 · 拒绝后真实地址仍是 page2（没有任何导航发生）", (await value(ADDRESS_SEL)) === PAGE2 && !(await viewByExactUrl(PAGE3)), PAGE2, await value(ADDRESS_SEL));
    const panel = await visibleText(".ai-panel");
    record("S3", "S3.3 · UI 不产生任何\"已回滚/已撤销成功\"式幻觉结论", ILLUSION_WORDS.every((w) => !panel.includes(w)), "无幻觉文案", panel.slice(0, 120).replace(/\n/g, " "));
    record("S3", "S3.4 · 被拒的 call 没有租约、没有执行记录（0 lease / 0 execution）", !!call && leasesOf(call.call_id).length === 0 && execsOfTask(run3.taskId).length === 0, "0 lease / 0 execution", JSON.stringify({ leases: call ? leasesOf(call.call_id).length : null, execs: execsOfTask(run3.taskId).length }));
  }

  /* ═════════════ S4 · 目标失效 ═════════════ */
  {
    // (a) 模型自报一个**未授权** viewId
    const otherViewId = VIEW.replace(/#t\d+$/, "#t9");
    await setPlan([{ name: "browser_read_page", args: { viewId: otherViewId } }]);
    const run4 = await runTaskViaUI("读取那个标签");
    await waitTaskTerminal(run4.taskId);
    const execs = execsByTool("browser.read.page");
    const last = execs[execs.length - 1];
    record("S4", "S4.1 · 未授权 viewId → 执行 FAILED(BROWSER_CONTROL_NOT_SELECTED)", !!last && last.status === "FAILED" && last.error_code === "BROWSER_CONTROL_NOT_SELECTED", "FAILED/NOT_SELECTED", JSON.stringify(last ? { status: last.status, error: last.error_code } : null));
    // (b) 用户在 UI 上撤销授权 → 旧目标立即失效
    await click("[data-ai-control-toggle]");
    await waitFor(async () => (await controlState()) === "off", 10000);
    record("S4", "S4.2 · UI 撤销后主进程授权列表为空", (await controlTargets()).targets.length === 0, "0 targets", JSON.stringify((await controlTargets()).targets));
    await setPlan([{ name: "browser_read_page", args: { viewId: VIEW } }]);
    const run5 = await runTaskViaUI("再读一次那个标签");
    await waitTaskTerminal(run5.taskId);
    const execs2 = execsByTool("browser.read.page");
    const last2 = execs2[execs2.length - 1];
    record("S4", "S4.3 · 撤权后同一 viewId → 执行 FAILED（不回落、不改绑）", !!last2 && last2.status === "FAILED" && last2.error_code === "BROWSER_CONTROL_NOT_SELECTED", "FAILED/NOT_SELECTED", JSON.stringify(last2 ? { status: last2.status, error: last2.error_code } : null));
    // (c) 授权后关闭标签 → 目标被摘掉
    await click("[data-ai-control-toggle]");
    await waitFor(async () => (await controlState()) === "on", 10000);
    const targetsBefore = (await controlTargets()).targets.length;
    await click(".tab-new");
    await waitFor(async () => (await js("return document.querySelectorAll('[data-tab]').length")) >= 2, 15000);
    const tabs = await js("return Array.from(document.querySelectorAll('[data-tab]')).map(e=>e.getAttribute('data-tab')).join(',')");
    const authorizedTab = await js("return document.querySelector('[data-tab][data-ai-control-authorized=\"1\"]')?.getAttribute('data-tab') || ''");
    let pruned = false;
    if (authorizedTab) {
      await click('[data-tab="' + authorizedTab + '"] .tab-close');
      pruned = await waitFor(async () => (await controlTargets()).targets.length === 0, 15000);
    }
    record("S4", "S4.4 · 关掉被授权标签 → 主进程授权目标被摘掉（1 → 0）", targetsBefore === 1 && !!authorizedTab && pruned, "1 → 0", JSON.stringify({ before: targetsBefore, after: (await controlTargets()).targets.length, authorizedTab, tabs }));
  }

  /* ── S4 之后活动标签是新建的空白标签：先真实导航 + 重新授权，并取**当前** viewId ── */
  await navigate(PAGE2);
  await waitViewExact(PAGE2, 25000);
  if ((await controlState()) === "off") { await click("[data-ai-control-toggle]"); await waitFor(async () => (await controlState()) === "on", 10000); }
  const VIEW2 = await viewIdNow();
  record("ui", "U7 · S4 之后重新授权**新活动标签**并取到新的稳定身份（不复用已关闭标签的 id）", (await controlState()) === "on" && !!VIEW2 && VIEW2 !== VIEW, "on + 新 viewId", JSON.stringify({ before: VIEW, now: VIEW2 }));

  /* ═════════════ S5 · URL 与协议策略 ═════════════ */
  {
    const callsBefore = callsByTool("browser.navigate").length;
    const propsBefore = tableRows("task_tool_proposals").length;
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "https://u:p@example.com/x"]) {
      await setPlan([{ name: "browser_navigate", args: { viewId: VIEW2, url: bad } }]);
      const run6 = await runTaskViaUI("导航到 " + bad);
      await waitTaskTerminal(run6.taskId);
      // 只按**本次任务**定位提案，绝不与其它场景的提案串线。
      const props = tableRows("task_tool_proposals").filter((p) => p.tool_id === "browser.navigate" && p.task_id === run6.taskId);
      const lastP = props[props.length - 1];
      const dec = tableRows("tool_decisions").filter((d) => d.proposal_id === (lastP && lastP.proposal_id))[0];
      record("S5", "S5.x · 工具门拒绝 " + bad.split(":")[0] + ": 提案 INVALID + 0 side-effect call", props.length === 1 && !!dec && String(dec.reason_code) === "TOOL_ARGUMENT_INVALID" && callsOfTask(run6.taskId).length === 0, "TOOL_ARGUMENT_INVALID + 0 call", JSON.stringify({ decision: dec && dec.decision, reason: dec && dec.reason_code, calls: callsOfTask(run6.taskId).length }));
    }
    record("S5", "S5.z · 三个非法 URL 都未产生任何 SideEffectCall（也没有任何导航）", callsByTool("browser.navigate").length === callsBefore && tableRows("task_tool_proposals").length > propsBefore && !!viewByExactUrl(PAGE2), "0 新增 call", "calls=" + (callsByTool("browser.navigate").length - callsBefore));
  }

  /* ═════════════ S6 · 停止与预算 ═════════════ */
  {
    // 6a：审批等待中用户取消任务 → call BLOCKED、0 导航
    const callsBefore = callsByTool("browser.navigate").length;
    await setPlan([{ name: "browser_navigate", args: { viewId: VIEW2, url: PAGE3 } }]);
    const run7 = await runTaskViaUI("导航到 page3（随后我会取消）");
    const seen6 = await waitApproval(120000);
    const cancelId = await approvalId();
    await click("[data-ai-cancel]");
    const term = await waitTaskTerminal(run7.taskId, 60000);
    const got = await taskGet(run7.taskId);
    record("S6", "S6.0 · 取消前真实出现等待审批的 SideEffectCall", seen6 && !!callById(cancelId) && !!cancelId, "approval → call", JSON.stringify({ id: cancelId, found: !!callById(cancelId) }));
    // 取消 → 任务终态与 pending call 收敛是**两步**（后者由 resolvePendingForStep 下一轮轮询完成），
    // 因此这里等它真正落地，而不是在任务终态那一刻就断言（那是在测竞态，不是在测产品）。
    const converged = await waitFor(() => { const c = callById(cancelId); return !!c && c.status === "BLOCKED"; }, 15000);
    const call = callById(cancelId);
    record("S6", "S6.1 · 审批等待中取消 → 任务终止（非 SUCCEEDED）且该 call 收敛为 BLOCKED(TASK_CANCELLED)", term && got.task.status !== "SUCCEEDED" && !!call && call.status === "BLOCKED" && String(call.error_code) === "TASK_CANCELLED", "终止 + BLOCKED/TASK_CANCELLED", JSON.stringify({ task: got.task.status, call: call && call.status, error: call && call.error_code, converged }));
    record("S6", "S6.2 · 取消后 0 导航、0 执行 lease、地址不变", callsOfTask(run7.taskId).length === (call ? 1 : 0) && !!call && leasesOf(call.call_id).length === 0 && callsByTool("browser.navigate").length === callsBefore + (call ? 1 : 0) && (await value(ADDRESS_SEL)) === PAGE2, "0 导航/0 lease + 地址不变", JSON.stringify({ calls: callsByTool("browser.navigate").length - callsBefore, leases: call ? leasesOf(call.call_id).length : null, address: await value(ADDRESS_SEL) }));

    // 6b：工具预算到限 → 明确停止（不静默成功）
    const readsBefore = execsByTool("browser.read.page").filter((e) => e.status === "SUCCEEDED").length;
    await setPlan(Array.from({ length: 12 }, () => ({ name: "browser_read_page", args: { viewId: VIEW2 } })));
    const run8 = await runTaskViaUI("连续读取 12 次（应被预算截停）");
    const term8 = await waitTaskTerminal(run8.taskId, 240000);
    const got8 = await taskGet(run8.taskId);
    const readsAfter = execsByTool("browser.read.page").filter((e) => e.status === "SUCCEEDED").length - readsBefore;
    const budgetRows = tableRows("task_budgets").filter((b) => b.task_id === run8.taskId);
    record("S6", "S6.3 · 工具预算到限 → 有界停止（成功读取 ≤ 上限 8，且任务不假装成功）", term8 && readsAfter >= 1 && readsAfter <= 8 && got8.task.status !== "SUCCEEDED", "1..8 次读取 + 非 SUCCEEDED", JSON.stringify({ reads: readsAfter, status: got8.task.status, budgets: budgetRows.length }));
    const budgetText = await visibleText(".ai-panel");
    record("S6", "S6.4 · UI 如实显示停止原因（预算/停止），不静默", /BUDGET|预算|停止/.test(budgetText) || got8.task.status === "BLOCKED", "明确停止原因", budgetText.replace(/\n/g, " ").slice(0, 160));
  }

  // 主进程无未处理错误（证书类噪声不在本门禁范围内：本门禁不使用 TLS 自签站点）
  const tail = stderrBuf.split("\n").filter((l) => /error|Error|FATAL/.test(l)).filter((l) => !/ExperimentalWarning|SQLite is an experimental/i.test(l)).slice(0, 5);
  record("hygiene", "H1 · 主进程无未处理错误", tail.length === 0, "无错误行", tail.join(" | ") || "clean");

  notVerified("崩溃 / 强杀后的浏览器控制目标恢复", "不在本轮契约内：控制目标是会话内授权，进程重启后一律清空（不自动恢复授权，也不自动续接任务）。");
  notVerified("像素级层级真值（截图证明原生视图压在外壳之上）", "本机屏幕被另一个正在运行的 OpenArc 实例占用，无法独占前台截图；层级由 domain 常量与 DOM/视口几何断言覆盖，不冒充像素证据。");

  const out = {
    phase: "D5-01 Closure-2",
    title: "受控浏览器能力 · 真实产品链端到端（读取 / 导航 / 审批 / 目标失效 / URL 策略 / 停止与预算）",
    testedCommit: process.env.OPENARC_TESTED_COMMIT || null,
    workspaceState: process.env.OPENARC_WORKSPACE_STATE ?? null,
    command: process.env.npm_lifecycle_event ? "npm run " + process.env.npm_lifecycle_event : "node experiments/d5-01/browser-control-e2e.mjs",
    env: { platform: process.platform, arch: process.arch, node: process.version, electron: require("electron/package.json").version },
    isolation: { userData: "os.tmpdir mkdtemp", downloads: "os.tmpdir mkdtemp", site: "本地受控站点 127.0.0.1", provider: "本地确定性 provider（只替代最后一跳网络）" },
    checks: CHECKS, counts: { pass: passed, fail: failed, total: CHECKS.length },
    notVerified: NOT_VERIFIED, observations: OBSERVATIONS, operationRecord: RECORD, at: new Date().toISOString(),
  };
  fs.mkdirSync(ART, { recursive: true });
  fs.writeFileSync(path.join(ART, "d5-01-browser-control-e2e.json"), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(ART, "d5-01-browser-control-operation-record.jsonl"), RECORD.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log("\n结论：" + (failed === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ pass: passed, fail: failed, total: CHECKS.length, notVerified: NOT_VERIFIED.length }));
  return failed === 0 ? 0 : 1;
}

// 绝不在 finally 之前 process.exit：那会跳过子进程清理，留下占用调试端口的孤儿实例
// （上一轮实测：孤儿实例会让下一轮连到旧 userData/旧 provider，产出完全虚假的证据）。
let exitCode = 2;
try {
  exitCode = await main();
} catch (e) {
  console.error("E2E 异常：" + String((e && e.stack) || e));
  // 主进程 stderr 是诊断"模型调用/工具链内部错误"的唯一诚实来源（只落本地 artifacts）。
  console.error("--- main stderr tail ---");
  console.error(stderrBuf.split("\n").slice(-30).join("\n"));
  exitCode = 2;
}
try {
  if (browser) await browser.close().catch(() => {});
} catch { /* ignore */ }
try { if (child) child.kill("SIGKILL"); } catch { /* ignore */ }
killOurElectron();
try { if (site) await site.close(); } catch { /* ignore */ }
try { if (provider) await provider.close(); } catch { /* ignore */ }
process.exit(exitCode);

// 被外部强杀（Ctrl-C / SIGTERM）时也要带走子进程，绝不留下占用调试端口的孤儿实例。
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    try { if (child) child.kill("SIGKILL"); } catch { /* ignore */ }
    killOurElectron();
    process.exit(130);
  });
}
