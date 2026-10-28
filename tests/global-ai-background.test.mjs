/** 全局 AI · 后台任务通知：窗口不在前台时，任务跑完 / 停下 / 等确认发系统通知；点通知回到对应对话。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createAgentNotifier, titleFor } = require("../electron/agent-notify.cjs");
const { TASK_STATUS } = require("../electron/task-domain.cjs");

test("通知标题覆盖真实的任务状态值", () => {
  for (const st of ["SUCCEEDED", "BLOCKED", "WAITING", "FAILED", "CANCELLED"]) assert.equal(TASK_STATUS[st], st);
});

function fakeEnv({ focused = false, minimized = false } = {}) {
  const shown = []; const sent = []; const calls = [];
  class Notification {
    static isSupported() { return true; }
    constructor(opts) { this.opts = opts; this.handlers = {}; }
    on(ev, fn) { this.handlers[ev] = fn; }
    show() { shown.push(this); }
  }
  const win = {
    isDestroyed: () => false, isFocused: () => focused, isVisible: () => true, isMinimized: () => minimized,
    restore: () => calls.push("restore"), show: () => calls.push("show"), focus: () => calls.push("focus"),
  };
  const n = createAgentNotifier({ Notification, getWindow: () => win, sendTaskEvent: (e) => sent.push(e) });
  return { n, shown, sent, calls };
}

test("窗口在前台时不发系统通知", () => {
  const { n, shown } = fakeEnv({ focused: true });
  assert.equal(n.taskFinished({ taskId: "t1", ok: true, status: "SUCCEEDED", goal: "整理资料" }), false);
  assert.equal(shown.length, 0);
});

test("窗口在后台：完成发通知，标题按状态，正文是任务目标", () => {
  const { n, shown } = fakeEnv({ focused: false });
  assert.equal(n.taskFinished({ taskId: "t1", ok: true, status: "SUCCEEDED", goal: "整理   这周的\n资料" }), true);
  assert.equal(shown[0].opts.title, "AI 任务已完成");
  assert.equal(shown[0].opts.body, "整理 这周的 资料");
  n.taskFinished({ taskId: "t2", ok: false, status: "BLOCKED", goal: "x" });
  n.taskFinished({ taskId: "t3", ok: false, status: "FAILED", goal: "x" });
  assert.deepEqual(shown.slice(1).map((s) => s.opts.title), ["AI 任务停下了，需要你看一下", "AI 任务没有完成"]);
  assert.equal(titleFor({ ok: false }), "AI 任务没有完成");
  assert.equal(titleFor({ ok: true }), "AI 任务已完成");
  assert.equal(titleFor({ ok: false, status: "WAITING" }), "AI 任务在等你确认");
});

test("用户自己取消的任务不发通知；最小化也算后台", () => {
  const { n, shown } = fakeEnv({ focused: true, minimized: true });
  assert.equal(n.taskFinished({ taskId: "t1", ok: false, status: "CANCELLED", goal: "x" }), false);
  assert.equal(n.taskFinished({ taskId: "t1", ok: true, status: "SUCCEEDED", goal: "x" }), true);
  assert.equal(shown.length, 1);
});

test("点通知：恢复并聚焦窗口，再让界面打开那段对话", () => {
  const { n, shown, sent, calls } = fakeEnv({ focused: false, minimized: true });
  n.taskFinished({ taskId: "task-42", ok: true, status: "SUCCEEDED", goal: "x" });
  shown[0].handlers.click();
  assert.deepEqual(calls, ["restore", "show", "focus"]);
  assert.deepEqual(sent, [{ type: "task/focus", taskId: "task-42" }]);
});

test("等批准的通知只显示工具名和目标，不带参数", () => {
  const { n, shown, sent } = fakeEnv({ focused: false });
  n.approvalNeeded({ toolId: "workspace.write", toolDisplayName: "写入工作区文件", targetDisplayName: "notes.md", args: { content: "SECRET_BODY" } });
  assert.equal(shown[0].opts.title, "AI 需要你确认一个操作");
  assert.equal(shown[0].opts.body, "写入工作区文件 · notes.md");
  assert.doesNotMatch(JSON.stringify(shown[0].opts), /SECRET_BODY/);
  shown[0].handlers.click();
  assert.deepEqual(sent, []);
});

test("系统不支持通知或构造出错时安静地跳过", () => {
  const n1 = createAgentNotifier({ Notification: null, getWindow: () => null });
  assert.equal(n1.taskFinished({ taskId: "t", ok: true, status: "SUCCEEDED", goal: "x" }), false);
  class Boom { static isSupported() { return true; } constructor() { throw new Error("boom"); } }
  const n2 = createAgentNotifier({ Notification: Boom, getWindow: () => null });
  assert.equal(n2.taskFinished({ taskId: "t", ok: true, status: "SUCCEEDED", goal: "x" }), false);
});
