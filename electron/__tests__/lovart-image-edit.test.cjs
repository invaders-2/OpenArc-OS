"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const lovart = require("../provider-adapter-lovart.cjs");

function response(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }

test("Lovart image edit uploads transparent PNG and passes attachments/prompt", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method, body: init.body, headers: init.headers });
    if (u.includes("/file/upload")) return response({ code: 0, data: { url: "https://a.lovart.ai/artifacts/agent/mask.png" } });
    if (u.includes("/project/save")) return response({ project_id: "project-1" });
    if (u.includes("/chat") && !u.includes("/chat/")) return response({ thread_id: "thread-1" });
    if (u.includes("/chat/status")) return response({ status: "done" });
    if (u.includes("/chat/result")) return response({ final_status: "done", items: [{ artifacts: [{ content: "https://a.lovart.ai/artifacts/agent/out.png", type: "image" }] }] });
    return response({}, 404);
  };
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  const out = await lovart.generateImageEdit({
    baseUrl: "https://lgw.lovart.ai",
    apiKey: JSON.stringify({ accessKey: "AK_test", secretKey: "SK_test" }),
    model: "generate_image_gpt_image_2_5_flare",
    prompt: "make it blue",
    mode: "redraw",
    sourceDataUrl: "data:image/png;base64," + png,
    fetchImpl,
    timeoutMs: 5000,
  });
  assert.equal(out.ok, true);
  assert.ok(out.uploadedUrl.includes("mask.png"));
  const upload = calls.find((call) => call.url.includes("/file/upload"));
  assert.ok(upload);
  const body = Buffer.isBuffer(upload.body) ? upload.body : Buffer.from(upload.body);
  assert.ok(body.includes(Buffer.from('name="file"; filename="masked-redraw.png"')));
  assert.ok(upload.headers["content-type"].startsWith("multipart/form-data; boundary="));
  const chat = calls.find((call) => call.url.includes("/chat") && !call.url.includes("/chat/"));
  const chatBody = JSON.parse(String(chat.body));
  assert.deepEqual(chatBody.attachments, ["https://a.lovart.ai/artifacts/agent/mask.png"]);
  assert.match(chatBody.prompt, /transparent-channel area/);
  assert.match(chatBody.prompt, /Redraw prompt: make it blue/);
});

test("accepts Lovart CDN upload host for attachments", () => {
  assert.equal(lovart.isLovartAttachmentUrl("https://cdn.lovart.ai/artifacts/mask.png"), true);
  assert.equal(lovart.isLovartAttachmentUrl("https://a.lovart.ai/artifacts/mask.png"), true);
  assert.equal(lovart.isLovartAttachmentUrl("https://evil.example/mask.png"), false);
  assert.equal(lovart.isLovartAttachmentUrl("http://cdn.lovart.ai/mask.png"), false);
});
