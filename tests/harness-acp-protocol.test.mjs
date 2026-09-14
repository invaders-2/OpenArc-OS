/** D4-02B · ACP protocol / vertical model probe（真实 official dsh --profile acp）。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHarnessFixture, readTree, PROVIDER_SECRET } from "./fixtures/harness-acp/fixture.mjs";

const fx = await createHarnessFixture();
const state = { adapter: null, start: null, result: null };
after(async () => { try { await state.adapter?.dispose(); } catch { /* ignore */ } await fx.close(); });

test("D4-02B-P1 · initialize / session-new / prompt / update / close（ACP v1）", async () => {
  state.adapter = fx.makeAdapter();
  const start = await state.adapter.start({ context: fx.ctx, modelConfigId: fx.modelConfigId, maxCalls: 4, ttlMs: 120000 });
  state.start = start;
  assert.equal(start.protocolVersion, 1);
  assert.equal(start.agentInfo?.name, "deepseek-harness-acp");
  assert.equal(typeof start.sessionId, "string");
  assert.equal(start.dshVersion, "0.1.5-rc.2");
  assert.equal(start.sdkVersion, "1.4.0");

  const r = await state.adapter.prompt("Return exactly: OPENARC_ACP_OK", { timeoutMs: 90000 });
  state.result = r;
  assert.equal(r.ok, true, JSON.stringify({ stopReason: r.stopReason }));
  assert.equal(r.stopReason, "end_turn");
  assert.ok(r.events.some((e) => e.raw === "agent_message_chunk"), "必须有 agent_message_chunk");
  assert.ok(r.events.some((e) => e.type === "usage"), "必须有 usage_update");
  assert.equal(r.text, "hello from fake");
  const close = await state.adapter.closeSession();
  assert.equal(close.ok, true);
});

test("D4-02B-P2 · Model 链路：Harness → Adapter → Model Proxy → Fake Provider；Provider 收到 key", async () => {
  assert.ok(fx.fp.state.requests >= 1, "Fake Provider 必须收到请求");
  assert.equal(fx.fp.state.authHeaders[0], "Bearer " + PROVIDER_SECRET);
  assert.equal(state.adapter.events.some((e) => e.type === "tool.proposed"), false, "0 tool proposal");
  assert.equal(state.adapter.permissions.length, 0, "本 probe 不应发生 permission request");
});

test("D4-02B-P3 · Harness 侧 0 Provider Secret（env/argv/stdout/stderr/DSH_HOME/workspace）", () => {
  const envText = JSON.stringify(state.adapter.childEnv);
  assert.equal(envText.includes(PROVIDER_SECRET), false, "Provider secret 不得在 child env");
  assert.equal("DEEPSEEK_API_KEY" in state.adapter.childEnv, false);
  assert.equal("OPENAI_API_KEY" in state.adapter.childEnv, false);
  assert.equal("ANTHROPIC_API_KEY" in state.adapter.childEnv, false);
  assert.ok(state.adapter.childEnv.OPENARC_MODEL_PROXY_CAPABILITY, "scoped capability 允许在可信 child env");
  const surfaces = JSON.stringify(state.start) + "\n" + envText + "\n" + state.adapter.stderr + "\n" + readTree(state.start.dshHome).text + "\n" + readTree(state.start.workspace).text;
  assert.equal(surfaces.includes(PROVIDER_SECRET), false, "Provider secret 不得出现在 Harness 任何面");
});

test("D4-02B-P4 · dispose：bounded shutdown，child 退出、bridge 关闭、临时目录清理", async () => {
  const d = await state.adapter.dispose();
  assert.equal(d.ok, true);
  assert.equal(d.exited, true, "child 必须退出");
  assert.equal(state.adapter.processExited, true);
  assert.equal(state.adapter.bridge, null);
  assert.equal(fs.existsSync(state.start.dshHome), false, "DSH_HOME 必须清理");
});
