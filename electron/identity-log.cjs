/**
 * D3-01 · 身份审计日志（§34）。
 *
 * 继承 D1-05 冻结的两条：**字段白名单** + **secret redaction**。
 *
 * 允许记：event、userId、sessionRef 的哈希、result、errorCode、durationMs。
 * 禁止记：password、password hash、salt、raw session token、
 *         Authorization、完整环境变量、标识符明文（记哈希）。
 *
 * 白名单的实现方式是**构造新对象**而不是"删掉敏感 key"——
 * 后者每加一个字段就可能漏删一次，前者漏加只是"少记一点"。
 */
"use strict";

const crypto = require("node:crypto");

/** 允许出现在日志里的顶层字段。任何不在此列的字段都会被丢弃。 */
const FIELD_WHITELIST = Object.freeze([
  "at",
  "event",
  "user_ref",
  "session_ref_hash",
  "result",
  "error_code",
  "duration_ms",
  "detail",
]);

/**
 * 值层面也要扫：`detail` 是自由文本，最容易夹带 secret。
 * 命中这些形状的值整体替换为 [REDACTED]。
 */
const SENSITIVE_KEY_PATTERN = /(password|passwd|secret|token|authorization|api[_-]?key|salt|credential)/i;

/**
 * 已登记的明文 secret。探针用假口令登记后，
 * 可断言"任何一条日志与任何一份落盘产物都不含它"。
 */
class IdentityLogger {
  constructor({ sink } = {}) {
    this.records = [];
    this.sink = typeof sink === "function" ? sink : null;
    this.secrets = new Set();
  }

  /** 登记一个明文 secret（测试用假口令；生产里不该有任何登记）。 */
  registerSecret(secret) {
    if (typeof secret === "string" && secret) this.secrets.add(secret);
  }

  log(record = {}) {
    const clean = {};
    for (const key of FIELD_WHITELIST) {
      if (!(key in record)) continue;
      clean[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : this.#scrub(record[key]);
    }
    clean.at = Number.isFinite(clean.at) ? clean.at : Date.now();
    this.records.push(clean);
    this.sink?.(clean);
    return clean;
  }

  /** 递归扫值：命中已登记 secret 或敏感形状就整体打码。 */
  #scrub(value) {
    if (typeof value === "string") {
      for (const s of this.secrets) if (value.includes(s)) return "[REDACTED]";
      return value.length > 512 ? `${value.slice(0, 512)}…[truncated]` : value;
    }
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((v) => this.#scrub(v));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_PATTERN.test(k) ? "[REDACTED]" : this.#scrub(v);
    }
    return out;
  }

  /** 已登记 secret 是否泄漏到日志里。返回命中项，空数组 = 干净。 */
  leaks() {
    const hits = [];
    for (const secret of this.secrets) {
      if (JSON.stringify(this.records).includes(secret)) hits.push(secret);
    }
    return hits;
  }

  /**
   * 落盘前自查：给定待序列化的产物，检查是否含已登记 secret。
   * 与 D1-05 的 08-redaction 探针同一判据。
   */
  scanArtifact(obj) {
    const hits = [];
    for (const secret of this.secrets) {
      if (JSON.stringify(obj ?? null)?.includes(secret)) hits.push(secret);
    }
    return hits;
  }

  reset() {
    this.records.length = 0;
  }
}

const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

module.exports = { IdentityLogger, FIELD_WHITELIST, SENSITIVE_KEY_PATTERN, sha256 };
