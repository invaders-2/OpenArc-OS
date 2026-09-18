/**
 * D4 · 真实产品入口 electron/main.cjs 端到端 gate（产品入口版）。
 *
 * 真实启动产品 electron .（真实 main.cjs + 真实 preload + dist/index.html），
 * CDP 连接真实 Renderer，以真实 UI + window.openarc 产品桥驱动必需流程。
 *
 * 主进程内部状态只经两种只读途径获得：
 *   1) electron/main.cjs 唯一一处默认关闭 test seam：boot 观测（OPENARC_E2E_OBSERVE=1）；
 *   2) 只读打开隔离 userData 的 identity.db（node:sqlite readOnly）与 runtime/side-effects/executors 计数。
 * 绝不写库、绝不手工设终态。
 *
 * 工具权限一律经产品入口：优先真实治理 UI（组织治理 → App 权限 → 工具权限），
 * 或 window.openarc.governance.command 产品桥。已删除 OPENARC_E2E_SEED_TOOL_GRANTS test-only 播种。
 *
 * 必需流程与退出码契约：
 *   boot / setup / flow1 / flow2 / flow3 / flow4 / flow5 / flow6 全部必需：任一 FAIL 或 renderer/main 错误 > 0 → overallStatus FAIL 且 exit 非零。
 *   任一必需流程 NOT_VERIFIED → PARTIAL；全部 PASS → PASS 且 exitCode=0。
 *   绝不把 NOT_VERIFIED 当作通过。
 *
 * 流程 4 本轮经**真实产品入口**跑通：真实 UI 创建任务 → 出真实产物 → 经新增追加入口（[data-ai-append-*]，
 * task/appendStep）在同一 Task 追加下一步目标 → 后续 step 真实耗尽预算停止 → UI 显式续接（[data-ai-resume]，
 * task/resume）→ 完成。拒绝矩阵（并发 / 重复 revision / 陈旧 revision / 不安全状态 / 非 owner / 执行前撤权）
 * 与本条主流程同源同入口，且每条拒绝都有「可追加时确实可追加」的正对照。
 *
 * 流程 6 本轮经**真实产品入口**验证"任务版本固定"：真实 UI 新建任务 → 后端解析并冻结默认 model config
 * （renderer 自报无效）→ 经产品桥把该 config 提升版本 → 真实 UI 追加步骤必须明确 MODEL_CONFIG_CHANGED
 * （Task/Step/run 全 BLOCKED、0 新 model call、0 新 Artifact、旧产物逐字段不变、UI 如实显示错误）→
 * 新任务绑定新版本正常成功 → 默认切到另一个 config 后，绑定原 config 的任务 append/resume 仍成功且归属不变。
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { startD4Provider } from "./fixtures/d4-04-provider.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const CDP_PORT = Number(process.env.OA_MAIN_CDP_PORT || 9788);
const ADMIN = "admin@openarc.test";
const PW = "admin-password-1";
const MEMBER = "member-main-e2e@openarc.test";
const MEMBER_PW = "member-password-1";
const PROVIDER_SECRET = "main-e2e-provider-secret";
const TOOL_SEARCH = "tool.resource.search";
const TOOL_META = "tool.resource.readMetadata";
const TOOL_TRASH = "tool.resource.trash";
const TOOL_ACTIONS = [TOOL_SEARCH, TOOL_META, TOOL_TRASH];
const GOAL_TRASH = "MAIN-E2E WRITE: 把目标资源移入废纸篓";
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "").split(" ").filter(Boolean);

if (!fs.existsSync(path.join(ROOT, "dist", "index.html"))) { console.error("缺少 dist/index.html —— 请先执行 npm run build"); process.exit(1); }

const COMMAND = process.env.npm_lifecycle_event ? "npm run " + process.env.npm_lifecycle_event : "node tests/d4-main-e2e.mjs";
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d4-main-e2e-"));
const DB_PATH = path.join(userData, "identity.db");
const BOOT_PATH = path.join(userData, "openarc-e2e-boot.json");
const EXEC_DIR = path.join(userData, "runtime", "side-effects", "executors");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
const checks = [];
const notVerified = [];
const observations = [];
const FLOW_BUCKETS = { boot: [], setup: [], flow1: [], flow2: [], flow3: [], flow4: [], flow5: [], flow6: [] };
const record = (flow, name, ok, actual, expected) => {
  const okv = !!ok;
  checks.push({ flow, name, ok: okv, actual: String(actual == null ? "" : actual), expected: expected === undefined ? "" : String(expected) });
  if (FLOW_BUCKETS[flow]) FLOW_BUCKETS[flow].push(okv);
  console.log((okv ? "PASS" : "FAIL") + " [" + flow + "] " + name + " :: actual=" + String(actual) + " expected=" + String(expected));
};
const markNotVerified = (flow, name, reason, actual, expected) => {
  checks.push({ flow, name, ok: false, notVerified: true, actual: String(actual == null ? "" : actual), expected: String(expected == null ? "" : expected), reason });
  notVerified.push({ flow, name, reason });
  console.log("NOT_VERIFIED [" + flow + "] " + name + " :: " + reason);
};
const observe = (name, detail) => { observations.push({ name, detail }); console.log("OBSERVE " + name + " :: " + detail); };

const mainErrors = [];
const consoleErrors = [];
const R = { taskIds: {}, exec: {} };
let child = null;
let provider = null;
let browser = null;
let page = null;

function dbAll(sql, params) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try { return db.prepare(sql).all(...(params || [])); } finally { db.close(); }
}
function dbSnapshot() {
  const all = (t) => { try { return dbAll("SELECT * FROM " + t); } catch { return []; } };
  return {
    tasks: all("tasks"), steps: all("task_steps"), proposals: all("task_tool_proposals"),
    decisions: all("tool_decisions"), executions: all("tool_executions"),
    sideEffectCalls: all("side_effect_calls"), leases: all("side_effect_leases"),
    approvals: all("tool_approvals"), artifacts: all("task_artifacts"),
    verifications: all("task_verifications"), events: all("task_events"),
    resources: all("resource_registry"), appGrants: all("app_resource_grants"), modelCalls: all("task_model_calls"),
    runs: all("task_harness_runs"), budgets: all("task_budgets"), libraryResources: all("library_resources"),
  };
}
function toolGrantRows() { try { return dbAll("SELECT * FROM app_resource_grants WHERE app_id = 'ai' AND scope = 'TOOL'"); } catch { return []; } }
function executorRecordCount() { try { return fs.readdirSync(EXEC_DIR).filter((n) => n.endsWith(".json")).length; } catch { return 0; } }
const byTask = (rows, id) => (rows || []).filter((r) => r.task_id === id);

async function main() {
  provider = await startD4Provider();
  const env = { ...process.env, OPENARC_D4_PROVIDER_URL: provider.baseUrl, OPENARC_IDENTITY_ADMIN: "1", OPENARC_E2E_OBSERVE: "1" };
  // 播种 seam 已从真实 main 删除；这里显式清掉外部可能残留的 env，确保没有任何 test-only 权限代偿。
  delete env.OPENARC_E2E_SEED_TOOL_GRANTS;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  child = spawn(electronPath, [".", "--user-data-dir=" + userData, "--remote-debugging-port=" + CDP_PORT, ...extraArgs], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
  let stderrBuf = "";
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { stderrBuf += String(d); });

  let version = null;
  const cdpDeadline = Date.now() + 40000;
  while (!version && Date.now() < cdpDeadline) { try { version = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json(); } catch { await sleep(300); } }
  if (!version || !version.Browser) throw new Error("CDP 未就绪");
  record("boot", "M1 · 真实 electron .（electron/main.cjs）启动并暴露 CDP", true, version.Browser, "CDP ready");

  browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);
  const context = browser.contexts()[0];
  const isUI = (p) => p.url().includes("dist/index.html");
  const findUI = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { const p = context.pages().find(isUI); if (p) return p; await sleep(300); } return null; };
  page = await findUI(30000);
  if (!page) throw new Error("未找到界面页面：" + context.pages().map((p) => p.url()).join(" | "));
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(String(msg.text()).slice(0, 200)); });
  page.on("pageerror", (err) => consoleErrors.push(String((err && err.message) || err).slice(0, 200)));

  const js = (code) => page.evaluate("(async () => { " + code + " })()");
  const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
  const text = (sel) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.textContent || ''");
  const attr = (sel, a) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.getAttribute(" + JSON.stringify(a) + ") || ''");
  const isDisabled = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? !!el.disabled : true;");
  const click = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");
  const setInput = (sel, value) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : (el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype); const setter = Object.getOwnPropertyDescriptor(proto, 'value').set; setter.call(el, " + JSON.stringify(value) + "); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return 'ok';");
  const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
  async function waitFor(fn, timeout) { timeout = timeout || 30000; const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await Promise.resolve(fn())) return true; } catch { /* retry */ } await sleep(100); } return false; }
  async function waitSel(sel, timeout) { return waitFor(() => has(sel), timeout || 20000); }
  async function waitGate(want, timeout) { return waitFor(async () => (await gate()) === want, timeout || 30000); }
  const bridge = (domain, command) => js("return window.openarc." + domain + ".command(" + JSON.stringify(command) + ")");
  const taskGet = (taskId) => bridge("task", { type: "task/get", taskId });
  const gov = (command) => bridge("governance", command);
  const getToolAccess = () => gov({ type: "governance/getAppToolAccess", appId: "ai" });
  const grantToolsBridge = (actions) => gov({ type: "governance/grantAppToolAccess", appId: "ai", actions });
  async function waitTaskTerminal(taskId, timeout) { return waitFor(async () => { const got = await taskGet(taskId); const s = got && got.task && got.task.status; return ["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"].includes(s); }, timeout || 120000); }
  async function openPanel() { if (await has(".ai-panel")) return true; if (await waitSel(".assistant-pill", 30000)) await click(".assistant-pill"); return waitSel(".ai-panel", 20000); }
  async function runTask(goal) {
    await openPanel();
    const prev = await attr(".ai-panel", "data-ai-task-id");
    await setInput("[data-ai-goal]", goal);
    if (!(await waitFor(async () => !(await isDisabled("[data-ai-run]")), 60000))) throw new Error("run button never re-enabled");
    const c = await click("[data-ai-run]");
    if (c !== "ok") throw new Error("run click failed: " + c);
    const started = await waitFor(async () => { const id = await attr(".ai-panel", "data-ai-task-id"); return typeof id === "string" && id.length > 0 && id !== prev; }, 30000);
    const taskId = await attr(".ai-panel", "data-ai-task-id");
    return { taskId, started };
  }
  async function waitApproval(timeout) {
    await waitFor(async () => (await attr("[data-approval-request-id]", "data-approval-request-id")).length > 0, timeout || 120000);
    return attr("[data-approval-request-id]", "data-approval-request-id");
  }
  async function setPlan(mode, extra) {
    const control = provider.baseUrl.replace("/v1", "") + "/__plan";
    const res = await fetch(control, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ mode }, extra || {})) });
    return res.ok;
  }
  async function createResource(name, type, content) { const r = await bridge("resource", { type: "resource/create", resourceType: type || "text", name, content: content || (name + "-body") }); return r && r.ok ? { id: r.resource.resourceId, ref: r.resource.resourceRef, raw: r } : { raw: r }; }
  async function grantAiResource(id) { return bridge("governance", { type: "governance/grantAppAccess", appId: "ai", resourceId: id, actions: ["resource.read", "resource.delete", "resource.useByAgent"] }); }
  async function clickApprove() { return click('[data-approval-action="approve"]'); }
  async function loginAs(id, pw) {
    if (!(await waitSel('[data-d3-id="login-identifier"]', 15000))) return false;
    await setInput('[data-d3-id="login-identifier"]', id);
    await setInput('[data-d3-id="login-password"]', pw);
    await sleep(100);
    await click('[data-d3-id="login-submit"]');
    return waitGate("ready", 30000);
  }
  async function logout() { const c = await click('[data-d3-id="topbar-logout"]'); return c === "ok" && await waitGate("unauthenticated", 20000); }
  // ---------------------------------------------------------------- 真实治理 UI：授予 ai TOOL 权限
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
    const verified = await waitFor(async () => { const ta = await getToolAccess(); return !!(ta && ta.ok && actions.every((a) => (ta.grantedActions || []).includes(a))); }, 20000);
    return { ok: verified, reason: verified ? "ui-granted" : "ui-not-verified" };
  }

  // ---------------------------------------------------------------- boot 观测（唯一 boot seam）
  await waitSel('[data-d3-id="setup-name"]', 30000);
  const bootRaw = fs.existsSync(BOOT_PATH) ? fs.readFileSync(BOOT_PATH, "utf8") : null;
  let boot = null;
  try { boot = bootRaw ? JSON.parse(bootRaw) : null; } catch { boot = null; }
  record("boot", "B0 · boot 观测文件存在且可解析（OPENARC_E2E_OBSERVE=1）", !!boot, bootRaw ? "parsed" : "missing", "openarc-e2e-boot.json");
  const expectedOrder = ["identity_created", "model_proxy_start_attempted", "model_proxy_started", "runtime_ready"];
  const orderIdx = boot ? expectedOrder.map((s) => (boot.bootOrder || []).indexOf(s)) : [];
  const orderOk = !!boot && orderIdx.every((i) => i >= 0) && orderIdx.every((i, k) => k === 0 || i > orderIdx[k - 1]);
  record("boot", "B1 · bootOrder 严格有序", orderOk, JSON.stringify(boot && boot.bootOrder), expectedOrder.join(" -> "));
  record("boot", "B2 · Model Proxy 任务接入前真实启动并监听", !!boot && boot.modelProxyStartAttempted === true && boot.modelProxyStarted === true && boot.modelProxyListening === true, JSON.stringify(boot ? { attempted: boot.modelProxyStartAttempted, started: boot.modelProxyStarted, listening: boot.modelProxyListening } : null), "attempted+started+listening");

  // ---------------------------------------------------------------- 真实 UI：首次初始化 + 登录
  record("setup", "A1 · 真实 UI 首次初始化（FIRST RUN）", await has('[data-d3-id="setup-form"]'), "setup-form", "present");
  await setInput('[data-d3-id="setup-name"]', "Main E2E Admin");
  await setInput('[data-d3-id="setup-identifier"]', ADMIN);
  await setInput('[data-d3-id="setup-password"]', PW);
  await setInput('[data-d3-id="setup-confirm"]', PW);
  await sleep(120);
  record("setup", "A2 · 真实 UI 提交初始化", (await click('[data-d3-id="setup-submit"]')) === "ok", "clicked", "ok");
  record("setup", "A3 · 初始化后 gate=unauthenticated", await waitGate("unauthenticated", 30000), await gate(), "unauthenticated");
  await setInput('[data-d3-id="login-identifier"]', ADMIN);
  await setInput('[data-d3-id="login-password"]', PW);
  await sleep(100);
  record("setup", "A4 · 真实 UI 登录 admin", (await click('[data-d3-id="login-submit"]')) === "ok", "clicked", "ok");
  record("setup", "A5 · 登录后 identity gate=ready", await waitGate("ready", 30000), await gate(), "ready");
  const taskBridgeKeys = await js("return window.openarc && window.openarc.task ? Object.keys(window.openarc.task).sort().join(',') : 'missing'");
  record("setup", "A6 · 真实 preload Task 桥只有 command,onEvent", taskBridgeKeys === "command,onEvent", taskBridgeKeys, "command,onEvent");
  record("setup", "A7 · Renderer 拿不到主进程 Domain", await js("return typeof window.openarc.taskService === 'undefined' && typeof window.openarc.resourceService === 'undefined'"), "hidden", "hidden");
  record("setup", "A8 · 无 test-only 播种：起始 app TOOL grant 为 0", toolGrantRows().length === 0, toolGrantRows().length, 0);

  // ---------------------------------------------------------------- 真实 UI：Settings → Models
  await click('[data-app-id="settings"]');
  await waitSel('[data-settings-pane="model"]', 20000);
  await click('[data-settings-pane="model"]');
  const settingsOpen = await waitSel('[data-d4-01="settings"]', 20000);
  record("setup", "S1 · 打开 Settings → 模型 / AI（真实 UI）", settingsOpen, settingsOpen ? "open" : "missing", "open");
  await setInput('[data-d4-01-provider-name]', "Main E2E Provider");
  await setInput('[data-d4-01-provider-scope]', "ORGANIZATION");
  await setInput('[data-d4-01-provider-url]', provider.baseUrl);
  await setInput('[data-d4-01-provider-secret]', PROVIDER_SECRET);
  await click('[data-d4-01-provider-create]');
  const providerCreated = await waitSel('[data-d4-01-provider]', 20000);
  const pid = await attr("[data-d4-01-provider]", "data-d4-01-provider");
  record("setup", "S2 · 真实 UI 创建本地确定性 Provider", providerCreated && !!pid, pid ? "created" : "missing", "created");
  record("setup", "S3 · 保存后密钥输入框清空（write-only）", (await js("return document.querySelector('[data-d4-01-provider-secret]').value")) === "", "cleared", "cleared");
  await click('[data-d4-01-tab="models"]');
  await waitSel('[data-d4-01-pane="models"]', 20000);
  await setInput('[data-d4-01-model-provider]', pid);
  await setInput('[data-d4-01-model-scope]', "ORGANIZATION");
  await setInput('[data-d4-01-model-remote]', "main-e2e-local");
  await setInput('[data-d4-01-model-name]', "Main E2E Local");
  await click('[data-d4-01-model-create]');
  const modelCreated = await waitSel('[data-d4-01-model]', 20000);
  const cid = await attr("[data-d4-01-model]", "data-d4-01-model");
  record("setup", "S4 · 真实 UI 注册 Model", modelCreated && !!cid, cid ? "created" : "missing", "created");
  await click('[data-d4-01-tab="defaults"]');
  await waitSel('[data-d4-01-pane="defaults"]', 20000);
  await setInput('[data-d4-01-default-personal-chat]', cid);
  await waitFor(async () => (await js("return document.querySelector('[data-d4-01-default-personal-chat]').value")) === cid, 15000);
  await setInput('[data-d4-01-default-org-chat]', cid);
  const orgDefaultOk = await waitFor(async () => (await js("return document.querySelector('[data-d4-01-default-org-chat]').value")) === cid, 15000);
  record("setup", "S5 · 真实 UI 设置默认 chat model（personal + organization）", orgDefaultOk, "org=" + (await js("return document.querySelector('[data-d4-01-default-org-chat]').value")), cid);
  await setPlan("final");
  await click('[data-d4-01-tab="providers"]');
  await waitSel('[data-d4-01-pane="providers"]', 15000);
  await click('[data-d4-01-test="' + pid + '"]');
  const testPassed = await waitFor(async () => (await text('[data-d4-01-test-result="' + pid + '"]')).indexOf("Inference:PASS") >= 0, 30000);
  record("setup", "S6 · 真实 UI 连接测试 Inference:PASS", testPassed, await text('[data-d4-01-test-result="' + pid + '"]'), "Inference:PASS");

  const flowReached = { flow1: false, flow2: false, flow3: false, flow4: false, flow5: false, flow6: false };

  // ================================================================ 流程 1：管理员授权 → WRITE 审批 → 一次副作用 → 成功
  const uiGrant = await grantToolsViaUI(TOOL_ACTIONS);
  record("flow1", "F1.0a · 真实治理 UI 给 ai 授予三个 TOOL 动作", uiGrant.ok, JSON.stringify(uiGrant), "ok=true");
  const taAfterGrant = await getToolAccess();
  record("flow1", "F1.0b · getAppToolAccess 反映三个 TOOL 动作全部已授予", !!(taAfterGrant && taAfterGrant.ok) && TOOL_ACTIONS.every((a) => (taAfterGrant.grantedActions || []).includes(a)), JSON.stringify(taAfterGrant && taAfterGrant.grantedActions), JSON.stringify(TOOL_ACTIONS));

  const target = await createResource("Main E2E Target", "text");
  record("flow1", "F1.1 · 经产品桥 resource/create 造目标资源", !!target.ref, target.ref ? "created" : JSON.stringify(target.raw && target.raw.error), "created");
  const reindex = await bridge("resource", { type: "resource/reindex", resourceRef: target.ref });
  record("flow1", "F1.2 · 经产品桥 resource/reindex 建索引", !!(reindex && reindex.ok), reindex && reindex.ok ? "ok" : JSON.stringify(reindex), "ok");
  const targetGrant = await grantAiResource(target.id);
  record("flow1", "F1.3 · 经产品治理入口给 ai 授予资源级 read/delete/useByAgent", !!(targetGrant && targetGrant.ok), targetGrant && targetGrant.ok ? "ok" : JSON.stringify(targetGrant), "ok");
  await setPlan("write", { resourceRef: target.ref });
  const writeRun = await runTask(GOAL_TRASH);
  R.taskIds.flow1 = writeRun.taskId;
  const writeApprovalId = await waitApproval(120000);
  record("flow1", "F1.4 · 真实 UI 任务发起并进入 AWAITING_APPROVAL（Approval UI 出现）", writeRun.started && !!writeApprovalId, JSON.stringify({ started: writeRun.started, approval: !!writeApprovalId }), "started + approval visible");
  const preWrite = dbSnapshot();
  const preCall = byTask(preWrite.sideEffectCalls, writeRun.taskId)[0];
  const preResource = preWrite.resources.find((r) => r.resource_id === target.id);
  record("flow1", "F1.5 · 审批前 0 mutation / 0 lease / 0 WRITE execution", !!preCall && preCall.status === "AWAITING_APPROVAL" && preResource && preResource.status === "active" && preWrite.leases.filter((l) => l.call_id === (preCall && preCall.call_id)).length === 0 && byTask(preWrite.executions, writeRun.taskId).filter((e) => e.tool_id === "resource.trash").length === 0, JSON.stringify({ call: preCall && preCall.status, resource: preResource && preResource.status }), "AWAITING_APPROVAL + active + 0/0");
  const approvalText = (await text(".approval")).replace(/\s+/g, " ").slice(0, 140);
  record("flow1", "F1.6 · Approval UI 显示 tool / risk / target", approvalText.includes("resource.trash") && approvalText.includes("可逆写入") && approvalText.includes("Main E2E Target"), approvalText, "tool+risk+target");
  await waitFor(async () => !(await isDisabled('[data-approval-action="approve"]')), 15000);
  record("flow1", "F1.7 · 点击真实 Approve", (await clickApprove()) === "ok", "clicked", "ok");
  const writeTerminal = await waitTaskTerminal(writeRun.taskId, 180000);
  const writeGet = await taskGet(writeRun.taskId);
  const writeStatus = writeGet && writeGet.task && writeGet.task.status;
  const postWrite = dbSnapshot();
  const writeCall = byTask(postWrite.sideEffectCalls, writeRun.taskId)[0];
  const writeStep = byTask(postWrite.steps, writeRun.taskId)[0];
  const writeCallIds = byTask(postWrite.sideEffectCalls, writeRun.taskId).map((c) => c.call_id);
  const writeLeases = postWrite.leases.filter((l) => writeCallIds.includes(l.call_id));
  const writeApprovals = postWrite.approvals.filter((a) => writeCallIds.includes(a.call_id));
  const writeArts = byTask(postWrite.artifacts, writeRun.taskId);
  const writeVers = byTask(postWrite.verifications, writeRun.taskId);
  const writeResource = postWrite.resources.find((r) => r.resource_id === target.id);
  const writeExecs = byTask(postWrite.executions, writeRun.taskId);
  const mutation = writeResource && writeResource.status !== "active" ? 1 : 0;
  record("flow1", "F1.8 · Task/Step SUCCEEDED", writeTerminal && writeStatus === "SUCCEEDED" && writeStep && writeStep.status === "SUCCEEDED", JSON.stringify({ task: writeStatus, step: writeStep && writeStep.status }), "SUCCEEDED/SUCCEEDED");
  record("flow1", "F1.9 · 恰 1 次 mutation（目标资源已 trash）", mutation === 1, mutation, 1);
  record("flow1", "F1.10 · SideEffectCall=1 / approval=1 / lease=1 / verification PASS", byTask(postWrite.sideEffectCalls, writeRun.taskId).length === 1 && writeCall.status === "SUCCEEDED" && writeCall.verification_status === "PASS" && writeApprovals.filter((a) => a.decision === "APPROVED").length === 1 && writeLeases.length === 1, JSON.stringify({ calls: byTask(postWrite.sideEffectCalls, writeRun.taskId).length, call: writeCall.status, ver: writeCall.verification_status, approvals: writeApprovals.length, leases: writeLeases.length }), "1/1/1/PASS");
  record("flow1", "F1.11 · lease 状态 RELEASED", writeLeases.length === 1 && writeLeases[0].status === "RELEASED", writeLeases.length ? writeLeases[0].status : "none", "RELEASED");
  record("flow1", "F1.12 · Artifact/Verification 齐全且相互绑定 + checksum 正确", writeArts.length === 1 && writeVers.length === 1 && writeVers[0].artifact_id === writeArts[0].artifact_id && writeArts[0].checksum === sha256(writeArts[0].safe_content), JSON.stringify({ artifacts: writeArts.length, verifications: writeVers.length }), "1+1 绑定");
  record("flow1", "F1.13 · 受控 READ execution 归属本任务 + WRITE 以 SideEffectCall 记录", writeExecs.some((e) => e.tool_id === "resource.search") && writeExecs.every((e) => e.task_id === writeRun.taskId) && byTask(postWrite.sideEffectCalls, writeRun.taskId).some((c) => c.tool_id === "resource.trash"), JSON.stringify({ reads: writeExecs.map((e) => e.tool_id), writes: byTask(postWrite.sideEffectCalls, writeRun.taskId).map((c) => c.tool_id) }), "search execution + trash sideEffectCall");
  R.exec.flow1Spawned = executorRecordCount();
  record("flow1", "F1.14 · production executor 真实 spawn（runtime/side-effects/executors 记录 >=1）", R.exec.flow1Spawned >= 1, R.exec.flow1Spawned, ">=1");
  flowReached.flow1 = true;

  // ================================================================ 流程 2：撤权停止（待批准时经产品入口撤销 ai 的 TOOL grant）
  const revokeTarget = await createResource("Main E2E Revoke Target", "text");
  await grantAiResource(revokeTarget.id);
  await setPlan("write", { resourceRef: revokeTarget.ref });
  const revokeRun = await runTask("MAIN-E2E REVOKE: 把 Main E2E Revoke Target 移入废纸篓");
  R.taskIds.flow2 = revokeRun.taskId;
  const revokeApprovalId = await waitApproval(120000);
  record("flow2", "F2.1 · 待审批 call 就绪（Approval UI 可见）", !!revokeApprovalId, revokeApprovalId ? "AWAITING_APPROVAL" : "missing", "AWAITING_APPROVAL");
  const accessBeforeRevoke = await getToolAccess();
  const toolGrant = accessBeforeRevoke && Array.isArray(accessBeforeRevoke.grants) ? accessBeforeRevoke.grants[0] : null;
  const execBefore = executorRecordCount();
  const revoke = toolGrant ? await gov({ type: "governance/revokeAppToolAccess", grantId: toolGrant.grantId }) : { ok: false, error: "NO_TOOL_GRANT" };
  record("flow2", "F2.2 · 经产品治理入口 revokeAppToolAccess 撤销 ai 的 TOOL grant（changed=true）", !!(revoke && revoke.ok && revoke.changed === true), JSON.stringify(revoke), "ok=true, changed=true");
  const accessAfterRevoke = await getToolAccess();
  record("flow2", "F2.3 · 撤权后 grantedActions 清空 / DB TOOL grant 为 0", !!(accessAfterRevoke && accessAfterRevoke.ok) && (accessAfterRevoke.grantedActions || []).length === 0 && toolGrantRows().length === 0, JSON.stringify({ granted: accessAfterRevoke && accessAfterRevoke.grantedActions, rows: toolGrantRows().length }), "[] + 0");
  await waitFor(async () => !(await isDisabled('[data-approval-action="approve"]')), 15000);
  record("flow2", "F2.4 · 使用旧批准（真实 UI Approve）", (await clickApprove()) === "ok", "clicked", "ok");
  const revokeTerminal = await waitTaskTerminal(revokeRun.taskId, 180000);
  const postRevoke = dbSnapshot();
  const revokeCall = byTask(postRevoke.sideEffectCalls, revokeRun.taskId)[0];
  const revokeTask = postRevoke.tasks.find((t) => t.task_id === revokeRun.taskId);
  const revokeStep = byTask(postRevoke.steps, revokeRun.taskId)[0];
  const revokeResource = postRevoke.resources.find((r) => r.resource_id === revokeTarget.id);
  const revokeLeases = postRevoke.leases.filter((l) => revokeCall && l.call_id === revokeCall.call_id);
  const execAfter = executorRecordCount();
  record("flow2", "F2.5 · 撤权后旧批准不得执行：Call BLOCKED + SIDE_EFFECT_AUTHORIZATION_REVOKED", revokeTerminal && !!revokeCall && revokeCall.status === "BLOCKED" && revokeCall.error_code === "SIDE_EFFECT_AUTHORIZATION_REVOKED", JSON.stringify({ call: revokeCall && revokeCall.status, error: revokeCall && revokeCall.error_code }), "BLOCKED + SIDE_EFFECT_AUTHORIZATION_REVOKED");
  record("flow2", "F2.6 · 0 mutation / 0 新 lease / 0 新 executor", revokeResource && revokeResource.status === "active" && revokeLeases.length === 0 && execAfter === execBefore, JSON.stringify({ resource: revokeResource && revokeResource.status, leases: revokeLeases.length, exec: execBefore + "->" + execAfter }), "active + 0 lease + exec 不变");
  const runEnabledAfterRevoke = await waitFor(async () => !(await isDisabled("[data-ai-run]")), 20000);
  record("flow2", "F2.7 · Task/Step BLOCKED + UI busy 复位", revokeTask && revokeTask.status === "BLOCKED" && revokeStep && revokeStep.status === "BLOCKED" && runEnabledAfterRevoke, JSON.stringify({ task: revokeTask && revokeTask.status, step: revokeStep && revokeStep.status, runEnabled: runEnabledAfterRevoke, runButtonDisabled: await isDisabled("[data-ai-run]") }), "BLOCKED/BLOCKED + run enabled");
  flowReached.flow2 = true;

  // ================================================================ 流程 3：明确 WRITE 被拒（不授予 ai 的 tool.resource.trash）
  const partialGrant = await grantToolsBridge([TOOL_SEARCH, TOOL_META]);
  record("flow3", "F3.1 · 经产品治理入口只授予 search/readMetadata（显式不授予 trash）", !!(partialGrant && partialGrant.ok), JSON.stringify(partialGrant), "ok=true");
  const accessFlow3 = await getToolAccess();
  const trashGranted = !!(accessFlow3 && (accessFlow3.grantedActions || []).includes(TOOL_TRASH));
  record("flow3", "F3.2 · 前置：trash TOOL 权限未被授予", !trashGranted, JSON.stringify(accessFlow3 && accessFlow3.grantedActions), "trash absent");
  const denyTarget = await createResource("Main E2E Deny Target", "text");
  await grantAiResource(denyTarget.id);
  await setPlan("deny", { resourceRef: denyTarget.ref, finalText: "完成" });
  const denyRun = await runTask("MAIN-E2E DENY: 把 Main E2E Deny Target 移入废纸篓");
  R.taskIds.flow3 = denyRun.taskId;
  const denyTerminal = await waitTaskTerminal(denyRun.taskId, 180000);
  const denyGet = await taskGet(denyRun.taskId);
  const denyStatus = denyGet && denyGet.task && denyGet.task.status;
  const denySnap = dbSnapshot();
  const denyTask = denySnap.tasks.find((t) => t.task_id === denyRun.taskId);
  const denyStep = byTask(denySnap.steps, denyRun.taskId)[0];
  const denyResource = denySnap.resources.find((r) => r.resource_id === denyTarget.id);
  const denyCalls = byTask(denySnap.sideEffectCalls, denyRun.taskId);
  const denyOps = denyGet && Array.isArray(denyGet.deniedOperations) ? denyGet.deniedOperations : [];
  const trashOp = denyOps.find((o) => o.toolId === "resource.trash");
  record("flow3", "F3.3 · Task/Step BLOCKED（不得 SUCCEEDED）", denyTerminal && denyStatus === "BLOCKED" && denyTask && denyTask.status === "BLOCKED" && denyStep && denyStep.status === "BLOCKED", JSON.stringify({ task: denyStatus, step: denyStep && denyStep.status }), "BLOCKED/BLOCKED");
  record("flow3", "F3.4 · 0 mutation / 无 SideEffectCall", denyResource && denyResource.status === "active" && denyCalls.length === 0, JSON.stringify({ resource: denyResource && denyResource.status, sideEffectCalls: denyCalls.length }), "active + 0 call");
  record("flow3", "F3.5 · task/get.deniedOperations 含 resource.trash + TOOL_APP_NOT_GRANTED", !!trashOp && trashOp.reasonCode === "TOOL_APP_NOT_GRANTED", JSON.stringify(denyOps.map((o) => ({ tool: o.toolId, reason: o.reasonCode }))), "trash + TOOL_APP_NOT_GRANTED");
  const deniedVisible = await waitFor(async () => await has("[data-ai-denied]"), 20000);
  const deniedToolText = (await text("[data-ai-denied-tool]")).trim();
  const deniedReasonText = (await text("[data-ai-denied-reason]")).trim();
  const statusText = (await text("[data-ai-status-text]")).trim();
  const resultText = (await text("[data-ai-result]")).trim();
  record("flow3", "F3.6 · AI 面板 data-ai-denied 可见（tool/target/reason），状态 BLOCKED", deniedVisible && deniedToolText.includes("resource.trash") && deniedReasonText.includes("TOOL_APP_NOT_GRANTED") && statusText.indexOf("BLOCKED") >= 0, JSON.stringify({ deniedVisible, tool: deniedToolText, reason: deniedReasonText, status: statusText }), "data-ai-denied + BLOCKED");
  record("flow3", "F3.7 · 明确 WRITE 被拒不得假成功：无 SUCCEEDED 文案 / 无成功产物", denyStatus !== "SUCCEEDED" && !resultText.includes("完成") && denyCalls.length === 0, JSON.stringify({ status: denyStatus, result: resultText.slice(0, 40) }), "not SUCCEEDED + empty result");
  const denyProposalIds = new Set(byTask(denySnap.proposals, denyRun.taskId).map((p) => p.proposal_id));
  const denyDecisions = denySnap.decisions.filter((d) => denyProposalIds.has(d.proposal_id) && d.reason_code === "TOOL_APP_NOT_GRANTED" && d.decision === "DENIED");
  const denyExecs = byTask(denySnap.executions, denyRun.taskId).filter((e) => e.tool_id === "resource.trash");
  record("flow3", "F3.8 · 后端记录：DENIED/TOOL_APP_NOT_GRANTED + 0 trash execution", denyDecisions.length >= 1 && denyExecs.length === 0, JSON.stringify({ decisions: denyDecisions.length, trashExecutions: denyExecs.length }), ">=1 decision + 0 execution");
  flowReached.flow3 = true;
  // ================================================================ 流程 4：同一任务追加下一步目标 → 预算停止 → UI 显式续接（真实产品入口）
  //
  // 顺序契约：拒绝矩阵所需的若干小任务先建，"追加 → 预算停止 → 续接成功"的主任务最后创建，
  // 使流程 5 刷新后 AI 面板恢复的最新任务就是它。所有结论只来自真实 UI / 产品桥 / 只读 DB。
  const KINDS = ["MODEL_CALLS", "TOOL_CALLS", "TOOL_ROUNDS"];
  const kindSnapshot = (ledger) => {
    const out = {};
    for (const k of KINDS) out[k] = { authorized: ledger.kinds[k].authorized, consumed: ledger.kinds[k].consumed, remaining: ledger.kinds[k].remaining };
    return out;
  };
  const norm = (v) => String(v == null ? "" : v).replace(/\s+/g, "");
  const stepsOfTask = (s, id) => byTask(s.steps, id).slice().sort((a, b) => Number(a.sequence) - Number(b.sequence));
  const artsOfTask = (s, id) => byTask(s.artifacts, id);
  const versOfTask = (s, id) => byTask(s.verifications, id);
  const runsOfTask = (s, id) => byTask(s.runs, id);
  const resourceOf = (s, id) => s.resources.find((r) => r.resource_id === id);
  const trashStateOf = (s, id) => ((s.libraryResources || []).find((r) => r.resource_id === id) || {}).trash_state;
  const inputValue = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? String(el.value) : null;");
  const appendViaBridge = (taskId, goal, expectedRevision) => bridge("task", { type: "task/appendStep", taskId, goal, expectedRevision });
  // 在途状态下 task revision 仍会随在途事件推进：始终以刚读到的 revision 重试，直到拿到确定性拒绝或接收。
  async function appendStable(taskId, goal, attempts = 8) {
    let res = null;
    let used = 0;
    for (let i = 0; i < attempts; i += 1) {
      const g = await taskGet(taskId);
      res = await appendViaBridge(taskId, goal, g.task.revision);
      used = i + 1;
      if (!(res && res.ok === false && res.error === "TASK_REVISION_CONFLICT")) return { res, attempts: used };
      await sleep(200);
    }
    return { res, attempts: used };
  }
  let lastApprovalId = "";
  async function waitApprovalEx(prevId, timeout) {
    const ok = await waitFor(async () => { const id = await attr("[data-approval-request-id]", "data-approval-request-id"); return id.length > 0 && id !== prevId; }, timeout || 120000);
    return ok ? await attr("[data-approval-request-id]", "data-approval-request-id") : "";
  }
  async function approveCurrent() { await waitFor(async () => !(await isDisabled('[data-approval-action="approve"]')), 15000); return clickApprove(); }
  const F4_APPEND_GOAL = "MAIN-E2E FLOW4 第二步：连续读取直至预算到限";
  const F4_REVOKE_GOAL = "MAIN-E2E FLOW4-REVOKE 第二步：把 Main E2E Flow4 Revoke Target 2 移入废纸篓";

  /* ---------------- 14 前置：经产品入口重新授予三个 TOOL 动作（F3.1 之后 trash 未授予，写入会被 DENY） ---------------- */
  const f4Grant = await grantToolsBridge(TOOL_ACTIONS);
  const f4Access = await getToolAccess();
  record("flow4", "F4.0 · 14 前置：经产品治理入口重新授予 search/readMetadata/trash（F3 的显式拒绝语义不被污染，仅并集追加）",
    !!(f4Grant && f4Grant.ok) && TOOL_ACTIONS.every((a) => (f4Access.grantedActions || []).includes(a)),
    JSON.stringify({ ok: f4Grant && f4Grant.ok, granted: f4Access && f4Access.grantedActions }), JSON.stringify(TOOL_ACTIONS));

  /* ---------------- 14(a) 小任务：同一 revision 真并发两次产品桥追加，恰好 1 次成功 ---------------- */
  const dupTarget = await createResource("Main E2E Flow4 Dup Target", "text");
  record("flow4", "F4.1 · 14(a) 小任务经产品桥 resource/create 造目标资源", !!dupTarget.ref, dupTarget.ref ? "created" : JSON.stringify(dupTarget.raw && dupTarget.raw.error), "created");
  await grantAiResource(dupTarget.id);
  await setPlan("write", { resourceRef: dupTarget.ref });
  const dupRun = await runTask("MAIN-E2E FLOW4-DUP: 把 Main E2E Flow4 Dup Target 移入废纸篓");
  R.taskIds.flow4Dup = dupRun.taskId;
  const dupApprovalId = await waitApprovalEx(lastApprovalId, 120000); lastApprovalId = dupApprovalId;
  await approveCurrent();
  const dupTerminal = await waitTaskTerminal(dupRun.taskId, 180000);
  const dupGet1 = await taskGet(dupRun.taskId);
  const dupSnap1 = dbSnapshot();
  const dupCall1 = byTask(dupSnap1.sideEffectCalls, dupRun.taskId)[0];
  const dupRes1 = resourceOf(dupSnap1, dupTarget.id);
  record("flow4", "F4.2 · 14(a) 小任务第一步真实成功（Task/Step SUCCEEDED + 1 Artifact + 1 Verification + trash 副作用 SUCCEEDED + 资源真实移入废纸篓）",
    dupTerminal && dupGet1.task.status === "SUCCEEDED" && (dupGet1.artifacts || []).length === 1 && (dupGet1.verifications || []).length === 1 && !!dupCall1 && dupCall1.status === "SUCCEEDED" && !!dupRes1 && dupRes1.status === "deleted" && trashStateOf(dupSnap1, dupTarget.id) === "TRASHED",
    JSON.stringify({ task: dupGet1.task.status, artifacts: (dupGet1.artifacts || []).length, verifications: (dupGet1.verifications || []).length, call: dupCall1 && dupCall1.status, resource: dupRes1 && dupRes1.status, trashState: trashStateOf(dupSnap1, dupTarget.id) }),
    "SUCCEEDED + 1/1 + call SUCCEEDED + registry deleted/trash_state TRASHED");
  record("flow4", "F4.3 · 14(f) 正对照：14(a) 小任务此刻 task/get.appendable=true（可追加时确实可追加）", dupGet1.appendable === true, String(dupGet1.appendable), "true");
  const dupR1 = dupGet1.task.revision;
  await setPlan("final");
  const dupConcurrent = await Promise.all([
    appendViaBridge(dupRun.taskId, "并发追加 A", dupR1),
    appendViaBridge(dupRun.taskId, "并发追加 B", dupR1),
  ]);
  const dupWins = dupConcurrent.filter((r) => r && r.ok === true);
  const dupLoses = dupConcurrent.filter((r) => !r || r.ok !== true);
  const dupAfterConcurrent = await taskGet(dupRun.taskId);
  record("flow4", "F4.4 · 14(a) 同一 revision 真并发（Promise.all 两次产品桥调用）恰好 1 次成功、step 数只 +1",
    dupWins.length === 1 && dupLoses.length === 1 && (dupAfterConcurrent.steps || []).length === 2,
    JSON.stringify({ results: dupConcurrent.map((r) => ({ ok: r && r.ok, error: r && r.error, reason: r && r.reason })), steps: (dupAfterConcurrent.steps || []).length }),
    "1 winner + steps=2");
  record("flow4", "F4.5 · 14(a) 并发赢家同步返回 { ok:true, taskId 不变, status:RUNNING }；拒绝方同步拒绝且无 running 异步面",
    dupWins.length === 1 && dupWins[0].taskId === dupRun.taskId && dupWins[0].status === "RUNNING" && dupLoses.length === 1 && ["TASK_REVISION_CONFLICT", "APPEND_NOT_ALLOWED"].includes(dupLoses[0].error) && !("running" in dupLoses[0]),
    JSON.stringify({ winner: dupWins[0] && { taskId: dupWins[0].taskId, status: dupWins[0].status }, loser: dupLoses[0] && { error: dupLoses[0].error, reason: dupLoses[0].reason } }),
    "winner RUNNING + loser 同步拒绝");
  const dupRepeat = await appendViaBridge(dupRun.taskId, "重复追加（同一 R1）", dupR1);
  const dupAfterRepeat = await taskGet(dupRun.taskId);
  record("flow4", "F4.6 · 14(a) 追加被接受后用同一 revision 再发起：同步被拒且 step 数不增（仍 2）",
    dupRepeat.ok === false && ["TASK_REVISION_CONFLICT", "APPEND_NOT_ALLOWED"].includes(dupRepeat.error) && (dupAfterRepeat.steps || []).length === 2,
    JSON.stringify({ error: dupRepeat.error, reason: dupRepeat.reason, steps: (dupAfterRepeat.steps || []).length }), "同步拒绝 + steps=2");
  const dupTerminal2 = await waitTaskTerminal(dupRun.taskId, 180000);
  const dupGetFinal = await taskGet(dupRun.taskId);
  record("flow4", "F4.7 · 14(a) 小任务追加的第二步真实运行收敛（Task SUCCEEDED + 2 Artifact + 2 step）",
    dupTerminal2 && dupGetFinal.task.status === "SUCCEEDED" && (dupGetFinal.artifacts || []).length === 2 && (dupGetFinal.steps || []).length === 2,
    JSON.stringify({ task: dupGetFinal.task.status, artifacts: (dupGetFinal.artifacts || []).length, steps: (dupGetFinal.steps || []).length }), "SUCCEEDED + 2 artifacts + 2 steps");

  /* ---------------- 14(c) 不安全状态（一）：flow3 的 BLOCKED 任务 ---------------- */
  const f3GetB = await taskGet(R.taskIds.flow3);
  const f3SnapB = dbSnapshot();
  const f3StepsB = stepsOfTask(f3SnapB, R.taskIds.flow3).length;
  const f3Rej = await appendViaBridge(R.taskIds.flow3, "对 BLOCKED 任务的追加", f3GetB.task.revision);
  const f3SnapA = dbSnapshot();
  const f3TaskA = f3SnapA.tasks.find((t) => t.task_id === R.taskIds.flow3);
  record("flow4", "F4.8 · 14(c) 对 flow3 的 BLOCKED 任务追加：APPEND_NOT_ALLOWED + reason APPEND_NOT_SUCCEEDED",
    f3Rej.ok === false && f3Rej.error === "APPEND_NOT_ALLOWED" && f3Rej.reason === "APPEND_NOT_SUCCEEDED",
    JSON.stringify(f3Rej), "APPEND_NOT_ALLOWED + APPEND_NOT_SUCCEEDED");
  record("flow4", "F4.9 · 14(c) 该拒绝 0 新增 step / task 状态与 revision 不变（task/get.appendReason 同因）",
    f3StepsB === stepsOfTask(f3SnapA, R.taskIds.flow3).length && f3TaskA.status === f3GetB.task.status && f3TaskA.revision === f3GetB.task.revision && f3GetB.appendReason === "APPEND_NOT_SUCCEEDED",
    JSON.stringify({ steps: f3StepsB + "->" + stepsOfTask(f3SnapA, R.taskIds.flow3).length, status: f3TaskA.status, revision: f3TaskA.revision, appendReason: f3GetB.appendReason }),
    "steps=1 不变 + 状态/revision 不变");
  const dupControl1 = await taskGet(dupRun.taskId);
  record("flow4", "F4.10 · 14(f) 正对照：同一时刻 14(a) 小任务 appendable=true（拒绝只发生在不安全状态）", dupControl1.appendable === true, String(dupControl1.appendable), "true");

  /* ---------------- 14(e)：执行前撤权不产生受保护操作（并为 14(c) 提供 AWAITING_APPROVAL 状态） ---------------- */
  const revTarget = await createResource("Main E2E Flow4 Revoke Target", "text");
  record("flow4", "F4.11 · 14(e) 撤权任务第一步目标资源经产品桥真实创建", !!revTarget.ref, revTarget.ref ? "created" : JSON.stringify(revTarget.raw && revTarget.raw.error), "created");
  await grantAiResource(revTarget.id);
  await setPlan("write", { resourceRef: revTarget.ref });
  const revRun = await runTask("MAIN-E2E FLOW4-REVOKE: 把 Main E2E Flow4 Revoke Target 移入废纸篓");
  R.taskIds.flow4Revoke = revRun.taskId;
  const revApproval1 = await waitApprovalEx(lastApprovalId, 120000); lastApprovalId = revApproval1;
  await approveCurrent();
  const revTerminal1 = await waitTaskTerminal(revRun.taskId, 180000);
  const revGet1 = await taskGet(revRun.taskId);
  const revSnap1 = dbSnapshot();
  const revArts1 = artsOfTask(revSnap1, revRun.taskId);
  const revVers1 = versOfTask(revSnap1, revRun.taskId);
  record("flow4", "F4.12 · 14(e) 撤权任务第一步真实成功且 appendable=true（第二步确有可追加资格）",
    revTerminal1 && revGet1.task.status === "SUCCEEDED" && revArts1.length === 1 && revVers1.length === 1 && revGet1.appendable === true,
    JSON.stringify({ task: revGet1.task.status, artifacts: revArts1.length, verifications: revVers1.length, appendable: revGet1.appendable }), "SUCCEEDED + 1/1 + appendable=true");
  const revTarget2 = await createResource("Main E2E Flow4 Revoke Target 2", "text");
  await grantAiResource(revTarget2.id);
  await setPlan("write", { resourceRef: revTarget2.ref });
  const revAppend = await appendViaBridge(revRun.taskId, F4_REVOKE_GOAL, revGet1.task.revision);
  record("flow4", "F4.13 · 14(e) 真实追加一个 WRITE 类第二步：同步接受 ok=true / taskId 不变 / status=RUNNING",
    revAppend.ok === true && revAppend.taskId === revRun.taskId && revAppend.status === "RUNNING",
    JSON.stringify({ ok: revAppend.ok, taskId: revAppend.taskId, status: revAppend.status }), "ok=true + 同一 taskId + RUNNING");
  const revApproval2 = await waitApprovalEx(revApproval1, 120000); lastApprovalId = revApproval2;
  record("flow4", "F4.14 · 14(e) 第二步进入 AWAITING_APPROVAL（真实 WRITE 审批 UI 出现）", !!revApproval2, revApproval2 ? "AWAITING_APPROVAL" : "missing", "AWAITING_APPROVAL");
  const revGetPending = await taskGet(revRun.taskId);
  const revInFlightAttempt = await appendStable(revRun.taskId, "待批准时追加");
  const revInFlight = revInFlightAttempt.res;
  const revStepsPending = stepsOfTask(dbSnapshot(), revRun.taskId).length;
  record("flow4", "F4.15 · 14(c) 对处于 AWAITING_APPROVAL 的任务追加：APPEND_NOT_ALLOWED + reason ∈ {APPEND_IN_FLIGHT, APPEND_SIDE_EFFECT_PENDING}，无新 step（在途 revision 会推进，须以最新 revision 重试才拿到状态拒绝）",
    revInFlight.ok === false && revInFlight.error === "APPEND_NOT_ALLOWED" && ["APPEND_IN_FLIGHT", "APPEND_SIDE_EFFECT_PENDING"].includes(revInFlight.reason) && revStepsPending === 2,
    JSON.stringify({ taskStatus: revGetPending.task.status, error: revInFlight.error, reason: revInFlight.reason, attempts: revInFlightAttempt.attempts, steps: revStepsPending }), "APPEND_NOT_ALLOWED + IN_FLIGHT/SIDE_EFFECT_PENDING + steps=2");
  const dupControl2 = await taskGet(dupRun.taskId);
  record("flow4", "F4.16 · 14(f) 正对照：同一时刻 14(a) 小任务 appendable=true（未决副作用只阻断自身任务）", dupControl2.appendable === true, String(dupControl2.appendable), "true");
  const accessBeforeAppendRevoke = await getToolAccess();
  const revGrant = accessBeforeAppendRevoke && Array.isArray(accessBeforeAppendRevoke.grants) ? accessBeforeAppendRevoke.grants[0] : null;
  const execBeforeAppendRevoke = executorRecordCount();
  const appendRevoke = revGrant ? await gov({ type: "governance/revokeAppToolAccess", grantId: revGrant.grantId }) : { ok: false, error: "NO_TOOL_GRANT" };
  record("flow4", "F4.17 · 14(e) 经产品治理入口 revokeAppToolAccess 撤销 ai 的 TOOL grant（changed=true）", !!(appendRevoke && appendRevoke.ok && appendRevoke.changed === true), JSON.stringify(appendRevoke), "ok=true + changed=true");
  const accessAfterAppendRevoke = await getToolAccess();
  record("flow4", "F4.18 · 14(e) 撤权后 grantedActions 清空 / DB TOOL grant 为 0",
    !!(accessAfterAppendRevoke && accessAfterAppendRevoke.ok) && (accessAfterAppendRevoke.grantedActions || []).length === 0 && toolGrantRows().length === 0,
    JSON.stringify({ granted: accessAfterAppendRevoke && accessAfterAppendRevoke.grantedActions, rows: toolGrantRows().length }), "[] + 0");
  const revApproved = await approveCurrent();
  const revTerminal2 = await waitTaskTerminal(revRun.taskId, 180000);
  const revGet2 = await taskGet(revRun.taskId);
  const revSnap2 = dbSnapshot();
  const revSteps2 = stepsOfTask(revSnap2, revRun.taskId);
  const revCalls2 = byTask(revSnap2.sideEffectCalls, revRun.taskId);
  const revBlockedCall = revCalls2.find((c) => c.status === "BLOCKED");
  const revRes2 = resourceOf(revSnap2, revTarget2.id);
  const revLeaseCount2 = revSnap2.leases.filter((l) => l.call_id === (revBlockedCall && revBlockedCall.call_id)).length;
  record("flow4", "F4.19 · 14(e) 撤权后旧批准不得执行：Call BLOCKED + SIDE_EFFECT_AUTHORIZATION_REVOKED",
    revTerminal2 && revApproved === "ok" && !!revBlockedCall && revBlockedCall.error_code === "SIDE_EFFECT_AUTHORIZATION_REVOKED",
    JSON.stringify({ call: revBlockedCall && revBlockedCall.status, error: revBlockedCall && revBlockedCall.error_code }), "BLOCKED + SIDE_EFFECT_AUTHORIZATION_REVOKED");
  record("flow4", "F4.20 · 14(e) 0 mutation（Target 2 仍 active）/ 0 新 lease / 0 新 executor",
    !!revRes2 && revRes2.status === "active" && revLeaseCount2 === 0 && executorRecordCount() === execBeforeAppendRevoke,
    JSON.stringify({ resource: revRes2 && revRes2.status, blockedCall: revBlockedCall && revBlockedCall.status, blockedCallLeases: revLeaseCount2, exec: execBeforeAppendRevoke + "->" + executorRecordCount() }), "active + blocked call 0 lease + exec 不变");
  record("flow4", "F4.21 · 14(e) 第一步 Artifact/Verification 逐字段保留 + 该任务只有 1 条 SUCCEEDED 副作用",
    revSteps2.length === 2 && revSteps2[0].status === "SUCCEEDED" && revSteps2[1].status === "BLOCKED"
      && JSON.stringify([revSteps2[0]]) === JSON.stringify([stepsOfTask(revSnap1, revRun.taskId)[0]])
      && JSON.stringify(artsOfTask(revSnap2, revRun.taskId)) === JSON.stringify(revArts1)
      && JSON.stringify(versOfTask(revSnap2, revRun.taskId)) === JSON.stringify(revVers1)
      && revCalls2.filter((c) => c.status === "SUCCEEDED").length === 1 && revCalls2.length === 2,
    JSON.stringify({ steps: revSteps2.map((s) => s.status), artifacts: artsOfTask(revSnap2, revRun.taskId).length, verifications: versOfTask(revSnap2, revRun.taskId).length, callStatuses: revCalls2.map((c) => c.status) }),
    "2 step(SUCCEEDED/BLOCKED) + 1 artifact + 1 SUCCEEDED call");
  record("flow4", "F4.22 · 14(e) 撤权任务 BLOCKED / 2 steps / 1 artifact / appendReason=APPEND_NOT_SUCCEEDED（流程 5 复用）",
    revGet2.task.status === "BLOCKED" && (revGet2.steps || []).length === 2 && (revGet2.artifacts || []).length === 1 && revGet2.appendReason === "APPEND_NOT_SUCCEEDED",
    JSON.stringify({ status: revGet2.task.status, steps: (revGet2.steps || []).length, artifacts: (revGet2.artifacts || []).length, appendReason: revGet2.appendReason }),
    "BLOCKED + 2 steps + 1 artifact + APPEND_NOT_SUCCEEDED");
  R.flow4Revoke = { steps: (revGet2.steps || []).length, artifacts: (revGet2.artifacts || []).length, appendReason: revGet2.appendReason, status: revGet2.task.status };
  const regrant = await grantToolsViaUI(TOOL_ACTIONS);
  record("flow4", "F4.23 · 14(f) 正对照：经真实治理 UI 重新授予三个 TOOL 动作（主任务的真实 WRITE 依赖它）", regrant.ok, JSON.stringify(regrant), "ok=true");

  /* ---------------- 主任务（必须最后创建）：真实 UI 创建 → 追加 → 预算停止 → UI 续接 → 成功 ---------------- */
  const heroTarget = await createResource("Main E2E Flow4 Target", "text");
  record("flow4", "F4.24 · 主任务目标资源经产品桥真实创建", !!heroTarget.ref, heroTarget.ref ? "created" : JSON.stringify(heroTarget.raw && heroTarget.raw.error), "created");
  await grantAiResource(heroTarget.id);
  await setPlan("write", { resourceRef: heroTarget.ref });
  const heroHistoryStart = provider.state.history.length;
  const heroRun = await runTask("MAIN-E2E FLOW4: 把 Main E2E Flow4 Target 移入废纸篓");
  R.taskIds.flow4 = heroRun.taskId;
  const heroApproval1 = await waitApprovalEx(lastApprovalId, 120000); lastApprovalId = heroApproval1;
  record("flow4", "F4.25 · 主任务经真实 UI 发起并进入 AWAITING_APPROVAL", heroRun.started && !!heroApproval1, JSON.stringify({ started: heroRun.started, approval: !!heroApproval1 }), "started + approval");
  await approveCurrent();
  const heroTerminal1 = await waitTaskTerminal(heroRun.taskId, 180000);
  const heroGet1 = await taskGet(heroRun.taskId);
  const heroSnap1 = dbSnapshot();
  const heroSteps1 = stepsOfTask(heroSnap1, heroRun.taskId);
  const heroArts1 = artsOfTask(heroSnap1, heroRun.taskId);
  const heroVers1 = versOfTask(heroSnap1, heroRun.taskId);
  const heroCall1 = byTask(heroSnap1.sideEffectCalls, heroRun.taskId)[0];
  const heroRes1 = resourceOf(heroSnap1, heroTarget.id);
  const heroExecBefore = executorRecordCount();
  record("flow4", "F4.26 · 第一步真实成功：Task/Step SUCCEEDED + 1 Artifact + 1 Verification（相互绑定 + checksum 正确）",
    heroTerminal1 && heroGet1.task.status === "SUCCEEDED" && heroSteps1.length === 1 && heroSteps1[0].status === "SUCCEEDED" && heroArts1.length === 1 && heroVers1.length === 1
      && heroVers1[0].artifact_id === heroArts1[0].artifact_id && heroArts1[0].checksum === sha256(heroArts1[0].safe_content),
    JSON.stringify({ task: heroGet1.task.status, step: heroSteps1[0] && heroSteps1[0].status, artifacts: heroArts1.length, verifications: heroVers1.length }),
    "SUCCEEDED + 1 artifact + 1 verification");
  record("flow4", "F4.27 · 第一步真实副作用：SideEffectCall=1 SUCCEEDED + 资源真实移入废纸篓 + mutation=1",
    byTask(heroSnap1.sideEffectCalls, heroRun.taskId).length === 1 && !!heroCall1 && heroCall1.status === "SUCCEEDED" && !!heroRes1 && heroRes1.status === "deleted" && trashStateOf(heroSnap1, heroTarget.id) === "TRASHED",
    JSON.stringify({ calls: byTask(heroSnap1.sideEffectCalls, heroRun.taskId).length, call: heroCall1 && heroCall1.status, resource: heroRes1 && heroRes1.status, trashState: trashStateOf(heroSnap1, heroTarget.id), mutation: heroRes1 && heroRes1.status !== "active" ? 1 : 0 }),
    "1 call SUCCEEDED + registry deleted/TRASHED + mutation=1");
  const appendBlockVisible = await waitSel("[data-ai-append-block]", 30000);
  const appendGoalVisible = appendBlockVisible && (await has("[data-ai-append-goal]"));
  const appendBtnVisible = appendBlockVisible && (await has("[data-ai-append]"));
  record("flow4", "F4.28 · task/get.appendable=true 且 UI 出现 [data-ai-append-block] + [data-ai-append-goal] + [data-ai-append]",
    heroGet1.appendable === true && appendBlockVisible && appendGoalVisible && appendBtnVisible,
    JSON.stringify({ appendable: heroGet1.appendable, block: appendBlockVisible, goal: appendGoalVisible, button: appendBtnVisible }), "appendable=true + 三个选择器可见");
  const heroStep1UiStatus = await attr('[data-ai-step="1"]', "data-ai-step-status");
  record("flow4", "F4.29 · [data-ai-steps] 内 [data-ai-step=\"1\"][data-ai-step-status=\"SUCCEEDED\"]",
    (await has("[data-ai-steps]")) && heroStep1UiStatus === "SUCCEEDED", JSON.stringify({ steps: await has("[data-ai-steps]"), step1: heroStep1UiStatus }), "steps 容器 + step1 SUCCEEDED");
  const ledgerBefore = heroGet1.budgetLedger;
  const budgetBeforeAppend = kindSnapshot(ledgerBefore);
  const ledgerShapeOk = KINDS.every((k) => Number.isFinite(ledgerBefore.kinds[k].authorized) && Number.isFinite(ledgerBefore.kinds[k].consumed) && Number.isFinite(ledgerBefore.kinds[k].remaining) && ledgerBefore.kinds[k].consumed <= ledgerBefore.kinds[k].authorized);
  record("flow4", "F4.30 · 追加前账本快照（task/get.budgetLedger 三类 authorized/consumed/remaining，consumed<=authorized）",
    ledgerShapeOk, JSON.stringify(budgetBeforeAppend), "三类齐全且自洽");
  await setPlan("budget");
  const heroPanelTaskBefore = await attr(".ai-panel", "data-ai-task-id");
  await setInput("[data-ai-append-goal]", F4_APPEND_GOAL);
  const appendReady = await waitFor(async () => !(await isDisabled("[data-ai-append]")), 15000);
  const appendClicked = await click("[data-ai-append]");
  const appendAcceptedSync = await waitFor(async () => { const g = await taskGet(heroRun.taskId); return !!(g && g.ok && g.task.status === "RUNNING" && (g.steps || []).length === 2); }, 15000);
  const heroPanelTaskAfter = await attr(".ai-panel", "data-ai-task-id");
  // 接收后后端 appendable=false（该 step 在途），UI 要么清空输入框、要么整块收起；两者都不能留下可再次提交的旧目标。
  const appendGoalCleared = await waitFor(async () => { const v = await inputValue("[data-ai-append-goal]"); return v === "" || (v === null && !(await has("[data-ai-append-block]"))); }, 10000);
  const appendBlockGone = !(await has("[data-ai-append-block]"));
  const noAppendError = !(await has("[data-ai-error]"));
  record("flow4", "F4.31 · 真实 UI 点击 [data-ai-append]：同一 Task（data-ai-task-id 不变）+ 同步接收（返回时已 2 steps / RUNNING）+ 输入框清空且无错误",
    appendReady && appendClicked === "ok" && appendAcceptedSync && heroPanelTaskBefore === heroRun.taskId && heroPanelTaskAfter === heroRun.taskId && appendGoalCleared && noAppendError,
    JSON.stringify({ ready: appendReady, click: appendClicked, syncAccepted: appendAcceptedSync, panelTaskId: heroPanelTaskAfter, goalClearedOrBlockGone: appendGoalCleared, appendBlockGone, noErrorElement: noAppendError }),
    "ok + 同一 taskId + 同步 2 steps + 清空");
  const heroSteps2 = stepsOfTask(dbSnapshot(), heroRun.taskId);
  let heroStep2Input = null; try { heroStep2Input = JSON.parse(heroSteps2[1].input); } catch { heroStep2Input = null; }
  record("flow4", "F4.32 · 追加后 task_steps 恰好 2 行；第二行 sequence=2 / input.appended=true / input.goal=用户输入",
    heroSteps2.length === 2 && Number(heroSteps2[1].sequence) === 2 && !!heroStep2Input && heroStep2Input.appended === true && heroStep2Input.goal === F4_APPEND_GOAL,
    JSON.stringify({ steps: heroSteps2.length, sequence: heroSteps2[1] && heroSteps2[1].sequence, appended: heroStep2Input && heroStep2Input.appended, goal: heroStep2Input && heroStep2Input.goal }),
    "2 steps + sequence2 + appended=true + goal 一致");
  record("flow4", "F4.33 · 旧 step 行逐字段不变（append 前后 DB 行 JSON 快照相等）",
    JSON.stringify([heroSteps1[0]]) === JSON.stringify([heroSteps2[0]]),
    JSON.stringify(heroSteps2[0]) === JSON.stringify(heroSteps1[0]) ? "row-identical" : JSON.stringify({ before: heroSteps1[0], after: heroSteps2[0] }), "row-identical");
  const heroGet2 = await taskGet(heroRun.taskId);
  const budgetAfterAppend = kindSnapshot(heroGet2.budgetLedger);
  record("flow4", "F4.34 · 追加未改变三类 budget authorized（快照相等，append 不增加额度）",
    KINDS.every((k) => budgetAfterAppend[k].authorized === budgetBeforeAppend[k].authorized) && KINDS.every((k) => budgetAfterAppend[k].consumed >= budgetBeforeAppend[k].consumed),
    JSON.stringify({ before: budgetBeforeAppend, after: budgetAfterAppend }), "authorized 三类全等");
  const heroStale1 = await appendViaBridge(heroRun.taskId, "陈旧 revision 追加（追加被接受后）", heroGet1.task.revision);
  const heroStepsAfterStale1 = stepsOfTask(dbSnapshot(), heroRun.taskId).length;
  record("flow4", "F4.35 · 14(a)/14(b) 追加被接受后用同一 R1 再发起：同步 TASK_REVISION_CONFLICT，step 数不增（仍 2）",
    heroStale1.ok === false && heroStale1.error === "TASK_REVISION_CONFLICT" && heroStepsAfterStale1 === 2,
    JSON.stringify({ error: heroStale1.error, current: heroStale1.current, steps: heroStepsAfterStale1 }), "TASK_REVISION_CONFLICT + steps=2");
  const heroStopTerminal = await waitTaskTerminal(heroRun.taskId, 300000);
  const heroGetStop = await taskGet(heroRun.taskId);
  const heroSnapStop = dbSnapshot();
  const heroStepsStop = stepsOfTask(heroSnapStop, heroRun.taskId);
  const heroRunsStop = runsOfTask(heroSnapStop, heroRun.taskId);
  const heroStep2Run = heroRunsStop.filter((r) => r.step_id === heroStepsStop[1].step_id);
  record("flow4", "F4.36 · 第二步真实耗尽预算：Task/Step BLOCKED + stopReason=BUDGET_EXHAUSTED + 该 step 有真实 harness run（run.error_code 同因）",
    heroStopTerminal && heroGetStop.task.status === "BLOCKED" && heroStepsStop[1].status === "BLOCKED" && heroGetStop.stopReason === "BUDGET_EXHAUSTED"
      && heroStep2Run.length === 1 && heroStep2Run[0].error_code === "BUDGET_EXHAUSTED" && heroRunsStop.length === 2,
    JSON.stringify({ task: heroGetStop.task.status, step2: heroStepsStop[1].status, stopReason: heroGetStop.stopReason, runs: heroRunsStop.length, step2RunError: heroStep2Run[0] && heroStep2Run[0].error_code }),
    "BLOCKED/BLOCKED + BUDGET_EXHAUSTED + 真实 run");
  record("flow4", "F4.37 · 预算路径该 step 0 新增 Artifact（既有 F4.2 语义保留：预算停止不产出产物）",
    artsOfTask(heroSnapStop, heroRun.taskId).length === 1 && (heroGetStop.artifacts || []).length === 1,
    JSON.stringify({ dbArtifacts: artsOfTask(heroSnapStop, heroRun.taskId).length, getArtifacts: (heroGetStop.artifacts || []).length }), 1);
  const heroCallsStop = byTask(heroSnapStop.sideEffectCalls, heroRun.taskId);
  const heroResStop = resourceOf(heroSnapStop, heroTarget.id);
  const heroLeaseIdsStop = new Set(heroCallsStop.map((c) => c.call_id));
  const heroLeaseCountStop = heroSnapStop.leases.filter((l) => heroLeaseIdsStop.has(l.call_id)).length;
  record("flow4", "F4.38 · 第一步产物与副作用在预算停止后保持不变（step/artifact/verification 行逐字段不变 + 仍 1 条 SUCCEEDED call + 资源仍处于废纸篓 + 0 新 lease/executor）",
    JSON.stringify([heroStepsStop[0]]) === JSON.stringify([heroSteps1[0]])
      && JSON.stringify(artsOfTask(heroSnapStop, heroRun.taskId)) === JSON.stringify(heroArts1)
      && JSON.stringify(versOfTask(heroSnapStop, heroRun.taskId)) === JSON.stringify(heroVers1)
      && heroCallsStop.length === 1 && heroCallsStop[0].status === "SUCCEEDED" && !!heroResStop && heroResStop.status === "deleted" && trashStateOf(heroSnapStop, heroTarget.id) === "TRASHED" && heroResStop.updated_at === heroRes1.updated_at
      && heroLeaseCountStop === 1 && byTask(heroSnapStop.executions, heroRun.taskId).filter((e) => e.tool_id === "resource.trash").length === 0 && executorRecordCount() === heroExecBefore,
    JSON.stringify({ step1: heroStepsStop[0].status, artifacts: artsOfTask(heroSnapStop, heroRun.taskId).length, calls: heroCallsStop.map((c) => c.status), resource: heroResStop && heroResStop.status, trashState: trashStateOf(heroSnapStop, heroTarget.id), resourceUpdatedAt: heroResStop && heroResStop.updated_at + "/" + (heroRes1 && heroRes1.updated_at), leases: heroLeaseCountStop, exec: heroExecBefore + "->" + executorRecordCount() }),
    "旧行不变 + 1 SUCCEEDED + trashed 未再变 + 0 新 lease/executor");
  const heroStale2 = await appendViaBridge(heroRun.taskId, "第二步 BLOCKED 后的陈旧追加", heroGet1.task.revision);
  const heroStepsAfterStale2 = stepsOfTask(dbSnapshot(), heroRun.taskId).length;
  record("flow4", "F4.39 · 14(b) 第二步已 BLOCKED 后用陈旧 revision 追加：TASK_REVISION_CONFLICT，step 数不变（2）",
    heroStale2.ok === false && heroStale2.error === "TASK_REVISION_CONFLICT" && heroStepsAfterStale2 === 2,
    JSON.stringify({ error: heroStale2.error, current: heroStale2.current, steps: heroStepsAfterStale2 }), "TASK_REVISION_CONFLICT + steps=2");
  const resumeVisible = await waitSel("[data-ai-resume]", 30000);
  const stopReasonRaw = await text("[data-ai-stop-reason]");
  const resumeBudgetUi = await text("[data-ai-resume-budget]");
  const resumeRemainingUi = await text("[data-ai-resume-remaining]");
  const heroGetStopUi = await taskGet(heroRun.taskId);
  const ledgerStop = heroGetStopUi.budgetLedger;
  const budgetStopSnapshot = kindSnapshot(ledgerStop);
  const nextGrant = ledgerStop.nextGrant;
  const remStop = ledgerStop.remaining;
  const expBudgetText = "本次追加预算：" + nextGrant.kind + " +" + nextGrant.amount + "（该 kind 任务剩余 " + remStop[nextGrant.kind] + "）（第 " + (ledgerStop.resumeCount + 1) + "/" + ledgerStop.maxResumes + " 次续接）";
  const expRemainingText = "三类剩余：MODEL_CALLS " + remStop.MODEL_CALLS + " / TOOL_CALLS " + remStop.TOOL_CALLS + " / TOOL_ROUNDS " + remStop.TOOL_ROUNDS;
  record("flow4", "F4.40 · UI 出现 [data-ai-resume] 且 [data-ai-stop-reason] 含 BUDGET_EXHAUSTED",
    resumeVisible && norm(stopReasonRaw).includes("BUDGET_EXHAUSTED"), JSON.stringify({ resume: resumeVisible, stopReason: stopReasonRaw }), "resume 可见 + 含 BUDGET_EXHAUSTED");
  record("flow4", "F4.41 · [data-ai-resume-budget] 文本 == 后端 task/get.budgetLedger.nextGrant（kind/amount/该 kind 剩余/第 N/M 次续接）",
    !!nextGrant && norm(resumeBudgetUi) === norm(expBudgetText),
    JSON.stringify({ ui: resumeBudgetUi, expected: expBudgetText, nextGrant }), "与 nextGrant 完全一致");
  record("flow4", "F4.42 · [data-ai-resume-remaining] 文本 == 后端三类 remaining（MODEL_CALLS/TOOL_CALLS/TOOL_ROUNDS）",
    norm(resumeRemainingUi) === norm(expRemainingText),
    JSON.stringify({ ui: resumeRemainingUi, expected: expRemainingText }), "与三类 remaining 完全一致");
  await setPlan("final");
  const resumeReady = await waitFor(async () => !(await isDisabled("[data-ai-resume]")), 15000);
  const resumeClicked = await click("[data-ai-resume]");
  const heroFinalTerminal = await waitTaskTerminal(heroRun.taskId, 180000);
  const heroGetFinal = await taskGet(heroRun.taskId);
  const heroSnapFinal = dbSnapshot();
  const heroStepsFinal = stepsOfTask(heroSnapFinal, heroRun.taskId);
  record("flow4", "F4.43 · 点击 [data-ai-resume] 后最终 Task SUCCEEDED + 恰好 3 个 step（SUCCEEDED/BLOCKED/SUCCEEDED）",
    resumeReady && resumeClicked === "ok" && heroFinalTerminal && heroGetFinal.task.status === "SUCCEEDED" && heroStepsFinal.length === 3 && heroStepsFinal.map((s) => s.status).join(",") === "SUCCEEDED,BLOCKED,SUCCEEDED",
    JSON.stringify({ click: resumeClicked, task: heroGetFinal.task.status, steps: heroStepsFinal.map((s) => s.status) }), "SUCCEEDED + SUCCEEDED,BLOCKED,SUCCEEDED");
  const heroArtsFinal = artsOfTask(heroSnapFinal, heroRun.taskId);
  const heroVersFinal = versOfTask(heroSnapFinal, heroRun.taskId);
  const heroRunsFinal = runsOfTask(heroSnapFinal, heroRun.taskId);
  record("flow4", "F4.44 · 最终 2 Artifact + 2 Verification（续接 run 真实产出第二个产物）",
    (heroGetFinal.artifacts || []).length === 2 && (heroGetFinal.verifications || []).length === 2 && heroArtsFinal.length === 2 && heroVersFinal.length === 2,
    JSON.stringify({ getArtifacts: (heroGetFinal.artifacts || []).length, getVerifications: (heroGetFinal.verifications || []).length, dbArtifacts: heroArtsFinal.length, dbVerifications: heroVersFinal.length }),
    "2 artifacts + 2 verifications");
  const ledgerFinal = heroGetFinal.budgetLedger;
  const budgetFinal = kindSnapshot(ledgerFinal);
  const additions = ledgerFinal.additions || [];
  record("flow4", "F4.45 · 账本 additions 恰好 1 条：kind/amount == 续接前 nextGrant，且含 consumedAtGrant；resumeCount=1",
    additions.length === 1 && additions[0].kind === nextGrant.kind && additions[0].amount === nextGrant.amount && additions[0].consumedAtGrant != null && ledgerFinal.resumeCount === 1,
    JSON.stringify({ additions: additions.map((a) => ({ kind: a.kind, amount: a.amount, consumedAtGrant: a.consumedAtGrant != null, grantedAt: a.grantedAt != null })), resumeCount: ledgerFinal.resumeCount, beforeNextGrant: nextGrant }),
    "1 addition == nextGrant + consumedAtGrant");
  record("flow4", "F4.46 · 只有被批准 kind 的 authorized 增加该 amount，其他 kind authorized 不变",
    KINDS.every((k) => (k === nextGrant.kind ? budgetFinal[k].authorized === budgetBeforeAppend[k].authorized + nextGrant.amount : budgetFinal[k].authorized === budgetBeforeAppend[k].authorized)),
    JSON.stringify({ beforeAuthorized: budgetBeforeAppend, afterAuthorized: budgetFinal, grantedKind: nextGrant.kind, amount: nextGrant.amount }), "仅 granted kind +amount");
  record("flow4", "F4.47 · 三类 consumed 单调不减且 <= authorized（remaining = authorized - consumed）",
    KINDS.every((k) => budgetFinal[k].consumed >= budgetBeforeAppend[k].consumed && budgetFinal[k].consumed >= budgetStopSnapshot[k].consumed && budgetFinal[k].consumed <= budgetFinal[k].authorized && budgetFinal[k].remaining === budgetFinal[k].authorized - budgetFinal[k].consumed),
    JSON.stringify(budgetFinal), "单调不减 + <=authorized");
  const heroHistory = provider.state.history.slice(heroHistoryStart);
  const modelRequests = heroHistory.length;
  const byMode = heroHistory.reduce((m, h) => { m[h.mode] = (m[h.mode] || 0) + 1; return m; }, {});
  record("flow4", "F4.48 · 实际调用次数 vs 账本：MODEL_CALLS consumed == 该任务三次 run 的真实模型请求数（provider.state.history 增量）",
    modelRequests > 0 && budgetFinal.MODEL_CALLS.consumed === modelRequests,
    JSON.stringify({ providerRequests: modelRequests, byMode, ledgerModelConsumed: budgetFinal.MODEL_CALLS.consumed, modelCallEnvelopes: (ledgerFinal.consumed || {}).modelCallEnvelopes }),
    "consumed == 真实模型请求数");
  const heroToolExecs = byTask(heroSnapFinal.executions, heroRun.taskId);
  const heroSideEffects = byTask(heroSnapFinal.sideEffectCalls, heroRun.taskId);
  const planLen = { write: 2, budget: 14, final: 0 };
  const observedToolCalls = heroHistory.filter((h) => planLen[h.mode] != null && h.n < planLen[h.mode]).length;
  record("flow4", "F4.49 · 工具调用交叉核对：TOOL_CALLS consumed == DB tool_executions + side_effect_calls == provider 观测发出的 tool_call 数",
    budgetFinal.TOOL_CALLS.consumed === heroToolExecs.length + heroSideEffects.length && budgetFinal.TOOL_CALLS.consumed === observedToolCalls,
    JSON.stringify({ ledgerToolConsumed: budgetFinal.TOOL_CALLS.consumed, dbToolExecutions: heroToolExecs.length, dbSideEffectCalls: heroSideEffects.length, providerToolCalls: observedToolCalls, providerRequests: modelRequests }),
    "consumed == executions + sideEffectCalls == provider tool_calls");
  const artBound = heroArtsFinal.every((a) => a.task_id === heroRun.taskId && !!a.step_id && !!a.run_id && heroStepsFinal.some((s) => s.step_id === a.step_id) && heroRunsFinal.some((r) => r.run_id === a.run_id && r.step_id === a.step_id));
  const verBound = heroVersFinal.every((v) => v.task_id === heroRun.taskId && heroArtsFinal.some((a) => a.artifact_id === v.artifact_id));
  const checksumOk = heroArtsFinal.every((a) => a.checksum === sha256(a.safe_content));
  record("flow4", "F4.50 · 关联链：2 artifact 各自绑定 (taskId, stepId, runId)、2 verification 绑定对应 artifactId（verification 行不承载 step/run）、checksum==sha256(content)、harness runs==3",
    heroArtsFinal.length === 2 && heroVersFinal.length === 2 && heroRunsFinal.length === 3 && artBound && verBound && checksumOk,
    JSON.stringify({ artifacts: heroArtsFinal.length, verifications: heroVersFinal.length, runs: heroRunsFinal.length, artBound, verBound, checksumOk, artifactRefs: heroArtsFinal.map((a) => ({ step: !!a.step_id, run: !!a.run_id })), verificationArtifacts: heroVersFinal.map((v) => !!heroArtsFinal.some((a) => a.artifact_id === v.artifact_id)) }), "2+2+3 绑定 + checksum 正确");
  const heroResFinal = resourceOf(heroSnapFinal, heroTarget.id);
  record("flow4", "F4.51 · 第一步副作用恰好一次：跨 step/跨 run 不重放（side_effect_calls==1、无第二次 trash execution、资源只 trash 一次、executor 不新增）",
    heroSideEffects.length === 1 && heroSideEffects[0].status === "SUCCEEDED" && heroToolExecs.filter((e) => e.tool_id === "resource.trash").length === 0
      && !!heroResFinal && heroResFinal.status === "deleted" && trashStateOf(heroSnapFinal, heroTarget.id) === "TRASHED" && heroResFinal.updated_at === heroRes1.updated_at && executorRecordCount() === heroExecBefore,
    JSON.stringify({ sideEffectCalls: heroSideEffects.length, callStatuses: heroSideEffects.map((c) => c.status), trashExecutions: heroToolExecs.filter((e) => e.tool_id === "resource.trash").length, resource: heroResFinal && heroResFinal.status, trashState: trashStateOf(heroSnapFinal, heroTarget.id), trashedAt: heroRes1.updated_at + "==" + (heroResFinal && heroResFinal.updated_at), exec: heroExecBefore + "->" + executorRecordCount() }),
    "1 SUCCEEDED + 0 重放 + 资源只 trash 一次");
  const heroAppendableAfter = await taskGet(heroRun.taskId);
  record("flow4", "F4.52 · 14(f) 收尾正对照：主任务最终态 appendable=true（成功态追加入口仍真实可用）", heroAppendableAfter.appendable === true, String(heroAppendableAfter.appendable), "true");
  observe("flow4-append-budget-resume", JSON.stringify({ taskId: heroRun.taskId, taskStatus: heroGetFinal.task.status, steps: heroStepsFinal.map((s) => s.status), artifacts: heroArtsFinal.length, verifications: heroVersFinal.length, runs: heroRunsFinal.length, budget: { before: budgetBeforeAppend, stop: budgetStopSnapshot, final: budgetFinal, nextGrant, additions: additions.length }, calls: { providerModelRequests: modelRequests, providerToolCalls: observedToolCalls, toolExecutions: heroToolExecs.length, sideEffectCalls: heroSideEffects.length } }));
  flowReached.flow4 = true;
  R.flow4 = {
    budgetBefore: budgetBeforeAppend, budgetStop: budgetStopSnapshot, budgetFinal, nextGrant,
    modelRequests, providerToolCalls: observedToolCalls, ledgerFinal, additions: additions.length,
    resumeCount: ledgerFinal.resumeCount, steps: heroStepsFinal.map((s) => s.status), artifacts: heroArtsFinal.length, verifications: heroVersFinal.length, runs: heroRunsFinal.length,
    artifactChecksums: heroArtsFinal.map((a) => a.checksum), artifactRefs: heroArtsFinal.map((a) => ({ artifactId: a.artifact_id, stepId: a.step_id, runId: a.run_id, type: a.type })),
  };

  // ================================================================ 流程 5：刷新一致性（Reload 后从后端一致恢复）
  const grantBeforeReload = await getToolAccess();
  const flow1GetBefore = await taskGet(R.taskIds.flow1);
  const flow3GetBefore = await taskGet(R.taskIds.flow3);
  const budgetGetBefore = await taskGet(R.taskIds.flow4);
  const beforeSnapshot = {
    grants: (grantBeforeReload && grantBeforeReload.grantedActions) || [],
    flow1: { status: flow1GetBefore && flow1GetBefore.task && flow1GetBefore.task.status, artifacts: (flow1GetBefore && flow1GetBefore.artifacts || []).length, verifications: (flow1GetBefore && flow1GetBefore.verifications || []).length },
    flow3: { status: flow3GetBefore && flow3GetBefore.task && flow3GetBefore.task.status, denied: (flow3GetBefore && flow3GetBefore.deniedOperations || []).length },
    flow4: { resumable: !!(budgetGetBefore && budgetGetBefore.resumable), kind: budgetGetBefore && budgetGetBefore.budgetLedger && budgetGetBefore.budgetLedger.kinds ? Object.keys(budgetGetBefore.budgetLedger.kinds).sort().join(",") : null },
  };
  await page.reload();
  await sleep(1200);
  let gateAfterReload = await gate();
  if (gateAfterReload !== "ready") {
    if (await waitSel('[data-d3-id="login-identifier"]', 15000)) {
      await setInput('[data-d3-id="login-identifier"]', ADMIN);
      await setInput('[data-d3-id="login-password"]', PW);
      await sleep(100);
      await click('[data-d3-id="login-submit"]');
    }
    await waitGate("ready", 30000);
    gateAfterReload = await gate();
  }
  record("flow5", "F5.1 · 刷新后产品身份 / 桌面状态正确恢复（gate=ready）", gateAfterReload === "ready", gateAfterReload, "ready");
  const grantAfterReload = await getToolAccess();
  record("flow5", "F5.2 · 刷新后 TOOL 权限从后端一致恢复", !!(grantAfterReload && grantAfterReload.ok) && JSON.stringify((grantAfterReload.grantedActions || []).slice().sort()) === JSON.stringify(beforeSnapshot.grants.slice().sort()), JSON.stringify({ before: beforeSnapshot.grants, after: grantAfterReload && grantAfterReload.grantedActions }), "unchanged");
  const flow1GetAfter = await taskGet(R.taskIds.flow1);
  record("flow5", "F5.3 · 刷新后 flow1 任务/产物/验证从 task/get 权威恢复", flow1GetAfter && flow1GetAfter.task && flow1GetAfter.task.status === "SUCCEEDED" && (flow1GetAfter.artifacts || []).length === 1 && (flow1GetAfter.verifications || []).length === 1, JSON.stringify({ status: flow1GetAfter && flow1GetAfter.task && flow1GetAfter.task.status, artifacts: (flow1GetAfter && flow1GetAfter.artifacts || []).length, verifications: (flow1GetAfter && flow1GetAfter.verifications || []).length }), "SUCCEEDED + 1 artifact + 1 verification");
  const flow3GetAfter = await taskGet(R.taskIds.flow3);
  const flow3DeniedAfter = flow3GetAfter && Array.isArray(flow3GetAfter.deniedOperations) ? flow3GetAfter.deniedOperations : [];
  record("flow5", "F5.4 · 刷新后 flow3 BLOCKED + deniedOperations 一致", flow3GetAfter && flow3GetAfter.task && flow3GetAfter.task.status === "BLOCKED" && flow3DeniedAfter.some((o) => o.toolId === "resource.trash" && o.reasonCode === "TOOL_APP_NOT_GRANTED"), JSON.stringify({ status: flow3GetAfter && flow3GetAfter.task && flow3GetAfter.task.status, denied: flow3DeniedAfter.map((o) => o.reasonCode) }), "BLOCKED + denied");
  const budgetGetAfter = await taskGet(R.taskIds.flow4);
  const ledgerAfter = budgetGetAfter && budgetGetAfter.budgetLedger;
  const kindsAfter = ledgerAfter && ledgerAfter.kinds ? Object.keys(ledgerAfter.kinds).sort().join(",") : null;
  record("flow5", "F5.5 · 刷新后预算账本从后端一致恢复（非 renderer 自报）", kindsAfter === beforeSnapshot.flow4.kind && !!(budgetGetAfter && !budgetGetAfter.resumable), JSON.stringify({ before: beforeSnapshot.flow4.kind, after: kindsAfter, resumable: budgetGetAfter && budgetGetAfter.resumable }), "unchanged");
  // ---- 流程 4 主任务 / 撤权任务刷新前快照（流程 5 的对照基准，全部来自后端 task/get） ----
  const heroGetBeforeReload = await taskGet(R.taskIds.flow4);
  const revGetBeforeReload = await taskGet(R.taskIds.flow4Revoke);
  const heroLedgerBeforeReload = { kinds: kindSnapshot(heroGetBeforeReload.budgetLedger), additions: (heroGetBeforeReload.budgetLedger.additions || []).length, resumeCount: heroGetBeforeReload.budgetLedger.resumeCount };
  const panelOpened = await openPanel();
  const panelRestored = await waitFor(async () => (await attr(".ai-panel", "data-ai-task-id")) === R.taskIds.flow4, 30000);
  const panelTaskId = await attr(".ai-panel", "data-ai-task-id");
  record("flow5", "F5.6 · 刷新后 AI 面板恢复到最新任务（= 流程 4 主任务）", panelOpened && panelRestored, JSON.stringify({ opened: panelOpened, panelTaskId, expected: R.taskIds.flow4 }), "panel 指向流程 4 主任务");
  const uiSteps = await js("return Array.from(document.querySelectorAll('[data-ai-steps] [data-ai-step]')).map((el) => ({ seq: el.getAttribute('data-ai-step'), status: el.getAttribute('data-ai-step-status'), appended: el.getAttribute('data-ai-step-appended'), text: (el.textContent || '') }))");
  const uiSeq = uiSteps.map((s) => s.seq).join(",");
  const uiStatus = uiSteps.map((s) => s.status).join(",");
  record("flow5", "F5.7 · 刷新后 [data-ai-steps] 3 条：sequence 1,2,3 / status SUCCEEDED,BLOCKED,SUCCEEDED / 第 2 条 data-ai-step-appended=true 且文本含追加目标",
    uiSteps.length === 3 && uiSeq === "1,2,3" && uiStatus === "SUCCEEDED,BLOCKED,SUCCEEDED" && uiSteps[1].appended === "true" && uiSteps[1].text.includes(F4_APPEND_GOAL) && uiSteps[0].appended == null && uiSteps[2].appended == null,
    JSON.stringify({ steps: uiSteps.map((s) => ({ seq: s.seq, status: s.status, appended: s.appended })), step2Text: (uiSteps[1] || {}).text }),
    "1,2,3 / SUCCEEDED,BLOCKED,SUCCEEDED / step2 appended=true + 追加目标");
  const appendBlockAfterReload = await has("[data-ai-append-block]");
  const resumeAfterReload = await has("[data-ai-resume]");
  record("flow5", "F5.8 · 刷新后 [data-ai-append-block] 可见（appendable=true）且 [data-ai-resume] 不出现（resumable=false）",
    appendBlockAfterReload && !resumeAfterReload && heroGetBeforeReload.appendable === true && heroGetBeforeReload.resumable === false,
    JSON.stringify({ appendBlock: appendBlockAfterReload, resume: resumeAfterReload, appendable: heroGetBeforeReload.appendable, resumable: heroGetBeforeReload.resumable }), "append 可见 + resume 不可见");
  const heroGetAfterReload = await taskGet(R.taskIds.flow4);
  const heroLedgerAfterReload = { kinds: kindSnapshot(heroGetAfterReload.budgetLedger), additions: (heroGetAfterReload.budgetLedger.additions || []).length, resumeCount: heroGetAfterReload.budgetLedger.resumeCount };
  record("flow5", "F5.9 · 刷新后主任务 task/get 权威一致：3 steps / 2 artifacts / 2 verifications / 账本 authorized+consumed+remaining+additions+resumeCount 与刷新前快照逐项相等",
    heroGetAfterReload.task.status === "SUCCEEDED" && (heroGetAfterReload.steps || []).length === 3 && (heroGetAfterReload.artifacts || []).length === 2 && (heroGetAfterReload.verifications || []).length === 2
      && JSON.stringify(heroLedgerAfterReload) === JSON.stringify(heroLedgerBeforeReload),
    JSON.stringify({ status: heroGetAfterReload.task.status, steps: (heroGetAfterReload.steps || []).length, artifacts: (heroGetAfterReload.artifacts || []).length, verifications: (heroGetAfterReload.verifications || []).length, ledgerBefore: heroLedgerBeforeReload, ledgerAfter: heroLedgerAfterReload }),
    "3/2/2 + 账本快照相等（非 renderer 自报）");
  const revGetAfterReload = await taskGet(R.taskIds.flow4Revoke);
  record("flow5", "F5.10 · 刷新后撤权任务（14(e)）BLOCKED / 2 steps / 1 artifact / appendReason=APPEND_NOT_SUCCEEDED（与刷新前一致）",
    revGetAfterReload.task.status === "BLOCKED" && (revGetAfterReload.steps || []).length === 2 && (revGetAfterReload.artifacts || []).length === 1 && revGetAfterReload.appendReason === "APPEND_NOT_SUCCEEDED"
      && revGetAfterReload.appendReason === revGetBeforeReload.appendReason && (revGetAfterReload.steps || []).length === (revGetBeforeReload.steps || []).length && (revGetAfterReload.artifacts || []).length === (revGetBeforeReload.artifacts || []).length,
    JSON.stringify({ status: revGetAfterReload.task.status, steps: (revGetAfterReload.steps || []).length, artifacts: (revGetAfterReload.artifacts || []).length, appendReason: revGetAfterReload.appendReason }),
    "BLOCKED + 2/1 + APPEND_NOT_SUCCEEDED");

  flowReached.flow5 = true;

  // 14(d) 前置：在 admin 会话里取流程 4 主任务的真实 revision 与 step 数（MEMBER 会话读不到 task/get）
  const heroRevForMember = (await taskGet(R.taskIds.flow4)).task.revision;
  const heroStepsForMemberBefore = byTask(dbSnapshot().steps, R.taskIds.flow4).length;
  // ---------------------------------------------------------------- 流程 2（续）：真实 MEMBER 会话调用治理 grant 被拒
  const createdMember = await gov({ type: "governance/createUser", identifier: MEMBER, password: MEMBER_PW, displayName: "Main E2E Member", role: "MEMBER" });
  record("flow2", "F2.8 · 经产品治理入口创建 MEMBER 账号", !!(createdMember && createdMember.ok), createdMember && createdMember.ok ? "created" : JSON.stringify(createdMember), "created");
  const loggedOut = await logout();
  const memberReady = await loginAs(MEMBER, MEMBER_PW);
  const grantAsMember = await gov({ type: "governance/grantAppToolAccess", appId: "ai", actions: [TOOL_TRASH] });
  record("flow2", "F2.9 · 真实 MEMBER 会话调用治理 grant 被拒", loggedOut && memberReady && grantAsMember && grantAsMember.ok === false && grantAsMember.error === "NOT_SUPER_ADMIN", JSON.stringify({ loggedOut, memberReady, res: grantAsMember }), "ok=false + NOT_SUPER_ADMIN");
  // 14(d) 非 owner：真实 MEMBER 会话对 admin 的流程 4 主任务发起 appendStep（携带真实 revision）→ TASK_FORBIDDEN
  const memberAppend = await appendViaBridge(R.taskIds.flow4, "MEMBER 对 admin 任务的追加", heroRevForMember);
  const heroStepsForMemberAfter = byTask(dbSnapshot().steps, R.taskIds.flow4).length;
  record("flow4", "F4.53 · 14(d) 真实 MEMBER 会话对 admin 任务的 appendStep 被拒：TASK_FORBIDDEN，0 新 step（14(f) 对照：同一任务在 admin 会话 appendable=true 且已被接受，见 F4.31/F4.52）",
    memberAppend.ok === false && memberAppend.error === "TASK_FORBIDDEN" && heroStepsForMemberBefore === 3 && heroStepsForMemberAfter === 3,
    JSON.stringify({ memberSession: memberReady, res: memberAppend, steps: heroStepsForMemberBefore + "->" + heroStepsForMemberAfter, adminControl: checks.find((c) => c.name.startsWith("F4.52"))?.ok === true }),
    "TASK_FORBIDDEN + steps=3 不变");

  // ---------------------------------------------------------------- 只读 DB / 错误
  const snap = dbSnapshot();
  const dbDump = JSON.stringify(snap);
  const secretHits = [PROVIDER_SECRET, userData, "mpx_", "tpx_"].filter((s) => s && dbDump.includes(s));
  record("setup", "I1 · 隔离 identity.db 只读快照 0 provider secret / 私有路径泄漏", secretHits.length === 0, JSON.stringify(secretHits), "[]");
  const firstTask = snap.tasks.slice().sort((a, b) => a.created_at - b.created_at)[0];
  const bootMtime = fs.existsSync(BOOT_PATH) ? fs.statSync(BOOT_PATH).mtimeMs : null;
  record("boot", "I2 · boot 观测写入早于首个任务接入", !!bootMtime && !!firstTask && bootMtime <= firstTask.created_at, JSON.stringify({ bootMtime, firstTask: firstTask && firstTask.created_at }), "boot <= task");
  const allStatuses = snap.tasks.map((t) => t.status);
  record("setup", "I3 · 所有 task 收敛终态（无 RUNNING / PENDING）", allStatuses.every((s) => ["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"].includes(s)), JSON.stringify(allStatuses), "all terminal");
  const unhandled = stderrBuf.split("\n").filter((l) => /Uncaught|UnhandledPromiseRejection|uncaughtException|unhandledRejection/i.test(l));
  mainErrors.push(...unhandled.slice(0, 5));
  record("setup", "I4 · Renderer console error = 0", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "), "0");
  record("setup", "I5 · main uncaught / unhandled = 0", mainErrors.length === 0, mainErrors.slice(0, 3).join(" | "), "0");

  // ================================================================ 流程 6：模型配置绑定（真实产品入口）
  //
  // 位置说明：流程 5 的既有断言包含"刷新后 AI 面板恢复的最新任务 = 流程 4 主任务"（F5.6）与
  // gate.flows.flow5.latestTaskIsFlow4；流程 6 必然新建任务，因此它放在既有只读快照（I1-I5）之后独立运行，
  // 不改任何既有断言，并由 flow6 自己的断言保证任务收敛终态、错误可见与归属不变。
  const GOAL6_A = "MAIN-E2E FLOW6-A: 输出绑定后的结论";
  const GOAL6_B = "MAIN-E2E FLOW6-B: 新版本绑定后的结论";
  const GOAL6_C = "MAIN-E2E FLOW6-C: 先出产物再耗尽预算";
  const GOAL6_APPEND_A = "MAIN-E2E FLOW6-A 改版后的追加（必须被明确拒绝）";
  const GOAL6_APPEND_B = "MAIN-E2E FLOW6-B 默认切换后的追加";
  const GOAL6_APPEND_C = "MAIN-E2E FLOW6-C 第二步：连续读取直至预算到限";
  const productModel = (command) => bridge("model", command);
  const modelRow = (s, id) => (s.tasks || []).find((t) => t.task_id === id) || null;
  const calls6Of = (s, id) => byTask(s.modelCalls, id);
  const terminal6 = (s, id) => {
    const row = modelRow(s, id);
    return !!row && ["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"].includes(row.status);
  };

  // 流程 5 结束时会话是 MEMBER（F2.9）：流程 6 必须回到真实 admin 会话。
  const logout6 = await logout();
  const adminBack6 = await loginAs(ADMIN, PW);
  record("flow6", "F6.0 · 前置：真实 UI 退出 MEMBER 会话并重新登录 admin（identity gate=ready）", logout6 && adminBack6, JSON.stringify({ logout: logout6, admin: adminBack6 }), "gate=ready");

  const defaults6 = await productModel({ type: "defaults/get" });
  const configs6 = await productModel({ type: "model/list" });
  const defaultChat6 = defaults6 && defaults6.ok && defaults6.personal ? defaults6.personal.chat : null;
  const defaultConfig6 = configs6 && configs6.ok && Array.isArray(configs6.items) ? configs6.items.find((m) => m.configId === defaultChat6) || null : null;
  const frozen6 = defaultConfig6 ? defaultConfig6.version : null;
  record("flow6", "F6.1 · 经产品桥读到 Settings 默认 chat model（configId/version，默认即 setup 经真实 UI 注册的模型）",
    !!defaultConfig6 && defaultChat6 === cid && Number.isFinite(frozen6) && frozen6 >= 1,
    JSON.stringify({ defaultChat: defaultChat6, version: frozen6, setupModel: cid }), "默认 == setup 模型");

  /* ---------------- (h) 真实 UI 新建任务：后端解析并冻结当前默认配置 ---------------- */
  await setPlan("final");
  const run6A = await runTask(GOAL6_A);
  R.taskIds.flow6 = run6A.taskId;
  const term6A = await waitTaskTerminal(run6A.taskId, 180000);
  const get6A = await taskGet(run6A.taskId);
  const snap6A = dbSnapshot();
  const row6A = modelRow(snap6A, run6A.taskId);
  const runs6A = runsOfTask(snap6A, run6A.taskId);
  const call6A = calls6Of(snap6A, run6A.taskId)[0];
  const arts6A = artsOfTask(snap6A, run6A.taskId);
  const vers6A = versOfTask(snap6A, run6A.taskId);
  record("flow6", "F6.2 (h) · 真实 UI task/run 建的任务冻结了后端解析出的默认模型：task 行 / run 行 / call 行 modelConfigId+version 非空且与 Settings 默认逐项一致",
    run6A.started && term6A && get6A.task.status === "SUCCEEDED" && arts6A.length === 1 && vers6A.length === 1
      && !!get6A.task.modelConfigId && get6A.task.modelConfigId === defaultChat6 && get6A.task.modelConfigVersion === frozen6
      && !!row6A && row6A.model_config_id === defaultChat6 && Number(row6A.model_config_version) === frozen6
      && runs6A.length === 1 && runs6A[0].model_config_id === defaultChat6 && Number(runs6A[0].model_config_version) === frozen6
      && !!call6A && call6A.model_config_id === defaultChat6 && Number(call6A.model_config_version) === frozen6,
    JSON.stringify({ task: get6A.task.status, artifacts: arts6A.length, taskBinding: { id: get6A.task.modelConfigId, v: get6A.task.modelConfigVersion }, expected: { id: defaultChat6, v: frozen6 }, runBinding: runs6A[0] && { id: runs6A[0].model_config_id, v: runs6A[0].model_config_version }, callBinding: call6A && { id: call6A.model_config_id, v: call6A.model_config_version } }),
    "SUCCEEDED + task/run/call 三行绑定 == Settings 默认");

  /* ---------------- (i) 经产品入口把该任务绑定的 config 提升版本 → 追加步骤必须明确 MODEL_CONFIG_CHANGED ---------------- */
  const bump6 = await productModel({ type: "model/update", configId: defaultChat6, displayName: "Main E2E Local (v2)" });
  const bumped6 = bump6 && bump6.ok && bump6.model ? bump6.model.version : null;
  record("flow6", "F6.3 (i) · 经真实产品入口 model/update 提升该任务绑定的 config 版本（真实 version bump，非 test-only 直改 DB）",
    !!bump6 && bump6.ok === true && bumped6 === frozen6 + 1,
    JSON.stringify({ entry: "window.openarc.model.command model/update", ok: bump6 && bump6.ok, version: bumped6, before: frozen6 }), "version = before + 1");

  const snap6A1 = dbSnapshot();
  const reqBefore6 = provider.state.requests;
  const stepBefore6 = stepsOfTask(snap6A1, run6A.taskId);
  const artBefore6 = artsOfTask(snap6A1, run6A.taskId);
  const verBefore6 = versOfTask(snap6A1, run6A.taskId);
  const callBefore6 = calls6Of(snap6A1, run6A.taskId);
  const appendBlock6 = await waitSel("[data-ai-append-block]", 30000);
  await setInput("[data-ai-append-goal]", GOAL6_APPEND_A);
  const appendReady6 = await waitFor(async () => !(await isDisabled("[data-ai-append]")), 15000);
  const appendClick6 = await click("[data-ai-append]");
  const appendTerm6 = await waitTaskTerminal(run6A.taskId, 180000);
  const get6A2 = await taskGet(run6A.taskId);
  const snap6A2 = dbSnapshot();
  const steps6A2 = stepsOfTask(snap6A2, run6A.taskId);
  const runs6A2 = runsOfTask(snap6A2, run6A.taskId);
  const appendRun6 = steps6A2.length > 1 ? runs6A2.filter((r) => r.step_id === steps6A2[1].step_id) : [];
  record("flow6", "F6.4 (i) · 改版后经真实 UI 追加步骤：Task/Step/新 run 全部收敛 BLOCKED，run.error_code=MODEL_CONFIG_CHANGED（绝不留 RUNNING 悬挂、绝不静默换模型）",
    appendBlock6 && appendReady6 === true && appendClick6 === "ok" && appendTerm6 && get6A2.task.status === "BLOCKED"
      && steps6A2.length === 2 && steps6A2[1].status === "BLOCKED"
      && appendRun6.length === 1 && appendRun6[0].status === "BLOCKED" && appendRun6[0].error_code === "MODEL_CONFIG_CHANGED"
      && Number(appendRun6[0].model_config_version) === frozen6,
    JSON.stringify({ appendBlockVisible: appendBlock6, ready: appendReady6, click: appendClick6, task: get6A2.task.status, steps: steps6A2.map((s) => s.status), run: appendRun6[0] && { status: appendRun6[0].status, error: appendRun6[0].error_code, version: appendRun6[0].model_config_version } }),
    "BLOCKED/BLOCKED + run MODEL_CONFIG_CHANGED");
  record("flow6", "F6.5 (i) · 该拒绝 0 执行：0 新 model call / 0 新 Artifact / 0 新 provider 请求；旧 step/artifact/verification/call 行逐字段不变",
    calls6Of(snap6A2, run6A.taskId).length === callBefore6.length
      && artsOfTask(snap6A2, run6A.taskId).length === artBefore6.length
      && versOfTask(snap6A2, run6A.taskId).length === verBefore6.length
      && provider.state.requests === reqBefore6
      && JSON.stringify([steps6A2[0]]) === JSON.stringify(stepBefore6)
      && JSON.stringify(artsOfTask(snap6A2, run6A.taskId)) === JSON.stringify(artBefore6)
      && JSON.stringify(versOfTask(snap6A2, run6A.taskId)) === JSON.stringify(verBefore6)
      && JSON.stringify(calls6Of(snap6A2, run6A.taskId)) === JSON.stringify(callBefore6),
    JSON.stringify({ calls: callBefore6.length + "->" + calls6Of(snap6A2, run6A.taskId).length, artifacts: artBefore6.length + "->" + artsOfTask(snap6A2, run6A.taskId).length, providerRequests: reqBefore6 + "->" + provider.state.requests, rowsUnchanged: JSON.stringify([steps6A2[0]]) === JSON.stringify(stepBefore6) && JSON.stringify(artsOfTask(snap6A2, run6A.taskId)) === JSON.stringify(artBefore6) }),
    "0 call + 0 artifact + 0 provider 请求 + 旧行不变");
  const errVisible6 = await waitFor(async () => { const e = (await text("[data-ai-error]")) || ""; const stText = (await text("[data-ai-status-text]")) || ""; return e.includes("MODEL_CONFIG_CHANGED") || stText.includes("BLOCKED"); }, 30000);
  const errText6 = (await text("[data-ai-error]")).trim().slice(0, 120);
  const panelStatus6 = await attr(".ai-panel", "data-ai-status");
  const statusText6 = (await text("[data-ai-status-text]")).trim();
  record("flow6", "F6.6 (i) · 真实 UI 如实呈现该错误：状态 BLOCKED 且 [data-ai-error] 含 MODEL_CONFIG_CHANGED（不假成功、不静默换模型）",
    errVisible6 && errText6.includes("MODEL_CONFIG_CHANGED") && panelStatus6 === "BLOCKED" && statusText6.includes("BLOCKED") && get6A2.task.status === "BLOCKED",
    JSON.stringify({ error: errText6, panelStatus: panelStatus6, statusText: statusText6, task: get6A2.task.status }), "BLOCKED + data-ai-error 含 MODEL_CONFIG_CHANGED");

  /* ---------------- (j) 同一时刻新建任务：绑定当前配置版本并正常成功 ---------------- */
  const run6B = await runTask(GOAL6_B);
  R.taskIds.flow6B = run6B.taskId;
  const term6B = await waitTaskTerminal(run6B.taskId, 180000);
  const get6B = await taskGet(run6B.taskId);
  const snap6B = dbSnapshot();
  const row6B = modelRow(snap6B, run6B.taskId);
  const runs6B = runsOfTask(snap6B, run6B.taskId);
  record("flow6", "F6.7 (j) · 改版后经真实 UI 新建任务：绑定**当前**版本并正常 SUCCEEDED（版本变化只拦绑定旧版本的任务）",
    term6B && get6B.task.status === "SUCCEEDED" && get6B.task.modelConfigId === defaultChat6 && get6B.task.modelConfigVersion === bumped6
      && !!row6B && Number(row6B.model_config_version) === bumped6
      && runs6B.length === 1 && Number(runs6B[0].model_config_version) === bumped6,
    JSON.stringify({ task: get6B.task.status, binding: { id: get6B.task.modelConfigId, v: get6B.task.modelConfigVersion }, expected: { id: defaultChat6, v: bumped6 } }), "SUCCEEDED + 绑定当前版本");

  /* ---------------- (k-2) 前置：绑定原 config 的任务先造出真实预算停止（此时默认尚未切换） ---------------- */
  const run6C = await runTask(GOAL6_C);
  R.taskIds.flow6C = run6C.taskId;
  const term6C = await waitTaskTerminal(run6C.taskId, 180000);
  const get6C = await taskGet(run6C.taskId);
  const budgetStep6 = stepsOfTask(dbSnapshot(), run6C.taskId).length;
  await setPlan("budget");
  await setInput("[data-ai-append-goal]", GOAL6_APPEND_C);
  const appendCReady6 = await waitFor(async () => !(await isDisabled("[data-ai-append]")), 15000);
  const appendCClick6 = appendCReady6 ? await click("[data-ai-append]") : "not-ready";
  const budgetStop6 = await waitTaskTerminal(run6C.taskId, 300000);
  const get6CStop = await taskGet(run6C.taskId);
  const resumeVisible6 = await waitSel("[data-ai-resume]", 30000);
  const stopReason6 = (await text("[data-ai-stop-reason]")).trim();
  const cRowStop6 = modelRow(dbSnapshot(), run6C.taskId);
  record("flow6", "F6.8 (k) · 默认切换前：绑定原 config 的任务造出真实预算停止（第二步 BUDGET_EXHAUSTED + [data-ai-resume] 可见），任务归属仍是原 config",
    appendCReady6 === true && appendCClick6 === "ok" && budgetStop6 && term6C && get6C.task.status === "SUCCEEDED"
      && get6CStop.task.status === "BLOCKED" && get6CStop.stopReason === "BUDGET_EXHAUSTED" && get6CStop.resumable === true
      && cRowStop6 && cRowStop6.model_config_id === defaultChat6 && Number(cRowStop6.model_config_version) === bumped6
      && resumeVisible6 && budgetStep6 === 1,
    JSON.stringify({ first: get6C.task.status, stop: get6CStop.task.status, stopReason: get6CStop.stopReason, uiStopReason: stopReason6, resumable: get6CStop.resumable, resumeVisible: resumeVisible6, stepsBeforeBudget: budgetStep6, binding: cRowStop6 && { id: cRowStop6.model_config_id, v: cRowStop6.model_config_version } }), "BLOCKED + BUDGET_EXHAUSTED + resumable + 原 config");

  /* ---------------- (k) 默认切到另一个 config（原 config 未变） ---------------- */
  const newCfg6 = await productModel({ type: "model/create", providerId: pid, remoteModelId: "main-e2e-local-2", displayName: "Main E2E Local 2", capabilities: ["chat"], scope: "ORGANIZATION" });
  const cid6b = newCfg6 && newCfg6.ok && newCfg6.model ? newCfg6.model.configId : null;
  const setDef6 = cid6b ? await productModel({ type: "defaults/set", capability: "chat", configId: cid6b, scope: "PERSONAL" }) : null;
  const setDefOrg6 = cid6b ? await productModel({ type: "defaults/set", capability: "chat", configId: cid6b, scope: "ORGANIZATION" }) : null;
  const defaultsAfter6 = await productModel({ type: "defaults/get" });
  const configsAfter6 = await productModel({ type: "model/list" });
  const origConfigAfter6 = configsAfter6 && configsAfter6.ok ? configsAfter6.items.find((m) => m.configId === defaultChat6) : null;
  record("flow6", "F6.9 (k) · 经真实产品入口新建第二个 config 并把默认切到它（原 config 自身版本未变）",
    !!cid6b && cid6b !== defaultChat6 && !!setDef6 && setDef6.ok === true && !!setDefOrg6 && setDefOrg6.ok === true
      && defaultsAfter6 && defaultsAfter6.ok && defaultsAfter6.personal && defaultsAfter6.personal.chat === cid6b
      && !!origConfigAfter6 && Number(origConfigAfter6.version) === Number(bumped6),
    JSON.stringify({ newConfig: cid6b, personalDefault: defaultsAfter6 && defaultsAfter6.personal && defaultsAfter6.personal.chat, originalConfig: defaultChat6, originalVersion: origConfigAfter6 && origConfigAfter6.version, expectedOriginalVersion: bumped6 }),
    "默认 = 新 config 且原 config version 不变");

  // (k-1) 绑定原 config 的任务 append：仍成功，且任务 / run / call 行归属仍是原 config
  // 这里用产品桥（与 AI 面板 [data-ai-append] 同一条 IPC 命令 task/appendStep）；面板此刻停在任务 C 上，
  // 以便 (k-2) 用真实 UI [data-ai-resume] 续接。
  await setPlan("final");
  const rev6B = (await taskGet(run6B.taskId)).task.revision;
  const appendB6 = await appendViaBridge(run6B.taskId, GOAL6_APPEND_B, rev6B);
  const appendBClicked6 = appendB6 && appendB6.ok === true ? "ok" : "rejected";
  const term6B2 = await waitTaskTerminal(run6B.taskId, 180000);
  const get6B2 = await taskGet(run6B.taskId);
  const snap6B2 = dbSnapshot();
  const row6B2 = modelRow(snap6B2, run6B.taskId);
  const runs6B2 = runsOfTask(snap6B2, run6B.taskId);
  const calls6B2 = calls6Of(snap6B2, run6B.taskId);
  record("flow6", "F6.10 (k) · 默认已指向新 config，绑定原 config 的任务追加仍正常 SUCCEEDED，且 task/run/call 行归属仍是原 config（不静默切换）",
    appendBClicked6 === "ok" && term6B2 && get6B2.task.status === "SUCCEEDED"
      && stepsOfTask(snap6B2, run6B.taskId).length === 2 && stepsOfTask(snap6B2, run6B.taskId)[1].status === "SUCCEEDED"
      && artsOfTask(snap6B2, run6B.taskId).length === 2
      && !!row6B2 && row6B2.model_config_id === defaultChat6 && Number(row6B2.model_config_version) === bumped6
      && runs6B2.length === 2 && runs6B2.every((r) => r.model_config_id === defaultChat6 && Number(r.model_config_version) === bumped6)
      && calls6B2.length === 2 && calls6B2.every((c) => c.model_config_id === defaultChat6 && Number(c.model_config_version) === bumped6),
    JSON.stringify({ syncAccept: appendB6 && { ok: appendB6.ok, status: appendB6.status }, task: get6B2.task.status, steps: stepsOfTask(snap6B2, run6B.taskId).map((s) => s.status), artifacts: artsOfTask(snap6B2, run6B.taskId).length, taskBinding: row6B2 && { id: row6B2.model_config_id, v: row6B2.model_config_version }, runBindings: runs6B2.map((r) => r.model_config_id + ":" + r.model_config_version), callBindings: calls6B2.map((c) => c.model_config_id + ":" + c.model_config_version), newDefault: defaultsAfter6 && defaultsAfter6.personal && defaultsAfter6.personal.chat }),
    "SUCCEEDED + 全部归属原 config");

  // (k-2) 绑定原 config 的任务 resume：默认已切到新 config，显式续接仍必须成功
  await setPlan("final");
  const resumeReady6 = await waitFor(async () => !(await isDisabled("[data-ai-resume]")), 15000);
  const resumeClick6 = await click("[data-ai-resume]");
  const term6C2 = await waitTaskTerminal(run6C.taskId, 180000);
  const get6C2 = await taskGet(run6C.taskId);
  const snap6C2 = dbSnapshot();
  const row6C2 = modelRow(snap6C2, run6C.taskId);
  const runs6C2 = runsOfTask(snap6C2, run6C.taskId);
  const calls6C2 = calls6Of(snap6C2, run6C.taskId);
  record("flow6", "F6.11 (k) · 默认已指向新 config，绑定原 config 的任务显式续接仍成功，且归属仍是原 config（不静默切换）",
    resumeReady6 && resumeClick6 === "ok" && term6C2 && get6C2.task.status === "SUCCEEDED"
      && !!row6C2 && row6C2.model_config_id === defaultChat6 && Number(row6C2.model_config_version) === bumped6
      && runs6C2.length >= 3 && runs6C2.every((r) => r.model_config_id === defaultChat6 && Number(r.model_config_version) === bumped6)
      && calls6C2.every((c) => c.model_config_id === defaultChat6 && Number(c.model_config_version) === bumped6),
    JSON.stringify({ task: get6C2.task.status, runs: runs6C2.length, runBindings: runs6C2.map((r) => r.model_config_id + ":" + r.model_config_version), callBindings: calls6C2.map((c) => c.model_config_id + ":" + c.model_config_version), taskBinding: row6C2 && { id: row6C2.model_config_id, v: row6C2.model_config_version } }),
    "SUCCEEDED + 全部归属原 config");

  const snap6Final = dbSnapshot();
  const flow6Ids = [run6A.taskId, run6B.taskId, run6C.taskId];
  record("flow6", "F6.12 · 流程 6 全部任务收敛终态且原 config 未被改写（默认切换不回写历史任务）",
    flow6Ids.every((id) => terminal6(snap6Final, id)) && flow6Ids.every((id) => { const r = modelRow(snap6Final, id); return r.model_config_id === defaultChat6 && Number(r.model_config_version) <= bumped6; }),
    JSON.stringify({ statuses: flow6Ids.map((id) => (modelRow(snap6Final, id) || {}).status), bindings: flow6Ids.map((id) => { const r = modelRow(snap6Final, id) || {}; return r.model_config_id + ":" + r.model_config_version; }) }),
    "全部终态 + 绑定不回写");
  R.flow6 = {
    taskA: run6A.taskId, taskB: run6B.taskId, taskC: run6C.taskId,
    defaultConfig: defaultChat6, frozenVersion: frozen6, bumpedVersion: bumped6, newDefaultConfig: cid6b,
    blockedAppend: { status: appendRun6[0] && appendRun6[0].status, error: appendRun6[0] && appendRun6[0].error_code, uiError: errText6 },
    appendAfterDefaultSwitch: get6B2.task.status, resumeAfterDefaultSwitch: get6C2.task.status,
    entries: [
      "真实 UI task/run（任务 A/B/C 全部经真实 AI 面板发起）",
      "真实 UI [data-ai-append-goal] + [data-ai-append]（任务 A 的改版后追加与任务 C 的预算停止追加）",
      "真实 UI [data-ai-resume]（任务 C 的显式续接）",
      "产品桥 task/appendStep（任务 B 在默认切换后的追加；与面板按钮同一条 IPC 命令）",
      "产品桥 window.openarc.model.command: model/update（版本提升）、model/create、defaults/set、model/list、defaults/get",
    ],
  };
  flowReached.flow6 = true;

  return { boot, snap, gateAfterReload };
}

let outcome = { boot: null, snap: null };
try {
  outcome = await main();
} catch (error) {
  record("setup", "E2E · 整体未抛异常", false, String((error && error.message) || error).slice(0, 200), "no throw");
  console.log("ERROR " + String((error && error.stack) || error));
} finally {
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  try { if (child) child.kill("SIGTERM"); } catch { /* ignore */ }
  await sleep(800);
  try { if (child && child.exitCode === null) child.kill("SIGKILL"); } catch { /* ignore */ }
  try { if (provider) await provider.close(); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- 脱敏 gate JSON
const SECRET_RE = [/\/Users\/[^\s"']*/g, /\/private\/[^\s"']*/g, /\/var\/folders\/[^\s"']*/g, /mpx_[A-Za-z0-9_-]+/g, /tpx_[A-Za-z0-9_-]+/g, /credential[^\s"',}\]]*/gi];
function sanitize(value, extra) {
  if (typeof value === "string") { let s = value; for (const re of SECRET_RE) s = s.replace(re, "[REDACTED]"); for (const term of extra || []) if (term) s = s.split(term).join("[REDACTED]"); return s; }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, extra));
  if (value && typeof value === "object") { const out = {}; for (const [k, v] of Object.entries(value)) out[k] = sanitize(v, extra); return out; }
  return value;
}
const snap = outcome.snap;
const byTaskOut = (rows, id) => (rows || []).filter((r) => r.task_id === id);
const checkOk = (id) => checks.some((c) => c.name.startsWith(id + " ") && c.ok === true);
const flow1Id = R.taskIds.flow1, flow2Id = R.taskIds.flow2, flow3Id = R.taskIds.flow3, flow4Id = R.taskIds.flow4;
const f1Calls = snap ? byTaskOut(snap.sideEffectCalls, flow1Id) : [];
const f1CallIds = f1Calls.map((c) => c.call_id);
const f1Arts = snap ? byTaskOut(snap.artifacts, flow1Id) : [];
const f1Vers = snap ? byTaskOut(snap.verifications, flow1Id) : [];

function bucketStatus(flow) {
  const arr = FLOW_BUCKETS[flow] || [];
  if (!arr.length) return "FAIL";
  return arr.every(Boolean) ? "PASS" : "FAIL";
}
const hardFailed = checks.filter((c) => !c.ok && !c.notVerified);
const rendererErrCount = consoleErrors.length;
const mainErrCount = mainErrors.length;
const requiredFlows = {
  boot: bucketStatus("boot"),
  setup: bucketStatus("setup"),
  flow1: bucketStatus("flow1"),
  flow2: bucketStatus("flow2"),
  flow3: bucketStatus("flow3"),
  flow4: bucketStatus("flow4"),
  flow5: bucketStatus("flow5"),
  flow6: bucketStatus("flow6"),
};
const anyRequiredFail = Object.entries(requiredFlows).some(([, s]) => s === "FAIL");
const anyRequiredNV = Object.entries(requiredFlows).some(([, s]) => s === "NOT_VERIFIED");
let overallStatus = "PASS";
if (anyRequiredFail || rendererErrCount > 0 || mainErrCount > 0) overallStatus = "FAIL";
else if (anyRequiredNV) overallStatus = "PARTIAL";

let gate = {
  testedCommit: (() => { try { return require("node:child_process").execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; } })(),
  workspaceState: (() => { try { return require("node:child_process").execFileSync("git", ["-C", ROOT, "status", "--porcelain"], { encoding: "utf8" }).trim(); } catch { return ""; } })(),
  command: COMMAND,
  env: { electron: process.versions.electron || null, node: process.versions.node, platform: process.platform, arch: process.arch, provider: "deterministic-local-http" },
  isolation: { userData: "os.tmpdir mkdtemp (isolated)", adminEnv: "OPENARC_IDENTITY_ADMIN=1", observeEnv: "OPENARC_E2E_OBSERVE=1" },
  productSeams: [
    { name: "boot snapshot", env: "OPENARC_E2E_OBSERVE=1", default: "off", effect: "仅把 runtime.snapshot() 写为隔离 userData/openarc-e2e-boot.json" },
    { name: "test-only tool grant seeding", removed: true, env: "OPENARC_E2E_SEED_TOOL_GRANTS=1", effect: "已从 electron/main.cjs 删除；工具权限一律经产品治理入口" },
  ],
  productEntries: {
    toolGrantUI: "组织治理（dock）→ App 权限 → 工具权限（data-gov-tool-*）；流程 1 与流程 4 的正对照经此真实 UI 授予",
    governanceBridge: "window.openarc.governance.command：getAppToolAccess / grantAppToolAccess / revokeAppToolAccess（流程 2 与 14(e) 撤权）",
    appendStepEntry: "AI 面板 [data-ai-append-block] / [data-ai-append-goal] / [data-ai-append] → window.openarc.task.command task/appendStep（同一 taskId；拒绝同步返回，接收立即返回 RUNNING，结果经 task/result 推送）",
    resumeEntry: "AI 面板 [data-ai-resume] / [data-ai-stop-reason] / [data-ai-resume-budget] / [data-ai-resume-remaining] → window.openarc.task.command task/resume（预算续接）",
    stepsProjection: "AI 面板 [data-ai-steps] / [data-ai-step]（sequence 属性） / data-ai-step-status / data-ai-step-appended，全部来自后端 task/get",
    modelConfigBinding: "任务 model config 由后端在 task/run 内按可信 context 解析并冻结 id+version（renderer 自报一律忽略）；Settings → 模型页只有注册 / 启停 / 默认设置，没有编辑入口，因此流程 6 的版本提升走产品桥 window.openarc.model.command { type: 'model/update' }（displayName 变更 → 真实 version bump），第二个 config 走 model/create，默认切换走 defaults/set（PERSONAL + ORGANIZATION），读取走 model/list + defaults/get",
  },
  boot: outcome.boot ? { snapshot: sanitize(outcome.boot, [PROVIDER_SECRET]), orderOk: checks.find((c) => c.name.startsWith("B1"))?.ok === true, listening: outcome.boot.modelProxyListening === true } : null,
  flows: {
    flow1: { taskId: flow1Id || null, prerequisiteGrant: "product governance UI (grantAppToolAccess)", status: snap ? (snap.tasks.find((t) => t.task_id === flow1Id) || {}).status : null, sideEffectCalls: f1Calls.length, approvals: snap ? snap.approvals.filter((a) => f1CallIds.includes(a.call_id)).length : 0, leases: snap ? snap.leases.filter((l) => f1CallIds.includes(l.call_id)).length : 0, artifacts: f1Arts.length, verifications: f1Vers.length, mutation: 1, executorSpawned: R.exec.flow1Spawned >= 1 },
    flow2: { taskId: flow2Id || null, prerequisiteGrant: "product governance UI (grantAppToolAccess)", revokeEntry: "product governance/revokeAppToolAccess", callStatus: snap ? (byTaskOut(snap.sideEffectCalls, flow2Id)[0] || {}).status || null : null, errorCode: snap ? (byTaskOut(snap.sideEffectCalls, flow2Id)[0] || {}).error_code || null : null, leases: snap ? byTaskOut(snap.leases, flow2Id).length : 0, mutation: 0, nonAdminGrantDenied: checks.find((c) => c.name.startsWith("F2.9"))?.ok === true },
    flow3: { taskId: flow3Id || null, prerequisiteGrant: "product entry grantAppToolAccess (search/readMetadata only)", status: snap ? (snap.tasks.find((t) => t.task_id === flow3Id) || {}).status : null, sideEffectCalls: snap ? byTaskOut(snap.sideEffectCalls, flow3Id).length : 0, mutation: 0, deniedOperation: checks.find((c) => c.name.startsWith("F3.5"))?.ok === true, deniedUiVisible: checks.find((c) => c.name.startsWith("F3.6"))?.ok === true },
    flow4: {
      taskId: flow4Id || null,
      entry: "真实 UI：task/run（plan write + 目标资源）→ Approve → [data-ai-append-goal] + [data-ai-append]（plan budget）→ 第二步真实预算停止 → [data-ai-resume]（plan final）→ 成功",
      status: snap ? (snap.tasks.find((t) => t.task_id === flow4Id) || {}).status : null,
      appendAcceptedByUI: checkOk("F4.31"),
      steps: R.flow4 ? R.flow4.steps : null,
      budgetStop: R.flow4 ? { stopReason: "BUDGET_EXHAUSTED", blockingKind: R.flow4.nextGrant.kind, artifactsOfBudgetStep: 0, runs: R.flow4.runs } : null,
      budgetBeforeAppend: R.flow4 ? R.flow4.budgetBefore : null,
      budgetAfterStop: R.flow4 ? R.flow4.budgetStop : null,
      budgetFinal: R.flow4 ? R.flow4.budgetFinal : null,
      nextGrant: R.flow4 ? R.flow4.nextGrant : null,
      resume: R.flow4 ? { uiVisible: checkOk("F4.40"), uiBudgetMatchesBackend: checkOk("F4.41"), uiRemainingMatchesBackend: checkOk("F4.42"), additions: R.flow4.additions, resumeCount: R.flow4.resumeCount } : null,
      calls: R.flow4 ? { providerModelRequests: R.flow4.modelRequests, modelCallsConsumed: R.flow4.budgetFinal.MODEL_CALLS.consumed, providerToolCalls: R.flow4.providerToolCalls, toolCallsConsumed: R.flow4.budgetFinal.TOOL_CALLS.consumed, toolRoundsConsumed: R.flow4.budgetFinal.TOOL_ROUNDS.consumed } : null,
      artifacts: R.flow4 ? R.flow4.artifacts : (snap ? byTaskOut(snap.artifacts, flow4Id).length : 0),
      verifications: R.flow4 ? R.flow4.verifications : (snap ? byTaskOut(snap.verifications, flow4Id).length : 0),
      harnessRuns: R.flow4 ? R.flow4.runs : 0,
      artifactChecksums: R.flow4 ? R.flow4.artifactChecksums : null,
      artifactRefs: R.flow4 ? R.flow4.artifactRefs : null,
      rejectionMatrix: {
        concurrencySingleWinner: checkOk("F4.4"), duplicateStaleRevision: checkOk("F4.6"), staleRevisionAfterAppend: checkOk("F4.35"), staleRevisionAfterBlocked: checkOk("F4.39"),
        notSucceededBlockedTask: checkOk("F4.8"), awaitingApproval: checkOk("F4.15"), nonOwnerMemberSession: checkOk("F4.53"), revokeBeforeExecution: checkOk("F4.19"),
        positiveControls: ["F4.3", "F4.5", "F4.10", "F4.12", "F4.16", "F4.23", "F4.52"].map((id) => ({ check: id, ok: checkOk(id) })),
      },
      revokeTask: Object.assign({ taskId: R.taskIds.flow4Revoke || null }, R.flow4Revoke || {}),
    },
    flow5: {
      reloadGate: outcome.gateAfterReload || null,
      source: "page.reload() 后仅经后端 task/get + 真实 AI 面板 [data-ai-steps]/[data-ai-append-block]/[data-ai-resume] 恢复，不依赖 renderer memory",
      grantsRestored: checks.find((c) => c.name.startsWith("F5.2"))?.ok === true, flow1Restored: checks.find((c) => c.name.startsWith("F5.3"))?.ok === true, flow3Restored: checks.find((c) => c.name.startsWith("F5.4"))?.ok === true, budgetRestored: checks.find((c) => c.name.startsWith("F5.5"))?.ok === true,
      flow4PanelRestored: checkOk("F5.6"), flow4StepsRestored: checkOk("F5.7"), flow4AppendStateRestored: checkOk("F5.8"), flow4LedgerRestored: checkOk("F5.9"), flow4RevokeTaskRestored: checkOk("F5.10"),
      latestTaskIsFlow4: (outcome.snap ? outcome.snap.tasks.slice().sort((a, b) => a.created_at - b.created_at).slice(-1)[0].task_id : null) === (R.taskIds.flow4 || null),
    },
    flow6: {
      entry: "真实 UI task/run（后端解析冻结默认模型）→ 产品桥 model/update 提升该 config 版本 → 真实 UI 追加步骤 → BLOCKED/MODEL_CONFIG_CHANGED → 新任务绑定新版本成功；产品桥 defaults/set 切默认后原 config 任务的 append/resume 仍成功",
      taskIds: R.taskIds.flow6 || R.flow6 ? { taskA: (R.flow6 && R.flow6.taskA) || R.taskIds.flow6 || null, taskB: (R.flow6 && R.flow6.taskB) || R.taskIds.flow6B || null, taskC: (R.flow6 && R.flow6.taskC) || R.taskIds.flow6C || null } : null,
      defaultConfig: R.flow6 ? R.flow6.defaultConfig : null,
      frozenVersion: R.flow6 ? R.flow6.frozenVersion : null,
      bumpedVersion: R.flow6 ? R.flow6.bumpedVersion : null,
      newDefaultConfig: R.flow6 ? R.flow6.newDefaultConfig : null,
      blockedAppend: R.flow6 ? R.flow6.blockedAppend : null,
      appendAfterDefaultSwitch: R.flow6 ? R.flow6.appendAfterDefaultSwitch : null,
      resumeAfterDefaultSwitch: R.flow6 ? R.flow6.resumeAfterDefaultSwitch : null,
      checks: ["F6.2", "F6.3", "F6.4", "F6.5", "F6.6", "F6.7", "F6.8", "F6.9", "F6.10", "F6.11", "F6.12"].map((id) => ({ check: id, ok: checkOk(id) })),
      modelConfigEntries: R.flow6 ? R.flow6.entries : null,
    },
  },
  requiredFlows,
  overallStatus,
  notVerified,
  observations,
  rendererConsoleErrors: rendererErrCount,
  mainUnhandledErrors: mainErrCount,
  checksSummary: { total: checks.length, pass: checks.filter((c) => c.ok).length, fail: hardFailed.length, notVerified: checks.filter((c) => c.notVerified).length },
  checks,
  at: new Date().toISOString(),
};
gate = sanitize(gate, [PROVIDER_SECRET]);
gate.artifactSha256Coverage = "sha256 of canonical JSON (2-space indent) excluding artifactSha256 field";
const canonicalForHash = JSON.stringify(gate, null, 2);
gate.artifactSha256 = crypto.createHash("sha256").update(canonicalForHash).digest("hex");
const gateText = JSON.stringify(gate, null, 2);
fs.mkdirSync(path.join(ROOT, "artifacts", "d4-main-e2e"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "artifacts", "d4-main-e2e", "gate.json"), gateText);
console.log("");
console.log(checks.filter((c) => c.ok).length + "/" + checks.length + " checks passed; NOT VERIFIED: " + notVerified.map((n) => n.name).join(" | "));
console.log("REQUIRED FLOWS: " + JSON.stringify(requiredFlows));
console.log("OVERALL STATUS: " + overallStatus);
console.log("GATE: " + JSON.stringify({ testedCommit: gate.testedCommit, workspaceState: gate.workspaceState, artifactSha256: gate.artifactSha256, requiredFlows, overallStatus, notVerified: notVerified.map((n) => n.name), rendererConsoleErrors: rendererErrCount, mainUnhandledErrors: mainErrCount, checksSummary: gate.checksSummary, boot: gate.boot && { snapshot: gate.boot.snapshot, orderOk: gate.boot.orderOk } }));

if (hardFailed.length) console.log("HARD FAILED: " + hardFailed.map((c) => c.name).join(" | "));
const exitCode = overallStatus === "PASS" ? 0 : 1;
console.log("EXIT_CODE: " + exitCode);
process.exit(exitCode);
