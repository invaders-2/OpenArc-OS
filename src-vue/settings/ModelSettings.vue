<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import DsBadge from "../design-system/DsBadge.vue";
import DsButton from "../design-system/DsButton.vue";
import DsDialog from "../design-system/DsDialog.vue";
import CliPanel from "./CliPanel.vue";
import { t as tr } from "../i18n";
import ProviderForm from "./ProviderForm.vue";
import RemoteModelsPanel from "./RemoteModelsPanel.vue";
import ProtocolSettingsPanel from "./ProtocolSettingsPanel.vue";
import { classifyRemoteModel } from "./modelCategories";
import { resolveProviderLogo } from "./providerLogos";
import {
  EGRESS_PROXY_DEFAULT_URL,
  egressProxyErrorText,
  egressProxyStatusView,
  normalizeEgressProxyResult,
  validateEgressProxyDraft,
} from "./egressProxyLogic";
import { useShellStore } from "../stores/shell";
import { normalizeProtocolResult } from "../../src/settings/modelProtocolLogic";

/**
 * D4-01 Closure C · Settings → Models / AI（对齐 src/settings/ModelSettings.tsx）。
 * 只经 window.openarc.model.command；credential write-only。
 * 所有 data-d4-01-* 契约逐项保留（tabs / panes / provider-* / model-* / defaults-*）。
 */

withDefaults(defineProps<{ role?: string | null }>(), { role: null });

const CAPABILITY_CHOICES = [
  { id: "chat", label: "文本对话" },
  { id: "image-generation", label: "生图" },
  { id: "vision-input", label: "图片输入" },
] as const;

const CAPABILITY_LABEL: Record<string, string> = {
  chat: "文本对话",
  "image-generation": "生图",
  "tool-calling": "工具调用",
  "vision-input": "图片输入",
};

function defaultUnavailableText(cap: string, m: any) {
  const name = m ? String(m.displayName || m.remoteModelId || m.configId) : tr("（该模型已不在清单里）");
  return name + (m ? tr("（已配置为默认，但没有「{cap}」能力，不可用）", { cap: tr(CAPABILITY_LABEL[cap] || cap) }) : tr("（已配置为默认，不可用）"));
}

const bridge = () => (window as any).openarc?.model;
const shell = useShellStore();
const logoTheme = computed<"light" | "dark">(() => (shell.dark ? "dark" : "light"));
/** 有品牌资源就上 logo；没有就由模板回退到既有彩色首字母。键与判定见 ./providerLogos.ts。 */
function providerLogo(p: any) {
  return resolveProviderLogo(
    { providerId: p?.providerId, displayName: p?.displayName, protocol: p?.protocol, adapterType: p?.adapterType },
    logoTheme.value,
  );
}

const providers = ref<any[]>([]);
const models = ref<any[]>([]);
const defaults = ref<any>(null);
const credStatus = ref<Record<string, any>>({});
const tests = ref<Record<string, any>>({});
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);
const mForm = reactive({ providerId: "", remoteModelId: "", displayName: "", capabilities: ["chat"] as string[], scope: "PERSONAL" });
const credDraft = ref<Record<string, string>>({});
const capsDraft = ref<Record<string, string[]>>({});

async function cmd(command: string, payload: Record<string, unknown> = {}): Promise<any> {
  const b = bridge();
  if (!b) return { ok: false, error: "NO_BRIDGE" };
  try {
    return await b.command({ command, payload });
  } catch {
    return { ok: false, error: "INTERNAL_ERROR" };
  }
}

async function load() {
  busy.value = true;
  error.value = null;
  const [p, m, d] = await Promise.all([cmd("provider/list"), cmd("model/list"), cmd("defaults/get")]);
  if (p.ok) providers.value = Array.isArray(p.items) ? p.items : [];
  else error.value = p.error;
  if (m.ok) models.value = Array.isArray(m.items) ? m.items : [];
  else error.value = m.error;
  if (d.ok) defaults.value = d;
  else error.value = d.error;
  if (p.ok) {
    const entries = await Promise.all(
      providers.value.map(async (it: any) => [it.providerId, await cmd("credential/status", { providerId: it.providerId })] as const),
    );
    credStatus.value = Object.fromEntries(entries);
  }
  busy.value = false;
}
/**
 * 预设的协议可用性来自运行期 protocol/list（不写死：另一包把 anthropic / lovart 协议落地后自动生效）。
 * 拿不到就保持 null —— 界面如实标「协议未确认」，不假装知道，也不静默放行。
 */
const knownProtocols = ref<string[] | null>(null);
async function loadProtocols() {
  const r = await cmd("protocol/list");
  if (!r || r.ok !== true) {
    knownProtocols.value = null;
    return;
  }
  const view = normalizeProtocolResult(r);
  knownProtocols.value = [...new Set(view.items.map((it: any) => String(it.id || "").trim()).filter(Boolean))];
}
onMounted(() => {
  void load();
  void loadProtocols();
});

/**
 * 「添加 / 编辑服务商」共用 ProviderForm 的校验与 payload。
 * 校验失败由组件 emit invalid(错误码)，这里保持既有 data-d4-01-error 的结构化展示。
 */
const providerFormRef = ref<{ reset: () => void } | null>(null);
const editingProviderId = ref<string | null>(null);
const providerDialogOpen = ref(false);
const providerDialogMode = ref<"create" | "edit">("create");
const providerDialogSeq = ref(0);
const providerViewOpen = ref(false);
const defaultsDialogOpen = ref(false);
const egressDialogOpen = ref(false);
function openProviderView(providerId: string) {
  selected.value = providerId;
  editingProviderId.value = null;
  providerDialogOpen.value = false;
  providerViewOpen.value = true;
}
function openProviderCreate() {
  selected.value = "new";
  editingProviderId.value = null;
  providerDialogMode.value = "create";
  providerDialogSeq.value += 1;
  providerDialogOpen.value = true;
}
function openProviderEdit(providerId: string) {
  editingProviderId.value = providerId;
  providerDialogMode.value = "edit";
  providerDialogSeq.value += 1;
  providerDialogOpen.value = true;
}
function closeProviderDialog() {
  providerDialogOpen.value = false;
  editingProviderId.value = null;
  if (selected.value === "new") selected.value = providers.value[0]?.providerId ?? null;
}
function onProviderInvalid(code: string) {
  error.value = code;
}
async function onProviderSubmit(event: { mode: "create" | "edit"; payload: Record<string, unknown>; credentialSecret: string; originChanged: boolean }) {
  error.value = null;
  if (event.mode === "create") {
    const before = providers.value.map((p) => p.providerId);
    const res = await cmd("provider/create", event.payload);
    if (!res.ok) {
      error.value = res.error;
      return;
    }
    notice.value = tr("已添加服务商");
    providerFormRef.value?.reset();
    await load();
    const added = providers.value.find((p) => !before.includes(p.providerId));
    if (added) selected.value = added.providerId;
    providerDialogOpen.value = false;
    return;
  }
  const providerId = String(event.payload.providerId || "");
  // 先落服务商字段（含显式 allowInsecureHttp 布尔），换密钥再走 credential/replace：
  // 若先换密钥、后改地址，凭据会被绑到旧 origin（后端 providerOrigin 在创建时固定）。
  const res = await cmd("provider/update", event.payload);
  if (!res.ok) {
    error.value = res.error;
    return;
  }
  if (event.credentialSecret) {
    const cred = await cmd("credential/replace", { providerId, secret: event.credentialSecret });
    if (!cred.ok) {
      // 服务商字段已保存，密钥没换成：保持编辑态让用户重试，绝不谎报整体成功。
      error.value = cred.error;
      notice.value = tr("服务商已保存，但密钥替换失败");
      await load();
      return;
    }
  }
  if (event.originChanged && !event.credentialSecret) {
    notice.value = tr("已保存服务商；API 地址 origin 已变化且未提供新密钥，旧密钥仍绑定原地址，请重新粘贴密钥后再保存。");
  } else {
    notice.value = tr(event.credentialSecret ? "已保存服务商并替换密钥" : "已保存服务商");
  }
  editingProviderId.value = null;
  providerDialogOpen.value = false;
  await load();
}
async function setProviderStatus(providerId: string, status: string) {
  const r = await cmd("provider/setStatus", { providerId, status });
  if (!r.ok) error.value = r.error;
  await load();
}
async function saveCred(providerId: string, replace: boolean) {
  const secret = credDraft.value[providerId] || "";
  if (!secret) return;
  const r = await cmd(replace ? "credential/replace" : "credential/set", { providerId, secret });
  if (r.ok) {
    notice.value = replace ? "Credential replaced" : "Credential saved";
    credDraft.value = { ...credDraft.value, [providerId]: "" };
    await load();
  } else error.value = r.error;
}
async function deleteCred(providerId: string) {
  const r = await cmd("credential/delete", { providerId });
  if (r.ok) await load();
  else error.value = r.error;
}
async function runTest(providerId: string) {
  const config = models.value.find((m) => m.providerId === providerId);
  if (!config) {
    error.value = "NO_MODEL_FOR_PROVIDER";
    return;
  }
  const r = await cmd("model/test", { configId: config.configId });
  tests.value = { ...tests.value, [providerId]: r };
  if (!r.ok && r.error) error.value = r.error;
}
function testLabel(t: any): string {
  if (!t) return "";
  const ok = (v: boolean) => tr(v ? "通过" : "失败");
  return (
    tr("地址") + " " + ok(t.reachable !== false) +
    tr("密钥") + " " + ok(t.credentialAccepted !== false) +
    tr("模型") + " " + ok(!!t.ok) +
    tr("推理") + " " + ok(!!t.inference) +
    tr("已验证能力") + " " + (t.verifiedCapabilities && t.verifiedCapabilities.length ? t.verifiedCapabilities.join("、") : tr("无"))
  );
}
function toggleCap(list: string[], cap: string) {
  return list.includes(cap) ? list.filter((c) => c !== cap) : [...list, cap];
}
function draftCaps(m: any): string[] {
  return capsDraft.value[m.configId] || m.capabilities || [];
}
async function saveCaps(configId: string) {
  const r = await cmd("model/update", { configId, capabilities: capsDraft.value[configId] || [] });
  if (!r.ok) error.value = r.error;
  else {
    notice.value = tr("已保存模型能力");
    const next = { ...capsDraft.value };
    delete next[configId];
    capsDraft.value = next;
    await load();
  }
}
/* 10-16 · 拉取服务商模型清单 → 勾选 → 批量注册 */
const ERR_TEXT: Record<string, string> = {
  AUTH_FAILED: "密钥被服务商拒绝，请检查 API 密钥",
  RATE_LIMITED: "请求过于频繁，稍后再试",
  MODEL_NOT_FOUND: "服务商没有这个接口或模型（404）",
  PROVIDER_UNAVAILABLE: "连不上服务商（网络或服务异常）",
  PROVIDER_PROTOCOL_ERROR: "服务商返回的格式不符合 OpenAI 兼容协议",
  MODEL_TIMEOUT: "请求超时",
  CREDENTIAL_MISSING: "还没保存 API 密钥",
  CREDENTIAL_STORE_UNAVAILABLE: "系统钥匙串不可用",
  ENDPOINT_BLOCKED: "地址被安全策略拒绝：远程站点默认必须 https。该站点若确实使用明文 HTTP，请勾选「允许不安全 HTTP（明文直连）」。明文 HTTP 下地址、凭据与内容可能被中间人读取或篡改",
  PROXY_UNAUTHORIZED: "没有权限（组织级服务商需要超级管理员）",
  INVALID_INPUT: "输入不完整或格式不对",
  MODEL_CONFIG_UNAVAILABLE: "没有可用的模型配置",
  NO_MODEL_FOR_PROVIDER: "这个服务商下还没有注册模型",
};
const errText = (code: string) => (ERR_TEXT[code] ? `${ERR_TEXT[code]}（${code}）` : code);
type Remote = { id: string; ownedBy: string | null; suggestedCapabilities: string[]; registered: boolean };
const pulling = ref<string | null>(null);
const remote = ref<Record<string, Remote[]>>({});
const remoteFilter = ref<Record<string, string>>({});
const picked = ref<Record<string, Record<string, string[]>>>({});
async function pullModels(providerId: string) {
  pulling.value = providerId;
  error.value = null;
  const r = await cmd("provider/models", { providerId });
  pulling.value = null;
  if (!r.ok) {
    error.value = r.error;
    return;
  }
  remote.value = { ...remote.value, [providerId]: r.items };
  picked.value = { ...picked.value, [providerId]: {} };
  notice.value = tr("拉取到 {n} 个模型", { n: r.items.length });
}
/** 拉取结果的能力来自 provider/models 的 suggestedCapabilities（后端 guessCapabilities 推断）；空能力不再默认成 chat。 */
function togglePick(providerId: string, m: { id: string; capabilities?: string[] }) {
  const cur = { ...(picked.value[providerId] || {}) };
  if (cur[m.id]) delete cur[m.id];
  else cur[m.id] = [...(Array.isArray(m.capabilities) ? m.capabilities : classifyRemoteModel({ id: m.id }).capabilities)];
  picked.value = { ...picked.value, [providerId]: cur };
}
function markRegistered(providerId: string, ids: string[]) {
  if (!ids.length) return;
  const set = new Set(ids);
  remote.value = { ...remote.value, [providerId]: (remote.value[providerId] || []).map((m) => (set.has(m.id) ? { ...m, registered: true } : m)) };
}
/** 注册模型后若个人默认还缺 chat / image-generation / video-generation，自动补该能力第一个可用模型。 */
async function autoDefaultAfterRegister(providerId: string) {
  const personal = defaults.value?.personal || {};
  const wanted = ["chat", "image-generation", "video-generation"].filter((cap) => !personal[cap]);
  if (!wanted.length) return;
  const names: string[] = [];
  for (const cap of wanted) {
    const candidate = models.value.find((m: any) => m.providerId === providerId && m.status === "enabled" && Array.isArray(m.capabilities) && m.capabilities.includes(cap));
    if (!candidate) continue;
    const res = await cmd("defaults/set", { capability: cap, configId: candidate.configId, scope: "PERSONAL" });
    if (res.ok) names.push(cap);
  }
  if (!names.length) return;
  notice.value = tr("已自动设置默认模型：{caps}", { caps: names.join(" / ") });
  await load();
}
/** 单个模型「加入」：走 model/create，带上分类推出的真实 capabilities；失败给结构化错误码。 */
async function addOneModel(providerId: string, m: { id: string; capabilities?: string[] }) {
  const capabilities = [...(Array.isArray(m.capabilities) ? m.capabilities : classifyRemoteModel({ id: m.id }).capabilities)];
  const r = await cmd("model/create", { providerId, remoteModelId: m.id, displayName: m.id, capabilities, scope: "PERSONAL" });
  if (!r.ok) {
    error.value = r.error;
    return;
  }
  notice.value = capabilities.length ? tr("已加入 {id}", { id: m.id }) : tr("已加入 {id}（未推断出能力，能力为空）", { id: m.id });
  markRegistered(providerId, [m.id]);
  await load();
  await autoDefaultAfterRegister(providerId);
}
/** 批量「注册所选」：逐条真实落库，部分失败如实报数，不谎报全部成功。 */
async function registerEntries(providerId: string, entries: { id: string; capabilities: string[] }[]) {
  const succeeded: string[] = [];
  let firstError: string | null = null;
  for (const entry of entries) {
    const r = await cmd("model/create", { providerId, remoteModelId: entry.id, displayName: entry.id, capabilities: [...(entry.capabilities || [])], scope: "PERSONAL" });
    if (r.ok) succeeded.push(entry.id);
    else if (!firstError) firstError = r.error;
  }
  if (firstError) error.value = firstError;
  notice.value = succeeded.length === entries.length ? tr("已注册 {n} 个模型", { n: succeeded.length }) : tr("已注册 {ok} / {all} 个模型（其余失败）", { ok: succeeded.length, all: entries.length });
  markRegistered(providerId, succeeded);
  picked.value = { ...picked.value, [providerId]: {} };
  await load();
  await autoDefaultAfterRegister(providerId);
}
function onRemoteFilter(value: string) {
  if (!current.value) return;
  remoteFilter.value = { ...remoteFilter.value, [current.value.providerId]: value };
}
function onTogglePick(m: { id: string; capabilities?: string[] }) {
  if (current.value) togglePick(current.value.providerId, m);
}
function onAddOne(m: { id: string; capabilities?: string[] }) {
  if (current.value) void addOneModel(current.value.providerId, m);
}
function onRegister(entries: { id: string; capabilities: string[] }[]) {
  if (current.value) void registerEntries(current.value.providerId, entries);
}
const CAP_SHORT: Record<string, string> = { chat: "对话", "tool-calling": "工具", "vision-input": "看图", "image-generation": "生图", "video-generation": "视频", embedding: "向量" };

async function createModel() {
  const r = await cmd("model/create", {
    providerId: mForm.providerId,
    remoteModelId: mForm.remoteModelId,
    displayName: mForm.displayName,
    capabilities: mForm.capabilities,
    scope: mForm.scope,
  });
  if (r.ok) {
    notice.value = tr("已注册模型");
    await load();
    await autoDefaultAfterRegister(mForm.providerId);
  } else error.value = r.error;
}
async function setModelStatus(configId: string, status: string) {
  const r = await cmd("model/setStatus", { configId, status });
  if (!r.ok) error.value = r.error;
  await load();
}
async function setDefault(capability: string, configId: string, scope: string) {
  if (!configId) return;
  const r = await cmd("defaults/set", { capability, configId, scope });
  if (!r.ok) error.value = r.error;
  else {
    notice.value = tr("已保存默认模型");
    await load();
  }
}
function onDefault(capability: string, e: Event, scope: string) {
  void setDefault(capability, (e.target as HTMLSelectElement).value, scope);
}
function credLabel(providerId: string): string {
  const c = credStatus.value[providerId];
  if (!c) return tr("读取中…");
  if (c.manageable === false) return "—";
  if (!c.storeAvailable) return tr("系统钥匙串不可用");
  return c.configured ? tr("已保存") : tr("未设置");
}
/** 已配置的默认值不在能力过滤后的清单里时，补一个 disabled 选项把它显示出来。 */
function defaultOptions(cap: string, current: string | null | undefined) {
  const def = current || "";
  const found = def ? models.value.find((m) => m.configId === def) : null;
  const inList = !!found && found.capabilities.includes(cap);
  const out: { value: string; label: string; disabled?: boolean; unavailableFor?: string }[] = [
    { value: "", label: "未设置" },
  ];
  if (def && !inList) {
    out.push({ value: def, label: defaultUnavailableText(cap, found), disabled: true, unavailableFor: cap });
  }
  for (const m of models.value.filter((m) => m.capabilities.includes(cap))) {
    out.push({ value: m.configId, label: m.displayName || m.remoteModelId });
  }
  return out;
}
function onCredDraft(providerId: string, e: Event) {
  credDraft.value = { ...credDraft.value, [providerId]: (e.target as HTMLInputElement).value };
}
function onModelProvider(e: Event) {
  mForm.providerId = (e.target as HTMLSelectElement).value;
}
function onModelRemote(e: Event) {
  mForm.remoteModelId = (e.target as HTMLInputElement).value;
}
function onModelName(e: Event) {
  mForm.displayName = (e.target as HTMLInputElement).value;
}
function onModelScope(e: Event) {
  mForm.scope = (e.target as HTMLSelectElement).value;
}
function toggleCreateCap(cap: string) {
  mForm.capabilities = toggleCap(mForm.capabilities, cap);
}
function toggleModelCap(configId: string, m: any, cap: string) {
  capsDraft.value = { ...capsDraft.value, [configId]: toggleCap(draftCaps(m), cap) };
}
/* ── 10-16 按界面原型：两栏（服务商列表 | 服务商详情）+ 默认模型，取消分区标签 ── */
const selected = ref<string | null>(null); // providerId 或 "new"
const current = computed(() => providers.value.find((p) => p.providerId === selected.value) || null);
const modelsOf = (providerId: string) => models.value.filter((m) => m.providerId === providerId);
const MODEL_GROUPS = [{ cap: "image-generation", label: "图像模型" }, { cap: "chat", label: "对话模型" }, { cap: "video-generation", label: "视频模型" }];
function modelsByCap(providerId: string, cap: string) { return modelsOf(providerId).filter((m: any) => Array.isArray(m.capabilities) && m.capabilities.includes(cap)); }
function groupedModels(providerId: string) { return MODEL_GROUPS.map((g) => ({ ...g, items: modelsByCap(providerId, g.cap) })).filter((g) => g.items.length); }
function imageModels(providerId: string) { return modelsByCap(providerId, "image-generation"); }
function providerState(p: any): { tone: "ok" | "warn" | "off"; label: string } {
  if (p.status !== "enabled") return { tone: "off", label: tr("已停用") };
  const c = credStatus.value[p.providerId];
  if (c && c.configured === false) return { tone: "warn", label: tr("缺少密钥") };
  const t = tests.value[p.providerId];
  if (t && t.ok) return { tone: "ok", label: tr("连接正常") };
  if (t && !t.ok) return { tone: "warn", label: tr("连接失败") };
  return { tone: "ok", label: tr("已启用") };
}
const PALETTE = ["#0A84FF", "#30B0C7", "#34C759", "#FF9F0A", "#FF375F", "#5E5CE6", "#64D2FF", "#8E8E93"];
function logoColor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const mono = (name: string) => {
  const n = String(name || "?").trim();
  return /^[一-鿿]/.test(n) ? n.slice(0, 1) : n.slice(0, 2).toUpperCase();
};
watch(providers, (list) => {
  if (selected.value === "new") return;
  if (!list.length) selected.value = "new";
  else if (!list.some((p) => p.providerId === selected.value)) selected.value = list[0].providerId;
});
const addingModel = ref(false);
function startAddModel(providerId: string) {
  mForm.providerId = providerId;
  mForm.remoteModelId = "";
  mForm.displayName = "";
  mForm.capabilities = ["chat"];
  addingModel.value = true;
}
async function submitModel() {
  await createModel();
  if (!error.value) addingModel.value = false;
}
const editingCaps = ref<string | null>(null);
/* 协议设置 / CLI 区块的展开入口：默认展开，探针不必先点开才看得到。 */
const protocolDialogOpen = ref(false);
const cliDialogOpen = ref(false);

/* ── 模型出网代理（默认关闭；只作用于模型与协议出口，不碰其它出网） ── */
const egress = reactive({ enabled: false, url: "" });
const egressBusy = ref(false);
const egressError = ref<string | null>(null);
const egressNotice = ref<string | null>(null);
const egressStatus = computed(() => egressProxyStatusView({ enabled: egress.enabled, url: egress.url }));

async function loadEgress() {
  const r = await cmd("model/proxy/get");
  const view = normalizeEgressProxyResult(r);
  if (view.problem) { egressError.value = view.problem; return; }
  egress.enabled = view.enabled;
  egress.url = view.url || "";
  egressError.value = null;
}
function onEgressUrl(e: Event) { egress.url = (e.target as HTMLInputElement).value; }
function toggleEgress() {
  egress.enabled = !egress.enabled;
  egressError.value = null;
  egressNotice.value = null;
  if (egress.enabled && !egress.url) egress.url = EGRESS_PROXY_DEFAULT_URL;
}
async function saveEgress() {
  const check = validateEgressProxyDraft({ enabled: egress.enabled, url: egress.url });
  if (!check.ok) { egressError.value = check.message; return; }
  egressBusy.value = true;
  const r = await cmd("model/proxy/set", { enabled: egress.enabled, url: check.url });
  egressBusy.value = false;
  const view = normalizeEgressProxyResult(r);
  if (view.problem) { egressError.value = view.problem; return; }
  egress.enabled = view.enabled;
  egress.url = view.url || "";
  egressError.value = null;
  egressNotice.value = tr(view.enabled ? "已保存：模型与协议请求将经代理转发" : "已保存：模型与协议请求直连");
}
onMounted(() => { void loadEgress(); });
</script>

<template>
  <div class="d401-settings mp2" data-d4-01="settings">
    <p class="settings-lead">{{ tr("统一管理服务商、地址、密钥与模型。所有接入 OpenArc 的应用通过后台调用，不需要逐个填写；密钥只写入系统钥匙串，不会再显示。") }}</p>
    <p v-if="error" class="d401-error" role="alert" data-d4-01-error :data-d4-01-error-code="error">{{ errText(error) }}</p>
    <p v-if="notice" class="d401-notice" role="status" data-d4-01-notice>{{ notice }}</p>

    <!-- 模型出网代理：一行紧凑设置（默认关闭；只作用于模型与协议出口） -->
    <!-- 页面：只保留服务商列表 + 添加自定义服务商；详情/默认/代理/协议/CLI 都走弹窗 -->
    <div class="mp2-provider-toolbar">
      <DsButton variant="ghost" size="sm" data-model-open-defaults @click="defaultsDialogOpen = true">{{ tr("默认模型") }}</DsButton>
      <DsButton variant="ghost" size="sm" data-model-open-egress @click="egressDialogOpen = true">{{ tr("出网代理") }}</DsButton>
      <DsButton variant="ghost" size="sm" data-model-settings-protocol-toggle @click="protocolDialogOpen = true">{{ tr("协议设置") }}</DsButton>
      <DsButton variant="ghost" size="sm" data-model-settings-cli-toggle @click="cliDialogOpen = true">CLI</DsButton>
    </div>
    <div class="mp2-provider-list" data-d4-01-pane="providers" data-d4-01-providers>
      <button v-for="p in providers" :key="p.providerId" type="button" class="mp2-provider-card" :data-d4-01-provider="p.providerId" @click="openProviderView(p.providerId)">
        <span class="mp2-logo" :class="{ 'mp2-logo-brand': providerLogo(p) }" :style="providerLogo(p) ? { color: 'var(--text)' } : { background: logoColor(p.providerId) }" aria-hidden="true">
          <span v-if="providerLogo(p)?.render === 'mask'" class="mp2-logo-mark" :style="{ maskImage: 'url(' + providerLogo(p)!.url + ')', WebkitMaskImage: 'url(' + providerLogo(p)!.url + ')' }" />
          <img v-else-if="providerLogo(p)" :src="providerLogo(p)!.url" :alt="providerLogo(p)!.label" />
          <template v-else>{{ mono(p.displayName) }}</template>
        </span>
        <span class="mp2-provider-card-main"><b>{{ p.displayName }}</b><small>{{ tr("{n} 个模型", { n: modelsOf(p.providerId).length }) }} · {{ tr(providerState(p).label) }}</small></span>
        <span class="mp2-dot" :data-tone="providerState(p).tone" />
      </button>
      <button type="button" class="mp2-provider-card mp2-provider-add" data-d4-01-provider-add @click="openProviderCreate">
        <span class="mp2-logo mp2-logo-add" aria-hidden="true">＋</span>
        <span class="mp2-provider-card-main"><b>{{ tr("添加自定义服务商") }}</b><small>{{ tr("地址 + 密钥 + 模型，兼容 OpenAI 的服务都可以") }}</small></span>
      </button>
    </div>
    <p v-if="!providers.length" class="set-cap" data-d4-01-providers-empty>{{ tr("还没有服务商。点击「添加自定义服务商」填写地址与密钥，常见的 OpenAI 兼容服务都可以。") }}</p>

    <DsDialog class="mp2-pdialog" :open="providerViewOpen" :title="current?.displayName || tr('服务商')" @close="providerViewOpen = false">
            <!-- 右：服务商详情 -->
      <div v-if="current" class="set-group mp2-detail mp2-dialog-detail" :key="current.providerId" :data-d4-01-provider-detail="current.providerId">
        <div class="mp2-head">
          <span
            class="mp2-logo"
            :class="{ 'mp2-logo-brand': providerLogo(current) }"
            :data-provider-logo="providerLogo(current)?.key ?? ''"
            :data-provider-logo-kind="providerLogo(current) ? 'brand' : 'initial'"
            :data-provider-logo-render="providerLogo(current)?.render ?? 'initial'"
            :data-provider-logo-theme="logoTheme"
            :style="providerLogo(current) ? { color: 'var(--text)' } : { background: logoColor(current.providerId) }"
            aria-hidden="true"
          >
            <span
              v-if="providerLogo(current)?.render === 'mask'"
              class="mp2-logo-mark"
              :style="{ maskImage: 'url(' + providerLogo(current)!.url + ')', WebkitMaskImage: 'url(' + providerLogo(current)!.url + ')' }"
            />
            <img v-else-if="providerLogo(current)" :src="providerLogo(current)!.url" :alt="providerLogo(current)!.label" />
            <template v-else>{{ mono(current.displayName) }}</template>
          </span>
          <b class="mp2-title">{{ current.displayName }}</b>
          <span class="badge" :class="{ ok: providerState(current).tone === 'ok', warn: providerState(current).tone === 'warn' }" data-d4-01-provider-status>{{ tr(providerState(current).label) }}</span>
          <span v-if="current.allowInsecureHttp" class="badge warn" data-d4-01-provider-insecure-badge :title="tr('该站点使用明文 HTTP，凭据与内容可能被中间人读取')" :aria-label="tr('不安全 HTTP：该站点使用明文 HTTP，凭据与内容可能被中间人读取')">{{ tr("不安全 HTTP") }}</span>
        </div>
        <h4 class="mp2-card-title">{{ tr("平台信息") }}</h4>
        <div class="mp2-field"><span>{{ tr("API 地址") }}</span>
          <div class="mp2-static mono">{{ current.baseUrl }}<small> · {{ current.scope === "ORGANIZATION" ? tr("组织") : tr("个人") }} · {{ current.adapterType }}</small></div>
        </div>
        <h4 class="mp2-card-title">{{ tr("API Key") }}</h4>
        <div class="mp2-field"><span>{{ tr("API 密钥") }} <small :data-d4-01-cred-status="current.providerId">{{ credLabel(current.providerId) }}</small></span>
          <div class="mp2-row">
            <input
              class="set-input"
              :data-d4-01-cred-input="current.providerId"
              :aria-label="'API 密钥：' + current.displayName"
              type="password"
              :placeholder="credStatus[current.providerId]?.configured ? tr('已保存（只写入，不再显示）· 粘贴新密钥可替换') : tr('粘贴密钥')"
              :value="credDraft[current.providerId] || ''"
              @input="onCredDraft(current.providerId, $event)"
            />
            <DsButton variant="secondary" size="sm" :data-d4-01-cred-set="current.providerId" :disabled="!credDraft[current.providerId]" @click="saveCred(current.providerId, !!credStatus[current.providerId]?.configured)">{{ tr("保存") }}</DsButton>
            <DsButton v-if="credStatus[current.providerId]?.configured" variant="ghost" size="sm" :data-d4-01-cred-delete="current.providerId" @click="deleteCred(current.providerId)">{{ tr("删除") }}</DsButton>
          </div>
        </div>
        <h4 class="mp2-card-title">{{ tr("连接状态") }}</h4>
        <div class="mp2-row">
          <DsButton variant="secondary" size="sm" :data-d4-01-test="current.providerId" @click="runTest(current.providerId)">{{ tr("测试连接") }}</DsButton>
          <span v-if="tests[current.providerId]" class="badge" :class="{ ok: tests[current.providerId].ok }" :data-d4-01-test-result="current.providerId">{{ tests[current.providerId].ok ? tr("连接成功") : tr("连接失败") }}</span>
          <small v-if="tests[current.providerId]" class="set-cap">{{ testLabel(tests[current.providerId]) }}</small>
          <span class="toolbar-spacer" />
          <DsButton variant="secondary" size="sm" :data-d4-01-provider-edit="current.providerId" @click="openProviderEdit(current.providerId)">{{ tr("编辑服务商") }}</DsButton>
          <DsButton v-if="current.status === 'enabled'" variant="ghost" size="sm" :data-d4-01-provider-disable="current.providerId" @click="setProviderStatus(current.providerId, 'disabled')">{{ tr("停用") }}</DsButton>
          <DsButton v-else variant="secondary" size="sm" :data-d4-01-provider-enable="current.providerId" @click="setProviderStatus(current.providerId, 'enabled')">{{ tr("启用") }}</DsButton>
        </div>

        <h4 class="mp2-card-title">{{ tr("协议") }}</h4>
        <div class="mp2-row mp2-protocol-row" data-model-provider-protocol>
          <span class="mono">{{ current.adapterType }}</span>
          <small class="set-cap">{{ tr("协议可用性与校验在「协议设置」中查看") }}</small>
          <div class="toolbar-spacer" />
          <DsButton variant="ghost" size="sm" @click="protocolDialogOpen = true">{{ tr("打开协议设置") }}</DsButton>
        </div>

        <template v-if="imageModels(current.providerId).length">
          <h4 class="mp2-card-title">{{ tr("图片接口") }}</h4>
          <div class="mp2-field" data-d4-01-image-api>
            <div class="mp2-static mono">{{ current.baseUrl }}<small> · {{ current.adapterType }}</small></div>
            <div class="mp2-row">
              <span v-for="m in imageModels(current.providerId)" :key="m.configId" class="badge">{{ m.displayName || m.remoteModelId }}</span>
            </div>
          </div>
        </template>

        <h4 class="mp2-card-title">{{ tr("模型列表") }}</h4>
        <div class="mp2-field" data-d4-01-pane="models"><span>{{ tr("模型与能力") }}</span>
          <div v-for="group in groupedModels(current.providerId)" :key="group.cap" class="mp2-model-group" :data-model-group="group.cap">
            <h5 class="mp2-model-group-title">{{ tr(group.label) }} <small>{{ group.items.length }}</small></h5>
            <ul class="mp2-models">
              <li v-for="m in group.items" :key="m.configId" :data-d4-01-model="m.configId" :class="{ off: m.status !== 'enabled' }">
                <div class="mp2-model-row">
                  <span class="mono mp2-model-id" :title="m.remoteModelId">{{ m.displayName || m.remoteModelId }}</span>
                  <span v-for="c in m.capabilities" :key="c" class="badge" :class="{ ok: m.verifiedCapabilities.includes(c) }" :title="m.verifiedCapabilities.includes(c) ? tr('已验证') : tr('已声明，未验证')">{{ CAP_SHORT[c] ? tr(CAP_SHORT[c]) : c }}</span>
                  <button class="mp2-link" @click="editingCaps = editingCaps === m.configId ? null : m.configId">{{ tr("编辑") }}</button>
                  <button v-if="m.status === 'enabled'" class="mp2-link" :data-d4-01-model-disable="m.configId" @click="setModelStatus(m.configId, 'disabled')">{{ tr("停用") }}</button>
                  <button v-else class="mp2-link" :data-d4-01-model-enable="m.configId" @click="setModelStatus(m.configId, 'enabled')">{{ tr("启用") }}</button>
                </div>
                <div v-if="editingCaps === m.configId" class="mp2-caps-edit">
                  <label v-for="c in CAPABILITY_CHOICES" :key="c.id">
                    <input type="checkbox" :data-d4-01-model-cap="m.configId" :data-d4-01-model-cap-id="c.id" :checked="draftCaps(m).includes(c.id)" @change="toggleModelCap(m.configId, m, c.id)" />
                    {{ tr(c.label) }}
                  </label>
                  <DsButton variant="secondary" size="sm" :data-d4-01-model-cap-save="m.configId" @click="saveCaps(m.configId); editingCaps = null">{{ tr("保存") }}</DsButton>
                </div>
              </li>
            </ul>
          </div>
          <p v-if="!modelsOf(current.providerId).length" class="set-cap" data-d4-01-models-empty>{{ tr("还没有模型。可以从服务商拉取，或手动添加。") }}</p>
          <div class="mp2-row">
            <DsButton variant="secondary" size="sm" :data-d4-01-pull="current.providerId" :disabled="pulling === current.providerId" @click="pullModels(current.providerId)">
              {{ pulling === current.providerId ? tr("拉取中…") : remote[current.providerId] ? tr("重新拉取") : tr("拉取模型") }}
            </DsButton>
            <DsButton variant="ghost" size="sm" data-d4-01-model-add @click="startAddModel(current.providerId)">{{ tr("添加自定义模型") }}</DsButton>
          </div>
        </div>

        <div v-if="addingModel && mForm.providerId === current.providerId" class="mp2-sub" data-d4-01-model-form>
          <label class="mp2-field"><span>{{ tr("模型 ID") }} <small>{{ tr("服务商那边的模型名") }}</small></span>
            <input class="set-input mono" data-d4-01-model-remote :aria-label="tr('模型 ID')" :placeholder="tr('例如 deepseek-chat')" :value="mForm.remoteModelId" @input="onModelRemote" />
          </label>
          <label class="mp2-field"><span>{{ tr("显示名称") }} <small>{{ tr("可选") }}</small></span>
            <input class="set-input" data-d4-01-model-name :aria-label="tr('显示名称')" :value="mForm.displayName" @input="onModelName" />
          </label>
          <div class="mp2-field"><span>{{ tr("能力") }}</span>
            <div class="mp2-caps-edit" data-d4-01-model-create-caps>
              <label v-for="c in CAPABILITY_CHOICES" :key="c.id">
                <input type="checkbox" :data-d4-01-model-create-cap="c.id" :checked="mForm.capabilities.includes(c.id)" @change="toggleCreateCap(c.id)" />
                {{ tr(c.label) }}
              </label>
            </div>
          </div>
          <div class="mp2-actions">
            <DsButton variant="ghost" size="sm" @click="addingModel = false">{{ tr("取消") }}</DsButton>
            <DsButton variant="primary" size="sm" data-d4-01-model-create :disabled="!mForm.remoteModelId.trim()" @click="submitModel">{{ tr("添加模型") }}</DsButton>
          </div>
        </div>

        <RemoteModelsPanel
          v-if="remote[current.providerId]"
          class="mp2-sub"
          :provider-id="current.providerId"
          :items="remote[current.providerId]"
          :picked="picked[current.providerId] || {}"
          :pulling="pulling === current.providerId"
          :filter="remoteFilter[current.providerId] || ''"
          @update:filter="onRemoteFilter"
          @toggle-pick="onTogglePick"
          @add-one="onAddOne"
          @register="onRegister"
        />
      </div>
    </DsDialog>

    <DsDialog class="mp2-form-dialog" :open="egressDialogOpen" :title="tr('模型出网代理')" @close="egressDialogOpen = false">
          <div class="set-group mp2-egress" data-model-egress>
      <div class="setting-row">
        <span class="set-lab">{{ tr("模型出网代理") }}<small>{{ tr("仅用于模型与协议请求；默认关闭") }}</small></span>
        <button
          type="button"
          role="switch"
          class="switch"
          data-model-egress-switch
          :aria-checked="egress.enabled"
          :aria-label="tr('模型出网代理')"
          :disabled="egressBusy"
          @click="toggleEgress"
        />
        <input
          class="set-input mono"
          data-model-egress-url
          type="text"
          inputmode="url"
          spellcheck="false"
          placeholder="http://127.0.0.1:7897"
          :aria-label="tr('模型出网代理地址')"
          :disabled="!egress.enabled || egressBusy"
          :value="egress.url"
          @input="onEgressUrl"
        />
        <DsButton variant="secondary" size="sm" data-model-egress-save :disabled="egressBusy || !egress.enabled" @click="saveEgress">{{ tr("保存") }}</DsButton>
        <DsBadge :tone="egressStatus.tone" data-model-egress-status>{{ tr(egressStatus.label) }}</DsBadge>
      </div>
      <p v-if="egressNotice" class="set-cap" data-model-egress-hint>{{ tr(egressNotice) }}</p>
      <p v-if="egressError" class="d401-error" role="alert" data-model-egress-error>{{ tr(egressError) }}</p>
    </div>


    </DsDialog>

    <DsDialog class="mp2-form-dialog" :open="defaultsDialogOpen" :title="tr('默认模型')" @close="defaultsDialogOpen = false">
          <!-- 默认模型 -->
    <template v-if="defaults">
      <div class="set-sec" data-d4-01-pane="defaults">
        <h3>{{ tr("默认模型") }}</h3>
        <p v-if="defaults && !defaults.personal?.chat" class="set-cap" data-d4-01-default-missing>{{ tr("还没有默认对话模型：应用调用模型会失败。注册模型后会自动选择第一个可用的对话模型，也可以在下面手动指定。") }}</p>
        <div class="set-group d401-defaults" data-d4-01-defaults-personal>
          <label v-for="d in [['chat', '文本对话', 'chat'], ['tool-calling', '工具调用', 'tool'], ['image-generation', '图像生成', 'image'], ['video-generation', '视频生成', 'video'], ['video-generation', '视频生成', 'video']]" :key="d[0]" class="setting-row">
            <span class="set-lab">{{ tr(d[1]) }}</span>
            <select class="set-select"  v-bind="{ ['data-d4-01-default-personal-' + d[2]]: '' }" :value="defaults.personal[d[0]] || ''" @change="onDefault(d[0], $event, 'PERSONAL')">
              <option v-for="o in defaultOptions(d[0], defaults.personal[d[0]])" :key="o.value + (o.disabled ? ':x' : '')" :value="o.value" :disabled="o.disabled" :data-d4-01-default-unavailable="o.unavailableFor">
                {{ o.value ? o.label : tr("自动") }}
              </option>
            </select>
          </label>
        </div>
        <p class="set-cap">{{ tr("「自动」表示使用当前服务商下已配置、且能力匹配的模型。所有应用（AI Studio、对话、Skill、短剧工坊……）都用这里的设置。") }}</p>
      </div>
      <div class="set-sec">
        <h3>{{ tr("组织默认模型") }} <small v-if="!defaults.canManageOrganization" class="muted">{{ tr("（只读）") }}</small></h3>
        <div class="set-group d401-defaults" data-d4-01-defaults-organization>
          <label v-for="d in [['chat', '文本对话', 'chat'], ['tool-calling', '工具调用', 'tool'], ['image-generation', '图像生成', 'image']]" :key="d[0]" class="setting-row">
            <span class="set-lab">{{ tr(d[1]) }}</span>
            <select class="set-select"  v-bind="{ ['data-d4-01-default-org-' + d[2]]: '' }" :disabled="!defaults.canManageOrganization" :value="defaults.organization[d[0]] || ''" @change="onDefault(d[0], $event, 'ORGANIZATION')">
              <option v-for="o in defaultOptions(d[0], defaults.organization[d[0]])" :key="o.value + (o.disabled ? ':x' : '')" :value="o.value" :disabled="o.disabled" :data-d4-01-default-unavailable="o.unavailableFor">
                {{ o.value ? o.label : tr("未设置") }}
              </option>
            </select>
          </label>
        </div>
        <p v-if="role !== 'ADMIN'" class="set-cap" data-d4-01-org-hint>{{ tr("组织默认模型需要管理员修改。成员没有设置个人默认时，使用组织默认。") }}</p>
        <p class="set-cap">{{ tr("协议（各家服务的调用方式与可用状态）可在「协议中心」查看，也可在下面的「协议设置」里校验与保存。") }}</p>
      </div>
    </template>


    </DsDialog>
    <DsDialog class="mp2-form-dialog" :open="providerDialogOpen" :title="providerDialogMode === 'create' ? tr('添加服务商') : tr('编辑服务商')" @close="closeProviderDialog">
      <ProviderForm
        :key="providerDialogMode + ':' + (editingProviderId || 'new') + ':' + providerDialogSeq"
        ref="providerFormRef"
        :mode="providerDialogMode"
        :busy="busy"
        :known-protocols="knownProtocols"
        :initial="providerDialogMode === 'edit' && current ? {
          providerId: current.providerId,
          displayName: current.displayName,
          baseUrl: current.baseUrl,
          endpointScope: current.endpointScope,
          scope: current.scope,
          status: current.status,
          allowInsecureHttp: current.allowInsecureHttp,
          adapterType: current.adapterType,
          credentialConfigured: !!credStatus[current.providerId]?.configured,
        } : undefined"
        @submit="onProviderSubmit"
        @invalid="onProviderInvalid"
        @cancel="closeProviderDialog"
      />
    </DsDialog>

    <DsDialog class="mp2-wide-dialog" :open="protocolDialogOpen" :title="tr('协议设置')" @close="protocolDialogOpen = false">
      <div data-model-settings-protocol-container><ProtocolSettingsPanel /></div>
      <template #footer><button class="primary" type="button" @click="protocolDialogOpen = false">{{ tr("关闭") }}</button></template>
    </DsDialog>

    <DsDialog class="mp2-wide-dialog" :open="cliDialogOpen" :title="tr('CLI 设置')" @close="cliDialogOpen = false">
      <div data-model-settings-cli-container><CliPanel /></div>
      <template #footer><button class="primary" type="button" @click="cliDialogOpen = false">{{ tr("关闭") }}</button></template>
    </DsDialog>
  </div>
</template>

<style scoped>
.mp2-block-head { display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 0 0 6px; background: transparent; color: var(--text); border-bottom: 1px solid var(--line); text-align: left; }
.mp2-block-head b { font-size: var(--fs-secondary); font-weight: var(--fw-medium); }
.mp2-block-head small { color: var(--muted); font-size: var(--fs-micro); }
.mp2-logo-brand { background: transparent; width: auto; min-width: 30px; max-width: 96px; padding: 0 3px; color: var(--text); }
.mp2-logo-mark { width: 18px; height: 18px; background-color: currentColor; -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat; -webkit-mask-position: center; mask-position: center; -webkit-mask-size: contain; mask-size: contain; }
.mp2-logo img { display: block; max-width: 90px; max-height: 20px; object-fit: contain; }

/* task-60：服务商列表页 */
.mp2-provider-toolbar { display: flex; align-items: center; gap: var(--space-1); flex-wrap: wrap; margin: 4px 0 10px; }
.mp2-provider-list { display: flex; flex-direction: column; gap: 8px; margin: 6px 0 10px; }
.mp2-provider-card { display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.035); color: var(--text); text-align: left; cursor: pointer; }
.mp2-provider-card:hover { background: rgb(var(--text-rgb) / 0.06); }
.mp2-provider-card-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mp2-provider-card-main b { font-size: var(--fs-secondary); font-weight: var(--fw-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mp2-provider-card-main small { font-size: var(--fs-micro); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mp2-provider-add { border-style: dashed; background: transparent; }
.mp2-provider-add .mp2-logo { background: var(--sunken); color: var(--text); }

/* task-60：供应商弹窗卡片分区 */
.mp2-pdialog :deep(.dialog) { width: min(760px, calc(100% - 64px)); max-height: calc(100% - 64px); display: flex; flex-direction: column; }
.mp2-pdialog :deep(.dialog-body) { overflow: auto; min-height: 0; }
.mp2-dialog-detail { gap: 10px; }
.mp2-dialog-detail .mp2-card-title { margin: 8px 0 0; font-size: var(--fs-caption); font-weight: var(--fw-medium); color: var(--muted); }
.mp2-dialog-detail > .mp2-field, .mp2-dialog-detail > .mp2-row, .mp2-dialog-detail > .mp2-sub, .mp2-dialog-detail > .mp2-model-group { padding: 10px 12px; border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.035); }
.mp2-dialog-detail > .mp2-head + .mp2-card-title { margin-top: 2px; }
.mp2-model-group-title { margin: 4px 0 2px; font-size: var(--fs-caption); font-weight: var(--fw-medium); }
.mp2-model-group-title small { color: var(--muted); font-weight: var(--fw-regular); }
.mp2-protocol-row { gap: 8px; }

/* task-56：设置弹窗尺寸与内部滚动 */
.mp2-form-dialog :deep(.dialog) { width: min(560px, calc(100% - 64px)); max-height: calc(100% - 64px); display: flex; flex-direction: column; }
.mp2-form-dialog :deep(.dialog-body) { overflow: auto; min-height: 0; }
.mp2-wide-dialog :deep(.dialog) { width: min(880px, calc(100% - 64px)); max-height: calc(100% - 64px); display: flex; flex-direction: column; }
.mp2-wide-dialog :deep(.dialog-body) { overflow: auto; min-height: 0; }

/* task-47：模型页重排 —— 两栏紧凑、左栏不空荡、窄窗单栏；字阶/间距统一到设置页 token。 */
.d401-settings { padding-bottom: var(--space-3); }
.mp2-egress { padding: 8px 12px; gap: 6px; }
.mp2-egress .setting-row { gap: var(--space-2); }
.mp2-grid { grid-template-columns: 232px minmax(0, 1fr); gap: 16px; align-items: start; }
.mp2-provs { position: sticky; top: 8px; align-self: start; max-height: calc(100vh - 280px); overflow: auto; padding: 8px; gap: 2px; }
.mp2-prov { padding: 7px 8px; }
.mp2-prov-main b { font-size: var(--fs-caption); }
.mp2-detail { padding: 14px 16px; gap: 12px; }
.mp2-detail .mp2-field { gap: 5px; }
.mp2-detail .set-cap { margin: 0; }
.mp2-head { min-height: 28px; }
@media (max-width: 880px) {
  .mp2-grid { grid-template-columns: 1fr; }
  .mp2-provs { position: static; max-height: none; flex-direction: row; flex-wrap: wrap; overflow: visible; }
  .mp2-prov { width: auto; flex: 1 1 180px; }
  .mp2-detail { padding: 12px; }
}
</style>
