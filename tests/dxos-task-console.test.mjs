/**
 * UI-3 · 任务 / Agent 控制台契约单测（纯逻辑，不启动浏览器、不依赖 DOM 渲染库）。
 *
 * 测的是 src/projects/taskConsoleLogic.ts 这一份**界面真正在用**的规则：
 *   · 命令白名单逐条等于 electron/agent-domain.cjs 的 AGENT_COMMANDS
 *   · 11 态逐条等于 electron/agent-task-store.cjs 的 TASK_STATUSES，且每态都有相位
 *   · 错误码 → 文案 / PageState 映射覆盖后端全部 AGENT_* 码
 *   · 依赖缺失文案必须指出缺的是哪一个
 *   · 事件流按 sequence 合并：去重、排序、缺口检测
 *   · 窄宽 / 空态判定共用同一条阈值
 *   · 界面源码边界（不 fetch、不写 localStorage、不直连端口、不发身份字段）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  AGENT_COMMANDS,
  TASK_CONSOLE_COMMANDS,
  TASK_DEPENDENCY_LABEL,
  TASK_DEPENDENCY_TEXT,
  TASK_ERROR_TEXT,
  TASK_NARROW_MAX,
  TASK_PAGE_STATE_KINDS,
  TASK_PHASE_BY_STATUS,
  TASK_PHASES,
  TASK_STATUSES,
  agentProgressPhase,
  canAnswerTask,
  canCancelTask,
  canContinueTask,
  canPauseTask,
  canResumeTask,
  dependencyMissingText,
  dependencyOfDetail,
  filterTasks,
  isActiveTaskStatus,
  isAllowedAgentCommand,
  isEmptyTaskList,
  isNarrowLayout,
  isTaskStatus,
  mergeTaskEvents,
  missingDependencies,
  nextEventCursor,
  normalizeTaskEvent,
  progressSequenceState,
  stepProgress,
  stepStatusLabel,
  taskActionDisabledReason,
  taskErrorState,
  taskErrorText,
  taskFeedback,
  taskFeedbackForStatus,
  taskListState,
  taskPhase,
  taskEventSequenceState,
  waitingQuestionFromEvents,
} from "../src/projects/taskConsoleLogic.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);
const domain = require(path.join(ROOT, "electron", "agent-domain.cjs"));
const taskStore = require(path.join(ROOT, "electron", "agent-task-store.cjs"));

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");

/* ══════════════════════════════════════════════════════════════════════════
   1 命令白名单：界面白名单 == 后端白名单
   ══════════════════════════════════════════════════════════════════════════ */
test("命令白名单逐条等于后端 agent-domain.cjs 的 AGENT_COMMANDS（含顺序与条数）", () => {
  const backend = Object.keys(domain.AGENT_COMMANDS);
  assert.equal(backend.length, 27, "后端应有 27 条 agent 命令（26 + agent/health）");
  assert.deepEqual([...AGENT_COMMANDS], backend, "界面白名单必须与后端完全一致，不能多也不能少");
});

test("白名单命令都是 agent/ 前缀且不重复", () => {
  const set = new Set(AGENT_COMMANDS);
  assert.equal(set.size, AGENT_COMMANDS.length, "白名单不能有重复项");
  for (const c of AGENT_COMMANDS) {
    assert.match(c, /^agent\/[a-z/]+$/, c + " 必须是 agent/ 前缀命令");
    assert.equal(domain.isAgentCommand(c), true, c + " 必须是后端承认的命令");
  }
});

test("isAllowedAgentCommand 拒绝非白名单输入（含原型污染与非法类型）", () => {
  for (const bad of ["", "agent/unknown", "agent/list ", "AGENT/LIST", "__proto__", "constructor", "toString", undefined, null, 42, {}, []]) {
    assert.equal(isAllowedAgentCommand(bad), false, JSON.stringify(bad) + " 必须被拒绝");
  }
  assert.equal(isAllowedAgentCommand("agent/task/list"), true);
});

test("控制台发出的命令是后端白名单的子集，且不包含高风险调用", () => {
  for (const c of TASK_CONSOLE_COMMANDS) {
    assert.equal(AGENT_COMMANDS.indexOf(c) >= 0, true, c + " 必须属于 AGENT_COMMANDS");
    assert.equal(domain.isAgentCommand(c), true, c + " 必须被后端承认");
  }
  for (const forbidden of ["agent/tool/call", "agent/project/run", "agent/react/run", "agent/task/create", "agent/project/snapshot"]) {
    assert.equal(TASK_CONSOLE_COMMANDS.indexOf(forbidden), -1, "UI-3 这一波不发起 " + forbidden);
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   2 11 态状态机 → 界面相位
   ══════════════════════════════════════════════════════════════════════════ */
test("11 态逐条等于后端 agent-task-store.cjs 的 TASK_STATUSES（含顺序）", () => {
  assert.equal(TASK_STATUSES.length, 11, "任务状态机是 11 态");
  assert.deepEqual([...TASK_STATUSES], [...taskStore.TASK_STATUSES], "界面状态表必须与后端一致");
});

test("11 态每一态都有界面相位；相位表没有多余键", () => {
  assert.equal(Object.keys(TASK_PHASE_BY_STATUS).length, 11);
  for (const status of TASK_STATUSES) {
    const phase = taskPhase(status);
    assert.equal(TASK_PHASES.indexOf(phase) >= 0, true, status + " → " + phase + " 必须在相位表内");
    assert.equal(isTaskStatus(status), true);
  }
  for (const key of Object.keys(TASK_PHASE_BY_STATUS)) {
    assert.equal(TASK_STATUSES.indexOf(key) >= 0, true, key + " 不是 11 态之一");
  }
});

test("未知状态归入 unknown 相位，不猜语义", () => {
  assert.equal(taskPhase("nonsense"), "unknown");
  assert.equal(taskPhase(undefined), "unknown");
  assert.equal(taskPhase(null), "unknown");
  assert.equal(taskFeedbackForStatus("nonsense").label, "状态未知");
  assert.equal(taskFeedbackForStatus("nonsense").tone, "warning");
});

test("相位反馈：文字 + 图标 + 语气齐全，活动指示只出现在执行/验证态", () => {
  const tones = ["neutral", "success", "warning", "danger"];
  for (const phase of TASK_PHASES) {
    const fb = taskFeedback(phase);
    assert.equal(typeof fb.label, "string");
    assert.ok(fb.label.length > 0, phase + " 必须有可见文字");
    assert.ok(fb.glyph.length > 0, phase + " 必须有图标字形（不靠颜色单独传意）");
    assert.equal(tones.indexOf(fb.tone) >= 0, true, phase + " 的 tone 必须是设计系统登记的语气");
    assert.ok(fb.detail.length > 0, phase + " 必须解释为什么停 / 在做什么");
  }
  assert.equal(taskFeedback("running").active, true);
  assert.equal(taskFeedback("verifying").active, true);
  assert.equal(taskFeedback("queued").active, false, "排队不显示运行转圈");
  assert.equal(taskFeedback("waiting").active, false, "等待停止活动指示");
  assert.equal(taskFeedback("waiting").needsAnswer, true);
  assert.equal(taskFeedback("success").tone, "success");
  assert.equal(taskFeedback("failed").tone, "danger");
});

test("11 态 → 反馈映射：完成只对应 completed，失败只对应 failed", () => {
  assert.equal(taskFeedbackForStatus("completed").label, taskFeedback("success").label);
  assert.equal(taskFeedbackForStatus("waiting_user").needsAnswer, true);
  assert.equal(taskFeedbackForStatus("waiting_children").needsAnswer, false);
  assert.equal(taskFeedbackForStatus("failed").tone, "danger");
  assert.equal(taskFeedbackForStatus("planning").active, true, "规划中属于执行态");
});

test("进行态判定只覆盖真实进行中的状态", () => {
  const active = ["queued", "planning", "running", "verifying", "waiting_children"];
  for (const s of TASK_STATUSES) {
    assert.equal(isActiveTaskStatus(s), active.indexOf(s) >= 0, s);
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   3 动作围栏（对齐 agent-task-store.cjs 的真实校验）
   ══════════════════════════════════════════════════════════════════════════ */
test("动作围栏与 task-store 的真实名单一致", () => {
  assert.equal(canPauseTask("running"), true);
  assert.equal(canPauseTask("waiting_user"), false);
  assert.equal(canResumeTask("paused"), true);
  assert.equal(canResumeTask("interrupted"), true);
  assert.equal(canResumeTask("failed"), true);
  assert.equal(canResumeTask("running"), false);
  assert.equal(canCancelTask("completed"), false);
  assert.equal(canCancelTask("cancelled"), false);
  assert.equal(canCancelTask("failed"), true);
  assert.equal(canAnswerTask("waiting_user"), true);
  assert.equal(canAnswerTask("running"), false);
  assert.equal(canContinueTask("paused", "react"), true);
  assert.equal(canContinueTask("running", "react"), false);
  assert.equal(canContinueTask("paused", "actions"), false);
});

test("taskActionDisabledReason 给出可见原因（空回答在前端就被拦下）", () => {
  assert.equal(taskActionDisabledReason("answer", { status: "waiting_user", answer: "   " }), "回答不能为空");
  assert.equal(taskActionDisabledReason("answer", { status: "waiting_user", answer: "行" }), null);
  assert.equal(taskActionDisabledReason("answer", { status: "running", answer: "行" }), "任务当前不在等待回答");
  assert.equal(taskActionDisabledReason("pause", { status: "waiting_user" }), "只有排队 / 规划 / 执行 / 验证中的任务可以暂停");
  assert.equal(taskActionDisabledReason("resume", { status: "running" }), "只有已暂停 / 已中断 / 失败的任务可以恢复");
  assert.equal(taskActionDisabledReason("cancel", { status: "completed" }), "已完成或已取消的任务不能再取消");
  assert.equal(taskActionDisabledReason("continue", { status: "paused", mode: "actions" }), "固定步骤任务不能追加要求");
});

/* ══════════════════════════════════════════════════════════════════════════
   4 错误码 → 文案 / PageState
   ══════════════════════════════════════════════════════════════════════════ */
test("每个后端 AGENT_* 码都有非兜底的人话文案", () => {
  for (const code of domain.AGENT_ERROR_CODES) {
    const text = taskErrorText(code);
    assert.equal(text, TASK_ERROR_TEXT[code], code + " 必须逐条登记，不能落兜底");
    assert.ok(text.length > 0);
  }
});

test("未登记的错误码也给出可读兜底", () => {
  assert.equal(taskErrorText("SOMETHING_NEW"), "任务操作失败");
});

test("错误码 → PageState kind：会话失效归 unauthorized，依赖缺失归 unavailable", () => {
  assert.equal(taskErrorState("AGENT_UNAUTHENTICATED"), "unauthorized");
  assert.equal(taskErrorState("AGENT_FORBIDDEN"), "unauthorized");
  assert.equal(taskErrorState("SESSION_EXPIRED"), "unauthorized");
  assert.equal(taskErrorState("AGENT_DEPENDENCY_UNAVAILABLE"), "unavailable");
  assert.equal(taskErrorState("AGENT_NOT_READY"), "unavailable");
  assert.equal(taskErrorState("NO_BRIDGE"), "unavailable");
  assert.equal(taskErrorState("AGENT_NOT_FOUND"), "error");
  assert.equal(taskErrorState("AGENT_COMMAND_NOT_ALLOWED"), "error");
  for (const code of domain.AGENT_ERROR_CODES) {
    assert.equal(TASK_PAGE_STATE_KINDS.indexOf(taskErrorState(code)) >= 0, true, code);
  }
});

test("依赖缺失文案必须指出缺的是哪一个依赖，并说明没有产物", () => {
  const toolCatalog = dependencyMissingText({
    code: "AGENT_DEPENDENCY_UNAVAILABLE",
    dependency: "toolCatalog",
    missing: [],
  });
  assert.ok(toolCatalog.indexOf("工具目录") >= 0, "要指出缺的是工具目录：" + toolCatalog);
  assert.ok(toolCatalog.indexOf("没有产生任何产物") >= 0, "要说明没有产物：" + toolCatalog);

  const fsAdapter = dependencyMissingText({ code: "AGENT_DEPENDENCY_UNAVAILABLE", dependency: "fsAdapter" });
  assert.ok(fsAdapter.indexOf("虚拟文件树") >= 0, "fsAdapter 要显示成虚拟文件树：" + fsAdapter);

  const unknown = dependencyMissingText({ code: "AGENT_DEPENDENCY_UNAVAILABLE", dependency: "somethingNew" });
  assert.ok(unknown.indexOf("somethingNew") >= 0, "未登记的依赖名要原样显示：" + unknown);

  const fromHealth = dependencyMissingText({
    code: "AGENT_DEPENDENCY_UNAVAILABLE",
    dependency: null,
    missing: missingDependencies({ dependencies: { db: true, toolCatalog: false, fsAdapter: false } }),
  });
  assert.ok(fromHealth.indexOf("工具目录") >= 0 && fromHealth.indexOf("虚拟文件树") >= 0, fromHealth);

  assert.equal(TASK_DEPENDENCY_TEXT.indexOf("缺少"), 0);
});

test("missingDependencies 只列 false 的键；dependencyOfDetail 只接受字符串", () => {
  const missing = missingDependencies({ dependencies: { db: true, modelAdapter: false, fsAdapter: false, x: null } });
  assert.deepEqual(missing.map((m) => m.key).sort(), ["fsAdapter", "modelAdapter"]);
  assert.equal(missingDependencies(null).length, 0);
  assert.equal(missingDependencies({ dependencies: "nope" }).length, 0);
  assert.equal(dependencyOfDetail({ dependency: "providerAdapter" }), "providerAdapter");
  assert.equal(dependencyOfDetail({ dependency: 42 }), null);
  assert.equal(dependencyOfDetail(null), null);
  assert.equal(typeof TASK_DEPENDENCY_LABEL.toolCatalog, "string");
});

/* ══════════════════════════════════════════════════════════════════════════
   5 页面状态优先级 / 空态
   ══════════════════════════════════════════════════════════════════════════ */
test("列表状态优先级：依赖缺失 > 错误 > 加载 > 空 > 就绪", () => {
  const base = { loading: false, errorCode: null, dependencyUnavailable: false, count: 0 };
  assert.equal(taskListState({ ...base, dependencyUnavailable: true, errorCode: "AGENT_INTERNAL", loading: true }), "unavailable");
  assert.equal(taskListState({ ...base, errorCode: "AGENT_INTERNAL" }), "error");
  assert.equal(taskListState({ ...base, loading: true }), "loading");
  assert.equal(taskListState(base), "empty");
  assert.equal(taskListState({ ...base, count: 3 }), "ready");
  /* 有缓存数据时不整页盖住：错误 / 加载只作为局部刷新事实。 */
  assert.equal(taskListState({ ...base, errorCode: "AGENT_INTERNAL", count: 3 }), "ready");
  assert.equal(taskListState({ ...base, loading: true, count: 3 }), "ready");
});

test("空态判定：0 或非法都算空", () => {
  assert.equal(isEmptyTaskList(0), true);
  assert.equal(isEmptyTaskList(-1), true);
  assert.equal(isEmptyTaskList(NaN), true);
  assert.equal(isEmptyTaskList(1), false);
});

test("窄宽阈值与 CSS 容器查询共用 900px", () => {
  assert.equal(TASK_NARROW_MAX, 900);
  assert.equal(isNarrowLayout(640), true);
  assert.equal(isNarrowLayout(900), true);
  assert.equal(isNarrowLayout(901), false);
  assert.equal(isNarrowLayout(NaN), false);
  const css = read("src/styles.css");
  assert.ok(css.indexOf("@container (max-width: 900px)") >= 0, "CSS 容器查询阈值必须仍是 900px");
  assert.ok(css.indexOf(".task-split") >= 0, "窄宽规则必须覆盖 .task-split");
});

/* ══════════════════════════════════════════════════════════════════════════
   6 事件流：规范化 + sequence 合并
   ══════════════════════════════════════════════════════════════════════════ */
test("normalizeTaskEvent 只接受正整数 sequence 与对象行", () => {
  assert.deepEqual(normalizeTaskEvent({ sequence: 2, type: "task.queued", message: "进入队列", created_at: 100 }), {
    sequence: 2,
    type: "task.queued",
    message: "进入队列",
    at: 100,
  });
  assert.equal(normalizeTaskEvent({ sequence: 0 }), null);
  assert.equal(normalizeTaskEvent({ sequence: -3 }), null);
  assert.equal(normalizeTaskEvent({ sequence: "x" }), null);
  assert.equal(normalizeTaskEvent(null), null);
  assert.equal(normalizeTaskEvent([]), null);
  const fallbackType = normalizeTaskEvent({ sequence: 1 });
  assert.equal(fallbackType.type, "task.event");
  assert.equal(fallbackType.at, null);
});

test("mergeTaskEvents 去重、按 sequence 升序、保留最高值", () => {
  const first = mergeTaskEvents([], [{ sequence: 2 }, { sequence: 1 }]);
  assert.deepEqual(first.events.map((e) => e.sequence), [1, 2]);
  assert.equal(first.added, 2);
  assert.equal(first.duplicate, 0);
  assert.equal(first.highest, 2);
  assert.equal(first.gap, false);

  const second = mergeTaskEvents(first.events, [{ sequence: 2 }, { sequence: 3 }]);
  assert.deepEqual(second.events.map((e) => e.sequence), [1, 2, 3]);
  assert.equal(second.added, 1);
  assert.equal(second.duplicate, 1);
  assert.equal(second.highest, 3);
});

test("mergeTaskEvents 检出 sequence 缺口（丢事件）", () => {
  const merged = mergeTaskEvents([{ sequence: 1, type: "a", message: "", at: null }], [{ sequence: 4 }]);
  assert.equal(merged.gap, true, "1 → 4 必须判为缺口");
  assert.equal(taskEventSequenceState(1, 2), "ok");
  assert.equal(taskEventSequenceState(1, 4), "gap");
  assert.equal(taskEventSequenceState(4, 2), "duplicate");
  assert.equal(taskEventSequenceState(4, 0), "invalid");
  assert.equal(taskEventSequenceState(4, 5), "ok");
});

test("mergeTaskEvents 按上限裁剪但保留最新事件与最高 sequence", () => {
  const incoming = Array.from({ length: 30 }, (_, i) => ({ sequence: i + 1 }));
  const merged = mergeTaskEvents([], incoming, 10);
  assert.equal(merged.events.length, 10);
  assert.equal(merged.events[0].sequence, 21);
  assert.equal(merged.highest, 30);
  assert.equal(merged.gap, false, "裁剪掉的是最老的，保留区间仍连续");
});

test("nextEventCursor 给出增量拉取游标（空流为 0）", () => {
  assert.equal(nextEventCursor([]), 0);
  assert.equal(nextEventCursor([{ sequence: 1 }, { sequence: 7 }]), 7);
});

test("agent:event 只认 progress，sequence 单调判定区分重放与丢帧", () => {
  const event = { kind: "progress", sequence: 3, payload: { command: "agent/task/get", phase: "begin" } };
  assert.equal(agentProgressPhase(event), "begin");
  assert.equal(agentProgressPhase({ kind: "log", payload: {} }), null);
  assert.equal(agentProgressPhase(null), null);
  assert.equal(agentProgressPhase({ kind: "progress", payload: { phase: "weird" } }), null);

  assert.deepEqual(progressSequenceState(0, { sequence: 1 }), { status: "ok", last: 1 });
  /* 首个事件只建立基线：共享通道开始订阅时序号早就 >1，不能判成缺口。 */
  assert.deepEqual(progressSequenceState(0, { sequence: 8 }), { status: "ok", last: 8 });
  assert.deepEqual(progressSequenceState(1, { sequence: 1 }), { status: "duplicate", last: 1 });
  assert.deepEqual(progressSequenceState(1, { sequence: 3 }), { status: "gap", last: 3 });
  assert.deepEqual(progressSequenceState(5, { sequence: 2 }), { status: "duplicate", last: 5 });
  assert.deepEqual(progressSequenceState(5, null), { status: "invalid", last: 5 });
});

test("等待提问只从事件流的 task.waiting_user 取（taskSummary 不投影该字段）", () => {
  const events = [
    { sequence: 1, type: "task.queued", message: "", at: null },
    { sequence: 2, type: "task.waiting_user", message: "请确认是否覆盖同名文件？", at: null },
    { sequence: 3, type: "task.answered", message: "覆盖", at: null },
  ];
  assert.equal(waitingQuestionFromEvents(events), "请确认是否覆盖同名文件？");
  assert.equal(waitingQuestionFromEvents([]), null);
  assert.equal(waitingQuestionFromEvents([{ sequence: 1, type: "task.queued", message: "x", at: null }]), null);
});

/* ══════════════════════════════════════════════════════════════════════════
   7 步骤进度 / 搜索
   ══════════════════════════════════════════════════════════════════════════ */
test("步骤进度统计已完成数，未知总量不伪造百分比", () => {
  assert.deepEqual(stepProgress([]), { done: 0, total: 0, ratio: null });
  const steps = [{ status: "completed" }, { status: "running" }, { status: "completed" }, { status: "queued" }];
  assert.deepEqual(stepProgress(steps), { done: 2, total: 4, ratio: 0.5 });
  assert.equal(stepStatusLabel("completed"), "已完成");
  assert.equal(stepStatusLabel("weird"), "weird");
});

test("搜索过滤匹配标题 / ID / 指令", () => {
  const tasks = [
    { taskId: "t1", title: "整理周报", instruction: "把本周记录整理成周报草稿" },
    { taskId: "t2", title: "生成图片", instruction: "从提示词生成图片" },
  ];
  assert.equal(filterTasks(tasks, "").length, 2);
  assert.equal(filterTasks(tasks, "周报").length, 1);
  assert.equal(filterTasks(tasks, "t2").length, 1);
  assert.equal(filterTasks(tasks, "生成").length, 1);
  assert.equal(filterTasks(tasks, "不存在").length, 0);
});

/* ══════════════════════════════════════════════════════════════════════════
   8 界面源码边界
   ══════════════════════════════════════════════════════════════════════════ */
test("界面源码不联网、不写 localStorage、不直连本机端口", () => {
  for (const rel of ["src/projects/TaskConsole.tsx", "src/projects/taskConsoleLogic.ts"]) {
    const code = stripComments(read(rel));
    assert.equal(/\bfetch\s*\(/.test(code), false, rel + " 不得调用 fetch");
    assert.equal(/XMLHttpRequest|WebSocket|EventSource/.test(code), false, rel + " 不得使用网络对象");
    assert.equal(/localStorage|sessionStorage/.test(code), false, rel + " 不得写 localStorage/sessionStorage");
    assert.equal(/https?:\/\/|127\.0\.0\.1|localhost/.test(code), false, rel + " 不得直连本机端口或外网地址");
    assert.equal(/document\.cookie/.test(code), false, rel + " 不得读 cookie");
  }
});

test("界面只经 window.openarc.agent 取数据，命令体不含身份字段", () => {
  const code = stripComments(read("src/projects/TaskConsole.tsx"));
  assert.ok(code.indexOf("openarc") >= 0 && code.indexOf(".agent") >= 0, "必须通过 window.openarc.agent");
  assert.equal(/openarc\s*\.\s*(model|task|skill|mcp|resource)\b/.test(code), false, "不得越域取数据");
  assert.equal(/sessionRef/.test(code), false, "界面不得出现 sessionRef");
  assert.equal(/userId/.test(code), false, "界面不得出现 userId");
  assert.equal(/appId/.test(code), false, "界面不得出现 appId");
  /* 命令体只发 { command, payload }：payload 的键必须只有业务参数 + requestId。
     逐行解析 send(...) / runAction(...) 的内联载荷对象，身份字段一个都不许出现。 */
  const allowed = ["afterSequence", "answer", "message", "requestId", "taskId"];
  let payloadCount = 0;
  for (const line of code.split("\n")) {
    if (!/send\(|runAction\(/.test(line)) continue;
    const objects = line.match(/\{[^{}]*\}/g) || [];
    for (const obj of objects) {
      const inner = obj.slice(1, -1).trim();
      if (!inner) continue;
      payloadCount += 1;
      for (const part of inner.split(",")) {
        const key = part.split(":")[0].trim();
        if (!key) continue;
        assert.equal(allowed.indexOf(key) >= 0, true, "载荷出现未授权字段 " + key + " @ " + line.trim());
      }
    }
  }
  assert.ok(payloadCount >= 4, "至少应解析出 4 处载荷，实际 " + payloadCount);
});

test("UI-3 的 CSS 只追加 .task-*，不新增 token 定义", () => {
  const css = read("src/styles.css");
  const marker = css.indexOf("UI-3 · 任务 / Agent 控制台");
  assert.ok(marker > 0, "styles.css 必须包含 UI-3 区块");
  const start = css.lastIndexOf("/*", marker);
  const tail = css.slice(start);
  // UI-3 区块边界 = 从 UI-3 注释起，到第一条不属于 .task-* 的规则为止。
  // 后续批次（UI-4 的 .org-*、UI-5 的 .model-proto-*）会在同一文件继续追加，不能把它们的规则
  // 算进 UI-3 边界（旧写法切到文件末尾，后续批次一追加就误判越界）。选择器与 token 断言不放松。
  const rule = /(^|\n)\s*([^\n{}@]+)\{/g;
  let match;
  let checked = 0;
  let end = tail.length;
  while ((match = rule.exec(tail))) {
    const sel = match[2].trim();
    if (!sel || sel === "from" || sel === "to" || /%$/.test(sel)) continue;
    if (!sel.split(",").every((part) => part.trim().startsWith(".task-"))) {
      assert.notEqual(checked, 0, "UI-3 区块第一条规则必须是 .task-*：" + sel);
      end = match.index;
      break;
    }
    checked += 1;
  }
  /* 区块内不得出现自定义属性声明（token 只能来自 tokens.css）。 */
  const block = tail.slice(0, end).replace(/\/\*[\s\S]*?\*\//g, " ");
  assert.equal(/--[a-z0-9-]+\s*:/.test(block), false, "UI-3 区块不得新增 / 改写 token");
  assert.ok(checked >= 20, "至少应解析出 20 条 .task-* 规则，实际 " + checked);
});

test("main.tsx 只在 projects 分支承载任务控制台，既有 ProjectsApp 仍可达", () => {
  const code = read("src/main.tsx");
  assert.ok(code.indexOf('from "./projects/TaskConsole"') >= 0, "必须引入 TaskConsole");
  assert.ok(code.indexOf('w?.appId === "projects"') >= 0, "projects 分支必须保留");
  assert.ok(code.indexOf("<TaskConsole") >= 0 && code.indexOf("<ProjectsApp") >= 0, "两个子视图都要能渲染");
  assert.ok(code.indexOf('useState<"tasks" | "projects">') >= 0, "projects 内子视图切换状态必须存在");
});
