/**
 * D4-04 · deterministic local provider edge（真实 HTTP server）。
 *
 * 只替代"最后一跳 provider network"；不替代 Model Proxy / Harness Adapter / ACP / official dsh。
 * 它按 smoke 设置的 mode 返回确定性的 model tool_call 序列，绝不接触 OpenArc DB / Domain。
 */
import http from "node:http";
import { createRequire } from "node:module";
// 有界 + 强制的关闭：绝不让"未结束的请求连接"把测试文件进程挂死（见 tests/model-fake-provider.mjs 的说明）。
import { closeServer } from "../model-fake-provider.mjs";

const require = createRequire(import.meta.url);
const { AI_TASK_BUDGET } = require("../../electron/task-domain.cjs");

const FINAL_TEXT = "OPENARC_VERTICAL_SMOKE_OK";

function planFor(mode, resourceRefs = [], followSeen = false, explicit = null, sequential = false) {
  // D5-01 Closure-2：显式 plan（[{name, args}]）。它只决定"模型想调什么"，
  // 广播哪些工具、能不能执行、要不要审批一律仍由 Tool Facade / OpenArc 决定。
  if (Array.isArray(explicit) && explicit.length) {
    const steps = sequential && !followSeen ? explicit.slice(0, 1) : explicit;
    return steps.map((s) => ({ name: String(s.name), args: () => (s.args && typeof s.args === "object" ? s.args : {}) }));
  }
  const refs = Array.isArray(resourceRefs) ? resourceRefs : (resourceRefs == null ? [] : [resourceRefs]);
  const search = { name: "resource_search", args: () => ({ query: "Vertical Smoke Resource", limit: 5 }) };
  const read = { name: "resource_read_metadata", args: () => ({ resourceRef: refs[0] ?? null }) };
  const trash = (ref) => ({ name: "resource_trash", args: () => ({ resourceRef: ref ?? null }) });
  // D4-06 Closure：续接成功后立即收尾（0 tool call → 直接 final text），证明不重放旧 tool 请求。
  if (mode === "final") return [];
  if (mode === "read") return [search, read];
  // revoke2：第二次 trash 只在 A 的 verified result 回给 Harness 之后才发出，
  // 保证"先完成 refA 真实 WRITE，再对 refB 等待批准"的顺序。
  if (mode === "revoke2") return followSeen ? [search, trash(refs[0]), trash(refs[1])] : [search, trash(refs[0])];
  if (mode === "write" || mode === "deny" || mode === "cancel" || mode === "unknown") return [search, trash(refs[0])];
  // D4-06 执行异常：真实 WRITE proposal，但 execution 前 Domain version 已变化 → 受控执行失败。
  if (mode === "conflict") return [search, trash(refs[0])];
  // D4-06 预算到限：确定性 READ 次数超过正式 Tool Facade 预算，逼出真实预算停止。
  if (mode === "budget") return Array.from({ length: AI_TASK_BUDGET.TOOL_CALLS + 1 }, (_, i) => ({ name: "resource_search", args: () => ({ query: "Budget Probe " + (i + 1), limit: 5 }) }));
  // D4-08：official dsh facade 下的确定性尺寸探针（test-only test.sized）。
  if (mode === "sized") return [{ name: "test_sized", args: () => ({ expectedSize: 10, label: "box" }) }];
  return [search, read];
}

export async function startD4Provider() {
  const state = { requests: 0, mode: "read", resourceRef: null, resourceRefs: [], toolCalls: [], names: [], authHeaders: [], history: [], finalText: null, bodies: [], plan: null, sequential: false };
  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/__plan") {
        let setPlanFlag = false;
        try {
          const b = JSON.parse(raw || "{}");
          if (typeof b.mode === "string") state.mode = b.mode;
          if (typeof b.resourceRef === "string") { state.resourceRef = b.resourceRef; state.resourceRefs = [b.resourceRef]; }
          if (Array.isArray(b.resourceRefs)) { state.resourceRefs = b.resourceRefs.filter((r) => typeof r === "string"); state.resourceRef = state.resourceRefs[0] || null; }
          if (typeof b.finalText === "string") state.finalText = b.finalText;
          if (Array.isArray(b.plan)) { state.plan = b.plan.filter((s) => s && typeof s.name === "string").slice(0, 32); state.sequential = b.sequential === true; setPlanFlag = true; }
        } catch { /* ignore */ }
        state.requests = 0; state.toolCalls = []; state.names = []; state.bodies = [];
        if (!setPlanFlag) { state.plan = null; state.sequential = false; }
        return send(200, { ok: true });
      }
      if (req.method === "GET" && req.url === "/__bodies") return send(200, { ok: true, bodies: state.bodies });
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        state.requests += 1;
        state.authHeaders.push(req.headers.authorization || null);
        let parsed = {}; try { parsed = JSON.parse(raw || "{}"); } catch { parsed = {}; }
        const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
        // test-only：请求体只留在本进程内存，供 probe 经 /__bodies 读取断言；provider 本身绝不落盘。
        state.bodies.push({ messages: msgs, tools: parsed.tools || null });
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
        const plan = planFor(state.mode, state.resourceRefs.length ? state.resourceRefs : state.resourceRef, followSeen, state.plan, state.sequential);
        const usage = { prompt_tokens: 11 * state.requests, completion_tokens: 5, total_tokens: 11 * state.requests + 5 };
        if (names.length < plan.length) {
          const step = plan[names.length];
          state.toolCalls.push(step.name);
          return send(200, { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_" + state.toolCalls.length, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args()) } }] }, finish_reason: "tool_calls" }], usage });
        }
        return send(200, { choices: [{ message: { role: "assistant", content: state.finalText || FINAL_TEXT } }], usage });
      }
      return send(404, { error: { message: "not found" } });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { baseUrl: "http://127.0.0.1:" + server.address().port + "/v1", port: server.address().port, state, finalText: FINAL_TEXT, close: () => closeServer(server) };
}
