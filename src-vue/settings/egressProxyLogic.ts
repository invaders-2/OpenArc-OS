/**
 * 「模型与服务商」› 模型出网代理 · 纯逻辑（无网络、无存储、无 Vue 依赖）。
 *
 * 与主进程 electron/model-domain.cjs#validateProxyUrl 同口径：
 *   · 只接受 http(s)://host:port；必须显式端口；不得带路径 / 查询 / 锚点 / 用户名密码。
 * 界面只做**提交前拦截**（结构化提示）；最终校验仍在主进程（model/proxy/set）。
 */

export const EGRESS_PROXY_DEFAULT_URL = "http://127.0.0.1:7897";

/** 结构化错误码 → 中文说明。文案里保留原始码，便于用户照着报错定位。 */
export const EGRESS_PROXY_ERROR_TEXT: Record<string, string> = {
  PROXY_AUTH_REQUIRED: "代理要求认证（HTTP 407）。当前不支持带认证的代理，请改用免认证的本地代理",
  PROXY_UNREACHABLE: "连不上代理：地址或端口不对，或代理没在运行",
  PROXY_TUNNEL_FAILED: "代理隧道建立失败（CONNECT 被拒或 TLS 握手失败）",
  PROXY_TIMEOUT: "代理无响应，连接超时",
  PROXY_CONFIG_INVALID: "代理配置无效",
  PROXY_NOT_SUPPORTED: "该请求或代理方式暂不支持",
  PROXY_UNAUTHORIZED: "没有权限修改模型出网代理（需要模型管理权限）",
  CANCELLED: "请求已取消",
  INVALID_INPUT: "地址格式不对：需要 http(s)://主机:端口，且不带路径、查询与用户名密码",
  INTERNAL_ERROR: "写入失败，请重试",
  NO_BRIDGE: "模型桥未就绪",
};

/** 未知码原样返回（不编造解释）。 */
export function egressProxyErrorText(code: string | null | undefined): string {
  const key = String(code == null ? "" : code);
  if (!key) return "没有返回错误码";
  return EGRESS_PROXY_ERROR_TEXT[key] ? EGRESS_PROXY_ERROR_TEXT[key] + "（" + key + "）" : key;
}

export type EgressProxyDraftCheck = { ok: boolean; code: string | null; message: string; url: string | null };

/** 提交前校验；返回发往主进程的归一 url（关闭时为 null）。 */
export function validateEgressProxyDraft(draft: { enabled?: boolean; url?: string } | null | undefined): EgressProxyDraftCheck {
  const enabled = !!(draft && draft.enabled === true);
  if (!enabled) return { ok: true, code: null, message: "", url: null };
  const raw = String((draft && draft.url) || "").trim();
  if (!raw) return { ok: false, code: "INVALID_INPUT", message: "请填写代理地址，例如 " + EGRESS_PROXY_DEFAULT_URL, url: null };
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return { ok: false, code: "INVALID_INPUT", message: "地址格式不对，需要 http(s)://主机:端口", url: null }; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, code: "INVALID_INPUT", message: "只支持 http:// 或 https:// 代理（不支持 SOCKS 等）", url: null };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, code: "INVALID_INPUT", message: "不支持带用户名/密码的代理（当前不支持认证代理）", url: null };
  }
  if (!parsed.port) return { ok: false, code: "INVALID_INPUT", message: "必须写明端口，例如 " + EGRESS_PROXY_DEFAULT_URL, url: null };
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, code: "INVALID_INPUT", message: "端口不合法", url: null };
  if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
    return { ok: false, code: "INVALID_INPUT", message: "代理地址不能带路径、查询参数或锚点", url: null };
  }
  return { ok: true, code: null, message: "", url: parsed.origin };
}

/** 开关状态视图：tone 只取 DsBadge 支持的四态。 */
export function egressProxyStatusView(state: { enabled?: boolean; url?: string | null } | null | undefined): { tone: "neutral" | "success" | "warning"; label: string; detail: string } {
  if (state && state.enabled === true) {
    return {
      tone: "success",
      label: "已启用",
      detail: "模型与协议请求将经 " + (state.url ? String(state.url) : "（未填写地址）") + " 转发；仅用于模型与协议请求。",
    };
  }
  return { tone: "neutral", label: "已关闭", detail: "仅用于模型与协议请求；默认关闭。" };
}

/** model/proxy/get|set 回包投影：字段缺失不补造；失败给中文原因。 */
export function normalizeEgressProxyResult(result: unknown): { enabled: boolean; url: string | null; problem: string | null; changed: boolean | null } {
  const res = result && typeof result === "object" ? (result as Record<string, unknown>) : null;
  if (!res || res.ok !== true) {
    const code = res && res.error ? String(res.error) : null;
    return { enabled: false, url: null, problem: code ? egressProxyErrorText(code) : "模型桥没有返回结果", changed: null };
  }
  const url = typeof res.url === "string" && res.url.trim() ? res.url.trim() : null;
  const enabled = res.enabled === true;
  return { enabled, url, problem: null, changed: typeof res.changed === "boolean" ? res.changed : null };
}
