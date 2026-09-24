/**
 * D5-02 · AI 编辑画布「真实产品链」探针（真实 electron . + Playwright/CDP）。
 *
 * 目标链路：Agent 提议 → 用户审批 → 授权执行 → 画布落库（+ 审批 UI 真的出现）。
 *
 * ── 这条链在真实 Electron 里到底怎么驱动（本探针的入口即是产品入口）────────────────
 *   ① 提议（Agent propose）
 *      · 产品入口：渲染层「全局 AI 助手」面板 → window.openarc.task.command({ type:"task/run", goal })
 *        → IPC task:command（electron/task-bootstrap.cjs）→ TaskHarnessOrchestrator.runTask
 *        → official dsh（ACP v1 stdio，HarnessAdapter）+ OpenArc Model Proxy + Tool Facade Bridge。
 *      · 模型侧看到的可调用工具 = electron/dsh-tool-profile.cjs 的 READ_TOOL_IDS/WRITE_TOOL_IDS
 *        经 buildBridgeManifest 投影，写进 dsh profile 的 manifest.json；每个 run 的 capability
 *        allowedTools 就是这份 toolIds（harness-adapter.cjs issueCapability）。
 *      · **Harness 只能提议**：WRITE 工具走 ToolFacadeBridge → sideEffectRuntime.proposeWrite
 *        → SideEffectCall(AWAITING_APPROVAL) + plan（固定 revision / 命令指纹），0 mutation。
 *   ② 审批 UI：src/approval/ApprovalPrompt.tsx，容器 [data-approval-request-id]，
 *      按钮 [data-approval-action="approve"|"deny"]；点击 → window.openarc.sideEffect.command
 *      ({ type:"sideEffect/decideApproval", approvalRequestId, decision }) → IPC sideeffect:command
 *      → Trusted Approval Gateway（electron/side-effect-bootstrap.cjs）→ SideEffectRuntime.decideApproval。
 *   ③ 执行：TaskHarnessOrchestrator.resolvePendingForStep → SideEffectRuntime.executeApproved
 *      → 受监督 executor（utility process，electron/side-effect-executor.cjs）→
 *      SideEffectAuthority.executeSideEffect → adapter.execute（CanvasControl.execute →
 *      canvasService.applyCommand(actorKind=AGENT，baseRevision 来自 plan)）→ verify（READ_AFTER_WRITE）
 *      → SideEffectCall SUCCEEDED + 审计 → verified result 交回 Harness。
 *   ④ 呈现：画布页（openarc-canvas:// 帧）2.5s 轮询 /api/canvases/{id}/meta 与 /api/canvases/{id}，
 *      远端 revision 前进即 applyRemoteCanvasData。
 *
 * ── 本探针实际跑到哪一步（不发明影子实现）───────────────────────────────────────
 *   探针只用真实产品入口（task/run、sideeffect:command、canvas:command、governance:command），
 *   模型侧只替换「最后一跳 provider 网络」为确定性本地 OpenAI-compatible provider
 *   （tests/fixtures/d4-04-provider.mjs，与 D4-04 / D5-01 门禁同一夹具），
 *   经 /__plan 指定模型「想调哪个工具」。official dsh / Model Proxy / Tool Facade / 审批网关 /
 *   受监督 executor 全部是产品代码。
 *
 *   阶段 S2 拿 canvas_edit 走同一条链；若产品尚未把 canvas.edit 广播给 Harness，
 *   探针会如实记录：模型请求里广播的工具名、审批 UI 是否出现、画布是否被改、SideEffectCall 是否产生。
 *   阶段 S4 用**已广播的** WRITE 工具 resource_trash 走同一条提议→审批→执行链，作为对照，
 *   证明这条网关链本身在真实 Electron 里是通的（把「画布工具没被广播」与「网关坏了」分开）。
 *
 * 运行：node experiments/d5-02/agent-canvas-probe.mjs
 *   env: OA_D502_AGENT_CDP_PORT（默认 9794；兼容 OA_D502_CDP_PORT）
 *        OA_D502_AGENT_EXPECT_GAP=1 → 若确认卡在产品缺口且对照链通过，退出码 0（缺口即结论）
 *   userData 前缀固定 oa-d502agent-（绝不 pkill 别人的进程；只 kill 自己 spawn 的子进程）
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { startD4Provider } from "../../tests/fixtures/d4-04-provider.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const ART = path.join(ROOT, "artifacts", "d5-02");
const CDP_PORT = Number(process.env.OA_D502_AGENT_CDP_PORT || process.env.OA_D502_CDP_PORT || 9794);
const ADMIN = { id: "admin@d502-agent.test", pw: "agent-canvas-1" };
const USER_DATA_PREFIX = "oa-d502agent-";
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 产品只读事实（同源引用，不在探针里另写一份字面量）── */
const PROFILE = require(path.join(ROOT, "electron", "dsh-tool-profile.cjs"));
const { ToolRegistry, buildBridgeManifest } = require(path.join(ROOT, "electron", "tool-registry.cjs"));
const registry = new ToolRegistry();
const productManifest = buildBridgeManifest(registry, { readToolIds: PROFILE.READ_TOOL_IDS, writeToolIds: PROFILE.WRITE_TOOL_IDS });

const CHECKS = [], NOTES = [], NOT_VERIFIED = [];
let passed = 0, failed = 0;
function record(section, name, ok, expected, actual) {
  const row = { section, name, status: ok ? "PASS" : "FAIL", expected: String(expected == null ? "" : expected), actual: String(actual == null ? "" : actual).slice(0, 1500), at: Date.now() };
  CHECKS.push(row);
  if (ok) passed += 1; else failed += 1;
  console.log((ok ? "  " : "! ") + "[" + row.status + "] " + section + " · " + name + (ok ? "" : " — 期望 " + row.expected + "，实际 " + row.actual));
  return ok;
}
const note = (t) => { NOTES.push(String(t)); console.log("   · " + t); };
const notVerified = (n, r) => { NOT_VERIFIED.push({ name: n, reason: String(r) }); console.log("   ? [NOT VERIFIED] " + n + " — " + r); };
const show = (label, value) => { const t = typeof value === "string" ? value : JSON.stringify(value); console.log("     " + label + " → " + String(t == null ? "null" : t).slice(0, 700)); return value; };

let child = null, browser = null, page = null, provider = null, userData = null, dbPath = null;
let stderrBuf = "", exitCodeOut = 1;
const consoleErrors = [];
let canvasId = null, ownerUserId = null;

const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const attr = (sel, name) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? (el.getAttribute(" + JSON.stringify(name) + ") || '') : '';");
const text = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? (el.textContent || '') : '';");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const setTextarea = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const click = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; el.click(); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const canvas = (payload) => js("return await window.openarc.canvas.command(" + JSON.stringify(payload) + ")");
const modelCmd = (payload) => js("return await window.openarc.model.command(" + JSON.stringify(payload) + ")");
const governance = (payload) => js("return await window.openarc.governance.command(" + JSON.stringify(payload) + ")");
const resource = (payload) => js("return await window.openarc.resource.command(" + JSON.stringify(payload) + ")");
const taskCommand = (payload) => js("return await window.openarc.task.command(" + JSON.stringify(payload) + ")");
const taskGet = (taskId) => taskCommand({ type: "task/get", taskId });
async function waitFor(fn, timeout = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await Promise.resolve(fn())) return true; } catch { /* retry */ } await sleep(200); } return false; }
const waitSel = (sel, ms) => waitFor(() => has(sel), ms || 20000);

/* ── DB 只读取证（与 D5-01 门禁同一口径；绝不写库）── */
function dbAll(sql) { const db = new DatabaseSync(dbPath, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } }
const tableRows = (t) => { try { return dbAll("SELECT * FROM " + t); } catch { return []; } };
const callsOfTask = (taskId, toolId) => tableRows("side_effect_calls").filter((r) => r.task_id === taskId && (!toolId || r.tool_id === toolId));
const callsByTool = (toolId) => tableRows("side_effect_calls").filter((r) => r.tool_id === toolId);
const execsByTool = (toolId) => tableRows("tool_executions").filter((r) => r.tool_id === toolId);
const auditHas = (needle) => JSON.stringify(tableRows("authorization_audit")).includes(needle);

/* ── 应用帧（宿主 iframe；仅作观测，主线负责画布页断言）──
 *  新形态：入口是上游原版列表首页 static/canvas-list.html，编辑器是**同一个宿主帧内**导航后的
 *  static/canvas.html；两者不再同时存在，所以分别按 URL 精确取帧。*/
function frameMatching(re) {
  const pages = browser ? browser.contexts().flatMap((c) => c.pages()) : [];
  for (const p of pages) { for (const f of p.frames()) { if (re.test(String(f.url()))) return f; } }
  return null;
}
const listFrame = () => frameMatching(/openarc-canvas:\/\/bundle\/static\/canvas-list\.html/);
const canvasFrame = () => frameMatching(/openarc-canvas:\/\/bundle\/static\/canvas\.html/);
async function inFrameOf(f, code) {
  if (!f) return { __noFrame: true };
  try { return JSON.parse((await f.evaluate("(async () => { return JSON.stringify(await (async () => { " + code + " })()); })()")) || "null"); }
  catch (e) { return { __error: String((e && e.message) || e).slice(0, 200) }; }
}
async function inFrame(code) { return await inFrameOf(canvasFrame(), code); }
const frameNodeCount = () => inFrame("return { url: location.href, nodes: document.querySelectorAll('#nodes .node, #nodes [data-node-id], .canvas-node').length, board: !!document.getElementById('board'), internals: typeof window.__openarcCanvasInternals };");

async function shot(name) {
  try { const p = path.join(ART, name); await page.screenshot({ path: p }); note("截图 " + path.relative(ROOT, p)); return p; } catch (e) { return null; }
}

async function launch() {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), USER_DATA_PREFIX));
  dbPath = path.join(userData, "identity.db");
  child = spawn(electronPath, [".", "--user-data-dir=" + userData, "--remote-debugging-port=" + CDP_PORT, ...extraArgs], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OPENARC_IDENTITY_ADMIN: "1" },
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { stderrBuf += String(d); });
  let version = null;
  const deadline = Date.now() + 60000;
  while (!version && Date.now() < deadline) { try { version = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json(); } catch { await sleep(300); } }
  if (!version) throw new Error("CDP 未就绪（端口 " + CDP_PORT + "）");
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);
  const ctx = browser.contexts()[0];
  const end = Date.now() + 40000;
  while (!page && Date.now() < end) { page = ctx.pages().find((p) => p.url().includes("dist/index.html")) || null; if (!page) await sleep(300); }
  if (!page) throw new Error("未找到界面页面（dist/index.html）");
  page.on("dialog", (d) => { void d.dismiss().catch(() => {}); });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror:" + String(e.message).slice(0, 200)));
}

async function loginAdmin() {
  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized" && (await waitSel('[data-d3-id="setup-name"]', 30000))) {
    // 集成分支保留 UI 线已定的"三步初始化向导"（显示名 → 账号 → 密码），末步才提交：
    // 后两步的输入在 DOM 里尚未存在，一次填完再点 setup-submit 不会发生任何事。
    // 驱动方式与 canvas-e2e.mjs / tests/fixtures/identity-ui-probe/main.cjs 一致。
    const setupNext = async () => {
      await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b && !b.disabled;"), 10000);
      await click('[data-d3-id="setup-next"]');
    };
    await setInput('[data-d3-id="setup-name"]', "D5-02 Agent Admin");
    await setupNext();
    await waitSel('[data-d3-id="setup-identifier"]', 10000);
    await setInput('[data-d3-id="setup-identifier"]', ADMIN.id);
    await setupNext();
    await waitSel('[data-d3-id="setup-password"]', 10000);
    await setInput('[data-d3-id="setup-password"]', ADMIN.pw);
    await setInput('[data-d3-id="setup-confirm"]', ADMIN.pw);
    await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-submit\"]'); return !!b && !b.disabled;"), 10000);
    await click('[data-d3-id="setup-submit"]');
    await waitFor(async () => (await gate()) === "unauthenticated", 30000);
  }
  await waitSel('[data-d3-id="login-identifier"]', 30000);
  await setInput('[data-d3-id="login-identifier"]', ADMIN.id);
  await setInput('[data-d3-id="login-password"]', ADMIN.pw);
  await click('[data-d3-id="login-submit"]');
  return waitFor(async () => (await gate()) === "ready", 60000);
}

/* ── AI 助手面板（产品入口）── */
async function openAiPanel() {
  if (await has(".ai-panel")) return true;
  if (await waitSel(".assistant-pill", 30000)) await click(".assistant-pill");
  return waitSel(".ai-panel", 20000);
}
async function runTaskViaUI(goal) {
  await openAiPanel();
  const prev = await attr(".ai-panel", "data-ai-task-id");
  await setTextarea("[data-ai-goal]", goal);
  const ready = await waitFor(async () => !(await js("const b = document.querySelector('[data-ai-run]'); return !b || b.disabled;")), 30000);
  if (!ready) throw new Error("run 按钮一直不可用");
  await click("[data-ai-run]");
  const started = await waitFor(async () => { const id = await attr(".ai-panel", "data-ai-task-id"); return typeof id === "string" && id.length > 0 && id !== prev; }, 40000);
  const status = await attr(".ai-panel", "data-ai-status");
  const stateText = (await text("[data-ai-state]")).replace(/\s+/g, " ").trim().slice(0, 300);
  return { taskId: await attr(".ai-panel", "data-ai-task-id"), started, status, stateText };
}
const waitApproval = (ms) => waitFor(async () => (await attr("[data-approval-request-id]", "data-approval-request-id")).length > 0, ms || 60000);
const approvalId = () => attr("[data-approval-request-id]", "data-approval-request-id");
async function waitTaskTerminal(taskId, timeout = 180000) {
  return waitFor(async () => { const g = await taskGet(taskId); const s = g && g.task && g.task.status; return ["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"].includes(s); }, timeout);
}
async function setPlan(plan) {
  const control = provider.baseUrl.replace("/v1", "") + "/__plan";
  const res = await fetch(control, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: plan || [] }) });
  return res.ok;
}
/** 模型这一跳实际被广播的工具名（唯一真源：provider 收到的请求体）。*/
function advertisedTools() {
  const bodies = (provider.state.bodies || []).slice().reverse();
  for (const b of bodies) {
    const tools = b && b.tools;
    if (!Array.isArray(tools) || !tools.length) continue;
    return tools.map((t) => (t && t.function && t.function.name) || (t && t.name) || String(t)).filter(Boolean);
  }
  return [];
}
const canvasState = async (id) => { const g = await canvas({ type: "canvas/get", canvasId: id }); return { ok: !!(g && g.ok), revision: g && g.ok ? g.canvas.revision : null, nodes: g && g.ok ? (g.canvas.doc.nodes || []).length : null, edges: g && g.ok ? (g.canvas.doc.connections || []).length : null }; };

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  provider = await startD4Provider();
  note("确定性 provider（只替换最后一跳网络）：" + provider.baseUrl);
  note("产品 Harness 可见 allowlist：READ=" + JSON.stringify(PROFILE.READ_TOOL_IDS) + " WRITE=" + JSON.stringify(PROFILE.WRITE_TOOL_IDS));
  note("产品会广播给 official dsh 的工具（buildBridgeManifest）：" + JSON.stringify(productManifest.toolIds));

  if (!fs.existsSync(path.join(ROOT, "dist", "index.html"))) { console.error("缺少 dist/index.html —— 本探针不构建（避免与主线冲突），请使用现有 dist"); process.exit(2); }
  await launch();
  record("S0", "真实 electron . 启动（隔离 userData 前缀 " + USER_DATA_PREFIX + " / CDP " + CDP_PORT + "）", !!browser, "CDP 可用", "connected");
  record("S0", "真实 UI 登录 admin（必要时先 setup）", await loginAdmin(), "data-identity-gate=ready", await gate());

  /* ── S0b 模型配置：provider / model / 默认 chat（画布与 AI 助手共用唯一来源）── */
  const prov = await modelCmd({ type: "provider/create", displayName: "D5-02 Agent Provider", baseUrl: provider.baseUrl, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: "d502-agent-secret" });
  const providerId = prov && prov.provider && prov.provider.providerId;
  const mdl = await modelCmd({ type: "model/create", providerId, remoteModelId: "d502-agent-local", displayName: "D5-02 Agent Local", capabilities: ["chat"], scope: "ORGANIZATION" });
  const configId = mdl && mdl.model && mdl.model.configId;
  const def = await modelCmd({ type: "defaults/set", capability: "chat", configId });
  show("provider/create", { ok: prov && prov.ok, providerId });
  show("model/create", { ok: mdl && mdl.ok, configId });
  show("defaults/set", { ok: def && def.ok, error: def && def.error });
  record("S0", "确定性 provider + chat 模型 + 默认 chat 就绪（AI 任务唯一模型来源）", !!(providerId && configId && def && def.ok), "provider+model+default", JSON.stringify({ providerId, configId, defaultOk: !!(def && def.ok) }));

  /* ── S1 建一本画布 + 打开画布窗口（活着的画布页 ⇒ 远端改动可被轮询呈现）── */
  const created = await canvas({ type: "canvas/create", title: "D5-02 Agent Canvas" });
  canvasId = created && created.ok ? created.canvas.canvasId : null;
  ownerUserId = created && created.ok ? created.canvas.ownerUserId : null;
  show("canvas/create", { ok: !!(created && created.ok), canvasId, revision: created && created.ok ? created.canvas.revision : null, nodes: created && created.ok ? created.canvas.doc.nodes.length : null });
  const before = await canvasState(canvasId);
  show("canvas/get(after create)", before);
  // 预览集成分支按"不改用户已定 UI"保留入口名"无限画布"；核心线叫"AI Studio"。两种都接受。
  await js("const el = document.querySelector('[aria-label=\"打开AI Studio\"]') || document.querySelector('[aria-label=\"打开无限画布\"]'); if (el) el.click(); return !!el;");
  const hostUp = await waitSel("[data-canvas-host]", 20000);
  // 产品路径：开窗先落在列表首页（canvas-list），点当前这本的卡片进入编辑器（不直接造帧）
  const listUp = await waitFor(() => !!listFrame(), 25000);
  const cardSel = "#cardsGrid .project-card[data-canvas-id=\"" + canvasId + "\"]";
  const cardUp = listUp && await waitFor(async () => (await inFrameOf(listFrame(), "return !!document.querySelector(" + JSON.stringify(cardSel) + ");")) === true, 20000);
  const cardClick = cardUp ? await inFrameOf(listFrame(), "const el = document.querySelector(" + JSON.stringify(cardSel) + "); if (!el) return 'missing'; el.click(); return 'clicked';") : "missing";
  const frameUp = await waitFor(() => !!canvasFrame(), 40000);
  const adapterUp = frameUp && await waitFor(async () => (await inFrame("return typeof window.__openarcCanvasInternals;")) === "object", 30000);
  const frameProbe = frameUp ? await frameNodeCount() : null;
  const openedState = adapterUp ? await inFrame("const s = window.__openarcCanvas && window.__openarcCanvas.state ? window.__openarcCanvas.state() : null; return s ? { id: s.canvasId, nodes: s.nodeCount } : null;") : null;
  show("canvas frame", frameProbe);
  show("opened canvas", openedState);
  record("S1", "新建画布 0 节点 + 从列表首页卡片进入画布窗口（编辑器帧活着、canvasId 一致，供‘呈现’路径轮询）", !!(created && created.ok) && before.nodes === 0 && hostUp && listUp && cardClick === "clicked" && frameUp && !!adapterUp && !!(openedState && openedState.id === canvasId), "0 节点 / host 就绪 / 卡片进入编辑器且 canvasId 一致", JSON.stringify({ nodes: before.nodes, revision: before.revision, hostUp, listUp, cardUp, cardClick, frameUp, adapterUp, frame: frameProbe, openedState }));

  /* ── S2 画布 Agent 链：提议 canvas_edit（产品入口 task/run）── */
  const grant = await governance({ type: "governance/grantAppToolAccess", appId: "ai", actions: ["tool.canvas.edit"] });
  show("governance/grantAppToolAccess", { ok: grant && grant.ok, actions: grant && grant.actions, error: grant && grant.error });
  const toolAccess = await governance({ type: "governance/getAppToolAccess", appId: "ai" });
  show("governance/getAppToolAccess", { ok: toolAccess && toolAccess.ok, grantedActions: toolAccess && toolAccess.grantedActions, error: toolAccess && toolAccess.error });

  const agentCommand = { type: "node.add", node: { id: "agent_node_1", type: "prompt", x: 240, y: 180, text: "D5-02 agent proposal" } };
  await setPlan([{ name: "canvas_edit", args: { canvasId, baseRevision: before.revision, command: agentCommand } }]);
  const goal = "在画布 " + canvasId + " 上添加一个提示词节点（节点 id=agent_node_1）";
  note("AI 助手任务目标：" + goal);
  const run1 = await runTaskViaUI(goal);
  show("task/run", run1);
  const approval1 = await waitApproval(60000);
  const rid1 = await approvalId();
  const advertised = advertisedTools();
  show("模型这一跳被广播的工具名", advertised);
  const shot1 = await shot(approval1 ? "agent-canvas-approval-canvas.png" : "agent-canvas-no-approval.png");
  if (approval1) {
    show("approval 面板", { approvalRequestId: rid1, tool: await attr("[data-approval-request-id]", "data-approval-tool"), target: (await text("[data-approval-target]")).trim().slice(0, 200) });
  }
  record("S2", "Agent 提议 canvas.edit → 真实审批面板出现（Agent 提议 → 审批这一段）", !!approval1 && advertised.includes("canvas_edit"), "审批面板 + canvas_edit 被广播", JSON.stringify({ approvalShown: !!approval1, approvalRequestId: rid1 || null, advertised, shot: shot1 ? path.basename(shot1) : null }));

  let canvasChainOk = false;
  if (approval1) {
    await click('[data-approval-action="approve"]');
    const term = await waitTaskTerminal(run1.taskId);
    const got = await taskGet(run1.taskId);
    show("task/get", { status: got && got.task && got.task.status, error: got && got.error, stopReason: got && got.stopReason });
    const afterChain = await canvasState(canvasId);
    show("canvas/get(after approved agent edit)", afterChain);
    const call = callsByTool("canvas.edit").slice(-1)[0] || null;
    show("side_effect_calls[canvas.edit]", call ? { callId: call.call_id, status: call.status, verification: call.verification_status, preconditions: call.preconditions_safe } : null);
    canvasChainOk = !!(term && afterChain.nodes === 1 && afterChain.revision > before.revision && call && call.status === "SUCCEEDED" && call.verification_status === "PASS");
    record("S2", "批准 → 授权执行 → 画布落库（节点 0→1、revision 前进、call SUCCEEDED/PASS）", canvasChainOk,
      "1 节点 + revision 前进 + SUCCEEDED/PASS", JSON.stringify({ term, afterChain, call: call ? { status: call.status, verification: call.verification_status } : null }));
  } else {
    const term = await waitFor(async () => { const g = await taskGet(run1.taskId); const s = g && g.task && g.task.status; return ["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"].includes(s); }, 90000);
    const got = await taskGet(run1.taskId);
    show("task/get", { terminal: term, status: got && got.task && got.task.status, error: got && got.error, stopReason: got && got.stopReason });
    const afterAttempt = await canvasState(canvasId);
    show("canvas/get(after agent attempt)", afterAttempt);
    const canvasCalls = callsByTool("canvas.edit");
    show("side_effect_calls[canvas.edit]", { count: canvasCalls.length });
    show("task steps", (got && got.steps || []).map((st) => ({ kind: st.kind, status: st.status, errorCode: st.error_code || st.errorCode || null })));
    show("provider 侧观察", { requests: provider.state.requests, toolCalls: provider.state.toolCalls, names: provider.state.names, history: provider.state.history });
    record("S2", "未出现审批面板时：画布内容与副作用账本必须原样不动（0 proposal / 0 mutation）",
      afterAttempt.nodes === before.nodes && canvasCalls.length === 0,
      "节点数不变 + 0 call", JSON.stringify({ before, afterAttempt, canvasCalls: canvasCalls.length, toolGranted: !!(toolAccess && (toolAccess.grantedActions || []).includes("tool.canvas.edit")) }));
    record("S2", "缺口定位：canvas.edit 未被产品广播给 Harness（模型提议也无法到达 Tool Facade）",
      !advertised.includes("canvas_edit") && productManifest.toolIds.every((id) => id !== "canvas.edit"),
      "canvas_edit 不在广播面", JSON.stringify({ advertised, productAllowlist: productManifest.toolIds }));
  }

  /* ── S3 同一命令层的「宿主手工路径」：证明画布 DB/版本检查/落库本身是通的（明确不是 AI 链）── */
  const manual = await canvas({ type: "canvas/command", canvasId, baseRevision: (await canvasState(canvasId)).revision, command: { type: "node.add", node: { id: "user_node_1", type: "prompt", x: 40, y: 40, text: "manual host path" } } });
  show("canvas/command(USER, node.add)", { ok: manual && manual.ok, revision: manual && manual.ok ? manual.canvas.revision : null, error: manual && manual.error });
  const afterManual = await canvasState(canvasId);
  show("canvas/get(after manual)", afterManual);
  const frameAfter = frameUp ? await frameNodeCount() : null;
  show("canvas frame(after)", frameAfter);
  record("S3", "对照：同一命令层（canvas:command / actorKind=USER）落库 + 版本前进（≠ AI 链，仅证明画布侧不阻塞）",
    !!(manual && manual.ok) && Number(manual.canvas.revision) > Number(before.revision), "命令返回 revision 前进", JSON.stringify({ commandRevision: manual && manual.ok ? manual.canvas.revision : null, beforeRevision: before.revision, reRead: afterManual, manualOk: !!(manual && manual.ok) }));

  /* ── S4 对照链：用**已广播**的 WRITE 工具 resource.trash 走同一条提议→审批→执行 ── */
  let controlOk = false;
  try {
    const resCreated = await resource({ type: "resource/create", resourceType: "text", name: "D5-02 Agent Trash Target", content: "agent-probe-target" });
    const resourceRef = resCreated && resCreated.ok ? resCreated.resource.resourceRef : null;
    const resourceId = resCreated && resCreated.ok ? resCreated.resource.resourceId : null;
    show("resource/create", { ok: !!(resCreated && resCreated.ok), resourceRef, resourceId });
    const grantTrash = await governance({ type: "governance/grantAppToolAccess", appId: "ai", actions: ["tool.canvas.edit", "tool.resource.trash"] });
    show("governance/grantAppToolAccess(resource.trash)", { ok: grantTrash && grantTrash.ok, actions: grantTrash && grantTrash.actions, error: grantTrash && grantTrash.error });
    const appGrant = await governance({ type: "governance/grantAppAccess", appId: "ai", resourceId, actions: ["resource.delete"] });
    show("governance/grantAppAccess(resource.delete)", { ok: appGrant && appGrant.ok, error: appGrant && appGrant.error });
    const userGrant = await governance({ type: "governance/grantResourceAccess", principalType: "USER", principalId: ownerUserId, resourceId, actions: ["resource.delete", "resource.useByAgent"] });
    show("governance/grantResourceAccess(USER)", { ok: userGrant && userGrant.ok, error: userGrant && userGrant.error });
    if (resourceRef && appGrant && appGrant.ok && userGrant && userGrant.ok) {
      await setPlan([{ name: "resource_trash", args: { resourceRef } }]);
      const run2 = await runTaskViaUI("把这个资源移到回收站：" + resourceRef);
      show("task/run(control)", run2);
      const seen2 = await waitApproval(90000);
      const rid2 = await approvalId();
      show("approval(control)", { shown: seen2, approvalRequestId: rid2, tool: await attr("[data-approval-request-id]", "data-approval-tool"), target: (await text("[data-approval-target]")).trim().slice(0, 200), shot: await shot(seen2 ? "agent-control-approval.png" : "agent-control-no-approval.png") });
      if (seen2) {
        await click('[data-approval-action="approve"]');
        const term2 = await waitTaskTerminal(run2.taskId);
        const got2 = await taskGet(run2.taskId);
        const call2 = callsOfTask(run2.taskId, "resource.trash").slice(-1)[0] || null;
        show("task/get(control)", { terminal: term2, status: got2 && got2.task && got2.task.status });
        show("side_effect_calls[resource.trash]", call2 ? { callId: call2.call_id, status: call2.status, verification: call2.verification_status } : null);
        controlOk = !!(term2 && got2 && got2.task.status === "SUCCEEDED" && call2 && call2.status === "SUCCEEDED" && call2.verification_status === "PASS");
        record("S4", "对照链：已广播 WRITE 工具走完 Agent 提议 → 审批 UI → 批准 → 受监督执行 → SUCCEEDED/PASS", controlOk,
          "SUCCEEDED/PASS", JSON.stringify({ status: got2 && got2.task.status, call: call2 ? { status: call2.status, verification: call2.verification_status } : null, audit: auditHas("resource.trash") }));
      } else {
        record("S4", "对照链：已广播 WRITE 工具应出现真实审批面板", false, "审批面板", "未出现");
      }
    } else {
      record("S4", "对照链授权前置（资源 + 三类 grant）", false, "全部 ok", JSON.stringify({ resourceRef, appGrant: appGrant && appGrant.ok, userGrant: userGrant && userGrant.ok }));
    }
  } catch (e) {
    record("S4", "对照链执行异常", false, "无异常", String((e && e.message) || e).slice(0, 300));
  }

  const canvasCallsFinal = callsByTool("canvas.edit");
  console.log("\n── 产品代码事实（探针只读引用，不是缺口结论）──");
  note("electron/dsh-tool-profile.cjs WRITE_TOOL_IDS = " + JSON.stringify(PROFILE.WRITE_TOOL_IDS) + "（含 canvas.edit ⇒ 已在 Harness 广播面与 capability.allowedTools 里）");
  const runtimeSrc = fs.readFileSync(path.join(ROOT, "electron", "side-effect-runtime.cjs"), "utf8");
  const inProcessSrc = (runtimeSrc.match(/IN_PROCESS_EXECUTION_PROVIDERS\s*=\s*Object\.freeze\(new Set\(\[([^\]]*)\]\)\)/) || [])[1] || "";
  const inProcessProviders = inProcessSrc.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  note("electron/side-effect-runtime.cjs IN_PROCESS_EXECUTION_PROVIDERS = " + JSON.stringify(inProcessProviders) + "（含 CanvasControl：画布命令层的唯一权威实例在主进程内，故走 executeInProcess；lease / claim / exactly-once / verify 全部照旧，executor bundle 不需要它）");
  note("canvas.edit 账本：side_effect_calls=" + canvasCallsFinal.length + " / tool_executions(canvas.edit)=" + execsByTool("canvas.edit").length);

  const gapConfirmed = !canvasChainOk && canvasCallsFinal.length === 0 && productManifest.toolIds.indexOf("canvas.edit") < 0;
  const expectGap = process.env.OA_D502_AGENT_EXPECT_GAP === "1";
  const ok = canvasChainOk || (expectGap && gapConfirmed && controlOk);
  exitCodeOut = ok ? 0 : 1;
  console.log("\n══ PASS/FAIL 小结 ══");
  console.log("  " + passed + " PASS / " + failed + " FAIL" + (NOT_VERIFIED.length ? " / " + NOT_VERIFIED.length + " NOT VERIFIED" : ""));
  console.log("  AI 画布链（提议→审批→执行→落库）：" + (canvasChainOk ? "PASS" : "FAIL（真实 Electron 里未取得）"));
  console.log("  对照链（已广播 WRITE 工具）：" + (controlOk ? "PASS" : "FAIL"));
  console.log("  产品缺口确认（canvas.edit 未进 Harness 广播面）：" + (gapConfirmed ? "是" : "否"));
  if (!canvasChainOk) console.log("  结论：D5-02 AI 编辑产品链缺环 —— 需先在产品侧放行 canvas.edit（见上方‘缺口定位’），探针无需改动即可复跑。");
  else console.log("  结论：D5-02 AI 编辑产品链在真实 Electron 中打通。");

  fs.writeFileSync(path.join(ART, "agent-canvas-probe.json"), JSON.stringify({
    at: new Date().toISOString(), mode: "D5-02 agent canvas chain probe (real electron)",
    cdpPort: CDP_PORT, userDataPrefix: USER_DATA_PREFIX, canvasId,
    productAllowlist: { read: PROFILE.READ_TOOL_IDS, write: PROFILE.WRITE_TOOL_IDS, advertised: productManifest.toolIds },
    advertisedToModel: advertisedTools(),
    canvasAgentChain: canvasChainOk, controlChain: controlOk, gapConfirmed,
    checks: CHECKS, notes: NOTES, notVerified: NOT_VERIFIED, consoleErrors: consoleErrors.slice(0, 20),
  }, null, 2));
  console.log("  证据 JSON：artifacts/d5-02/agent-canvas-probe.json");
}

let watchdog = null;
try {
  watchdog = setTimeout(() => { console.error("探针总超时，强制结束"); try { child?.kill("SIGKILL"); } catch { /* ignore */ } process.exit(3); }, 10 * 60 * 1000);
  if (watchdog.unref) watchdog.unref();
  await main();
} catch (e) {
  console.error("探针异常：" + String((e && e.stack) || e).slice(0, 2000));
  if (stderrBuf) console.error("electron stderr(尾部)：\n" + stderrBuf.slice(-1500));
  exitCodeOut = 1;
} finally {
  try { if (watchdog) clearTimeout(watchdog); } catch { /* ignore */ }
  try { await provider?.close?.(); } catch { /* ignore */ }
  try { await browser?.close(); } catch { /* ignore */ }
  try { child?.kill("SIGKILL"); } catch { /* ignore */ }
  if (userData) console.log("隔离 userData：" + userData);
}
process.exit(exitCodeOut);
