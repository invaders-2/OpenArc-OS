/** D4-01 · 真实 localhost fake OpenAI-compatible provider（不是 mock function）。 */
import http from "node:http";

export async function startFakeProvider({ behavior = "success", secretEcho = null, delayMs = 0 } = {}) {
  const state = { requests: 0, authHeaders: [], bodies: [], behavior, closed: 0, toolLoop: null, toolLoopBodies: [], toolCalls: [] };
  const server = http.createServer((req, res) => {
    res.on("close", () => { if (!res.writableEnded) state.closed += 1; });
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
      if (b === "stream" || b === "stream-slow" || b === "stream-disconnect") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const parts = ["Hel", "lo", " OpenArc"];
        let i = 0;
        const tick = () => {
          if (b === "stream-slow") return;
          if (i < parts.length) { res.write("data: " + JSON.stringify({ choices: [{ delta: { content: parts[i] } }] }) + "\n\n"); i += 1; setTimeout(tick, 30); return; }
          if (b === "stream-disconnect") { res.write("data: " + JSON.stringify({ choices: [{ delta: { content: " partial" } }] }) + "\n\n"); res.destroy(); return; }
          res.write("data: " + JSON.stringify({ usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 } }) + "\n\n");
          res.write("data: [DONE]\n\n");
          res.end();
        };
        setTimeout(tick, 10);
        return;
      }
      if (b === "disconnect") { res.writeHead(200, { "content-type": "application/json" }); res.write("{\"choices\":["); return; }
      if (b === "tool") return json(200, { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "delete_everything", arguments: "{}" } }] } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } });
      if (b === "tool-loop") {
        // D4-03B Closure：真实 3-turn tool loop。Fake Provider 只按真实 model messages 决策，
        // 不替 Harness 决定；turn1 search → turn2 read metadata(ref 来自真实 tool result) → turn3 final。
        const respond = () => {
        let parsed = {};
        try { parsed = JSON.parse(raw || "{}"); } catch { parsed = {}; }
        const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
        const flat = JSON.stringify(msgs);
        const names = [];
        for (const m of msgs) if (m && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) if (tc && tc.function && tc.function.name) names.push(String(tc.function.name));
        const toolNames = Array.isArray(parsed.tools) ? parsed.tools.map((t) => t && t.function && t.function.name).filter(Boolean) : [];
        const ref = (flat.match(/resource:\/\/res_[A-Za-z0-9_-]+/) || [null])[0];
        state.toolLoop = { names, toolNames, hasResourceRef: !!ref };
        state.toolLoopBodies.push(raw.slice(0, 20000));
        const call = (id, name, args) => { state.toolCalls.push(name); return json(200, { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 11 * state.requests, completion_tokens: 5, total_tokens: 11 * state.requests + 5 } }); };
        const final = () => json(200, { choices: [{ message: { role: "assistant", content: "OPENARC_DSH_TOOL_OK" } }], usage: { prompt_tokens: 44, completion_tokens: 4, total_tokens: 48 } });
        const plan = Array.isArray(state.toolLoopPlan) ? state.toolLoopPlan : null;
        if (plan) {
          if (names.length < plan.length) { const s = plan[names.length]; return call(s.id || ("call_" + (names.length + 1)), s.name, s.args || {}); }
          return final();
        }
        const query = state.toolLoopQuery || "OPENARC_DSH_VISIBLE_RESOURCE";
        if (!names.includes("resource_search")) return call("call_search_1", "resource_search", { query, limit: 5 });
        if (!names.includes("resource_read_metadata")) return call("call_read_1", "resource_read_metadata", { resourceRef: ref || "resource://res_missing" });
        return final();
        };
        if (delayMs > 0) return void setTimeout(respond, delayMs);
        return respond();
      }
      if (b === "exact") return json(200, { choices: [{ message: { role: "assistant", content: "OPENARC_TASK_OK" } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
      if (b === "external-error") return json(500, { error: { message: "provider boom" } });
      return json(200, { choices: [{ message: { role: "assistant", content: "hello from fake" } }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { baseUrl: "http://127.0.0.1:" + server.address().port, state, close: () => new Promise((r) => server.close(r)), setBehavior: (b) => { state.behavior = b; } };
}
