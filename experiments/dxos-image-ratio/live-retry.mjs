#!/usr/bin/env node
/** 针对 /v1/images/generations 的后台恢复重试：只在真的出图时停。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UPSTREAM, loadToken } from "../dxos-relay-image/relay.mjs";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-image-ratio");
fs.mkdirSync(ART, { recursive: true });
const LOG = path.join(ART, "live-retry.jsonl");
const token = loadToken();
const base = UPSTREAM.replace(/\/+$/, "");
const MODELS = ["grok-imagine-image", "gpt-image-1", "gemini-3.1-flash-image"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iters = Number(process.env.OA_IR_ITERS || 18);
const gap = Number(process.env.OA_IR_GAP || 30000);
for (let i = 1; i <= iters; i += 1) {
  for (const model of MODELS) {
    const t0 = Date.now();
    let rec = { i, at: new Date().toISOString(), model, status: 0, ms: 0, len: 0, msg: "" };
    try {
      const r = await fetch(base + "/v1/images/generations", {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: "a red apple on a white table", n: 1, size: "1024x1024" }),
        redirect: "error", signal: AbortSignal.timeout(120000),
      });
      const b = Buffer.from(await r.arrayBuffer());
      rec.status = r.status; rec.ms = Date.now() - t0; rec.len = b.length;
      let j = null; try { j = JSON.parse(b.toString("utf8")); } catch {}
      rec.msg = j ? String((j.error && (j.error.message || j.error.code)) || (j.data ? "IMAGE" : "keys:" + Object.keys(j).join(","))).slice(0, 140) : b.toString("utf8", 0, 80);
      if (r.status === 200) {
        const m = /"b64_json"\s*:\s*"([A-Za-z0-9+/=]+)"/.exec(b.toString("utf8"));
        if (m) fs.writeFileSync(path.join(ART, "recovered-" + model + ".bin"), Buffer.from(m[1], "base64"));
      }
    } catch (e) { rec.status = 0; rec.ms = Date.now() - t0; rec.msg = String((e && e.message) || e).slice(0, 140); }
    fs.appendFileSync(LOG, JSON.stringify(rec) + "\n");
    console.log(JSON.stringify(rec));
    if (rec.status === 200 && rec.msg === "IMAGE") { console.log("IMAGE_ACCOUNT_AVAILABLE"); process.exit(0); }
  }
  if (i < iters) await sleep(gap);
}
console.log("NO_IMAGE_ACCOUNT");
process.exit(1);
