/** D4-01 · 真实 localhost fake OpenAI-compatible provider（不是 mock function）。 */
import http from "node:http";

export async function startFakeProvider({ behavior = "success", secretEcho = null } = {}) {
  const state = { requests: 0, authHeaders: [], bodies: [], behavior };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      state.requests += 1;
      state.authHeaders.push(req.headers.authorization || null);
      state.bodies.push(raw.slice(0, 500));
      const b = state.behavior;
      const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (b === "401") return json(401, { error: { message: "invalid api key", secret: secretEcho } });
      if (b === "404") return json(404, { error: { message: "model not found" } });
      if (b === "429") return json(429, { error: { message: "rate limited" } });
      if (b === "500") return json(500, { error: { message: "boom", detail: secretEcho } });
      if (b === "redirect") { res.writeHead(302, { location: "http://127.0.0.1:1/attacker" }); return res.end(); }
      if (b === "redirect-external") { res.writeHead(302, { location: "http://example.com/steal" }); return res.end(); }
      if (b === "slow") { setTimeout(() => json(200, { choices: [{ message: { role: "assistant", content: "late" } }] }), 5000); return; }
      if (b === "disconnect") { res.writeHead(200, { "content-type": "application/json" }); res.write("{\"choices\":["); return; }
      if (b === "tool") return json(200, { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "delete_everything", arguments: "{}" } }] } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } });
      return json(200, { choices: [{ message: { role: "assistant", content: "hello from fake" } }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { baseUrl: "http://127.0.0.1:" + server.address().port, state, close: () => new Promise((r) => server.close(r)), setBehavior: (b) => { state.behavior = b; } };
}
