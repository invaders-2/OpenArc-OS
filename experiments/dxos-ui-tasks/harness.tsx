/**
 * UI-3 · 任务 / Agent 控制台探针用挂载壳（只在 experiments 里被 esbuild 打包，不进产品构建）。
 *
 * 它做四件事：
 *   1. 复刻产品窗口里 projects 分支的真实外壳（.window > .split > .split-side 导航 + .split-main），
 *      让 TaskConsole 处于和 src/main.tsx 的 projects 分支完全相同的 DOM 位置与容器宽度规则下；
 *   2. 装一个**假 agent 桥**（只在 window.openarc.agent 上放 command / onEvent），
 *      按 ?scenario= 返回不同数据形状，离线、确定性地驱动七类状态；
 *   3. 另装一个**假 skill 桥**并把 SkillCenter 挂进同款外壳，供基准对照（?page=skill）；
 *   4. 把收到的命令与下行事件挂到 window.__oaTaskProbe，供 Playwright 断言。
 *
 * 这两个桥都不发任何网络请求：它们是内存里的 switch。
 */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { TaskConsole } from "../../src/projects/TaskConsole";
import { SkillCenter } from "../../src/skills/SkillCenter";
import "../../src/design-system/tokens.css";
import "../../src/design-system/primitives.css";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") || "ready";
const runMode = params.get("run") || "fast";
/* 入口依赖装配模式：默认 all（B6 已把 fsAdapter 真实接线）；
   ?deps=fs-missing 是显式的依赖缺失降级场景，用于降级截图，不再是默认态。 */
const depsMode = params.get("deps") || "all";
/* U1 · 深色对照：harness 根节点加 .dark（产品用类名切主题，不是媒体查询）。 */
const dark = params.get("dark") === "1";

/* ══════════════════════════════════════════════════════════════════════════
   任务数据（形状对齐 electron/agent-service.cjs:179-189 的 taskSummary 投影）
   ══════════════════════════════════════════════════════════════════════════ */
const T0 = Date.parse("2026-02-01T09:00:00Z");
const READY_TASKS: any[] = [
  {
    taskId: "t_report",
    projectId: "p_weekly",
    threadId: "th_weekly",
    title: "整理本周周报",
    instruction: "把本周记录整理成周报草稿，附下周计划；不对未验证内容作结论。",
    status: "running",
    mode: "react",
    executionProfile: "standard",
    createdAt: T0,
    updatedAt: T0 + 12 * 60 * 1000,
    startedAt: T0 + 60 * 1000,
    completedAt: null,
    errorCode: null,
    errorMessage: null,
    agentRunId: "run_report",
  },
  {
    taskId: "t_wait",
    projectId: "p_weekly",
    threadId: "th_deploy",
    title: "确认部署目标",
    instruction: "确认要部署到哪个环境后再继续写文件。",
    status: "waiting_user",
    mode: "react",
    executionProfile: "standard",
    createdAt: T0 + 3600 * 1000,
    updatedAt: T0 + 3900 * 1000,
    startedAt: T0 + 3700 * 1000,
    completedAt: null,
    errorCode: null,
    errorMessage: null,
    agentRunId: "run_deploy",
  },
  {
    taskId: "t_done",
    projectId: "p_weekly",
    threadId: "th_release",
    title: "生成发布说明",
    instruction: "根据已完成变更生成发布说明。",
    status: "completed",
    mode: "actions",
    executionProfile: "standard",
    createdAt: T0 - 7200 * 1000,
    updatedAt: T0 - 6000 * 1000,
    startedAt: T0 - 7100 * 1000,
    completedAt: T0 - 6000 * 1000,
    errorCode: null,
    errorMessage: null,
    agentRunId: "run_release",
  },
];

const STEPS: Record<string, any[]> = {
  t_report: [
    { id: "s1", ordinal: 1, title: "收集本周记录", tool: "file.read", status: "completed", startedAt: T0 + 60 * 1000, completedAt: T0 + 120 * 1000 },
    { id: "s2", ordinal: 2, title: "整理要点", tool: "model.call", status: "running", startedAt: T0 + 120 * 1000, completedAt: null },
    { id: "s3", ordinal: 3, title: "生成周报草稿", tool: "file.write", status: "queued", startedAt: null, completedAt: null },
  ],
  t_wait: [
    { id: "s1", ordinal: 1, title: "读取部署配置", tool: "file.read", status: "completed", startedAt: T0 + 3700 * 1000, completedAt: T0 + 3750 * 1000 },
    { id: "s2", ordinal: 2, title: "写入目标环境", tool: "file.write", status: "queued", startedAt: null, completedAt: null },
  ],
  t_done: [
    { id: "s1", ordinal: 1, title: "汇总已完成变更", tool: "file.read", status: "completed", startedAt: T0 - 7100 * 1000, completedAt: T0 - 6900 * 1000 },
    { id: "s2", ordinal: 2, title: "生成发布说明", tool: "file.write", status: "completed", startedAt: T0 - 6900 * 1000, completedAt: T0 - 6200 * 1000 },
    { id: "s3", ordinal: 3, title: "核对交付物", tool: "verification", status: "completed", startedAt: T0 - 6200 * 1000, completedAt: T0 - 6000 * 1000 },
  ],
};

const DELIVERABLES: Record<string, any[]> = {
  t_report: [{ id: "d1", name: "周报草稿.md", type: "file", createdAt: T0 + 11 * 60 * 1000 }],
  t_wait: [],
  t_done: [
    { id: "d1", name: "发布说明.pdf", type: "file", createdAt: T0 - 6100 * 1000 },
    { id: "d2", name: "变更清单.csv", type: "file", createdAt: T0 - 6050 * 1000 },
  ],
};

const CHECKPOINTS: Record<string, number> = { t_report: 2, t_wait: 1, t_done: 3 };

const EVENTS: Record<string, any[]> = {
  t_report: [
    { id: "e1", task_id: "t_report", sequence: 1, type: "task.created", message: "任务已创建", data_json: null, created_at: T0 },
    { id: "e2", task_id: "t_report", sequence: 2, type: "task.started", message: "开始执行", data_json: null, created_at: T0 + 60 * 1000 },
    { id: "e3", task_id: "t_report", sequence: 3, type: "task.step_completed", message: "步骤「收集本周记录」完成", data_json: null, created_at: T0 + 120 * 1000 },
  ],
  t_wait: [
    { id: "e1", task_id: "t_wait", sequence: 1, type: "task.created", message: "任务已创建", data_json: null, created_at: T0 + 3600 * 1000 },
    { id: "e2", task_id: "t_wait", sequence: 2, type: "task.step_completed", message: "步骤「读取部署配置」完成", data_json: null, created_at: T0 + 3750 * 1000 },
    { id: "e3", task_id: "t_wait", sequence: 3, type: "task.waiting_user", message: "请确认：是否覆盖现有 dist/ 目录？可选覆盖 / 跳过。", data_json: null, created_at: T0 + 3900 * 1000 },
  ],
  t_done: [
    { id: "e1", task_id: "t_done", sequence: 1, type: "task.created", message: "任务已创建", data_json: null, created_at: T0 - 7200 * 1000 },
    { id: "e2", task_id: "t_done", sequence: 2, type: "task.step_completed", message: "步骤「汇总已完成变更」完成", data_json: null, created_at: T0 - 6900 * 1000 },
    { id: "e3", task_id: "t_done", sequence: 3, type: "task.completed", message: "任务完成，产出 2 项交付物", data_json: null, created_at: T0 - 6000 * 1000 },
  ],
};

/* 运行中的增量事件：每次 task/events 调用追加一条，sequence 严格 +1。 */
const RUNNING_EXTRA = [
  "步骤「整理要点」调用模型（model.call）",
  "模型返回要点 5 条",
  "步骤「生成周报草稿」开始写入",
  "写入周报草稿.md（3.2 KB）",
  "核对交付物与验收目标",
];

/* ══════════════════════════════════════════════════════════════════════════
   U1 · core 任务（既有 tasks / task_steps 表）假桥
   ──────────────────────────────────────────────────────────────────────────
   形状对齐 task-bootstrap.cjs:152-182 的 task/get 信封与 task-domain.cjs:307-336
   的 safeTask / safeStep；命令域是 task/*（preload.cjs:151-158），与上面的 agent/*
   完全是两条通道，探针按两个独立列表记录命令。
   ══════════════════════════════════════════════════════════════════════════ */
function coreFixture() {
  const task: any = {
    taskId: "core_sync",
    userId: "u_probe",
    appId: "ai",
    goal: "同步素材库（core）",
    status: "SUCCEEDED",
    revision: 7,
    cancelRequested: false,
    createdAt: T0,
    updatedAt: T0 + 180000,
    startedAt: T0,
    completedAt: T0 + 120000,
    modelConfigId: "mc_default",
    modelConfigVersion: 2,
  };
  const steps: any[] = [
    { stepId: "cs1", taskId: "core_sync", sequence: 1, kind: "reasoning", status: "SUCCEEDED", input: null, outputRef: null, startedAt: T0, completedAt: T0 + 60000, attempt: 1, maxAttempts: 1 },
    { stepId: "cs2", taskId: "core_sync", sequence: 2, kind: "reasoning", status: "SUCCEEDED", input: null, outputRef: null, startedAt: T0 + 60000, completedAt: T0 + 120000, attempt: 1, maxAttempts: 1 },
  ];
  const artifacts: any[] = [
    { artifactId: "ca1", taskId: "core_sync", stepId: "cs2", runId: "run_core_1", type: "text", content: "已同步 3 个素材", checksum: "sha_ca1", createdAt: T0 + 120000 },
  ];
  const verifications: any[] = [
    { verificationId: "cv1", artifactId: "ca1", taskId: "core_sync", stepId: "cs2", runId: "run_core_1", type: "SCHEMA_VALID", status: "PASS", method: "SCHEMA_VALID", expected: null, actual: null, createdAt: T0 + 120000 },
  ];
  let appendable = true;
  let appendReason: string | null = null;
  let resumable = false;
  let resumeReason: string | null = "RESUME_NOT_BLOCKED";
  let stopReason: string | null = null;
  let recovery: any = { applicable: false, reason: null, calls: [] };

  /* core-denied：进行中 → appendable=false + 明确拒绝原因（状态不允许时禁用并给原因）。 */
  if (scenario === "core-denied") {
    task.status = "RUNNING";
    task.completedAt = null;
    steps[1].status = "RUNNING";
    steps[1].completedAt = null;
    appendable = false;
    appendReason = "APPEND_IN_FLIGHT";
  }
  /* core-recovery：BLOCKED + 结果未知副作用 → 续接可用 + 人工确认入口。 */
  if (scenario === "core-recovery") {
    task.status = "BLOCKED";
    appendable = false;
    appendReason = "APPEND_NOT_SUCCEEDED";
    resumable = true;
    resumeReason = null;
    stopReason = "RESUME_UNKNOWN_EFFECT_PRESENT";
    recovery = {
      applicable: true,
      reason: "RESUME_UNKNOWN_EFFECT_PRESENT",
      calls: [
        { callId: "call_unknown_1", toolId: "file.write", toolVersion: "1", status: "UNKNOWN_EFFECT", errorCode: "TOOL_TIMEOUT", stepId: "cs2", runId: "run_core_1", recoveryResult: "INDETERMINATE", recoveryReason: "结果无法判定，需要人工核查", acknowledged: false, acknowledgedAt: null, acknowledgedBy: null },
      ],
    };
  }
  return { task, steps, artifacts, verifications, appendable, appendReason, resumable, resumeReason, stopReason, recovery };
}

const CORE: any = coreFixture();
/* 统一读模型的 core 行：与 coreFixture 同一任务，保证列表与详情一致（status 每次现读，跟随场景）。 */
const coreUnifiedItem = () => ({
  source: "core",
  id: CORE.task.taskId,
  title: CORE.task.goal,
  status: CORE.task.status,
  projectId: null,
});
const coreProbe: any = { commands: [] as any[] };
(window as any).__oaTaskCoreProbe = coreProbe;

const listeners: Array<(e: any) => void> = [];
let eventSequence = 0;
const probe: any = {
  scenario,
  runMode,
  commands: [] as any[],
  events: [] as any[],
  taskEventsCalls: [] as any[],
  emit(event: any) {
    probe.events.push(event);
    for (const fn of listeners) {
      try {
        fn(event);
      } catch {
        /* 探针监听器异常不影响页面 */
      }
    }
  },
};
(window as any).__oaTaskProbe = probe;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const record = (command: string, payload: Record<string, unknown>) => {
  probe.commands.push({ command, payload });
};

const nextSequence = () => {
  eventSequence += 1;
  return eventSequence;
};

/** 模拟 agent-service.cjs:674-699：每条命令前后各发一条 progress（P1 信封）。 */
const emitProgress = (command: string, phase: string, requestId?: unknown) => {
  probe.emit({
    channel: "agent:event",
    domain: "agent",
    kind: "progress",
    sequence: nextSequence(),
    at: Date.now(),
    payload: { command, phase, requestId: requestId == null ? null : String(requestId) },
  });
};

function healthValue() {
  return {
    status: scenario === "unavailable" ? "degraded" : "ok",
    dependencies: {
      db: true,
      actorResolution: true,
      modelAdapter: true,
      providerAdapter: true,
      toolRunner: true,
      toolCatalog: scenario !== "unavailable",
      toolAuth: true,
      mcpSource: true,
      skillSource: true,
      canvasSource: true,
      // B6 已把 fsAdapter 真实接线（agent / skill / media 共用同一实例），
      // 默认按真实 health 语义置 true；?deps=fs-missing 才是显式的依赖缺失降级场景。
      // （与 dxos-ui-skills/harness.tsx 的 deps=all 默认同一口径，不再让默认态反映已不存在的事实。）
      fsAdapter: scenario !== "unavailable" && depsMode !== "fs-missing",
      workspaceAdapter: true,
      userDataDir: true,
      dbPath: true,
    },
  };
}

function findTask(taskId: unknown) {
  return READY_TASKS.find((t) => t.taskId === taskId);
}

async function command(raw: any) {
  const cmd = raw && raw.command;
  const payload = (raw && raw.payload) || {};
  record(String(cmd), payload);
  emitProgress(String(cmd), "begin", payload.requestId);
  const finish = (result: any) => {
    emitProgress(String(cmd), result && result.ok === false ? "failed" : "completed", payload.requestId);
    return result;
  };
  switch (cmd) {
    case "agent/health":
      return finish({ ok: true, value: healthValue() });
    case "agent/task/list":
      if (scenario === "loading") return new Promise(() => {});
      /* core-only / both-empty / core-error-only：DX 侧确实没有任务（与统一读模型的 DX 部分一致）。 */
      /* truncated-hidden：core 真实有 5 条却一条都没列进 items；DX 侧确实 0 条（与读模型的 dx 计数一致）。 */
      if (scenario === "empty" || scenario === "both-empty" || scenario === "core-only" || scenario === "core-only-dark" || scenario === "core-error-only" || scenario === "truncated-hidden")
        return finish({ ok: true, value: { items: [] } });
      if (scenario === "error") return finish({ ok: false, error: "AGENT_COMMAND_NOT_ALLOWED", message: "命令不在 agent:command 白名单内" });
      if (scenario === "unauthorized") return finish({ ok: false, error: "SESSION_EXPIRED", message: "会话已过期，请重新登录" });
      if (scenario === "unavailable")
        return finish({
          ok: false,
          error: "AGENT_DEPENDENCY_UNAVAILABLE",
          message: "工具目录未就绪：agent-tool-catalog.cjs 不可用",
          detail: { dependency: "toolCatalog", causeCode: "catalog_unavailable" },
        });
      return finish({ ok: true, value: { items: READY_TASKS } });
    case "agent/task/get": {
      const task = findTask(payload.taskId);
      if (!task) return finish({ ok: false, error: "AGENT_NOT_FOUND", message: "任务不存在" });
      return finish({
        ok: true,
        value: {
          /* 快照：真实 IPC 会结构化克隆，渲染层拿到的不是主进程对象的引用。
             不复制的话，下面的 answer/pause 改动会在下一次 React 渲染里"提前"反映出来。 */
          task: { ...task },
          steps: STEPS[task.taskId] || [],
          deliverables: DELIVERABLES[task.taskId] || [],
          checkpoints: CHECKPOINTS[task.taskId] || 0,
        },
      });
    }
    case "agent/task/events": {
      const taskId = String(payload.taskId || "");
      const after = Number.isFinite(Number(payload.afterSequence)) ? Number(payload.afterSequence) : 0;
      probe.taskEventsCalls.push({ taskId, afterSequence: after });
      const rows = EVENTS[taskId] || [];
      /* 运行中：每次轮询追加一条真实增量，sequence 严格递增。 */
      if (scenario === "running" && taskId === "t_report" && rows.length < 3 + RUNNING_EXTRA.length) {
        const index = rows.length - 3;
        const next = rows[rows.length - 1].sequence + 1;
        rows.push({
          id: "e" + next,
          task_id: taskId,
          sequence: next,
          type: index % 2 === 0 ? "task.step_completed" : "task.recovery",
          message: RUNNING_EXTRA[index] + "（增量事件 #" + next + "）",
          data_json: null,
          created_at: T0 + (180 + index * 30) * 1000,
        });
        if (runMode === "slow") await sleep(120);
      }
      return finish({ ok: true, value: { items: rows.filter((r) => r.sequence > after) } });
    }
    case "agent/task/answer": {
      const task = findTask(payload.taskId);
      if (!task) return finish({ ok: false, error: "AGENT_NOT_FOUND", message: "任务不存在" });
      if (task.status !== "waiting_user") return finish({ ok: false, error: "AGENT_CONFLICT", message: "该任务当前不在等待回答" });
      task.status = "queued";
      task.updatedAt = Date.now();
      const rows = EVENTS[task.taskId];
      rows.push({ id: "e" + (rows.length + 1), task_id: task.taskId, sequence: rows.length + 1, type: "task.answered", message: "用户已回答", data_json: null, created_at: Date.now() });
      if (runMode === "slow") await sleep(300);
      return finish({ ok: true, value: { task: { ...task } } });
    }
    case "agent/task/pause": {
      const task = findTask(payload.taskId);
      if (!task) return finish({ ok: false, error: "AGENT_NOT_FOUND", message: "任务不存在" });
      task.status = "paused";
      return finish({ ok: true, value: { task: { ...task } } });
    }
    case "agent/task/resume": {
      const task = findTask(payload.taskId);
      if (!task) return finish({ ok: false, error: "AGENT_NOT_FOUND", message: "任务不存在" });
      task.status = "queued";
      return finish({ ok: true, value: { task: { ...task } } });
    }
    case "agent/task/cancel": {
      const task = findTask(payload.taskId);
      if (!task) return finish({ ok: false, error: "AGENT_NOT_FOUND", message: "任务不存在" });
      task.status = "cancelled";
      return finish({ ok: true, value: { task: { ...task } } });
    }
    case "agent/task/continue": {
      const task = findTask(payload.taskId);
      if (!task) return finish({ ok: false, error: "AGENT_NOT_FOUND", message: "任务不存在" });
      if (task.mode !== "react") return finish({ ok: false, error: "AGENT_CONFLICT", message: "此任务使用固定步骤，不能追加要求" });
      task.status = "queued";
      return finish({ ok: true, value: { task: { ...task } } });
    }
    /* UI-3b 统一读模型：只读合并 dx / core 两套任务表（形状对齐 task-unified-view.cjs）。 */
    case "agent/task/unified-list": {
      const source = payload.source ? String(payload.source) : null;
      const unifiedValue = (all: any[], dxCount: number, coreCount: number) => {
        const items = all.filter((item) => !source || item.source === source);
        return {
          readModel: true,
          boundary: "这是读模型：不写任何表、不改变任何一方状态机。",
          sources: source ? [source] : ["dx", "core"],
          counts: { dx: dxCount, core: coreCount, total: dxCount + coreCount },
          items,
        };
      };
      /* 场景自洽：读模型的 DX 部分必须与 agent/task/list 同步，否则"两侧合并"会假就绪
         （例如 empty 场景里读模型仍返回任务）；core 侧是列表里 core 行的唯一来源。 */
      if (scenario === "loading") return new Promise(() => {});
      if (scenario === "empty" || scenario === "both-empty") return finish({ ok: true, value: unifiedValue([], 0, 0) });
      if (scenario === "core-only" || scenario === "core-only-dark")
        return finish({ ok: true, value: unifiedValue([coreUnifiedItem()], 0, 1) });
      /* U2 · 共享 limit 截断：core 真实 5 条，items 里只留下 1 条；counts > 列出，truncated=true。
         形状对齐 task-unified-view.cjs:listUnifiedTasks —— counts 是每侧真实总数，listed 是 items 实列数。 */
      if (scenario === "truncated" || scenario === "truncated-dark") {
        const items = [
          { source: "dx", id: "t_report", title: "整理本周周报", status: "RUNNING", projectId: "p_weekly" },
          { source: "dx", id: "t_wait", title: "确认部署目标", status: "WAITING", projectId: "p_weekly" },
          { source: "dx", id: "t_done", title: "生成发布说明", status: "SUCCEEDED", projectId: "p_weekly" },
          coreUnifiedItem(),
        ];
        return finish({
          ok: true,
          value: {
            readModel: true,
            boundary: "这是读模型：不写任何表、不改变任何一方状态机。",
            sources: ["dx", "core"],
            counts: { dx: 3, core: 5, total: 8 },
            listed: { dx: 3, core: 1, total: 4 },
            truncated: true,
            truncatedSides: ["core"],
            items,
          },
        });
      }
      /* U2 · 边界响应：真实有 core 5 条但 items 一条都没列出 —— 列表必须 ready 且有截断提示，
         不能因为"列不出 core 行"显示成空（这正是 U2 要堵的真缺口）。 */
      if (scenario === "truncated-hidden") {
        return finish({
          ok: true,
          value: {
            readModel: true,
            boundary: "这是读模型：不写任何表、不改变任何一方状态机。",
            sources: ["dx", "core"],
            counts: { dx: 0, core: 5, total: 5 },
            listed: { dx: 0, core: 0, total: 0 },
            truncated: true,
            truncatedSides: ["core"],
            items: [],
          },
        });
      }
      if (scenario === "core-error" || scenario === "core-error-only")
        return finish({ ok: false, error: "AGENT_INTERNAL", message: "统一读模型读取失败：core 来源不可用（演示）" });
      if (scenario === "error") return finish({ ok: false, error: "AGENT_COMMAND_NOT_ALLOWED", message: "命令不在 agent:command 白名单内" });
      if (scenario === "unauthorized") return finish({ ok: false, error: "SESSION_EXPIRED", message: "会话已过期，请重新登录" });
      if (scenario === "unavailable")
        return finish({
          ok: false,
          error: "AGENT_DEPENDENCY_UNAVAILABLE",
          message: "工具目录未就绪：agent-tool-catalog.cjs 不可用",
          detail: { dependency: "toolCatalog", causeCode: "catalog_unavailable" },
        });
      const all = [
        { source: "dx", id: "t_report", title: "整理本周周报", status: "RUNNING", projectId: "p_weekly" },
        { source: "dx", id: "t_wait", title: "确认部署目标", status: "WAITING", projectId: "p_weekly" },
        { source: "dx", id: "t_done", title: "生成发布说明", status: "SUCCEEDED", projectId: "p_weekly" },
        coreUnifiedItem(),
      ];
      return finish({ ok: true, value: unifiedValue(all, 3, 1) });
    }
    /* UI-3b 写操作入口：失败只在 ?scenario=entry-error 下按稳定码返回。 */
    case "agent/task/create": {
      if (scenario === "entry-error") return finish({ ok: false, error: "AGENT_FORBIDDEN", message: "当前账号或该应用没有被授这个动作" });
      if (runMode === "slow") await sleep(700);
      const taskId = "t_new_" + String(READY_TASKS.length + 1);
      const created = {
        taskId,
        projectId: String(payload.projectId || "p_weekly"),
        threadId: "th_new",
        title: String(payload.title || "新建任务"),
        instruction: String(payload.instruction || ""),
        status: "queued",
        mode: "react",
        executionProfile: "standard",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        startedAt: null,
        completedAt: null,
        errorCode: null,
        errorMessage: null,
        agentRunId: null,
      };
      READY_TASKS.push(created);
      return finish({ ok: true, value: { task: { ...created } } });
    }
    case "agent/tool/call":
      if (runMode === "slow") await sleep(700);
      return finish({ ok: true, value: { tool: String(payload.tool || ""), result: { ok: true, text: "（探针）工具已执行" } } });
    case "agent/project/run":
      if (scenario === "entry-error") return finish({ ok: false, error: "AGENT_DEPENDENCY_UNAVAILABLE", message: "模型调用出口未就绪", detail: { dependency: "modelAdapter" } });
      if (runMode === "slow") await sleep(700);
      return finish({ ok: true, value: { projectId: String(payload.projectId || ""), outcome: { kind: "completed", steps: 2 } } });
    case "agent/react/run":
      if (runMode === "slow") await sleep(700);
      return finish({ ok: true, value: { taskId: String(payload.taskId || ""), outcome: { kind: "completed" } } });
    default:
      return finish({ ok: false, error: "AGENT_COMMAND_NOT_ALLOWED", message: "未登记命令：" + String(cmd) });
  }
}

const agentBridge = {
  command,
  onEvent(cb: (e: any) => void) {
    listeners.push(cb);
    return () => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  },
};

/* ══════════════════════════════════════════════════════════════════════════
   基准页 SkillCenter（?page=skill）的就绪态假桥（只做内存 switch）
   ══════════════════════════════════════════════════════════════════════════ */
const READY_SKILLS: any[] = [
  {
    id: "writing",
    name: "写作生成",
    description: "生成诗歌、文案、故事、脚本、邮件、标题等原创文本，输出可直接交付的成品。",
    kind: "text",
    builtin: true,
    layer: "preset",
    origin: "official",
    exposure: "slash",
    enabled: true,
    systemPrompt: "你是中文写作助手。",
    inputSchema: { type: "object", properties: { instruction: { type: "string" } }, required: ["instruction"] },
  },
  {
    id: "analysis",
    name: "文本分析",
    description: "总结、归纳、对比、提取要点、诊断问题，输出结构化结论。",
    kind: "text",
    builtin: true,
    layer: "preset",
    origin: "official",
    exposure: "slash",
    enabled: false,
    systemPrompt: "你是分析总结助手。",
  },
  {
    id: "team_report",
    name: "团队周报",
    description: "把本周记录整理成周报草稿，含下周计划。",
    kind: "procedure",
    builtin: false,
    layer: "workflow",
    origin: "imported",
    exposure: "slash",
    enabled: true,
    systemPrompt: "你是周报执行器。",
    v2: {
      version: 1,
      triggers: ["周报"],
      steps: [
        { title: "收集素材", detail: "读取本周任务与记录" },
        { title: "生成周报", detail: "按模板输出草稿" },
      ],
    },
    source: { format: "agentskills/v1", instructions: "# 团队周报\n1. 收集素材\n2. 生成周报", files: [{ path: "reference/template.md" }] },
  },
];

const skillProbe: any = { page: "skill", commands: [] as any[] };
(window as any).__oaSkillProbe = skillProbe;

async function skillCommand(raw: any) {
  const cmd = raw && raw.command;
  const payload = (raw && raw.payload) || {};
  skillProbe.commands.push({ command: cmd, payload });
  switch (cmd) {
    case "skill/health":
      return { ok: true, value: { status: "ok", dependencies: { chatTarget: true, modelCall: true, cliRuntime: true, fsAdapter: true, mediaAdapter: true, skillWorkspace: true } } };
    case "skill/list":
      return { ok: true, value: { items: READY_SKILLS } };
    case "skill/pack/list":
      return { ok: true, value: { items: [] } };
    case "skill/get": {
      const skill = READY_SKILLS.find((s) => s.id === payload.skillId);
      return skill ? { ok: true, value: { skill } } : { ok: false, error: "SKILL_NOT_FOUND", message: "技能不存在" };
    }
    default:
      return { ok: false, error: "SKILL_COMMAND_NOT_ALLOWED", message: "未登记命令" };
  }
}

const skillBridge = { command: skillCommand, onEvent: () => () => {} };

/* ══════════════════════════════════════════════════════════════════════════
   U1 · core 任务假桥（task:command；命令域 task/*，与 agent/* 分开记录）
   ══════════════════════════════════════════════════════════════════════════ */
async function taskCommand(raw: any) {
  const cmd = String(raw && (raw.type != null ? raw.type : raw.command) || "");
  const payload = (raw && raw.payload) || {};
  coreProbe.commands.push({ command: cmd, payload });
  switch (cmd) {
    case "task/list":
      return { ok: true, items: [{ taskId: CORE.task.taskId, goal: CORE.task.goal, status: CORE.task.status }] };
    case "task/get":
      return {
        ok: true,
        task: { ...CORE.task },
        steps: CORE.steps.map((s: any) => ({ ...s })),
        artifacts: CORE.artifacts.map((a: any) => ({ ...a })),
        verifications: CORE.verifications.map((v: any) => ({ ...v })),
        deniedOperations: [],
        appendable: CORE.appendable,
        appendReason: CORE.appendReason,
        resumable: CORE.resumable,
        resumeReason: CORE.resumeReason,
        stopReason: CORE.stopReason,
        budgetLedger: null,
        recovery: {
          applicable: CORE.recovery.applicable,
          reason: CORE.recovery.reason,
          calls: CORE.recovery.calls.map((c: any) => ({ ...c })),
        },
      };
    case "task/appendStep": {
      if (scenario === "core-fail") return { ok: false, error: "TASK_REVISION_CONFLICT", message: "任务已被其他操作改动" };
      if (runMode === "slow") await sleep(1600);
      if (!CORE.appendable) return { ok: false, error: "APPEND_NOT_ALLOWED", reason: CORE.appendReason };
      CORE.steps.push({
        stepId: "cs" + (CORE.steps.length + 1),
        taskId: "core_sync",
        sequence: CORE.steps.length + 1,
        kind: "reasoning",
        status: "PENDING",
        input: { appended: true },
        outputRef: null,
        startedAt: null,
        completedAt: null,
        attempt: 1,
        maxAttempts: 1,
      });
      CORE.task.revision += 1;
      CORE.task.status = "RUNNING";
      CORE.appendable = false;
      CORE.appendReason = "APPEND_IN_FLIGHT";
      return { ok: true, task: { ...CORE.task }, step: { ...CORE.steps[CORE.steps.length - 1] }, appendIndex: CORE.steps.length, remaining: { MODEL_CALLS: 3 } };
    }
    case "task/resume": {
      if (runMode === "slow") await sleep(700);
      if (!CORE.resumable) return { ok: false, error: CORE.resumeReason || "RESUME_NOT_ELIGIBLE" };
      CORE.task.status = "RUNNING";
      CORE.task.revision += 1;
      CORE.resumable = false;
      return { ok: true, taskId: CORE.task.taskId, status: CORE.task.status };
    }
    case "task/cancel": {
      if (runMode === "slow") await sleep(700);
      CORE.task.status = "CANCELLED";
      CORE.task.cancelRequested = true;
      CORE.task.revision += 1;
      CORE.appendable = false;
      CORE.appendReason = "APPEND_NOT_SUCCEEDED";
      return { ok: true, cancelled: true, task: { ...CORE.task } };
    }
    case "task/recovery":
      return {
        ok: true,
        taskId: CORE.task.taskId,
        applicable: CORE.recovery.applicable,
        reason: CORE.recovery.reason,
        calls: CORE.recovery.calls.map((c: any) => ({ ...c })),
      };
    case "task/acknowledgeUnknownEffect": {
      if (runMode === "slow") await sleep(500);
      const callId = String(payload.callId || "");
      const call = CORE.recovery.calls.find((c: any) => c.callId === callId);
      if (!call) return { ok: false, error: "TASK_NOT_FOUND" };
      call.acknowledged = true;
      call.acknowledgedAt = Date.now();
      return { ok: true, changed: true, acknowledged: true, taskId: CORE.task.taskId, callId };
    }
    case "task/run":
      return { ok: false, error: "INVALID_INPUT" };
    default:
      return { ok: false, error: "TASK_COMMAND_NOT_ALLOWED" };
  }
}

const taskBridge = { command: taskCommand };
(window as any).openarc = { agent: agentBridge, skill: skillBridge, task: taskBridge };

/* ══════════════════════════════════════════════════════════════════════════
   外壳（与 main.tsx projects 分支同一 DOM 结构）
   ══════════════════════════════════════════════════════════════════════════ */
function SplitShell({ children, current, onSelect }: { children: React.ReactNode; current: string; onSelect?: (v: string) => void }) {
  return (
    <div className={"window" + (dark ? " dark" : "")} style={{ position: "absolute", inset: 0 }}>
      <div className="split">
        <nav className="split-side" aria-label="项目子视图">
          <div className="split-section">项目</div>
          <button className="split-nav" aria-current={current === "tasks"} onClick={() => onSelect && onSelect("tasks")}>
            任务控制台
          </button>
          <button className="split-nav" aria-current={current === "projects"} onClick={() => onSelect && onSelect("projects")}>
            项目与资源
          </button>
        </nav>
        <div className="split-main">{children}</div>
      </div>
    </div>
  );
}

function SkillShell() {
  const [tab, setTab] = useState<"market" | "mine" | "installed">("installed");
  return (
    <div className="window" style={{ position: "absolute", inset: 0 }}>
      <div className="split">
        <nav className="split-side" aria-label="Skill 分类">
          <div className="split-section">Skill</div>
          <button className="split-nav" aria-current={tab === "market"} onClick={() => setTab("market")}>
            市场
          </button>
          <button className="split-nav" aria-current={tab === "mine"} onClick={() => setTab("mine")}>
            我的技能
          </button>
          <div className="split-section">本机</div>
          <button className="split-nav" aria-current={tab === "installed"} onClick={() => setTab("installed")}>
            已安装
          </button>
        </nav>
        <div className="split-main">
          <SkillCenter tab={tab} role="ADMIN" />
        </div>
      </div>
    </div>
  );
}

function TaskShell() {
  const [tab, setTab] = useState("tasks");
  return (
    <SplitShell current={tab} onSelect={setTab}>
      {/* 探针只覆盖任务子视图；「项目与资源」由既有 D3-04D 探针负责真实渲染。 */}
      <TaskConsole role="ADMIN" />
    </SplitShell>
  );
}

const pageKind = params.get("page") || "task";
createRoot(document.getElementById("root")!).render(pageKind === "skill" ? <SkillShell /> : <TaskShell />);
