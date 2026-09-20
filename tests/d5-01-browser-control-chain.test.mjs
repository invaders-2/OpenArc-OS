/**
 * D5-01 Closure-2 · 受控浏览器能力**产品工具链**测试（不是服务层单测）。
 *
 * 真实链路（与 production 同一段装配）：
 *   OpenArc Task/Step/run → official @deepseek-ai/dsh（ACP v1）→ Tool Facade
 *     READ：ControlledToolProxy.propose → executeReadOnly → adapter(BrowserControl) → BrowserControlAuthority
 *     WRITE：SIDE_EFFECT_PROPOSAL → SideEffectPlan(AWAITING_APPROVAL) → **trusted 用户批准**
 *            → lease → claim → adapter.execute → READ_AFTER_WRITE verify → safe result → dsh 继续
 *
 * 永久：Harness proposes. OpenArc decides / executes / verifies.
 * 目标一律来自**用户显式授权**的控制目标；模型给的 viewId 只是请求，越权访问 0 次真实读取。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const require = createRequire(import.meta.url);
const { BrowserControlAuthority } = require("../electron/browser-control-authority.cjs");
const { WRITE_TOOL_IDS } = require("../electron/dsh-tool-profile.cjs");

const USER_VIEW = "browser#t1";
const OTHER_VIEW = "browser#t2";
const SITE = "http://127.0.0.1:5391";
const PAGE_TEXT = "OPENARC-PAGE-TEXT-" + "x".repeat(5000);
const PAGE2 = SITE + "/page2";
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t && t.unref) t.unref(); });
const waitFor = async (fn, ms, detail = "") => { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (await Promise.resolve(fn())) return true; await sleep(25); } assert.fail("waitFor 超时：" + detail); };

/** 假原生控制器：只实现受控浏览器能力真正用到的方法，并记录每一次真实动作。 */
function fakeController() {
  const state = {
    entries: [
      { viewId: USER_VIEW, windowId: "browser", tabId: "t1", url: SITE + "/form", title: "FORM", sessionKey: "usr_admin", alive: true },
      { viewId: OTHER_VIEW, windowId: "browser", tabId: "t2", url: SITE + "/page3", title: "P3", sessionKey: "usr_admin", alive: true },
    ],
    reads: 0,
    navigations: [],
  };
  return {
    state,
    inventory: () => state.entries.filter((e) => e.alive),
    ownerOfView: (viewId) => state.entries.find((e) => e.viewId === viewId && e.alive) || null,
    readText: async () => { state.reads += 1; return PAGE_TEXT; },
    liveUrl: (viewId) => { const e = state.entries.find((x) => x.viewId === viewId); return e && e.alive ? e.url : null; },
    navigate: (windowId, url, tabId) => {
      state.navigations.push({ windowId, url, tabId });
      const e = state.entries.find((x) => x.viewId === windowId + "#" + tabId);
      if (e) e.url = url;
      return { ok: true };
    },
    waitForCommit: async (viewId) => {
      const e = state.entries.find((x) => x.viewId === viewId);
      if (!e || !e.alive) return { ok: false, error: "BROWSER_CONTROL_TARGET_GONE" };
      return { ok: true, url: e.url, noop: false };
    },
  };
}

async function setup({ selectTargets = [USER_VIEW], tools = ["tool.browser.read", "tool.browser.navigate"] } = {}) {
  const controller = fakeController();
  const audits = [];
  const browserControl = new BrowserControlAuthority({ audit: (r) => audits.push(r) });
  browserControl.attachController(controller);
  const fx = await createToolHarnessFixture({
    withAdapters: true, behavior: "tool-loop", browserControl,
    facadeWriteToolIds: WRITE_TOOL_IDS, sideEffectApprovalWaitMs: 60000,
  });
  // 装配后半段若失败，也必须关掉夹具（否则残留 provider/supervisor 会把测试进程挂住）。
  try {
    return await finishSetup({ fx, controller, audits, browserControl, selectTargets, tools });
  } catch (e) {
    try { await fx.close(); } catch { /* ignore */ }
    throw e;
  }
}

async function finishSetup({ fx, controller, audits, browserControl, selectTargets, tools }) {
  // 分区归属必须是**真实登录用户 id**（同一 AuthorizationService 解析，主机不给假 userId 开后门）。
  const actor = fx.f.authService.resolveActor({ context: { sessionRef: fx.f.sessions.admin, appId: "ai", source: "test" } });
  assert.equal(actor.ok, true, "夹具管理员会话必须可解析");
  const userId = String(actor.user.id);
  for (const e of controller.state.entries) e.sessionKey = userId;
  browserControl.setSession(userId);
  for (const viewId of selectTargets) {
    const [windowId, tabId] = viewId.split("#");
    const r = browserControl.select({ context: { source: "user" }, userId, windowId, tabId });
    assert.equal(r.ok, true, "选择目标必须成功：" + JSON.stringify(r));
  }
  fx.grantTool("ai", tools);
  const ctx = fx.ctx();
  const t = fx.createTask();
  const orch = fx.makeDshOrchestrator();
  return { fx, controller, audits, browserControl, ctx, task: t.task, orch, userId };
}
const userCtx = (s) => ({ sessionRef: s.fx.f.sessions.admin, source: "user" });
const run = (s, plan) => {
  s.fx.fp.state.toolLoopPlan = plan;
  return s.orch.runTask({ context: s.ctx, taskId: s.task.taskId, expectedRevision: s.task.revision, verify: { type: "EXACT_TEXT", expected: "OPENARC_DSH_TOOL_OK" } });
};
const auditText = (s) => JSON.stringify(s.fx.f.identity.connection.prepare("SELECT * FROM authorization_audit").all());

test("READ 链：工具门 → 真实受控读取 → 有界 untrusted 正文回 dsh → 审计与日志零正文", async () => {
  const s = await setup();
  try {
    const r = await run(s, [{ id: "call_read_1", name: "browser_read_page", args: { viewId: USER_VIEW } }]);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.task.status, "SUCCEEDED");

    const execs = s.fx.toolStore.executionsOfTask(s.task.taskId);
    assert.equal(execs.length, 1, "恰好 1 次真实执行");
    assert.equal(execs[0].tool_id, "browser.read.page");
    assert.equal(execs[0].status, "SUCCEEDED");
    assert.equal(execs[0].verification_status, "PASS");
    assert.equal(s.controller.state.reads, 1, "真实读取恰好 1 次");
    assert.equal(s.controller.state.navigations.length, 0, "读取绝不触发导航");

    // 正文按上限进入**不可信**结果（4000 字符 ≠ 去敏：它是不可信参考数据）。
    const bodies = s.fx.fp.state.toolLoopBodies.join("\n");
    assert.ok(bodies.includes("OPENARC-PAGE-TEXT-"), "模型必须拿到真实页面正文（作为 tool result）");
    assert.ok(bodies.includes("untrusted"), "正文必须带 untrusted 标记");
    const lastBody = JSON.parse(String(s.fx.fp.state.toolLoopBodies[s.fx.fp.state.toolLoopBodies.length - 1] || "{}"));
    const highTrust = (lastBody.messages || []).filter((m) => m && (m.role === "system" || m.role === "developer"));
    assert.equal(JSON.stringify(highTrust).includes("OPENARC-PAGE-TEXT-"), false, "页面正文绝不得进入 system/developer 高信任消息");

    // 审计：有工具执行与浏览器读取两条 ALLOW，但**没有正文**。
    const audit = auditText(s);
    assert.ok(audit.includes("browser.read.page"), "审计必须记录工具");
    assert.ok(s.audits.some((a) => a.action === "browser.read_page" && a.decision === "ALLOW"), "浏览器读取必须落审计");
    assert.equal(audit.includes("OPENARC-PAGE-TEXT-"), false, "审计绝不得包含页面正文");
  } finally { await s.fx.close(); }
});

test("READ 越权：模型自报未授权 viewId → 0 次真实读取、execution FAILED、任务不成功", async () => {
  const s = await setup();
  try {
    const r = await run(s, [{ id: "call_read_evil", name: "browser_read_page", args: { viewId: OTHER_VIEW } }]);
    // 注意：任务终态由模型自己的收尾决定（工具失败会作为错误结果回给模型），
    // 所以"任务是否 SUCCEEDED"不是安全判据 —— 判据是**真实执行**与**真实读取**。
    void r;
    assert.equal(s.controller.state.reads, 0, "未授权目标绝不得被读取");
    const execs = s.fx.toolStore.executionsOfTask(s.task.taskId);
    assert.equal(execs.length, 1);
    assert.equal(execs[0].status, "FAILED");
    assert.equal(execs[0].error_code, "BROWSER_CONTROL_NOT_SELECTED");
    assert.equal(JSON.stringify(s.fx.fp.state.toolLoopBodies).includes("OPENARC-PAGE-TEXT-"), false, "失败时绝不得泄漏正文");
  } finally { await s.fx.close(); }
});

test("WRITE 链：导航 propose → 用户审批（绑定目标+地址）→ lease → claim → 真实导航 → READ_AFTER_WRITE PASS", async () => {
  const s = await setup();
  try {
    const running = run(s, [{ id: "call_nav_1", name: "browser_navigate", args: { viewId: USER_VIEW, url: PAGE2 } }]);
    await waitFor(() => s.fx.sideEffectStore.callsOfTask(s.task.taskId).length === 1, 60000, "SideEffectCall 未出现");
    const call = s.fx.sideEffectStore.callsOfTask(s.task.taskId)[0];
    assert.equal(call.toolId, "browser.navigate");
    assert.equal(call.status, "AWAITING_APPROVAL");
    assert.equal(call.effectClass, "REVERSIBLE_WRITE");
    // 批准前：0 导航 / 0 lease / 0 execution。
    assert.equal(s.controller.state.navigations.length, 0, "未批准前绝不得导航");
    assert.equal(s.fx.sideEffectStore.leasesOfCall(call.callId).length, 0);
    assert.equal(s.fx.toolStore.executionsOfTask(s.task.taskId).length, 0);
    // 批准绑定的就是**这个目标 + 这个地址**（approval 投影里必须看得见）。
    assert.equal(call.preconditionsSafe.targetRef, USER_VIEW);
    assert.equal(call.preconditionsSafe.url, PAGE2);
    const snap = s.fx.sideEffectRuntime.approvalSnapshot({ approvalRequestId: call.callId, context: userCtx(s) });
    assert.equal(snap.targetRef, USER_VIEW, "审批投影必须显示目标标签");
    assert.equal(snap.url, PAGE2, "审批投影必须显示被批准的地址");
    assert.equal(snap.resourceRef, null);

    const approved = s.fx.sideEffectRuntime.decideApproval({ context: userCtx(s), approvalRequestId: call.callId, decision: "APPROVE" });
    assert.equal(approved.ok, true, JSON.stringify(approved));

    const r = await running;
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.task.status, "SUCCEEDED");
    assert.deepEqual(s.controller.state.navigations, [{ windowId: "browser", url: PAGE2, tabId: "t1" }], "恰好一次真实导航到被批准的地址");
    assert.equal(s.controller.state.entries[0].url, PAGE2, "真实视图地址已落地");
    const after = s.fx.sideEffectStore.callById(call.callId);
    assert.equal(after.status, "SUCCEEDED");
    assert.equal(after.verificationStatus, "PASS", "必须 READ_AFTER_WRITE 验证通过");
    assert.equal(s.fx.sideEffectStore.leasesOfCall(call.callId).length, 1, "execution lease = 1");
    assert.equal(s.fx.sideEffectStore.approvalsOfCall(call.callId).filter((a) => a.decision === "APPROVED").length, 1, "approval = 1");
  } finally { await s.fx.close(); }
});

test("WRITE 拒绝：用户 DENY → 0 导航、execution 不存在、不产生任何“已回滚”式结论", async () => {
  const s = await setup();
  try {
    const running = run(s, [{ id: "call_nav_deny", name: "browser_navigate", args: { viewId: USER_VIEW, url: PAGE2 } }]);
    await waitFor(() => s.fx.sideEffectStore.callsOfTask(s.task.taskId).length === 1, 60000, "SideEffectCall 未出现");
    const call = s.fx.sideEffectStore.callsOfTask(s.task.taskId)[0];
    const denied = s.fx.sideEffectRuntime.decideApproval({ context: userCtx(s), approvalRequestId: call.callId, decision: "DENY" });
    assert.equal(denied.ok, true, JSON.stringify(denied));
    const r = await running;
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.ok(["FAILED", "BLOCKED"].includes(r.task.status));
    assert.equal(s.controller.state.navigations.length, 0, "拒绝后绝不得导航");
    assert.equal(s.fx.sideEffectStore.callById(call.callId).status, "BLOCKED");
    assert.equal(s.fx.toolStore.executionsOfTask(s.task.taskId).length, 0, "拒绝 = 0 次执行");
  } finally { await s.fx.close(); }
});

test("工具门：URL 协议/凭据在 propose 阶段就被拒（0 side-effect call、0 导航），未授权目标不产生 plan", async () => {
  const s = await setup();
  try {
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "https://u:p@example.com/x"]) {
      const p = s.fx.toolProxy.propose({ context: s.ctx, taskId: s.task.taskId, toolId: "browser.navigate", toolVersion: 1, arguments: { viewId: USER_VIEW, url: bad }, proposalId: null });
      assert.equal(p.decisionStatus, "INVALID", "工具门必须拒绝 " + bad);
      assert.equal(p.reasonCode, "TOOL_ARGUMENT_INVALID");
    }
    assert.equal(s.fx.sideEffectStore.callsOfTask(s.task.taskId).length, 0, "被拒的提案不得产生 SideEffectCall");
    assert.equal(s.controller.state.navigations.length, 0);
    // 合法 URL 但目标未授权 → 工具门放行、**plan 阶段**拒绝（0 mutation、0 导航）。
    const t = s.fx.taskService.getTask({ context: s.ctx, taskId: s.task.taskId });
    assert.equal(t.ok, true);
    const st = s.fx.taskService.startTask ? s.fx.taskService.startTask({ context: s.ctx, taskId: s.task.taskId, expectedRevision: t.task.revision }) : { ok: false };
    void st;
    const planned = await s.fx.sideEffectAuthority.planSideEffect({
      context: s.ctx, taskId: s.task.taskId, toolId: "browser.navigate", toolVersion: 1,
      arguments: { viewId: OTHER_VIEW, url: PAGE2 },
    });
    assert.equal(planned.ok, false, "未授权目标不得产生 plan");
    assert.equal(planned.error, "SIDE_EFFECT_NO_PLAN");
    assert.equal(s.fx.sideEffectStore.callsOfTask(s.task.taskId).length, 0);
    assert.equal(s.controller.state.navigations.length, 0);
  } finally { await s.fx.close(); }
});
