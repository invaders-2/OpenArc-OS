"use strict";
/**
 * 模型名到协议 Profile 的匹配规则：精确 ID 优先，match 是有意的族前缀，空 match 最后兜底。
 * 源：DXSRC/protocol-engine/modelProfile.ts:1-23
 */
function modelCandidates(model) {
  const normalized = String(model || "").trim().toLowerCase().replace(/^models\//, "");
  const leaf = normalized.split("/").pop() || normalized;
  return leaf === normalized ? [normalized] : [normalized, leaf];
}

function findModelProfile(profiles, model) {
  const entries = Object.entries(profiles || {});
  const candidates = modelCandidates(model);
  const exact = entries.find(([id]) => candidates.includes(id.toLowerCase()));
  if (exact) return exact;
  const matched = entries.find(([, profile]) => (profile.match || []).some((pattern) => {
    const value = String(pattern || "").trim().toLowerCase();
    return !!value && candidates.some((candidate) => candidate.startsWith(value));
  }));
  if (matched) return matched;
  return entries.find(([, profile]) => (profile.match || []).some((pattern) => !String(pattern || "").trim()));
}

module.exports = { findModelProfile, modelCandidates };
