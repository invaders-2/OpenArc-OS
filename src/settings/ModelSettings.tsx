import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge, Button, ScrollArea, SearchField, TextField } from "../design-system/primitives";
import { PageState } from "../design-system/page-states";
/* page-states.css 只被设计系统 gallery 引用过；PageState 是本文件新增区块的
   加载 / 空 / 错误 / 不可用态的承接组件，必须把它的样式一并带进来。 */
import "../design-system/page-states.css";
/* 写类入口（protocol/save）的二次确认复用产品既有 Dialog。 */
import { Dialog } from "../desktop/Dialog";
import {
  MODEL_ENTRIES,
  MODEL_ENTRY_INPUT_LABEL,
  MODEL_ENTRY_RISK_LABEL,
  MODEL_ENTRY_RISK_TEXT,
  PROTOCOL_KIND_ALL,
  STREAM_FLUSH_INTERVAL_MS,
  beginStream,
  buildProtocolPayload,
  createStreamBuffer,
  describeManifest,
  describeProtocolDetail,
  filterProtocols,
  isModelEvent,
  missingFieldsText,
  modelEntryAvailability,
  modelEntryConfirmText,
  modelEntryConfirmTitle,
  modelEntryMissingInputs,
  modelEntryMeta,
  modelEntryNeedsConfirm,
  modelProtocolErrorState,
  modelProtocolErrorText,
  normalizeProtocolResult,
  protocolCapabilitiesText,
  protocolFacts,
  protocolKindLabel,
  protocolKindOptions,
  protocolKey,
  protocolListState,
  protocolRowStatus,
  reduceModelStreamEvent,
  requestStreamStop,
  settleStream,
  streamAvailability,
  streamGapText,
  streamInitialState,
  streamPhaseFeedback,
  streamSequenceText,
  type ManifestView,
  type ModelEntryKey,
  type ModelStreamState,
  type ProtocolDetail,
  type ProtocolItem,
  type ShadowedLegacyItem,
} from "./modelProtocolLogic";

/** D4-01 Closure C · Settings → Models / AI（只经 window.openarc.model.command；credential write-only）。 */
type ModelBridge = { command: (c: Record<string, unknown>) => Promise<any> };
const bridge = (): ModelBridge | undefined => (window as any).openarc?.model;
type Tab = "providers" | "models" | "defaults";

/** 可勾选的能力：取值与 electron/model-domain.cjs 的 CAPABILITIES 完全一致（不多造能力名）。 */
const CAPABILITY_CHOICES = [
  { id: "chat", label: "文本对话" },
  { id: "image-generation", label: "生图" },
  { id: "vision-input", label: "图片输入" },
  { id: "video-generation", label: "视频生成" },
  { id: "audio-generation", label: "音频生成" },
  { id: "3d-generation", label: "3D 生成" },
] as const;

/** 能力的中文名：只用于"已配置的默认为什么不可用"的选项文案（取值与 CAPABILITY_CHOICES 同一套）。 */
const CAPABILITY_LABEL: Record<string, string> = { chat: "文本对话", "image-generation": "生图", "tool-calling": "工具调用", "vision-input": "图片输入", "video-generation": "视频生成", "audio-generation": "音频生成", "3d-generation": "3D 生成" };

/** P2：OpenArc 现有模型面统一走 OpenAI 兼容 wire format，manifest 也按 openai-images 协议解析。 */
const OPENAI_COMPATIBLE_PROTOCOL = "openai-images";

/** 由模型声明的能力选择 manifest 的 intent（只决定取哪份参数 schema/limits）。 */
function manifestIntentFor(m: any): string {
  return Array.isArray(m?.capabilities) && m.capabilities.includes("image-generation") ? "image.generate" : "llm.chat";
}

/** 显式配置的默认值不在能力过滤后的清单里时，如实点名配的是哪个模型、为什么不可用（不是"没配"）。 */
function defaultUnavailableText(cap: string, m: any) {
  const name = m ? String(m.displayName || m.remoteModelId || m.configId) : "（该模型已不在清单里）";
  return name + "（已配置为默认" + (m ? "，但没有「" + (CAPABILITY_LABEL[cap] || cap) + "」能力" : "") + "，不可用）";
}

export function ModelSettings({ role }: { role: string | null }) {
  const [tab, setTab] = useState<Tab>("providers");
  const [providers, setProviders] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [defaults, setDefaults] = useState<any>(null);
  const [credStatus, setCredStatus] = useState<Record<string, any>>({});
  const [tests, setTests] = useState<Record<string, any>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pForm, setPForm] = useState({ displayName: "", baseUrl: "", endpointScope: "LOCALHOST", scope: "PERSONAL", credentialSecret: "" });
  const [mForm, setMForm] = useState({ providerId: "", remoteModelId: "", displayName: "", capabilities: ["chat"], scope: "PERSONAL" });
  const [credDraft, setCredDraft] = useState<Record<string, string>>({});
  /** 编辑已有模型能力的草稿（key = configId）；保存走 model/update。 */
  const [capsDraft, setCapsDraft] = useState<Record<string, string[]>>({});
  /** P2：manifest 驱动的参数表单（数据来源，不动既有表单结构）。 */
  const [manifestFields, setManifestFields] = useState<any[]>([]);
  const [manifestDefaults, setManifestDefaults] = useState<Record<string, unknown>>({});
  const [paramDraft, setParamDraft] = useState<Record<string, string>>({});
  const [modelManifests, setModelManifests] = useState<Record<string, any>>({});

  const cmd = useCallback(async (command: string, payload: Record<string, unknown> = {}): Promise<any> => {
    const b = bridge();
    if (!b) return { ok: false, error: "NO_BRIDGE" };
    try { return await b.command({ command, payload }); } catch { return { ok: false, error: "INTERNAL_ERROR" }; }
  }, []);

  const load = useCallback(async () => {
    setBusy(true); setError(null);
    const [p, m, d] = await Promise.all([cmd("provider/list"), cmd("model/list"), cmd("defaults/get")]);
    if (p.ok) setProviders(p.items); else setError(p.error);
    if (m.ok) setModels(m.items); else setError(m.error);
    if (d.ok) setDefaults(d); else setError(d.error);
    if (p.ok) {
      const entries = await Promise.all(p.items.map(async (it: any) => [it.providerId, await cmd("credential/status", { providerId: it.providerId })] as const));
      setCredStatus(Object.fromEntries(entries));
    }
    if (m.ok) {
      const manifests = await Promise.all(m.items.map(async (it: any) => [it.configId, await cmd("manifest/get", { protocolId: OPENAI_COMPATIBLE_PROTOCOL, model: it.remoteModelId, intent: manifestIntentFor(it) })] as const));
      setModelManifests(Object.fromEntries(manifests));
    }
    setBusy(false);
  }, [cmd]);
  useEffect(() => { void load(); }, [load]);

  const createProvider = async () => {
    const payload: Record<string, unknown> = { displayName: pForm.displayName, baseUrl: pForm.baseUrl, endpointScope: pForm.endpointScope, scope: pForm.scope };
    if (pForm.credentialSecret) payload.credentialSecret = pForm.credentialSecret;
    const res = await cmd("provider/create", payload);
    if (res.ok) { setNotice("Provider created"); setPForm({ displayName: "", baseUrl: "", endpointScope: "LOCALHOST", scope: "PERSONAL", credentialSecret: "" }); await load(); }
    else setError(res.error);
  };
  const setProviderStatus = async (providerId: string, status: string) => { const r = await cmd("provider/setStatus", { providerId, status }); if (!r.ok) setError(r.error); await load(); };
  const saveCred = async (providerId: string, replace: boolean) => {
    const secret = credDraft[providerId] || "";
    if (!secret) return;
    const r = await cmd(replace ? "credential/replace" : "credential/set", { providerId, secret });
    if (r.ok) { setNotice(replace ? "Credential replaced" : "Credential saved"); setCredDraft((prev) => ({ ...prev, [providerId]: "" })); await load(); }
    else setError(r.error);
  };
  const deleteCred = async (providerId: string) => { const r = await cmd("credential/delete", { providerId }); if (r.ok) await load(); else setError(r.error); };
  const runTest = async (providerId: string) => {
    const config = models.find((m) => m.providerId === providerId);
    if (!config) { setError("NO_MODEL_FOR_PROVIDER"); return; }
    const r = await cmd("model/test", { configId: config.configId });
    setTests((prev) => ({ ...prev, [providerId]: r }));
    if (!r.ok && r.error) setError(r.error);
  };
  const testLabel = (t: any) => {
    if (!t) return "";
    return "Endpoint:" + (t.reachable === false ? "FAIL" : "PASS") +
      " Credential:" + (t.credentialAccepted === false ? "FAIL" : "PASS") +
      " Model:" + (t.ok ? "PASS" : "FAIL") +
      " Inference:" + (t.inference ? "PASS" : "FAIL") +
      " Capabilities:" + ((t.verifiedCapabilities && t.verifiedCapabilities.length) ? t.verifiedCapabilities.join(",") : "NOT VERIFIED");
  };
  const toggleCap = (list: string[], cap: string) => (list.includes(cap) ? list.filter((c) => c !== cap) : [...list, cap]);
  const draftCaps = (m: any) => capsDraft[m.configId] || m.capabilities || [];
  const saveCaps = async (configId: string) => { const r = await cmd("model/update", { configId, capabilities: capsDraft[configId] || [] }); if (!r.ok) setError(r.error); else { setNotice("Model capabilities updated"); setCapsDraft((prev) => { const next = { ...prev }; delete next[configId]; return next; }); await load(); } };
  const autoDefaultAfterCreate = async (providerId: string, capabilities: string[]) => {
    const wanted = ["chat", "image-generation", "video-generation", "audio-generation", "3d-generation"].filter((capability) => capabilities.includes(capability));
    if (!wanted.length) return;
    const current = await cmd("defaults/get");
    const personal = current && current.ok && current.value && current.value.personal ? current.value.personal : {};
    for (const capability of wanted) {
      if (personal[capability]) continue;
      const list = await cmd("model/list");
      const models = list && list.ok && Array.isArray(list.value) ? list.value : [];
      const candidate = models.find((model: any) => model.providerId === providerId && model.status === "enabled" && Array.isArray(model.capabilities) && model.capabilities.includes(capability));
      if (candidate) await cmd("defaults/set", { capability, configId: candidate.configId, scope: "PERSONAL" });
    }
  };
  const createModel = async () => {
    const r = await cmd("model/create", { providerId: mForm.providerId, remoteModelId: mForm.remoteModelId, displayName: mForm.displayName, capabilities: mForm.capabilities, scope: mForm.scope });
    if (r.ok) { setNotice("Model registered"); await load(); await autoDefaultAfterCreate(mForm.providerId, mForm.capabilities); await load(); } else setError(r.error);
  };
  const setModelStatus = async (configId: string, status: string) => { const r = await cmd("model/setStatus", { configId, status }); if (!r.ok) setError(r.error); await load(); };
  /** 注册表单里输入了新模型就按它取；否则退回清单里第一个已存在的模型，进页面即自动呈现参数表单。 */
  const manifestModel = mForm.remoteModelId || (models.length ? String(models[0].remoteModelId || "") : "");
  const manifestIntent = mForm.remoteModelId ? "image.generate" : models.length ? manifestIntentFor(models[0]) : "image.generate";
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!manifestModel) { if (!cancelled) { setManifestFields([]); setManifestDefaults({}); } return; }
      const r = await cmd("manifest/get", { protocolId: OPENAI_COMPATIBLE_PROTOCOL, model: manifestModel, intent: manifestIntent });
      if (cancelled) return;
      if (r.ok && r.parameterSchema && Array.isArray(r.parameterSchema.fields)) {
        setManifestFields(r.parameterSchema.fields);
        setManifestDefaults(r.parameterSchema.defaults || {});
      } else { setManifestFields([]); setManifestDefaults({}); }
    })();
    return () => { cancelled = true; };
  }, [cmd, manifestModel, manifestIntent]);
  /** 配额/限制视图的数据来源：manifest 的 limits（不伪造配额数字，没有就显示 -）。 */
  const limitsLabel = (m: any) => {
    const entry = modelManifests[m?.configId];
    if (!entry || !entry.ok || !entry.manifest || !entry.manifest.limits) return "-";
    const limits = entry.manifest.limits;
    return Object.keys(limits).length ? JSON.stringify(limits) : "-";
  };
  const setDefault = async (capability: string, configId: string, scope: string) => { if (!configId) return; const r = await cmd("defaults/set", { capability, configId, scope }); if (!r.ok) setError(r.error); else { setNotice("Default saved"); await load(); } };
  const credLabel = (providerId: string) => { const c = credStatus[providerId]; if (!c) return "..."; if (c.manageable === false) return "—"; if (!c.storeAvailable) return "Unavailable"; return c.configured ? "Configured" : "Missing"; };
  const opts = (cap: string) => models.filter((m) => m.capabilities.includes(cap)).map((m) => <option key={m.configId} value={m.configId}>{m.displayName || m.remoteModelId}</option>);
  /** 已配置的默认值不在能力过滤后的 options 里（能力不符/已不存在）时，补一个 disabled 选项把它显示出来：
   *  否则 select 匹配不到 option 会回落到第一项，界面看起来像"根本没配"——与画布页"默认不可用"口径冲突。*/
  const defaultOpts = (cap: string, current: string | null | undefined) => {
    const def = current || "";
    const found = def ? models.find((m) => m.configId === def) : null;
    const inList = !!found && found.capabilities.includes(cap);
    return (
      <>
        <option value="">No default configured</option>
        {def && !inList ? <option value={def} disabled data-d4-01-default-unavailable={cap}>{defaultUnavailableText(cap, found)}</option> : null}
        {opts(cap)}
      </>
    );
  };

  /* ══════════════════════════════════════════════════════════════════════
     UI-5 · 模型与协议：协议表 / 能力 manifest / 流式状态
     既有 providers / models / defaults 三个 pane 的 DOM、类名与交互零改动；
     本区块只作为 <section className="model-proto"> 追加在它们之后。
     ══════════════════════════════════════════════════════════════════════ */

  const [protocolItems, setProtocolItems] = useState<ProtocolItem[]>([]);
  const [protocolShadowed, setProtocolShadowed] = useState<ShadowedLegacyItem[]>([]);
  const [protocolLoading, setProtocolLoading] = useState(true);
  const [protocolError, setProtocolError] = useState<string | null>(null);
  const [protocolIncomplete, setProtocolIncomplete] = useState<string | null>(null);
  const [protocolKind, setProtocolKind] = useState<string>(PROTOCOL_KIND_ALL);
  const [protocolQuery, setProtocolQuery] = useState("");
  const [selectedProtocol, setSelectedProtocol] = useState<string | null>(null);
  const [protocolDetail, setProtocolDetail] = useState<{ loading: boolean; code: string | null; view: ProtocolDetail | null }>({ loading: false, code: null, view: null });
  const [manifestView, setManifestView] = useState<ManifestView | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [manifestPick, setManifestPick] = useState("");
  const [streamState, setStreamState] = useState<ModelStreamState>(() => streamInitialState());
  const [streamText, setStreamText] = useState("");
  const [streamPrompt, setStreamPrompt] = useState("");
  /* UI-5b 动作入口：输入 / 进行中 / 失败 / 结果；凭据只提示，不回显。 */
  const [entryInputs, setEntryInputs] = useState<Record<string, string>>({});
  const [entryBusy, setEntryBusy] = useState<string | null>(null);
  const [entryFailure, setEntryFailure] = useState<{ entry: ModelEntryKey; code: string; context: string } | null>(null);
  const [entryResult, setEntryResult] = useState<{ entry: ModelEntryKey; value: unknown } | null>(null);
  /* UI-5c 二次确认：protocol/save 待确认的载荷；非 null 时弹 Dialog，确认前不发命令。 */
  const [pendingEntry, setPendingEntry] = useState<{ key: ModelEntryKey; payload: Record<string, unknown>; summary: string } | null>(null);
  const streamRef = useRef<ModelStreamState>(streamState);
  /* 流式文本按批渲染（MOTION_SYSTEM §7：不逐 token 补间）。reducer 仍逐事件累计，
     这里只决定"什么时候写进 DOM"。 */
  const streamBuffer = useRef(createStreamBuffer());

  const loadProtocols = useCallback(async () => {
    setProtocolLoading(true);
    const res = await cmd("protocol/list", buildProtocolPayload("protocol/list", {}));
    const norm = normalizeProtocolResult(res);
    setProtocolItems(norm.items);
    setProtocolShadowed(norm.shadowedLegacy);
    if (res.ok !== true) { setProtocolError(String(res.error || "INTERNAL_ERROR")); setProtocolIncomplete(null); }
    else { setProtocolError(null); setProtocolIncomplete(norm.problem); }
    setProtocolLoading(false);
  }, [cmd]);
  useEffect(() => { void loadProtocols(); }, [loadProtocols]);

  /** protocol/get 的真实内容；legacy-only 协议会返回 PROTOCOL_NOT_FOUND，界面如实呈现。 */
  const openProtocol = useCallback(async (item: ProtocolItem) => {
    setSelectedProtocol(protocolKey(item));
    setProtocolDetail({ loading: true, code: null, view: null });
    const res = await cmd("protocol/get", buildProtocolPayload("protocol/get", { kind: item.kind, id: item.id }));
    if (res.ok !== true) { setProtocolDetail({ loading: false, code: String(res.error || "INTERNAL_ERROR"), view: null }); return; }
    const view = describeProtocolDetail(res);
    setProtocolDetail(view.found ? { loading: false, code: null, view } : { loading: false, code: "RESPONSE_INCOMPLETE", view: null });
  }, [cmd]);

  const manifestModelDefault = models.length ? String(models[0].remoteModelId || "") : "";
  useEffect(() => { if (!manifestPick && manifestModelDefault) setManifestPick(manifestModelDefault); }, [manifestPick, manifestModelDefault]);

  const loadManifestBlock = useCallback(async (model: string) => {
    if (!model) { setManifestView(null); setManifestError(null); return; }
    setManifestLoading(true); setManifestError(null);
    const picked = models.find((m) => String(m.remoteModelId) === model);
    const intent = picked ? manifestIntentFor(picked) : "llm.chat";
    const res = await cmd("manifest/get", buildProtocolPayload("manifest/get", { protocolId: OPENAI_COMPATIBLE_PROTOCOL, model, intent }));
    if (res.ok !== true) { setManifestView(null); setManifestError(String(res.error || "INTERNAL_ERROR")); }
    else { setManifestView(describeManifest(res)); setManifestError(null); }
    setManifestLoading(false);
  }, [cmd, models]);
  useEffect(() => { void loadManifestBlock(manifestPick); }, [loadManifestBlock, manifestPick]);

  const enabledProviders = providers.filter((p) => p.status === "enabled");
  const streamProvider = enabledProviders.length ? enabledProviders[0] : null;
  const streamModel = models.length ? String(models[0].remoteModelId || "") : "";
  const streamCredential = streamProvider && credStatus[streamProvider.providerId] ? !!credStatus[streamProvider.providerId].configured : null;
  /* 动作入口的可用性凭据：与流式区块用同一个"已启用供应商 + 其凭据状态"。 */
  const entryProviderId = streamProvider ? String(streamProvider.providerId) : null;
  const entryCredentialConfigured = streamCredential;
  const availability = streamAvailability({
    hasBridge: !!bridge(),
    providerCount: providers.length,
    modelCount: models.length,
    enabledProvider: streamProvider ? String(streamProvider.providerId) : null,
    credentialConfigured: streamCredential,
  });
  const phaseFeedback = streamPhaseFeedback(streamState.phase);
  const streamActive = streamState.phase === "queued" || streamState.phase === "starting" || streamState.phase === "streaming" || streamState.phase === "usage" || streamState.phase === "stopping";

  /* model:event（P1 信封）：只接受 model 域的 progress/log/approval；序列单调，缺口显式标注。 */
  useEffect(() => {
    const b = bridge() as any;
    if (!b || typeof b.onEvent !== "function") return;
    const off = b.onEvent((event: unknown) => {
      if (!isModelEvent(event)) return;
      const prev = streamRef.current;
      const next = reduceModelStreamEvent(prev, event, Date.now());
      if (next === prev) return;
      const appended = next.text.length > prev.text.length ? next.text.slice(prev.text.length) : "";
      streamRef.current = next;
      if (appended) streamBuffer.current.push(appended);
      setStreamState(next);
      const terminal = next.phase === "completed" || next.phase === "error" || next.phase === "cancelled";
      if (terminal) { const rest = streamBuffer.current.drain(); if (rest) setStreamText((cur) => cur + rest); }
    });
    return () => { if (typeof off === "function") off(); };
  }, []);

  useEffect(() => {
    const handle = window.setInterval(() => {
      if (!streamBuffer.current.size()) return;
      const chunk = streamBuffer.current.drain();
      if (chunk) setStreamText((prev) => prev + chunk);
    }, STREAM_FLUSH_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, []);

  const startStream = async () => {
    if (!availability.available || !streamProvider) return;
    const requestId = "ui5_" + Date.now().toString(36);
    const started = beginStream(String(streamProvider.providerId), streamModel, requestId, Date.now());
    streamRef.current = started;
    streamBuffer.current = createStreamBuffer();
    setStreamText("");
    setStreamState(started);
    const res = await cmd("provider/callStream", buildProtocolPayload("provider/callStream", {
      providerId: String(streamProvider.providerId),
      model: streamModel,
      messages: [{ role: "user", content: streamPrompt }],
      requestId,
    }));
    const settled = settleStream(streamRef.current, res, Date.now());
    streamRef.current = settled;
    setStreamState(settled);
    const rest = streamBuffer.current.drain();
    if (rest) setStreamText((cur) => cur + rest);
  };

  /** 停止请求：命令面没有中断动作，界面只停止追踪并如实标注（不假装已取消）。 */
  const requestStop = () => {
    const next = requestStreamStop(streamRef.current, Date.now());
    streamRef.current = next;
    setStreamState(next);
  };

  /**
   * 本地必填 / JSON 校验 → buildProtocolPayload 按键白名单构造载荷。
   * 失败写 entryFailure 并返回 null：不弹确认、不发命令。
   * 需要凭据的动作缺凭据时可用性判定已经拦住，这里不会把它发出去。
   */
  const prepareEntry = (key: ModelEntryKey): { payload: Record<string, unknown>; summary: string } | null => {
    const meta = modelEntryMeta(key);
    if (!meta) return null;
    const values: Record<string, string> = {};
    for (const field of meta.inputs) values[field] = entryInputs[key + ":" + field] || "";
    const missing = modelEntryMissingInputs(key, values);
    if (missing.length) {
      setEntryFailure({
        entry: key,
        code: "INVALID_INPUT",
        context: "缺少必填内容（" + missing.map((f) => MODEL_ENTRY_INPUT_LABEL[f] || f).join("、") + "）",
      });
      return null;
    }
    const raw: Record<string, unknown> = {};
    for (const field of meta.inputs) {
      const value = values[field].trim();
      if (!value) continue;
      if (field === "protocol") {
        try {
          raw.protocol = JSON.parse(value);
        } catch {
          setEntryFailure({ entry: key, code: "PROTOCOL_INVALID", context: "协议必须是合法 JSON" });
          return null;
        }
      } else if (field === "count") {
        const n = Number(value);
        raw.count = Number.isFinite(n) && n > 0 ? n : 1;
      } else {
        raw[field] = value;
      }
    }
    const payload = buildProtocolPayload(meta.command, raw);
    return { payload, summary: modelEntryConfirmText(key, payload) };
  };

  /** 点动作入口：写类入口（protocol/save）先弹二次确认；其余入口保持原语义直接发送。 */
  const requestEntry = (key: ModelEntryKey) => {
    setEntryFailure(null);
    const prepared = prepareEntry(key);
    if (!prepared) return;
    if (!modelEntryNeedsConfirm(key)) {
      void submitEntry(key, prepared.payload);
      return;
    }
    setPendingEntry({ key, payload: prepared.payload, summary: prepared.summary });
  };

  const cancelEntryConfirm = () => setPendingEntry(null);

  const confirmEntry = async () => {
    const pending = pendingEntry;
    setPendingEntry(null);
    if (!pending) return;
    await submitEntry(pending.key, pending.payload);
  };

  /** 确认后真正发送（或非写类入口直接发送）：命令 → 结构化结果 / 失败。 */
  const submitEntry = async (key: ModelEntryKey, payload: Record<string, unknown>) => {
    const meta = modelEntryMeta(key);
    if (!meta) return;
    setEntryBusy(key);
    setEntryFailure(null);
    setEntryResult(null);
    setError(null);
    setNotice(null);
    const res = await cmd(meta.command, payload);
    setEntryBusy(null);
    if (res.ok !== true) {
      const code = String(res.error || "INTERNAL_ERROR");
      setEntryFailure({ entry: key, code, context: meta.label });
      if (Array.isArray(res.issues)) setEntryResult({ entry: key, value: { issues: res.issues } });
      return;
    }
    setEntryResult({ entry: key, value: res });
    setNotice(meta.label + "完成");
  };

  const filteredProtocols = useMemo(() => filterProtocols(protocolItems, protocolKind, protocolQuery), [protocolItems, protocolKind, protocolQuery]);
  const protocolState = protocolListState({
    loading: protocolLoading,
    errorCode: protocolError,
    count: protocolItems.length,
    dependencyUnavailable: protocolError === "PROTOCOL_NOT_READY" || protocolError === "NO_BRIDGE",
  });
  const jsonText = (value: unknown) => JSON.stringify(value, null, 2);

  const renderProtocolDetail = () => {
    /* 行级真实字段来自 protocol/list（source / ported / activeVersion / execution …），
       与 protocol/get 的协议体分开呈现：即使 protocol/get 失败（legacy 定义）这些事实也照常显示。 */
    const selectedItem = protocolItems.find((p) => protocolKey(p) === selectedProtocol) || null;
    const factsBlock = selectedItem ? (
      <div className="model-proto__facts-grid" data-model-proto="protocol-row-facts">
        {protocolFacts(selectedItem).map((f) => (
          <div key={f.label} className="model-proto__fact">
            <span className="model-proto__factlabel">{f.label}</span>
            <span className="model-proto__mono">{f.value}</span>
          </div>
        ))}
      </div>
    ) : null;
    const wrap = (content: ReactNode) => (
      <div className="model-proto__detail" data-model-proto-selected={selectedProtocol || ""}>
        {factsBlock}
        {content}
      </div>
    );
    if (protocolDetail.loading) return wrap(<PageState kind="loading" title="正在读取 protocol/get" description="只渲染主进程真实返回的内容。" />);
    if (protocolDetail.code) {
      return wrap(
        <PageState
          kind={modelProtocolErrorState(protocolDetail.code)}
          title={"protocol/get 失败（" + protocolDetail.code + "）"}
          description={modelProtocolErrorText(protocolDetail.code)}
          onAction={selectedProtocol ? () => { const item = protocolItems.find((p) => protocolKey(p) === selectedProtocol); if (item) void openProtocol(item); } : undefined}
        />,
      );
    }
    const view = protocolDetail.view;
    if (!view) return wrap(<PageState kind="empty" title="选择一个协议查看详情" description="详情来自 protocol/get：只显示真实返回的操作 / 工作流 / 模型 profile 声明情况。" />);
    return (
      <div className="model-proto__detail-body" data-model-proto-detail={view.protocolId}>
        {factsBlock}
        <div className="model-proto__detail-head">
          <h5 className="model-proto__detail-title">{view.label}</h5>
          <span className="model-proto__facts">
            <Badge size="sm">v{view.version}</Badge>
            <Badge size="sm">executor {view.executor}</Badge>
          </span>
        </div>
        <p className="model-proto__desc">{view.summary}</p>
        <dl className="model-proto__kv">
          <dt>protocolId</dt><dd>{view.protocolId}</dd>
          <dt>schemaVersion</dt><dd>{view.schemaVersion}</dd>
          <dt>hash</dt><dd className="model-proto__mono">{view.hash}</dd>
          <dt>capabilities</dt><dd>{view.capabilities.length ? view.capabilities.join("、") : "未返回"}</dd>
        </dl>
        <div className="model-proto__group" data-model-proto="declared-groups" role="group" aria-label="协议声明情况">
          {view.groups.map((g) => (
            <span key={g.key} className="model-proto__group-item" data-model-proto-group={g.key} data-model-proto-declared={g.declared ? "true" : "false"}>
              <Badge tone={g.declared ? "success" : "neutral"} size="sm">{g.label}：{g.declared ? g.count + " 条" : "未声明"}</Badge>
            </span>
          ))}
        </div>
        {view.operations.length ? (
          <div className="model-proto__table-wrap">
            <table className="model-proto__table" data-model-proto="operations">
              <caption>操作 operations</caption>
              <thead><tr><th>id</th><th>method</th><th>path</th><th>requestMode</th></tr></thead>
              <tbody>
                {view.operations.map((op) => (
                  <tr key={op.id} data-model-proto-operation={op.id}><td className="model-proto__mono">{op.id}</td><td>{op.method}</td><td className="model-proto__mono">{op.path}</td><td>{op.requestMode}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="model-proto__desc">操作 operations：未声明</p>}
        {view.workflows.length ? (
          <div className="model-proto__table-wrap">
            <table className="model-proto__table" data-model-proto="workflows">
              <caption>工作流 workflows</caption>
              <thead><tr><th>id</th><th>submit</th></tr></thead>
              <tbody>{view.workflows.map((wf) => (<tr key={wf.id} data-model-proto-workflow={wf.id}><td className="model-proto__mono">{wf.id}</td><td className="model-proto__mono">{wf.submit}</td></tr>))}</tbody>
            </table>
          </div>
        ) : <p className="model-proto__desc">工作流 workflows：未声明</p>}
        {view.profiles.length ? (
          <div className="model-proto__table-wrap">
            <table className="model-proto__table" data-model-proto="model-profiles">
              <caption>模型 profile</caption>
              <thead><tr><th>id</th><th>label</th><th>capabilities</th><th>workflows</th><th>uiSchemas</th><th>assets</th><th>limits</th></tr></thead>
              <tbody>
                {view.profiles.map((pf) => (
                  <tr key={pf.id} data-model-proto-profile={pf.id}>
                    <td className="model-proto__mono">{pf.id}</td><td>{pf.label}</td>
                    <td>{pf.capabilities.length ? pf.capabilities.join("、") : "未返回"}</td>
                    <td>{pf.workflowCount}</td>
                    <td>{pf.uiSchemas.length ? pf.uiSchemas.join("、") : "未返回"}</td>
                    <td>{pf.declaredAssets ? "已声明" : "未声明"}</td><td>{pf.declaredLimits ? "已声明" : "未声明"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="model-proto__desc">模型 profile：未声明</p>}
      </div>
    );
  };

  const renderManifestBlock = () => {
    if (manifestLoading) return <PageState kind="loading" title="正在读取 manifest/get" description="参数 schema / limits 由主进程按协议与 intent 解析。" />;
    if (manifestError) return <PageState kind={modelProtocolErrorState(manifestError)} title={"manifest/get 失败（" + manifestError + "）"} description={modelProtocolErrorText(manifestError)} onAction={() => void loadManifestBlock(manifestPick)} />;
    const view = manifestView;
    if (!view) return <PageState kind="empty" title="没有可解析的模型" description="model/list 为空时不会向 manifest/get 发请求；注册模型后再看这里。" />;
    return (
      <div className="model-proto__detail-body" data-model-proto-manifest={view.protocolId}>
        <dl className="model-proto__kv">
          <dt>format</dt><dd>{view.format}</dd>
          <dt>protocolId</dt><dd>{view.protocolId}</dd>
          <dt>protocolVersion</dt><dd>{view.protocolVersion}</dd>
          <dt>protocolHash</dt><dd className="model-proto__mono">{view.protocolHash}</dd>
          <dt>model</dt><dd className="model-proto__mono">{view.model}</dd>
          <dt>intent</dt><dd>{view.intent}</dd>
        </dl>
        <section className="model-proto__sub" data-model-proto="manifest-profile">
          <h5 className="model-proto__sub-title">模型 profile（manifest 子集）</h5>
          {view.profile.declared ? (
            <>
              <dl className="model-proto__kv">
                <dt>profileId</dt><dd>{view.profile.profileId}</dd>
                <dt>profileLabel</dt><dd>{view.profile.profileLabel}</dd>
                <dt>capabilities</dt><dd>{view.profile.capabilities.length ? view.profile.capabilities.join("、") : "未返回"}</dd>
                <dt>coarseCaps</dt><dd>{view.profile.coarseCaps.length ? view.profile.coarseCaps.join("、") : "未返回"}</dd>
                <dt>uiSchemas</dt><dd>{view.profile.uiSchemas.length ? view.profile.uiSchemas.join("、") : "未返回"}</dd>
                <dt>defaultOperations</dt><dd>{view.profile.defaultOperations.length ? view.profile.defaultOperations.map((d) => d.capability + "→" + d.operationId).join("、") : "未返回"}</dd>
                <dt>capabilitySources</dt><dd>{view.profile.capabilitySources.length ? view.profile.capabilitySources.map((d) => d.capability + "←" + d.source).join("、") : "未返回"}</dd>
                <dt>defaults</dt><dd className="model-proto__mono">{Object.keys(view.profile.defaults).length ? jsonText(view.profile.defaults) : "未返回"}</dd>
              </dl>
            </>
          ) : <p className="model-proto__desc">manifest：未返回</p>}
        </section>
        <section className="model-proto__sub" data-model-proto="manifest-schema">
          <h5 className="model-proto__sub-title">参数 schema（parameterSchema）</h5>
          {view.parameterSchema.declared ? (
            <>
              <dl className="model-proto__kv">
                <dt>operationId</dt><dd>{view.parameterSchema.operationId || "未返回"}</dd>
                <dt>schemaId</dt><dd>{view.parameterSchema.schemaId || "未返回"}</dd>
                <dt>source</dt><dd>{view.parameterSchema.source}</dd>
              </dl>
              {view.parameterSchema.fields.length ? (
                <div className="model-proto__table-wrap">
                  <table className="model-proto__table" data-model-proto="manifest-fields">
                    <thead><tr><th>key</th><th>label</th><th>type</th><th>default</th><th>options</th></tr></thead>
                    <tbody>
                      {view.parameterSchema.fields.map((f) => (
                        <tr key={f.key} data-model-proto-field={f.key}><td className="model-proto__mono">{f.key}</td><td>{f.label}</td><td>{f.type}</td><td className="model-proto__mono">{f.defaultValue || "未返回"}</td><td>{f.options.length ? f.options.join("、") : "未返回"}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="model-proto__desc">fields：未返回</p>}
            </>
          ) : <p className="model-proto__desc">parameterSchema：未返回</p>}
        </section>
        <section className="model-proto__sub" data-model-proto="manifest-limits">
          <h5 className="model-proto__sub-title">limits</h5>
          {view.limits.declared
            ? <pre className="model-proto__pre" data-model-proto="limits-value">{jsonText(view.limits.value)}</pre>
            : <p className="model-proto__desc" data-model-proto="limits-missing">未返回</p>}
        </section>
        <section className="model-proto__sub" data-model-proto="manifest-assets">
          <h5 className="model-proto__sub-title">assets</h5>
          {view.assets.declared
            ? <pre className="model-proto__pre" data-model-proto="assets-value">{jsonText(view.assets.value)}</pre>
            : <p className="model-proto__desc" data-model-proto="assets-missing">未返回</p>}
          <p className="model-proto__note">{view.assets.note}</p>
        </section>
        <section className="model-proto__sub" data-model-proto="manifest-profiles-map">
          <h5 className="model-proto__sub-title">modelProfiles 映射</h5>
          {view.modelProfiles.declared
            ? <pre className="model-proto__pre" data-model-proto="model-profiles-value">{jsonText(view.modelProfiles.value)}</pre>
            : <p className="model-proto__desc" data-model-proto="model-profiles-missing">未返回</p>}
          <p className="model-proto__note">{view.modelProfiles.note}</p>
        </section>
        <section className="model-proto__sub" data-model-proto="manifest-operation">
          <h5 className="model-proto__sub-title">operation</h5>
          {view.operation.declared
            ? <dl className="model-proto__kv"><dt>id</dt><dd className="model-proto__mono">{view.operation.id}</dd><dt>method</dt><dd>{view.operation.method}</dd><dt>path</dt><dd className="model-proto__mono">{view.operation.path}</dd><dt>requestMode</dt><dd>{view.operation.requestMode}</dd></dl>
            : <p className="model-proto__desc">未返回</p>}
        </section>
        <section className="model-proto__sub" data-model-proto="manifest-inferred">
          <h5 className="model-proto__sub-title">inferred（可选推断）</h5>
          {view.inferred.declared
            ? <pre className="model-proto__pre" data-model-proto="inferred-value">{jsonText(view.inferred.value)}</pre>
            : <p className="model-proto__desc" data-model-proto="inferred-missing">未返回</p>}
        </section>
        {view.missing.length ? <p className="model-proto__warn" data-model-proto="manifest-missing">{missingFieldsText(view)}</p> : null}
      </div>
    );
  };

  const renderStreamBlock = () => {
    if (!availability.available) {
      return (
        <div className="model-proto__state" data-model-proto-state={"stream-" + availability.kind}>
          <PageState kind="unavailable" title={availability.title} description={availability.description} missing={availability.missing} />
        </div>
      );
    }
    return (
      <div className="model-stream" data-model-stream="console">
        <div className="model-stream__head">
          <span className="model-stream__phase" data-model-proto-stream-phase={streamState.phase} role="status" aria-live="polite">
            <Badge tone={phaseFeedback.tone} size="sm">{phaseFeedback.glyph} {phaseFeedback.label}</Badge>
          </span>
          {phaseFeedback.active ? <span className="model-stream__activity" aria-hidden="true" /> : null}
          <span className="model-proto__facts">
            <span className="model-proto__mono">provider {streamState.providerId || streamProvider?.providerId || "-"}</span>
            <span className="model-proto__mono">model {streamState.model || streamModel || "-"}</span>
            <span className="model-proto__mono">requestId {streamState.requestId || "-"}</span>
          </span>
        </div>
        <p className="model-proto__desc" data-model-proto-stream-detail>{phaseFeedback.detail}</p>
        <div className="model-stream__controls">
          <TextField label="调用内容" labelHidden aria-label="流式调用内容" data-model-proto-field="stream-prompt" value={streamPrompt} onChange={(e) => setStreamPrompt(e.target.value)} placeholder="用一句话说明这次流式调用" />
          <Button variant="primary" size="sm" data-model-proto-action="stream-start" disabled={streamActive} status={streamActive ? "loading" : "idle"} onClick={() => void startStream()}>{streamText || streamActive ? "重新开始流式调用" : "开始流式调用"}</Button>
          <Button variant="secondary" size="sm" data-model-proto-action="stream-cancel" disabled={!streamActive || streamState.phase === "stopping"} onClick={() => requestStop()}>停止</Button>
        </div>
        <div className="model-stream__facts">
          <span data-model-stream-deltas>增量 {streamState.deltas}</span>
          <span data-model-stream-tool-deltas>工具增量 {streamState.toolDeltas}</span>
          <span data-model-stream-last-seq>最近 sequence {streamState.lastSequence || "未返回"}</span>
          <span data-model-stream-duplicates>重复 {streamState.duplicates}</span>
          {streamState.mutedAfterStop ? <span data-model-stream-muted>停止后丢弃 {streamState.mutedAfterStop}</span> : null}
          {streamGapText(streamState) ? <span className="model-proto__warn" data-model-stream-gap>{streamGapText(streamState)}</span> : null}
        </div>
        {streamState.usage ? <pre className="model-proto__pre" data-model-stream-usage>{jsonText(streamState.usage)}</pre> : null}
        {streamState.errorCode ? <p className="model-proto__warn" data-model-stream-error>{streamState.errorCode + "：" + modelProtocolErrorText(streamState.errorCode)}{streamState.errorDetail ? "（" + streamState.errorDetail + "）" : ""}</p> : null}
        {streamState.resultCode ? <p className="model-proto__note" data-model-stream-result>调用结果码 {streamState.resultCode}</p> : null}
        <p className="model-proto__desc" data-model-proto="stream-text">{streamText || (streamActive ? "（等待第一个增量…）" : "（还没有流式文本）")}</p>
        <ScrollArea className="model-stream__events-scroll" maxHeight={220} label="流式事件">
          {streamState.events.length ? (
            <ol className="model-stream__events" data-model-stream-events>
              {streamState.events.map((row) => (
                <li key={row.key} data-model-stream-event={row.type} data-model-stream-seq={streamSequenceText(row)}>
                  <span className="model-stream__seq">#{streamSequenceText(row)}</span>
                  <span className="model-stream__kind">{row.kind}</span>
                  <span className="model-stream__type">{row.type}</span>
                  <span className="model-stream__msg">{row.summary}</span>
                  <span className="model-stream__at">{row.at ? new Date(row.at).toLocaleTimeString("zh-CN") : "未返回"}</span>
                </li>
              ))}
            </ol>
          ) : <p className="model-proto__desc">还没有 model:event 事件。</p>}
        </ScrollArea>
        <p className="model-proto__note">流式区块的命令：provider/callStream；增量只来自 model:event 的 P1 信封（channel/domain/kind/sequence/at/payload）。停止只停止界面追踪，当前命令面没有中断动作。</p>
      </div>
    );
  };

  return (
    <div className="d401-settings" data-d4-01="settings">
      <nav className="d401-tabs" role="tablist" aria-label="模型设置分区">
        {(["providers", "models", "defaults"] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} data-d4-01-tab={t} onClick={() => setTab(t)}>
            {{ providers: "Providers", models: "Models", defaults: "Defaults" }[t]}
          </button>
        ))}
      </nav>
      {error ? <p className="d401-error" role="alert" data-d4-01-error>{error}</p> : null}
      {notice ? <p className="d401-notice" role="status" data-d4-01-notice>{notice}</p> : null}
      {busy ? <p className="muted" data-d4-01-busy>...</p> : null}

      {tab === "providers" ? (
        <section data-d4-01-pane="providers">
          <div className="d401-form">
            <input data-d4-01-provider-name aria-label="Provider display name" placeholder="Display Name" value={pForm.displayName} onChange={(e) => setPForm({ ...pForm, displayName: e.target.value })} />
            <input data-d4-01-provider-url aria-label="Provider base URL" placeholder="Base URL" value={pForm.baseUrl} onChange={(e) => setPForm({ ...pForm, baseUrl: e.target.value })} />
            <select data-d4-01-provider-scope aria-label="Provider scope" value={pForm.scope} onChange={(e) => setPForm({ ...pForm, scope: e.target.value })}>
              <option value="PERSONAL">PERSONAL</option>
              <option value="ORGANIZATION">ORGANIZATION</option>
            </select>
            <input data-d4-01-provider-secret aria-label="Provider API key" type="password" placeholder="API Key" value={pForm.credentialSecret} onChange={(e) => setPForm({ ...pForm, credentialSecret: e.target.value })} />
            <Button variant="primary" size="sm" data-d4-01-provider-create onClick={() => void createProvider()}>创建 Provider</Button>
          </div>
          {providers.length === 0 ? <p className="muted" data-d4-01-providers-empty>No model providers configured</p> : null}
          <ul className="d401-list" data-d4-01-providers>
            {providers.map((p) => (
              <li key={p.providerId} data-d4-01-provider={p.providerId} className="d401-row">
                <span className="d401-name">{p.displayName}</span>
                <span className="d401-meta">{p.adapterType} | {p.baseUrl} | {p.endpointScope} | {p.scope}</span>
                <span className="d401-meta" data-d4-01-provider-status>{p.status}</span>
                <span className="d401-meta" data-d4-01-cred-status={p.providerId}>{credLabel(p.providerId)}</span>
                <input data-d4-01-cred-input={p.providerId} aria-label={"API key for " + p.displayName} type="password" placeholder="API Key" value={credDraft[p.providerId] || ""} onChange={(e) => setCredDraft({ ...credDraft, [p.providerId]: e.target.value })} />
                <Button variant="secondary" size="sm" data-d4-01-cred-set={p.providerId} onClick={() => void saveCred(p.providerId, false)}>保存</Button>
                <Button variant="secondary" size="sm" data-d4-01-cred-replace={p.providerId} onClick={() => void saveCred(p.providerId, true)}>替换</Button>
                <Button variant="ghost" size="sm" data-d4-01-cred-delete={p.providerId} onClick={() => void deleteCred(p.providerId)}>删除密钥</Button>
                <Button variant="ghost" size="sm" data-d4-01-test={p.providerId} onClick={() => void runTest(p.providerId)}>连接测试</Button>
                {p.status === "enabled"
                  ? <Button variant="ghost" size="sm" data-d4-01-provider-disable={p.providerId} onClick={() => void setProviderStatus(p.providerId, "disabled")}>禁用</Button>
                  : <Button variant="secondary" size="sm" data-d4-01-provider-enable={p.providerId} onClick={() => void setProviderStatus(p.providerId, "enabled")}>启用</Button>}
                {tests[p.providerId] ? <span className="d401-test" data-d4-01-test-result={p.providerId}>{testLabel(tests[p.providerId])}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {tab === "models" ? (
        <section data-d4-01-pane="models">
          <div className="d401-form">
            <select data-d4-01-model-provider aria-label="Model provider" value={mForm.providerId} onChange={(e) => setMForm({ ...mForm, providerId: e.target.value })}>
              <option value="">选择 Provider</option>
              {providers.map((p) => <option key={p.providerId} value={p.providerId}>{p.displayName}</option>)}
            </select>
            <input data-d4-01-model-remote aria-label="Remote model ID" placeholder="Remote Model ID" value={mForm.remoteModelId} onChange={(e) => setMForm({ ...mForm, remoteModelId: e.target.value })} />
            <input data-d4-01-model-name aria-label="Model display name" placeholder="Display Name" value={mForm.displayName} onChange={(e) => setMForm({ ...mForm, displayName: e.target.value })} />
            <select data-d4-01-model-scope aria-label="Model scope" value={mForm.scope} onChange={(e) => setMForm({ ...mForm, scope: e.target.value })}>
              <option value="PERSONAL">PERSONAL</option>
              <option value="ORGANIZATION">ORGANIZATION</option>
            </select>
            <div className="d401-caps" data-d4-01-model-create-caps role="group" aria-label="模型能力">
              {CAPABILITY_CHOICES.map((c) => (
                <label key={c.id}>
                  <input
                    type="checkbox"
                    data-d4-01-model-create-cap={c.id}
                    checked={mForm.capabilities.includes(c.id)}
                    onChange={() => setMForm({ ...mForm, capabilities: toggleCap(mForm.capabilities, c.id) })}
                  />
                  {c.label}
                </label>
              ))}
            </div>
            {manifestFields.length ? (
              <div className="d401-caps" data-d4-01-manifest-fields role="group" aria-label="模型参数">
                {manifestFields.map((field: any) => (
                  <label key={String(field.key)}>
                    {String(field.label || field.key)}
                    <input
                      data-d4-01-manifest-field={String(field.key)}
                      aria-label={String(field.label || field.key)}
                      value={paramDraft[String(field.key)] ?? String(manifestDefaults[String(field.key)] ?? field.default ?? "")}
                      onChange={(e) => setParamDraft({ ...paramDraft, [String(field.key)]: e.target.value })}
                    />
                  </label>
                ))}
              </div>
            ) : null}
            <Button variant="primary" size="sm" data-d4-01-model-create onClick={() => void createModel()}>注册 Model</Button>
          </div>
          {models.length === 0 ? <p className="muted" data-d4-01-models-empty>No models configured</p> : null}
          <ul className="d401-list" data-d4-01-models>
            {models.map((m) => (
              <li key={m.configId} data-d4-01-model={m.configId} className="d401-row">
                <span className="d401-name">{m.displayName || m.remoteModelId}</span>
                <span className="d401-meta">{m.remoteModelId} | {m.scope} | v{m.version} | {m.status}</span>
                <span className="d401-meta" data-d4-01-model-declared={m.configId}>Declared: {m.capabilities.join(", ") || "-"}</span>
                <span className="d401-meta" data-d4-01-model-verified={m.configId}>Verified: {m.verifiedCapabilities.join(", ") || "-"}</span>
                <span className="d401-meta" data-d4-01-model-limits={m.configId}>Limits: {limitsLabel(m)}</span>
                <div className="d401-caps" role="group" aria-label={"模型能力 " + (m.displayName || m.remoteModelId)}>
                  {CAPABILITY_CHOICES.map((c) => (
                    <label key={c.id}>
                      <input
                        type="checkbox"
                        data-d4-01-model-cap={m.configId}
                        data-d4-01-model-cap-id={c.id}
                        checked={draftCaps(m).includes(c.id)}
                        onChange={() => setCapsDraft((prev) => ({ ...prev, [m.configId]: toggleCap(draftCaps(m), c.id) }))}
                      />
                      {c.label}
                    </label>
                  ))}
                  <Button variant="secondary" size="sm" data-d4-01-model-cap-save={m.configId} onClick={() => void saveCaps(m.configId)}>保存能力</Button>
                </div>
                {m.status === "enabled"
                  ? <Button variant="ghost" size="sm" data-d4-01-model-disable={m.configId} onClick={() => void setModelStatus(m.configId, "disabled")}>禁用</Button>
                  : <Button variant="secondary" size="sm" data-d4-01-model-enable={m.configId} onClick={() => void setModelStatus(m.configId, "enabled")}>启用</Button>}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {tab === "defaults" && defaults ? (
        <section data-d4-01-pane="defaults">
          <div className="d401-defaults" data-d4-01-defaults-personal>
            <h4>My Defaults</h4>
            <label>Chat <select data-d4-01-default-personal-chat value={defaults.personal.chat || ""} onChange={(e) => void setDefault("chat", e.target.value, "PERSONAL")}>{defaultOpts("chat", defaults.personal.chat)}</select></label>
            <label>Tool Calling <select data-d4-01-default-personal-tool value={defaults.personal["tool-calling"] || ""} onChange={(e) => void setDefault("tool-calling", e.target.value, "PERSONAL")}>{defaultOpts("tool-calling", defaults.personal["tool-calling"])}</select></label>
            <label>Image Generation <select data-d4-01-default-personal-image value={defaults.personal["image-generation"] || ""} onChange={(e) => void setDefault("image-generation", e.target.value, "PERSONAL")}>{defaultOpts("image-generation", defaults.personal["image-generation"])}</select></label>
            <label>Video Generation <select data-d4-01-default-personal-video value={defaults.personal["video-generation"] || ""} onChange={(e) => void setDefault("video-generation", e.target.value, "PERSONAL")}>{defaultOpts("video-generation", defaults.personal["video-generation"])}</select></label>
            <label>Audio Generation <select data-d4-01-default-personal-audio value={defaults.personal["audio-generation"] || ""} onChange={(e) => void setDefault("audio-generation", e.target.value, "PERSONAL")}>{defaultOpts("audio-generation", defaults.personal["audio-generation"])}</select></label>
            <label>3D Generation <select data-d4-01-default-personal-3d value={defaults.personal["3d-generation"] || ""} onChange={(e) => void setDefault("3d-generation", e.target.value, "PERSONAL")}>{defaultOpts("3d-generation", defaults.personal["3d-generation"])}</select></label>
          </div>
          <div className="d401-defaults" data-d4-01-defaults-organization>
            <h4>Organization Defaults {defaults.canManageOrganization ? null : <span className="muted">(read-only)</span>}</h4>
            <label>Chat <select data-d4-01-default-org-chat value={defaults.organization.chat || ""} onChange={(e) => void setDefault("chat", e.target.value, "ORGANIZATION")}>{defaultOpts("chat", defaults.organization.chat)}</select></label>
            <label>Tool Calling <select data-d4-01-default-org-tool value={defaults.organization["tool-calling"] || ""} onChange={(e) => void setDefault("tool-calling", e.target.value, "ORGANIZATION")}>{defaultOpts("tool-calling", defaults.organization["tool-calling"])}</select></label>
            <label>Image Generation <select data-d4-01-default-org-image value={defaults.organization["image-generation"] || ""} onChange={(e) => void setDefault("image-generation", e.target.value, "ORGANIZATION")}>{defaultOpts("image-generation", defaults.organization["image-generation"])}</select></label>
            <label>Video Generation <select data-d4-01-default-org-video value={defaults.organization["video-generation"] || ""} onChange={(e) => void setDefault("video-generation", e.target.value, "ORGANIZATION")}>{defaultOpts("video-generation", defaults.organization["video-generation"])}</select></label>
            <label>Audio Generation <select data-d4-01-default-org-audio value={defaults.organization["audio-generation"] || ""} onChange={(e) => void setDefault("audio-generation", e.target.value, "ORGANIZATION")}>{defaultOpts("audio-generation", defaults.organization["audio-generation"])}</select></label>
            <label>3D Generation <select data-d4-01-default-org-3d value={defaults.organization["3d-generation"] || ""} onChange={(e) => void setDefault("3d-generation", e.target.value, "ORGANIZATION")}>{defaultOpts("3d-generation", defaults.organization["3d-generation"])}</select></label>
          </div>
          {role !== "ADMIN" ? <p className="muted" data-d4-01-org-hint>Organization defaults require an authorized admin.</p> : null}
        </section>
      ) : null}

      {/* ══════════════════════════════════════════════════════════════════
          UI-5 · 模型与协议：协议表 / 能力 manifest / 流式状态
          只按顺序追加在既有 providers / models / defaults 三个 pane 之后；
          既有区块的 DOM、类名与交互保持原样。新增样式只到 .model-proto-* / .model-stream-*。
          ══════════════════════════════════════════════════════════════════ */}
      <section className="model-proto" data-model-proto="console" aria-label="模型与协议">
        <div className="model-proto__banner">
          <div className="model-proto__banner-row">
            <h3 className="model-proto__title">协议与流式状态</h3>
            <span data-model-proto="protocol-count"><Badge size="sm">协议 {protocolItems.length}</Badge></span>
            {protocolShadowed.length ? <span data-model-proto="protocol-shadowed"><Badge tone="warning" size="sm">被 v2 遮蔽的 legacy {protocolShadowed.length}</Badge></span> : null}
          </div>
          <p className="model-proto__hint">
            数据只来自 window.openarc.model 的受控命令（protocol/list、protocol/get、manifest/get、provider/callStream）；
            流式增量只来自 model:event 的 P1 信封。后端没有返回的字段一律标注"未返回"，不补造内容。
          </p>
        </div>

        {/* ── 1) 协议表：id/kind/label/engine/source/activeVersion/capabilities/ported/execution ── */}
        <div className="model-proto__block" data-model-proto="protocols">
          <div className="model-proto__block-head">
            <h4 className="model-proto__block-title">协议表</h4>
            <span className="model-proto__filters" role="group" aria-label="按 kind 过滤协议">
              {protocolKindOptions(protocolItems).map((k) => (
                <Button key={k} variant={protocolKind === k ? "secondary" : "ghost"} size="sm" aria-pressed={protocolKind === k} data-model-proto-kind={k} onClick={() => setProtocolKind(k)}>
                  {protocolKindLabel(k)}
                </Button>
              ))}
            </span>
          </div>
          <div className="model-proto__controls">
            <SearchField value={protocolQuery} onValueChange={setProtocolQuery} placeholder="搜索协议 id / label / 能力" label="搜索协议" data-model-proto-search="protocols" />
            <Button variant="secondary" size="sm" data-model-proto-action="protocol-reload" status={protocolLoading ? "loading" : "idle"} onClick={() => void loadProtocols()}>刷新协议表</Button>
          </div>
          {protocolIncomplete ? <p className="model-proto__warn" data-model-proto="protocol-incomplete">{protocolIncomplete}</p> : null}
          {protocolState !== "ready" ? (
            <div className="model-proto__state" data-model-proto-state={protocolState}>
              <PageState
                kind={protocolState}
                title={protocolState === "loading" ? "正在读取协议表" : protocolState === "empty" ? "协议表为空" : protocolState === "unavailable" ? "协议域不可用" : protocolState === "unauthorized" ? "没有读取协议表的权限" : "协议表读取失败"}
                description={protocolState === "loading" ? "等待 protocol/list 返回项目真实协议。" : modelProtocolErrorText(protocolError || "RESPONSE_INCOMPLETE")}
                onAction={protocolState === "error" || protocolState === "unauthorized" ? () => void loadProtocols() : undefined}
              />
            </div>
          ) : (
            <div className="model-proto__split">
              <div className="model-proto__list-pane">
                <div className="model-proto__pane-head">
                  <span className="model-proto__pane-title">协议</span>
                  <span className="model-proto__facts">共 {protocolItems.length} 条 · 当前 {filteredProtocols.length} 条</span>
                </div>
                {filteredProtocols.length ? (
                  <ScrollArea className="model-proto__list-scroll" maxHeight={340} label="协议列表">
                    <ul className="model-proto__list" data-model-proto-list>
                      {filteredProtocols.map((item) => {
                        const status = protocolRowStatus(item);
                        const key = protocolKey(item);
                        return (
                          <li key={key}>
                            <button
                              type="button"
                              className="model-proto__row"
                              data-model-proto-item={key}
                              aria-pressed={selectedProtocol === key}
                              onClick={() => void openProtocol(item)}
                            >
                              <span className="model-proto__row-top">
                                <strong>{item.label || item.id}</strong>
                                <Badge tone={status.tone} size="sm">{status.label}</Badge>
                              </span>
                              <span className="model-proto__row-facts">
                                <span>{item.id}</span>
                                <span>{item.kind}</span>
                                <span>engine {item.engine || "未返回"}</span>
                                {item.activeVersion == null ? <span>activeVersion 未返回</span> : <span>v{item.activeVersion}</span>}
                              </span>
                              <span className="model-proto__row-desc">{status.detail}</span>
                              <span className="model-proto__row-cap">能力 {protocolCapabilitiesText(item)}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </ScrollArea>
                ) : (
                  <PageState
                    kind="empty"
                    title="没有匹配的协议"
                    description={protocolQuery ? "当前搜索/k过滤下没有协议；清空搜索或切回「全部」。" : "protocol/list 返回了 0 条协议。"}
                  />
                )}
              </div>
              <div className="model-proto__detail-pane" data-model-proto-detail-pane>{renderProtocolDetail()}</div>
            </div>
          )}
        </div>

        {/* ── 2) 能力 manifest：manifest/get 的真实输出 ── */}
        <div className="model-proto__block" data-model-proto="manifest">
          <div className="model-proto__block-head">
            <h4 className="model-proto__block-title">能力 manifest</h4>
            <span className="model-proto__facts">协议 {OPENAI_COMPATIBLE_PROTOCOL}</span>
          </div>
          <div className="model-proto__controls">
            <TextField label="模型" value={manifestPick} onChange={(e) => setManifestPick(e.target.value)} placeholder="remoteModelId（例如 gpt-image）" data-model-proto-field="manifest-model" />
            <Button variant="secondary" size="sm" data-model-proto-action="manifest-load" status={manifestLoading ? "loading" : "idle"} onClick={() => void loadManifestBlock(manifestPick)}>读取 manifest</Button>
          </div>
          {renderManifestBlock()}
        </div>

        {/* ── 3) 流式状态：provider/callStream + model:event ── */}
        <div className="model-proto__block" data-model-proto="stream">
          <div className="model-proto__block-head">
            <h4 className="model-proto__block-title">流式状态</h4>
            <span className="model-proto__facts" data-model-proto="stream-availability">{availability.kind}</span>
          </div>
          {renderStreamBlock()}
        </div>

        {/* ── 4) 动作入口：协议校验 / 协议保存 / 图像生成 / 协议执行 ── */}
        <div className="model-proto__block" data-model-proto="entries">
          <div className="model-proto__block-head">
            <h4 className="model-proto__block-title">动作入口</h4>
            <span className="model-proto__facts" data-model-proto="entries-facts">
              已启用供应商 {enabledProviders.length} 个 · 凭据 {entryCredentialConfigured === null ? "未知" : entryCredentialConfigured ? "已配置" : "缺失"}
            </span>
          </div>
          <p className="model-proto__hint">
            协议校验 / 保存是本地动作；图像生成 / 协议执行需要凭据。缺凭据时只给结构化提示，
            不发起调用，也不回显任何密钥。
          </p>
          <ScrollArea label="模型动作入口" maxHeight={360}>
            {MODEL_ENTRIES.map((meta) => {
              const av = modelEntryAvailability(meta.key, {
                hasBridge: !!bridge(),
                enabledProvider: entryProviderId,
                credentialConfigured: entryCredentialConfigured,
                hasProtocol: !!String(
                  entryInputs["protocol-validate:protocol"] || entryInputs["protocol-save:protocol"] || "",
                ).trim(),
              });
              const busy = entryBusy === meta.key;
              const failure = entryFailure && entryFailure.entry === meta.key ? entryFailure : null;
              const result = entryResult && entryResult.entry === meta.key ? entryResult : null;
              return (
                <div
                  className="model-proto__sub model-proto-action"
                  key={meta.key}
                  data-model-entry={meta.key}
                  data-model-entry-command={meta.command}
                  data-model-entry-state={busy ? "busy" : av.available ? "ready" : av.kind}
                  data-model-entry-risk={meta.risk}
                  aria-busy={busy ? "true" : undefined}
                >
                  <div className="model-proto__facts model-proto-action-head">
                    <span data-model-entry-risk-badge>
                      <Badge tone={meta.risk === "read" ? "neutral" : "warning"} size="sm">
                        {MODEL_ENTRY_RISK_LABEL[meta.risk]}
                      </Badge>
                    </span>
                    {meta.requiresCredential ? (
                      <span data-model-entry-credential="required">
                        <Badge tone="warning" size="sm">需要凭据</Badge>
                      </span>
                    ) : null}
                    <strong>{meta.label}</strong>
                    <span className="model-proto__mono">{meta.command}</span>
                  </div>
                  <p className="model-proto__desc model-proto-action-meta">{meta.description}</p>
                  <p
                    className={(av.available ? "model-proto__desc" : "model-proto__warn") + " model-proto-action-meta"}
                    data-model-entry-availability={av.kind}
                  >
                    {av.title} · {av.description}
                  </p>
                  <p className="model-proto__note model-proto-action-meta" data-model-entry-risk-text>
                    {MODEL_ENTRY_RISK_TEXT[meta.key]}
                  </p>
                  {meta.inputs.map((field) => (
                    <TextField
                      key={field}
                      label={MODEL_ENTRY_INPUT_LABEL[field] || field}
                      data-model-entry-field={meta.key + ":" + field}
                      value={entryInputs[meta.key + ":" + field] || ""}
                      onChange={(e) =>
                        setEntryInputs((cur) => ({ ...cur, [meta.key + ":" + field]: e.target.value }))
                      }
                    />
                  ))}
                  <div className="model-stream__controls model-proto-action-actions">
                    <Button
                      variant={meta.risk === "read" ? "secondary" : "primary"}
                      size="sm"
                      data-model-entry-action={meta.key}
                      status={busy ? "loading" : "idle"}
                      disabled={!av.available || entryBusy !== null}
                      onClick={() => requestEntry(meta.key)}
                    >
                      {meta.label}
                    </Button>
                    <span className="model-proto__note">{av.available ? "前置条件已满足" : "前置条件未满足"}</span>
                  </div>
                  {failure ? (
                    <p
                      className="model-proto__warn"
                      role="alert"
                      data-model-entry-error
                      data-model-entry-error-code={failure.code}
                    >
                      {failure.context}：{modelProtocolErrorText(failure.code)}（{failure.code}）
                    </p>
                  ) : null}
                  {result ? (
                    <pre className="model-proto__pre" data-model-entry-result>
                      {jsonText(result.value)}
                    </pre>
                  ) : null}
                </div>
              );
            })}
          </ScrollArea>
        </div>

        {/* 写类入口（protocol/save）二次确认：确认前不发命令；取消 / Esc 都不发送。 */}
        <Dialog
          open={pendingEntry !== null}
          title={pendingEntry ? modelEntryConfirmTitle(pendingEntry.key) : "确认"}
          onClose={cancelEntryConfirm}
          footer={
            <>
              <Button variant="ghost" size="sm" data-model-entry-confirm-cancel onClick={cancelEntryConfirm}>
                取消
              </Button>
              <Button
                variant="primary"
                size="sm"
                data-model-entry-confirm-submit
                status={entryBusy !== null ? "loading" : "idle"}
                disabled={entryBusy !== null}
                onClick={() => void confirmEntry()}
              >
                确认保存
              </Button>
            </>
          }
        >
          {pendingEntry ? (
            <div className="model-proto-action-confirm" data-model-entry-confirm={pendingEntry.key}>
              <p className="model-proto-action-confirm-value" data-model-entry-confirm-summary>
                {pendingEntry.summary}
              </p>
              <p className="model-proto__note">确认前不会发出任何命令；取消则命令数为 0。</p>
            </div>
          ) : null}
        </Dialog>
      </section>
    </div>
  );
}
