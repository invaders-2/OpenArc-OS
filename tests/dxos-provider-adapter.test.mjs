/**
 * B4 · providerAdapter 桥测试（全离线：假 store / 假 service，无 Electron、无网络、无第三方依赖）。
 *
 * 覆盖任务书验收条目：
 *   ① firstUsable 选型顺序（可用且已配密钥优先 / cap_sort / sort）
 *   ② all() 不含密钥字段（api_key / wallet_api_key / credentialRef）
 *   ③ autoFallback 语义
 *   ④ revealProvider 掩码
 *   ⑤ call 透传参数与返回值
 *
 * 只读源：electron/provider-adapter-bridge.cjs、provider-protocol-store.cjs:138-149 listPublic、
 *         provider-protocol-service.cjs:151 call。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createProviderAdapter, projectProvider } = require("../electron/provider-adapter-bridge.cjs");

const RAW_SECRET = "sk-RAW-SECRET-abcdef";

/** 假 store：listPublic() 形状对齐 provider-protocol-store.cjs:138-149。 */
function makeStore(providers) {
  return {
    calls: 0,
    listPublic() {
      this.calls += 1;
      return providers.map((p) => ({ ...p }));
    },
  };
}

/** 假 service：只记录 call 入参并回一个 provider-protocol-service.cjs:151 形状的结果。 */
function makeService(reply) {
  return {
    requests: [],
    async call(input) {
      this.requests.push(input);
      return reply === undefined ? { ok: true, text: "模型输出", toolCalls: [], usage: { total_tokens: 7 }, requestId: "rid-1" } : reply;
    },
  };
}

const provider = (over) => ({
  id: over.id,
  name: over.id,
  base_url: over.base_url === undefined ? "https://api.example.invalid/v1" : over.base_url,
  protocol: over.protocol === undefined ? "openai" : over.protocol,
  enabled: over.enabled === undefined ? true : over.enabled,
  sort: over.sort === undefined ? 1 : over.sort,
  created_ts: over.created_ts === undefined ? 1 : over.created_ts,
  has_key: over.has_key === true,
  key_mask: over.has_key === true ? "****cdef" : "",
  has_wallet_key: over.has_wallet_key === true,
  wallet_key_mask: over.has_wallet_key === true ? "****wxyz" : "",
  source: over.source,
  cli_tool: over.cli_tool,
  cap_sort: over.cap_sort,
  models: over.models || [{ model: "m-llm", caps: ["llm"] }],
});

test("① firstUsable：可用且已配密钥优先，其次 cap_sort / sort", () => {
  const store = makeStore([
    provider({ id: "no-key", has_key: false, sort: 1 }),
    provider({ id: "disabled-key", has_key: true, enabled: false, sort: 0 }),
    provider({ id: "keyed-late", has_key: true, sort: 5 }),
    provider({ id: "keyed-early", has_key: true, sort: 2 }),
  ]);
  const adapter = createProviderAdapter({ store, service: makeService() });

  // 没有密钥的站点即使 sort 最小也不选；被停用的也不选。
  assert.equal(adapter.firstUsable("llm").id, "keyed-early");
  // cap_sort 优先于站点 sort。
  store.listPublic = () =>
    [
      provider({ id: "no-key", has_key: false, sort: 1 }),
      provider({ id: "keyed-late", has_key: true, sort: 5, cap_sort: { llm: 1 } }),
      provider({ id: "keyed-early", has_key: true, sort: 2 }),
    ];
  assert.equal(adapter.firstUsable("llm").id, "keyed-late");

  // 免 key 协议（provider-protocol-domain.providerRequiresApiKey('ollama') === false）无密钥也可用。
  const ollamaStore = makeStore([provider({ id: "ollama", protocol: "ollama", has_key: false })]);
  const ollamaAdapter = createProviderAdapter({ store: ollamaStore, service: makeService() });
  assert.equal(ollamaAdapter.firstUsable("llm").id, "ollama");

  // 能力不匹配 → null；未传 kind 默认 llm。
  const imageStore = makeStore([provider({ id: "img", has_key: true, models: [{ model: "m-img", caps: ["image"] }] })]);
  const imageAdapter = createProviderAdapter({ store: imageStore, service: makeService() });
  assert.equal(imageAdapter.firstUsable("llm"), null);
  assert.equal(imageAdapter.firstUsable("image").id, "img");
  assert.equal(imageAdapter.firstUsable(), null);
});

test("② all()：只读投影，绝不含 api_key / wallet_api_key / credentialRef", () => {
  const store = makeStore([
    provider({ id: "p1", has_key: true, has_wallet_key: true }),
    // 故意在 listPublic 结果里塞入凭据键，验证第二道防线会剔除。
    { ...provider({ id: "p2", has_key: false }), api_key: RAW_SECRET, wallet_api_key: RAW_SECRET, credentialRef: "cred_x" },
  ]);
  const adapter = createProviderAdapter({ store, service: makeService() });
  const items = adapter.all();
  assert.equal(items.length, 2);
  for (const item of items) {
    assert.equal("api_key" in item, false, "all() 不得含 api_key");
    assert.equal("wallet_api_key" in item, false, "all() 不得含 wallet_api_key");
    assert.equal("credentialRef" in item, false, "all() 不得含 credentialRef");
  }
  assert.equal(JSON.stringify(items).includes(RAW_SECRET), false, "all() 序列化后不得出现裸密钥");
  assert.equal(items[0].key_mask, "****cdef", "保留掩码供 UI 显示");
  // projectProvider 是第二道防线：即使入参带凭据键，投影也会剔除。
  assert.deepEqual(projectProvider({ id: "p", api_key: RAW_SECRET, wallet_api_key: RAW_SECRET, credentialRef: "cred_x" }), { id: "p" });
});

test("③ autoFallback()：源默认开启（DXSRC store.ts:262 !== false），回退链按 all() 顺序", () => {
  const store = makeStore([
    provider({ id: "disabled", has_key: true, enabled: false, sort: 0 }),
    provider({ id: "late", has_key: true, sort: 5 }),
    provider({ id: "early", has_key: true, sort: 1 }),
  ]);
  const adapter = createProviderAdapter({ store, service: makeService() });
  assert.equal(adapter.autoFallback(), true);
  // 回退链：启用的在前（sort 升序），停用的最后；与 DXSRC store.ts:427-431 listProviders 同序。
  assert.deepEqual(adapter.all().map((p) => p.id), ["early", "late", "disabled"]);
});

test("④ revealProvider：返回掩码投影，找不到返回 null", () => {
  const store = makeStore([{ ...provider({ id: "p1", has_key: true }), api_key: RAW_SECRET }]);
  const adapter = createProviderAdapter({ store, service: makeService() });
  const found = adapter.revealProvider("p1");
  assert.equal(found.id, "p1");
  assert.equal("api_key" in found, false);
  assert.equal(JSON.stringify(found).includes(RAW_SECRET), false);
  assert.equal(found.key_mask, "****cdef");
  assert.equal(adapter.revealProvider("missing"), null);
  assert.equal(adapter.revealProvider(null), null);
});

test("⑤ call：透传参数到 provider-protocol-service.call，返回值原样（含 content 兼容别名）", async () => {
  const service = makeService();
  const adapter = createProviderAdapter({ store: makeStore([]), service });
  const seen = [];
  const result = await adapter.call({
    providerId: "p1",
    model: "m-llm",
    messages: [{ role: "user", content: "你好" }],
    tools: [{ type: "function", function: { name: "t" } }],
    params: { temperature: 0.2 },
    stream: false,
    requestId: "req-1",
    onEvent: (event) => seen.push(event),
  });
  assert.equal(service.requests.length, 1);
  const req = service.requests[0];
  assert.equal(req.providerId, "p1");
  assert.equal(req.model, "m-llm");
  assert.deepEqual(req.messages, [{ role: "user", content: "你好" }]);
  assert.deepEqual(req.tools, [{ type: "function", function: { name: "t" } }]);
  assert.deepEqual(req.params, { temperature: 0.2 });
  assert.equal(req.stream, false);
  assert.equal(req.requestId, "req-1");
  assert.equal(typeof req.onEvent, "function");
  // 返回值：service 的字段全部保留（透传），另加 content 别名。
  assert.equal(result.ok, true);
  assert.equal(result.text, "模型输出");
  assert.equal(result.content, "模型输出");
  assert.deepEqual(result.usage, { total_tokens: 7 });
  assert.equal(result.requestId, "rid-1");
  assert.equal(typeof result.latencyMs, "number");
  assert.equal(seen.length, 0, "onEvent 只作为回调透传，适配器不自己触发");
});

test("⑤b call：兼容 agent-react-driver 的 provider 对象与 system 顶层字段", async () => {
  const service = makeService({ ok: true, text: "x" });
  const adapter = createProviderAdapter({ store: makeStore([]), service });
  await adapter.call({ provider: { id: "from-object", api_key: RAW_SECRET }, model: "m", messages: [], system: "你是 DX OS" });
  const req = service.requests[0];
  assert.equal(req.providerId, "from-object");
  assert.equal(req.params.system, "你是 DX OS");
  assert.equal(req.tools, null);
  assert.equal(req.signal, null);
});

test("构造契约：缺 store.listPublic / service.call 一律报错，不静默", () => {
  assert.throws(() => createProviderAdapter({ store: {}, service: makeService() }), /listPublic/);
  assert.throws(() => createProviderAdapter({ store: makeStore([]), service: {} }), /call/);
});
