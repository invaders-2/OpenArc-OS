/**
 * 本地 Anthropic Messages mock（扮演 api.anthropic.com）。
 * 只替代最后一跳网络，其余全部是真实 Electron 主进程 / 产品入口。
 * 鉴权纪律：只记录请求头是否带 x-api-key / anthropic-version，绝不回显密钥值。
 */
import http from "node:http";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_TEXT = "你好，我是本地 mock 扮演的 Claude。";

export async function startAnthropicMock({ secret = "oa-anthropic-mock-secret", text = DEFAULT_TEXT, streamChunks = ["你好，", "我是", " mock Claude。"] } = {}) {
  const state = { requests: [], streamTextChunks: streamChunks, text, authRejects: 0, origin: null };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const headers = req.headers;
      state.requests.push({
        method: req.method,
        url: req.url,
        hasApiKey: typeof headers["x-api-key"] === "string" && headers["x-api-key"].length > 0,
        apiKeyMatches: headers["x-api-key"] === secret,
        anthropicVersion: headers["anthropic-version"] || null,
        hasAuthorization: "authorization" in headers,
        contentType: headers["content-type"] || null,
        body,
      });
      const authed = headers["x-api-key"] === secret && headers["anthropic-version"] === ANTHROPIC_VERSION;
      if (!authed) state.authRejects += 1;

      if (req.url.endsWith("/models")) {
        if (!authed) { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "missing or wrong x-api-key / anthropic-version" } })); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          data: [
            { type: "model", id: "claude-opus-4-6", display_name: "Claude Opus 4.6", created_at: "2026-01-01T00:00:00Z", max_tokens: 64000 },
            { type: "model", id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6", created_at: "2026-01-01T00:00:00Z", max_tokens: 64000 },
          ],
          has_more: false,
        }));
        return;
      }
      if (!authed) { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "missing or wrong x-api-key / anthropic-version" } })); return; }

      if (body && body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const send = (event, payload) => res.write("event: " + event + "\ndata: " + JSON.stringify(payload) + "\n\n");
        send("message_start", { type: "message_start", message: { id: "msg_mock", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 9, output_tokens: 1 } } });
        send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        let i = 0;
        const step = () => {
          if (i >= streamChunks.length) {
            send("content_block_stop", { type: "content_block_stop", index: 0 });
            send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } });
            send("message_stop", { type: "message_stop" });
            res.end();
            return;
          }
          send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: streamChunks[i] } });
          i += 1;
          setTimeout(step, 120).unref();
        };
        setTimeout(step, 30).unref();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_mock", type: "message", role: "assistant", model: body && body.model,
        content: [{ type: "text", text }], stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 7 },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = "http://127.0.0.1:" + server.address().port;
  state.origin = baseUrl;
  return {
    baseUrl,
    state,
    close: () => new Promise((resolve) => { try { server.closeAllConnections?.(); } catch { /* ignore */ } server.close(resolve); }),
  };
}
