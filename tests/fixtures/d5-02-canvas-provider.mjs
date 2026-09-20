/**
 * D5-02 · 画布模型链的确定性本地 provider（**只替代最后一跳网络**）。
 *
 * 它证明"画布的模型调用确实经过 OpenArc 模型服务"：请求里带的是 OpenArc 的凭据与 remote model id，
 * 画布页面永远看不到这些。它不接触 OpenArc 的 DB / Domain / 权限。
 *
 * 两种能力：
 *   · POST /v1/chat/completions   → 确定性文本（用于画布 LLM 节点）
 *   · POST /v1/images/generations → 确定性 1×1 PNG（用于画布图像生成节点）
 * 也提供失败模式（mode=fail）用于"失败如实展示"。
 */
import http from "node:http";
import { closeServer } from "../model-fake-provider.mjs";

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
export const CANVAS_TEXT_PREFIX = "OPENARC-CANVAS-LLM:";

export async function startCanvasProvider({ port = Number(process.env.OA_D502_PORT || 5411) } = {}) {
  const state = { mode: "ok", delayMs: 2500, inflight: 0, chats: [], images: [], authSeen: 0, models: [] };
  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/__mode") {
        try { const b = JSON.parse(raw || "{}"); if (typeof b.mode === "string") state.mode = b.mode; if (Number.isFinite(Number(b.delayMs))) state.delayMs = Number(b.delayMs); } catch { /* ignore */ }
        state.chats = []; state.images = [];
        return send(200, { ok: true, mode: state.mode });
      }
      if (req.method === "GET" && req.url === "/__state") return send(200, { ok: true, ...state, authSeen: state.authSeen });
      if (req.headers && typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ")) state.authSeen += 1;
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch { /* ignore */ }
        state.chats.push({ model: body.model, messages: Array.isArray(body.messages) ? body.messages.length : 0, last: body.messages && body.messages.length ? String(body.messages[body.messages.length - 1].content || "").slice(0, 200) : "" });
        state.models.push(body.model);
        if (state.mode === "fail") return send(500, { error: { message: "provider failure" } });
        const lastUser = Array.isArray(body.messages) ? [...body.messages].reverse().find((m) => m.role === "user") : null;
        const text = CANVAS_TEXT_PREFIX + String((lastUser && lastUser.content) || "").slice(0, 120);
        // slow：真实在途请求（用于"用户停止 / 迟到结果"证据）
        if (state.mode === "slow") { state.inflight += 1; setTimeout(() => { state.inflight -= 1; send(200, { id: "chatcmpl_canvas", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 } }); }, Number(state.delayMs) || 2500); return; }
        return send(200, { id: "chatcmpl_canvas", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 } });
      }
      if (req.method === "POST" && req.url === "/v1/images/generations") {
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch { /* ignore */ }
        state.images.push({ model: body.model, prompt: String(body.prompt || "").slice(0, 200), size: body.size || null, n: body.n || 1 });
        state.models.push(body.model);
        if (state.mode === "fail") return send(500, { error: { message: "provider failure" } });
        const n = Math.max(1, Math.min(4, Number(body.n) || 1));
        return send(200, { created: Math.floor(Date.now() / 1000), data: Array.from({ length: n }, () => ({ b64_json: PNG_1x1, revised_prompt: "canvas:" + String(body.prompt || "").slice(0, 60) })) });
      }
      return send(404, { error: { message: "not found" } });
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port,
    baseUrl: "http://127.0.0.1:" + port + "/v1",
    state: () => ({ ...state }),
    async setMode(mode) {
      await fetch("http://127.0.0.1:" + port + "/__mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
    },
    close: () => closeServer(server),
  };
}
