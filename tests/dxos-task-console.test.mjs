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
  CORE_TASK_ACTIONS,
  CORE_TASK_ACTION_PAYLOAD_KEYS,
  CORE_TASK_COMMANDS,
  CORE_TASK_ERROR_TEXT,
  CORE_TASK_REASON_TEXT,
  CORE_TASK_STATUSES,
  TASK_CONSOLE_COMMANDS,
  TASK_DEPENDENCY_LABEL,
  TASK_ENTRIES,
  TASK_ENTRY_KEYS,
  TASK_ENTRY_REQUIRED_INPUTS,
  TASK_ENTRY_RISK_LABEL,
  TASK_ENTRY_RISK_TEXT,
  UNIFIED_READ_MODEL_COMMAND,
  UNIFIED_SOURCES,
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
  normalizeUnifiedList,
  taskEntryAvailability,
  taskEntryConfirmSummary,
  taskEntryConfirmTitle,
  taskEntryDependencyText,
  taskEntryMeta,
  taskEntryMissingInputs,
  taskEntryRiskText,
  TASK_LIST_SIDE_LABEL,
  taskListCounts,
  taskListFailedSides,
  taskListFailureScope,
  taskListFailureTitle,
  taskListState,
  taskListStateFromSides,
  taskPhase,
  taskEventSequenceState,
  unifiedCountsText,
  unifiedSourceBadge,
  unifiedSourceIndex,
  unifiedSourceLabel,
  waitingQuestionFromEvents,
  coreActionConfirmSummary,
  coreActionConfirmTitle,
  coreActionDisabledReason,
  coreActionMissingInputs,
  coreActionPayload,
  coreTaskActionMeta,
  coreTaskActionRiskText,
  coreTaskErrorText,
  coreTaskFailureText,
  coreTaskReasonText,
  coreTaskStatusLabel,
  coreTaskStatusTone,
  isActiveCoreStatus,
  isAllowedCoreTaskCommand,
  isCoreTaskStatus,
  nextUnacknowledgedRecoveryCall,
  normalizeCoreTaskDetail,
  unifiedCapabilityNote,
} from "../src/projects/taskConsoleLogic.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);
const domain = require(path.join(ROOT, "electron", "agent-domain.cjs"));
const taskStore = require(path.join(ROOT, "electron", "agent-task-store.cjs"));
const taskBootstrap = require(path.join(ROOT, "electron", "task-bootstrap.cjs"));
const coreDomain = require(path.join(ROOT, "electron", "task-domain.cjs"));

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");

/* ══════════════════════════════════════════════════════════════════════════
   1 命令白名单：界面白名单 == 后端白名单
   ══════════════════════════════════════════════════════════════════════════ */
test("命令白名单逐条等于后端 agent-domain.cjs 的 AGENT_COMMANDS（含顺序与条数）", () => {
  const backend = Object.keys(domain.AGENT_COMMANDS);
  assert.equal(backend.length, 28, "后端应有 28 条 agent 命令（27 + agent/health + agent/task/unified-list）");
  assert.deepEqual([...AGENT_COMMANDS], backend, "界面白名单必须与后端完全一致，不能多也不能少");
});

test("白名单命令都是 agent/ 前缀且不重复", () => {
  const set = new Set(AGENT_COMMANDS);
  assert.equal(set.size, AGENT_COMMANDS.length, "白名单不能有重复项");
  for (const c of AGENT_COMMANDS) {
    // 后端真实命令名允许连字符（agent/task/unified-list），前缀判据同步放宽到 [a-z/-]。
    assert.match(c, /^agent\/[a-z/-]+$/, c + " 必须是 agent/ 前缀命令");
    assert.equal(domain.isAgentCommand(c), true, c + " 必须是后端承认的命令");
  }
});

test("isAllowedAgentCommand 拒绝非白名单输入（含原型污染与非法类型）", () => {
  for (const bad of ["", "agent/unknown", "agent/list ", "AGENT/LIST", "__proto__", "constructor", "toString", undefined, null, 42, {}, []]) {
    assert.equal(isAllowedAgentCommand(bad), false, JSON.stringify(bad) + " 必须被拒绝");
  }
  assert.equal(isAllowedAgentCommand("agent/task/list"), true);
});

test("控制台发出的命令是后端白名单的子集，写操作入口与统一读模型都在内", () => {
  for (const c of TASK_CONSOLE_COMMANDS) {
    assert.equal(AGENT_COMMANDS.indexOf(c) >= 0, true, c + " 必须属于 AGENT_COMMANDS");
    assert.equal(domain.isAgentCommand(c), true, c + " 必须被后端承认");
  }
  /* UI-3b 四个写操作入口 + 统一读模型：命令名与后端一致，界面不再只读。 */
  for (const required of ["agent/task/create", "agent/tool/call", "agent/project/run", "agent/react/run", "agent/task/unified-list"]) {
    assert.equal(TASK_CONSOLE_COMMANDS.indexOf(required) >= 0, true, "必须提供入口 " + required);
    assert.equal(domain.isAgentCommand(required), true, required + " 必须被后端承认");
  }
  /* 仍不发起的一类：项目快照（写盘）不在本波入口里。 */
  assert.equal(TASK_CONSOLE_COMMANDS.indexOf("agent/project/snapshot"), -1, "本波不发起 agent/project/snapshot");
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

/* ── 5b. 列表状态按统一视图两侧（DX + core）合并判定（U1 修正）────────────── */
const side = (count, extra = {}) => ({ loading: false, errorCode: null, count, ...extra });
const sides = (dx, core, dependencyUnavailable = false) => ({ dependencyUnavailable, dx, core });

test("两侧组合的四种状态：只有一侧有数据也是 ready，两侧都空才是 empty", () => {
  assert.equal(taskListStateFromSides(sides(side(0), side(0))), "empty");
  /* core-only：U1 报出的真缺口——只有 core 任务时必须就绪，而不是空。 */
  assert.equal(taskListStateFromSides(sides(side(0), side(2))), "ready");
  assert.equal(taskListStateFromSides(sides(side(3), side(0))), "ready");
  assert.equal(taskListStateFromSides(sides(side(3), side(1))), "ready");
  /* 加载与实际数据不冲突：只要一侧已拿到数据就进就绪态（另一侧不整页盖住）。 */
  assert.equal(taskListStateFromSides(sides(side(3, { loading: true }), side(0, { loading: true }))), "ready");
  assert.equal(taskListStateFromSides(sides(side(0, { loading: true }), side(0, { loading: true }))), "loading");
  /* 依赖缺失仍是先于数据态的环境事实。 */
  assert.equal(taskListStateFromSides(sides(side(0), side(0), true)), "unavailable");
  assert.equal(taskListStateFromSides(sides(side(3), side(0), true)), "unavailable");
});

test("单侧失败：无数据是整体失败，有数据是该侧失败（core 取数失败不得静默成空）", () => {
  const dxFail = sides(side(0, { errorCode: "AGENT_COMMAND_NOT_ALLOWED" }), side(0));
  const coreFail = sides(side(0), side(0, { errorCode: "AGENT_INTERNAL" }));
  assert.equal(taskListStateFromSides(dxFail), "error");
  assert.equal(taskListStateFromSides(coreFail), "error");
  assert.notEqual(taskListStateFromSides(coreFail), "empty");
  assert.deepEqual(taskListFailedSides(dxFail), ["dx"]);
  assert.deepEqual(taskListFailedSides(coreFail), ["core"]);
  assert.deepEqual(taskListFailedSides(sides(side(0, { errorCode: "X" }), side(0, { errorCode: "Y" }))), ["dx", "core"]);
  assert.deepEqual(taskListFailedSides(sides(side(0), side(0))), []);
  assert.equal(taskListFailureScope(coreFail), "overall");
  assert.equal(taskListFailureScope(sides(side(0), side(0))), "none");

  /* 该侧失败：另一侧还有数据 → 列表照常 ready，失败只作为局部事实。 */
  const coreFailWithDx = sides(side(3), side(0, { errorCode: "AGENT_INTERNAL" }));
  const dxFailWithCore = sides(side(0, { errorCode: "AGENT_COMMAND_NOT_ALLOWED" }), side(1));
  assert.equal(taskListStateFromSides(coreFailWithDx), "ready");
  assert.equal(taskListStateFromSides(dxFailWithCore), "ready");
  assert.equal(taskListFailureScope(coreFailWithDx), "side");
  assert.equal(taskListFailureScope(dxFailWithCore), "side");
  assert.deepEqual(taskListFailedSides(coreFailWithDx), ["core"]);
  /* 有缓存数据时失败不整页盖住（与 taskListState 的既有语义一致）。 */
  assert.equal(taskListStateFromSides(sides(side(2, { errorCode: "X" }), side(1))), "ready");
});

test("计数口径：两侧有效条数相加，非法 / 负数按 0 且不制造数据", () => {
  assert.deepEqual(taskListCounts({ dx: side(3), core: side(1) }), { dx: 3, core: 1, total: 4 });
  assert.deepEqual(taskListCounts({ dx: side(0), core: side(2) }), { dx: 0, core: 2, total: 2 });
  assert.deepEqual(taskListCounts({ dx: side(-1), core: side(NaN) }), { dx: 0, core: 0, total: 0 });
  assert.deepEqual(taskListCounts({ dx: side(2.9), core: side(Infinity) }), { dx: 2, core: 0, total: 2 });
});

test("整页失败标题点名失败侧并保留稳定错误码；DX 文案保持既有口径", () => {
  assert.equal(
    taskListFailureTitle("dx", "AGENT_COMMAND_NOT_ALLOWED"),
    "读取任务列表失败：" + TASK_ERROR_TEXT.AGENT_COMMAND_NOT_ALLOWED,
  );
  const coreTitle = taskListFailureTitle("core", "AGENT_INTERNAL");
  assert.ok(coreTitle.indexOf("core 任务列表") >= 0, coreTitle);
  assert.ok(coreTitle.indexOf(TASK_ERROR_TEXT.AGENT_INTERNAL) >= 0, coreTitle);
  assert.ok(TASK_LIST_SIDE_LABEL.core.indexOf("unified-list") >= 0, TASK_LIST_SIDE_LABEL.core);
  assert.ok(TASK_LIST_SIDE_LABEL.dx.indexOf("agent/task/list") >= 0, TASK_LIST_SIDE_LABEL.dx);
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
  const allowed = [
    "afterSequence", "answer", "arguments", "instruction", "message",
    "projectId", "requestId", "taskId", "title", "tool",
  ];
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


/* ══════════════════════════════════════════════════════════════════════════
   9 写操作入口（UI-3b）—— 可用性 / 风险 / 必填 / 统一读模型来源
   ══════════════════════════════════════════════════════════════════════════ */
test("四个写操作入口逐条落在后端白名单，命令与界面入口同源", () => {
  assert.deepEqual([...TASK_ENTRY_KEYS], ["create", "tool-call", "project-run", "react-run"]);
  assert.equal(TASK_ENTRIES.length, 4);
  for (const meta of TASK_ENTRIES) {
    assert.equal(domain.isAgentCommand(meta.command), true, meta.command + " 必须是后端命令");
    assert.equal(TASK_CONSOLE_COMMANDS.indexOf(meta.command) >= 0, true, meta.command + " 必须在界面白名单");
    assert.equal(taskEntryMeta(meta.key), meta);
    assert.ok(meta.requires.length > 0, meta.key + " 必须声明依赖");
  }
  assert.equal(taskEntryMeta("nope"), null);
  assert.equal(taskEntryRiskText("nope"), "");
  assert.deepEqual(Object.keys(TASK_ENTRY_RISK_LABEL).sort(), ["external-side-effect", "model-call", "write"]);
  for (const key of TASK_ENTRY_KEYS) assert.ok(TASK_ENTRY_RISK_TEXT[key].length > 0, key + " 必须有风险说明");
});

test("入口可用性：桥缺失 / 依赖缺失 / 就绪三态，缺哪个依赖就说哪个", () => {
  const noBridge = taskEntryAvailability("create", { hasBridge: false, missing: [] });
  assert.equal(noBridge.available, false);
  assert.equal(noBridge.kind, "no-bridge");

  /* 工具目录 + 虚拟文件树缺失：agent/tool/call 不可用 */
  const toolAvail = taskEntryAvailability("tool-call", {
    hasBridge: true,
    missing: [
      { key: "toolCatalog", label: TASK_DEPENDENCY_LABEL.toolCatalog },
      { key: "fsAdapter", label: TASK_DEPENDENCY_LABEL.fsAdapter },
    ],
  });
  assert.equal(toolAvail.available, false);
  assert.equal(toolAvail.kind, "dependency");
  assert.ok(toolAvail.title.indexOf("工具目录") >= 0, toolAvail.title);
  assert.ok(toolAvail.description.indexOf("虚拟文件树") >= 0, toolAvail.description);
  assert.deepEqual(toolAvail.missing.map((m) => m.key).sort(), ["fsAdapter", "toolCatalog"]);

  /* 模型站点缺失：project/run 与 react/run 都要点名 */
  for (const key of ["project-run", "react-run"]) {
    const av = taskEntryAvailability(key, {
      hasBridge: true,
      missing: [
        { key: "modelAdapter", label: TASK_DEPENDENCY_LABEL.modelAdapter },
        { key: "providerAdapter", label: TASK_DEPENDENCY_LABEL.providerAdapter },
      ],
    });
    assert.equal(av.kind, "dependency");
    assert.ok(av.title.indexOf("模型调用出口") >= 0, key + " " + av.title);
    assert.ok(av.description.indexOf("模型供应商只读桥") >= 0, key + " " + av.description);
  }

  /* 无关依赖缺失不影响入口（create 只依赖 db / actorResolution）。 */
  const createReady = taskEntryAvailability("create", {
    hasBridge: true,
    missing: [{ key: "fsAdapter", label: TASK_DEPENDENCY_LABEL.fsAdapter }],
  });
  assert.equal(createReady.available, true);
  assert.equal(createReady.kind, "ready");
  assert.equal(createReady.missing.length, 0);
  assert.equal(taskEntryAvailability("nope", { hasBridge: true, missing: [] }).kind, "input");
});

test("依赖缺失文案说明没有产物，且与原 task 文案同一口径", () => {
  const text = taskEntryDependencyText(TASK_ENTRIES[1], [{ key: "toolCatalog", label: "工具目录" }]);
  assert.ok(text.startsWith("缺少依赖："));
  assert.ok(text.indexOf("工具目录") >= 0);
  assert.ok(text.indexOf("没有产生任何产物") >= 0, text);
});

test("必填输入在前端就被拦下（不发空命令）", () => {
  assert.deepEqual(TASK_ENTRY_REQUIRED_INPUTS.create, ["projectId", "instruction"]);
  assert.deepEqual(taskEntryMissingInputs("create", { projectId: "p1" }), ["instruction"]);
  assert.deepEqual(taskEntryMissingInputs("create", { projectId: "p1", instruction: "  " }), ["instruction"]);
  assert.deepEqual(taskEntryMissingInputs("create", { projectId: "p1", instruction: "做点事", title: "" }), []);
  assert.deepEqual(taskEntryMissingInputs("tool-call", { tool: "file.read" }), []);
  assert.deepEqual(taskEntryMissingInputs("tool-call", {}), ["tool"]);
  assert.deepEqual(taskEntryMissingInputs("react-run", { taskId: "t1" }), []);
  assert.deepEqual(taskEntryMissingInputs("nope", {}), []);
});

test("统一读模型：来源标注 dx / core / 并列，计数不重算", () => {
  const view = normalizeUnifiedList({
    ok: true,
    readModel: true,
    boundary: "这是读模型：不写任何表、不改变任何一方状态机。",
    sources: ["dx", "core"],
    counts: { dx: 2, core: 1, total: 3 },
    items: [
      { source: "dx", id: "t1", title: "甲", status: "RUNNING", projectId: "p1" },
      { source: "core", id: "t1", title: "甲（core）", status: "SUCCEEDED", projectId: null },
      { source: "dx", id: "t2", title: "乙", status: null, projectId: "p1" },
      { source: "weird", id: "" },
    ],
  });
  assert.equal(view.ok, true);
  assert.equal(view.readModel, true);
  assert.deepEqual(view.counts, { dx: 2, core: 1, total: 3 });
  assert.equal(view.items.length, 3, "缺 id 的行被丢弃");
  assert.deepEqual(unifiedSourceIndex(view.items), { t1: "dx+core", t2: "dx" });
  assert.deepEqual(unifiedSourceBadge("dx"), { label: "DX", tone: "neutral" });
  assert.deepEqual(unifiedSourceBadge("core"), { label: "core", tone: "neutral" });
  assert.equal(unifiedSourceBadge("dx+core").tone, "warning");
  assert.equal(unifiedSourceBadge("weird").tone, "warning");
  assert.ok(unifiedSourceLabel("core").indexOf("core") >= 0);
  assert.equal(unifiedSourceLabel("weird"), "weird");
  assert.ok(unifiedCountsText(view).indexOf("dx 2") >= 0 && unifiedCountsText(view).indexOf("core 1") >= 0);
  assert.equal(unifiedCountsText(null), "统一读模型未返回");
  assert.deepEqual([...UNIFIED_SOURCES], ["dx", "core"]);
  assert.equal(UNIFIED_READ_MODEL_COMMAND, "agent/task/unified-list");
  assert.deepEqual(normalizeUnifiedList(null).counts, { dx: 0, core: 0, total: 0 });
});

test("界面源码包含四个写操作入口与统一读模型，且不发身份字段", () => {
  const code = stripComments(read("src/projects/TaskConsole.tsx"));
  for (const marker of ["TASK_ENTRIES", "data-task-entry", "data-task-source", "UNIFIED_READ_MODEL_COMMAND"]) {
    assert.ok(code.indexOf(marker) >= 0, "界面必须渲染 " + marker);
  }
  assert.equal(/sessionRef|userId|appId/.test(code), false, "界面不得出现身份字段");
  const logic = stripComments(read("src/projects/taskConsoleLogic.ts"));
  for (const c of ["agent/task/create", "agent/tool/call", "agent/project/run", "agent/react/run", "agent/task/unified-list"]) {
    assert.ok(logic.indexOf(c) >= 0, "逻辑层必须登记 " + c);
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   写类入口二次确认（UI-3c）：确认前不发命令；取消则命令数 0；确认后才发送
   ══════════════════════════════════════════════════════════════════════════ */
test("四个写操作入口都有二次确认标题与副作用说明", () => {
  for (const key of TASK_ENTRY_KEYS) {
    const title = taskEntryConfirmTitle(key);
    const summary = taskEntryConfirmSummary(key, {});
    assert.ok(title && title.trim().length > 0, key + " 必须有确认标题");
    assert.ok(summary && summary.length > 0, key + " 必须有副作用说明");
  }
  assert.equal(taskEntryConfirmTitle("nope"), "确认");
  assert.equal(taskEntryConfirmSummary("nope", {}), "");
});

test("确认框摘要只列出已填字段，不编造载荷", () => {
  const summary = taskEntryConfirmSummary("create", { projectId: "p_weekly", instruction: "写周报" });
  assert.ok(summary.indexOf("p_weekly") >= 0 && summary.indexOf("写周报") >= 0, summary);
  assert.equal(summary.indexOf("标题"), -1, "未填的 title 不应出现在摘要里：" + summary);
});

test("界面源码用 Dialog 做二次确认：确认前不发命令、取消按钮存在", () => {
  const code = stripComments(read("src/projects/TaskConsole.tsx"));
  assert.ok(code.indexOf("Dialog") >= 0, "必须复用既有 Dialog");
  assert.ok(code.indexOf("task-entry-confirm-submit") >= 0, "必须有确认按钮");
  assert.ok(code.indexOf("task-entry-confirm-cancel") >= 0, "必须有取消按钮");
  assert.ok(code.indexOf("requestEntry") >= 0, "入口按钮必须先走 requestEntry（不直接 submitEntry）");
  assert.equal(
    /onClick=\{\(\) => void submitEntry\(meta\.key\)\}/.test(code),
    false,
    "入口按钮不得直接发送命令",
  );
});


/* ══════════════════════════════════════════════════════════════════════════
   U1 · core 任务（既有 tasks / task_steps）—— 另一套命令域与动作
   ══════════════════════════════════════════════════════════════════════════ */
test("core 命令白名单逐条等于后端 task-bootstrap.cjs 的 TASK_COMMANDS（含顺序与条数）", () => {
  assert.equal(taskBootstrap.TASK_COMMANDS.length, 8, "后端 core 域应有 8 条命令");
  assert.deepEqual([...CORE_TASK_COMMANDS], [...taskBootstrap.TASK_COMMANDS], "界面 core 白名单必须与后端完全一致");
  for (const c of CORE_TASK_COMMANDS) {
    assert.match(c, /^task\/[A-Za-z]+$/, c + " 必须是 task/ 前缀命令");
    assert.equal(isAllowedCoreTaskCommand(c), true, c + " 必须被 core 白名单承认");
  }
  assert.equal(isAllowedCoreTaskCommand("agent/task/continue"), false, "core 白名单不得混入 agent 命令");
  assert.equal(isAllowedCoreTaskCommand("task/appendstep"), false, "命令名大小写不匹配必须拒绝");
  for (const bad of ["", "__proto__", "constructor", undefined, null, 42, {}, []]) {
    assert.equal(isAllowedCoreTaskCommand(bad), false, JSON.stringify(bad) + " 必须被拒绝");
  }
});

test("core 动作集合与 DX（agent/*）动作集合不重叠、不混用", () => {
  for (const meta of CORE_TASK_ACTIONS) {
    assert.equal(CORE_TASK_COMMANDS.indexOf(meta.command) >= 0, true, meta.command + " 必须在 core 白名单");
    assert.equal(AGENT_COMMANDS.indexOf(meta.command), -1, meta.command + " 不得是 agent 命令");
    assert.equal(TASK_CONSOLE_COMMANDS.indexOf(meta.command), -1, "DX 控制台不得发 " + meta.command);
    assert.equal(meta.requiresConfirm, true, meta.label + " 是写/终结动作，必须二次确认");
    assert.ok(meta.description.length > 0 && meta.label.length > 0);
  }
  for (const c of TASK_CONSOLE_COMMANDS) {
    assert.equal(CORE_TASK_COMMANDS.indexOf(c), -1, "core 白名单不得包含 DX 命令 " + c);
  }
  assert.equal(coreTaskActionMeta("append-step").command, "task/appendStep");
  assert.equal(coreTaskActionMeta("nope"), null);
  assert.equal(coreTaskActionRiskText("append-step"), "写操作");
  assert.equal(coreTaskActionRiskText("cancel"), "终结操作");
  assert.equal(coreTaskActionRiskText("nope"), "");
});

test("core 载荷只含白名单业务键，且绝不包含身份字段", () => {
  const payload = coreActionPayload("append-step", {
    taskId: "core_sync",
    goal: "  继续处理  ",
    expectedRevision: 7,
    requestId: "req-1",
    userId: "u_evil",
    role: "ADMIN",
    appId: "ai",
    sessionRef: "s_evil",
  });
  assert.deepEqual(Object.keys(payload).sort(), ["expectedRevision", "goal", "requestId", "taskId"]);
  assert.equal(payload.goal, "继续处理", "goal 去首尾空白");
  for (const key of Object.keys(payload)) {
    assert.equal(CORE_TASK_ACTION_PAYLOAD_KEYS.indexOf(key) >= 0, true, key + " 必须在载荷白名单");
  }
  for (const bad of ["userId", "role", "appId", "sessionRef"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(payload, bad), false, "绝不发送 " + bad);
  }
  /* 无 taskId 时不产出任何载荷（后端会 INVALID_INPUT，界面先行拦截）。 */
  assert.deepEqual(coreActionPayload("append-step", { goal: "x" }), {});
  assert.deepEqual(coreActionPayload("nope", { taskId: "t" }), {});
  /* 可选值缺失时不写入 key。 */
  assert.deepEqual(Object.keys(coreActionPayload("resume", { taskId: "t" })), ["taskId"]);
  assert.deepEqual(Object.keys(coreActionPayload("append-step", { taskId: "t", goal: "  " })), ["taskId"]);
});

test("core 必填输入在前端就被拦下（不发空命令）", () => {
  assert.deepEqual(coreActionMissingInputs("append-step", { taskId: "t" }), ["goal"]);
  assert.deepEqual(coreActionMissingInputs("append-step", { taskId: "t", goal: "x" }), []);
  assert.deepEqual(coreActionMissingInputs("append-step", {}), ["taskId", "goal"]);
  assert.deepEqual(coreActionMissingInputs("acknowledge-unknown-effect", { taskId: "t" }), ["callId"]);
  assert.deepEqual(coreActionMissingInputs("acknowledge-unknown-effect", { taskId: "t", callId: "c1" }), []);
  assert.deepEqual(coreActionMissingInputs("nope", { taskId: "t" }), []);
  assert.ok(CORE_TASK_ACTION_PAYLOAD_KEYS.length >= 4);
});

test("core 可用性判定：桥缺失 / 详情未就绪 / 状态不允许都给出可见原因", () => {
  const noBridge = coreActionDisabledReason("append-step", { hasBridge: false, detail: null });
  assert.ok(noBridge.indexOf("window.openarc.task") >= 0, noBridge);
  const noDetail = coreActionDisabledReason("append-step", { hasBridge: true, detail: null });
  assert.ok(noDetail.indexOf("详情尚未就绪") >= 0, noDetail);

  const detail = (over) =>
    normalizeCoreTaskDetail(
      Object.assign(
        {
          ok: true,
          task: { taskId: "core_sync", goal: "同步素材库", status: "SUCCEEDED", revision: 7, cancelRequested: false },
          steps: [{ stepId: "s1", sequence: 1, kind: "reasoning", status: "SUCCEEDED" }],
          artifacts: [{ artifactId: "a1", type: "text" }],
          appendable: true,
          appendReason: null,
          resumable: false,
          resumeReason: "RESUME_NOT_BLOCKED",
          recovery: { applicable: false, reason: null, calls: [] },
        },
        over,
      ),
    );

  const ready = detail();
  assert.equal(ready.task.status, "SUCCEEDED");
  assert.equal(coreActionDisabledReason("append-step", { hasBridge: true, detail: ready, goal: "继续" }), null);
  assert.ok(coreActionDisabledReason("append-step", { hasBridge: true, detail: ready }).indexOf("填写") >= 0);

  const denied = detail({ appendable: false, appendReason: "APPEND_IN_FLIGHT" });
  const deniedReason = coreActionDisabledReason("append-step", { hasBridge: true, detail: denied, goal: "继续" });
  assert.ok(deniedReason.indexOf("已有步骤或 run 正在进行") >= 0, deniedReason);

  const blocked = detail({ task: { taskId: "t", goal: "g", status: "BLOCKED", revision: 3 }, resumable: true, resumeReason: null });
  assert.equal(coreActionDisabledReason("resume", { hasBridge: true, detail: blocked }), null);
  const notResumable = detail({ resumable: false, resumeReason: "RESUME_NOT_BUDGET_STOP" });
  assert.ok(coreActionDisabledReason("resume", { hasBridge: true, detail: notResumable }).indexOf("不是因预算耗尽停止") >= 0);

  const done = detail({ task: { taskId: "t", goal: "g", status: "SUCCEEDED", revision: 1 } });
  assert.ok(coreActionDisabledReason("cancel", { hasBridge: true, detail: done }).indexOf("不能再取消") >= 0);
  const cancelled = detail({ task: { taskId: "t", goal: "g", status: "CANCELLED", revision: 2 } });
  assert.ok(coreActionDisabledReason("cancel", { hasBridge: true, detail: cancelled }).indexOf("不能再取消") >= 0);
  const running = detail({ task: { taskId: "t", goal: "g", status: "RUNNING", revision: 2 } });
  assert.equal(coreActionDisabledReason("cancel", { hasBridge: true, detail: running }), null);

  const noRecovery = detail();
  assert.ok(coreActionDisabledReason("acknowledge-unknown-effect", { hasBridge: true, detail: noRecovery, callId: "c1" }).indexOf("没有需要人工核查") >= 0);
  const recovery = detail({
    task: { taskId: "t", goal: "g", status: "BLOCKED", revision: 4 },
    recovery: {
      applicable: true,
      reason: "RESUME_UNKNOWN_EFFECT_PRESENT",
      calls: [{ callId: "c1", status: "UNKNOWN_EFFECT", acknowledged: false }],
    },
  });
  assert.equal(coreActionDisabledReason("acknowledge-unknown-effect", { hasBridge: true, detail: recovery, callId: "c1" }), null);
  const acked = detail({
    recovery: {
      applicable: true,
      reason: "RESUME_UNKNOWN_EFFECT_PRESENT",
      calls: [{ callId: "c1", status: "UNKNOWN_EFFECT", acknowledged: true }],
    },
  });
  assert.ok(coreActionDisabledReason("acknowledge-unknown-effect", { hasBridge: true, detail: acked, callId: "c1" }).indexOf("已经确认过") >= 0);
});

test("core 错误码全部有人话文案，拒绝原因与人话分开登记", () => {
  const codes = [...new Set(Object.values(coreDomain.ERROR))];
  assert.ok(codes.length >= 40, "core ERROR 码数量异常：" + codes.length);
  for (const code of codes) {
    const text = coreTaskErrorText(code);
    assert.equal(text, CORE_TASK_ERROR_TEXT[code], code + " 必须逐条登记，不能落兜底");
    assert.ok(text.length > 0 && text !== "core 任务操作失败", code);
  }
  const reasons = [...new Set([...Object.values(coreDomain.APPEND_REASON), ...Object.values(coreDomain.RESUME_REASON)])];
  assert.ok(reasons.length >= 20);
  for (const reason of reasons) {
    const text = coreTaskReasonText(reason);
    assert.equal(text, CORE_TASK_REASON_TEXT[reason], reason + " 必须逐条登记");
    assert.ok(text.length > 0 && text !== reason, reason);
  }
  assert.equal(coreTaskReasonText("APPEND_UNKNOWN_EFFECT"), "存在结果未知的副作用，先核查再追加");
  assert.equal(coreTaskFailureText("APPEND_IN_FLIGHT"), CORE_TASK_REASON_TEXT.APPEND_IN_FLIGHT, "拒绝原因优先于错误码");
  assert.equal(coreTaskFailureText("TASK_REVISION_CONFLICT"), CORE_TASK_ERROR_TEXT.TASK_REVISION_CONFLICT);
  assert.equal(coreTaskErrorText("SOMETHING_NEW"), "core 任务操作失败");
  assert.equal(coreTaskReasonText(""), "没有给出原因");
});

test("core task/get 投影规范化：形状、取消资格与待确认副作用", () => {
  const result = {
    ok: true,
    task: {
      taskId: "core_sync", goal: "同步素材库", status: "BLOCKED", revision: 9, cancelRequested: false,
      createdAt: 1, updatedAt: 2, startedAt: 1, completedAt: null, userId: "u_local", appId: "ai",
    },
    steps: [
      { stepId: "s1", sequence: 1, kind: "reasoning", status: "BLOCKED", startedAt: 1, completedAt: 2 },
      { stepId: "s2", sequence: 2, kind: "reasoning", status: "PENDING" },
    ],
    artifacts: [{ artifactId: "a1", stepId: "s1", type: "text", createdAt: 3 }],
    verifications: [{ type: "SCHEMA_VALID", status: "PASS" }],
    appendable: false,
    appendReason: "APPEND_NOT_SUCCEEDED",
    resumable: true,
    resumeReason: null,
    stopReason: "BUDGET_EXHAUSTED",
    recovery: {
      applicable: true,
      reason: "RESUME_UNKNOWN_EFFECT_PRESENT",
      calls: [
        { callId: "c1", toolId: "file.write", status: "UNKNOWN_EFFECT", acknowledged: false },
        { callId: "c2", toolId: "file.write", status: "UNKNOWN_EFFECT", acknowledged: true },
      ],
    },
  };
  const detail = normalizeCoreTaskDetail(result);
  assert.equal(detail.task.taskId, "core_sync");
  assert.equal(detail.task.revision, 9);
  assert.equal(detail.steps.length, 2);
  assert.equal(detail.artifacts.length, 1);
  assert.equal(detail.verifications.length, 1);
  assert.equal(detail.canCancel, true, "BLOCKED 仍可取消");
  assert.equal(detail.appendable, false);
  assert.equal(detail.resumable, true);
  assert.equal(nextUnacknowledgedRecoveryCall(detail).callId, "c1");
  /* 信封形式 { ok, value } 也要能解。 */
  assert.equal(normalizeCoreTaskDetail({ ok: true, value: result }).task.taskId, "core_sync");
  assert.equal(normalizeCoreTaskDetail({ ok: false, error: "TASK_NOT_FOUND" }), null);
  assert.equal(normalizeCoreTaskDetail({ ok: true }), null);
  assert.equal(normalizeCoreTaskDetail(null), null);
  assert.equal(normalizeCoreTaskDetail([]), null);

  const succeeded = normalizeCoreTaskDetail({ ok: true, task: { taskId: "t", status: "SUCCEEDED", cancelRequested: false } });
  assert.equal(succeeded.canCancel, false);
  const requested = normalizeCoreTaskDetail({ ok: true, task: { taskId: "t", status: "RUNNING", cancelRequested: true } });
  assert.equal(requested.canCancel, false, "已请求取消就不再重复提供取消");
  assert.equal(nextUnacknowledgedRecoveryCall(succeeded), null);
  assert.equal(nextUnacknowledgedRecoveryCall(null), null);
});

test("core 状态词汇来自后端 7 态；进行态判定只覆盖未结束状态", () => {
  assert.deepEqual([...CORE_TASK_STATUSES], ["PENDING", "RUNNING", "WAITING", "SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED"]);
  for (const s of CORE_TASK_STATUSES) {
    assert.equal(isCoreTaskStatus(s), true);
    assert.ok(coreTaskStatusLabel(s).length > 0);
    assert.equal(["neutral", "success", "warning", "danger"].indexOf(coreTaskStatusTone(s)) >= 0, true);
  }
  assert.equal(isCoreTaskStatus("running"), false, "core 是大小写敏感的大写状态，DX 的小写状态不得混入");
  assert.ok(coreTaskStatusLabel("weird").indexOf("weird") >= 0, "未登记状态原样显示");
  assert.equal(isActiveCoreStatus("RUNNING"), true);
  assert.equal(isActiveCoreStatus("WAITING"), true);
  assert.equal(isActiveCoreStatus("PENDING"), true);
  assert.equal(isActiveCoreStatus("SUCCEEDED"), false);
  assert.equal(isActiveCoreStatus("BLOCKED"), false);
  assert.equal(isActiveCoreStatus("FAILED"), false);
});

test("core 二次确认标题与副作用说明都非空，并带上真实目标 / callId", () => {
  for (const meta of CORE_TASK_ACTIONS) {
    assert.ok(coreActionConfirmTitle(meta.key).length > 0, meta.key);
    const summary = coreActionConfirmSummary(meta.key, { taskId: "core_sync", goal: "继续处理", callId: "c1" });
    assert.ok(summary.length > 0 && summary.indexOf("core_sync") >= 0, meta.key + " " + summary);
  }
  assert.ok(coreActionConfirmSummary("append-step", { taskId: "t", goal: "继续处理" }).indexOf("继续处理") >= 0);
  assert.ok(coreActionConfirmSummary("acknowledge-unknown-effect", { taskId: "t", callId: "c9" }).indexOf("c9") >= 0);
  assert.equal(coreActionConfirmTitle("nope"), "确认");
  assert.equal(coreActionConfirmSummary("nope", {}), "");
});

test("统一读模型标注按来源说明能做什么，不再用一句只读概括两套命令", () => {
  const core = unifiedCapabilityNote("core");
  const dx = unifiedCapabilityNote("dx");
  assert.ok(core.indexOf("task/appendStep") >= 0 && core.indexOf("agent/*") >= 0, core);
  assert.ok(dx.indexOf("agent/") >= 0 && dx.indexOf("task/*") >= 0, dx);
  assert.ok(core.indexOf("不能混用") >= 0 && dx.indexOf("不能混用") >= 0);
  assert.ok(unifiedCapabilityNote("weird").indexOf("不提供任何动作") >= 0);
});

test("core 桥收敛在 coreTaskConsole.ts：TaskConsole.tsx 不出现 openarc.task", () => {
  const bridge = stripComments(read("src/projects/coreTaskConsole.ts"));
  assert.ok(bridge.indexOf("openarc") >= 0 && bridge.indexOf(".task") >= 0, "core 桥必须只经 window.openarc.task");
  assert.ok(bridge.indexOf("sendCoreTaskCommand") >= 0, "必须只有一个出口");
  assert.equal(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|localStorage|sessionStorage/.test(bridge), false, "core 桥不得联网 / 写存储");
  const consoleCode = stripComments(read("src/projects/TaskConsole.tsx"));
  assert.equal(/openarc\s*\.\s*task\b/.test(consoleCode), false, "TaskConsole.tsx 不得直接引用 openarc.task");
  assert.ok(consoleCode.indexOf("sendCoreTaskCommand") >= 0, "TaskConsole 必须经 core 桥出口发命令");
  assert.ok(consoleCode.indexOf("data-task-core-action") >= 0, "必须渲染 core 动作按钮");
  assert.ok(consoleCode.indexOf("data-task-core-confirm-submit") >= 0, "core 写类动作必须有二次确认");
  assert.ok(consoleCode.indexOf("nextUnacknowledgedRecoveryCall") >= 0, "必须渲染待确认副作用入口");
});


