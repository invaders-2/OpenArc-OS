/** D4-02B · Permission policy probe：强制 permission request，OpenArc client 一律 reject。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHarnessFixture } from "./fixtures/harness-acp/fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.join(here, "fixtures", "harness-acp", "permission-agent.mjs");

const fx = await createHarnessFixture();
const adapter = fx.makeAdapter({ dshBin: process.execPath, dshArgs: [AGENT] });
after(async () => { try { await adapter.dispose(); } catch { /* ignore */ } await fx.close(); });

test("D4-02B-PERM1 · 强制 permission request → client 返回 reject(cancelled)，0 tool execution", async () => {
  const start = await adapter.start({ context: fx.ctx, modelConfigId: fx.modelConfigId, maxCalls: 2, ttlMs: 60000 });
  assert.equal(start.protocolVersion, 1);
  const r = await adapter.prompt("force a permission request", { timeoutMs: 30000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(adapter.permissions.length, 1, "必须收到 1 次 permission request");
  assert.equal(adapter.events.some((e) => e.type === "permission.requested"), true);
  assert.ok(r.text.includes("permission outcome: cancelled"), "OpenArc client 必须 reject（cancelled）: " + r.text);
  assert.equal(adapter.events.some((e) => e.type === "tool.proposed"), false, "permission 阶段没有已执行 tool");
  assert.equal(fx.fp.state.requests, 0, "permission probe 不触达 Provider（fake agent，不执行任何模型/工具）");
});
