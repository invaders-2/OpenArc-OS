/**
 * B4e 收口补丁 · mcp-live-transport 的「服务名 → 真实活连接」解析（离线单测）。
 *
 * 被测算的是产品模块：electron/mcp-live-transport.cjs 的 resolveLiveConnection。
 * 覆盖的真实缺口：集成/插件传进来的 serverId 是**声明服务名**（"lingxing" / "ziniao"），
 * 而 mcpService.live 的键是随机 connectionId；同时**不**允许按"谁发现了同名工具"匹配 ——
 * 多个连接连同一个服务端时会全部命中，那必须判定为歧义并拒绝，而不是随机挑一条。
 *
 * 全程离线：不 spawn 进程、不联网、不新增依赖；只注入内存 live/store 与假的 client.callTool。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createMcpLiveTransport } = require("../electron/mcp-live-transport.cjs");

const SWITCH_ON = { isToolInvocationEnabled: () => true };

/** 内存版 mcpService：只有 live（connectionId → { client }）与 store.connectionById。 */
function serviceWith(rows, liveIds) {
  const byId = new Map(rows.map((r) => [r.connection_id, r]));
  const live = new Map();
  const calls = [];
  for (const id of liveIds) {
    live.set(id, {
      client: {
        async callTool(request) { calls.push({ id: id, request: request }); return { ok: true, content: [{ type: "text", text: id }] }; },
      },
    });
  }
  return { live, store: { connectionById: (id) => byId.get(id) || null }, calls };
}

/** 一条连接记录：默认既无归属键、也无协商名，只由测试按需覆盖。 */
const row = (id, patch = {}) => Object.assign({ connection_id: id, endpoint_json: "{}", server_name: null, name: id }, patch);

test("serverId 就是 connectionId 时直取，既有调用形状零变化", async () => {
  const svc = serviceWith([row("mcp_aaa")], ["mcp_aaa"]);
  const transport = createMcpLiveTransport({ mcpService: svc, switchPort: SWITCH_ON });
  const res = await transport.callTool({ serverId: "mcp_aaa", toolName: "echo_sum", arguments: { a: 1 } });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(svc.calls.length, 1);
  assert.equal(svc.calls[0].id, "mcp_aaa");
  assert.equal(svc.calls[0].request.name, "echo_sum");
});

test("声明服务名按连接名整词解析：两条活连接共用同一服务端时，只命中名字含服务名的那条", async () => {
  // 复刻真机探针现场：item1 的 "E2E Toggle Stub" 与 item4 的 "E2E Lingxing Stub" 都连着同一个 stub，
  // 都发现了 query_product_performance_asin_lists；只有名字含 lingxing 的那条才是声明服务的落点。
  const svc = serviceWith([
    row("mcp_dummy", { name: "E2E Toggle Stub" }),
    row("mcp_lingxing", { name: "E2E Lingxing Stub" }),
  ], ["mcp_dummy", "mcp_lingxing"]);
  const transport = createMcpLiveTransport({ mcpService: svc, switchPort: SWITCH_ON });
  const res = await transport.callTool({ serverId: "lingxing", toolName: "query_product_performance_asin_lists", arguments: {} });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(svc.calls.length, 1);
  assert.equal(svc.calls[0].id, "mcp_lingxing", "必须命中声明服务对应的连接，而不是同工具的另一条");
});

test("managedByAppId / endpoint.serverKey / 协商 serverName 三种身份信号都能解析", async () => {
  const byApp = serviceWith([row("mcp_app", { endpoint_json: JSON.stringify({ url: "http://127.0.0.1:1/mcp", managedByAppId: "lingxing" }) })], ["mcp_app"]);
  const r1 = await createMcpLiveTransport({ mcpService: byApp, switchPort: SWITCH_ON }).callTool({ serverId: "lingxing", toolName: "t" });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(byApp.calls[0].id, "mcp_app");

  const byKey = serviceWith([row("mcp_key", { endpoint_json: JSON.stringify({ serverKey: "openarc-test-echo" }) })], ["mcp_key"]);
  const r2 = await createMcpLiveTransport({ mcpService: byKey, switchPort: SWITCH_ON }).callTool({ serverId: "openarc-test-echo", toolName: "t" });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(byKey.calls[0].id, "mcp_key");

  const byName = serviceWith([row("mcp_named", { server_name: "lingxing" })], ["mcp_named"]);
  const r3 = await createMcpLiveTransport({ mcpService: byName, switchPort: SWITCH_ON }).callTool({ serverId: "LINGXING", toolName: "t" });
  assert.equal(r3.ok, true, JSON.stringify(r3));
  assert.equal(byName.calls[0].id, "mcp_named");
});

test("解析不到 / 命中多条 → 结构化拒绝且 0 次 tools/call（不静默、不伪造、不随机挑）", async () => {
  const none = serviceWith([row("mcp_other", { name: "别的服务" })], ["mcp_other"]);
  const r1 = await createMcpLiveTransport({ mcpService: none, switchPort: SWITCH_ON }).callTool({ serverId: "lingxing", toolName: "t" });
  assert.equal(r1.ok, false);
  assert.equal(r1.error, "MCP_CONNECTION_NOT_FOUND");
  assert.match(r1.detail, /^service-unresolved:lingxing/);
  assert.equal(none.calls.length, 0, "解析不到时不得发出任何 tools/call");

  const ambiguous = serviceWith([
    row("mcp_a", { name: "Lingxing A" }),
    row("mcp_b", { name: "Lingxing B" }),
  ], ["mcp_a", "mcp_b"]);
  const r2 = await createMcpLiveTransport({ mcpService: ambiguous, switchPort: SWITCH_ON }).callTool({ serverId: "lingxing", toolName: "t" });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, "MCP_CONNECTION_NOT_FOUND");
  assert.match(r2.detail, /^service-ambiguous:lingxing/);
  assert.equal(ambiguous.calls.length, 0, "歧义时不得随机挑一条发出 tools/call");
});

test("store 不可用（只有 live 注册表）时按结构化不可达拒绝，不退回模糊匹配", async () => {
  const svc = { live: new Map([["mcp_x", { client: { async callTool() { return { ok: true }; } } }]]), calls: [] };
  const res = await createMcpLiveTransport({ mcpService: svc, switchPort: SWITCH_ON }).callTool({ serverId: "lingxing", toolName: "t" });
  assert.equal(res.ok, false);
  assert.equal(res.error, "MCP_UNREACHABLE");
  assert.equal(res.detail, "service-registry-unavailable");
});
