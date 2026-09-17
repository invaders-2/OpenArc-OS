/**
 * D4-04 · deterministic local provider edge（真实 HTTP server）。
 *
 * 只替代"最后一跳 provider network"；不替代 Model Proxy / Harness Adapter / ACP / official dsh。
 * 它按 smoke 设置的 mode 返回确定性的 model tool_call 序列，绝不接触 OpenArc DB / Domain。
 */
import http from "node:http";

const FINAL_TEXT = "OPENARC_VERTICAL_SMOKE_OK";

function planFor(mode, resourceRefs = [], followSeen = false) {
  const refs = Array.isArray(resourceRefs) ? resourceRefs : (resourceRefs == null ? [] : [resourceRefs]);
  const search = { name: "resource_search", args: () => ({ query: "Vertical Smoke Resource", limit: 5 }) };
  const read = { name: "resource_read_metadata", args: () => ({ resourceRef: refs[0] ?? null }) };
  const trash = (ref) => ({ name: "resource_trash", args: () => ({ resourceRef: ref ?? null }) });
  if (mode === "read") return [search, read];
  // revoke2：第二次 trash 只在 A 的 verified result 回给 Harness 之后才发出，
  // 保证"先完成 refA 真实 WRITE，再对 refB 等待批准"的顺序。
  if (mode === "revoke2") return followSeen ? [search, trash(refs[0]), trash(refs[1])] : [search, trash(refs[0])];
  if (mode === "write" || mode === "deny" || mode === "cancel" || mode === "unknown") return [search, trash(refs[0])];
  // D4-06 执行异常：真实 WRITE proposal，但 execution 前 Domain version 已变化 → 受控执行失败。
  if (mode === "conflict") return [search, trash(refs[0])];
  // D4-06 预算到限：14 次受控 READ，超过 Model Proxy(8) / Tool Facade(8) bounded 预算，逼出真实预算停止。
  if (mode === "budget") return Array.from({ length: 14 }, (_, i) => ({ name: "resource_search", args: () => ({ query: "Budget Probe " + (i + 1), limit: 5 }) }));
  return [search, read];
}

export async function startD4Provider() {
  const state = { requests: 0, mode: "read", resourceRef: null, resourceRefs: [], toolCalls: [], names: [], authHeaders: [], history: [] };
  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/__plan") {
        try {
          const b = JSON.parse(raw || "{}");
          if (typeof b.mode === "string") state.mode = b.mode;
          if (typeof b.resourceRef === "string") { state.resourceRef = b.resourceRef; state.resourceRefs = [b.resourceRef]; }
          if (Array.isArray(b.resourceRefs)) { state.resourceRefs = b.resourceRefs.filter((r) => typeof r === "string"); state.resourceRef = state.resourceRefs[0] || null; }
        } catch { /* ignore */ }
        state.requests = 0; state.toolCalls = []; state.names = [];
        return send(200, { ok: true });
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        state.requests += 1;
        state.authHeaders.push(req.headers.authorization || null);
        let parsed = {}; try { parsed = JSON.parse(raw || "{}"); } catch { parsed = {}; }
        const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
        const names = [];
        for (const m of msgs) if (m && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) if (tc && tc.function && tc.function.name) names.push(String(tc.function.name));
        state.names = names.slice();
        const isFollow = (m) => {
          if (!m) return false;
          if (typeof m.content === "string") return m.content.includes("OpenArc verified side-effect result");
          if (Array.isArray(m.content)) return m.content.some((p) => p && typeof p.text === "string" && p.text.includes("OpenArc verified side-effect result"));
          return false;
        };
        const followSeen = msgs.some(isFollow);
        state.history.push({ mode: state.mode, n: names.length, names: names.slice(), followSeen });
        const plan = planFor(state.mode, state.resourceRefs.length ? state.resourceRefs : state.resourceRef, followSeen);
        const usage = { prompt_tokens: 11 * state.requests, completion_tokens: 5, total_tokens: 11 * state.requests + 5 };
        if (names.length < plan.length) {
          const step = plan[names.length];
          state.toolCalls.push(step.name);
          return send(200, { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_" + state.toolCalls.length, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args()) } }] }, finish_reason: "tool_calls" }], usage });
        }
        return send(200, { choices: [{ message: { role: "assistant", content: FINAL_TEXT } }], usage });
      }
      return send(404, { error: { message: "not found" } });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { baseUrl: "http://127.0.0.1:" + server.address().port + "/v1", port: server.address().port, state, finalText: FINAL_TEXT, close: () => new Promise((r) => { server.close(() => r()); }) };
}
