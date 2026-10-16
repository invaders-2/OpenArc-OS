
/**
 * UI-3 · 任务 / Agent 控制台：纯逻辑层（无 React / 无 DOM / 无 I/O）。
 *
 * 为什么单独拆一层：11 态状态机映射、命令白名单、错误码→文案、依赖缺失说明、
 * agent:event / task 事件流的 sequence 合并，都是**可离线断言**的规则。
 * 放在 .tsx 里就只能在浏览器里测；放这里，tests/dxos-task-console.test.mjs
 * 直接 import 这份**界面真正在用**的逻辑。
 *
 * 边界（与 electron/agent-domain.cjs 同口径，界面层不做第二套）：
 *   · 命令白名单逐条对齐 electron/agent-domain.cjs:52-97 的 AGENT_COMMANDS；
 *   · 错误码逐条对齐 agent-domain.cjs:23-43 与 dxos-foundation-errors.cjs:12-26；
 *   · 11 态逐条对齐 agent-task-store.cjs:55-68 的 TASK_STATUSES；
 *   · 事件形状对齐 agent-service.cjs:465-473（task/events 返回 dx_task_events 原始行）
 *     与 dxos-foundation-events.cjs:74-90（agent:event 的 P1 信封）。
 *   渲染层自报的 userId / role / sessionRef 一律不发送（agent-bootstrap.cjs:45-50）。
 */

/* ══════════════════════════════════════════════════════════════════════════
   1. 命令白名单 —— 界面只能发这些命令（agent:command 的后端白名单）
   ══════════════════════════════════════════════════════════════════════════ */
export const AGENT_COMMANDS: readonly string[] = [
  "agent/task/create",
  "agent/task/list",
  "agent/task/get",
  "agent/task/events",
  "agent/task/answer",
  "agent/task/continue",
  "agent/task/pause",
  "agent/task/cancel",
  "agent/task/resume",
  "agent/task/delete",
  "agent/task/trace",
  "agent/task/stats",
  "agent/task/unified-list",
  "agent/run/get",
  "agent/run/inspect",
  "agent/run/list",
  "agent/tool/catalog",
  "agent/tool/describe",
  "agent/tool/call",
  "agent/capability/route",
  "agent/project/create",
  "agent/project/list",
  "agent/project/snapshot",
  "agent/project/run",
  "agent/memory/list",
  "agent/memory/save",
  "agent/react/run",
  "agent/health",
];

/** 未登记命令一律拒绝（不猜、不透传），与 agent-domain.cjs:102-104 同一条判据。 */
export function isAllowedAgentCommand(command: unknown): command is string {
  return typeof command === "string" && AGENT_COMMANDS.indexOf(command) >= 0;
}

/**
 * 控制台真正会发出的命令。
 *   · 只读 / 既有动作：health / list / get / events / answer / continue / pause / cancel / resume；
 *   · UI-3b 写操作入口：task/create、tool/call、project/run、react/run（审批在工具与权限层，
 *     界面只按风险标注并在依赖缺失时给人话提示）；
 *   · 统一读模型：task/unified-list（只读合并 DX 与 core 两套任务表，U1 交付）。
 * 每一条都必须在 AGENT_COMMANDS 内，测试逐条对齐后端 agent-domain.cjs。
 */
export const TASK_CONSOLE_COMMANDS: readonly string[] = [
  "agent/health",
  "agent/task/list",
  "agent/task/get",
  "agent/task/events",
  "agent/task/answer",
  "agent/task/continue",
  "agent/task/pause",
  "agent/task/cancel",
  "agent/task/resume",
  "agent/task/create",
  "agent/tool/call",
  "agent/project/run",
  "agent/react/run",
  "agent/task/unified-list",
];

/* ══════════════════════════════════════════════════════════════════════════
   2. 11 态任务状态机（agent-task-store.cjs:55-68）
   ══════════════════════════════════════════════════════════════════════════ */
export type TaskStatus =
  | "queued"
  | "planning"
  | "running"
  | "verifying"
  | "completed"
  | "waiting_user"
  | "waiting_children"
  | "paused"
  | "interrupted"
  | "failed"
  | "cancelled";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "queued",
  "planning",
  "running",
  "verifying",
  "completed",
  "waiting_user",
  "waiting_children",
  "paused",
  "interrupted",
  "failed",
  "cancelled",
];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "排队中",
  planning: "规划中",
  running: "执行中",
  verifying: "验证中",
  completed: "已完成",
  waiting_user: "等待你回答",
  waiting_children: "等待子任务",
  paused: "已暂停",
  interrupted: "已中断",
  failed: "失败",
  cancelled: "已取消",
};

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).indexOf(value) >= 0;
}

/** 后端返回未知状态时：界面显示原始值 + 归入 unknown 相位，不猜语义。 */
export function taskStatusLabel(status: unknown): string {
  return isTaskStatus(status) ? TASK_STATUS_LABEL[status] : status ? String(status) : "状态未知";
}

/* ══════════════════════════════════════════════════════════════════════════
   3. 11 态 → 界面相位（MOTION_SYSTEM §7 的状态反馈词汇）
   ══════════════════════════════════════════════════════════════════════════ */
export type TaskPhase =
  | "queued"
  | "running"
  | "verifying"
  | "success"
  | "waiting"
  | "waiting_children"
  | "paused"
  | "interrupted"
  | "failed"
  | "cancelled"
  | "unknown";

export const TASK_PHASES: readonly TaskPhase[] = [
  "queued",
  "running",
  "verifying",
  "success",
  "waiting",
  "waiting_children",
  "paused",
  "interrupted",
  "failed",
  "cancelled",
  "unknown",
];

export const TASK_PHASE_BY_STATUS: Record<TaskStatus, TaskPhase> = {
  queued: "queued",
  planning: "running",
  running: "running",
  verifying: "verifying",
  completed: "success",
  waiting_user: "waiting",
  /* waiting_children 与 waiting_user 分开：只有 waiting_user 需要用户作答，
     只有它会显示回答框（agent-task-store.cjs:927 只接受 waiting_user 的 answer）。 */
  waiting_children: "waiting_children",
  paused: "paused",
  interrupted: "interrupted",
  failed: "failed",
  cancelled: "cancelled",
};

export function taskPhase(status: unknown): TaskPhase {
  return isTaskStatus(status) ? TASK_PHASE_BY_STATUS[status] : "unknown";
}

/* ══════════════════════════════════════════════════════════════════════════
   4. 统一状态反馈（MOTION_SYSTEM §7）
      每个相位都给 label + glyph + 文字说明；颜色只是辅助通道，不单独传意。
      活动指示只出现在真实执行/验证状态（queued/waiting 停止转圈）。
   ══════════════════════════════════════════════════════════════════════════ */
export type TaskTone = "neutral" | "success" | "warning" | "danger";

export type TaskFeedback = {
  label: string;
  tone: TaskTone;
  /** 可见说明文字：为什么停、在等什么、下一步能做什么。 */
  detail: string;
  /** 是否有低强度活动指示（只用于真实执行/验证态）。 */
  active: boolean;
  glyph: string;
  /** 是否在等待用户输入（waiting_user）。 */
  needsAnswer: boolean;
};

export function taskFeedback(phase: TaskPhase): TaskFeedback {
  switch (phase) {
    case "queued":
      return {
        label: "已排队",
        tone: "neutral",
        detail: "等待执行槽位；还没有开始调用模型，也没有消耗工具调用。",
        active: false,
        glyph: "◷",
        needsAnswer: false,
      };
    case "running":
      return {
        label: "执行中",
        tone: "neutral",
        detail: "任务正在真实执行；增量进度来自 agent:event 的 progress 事件。",
        active: true,
        glyph: "◐",
        needsAnswer: false,
      };
    case "verifying":
      return {
        label: "验证中",
        tone: "neutral",
        detail: "正在核对步骤结果与验收目标；验证通过前不会显示成功。",
        active: true,
        glyph: "◇",
        needsAnswer: false,
      };
    case "success":
      return {
        label: "已完成",
        tone: "success",
        detail: "任务状态机已确认完成；产物见下方交付物。",
        active: false,
        glyph: "✓",
        needsAnswer: false,
      };
    case "waiting":
      return {
        label: "等待你的回答",
        tone: "warning",
        detail: "任务已停下等待输入；在回答框里作答后会重新排队。",
        active: false,
        glyph: "?",
        needsAnswer: true,
      };
    case "waiting_children":
      return {
        label: "等待子任务",
        tone: "neutral",
        detail: "任务在等待并行子任务返回；这不是需要你回答的等待，活动指示已停止。",
        active: false,
        glyph: "⧗",
        needsAnswer: false,
      };
    case "paused":
      return {
        label: "已暂停",
        tone: "warning",
        detail: "任务保留可续接状态；恢复后会从队列重新开始。",
        active: false,
        glyph: "❙❙",
        needsAnswer: false,
      };
    case "interrupted":
      return {
        label: "已中断",
        tone: "warning",
        detail: "执行中断，已完成动作保留；可恢复的任务会重新进入队列。",
        active: false,
        glyph: "◼",
        needsAnswer: false,
      };
    case "failed":
      return {
        label: "执行失败",
        tone: "danger",
        detail: "任务没有完成，原因见错误码说明；失败与「结果未知」分开呈现。",
        active: false,
        glyph: "!",
        needsAnswer: false,
      };
    case "cancelled":
      return {
        label: "已取消",
        tone: "neutral",
        detail: "取消请求已生效；已完成的动作保留，不反向播放。",
        active: false,
        glyph: "⊘",
        needsAnswer: false,
      };
    default:
      return {
        label: "状态未知",
        tone: "warning",
        detail: "后端返回了界面未登记的状态；不猜语义，请刷新或查看事件流。",
        active: false,
        glyph: "?",
        needsAnswer: false,
      };
  }
}

export function taskFeedbackForStatus(status: unknown): TaskFeedback {
  return taskFeedback(taskPhase(status));
}

/** 任务是否处于"进行态"（用于决定是否继续按 sequence 增量拉事件）。 */
export function isActiveTaskStatus(status: unknown): boolean {
  return status === "queued" || status === "planning" || status === "running" || status === "verifying" || status === "waiting_children";
}

/* ══════════════════════════════════════════════════════════════════════════
   5. 动作可用性（对齐 agent-task-store.cjs 真实围栏，界面只做可见的预判）
   ══════════════════════════════════════════════════════════════════════════ */
export function canAnswerTask(status: unknown): boolean {
  return status === "waiting_user";
}
/** pauseTask：queued / planning / running / verifying（agent-task-store.cjs:1060） */
export function canPauseTask(status: unknown): boolean {
  return status === "queued" || status === "planning" || status === "running" || status === "verifying";
}
/** cancelTask：completed / cancelled 之外都可（agent-task-store.cjs:1076） */
export function canCancelTask(status: unknown): boolean {
  return status !== "completed" && status !== "cancelled";
}
/** resumeTask：paused / interrupted / failed（还需 resume_safe，界面拿不到时显示原因） */
export function canResumeTask(status: unknown): boolean {
  return status === "paused" || status === "interrupted" || status === "failed";
}
/** continueTask：只对 react 模式，且不在执行中（agent-task-store.cjs:942） */
export function canContinueTask(status: unknown, mode: unknown): boolean {
  if (mode !== "react") return false;
  return !(status === "queued" || status === "planning" || status === "running" || status === "verifying");
}

export type TaskAction = "answer" | "pause" | "resume" | "cancel" | "continue";

/** 动作不可用的可见原因；返回 null 表示可执行。 */
export function taskActionDisabledReason(
  action: TaskAction,
  input: { status?: unknown; mode?: unknown; answer?: string },
): string | null {
  const status = input.status;
  switch (action) {
    case "answer":
      if (!canAnswerTask(status)) return "任务当前不在等待回答";
      if (!String(input.answer || "").trim()) return "回答不能为空";
      return null;
    case "pause":
      return canPauseTask(status) ? null : "只有排队 / 规划 / 执行 / 验证中的任务可以暂停";
    case "resume":
      return canResumeTask(status) ? null : "只有已暂停 / 已中断 / 失败的任务可以恢复";
    case "cancel":
      return canCancelTask(status) ? null : "已完成或已取消的任务不能再取消";
    case "continue":
      if (input.mode !== "react") return "固定步骤任务不能追加要求";
      return canContinueTask(status, input.mode) ? null : "任务正在执行，请先暂停或取消";
    default:
      return null;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   6. 错误码 → 人话 / PageState + 依赖缺失说明
   ══════════════════════════════════════════════════════════════════════════ */
export const TASK_ERROR_TEXT: Record<string, string> = {
  /* agent-domain.cjs:23-43 的 Agent 域自有码 */
  AGENT_COMMAND_NOT_ALLOWED: "命令不在 agent:command 白名单内，界面不会发送未登记的命令",
  AGENT_INVALID_INPUT: "输入不完整或不符合要求（例如缺少 taskId / answer）",
  AGENT_UNAUTHENTICATED: "当前会话未认证，agent 命令被拒绝；重新登录后再试",
  AGENT_FORBIDDEN: "当前账号或该应用没有被授这个动作",
  AGENT_NOT_FOUND: "该任务或 Agent Run 不存在，可能已被删除",
  AGENT_CONFLICT: "与任务当前状态冲突（例如取消已完成的任务）",
  AGENT_DEPENDENCY_UNAVAILABLE: "缺少执行该命令所需的依赖",
  AGENT_INTERNAL: "Agent 域内部错误，操作未完成",
  /* agent-bootstrap.cjs:14 —— Agent 域未装配时的稳定码 */
  AGENT_NOT_READY: "Agent 域尚未装配（当前环境没有可用的 Agent 服务）",
  /* dxos-foundation-errors.cjs:12-26 —— IPC 出口的实际失败码 */
  DXOS_ERR_INTERNAL: "主进程返回异常，任务操作未完成",
  DXOS_ERR_INVALID_INPUT: "输入被拒绝",
  DXOS_ERR_NOT_FOUND: "目标不存在，可能已被删除",
  DXOS_ERR_CONFLICT: "与当前状态冲突，请刷新后重试",
  DXOS_ERR_FORBIDDEN: "当前账号没有权限完成这个动作",
  DXOS_ERR_UNAVAILABLE: "当前环境不支持这个能力",
  DXOS_ERR_DEPENDENCY_MISSING: "缺少依赖：命令没有执行，任务也没有产生新产物",
  DXOS_ERR_TIMEOUT: "操作超时，任务可能仍在后台执行，请稍后刷新查看",
  DXOS_ERR_CANCELLED: "操作已取消",
  DXOS_ERR_CHILD_FAILED: "子任务失败，父任务没有继续",
  DXOS_ERR_QUOTA_EXCEEDED: "已超出当前配额",
  DXOS_ERR_QUOTA_LEDGER_MISSING: "缺少用量账本，操作被拒绝",
  DXOS_ERR_SCHEMA_TOO_NEW: "本地数据版本高于当前程序，拒绝写入",
  DXOS_ERR_UNSUPPORTED: "该能力在本地版本中关闭",
  /* 渲染层自己的事实位（前缀刻意与后端码区分，避免被当成后端码） */
  NO_BRIDGE: "桌面桥未接入（当前环境没有 agent 域）",
  RESPONSE_INCOMPLETE: "主进程返回的记录不完整，界面不猜内容",
  SESSION_EXPIRED: "会话已过期，请重新登录",
  SESSION_REVOKED: "会话已失效，请重新登录",
  LOCAL_INPUT_REQUIRED: "缺少必填内容（界面上先行拦截，没有发给后端）",
};

/** 未登记的码也给出可读兜底，并保留原始码显示（不塌缩成「未知错误」）。 */
export function taskErrorText(code: string): string {
  return TASK_ERROR_TEXT[code] || "任务操作失败";
}

const UNAUTHORIZED_CODES: readonly string[] = [
  "AGENT_UNAUTHENTICATED",
  "AGENT_FORBIDDEN",
  "DXOS_ERR_FORBIDDEN",
  "SESSION_EXPIRED",
  "SESSION_REVOKED",
];

const UNAVAILABLE_CODES: readonly string[] = [
  "AGENT_DEPENDENCY_UNAVAILABLE",
  "AGENT_NOT_READY",
  "NO_BRIDGE",
  "DXOS_ERR_DEPENDENCY_MISSING",
  "DXOS_ERR_UNAVAILABLE",
  "DXOS_ERR_UNSUPPORTED",
];

export type TaskPageStateKind = "loading" | "empty" | "error" | "unavailable" | "unauthorized";

export const TASK_PAGE_STATE_KINDS: readonly TaskPageStateKind[] = [
  "loading",
  "empty",
  "error",
  "unavailable",
  "unauthorized",
];

/** 失败码 → PageState kind（只返回 page-states.tsx 已登记的 kind）。 */
export function taskErrorState(code: string): TaskPageStateKind {
  if (UNAUTHORIZED_CODES.indexOf(code) >= 0) return "unauthorized";
  if (UNAVAILABLE_CODES.indexOf(code) >= 0) return "unavailable";
  return "error";
}

/* ── 列表状态按统一视图两侧（DX + core）合并判定 ───────────────────────────
   为什么按两侧：列表里的 DX 行来自 agent/task/list，core 行来自统一读模型的 core 来源。
   只按 DX 计数会让“只有 core 任务”的账号看到假空态（U1 报出的真缺口）。 */
export type TaskListSide = {
  loading: boolean;
  errorCode: string | null;
  count: number;
};

export type TaskListSideKey = "dx" | "core";

export type TaskListSides = {
  dependencyUnavailable: boolean;
  dx: TaskListSide;
  core: TaskListSide;
};

/** 计数口径：两侧各自有效条数相加；非法 / 负数按 0 处理，不参与“有数据”判定。 */
export function taskListCounts(sides: { dx: TaskListSide; core: TaskListSide }): { dx: number; core: number; total: number } {
  const norm = (n: number) => (Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0);
  const dx = norm(sides.dx.count);
  const core = norm(sides.core.count);
  return { dx, core, total: dx + core };
}

/** 失败的那几侧；没有失败返回空数组。 */
export function taskListFailedSides(sides: { dx: TaskListSide; core: TaskListSide }): TaskListSideKey[] {
  const out: TaskListSideKey[] = [];
  if (sides.dx.errorCode) out.push("dx");
  if (sides.core.errorCode) out.push("core");
  return out;
}

/**
 * 失败范围——用于区分“该侧失败”与“整体失败”：
 *   · "overall" —— 有侧失败且两侧都没有数据：整页按错误呈现（不把取数失败静默当成空）；
 *   · "side"    —— 有侧失败但另一侧还有数据：列表照常就绪，失败只作为该侧的局部提示；
 *   · "none"    —— 没有失败。
 */
export function taskListFailureScope(sides: { dx: TaskListSide; core: TaskListSide }): "none" | "side" | "overall" {
  if (!taskListFailedSides(sides).length) return "none";
  return taskListCounts(sides).total > 0 ? "side" : "overall";
}

/**
 * 页面状态判定的**优先级**（顺序即规则，与 skillCenterLogic.skillListState 同一口径）：
 *   1 依赖缺失 —— 环境事实，先于一切数据态
 *   2 两侧合并有数据 —— 就绪（另一侧的 loading / 失败不挡住已能看到的任务）
 *   3 任一侧失败且无数据 —— 整体失败（不静默成空）
 *   4 两侧都无数据且仍在加载
 *   5 两侧都空
 * 初值为 loading，避免先画一帧假空态。
 */
export function taskListStateFromSides(v: TaskListSides): TaskPageStateKind | "ready" {
  if (v.dependencyUnavailable) return "unavailable";
  if (taskListCounts(v).total > 0) return "ready";
  if (taskListFailedSides(v).length) return "error";
  if (v.dx.loading || v.core.loading) return "loading";
  return "empty";
}

/**
 * 旧口径：只按 DX 一侧计数（保留给只看单一来源的调用方与既有断言）。
 * 两侧合并判定请用 taskListStateFromSides。
 */
export function taskListState(v: {
  loading: boolean;
  errorCode: string | null;
  dependencyUnavailable: boolean;
  count: number;
}): TaskPageStateKind | "ready" {
  return taskListStateFromSides({
    dependencyUnavailable: v.dependencyUnavailable,
    dx: { loading: v.loading, errorCode: v.errorCode, count: v.count },
    core: { loading: false, errorCode: null, count: 0 },
  });
}

export const TASK_LIST_SIDE_LABEL: Record<TaskListSideKey, string> = {
  dx: "DX 任务列表（agent/task/list）",
  core: "core 任务列表（统一读模型 agent/task/unified-list）",
};

/** 整页失败标题：点名失败的是哪一侧，并保留稳定错误码（不塌缩成“未知错误”）。 */
export function taskListFailureTitle(side: TaskListSideKey | null, code: string | null): string {
  const label = side === "core" ? "core 任务列表" : "任务列表";
  return "读取" + (side === "core" ? " " : "") + label + "失败：" + taskErrorText(code || "AGENT_INTERNAL");
}

/* ── 依赖缺失：一定指出缺的是哪一个（agent/health 的 dependencies 清单）── */
export const TASK_DEPENDENCY_LABEL: Record<string, string> = {
  db: "任务数据库连接（identity store 的 SQLite）",
  actorResolution: "会话身份解析（authorization.resolveActor）",
  modelAdapter: "模型调用出口（provider-protocol-service.call）",
  providerAdapter: "模型供应商只读桥（provider-adapter-bridge）",
  "providerAdapter.chatWithTools": "模型供应商只读桥的 chatWithTools",
  "providerAdapter.autoFallback": "模型供应商只读桥的 autoFallback",
  toolRunner: "工具执行器（agent-builtin-tools.runTool）",
  "toolRunner.runTool": "工具执行器（agent-builtin-tools.runTool）",
  toolCatalog: "工具目录（agent-tool-catalog.cjs）",
  toolAuth: "工具权限判定（App Grant / AuthorizationService）",
  mcpSource: "MCP 工具来源（B4 已接）",
  skillSource: "技能工具来源（B4 已接）",
  canvasSource: "画布工具来源（B5）",
  fsAdapter: "虚拟文件树（B6 fsAdapter）",
  workspaceAdapter: "Agent 工作空间适配器",
  userDataDir: "运行数据目录",
  dbPath: "数据库文件路径",
  agentRuntime: "Agent 运行管理器（agent-runtime-manager）",
  "agentRuntime.normalizeEnvelope": "Agent 请求信封归一化",
  usage: "用量记账（agent-runtime-usage）",
  fallback: "模型回退（agent-runtime-fallback）",
  "fallback.runWithAgentModelFallback": "模型回退 runWithAgentModelFallback",
  toolLoop: "服务端工具循环（agent-runtime-tool-loop）",
  capability: "能力目标解析（capability-target-resolver）",
  skillRunner: "技能执行器（skill-runner）",
  mcpAdapter: "MCP 调用适配器",
  clock: "时钟",
};

export function dependencyLabel(key: string): string {
  return TASK_DEPENDENCY_LABEL[key] || key;
}

/** agent/health 的 dependencies 里值为 false 的键（环境缺失事实）。 */
export function missingDependencies(health: unknown): { key: string; label: string }[] {
  if (!health || typeof health !== "object") return [];
  const deps = (health as { dependencies?: unknown }).dependencies;
  if (!deps || typeof deps !== "object") return [];
  const out: { key: string; label: string }[] = [];
  for (const [key, value] of Object.entries(deps as Record<string, unknown>)) {
    if (value === false) out.push({ key, label: dependencyLabel(key) });
  }
  return out;
}

/** AGENT_DEPENDENCY_UNAVAILABLE 的显式文案：必须说明缺哪个依赖，且任务没有产物。 */
export const TASK_DEPENDENCY_TEXT =
  "缺少执行该命令所需的依赖（模型连接、工具目录或虚拟文件树）。命令没有执行，任务也没有产生任何产物；接入依赖后可以重试。";

export function dependencyMissingText(input: {
  code?: string | null;
  dependency?: unknown;
  missing?: { key: string; label: string }[];
  message?: string | null;
}): string {
  const code = input.code == null ? "" : String(input.code);
  if (code === "AGENT_NOT_READY") {
    return "Agent 域尚未装配：当前环境没有可用的 Agent 服务。命令没有执行，任务也没有产生任何产物。";
  }
  if (code === "NO_BRIDGE") {
    return "桌面桥未接入：当前环境没有 agent 域。命令没有执行，任务也没有产生任何产物。";
  }
  if (code !== "AGENT_DEPENDENCY_UNAVAILABLE" && code !== "DXOS_ERR_DEPENDENCY_MISSING") {
    return input.message ? String(input.message) : taskErrorText(code);
  }
  const dependency = input.dependency == null ? "" : String(input.dependency).trim();
  if (dependency) {
    return "缺少依赖：" + dependencyLabel(dependency) + "（" + dependency + "）。命令没有执行，任务也没有产生任何产物；接入后可以重试。";
  }
  const missing = Array.isArray(input.missing) ? input.missing : [];
  if (missing.length) {
    return "缺少依赖：" + missing.map((m) => m.label).join("、") + "。命令没有执行，任务也没有产生任何产物；接入后可以重试。";
  }
  return TASK_DEPENDENCY_TEXT;
}

/** 从错误的 detail.dependency 取依赖名（agent-service.cjs:84-101 的形状）。 */
export function dependencyOfDetail(detail: unknown): string | null {
  if (!detail || typeof detail !== "object") return null;
  const value = (detail as { dependency?: unknown }).dependency;
  return typeof value === "string" && value.trim() ? value : null;
}

/* ══════════════════════════════════════════════════════════════════════════
   7. 任务事件流：规范化 + 按 sequence 合并（单调、去重、缺口检测）
      agent/task/events 返回 dx_task_events 原始行，字段 snake_case；
      created_at 是毫秒时间戳，sequence 由 agent-task-store.cjs:546 的
      MAX(sequence)+1 保证同任务内单调递增。
   ══════════════════════════════════════════════════════════════════════════ */
export type TaskEvent = {
  sequence: number;
  type: string;
  message: string;
  at: number | null;
};

export function normalizeTaskEvent(input: unknown): TaskEvent | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const row = input as Record<string, unknown>;
  const sequence = Number(row.sequence);
  if (!Number.isFinite(sequence) || sequence <= 0) return null;
  const type = typeof row.type === "string" && row.type ? row.type : "task.event";
  const message = typeof row.message === "string" ? row.message : "";
  const rawAt = row.created_at != null ? row.created_at : row.at;
  const at = Number.isFinite(Number(rawAt)) ? Number(rawAt) : null;
  return { sequence: Math.trunc(sequence), type, message, at };
}

export type MergeResult = {
  events: TaskEvent[];
  added: number;
  duplicate: number;
  highest: number;
  /** 保留区间内是否存在 sequence 断号（丢事件）。 */
  gap: boolean;
};

export function mergeTaskEvents(prev: TaskEvent[], incoming: unknown, cap = 200): MergeResult {
  const map = new Map<number, TaskEvent>();
  for (const e of prev || []) map.set(e.sequence, e);
  let added = 0;
  let duplicate = 0;
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const event = normalizeTaskEvent(raw);
    if (!event) continue;
    if (map.has(event.sequence)) {
      duplicate += 1;
      continue;
    }
    map.set(event.sequence, event);
    added += 1;
  }
  const events = Array.from(map.values()).sort((a, b) => a.sequence - b.sequence);
  let gap = false;
  for (let i = 1; i < events.length; i += 1) {
    if (events[i].sequence !== events[i - 1].sequence + 1) {
      gap = true;
      break;
    }
  }
  const highest = events.length ? events[events.length - 1].sequence : 0;
  const limited = cap > 0 && events.length > cap ? events.slice(events.length - cap) : events;
  return { events: limited, added, duplicate, highest, gap };
}

/** 增量拉取前的游标：已合并的最高 sequence（0 表示从未拉过）。 */
export function nextEventCursor(events: TaskEvent[]): number {
  return events.length ? events[events.length - 1].sequence : 0;
}

/** 单个新 sequence 相对当前最高值的关系。 */
export function taskEventSequenceState(highest: number, sequence: number): "ok" | "duplicate" | "gap" | "invalid" {
  if (!Number.isFinite(sequence) || sequence <= 0) return "invalid";
  if (sequence <= highest) return "duplicate";
  if (sequence === highest + 1) return "ok";
  return "gap";
}

/* ── agent:event（命令进度信封）：只认 progress，sequence 单调判定 ── */
export type AgentProgressEvent = {
  channel?: string;
  domain?: string;
  kind?: string;
  sequence?: number;
  at?: number;
  payload?: { command?: string; phase?: string; requestId?: string | null };
};

export type AgentProgressPhase = "begin" | "completed" | "failed" | "rejected";

export function agentProgressPhase(event: AgentProgressEvent | null | undefined): AgentProgressPhase | null {
  if (!event || event.kind !== "progress") return null;
  const phase = event.payload && event.payload.phase;
  if (phase === "begin" || phase === "completed" || phase === "failed" || phase === "rejected") {
    return phase;
  }
  return null;
}

/** agent:event 的 sequence 判定：ok / duplicate / gap / invalid（信封在 dxos-foundation-events.cjs:74-90）。 */
export function progressSequenceState(last: number, event: AgentProgressEvent | null | undefined): {
  status: "ok" | "duplicate" | "gap" | "invalid";
  last: number;
} {
  const sequence = event && event.sequence;
  if (!Number.isFinite(sequence) || (sequence as number) <= 0) return { status: "invalid", last };
  /* 首个事件只建立基线：agent:event 是跨命令共享通道，控制台开始订阅时序列早已在推进，
     把"第一次看到的序号不是 1"判成丢帧会误导用户（MOTION_SYSTEM §7 不伪造异常）。 */
  if (last <= 0) return { status: "ok", last: sequence as number };
  if ((sequence as number) <= last) return { status: "duplicate", last };
  if ((sequence as number) === last + 1) return { status: "ok", last: sequence as number };
  return { status: "gap", last: sequence as number };
}

/* ══════════════════════════════════════════════════════════════════════════
   8. 事件文案 / 等待提问 / 步骤进度
   ══════════════════════════════════════════════════════════════════════════ */
export const TASK_EVENT_LABEL: Record<string, string> = {
  "task.created": "任务已创建",
  "task.queued": "进入队列",
  "task.planning": "开始规划",
  "task.plan": "已生成计划",
  "task.started": "开始执行",
  "task.step_started": "步骤开始",
  "task.step_completed": "步骤完成",
  "task.step_failed": "步骤失败",
  "task.waiting_user": "等待用户回答",
  "task.answered": "用户已回答",
  "task.continued": "用户追加要求",
  "task.paused": "任务已暂停",
  "task.resumed": "任务重新排队",
  "task.cancelled": "任务已取消",
  "task.failed": "任务失败",
  "task.completed": "任务完成",
  "task.checkpoint": "写入检查点",
  "task.deliverable": "产出交付物",
  "task.interrupted": "任务中断",
  "task.verifying": "开始验证",
  "task.instruction_refreshed": "验收目标已刷新",
  "task.recovery": "恢复执行",
};

export function taskEventLabel(type: unknown): string {
  const key = type == null ? "" : String(type);
  return TASK_EVENT_LABEL[key] || key || "任务事件";
}

/** waiting_user 的提问文本只存在于事件流（taskSummary 不投影 waiting_question）。 */
export function waitingQuestionFromEvents(events: TaskEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.type === "task.waiting_user" && e.message) return e.message;
  }
  return null;
}

export type TaskStep = {
  id?: string;
  ordinal?: number;
  title?: string;
  tool?: string;
  status?: string;
  startedAt?: number | null;
  completedAt?: number | null;
};

export const STEP_STATUS_LABEL: Record<string, string> = {
  queued: "排队",
  running: "执行中",
  verifying: "验证中",
  completed: "已完成",
  failed: "失败",
  skipped: "跳过",
};

export function stepStatusLabel(status: unknown): string {
  return STEP_STATUS_LABEL[String(status)] || (status ? String(status) : "未知");
}

export function stepProgress(steps: TaskStep[]): { done: number; total: number; ratio: number | null } {
  const total = Array.isArray(steps) ? steps.length : 0;
  const done = (Array.isArray(steps) ? steps : []).filter((s) => s && s.status === "completed").length;
  return { done, total, ratio: total > 0 ? done / total : null };
}

/** 搜索过滤：标题 / taskId / 指令。 */
export function filterTasks<T extends { taskId?: string; title?: string; instruction?: string }>(tasks: T[], query: string): T[] {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return tasks;
  return tasks.filter((t) => {
    const hay = [t.taskId, t.title, t.instruction]
      .filter((v) => typeof v === "string")
      .join("\n")
      .toLowerCase();
    return hay.indexOf(q) >= 0;
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   9. 窄宽 / 空态判定（纯逻辑，供探针与界面共用同一条阈值）
      CSS 的容器查询阈值是 900px（见 styles.css 的 @container (max-width: 900px)）。
   ══════════════════════════════════════════════════════════════════════════ */
export const TASK_NARROW_MAX = 900;

export function isNarrowLayout(width: number): boolean {
  return Number.isFinite(width) && width <= TASK_NARROW_MAX;
}

export function isEmptyTaskList(count: number): boolean {
  return !Number.isFinite(count) || count <= 0;
}

/* ══════════════════════════════════════════════════════════════════════════
   10. 写操作入口（UI-3b）—— 新建任务 / 调用工具 / 跑项目 / ReAct
   ──────────────────────────────────────────────────────────────────────────
   四条命令都在后端白名单里（agent-domain.cjs:52-97），界面这一轮补的是：
     · 可用性判定：agent/health 的 dependencies 里缺哪个依赖就说清哪个（工具目录 / 模型站点）；
     · 风险标注：写类 / 外部副作用在 UI 上显式标出，与既有审批语义一致（调用不绕过审批）；
     · 进行中 / 失败：按钮 disabled + aria-busy，失败显示稳定错误码 → 人话。
   入口本身不新增命令语义，也不替后端做权限判定。
   ══════════════════════════════════════════════════════════════════════════ */
export type TaskEntryKey = "create" | "tool-call" | "project-run" | "react-run";

export const TASK_ENTRY_KEYS: readonly TaskEntryKey[] = [
  "create",
  "tool-call",
  "project-run",
  "react-run",
];

export type TaskEntryRisk = "write" | "external-side-effect" | "model-call";

export type TaskEntryMeta = {
  key: TaskEntryKey;
  command: string;
  label: string;
  description: string;
  /** 风险类别：写 / 外部副作用 / 真实模型调用。 */
  risk: TaskEntryRisk;
  /** 是否走审批（外部副作用按既有审批语义逐次确认）。 */
  requiresApproval: boolean;
  /** 需要的后端依赖（agent/health 的 dependencies 键）。 */
  requires: readonly string[];
  /** 主要输入（界面据此渲染字段并提示必填）。 */
  inputs: readonly string[];
};

/**
 * 依赖清单照后端真实校验写：
 *   · task/create：createTask 需要 db / actorResolution；
 *   · tool/call：resolveToolByName 需要 toolCatalog / toolRunner / toolAuth，文件类工具还要 fsAdapter；
 *   · project/run：project-agent-mode.cjs:117-147 逐项 requireAdapter；
 *   · react/run：agent-react-driver.cjs:240-263 的 REQUIRED_ADAPTERS。
 */
export const TASK_ENTRIES: readonly TaskEntryMeta[] = [
  {
    key: "create",
    command: "agent/task/create",
    label: "新建任务",
    description: "登记一条 Agent 任务（固定步骤或 ReAct 由入参决定）。只写任务记录，不调用模型。",
    risk: "write",
    requiresApproval: false,
    requires: ["db", "actorResolution"],
    inputs: ["projectId", "instruction", "title"],
  },
  {
    key: "tool-call",
    command: "agent/tool/call",
    label: "调用工具",
    description: "真实执行一个已登记的工具；外部副作用按既有审批语义逐次确认。",
    risk: "external-side-effect",
    requiresApproval: true,
    requires: ["toolCatalog", "toolRunner", "toolAuth", "fsAdapter"],
    inputs: ["tool", "arguments"],
  },
  {
    key: "project-run",
    command: "agent/project/run",
    label: "跑项目",
    description: "按项目 Agent 模式跑一次完整任务：真实调用模型与工具，可能落盘产物。",
    risk: "model-call",
    requiresApproval: false,
    requires: [
      "modelAdapter",
      "providerAdapter",
      "toolRunner",
      "toolCatalog",
      "workspaceAdapter",
      "agentRuntime",
      "capability",
      "usage",
      "fallback",
      "toolLoop",
    ],
    inputs: ["projectId", "instruction"],
  },
  {
    key: "react-run",
    command: "agent/react/run",
    label: "ReAct 运行",
    description: "对一条 ReAct 任务继续跑驱动循环：真实调用模型与工具，并消耗预算。",
    risk: "model-call",
    requiresApproval: false,
    requires: [
      "modelAdapter",
      "providerAdapter",
      "toolRunner",
      "toolCatalog",
      "workspaceAdapter",
      "agentRuntime",
      "capability",
      "usage",
      "fallback",
    ],
    inputs: ["taskId"],
  },
];

export function taskEntryMeta(key: unknown): TaskEntryMeta | null {
  const found = TASK_ENTRIES.find((e) => e.key === key);
  return found || null;
}

/** 入口风险提示：与既有审批语义一致（写 / 外部副作用要显式说明）。 */
export const TASK_ENTRY_RISK_TEXT: Record<TaskEntryKey, string> = {
  create: "写操作：会新建一条任务记录（可取消 / 删除），不调用模型。",
  "tool-call": "外部副作用：会真实执行工具；写类工具按既有审批语义逐次确认，界面不绕过审批。",
  "project-run": "写操作 + 真实调用：会创建项目 Run，调用模型与工具并可能落盘产物。",
  "react-run": "写操作 + 真实模型调用：ReAct 循环会消耗预算并真实调用工具。",
};

export const TASK_ENTRY_RISK_LABEL: Record<TaskEntryRisk, string> = {
  write: "写操作",
  "external-side-effect": "外部副作用",
  "model-call": "真实模型调用",
};

export function taskEntryRiskText(key: unknown): string {
  const meta = taskEntryMeta(key);
  return meta ? TASK_ENTRY_RISK_TEXT[meta.key] : "";
}

export type TaskEntryAvailabilityKind = "ready" | "no-bridge" | "dependency" | "input";

export type TaskEntryAvailability = {
  available: boolean;
  kind: TaskEntryAvailabilityKind;
  title: string;
  description: string;
  missing: { key: string; label: string }[];
};

/**
 * 入口可用性：桥缺失 > 依赖缺失 > 就绪。
 * missing 只统计 agent/health 明确为 false 的依赖；health 未加载时不假设缺失。
 */
export function taskEntryAvailability(
  key: unknown,
  input: { hasBridge: boolean; missing: { key: string; label: string }[] },
): TaskEntryAvailability {
  const meta = taskEntryMeta(key);
  if (!meta) {
    return { available: false, kind: "input", title: "未登记的入口", description: "界面不猜语义。", missing: [] };
  }
  if (!input.hasBridge) {
    return {
      available: false,
      kind: "no-bridge",
      title: meta.label + "不可用：桌面桥未接入",
      description: dependencyMissingText({ code: "NO_BRIDGE" }),
      missing: [],
    };
  }
  const required = new Set(meta.requires);
  const missing = (Array.isArray(input.missing) ? input.missing : []).filter((m) => required.has(m.key));
  if (missing.length) {
    return {
      available: false,
      kind: "dependency",
      title: meta.label + "不可用：缺少 " + missing.map((m) => m.label).join("、"),
      description: taskEntryDependencyText(meta, missing),
      missing,
    };
  }
  return {
    available: true,
    kind: "ready",
    title: meta.label + "可用",
    description: "依赖已就绪；命令会真实发往主进程，失败会显示稳定错误码。",
    missing: [],
  };
}

/** 依赖缺失的结构化人话：点名缺哪个依赖，并说明没有产物。 */
export function taskEntryDependencyText(
  meta: TaskEntryMeta,
  missing: { key: string; label: string }[],
): string {
  const labels = (Array.isArray(missing) ? missing : []).map((m) => m.label + "（" + m.key + "）");
  const head = labels.length ? "缺少依赖：" + labels.join("、") + "。" : "缺少执行该命令所需的依赖。";
  return head + "命令没有执行，任务也没有产生任何产物；接入后可以重试。";
}

/** 必填输入（与后端 requireStr 的必填项一致）：其余字段可留空。 */
export const TASK_ENTRY_REQUIRED_INPUTS: Record<TaskEntryKey, readonly string[]> = {
  create: ["projectId", "instruction"],
  "tool-call": ["tool"],
  "project-run": ["projectId", "instruction"],
  "react-run": ["taskId"],
};

export const TASK_ENTRY_INPUT_LABEL: Record<string, string> = {
  projectId: "项目 ID",
  instruction: "指令",
  title: "标题（可选）",
  tool: "工具名",
  arguments: "参数 JSON（可选）",
  taskId: "任务 ID",
};

/** 缺哪些必填项：界面先行拦截，不发空命令给后端。 */
export function taskEntryMissingInputs(key: unknown, values: Record<string, unknown>): string[] {
  const meta = taskEntryMeta(key);
  if (!meta) return [];
  const required = TASK_ENTRY_REQUIRED_INPUTS[meta.key] || [];
  return required.filter((field) => !String((values || {})[field] == null ? "" : (values || {})[field]).trim());
}

/* ── 写类入口的二次确认（UI-3c）────────────────────────────────────────────
   四个入口都会产生真实副作用，按产品既有约定在发出命令前显式确认：
     · 确认前不发命令；取消则命令数 0；确认后才发送（判据在界面 handler，文案在这里）。
   文案只描述"将要发生什么"和"这次会发什么载荷"，不预告成功、不假装结果。 */
export const TASK_ENTRY_CONFIRM_TITLE: Record<TaskEntryKey, string> = {
  create: "确认新建任务",
  "tool-call": "确认调用工具",
  "project-run": "确认运行项目",
  "react-run": "确认 ReAct 运行",
};

const TASK_ENTRY_CONFIRM_HEAD: Record<TaskEntryRisk, string> = {
  write: "写操作：确认后会写入一条新的任务记录，并可能调用模型与工具。",
  "external-side-effect": "外部副作用：确认后会真实执行该工具，写类工具的审批不会因此被绕过。",
  "model-call": "真实调用：确认后会调用模型与工具，可能消耗预算并落盘产物。",
};

export function taskEntryConfirmTitle(key: unknown): string {
  const meta = taskEntryMeta(key);
  if (!meta) return "确认";
  return TASK_ENTRY_CONFIRM_TITLE[meta.key];
}

/** 确认框正文：副作用说明 + 本次将要发送的载荷摘要（仅已填字段）。 */
export function taskEntryConfirmSummary(key: unknown, payload: Record<string, unknown>): string {
  const meta = taskEntryMeta(key);
  if (!meta) return "";
  const head = TASK_ENTRY_CONFIRM_HEAD[meta.risk] || TASK_ENTRY_CONFIRM_HEAD.write;
  const facts = meta.inputs
    .filter((field) => (payload || {})[field] !== undefined)
    .map((field) => (TASK_ENTRY_INPUT_LABEL[field] || field) + "：" + String((payload || {})[field]))
    .join("；");
  return facts ? head + " 本次载荷——" + facts : head;
}

/* ── 统一读模型（DX 11 态 + core 7 态）：只用于列表来源标注，不改任何状态机 ── */
export const UNIFIED_READ_MODEL_COMMAND = "agent/task/unified-list";
export const UNIFIED_SOURCES: readonly string[] = ["dx", "core"];

export type UnifiedItem = {
  source: string;
  id: string;
  title: string;
  status: string | null;
  projectId: string | null;
};

export type UnifiedListView = {
  ok: boolean;
  readModel: boolean;
  sources: string[];
  counts: { dx: number; core: number; total: number };
  items: UnifiedItem[];
  boundary: string;
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function normalizeUnifiedList(result: unknown): UnifiedListView {
  const root = isObj(result) ? (isObj(result.value) ? (result.value as Record<string, unknown>) : result) : {};
  const itemsRaw = Array.isArray(root.items) ? root.items : [];
  const items: UnifiedItem[] = [];
  for (const raw of itemsRaw) {
    if (!isObj(raw)) continue;
    const source = typeof raw.source === "string" ? raw.source : "";
    const id = typeof raw.id === "string" ? raw.id : "";
    if (!source || !id) continue;
    items.push({
      source,
      id,
      title: typeof raw.title === "string" ? raw.title : "",
      status: typeof raw.status === "string" ? raw.status : null,
      projectId: typeof raw.projectId === "string" ? raw.projectId : null,
    });
  }
  const countsRaw = isObj(root.counts) ? root.counts : {};
  const counts = {
    dx: Number.isFinite(Number(countsRaw.dx)) ? Number(countsRaw.dx) : 0,
    core: Number.isFinite(Number(countsRaw.core)) ? Number(countsRaw.core) : 0,
    total: Number.isFinite(Number(countsRaw.total)) ? Number(countsRaw.total) : items.length,
  };
  const sources = Array.isArray(root.sources)
    ? root.sources.filter((s): s is string => typeof s === "string")
    : [];
  return {
    ok: root.ok !== false,
    readModel: root.readModel === true,
    sources: sources.length ? sources : UNIFIED_SOURCES.slice(),
    counts,
    items,
    boundary: typeof root.boundary === "string" ? root.boundary : "",
  };
}

export const UNIFIED_SOURCE_LABEL: Record<string, string> = {
  dx: "DX（新任务表）",
  core: "core（既有任务表）",
};

export function unifiedSourceLabel(source: unknown): string {
  const key = source == null ? "" : String(source);
  return UNIFIED_SOURCE_LABEL[key] || (key || "来源未知");
}

/** id → 来源（同 id 命中两套表就并列，官方读模型本身不做优先级猜测）。 */
export function unifiedSourceIndex(items: UnifiedItem[]): Record<string, string> {
  const map: Record<string, Set<string>> = {};
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !item.id || !item.source) continue;
    if (!map[item.id]) map[item.id] = new Set<string>();
    map[item.id].add(item.source);
  }
  const out: Record<string, string> = {};
  for (const [id, set] of Object.entries(map)) {
    out[id] = UNIFIED_SOURCES.filter((s) => set.has(s)).join("+") || Array.from(set).join("+");
  }
  return out;
}

export function unifiedSourceBadge(source: unknown): { label: string; tone: TaskTone } {
  const key = source == null ? "" : String(source);
  if (key === "dx") return { label: "DX", tone: "neutral" };
  if (key === "core") return { label: "core", tone: "neutral" };
  if (key === "dx+core") return { label: "DX + core", tone: "warning" };
  return { label: key || "来源未知", tone: "warning" };
}

export function unifiedCountsText(view: UnifiedListView | null): string {
  if (!view || !view.ok) return "统一读模型未返回";
  return "统一读模型：dx " + view.counts.dx + " / core " + view.counts.core + " / 共 " + view.counts.total;
}


/* ══════════════════════════════════════════════════════════════════════════
   10. core 任务域（既有 tasks / task_steps / task_events）—— 另一套命令与动作
   ──────────────────────────────────────────────────────────────────────────
   为什么单独一段：统一读模型把 core 任务显到同一张列表里，但它的命令通道
   与 DX 完全不同 —— DX 走 agent/*（agent:command），core 走 task/*（task:command，
   preload.cjs:151-158 的 window.openarc.task）。两套命令域必须分开登记、分开
   判定、分开渲染文案，界面不允许把 agent/task/continue 当成 core 的“追加步骤”。
   ══════════════════════════════════════════════════════════════════════════ */

/** electron/task-bootstrap.cjs:106 的 TASK_COMMANDS 全量；界面只发这些，一条不多。 */
export const CORE_TASK_COMMANDS: readonly string[] = [
  "task/run",
  "task/get",
  "task/list",
  "task/cancel",
  "task/resume",
  "task/appendStep",
  "task/recovery",
  "task/acknowledgeUnknownEffect",
];

/** 未登记命令一律拒绝（与 task-bootstrap.cjs:115 的后端判据同一条）。 */
export function isAllowedCoreTaskCommand(command: unknown): command is string {
  return typeof command === "string" && (CORE_TASK_COMMANDS as readonly string[]).indexOf(command) >= 0;
}

/* ── core 7 态（task-domain.cjs:9-18）────────────────────────────────── */
export const CORE_TASK_STATUSES: readonly string[] = [
  "PENDING",
  "RUNNING",
  "WAITING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "BLOCKED",
];

export const CORE_TASK_STATUS_LABEL: Record<string, string> = {
  PENDING: "已入队",
  RUNNING: "执行中",
  WAITING: "等待中",
  SUCCEEDED: "已成功",
  FAILED: "已失败",
  CANCELLED: "已取消",
  BLOCKED: "已停止（可续接）",
};

export function isCoreTaskStatus(value: unknown): value is string {
  return typeof value === "string" && CORE_TASK_STATUSES.indexOf(value) >= 0;
}

export function coreTaskStatusLabel(status: unknown): string {
  return isCoreTaskStatus(status) ? CORE_TASK_STATUS_LABEL[status] : status ? String(status) : "状态未知";
}

/** core 进行态：只有 PENDING / RUNNING / WAITING 需要按 task/get 轮询刷新。 */
export function isActiveCoreStatus(status: unknown): boolean {
  return status === "PENDING" || status === "RUNNING" || status === "WAITING";
}

export function coreTaskStatusTone(status: unknown): TaskTone {
  if (status === "SUCCEEDED") return "success";
  if (status === "FAILED" || status === "CANCELLED") return "danger";
  if (status === "BLOCKED" || status === "WAITING") return "warning";
  return "neutral";
}

/* ── 动作集合：只登记 core 白名单里对“已存在任务”真正有语义的命令 ───── */
export type CoreTaskActionKey = "append-step" | "resume" | "cancel" | "acknowledge-unknown-effect";
/** 风险类别：read（只读）/ write（写或启动执行）/ destructive（不可逆终结）。 */
export type CoreTaskActionRisk = "read" | "write" | "destructive";

export type CoreTaskActionMeta = {
  key: CoreTaskActionKey;
  command: string;
  label: string;
  description: string;
  risk: CoreTaskActionRisk;
  /** 写类动作必须走既有 Dialog 二次确认；确认前 0 命令。 */
  requiresConfirm: boolean;
  /** 需要构造的载荷键（taskId 恒在）。 */
  inputs: readonly string[];
};

export const CORE_TASK_ACTIONS: readonly CoreTaskActionMeta[] = [
  {
    key: "append-step",
    command: "task/appendStep",
    label: "追加下一步",
    description: "同一任务追加一个下一步目标（bounded 新步骤 + 一次新 run）；不重放旧工具请求，只用任务剩余额度。",
    risk: "write",
    requiresConfirm: true,
    inputs: ["taskId", "goal", "expectedRevision"],
  },
  {
    key: "resume",
    command: "task/resume",
    label: "续接预算",
    description: "仅对“预算耗尽停止”的任务补一次额度并继续；是否可续接由后端 task/get 判定。",
    risk: "write",
    requiresConfirm: true,
    inputs: ["taskId", "expectedRevision"],
  },
  {
    key: "cancel",
    command: "task/cancel",
    label: "取消任务",
    description: "请求停止任务并收尾在途 run；已完成步骤与产物保留，不回滚。",
    risk: "destructive",
    requiresConfirm: true,
    inputs: ["taskId"],
  },
  {
    key: "acknowledge-unknown-effect",
    command: "task/acknowledgeUnknownEffect",
    label: "确认已核查",
    description: "对结果未知的副作用只记录一条人工确认事件；不重试、不重放、不改任务状态。",
    risk: "write",
    requiresConfirm: true,
    inputs: ["taskId", "callId"],
  },
];

export function coreTaskActionMeta(key: unknown): CoreTaskActionMeta | null {
  const found = CORE_TASK_ACTIONS.find((a) => a.key === key);
  return found || null;
}

export const CORE_TASK_ACTION_RISK_LABEL: Record<CoreTaskActionRisk, string> = {
  read: "只读",
  write: "写操作",
  destructive: "终结操作",
};

export function coreTaskActionRiskText(key: unknown): string {
  const meta = coreTaskActionMeta(key);
  return meta ? CORE_TASK_ACTION_RISK_LABEL[meta.risk] : "";
}

/* ── 载荷：只允许业务参数 + requestId，绝不出现身份字段 ─────────────── */
export const CORE_TASK_ACTION_PAYLOAD_KEYS: readonly string[] = [
  "taskId",
  "goal",
  "expectedRevision",
  "callId",
  "requestId",
];

export const CORE_TASK_ACTION_INPUT_LABEL: Record<string, string> = {
  goal: "下一步目标",
  callId: "副作用记录",
};

export function coreActionMissingInputs(key: unknown, values: Record<string, unknown> = {}): string[] {
  const meta = coreTaskActionMeta(key);
  const missing: string[] = [];
  if (!String(values.taskId == null ? "" : values.taskId).trim()) missing.push("taskId");
  if (!meta) return missing;
  if (meta.inputs.indexOf("goal") >= 0 && !String(values.goal == null ? "" : values.goal).trim()) missing.push("goal");
  if (meta.inputs.indexOf("callId") >= 0 && !String(values.callId == null ? "" : values.callId).trim()) missing.push("callId");
  return missing;
}

/**
 * 载荷构造：只输出白名单键。空可选项不写入（后端按“未提供”处理），
 * 绝不把 renderer 自报的 userId / role / appId / sessionRef 拼进来。
 */
export function coreActionPayload(key: unknown, values: Record<string, unknown> = {}): Record<string, unknown> {
  const meta = coreTaskActionMeta(key);
  const out: Record<string, unknown> = {};
  if (!meta) return out;
  const taskId = String(values.taskId == null ? "" : values.taskId).trim();
  if (!taskId) return out;
  out.taskId = taskId;
  if (meta.inputs.indexOf("goal") >= 0) {
    const goal = String(values.goal == null ? "" : values.goal).trim();
    if (goal) out.goal = goal;
  }
  if (meta.inputs.indexOf("expectedRevision") >= 0) {
    const rev = values.expectedRevision;
    if (rev != null && Number.isFinite(Number(rev))) out.expectedRevision = Number(rev);
  }
  if (meta.inputs.indexOf("callId") >= 0) {
    const callId = String(values.callId == null ? "" : values.callId).trim();
    if (callId) out.callId = callId;
  }
  if (values.requestId != null && String(values.requestId)) out.requestId = String(values.requestId);
  return out;
}

export const CORE_TASK_ACTION_CONFIRM_TITLE: Record<CoreTaskActionKey, string> = {
  "append-step": "确认追加下一步",
  resume: "确认续接预算",
  cancel: "确认取消任务",
  "acknowledge-unknown-effect": "确认已核查结果未知的副作用",
};

export function coreActionConfirmTitle(key: unknown): string {
  const meta = coreTaskActionMeta(key);
  return meta ? CORE_TASK_ACTION_CONFIRM_TITLE[meta.key] : "确认";
}

/** 确认框的副作用说明：只说这次动作真的会做什么，不夸大也不隐瞒。 */
export function coreActionConfirmSummary(key: unknown, payload: Record<string, unknown> = {}): string {
  const meta = coreTaskActionMeta(key);
  if (!meta) return "";
  const taskText = payload.taskId ? "任务 " + String(payload.taskId) : "该任务";
  if (meta.key === "append-step") {
    return "写操作：" + taskText + " 会新增一个执行步骤并开始一次新 run（只用剩余额度，不重放旧工具请求）。下一步目标：" + String(payload.goal || "（未填写）") + "。";
  }
  if (meta.key === "resume") {
    return "写操作：为 " + taskText + " 追加一次预算并新建步骤，随后真实调用模型；是否可续接由后端判定。";
  }
  if (meta.key === "cancel") {
    return "终结操作：请求停止 " + taskText + " 并收尾在途 run；已完成步骤与产物保留，不回滚。";
  }
  return "写操作：为 " + taskText + " 记录一条人工确认（callId " + String(payload.callId || "（缺失）") + "）；不会重试、不会重放副作用，也不会改写任务状态。";
}

/* ── task/get 投影规范化（以后端为准，不做本地拼接）────────────────────── */
export type CoreTaskRecord = {
  taskId: string;
  goal: string;
  status: string;
  revision: number | null;
  cancelRequested: boolean;
  createdAt: number | null;
  updatedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  modelConfigId: string | null;
  modelConfigVersion: number | null;
};

export type CoreTaskStep = {
  stepId: string | null;
  sequence: number | null;
  kind: string | null;
  status: string | null;
  input: unknown;
  startedAt: number | null;
  completedAt: number | null;
};

export type CoreTaskArtifact = {
  artifactId: string | null;
  stepId: string | null;
  type: string | null;
  content: unknown;
  checksum: string | null;
  createdAt: number | null;
};

export type CoreRecoveryCall = {
  callId: string;
  toolId: string | null;
  status: string | null;
  errorCode: string | null;
  stepId: string | null;
  runId: string | null;
  recoveryResult: string | null;
  recoveryReason: string | null;
  acknowledged: boolean;
  acknowledgedAt: number | null;
};

export type CoreTaskRecovery = { applicable: boolean; reason: string | null; calls: CoreRecoveryCall[] };

export type CoreTaskDetail = {
  task: CoreTaskRecord;
  steps: CoreTaskStep[];
  artifacts: CoreTaskArtifact[];
  verifications: Record<string, unknown>[];
  appendable: boolean;
  appendReason: string | null;
  resumable: boolean;
  resumeReason: string | null;
  stopReason: string | null;
  canCancel: boolean;
  recovery: CoreTaskRecovery;
};

const numOrNull = (v: unknown): number | null => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));

/** task-service.cjs:307-336 的 safeTask / safeStep + bootstrap.cjs:171-182 的 task/get 信封。 */
export function normalizeCoreTaskDetail(result: unknown): CoreTaskDetail | null {
  const unwrapped = isObj(result) && isObj(result.value) ? (result.value as Record<string, unknown>) : result;
  const root = isObj(unwrapped) ? (unwrapped as Record<string, unknown>) : null;
  if (!root || root.ok === false) return null;
  const rawTask = isObj(root.task) ? (root.task as Record<string, unknown>) : null;
  if (!rawTask) return null;
  const taskId = String(rawTask.taskId == null ? "" : rawTask.taskId);
  if (!taskId) return null;
  const status = String(rawTask.status == null ? "" : rawTask.status);
  const task: CoreTaskRecord = {
    taskId,
    goal: String(rawTask.goal == null ? "" : rawTask.goal),
    status,
    revision: numOrNull(rawTask.revision),
    cancelRequested: rawTask.cancelRequested === true,
    createdAt: numOrNull(rawTask.createdAt),
    updatedAt: numOrNull(rawTask.updatedAt),
    startedAt: numOrNull(rawTask.startedAt),
    completedAt: numOrNull(rawTask.completedAt),
    modelConfigId: strOrNull(rawTask.modelConfigId),
    modelConfigVersion: numOrNull(rawTask.modelConfigVersion),
  };
  const steps: CoreTaskStep[] = [];
  for (const s of Array.isArray(root.steps) ? root.steps : []) {
    if (!isObj(s)) continue;
    steps.push({
      stepId: strOrNull((s as Record<string, unknown>).stepId),
      sequence: numOrNull((s as Record<string, unknown>).sequence),
      kind: strOrNull((s as Record<string, unknown>).kind),
      status: strOrNull((s as Record<string, unknown>).status),
      input: (s as Record<string, unknown>).input,
      startedAt: numOrNull((s as Record<string, unknown>).startedAt),
      completedAt: numOrNull((s as Record<string, unknown>).completedAt),
    });
  }
  const artifacts: CoreTaskArtifact[] = [];
  for (const a of Array.isArray(root.artifacts) ? root.artifacts : []) {
    if (!isObj(a)) continue;
    artifacts.push({
      artifactId: strOrNull((a as Record<string, unknown>).artifactId),
      stepId: strOrNull((a as Record<string, unknown>).stepId),
      type: strOrNull((a as Record<string, unknown>).type),
      content: (a as Record<string, unknown>).content,
      checksum: strOrNull((a as Record<string, unknown>).checksum),
      createdAt: numOrNull((a as Record<string, unknown>).createdAt),
    });
  }
  const verifications = (Array.isArray(root.verifications) ? root.verifications : []).filter(isObj) as Record<string, unknown>[];
  const recoveryRoot = isObj(root.recovery) ? (root.recovery as Record<string, unknown>) : null;
  const calls: CoreRecoveryCall[] = [];
  for (const c of recoveryRoot && Array.isArray(recoveryRoot.calls) ? (recoveryRoot.calls as unknown[]) : []) {
    if (!isObj(c)) continue;
    const callId = String((c as Record<string, unknown>).callId == null ? "" : (c as Record<string, unknown>).callId);
    if (!callId) continue;
    calls.push({
      callId,
      toolId: strOrNull((c as Record<string, unknown>).toolId),
      status: strOrNull((c as Record<string, unknown>).status),
      errorCode: strOrNull((c as Record<string, unknown>).errorCode),
      stepId: strOrNull((c as Record<string, unknown>).stepId),
      runId: strOrNull((c as Record<string, unknown>).runId),
      recoveryResult: strOrNull((c as Record<string, unknown>).recoveryResult),
      recoveryReason: strOrNull((c as Record<string, unknown>).recoveryReason),
      acknowledged: (c as Record<string, unknown>).acknowledged === true,
      acknowledgedAt: numOrNull((c as Record<string, unknown>).acknowledgedAt),
    });
  }
  const canCancel = status !== "SUCCEEDED" && status !== "FAILED" && status !== "CANCELLED" && !task.cancelRequested;
  return {
    task,
    steps,
    artifacts,
    verifications,
    appendable: root.appendable === true,
    appendReason: strOrNull(root.appendReason),
    resumable: root.resumable === true,
    resumeReason: strOrNull(root.resumeReason),
    stopReason: strOrNull(root.stopReason),
    canCancel,
    recovery: {
      applicable: recoveryRoot ? recoveryRoot.applicable === true : false,
      reason: recoveryRoot ? strOrNull(recoveryRoot.reason) : null,
      calls,
    },
  };
}

/** 详情里下一条尚未人工确认的结果未知副作用。 */
export function nextUnacknowledgedRecoveryCall(detail: CoreTaskDetail | null): CoreRecoveryCall | null {
  if (!detail || !detail.recovery.applicable) return null;
  return detail.recovery.calls.find((c) => !c.acknowledged) || null;
}

/* ── 可用性判定：依赖缺失 / 状态不允许 / 输入缺失 → 禁用 + 可见原因 ──── */
export type CoreActionContext = {
  hasBridge: boolean;
  detail: CoreTaskDetail | null;
  goal?: string;
  callId?: string;
};

export function coreActionDisabledReason(key: unknown, ctx: CoreActionContext): string | null {
  const meta = coreTaskActionMeta(key);
  if (!meta) return "未登记的动作";
  if (!ctx.hasBridge) return "当前环境没有 core 任务桥（window.openarc.task），不会发送任何命令";
  if (!ctx.detail) return "任务详情尚未就绪，先刷新 task/get 再操作";
  const d = ctx.detail;
  if (meta.key === "append-step") {
    if (!d.appendable) return "追加不可用：" + coreTaskReasonText(d.appendReason || "APPEND_NOT_SUCCEEDED");
    if (!String(ctx.goal || "").trim()) return "请先填写要追加的下一步目标";
    return null;
  }
  if (meta.key === "resume") {
    if (!d.resumable) return "续接不可用：" + coreTaskReasonText(d.resumeReason || d.stopReason || "RESUME_NOT_BLOCKED");
    return null;
  }
  if (meta.key === "cancel") {
    if (d.task.status === "SUCCEEDED" || d.task.status === "FAILED" || d.task.status === "CANCELLED") {
      return "已完成 / 已失败 / 已取消的任务不能再取消";
    }
    if (d.task.cancelRequested) return "取消请求已提交，等待任务收尾";
    return null;
  }
  // acknowledge-unknown-effect：只对真实的 UNKNOWN_EFFECT call 开放。
  if (!d.recovery.applicable) return "当前任务没有需要人工核查的结果未知副作用";
  const callId = String(ctx.callId || "");
  if (!callId) return "没有待确认的副作用记录";
  const call = d.recovery.calls.find((c) => c.callId === callId);
  if (!call) return "该副作用记录不属于当前任务";
  if (call.acknowledged) return "该副作用已经确认过（重复确认是幂等的）";
  return null;
}

/* ── core 错误码 / 拒绝原因 → 人话 ────────────────────────────────────── */
/** task-domain.cjs:120-173 的 ERROR 全量；逐条登记，未登记的才落兜底。 */
export const CORE_TASK_ERROR_TEXT: Record<string, string> = {
  TASK_NOT_FOUND: "任务不存在，或不属于当前账号 / 应用",
  TASK_FORBIDDEN: "当前账号或该应用没有权限操作这个任务",
  TASK_INVALID_STATE: "任务状态不允许这个操作，请刷新后按当前状态重试",
  TASK_REVISION_CONFLICT: "任务已被其他操作改动（revision 冲突），已按后端最新状态刷新，请重试",
  TASK_CANCELLED: "任务已请求取消，不能再执行这个动作",
  MODEL_CONFIG_CHANGED: "任务绑定的模型配置版本已变化，为避免串用旧配置被拒绝；请刷新后处理",
  RECOVERY_REQUIRED: "任务在上次运行中断，已标记为需要恢复核查",
  BUDGET_EXHAUSTED: "本任务的执行预算已用尽；需要显式续接后才能继续",
  INVALID_INPUT: "输入不完整或不符合要求",
  INTERNAL_ERROR: "core 任务运行时内部错误，操作未完成",
  HARNESS_PROCESS_EXITED: "推理运行时进程已退出，任务未完成",
  HARNESS_START_TIMEOUT: "推理运行时启动超时",
  HARNESS_TURN_TIMEOUT: "推理运行时单轮执行超时",
  HARNESS_CANCELLED: "推理运行时已被取消",
  TOOL_EXECUTION_NOT_AVAILABLE: "当前环境没有可用的工具执行通道",
  PERMISSION_NOT_AVAILABLE: "缺少执行所需权限",
  AUTHORIZATION_REVOKED: "授权已被撤销，任务不能继续执行",
  STALE_CAPABILITY: "能力凭证已过期，未执行任何动作",
  ARTIFACT_PERSIST_FAILED: "产物落库失败，任务没有记为成功",
  VERIFICATION_FAILED: "产物未通过校验，任务没有记为成功",
  MCP_NOT_AVAILABLE: "MCP 通道不可用",
  TOOL_NOT_FOUND: "工具不存在或未登记",
  TOOL_DISABLED: "该工具当前被关闭",
  TOOL_VERSION_UNSUPPORTED: "工具版本不受支持",
  TOOL_ARGUMENT_INVALID: "工具参数不合法",
  TOOL_ARGUMENT_FORBIDDEN_FIELD: "工具参数包含被禁止的字段",
  TOOL_FORBIDDEN: "当前账号或应用被禁止使用该工具",
  TOOL_APP_NOT_GRANTED: "该应用没有被授予此工具",
  TOOL_AGENT_USE_NOT_AUTHORIZED: "Agent 使用该工具未获授权",
  TOOL_APPROVAL_REQUIRED: "该工具需要逐次审批，尚未批准",
  TOOL_PROPOSAL_STALE: "工具提案已过期，未执行",
  TOOL_RESOURCE_REF_REQUIRED: "该工具需要明确的资源引用",
  TASK_TERMINAL: "任务已到终态，不能再执行这个动作",
  TOOL_EXECUTION_STALE: "工具执行已过期，未执行",
  TOOL_PLAN_STALE: "工具计划已过期，未执行",
  TOOL_TIMEOUT: "工具调用超时",
  TOOL_EXECUTION_FAILED: "工具执行失败",
  TOOL_OUTPUT_INVALID: "工具输出不合法，未采信",
  TOOL_VERIFICATION_FAILED: "工具报告成功但产物校验失败",
  TOOL_AUTHORIZATION_REVOKED: "工具授权已被撤销，未执行",
  TOOL_NOT_EXECUTABLE: "该工具不可执行",
  RESOURCE_NOT_AVAILABLE: "所需资源不可用",
  WRITE_EXECUTION_DISABLED: "写执行通道当前被关闭",
  APPEND_NOT_ALLOWED: "当前状态不允许追加下一步",
  /* 渲染层自己的事实位（前缀刻意与后端码区分） */
  NO_CORE_BRIDGE: "桌面桥未接入 core 任务域（当前环境没有 window.openarc.task）",
  TASK_COMMAND_NOT_ALLOWED: "命令不在 task:command 白名单内，界面不会发送未登记的命令",
  RESPONSE_INCOMPLETE: "主进程返回的记录不完整，界面不猜内容",
  LOCAL_INPUT_REQUIRED: "缺少必填内容（界面上先行拦截，没有发给后端）",
  RESUME_NOT_ELIGIBLE: "按后端判定，该任务当前不可续接",
  EXPLICIT_RESUME_DEFERRED: "非预算停止的恢复尚未开放",
  SIDE_EFFECT_APPROVAL_UNRESOLVED: "存在尚未处理的副作用审批，任务不能继续",
};

/** 未登记的码也给出可读兜底，并保留原始码显示（不塌缩成“未知错误”）。 */
export function coreTaskErrorText(code: unknown): string {
  const key = code == null ? "" : String(code);
  return CORE_TASK_ERROR_TEXT[key] || "core 任务操作失败";
}

/** APPEND_REASON / RESUME_REASON（task-domain.cjs:255-282）：为什么现在不能追加 / 续接。 */
export const CORE_TASK_REASON_TEXT: Record<string, string> = {
  APPEND_IN_FLIGHT: "已有步骤或 run 正在进行，等它结束后再追加",
  APPEND_EFFECT_STATE_UNAVAILABLE: "暂时读不到副作用账本，为安全起见不追加",
  APPEND_UNKNOWN_EFFECT: "存在结果未知的副作用，先核查再追加",
  APPEND_SIDE_EFFECT_PENDING: "有未决副作用（等待审批 / 执行中），先处理再追加",
  APPEND_ACTIVE_LEASE: "存在有效执行租约，先等它释放",
  APPEND_NOT_SUCCEEDED: "只有已成功完成的任务才能追加下一步",
  APPEND_NO_ARTIFACT: "任务还没有可参考的产物，不追加",
  RESUME_NOT_BLOCKED: "任务不在已停止状态，无需续接",
  RESUME_CANCELLED: "任务已请求取消，不能续接",
  RESUME_IN_FLIGHT: "已有步骤或 run 正在进行，等它结束后再续接",
  RESUME_NO_HARNESS_RUN: "没有可续接的 run 记录",
  RESUME_NOT_BUDGET_STOP: "该任务不是因预算耗尽停止，当前不支持续接",
  RESUME_UNKNOWN_BUDGET_KIND: "无法判定该补哪一类预算，拒绝续接",
  RESUME_UNKNOWN_EFFECT_PRESENT: "存在结果未知的副作用，先核查再续接",
  RESUME_SIDE_EFFECT_PENDING: "有未决副作用，先处理再续接",
  RESUME_ACTIVE_LEASE: "存在有效执行租约，先等它释放",
  RESUME_NO_SAFE_CONTINUATION: "没有可安全续接的已完成产物",
  RESUME_LIMIT_REACHED: "已达续接次数上限",
  RESUME_BUDGET_REMAINING: "该预算仍有余额，不是容量停止，不能循环追加",
  RESUME_EFFECT_STATE_UNAVAILABLE: "暂时读不到副作用账本，为安全起见不续接",
};

export function coreTaskReasonText(reason: unknown): string {
  const key = reason == null ? "" : String(reason);
  return CORE_TASK_REASON_TEXT[key] || key || "没有给出原因";
}

/** 失败文案优先级：拒绝原因 > 错误码 > 兜底，且始终保留原始码。 */
export function coreTaskFailureText(code: unknown): string {
  const key = code == null ? "" : String(code);
  if (CORE_TASK_REASON_TEXT[key]) return CORE_TASK_REASON_TEXT[key];
  return coreTaskErrorText(key);
}

/** 详情里显式标注命令域；同样把 "/" 与 "*" 分开拼接，避免被朴素 stripComments 吞掉。 */
export const CORE_TASK_COMMAND_DOMAIN_TEXT = "命令域 task/" + "*（与 DX 的 agent/" + "* 分开，不能混用）";

/** core 列表行的能力提示（同样不出现连续的 "/" + "*"）。 */
export const CORE_TASK_ROW_HINT = "选中后按其真实能力提供动作（task/" + "* 命令），与 DX 任务的 agent/" + "* 不混用。";

/** 按 source 说明“这里能做什么”，替代过去“core 只读”的一句笼统标注。 */
export function unifiedCapabilityNote(source: unknown): string {
  const key = source == null ? "" : String(source);
  /* 注意："task/" 与 "*" 必须分开拼接：本文件的消费测试用朴素的 stripComments 去掉注释，
     字符串里出现连续的 "/" + "*" 会被误当成块注释起点，把后续代码一起吞掉。 */
  if (key === "core") {
    return "core 任务（既有任务表）：可选中查看；动作走 task/" + "* 命令 —— 追加下一步 task/appendStep、续接预算 task/resume、取消 task/cancel、确认结果未知副作用 task/acknowledgeUnknownEffect。与 DX 的 agent/" + "* 不是同一套命令，不能混用。";
  }
  if (key === "dx") {
    return "DX 任务（新任务表）：可选中查看；动作走 agent/" + "* 命令 —— 回答 / 暂停 / 恢复 / 追加要求 / 取消。与 core 的 task/" + "* 不是同一套命令，不能混用。";
  }
  return "来源未登记：只显示读模型信息，不提供任何动作。";
}

