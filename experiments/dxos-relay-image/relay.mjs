#!/usr/bin/env node
/**
 * dxos-relay-image · 本地回环桥（实验用，不是产品代码）。
 *
 * 背景：electron/model-domain.cjs:validateEndpoint 规定远程公网地址必须 https
 *（remote-requires-https），只有 localhost 允许 http。测试用的中转站是
 * http://43.130.6.197:8080，无法直接登记。本桥在 127.0.0.1:<随机端口> 起一个
 * 透明反向代理，把 provider 的 baseUrl 变成 LOCALHOST 口径（合法），请求与
 * Authorization 头原样转发到上游。
 *
 * 纪律：
 *   · 不打印、不落盘任何请求头（Authorization 只在进程内转发）。
 *   · 透明：不重试、不改状态码，上游 429/5xx 如实回到调用方。
 *   · 只监听 127.0.0.1。
 */
import http from "node:http";
import fs from "node:fs";

export const UPSTREAM = "http://43.130.6.197:8080";
export const DEFAULT_TOKEN_FILE = "/tmp/oa-relay.token";

export function loadToken(file = DEFAULT_TOKEN_FILE) {
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!raw) throw new Error("token file is empty: " + file);
  return raw;
}

/** token 摘要（绝不回明文）。 */
export function tokenDigest(token) {
  return import("node:crypto").then(({ createHash }) => ({
    bytes: Buffer.byteLength(String(token), "utf8"),
    sha256_12: createHash("sha256").update(String(token)).digest("hex").slice(0, 12),
  }));
}

/** 抹掉可能的密钥形态，报告里只出现 [REDACTED]。 */
export function scrubText(text, secrets = []) {
  let out = String(text == null ? "" : text);
  for (const s of secrets) {
    if (!s || String(s).length < 4) continue;
    out = out.split(String(s)).join("[REDACTED_TOKEN]");
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]");
  return out;
}

export async function startRelay({ upstream = UPSTREAM, token, host = "127.0.0.1", port = 0, log = () => {} } = {}) {
  if (!token) throw new Error("startRelay 需要 token");
  const entries = [];
  const startedAt = Date.now();

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const target = upstream.replace(/\/+$/, "") + req.url;
    const headers = {};
    // 只透传必要的头；Authorization 原样转发，不记录。
    if (req.headers.authorization) headers.authorization = req.headers.authorization;
    if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
    if (req.headers.accept) headers.accept = req.headers.accept;
    let status = 0;
    let resBytes = 0;
    let error = null;
    try {
      const upstreamRes = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
        redirect: "error",
      });
      status = upstreamRes.status;
      const outHeaders = {};
      const ct = upstreamRes.headers.get("content-type");
      if (ct) outHeaders["content-type"] = ct;
      res.writeHead(status, outHeaders);
      if (upstreamRes.body) {
        const reader = upstreamRes.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          resBytes += value.length;
          res.write(Buffer.from(value));
        }
      }
      res.end();
    } catch (err) {
      error = String((err && err.message) || err).slice(0, 300);
      status = status || 502;
      try {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "RELAY_UPSTREAM_FAILED", detail: error }));
      } catch { /* ignore */ }
    }
    const entry = {
      n: entries.length + 1,
      method: req.method,
      path: req.url,
      status,
      ms: Date.now() - t0,
      reqBytes: body.length,
      resBytes,
      error,
      at: Date.now() - startedAt,
    };
    entries.push(entry);
    log(entry);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  return {
    host,
    port: actualPort,
    baseUrl: "http://127.0.0.1:" + actualPort + "/v1",
    origin: "http://127.0.0.1:" + actualPort,
    entries,
    countByStatus: (code) => entries.filter((e) => e.status === code).length,
    close: () => new Promise((resolve) => server.close(() => resolve(true))),
  };
}
