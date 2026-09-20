/**
 * D5-01 Closure-3 · **主进程内执行类**的执行边界（in-process execution class）。
 *
 * 本轮新增的 in-process class 不能因为是"同类进程"就少掉独立 executor 的死亡 / 停止 / 无副作用证明：
 *   B1 claim 前撤权 → 0 派发
 *   B2 派发后停止（取消任务）→ 状态不悬挂、结论绝不是"未执行"
 *   B3 超时后迟到完成 → 不覆盖权威 UNKNOWN_EFFECT、不自动重试、不产生第二次派发；只读恢复可给结论
 *   B4 执行中标签消失 → 不可知 + 任务/调用终态一致，且不转向别的标签
 *   B5 结果核查归因：只认"这次派发"的证据，绝不因"当前 URL 相等"认领别人的导航
 *   B6 并发重复请求 → 同一执行记录只派发一次；批准后 plan 被改 → 旧批准不得用于新地址
 *
 * 全程走**同一条** OpenArc 权威链：propose → approve → lease → claim → execute → verify
 * （SideEffectAuthority 的既有约束一条都不少）。
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
const PAGE2 = SITE + "/page2";
const PAGE3 = SITE + "/page3";
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t && t.unref) t.unref(); });
const waitFor = async (fn, ms, detail = "") => { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (await Promise.resolve(fn())) return true; await sleep(20); } assert.fail("waitFor 超时：" + detail); };

/**
 * 假控制器（与 tests/d5-01-browser-control-chain.test.mjs 同口径），额外提供：
 *   · state.gate：把"派发等待"卡住，用来精确制造"派发之后、结果之前"的窗口；
 *   · state.releaseLate()：模拟"超时之后页面迟到完成"。
 */
function fakeController({ outcome = "applied" } = {}) {
  const state = {
    entries: [
      { viewId: USER_VIEW, windowId: "browser", tabId: "t1", url: SITE + "/form", title: "FORM", sessionKey: "usr_admin", alive: true },
      { viewId: OTHER_VIEW, windowId: "browser", tabId: "t2", url: PAGE3, title: "P3", sessionKey: "usr_admin", alive: true },
    ],
    reads: 0, navigations: [], outcome, ledger: new Map(), seq: 0, pending: null, gate: null, releaseLate: null,
  };
  const entryOf = (viewId) => state.entries.find((x) => x.viewId === viewId) || null;
  return {
    state,
    inventory: () => state.entries.filter((e) => e.alive),
    ownerOfView: (viewId) => state.entries.find((e) => e.viewId === viewId && e.alive) || null,
    readText: async () => { state.reads += 1; return "PAGE-TEXT ".repeat(50); },
    liveUrl: (viewId) => { const e = entryOf(viewId); return e && e.alive ? e.url : null; },
    navigate: (windowId, url, tabId) => {
      state.navigations.push({ windowId, url, tabId, at: Date.now() });
      const viewId = windowId + "#" + tabId;
      const e = entryOf(viewId);
      state.seq += 1;
      const ev = { seq: state.seq, viewId, requested: String(url), from: e ? String(e.url) : "", at: 1, started: { url: String(url), at: 1 }, commitments: [], loaded: null, loadError: null, superseded: false };
      state.ledger.set(viewId + "#" + ev.seq, ev);
      state.pending = { viewId, ev };
      if (state.outcome === "notapplied") ev.loadError = "ERR_ABORTED";
      return { ok: true, seq: ev.seq };
    },
    async waitForDispatch(viewId) {
      if (state.gate) await state.gate;
      const p = state.pending;
      if (!p || p.viewId !== String(viewId)) return { verdict: "INDETERMINATE", reason: "NO_DISPATCH" };
      const { ev } = p;
      if (state.outcome === "notapplied") return { verdict: "NOT_APPLIED", seq: ev.seq, reason: "ERR_ABORTED", requested: ev.requested };
      if (state.outcome === "unconfirmed" || state.outcome === "late") {
        if (state.outcome === "late") state.releaseLate = () => { const e = entryOf(viewId); if (e) e.url = ev.requested; ev.loaded = { at: 3, url: ev.requested }; };
        return { verdict: "INDETERMINATE", seq: ev.seq, reason: "DISPATCH_UNCONFIRMED", requested: ev.requested };
      }
      const finalUrl = state.outcome === "redirect" ? ev.requested.replace(/\/page2$/, "/page3") : ev.requested;
      const e = entryOf(viewId);
      if (e) e.url = finalUrl;
      ev.loaded = { at: 2, url: finalUrl };
      return { verdict: "APPLIED", seq: ev.seq, url: finalUrl, requested: ev.requested, from: ev.from, redirected: finalUrl !== ev.requested, noop: finalUrl === ev.from };
    },
    dispatchEvidence(viewId) {
      let latest = null;
      for (const ev of state.ledger.values()) if (ev.viewId === String(viewId)) latest = ev;
      return latest ? { ...latest } : null;
    },
  };
}

async function setup({ outcome = "applied", tools = ["tool.browser.read", "tool.browser.navigate"] } = {}) {
  const controller = fakeController({ outcome });
  const audits = [];
  const browserControl = new BrowserControlAuthority({ audit: (r) => audits.push(r) });
  browserControl.attachController(controller);
  const fx = await createToolHarnessFixture({
    withAdapters: true, behavior: "tool-loop", browserControl,
    facadeWriteToolIds: WRITE_TOOL_IDS, sideEffectApprovalWaitMs: 30000,
  });
  try {
    const actor = fx.f.authService.resolveActor({ context: { sessionRef: fx.f.sessions.admin, appId: "ai", source: "test" } });
    const userId = String(actor.user.id);
    for (const e of controller.state.entries) e.sessionKey = userId;
    browserControl.setSession(userId);
    const sel = browserControl.select({ context: { source: "user" }, userId, windowId: "browser", tabId: "t1" });
    assert.equal(sel.ok, true, JSON.stringify(sel));
    fx.grantTool("ai", tools);
    return { fx, controller, audits, browserControl, userId };
  } catch (e) {
    try { await fx.close(); } catch { /* ignore */ }
    throw e;
  }
}

/** 走真实链路建一条 AWAITING_APPROVAL 的 navigate call（并可选批准）。 */
async function makeCall(s, { url = PAGE2, viewId = USER_VIEW, approve = true } = {}) {
  const run = s.fx.dshRunSetup();
  const planned = await s.fx.sideEffectRuntime.proposeWrite({
    context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId,
    toolId: "browser.navigate", toolVersion: 1, arguments: { viewId, url },
  });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  const callId = planned.approvalRequestId;
  if (approve) {
    const approved = s.fx.sideEffectAuthority.approveSideEffect({ context: { sessionRef: s.fx.f.sessions.admin, source: "user" }, callId });
    assert.equal(approved.ok, true, JSON.stringify(approved));
  }
  return { ...run, callId, call: () => s.fx.sideEffectStore.callById(callId), leases: () => s.fx.sideEffectStore.leasesOfCall(callId) };
}

test("B1 · claim 前撤权：绝不派发（0 导航）、调用明确收敛，且不留 ACTIVE lease", async () => {
  const s = await setup();
  try {
    const c = await makeCall(s);
    // 批准之后、执行之前撤掉 tool.browser.navigate 权限（治理撤权的等价物：整表 upsert 覆盖动作集合）
    const revoked = s.fx.f.authService.grantAppToolPermission({ context: s.fx.f.ctx("admin"), appId: "ai", actions: ["tool.resource.search"] });
    assert.equal(revoked.ok, true, JSON.stringify(revoked));
    const res = await s.fx.sideEffectRuntime.executeInProcess({ callId: c.callId });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(s.controller.state.navigations.length, 0, "撤权后绝不派发");
    assert.equal(String(c.call().status), "BLOCKED", "调用必须明确收敛，不能悬挂：" + c.call().status);
    assert.equal(c.leases().filter((l) => l.status === "ACTIVE").length, 0, "不得留 ACTIVE lease");
  } finally { await s.fx.close(); }
});

test("B2 · 派发后停止（取消任务）：结论不是'未执行'，状态不悬挂，且不再有第二次派发", async () => {
  const s = await setup({ outcome: "unconfirmed" });
  try {
    const c = await makeCall(s);
    // 卡住派发等待，精确制造"已 claim + 已派发、结果未定"的窗口
    let releaseGate;
    s.controller.state.gate = new Promise((r) => { releaseGate = r; });
    const running = s.fx.sideEffectRuntime.executeInProcess({ callId: c.callId });
    await waitFor(() => s.controller.state.navigations.length === 1, 10000, "派发未发生");
    assert.equal(String(c.call().status), "RUNNING", "此刻必须处于 RUNNING（已 claim）");
    // 用户停止：取消任务
    const task = s.fx.taskStore.taskById(c.taskId);
    const cancelled = s.fx.taskService.cancelTask({ context: c.context, taskId: c.taskId, expectedRevision: task.revision });
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    releaseGate();
    const res = await running;
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.executed !== false || res.unknownEffect === true, true, "派发已发生 → 结论绝不能是'未执行'");
    assert.equal(String(c.call().status), "UNKNOWN_EFFECT", "结果不可知必须如实收敛：" + c.call().status);
    assert.equal(c.leases().filter((l) => l.status === "ACTIVE").length, 0, "不得留 ACTIVE lease");
    const step = s.fx.taskStore.stepById(c.stepId);
    assert.ok(step && ["BLOCKED", "CANCELLED", "SUCCEEDED"].includes(String(step.status)), "Step 不能悬挂：" + (step && step.status));
    assert.equal(s.controller.state.navigations.length, 1, "绝不允许第二次派发");
  } finally { await s.fx.close(); }
});

test("B3 · 超时后迟到完成：不覆盖权威 UNKNOWN_EFFECT、不自动重试；只读恢复才给结论", async () => {
  const s = await setup({ outcome: "late" });
  try {
    const c = await makeCall(s);
    const res = await s.fx.sideEffectRuntime.executeInProcess({ callId: c.callId });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(String(c.call().status), "UNKNOWN_EFFECT", "超时 → 权威状态是未知：" + c.call().status);
    assert.equal(res.recovered, true, "必须走既有恢复路径（不得自动续接 Harness）");
    const audits = s.fx.f.identity.connection.prepare("SELECT action, decision FROM authorization_audit").all().map((r) => r.action);
    assert.ok(audits.includes("side_effect.unknown_effect"), "UNKNOWN_EFFECT 必须落审计");

    // 页面**迟到完成**：不得由迟到的 promise 改写任何权威状态
    assert.equal(typeof s.controller.state.releaseLate, "function");
    s.controller.state.releaseLate();
    await sleep(30);
    assert.equal(String(c.call().status), "UNKNOWN_EFFECT", "迟到完成绝不允许覆盖权威未知状态");
    assert.equal(s.controller.state.navigations.length, 1, "绝不自动重试 / 重复派发");

    // 只有**显式的只读恢复核查**才允许修改调用状态（D4 既有契约：APPLIED → SUCCEEDED，Task/Step 保持 BLOCKED）
    const v = await s.fx.sideEffectRuntime.verifyUnknownEffect({ callId: c.callId });
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(String(c.call().status), "SUCCEEDED", "只读恢复给出 APPLIED 后才允许收敛：" + JSON.stringify(v));
    assert.equal(String(s.fx.taskStore.taskById(c.taskId).status), "BLOCKED", "§28：恢复驱动的结果绝不自动续接 Harness");
  } finally { await s.fx.close(); }
});

test("B4 · 执行中目标消失：判不可知、不转向别的标签、调用与任务都有终态", async () => {
  const s = await setup({ outcome: "unconfirmed" });
  try {
    const c = await makeCall(s);
    let releaseGate;
    s.controller.state.gate = new Promise((r) => { releaseGate = r; });
    const running = s.fx.sideEffectRuntime.executeInProcess({ callId: c.callId });
    await waitFor(() => s.controller.state.navigations.length === 1, 10000, "派发未发生");
    // 执行中标签被关闭（视图释放）
    s.controller.state.entries[0].alive = false;
    releaseGate();
    const res = await running;
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(String(c.call().status), "UNKNOWN_EFFECT", "派发后目标消失 = 不可知：" + c.call().status);
    assert.equal(s.controller.state.navigations.filter((n) => n.tabId !== "t1").length, 0, "绝不转向别的标签");
    assert.equal(s.controller.state.navigations.length, 1);
    assert.equal(c.leases().filter((l) => l.status === "ACTIVE").length, 0);
    const step = s.fx.taskStore.stepById(c.stepId);
    assert.ok(step && step.status !== "RUNNING", "Step 不得悬挂：" + (step && step.status));
  } finally { await s.fx.close(); }
});

test("B5 · 结果核查归因：只认本次派发证据；无证据/被中止一律不得认领成功", async () => {
  const s = await setup({ outcome: "applied" });
  try {
    const adapter = s.fx.adapters.adapterFor({ executionProvider: "BrowserControl", toolId: "browser.navigate" });
    assert.ok(adapter && typeof adapter.verify === "function");
    const contract = s.fx.toolRegistry.get("browser.navigate", 1);
    const ctx = { sessionRef: s.fx.f.sessions.admin, appId: "ai", source: "agent", agent: true, actorUserId: s.userId };
    // ① 无证据 → fail closed（上层进 UNKNOWN_EFFECT），绝不因 URL 相等而放行
    const none = await adapter.verify({ context: ctx, result: { viewId: USER_VIEW, url: PAGE2, dispatchSeq: 999 }, contract });
    assert.equal(none.ok, false, "没有派发证据时绝不允许声称生效");
    assert.equal(none.detail.reason, "NO_DISPATCH_EVIDENCE");
    // ② 真实派发 → 认领成功（并且能看出是不是重定向）
    const c = await makeCall(s);
    const res = await s.fx.sideEffectRuntime.executeInProcess({ callId: c.callId });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(String(c.call().status), "SUCCEEDED");
    const result = { viewId: USER_VIEW, url: PAGE2, ok: true, requested: PAGE2, redirected: false, noop: false, dispatchSeq: s.controller.state.pending.ev.seq };
    const okv = await adapter.verify({ context: ctx, result, contract });
    assert.equal(okv.ok, true, JSON.stringify(okv));
    assert.equal(okv.applied, true);
    assert.equal(okv.detail.seq, result.dispatchSeq, "结论必须绑定到**这次**派发序号");
    // ③ 证据显示这次加载被中止（用户自己导航到了同一地址）→ 不得认领成功
    const ev = s.controller.state.ledger.get(USER_VIEW + "#" + result.dispatchSeq);
    ev.loaded = null; ev.loadError = "ERR_ABORTED";
    const foreign = await adapter.verify({ context: ctx, result, contract });
    assert.equal(foreign.ok, true);
    assert.equal(foreign.applied, false, "地址相等但本次加载被中止 → 绝不能算本次成功");
    assert.equal(foreign.confidence, "KNOWN_NO_EFFECT");
  } finally { await s.fx.close(); }
});

test("B6 · 并发与重复：同一执行记录只派发一次；plan 被改后旧批准不得用于新地址", async () => {
  const s = await setup({ outcome: "applied" });
  try {
    const c = await makeCall(s);
    const [a, b] = await Promise.all([
      s.fx.sideEffectRuntime.executeInProcess({ callId: c.callId }),
      s.fx.sideEffectRuntime.executeInProcess({ callId: c.callId }),
    ]);
    const succeeded = [a, b].filter((r) => r.ok === true).length;
    assert.equal(succeeded >= 1, true, JSON.stringify([a.ok, b.ok]));
    assert.equal(s.controller.state.navigations.length, 1, "同一 execution 绝不重复派发：" + JSON.stringify(s.controller.state.navigations));
    assert.equal(String(c.call().status), "SUCCEEDED");

    // 旧批准不得用于新地址：批准之后 plan 被改（篡改 persisted expectedEffects）→ claim 必须拒绝、0 派发
    const s2 = await setup({ outcome: "applied" });
    try {
      const c2 = await makeCall(s2);
      const before = s2.controller.state.navigations.length;
      // 直写持久化行 = 模拟"批准之后另一个写者把 plan 的地址改掉"（updateCall 不支持这两个 JSON 列）。
      s2.fx.f.identity.connection.prepare("UPDATE side_effect_calls SET expected_effects_safe = ? WHERE call_id = ?")
        .run(JSON.stringify([{ action: "navigate", target: USER_VIEW, from: "http://127.0.0.1:5391/form", to: PAGE3 }]), c2.callId);
      assert.equal(s2.fx.sideEffectStore.callById(c2.callId).expectedEffectsSafe[0].to, PAGE3, "篡改必须真的落库（否则这条用例什么也没测）");
      const res2 = await s2.fx.sideEffectRuntime.executeInProcess({ callId: c2.callId });
      assert.equal(res2.ok, false, "plan 被改后旧批准必须失效：" + JSON.stringify(res2));
      assert.equal(s2.controller.state.navigations.length, before, "被拒时 0 派发");
      assert.notEqual(String(s2.fx.sideEffectStore.callById(c2.callId).status), "SUCCEEDED", "绝不能执行成功");
    } finally { await s2.fx.close(); }
  } finally { await s.fx.close(); }
});
