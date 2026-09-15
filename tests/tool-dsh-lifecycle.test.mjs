/** D4-03B Final Closure · Tool Facade lifecycle（cleanup / 5-run / 2-run isolation）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
const require = createRequire(import.meta.url);
const { ToolFacadeBridge } = require("../electron/tool-facade-bridge.cjs");
const { buildToolManifest } = require("../electron/tool-registry.cjs");
const { HarnessAdapter } = require("../electron/harness-adapter.cjs");
const { TaskHarnessOrchestrator } = require("../electron/task-harness-orchestrator.cjs");

const TOOL_IDS = ["resource.read.metadata", "resource.search"];

test("Bridge lifecycle：start → issue → stop → listener/port/capability 全部清理", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true });
  const created = await fx.createResource("OPENARC_DSH_VISIBLE_RESOURCE");
  fx.grantTool("ai", ["tool.resource.readMetadata", "tool.resource.search"]);
  const manifest = buildToolManifest(fx.toolRegistry, { toolIds: TOOL_IDS });
  const bridge = new ToolFacadeBridge({ toolProxy: fx.toolProxy, manifest, clock: fx.f.clock });
  try {
    await bridge.start();
    const port = new URL(bridge.baseUrl).port;
    assert.match(bridge.baseUrl, /^http:\/\/127\.0\.0\.1:/);
    const run = fx.dshRunSetup();
    const cap = bridge.issueCapability({ context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, allowedTools: TOOL_IDS, maxCalls: 2 });
    assert.equal(cap.ok, true);
    assert.equal(bridge.capabilities.size, 1);
    await bridge.stop();
    assert.equal(bridge.server, null);
    assert.equal(bridge.baseUrl, null);
    assert.equal(bridge.capabilities.size, 0);
    await assert.rejects(fetch("http://127.0.0.1:" + port + "/tool-call", { method: "POST" }), /fetch failed|ECONNREFUSED|ECONNRESET/);
    const again = await bridge.stop();
    assert.equal(again.ok, true);
  } finally { await fx.close(); }
});

test("5-run lifecycle：每 run 独立 dsh / DSH_HOME / capability；0 orphan / 0 listener 累积", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  const created = await fx.createResource("OPENARC_DSH_VISIBLE_RESOURCE");
  await fx.f.searchService.indexResource(created.resource.resourceId);
  fx.grantTool("ai", ["tool.resource.readMetadata", "tool.resource.search"]);
  const adapters = []; const bridges = []; const ports = []; const homes = []; const sessions = []; const caps = []; const toolCaps = [];
  const factory = () => {
    const a = new HarnessAdapter({ modelProxy: fx.proxy });
    const origStart = a.start.bind(a);
    a.start = async (opts) => { const info = await origStart(opts); sessions.push(info.sessionId); caps.push(info.capabilityId); toolCaps.push(info.toolCapabilityId); homes.push(info.dshHome); return info; };
    adapters.push(a); return a;
  };
  const bridgeFactory = (o) => {
    const b = new ToolFacadeBridge(o);
    const orig = b.start.bind(b);
    b.start = async () => { const r = await orig(); ports.push(new URL(b.baseUrl).port); return r; };
    bridges.push(b); return b;
  };
  try {
    for (let i = 0; i < 5; i += 1) {
      const orch = new TaskHarnessOrchestrator({ taskService: fx.taskService, adapterFactory: factory, toolProxy: fx.toolProxy, clock: fx.f.clock, toolFacade: { enabled: true, toolIds: TOOL_IDS, maxCalls: 4, ttlMs: 120000, bridgeFactory } });
      const ctx = fx.ctx();
      const t = fx.createTask();
      const r = await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: "OPENARC_DSH_TOOL_OK" } });
      assert.equal(r.ok, true, "run " + i + ": " + JSON.stringify(r));
      assert.equal(r.task.status, "SUCCEEDED");
      const a = adapters[i];
      assert.equal(a.processExited, true, "run " + i + " dsh 必须退出");
      const b = bridges[i];
      assert.equal(b.server, null);
      assert.equal(b.baseUrl, null);
      assert.equal(b.capabilities.size, 0, "run " + i + " capability 必须清空");
      assert.ok(b.stats.calls >= 2, "run " + i + " 至少 2 次 tool call");
      await assert.rejects(fetch("http://127.0.0.1:" + ports[i] + "/tool-call", { method: "POST" }), /fetch failed|ECONNREFUSED|ECONNRESET/);
      assert.equal(a.toolCapability, null, "run " + i + " tool capability 引用必须清空");
      await orch.dispose();
    }
    assert.equal(adapters.length, 5);
    assert.equal(bridges.length, 5);
    assert.equal(new Set(homes).size, 5, "5 个独立 DSH_HOME");
    assert.equal(new Set(ports).size, 5, "5 个独立 loopback port");
    assert.equal(new Set(sessions).size, 5, "5 个独立 ACP session");
    assert.equal(new Set(caps).size, 5, "5 个独立 Model capability");
    assert.equal(new Set(toolCaps).size, 5, "5 个独立 Tool capability");
  } finally { await fx.close(); }
});
