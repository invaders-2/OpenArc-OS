/** D4-03C1 Closure · 真实 Lease Contention：两个独立 child executor 同时 acquireLease 同一 disk DB。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
const require = createRequire(import.meta.url);
const { IdentityStore, SCHEMA_VERSION } = require("../electron/identity-store.cjs");
const { SideEffectStore } = require("../electron/side-effect-store.cjs");

const CONTENDER = path.join(import.meta.dirname, "fixtures", "harness-acp", "lease-contender.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setupApprovedCall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-c1-contention-"));
  const dbPath = path.join(root, "identity.db");
  const fx = await createToolHarnessFixture({ withAdapters: true, dbPath, keepData: true });
  const run = fx.dshRunSetup();
  const p = await fx.sideEffectAuthority.planSideEffect({ context: fx.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: "test.write", arguments: { target: "doc-1" } });
  assert.equal(p.ok, true, JSON.stringify(p));
  const userCtx = { sessionRef: fx.f.sessions.admin, appId: "ai", source: "user" };
  assert.equal(fx.sideEffectAuthority.approveSideEffect({ context: userCtx, callId: p.call.callId }).ok, true);
  assert.equal(fx.sideEffectAuthority.evaluateExecutionEligibility({ context: fx.ctx(), callId: p.call.callId, holderId: "x" }).status, "LEASE_REQUIRED");
  const now = fx.f.clock();
  const storeRoot = fx.f.storeRoot;
  await fx.close();
  return { root, storeRoot, dbPath, callId: p.call.callId, now };
}

function spawnContender(args) {
  const child = spawn(process.execPath, [CONTENDER, JSON.stringify(args)], { stdio: ["pipe", "pipe", "pipe"] });
  const box = { child, ready: false, result: null, stderr: "", exitCode: null };
  let buf = "";
  box.done = new Promise((resolve) => {
    child.stdout.on("data", (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let msg = null; try { msg = JSON.parse(line); } catch { msg = null; }
        if (!msg) continue;
        if (msg.type === "ready") box.ready = true;
        if (msg.type === "result") { box.result = msg.result; resolve(box.result); }
      }
    });
    child.on("exit", (code) => { box.exitCode = code; resolve(box.result); });
  });
  child.stderr.on("data", (d) => { box.stderr += String(d); });
  return box;
}

async function waitReady(box, ms) {
  const deadline = Date.now() + ms;
  while (!box.ready && Date.now() < deadline) await sleep(20);
  assert.ok(box.ready, "executor 未就绪: " + box.stderr);
}
async function waitExit(box, ms) {
  if (box.child.exitCode != null || box.child.signalCode != null) return;
  await Promise.race([new Promise((r) => box.child.once("exit", r)), sleep(ms)]);
}

test("真实 contention：两个独立 executor 同时 acquire 同一 call → 恰好 1 winner / 1 CONFLICT / 1 ACTIVE", async () => {
  const { root, storeRoot, dbPath, callId, now } = await setupApprovedCall();
  const contenders = [];
  try {
    // 顺序启动（避免两个进程同时执行 PRAGMA journal_mode=WAL 争抢），但 acquire 同时放行。
    contenders.push(spawnContender({ dbPath, callId, holderId: "holder_A", instanceId: "runtime_A", now }));
    await waitReady(contenders[0], 30000);
    contenders.push(spawnContender({ dbPath, callId, holderId: "holder_B", instanceId: "runtime_B", now }));
    await waitReady(contenders[1], 30000);

    contenders[0].child.stdin.write("GO\n");
    contenders[1].child.stdin.write("GO\n");
    const results = await Promise.race([Promise.all(contenders.map((c) => c.done)), sleep(60000).then(() => null)]);
    assert.ok(results, "contender 超时未返回: " + JSON.stringify(contenders.map((c) => c.stderr)));
    for (const c of contenders) { try { c.child.kill("SIGKILL"); } catch { /* ignore */ } }

    const winner = results.filter((r) => r && r.ok === true);
    const conflict = results.filter((r) => r && r.ok === false);
    assert.equal(winner.length, 1, "success count 必须恰好 1: " + JSON.stringify(results));
    assert.equal(conflict.length, 1, "conflict count 必须恰好 1: " + JSON.stringify(results));
    assert.equal(conflict[0].error, "SIDE_EFFECT_LEASE_CONFLICT");
    assert.equal(winner[0].lease.status, "ACTIVE");
    assert.ok(!JSON.stringify(results).includes("SQLITE_BUSY"), "不得暴露裸 SQLITE_BUSY: " + JSON.stringify(results));
    assert.ok(!JSON.stringify(results).includes("SQLITE_LOCKED"), "不得暴露裸 SQLITE_LOCKED: " + JSON.stringify(results));

    // 等两个 executor 真正退出后再重开，避免残留 WAL lock。
    for (const c of contenders) { try { c.child.kill("SIGKILL"); } catch { /* ignore */ } }
    for (const c of contenders) await waitExit(c, 5000);

    const identity = new IdentityStore({ path: dbPath }).open();
    try {
      assert.equal(identity.schemaVersion, SCHEMA_VERSION);
      const store = new SideEffectStore({ identity });
      const active = store.leasesOfCall(callId).filter((l) => l.status === "ACTIVE");
      assert.equal(active.length, 1, "ACTIVE lease count 必须恰好 1");
      assert.equal(active[0].holderId, winner[0].lease.holderId);
      assert.equal(store.callById(callId).status, "LEASED");
    } finally { identity.close(); }
  } finally {
    for (const c of contenders) { try { c.child.kill("SIGKILL"); } catch { /* ignore */ } }
    fs.rmSync(root, { recursive: true, force: true });
    try { fs.rmSync(storeRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
