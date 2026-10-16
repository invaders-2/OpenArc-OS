/**
 * 智能画布流式 LLM 真机验证 · 确定性本地 provider（**只替代最后一跳网络**）。
 *
 * 三种模式：
 *   stream    —— 真实 SSE：4 个 delta，token 之间 40ms（证明"边生成边显示"）
 *   nonstream —— 收到 stream:true 也回普通 JSON（证明宿主如实降级，不伪造分块）
 *   slow      —— 只发第一个 delta 后保持连接（证明取消能中止主进程在途请求）
 *
 * 记录每个请求是否 stream、是否被客户端中止（res 'close' 且未写完 = 中止）。
 */
import http from "node:http";

export const STREAM_PREFIX = "OPENARC-STREAM:";
export const STREAM_CHUNKS = ["流", "式", "-", "OK"];

export async function startStreamProvider({ port = Number(process.env.OA_CANVAS_LLM_STREAM_PORT || 5473) } = {}) {
  const state = { mode: "stream", chats: [], aborted: 0, completed: 0 };
  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/__mode") {
        try { const b = JSON.parse(raw || "{}"); if (typeof b.mode === "string") state.mode = b.mode; } catch { /* ignore */ }
        state.chats = []; state.aborted = 0; state.completed = 0;
        return send(200, { ok: true, mode: state.mode });
      }
      if (req.method === "GET" && req.url === "/__state") return send(200, { ok: true, ...state });
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch { /* ignore */ }
        const lastUser = Array.isArray(body.messages) ? [...body.messages].reverse().find((m) => m.role === "user") : null;
        const record = { model: body.model, stream: body.stream === true, streamed: false, aborted: false, text: "", last: String((lastUser && lastUser.content) || "").slice(0, 160) };
        state.chats.push(record);
        // 非流式请求（或 nonstream 模式下的流式请求）一律回普通 JSON：
        // non-stream 出口本来就期望 JSON，不能拿 SSE 冒充。
        if (state.mode === "nonstream" || body.stream !== true) {
          record.text = STREAM_PREFIX + record.last;
          state.completed += 1;
          return send(200, { id: "chatcmpl_nonstream", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: record.text }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
        }
        const chunks = state.mode === "slow" ? STREAM_CHUNKS.slice(0, 1) : STREAM_CHUNKS;
        record.streamed = true;
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        let i = 0;
        let ended = false;
        const pump = () => {
          if (i < chunks.length) {
            const piece = chunks[i]; record.text += piece; i += 1;
            res.write("data: " + JSON.stringify({ id: "chatcmpl_stream", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }) + "\n\n");
            if (state.mode === "slow") return; // 保持连接，等客户端中止
            setTimeout(pump, 40);
          } else {
            ended = true;
            res.write("data: [DONE]\n\n");
            res.end();
            state.completed += 1;
          }
        };
        res.on("close", () => { if (!ended) { record.aborted = true; state.aborted += 1; } });
        setTimeout(pump, 20);
        return;
      }
      return send(404, { error: "not found" });
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port,
    baseUrl: "http://127.0.0.1:" + port + "/v1",
    state: () => ({ ...state, chats: state.chats.map((c) => ({ ...c })) }),
    async setMode(mode) {
      await fetch("http://127.0.0.1:" + port + "/__mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
