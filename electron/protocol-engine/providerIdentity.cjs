"use strict";
/**
 * 平台身份与 wire protocol 的分离：仅旧版/通用 OpenAI 绑定会被自动升级。
 * 源：DXSRC/protocol-engine/providerIdentity.ts:1-56
 */
function isFhlProvider(input) {
  if (!input) return false;
  if (String(input.id || "").trim().toLowerCase() === "fhl") return true;
  try {
    const host = new URL(String(input.base_url || "")).hostname.toLowerCase();
    return host === "fhl.mom" || host === "www.fhl.mom";
  } catch { return false; }
}

function isMinimaxProvider(input) {
  if (!input) return false;
  if (String(input.id || "").trim().toLowerCase() === "minimax") return true;
  try {
    const host = new URL(String(input.base_url || "")).hostname.toLowerCase();
    return host === "api.minimax.cn" || host === "api-bj.minimaxi.com" || host === "api.minimax.io" || host.endsWith(".minimax.io");
  } catch { return false; }
}

function isGeminiProvider(input) {
  if (!input) return false;
  try {
    const host = new URL(String(input.base_url || "")).hostname.toLowerCase();
    return host === "generativelanguage.googleapis.com" || host.endsWith(".generativelanguage.googleapis.com");
  } catch { return false; }
}

function canonicalAgentProviderProtocol(input, fallback = "openai") {
  const protocol = String((input && input.protocol) || "").trim().toLowerCase();
  if (isFhlProvider(input) && (!protocol || ["openai", "openai-http", "fhl", "fhl-http"].includes(protocol))) return "fhl-http";
  if (isMinimaxProvider(input) && (!protocol || ["openai", "openai-http", "minimax", "minimax-http"].includes(protocol))) return "minimax-http";
  if (isGeminiProvider(input) && (!protocol || ["openai", "openai-http", "gemini", "gemini-http"].includes(protocol))) return "gemini-http";
  return protocol || fallback;
}

module.exports = { isFhlProvider, isMinimaxProvider, isGeminiProvider, canonicalAgentProviderProtocol };
