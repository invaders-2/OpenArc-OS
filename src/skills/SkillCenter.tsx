/**
 * UI-1 · Skill 中心（appId `skills` 的右侧内容区）。
 *
 * 数据面边界（与 McpCenter.tsx:8-13 / preload.cjs:173-187 同一口径）：
 *   · 只经 window.openarc.skill.command 发受控命令，只订阅 skill.onEvent；
 *   · 不 fetch、不直连本机端口、不读凭据、不写 localStorage；
 *   · sessionRef / userId / role 一律由主进程注入：界面**不发**这些字段，
 *     只发 { command, payload }（payload 里只有业务参数 + 请求内 requestId）。
 *
 * 后端形状（electron/skill-service.cjs:141-148 / :321-346）：
 *   成功 { ok:true, value:{...} }；失败 { ok:false, error, message, detail? }。
 *   value 里没有 api_key / credentialRef / 绝对路径（出口统一过 redactSkillValue）。
 *
 * 视觉：只用 primitives 组件与 tokens.css 既有 token；结构对齐 McpCenter.tsx
 * 的 split-side / split-main 信息密度（左侧分类导航在 main.tsx 保留）。
 * 八类状态的代码落点见文件末尾 STATE_BRANCHES。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  SearchField,
  TextField,
  ToastProvider,
  useToast,
} from "../design-system/primitives";
import { PageState } from "../design-system/page-states";
import { Dialog } from "../desktop/Dialog";
/* page-states.css 只被设计系统 gallery 引用过；PageState 是本页错误 / 空 / 加载态的
   唯一实现，这里按需引入它自己的样式表（不改任何既有类与 token）。 */
import "../design-system/page-states.css";
import {
  SKILL_DEPENDENCY_TEXT,
  SKILL_TAB_LABEL,
  classifyImportError,
  filterSkills,
  isAllowedSkillCommand,
  skillErrorState,
  skillErrorText,
  skillListState,
  skillProgressPhase,
  skillRunDisabledReason,
  skillRunFeedback,
  skillRunStatusFromPhase,
  skillsForTab,
} from "./skillCenterLogic";
import type {
  ImportFailureCategory,
  SkillPack,
  SkillRecord,
  SkillRunStatus,
  SkillTab,
} from "./skillCenterLogic";

/* ══════════════════════════════════════════════════════════════════════════
   桥与结果形状
   ══════════════════════════════════════════════════════════════════════════ */
type SkillBridge = {
  command: (cmd: Record<string, unknown>) => Promise<SkillResult>;
  onEvent?: (cb: (event: SkillEvent) => void) => () => void;
};
type SkillResult = Record<string, unknown> & { ok?: boolean };
type SkillEvent = {
  kind?: string;
  domain?: string;
  sequence?: number;
  at?: number;
  payload?: { command?: string; phase?: string; requestId?: string | null };
};

/** 只读访问：不改 window.openarc 的类型声明，也不扩大暴露面。 */
const getSkillBridge = (): SkillBridge | undefined => {
  if (typeof window === "undefined") return undefined;
  const root = (window as unknown as { openarc?: { skill?: SkillBridge } }).openarc;
  return root && root.skill ? root.skill : undefined;
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

const codeOf = (v: unknown): string => (typeof v === "string" && v ? v : "SKILL_INTERNAL");
const messageOf = (v: unknown): string => (typeof v === "string" ? v : "");

const timeText = (ts: unknown): string => {
  const n = Number(ts);
  if (ts == null || !Number.isFinite(n) || n <= 0) return "—";
  return new Date(n).toLocaleString("zh-CN", { hour12: false });
};

/** skill-service.cjs:141-148 的成功体是 { ok:true, value }；这里兼容平铺返回。 */
const valueOf = (res: SkillResult): Record<string, unknown> => (isObject(res.value) ? res.value : res);

const listOf = (res: SkillResult, ...keys: string[]): unknown[] => {
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

/** 本机文件 → base64。走用户选择的 File 对象，不碰绝对路径、不读凭据。 */
const toBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
};

const MAX_PACKAGE_BYTES = 32 * 1024 * 1024; // 对齐 skill-import.cjs:34

const inputSchemaSummary = (schema: unknown): string => {
  if (!isObject(schema)) return "—";
  const props = isObject(schema.properties) ? Object.keys(schema.properties) : [];
  const required = Array.isArray(schema.required) ? schema.required.map((v) => String(v)) : [];
  if (!props.length) return "—";
  return props.map((p) => (required.indexOf(p) >= 0 ? p + "*" : p)).join(", ");
};

const LAYER_LABEL: Record<string, string> = {
  preset: "预置 preset",
  workflow: "工作流 workflow",
  capability: "系统能力 capability",
};
const ORIGIN_LABEL: Record<string, string> = {
  official: "官方 official",
  system: "系统 system",
  user: "用户自建 user",
  imported: "导入 imported",
};
const EXPOSURE_LABEL: Record<string, string> = {
  internal: "内部 internal",
  slash: "斜杠调用 /技能ID",
};

const IMPORT_CATEGORY_LABEL: Record<ImportFailureCategory, string> = {
  zip: "ZIP 结构",
  size: "体积超限",
  path: "路径越界",
  format: "包格式",
  content: "包内容",
  permission: "权限",
  dependency: "依赖缺失",
  offline: "在线获取（已关闭）",
  unknown: "未登记原因",
};

/* ══════════════════════════════════════════════════════════════════════════
   页面
   ══════════════════════════════════════════════════════════════════════════ */
type Failure = { code: string; context: string };
type ListError = { code: string; context: string };
type Health = { status: string; dependencies: Record<string, unknown> };
type DetailState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "ready"; skill: SkillRecord }
  | { kind: "error"; code: string };
type RunState = {
  skillId: string;
  status: SkillRunStatus;
  requestId: string;
  startedAt: number;
  text?: string;
  errorCode?: string;
};
type ImportState = { status: "idle" | "reading" | "uploading" | "done" | "failed"; fileName?: string };
type ImportFailure = { category: ImportFailureCategory; label: string; detail: string };
type ConfirmState = { kind: "delete-skill" | "uninstall-pack"; id: string; name: string } | null;

const MISSING_DEP_LABEL: Record<string, string> = {
  chatTarget: "模型连接（providerAdapter）",
  modelCall: "模型调用（modelAdapter）",
  cliRuntime: "CLI 运行时",
  fsAdapter: "虚拟文件树",
  mediaAdapter: "媒体执行器",
  skillWorkspace: "多 Agent 工作空间",
};

export function SkillCenter({ tab, role }: { tab: SkillTab; role: string | null }) {
  return (
    <ToastProvider>
      <SkillCenterBody tab={tab} role={role} />
    </ToastProvider>
  );
}

function SkillCenterBody({ tab, role }: { tab: SkillTab; role: string | null }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const bridge = getSkillBridge();
  const available = typeof bridge?.command === "function";
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  /* 初值 true：首屏在 useEffect 发命令之前不先画一帧"还没有技能"（假空态）。 */
  const [loading, setLoading] = useState(true);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [listError, setListError] = useState<ListError | null>(null);
  const [packs, setPacks] = useState<SkillPack[]>([]);
  const [packsLoading, setPacksLoading] = useState(true);
  const [packsError, setPacksError] = useState<ListError | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [dependencyMissing, setDependencyMissing] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({ kind: "none" });
  const [query, setQuery] = useState("");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [lastPhase, setLastPhase] = useState<string | null>(null);
  const [importState, setImportState] = useState<ImportState>({ status: "idle" });
  const [importFailure, setImportFailure] = useState<ImportFailure | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);

  const runRef = useRef<{ requestId: string; skillId: string } | null>(null);

  const send = useCallback(
    async (command: string, payload: Record<string, unknown> = {}): Promise<SkillResult> => {
      // 白名单先在渲染层挡一次，与 skill-domain.cjs:79-81 同一条判据。
      if (!isAllowedSkillCommand(command)) {
        return { ok: false, error: "SKILL_COMMAND_NOT_ALLOWED", message: "命令不在白名单内" };
      }
      if (!bridge?.command) return { ok: false, error: "NO_BRIDGE" };
      try {
        const res = await bridge.command({ command, payload });
        return isObject(res) ? res : { ok: false, error: "RESPONSE_INCOMPLETE" };
      } catch {
        // 桥异常与后端异常一样收敛成可见错误码，不允许"点了没反应"。
        return { ok: false, error: "SKILL_INTERNAL" };
      }
    },
    [bridge],
  );

  const markDependency = (code: string) => {
    if (code === "SKILL_DEPENDENCY_UNAVAILABLE" || code === "SKILL_NOT_READY" || code === "NO_BRIDGE") {
      setDependencyMissing(skillErrorText(code));
    }
  };

  const loadHealth = useCallback(async () => {
    const res = await send("skill/health");
    if (res.ok !== true) {
      setHealth(null);
      return;
    }
    const v = valueOf(res);
    setHealth({
      status: asText(v.status, "unknown"),
      dependencies: isObject(v.dependencies) ? v.dependencies : {},
    });
  }, [send]);

  const loadList = useCallback(
    async (opts?: { silent?: boolean }): Promise<boolean> => {
      if (!opts?.silent) setLoading(true);
      const res = await send("skill/list");
      if (res.ok !== true) {
        const code = codeOf(res.error);
        setListError({ code, context: "读取技能列表" });
        markDependency(code);
        if (!opts?.silent) setLoading(false);
        return false;
      }
      const items = listOf(res, "items", "skills").filter(isObject) as unknown as SkillRecord[];
      setSkills(items);
      setListError(null);
      if (!opts?.silent) setLoading(false);
      return true;
    },
    [send],
  );

  const loadPacks = useCallback(
    async (opts?: { silent?: boolean }): Promise<boolean> => {
      if (!opts?.silent) setPacksLoading(true);
      const res = await send("skill/pack/list");
      if (res.ok !== true) {
        const code = codeOf(res.error);
        setPacksError({ code, context: "读取技能包列表" });
        markDependency(code);
        if (!opts?.silent) setPacksLoading(false);
        return false;
      }
      const items = listOf(res, "items", "packs").filter(isObject) as unknown as SkillPack[];
      setPacks(items);
      setPacksError(null);
      if (!opts?.silent) setPacksLoading(false);
      return true;
    },
    [send],
  );

  const loadDetail = useCallback(
    async (skillId: string) => {
      setSelectedId(skillId);
      setDetail({ kind: "loading" });
      const res = await send("skill/get", { skillId });
      if (res.ok !== true) {
        const code = codeOf(res.error);
        markDependency(code);
        setDetail({ kind: "error", code });
        return;
      }
      const v = valueOf(res);
      const skill = isObject(v.skill) ? (v.skill as unknown as SkillRecord) : null;
      setDetail(skill ? { kind: "ready", skill } : { kind: "error", code: "RESPONSE_INCOMPLETE" });
    },
    [send],
  );

  useEffect(() => {
    if (!available) {
      setLoading(false);
      setPacksLoading(false);
      setDependencyMissing(skillErrorText("NO_BRIDGE"));
      return;
    }
    void loadHealth();
    void loadList();
    void loadPacks();
    // 只在挂载时拉一次；后续由动作成功后显式刷新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available]);

  /* skill:event（P1 信封）：progress 的 begin/failed/rejected 直接驱动运行态；
     completed 只表示"命令返回了"，成功与否由命令结果决定，不提前标成功。 */
  useEffect(() => {
    if (!available || typeof bridge?.onEvent !== "function") return;
    const off = bridge.onEvent((event) => {
      const phase = skillProgressPhase(event);
      if (!phase) return;
      const payload = event.payload || {};
      if (payload.command !== "skill/run") return;
      const active = runRef.current;
      if (active && payload.requestId && payload.requestId !== active.requestId) return;
      setLastPhase(phase);
      const mapped = skillRunStatusFromPhase(phase);
      if (mapped === "running") setRun((cur) => (cur ? { ...cur, status: "running" } : cur));
      else if (mapped === "failed") setRun((cur) => (cur ? { ...cur, status: "failed" } : cur));
      else if (mapped === "unavailable")
        setRun((cur) => (cur ? { ...cur, status: "unavailable", errorCode: "SKILL_DEPENDENCY_UNAVAILABLE" } : cur));
    });
    return off;
  }, [available, bridge]);

  /* ── 动作 ─────────────────────────────────────────────────────────────── */

  const refreshAll = async () => {
    await Promise.all([loadList({ silent: true }), loadPacks({ silent: true })]);
  };

  const toggleEnabled = async (skill: SkillRecord) => {
    const command = skill.enabled === false ? "skill/enable" : "skill/disable";
    const context = skill.enabled === false ? "启用技能" : "停用技能";
    setBusy("toggle");
    setFailure(null);
    setNotice(null);
    const res = await send(command, { skillId: skill.id });
    setBusy(null);
    if (res.ok !== true) {
      const code = codeOf(res.error);
      markDependency(code);
      setFailure({ code, context });
      return;
    }
    setNotice(context + "已完成");
    await loadList({ silent: true });
    if (selectedId === skill.id) await loadDetail(skill.id);
  };

  const runSkill = async (skill: SkillRecord) => {
    const reason = skillRunDisabledReason(skill);
    if (reason) {
      setFailure({ code: "LOCAL_INPUT_REQUIRED", context: reason });
      return;
    }
    if (!instruction.trim()) {
      setRun({
        skillId: skill.id,
        status: "failed",
        requestId: "",
        startedAt: Date.now(),
        errorCode: "LOCAL_INPUT_REQUIRED",
      });
      return;
    }
    const requestId = requestIdFactory();
    runRef.current = { requestId, skillId: skill.id };
    setBusy("run");
    setFailure(null);
    setNotice(null);
    setLastPhase("begin");
    setRun({ skillId: skill.id, status: "running", requestId, startedAt: Date.now() });
    const res = await send("skill/run", {
      skillId: skill.id,
      arguments: { instruction },
      requestId,
    });
    runRef.current = null;
    setBusy(null);
    if (res.ok === true) {
      const v = valueOf(res);
      const text = typeof v.text === "string" ? v.text : "";
      setRun({ skillId: skill.id, status: "success", requestId, startedAt: Date.now(), text });
      toast({
        kind: "success",
        title: "技能执行完成",
        description: text ? text.slice(0, 120) : "主进程已返回结果。",
      });
      return;
    }
    const code = codeOf(res.error);
    markDependency(code);
    const status: SkillRunStatus = code === "SKILL_DEPENDENCY_UNAVAILABLE" ? "unavailable" : "failed";
    setRun({ skillId: skill.id, status, requestId, startedAt: Date.now(), errorCode: code });
    /* 失败通知常驻：错误不能只闪过几秒（DESIGN_SYSTEM §9 / MS §7）。 */
    toast({
      kind: "error",
      title: "技能执行失败",
      description: skillErrorText(code) + "（" + code + "）",
      duration: null,
    });
  };

  const exportSkill = async (skill: SkillRecord) => {
    setBusy("export");
    setFailure(null);
    const res = await send("skill/pack/export", { skillId: skill.id });
    setBusy(null);
    if (res.ok !== true) {
      const code = codeOf(res.error);
      markDependency(code);
      setFailure({ code, context: "导出技能" });
      return;
    }
    const v = valueOf(res);
    const fileName = asText(v.fileName, skill.id + ".zip");
    const base64 = typeof v.base64 === "string" ? v.base64 : "";
    setNotice("已生成导出包 " + fileName + "（" + asText(v.bytes, "?") + " 字节）");
    toast({ kind: "success", title: "导出完成", description: fileName });
    if (!base64) return;
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setFailure({ code: "DXOS_ERR_INTERNAL", context: "保存导出包" });
    }
  };

  const importPack = async (file: File | undefined) => {
    if (!file) return;
    const name = file.name || "skill-pack.zip";
    setImportFailure(null);
    setFailure(null);
    setNotice(null);
    setImportState({ status: "reading", fileName: name });
    if (file.size > MAX_PACKAGE_BYTES) {
      setImportState({ status: "failed", fileName: name });
      setImportFailure(classifyImportError({ code: "FILE_TOO_LARGE", message: "技能包超过 32 MB 上限" }));
      toast({ kind: "error", title: "技能包导入失败", description: "技能包超过 32 MB 上限", duration: null });
      return;
    }
    let base64 = "";
    try {
      base64 = toBase64(await file.arrayBuffer());
    } catch {
      setImportState({ status: "failed", fileName: name });
      setImportFailure(classifyImportError({ code: "DXOS_ERR_INTERNAL", message: "读取本机文件失败" }));
      return;
    }
    setImportState({ status: "uploading", fileName: name });
    setBusy("import");
    const res = await send("skill/pack/import", {
      archiveBase64: base64,
      sourceName: name,
      requestId: requestIdFactory(),
    });
    setBusy(null);
    if (res.ok !== true) {
      const code = codeOf(res.error);
      const message = messageOf(res.message);
      markDependency(code);
      setImportState({ status: "failed", fileName: name });
      setImportFailure(classifyImportError({ code, message }));
      toast({
        kind: "error",
        title: "技能包导入失败",
        description: message || skillErrorText(code),
        duration: null,
      });
      return;
    }
    const v = valueOf(res);
    const registered = Array.isArray(v.skills) ? v.skills.length : 0;
    setImportState({ status: "done", fileName: name });
    setNotice("已导入技能包「" + name + "」" + (registered ? "，注册 " + registered + " 个技能" : ""));
    toast({ kind: "success", title: "技能包导入完成", description: name });
    await refreshAll();
  };

  const confirmDelete = async () => {
    if (!confirm) return;
    const isPack = confirm.kind === "uninstall-pack";
    setBusy(isPack ? "uninstall" : "delete");
    setFailure(null);
    const res = isPack
      ? await send("skill/pack/uninstall", { packId: confirm.id })
      : await send("skill/delete", { skillId: confirm.id });
    setBusy(null);
    const context = isPack ? "卸载技能包" : "删除技能";
    setConfirm(null);
    if (res.ok !== true) {
      const code = codeOf(res.error);
      markDependency(code);
      setFailure({ code, context });
      return;
    }
    setNotice(context + "已完成");
    if (!isPack && selectedId === confirm.id) {
      setSelectedId(null);
      setDetail({ kind: "none" });
      setRun(null);
    }
    await refreshAll();
  };

  /* ── 派生 ─────────────────────────────────────────────────────────────── */

  const tabSkills = skillsForTab(tab, skills);
  const rawItems: Array<SkillRecord | SkillPack> = tab === "market" ? packs : tabSkills;
  const filteredSkills = tab === "market" ? [] : filterSkills(tabSkills, query);
  const filteredPacks = packs.filter((p) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return ((asText(p.name, p.id) + " " + asText(p.sourceName, "")).toLowerCase().indexOf(q) >= 0);
  });
  const filteredItems: Array<SkillRecord | SkillPack> = tab === "market" ? filteredPacks : filteredSkills;
  const sourceLoading = tab === "market" ? packsLoading : loading;
  const sourceError = tab === "market" ? packsError : listError;
  const state = skillListState({
    loading: sourceLoading,
    errorCode: sourceError ? sourceError.code : null,
    dependencyUnavailable: !!dependencyMissing,
    count: rawItems.length,
  });
  const searchEmpty = state === "ready" && filteredItems.length === 0 && query.trim() !== "";
  const selectedSkill =
    detail.kind === "ready" ? detail.skill : skills.find((s) => s.id === selectedId) || null;

  const missingDeps: string[] = [];
  if (health) {
    for (const key of ["chatTarget", "modelCall", "cliRuntime", "fsAdapter", "mediaAdapter"]) {
      if (health.dependencies[key] === false) missingDeps.push(MISSING_DEP_LABEL[key] || key);
    }
  }
  const healthNote = health
    ? "运行依赖：" +
      (missingDeps.length ? "未接入 " + missingDeps.join("、") : "已接入可运行的部分") +
      (health.status === "degraded" ? "；多 Agent 工作空间未接入（degraded）" : "")
    : null;

  const runFeedback = skillRunFeedback(run ? run.status : "idle");
  const activeRun = run && (!selectedSkill || run.skillId === selectedSkill.id) ? run : null;

  /* ── 渲染 ─────────────────────────────────────────────────────────────── */

  const header = (
    <header className="skill-banner">
      <div className="skill-banner__row">
        <h1 className="skill-banner__title">Skill 中心 · {SKILL_TAB_LABEL[tab]}</h1>
        <span className="skill-muted">本地技能与技能包；不联网、不显示模拟数据</span>
      </div>
      {failure ? (
        <p className="skill-error" role="alert" data-skill-error data-skill-error-code={failure.code}>
          {failure.context}未完成：{skillErrorText(failure.code)}（{failure.code}）
        </p>
      ) : null}
      {notice ? (
        <p className="skill-notice" role="status" data-skill-notice>
          {notice}
        </p>
      ) : null}
      {dependencyMissing ? (
        <p className="skill-warn" role="status" data-skill-dependency>
          {SKILL_DEPENDENCY_TEXT}
        </p>
      ) : null}
      {healthNote ? (
        <p className="skill-muted" data-skill-health>
          {healthNote}
        </p>
      ) : null}
    </header>
  );

  const importPanel = (
    <div className="skill-import" data-skill-import-state={importState.status}>
      <div className="skill-import__row">
        <Button
          variant="secondary"
          size="sm"
          data-skill-action="import"
          status={busy === "import" ? "loading" : "idle"}
          disabled={!available || busy === "import"}
          onClick={() => fileRef.current?.click()}
        >
          从本机 ZIP 导入
        </Button>
        <Button
          variant="ghost"
          size="sm"
          data-skill-action="refresh"
          disabled={busy !== null}
          onClick={() => void refreshAll()}
        >
          刷新
        </Button>
        <span className="skill-muted" data-skill-import-progress>
          {importState.status === "reading"
            ? "正在读取本机文件…"
            : importState.status === "uploading"
              ? "正在导入 " + (importState.fileName || "") + "…"
              : importState.status === "done"
                ? "已导入 " + (importState.fileName || "")
                : "只接受标准 ZIP；在线获取在本版本关闭"}
        </span>
      </div>
      {importFailure ? (
        <p
          className="skill-error"
          role="alert"
          data-skill-import-error
          data-skill-import-category={importFailure.category}
        >
          导入失败（{IMPORT_CATEGORY_LABEL[importFailure.category]}）：{importFailure.label}
          {importFailure.detail ? "　" + importFailure.detail : ""}
        </p>
      ) : null}
      <input
        ref={fileRef}
        type="file"
        accept=".zip,application/zip"
        className="skill-file-input"
        aria-label="选择技能包 ZIP"
        data-skill-file-input
        onChange={(e) => {
          const file = e.target.files && e.target.files[0] ? e.target.files[0] : undefined;
          e.target.value = "";
          void importPack(file);
        }}
      />
    </div>
  );

  const listPane = (
    <section className="skill-list-pane" aria-label={tab === "market" ? "技能包列表" : "技能列表"}>
      <div className="skill-pane-head">
        <h2 className="skill-pane-title">
          {tab === "market" ? "技能包" : tab === "mine" ? "我的技能" : "已安装"}
        </h2>
        <span className="skill-muted" data-skill-count>
          {filteredItems.length} / {rawItems.length}
        </span>
      </div>
      {tab === "market" ? importPanel : null}
      {tab === "market" ? null : (
        <SearchField
          value={query}
          onValueChange={setQuery}
          placeholder="搜索技能"
          label="搜索技能"
          data-skill-search
        />
      )}
      <ul className="skill-list" data-skill-list>
        {tab === "market"
          ? filteredPacks.map((pack) => (
                <li key={pack.id}>
                  <div className="skill-row skill-row--pack" data-skill-pack={pack.id}>
                    <span className="skill-row__top">
                      <strong data-skill-pack-name>{asText(pack.name, pack.id)}</strong>
                      <Badge tone="neutral" className="skill-status">
                        {asText(pack.skillCount, "0")} 个技能
                      </Badge>
                    </span>
                    <span className="skill-row__facts">
                      <span>导入时间 {timeText(pack.importedAt)}</span>
                      <span>来源 {asText(pack.sourceName, "—")}</span>
                      <span>入口 {(pack.entryPoints || []).length} 个</span>
                      <span>文档 {(pack.skillDocs || []).length} 份</span>
                    </span>
                    <span className="skill-row__actions">
                      <Button
                        variant="danger"
                        size="sm"
                        data-skill-pack-action="uninstall"
                        disabled={busy !== null}
                        onClick={() => setConfirm({ kind: "uninstall-pack", id: pack.id, name: asText(pack.name, pack.id) })}
                      >
                        卸载
                      </Button>
                    </span>
                  </div>
                </li>
              ))
          : filteredSkills.map((skill) => {
              const enabled = skill.enabled !== false;
              return (
                <li key={skill.id}>
                  <button
                    type="button"
                    className="skill-row"
                    data-skill-id={skill.id}
                    data-skill-enabled={enabled ? "true" : "false"}
                    data-skill-builtin={skill.builtin ? "true" : "false"}
                    aria-pressed={skill.id === selectedId}
                    onClick={() => void loadDetail(skill.id)}
                  >
                    <span className="skill-row__top">
                      <strong data-skill-name>{asText(skill.name, skill.id)}</strong>
                      <Badge tone={enabled ? "neutral" : "warning"} className="skill-status">
                        {enabled ? "已启用" : "已停用"}
                      </Badge>
                    </span>
                    <span className="skill-row__facts">
                      <span data-skill-kind>{asText(skill.kind, "文本")}</span>
                      <span data-skill-layer>{LAYER_LABEL[skill.layer || ""] || asText(skill.layer, "未分层")}</span>
                      <span data-skill-origin>{ORIGIN_LABEL[skill.origin || ""] || asText(skill.origin, "未知来源")}</span>
                      {skill.source && skill.source.metadata && skill.source.metadata.packName ? (
                        <span data-skill-pack-name>包 {skill.source.metadata.packName}</span>
                      ) : null}
                    </span>
                    <span className="skill-row__desc" data-skill-desc>
                      {asText(skill.description, "（没有说明）")}
                    </span>
                  </button>
                </li>
              );
            })}
      </ul>
      {role !== "ADMIN" ? (
        <p className="skill-muted" data-skill-role-note>
          权限口径：本地技能目录按账号隔离，团队技能包由管理员安装；被拒绝的动作会显示稳定错误码。
        </p>
      ) : null}
    </section>
  );

  const detailPane = (
    <section className="skill-detail-pane" aria-label="技能详情" data-skill-detail-state={detail.kind}>
      {detail.kind === "none" ? (
        <PageState
          kind="empty"
          title="选择一个技能"
          description="左侧选中的技能会显示来源、分层、执行说明、工作流步骤与运行入口。"
        />
      ) : null}
      {detail.kind === "loading" ? <PageState kind="loading" title="正在读取技能详情…" /> : null}
      {detail.kind === "error" ? (
        <PageState
          kind={skillErrorState(detail.code)}
          title={"读取技能详情失败：" + skillErrorText(detail.code)}
          description={"后端返回的稳定错误码是 " + detail.code + "。"}
          onAction={selectedId ? () => void loadDetail(selectedId) : undefined}
        />
      ) : null}
      {detail.kind === "ready" ? (
        <div className="skill-detail" key={detail.skill.id} data-skill-detail>
          <header className="skill-detail__head">
            <div className="skill-detail__title">
              <h3 data-skill-detail-name>{asText(detail.skill.name, detail.skill.id)}</h3>
              <Badge
                tone={detail.skill.enabled === false ? "warning" : "neutral"}
                className="skill-status"
              >
                {detail.skill.enabled === false ? "已停用" : "已启用"}
              </Badge>
            </div>
            <div className="skill-detail__facts">
              <span data-skill-detail-id>ID {detail.skill.id}</span>
              <span>{LAYER_LABEL[detail.skill.layer || ""] || asText(detail.skill.layer, "未分层")}</span>
              <span>{ORIGIN_LABEL[detail.skill.origin || ""] || asText(detail.skill.origin, "未知来源")}</span>
              <span>{detail.skill.builtin ? "内置技能（只能停用）" : "自定义技能（可删除）"}</span>
            </div>
            <div className="skill-actions">
              <Button
                variant="secondary"
                size="sm"
                data-skill-action="toggle"
                status={busy === "toggle" ? "loading" : "idle"}
                disabled={busy !== null}
                onClick={() => void toggleEnabled(detail.skill)}
              >
                {detail.skill.enabled === false ? "启用" : "停用"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-skill-action="export"
                status={busy === "export" ? "loading" : "idle"}
                disabled={busy !== null}
                onClick={() => void exportSkill(detail.skill)}
              >
                导出 ZIP
              </Button>
              <Button
                variant="danger"
                size="sm"
                data-skill-action="delete"
                disabled={busy !== null || detail.skill.builtin === true}
                title={detail.skill.builtin ? "内置技能不能删除，只能停用" : undefined}
                onClick={() =>
                  setConfirm({
                    kind: "delete-skill",
                    id: detail.skill.id,
                    name: asText(detail.skill.name, detail.skill.id),
                  })
                }
              >
                删除
              </Button>
            </div>
            {detail.skill.builtin ? (
              <p className="skill-muted" data-skill-note="builtin">
                内置技能不能删除，只能停用；停用后不会进入新的任务。
              </p>
            ) : null}
            {detail.skill.enabled === false ? (
              <p className="skill-warn" data-skill-note="disabled">
                技能已停用：先启用，再运行 —— 技能执行器对停用技能直接拒绝（skill-runner.cjs:1632）。
              </p>
            ) : null}
          </header>

          <section className="skill-section" aria-label="运行">
            <div className="skill-section-head">
              <h4>运行</h4>
              <span className="skill-muted">真实模型调用；参数与产物由执行器返回</span>
            </div>
            <TextField
              label="输入"
              hint="作为 instruction 传给技能执行器；界面不发送身份、凭据或会话字段。"
              data-skill-field="instruction"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              error={
                activeRun && activeRun.errorCode === "LOCAL_INPUT_REQUIRED" ? "输入不能为空" : undefined
              }
            />
            <div className="skill-actions">
              <Button
                variant="primary"
                size="sm"
                data-skill-action="run"
                status={busy === "run" ? "loading" : "idle"}
                disabled={busy !== null || !!skillRunDisabledReason(detail.skill)}
                onClick={() => void runSkill(detail.skill)}
              >
                运行
              </Button>
              {skillRunDisabledReason(detail.skill) ? (
                <span className="skill-muted" data-skill-run-disabled-reason>
                  {skillRunDisabledReason(detail.skill)}
                </span>
              ) : null}
            </div>
            {activeRun ? (
              <div className="skill-run" data-skill-run data-skill-run-state={activeRun.status}>
                <div className="skill-run__head">
                  <Badge tone={runFeedback.tone} className="skill-status">
                    {runFeedback.label}
                  </Badge>
                  <span className="skill-muted">{runFeedback.detail}</span>
                  {runFeedback.active ? <span className="ds-spinner" aria-hidden="true" /> : null}
                </div>
                {activeRun.text ? (
                  <p className="skill-run__text" data-skill-run-text>
                    {activeRun.text}
                  </p>
                ) : null}
                {activeRun.errorCode ? (
                  <p className="skill-error" role="alert" data-skill-run-error data-skill-error-code={activeRun.errorCode}>
                    {skillErrorText(activeRun.errorCode)}（{activeRun.errorCode}）
                  </p>
                ) : null}
                <span className="skill-muted" data-skill-run-events>
                  最近 progress 事件：{lastPhase || "尚未收到"}
                </span>
              </div>
            ) : null}
          </section>

          <section className="skill-section" aria-label="基本信息">
            <h4>基本信息</h4>
            <dl className="skill-kv" data-skill-config>
              <dt>ID</dt>
              <dd className="skill-mono">{detail.skill.id}</dd>
              <dt>类型</dt>
              <dd>{asText(detail.skill.kind, "文本")}</dd>
              <dt>分层</dt>
              <dd>{LAYER_LABEL[detail.skill.layer || ""] || asText(detail.skill.layer, "未分层")}</dd>
              <dt>来源</dt>
              <dd>{ORIGIN_LABEL[detail.skill.origin || ""] || asText(detail.skill.origin, "未知来源")}</dd>
              <dt>调用方式</dt>
              <dd>{EXPOSURE_LABEL[detail.skill.exposure || ""] || asText(detail.skill.exposure, "未知")}</dd>
              <dt>输入参数</dt>
              <dd className="skill-mono" data-skill-input-schema>
                {inputSchemaSummary(detail.skill.inputSchema)}
              </dd>
              <dt>启用</dt>
              <dd>{detail.skill.enabled === false ? "已停用" : "已启用"}</dd>
            </dl>
          </section>

          <section className="skill-section" aria-label="执行说明">
            <h4>执行说明</h4>
            <p className="skill-muted">
              来源：{detail.skill.source && detail.skill.source.format ? detail.skill.source.format : "内置技能目录"}
              {detail.skill.source && detail.skill.source.metadata && detail.skill.source.metadata.displayOverride
                ? "（显示名被本地改写过）"
                : ""}
            </p>
            <div data-skill-instructions>
              <pre className="skill-pre">
                {asText(
                  (detail.skill.source && detail.skill.source.instructions) || detail.skill.systemPrompt,
                  "（没有可显示的执行说明）",
                )}
              </pre>
            </div>
          </section>

          {detail.skill.v2 && detail.skill.v2.steps && detail.skill.v2.steps.length ? (
            <section className="skill-section" aria-label="工作流步骤">
              <div className="skill-section-head">
                <h4>工作流步骤</h4>
                <span className="skill-muted">
                  v{asText(detail.skill.v2.version, "?")}
                  {detail.skill.v2.sourceName ? " · " + detail.skill.v2.sourceName : ""}
                </span>
              </div>
              <ol className="skill-steps" data-skill-steps>
                {detail.skill.v2.steps.map((step, i) => (
                  <li key={i} data-skill-step={i}>
                    <span className="skill-step__title">{asText(step.title, "步骤 " + (i + 1))}</span>
                    {step.detail ? <span className="skill-muted">{step.detail}</span> : null}
                    {step.uses ? <span className="skill-muted">使用：{step.uses}</span> : null}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {detail.skill.source && detail.skill.source.files && detail.skill.source.files.length ? (
            <section className="skill-section" aria-label="资源文件">
              <h4>资源文件</h4>
              <ul className="skill-files" data-skill-files>
                {detail.skill.source.files.map((file, i) => (
                  <li key={i} className="skill-mono">
                    {asText(file.path, "（未命名）")}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {detail.skill.v2 && (detail.skill.v2.triggers || detail.skill.v2.checks || detail.skill.v2.permissions) ? (
            <section className="skill-section" aria-label="触发与校验">
              <h4>触发与校验</h4>
              {detail.skill.v2.triggers && detail.skill.v2.triggers.length ? (
                <p className="skill-muted">触发：{detail.skill.v2.triggers.join("、")}</p>
              ) : null}
              {detail.skill.v2.checks && detail.skill.v2.checks.length ? (
                <p className="skill-muted">自检：{detail.skill.v2.checks.join("、")}</p>
              ) : null}
              {detail.skill.v2.permissions ? (
                <p className="skill-muted" data-skill-permissions>
                  权限声明：读文件 {detail.skill.v2.permissions.readsFiles ? "是" : "否"} · 写文件{" "}
                  {detail.skill.v2.permissions.writesFiles ? "是" : "否"} · 网络{" "}
                  {detail.skill.v2.permissions.network ? "是" : "否"} · 敏感数据{" "}
                  {detail.skill.v2.permissions.sensitive ? "是" : "否"}
                </p>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </section>
  );

  const body =
    state === "loading" ? (
      <PageState kind="loading" title="正在读取技能目录…" />
    ) : state === "unavailable" ? (
      <div className="skill-state-block" data-skill-empty="unavailable">
        <PageState
          kind="unavailable"
          title="技能依赖不可用"
          description={SKILL_DEPENDENCY_TEXT}
        />
        <Button variant="secondary" data-skill-action="recheck" onClick={() => void refreshAll()}>
          重新检查
        </Button>
      </div>
    ) : state === "error" ? (
      <div className="skill-state-block" data-skill-empty="error">
        <PageState
          kind={skillErrorState(sourceError ? sourceError.code : "SKILL_INTERNAL")}
          title="读取技能目录失败"
          description={
            (sourceError ? sourceError.context + "。" : "") +
            "目录是后端按权限过滤后的真实结果，这里不展示缓存或模拟数据。"
          }
          onAction={() => void refreshAll()}
        />
      </div>
    ) : state === "empty" ? (
      <div className="skill-state-block" data-skill-empty="empty">
        <PageState
          kind="empty"
          title={tab === "market" ? "还没有技能包" : tab === "mine" ? "还没有自定义技能" : "还没有可用技能"}
          description={
            tab === "market"
              ? "技能包用于把一批 SKILL.md 一次装进来。本版本只支持从本机 ZIP 导入，联网市场与在线安装已关闭。"
              : "自定义技能与导入的技能会出现在这里；导入技能包后会自动注册。"
          }
        />
        {tab === "market" ? (
          <div className="skill-import" data-skill-import-state={importState.status}>
            <Button
              variant="secondary"
              data-skill-action="import"
              status={busy === "import" ? "loading" : "idle"}
              disabled={!available || busy === "import"}
              onClick={() => fileRef.current?.click()}
            >
              从本机 ZIP 导入
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              className="skill-file-input"
              aria-label="选择技能包 ZIP"
              data-skill-file-input
              onChange={(e) => {
                const file = e.target.files && e.target.files[0] ? e.target.files[0] : undefined;
                e.target.value = "";
                void importPack(file);
              }}
            />
          </div>
        ) : (
          <Button variant="secondary" data-skill-action="refresh-empty" onClick={() => void refreshAll()}>
            重新读取
          </Button>
        )}
      </div>
    ) : searchEmpty ? (
      <div className="skill-state-block" data-skill-empty="search">
        <PageState kind="empty" title="没有匹配的技能" description="清除搜索词可以恢复完整列表。" />
        <Button variant="secondary" data-skill-action="clear-search" onClick={() => setQuery("")}>
          清除搜索
        </Button>
      </div>
    ) : (
      <div className="skill-split">
        {listPane}
        {tab === "market" ? detailPaneMarket(packs) : detailPane}
      </div>
    );

  const dialogs = (
    <Dialog
      open={confirm !== null}
      title={confirm && confirm.kind === "uninstall-pack" ? "卸载技能包" : "删除技能"}
      onClose={() => setConfirm(null)}
      footer={
        <>
          <Button variant="ghost" onClick={() => setConfirm(null)}>
            取消
          </Button>
          <Button
            variant="danger"
            data-skill-submit="confirm"
            status={busy === "delete" || busy === "uninstall" ? "loading" : "idle"}
            onClick={() => void confirmDelete()}
          >
            {confirm && confirm.kind === "uninstall-pack" ? "卸载" : "删除"}
          </Button>
        </>
      }
    >
      <div data-skill-confirm={confirm ? confirm.kind : "none"}>
        {confirm && confirm.kind === "uninstall-pack" ? (
          <>
            <p>将卸载技能包「{confirm.name}」并清理它注册的技能与工作空间资料。</p>
            <p className="skill-muted">卸载后不可恢复；包目录与索引记录都会被删除。</p>
          </>
        ) : (
          <>
            <p>将删除技能「{confirm ? confirm.name : ""}」。</p>
            <p className="skill-muted">内置技能不能删除，只能停用。删除后不可恢复。</p>
          </>
        )}
      </div>
    </Dialog>
  );

  return (
    <div
      ref={rootRef}
      className="skill-center"
      data-skill-center="1"
      data-skill-tab={tab}
      data-skill-available={available ? "true" : "false"}
      data-skill-role={role || "NONE"}
      data-skill-list-state={state}
    >
      {header}
      {body}
      {dialogs}
    </div>
  );
}

/** 市场页的详情区：技能包没有实例详情，改为说明"包内技能去『已安装』看"。 */
function detailPaneMarket(packs: SkillPack[]) {
  return (
    <section className="skill-detail-pane" aria-label="技能包说明" data-skill-detail-state="market">
      <div className="skill-detail" data-skill-market-note>
        <h3>技能包（本机导入）</h3>
        <p className="skill-muted">
          技能包把一批 SKILL.md 与资源一起装进来；安装后包内技能会在「已安装」分类出现并可启停、运行。
          联网市场与在线安装在 OUT 范围内已关闭，这里只从本机 ZIP 导入。
        </p>
        <p className="skill-muted" data-skill-pack-total>
          当前已安装 {packs.length} 个技能包。
        </p>
      </div>
    </section>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   STATE_BRANCHES —— UI-1「八类状态」在代码里的确切落点（供评审逐条对照）

   1 加载中       state === "loading"（skillListState：sourceLoading && count === 0）
                  → <PageState kind="loading">，data-skill-list-state="loading"
   2 空           state === "empty"（无技能 / 无技能包）；搜索无结果为 data-skill-empty="search"
                  → <PageState kind="empty"> + 分类对应的下一步入口（导入 / 重新读取）
   3 错误         state === "error"（sourceError 且 count === 0）
                  → <PageState kind={skillErrorState(code)}>：SKILL_COMMAND_NOT_ALLOWED 等落 "error"，
                    SKILL_UNAUTHENTICATED / SESSION_* 落 "unauthorized"，data-skill-error-code 带原始码
   3b 依赖缺失     dependencyMissing 非空（SKILL_DEPENDENCY_UNAVAILABLE / SKILL_NOT_READY / NO_BRIDGE）
                  → state === "unavailable" + <PageState kind="unavailable">
                    + data-skill-dependency（SKILL_DEPENDENCY_TEXT 明确说明"没有执行、没有产物"）
   4 就绪         state === "ready" → .skill-split（列表 + 详情），列表头信息密度对齐 McpCenter
   5 运行中       activeRun.status ∈ queued/running（skill/run 进行态）
                  → .skill-run[data-skill-run-state]，统一状态反馈 + ds-spinner；progress 事件驱动
   6 禁用态       行 data-skill-enabled="false" + Badge「已停用」；详情 note=disabled，
                  运行按钮 disabled + data-skill-run-disabled-reason（含技能已停用 / 系统能力 / 媒体技能）
   7 导入中/失败   data-skill-import-state ∈ reading/uploading/failed/done；
                  失败按 classifyImportError 分类（ZIP / 体积 / 路径越界 / 格式 / 内容 / 权限 / 依赖 / 在线）
                  → data-skill-import-error + data-skill-import-category
   8 容器窄宽     @container (max-width: 900px) 下 .skill-split 改单列（styles.css 追加块），
                  minmax(0,*) + overflow-wrap 保证不溢出
   ══════════════════════════════════════════════════════════════════════════ */
