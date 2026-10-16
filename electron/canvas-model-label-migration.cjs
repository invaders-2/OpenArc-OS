/**
 * 画布模型标签 · 旧格式 → 新格式的**保真迁移**（纯函数；宿主在加载画布文档时调用）。
 *
 * 背景：画布文档里存的是模型**标签**（不透明字符串）。旧命名是
 *   `${displayName || remoteModelId || configId} · ${configId 末 4 位}`
 * 已经落库；新命名（src/canvas/canvasModelLabels.ts）改用供应商真实模型名，重名才追加
 * 供应商显示名 / 配置后缀。旧标签于是成了"清单外的值"，画布页的守卫脚本
 * （public/novai-canvas/openarc-canvas-guard.js 的 pruneOptions / syncNodeField）会把它
 * **静默换成该能力清单的第一个模型** —— 那是换模型，不是改名，属数据/体验损失。
 *
 * 本模块只做一件事：用旧标签**自身携带的信息**（名字 + configId 末 4 位）在当前可用清单里
 * 反查**同一个 configId**，重写成该 configId 的新标签。反查不唯一（歧义）或对不上，一律
 * **保持原值不动**并结构化上报，绝不取"服务商第一个模型"这种猜测。
 *
 * 与 src/canvas/canvasModelLabels.ts 是同一套命名规则的 CJS 端口：宿主主进程（CJS）无法
 * require .ts，故这里保留一份；tests/dxos-canvas-legacy-label-migration.test.mjs 用同一批
 * 清单逐条比对两份实现，规则漂移会直接红。
 */
"use strict";

/** 命名分隔符 / 旧后缀长度：必须与 src/canvas/canvasModelLabels.ts 一致。 */
const LABEL_SEPARATOR = " · ";
const LEGACY_SUFFIX_LEN = 4;

/** 文档里承载模型标签的字段。只改这些字段，其它节点数据 / 几何 / 连线一律不碰。 */
const NODE_MODEL_FIELDS = Object.freeze(["model", "llmMsModel"]);
const LOG_MODEL_FIELDS = Object.freeze(["model"]);

const str = (v) => (v == null ? "" : String(v));

// ------------------------------------------------------------------ 命名规则（TS 的 CJS 端口）

/** 基础名：供应商真实模型名 > 本地显示名 > configId。 */
function canvasModelBaseName(m) {
  const remote = str(m && m.remoteModelId).trim();
  if (remote) return remote;
  const display = str(m && m.displayName).trim();
  if (display) return display;
  return str(m && m.configId).trim();
}

/** 消歧用的供应商身份：显示名优先，缺失时退回 providerId，再退回中性占位。 */
function providerLabelOf(m) {
  const name = str(m && m.providerName).trim();
  if (name) return name;
  const id = str(m && m.providerId).trim();
  return id || "未知供应商";
}

function groupIndexes(values) {
  const out = new Map();
  values.forEach((v, i) => {
    const list = out.get(v);
    if (list) list.push(i);
    else out.set(v, [i]);
  });
  return out;
}

function shortestUniqueConfigSuffix(ids) {
  const max = Math.max(1, ...ids.map((id) => id.length));
  for (let len = LEGACY_SUFFIX_LEN; len <= max; len += 1) {
    const seen = new Set();
    let unique = true;
    for (const id of ids) {
      const suffix = id.slice(-len);
      if (seen.has(suffix)) { unique = false; break; }
      seen.add(suffix);
    }
    if (unique) return len;
  }
  return Number.POSITIVE_INFINITY;
}

/** configId → 新标签；新标签 → configId（双射）。与 buildCanvasModelLabelIndex 同规则。 */
function buildCanvasModelLabels(models) {
  const rows = (Array.isArray(models) ? models : []).map((m) => ({
    configId: str(m && m.configId),
    base: canvasModelBaseName(m),
    provider: providerLabelOf(m),
  }));
  const labels = rows.map((r) => r.base);

  for (const group of groupIndexes(rows.map((r) => r.base)).values()) {
    if (group.length < 2) continue;
    for (const i of group) labels[i] = rows[i].base + LABEL_SEPARATOR + rows[i].provider;
  }
  for (const group of groupIndexes(labels.slice()).values()) {
    if (group.length < 2) continue;
    const len = shortestUniqueConfigSuffix(group.map((i) => rows[i].configId));
    for (const i of group) labels[i] = labels[i] + LABEL_SEPARATOR + rows[i].configId.slice(-len);
  }
  for (const group of groupIndexes(labels.slice()).values()) {
    if (group.length < 2) continue;
    for (const i of group) labels[i] = labels[i] + LABEL_SEPARATOR + rows[i].configId;
  }

  const labelOf = new Map();
  const configOf = new Map();
  rows.forEach((r, i) => {
    labelOf.set(r.configId, labels[i]);
    configOf.set(labels[i], r.configId);
  });
  return { labelOf, configOf };
}

// ------------------------------------------------------------------ 旧标签反查

/** 旧实现里拼进标签的名字部分：`displayName || remoteModelId || configId`（不 trim，原样）。 */
function legacyBaseName(m) {
  return str(m && (m.displayName || m.remoteModelId || m.configId));
}

/**
 * 拆旧标签：`名字 · 后缀`。后缀取自 configId 的末 4 位（configId 短于 4 位时是全长），
 * 名字里本身可能含分隔符，所以从**最后一个**分隔符切。拆不出 / 后缀长度不是 1..4 → null。
 */
function parseLegacyLabel(value) {
  const text = str(value);
  const idx = text.lastIndexOf(LABEL_SEPARATOR);
  if (idx <= 0) return null;
  const name = text.slice(0, idx);
  const suffix = text.slice(idx + LABEL_SEPARATOR.length);
  if (suffix.length < 1 || suffix.length > LEGACY_SUFFIX_LEN) return null;
  return { name, suffix };
}

/**
 * 后缀必须**恰好**是 `configId.slice(-4)`（长度 = min(4, configId.length)）—— 这条把
 * "新标签里 1..4 字的供应商后缀"与"旧标签的 configId 尾号"区分开，避免误迁移。
 */
function suffixMatchesConfig(suffix, configId) {
  const want = Math.min(LEGACY_SUFFIX_LEN, configId.length);
  return suffix.length === want && configId.endsWith(suffix);
}

/** 旧标签在当前清单里的候选配置：后缀 + 名字都对得上才算。 */
function legacyCandidates(value, models) {
  const parsed = parseLegacyLabel(value);
  if (!parsed) return null;
  const out = [];
  for (const m of models) {
    const configId = str(m && m.configId);
    if (!configId) continue;
    if (!suffixMatchesConfig(parsed.suffix, configId)) continue;
    if (legacyBaseName(m) !== parsed.name) continue;
    out.push(m);
  }
  return { parsed, candidates: out };
}

// ------------------------------------------------------------------ 迁移主函数

function emptyReport() {
  return { scanned: 0, changed: false, migrated: [], ambiguous: [], unresolved: [], alreadyCurrent: 0 };
}

/**
 * 把文档里旧格式模型标签迁移成同一 configId 的新标签。
 *
 * @param doc    画布文档（`{ nodes, connections, viewport, logs }`；任意只读形状都行）
 * @param models 当前可用模型清单（`{ configId, remoteModelId?, displayName?, providerId?, providerName? }[]`）
 * @returns `{ doc, report }` —— 无迁移时 doc 返回**原引用**；非模型字段不复制不改写。
 */
function migrateCanvasModelLabels(doc, models) {
  const report = emptyReport();
  if (!doc || typeof doc !== "object") return { doc, report };
  const list = Array.isArray(models) ? models : [];
  const index = buildCanvasModelLabels(list);

  /** 检查一个字符串字段；需要时返回新值。record 的唯一出口，保证 report 完整。 */
  const visit = (scope, ownerId, field, value) => {
    if (typeof value !== "string" || !value) return value;
    report.scanned += 1;
    if (index.configOf.has(value)) { report.alreadyCurrent += 1; return value; }
    const found = legacyCandidates(value, list);
    if (!found) {
      report.unresolved.push({ scope, ownerId, field, value, reason: "NOT_LEGACY" });
      return value;
    }
    if (found.candidates.length === 0) {
      report.unresolved.push({ scope, ownerId, field, value, reason: "NOT_FOUND" });
      return value;
    }
    if (found.candidates.length > 1) {
      report.ambiguous.push({
        scope, ownerId, field, value,
        name: found.parsed.name, suffix: found.parsed.suffix,
        candidates: found.candidates.map((m) => str(m && m.configId)),
      });
      return value;
    }
    const configId = str(found.candidates[0].configId);
    const to = index.labelOf.get(configId);
    if (!to || to === value) {
      // 对上了同一 configId 却没有新标签（清单为空等）：保持原值并上报，不猜。
      if (!to) report.unresolved.push({ scope, ownerId, field, value, reason: "NOT_FOUND" });
      else report.alreadyCurrent += 1;
      return value;
    }
    report.migrated.push({ scope, ownerId, field, from: value, to, configId });
    return to;
  };

  let nodes = null;
  if (Array.isArray(doc.nodes)) {
    nodes = doc.nodes.map((node, i) => {
      if (!node || typeof node !== "object") return node;
      const ownerId = typeof node.id === "string" && node.id ? node.id : null;
      let copy = null;
      for (const field of NODE_MODEL_FIELDS) {
        const next = visit("node", ownerId, field, node[field]);
        if (next !== node[field]) {
          if (!copy) copy = { ...node };
          copy[field] = next;
        }
      }
      return copy || node;
    });
  }

  let logs = null;
  if (Array.isArray(doc.logs)) {
    logs = doc.logs.map((log, i) => {
      if (!log || typeof log !== "object") return log;
      const ownerId = typeof log.id === "string" && log.id ? log.id : "logs[" + i + "]";
      let copy = null;
      for (const field of LOG_MODEL_FIELDS) {
        const next = visit("log", ownerId, field, log[field]);
        if (next !== log[field]) {
          if (!copy) copy = { ...log };
          copy[field] = next;
        }
      }
      return copy || log;
    });
  }

  report.changed = report.migrated.length > 0;
  if (!report.changed) return { doc, report };

  const next = { ...doc };
  if (nodes) next.nodes = nodes;
  if (logs) next.logs = logs;
  return { doc: next, report };
}

module.exports = {
  LABEL_SEPARATOR,
  LEGACY_SUFFIX_LEN,
  NODE_MODEL_FIELDS,
  LOG_MODEL_FIELDS,
  canvasModelBaseName,
  providerLabelOf,
  buildCanvasModelLabels,
  parseLegacyLabel,
  legacyCandidates,
  migrateCanvasModelLabels,
};
