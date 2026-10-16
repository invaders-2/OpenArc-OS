#!/usr/bin/env node
/** 网关图像模型发现：哪些模型真的支持 POST /v1/images/generations。 */
import { UPSTREAM, loadToken } from "../dxos-relay-image/relay.mjs";

const MODELS = (process.env.OA_IMAGE_MODELS || [
  "gpt-image-1.5","gpt-image-2","gpt-image-2.5-flare","gpt-image-2.5-sunburst",
  "gemini-2.5-flash-image","gemini-2.5-flash-image-preview","gemini-3.1-flash-image-preview",
  "gemini-3-pro-image","grok-imagine-image","grok-imagine-image-quality","grok-imagine-image-2.0",
].join(",")).split(",").map((s) => s.trim()).filter(Boolean);

const base = UPSTREAM.replace(/\/+$/, "");
const token = loadToken();
const rows = [];
for (const model of MODELS) {
  const t0 = Date.now();
  let status = 0, ct = "", len = 0, msg = "";
  try {
    const r = await fetch(base + "/v1/images/generations", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: "a red apple", n: 1, size: "1024x1024" }),
      redirect: "error",
      signal: AbortSignal.timeout(120000),
    });
    status = r.status; ct = r.headers.get("content-type") || "";
    const b = Buffer.from(await r.arrayBuffer()); len = b.length;
    let j = null; try { j = JSON.parse(b.toString("utf8")); } catch { /* ignore */ }
    msg = j ? String((j.error && (j.error.message || j.error.code)) || (j.data ? "data:" + Object.keys(j.data[0] || {}).join(",") : "keys:" + Object.keys(j).join(","))) : b.toString("utf8", 0, 120);
  } catch (e) { msg = String((e && e.message) || e).slice(0, 150); }
  const row = { model, status, ms: Date.now() - t0, ct, len, msg: msg.slice(0, 160) };
  rows.push(row);
  console.log(JSON.stringify(row));
}
