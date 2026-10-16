#!/usr/bin/env node
/** 网关可用性体检：不同模型组 + 图像端点。 */
import fs from "node:fs";
const token = fs.readFileSync("/tmp/oa-relay.token", "utf8").trim();
const base = "http://43.130.6.197:8080";
async function post(path, body, timeoutMs) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(new Error("timeout")), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(base + path, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body), signal: c.signal, redirect: "error" });
    const txt = await r.text();
    return { path, status: r.status, ms: Date.now() - t0, bytes: txt.length, head: txt.slice(0, 220) };
  } catch (e) { return { path, status: 0, ms: Date.now() - t0, err: String(e.message || e).slice(0, 160) }; }
  finally { clearTimeout(t); }
}
const model = process.env.OA_GC_MODEL || "gemini-3-flash";
console.log(JSON.stringify(await post("/v1/chat/completions", { model, messages: [{ role: "user", content: "只回复：ok" }], stream: false }, 120000)));
const model2 = process.env.OA_GC_MODEL2 || "gpt-5.6";
console.log(JSON.stringify(await post("/v1/chat/completions", { model: model2, messages: [{ role: "user", content: "只回复：ok" }], stream: false }, 120000)));
const model3 = process.env.OA_GC_MODEL3 || "claude-opus-4-6-thinking";
console.log(JSON.stringify(await post("/v1/chat/completions", { model: model3, messages: [{ role: "user", content: "只回复：ok" }], stream: false }, 120000)));
console.log(JSON.stringify(await post("/v1/images/generations", { model: "gemini-3.1-flash-image", prompt: "a red apple on a white table", n: 1, size: "1024x1024" }, 240000)));
