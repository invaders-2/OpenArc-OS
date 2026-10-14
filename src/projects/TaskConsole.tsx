
/**
 * UI-3 · 任务 / Agent 控制台（appId projects 内子视图）。
 *
 * 数据面边界（与 McpCenter.tsx / SkillCenter.tsx / preload.cjs:161-172 同一口径）：
 *   · 只经 window.openarc.agent.command 发受控命令，只订阅 agent.onEvent；
 *   · 不 fetch、不直连本机端口、不读凭据、不写 localStorage；
 *   · sessionRef / userId / role 一律由主进程注入：界面**不发**这些字段，
 *     只发 { command, payload }（payload 里只有业务参数 + 请求内 requestId）。
 *
 * 后端形状（electron/agent-service.cjs:674-699 / agent-domain.cjs:164-171）：
 *   成功 { ok:true, value:{...} }；失败 { ok:false, error, message, detail? }。
 *   value 里没有 api_key / credentialRef / 绝对路径（出口统一过 redactAgentValue）。
 *
 * 状态覆盖（任务书七类）：加载 / 空 / 错误（命令被拒 / 会话失效 / 依赖缺失）/
 * 就绪（列表 + 计划·步骤·事件流·检查点·交付物）/ 运行中（agent:event 增量）/
 * 等待用户（回答输入）/ 窄宽。纯逻辑见 ./taskConsoleLogic.ts。
 *
 * 视觉：只用 primitives 组件与 tokens.css 既有 token；结构对齐 SkillCenter.tsx 的
 * split-side / split-main 信息密度（左侧子视图导航在 main.tsx 的 projects 分支）。
 * agent:event 的 sequence 只用于判定增量丢帧，不用于伪造进度（MOTION_SYSTEM §7）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  ScrollArea,
  SearchField,
  TextField,
  ToastProvider,
  useToast,
} from "../design-system/primitives";
import { PageState } from "../design-system/page-states";
/* page-states.css 只被设计系统 gallery 引用过；PageState 是本页错误 / 空 / 加载态的
   唯一实现，这里按需引入它自己的样式表（不改任何既有类与 token）。 */
import "../design-system/page-states.css";
/* 写类入口的二次确认复用产品既有 Dialog（焦点陷阱 / Esc / 焦点返回都在组件内）。 */
import { Dialog } from "../desktop/Dialog";
import {
  TASK_CONSOLE_COMMANDS,
  TASK_ENTRIES,
  TASK_ENTRY_INPUT_LABEL,
  TASK_ENTRY_RISK_LABEL,
  TASK_ENTRY_RISK_TEXT,
  UNIFIED_READ_MODEL_COMMAND,
  agentProgressPhase,
  canCancelTask,
  canContinueTask,
  canPauseTask,
  canResumeTask,
  dependencyMissingText,
  dependencyOfDetail,
  filterTasks,
  isActiveTaskStatus,
  isAllowedAgentCommand,
  mergeTaskEvents,
  missingDependencies,
  nextEventCursor,
  normalizeUnifiedList,
  progressSequenceState,
  stepProgress,
  stepStatusLabel,
  taskActionDisabledReason,
  taskEntryAvailability,
  taskEntryConfirmSummary,
  taskEntryConfirmTitle,
  taskEntryMeta,
  taskEntryMissingInputs,
  taskErrorState,
  taskErrorText,
  taskEventLabel,
  taskFeedbackForStatus,
  taskListState,
  unifiedCountsText,
  unifiedSourceBadge,
  unifiedSourceIndex,
  waitingQuestionFromEvents,
} from "./taskConsoleLogic";
import type {
  AgentProgressEvent,
  TaskEntryKey,
  TaskEvent,
  TaskStep,
  UnifiedListView,
} from "./taskConsoleLogic";

/* ══════════════════════════════════════════════════════════════════════════
   桥与结果形状
   ══════════════════════════════════════════════════════════════════════════ */
type AgentBridge = {
  command: (cmd: Record<string, unknown>) => Promise<AgentResult>;
  onEvent?: (cb: (event: AgentProgressEvent) => void) => () => void;
};
type AgentResult = Record<string, unknown> & { ok?: boolean };

/** 只读访问：不改 window.openarc 的类型声明，也不扩大暴露面。 */
const getAgentBridge = (): AgentBridge | undefined => {
  if (typeof window === "undefined") return undefined;
  const root = (window as unknown as { openarc?: { agent?: AgentBridge } }).openarc;
  return root && root.agent ? root.agent : undefined;
};

/* ══════════════════════════════════════════════════════════════════════════
   小工具
   ══════════════════════════════════════════════════════════════════════════ */
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const asText = (v: unknown, fallback = "—"): string => {
  if (typeof v === "string") return v.trim() ? v : fallback;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : fallback;
  if (typeof v === "boolean") return v ? "是" : "否";
  return fallback;
};

const codeOf = (v: unknown): string => (typeof v === "string" && v ? v : "AGENT_INTERNAL");
const messageOf = (v: unknown): string => (typeof v === "string" ? v : "");

const timeText = (ts: unknown): string => {
  const n = Number(ts);
  if (ts == null || !Number.isFinite(n) || n <= 0) return "—";
  return new Date(n).toLocaleString("zh-CN", { hour12: false });
};

/** agent-service.cjs:164-171 的成功体是 { ok:true, value }；这里兼容平铺返回。 */
const valueOf = (res: AgentResult): Record<string, unknown> => (isObject(res.value) ? res.value : res);

const listOf = (res: AgentResult, ...keys: string[]): unknown[] => {
  const v = valueOf(res);
  for (const k of keys) {
    if (Array.isArray(v[k])) return v[k] as unknown[];
  }
  return [];
};

const requestIdFactory = (): string => {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* 回退到时间戳 + 随机串 */
  }
  return "req-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
};

/* ══════════════════════════════════════════════════════════════════════════
   页面
   ══════════════════════════════════════════════════════════════════════════ */
type TaskRecord = {
  taskId?: string;
  projectId?: string;
  threadId?: string;
  title?: string;
  instruction?: string;
  status?: string;
  mode?: string;
  executionProfile?: string;
  createdAt?: number;
  updatedAt?: number;
  startedAt?: number | null;
  completedAt?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  agentRunId?: string | null;
};

type Deliverable = { id?: string; name?: string; type?: string; createdAt?: number };

type DetailState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "error"; code: string; message: string }
  | { kind: "ready"; task: TaskRecord; steps: TaskStep[]; deliverables: Deliverable[]; checkpoints: number };

type Failure = { code: string; context: string; message?: string };
type DependencyState = { code: string; dependency: string | null; message: string | null; context: string };
type Health = { status: string; dependencies: Record<string, unknown> };

export function TaskConsole({ role }: { role: string | null }) {
  return (
    <ToastProvider>
      <TaskConsoleBody role={role} />
    </ToastProvider>
  );
}

function TaskConsoleBody({ role }: { role: string | null }) {
  const bridge = getAgentBridge();
  const available = typeof bridge?.command === "function";
  const { toast } = useToast();

  /* 初值 true：首屏在 useEffect 发命令之前不先画一帧"还没有任务"（假空态）。 */
  const [loading, setLoading] = useState(true);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [listError, setListError] = useState<Failure | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [dependency, setDependency] = useState<DependencyState | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({ kind: "none" });
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [eventGap, setEventGap] = useState(false);
  const [progressSequence, setProgressSequence] = useState(0);
  const [progressGap, setProgressGap] = useState(false);
  const [lastProgressPhase, setLastProgressPhase] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [continueText, setContinueText] = useState("");
  const [continueOpen, setContinueOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  /* UI-3b 写操作入口：四条命令同一条白名单；这里只保存输入、进行中与失败事实。 */
  const [entryInputs, setEntryInputs] = useState<Record<string, string>>({});
  const [entryBusy, setEntryBusy] = useState<string | null>(null);
  const [entryFailure, setEntryFailure] = useState<{ entry: TaskEntryKey; code: string; context: string } | null>(null);
  /* UI-3c 二次确认：待确认的入口与已构造好的载荷；非 null 时弹 Dialog，确认前不发命令。 */
  const [pendingEntry, setPendingEntry] = useState<{ key: TaskEntryKey; payload: Record<string, unknown>; summary: string } | null>(null);
  /* 统一读模型：只读列表来源标注（不改任何一方状态机）。 */
  const [unified, setUnified] = useState<UnifiedListView | null>(null);

  const eventsRef = useRef<TaskEvent[]>([]);

  const send = useCallback(
    async (command: string, payload: Record<string, unknown> = {}): Promise<AgentResult> => {
      // 白名单先在渲染层挡一次，与 agent-domain.cjs:102-104 / agent-bootstrap.cjs:43 同一条判据。
      if (!isAllowedAgentCommand(command) || TASK_CONSOLE_COMMANDS.indexOf(command) < 0) {
        return { ok: false, error: "AGENT_COMMAND_NOT_ALLOWED", message: "命令不在白名单内" };
      }
      if (!bridge?.command) return { ok: false, error: "NO_BRIDGE" };
      try {
        const res = await bridge.command({ command, payload });
        return isObject(res) ? res : { ok: false, error: "RESPONSE_INCOMPLETE" };
      } catch {
        // 桥异常与后端异常一样收敛成可见错误码，不允许"点了没反应"。
        return { ok: false, error: "AGENT_INTERNAL" };
      }
    },
    [bridge],
  );

  /** 依赖缺失是环境事实：先于数据态，且必须说清缺哪个依赖。 */
  const markDependency = useCallback((code: string, detail: unknown, message: string, context: string) => {
    const kind = taskErrorState(code);
    if (kind !== "unavailable") return;
    setDependency({ code, dependency: dependencyOfDetail(detail), message: message || null, context });
  }, []);

  const loadHealth = useCallback(async () => {
    const res = await send("agent/health");
    if (res.ok !== true) {
      setHealth(null);
      return;
    }
    const v = valueOf(res);
    setHealth({
      status: asText(v.status, "unknown"),
      dependencies: isObject(v.dependencies) ? (v.dependencies as Record<string, unknown>) : {},
    });
  }, [send]);

  const mergeIncomingEvents = useCallback((incoming: unknown) => {
    setEvents((prev) => {
      const merged = mergeTaskEvents(prev, incoming);
      eventsRef.current = merged.events;
      setEventGap(merged.gap);
      return merged.events;
    });
  }, []);

  const loadList = useCallback(
    async (opts?: { silent?: boolean }): Promise<boolean> => {
      if (!opts?.silent) setLoading(true);
      const res = await send("agent/task/list");
      if (res.ok !== true) {
        const code = codeOf(res.error);
        const message = messageOf(res.message);
        setListError({ code, context: "读取任务列表", message });
        markDependency(code, res.detail, message, "读取任务列表");
        if (!opts?.silent) setLoading(false);
        return false;
      }
      const items = listOf(res, "items", "tasks").filter(isObject) as unknown as TaskRecord[];
      setTasks(items);
      setListError(null);
      if (!opts?.silent) setLoading(false);
      return true;
    },
    [send, markDependency],
  );

  /** 读取任务详情（agent-service.cjs:452-464 的安全投影）：task + steps + deliverables + checkpoints(数量)。 */
  const refreshSelected = useCallback(
    async (taskId: string, opts?: { silent?: boolean }): Promise<TaskRecord | null> => {
      if (!opts?.silent) setDetail({ kind: "loading" });
      const res = await send("agent/task/get", { taskId });
      if (res.ok !== true) {
        const code = codeOf(res.error);
        const message = messageOf(res.message);
        markDependency(code, res.detail, message, "读取任务详情");
        setDetail({ kind: "error", code, message });
        return null;
      }
      const v = valueOf(res);
      const task = isObject(v.task) ? (v.task as unknown as TaskRecord) : null;
      if (!task) {
        setDetail({ kind: "error", code: "RESPONSE_INCOMPLETE", message: "" });
        return null;
      }
      const steps = (Array.isArray(v.steps) ? v.steps : []).filter(isObject) as unknown as TaskStep[];
      const deliverables = (Array.isArray(v.deliverables) ? v.deliverables : []).filter(isObject) as unknown as Deliverable[];
      const checkpoints = Number.isFinite(Number(v.checkpoints)) ? Number(v.checkpoints) : 0;
      setDetail({ kind: "ready", task, steps, deliverables, checkpoints });
      return task;
    },
    [send, markDependency],
  );

  /** 按 sequence 增量拉取（afterSequence = 已合并最高值）。 */
  const loadEvents = useCallback(
    async (taskId: string, afterOverride?: number): Promise<boolean> => {
      const afterSequence = afterOverride == null ? nextEventCursor(eventsRef.current) : afterOverride;
      const res = await send("agent/task/events", { taskId, afterSequence });
      if (res.ok !== true) {
        const code = codeOf(res.error);
        markDependency(code, res.detail, messageOf(res.message), "读取任务事件流");
        return false;
      }
      mergeIncomingEvents(listOf(res, "items", "events"));
      return true;
    },
    [send, markDependency, mergeIncomingEvents],
  );

  const loadDetail = useCallback(
    async (taskId: string) => {
      setSelectedId(taskId);
      setDetail({ kind: "loading" });
      eventsRef.current = [];
      setEvents([]);
      setEventGap(false);
      setFailure(null);
      setNotice(null);
      setAnswer("");
      setContinueText("");
      setContinueOpen(false);
      setConfirmCancel(false);
      const task = await refreshSelected(taskId);
      if (task) await loadEvents(taskId, 0);
    },
    [refreshSelected, loadEvents],
  );

  /** 统一读模型（只读）：失败不阻塞主列表，界面照实标注来源未知。 */
  const loadUnified = useCallback(async () => {
    const res = await send(UNIFIED_READ_MODEL_COMMAND, {});
    setUnified(normalizeUnifiedList(res));
  }, [send]);

  useEffect(() => {
    if (!available) {
      setLoading(false);
      setDependency({ code: "NO_BRIDGE", dependency: null, message: null, context: "接入 agent 域" });
      return;
    }
    void loadHealth();
    void loadList();
    void loadUnified();
    // 只在挂载时拉一次；后续由动作成功后显式刷新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available]);

  /* agent:event（P1 信封）：只处理 progress；sequence 单调判定丢帧，不伪造进度。 */
  useEffect(() => {
    if (!available || typeof bridge?.onEvent !== "function") return;
    const off = bridge.onEvent((event) => {
      const phase = agentProgressPhase(event);
      if (!phase) return;
      setProgressSequence((last) => {
        const judged = progressSequenceState(last, event);
        if (judged.status === "gap") setProgressGap(true);
        if (judged.status === "duplicate" || judged.status === "invalid") return last;
        return judged.last;
      });
      setLastProgressPhase(phase);
    });
    return off;
  }, [available, bridge]);

  const activeSelected = detail.kind === "ready" && isActiveTaskStatus(detail.task.status);

  /* 进行态：按 sequence 增量轮询事件流 + 刷新状态（真实执行期间才有活动指示）。 */
  useEffect(() => {
    if (!available || !selectedId || !activeSelected) return;
    const timer = window.setInterval(() => {
      void (async () => {
        await refreshSelected(selectedId, { silent: true });
        await loadEvents(selectedId);
      })();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [available, selectedId, activeSelected, refreshSelected, loadEvents]);

  /* ── 动作 ─────────────────────────────────────────────────────────────── */
  const refreshAll = async () => {
    await loadList({ silent: true });
    if (selectedId) {
      await refreshSelected(selectedId, { silent: true });
      await loadEvents(selectedId);
    }
    await loadUnified();
  };

  const runAction = async (
    action: string,
    command: string,
    payload: Record<string, unknown>,
    okNotice: string,
    context: string,
  ): Promise<boolean> => {
    setBusy(action);
    setFailure(null);
    setNotice(null);
    const res = await send(command, payload);
    setBusy(null);
    if (res.ok !== true) {
      const code = codeOf(res.error);
      const message = messageOf(res.message);
      markDependency(code, res.detail, message, context);
      setFailure({ code, context, message });
      /* 失败通知常驻：错误不能只闪过几秒（DESIGN_SYSTEM §9 / MOTION_SYSTEM §7）。 */
      toast({
        kind: "error",
        title: context + "失败",
        description: taskErrorText(code) + "（" + code + "）",
        duration: null,
      });
      return false;
    }
    setNotice(okNotice);
    toast({ kind: "success", title: okNotice });
    await refreshAll();
    return true;
  };

  const submitAnswer = async () => {
    if (!selectedId) return;
    const reason = taskActionDisabledReason("answer", {
      status: detail.kind === "ready" ? detail.task.status : null,
      answer,
    });
    if (reason) {
      setFailure({ code: "LOCAL_INPUT_REQUIRED", context: reason });
      return;
    }
    const ok = await runAction(
      "answer",
      "agent/task/answer",
      { taskId: selectedId, answer: answer.trim(), requestId: requestIdFactory() },
      "回答已提交，任务重新排队",
      "回答任务",
    );
    if (ok) setAnswer("");
  };

  const togglePause = () =>
    selectedId ? runAction("pause", "agent/task/pause", { taskId: selectedId }, "任务已暂停", "暂停任务") : Promise.resolve(false);
  const resumeTask = () =>
    selectedId ? runAction("resume", "agent/task/resume", { taskId: selectedId }, "任务已重新排队", "恢复任务") : Promise.resolve(false);
  const cancelTask = async () => {
    setConfirmCancel(false);
    if (selectedId) await runAction("cancel", "agent/task/cancel", { taskId: selectedId }, "任务已取消", "取消任务");
  };
  const continueTask = async () => {
    if (!selectedId) return;
    if (!continueText.trim()) {
      setFailure({ code: "LOCAL_INPUT_REQUIRED", context: "追加要求不能为空" });
      return;
    }
    const ok = await runAction(
      "continue",
      "agent/task/continue",
      { taskId: selectedId, message: continueText.trim(), requestId: requestIdFactory() },
      "已追加要求，任务重新排队",
      "追加要求",
    );
    if (ok) {
      setContinueText("");
      setContinueOpen(false);
    }
  };

  /**
   * 本地必填 / JSON 校验 + 载荷构造。失败时写 entryFailure 并返回 null：
   * 既不弹确认框，也不发命令（与后端 requireStr 的必填项同一份清单）。
   */
  const prepareEntry = (key: TaskEntryKey): { payload: Record<string, unknown>; summary: string } | null => {
    const meta = taskEntryMeta(key);
    if (!meta) return null;
    const values: Record<string, string> = {};
    for (const field of meta.inputs) values[field] = entryInputs[key + ":" + field] || "";
    const missingInputs = taskEntryMissingInputs(key, values);
    if (missingInputs.length) {
      setEntryFailure({
        entry: key,
        code: "LOCAL_INPUT_REQUIRED",
        context: "缺少必填内容（" + missingInputs.map((f) => TASK_ENTRY_INPUT_LABEL[f] || f).join("、") + "）",
      });
      return null;
    }
    const payload: Record<string, unknown> = {};
    for (const field of meta.inputs) {
      const value = values[field].trim();
      if (!value) continue;
      if (field === "arguments") {
        try {
          payload.arguments = JSON.parse(value);
        } catch {
          setEntryFailure({ entry: key, code: "LOCAL_INPUT_REQUIRED", context: "参数必须是合法 JSON" });
          return null;
        }
      } else {
        payload[field] = value;
      }
    }
    return { payload, summary: taskEntryConfirmSummary(key, payload) };
  };

  /** 点入口按钮：先本地校验，再打开二次确认；命令数保持 0。 */
  const requestEntry = (key: TaskEntryKey) => {
    setEntryFailure(null);
    const prepared = prepareEntry(key);
    if (!prepared) return;
    setPendingEntry({ key, payload: prepared.payload, summary: prepared.summary });
  };

  const cancelEntryConfirm = () => setPendingEntry(null);

  /** 确认后真正发送：白名单命令 → 结构化失败。 */
  const submitEntry = async (key: TaskEntryKey, payload: Record<string, unknown>) => {
    const meta = taskEntryMeta(key);
    if (!meta) return;
    setEntryBusy(key);
    setEntryFailure(null);
    setFailure(null);
    setNotice(null);
    const res = await send(meta.command, payload);
    setEntryBusy(null);
    if (res.ok !== true) {
      const code = codeOf(res.error);
      const message = messageOf(res.message);
      markDependency(code, res.detail, message, meta.label);
      setEntryFailure({ entry: key, code, context: meta.label });
      /* 失败通知常驻：错误不能只闪过几秒（DESIGN_SYSTEM §9）。 */
      toast({
        kind: "error",
        title: meta.label + "失败",
        description: taskErrorText(code) + "（" + code + "）",
        duration: null,
      });
      return;
    }
    setNotice(meta.label + "已提交，任务会出现在列表里");
    toast({ kind: "success", title: meta.label + "已提交" });
    await refreshAll();
    await loadUnified();
  };

  const confirmEntry = async () => {
    const pending = pendingEntry;
    setPendingEntry(null);
    if (!pending) return;
    await submitEntry(pending.key, pending.payload);
  };

  /* ── 派生 ─────────────────────────────────────────────────────────────── */
  const dependencyText = useMemo(
    () =>
      dependency
        ? dependencyMissingText({
            code: dependency.code,
            dependency: dependency.dependency,
            missing: missingDependencies(health),
            message: dependency.message,
          })
        : "",
    [dependency, health],
  );

  const listState = taskListState({
    loading,
    errorCode: listError ? listError.code : null,
    dependencyUnavailable: !!dependency,
    count: tasks.length,
  });

  const filteredTasks = filterTasks(tasks, query);
  const missing = missingDependencies(health);
  const healthDegraded = !!health && (health.status !== "ok" || missing.length > 0);
  const healthLabel = health
    ? healthDegraded
      ? "依赖 " + missing.length + " 项缺失"
      : "依赖已就绪"
    : "健康未知";
  /* 统一读模型的来源索引：行内来源标注用；core-only 项单独列一行。 */
  const sourceIndex = unifiedSourceIndex(unified ? unified.items : []);
  const entryMissing = missingDependencies(health);
  const coreUnified = unified ? unified.items.filter((item) => item.source === "core") : [];

  const selectedTask = detail.kind === "ready" ? detail.task : null;
  const feedback = taskFeedbackForStatus(selectedTask ? selectedTask.status : null);
  const runningSteps = detail.kind === "ready" ? stepProgress(detail.steps) : { done: 0, total: 0, ratio: null };
  const waitingQuestion = detail.kind === "ready" ? waitingQuestionFromEvents(events) : null;
  const highestSequence = nextEventCursor(events);
  const lowestSequence = events.length ? events[0].sequence : 0;
  const actionStatus = selectedTask ? selectedTask.status : null;
  const actionMode = selectedTask ? selectedTask.mode : null;
  const answerReason = taskActionDisabledReason("answer", { status: actionStatus, answer });
  const canContinue = !!selectedTask && canContinueTask(actionStatus, actionMode);

  /* ══════════════════════════════════════════════════════════════════════
     渲染
     ══════════════════════════════════════════════════════════════════════ */
  if (!available) {
    return (
      <div className="task-center" data-task-center="1" data-task-available="false">
        <PageState kind="unavailable" title="Agent 域未接入" description={dependencyMissingText({ code: "NO_BRIDGE" })} />
        <p className="task-muted" data-task-dependency>
          {dependencyMissingText({ code: "NO_BRIDGE" })}
        </p>
      </div>
    );
  }

  return (
    <div className="task-center" data-task-center="1" data-task-available="true">
      <div className="task-banner">
        <div className="task-banner__row">
          <h1 className="task-banner__title">任务 / Agent 控制台</h1>
          <span className="task-muted">11 态任务机 · 计划 / 步骤 / 事件流 / 检查点 / 交付物</span>
          <Badge tone={healthDegraded ? "warning" : "neutral"} className="task-status" data-task-health>
            {healthLabel}
          </Badge>
        </div>
        {failure ? (
          <p className="task-error" role="alert" data-task-error data-task-error-code={failure.code}>
            {failure.context}：{taskErrorText(failure.code)}（{failure.code}）
            {failure.message ? " · " + failure.message : ""}
          </p>
        ) : null}
        {notice ? (
          <p className="task-notice" role="status" data-task-notice>
            {notice}
          </p>
        ) : null}
        {listError && tasks.length > 0 ? (
          <p className="task-error" role="alert" data-task-error data-task-error-code={listError.code}>
            刷新任务列表失败：{taskErrorText(listError.code)}（{listError.code}）
          </p>
        ) : null}
      </div>

      <section className="task-section" aria-label="写操作入口" data-task-entries>
        <div className="task-section-head">
          <h4>写操作入口</h4>
          <span className="task-muted" data-task-entries-unified>
            {unifiedCountsText(unified)}
          </span>
        </div>
        <p className="task-muted" data-task-unified-boundary>
          {unified && unified.boundary
            ? unified.boundary
            : "统一读模型只读合并 DX 与 core 两套任务表；来源标注见任务行。"}
        </p>
        <ScrollArea label="写操作入口" maxHeight={280}>
          <div data-task-entry-list>
            {TASK_ENTRIES.map((meta) => {
              const av = taskEntryAvailability(meta.key, { hasBridge: available, missing: entryMissing });
              const busy = entryBusy === meta.key;
              const err = entryFailure && entryFailure.entry === meta.key ? entryFailure : null;
              return (
                <div
                  className="task-run task-entry"
                  key={meta.key}
                  data-task-entry={meta.key}
                  data-task-entry-command={meta.command}
                  data-task-entry-state={busy ? "busy" : av.available ? "ready" : av.kind}
                  data-task-entry-risk={meta.risk}
                  aria-busy={busy ? "true" : undefined}
                >
                  <div className="task-run__head task-entry-head">
                    <span data-task-entry-risk-badge>
                      <Badge tone={meta.risk === "write" ? "neutral" : "warning"} className="task-status">
                        {TASK_ENTRY_RISK_LABEL[meta.risk]}
                      </Badge>
                    </span>
                    {meta.requiresApproval ? (
                      <span data-task-entry-approval="true">
                        <Badge tone="warning" size="sm" className="task-status">
                          逐次审批
                        </Badge>
                      </span>
                    ) : null}
                    <strong>{meta.label}</strong>
                    <span className="task-muted task-mono">{meta.command}</span>
                  </div>
                  <p className="task-muted task-entry-meta" data-task-entry-desc>
                    {meta.description}
                  </p>
                  <p
                    className={(av.available ? "task-muted" : "task-warn") + " task-entry-meta"}
                    data-task-entry-availability={av.kind}
                  >
                    {av.title} · {av.description}
                  </p>
                  <p className="task-muted task-entry-meta" data-task-entry-risk-text>
                    {TASK_ENTRY_RISK_TEXT[meta.key]}
                  </p>
                  {meta.inputs.map((field) => (
                    <TextField
                      key={field}
                      label={TASK_ENTRY_INPUT_LABEL[field] || field}
                      data-task-entry-field={meta.key + ":" + field}
                      value={entryInputs[meta.key + ":" + field] || ""}
                      onChange={(e) =>
                        setEntryInputs((cur) => ({ ...cur, [meta.key + ":" + field]: e.target.value }))
                      }
                    />
                  ))}
                  <div className="task-actions task-entry-actions">
                    <Button
                      variant={meta.risk === "write" ? "secondary" : "primary"}
                      size="sm"
                      data-task-entry-action={meta.key}
                      status={busy ? "loading" : "idle"}
                      disabled={!av.available || entryBusy !== null}
                      onClick={() => requestEntry(meta.key)}
                    >
                      {meta.label}
                    </Button>
                    <span className="task-muted">{av.available ? "可用" : "不可用"}</span>
                  </div>
                  {err ? (
                    <p
                      className="task-error"
                      role="alert"
                      data-task-entry-error
                      data-task-entry-error-code={err.code}
                    >
                      {err.context}失败：{taskErrorText(err.code)}（{err.code}）
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </section>

      {/* 写类入口二次确认：确认前不发命令；取消 / Esc 都不发送（命令数保持 0）。 */}
      <Dialog
        open={pendingEntry !== null}
        title={pendingEntry ? taskEntryConfirmTitle(pendingEntry.key) : "确认"}
        onClose={cancelEntryConfirm}
        footer={
          <>
            <Button variant="ghost" size="sm" data-task-entry-confirm-cancel onClick={cancelEntryConfirm}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              data-task-entry-confirm-submit
              status={entryBusy !== null ? "loading" : "idle"}
              disabled={entryBusy !== null}
              onClick={() => void confirmEntry()}
            >
              确认发送
            </Button>
          </>
        }
      >
        {pendingEntry ? (
          <div className="task-entry-confirm" data-task-entry-confirm={pendingEntry.key}>
            <p className="task-entry-confirm-value" data-task-entry-confirm-summary>
              {pendingEntry.summary}
            </p>
            <p className="task-muted">确认前不会发出任何命令；取消则命令数为 0。</p>
          </div>
        ) : null}
      </Dialog>

      {listState !== "ready" ? (
        <div
          className="task-state-block"
          data-task-list-state={listState}
          data-task-dependency={listState === "unavailable" ? "" : undefined}
        >
          {listState === "loading" ? <PageState kind="loading" title="正在读取任务列表…" /> : null}
          {listState === "empty" ? (
            <PageState
              kind="empty"
              title="还没有任务"
              description="当前账号可见的项目里还没有 Agent 任务记录。任务在项目内创建后会出现在这里。"
            />
          ) : null}
          {listState === "error" ? (
            <PageState
              kind={taskErrorState(listError ? listError.code : "AGENT_INTERNAL")}
              title={"读取任务列表失败：" + taskErrorText(listError ? listError.code : "AGENT_INTERNAL")}
              description={"后端返回的稳定错误码是 " + (listError ? listError.code : "AGENT_INTERNAL") + "。"}
              onAction={() => void loadList()}
            />
          ) : null}
          {listState === "unavailable" ? (
            <PageState
              kind="unavailable"
              title={"任务控制台不可用：" + (dependency ? dependency.context : "依赖缺失")}
              description={dependencyText}
              onAction={() => { setDependency(null); void loadHealth(); void loadList(); }}
            />
          ) : null}

        </div>
      ) : (
        <div className="task-split">
          <section className="task-list-pane" aria-label="任务列表">
            <div className="task-pane-head">
              <h2 className="task-pane-title">任务</h2>
              <span className="task-muted" data-task-count>
                {filteredTasks.length} / {tasks.length}
              </span>
              <span className="task-muted" data-task-unified>
                {unifiedCountsText(unified)}
              </span>
            </div>
            <SearchField
              value={query}
              onValueChange={setQuery}
              placeholder="搜索任务"
              label="搜索任务"
              data-task-search
            />
            {filteredTasks.length ? (
              <ul className="task-list" data-task-list>
                {filteredTasks.map((task) => {
                  const fb = taskFeedbackForStatus(task.status);
                  const id = asText(task.taskId, "（无 ID）");
                  /* 来源标注来自 agent/task/unified-list；索引没有该 id 时按 DX 显示（本列表就是 DX 投影）。 */
                  const src = sourceIndex[id] || "dx";
                  const srcBadge = unifiedSourceBadge(src);
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        className="task-row"
                        data-task-id={id}
                        data-task-status={task.status || "unknown"}
                        aria-pressed={id === selectedId}
                        onClick={() => void loadDetail(id)}
                      >
                        <span className="task-row__top">
                          <strong data-task-name>{asText(task.title, id)}</strong>
                          <Badge tone={fb.tone} className="task-status">
                            {fb.glyph} {fb.label}
                          </Badge>
                          <span data-task-source={src}>
                            <Badge tone={srcBadge.tone} size="sm" className="task-status">
                              {srcBadge.label}
                            </Badge>
                          </span>
                        </span>
                        <span className="task-row__facts">
                          <span data-task-mode>{asText(task.mode, "固定步骤")}</span>
                          <span>{asText(task.executionProfile, "默认档")}</span>
                          <span data-task-updated>更新 {timeText(task.updatedAt)}</span>
                        </span>
                        <span className="task-row__desc" data-task-desc>
                          {asText(task.instruction, "（没有指令）")}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="task-muted" data-task-filter-empty>
                没有匹配「{query}」的任务。
              </p>
            )}
            {coreUnified.length ? (
              <p className="task-muted" data-task-unified-core>
                统一读模型里的 core 来源任务：
                {coreUnified.map((item) => " " + (item.title || item.id)).join("、")}
              </p>
            ) : null}
            {role !== "ADMIN" ? (
              <p className="task-muted" data-task-role-note>
                权限口径：任务按项目成员归属；被拒绝的动作会显示稳定错误码。
              </p>
            ) : null}
          </section>

          <section className="task-detail-pane" aria-label="任务详情" data-task-detail-state={detail.kind}>
            {detail.kind === "none" ? (
              <PageState
                kind="empty"
                title="选择一个任务"
                description="左侧选中的任务会显示状态、计划与步骤、事件流、检查点与交付物。"
              />
            ) : null}
            {detail.kind === "loading" ? <PageState kind="loading" title="正在读取任务详情…" /> : null}
            {detail.kind === "error" ? (
              <PageState
                kind={taskErrorState(detail.code)}
                title={"读取任务详情失败：" + taskErrorText(detail.code)}
                description={"后端返回的稳定错误码是 " + detail.code + "。"}
                onAction={selectedId ? () => void loadDetail(selectedId) : undefined}
              />
            ) : null}
            {detail.kind === "ready" && selectedTask ? (
              <div className="task-detail" key={asText(selectedTask.taskId, "task")} data-task-detail>
                <header className="task-detail__head">
                  <div className="task-detail__title">
                    <h3 data-task-detail-name>{asText(selectedTask.title, asText(selectedTask.taskId, "任务"))}</h3>
                    <Badge tone={feedback.tone} className="task-status" data-task-status-badge>
                      {feedback.glyph} {feedback.label}
                    </Badge>
                  </div>
                  <div className="task-detail__facts">
                    <span data-task-detail-id>ID {asText(selectedTask.taskId)}</span>
                    <span>项目 {asText(selectedTask.projectId)}</span>
                    <span>模式 {asText(selectedTask.mode, "固定步骤")}</span>
                    <span>创建 {timeText(selectedTask.createdAt)}</span>
                  </div>
                  {selectedTask.errorCode ? (
                    <p className="task-error" role="alert" data-task-task-error data-task-error-code={selectedTask.errorCode}>
                      任务失败码：{taskErrorText(selectedTask.errorCode)}（{selectedTask.errorCode}）
                      {selectedTask.errorMessage ? " · " + selectedTask.errorMessage : ""}
                    </p>
                  ) : null}
                </header>

                {/* 进行态反馈（MOTION_SYSTEM §7）：文字 + 图标 + 活动指示，颜色只是辅助。 */}
                <section className="task-section" aria-label="执行状态">
                  <div className="task-run" data-task-run data-task-run-status={selectedTask.status} data-task-phase={feedback.label}>
                    <div className="task-run__head">
                      <span className="task-run__glyph" aria-hidden="true">
                        {feedback.glyph}
                      </span>
                      <Badge tone={feedback.tone} className="task-status">
                        {feedback.label}
                      </Badge>
                      <span className="task-muted">{feedback.detail}</span>
                      {feedback.active ? <span className="ds-spinner" aria-hidden="true" /> : null}
                    </div>
                    <p className="task-muted" data-task-run-progress>
                      步骤 {runningSteps.done}/{runningSteps.total} · 最近 progress：
                      {lastProgressPhase || "尚未收到"} · agent:event sequence {progressSequence}
                      （{progressGap ? "有缺口" : "连续"}）· 任务事件 {highestSequence}
                      （{eventGap ? "有缺口" : "连续"}）
                    </p>
                  </div>

                  <div className="task-actions" data-task-actions>
                    {canPauseTask(actionStatus) ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        data-task-action="pause"
                        status={busy === "pause" ? "loading" : "idle"}
                        disabled={busy !== null}
                        onClick={() => void togglePause()}
                      >
                        暂停
                      </Button>
                    ) : null}
                    {canResumeTask(actionStatus) ? (
                      <Button
                        variant="primary"
                        size="sm"
                        data-task-action="resume"
                        status={busy === "resume" ? "loading" : "idle"}
                        disabled={busy !== null}
                        onClick={() => void resumeTask()}
                      >
                        恢复
                      </Button>
                    ) : null}
                    {canContinue ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        data-task-action="continue"
                        disabled={busy !== null}
                        onClick={() => setContinueOpen((v) => !v)}
                      >
                        {continueOpen ? "收起追加" : "追加要求"}
                      </Button>
                    ) : null}
                    {canCancelTask(actionStatus) ? (
                      confirmCancel ? (
                        <>
                          <Button
                            variant="danger"
                            size="sm"
                            data-task-action="cancel-confirm"
                            status={busy === "cancel" ? "loading" : "idle"}
                            disabled={busy !== null}
                            onClick={() => void cancelTask()}
                          >
                            确认取消
                          </Button>
                          <Button variant="ghost" size="sm" data-task-action="cancel-abort" disabled={busy !== null} onClick={() => setConfirmCancel(false)}>
                            放弃
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="danger"
                          size="sm"
                          data-task-action="cancel"
                          disabled={busy !== null}
                          onClick={() => setConfirmCancel(true)}
                        >
                          取消任务
                        </Button>
                      )
                    ) : null}
                  </div>

                  {canContinue && continueOpen ? (
                    <div className="task-continue">
                      <TextField
                        label="追加要求"
                        hint="追加内容会写入任务会话并让任务重新排队；界面不发送身份字段。"
                        data-task-field="continue"
                        value={continueText}
                        onChange={(e) => setContinueText(e.target.value)}
                      />
                      <div className="task-actions">
                        <Button
                          variant="primary"
                          size="sm"
                          data-task-action="continue-submit"
                          status={busy === "continue" ? "loading" : "idle"}
                          disabled={busy !== null || !continueText.trim()}
                          onClick={() => void continueTask()}
                        >
                          提交追加
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </section>

                {feedback.needsAnswer ? (
                  <section className="task-section task-answer" aria-label="回答任务提问">
                    <div className="task-section-head">
                      <h4>等待你的回答</h4>
                      <span className="task-muted">任务已停下；回答后会重新排队</span>
                    </div>
                    {waitingQuestion ? (
                      <p className="task-warn" data-task-question>
                        {waitingQuestion}
                      </p>
                    ) : (
                      <p className="task-muted" data-task-question>
                        任务在等待输入；提问文本来自事件流的 task.waiting_user（任务安全投影不单独暴露该字段）。
                      </p>
                    )}
                    <TextField
                      label="回答"
                      hint="回答会写入任务会话；界面不发送身份 / 角色 / 会话字段。"
                      data-task-field="answer"
                      value={answer}
                      onChange={(e) => setAnswer(e.target.value)}
                      error={failure && failure.code === "LOCAL_INPUT_REQUIRED" ? failure.context : undefined}
                    />
                    <div className="task-actions">
                      <Button
                        variant="primary"
                        size="sm"
                        data-task-action="answer"
                        status={busy === "answer" ? "loading" : "idle"}
                        disabled={busy !== null || answerReason !== null}
                        onClick={() => void submitAnswer()}
                      >
                        提交回答
                      </Button>
                      {answerReason ? (
                        <span className="task-muted" data-task-action-reason>
                          {answerReason}
                        </span>
                      ) : null}
                    </div>
                  </section>
                ) : null}

                <section className="task-section" aria-label="计划与步骤">
                  <div className="task-section-head">
                    <h4>计划与步骤</h4>
                    <span className="task-muted" data-task-step-progress>
                      {runningSteps.done} / {runningSteps.total} 步完成
                    </span>
                  </div>
                  {detail.steps.length ? (
                    <ol className="task-steps" data-task-steps>
                      {detail.steps.map((step, i) => (
                        <li
                          key={asText(step.id, "step-" + i)}
                          data-task-step={step.ordinal == null ? i : step.ordinal}
                          data-task-step-status={step.status || "unknown"}
                        >
                          <span className="task-step__ord">{step.ordinal == null ? i + 1 : step.ordinal}</span>
                          <span className="task-step__title">{asText(step.title, "步骤 " + (i + 1))}</span>
                          <span className="task-step__tool task-mono">{asText(step.tool)}</span>
                          <Badge tone={step.status === "failed" ? "danger" : step.status === "completed" ? "success" : "neutral"} size="sm">
                            {stepStatusLabel(step.status)}
                          </Badge>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="task-muted" data-task-steps-empty>
                      任务还没有登记步骤（固定步骤任务在规划后写入；react 任务按轮次写入）。
                    </p>
                  )}
                </section>

                <section className="task-section" aria-label="事件流">
                  <div className="task-section-head">
                    <h4>事件流</h4>
                    <span className="task-muted" data-task-events-meta>
                      sequence {lowestSequence}–{highestSequence} · {events.length} 条
                      {eventGap ? " · 有缺口（增量拉取丢事件）" : ""}
                    </span>
                  </div>
                  {events.length ? (
                    <ScrollArea label="任务事件流" maxHeight={260} className="task-events-scroll">
                      <ol className="task-events" data-task-events>
                        {events.map((event) => (
                          <li key={event.sequence} data-task-event-seq={event.sequence} data-task-event-type={event.type}>
                            <span className="task-event__seq task-mono">#{event.sequence}</span>
                            <span className="task-event__type">{taskEventLabel(event.type)}</span>
                            {event.message && event.message !== taskEventLabel(event.type) ? (
                              <span className="task-event__msg">{event.message}</span>
                            ) : null}
                            <span className="task-event__time task-mono">{timeText(event.at)}</span>
                          </li>
                        ))}
                      </ol>
                    </ScrollArea>
                  ) : (
                    <p className="task-muted" data-task-events-empty>
                      还没有任务事件。进行中的任务会按 sequence 增量拉取（afterSequence）。
                    </p>
                  )}
                </section>

                <section className="task-section" aria-label="检查点">
                  <div className="task-section-head">
                    <h4>检查点</h4>
                    <span className="task-muted" data-task-checkpoints>
                      {detail.checkpoints} 个
                    </span>
                  </div>
                  <p className="task-muted">
                    检查点由任务状态机写入 task_checkpoints；任务详情的安全投影只给出数量，界面不编造明细。
                  </p>
                </section>

                <section className="task-section" aria-label="交付物">
                  <div className="task-section-head">
                    <h4>交付物</h4>
                    <span className="task-muted" data-task-deliverables-count>
                      {detail.deliverables.length} 项
                    </span>
                  </div>
                  {detail.deliverables.length ? (
                    <ul className="task-deliverables" data-task-deliverables>
                      {detail.deliverables.map((item, i) => (
                        <li key={asText(item.id, "deliverable-" + i)} className="task-deliverable">
                          <span className="task-deliverable__name">{asText(item.name, "未命名交付物")}</span>
                          <span className="task-muted">{asText(item.type, "未知类型")}</span>
                          <span className="task-muted task-mono">{timeText(item.createdAt)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="task-muted" data-task-deliverables-empty>
                      还没有交付物。成功标记只对应验证通过的步骤，流式文本结束不会提前产出交付物。
                    </p>
                  )}
                </section>
              </div>
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}
