// 拉取服务商模型清单：GET /models、带 Bearer、不跟随重定向、格式容错、能力推断。
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const adapter = require("../electron/provider-adapter.cjs");

test("请求形状与解析", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return { ok: true, json: async () => ({ data: [{ id: "deepseek-chat", owned_by: "deepseek" }, { id: "" }, "gpt-image-1"] }) }; };
  const r = await adapter.listModels({ baseUrl: "https://api.example.com/v1/", apiKey: "sk-test", fetchImpl });
  assert.equal(seen[0].url, "https://api.example.com/v1/models");
  assert.equal(seen[0].init.method, "GET");
  assert.equal(seen[0].init.headers.authorization, "Bearer sk-test");
  assert.equal(seen[0].init.redirect, "error");
  assert.deepEqual(r.items.map((m) => m.id), ["deepseek-chat", "gpt-image-1"]);
});

test("上游错误与网络错误如实返回", async () => {
  assert.equal((await adapter.listModels({ baseUrl: "https://x", apiKey: "k", fetchImpl: async () => ({ ok: false, status: 401 }) })).status, 401);
  assert.equal((await adapter.listModels({ baseUrl: "https://x", apiKey: "k", fetchImpl: async () => { throw new Error("boom"); } })).kind, "network");
  assert.equal((await adapter.listModels({ baseUrl: "https://x", apiKey: "k", fetchImpl: async () => ({ ok: true, json: async () => ({ foo: 1 }) }) })).protocol, true);
});

test("能力推断只作默认值", () => {
  assert.deepEqual(adapter.guessCapabilities("doubao-seedream-4-0"), ["image-generation"]);
  assert.deepEqual(adapter.guessCapabilities("doubao-seedance-1-0-pro"), ["video-generation"]);
  assert.deepEqual(adapter.guessCapabilities("text-embedding-3-small"), []);
  assert.deepEqual(adapter.guessCapabilities("deepseek-chat"), ["chat"]);
  assert.deepEqual(adapter.guessCapabilities("qwen-vl-max"), ["chat", "vision-input"]);
});
