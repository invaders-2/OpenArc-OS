#!/usr/bin/env node
/**
 * dxos-relay-image · 上游站点探针（直连网关，带 429 退避重试）。
 *
 * 只读事实：模型清单、chat 往返、图像模型走 chat 端点时的限流表现。
 * 真实出图交给应用内的 image/generate（见 run-all.mjs），这里不重复调用。
 * 429/5xx 一律如实记录，重试只为越过瞬时限流，不掩盖问题。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UPSTREAM, DEFAULT_TOKEN_FILE, loadToken, tokenDigest, scrubText } from "./relay.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-relay-image");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RETRY_STATUSES = new Set([429, 502, 503, 504]);

async function once(url, { method = "GET", token, body = null, timeoutMs = 180000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: {
        authorization: "Bearer " + token,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      redirect: "error",
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, ms: Date.now() - t0, json, textLength: text.length };
  } catch (err) {
    return { status: 0, ms: Date.now() - t0, error: String((err && err.message) || err).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/** 有限次数的退避重试；每次尝试都进 attempts 数组。 */
async function withBackoff(label, fn, { retries = 3, delays = [3000, 8000, 20000] } = {}) {
  const attempts = [];
  for (let i = 0; i <= retries; i += 1) {
    const r = await fn();
    attempts.push({ attempt: i + 1, status: r.status, ms: r.ms, error: r.error || null, retryAfterMs: r.retryAfterMs || null });
    const retryable = r.status === 0 || RETRY_STATUSES.has(r.status);
    if (!retryable || i === retries) return { ...r, label, attempts };
    await sleep(delays[Math.min(i, delays.length - 1)]);
  }
  return { label, status: 0, attempts };
}

export async function runProbe({ token, upstream = UPSTREAM, log = () => {} } = {}) {
  if (!token) throw new Error("runProbe 需要 token");
  const base = upstream.replace(/\/+$/, "");
  const out = { upstream: base, tokenDigest: await tokenDigest(token), at: new Date().toISOString(), steps: {} };

  // 1. GET /v1/models
  const models = await withBackoff("models", () => once(base + "/v1/models", { token }), { retries: 2, delays: [2000, 5000] });
  const ids = models.json && Array.isArray(models.json.data) ? models.json.data.map((m) => String(m && m.id)).filter(Boolean) : [];
  out.steps.models = { status: models.status, ms: models.ms, attempts: models.attempts, count: ids.length, ids };
  log("models status=" + models.status + " count=" + ids.length + " ms=" + models.ms);

  // 2. chat 往返（文本模型）
  const chat = await withBackoff("chat", () => once(base + "/v1/chat/completions", {
    method: "POST", token, timeoutMs: 120000,
    body: { model: "gemini-3-flash", messages: [{ role: "user", content: "只回复：ok" }], stream: false },
  }), { retries: 2, delays: [3000, 8000] });
  const chatText = chat.json && chat.json.choices && chat.json.choices[0] && chat.json.choices[0].message ? chat.json.choices[0].message.content : null;
  out.steps.chat = { model: "gemini-3-flash", status: chat.status, ms: chat.ms, attempts: chat.attempts, text: typeof chatText === "string" ? chatText.slice(0, 200) : null };
  log("chat status=" + chat.status + " ms=" + chat.ms + " text=" + JSON.stringify(out.steps.chat.text));

  // 3. 图像模型走 chat 端点：历史上出现过 429（Upstream rate limit exceeded）——如实记录重试次数
  const imageChat = await withBackoff("image-model-on-chat", () => once(base + "/v1/chat/completions", {
    method: "POST", token, timeoutMs: 120000,
    body: { model: "gemini-3.1-flash-image", messages: [{ role: "user", content: "只回复：ok" }], stream: false },
  }), { retries: 3, delays: [3000, 8000, 20000] });
  const imageChatText = imageChat.json && imageChat.json.choices && imageChat.json.choices[0] && imageChat.json.choices[0].message ? imageChat.json.choices[0].message.content : null;
  out.steps.imageModelOnChat = {
    model: "gemini-3.1-flash-image",
    status: imageChat.status,
    ms: imageChat.ms,
    attempts: imageChat.attempts,
    saw429: imageChat.attempts.some((a) => a.status === 429),
    retryCount: Math.max(0, imageChat.attempts.length - 1),
    errorText: imageChat.json && (imageChat.json.error && (imageChat.json.error.message || imageChat.json.error.code)) ? String(imageChat.json.error.message || imageChat.json.error.code).slice(0, 300) : null,
    text: typeof imageChatText === "string" ? imageChatText.slice(0, 200) : null,
  };
  log("image-model-on-chat status=" + imageChat.status + " attempts=" + imageChat.attempts.length + " saw429=" + out.steps.imageModelOnChat.saw429);

  return out;
}

const IS_MAIN = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (IS_MAIN) {
  const token = loadToken(process.env.OA_RELAY_TOKEN_FILE || DEFAULT_TOKEN_FILE);
  fs.mkdirSync(ART, { recursive: true });
  runProbe({ token, log: (m) => console.log("  · " + scrubText(m, [token])) })
    .then((out) => {
      fs.writeFileSync(path.join(ART, "probe.json"), JSON.stringify(out, null, 2));
      const { tokenDigest: _d, ...safe } = out;
      console.log(JSON.stringify({ ...safe, tokenDigest: out.tokenDigest }, null, 2));
      process.exit(0);
    })
    .catch((err) => { console.error("PROBE FAILED " + scrubText(err && err.stack, [loadToken()])); process.exit(2); });
}

export { once, withBackoff };
