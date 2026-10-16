/**
 * B3e · DX OS Agent ReAct 驱动回归测试（全离线）。
 *
 * 覆盖任务书要求：
 *   1) 正常收敛：模型 -> 工具调用 -> 观察回填 -> 再模型 -> finish_task；
 *   2) 工具失败：错误作为观察回填，模型修正后仍能收敛；
 *   3) 取消：任务不再 running 时循环立即 stopped，不继续调用模型；
 *   4) 迭代上限：maxModelCalls 预算耗尽 -> budget_exhausted；
 *   5) 等待用户后再继续：ask_user -> waiting_user -> 回答后恢复 -> 收敛；
 *   6) 未注入适配器：runReactTask 返回结构化 AGENT_DEPENDENCY_UNAVAILABLE；
 *   7) 越界/未知名工具：执行前授权双检拒绝，且不产生工具副作用。
 *
 * 离线保证：模型 / 工具 / 技能 / MCP / 任务状态机 / kernel / runStore / supervisor
 * 全部使用本文件内的假适配器；不触网、不读磁盘、不加载真实 electron 模块。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const driver = require("../electron/agent-react-driver.cjs");

const TASK_ID = "task-1";
const WORKER_ID = "worker-1";
const LEASE = "lease-1";
const ROOT = "root-0";
const USER = "user-1";

class FakeToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

function toolDef(name) {
  return { type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } };
}

function call(id, name, args) {
  return { id, name, arguments: JSON.stringify(args) };
}

function createFakeTaskStore(options = {}) {
  const events = [];
  const steps = [];
  const operations = new Map();
  const turns = [];
  const messages = [];
  const memories = [];
  const counts = { model: 0, tool: 0 };
  const limits = options.budget || { maxModelCalls: 8, maxToolCalls: 20 };
  const runtime = { status: "running", leaseValid: true };
  let seq = 0;
  let stepSeq = 0;
  let turnSeq = 0;

  const task = {
    id: TASK_ID,
    project_id: "project-1",
    thread_id: "thread-1",
    instruction: options.instruction || "写一个测试文件",
    execution_profile: options.execution_profile || "thinking",
    attempt_no: 1,
    parent_task_id: null,
    agent_profile_id: options.agent_profile_id || null,
    preferred_provider_id: null,
    preferred_llm_model: null,
    preferred_image_provider_id: null,
    preferred_image_model: null,
    expected_output_schema: options.expectedOutputSchema || null,
    permission_grant_json: "[]",
    depends_on_json: "[]",
    result: null,
    status: "running",
    plan: null,
  };
  if (options.seedPlanned !== false) {
    events.push({ type: "task.planned", message: "seeded", sequence: ++seq, data_json: null });
  }

  const store = {
    DEFAULT_BUDGET: limits,
    events,
    steps,
    operations,
    turns,
    messages,
    memories,
    counts,
    runtime,
    task,
    appendTaskEvent(taskId, type, message, data) {
      const event = { type, message, sequence: ++seq, data_json: data === undefined ? null : JSON.stringify(data) };
      events.push(event);
      return event;
    },
    getTask() {
      return Object.assign({}, task, { plan: task.plan, steps: steps, events: events });
    },
    taskIsRunning() {
      return runtime.leaseValid && runtime.status === "running";
    },
    consumeBudget(taskId, kind, budget) {
      const key = kind === "model" ? "maxModelCalls" : "maxToolCalls";
      const limit = (budget || limits)[key];
      counts[kind] += 1;
      return limit === null || limit === undefined || counts[kind] <= limit;
    },
    sealStaleReactSteps() {},
    savePlan(taskId, plan) {
      task.plan = plan;
      store.appendTaskEvent(taskId, "task.planned", plan.goal);
    },
    appendDynamicStep(taskId, title, toolName, args, stableOperationId) {
      // 与真实 agent-task-store 一致：返回快照，后续 start/complete 只改库中行；
      // 调用方持有的 step.status 始终保持创建时的值。
      const existing = steps.find((s) => s.operation_id === stableOperationId);
      if (existing) return { id: existing.id, ordinal: existing.ordinal, operation_id: existing.operation_id, status: existing.status };
      const step = {
        id: "step-" + (++stepSeq),
        ordinal: steps.length + 1,
        operation_id: stableOperationId,
        status: "queued",
        title: title,
        tool_name: toolName,
        output_json: null,
      };
      steps.push(step);
      return { id: step.id, ordinal: step.ordinal, operation_id: step.operation_id, status: step.status };
    },
    requeueReactStepForResume(taskId, stepId) {
      const step = steps.find((s) => s.id === stepId);
      if (step) step.status = "queued";
      return Boolean(step);
    },
    startStep(taskId, stepId) {
      const step = steps.find((s) => s.id === stepId);
      if (!step || step.status !== "queued") return false;
      step.status = "running";
      return true;
    },
    completeStep(taskId, stepId, workerId, output) {
      const step = steps.find((s) => s.id === stepId);
      if (!step || step.status !== "running") return false;
      step.status = "completed";
      step.output_json = JSON.stringify(output);
      store.appendTaskEvent(taskId, "step.completed", (output && output.message) || "步骤已完成");
      return true;
    },
    failStep(taskId, stepId, workerId, message) {
      const step = steps.find((s) => s.id === stepId);
      if (!step || step.status !== "running") return false;
      step.status = "failed";
      step.result_summary = message;
      store.appendTaskEvent(taskId, "step.failed", message);
      return true;
    },
    findOperation(operationId) {
      return operations.get(operationId);
    },
    beginOperation(operationId, taskId, toolName) {
      if (operations.has(operationId)) return false;
      operations.set(operationId, { operation_id: operationId, task_id: taskId, tool_name: toolName, status: "running", result_json: null });
      return true;
    },
    finishOperation(operationId, result) {
      const operation = operations.get(operationId);
      if (!operation) return false;
      operation.status = "completed";
      operation.result_json = JSON.stringify(result);
      return true;
    },
    latestResumableAgentTurn() {
      for (let index = turns.length - 1; index >= 0; index -= 1) {
        if (turns[index].status === "responded" || turns[index].status === "processing") return turns[index];
      }
      return undefined;
    },
    persistAgentTurn(input) {
      const turn = {
        id: "turn-" + (++turnSeq),
        iteration: turnSeq,
        status: "responded",
        response_json: JSON.stringify({ content: input.content, toolCalls: input.toolCalls }),
        next_tool_index: 0,
      };
      turns.push(turn);
      return turn;
    },
    advanceAgentTurn(turnId, nextToolIndex) {
      const turn = turns.find((t) => t.id === turnId);
      if (!turn) return false;
      turn.next_tool_index = nextToolIndex;
      turn.status = "processing";
      return true;
    },
    completeAgentTurn(turnId) {
      const turn = turns.find((t) => t.id === turnId);
      if (!turn) return false;
      turn.status = "completed";
      return true;
    },
    waitForUser(taskId, workerId, question) {
      runtime.status = "waiting_user";
      runtime.question = question;
      return true;
    },
    waitForChildren() {
      runtime.status = "waiting_children";
      return true;
    },
    failTaskFenced(taskId, workerId, code, message) {
      runtime.status = "failed";
      runtime.errorCode = code;
      runtime.errorMessage = message;
      store.appendTaskEvent(taskId, "task.failed", message);
      return true;
    },
    postTaskMessage(taskId, role, contentText) {
      messages.push({ role: role, content: contentText });
    },
    threadVisibility() {
      return options.visibility || "project";
    },
    addMemory(input) {
      const memory = Object.assign({ id: "memory-" + (memories.length + 1) }, input);
      memories.push(memory);
      return memory;
    },
    listChildTasks() {
      return options.children || [];
    },
  };
  return store;
}

function createKernelStore() {
  return {
    runs: new Map(),
    events: [],
    findAgentRunByTask(taskId) {
      for (const run of this.runs.values()) if (run.taskId === taskId) return run;
      return undefined;
    },
    createAgentRun(prepared) {
      const run = { id: prepared.trace.runId, taskId: prepared.trace.taskId, status: "created" };
      this.runs.set(run.id, run);
      return run;
    },
    startAgentRun(runId) {
      const run = this.runs.get(runId);
      if (run) run.status = "running";
    },
    appendAgentRunEvent(runId, type, data) {
      this.events.push({ runId: runId, type: type, data: data });
    },
    failAgentRun(runId, error) {
      const run = this.runs.get(runId);
      if (run) { run.status = "failed"; run.error = error; }
    },
    waitAgentRun(runId, question) {
      const run = this.runs.get(runId);
      if (run) { run.status = "waiting_user"; run.question = question; }
    },
  };
}

function createSupervisor(options) {
  return {
    listAgentProfiles: () => (options.profiles ? Object.values(options.profiles) : []),
    getAgentProfile: (id) => (options.profiles && options.profiles[id]) || undefined,
    delegateAgentWork: () => { throw new Error("offline supervisor: delegateAgentWork 未编排"); },
  };
}

function createProviderAdapter(replies, onCall) {
  return {
    requests: [],
    script: replies.slice(),
    firstUsable() {
      return {
        id: "provider-1",
        base_url: "https://offline.invalid",
        api_key: "offline-key",
        protocol: "openai",
        models: [{ model: "fake-llm", caps: ["llm", "llm.tools"] }],
      };
    },
    autoFallback() {
      return false;
    },
    async call(request) {
      this.requests.push({
        messages: structuredClone(request.messages),
        system: request.system,
        tools: structuredClone(request.tools),
        model: request.model,
        providerId: request.providerId,
      });
      if (onCall) onCall(request, this);
      const next = this.script.shift();
      if (next === undefined) throw new Error("offline provider: scripted reply exhausted");
      return typeof next === "function" ? next(request, this) : next;
    },
  };
}

function createToolRunner(toolImpl) {
  return {
    ToolError: FakeToolError,
    calls: [],
    async runTool(name, ctx, args) {
      this.calls.push({ name: name, ctx: ctx, args: args });
      if (toolImpl) return toolImpl(name, args, ctx);
      return { message: "已执行 " + name };
    },
  };
}

function createCapabilityAdapter() {
  return {
    createProgressiveCapabilityToolset(tools) {
      return {
        tools: () => tools,
        isDiscovery: () => false,
        discover: () => ({ activated: [] }),
        applyTargets: () => {},
      };
    },
    discoverCapabilityTargetsForUser: async () => [],
    normalizeCapabilityReferences: (value) => (value && typeof value === "object" ? value : {}),
    normalizeCapabilityRequirements: (value) => (value && typeof value === "object" ? value : {}),
    selectedCapabilityTargets: () => [],
    resolveAgentRoute: () => { throw new Error("offline capability router: 无路由，回退 providerAdapter"); },
  };
}

function createHarness(options = {}) {
  const taskStore = createFakeTaskStore(options);
  const kernelStore = createKernelStore();
  const supervisor = createSupervisor(options);
  const providerAdapter = createProviderAdapter(options.replies || [], options.onCall);
  const toolRunner = createToolRunner(options.toolImpl);
  const mcpAdapter = {
    calls: [],
    async callByName(name, args) {
      this.calls.push({ name: name, args: args });
      return options.mcpResult || "mcp 离线结果";
    },
  };
  const skillAdapter = {
    calls: [],
    async runSkill(name, args) {
      this.calls.push({ name: name, args: args });
      return options.skillResult || { text: "技能离线正文", images: [], videos: [], audios: [] };
    },
  };
  const capabilityAdapter = createCapabilityAdapter();
  const workspaceAdapter = {
    ensureRunWorkspace: () => ({ workspaceRootId: "ws-1" }),
    assertRunWorkspaceWrite: () => {},
    getRunWorkspace: () => null,
    listRunArtifacts: () => [],
    stageRunArtifact: () => {},
    stageRunArtifactNode: () => {},
  };
  const usageAdapter = {
    invocations: [],
    finished: [],
    beginAgentUsage(input) {
      const invocation = { id: "usage-" + (this.invocations.length + 1), kind: input.kind, startedAt: 1000 };
      this.invocations.push(invocation);
      return invocation;
    },
    finishAgentUsage(id, result) {
      this.finished.push({ id: id, status: result.status });
    },
  };
  const schemaValidator = { validateJsonSchema: options.validateJsonSchema || (() => []) };
  const modelFallback = {
    runWithAgentModelFallback: async (input) => {
      let lastError;
      for (let index = 0; index < input.routes.length; index += 1) {
        try {
          return await input.invoke(input.routes[index]);
        } catch (error) {
          lastError = error;
          if (index === input.routes.length - 1) throw error;
        }
      }
      throw lastError;
    },
  };
  const kernel = {
    prepareAgentTurn(input) {
      return {
        trace: {
          runId: input.runId || "run-1",
          correlationId: input.correlationId,
          taskId: input.taskId,
          projectId: input.projectId,
          userId: input.userId,
        },
        route: { tools: options.routeTools || [toolDef("fs_write"), toolDef("fs_read")], toolDescriptors: [] },
        capabilities: [],
        context: [],
        systemPromptAdditions: [],
      };
    },
  };

  driver.resetReactDriverForTests();
  driver.configureReactDriver({
    kernel: kernel,
    kernelStore: kernelStore,
    supervisor: supervisor,
    taskStore: taskStore,
    toolRunner: toolRunner,
    mcpAdapter: mcpAdapter,
    skillAdapter: skillAdapter,
    capabilityAdapter: capabilityAdapter,
    providerAdapter: providerAdapter,
    workspaceAdapter: workspaceAdapter,
    usageAdapter: usageAdapter,
    schemaValidator: schemaValidator,
    modelFallback: modelFallback,
    clock: () => 1000,
    logger: null,
  });

  return {
    kernel: kernel,
    kernelStore: kernelStore,
    supervisor: supervisor,
    taskStore: taskStore,
    toolRunner: toolRunner,
    mcpAdapter: mcpAdapter,
    skillAdapter: skillAdapter,
    capabilityAdapter: capabilityAdapter,
    providerAdapter: providerAdapter,
    workspaceAdapter: workspaceAdapter,
    usageAdapter: usageAdapter,
    schemaValidator: schemaValidator,
    modelFallback: modelFallback,
    run: () => driver.runReactTask(TASK_ID, WORKER_ID, LEASE, ROOT, USER),
  };
}

test("正常收敛：模型 -> 工具 -> 观察回填 -> 再模型 -> finish_task", async () => {
  const harness = createHarness({
    replies: [
      { content: "先写文件", toolCalls: [call("c1", "fs_write", { path: "a.md", content: "hello" })] },
      { content: "收尾", toolCalls: [call("c2", "finish_task", { summary: "完成 a.md" })] },
    ],
    toolImpl: () => ({ message: "已写入 a.md", deliverable: true, nodeId: "node-1", name: "a.md" }),
  });
  const outcome = await harness.run();
  assert.equal(outcome.kind, "finished");
  assert.equal(outcome.summary, "完成 a.md");

  // 两个模型轮次
  assert.equal(harness.providerAdapter.requests.length, 2);
  const firstTools = harness.providerAdapter.requests[0].tools.map((t) => t.function.name);
  assert.ok(firstTools.includes("fs_write"));
  assert.ok(firstTools.includes("finish_task"));
  assert.ok(firstTools.includes("ask_user"));
  assert.ok(firstTools.includes("save_memory"));
  assert.ok(harness.providerAdapter.requests[0].system.includes("你是 DX OS 的项目 Agent"));
  assert.equal(harness.providerAdapter.requests[0].model, "fake-llm");

  // 第二轮请求已回填第一轮的工具观察
  const toolMessage = harness.providerAdapter.requests[1].messages.find((m) => m.role === "tool");
  assert.ok(toolMessage);
  assert.ok(toolMessage.content.includes("已写入 a.md"));
  assert.equal(toolMessage.tool_call_id, "c1");
  // 第二轮请求带上了 assistant 的 tool_calls 声明
  const assistantWithCalls = harness.providerAdapter.requests[1].messages.find((m) => m.role === "assistant" && m.tool_calls);
  assert.ok(assistantWithCalls);
  assert.equal(assistantWithCalls.tool_calls[0].function.name, "fs_write");

  // 工具只执行一次，且调用参数原样透传
  assert.equal(harness.toolRunner.calls.length, 1);
  assert.equal(harness.toolRunner.calls[0].name, "fs_write");
  assert.deepEqual(harness.toolRunner.calls[0].args, { path: "a.md", content: "hello" });
  assert.equal(harness.toolRunner.calls[0].ctx.rootNodeId, "ws-1");

  // 步骤 / operation 落库
  assert.equal(harness.taskStore.steps.length, 1);
  assert.equal(harness.taskStore.steps[0].status, "completed");
  assert.equal(harness.taskStore.operations.size, 1);
  assert.equal([...harness.taskStore.operations.values()][0].status, "completed");

  // 任务事件序列
  const eventTypes = harness.taskStore.events.map((e) => e.type);
  assert.ok(eventTypes.includes("agent.kernel.prepared"));
  assert.ok(eventTypes.includes("step.started"));
  assert.ok(eventTypes.includes("step.completed"));

  // run 事件序列
  const runEventTypes = harness.kernelStore.events.map((e) => e.type);
  assert.ok(runEventTypes.includes("planned"));
  assert.ok(runEventTypes.includes("capability.started"));
  assert.ok(runEventTypes.includes("capability.completed"));

  // 模型/工具两类 usage 都记账
  assert.ok(harness.usageAdapter.invocations.some((i) => i.kind === "model"));
  assert.ok(harness.usageAdapter.invocations.some((i) => i.kind === "tool"));
  assert.ok(harness.usageAdapter.finished.some((f) => f.status === "completed"));
});

test("工具失败：错误作为观察回填，模型修正后仍能收敛", async () => {
  const harness = createHarness({
    replies: [
      { toolCalls: [call("c1", "fs_write", { path: "b.md", content: "x" })] },
      { toolCalls: [call("c2", "finish_task", { summary: "降级完成" })] },
    ],
    toolImpl: () => { throw new FakeToolError("tool_failed", "磁盘已满"); },
  });
  const outcome = await harness.run();
  assert.equal(outcome.kind, "finished");
  assert.equal(outcome.summary, "降级完成");

  const toolMessage = harness.providerAdapter.requests[1].messages.filter((m) => m.role === "tool").pop();
  assert.ok(toolMessage.content.includes("工具执行失败（tool_failed）：磁盘已满"));
  assert.equal(harness.taskStore.steps[0].status, "failed");
  assert.ok(harness.taskStore.events.map((e) => e.type).includes("step.failed"));
  assert.ok(harness.kernelStore.events.map((e) => e.type).includes("capability.failed"));
});

test("取消：任务不再 running 时循环立即 stopped，不继续调用模型", async () => {
  const harness = createHarness({
    replies: [
      { toolCalls: [call("c1", "fs_write", { path: "c.md", content: "x" })] },
      { toolCalls: [call("c2", "finish_task", { summary: "不应到达" })] },
    ],
    toolImpl: () => {
      harness.taskStore.runtime.status = "cancelled";
      return { message: "已写入 c.md" };
    },
  });
  const outcome = await harness.run();
  assert.equal(outcome.kind, "stopped");
  assert.equal(harness.providerAdapter.requests.length, 1);
});

test("迭代上限：maxModelCalls 预算耗尽 -> budget_exhausted", async () => {
  const harness = createHarness({
    budget: { maxModelCalls: 2, maxToolCalls: 20 },
    replies: [
      { toolCalls: [call("c1", "fs_read", { path: "a.md" })] },
      { toolCalls: [call("c2", "fs_read", { path: "b.md" })] },
      { toolCalls: [call("c3", "finish_task", { summary: "不应到达" })] },
    ],
  });
  const outcome = await harness.run();
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.code, "budget_exhausted");
  assert.ok(outcome.message.includes("模型调用达到上限（2 次）"));
  assert.equal(harness.providerAdapter.requests.length, 2);
});

test("等待用户后再继续：ask_user -> waiting_user -> 回答后恢复 -> 收敛", async () => {
  const harness = createHarness({
    replies: [
      { toolCalls: [call("c1", "ask_user", { question: "标题叫什么？" })] },
      { toolCalls: [call("c2", "finish_task", { summary: "按标题完成" })] },
    ],
  });
  const first = await harness.run();
  assert.equal(first.kind, "waiting_user");
  assert.equal(harness.taskStore.runtime.status, "waiting_user");
  assert.ok(harness.taskStore.messages.some((m) => m.content.includes("标题叫什么？")));
  const waitingRun = [...harness.kernelStore.runs.values()][0];
  assert.equal(waitingRun.status, "waiting_user");
  // ask_user 是控制工具，不产生工具步骤
  assert.equal(harness.taskStore.steps.length, 0);

  // 用户回答后恢复同一任务
  harness.taskStore.runtime.status = "running";
  harness.taskStore.appendTaskEvent(TASK_ID, "task.answered", "标题叫《离线》");
  const second = await harness.run();
  assert.equal(second.kind, "finished");
  assert.equal(second.summary, "按标题完成");

  // 恢复后的模型请求带上用户回答；且没有重放 ask_user 的副作用
  assert.equal(harness.providerAdapter.requests.length, 2);
  const resumeUserMessage = harness.providerAdapter.requests[1].messages.find(
    (m) => m.role === "user" && m.content.includes("用户最新补充或回答"),
  );
  assert.ok(resumeUserMessage);
  assert.ok(resumeUserMessage.content.includes("标题叫《离线》"));
  assert.equal(harness.taskStore.turns[0].status, "completed");
});

test("未注入适配器：返回结构化 AGENT_DEPENDENCY_UNAVAILABLE", async () => {
  driver.resetReactDriverForTests();
  assert.equal(driver.AGENT_DEPENDENCY_UNAVAILABLE, "AGENT_DEPENDENCY_UNAVAILABLE");
  const outcome = await driver.runReactTask(TASK_ID, WORKER_ID, LEASE, ROOT, USER);
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.code, "AGENT_DEPENDENCY_UNAVAILABLE");
  assert.equal(outcome.dependency, "providerAdapter");
  assert.ok(outcome.message.includes("providerAdapter"));

  // 部分注入：providerAdapter 有了但缺 toolRunner，仍必须结构化报错而不是假装成功
  driver.configureReactDriver({
    providerAdapter: { firstUsable: () => null, autoFallback: () => false, call: async () => ({}) },
  });
  const partial = await driver.runReactTask(TASK_ID, WORKER_ID, LEASE, ROOT, USER);
  assert.equal(partial.kind, "failed");
  assert.equal(partial.code, "AGENT_DEPENDENCY_UNAVAILABLE");
  assert.equal(partial.dependency, "toolRunner");
});

test("越界/未知名工具：执行前授权双检拒绝，不产生工具副作用", async () => {
  const harness = createHarness({
    replies: [
      { toolCalls: [call("c1", "fs_delete_all", { path: "x" })] },
      { toolCalls: [call("c2", "finish_task", { summary: "拒绝后收敛" })] },
    ],
  });
  const outcome = await harness.run();
  assert.equal(outcome.kind, "finished");
  assert.equal(outcome.summary, "拒绝后收敛");
  assert.equal(harness.toolRunner.calls.length, 0);
  assert.equal(harness.taskStore.steps.length, 0);
  assert.equal(harness.taskStore.operations.size, 0);

  const toolMessage = harness.providerAdapter.requests[1].messages.filter((m) => m.role === "tool").pop();
  assert.ok(toolMessage.content.includes("unknown_tool"));
  assert.ok(toolMessage.content.includes("fs_delete_all"));
});

test("Planner：未规划时先消耗一次模型调用并提交计划", async () => {
  const harness = createHarness({
    seedPlanned: false,
    replies: [
      { toolCalls: [call("p1", "submit_plan", { goal: "目标", acceptance: ["文件存在"] })] },
      { toolCalls: [call("c1", "finish_task", { summary: "完成" })] },
    ],
  });
  const outcome = await harness.run();
  assert.equal(outcome.kind, "finished");
  assert.equal(harness.providerAdapter.requests.length, 2);
  const planTools = harness.providerAdapter.requests[0].tools.map((t) => t.function.name);
  assert.deepEqual(planTools, ["submit_plan"]);
  assert.deepEqual(harness.taskStore.task.plan, { goal: "目标", assumptions: [], acceptance: ["文件存在"] });
});

test("工具声明与长度助手：纯函数行为与源一致", () => {
  assert.equal(driver.isSingleDocumentCreation("创建一篇小说文档"), true);
  assert.equal(driver.isSingleDocumentCreation("创建多个小说文档"), false);
  assert.equal(driver.isSingleDocumentCreation("修改这篇小说文档"), false);
  assert.deepEqual(driver.requestedDocumentLength("写一篇 800-1200 字的文章"), { min: 800, max: 1200 });
  assert.equal(driver.requestedDocumentLength("随便写点东西"), null);
  assert.equal(driver.fastDocumentLengthError({ instruction: "写 100-200 字的文档" }, "fs_write", { content: "太短" }).includes("不符合用户要求"), true);
  assert.equal(driver.fastDocumentLengthError({ instruction: "写 100-200 字的文档" }, "fs_write", { content: "字".repeat(150) }), "");
});
