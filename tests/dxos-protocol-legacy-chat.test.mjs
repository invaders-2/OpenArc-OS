/**
 * W4a · legacy 对话 / 工具 / 模型目录执行器契约测试。
 * 被测：electron/protocol-engine/legacy-executor-chat.cjs
 * 源：DXSRC/server/protocols.ts:3639-4243 与 :6624-6794
 *
 * 全部走 node:http 本地 stub（127.0.0.1 随机端口），无外网、无真实密钥。
 * 覆盖：
 *   1. callChat 三种 bodyKind（openai_chat / anthropic_messages / gemini_content）的
 *      URL / headers / 鉴权头 / body 构造，以及文本与 usage 解析映射；
 *   2. streamChat 的 SSE 增量回调顺序；
 *   3. chatWithTools 的工具调用回路（gemini / anthropic 消息合并分支、openai SSE 工具参数累积、
 *      明确拒绝 stream 时降级 stream=false）；
 *   4. describeImage 的 OpenAI 视觉与 Anthropic 视觉两种 body；
 *   5. fetchModelCatalog / fetchModels 解析 openai / anthropic / gemini 三种模型列表；
 *   6. 端口未注入依赖（cli:codex / runninghub 对话 / runninghub 模型目录 / agnes 模型目录）返回结构化
 *      LEGACY_DEPENDENCY_UNAVAILABLE，detail 指明「端口未注入」，不写「未移植」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const chat = require("../electron/protocol-engine/legacy-executor-chat.cjs");

function startStub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      baseUrl: "http://127.0.0.1:" + server.address().port,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function provider(baseUrl, protocol, apiKey = "sk-test") {
  return { id: "stub-provider", base_url: baseUrl, api_key: apiKey, protocol };
}

function json(res, payload, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

const TOOLS = [{
  type: "function",
  function: { name: "lookup", description: "查询", parameters: { type: "object", properties: { x: { type: "number", description: "参数" } }, required: ["x"] } },
}];

// ── 1. callChat：三种 bodyKind 的 URL / headers / 鉴权 / body 构造 ──────
test("callChat openai_chat：URL/鉴权头/body 强制流式，文本与 usage 解析", async () => {
  let seen = null;
  const stub = await startStub(async (req, res) => {
    const raw = await readBody(req);
    seen = { method: req.method, url: req.url, headers: req.headers, body: JSON.parse(raw) };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "你好" } }] }) + "\n\n");
    res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "世界" } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) + "\n\n");
    res.write("data: [DONE]\n\n");
    res.end();
  });
  try {
    const result = await chat.callChat(provider(stub.baseUrl, "openai"), "gpt-4o-mini", { system: "系统", prompt: "hi" }, { temperature: 0.3, max_tokens: 16 });
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/v1/chat/completions");
    assert.equal(seen.headers.authorization, "Bearer sk-test");
    assert.equal(seen.headers["content-type"], "application/json");
    assert.deepEqual(seen.body, {
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: "系统" }, { role: "user", content: "hi" }],
      stream: true,
      temperature: 0.3,
      max_tokens: 16,
    });
    assert.equal(result.text, "你好世界");
    assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    assert.equal(typeof result.latencyMs, "number");
    assert.deepEqual(result.raw, { streamed: true });
  } finally {
    await stub.close();
  }
});

test("callChat anthropic_messages：/v1/messages + x-api-key + anthropic-version，非流式 body", async () => {
  let seen = null;
  const stub = await startStub(async (req, res) => {
    const raw = await readBody(req);
    seen = { method: req.method, url: req.url, headers: req.headers, body: JSON.parse(raw) };
    json(res, { content: [{ type: "text", text: "claude 回答" }], usage: { input_tokens: 1, output_tokens: 2 } });
  });
  try {
    const result = await chat.callChat(
      provider(stub.baseUrl, "anthropic"),
      "claude-x",
      { system: "sys", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }] },
      { max_tokens: 256 },
    );
    assert.equal(seen.url, "/v1/messages");
    assert.equal(seen.headers["x-api-key"], "sk-test");
    assert.equal(seen.headers["anthropic-version"], "2023-06-01");
    assert.equal(seen.headers.authorization, undefined);
    assert.deepEqual(seen.body, {
      model: "claude-x",
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }],
      system: "sys",
    });
    assert.equal(result.text, "claude 回答");
    assert.deepEqual(result.usage, { input_tokens: 1, output_tokens: 2 });
  } finally {
    await stub.close();
  }
});

test("callChat gemini_content：generateContent + x-goog-api-key，非流式 body 与 usageMetadata", async () => {
  let seen = null;
  const stub = await startStub(async (req, res) => {
    const raw = await readBody(req);
    seen = { method: req.method, url: req.url, headers: req.headers, body: JSON.parse(raw) };
    json(res, { candidates: [{ content: { parts: [{ text: "gemini 回答" }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 } });
  });
  try {
    const result = await chat.callChat(provider(stub.baseUrl, "gemini"), "gemini-2.5-flash", { prompt: "hi" }, { max_tokens: 16 });
    assert.equal(seen.url, "/v1beta/models/gemini-2.5-flash:generateContent");
    assert.equal(seen.headers["x-goog-api-key"], "sk-test");
    assert.equal(seen.headers.authorization, undefined);
    assert.deepEqual(seen.body, { contents: [{ parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 16 } });
    assert.equal(result.text, "gemini 回答");
    assert.deepEqual(result.usage, { promptTokenCount: 1, candidatesTokenCount: 2 });
  } finally {
    await stub.close();
  }
});

// ── 2. streamChat：SSE 增量回调顺序 ──────────────────────────────────
test("streamChat 按 SSE 到达顺序回调增量，并回传 usage", async () => {
  const stub = await startStub(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const piece of ["第一", "第二", "第三"]) {
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + "\n\n");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    res.write("data: " + JSON.stringify({ choices: [{ delta: {} }], usage: { total_tokens: 9 } }) + "\n\n");
    res.write("data: [DONE]\n\n");
    res.end();
  });
  try {
    const deltas = [];
    const result = await chat.streamChat(provider(stub.baseUrl, "openai"), "gpt-4o-mini", { prompt: "hi" }, {}, (text) => deltas.push(text));
    assert.deepEqual(deltas, ["第一", "第二", "第三"]);
    assert.deepEqual(result.usage, { total_tokens: 9 });
  } finally {
    await stub.close();
  }
});

// ── 3. chatWithTools：工具调用回路 ───────────────────────────────────
test("chatWithTools gemini：系统指令 + contents 合并 + functionCall/toolCalls 回路", async () => {
  let seen = null;
  const stub = await startStub(async (req, res) => {
    const raw = await readBody(req);
    seen = { url: req.url, headers: req.headers, body: JSON.parse(raw) };
    json(res, {
      candidates: [{ content: { parts: [{ text: "回答" }, { functionCall: { name: "lookup", args: { x: 2 } } }] } }],
      usageMetadata: { promptTokenCount: 1 },
    });
  });
  try {
    const messages = [
      { role: "user", content: "q1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a", tool_calls: [{ id: "t1", function: { name: "lookup", arguments: "{\"x\":1}" } }] },
      { role: "tool", tool_call_id: "t1", content: "{\"result\":42}" },
    ];
    const result = await chat.chatWithTools(provider(stub.baseUrl, "gemini"), "gemini-2.5-flash", messages, "SYS", TOOLS);
    assert.equal(seen.url, "/v1beta/models/gemini-2.5-flash:generateContent");
    assert.equal(seen.headers["x-goog-api-key"], "sk-test");
    assert.deepEqual(seen.body.systemInstruction, { parts: [{ text: "SYS" }] });
    assert.equal(seen.body.contents.length, 3);
    assert.equal(seen.body.contents[0].role, "user");
    assert.deepEqual(seen.body.contents[0].parts, [{ text: "q1" }, { text: "q2" }]);
    assert.equal(seen.body.contents[1].role, "model");
    assert.deepEqual(seen.body.contents[1].parts[1], { functionCall: { name: "lookup", args: { x: 1 } } });
    assert.equal(seen.body.contents[2].parts[0].functionResponse.name, "lookup");
    assert.deepEqual(seen.body.contents[2].parts[0].functionResponse.response, { result: 42 });
    // gemini 工具 schema 走 geminiToolParameters 归一化
    assert.equal(seen.body.tools[0].functionDeclarations[0].parameters.type, "object");
    assert.equal(seen.body.tools[0].functionDeclarations[0].parameters.properties.x.type, "number");
    assert.deepEqual(seen.body.toolConfig, { functionCallingConfig: { mode: "AUTO" } });
    assert.equal(result.content, "回答");
    assert.deepEqual(result.toolCalls, [{ id: "gemini_0_1", name: "lookup", arguments: '{"x":2}' }]);
    assert.deepEqual(result.usage, { promptTokenCount: 1 });
  } finally {
    await stub.close();
  }
});

test("chatWithTools anthropic：tool_use / tool_result 合并 + input_schema 回路", async () => {
  let seen = null;
  const stub = await startStub(async (req, res) => {
    const raw = await readBody(req);
    seen = { url: req.url, headers: req.headers, body: JSON.parse(raw) };
    json(res, {
      content: [{ type: "text", text: "答" }, { type: "tool_use", id: "toolu_1", name: "lookup", input: { x: 3 } }],
      usage: { input_tokens: 1, output_tokens: 2 },
    });
  });
  try {
    const messages = [
      { role: "user", content: "q1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a", tool_calls: [{ id: "t1", function: { name: "lookup", arguments: "{\"x\":1}" } }] },
      { role: "tool", tool_call_id: "t1", content: "{\"result\":42}" },
    ];
    const result = await chat.chatWithTools(provider(stub.baseUrl, "anthropic"), "claude-x", messages, "SYS", TOOLS);
    assert.equal(seen.url, "/v1/messages");
    assert.equal(seen.headers["x-api-key"], "sk-test");
    assert.equal(seen.headers["anthropic-version"], "2023-06-01");
    assert.equal(seen.body.system, "SYS");
    assert.equal(seen.body.max_tokens, 4096);
    assert.deepEqual(seen.body.messages[0], { role: "user", content: [{ type: "text", text: "q1" }, { type: "text", text: "q2" }] });
    assert.deepEqual(seen.body.messages[1].content[1], { type: "tool_use", id: "t1", name: "lookup", input: { x: 1 } });
    assert.deepEqual(seen.body.messages[2], { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: '{"result":42}' }] });
    assert.equal(seen.body.tools[0].name, "lookup");
    assert.equal(seen.body.tools[0].input_schema.type, "object");
    assert.deepEqual(seen.body.tool_choice, { type: "auto" });
    assert.equal(result.content, "答");
    assert.deepEqual(result.toolCalls, [{ id: "toolu_1", name: "lookup", arguments: '{"x":3}' }]);
    assert.deepEqual(result.usage, { input_tokens: 1, output_tokens: 2 });
  } finally {
    await stub.close();
  }
});

test("chatWithTools openai：SSE 分片累积 tool_calls 参数并回调增量文本", async () => {
  let seen = null;
  const stub = await startStub(async (req, res) => {
    seen = { url: req.url, headers: req.headers, body: JSON.parse(await readBody(req)) };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "片段" } }] }) + "\n\n");
    res.write("data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: '{"x":' } }] } }] }) + "\n\n");
    res.write("data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] }) + "\n\n");
    res.write("data: " + JSON.stringify({ choices: [{ delta: {} }], usage: { total_tokens: 9 } }) + "\n\n");
    res.write("data: [DONE]\n\n");
    res.end();
  });
  try {
    const deltas = [];
    const result = await chat.chatWithTools(
      provider(stub.baseUrl, "openai"),
      "gpt-4o-mini",
      [{ role: "user", content: "hi" }],
      "SYS",
      TOOLS,
      300000,
      (text) => deltas.push(text),
    );
    assert.equal(seen.url, "/v1/chat/completions");
    assert.equal(seen.body.stream, true);
    assert.deepEqual(seen.body.messages, [{ role: "system", content: "SYS" }, { role: "user", content: "hi" }]);
    assert.deepEqual(deltas, ["片段"]);
    assert.equal(result.content, "片段");
    assert.deepEqual(result.toolCalls, [{ id: "call_1", name: "lookup", arguments: '{"x":1}' }]);
    assert.deepEqual(result.usage, { total_tokens: 9 });
  } finally {
    await stub.close();
  }
});

test("chatWithTools openai：明确拒绝 stream 时降级 stream=false 并接收同步 JSON", async () => {
  const requests = [];
  const stub = await startStub(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    requests.push(body);
    if (requests.length === 1) {
      json(res, { error: { message: "stream is not supported" } }, 400);
      return;
    }
    json(res, { choices: [{ message: { content: "同步回答", tool_calls: [{ id: "c1", function: { name: "lookup", arguments: "{}" } }] } }], usage: { total_tokens: 4 } });
  });
  try {
    const result = await chat.chatWithTools(provider(stub.baseUrl, "openai"), "gpt-4o-mini", [{ role: "user", content: "hi" }], "SYS", TOOLS);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].stream, true);
    assert.equal(requests[1].stream, false);
    assert.equal(result.content, "同步回答");
    assert.deepEqual(result.toolCalls, [{ id: "c1", name: "lookup", arguments: "{}" }]);
    assert.deepEqual(result.usage, { total_tokens: 4 });
  } finally {
    await stub.close();
  }
});

// ── 4. describeImage：OpenAI / Anthropic 两种视觉 body ───────────────
test("describeImage：openai 视觉用 image_url，anthropic 视觉用 base64 image source", async () => {
  const seen = [];
  const stub = await startStub(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    seen.push({ url: req.url, body });
    if (req.url === "/v1/messages") json(res, { content: [{ type: "text", text: "一只狗" }], usage: {} });
    else json(res, { choices: [{ message: { content: "一只猫" } }], usage: {} });
  });
  const dataUrl = "data:image/png;base64,AAA";
  try {
    const cat = await chat.describeImage(provider(stub.baseUrl, "openai"), "gpt-4o-mini", dataUrl, "描述这张图");
    assert.equal(seen[0].url, "/v1/chat/completions");
    assert.equal(seen[0].body.stream, false);
    assert.deepEqual(seen[0].body.messages[0].content, [
      { type: "text", text: "描述这张图" },
      { type: "image_url", image_url: { url: dataUrl } },
    ]);
    assert.equal(cat, "一只猫");

    const dog = await chat.describeImage(provider(stub.baseUrl, "anthropic"), "claude-x", dataUrl, "描述这张图");
    assert.equal(seen[1].url, "/v1/messages");
    assert.deepEqual(seen[1].body.messages[0].content, [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
      { type: "text", text: "描述这张图" },
    ]);
    assert.equal(dog, "一只狗");
  } finally {
    await stub.close();
  }
});

// ── 5. fetchModelCatalog / fetchModels：openai / anthropic / gemini ──
test("fetchModelCatalog：openai / anthropic / gemini 三种模型列表解析", async () => {
  const openaiStub = await startStub(async (req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.url, "/v1/models");
    assert.equal(req.headers.authorization, "Bearer sk-test");
    json(res, { object: "list", data: [{ id: "gpt-4o", name: "GPT-4o" }, { id: "gpt-4o-mini" }] });
  });
  const anthropicStub = await startStub(async (req, res) => {
    assert.equal(req.url, "/v1/models");
    assert.equal(req.headers["x-api-key"], "sk-test");
    json(res, { data: [{ id: "claude-3-5-sonnet", display_name: "Claude 3.5 Sonnet" }] });
  });
  const geminiStub = await startStub(async (req, res) => {
    assert.equal(req.url, "/v1beta/models");
    assert.equal(req.headers["x-goog-api-key"], "sk-test");
    json(res, { models: [{ name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash" }] });
  });
  try {
    assert.deepEqual(await chat.fetchModelCatalog(provider(openaiStub.baseUrl, "openai")), [
      { model: "gpt-4o", name: "GPT-4o" }, { model: "gpt-4o-mini" },
    ]);
    assert.deepEqual(await chat.fetchModels(provider(openaiStub.baseUrl, "openai")), ["gpt-4o", "gpt-4o-mini"]);
    assert.deepEqual(await chat.fetchModelCatalog(provider(anthropicStub.baseUrl, "anthropic")), [
      { model: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet" },
    ]);
    assert.deepEqual(await chat.fetchModelCatalog(provider(geminiStub.baseUrl, "gemini")), [
      { model: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    ]);
  } finally {
    await openaiStub.close();
    await anthropicStub.close();
    await geminiStub.close();
  }
});

test("fetchModelCatalog：minimax 不发请求直接返回内置目录", async () => {
  const result = await chat.fetchModelCatalog(provider("http://127.0.0.1:1", "minimax"));
  assert.deepEqual(result, [{ model: "MiniMax-H3", type: "llm" }]);
});

// ── 6. 端口未注入依赖：结构化错误，不做假实现 ────────────────────────
test("端口未注入依赖返回 LEGACY_DEPENDENCY_UNAVAILABLE（cli:codex / runninghub / agnes）", async () => {
  const cli = await chat.callChat(provider("http://127.0.0.1:1", "cli:codex"), "gpt-5.5", { prompt: "hi" });
  assert.equal(cli.ok, false);
  assert.equal(cli.error, "LEGACY_DEPENDENCY_UNAVAILABLE");
  assert.match(cli.detail, /CLI/);

  const rh = await chat.callChat(provider("http://127.0.0.1:1", "runninghub"), "m", { prompt: "hi" });
  assert.equal(rh.ok, false);
  assert.equal(rh.error, "LEGACY_DEPENDENCY_UNAVAILABLE");

  const rhCatalog = await chat.fetchModelCatalog(provider("http://127.0.0.1:1", "runninghub"));
  assert.equal(rhCatalog.ok, false);
  assert.equal(rhCatalog.error, "LEGACY_DEPENDENCY_UNAVAILABLE");
  assert.match(rhCatalog.detail, /runninghub/);
  // 端口未注入时的 detail 必须准确，不得再写「未移植」（启用态见 dxos-integration-runninghub.test.mjs）
  assert.match(rhCatalog.detail, /端口未注入/);
  assert.doesNotMatch(rhCatalog.detail, /未移植/);

  const agnes = await chat.fetchModelCatalog(provider("http://127.0.0.1:1", "agnes"));
  assert.equal(agnes.ok, false);
  assert.equal(agnes.error, "LEGACY_DEPENDENCY_UNAVAILABLE");
  assert.match(agnes.detail, /agnes/);
  // 端口未注入时的 detail 必须准确，不得再写「未移植」（启用态见 dxos-integration-agnes.test.mjs）
  assert.match(agnes.detail, /端口未注入/);
  assert.doesNotMatch(agnes.detail, /未移植/);
});
