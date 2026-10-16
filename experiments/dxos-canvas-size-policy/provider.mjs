/**
 * DXOS-CANVAS-SIZE-POLICY · 确定性本地 provider（**只替代最后一跳网络**）。
 *
 * 与 tests / dxos-canvas-run-rebase 的桩同形状，但图像产物**按请求的 size 出图**：
 *   · POST /v1/images/generations → 解析 body.size（"WxH"），生成一张**正好该尺寸**的 PNG，
 *     并把请求体里的 model / prompt / size 与真实生成像素记录到 state.images；
 *   · 没有 size / "auto" → 320x320（记录 requested=false）。
 * 这样"请求体 size"与"产物像素"是两条独立事实：前者来自 OpenArc 真正发出的请求，后者来自返回图本身。
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
/** 生成一张 width×height 的渐变 PNG（截图里肉眼可见，且 IHDR 尺寸可独立解析）。 */
export function makePng(width, height) {
  const w = Math.max(1, Math.round(Number(width) || 1));
  const h = Math.max(1, Math.round(Number(height) || 1));
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < w; x += 1) {
      const o = y * stride + 1 + x * 3;
      raw[o] = Math.floor((x * 255) / w);
      raw[o + 1] = Math.floor((y * 255) / h);
      raw[o + 2] = 180;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
/** 从 "WxH" 解析像素；解析不出（null / auto / 别的形状）返回 320x320 且 requested=false。 */
export function sizeToPixels(size) {
  const m = /^\s*(\d+)\s*x\s*(\d+)\s*$/i.exec(String(size == null ? "" : size));
  if (!m) return { width: 320, height: 320, requested: false };
  return { width: Number(m[1]), height: Number(m[2]), requested: true };
}
/** 从 data URL 解析 PNG 的 IHDR 宽高（独立于请求体）。 */
export function pngDimsFromDataUrl(dataUrl) {
  const m = /^data:image\/png;base64,([\s\S]+)$/.exec(String(dataUrl || ""));
  if (!m) return null;
  const buf = Buffer.from(m[1], "base64");
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export async function startSizePolicyProvider({ port = Number(process.env.OA_SIZE_POLICY_PORT || 5477) } = {}) {
  const state = { images: [], chats: [], authSeen: 0 };
  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/__reset") { state.images = []; state.chats = []; return send(200, { ok: true }); }
      if (req.method === "GET" && req.url === "/__state") return send(200, { ok: true, images: state.images.slice(), chats: state.chats.slice(), authSeen: state.authSeen });
      if (req.headers && typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ")) state.authSeen += 1;
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        let body = {}; try { body = JSON.parse(raw || "{}"); } catch { /* ignore */ }
        state.chats.push({ model: body.model });
        return send(200, { id: "chatcmpl_size", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      }
      if (req.method === "POST" && req.url === "/v1/images/generations") {
        let body = {}; try { body = JSON.parse(raw || "{}"); } catch { /* ignore */ }
        const px = sizeToPixels(body.size);
        const n = Math.max(1, Math.min(4, Number(body.n) || 1));
        state.images.push({ model: body.model, prompt: String(body.prompt || "").slice(0, 120), size: body.size == null ? null : String(body.size), requested: px.requested, width: px.width, height: px.height, at: Date.now() });
        // 产物按请求尺寸出图；过大的极端值截到 2048 避免慢，但记录里保留真实请求尺寸
        const png = makePng(Math.min(px.width, 2048), Math.min(px.height, 2048)).toString("base64");
        return send(200, { created: Math.floor(Date.now() / 1000), data: Array.from({ length: n }, () => ({ b64_json: png, mime_type: "image/png", revised_prompt: "size-policy:" + String(body.size || "auto") })) });
      }
      return send(404, { error: { message: "not found" } });
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port,
    baseUrl: "http://127.0.0.1:" + port + "/v1",
    state: () => ({ images: state.images.map((i) => ({ ...i })), chats: state.chats.map((c) => ({ ...c })), authSeen: state.authSeen }),
    async reset() { await fetch("http://127.0.0.1:" + port + "/__reset", { method: "POST" }); },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
