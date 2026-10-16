/**
 * 「添加 / 编辑服务商」共享纯逻辑（无 DOM / 无网络）。
 *
 * 后端事实（只读核对 electron/model-bootstrap.cjs 与 electron/model-service.cjs）：
 *   provider/create → displayName / baseUrl / endpointScope / scope / allowInsecureHttp / credentialSecret
 *   provider/update → providerId / displayName / baseUrl / endpointScope / status / allowInsecureHttp / credentialSecret / scope
 *                     **scope 是可选入参**：仅 PERSONAL / ORGANIZATION；任何范围变更后端要求超级管理员，
 *                     且会同步迁移该服务商下已有模型的范围与归属（非管理员返回 PROXY_UNAUTHORIZED）。
 *   provider/update 用 Object.prototype.hasOwnProperty 区分 allowInsecureHttp 的「未传」与「显式 false」：
 *     传 false 才会真正把 allow_insecure_http 清零；省略则保留旧值。因此编辑 payload 必须显式带布尔。
 *   credential/replace 换密钥；凭据与 base_url 的 origin 绑定，跨 origin 改地址后旧凭据不再匹配。
 *
 * 本模块只做输入校验与 payload 组装，所有落库判断交给后端（不在界面里假装成功）。
 */

export type ProviderFormMode = "create" | "edit";

export interface ProviderDraft {
  providerId?: string;
  displayName: string;
  baseUrl: string;
  endpointScope?: string;
  scope: string;
  status?: string;
  allowInsecureHttp: boolean;
  credentialSecret?: string;
  /** ModelStore 的协议字段；provider/create|update 透传，镜像桥 mapProtocol 消费。缺省 openai-compatible。 */
  adapterType?: string;
  /** 纯界面字段：single = 一把 API Key；dual = access_key + secret_key（见 providerPresets.ts）。不发给后端。 */
  credentialMode?: string;
}

export interface ProviderDraftFieldErrors {
  displayName?: string;
  baseUrl?: string;
  insecureHttp?: string;
  scope?: string;
}

export interface ProviderDraftValidation {
  ok: boolean;
  /** 与后端错误码同名字符串；界面直接用它当 data-d4-01-error-code。 */
  code: string | null;
  fieldErrors: ProviderDraftFieldErrors;
  needsInsecureOptIn: boolean;
  origin: string | null;
  originChanged: boolean;
  /** 改地址跨 origin 且服务商已有密钥、但这次没填新密钥：保存后旧密钥仍绑旧地址。 */
  requiresNewCredential: boolean;
}

/** loopback 与私网 http 本来就被 validateEndpoint 允许，不是「不安全 HTTP」开关的适用范围。 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/** 只有公网 http（非 loopback、非私网）才需要用户显式勾选「允许不安全 HTTP」。 */
export function isPlainRemoteHttp(value: unknown): boolean {
  try {
    const url = new URL(String(value == null ? "" : value).trim());
    if (url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase();
    return !LOOPBACK_HOSTS.has(host) && !PRIVATE_V4.test(host);
  } catch {
    return false;
  }
}

/** 「添加」与「编辑」共用同一条必选判定。 */
export function needsInsecureOptIn(value: unknown): boolean {
  return isPlainRemoteHttp(value);
}

/** origin 唯一口径：URL origin；非法地址返回 null（与后端 domain.originOf 同口径）。 */
export function originOf(value: unknown): string | null {
  try {
    const origin = new URL(String(value == null ? "" : value).trim()).origin;
    return origin && origin !== "null" ? origin : null;
  } catch {
    return null;
  }
}

export const PROVIDER_SCOPE_OPTIONS = [
  { id: "PERSONAL", label: "个人" },
  { id: "ORGANIZATION", label: "组织" },
] as const;

export type ProviderScope = (typeof PROVIDER_SCOPE_OPTIONS)[number]["id"];

export function isProviderScope(value: unknown): value is ProviderScope {
  return PROVIDER_SCOPE_OPTIONS.some((option) => option.id === value);
}

export function providerScopeLabel(value: unknown): string {
  const found = PROVIDER_SCOPE_OPTIONS.find((option) => option.id === value);
  return found ? found.label : String(value == null ? "" : value);
}

/** 任何范围变更都需管理员（与后端「创建组织需要超级管理员」同口径）。 */
export function isScopeChange(initial: unknown, next: unknown): boolean {
  return !!initial && !!next && String(initial) !== String(next);
}

/** 保存中禁用范围选择；后端才是权限裁决者，界面不假装成功、不静默回滚。 */
export function scopeSelectDisabled(options: { busy?: boolean } = {}): boolean {
  return options.busy === true;
}

export const PROVIDER_SCOPE_HINT_CREATE = "个人只对自己生效；组织需要管理员";
export const PROVIDER_SCOPE_HINT_EDIT = "组织需要管理员；改范围会一并调整该服务商下已有模型的范围与归属";

export function providerScopeHint(mode: ProviderFormMode): string {
  return mode === "edit" ? PROVIDER_SCOPE_HINT_EDIT : PROVIDER_SCOPE_HINT_CREATE;
}

export const PROVIDER_STATUS_OPTIONS = [
  { id: "enabled", label: "启用" },
  { id: "disabled", label: "停用" },
] as const;

export const PROVIDER_INSECURE_WARNING =
  "该站点使用明文 HTTP，地址、API 密钥与请求内容在链路上没有加密，可能被中间人读取或篡改。只在你自建 / 自控、且确认链路可信时才勾选。";

/**
 * 与「添加」同一套字段与校验：
 *   · 名称 / API 地址必填，地址必须是合法 http(s) URL（INVALID_INPUT）；
 *   · 公网明文 http 必须显式勾选，否则 ENDPOINT_BLOCKED（与后端同一错误码）。
 */
export function validateProviderDraft(
  draft: ProviderDraft,
  options: { initialBaseUrl?: string | null; credentialConfigured?: boolean } = {},
): ProviderDraftValidation {
  const displayName = String(draft.displayName == null ? "" : draft.displayName).trim();
  const baseUrl = String(draft.baseUrl == null ? "" : draft.baseUrl).trim();
  const scope = String(draft.scope == null ? "PERSONAL" : draft.scope).trim();
  const origin = originOf(baseUrl);
  const optIn = needsInsecureOptIn(baseUrl);
  const initialOrigin = options.initialBaseUrl ? originOf(options.initialBaseUrl) : null;
  const fieldErrors: ProviderDraftFieldErrors = {};

  if (!displayName) fieldErrors.displayName = "请填写名称";
  if (!baseUrl) fieldErrors.baseUrl = "请填写 API 地址";
  else if (!origin) fieldErrors.baseUrl = "地址不是合法的 http(s) URL";
  if (!isProviderScope(scope)) fieldErrors.scope = "范围只能是个人或组织";
  if (optIn && draft.allowInsecureHttp !== true) {
    fieldErrors.insecureHttp = "这是公网明文 HTTP 地址：必须勾选「允许不安全 HTTP（明文直连）」才能保存";
  }

  let code: string | null = null;
  if (fieldErrors.displayName || fieldErrors.baseUrl || fieldErrors.scope) code = "INVALID_INPUT";
  else if (fieldErrors.insecureHttp) code = "ENDPOINT_BLOCKED";

  const originChanged = !!(initialOrigin && origin && initialOrigin !== origin);
  const secret = String(draft.credentialSecret == null ? "" : draft.credentialSecret);
  const requiresNewCredential = originChanged && options.credentialConfigured === true && !secret;

  return { ok: code === null, code, fieldErrors, needsInsecureOptIn: optIn, origin, originChanged, requiresNewCredential };
}

/** provider/create payload；与既有实现一致：非公网明文时该开关恒为 false。 */
export function buildProviderCreatePayload(draft: ProviderDraft): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    displayName: String(draft.displayName == null ? "" : draft.displayName).trim(),
    baseUrl: String(draft.baseUrl == null ? "" : draft.baseUrl).trim(),
    // adapterType 必须显式发送：后端 provider/create 默认 openai-compatible，预设选了协议不传就等于没选。
    adapterType: normalizeAdapterType(draft.adapterType),
    endpointScope: draft.endpointScope || "LOCALHOST",
    scope: draft.scope || "PERSONAL",
    allowInsecureHttp: needsInsecureOptIn(draft.baseUrl) && draft.allowInsecureHttp === true,
  };
  const secret = String(draft.credentialSecret == null ? "" : draft.credentialSecret);
  if (secret) payload.credentialSecret = secret;
  return payload;
}

/**
 * provider/update payload。
 * allowInsecureHttp 必须**每次显式带布尔**：后端用 hasOwnProperty 判定，省略会保留旧值，
 * 只有显式 false 才会把 allow_insecure_http 真正清零（不是仅界面变化）。
 * scope 每次显式携带：后端只在「与旧值不同」时要求超级管理员，同值不改不算变更。
 */
export function buildProviderUpdatePayload(draft: ProviderDraft): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    providerId: String(draft.providerId == null ? "" : draft.providerId),
    displayName: String(draft.displayName == null ? "" : draft.displayName).trim(),
    baseUrl: String(draft.baseUrl == null ? "" : draft.baseUrl).trim(),
    status: draft.status || "enabled",
    allowInsecureHttp: draft.allowInsecureHttp === true,
    scope: isProviderScope(draft.scope) ? draft.scope : "PERSONAL",
  };
  // 后端 updateProvider 只在 adapterType 显式给了才改、缺省沿用原值；编辑表单始终带上当前值，
  // 因此「只改名不改协议」不会被预设误改（预设只在用户点击时写进表单）。
  if (String(draft.adapterType == null ? "" : draft.adapterType).trim()) payload.adapterType = normalizeAdapterType(draft.adapterType);
  if (draft.endpointScope) payload.endpointScope = draft.endpointScope;
  return payload;
}

/**
 * 提交装配（create / edit 共用）：
 *   · create 的凭据随 payload 一次落库（provider/create 的 credentialSecret）；
 *   · edit 的凭据由上层走 credential/replace，不进 update payload。
 * 双密钥（Lovart）的组合值是在表单里算出来的，必须显式塞进 create payload —— 只挂在事件上会被丢掉。
 */
export function buildProviderSubmitPayload(
  mode: ProviderFormMode,
  draft: ProviderDraft,
  credentialSecret: unknown,
): { payload: Record<string, unknown>; credentialSecret: string } {
  const secret = String(credentialSecret == null ? "" : credentialSecret);
  if (mode === "edit") return { payload: buildProviderUpdatePayload(draft), credentialSecret: secret };
  const payload = buildProviderCreatePayload(draft);
  if (secret) payload.credentialSecret = secret;
  return { payload, credentialSecret: secret };
}

export function providerDraftFromProvider(provider: any): ProviderDraft {
  const p = provider && typeof provider === "object" ? provider : {};
  return {
    providerId: p.providerId ? String(p.providerId) : "",
    displayName: p.displayName ? String(p.displayName) : "",
    baseUrl: p.baseUrl ? String(p.baseUrl) : "",
    endpointScope: p.endpointScope ? String(p.endpointScope) : "LOCALHOST",
    scope: p.scope ? String(p.scope) : "PERSONAL",
    status: p.status ? String(p.status) : "enabled",
    allowInsecureHttp: p.allowInsecureHttp === true,
    credentialSecret: "",
    adapterType: p.adapterType ? String(p.adapterType) : DEFAULT_ADAPTER_TYPE,
    credentialMode: "single",
  };
}

export const DEFAULT_ADAPTER_TYPE = "openai-compatible";

/** adapterType 归一：空值落到 openai-compatible（与后端 createProvider 默认值同口径）。 */
export function normalizeAdapterType(value: unknown): string {
  return String(value == null ? "" : value).trim() || DEFAULT_ADAPTER_TYPE;
}

export function blankProviderDraft(): ProviderDraft {
  return { providerId: "", displayName: "", baseUrl: "", endpointScope: "LOCALHOST", scope: "PERSONAL", status: "enabled", allowInsecureHttp: false, credentialSecret: "", adapterType: DEFAULT_ADAPTER_TYPE, credentialMode: "single" };
}
