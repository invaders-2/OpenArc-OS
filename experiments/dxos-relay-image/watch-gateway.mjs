#!/usr/bin/env node
/**
 * 网关恢复观察（后台）：每 45s 探测 chat；恢复（200）后额外探测 images 端点。
 * 追加 JSONL 到 artifacts/dxos-relay-image/gateway-availability.jsonl。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-relay-image");
fs.mkdirSync(ART, { recursive: true });
const LOG = path.join(ART, "gateway-availability.jsonl");
const token = fs.readFileSync("/tmp/oa-relay.token", "utf8").trim();
const base = "http://43.130.6.197:8080";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p, body, timeoutMs) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(new Error("timeout")), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(base + p, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body), signal: c.signal, redirect: "error" });
    const txt = await r.text();
    return { status: r.status, ms: Date.now() - t0, bytes: txt.length, head: txt.slice(0, 160) };
  } catch (e) { return { status: 0, ms: Date.now() - t0, err: String(e.message || e).slice(0, 120) }; }
  finally { clearTimeout(t); }
}
const iterations = Number(process.env.OA_WATCH_ITERS || 24);
const gap = Number(process.env.OA_WATCH_GAP || 45000);
for (let i = 1; i <= iterations; i += 1) {
  const chat = await post("/v1/chat/completions", { model: "gemini-3-flash", messages: [{ role: "user", content: "只回复：ok" }], stream: false }, 60000);
  const rec = { i, at: new Date().toISOString(), chat };
  if (chat.status === 200) {
    const img = await post("/v1/images/generations", { model: "gemini-3.1-flash-image", prompt: "a red apple on a white table", n: 1, size: "1024x1024" }, 240000);
    rec.images = img;
  }
  fs.appendFileSync(LOG, JSON.stringify(rec) + "\n");
  console.log(JSON.stringify(rec));
  if (chat.status === 200) process.exit(0);
  if (i < iterations) await sleep(gap);
}
console.log("WATCH_ENDED_NO_RECOVERY");
process.exit(1);
