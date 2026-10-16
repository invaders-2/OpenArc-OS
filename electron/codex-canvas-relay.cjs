/**
 * DX OS 0.6.1 · codex-canvas 中继（移植：server/index.ts:1219-1259 + server/codexCanvas.ts:35-124）。
 *
 * 为什么与源不同（本仓硬约束，不可照搬）：
 *   · 源在激活后 fetch(http://127.0.0.1:PORT/api/codex-canvas<path>)（index.ts:1247-1251），
 *     本仓渲染层不得直连本地端口、主进程不得自起 HTTP，因此把这一步换成**注入的进程内
 *     dispatch**：由 codex-canvas-bootstrap.cjs 把 method+path 映射到既有 canvas 命令/服务。
 *   · 其余语义逐条保持：id=sha256(pairing code)（codexCanvas.ts:53-55,82-89）、
 *     AES-256-GCM 信封 id/iv/data（index.ts:1227-1235,1254-1257）、nonce 防重放
 *     （codexCanvas.ts:98-106）、路由白名单 + images 正则（index.ts:1219-1224,1244-1245）、
 *     超时 40s / generation/execute 130s（index.ts:1250）。
 *
 * 配对码与授权令牌从不进信封明文：id 只是 sha256(code) 的十六进制，code 只出现在
 * 首次 /connect 的密文里（index.ts:1238）。
 */
"use strict";

const { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } = require("node:crypto");

// server/index.ts:1219-1224 白名单逐条照抄，顺序与内容一致。
const RELAY_ROUTES = Object.freeze([
  "GET /snapshot", "GET /image-models", "POST /nodes/find", "POST /nodes/get",
  "POST /nodes/rename", "POST /nodes/edit", "POST /connections/change",
  "POST /cards", "POST /generation/preview", "POST /generation/execute",
  "POST /generation/query",
]);

// server/index.ts:1244 images 正则：taskId 只允许字母数字连字符，长度 1-100。
const IMAGE_ROUTE_PATTERN = /^\/generation\/images\?taskId=[a-zA-Z0-9-]{1,100}$/;

// server/index.ts:1230 iv 必须 12 字节；data 最少 17 字节（16 GCM tag + ≥1 密文），上限 3MB。
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MIN_DATA_BYTES = TAG_BYTES + 1;
const MAX_DATA_BYTES = 3_000_000;
// server/index.ts:1250 默认 40s；generation/execute 单独 130s。
const DEFAULT_TIMEOUT_MS = 40_000;
const EXECUTE_TIMEOUT_MS = 130_000;
// server/index.ts:1232 密钥派生前缀原样保留，换掉会与既有 MCP 桥不兼容。
const RELAY_KEY_PREFIX = "dxos-canvas-relay/v1:";
const CANVAS_ID_TTL_MS = 5 * 60_000; // codexCanvas.ts:54 配对码 5 分钟
const GRANT_TTL_MS = 8 * 60 * 60_000; // codexCanvas.ts:55 授权 8 小时
const NONCE_CACHE_LIMIT = 4096; // codexCanvas.ts:103 有界的重放缓存

class CodexCanvasRelayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CodexCanvasRelayError";
    this.code = code;
  }
}

/** server/index.ts:1232：key = sha256("dxos-canvas-relay/v1:" + code)，返回 32 字节 raw。 */
function deriveRelayKey(code) {
  return createHash("sha256").update(RELAY_KEY_PREFIX + String(code)).digest();
}

/** codexCanvas.ts:36 的 hash(value)：pending / grants 的键都是 sha256 十六进制。 */
function hashKey(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

/** codexCanvas.ts:86-88：服务端用 id 反查配对码；id 就是 sha256(code) 的 hex。 */
function relayIdForCode(code) {
  return hashKey(code);
}

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const asStr = (v, max = 4096) => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, max);

/**
 * 客户端侧封口（源里由外部 dxos-canvas-mcp 桥实现，0.6.1 未随包发布）。
 * 供本仓桥接进程与测试使用，服务端逻辑不依赖它。
 */
function sealRelayEnvelope(code, payload, options = {}) {
  const iv = options.iv ? Buffer.from(options.iv) : randomBytes(IV_BYTES);
  if (iv.length !== IV_BYTES) throw new CodexCanvasRelayError("INVALID_ENVELOPE", "iv 必须为 12 字节");
  const cipher = createCipheriv("aes-256-gcm", deriveRelayKey(code), iv);
  const sealed = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]);
  return { id: relayIdForCode(code), iv: iv.toString("base64"), data: sealed.toString("base64") };
}

/** 打开一个信封（请求或响应同形：iv + data + GCM tag）。认证失败即拒绝。 */
function openRelayEnvelope(code, envelope) {
  if (!isObj(envelope)) throw new CodexCanvasRelayError("INVALID_ENVELOPE", "桥接请求无效");
  const iv = Buffer.from(asStr(envelope.iv), "base64");
  const data = Buffer.from(asStr(envelope.data), "base64");
  if (iv.length !== IV_BYTES || data.length < MIN_DATA_BYTES) throw new CodexCanvasRelayError("INVALID_ENVELOPE", "桥接请求无效");
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveRelayKey(code), iv);
    decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(0, -TAG_BYTES)), decipher.final()]).toString("utf8"));
  } catch (error) {
    if (error instanceof CodexCanvasRelayError) throw error;
    throw new CodexCanvasRelayError("DECRYPT_FAILED", "桥接请求无法解密");
  }
}

/**
 * 中继装配。dispatch 是源的 fetch 替代品：
 *   dispatch({ method, path, body, token, grant, signal }) => Promise<{ status, body }>
 * 由 bootstrap 负责把 method+path 落到既有 canvas 命令/服务；本模块本身不做 HTTP。
 */
function createCodexCanvasRelay({
  dispatch = null,
  clock = () => Date.now(),
  pairTtlMs = CANVAS_ID_TTL_MS,
  grantTtlMs = GRANT_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  executeTimeoutMs = EXECUTE_TIMEOUT_MS,
  exchange = null,
  authorizePair = null,
  authorizeToken = null,
  logger = null,
} = {}) {
  if (typeof dispatch !== "function") throw new Error("createCodexCanvasRelay 需要 dispatch 函数");
  const now = () => (typeof clock === "function" ? clock() : Date.now());
  const pending = new Map(); // sha256(code) -> { code, expiresAt, grant }   （codexCanvas.ts:33）
  const grants = new Map(); // sha256(token) -> grant                        （codexCanvas.ts:34）
  const channels = new Map(); // id -> { code, token, grant, nonces }        （codexCanvas.ts:35）
  const timingSafeEqualStr = (a, b) => {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  };

  // codexCanvas.ts:43-47：过期即清，避免 pending/grants/channels 无界。
  function prune() {
    const at = now();
    for (const [key, value] of pending) if (value.expiresAt <= at) pending.delete(key);
    for (const [key, value] of grants) if (value.expiresAt <= at) grants.delete(key);
    for (const [key, value] of channels) {
      if (value.grant.expiresAt <= at || !grants.has(hashKey(value.token))) channels.delete(key);
    }
  }

  /** codexCanvas.ts:49-58：生成一次性配对码；返回给已认证画布所有者。 */
  function pair({ user, sessionId, canvasId } = {}) {
    if (!user || !sessionId || !canvasId) throw new CodexCanvasRelayError("INVALID_INPUT", "配对需要 user / sessionId / canvasId");
    const grant = { user, sessionId, canvasId, expiresAt: now() + grantTtlMs };
    if (typeof authorizePair === "function") {
      const allowed = authorizePair(grant);
      if (allowed === false) throw new CodexCanvasRelayError("PAIR_FORBIDDEN", "当前账号没有此画布的编辑权限");
    }
    prune();
    // codexCanvas.ts:52：同一会话 + 同一画布只保留最新一条配对。
    for (const [key, value] of pending) {
      if (value.grant.sessionId === sessionId && value.grant.canvasId === canvasId) pending.delete(key);
    }
    const code = randomBytes(18).toString("base64url");
    const expiresAt = now() + pairTtlMs;
    pending.set(hashKey(code), { code, expiresAt, grant });
    return { code, expiresAt, canvasId, username: user.username || user.id || null };
  }

  /** codexCanvas.ts:82-89：id 只暴露 sha256(code)；未知 id 一律拒绝。 */
  function secret(id) {
    prune();
    if (!/^[0-9a-f]{64}$/.test(String(id))) throw new CodexCanvasRelayError("INVALID_SESSION", "无效的桥接会话");
    const active = channels.get(id) || null;
    const waiting = pending.get(id) || null;
    if (!active && !waiting) throw new CodexCanvasRelayError("SESSION_EXPIRED", "配对码已过期或连接已撤销");
    return { code: (active || waiting).code, active, waiting };
  }

  /** codexCanvas.ts:91-96 + 67-78：兑换配对码、铸 token、注册通道。 */
  async function activate(id, code) {
    const key = hashKey(code);
    const entry = pending.get(key);
    if (!entry || entry.expiresAt <= now()) throw new CodexCanvasRelayError("PAIR_INVALID", "配对码无效或已过期，请在画布重新生成");
    pending.delete(key);
    if (typeof authorizeToken === "function") {
      const allowed = authorizeToken(entry.grant);
      if (allowed === false) throw new CodexCanvasRelayError("SESSION_INACTIVE", "账号会话或画布编辑权限已失效");
    }
    let connected;
    if (typeof exchange === "function") {
      connected = await exchange({ code, grant: entry.grant });
    } else {
      connected = { token: randomBytes(32).toString("base64url") };
    }
    if (!connected || !connected.token) throw new CodexCanvasRelayError("PAIR_INVALID", "配对兑换失败");
    const token = String(connected.token);
    grants.set(hashKey(token), entry.grant);
    channels.set(id, { code, token, grant: entry.grant, nonces: new Set() });
    return {
      username: connected.username || entry.grant.user.username || entry.grant.user.id || null,
      canvas: connected.canvas || { id: entry.grant.canvasId, title: null, version: null },
      expiresAt: connected.expiresAt || entry.grant.expiresAt,
    };
  }

  /** codexCanvas.ts:98-106：同一 iv 二次出现即拒；缓存有界；随后再次校验授权。 */
  function markNonce(id, nonce) {
    const channel = channels.get(id);
    if (!channel) return;
    if (channel.nonces.has(nonce)) throw new CodexCanvasRelayError("REPLAY_REJECTED", "重复的桥接请求已拒绝");
    if (channel.nonces.size >= NONCE_CACHE_LIMIT) {
      const oldest = channel.nonces.values().next().value;
      if (oldest !== undefined) channel.nonces.delete(oldest);
    }
    channel.nonces.add(nonce);
    if (typeof authorizeToken === "function") {
      const allowed = authorizeToken(channel.grant);
      if (allowed === false) {
        channels.delete(id);
        throw new CodexCanvasRelayError("SESSION_INACTIVE", "Codex 授权无效或已撤销，请重新配对");
      }
    }
  }

  /** codexCanvas.ts:119-124：撤销某用户某画布的全部配对 / 授权 / 通道。 */
  function revoke({ userId, canvasId } = {}) {
    const uid = userId == null ? null : String(userId);
    const cid = canvasId == null ? null : String(canvasId);
    for (const [key, value] of pending) if (value.grant.user.id === uid && value.grant.canvasId === cid) pending.delete(key);
    for (const [key, value] of grants) if (value.user.id === uid && value.canvasId === cid) grants.delete(key);
    for (const [key, value] of channels) if (value.grant.user.id === uid && value.grant.canvasId === cid) channels.delete(key);
    return { ok: true };
  }

  /** 带超时的进程内 dispatch；AbortController 让既有服务能像 fetch 一样被中止（index.ts:1250）。 */
  async function dispatchWithTimeout(args, ms) {
    const controller = new AbortController();
    let timer = null;
    try {
      return await Promise.race([
        Promise.resolve().then(() => dispatch({ ...args, signal: controller.signal })),
        // 定时器不 unref：一次在途 dispatch 必须能等到超时；成功路径会 clearTimeout。
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new CodexCanvasRelayError("TIMEOUT", "桥接操作超时"));
          }, ms);
        }),
      ]);
    } catch (error) {
      if (error instanceof CodexCanvasRelayError) throw error;
      throw new CodexCanvasRelayError("DISPATCH_FAILED", String((error && error.message) || error));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function fail(error) {
    const code = error instanceof CodexCanvasRelayError ? error.code : "INTERNAL_ERROR";
    const message = String((error && error.message) || error || "桥接失败");
    if (logger && typeof logger.warn === "function") logger.warn("[codex-canvas-relay] " + code + ": " + message);
    // 源 index.ts:1258 统一 fail(...,403)：错误分支不加密、不回传明文请求内容。
    return { ok: false, status: 403, error: code, message };
  }

  /**
   * 主入口：等价 POST /api/codex-canvas/relay（index.ts:1225-1259）。
   * @returns {Promise<{ok:true,iv:string,data:string}|{ok:false,status:number,error:string,message:string}>}
   */
  async function relay(envelope) {
    let key = null;
    let id = "";
    try {
      id = asStr(envelope && envelope.id, 200);
      const iv = Buffer.from(asStr(envelope && envelope.iv, 100), "base64");
      const data = Buffer.from(asStr(envelope && envelope.data, MAX_DATA_BYTES * 2), "base64");
      // index.ts:1230 长度/超长先拒，避免把大包带进解密。
      if (iv.length !== IV_BYTES || data.length < MIN_DATA_BYTES || data.length > MAX_DATA_BYTES) {
        throw new CodexCanvasRelayError("INVALID_ENVELOPE", "桥接请求无效");
      }
      const resolved = secret(id);
      const { code, active } = resolved;
      key = deriveRelayKey(code);
      let input;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
        input = JSON.parse(Buffer.concat([decipher.update(data.subarray(0, -TAG_BYTES)), decipher.final()]).toString("utf8"));
      } catch {
        // 错密钥 / 错 iv / 篡改密文都会落到这里（GCM 认证失败）。
        throw new CodexCanvasRelayError("DECRYPT_FAILED", "桥接请求无法解密");
      }
      if (!isObj(input)) throw new CodexCanvasRelayError("INVALID_ENVELOPE", "桥接请求无效");

      let result;
      if (!active) {
        // index.ts:1237-1239：未激活只接受 POST /connect，且密文里的 code 必须匹配。
        const method = asStr(input.method, 16);
        const path = asStr(input.path, 200);
        if (method !== "POST" || path !== "/connect" || !timingSafeEqualStr(input.code, code)) {
          throw new CodexCanvasRelayError("PAIR_REQUIRED", "请先使用画布配对码连接");
        }
        const activated = await activate(id, code);
        result = { status: 200, body: { ok: true, ...activated } };
      } else {
        // index.ts:1241-1252：先登记 nonce（重放即拒），再校验白名单，再进程内调用。
        markNonce(id, iv.toString("base64"));
        const method = asStr(input.method, 16);
        const path = asStr(input.path, 200);
        const imageRoute = method === "GET" && IMAGE_ROUTE_PATTERN.test(path);
        if (!RELAY_ROUTES.includes(method + " " + path) && !imageRoute) {
          throw new CodexCanvasRelayError("ROUTE_NOT_ALLOWED", "不支持的桥接操作");
        }
        const channel = channels.get(id);
        const ms = path === "/generation/execute" ? executeTimeoutMs : timeoutMs;
        const dispatched = await dispatchWithTimeout({ method, path, body: input.body || {}, token: channel.token, grant: channel.grant }, ms);
        const status = Number(dispatched && dispatched.status);
        result = { status: Number.isFinite(status) ? status : 200, body: dispatched ? dispatched.body : null };
      }

      // index.ts:1254-1257：响应换新 iv，用同一把 key 回加密。
      const responseIv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, responseIv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(result)), cipher.final(), cipher.getAuthTag()]);
      return { ok: true, iv: responseIv.toString("base64"), data: encrypted.toString("base64") };
    } catch (error) {
      return fail(error);
    }
  }

  return {
    pair,
    revoke,
    secret,
    relay,
    // 只读调试面（测试/诊断用），不通过 IPC 暴露 code。
    inspect() {
      prune();
      return { pending: pending.size, grants: grants.size, channels: channels.size };
    },
  };
}

module.exports = {
  RELAY_KEY_PREFIX,
  RELAY_ROUTES,
  IMAGE_ROUTE_PATTERN,
  IV_BYTES,
  TAG_BYTES,
  MIN_DATA_BYTES,
  MAX_DATA_BYTES,
  DEFAULT_TIMEOUT_MS,
  EXECUTE_TIMEOUT_MS,
  NONCE_CACHE_LIMIT,
  CodexCanvasRelayError,
  deriveRelayKey,
  relayIdForCode,
  sealRelayEnvelope,
  openRelayEnvelope,
  createCodexCanvasRelay,
};
