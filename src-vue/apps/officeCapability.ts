/**
 * 文稿 / 相册共用的 Office（docx / xlsx）解析能力探测。
 *
 * 为什么走这条命令而不是前端猜依赖：本仓确实没有 adm-zip / exceljs（见
 * electron/canvas-dxos-agent-attachments.cjs 的硬约束），唯一真实的"当前构建能否解析 docx/xlsx"
 * 事实来自 canvas/agentAttachments/extract 的返回：扩展名命中时它给出结构化 parseError。
 * 这里只把那条真实结果归一成 UI 状态，不伪造"可用"，也不在两条命令之间做假缓存。
 */
export type OfficeFormatStatus = { available: boolean; error: string | null };
export type OfficeCapability = {
  checked: boolean;
  docx: OfficeFormatStatus;
  xlsx: OfficeFormatStatus;
  failure: { code: string; detail?: unknown } | null;
};

type CanvasBridgeHost = {
  openarc?: {
    canvas?: { command?: (command: Record<string, unknown>) => Promise<unknown> };
  };
};

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const UNKNOWN = (): OfficeCapability => ({
  checked: false,
  docx: { available: false, error: null },
  xlsx: { available: false, error: null },
  failure: null,
});

/** 用空字节触发"扩展名命中"分支；后端只按扩展名返回解析依赖缺失，不会读取内容。 */
export async function probeOfficeCapability(host: CanvasBridgeHost | null = typeof window === "undefined" ? null : (window as unknown as CanvasBridgeHost)): Promise<OfficeCapability> {
  const canvas = host && host.openarc && host.openarc.canvas ? host.openarc.canvas : null;
  if (!canvas || typeof canvas.command !== "function") {
    return { ...UNKNOWN(), checked: true, failure: { code: "BRIDGE_ABSENT" } };
  }
  let reply: any;
  try {
    reply = await canvas.command({
      type: "canvas/agentAttachments/extract",
      files: [
        { name: "office-probe.docx", mime: DOCX_MIME, base64: "" },
        { name: "office-probe.xlsx", mime: XLSX_MIME, base64: "" },
      ],
    });
  } catch (error) {
    return { ...UNKNOWN(), checked: true, failure: { code: "BRIDGE_ERROR", detail: error instanceof Error ? error.message : String(error) } };
  }
  if (!reply || typeof reply !== "object" || reply.ok !== true) {
    const code = reply && typeof reply === "object" && typeof reply.error === "string" ? reply.error : "PROBE_FAILED";
    return { ...UNKNOWN(), checked: true, failure: { code, detail: reply && typeof reply === "object" ? reply.detail : null } };
  }
  const attachments = Array.isArray(reply.attachments) ? reply.attachments : [];
  const pick = (name: string): OfficeFormatStatus => {
    const item = attachments.find((entry: any) => entry && entry.name === name);
    const error = item && typeof item.error === "string" && item.error ? item.error : null;
    return { available: !!item && !error, error };
  };
  return { checked: true, docx: pick("office-probe.docx"), xlsx: pick("office-probe.xlsx"), failure: null };
}

/** 界面一行摘要（正文只放结论，原始错误放 title / data-*）。 */
export function officeCapabilityLabel(capability: OfficeCapability | null): string {
  if (!capability) return "docx/xlsx：探测中…";
  if (capability.failure) return "docx/xlsx：无法探测（" + capability.failure.code + "）";
  const docx = capability.docx.available;
  const xlsx = capability.xlsx.available;
  if (docx && xlsx) return "docx/xlsx：可解析";
  return "docx/xlsx：不可用（当前构建未包含解析依赖）";
}

/** 悬浮提示：把后端原文一并给出，避免只看到结论。 */
export function officeCapabilityDetail(capability: OfficeCapability | null): string {
  if (!capability) return "";
  if (capability.failure) return capability.failure.code + (capability.failure.detail == null ? "" : "：" + String(capability.failure.detail));
  return [capability.docx.error, capability.xlsx.error].filter(Boolean).join("\n");
}
