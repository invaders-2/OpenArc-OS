/**
 * B3b · Agent 内核 / 能力层 / Run 持久化 / Supervisor 巡检回归测试。
 *
 * 覆盖（任务 K1）：
 *   1) 回合组装 prepareAgentTurn：contextBuilder 分段顺序与预算、capability snapshot、PreparedAgentTurn 形状
 *   2) 能力层：resolveAgentRoute 真实分支、capabilityTargetResolver 未命中/多候选、capabilityDiscovery、渐进式工具集
 *   3) runStore：createAgentRun→startAgentRun→appendAgentRunEvent→waiting_user/completed/failed/cancelled 全链路 + 落库断言
 *   4) supervisor 委派上限：深度 3、每 Run 最多 8 个子、并行 3（真实闸门在 agent-task-store.claimNextTask）
 *      + delegateAgentWork / getAgentProfile / listAgentProfiles
 *   5) runInspection 快照字段
 *   6) 未注入 modelAdapter/toolRunner/fsAdapter 时的结构化 AGENT_DEPENDENCY_UNAVAILABLE
 *
 * 全部离线：node:sqlite 内存库（真实 SQLite）+ 注入的假适配器。
 * 源文件行号注释对应 electron/*.cjs（B3b CJS 投影）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const foundationSchema = require("../electron/dxos-foundation-schema.cjs");
const agentSchema = require("../electron/dxos-agent-schema.cjs");
const kernel = require("../electron/agent-kernel.cjs");
const runStore = require("../electron/agent-kernel-store.cjs");
const supervisor = require("../electron/agent-kernel-supervisor.cjs");
const inspection = require("../electron/agent-kernel-inspection.cjs");
const capabilityRouter = require("../electron/capability-router.cjs");
const targetResolver = require("../electron/capability-target-resolver.cjs");
const discovery = require("../electron/capability-discovery.cjs");
const progressive = require("../electron/progressive-capability-router.cjs");
const contracts = require("../electron/agent-contracts.cjs");
const taskStoreModule = require("../electron/agent-task-store.cjs");

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

let clockTick = 1_700_000_000_000;
function nextClock() { clockTick += 1; return clockTick; }

/** agent-kernel.cjs:103-106 requireDb 的等价建库：真实 SQLite 内存库 + 全量 DX 地基表。 */
function newDb() {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const statement of foundationSchema.dxosDdl()) db.exec(statement);
  for (const statement of agentSchema.dxosAgentDdl()) db.exec(statement);
  return db;
}

/** agent-kernel-supervisor.cjs:66-79 profileView 需要的列。 */
function seedProfiles(db) {
  const ts = nextClock();
  const insert = db.prepare(
    "INSERT INTO agent_profiles(id,name,description,capability_scopes_json,model_profile,max_model_calls,max_tool_calls,system_prompt,builtin,enabled,created_at,updated_at,allowed_risks_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  insert.run("maker", "Maker", "产出者", JSON.stringify(["file:*", "app:*"]), "default", 10, 20, "负责产出。", 1, 1, ts, ts, JSON.stringify(["read", "write"]));
  insert.run("reviewer", "Reviewer", "审核者", JSON.stringify(["*"]), "default", 5, 5, "负责审核。", 0, 1, ts, ts, JSON.stringify(["read"]));
  return db;
}

/** 重置并注入内核依赖；每个用例开头调用，避免模块级 state 串味。 */
function configureKernel(db, over = {}) {
  kernel.resetAgentKernelForTests();
  return kernel.configureAgentKernel(Object.assign({ db, clock: nextClock }, over));
}

/** capabilityRegistry.ts:13-35 kernelCapabilityFromTool 的输入形状。 */
function toolDescriptor(over = {}) {
  return Object.assign({
    source: "file", sourceId: "src1", name: "read_file", domain: "file",
    intents: ["file.read"], title: "读文件", description: "读取一个文件",
    whenToUse: ["需要读文件时"], requiredContext: [], inputSchema: { type: "object" },
    outputSchema: undefined, permissions: ["read"], risk: "read", sideEffects: [],
    status: "ready", executable: true, enabled: true, handler: { type: "function" },
    appId: undefined, capabilityId: undefined,
  }, over);
}

function makeModelRoute(over = {}) {
  return Object.assign({
    providerId: "p1", providerName: "供应商一", model: "m1", intent: "llm.tools",
    operationId: "op1", operation: { id: "op1" }, uiSchemaId: undefined,
    defaults: {}, satisfied: [], missing: [], warnings: [], reasons: ["选中 p1/m1"], alternatives: [],
  }, over);
}

function makeModelResolver(routes, onCall) {
  return {
    resolveModelRoutesFromProviders(providers, options) {
      if (onCall) onCall(providers, options);
      return typeof routes === "function" ? routes(providers, options) : routes;
    },
  };
}

function makeToolResolver(tools) {
  const result = () => tools || { descriptors: [], openaiTools: [] };
  return { resolveReactTools: result, resolveTools: result };
}

function makeProvider(id, name, models) {
  return { id, name, base_url: "https://example.invalid", api_key: "sk-test-key-000000", protocol: "openai", models: (models || ["m1"]).map((model) => ({ model })) };
}

/** 构造 PreparedAgentTurn（runStore.ts:115-132 createAgentRun 只消费 trace/context/capabilities）。 */
let runSeq = 0;
let taskSeq = 0;
function makePrepared(over = {}) {
  const runId = over.runId || "run-" + (++runSeq);
  const trace = Object.assign({
    runId, correlationId: runId, sessionId: "sess-1", taskId: "task-parent",
    projectId: "proj-1", appId: "app-1", entryPoint: "project", userId: "u1",
    createdAt: nextClock(), delegationDepth: 0,
  }, over.trace || {});
  return {
    trace,
    route: over.route || { toolDescriptors: [], tools: [], systemPromptAdditions: [], warnings: [], reasons: [] },
    capabilities: over.capabilities || [],
    context: over.context || [],
  };
}

/** 假 taskStore：supervisor/delegateAgentWork 与 contextBuilder.listMemories 消费的方法。 */
function makeFakeTaskStore(over = {}) {
  const tasks = new Map();
  const memories = over.memories || [{ content: "记忆甲" }, { content: "记忆乙" }];
  const api = {
    tasks,
    listMemories() { return memories; },
    getTask(id) { return tasks.get(id); },
    getProject(id) { return { id, root_node_id: "root_1" }; },
    createTask(input) {
      const id = "child-task-" + (++taskSeq);
      const task = Object.assign({}, input, {
        id, status: "queued", thread_id: "thread-1",
        root_task_id: input.rootTaskId || id,
        delegation_depth: input.delegationDepth || 0,
        permission_grant_json: JSON.stringify(input.permissionGrant || []),
      });
      tasks.set(id, task);
      return task;
    },
    setPermissionGrant(taskId, grant) {
      const task = tasks.get(taskId);
      if (task) { task.permission_grant_json = JSON.stringify(grant); task.grant = grant; }
    },
    appendTaskEvent() {},
    refreshTaskInstruction() {},
    cancelTask() {},
    failQueuedTask() {},
  };
  return Object.assign(api, over.override || {});
}

// ---------------------------------------------------------------------------
// 1) 共享契约与能力类型常量
// ---------------------------------------------------------------------------

test("契约：常量与 capabilityMetadata 归一化（agent-contracts.cjs:16-41）", () => {
  assert.equal(contracts.AGENT_REQUEST_SCHEMA_V1, "dx-agent-request/v1");
  assert.equal(contracts.AGENT_CAPABILITY_METADATA_KEY, "x_dx_capability");
  assert.equal(contracts.CAPABILITY_DISCOVER_TOOL_NAME, "capability_discover");
  assert.deepEqual(contracts.SUPERVISOR_RUN_STATUSES, ["created", "running", "waiting_user", "completed", "failed", "cancelled"]);

  const meta = contracts.capabilityMetadata({
    id: "cap.image.generate", domain: "media.image",
    intents: [" image.generate ", "image.generate", "", "image.edit"],
    appId: "", requiredContext: ["p1", "p1", "p2"],
  });
  assert.equal(meta.schema, "dx-agent-capability/v1");
  assert.deepEqual(meta.intents, ["image.generate", "image.edit"]);
  assert.equal("appId" in meta, false);
  assert.deepEqual(meta.requiredContext, ["p1", "p2"]);
  assert.deepEqual(contracts.capabilityMetadata(null).intents, []);
});

test("能力类型：显式枚举常量（capability-types.cjs:14-67）", () => {
  const types = require("../electron/capability-types.cjs");
  assert.deepEqual([...types.PROVIDER_CAPABILITIES], ["llm", "image", "video", "audio"]);
  assert.deepEqual([...types.COARSE_CAPABILITIES], ["llm", "image", "video", "audio", "other"]);
  assert.ok(types.CAPABILITY_INTENTS.includes("llm.chat.vision"));
  assert.ok(types.TASK_INTENTS.includes("agent.analyze_image_and_write"));
  assert.deepEqual([...types.FALLBACK_POLICIES], ["strict", "compatible", "best_available"]);
  assert.deepEqual([...types.CAPABILITY_SOURCES], ["manual", "observed", "profile", "model_caps", "fallback"]);
});

// ---------------------------------------------------------------------------
// 1) 回合组装 prepareAgentTurn（kernel.ts:7-47 / contextBuilder.ts:23-55）
// ---------------------------------------------------------------------------

test("prepareAgentTurn：上下文分段顺序与预算、capability snapshot、PreparedAgentTurn 形状", () => {
  const db = seedProfiles(newDb());
  const descriptors = [
    toolDescriptor({ name: "read_file", capabilityId: "file:src1:read_file", risk: "read" }),
    toolDescriptor({ name: "delete_file", sourceId: "src2", capabilityId: "file:src2:delete_file", risk: "delete" }),
    toolDescriptor({ name: "app_tool", source: "app", sourceId: "app1", appId: "app1", domain: undefined, capabilityId: "app:app1:app_tool", risk: "write", enabled: false }),
  ];
  const tools = { descriptors, openaiTools: [{ type: "function", function: { name: "read_file" } }] };
  const captured = [];
  const memories = Array.from({ length: 25 }, (_, index) => ({ content: "记忆" + index }));
  configureKernel(db, {
    modelResolver: makeModelResolver([makeModelRoute({ warnings: ["模型警告"], reasons: ["模型理由"] })], (providers, options) => captured.push({ providers, options })),
    toolResolver: makeToolResolver(tools),
    providers: () => [makeProvider("p1", "供应商一", ["m1"])],
    taskStore: makeFakeTaskStore({ memories }),
  });

  // 超过 MAX_APP_CONTEXT_CHARS 的字符串 + 敏感键，验证截断与脱敏（agent-kernel.cjs:202-222）。
  const turn = kernel.prepareAgentTurn({
    runId: "run-shape", instruction: "读取并统计文件", entryPoint: "project",
    actor: { id: "u1", role: "user", displayName: "用户一" },
    projectId: "proj-1", appId: "app-1",
    appContext: { token: "sk-abcdefghijklmnop", nested: { payload: "x".repeat(9000) } },
    preferredProviderId: "p1", preferredModel: "m1",
  });

  // trace 形状（agent-kernel.cjs:290-307）
  assert.equal(turn.trace.runId, "run-shape");
  assert.equal(turn.trace.correlationId, "run-shape");
  assert.equal(turn.trace.userId, "u1");
  assert.equal(turn.trace.entryPoint, "project");
  assert.equal(turn.trace.delegationDepth, 0);
  assert.equal(turn.trace.projectId, "proj-1");
  assert.equal(typeof turn.trace.createdAt, "number");

  // route 透传 + preferredModels 权重（capability-router.cjs:48-54）
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].options.requiresAll, ["llm.tools"]);
  assert.equal(captured[0].options.taskIntent, "agent.project.write");
  assert.deepEqual(captured[0].options.preferredModels, [{ providerId: "p1", model: "m1", weight: 2000 }]);
  assert.equal(turn.route.model.model, "m1");

  // capability snapshot：delete→destructive、enabled:false→不可执行、app 域回退（agent-kernel.cjs:152-196）
  assert.equal(turn.capabilities.length, 3);
  const [readCap, deleteCap, appCap] = turn.capabilities;
  assert.equal(readCap.id, "file:src1:read_file");
  assert.equal(readCap.risk, "read");
  assert.equal(readCap.executable, true);
  assert.equal(readCap.providerType, "file");
  assert.equal(readCap.providerId, "src1");
  assert.equal(readCap.handlerType, "function");
  assert.deepEqual(readCap.whenToUse, ["需要读文件时"]);
  assert.equal(deleteCap.risk, "destructive");
  assert.equal(appCap.domain, "app.app1");
  assert.equal(appCap.executable, false);
  assert.equal(appCap.risk, "write");

  // contextBuilder：priority 80（项目记忆）在 70（APP 上下文）之前
  assert.deepEqual(turn.context.map((section) => section.id), ["project.memories", "app.context"]);
  assert.equal(turn.context[0].priority, 80);
  assert.equal(turn.context[0].source, "memory");
  assert.equal(turn.context[0].trust, "trusted");
  assert.equal(turn.context[0].content.split("\n").length, 20, "记忆最多 20 条");
  assert.equal(turn.context[0].content.split("\n")[0], "- 记忆0");
  assert.equal(turn.context[1].priority, 70);
  assert.equal(turn.context[1].source, "app");
  assert.equal(turn.context[1].trust, "untrusted");
  assert.ok(turn.context[1].content.length <= kernel.MAX_APP_CONTEXT_CHARS);
  assert.ok(turn.context[1].content.includes("[redacted]"), "敏感键被脱敏");
  assert.ok(turn.context[1].title.startsWith("APP 上下文 · app-1"));

  // systemPromptAdditions：受控上下文提示（agent-kernel.cjs:324-327）
  assert.equal(turn.systemPromptAdditions.length, 1);
  assert.match(turn.systemPromptAdditions[0], /不可信业务数据/);
  assert.match(turn.systemPromptAdditions[0], /【项目记忆】/);

  // contextSectionsPrompt 拼接格式（agent-kernel.cjs:256-260）
  assert.equal(kernel.contextSectionsPrompt([]), "");
  assert.equal(kernel.contextSectionsPrompt([{ title: "A", content: "1" }, { title: "B", content: "2" }]), "【A】\n1\n\n【B】\n2");
});

test("contextBuilder：safeAppContext 脱敏/深度限制/数组上限/序列化兜底与预算常量", () => {
  assert.equal(kernel.safeAppContext(undefined), "");
  assert.equal(kernel.safeAppContext(null), "");
  // 循环引用被 redact 的 depth 上限截断（redact 未导出，经 safeAppContext 间接验证）
  const circular = {}; circular.self = circular;
  assert.ok(kernel.safeAppContext(circular).includes("[depth-limited]"));
  // BigInt 无法 JSON 序列化 → 走 catch 兜底
  assert.equal(kernel.safeAppContext({ big: 10n }), "[无法序列化的 APP 上下文]");
  assert.equal(kernel.MAX_APP_CONTEXT_CHARS, 8000);
  assert.equal(kernel.SENSITIVE_KEY.test("Authorization"), true);

  // redact 未从 agent-kernel.cjs 导出（module.exports 无 redact），经 buildAgentContext 间接验证
  const secret = kernel.safeAppContext({ password: "p", nested: { api_key: "k" } });
  assert.ok(secret.includes("[redacted]"));
  assert.ok(!secret.includes('"k"'));

  const deep = kernel.buildAgentContext({ appContext: { a: { b: { c: { d: { e: { f: "deep" } } } } } } });
  assert.equal(deep.length, 1);
  assert.ok(deep[0].content.includes("[depth-limited]"));

  const wide = kernel.buildAgentContext({ appContext: { list: Array.from({ length: 150 }, (_, i) => i) } });
  assert.equal(JSON.parse(wide[0].content).list.length, 100);
});

test("kernelCapabilitySnapshot：total / executable / byProvider 汇总（agent-kernel.cjs:182-196）", () => {
  const descriptors = [
    toolDescriptor({ name: "a", source: "file", capabilityId: "file:a", executable: true, enabled: true }),
    toolDescriptor({ name: "b", source: "file", capabilityId: "file:b", executable: true, enabled: false }),
    toolDescriptor({ name: "c", source: "mcp", sourceId: "mcp1", capabilityId: "mcp:c", executable: true, enabled: true }),
  ];
  const snapshot = kernel.kernelCapabilitySnapshot(descriptors);
  assert.equal(snapshot.capabilities.length, 3);
  assert.deepEqual(snapshot.summary, { total: 3, executable: 2, byProvider: { file: 2, mcp: 1 } });
});

test("createAgentKernelEvent：sequence 必须为正整数（agent-kernel.cjs:266-282）", () => {
  configureKernel(newDb());
  const event = kernel.createAgentKernelEvent(
    { runId: "r1", correlationId: "c1", causationId: "ca1", taskId: "t1", projectId: "p1", appId: "a1" },
    "running", 3, { hello: "world" },
  );
  assert.equal(event.type, "running");
  assert.equal(event.runId, "r1");
  assert.equal(event.sequence, 3);
  assert.equal(event.taskId, "t1");
  assert.deepEqual(event.data, { hello: "world" });
  assert.equal(typeof event.id, "string");
  assert.equal(typeof event.timestamp, "number");
  assert.throws(() => kernel.createAgentKernelEvent({ runId: "r1" }, "running", 0), /正整数/);
  assert.throws(() => kernel.createAgentKernelEvent({ runId: "r1" }, "running", 1.5), /正整数/);
});

// ---------------------------------------------------------------------------
// 2) 能力层：resolveAgentRoute / capabilityTargetResolver / capabilityDiscovery
// ---------------------------------------------------------------------------

function expectDependency(fn, dependency) {
  try {
    fn();
    assert.fail("应当抛出 AGENT_DEPENDENCY_UNAVAILABLE：" + dependency);
  } catch (error) {
    assert.equal(error.code, kernel.AGENT_DEPENDENCY_UNAVAILABLE, error.message);
    assert.equal(error.dependency, dependency);
  }
}

test("resolveAgentRoute：依赖未注入时抛结构化 AGENT_DEPENDENCY_UNAVAILABLE（capability-router.cjs:31-47）", () => {
  kernel.resetAgentKernelForTests();
  expectDependency(() => capabilityRouter.resolveAgentRoute({}), "modelResolver.resolveModelRoutesFromProviders");

  kernel.configureAgentKernel({ modelResolver: makeModelResolver([]) });
  expectDependency(() => capabilityRouter.resolveAgentRoute({}), "toolResolver.resolveTools");

  kernel.configureAgentKernel({ modelResolver: makeModelResolver([]), toolResolver: { resolveTools: () => ({ descriptors: [], openaiTools: [] }) } });
  expectDependency(() => capabilityRouter.resolveAgentRoute({}), "toolResolver.resolveReactTools");

  kernel.configureAgentKernel({ modelResolver: makeModelResolver([]), toolResolver: makeToolResolver(), providers: [] });
  expectDependency(() => capabilityRouter.resolveAgentRoute({}), "providers");

  kernel.resetAgentKernelForTests();
  kernel.configureAgentKernel({ modelResolver: makeModelResolver([]), toolResolver: { resolveReactTools: () => ({ descriptors: [], openaiTools: [] }) }, providers: () => [] });
  expectDependency(() => capabilityRouter.resolveAgentRoute({ requestedSources: ["file"] }), "toolResolver.resolveTools");
});

test("resolveAgentRoute：hasImageInput / preferredModels 权重 / requestedSources 真实分支（capability-router.cjs:24-83）", () => {
  const db = newDb();
  const calls = [];
  const descriptors = [toolDescriptor({ name: "read_file", capabilityId: "file:src1:read_file" })];
  const toolsResult = { descriptors, openaiTools: [{ type: "function", function: { name: "read_file" } }] };
  configureKernel(db, {
    modelResolver: makeModelResolver((providers, options) => { calls.push({ providers, options }); return [makeModelRoute({ warnings: ["w"], reasons: ["r"] })]; }),
    toolResolver: {
      resolveReactTools: (actor) => { calls.push({ resolveReactTools: actor }); return toolsResult; },
      resolveTools: (input) => { calls.push({ resolveTools: input }); return toolsResult; },
    },
    providers: () => [makeProvider("p1", "供应商一", ["m1", "m2"]), makeProvider("p2", "供应商二", ["m3"])],
  });

  const route = capabilityRouter.resolveAgentRoute({ actor: { id: "u1", role: "user" } });
  assert.equal(route.taskIntent, "agent.project.write");
  assert.deepEqual(route.requiresAll, ["llm.tools"]);
  assert.deepEqual(route.requiresAny, []);
  assert.equal(route.model.model, "m1");
  assert.equal(route.modelRoutes.length, 1);
  assert.deepEqual(route.tools, toolsResult.openaiTools);
  assert.deepEqual(route.toolDescriptors, descriptors);
  assert.deepEqual(route.systemPromptAdditions, []);
  assert.deepEqual(route.warnings, ["w"]);
  assert.ok(route.reasons.some((reason) => reason.includes("暴露 1 个 Agent 工具（1 个文件工具，0 个 Skill 工具，0 个 MCP 工具）")));
  assert.deepEqual(calls[0].options.preferredModels, []);
  assert.equal(calls[0].options.fallbackPolicy, "best_available");
  assert.deepEqual(calls.find((call) => call.resolveReactTools).resolveReactTools, { id: "u1", role: "user" });

  const route2 = capabilityRouter.resolveAgentRoute({ hasImageInput: true });
  assert.equal(route2.taskIntent, "agent.analyze_image_and_write");
  assert.deepEqual(route2.requiresAll, ["llm.chat.vision", "llm.tools"]);

  capabilityRouter.resolveAgentRoute({ preferredProviderId: "p1", preferredModel: "m2" });
  const weighted = calls.filter((call) => call.options && call.options.preferredModels).pop().options.preferredModels;
  assert.deepEqual(weighted, [
    { providerId: "p1", model: "m1", weight: 500 },
    { providerId: "p1", model: "m2", weight: 2000 },
  ]);

  capabilityRouter.resolveAgentRoute({ preferredModel: "m9" });
  assert.deepEqual(calls.filter((call) => call.options && call.options.preferredModels).pop().options.preferredModels, [{ model: "m9", weight: 2000 }]);

  const route5 = capabilityRouter.resolveAgentRoute({ requestedSources: ["file"], actor: { id: "u1" } });
  assert.equal(route5.toolDescriptors.length, 1);
  assert.deepEqual(calls.find((call) => call.resolveTools).resolveTools, {
    intent: "project.agent", actor: { id: "u1" }, requestedSources: ["file"],
    executableOnly: true, includeRisk: ["read", "write", "delete", "external"],
  });

  configureKernel(db, {
    modelResolver: makeModelResolver([makeModelRoute()]),
    toolResolver: makeToolResolver({ descriptors: [], openaiTools: [] }),
    providers: () => [makeProvider("p1", "供应商一", ["m1"])],
  });
  const empty = capabilityRouter.resolveAgentRoute({});
  assert.ok(empty.warnings.some((warning) => warning.includes("当前没有可执行工具")));
  assert.ok(empty.reasons.some((reason) => reason.includes("暴露 0 个 Agent 工具")));

  assert.deepEqual(capabilityRouter.inferAgentRequirements({}), { taskIntent: "agent.project.write", requiresAll: ["llm.tools"], requiresAny: [] });
  assert.deepEqual(capabilityRouter.inferAgentRequirements({ hasImageInput: true }), { taskIntent: "agent.analyze_image_and_write", requiresAll: ["llm.chat.vision", "llm.tools"], requiresAny: [] });
});

test("capabilityTargetResolver：未命中 / 多候选排序 / resolutionSupport 三档（capability-target-resolver.cjs:29-194）", () => {
  const db = newDb();
  assert.equal(Object.keys(targetResolver.CAPABILITY_TO_PROTOCOL_INTENT).length, 16);
  assert.equal(targetResolver.protocolIntentForCapability("media.image.generate"), "image.generate");
  assert.equal(targetResolver.protocolIntentForCapability("media.image.inspect"), "image.describe");
  assert.equal(targetResolver.protocolIntentForCapability("media.image.unknown"), null);

  assert.deepEqual(targetResolver.normalizeCapabilityReferences({ images: 2.9, videos: -3, audios: "7", files: 1000 }), { images: 2, videos: 0, audios: 7, files: 100 });
  assert.deepEqual(targetResolver.normalizeCapabilityRequirements({ resolution: "  4K  " }), { resolution: "4k" });
  assert.deepEqual(targetResolver.normalizeCapabilityRequirements({}), {});

  configureKernel(db, {
    modelResolver: makeModelResolver([]),
    modelDescriptor: { resolveModelDescriptor: () => { throw new Error("未命中不应调用 modelDescriptor"); } },
  });
  assert.deepEqual(targetResolver.discoverCapabilityTargets(["media.image.unknown"], [makeProvider("p1", "供应商一")]), {});
  assert.deepEqual(targetResolver.discoverCapabilityTargets(["media.image.generate"], [makeProvider("p1", "供应商一", ["m1"])]), { "media.image.generate": [] });

  const provider = makeProvider("p1", "供应商一", ["m1", "m2", "m3", "m4", "m5"]);
  const descriptorByModel = {
    m1: { execution: { available: true, mode: "api" }, capabilities: ["image.generate"], operation: { id: "op1" }, inputs: { prompt: true } },
    m2: { execution: { available: true, mode: "api" }, capabilities: ["image.generate"], operation: { id: "op2" }, parameters: { schemaId: "s1", defaults: {}, fields: [{ key: "resolution", options: ["1k"] }] }, inputs: {} },
    m3: { execution: { available: false, mode: "api" }, capabilities: ["image.generate"], operation: { id: "op3" }, inputs: {} },
    m4: { execution: { available: true, mode: "api" }, capabilities: ["image.edit"], operation: { id: "op4" }, inputs: {} },
    m5: { execution: { available: true, mode: "api" }, capabilities: ["image.generate"], inputs: {} },
  };
  configureKernel(db, {
    modelResolver: makeModelResolver([
      { providerId: "p1", model: "m2" }, { providerId: "p1", model: "m1" }, { providerId: "p1", model: "m3" },
      { providerId: "p1", model: "m4" }, { providerId: "p1", model: "m5" },
    ]),
    modelDescriptor: { resolveModelDescriptor: ({ model }) => descriptorByModel[model.model] },
  });

  const noRequirement = targetResolver.discoverCapabilityTargets(["media.image.generate"], [provider], {}, {});
  assert.deepEqual(noRequirement["media.image.generate"].map((target) => target.model), ["m2", "m1"]);
  assert.equal(noRequirement["media.image.generate"][0].providerId, "p1");
  assert.equal(noRequirement["media.image.generate"][0].providerName, "供应商一");
  assert.equal(noRequirement["media.image.generate"][0].mode, "api");
  assert.equal(noRequirement["media.image.generate"][0].operationId, "op2");
  assert.equal(noRequirement["media.image.generate"][1].parameters, undefined);

  const fourK = targetResolver.discoverCapabilityTargets(["media.image.generate"], [provider], {}, { resolution: "4k" });
  assert.deepEqual(fourK["media.image.generate"].map((target) => target.model), ["m1"]);

  const oneK = targetResolver.discoverCapabilityTargets(["media.image.generate"], [provider], {}, { resolution: "1k" });
  assert.deepEqual(oneK["media.image.generate"].map((target) => target.model), ["m2", "m1"]);
});

test("capabilityTargetResolver：size 选项阈值与 selectedCapabilityTargets（capability-target-resolver.cjs:71-90,171-173）", () => {
  const db = newDb();
  const provider = makeProvider("p1", "供应商一", ["m1"]);
  const descriptor = {
    execution: { available: true, mode: "api" }, capabilities: ["image.generate"], operation: { id: "op1" }, inputs: {},
    parameters: { schemaId: "s", defaults: {}, fields: [{ key: "size", options: ["1024x1024", "2048x2048"] }] },
  };
  configureKernel(db, {
    modelResolver: makeModelResolver([{ providerId: "p1", model: "m1" }]),
    modelDescriptor: { resolveModelDescriptor: () => descriptor },
  });
  assert.equal(targetResolver.discoverCapabilityTargets(["media.image.generate"], [provider], {}, { resolution: "1k" })["media.image.generate"].length, 1);
  assert.equal(targetResolver.discoverCapabilityTargets(["media.image.generate"], [provider], {}, { resolution: "4k" })["media.image.generate"].length, 0);
  // 任意像素阈值：999 低于 2048 → 命中；5000 高于 2048 → 被剔除
  assert.equal(targetResolver.discoverCapabilityTargets(["media.image.generate"], [provider], {}, { resolution: "999" })["media.image.generate"].length, 1);
  assert.equal(targetResolver.discoverCapabilityTargets(["media.image.generate"], [provider], {}, { resolution: "5000" })["media.image.generate"].length, 0);

  assert.deepEqual(targetResolver.selectedCapabilityTargets({ "media.image.generate": [{ providerId: "p1", model: "m1" }], "media.image.edit": [] }), [
    { intent: "media.image.generate", providerId: "p1", model: "m1" },
  ]);
  assert.deepEqual(targetResolver.selectedCapabilityTargets({}), []);
});

test("capabilityTargetResolver：discoverCapabilityTargetsForUser（capability-target-resolver.cjs:160-168）", async () => {
  const db = newDb();
  const provider = makeProvider("p1", "供应商一", ["m1"]);
  const descriptor = { execution: { available: true, mode: "api" }, capabilities: ["image.generate"], operation: { id: "op1" }, inputs: {} };
  const ordered = [];
  configureKernel(db, {
    modelResolver: makeModelResolver([{ providerId: "p1", model: "m1" }]),
    modelDescriptor: { resolveModelDescriptor: () => descriptor },
    providers: () => [provider],
    store: { applyModelOrders: (list) => { ordered.push(list); return list; } },
  });
  const byUser = await targetResolver.discoverCapabilityTargetsForUser("u1", ["media.image.generate"], {}, {});
  assert.equal(ordered.length, 1);
  assert.equal(byUser["media.image.generate"][0].model, "m1");

  configureKernel(db, { modelResolver: makeModelResolver([]) });
  expectDependency(() => targetResolver.discoverCapabilityTargets([], []), "modelDescriptor.resolveModelDescriptor");

  configureKernel(db, { modelResolver: makeModelResolver([]), modelDescriptor: { resolveModelDescriptor: () => descriptor }, providers: () => [provider] });
  await assert.rejects(
    () => targetResolver.discoverCapabilityTargetsForUser("u1", [], {}, {}),
    (error) => error.code === kernel.AGENT_DEPENDENCY_UNAVAILABLE && error.dependency === "store.applyModelOrders",
  );
});

test("capabilityDiscovery：descriptor id 兜底与 runCapabilityIds 授权过滤（capability-discovery.cjs:10-30）", () => {
  const descriptors = [
    { capabilityId: "cap-a", source: "app", sourceId: "a1", name: "toolA", intents: ["intent.a"] },
    { source: "file", sourceId: "f1", name: "toolB", intents: ["intent.b", "intent.c"] },
    { source: "mcp", sourceId: "m1", name: "toolC" },
  ];
  assert.equal(discovery.capabilityDescriptorId(descriptors[0]), "cap-a");
  assert.equal(discovery.capabilityDescriptorId(descriptors[1]), "file:f1:toolB");
  assert.equal(discovery.capabilityDescriptorId(descriptors[2]), "mcp:m1:toolC");

  const all = discovery.authorizeCapabilityDiscovery(descriptors, ["intent.a", "intent.b", "nope"]);
  assert.equal(all.descriptors.length, 3);
  assert.deepEqual(all.targetIntents, ["intent.a", "intent.b"]);

  // intents 缺失时用 source.name 兜底（第三个 descriptor 无 intents → mcp.toolC）
  assert.deepEqual(discovery.authorizeCapabilityDiscovery(descriptors, ["mcp.toolC"]).targetIntents, ["mcp.toolC"]);

  const limited = discovery.authorizeCapabilityDiscovery(descriptors, ["intent.a", "intent.b"], ["cap-a"]);
  assert.equal(limited.descriptors.length, 1);
  assert.deepEqual(limited.targetIntents, ["intent.a"]);

  assert.deepEqual(discovery.authorizeCapabilityDiscovery(descriptors, ["intent.a", "intent.b"], ["file:f1:toolB"]).targetIntents, ["intent.b"]);
  assert.deepEqual(discovery.authorizeCapabilityDiscovery(descriptors, ["intent.a"], ["no-such"]).targetIntents, []);
});

test("progressiveCapabilityRouter：收敛 schema / discover / applyTargets 参数约束（progressive-capability-router.cjs:77-171）", () => {
  const capabilityTool = {
    type: "function",
    function: { name: "image_generate", description: "生成图片", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } },
    x_dx_capability: { schema: "dx-agent-capability/v1", id: "cap.image", domain: "media.image", intents: ["image.generate"] },
  };
  const plain = { type: "function", function: { name: "plain" }, x_dx_capability: { schema: "other" } };
  const toolset = progressive.createProgressiveCapabilityToolset([capabilityTool, plain], { surface: "桌面" });

  assert.deepEqual(toolset.all.map((tool) => tool.function.name), ["image_generate"]);
  assert.equal(toolset.discoveryTool.function.name, "capability_discover");
  assert.deepEqual(toolset.discoveryTool.function.parameters.properties.intents.items.enum, ["image.generate"]);
  assert.deepEqual(toolset.discoveryTool.function.parameters.properties.domains.items.enum, ["media.image"]);
  assert.ok(toolset.discoveryTool.function.description.includes("桌面可用的"));
  assert.equal(toolset.isDiscovery("capability_discover"), true);
  assert.equal(toolset.isDiscovery("image_generate"), false);
  assert.equal(toolset.tools().length, 1);

  const result = toolset.discover({ intents: ["image.generate", "nope"] });
  assert.deepEqual(result.activated, [{ id: "cap.image", domain: "media.image", intents: ["image.generate"], toolName: "image_generate" }]);
  assert.deepEqual(result.unavailable, ["nope"]);
  assert.deepEqual(toolset.tools().map((tool) => tool.function.name), ["capability_discover", "image_generate"]);

  toolset.applyTargets({
    "image.generate": [{
      providerName: "供应商一", model: "m1", operationId: "op1",
      parameters: { fields: [{ key: "resolution", type: "slider", required: true, min: 0, max: 4, default: 1, label: "分辨率", options: [{ value: "1k" }, { value: "2k" }] }] },
    }],
  });
  const constrained = toolset.tools().find((tool) => tool.function.name === "image_generate");
  const resolution = constrained.function.parameters.properties.resolution;
  assert.equal(resolution.type, "number");
  assert.deepEqual(resolution.enum, ["1k", "2k"]);
  assert.equal(resolution.minimum, 0);
  assert.equal(resolution.maximum, 4);
  assert.equal(resolution.default, 1);
  assert.equal(resolution.description, "分辨率");
  assert.deepEqual(constrained.function.parameters.required, ["prompt", "resolution"]);
  assert.ok(constrained.function.description.includes("[V2 自动目标] 供应商一 / m1 / op1"));

  assert.equal(toolset.discover({ domains: ["media.image"] }).activated.length, 1);
  assert.equal(toolset.discover({ domains: ["no.such"] }).activated.length, 0);
});

// ---------------------------------------------------------------------------
// 3) runStore：create → start → 事件 → waiting_user → completed/failed/cancelled
// ---------------------------------------------------------------------------

test("runStore：createAgentRun→startAgentRun→appendAgentRunEvent→waiting_user→completed 全链路落库", () => {
  const db = newDb();
  configureKernel(db);
  const context = [
    { id: "project.memories", source: "memory", trust: "trusted", title: "项目记忆", content: "- 甲" },
    { id: "app.context", source: "app", trust: "untrusted", title: "APP 上下文", content: "{}" },
  ];
  const prepared = makePrepared({
    capabilities: [{ id: "cap-1" }, { id: "cap-2" }],
    context,
  });

  const created = runStore.createAgentRun(prepared, "目标：创建文件");
  assert.equal(created.id, prepared.trace.runId);
  assert.equal(created.status, "created");
  assert.equal(created.goal, "目标：创建文件");
  assert.equal(created.correlationId, prepared.trace.correlationId);
  assert.equal(created.taskId, "task-parent");
  assert.equal(created.projectId, "proj-1");
  assert.equal(created.appId, "app-1");
  assert.equal(created.userId, "u1");
  assert.equal(created.entryPoint, "project");
  assert.equal(created.rootRunId, prepared.trace.runId);
  assert.equal(created.delegationDepth, 0);
  assert.equal(created.capabilityCount, 2);
  assert.deepEqual(created.capabilityIds, ["cap-1", "cap-2"]);
  assert.deepEqual(created.context, [
    { id: "project.memories", source: "memory", trust: "trusted" },
    { id: "app.context", source: "app", trust: "untrusted" },
  ]);
  assert.equal(created.createdAt, prepared.trace.createdAt);
  assert.equal(created.updatedAt, prepared.trace.createdAt);
  // 幂等：同一 runId 重复 create 返回既有行，不覆盖 goal
  assert.equal(runStore.createAgentRun(prepared, "改目标").goal, "目标：创建文件");

  const runRow = db.prepare("SELECT * FROM agent_runs WHERE id=?").get(prepared.trace.runId);
  assert.equal(runRow.status, "created");
  assert.equal(runRow.goal, "目标：创建文件");
  assert.equal(runRow.capability_count, 2);
  assert.equal(runRow.capability_ids_json, JSON.stringify(["cap-1", "cap-2"]));
  assert.equal(runRow.context_json, JSON.stringify([
    { id: "project.memories", source: "memory", trust: "trusted" },
    { id: "app.context", source: "app", trust: "untrusted" },
  ]));
  assert.equal(runRow.root_run_id, prepared.trace.runId);
  assert.equal(runRow.delegation_depth, 0);
  assert.equal(runRow.started_at, null);

  const createdEvents = runStore.listAgentRunEvents(prepared.trace.runId);
  assert.equal(createdEvents.length, 1);
  assert.equal(createdEvents[0].type, "created");
  assert.equal(createdEvents[0].sequence, 1);
  assert.equal(createdEvents[0].correlationId, prepared.trace.correlationId);
  assert.equal(createdEvents[0].taskId, "task-parent");
  assert.equal(createdEvents[0].projectId, "proj-1");
  assert.deepEqual(createdEvents[0].data, { capabilityCount: 2, contextSections: ["project.memories", "app.context"] });
  assert.equal(db.prepare("SELECT COUNT(*) AS value FROM agent_run_events WHERE run_id=?").get(prepared.trace.runId).value, 1);

  const running = runStore.startAgentRun(prepared.trace.runId);
  assert.equal(running.status, "running");
  assert.equal(typeof running.startedAt, "number");
  // 重复 start 不新增事件
  assert.equal(runStore.startAgentRun(prepared.trace.runId).status, "running");
  assert.equal(runStore.listAgentRunEvents(prepared.trace.runId).length, 2);
  assert.equal(runStore.listAgentRunEvents(prepared.trace.runId)[1].type, "running");
  assert.equal(db.prepare("SELECT started_at FROM agent_runs WHERE id=?").get(prepared.trace.runId).started_at, running.startedAt);

  // sequence 自增 + 事件 data 脱敏（agent-kernel-store.cjs:85-104）
  const third = runStore.appendAgentRunEvent(prepared.trace.runId, "capability.started", { tool: "file.create", apiKey: "sk-abcdefghijklmnop", nested: { accessToken: "abc" } });
  assert.equal(third.sequence, 3);
  assert.equal(third.data.tool, "file.create");
  assert.equal(third.data.apiKey, "[REDACTED]");
  assert.equal(third.data.nested.accessToken, "[REDACTED]");
  assert.equal(runStore.appendAgentRunEvent(prepared.trace.runId, "capability.completed", { ok: true }).sequence, 4);

  const waiting = runStore.waitAgentRun(prepared.trace.runId, "要继续吗？");
  assert.equal(waiting.status, "waiting_user");
  const waitingEvent = runStore.listAgentRunEvents(prepared.trace.runId).find((event) => event.type === "waiting_user");
  assert.equal(waitingEvent.sequence, 5);
  assert.deepEqual(waitingEvent.data, { question: "要继续吗？" });

  // after 分页
  assert.deepEqual(runStore.listAgentRunEvents(prepared.trace.runId, 3).map((event) => event.sequence), [4, 5]);

  const completed = runStore.completeAgentRun(prepared.trace.runId, { outputFile: "a.txt", accessToken: "abc" });
  assert.equal(completed.status, "completed");
  assert.equal(completed.result.outputFile, "a.txt");
  assert.equal(completed.result.accessToken, "[REDACTED]");
  assert.equal(typeof completed.completedAt, "number");
  const seqs = runStore.listAgentRunEvents(prepared.trace.runId).map((event) => event.sequence);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6]);
  assert.equal(runStore.listAgentRunEvents(prepared.trace.runId).at(-1).type, "completed");
  const finalRow = db.prepare("SELECT * FROM agent_runs WHERE id=?").get(prepared.trace.runId);
  assert.equal(finalRow.status, "completed");
  assert.equal(finalRow.result_json, JSON.stringify(completed.result));
  assert.equal(finalRow.completed_at, completed.completedAt);

  // waitAgentRun 没有终态短路（agent-kernel-store.cjs:163-165 与 155/168/175/183 不同），
  // 会把已完成的 Run 改回 waiting_user —— 与源一致地只在 start/complete/fail/cancel 上短路。
  assert.equal(runStore.waitAgentRun(prepared.trace.runId, "x").status, "waiting_user");
  assert.equal(runStore.listAgentRunEvents(prepared.trace.runId).at(-1).type, "waiting_user");
  assert.equal(runStore.completeAgentRun(prepared.trace.runId, { accessToken: "abc" }).status, "completed");

  // 终态不复活（agent-kernel-store.cjs:155-187 的三个短路函数）
  assert.equal(runStore.failAgentRun(prepared.trace.runId, new Error("late")).status, "completed");
  assert.equal(runStore.cancelAgentRun(prepared.trace.runId).status, "completed");
  assert.equal(runStore.startAgentRun(prepared.trace.runId).status, "completed");

  assert.deepEqual(runStore.listAgentRuns("u1").map((run) => run.id), [prepared.trace.runId]);
  assert.deepEqual(runStore.listAgentRuns("u1", "proj-1").map((run) => run.id), [prepared.trace.runId]);
  assert.deepEqual(runStore.listAgentRuns("other"), []);
  assert.equal(runStore.findAgentRunByTask("task-parent").id, prepared.trace.runId);
  assert.equal(runStore.findAgentRunByTask("no-task"), undefined);
  assert.equal(runStore.getAgentRun("no-run"), undefined);
});

test("runStore：failed / cancelled 落库、错误脱敏与按任务取消", () => {
  const db = newDb();
  configureKernel(db);

  const failed = makePrepared({ trace: { taskId: "task-fail" } });
  runStore.createAgentRun(failed, "失败目标");
  runStore.startAgentRun(failed.trace.runId);
  const failedRun = runStore.failAgentRun(failed.trace.runId, new Error("模型返回 token=abc123secret"));
  assert.equal(failedRun.status, "failed");
  assert.match(failedRun.errorMessage, /token=\[REDACTED\]/);
  const failedRow = db.prepare("SELECT * FROM agent_runs WHERE id=?").get(failed.trace.runId);
  assert.equal(failedRow.status, "failed");
  assert.ok(failedRow.completed_at > 0);
  const failedEvents = runStore.listAgentRunEvents(failed.trace.runId);
  assert.equal(failedEvents.at(-1).type, "failed");
  assert.equal(failedEvents.at(-1).data.message, failedRun.errorMessage);

  const cancelled = makePrepared({ trace: { taskId: "task-cancel" } });
  runStore.createAgentRun(cancelled, "取消目标");
  assert.equal(runStore.cancelAgentRun(cancelled.trace.runId).status, "cancelled");
  assert.equal(runStore.listAgentRunEvents(cancelled.trace.runId).at(-1).type, "cancelled");
  assert.equal(runStore.startAgentRun(cancelled.trace.runId).status, "cancelled");
  assert.equal(runStore.completeAgentRun(cancelled.trace.runId, {}).status, "cancelled");

  const byTask = makePrepared({ trace: { taskId: "task-by" } });
  runStore.createAgentRun(byTask, "按任务取消");
  assert.equal(runStore.cancelAgentRunByTask("task-by").status, "cancelled");
  assert.equal(runStore.cancelAgentRunByTask("no-such"), undefined);
  assert.throws(() => runStore.appendAgentRunEvent("no-such", "x"), /Agent Run 不存在/);
});

test("runStore：redactSecrets / redactString 脱敏与预算（agent-kernel-store.cjs:20-34）", () => {
  assert.equal(runStore.redactString("Authorization: Bearer abc.def.ghi"), "Authorization: Bearer [REDACTED]");
  assert.equal(runStore.redactString("sk-abcdefghijklmnop"), "[REDACTED]");
  assert.equal(runStore.redactString("api_key=supersecret"), "api_key=[REDACTED]");
  assert.equal(runStore.redactString("x".repeat(13000)).length, 13000);
  assert.equal(runStore.redactSecrets("x".repeat(13000)).length, 12000);
  assert.equal(runStore.redactSecrets({ access_token: "t" }).access_token, "[REDACTED]");
  assert.equal(runStore.redactSecrets({ a: { b: { c: { d: { e: { f: { g: "deep" } } } } } } }).a.b.c.d.e.f.g, "[TRUNCATED]");
  assert.equal(runStore.redactSecrets(Array.from({ length: 150 }, (_, i) => i)).length, 100);
});

// ---------------------------------------------------------------------------
// 4) supervisor：profile / 委派上限 / delegateAgentWork / 并行闸门
// ---------------------------------------------------------------------------

function makeParentTaskRow(id, over = {}) {
  return Object.assign({
    id, thread_id: "thread-1", root_task_id: "root-task", instruction: "父指令",
    title: "父任务", status: "running", permission_grant_json: "[]",
  }, over);
}

function seedParentRun(db, taskStore, over = {}) {
  const taskId = over.taskId || "parent-task";
  taskStore.tasks.set(taskId, makeParentTaskRow(taskId, over.taskRow || {}));
  const prepared = makePrepared({
    trace: Object.assign({ taskId, projectId: "proj-1", userId: "u1", entryPoint: "project" }, over.trace || {}),
    capabilities: over.capabilities || [{ id: "file:src1:read_file" }, { id: "file:src2:write_file" }, { id: "file:src3:risky" }],
  });
  runStore.createAgentRun(prepared, over.goal || "父目标");
  return { prepared, runId: prepared.trace.runId, taskId };
}

function delegationDescriptors() {
  return [
    toolDescriptor({ name: "read_file", capabilityId: "file:src1:read_file", risk: "read" }),
    toolDescriptor({ name: "write_file", sourceId: "src2", capabilityId: "file:src2:write_file", risk: "write" }),
    toolDescriptor({ name: "risky_delete", sourceId: "src3", capabilityId: "file:src3:risky", risk: "delete" }),
  ];
}

function supervisorAdapters(descriptors, over = {}) {
  const tools = { descriptors, openaiTools: descriptors.map((descriptor) => ({ type: "function", function: { name: descriptor.name } })) };
  return Object.assign({
    modelResolver: makeModelResolver([makeModelRoute()]),
    toolResolver: makeToolResolver(tools),
    providers: () => [makeProvider("p1", "供应商一", ["m1"])],
    workspaceStore: {
      ensureRunWorkspace() {}, abandonRunWorkspace() {}, recordReviewerDecision() {},
      artifactReviewState: () => ({ required: false }),
    },
    schemaValidator: { validateJsonSchemaDefinition: () => [] },
  }, over);
}

test("supervisor：listAgentProfiles / getAgentProfile / capabilityGrantForProfile（agent-kernel-supervisor.cjs:66-102）", () => {
  const db = seedProfiles(newDb());
  configureKernel(db);

  const profiles = supervisor.listAgentProfiles();
  assert.deepEqual(profiles.map((profile) => profile.id), ["maker", "reviewer"]);
  assert.equal(profiles[0].name, "Maker");
  assert.deepEqual(profiles[0].capabilityScopes, ["file:*", "app:*"]);
  assert.deepEqual(profiles[0].allowedRisks, ["read", "write"]);
  assert.deepEqual(profiles[0].budget, { modelCalls: 10, toolCalls: 20 });
  assert.equal(profiles[0].builtin, true);
  assert.equal(profiles[0].enabled, true);

  db.prepare("UPDATE agent_profiles SET enabled=0 WHERE id=?").run("reviewer");
  assert.deepEqual(supervisor.listAgentProfiles().map((profile) => profile.id), ["maker"]);
  assert.equal(supervisor.getAgentProfile("reviewer"), undefined);
  assert.equal(supervisor.getAgentProfile("no-such"), undefined);

  assert.deepEqual(supervisor.capabilityGrantForProfile(["file:src1:read_file", "app:app1:x", "mcp:a:b"], "maker"), ["file:src1:read_file", "app:app1:x"]);
  assert.deepEqual(supervisor.capabilityGrantForProfile(["file:a", "file:b"], "maker", ["file:a", "file:a"]), ["file:a"]);
  assert.throws(
    () => supervisor.capabilityGrantForProfile(["file:a", "mcp:a:b"], "maker", ["mcp:a:b"]),
    /子 Agent 请求了未继承的能力：mcp:a:b/,
  );
  assert.throws(() => supervisor.capabilityGrantForProfile([], "no-such"), /Agent Profile 不存在或未启用：no-such/);
});

test("supervisor：delegateAgentWork 创建子 Run、按 grant+allowedRisks 收窄、request_hash 去重（agent-kernel-supervisor.cjs:123-211）", () => {
  const db = seedProfiles(newDb());
  const taskStore = makeFakeTaskStore();
  configureKernel(db, Object.assign(supervisorAdapters(delegationDescriptors()), { taskStore }));
  const parent = seedParentRun(db, taskStore);

  const delegated = supervisor.delegateAgentWork(parent.runId, "u1", [
    { key: "producer", instruction: "写文件 a.txt", agentProfileId: "maker", capabilityIds: ["file:src1:read_file", "file:src2:write_file"] },
  ]);
  assert.equal(delegated.parentRunId, parent.runId);
  assert.deepEqual(delegated.limits, { maxDepth: 3, maxChildrenPerRun: 8, maxParallelPerRoot: 3 });
  assert.equal(delegated.children.length, 1);
  const child = delegated.children[0];
  assert.equal(child.key, "producer");
  assert.equal(child.childTask.agentProfileId, "maker");
  assert.equal(child.childTask.delegation_depth, 1);
  assert.equal(child.childTask.parentTaskId, parent.taskId);
  assert.equal(child.childRun.status, "created");
  assert.equal(child.childRun.parentRunId, parent.runId);
  assert.equal(child.childRun.rootRunId, parent.runId);
  assert.equal(child.childRun.delegationDepth, 1);
  assert.equal(child.childRun.taskId, child.childTask.id);
  assert.deepEqual(child.childRun.capabilityIds, ["file:src1:read_file", "file:src2:write_file"]);
  assert.equal(child.childRun.capabilityCount, 2);
  assert.deepEqual(JSON.parse(taskStore.tasks.get(child.childTask.id).permission_grant_json), ["file:src1:read_file", "file:src2:write_file"]);
  assert.ok(child.childRun.goal.includes("写文件 a.txt"));

  const delegationRow = db.prepare("SELECT * FROM agent_delegations WHERE parent_run_id=?").get(parent.runId);
  assert.equal(delegationRow.child_run_id, child.childRun.id);
  assert.equal(delegationRow.child_task_id, child.childTask.id);
  assert.equal(delegationRow.agent_profile_id, "maker");
  assert.equal(delegationRow.ordinal, 1);
  assert.equal(delegationRow.status, "created");
  assert.equal(typeof delegationRow.request_hash, "string");
  assert.equal(runStore.listAgentRunEvents(parent.runId).some((event) => event.type === "child.created"), true);

  assert.throws(
    () => supervisor.delegateAgentWork(parent.runId, "u1", [{ key: "a", instruction: "a", agentProfileId: "maker", dependsOn: ["b"] }]),
    /只能依赖本批次中排在它之前的任务：b/,
  );
  assert.throws(
    () => supervisor.delegateAgentWork(parent.runId, "u1", [{ key: "producer-copy", instruction: "写文件 a.txt", agentProfileId: "maker", capabilityIds: ["file:src1:read_file", "file:src2:write_file"] }]),
    (error) => error.statusCode === 409 && /检测到重复委派/.test(error.message),
  );

  const withReviewer = supervisor.delegateAgentWork(parent.runId, "u1", [
    { key: "producer2", instruction: "再写一个文件 b.txt", agentProfileId: "maker", capabilityIds: ["file:src1:read_file", "file:src2:write_file"] },
    { key: "review2", instruction: "复核 b.txt", agentProfileId: "reviewer", dependsOn: ["producer2"] },
  ]);
  const reviewerChild = withReviewer.children[1];
  assert.deepEqual(reviewerChild.childRun.capabilityIds, ["file:src1:read_file"]);
  assert.ok(taskStore.tasks.get(reviewerChild.childTask.id).expectedOutputSchema);
  const producerTaskId = withReviewer.children[0].childTask.id;
  assert.equal(reviewerChild.childTask.dependsOn[0], producerTaskId);
});

test("supervisor：delegateAgentWork 前置校验拒绝（agent-kernel-supervisor.cjs:124-152）", () => {
  const db = seedProfiles(newDb());
  const taskStore = makeFakeTaskStore();
  configureKernel(db, Object.assign(supervisorAdapters(delegationDescriptors()), { taskStore }));

  const unbound = makePrepared({ trace: { taskId: undefined, projectId: undefined } });
  runStore.createAgentRun(unbound, "无任务目标");
  assert.throws(() => supervisor.delegateAgentWork(unbound.trace.runId, "u1", [{ key: "k", instruction: "x", agentProfileId: "maker" }]), /只有绑定项目任务的 Agent Run 才能委派子 Agent/);

  const parent = seedParentRun(db, taskStore);
  assert.throws(() => supervisor.delegateAgentWork(parent.runId, "u2", [{ key: "k", instruction: "x", agentProfileId: "maker" }]), /不能代替其他用户委派 Agent/);
  runStore.completeAgentRun(parent.runId, {});
  assert.throws(() => supervisor.delegateAgentWork(parent.runId, "u1", [{ key: "k", instruction: "x", agentProfileId: "maker" }]), /已结束的 Agent Run 不能继续委派/);

  const missing = seedParentRun(db, taskStore, { taskId: "missing-task" });
  taskStore.tasks.delete("missing-task");
  assert.throws(() => supervisor.delegateAgentWork(missing.runId, "u1", [{ key: "k", instruction: "x", agentProfileId: "maker" }]), /父任务不存在/);

  const valid = seedParentRun(db, taskStore, { taskId: "valid-task" });
  assert.throws(() => supervisor.delegateAgentWork(valid.runId, "u1", []), /至少需要一个子 Agent 委派/);
  assert.throws(() => supervisor.delegateAgentWork(valid.runId, "u1", [{ key: "bad key", instruction: "x", agentProfileId: "maker" }]), /子任务 key 无效或重复：bad key/);
  assert.throws(() => supervisor.delegateAgentWork(valid.runId, "u1", [{ key: "dup", instruction: "x", agentProfileId: "maker" }, { key: "dup", instruction: "y", agentProfileId: "maker" }]), /子任务 key 无效或重复：dup/);
  assert.throws(() => supervisor.delegateAgentWork(valid.runId, "u1", [{ key: "k", instruction: "   ", agentProfileId: "maker" }]), /子任务 k 缺少 instruction/);
  assert.throws(() => supervisor.delegateAgentWork(valid.runId, "u1", [{ key: "k", instruction: "x", agentProfileId: "ghost" }]), /Agent Profile 不存在或未启用：ghost/);
  assert.throws(
    () => supervisor.delegateAgentWork(valid.runId, "u1", [
      { key: "a", instruction: "a", agentProfileId: "maker" },
      { key: "b", instruction: "b", agentProfileId: "maker" },
      { key: "rev", instruction: "r", agentProfileId: "reviewer", dependsOn: ["a", "b"] },
    ]),
    /Reviewer rev 最多只能依赖一个 Producer/,
  );
});

test("supervisor：深度 3 / 每 Run 最多 8 个子逐条拒绝（agent-kernel-supervisor.cjs:36-37,104-108,132,145-146）", () => {
  const db = seedProfiles(newDb());
  const taskStore = makeFakeTaskStore();
  configureKernel(db, Object.assign(supervisorAdapters(delegationDescriptors()), { taskStore }));

  assert.deepEqual(supervisor.SUPERVISOR_LIMITS, { maxDepth: 3, maxChildrenPerRun: 8, maxParallelPerRoot: 3 });

  const bulk = seedParentRun(db, taskStore, { taskId: "bulk-task" });
  const nine = Array.from({ length: 9 }, (_, index) => ({ key: "k" + index, instruction: "任务 " + index, agentProfileId: "maker" }));
  assert.throws(() => supervisor.delegateAgentWork(bulk.runId, "u1", nine), /每次最多委派 8 个子 Agent/);

  const full = seedParentRun(db, taskStore, { taskId: "full-task" });
  const insertDelegation = db.prepare("INSERT INTO agent_delegations(id,parent_run_id,child_run_id,parent_task_id,child_task_id,agent_profile_id,ordinal,depends_on_json,expected_output_schema,permission_grant_json,status,created_at,updated_at,request_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  for (let index = 1; index <= 8; index += 1) {
    insertDelegation.run("deleg-" + index, full.runId, "child-run-" + index, full.taskId, "child-task-insert-" + index, "maker", index, "[]", null, "[]", "created", nextClock(), nextClock(), "hash-" + index);
  }
  assert.throws(
    () => supervisor.delegateAgentWork(full.runId, "u1", [{ key: "extra", instruction: "第九个", agentProfileId: "maker" }]),
    /每个 Run 最多委派 8 个子 Agent/,
  );

  const deep = seedParentRun(db, taskStore, { taskId: "deep-task", trace: { delegationDepth: 3 } });
  assert.throws(
    () => supervisor.delegateAgentWork(deep.runId, "u1", [{ key: "leaf", instruction: "叶子", agentProfileId: "maker" }]),
    /Agent 委派深度不能超过 3 层/,
  );

  const depth2 = seedParentRun(db, taskStore, { taskId: "depth2-task", trace: { delegationDepth: 2 } });
  const allowed = supervisor.delegateAgentWork(depth2.runId, "u1", [{ key: "leaf", instruction: "叶子", agentProfileId: "maker" }]);
  assert.equal(allowed.children[0].childRun.delegationDepth, 3);
  assert.equal(allowed.children[0].childTask.delegation_depth, 3);
});

test("supervisor：并行上限 3 的真实闸门在 agent-task-store.claimNextTask（agent-task-store.cjs:1231）", () => {
  const db = newDb();
  seedProfiles(db);
  configureKernel(db, {});
  taskStoreModule.resetAgentTaskStoreForTests();
  taskStoreModule.configureAgentTaskStore({ db, clock: nextClock });
  try {
    const insert = db.prepare("INSERT INTO dx_tasks(id,project_id,thread_id,title,instruction,status,created_at,updated_at,root_task_id,delegation_depth,lease_until) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    const ts = nextClock();
    insert.run("root-1", "proj-1", "thread-1", "root", "root", "running", ts, ts, "root-1", 0, null);
    insert.run("c1", "proj-1", "thread-1", "c1", "c1", "running", ts, ts, "root-1", 1, null);
    insert.run("c2", "proj-1", "thread-1", "c2", "c2", "running", ts, ts, "root-1", 1, null);
    insert.run("c3", "proj-1", "thread-1", "c3", "c3", "queued", ts, ts, "root-1", 1, null);

    assert.equal(taskStoreModule.claimNextTask("w1", 5000), undefined);

    db.prepare("UPDATE dx_tasks SET status='completed' WHERE id='c1'").run();
    const claimed = taskStoreModule.claimNextTask("w1", 5000);
    assert.equal(claimed.id, "c3");
    assert.equal(claimed.status, "running");
  } finally {
    taskStoreModule.resetAgentTaskStoreForTests();
  }
});

// ---------------------------------------------------------------------------
// 5) runInspection 快照字段
// ---------------------------------------------------------------------------

test("runInspection：子树 / usage / timing / artifacts / review / recovery / nodeActivity / routing（agent-kernel-inspection.cjs:56-271）", () => {
  const db = seedProfiles(newDb());
  kernel.resetAgentKernelForTests();
  kernel.configureAgentKernel({ db, clock: nextClock });

  const rootPrepared = makePrepared({ trace: { taskId: "root-task", projectId: "proj-1", appId: "app-1", sessionId: "sess-1", userId: "u1", entryPoint: "project" } });
  runStore.createAgentRun(rootPrepared, "根目标");
  runStore.startAgentRun(rootPrepared.trace.runId);
  const rootRunId = rootPrepared.trace.runId;

  const childPrepared = makePrepared({ trace: { taskId: "child-task", projectId: "proj-1", appId: "app-1", sessionId: "sess-1", userId: "u1", parentRunId: rootRunId, rootRunId, delegationDepth: 1 } });
  runStore.createAgentRun(childPrepared, "子目标");
  const childRunId = childPrepared.trace.runId;

  const ts0 = nextClock();
  db.prepare("INSERT INTO agent_artifacts(id,run_id,path,kind,bytes,sha256,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("art-db", rootRunId, "a.txt", "text", 5, "sha", "produced", ts0, ts0);
  db.prepare("INSERT INTO task_attempts(id,task_id,attempt_no,worker_id,lease_token,status,claimed_at,heartbeat_at,lease_until) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("att-1", "root-task", 2, "w1", "lease-1", "running", ts0, ts0, ts0 + 10000);
  db.prepare("INSERT INTO agent_checkpoints(id,run_id,task_id,attempt_no,sequence,schema_version,phase,state_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("cp-1", rootRunId, "root-task", 2, 7, "v1", "iteration", JSON.stringify({ iteration: 4, nextToolIndex: 2 }), ts0);

  runStore.appendAgentRunEvent(rootRunId, "artifact.created", { surfaceArtifact: true, artifactId: "surf-1", bytes: 10 });
  runStore.appendAgentRunEvent(rootRunId, "artifact.created", { surfaceArtifact: true, artifactId: "surf-1", bytes: 10 });
  runStore.appendAgentRunEvent(rootRunId, "artifact.created", { surfaceArtifact: true, artifactId: "surf-2" });
  runStore.appendAgentRunEvent(rootRunId, "capability.completed", {
    intents: ["capability_discover", "image.generate"],
    targets: [
      { intent: "image.generate", providerId: "p1", providerName: "供应商一", model: "m1", mode: "api", operationId: "op1" },
      { intent: "image.generate", providerId: "p1", providerName: "供应商一", model: "m1", mode: "api", operationId: "op1" },
    ],
  });

  const usageEvents = [
    { id: "u1", runId: rootRunId, kind: "model", providerId: "p1", model: "m1", status: "completed", inputTokens: 10, outputTokens: 20, totalTokens: 30, cachedInputTokens: 1, cacheCreationInputTokens: 2, reasoningTokens: 3, latencyMs: 100, createdAt: 111, completedAt: 222 },
    { id: "u2", runId: rootRunId, kind: "tool", toolName: "read_file", status: "completed", latencyMs: 50, createdAt: 112, completedAt: 222 },
    { id: "u3", runId: rootRunId, kind: "model", providerId: "p1", model: "m2", status: "failed", latencyMs: 5, createdAt: 113, completedAt: 222 },
    { id: "u4", runId: rootRunId, kind: "model", providerId: "p1", model: "m3", status: "started", createdAt: 114 },
  ];
  kernel.configureAgentKernel({
    usageStore: { listAgentUsage: () => usageEvents },
    workspaceStore: { artifactReviewState: () => ({ required: false }) },
  });

  const observedAt = rootPrepared.trace.createdAt + 10000;
  const snapshot = inspection.inspectAgentRun(rootRunId, observedAt);

  // run / children
  assert.equal(snapshot.run.id, rootRunId);
  assert.equal(snapshot.run.status, "running");
  assert.equal(snapshot.run.goal, "根目标");
  assert.equal(snapshot.children.length, 1);
  const child = snapshot.children[0];
  assert.equal(child.runId, childRunId);
  assert.equal(child.parentRunId, rootRunId);
  assert.equal(child.depth, 1);
  assert.equal(child.status, "created");
  assert.equal(child.goal, "子目标");
  assert.equal(child.modelCalls, 0);
  assert.equal(child.toolCalls, 0);
  assert.equal(child.queueDurationMs, null);
  assert.equal(child.artifactCount, 0);
  assert.equal(child.artifactBytes, 0);

  // usage 聚合（含 cost 固定 unavailable）
  assert.equal(snapshot.usage.modelCalls, 3);
  assert.equal(snapshot.usage.toolCalls, 1);
  assert.equal(snapshot.usage.recordedInvocations, 4);
  assert.equal(snapshot.usage.failedInvocations, 1);
  assert.equal(snapshot.usage.inputTokens, 10);
  assert.equal(snapshot.usage.outputTokens, 20);
  assert.equal(snapshot.usage.totalTokens, 30);
  assert.equal(snapshot.usage.cachedInputTokens, 1);
  assert.equal(snapshot.usage.cacheCreationInputTokens, 2);
  assert.equal(snapshot.usage.reasoningTokens, 3);
  assert.equal(snapshot.usage.callLatencyMs, 155);
  assert.equal(snapshot.usage.cost, null);
  assert.equal(snapshot.usage.costSource, "unavailable");

  // timing
  assert.equal(snapshot.timing.queueDurationMs, snapshot.run.startedAt - snapshot.run.createdAt);
  assert.equal(snapshot.timing.wallDurationMs, observedAt - snapshot.run.createdAt);
  assert.equal(snapshot.timing.executionDurationMs, observedAt - snapshot.run.startedAt);

  // artifacts：agent_artifacts 一行 + surfaceArtifact 去重/unknownBytes
  assert.equal(snapshot.artifacts.count, 3);
  assert.equal(snapshot.artifacts.bytes, 15);
  assert.equal(snapshot.artifacts.unknownBytes, 1);

  // review / corrections
  assert.deepEqual(snapshot.review, { required: false, state: "not_required", feedback: [], items: [] });
  assert.deepEqual(snapshot.corrections, []);

  // recovery
  assert.deepEqual(snapshot.recovery[rootRunId], {
    attemptNo: 2, attemptStatus: "running", checkpointSequence: 7, checkpointPhase: "iteration",
    checkpointAt: ts0, iteration: 4, nextToolIndex: 2,
  });
  assert.deepEqual(snapshot.recovery[childRunId], {
    attemptNo: 0, attemptStatus: "none", checkpointSequence: null, checkpointPhase: null,
    checkpointAt: null, iteration: null, nextToolIndex: null,
  });

  // nodeActivity
  assert.deepEqual(snapshot.nodeActivity[rootRunId].recorded, { modelCalls: 3, toolCalls: 1 });
  assert.equal(snapshot.nodeActivity[rootRunId].active.length, 1);
  assert.equal(snapshot.nodeActivity[rootRunId].active[0].id, "u4");
  assert.equal(snapshot.nodeActivity[rootRunId].active[0].kind, "model");
  assert.equal(snapshot.nodeActivity[rootRunId].recent.length, 4);
  assert.equal(snapshot.nodeActivity[rootRunId].recent[0].id, "u4");
  assert.equal(snapshot.nodeActivity[rootRunId].recent[0].status, "started");
  assert.equal(snapshot.nodeActivity[rootRunId].recent[3].completedAt, 222);
  assert.deepEqual(snapshot.nodeActivity[childRunId].recorded, { modelCalls: 0, toolCalls: 0 });

  // routing
  assert.deepEqual(snapshot.routing[rootRunId].activatedIntents, ["image.generate"]);
  assert.equal(snapshot.routing[rootRunId].selectedTargets.length, 1);
  assert.equal(snapshot.routing[rootRunId].selectedTargets[0].operationId, "op1");
  assert.equal(snapshot.routing[rootRunId].modelAttempts.length, 3);

  // expectedScope 403 / 匹配放行
  const scope = { rootRunId, projectId: "proj-1", appId: "app-1", sessionId: "sess-1", userId: "u1" };
  assert.throws(() => inspection.inspectAgentRun(rootRunId, observedAt, Object.assign({}, scope, { projectId: "other" })), (error) => error.statusCode === 403);
  assert.equal(inspection.inspectAgentRun(rootRunId, observedAt, scope).run.id, rootRunId);

  // 不存在的 Run → 404
  assert.throws(() => inspection.inspectAgentRun("no-run", observedAt), (error) => error.statusCode === 404);
});

test("runInspection：usageStore / workspaceStore 未注入时抛 AGENT_DEPENDENCY_UNAVAILABLE（agent-kernel-inspection.cjs:29-40）", () => {
  const db = seedProfiles(newDb());
  configureKernel(db);
  const prepared = makePrepared({ trace: { taskId: "dep-task" } });
  runStore.createAgentRun(prepared, "依赖目标");

  assert.throws(() => inspection.inspectAgentRun(prepared.trace.runId), (error) => error.code === kernel.AGENT_DEPENDENCY_UNAVAILABLE && error.dependency === "usageStore");
  kernel.configureAgentKernel({ usageStore: { listAgentUsage: () => [] } });
  assert.throws(() => inspection.inspectAgentRun(prepared.trace.runId), (error) => error.code === kernel.AGENT_DEPENDENCY_UNAVAILABLE && error.dependency === "workspaceStore");
  kernel.configureAgentKernel({ usageStore: { listAgentUsage: () => [] }, workspaceStore: { artifactReviewState: () => ({ required: false }) } });
  assert.equal(inspection.inspectAgentRun(prepared.trace.runId).run.id, prepared.trace.runId);
});

// ---------------------------------------------------------------------------
// 6) 依赖门：modelAdapter / toolRunner / fsAdapter
// ---------------------------------------------------------------------------

test("依赖门：未注入 modelAdapter / toolRunner / fsAdapter 时抛结构化 AGENT_DEPENDENCY_UNAVAILABLE（agent-kernel.cjs:33,91-111）", () => {
  kernel.resetAgentKernelForTests();
  const deps = kernel.getAgentKernelDependencies();
  assert.equal(deps.modelAdapter, null);
  assert.equal(deps.toolRunner, null);
  assert.equal(deps.fsAdapter, null);

  for (const name of ["modelAdapter", "toolRunner", "fsAdapter"]) {
    try {
      kernel.requireAdapter(name, deps[name]);
      assert.fail("应当抛出：" + name);
    } catch (error) {
      assert.equal(error.code, kernel.AGENT_DEPENDENCY_UNAVAILABLE);
      assert.equal(error.dependency, name);
      assert.equal(error.message, "Agent 内核依赖不可用：" + name + "（需通过 configureAgentKernel 注入）");
    }
  }

  try {
    kernel.requireDb();
    assert.fail("应当抛出：db");
  } catch (error) {
    assert.equal(error.code, kernel.AGENT_DEPENDENCY_UNAVAILABLE);
    assert.equal(error.dependency, "db");
  }

  const modelAdapter = { call() {} };
  const toolRunner = { run() {} };
  const fsAdapter = { read() {} };
  kernel.configureAgentKernel({ modelAdapter, toolRunner, fsAdapter });
  const injected = kernel.getAgentKernelDependencies();
  assert.equal(kernel.requireAdapter("modelAdapter", injected.modelAdapter), modelAdapter);
  assert.equal(kernel.requireAdapter("toolRunner", injected.toolRunner), toolRunner);
  assert.equal(kernel.requireAdapter("fsAdapter", injected.fsAdapter), fsAdapter);
});
