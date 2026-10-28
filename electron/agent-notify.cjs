"use strict";
/**
 * 全局 AI 后台任务通知：OpenArc 窗口不在前台时，任务跑完 / 停下 / 需要你确认，就发一条系统通知；
 * 点通知回到 OpenArc，并打开那个对话。窗口在前台时不发（界面里另有应用内通知）。
 *
 * 只显示用户自己写的任务目标和工具名，不显示工具参数、正文或任何密钥。
 */

const STATUS_TITLE = Object.freeze({
  SUCCEEDED: "AI 任务已完成",
  BLOCKED: "AI 任务停下了，需要你看一下",
  WAITING: "AI 任务在等你确认",
  FAILED: "AI 任务没有完成",
  CANCELLED: null, // 用户自己取消的，不打扰
});

const clip = (s, n) => { const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

function titleFor({ ok, status }) {
  if (status && Object.prototype.hasOwnProperty.call(STATUS_TITLE, status)) return STATUS_TITLE[status];
  return ok ? STATUS_TITLE.SUCCEEDED : STATUS_TITLE.FAILED;
}

/**
 * @param {object} o
 * @param {Function} o.Notification  Electron Notification 构造器（测试可注入假实现）
 * @param {() => object|null} o.getWindow  当前主窗口
 * @param {(event: object) => void} o.sendTaskEvent  往渲染进程推 task:event
 */
function createAgentNotifier({ Notification = null, getWindow = () => null, sendTaskEvent = () => {} } = {}) {
  const supported = () => {
    try { return !!Notification && (typeof Notification.isSupported !== "function" || Notification.isSupported()); } catch { return false; }
  };
  const inForeground = () => {
    const win = getWindow();
    if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return false;
    try { return win.isFocused() && win.isVisible() && !win.isMinimized(); } catch { return false; }
  };
  function bringBack(taskId) {
    const win = getWindow();
    if (win && !(typeof win.isDestroyed === "function" && win.isDestroyed())) {
      try { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } catch { /* ignore */ }
    }
    if (taskId) sendTaskEvent({ type: "task/focus", taskId: String(taskId) });
  }
  function show({ title, body, taskId = null }) {
    if (!title || !supported() || inForeground()) return false;
    try {
      const n = new Notification({ title, body: body || "", silent: false });
      if (typeof n.on === "function") n.on("click", () => bringBack(taskId));
      n.show();
      return true;
    } catch { return false; }
  }
  return {
    /** 一轮跑完。 */
    taskFinished({ taskId, ok, status, goal }) {
      return show({ title: titleFor({ ok, status }), body: clip(goal, 80), taskId });
    },
    /** 某个操作在等批准（写文件 / 跑命令 / MCP 等）。 */
    approvalNeeded(request) {
      const tool = clip(request && (request.toolDisplayName || request.toolId), 60);
      const target = clip(request && request.targetDisplayName, 60);
      return show({ title: "AI 需要你确认一个操作", body: tool + (target ? " · " + target : ""), taskId: null });
    },
  };
}

module.exports = { createAgentNotifier, titleFor };
