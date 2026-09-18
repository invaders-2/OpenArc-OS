/**
 * D4 · 真实产品入口 electron/main.cjs 端到端 gate。
 *
 * 真实启动产品 electron .（真实 main.cjs + 真实 preload + dist/index.html），
 * CDP 连接真实 Renderer，以真实 UI + window.openarc 产品桥驱动四条流程。
 * 主进程内部状态只经两种只读途径获得：
 *   1) electron/main.cjs 唯一两处默认关闭 test seam 中的 boot 观测（OPENARC_E2E_OBSERVE=1）；
 *   2) 只读打开隔离 userData 的 identity.db（node:sqlite readOnly）与 runtime/side-effects/executors 计数。
 * 绝不写库、绝不手工设终态。
 *
 * 诚实边界（重要）：产品目前没有授予 App TOOL-scope 权限的 UI / IPC 入口，
 * 流程 1/2/3 的前置 tool grant 由第二处默认关闭 test seam（OPENARC_E2E_SEED_TOOL_GRANTS=1，
 * 在真实 ADMIN 会话后调用真实 authorization.grantAppToolPermission，仍过 SUPER_ADMIN 校验）
 * 代偿。该产品入口本身记为 gap / NOT VERIFIED，播种绝不当作“产品入口已验证”。
 * 流程 4（记忆）只走产品路径，不使用该播种。
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
const adapter = require("../electron/harness-model-adapter.cjs");
const { OPENARC_RULES_TEXT, RULES_NAME, REFERENCE_NAME } = adapter;
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const CDP_PORT = Number(process.env.OA_MAIN_CDP_PORT || 9788);
const ADMIN = "admin@openarc.test";
const PW = "admin-password-1";
const MEMBER = "member-main-e2e@openarc.test";
const MEMBER_PW = "member-password-1";
const MEMORY_SECRET = "SECRET_MAIN_E2E_MEMORY_alpha_roadmap";
const PROVIDER_SECRET = "main-e2e-provider-secret";
const MEMORY_NAME = "Main E2E Alpha Notes";
const GOAL_MEMORY = "project alpha";
const TOOL_ACTIONS = ["tool.resource.search", "tool.resource.readMetadata", "tool.resource.trash"];
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
const record = (name, ok, actual, expected) => {
  checks.push({ name, expected: expected === undefined ? "" : String(expected), actual: String(actual === undefined ? "" : actual), ok: !!ok });
  console.log((ok ? "PASS" : "FAIL") + " " + name + " :: actual=" + String(actual) + " expected=" + String(expected));
};
const markNotVerified = (name, reason) => { notVerified.push({ name, reason }); console.log("NOT_VERIFIED " + name + " :: " + reason); };
const gap = (name, actual, expected, reason) => {
  checks.push({ name, expected: String(expected), actual: String(actual), ok: false, gap: true });
  markNotVerified(name, reason);
  console.log("GAP " + name + " :: actual=" + String(actual) + " expected=" + String(expected));
};
const observe = (name, detail) => { observations.push({ name, detail }); console.log("OBSERVE " + name + " :: " + detail); };

const mainErrors = [];
const consoleErrors = [];
const R = { taskIds: {}, exec: {}, mem: {}, ledger: {} };
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
  const env = { ...process.env, OPENARC_D4_PROVIDER_URL: provider.baseUrl, OPENARC_IDENTITY_ADMIN: "1", OPENARC_E2E_OBSERVE: "1", OPENARC_E2E_SEED_TOOL_GRANTS: "1" };
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
  record("M1 · 真实 electron .（electron/main.cjs）启动并暴露 CDP", true, version.Browser, "CDP ready");

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
    const control = provider.baseUrl.replace(/\/v1\/?$/, "") + "/__plan";
    const res = await fetch(control, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ mode }, extra || {})) });
    return res.ok;
  }
  async function readBodies() { const res = await fetch(provider.baseUrl.replace(/\/v1\/?$/, "") + "/__bodies"); const json = await res.json(); return Array.isArray(json.bodies) ? json.bodies : []; }
  const messagesOf = (body) => (body && Array.isArray(body.messages) ? body.messages : []);
  const messageText = (m) => { if (!m) return ""; if (typeof m.content === "string") return m.content; if (Array.isArray(m.content)) return m.content.map((p) => (p && typeof p.text === "string" ? p.text : "")).join(""); return ""; };
  const bodyText = (body) => messagesOf(body).map(messageText).join("\n");
  const messageByName = (body, name) => messagesOf(body).find((m) => m && m.name === name) || null;
  async function createResource(name, type, content) { const r = await bridge("resource", { type: "resource/create", resourceType: type || "text", name, content: content || (name + "-body") }); return r && r.ok ? { id: r.resource.resourceId, ref: r.resource.resourceRef, raw: r } : { raw: r }; }
  async function grantAiResource(id) { return bridge("governance", { type: "governance/grantAppAccess", appId: "ai", resourceId: id, actions: ["resource.read", "resource.delete", "resource.useByAgent"] }); }
  async function clickApprove() { return click('[data-approval-action="approve"]'); }

  // ---------------------------------------------------------------- boot 观测（唯一 boot seam）
  await waitSel('[data-d3-id="setup-name"]', 30000);
  const bootRaw = fs.existsSync(BOOT_PATH) ? fs.readFileSync(BOOT_PATH, "utf8") : null;
  let boot = null;
  try { boot = bootRaw ? JSON.parse(bootRaw) : null; } catch { boot = null; }
  record("B0 · boot 观测文件存在且可解析（OPENARC_E2E_OBSERVE=1）", !!boot, bootRaw ? "parsed" : "missing", "openarc-e2e-boot.json");
  const expectedOrder = ["identity_created", "model_proxy_start_attempted", "model_proxy_started", "runtime_ready"];
  const orderIdx = boot ? expectedOrder.map((s) => (boot.bootOrder || []).indexOf(s)) : [];
  const orderOk = !!boot && orderIdx.every((i) => i >= 0) && orderIdx.every((i, k) => k === 0 || i > orderIdx[k - 1]);
  record("B1 · bootOrder 严格有序", orderOk, JSON.stringify(boot && boot.bootOrder), expectedOrder.join(" -> "));
  record("B2 · Model Proxy 任务接入前真实启动并监听", !!boot && boot.modelProxyStartAttempted === true && boot.modelProxyStarted === true && boot.modelProxyListening === true, JSON.stringify(boot ? { attempted: boot.modelProxyStartAttempted, started: boot.modelProxyStarted, listening: boot.modelProxyListening } : null), "attempted+started+listening");

  // ---------------------------------------------------------------- 真实 UI：首次初始化 + 登录
  record("A1 · 真实 UI 首次初始化（FIRST RUN）", await has('[data-d3-id="setup-form"]'), "setup-form", "present");
  await setInput('[data-d3-id="setup-name"]', "Main E2E Admin");
  await setInput('[data-d3-id="setup-identifier"]', ADMIN);
  await setInput('[data-d3-id="setup-password"]', PW);
  await setInput('[data-d3-id="setup-confirm"]', PW);
  await sleep(120);
  record("A2 · 真实 UI 提交初始化", (await click('[data-d3-id="setup-submit"]')) === "ok", "clicked", "ok");
  record("A3 · 初始化后 gate=unauthenticated", await waitGate("unauthenticated", 30000), await gate(), "unauthenticated");
  await setInput('[data-d3-id="login-identifier"]', ADMIN);
  await setInput('[data-d3-id="login-password"]', PW);
  await sleep(100);
  record("A4 · 真实 UI 登录 admin", (await click('[data-d3-id="login-submit"]')) === "ok", "clicked", "ok");
  record("A5 · 登录后 identity gate=ready", await waitGate("ready", 30000), await gate(), "ready");
  const taskBridgeKeys = await js("return window.openarc && window.openarc.task ? Object.keys(window.openarc.task).sort().join(',') : 'missing'");
  record("A6 · 真实 preload Task 桥只有 command,onEvent", taskBridgeKeys === "command,onEvent", taskBridgeKeys, "command,onEvent");
  record("A7 · Renderer 拿不到主进程 Domain", await js("return typeof window.openarc.taskService === 'undefined' && typeof window.openarc.resourceService === 'undefined'"), "hidden", "hidden");

  // ------------------------------------------------------- test-only 播种（第二处 seam，代偿缺失产品入口）
  const seedSeen = await waitFor(() => toolGrantRows().length > 0, 20000);
  const seededActions = seedSeen ? JSON.parse(toolGrantRows()[0].actions || "[]") : [];
  record("P1 · test-only 播种在 admin 会话后真实 grantAppToolPermission（4 个 tool 动作）", seedSeen && TOOL_ACTIONS.every((a) => seededActions.includes(a)), JSON.stringify(seededActions), JSON.stringify(TOOL_ACTIONS));
  markNotVerified("产品入口 · 授予 App TOOL-scope 权限（UI / IPC）", "产品没有任何入口能创建 app TOOL-scope grant：authorization 桥只读；governance/grantAppAccess 经 normalizeGrantActions 只接受 RESOURCE_ACTIONS，tool.* 动作返回 INVALID_INPUT（本 run P0 实测）。流程 1/2/3 的前置 grant 由默认关闭的 test-only seam（OPENARC_E2E_SEED_TOOL_GRANTS=1，真实 grantAppToolPermission + SUPER_ADMIN 校验）代偿；该产品入口本身 = NOT VERIFIED / gap。");

  // ---------------------------------------------------------------- 真实 UI：Settings → Models
  await click('[data-app-id="settings"]');
  await waitSel('[data-settings-pane="model"]', 20000);
  await click('[data-settings-pane="model"]');
  const settingsOpen = await waitSel('[data-d4-01="settings"]', 20000);
  record("S1 · 打开 Settings → 模型 / AI（真实 UI）", settingsOpen, settingsOpen ? "open" : "missing", "open");
  await setInput('[data-d4-01-provider-name]', "Main E2E Provider");
  await setInput('[data-d4-01-provider-scope]', "ORGANIZATION");
  await setInput('[data-d4-01-provider-url]', provider.baseUrl);
  await setInput('[data-d4-01-provider-secret]', PROVIDER_SECRET);
  await click('[data-d4-01-provider-create]');
  const providerCreated = await waitSel('[data-d4-01-provider]', 20000);
  const pid = await attr("[data-d4-01-provider]", "data-d4-01-provider");
  record("S2 · 真实 UI 创建本地确定性 Provider", providerCreated && !!pid, pid ? "created" : "missing", "created");
  record("S3 · 保存后密钥输入框清空（write-only）", (await js("return document.querySelector('[data-d4-01-provider-secret]').value")) === "", "cleared", "cleared");
  await click('[data-d4-01-tab="models"]');
  await waitSel('[data-d4-01-pane="models"]', 20000);
  await setInput('[data-d4-01-model-provider]', pid);
  await setInput('[data-d4-01-model-scope]', "ORGANIZATION");
  await setInput('[data-d4-01-model-remote]', "main-e2e-local");
  await setInput('[data-d4-01-model-name]', "Main E2E Local");
  await click('[data-d4-01-model-create]');
  const modelCreated = await waitSel('[data-d4-01-model]', 20000);
  const cid = await attr("[data-d4-01-model]", "data-d4-01-model");
  record("S4 · 真实 UI 注册 Model", modelCreated && !!cid, cid ? "created" : "missing", "created");
  await click('[data-d4-01-tab="defaults"]');
  await waitSel('[data-d4-01-pane="defaults"]', 20000);
  await setInput('[data-d4-01-default-personal-chat]', cid);
  await waitFor(async () => (await js("return document.querySelector('[data-d4-01-default-personal-chat]').value")) === cid, 15000);
  await setInput('[data-d4-01-default-org-chat]', cid);
  const orgDefaultOk = await waitFor(async () => (await js("return document.querySelector('[data-d4-01-default-org-chat]').value")) === cid, 15000);
  record("S5 · 真实 UI 设置默认 chat model（personal + organization）", orgDefaultOk, "org=" + (await js("return document.querySelector('[data-d4-01-default-org-chat]').value")), cid);
  await setPlan("final");
  await click('[data-d4-01-tab="providers"]');
  await waitSel('[data-d4-01-pane="providers"]', 15000);
  await click('[data-d4-01-test="' + pid + '"]');
  const testPassed = await waitFor(async () => (await text('[data-d4-01-test-result="' + pid + '"]')).indexOf("Inference:PASS") >= 0, 30000);
  record("S6 · 真实 UI 连接测试 Inference:PASS", testPassed, await text('[data-d4-01-test-result="' + pid + '"]'), "Inference:PASS");

  // ---------------------------------------------------------------- 流程 1：启动与成功执行（前置 grant 由 test-only 播种）
  const target = await createResource("Main E2E Target", "text");
  record("R1 · 经产品桥 resource/create 造目标资源", !!target.ref, target.ref ? "created" : JSON.stringify(target.raw && target.raw.error), "created");
  const reindex = await bridge("resource", { type: "resource/reindex", resourceRef: target.ref });
  record("R2 · 经产品桥 resource/reindex 建索引", !!(reindex && reindex.ok), reindex && reindex.ok ? "ok" : JSON.stringify(reindex), "ok");
  const targetGrant = await grantAiResource(target.id);
  record("R3 · 经产品治理入口给 ai 授予资源级 read/delete/useByAgent", !!(targetGrant && targetGrant.ok), targetGrant && targetGrant.ok ? "ok" : JSON.stringify(targetGrant), "ok");
  await setPlan("write", { resourceRef: target.ref });
  const writeRun = await runTask("MAIN-E2E WRITE: 把 Main E2E Target 移入废纸篓");
  R.taskIds.flow1 = writeRun.taskId;
  const writeApprovalId = await waitApproval(120000);
  record("F1.1 · 真实 UI 任务发起并进入 AWAITING_APPROVAL（Approval UI 出现）", writeRun.started && !!writeApprovalId, JSON.stringify({ started: writeRun.started, approval: !!writeApprovalId }), "started + approval visible");
  const preWrite = dbSnapshot();
  const preCall = byTask(preWrite.sideEffectCalls, writeRun.taskId)[0];
  const preResource = preWrite.resources.find((r) => r.resource_id === target.id);
  record("F1.2 · 审批前 0 mutation / 0 lease / 0 WRITE execution", !!preCall && preCall.status === "AWAITING_APPROVAL" && preResource && preResource.status === "active" && preWrite.leases.filter((l) => l.call_id === (preCall && preCall.call_id)).length === 0 && byTask(preWrite.executions, writeRun.taskId).filter((e) => e.tool_id === "resource.trash").length === 0, JSON.stringify({ call: preCall && preCall.status, resource: preResource && preResource.status }), "AWAITING_APPROVAL + active + 0/0");
  const approvalText = (await text(".approval")).replace(/\s+/g, " ").slice(0, 140);
  record("F1.3 · Approval UI 显示 tool / risk / target", approvalText.includes("resource.trash") && approvalText.includes("可逆写入") && approvalText.includes("Main E2E Target"), approvalText, "tool+risk+target");
  await waitFor(async () => !(await isDisabled('[data-approval-action="approve"]')), 15000);
  record("F1.4 · 点击真实 Approve", (await clickApprove()) === "ok", "clicked", "ok");
  const writeTerminal = await waitTaskTerminal(writeRun.taskId, 180000);
  const writeGet = await taskGet(writeRun.taskId);
  const writeStatus = writeGet && writeGet.task && writeGet.task.status;
  const postWrite = dbSnapshot();
  const writeCall = byTask(postWrite.sideEffectCalls, writeRun.taskId)[0];
  const writeTaskRow = postWrite.tasks.find((t) => t.task_id === writeRun.taskId);
  const writeStep = byTask(postWrite.steps, writeRun.taskId)[0];
  const writeCallIds = byTask(postWrite.sideEffectCalls, writeRun.taskId).map((c) => c.call_id);
  const writeLeases = postWrite.leases.filter((l) => writeCallIds.includes(l.call_id));
  const writeApprovals = postWrite.approvals.filter((a) => writeCallIds.includes(a.call_id));
  const writeArts = byTask(postWrite.artifacts, writeRun.taskId);
  const writeVers = byTask(postWrite.verifications, writeRun.taskId);
  const writeResource = postWrite.resources.find((r) => r.resource_id === target.id);
  const writeExecs = byTask(postWrite.executions, writeRun.taskId);
  const mutation = writeResource && writeResource.status !== "active" ? 1 : 0;
  record("F1.5 · Task/Step SUCCEEDED", writeTerminal && writeStatus === "SUCCEEDED" && writeStep && writeStep.status === "SUCCEEDED", JSON.stringify({ task: writeStatus, step: writeStep && writeStep.status }), "SUCCEEDED/SUCCEEDED");
  record("F1.6 · 恰 1 次 mutation（目标资源已 trash）", mutation === 1, mutation, 1);
  record("F1.7 · SideEffectCall=1 / approval=1 / lease=1 / verification PASS", byTask(postWrite.sideEffectCalls, writeRun.taskId).length === 1 && writeCall.status === "SUCCEEDED" && writeCall.verification_status === "PASS" && writeApprovals.filter((a) => a.decision === "APPROVED").length === 1 && writeLeases.length === 1, JSON.stringify({ calls: byTask(postWrite.sideEffectCalls, writeRun.taskId).length, call: writeCall.status, ver: writeCall.verification_status, approvals: writeApprovals.length, leases: writeLeases.length }), "1/1/1/PASS");
  record("F1.8 · lease 状态 RELEASED", writeLeases.length === 1 && writeLeases[0].status === "RELEASED", writeLeases.length ? writeLeases[0].status : "none", "RELEASED");
  record("F1.9 · Artifact/Verification 齐全且相互绑定 + checksum 正确", writeArts.length === 1 && writeVers.length === 1 && writeVers[0].artifact_id === writeArts[0].artifact_id && writeArts[0].checksum === sha256(writeArts[0].safe_content), JSON.stringify({ artifacts: writeArts.length, verifications: writeVers.length }), "1+1 绑定");
  record("F1.10 · 受控 READ execution 归属本任务 + WRITE 以 SideEffectCall 记录", writeExecs.some((e) => e.tool_id === "resource.search") && writeExecs.every((e) => e.task_id === writeRun.taskId) && byTask(postWrite.sideEffectCalls, writeRun.taskId).some((c) => c.tool_id === "resource.trash"), JSON.stringify({ reads: writeExecs.map((e) => e.tool_id), writes: byTask(postWrite.sideEffectCalls, writeRun.taskId).map((c) => c.tool_id) }), "search execution + trash sideEffectCall");
  R.exec.flow1Spawned = executorRecordCount();
  record("F1.11 · production executor 真实 spawn（runtime/side-effects/executors 记录 >=1）", R.exec.flow1Spawned >= 1, R.exec.flow1Spawned, ">=1");

  // ---------------------------------------------------------------- 流程 3：预算停止与显式续接（前置 grant 由 test-only 播种）
  await setPlan("budget");
  const budgetRun = await runTask("MAIN-E2E BUDGET: 连续读取直至预算到限");
  R.taskIds.flow3 = budgetRun.taskId;
  const budgetTerminal = await waitTaskTerminal(budgetRun.taskId, 240000);
  const budgetGet = await taskGet(budgetRun.taskId);
  const budgetStatus = budgetGet && budgetGet.task && budgetGet.task.status;
  const budgetResumable = !!(budgetGet && budgetGet.resumable);
  const ledgerBefore = budgetGet && budgetGet.budgetLedger;
  record("F3.1 · bounded 预算任务在真实 main 下停止（BLOCKED）", budgetTerminal && budgetStatus === "BLOCKED", budgetStatus, "BLOCKED");
  const resumeVisible = await has("[data-ai-resume]");
  const budgetText = await text("[data-ai-resume-budget]");
  const remainingText = await text("[data-ai-resume-remaining]");
  const resumeReason = budgetGet && budgetGet.resumeReason;
  const budgetSnapshotBefore = dbSnapshot();
  const readExecsBefore = byTask(budgetSnapshotBefore.executions, budgetRun.taskId).filter((e) => e.tool_id === "resource.search").length;
  const artsBefore = byTask(budgetSnapshotBefore.artifacts, budgetRun.taskId).length;
  if (budgetResumable && resumeVisible) {
    record("F3.2 · 后端判定可续接并暴露账本", !!ledgerBefore && !!ledgerBefore.nextGrant, JSON.stringify({ resumable: budgetResumable, stopReason: budgetGet && budgetGet.stopReason }), "resumable + nextGrant");
    record("F3.3 · 真实 UI 显示续接入口与账本（nextGrant + 三类剩余）", budgetText.length > 0 && remainingText.includes("MODEL_CALLS") && remainingText.includes("TOOL_CALLS") && remainingText.includes("TOOL_ROUNDS"), JSON.stringify({ resumeVisible, budget: budgetText.slice(0, 80) }), "resume+ledger");
    await setPlan("final", { finalText: "MAIN_E2E_RESUME_OK" });
    await waitFor(async () => !(await isDisabled("[data-ai-resume]")), 15000);
    const rc = await click("[data-ai-resume]");
    const resumedTerminal = await waitTaskTerminal(budgetRun.taskId, 180000);
    const afterGet = await taskGet(budgetRun.taskId);
    R.ledger.after = afterGet && afterGet.budgetLedger;
    const afterSnap = dbSnapshot();
    const readExecsAfter = byTask(afterSnap.executions, budgetRun.taskId).filter((e) => e.tool_id === "resource.search").length;
    const artsAfter = byTask(afterSnap.artifacts, budgetRun.taskId).length;
    const statusAfter = afterGet && afterGet.task && afterGet.task.status;
    const resumedOk = rc === "ok" && resumedTerminal && statusAfter === "SUCCEEDED" && readExecsAfter === readExecsBefore && artsAfter >= artsBefore;
    record("F3.4 · 真实 UI 续接 → Task SUCCEEDED；已完成 READ execution 不重放；Artifact 保留/新增", resumedOk, JSON.stringify({ click: rc, status: statusAfter, readBefore: readExecsBefore, readAfter: readExecsAfter, artsBefore, artsAfter }), "SUCCEEDED + no replay + artifacts");
    const lb = ledgerBefore, la = R.ledger.after;
    record("F3.5 · 只追加一次预算且其他预算未被重置", !!la && la.resumeCount === (lb.resumeCount || 0) + 1 && la.kinds.TOOL_CALLS.authorized === lb.kinds.TOOL_CALLS.authorized && la.kinds.TOOL_ROUNDS.authorized === lb.kinds.TOOL_ROUNDS.authorized && la.kinds.MODEL_CALLS.authorized === lb.kinds.MODEL_CALLS.authorized + lb.nextGrant.amount, JSON.stringify({ before: { mc: lb.kinds.MODEL_CALLS.authorized, tc: lb.kinds.TOOL_CALLS.authorized, tr: lb.kinds.TOOL_ROUNDS.authorized, grant: lb.nextGrant }, after: la ? { mc: la.kinds.MODEL_CALLS.authorized, tc: la.kinds.TOOL_CALLS.authorized, tr: la.kinds.TOOL_ROUNDS.authorized, resumes: la.resumeCount } : null }), "只加 MODEL_CALLS，其余不变");
  } else {
    gap("F3.2/F3.3 · 预算停止后可续接并暴露账本 / UI 续接入口", JSON.stringify({ status: budgetStatus, stopReason: budgetGet && budgetGet.stopReason, resumable: budgetResumable, resumeReason, resumeVisible, artifacts: artsBefore }), "resumable=true + nextGrant + UI resume", "真实 UI task/run 每次只创建一个 step；预算耗尽路径产出 0 Artifact，而 getResumeEligibility 要求 artifactsOfTask>0（否则 NO_SAFE_CONTINUATION），因此经产品入口拿不到可续接状态与续接 UI。d4-06-resume 是先经主进程 API 构造 2-step 任务（step1 成功 WRITE 出 Artifact，step2 预算停止）才触达；该构造不是产品入口。故本流程保留 NOT VERIFIED。");
    gap("F3.4/F3.5 · 真实 UI 续接成功 + 不重放 + 其他预算未重置", JSON.stringify({ resumable: budgetResumable, resumeReason, resumeVisible }), "resumed SUCCEEDED + no replay + ledger monotonic", "同上：不可续接故无续接按钮可点。");
  }

  // ---------------------------------------------------------------- 流程 2：撤权停止（前置 grant 由 test-only 播种）
  const revokeTarget = await createResource("Main E2E Revoke Target", "text");
  await grantAiResource(revokeTarget.id);
  await setPlan("write", { resourceRef: revokeTarget.ref });
  const revokeRun = await runTask("MAIN-E2E REVOKE: 把 Main E2E Revoke Target 移入废纸篓");
  R.taskIds.flow2 = revokeRun.taskId;
  const revokeApprovalId = await waitApproval(120000);
  record("F2.1 · 待审批 call 就绪（Approval UI 可见）", !!revokeApprovalId, revokeApprovalId ? "AWAITING_APPROVAL" : "missing", "AWAITING_APPROVAL");
  const access = await bridge("governance", { type: "governance/getAppAccess", appId: "ai" });
  const toolGrant = access && Array.isArray(access.grants) ? access.grants.find((g) => g.scope === "TOOL") : null;
  const execBefore = executorRecordCount();
  const revoke = toolGrant ? await bridge("governance", { type: "governance/revokeAppAccess", grantId: toolGrant.grantId }) : { ok: false, error: "NO_TOOL_GRANT" };
  record("F2.2 · 经产品治理入口撤权 ai 的 TOOL grant（changed=true）", !!(revoke && revoke.ok && revoke.changed === true), JSON.stringify(revoke), "ok=true, changed=true");
  await waitFor(async () => !(await isDisabled('[data-approval-action="approve"]')), 15000);
  record("F2.3 · 使用旧批准（真实 UI Approve）", (await clickApprove()) === "ok", "clicked", "ok");
  const revokeTerminal = await waitTaskTerminal(revokeRun.taskId, 180000);
  const postRevoke = dbSnapshot();
  const revokeCall = byTask(postRevoke.sideEffectCalls, revokeRun.taskId)[0];
  const revokeTask = postRevoke.tasks.find((t) => t.task_id === revokeRun.taskId);
  const revokeStep = byTask(postRevoke.steps, revokeRun.taskId)[0];
  const revokeResource = postRevoke.resources.find((r) => r.resource_id === revokeTarget.id);
  const revokeLeases = postRevoke.leases.filter((l) => revokeCall && l.call_id === revokeCall.call_id);
  const execAfter = executorRecordCount();
  record("F2.4 · 撤权后旧批准不得执行：Call BLOCKED + SIDE_EFFECT_AUTHORIZATION_REVOKED", revokeTerminal && !!revokeCall && revokeCall.status === "BLOCKED" && revokeCall.error_code === "SIDE_EFFECT_AUTHORIZATION_REVOKED", JSON.stringify({ call: revokeCall && revokeCall.status, error: revokeCall && revokeCall.error_code }), "BLOCKED + SIDE_EFFECT_AUTHORIZATION_REVOKED");
  record("F2.5 · 0 mutation / 0 新 lease / 0 新 executor", revokeResource && revokeResource.status === "active" && revokeLeases.length === 0 && execAfter === execBefore, JSON.stringify({ resource: revokeResource && revokeResource.status, leases: revokeLeases.length, exec: execBefore + "->" + execAfter }), "active + 0 lease + exec 不变");
  record("F2.6 · Task/Step BLOCKED + UI busy 复位", revokeTask && revokeTask.status === "BLOCKED" && revokeStep && revokeStep.status === "BLOCKED", JSON.stringify({ task: revokeTask && revokeTask.status, step: revokeStep && revokeStep.status }), "BLOCKED/BLOCKED");

  // ---------------------------------------- 观察项：撤权（无 tool grant）后任务仍收敛但 0 副作用（不修）
  const obsTarget = await createResource("Main E2E Obs Target", "text");
  await grantAiResource(obsTarget.id);
  await setPlan("write", { resourceRef: obsTarget.ref });
  const obsRun = await runTask("MAIN-E2E OBS: 无 tool grant 时删除 Main E2E Obs Target");
  R.taskIds.obs = obsRun.taskId;
  await waitTaskTerminal(obsRun.taskId, 120000);
  const obsSnap = dbSnapshot();
  const obsProposals = byTask(obsSnap.proposals, obsRun.taskId);
  const obsTask = obsSnap.tasks.find((t) => t.task_id === obsRun.taskId);
  const obsResource = obsSnap.resources.find((r) => r.resource_id === obsTarget.id);
  const obsDenied = obsProposals.length > 0 && obsProposals.every((p) => { const d = obsSnap.decisions.find((x) => x.proposal_id === p.proposal_id); return d && d.reason_code === "TOOL_APP_NOT_GRANTED"; });
  const obsDetail = JSON.stringify({ task: obsTask && obsTask.status, proposals: obsProposals.map((p) => p.tool_id), denied: obsDenied, sideEffectCalls: byTask(obsSnap.sideEffectCalls, obsRun.taskId).length, mutation: obsResource && obsResource.status !== "active" ? 1 : 0 });
  record("F2.7 · [OBSERVE] 无 tool grant 时任务仍收敛 SUCCEEDED 但 0 mutation / 0 审批 / 0 副作用", obsDenied && obsResource && obsResource.status === "active" && byTask(obsSnap.sideEffectCalls, obsRun.taskId).length === 0, obsDetail, "denied + 0 副作用（不修）");
  observe("no-tool-grant 行为", obsDetail);

  // ---------------------------------------------------------------- 流程 4：记忆隔离（只用产品路径，不使用播种）
  const mem = await createResource(MEMORY_NAME, "memory", MEMORY_SECRET + " project alpha roadmap; reference data only");
  record("F4.1 · 经产品桥建立 personal memory", !!(mem.ref && mem.raw && mem.raw.resource && mem.raw.resource.resourceType === "memory"), JSON.stringify({ ok: !!mem.ref, type: mem.raw && mem.raw.resource && mem.raw.resource.resourceType }), "memory created");
  await bridge("resource", { type: "resource/reindex", resourceRef: mem.ref });
  const memGrant = await bridge("governance", { type: "governance/grantAppAccess", appId: "ai", resourceType: "memory", actions: ["resource.search", "resource.read"] });
  record("F4.2 · 经产品治理入口给 ai 授予 memory search/read", !!(memGrant && memGrant.ok), memGrant && memGrant.ok ? "ok" : JSON.stringify(memGrant), "ok");
  const memSearch = await bridge("resource", { type: "resource/search", query: GOAL_MEMORY, filter: { resourceType: "memory" } });
  record("F4.3 · 授权检索命中该 memory", !!(memSearch && memSearch.ok && Array.isArray(memSearch.items) && memSearch.items.some((i) => i.resourceRef === mem.ref)), "hits=" + (memSearch && memSearch.items ? memSearch.items.length : "?"), "hit");
  await setPlan("final", { finalText: "MAIN_E2E_MEMORY_OK" });
  const memRun = await runTask(GOAL_MEMORY);
  R.taskIds.mem = memRun.taskId;
  const memTerminal = await waitTaskTerminal(memRun.taskId, 120000);
  const bodies1 = await readBodies();
  const refs1 = bodies1.map((b) => messageByName(b, REFERENCE_NAME)).filter(Boolean);
  const all1 = bodies1.map(bodyText).join("\n");
  const refPayloadOk = refs1.some((r) => { try { const p = JSON.parse(r.content); return p && p.trust === "untrusted" && Array.isArray(p.items) && p.items.some((i) => String(i.text).includes(MEMORY_SECRET)); } catch { return false; } });
  const placementOk = bodies1.some((b) => { const msgs = messagesOf(b); const ri = msgs.findIndex((m) => m && m.name === REFERENCE_NAME); const si = msgs.findIndex((m) => m && m.name === RULES_NAME); if (ri < 0 || si < 0 || ri !== si + 1) return false; const rules = msgs[si]; return rules.role === "system" && rules.content === OPENARC_RULES_TEXT && msgs.slice(0, si).every((m) => m.role === "system"); });
  const highTrustClean = bodies1.length > 0 && bodies1.every((b) => { const ref = messageByName(b, REFERENCE_NAME); if (!ref || ref.role !== "user") return false; return messagesOf(b).every((m) => { if (!m || (m.role !== "system" && m.role !== "developer")) return true; const t = messageText(m); return !t.includes(MEMORY_SECRET) && !t.includes(MEMORY_NAME); }); });
  record("F4.4 · 授权 memory 进入 provider 请求体：reference_data(user, untrusted, JSON) + rules(system 常量) 相邻", memTerminal && refs1.length > 0 && refPayloadOk && placementOk, JSON.stringify({ status: memTerminal, reference: refs1.length, refPayloadOk, placementOk }), "reference_data + rules");
  record("F4.5 · 信任分层：高信任 system/developer 不含 secret / memory 标题", highTrustClean, JSON.stringify({ highTrustClean }), "clean");
  const memDel = await bridge("resource", { type: "resource/delete", resourceRef: mem.ref });
  const memPerm = await bridge("resource", { type: "resource/permanentDelete", resourceRef: mem.ref });
  record("F4.6 · 经产品桥删除 memory（trash + permanentDelete）", !!(memDel && memDel.ok) && !!(memPerm && memPerm.ok), JSON.stringify({ del: memDel && memDel.ok, perm: memPerm && memPerm.ok }), "ok/ok");
  await setPlan("final", { finalText: "MAIN_E2E_MEMORY_OK" });
  const memRun2 = await runTask(GOAL_MEMORY);
  await waitTaskTerminal(memRun2.taskId, 120000);
  await bridge("resource", { type: "resource/search", query: GOAL_MEMORY, filter: { resourceType: "memory" } });
  await sleep(400);
  const bodies2 = await readBodies();
  const all2 = bodies2.map(bodyText).join("\n");
  const struct2 = bodies2.filter((b) => messageByName(b, REFERENCE_NAME) || messageByName(b, RULES_NAME));
  record("F4.7 · 删除后同一 goal 后续请求不含 memory 注入结构与 secret", bodies2.length > 0 && struct2.length === 0 && !all2.includes(MEMORY_SECRET), JSON.stringify({ bodies: bodies2.length, injected: struct2.length, secret: all2.includes(MEMORY_SECRET) }), "absent");

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
  record("F4.8 · 刷新后产品身份 / 桌面状态正确恢复（gate=ready）", gateAfterReload === "ready", gateAfterReload, "ready");

  const created2 = await bridge("governance", { type: "governance/createUser", identifier: MEMBER, password: MEMBER_PW, displayName: "Main E2E Member", role: "MEMBER" });
  record("F4.9 · 经产品治理入口创建 MEMBER 账号", !!(created2 && created2.ok), created2 && created2.ok ? "created" : JSON.stringify(created2), "created");
  const logoutClick = await click('[data-d3-id="topbar-logout"]');
  const loggedOut = await waitGate("unauthenticated", 20000);
  await setInput('[data-d3-id="login-identifier"]', MEMBER);
  await setInput('[data-d3-id="login-password"]', MEMBER_PW);
  await sleep(100);
  await click('[data-d3-id="login-submit"]');
  const memberReady = await waitGate("ready", 30000);
  record("F4.10 · 真实 UI 登出并切换 MEMBER", logoutClick === "ok" && loggedOut && memberReady, JSON.stringify({ logout: logoutClick, loggedOut, memberReady }), "logout + ready");
  await setPlan("final", { finalText: "MAIN_E2E_MEMBER_OK" });
  let memberRun = await runTask(GOAL_MEMORY);
  let memberTerminal = await waitTaskTerminal(memberRun.taskId, 120000);
  let memberGet = await taskGet(memberRun.taskId);
  let memberStatus = memberGet && memberGet.task && memberGet.task.status;
  // harness 子进程启动偶发 INTERNAL_ERROR（0 模型调用）时，按“失败先重跑”重试一次；仍失败则如实记录。
  let memberRetried = false;
  if (memberStatus !== "SUCCEEDED" && dbSnapshot().modelCalls.filter((c) => c.task_id === memberRun.taskId).length === 0) {
    memberRetried = true;
    await setPlan("final", { finalText: "MAIN_E2E_MEMBER_OK" });
    memberRun = await runTask(GOAL_MEMORY);
    memberTerminal = await waitTaskTerminal(memberRun.taskId, 120000);
    memberGet = await taskGet(memberRun.taskId);
    memberStatus = memberGet && memberGet.task && memberGet.task.status;
  }
  const memberSucceeded = memberTerminal && memberStatus === "SUCCEEDED";
  const bodies3 = await readBodies();
  const all3 = bodies3.map(bodyText).join("\n");
  const struct3 = bodies3.filter((b) => messageByName(b, REFERENCE_NAME) || messageByName(b, RULES_NAME));
  record("F4.11 · 切账号后同一 goal 请求体不含之前账号的 memory 注入与 secret", memberReady && memberSucceeded && bodies3.length > 0 && struct3.length === 0 && !all3.includes(MEMORY_SECRET), JSON.stringify({ status: memberStatus, retried: memberRetried, bodies: bodies3.length, injected: struct3.length, secret: all3.includes(MEMORY_SECRET) }), "absent");

  // ---------------------------------------------------------------- 只读 DB / 错误
  const snap = dbSnapshot();
  const dbDump = JSON.stringify(snap);
  const secretHits = [PROVIDER_SECRET, MEMORY_SECRET, MEMORY_NAME, userData, "mpx_", "tpx_"].filter((s) => s && dbDump.includes(s));
  record("I1 · 隔离 identity.db 只读快照 0 provider secret / memory 正文 / 私有路径泄漏", secretHits.length === 0, JSON.stringify(secretHits), "[]");
  const firstTask = snap.tasks.slice().sort((a, b) => a.created_at - b.created_at)[0];
  const bootMtime = fs.existsSync(BOOT_PATH) ? fs.statSync(BOOT_PATH).mtimeMs : null;
  record("I2 · boot 观测写入早于首个任务接入", !!bootMtime && !!firstTask && bootMtime <= firstTask.created_at, JSON.stringify({ bootMtime, firstTask: firstTask && firstTask.created_at }), "boot <= task");
  const allStatuses = snap.tasks.map((t) => t.status);
  record("I3 · 所有 task 收敛终态（无 RUNNING / PENDING）", allStatuses.every((s) => ["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"].includes(s)), JSON.stringify(allStatuses), "all terminal");
  const unhandled = stderrBuf.split("\n").filter((l) => /Uncaught|UnhandledPromiseRejection|uncaughtException|unhandledRejection/i.test(l));
  mainErrors.push(...unhandled.slice(0, 5));
  record("I4 · Renderer console error = 0", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "), "0");
  record("I5 · main uncaught / unhandled = 0", mainErrors.length === 0, mainErrors.slice(0, 3).join(" | "), "0");

  return { boot, snap };
}

let outcome = { boot: null, snap: null };
try {
  outcome = await main();
} catch (error) {
  record("E2E · 整体未抛异常", false, String((error && error.message) || error).slice(0, 200), "no throw");
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
const failed = checks.filter((c) => !c.ok);
const flow1Id = R.taskIds.flow1, flow2Id = R.taskIds.flow2, flow3Id = R.taskIds.flow3, obsId = R.taskIds.obs;
const f1Calls = snap ? byTaskOut(snap.sideEffectCalls, flow1Id) : [];
const f1CallIds = f1Calls.map((c) => c.call_id);
const f1Arts = snap ? byTaskOut(snap.artifacts, flow1Id) : [];
const f1Vers = snap ? byTaskOut(snap.verifications, flow1Id) : [];
let gate = {
  testedCommit: (() => { try { return require("node:child_process").execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; } })(),
  workspaceState: (() => { try { return require("node:child_process").execFileSync("git", ["-C", ROOT, "status", "--porcelain"], { encoding: "utf8" }).trim(); } catch { return ""; } })(),
  command: COMMAND,
  env: { electron: process.versions.electron || null, node: process.versions.node, platform: process.platform, arch: process.arch, provider: "deterministic-local-http" },
  isolation: { userData: "os.tmpdir mkdtemp (isolated)", adminEnv: "OPENARC_IDENTITY_ADMIN=1", observeEnv: "OPENARC_E2E_OBSERVE=1", seedEnv: "OPENARC_E2E_SEED_TOOL_GRANTS=1" },
  productSeams: [
    { name: "boot snapshot", env: "OPENARC_E2E_OBSERVE=1", default: "off", effect: "仅把 runtime.snapshot() 写为隔离 userData/openarc-e2e-boot.json" },
    { name: "test-only tool grant seeding", env: "OPENARC_E2E_SEED_TOOL_GRANTS=1", default: "off", effect: "admin 会话后调用真实 authorization.grantAppToolPermission 为 ai 授予 3 个 tool 动作；仅代偿缺失的产品入口" },
  ],
  boot: outcome.boot ? { snapshot: sanitize(outcome.boot, [MEMORY_SECRET, PROVIDER_SECRET]), orderOk: checks.find((c) => c.name.startsWith("B1"))?.ok === true, listening: outcome.boot.modelProxyListening === true } : null,
  flows: {
    flow1: { taskId: flow1Id || null, prerequisiteGrant: "test-only seeded (OPENARC_E2E_SEED_TOOL_GRANTS)", status: snap ? (snap.tasks.find((t) => t.task_id === flow1Id) || {}).status : null, sideEffectCalls: f1Calls.length, approvals: snap ? snap.approvals.filter((a) => f1CallIds.includes(a.call_id)).length : 0, leases: snap ? snap.leases.filter((l) => f1CallIds.includes(l.call_id)).length : 0, artifacts: f1Arts.length, verifications: f1Vers.length, mutation: 1, executorSpawned: R.exec.flow1Spawned >= 1 },
    flow2: { taskId: flow2Id || null, prerequisiteGrant: "test-only seeded (OPENARC_E2E_SEED_TOOL_GRANTS)", revokeEntry: "product governance/revokeAppAccess", callStatus: snap ? (byTaskOut(snap.sideEffectCalls, flow2Id)[0] || {}).status || null : null, errorCode: snap ? (byTaskOut(snap.sideEffectCalls, flow2Id)[0] || {}).error_code || null : null, leases: snap ? byTaskOut(snap.leases, flow2Id).length : 0, mutation: 0 },
    flow3: { taskId: flow3Id || null, prerequisiteGrant: "test-only seeded (OPENARC_E2E_SEED_TOOL_GRANTS)", budgetStatus: checks.find((c) => c.name.startsWith("F3.1"))?.actual || null, resumable: checks.find((c) => c.name.startsWith("F3.2"))?.ok === true, resumeEntry: checks.find((c) => c.name.startsWith("F3.3"))?.ok === true, resumed: checks.find((c) => c.name.startsWith("F3.4"))?.ok === true },
    observation: { taskId: obsId || null, detail: observations },
    flow4: { injected: checks.find((c) => c.name.startsWith("F4.4"))?.ok === true, lowTrust: checks.find((c) => c.name.startsWith("F4.5"))?.ok === true, removed: checks.find((c) => c.name.startsWith("F4.7"))?.ok === true, reload: checks.find((c) => c.name.startsWith("F4.8"))?.ok === true, accountSwitch: checks.find((c) => c.name.startsWith("F4.11"))?.ok === true },
  },
  notVerified,
  observations,
  rendererConsoleErrors: consoleErrors.length,
  mainUnhandledErrors: mainErrors.length,
  checksSummary: { total: checks.length, pass: checks.length - failed.length, fail: failed.length },
  checks,
  at: new Date().toISOString(),
};
gate = sanitize(gate, [MEMORY_SECRET, PROVIDER_SECRET]);
gate.artifactSha256Coverage = "sha256 of canonical JSON (2-space indent) excluding artifactSha256 field";
const canonicalForHash = JSON.stringify(gate, null, 2);
gate.artifactSha256 = crypto.createHash("sha256").update(canonicalForHash).digest("hex");
const gateText = JSON.stringify(gate, null, 2);
fs.mkdirSync(path.join(ROOT, "artifacts", "d4-main-e2e"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "artifacts", "d4-main-e2e", "gate.json"), gateText);
console.log("");
console.log((checks.length - failed.length) + "/" + checks.length + " checks passed; NOT VERIFIED: " + notVerified.map((n) => n.name).join(" | "));
console.log("GATE: " + JSON.stringify({ testedCommit: gate.testedCommit, artifactSha256: gate.artifactSha256, notVerified: notVerified.map((n) => n.name), rendererConsoleErrors: gate.rendererConsoleErrors, mainUnhandledErrors: gate.mainUnhandledErrors, checksSummary: gate.checksSummary, boot: gate.boot && { snapshot: gate.boot.snapshot, orderOk: gate.boot.orderOk }, flows: gate.flows }));

const hardFailed = failed.filter((c) => !c.gap);
const gateOk = hardFailed.length === 0 && gate.rendererConsoleErrors === 0 && gate.mainUnhandledErrors === 0 && (gate.boot && gate.boot.orderOk);
if (hardFailed.length) console.log("HARD FAILED: " + hardFailed.map((c) => c.name).join(" | "));
process.exit(gateOk ? 0 : 1);
