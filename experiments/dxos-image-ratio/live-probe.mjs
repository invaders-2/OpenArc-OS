#!/usr/bin/env node
/**
 * dxos-image-ratio · 真机探针：请求什么尺寸，就测量返回图的真实像素。
 *
 * 只读事实：
 *   · 对同一网关 POST /v1/images/generations，逐尺寸记录 请求体 size / 响应字段 /
 *     字节数 / content-type / 魔数格式 / 真实宽高。
 *   · 判定"请求什么就得到什么"还是"被上游改写"。
 *   · token 只从 /tmp/oa-relay.token 在运行时读取，绝不打印；输出用 sha256 前 12 位代替。
 *   · 429/5xx 有限退避重试，每次尝试如实入账，不掩盖限流。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UPSTREAM, DEFAULT_TOKEN_FILE, loadToken, tokenDigest, scrubText } from "../dxos-relay-image/relay.mjs";
import { measureImage, parseSize } from "./measure.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-image-ratio");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 404 也重试：该网关的图像路由按账号可用性在 404("Images API is not supported") 与 200 之间抖动
// （2026-10-16 22:58 实测同一 gemini-3.1-flash-image 一次 404、一次 200）。每次尝试都入账。
const RETRY_STATUSES = new Set([404, 429, 502, 503, 504]);

const DEFAULT_MODELS = ["gemini-3.1-flash-image"];
const DEFAULT_SIZES = ["1024x1024", "1536x1024", "1024x1536"];

async function once(url, { method = "GET", token, body = null, timeoutMs = 180000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: { authorization: "Bearer " + token, ...(body ? { "content-type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      redirect: "error",
    });
    const contentType = res.headers.get("content-type") || "";
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, ms: Date.now() - t0, contentType, buf };
  } catch (err) {
    return { status: 0, ms: Date.now() - t0, error: String((err && err.message) || err).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/** 有限退避；每次尝试都进 attempts。 */
async function withBackoff(fn, { retries = 2, delays = [4000, 12000] } = {}) {
  const attempts = [];
  for (let i = 0; i <= retries; i += 1) {
    const r = await fn();
    attempts.push({ attempt: i + 1, status: r.status, ms: r.ms, error: r.error || null });
    const retryable = r.status === 0 || RETRY_STATUSES.has(r.status);
    if (!retryable || i === retries) return { ...r, attempts };
    await sleep(delays[Math.min(i, delays.length - 1)]);
  }
  return { status: 0, attempts };
}

function jsonOf(buf) { try { return JSON.parse(buf.toString("utf8")); } catch { return null; } }

/** 从 OpenAI 兼容响应里取出第一张图的实际字节（base64 或 url 两种形态都支持）。 */
async function firstImageBytes(json, token, log) {
  const item = json && Array.isArray(json.data) ? json.data[0] : null;
  if (!item || typeof item !== "object") return { source: null, reason: "no data[0]" };
  if (typeof item.b64_json === "string" && item.b64_json) {
    return { source: "b64_json", bytes: Buffer.from(item.b64_json, "base64"), declaredMime: item.mime_type || item.mimeType || null, revisedPrompt: item.revised_prompt || null };
  }
  if (typeof item.url === "string" && item.url) {
    const fetched = await once(item.url, { method: "GET", token, timeoutMs: 120000 });
    if (fetched.status !== 200 || !fetched.buf) return { source: "url", reason: "url fetch status=" + fetched.status, url: item.url.slice(0, 120) };
    return { source: "url", bytes: fetched.buf, declaredMime: fetched.contentType || null, url: item.url.slice(0, 120) };
  }
  log("data[0] keys=" + Object.keys(item).join(","));
  return { source: null, reason: "data[0] has neither b64_json nor url" };
}

export async function runProbe({ token, upstream = UPSTREAM, models = DEFAULT_MODELS, sizes = DEFAULT_SIZES, prompt = "a red apple on a white table", log = () => {} } = {}) {
  if (!token) throw new Error("runProbe 需要 token");
  const base = upstream.replace(/\/+$/, "");
  const out = { upstream: base, tokenDigest: await tokenDigest(token), at: new Date().toISOString(), prompt, models: [], rows: [] };
  for (const model of models) {
    log("model=" + model);
    for (const size of sizes) {
      const requested = parseSize(size);
      const call = await withBackoff(() => once(base + "/v1/images/generations", {
        method: "POST", token, timeoutMs: 180000,
        body: { model, prompt, n: 1, size },
      }), { retries: 5, delays: [4000, 8000, 12000, 20000, 30000] });
      const row = {
        model, requestedSize: size, status: call.status, ms: call.ms, attempts: call.attempts.length,
        responseContentType: call.contentType || null,
        responseError: null, imageField: null, declaredMime: null,
        bytes: call.buf ? call.buf.length : 0, actual: null, match: null, rawBytesHash12: null,
      };
      if (call.status !== 200) {
        const j = call.buf ? jsonOf(call.buf) : null;
        row.responseError = j ? String((j.error && (j.error.message || j.error.code)) || JSON.stringify(j).slice(0, 200)).slice(0, 300) : (call.error || "http " + call.status);
        out.rows.push(row);
        log("  size=" + size + " -> status=" + call.status + " err=" + row.responseError);
        continue;
      }
      const json = jsonOf(call.buf);
      if (!json) { row.responseError = "non-JSON 200"; out.rows.push(row); continue; }
      row.usage = json.usage || null;
      const img = await firstImageBytes(json, token, log);
      row.imageField = img.source;
      if (!img.bytes) { row.responseError = img.reason || "no image bytes"; out.rows.push(row); continue; }
      const m = measureImage(img.bytes);
      row.declaredMime = img.declaredMime || null;
      row.bytes = m.bytes;
      row.actual = { mime: m.mime, width: m.width, height: m.height, magic: m.magic };
      row.rawBytesHash12 = (await import("node:crypto")).createHash("sha256").update(img.bytes).digest("hex").slice(0, 12);
      row.match = !!(requested && m.width === requested.width && m.height === requested.height);
      row.sha256_12 = row.rawBytesHash12;
      // 落盘原始字节（基名只含模型与尺寸，安全字符）
      const safe = (model + "_" + size).replace(/[^A-Za-z0-9._-]/g, "_");
      fs.mkdirSync(ART, { recursive: true });
      fs.writeFileSync(path.join(ART, safe + ".bin"), img.bytes);
      out.rows.push(row);
      log("  size=" + size + " -> status=200 field=" + img.source + " mime=" + m.mime + " actual=" + m.width + "x" + m.height + " bytes=" + m.bytes + " match=" + row.match + " ms=" + call.ms);
    }
  }
  return out;
}

const IS_MAIN = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (IS_MAIN) {
  let token;
  try { token = loadToken(process.env.OA_RELAY_TOKEN_FILE || DEFAULT_TOKEN_FILE); }
  catch (err) { console.error("TOKEN_UNAVAILABLE: " + String(err && err.message)); process.exit(3); }
  const models = (process.env.OA_IMAGE_MODELS || DEFAULT_MODELS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const sizes = (process.env.OA_IMAGE_SIZES || DEFAULT_SIZES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  fs.mkdirSync(ART, { recursive: true });
  runProbe({ token, models, sizes, log: (m) => console.log("  · " + scrubText(m, [token])) })
    .then((out) => {
      fs.writeFileSync(path.join(ART, "live-probe.json"), JSON.stringify(out, null, 2));
      const { tokenDigest: d, ...safe } = out;
      console.log(JSON.stringify({ ...safe, tokenDigest: d }, null, 2));
      process.exit(0);
    })
    .catch((err) => { console.error("PROBE FAILED " + scrubText(err && err.stack, [token])); process.exit(2); });
}

export { once, withBackoff, firstImageBytes };
