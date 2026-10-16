/**
 * 「协议设置」纯逻辑（无 DOM / 无网络）。
 *
 * 后端事实（electron/provider-protocol-service.cjs:83-131，IPC 见 electron/model-bootstrap.cjs）：
 *   protocol/list     → { ok, items:[{id,kind,label,engine,source,activeVersion,activeHash,capabilities,ported,execution,unavailableReason?}], shadowedLegacy }
 *   protocol/get      → { ok, version, hash, protocol } | { ok:false, error:"PROTOCOL_NOT_FOUND" }
 *   protocol/validate → { ok:true, protocol } | { ok:false, error:"PROTOCOL_INVALID", issues:[string] }
 *   protocol/save     → { ok:true, entry } | { ok:false, error:"PROTOCOL_SAVE_REJECTED", detail }
 *
 * 本模块只做「如实转述」：不把 legacy 没有声明体的地方编造成有声明，
 * 不把 backend 没给的 execution/ported 猜成可用。
 */

export type ProtocolTone = "neutral" | "success" | "warning" | "danger";

export interface ProtocolExecutionView {
  execution: string | null;
  label: string;
  tone: ProtocolTone;
  detail: string;
}

/** execution 五值（含缺失）如实标注；conditional / unavailable 必须带出后端给的前提。 */
export function protocolExecutionView(entry: any): ProtocolExecutionView {
  const execution = entry && typeof entry.execution === "string" ? entry.execution : null;
  const reason = entry && entry.unavailableReason != null && String(entry.unavailableReason).trim()
    ? String(entry.unavailableReason)
    : "";
  switch (execution) {
    case "declarative":
      return { execution, label: "声明式可执行", tone: "success", detail: "v2 声明式引擎定义，可直接执行。" };
    case "available":
      return { execution, label: "内置实现，可直接执行", tone: "success", detail: "legacy 执行分支自身完整，可直接执行。" };
    case "conditional":
      return { execution, label: "需要前提", tone: "warning", detail: reason || "需要额外前提（后端未给出前提说明），界面不假设它可执行。" };
    case "unavailable":
      return { execution, label: "当前不可执行", tone: "danger", detail: reason || "后端标注为不可执行，且没有给出原因。" };
    default:
      return { execution: null, label: "未标注", tone: "neutral", detail: "后端没有返回 execution 字段，界面不推断可执行性。" };
  }
}

export function protocolEngineText(engine: unknown): string {
  const value = String(engine ?? "").trim();
  if (value === "v2") return "声明式引擎（v2）";
  if (value === "legacy") return "内置执行器（legacy）";
  return value || "未返回";
}

export function protocolPortedText(ported: unknown): string {
  if (ported === true) return "已移植";
  if (ported === false) return "未移植";
  return "未返回";
}

export function protocolSourceText(source: unknown): string {
  const value = String(source ?? "").trim();
  if (!value) return "未返回";
  if (value === "builtin" || value === "system") return "内置";
  if (value === "user" || value === "custom") return "自建";
  if (value === "plugin") return "插件";
  return value;
}

/** 协议域错误码 → 中文；原始码不上屏（界面把它放进 data-* 属性）。 */
export const PROTOCOL_ERROR_TEXT: Readonly<Record<string, string>> = {
  PROTOCOL_INVALID: "协议定义没有通过校验",
  PROTOCOL_SAVE_REJECTED: "协议保存被拒绝",
  PROTOCOL_NOT_READY: "协议后端还没有就绪",
  PROTOCOL_NOT_FOUND: "没有这个协议（legacy 协议由内置执行器直接实现，没有可展示的声明式定义体）",
  PROTOCOL_EXECUTION_FAILED: "协议执行失败",
  MODEL_COMMAND_NOT_ALLOWED: "这个命令不在允许清单里",
  INVALID_INPUT: "输入不完整或格式不对",
  NO_BRIDGE: "模型桥还没有接入（当前版本未提供 model 桥）",
  DXOS_ERR_INTERNAL: "内部错误",
};

export function protocolSettingsErrorText(code: unknown): string {
  const key = String(code ?? "").trim();
  if (!key) return "协议操作失败（后端没有返回错误码）";
  return PROTOCOL_ERROR_TEXT[key] ?? "协议操作失败（后端返回了未登记的错误码）";
}

/** 校验 issues 逐条转文案；后端给的就是中文串，这里只做保底，不改写。 */
export function protocolIssueText(issue: unknown): string {
  if (typeof issue === "string") return issue.trim();
  if (issue && typeof issue === "object") {
    const message = (issue as any).message ?? (issue as any).detail;
    if (typeof message === "string" && message.trim()) return message.trim();
    try {
      return JSON.stringify(issue);
    } catch {
      return "无法解析的校验问题";
    }
  }
  return issue == null ? "" : String(issue);
}

export interface ProtocolValidateView {
  ok: boolean;
  code: string | null;
  issues: string[];
  text: string;
}

/** protocol/validate 回包：通过就说通过；失败必须把逐条 issues 如实列出。 */
export function protocolValidateView(reply: any): ProtocolValidateView {
  if (reply && reply.ok === true) return { ok: true, code: null, issues: [], text: "协议通过校验，可以保存。" };
  const code = reply && reply.error ? String(reply.error) : "DXOS_ERR_INTERNAL";
  const rawIssues = reply && Array.isArray(reply.issues) ? reply.issues : [];
  const issues = rawIssues.map(protocolIssueText).filter((item: string) => item.length > 0);
  const head = protocolSettingsErrorText(code);
  const text = issues.length
    ? head + "（逐条问题 " + issues.length + " 条）：" + issues.join("；")
    : head + "（后端没有返回逐条 issues）";
  return { ok: false, code, issues, text };
}

export interface ProtocolSaveView {
  ok: boolean;
  code: string | null;
  entryId: string | null;
  text: string;
}

export function protocolSaveView(reply: any): ProtocolSaveView {
  if (reply && reply.ok === true) {
    const entry = reply.entry;
    const rawId = entry && typeof entry === "object" ? (entry.id ?? entry.protocolId ?? null) : null;
    const entryId = rawId == null || rawId === "" ? null : String(rawId);
    return {
      ok: true,
      code: null,
      entryId,
      text: entryId ? "已保存自定义协议：" + entryId + "（写入本机协议库）。" : "已保存自定义协议（后端没有返回条目 id）。",
    };
  }
  const code = reply && reply.error ? String(reply.error) : "DXOS_ERR_INTERNAL";
  const detail = reply && reply.detail ? String(reply.detail) : "";
  return {
    ok: false,
    code,
    entryId: null,
    text: detail ? protocolSettingsErrorText(code) + "：" + detail : protocolSettingsErrorText(code),
  };
}

export interface ProtocolDraftParse {
  ok: boolean;
  value: any;
  message: string;
}

/** 草稿 JSON 解析：空草稿与语法错误都给出可执行的中文提示，不静默吞掉。 */
export function parseProtocolDraft(text: unknown): ProtocolDraftParse {
  const raw = String(text ?? "").trim();
  if (!raw) return { ok: false, value: null, message: "协议 JSON 是空的：先从列表里选一个 v2 协议，或直接粘贴一份定义。" };
  try {
    return { ok: true, value: JSON.parse(raw), message: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, value: null, message: "JSON 解析失败：" + message };
  }
}

/** 保存前必须知道 kind；从协议体里兜底取 id 只用于展示，不用于冒充 kind。 */
export function protocolDraftKind(text: unknown, fallback: unknown): string {
  const parsed = parseProtocolDraft(text);
  if (parsed.ok && parsed.value && typeof parsed.value.kind === "string" && parsed.value.kind.trim()) return parsed.value.kind.trim();
  return String(fallback ?? "").trim() || "model";
}
