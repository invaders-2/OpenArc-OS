/**
 * 通用「应用更新」界面（按 appId 驱动）的纯逻辑层。
 *
 * 由原 src-vue/apps/canvasUpdateLogic.ts（画布专用）泛化而来：同一套状态机 / 确认门 / 切源请求，
 * 只多了一个 app 上下文（appId + appName）。画布专用入口保留可用 —— canvasUpdateLogic.ts 只是
 * 把本模块的通用函数用 canvas 参数包了一层（行为逐字不变）。
 *
 * 只做「命令契约 ↔ 界面状态」的确定性映射：无 Vue、无 DOM、无 IO，可直接被 node --test 断言。
 * 命令契约见 docs/canvas-online-update.md 第 5 节（错误码在 electron/market-update-domain.cjs 冻结）。
 *
 * 三条硬约束写在这里，组件只准照做：
 *   1) install 永远带 confirm:true，且必须由 confirmDecision("confirm") 放行 —— 不存在静默安装路径；
 *   2) 已是最新 / 源里没有 Release 都是**正常状态**，不是失败；
 *   3) 切源只在用户显式点选时发 source/set；同 kind 不重复发（不覆盖已保存的选择）。
 *
 * 诚实边界（本模块是权威）：
 *   · 后端 status.loadable === false 的应用，即使源里有新版本也不放行安装（canInstall=false），
 *     界面必须显示「该应用暂不支持安装包加载」，绝不假装升级成功；
 *   · 没有发布包的应用显示当前版本 + 「无可用更新」，是正常状态，不是错误。
 */

export const CANVAS_APP_ID = "canvas";
export const CANVAS_APP_NAME = "无限画布";

export const UPDATE_STATUS_COMMAND = "market/update/status";
export const UPDATE_CHECK_COMMAND = "market/update/check";
export const UPDATE_INSTALL_COMMAND = "market/update/install";
export const UPDATE_ROLLBACK_COMMAND = "market/update/rollback";
export const UPDATE_SOURCES_COMMAND = "market/update/sources";
export const UPDATE_SOURCE_SET_COMMAND = "market/update/source/set";

export type AppUpdateBusy = "status" | "check" | "install" | "rollback" | null;

export interface AppUpdateSource {
  kind: string;
  owner: string;
  repo: string;
}

export interface AppUpdateLatest {
  version: string;
  notesUrl: string | null;
  publishedAt: number;
}

export interface AppUpdateCurrent {
  version: string;
  digest: string | null;
  installedAt: number;
}

export interface AppUpdateStatus {
  appId: string;
  current: AppUpdateCurrent | null;
  builtinVersion: string;
  source: AppUpdateSource;
  checkedAt: number | null;
  latest: AppUpdateLatest | null;
  updateAvailable: boolean;
  canRollback: boolean;
  /** 已安装包形态 / 应用声明的包形态；后端不懂就回 null，不臆造。 */
  packageKind: string | null;
  /** 渲染层是否已接入该应用的已安装包加载路径（后端 domain.APP_PACKAGE_LOADERS 决定）。 */
  loadable: boolean;
  loader: string | null;
  loadReason: string | null;
}

export interface AppUpdateSourceOption {
  kind: string;
  label: string;
  defaultRepository: { owner: string; repo: string } | null;
  configurableFields: string[];
}

export interface AppUpdateSources {
  kind: string;
  owner: string;
  repo: string;
  defaultRepository: { owner: string; repo: string } | null;
  defaultSource: { kind: string } | null;
  selected: { kind: string; owner: string; repo: string } | null;
  sources: AppUpdateSourceOption[];
}

/**
 * 冻结错误码 → 中文。逐条对应 electron/market-update-domain.cjs 的 MARKET_UPDATE_ERROR_CODES，
 * 未知码不编造原因，直接说明「更新失败」并保留原始码给 data-*。
 */
export const UPDATE_ERROR_TEXT: Readonly<Record<string, string>> = Object.freeze({
  MARKET_UPDATE_NOT_READY: "在线更新服务还没装配好，稍后再试。",
  MARKET_UPDATE_INVALID_INPUT: "这次请求的参数不合法，操作已停止。",
  MARKET_UPDATE_UNAUTHENTICATED: "当前会话没有登录，登录后就能检查更新。",
  MARKET_UPDATE_COMMAND_NOT_ALLOWED: "这条更新命令不被允许，操作已停止。",
  MARKET_UPDATE_NOT_FOUND: "更新源里没有这个版本的安装包。",
  MARKET_UPDATE_NO_RELEASE: "更新源里还没有可用的版本。",
  MARKET_UPDATE_SIGNATURE_INVALID: "更新包签名校验没通过，已拒绝安装。",
  MARKET_UPDATE_DIGEST_MISMATCH: "更新包内容摘要不一致，已拒绝安装。",
  MARKET_UPDATE_SOURCE_DIGEST_MISMATCH: "更新包与源里的文件清单不一致，已拒绝安装。",
  MARKET_UPDATE_HOST_NOT_ALLOWED: "下载地址不在这个更新源允许的主机里，已拒绝下载。",
  MARKET_UPDATE_DOWNLOAD_FAILED: "下载更新包失败，检查网络后可以重试。",
  MARKET_UPDATE_CONFLICT: "这个应用正忙或有另一个安装在进行，稍后重试。",
  MARKET_UPDATE_ROLLBACK_UNAVAILABLE: "没有可以回滚的上一版。",
  MARKET_UPDATE_UNSUPPORTED: "这个更新包的格式不受支持。",
  MARKET_UPDATE_NOT_LOADABLE: "该应用暂不支持安装包加载，本期只有无限画布会真正生效。",
  DXOS_ERR_INTERNAL: "更新服务内部出错，可以稍后重试。",
});

export const UPDATE_UNKNOWN_ERROR_TEXT = "更新失败，原因未知。可以重试。";

/** 硬拒绝类错误：同一份包再重试也不会通过，文案引导换源/换版本而不是反复重试。 */
export const UPDATE_REJECTED_CODES: readonly string[] = Object.freeze([
  "MARKET_UPDATE_SIGNATURE_INVALID",
  "MARKET_UPDATE_DIGEST_MISMATCH",
  "MARKET_UPDATE_SOURCE_DIGEST_MISMATCH",
  "MARKET_UPDATE_HOST_NOT_ALLOWED",
  "MARKET_UPDATE_INVALID_INPUT",
  "MARKET_UPDATE_UNSUPPORTED",
  "MARKET_UPDATE_COMMAND_NOT_ALLOWED",
  "MARKET_UPDATE_NOT_LOADABLE",
]);

export function updateErrorText(code: unknown): string {
  const key = typeof code === "string" ? code : "";
  return UPDATE_ERROR_TEXT[key] || UPDATE_UNKNOWN_ERROR_TEXT;
}

export function isRejectedError(code: unknown): boolean {
  return typeof code === "string" && UPDATE_REJECTED_CODES.indexOf(code) >= 0;
}

/** 失败后能否原样重试（硬拒绝类仍可重试，但文案不承诺会成功）。 */
export function isRetryableError(code: unknown): boolean {
  return typeof code === "string" && code.length > 0 && !isRejectedError(code);
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asNumber = (value: unknown): number => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** 时间戳 → 本机时区的 YYYY-MM-DD HH:mm；0 / 非法值如实回「—」。 */
export function formatTimestamp(value: unknown): string {
  const ms = asNumber(value);
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function normalizeSource(value: unknown): AppUpdateSource {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return { kind: asString(raw.kind), owner: asString(raw.owner), repo: asString(raw.repo) };
}

/** 把后端 value（或探针 fixture）收敛成可信状态；形状不对回 null，绝不半信任。 */
export function normalizeAppUpdateStatus(value: unknown): AppUpdateStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const latestRaw = raw.latest && typeof raw.latest === "object" ? (raw.latest as Record<string, unknown>) : null;
  const currentRaw = raw.current && typeof raw.current === "object" ? (raw.current as Record<string, unknown>) : null;
  const latestVersion = latestRaw ? asString(latestRaw.version) : "";
  const currentVersion = currentRaw ? asString(currentRaw.version) : "";
  return {
    appId: asString(raw.appId) || CANVAS_APP_ID,
    current: currentVersion
      ? { version: currentVersion, digest: asString(currentRaw && currentRaw.digest) || null, installedAt: asNumber(currentRaw && currentRaw.installedAt) }
      : null,
    builtinVersion: asString(raw.builtinVersion) || "—",
    source: normalizeSource(raw.source),
    // 注意：Number(null) === 0，不能直接拿 Number.isFinite 判。0 / 负值 / null 都表示"从没检查过"。
    checkedAt: Number.isFinite(Number(raw.checkedAt)) && Number(raw.checkedAt) > 0 ? Number(raw.checkedAt) : null,
    latest: latestVersion
      ? { version: latestVersion, notesUrl: asString(latestRaw && latestRaw.notesUrl) || null, publishedAt: asNumber(latestRaw && latestRaw.publishedAt) }
      : null,
    updateAvailable: raw.updateAvailable === true,
    canRollback: raw.canRollback === true,
    packageKind: asString(raw.packageKind) || null,
    loadable: raw.loadable !== false,
    loader: asString(raw.loader) || null,
    loadReason: asString(raw.loadReason) || null,
  };
}

export function normalizeAppUpdateSources(value: unknown): AppUpdateSources | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const list = Array.isArray(raw.sources) ? raw.sources : [];
  const options: AppUpdateSourceOption[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const kind = asString(entry.kind);
    if (!kind) continue;
    const repo = entry.defaultRepository && typeof entry.defaultRepository === "object" ? (entry.defaultRepository as Record<string, unknown>) : null;
    options.push({
      kind,
      label: asString(entry.label) || kind,
      defaultRepository: repo ? { owner: asString(repo.owner), repo: asString(repo.repo) } : null,
      configurableFields: Array.isArray(entry.configurableFields) ? entry.configurableFields.map((f) => asString(f)).filter(Boolean) : [],
    });
  }
  const selectedRaw = raw.selected && typeof raw.selected === "object" ? (raw.selected as Record<string, unknown>) : null;
  return {
    kind: asString(raw.kind),
    owner: asString(raw.owner),
    repo: asString(raw.repo),
    defaultRepository: raw.defaultRepository && typeof raw.defaultRepository === "object"
      ? { owner: asString((raw.defaultRepository as Record<string, unknown>).owner), repo: asString((raw.defaultRepository as Record<string, unknown>).repo) }
      : null,
    defaultSource: raw.defaultSource && typeof raw.defaultSource === "object" ? { kind: asString((raw.defaultSource as Record<string, unknown>).kind) } : null,
    selected: selectedRaw ? { kind: asString(selectedRaw.kind), owner: asString(selectedRaw.owner), repo: asString(selectedRaw.repo) } : null,
    sources: options,
  };
}

export const SOURCE_KIND_FALLBACK: readonly AppUpdateSourceOption[] = [
  { kind: "modelscope-repo", label: "ModelScope 仓库", defaultRepository: { owner: "bllack", repo: "OpenArc-OS" }, configurableFields: ["owner", "repo"] },
  { kind: "github-releases", label: "GitHub Releases", defaultRepository: { owner: "invaders-2", repo: "OpenArc-OS" }, configurableFields: ["owner", "repo"] },
];

/** sources 命令失败时用注册表兜底，界面不至于空着；label 与后端 describeSource 一致。 */
export function sourceOptions(sources: AppUpdateSources | null): AppUpdateSourceOption[] {
  if (sources && sources.sources.length) return sources.sources.slice();
  return SOURCE_KIND_FALLBACK.slice();
}

export function sourceKindLabel(kind: string, sources?: AppUpdateSources | null): string {
  const found = sourceOptions(sources || null).find((item) => item.kind === kind);
  return found ? found.label : kind || "—";
}

export function repositoryText(source: AppUpdateSource | null | undefined): string {
  if (!source || !source.owner || !source.repo) return "—";
  return source.owner + "/" + source.repo;
}

/** 「ModelScope 仓库（bllack/OpenArc-OS）」——来源仓库始终与 kind 一起出现。 */
export function sourceText(source: AppUpdateSource | null | undefined, sources?: AppUpdateSources | null): string {
  if (!source || !source.kind) return "—";
  return sourceKindLabel(source.kind, sources) + "（" + repositoryText(source) + "）";
}

/** 正在生效的版本：装过就是 current，没装过就是随包内置版本。 */
export function runningVersion(status: AppUpdateStatus | null): string {
  if (!status) return "—";
  return status.current ? status.current.version : status.builtinVersion;
}

export function runningLabel(status: AppUpdateStatus | null): string {
  if (!status) return "—";
  return status.current ? "已安装的 " + status.current.version : "随包内置的 " + status.builtinVersion;
}

export type AppUpdatePhase = "unchecked" | "checking" | "latest" | "available" | "unsupported" | "failed";
export type AppUpdateTone = "neutral" | "success" | "warning" | "danger";

export interface AppUpdateViewInput {
  status: AppUpdateStatus | null;
  busy: AppUpdateBusy;
  errorCode: string | null;
  sources?: AppUpdateSources | null;
  appId?: string;
  appName?: string;
}

export interface AppUpdateView {
  phase: AppUpdatePhase;
  tone: AppUpdateTone;
  badge: string;
  title: string;
  detail: string;
  canCheck: boolean;
  canInstall: boolean;
  canRollback: boolean;
  busy: AppUpdateBusy;
  installBusy: boolean;
  rollbackBusy: boolean;
  dataState: AppUpdatePhase;
  appId: string;
  appName: string;
  loadable: boolean;
}

/**
 * 状态映射的唯一权威：未检查 / 检查中 / 已是最新 / 有更新 / 有更新但暂不支持加载 / 失败
 * （+ 安装中由 busy 表达）。appId/appName 缺省 = canvas（历史行为逐字不变）。
 */
export function appUpdateView(input: AppUpdateViewInput): AppUpdateView {
  const appId = input.appId || CANVAS_APP_ID;
  const appName = input.appName || CANVAS_APP_NAME;
  const status = input.status;
  const busy = input.busy;
  const loadable = !status || status.loadable !== false;
  const base = {
    busy,
    installBusy: busy === "install",
    rollbackBusy: busy === "rollback",
    canInstall: false,
    canRollback: false,
    appId,
    appName,
    loadable,
  };

  if (busy === "status") {
    return { ...base, phase: "checking", tone: "neutral", badge: "读取中", title: "正在读取" + appName + "的更新状态…", detail: "这一步只读本机记录，不会联网。", canCheck: false, dataState: "checking" };
  }
  if (busy === "check") {
    return { ...base, phase: "checking", tone: "neutral", badge: "检查中", title: "正在检查" + appName + "的更新…", detail: "正在向" + sourceText(status && status.source, input.sources) + "读取最新版本。", canCheck: false, dataState: "checking" };
  }
  if (input.errorCode) {
    return {
      ...base,
      phase: "failed",
      tone: "danger",
      badge: "失败",
      title: updateErrorText(input.errorCode),
      detail: "可以重试；原始错误码保留在 data-canvas-update-error-code。",
      canCheck: true,
      canInstall: !!(loadable && status && status.updateAvailable && status.latest),
      canRollback: !!(status && status.canRollback),
      dataState: "failed",
    };
  }
  if (!status) {
    return { ...base, phase: "unchecked", tone: "neutral", badge: "未检查", title: "还没有检查过更新", detail: "检查后会显示更新源里的最新版本、发布时间与说明链接。", canCheck: true, dataState: "unchecked" };
  }
  if (status.checkedAt == null && !status.updateAvailable) {
    return {
      ...base,
      phase: "unchecked",
      tone: "neutral",
      badge: "未检查",
      title: "还没有检查过更新",
      detail: "当前来源 " + sourceText(status.source, input.sources) + "。检查后会显示最新版本、发布时间与说明链接。",
      canCheck: true,
      canRollback: status.canRollback,
      dataState: "unchecked",
    };
  }
  if (!status.latest) {
    return {
      ...base,
      phase: "latest",
      tone: "neutral",
      badge: "已是最新",
      title: "更新源里还没有发布版本",
      detail: sourceText(status.source, input.sources) + "里还没有 " + appName + " 安装包，当前运行 " + runningLabel(status) + "。这不是错误。",
      canCheck: true,
      canRollback: status.canRollback,
      dataState: "latest",
    };
  }
  if (!status.updateAvailable) {
    return {
      ...base,
      phase: "latest",
      tone: "success",
      badge: "已是最新",
      title: "已是最新版本 " + status.latest.version,
      detail: runningLabel(status) + "；上次检查 " + formatTimestamp(status.checkedAt) + "。",
      canCheck: true,
      canRollback: status.canRollback,
      dataState: "latest",
    };
  }
  if (!loadable) {
    return {
      ...base,
      phase: "unsupported",
      tone: "warning",
      badge: "暂不支持安装包加载",
      title: "发现新版本 " + status.latest.version + "，但" + appName + "暂不支持安装包加载",
      detail: (status.loadReason || "该应用暂不支持安装包加载。") + " 当前运行 " + runningLabel(status) + "，本次不会安装，也不会假装升级成功。",
      canCheck: true,
      canInstall: false,
      canRollback: status.canRollback,
      dataState: "unsupported",
    };
  }
  return {
    ...base,
    phase: "available",
    tone: "warning",
    badge: "有可用更新",
    title: "发现新版本 " + status.latest.version,
    detail: runningLabel(status) + "可更新到 " + status.latest.version + "，发布时间 " + formatTimestamp(status.latest.publishedAt) + "。",
    canCheck: true,
    canInstall: true,
    canRollback: status.canRollback,
    dataState: "available",
  };
}

export type AppUpdatePendingAction =
  | { kind: "install"; version: string }
  | { kind: "rollback"; toVersion: string | null };

export interface AppUpdateConfirm {
  kind: "install" | "rollback";
  title: string;
  body: string;
  primary: string;
}

export function pendingInstallAction(status: AppUpdateStatus | null): AppUpdatePendingAction | null {
  if (!status || status.loadable === false || !status.updateAvailable || !status.latest) return null;
  return { kind: "install", version: status.latest.version };
}

export function pendingRollbackAction(status: AppUpdateStatus | null): AppUpdatePendingAction | null {
  if (!status || !status.canRollback) return null;
  return { kind: "rollback", toVersion: null };
}

/** 二次确认的文案：把「会动什么、从哪来」讲清楚，不用颜色单独承担危险语义。 */
export function appConfirmCopy(action: AppUpdatePendingAction | null, status: AppUpdateStatus | null, sources?: AppUpdateSources | null, appName = CANVAS_APP_NAME): AppUpdateConfirm {
  if (!action || action.kind === "rollback") {
    return {
      kind: "rollback",
      title: "回滚" + appName,
      body: "将把" + appName + "从当前版本 " + runningVersion(status) + " 回滚到上一个已安装的版本。回滚只在你点击确认后才会开始。",
      primary: "确认回滚",
    };
  }
  return {
    kind: "install",
    title: "更新" + appName,
    body: "将从 " + sourceText(status && status.source, sources) + " 下载并安装" + appName + " " + action.version + "，替换当前 " + runningVersion(status) + "。更新只在你点击确认后才会开始，不会在后台静默安装。",
    primary: "确认更新",
  };
}

export type AppUpdateDecision =
  | { invoke: false; reason: "cancelled" | "nothing-pending" | "not-loadable" }
  | { invoke: true; command: string; payload: Record<string, unknown> };

/** 唯一放行安装/回滚的门：只有 decision === "confirm" 才产出命令，且安装必带 confirm:true。 */
export function appConfirmDecision(action: AppUpdatePendingAction | null, decision: "confirm" | "cancel", appId = CANVAS_APP_ID): AppUpdateDecision {
  if (!action) return { invoke: false, reason: "nothing-pending" };
  if (decision !== "confirm") return { invoke: false, reason: "cancelled" };
  if (action.kind === "install") {
    const payload: Record<string, unknown> = { appId, confirm: true };
    if (action.version) payload.version = action.version;
    return { invoke: true, command: UPDATE_INSTALL_COMMAND, payload };
  }
  return { invoke: true, command: UPDATE_ROLLBACK_COMMAND, payload: { appId } };
}

export interface AppUpdateSourceSetRequest {
  invoke: boolean;
  reason: string;
  command: string;
  payload: Record<string, unknown>;
}

/**
 * 切源请求：只在用户显式点选时调用。
 *   · 同 kind → 不发命令（避免用默认 owner/repo 覆盖已保存的选择）；
 *   · 换 kind → 只带 kind，让后端用该源的默认仓库。
 */
export function sourceSetRequest(current: AppUpdateSource | null | undefined, kind: string): AppUpdateSourceSetRequest {
  const target = typeof kind === "string" ? kind.trim() : "";
  const same = !!current && !!target && current.kind === target;
  if (same) return { invoke: false, reason: "same-kind", command: UPDATE_SOURCE_SET_COMMAND, payload: { kind: target } };
  return { invoke: true, reason: current ? "switch-kind" : "first-pick", command: UPDATE_SOURCE_SET_COMMAND, payload: { kind: target } };
}

export function installSuccessText(result: unknown): string {
  const value = result && typeof result === "object" ? (result as Record<string, unknown>) : null;
  const installed = value && value.installed && typeof value.installed === "object" ? (value.installed as Record<string, unknown>) : null;
  const version = asString(installed && installed.version);
  return version ? "已更新到 " + version + "。" : "更新已完成。";
}

export function rollbackSuccessText(result: unknown): string {
  const value = result && typeof result === "object" ? (result as Record<string, unknown>) : null;
  const to = asString(value && value.rolledBackTo);
  return to ? "已回滚到 " + to + "。" : "回滚已完成。";
}

/* ── 应用市场卡片用的一行状态（不打开详情也能看到版本 / 有无更新 / 能否升级） ── */

export interface AppCardUpdate {
  badge: string;
  tone: AppUpdateTone;
  detail: string;
  canUpgrade: boolean;
}

export function appCardUpdate(status: AppUpdateStatus | null): AppCardUpdate {
  if (!status) return { badge: "版本未知", tone: "neutral", detail: "暂时读不到这个应用的更新状态", canUpgrade: false };
  const version = runningVersion(status);
  if (status.loadable === false) {
    if (status.updateAvailable && status.latest) {
      return { badge: "有新版本 " + status.latest.version, tone: "warning", detail: "当前 " + version + "；该应用暂不支持安装包加载", canUpgrade: false };
    }
    if (status.checkedAt != null) {
      return { badge: "无可用更新", tone: "neutral", detail: "当前 " + version + "；已检查，源里没有发布包（该应用暂不支持安装包加载）", canUpgrade: false };
    }
    return { badge: "暂不支持安装包加载", tone: "neutral", detail: "当前 " + version + "；本期只有无限画布会真正生效", canUpgrade: false };
  }
  if (status.updateAvailable && status.latest) {
    return { badge: "有新版本 " + status.latest.version, tone: "warning", detail: "当前 " + version + "，可升级到 " + status.latest.version, canUpgrade: true };
  }
  if (status.checkedAt != null) {
    return { badge: "已是最新", tone: "success", detail: "当前 " + version + "；已检查，无可用更新", canUpgrade: false };
  }
  return { badge: "未检查", tone: "neutral", detail: "当前 " + version, canUpgrade: false };
}

/**
 * 探针复用的选择器清单（单一权威）。每个属性都必须在 CanvasUpdatePanel.vue / MarketApp.vue 里真实存在，
 * tests/dxos-canvas-update-ui.test.mjs 会对着源码逐条核对。
 */
export const CANVAS_UPDATE_SELECTORS = Object.freeze([
  '[data-canvas-update="1"]',
  '[data-canvas-update-state]',
  '[data-canvas-update-busy]',
  '[data-canvas-update-title]',
  '[data-canvas-update-notice]',
  '[data-canvas-update-progress]',
  '[data-canvas-update-current]',
  '[data-canvas-update-builtin]',
  '[data-canvas-update-latest]',
  '[data-canvas-update-published]',
  '[data-canvas-update-available]',
  '[data-canvas-update-can-rollback]',
  '[data-canvas-update-source]',
  '[data-canvas-update-source-repo]',
  '[data-canvas-update-checked-at]',
  '[data-canvas-update-error-code]',
  '[data-canvas-update-notes]',
  '[data-canvas-update-notes-none]',
  '[data-canvas-update-check]',
  '[data-canvas-update-install]',
  '[data-canvas-update-rollback]',
  '[data-canvas-update-back]',
  '[data-canvas-update-source-option]',
  '[data-canvas-update-confirm]',
  '[data-canvas-update-confirm-primary]',
  '[data-canvas-update-open]',
]);

/** 泛化新增的取证属性（同一个面板，按 appId 驱动；旧 data-canvas-update-* 全部保留）。 */
export const APP_UPDATE_SELECTORS = Object.freeze([
  '[data-app-update="<appId>"]',
  '[data-app-update-name]',
  '[data-app-update-phase]',
  '[data-app-update-loadable]',
]);
