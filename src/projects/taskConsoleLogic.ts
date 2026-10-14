
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

/**
 * 页面状态判定的**优先级**（顺序即规则，与 skillCenterLogic.skillListState 同一口径）：
 *   1 依赖缺失 —— 环境事实，先于一切数据态
 *   2 错误且无数据
 *   3 首屏加载且无数据
 *   4 空且无数据
 *   5 就绪
 * 初值为 loading，避免先画一帧假空态。
 */
export function taskListState(v: {
  loading: boolean;
  errorCode: string | null;
  dependencyUnavailable: boolean;
  count: number;
}): TaskPageStateKind | "ready" {
  if (v.dependencyUnavailable) return "unavailable";
  if (v.errorCode && v.count === 0) return "error";
  if (v.loading && v.count === 0) return "loading";
  if (v.count === 0) return "empty";
  return "ready";
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

