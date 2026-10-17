"use strict";
/**
 * task-21 · 窗口标签组 IPC 批处理（复用既有 windows:sync 通道，不新增 preload 顶层键/成员）。
 *
 * 渲染层持有 Window Manager 的唯一状态（与 React/Vue 同一条线）；本模块只做**受控求值**：
 *   windows:sync { windowState: <persisted>, commands: [window/tab-group-* ...], areas? }
 *   → 主进程用同一份 window-manager.reduce 计算，返回新 persisted 状态 + accepted/rejected。
 *
 * 安全/契约：
 *   · 输入状态必须是 persisted 形态（windows 数组）；坏状态结构化拒绝，不抛异常。
 *   · 命令表只接受 REDUCERS 里已登记的 type；未知命令进 rejected，绝不静默执行。
 *   · 单次上限 64 条，防止一次 IPC 无限计算。
 *   · 返回值只含窗口域字段（appId / bounds / meta / tabGroupId），不含任何路径 / 凭据。
 */
const domain = require("./window-domain.cjs");
const manager = require("./window-manager.cjs");

const MAX_WINDOW_COMMANDS = 64;

function applyWindowCommandBatch({ state = null, commands = [], areas = null } = {}) {
  if (!domain.isPersistable(state)) return { ok: false, error: "WINDOW_STATE_INVALID", detail: "windowState 必须是含 windows 数组的持久化状态" };
  if (!Array.isArray(commands)) return { ok: false, error: "WINDOW_COMMANDS_INVALID", detail: "commands 必须是数组" };
  if (commands.length > MAX_WINDOW_COMMANDS) return { ok: false, error: "WINDOW_COMMANDS_TOO_MANY", detail: "单次最多 " + MAX_WINDOW_COMMANDS + " 条命令" };
  let base;
  try {
    base = manager.deserialize(state, Array.isArray(areas) ? areas : null);
  } catch (error) {
    return { ok: false, error: "WINDOW_STATE_INVALID", detail: String((error && error.message) || error).slice(0, 200) };
  }
  let next = base;
  const accepted = [];
  const rejected = [];
  for (const command of commands) {
    if (!command || typeof command !== "object" || typeof command.type !== "string" || !manager.REDUCERS[command.type]) {
      rejected.push({ type: command && typeof command === "object" ? command.type : null, reason: "unknown-command" });
      continue;
    }
    const before = next;
    next = manager.reduce(next, command);
    accepted.push({ type: command.type, changed: next !== before });
  }
  return {
    ok: true,
    changed: next !== base,
    accepted,
    rejected,
    state: next,
    persisted: domain.toPersisted(next),
  };
}

module.exports = { applyWindowCommandBatch, MAX_WINDOW_COMMANDS };
