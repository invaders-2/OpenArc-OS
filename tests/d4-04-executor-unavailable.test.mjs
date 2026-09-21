/**
 * D4-04 · executor 不可用时产品运行验证（真实 product stack，纯 Node）。
 *
 * 已有测试只证明 RuntimeSupervisor 层 fail closed；这里补上产品
 * SideEffectRuntime.executeApproved 入口：launcher 不可用 → 不 spawn、不建 lease、
 * 不 mutation，call 收敛 BLOCKED；上层（orchestrator 使用的同一 TaskService 合同）
 * 把 task/run 收敛到 BLOCKED。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createIdentityService } = require("../electron/identity-bootstrap.cjs");
const { UnavailableExecutorLauncher } = require("../electron/executor-launcher.cjs");

const ADMIN = "admin@openarc.test";
const PW = "admin-password-1";
const TRASH = "resource.trash";

test("D4-04 executor unavailable：产品 executeApproved fail closed（0 spawn / 0 lease / 0 mutation / task 终态）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d404-exec-unavail-"));
  let identity = null;
  try {
    identity = createIdentityService({
      userDataDir: dir,
      safeStorage: null,
      allowAdmin: true,
      executorLauncher: new UnavailableExecutorLauncher(),
    });
    await identity.store.initialize({ identifier: ADMIN, password: PW, displayName: "Admin" });
    const login = await identity.service.dispatch({ type: "identity/login", identifier: ADMIN, password: PW });
    assert.equal(login.ok, true, JSON.stringify(login));
    for (const appId of ["ai", "resource-library"]) {
      if (!identity.authStore.appById(appId)) identity.authStore.upsertApp({ appId, name: appId, publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
    }
    const admin = identity.store.allUsers().find((u) => u.role === "ADMIN");
    const sessionRef = identity.service.current;
    assert.ok(admin && sessionRef, "admin session required");
    const ctx = (appId, extra = {}) => ({ sessionRef, appId, source: "test", ...extra });

    const created = await identity.resourceService.createResource({ context: ctx("resource-library"), resourceType: "text", name: "Executor Unavailable Target", content: "executor-unavailable-body" });
    assert.equal(created.ok, true, JSON.stringify(created));
    const resourceRef = created.resource.resourceRef;
    assert.equal(identity.authorization.grantAppToolPermission({ context: ctx("ai"), appId: "ai", actions: ["tool.resource.search", "tool.resource.readMetadata", "tool.resource.trash"] }).ok, true);
    assert.equal(identity.authorization.grantAppResourcePermission({ context: ctx("resource-library"), appId: "ai", resourceId: created.resource.resourceId, actions: ["resource.read", "resource.delete"] }).ok, true);
    assert.equal(identity.authorization.grantResourcePermission({ context: ctx("resource-library"), principalType: "USER", principalId: admin.id, resourceId: created.resource.resourceId, actions: ["resource.read", "resource.delete", "resource.useByAgent"] }).ok, true);

    // task / step / run 全部经产品 API 准备（不直改 DB）。
    const c = ctx("ai");
    // R-8/F-2：任务必须像产品入口那样绑定 model config —— 未绑定任务不得启动 run。
    // 本用例走的是 executor 不可用路径，不会真的调用模型，只需要一个可解析的 provider + config；
    // 用持有 model.manage 的 settings App Principal 建（ai 只有 view/use/test，不额外放宽权限）。
    const prov = identity.modelService.createProvider({ context: ctx("settings"), displayName: "D404 Executor Probe", baseUrl: "http://127.0.0.1:1/v1" });
    assert.equal(prov.ok, true, JSON.stringify(prov));
    const model = identity.modelService.createModel({ context: ctx("settings"), providerId: prov.provider.providerId, remoteModelId: "remote-d404", capabilities: ["chat"] });
    assert.equal(model.ok, true, JSON.stringify(model));
    const t = identity.taskService.createTask({ context: c, goal: "executor unavailable probe", modelConfigId: model.model.configId });
    assert.equal(t.ok, true, JSON.stringify(t));
    const st = identity.taskService.startTask({ context: c, taskId: t.task.taskId, expectedRevision: t.task.revision });
    assert.equal(st.ok, true, JSON.stringify(st));
    const step = identity.taskService.createStep({ context: c, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: st.task.revision });
    assert.equal(step.ok, true, JSON.stringify(step));
    const ss = identity.taskService.startStep({ context: c, taskId: t.task.taskId, stepId: step.step.stepId, expectedRevision: step.task.revision });
    assert.equal(ss.ok, true, JSON.stringify(ss));
    const run = identity.taskService.startHarnessRun({ context: c, taskId: t.task.taskId, stepId: step.step.stepId, expectedRevision: ss.task.revision });
    assert.equal(run.ok, true, JSON.stringify(run));
    const mr = identity.taskService.markHarnessRunRunning({ context: c, taskId: t.task.taskId, runId: run.run.runId, expectedRevision: run.task.revision });
    assert.equal(mr.ok, true, JSON.stringify(mr));

    const planned = await identity.sideEffectRuntime.proposeWrite({ context: c, taskId: t.task.taskId, stepId: step.step.stepId, runId: run.run.runId, toolId: TRASH, toolVersion: 1, arguments: { resourceRef } });
    assert.equal(planned.ok, true, JSON.stringify(planned));
    const callId = planned.approvalRequestId;
    const approved = identity.sideEffectAuthority.approveSideEffect({ context: { sessionRef, source: "user" }, callId });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assert.equal(identity.sideEffectStore.callById(callId).status, "APPROVED");

    const res = await identity.sideEffectRuntime.executeApproved({ callId, holderId: "oase_1" });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.error, "EXECUTOR_LAUNCHER_UNAVAILABLE", JSON.stringify(res));

    const call = identity.sideEffectStore.callById(callId);
    assert.equal(call.status, "BLOCKED", JSON.stringify(call));
    assert.equal(call.errorCode, "EXECUTOR_LAUNCHER_UNAVAILABLE", JSON.stringify(call));
    assert.equal(identity.supervisor.snapshot().length, 0, "不得注册 runtime");
    assert.equal(identity.supervisor.executorEvidence().length, 0, "不得产生 executor evidence");
    assert.equal(identity.sideEffectStore.leasesOfCall(callId).length, 0, "0 lease");
    assert.equal(identity.resourceService.sideEffectPrecondition({ resourceRef }).trashed, false, "0 mutation");

    // 上层收敛：orchestrator 在 executeApproved 失败后使用同一 TaskService 合同（blockStep + blockHarnessRun）。
    const fresh = identity.taskStore.taskById(t.task.taskId);
    const blockedStep = identity.taskService.blockStep({ context: c, taskId: t.task.taskId, stepId: step.step.stepId, runId: run.run.runId, reason: res.error, event: null, expectedRevision: fresh.revision });
    assert.equal(blockedStep.ok, true, JSON.stringify(blockedStep));
    const blockedRun = identity.taskService.blockHarnessRun({ context: c, taskId: t.task.taskId, runId: run.run.runId, errorCode: res.error, stopReason: "blocked", expectedRevision: blockedStep.task.revision });
    assert.equal(blockedRun.ok, true, JSON.stringify(blockedRun));
    const task = identity.taskStore.taskById(t.task.taskId);
    assert.notEqual(task.status, "RUNNING", "task 不得停留在 RUNNING");
    assert.equal(task.status, "BLOCKED", JSON.stringify(task));
    const runs = identity.taskStore.harnessRunsOfTask(t.task.taskId);
    assert.notEqual(runs[runs.length - 1].status, "RUNNING", "harness run 不得停留在 RUNNING");
    assert.equal(runs[runs.length - 1].status, "BLOCKED");
  } finally {
    try { identity?.supervisor?.stop?.(); } catch { /* ignore */ }
    try { await identity?.modelProxy?.stop?.(); } catch { /* ignore */ }
    try { identity?.store?.close(); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
