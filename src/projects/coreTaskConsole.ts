/**
 * U1 · core 任务域窄桥（只经 preload.cjs:151-158 暴露的 window.openarc.task）。
 *
 * 为什么单独一个模块：TaskConsole.tsx 的既有边界断言（tests/dxos-task-console.test.mjs
 * 「界面只经 window.openarc.agent 取数据」）明确要求它不出现 openarc.task；core 任务
 * 走的是**另一条** IPC（task:command），把它收敛在这一个薄桥里，主界面只调用
 * sendCoreTaskCommand(...)，不直接碰 window / ipc。
 *
 * 边界：
 *   · 只经 window.openarc.task.command，只发 CORE_TASK_COMMANDS（后端 TASK_COMMANDS 全量）；
 *   · 不 fetch、不直连端口、不读凭据、不写存储；
 *   · userId / role / sessionRef / appId 一律不发送，由主进程从可信会话注入。
 */
import { CORE_TASK_COMMANDS, isAllowedCoreTaskCommand } from "./taskConsoleLogic";

export type CoreTaskResult = Record<string, unknown> & { ok?: boolean };

export type CoreTaskBridge = {
  command: (cmd: Record<string, unknown>) => Promise<CoreTaskResult>;
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 只读访问：不扩大 window.openarc 的类型声明，也不新增暴露面。 */
export function getCoreTaskBridge(): CoreTaskBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const root = (window as unknown as { openarc?: { task?: CoreTaskBridge } }).openarc;
  const task = root ? root.task : undefined;
  return task && typeof task.command === "function" ? task : undefined;
}

export function hasCoreTaskBridge(): boolean {
  return !!getCoreTaskBridge();
}

/**
 * 唯一出口：命令先在渲染层按白名单挡一次（与 task-bootstrap.cjs:115 同一条判据），
 * 再交给主进程；异常收敛成可见错误码，不允许“点了没反应”。
 */
export async function sendCoreTaskCommand(
  command: string,
  payload: Record<string, unknown> = {},
): Promise<CoreTaskResult> {
  if (!isAllowedCoreTaskCommand(command) || CORE_TASK_COMMANDS.indexOf(command) < 0) {
    return { ok: false, error: "TASK_COMMAND_NOT_ALLOWED", message: "命令不在 core 任务白名单内" };
  }
  const bridge = getCoreTaskBridge();
  if (!bridge) return { ok: false, error: "NO_CORE_BRIDGE" };
  try {
    const res = await bridge.command({ type: command, payload });
    return isObject(res) ? res : { ok: false, error: "RESPONSE_INCOMPLETE" };
  } catch {
    return { ok: false, error: "INTERNAL_ERROR" };
  }
}
