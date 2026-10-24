"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const tripo = require("../provider-adapter-tripo.cjs");

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("Tripo text-to-model sends Bearer and expected body", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => { calls.push({ url: String(url), init }); return json({ data: { task_id: "task-1" } }); };
  const out = await tripo.createTask({ apiKey: "sk_test", prompt: "a red apple", fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(out.taskId, "task-1");
  assert.equal(calls[0].url, "https://openapi.tripo3d.ai/v3/generation/text-to-model");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk_test");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.prompt, "a red apple");
  assert.equal(body.model, tripo.MODEL);
  assert.equal(body.texture, true);
  assert.equal(body.pbr, true);
});

test("Tripo image-to-model uses image_url", async () => {
  let body;
  const fetchImpl = async (url, init = {}) => { body = JSON.parse(init.body); return json({ data: { task_id: "task-2" } }); };
  const out = await tripo.createTask({ apiKey: "Bearer sk_test", kind: "image", fileToken: "file-token-1", fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(body.input, "file-token-1");
});

test("Tripo auth/rate-limit errors are structured", async () => {
  assert.equal((await tripo.createTask({ apiKey: "sk", prompt: "x", fetchImpl: async () => json({ message: "unauthorized" }, 401) })).error, "AUTH_FAILED");
  assert.equal((await tripo.createTask({ apiKey: "sk", prompt: "x", fetchImpl: async () => json({ message: "slow" }, 429) })).error, "RATE_LIMITED");
});

test("Tripo getTask success and failure; timeout", async () => {
  const success = await tripo.getTask({ apiKey: "sk", taskId: "t1", fetchImpl: async () => json({ data: { status: "success", output: { model_url: "https://cdn.tripo3d.ai/m.glb" } } }) });
  assert.equal(success.ok, true);
  assert.equal(success.modelUrl, "https://cdn.tripo3d.ai/m.glb");
  const failed = await tripo.getTask({ apiKey: "sk", taskId: "t1", fetchImpl: async () => json({ data: { status: "failed" } }) });
  assert.equal(failed.ok, false);
  const timed = await tripo.getTask({ apiKey: "sk", taskId: "t1", timeoutMs: 5, pollMs: 1, fetchImpl: async () => json({ data: { status: "running" } }) });
  assert.equal(timed.error, "MODEL_TIMEOUT");
});

test("Tripo upload multipart and imageToModel input token", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/v3/files")) return json({ data: { file_token: "ft_1" } });
    return json({ data: { task_id: "task-img" } });
  };
  const uploaded = await tripo.uploadFile({ apiKey: "sk_test", data: Buffer.from("png"), mime: "image/png", filename: "ref.png", fetchImpl });
  assert.equal(uploaded.ok, true);
  assert.equal(uploaded.fileToken, "ft_1");
  const uploadCall = calls[0];
  assert.equal(uploadCall.url, "https://openapi.tripo3d.ai/v3/files");
  assert.ok(uploadCall.init.headers["content-type"].startsWith("multipart/form-data; boundary="));
  const body = Buffer.isBuffer(uploadCall.init.body) ? uploadCall.init.body : Buffer.from(uploadCall.init.body);
  assert.ok(body.includes(Buffer.from('name="file"; filename="ref.png"')));
  const created = await tripo.imageToModel({ apiKey: "sk_test", fileToken: "ft_1", fetchImpl });
  assert.equal(created.ok, true);
  const payload = JSON.parse(calls[1].init.body);
  assert.equal(payload.input, "ft_1");
});

test("Tripo 2010 maps to CREDIT_INSUFFICIENT and blocks foreign model hosts", async () => {
  const out = await tripo.createTask({ apiKey: "sk_test", prompt: "x", fetchImpl: async () => json({ code: 2010, message: "insufficient credit" }, 400) });
  assert.equal(out.error, "CREDIT_INSUFFICIENT");
  assert.equal(out.code, "2010");
  const blocked = await tripo.downloadModel({ url: "https://evil.example/model.glb", fetchImpl: async () => json({}) });
  assert.equal(blocked.error, "MODEL_HOST_BLOCKED");
});
