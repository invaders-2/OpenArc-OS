/**
 * D3-01 · 口令 KDF 与 verifier 编解码。
 *
 * **不自建 hash。** 候选按 ADR §6 评估：
 *
 *   Argon2id —— 首选（OWASP 2024 首推）。但它没有 Node 官方实现，
 *               只能引 `@node-rs/argon2` / `argon2` 这类 **native 依赖**，
 *               需要 prebuilt 二进制或本机工具链；D1-06 已冻结
 *               "不为了单阶段引入无法在本机与 Windows 双端验证的 native 依赖"。
 *
 *   scrypt  —— Node `node:crypto` 官方实现（`crypto.scrypt`），**零第三方依赖、
 *               跨平台同一份代码路径**，且是 **memory-hard** KDF（不是简单的迭代 hash）。
 *               RFC 7914 / OWASP 均列为可接受的口令 KDF。
 *
 *   结论：**本轮选 scrypt**，并把 algorithm / parameters / salt / version
 *   全部落库 —— 参数升级时旧 verifier 仍可校验，校验成功后透明重哈希（见 ADR §6）。
 *   Argon2id 作为 `algo` 的第二个取值保留，未来 native 依赖可行时只改本文件。
 *
 * 编码格式（verifier 字符串，存进 users.password_hash）：
 *   scrypt$N$r$p$keylen$<saltB64url>$<hashB64url>
 *
 * 为什么把参数也写进串里：verifier 必须自描述。
 * 否则"升级默认参数"会变成"旧用户再也登不进去"，或者需要一次全量迁移。
 */
"use strict";

const crypto = require("node:crypto");

const ALGO = { SCRYPT: "scrypt", ARGON2ID: "argon2id" };

/**
 * 默认参数。
 *
 * OWASP 对 scrypt 的最低建议是 N=2^16 (64MB) / r=8 / p=1；
 * 对交互式登录场景它同时接受 N=2^14 (16MB)。
 * 这里取 **N=2^15 / r=8 / p=1 = 32MB**：
 *   · 单次派生 ~60ms（本机实测区间 40–90ms），登录与解锁的交互可接受
 *   · 32MB 峰值内存不会让低端机在并发登录时 OOM
 *   · 已经是 memory-hard，GPU/ASIC 批量撞库的成本远高于 PBKDF2
 * 参数可调，未来上调只需改 DEFAULT_PARAMS —— 旧 verifier 靠自描述格式继续可用。
 */
const DEFAULT_PARAMS = { N: 32768, r: 8, p: 1, keylen: 32 };

/** scrypt 的 maxmem 必须显式给，否则 N 较大时 Node 会抛 "Invalid scrypt param"。 */
const maxmemOf = ({ N, r, p }) => 128 * N * r * Math.max(1, p) * 2 + 1024 * 1024;

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url");

function scrypt(password, salt, params) {
  const { N, r, p, keylen } = params;
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      Buffer.isBuffer(password) ? password : Buffer.from(String(password), "utf8"),
      salt,
      keylen,
      { N, r, p, maxmem: maxmemOf(params) },
      (err, derived) => (err ? reject(err) : resolve(derived)),
    );
  });
}

/**
 * 一个"结构合法、值随机"的假 verifier。
 *
 * **存在的理由**：登录时若标识符不存在就直接返回，攻击者可用响应时间
 * 区分"用户不存在"与"密码错误"——这正是 §12 要封住的侧信道。
 * 因此标识符不存在时**照样跑一次完整 KDF**，再返回同一个 INVALID_CREDENTIALS。
 */
let DUMMY = null;
function dummyVerifier() {
  if (!DUMMY) {
    DUMMY = {
      algo: ALGO.SCRYPT,
      params: { ...DEFAULT_PARAMS },
      salt: crypto.randomBytes(16),
      hash: crypto.randomBytes(DEFAULT_PARAMS.keylen),
      version: 1,
    };
  }
  return DUMMY;
}

/** 生成 verifier。salt 每次 16 字节新鲜随机，绝不复用。 */
async function createVerifier(password, params = DEFAULT_PARAMS) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, params);
  return { algo: ALGO.SCRYPT, params: { ...params }, salt, hash, version: 1 };
}

/** verifier → 自描述字符串。 */
function encodeVerifier(v) {
  const { N, r, p, keylen } = v.params;
  return [v.algo, v.version, N, r, p, keylen, b64u(v.salt), b64u(v.hash)].join("$");
}

/** 解析失败返回 null，调用方按 INVALID_CREDENTIALS 处理（不泄漏原因）。 */
function decodeVerifier(text) {
  const parts = String(text || "").split("$");
  if (parts.length !== 8) return null;
  const [algo, version, N, r, p, keylen, salt, hash] = parts;
  if (algo !== ALGO.SCRYPT) return null;
  const params = { N: +N, r: +r, p: +p, keylen: +keylen };
  if (![params.N, params.r, params.p, params.keylen].every((x) => Number.isInteger(x) && x > 0)) return null;
  return { algo, version: +version || 1, params, salt: unb64u(salt), hash: unb64u(hash) };
}

/** 恒定时间比较。长度不等时 timingSafeEqual 会抛，先比长度（长度本身不保密）。 */
function safeEqual(a, b) {
  const ba = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * 校验。
 *
 * 无论成功失败都跑满一次 KDF（失败时也返回，不提前短路），
 * 因此"参数不同导致的早退"不会变成新的时间侧信道。
 */
async function verifyPassword(password, encoded) {
  const v = decodeVerifier(encoded);
  if (!v) {
    await scrypt(password, dummyVerifier().salt, DEFAULT_PARAMS);
    return false;
  }
  const derived = await scrypt(password, v.salt, v.params);
  return safeEqual(derived, v.hash);
}

/**
 * 口令强度。首版只做**最小**约束：长度与字符集不设花样，
 * 因为 D3-01 冻结的是生命周期，不是口令策略产品化。
 * 8 条里最重要的一条是"不能是空串"——空口令等于把门禁拆了。
 */
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1024;

function validatePassword(password) {
  if (typeof password !== "string") return { ok: false, code: "INVALID_INPUT", reason: "password-not-string" };
  if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, code: "INVALID_INPUT", reason: "password-too-short" };
  if (password.length > MAX_PASSWORD_LENGTH) return { ok: false, code: "INVALID_INPUT", reason: "password-too-long" };
  return { ok: true };
}

/** 参数是否"需要升级"（用于登录成功后透明重哈希）。 */
function needsUpgrade(encoded) {
  const v = decodeVerifier(encoded);
  if (!v) return true;
  return v.params.N < DEFAULT_PARAMS.N || v.params.r < DEFAULT_PARAMS.r || v.params.p < DEFAULT_PARAMS.p;
}

module.exports = {
  ALGO,
  DEFAULT_PARAMS,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  createVerifier,
  encodeVerifier,
  decodeVerifier,
  verifyPassword,
  safeEqual,
  validatePassword,
  needsUpgrade,
  dummyVerifier,
  maxmemOf,
};
