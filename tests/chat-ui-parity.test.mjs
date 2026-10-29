// 全局 AI 对话界面：预览协议、附件上传、对话列表偏好、语音转写、思考过程拆分。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createChatPreview, createVoiceTranscriber, registerChatIpc, kindOf, safeName, CSP_REMOTE, CSP_LOCAL } = require("../electron/chat-preview.cjs");
const { createChatPrefs } = require("../electron/chat-prefs.cjs");
const providerAdapter = require("../electron/provider-adapter.cjs");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "chatui-"));

test("附件写进 uploads/<日期>/，重名加序号，文件名里的空白和括号换掉", () => {
  const dir = tmp();
  const p = createChatPreview({ getWorkspaceDir: () => dir, clock: () => Date.UTC(2026, 9, 28, 8) });
  const a = p.upload({ name: "my report (final).md", data: new TextEncoder().encode("# hi") });
  assert.equal(a.ok, true);
  assert.match(a.file.path, /^uploads\/2026102\d\/my_report_final_\.md$/);
  const b = p.upload({ name: "my report (final).md", data: new TextEncoder().encode("# again") });
  assert.match(b.file.path, /my_report_final_-2\.md$/);
  assert.equal(fs.readFileSync(path.join(dir, b.file.path), "utf8"), "# again");
  assert.equal(p.upload({ name: "x", data: "not bytes" }).ok, false);
  assert.equal(safeName("../../etc/passwd"), "passwd");
});

test("工作文件夹预览：只认文件夹里的文件，文本带正文，路径穿越被拒", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "notes"));
  fs.writeFileSync(path.join(dir, "notes", "a.md"), "# 标题");
  fs.writeFileSync(path.join(os.tmpdir(), "outside-chatui.txt"), "secret");
  const p = createChatPreview({ getWorkspaceDir: () => dir });
  const r = p.openWorkspace({ path: "notes/a.md" });
  assert.equal(r.ok, true); assert.equal(r.kind, "markdown"); assert.equal(r.text, "# 标题");
  assert.match(r.previewUrl, /^openarc-preview:\/\/w\/[^/]+\/notes\/a\.md$/);
  assert.equal(p.openWorkspace({ path: "../outside-chatui.txt" }).ok, false);
  assert.equal(p.openWorkspace({ path: "/etc/passwd" }).ok, false);
  const list = p.listFiles({ query: "a.md" });
  assert.deepEqual(list.items.map((x) => x.path), ["notes/a.md"]);
});

test("预览协议：需要本次启动的随机令牌；生成的 HTML 用不联网的 CSP", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "v.mp4"), Buffer.alloc(1000, 1));
  const p = createChatPreview({ getWorkspaceDir: () => dir });
  const h = p.putHtml({ html: "<script>1</script>" });
  const ok = await p.handle(new Request(h.previewUrl));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-security-policy"), CSP_LOCAL);
  assert.match(CSP_LOCAL, /connect-src 'none'/);
  assert.match(CSP_REMOTE, /script-src 'none'/);
  const forged = h.previewUrl.replace(/\/\/h\/[^/]+\//, "//h/forged/");
  assert.equal((await p.handle(new Request(forged))).status, 404);
  const v = p.openWorkspace({ path: "v.mp4" });
  const part = await p.handle(new Request(v.previewUrl, { headers: { range: "bytes=0-99" } }));
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 100);
});

test("文件种类判断", () => {
  assert.equal(kindOf("a.png"), "image");
  assert.equal(kindOf("a.mp4"), "video");
  assert.equal(kindOf("a.pdf"), "pdf");
  assert.equal(kindOf("a.csv"), "csv");
  assert.equal(kindOf("a.py"), "code");
});

test("对话列表偏好：按用户隔离；删除只是隐藏且会取消置顶；没登录不让改", () => {
  const file = path.join(tmp(), "chat-prefs.json");
  const prefs = createChatPrefs({ file });
  assert.equal(prefs.get({}).ok, false);
  prefs.update({ userId: "u1", taskId: "task_1", action: "rename", title: "  季度\n分析  " });
  prefs.update({ userId: "u1", taskId: "task_1", action: "pin" });
  let g = prefs.get({ userId: "u1" });
  assert.equal(g.titles.task_1, "季度 分析");
  assert.deepEqual(g.pinned, ["task_1"]);
  g = prefs.update({ userId: "u1", taskId: "task_1", action: "hide" });
  assert.deepEqual(g.hidden, ["task_1"]); assert.deepEqual(g.pinned, []);
  assert.deepEqual(prefs.get({ userId: "u2" }).titles, {});
  assert.equal(prefs.update({ userId: "u1", taskId: "../x", action: "pin" }).ok, false);
  // 重新加载后还在
  assert.deepEqual(createChatPrefs({ file }).get({ userId: "u1" }).hidden, ["task_1"]);
});

test("语音转写：只选名字像转写模型的音频模型；没有就如实返回 VOICE_NO_MODEL", async () => {
  const providers = [{ id: "p1", name: "TTS 站", enabled: true, base_url: "https://a", models: [{ model: "tts-1", caps: ["audio"] }] }];
  const store = { listPublic: () => providers };
  const calls = [];
  const service = { legacyExecute: async (x) => { calls.push(x); return { ok: true, text: " 你好 " }; } };
  const v = createVoiceTranscriber({ getStore: () => store, getService: () => service });
  assert.equal(v.status().available, false);
  assert.equal((await v.transcribe({ data: new Uint8Array([1]), mime: "audio/webm" })).error, "VOICE_NO_MODEL");
  providers.push({ id: "p2", name: "转写站", enabled: true, base_url: "https://b", models: [{ model: "whisper-1", caps: ["audio"] }] });
  assert.deepEqual(v.status(), { ok: true, available: true, model: "whisper-1", provider: "转写站" });
  const r = await v.transcribe({ data: new Uint8Array([1, 2, 3]), mime: "audio/webm;codecs=opus" });
  assert.deepEqual(r, { ok: true, text: "你好" });
  assert.equal(calls[0].providerId, "p2"); assert.equal(calls[0].action, "audio"); assert.equal(calls[0].intent, "transcribe");
  assert.equal(calls[0].input.mime, "audio/webm"); assert.equal(calls[0].input.buf.length, 3);
  assert.equal((await v.transcribe({ data: new Uint8Array(0) })).error, "VOICE_EMPTY");
});

test("chat:command：不受信任的调用被拒；未知命令不放行", async () => {
  let handler = null;
  const ipcMain = { handle: (_n, fn) => { handler = fn; } };
  registerChatIpc({ ipcMain, preview: createChatPreview({ getWorkspaceDir: () => tmp() }), isTrusted: (e) => e.trusted === true });
  await assert.rejects(() => handler({ trusted: false }, { command: "workspace/files" }));
  assert.equal((await handler({ trusted: true }, { command: "fs/delete" })).error, "CHAT_COMMAND_NOT_ALLOWED");
  assert.equal((await handler({ trusted: true }, { command: "voice/status" })).available, false);
});

test("思考过程：reasoning_content 与 <think> 前缀都拆出来，不混进正文", () => {
  const a = providerAdapter.parseChatResponse({ choices: [{ message: { content: "答案", reasoning_content: "先想想" } }] });
  assert.equal(a.text, "答案"); assert.equal(a.reasoning, "先想想");
  const b = providerAdapter.parseChatResponse({ choices: [{ message: { content: "<think>推理</think>\n结论" } }] });
  assert.equal(b.text, "结论"); assert.equal(b.reasoning, "推理");
});

test("网站图标：只认位图，按域名缓存；取不到图标时如实返回 NO_ICON；非法域名直接拒绝", async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
  const calls = [];
  const web = { async fetchRaw({ url }) {
    calls.push(url);
    if (url === "https://a.example.com/favicon.ico") return { ok: true, buffer: png, contentType: "image/png", finalUrl: url, truncated: false };
    if (url === "https://b.example.com/favicon.ico") return { ok: true, buffer: Buffer.from("<html>not an icon</html>"), contentType: "text/html", finalUrl: url, truncated: false };
    if (url === "https://b.example.com/") return { ok: true, buffer: Buffer.from('<link rel="shortcut icon" href="/static/i.png">'), contentType: "text/html", finalUrl: url, truncated: false };
    if (url === "https://b.example.com/static/i.png") return { ok: true, buffer: png, contentType: "image/png", finalUrl: url, truncated: false };
    return { ok: false, error: "WEB_HTTP_ERROR" };
  } };
  const p = createChatPreview({ getWebAccess: () => web });
  const a = await p.favicon({ host: "a.example.com" });
  assert.equal(a.ok, true); assert.match(a.dataUrl, /^data:image\/png;base64,/);
  await p.favicon({ host: "a.example.com" });
  assert.equal(calls.filter((u) => u.startsWith("https://a.")).length, 1, "同一域名只取一次");
  const b = await p.favicon({ host: "b.example.com" });
  assert.equal(b.ok, true, "favicon.ico 不是图片时，退回首页里的 <link rel=icon>");
  assert.equal((await p.favicon({ host: "c.example.com" })).error, "NO_ICON");
  assert.equal((await p.favicon({ host: "localhost" })).error, "INVALID_HOST");
  assert.equal((await p.favicon({ host: "a.com/../x" })).error, "INVALID_HOST");
});
