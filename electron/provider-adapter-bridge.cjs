"use strict";
/**
 * B4 · providerAdapter 桥（B2 provider-protocol-store / service → B4 只读适配器契约）。
 *
 * 为什么需要这一层：
 *   B4 的执行器要的是 { firstUsable(kind), all(), autoFallback(), revealProvider(id), call(...) }
 *   （skill-store.cjs:38-40 / skill-runner.cjs:58-60 / agent-react-driver.cjs:33），
 *   而 B2 对外只有 ProviderProtocolStore（providers.json + credential-store）与
 *   ProviderProtocolService.call（唯一模型出口，密钥只在 service 内部解出）。
 *   本桥把两者接上，并且**只做只读投影**：api_key / wallet_api_key / credentialRef
 *   一个都不跨出适配器。
 *
 * 密钥边界：
 *   · all() / firstUsable() / revealProvider() 一律基于 provider-protocol-store.cjs:138
 *     listPublic() 的公开视图（has_key / key_mask / has_wallet_key / wallet_key_mask），
 *     不读 store.get()，因此不可能把真值带出。
 *   · 真正调用只走 call()：providerId 透传给 provider-protocol-service.cjs:151，
 *     由 service 在进程内解析凭据（provider-protocol-service.cjs:130-140 #resolveProvider）。
 *
 * 选型顺序（对齐 DXSRC store.ts:448-477 firstUsableProvider / :444-446 allProviders）：
 *   enabled + base_url + 具备目标能力模型 + 鉴权就绪（免 key 协议或 has_key）→
 *   cap_sort[cap] → sort → created_ts。
 */
const DEFAULT_PROVIDER_DOMAIN = require("./provider-protocol-domain.cjs");

/** 与 DXSRC store.ts:259 / skill-runner.cjs:326-520 同名的能力枚举。 */
const CAPABILITIES = Object.freeze(["llm", "image", "video", "audio"]);

/**
 * 公开视图副本：listPublic() 已经是无密钥投影（provider-protocol-store.cjs:138-149），
 * 这里再显式丢掉可能的凭据键，构成第二道防线。
 */
function projectProvider(provider) {
  if (!provider || typeof provider !== "object") return null;
  const { api_key, wallet_api_key, credentialRef, ...rest } = provider;
  void api_key;
  void wallet_api_key;
  void credentialRef;
  return rest;
}

/**
 * @param opts.store    ProviderProtocolStore（provider-protocol-store.cjs:75，必须有 listPublic）
 * @param opts.service  ProviderProtocolService（provider-protocol-service.cjs:59，必须有 call）
 * @param opts.modelDomain 可选：提供 providerRequiresApiKey 的域模块；缺省用 provider-protocol-domain.cjs
 */
function createProviderAdapter({ store, service, modelDomain = null } = {}) {
  if (!store || typeof store.listPublic !== "function") throw new Error("provider-adapter-bridge 需要 store.listPublic()");
  if (!service || typeof service.call !== "function") throw new Error("provider-adapter-bridge 需要 service.call()");
  const providerDomain =
    modelDomain && typeof modelDomain.providerRequiresApiKey === "function" ? modelDomain : DEFAULT_PROVIDER_DOMAIN;
  const requiresKey = (protocol) => {
    try {
      return providerDomain.providerRequiresApiKey(protocol) !== false;
    } catch {
      // 协议未知时按"需要密钥"处理，绝不放行一个无法鉴权的站点。
      return true;
    }
  };

  /** 只读快照：公开投影 + 稳定排序（enabled 优先，其后 sort / created_ts）。 */
  function snapshot() {
    let items = [];
    try {
      items = store.listPublic() || [];
    } catch {
      items = [];
    }
    return items
      .map(projectProvider)
      .filter((provider) => provider && provider.id)
      .sort(
        (a, b) =>
          Number(b.enabled === true) - Number(a.enabled === true) ||
          Number(a.sort || 0) - Number(b.sort || 0) ||
          Number(a.created_ts || 0) - Number(b.created_ts || 0),
      );
  }

  function hasCapability(provider, cap) {
    return (provider.models || []).some((model) => model && (model.caps || []).includes(cap));
  }

  /** DXSRC store.ts:460-468 isUsableProvider 的无密钥等价物。 */
  function isUsable(provider, cap) {
    if (!provider || provider.enabled === false || !hasCapability(provider, cap)) return false;
    if (provider.source === "cli") return !!provider.cli_tool;
    if (!provider.base_url) return false;
    return !requiresKey(provider.protocol) || provider.has_key === true;
  }

  /** DXSRC store.ts:448-450 capabilitySort（cap 专属排序优先于站点 sort）。 */
  function capabilitySort(provider, cap) {
    const sort = provider.cap_sort && provider.cap_sort[cap];
    return Number.isFinite(Number(sort)) ? Number(sort) : Number(provider.sort || 0);
  }

  /** 只读投影：全部站点公开视图（不含 api_key / credentialRef）。 */
  function all() {
    return snapshot();
  }

  /** 第一个「启用 + 鉴权就绪 + 有指定能力模型」的站点；没有则 null（调用方自行决定报错文案）。 */
  function firstUsable(kind = "llm") {
    const cap = String(kind || "llm");
    return (
      snapshot()
        .slice()
        .sort(
          (a, b) =>
            capabilitySort(a, cap) - capabilitySort(b, cap) ||
            Number(a.sort || 0) - Number(b.sort || 0) ||
            Number(a.created_ts || 0) - Number(b.created_ts || 0),
        )
        .find((provider) => isUsable(provider, cap)) || null
    );
  }

  /**
   * DXSRC store.ts:262 getAutoFallback()：providerSettings().autoFallback !== false。
   * OpenArc 的 providers.json 没有 autoFallback 字段（不发明字段），因此维持源默认值"开启"。
   */
  function autoFallback() {
    return true;
  }

  /** 单个站点的公开投影（含 key_mask / has_key）；不存在返回 null。绝不返回真值密钥。 */
  function revealProvider(id) {
    const key = id == null ? "" : String(id);
    return all().find((provider) => provider.id === key) || null;
  }

  /**
   * 唯一真实调用出口：直接转发 provider-protocol-service.cjs:151 call。
   *   · providerId 兼容两种入参：显式 providerId，或 agent-react-driver.cjs:411 传入的 provider 对象；
   *   · system 兼容 agent-react-driver.cjs:416 的顶层字段，落到 params.system（skill-runner.cjs:286 同约定）；
   *   · 返回值保留 service 的全部字段（ok / text / toolCalls / usage / requestId / snapshot…），
   *     只补一个 content 别名供 agent-react-driver.cjs:388-402 normalizeModelReply 消费。
   */
  async function call(input = {}) {
    const source = input && typeof input === "object" ? input : {};
    const providerId =
      source.providerId != null ? source.providerId : source.provider && source.provider.id != null ? source.provider.id : null;
    const params =
      source.params && typeof source.params === "object" && !Array.isArray(source.params) ? { ...source.params } : {};
    if (source.system != null && params.system === undefined) params.system = source.system;
    const startedAt = Date.now();
    const response = await service.call({
      providerId: providerId == null ? undefined : providerId,
      model: source.model,
      messages: Array.isArray(source.messages) ? source.messages : [],
      tools: source.tools == null ? null : source.tools,
      params,
      stream: source.stream === true,
      requestId: source.requestId,
      signal: source.signal || null,
      allowLan: source.allowLan === true,
      onEvent: typeof source.onEvent === "function" ? source.onEvent : () => {},
    });
    if (!response || typeof response !== "object") return response;
    if (response.content === undefined) {
      return {
        ...response,
        content: response.text == null ? "" : String(response.text),
        latencyMs: Date.now() - startedAt,
      };
    }
    return response;
  }

  return { firstUsable, all, autoFallback, revealProvider, call };
}

module.exports = { createProviderAdapter, projectProvider, CAPABILITIES };
