#!/usr/bin/env node
/** 临时重试观察：网关 503 "No available accounts" 是否瞬时。 */
import fs from "node:fs";
const token = fs.readFileSync("/tmp/oa-relay.token", "utf8").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function chat(model) {
  const t0 = Date.now();
  try {
    const r = await fetch("http://43.130.6.197:8080/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "只回复：ok" }], stream: false }),
      redirect: "error",
    });
    const txt = await r.text();
    return { model, status: r.status, ms: Date.now() - t0, body: txt.slice(0, 200) };
  } catch (e) { return { model, status: 0, ms: Date.now() - t0, err: String(e.message || e).slice(0, 150) }; }
}
const n = Number(process.env.OA_RC_N || 6);
const gap = Number(process.env.OA_RC_GAP || 20000);
for (let i = 0; i < n; i += 1) {
  const r = await chat(process.env.OA_RC_MODEL || "gemini-3-flash");
  console.log(JSON.stringify(r));
  if (r.status === 200) break;
  await sleep(gap);
}
