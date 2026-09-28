/**
 * D5-03 第三批 · streamable HTTP 流式收口（GET server→client 流）。
 *
 * 服务端行为全部来自自建受控 fixture（tests/fixtures/mcp/echo-server.mjs，只监听 127.0.0.1）；
 * 断言同时看客户端投影与 GET /__state 的服务端统计。
 *
 * 覆盖：405/404/501 = 不支持（POST 保持可用）/ 带 id 的断线续传只重放其后事件 /
 *       无 id 不续传不重放 / 重复事件去重 / 服务端请求一律 -32601 且真的回了服务端 /
 *       重连有界（耗尽后 unavailable，不静默无限重连）/ 重连 404 = 会话失效。
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

async function createHttp(fx, info, name = "GET 流") {
  const created = await fx.invoke({ command: "mcp/create", name, transport: "http", location: "REMOTE_SERVICE", endpoint: { url: info.url }, authMode: "NONE", visibility: "PERSONAL" });
  assert.equal(created.ok, true, JSON.stringify(created));
  const id = created.connection.connectionId;
  await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
  return id;
}

const recordOf = (fx, id) => fx.identity.connection.prepare("SELECT * FROM mcp_connections WHERE connection_id = ?").get(id);
const liveClient = (fx, id) => { const entry = fx.mcpService.live.get(id); return entry ? entry.client : null; };

test("G1 · GET 返回 405：连接保持 READY，POST 工具发现照常可用（不把连接判 ERROR）", async () => {
  const server = startEchoServer(["--http", "--port=0"]); // 默认对 GET 回 405
  try {
    const info = await server.ready;
    await withFixture(async (fx) => {
      const id = await createHttp(fx, info);
      const res = await fx.invoke({ command: "mcp/connect", connectionId: id });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.connection.status, "READY");
      assert.equal(res.connection.lastErrorCode, null);
      assert.equal(res.connection.getStream.state, "unsupported");
      assert.equal(res.connection.getStream.status, 405);
      assert.equal(res.connection.getStream.supported, false);
      assert.deepEqual(res.connection.tools.map((t) => t.name), ECHO.tools);
      const st = await stateOf(info);
      assert.equal(st.getSse.rejected >= 1, true, JSON.stringify(st.getSse));
      assert.equal(st.http.byMethod["tools/list"], 1);
      // 405 之后 POST 仍可用：再 test 一次（真实重新握手 + 重新工具发现）
      const tested = await fx.invoke({ command: "mcp/test", connectionId: id });
      assert.equal(tested.ok, true, JSON.stringify(tested));
      assert.equal(tested.connection.status, "READY");
      assert.equal(tested.negotiated.tools.length, 2);
      assert.equal(tested.negotiated.stream.supported, false);
      assert.equal((await stateOf(info)).http.byMethod["tools/list"] >= 2, true);
    });
  } finally {
    server.stop();
  }
});

test("G2 · GET 404 / 501 同样只是「不支持」：连接照常 READY，POST 可用", async () => {
  for (const status of [404, 501]) {
    const server = startEchoServer(["--http", "--port=0", "--get-unavailable=" + status]);
    try {
      const info = await server.ready;
      await withFixture(async (fx) => {
        const id = await createHttp(fx, info);
        const res = await fx.invoke({ command: "mcp/connect", connectionId: id });
        assert.equal(res.ok, true, status + " → " + JSON.stringify(res));
        assert.equal(res.connection.status, "READY", String(status));
        assert.equal(res.connection.getStream.state, "unsupported", String(status));
        assert.equal(res.connection.getStream.status, status);
        assert.deepEqual(res.connection.tools.map((t) => t.name), ECHO.tools);
        assert.equal((await stateOf(info)).getSse.rejected >= 1, true);
      });
    } finally {
      server.stop();
    }
  }
});

test("G3 · GET SSE + 服务端给 id：重连带 Last-Event-ID，只重放其后事件；重连有界", async () => {
  const server = startEchoServer(["--http", "--port=0", "--get-sse", "--get-sse-ids", "--get-sse-replay", "--get-sse-close-after=1", "--get-sse-notify-interval=20"]);
  try {
    const info = await server.ready;
    await withFixture(async (fx) => {
      const id = await createHttp(fx, info);
      const res = await fx.invoke({ command: "mcp/connect", connectionId: id });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.connection.status, "READY");
      assert.equal(res.connection.getStream.state, "open");
      assert.equal(res.connection.getStream.supported, true);
      const client = liveClient(fx, id);
      const settled = await waitFor(() => { const d = client.diagnostics(); return d.stream.state === "unavailable" ? d : null; }, { timeoutMs: 3000 });
      assert.equal(!!settled, true, JSON.stringify(client.diagnostics()));
      assert.equal(settled.stream.reconnects, 1, "streamReconnectAttempts=1：有界重连一次后收敛");
      assert.equal(settled.stream.hasLastEventId, true);
      assert.equal(settled.events.total, 2, "两个不同事件各处理一次（续传不产生重复结果）：" + JSON.stringify(settled.events));
      assert.equal(settled.events.duplicates, 0);
      const st = await stateOf(info);
      assert.equal(st.getSse.opens, 2, "服务端结束流后客户端重连了一次：" + JSON.stringify(st.getSse));
      assert.equal(st.getSse.lastEventIdSeen, "1", "重连必须带 Last-Event-ID=1：" + JSON.stringify(st.getSse));
      assert.equal(st.getSse.replayedFrom, 1, "只重放 Last-Event-ID 之后的事件：" + JSON.stringify(st.getSse));
      assert.equal(st.getSse.replays, 1);
      assert.equal(st.getSse.distinctSent, 2, "不重复投递已完成的事件：" + JSON.stringify(st.getSse));
      const view = await fx.invoke({ command: "mcp/get", connectionId: id });
      assert.equal(view.connection.status, "READY", "GET 流耗尽不得把连接判 ERROR");
      assert.equal(view.connection.getStream.state, "unavailable");
      assert.equal(view.connection.getStream.reconnects, 1);
      assert.equal(view.connection.getStream.hasLastEventId, true);
      assert.equal(view.connection.getStream.events.total, 2);
    }, { requestTimeoutMs: 3000, clientFactory: () => new McpClient({ requestTimeoutMs: 3000, streamReconnectAttempts: 1 }) });
  } finally {
    server.stop();
  }
});

test("G4 · GET SSE 无事件 id：不续传（不发 Last-Event-ID、不重放），也不重复投递", async () => {
  const server = startEchoServer(["--http", "--port=0", "--get-sse", "--get-sse-close-after=1", "--get-sse-notify-interval=20"]);
  try {
    const info = await server.ready;
    await withFixture(async (fx) => {
      const id = await createHttp(fx, info);
      const res = await fx.invoke({ command: "mcp/connect", connectionId: id });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.connection.getStream.hasLastEventId, false);
      const client = liveClient(fx, id);
      const settled = await waitFor(() => { const d = client.diagnostics(); return d.stream.state === "unavailable" ? d : null; }, { timeoutMs: 3000 });
      assert.equal(!!settled, true, JSON.stringify(client.diagnostics()));
      assert.equal(settled.stream.reconnects >= 1, true, "断线后确实重连了：" + JSON.stringify(settled.stream));
      assert.equal(settled.stream.hasLastEventId, false, "没有 id 就不许记 Last-Event-ID");
      const st = await stateOf(info);
      assert.equal(st.getSse.opens >= 2, true, JSON.stringify(st.getSse));
      assert.equal(st.getSse.lastEventIdSeen, null, "没有 id 就不许发 Last-Event-ID：" + JSON.stringify(st.getSse));
      assert.equal(st.getSse.replays, 0, "没有 id 就不许续传/重放");
      assert.equal(st.getSse.replayedFrom, null);
      assert.equal(settled.events.total, st.getSse.distinctSent, "事件既不重复也不丢：" + JSON.stringify({ total: settled.events.total, sent: st.getSse.distinctSent }));
      assert.equal(settled.events.duplicates, 0);
      const view = await fx.invoke({ command: "mcp/get", connectionId: id });
      assert.equal(view.connection.status, "READY", "GET 流耗尽不得把连接判 ERROR");
    }, { requestTimeoutMs: 3000, clientFactory: () => new McpClient({ requestTimeoutMs: 3000, streamReconnectAttempts: 1 }) });
  } finally {
    server.stop();
  }
});

test("G5 · 重复事件（同一 id 重发）被识别去重，不产生新的结果", async () => {
  const server = startEchoServer(["--http", "--port=0", "--get-sse", "--get-sse-ids", "--get-sse-duplicate", "--get-sse-close-after=2", "--get-sse-notify-interval=20"]);
  try {
    const info = await server.ready;
    await withFixture(async (fx) => {
      const id = await createHttp(fx, info);
      const res = await fx.invoke({ command: "mcp/connect", connectionId: id });
      assert.equal(res.ok, true, JSON.stringify(res));
      const client = liveClient(fx, id);
      const settled = await waitFor(() => { const d = client.diagnostics(); return d.stream.state === "unavailable" ? d : null; }, { timeoutMs: 3000 });
      assert.equal(!!settled, true, JSON.stringify(client.diagnostics()));
      const st = await stateOf(info);
      assert.equal(st.getSse.duplicatesSent >= 2, true, "服务端确实重发了同一 id：" + JSON.stringify(st.getSse));
      assert.equal(st.getSse.replays, 0, "没有 --get-sse-replay：重连不重放");
      assert.equal(settled.stream.reconnects, 1);
      assert.equal(settled.events.duplicates, st.getSse.duplicatesSent, "重复事件必须被识别：" + JSON.stringify({ client: settled.events, server: st.getSse }));
      assert.equal(settled.events.total, st.getSse.distinctSent, "每个 id 只当一次结果：" + JSON.stringify({ client: settled.events, server: st.getSse }));
      assert.equal(st.getSse.distinctSent, 4);
      assert.equal(st.getSse.duplicatesSent, 4);
      assert.equal(settled.events.total, 4);
    }, { requestTimeoutMs: 3000, clientFactory: () => new McpClient({ requestTimeoutMs: 3000, streamReconnectAttempts: 1 }) });
  } finally {
    server.stop();
  }
});

test("G6 · GET 流上的服务端请求一律 -32601：不执行工具，且错误真的回了服务端（证据计数）", async () => {
  const server = startEchoServer(["--http", "--port=0", "--get-sse", "--get-sse-ids", "--server-request-after=1", "--get-sse-notify-interval=20"]);
  try {
    const info = await server.ready;
    await withFixture(async (fx) => {
      const id = await createHttp(fx, info);
      const res = await fx.invoke({ command: "mcp/connect", connectionId: id });
      assert.equal(res.ok, true, JSON.stringify(res));
      const client = liveClient(fx, id);
      const st = await waitForState(info, (s) => s.serverRequests.responses.some((r) => r.code === -32601));
      const answered = st.serverRequests.responses.filter((r) => r.code === -32601);
      assert.equal(st.serverRequests.sent >= 1, true, JSON.stringify(st.serverRequests));
      assert.equal(answered.length >= 1, true, "服务端必须收到 -32601：" + JSON.stringify(st.serverRequests));
      assert.equal(answered[0].id, "srv-1");
      const diag = client.diagnostics();
      assert.equal(diag.unsupportedServerRequests >= 1, true, "证据计数必须保留：" + JSON.stringify(diag));
      assert.equal(fx.mcpService.invokeTool({}).error, "MCP_TOOL_INVOCATION_NOT_ENABLED");
      const view = await fx.invoke({ command: "mcp/get", connectionId: id });
      assert.equal(view.connection.status, "READY");
    }, { requestTimeoutMs: 3000 });
  } finally {
    server.stop();
  }
});

test("G7 · GET 重连返回 404 → 会话失效：连接如实转 ERROR，流与在途被 abort，无悬挂", async () => {
  const server = startEchoServer(["--http", "--port=0", "--get-sse", "--get-sse-close-after=1", "--get-sse-reconnect-404", "--get-sse-notify-interval=20"]);
  try {
    const info = await server.ready;
    await withFixture(async (fx) => {
      const id = await createHttp(fx, info);
      const res = await fx.invoke({ command: "mcp/connect", connectionId: id });
      assert.equal(res.ok, true, JSON.stringify(res));
      const client = liveClient(fx, id);
      assert.equal(client.diagnostics().stream.state, "open");
      const st = await waitForState(info, (s) => s.getSse.reconnect404 >= 1);
      assert.equal(st.getSse.reconnect404 >= 1, true, "重连确实撞上了 404：" + JSON.stringify(st.getSse));
      const gone = await waitFor(() => (fx.mcpService.live.size === 0 ? true : null), { timeoutMs: 2000 });
      assert.equal(gone, true, "会话失效后 live 不得留下连接");
      const row = recordOf(fx, id);
      assert.equal(row.status, "ERROR");
      assert.equal(row.last_error_code, "MCP_SESSION_EXPIRED");
      const diag = client.diagnostics();
      assert.equal(diag.sessionExpired, true);
      assert.equal(diag.stream.state, "closed");
      assert.equal(diag.stream.error, "MCP_SESSION_EXPIRED");
      assert.equal(diag.inflightRequests, 0);
      const log = await fx.invoke({ command: "mcp/testLog", connectionId: id });
      assert.equal(log.items.some((x) => x.event === "SESSION_INVALID" && x.errorCode === "MCP_SESSION_EXPIRED"), true, JSON.stringify(log.items));
      const view = await fx.invoke({ command: "mcp/get", connectionId: id });
      assert.equal(view.connection.status, "ERROR");
      assert.equal(view.connection.lastErrorCode, "MCP_SESSION_EXPIRED");
      assert.equal("getStream" in view.connection, false, "没有活连接就不该有实时流状态");
    }, { requestTimeoutMs: 3000 });
  } finally {
    server.stop();
  }
});
