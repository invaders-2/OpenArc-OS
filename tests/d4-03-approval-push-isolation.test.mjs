/**
 * D4-03 · Approval **推送**隔离（§44）。
 *
 * 读路径（listPending / getApprovalRequest）与决策路径都按"主进程当前 authenticated
 * session"过滤，但推送路径曾经直接转发 runtime 的快照，于是任何已登录会话都会收到
 * **别人任务**的 approval 快照。本用例跑真实 side-effect runtime + 真实 task/call 行 +
 * 产品 registerIdentityIpc 接线，断言推送的可见性与 listPending / getApprovalRequest 一致。
 *
 * D5-03 第十三批 · 旧断言为何失效：SNAPSHOT_FIELDS 是**产品自己的封闭白名单**
 * （electron/side-effect-runtime.cjs 的 allowed 集合），D5-01 Closure-2 为受控浏览器导航
 * 审批把 `targetRef`（被批准的目标标签身份）与 `url`（被批准的地址）纳入**用户必须看到**的
 * 信息，旧测试的期望集合没跟上 —— 属于**断言过时**，不是泄露。判据没有被降低：集合仍是
 * 封闭的精确比较（多一个键就红），且新增的 N1–N4 对新增字段补了**值级**断言（资源回收必须
 * 为 null、浏览器导航必须精确等于被提案的地址/目标、正文/路径/凭据/内部 id 一律不得进入）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const require = createRequire(import.meta.url);
const { IdentityService } = require("../electron/identity-service.cjs");
const { SessionSecretStore, memoryBackend } = require("../electron/session-secret-store.cjs");
const { createSideEffectGateway } = require("../electron/side-effect-bootstrap.cjs");
const { registerIdentityIpc } = require("../electron/identity-bootstrap.cjs");
const { BrowserControlAuthority } = require("../electron/browser-control-authority.cjs");

const TRASH = "resource.trash";
const NAVIGATE = "browser.navigate";
const ABS_PATH_RE = /\/Users\/|\/private\/|\/var\/folders/;
/** 内部 authority id 前缀：只允许出现在主进程，绝不进推送（`scall_` 例外见 N4）。 */
const INTERNAL_ID_RE = /slease_|tappr_/i;
/** approval 推送允许出现的**全部**字段（= approvalSnapshot 白名单，多一个都不行）。 */
const SNAPSHOT_FIELDS = [
  "approvalRequestId", "status", "toolId", "toolDisplayName", "riskClass", "effectClass",
  "targetDisplayName", "resourceRef", "targetRef", "url", "expectedEffects", "expectedVersion",
  "currentVersion", "expiresAt", "requiresApproval",
].sort();

const SITE = "http://127.0.0.1:5391";
const VIEW = "browser#t1";
const PAGE2 = SITE + "/page2";
/** 页面正文的可辨识标记：只允许存在于受控读取结果里，绝不允许出现在审批/推送载荷。 */
const PAGE_TEXT = "OPENARC-PAGE-BODY-MARKER-D4-03";

/** 推送 / 读取 / 列表三处必须是同一份封闭投影：多的键、少的键都算红。 */
function assertExactSnapshotKeys(request, label) {
  assert.deepEqual(Object.keys(request).sort(), SNAPSHOT_FIELDS, label + "：推送/读取的字段集合必须是封闭白名单，多一个少一个都不行");
}

/**
 * 假原生控制器：只实现审批装配（select / inspect / plan）真正用到的方法。
 * 本用例只取"提案 → 审批快照/推送"这一段，真实导航执行与验证由 D5-01 / 回归覆盖。
 */
function fakeBrowserController() {
  const state = {
    entries: [{ viewId: VIEW, windowId: "browser", tabId: "t1", url: SITE + "/form", title: "FORM", sessionKey: null, alive: true }],
    reads: 0,
    navigations: [],
  };
  const entryOf = (viewId) => state.entries.find((x) => x.viewId === viewId) || null;
  return {
    state,
    inventory: () => state.entries.filter((e) => e.alive),
    ownerOfView: (viewId) => state.entries.find((e) => e.viewId === viewId && e.alive) || null,
    readText: async () => { state.reads += 1; return PAGE_TEXT; },
    liveUrl: (viewId) => { const e = entryOf(viewId); return e && e.alive ? e.url : null; },
    navigate: () => { state.navigations.push(1); return { ok: false }; },
  };
}

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d4-03-push-"));
  const fx = await createToolHarnessFixture({
    withAdapters: true,
    dbPath: path.join(root, "identity.db"),
    storeRoot: path.join(root, "library"),
    keepData: true,
    sideEffectRuntimeDir: path.join(root, "runtime"),
  });
  const created = await fx.createResource("Push Isolation Target");
  fx.grantTool("ai", ["tool.resource.trash"]);
  fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId: created.resource.resourceId, actions: ["resource.delete"] });
  fx.grantUserResource(created.resource.resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]);
  const run = fx.dshRunSetup(); // A 的真实 RUNNING task / step / run（task.session_ref = A 的会话）
  // 产品装配：main process 的 IdentityService —— 推送过滤读的就是它的 current。
  const service = new IdentityService({ store: fx.f.identity, secrets: new SessionSecretStore(memoryBackend()), allowAdmin: true });
  const pushes = [];
  const handlers = new Map();
  registerIdentityIpc({
    // 只替掉 Electron ipcMain 这一层：gateway / runtime / identity 都是产品实现。
    ipcMain: { handle: (channel, fn) => { handlers.set(channel, fn); } },
    service,
    sideEffect: createSideEffectGateway({ sideEffectRuntime: fx.sideEffectRuntime }),
    sendSideEffect: (payload) => pushes.push(payload),
    isTrusted: () => true,
  });
  /** Renderer 唯一入口（ApprovalPrompt 用的就是它）。 */
  const ipc = (command) => handlers.get("sideeffect:command")({}, command); // async handler → 必须 await
  /** 切换 main process 当前 authenticated session；null = 未登录。 */
  const asSession = (key) => { service.current = key ? fx.f.sessions[key] : null; };
  // §35 duplicate：同一个 step 上同 tool/args 会收敛成同一条 call，多 call 场景必须换 step。
  const propose = (r = run) => fx.sideEffectRuntime.proposeWrite({ context: fx.ctx(), taskId: r.taskId, stepId: r.stepId, runId: r.runId, toolId: TRASH, arguments: { resourceRef: created.resource.resourceRef } });
  const newRun = () => fx.dshRunSetup();
  return {
    fx, service, pushes, ipc, asSession, propose, newRun,
    storeRoot: fx.f.storeRoot,
    sessionA: fx.f.sessions.admin, // A = 任务 owner
    sessionB: fx.f.sessions.alice, // B = 另一个真实用户会话
    async close() {
      try { await fx.close(); } catch { /* ignore */ }
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/** 浏览器导航场景：与 setup() 同一条产品接线，只是受控目标换成真实选中的浏览器标签。 */
async function setupBrowser() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d4-03-push-browser-"));
  const controller = fakeBrowserController();
  const audits = [];
  const browserControl = new BrowserControlAuthority({ audit: (r) => audits.push(r) });
  browserControl.attachController(controller);
  const fx = await createToolHarnessFixture({
    withAdapters: true, browserControl,
    dbPath: path.join(root, "identity.db"),
    storeRoot: path.join(root, "library"),
    keepData: true,
    sideEffectRuntimeDir: path.join(root, "runtime"),
  });
  try {
    // 分区归属必须是**真实登录用户 id**（与 D5-01 同一口径：主机不给假 userId 开后门）。
    const actor = fx.f.authService.resolveActor({ context: { sessionRef: fx.f.sessions.admin, appId: "ai", source: "test" } });
    assert.equal(actor.ok, true, "夹具管理员会话必须可解析");
    const userId = String(actor.user.id);
    for (const e of controller.state.entries) e.sessionKey = userId;
    browserControl.setSession(userId);
    const selected = browserControl.select({ context: { source: "user" }, userId, windowId: "browser", tabId: "t1" });
    assert.equal(selected.ok, true, "选择控制目标必须成功：" + JSON.stringify(selected));
    fx.grantTool("ai", ["tool.browser.navigate"]);
    const run = fx.dshRunSetup(); // A 的真实 RUNNING task / step / run
    const service = new IdentityService({ store: fx.f.identity, secrets: new SessionSecretStore(memoryBackend()), allowAdmin: true });
    const pushes = [];
    const handlers = new Map();
    registerIdentityIpc({
      ipcMain: { handle: (channel, fn) => { handlers.set(channel, fn); } },
      service,
      sideEffect: createSideEffectGateway({ sideEffectRuntime: fx.sideEffectRuntime }),
      sendSideEffect: (payload) => pushes.push(payload),
      isTrusted: () => true,
    });
    const ipc = (command) => handlers.get("sideeffect:command")({}, command);
    const asSession = (key) => { service.current = key ? fx.f.sessions[key] : null; };
    const navigate = (url, r = run) => fx.sideEffectRuntime.proposeWrite({ context: fx.ctx(), taskId: r.taskId, stepId: r.stepId, runId: r.runId, toolId: NAVIGATE, arguments: { viewId: VIEW, url } });
    const newRun = () => fx.dshRunSetup();
    return {
      fx, controller, audits, browserControl, service, pushes, ipc, asSession, navigate, newRun,
      storeRoot: fx.f.storeRoot,
      sessionA: fx.f.sessions.admin,
      sessionB: fx.f.sessions.alice,
      async close() {
        try { await fx.close(); } catch { /* ignore */ }
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
      },
    };
  } catch (e) {
    try { await fx.close(); } catch { /* ignore */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    throw e;
  }
}

test("P1 · 当前会话 = B：A 任务进入 AWAITING_APPROVAL 时推送必须被静默丢弃", async () => {
  const s = await setup();
  try {
    s.asSession("alice"); // B 已登录
    const planned = await s.propose();
    assert.equal(planned.ok, true, JSON.stringify(planned));
    assert.equal(s.fx.sideEffectStore.callById(planned.approvalRequestId).status, "AWAITING_APPROVAL");
    assert.equal(s.pushes.length, 0, "B 的窗口不得收到 A 任务的推送：" + JSON.stringify(s.pushes));
    assert.deepEqual(await s.ipc({ type: "sideEffect/listPending" }), { ok: true, items: [], revocable: [] });
    const gotB = await s.ipc({ type: "sideEffect/getApprovalRequest", approvalRequestId: planned.approvalRequestId });
    assert.equal(gotB.ok, false, JSON.stringify(gotB));
    assert.equal(gotB.error, "SIDE_EFFECT_CALL_NOT_FOUND");
    // 与底层投影一致：B 会话下该 call 不可投影
    assert.equal(s.fx.sideEffectRuntime.approvalSnapshot({ approvalRequestId: planned.approvalRequestId, context: { sessionRef: s.sessionB } }), null);
  } finally { await s.close(); }
});

test("P2 · 当前会话 = A（owner）：推送投递，载荷 = 白名单投影且与 getApprovalRequest 一致", async () => {
  const s = await setup();
  try {
    s.asSession("admin");
    const planned = await s.propose();
    assert.equal(planned.ok, true, JSON.stringify(planned));
    assert.equal(s.pushes.length, 1, "owner 会话必须收到推送");
    const event = s.pushes[0];
    assert.equal(event.type, "sideEffect/approvalRequested");
    assertExactSnapshotKeys(event.request, "P2 resource.trash");
    assert.equal(event.request.approvalRequestId, planned.approvalRequestId);
    const got = await s.ipc({ type: "sideEffect/getApprovalRequest", approvalRequestId: planned.approvalRequestId });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.deepEqual(event.request, got.request, "推送载荷必须与读路径同一份安全投影");
    const pending = await s.ipc({ type: "sideEffect/listPending" });
    assert.ok(pending.items.some((i) => i.approvalRequestId === planned.approvalRequestId), "owner 必须能在 listPending 里发现它（合法入口不丢）");
    const text = JSON.stringify(event);
    assert.ok(!text.includes(s.storeRoot), "推送不得含 store root");
    assert.ok(!ABS_PATH_RE.test(text), "推送不得含绝对路径");
  } finally { await s.close(); }
});

test("P3 · 会话切回 A 后仍能发现 B 会话期间产生的 pending（挂载查询等价）", async () => {
  const s = await setup();
  try {
    s.asSession("alice");
    const planned = await s.propose();
    assert.equal(planned.ok, true, JSON.stringify(planned));
    assert.equal(s.pushes.length, 0);
    s.asSession("admin"); // 切回 owner
    const pending = await s.ipc({ type: "sideEffect/listPending" }); // ApprovalPrompt 挂载时走的就是这条命令
    assert.ok(pending.items.some((i) => i.approvalRequestId === planned.approvalRequestId), "owner 不能丢失这条待决请求：" + JSON.stringify(pending));
    const got = await s.ipc({ type: "sideEffect/getApprovalRequest", approvalRequestId: planned.approvalRequestId });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.request.approvalRequestId, planned.approvalRequestId);
  } finally { await s.close(); }
});

test("P4 · 无 authenticated session：不推送、不改任何状态", async () => {
  const s = await setup();
  try {
    s.asSession(null);
    const planned = await s.propose();
    assert.equal(planned.ok, true, JSON.stringify(planned));
    assert.equal(s.pushes.length, 0, "未登录时不得推送");
    assert.equal(s.fx.sideEffectStore.callById(planned.approvalRequestId).status, "AWAITING_APPROVAL", "静默丢弃不得改状态");
    assert.equal(s.fx.sideEffectStore.approvalsOfCall(planned.approvalRequestId).length, 0);
  } finally { await s.close(); }
});

test("P5 · 决策路径不受影响：owner APPROVE/DENY 正常，非 owner 会话决策仍被拒", async () => {
  const s = await setup();
  try {
    s.asSession("admin");
    const toApprove = await s.propose();
    const approved = await s.ipc({ type: "sideEffect/decideApproval", approvalRequestId: toApprove.approvalRequestId, decision: "APPROVE" });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assert.equal(approved.status, "APPROVED");
    const toDeny = await s.propose(s.newRun());
    const denied = await s.ipc({ type: "sideEffect/decideApproval", approvalRequestId: toDeny.approvalRequestId, decision: "DENY" });
    assert.equal(denied.ok, true, JSON.stringify(denied));
    assert.equal(denied.status, "BLOCKED");
    // 既有语义：decision 只认 user/role（task owner 或 ADMIN），不认 sessionRef —— 本轮不改。
    const foreign = await s.propose(s.newRun());
    s.asSession("alice");
    const rejected = await s.ipc({ type: "sideEffect/decideApproval", approvalRequestId: foreign.approvalRequestId, decision: "APPROVE" });
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.equal(rejected.error, "SIDE_EFFECT_APPROVAL_FORBIDDEN");
    assert.equal(s.fx.sideEffectStore.callById(foreign.approvalRequestId).status, "AWAITING_APPROVAL", "被拒决策不得改 call 状态");
  } finally { await s.close(); }
});

test("P6 · 无 session：读路径空 / not-found，声明了 context 的投影一律 null", async () => {
  const s = await setup();
  try {
    s.asSession(null);
    const planned = await s.propose();
    assert.equal(planned.ok, true, JSON.stringify(planned));
    // 声明了 context 却没有 session：等于未认证窗口，不得放行（修复前这里能拿到完整快照）
    assert.equal(s.fx.sideEffectRuntime.approvalSnapshot({ approvalRequestId: planned.approvalRequestId, context: {} }), null);
    assert.equal(s.fx.sideEffectRuntime.approvalSnapshot({ approvalRequestId: planned.approvalRequestId, context: { sessionRef: null } }), null);
    assert.deepEqual(await s.ipc({ type: "sideEffect/listPending" }), { ok: true, items: [], revocable: [] });
    const got = await s.ipc({ type: "sideEffect/getApprovalRequest", approvalRequestId: planned.approvalRequestId });
    assert.equal(got.ok, false, JSON.stringify(got));
    assert.equal(got.error, "SIDE_EFFECT_CALL_NOT_FOUND");
    // gateway 默认 context（不传）同样不得放行
    assert.deepEqual(s.fx.sideEffectRuntime.listPendingApprovals({}), { ok: true, items: [], revocable: [] });
  } finally { await s.close(); }
});

test("P7 · A 会话下读路径正常（正对照）", async () => {
  const s = await setup();
  try {
    s.asSession("admin");
    const planned = await s.propose();
    assert.equal(planned.ok, true, JSON.stringify(planned));
    const pending = await s.ipc({ type: "sideEffect/listPending" });
    assert.ok(pending.items.some((i) => i.approvalRequestId === planned.approvalRequestId), JSON.stringify(pending));
    const got = await s.ipc({ type: "sideEffect/getApprovalRequest", approvalRequestId: planned.approvalRequestId });
    assert.equal(got.ok, true, JSON.stringify(got));
    const snap = s.fx.sideEffectRuntime.approvalSnapshot({ approvalRequestId: planned.approvalRequestId, context: { sessionRef: s.sessionA } });
    assert.equal(snap && snap.approvalRequestId, planned.approvalRequestId);
  } finally { await s.close(); }
});

test("P8 · context == null 的内部投影语义未变（推送钩子用）", async () => {
  const s = await setup();
  try {
    s.asSession(null); // 内部投影与窗口会话无关
    const planned = await s.propose();
    const internal = s.fx.sideEffectRuntime.approvalSnapshot({ approvalRequestId: planned.approvalRequestId });
    assert.ok(internal && internal.approvalRequestId === planned.approvalRequestId, "内部无 context 投影保持既有语义");
  } finally { await s.close(); }
});

test("N1 · 反例 · 资源回收审批不携带任何浏览器目标", async () => {
  const s = await setup();
  try {
    s.asSession("admin");
    const planned = await s.propose();
    assert.equal(planned.ok, true, JSON.stringify(planned));
    assert.equal(s.pushes.length, 1);
    const event = s.pushes[0];
    assertExactSnapshotKeys(event.request, "N1 resource.trash");
    assert.equal(event.request.targetRef, null, "资源回收没有浏览器目标身份");
    assert.equal(event.request.url, null, "资源回收没有浏览器地址");
    assert.ok(planned.call && planned.call.preconditionsSafe, "proposeWrite 必须返回带 preconditionsSafe 的 call 行");
    assert.equal(event.request.resourceRef, planned.call.preconditionsSafe.resourceRef);
    assert.equal(typeof event.request.resourceRef, "string");
    assert.ok(event.request.resourceRef.length > 0, "资源回收的 target 必须是真实 resourceRef 字符串，不能是空串");
    const text = JSON.stringify(event);
    assert.equal(text.includes("浏览器标签"), false, "资源回收推送不得出现浏览器目标文案：" + text);
    assert.equal(/https?:\/\//.test(text), false, "资源回收推送不得出现任何 http(s) 痕迹：" + text);
    // 底层持久化的 preconditions 也没有这两个键（不是投影层删掉的）
    assert.deepEqual(Object.keys(s.fx.sideEffectStore.callById(planned.approvalRequestId).preconditionsSafe).sort(), ["expectedVersion", "registryStatus", "resourceRef"]);
  } finally { await s.close(); }
});

test("N2 · 正例 · 浏览器导航：推送 / 读取 / 列表三处同一个待批准地址", async () => {
  const s = await setupBrowser();
  try {
    const URL_WITH_QUERY = "https://example.com/search?q=openarc&page=2#frag";
    const URL_LONG = "https://example.com/long?p=" + "a".repeat(1500) + "&end=1";
    s.asSession("admin");

    const planned = await s.navigate(URL_WITH_QUERY);
    assert.equal(planned.ok, true, JSON.stringify(planned));
    assert.equal(s.pushes.length, 1, "owner 会话必须收到刚好 1 条推送");
    const event = s.pushes[0];
    assert.equal(event.type, "sideEffect/approvalRequested");
    assertExactSnapshotKeys(event.request, "N2 browser.navigate");
    // 推送里的地址与目标就是**被提案的那一个**（精确相等，不是 includes）
    assert.equal(event.request.url, URL_WITH_QUERY);
    assert.equal(event.request.targetRef, VIEW);
    assert.equal(event.request.resourceRef, null);
    assert.equal(event.request.targetDisplayName, "浏览器标签 " + VIEW, "目标身份必须是稳定标签身份，不是页面正文");
    // 推送 = 读取
    const got = await s.ipc({ type: "sideEffect/getApprovalRequest", approvalRequestId: planned.approvalRequestId });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.deepEqual(event.request, got.request, "推送载荷必须与 getApprovalRequest 同一份投影");
    assertExactSnapshotKeys(got.request, "N2 getApprovalRequest");
    // 三处一致
    const pending = await s.ipc({ type: "sideEffect/listPending" });
    const item = pending.items.find((i) => i.approvalRequestId === planned.approvalRequestId);
    assert.ok(item, "listPending 必须能发现它：" + JSON.stringify(pending));
    assert.equal(item.url, URL_WITH_QUERY, "列表项必须携带同一个地址");
    assert.equal(item.targetRef, VIEW);
    assert.deepEqual(item, got.request, "列表项 = 读取结果 = 推送载荷");
    // 地址没有被截断 / 改写
    assert.equal(s.fx.sideEffectStore.callById(planned.approvalRequestId).preconditionsSafe.url, URL_WITH_QUERY);
    // 正文绝不进入审批载荷
    assert.equal(JSON.stringify(event).includes(PAGE_TEXT), false, "页面正文绝不得进入审批推送");
    assert.equal(JSON.stringify(got.request).includes(PAGE_TEXT), false, "页面正文绝不得进入读取路径");
    assert.deepEqual(s.controller.state.navigations, [], "审批阶段不得发生任何真实导航");

    // 带 query / path 的长地址原样进入三处（未被 slice 截断）
    const plannedLong = await s.navigate(URL_LONG, s.newRun());
    assert.equal(plannedLong.ok, true, JSON.stringify(plannedLong));
    assert.equal(s.pushes.length, 2);
    const longEvent = s.pushes[1];
    assertExactSnapshotKeys(longEvent.request, "N2 browser.navigate（长地址）");
    assert.equal(longEvent.request.url, URL_LONG);
    assert.equal(longEvent.request.url.length, URL_LONG.length);
    assert.equal(s.fx.sideEffectStore.callById(plannedLong.approvalRequestId).preconditionsSafe.url, URL_LONG);
    const longGot = await s.ipc({ type: "sideEffect/getApprovalRequest", approvalRequestId: plannedLong.approvalRequestId });
    assert.equal(longGot.ok, true, JSON.stringify(longGot));
    assert.deepEqual(longEvent.request, longGot.request);
    assert.equal(JSON.stringify(longEvent).includes(PAGE_TEXT), false);
  } finally { await s.close(); }
});

test("N3 · 反例 · 非所属会话 / 未登录窗口在浏览器场景仍为 0 投影", async () => {
  const s = await setupBrowser();
  try {
    // 当前会话 = B（非 task owner）
    s.asSession("alice");
    const planned = await s.navigate(PAGE2);
    assert.equal(planned.ok, true, JSON.stringify(planned));
    assert.equal(s.pushes.length, 0, "B 的窗口不得收到 A 任务的浏览器审批推送：" + JSON.stringify(s.pushes));
    assert.deepEqual(await s.ipc({ type: "sideEffect/listPending" }), { ok: true, items: [], revocable: [] });
    const gotB = await s.ipc({ type: "sideEffect/getApprovalRequest", approvalRequestId: planned.approvalRequestId });
    assert.equal(gotB.ok, false, JSON.stringify(gotB));
    assert.equal(gotB.error, "SIDE_EFFECT_CALL_NOT_FOUND");
    assert.equal(s.fx.sideEffectRuntime.approvalSnapshot({ approvalRequestId: planned.approvalRequestId, context: { sessionRef: s.sessionB } }), null);

    // 无 authenticated session
    const planned2 = await s.navigate(PAGE2, s.newRun());
    assert.equal(planned2.ok, true, JSON.stringify(planned2));
    s.asSession(null);
    assert.equal(s.pushes.length, 0, "未登录时不得推送浏览器审批");
    assert.equal(s.fx.sideEffectStore.callById(planned2.approvalRequestId).status, "AWAITING_APPROVAL", "静默丢弃不得改状态");
    assert.equal(s.fx.sideEffectStore.approvalsOfCall(planned2.approvalRequestId).length, 0);
    assert.equal(s.fx.sideEffectRuntime.approvalSnapshot({ approvalRequestId: planned2.approvalRequestId, context: {} }), null);
    assert.equal(s.fx.sideEffectRuntime.approvalSnapshot({ approvalRequestId: planned2.approvalRequestId, context: { sessionRef: null } }), null);
    assert.equal(s.fx.sideEffectRuntime.approvalSnapshot({ approvalRequestId: planned2.approvalRequestId, context: { sessionRef: s.sessionB } }), null);
    assert.deepEqual(await s.ipc({ type: "sideEffect/listPending" }), { ok: true, items: [], revocable: [] });
    const gotNone = await s.ipc({ type: "sideEffect/getApprovalRequest", approvalRequestId: planned2.approvalRequestId });
    assert.equal(gotNone.ok, false, JSON.stringify(gotNone));
    assert.equal(gotNone.error, "SIDE_EFFECT_CALL_NOT_FOUND");
  } finally { await s.close(); }
});

test("N4 · 反例 · 路径 / 凭据 / 其它未准许字段一律不得进入推送", async () => {
  const trash = await setup();
  const browser = await setupBrowser();
  try {
    trash.asSession("admin");
    const trashed = await trash.propose();
    assert.equal(trashed.ok, true, JSON.stringify(trashed));
    assert.equal(trash.pushes.length, 1);
    const trashEvent = trash.pushes[0];
    assertExactSnapshotKeys(trashEvent.request, "N4 resource.trash");
    assert.deepEqual(Object.keys(trashEvent.request).sort(), SNAPSHOT_FIELDS, "资源回收推送不得新增白名单外的键（负向自证：投影里多加一个敏感字段这里必须红）");
    assert.equal(JSON.stringify(trashEvent).includes(trash.storeRoot), false, "推送不得含 store root");
    assert.equal(ABS_PATH_RE.test(JSON.stringify(trashEvent)), false, "推送不得含绝对路径");
    assert.equal(INTERNAL_ID_RE.test(JSON.stringify(trashEvent)), false, "推送不得含内部 authority id（lease / approval 行 id）");

    browser.asSession("admin");
    const url = "https://example.com/deep/path?token=1";
    const nav = await browser.navigate(url);
    assert.equal(nav.ok, true, JSON.stringify(nav));
    assert.equal(browser.pushes.length, 1);
    const navEvent = browser.pushes[0];
    assertExactSnapshotKeys(navEvent.request, "N4 browser.navigate");
    assert.deepEqual(Object.keys(navEvent.request).sort(), SNAPSHOT_FIELDS, "浏览器导航推送不得新增白名单外的键（负向自证：投影里多加一个敏感字段这里必须红）");
    const navText = JSON.stringify(navEvent);
    assert.equal(navText.includes(browser.storeRoot), false, "推送不得含 store root");
    assert.equal(ABS_PATH_RE.test(navText), false, "推送不得含绝对路径（/Users/、/private/、/var/folders）");
    assert.equal(INTERNAL_ID_RE.test(navText), false, "推送不得含内部 authority id（slease_ / tappr_）");
    assert.equal(navText.includes(PAGE_TEXT), false, "推送不得含页面正文");
    // 内部 authority id 只留在主进程：调用 id 前缀是 scall_，但 lease / approval 行 id 不得进投影
    assert.equal(/slease_|tappr_/.test(JSON.stringify(await browser.ipc({ type: "sideEffect/listPending" }))), false);

    // 工具门：含 user:pass@host 的地址在**提案阶段**就被拒，绝不产生 push
    const pushesBefore = browser.pushes.length;
    const callsBefore = browser.fx.sideEffectStore.callsOfTask(nav.call.taskId).length;
    const bad = await browser.navigate("https://u:p@example.com/x", browser.newRun());
    assert.equal(bad.ok, false, "带凭据的地址必须在提案阶段被拒：" + JSON.stringify(bad));
    assert.equal(bad.error, "TOOL_ARGUMENT_INVALID");
    assert.equal(browser.pushes.length, pushesBefore, "被拒的提案不得产生任何推送");
    assert.equal(browser.fx.sideEffectStore.callsOfTask(nav.call.taskId).length, callsBefore, "被拒的提案不得产生 SideEffectCall");
    const afterBad = JSON.stringify({ pushes: browser.pushes, pending: await browser.ipc({ type: "sideEffect/listPending" }) });
    assert.equal(afterBad.includes("u:p@example.com"), false, "凭据无论如何不得出现在审批投影里");
  } finally { await trash.close(); await browser.close(); }
});
