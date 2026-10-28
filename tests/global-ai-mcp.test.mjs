/** 全局 AI · MCP 工具：已连接服务器的工具每轮交给 AI；一律先审批，批准后执行，返回内容交回模型。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
const require = createRequire(import.meta.url);
const { registerMcpToolContracts, mcpToolIdFor } = require("../electron/mcp-tool-contract.cjs");
const { createMcpSideEffectProvider } = require("../electron/mcp-side-effect-provider.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(25); } assert.fail("超时：" + what); };

test("MCP 返回内容有界地交给模型（文字原样，其余类型占位）", async () => {
  const transport = { callTool: async () => ({ ok: true, content: [{ type: "text", text: "HELLO_FROM_MCP" }, { type: "image", data: "xx" }], isError: false }) };
  const contract = { toolId: "mcp.demo.echo", executionPolicy: "CONTROLLED_EXTERNAL_EFFECT", externalTarget: { serverId: "demo", toolName: "echo" } };
  const p = createMcpSideEffectProvider({ transport, registry: null });
  const plan = await p.plan({ args: { text: "hi" }, contract });
  const r = await p.execute({ contract, preconditions: plan.preconditions, expectedEffects: plan.expectedEffects, callId: "c1" });
  assert.equal(r.ok, true);
  assert.equal(r.result.forModel.content, "HELLO_FROM_MCP\n[image]");
  assert.equal(r.result.forModel.untrusted, true);
});

test("真实 dsh：已连接的 MCP 工具出现在 AI 工具列表里；调用先审批，批准后执行，结果交回模型；不合受控合同的不暴露", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", sideEffectApprovalWaitMs: 60000, facadeMaxCalls: 8 });
  try {
    const reg = registerMcpToolContracts(fx.toolRegistry, [{ serverId: "demo", serverName: "Demo", toolName: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }]);
    assert.equal(reg.ok, true, JSON.stringify(reg));
    const toolId = mcpToolIdFor("demo", "echo");
    const calls = [];
    const transport = { callTool: async (req) => { calls.push(req); return { ok: true, content: [{ type: "text", text: "MCP_ECHO:" + req.arguments.text }], isError: false }; } };
    fx.adapters.providers.McpExternal = createMcpSideEffectProvider({ transport, registry: fx.toolRegistry });

    const orch = fx.makeDshOrchestrator({ memoryContext: null });
    // resource.search 是只读工具，不能被当成提议工具塞进来；未知 id 也忽略。
    orch.setDynamicWriteTools(() => [toolId, "resource.search", "mcp.nope.missing"]);
    const name = toolId.replace(/[^A-Za-z0-9]+/g, "_");
    fx.fp.state.toolLoopPlan = [{ id: "call_mcp", name, args: { text: "OPENARC_MCP_INPUT" } }];

    const t = fx.createTask("用 MCP 工具回显");
    const p = orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision });
    await waitFor(() => fx.sideEffectStore.callsOfTask(t.task.taskId).length === 1, 60000, "MCP 审批");
    const call = fx.sideEffectStore.callsOfTask(t.task.taskId)[0];
    assert.equal(call.toolId, toolId);
    assert.equal(calls.length, 0, "批准前不调用外部服务器");
    assert.equal(fx.sideEffectRuntime.decideApproval({ context: { sessionRef: fx.f.sessions.admin, source: "user" }, approvalRequestId: call.callId, decision: "APPROVE" }).ok, true);
    const r = await p;
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].arguments, { text: "OPENARC_MCP_INPUT" });

    const first = JSON.parse(fx.fp.state.toolLoopBodies[0]);
    const names = (first.tools || []).map((x) => x.function.name);
    assert.ok(names.includes(name), "MCP 工具在工具列表里");
    assert.equal(names.filter((n) => n === "resource_search").length, 1, "只读工具没有被重复塞进来");
    assert.ok(!names.some((n) => /nope/.test(n)));
    assert.match(fx.fp.state.toolLoopBodies.join("\n"), /MCP_ECHO:OPENARC_MCP_INPUT/, "MCP 返回内容交回了模型");
  } finally { await fx.close(); }
});

test("没接 MCP（动态清单为空）时，工具列表和以前一样", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeMaxCalls: 4 });
  try {
    fx.fp.state.toolLoopPlan = [];
    const orch = fx.makeDshOrchestrator({ memoryContext: null });
    orch.setDynamicWriteTools(() => []);
    const t = fx.createTask("hi");
    const r = await orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision });
    assert.equal(r.ok, true, JSON.stringify(r));
    const names = (JSON.parse(fx.fp.state.toolLoopBodies[0]).tools || []).map((x) => x.function.name);
    assert.ok(!names.some((n) => n.startsWith("mcp_")));
  } finally { await fx.close(); }
});
