"use strict";

/**
 * 访达窗口「加入资源库 / 导出」纯逻辑层（无 React / 无 DOM / 无 I/O）。
 *
 * 这一层从已废弃并删除的 src/governance/FilesApp.tsx 抽出（全工程只此一份实现），
 * 只承载一件事：
 *   D3-04D「Files → Resource Library」的受控 Add to Library / Export 规则。
 * 单独拆出来的理由：命令白名单、入口可用性、错误码→文案、载荷键白名单
 * 都是**可离线断言**的规则；放在 .tsx 里就只能靠真机才能测。
 * tests/files-library-actions.test.mjs 直接 import 这一份**界面真正在用**的逻辑。
 *
 * 边界（逐条与主进程对齐，界面层不做第二套）：
 *   · 资源命令对齐 electron/resource-bootstrap.cjs:20-83 的 RENDERER_COMMANDS
 *     （本轮新增 importFromFiles / linkFromFiles 两条，同样登记在同一白名单）；
 *   · 文件导出复用既有 window.openarc.files.exportTo（electron — preload.cjs:253 → main.cjs:1266 files:export）；
 *   · 源文件路径只在主进程解析：file-service.cjs:467 resolve() 刻意不挂 preload，
 *     渲染进程只给 folderId + 条目 id（§64 / §66 / §14）。
 */

/* ══════════════════════════════════════════════════════════════════════════
   1. 入口与命令面
   ══════════════════════════════════════════════════════════════════════════ */

export type LibraryEntryId = "add-managed" | "add-linked" | "export-resource" | "reveal-source" | "export-computer";

/** 工具栏「资源库」菜单与右键菜单共用同一组入口，顺序固定。 */
export const LIBRARY_ENTRIES: readonly LibraryEntryId[] = [
  "add-managed",
  "add-linked",
  "export-resource",
  "reveal-source",
  "export-computer",
];

export const LIBRARY_ENTRY_LABEL: Record<LibraryEntryId, string> = {
  "add-managed": "加入资源库（Managed）",
  "add-linked": "链接到资源库（Linked）",
  "export-resource": "导出资源为普通文件…",
  "reveal-source": "显示源文件",
  "export-computer": "导出到电脑…",
};

/** 与 electron/resource-bootstrap.cjs 的 RENDERER_COMMANDS 逐条对齐（本轮 +2）。 */
export const RESOURCE_LIBRARY_COMMANDS: readonly string[] = [
  "resource/importFromFiles",
  "resource/linkFromFiles",
  "resource/export",
  "resource/revealSource",
];

/* ══════════════════════════════════════════════════════════════════════════
   2. 入口可用性判定（未选中 / 只有文件夹 / 未入资源库 / 进行中 都有明确原因）
   ══════════════════════════════════════════════════════════════════════════ */

export type LibrarySelection = {
  /** 选中的文件服务条目数（真是文件）。 */
  fileCount: number;
  /** 选中的虚拟文件夹数（OpenArc 自己的文件夹，不是磁盘目录）。 */
  folderCount: number;
  /** 选中项里「本窗口刚加入过资源库」的条目数。 */
  knownResourceCount: number;
  /** 其中 storageMode 为 LINKED 的条目数（只有它才能显示源文件）。 */
  knownLinkedCount: number;
};

export type LibraryContext = {
  /** window.openarc.resource.command 是否存在。 */
  hasResourceBridge: boolean;
  /** window.openarc.files.exportTo 是否存在。 */
  hasFilesBridge: boolean;
  /** 本窗口是否正在执行资源库操作。 */
  busy: boolean;
};

export type LibraryAvailability = { enabled: boolean; reason: string };

/** 禁用原因的人话文案（DESIGN_SYSTEM §8：禁用控件不隐藏原因）。 */
export const LIBRARY_REASON = {
  noSelection: "先选择要处理的文件或文件夹",
  noFile: "文件夹不能加入资源库，请选择文件",
  noResourceBridge: "资源库服务未就绪，当前环境无法派发资源命令",
  noFilesBridge: "文件服务未就绪，无法导出到电脑",
  busy: "正在处理上一个资源库操作…",
  notInLibrary: "该文件尚未加入资源库：先「加入资源库」，再导出资源",
  needSingle: "导出资源一次只处理一个已加入资源库的文件",
  needLinked: "只有「链接到资源库」的文件才能显示源文件",
} as const;

function emptySelectionReason(sel: LibrarySelection): string {
  return sel.folderCount > 0 ? LIBRARY_REASON.noFile : LIBRARY_REASON.noSelection;
}

export function libraryEntryAvailability(
  entry: LibraryEntryId,
  sel: LibrarySelection,
  ctx: LibraryContext,
): LibraryAvailability {
  if (ctx.busy) return { enabled: false, reason: LIBRARY_REASON.busy };

  // 导出到电脑走文件桥（files.exportTo），不需要资源桥。
  if (entry === "export-computer") {
    if (!ctx.hasFilesBridge) return { enabled: false, reason: LIBRARY_REASON.noFilesBridge };
    if (sel.fileCount < 1) return { enabled: false, reason: emptySelectionReason(sel) };
    return { enabled: true, reason: "" };
  }

  if (!ctx.hasResourceBridge) return { enabled: false, reason: LIBRARY_REASON.noResourceBridge };

  if (entry === "add-managed" || entry === "add-linked") {
    if (sel.fileCount < 1) return { enabled: false, reason: emptySelectionReason(sel) };
    return { enabled: true, reason: "" };
  }

  if (entry === "export-resource") {
    if (sel.fileCount < 1) return { enabled: false, reason: emptySelectionReason(sel) };
    if (sel.knownResourceCount < 1) return { enabled: false, reason: LIBRARY_REASON.notInLibrary };
    if (sel.knownResourceCount !== 1 || sel.fileCount !== 1) return { enabled: false, reason: LIBRARY_REASON.needSingle };
    return { enabled: true, reason: "" };
  }

  // reveal-source
  if (sel.fileCount < 1) return { enabled: false, reason: emptySelectionReason(sel) };
  if (sel.knownLinkedCount !== 1 || sel.fileCount !== 1) return { enabled: false, reason: LIBRARY_REASON.needLinked };
  return { enabled: true, reason: "" };
}

/** 由「选中了哪些条目」+「本窗口已知的资源引用」算出可用性输入，纯函数。 */
export function selectionStats(
  picked: readonly { kind: "file" | "folder"; id: string }[],
  refs: Record<string, { storageMode?: string } | undefined>,
): LibrarySelection {
  let fileCount = 0;
  let folderCount = 0;
  let knownResourceCount = 0;
  let knownLinkedCount = 0;
  for (const row of picked) {
    if (row.kind === "folder") {
      folderCount += 1;
      continue;
    }
    fileCount += 1;
    const ref = refs[row.id];
    if (ref) {
      knownResourceCount += 1;
      if (ref.storageMode === "LINKED") knownLinkedCount += 1;
    }
  }
  return { fileCount, folderCount, knownResourceCount, knownLinkedCount };
}

/** 工具栏按钮：没有任何选中项（或正在执行）就整体禁用。 */
export function toolbarEntryAvailability(sel: LibrarySelection, ctx: LibraryContext): LibraryAvailability {
  if (ctx.busy) return { enabled: false, reason: LIBRARY_REASON.busy };
  if (!ctx.hasResourceBridge && !ctx.hasFilesBridge) return { enabled: false, reason: LIBRARY_REASON.noResourceBridge };
  if (sel.fileCount < 1 && sel.folderCount < 1) return { enabled: false, reason: LIBRARY_REASON.noSelection };
  return { enabled: true, reason: "" };
}

/* ══════════════════════════════════════════════════════════════════════════
   3. 命令载荷：按键白名单构造，操作者身份字段永远不出现
   ══════════════════════════════════════════════════════════════════════════ */

/** 与 file-service.cjs:18 的 ID_RE 同一条判据（folderId / entryId 不进磁盘路径）。 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_IDS = 200;

export const ALLOWED_PAYLOAD_KEYS: Record<string, string[]> = {
  "resource/importFromFiles": ["type", "folderId", "ids"],
  "resource/linkFromFiles": ["type", "folderId", "ids"],
  "resource/export": ["type", "resourceRef"],
  "resource/revealSource": ["type", "resourceRef"],
  "files/exportTo": ["folderId", "ids"],
};

export function payloadKeysAllowed(command: string, payload: unknown): boolean {
  const allowed = ALLOWED_PAYLOAD_KEYS[command];
  if (!allowed) return false;
  if (!payload || typeof payload !== "object") return true;
  return Object.keys(payload as Record<string, unknown>).every((k) => allowed.indexOf(k) >= 0);
}

export function safeFolderId(value: unknown): string {
  return typeof value === "string" && ID_RE.test(value) ? value : "";
}

export function safeIds(values: unknown): string[] {
  const list = Array.isArray(values) ? values : [];
  const out: string[] = [];
  for (const v of list) {
    if (typeof v === "string" && ID_RE.test(v) && out.indexOf(v) < 0) out.push(v);
    if (out.length >= MAX_IDS) break;
  }
  return out;
}

function safeRef(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function importFromFilesPayload(folderId: unknown, ids: unknown): Record<string, unknown> {
  return { type: "resource/importFromFiles", folderId: safeFolderId(folderId), ids: safeIds(ids) };
}

export function linkFromFilesPayload(folderId: unknown, ids: unknown): Record<string, unknown> {
  return { type: "resource/linkFromFiles", folderId: safeFolderId(folderId), ids: safeIds(ids) };
}

export function exportResourcePayload(resourceRef: unknown): Record<string, unknown> {
  return { type: "resource/export", resourceRef: safeRef(resourceRef) };
}

export function revealSourcePayload(resourceRef: unknown): Record<string, unknown> {
  return { type: "resource/revealSource", resourceRef: safeRef(resourceRef) };
}

export function exportToComputerPayload(folderId: unknown, ids: unknown): Record<string, unknown> {
  return { folderId: safeFolderId(folderId), ids: safeIds(ids) };
}

/* ══════════════════════════════════════════════════════════════════════════
   4. 错误码 → 人话文案（界面只按 code 分支，不解析 message 文本）
   ══════════════════════════════════════════════════════════════════════════ */

export const LIBRARY_ERROR_TEXT: Record<string, string> = {
  // 桥与文件服务
  NO_BRIDGE: "资源库服务未就绪，界面无法派发命令",
  FILES_UNAVAILABLE: "文件服务未就绪，无法读取选中的文件",
  NO_SELECTION: "请先选择要处理的文件",
  INVALID_FOLDER: "目标文件夹不存在",
  // resource-bootstrap.cjs:149 / resource-service.cjs REASON
  INVALID_INPUT: "命令参数不合法，本次操作没有生效",
  INTERNAL_ERROR: "资源服务内部错误，本次操作没有生效",
  NOT_FOUND_OR_FORBIDDEN: "目标不存在，或当前账号没有权限",
  NOT_FOUND: "目标文件不存在，可能已被删除或移动",
  CANCELLED: "已取消，没有产生变更",
  CANCELED: "已取消，没有产生变更",
  EXPORT_UNAVAILABLE: "当前环境不支持导出（没有系统保存对话框）",
  REVEAL_UNAVAILABLE: "当前环境不支持「显示源文件」",
  IMPORT_FAILED: "导入失败：文件可能已被移动、不可读或空间不足",
  IMPORT_CANCELLED: "导入已取消，没有产生变更",
  IMPORTER_UNAVAILABLE: "当前环境不支持从文件服务加入资源库",
  FILE_IO: "文件读写失败，本次操作没有生效",
  FILE_MISSING: "源文件已不存在，本次操作没有生效",
  DISK_SPACE_INSUFFICIENT: "本机磁盘空间不足，导入没有开始",
  // 授权
  UNAUTHORIZED: "当前账号没有加入资源库的权限",
  FORBIDDEN: "当前会话没有权限执行该操作",
};

/** 未登记错误码也给出可读兜底（绝不把原始码或异常文本当正文）。 */
export function libraryErrorText(code: unknown): string {
  if (typeof code === "string" && LIBRARY_ERROR_TEXT[code]) return LIBRARY_ERROR_TEXT[code];
  return "资源库操作失败，请重试";
}

/** 命令结果里的 error 收敛成字符串码：缺失一律 INTERNAL，绝不把 message 文本当码。 */
export function codeOfError(value: unknown): string {
  return typeof value === "string" && value ? value : "INTERNAL_ERROR";
}

/* ══════════════════════════════════════════════════════════════════════════
   5. 成功反馈文案（必须说清结果落在资源库的哪里 / 导出到哪）
   ══════════════════════════════════════════════════════════════════════════ */

export function addSuccessText(mode: "import" | "link", count: number, skipped: number): string {
  const storage = mode === "import" ? "Managed（已复制进 OpenArc）" : "Linked（未复制内容）";
  const tail = skipped > 0 ? "，跳过 " + skipped + " 个（文件不存在或不可读）" : "";
  return "已加入资源库 " + count + " 个文件 · " + storage + tail + " · 可在 Dock「资源库」App 查看";
}

export function exportResourceSuccessText(bytes: unknown): string {
  const n = Number(bytes);
  const size = Number.isFinite(n) && n >= 0 ? n + " 字节" : "未知大小";
  return "已把资源导出为普通文件（" + size + "），落点是你刚选择的保存位置";
}

export function exportComputerSuccessText(count: number, dest: unknown): string {
  const where = typeof dest === "string" && dest ? dest : "你刚选择的文件夹";
  return "已把 " + count + " 个文件导出到电脑：" + where;
}

/* ══════════════════════════════════════════════════════════════════════════
   6. 命令执行（只经 window.openarc.*，异常一律收敛成结构化码）
   ══════════════════════════════════════════════════════════════════════════ */

export type ResourceBridgeLike = { command?: (cmd: Record<string, unknown>) => Promise<unknown> } | null | undefined;
export type FilesBridgeLike = { exportTo?: (folderId: string, ids: string[]) => Promise<unknown> } | null | undefined;

export type LibraryRunResult = {
  ok: boolean;
  code: string;
  text: string;
  resources?: unknown[];
  count?: number;
  bytes?: number;
  dest?: string;
  skipped?: number;
};

async function callResource(bridge: ResourceBridgeLike, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!bridge || typeof bridge.command !== "function") return { ok: false, error: "NO_BRIDGE" };
  try {
    const res = await bridge.command(payload);
    return res && typeof res === "object" ? (res as Record<string, unknown>) : { ok: false, error: "INTERNAL_ERROR" };
  } catch {
    return { ok: false, error: "INTERNAL_ERROR" };
  }
}

/** 加入资源库 / 链接到资源库：选中文件的真实磁盘路径由主进程解析。 */
export async function runAddFromFiles(
  bridge: ResourceBridgeLike,
  folderId: unknown,
  ids: unknown,
  mode: "import" | "link",
): Promise<LibraryRunResult> {
  const payload = mode === "link" ? linkFromFilesPayload(folderId, ids) : importFromFilesPayload(folderId, ids);
  const res = await callResource(bridge, payload);
  if (res.ok) {
    const resources = Array.isArray(res.resources) ? res.resources : [];
    const skippedList = Array.isArray(res.skipped) ? res.skipped : [];
    const count = resources.length || Number(res.count) || safeIds(ids).length;
    return { ok: true, code: "OK", text: addSuccessText(mode, count, skippedList.length), resources, count, skipped: skippedList.length };
  }
  const code = codeOfError(res.error);
  return { ok: false, code, text: libraryErrorText(code) };
}

/** 导出资源为普通文件：resourceRef 只可能是本窗口刚加入资源库后拿到的。 */
export async function runExportResource(bridge: ResourceBridgeLike, resourceRef: unknown): Promise<LibraryRunResult> {
  const res = await callResource(bridge, exportResourcePayload(resourceRef));
  if (res.ok) return { ok: true, code: "OK", text: exportResourceSuccessText(res.bytes), bytes: Number(res.bytes) || 0 };
  const code = codeOfError(res.error);
  return { ok: false, code, text: libraryErrorText(code) };
}

/** 显示源文件：仅 LINKED 资源可用，路径不回渲染进程。 */
export async function runRevealSource(bridge: ResourceBridgeLike, resourceRef: unknown): Promise<LibraryRunResult> {
  const res = await callResource(bridge, revealSourcePayload(resourceRef));
  if (res.ok) return { ok: true, code: "OK", text: "已在访达中显示源文件" };
  const code = codeOfError(res.error);
  return { ok: false, code, text: libraryErrorText(code) };
}

/** 导出到电脑：走既有 files.exportTo（目录由主进程 dialog 选）。 */
export async function runExportToComputer(
  bridge: FilesBridgeLike,
  folderId: unknown,
  ids: unknown,
): Promise<LibraryRunResult> {
  const payload = exportToComputerPayload(folderId, ids);
  if (!payload.folderId || (payload.ids as string[]).length === 0) return { ok: false, code: "NO_SELECTION", text: libraryErrorText("NO_SELECTION") };
  if (!bridge || typeof bridge.exportTo !== "function") return { ok: false, code: "FILES_UNAVAILABLE", text: libraryErrorText("FILES_UNAVAILABLE") };
  try {
    const res = await bridge.exportTo(payload.folderId as string, payload.ids as string[]);
    const out = res && typeof res === "object" ? (res as Record<string, unknown>) : { ok: false, error: "INTERNAL_ERROR" };
    if (out.ok) {
      const count = Number(out.count) || (payload.ids as string[]).length;
      return { ok: true, code: "OK", text: exportComputerSuccessText(count, out.dest), count, dest: typeof out.dest === "string" ? out.dest : "" };
    }
    const code = codeOfError(out.error);
    return { ok: false, code, text: libraryErrorText(code) };
  } catch {
    return { ok: false, code: "INTERNAL_ERROR", text: libraryErrorText("INTERNAL_ERROR") };
  }
}
