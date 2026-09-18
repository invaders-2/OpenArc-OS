/**
 * D4-03 · 模型配置绑定（真实 TaskService / TaskHarnessOrchestrator / 真实 IPC 入口）。
 *
 * 冻结契约：任务创建时按**后端实际生效**的 model config 冻结 id + version，之后配置变化一律
 * 显式 MODEL_CONFIG_CHANGED —— 绝不静默切换、绝不用新版本签发 capability、绝不留下 RUNNING 悬挂。
 * 绑定前创建的旧任务在首个 run 上懒绑定一次（不伪造历史版本）；R-8：解析不出来时任务保持未绑定，
 * 但**绝不建 run** —— 未绑定时绝不允许启动模型调用或工具执行。
 *
 * 覆盖：产品入口 task/run 绑定（renderer 自报被忽略）/ 无默认配置明确拒绝且不建任务 /
 * 改版后新 run 全量 BLOCKED 且 0 capability / 追加与显式续接同契约 / 默认切换不静默跟随 /
 * 旧任务懒绑定与"解析失败保持既有行为" / 两个确定性同步竞态窗口（含 startModelCall 路径）/
 * R-7 capability 签发同一同步点改版（期望冻结版本透传，绝不签发非冻结版本）/ R-9 绑定后被禁用
 * （配置解析类失败一律在签发前阻断，原因码明确）/ 未绑定旧任务（expected=null）正对照。
 * R-8：K/L/M/N/O 五组用例 —— 未绑定时四条真实入口 0 run / 0 capability / 0 请求 / 0 执行并收敛 BLOCKED、
 * 默认稍后出现才懒绑定并真实成功、并发只形成一种绑定、历史 run/call 逐字段不变且绝不回填、
 * modelService=null 的桩装配与 ad5e600 逐字一致。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createToolHarnessFixture, EXACT } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const require = createRequire(import.meta.url);
const { registerTaskIpc } = require("../electron/task-bootstrap.cjs");
// R-8：unbound 历史 run 只能由契约允许的 test-only 桩装配（modelService=null）构造，与 production 同一实现。
const { TaskService } = require("../electron/task-service.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (fn, ms, detail) => (async () => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(25); } assert.fail("waitFor 超时：" + detail); })();

const VERIFY = { type: "EXACT_TEXT", expected: EXACT };
const rowsOf = (fx, taskId) => ({
  task: JSON.stringify(fx.taskStore.taskById(taskId)),
  steps: fx.taskStore.stepsOfTask(taskId).map((r) => JSON.stringify(r)),
  artifacts: fx.taskStore.artifactsOfTask(taskId).map((r) => JSON.stringify(r)),
  verifications: fx.taskStore.verificationsOfTask(taskId).map((r) => JSON.stringify(r)),
  calls: fx.taskStore.callsOfTask(taskId).map((r) => JSON.stringify(r)),
});
const eventsOfType = (fx, taskId, type) => fx.taskStore.eventsOfTask(taskId).filter((e) => e.event_type === type);
const taskStatus = (fx, taskId) => fx.taskStore.taskById(taskId).status;
const runsOf = (fx, taskId) => fx.taskStore.harnessRunsOfTask(taskId);

/** 真实 IPC 入口（fake ipcMain，与 d4-09 K 同一写法）。 */
function installIpc(fx, orchestrator, sessionRef = fx.f.sessions.admin) {
  const handlers = new Map();
  const events = [];
  registerTaskIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    taskService: fx.taskService, orchestrator, identity: { current: sessionRef },
    send: (ev) => events.push(ev), hostAppId: "ai",
  });
  return { command: handlers.get("task:command"), events };
}

const setChatDefault = (fx, configId, scope = "PERSONAL") => {
  const res = fx.f.modelService.setDefault({ context: fx.ctx(), capability: "chat", configId, scope });
  assert.equal(res.ok, true, "设置默认 chat model 失败：" + JSON.stringify(res));
  return res;
};
const bumpConfig = (fx, configId, displayName) => {
  const res = fx.f.modelService.updateModel({ context: fx.ctx(), configId, displayName });
  assert.equal(res.ok, true, "改版 model config 失败：" + JSON.stringify(res));
  return res.model.version;
};
const newConfig = (fx, remoteModelId, displayName = remoteModelId) => {
  const res = fx.f.modelService.createModel({ context: fx.ctx(), providerId: fx.providerId, remoteModelId, displayName, capabilities: ["chat"] });
  assert.equal(res.ok, true, "创建第二个 model config 失败：" + JSON.stringify(res));
  return res.model.configId;
};
/** capability 签发 spy：只记录安全字段（id/version），绝不接触 token。 */
function spyIssueCapability(fx) {
  const issued = [];
  const orig = fx.proxy.issueCapability.bind(fx.proxy);
  fx.proxy.issueCapability = (args) => {
    const res = orig(args);
    if (res && res.ok) issued.push({ modelConfigId: res.capability.modelConfigId, modelConfigVersion: res.capability.modelConfigVersion });
    return res;
  };
  return issued;
}
const runToTerminal = (fx, taskId, ms = 120000) => waitFor(() => ["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"].includes(taskStatus(fx, taskId)), ms, "任务未收敛终态：taskId=" + taskId);

/** 已冻结任务的第一段真实运行（真实 official dsh + Model Proxy + fake provider）。 */
async function runToSucceeded(fx, taskId, orch = fx.orchestrator) {
  const rev = fx.taskStore.taskById(taskId).revision;
  const r = await orch.runTask({ context: fx.ctx(), taskId, expectedRevision: rev, verify: VERIFY });
  assert.equal(r.ok, true, "初始 run 必须成功：" + JSON.stringify(r.error));
  assert.equal(taskStatus(fx, taskId), "SUCCEEDED");
  return r;
}

/* ============================================================ A 产品入口绑定 */
test("D4-03 A · task/run 由后端解析并冻结 model config；renderer 自报的 id/version 一律忽略", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "exact" });
  try {
    const cid = fx.modelConfigId;
    setChatDefault(fx, cid);
    const otherCid = newConfig(fx, "remote-fake-ignored");
    const ipc = installIpc(fx, fx.orchestrator);

    const resolved = fx.f.modelService.resolveModel({ context: fx.ctx(), capability: "chat" });
    assert.equal(resolved.ok, true, "前置：必须存在可用默认 chat 配置：" + JSON.stringify(resolved));
    assert.equal(resolved.snapshot.modelConfigId, cid);

    // renderer 自报 modelConfigId / modelConfigVersion 一律无效（后端选择）。
    const res = await ipc.command({}, { type: "task/run", goal: "return exactly: " + EXACT, modelConfigId: otherCid, modelConfigVersion: 999 });
    assert.equal(res.ok, true, JSON.stringify(res));
    const taskId = res.taskId;
    assert.ok(taskId, "必须返回 taskId");

    const row = fx.taskStore.taskById(taskId);
    assert.equal(row.model_config_id, resolved.snapshot.modelConfigId, "任务必须绑定后端解析出的 config");
    assert.equal(row.model_config_version, resolved.snapshot.modelConfigVersion, "任务必须绑定后端解析出的 version");
    assert.notEqual(row.model_config_id, otherCid, "renderer 自报的 config 绝不能被采纳");
    assert.notEqual(row.model_config_version, 999, "renderer 自报的 version 绝不能被采纳");
    const created = eventsOfType(fx, taskId, "task.created");
    assert.equal(created.length, 1);
    assert.deepEqual(JSON.parse(created[0].safe_payload), { goal: "return exactly: " + EXACT, modelConfigId: cid, modelConfigVersion: row.model_config_version });

    assert.equal(await runToTerminal(fx, taskId), true);
    assert.equal(taskStatus(fx, taskId), "SUCCEEDED");
    // run 行 / call 行归属同一个冻结值
    const runs = runsOf(fx, taskId);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].model_config_id, cid);
    assert.equal(runs[0].model_config_version, row.model_config_version);
    const calls = fx.taskStore.callsOfTask(taskId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model_config_id, cid);
    assert.equal(calls[0].model_config_version, row.model_config_version);
    // 产品桥如实回投影
    const got = await ipc.command({}, { type: "task/get", taskId });
    assert.equal(got.task.modelConfigId, cid);
    assert.equal(got.task.modelConfigVersion, row.model_config_version);
  } finally { await fx.close(); }
});

/* ============================================================ B 无可用默认配置 */
test("D4-03 B · 无可用默认配置：task/run 明确拒绝且不创建任何任务（绝不静默回退）", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "exact" });
  try {
    const ipc = installIpc(fx, fx.orchestrator);
    const resolved = fx.f.modelService.resolveModel({ context: fx.ctx(), capability: "chat" });
    assert.equal(resolved.ok, false, "前置：本夹具不得存在可用默认配置");
    assert.equal(resolved.error, "MODEL_CONFIG_UNAVAILABLE");

    const before = fx.taskStore.allTasks().length;
    const res = await ipc.command({}, { type: "task/run", goal: "没有默认模型也必须明确失败" });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.error, "MODEL_CONFIG_UNAVAILABLE", JSON.stringify(res));
    assert.equal(fx.taskStore.allTasks().length, before, "解析失败绝不能建任务");
    assert.equal(before, 0, "本用例不得有任何任务行");
    assert.equal(fx.fp.state.requests, 0, "0 模型请求");
  } finally { await fx.close(); }
});

/* ============================================================ C 改版后的新 run */
test("D4-03 C · 配置改版后该任务的新 run：MODEL_CONFIG_CHANGED / 全量 BLOCKED / 0 call / 0 capability / 0 artifact", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "exact" });
  try {
    const cid = fx.modelConfigId;
    const ctx = fx.ctx();
    const t = fx.taskService.createTask({ context: ctx, goal: "冻结后改版", modelConfigId: cid });
    assert.equal(t.task.modelConfigVersion, 1);
    const frozenVersion = t.task.modelConfigVersion;
    assert.equal(bumpConfig(fx, cid, "renamed-after-freeze"), 2, "改版必须 bump version");

    const issued = spyIssueCapability(fx);
    const r = await fx.orchestrator.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, verify: VERIFY });
    assert.equal(r.ok, false, "配置变化必须拒绝：" + JSON.stringify(r));
    assert.equal(r.error, "MODEL_CONFIG_CHANGED", JSON.stringify(r));
    assert.equal(r.blocked, true, JSON.stringify(r));

    assert.equal(taskStatus(fx, t.task.taskId), "BLOCKED", "Task 必须收敛 BLOCKED");
    const steps = fx.taskStore.stepsOfTask(t.task.taskId);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].status, "BLOCKED", "Step 必须收敛 BLOCKED");
    const runs = runsOf(fx, t.task.taskId);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "BLOCKED", "HarnessRun 绝不允许停在 RUNNING/STARTING");
    assert.equal(runs[0].error_code, "MODEL_CONFIG_CHANGED");
    assert.equal(runs[0].model_config_id, cid);
    assert.equal(runs[0].model_config_version, frozenVersion, "run 行必须挂冻结版本");

    assert.equal(fx.taskStore.callsOfTask(t.task.taskId).length, 0, "0 条 model call");
    assert.equal(fx.taskStore.artifactsOfTask(t.task.taskId).length, 0, "0 Artifact");
    assert.equal(fx.taskStore.verificationsOfTask(t.task.taskId).length, 0, "0 Verification");
    assert.equal(issued.filter((c) => c.modelConfigVersion !== frozenVersion).length, 0, "绝不允许以非冻结版本签发 capability：" + JSON.stringify(issued));
    assert.equal(issued.length, 0, "版本已变时连 capability 都不允许签发：" + JSON.stringify(issued));
    assert.equal(fx.fp.state.requests, 0, "0 provider 请求");
    assert.equal(taskStatus(fx, t.task.taskId) === "SUCCEEDED", false, "绝不能被写成成功");
  } finally { await fx.close(); }
});

/* ============================================================ D 追加 / 显式续接同一契约 */
test("D4-03 D1 · 改版后 appendStep：同步接收但整链 MODEL_CONFIG_CHANGED + 全量 BLOCKED + 0 执行 + 旧产物逐字段不变", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "exact" });
  try {
    const cid = fx.modelConfigId;
    const ctx = fx.ctx();
    const t = fx.taskService.createTask({ context: ctx, goal: "return exactly: " + EXACT, modelConfigId: cid });
    const frozenVersion = t.task.modelConfigVersion;
    await runToSucceeded(fx, t.task.taskId);
    const before = rowsOf(fx, t.task.taskId);
    const requestsBefore = fx.fp.state.requests;
    const issued = spyIssueCapability(fx);

    assert.equal(bumpConfig(fx, cid, "renamed-before-append"), 2);
    const appended = await fx.orchestrator.appendStep({ context: ctx, taskId: t.task.taskId, goal: "下一步目标", expectedRevision: fx.taskStore.taskById(t.task.taskId).revision, verify: VERIFY });
    assert.equal(appended.ok, false, JSON.stringify(appended));
    assert.equal(appended.error, "MODEL_CONFIG_CHANGED", JSON.stringify(appended));
    assert.equal(appended.blocked, true, JSON.stringify(appended));

    const after = rowsOf(fx, t.task.taskId);
    assert.equal(after.steps.length, 2, "只新增一个 step");
    assert.equal(JSON.parse(after.steps[0]).status, "SUCCEEDED", "旧 step 保持成功");
    assert.equal(JSON.parse(after.steps[1]).status, "BLOCKED", "追加 step 必须收敛 BLOCKED");
    assert.equal(taskStatus(fx, t.task.taskId), "BLOCKED", "任务不得停在 RUNNING，也不得被写成成功");
    assert.equal(JSON.parse(after.task).status, "BLOCKED");
    const runs = runsOf(fx, t.task.taskId);
    assert.equal(runs.length, 2);
    assert.equal(runs[1].status, "BLOCKED", "新 run 绝不允许停在 STARTING/RUNNING");
    assert.equal(runs[1].error_code, "MODEL_CONFIG_CHANGED");
    assert.equal(runs[1].model_config_version, frozenVersion);
    // 0 执行：无新 call / 新 artifact / 新 verification / 无 provider 请求
    assert.equal(after.calls.length, 1, "0 条新 model call");
    assert.equal(after.artifacts.length, 1, "0 新 Artifact");
    assert.equal(after.verifications.length, 1, "0 新 Verification");
    assert.equal(fx.fp.state.requests, requestsBefore, "0 provider 请求");
    // 旧 artifact / verification 逐字段不变
    assert.deepEqual(after.artifacts, before.artifacts, "旧 artifact 行逐字段不变");
    assert.deepEqual(after.verifications, before.verifications, "旧 verification 行逐字段不变");
    assert.deepEqual(after.steps.slice(0, 1), before.steps, "旧 step 行逐字段不变");
    assert.equal(after.calls[0], before.calls[0], "旧 call 行逐字段不变");
    assert.equal(issued.filter((c) => c.modelConfigVersion !== frozenVersion).length, 0, "绝不允许以非冻结版本签发 capability：" + JSON.stringify(issued));
    assert.equal(issued.length, 0, "改版后的 append 不得签发任何 capability：" + JSON.stringify(issued));
    assert.equal(eventsOfType(fx, t.task.taskId, "task.succeeded").length, 1, "追加失败不得追加 task.succeeded");
  } finally { await fx.close(); }
});

test("D4-03 D2 · 改版后 resumeBudgetExhausted：明确 MODEL_CONFIG_CHANGED + 全量 BLOCKED + 0 执行 + 旧产物不变", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "exact", modelMaxCalls: 1 });
  try {
    const cid = fx.modelConfigId;
    const ctx = fx.ctx();
    const t = fx.taskService.createTask({ context: ctx, goal: "return exactly: " + EXACT, modelConfigId: cid });
    const frozenVersion = t.task.modelConfigVersion;
    await runToSucceeded(fx, t.task.taskId);
    assert.equal(fx.taskService.getTaskBudget({ context: ctx, taskId: t.task.taskId }).kinds.MODEL_CALLS.remaining, 0, "前置：MODEL_CALLS 已用尽");

    // 预算停止（真实事件路径）→ 该任务可被显式续接
    const stopStep = fx.taskService.appendStep({ context: ctx, taskId: t.task.taskId, goal: "预算停止目标", expectedRevision: fx.taskStore.taskById(t.task.taskId).revision });
    assert.equal(stopStep.ok, true, JSON.stringify(stopStep));
    const stopped = await fx.orchestrator.runStep({ context: ctx, taskId: t.task.taskId, stepId: stopStep.step.stepId, expectedRevision: stopStep.task.revision, stepInput: stopStep.step.input, verify: VERIFY });
    assert.equal(stopped.ok, false);
    assert.equal(stopped.error, "BUDGET_EXHAUSTED");
    const elig = fx.taskService.getResumeEligibility({ context: ctx, taskId: t.task.taskId });
    assert.equal(elig.resumable, true, "前置：必须可显式续接：" + JSON.stringify(elig));

    const before = rowsOf(fx, t.task.taskId);
    const requestsBefore = fx.fp.state.requests;
    const issued = spyIssueCapability(fx);
    assert.equal(bumpConfig(fx, cid, "renamed-before-resume"), 2);

    const resumed = await fx.orchestrator.resumeBudgetExhausted({ context: ctx, taskId: t.task.taskId, expectedRevision: fx.taskStore.taskById(t.task.taskId).revision, verify: VERIFY });
    assert.equal(resumed.ok, false, JSON.stringify(resumed));
    assert.equal(resumed.error, "MODEL_CONFIG_CHANGED", JSON.stringify(resumed));
    assert.equal(resumed.blocked, true, JSON.stringify(resumed));

    const after = rowsOf(fx, t.task.taskId);
    assert.equal(taskStatus(fx, t.task.taskId), "BLOCKED", "任务不得停在 RUNNING，也不得被写成成功");
    assert.notEqual(taskStatus(fx, t.task.taskId), "SUCCEEDED");
    const steps = fx.taskStore.stepsOfTask(t.task.taskId);
    assert.equal(steps[steps.length - 1].status, "BLOCKED");
    const runs = runsOf(fx, t.task.taskId);
    const resumeRun = runs[runs.length - 1];
    assert.equal(resumeRun.status, "BLOCKED", "续接 run 绝不允许停在 STARTING/RUNNING");
    assert.equal(resumeRun.error_code, "MODEL_CONFIG_CHANGED");
    assert.equal(resumeRun.model_config_version, frozenVersion);
    assert.equal(after.calls.length, 1, "0 条新 model call");
    assert.equal(after.artifacts.length, 1, "0 新 Artifact");
    assert.equal(fx.fp.state.requests, requestsBefore, "0 provider 请求");
    assert.deepEqual(after.artifacts, before.artifacts, "旧 artifact 行逐字段不变");
    assert.deepEqual(after.verifications, before.verifications, "旧 verification 行逐字段不变");
    assert.equal(after.calls[0], before.calls[0], "旧 call 行逐字段不变");
    // 续接额度只被 grant（既有语义），绝不被未发生的模型调用消耗
    assert.equal(fx.taskService.getTaskBudget({ context: ctx, taskId: t.task.taskId }).kinds.MODEL_CALLS.consumed, 1, "0 新模型调用消耗");
    assert.equal(issued.filter((c) => c.modelConfigVersion !== frozenVersion).length, 0, "绝不允许以非冻结版本签发 capability：" + JSON.stringify(issued));
    assert.equal(issued.length, 0, "改版后的续接不得签发任何 capability：" + JSON.stringify(issued));
  } finally { await fx.close(); }
});

/* ============================================================ E 未变化正常运行 */
test("D4-03 E · 默认切到另一个 config（原 config 未变）：原任务 append 仍成功且归属不变，新任务绑定新默认", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "exact" });
  try {
    const cid = fx.modelConfigId;
    setChatDefault(fx, cid);
    const ipc = installIpc(fx, fx.orchestrator);

    const first = await ipc.command({}, { type: "task/run", goal: "return exactly: " + EXACT });
    assert.equal(first.ok, true, JSON.stringify(first));
    const taskA = first.taskId;
    assert.equal(await runToTerminal(fx, taskA), true);
    assert.equal(taskStatus(fx, taskA), "SUCCEEDED");
    const aVersion = fx.taskStore.taskById(taskA).model_config_version;
    const aRowsBefore = rowsOf(fx, taskA);

    // 默认切到**另一个** config；原 config 自身未变（version 不动）。
    const cid2 = newConfig(fx, "remote-fake-2");
    setChatDefault(fx, cid2);
    const resolvedNow = fx.f.modelService.resolveModel({ context: fx.ctx(), capability: "chat" });
    assert.equal(resolvedNow.snapshot.modelConfigId, cid2, "前置：默认已指向新 config");
    assert.equal(fx.f.modelService.resolveModel({ context: fx.ctx(), configId: cid }).snapshot.modelConfigVersion, aVersion, "前置：原 config 自身未变");

    const appended = await fx.orchestrator.appendStep({ context: fx.ctx(), taskId: taskA, goal: "默认已切换后的追加", expectedRevision: fx.taskStore.taskById(taskA).revision, verify: VERIFY });
    assert.equal(appended.ok, true, "原 config 未变时追加必须成功：" + JSON.stringify(appended.error));
    assert.equal(taskStatus(fx, taskA), "SUCCEEDED");
    const aRowsAfter = rowsOf(fx, taskA);
    assert.equal(aRowsAfter.steps.length, 2);
    assert.deepEqual(aRowsAfter.steps.slice(0, 1), aRowsBefore.steps, "旧 step 行不变");
    assert.deepEqual(aRowsAfter.artifacts.slice(0, 1), aRowsBefore.artifacts, "旧 artifact 行不变");
    assert.equal(aRowsAfter.artifacts.length, 2, "追加 run 真实产出第二个 artifact");
    const aRow = fx.taskStore.taskById(taskA);
    assert.equal(aRow.model_config_id, cid, "任务归属必须仍是原 config（绝不静默切到新默认）");
    assert.equal(aRow.model_config_version, aVersion);
    for (const run of runsOf(fx, taskA)) assert.equal(run.model_config_id, cid, "每个 run 行都必须归属原 config");
    for (const call of fx.taskStore.callsOfTask(taskA)) assert.equal(call.model_config_id, cid, "每条 call 行都必须归属原 config");

    // 同一默认下的新任务：绑定新默认并正常运行成功
    const second = await ipc.command({}, { type: "task/run", goal: "return exactly: " + EXACT });
    assert.equal(second.ok, true, JSON.stringify(second));
    const taskB = second.taskId;
    assert.equal(await runToTerminal(fx, taskB), true);
    assert.equal(taskStatus(fx, taskB), "SUCCEEDED");
    const bRow = fx.taskStore.taskById(taskB);
    assert.equal(bRow.model_config_id, cid2, "新任务必须绑定当前默认");
    assert.equal(bRow.model_config_version, resolvedNow.snapshot.modelConfigVersion);
  } finally { await fx.close(); }
});

/* ============================================================ F 旧任务兼容 */
test("D4-03 F1 · 绑定前创建的旧任务首个 run：同一事务懒绑定 + task.model_config_bound 事件 + run 行归属正确", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "exact" });
  try {
    const cid = fx.modelConfigId;
    setChatDefault(fx, cid);
    const ctx = fx.ctx();
    // 旧任务：createTask 不传 config（模拟绑定能力上线之前创建的库行）
    const t = fx.taskService.createTask({ context: ctx, goal: "legacy unbound probe" });
    assert.equal(t.task.modelConfigId, null, "旧任务起始必须未绑定");
    assert.equal(t.task.modelConfigVersion, null);
    assert.equal(eventsOfType(fx, t.task.taskId, "task.model_config_bound").length, 0, "未绑定时不得有绑定事件");

    const started = fx.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const step = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: started.task.revision });
    const stepStarted = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: step.step.stepId, expectedRevision: step.task.revision });
    const revBefore = fx.taskStore.taskById(t.task.taskId).revision;
    const run = fx.taskService.startHarnessRun({ context: ctx, taskId: t.task.taskId, stepId: step.step.stepId, expectedRevision: stepStarted.task.revision });
    assert.equal(run.ok, true, JSON.stringify(run));

    const row = fx.taskStore.taskById(t.task.taskId);
    assert.equal(row.model_config_id, cid, "旧任务必须被懒绑定到当前生效配置");
    assert.equal(row.model_config_version, 1);
    assert.equal(run.task.modelConfigId, cid);
    assert.equal(run.task.modelConfigVersion, 1);
    assert.equal(run.run.modelConfigId, cid, "run 行归属必须是绑定值");
    assert.equal(run.run.modelConfigVersion, 1);
    assert.equal(row.revision, revBefore + 1, "懒绑定与建 run 同属一次 revision 递增");
    const bound = eventsOfType(fx, t.task.taskId, "task.model_config_bound");
    assert.equal(bound.length, 1, "恰好一条绑定事件");
    assert.deepEqual(JSON.parse(bound[0].safe_payload), { modelConfigId: cid, modelConfigVersion: 1, source: "PERSONAL_DEFAULT", reason: "LEGACY_UNBOUND_LAZY_BIND" });
    const startedEvents = eventsOfType(fx, t.task.taskId, "harness.run.started");
    assert.equal(startedEvents.length, 1);
    assert.deepEqual(Object.keys(JSON.parse(startedEvents[0].safe_payload)).sort(), ["acpVersion", "harnessVersion", "modelConfigId", "modelConfigVersion", "runId", "stepId"]);
    assert.deepEqual(JSON.parse(startedEvents[0].safe_payload).modelConfigId, cid);
    // 只绑定一次：第二个 run 不再写绑定事件
    const step2 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: fx.taskStore.taskById(t.task.taskId).revision });
    const step2Started = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: step2.step.stepId, expectedRevision: step2.task.revision });
    const run2 = fx.taskService.startHarnessRun({ context: ctx, taskId: t.task.taskId, stepId: step2.step.stepId, expectedRevision: step2Started.task.revision });
    assert.equal(run2.ok, true, JSON.stringify(run2));
    assert.equal(run2.run.modelConfigId, cid, "第二个 run 使用已绑定值");
    assert.equal(eventsOfType(fx, t.task.taskId, "task.model_config_bound").length, 1, "绑定只发生一次");
  } finally { await fx.close(); }
});

test("D4-03 F2 · R-8：无可用默认配置的旧任务：保持未绑定且绝不建 run（明确 MODEL_CONFIG_UNAVAILABLE）", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "exact" });
  try {
    const ctx = fx.ctx();
    assert.equal(fx.f.modelService.resolveModel({ context: ctx, capability: "chat" }).ok, false, "前置：不得存在可用默认配置");
    const t = fx.taskService.createTask({ context: ctx, goal: "legacy unbound, no default" });
    const started = fx.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const step = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: started.task.revision });
    const stepStarted = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: step.step.stepId, expectedRevision: step.task.revision });
    const revBefore = fx.taskStore.taskById(t.task.taskId).revision;
    const run = fx.taskService.startHarnessRun({ context: ctx, taskId: t.task.taskId, stepId: step.step.stepId, expectedRevision: stepStarted.task.revision });
    assert.equal(run.ok, false, "未绑定且解析不出配置时绝不建 run：" + JSON.stringify(run));
    assert.equal(run.error, "MODEL_CONFIG_UNAVAILABLE", JSON.stringify(run));
    assert.equal(run.message, "任务未绑定模型配置，无法启动", JSON.stringify(run));
    assert.equal(runsOf(fx, t.task.taskId).length, 0, "0 条 harness run");
    const row = fx.taskStore.taskById(t.task.taskId);
    assert.equal(row.model_config_id, null, "必须保持未绑定");
    assert.equal(row.model_config_version, null);
    assert.equal(row.revision, revBefore, "失败不得改 revision");
    assert.equal(eventsOfType(fx, t.task.taskId, "task.model_config_bound").length, 0, "解析失败不得伪造绑定事件");
    const types = fx.taskStore.eventsOfTask(t.task.taskId).map((e) => e.event_type);
    assert.deepEqual(types, ["task.created", "task.started", "step.created", "step.started"], "失败不得追加任何执行事件");

    // 真实 Harness 路径：未绑定且解析不出默认配置的任务不可能悄悄跑成一次模型调用；
    // 必须显式失败、0 run / 0 capability，并收敛 BLOCKED（绝不 RUNNING 悬挂）。
    const requestsBefore = fx.fp.state.requests;
    const capsBefore = fx.proxy.capabilities.size;
    const t2 = fx.taskService.createTask({ context: ctx, goal: "unbound legacy through real harness" });
    const r2 = await fx.orchestrator.runTask({ context: ctx, taskId: t2.task.taskId, expectedRevision: t2.task.revision, verify: VERIFY });
    assert.equal(r2.ok, false, "解析不出配置时真实 run 必须显式失败：" + JSON.stringify(r2));
    assert.equal(r2.error, "MODEL_CONFIG_UNAVAILABLE", JSON.stringify(r2));
    assert.equal(r2.blocked, true, JSON.stringify(r2));
    assert.equal(taskStatus(fx, t2.task.taskId), "BLOCKED", "必须收敛 BLOCKED");
    assert.equal(fx.taskStore.stepsOfTask(t2.task.taskId)[0].status, "BLOCKED", "Step 必须收敛 BLOCKED");
    assert.equal(runsOf(fx, t2.task.taskId).length, 0, "0 条 harness run");
    assert.equal(fx.taskStore.callsOfTask(t2.task.taskId).length, 0, "0 条 model call");
    assert.equal(fx.taskStore.artifactsOfTask(t2.task.taskId).length, 0, "0 Artifact");
    assert.equal(fx.fp.state.requests, requestsBefore, "0 provider 请求");
    assert.equal(fx.proxy.capabilities.size, capsBefore, "0 capability 签发");
    assert.equal(fx.taskStore.taskById(t2.task.taskId).model_config_id, null, "依然未绑定，绝不静默选一个 config 跑");
  } finally { await fx.close(); }
});

/* ============================================================ G 确定性竞态同步点（无 sleep） */
test("D4-03 G · 两个同步竞态窗口（绑定→签发 / 签发→调用）：绝不以非冻结版本签发 capability，run 绝不悬挂", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "exact" });
  try {
    const cid = fx.modelConfigId;
    const ctx = fx.ctx();

    // G1：createTask 返回（绑定完成）之后、capability 签发之前，顺序同步改版。
    const t1 = fx.taskService.createTask({ context: ctx, goal: "race: bind -> issue", modelConfigId: cid });
    const frozen = t1.task.modelConfigVersion;
    const issued1 = spyIssueCapability(fx);
    assert.equal(bumpConfig(fx, cid, "race-rename-1"), frozen + 1, "同步改版必须发生在绑定之后、签发之前");
    const r1 = await fx.orchestrator.runTask({ context: ctx, taskId: t1.task.taskId, expectedRevision: t1.task.revision, verify: VERIFY });
    assert.ok(r1.ok === true || r1.error === "MODEL_CONFIG_CHANGED", "结果只能是冻结版本成功或明确 MODEL_CONFIG_CHANGED：" + JSON.stringify(r1));
    assert.equal(r1.error, "MODEL_CONFIG_CHANGED");
    assert.equal(taskStatus(fx, t1.task.taskId), "BLOCKED");
    assert.equal(runsOf(fx, t1.task.taskId)[0].status, "BLOCKED");
    assert.equal(runsOf(fx, t1.task.taskId)[0].model_config_version, frozen, "run 必须挂冻结版本");
    assert.equal(fx.taskStore.callsOfTask(t1.task.taskId).length, 0);
    assert.equal(issued1.filter((c) => c.modelConfigVersion !== frozen).length, 0, "没有任何一次签发使用非冻结版本：" + JSON.stringify(issued1));
    assert.equal(issued1.length, 0, "版本已变时不得签发 capability");

    // G2：capability 已按冻结版本签发之后、startModelCall 之前，同步改版
    //     （adapter.start 内部完成签发，返回前同步改版 —— 与真实重启/并发写入同一窗口，无 sleep）。
    const t2 = fx.taskService.createTask({ context: ctx, goal: "race: issue -> call", modelConfigId: cid });
    const frozen2 = t2.task.modelConfigVersion;
    const issued2 = spyIssueCapability(fx);
    const baseFactory = fx.realAgentFactory();
    const racingFactory = () => {
      const adapter = baseFactory();
      const origStart = adapter.start.bind(adapter);
      adapter.start = async (opts) => {
        const info = await origStart(opts);
        bumpConfig(fx, cid, "race-rename-2");
        return info;
      };
      return adapter;
    };
    const orch = fx.makeOrchestrator(racingFactory);
    try {
      const r2 = await orch.runTask({ context: ctx, taskId: t2.task.taskId, expectedRevision: t2.task.revision, verify: VERIFY });
      assert.equal(r2.ok, false, "改版后必须显式拒绝：" + JSON.stringify(r2));
      assert.equal(r2.error, "MODEL_CONFIG_CHANGED", JSON.stringify(r2));
      assert.equal(r2.blocked, true, JSON.stringify(r2));
      assert.equal(taskStatus(fx, t2.task.taskId), "BLOCKED", "startModelCall 失败后绝不允许留下 RUNNING 悬挂");
      const steps = fx.taskStore.stepsOfTask(t2.task.taskId);
      assert.equal(steps[steps.length - 1].status, "BLOCKED");
      const runs = runsOf(fx, t2.task.taskId);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].status, "BLOCKED", "run 必须收敛 BLOCKED（既非 RUNNING 也非 SUCCEEDED）");
      assert.equal(runs[0].error_code, "MODEL_CONFIG_CHANGED");
      assert.equal(fx.taskStore.callsOfTask(t2.task.taskId).length, 0, "0 条 model call");
      assert.equal(fx.taskStore.artifactsOfTask(t2.task.taskId).length, 0, "0 Artifact");
      assert.equal(issued2.length >= 1, true, "本窗口内 capability 已按冻结版本签发：" + JSON.stringify(issued2));
      assert.equal(issued2.filter((c) => c.modelConfigVersion !== frozen2).length, 0, "没有任何一次签发使用非冻结版本：" + JSON.stringify(issued2));
    } finally { await orch.dispose(); }
  } finally { await fx.close(); }
});

/* ============================================================ H R-7 签发同一同步点改版 */
/**
 * issueCapability 实参/结果探针：可在**同一同步点内**先做一次真实配置改版再走原函数。
 * 只记录安全字段（期望版本 / 结果码 / 签发版本），绝不接触 token。
 */
function wrapIssueCapability(fx, { onCall = null } = {}) {
  const calls = [];
  const prev = fx.proxy.issueCapability;
  const orig = prev.bind(fx.proxy);
  fx.proxy.issueCapability = (args) => {
    if (onCall) onCall(args);
    const res = orig(args);
    calls.push({
      expectedModelConfigVersion: args ? args.expectedModelConfigVersion : undefined,
      ok: !!(res && res.ok),
      error: res && res.ok === false ? res.error : null,
      expected: res ? res.expected : undefined,
      current: res ? res.current : undefined,
      modelConfigVersion: res && res.ok && res.capability ? res.capability.modelConfigVersion : null,
    });
    return res;
  };
  return { calls, restore: () => { fx.proxy.issueCapability = prev; } };
}
const usableTokens = (fx) => [...fx.proxy.capabilities.values()].filter((c) => c.state === "ISSUED" || c.state === "ACTIVE").length;

test("D4-03 H · R-7：capability 签发同一同步点配置改版 —— 绝不以非冻结版本签发（H2 正对照正常签发）", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "exact" });
  try {
    const cid = fx.modelConfigId;
    const ctx = fx.ctx();

    // H1：checkModelConfig 预检通过之后、issueCapability 生成 token 之前 —— 在同一同步点内真实改版。
    const t1 = fx.taskService.createTask({ context: ctx, goal: "race: issue window rename", modelConfigId: cid });
    const frozen = t1.task.modelConfigVersion;
    const requestsBefore = fx.fp.state.requests;
    const capsBefore = fx.proxy.capabilities.size;
    assert.equal(capsBefore, 0, "前置：本夹具尚未签发任何 capability");
    let bumpedTo = null;
    const h1 = wrapIssueCapability(fx, { onCall: () => { bumpedTo = bumpConfig(fx, cid, "issue-window-rename"); } });
    let r1;
    try {
      r1 = await fx.orchestrator.runTask({ context: ctx, taskId: t1.task.taskId, expectedRevision: t1.task.revision, verify: VERIFY });
    } finally { h1.restore(); }

    assert.equal(bumpedTo, frozen + 1, "前置：改版必须真实发生在 issueCapability 被调用的同一同步点内");
    assert.equal(r1.ok, false, "窗口内改版必须显式拒绝：" + JSON.stringify(r1));
    assert.equal(r1.error, "MODEL_CONFIG_CHANGED", JSON.stringify(r1));
    assert.equal(r1.blocked, true, JSON.stringify(r1));
    assert.equal(h1.calls.length, 1, "恰好一次签发尝试：" + JSON.stringify(h1.calls));
    assert.equal(h1.calls[0].ok, false, "绝不允许以非冻结版本签发成功：" + JSON.stringify(h1.calls));
    assert.equal(h1.calls[0].error, "MODEL_CONFIG_CHANGED", JSON.stringify(h1.calls));
    assert.equal(h1.calls[0].expected, frozen);
    assert.equal(h1.calls[0].current, frozen + 1);
    assert.equal(h1.calls[0].modelConfigVersion, null, "不得返回任何签发版本");
    assert.equal(fx.proxy.capabilities.size, capsBefore, "不得生成任何 capability token");
    assert.equal(usableTokens(fx), 0, "不得存在可用 token");
    assert.equal(h1.calls[0].expectedModelConfigVersion, frozen, "签发必须透传任务冻结版本：" + JSON.stringify(h1.calls));

    assert.equal(taskStatus(fx, t1.task.taskId), "BLOCKED", "Task 必须收敛 BLOCKED");
    const steps1 = fx.taskStore.stepsOfTask(t1.task.taskId);
    assert.equal(steps1.length, 1);
    assert.equal(steps1[0].status, "BLOCKED", "Step 必须收敛 BLOCKED");
    const runs1 = runsOf(fx, t1.task.taskId);
    assert.equal(runs1.length, 1);
    assert.equal(runs1[0].status, "BLOCKED", "run 绝不悬挂");
    assert.equal(runs1[0].error_code, "MODEL_CONFIG_CHANGED");
    assert.equal(runs1[0].model_config_version, frozen, "run 必须挂冻结版本");
    assert.equal(fx.taskStore.callsOfTask(t1.task.taskId).length, 0, "0 条 model call");
    assert.equal(fx.taskStore.artifactsOfTask(t1.task.taskId).length, 0, "0 Artifact");
    assert.equal(fx.fp.state.requests, requestsBefore, "0 provider 请求");

    // H2 正对照：同一路径、配置未变 → 照旧按冻结版本签发并成功收敛。
    const t2 = fx.taskService.createTask({ context: ctx, goal: "return exactly: " + EXACT, modelConfigId: cid });
    const frozen2 = t2.task.modelConfigVersion;
    assert.equal(frozen2, frozen + 1, "前置：新任务绑定当前生效版本");
    const h2 = wrapIssueCapability(fx);
    let r2;
    try {
      r2 = await fx.orchestrator.runTask({ context: ctx, taskId: t2.task.taskId, expectedRevision: t2.task.revision, verify: VERIFY });
    } finally { h2.restore(); }
    assert.equal(r2.ok, true, "配置未变时同一路径必须成功：" + JSON.stringify(r2));
    assert.equal(taskStatus(fx, t2.task.taskId), "SUCCEEDED");
    assert.equal(h2.calls.length, 1, JSON.stringify(h2.calls));
    assert.equal(h2.calls[0].expectedModelConfigVersion, frozen2, "透传冻结版本：" + JSON.stringify(h2.calls));
    assert.equal(h2.calls[0].ok, true, JSON.stringify(h2.calls));
    assert.equal(h2.calls[0].modelConfigVersion, frozen2, "签发必须使用冻结版本");
    assert.equal(fx.fp.state.requests, requestsBefore + 1, "恰好一次 provider 请求");

    // H0 Model Proxy 级契约：期望版本不等 → 不签发、不建 token；相等 / 未传（默认 null）保持既有行为。
    const capsAfterH2 = fx.proxy.capabilities.size;
    const stale = fx.proxy.issueCapability({ context: ctx, configId: cid, allowedCapabilities: ["chat"], maxCalls: 1, ttlMs: 60000, expectedModelConfigVersion: frozen2 - 1 });
    assert.equal(stale.ok, false, JSON.stringify(stale));
    assert.equal(stale.error, "MODEL_CONFIG_CHANGED");
    assert.equal(stale.expected, frozen2 - 1);
    assert.equal(stale.current, frozen2);
    assert.equal(fx.proxy.capabilities.size, capsAfterH2, "不签发就绝不生成 token");
    const same = fx.proxy.issueCapability({ context: ctx, configId: cid, allowedCapabilities: ["chat"], maxCalls: 1, ttlMs: 60000, expectedModelConfigVersion: frozen2 });
    assert.equal(same.ok, true, JSON.stringify(same));
    assert.equal(same.capability.modelConfigVersion, frozen2);
    const noExpectation = fx.proxy.issueCapability({ context: ctx, configId: cid, allowedCapabilities: ["chat"], maxCalls: 1, ttlMs: 60000 });
    assert.equal(noExpectation.ok, true, "未传期望版本的既有调用方行为必须不变：" + JSON.stringify(noExpectation));
    assert.equal(noExpectation.capability.modelConfigVersion, frozen2);
  } finally { await fx.close(); }
});

/* ============================================================ I R-9 绑定后被禁用 */
test("D4-03 I · R-9：绑定后禁用 config → MODEL_CONFIG_UNAVAILABLE 全量 BLOCKED / 0 capability / 0 provider；恢复后可再跑", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "exact" });
  try {
    const cid = fx.modelConfigId;
    const ctx = fx.ctx();
    // 基线：真实跑成功一次（append 资格依赖 SUCCEEDED）
    const t = fx.taskService.createTask({ context: ctx, goal: "return exactly: " + EXACT, modelConfigId: cid });
    const frozen = t.task.modelConfigVersion;
    await runToSucceeded(fx, t.task.taskId);
    // 另一个已冻结、尚未跑过的任务：覆盖「新 run」入口
    const tNew = fx.taskService.createTask({ context: ctx, goal: "disabled before first run", modelConfigId: cid });
    assert.equal(tNew.task.modelConfigVersion, frozen);

    const rowsBefore = rowsOf(fx, t.task.taskId);
    const requestsBefore = fx.fp.state.requests;
    const capsBefore = fx.proxy.capabilities.size;
    const issued = spyIssueCapability(fx);

    // 真实 modelService 命令：禁用（不是改版）
    const disabled = fx.f.modelService.setModelStatus({ context: ctx, configId: cid, status: "disabled" });
    assert.equal(disabled.ok, true, JSON.stringify(disabled));
    assert.equal(disabled.model.status, "disabled");
    assert.equal(fx.f.modelService.resolveModel({ context: ctx, configId: cid }).error, "MODEL_CONFIG_UNAVAILABLE", "前置：禁用后解析必须显式不可用");

    // I1 · append 入口
    const appended = await fx.orchestrator.appendStep({ context: ctx, taskId: t.task.taskId, goal: "disabled append", expectedRevision: fx.taskStore.taskById(t.task.taskId).revision, verify: VERIFY });
    assert.equal(appended.ok, false, JSON.stringify(appended));
    assert.equal(appended.error, "MODEL_CONFIG_UNAVAILABLE", JSON.stringify(appended));
    assert.notEqual(appended.error, "HARNESS_NOT_STARTED", "对外原因码不得退化成 HARNESS_NOT_STARTED");
    assert.equal(appended.blocked, true, JSON.stringify(appended));

    // I2 · 新 run 入口
    const ran = await fx.orchestrator.runTask({ context: ctx, taskId: tNew.task.taskId, expectedRevision: tNew.task.revision, verify: VERIFY });
    assert.equal(ran.ok, false, JSON.stringify(ran));
    assert.equal(ran.error, "MODEL_CONFIG_UNAVAILABLE", JSON.stringify(ran));
    assert.notEqual(ran.error, "HARNESS_NOT_STARTED", "对外原因码不得退化成 HARNESS_NOT_STARTED");
    assert.equal(ran.blocked, true, JSON.stringify(ran));

    // 全量 BLOCKED
    assert.equal(taskStatus(fx, t.task.taskId), "BLOCKED");
    const steps = fx.taskStore.stepsOfTask(t.task.taskId);
    assert.equal(steps.length, 2, "只新增一个 step");
    assert.equal(steps[1].status, "BLOCKED");
    const runs = runsOf(fx, t.task.taskId);
    assert.equal(runs.length, 2);
    assert.equal(runs[1].status, "BLOCKED", "run 绝不悬挂");
    assert.equal(runs[1].error_code, "MODEL_CONFIG_UNAVAILABLE");
    assert.equal(runs[1].model_config_version, frozen);
    assert.equal(taskStatus(fx, tNew.task.taskId), "BLOCKED");
    const stepsNew = fx.taskStore.stepsOfTask(tNew.task.taskId);
    assert.equal(stepsNew[0].status, "BLOCKED");
    const runsNew = runsOf(fx, tNew.task.taskId);
    assert.equal(runsNew.length, 1);
    assert.equal(runsNew[0].status, "BLOCKED");
    assert.equal(runsNew[0].error_code, "MODEL_CONFIG_UNAVAILABLE");
    assert.equal(runsNew[0].model_config_version, frozen);

    // 0 capability / 0 provider 请求 / 0 新执行 / 旧产物逐字段不变
    const after = rowsOf(fx, t.task.taskId);
    assert.equal(after.calls.length, 1, "0 条新 model call");
    assert.equal(fx.taskStore.callsOfTask(tNew.task.taskId).length, 0, "0 条 model call");
    assert.equal(after.artifacts.length, 1, "0 新 Artifact");
    assert.equal(fx.taskStore.artifactsOfTask(tNew.task.taskId).length, 0, "0 新 Artifact");
    assert.deepEqual(after.artifacts, rowsBefore.artifacts, "旧 artifact 行逐字段不变");
    assert.deepEqual(after.verifications, rowsBefore.verifications, "旧 verification 行逐字段不变");
    assert.equal(after.calls[0], rowsBefore.calls[0], "旧 call 行逐字段不变");
    assert.equal(fx.fp.state.requests, requestsBefore, "0 provider 请求");
    assert.equal(issued.length, 0, "0 capability 签发：" + JSON.stringify(issued));
    assert.equal(fx.proxy.capabilities.size, capsBefore, "不得新增 capability 记录");
    assert.equal(usableTokens(fx), 0, "不得存在可用 token");
    assert.equal(eventsOfType(fx, t.task.taskId, "task.succeeded").length, 1, "阻断不得追加 task.succeeded");

    // 恢复启用（真实命令）→ 同一 config 可正常跑成功；已冻结 BLOCKED 任务绝不静默换版本
    const reenabled = fx.f.modelService.setModelStatus({ context: ctx, configId: cid, status: "enabled" });
    assert.equal(reenabled.ok, true, JSON.stringify(reenabled));
    assert.equal(reenabled.model.status, "enabled");
    assert.equal(reenabled.model.version, frozen + 2, "禁用 + 恢复各 bump 一次 version");
    assert.equal(fx.f.modelService.resolveModel({ context: ctx, configId: cid }).ok, true, "恢复后解析必须可用");
    const t3 = fx.taskService.createTask({ context: ctx, goal: "return exactly: " + EXACT, modelConfigId: cid });
    assert.equal(t3.task.modelConfigVersion, frozen + 2, "新任务绑定恢复后的当前版本");
    await runToSucceeded(fx, t3.task.taskId);
    assert.equal(taskStatus(fx, t.task.taskId), "BLOCKED", "旧任务保持 BLOCKED，绝不被静默复活");
  } finally { await fx.close(); }
});

/* ============================================================ J 正对照（expected=null） */
test("D4-03 J · 正对照：未绑定旧任务（expected=null）capability 签发路径与既有行为逐项不变", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "exact" });
  try {
    const cid = fx.modelConfigId;
    setChatDefault(fx, cid);
    const ctx = fx.ctx();
    // J1：解析得出默认配置 → 懒绑定一次，之后透传的仍是任务冻结版本，run 正常成功
    const t = fx.taskService.createTask({ context: ctx, goal: "return exactly: " + EXACT });
    assert.equal(t.task.modelConfigVersion, null, "前置：旧任务未绑定");
    const probe = wrapIssueCapability(fx);
    let r;
    try {
      r = await fx.orchestrator.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, verify: VERIFY });
    } finally { probe.restore(); }
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(taskStatus(fx, t.task.taskId), "SUCCEEDED");
    assert.equal(fx.taskStore.taskById(t.task.taskId).model_config_version, 1, "懒绑定到当前生效版本");
    assert.equal(probe.calls.length, 1, JSON.stringify(probe.calls));
    assert.equal(probe.calls[0].expectedModelConfigVersion, 1, "懒绑定的冻结版本照旧透传：" + JSON.stringify(probe.calls));
    assert.equal(probe.calls[0].ok, true, JSON.stringify(probe.calls));
    assert.equal(probe.calls[0].modelConfigVersion, 1);

    // J0：其它调用方（不传 expectedModelConfigVersion → 默认 null）行为不变：改版后照旧签发
    assert.equal(bumpConfig(fx, cid, "j0-rename"), 2);
    const legacy = fx.proxy.issueCapability({ context: ctx, configId: cid, allowedCapabilities: ["chat"], maxCalls: 1, ttlMs: 60000 });
    assert.equal(legacy.ok, true, "未传期望版本的既有调用方必须照旧签发：" + JSON.stringify(legacy));
    assert.equal(legacy.capability.modelConfigVersion, 2);
  } finally { await fx.close(); }

  // J2（R-8）：解析不出默认配置的未绑定旧任务根本走不到 capability 签发 —— 0 次签发尝试，
  // 原因码是 MODEL_CONFIG_UNAVAILABLE（不再退化成 HARNESS_NOT_STARTED），step/task 收敛 BLOCKED。
  const fx2 = await createToolHarnessFixture({ withAdapters: true, behavior: "exact" });
  try {
    const ctx = fx2.ctx();
    assert.equal(fx2.f.modelService.resolveModel({ context: ctx, capability: "chat" }).ok, false, "前置：无可用默认配置");
    const t2 = fx2.taskService.createTask({ context: ctx, goal: "legacy unbound, no default" });
    const requestsBefore = fx2.fp.state.requests;
    const capsBefore = fx2.proxy.capabilities.size;
    const probe = wrapIssueCapability(fx2);
    let r2;
    try {
      r2 = await fx2.orchestrator.runTask({ context: ctx, taskId: t2.task.taskId, expectedRevision: t2.task.revision, verify: VERIFY });
    } finally { probe.restore(); }
    assert.equal(r2.ok, false, JSON.stringify(r2));
    assert.equal(r2.error, "MODEL_CONFIG_UNAVAILABLE", JSON.stringify(r2));
    assert.notEqual(r2.error, "HARNESS_NOT_STARTED", "对外原因码不得退化成 HARNESS_NOT_STARTED");
    assert.equal(r2.blocked, true, JSON.stringify(r2));
    assert.equal(probe.calls.length, 0, "没建 run 就绝不允许走到 capability 签发：" + JSON.stringify(probe.calls));
    assert.equal(runsOf(fx2, t2.task.taskId).length, 0, "0 条 harness run");
    assert.equal(taskStatus(fx2, t2.task.taskId), "BLOCKED");
    assert.equal(fx2.taskStore.stepsOfTask(t2.task.taskId)[0].status, "BLOCKED", "Step 绝不悬挂在 RUNNING");
    assert.equal(fx2.taskStore.taskById(t2.task.taskId).model_config_id, null, "绝不静默选一个 config 跑");
    assert.equal(fx2.taskStore.callsOfTask(t2.task.taskId).length, 0, "0 条 model call");
    assert.equal(fx2.fp.state.requests, requestsBefore, "0 provider 请求");
    assert.equal(fx2.proxy.capabilities.size, capsBefore, "解析失败不得生成 token");
  } finally { await fx2.close(); }
});

/* ============================================================ K R-8 未绑定不得启动执行 */

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
/** R-8 唯一例外（test-only 桩装配）：没有真实模型服务，因此不参与懒绑定解析。 */
const bareService = (fx) => new TaskService({ identity: fx.f.identity, authService: fx.f.authService, authStore: fx.f.store, taskStore: fx.taskStore, clock: fx.f.clock });
/** 历史行逐字段快照：规范化后比较，任何回填/改写都会立刻暴露。 */
const historyRows = (fx, taskId) => ({
  runs: fx.taskStore.harnessRunsOfTask(taskId).map((r) => JSON.stringify(r)),
  calls: fx.taskStore.callsOfTask(taskId).map((r) => JSON.stringify(r)),
  artifacts: fx.taskStore.artifactsOfTask(taskId).map((r) => JSON.stringify(r)),
  verifications: fx.taskStore.verificationsOfTask(taskId).map((r) => JSON.stringify(r)),
});
/** 一次入口调用前后的"执行面"计数：run/call/artifact/verification/tool 执行/工具提案/provider 请求/capability。 */
const execSurface = (fx, taskId) => ({
  runs: fx.taskStore.harnessRunsOfTask(taskId).length,
  calls: fx.taskStore.callsOfTask(taskId).length,
  artifacts: fx.taskStore.artifactsOfTask(taskId).length,
  verifications: fx.taskStore.verificationsOfTask(taskId).length,
  toolExecutions: fx.toolStore.executionsOfTask(taskId).length,
  toolProposals: fx.toolStore.proposalsOfTask(taskId).length,
  requests: fx.fp.state.requests,
  capabilities: fx.proxy.capabilities.size,
  tokens: [...fx.proxy.capabilities.keys()],
});
const assertNoExecution = (fx, taskId, before, label) => {
  assert.deepEqual(execSurface(fx, taskId), before, label + "：run/call/artifact/verification/tool 执行/provider 请求/capability 必须逐项不变");
};
const assertConvergedBlocked = (fx, taskId, label) => {
  assert.equal(taskStatus(fx, taskId), "BLOCKED", label + "：Task 必须收敛 BLOCKED（绝不 RUNNING 悬挂）");
  const steps = fx.taskStore.stepsOfTask(taskId);
  assert.equal(steps[steps.length - 1].status, "BLOCKED", label + "：最新 Step 必须收敛 BLOCKED");
  for (const s of steps) assert.notEqual(s.status, "RUNNING", label + "：绝不允许悬挂在 RUNNING 的 step");
  for (const r of runsOf(fx, taskId)) assert.equal(["STARTING", "RUNNING"].includes(r.status), false, label + "：绝不允许悬挂的 run：" + r.status);
};
/** 未绑定模型调用的 spy：只记录是否有任何一次 capability 签发真正落地。 */
const spyToolUsage = (fx) => {
  const used = [];
  for (const m of ["propose", "executeReadOnly"]) {
    const orig = fx.toolProxy[m].bind(fx.toolProxy);
    fx.toolProxy[m] = (args) => { used.push(m); return orig(args); };
  }
  return used;
};

/**
 * R-8 场景：绑定能力上线之前创建的旧任务 —— 未绑定的 task + 真实跑过的 run/call/artifact 历史。
 * 历史行全部经任务域命令构造：未绑定 run 只能由契约允许的 test-only 桩装配（modelService=null）建出，
 * 不直写 DB、不手工伪造终态。账本必须先于历史建立（TaskService 只在任务首次被触碰时建基线），
 * 否则历史 run 会把任务判成 legacy → remaining=0 → 既有预算守卫先于本用例要验证的
 * "未绑定不得启动"命中（预算守卫是既有语义，不在本次契约范围）。
 */
function legacyUnboundTask(fx, goal) {
  const ctx = fx.ctx();
  const bare = bareService(fx);
  const created = fx.taskService.createTask({ context: ctx, goal });
  const taskId = created.task.taskId;
  fx.taskService.getTaskBudget({ context: ctx, taskId });
  const started = bare.startTask({ context: ctx, taskId, expectedRevision: created.task.revision });
  const step = bare.createStep({ context: ctx, taskId, kind: "reasoning", input: null, expectedRevision: started.task.revision });
  const stepStarted = bare.startStep({ context: ctx, taskId, stepId: step.step.stepId, expectedRevision: step.task.revision });
  const run = bare.startHarnessRun({ context: ctx, taskId, stepId: step.step.stepId, expectedRevision: stepStarted.task.revision });
  assert.equal(run.ok, true, "桩装配必须照旧建 run（契约例外）：" + JSON.stringify(run));
  assert.equal(run.run.modelConfigId, null, "历史 run 行必须保持未绑定");
  const running = bare.markHarnessRunRunning({ context: ctx, taskId, runId: run.run.runId, expectedRevision: run.task.revision });
  assert.equal(running.ok, true, JSON.stringify(running));
  const call = bare.startModelCall({ context: ctx, taskId, stepId: step.step.stepId, requestId: "mreq_" + run.run.runId, expectedRevision: running.task.revision });
  assert.equal(call.ok, true, JSON.stringify(call));
  assert.equal(call.call.modelConfigId, null, "历史 call 行必须保持未绑定");
  const callDone = bare.completeModelCall({ context: ctx, taskId, callId: call.call.callId, usage: { totalTokens: 7 }, requestId: "mreq_" + run.run.runId, expectedRevision: call.task.revision });
  assert.equal(callDone.ok, true, JSON.stringify(callDone));
  const committed = fx.taskService.commitStepSuccess({
    context: ctx, taskId, stepId: step.step.stepId, runId: run.run.runId,
    artifact: { type: "text", content: "legacy-unbound-artifact" },
    verification: { type: "EXACT_TEXT", status: "PASS" },
    expectedRevision: callDone.task.revision,
  });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal(taskStatus(fx, taskId), "SUCCEEDED", "前置：旧任务历史必须真实收敛 SUCCEEDED");
  const runDone = bare.completeHarnessRun({ context: ctx, taskId, runId: run.run.runId, stopReason: "end_turn", expectedRevision: committed.task.revision });
  assert.equal(runDone.ok, true, JSON.stringify(runDone));
  return { ctx, taskId, stepId: step.step.stepId, runId: run.run.runId, callId: call.call.callId };
}

test("D4-03 K · R-8：未绑定旧任务 + 无可用默认配置 —— 四条真实入口明确 MODEL_CONFIG_UNAVAILABLE；0 run/0 capability/0 call/0 请求/0 工具执行/0 artifact；Step/Task 收敛 BLOCKED", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "exact" });
  try {
    const ctx = fx.ctx();
    assert.equal(fx.f.modelService.resolveModel({ context: ctx, capability: "chat" }).ok, false, "前置：不得存在可用默认配置");
    const issued = spyIssueCapability(fx);
    const toolUsed = spyToolUsage(fx);
    const capsBefore = fx.proxy.capabilities.size;

    // K0 · 真实产品入口 task/run：同一前提下明确拒绝且绝不建任务（未绑定任务不可能从这里产生）
    const ipc = installIpc(fx, fx.orchestrator);
    const tasksBefore = fx.taskStore.allTasks().length;
    const ipcRes = await ipc.command({}, { type: "task/run", goal: "没有默认模型也必须明确失败" });
    assert.equal(ipcRes.ok, false, JSON.stringify(ipcRes));
    assert.equal(ipcRes.error, "MODEL_CONFIG_UNAVAILABLE", JSON.stringify(ipcRes));
    assert.equal(fx.taskStore.allTasks().length, tasksBefore, "task/run 解析失败绝不建任务");

    const orch = fx.makeToolOrchestrator();
    try {
      // K1 · orchestrator.runTask
      const k1 = fx.taskService.createTask({ context: ctx, goal: "legacy unbound / runTask" });
      assert.equal(k1.task.modelConfigId, null, "前置：旧任务未绑定");
      const before1 = execSurface(fx, k1.task.taskId);
      const r1 = await orch.runTask({ context: ctx, taskId: k1.task.taskId, expectedRevision: k1.task.revision, verify: VERIFY });
      assert.equal(r1.ok, false, JSON.stringify(r1));
      assert.equal(r1.error, "MODEL_CONFIG_UNAVAILABLE", JSON.stringify(r1));
      assert.equal(r1.blocked, true, JSON.stringify(r1));
      assertNoExecution(fx, k1.task.taskId, before1, "K1");
      assertConvergedBlocked(fx, k1.task.taskId, "K1");
      assert.equal(fx.taskStore.taskById(k1.task.taskId).model_config_id, null, "K1：任务必须保持未绑定");
      assert.equal(eventsOfType(fx, k1.task.taskId, "task.model_config_bound").length, 0, "K1：解析失败不得伪造绑定事件");

      // K2 · appendStepCommand（真实"追加下一步"在途入口）
      const k2 = legacyUnboundTask(fx, "legacy unbound / appendStep");
      assert.equal(fx.taskService.getAppendEligibility({ context: ctx, taskId: k2.taskId }).appendable, true, "前置：必须是可追加的旧任务");
      const before2 = execSurface(fx, k2.taskId);
      const cmd = orch.appendStepCommand({ context: ctx, taskId: k2.taskId, goal: "追加一步", expectedRevision: fx.taskStore.taskById(k2.taskId).revision, verify: VERIFY });
      assert.equal(cmd.ok, true, "入口同步接收（拒绝只可能来自 run 侧）：" + JSON.stringify(cmd));
      const r2 = await cmd.running;
      assert.equal(r2.ok, false, JSON.stringify(r2));
      assert.equal(r2.error, "MODEL_CONFIG_UNAVAILABLE", JSON.stringify(r2));
      assert.equal(r2.blocked, true, JSON.stringify(r2));
      assertNoExecution(fx, k2.taskId, before2, "K2");
      assertConvergedBlocked(fx, k2.taskId, "K2");
      assert.equal(fx.taskStore.taskById(k2.taskId).model_config_id, null, "K2：任务必须保持未绑定");
      assert.equal(eventsOfType(fx, k2.taskId, "task.model_config_bound").length, 0, "K2：解析失败不得伪造绑定事件");

      // K3 · resumeBudgetExhausted（真实预算停止后的显式续接入口）
      const k3 = legacyUnboundTask(fx, "legacy unbound / resume");
      // 续接只允许追加"当前真实阻塞 kind"：先经 run 结束计量入口把 MODEL_CALLS 真实耗尽。
      const consumed = fx.taskService.recordBudgetConsumption({ context: ctx, taskId: k3.taskId, consumption: { MODEL_CALLS: 8 } });
      assert.equal(consumed.ok, true, JSON.stringify(consumed));
      assert.equal(consumed.remaining.MODEL_CALLS, 0, "前置：MODEL_CALLS 必须已用尽");
      const appended = fx.taskService.appendStep({ context: ctx, taskId: k3.taskId, goal: "预算停止", expectedRevision: fx.taskStore.taskById(k3.taskId).revision });
      assert.equal(appended.ok, true, JSON.stringify(appended));
      const stepStarted = fx.taskService.startStep({ context: ctx, taskId: k3.taskId, stepId: appended.step.stepId, expectedRevision: appended.task.revision });
      assert.equal(stepStarted.ok, true, JSON.stringify(stepStarted));
      const stopped = fx.taskService.blockStep({ context: ctx, taskId: k3.taskId, stepId: appended.step.stepId, reason: "BUDGET_EXHAUSTED", event: "task.budget_exhausted", payload: { kind: "MODEL_CALLS", remaining: 0 }, expectedRevision: stepStarted.task.revision });
      assert.equal(stopped.ok, true, JSON.stringify(stopped));
      const elig = fx.taskService.getResumeEligibility({ context: ctx, taskId: k3.taskId });
      assert.equal(elig.resumable, true, "前置：必须可显式续接：" + JSON.stringify(elig));
      const before3 = execSurface(fx, k3.taskId);
      const r3 = await orch.resumeBudgetExhausted({ context: ctx, taskId: k3.taskId, expectedRevision: fx.taskStore.taskById(k3.taskId).revision, verify: VERIFY });
      assert.equal(r3.ok, false, JSON.stringify(r3));
      assert.equal(r3.error, "MODEL_CONFIG_UNAVAILABLE", JSON.stringify(r3));
      assert.equal(r3.blocked, true, JSON.stringify(r3));
      assertNoExecution(fx, k3.taskId, before3, "K3");
      assertConvergedBlocked(fx, k3.taskId, "K3");
      assert.equal(fx.taskStore.taskById(k3.taskId).model_config_id, null, "K3：任务必须保持未绑定");
    } finally { await orch.dispose(); }

    // 全局：0 capability 签发 / 0 tool 执行 / 0 provider 请求
    assert.equal(issued.length, 0, "0 capability 签发：" + JSON.stringify(issued));
    assert.equal(fx.proxy.capabilities.size, capsBefore, "不得新增 capability 记录");
    assert.deepEqual(toolUsed, [], "0 tool propose/execute");
    assert.equal(fx.fp.state.requests, 0, "0 provider 请求");
    assert.equal(fx.taskStore.allTasks().length, tasksBefore + 3, "四条入口加起来只留下 3 条旧任务（task/run 一条都没建）");
  } finally { await fx.close(); }
});

test("D4-03 L · R-8：默认配置稍后出现 —— 下一次显式运行重新解析并绑定（绑定事件 + run/call 归属 == 绑定值）并真实成功；绝不沿用未绑定的旧 run", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "exact" });
  try {
    const ctx = fx.ctx();
    const t = fx.taskService.createTask({ context: ctx, goal: "return exactly: " + EXACT });
    // 第一次显式运行：无默认配置 → 明确失败，且绝不留任何 run（修复前会留下一条未绑定的 run）
    const r1 = await fx.orchestrator.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, verify: VERIFY });
    assert.equal(r1.ok, false, JSON.stringify(r1));
    assert.equal(r1.error, "MODEL_CONFIG_UNAVAILABLE", JSON.stringify(r1));
    assert.equal(runsOf(fx, t.task.taskId).length, 0, "失败绝不留未绑定的 run");
    assert.equal(fx.taskStore.callsOfTask(t.task.taskId).length, 0, "失败绝不留 model call");
    assert.equal(fx.taskStore.taskById(t.task.taskId).model_config_id, null, "失败后仍然未绑定");
    assert.equal(eventsOfType(fx, t.task.taskId, "task.model_config_bound").length, 0);

    // 默认配置稍后出现（真实命令）
    const cid = fx.modelConfigId;
    setChatDefault(fx, cid);
    const resolved = fx.f.modelService.resolveModel({ context: ctx, capability: "chat" });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    assert.equal(resolved.snapshot.modelConfigId, cid);

    const requestsBefore = fx.fp.state.requests;
    const issued = spyIssueCapability(fx);
    const r2 = await fx.orchestrator.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: fx.taskStore.taskById(t.task.taskId).revision, verify: VERIFY });
    assert.equal(r2.ok, true, "默认出现后的显式运行必须真实成功：" + JSON.stringify(r2));
    assert.equal(taskStatus(fx, t.task.taskId), "SUCCEEDED");

    const row = fx.taskStore.taskById(t.task.taskId);
    assert.equal(row.model_config_id, cid, "懒绑定到当前生效配置");
    assert.equal(row.model_config_version, resolved.snapshot.modelConfigVersion);
    const bound = eventsOfType(fx, t.task.taskId, "task.model_config_bound");
    assert.equal(bound.length, 1, "恰好一条绑定事件（只绑定一次）");
    assert.deepEqual(JSON.parse(bound[0].safe_payload), { modelConfigId: cid, modelConfigVersion: resolved.snapshot.modelConfigVersion, source: "PERSONAL_DEFAULT", reason: "LEGACY_UNBOUND_LAZY_BIND" });
    const runs = runsOf(fx, t.task.taskId);
    assert.equal(runs.length, 1, "恰好一个 run —— 绝不是失败时留下的未绑定 run");
    assert.equal(runs[0].model_config_id, cid, "run 归属必须是绑定值");
    assert.equal(runs[0].model_config_version, resolved.snapshot.modelConfigVersion);
    const calls = fx.taskStore.callsOfTask(t.task.taskId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model_config_id, cid, "call 归属必须是绑定值");
    assert.equal(calls[0].model_config_version, resolved.snapshot.modelConfigVersion);
    assert.equal(fx.taskStore.artifactsOfTask(t.task.taskId).length, 1, "真实成功产出 artifact");
    assert.equal(fx.taskStore.verificationsOfTask(t.task.taskId).length, 1);
    assert.equal(fx.fp.state.requests, requestsBefore + 1, "恰好一次真实 provider 请求");
    assert.equal(issued.length, 1, JSON.stringify(issued));
    assert.equal(issued[0].modelConfigId, cid);
    assert.equal(issued[0].modelConfigVersion, resolved.snapshot.modelConfigVersion, "capability 必须以绑定值签发");
  } finally { await fx.close(); }
});

test("D4-03 M · R-8/并发：同一未绑定旧任务上的两个并发 run 只形成一种绑定（受控同步点，无 sleep 竞猜）；所有 run/call 归属一致，绝无第二配置", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "exact" });
  try {
    const ctx = fx.ctx();
    const cid1 = fx.modelConfigId;
    setChatDefault(fx, cid1);
    const cid2 = newConfig(fx, "remote-fake-race-2");

    // 未绑定旧任务 + 两个 RUNNING step（两个并发 run 各自的 step）
    const t = fx.taskService.createTask({ context: ctx, goal: "return exactly: " + EXACT });
    const started = fx.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const s1 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: started.task.revision });
    const s2 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: s1.task.revision });
    const ss1 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: s2.task.revision });
    assert.equal(ss1.ok, true, JSON.stringify(ss1));
    const ss2 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s2.step.stepId, expectedRevision: ss1.task.revision });
    assert.equal(ss2.ok, true, JSON.stringify(ss2));
    const taskId = t.task.taskId;

    // 懒绑定解析 spy：只统计"无 configId 的 chat 解析"（= 懒绑定），绝不接触 token。
    const lazyResolves = [];
    const origResolve = fx.f.modelService.resolveModel.bind(fx.f.modelService);
    fx.f.modelService.resolveModel = (args = {}) => { if (args.capability === "chat" && args.configId == null) lazyResolves.push(args.capability); return origResolve(args); };

    // 受控同步点：run A 的第一个 adapter.start 停在闸门上 —— 它必然发生在 startHarnessRun（懒绑定 + 建 run A）之后；
    // B 的启动只由"A 已进闸"这一事实触发，闸门直到绑定一致性断言全部结束才释放，因此 B 的判定完全确定、无 sleep 竞猜。
    const enteredA = deferred();
    const gate = deferred();
    let adapterSeq = 0;
    const factory = () => {
      adapterSeq += 1;
      if (adapterSeq > 1) return fx.realAgentFactory()();
      return {
        start: async () => { enteredA.resolve(); await gate.promise; throw Object.assign(new Error("M gate"), { code: "HARNESS_NOT_STARTED" }); },
        prompt: async () => ({ events: [], text: "" }), cancel: async () => { },
        dispose: async () => { }, revokeModelCapability() { }, revokeToolCapability() { }, budgetExhausted: () => null,
      };
    };
    const orch = fx.makeOrchestrator(factory);
    try {
      const pA = orch.runStep({ context: ctx, taskId, stepId: s1.step.stepId, expectedRevision: ss1.task.revision, stepInput: s1.step.input, verify: VERIFY });
      await enteredA.promise;
      // A 已经在 startHarnessRun 里完成懒绑定并建了 run A（后到者 B 看到的就是这个值）
      assert.equal(fx.taskStore.taskById(taskId).model_config_id, cid1, "A 必须已完成懒绑定");
      assert.equal(runsOf(fx, taskId).length, 1);
      assert.equal(runsOf(fx, taskId)[0].model_config_id, cid1);
      assert.equal(lazyResolves.length, 1, "懒绑定只解析一次：" + JSON.stringify(lazyResolves));

      // 默认切到**另一个** config：后到者绝不能再解析、更不得绑到 cid2
      setChatDefault(fx, cid2);
      // 前置检查绕开 spy：spy 只统计被测代码路径的解析，不统计测试自己的断言查询。
      assert.equal(origResolve({ context: ctx, capability: "chat" }).snapshot.modelConfigId, cid2, "前置：默认已指向第二个 config");

      const pB = orch.runStep({ context: ctx, taskId, stepId: s2.step.stepId, expectedRevision: fx.taskStore.taskById(taskId).revision, stepInput: s2.step.input, verify: VERIFY });
      const rB = await pB;
      assert.equal(rB.ok, true, "并发中的后到者必须照旧真实跑成功：" + JSON.stringify(rB));

      const row = fx.taskStore.taskById(taskId);
      assert.equal(row.model_config_id, cid1, "任务只绑定一种配置");
      assert.equal(row.model_config_version, 1);
      const runs = runsOf(fx, taskId);
      assert.equal(runs.length, 2, "两个并发 run 各一条 run 行");
      for (const run of runs) {
        assert.equal(run.model_config_id, cid1, "所有 run 行归属同一绑定值");
        assert.equal(run.model_config_version, 1);
        assert.notEqual(run.model_config_id, cid2, "绝不允许第二个 run 分裂到另一配置");
      }
      for (const call of fx.taskStore.callsOfTask(taskId)) {
        assert.equal(call.model_config_id, cid1, "所有 call 行归属同一绑定值");
        assert.equal(call.model_config_version, 1);
        assert.notEqual(call.model_config_id, cid2, "绝不允许 call 行分裂到另一配置");
      }
      assert.equal(fx.taskStore.callsOfTask(taskId).length >= 1, true, "B 的真实推理必须留下一条 call 行");
      const bound = eventsOfType(fx, taskId, "task.model_config_bound");
      assert.equal(bound.length, 1, "只形成一次绑定：" + JSON.stringify(bound));
      assert.equal(JSON.parse(bound[0].safe_payload).modelConfigId, cid1);
      assert.equal(lazyResolves.length, 1, "后到者绝不重新解析（事务串行化后看到前者已绑定的值）：" + JSON.stringify(lazyResolves));
      assert.equal(adapterSeq, 2, "两个并发 run 各自独立装配 adapter");

      // 释放 A：它只会按既有语义收敛（不参与绑定一致性判定），随后仍必须保持"全量归属 cid1"。
      gate.resolve();
      await pA;
      for (const run of runsOf(fx, taskId)) assert.equal(run.model_config_id, cid1, "收尾后 run 归属仍然一致");
      for (const call of fx.taskStore.callsOfTask(taskId)) assert.equal(call.model_config_id, cid1, "收尾后 call 归属仍然一致");
    } finally { await orch.dispose(); }
  } finally { await fx.close(); }
});

test("D4-03 N · R-8：历史保留 —— 未绑定的历史 run/call 行逐字段不变、绝不回填；绑定之后的新 run 才用绑定值", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "exact" });
  try {
    const ctx = fx.ctx();
    const legacy = legacyUnboundTask(fx, "legacy unbound history");
    const historyBefore = historyRows(fx, legacy.taskId);
    assert.equal(historyBefore.runs.length, 1);
    assert.equal(historyBefore.calls.length, 1);
    assert.equal(JSON.parse(historyBefore.runs[0]).model_config_id, null, "前置：历史 run 未绑定");
    assert.equal(JSON.parse(historyBefore.calls[0]).model_config_id, null, "前置：历史 call 未绑定");
    assert.equal(fx.taskStore.taskById(legacy.taskId).model_config_id, null, "前置：任务未绑定");

    // N1 · 无默认配置下的直接入口（真实任务域命令）：绝不建 run（修复前会再留一条未绑定 run，快照立刻变化）
    const appended = fx.taskService.appendStep({ context: ctx, taskId: legacy.taskId, goal: "历史保留探针", expectedRevision: fx.taskStore.taskById(legacy.taskId).revision });
    assert.equal(appended.ok, true, "前置：已成功的旧任务只能经 appendStep 进入新 run：" + JSON.stringify(appended));
    const stepStarted = fx.taskService.startStep({ context: ctx, taskId: legacy.taskId, stepId: appended.step.stepId, expectedRevision: appended.task.revision });
    assert.equal(stepStarted.ok, true, JSON.stringify(stepStarted));
    const revoked = fx.taskService.startHarnessRun({ context: ctx, taskId: legacy.taskId, stepId: appended.step.stepId, expectedRevision: stepStarted.task.revision });
    assert.equal(revoked.ok, false, "未绑定且解析不出配置时绝不建 run：" + JSON.stringify(revoked));
    assert.equal(revoked.error, "MODEL_CONFIG_UNAVAILABLE", JSON.stringify(revoked));
    assert.equal(revoked.message, "任务未绑定模型配置，无法启动", JSON.stringify(revoked));
    assert.equal(historyRows(fx, legacy.taskId).runs.length, 1, "历史 run 数量不变");
    assert.deepEqual(historyRows(fx, legacy.taskId), historyBefore, "历史 run/call/artifact/verification 行逐字段不变");
    const blocked = fx.taskService.blockStep({ context: ctx, taskId: legacy.taskId, stepId: appended.step.stepId, reason: "MODEL_CONFIG_UNAVAILABLE", expectedRevision: fx.taskStore.taskById(legacy.taskId).revision });
    assert.equal(blocked.ok, true, JSON.stringify(blocked));

    // N2 · 默认出现后的真实入口：懒绑定 + 真实跑成功；历史行仍然逐字段不变、绝不回填
    const cid = fx.modelConfigId;
    setChatDefault(fx, cid);
    const requestsBefore = fx.fp.state.requests;
    const r2 = await fx.orchestrator.runTask({ context: ctx, taskId: legacy.taskId, expectedRevision: fx.taskStore.taskById(legacy.taskId).revision, verify: VERIFY });
    assert.equal(r2.ok, true, "绑定后必须真实成功：" + JSON.stringify(r2));
    assert.equal(taskStatus(fx, legacy.taskId), "SUCCEEDED");
    assert.equal(fx.fp.state.requests, requestsBefore + 1, "恰好一次真实 provider 请求");

    const after = historyRows(fx, legacy.taskId);
    assert.equal(after.runs.length, 2, "只新增一条绑定之后的 run");
    assert.equal(after.calls.length, 2, "只新增一条绑定之后的 call");
    assert.equal(after.artifacts.length, 2, "只新增一个绑定之后的 artifact");
    assert.equal(after.verifications.length, 2, "只新增一条绑定之后的 verification");
    // 夹具时钟固定：run/call/artifact 按时间戳排序时历史行与新增行先后不稳定 —— 一律按主键定位，绝不靠数组下标。
    const beforeArtifact = JSON.parse(historyBefore.artifacts[0]);
    const beforeVerification = JSON.parse(historyBefore.verifications[0]);
    const afterRuns = after.runs.map((r) => JSON.parse(r));
    const afterCalls = after.calls.map((r) => JSON.parse(r));
    const histRun = afterRuns.find((r) => r.run_id === legacy.runId);
    const histCall = afterCalls.find((c) => c.call_id === legacy.callId);
    const histArtifact = after.artifacts.map((r) => JSON.parse(r)).find((a) => a.artifact_id === beforeArtifact.artifact_id);
    const histVerification = after.verifications.map((r) => JSON.parse(r)).find((v) => v.verification_id === beforeVerification.verification_id);
    assert.equal(JSON.stringify(histRun), historyBefore.runs[0], "历史 run 行逐字段不变");
    assert.equal(JSON.stringify(histCall), historyBefore.calls[0], "历史 call 行逐字段不变");
    assert.equal(JSON.stringify(histArtifact), historyBefore.artifacts[0], "历史 artifact 行逐字段不变");
    assert.equal(JSON.stringify(histVerification), historyBefore.verifications[0], "历史 verification 行逐字段不变");
    assert.equal(histRun.model_config_id, null, "历史 run 的 null 归属绝不被回填");
    assert.equal(histRun.model_config_version, null, "历史 run 的 null version 绝不被回填");
    assert.equal(histCall.model_config_id, null, "历史 call 的 null 归属绝不被回填");
    assert.equal(histCall.model_config_version, null, "历史 call 的 null version 绝不被回填");
    const freshRun = afterRuns.find((r) => r.run_id !== legacy.runId);
    const freshCall = afterCalls.find((c) => c.call_id !== legacy.callId);
    assert.equal(freshRun.model_config_id, cid, "绑定之后的 run 才用绑定值");
    assert.equal(freshRun.model_config_version, 1);
    assert.equal(freshCall.model_config_id, cid, "绑定之后的 call 才用绑定值");
    assert.equal(freshCall.model_config_version, 1);
    assert.equal(fx.taskStore.taskById(legacy.taskId).model_config_id, cid, "任务此时才绑定");
  } finally { await fx.close(); }
});

test("D4-03 O · 正对照：modelService 为 null 的 test-only 桩装配行为与 ad5e600 逐字一致", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "exact" });
  try {
    const ctx = fx.ctx();
    const bare = bareService(fx);
    const t = bare.createTask({ context: ctx, goal: "stub assembly probe" });
    const started = bare.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const step = bare.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: started.task.revision });
    const stepStarted = bare.startStep({ context: ctx, taskId: t.task.taskId, stepId: step.step.stepId, expectedRevision: step.task.revision });
    const revBefore = fx.taskStore.taskById(t.task.taskId).revision;
    const run = bare.startHarnessRun({ context: ctx, taskId: t.task.taskId, stepId: step.step.stepId, expectedRevision: stepStarted.task.revision });
    assert.equal(run.ok, true, "桩装配必须照旧建 run（契约例外）：" + JSON.stringify(run));
    assert.equal(run.run.modelConfigId, null, "桩装配不绑定（与既有行为逐字一致）");
    assert.equal(run.run.modelConfigVersion, null);
    assert.equal(run.run.status, "STARTING");
    assert.equal(run.task.modelConfigId, null);
    assert.equal(run.task.modelConfigVersion, null);
    const row = fx.taskStore.taskById(t.task.taskId);
    assert.equal(row.model_config_id, null);
    assert.equal(row.revision, revBefore + 1, "只保留既有的建 run revision 递增");
    assert.deepEqual(fx.taskStore.eventsOfTask(t.task.taskId).map((e) => e.event_type), ["task.created", "task.started", "step.created", "step.started", "harness.run.started"], "事件序列与 ad5e600 逐字一致");
    assert.deepEqual(Object.keys(JSON.parse(eventsOfType(fx, t.task.taskId, "harness.run.started")[0].safe_payload)).sort(), ["acpVersion", "harnessVersion", "modelConfigId", "modelConfigVersion", "runId", "stepId"]);
    assert.equal(eventsOfType(fx, t.task.taskId, "task.model_config_bound").length, 0, "桩装配不得伪造绑定事件");
    assert.equal(fx.fp.state.requests, 0, "桩装配本身 0 provider 请求");
    assert.equal(fx.proxy.capabilities.size, 0, "桩装配本身 0 capability");
  } finally { await fx.close(); }
});

