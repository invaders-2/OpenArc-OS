/**
 * D5-03 第三批 · streamable HTTP 流式收口（POST 侧）。
 *
 * 全部对着自建受控 fixture（tests/fixtures/mcp/echo-server.mjs，只监听 127.0.0.1）断言，
 * 既看客户端结果，也看服务端"实际看到了什么"（GET /__state 统计），不连任何第三方。
 *
 * 覆盖：响应先到即完成（不等流结束）/ 半包跨 chunk / 超大事件明确失败 / 只推通知的有界超时 /
 *       流中断不重发 / 会话失效（404 与 400 信号）/ 收尾（停用、删除、dispose）不留悬挂。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createMcpFixture, startEchoServer, waitFor, McpClient, ECHO } from "./mcp-fixtures.mjs";

async function withFixture(fn, options = {}) {
  const fx = await createMcpFixture(options);
  try {
    return await fn(fx);
  } finally {
    await fx.close();
  }
}

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
async function createHttp(fx, info, name = "流式 HTTP") {
  const created = await fx.invoke({ command: "mcp/create", name, transport: "http", location: "REMOTE_SERVICE", endpoint: { url: info.url }, authMode: "NONE", visibility: "PERSONAL" });
  assert.equal(created.ok, true, JSON.stringify(created));
  const id = created.connection.connectionId;
  await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
  return id;
}

const recordOf = (fx, id) => fx.identity.connection.prepare("SELECT * FROM mcp_connections WHERE connection_id = ?").get(id);
const liveClient = (fx, id) => { const entry = fx.mcpService.live.get(id); return entry ? entry.client : null; };

test("S1 · POST 的 SSE 流：响应事件到达即完成请求，不等服务端结束流（时间 + 服务端侧证据）", async () => {
  // 服务端先推一条通知、再回响应，然后持续推通知且永不结束流 —— 旧实现 res.text() 会挂到超时
  const server = startEchoServer(["--http", "--port=0", "--sse-stream", "--sse-notify-interval=25"]);
  try {
    const info = await server.ready;
    await withFixture(async (fx) => {
      const id = await createHttp(fx, info);
      const started = Date.now();
      const res = await fx.invoke({ command: "mcp/connect", connectionId: id });
      const elapsed = Date.now() - started;
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.connection.status, "READY");
      assert.deepEqual(res.connection.tools.map((t) => t.name), ECHO.tools);
      assert.equal(elapsed < 1200, true, "匹配响应必须早于请求超时完成，实际 " + elapsed + "ms");
      const client = liveClient(fx, id);
      const diag = client.diagnostics();
      // 响应之前那条通知已经被增量解析（不是等整段流结束再一次性解析）
      assert.equal(diag.notifications.includes("notifications/message"), true, JSON.stringify(diag.notifications));
      assert.equal(diag.events.total >= 4, true, JSON.stringify(diag.events));
      const st = await waitForState(info, (s) => s.postSse.closedByClient >= 2);
      assert.equal(st.postSse.streams >= 2, true, JSON.stringify(st.postSse));
      assert.equal(st.postSse.notifications >= 2, true, "响应前的通知确实发了：" + JSON.stringify(st.postSse));
      assert.equal(st.postSse.closedByClient >= 2, true, "拿到响应后必须立刻释放 POST 流：" + JSON.stringify(st.postSse));
      assert.equal(st.http.byMethod["initialize"], 1);
      assert.equal(st.http.byMethod["tools/list"], 1);
    }, { requestTimeoutMs: 3000 });
  } finally {
    server.stop();
  }
});

test("S2 · SSE 半包跨 chunk 正确拼接（服务端按 5 字符分片写入仍能解析出匹配响应）", async () => {
  const server = startEchoServer(["--http", "--port=0", "--sse-split"]);
  try {
    const info = await server.ready;
    await withFixture(async (fx) => {
      const id = await createHttp(fx, info);
      const res = await fx.invoke({ command: "mcp/connect", connectionId: id });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.connection.status, "READY");
      assert.deepEqual(res.connection.tools.map((t) => t.name), ECHO.tools);
      const st = await waitForState(info, (s) => s.postSse.splitWrites >= 30);
      assert.equal(st.postSse.splitWrites >= 30, true, "半包确实发生了：" + JSON.stringify(st.postSse));
      assert.equal(st.postSse.streams >= 2, true, JSON.stringify(st.postSse));
    }, { requestTimeoutMs: 4000 });
  } finally {
    server.stop();
  }
});

test("S3 · 单个事件超界 → MCP_STREAM_EVENT_TOO_LARGE（有界，不无限缓冲、不重发）", async () => {
  const server = startEchoServer(["--http", "--port=0", "--sse-event-bytes=65536"]);
  try {
    const info = await server.ready;
    await withFixture(async (fx) => {
      const id = await createHttp(fx, info);
      const started = Date.now();
      const res = await fx.invoke({ command: "mcp/connect", connectionId: id });
      const elapsed = Date.now() - started;
      assert.equal(res.ok, false, JSON.stringify(res));
      assert.equal(res.error, "MCP_STREAM_EVENT_TOO_LARGE");
      assert.equal(recordOf(fx, id).status, "ERROR");
      assert.equal(recordOf(fx, id).last_error_code, "MCP_STREAM_EVENT_TOO_LARGE");
      assert.equal(elapsed < 1500, true, "超界必须立即失败，实际 " + elapsed + "ms");
      const st = await waitForState(info, (s) => s.postSse.bigEvents >= 1);
      assert.equal(st.postSse.bigEvents >= 1, true, JSON.stringify(st.postSse));
      assert.equal(st.http.byMethod["initialize"], 1, "失败后不得自动重发");
      assert.equal(st.http.byMethod["tools/list"] || 0, 0);
      assert.equal(fx.mcpService.live.size, 0);
      assert.equal(fx.mcpService.opening.size, 0);
    }, { requestTimeoutMs: 3000, clientFactory: () => new McpClient({ requestTimeoutMs: 3000, maxEventBytes: 4096 }) });
  } finally {
    server.stop();
  }
});

test("S4 · 流一直只推通知、不给响应 → 有界 MCP_TIMEOUT（不悬挂、不假装成功）", async () => {
  const server = startEchoServer(["--http", "--port=0", "--sse-notify-only", "--sse-notify-interval=20"]);
  try {
    const info = await server.ready;
    await withFixture(async (fx) => {
      const id = await createHttp(fx, info);
      const started = Date.now();
      const res = await fx.invoke({ command: "mcp/connect", connectionId: id });
      const elapsed = Date.now() - started;
      assert.equal(res.ok, false, JSON.stringify(res));
      assert.equal(res.error, "MCP_TIMEOUT");
      assert.equal(elapsed < 2500, true, "超时必须有界，实际 " + elapsed + "ms");
      assert.equal(elapsed >= 350, true, "不得早于请求超时就失败，实际 " + elapsed + "ms");
      assert.equal(recordOf(fx, id).status, "ERROR");
      assert.equal(recordOf(fx, id).last_error_code, "MCP_TIMEOUT");
      const st = await waitForState(info, (s) => s.postSse.notifications >= 2);
      assert.equal(st.postSse.notifications >= 2, true, "服务端确实推了通知但没有响应：" + JSON.stringify(st.postSse));
      assert.equal(st.http.byMethod["initialize"], 1, "超时后不得自动重发");
    }, { requestTimeoutMs: 600 });
  } finally {
    server.stop();
  }
});

test("S5 · 流中断（服务端 destroy 且无响应）→ MCP_STREAM_INTERRUPTED，请求级不重发", async () => {
  const server = startEchoServer(["--http", "--port=0", "--sse-drop-after=2", "--sse-notify-interval=20"]);
  try {
    const info = await server.ready;
    await withFixture(async (fx) => {
      const id = await createHttp(fx, info);
      const started = Date.now();
      const res = await fx.invoke({ command: "mcp/connect", connectionId: id });
      const elapsed = Date.now() - started;
      assert.equal(res.ok, false, JSON.stringify(res));
      assert.equal(res.error, "MCP_STREAM_INTERRUPTED");
      assert.equal(elapsed < 2000, true, "中断必须快速失败，实际 " + elapsed + "ms");
      assert.equal(recordOf(fx, id).status, "ERROR");
      assert.equal(recordOf(fx, id).last_error_code, "MCP_STREAM_INTERRUPTED");
      const st = await waitForState(info, (s) => s.postSse.droppedByServer >= 1);
      assert.equal(st.postSse.droppedByServer >= 1, true, JSON.stringify(st.postSse));
      assert.equal(st.http.byMethod["initialize"], 1, "流中断后客户端不得自动重发 initialize");
      // 显式重连是调用方的决定：每次尝试也只发一次 initialize
      const again = await fx.invoke({ command: "mcp/reconnect", connectionId: id });
      assert.equal(again.ok, false);
      assert.equal(again.error, "MCP_STREAM_INTERRUPTED");
      assert.equal(again.attempts, 1);
      assert.equal((await stateOf(info)).http.byMethod["initialize"], 2, "重连=一次新握手，不是偷偷重发");
    }, { requestTimeoutMs: 2000, reconnectAttempts: 1 });
  } finally {
    server.stop();
  }
});

test("S6 · 会话失效（404 / 400 + session 信号）→ MCP_SESSION_EXPIRED，记录如实且立刻收尾", async () => {
  for (const statusFlag of ["--session-expire-status=404", "--session-expire-status=400"]) {
    const server = startEchoServer(["--http", "--port=0", "--session-expire-after=1", statusFlag]);
    try {
      const info = await server.ready;
      await withFixture(async (fx) => {
        const id = await createHttp(fx, info);
        const res = await fx.invoke({ command: "mcp/connect", connectionId: id });
        assert.equal(res.ok, false, statusFlag + " → " + JSON.stringify(res));
        assert.equal(res.error, "MCP_SESSION_EXPIRED", statusFlag);
        const row = recordOf(fx, id);
        assert.equal(row.status, "ERROR", statusFlag);
        assert.equal(row.last_error_code, "MCP_SESSION_EXPIRED", statusFlag);
        assert.equal(fx.mcpService.live.size, 0, "失效后不得留下'看着还在连'的活连接");
        assert.equal(fx.mcpService.opening.size, 0);
        const st = await stateOf(info);
        assert.equal(st.session.expired >= 1, true, JSON.stringify(st.session));
        assert.equal(st.http.byMethod["tools/list"], 1, "会话失效后不得静默重发 tools/list");
        const log = await fx.invoke({ command: "mcp/testLog", connectionId: id });
        assert.equal(log.items.some((x) => x.errorCode === "MCP_SESSION_EXPIRED"), true, JSON.stringify(log.items));
      }, { requestTimeoutMs: 2000 });
    } finally {
      server.stop();
    }
  }
});

test("S7 · 收尾：停用 / 删除主动 abort GET 流，状态如实（DISABLED），服务端侧流确实断开", async () => {
  const server = startEchoServer(["--http", "--port=0", "--get-sse", "--get-sse-ids", "--get-sse-notify-interval=20"]);
  try {
    const info = await server.ready;
    await withFixture(async (fx) => {
      const id = await createHttp(fx, info);
      const res = await fx.invoke({ command: "mcp/connect", connectionId: id });
      assert.equal(res.ok, true, JSON.stringify(res));
      const client = liveClient(fx, id);
      assert.equal(client.diagnostics().stream.state, "open");
      assert.equal(client.diagnostics().inflightRequests, 0);
      const running = await waitForState(info, (s) => s.getSse.distinctSent >= 2);
      assert.equal(running.getSse.openStreams >= 1, true, JSON.stringify(running.getSse));

      const off = await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: false });
      assert.equal(off.connection.status, "DISABLED");
      assert.equal(fx.mcpService.live.size, 0);
      const afterOff = client.diagnostics();
      assert.equal(afterOff.stream.state, "closed");
      assert.equal(afterOff.inflightRequests, 0);
      assert.equal(afterOff.background, 0);
      const closed = await waitForState(info, (s) => s.getSse.openStreams === 0);
      assert.equal(closed.getSse.openStreams, 0, "停用后服务端侧 GET 流必须已断开：" + JSON.stringify(closed.getSse));

      await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
      const again = await fx.invoke({ command: "mcp/connect", connectionId: id });
      assert.equal(again.ok, true, JSON.stringify(again));
      const client2 = liveClient(fx, id);
      await waitForState(info, (s) => s.getSse.opens >= 2);
      const del = await fx.invoke({ command: "mcp/delete", connectionId: id });
      assert.equal(del.ok, true);
      assert.equal(fx.mcpService.live.size, 0);
      assert.equal(client2.diagnostics().stream.state, "closed");
      assert.equal(client2.diagnostics().inflightRequests, 0);
      const closed2 = await waitForState(info, (s) => s.getSse.openStreams === 0);
      assert.equal(closed2.getSse.openStreams, 0, "删除后服务端侧 GET 流必须已断开：" + JSON.stringify(closed2.getSse));
    }, { requestTimeoutMs: 3000 });
  } finally {
    server.stop();
  }
});

test("S8 · 应用关闭（dispose）abort 还在握手中的请求：立刻结束，不留悬挂", async () => {
  const server = startEchoServer(["--http", "--port=0", "--no-response"]);
  try {
    const info = await server.ready;
    await withFixture(async (fx) => {
      const id = await createHttp(fx, info);
      const started = Date.now();
      const pending = fx.invoke({ command: "mcp/connect", connectionId: id });
      await waitForState(info, (s) => (s.http.byMethod["initialize"] || 0) >= 1);
      assert.equal(fx.mcpService.opening.size, 1, "握手中的客户端必须在 opening 里可见");
      const disposed = await fx.mcpService.dispose();
      assert.equal(disposed.aborted >= 1, true, JSON.stringify(disposed));
      const res = await Promise.race([pending, new Promise((r) => setTimeout(() => r({ ok: false, error: "STILL-PENDING" }), 800))]);
      const elapsed = Date.now() - started;
      assert.notEqual(res.error, "STILL-PENDING", "dispose 必须让在途握手立刻结束");
      assert.equal(res.ok, false);
      assert.equal(elapsed < 700, true, "握手必须在 dispose 后立刻结束，实际 " + elapsed + "ms");
      assert.equal(fx.mcpService.live.size, 0);
      assert.equal(fx.mcpService.opening.size, 0);
    }, { requestTimeoutMs: 5000 });
  } finally {
    server.stop();
  }
});
