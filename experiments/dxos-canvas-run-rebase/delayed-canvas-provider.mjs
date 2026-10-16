/**
 * DXOS-CANVAS-RUN-REBASE · 带可控延迟的桩 provider（只替代最后一跳网络）。
 *
 * 与 tests/fixtures/d5-02-canvas-provider.mjs 同一形状，但**图像**路径也可控延迟：
 * 画布页面在 POST /api/canvas-image-tasks 之后会落盘 pending 卡片（revision 前进），
 * 这个延迟刚好把这个时序暴露出来。
 *
 *   POST /__mode  { mode: "ok"|"fail", delayMs }  → 设置模式/延迟（默认图像 4000ms）
 *   GET  /__state → 请求计数
 *   POST /v1/chat/completions    → 确定性文本
 *   POST /v1/images/generations  → 确定性 PNG（延迟 delayMs）
 */
import http from "node:http";
import zlib from "node:zlib";

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
/** 生成一张有渐变颜色的 PNG：截图里能肉眼确认「图真的回来了」。 */
export function makePng(width = 320, height = 320) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x += 1) {
      const o = y * stride + 1 + x * 3;
      raw[o] = Math.floor((x * 255) / width);
      raw[o + 1] = Math.floor((y * 255) / height);
      raw[o + 2] = 180;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export const CANVAS_TEXT_PREFIX = "OPENARC-CANVAS-LLM:";

export async function startDelayedCanvasProvider({ port = Number(process.env.OA_REBASE_PORT || 5433), delayMs = 4000 } = {}) {
  const png = makePng(320, 320).toString("base64");
  const state = { mode: "ok", delayMs: Number(delayMs) || 4000, inflight: 0, chats: [], images: [], authSeen: 0, models: [] };
  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/__mode") {
        try { const b = JSON.parse(raw || "{}"); if (typeof b.mode === "string") state.mode = b.mode; if (Number.isFinite(Number(b.delayMs))) state.delayMs = Number(b.delayMs); } catch { /* ignore */ }
        state.chats = []; state.images = [];
        return send(200, { ok: true, mode: state.mode, delayMs: state.delayMs });
      }
      if (req.method === "GET" && req.url === "/__state") return send(200, { ok: true, ...state });
      if (req.headers && typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ")) state.authSeen += 1;
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch { /* ignore */ }
        state.chats.push({ model: body.model, messages: Array.isArray(body.messages) ? body.messages.length : 0 });
        state.models.push(body.model);
        if (state.mode === "fail") return send(500, { error: { message: "provider failure" } });
        const lastUser = Array.isArray(body.messages) ? [...body.messages].reverse().find((m) => m.role === "user") : null;
        const text = CANVAS_TEXT_PREFIX + String((lastUser && lastUser.content) || "").slice(0, 120);
        return send(200, { id: "chatcmpl_rebase", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 } });
      }
      if (req.method === "POST" && req.url === "/v1/images/generations") {
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch { /* ignore */ }
        state.images.push({ model: body.model, prompt: String(body.prompt || "").slice(0, 200), size: body.size || null, n: body.n || 1 });
        state.models.push(body.model);
        if (state.mode === "fail") return send(500, { error: { message: "provider failure" } });
        const n = Math.max(1, Math.min(4, Number(body.n) || 1));
        state.inflight += 1;
        // 关键：图像真的延迟。画布页面的 pending 落盘发生在这个窗口内。
        setTimeout(() => {
          state.inflight -= 1;
          send(200, { created: Math.floor(Date.now() / 1000), data: Array.from({ length: n }, () => ({ b64_json: png, mime_type: "image/png", revised_prompt: "rebase:" + String(body.prompt || "").slice(0, 60) })) });
        }, Math.max(0, Number(state.delayMs) || 0));
        return;
      }
      return send(404, { error: { message: "not found" } });
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port,
    baseUrl: "http://127.0.0.1:" + port + "/v1",
    state: () => ({ ...state, chats: state.chats.slice(), images: state.images.slice() }),
    async setMode(mode, nextDelayMs = null) {
      await fetch("http://127.0.0.1:" + port + "/__mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(nextDelayMs == null ? { mode } : { mode, delayMs: nextDelayMs }) });
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
