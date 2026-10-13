"use strict";
/**
 * B3c · Agent Run 生命周期管理器。
 *
 * 逐字移植 server/agent-runtime/runManager.ts:1-202：
 *   RunManager.prepare / create / start / waitForUser / append / acquireWorkspace /
 *   complete / fail / cancel / execute，以及模块级单例 agentRunManager。
 *
 * 依赖替换：
 *   · 源 import ccsDb          -> 注入 db
 *   · 源 import prepareAgentTurn (agent-kernel/kernel.ts) -> 注入 kernel
 *   · 源 import runStore        -> 注入 taskStore（runStore 同名函数）
 *   · 源 import workspaceStore  -> 本目录 agent-runtime-workspace.cjs（共享注入）
 *   · 源 import capsuleForEnvelope / validateJsonSchema / AgentMiddlewarePipeline -> 本目录已移植文件
 *
 * B4/云计费：prepare 里 actor 只作为普通对象透传（userId），不 import auth；
 * 源 runManager 未调用 apiQuota，故无计费删除点。
 *
 * 扩展点（任务 E 要求"检查点落库经 agent-task-store 的 appendAgentCheckpoint"）：
 *   waitForUser / complete / fail / cancel 在 Run 关联 taskId 时额外写入一个
 *   AgentCheckpointPhase 检查点（phase = waiting_user / terminal）。这是对源 runManager
 *   的集成补充，不改变原有函数返回值与状态机语义。
 */
const depsModule = require("./agent-runtime-deps.cjs");
const { requireDependency, requireDependencyFunction } = depsModule;
const { AgentMiddlewarePipeline, validateJsonSchema } = require("./agent-runtime-envelope.cjs");
const { capsuleForEnvelope } = require("./agent-runtime-profiles.cjs");
const workspace = require("./agent-runtime-workspace.cjs");

const checkpointContract = (() => {
  try {
    return require("./agent-checkpoint-contract.cjs");
  } catch {
    // B3a 尚未落地时的只读兜底常量；真正的检查点落库仍要求 taskStore.appendAgentCheckpoint。
    return { AGENT_CHECKPOINT_SCHEMA: "dx-agent-checkpoint/v1", AGENT_CHECKPOINT_PHASES: ["model_response_persisted", "tool_progress", "waiting_user", "waiting_children", "verification", "terminal"], isCheckpointPhase: (value) => ["model_response_persisted", "tool_progress", "waiting_user", "waiting_children", "verification", "terminal"].includes(value) };
  }
})();

function db() {
  return requireDependency("db");
}
function kernelFn(name) {
  return requireDependencyFunction("kernel", name);
}
function runStoreFn(name) {
  // runStore 属 B3b（server/agent-kernel/runStore.ts -> electron/agent-kernel-store.cjs）；
  // deps.runStoreFunction 支持注入覆盖，并会在未注入时惰性接 B3b。
  return depsModule.runStoreFunction(name);
}

const terminal = new Set(["completed", "failed", "cancelled"]);

/** 源 runManager.ts:31-33。 */
function capabilityMatches(id, boundary) {
  return boundary.endsWith("*") ? id.startsWith(boundary.slice(0, -1)) : id === boundary;
}

function descriptorCapabilityId(tool) {
  return tool.capabilityId || tool.source + ":" + tool.sourceId + ":" + tool.name;
}

/**
 * OpenArc 合并库里 tasks 表若未提供 expected_output_schema 列，等价于"任务未声明结构化产出"，
 * 此时跳过 Schema 验收（不是伪造通过）。DX 原生库会有该列，走完整校验。
 */
function declaredOutputSchema(taskId) {
  try {
    // B3a 的 DX 任务表为 dx_tasks（dxos-agent-schema.cjs:100-102），不是 OpenArc 同名的 tasks。
    const row = db().prepare("SELECT expected_output_schema AS schema FROM dx_tasks WHERE id=?").get(taskId);
    return row?.schema ?? null;
  } catch (error) {
    if (/no such column/i.test(String(error?.message || ""))) return null;
    throw error;
  }
}

/** 任务 E 的检查点集成：仅在 Run 绑定 taskId 时写入。 */
function persistLifecycleCheckpoint(run, phase, extraState) {
  if (!run?.taskId) return undefined;
  const append = requireDependencyFunction("taskStore", "appendAgentCheckpoint");
  if (typeof checkpointContract.isCheckpointPhase === "function" && !checkpointContract.isCheckpointPhase(phase)) {
    throw new Error("未知 Agent 检查点 phase：" + phase);
  }
  let attemptNo = 0;
  try {
    const task = db().prepare("SELECT attempt_no AS attemptNo FROM dx_tasks WHERE id=?").get(run.taskId);
    attemptNo = Number(task?.attemptNo) || 0;
  } catch {
    /* 表结构缺列时按 0 处理，不影响检查点主键 (task_id,sequence) */
  }
  append({
    runId: run.id,
    taskId: run.taskId,
    attemptNo,
    phase,
    state: { schema: checkpointContract.AGENT_CHECKPOINT_SCHEMA, iteration: 0, nextToolIndex: 0, ...extraState },
  });
  return phase;
}

/** 源 runManager.ts:46-198。 */
class RunManager {
  constructor(middlewares = []) {
    this.controllers = new Map();
    this.pipeline = new AgentMiddlewarePipeline(middlewares);
  }

  /** 源 runManager.ts:52-124：Profile 授权 + 能力边界裁剪，全部在 prepare 阶段完成。 */
  prepare(envelope, actor, options = {}) {
    const capsule = capsuleForEnvelope(envelope);
    if (envelope.profileId && !capsule) {
      throw Object.assign(new Error("Agent Profile 不存在或未启用：" + envelope.profileId), { statusCode: 400 });
    }
    if (capsule && (!capsule.sourceTypes.includes(envelope.source.type) || (capsule.appId && capsule.appId !== envelope.source.appId))) {
      throw Object.assign(new Error("Agent Profile " + capsule.id + " 不允许从当前入口调用"), { statusCode: 403 });
    }
    if (capsule?.id === "developer-app" && !envelope.source.entryPoint) {
      throw Object.assign(new Error("Developer Agent 必须通过受控 APP 入口调用"), { statusCode: 403 });
    }
    if (capsule && envelope.source.entryPoint && !capsule.entryPoints.includes(envelope.source.entryPoint)) {
      throw Object.assign(new Error("Agent Profile " + capsule.id + " 不允许从入口 " + envelope.source.entryPoint + " 调用"), { statusCode: 403 });
    }
    const entryPoint = envelope.source.type === "channel" || envelope.source.type === "api" ? "app" : envelope.source.type;
    const prepared = kernelFn("prepareAgentTurn")({
      runId: options.runId,
      instruction: envelope.goal,
      entryPoint,
      actor,
      projectId: envelope.scope.projectId,
      taskId: options.taskId,
      sessionId: envelope.session.sessionId || envelope.session.threadId,
      appId: envelope.source.appId,
      appContext: {
        ...(envelope.appContext && typeof envelope.appContext === "object" ? envelope.appContext : {}),
        ...(envelope.scope.canvasId ? { canvasId: envelope.scope.canvasId } : {}),
        ...(envelope.scope.appWorkspaceId ? { appWorkspaceId: envelope.scope.appWorkspaceId } : {}),
        ...(envelope.scope.knowledgeScopeIds ? { knowledgeScopeIds: envelope.scope.knowledgeScopeIds } : {}),
      },
      correlationId: envelope.correlationId || envelope.requestId,
      causationId: envelope.causationId || envelope.session.continuationOfRunId,
      agentProfileId: capsule?.id || envelope.profileId,
      preferredProviderId: envelope.modelPreference?.providerId,
      preferredModel: envelope.modelPreference?.model,
      requestedSources: capsule?.id === "developer-app" ? ["system", "file", "app"] : undefined,
    });
    if (capsule?.id === "developer-app") {
      const appId = String(envelope.source.appId || "");
      const allowedDescriptorIds = new Set(prepared.route.toolDescriptors
        .filter((tool) => tool.source !== "app" || tool.sourceId === appId)
        .map(descriptorCapabilityId));
      prepared.capabilities = prepared.capabilities.filter((capability) => allowedDescriptorIds.has(capability.id));
      prepared.route.toolDescriptors = prepared.route.toolDescriptors.filter((tool) => allowedDescriptorIds.has(descriptorCapabilityId(tool)));
      const allowedNames = new Set(prepared.route.toolDescriptors.map((tool) => tool.name));
      prepared.route.tools = prepared.route.tools.filter((tool) => allowedNames.has(tool.function.name));
    }
    const boundaries = [...(capsule?.capabilityScopes || [])];
    if (boundaries.length || envelope.capabilityBoundary?.length) {
      const allowedCapabilityIds = new Set(prepared.capabilities
        .filter((capability) => (!boundaries.length || boundaries.some((boundary) => capabilityMatches(capability.id, boundary)))
          && (!envelope.capabilityBoundary?.length || envelope.capabilityBoundary.some((boundary) => capabilityMatches(capability.id, boundary))))
        .map((capability) => capability.id));
      prepared.capabilities = prepared.capabilities.filter((capability) => allowedCapabilityIds.has(capability.id));
      prepared.route.toolDescriptors = prepared.route.toolDescriptors.filter((tool) => allowedCapabilityIds.has(descriptorCapabilityId(tool)));
      const allowedNames = new Set(prepared.route.toolDescriptors.map((tool) => tool.name));
      prepared.route.tools = prepared.route.tools.filter((tool) => allowedNames.has(tool.function.name));
    }
    if (capsule) prepared.systemPromptAdditions.push(capsule.systemInstructions);
    const controller = this.controllers.get(prepared.trace.runId) || new AbortController();
    this.controllers.set(prepared.trace.runId, controller);
    return { envelope, actor, prepared, runId: prepared.trace.runId, signal: controller.signal, state: {} };
  }

  /** 源 runManager.ts:126-140：同 runId 仅允许同范围复用，否则 409。 */
  create(context) {
    const existing = runStoreFn("getAgentRun")(context.runId);
    if (existing) {
      if (existing.userId !== context.actor.id
        || existing.projectId !== context.envelope.scope.projectId
        || existing.appId !== context.envelope.source.appId
        || existing.correlationId !== (context.envelope.correlationId || context.envelope.requestId)
        || existing.sessionId !== (context.envelope.session.sessionId || context.envelope.session.threadId)) {
        throw Object.assign(new Error("runId 已属于其他请求范围"), { statusCode: 409 });
      }
      return existing;
    }
    return runStoreFn("createAgentRun")(context.prepared, context.envelope.goal);
  }

  start(runId) {
    return runStoreFn("startAgentRun")(runId);
  }

  /** 源 runManager.ts:143 + 任务 E 的等待态检查点。 */
  waitForUser(runId, question) {
    const run = runStoreFn("waitAgentRun")(runId, question);
    if (run) persistLifecycleCheckpoint(run, "waiting_user", { pendingToolCalls: [] });
    return run;
  }

  append(runId, type, data) {
    return runStoreFn("appendAgentRunEvent")(runId, type, data);
  }

  /** 源 runManager.ts:145-149。 */
  acquireWorkspace(context, sourceRootId) {
    const projectId = context.envelope.scope.projectId;
    if (!projectId) throw new Error("只有项目 Agent Run 可以创建 Workspace");
    return workspace.ensureRunWorkspace(context.runId, projectId, sourceRootId, context.actor.id);
  }

  /** 源 runManager.ts:151-172：结构化产出 Schema 验收 + Artifact 提交门禁。 */
  complete(runId, result) {
    const current = runStoreFn("getAgentRun")(runId);
    if (current?.taskId) {
      const schema = declaredOutputSchema(current.taskId);
      if (schema) {
        let parsed;
        try {
          parsed = JSON.parse(schema);
        } catch {
          parsed = null;
        }
        const output = result && typeof result === "object" && "output" in result ? result.output : result;
        const issues = validateJsonSchema(output, parsed);
        if (issues.length) throw Object.assign(new Error("结构化结果验收失败：" + issues.slice(0, 5).map((issue) => issue.path + " " + issue.message).join("；")), { statusCode: 409 });
      }
    }
    const artifacts = workspace.listRunArtifacts(runId);
    const review = workspace.artifactReviewState(runId);
    if (artifacts.some((artifact) => artifact.status === "produced" || artifact.status === "conflicted" || artifact.status === "rejected")) {
      throw Object.assign(new Error("Agent Artifact 尚未通过验证与提交门禁"), { statusCode: 409 });
    }
    if (artifacts.some((artifact) => artifact.status === "validated") && !(review.required && review.decision === undefined)) {
      throw Object.assign(new Error("Agent Artifact 尚未提交"), { statusCode: 409 });
    }
    const run = runStoreFn("completeAgentRun")(runId, result);
    persistLifecycleCheckpoint(run, "terminal", { pendingToolCalls: [] });
    this.controllers.delete(runId);
    return run;
  }

  fail(runId, error) {
    workspace.abandonRunWorkspace(runId);
    const run = runStoreFn("failAgentRun")(runId, error);
    if (run) persistLifecycleCheckpoint(run, "terminal", { pendingToolCalls: [] });
    this.controllers.delete(runId);
    return run;
  }

  cancel(runId, hooks = {}) {
    this.controllers.get(runId)?.abort();
    hooks.cancelTask?.();
    hooks.cancelChildren?.();
    workspace.abandonRunWorkspace(runId);
    const run = runStoreFn("cancelAgentRun")(runId);
    if (run) persistLifecycleCheckpoint(run, "terminal", { pendingToolCalls: [] });
    hooks.notifyParent?.();
    this.controllers.delete(runId);
    return run;
  }

  /** 源 runManager.ts:182-197：create → start → pipeline.execute，失败走 cancel/fail。 */
  async execute(context, operation) {
    const existing = this.create(context);
    if (terminal.has(existing.status)) return existing.result;
    this.start(context.runId);
    try {
      return await this.pipeline.execute(context, operation);
    } catch (error) {
      if (context.signal.aborted || error?.name === "AbortError") this.cancel(context.runId);
      else this.fail(context.runId, error);
      throw error;
    }
  }
}

const agentRunManager = new RunManager();

/** 依赖注入总入口；与 electron/agent-task-store.cjs 的 configureAgentTaskStore 同构。 */
function configureAgentRuntime(config) {
  return depsModule.configureAgentRuntime(config);
}

function createAgentRuntimeManager(middlewares = []) {
  return new RunManager(middlewares);
}

module.exports = {
  RunManager,
  agentRunManager,
  createAgentRuntimeManager,
  configureAgentRuntime,
  resetAgentRuntimeForTests: depsModule.resetAgentRuntimeForTests,
  AGENT_DEPENDENCY_UNAVAILABLE: depsModule.AGENT_DEPENDENCY_UNAVAILABLE,
  dependencyUnavailable: depsModule.dependencyUnavailable,
  AGENT_CHECKPOINT_SCHEMA: checkpointContract.AGENT_CHECKPOINT_SCHEMA,
  AGENT_CHECKPOINT_PHASES: checkpointContract.AGENT_CHECKPOINT_PHASES,
  isCheckpointPhase: checkpointContract.isCheckpointPhase,
};
