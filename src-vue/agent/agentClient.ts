/**
 * Vue 壳层 · Agent 桥接（task-35）。
 *
 * 只有 window.openarc.agent.command 一个出口；identity/appId 由主进程注入，渲染层不伪造。
 * 所有失败保留后端结构化 code，不用“操作失败”盖掉依赖缺失 / 权限 / 未就绪这类真实状态。
 */
export type AgentBridge = { command: (input: { command: string; payload?: Record<string, unknown> }) => Promise<any>; onEvent?: (cb: (event: any) => void) => (() => void) | void };

export function agentBridge(): AgentBridge | null {
  const bridge = (window as any).openarc?.agent;
  return bridge && typeof bridge.command === "function" ? (bridge as AgentBridge) : null;
}

export type AgentResult = { ok: boolean; value: any; error: string; message: string; detail: any };

export async function agentCommand(command: string, payload: Record<string, unknown> = {}, bridge: AgentBridge | null = agentBridge()): Promise<AgentResult> {
  if (!bridge) return { ok: false, value: null, error: "NO_BRIDGE", message: "Agent 服务只在 OpenArc 桌面应用里可用。", detail: null };
  try {
    const raw = await bridge.command({ command, payload });
    if (raw && raw.ok === true) return { ok: true, value: raw.value, error: "", message: "", detail: null };
    return {
      ok: false,
      value: null,
      error: String(raw?.error || "INTERNAL_ERROR"),
      message: String(raw?.message || ""),
      detail: raw?.detail ?? null,
    };
  } catch (error) {
    return { ok: false, value: null, error: "INTERNAL_ERROR", message: String((error as any)?.message || error || ""), detail: null };
  }
}

const AGENT_ERRORS: Record<string, string> = {
  NO_BRIDGE: "Agent 服务只在 OpenArc 桌面应用里可用。",
  AGENT_NOT_READY: "Agent 运行时还没就绪。",
  AGENT_DEPENDENCY_UNAVAILABLE: "Agent 依赖未装配（模型/工具/文件树或数据库），现在不能执行。",
  AGENT_UNAUTHENTICATED: "登录状态已失效，请重新登录。",
  AGENT_FORBIDDEN: "当前身份没有执行这个 Agent 动作的权限。",
  AGENT_NOT_FOUND: "目标项目/任务/Run 不存在，或你没有访问权限。",
  AGENT_INVALID_INPUT: "请求参数不完整或格式不对。",
  AGENT_COMMAND_NOT_ALLOWED: "后端未开放这个 Agent 命令。",
  AGENT_CONFLICT: "任务状态已变化，刷新后再试。",
  AGENT_INTERNAL: "Agent 域内部错误。",
  INTERNAL_ERROR: "请求没有完成（内部错误）。",
};

export function agentErrorText(code: string, message = ""): string {
  if (code && AGENT_ERRORS[code]) return message ? AGENT_ERRORS[code] + " " + message : AGENT_ERRORS[code];
  if (code) return message ? message + "（" + code + "）" : "请求被拒绝（" + code + "）";
  return message || "";
}

export type TaskStatus = "queued" | "planning" | "running" | "verifying" | "completed" | "waiting_user" | "waiting_children" | "paused" | "interrupted" | "failed" | "cancelled" | string;

export const TASK_STATUS_TEXT: Record<string, string> = {
  queued: "排队中",
  planning: "规划中",
  running: "执行中",
  verifying: "验收中",
  completed: "已完成",
  waiting_user: "等待你确认",
  waiting_children: "等待子任务",
  paused: "已暂停",
  interrupted: "已中断",
  failed: "失败",
  cancelled: "已取消",
};

export function taskStatusText(status: TaskStatus): string {
  return TASK_STATUS_TEXT[String(status || "")] || String(status || "未知");
}

export function isTerminalTask(status: TaskStatus): boolean {
  return ["completed", "failed", "cancelled", "interrupted"].includes(String(status || ""));
}

export function isLiveTask(status: TaskStatus): boolean {
  return !isTerminalTask(status) && status !== "paused" && status !== "waiting_user";
}

export type AssistantMode = "assistant" | "thinking" | "agent";

export const AGENT_MODES: { id: AssistantMode; label: string; hint: string; executionProfile: string }[] = [
  {
    id: "assistant",
    label: "助理",
    hint: "同步跑一轮项目 Agent：读文件、调用能力、直接答复；长任务请用思考/Agent 模式。",
    executionProfile: "",
  },
  {
    id: "thinking",
    label: "思考",
    hint: "把指令写入项目任务队列（executionProfile=thinking）。后端 worker 推进后界面按 task/get 展示真实状态。",
    executionProfile: "thinking",
  },
  {
    id: "agent",
    label: "Agent",
    hint: "把指令写入后台 Agent 队列（executionProfile=agent）。界面只展示后端真实状态，不本地模拟执行。",
    executionProfile: "agent",
  },
];

export const EVENT_LABEL: Record<string, string> = {
  "task.created": "任务已创建",
  "task.imported": "任务已导入",
  "task.planned": "计划已生成",
  "task.waiting_user": "需要你确认/回答",
  "task.answered": "已提交你的回答",
  "task.continued": "已追加要求",
  "task.paused": "任务已暂停",
  "task.resumed": "任务重新入队",
  "task.cancelled": "任务已取消",
  "task.failed": "任务失败",
  "supervisor.waiting_children": "等待子 Agent",
  "capability.started": "开始调用能力",
  "capability.completed": "能力调用完成",
  "capability.failed": "能力调用失败",
  "artifact.created": "生成产物",
};

export function eventLabel(type: string): string {
  return EVENT_LABEL[String(type || "")] || String(type || "");
}

export function formatAgentTime(value: unknown): string {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || ms <= 0) return "";
  try {
    return new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function eventTime(row: any): string {
  return formatAgentTime(row?.created_at ?? row?.createdAt ?? row?.at ?? row?.timestamp);
}

export function prettyDetail(value: unknown, max = 800): string {
  if (value === null || value === undefined || value === "") return "";
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > max ? text.slice(0, max) + "…" : text;
  } catch {
    return "";
  }
}
