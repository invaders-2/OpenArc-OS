/**
 * 画布宿主浮层（协作 / .dxcanvas 打包）的纯函数层。
 *
 * 与 canvasShareModel.ts 同一分工：组件只做状态与渲染，错误文案、字节编解码、
 * 文件名与事件摘要都放在这里，便于单独核对「不伪造」口径：
 *   · 命令失败只按后端真实 error / detail 生成文案，不把失败当成功；
 *   · .dxcanvas 内联上限取后端 canvas-dxos-commands.cjs 的 32MB，绝不截断；
 *   · 下载文件名只由画布标题与 canvasId 组成，不含绝对路径。
 */

export type Cmd = (payload: Record<string, unknown>) => Promise<any>;

/** 与 electron/canvas-dxos-commands.cjs 的 MAX_INLINE_PACKAGE_BYTES 同一个值。 */
export const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;

const HOST_ERROR_TEXT: Record<string, string> = {
  NO_BRIDGE: "画布桥没有接入（宿主不可用）",
  CANVAS_UNAVAILABLE: "画布服务未装配（后端不可用）",
  CANVAS_COMMAND_NOT_ALLOWED: "当前构建没有登记这条画布命令（不可用）",
  NOT_IMPLEMENTED: "后端没有实现这条画布命令（不可用）",
  NOT_FOUND: "这本画布已经不存在或无法打开",
  NOT_FOUND_OR_FORBIDDEN: "这本画布已不可访问（可能已被移出共享或删除）",
  READ_ONLY: "当前是只读权限，不能执行这个操作",
  FORBIDDEN: "没有权限执行这个操作",
  INVALID_INPUT: "请求内容不完整或不正确",
  LIMIT_EXCEEDED: "超过后端上限",
  REVISION_CONFLICT: "版本冲突：画布在别处被修改过",
  INTERNAL_ERROR: "画布服务内部出错",
};

/** 结构化失败 → 中文原因（保留后端错误码，不吞掉 detail）。 */
export function hostCommandError(res: any, fallback: string): string {
  const code = res && typeof res === "object" ? String(res.error || "") : "";
  const known = HOST_ERROR_TEXT[code];
  if (known) return known + (code ? "（" + code + "）" : "");
  const detail = res && typeof res === "object" && res.detail != null ? "：" + String(res.detail).slice(0, 160) : "";
  return fallback + (code ? "（" + code + detail + "）" : "");
}

export function formatBytes(value: unknown): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "大小未知";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

/** 分块编码，避免 String.fromCharCode(...array) 对 32MB 数据一次性展开。 */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** 下载文件名：画布标题（去掉文件系统保留字符）+ 短 canvasId，不含任何路径。 */
export function packageFileName(title: string | undefined, canvasId: string): string {
  const base = String(title || "画布").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 60) || "画布";
  const shortId = String(canvasId || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16);
  return base + (shortId ? "-" + shortId : "") + ".dxcanvas";
}

export type CollabEventView = { key: string; text: string };

/** 协作下行事件 → 一行可读摘要（只描述事件本身，不推断谁在编辑什么）。 */
export function collabEventView(event: any, index: number): CollabEventView {
  const type = String((event && event.type) || "unknown");
  const clientId = String((event && (event.sourceClientId || event.clientId)) || "");
  const name = String((event && event.username) || "") || (clientId ? "客户端 " + clientId.slice(0, 12) : "其他设备");
  if (type === "cursor") {
    const x = Number(event && event.x);
    const y = Number(event && event.y);
    const where = Number.isFinite(x) && Number.isFinite(y) ? "（" + Math.round(x) + ", " + Math.round(y) + "）" : "";
    return { key: type + ":" + clientId + ":" + index, text: "光标 · " + name + where };
  }
  if (type === "patch") {
    const revision = Number(event && event.revision);
    return { key: type + ":" + clientId + ":" + index, text: "补丁 · " + name + (Number.isFinite(revision) ? " revision " + revision : "") };
  }
  if (type === "presence") return { key: type + ":" + index, text: "在线状态变化" };
  return { key: type + ":" + index, text: type };
}
