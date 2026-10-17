/**
 * 共享盘 / 部门盘 / 快照的渲染层薄封装。
 *
 * 唯一通道是 window.openarc.platform.command（platform:command）：
 *   · platform/fs/shared/roots|list、platform/fs/search|stats、platform/fs/snapshot/create|restore；
 *   · 返回值只包含安全节点投影（id / name / type / mime / size / parentId / share / ownerId / system / 时间），
 *     不含 blob、内容正文或磁盘绝对路径；界面不猜测后端没返回的字段；
 *   · 权限判定全部在主进程（public 全员可读、department 本部门可读、恢复只允许超管 / owner / 部门管理员），
 *     渲染层只展示后端结果，失败时原样呈现结构化错误码，不把拒绝包装成成功。
 */

export type SharedNode = {
  id: string;
  name: string;
  type: string;
  mime: string | null;
  size: number | null;
  parentId: string | null;
  share: string | null;
  ownerId: string | null;
  system: boolean;
  createdAt: number | null;
  updatedAt: number | null;
};

export type SharedSearchHit = { id: string; name: string; type: string; path?: string; snippet?: string };

export type PlatformResult = { ok?: boolean; value?: unknown; error?: string; message?: string; detail?: unknown };

type PlatformBridge = { command: (command: Record<string, unknown>) => Promise<unknown> };

const PLATFORM_ERROR_TEXT: Record<string, string> = {
  NO_BRIDGE: "当前环境没有平台桥，共享盘不可用",
  PLATFORM_COMMAND_NOT_ALLOWED: "这个平台命令没有被白名单允许",
  PLATFORM_INVALID_INPUT: "请求参数不完整或不合法",
  PLATFORM_UNAUTHENTICATED: "当前会话未认证：请重新登录后再试",
  PLATFORM_FORBIDDEN: "后端拒绝：没有访问或恢复这个节点的权限",
  PLATFORM_NOT_FOUND: "节点不存在，或已移入回收站",
  PLATFORM_CONFLICT: "状态冲突：快照恢复没有完成，请刷新后重试",
  PLATFORM_DEPENDENCY_UNAVAILABLE: "虚拟文件树还没有装配，共享盘暂不可用",
  PLATFORM_INTEGRITY_FAILED: "数据完整性校验失败",
  PLATFORM_DNS_FAILED: "网络解析失败",
  PLATFORM_RESTORE_FAILED: "恢复快照失败",
  PLATFORM_INTERNAL: "平台服务内部错误",
  DXOS_ERR_INTERNAL: "平台服务内部错误",
};

export function platformBridge(): PlatformBridge | null {
  if (typeof window === "undefined") return null;
  const api = (window.openarc as { platform?: PlatformBridge } | undefined)?.platform;
  return api && typeof api.command === "function" ? api : null;
}

export async function platformCommand(command: string, payload: Record<string, unknown> = {}): Promise<PlatformResult> {
  const bridge = platformBridge();
  if (!bridge) return { ok: false, error: "NO_BRIDGE" };
  try {
    const res = (await bridge.command({ command, payload })) as PlatformResult | null;
    return res && typeof res === "object" ? res : { ok: false, error: "PLATFORM_INTERNAL" };
  } catch (error) {
    return { ok: false, error: "PLATFORM_INTERNAL", message: String((error as Error)?.message || error) };
  }
}

export function platformErrorText(res: PlatformResult | null): string {
  if (!res) return "平台服务没有返回结果";
  const code = String(res.error || "PLATFORM_INTERNAL");
  const message = typeof res.message === "string" && res.message.trim() ? res.message.trim() : PLATFORM_ERROR_TEXT[code] || "平台服务调用失败";
  const detail = typeof res.detail === "string" && res.detail.trim() ? res.detail.trim() : "";
  const suffix = code === "NO_BRIDGE" ? "" : "（" + code + "）";
  return message + (detail && detail !== message ? "：" + detail : "") + suffix;
}

export function platformErrorCode(res: PlatformResult | null): string {
  return String((res && res.error) || "PLATFORM_INTERNAL");
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** 把后端安全节点投影转成界面用的对象；缺 id/name 的条目直接丢弃（不猜）。 */
export function sharedNodeOf(value: unknown): SharedNode | null {
  const node = recordOf(value);
  const id = textOf(node.id);
  const name = textOf(node.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    type: textOf(node.type) || "file",
    mime: textOf(node.mime) || null,
    size: numberOf(node.size),
    parentId: textOf(node.parentId) || null,
    share: textOf(node.share) || null,
    ownerId: textOf(node.ownerId) || null,
    system: node.system === true,
    createdAt: numberOf(node.createdAt),
    updatedAt: numberOf(node.updatedAt),
  };
}

export function sharedNodesOf(value: unknown): SharedNode[] {
  return Array.isArray(value) ? value.map(sharedNodeOf).filter((node): node is SharedNode => !!node) : [];
}

export function sharedSearchHitsOf(value: unknown): SharedSearchHit[] {
  if (!Array.isArray(value)) return [];
  const out: SharedSearchHit[] = [];
  for (const raw of value) {
    const row = recordOf(raw);
    const id = textOf(row.id);
    const name = textOf(row.name);
    if (!id || !name) continue;
    const hit: SharedSearchHit = { id, name, type: textOf(row.type) || "file" };
    const path = textOf(row.path);
    const snippet = textOf(row.snippet);
    if (path) hit.path = path;
    if (snippet) hit.snippet = snippet;
    out.push(hit);
  }
  return out;
}

export function shareLabel(share: string | null): string {
  if (share === "public") return "公共";
  if (share && share.startsWith("department:")) return "部门";
  return "共享";
}

export function formatSharedBytes(value: unknown): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1073741824).toFixed(2) + " GB";
}

export function formatSharedTime(value: unknown): string {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  const ms = ts > 1e12 ? ts : ts * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
}
