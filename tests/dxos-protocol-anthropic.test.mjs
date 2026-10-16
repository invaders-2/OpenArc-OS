/**
 * Anthropic Messages 官方协议（adapterType=anthropic，provider.protocol=anthropic）离线验收。
 *
 * 全程本地 mock HTTP 扮演 api.anthropic.com：
 *   · 请求头断言：x-api-key + anthropic-version 存在，且**没有** Authorization / Bearer
 *   · 请求体形状：max_tokens 必填、system 顶层提取、messages 角色归并
 *   · 非流式响应归一（content[].text + usage）
 *   · SSE 流式逐事件解析（message_start/content_block_delta/message_delta/message_stop）
 *   · 视觉消息构造（image/source base64）
 *   · 错误归一（401/403/429/超时/取消）
 *   · 协议表（auth/headers/models/operations/categories）与 mapProtocol 透传
 *   · provider-protocol-service provider/call + callStream 真走 Anthropic 线路
 *   · ModelService 的 model/test、provider/models、chat/chatStream 按 adapterType 分发
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { createModelFixture } from "./model-fixtures.mjs";

const require = createRequire(import.meta.url);
const anthropic = require("../electron/provider-adapter-anthropic.cjs");
const openaiAdapter = require("../electron/provider-adapter.cjs");
const legacy = require("../electron/protocol-engine/legacy-protocols.cjs");
const { mapProtocol } = require("../electron/model-provider-bridge.cjs");
const { ProviderProtocolService } = require("../electron/provider-protocol-service.cjs");

const SECRET = "sk-ant-mock-SECRET-1234567890";
const servers = [];
after(async () => { for (const server of servers) { try { await server.close(); } catch { /* ignore */ } } });

/** 本地 Anthropic 形状 mock：mode 控制非流式状态 / 流式 / 延迟。 */
async function startMockAnthropic() {
  const state = { mode: "success", requests: [], gate: null };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", async () => {
      const body = raw ? JSON.parse(raw) : null;
      state.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [
          { type: "model", id: "claude-opus-4-6", display_name: "Claude Opus 4.6", created_at: "2026-01-01T00:00:00Z", max_tokens: 64000 },
          { type: "model", id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6", created_at: "2026-01-01T00:00:00Z", max_tokens: 64000 },
        ], has_more: false, first_id: "claude-opus-4-6", last_id: "claude-sonnet-4-6" }));
        return;
      }
      const mode = state.mode;
      if (mode === "401" || mode === "403" || mode === "429" || mode === "500") {
        res.writeHead(Number(mode), { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "denied by mock" } }));
        return;
      }
      if (mode === "sse-error") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: message_start\ndata: " + JSON.stringify({ type: "message_start", message: { id: "msg_err", usage: { input_tokens: 3, output_tokens: 0 } } }) + "\n\n");
        res.write("event: error\ndata: " + JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }) + "\n\n");
        res.end();
        return;
      }
      if (mode === "slow") {
        state.gate = res;
        setTimeout(() => { if (!res.writableEnded) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ content: [{ type: "text", text: "late" }] })); } }, 5000).unref();
        return;
      }
      if (body && body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const send = (event, payload) => res.write("event: " + event + "\ndata: " + JSON.stringify(payload) + "\n\n");
        send("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 1 } } });
        send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } });
        setTimeout(() => {
          send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } });
          send("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} } });
          send("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":' } });
          send("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"x"}' } });
          send("content_block_stop", { type: "content_block_stop", index: 0 });
          send("content_block_stop", { type: "content_block_stop", index: 1 });
          send("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } });
          send("message_stop", { type: "message_stop" });
          res.end();
        }, 10);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_ok", type: "message", role: "assistant", model: body && body.model,
        content: [{ type: "text", text: "你好，来自 mock" }], stop_reason: "end_turn",
        usage: { input_tokens: 11, output_tokens: 5 },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = "http://127.0.0.1:" + server.address().port;
  const close = () => new Promise((resolve) => { if (state.gate && !state.gate.writableEnded) state.gate.end(); server.closeAllConnections?.(); server.close(resolve); });
  const handle = { baseUrl, state, close };
  servers.push(handle);
  return handle;
}

function decodeBody(text) { return text == null ? "" : Buffer.isBuffer(text) ? text.toString("utf8") : String(text); }

/** 用 openai 适配器都稳定的 fetchImpl 形态：这里直接要求 mock 服务可用（内置 fetch）。 */

test("① 鉴权头与请求体：x-api-key + anthropic-version，无 Authorization/Bearer；max_tokens 必填、system 提取、角色归并", async () => {
  const mock = await startMockAnthropic();
  mock.state.mode = "success";
  const { res } = await anthropic.chat({
    baseUrl: mock.baseUrl, apiKey: SECRET, model: "claude-opus-4-6",
    messages: [
      { role: "system", content: "你是助手" },
      { role: "assistant", content: "上一轮" },
      { role: "user", content: "你好" },
    ],
    params: {},
  });
  const parsed = anthropic.parseChatResponse(await res.json());
  assert.equal(parsed.text, "你好，来自 mock");
  assert.deepEqual(parsed.usage, { inputTokens: 11, outputTokens: 5, totalTokens: 16 });

  const seen = mock.state.requests.at(-1);
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/v1/messages");
  assert.equal(seen.headers["x-api-key"], SECRET);
  assert.equal(seen.headers["anthropic-version"], "2023-06-01");
  assert.equal("authorization" in seen.headers, false, "官方协议不得发 Authorization");
  assert.equal(JSON.stringify(seen.headers).includes("Bearer"), false, "不得出现 Bearer");
  assert.equal(seen.body.max_tokens, 1024, "max_tokens 是官方必填项，缺失时必须有默认值");
  assert.equal(seen.body.system, "你是助手");
  assert.deepEqual(seen.body.messages.map((m) => m.role), ["assistant", "user"]);
  assert.equal(seen.body.stream, undefined, "非流式请求不发 stream 字段");
});

test("② 非流式 tool_use 归一：text + tool_calls（OpenAI 形状）", () => {
  const parsed = anthropic.parseChatResponse({
    content: [{ type: "text", text: "调用工具" }, { type: "tool_use", id: "toolu_9", name: "lookup", input: { q: "x" } }],
    stop_reason: "tool_use", usage: { input_tokens: 4, output_tokens: 6 },
  });
  assert.equal(parsed.text, "调用工具");
  assert.equal(parsed.toolCalls.length, 1);
  assert.deepEqual(parsed.toolCalls[0], { id: "toolu_9", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } });
  assert.equal(parsed.stopReason, "tool_use");
});

test("③ SSE 流式逐事件：message_start → content_block_delta → message_delta → message_stop（增量 + 工具调用 + usage）", async () => {
  const mock = await startMockAnthropic();
  mock.state.mode = "success";
  const events = [];
  const out = await anthropic.chatStream({
    baseUrl: mock.baseUrl, apiKey: SECRET, model: "claude-opus-4-6",
    messages: [{ role: "user", content: "hi" }],
    onEvent: (event) => events.push(event),
  });
  assert.equal(out.text, "Hello world");
  assert.deepEqual(out.usage, { inputTokens: 7, outputTokens: 9, totalTokens: 16 });
  assert.deepEqual(out.toolCalls, [{ id: "toolu_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }]);
  assert.deepEqual(events.map((e) => e.type), [
    "response.start", "usage", "text.delta", "text.delta", "tool_call.delta", "tool_call.delta", "usage", "response.complete",
  ]);
  assert.equal(events.filter((e) => e.type === "text.delta").map((e) => e.text).join(""), "Hello world");
  const seen = mock.state.requests.at(-1);
  assert.equal(seen.body.stream, true);
  assert.equal(seen.headers["x-api-key"], SECRET);
});

test("④ 视觉消息构造：data URL → 官方 image/source(base64)", () => {
  const body = anthropic.buildBody({
    model: "claude-opus-4-6",
    messages: [{ role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAB" } }] }],
    params: { max_tokens: 256 },
  });
  assert.equal(body.max_tokens, 256);
  assert.deepEqual(body.messages[0].content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAB" } });
  // 已经是官方形状的块原样保留（不二次包装）。
  const passthrough = anthropic.toAnthropicContent([{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "ZZ" } }]);
  assert.deepEqual(passthrough[0].source, { type: "base64", media_type: "image/jpeg", data: "ZZ" });
  // http(s) 图片 → url source。
  assert.deepEqual(anthropic.toAnthropicContent([{ type: "image_url", image_url: { url: "https://x.test/a.png" } }])[0].source, { type: "url", url: "https://x.test/a.png" });
});

test("⑤ 错误归一：401/403→AUTH_FAILED、429→RATE_LIMITED、超时/取消沿用既有口径", async () => {
  const mock = await startMockAnthropic();
  for (const [mode, code] of [["401", "AUTH_FAILED"], ["403", "AUTH_FAILED"], ["429", "RATE_LIMITED"], ["500", "PROVIDER_UNAVAILABLE"]]) {
    mock.state.mode = mode;
    const { res } = await anthropic.chat({ baseUrl: mock.baseUrl, apiKey: SECRET, model: "m", messages: [{ role: "user", content: "x" }] });
    assert.equal(res.status, Number(mode));
    assert.equal(anthropic.errorCodeFor({ status: res.status }), code, mode);
  }
  assert.equal(anthropic.errorCodeFor({ kind: "timeout" }), "MODEL_TIMEOUT");
  assert.equal(anthropic.errorCodeFor({ kind: "cancelled" }), "CANCELLED");
  // 流内 error 事件按同一状态表归一。
  mock.state.mode = "sse-error";
  await assert.rejects(
    () => anthropic.chatStream({ baseUrl: mock.baseUrl, apiKey: SECRET, model: "m", messages: [{ role: "user", content: "x" }] }),
    (error) => error.name === "ProviderHttpError" && anthropic.errorCodeFor({ status: error.status }) === "RATE_LIMITED",
  );
});

test("⑥ 模型列表：GET /v1/models（x-api-key + anthropic-version），解析 data[].id/display_name", async () => {
  const mock = await startMockAnthropic();
  const r = await anthropic.listModels({ baseUrl: mock.baseUrl, apiKey: SECRET });
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.map((m) => m.id), ["claude-opus-4-6", "claude-sonnet-4-6"]);
  const seen = mock.state.requests.at(-1);
  assert.equal(seen.method, "GET");
  assert.equal(seen.url, "/v1/models");
  assert.equal(seen.headers["x-api-key"], SECRET);
  assert.equal(seen.headers["anthropic-version"], "2023-06-01");
  assert.equal("authorization" in seen.headers, false);
});

test("⑦ 协议表：anthropic 的 auth/headers/models/operations/categories 齐备；baseUrl 已带 /v1 时不重复叠加", () => {
  const def = legacy.PROTOCOLS.anthropic;
  assert.equal(def.auth.type, "api_key_header");
  assert.equal(def.auth.header, "x-api-key");
  assert.equal(def.headers["anthropic-version"], "2023-06-01");
  assert.equal(def.models.endpoint, "/v1/models");
  // def.stream 会让 legacy-executor-chat 强制按 OpenAI SSE 累积，Anthropic 具名事件不适用 → 必须不设。
  assert.equal(def.stream, undefined, "anthropic 不得设 def.stream（会走错 SSE 形状）");
  assert.ok(def.categories.includes("llm") && def.categories.includes("vision"), JSON.stringify(def.categories));
  assert.ok(def.operations["llm.chat"], "必须有 llm.chat");
  assert.ok(def.operations["llm.chat.stream"], "必须有流式操作");
  assert.equal(def.operations["llm.chat.stream"].stream.protocol, "sse");
  assert.ok(def.operations["llm.chat.vision"], "视觉操作");
  // 既有 legacy 构造器已按官方形状出请求（回归口径不变）。
  const built = legacy.buildChatRequest({ base_url: "https://api.anthropic.com", api_key: "k", protocol: "anthropic" }, "claude-opus-4-6", { messages: [{ role: "user", content: "hi" }] });
  assert.equal(built.url, "https://api.anthropic.com/v1/messages");
  assert.equal(built.headers["x-api-key"], "k");
  // adapterType → 协议 id 透传。
  assert.equal(mapProtocol("anthropic"), "anthropic");
  assert.equal(mapProtocol("openai-compatible"), "openai");
  // baseUrl 带 /v1 时不出现 /v1/v1。
  assert.equal(anthropic.buildRequest({ baseUrl: "https://api.anthropic.com/v1", apiKey: "k", model: "m", messages: [] }).url, "https://api.anthropic.com/v1/messages");
  assert.equal(openaiAdapter.adapterFor("anthropic").ADAPTER_TYPE, "anthropic");
  assert.equal(openaiAdapter.adapterFor("openai-compatible").ADAPTER_TYPE, "openai-compatible");
});

test("⑧ provider-protocol-service：provider.protocol=anthropic 走 /v1/messages（非流式 + 流式 + 429）", async () => {
  const mock = await startMockAnthropic();
  const provider = () => ({ id: "p1", name: "Claude", base_url: mock.baseUrl, protocol: "anthropic", api_key: SECRET, enabled: true, models: [{ model: "claude-opus-4-6", caps: ["llm"] }] });
  const store = { get: (id) => (String(id) === "p1" ? provider() : null), listInternal: () => [provider()] };
  const service = new ProviderProtocolService({ store, userDataDir: null, clock: () => Date.now() });

  const nonStream = await service.call({ providerId: "p1", model: "claude-opus-4-6", messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }] });
  assert.equal(nonStream.ok, true, JSON.stringify(nonStream));
  assert.equal(nonStream.text, "你好，来自 mock");
  assert.deepEqual(nonStream.usage, { inputTokens: 11, outputTokens: 5, totalTokens: 16 });
  const seen = mock.state.requests.at(-1);
  assert.equal(seen.url, "/v1/messages");
  assert.equal(seen.headers["x-api-key"], SECRET);
  assert.equal(seen.body.system, "s");

  const events = [];
  const streamed = await service.call({ providerId: "p1", model: "claude-opus-4-6", messages: [{ role: "user", content: "hi" }], stream: true, onEvent: (e) => events.push(e) });
  assert.equal(streamed.ok, true, JSON.stringify(streamed));
  assert.equal(streamed.text, "Hello world");
  assert.deepEqual(events.map((e) => e.type), ["response.start", "usage", "text.delta", "text.delta", "tool_call.delta", "tool_call.delta", "usage", "response.complete"]);

  mock.state.mode = "429";
  const limited = await service.call({ providerId: "p1", model: "claude-opus-4-6", messages: [{ role: "user", content: "hi" }] });
  assert.equal(limited.ok, false);
  assert.equal(limited.error, "RATE_LIMITED");
  mock.state.mode = "success";
});

test("⑨ ModelService：adapterType=anthropic 的 model/test、provider/models、chat、chatStream 全走官方协议", async () => {
  const mock = await startMockAnthropic();
  const fixture = await createModelFixture({ timeoutMs: 3000 });
  try {
    const admin = fixture.adminCtx();
    const context = { sessionRef: admin.sessionRef, appId: "ai" };
    fixture.modelService.grantAppModelAccess({ context: admin, appId: "ai", actions: ["model.view", "model.use", "model.manage", "model.test"] });
    const created = fixture.modelService.createProvider({ context, displayName: "Anthropic Mock", baseUrl: mock.baseUrl, adapterType: "anthropic", credentialSecret: SECRET });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.provider.adapterType, "anthropic");
    const model = fixture.modelService.createModel({ context, providerId: created.provider.providerId, remoteModelId: "claude-opus-4-6", capabilities: ["chat", "vision-input"] });
    assert.equal(model.ok, true, JSON.stringify(model));
    const configId = model.model.configId;

    // chat：官方形状 + usage 归一
    const chat = await fixture.modelService.chat({ context, configId, messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }] });
    assert.equal(chat.ok, true, JSON.stringify(chat));
    assert.equal(chat.text, "你好，来自 mock");
    assert.deepEqual(chat.usage, { inputTokens: 11, outputTokens: 5, totalTokens: 16 });
    const seen = mock.state.requests.at(-1);
    assert.equal(seen.url, "/v1/messages");
    assert.equal(seen.headers["x-api-key"], SECRET);
    assert.equal("authorization" in seen.headers, false);

    // model/test → 走 chat（antropic），通过后写 verifiedCapabilities
    const tested = await fixture.modelService.testConnection({ context, configId });
    assert.equal(tested.ok, true, JSON.stringify(tested));
    assert.equal(tested.reachable, true);

    // provider/models → GET /v1/models
    mock.state.requests.length = 0;
    const remote = await fixture.modelService.listRemoteModels({ context, providerId: created.provider.providerId });
    assert.equal(remote.ok, true, JSON.stringify(remote));
    assert.deepEqual(remote.items.map((m) => m.id), ["claude-opus-4-6", "claude-sonnet-4-6"]);
    assert.equal(remote.items[0].suggestedCapabilities.includes("vision-input"), true, "claude 名称推断含视觉");
    const listReq = mock.state.requests.at(-1);
    assert.equal(listReq.method, "GET");
    assert.equal(listReq.url, "/v1/models");
    assert.equal(listReq.headers["anthropic-version"], "2023-06-01");

    // chatStream：增量事件
    const events = [];
    const streamed = await fixture.modelService.chatStream({ context, configId, messages: [{ role: "user", content: "hi" }], onEvent: (e) => events.push(e) });
    assert.equal(streamed.ok, true, JSON.stringify(streamed));
    assert.equal(streamed.text, "Hello world");
    assert.deepEqual(events.filter((e) => e.type === "text.delta").map((e) => e.text), ["Hello", " world"]);

    // 401 → AUTH_FAILED（凭据被拒时不静默回落）
    mock.state.mode = "401";
    const denied = await fixture.modelService.chat({ context, configId, messages: [{ role: "user", content: "hi" }] });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, "AUTH_FAILED");
  } finally {
    fixture.close();
  }
});

test("⑩ ModelService 超时/取消：timeoutMs 与 AbortSignal 沿用既有错误码", async () => {
  const mock = await startMockAnthropic();
  mock.state.mode = "slow";
  const fixture = await createModelFixture({ timeoutMs: 150 });
  try {
    const admin = fixture.adminCtx();
    const context = { sessionRef: admin.sessionRef, appId: "ai" };
    fixture.modelService.grantAppModelAccess({ context: admin, appId: "ai", actions: ["model.view", "model.use", "model.manage", "model.test"] });
    const created = fixture.modelService.createProvider({ context, displayName: "Anthropic Slow", baseUrl: mock.baseUrl, adapterType: "anthropic", credentialSecret: SECRET });
    const model = fixture.modelService.createModel({ context, providerId: created.provider.providerId, remoteModelId: "claude-opus-4-6", capabilities: ["chat"] });
    const configId = model.model.configId;

    const timedOut = await fixture.modelService.chat({ context, configId, messages: [{ role: "user", content: "hi" }] });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.error, "MODEL_TIMEOUT");

    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("user-cancel")), 80);
    const cancelled = await fixture.modelService.chat({ context, configId, messages: [{ role: "user", content: "hi" }], signal: controller.signal });
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.error, "CANCELLED");
  } finally {
    fixture.close();
  }
});

test("⑪ provider/update：显式 adapterType 切换协议；缺省沿用原值（预设切换 Claude 的路径）", async () => {
  const mock = await startMockAnthropic();
  const fixture = await createModelFixture({ timeoutMs: 3000 });
  try {
    const admin = fixture.adminCtx();
    const context = { sessionRef: admin.sessionRef, appId: "ai" };
    fixture.modelService.grantAppModelAccess({ context: admin, appId: "ai", actions: ["model.view", "model.use", "model.manage", "model.test"] });
    const created = fixture.modelService.createProvider({ context, displayName: "切换到 Anthropic", baseUrl: mock.baseUrl, credentialSecret: SECRET });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.provider.adapterType, "openai-compatible");

    const sw = fixture.modelService.updateProvider({ context, providerId: created.provider.providerId, adapterType: "anthropic" });
    assert.equal(sw.ok, true, JSON.stringify(sw));
    assert.equal(sw.provider.adapterType, "anthropic");

    const keep = fixture.modelService.updateProvider({ context, providerId: created.provider.providerId, displayName: "改名不改协议" });
    assert.equal(keep.ok, true, JSON.stringify(keep));
    assert.equal(keep.provider.adapterType, "anthropic", "缺省 adapterType 必须沿用原值");

    const model = fixture.modelService.createModel({ context, providerId: created.provider.providerId, remoteModelId: "claude-opus-4-6", capabilities: ["chat"] });
    const chat = await fixture.modelService.chat({ context, configId: model.model.configId, messages: [{ role: "user", content: "hi" }] });
    assert.equal(chat.ok, true, JSON.stringify(chat));
    assert.equal(mock.state.requests.at(-1).url, "/v1/messages", "切换后必须走 Anthropic 线路");
  } finally {
    fixture.close();
  }
});
