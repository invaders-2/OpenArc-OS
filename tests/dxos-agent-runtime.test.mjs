/**
 * B3c · DX OS Agent 运行时回归测试。
 *
 * 覆盖任务书 B3c E 条：
 *   1) 请求信封解析与 Schema 校验（合法/非法）
 *   2) 中间件管线顺序与错误处理
 *   3) runManager 生命周期（created→running→waiting_user→completed 与失败态）+ 检查点落库
 *   4) serverToolLoop：模型 tool_calls → toolRunner → 结果回填 → 二次模型 → 收敛 / 迭代上限 / 工具失败
 *   5) usageStore 落 agent_usage_events（model/tool 两类）
 *   6) workspaceStore：ensure/commit/conflict/abandon + assertRunWorkspaceWrite 越界拒绝
 *
 * 全部离线：db 用 node:sqlite 内存库；fsAdapter 用注入的假虚拟文件树；
 * 检查点优先调用真实的 electron/agent-task-store.cjs（B3a）以保证接口对齐，
 * 该文件尚未落地时退回同语义本地实现，并把"是否真实模块"记录在 REAL_CHECKPOINT 上。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const foundationSchema = require("../electron/dxos-foundation-schema.cjs");
const agentSchema = require("../electron/dxos-agent-schema.cjs");
const deps = require("../electron/agent-runtime-deps.cjs");
const envelope = require("../electron/agent-runtime-envelope.cjs");
const profiles = require("../electron/agent-runtime-profiles.cjs");
const fallback = require("../electron/agent-runtime-fallback.cjs");
const usage = require("../electron/agent-runtime-usage.cjs");
const workspace = require("../electron/agent-runtime-workspace.cjs");
const managerModule = require("../electron/agent-runtime-manager.cjs");
const toolLoop = require("../electron/agent-runtime-tool-loop.cjs");

// ---------------------------------------------------------------------------
// B3a 真实检查点实现探测
// ---------------------------------------------------------------------------

function loadRealTaskStore() {
  try {
    return require("../electron/agent-task-store.cjs");
  } catch {
    return null;
  }
}
const REAL_TASK_STORE = loadRealTaskStore();
function loadRealKernel() {
  try {
    return require("../electron/agent-kernel.cjs");
  } catch {
    return null;
  }
}
function loadRealKernelStore() {
  try {
    return require("../electron/agent-kernel-store.cjs");
  } catch {
    return null;
  }
}
const REAL_KERNEL = loadRealKernel();
const REAL_KERNEL_STORE = loadRealKernelStore();

// ---------------------------------------------------------------------------
// 测试基础设施
// ---------------------------------------------------------------------------

function newDb() {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const statement of foundationSchema.dxosDdl()) db.exec(statement);
  for (const statement of agentSchema.dxosAgentDdl()) db.exec(statement);
  return db;
}

let clockTick = 1_700_000_000_000;
function nextClock() {
  clockTick += 1;
  return clockTick;
}

function runView(row) {
  if (!row) return undefined;
  return {
    id: row.id, correlationId: row.correlation_id,
    causationId: row.causation_id || undefined,
    sessionId: row.session_id || undefined,
    taskId: row.task_id || undefined,
    projectId: row.project_id || undefined,
    appId: row.app_id || undefined,
    userId: row.user_id || undefined,
    parentRunId: row.parent_run_id || undefined,
    rootRunId: row.root_run_id || undefined,
    agentProfileId: row.agent_profile_id || undefined,
    entryPoint: row.entry_point, status: row.status, goal: row.goal,
    result: row.result_json ? JSON.parse(row.result_json) : undefined,
    errorMessage: row.error_message || undefined,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** 本地 runStore（server/agent-kernel/runStore.ts:60-178 的同语义最小实现，供测试注入）。 */
function createLocalRunStore(db) {
  function getAgentRun(id) {
    return runView(db.prepare("SELECT * FROM agent_runs WHERE id=?").get(id));
  }
  function appendAgentRunEvent(runId, type, data) {
    const run = db.prepare("SELECT * FROM agent_runs WHERE id=?").get(runId);
    if (!run) throw new Error("Agent Run 不存在");
    const sequence = db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS value FROM agent_run_events WHERE run_id=?").get(runId).value;
    const id = randomUUID();
    db.prepare("INSERT INTO agent_run_events(id,run_id,sequence,type,correlation_id,causation_id,data_json,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, runId, sequence, type, run.correlation_id, run.causation_id, data === undefined ? null : JSON.stringify(data), nextClock());
    return { id, type, runId, sequence };
  }
  function createAgentRun(prepared, goal) {
    const trace = prepared.trace;
    if (getAgentRun(trace.runId)) return getAgentRun(trace.runId);
    const ts = trace.createdAt || nextClock();
    db.prepare("INSERT INTO agent_runs(id,correlation_id,causation_id,session_id,task_id,project_id,app_id,user_id,entry_point,status,goal,context_json,capability_count,created_at,updated_at,parent_run_id,root_run_id,agent_profile_id,delegated_by_run_id,capability_ids_json,delegation_depth) VALUES (?,?,?,?,?,?,?,?,?,'created',?,?,?,?,?,?,?,?,?,?,?)")
      .run(trace.runId, trace.correlationId, trace.causationId || null, trace.sessionId || null, trace.taskId || null, trace.projectId || null, trace.appId || null, trace.userId || null, trace.entryPoint, goal, "[]", 0, ts, ts, trace.parentRunId || null, trace.rootRunId || trace.runId, trace.agentProfileId || null, trace.delegatedByRunId || null, "[]", 0);
    appendAgentRunEvent(trace.runId, "created", {});
    return getAgentRun(trace.runId);
  }
  function transition(runId, status, fields = {}) {
    const ts = nextClock();
    db.prepare("UPDATE agent_runs SET status=?,result_json=?,error_message=?,updated_at=?,started_at=CASE WHEN ?='running' THEN COALESCE(started_at,?) ELSE started_at END,completed_at=CASE WHEN ? IN ('completed','failed','cancelled') THEN ? ELSE completed_at END WHERE id=?")
      .run(status, fields.result === undefined ? null : JSON.stringify(fields.result), fields.error ?? null, ts, status, ts, status, ts, runId);
    return getAgentRun(runId);
  }
  return {
    getAgentRun, appendAgentRunEvent, createAgentRun,
    startAgentRun(runId) {
      const cur = getAgentRun(runId);
      if (!cur || cur.status === "running" || ["completed", "failed", "cancelled"].includes(cur.status)) return cur;
      transition(runId, "running");
      appendAgentRunEvent(runId, "running");
      return getAgentRun(runId);
    },
    waitAgentRun(runId, question) {
      transition(runId, "waiting_user");
      appendAgentRunEvent(runId, "waiting_user", question ? { question } : undefined);
      return getAgentRun(runId);
    },
    completeAgentRun(runId, result) {
      const cur = getAgentRun(runId);
      if (!cur || ["completed", "failed", "cancelled"].includes(cur.status)) return cur;
      transition(runId, "completed", { result });
      appendAgentRunEvent(runId, "completed", result);
      return getAgentRun(runId);
    },
    failAgentRun(runId, error) {
      const cur = getAgentRun(runId);
      if (!cur || ["completed", "failed", "cancelled"].includes(cur.status)) return cur;
      const message = String((error && error.message) || error || "Agent Run 执行失败");
      transition(runId, "failed", { error: message });
      appendAgentRunEvent(runId, "failed", { message });
      return getAgentRun(runId);
    },
    cancelAgentRun(runId) {
      const cur = getAgentRun(runId);
      if (!cur || ["completed", "failed", "cancelled"].includes(cur.status)) return cur;
      transition(runId, "cancelled");
      appendAgentRunEvent(runId, "cancelled");
      return getAgentRun(runId);
    },
  };
}

/** 本地检查点写入（仅当 B3a 模块不可用时兜底；语义同 taskStore.ts:440-447）。 */
function appendCheckpointLocal(db, input) {
  const sequence = db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS value FROM agent_checkpoints WHERE task_id=?").get(input.taskId).value;
  db.prepare("INSERT INTO agent_checkpoints(id,run_id,task_id,attempt_no,sequence,schema_version,phase,state_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(randomUUID(), input.runId, input.taskId, input.attemptNo, sequence, "dx-agent-checkpoint/v1", input.phase, JSON.stringify(input.state), nextClock());
  return sequence;
}

/**
 * 组合注入用 taskStore：run 生命周期走本地最小实现（管理器只消费注入函数），
 * appendAgentCheckpoint 优先调用 B3a 真实模块。
 */
function buildTaskStore(db) {
  const local = createLocalRunStore(db);
  const taskStore = { appendAgentCheckpoint: (input) => appendCheckpointLocal(db, input) };
  let checkpointSource = "local-fallback";
  let runStore = null;
  let runStoreSource = "local";

  // 检查点：优先 B3a electron/agent-task-store.cjs:785 appendAgentCheckpoint（任务 E 明确要求）。
  if (REAL_TASK_STORE && typeof REAL_TASK_STORE.configureAgentTaskStore === "function") {
    try {
      REAL_TASK_STORE.configureAgentTaskStore({ db, clock: nextClock, idFactory: randomUUID });
      if (typeof REAL_TASK_STORE.appendAgentCheckpoint === "function") {
        taskStore.appendAgentCheckpoint = (input) => REAL_TASK_STORE.appendAgentCheckpoint(input);
        checkpointSource = "B3a";
      }
    } catch {
      checkpointSource = "local-fallback";
    }
  }
  // Run 生命周期：优先 B3b electron/agent-kernel-store.cjs（runStore.ts:1-178 的移植）。
  if (REAL_KERNEL_STORE && typeof REAL_KERNEL_STORE.getAgentRun === "function" && REAL_KERNEL) {
    try {
      REAL_KERNEL.configureAgentKernel({ db, clock: nextClock });
      runStore = REAL_KERNEL_STORE;
      runStoreSource = "B3b";
    } catch {
      runStore = null;
    }
  }
  if (!runStore) Object.assign(taskStore, local);
  const getRun = (runId) => (runStore ? runStore.getAgentRun(runId) : taskStore.getAgentRun(runId));
  return { taskStore, runStore, getRun, checkpointSource, runStoreSource };
}

/** 统一注入：B3a taskStore + B3b runStore + 假 kernel/fs。 */
function bootstrapRuntime(db, options = {}) {
  const built = buildTaskStore(db);
  deps.configureAgentRuntime({
    db,
    kernel: options.kernel || testKernel(),
    taskStore: built.taskStore,
    runStore: built.runStore,
    fsAdapter: options.fsAdapter || null,
    clock: nextClock,
    idFactory: randomUUID,
  });
  return built;
}

/** 注入式假虚拟文件树：满足 agent-runtime-workspace.cjs 顶部 fsAdapter 契约。 */
function createFakeFs() {
  let seq = 0;
  let tick = 0;
  const nodes = new Map();
  const blobs = new Map();
  const state = { revision: 0, lastCommitId: null };
  const control = { publishConflict: false };

  const nextId = () => "n" + (++seq);
  function mk(name, type, parentId, ownerId, extra = {}, forcedId) {
    const id = forcedId || nextId();
    const node = { id, name, type, parentId: parentId ?? null, ownerId: ownerId ?? null, content: undefined, mime: undefined, blob: undefined, trashed: false, updated_ts: ++tick, ...extra };
    nodes.set(id, node);
    return node;
  }
  const childrenOf = (parentId) => [...nodes.values()].filter((n) => n.parentId === parentId && !n.trashed);
  const systemRoot = mk("system-root", "folder", null, "system");

  function getNode(id) { return nodes.get(id) || null; }
  function listChildren(parentId) { return { nodes: childrenOf(parentId) }; }
  function ensureSystemRoot() { return systemRoot; }
  function ensureFolder(name, parentId, ownerId) {
    const found = childrenOf(parentId).find((n) => n.type === "folder" && n.name === name);
    return found || mk(name, "folder", parentId, ownerId);
  }
  function createNode({ name, type, parentId, ownerId }) { return mk(name, type, parentId, ownerId); }
  function findByPath(rootId, path) {
    const parts = String(path).split("/").filter(Boolean);
    let cur = getNode(rootId);
    for (const part of parts) {
      if (!cur) return null;
      cur = childrenOf(cur.id).find((n) => n.name === part) || null;
    }
    return cur;
  }
  function copyNode(nodeId, targetParentId) {
    const src = getNode(nodeId);
    if (!src) throw new Error("copyNode: 源节点不存在");
    const copy = mk(src.name, src.type, targetParentId, src.ownerId, { content: src.content, mime: src.mime, blob: src.blob });
    if (src.type === "folder") for (const child of childrenOf(src.id)) copyNode(child.id, copy.id);
    return copy;
  }
  function readBlob(nodeId) {
    const node = getNode(nodeId);
    return node && node.blob ? node.blob : null;
  }
  function stageContentAddressedBlob(data, sha256) {
    const hex = sha256 || createHash("sha256").update(data).digest("hex");
    blobs.set(hex, Buffer.from(data));
    return { sha256: hex };
  }
  function getFsCommitState() { return { revision: state.revision, lastCommitId: state.lastCommitId }; }
  function prepareFsArtifactBatchPlan(rootId, writes, record) {
    const baseRevision = record && Number.isFinite(Number(record.baseRevision)) ? Number(record.baseRevision) : state.revision;
    const upserts = [];
    const resultNodeIds = {};
    for (const write of writes) {
      const existing = findByPath(rootId, write.path);
      const nodeId = existing ? existing.id : nextId();
      resultNodeIds[write.path] = nodeId;
      upserts.push({ ...write, nodeId, existing: Boolean(existing) });
    }
    return { rootId, baseRevision, targetRevision: baseRevision + 1, upserts, resultNodeIds };
  }
  function serializeFsArtifactBatchPlan(plan) {
    return { rootId: plan.rootId, baseRevision: plan.baseRevision, targetRevision: plan.targetRevision, upserts: plan.upserts, resultNodeIds: plan.resultNodeIds };
  }
  function applyWrite(rootId, write) {
    const existing = findByPath(rootId, write.path);
    if (existing) {
      if (write.kind === "text") { existing.content = write.content; existing.updated_ts = ++tick; }
      else { existing.blob = blobs.get(write.blobSha256); existing.mime = write.mime; existing.updated_ts = ++tick; }
      return existing.id;
    }
    const parts = String(write.path).split("/");
    const fileName = parts.pop();
    const parent = parts.length ? findByPath(rootId, parts.join("/")) : getNode(rootId);
    if (!parent) throw new Error("missing parent for " + write.path);
    const node = write.kind === "text"
      ? mk(fileName, "file", parent.id, write.ownerId, { content: write.content }, write.nodeId)
      : mk(fileName, "file", parent.id, write.ownerId, { mime: write.mime, blob: blobs.get(write.blobSha256) }, write.nodeId);
    return node.id;
  }
  function publishFsArtifactBatchPlan(plan, commitId, onPublished) {
    if (control.publishConflict) throw Object.assign(new Error("FS 提交冲突"), { code: "FS_REVISION_CONFLICT" });
    for (const write of plan.upserts) applyWrite(plan.rootId, write);
    state.revision = plan.targetRevision;
    state.lastCommitId = commitId;
    if (onPublished) onPublished();
    return plan.resultNodeIds;
  }
  function collectOrphanContentBlobs() { return { removed: [], kept: [...blobs.keys()] }; }

  return {
    control, nodes, blobs,
    getNode, listChildren, ensureSystemRoot, ensureFolder, createNode, findByPath, copyNode,
    readBlob, stageContentAddressedBlob, getFsCommitState, prepareFsArtifactBatchPlan,
    serializeFsArtifactBatchPlan, publishFsArtifactBatchPlan, collectOrphanContentBlobs,
  };
}

function testKernel() {
  return {
    prepareAgentTurn(input) {
      return {
        trace: {
          runId: input.runId || randomUUID(),
          correlationId: input.correlationId || "corr",
          causationId: input.causationId,
          sessionId: input.sessionId,
          taskId: input.taskId,
          parentRunId: input.parentRunId,
          rootRunId: input.rootRunId,
          agentProfileId: input.agentProfileId,
          projectId: input.projectId,
          appId: input.appId,
          entryPoint: input.entryPoint,
          userId: (input.actor && input.actor.id) || input.userId,
          createdAt: nextClock(),
        },
        route: { toolDescriptors: [], tools: [] },
        capabilities: [],
        context: [],
        systemPromptAdditions: [],
      };
    },
  };
}

function makeEnvelope(overrides = {}) {
  return {
    schema: "dx-agent-request/v1",
    requestId: "req-1",
    source: { type: "desktop" },
    actor: { userId: "u1" },
    session: { sessionId: "s1" },
    scope: { projectId: "p1" },
    goal: "测试目标",
    interactionPolicy: "interactive",
    ...overrides,
  };
}

function insertRun(db, spec) {
  const ts = nextClock();
  db.prepare("INSERT INTO agent_runs(id,correlation_id,causation_id,session_id,task_id,project_id,app_id,user_id,entry_point,status,goal,context_json,capability_count,created_at,updated_at,parent_run_id,root_run_id,agent_profile_id,delegated_by_run_id,capability_ids_json,delegation_depth) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(spec.id, spec.correlationId || "corr-" + spec.id, null, spec.sessionId || null, spec.taskId || null, spec.projectId || null, spec.appId || null, spec.userId || null, spec.entryPoint || "desktop", spec.status || "created", spec.goal || "g", "[]", 0, ts, ts, spec.parentRunId || null, spec.rootRunId || spec.id, spec.agentProfileId || null, null, "[]", 0);
}

function insertDxTask(db, spec) {
  const ts = nextClock();
  db.prepare("INSERT INTO dx_tasks(id,project_id,thread_id,title,instruction,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(spec.id, spec.projectId || "p1", spec.threadId || "th1", spec.title || "t", spec.instruction || "i", spec.status || "running", ts, ts);
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, "期望 code=" + code + "，实际=" + error.code + " / " + error.message);
    return true;
  });
}
function expectStatus(fn, statusCode) {
  assert.throws(fn, (error) => {
    assert.equal(error.statusCode, statusCode, "期望 statusCode=" + statusCode + "，实际=" + error.statusCode + " / " + error.message);
    return true;
  });
}

// ---------------------------------------------------------------------------
// 1. 请求信封 + Schema 校验
// ---------------------------------------------------------------------------

test("envelope：归一化默认值、来源类型与模型偏好", () => {
  const result = envelope.normalizeAgentRequestEnvelopeV1({
    goal: "  写一份周报  ",
    source: { type: "app", appId: "canvas", entryPoint: "agent-panel", channelId: "  ch1  " },
    interactionPolicy: "confirm-risky",
    scope: { projectId: " p1 ", knowledgeScopeIds: ["k1", "k1", "k2", ""] },
    modelPreference: { providerId: "prov", model: "model-x" },
    deliveryTarget: { type: "desktop", targetId: "d1" },
    capabilityBoundary: ["file:*", "media.*"],
  }, { id: "user-9" });
  assert.equal(result.schema, "dx-agent-request/v1");
  assert.equal(result.goal, "写一份周报");
  assert.equal(result.source.type, "app");
  assert.equal(result.source.appId, "canvas");
  assert.equal(result.source.channelId, "ch1");
  assert.equal(result.actor.userId, "user-9");
  assert.equal(result.interactionPolicy, "confirm-risky");
  assert.deepEqual(result.scope.knowledgeScopeIds, ["k1", "k2"]);
  assert.deepEqual(result.modelPreference, { providerId: "prov", model: "model-x" });
  assert.deepEqual(result.deliveryTarget, { type: "desktop", targetId: "d1" });
  assert.deepEqual(result.capabilityBoundary, ["file:*", "media.*"]);
  assert.ok(result.requestId);
});

test("envelope：缺 goal / APP 缺 appId 抛 400，非法枚举回落默认值", () => {
  expectStatus(() => envelope.normalizeAgentRequestEnvelopeV1({ goal: "   " }, { id: "u" }), 400);
  expectStatus(() => envelope.normalizeAgentRequestEnvelopeV1({ goal: "g", source: { type: "app" } }, { id: "u" }), 400);
  const result = envelope.normalizeAgentRequestEnvelopeV1({ goal: "g", source: { type: "not-a-type" }, interactionPolicy: "whatever" }, "u-string");
  assert.equal(result.source.type, "api");
  assert.equal(result.interactionPolicy, "interactive");
  assert.equal(result.actor.userId, "u-string");
});

test("envelope：validateAgentRequestEnvelopeV1 合法/非法判定", () => {
  const valid = envelope.normalizeAgentRequestEnvelopeV1({ goal: "g", source: { type: "desktop" } }, { id: "u1" });
  assert.equal(envelope.validateAgentRequestEnvelopeV1(valid), true);
  assert.equal(envelope.validateAgentRequestEnvelopeV1({ ...valid, schema: "x" }), false);
  assert.equal(envelope.validateAgentRequestEnvelopeV1({ ...valid, goal: "" }), false);
  assert.equal(envelope.validateAgentRequestEnvelopeV1({ ...valid, source: { type: "nope" } }), false);
  assert.equal(envelope.validateAgentRequestEnvelopeV1({ ...valid, actor: {} }), false);
  assert.equal(envelope.validateAgentRequestEnvelopeV1({ ...valid, interactionPolicy: "nope" }), false);
});

test("schemaValidator：类型/必填/枚举/边界/额外字段/深度/属性上限", () => {
  const schema = {
    type: "object",
    required: ["name", "age"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 2, maxLength: 4 },
      age: { type: "integer", minimum: 0, maximum: 120 },
      role: { enum: ["a", "b"] },
      tags: { type: "array", items: { type: "string" }, maxItems: 2 },
    },
  };
  assert.deepEqual(envelope.validateJsonSchema({ name: "ab", age: 30, role: "a", tags: ["x"] }, schema), []);
  const issues = envelope.validateJsonSchema({ name: "a", age: 5.5, role: "z", tags: ["x", "y", "z"], extra: 1 }, schema);
  assert.ok(issues.some((i) => i.path === "$.name" && /长度小于/.test(i.message)));
  assert.ok(issues.some((i) => i.path === "$.age" && /应为 integer/.test(i.message)));
  assert.ok(issues.some((i) => i.path === "$.role" && /enum/.test(i.message)));
  assert.ok(issues.some((i) => i.path === "$.tags" && /元素多于/.test(i.message)));
  assert.ok(issues.some((i) => i.path === "$.extra" && /额外字段/.test(i.message)));
  assert.deepEqual(envelope.validateJsonSchema(1, { type: "number" }).length, 0);
  assert.deepEqual(envelope.validateJsonSchema(1, { type: "string" }).map((i) => i.path), ["$"]);

  let deep = { type: "string" };
  for (let i = 0; i < 14; i += 1) deep = { type: "object", properties: { child: deep } };
  assert.ok(envelope.validateJsonSchemaDefinition(deep).some((i) => /嵌套不能超过/.test(i.message)));
  assert.ok(envelope.validateJsonSchemaDefinition({ $ref: "#/x" }).some((i) => /引用或远程 Schema/.test(i.message)));
  const wide = { type: "object", properties: {} };
  for (let i = 0; i < 257; i += 1) wide.properties["k" + i] = { type: "string" };
  assert.ok(envelope.validateJsonSchemaDefinition(wide).some((i) => /properties 总数/.test(i.message)));
  assert.deepEqual(envelope.validateJsonSchemaDefinition("nope").length, 1);
});

// ---------------------------------------------------------------------------
// 2. 中间件管线
// ---------------------------------------------------------------------------

test("middleware：按 order 执行 before，after 逆序，支持 appliesTo", async () => {
  const log = [];
  const pipeline = new envelope.AgentMiddlewarePipeline([
    { id: "late", order: 20, before: () => log.push("late.before"), after: () => log.push("late.after") },
    { id: "early", order: 10, before: () => log.push("early.before"), after: () => log.push("early.after") },
    { id: "skip", order: 5, appliesTo: () => false, before: () => log.push("skip.before") },
  ]);
  const result = await pipeline.execute({ state: {} }, async () => { log.push("op"); return 42; });
  assert.equal(result, 42);
  assert.deepEqual(log, ["early.before", "late.before", "op", "late.after", "early.after"]);
});

test("middleware：onError handled 吞掉异常，rethrow 继续抛", async () => {
  const handled = new envelope.AgentMiddlewarePipeline([{ id: "h", order: 1, onError: () => "handled" }]);
  assert.equal(await handled.execute({ state: {} }, async () => { throw new Error("boom"); }), undefined);
  const rethrow = new envelope.AgentMiddlewarePipeline([
    { id: "second", order: 2, onError: () => "rethrow" },
    { id: "first", order: 1, onError: () => "rethrow" },
  ]);
  await assert.rejects(rethrow.execute({ state: {} }, async () => { throw new Error("boom"); }), /boom/);
});

// ---------------------------------------------------------------------------
// 3. Profiles / Fallback
// ---------------------------------------------------------------------------

test("profiles：按 profileId / sourceType+appId 选中胶囊", () => {
  assert.equal(profiles.getAppAgentCapsule("system-jarvis").maxToolCalls, 32);
  assert.equal(profiles.getAppAgentCapsule("nope"), undefined);
  assert.equal(profiles.capsuleForEnvelope({ profileId: "canvas-agent", source: { type: "app", appId: "canvas" } }).id, "canvas-agent");
  assert.equal(profiles.capsuleForEnvelope({ source: { type: "app", appId: "tasks" } }).id, "conversation");
  assert.equal(profiles.capsuleForEnvelope({ source: { type: "project" } }).id, "project-assistant");
  assert.equal(profiles.capsuleForEnvelope({ source: { type: "desktop" } }), undefined);
});

test("fallback：瞬态错误沿有序路由回退，用尽/非瞬态抛出", async () => {
  const tried = [];
  const ok = await fallback.runWithAgentModelFallback({
    routes: ["r1", "r2"], invoke: async (route) => { tried.push(route); if (route === "r1") throw new Error("HTTP 503 overloaded"); return "ok"; },
  });
  assert.equal(ok, "ok");
  assert.deepEqual(tried, ["r1", "r2"]);

  await assert.rejects(fallback.runWithAgentModelFallback({ routes: [], invoke: async () => "x" }), /没有可用的 Agent 模型路由/);
  await assert.rejects(fallback.runWithAgentModelFallback({
    routes: ["r1", "r2"], invoke: async (route) => { if (route === "r1") throw new Error("HTTP 429 too many requests"); throw new Error("still down"); },
  }), /still down/);

  const nonTransient = [];
  await assert.rejects(fallback.runWithAgentModelFallback({
    routes: ["r1", "r2"], invoke: async (route) => { nonTransient.push(route); throw new Error("用户输入非法：400 bad request"); },
  }), /bad request/);
  assert.deepEqual(nonTransient, ["r1"]);

  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(fallback.isTransientAgentModelError(abort), false);
  assert.equal(fallback.isTransientAgentModelError(new Error("模型不存在")), true);
  assert.equal(fallback.isTransientAgentModelError(new Error("完全无关的错误")), false);
});

test("fallback：回退时缓冲增量，仅成功路由统一下发", async () => {
  const deltas = [];
  const result = await fallback.runWithAgentModelFallback({
    routes: ["r1", "r2"],
    onDelta: (text) => deltas.push(text),
    invoke: async (route, onDelta) => {
      if (route === "r1") { onDelta("半截"); throw new Error("timeout"); }
      onDelta("完整"); onDelta("结果");
      return "done";
    },
  });
  assert.equal(result, "done");
  assert.deepEqual(deltas, ["完整结果"]);
});

// ---------------------------------------------------------------------------
// 4. runManager 生命周期 + 检查点
// ---------------------------------------------------------------------------

test("runManager：created→running→waiting_user→completed 且检查点落库", async () => {
  deps.resetAgentRuntimeForTests();
  const db = newDb();
  const { taskStore, getRun, checkpointSource, runStoreSource } = bootstrapRuntime(db);

  insertDxTask(db, { id: "task-1" });
  const manager = new managerModule.RunManager();
  const context = manager.prepare(makeEnvelope(), { id: "u1" }, { runId: "run-life-1", taskId: "task-1" });
  const created = manager.create(context);
  assert.equal(created.status, "created");
  assert.equal(manager.start(context.runId).status, "running");
  const waiting = manager.waitForUser(context.runId, "请确认预算");
  assert.equal(waiting.status, "waiting_user");
  assert.equal(manager.start(context.runId).status, "running");
  const completed = manager.complete(context.runId, { output: "完成" });
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.result, { output: "完成" });

  const checkpoints = db.prepare("SELECT phase,schema_version,state_json FROM agent_checkpoints WHERE run_id=? ORDER BY sequence").all("run-life-1");
  assert.deepEqual(checkpoints.map((row) => row.phase), ["waiting_user", "terminal"]);
  assert.equal(checkpoints[0].schema_version, "dx-agent-checkpoint/v1");
  assert.equal(JSON.parse(checkpoints[0].state_json).schema, "dx-agent-checkpoint/v1");
  // 接口对齐证据：检查点由 B3a appendAgentCheckpoint 落库，Run 状态由 B3b agent-kernel-store 落库。
  assert.equal(checkpointSource, "B3a");
  assert.equal(runStoreSource, "B3b");
});

test("runManager：execute 中 operation 抛错 → failed 且 terminal 检查点", async () => {
  deps.resetAgentRuntimeForTests();
  const db = newDb();
  const { taskStore, getRun, checkpointSource, runStoreSource } = bootstrapRuntime(db);

  insertDxTask(db, { id: "task-fail" });
  const manager = new managerModule.RunManager([{ id: "tag", order: 1, before: (ctx) => { ctx.state.tagged = true; } }]);
  const context = manager.prepare(makeEnvelope(), { id: "u1" }, { runId: "run-fail-1", taskId: "task-fail" });
  await assert.rejects(manager.execute(context, async () => { throw new Error("模型崩溃"); }), /模型崩溃/);
  const run = getRun("run-fail-1");
  assert.equal(run.status, "failed");
  assert.match(run.errorMessage, /模型崩溃/);
  const phases = db.prepare("SELECT phase FROM agent_checkpoints WHERE run_id=?").all("run-fail-1").map((row) => row.phase);
  assert.deepEqual(phases, ["terminal"]);
});

test("runManager：execute 已终态直接返回缓存结果，不重复执行", async () => {
  deps.resetAgentRuntimeForTests();
  const db = newDb();
  const { taskStore, getRun, checkpointSource, runStoreSource } = bootstrapRuntime(db);

  const manager = new managerModule.RunManager();
  const context = manager.prepare(makeEnvelope(), { id: "u1" }, { runId: "run-cache-1", taskId: "task-cache" });
  manager.create(context);
  manager.start(context.runId);
  manager.complete(context.runId, "first");
  let executed = 0;
  const result = await manager.execute(context, async () => { executed += 1; return "second"; });
  assert.equal(executed, 0);
  assert.equal(result, "first");
});

test("runManager：prepare 拒绝不合法 Profile 入口", () => {
  deps.resetAgentRuntimeForTests();
  const db = newDb();
  bootstrapRuntime(db);
  const manager = new managerModule.RunManager();
  expectStatus(() => manager.prepare(makeEnvelope({ profileId: "no-such-profile" }), { id: "u1" }), 400);
  expectStatus(() => manager.prepare(makeEnvelope({ profileId: "canvas-agent", source: { type: "desktop" } }), { id: "u1" }), 403);
  expectStatus(() => manager.prepare(makeEnvelope({ profileId: "developer-app", source: { type: "app", appId: "dev" } }), { id: "u1" }), 403);
});

test("runManager：同 runId 不同请求范围 → 409", () => {
  deps.resetAgentRuntimeForTests();
  const db = newDb();
  const { taskStore, getRun, checkpointSource, runStoreSource } = bootstrapRuntime(db);
  const manager = new managerModule.RunManager();
  const first = manager.prepare(makeEnvelope(), { id: "u1" }, { runId: "run-scope-1" });
  manager.create(first);
  const other = manager.prepare(makeEnvelope({ scope: { projectId: "p2" } }), { id: "u1" }, { runId: "run-scope-1" });
  expectStatus(() => manager.create(other), 409);
});

// ---------------------------------------------------------------------------
// 5. usageStore
// ---------------------------------------------------------------------------

test("usage：model 调用 start/finish 落 agent_usage_events 并写 run 事件", () => {
  deps.resetAgentRuntimeForTests();
  const db = newDb();
  bootstrapRuntime(db);
  insertDxTask(db, { id: "task-u1" });
  insertRun(db, { id: "run-usage-1", taskId: "task-u1", userId: "u1", projectId: "p1" });

  const started = usage.beginAgentUsage({ runId: "run-usage-1", taskId: "task-u1", kind: "model", providerId: "prov", model: "m1" });
  assert.ok(started.id);
  const finished = usage.finishAgentUsage(started.id, { status: "completed", usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 2 } }, latencyMs: 7 });
  assert.equal(finished.status, "completed");
  assert.deepEqual(finished.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: undefined, cacheCreationInputTokens: undefined, reasoningTokens: 2 });
  assert.equal(finished.cost, null);
  assert.equal(finished.costSource, "unavailable");

  const row = db.prepare("SELECT * FROM agent_usage_events WHERE id=?").get(started.id);
  assert.equal(row.kind, "model");
  assert.equal(row.status, "completed");
  assert.equal(row.total_tokens, 15);
  assert.equal(row.reasoning_tokens, 2);
  assert.equal(row.latency_ms, 7);
  const event = db.prepare("SELECT type FROM agent_run_events WHERE run_id=? ORDER BY sequence").all("run-usage-1").map((r) => r.type);
  assert.ok(event.includes("usage.recorded"));

  const already = usage.finishAgentUsage(started.id, { status: "failed" });
  assert.equal(already.status, "already_finished");
});

test("usage：tool 记账按 invocationId 幂等，listAgentUsage 覆盖两类", () => {
  deps.resetAgentRuntimeForTests();
  const db = newDb();
  bootstrapRuntime(db);
  insertDxTask(db, { id: "task-u2" });
  insertRun(db, { id: "run-usage-2", taskId: "task-u2", userId: "u1", projectId: "p1" });

  const modelCall = usage.beginAgentUsage({ runId: "run-usage-2", taskId: "task-u2", kind: "model", model: "m2" });
  usage.finishAgentUsage(modelCall.id, { status: "failed", error: new Error("上游 500") });

  const first = usage.recordAgentToolUsage({ runId: "run-usage-2", invocationId: "inv-1", toolName: "file.write", status: "completed", latencyMs: 3 });
  const second = usage.recordAgentToolUsage({ runId: "run-usage-2", invocationId: "inv-1", toolName: "file.write", status: "completed" });
  assert.equal(second.id, first.id);
  assert.equal(second.status, "already_recorded");

  const listed = usage.listAgentUsage(["run-usage-2"]);
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map((row) => row.kind).sort(), ["model", "tool"]);
  const toolRow = listed.find((row) => row.kind === "tool");
  assert.equal(toolRow.toolName, "file.write");
  assert.equal(toolRow.invocationId, undefined); // 列表投影未选 invocation_id，保持与源一致的列集合
});

test("usage：normalizeAgentUsage 兼容三种协议字段名", () => {
  assert.deepEqual(usage.normalizeAgentUsage({ usage: { input_tokens: 3, output_tokens: 4 } }), { inputTokens: 3, outputTokens: 4, totalTokens: 7, cachedInputTokens: undefined, cacheCreationInputTokens: undefined, reasoningTokens: undefined });
  assert.deepEqual(usage.normalizeAgentUsage({ usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, thoughtsTokenCount: 5 } }), { inputTokens: 2, outputTokens: 1, totalTokens: 3, cachedInputTokens: undefined, cacheCreationInputTokens: undefined, reasoningTokens: 5 });
  assert.deepEqual(usage.normalizeAgentUsage({ data: { usage: { cache_read_input_tokens: 9, cache_creation_input_tokens: 1 } } }), { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined, cachedInputTokens: 9, cacheCreationInputTokens: 1, reasoningTokens: undefined });
  assert.equal(usage.normalizeAgentUsage(null), undefined);
  assert.equal(usage.normalizeAgentUsage({ nothing: true }), undefined);
});

test("dependency：未注入 kernel 时 prepare 抛 AGENT_DEPENDENCY_UNAVAILABLE", () => {
  deps.resetAgentRuntimeForTests();
  const db = newDb();
  deps.configureAgentRuntime({ db, clock: nextClock, idFactory: randomUUID });
  const manager = new managerModule.RunManager();
  expectCode(() => manager.prepare(makeEnvelope(), { id: "u1" }), "AGENT_DEPENDENCY_UNAVAILABLE");
});

// ---------------------------------------------------------------------------
// 6. serverToolLoop
// ---------------------------------------------------------------------------

function capabilityTool(name, id, domain, intents) {
  return {
    type: "function",
    function: { name, description: name, parameters: { type: "object", properties: { x: { type: "integer" } } } },
    x_dx_capability: { schema: "dx-agent-capability/v1", id, domain, intents },
  };
}

test("toolLoop：模型 tool_calls → toolRunner → 回填 → 二次模型 → 收敛", async () => {
  deps.resetAgentRuntimeForTests();
  const calls = [];
  const ran = [];
  const modelAdapter = {
    async call(args) {
      calls.push(args);
      if (calls.length === 1) return { ok: true, text: "", toolCalls: [{ id: "c1", name: "file.write", arguments: JSON.stringify({ x: 1 }) }], usage: { prompt_tokens: 1 } };
      return { ok: true, text: "最终答案", toolCalls: [] };
    },
  };
  const toolRunner = { async run(name, args, ctx) { ran.push({ name, args, ctx }); return { wrote: true, value: 42 }; } };
  const result = await toolLoop.runServerToolLoop({
    runId: "run-loop-1", messages: [{ role: "user", content: "hi" }],
    tools: [capabilityTool("file.write", "cap.file.write", "file", ["file.write"])],
    modelAdapter, toolRunner, maxSteps: 5, providerId: "p", model: "m",
  });
  assert.equal(result.terminal, true);
  assert.equal(result.content, "最终答案");
  assert.equal(result.step, 2);
  assert.equal(ran.length, 1);
  assert.equal(ran[0].name, "file.write");
  assert.deepEqual(ran[0].args, { x: 1 });
  assert.equal(calls.length, 2);
  const toolMessage = calls[1].messages.find((message) => message.role === "tool");
  assert.ok(toolMessage);
  assert.equal(toolMessage.tool_call_id, "c1");
  assert.match(toolMessage.content, /"value":42/);
  assert.equal(calls[1].tools[0].function.name, "capability_discover");
});

test("toolLoop：模型持续返回工具调用时命中迭代上限 step_limit", async () => {
  deps.resetAgentRuntimeForTests();
  let modelCalls = 0;
  const modelAdapter = {
    async call() { modelCalls += 1; return { ok: true, text: "step", toolCalls: [{ id: "c" + modelCalls, name: "t", arguments: "{}" }] }; },
  };
  const toolRunner = { async run() { return "ok"; } };
  const result = await toolLoop.runServerToolLoop({ runId: "run-loop-2", messages: [], tools: [], modelAdapter, toolRunner, maxSteps: 2 });
  assert.equal(result.reason, "step_limit");
  assert.equal(result.step, 2);
  assert.equal(modelCalls, 2);
  assert.equal(result.terminal, true);
});

test("toolLoop：工具失败回填 ok:false，不伪造成功", async () => {
  deps.resetAgentRuntimeForTests();
  const calls = [];
  const modelAdapter = {
    async call(args) {
      calls.push(args);
      if (calls.length === 1) return { ok: true, text: "", toolCalls: [{ id: "c1", name: "t", arguments: "{}" }] };
      return { ok: true, text: "已处理失败", toolCalls: [] };
    },
  };
  const toolRunner = { async run() { throw new Error("磁盘只读"); } };
  const result = await toolLoop.runServerToolLoop({ runId: "run-loop-3", messages: [], tools: [], modelAdapter, toolRunner, maxSteps: 4 });
  assert.equal(result.terminal, true);
  assert.equal(result.content, "已处理失败");
  const toolMessage = calls[1].messages.find((message) => message.role === "tool");
  assert.match(toolMessage.content, /"ok":false/);
  assert.match(toolMessage.content, /磁盘只读/);
});

test("toolLoop：未注入 toolRunner / 模型失败返回结构化错误", async () => {
  deps.resetAgentRuntimeForTests();
  deps.configureAgentRuntime({});
  const modelAdapter = { async call() { return { ok: true, text: "", toolCalls: [] }; } };
  await assert.rejects(
    toolLoop.runServerToolLoop({ runId: "run-loop-4", messages: [], tools: [], modelAdapter }),
    (error) => error.code === "AGENT_DEPENDENCY_UNAVAILABLE" && error.dependency === "toolRunner",
  );
  await assert.rejects(
    toolLoop.runServerToolLoop({ runId: "run-loop-5", messages: [], tools: [], modelAdapter: { async call() { return { ok: false, error: "PROVIDER_PROTOCOL_ERROR" }; } }, toolRunner: { async run() { return 1; } } }),
    (error) => error.code === "PROVIDER_PROTOCOL_ERROR",
  );
});

test("toolLoop：filterGatewayCapabilityTools 保真 + 客户端 pending 协调器", async () => {
  const canonical = [capabilityTool("canonical.tool", "cap.canonical", "file", ["file.read"])];
  const allowed = new Set(["canonical.tool", "client.tool"]);
  const filtered = toolLoop.filterGatewayCapabilityTools([
    { type: "function", function: { name: "canonical.tool", description: "hijack", parameters: { type: "object", properties: { evil: { type: "string" } } } } },
    { type: "function", function: { name: "client.tool", description: "client", parameters: { type: "object", properties: {} } }, x_dx_capability: { schema: "dx-agent-capability/v1", id: "cap.client", domain: "app", intents: ["app.run"] } },
    { type: "function", function: { name: "not.allowed" }, x_dx_capability: { schema: "dx-agent-capability/v1", id: "cap.x", domain: "app", intents: ["x"] } },
    { type: "function", function: { name: "bad name!" } },
  ], canonical, allowed);
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].function.name, "canonical.tool");
  assert.equal(filtered[0].function.description, "canonical.tool");
  assert.equal(filtered[1].x_dx_capability.id, "cap.client");
  assert.equal(toolLoop.filterGatewayCapabilityTools(null, canonical, allowed).length, 1);

  const coordinator = new toolLoop.ServerAgentToolLoopCoordinator();
  const state = coordinator.create({ runId: "run-coord-1", messages: [], system: "s", tools: [], maxSteps: 5 });
  const model = async () => ({ content: "", toolCalls: [{ id: "c1", name: "remote.tool", arguments: "{}" }] });
  const first = await coordinator.advance(state, { model, discover: async (args, local) => local });
  assert.equal(first.terminal, false);
  assert.deepEqual(first.toolCalls.map((call) => call.id), ["c1"]);
  // pending 状态下来错 observation → 409
  await assert.rejects(
    coordinator.advance(state, { observations: [{ invocationId: "zzz", toolName: "x", status: "completed" }], model, discover: async (args, local) => local }),
    (error) => error.statusCode === 409,
  );
  const second = await coordinator.advance(state, {
    observations: [{ invocationId: "c1", toolName: "remote.tool", status: "completed", result: { ok: true } }],
    model: async () => ({ content: "完成", toolCalls: [] }),
    discover: async (args, local) => local,
  });
  assert.equal(second.terminal, true);
  assert.equal(second.content, "完成");
});

// ---------------------------------------------------------------------------
// 7. workspaceStore
// ---------------------------------------------------------------------------

function setupWorkspaceTest() {
  deps.resetAgentRuntimeForTests();
  const db = newDb();
  const fsAdapter = createFakeFs();
  const { taskStore } = bootstrapRuntime(db, { fsAdapter });
  const projectRoot = fsAdapter.createNode({ name: "project", type: "folder", parentId: null, ownerId: "u1" });
  const fileA = fsAdapter.createNode({ name: "a.txt", type: "file", parentId: projectRoot.id, ownerId: "u1" });
  fileA.content = "v1";
  const docs = fsAdapter.createNode({ name: "docs", type: "folder", parentId: projectRoot.id, ownerId: "u1" });
  const readme = fsAdapter.createNode({ name: "readme.md", type: "file", parentId: docs.id, ownerId: "u1" });
  readme.content = "hello";
  return { db, fsAdapter, taskStore, projectRootId: projectRoot.id };
}

test("workspace：ensure → 越界写拒绝 → validate → commit；commit 落回正式项目", () => {
  const { db, fsAdapter, projectRootId } = setupWorkspaceTest();
  insertRun(db, { id: "run-ws-1", projectId: "p1", userId: "u1", appId: "app", sessionId: "s1" });

  const ws = workspace.ensureRunWorkspace("run-ws-1", "p1", projectRootId, "u1");
  assert.equal(ws.status, "active");
  assert.equal(ws.projectId, "p1");
  assert.deepEqual(Object.keys(ws.baseManifest).sort(), ["a.txt", "docs", "docs/readme.md"]);
  assert.equal(fsAdapter.findByPath(ws.workspaceRootId, "a.txt").content, "v1");
  // ensure 幂等
  assert.equal(workspace.ensureRunWorkspace("run-ws-1", "p1", projectRootId, "u1").workspaceRootId, ws.workspaceRootId);

  // 越界写拒绝
  workspace.assertRunWorkspaceWrite("run-ws-1", "u1", ws.workspaceRootId, "docs/readme.md");
  expectStatus(() => workspace.assertRunWorkspaceWrite("run-ws-1", "u1", projectRootId, "a.txt"), 403);
  expectStatus(() => workspace.assertRunWorkspaceWrite("run-ws-1", "u1", ws.workspaceRootId, "../escape.txt"), 400);
  expectStatus(() => workspace.assertRunWorkspaceWrite("run-ws-1", "u1", ws.workspaceRootId, "/abs.txt"), 400);
  expectStatus(() => workspace.assertRunWorkspaceWrite("run-ws-1", "u1", ws.workspaceRootId, ".ccs-ai/secret.txt"), 400);
  expectStatus(() => workspace.assertRunWorkspaceWrite("run-ws-1", "other-user", ws.workspaceRootId, "a.txt"), 403);

  // Agent 修改 Workspace 副本
  fsAdapter.findByPath(ws.workspaceRootId, "a.txt").content = "v2";
  const staged = workspace.stageRunArtifact("run-ws-1", "a.txt");
  assert.equal(staged.status, "produced");
  assert.equal(staged.baseSha256, ws.baseManifest["a.txt"].sha256);
  // 未验证直接提交 → 409
  expectStatus(() => workspace.commitRunArtifact("run-ws-1", staged.id, "u1"), 409);
  const validated = workspace.validateRunArtifact("run-ws-1", staged.id);
  assert.equal(validated.status, "validated");
  const committed = workspace.commitRunArtifact("run-ws-1", staged.id, "u1");
  assert.equal(committed.status, "committed");
  assert.ok(committed.committedNodeId);
  assert.equal(workspace.getRunWorkspace("run-ws-1").status, "committed");
  assert.equal(fsAdapter.findByPath(projectRootId, "a.txt").content, "v2");
  assert.equal(fsAdapter.findByPath(projectRootId, "docs/readme.md").content, "hello");
});

test("workspace：提交时 FS 版本冲突 → workspace/artifact/journal 全部 conflicted", () => {
  const { db, fsAdapter, projectRootId } = setupWorkspaceTest();
  insertRun(db, { id: "run-ws-2", projectId: "p1", userId: "u1", appId: "app", sessionId: "s1" });
  const ws = workspace.ensureRunWorkspace("run-ws-2", "p1", projectRootId, "u1");
  fsAdapter.findByPath(ws.workspaceRootId, "a.txt").content = "v2";
  const staged = workspace.stageRunArtifact("run-ws-2", "a.txt");
  workspace.validateRunArtifact("run-ws-2", staged.id);

  fsAdapter.control.publishConflict = true;
  assert.throws(() => workspace.commitRunArtifact("run-ws-2", staged.id, "u1"), (error) => error.code === "FS_REVISION_CONFLICT");
  assert.equal(workspace.getRunWorkspace("run-ws-2").status, "conflicted");
  assert.equal(workspace.listRunArtifacts("run-ws-2").find((item) => item.id === staged.id).status, "conflicted");
  const journal = db.prepare("SELECT status,error_message AS message FROM agent_commit_journals WHERE run_id=?").get("run-ws-2");
  assert.equal(journal.status, "conflicted");
  assert.match(journal.message, /冲突/);
  // 正式项目未被写入
  assert.equal(fsAdapter.findByPath(projectRootId, "a.txt").content, "v1");
});

test("workspace：正式项目在 Run 期间被改动 → 整批提交 409，Workspace 保持 active", () => {
  const { db, fsAdapter, projectRootId } = setupWorkspaceTest();
  insertRun(db, { id: "run-ws-3", projectId: "p1", userId: "u1", appId: "app", sessionId: "s1" });
  const ws = workspace.ensureRunWorkspace("run-ws-3", "p1", projectRootId, "u1");
  fsAdapter.findByPath(ws.workspaceRootId, "a.txt").content = "v2";
  const staged = workspace.stageRunArtifact("run-ws-3", "a.txt");
  workspace.validateRunArtifact("run-ws-3", staged.id);

  // 审查期间别的进程改了正式项目
  fsAdapter.findByPath(projectRootId, "a.txt").content = "external-change";
  expectStatus(() => workspace.commitRunArtifact("run-ws-3", staged.id, "u1"), 409);
  expectStatus(() => workspace.validateAndCommitRunArtifacts("run-ws-3", "u1"), 409);
  assert.equal(workspace.getRunWorkspace("run-ws-3").status, "active");
  assert.equal(fsAdapter.findByPath(projectRootId, "a.txt").content, "external-change");
});

test("workspace：abandon 只对 active 生效并关闭后续写入", () => {
  const { db, fsAdapter, projectRootId } = setupWorkspaceTest();
  insertRun(db, { id: "run-ws-4", projectId: "p1", userId: "u1", appId: "app", sessionId: "s1" });
  const ws = workspace.ensureRunWorkspace("run-ws-4", "p1", projectRootId, "u1");
  const abandoned = workspace.abandonRunWorkspace("run-ws-4");
  assert.equal(abandoned.status, "abandoned");
  expectStatus(() => workspace.requireRunWorkspace("run-ws-4", "u1", true), 409);
  expectStatus(() => workspace.assertRunWorkspaceWrite("run-ws-4", "u1", ws.workspaceRootId, "a.txt"), 409);
  // 幂等：已 abandoned 不再变更
  assert.equal(workspace.abandonRunWorkspace("run-ws-4").status, "abandoned");
});

test("workspace：未注入 fsAdapter 时所有触盘能力抛 AGENT_DEPENDENCY_UNAVAILABLE", () => {
  deps.resetAgentRuntimeForTests();
  const db = newDb();
  bootstrapRuntime(db);
  insertRun(db, { id: "run-ws-5", projectId: "p1", userId: "u1" });
  expectCode(() => workspace.ensureRunWorkspace("run-ws-5", "p1", "root-1", "u1"), "AGENT_DEPENDENCY_UNAVAILABLE");
  // 先落一条 Workspace 行，才能走到 fsAdapter 缺失分支（否则先是 404 Workspace 不存在）
  db.prepare("INSERT INTO agent_workspaces(run_id,project_id,source_root_id,workspace_root_id,user_id,status,base_manifest_json,created_at,updated_at) VALUES (?,?,?,?,?,'active','{}',?,?)")
    .run("run-ws-5", "p1", "root-1", "ws-root-1", "u1", 1, 1);
  expectCode(() => workspace.assertRunWorkspaceWrite("run-ws-5", "u1", "ws-root-1", "a.txt"), "AGENT_DEPENDENCY_UNAVAILABLE");
  // 纯数据库能力不依赖 fsAdapter，仍可用
  assert.deepEqual(workspace.listRunArtifacts("run-ws-5"), []);
});

test("workspace：artifactReviewState 无 Reviewer 时 not_required", () => {
  const { db } = setupWorkspaceTest();
  insertRun(db, { id: "run-ws-6", projectId: "p1", userId: "u1", taskId: "task-6" });
  const review = workspace.artifactReviewState("run-ws-6");
  assert.equal(review.required, false);
  assert.equal(review.status, "not_required");
});

test("workspace：recoverAgentCommitJournals 无遗留 Journal 时返回空", () => {
  const { db } = setupWorkspaceTest();
  insertRun(db, { id: "run-ws-7", projectId: "p1", userId: "u1" });
  assert.deepEqual(workspace.recoverAgentCommitJournals(), { recovered: [], conflicted: [] });
});
