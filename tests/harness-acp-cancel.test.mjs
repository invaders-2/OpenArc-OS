/** D4-02B · Cancel / Crash probe：真实慢 Provider + session/cancel，child crash 安全失败，0 retry。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHarnessFixture } from "./fixtures/harness-acp/fixture.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fx = await createHarnessFixture({ behavior: "slow" });
const adapters = [];
after(async () => { for (const a of adapters) { try { await a.dispose(); } catch { /* ignore */ } } await fx.close(); });

test("D4-02B-C1 · cancel：Harness 停止、Provider 连接关闭、0 retry", async () => {
  const adapter = fx.makeAdapter();
  adapters.push(adapter);
  await adapter.start({ context: fx.ctx, modelConfigId: fx.modelConfigId, maxCalls: 4, ttlMs: 120000 });
  const before = fx.fp.state.requests;
  const p = adapter.prompt("slow prompt", { timeoutMs: 60000 });
  await sleep(500);
  const c = await adapter.cancel();
  assert.equal(c.ok, true);
  const res = await p.then((r) => r, (e) => ({ error: e.code }));
  assert.ok(res.stopReason === "cancelled" || res.error, JSON.stringify(res));
  await sleep(600);
  assert.equal(fx.fp.state.requests - before, 1, "0 retry：Provider 只被请求 1 次");
  assert.ok(fx.fp.state.closed >= 1, "cancel 必须关闭 Provider 连接");
  const d = await adapter.dispose();
  assert.equal(d.exited, true);
});

test("D4-02B-C2 · child crash：HARNESS_PROCESS_EXITED，无 respawn / 无 retry", async () => {
  const adapter = fx.makeAdapter();
  adapters.push(adapter);
  await adapter.start({ context: fx.ctx, modelConfigId: fx.modelConfigId, maxCalls: 4, ttlMs: 120000 });
  const before = fx.fp.state.requests;
  const p = adapter.prompt("crash prompt", { timeoutMs: 60000 });
  await sleep(500);
  const pid = adapter.child.pid;
  adapter.child.kill("SIGKILL");
  const res = await p.then((r) => r, (e) => ({ error: e.code }));
  assert.equal(res.error, "HARNESS_PROCESS_EXITED", JSON.stringify(res));
  assert.equal(adapter.processExited, true);
  assert.equal(adapter.child.pid, pid, "不得 respawn 新进程");
  await sleep(500);
  assert.ok(fx.fp.state.requests - before <= 1, "crash 后不得有新的 Provider 请求");
  await adapter.dispose();
});

test("D4-02B-C3 · turn timeout：bounded，标记 HARNESS_TURN_TIMEOUT 且不无限挂", async () => {
  const adapter = fx.makeAdapter();
  adapters.push(adapter);
  await adapter.start({ context: fx.ctx, modelConfigId: fx.modelConfigId, maxCalls: 4, ttlMs: 120000 });
  const res = await adapter.prompt("timeout prompt", { timeoutMs: 600 }).then((r) => r, (e) => ({ error: e.code }));
  assert.equal(res.error, "HARNESS_TURN_TIMEOUT", JSON.stringify(res));
  await adapter.dispose();
});
