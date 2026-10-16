/**
 * 照片应用 · photos 域纯逻辑层（无 React / 无 DOM / 无 I/O）。
 *
 * 为什么单独拆一层：错误码→文案、分页状态推导、来源/文件夹树构建、base64url 字节还原
 * 都是**可离线断言**的规则，图库视图与图像工坊的两个「发送」入口共用同一份判断。
 * 留在 .tsx 里就只能靠启动浏览器验证；放这里，tests/dxos-photos-ui.test.mjs 直接 import 真逻辑。
 *
 * 三方对齐（界面不做第二套口径）：
 *   · 命令白名单逐条对齐 electron/photos-domain.cjs:173-192 的 PHOTOS_COMMANDS；
 *   · 错误码逐条对齐 electron/photos-domain.cjs:100-128 的 PHOTOS_ERROR_CODES，
 *     并补上 IPC 出口实际会出现的 DXOS_ERR_*（dxos-foundation-errors.cjs）与渲染层事实位；
 *   · 分页默认 50 / 上限 100 对齐 photos-domain.cjs:93-94
 *     （= foundation 数组截断长度 100，所以一页永远不会被脱敏层二次静默截断）；
 *   · 来源/文件夹树形状对齐 photos-store.cjs:317-341（sources / folders / virtualFolders 各自
 *     在 100 条处硬截断并给 truncated 标记，items 才是真分页）。
 *
 * 后端已具备、界面未呈现的四条命令（本轮不做 UI）：
 *   photos/features/compute、photos/features/query、
 *   photos/related/compute、photos/related/query
 *   原因：它们的输入是调用方已经算好的 192 维视觉特征向量与排序结果（related 还要
 *   catalogSignature / descriptionSignature / candidates / semanticScores），DX 自家界面也没有
 *   对应入口；本仓没有特征提取器与语义打分来源，做出来只能是假入口。命令仍在白名单里，
 *   一旦有上游提供向量就能接上，所以它们是「未呈现」而不是「不支持」。
 */
import type { DomainBridge, DomainName } from "./types";

/* ══════════════════════════════════════════════════════════════════════════
   页面状态（与 design-system/page-states.tsx 的 PageStateKind 同集合）
   这里刻意不 import .tsx：node:test 直接 import 本文件时不能被 JSX 卡住。
   .tsx 侧用类型断言保证两边不漂移（见 PhotosApp.tsx 的 PageStateKind 检查）。
   ══════════════════════════════════════════════════════════════════════════ */
export type PhotosPageStateKind =
  | "loading"
  | "empty"
  | "error"
  | "unauthorized"
  | "offline"
  | "unavailable"
  | "partial-result";

export const PHOTOS_PAGE_STATE_KINDS: readonly PhotosPageStateKind[] = [
  "loading",
  "empty",
  "error",
  "unauthorized",
  "offline",
  "unavailable",
  "partial-result",
];

/* ══════════════════════════════════════════════════════════════════════════
   命令白名单 —— 界面只能发这些命令（photos:command 的后端白名单）
   ══════════════════════════════════════════════════════════════════════════ */
export const PHOTOS_COMMANDS: readonly string[] = [
  "photos/sources/list",
  "photos/sources/add",
  "photos/sources/remove",
  "photos/folders/create",
  "photos/folders/remove",
  "photos/folders/assign",
  "photos/library",
  "photos/sourceFile",
  "photos/sourceThumbnail",
  "photos/importImage",
  "photos/features/compute",
  "photos/features/query",
  "photos/related/compute",
  "photos/related/query",
  "photos/reversePrompt",
  "photos/visionModels",
  "photos/backgroundRemoval",
  "photos/health",
];

/** 本文件顶部注释里登记的四条「后端已具备、界面未呈现」命令。 */
export const PHOTOS_COMMANDS_UNUSED_BY_UI: readonly string[] = [
  "photos/features/compute",
  "photos/features/query",
  "photos/related/compute",
  "photos/related/query",
];

/** 未登记命令一律拒绝（不猜、不透传），与 photos-domain.cjs:194-196 同一条判据。 */
export function isAllowedPhotosCommand(command: unknown): command is string {
  return typeof command === "string" && PHOTOS_COMMANDS.indexOf(command) >= 0;
}

/* ══════════════════════════════════════════════════════════════════════════
   桥与信封
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 从宿主取 window.openarc.<domain> 的命令面。
 * 用显式结构检查而不是直接取属性：类型声明由另一名执行者补，
 * 界面这侧不依赖声明是否存在，也不怕被声明成别的形状（fail closed）。
 */
export function domainBridge(host: unknown, domain: DomainName): DomainBridge | null {
  if (!host || typeof host !== "object") return null;
  const openarc = (host as { openarc?: unknown }).openarc;
  if (!openarc || typeof openarc !== "object") return null;
  const candidate = (openarc as Record<string, unknown>)[domain as string];
  if (!candidate || typeof candidate !== "object") return null;
  const command = (candidate as { command?: unknown }).command;
  if (typeof command !== "function") return null;
  const bridge = candidate as DomainBridge;
  return { command: (cmd) => bridge.command(cmd) };
}

/** 成功信封 → value；失败或缺字段 → null（界面不猜内容）。 */
export function resultValue<T>(res: unknown): T | null {
  if (!res || typeof res !== "object") return null;
  if ((res as { ok?: unknown }).ok !== true) return null;
  const payload = (res as { value?: unknown }).value;
  return (payload === undefined ? null : payload) as T | null;
}

export type FailureView = { code: string; message: string; detail?: unknown };

/** 失败信封 → { code, message, detail? }；不是失败信封时回 null。 */
export function resultFailure(res: unknown): FailureView | null {
  if (!res || typeof res !== "object") return null;
  if ((res as { ok?: unknown }).ok === true) return null;
  const code = (res as { error?: unknown }).error;
  const message = (res as { message?: unknown }).message;
  const detail = (res as { detail?: unknown }).detail;
  const out: FailureView = {
    code: typeof code === "string" && code ? code : "DXOS_ERR_INTERNAL",
    message: typeof message === "string" && message ? message : "",
  };
  if (detail !== undefined) out.detail = detail;
  return out;
}

/** 渲染层自己造的失败信封（桥缺失、桥抛异常），前缀刻意与后端码区分。 */
export function localFailure(code: string, message: string): FailureView {
  return { code, message };
}

/* ══════════════════════════════════════════════════════════════════════════
   错误码 → 人话 + 对应 PageState
   ══════════════════════════════════════════════════════════════════════════ */
export const PHOTOS_ERROR_TEXT: Record<string, string> = {
  PHOTOS_COMMAND_NOT_ALLOWED: "命令不在 photos:command 白名单内，界面不会发送未登记的命令",
  PHOTOS_NOT_READY: "照片服务尚未装配（当前环境没有照片域的会话与数据根）",
  PHOTOS_INVALID_INPUT: "输入不完整或不符合要求",
  PHOTOS_UNAUTHENTICATED: "当前会话未认证，照片命令被拒绝；重新登录后再试",
  PHOTOS_FORBIDDEN: "当前账号或该应用没有被授这个动作",
  PHOTOS_NOT_FOUND: "照片、来源或文件夹不存在，可能已被移除",
  PHOTOS_CONFLICT: "与当前状态冲突，请刷新后重试",
  PHOTOS_PATH_ESCAPE: "路径落在来源文件夹之外，已按安全围栏拒绝",
  PHOTOS_TOO_LARGE: "文件超过单次内联上限；请改用缩略图，或由宿主接通分片传输",
  PHOTOS_DEPENDENCY_UNAVAILABLE:
    "缺少这个能力所需的依赖（图像处理 / 视频封面 / 导入器 / 数据库）。操作没有执行，也没有产生产物；接入依赖后可以重试。",
  PHOTOS_PROVIDER_UNAVAILABLE:
    "没有可用的视觉模型供应商。反推提示词没有执行；请先在「设置 → API 供应商」添加一个支持视觉（vision / vlm）的平台并勾选对应模型。",
  PHOTOS_PROVIDER_FAILED: "视觉模型调用失败（鉴权、baseUrl、额度或超时）。请检查供应商配置后重试。",
  PHOTOS_INTERNAL: "照片域内部错误，操作未完成",
  DXOS_ERR_INTERNAL: "主进程返回异常，照片操作未完成",
  NO_BRIDGE: "桌面桥未接入（当前环境没有照片域），这个窗口里的操作不会发出去",
  RESPONSE_INCOMPLETE: "主进程返回的记录不完整，界面不猜内容",
};

/** 未登记的码也给可读兜底，并把原始码原样带出（不塌缩成"未知错误"）。 */
export function photosErrorText(code: string): string {
  return PHOTOS_ERROR_TEXT[code] || "照片操作未完成，未登记的错误码：" + String(code || "");
}

const PHOTOS_UNAUTHORIZED_CODES: readonly string[] = [
  "PHOTOS_UNAUTHENTICATED",
  "PHOTOS_FORBIDDEN",
  "DXOS_ERR_FORBIDDEN",
  "SESSION_EXPIRED",
  "SESSION_REVOKED",
];

const PHOTOS_UNAVAILABLE_CODES: readonly string[] = [
  "PHOTOS_NOT_READY",
  "PHOTOS_DEPENDENCY_UNAVAILABLE",
  "PHOTOS_PROVIDER_UNAVAILABLE",
  "NO_BRIDGE",
  "DXOS_ERR_DEPENDENCY_MISSING",
  "DXOS_ERR_UNAVAILABLE",
  "DXOS_ERR_UNSUPPORTED",
];

/** 失败码 → PageState kind（只返回 page-states.tsx 已登记的 kind）。 */
export function photosErrorState(code: string): PhotosPageStateKind {
  if (PHOTOS_UNAUTHORIZED_CODES.indexOf(code) >= 0) return "unauthorized";
  if (PHOTOS_UNAVAILABLE_CODES.indexOf(code) >= 0) return "unavailable";
  return "error";
}

/** 错误码 + 说明的一条展示串（界面把它放进 role=alert 的段落）。 */
export function photosFailureLine(context: string, code: string): string {
  return context + "未完成：" + photosErrorText(code) + "（" + code + "）";
}

/* ══════════════════════════════════════════════════════════════════════════
   分页 —— 后端默认 50 / 上限 100，且单数组过 IPC 会被截断
   ══════════════════════════════════════════════════════════════════════════ */
export const PHOTOS_PAGE_LIMIT_DEFAULT = 50;
export const PHOTOS_PAGE_LIMIT_MAX = 100;

/** limit 归一：非整数或小于 1 用默认值；大于 100 夹到 100（与后端 normalizePagination 同口径）。 */
export function normalizePageLimit(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return PHOTOS_PAGE_LIMIT_DEFAULT;
  return Math.min(value, PHOTOS_PAGE_LIMIT_MAX);
}

/** offset 归一：非负安全整数，其余归 0。 */
export function normalizePageOffset(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return value;
}

export type PageSlice = {
  offset: number;
  limit: number;
  total: number;
  loaded: number;
  /** 后端显式返回的 truncated；缺省时由 offset + loaded < total 推导。 */
  truncated?: boolean;
};

export type PageStateView = {
  offset: number;
  limit: number;
  total: number;
  loaded: number;
  /** 已载入区间是否有未取的下一页（翻页按钮的唯一依据）。 */
  hasNext: boolean;
  hasPrev: boolean;
  nextOffset: number;
  prevOffset: number;
  remaining: number;
  truncated: boolean;
  label: string;
};

/**
 * 分页状态推导。不假设一次拿全量：
 *   · hasNext 取"后端 truncated"或"offset + loaded < total"；
 *   · loaded 夹在 total 之内（后端 total 可能是上一轮快照）；
 *   · 翻页按钮用 nextOffset / prevOffset，永远从当前边界推进。
 */
export function pageState(slice: PageSlice): PageStateView {
  const total = Math.max(0, Math.trunc(Number(slice.total) || 0));
  const limit = normalizePageLimit(slice.limit);
  const offset = normalizePageOffset(slice.offset);
  const rawLoaded = Math.max(0, Math.trunc(Number(slice.loaded) || 0));
  const loaded = Math.min(rawLoaded, Math.max(0, total - offset));
  const boundary = offset + loaded;
  const truncated = slice.truncated === true || boundary < total;
  return {
    offset,
    limit,
    total,
    loaded,
    hasNext: truncated,
    hasPrev: offset > 0,
    nextOffset: boundary,
    prevOffset: Math.max(0, offset - limit),
    remaining: Math.max(0, total - boundary),
    truncated,
    label: "已载入 " + loaded + " / " + total,
  };
}

/** 追加一页并按键去重（翻页重试不会把同一行插两次）。 */
export function mergePage<T>(prev: readonly T[], page: readonly T[], keyOf: (item: T) => string): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const list of [prev, page]) {
    for (const item of list || []) {
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

/**
 * sources / folders / virtualFolders 是"最多 100 条 + truncated 标记"，不是真分页。
 * 界面必须把截断说出来，不能假装看到全部。
 */
export function sourcesTruncationNotices(value: {
  sourcesTotal?: unknown;
  sourcesTruncated?: unknown;
  foldersTotal?: unknown;
  foldersTruncated?: unknown;
  virtualFoldersTotal?: unknown;
  virtualFoldersTruncated?: unknown;
  walkCapReached?: unknown;
}): string[] {
  const notices: string[] = [];
  if (value.sourcesTruncated) notices.push("来源只显示前 " + PHOTOS_PAGE_LIMIT_MAX + " 个（共 " + value.sourcesTotal + " 个）");
  if (value.foldersTruncated) notices.push("来源子目录只显示前 " + PHOTOS_PAGE_LIMIT_MAX + " 个（共 " + value.foldersTotal + " 个）");
  if (value.virtualFoldersTruncated) notices.push("虚拟文件夹只显示前 " + PHOTOS_PAGE_LIMIT_MAX + " 个（共 " + value.virtualFoldersTotal + " 个）");
  if (value.walkCapReached) notices.push("目录扫描到达深度或条目上限，更深的文件没有列出来");
  return notices;
}

/* ══════════════════════════════════════════════════════════════════════════
   文件夹树（虚拟文件夹：跨来源归类）
   ══════════════════════════════════════════════════════════════════════════ */
export type FolderRow = { id: string; name: string; parentId: string | null };
export type FolderNode = FolderRow & { children: FolderNode[]; depth: number; orphan: boolean };

export type FolderTree = {
  roots: FolderNode[];
  byId: Map<string, FolderNode>;
  orphans: FolderNode[];
  /** 因父指向成环而被断开（并升为根）的节点 id。 */
  droppedCycles: string[];
};

/**
 * 构建虚拟文件夹树。后端只保证 parentId 是"另一个文件夹或 null"（创建时校验父存在，
 * 删除父级联子级），但旧数据仍可能出现断父或成环，前端不允许因此丢节点或死循环：
 *   · 父缺失 → 标 orphan 并升为根；
 *   · 自指或成环 → 断开第一个（id 序）节点并升为根，其余如实列在 droppedCycles。
 */
export function buildVirtualFolderTree(folders: readonly FolderRow[]): FolderTree {
  const byId = new Map<string, FolderNode>();
  for (const folder of folders || []) {
    if (!folder || typeof folder.id !== "string" || !folder.id || byId.has(folder.id)) continue;
    byId.set(folder.id, {
      id: folder.id,
      name: typeof folder.name === "string" && folder.name ? folder.name : folder.id,
      parentId: folder.parentId == null ? null : String(folder.parentId),
      children: [],
      depth: 0,
      orphan: false,
    });
  }
  for (const node of byId.values()) {
    if (node.parentId == null) continue;
    if (node.parentId === node.id) {
      node.orphan = true;
      continue;
    }
    const parent = byId.get(node.parentId);
    if (!parent) {
      node.orphan = true;
      continue;
    }
    parent.children.push(node);
  }
  const byName = (a: FolderNode, b: FolderNode) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const roots: FolderNode[] = [];
  const reachable = new Set<string>();
  const visit = (node: FolderNode, depth: number) => {
    node.depth = depth;
    reachable.add(node.id);
    node.children.sort(byName);
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const node of [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (node.parentId != null && !node.orphan) continue;
    roots.push(node);
  }
  for (const root of roots) visit(root, 0);
  const droppedCycles: string[] = [];
  for (const node of [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (reachable.has(node.id)) continue;
    const parent = node.parentId == null ? null : byId.get(node.parentId);
    if (parent) parent.children = parent.children.filter((child) => child.id !== node.id);
    node.orphan = true;
    droppedCycles.push(node.id);
    if (roots.indexOf(node) < 0) roots.push(node);
    visit(node, 0);
  }
  const orphans = roots.filter((root) => root.orphan);
  return { roots, byId, orphans, droppedCycles };
}

/** 预序遍历：只下钻到展开的节点。depth 用于缩进，展开态由界面持有。 */
export function flattenFolderTree(
  roots: readonly FolderNode[],
  expanded: Iterable<string>,
): { node: FolderNode; depth: number }[] {
  const open = expanded instanceof Set ? expanded : new Set(expanded);
  const rows: { node: FolderNode; depth: number }[] = [];
  const visit = (node: FolderNode, depth: number) => {
    rows.push({ node, depth });
    if (!open.has(node.id)) return;
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return rows;
}

/** 面包屑：根到目标；断父时到断点为止。 */
export function folderPathLabel(folders: readonly FolderRow[], id: string): string {
  const byId = new Map((folders || []).map((folder) => [folder.id, folder]));
  const names: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.name);
    current = current.parentId == null ? undefined : byId.get(current.parentId);
  }
  return names.join(" / ");
}

/** select 用的父文件夹选项（平铺输出，depth 由界面转成缩进）。 */
export function folderOptions(folders: readonly FolderRow[]): { id: string; label: string; depth: number }[] {
  const tree = buildVirtualFolderTree(folders);
  const out: { id: string; label: string; depth: number }[] = [];
  const visit = (node: FolderNode, depth: number) => {
    out.push({ id: node.id, label: node.name, depth });
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of tree.roots) visit(root, 0);
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   来源里的真实目录（local-folder:<sourceId>:<relativePath>）
   ══════════════════════════════════════════════════════════════════════════ */
export type LocalFolderRow = { id: string; name: string; parentId: string; sourceId: string; path: string };
export type LocalFolderNode = LocalFolderRow & { children: LocalFolderNode[]; depth: number };

export const LOCAL_ROOT_PREFIX = "local-root:";

export function localRootId(sourceId: string): string {
  return LOCAL_ROOT_PREFIX + String(sourceId);
}

/** 按来源分组构建真实目录树；父不在本批（断父）时升为该来源的根。 */
export function buildLocalFolderTree(folders: readonly LocalFolderRow[]): Map<string, LocalFolderNode[]> {
  const bySource = new Map<string, LocalFolderNode[]>();
  const byId = new Map<string, LocalFolderNode>();
  for (const folder of folders || []) {
    if (!folder || typeof folder.id !== "string" || !folder.id || byId.has(folder.id)) continue;
    byId.set(folder.id, {
      id: folder.id,
      name: typeof folder.name === "string" && folder.name ? folder.name : folder.id,
      parentId: String(folder.parentId == null ? "" : folder.parentId),
      sourceId: String(folder.sourceId == null ? "" : folder.sourceId),
      path: String(folder.path == null ? "" : folder.path),
      children: [],
      depth: 0,
    });
  }
  const roots = new Map<string, LocalFolderNode[]>();
  for (const node of byId.values()) {
    const parent = byId.get(node.parentId);
    if (parent) parent.children.push(node);
  }
  const visit = (node: LocalFolderNode, depth: number) => {
    node.depth = depth;
    node.children.sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
    for (const child of node.children) visit(child, depth + 1);
  };
  const ordered = [...byId.values()].sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
  for (const node of ordered) {
    if (byId.get(node.parentId)) continue;
    const bucket = roots.get(node.sourceId) || [];
    if (!roots.has(node.sourceId)) roots.set(node.sourceId, bucket);
    bucket.push(node);
    visit(node, 0);
  }
  for (const [sourceId, bucket] of roots) bySource.set(sourceId, bucket);
  return bySource;
}

/* ══════════════════════════════════════════════════════════════════════════
   base64url 字节还原（后端字节出口统一 encoding:"base64url"，见 photos-domain.cjs:511）
   ══════════════════════════════════════════════════════════════════════════ */
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_LOOKUP: number[] = (() => {
  const table = new Array<number>(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i += 1) table[B64_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

export function isBase64Url(data: unknown): boolean {
  if (typeof data !== "string") return false;
  const clean = data.replace(/=+$/, "");
  if (!clean) return data.length === 0 || /^=+$/.test(data);
  return /^[A-Za-z0-9_-]+$/.test(clean);
}

/** base64url 到字节。非法输入抛错（不静默出半截图）。 */
export function base64UrlToBytes(data: string): Uint8Array {
  const clean = String(data == null ? "" : data).replace(/=+$/, "").replace(/\s+/g, "");
  if (!clean) return new Uint8Array(0);
  if (!/^[A-Za-z0-9_-]+$/.test(clean)) throw new Error("不是有效的 base64url 数据");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const code = clean.charCodeAt(i);
    const value = code < 128 ? B64_LOOKUP[code] : -1;
    if (value < 0) throw new Error("不是有效的 base64url 数据");
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at] = (acc >>> bits) & 0xff;
      at += 1;
    }
  }
  return at === out.length ? out : out.subarray(0, at);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    acc = (acc << 8) | (bytes[i] & 0xff);
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += B64_ALPHABET[(acc >>> bits) & 0x3f];
    }
  }
  if (bits > 0) out += B64_ALPHABET[(acc << (6 - bits)) & 0x3f];
  return out;
}

/** 浏览器 data: URL 只吃标准 base64（含 + / 与 = 填充），这里做无损转换。 */
export function base64UrlToBase64(data: string): string {
  const clean = String(data == null ? "" : data).replace(/=+$/, "").replace(/\s+/g, "");
  const pad = (4 - (clean.length % 4)) % 4;
  return clean.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
}

export function base64UrlToDataUrl(data: string, mime: string): string {
  const type = typeof mime === "string" && mime ? mime : "application/octet-stream";
  return "data:" + type + ";base64," + base64UrlToBase64(data);
}

export function decodedByteLength(data: string): number {
  return base64UrlToBytes(data).length;
}

/* ══════════════════════════════════════════════════════════════════════════
   photos/health 的依赖事实（布尔只报事实，缺失不降级成"可用"）
   ══════════════════════════════════════════════════════════════════════════ */
export const PHOTOS_DEPENDENCY_LABELS: Record<string, string> = {
  identity: "账号会话",
  database: "特征数据库（identity.db）",
  providerStore: "模型供应商配置",
  vision: "视觉模型实现",
  fsLibrary: "虚拟文件树图库",
  shareAccess: "共享可见性策略",
  sharp: "图像处理（sharp）",
  videoPoster: "视频封面生成",
  importer: "画布 / 资产库导入器",
  fetch: "网络请求（fetch）",
};

export type DependencyRow = { key: string; label: string; available: boolean; hint: string };

export function dependencyReport(health: unknown): DependencyRow[] {
  const deps =
    health && typeof health === "object" && (health as { dependencies?: unknown }).dependencies
      ? ((health as { dependencies: unknown }).dependencies as Record<string, unknown>)
      : null;
  if (!deps || typeof deps !== "object") return [];
  return Object.keys(deps)
    .sort()
    .map((key) => {
      const available = deps[key] === true;
      return {
        key,
        label: PHOTOS_DEPENDENCY_LABELS[key] || key,
        available,
        hint: available ? "已装配" : "未装配：用到它的功能会回结构化不可用，不会假成功",
      };
    });
}

/* ══════════════════════════════════════════════════════════════════════════
   视觉模型（反推提示词）与抠图的人话入口
   ══════════════════════════════════════════════════════════════════════════ */
export const VISION_CONFIG_HINT_FALLBACK =
  "请先在「设置 → API 供应商」添加一个支持视觉（vision / vlm）的平台，填入 baseUrl 与 API Key，并勾选 caps 含 vision 的模型。";

export type VisionModelsView = {
  available: boolean;
  models: { providerId: string; providerName: string; model: string }[];
  hint: string;
};

export function visionModelsView(value: unknown): VisionModelsView {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawModels = Array.isArray(source.models) ? source.models : [];
  const models = rawModels
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => ({
      providerId: String(item.providerId == null ? "" : item.providerId),
      providerName: String(item.providerName == null ? (item.providerId == null ? "" : item.providerId) : item.providerName),
      model: String(item.model == null ? "" : item.model),
    }))
    .filter((item) => item.providerId && item.model);
  const hint = typeof source.hint === "string" && source.hint ? source.hint : VISION_CONFIG_HINT_FALLBACK;
  return { available: source.available === true && models.length > 0, models, hint };
}

export const BACKGROUND_REMOVAL_DEPENDENCY_LABELS: Record<string, string> = {
  "media-background-removal": "本地抠图模块（media-background-removal.cjs）",
  sharp: "图像处理（sharp）",
  onnxruntime: "推理运行时（onnxruntime）",
  model: "抠图模型文件",
};

/** 抠图依赖缺失的结构化提示：依赖名 + 后端 hint + 可执行下一步。 */
export function backgroundRemovalHint(detail: unknown, code: string): string {
  const source = detail && typeof detail === "object" ? (detail as Record<string, unknown>) : {};
  const dependency = typeof source.dependency === "string" ? source.dependency : "";
  const label = dependency ? BACKGROUND_REMOVAL_DEPENDENCY_LABELS[dependency] || dependency : "";
  const hint = typeof source.hint === "string" ? source.hint : "";
  const parts: string[] = [];
  if (code === "PHOTOS_DEPENDENCY_UNAVAILABLE") {
    parts.push(label ? "缺少：" + label : "缺少本地抠图依赖");
    parts.push("抠图没有执行，也没有产生任何图。");
  } else {
    parts.push(photosErrorText(code));
  }
  if (hint) parts.push(hint);
  else parts.push("接入依赖后可以重试；本仓不会用假图兜底。");
  return parts.join(" ");
}

/* ══════════════════════════════════════════════════════════════════════════
   导入目标（photos/importImage 的 destination 只认 canvas / library）
   ══════════════════════════════════════════════════════════════════════════ */
export type ImportDestination = "canvas" | "library";

export const IMPORT_DESTINATIONS: readonly { id: ImportDestination; label: string; hint: string }[] = [
  { id: "canvas", label: "画布", hint: "落成画布上的一张图片卡片；目标 ID 是画布 ID。" },
  { id: "library", label: "素材库", hint: "写入素材库；目标 ID 由主进程注入的导入器决定。" },
];

/* ══════════════════════════════════════════════════════════════════════════
   展示小工具
   ══════════════════════════════════════════════════════════════════════════ */
export function formatBytes(value: unknown): string {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return "—";
  if (size < 1024) return size + " B";
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
  if (size < 1024 * 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + " MB";
  return (size / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

/** updated_ts 是秒（photos-store.cjs:259 的 stat.mtimeMs / 1000）。 */
export function formatTimestamp(value: unknown): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n: number) => (n < 10 ? "0" + n : String(n));
  return (
    date.getFullYear() +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    " " +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes())
  );
}

export function photoKindLabel(kind: unknown): string {
  if (kind === "video") return "视频";
  if (kind === "image") return "图片";
  return "未知类型";
}

/** 归类结果的人话摘要（assigned / cleared / skipped 都可能只出现一部分）。 */
export function assignSummary(value: unknown): string {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const parts: string[] = [];
  if (Number.isFinite(Number(source.assigned))) parts.push("已归入 " + Number(source.assigned) + " 张");
  if (Number.isFinite(Number(source.cleared))) parts.push("已移出 " + Number(source.cleared) + " 张");
  const skipped = Array.isArray(source.skipped) ? source.skipped.length : 0;
  if (skipped) parts.push("跳过 " + skipped + " 张（文件已不在来源里）");
  if (!parts.length) return "没有需要改动的照片";
  return parts.join("，");
}
