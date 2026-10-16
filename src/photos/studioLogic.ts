/**
 * 照片应用 · 图像工坊（photocraft + appExchange）纯逻辑层（无 React / 无 DOM / 无 I/O）。
 *
 * 为什么单独拆一层：三态可见性控件的语义、分组投影、回收站可执行动作、
 * 以及「发送到画布 / 图像工坊」的 target 过滤与不可用态，都是可离线断言的规则；
 * 放在 .tsx 里就只能靠启动浏览器验证。
 *
 * 逐条对齐已冻结的后端：
 *   · 命令白名单/错误码：electron/photocraft-domain.cjs:132-150、:65-87；
 *   · ProjectSummary / Group：electron/photocraft-domain.cjs:251-283 与 photocraft-service.cjs:106-122；
 *   · 三态与成员整表替换：photocraft-service.cjs:188-201（非 restricted 时成员表被清空，逐字对齐）；
 *   · target 表与映射备注：electron/app-exchange-domain.cjs:83-117；
 *   · canOpen 过滤：app-exchange-service.cjs:172-181（前端不得硬编码 target 列表）；
 *   · 只传引用：app-exchange-domain.cjs:240-282（bytes/data/url 一律拒绝）。
 */
import type { PhotosPageStateKind } from "./photosLogic";
import type { PhotoCraftGroup, PhotoCraftProject } from "./types";

/* ══════════════════════════════════════════════════════════════════════════
   photocraft 命令白名单与错误码
   ══════════════════════════════════════════════════════════════════════════ */
export const PHOTOCRAFT_COMMANDS: readonly string[] = [
  "photocraft/projects/list",
  "photocraft/projects/create",
  "photocraft/projects/get",
  "photocraft/projects/update",
  "photocraft/projects/trash",
  "photocraft/projects/restore",
  "photocraft/projects/purge",
  "photocraft/projects/readSource",
  "photocraft/projects/writeSource",
  "photocraft/projects/export",
  "photocraft/projects/saveClipboardTemp",
  "photocraft/projects/saveBundle",
  "photocraft/projects/save-bundle",
  "photocraft/trash/list",
  "photocraft/groups/create",
  "photocraft/groups/remove",
];

export function isAllowedPhotocraftCommand(command: unknown): command is string {
  return typeof command === "string" && PHOTOCRAFT_COMMANDS.indexOf(command) >= 0;
}

/** 本应用不呈现、但后端已登记的两条（save-bundle 由 file-transfer 域承接）。 */
export const PHOTOCRAFT_COMMANDS_UNUSED_BY_UI: readonly string[] = [
  "photocraft/projects/saveBundle",
  "photocraft/projects/save-bundle",
  "photocraft/projects/saveClipboardTemp",
];

export const PHOTOCRAFT_ERROR_TEXT: Record<string, string> = {
  PHOTOCRAFT_COMMAND_NOT_ALLOWED: "命令不在 photocraft:command 白名单内",
  PHOTOCRAFT_NOT_READY: "图像工坊服务尚未装配",
  PHOTOCRAFT_INVALID_INPUT: "输入不完整或不符合要求",
  PHOTOCRAFT_UNAUTHENTICATED: "当前会话未认证，图像工坊命令被拒绝；重新登录后再试",
  PHOTOCRAFT_NOT_FOUND: "项目、分组或源文件不存在，可能已被删除",
  PHOTOCRAFT_FORBIDDEN: "只有项目所有者可以执行这个动作；共享项目对你是只读的",
  PHOTOCRAFT_CONFLICT: "与当前状态冲突（例如默认分组不能删除、项目尚未进入回收站）",
  PHOTOCRAFT_TOO_LARGE: "文件超过 24 MB 的内联上限，请改用更小的文件",
  PHOTOCRAFT_UNSUPPORTED: "这个能力在本仓由其他域承接：save-bundle 属文件传输，不再由图像工坊实现",
  PHOTOCRAFT_INTERNAL: "图像工坊内部错误，操作未完成",
  DXOS_ERR_INTERNAL: "主进程返回异常，图像工坊操作未完成",
  NO_BRIDGE: "桌面桥未接入（当前环境没有图像工坊域）",
};

export function photocraftErrorText(code: string): string {
  return PHOTOCRAFT_ERROR_TEXT[code] || "图像工坊操作未完成，未登记的错误码：" + String(code || "");
}

export function photocraftFailureLine(context: string, code: string): string {
  return context + "未完成：" + photocraftErrorText(code) + "（" + code + "）";
}

const PHOTOCRAFT_UNAUTHORIZED: readonly string[] = [
  "PHOTOCRAFT_UNAUTHENTICATED",
  "PHOTOCRAFT_FORBIDDEN",
  "DXOS_ERR_FORBIDDEN",
];
const PHOTOCRAFT_UNAVAILABLE: readonly string[] = [
  "PHOTOCRAFT_NOT_READY",
  "PHOTOCRAFT_UNSUPPORTED",
  "NO_BRIDGE",
  "DXOS_ERR_DEPENDENCY_MISSING",
  "DXOS_ERR_UNAVAILABLE",
  "DXOS_ERR_UNSUPPORTED",
];

export function photocraftErrorState(code: string): PhotosPageStateKind {
  if (PHOTOCRAFT_UNAUTHORIZED.indexOf(code) >= 0) return "unauthorized";
  if (PHOTOCRAFT_UNAVAILABLE.indexOf(code) >= 0) return "unavailable";
  return "error";
}

/* ══════════════════════════════════════════════════════════════════════════
   appExchange 命令白名单与错误码
   ══════════════════════════════════════════════════════════════════════════ */
export const APP_EXCHANGE_COMMANDS: readonly string[] = [
  "appExchange/targets",
  "appExchange/exchange",
  "appExchange/get",
  "appExchange/inspect",
];

export function isAllowedAppExchangeCommand(command: unknown): command is string {
  return typeof command === "string" && APP_EXCHANGE_COMMANDS.indexOf(command) >= 0;
}

export const APP_EXCHANGE_ERROR_TEXT: Record<string, string> = {
  APP_EXCHANGE_COMMAND_NOT_ALLOWED: "命令不在 appExchange:command 白名单内",
  APP_EXCHANGE_INVALID_INPUT: "发送请求不完整或字段不合法",
  APP_EXCHANGE_UNAUTHENTICATED: "当前会话未认证，应用互传命令被拒绝；重新登录后再试",
  APP_EXCHANGE_NOT_FOUND: "发送记录或素材不存在",
  APP_EXCHANGE_CONFLICT: "同一个请求 ID 已用于另一次发送，请重新发起",
  APP_EXCHANGE_FORBIDDEN: "没有打开目标应用或读取这张图的权限",
  APP_EXCHANGE_TARGET_UNSUPPORTED:
    "目标应用不支持这个操作。请重新选择下方由后端列出的目标；本仓没有 dev-photocraft，等价物是图像工坊（image-studio）。",
  APP_EXCHANGE_BYTES_NOT_ALLOWED: "应用互传只传引用，不接收图片字节或 URL",
  APP_EXCHANGE_STALE_REVISION: "来源图片已变化，请重新发送",
  APP_EXCHANGE_TOO_LARGE: "图片超过 64 MB 上限，无法发送",
  APP_EXCHANGE_IMAGE_INVALID: "图片格式无效：只支持 PNG / JPEG / WebP，动态图需先导出为静态图片",
  APP_EXCHANGE_IMAGE_ENGINE_UNAVAILABLE: "缺少 sharp，无法校验图片；发送没有执行",
  APP_EXCHANGE_DEPENDENCY_UNAVAILABLE:
    "应用互传的依赖端口未装配（目标列表 / 画布 / 素材读取中的某一项）；发送没有执行，也没有建副本。",
  APP_EXCHANGE_NOT_READY: "应用互传服务尚未装配（当前环境没有互传域）",
  APP_EXCHANGE_INTERNAL: "应用互传内部错误，发送未完成",
  DXOS_ERR_INTERNAL: "主进程返回异常，发送未完成",
  NO_BRIDGE: "桌面桥未接入（当前环境没有应用互传域）",
};

export function appExchangeErrorText(code: string): string {
  return APP_EXCHANGE_ERROR_TEXT[code] || "发送未完成，未登记的错误码：" + String(code || "");
}

export function appExchangeFailureLine(context: string, code: string): string {
  return context + "未完成：" + appExchangeErrorText(code) + "（" + code + "）";
}

const EXCHANGE_UNAUTHORIZED: readonly string[] = [
  "APP_EXCHANGE_UNAUTHENTICATED",
  "APP_EXCHANGE_FORBIDDEN",
  "DXOS_ERR_FORBIDDEN",
];
const EXCHANGE_UNAVAILABLE: readonly string[] = [
  "APP_EXCHANGE_NOT_READY",
  "APP_EXCHANGE_DEPENDENCY_UNAVAILABLE",
  "APP_EXCHANGE_IMAGE_ENGINE_UNAVAILABLE",
  "NO_BRIDGE",
];

export function appExchangeErrorState(code: string): PhotosPageStateKind {
  if (EXCHANGE_UNAUTHORIZED.indexOf(code) >= 0) return "unauthorized";
  if (EXCHANGE_UNAVAILABLE.indexOf(code) >= 0) return "unavailable";
  return "error";
}

/* ══════════════════════════════════════════════════════════════════════════
   项目与分组投影
   ══════════════════════════════════════════════════════════════════════════ */
export type GroupBucket = {
  group: PhotoCraftGroup;
  projects: PhotoCraftProject[];
  mine: boolean;
  isDefault: boolean;
};

/** 按 groups 的顺序分桶；项目落在未列出的 groupId 时补一个只读桶（不吞项目）。 */
export function groupProjects(
  projects: readonly PhotoCraftProject[],
  groups: readonly PhotoCraftGroup[],
): GroupBucket[] {
  const buckets: GroupBucket[] = (groups || []).map((group) => ({
    group,
    projects: [],
    mine: group.mine !== false,
    isDefault: group.isDefault === true,
  }));
  const byId = new Map(buckets.map((bucket) => [bucket.group.id, bucket]));
  for (const project of projects || []) {
    let bucket = byId.get(project.groupId);
    if (!bucket) {
      bucket = {
        group: { id: project.groupId, name: project.groupId, mine: false, isDefault: false },
        projects: [],
        mine: false,
        isDefault: false,
      };
      byId.set(project.groupId, bucket);
      buckets.push(bucket);
    }
    bucket.projects.push(project);
  }
  const byUpdated = (a: PhotoCraftProject, b: PhotoCraftProject) =>
    Number(b.updatedAt || 0) - Number(a.updatedAt || 0) || String(a.title).localeCompare(String(b.title));
  for (const bucket of buckets) bucket.projects.sort(byUpdated);
  return buckets;
}

/** 分组下拉选项：默认分组置顶，然后按名字。 */
export function groupOptions(groups: readonly PhotoCraftGroup[]): { id: string; label: string; isDefault: boolean; mine: boolean }[] {
  return (groups || [])
    .slice()
    .sort((a, b) => Number(b.isDefault === true) - Number(a.isDefault === true) || String(a.name).localeCompare(String(b.name)) || a.id.localeCompare(b.id))
    .map((group) => ({ id: group.id, label: group.name, isDefault: group.isDefault === true, mine: group.mine !== false }));
}

export function canEditProject(project: PhotoCraftProject | null | undefined): boolean {
  return !!project && project.mine === true && project.access === "owner";
}

export function accessLabel(project: PhotoCraftProject | null | undefined): string {
  if (!project) return "";
  return project.access === "owner" ? "我是所有者" : "只读共享";
}

/* ══════════════════════════════════════════════════════════════════════════
   三态可见性控件
   ══════════════════════════════════════════════════════════════════════════ */
export type Visibility = "private" | "public" | "restricted";

export const VISIBILITY_OPTIONS: readonly { id: Visibility; label: string; hint: string }[] = [
  { id: "private", label: "私有", hint: "只有我自己能看到这个项目。" },
  { id: "public", label: "公开", hint: "所有登录用户都能看到（只读）。" },
  { id: "restricted", label: "指定成员", hint: "只有我在成员列表里填的账号能看到（只读）。" },
];

export function visibilityLabel(value: unknown): string {
  const found = VISIBILITY_OPTIONS.find((option) => option.id === value);
  return found ? found.label : "未登记可见性";
}

export function memberList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .map((item) => String(item == null ? "" : item).trim())
    .filter((id) => id && !seen.has(id) && (seen.add(id), true));
}

/** 成员输入框的文本形态：一行一个 id（后端成员 id 形如 usr_xxx）。 */
export function membersInputValue(value: unknown): string {
  return memberList(value).join("\n");
}

export function parseMembersInput(text: unknown): string[] {
  return memberList(String(text == null ? "" : text).split(/[\s,;]+/));
}

export type VisibilityControl = {
  current: Visibility;
  options: { id: Visibility; label: string; hint: string; selected: boolean; disabled: boolean }[];
  disabled: boolean;
  disabledReason: string;
  note: string;
  requiresMembers: boolean;
  memberCount: number;
};

/**
 * 三态控件的语义（不是三个独立开关）：
 *   · 非所有者只能看当前值，控件整体禁用并说明原因；
 *   · 选「指定成员」才显示成员输入，并提示至少要有一个成员；
 *   · 切到「私有 / 公开」时后端会清空成员表（photocraft-service.cjs:194 逐字对齐），
 *     界面必须提前把这件事说出来，不能等保存后才发现成员没了。
 */
export function visibilityControl(input: {
  visibility: unknown;
  mine?: boolean | null;
  members?: unknown;
}): VisibilityControl {
  const current: Visibility = input.visibility === "public" || input.visibility === "restricted" ? input.visibility : "private";
  const members = memberList(input.members);
  const mine = input.mine !== false;
  const options = VISIBILITY_OPTIONS.map((option) => ({
    id: option.id,
    label: option.label,
    hint: option.hint,
    selected: option.id === current,
    disabled: !mine,
  }));
  const requiresMembers = current === "restricted";
  const note = !mine
    ? "你不是这个项目的所有者，可见性与成员不可修改。"
    : requiresMembers && members.length === 0
      ? "当前是「指定成员」但成员为空：除你之外没有人能看到，请填入成员 ID。"
      : current === "restricted"
        ? "成员 " + members.length + " 个；改回私有或公开会清空成员列表。"
        : "改成「指定成员」会启用成员列表；改回私有或公开会清空成员列表。";
  return {
    current,
    options,
    disabled: !mine,
    disabledReason: mine ? "" : "只有项目所有者可以修改可见性",
    note,
    requiresMembers,
    memberCount: members.length,
  };
}

/**
 * update 的可见性载荷。后端在非 restricted 时会整表替换成空数组，
 * 这里显式给出同样的语义，避免界面"以为成员还在"。
 */
export function visibilityUpdatePayload(
  visibility: Visibility,
  members: readonly string[],
): { visibility: Visibility; members: string[] } {
  return { visibility, members: visibility === "restricted" ? memberList(members) : [] };
}

/* ══════════════════════════════════════════════════════════════════════════
   回收站与导出
   ══════════════════════════════════════════════════════════════════════════ */
export const MIME_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "application/octet-stream": "bin",
};

export function sanitizeFileName(name: unknown, fallback: string): string {
  const clean = String(name == null ? "" : name)
    .replace(/[\\/:*?"<>|]/g, "_")
    .slice(0, 120);
  return clean || fallback;
}

/** 下载源文件时的文件名（后端 readSource 只回 name/mime/size/base64）。 */
export function sourceDownloadName(name: unknown, mime: unknown): string {
  const raw = String(name == null ? "" : name);
  if (raw) return sanitizeFileName(raw, "source.bin");
  const extension = MIME_EXTENSION[String(mime == null ? "" : mime)] || "bin";
  return "source." + extension;
}

/** 写入项目「导出/」目录时的文件名。 */
export function exportArtifactName(project: PhotoCraftProject | null | undefined, name?: unknown): string {
  if (name != null && String(name)) return sanitizeFileName(name, "export.bin");
  const title = project && project.title ? project.title : "未命名项目";
  const extension = project ? MIME_EXTENSION[project.sourceMime] || "bin" : "bin";
  return sanitizeFileName(title + "-导出." + extension, "export.bin");
}

export function canPurge(project: PhotoCraftProject | null | undefined): boolean {
  return !!project && Number(project.deletedAt || 0) > 0;
}

export const TRASH_PURGE_HINT =
  "彻底删除会同时删掉项目与它在虚拟树里的缓存目录，回收站里无法再恢复。只有已进入回收站的项目可以彻底删除。";

export function trashActionHint(project: PhotoCraftProject | null | undefined): string {
  if (!project) return "";
  return canPurge(project) ? "该项目在回收站里，可以恢复或彻底删除。" : "该项目仍在项目列表，先移入回收站后才能彻底删除。";
}

/* ══════════════════════════════════════════════════════════════════════════
   appExchange target 语义（列表由后端过滤，前端不硬编码 target）
   ══════════════════════════════════════════════════════════════════════════ */
export type ExchangeTargetView = {
  target: import("./types").ExchangeTarget;
  key: string;
  label: string;
  disabled: boolean;
  disabledReason: string;
  note: string;
  needsCanvas: boolean;
};

export const MIME_LABEL: Record<string, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
};

export function mimeLabel(mime: unknown): string {
  const value = String(mime == null ? "" : mime);
  return MIME_LABEL[value] || value || "未知格式";
}

/** target 的稳定标识（appId + action 才是唯一语义，单看 appId 会撞两条）。 */
export function exchangeTargetKey(target: { appId: string; action: string }): string {
  return String(target.appId) + ":" + String(target.action);
}

export function targetAccepts(target: { accepts?: unknown }, mime: unknown): boolean {
  const accepts: unknown[] = target && Array.isArray(target.accepts) ? target.accepts : [];
  return accepts.some((item) => String(item) === String(mime));
}

export function targetOptionLabel(target: { title?: unknown; action?: unknown; creates?: unknown }): string {
  const title = String(target && target.title ? target.title : "");
  const creates = String(target && target.creates ? target.creates : "");
  const createsLabel = creates === "document" ? "新建项目" : creates === "layer" ? "当前文档" : creates === "node" ? "新建卡片" : creates;
  return createsLabel ? title + "（" + createsLabel + "）" : title;
}

/** 需要目标画布 ID 的 target：由后端声明的 action/creates 推导，不看 appId 硬编码。 */
export function targetNeedsCanvas(target: { action?: unknown; creates?: unknown }): boolean {
  return target && (target.action === "image.import" || target.creates === "node");
}

export type TargetsView = {
  targets: ExchangeTargetView[];
  canvases: { id: string; title: string }[];
  /** 至少有一个可发送目标。 */
  ready: boolean;
  /** 没有可发送目标时的可执行原因（不是空态文案）。 */
  emptyReason: string;
};

/**
 * 把后端 targets 表投影成界面可用的选项：
 *   · 目标列表只来自后端（canOpen 已过滤），前端不补也不删；
 *   · 来源 mime 不被 target.accepts 接受时禁用并写明原因；
 *   · mappingNote 原样展示，让 image-studio 与 dev-photocraft 的映射可追溯。
 */
export function targetsView(value: unknown, mime: unknown): TargetsView {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawTargets = Array.isArray(source.targets) ? source.targets : [];
  const rawCanvases = Array.isArray(source.canvases) ? source.canvases : [];
  const known = String(mime == null ? "" : mime);
  const targets = rawTargets
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && typeof item.appId === "string" && typeof item.action === "string")
    .map((item) => {
      const target = item as unknown as import("./types").ExchangeTarget;
      const accepted = known ? targetAccepts(target, known) : null;
      const disabled = accepted === false;
      return {
        target,
        key: exchangeTargetKey(target),
        label: targetOptionLabel(target),
        disabled,
        disabledReason: disabled
          ? "只接受 " + (Array.isArray(target.accepts) ? target.accepts.map(mimeLabel).join(" / ") : "") + "；当前来源是 " + mimeLabel(known)
          : "",
        note: typeof target.mappingNote === "string" && target.mappingNote ? target.mappingNote : "",
        needsCanvas: targetNeedsCanvas(target),
      };
    });
  const canvases = rawCanvases
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && typeof item.id === "string")
    .map((item) => ({ id: String(item.id), title: String(item.title == null ? item.id : item.title) }));
  const ready = targets.some((item) => !item.disabled);
  let emptyReason = "";
  if (!targets.length) {
    emptyReason =
      "后端没有返回可发送的目标。targets 表按 canOpen 过滤：可能没有打开目标应用的权限，或应用互传的依赖端口未装配。请让管理员确认后，点「重新读取目标」再试。";
  } else if (!ready) {
    emptyReason =
      "当前来源的格式不被任何目标接受（本仓只支持 PNG / JPEG / WebP）。请先把图片转成这三种格式之一，再重新读取目标。";
  }
  return { targets, canvases, ready, emptyReason };
}

/** 默认选中第一个可发送目标，且优先画布（新建卡片不需要额外 ID 之外的上下文）。 */
export function defaultTargetKey(views: readonly ExchangeTargetView[], mime: unknown): string | null {
  const usable = views.filter((view) => !view.disabled);
  if (!usable.length) return null;
  const canvas = usable.find((view) => view.needsCanvas && targetAccepts(view.target, mime));
  return (canvas || usable[0]).key;
}

/**
 * target 不可用时的可执行提示（要求 5：不能给空态）。
 * 覆盖 TARGET_UNSUPPORTED / DEPENDENCY_UNAVAILABLE / NOT_READY / FORBIDDEN。
 */
export function targetsUnavailableNotice(code: string, detail?: unknown): string {
  const source = detail && typeof detail === "object" ? (detail as Record<string, unknown>) : {};
  const dependency = typeof source.dependency === "string" ? source.dependency : "";
  switch (code) {
    case "APP_EXCHANGE_TARGET_UNSUPPORTED":
      return (
        "目标应用不支持这个操作。" +
        (source.appId ? "后端报告的目标是 " + String(source.appId) + "/" + String(source.action == null ? "" : source.action) + "。" : "") +
        "请从下方后端列出的目标里重新选择；列表里没有的应用表示当前没有它的打开权限。"
      );
    case "APP_EXCHANGE_DEPENDENCY_UNAVAILABLE":
      return (
        "应用互传依赖端口未装配" +
        (dependency ? "（缺少 " + dependency + "）" : "") +
        "。请在主进程装配 target 列表 / 画布 / 素材读取端口后，点「重新读取目标」。发送没有执行，也没有建副本。"
      );
    case "APP_EXCHANGE_IMAGE_ENGINE_UNAVAILABLE":
      return "缺少 sharp，无法校验图片元数据；发送没有执行。安装 sharp 或注入 sharpLoader 后重试。";
    case "APP_EXCHANGE_NOT_READY":
    case "NO_BRIDGE":
      return "应用互传服务尚未装配（当前环境没有 appExchange:command）。发送不可用；目标列表需要后端先就绪。";
    case "APP_EXCHANGE_FORBIDDEN":
      return "没有打开目标应用或读取这张图的权限。请确认该应用的打开授权与素材可见性，然后重新读取目标。";
    default:
      return appExchangeErrorText(code);
  }
}

export type TargetsPageState = {
  kind: PhotosPageStateKind | "ready";
  title: string;
  description: string;
  missing?: string[];
};

/** 目标面板的四态推导。目标为空 / 全被格式排除时用 unavailable + 可执行说明，不用空态。 */
export function targetsPageState(input: {
  value?: unknown;
  errorCode?: string | null;
  loading: boolean;
  mime?: unknown;
}): TargetsPageState {
  if (input.loading && input.value === undefined) {
    return { kind: "loading", title: "正在读取可用目标…", description: "目标列表由后端按打开权限过滤，界面不硬编码。" };
  }
  if (input.errorCode) {
    return {
      kind: appExchangeErrorState(input.errorCode),
      title: "读取目标失败",
      description: targetsUnavailableNotice(input.errorCode),
    };
  }
  const view = targetsView(input.value, input.mime);
  if (!view.ready) return { kind: "unavailable", title: "没有可发送的目标", description: view.emptyReason };
  return { kind: "ready", title: "", description: "" };
}

/* ══════════════════════════════════════════════════════════════════════════
   只传引用：请求构造与形状校验
   ══════════════════════════════════════════════════════════════════════════ */
const REFERENCE_FORBIDDEN_KEYS: readonly string[] = [
  "bytes",
  "data",
  "base64",
  "blob",
  "buffer",
  "content",
  "file",
  "image",
  "url",
  "dataUrl",
  "src",
  "path",
];

/** 应用互传只传引用：字段名或二进制值命中即判否（app-exchange-domain.cjs:245）。 */
export function isReferenceOnly(value: unknown, depth = 0): boolean {
  if (value == null) return true;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean" || type === "bigint") return true;
  if (typeof Uint8Array !== "undefined" && value instanceof Uint8Array) return false;
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return false;
  if (type !== "object") return true;
  if (depth > 5) return false;
  if (Array.isArray(value)) return value.every((item) => isReferenceOnly(item, depth + 1));
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (REFERENCE_FORBIDDEN_KEYS.indexOf(key) >= 0) return false;
    if (!isReferenceOnly(item, depth + 1)) return false;
  }
  return true;
}

export type ExchangeRequestBuild =
  | { ok: true; request: import("./types").ExchangeRequest }
  | { ok: false; message: string };

/**
 * 构造 exchange 请求。与后端 validateExchangeRequest 的关键约束一致：
 *   · 画布目标必须有 projectId（画布 ID）；
 *   · 图像工坊的 image.edit 不覆盖已有项目，带 projectId 直接拒绝；
 *   · 只传 nodeId 引用，不带任何字节。
 */
export function buildExchangeRequest(input: {
  requestId: unknown;
  target: { appId?: unknown; action?: unknown; projectId?: unknown } | null | undefined;
  asset: { nodeId?: unknown; canvasId?: unknown; photoCraftProjectId?: unknown; revision?: unknown } | null | undefined;
  needsCanvas?: boolean;
}): ExchangeRequestBuild {
  const requestId = String(input.requestId == null ? "" : input.requestId).trim();
  if (!requestId) return { ok: false, message: "缺少请求 ID，无法发送" };
  const target = input.target;
  if (!target || !target.appId || !target.action) return { ok: false, message: "请选择一个目标应用" };
  const nodeId = input.asset && input.asset.nodeId ? String(input.asset.nodeId) : "";
  if (!nodeId) return { ok: false, message: "这个项目还没有源文件，无法发送" };
  const projectId = target.projectId == null || target.projectId === "" ? "" : String(target.projectId);
  if (input.needsCanvas && !projectId) return { ok: false, message: "请选择目标画布" };
  if (!input.needsCanvas && projectId) return { ok: false, message: "图像工坊只支持新建项目，不覆盖已有项目" };
  const targetOut: import("./types").ExchangeRequestTarget = { appId: String(target.appId), action: String(target.action) };
  if (projectId) targetOut.projectId = projectId;
  const assetOut: import("./types").ExchangeAsset = { nodeId };
  if (input.asset && input.asset.canvasId) assetOut.canvasId = String(input.asset.canvasId);
  if (input.asset && input.asset.photoCraftProjectId) assetOut.photoCraftProjectId = String(input.asset.photoCraftProjectId);
  if (input.asset && input.asset.revision) assetOut.revision = String(input.asset.revision).slice(0, 128);
  const request = { requestId, target: targetOut, asset: assetOut };
  if (!isReferenceOnly(request)) return { ok: false, message: "应用互传只传引用，请求里不能带图片字节或 URL" };
  return { ok: true, request };
}

/** 请求 ID：只含 [A-Za-z0-9_-]，且不超过后端 128 字符上限。 */
export function newRequestId(seed: string | number, now: number): string {
  const clean = String(seed).replace(/[^A-Za-z0-9_-]/g, "");
  const stamp = String(Math.trunc(Number(now) || 0));
  return ("oa" + (clean ? "-" + clean : "") + "-" + stamp).slice(0, 128);
}

/** 发送成功的人话（区分新建项目 / 当前文档 / 新建卡片三种落点）。 */
export function exchangeResultText(result: unknown): string {
  const source = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const target = source.target && typeof source.target === "object" ? (source.target as Record<string, unknown>) : {};
  const action = String(target.action == null ? "" : target.action);
  const appId = String(target.appId == null ? "" : target.appId);
  const place =
    action === "image.edit"
      ? "新建项目 " + String(target.projectId == null ? "" : target.projectId)
      : action === "image.receive"
        ? "当前文档（素材 " + String(target.assetNodeId == null ? "" : target.assetNodeId) + "）"
        : action === "image.import"
          ? "画布卡片 " + String(target.cardId == null ? "" : target.cardId)
          : "目标 " + appId;
  const asset = source.asset && typeof source.asset === "object" ? (source.asset as Record<string, unknown>) : {};
  const name = String(asset.name == null ? "图片" : asset.name);
  return "已发送「" + name + "」到 " + appId + "：" + place;
}
