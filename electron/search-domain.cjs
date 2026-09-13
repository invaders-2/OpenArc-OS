/**
 * D3-04C · Search / Index / Preview 纯领域模型。
 *
 * 与其它 *-domain.cjs 同一约束：**纯函数、无 Electron、无 DOM、无 I/O**。
 *
 * 关键决定：SQLite FTS5 的 unicode61 把连续 CJK 当成一个 token，trigram 又要求 >=3 字，
 * 因此单靠 tokenizer 无法满足「鞋子」(2 字) 这类中文查询。
 * 本模块用**受控本地 n-gram**：索引时写入 CJK unigram + bigram，查询时按需生成 bigram（或单字 unigram）。
 * FTS5 只当分词容器；Authorization 永远在服务端。
 */
"use strict";

const crypto = require("node:crypto");

const INDEX_STATUS = Object.freeze({
  PENDING: "PENDING",
  INDEXING: "INDEXING",
  READY: "READY",
  STALE: "STALE",
  NO_TEXT: "NO_TEXT",
  UNAVAILABLE: "UNAVAILABLE",
  FAILED: "FAILED",
});

const PREVIEW_KIND = Object.freeze({
  TEXT: "text",
  IMAGE: "image",
  VIDEO: "video",
  AUDIO: "audio",
  PDF: "pdf",
  UNSUPPORTED: "unsupported",
});

const REASON = Object.freeze({
  INVALID_INPUT: "INVALID_INPUT",
  NOT_FOUND_OR_FORBIDDEN: "NOT_FOUND_OR_FORBIDDEN",
  QUERY_EMPTY: "QUERY_EMPTY",
  QUERY_TOO_LONG: "QUERY_TOO_LONG",
  SEARCH_UNAVAILABLE: "SEARCH_UNAVAILABLE",
  INDEX_FAILED: "INDEX_FAILED",
  PREVIEW_UNSUPPORTED: "PREVIEW_UNSUPPORTED",
  PREVIEW_UNAVAILABLE: "PREVIEW_UNAVAILABLE",
  CAPABILITY_INVALID: "CAPABILITY_INVALID",
  CAPABILITY_EXPIRED: "CAPABILITY_EXPIRED",
  RANGE_INVALID: "RANGE_INVALID",
  NO_TEXT: "NO_TEXT",
});

const LIMITS = Object.freeze({
  MAX_QUERY_LENGTH: 256,
  MAX_SNIPPET_CHARS: 240,
  MAX_PREVIEW_TEXT_BYTES: 256 * 1024,
  MAX_INDEX_TEXT_BYTES: 2 * 1024 * 1024,
  MAX_SCAN: 5000,
  FTS_BATCH: 200,
  MAX_RANGE_BYTES: 8 * 1024 * 1024,
});

/** Preview capability 有效期（短时）。 */
const PREVIEW_CAPABILITY_TTL_MS = 60 * 1000;
const PREVIEW_VERSION = 1;
const INDEX_VERSION = 1;

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af\u3005\u3006]/;
const WORD_RE = /[\p{L}\p{N}_]/u;
const isCjk = (ch) => CJK_RE.test(ch);
const isWordChar = (ch) => !isCjk(ch) && WORD_RE.test(ch);

const normalizeText = (v) => String(v == null ? "" : v).normalize("NFKC").toLowerCase();

/**
 * 索引分词：ASCII/Unicode 词按整词；CJK 写 unigram + bigram。
 * 结果去重后 join(' ') 写入 FTS token 列。
 */
function tokenizeForIndex(raw) {
  const s = normalizeText(raw);
  const tokens = [];
  const seen = new Set();
  const push = (t) => {
    if (t && !seen.has(t)) {
      seen.add(t);
      tokens.push(t);
    }
  };
  let word = "";
  let prevCjk = "";
  const flushWord = () => {
    if (word) {
      push(word);
      word = "";
    }
  };
  for (const ch of s) {
    if (isCjk(ch)) {
      flushWord();
      push(ch);
      if (prevCjk) push(prevCjk + ch);
      prevCjk = ch;
    } else if (isWordChar(ch)) {
      prevCjk = "";
      word += ch;
    } else {
      flushWord();
      prevCjk = "";
    }
  }
  flushWord();
  return tokens;
}

/** 便于测试/调试：token 串。 */
const indexTokenString = (raw) => tokenizeForIndex(raw).join(" ");

/**
 * 查询分词：单字 CJK -> unigram；>=2 字 CJK -> 全部 bigram（AND 语义保证精度）。
 * ASCII/Unicode 词按整词。返回 tokens（FTS）与 displayTerms（snippet/highlight 用原文片段）。
 */
function parseQuery(raw) {
  const s = normalizeText(raw).trim();
  if (!s) return { ok: false, error: REASON.QUERY_EMPTY };
  if (s.length > LIMITS.MAX_QUERY_LENGTH) return { ok: false, error: REASON.QUERY_TOO_LONG };
  const tokens = [];
  const displayTerms = [];
  for (const seg of s.split(/\s+/).filter(Boolean)) {
    let cjkRun = "";
    let word = "";
    const flushCjk = () => {
      if (!cjkRun) return;
      displayTerms.push(cjkRun);
      if (cjkRun.length === 1) tokens.push(cjkRun);
      else for (let i = 0; i < cjkRun.length - 1; i += 1) tokens.push(cjkRun.slice(i, i + 2));
      cjkRun = "";
    };
    const flushWord = () => {
      if (!word) return;
      displayTerms.push(word);
      tokens.push(word);
      word = "";
    };
    for (const ch of seg) {
      if (isCjk(ch)) {
        flushWord();
        cjkRun += ch;
      } else if (isWordChar(ch)) {
        flushCjk();
        word += ch;
      } else {
        flushCjk();
        flushWord();
      }
    }
    flushCjk();
    flushWord();
  }
  const uniq = [...new Set(tokens)].filter(Boolean);
  if (!uniq.length) return { ok: false, error: REASON.QUERY_EMPTY };
  return { ok: true, tokens: uniq, displayTerms: [...new Set(displayTerms)], normalized: s };
}

/**
 * 构造安全的 FTS5 MATCH 串：每个 token 用双引号包裹（内部双引号翻倍），
 * 空格 = implicit AND。用户输入不会变成 FTS 操作符。
 */
function buildFtsQuery(tokens) {
  return (tokens || [])
    .filter(Boolean)
    .map((t) => '"' + String(t).replace(/"/g, '""') + '"')
    .join(" ");
}

/** 结构化 snippet + highlight（绝不返回 HTML 字符串）。 */
function buildSnippet(rawText, displayTerms, maxChars = LIMITS.MAX_SNIPPET_CHARS) {
  const src = String(rawText == null ? "" : rawText);
  if (!src) return { text: "", spans: [], truncated: false, matched: false };
  const lower = src.toLowerCase();
  const terms = [...new Set((displayTerms || []).map((t) => String(t).toLowerCase()).filter(Boolean))].sort((a, b) => b.length - a.length);
  let first = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (first < 0 || i < first)) first = i;
  }
  if (first < 0) return { text: "", spans: [], truncated: false, matched: false };
  const start = Math.max(0, first - Math.floor(maxChars / 3));
  const end = Math.min(src.length, start + maxChars);
  const slice = src.slice(start, end);
  const sliceLower = slice.toLowerCase();
  const ranges = [];
  for (const t of terms) {
    let from = 0;
    while (t && from <= sliceLower.length - t.length) {
      const i = sliceLower.indexOf(t, from);
      if (i < 0) break;
      if (!ranges.some((r) => i < r.end && i + t.length > r.start)) ranges.push({ start: i, end: i + t.length });
      from = i + Math.max(1, t.length);
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  const spans = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start > cursor) spans.push({ text: slice.slice(cursor, r.start), match: false });
    spans.push({ text: slice.slice(r.start, r.end), match: true });
    cursor = r.end;
  }
  if (cursor < slice.length) spans.push({ text: slice.slice(cursor), match: false });
  return { text: slice, spans, truncated: start > 0 || end < src.length, matched: true };
}

/** 命中的字段列表（用原文 displayTerms 大小写不敏感匹配）。 */
function matchedFields(doc, displayTerms) {
  const terms = (displayTerms || []).map((t) => String(t).toLowerCase()).filter(Boolean);
  const hit = (value) => {
    if (!value) return false;
    const v = String(value).toLowerCase();
    return terms.some((t) => t && v.includes(t));
  };
  const fields = [];
  if (hit(doc.name)) fields.push("name");
  if (hit(doc.description)) fields.push("description");
  if (hit(doc.tags_text)) fields.push("tag");
  if (hit(doc.collection_name)) fields.push("collection");
  if (hit(doc.content_text)) fields.push("content");
  return fields;
}

const SCORE_WEIGHTS = Object.freeze({ name: 6, tag: 4, description: 2, collection: 1, content: 0.5 });

/**
 * 确定性 ranking：bm25（越小越好）取反 + 字段命中 boost + updatedAt 微调。
 * Renderer 不得重算另一套排序。
 */
function computeScore({ bm25 = 0, fields = [], updatedAt = 0 }) {
  let score = -Number(bm25 || 0);
  for (const f of fields) score += SCORE_WEIGHTS[f] || 0;
  score += Math.min(1, Number(updatedAt || 0) / 1e13);
  return score;
}

/** Preview cache key：resourceId + resourceVersion + checksum + kind + previewVersion。 */
function previewCacheKey({ resourceId, resourceVersion, checksum, kind, previewVersion = PREVIEW_VERSION }) {
  const raw = [resourceId, resourceVersion, checksum || "nohash", kind, previewVersion].join("|");
  return "pv_" + crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 32);
}

function previewCacheKeyParts({ resourceId, resourceVersion, checksum, kind, previewVersion = PREVIEW_VERSION }) {
  return { resourceId, resourceVersion, checksum: checksum || null, kind, previewVersion };
}

/** 解析 HTTP-like Range 头（bytes=start-end / bytes=start- / bytes=-suffix）。 */
function parseRange(header, size) {
  if (!header) return { ok: true, range: null };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return { ok: false, error: REASON.RANGE_INVALID };
  const total = Number(size);
  let start;
  let end;
  if (m[1] === "" && m[2] === "") return { ok: false, error: REASON.RANGE_INVALID };
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return { ok: false, error: REASON.RANGE_INVALID };
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? total - 1 : Number(m[2]);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) return { ok: false, error: REASON.RANGE_INVALID };
  end = Math.min(end, total - 1);
  if (end - start + 1 > LIMITS.MAX_RANGE_BYTES) end = start + LIMITS.MAX_RANGE_BYTES - 1;
  return { ok: true, range: { start, end, length: end - start + 1, total } };
}

function validatePreviewKind(kind) {
  const k = String(kind || "");
  if (!Object.values(PREVIEW_KIND).includes(k)) return { ok: false, error: REASON.INVALID_INPUT };
  return { ok: true, kind: k };
}

function availabilityIsPreviewable(availability) {
  return availability === "AVAILABLE";
}

module.exports = {
  INDEX_STATUS,
  PREVIEW_KIND,
  REASON,
  LIMITS,
  PREVIEW_CAPABILITY_TTL_MS,
  PREVIEW_VERSION,
  INDEX_VERSION,
  SCORE_WEIGHTS,
  isCjk,
  normalizeText,
  tokenizeForIndex,
  indexTokenString,
  parseQuery,
  buildFtsQuery,
  buildSnippet,
  matchedFields,
  computeScore,
  previewCacheKey,
  previewCacheKeyParts,
  parseRange,
  validatePreviewKind,
  availabilityIsPreviewable,
};
