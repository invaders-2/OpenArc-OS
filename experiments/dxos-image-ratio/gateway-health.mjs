#!/usr/bin/env node
/** 网关健康与 Grok 图像模型重试（503 是否瞬时）。 */
import { UPSTREAM, loadToken, tokenDigest } from "../dxos-relay-image/relay.mjs";
const base = UPSTREAM.replace(/\/+$/, "");
const token = loadToken();
const digest = await tokenDigest(token);
console.log("token sha256_12 =", digest.sha256_12, "bytes =", digest.bytes);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const t0 = Date.now();
const mr = await fetch(base + "/v1/models", { headers: { authorization: "Bearer " + token }, redirect: "error", signal: AbortSignal.timeout(30000) });
console.log("/v1/models status", mr.status, "ms", Date.now() - t0);

for (let i = 0; i < 3; i += 1) {
  for (const model of ["grok-imagine-image", "grok-imagine-image-2.0", "grok-imagine-image-quality"]) {
    const t = Date.now();
    try {
      const r = await fetch(base + "/v1/images/generations", {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: "a red apple on a white table", n: 1, size: "1024x1024" }),
        redirect: "error", signal: AbortSignal.timeout(120000),
      });
      const b = Buffer.from(await r.arrayBuffer());
      let j = null; try { j = JSON.parse(b.toString("utf8")); } catch {}
      const msg = j ? ((j.error && (j.error.message || j.error.code)) || (j.data ? "data:" + Object.keys(j.data[0] || {}).join(",") : "keys:" + Object.keys(j).join(","))) : b.toString("utf8", 0, 80);
      console.log(JSON.stringify({ attempt: i + 1, model, status: r.status, ms: Date.now() - t, len: b.length, msg: String(msg).slice(0, 140) }));
    } catch (e) { console.log(JSON.stringify({ attempt: i + 1, model, status: 0, ms: Date.now() - t, msg: String((e && e.message) || e).slice(0, 140) })); }
  }
  if (i < 2) await sleep(8000);
}
