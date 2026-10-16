/**
 * UI-5 · 模型与协议：纯逻辑层（无 React / 无 DOM / 无 I/O / 无网络）。
 *
 * 为什么单独拆一层：协议表过滤、protocol/get 摘要、manifest/get 子集投影、
 * 流式状态机（排队→开始→增量→用量→结束/错误/停止）以及"哪些字段没返回"都是
 * **可离线断言**的规则，界面上三个区块共用同一份判断。留在 .tsx 里就没法在不启动
 * 浏览器的情况下测；放在这里，tests/dxos-model-protocol-console.test.mjs 直接
 * import 真逻辑，界面上不会出现第二套口径。
 *
 * 数据面（B2 已交付，渲染层只经 window.openarc.model.command / model.onEvent）：
 *   · protocol/list   → { ok, items, shadowedLegacy }
 *   · protocol/get    → { ok, version, hash, protocol }
 *   · manifest/get    → { ok, format, protocolId, protocolVersion, protocolHash,
 *                         model, intent, manifest, parameterSchema, operation, inferred? }
 *   · provider/callStream → { ok, requestId, text, toolCalls, usage, snapshot }
 *     增量经 provider-protocol-service.cjs#streamSink 包成 model:event 的 P1 信封
 *     （dxos-foundation-events.cjs:56-92）：{ channel, domain, kind, sequence, at, payload }。
 *
 * 边界：本文件**不编造字段**。后端没给的（例如 manifest/get 的 manifest 不含
 * assets、顶层不含 modelProfiles）一律返回 declared:false，由界面如实标注"未返回"。
 */

/* ══════════════════════════════════════════════════════════════════════════
   命令白名单 —— 界面**只能**发这些命令（model:command 的后端白名单）
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * UI-5 新区块会发送的命令；逐条对齐 electron/model-bootstrap.cjs#MODEL_COMMANDS。
 *   只读：protocol/list、protocol/get、manifest/get；
 *   流式：provider/callStream；
 *   UI-5b 动作入口：protocol/validate、protocol/save、image/generate、protocol/execute。
 * 后两条（image/generate、protocol/execute）需要凭据：渲染层只提示"缺凭据"，不回显密钥。
 */
export const MODEL_PROTOCOL_COMMANDS: readonly string[] = [
  "protocol/list",
  "protocol/get",
  "manifest/get",
  "provider/callStream",
  "protocol/validate",
  "protocol/save",
  "image/generate",
  "protocol/execute",
];

/**
 * 既有设置页（providers / models / defaults 三个 pane）已在用的命令。
 * 本文件不改既有区块，这里登记它们只为"整页只发白名单命令"这一条探针断言提供完整清单；
 * 不登记就等于把既有命令误判成越权。
 */
export const MODEL_SETTINGS_EXISTING_COMMANDS: readonly string[] = [
  "provider/list",
  "provider/create",
  "provider/setStatus",
  "credential/status",
  "credential/set",
  "credential/replace",
  "credential/delete",
  "model/list",
  "model/create",
  "model/update",
  "model/setStatus",
  "model/test",
  "defaults/get",
  "defaults/set",
  "manifest/get",
];

/** 全页白名单 = 新增区块 ∪ 既有区块（去重，顺序稳定）。 */
export const MODEL_CONSOLE_COMMANDS: readonly string[] = [
  ...MODEL_PROTOCOL_COMMANDS,
  ...MODEL_SETTINGS_EXISTING_COMMANDS.filter((c) => MODEL_PROTOCOL_COMMANDS.indexOf(c) < 0),
];

/** 未登记命令一律拒绝（不猜、不透传）。 */
export function isAllowedModelCommand(command: unknown): command is string {
  return typeof command === "string" && MODEL_CONSOLE_COMMANDS.indexOf(command) >= 0;
}

/**
 * 身份字段永远由主进程按可信宿主决定（model-bootstrap.cjs:109-110 忽略 Renderer 自报值）。
 * 这里在渲染层再拦一道：载荷里出现这些键就判定构造错误，不发给后端。
 */
export const MODEL_IDENTITY_PAYLOAD_KEYS: readonly string[] = ["userId", "role", "sessionRef", "appId"];

export function payloadHasIdentityField(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  return Object.keys(payload as Record<string, unknown>).some((k) => MODEL_IDENTITY_PAYLOAD_KEYS.indexOf(k) >= 0);
}

/** 每个新命令允许出现的载荷键（按键白名单构造，防止顺手把整份表单塞进去）。 */
export const MODEL_PROTOCOL_PAYLOAD_KEYS: Record<string, readonly string[]> = {
  "protocol/list": ["kind", "ported"],
  "protocol/get": ["kind", "id", "version"],
  "manifest/get": ["protocolId", "model", "intent"],
  "provider/callStream": ["providerId", "model", "messages", "params", "requestId"],
  /* UI-5b：动作入口的载荷键逐条对齐 model-bootstrap.cjs 的 switch 分支。 */
  "protocol/validate": ["protocol"],
  "protocol/save": ["kind", "protocol"],
  "image/generate": ["providerId", "model", "prompt", "size", "count", "params", "requestId"],
  "protocol/execute": ["providerId", "protocolId", "model", "intent", "prompt", "params", "inputs", "requestId"],
};

/** 按命令名过滤载荷键；未登记的键直接丢弃（返回的键集合可被单测断言）。 */
export function buildProtocolPayload(command: string, values: Record<string, unknown>): Record<string, unknown> {
  const allowed = MODEL_PROTOCOL_PAYLOAD_KEYS[command] || [];
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    const value = values[key];
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   错误码 → 人话 + PageState（覆盖 provider-protocol-service 与 model-domain 的出口码）
   ══════════════════════════════════════════════════════════════════════════ */
export const MODEL_PROTOCOL_ERROR_TEXT: Record<string, string> = {
  /* provider-protocol-service.cjs / model-bootstrap.cjs 的稳定码 */
  PROTOCOL_NOT_READY: "模型协议域尚未装配（当前环境没有可用的协议服务）",
  PROTOCOL_NOT_FOUND: "该协议不存在：可能是 legacy 定义，请确认协议表里的 engine/execution 字段",
  PROTOCOL_INVALID: "协议定义未通过校验，界面不会保存",
  PROTOCOL_SAVE_REJECTED: "协议保存被拒绝（校验或冲突），没有写入",
  MODEL_COMMAND_NOT_ALLOWED: "命令不在 model:command 白名单内，界面不会发送未登记的命令",
  INVALID_INPUT: "输入不完整或不符合要求",
  INTERNAL_ERROR: "模型域内部错误，操作未完成",
  PROVIDER_NOT_FOUND: "找不到这个供应商配置，可能在别处被删除",
  CREDENTIAL_MISSING: "该供应商还没有可用凭据：请先在 Providers 区块保存 API Key",
  ENDPOINT_BLOCKED: "端点被本地策略拦下（仅本地/允许的局域网地址可直连）",
  /* 流式出口可能返回的规约码（provider-protocol-service.cjs#call） */
  NETWORK_ERROR: "网络不可达，流式调用没有建立",
  PROVIDER_ERROR: "供应商返回错误状态",
  PROVIDER_PROTOCOL_ERROR: "供应商响应无法解析成协议要求的形状",
  TIMEOUT: "调用超时，连接已结束",
  CANCELLED: "调用在完成前被取消",
  PARTIAL_RESPONSE: "连接中断：只收到部分增量，界面不把它当作完整结果",
  /* DXOS 地基码（dxos-foundation-errors.cjs） */
  DXOS_ERR_DEPENDENCY_MISSING: "缺少依赖：调用没有执行，产物也没有生成",
  DXOS_ERR_UNAVAILABLE: "当前环境不支持这个能力",
  DXOS_ERR_FORBIDDEN: "当前账号没有权限完成这个动作",
  DXOS_ERR_TIMEOUT: "操作超时，调用可能仍在后台执行",
  /* 渲染层事实位（前缀刻意与后端码区分） */
  NO_BRIDGE: "桌面桥未接入（当前环境没有模型域）",
  RESPONSE_INCOMPLETE: "主进程返回的记录不完整，界面不猜内容",
};

export function modelProtocolErrorText(code: string): string {
  return MODEL_PROTOCOL_ERROR_TEXT[code] || "模型与协议操作失败";
}

const MODEL_UNAUTHORIZED_CODES: readonly string[] = ["DXOS_ERR_FORBIDDEN", "SESSION_EXPIRED", "SESSION_REVOKED"];
const MODEL_UNAVAILABLE_CODES: readonly string[] = [
  "PROTOCOL_NOT_READY",
  "NO_BRIDGE",
  "DXOS_ERR_DEPENDENCY_MISSING",
  "DXOS_ERR_UNAVAILABLE",
  "CREDENTIAL_MISSING",
];

export type ModelPageStateKind = "loading" | "empty" | "error" | "unavailable" | "unauthorized";

export function modelProtocolErrorState(code: string): ModelPageStateKind {
  if (MODEL_UNAUTHORIZED_CODES.indexOf(code) >= 0) return "unauthorized";
  if (MODEL_UNAVAILABLE_CODES.indexOf(code) >= 0) return "unavailable";
  return "error";
}

/** 列表四态判定；有缓存数据时不整页盖住（与 skillListState 同口径）。 */
export function protocolListState(v: {
  loading: boolean;
  errorCode: string | null;
  count: number;
  dependencyUnavailable: boolean;
}): ModelPageStateKind | "ready" {
  if (v.dependencyUnavailable) return "unavailable";
  if (v.errorCode && v.count === 0) return "error";
  if (v.loading && v.count === 0) return "loading";
  if (v.count === 0) return "empty";
  return "ready";
}

/* ══════════════════════════════════════════════════════════════════════════
   协议表（protocol/list）
   ══════════════════════════════════════════════════════════════════════════ */
export type ProtocolKind = "model" | "provider";
export const PROTOCOL_KINDS: readonly ProtocolKind[] = ["model", "provider"];
export const PROTOCOL_KIND_LABEL: Record<ProtocolKind, string> = {
  model: "模型协议",
  provider: "供应商协议",
};
export const PROTOCOL_KIND_ALL = "all";

export type ProtocolItem = {
  id: string;
  kind: string;
  label?: string;
  engine?: string;
  source?: string;
  activeVersion?: number | string;
  activeHash?: string;
  capabilities?: string[];
  ported?: boolean;
  execution?: string;
  unavailableReason?: string;
};

export type ShadowedLegacyItem = { id: string; kind: string; execution?: string; unavailableReason?: string };

export function protocolKey(item: { kind?: string; id?: string }): string {
  return String(item.kind || "") + ":" + String(item.id || "");
}

/** 真实出现在数据里的 kind（不写死 model/provider，未知 kind 也原样列出）。 */
export function protocolKindOptions(items: ProtocolItem[]): string[] {
  const seen: string[] = [];
  for (const item of items) {
    const kind = String(item.kind || "");
    if (kind && seen.indexOf(kind) < 0) seen.push(kind);
  }
  return [PROTOCOL_KIND_ALL, ...seen.sort()];
}

export function protocolKindLabel(kind: string): string {
  if (kind === PROTOCOL_KIND_ALL) return "全部";
  return (PROTOCOL_KIND_LABEL as Record<string, string>)[kind] || kind;
}

/** protocol/list 的回包投影：形状不完整时明确标出，不用空数组冒充"没有数据"。 */
export function normalizeProtocolResult(result: unknown): {
  items: ProtocolItem[];
  shadowedLegacy: ShadowedLegacyItem[];
  incomplete: boolean;
  problem: string | null;
} {
  const res = (result || {}) as Record<string, unknown>;
  if (res.ok !== true) {
    return { items: [], shadowedLegacy: [], incomplete: false, problem: null };
  }
  if (!Array.isArray(res.items)) {
    return { items: [], shadowedLegacy: [], incomplete: true, problem: RESPONSE_INCOMPLETE_TEXT };
  }
  const items = (res.items as unknown[]).filter((v): v is ProtocolItem => !!v && typeof v === "object" && typeof (v as ProtocolItem).id === "string");
  const shadowedLegacy = Array.isArray(res.shadowedLegacy)
    ? (res.shadowedLegacy as unknown[]).filter((v): v is ShadowedLegacyItem => !!v && typeof v === "object")
    : [];
  return { items, shadowedLegacy, incomplete: items.length !== res.items.length, problem: items.length !== res.items.length ? RESPONSE_INCOMPLETE_TEXT : null };
}

export const RESPONSE_INCOMPLETE_TEXT = "主进程只返回了部分协议条目，界面只渲染拿到的部分";

export function filterProtocols(items: ProtocolItem[], kind: string, query: string): ProtocolItem[] {
  const q = String(query || "").trim().toLowerCase();
  return items.filter((item) => {
    if (kind && kind !== PROTOCOL_KIND_ALL && String(item.kind || "") !== kind) return false;
    if (!q) return true;
    const hay = [item.id, item.label, item.source, item.engine, item.execution, ...(item.capabilities || [])]
      .filter((v) => typeof v === "string")
      .join("\n")
      .toLowerCase();
    return hay.indexOf(q) >= 0;
  });
}

export type ProtocolTone = "neutral" | "success" | "warning" | "danger";

/**
 * 行状态：execution 是 B2 明确附加的字段（declarative / available / conditional / unavailable）。
 * conditional 表示"外部依赖（可选插件 / CLI）就绪后才可执行"，原因里写明前提；
 * 没有 execution 字段时按 engine 推断为"catalog"中性态，绝不默认成可用。
 */
export function protocolRowStatus(item: ProtocolItem): { tone: ProtocolTone; label: string; detail: string } {
  if (item.execution === "unavailable") {
    return {
      tone: "warning",
      label: "不可用",
      detail: item.unavailableReason || "该协议在当前版本没有执行链（未给出原因）",
    };
  }
  if (item.execution === "conditional") {
    return {
      tone: "warning",
      label: "条件可用",
      detail: item.unavailableReason || "该协议需要外部依赖就绪后才可执行（未给出前提）",
    };
  }
  if (item.execution === "declarative") {
    return { tone: "success", label: "可执行（声明式）", detail: "声明式协议引擎执行，engine=v2" };
  }
  if (item.execution === "available") {
    return { tone: "neutral", label: "可执行（legacy）", detail: "legacy 执行器已落地；engine=" + String(item.engine || "-") };
  }
  return { tone: "neutral", label: "仅协议表", detail: "回包没有 execution 字段，界面不推断可执行性" };
}

/** 协议行的真实字段（缺字段显示"未返回"，不猜）。 */
export function protocolFacts(item: ProtocolItem): { label: string; value: string }[] {
  const facts: { label: string; value: string }[] = [
    { label: "id", value: String(item.id) },
    { label: "kind", value: String(item.kind || "-") },
    { label: "label", value: item.label == null ? "未返回" : String(item.label) },
    { label: "engine", value: item.engine == null ? "未返回" : String(item.engine) },
    { label: "source", value: item.source == null ? "未返回" : String(item.source) },
    { label: "activeVersion", value: item.activeVersion == null ? "未返回" : String(item.activeVersion) },
    { label: "ported", value: typeof item.ported === "boolean" ? String(item.ported) : "未返回" },
    { label: "execution", value: item.execution == null ? "未返回" : String(item.execution) },
  ];
  return facts;
}

export function protocolCapabilitiesText(item: ProtocolItem): string {
  const caps = item.capabilities || [];
  return caps.length ? caps.join("、") : "未返回";
}

/* ══════════════════════════════════════════════════════════════════════════
   protocol/get 详情：只报"声明了什么 / 没声明什么"
   ══════════════════════════════════════════════════════════════════════════ */
export type DeclaredGroup = {
  key: string;
  label: string;
  declared: boolean;
  count: number;
  ids: string[];
};

export type OperationRow = { id: string; method: string; path: string; requestMode: string };
export type WorkflowRow = { id: string; submit: string };
export type ProfileRow = {
  id: string;
  label: string;
  capabilities: string[];
  workflowCount: number;
  uiSchemas: string[];
  declaredAssets: boolean;
  declaredLimits: boolean;
};

export type ProtocolDetail = {
  found: boolean;
  version: string;
  hash: string;
  protocolId: string;
  label: string;
  summary: string;
  executor: string;
  schemaVersion: string;
  capabilities: string[];
  groups: DeclaredGroup[];
  operations: OperationRow[];
  workflows: WorkflowRow[];
  profiles: ProfileRow[];
  uiSchemas: string[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringKeys(rec: unknown): string[] {
  return Object.keys(asRecord(rec));
}

function declaredGroup(key: string, label: string, ids: string[]): DeclaredGroup {
  return { key, label, declared: ids.length > 0, count: ids.length, ids };
}

/** 原始 protocol 对象 → 详情投影；protocol/get 的结果是 { ok, version, hash, protocol }。 */
export function describeProtocolDetail(result: unknown): ProtocolDetail {
  const res = asRecord(result);
  const protocol = asRecord(res.protocol);
  const operations = asRecord(protocol.operations);
  const workflows = asRecord(protocol.workflows);
  const profiles = asRecord(protocol.modelProfiles);
  const uiSchemas = asRecord(protocol.uiSchemas);
  const operationIds = Object.keys(operations);
  const workflowIds = Object.keys(workflows);
  const profileIds = Object.keys(profiles);
  const uiSchemaIds = Object.keys(uiSchemas);
  const capabilities = Array.isArray(protocol.capabilities) ? (protocol.capabilities as unknown[]).map(String) : [];

  return {
    found: res.ok === true && Object.keys(protocol).length > 0,
    version: res.version == null ? "未返回" : String(res.version),
    hash: res.hash == null ? "未返回" : String(res.hash),
    protocolId: protocol.id == null ? "未返回" : String(protocol.id),
    label: protocol.label == null ? "未返回" : String(protocol.label),
    summary: protocol.summary == null ? "未返回" : String(protocol.summary),
    executor: protocol.executor == null ? "未返回" : JSON.stringify(protocol.executor),
    schemaVersion: protocol.schemaVersion == null ? "未返回" : String(protocol.schemaVersion),
    capabilities,
    /* "存在性"：声明了哪些族、各几条；声明为空的族明确 declared:false。 */
    groups: [
      declaredGroup("operations", "操作 operations", operationIds),
      declaredGroup("workflows", "工作流 workflows", workflowIds),
      declaredGroup("modelProfiles", "模型 profile", profileIds),
      declaredGroup("uiSchemas", "参数界面 uiSchemas", uiSchemaIds),
      declaredGroup("capabilities", "能力 capabilities", capabilities),
    ],
    operations: operationIds.map((id) => {
      const op = asRecord(operations[id]);
      return {
        id,
        method: op.method == null ? "未返回" : String(op.method),
        path: op.path == null ? "未返回" : String(op.path),
        requestMode: op.requestMode == null ? "未返回" : String(op.requestMode),
      };
    }),
    workflows: workflowIds.map((id) => {
      const wf = asRecord(workflows[id]);
      return { id, submit: wf.submit == null ? "未返回" : String(wf.submit) };
    }),
    profiles: profileIds.map((id) => {
      const profile = asRecord(profiles[id]);
      return {
        id,
        label: profile.label == null ? "未返回" : String(profile.label),
        capabilities: Array.isArray(profile.capabilities) ? (profile.capabilities as unknown[]).map(String) : [],
        workflowCount: stringKeys(profile.workflows).length,
        uiSchemas: Array.isArray(profile.uiSchemas) ? (profile.uiSchemas as unknown[]).map(String) : [],
        declaredAssets: Object.keys(asRecord(profile.assets)).length > 0,
        declaredLimits: Object.keys(asRecord(profile.limits)).length > 0,
      };
    }),
    uiSchemas: uiSchemaIds,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   能力 manifest（manifest/get）：只展示真实返回的子集
   ══════════════════════════════════════════════════════════════════════════ */
export type ManifestFieldRow = { key: string; label: string; type: string; defaultValue: string; options: string[] };

export type ManifestSection<T> = { declared: boolean; value: T | null; note: string };

export type ManifestView = {
  ok: boolean;
  format: string;
  protocolId: string;
  protocolVersion: string;
  protocolHash: string;
  model: string;
  intent: string;
  profile: {
    declared: boolean;
    profileId: string;
    profileLabel: string;
    capabilities: string[];
    coarseCaps: string[];
    uiSchemas: string[];
    defaultOperations: { capability: string; operationId: string }[];
    capabilitySources: { capability: string; source: string }[];
    defaults: Record<string, unknown>;
  };
  parameterSchema: {
    declared: boolean;
    operationId: string;
    schemaId: string;
    source: string;
    fields: ManifestFieldRow[];
    defaults: Record<string, unknown>;
  };
  limits: ManifestSection<Record<string, unknown>>;
  assets: ManifestSection<Record<string, unknown>>;
  modelProfiles: ManifestSection<Record<string, unknown>>;
  operation: { declared: boolean; id: string; method: string; path: string; requestMode: string };
  inferred: ManifestSection<unknown>;
  /** 明确列出"后端这次没返回"的字段名，界面按此渲染"未返回"。 */
  missing: string[];
};

function formatScalar(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function sectionOf<T>(value: unknown, note: string): ManifestSection<T> {
  const declared = value !== undefined && value !== null && Object.keys(asRecord(value)).length > 0;
  return { declared, value: declared ? (value as T) : null, note };
}

const MANIFEST_MISSING_NOTE = {
  assets: "未返回（manifest/get 的 manifest 不含 assets 字段；协议 profile 里的 assets 见协议详情）",
  modelProfiles: "未返回（manifest/get 顶层没有 modelProfiles 映射；模型 profile 见 protocol/get 详情）",
};

export function describeManifest(result: unknown): ManifestView {
  const res = asRecord(result);
  const manifest = asRecord(res.manifest);
  const schema = asRecord(res.parameterSchema);
  const operation = asRecord(res.operation);
  const defaults = asRecord(schema.defaults);
  const fieldsRaw = Array.isArray(schema.fields) ? schema.fields : [];
  const fields: ManifestFieldRow[] = fieldsRaw.map((f) => {
    const field = asRecord(f);
    const options = Array.isArray(field.options)
      ? (field.options as unknown[]).map((o) => formatScalar(asRecord(o).value !== undefined ? asRecord(o).value : o))
      : [];
    return {
      key: formatScalar(field.key),
      label: field.label == null ? formatScalar(field.key) : formatScalar(field.label),
      type: field.type == null ? "未返回" : formatScalar(field.type),
      defaultValue: formatScalar(field.default),
      options,
    };
  });
  const defaultOperations = Object.entries(asRecord(manifest.defaultOperations)).map(([capability, operationId]) => ({
    capability,
    operationId: formatScalar(operationId),
  }));
  const capabilitySources = Object.entries(asRecord(manifest.capabilitySources)).map(([capability, source]) => ({
    capability,
    source: formatScalar(source),
  }));

  const limits = sectionOf<Record<string, unknown>>(manifest.limits, "来自 profile.limits，按 intent 合并 byCapability 后由 manifest 返回");
  const assets = sectionOf<Record<string, unknown>>(manifest.assets, MANIFEST_MISSING_NOTE.assets);
  const modelProfiles = sectionOf<Record<string, unknown>>(res.modelProfiles, MANIFEST_MISSING_NOTE.modelProfiles);
  const inferred = sectionOf<unknown>(res.inferred, "只有给 model/models 时才由主进程追加");

  const profileDeclared = Object.keys(manifest).length > 0;
  const schemaDeclared = Object.keys(schema).length > 0;
  const operationDeclared = Object.keys(operation).length > 0;
  const missing: string[] = [];
  if (!profileDeclared) missing.push("manifest（模型 profile）");
  if (!schemaDeclared) missing.push("parameterSchema");
  if (!operationDeclared) missing.push("operation");
  if (!limits.declared) missing.push("manifest.limits");
  if (!assets.declared) missing.push("assets");
  if (!modelProfiles.declared) missing.push("modelProfiles");
  if (!inferred.declared) missing.push("inferred");

  return {
    ok: res.ok === true,
    format: res.format == null ? "未返回" : String(res.format),
    protocolId: res.protocolId == null ? "未返回" : String(res.protocolId),
    protocolVersion: res.protocolVersion == null ? "未返回" : String(res.protocolVersion),
    protocolHash: res.protocolHash == null ? "未返回" : String(res.protocolHash),
    model: res.model == null ? "未返回" : String(res.model),
    intent: res.intent == null ? "未返回" : String(res.intent),
    profile: {
      declared: profileDeclared,
      profileId: manifest.profileId == null ? "未返回" : formatScalar(manifest.profileId),
      profileLabel: manifest.profileLabel == null ? "未返回" : formatScalar(manifest.profileLabel),
      capabilities: Array.isArray(manifest.capabilities) ? (manifest.capabilities as unknown[]).map(String) : [],
      coarseCaps: Array.isArray(manifest.coarseCaps) ? (manifest.coarseCaps as unknown[]).map(String) : [],
      uiSchemas: Array.isArray(manifest.uiSchemas) ? (manifest.uiSchemas as unknown[]).map(String) : [],
      defaultOperations,
      capabilitySources,
      defaults: asRecord(manifest.defaults),
    },
    parameterSchema: {
      declared: schemaDeclared,
      operationId: formatScalar(schema.operationId),
      schemaId: formatScalar(schema.schemaId),
      source: schema.source == null ? "未返回" : formatScalar(schema.source),
      fields,
      defaults,
    },
    limits,
    assets,
    modelProfiles,
    operation: {
      declared: operationDeclared,
      id: formatScalar(operation.id),
      method: operation.method == null ? "未返回" : formatScalar(operation.method),
      path: operation.path == null ? "未返回" : formatScalar(operation.path),
      requestMode: operation.requestMode == null ? "未返回" : formatScalar(operation.requestMode),
    },
    inferred,
    missing,
  };
}

/** 未返回字段的显式文案（空清单不渲染）。 */
export function missingFieldsText(view: ManifestView): string {
  if (!view.missing.length) return "";
  return "本次回包未返回：" + view.missing.join("、");
}

/* ══════════════════════════════════════════════════════════════════════════
   流式状态机（provider/callStream + model:event）
   ══════════════════════════════════════════════════════════════════════════ */
export type StreamPhase =
  | "idle"
  | "queued"
  | "starting"
  | "streaming"
  | "usage"
  | "completed"
  | "error"
  | "stopping"
  | "cancelled";

export const STREAM_PHASES: readonly StreamPhase[] = [
  "idle",
  "queued",
  "starting",
  "streaming",
  "usage",
  "completed",
  "error",
  "stopping",
  "cancelled",
];

/** 动效口径：active=只持续于真实执行状态；glyph+label 一起出现，颜色不单独传意（MOTION §7）。 */
export function streamPhaseFeedback(phase: StreamPhase): {
  label: string;
  glyph: string;
  tone: ProtocolTone;
  active: boolean;
  detail: string;
} {
  switch (phase) {
    case "queued":
      return { label: "排队", glyph: "≡", tone: "neutral", active: false, detail: "命令已发出，等待主进程返回第一个流事件。" };
    case "starting":
      return { label: "开始", glyph: "▶", tone: "neutral", active: true, detail: "已收到 response.start，连接建立。" };
    case "streaming":
      return { label: "增量", glyph: "…", tone: "neutral", active: true, detail: "文本按渲染批次更新，不逐 token 补间（MOTION §7）。" };
    case "usage":
      return { label: "用量", glyph: "Σ", tone: "neutral", active: true, detail: "供应商已返回 usage；流还没结束。" };
    case "completed":
      return { label: "结束", glyph: "✓", tone: "success", active: false, detail: "收到 response.complete。结束不等于验证通过（DESIGN_SYSTEM §9）。" };
    case "error":
      return { label: "错误", glyph: "!", tone: "danger", active: false, detail: "流在错误处终止，界面保留已收到的增量。" };
    case "stopping":
      return { label: "停止中", glyph: "■", tone: "warning", active: true, detail: "已发出界面侧停止请求；本次调用没有中断命令，主进程仍会跑到结束，界面不再追写增量。" };
    case "cancelled":
      return { label: "已停止", glyph: "■", tone: "warning", active: false, detail: "界面已停止追踪，含部分结果；主进程侧调用可能已经完成，已完成动作保留。" };
    default:
      return { label: "未开始", glyph: "○", tone: "neutral", active: false, detail: "还没有流式调用：选择供应商与模型后开始。" };
  }
}

export type StreamEventRow = {
  key: string;
  sequence: number | null;
  kind: string;
  type: string;
  at: number | null;
  summary: string;
  text: string;
};

export type ModelStreamState = {
  phase: StreamPhase;
  providerId: string;
  model: string;
  requestId: string | null;
  text: string;
  deltas: number;
  toolDeltas: number;
  usage: unknown;
  events: StreamEventRow[];
  lastSequence: number;
  gaps: { from: number; to: number }[];
  duplicates: number;
  errorCode: string | null;
  errorDetail: string | null;
  /** 停止请求之后到达的增量被丢弃的段数（只影响界面渲染）。 */
  mutedAfterStop: number;
  startedAt: number | null;
  endedAt: number | null;
  resultCode: string | null;
};

export const STREAM_EVENT_ROWS_MAX = 200;

export function streamInitialState(seed: Partial<ModelStreamState> = {}): ModelStreamState {
  return {
    phase: "idle",
    providerId: "",
    model: "",
    requestId: null,
    text: "",
    deltas: 0,
    toolDeltas: 0,
    usage: null,
    events: [],
    lastSequence: 0,
    gaps: [],
    duplicates: 0,
    errorCode: null,
    errorDetail: null,
    mutedAfterStop: 0,
    startedAt: null,
    endedAt: null,
    resultCode: null,
    ...seed,
  };
}

/** 开始一次流式调用（本地态；真正进度只由 model:event 推进）。 */
export function beginStream(providerId: string, model: string, requestId: string | null, at: number): ModelStreamState {
  return streamInitialState({ phase: "queued", providerId, model, requestId, startedAt: at });
}

/** 停止请求：不假装已取消（MOTION §7 stopping / DESIGN_SYSTEM §9）。 */
export function requestStreamStop(state: ModelStreamState, at: number): ModelStreamState {
  if (state.phase === "idle" || state.phase === "completed" || state.phase === "error" || state.phase === "cancelled") return state;
  return { ...state, phase: "stopping", endedAt: at };
}

/** 调用结束后（无论成功/失败）按是否请求过停止收敛终态。 */
export function settleStream(
  state: ModelStreamState,
  result: { ok?: boolean; error?: unknown },
  at: number,
): ModelStreamState {
  const errorCode = result && result.ok === false ? String(result.error || "INTERNAL_ERROR") : null;
  if (state.phase === "stopping") {
    return {
      ...state,
      phase: "cancelled",
      endedAt: at,
      resultCode: errorCode || "STOPPED_TRACKING",
      errorCode: errorCode && errorCode !== "CANCELLED" ? errorCode : null,
      errorDetail: sectionResultDetail(errorCode),
    };
  }
  if (errorCode) {
    return { ...state, phase: "error", endedAt: at, errorCode, resultCode: errorCode, errorDetail: null };
  }
  if (state.phase === "error" || state.phase === "cancelled") {
    return { ...state, endedAt: at, resultCode: state.resultCode || "STOPPED_TRACKING" };
  }
  /* 调用返回即流已结束：标"结束"而不是"成功"——结束不等于验证通过（DESIGN_SYSTEM §9），
     streamPhaseFeedback("completed").detail 已写明这条。 */
  return { ...state, phase: "completed", endedAt: at, resultCode: state.resultCode || "OK", errorCode: null };
}

function sectionResultDetail(errorCode: string | null): string {
  if (errorCode && errorCode !== "CANCELLED") {
    return "停止请求已确认；主进程返回了错误码 " + errorCode + "，界面按错误如实呈现。";
  }
  return "停止请求已确认；界面不再追踪本次流。已完成动作与部分增量保留，未产生完整结果。";
}

/** P1 信封的形状校验：只接受 model 域、progress/log/approval 三类。 */
export function isModelEvent(event: unknown): boolean {
  const e = asRecord(event);
  return (e.channel === "model:event" || e.domain === "model") && typeof e.kind === "string";
}

/** 把一条 model:event 折进状态（纯函数；不修改入参）。 */
export function reduceModelStreamEvent(state: ModelStreamState, event: unknown, at: number): ModelStreamState {
  if (!isModelEvent(event)) return state;
  const e = event as Record<string, unknown>;
  const kind = String(e.kind);
  const seqRaw = typeof e.sequence === "number" && Number.isFinite(e.sequence) ? e.sequence : null;
  const payload = asRecord(e.payload);
  const eventRequestId = payload.requestId == null ? null : String(payload.requestId);
  if (eventRequestId && state.requestId && eventRequestId !== state.requestId) return state;

  const next: ModelStreamState = { ...state, events: state.events.slice(), gaps: state.gaps.slice() };
  if (seqRaw != null) {
    if (seqRaw <= next.lastSequence) {
      /* 重复 / 乱序旧事件：不重复追加，不倒退状态。 */
      return { ...next, duplicates: next.duplicates + 1 };
    }
    if (seqRaw > next.lastSequence + 1 && next.lastSequence > 0) {
      next.gaps.push({ from: next.lastSequence + 1, to: seqRaw - 1 });
    }
    next.lastSequence = seqRaw;
  }

  const type = kind === "progress" ? String(payload.type || "progress") : kind === "log" ? String(asRecord(payload.data).type || "log") : kind;
  const row: StreamEventRow = {
    key: (seqRaw == null ? "n" + (next.events.length + 1) : "s" + seqRaw) + ":" + type,
    sequence: seqRaw,
    kind,
    type,
    at: typeof e.at === "number" ? e.at : at,
    summary: "",
    text: "",
  };

  const stopped = next.phase === "stopping" || next.phase === "cancelled";

  if (kind === "log") {
    const level = payload.level == null ? "info" : String(payload.level);
    const message = payload.message == null ? "" : String(payload.message);
    const data = asRecord(payload.data);
    row.summary = level + " · " + message;
    if (data.type === "response.error") {
      const code = message.indexOf("CANCELLED") >= 0 || data.error === "CANCELLED" ? "CANCELLED" : String(data.error || "PARTIAL_RESPONSE");
      next.errorCode = code;
      next.errorDetail = data.partial ? "已收到部分增量：" + String(data.partial).slice(0, 200) : null;
      next.phase = code === "CANCELLED" ? "cancelled" : "error";
      next.resultCode = code;
      next.endedAt = at;
    }
  } else if (kind === "progress") {
    row.summary = type;
    if (type === "response.start") {
      next.phase = stopped ? next.phase : "starting";
    } else if (type === "text.delta") {
      const text = payload.text == null ? "" : String(payload.text);
      row.text = text;
      row.summary = "文本增量 " + text.length + " 字";
      if (stopped) {
        next.mutedAfterStop += 1;
      } else {
        next.text += text;
        next.deltas += 1;
        next.phase = "streaming";
      }
    } else if (type === "usage") {
      next.usage = payload.usage == null ? null : payload.usage;
      if (!stopped) next.phase = "usage";
    } else if (type === "tool_call.delta") {
      next.toolDeltas += 1;
      if (!stopped) next.phase = "streaming";
    } else if (type === "response.complete") {
      next.phase = stopped ? next.phase : "completed";
      next.endedAt = at;
      next.resultCode = next.resultCode || "STREAM_COMPLETE";
    } else if (type === "response.error") {
      const code = payload.error == null ? "PARTIAL_RESPONSE" : String(payload.error);
      next.errorCode = code;
      next.phase = code === "CANCELLED" ? "cancelled" : "error";
      next.resultCode = code;
      next.endedAt = at;
    }
    /* 未登记 type 只记一行，不改状态 —— 不猜后端语义。 */
  }

  next.events.push(row);
  if (next.events.length > STREAM_EVENT_ROWS_MAX) next.events = next.events.slice(next.events.length - STREAM_EVENT_ROWS_MAX);
  return next;
}

/** 事件行的 P1 信封展示：sequence 缺失时如实标 null（界面显示"未返回"）。 */
export function streamSequenceText(row: StreamEventRow): string {
  return row.sequence == null ? "未返回" : String(row.sequence);
}

/** 序列缺口文案：缺了几个、从哪到哪；没有缺口返回空串。 */
export function streamGapText(state: ModelStreamState): string {
  if (!state.gaps.length) return "";
  const last = state.gaps[state.gaps.length - 1];
  const total = state.gaps.reduce((sum, g) => sum + (g.to - g.from + 1), 0);
  return "检测到 " + total + " 个缺口（最近：sequence " + last.from + "–" + last.to + "）";
}

/* ── 渲染批次：MOTION §7 要求流式按批次更新，不做逐 token 布局补间 ───────── */
export const STREAM_FLUSH_INTERVAL_MS = 120;

export type StreamBuffer = {
  push: (text: string) => void;
  size: () => number;
  drain: () => string;
};

export function createStreamBuffer(): StreamBuffer {
  let parts: string[] = [];
  return {
    push(text: string) {
      if (text) parts.push(text);
    },
    size() {
      return parts.length;
    },
    drain() {
      const joined = parts.join("");
      parts = [];
      return joined;
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   无可用 provider 时的结构化说明（不造假数据）
   ══════════════════════════════════════════════════════════════════════════ */
export type StreamAvailability = {
  available: boolean;
  kind: "ready" | "no-bridge" | "no-provider" | "no-model" | "no-credential";
  title: string;
  description: string;
  missing: string[];
};

/**
 * 流式区块能否真实发起调用。判据全部是**已经拿到的真实投影**：
 * provider/list 的 status / credential/status / model/list，不猜、不造。
 */
export function streamAvailability(input: {
  hasBridge: boolean;
  providerCount: number;
  modelCount: number;
  enabledProvider: string | null;
  credentialConfigured: boolean | null;
}): StreamAvailability {
  if (!input.hasBridge) {
    return {
      available: false,
      kind: "no-bridge",
      title: "模型桥未接入",
      description: "当前渲染环境没有 window.openarc.model，界面不会发起任何流式调用。",
      missing: ["window.openarc.model.command", "model.onEvent"],
    };
  }
  if (input.providerCount === 0) {
    return {
      available: false,
      kind: "no-provider",
      title: "没有可用的 provider",
      description: "provider/list 返回空：需要先在 Providers 区块创建并启用一个供应商，流式区块才可能发起真实调用。",
      missing: ["provider/list 至少一条 status=enabled 的供应商"],
    };
  }
  if (!input.enabledProvider) {
    return {
      available: false,
      kind: "no-provider",
      title: "没有已启用的 provider",
      description: "现有供应商全部处于 disabled：启用一个后再回到本区块。",
      missing: ["status=enabled 的供应商"],
    };
  }
  if (input.credentialConfigured === false) {
    return {
      available: false,
      kind: "no-credential",
      title: "供应商缺少凭据",
      description: "credential/status 显示未配置：界面不会假装调用成功，也不会用演示数据顶替。",
      missing: ["credential/status.configured=true"],
    };
  }
  if (input.modelCount === 0) {
    return {
      available: false,
      kind: "no-model",
      title: "没有已注册的模型",
      description: "model/list 返回空：先在 Models 区块注册模型，流式区块才有 model 可发。",
      missing: ["model/list 至少一条记录"],
    };
  }
  return {
    available: true,
    kind: "ready",
    title: "可以发起真实流式调用",
    description: "命令走 provider/callStream，增量经 model:event 下发；界面只渲染真实事件。",
    missing: [],
  };
}


/* ══════════════════════════════════════════════════════════════════════════
   UI-5b · 动作入口：协议校验 / 协议保存 / 图像生成 / 协议执行
   ──────────────────────────────────────────────────────────────────────────
   四个入口都在 MODEL_PROTOCOL_COMMANDS 内（electron/model-bootstrap.cjs:149-216 逐条实现）。
   可用性判据只用**已经拿到的真实投影**（provider/list、credential/status、协议详情）；
   需要凭据的动作缺凭据时给结构化提示，绝不回显密钥、绝不假装调用成功。
   ══════════════════════════════════════════════════════════════════════════ */
export type ModelEntryKey = "protocol-validate" | "protocol-save" | "image-generate" | "protocol-execute";

export const MODEL_ENTRY_KEYS: readonly ModelEntryKey[] = [
  "protocol-validate",
  "protocol-save",
  "image-generate",
  "protocol-execute",
];

export type ModelEntryRisk = "read" | "write" | "use";

export type ModelEntryMeta = {
  key: ModelEntryKey;
  command: string;
  label: string;
  description: string;
  risk: ModelEntryRisk;
  /** 需要凭据的动作：缺凭据时结构化提示（provider-protocol-service.cjs#resolveProvider）。 */
  requiresCredential: boolean;
  requiresProvider: boolean;
  requiresProtocol: boolean;
  inputs: readonly string[];
};

export const MODEL_ENTRIES: readonly ModelEntryMeta[] = [
  {
    key: "protocol-validate",
    command: "protocol/validate",
    label: "协议校验",
    description: "校验一份 declarative 协议定义，返回规范化结果或 issues；只读，不落库。",
    risk: "read",
    requiresCredential: false,
    requiresProvider: false,
    requiresProtocol: true,
    inputs: ["protocol"],
  },
  {
    key: "protocol-save",
    command: "protocol/save",
    label: "协议保存",
    description: "把一份自定义 declarative 协议写入本地协议库（有校验失败或冲突就拒绝）。",
    risk: "write",
    requiresCredential: false,
    requiresProvider: false,
    requiresProtocol: true,
    inputs: ["kind", "protocol"],
  },
  {
    key: "image-generate",
    command: "image/generate",
    label: "图像生成",
    description: "按图像协议真实调用供应商并把产物落盘；需要凭据。",
    risk: "use",
    requiresCredential: true,
    requiresProvider: true,
    requiresProtocol: false,
    inputs: ["providerId", "model", "prompt", "size", "count"],
  },
  {
    key: "protocol-execute",
    command: "protocol/execute",
    label: "协议执行",
    description: "按声明式协议引擎 compile + workflow 真实执行；需要凭据。",
    risk: "use",
    requiresCredential: true,
    requiresProvider: true,
    requiresProtocol: false,
    inputs: ["providerId", "protocolId", "model", "intent", "prompt"],
  },
];

export function modelEntryMeta(key: unknown): ModelEntryMeta | null {
  const found = MODEL_ENTRIES.find((e) => e.key === key);
  return found || null;
}

export const MODEL_ENTRY_RISK_LABEL: Record<ModelEntryRisk, string> = {
  read: "只读",
  write: "写操作",
  use: "真实调用",
};

export const MODEL_ENTRY_RISK_TEXT: Record<ModelEntryKey, string> = {
  "protocol-validate": "只读：不写协议库、不调用模型。",
  "protocol-save": "写操作：会写入本地协议库；保存失败时不产生半份记录。",
  "image-generate": "真实调用 + 落盘：会调用供应商并把图片写到 dxos/media。",
  "protocol-execute": "真实调用：会按协议引擎执行，可能产生网络请求与产物。",
};

export function modelEntryRiskText(key: unknown): string {
  const meta = modelEntryMeta(key);
  return meta ? MODEL_ENTRY_RISK_TEXT[meta.key] : "";
}

export type ModelEntryAvailability = {
  available: boolean;
  kind: "ready" | "no-bridge" | "no-provider" | "no-credential" | "no-input";
  title: string;
  description: string;
  missing: string[];
};

/** 缺凭据的结构化提示：说清"没有执行"，且明确界面不回显密钥。 */
export const MODEL_ENTRY_MISSING_CREDENTIAL_TEXT =
  "缺凭据：该动作需要凭据，当前供应商还没有可用的凭据。命令没有执行，也没有生成任何产物；请先在供应商配置里保存凭据（界面只写不读，不回显任何密钥）。";

export const MODEL_ENTRY_MISSING_PROVIDER_TEXT =
  "没有可用的供应商：provider/list 里没有 status=enabled 的供应商。命令没有执行，也没有生成任何产物；先在 Providers 区块启用一个供应商。";

export const MODEL_ENTRY_MISSING_PROTOCOL_TEXT =
  "缺少协议定义：先粘贴一份 declarative 协议 JSON（可先用「协议校验」确认它合法）。";

/**
 * 入口可用性：桥缺失 > 无供应商 > 缺凭据 > 缺输入 > 就绪。
 * 判据全部是调用方已经拿到的真实投影，不在这里发起任何读取。
 */
export function modelEntryAvailability(
  key: unknown,
  input: {
    hasBridge: boolean;
    enabledProvider: string | null;
    credentialConfigured: boolean | null;
    hasProtocol: boolean;
  },
): ModelEntryAvailability {
  const meta = modelEntryMeta(key);
  if (!meta) {
    return { available: false, kind: "no-input", title: "未登记的入口", description: "界面不猜语义。", missing: [] };
  }
  if (!input.hasBridge) {
    return {
      available: false,
      kind: "no-bridge",
      title: meta.label + "不可用：模型桥未接入",
      description: "当前渲染环境没有 window.openarc.model，界面不会发起任何模型命令。",
      missing: ["window.openarc.model.command"],
    };
  }
  if (meta.requiresProvider && !input.enabledProvider) {
    return {
      available: false,
      kind: "no-provider",
      title: meta.label + "不可用：没有已启用的供应商",
      description: MODEL_ENTRY_MISSING_PROVIDER_TEXT,
      missing: ["provider/list 至少一条 status=enabled 的供应商"],
    };
  }
  if (meta.requiresCredential && input.credentialConfigured === false) {
    return {
      available: false,
      kind: "no-credential",
      title: meta.label + "不可用：缺凭据",
      description: MODEL_ENTRY_MISSING_CREDENTIAL_TEXT,
      missing: ["credential/status.configured=true"],
    };
  }
  if (meta.requiresProtocol && input.hasProtocol !== true) {
    return {
      available: false,
      kind: "no-input",
      title: meta.label + "不可用：缺少协议定义",
      description: MODEL_ENTRY_MISSING_PROTOCOL_TEXT,
      missing: ["protocol（declarative JSON）"],
    };
  }
  return {
    available: true,
    kind: "ready",
    title: meta.label + "可用",
    description: "前置条件已满足；命令会真实发往主进程，失败会显示稳定错误码。",
    missing: [],
  };
}

export const MODEL_ENTRY_REQUIRED_INPUTS: Record<ModelEntryKey, readonly string[]> = {
  "protocol-validate": ["protocol"],
  "protocol-save": ["kind", "protocol"],
  "image-generate": ["providerId", "model", "prompt"],
  "protocol-execute": ["providerId", "model", "prompt"],
};

export const MODEL_ENTRY_INPUT_LABEL: Record<string, string> = {
  protocol: "协议 JSON",
  kind: "协议类型（model / provider）",
  providerId: "供应商 ID",
  model: "模型",
  prompt: "提示词",
  size: "尺寸（可选，如 1024x1024）",
  count: "张数（可选）",
  protocolId: "协议 ID（可选）",
  intent: "意图（可选，如 image.generate）",
};

/** 缺哪些必填项：界面先行拦截，不发空命令给后端。 */
export function modelEntryMissingInputs(key: unknown, values: Record<string, unknown>): string[] {
  const meta = modelEntryMeta(key);
  if (!meta) return [];
  const required = MODEL_ENTRY_REQUIRED_INPUTS[meta.key] || [];
  return required.filter((field) => !String((values || {})[field] == null ? "" : (values || {})[field]).trim());
}

/* ── 写类入口的二次确认（UI-5c）────────────────────────────────────────────
   protocol/save 会写本地协议库，属于"写"风险（MODEL_ENTRIES.risk === "write"）；
   确认前不发命令、取消则命令数 0、确认后才发送。只读与真实调用入口不走这一步，
   它们的风险由既有可用性判定与审批语义承担。 */
export function modelEntryNeedsConfirm(key: unknown): boolean {
  const meta = modelEntryMeta(key);
  return meta != null && meta.risk === "write";
}

export function modelEntryConfirmTitle(key: unknown): string {
  const meta = modelEntryMeta(key);
  if (!meta) return "确认";
  return meta.key === "protocol-save" ? "确认保存协议" : "确认" + meta.label;
}

/** 保存前摘要：只说清楚"要把哪份协议写进本地协议库"，不预告成功。 */
export function modelEntryConfirmText(key: unknown, payload: Record<string, unknown>): string {
  const meta = modelEntryMeta(key);
  if (!meta) return "";
  if (meta.key === "protocol-save") {
    const kind = payload.kind == null ? "未填" : String(payload.kind);
    const protocol = payload.protocol && typeof payload.protocol === "object" && !Array.isArray(payload.protocol)
      ? (payload.protocol as Record<string, unknown>)
      : null;
    const id = protocol && protocol.id != null ? String(protocol.id) : "（未给出 id）";
    return "将把协议 " + id + "（kind=" + kind + "）写入本地协议库；保存失败时不产生半份记录。取消则命令数保持 0。";
  }
  return meta.description;
}

