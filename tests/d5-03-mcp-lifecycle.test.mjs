/**
 * D5-03 第三批 · 生命周期收尾接线（登出 / 锁屏 / 撤权 / 关应用）。
 *
 * 测的这条线就是产品装配线：
 *   · IdentityService 事件 → attachMcpSessionLifecycle（identity-bootstrap 里的同一个调用）；
 *   · AuthorizationService 撤销 App Grant → attachMcpAppGrantRevocation；
 *   · 关应用 = disposeMcpBounded（main.cjs will-quit 里的同一个助手，2s 兜底）。
 *
 * 全部对着自建受控 fixture（tests/fixtures/mcp/echo-server.mjs，只监听 127.0.0.1），不连第三方。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createMcpFixture, startEchoServer, waitFor, disposeMcpBounded } from "./mcp-fixtures.mjs";
import { pw } from "./device-fixtures.mjs";
import { fakeTimers } from "./session-expiry-fixtures.mjs";

const require = createRequire(import.meta.url);
const { MCP_SESSION_END_EVENTS } = require("../electron/mcp-bootstrap.cjs");

async function withFixture(fn, options = {}) {
  const fx = await createMcpFixture(options);
  try {
    return await fn(fx);
  } finally {
    await fx.close();
  }
}

const recordOf = (fx, id) => fx.identity.connection.prepare("SELECT * FROM mcp_connections WHERE connection_id = ?").get(id);
const mcpGrantOf = (fx) => fx.store.appGrantsForApp("mcp-center").find((g) => g.resource_type === "mcp");
const stateOf = async (info) => (await fetch("http://127.0.0.1:" + info.port + "/__state")).json();

async function waitForState(info, predicate, { timeoutMs = 2500, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await stateOf(info);
    if (predicate(st)) return st;
    if (Date.now() > deadline) return st;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** 建一个远程 HTTP 连接（本机自建 fixture）并启用。 */
async function createHttp(fx, info, name = "生命周期 HTTP") {
  const created = await fx.invoke({ command: "mcp/create", name, transport: "http", location: "REMOTE_SERVICE", endpoint: { url: info.url }, authMode: "NONE", visibility: "PERSONAL" });
  assert.equal(created.ok, true, JSON.stringify(created));
  const id = created.connection.connectionId;
  await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
  return id;
}

test("L1 · 登出：活连接与 GET 流立刻收掉，enabled 不被改写；重新登录后仍可 connect", async () => {
  const server = startEchoServer(["--http", "--port=0", "--get-sse", "--get-sse-ids", "--get-sse-notify-interval=20"]);
  try {
    const info = await server.ready;
    await withFixture(async (fx) => {
      const id = await createHttp(fx, info);
      const connected = await fx.invoke({ command: "mcp/connect", connectionId: id });
      assert.equal(connected.ok, true, JSON.stringify(connected));
      const client = fx.mcpService.live.get(id).client;
      assert.equal(client.diagnostics().stream.state, "open");
      const running = await waitForState(info, (s) => s.getSse.openStreams >= 1);
      assert.equal(running.getSse.openStreams >= 1, true, "连接后服务端侧 GET 流应当活着：" + JSON.stringify(running.getSse));

      const out = await fx.identityService.dispatch({ type: "identity/logout" });
      assert.equal(out.ok, true, JSON.stringify(out));
      const settled = await waitFor(() => (fx.mcpService.live.size === 0 && fx.mcpService.opening.size === 0 && recordOf(fx, id).status === "DISABLED" ? true : null));
      assert.equal(settled, true, "登出后不得留下活连接或握手中的客户端");
      assert.equal(client.diagnostics().stream.state, "closed");
      assert.equal(client.diagnostics().inflightRequests, 0);
      assert.equal(client.diagnostics().background, 0);
      const closed = await waitForState(info, (s) => s.getSse.openStreams === 0);
      assert.equal(closed.getSse.openStreams, 0, "登出后服务端侧 GET 流必须断开：" + JSON.stringify(closed.getSse));

      const row = recordOf(fx, id);
      assert.equal(row.status, "DISABLED", "登出后状态必须照实（未连接的 DISABLED），不能留 READY，也不能假装 AUTH_REQUIRED");
      assert.equal(row.last_error_code, "MCP_SESSION_ENDED", "为什么变成 DISABLED 必须留痕：会话结束");
      assert.equal(row.enabled, 1, "enabled 是用户意图，登出不得改写");
      const logs = fx.mcpStore.logsOfConnection(id, 50);
      assert.equal(logs.some((r) => r.event === "SESSION_ENDED" && r.detail === "logout"), true, JSON.stringify(logs));

      // 没有会话：命令照旧被拒（不是"界面自己禁用"，是命令层实时判定）
      assert.equal((await fx.invoke({ command: "mcp/list" })).error, "MCP_UNAUTHORIZED");
      assert.equal((await fx.invoke({ command: "mcp/connect", connectionId: id })).error, "MCP_UNAUTHORIZED");

      // 重新登录：不重新配置、不重新启用，直接 connect 就恢复
      const login = await fx.identityService.dispatch({ type: "identity/login", identifier: "admin@openarc.test", password: pw("admin") });
      assert.equal(login.ok, true, JSON.stringify(login));
      fx.identityRef.current = fx.identityService.current;
      const again = await fx.invoke({ command: "mcp/connect", connectionId: id });
      assert.equal(again.ok, true, JSON.stringify(again));
      const fresh = recordOf(fx, id);
      assert.equal(fresh.status, "READY");
      assert.equal(fresh.enabled, 1);
    }, { requestTimeoutMs: 3000 });
  } finally {
    server.stop();
  }
});

test("L2 · 锁屏：同样收掉活连接（不是留到解锁）；解锁后仍可连接", async () => {
  await withFixture(async (fx) => {
    const created = await fx.createLocal();
    const id = created.connection.connectionId;
    await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
    const connected = await fx.invoke({ command: "mcp/connect", connectionId: id });
    assert.equal(connected.ok, true, JSON.stringify(connected));
    assert.equal(fx.mcpService.live.size, 1);

    const locked = await fx.identityService.dispatch({ type: "identity/lock" });
    assert.equal(locked.ok, true, JSON.stringify(locked));
    const settled = await waitFor(() => (fx.mcpService.live.size === 0 && recordOf(fx, id).status === "DISABLED" ? true : null));
    assert.equal(settled, true, "锁屏后不得留下活连接");
    const row = recordOf(fx, id);
    assert.equal(row.status, "DISABLED");
    assert.equal(row.last_error_code, "MCP_SESSION_ENDED");
    assert.equal(row.enabled, 1);
    const logs = fx.mcpStore.logsOfConnection(id, 50);
    assert.equal(logs.some((r) => r.event === "SESSION_ENDED" && r.detail === "user"), true, JSON.stringify(logs));

    const unlocked = await fx.identityService.dispatch({ type: "identity/unlock", password: pw("admin") });
    assert.equal(unlocked.ok, true, JSON.stringify(unlocked));
    fx.identityRef.current = fx.identityService.current;
    const again = await fx.invoke({ command: "mcp/reconnect", connectionId: id });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(recordOf(fx, id).status, "READY");
  });
});

test("L3 · 撤权：mcp.* 被撤销后立刻收掉活连接；后续命令 MCP_UNAUTHORIZED、工具不再投影", async () => {
  await withFixture(async (fx) => {
    const created = await fx.createLocal();
    const id = created.connection.connectionId;
    await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
    const connected = await fx.invoke({ command: "mcp/connect", connectionId: id });
    assert.equal(connected.ok, true, JSON.stringify(connected));
    assert.equal(fx.mcpService.live.size, 1);
    const client = fx.mcpService.live.get(id).client;

    const grant = mcpGrantOf(fx);
    assert.equal(!!grant, true, "mcp-center 的 mcp Grant 必须存在");
    const revoked = fx.authService.revokeAppResourcePermission({ context: { sessionRef: fx.sessions.admin, appId: "resource-library" }, grantId: grant.id });
    assert.equal(revoked.ok, true, JSON.stringify(revoked));
    assert.equal(revoked.changed, true);

    assert.equal(fx.mcpService.live.size, 0, "撤权必须立刻收掉活连接，不等下一次命令");
    const closed = await waitFor(() => (client.diagnostics().state === "closed" ? true : null));
    assert.equal(closed, true, "撤权后客户端必须真的关掉");
    assert.equal(client.diagnostics().inflightRequests, 0);
    const row = recordOf(fx, id);
    assert.equal(row.status, "ERROR", "撤权后不得留 READY");
    assert.equal(row.last_error_code, "MCP_UNAUTHORIZED");
    assert.equal(row.enabled, 1, "撤权不改写 enabled");
    const logs = fx.mcpStore.logsOfConnection(id, 50);
    assert.equal(logs.some((r) => r.event === "AUTHORIZATION_REVOKED" && r.error_code === "MCP_UNAUTHORIZED"), true, JSON.stringify(logs));
    assert.equal(logs.some((r) => r.event === "AUTHORIZATION_REVOKED" && r.detail === "app-grant-revoked"), true, "撤权的既有 detail 一个字符不变：" + JSON.stringify(logs));

    // 撤销后任何 mcp 命令都回 MCP_UNAUTHORIZED；工具调用入口仍是"未开放"而不是"无权限"
    for (const command of ["mcp/list", "mcp/connect", "mcp/reconnect", "mcp/test", "mcp/testLog"]) {
      const res = await fx.invoke({ command, connectionId: id });
      assert.equal(res.error, "MCP_UNAUTHORIZED", command + " → " + JSON.stringify(res));
    }
    assert.equal(fx.mcpService.invokeTool({ connectionId: id, name: "echo_sum" }).error, "MCP_TOOL_INVOCATION_NOT_ENABLED");

    // 重新授予只给 mcp.view：连接状态仍可见，但工具描述不投影（toolsHidden）
    fx.store.upsertAppGrant({ appId: "mcp-center", resourceType: "mcp", actions: ["mcp.view"], grantedBy: "test", organizationId: fx.orgId });
    const listed = await fx.invoke({ command: "mcp/list" });
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].toolsHidden, true);
    assert.deepEqual(listed.items[0].tools, []);
    assert.equal(listed.items[0].toolsHash, null);
    assert.equal(JSON.stringify(listed).includes("echo_sum"), false, "无权时连工具名都不得出现");
  });
});

test("L4 · dispose 幂等；关应用的有界 dispose 超时/异常只留痕，不阻塞退出", async () => {
  const server = startEchoServer(["--http", "--port=0", "--get-sse", "--get-sse-notify-interval=25"]);
  try {
    const info = await server.ready;
    await withFixture(async (fx) => {
      const id = await createHttp(fx, info);
      await fx.invoke({ command: "mcp/connect", connectionId: id });
      const client = fx.mcpService.live.get(id).client;

      const first = await fx.mcpService.dispose({ reason: "app-quit" });
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal(first.closed, 1);
      assert.equal(first.ended, 1);
      assert.equal(client.diagnostics().stream.state, "closed");
      const row = recordOf(fx, id);
      assert.equal(row.status, "DISABLED");
      assert.equal(row.last_error_code, "MCP_SESSION_ENDED");
      assert.equal(row.enabled, 1);
      assert.equal(fx.mcpStore.logsOfConnection(id, 50).some((r) => r.event === "SESSION_ENDED" && r.detail === "app-quit"), true, "关应用的既有 detail 一个字符不变");

      const second = await fx.mcpService.dispose({ reason: "app-quit" });
      assert.deepEqual({ ok: second.ok, closed: second.closed, aborted: second.aborted, ended: second.ended }, { ok: true, closed: 0, aborted: 0, ended: 0 }, "dispose 必须幂等");
      assert.equal(fx.mcpStore.logsOfConnection(id, 50).filter((r) => r.event === "SESSION_ENDED").length, 1, "幂等：不得重复记录收尾日志");

      const bounded = await disposeMcpBounded({ service: fx.mcpService, timeoutMs: 500, reason: "app-quit" });
      assert.equal(bounded.ok, true, JSON.stringify(bounded));
      assert.equal(bounded.skipped, undefined);

      const started = Date.now();
      const hung = await disposeMcpBounded({ service: { dispose: () => new Promise(() => {}) }, timeoutMs: 60 });
      assert.equal(hung.ok, false);
      assert.equal(hung.error, "DISPOSE_TIMEOUT");
      assert.equal(Date.now() - started < 500, true, "超时必须兜底返回，不能阻塞退出");

      const failed = await disposeMcpBounded({ service: { dispose: async () => { throw new Error("boom"); } }, timeoutMs: 200 });
      assert.equal(failed.ok, false);
      assert.equal(failed.error, "boom");

      const skipped = await disposeMcpBounded({ service: null, timeoutMs: 10 });
      assert.equal(skipped.skipped, true);
      assert.equal(skipped.ok, true);
    }, { requestTimeoutMs: 3000 });
  } finally {
    server.stop();
  }
});

test("L5 · 登出中止在途握手：立刻结束、不留 live / opening，状态如实（DISABLED + MCP_SESSION_ENDED）", async () => {
  const server = startEchoServer(["--http", "--port=0", "--no-response"]);
  try {
    const info = await server.ready;
    await withFixture(async (fx) => {
      const id = await createHttp(fx, info);
      const pending = fx.invoke({ command: "mcp/connect", connectionId: id });
      await waitForState(info, (s) => (s.http.byMethod["initialize"] || 0) >= 1);
      assert.equal(fx.mcpService.opening.size, 1, "握手中的客户端必须在 opening 里可见");

      const out = await fx.identityService.dispatch({ type: "identity/logout" });
      assert.equal(out.ok, true);
      const res = await Promise.race([pending, new Promise((r) => setTimeout(() => r({ ok: false, error: "STILL-PENDING" }), 1200))]);
      assert.notEqual(res.error, "STILL-PENDING", "登出必须让在途握手立刻结束");
      assert.equal(res.ok, false);
      assert.equal(res.error, "MCP_SESSION_ENDED", "本地会话结束不得伪装成超时或连不上服务端");
      assert.equal(fx.mcpService.live.size, 0, "收尾后不得复活成活连接");
      assert.equal(fx.mcpService.opening.size, 0);
      assert.equal(fx.mcpService.openingOf.size, 0);
      const row = recordOf(fx, id);
      assert.equal(row.status, "DISABLED", "在途握手被会话收尾中止后不得复读成 READY/CONNECTING");
      assert.equal(row.last_error_code, "MCP_SESSION_ENDED");
      assert.equal(row.enabled, 1);
      const logs = fx.mcpStore.logsOfConnection(id, 50);
      assert.equal(logs.some((r) => r.event === "SESSION_ENDED"), true, JSON.stringify(logs));
      assert.equal(logs.some((r) => r.event === "CONNECT_FAILED"), false, "会话收尾不得记成一次连接失败");
    }, { requestTimeoutMs: 5000 });
  } finally {
    server.stop();
  }
});

// ---------------------------------------------------------------------------
// D5-03 第四批 · 会话自然到期也走同一条收流线
//
// 到期由身份服务层的**单一定时器**判定（定时器注入后可精确到点）；
// 事件 identity/session-expired → attachMcpSessionLifecycle → dispose，
// 与登出 / 锁屏完全同归属：只收连接与在途、只落状态，绝不改写 enabled。
// ---------------------------------------------------------------------------

const EXPIRY_IDLE_MS = 20_000;

test("L6 · 空闲自然过期：活连接与 GET 流立刻收掉，状态 DISABLED + MCP_SESSION_ENDED，enabled 不变", async () => {
  const server = startEchoServer(["--http", "--port=0", "--get-sse", "--get-sse-ids", "--get-sse-notify-interval=20"]);
  try {
    const info = await server.ready;
    const timers = fakeTimers();
    await withFixture(async (fx) => {
      const login = await fx.identityService.dispatch({ type: "identity/login", identifier: "admin@openarc.test", password: pw("admin") });
      assert.equal(login.ok, true, JSON.stringify(login));
      fx.identityRef.current = fx.identityService.current;
      const events = [];
      fx.identityService.onEvent((e) => events.push(e));

      const id = await createHttp(fx, info);
      const connected = await fx.invoke({ command: "mcp/connect", connectionId: id });
      assert.equal(connected.ok, true, JSON.stringify(connected));
      const client = fx.mcpService.live.get(id).client;
      assert.equal(client.diagnostics().stream.state, "open");
      const running = await waitForState(info, (s) => s.getSse.openStreams >= 1);
      assert.equal(running.getSse.openStreams >= 1, true, "连接后服务端侧 GET 流应当活着：" + JSON.stringify(running.getSse));

      const before = await fx.invoke({ command: "mcp/get", connectionId: id });
      assert.equal(before.ok, true, JSON.stringify(before));
      assert.equal(before.connection.tools.some((t) => t.name === "echo_sum"), true, "到期前工具照常投影：" + JSON.stringify(before.connection.tools));

      // 空闲期限到点：唯一定时器把"已过期"落成权威事实并 emit
      fx.advance(EXPIRY_IDLE_MS);
      await timers.fire();

      const settled = await waitFor(() => (fx.mcpService.live.size === 0 && fx.mcpService.opening.size === 0 && recordOf(fx, id).status === "DISABLED" ? true : null));
      assert.equal(settled, true, "空闲到期后不得留下活连接或握手中的客户端");
      assert.equal(client.diagnostics().stream.state, "closed");
      assert.equal(client.diagnostics().inflightRequests, 0);
      assert.equal(client.diagnostics().background, 0);
      const closed = await waitForState(info, (s) => s.getSse.openStreams === 0);
      assert.equal(closed.getSse.openStreams, 0, "到期后服务端侧 GET 流必须断开：" + JSON.stringify(closed.getSse));

      const row = recordOf(fx, id);
      assert.equal(row.status, "DISABLED", "到期后状态必须照实（未连接的 DISABLED），不能留 READY");
      assert.equal(row.last_error_code, "MCP_SESSION_ENDED", "为什么变成 DISABLED 必须留痕：会话结束");
      assert.equal(row.enabled, 1, "enabled 是用户意图，到期不得改写");
      const logs = fx.mcpStore.logsOfConnection(id, 50);
      /* 口径：到期这条路径的 detail 自带 expired: 前缀 —— 光看 "idle" 读不出这是会话自然过期；
         登出 / 锁屏 / 关应用 / 撤权仍用各自的既有 detail（L1 / L2 / L3 / L4 各自盯着）。 */
      assert.equal(logs.some((r) => r.event === "SESSION_ENDED" && r.detail === "expired:idle"), true, JSON.stringify(logs));
      assert.equal(logs.some((r) => r.event === "SESSION_ENDED" && r.detail === "idle"), false, "不得再落裸的 idle：" + JSON.stringify(logs));

      // 新事件的 payload：起约束作用的那条上限 + 会话标识
      const expired = events.filter((e) => e.event === "identity/session-expired");
      assert.equal(expired.length, 1, "只 emit 一次");
      assert.equal(expired[0].reason, "idle");
      assert.equal(expired[0].sessionId, fx.identity.sessionByRef(expired[0].sessionRef).id);

      // 没有会话：命令照旧被拒，工具名 / 描述 / hash 一律不再投影
      const listed = await fx.invoke({ command: "mcp/list" });
      assert.equal(listed.error, "MCP_UNAUTHORIZED", JSON.stringify(listed));
      assert.equal(JSON.stringify(listed).includes("echo_sum"), false, "会话结束后连工具名都不得出现");
      assert.equal((await fx.invoke({ command: "mcp/connect", connectionId: id })).error, "MCP_UNAUTHORIZED");
      assert.equal(fx.mcpService.invokeTool({ connectionId: id, name: "echo_sum" }).error, "MCP_TOOL_INVOCATION_NOT_ENABLED");

      // 重新登录：不重新配置、不重新启用，直接 connect 就恢复
      const again = await fx.identityService.dispatch({ type: "identity/login", identifier: "admin@openarc.test", password: pw("admin") });
      assert.equal(again.ok, true, JSON.stringify(again));
      fx.identityRef.current = fx.identityService.current;
      const reconnected = await fx.invoke({ command: "mcp/connect", connectionId: id });
      assert.equal(reconnected.ok, true, JSON.stringify(reconnected));
      assert.equal(recordOf(fx, id).status, "READY");
      assert.equal(recordOf(fx, id).enabled, 1);
    }, { requestTimeoutMs: 3000, idleMs: EXPIRY_IDLE_MS, ttlMs: 12 * 60 * 60 * 1000, timers });
  } finally {
    server.stop();
  }
});

test("L7 · 旧会话到期不关随后登录的新会话：旧安排已出队也动不了新连接", async () => {
  const IDLE_MS = 15_000;
  const timers = fakeTimers();
  await withFixture(async (fx) => {
    const first = await fx.identityService.dispatch({ type: "identity/login", identifier: "admin@openarc.test", password: pw("admin") });
    assert.equal(first.ok, true, JSON.stringify(first));
    const firstRef = first.snapshot.sessionRef;
    fx.identityRef.current = firstRef;
    const events = [];
    fx.identityService.onEvent((e) => events.push(e));
    const stale = timers.history[0];
    assert.equal(!!stale, true, "登录必须排一次到期");

    const created = await fx.createLocal();
    const id = created.connection.connectionId;
    await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
    const connected = await fx.invoke({ command: "mcp/connect", connectionId: id });
    assert.equal(connected.ok, true, JSON.stringify(connected));
    assert.equal(fx.mcpService.live.size, 1);

    // 用户重新登录 → 新会话；旧安排被取消，但真实竞态里那个回调可能已经出队
    const second = await fx.identityService.dispatch({ type: "identity/login", identifier: "admin@openarc.test", password: pw("admin") });
    assert.equal(second.ok, true, JSON.stringify(second));
    const secondRef = second.snapshot.sessionRef;
    assert.notEqual(secondRef, firstRef, "重新登录必须是一条新会话");
    fx.identityRef.current = secondRef;
    assert.equal(stale.cleared, true, "重新登录后旧安排必须被取消");
    assert.equal(timers.pending(), 1, "在途定时器仍然只有一个（新会话的）");

    // 旧到期时间到
    fx.advance(IDLE_MS);
    await stale.fn();
    await timers.settle();

    assert.equal(events.filter((e) => e.event === "identity/session-expired").length, 0, "旧到期不得 emit");
    assert.equal(fx.identityService.current, secondRef, "旧到期不得把当前会话收掉");
    assert.equal(fx.identity.sessionByRef(firstRef).revoked_at, null, "旧到期不得去动别的世代");
    assert.equal(fx.identity.sessionByRef(secondRef).revoked_at, null, "旧到期不得终结新会话");
    assert.equal(fx.mcpService.live.size, 1, "旧到期不得收掉新会话的活连接");
    assert.equal(recordOf(fx, id).status, "READY");
    assert.equal(recordOf(fx, id).last_error_code ?? null, null, "不得留下任何会话结束痕迹");
  }, { requestTimeoutMs: 3000, idleMs: IDLE_MS, ttlMs: 12 * 60 * 60 * 1000, timers });
});

test("L8 · 事件登记：identity/session-expired 与登出 / 锁屏走同一条收流线", () => {
  assert.equal(MCP_SESSION_END_EVENTS["identity/session-expired"], "expired");
  assert.equal(MCP_SESSION_END_EVENTS["identity/logged-out"], "logout");
  assert.equal(MCP_SESSION_END_EVENTS["identity/locked"], "lock");
  assert.deepEqual(Object.keys(MCP_SESSION_END_EVENTS).sort(), ["identity/locked", "identity/logged-out", "identity/session-expired"]);
});

test("L9 · 绝对到期：连接日志 detail 是 expired:absolute，登出 / 锁屏 / 关应用 / 撤权的既有 detail 不变", async () => {
  const TTL_MS = 12_000;
  const timers = fakeTimers();
  await withFixture(async (fx) => {
    const login = await fx.identityService.dispatch({ type: "identity/login", identifier: "admin@openarc.test", password: pw("admin") });
    assert.equal(login.ok, true, JSON.stringify(login));
    fx.identityRef.current = fx.identityService.current;

    const created = await fx.createLocal();
    const id = created.connection.connectionId;
    await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
    const connected = await fx.invoke({ command: "mcp/connect", connectionId: id });
    assert.equal(connected.ok, true, JSON.stringify(connected));
    assert.equal(fx.mcpService.live.size, 1);

    // 绝对上限（ttl）先到、空闲上限远在其后 → 到期原因是 absolute
    fx.advance(TTL_MS);
    await timers.fire();

    const settled = await waitFor(() => (fx.mcpService.live.size === 0 && recordOf(fx, id).status === "DISABLED" ? true : null));
    assert.equal(settled, true, "绝对到期后不得留下活连接，状态必须照实收敛");
    const row = recordOf(fx, id);
    assert.equal(row.last_error_code, "MCP_SESSION_ENDED", "为什么变成 DISABLED 必须留痕：会话结束");
    assert.equal(row.enabled, 1, "enabled 是用户意图，到期不得改写");

    const logs = fx.mcpStore.logsOfConnection(id, 50);
    assert.equal(logs.some((r) => r.event === "SESSION_ENDED" && r.detail === "expired:absolute"), true, JSON.stringify(logs));
    assert.equal(logs.some((r) => r.event === "SESSION_ENDED" && r.detail === "absolute"), false, "不得再落裸的 absolute：" + JSON.stringify(logs));
    assert.equal(logs.filter((r) => r.event === "SESSION_ENDED").length, 1, "只记一条收尾日志（与 L6 同一份幂等语义）");
    // 其余收尾路径的 detail 由 L1（logout）/ L2（user）/ L3（app-grant-revoked）/ L4（app-quit）各自盯着
  }, { requestTimeoutMs: 3000, ttlMs: TTL_MS, idleMs: 60 * 60 * 1000, timers });
});

