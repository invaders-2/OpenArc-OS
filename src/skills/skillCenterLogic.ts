/**
 * UI-1 · Skill 中心：纯逻辑层（无 React / 无 DOM / 无 I/O）。
 *
 * 为什么单独拆一层：状态映射、命令白名单、错误码→文案、导入失败分类都是**可离线断言**的
 * 规则，界面上三个入口（列表 / 详情 / 运行）共用同一份判断。把它们留在 .tsx 里就没法在
 * 不启动浏览器的情况下测；放在这里，tests/dxos-skill-center.test.mjs 直接 import 真逻辑。
 *
 * 边界（与 electron/skill-domain.cjs 同口径，界面层不做第二套）：
 *   · 命令白名单逐条对齐 electron/skill-domain.cjs:51-74 的 SKILL_COMMANDS；
 *   · 错误码逐条对齐 electron/skill-domain.cjs:24-42 的 SKILL_ERROR_CODES，
 *     并补充 IPC 出口实际会出现的 DXOS_* 与渲染层事实位（skill-service.cjs:127-148）；
 *   · 导入失败原因对齐 electron/skill-import.cjs:43-48 与 electron/skill-pack.cjs:77-82
 *     —— 注意：这两个 fail() 只把 reason 挂在 Error 上，dxos-foundation-errors.cjs:94-104
 *     的最后一步**不会**把 reason 搬到 IPC 结果里，渲染层只拿得到 { code, message }，
 *     所以分类以文本特征为主、错误码为辅，不假装能拿到 reason。
 */

/* ══════════════════════════════════════════════════════════════════════════
   分类导航（UI-PLAN UI-1：保留 市场 / 我的技能 / 已安装 三分类）
   ══════════════════════════════════════════════════════════════════════════ */
export type SkillTab = "market" | "mine" | "installed";

export const SKILL_TABS: readonly SkillTab[] = ["market", "mine", "installed"];

export const SKILL_TAB_LABEL: Record<SkillTab, string> = {
  market: "技能包（本机导入）",
  mine: "我的技能",
  installed: "已安装",
};

/* ══════════════════════════════════════════════════════════════════════════
   命令白名单 —— 界面**只能**发这些命令（skill:command 的后端白名单）
   ══════════════════════════════════════════════════════════════════════════ */
export const SKILL_COMMANDS: readonly string[] = [
  "skill/list",
  "skill/get",
  "skill/enable",
  "skill/disable",
  "skill/save",
  "skill/delete",
  "skill/run",
  "skill/analyze",
  "skill/pack/list",
  "skill/pack/install",
  "skill/pack/import",
  "skill/pack/export",
  "skill/pack/uninstall",
  "skill/workspace/list",
  "skill/health",
];

/** 未登记命令一律拒绝（不猜、不透传），与 skill-domain.cjs:79-81 同一条判据。 */
export function isAllowedSkillCommand(command: unknown): command is string {
  return typeof command === "string" && SKILL_COMMANDS.indexOf(command) >= 0;
}

/* ══════════════════════════════════════════════════════════════════════════
   记录形状（渲染层只读投影；字段来源 electron/skill-store.cjs:145-153）
   ══════════════════════════════════════════════════════════════════════════ */
export type SkillSourceFile = { path?: string; content?: string };
export type SkillV2Step = { title?: string; detail?: string; uses?: string };
export type SkillV2 = {
  version?: number;
  triggers?: string[];
  inputs?: string[];
  steps?: SkillV2Step[];
  allowedTools?: string[];
  output?: string;
  checks?: string[];
  sourceName?: string;
  analyzedAt?: number;
  permissions?: {
    readsFiles?: boolean;
    writesFiles?: boolean;
    network?: boolean;
    sensitive?: boolean;
  };
  resources?: { name?: string; content?: string }[];
};
export type SkillRecord = {
  id: string;
  name?: string;
  description?: string;
  kind?: string;
  builtin?: boolean;
  layer?: string;
  origin?: string;
  exposure?: string;
  visibleInApp?: boolean;
  enabled?: boolean;
  systemPrompt?: string;
  inputSchema?: unknown;
  source?: {
    format?: string;
    sourcePath?: string;
    instructions?: string;
    files?: SkillSourceFile[];
    metadata?: { packId?: string; packName?: string; displayOverride?: boolean };
  };
  v2?: SkillV2;
};
export type SkillPack = {
  id: string;
  name?: string;
  sourceName?: string;
  importedAt?: number;
  skillCount?: number;
  entryPoints?: { id?: string; runtime?: string; path?: string }[];
  kind?: string;
  skillDocs?: { path?: string; title?: string }[];
};

/* ══════════════════════════════════════════════════════════════════════════
   状态映射（UI-1 八类状态里的「加载 / 空 / 错误 / 就绪 / 依赖缺失」）
   ══════════════════════════════════════════════════════════════════════════ */
export type SkillPageStateKind =
  | "loading"
  | "empty"
  | "error"
  | "unavailable"
  | "partial-result"
  | "unauthorized";

/** 运行时可枚举的版本（测试据此断言不新增第八种状态）。 */
export const SKILL_PAGE_STATE_KINDS: readonly SkillPageStateKind[] = [
  "loading",
  "empty",
  "error",
  "unavailable",
  "partial-result",
  "unauthorized",
];

/**
 * 页面状态判定的**优先级**（顺序即规则）：
 *   1 依赖缺失   —— 环境事实，先于一切数据态（skill-service.cjs:44-49 的规约）
 *   2 错误且无数据
 *   3 首屏加载且无数据（真加载态；有缓存数据时走局部刷新，不整页盖住）
 *   4 空且无数据
 *   5 就绪
 * 与 McpCenter.tsx:325-334 同一口径：初值为 loading，避免先画一帧假空态。
 */
export function skillListState(v: {
  loading: boolean;
  errorCode: string | null;
  dependencyUnavailable: boolean;
  count: number;
}): SkillPageStateKind | "ready" {
  if (v.dependencyUnavailable) return "unavailable";
  if (v.errorCode && v.count === 0) return "error";
  if (v.loading && v.count === 0) return "loading";
  if (v.count === 0) return "empty";
  return "ready";
}

/* ══════════════════════════════════════════════════════════════════════════
   错误码 → 人话 + 对应 PageState
   ══════════════════════════════════════════════════════════════════════════ */
export const SKILL_ERROR_TEXT: Record<string, string> = {
  /* electron/skill-domain.cjs:24-31 的技能域自有码 */
  SKILL_COMMAND_NOT_ALLOWED: "命令不在 skill:command 白名单内，界面不会发送未登记的命令",
  SKILL_INVALID_INPUT: "输入不完整或不符合要求",
  SKILL_UNAUTHENTICATED: "当前会话未认证，技能命令被拒绝；重新登录后再试",
  SKILL_FORBIDDEN: "当前账号或该应用没有被授这个动作",
  SKILL_NOT_FOUND: "该技能或技能包不存在，可能已被删除",
  SKILL_CONFLICT: "与已有技能冲突（例如同一 ID 被两个技能占用）",
  /* 依赖缺失必须在界面上说清楚：技能没执行，也没有产物 */
  SKILL_DEPENDENCY_UNAVAILABLE:
    "缺少执行该技能所需的依赖（模型连接、CLI 运行时或虚拟文件树）。技能没有执行，也没有产生任何产物；接入依赖后可以重试。",
  SKILL_INTERNAL: "技能域内部错误，操作未完成",
  /* electron/skill-bootstrap.cjs:15 —— 技能域未装配时的稳定码 */
  SKILL_NOT_READY: "技能域尚未装配（当前环境没有可用的技能服务）",
  /* electron/dxos-foundation-errors.cjs:12-26 —— IPC 出口的实际失败码 */
  DXOS_ERR_INTERNAL: "主进程返回异常，技能操作未完成",
  DXOS_ERR_INVALID_INPUT: "输入被拒绝。技能包导入失败时请检查这里列出的原因",
  DXOS_ERR_NOT_FOUND: "目标不存在，可能已被删除",
  DXOS_ERR_CONFLICT: "与当前状态冲突，请刷新后重试",
  DXOS_ERR_FORBIDDEN: "当前账号没有权限完成这个动作",
  DXOS_ERR_UNAVAILABLE: "当前环境不支持这个能力",
  DXOS_ERR_DEPENDENCY_MISSING: "缺少依赖：技能没有执行，产物也没有生成",
  DXOS_ERR_TIMEOUT: "操作超时，技能可能仍在后台执行，请稍后刷新查看",
  DXOS_ERR_CANCELLED: "操作已取消",
  DXOS_ERR_QUOTA_EXCEEDED: "已超出当前配额",
  DXOS_ERR_UNSUPPORTED: "该能力在本地版本中关闭",
  /* 渲染层自己的事实位（前缀刻意与后端码区分，避免被当成后端码） */
  NO_BRIDGE: "桌面桥未接入（当前环境没有技能域）",
  RESPONSE_INCOMPLETE: "主进程返回的记录不完整，界面不猜内容",
  SESSION_EXPIRED: "会话已过期，请重新登录",
  SESSION_REVOKED: "会话已失效，请重新登录",
  LOCAL_INPUT_REQUIRED: "缺少必填内容（界面上先行拦截，没有发给后端）",
  FILE_TOO_LARGE: "技能包超过 32 MB 上限，界面在读取前就拒绝",
};

/** 未登记的码也给出可读兜底，并把原始码显示出来（不塌缩成"未知错误"）。 */
export function skillErrorText(code: string): string {
  return SKILL_ERROR_TEXT[code] || "技能操作失败";
}

const UNAUTHORIZED_CODES: readonly string[] = [
  "SKILL_UNAUTHENTICATED",
  "SKILL_FORBIDDEN",
  "DXOS_ERR_FORBIDDEN",
  "SESSION_EXPIRED",
  "SESSION_REVOKED",
];

const UNAVAILABLE_CODES: readonly string[] = [
  "SKILL_DEPENDENCY_UNAVAILABLE",
  "SKILL_NOT_READY",
  "NO_BRIDGE",
  "DXOS_ERR_DEPENDENCY_MISSING",
  "DXOS_ERR_UNAVAILABLE",
  "DXOS_ERR_UNSUPPORTED",
];

/** 失败码 → PageState kind（只返回 page-states.tsx 已登记的 kind）。 */
export function skillErrorState(code: string): SkillPageStateKind {
  if (UNAUTHORIZED_CODES.indexOf(code) >= 0) return "unauthorized";
  if (UNAVAILABLE_CODES.indexOf(code) >= 0) return "unavailable";
  return "error";
}

/** 依赖缺失的显式文案（UI-1 要求 SKILL_DEPENDENCY_UNAVAILABLE 有明确说明）。 */
export const SKILL_DEPENDENCY_TEXT = SKILL_ERROR_TEXT.SKILL_DEPENDENCY_UNAVAILABLE;

/* ══════════════════════════════════════════════════════════════════════════
   运行状态（MOTION_SYSTEM §7：queued / running / success / failed / unknown）
   ══════════════════════════════════════════════════════════════════════════ */
export type SkillTone = "neutral" | "success" | "warning" | "danger";
export type SkillRunStatus = "idle" | "queued" | "running" | "success" | "failed" | "unavailable";

export function skillRunFeedback(status: SkillRunStatus): {
  label: string;
  tone: SkillTone;
  detail: string;
  active: boolean;
} {
  switch (status) {
    case "queued":
      return { label: "已排队", tone: "neutral", detail: "等待执行槽位，还没有开始调用模型。", active: false };
    case "running":
      return { label: "执行中", tone: "neutral", detail: "技能正在真实执行；进度来自 skill:event 的 progress 事件。", active: true };
    case "success":
      return { label: "已完成", tone: "success", detail: "主进程已返回结果。", active: false };
    case "failed":
      return { label: "执行失败", tone: "danger", detail: "技能执行没有完成，原因见错误码说明。", active: false };
    case "unavailable":
      return { label: "依赖缺失", tone: "warning", detail: SKILL_DEPENDENCY_TEXT, active: false };
    default:
      return { label: "未运行", tone: "neutral", detail: "选择一个技能并给出输入后可以运行。", active: false };
  }
}

export type SkillProgressPhase = "begin" | "completed" | "failed" | "rejected";

/** skill:event 的 P1 信封（dxos-foundation-events.cjs）→ progress 阶段。 */
export function skillProgressPhase(event: {
  kind?: string;
  payload?: { command?: string; phase?: string; requestId?: string | null };
} | null): SkillProgressPhase | null {
  if (!event || event.kind !== "progress") return null;
  const phase = event.payload && event.payload.phase;
  if (phase === "begin" || phase === "completed" || phase === "failed" || phase === "rejected") {
    return phase;
  }
  return null;
}

export function skillRunStatusFromPhase(phase: SkillProgressPhase | null): SkillRunStatus | null {
  if (phase === "begin") return "running";
  if (phase === "rejected") return "unavailable";
  if (phase === "failed") return "failed";
  /* completed 只是"命令返回了"：成功与否由命令结果决定，不提前标成功
     （DESIGN_SYSTEM §9：流式文本结束不能触发成功样式）。 */
  return null;
}

/* ══════════════════════════════════════════════════════════════════════════
   导入失败分类（skill-import.cjs:43-48 / skill-pack.cjs:77-82 的失败文本）
   ══════════════════════════════════════════════════════════════════════════ */
export type ImportFailureCategory =
  | "zip"
  | "size"
  | "path"
  | "format"
  | "content"
  | "permission"
  | "dependency"
  | "offline"
  | "unknown";

/* 顺序即优先级：体积 > ZIP 结构 > 路径 > 内容 > 格式 > 在线 > 依赖。
   之所以把体积排在 ZIP 之前：「压缩包不能超过 32 MB」同时含「压缩包」与「不能超过」，
   按体积解释才对（反过来会把它归类成"ZIP 损坏"）。 */
const IMPORT_PATTERNS: readonly { category: ImportFailureCategory; test: RegExp; label: string }[] = [
  { category: "size", test: /过大|超出限制|不能超过|上限|不能超过/i, label: "技能包体积超出上限" },
  { category: "zip", test: /ZIP|压缩包|文件头|解压|目录损坏|目录无效|目录不完整|内容不完整|文件不完整/i, label: "不是有效的技能包 ZIP，或 ZIP 结构损坏" },
  { category: "path", test: /越界|不安全路径/i, label: "技能包内存在越界路径，已阻止写入" },
  { category: "content", test: /SKILL\.md|可导入|相同 ID|没有可/i, label: "技能包内没有可导入的技能，或技能 ID 重复" },
  { category: "format", test: /格式|skill\.json|manifest|systemPrompt|文本型|压缩/i, label: "技能包格式不受支持或清单字段缺失" },
  { category: "offline", test: /在线|ModelScope|安装器|npx|网络/i, label: "在线获取已关闭：本版本只支持从本机 ZIP 导入" },
  { category: "dependency", test: /依赖|尚未接入|未注入/i, label: "导入依赖不可用，技能没有写入" },
];

/** 导入失败 → 分类 + 人话；同时保留原始 message（脱敏后的）供排查。 */
export function classifyImportError(input: {
  code?: string | null;
  message?: string | null;
}): { category: ImportFailureCategory; label: string; detail: string } {
  const code = input.code == null ? "" : String(input.code);
  const message = input.message == null ? "" : String(input.message);
  if (UNAVAILABLE_CODES.indexOf(code) >= 0) {
    return { category: "dependency", label: "导入依赖不可用，技能没有写入", detail: message || skillErrorText(code) };
  }
  if (UNAUTHORIZED_CODES.indexOf(code) >= 0) {
    return { category: "permission", label: "当前账号没有导入权限", detail: message || skillErrorText(code) };
  }
  for (const rule of IMPORT_PATTERNS) {
    if (rule.test.test(message)) {
      return { category: rule.category, label: rule.label, detail: message };
    }
  }
  return {
    category: "unknown",
    label: "技能包导入失败，原因未登记",
    detail: message || skillErrorText(code),
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   列表过滤（三分类 + 搜索）
   ══════════════════════════════════════════════════════════════════════════ */
export function filterSkills(skills: SkillRecord[], query: string): SkillRecord[] {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return skills;
  return skills.filter((s) => {
    const hay = [s.id, s.name, s.description].filter((v) => typeof v === "string").join("\n").toLowerCase();
    return hay.indexOf(q) >= 0;
  });
}

/** 我的技能 = 非内置（用户自建 / 导入）；已安装 = 全部可见技能。 */
export function skillsForTab(tab: SkillTab, skills: SkillRecord[]): SkillRecord[] {
  if (tab === "mine") return skills.filter((s) => s.builtin !== true);
  if (tab === "installed") return skills.filter((s) => s.visibleInApp !== false);
  return [];
}

/** 媒体类技能（skill-store.cjs:179-438 的 kind 取值）：参数入口不属 UI-1。 */
export const MEDIA_SKILL_KINDS: readonly string[] = [
  "image",
  "image_upscale",
  "midjourney",
  "image_edit",
  "image_batch",
  "image_describe",
  "video",
  "audio_tts",
  "audio_transcribe",
  "audio_music",
];

/** 技能是否可运行：必须启用，且不是系统内部能力（layer=capability）。 */
export function skillRunDisabledReason(skill: SkillRecord | null): string | null {
  if (!skill) return "先选择一个技能";
  if (skill.layer === "capability") return "系统能力不通过技能中心运行";
  if (skill.enabled === false) return "技能已停用：先启用再运行";
  if (skill.kind && MEDIA_SKILL_KINDS.indexOf(skill.kind) >= 0) {
    return "媒体技能的参数入口属后续批次，本轮只运行文本与工作流技能";
  }
  return null;
}
