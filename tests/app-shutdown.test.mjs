/**
 * D5-03 第十一批 · 关应用收尾顺序（electron/app-shutdown.cjs）的领域单测。
 *
 * 这一层能证明的是「有界 / 不吞错 / 出错也不跳过后面的关库」；
 * 「真实 Electron 退出」由 npm run test:d5-03-exit（真实进程）覆盖，两者不互相替代。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { disposeBounded, disposeHarnessBounded, disposeAppResources, MCP_DISPOSE_MS, HARNESS_DISPOSE_MS } = require("../electron/app-shutdown.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("disposeBounded：未装配 → skipped；超时 → 有界返回且带 timeoutCode；抛错 → 如实带 error，绝不 reject", async () => {
  assert.deepEqual(await disposeBounded({ service: null }), { ok: true, skipped: true });
  assert.deepEqual(await disposeBounded({ service: {} }), { ok: true, skipped: true });

  const t0 = Date.now();
  const hung = await disposeBounded({ service: { dispose: () => new Promise(() => {}) }, timeoutMs: 60, timeoutCode: "HARNESS_DISPOSE_TIMEOUT" });
  const elapsed = Date.now() - t0;
  assert.equal(hung.ok, false);
  assert.equal(hung.timedOut, true);
  assert.equal(hung.timeoutCode, "HARNESS_DISPOSE_TIMEOUT");
  assert.ok(elapsed < 2000, "有界返回，实际 " + elapsed + "ms");

  const threw = await disposeBounded({ service: { dispose: async () => { throw new Error("boom"); } } });
  assert.equal(threw.ok, false);
  assert.equal(threw.error, "boom");
  assert.equal(threw.timedOut, undefined);

  const nonObject = await disposeBounded({ service: { dispose: async () => undefined } });
  assert.deepEqual(nonObject, { ok: true });
});

test("disposeHarnessBounded：harness 超时用独立错误码，且 orchestrator 缺席时 skipped（不假装收过）", async () => {
  const skipped = await disposeHarnessBounded({ orchestrator: null });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, true);
  const hung = await disposeHarnessBounded({ orchestrator: { dispose: () => new Promise(() => {}) }, timeoutMs: 50 });
  assert.equal(hung.timedOut, true);
  assert.equal(hung.error, "HARNESS_DISPOSE_TIMEOUT");
});

test("disposeAppResources：Harness / MCP 收尾都跑完（单项抛错也不跳过），随后才 proxy.stop → store.close", async () => {
  const order = [];
  const res = await disposeAppResources({
    orchestrator: { dispose: async () => { order.push("harness:begin"); await sleep(20); order.push("harness:end"); return { ok: true }; } },
    mcpService: { dispose: async () => { order.push("mcp:throw"); throw new Error("mcp boom"); } },
    identity: { modelProxy: { stop: () => order.push("proxy:stop") }, store: { close: () => order.push("store:close") } },
  });
  // MCP 与 Harness 的收尾是**并发发起**的（两条独立预算不串行相加），所以它们的起点顺序不固定；
  // 必须成立的是：两者都跑完，之后才 proxy.stop → store.close。
  assert.deepEqual(order.slice(-2), ["proxy:stop", "store:close"], JSON.stringify(order));
  assert.ok(order.includes("harness:end") && order.includes("mcp:throw"), JSON.stringify(order));
  assert.ok(order.indexOf("harness:end") < order.indexOf("proxy:stop"), JSON.stringify(order));
  assert.ok(order.indexOf("mcp:throw") < order.indexOf("proxy:stop"), JSON.stringify(order));
  assert.equal(res.ok, false, "MCP 抛错 → ok=false，但后续步骤照做");
  assert.equal(res.mcp.ok, false);
  assert.equal(res.mcp.error, "mcp boom");
  assert.equal(res.harness.ok, true);
  assert.equal(res.proxyStopped, true);
  assert.equal(res.storeClosed, true);
});

test("disposeAppResources：Harness 卡死 → 有界返回、MCP / proxy / store 仍照常收尾", async () => {
  const order = [];
  const t0 = Date.now();
  const res = await disposeAppResources({
    orchestrator: { dispose: () => new Promise(() => {}) },
    mcpService: { dispose: async () => { order.push("mcp"); return { ok: true, closed: 2 }; } },
    identity: { modelProxy: { stop: () => order.push("proxy") }, store: { close: () => order.push("store") } },
    // 用很小的上界让用例快速结束；产品默认值由下面的常量断言守住。
    timeoutMs: 40,
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 4000, "有界，实际 " + elapsed + "ms");
  assert.equal(res.harness.timedOut, true);
  assert.ok(order.includes("mcp") && order.includes("proxy") && order.includes("store"), JSON.stringify(order));
  assert.equal(res.storeClosed, true, "Harness 卡死绝不跳过关库");
  assert.equal(MCP_DISPOSE_MS, 2000);
  assert.equal(HARNESS_DISPOSE_MS, 8000);
});

test("disposeAppResources：identity 缺席也绝不抛（退出路径不许因缺装配而崩）", async () => {
  const res = await disposeAppResources({});
  assert.equal(res.proxyStopped, false);
  assert.equal(res.storeClosed, false);
  assert.equal(res.harness.skipped, true);
  assert.equal(res.mcp.ok, true);
});
