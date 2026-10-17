/**
 * 域命令桥的共用外壳（developer / integration / ocr / systemFonts / fileTransfer / desktop / cli）。
 *
 * 只做三件事：取 window.openarc.<domain> 的命令面、把调用异常折成稳定的本地失败信封、
 * 把后端的失败码翻成中文。**不缓存、不写状态**；每个页面自己持有真实返回值。
 * 结构检查失败一律 fail closed（返回 null），绝不把其它形状当命令桥用。
 */
export type DomainName =
  | "developer"
  | "integration"
  | "ocr"
  | "systemFonts"
  | "fileTransfer"
  | "desktop"
  | "cli"
  | "agent";

export type CommandReply = Record<string, unknown> & { ok?: boolean };

export type DomainBridge = {
  command: (command: { command: string; payload?: Record<string, unknown> }) => Promise<CommandReply>;
};

export type FailureView = { code: string; message: string; detail?: unknown };

/** 从宿主取某个域的命令面；不是 { command: fn } 形状即视为没有这条桥。 */
export function domainBridge(host: unknown, domain: DomainName): DomainBridge | null {
  if (!host || typeof host !== "object") return null;
  const openarc = (host as { openarc?: unknown }).openarc;
  if (!openarc || typeof openarc !== "object") return null;
  const candidate = (openarc as Record<string, unknown>)[domain];
  if (!candidate || typeof candidate !== "object") return null;
  const command = (candidate as { command?: unknown }).command;
  if (typeof command !== "function") return null;
  const bridge = candidate as DomainBridge;
  return { command: (payload) => bridge.command(payload) };
}

/** 渲染层自造的失败信封：码前缀与后端区分，界面上仍按普通失败显示。 */
export function localFailure(code: string, detail?: unknown): FailureView {
  return { code, message: "", detail };
}

export function resultValue<T>(reply: unknown): T | null {
  if (!reply || typeof reply !== "object") return null;
  if ((reply as { ok?: unknown }).ok !== true) return null;
  const value = (reply as { value?: unknown }).value;
  return (value === undefined ? null : value) as T | null;
}

export function resultFailure(reply: unknown): FailureView | null {
  if (!reply || typeof reply !== "object") return localFailure("MALFORMED_REPLY");
  if ((reply as { ok?: unknown }).ok === true) return null;
  const code = (reply as { error?: unknown }).error;
  const message = (reply as { message?: unknown }).message;
  const detail = (reply as { detail?: unknown }).detail;
  const view: FailureView = {
    code: typeof code === "string" && code ? code : "DXOS_ERR_INTERNAL",
    message: typeof message === "string" ? message : "",
  };
  if (detail !== undefined) view.detail = detail;
  return view;
}

/** 统一调用入口：没有桥、桥抛异常、返回值畸形都折成可展示的失败信封。 */
export async function invokeDomain(
  domain: DomainName,
  command: string,
  payload: Record<string, unknown> = {},
  host: unknown = typeof window === "undefined" ? null : window,
): Promise<CommandReply> {
  const bridge = domainBridge(host, domain);
  if (!bridge) return { ok: false, error: "BRIDGE_ABSENT" };
  try {
    return await bridge.command({ command, payload });
  } catch (error) {
    return { ok: false, error: "BRIDGE_ERROR", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** 跨域共用的错误码文案；各域专属码在各自页面里补充，未知码走兜底。 */
const COMMON_FAILURE_TEXT: Record<string, string> = {
  BRIDGE_ABSENT: "当前环境没有这条原生桥（浏览器预览不提供），请在 OpenArc 桌面应用里使用。",
  BRIDGE_ERROR: "命令没有送达主进程，桥在调用时抛错。",
  MALFORMED_REPLY: "主进程返回的形状不完整，界面不会猜测内容。",
  UNREADY: "该域尚未装配。",
  NOT_READY: "该域尚未装配。",
  UNAUTHENTICATED: "当前会话未认证，命令被拒绝；重新登录后再试。",
  FORBIDDEN: "当前账号或这个应用没有被授予该动作。",
  INVALID_INPUT: "输入不完整或不符合要求。",
  NOT_FOUND: "目标不存在，可能已被移除。",
  CONFLICT: "与当前状态冲突，请刷新后重试。",
  INTERNAL: "主进程执行失败，没有返回可用的结果。",
  DXOS_ERR_INTERNAL: "主进程执行失败，没有返回可用的结果。",
  TIMEOUT: "操作超时，实际副作用未知，请先核对结果再重试。",
};

/** 失败码 → 人话；后端 message 优先（它已经是中文），否则按码兜底。code 永远不进正文。 */
export function failureText(view: FailureView | null): string {
  if (!view) return "";
  if (view.message) return view.message;
  const code = String(view.code || "");
  if (COMMON_FAILURE_TEXT[code]) return COMMON_FAILURE_TEXT[code];
  const suffix = code.split("_").pop() || code;
  return COMMON_FAILURE_TEXT[suffix] || "操作失败；具体原因已记录在下方明细里。";
}

/** 明细里的一行可展示文本（detail 可能是字符串、对象或数组，不做过度格式化）。 */
export function detailText(detail: unknown): string {
  if (detail === undefined || detail === null) return "";
  if (typeof detail === "string") return detail;
  if (typeof detail === "number" || typeof detail === "boolean") return String(detail);
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export function formatBytes(bytes: unknown): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + " MB";
  return (n / 1024 ** 3).toFixed(2) + " GB";
}

export function formatTime(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return new Date(n).toLocaleString("zh-CN", { hour12: false });
}
