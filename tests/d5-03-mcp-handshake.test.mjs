/**
 * D5-03 第一批 · MCP 真实握手与能力发现（stdio + streamable HTTP）。
 *
 * 对着自建的受控测试服务断言**服务端实际返回**的
 * protocolVersion / serverInfo / capabilities / tools —— 不是对着客户端自己的常量。
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createMcpFixture, startEchoServer, recordingLauncher, waitFor, pidAlive, ECHO, ECHO_HTTP_PATH, McpClient } from "./mcp-fixtures.mjs";

async function withFixture(fn, options = {}) {
  const fx = await createMcpFixture(options);
  try {
    return await fn(fx);
  } finally {
    await fx.close();
  }
}

/** 直接读记录（断言"实际写进库里的协商结果"）。 */
const recordOf = (fx, id) => fx.identity.connection.prepare("SELECT * FROM mcp_connections WHERE connection_id = ?").get(id);

test("B1 · stdio 真实握手：initialize + tools/list，协商结果与 fixture 实际值一致", async () => {
  await withFixture(async (fx) => {
    const created = await fx.createLocal({ name: "stdio 回显" });
    const id = created.connection.connectionId;
    await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
    const res = await fx.invoke({ command: "mcp/connect", connectionId: id });
    assert.equal(res.ok, true, JSON.stringify(res));
    const c = res.connection;
    assert.equal(c.status, "READY");
    assert.equal(c.lastErrorCode, null);
    assert.equal(c.protocolVersion, ECHO.protocolVersion);
    assert.equal(c.serverName, ECHO.serverName);
    assert.equal(c.serverVersion, ECHO.serverVersion);
    assert.deepEqual(c.capabilities, { tools: { listChanged: false }, logging: {} });
    assert.deepEqual(c.tools.map((t) => t.name), ECHO.tools);
    assert.equal(c.tools[0].description, "把两个数字相加并回显（测试服务；不实现调用）");
    assert.equal(c.tools[0].inputSchemaSummary, "type=object; properties: a:number(required), b:number(required); required: a,b");
    assert.equal(c.tools.every((t) => !("inputSchema" in t)), true, "完整 inputSchema 不进快照");
    assert.equal(typeof c.lastConnectedAt, "number");
    // 记录里的快照与投影一致，hash 覆盖的正是这份快照
    const row = recordOf(fx, id);
    const recorded = JSON.parse(row.tools_json);
    assert.deepEqual(recorded.map((t) => t.name), ECHO.tools);
    assert.equal(row.tools_hash, crypto.createHash("sha256").update(JSON.stringify(recorded)).digest("hex"));
    assert.equal(c.toolsHash, row.tools_hash);
    // 连接复用：READY 上再 connect 不重新握手
    const again = await fx.invoke({ command: "mcp/connect", connectionId: id });
    assert.equal(again.ok, true);
    assert.equal(again.reused, true);
  });
});

test("B2 · streamable HTTP 真实握手：JSON / SSE / session 头三种服务端行为都能协商", async () => {
  const cases = [
    { name: "JSON 单响应", args: [] },
    { name: "SSE 单响应", args: ["--sse"] },
    { name: "要求 Mcp-Session-Id", args: ["--require-session"] },
  ];
  for (const entry of cases) {
    const server = startEchoServer(["--http", "--port=0", ...entry.args]);
    try {
      const info = await server.ready;
      assert.equal(info.event, "listening");
      assert.equal(info.url.startsWith("http://127.0.0.1:"), true);
      await withFixture(async (fx) => {
        const created = await fx.invoke({ command: "mcp/create", name: entry.name, transport: "http", location: "REMOTE_SERVICE", endpoint: { url: info.url }, authMode: "NONE", visibility: "PERSONAL" });
        assert.equal(created.ok, true, JSON.stringify(created));
        assert.deepEqual(created.connection.endpoint, { url: info.url, endpointScope: "LOCALHOST" });
        const id = created.connection.connectionId;
        await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
        const res = await fx.invoke({ command: "mcp/connect", connectionId: id });
        assert.equal(res.ok, true, entry.name + " → " + JSON.stringify(res));
        assert.equal(res.connection.status, "READY");
        assert.equal(res.connection.protocolVersion, ECHO.protocolVersion);
        assert.equal(res.connection.serverName, ECHO.serverName);
        assert.equal(res.connection.serverVersion, ECHO.serverVersion);
        assert.deepEqual(res.connection.tools.map((t) => t.name), ECHO.tools);
      });
    } finally {
      server.stop();
    }
  }
});

test("B3 · 协议版本不符：记录服务端真实版本 + 明确报错（不假装 READY）", async () => {
  const server = startEchoServer(["--http", "--port=0", "--protocol-version=1999-01-01"]);
  try {
    const info = await server.ready;
    await withFixture(async (fx) => {
      const created = await fx.invoke({ command: "mcp/create", name: "版本不符", transport: "http", location: "REMOTE_SERVICE", endpoint: { url: info.url }, visibility: "PERSONAL" });
      const id = created.connection.connectionId;
      await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
      const res = await fx.invoke({ command: "mcp/connect", connectionId: id });
      assert.equal(res.ok, false);
      assert.equal(res.error, "MCP_PROTOCOL_VERSION_UNSUPPORTED");
      const row = recordOf(fx, id);
      assert.equal(row.status, "ERROR");
      assert.equal(row.last_error_code, "MCP_PROTOCOL_VERSION_UNSUPPORTED");
      assert.equal(row.protocol_version, "1999-01-01", "真实返回值必须落库");
      assert.equal(row.server_name, ECHO.serverName);
      assert.equal(row.server_version, ECHO.serverVersion);
      assert.equal(row.tools_json, "[]", "协商失败不得留下工具快照");
    });
  } finally {
    server.stop();
  }
});

test("B4 · 鉴权失败 → AUTH_REQUIRED；补上凭据后可恢复 READY", async () => {
  const secret = "oa-fixture-bearer-token-77";
  const server = startEchoServer(["--http", "--port=0", "--auth-token=" + secret]);
  try {
    const info = await server.ready;
    await withFixture(async (fx) => {
      // 1) NONE 模式连一个要鉴权的服务：必须 AUTH_REQUIRED（不是假装成功）
      const created = await fx.invoke({ command: "mcp/create", name: "需要鉴权", transport: "http", location: "REMOTE_SERVICE", endpoint: { url: info.url }, authMode: "NONE", visibility: "PERSONAL" });
      const id = created.connection.connectionId;
      await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
      const failed = await fx.invoke({ command: "mcp/test", connectionId: id });
      assert.equal(failed.ok, false);
      assert.equal(failed.error, "MCP_AUTH_REQUIRED");
      assert.equal(recordOf(fx, id).status, "AUTH_REQUIRED");
      const log = await fx.invoke({ command: "mcp/testLog", connectionId: id });
      assert.equal(log.items.some((x) => x.errorCode === "MCP_AUTH_REQUIRED"), true);

      // 2) 用户补上正确凭据（重新授权）→ 同一个连接恢复 READY
      const updated = await fx.invoke({ command: "mcp/update", connectionId: id, patch: { authMode: "BEARER", credentialSecret: secret } });
      assert.equal(updated.ok, true, JSON.stringify(updated));
      assert.equal(updated.connection.credentialConfigured, true);
      assert.equal(JSON.stringify(updated).includes(secret), false);
      assert.equal(updated.connection.status, "DISABLED", "改了连接参数必须回到未连接状态");
      const ok = await fx.invoke({ command: "mcp/test", connectionId: id });
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.equal(ok.connection.status, "READY");
      assert.equal(ok.negotiated.protocolVersion, ECHO.protocolVersion);
      assert.deepEqual(ok.negotiated.tools, ECHO.tools);
      assert.equal(JSON.stringify(ok).includes(secret), false, "测试结果也不得回显 secret");
    });
  } finally {
    server.stop();
  }
});

test("B5 · 服务不响应 → 有界超时 ERROR（不悬挂、不假装成功）", async () => {
  // 白名单程序 + fixture 的 --no-response：走真实 spawn 与真实 stdio 超时路径
  await withFixture(async (fx) => {
    const created = await fx.createLocal({ name: "不响应" });
    const id = created.connection.connectionId;
    await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
    const started = Date.now();
    const res = await fx.invoke({ command: "mcp/connect", connectionId: id });
    const elapsed = Date.now() - started;
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.error, "MCP_TIMEOUT");
    assert.equal(recordOf(fx, id).status, "ERROR");
    assert.equal(recordOf(fx, id).last_error_code, "MCP_TIMEOUT");
    assert.equal(elapsed < 3000, true, "超时必须是有界的，实际 " + elapsed + "ms");
    assert.deepEqual(JSON.parse(recordOf(fx, id).endpoint_json), { serverKey: "openarc-test-echo" });
  }, { requestTimeoutMs: 400, stdioArgs: ["--no-response"] });
});

test("B6 · 工具发现分页有界：超过上限时如实截断并记账", async () => {
  const server = startEchoServer(["--http", "--port=0", "--tool-count=250", "--tools-page-size=50"]);
  try {
    const info = await server.ready;
    await withFixture(async (fx) => {
      const created = await fx.invoke({ command: "mcp/create", name: "多工具", transport: "http", location: "REMOTE_SERVICE", endpoint: { url: info.url }, visibility: "PERSONAL" });
      const id = created.connection.connectionId;
      await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
      const res = await fx.invoke({ command: "mcp/connect", connectionId: id });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.connection.tools.length, 200, "工具数上限生效");
      const row = recordOf(fx, id);
      assert.equal(JSON.parse(row.tools_json).length, 200);
      assert.equal(row.tools_hash, crypto.createHash("sha256").update(JSON.stringify(JSON.parse(row.tools_json))).digest("hex"));
      const log = await fx.invoke({ command: "mcp/testLog", connectionId: id });
      const discovered = log.items.find((x) => x.event === "TOOLS_DISCOVERED");
      assert.equal(!!discovered && discovered.detail.includes("truncated=true"), true, JSON.stringify(discovered));
    }, { maxTools: 200, maxPages: 10 });
  } finally {
    server.stop();
  }
});

test("B7 · 重连有界：最多 N 次；鉴权类失败不空转", async () => {
  const server = startEchoServer(["--http", "--port=0", "--auth-token=never-matches"]);
  try {
    const info = await server.ready;
    await withFixture(async (fx) => {
      const created = await fx.invoke({ command: "mcp/create", name: "鉴权失败", transport: "http", location: "REMOTE_SERVICE", endpoint: { url: info.url }, visibility: "PERSONAL" });
      const id = created.connection.connectionId;
      await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
      const res = await fx.invoke({ command: "mcp/reconnect", connectionId: id });
      assert.equal(res.ok, false);
      assert.equal(res.error, "MCP_AUTH_REQUIRED");
      assert.equal(res.attempts, 1, "AUTH_REQUIRED 不做无意义重试");
    }, { reconnectAttempts: 3 });

    await withFixture(async (fx) => {
      const created = await fx.invoke({ command: "mcp/create", name: "不响应", transport: "http", location: "REMOTE_SERVICE", endpoint: { url: "http://127.0.0.1:1/mcp" }, visibility: "PERSONAL" });
      const id = created.connection.connectionId;
      await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
      const started = Date.now();
      const res = await fx.invoke({ command: "mcp/reconnect", connectionId: id });
      const elapsed = Date.now() - started;
      assert.equal(res.ok, false);
      assert.equal(res.attempts, 3);
      assert.equal(res.limit, 3);
      assert.equal(elapsed < 5000, true, "重连必须有界，实际 " + elapsed + "ms");
    }, { reconnectAttempts: 3, reconnectBackoffMs: 5, requestTimeoutMs: 300 });
  } finally {
    server.stop();
  }
});

test("B8 · 停用 / 删除必须收掉子进程（pid 证据，不留孤儿）", async () => {
  const rec = recordingLauncher();
  await withFixture(async (fx) => {
    const created = await fx.createLocal();
    const id = created.connection.connectionId;
    await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
    const connected = await fx.invoke({ command: "mcp/connect", connectionId: id });
    assert.equal(connected.ok, true, JSON.stringify(connected));
    assert.equal(rec.pids.length, 1, "受控 launcher 启动了 1 个子进程");
    const pid = rec.pids[0];
    assert.equal(pidAlive(pid), true);
    assert.equal(fx.mcpService.live.size, 1);

    const off = await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: false });
    assert.equal(off.connection.status, "DISABLED");
    assert.equal(await waitFor(() => !pidAlive(pid)), true, "停用后子进程必须退出");
    assert.equal(fx.mcpService.live.size, 0);

    // 再连一次 → 再删：同样收干净
    await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
    await fx.invoke({ command: "mcp/connect", connectionId: id });
    assert.equal(rec.pids.length, 2);
    const pid2 = rec.pids[1];
    assert.equal(pidAlive(pid2), true);
    const del = await fx.invoke({ command: "mcp/delete", connectionId: id });
    assert.equal(del.ok, true);
    assert.equal(await waitFor(() => !pidAlive(pid2)), true, "删除后子进程必须退出");
    assert.equal(fx.mcpService.live.size, 0);
  }, { launcher: rec.launcher });
});

test("B9 · test 每次都做真实握手并留日志（发现工具中 → 结果）", async () => {
  await withFixture(async (fx) => {
    const created = await fx.createLocal({ name: "测试日志" });
    const id = created.connection.connectionId;
    await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
    const first = await fx.invoke({ command: "mcp/test", connectionId: id });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.reachable, true);
    assert.equal(first.negotiated.transport, "stdio");
    assert.equal(first.negotiated.location, "LOCAL_DEVICE");
    assert.deepEqual(first.negotiated.tools, ECHO.tools);
    const before = recordOf(fx, id).last_connected_at;
    fx.advance(1000);
    const second = await fx.invoke({ command: "mcp/test", connectionId: id });
    assert.equal(second.ok, true);
    assert.equal(recordOf(fx, id).last_connected_at > before, true, "每次测试都刷新 lastConnectedAt");
    const log = await fx.invoke({ command: "mcp/testLog", connectionId: id });
    assert.equal(log.ok, true);
    assert.equal(log.items.length > 0, true);
    assert.equal(log.items.some((x) => x.event === "CONNECT_START"), true);
    assert.equal(log.items.filter((x) => x.event === "TOOLS_DISCOVERED").length >= 2, true);
    assert.equal(log.items[0].at >= log.items[log.items.length - 1].at, true, "日志按时间倒序");
    // 限制条数生效
    const limited = await fx.invoke({ command: "mcp/testLog", connectionId: id, limit: 1 });
    assert.equal(limited.items.length, 1);
  });
});

test("B10 · 工具变化会被如实记录：hash 随快照变化", async () => {
  const servers = [startEchoServer(["--http", "--port=0"]), startEchoServer(["--http", "--port=0", "--tool-count=1"])];
  try {
    const [a, b] = await Promise.all(servers.map((s) => s.ready));
    await withFixture(async (fx) => {
      const hashes = [];
      for (const info of [a, b]) {
        const created = await fx.invoke({ command: "mcp/create", name: "hash " + info.port, transport: "http", location: "REMOTE_SERVICE", endpoint: { url: info.url }, visibility: "PERSONAL" });
        const id = created.connection.connectionId;
        await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
        const res = await fx.invoke({ command: "mcp/connect", connectionId: id });
        assert.equal(res.ok, true, JSON.stringify(res));
        hashes.push(res.connection.toolsHash);
      }
      assert.notEqual(hashes[0], hashes[1], "工具集不同 → hash 必须不同");
      assert.equal(hashes[0].length, 64);
    });
  } finally {
    for (const s of servers) s.stop();
  }
});

test("B11 · launcher 不可用 → 明确 MCP_UNREACHABLE（不静默成功、不假装连接过）", async () => {
  const brokenFactory = () => new McpClient({ launcher: { available: false, launch: () => { throw new Error("no-launcher"); } }, requestTimeoutMs: 200 });
  await withFixture(async (fx) => {
    const created = await fx.createLocal();
    const id = created.connection.connectionId;
    await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
    const res = await fx.invoke({ command: "mcp/connect", connectionId: id });
    assert.equal(res.ok, false);
    assert.equal(res.error, "MCP_UNREACHABLE");
    assert.equal(recordOf(fx, id).status, "ERROR");
    assert.equal(recordOf(fx, id).last_error_code, "MCP_UNREACHABLE");
    assert.equal(fx.mcpService.live.size, 0);
  }, { clientFactory: brokenFactory });
});

test("B12 · fixture 自身不实现 tools/call（服务端也是 -32601）", async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [ECHO_HTTP_PATH, "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
  const responses = [];
  child.stdout.setEncoding("utf8");
  let buffer = "";
  child.stdout.on("data", (d) => {
    buffer += d;
    let i = buffer.indexOf("\n");
    while (i >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) responses.push(JSON.parse(line));
      i = buffer.indexOf("\n");
    }
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo_sum", arguments: { a: 1, b: 2 } } }) + "\n");
  const seen = await waitFor(() => (responses.length >= 2 ? responses : null));
  child.kill("SIGKILL");
  assert.equal(Array.isArray(seen), true);
  const call = seen.find((m) => m.id === 2);
  assert.equal(call.error.code, -32601);
  assert.equal(String(call.error.message).includes("tools/call is not implemented"), true);
});
