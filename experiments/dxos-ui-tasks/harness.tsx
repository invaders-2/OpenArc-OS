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
      if (scenario === "empty") return finish({ ok: true, value: { items: [] } });
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
      const items = [
        { source: "dx", id: "t_report", title: "整理本周周报", status: "RUNNING", projectId: "p_weekly" },
        { source: "dx", id: "t_wait", title: "确认部署目标", status: "WAITING", projectId: "p_weekly" },
        { source: "dx", id: "t_done", title: "生成发布说明", status: "SUCCEEDED", projectId: "p_weekly" },
        { source: "core", id: "core_sync", title: "同步素材库（core）", status: "RUNNING", projectId: null },
      ].filter((item) => !source || item.source === source);
      return finish({
        ok: true,
        value: {
          readModel: true,
          boundary: "这是读模型：不写任何表、不改变任何一方状态机。",
          sources: source ? [source] : ["dx", "core"],
          counts: { dx: 3, core: 1, total: 4 },
          items,
        },
      });
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
(window as any).openarc = { agent: agentBridge, skill: skillBridge };

/* ══════════════════════════════════════════════════════════════════════════
   外壳（与 main.tsx projects 分支同一 DOM 结构）
   ══════════════════════════════════════════════════════════════════════════ */
function SplitShell({ children, current, onSelect }: { children: React.ReactNode; current: string; onSelect?: (v: string) => void }) {
  return (
    <div className="window" style={{ position: "absolute", inset: 0 }}>
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
