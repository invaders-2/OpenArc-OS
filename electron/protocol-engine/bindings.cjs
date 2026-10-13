"use strict";
/**
 * provider/model → v2 协议的绑定与兼容升级。
 * 源：DXSRC/protocol-engine/bindings.ts:1-79 逐条移植（含 apimart/apib 特殊路由）。
 */
const { getProtocolV2, isCustomProtocolV2 } = require("./repository.cjs");
const { canonicalAgentProviderProtocol, isFhlProvider } = require("./providerIdentity.cjs");
const { findModelProfile } = require("./modelProfile.cjs");

const PROVIDER_V2_COMPATIBILITY = {
  ollama: "ollama-http", openai: "openai-http", megabyai: "openai-http", "aliyun-bailian": "aliyun-bailian-http", xai: "xai-http", gemini: "gemini-http", minimax: "minimax-http", agtoken: "agtoken-http", zkki: "zkki-http", apimart: "apimart-http", modelscope: "modelscope-http", volcengine: "volcengine-http", "volcengine-speech": "volcengine-speech-http",
};
const MODEL_V2_COMPATIBILITY = {
  openai: "openai-images", "openai-chat": "openai-images", "openai-image": "openai-images", "openai-audio": "openai-images",
  "openai-relay": "comfly-openai",
  "aliyun-bailian": "openai-images",
  "gemini-generations": "comfly-openai",
  "gpt-best": "gpt-best-images", "gpt-best-images": "gpt-best-images", xai: "xai", gemini: "gemini",
  "gemini-chat": "gemini", "gemini-image": "gemini", "agtoken-video": "agtoken-videos",
  minimax: "minimax", "zkki-model": "zkki-images", apimart: "apimart-images", midjourney: "midjourney", modelscope: "modelscope-images", volcengine: "volcengine", "volcengine-speech": "volcengine-speech",
};

function apibImageProvider(provider, model) {
  if (!provider || !/(?:gpt|gemini|imagen|banana|dall|image|seedream|flux|recraft|ideogram|midjourney|jimeng|kolors|photon|cogview)/i.test(model)) return false;
  try {
    const host = new URL(String(provider.base_url || "")).hostname.toLowerCase();
    return host === "apib.ai" || host.endsWith(".apib.ai");
  } catch { return false; }
}

function apimartProvider(provider) {
  if (!provider) return false;
  if (String(provider.protocol || "").toLowerCase().startsWith("apimart")) return true;
  try {
    const host = new URL(String(provider.base_url || "")).hostname.toLowerCase();
    return host === "api.apimart.ai" || host.endsWith(".apimart.ai") || host === "apib.ai" || host.endsWith(".apib.ai");
  } catch { return false; }
}

function boundProviderProtocolV2(provider) {
  const id = canonicalAgentProviderProtocol(provider);
  return getProtocolV2("provider", id) || getProtocolV2("provider", PROVIDER_V2_COMPATIBILITY[id] || "");
}

function matchingProfile(protocol, model) {
  const found = findModelProfile(protocol.modelProfiles, model);
  return found ? found[1] : undefined;
}

function supportsIntent(entry, model, intent) {
  if (!entry || entry.protocol.kind !== "model") return false;
  const profile = matchingProfile(entry.protocol, model);
  return !!(profile && profile.capabilities.includes(intent));
}

function boundModelProtocolV2(protocolId, provider, model = "", intent = "") {
  const id = String(protocolId || "").trim().toLowerCase();
  if (apimartProvider(provider) && /^minimax-(?:h3|hailuo)/i.test(model) && intent.startsWith("video.") && !isCustomProtocolV2("model", id)) return getProtocolV2("model", "apimart-images");
  if (apimartProvider(provider) && /^(?:doubao-)?seedream-5[.-]0-(?:pro|flash)/i.test(model) && intent.startsWith("image.") && !isCustomProtocolV2("model", id)) return getProtocolV2("model", "apimart-images");
  if (apimartProvider(provider) && /^grok-imagine-(?:image|2\.0-ext|1\.5-(?:apimart|ext))/i.test(model) && intent.startsWith("image.") && !isCustomProtocolV2("model", id)) return getProtocolV2("model", "apimart-images");
  if (apimartProvider(provider) && intent === "audio.tts" && !isCustomProtocolV2("model", id)) return getProtocolV2("model", "apimart-images");
  const direct = getProtocolV2("model", id);
  const selected = direct
    || getProtocolV2("model", apibImageProvider(provider, model) ? "apib-images" : "")
    || getProtocolV2("model", isFhlProvider(provider) ? "fhl-images" : MODEL_V2_COMPATIBILITY[id] || "");
  if (!intent || isCustomProtocolV2("model", id) || supportsIntent(selected, model, intent)) return selected;
  const openAi = getProtocolV2("model", "openai-images");
  return supportsIntent(openAi, model, intent) ? openAi : selected;
}

module.exports = { boundProviderProtocolV2, boundModelProtocolV2, PROVIDER_V2_COMPATIBILITY, MODEL_V2_COMPATIBILITY };
