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
 *   boot / setup / flow1 / flow2 / flow3 / flow5 任一 FAIL 或不可达 → overallStatus FAIL 且 exit 非零。
 *   flow4（预算停止 + UI 显式续接）当前产品入口不可达 → NOT_VERIFIED，但属必需项：overallStatus PARTIAL 且 exit 非零。
 *   绝不把 NOT_VERIFIED 当作通过。
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
const FLOW_BUCKETS = { boot: [], setup: [], flow1: [], flow2: [], flow3: [], flow5: [] };
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

  const flowReached = { flow1: false, flow2: false, flow3: false, flow5: false };

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
  record("flow2", "F2.7 · Task/Step BLOCKED + UI busy 复位", revokeTask && revokeTask.status === "BLOCKED" && revokeStep && revokeStep.status === "BLOCKED" && !(await isDisabled("[data-ai-run]")), JSON.stringify({ task: revokeTask && revokeTask.status, step: revokeStep && revokeStep.status, runEnabled: !(await isDisabled("[data-ai-run]")) }), "BLOCKED/BLOCKED + run enabled");
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

  // ================================================================ 流程 4：预算停止 + UI 显式续接（如实调查 → NOT VERIFIED）
  await setPlan("budget");
  const budgetRun = await runTask("MAIN-E2E BUDGET: 连续读取直至预算到限");
  R.taskIds.flow4 = budgetRun.taskId;
  const budgetTerminal = await waitTaskTerminal(budgetRun.taskId, 240000);
  const budgetGet = await taskGet(budgetRun.taskId);
  const budgetStatus = budgetGet && budgetGet.task && budgetGet.task.status;
  const budgetSnap = dbSnapshot();
  const budgetArts = byTask(budgetSnap.artifacts, budgetRun.taskId).length;
  const budgetResumable = !!(budgetGet && budgetGet.resumable);
  const budgetReason = budgetGet && budgetGet.resumeReason;
  const budgetResumeVisible = await has("[data-ai-resume]");
  observe("flow4-budget-stop", JSON.stringify({ status: budgetStatus, artifacts: budgetArts, resumable: budgetResumable, resumeReason: budgetReason, resumeUi: budgetResumeVisible }));
  record("flow4", "F4.1 · [OBSERVE] bounded 预算任务在真实 main 下停止", budgetTerminal && budgetStatus === "BLOCKED", budgetStatus, "BLOCKED");
  record("flow4", "F4.2 · [OBSERVE] 预算路径 0 Artifact（getResumeEligibility 前置不满足）", budgetArts === 0, budgetArts, 0);
  markNotVerified("flow4",
    "F4.3 · 预算停止后经产品入口可达可续接状态 + UI 显式续接",
    "结构冲突（本轮不可达）：真实 UI 的 task/run 每次只创建一个 step；预算耗尽发生在推理过程中，该 step 直接 BLOCKED 且 0 Artifact。而 getResumeEligibility 要求 artifactsOfTask>0（否则 RESUME_NO_SAFE_CONTINUATION），因此产品入口永远拿不到 resumable=true / 续接 UI。d4-06-resume 是先经主进程 API 构造 2-step 任务（step1 成功 WRITE 出 Artifact，step2 预算停止）才触达；该构造不是产品入口。本轮不通过测试 API 构造多步任务、不制造空产物/假成功、不放宽续接守卫。最小方案：需要一个产品级“分阶段/追加步骤”入口，使正常任务先完成一个带 Artifact 的真实步骤，再在后续步骤预算停止。",
    JSON.stringify({ status: budgetStatus, artifacts: budgetArts, resumable: budgetResumable, resumeReason: budgetReason, resumeUi: budgetResumeVisible }),
    "resumable=true + nextGrant + UI resume");

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
  flowReached.flow5 = true;

  // ---------------------------------------------------------------- 流程 2（续）：真实 MEMBER 会话调用治理 grant 被拒
  const createdMember = await gov({ type: "governance/createUser", identifier: MEMBER, password: MEMBER_PW, displayName: "Main E2E Member", role: "MEMBER" });
  record("flow2", "F2.8 · 经产品治理入口创建 MEMBER 账号", !!(createdMember && createdMember.ok), createdMember && createdMember.ok ? "created" : JSON.stringify(createdMember), "created");
  const loggedOut = await logout();
  const memberReady = await loginAs(MEMBER, MEMBER_PW);
  const grantAsMember = await gov({ type: "governance/grantAppToolAccess", appId: "ai", actions: [TOOL_TRASH] });
  record("flow2", "F2.9 · 真实 MEMBER 会话调用治理 grant 被拒", loggedOut && memberReady && grantAsMember && grantAsMember.ok === false && grantAsMember.error === "NOT_SUPER_ADMIN", JSON.stringify({ loggedOut, memberReady, res: grantAsMember }), "ok=false + NOT_SUPER_ADMIN");

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
const flow1Id = R.taskIds.flow1, flow2Id = R.taskIds.flow2, flow3Id = R.taskIds.flow3, flow4Id = R.taskIds.flow4;
const f1Calls = snap ? byTaskOut(snap.sideEffectCalls, flow1Id) : [];
const f1CallIds = f1Calls.map((c) => c.call_id);
const f1Arts = snap ? byTaskOut(snap.artifacts, flow1Id) : [];
const f1Vers = snap ? byTaskOut(snap.verifications, flow1Id) : [];

function bucketStatus(flow) {
  if (flow === "flow4") return "NOT_VERIFIED";
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
  flow4: "NOT_VERIFIED",
  flow5: bucketStatus("flow5"),
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
    toolGrantUI: "组织治理（dock）→ App 权限 → 工具权限（data-gov-tool-*）；流程 1 经此真实 UI 授予",
    governanceBridge: "window.openarc.governance.command：getAppToolAccess / grantAppToolAccess / revokeAppToolAccess",
  },
  boot: outcome.boot ? { snapshot: sanitize(outcome.boot, [PROVIDER_SECRET]), orderOk: checks.find((c) => c.name.startsWith("B1"))?.ok === true, listening: outcome.boot.modelProxyListening === true } : null,
  flows: {
    flow1: { taskId: flow1Id || null, prerequisiteGrant: "product governance UI (grantAppToolAccess)", status: snap ? (snap.tasks.find((t) => t.task_id === flow1Id) || {}).status : null, sideEffectCalls: f1Calls.length, approvals: snap ? snap.approvals.filter((a) => f1CallIds.includes(a.call_id)).length : 0, leases: snap ? snap.leases.filter((l) => f1CallIds.includes(l.call_id)).length : 0, artifacts: f1Arts.length, verifications: f1Vers.length, mutation: 1, executorSpawned: R.exec.flow1Spawned >= 1 },
    flow2: { taskId: flow2Id || null, prerequisiteGrant: "product governance UI (grantAppToolAccess)", revokeEntry: "product governance/revokeAppToolAccess", callStatus: snap ? (byTaskOut(snap.sideEffectCalls, flow2Id)[0] || {}).status || null : null, errorCode: snap ? (byTaskOut(snap.sideEffectCalls, flow2Id)[0] || {}).error_code || null : null, leases: snap ? byTaskOut(snap.leases, flow2Id).length : 0, mutation: 0, nonAdminGrantDenied: checks.find((c) => c.name.startsWith("F2.9"))?.ok === true },
    flow3: { taskId: flow3Id || null, prerequisiteGrant: "product entry grantAppToolAccess (search/readMetadata only)", status: snap ? (snap.tasks.find((t) => t.task_id === flow3Id) || {}).status : null, sideEffectCalls: snap ? byTaskOut(snap.sideEffectCalls, flow3Id).length : 0, mutation: 0, deniedOperation: checks.find((c) => c.name.startsWith("F3.5"))?.ok === true, deniedUiVisible: checks.find((c) => c.name.startsWith("F3.6"))?.ok === true },
    flow4: { taskId: flow4Id || null, observed: observations.find((o) => o.name === "flow4-budget-stop")?.detail || null, resumable: false, uiResume: false },
    flow5: { reloadGate: outcome.gateAfterReload || null, grantsRestored: checks.find((c) => c.name.startsWith("F5.2"))?.ok === true, flow1Restored: checks.find((c) => c.name.startsWith("F5.3"))?.ok === true, flow3Restored: checks.find((c) => c.name.startsWith("F5.4"))?.ok === true, budgetRestored: checks.find((c) => c.name.startsWith("F5.5"))?.ok === true },
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
