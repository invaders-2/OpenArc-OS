"use strict";
/**
 * 模型/协议出网代理（HTTP CONNECT 隧道）—— 无第三方依赖，只有 node:net / tls / http / zlib。
 *
 * 为什么需要它：Node 的 fetch（undici）不读代理；NODE_USE_ENV_PROXY / HTTP_PROXY 是**进程启动期**
 * 全局开关，不能只对"模型出口"精确生效。本模块提供一个与被注入 fetchImpl 同签名的函数
 * (url, init) => Response-like，关闭代理时**完全**走注入的 baseFetch（生产 = globalThis.fetch），
 * 开启时代理转发，且只注入到模型域（ModelService / provider-protocol-service / 各 provider 适配器），
 * 绝不写 globalThis，也不影响在线更新 / 开发者应用 / 集成等其它出网。
 *
 * 传输口径：
 *   · https 目标：net.connect(proxy) → 发 CONNECT host:port → 200 后在该隧道上 tls.connect
 *     → http.request({ createConnection: () => tlsSocket }) 发原始请求；
 *   · http 目标（仅回环 / 本地测试场景）：直接向代理发绝对 URI（absolute-form）请求。
 *
 * 安全口径：代理返回 407 → 结构化 PROXY_AUTH_REQUIRED，并如实标注"当前不支持带认证的代理"，
 * 绝不静默降级成直连；隧道失败/代理不可达 → PROXY_TUNNEL_FAILED / PROXY_UNREACHABLE。
 */
const net = require("node:net");
const tls = require("node:tls");
const http = require("node:http");
const zlib = require("node:zlib");
const { Readable } = require("node:stream");
const domain = require("./model-domain.cjs");

const EGRESS_ERROR = Object.freeze({
  PROXY_UNREACHABLE: "PROXY_UNREACHABLE",
  PROXY_AUTH_REQUIRED: "PROXY_AUTH_REQUIRED",
  PROXY_TUNNEL_FAILED: "PROXY_TUNNEL_FAILED",
  PROXY_TIMEOUT: "PROXY_TIMEOUT",
  PROXY_CONFIG_INVALID: "PROXY_CONFIG_INVALID",
  PROXY_NOT_SUPPORTED: "PROXY_NOT_SUPPORTED",
  CANCELLED: "CANCELLED",
});

/** 结构化出网错误：code 进 errorCode，detail 不含凭据（最多 200 字）。 */
class EgressError extends Error {
  constructor(code, detail = null) {
    super(code + (detail ? ": " + String(detail).slice(0, 200) : ""));
    this.name = "EgressError";
    this.errorCode = code;
    if (detail != null) this.detail = String(detail).slice(0, 200);
  }
}

function abortError(reason) {
  const code = reason && reason.errorCode ? reason.errorCode : EGRESS_ERROR.CANCELLED;
  const message = reason && (reason.detail || reason.message) ? String(reason.detail || reason.message) : "proxy-aborted";
  const error = new EgressError(code, message);
  if (code === EGRESS_ERROR.CANCELLED) error.name = "AbortError";
  return error;
}

function isAbortSignal(value) {
  return !!value && typeof value === "object" && typeof value.aborted === "boolean" && typeof value.addEventListener === "function";
}

/** 请求头归一：Headers 实例 / [[k,v]] / 普通对象都支持；名字转小写，多值合并。 */
function normalizeRequestHeaders(raw) {
  const out = {};
  const put = (name, value) => {
    if (name == null || value == null) return;
    const key = String(name).trim().toLowerCase();
    if (!key) return;
    out[key] = Array.isArray(value) ? value.map(String).join(", ") : String(value);
  };
  if (!raw) return out;
  if (typeof raw.forEach === "function" && typeof raw.get === "function" && !Array.isArray(raw)) {
    raw.forEach((value, name) => put(name, value));
    return out;
  }
  if (Array.isArray(raw)) {
    for (const pair of raw) if (Array.isArray(pair) && pair.length >= 2) put(pair[0], pair[1]);
    return out;
  }
  if (typeof raw === "object") for (const [key, value] of Object.entries(raw)) put(key, value);
  return out;
}

/**
 * 请求体 → Buffer（+ 序列化产生的 content-type）。
 * 字符串 / Buffer / TypedArray / ArrayBuffer / URLSearchParams 直接处理；FormData / Blob / 流
 * 交给 undici 的 Request 只做**本地序列化**（不发网），拿到字节与 multipart boundary。
 */
async function serializeBody(body, method, headers) {
  if (body === undefined || body === null) return { bytes: null, contentType: null };
  if (method === "GET" || method === "HEAD") return { bytes: null, contentType: null };
  if (typeof body === "string") return { bytes: Buffer.from(body, "utf8"), contentType: null };
  if (Buffer.isBuffer(body)) return { bytes: body, contentType: null };
  if (body instanceof Uint8Array) return { bytes: Buffer.from(body), contentType: null };
  if (body instanceof ArrayBuffer) return { bytes: Buffer.from(new Uint8Array(body)), contentType: null };
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    return { bytes: Buffer.from(body.toString(), "utf8"), contentType: "application/x-www-form-urlencoded;charset=UTF-8" };
  }
  if (typeof Request === "function") {
    try {
      const probe = new Request("http://egress.local/", { method: method || "POST", body, duplex: "half" });
      const bytes = Buffer.from(await probe.arrayBuffer());
      return { bytes, contentType: probe.headers.get("content-type") || null };
    } catch { /* 交给下面的 toString 兜底 */ }
  }
  if (typeof body.toString === "function") return { bytes: Buffer.from(String(body), "utf8"), contentType: null };
  return { bytes: null, contentType: null };
}

/** TCP 连接代理；ECONNREFUSED / ENOTFOUND 等一律结构化 PROXY_UNREACHABLE。 */
function connectProxySocket({ config, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.connect({ host: config.hostname, port: config.port });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      if (error) { try { socket.destroy(); } catch { /* ignore */ } reject(error); }
      else resolve(socket);
    };
    const onConnect = () => finish(null);
    const onError = (error) => finish(new EgressError(EGRESS_ERROR.PROXY_UNREACHABLE, (error && (error.code || error.message)) || "connect-failed"));
    const onAbort = () => finish(abortError(signal && signal.reason));
    const timer = setTimeout(() => finish(new EgressError(EGRESS_ERROR.PROXY_TIMEOUT, "proxy-connect-timeout")), timeoutMs);
    socket.once("connect", onConnect);
    socket.once("error", onError);
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** 在已有 TCP 连接上完成 CONNECT 握手；返回隧道上残留的字节（通常为空）。 */
function establishTunnel({ socket, targetHost, targetPort, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error, rest) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      if (error) { try { socket.destroy(); } catch { /* ignore */ } reject(error); }
      else resolve(rest || Buffer.alloc(0));
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffer.length > 65536) finish(new EgressError(EGRESS_ERROR.PROXY_TUNNEL_FAILED, "proxy-response-too-large"));
        return;
      }
      const head = buffer.slice(0, end).toString("latin1");
      const rest = buffer.slice(end + 4);
      const match = /^HTTP\/\d\.\d\s+(\d{3})/.exec(head.split("\r\n")[0] || "");
      const status = match ? Number(match[1]) : 0;
      if (status === 407) { finish(new EgressError(EGRESS_ERROR.PROXY_AUTH_REQUIRED, "proxy-requires-authentication")); return; }
      if (status !== 200) { finish(new EgressError(EGRESS_ERROR.PROXY_TUNNEL_FAILED, "proxy-connect-status-" + status)); return; }
      finish(null, rest);
    };
    const onError = (error) => finish(new EgressError(EGRESS_ERROR.PROXY_UNREACHABLE, (error && (error.code || error.message)) || "proxy-connect-error"));
    const onClose = () => finish(new EgressError(EGRESS_ERROR.PROXY_TUNNEL_FAILED, "proxy-closed-before-connect-established"));
    const onAbort = () => finish(abortError(signal && signal.reason));
    const timer = setTimeout(() => finish(new EgressError(EGRESS_ERROR.PROXY_TIMEOUT, "proxy-connect-handshake-timeout")), timeoutMs);
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    socket.write("CONNECT " + targetHost + ":" + targetPort + " HTTP/1.1\r\nHost: " + targetHost + ":" + targetPort + "\r\nProxy-Connection: keep-alive\r\n\r\n");
  });
}

/** 隧道内 TLS 升级（servername = 目标主机；tlsOptions 仅供单测注入受信 CA）。 */
function upgradeTls({ socket, servername, tlsOptions, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let tlsSocket = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (tlsSocket) { tlsSocket.removeListener("secureConnect", onSecure); tlsSocket.removeListener("error", onError); }
      if (error) { try { (tlsSocket || socket).destroy(); } catch { /* ignore */ } reject(error); }
      else resolve(tlsSocket);
    };
    const onSecure = () => finish(null);
    const onError = (error) => finish(new EgressError(EGRESS_ERROR.PROXY_TUNNEL_FAILED, "tls:" + ((error && (error.code || error.message)) || "handshake-failed")));
    const onAbort = () => finish(abortError(signal && signal.reason));
    const timer = setTimeout(() => finish(new EgressError(EGRESS_ERROR.PROXY_TIMEOUT, "proxy-tls-handshake-timeout")), timeoutMs);
    try { tlsSocket = tls.connect({ socket, servername, ...(tlsOptions || {}) }); }
    catch (error) { finish(new EgressError(EGRESS_ERROR.PROXY_TUNNEL_FAILED, "tls-connect:" + ((error && error.message) || error))); return; }
    tlsSocket.once("secureConnect", onSecure);
    tlsSocket.once("error", onError);
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** 响应体：按 content-encoding 透明解压（gzip/deflate/br），与 fetch 语义对齐。 */
function nodeResponseBody(res) {
  const encoding = String((res.headers && res.headers["content-encoding"]) || "").toLowerCase().trim();
  const decompressed = encoding === "gzip" || encoding === "x-gzip" || encoding === "deflate" || encoding === "br";
  let stream = res;
  if (encoding === "gzip" || encoding === "x-gzip") stream = res.pipe(zlib.createGunzip());
  else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());
  else if (encoding === "br") stream = res.pipe(zlib.createBrotliDecompress());
  return { body: Readable.toWeb(stream), decompressed };
}

const NULL_BODY_STATUS = new Set([204, 205, 304]);

/** 把 http.IncomingMessage 变成完整 Response-like（ok/status/headers.get/text/json/arrayBuffer/body…）。 */
function toResponse(res, method) {
  const { body: rawBody, decompressed } = nodeResponseBody(res);
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers || {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, String(item));
    else headers.set(name, String(value));
  }
  if (decompressed) { headers.delete("content-encoding"); headers.delete("content-length"); }
  const nullBody = NULL_BODY_STATUS.has(Number(res.statusCode)) || method === "HEAD";
  return new Response(nullBody ? null : rawBody, {
    status: Number(res.statusCode),
    statusText: res.statusMessage || "",
    headers,
  });
}

/** 目标 URL 归一（string / URL / Request-like）。 */
function targetUrlOf(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object" && typeof input.url === "string") return input.url;
  return null;
}

function hostHeaderFor(url) {
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  return url.port && url.port !== defaultPort ? url.hostname + ":" + url.port : url.hostname;
}

function createEgressFetch({ getConfig = null, baseFetch = null, connectTimeoutMs = 15000, requestTimeoutMs = 0, tlsOptions = null, logger = null } = {}) {
  const readConfig = typeof getConfig === "function" ? getConfig : () => ({ enabled: false, url: null });
  const direct = typeof baseFetch === "function" ? baseFetch : (typeof fetch === "function" ? fetch.bind(globalThis) : null);

  const log = (event, extra) => { try { if (logger && typeof logger.log === "function") logger.log({ scope: "net-egress", event, ...(extra || {}), at: Date.now() }); } catch { /* 日志失败不改业务 */ } };
  // 最近一次"代理侧"结构化错误：出口适配器会把网络失败归一成 provider 错误码，
  // 这里保留原始出网码，供 ModelService 在命令结果里附带（只含码与短 detail，无凭据）。
  let lastError = null;

  async function egressFetch(input, init = {}) {
    let rawConfig = null;
    try { rawConfig = readConfig(); } catch { throw new EgressError(EGRESS_ERROR.PROXY_CONFIG_INVALID, "config-read-failed"); }
    const normalized = domain.normalizeProxyConfig(rawConfig && typeof rawConfig === "object" ? rawConfig : {});
    if (!normalized.ok) throw new EgressError(EGRESS_ERROR.PROXY_CONFIG_INVALID, normalized.reason || normalized.error);
    // 关闭代理：逐字走原路径（不复制、不改写、不包装返回值）。
    if (normalized.enabled !== true) {
      if (!direct) throw new EgressError(EGRESS_ERROR.PROXY_NOT_SUPPORTED, "no-base-fetch");
      return direct(input, init);
    }
    const proxy = domain.validateProxyUrl(normalized.url);
    if (!proxy.ok) throw new EgressError(EGRESS_ERROR.PROXY_CONFIG_INVALID, proxy.reason || proxy.error);
    const urlString = targetUrlOf(input);
    if (!urlString) throw new EgressError(EGRESS_ERROR.PROXY_NOT_SUPPORTED, "unsupported-request-input");
    let target;
    try { target = new URL(urlString); } catch { throw new EgressError(EGRESS_ERROR.PROXY_CONFIG_INVALID, "target-url-invalid"); }
    if (target.protocol !== "https:" && target.protocol !== "http:") throw new EgressError(EGRESS_ERROR.PROXY_NOT_SUPPORTED, "target-protocol:" + target.protocol);

    const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
    const headers = normalizeRequestHeaders(init && init.headers !== undefined ? init.headers : (input && typeof input === "object" ? input.headers : null));
    const requestBody = init && "body" in init ? init.body : (input && typeof input === "object" ? input.body : undefined);
    const serialized = await serializeBody(requestBody, method, headers);
    if (serialized.contentType && !headers["content-type"]) headers["content-type"] = serialized.contentType;
    headers.host = hostHeaderFor(target);

    const outerSignal = isAbortSignal(init && init.signal) ? init.signal : null;
    const controller = new AbortController();
    let timer = null;
    const onOuterAbort = () => controller.abort(outerSignal && outerSignal.reason);
    if (outerSignal) {
      if (outerSignal.aborted) controller.abort(outerSignal.reason);
      else outerSignal.addEventListener("abort", onOuterAbort, { once: true });
    }
    if (Number(requestTimeoutMs) > 0) timer = setTimeout(() => controller.abort(new EgressError(EGRESS_ERROR.PROXY_TIMEOUT, "egress-request-timeout")), Number(requestTimeoutMs));

    let proxySocket = null;
    let tunnelSocket = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener("abort", onOuterAbort);
    };
    try {
      if (target.protocol === "https:") {
        proxySocket = await connectProxySocket({ config: proxy, timeoutMs: Number(connectTimeoutMs) || 15000, signal: controller.signal });
        let tunnelBase = proxySocket;
        if (proxy.protocol === "https:") tunnelBase = await upgradeTls({ socket: proxySocket, servername: proxy.hostname, tlsOptions, timeoutMs: Number(connectTimeoutMs) || 15000, signal: controller.signal });
        const rest = await establishTunnel({ socket: tunnelBase, targetHost: target.hostname, targetPort: target.port || "443", timeoutMs: Number(connectTimeoutMs) || 15000, signal: controller.signal });
        if (rest.length) { try { tunnelBase.unshift(rest); } catch { /* 隧道起始无目标数据属正常 */ } }
        tunnelSocket = await upgradeTls({ socket: tunnelBase, servername: target.hostname, tlsOptions, timeoutMs: Number(connectTimeoutMs) || 15000, signal: controller.signal });
        const response = await new Promise((resolve, reject) => {
          // 无 agent 时 Node 使用 per-request createConnection（_http_client.js:217/418）。
          const req = http.request({ createConnection: () => tunnelSocket, host: target.hostname, port: target.port || "443", method, path: (target.pathname || "/") + (target.search || ""), headers, signal: controller.signal });
          req.on("response", resolve);
          req.on("error", (error) => {
            if (controller.signal.aborted) reject(abortError(controller.signal.reason));
            else if (error && error.code === "ENOTFOUND") reject(new EgressError(EGRESS_ERROR.PROXY_UNREACHABLE, "target-dns"));
            else reject(new EgressError(EGRESS_ERROR.PROXY_TUNNEL_FAILED, (error && (error.code || error.message)) || "request-failed"));
          });
          if (serialized.bytes && serialized.bytes.length) req.write(serialized.bytes);
          req.end();
        });
        log("proxied-https", { host: target.hostname, status: response.statusCode });
        return toResponse(response, method);
      }
      // http 目标：向代理发 absolute-form 请求（仅回环 / 本地测试）。
      const response = await new Promise((resolve, reject) => {
        const req = http.request({
          host: proxy.hostname, port: proxy.port, method,
          path: target.href,
          headers: { ...headers, host: hostHeaderFor(target) },
          signal: controller.signal,
        });
        req.on("response", resolve);
        req.on("error", (error) => {
          if (controller.signal.aborted) reject(abortError(controller.signal.reason));
          else reject(new EgressError(EGRESS_ERROR.PROXY_UNREACHABLE, (error && (error.code || error.message)) || "proxy-request-failed"));
        });
        if (serialized.bytes && serialized.bytes.length) req.write(serialized.bytes);
        req.end();
      });
      log("proxied-http", { host: target.hostname, status: response.statusCode });
      return toResponse(response, method);
    } catch (error) {
      const normalized = error && error.errorCode
        ? error
        : controller.signal.aborted
          ? abortError(controller.signal.reason)
          : new EgressError(EGRESS_ERROR.PROXY_TUNNEL_FAILED, (error && (error.code || error.message)) || "egress-failed");
      lastError = { code: normalized.errorCode, detail: normalized.detail || null, at: Date.now() };
      throw normalized;
    } finally {
      cleanup();
      if (controller.signal.aborted) {
        try { if (tunnelSocket) tunnelSocket.destroy(); } catch { /* ignore */ }
        try { if (proxySocket && proxySocket !== tunnelSocket) proxySocket.destroy(); } catch { /* ignore */ }
      }
    }
  }

  /** 只读诊断：当前是否启用、代理地址（不含任何凭据）。 */
  egressFetch.describe = () => {
    try {
      const normalized = domain.normalizeProxyConfig(readConfig() || {});
      return normalized.ok ? { enabled: normalized.enabled === true, url: normalized.url || null } : { enabled: false, url: null, configError: normalized.reason || normalized.error };
    } catch { return { enabled: false, url: null, configError: "config-read-failed" }; }
  };
  /** 最近一次代理侧错误（默认 2 分钟内有效）；没有或已过期返回 null。 */
  egressFetch.recentError = (withinMs = 120000) => (lastError && Date.now() - lastError.at <= Math.max(0, Number(withinMs) || 0) ? { ...lastError } : null);
  return egressFetch;
}

module.exports = { EGRESS_ERROR, EgressError, createEgressFetch, normalizeRequestHeaders, serializeBody, toResponse, hostHeaderFor };
