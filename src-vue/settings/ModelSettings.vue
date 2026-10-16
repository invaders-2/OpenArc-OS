<script setup lang="ts">
import ModelProtocols from "./ModelProtocols.vue";
import { computed, onMounted, reactive, ref } from "vue";
import DsButton from "../design-system/DsButton.vue";

/**
 * D4-01 Closure C · Settings → Models / AI（对齐 src/settings/ModelSettings.tsx）。
 * 只经 window.openarc.model.command；credential write-only。
 * 所有 data-d4-01-* 契约逐项保留（tabs / panes / provider-* / model-* / defaults-*）。
 */
type Tab = "providers" | "models" | "defaults" | "protocols";

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
  const name = m ? String(m.displayName || m.remoteModelId || m.configId) : "（该模型已不在清单里）";
  return name + "（已配置为默认" + (m ? "，但没有「" + (CAPABILITY_LABEL[cap] || cap) + "」能力" : "") + "，不可用）";
}

const bridge = () => (window as any).openarc?.model;

const tab = ref<Tab>("providers");
const providers = ref<any[]>([]);
const models = ref<any[]>([]);
const defaults = ref<any>(null);
const credStatus = ref<Record<string, any>>({});
const tests = ref<Record<string, any>>({});
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);
const pForm = reactive({ displayName: "", baseUrl: "", endpointScope: "LOCALHOST", scope: "PERSONAL", credentialSecret: "" });
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
onMounted(() => {
  void load();
});

async function createProvider() {
  const payload: Record<string, unknown> = {
    displayName: pForm.displayName,
    baseUrl: pForm.baseUrl,
    endpointScope: pForm.endpointScope,
    scope: pForm.scope,
  };
  if (pForm.credentialSecret) payload.credentialSecret = pForm.credentialSecret;
  const res = await cmd("provider/create", payload);
  if (res.ok) {
    notice.value = "已添加服务商";
    pForm.displayName = "";
    pForm.baseUrl = "";
    pForm.endpointScope = "LOCALHOST";
    pForm.scope = "PERSONAL";
    pForm.credentialSecret = "";
    await load();
  } else error.value = res.error;
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
  const ok = (v: boolean) => (v ? "通过" : "失败");
  return (
    "地址 " + ok(t.reachable !== false) +
    " · 密钥 " + ok(t.credentialAccepted !== false) +
    " · 模型 " + ok(!!t.ok) +
    " · 推理 " + ok(!!t.inference) +
    " · 已验证能力 " + (t.verifiedCapabilities && t.verifiedCapabilities.length ? t.verifiedCapabilities.join("、") : "无")
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
    notice.value = "已保存模型能力";
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
  ENDPOINT_BLOCKED: "地址被安全策略拒绝（需 https，且密钥只发往登记时的地址）",
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
  notice.value = `拉取到 ${r.items.length} 个模型`;
}
function remoteList(providerId: string) {
  const q = (remoteFilter.value[providerId] || "").trim().toLowerCase();
  return (remote.value[providerId] || []).filter((m) => !q || m.id.toLowerCase().includes(q));
}
function togglePick(providerId: string, m: Remote) {
  const cur = { ...(picked.value[providerId] || {}) };
  if (cur[m.id]) delete cur[m.id];
  else cur[m.id] = m.suggestedCapabilities.length ? [...m.suggestedCapabilities] : ["chat"];
  picked.value = { ...picked.value, [providerId]: cur };
}
const pickedCount = (providerId: string) => Object.keys(picked.value[providerId] || {}).length;
async function registerPicked(providerId: string) {
  const entries = Object.entries(picked.value[providerId] || {});
  let okN = 0;
  for (const [id, caps] of entries) {
    const r = await cmd("model/create", { providerId, remoteModelId: id, displayName: id, capabilities: caps, scope: "PERSONAL" });
    if (r.ok) okN += 1;
    else error.value = r.error;
  }
  notice.value = `已注册 ${okN} 个模型`;
  remote.value = { ...remote.value, [providerId]: (remote.value[providerId] || []).map((m) => (picked.value[providerId]?.[m.id] ? { ...m, registered: true } : m)) };
  picked.value = { ...picked.value, [providerId]: {} };
  await load();
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
    notice.value = "已注册模型";
    await load();
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
    notice.value = "已保存默认模型";
    await load();
  }
}
function onDefault(capability: string, e: Event, scope: string) {
  void setDefault(capability, (e.target as HTMLSelectElement).value, scope);
}
function credLabel(providerId: string): string {
  const c = credStatus.value[providerId];
  if (!c) return "读取中…";
  if (c.manageable === false) return "—";
  if (!c.storeAvailable) return "系统钥匙串不可用";
  return c.configured ? "已保存" : "未设置";
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
function onProviderName(e: Event) {
  pForm.displayName = (e.target as HTMLInputElement).value;
}
function onProviderUrl(e: Event) {
  pForm.baseUrl = (e.target as HTMLInputElement).value;
}
function onProviderScope(e: Event) {
  pForm.scope = (e.target as HTMLSelectElement).value;
}
function onProviderSecret(e: Event) {
  pForm.credentialSecret = (e.target as HTMLInputElement).value;
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
const TABS: { id: Tab; label: string }[] = [
  { id: "providers", label: "服务商" },
  { id: "models", label: "模型" },
  { id: "defaults", label: "默认模型" },
  { id: "protocols", label: "协议" },
];
const providerOptions = computed(() => providers.value);
</script>

<template>
  <div class="d401-settings" data-d4-01="settings">
    <p class="settings-lead">统一管理服务商、地址、密钥与模型。所有接入 OpenArc 的应用通过后台调用，不需要逐个填写；密钥只写入系统钥匙串，不会再显示。</p>
    <nav class="segmented text d401-tabs" role="tablist" aria-label="模型设置分区">
      <button
        v-for="t in TABS"
        :key="t.id"
        type="button"
        role="tab"
        :aria-selected="tab === t.id"
        :aria-pressed="tab === t.id"
        :data-d4-01-tab="t.id"
        @click="tab = t.id"
      >
        {{ t.label }}
      </button>
    </nav>
    <p v-if="error" class="d401-error" role="alert" data-d4-01-error :data-d4-01-error-code="error">{{ errText(error) }}</p>
    <p v-if="notice" class="d401-notice" role="status" data-d4-01-notice>{{ notice }}</p>
    <p v-if="busy" class="muted" data-d4-01-busy>正在处理…</p>

    <section v-if="tab === 'providers'" data-d4-01-pane="providers">
      <div class="set-sec">
        <h3>已添加的服务商</h3>
        <p v-if="providers.length === 0" class="set-cap set-empty" data-d4-01-providers-empty>还没有服务商。在下方添加一个，填写地址与密钥。</p>
        <ul class="d401-list" data-d4-01-providers>
          <li v-for="p in providers" :key="p.providerId" :data-d4-01-provider="p.providerId" class="set-group d401-card">
            <div class="setting-row">
              <span class="d401-logo" aria-hidden="true">{{ (p.displayName || "?").slice(0, 2).toUpperCase() }}</span>
              <span class="set-lab">
                <span class="d401-name">{{ p.displayName }}</span>
                <small class="d401-meta">{{ p.adapterType }} · {{ p.baseUrl }} · {{ p.scope === "ORGANIZATION" ? "组织" : "个人" }}</small>
              </span>
              <span class="badge" :class="{ ok: p.status === 'enabled' }" data-d4-01-provider-status>{{ p.status === "enabled" ? "已启用" : "已停用" }}</span>
            </div>
            <div class="setting-row">
              <span class="set-lab">API 密钥<small :data-d4-01-cred-status="p.providerId">{{ credLabel(p.providerId) }}</small></span>
              <input
                class="set-input"
                :data-d4-01-cred-input="p.providerId"
                :aria-label="'API key for ' + p.displayName"
                type="password"
                placeholder="粘贴密钥（只写入，不再显示）"
                :value="credDraft[p.providerId] || ''"
                @input="onCredDraft(p.providerId, $event)"
              />
              <DsButton variant="secondary" size="sm" :data-d4-01-cred-set="p.providerId" @click="saveCred(p.providerId, false)">保存</DsButton>
              <DsButton variant="secondary" size="sm" :data-d4-01-cred-replace="p.providerId" @click="saveCred(p.providerId, true)">替换</DsButton>
              <DsButton variant="ghost" size="sm" :data-d4-01-cred-delete="p.providerId" @click="deleteCred(p.providerId)">删除</DsButton>
            </div>
            <div class="setting-row">
              <span class="set-lab">
                连接
                <small v-if="tests[p.providerId]" class="d401-test" :data-d4-01-test-result="p.providerId">{{ testLabel(tests[p.providerId]) }}</small>
              </span>
              <DsButton variant="secondary" size="sm" :data-d4-01-test="p.providerId" @click="runTest(p.providerId)">测试连接</DsButton>
              <DsButton
                v-if="p.status === 'enabled'"
                variant="ghost"
                size="sm"
                :data-d4-01-provider-disable="p.providerId"
                @click="setProviderStatus(p.providerId, 'disabled')"
              >停用</DsButton>
              <DsButton
                v-else
                variant="secondary"
                size="sm"
                :data-d4-01-provider-enable="p.providerId"
                @click="setProviderStatus(p.providerId, 'enabled')"
              >启用</DsButton>
            </div>
            <div class="setting-row">
              <span class="set-lab">
                模型
                <small>从服务商拉取可用模型（OpenAI 兼容 /models），勾选后注册</small>
              </span>
              <DsButton variant="secondary" size="sm" :data-d4-01-pull="p.providerId" :disabled="pulling === p.providerId" @click="pullModels(p.providerId)">
                {{ pulling === p.providerId ? "拉取中…" : remote[p.providerId] ? "重新拉取" : "拉取模型" }}
              </DsButton>
            </div>
            <div v-if="remote[p.providerId]" class="set-block d401-remote" :data-d4-01-remote="p.providerId">
              <div class="d401-remote-head">
                <label class="ds-search d401-remote-search">
                  <input
                    class="ds-search__input"
                    type="search"
                    placeholder="筛选模型"
                    aria-label="筛选模型"
                    :value="remoteFilter[p.providerId] || ''"
                    @input="remoteFilter = { ...remoteFilter, [p.providerId]: ($event.target as HTMLInputElement).value }"
                  />
                </label>
                <span class="set-val">{{ remoteList(p.providerId).length }} / {{ remote[p.providerId].length }}</span>
                <DsButton variant="primary" size="sm" :disabled="!pickedCount(p.providerId)" @click="registerPicked(p.providerId)">
                  注册所选{{ pickedCount(p.providerId) ? `（${pickedCount(p.providerId)}）` : "" }}
                </DsButton>
              </div>
              <ul class="d401-remote-list">
                <li v-for="m in remoteList(p.providerId)" :key="m.id">
                  <label :class="{ done: m.registered }">
                    <input type="checkbox" :disabled="m.registered" :checked="m.registered || !!picked[p.providerId]?.[m.id]" @change="togglePick(p.providerId, m)" />
                    <span class="mono d401-remote-id">{{ m.id }}</span>
                    <span v-if="m.registered" class="badge">已注册</span>
                    <span v-else class="d401-remote-caps">{{ (m.suggestedCapabilities.length ? m.suggestedCapabilities : ['chat']).map((c) => CAP_SHORT[c] || c).join(" · ") }}</span>
                  </label>
                </li>
                <li v-if="!remoteList(p.providerId).length" class="set-cap">没有匹配的模型</li>
              </ul>
              <p class="set-cap">能力按模型名推断，注册后可在「模型」里修改；「测试连接」通过后才算已验证。</p>
            </div>
          </li>
        </ul>
      </div>
      <div class="set-sec">
        <h3>添加服务商</h3>
        <div class="set-group d401-form">
          <label class="setting-row">
            <span class="set-lab">名称</span>
            <input class="set-input" data-d4-01-provider-name aria-label="Provider display name" placeholder="例如 DeepSeek" :value="pForm.displayName" @input="onProviderName" />
          </label>
          <label class="setting-row">
            <span class="set-lab">API 地址</span>
            <input class="set-input mono" data-d4-01-provider-url aria-label="Provider base URL" placeholder="https://api.example.com/v1" :value="pForm.baseUrl" @input="onProviderUrl" />
          </label>
          <label class="setting-row">
            <span class="set-lab">范围<small>个人只对自己生效；组织需要管理员</small></span>
            <select class="set-select" data-d4-01-provider-scope aria-label="Provider scope" :value="pForm.scope" @change="onProviderScope">
              <option value="PERSONAL">个人</option>
              <option value="ORGANIZATION">组织</option>
            </select>
          </label>
          <label class="setting-row">
            <span class="set-lab">API 密钥<small>只写入系统钥匙串</small></span>
            <input class="set-input" data-d4-01-provider-secret aria-label="Provider API key" type="password" placeholder="粘贴密钥" :value="pForm.credentialSecret" @input="onProviderSecret" />
          </label>
          <div class="setting-row set-actions">
            <DsButton variant="primary" size="sm" data-d4-01-provider-create @click="createProvider">添加服务商</DsButton>
          </div>
        </div>
      </div>
    </section>

    <section v-if="tab === 'models'" data-d4-01-pane="models">
      <div class="set-sec">
        <h3>已注册的模型</h3>
        <p v-if="models.length === 0" class="set-cap set-empty" data-d4-01-models-empty>还没有模型。先添加服务商，再在下方注册模型。</p>
        <ul class="d401-list" data-d4-01-models>
          <li v-for="m in models" :key="m.configId" :data-d4-01-model="m.configId" class="set-group d401-card">
            <div class="setting-row">
              <span class="set-lab">
                <span class="d401-name">{{ m.displayName || m.remoteModelId }}</span>
                <small class="d401-meta mono">{{ m.remoteModelId }} · {{ m.scope === "ORGANIZATION" ? "组织" : "个人" }} · v{{ m.version }}</small>
              </span>
              <span class="badge" :class="{ ok: m.status === 'enabled' }">{{ m.status === "enabled" ? "已启用" : "已停用" }}</span>
              <DsButton
                v-if="m.status === 'enabled'"
                variant="ghost"
                size="sm"
                :data-d4-01-model-disable="m.configId"
                @click="setModelStatus(m.configId, 'disabled')"
              >停用</DsButton>
              <DsButton
                v-else
                variant="secondary"
                size="sm"
                :data-d4-01-model-enable="m.configId"
                @click="setModelStatus(m.configId, 'enabled')"
              >启用</DsButton>
            </div>
            <div class="setting-row">
              <span class="set-lab">
                能力
                <small :data-d4-01-model-declared="m.configId">声明：{{ m.capabilities.join("、") || "—" }}</small>
                <small :data-d4-01-model-verified="m.configId">已验证：{{ m.verifiedCapabilities.join("、") || "—" }}</small>
              </span>
              <div class="d401-caps" role="group" :aria-label="'模型能力 ' + (m.displayName || m.remoteModelId)">
                <label v-for="c in CAPABILITY_CHOICES" :key="c.id">
                  <input
                    type="checkbox"
                    :data-d4-01-model-cap="m.configId"
                    :data-d4-01-model-cap-id="c.id"
                    :checked="draftCaps(m).includes(c.id)"
                    @change="toggleModelCap(m.configId, m, c.id)"
                  />
                  {{ c.label }}
                </label>
              </div>
              <DsButton variant="secondary" size="sm" :data-d4-01-model-cap-save="m.configId" @click="saveCaps(m.configId)">保存</DsButton>
            </div>
          </li>
        </ul>
      </div>
      <div class="set-sec">
        <h3>注册模型</h3>
        <div class="set-group d401-form">
          <label class="setting-row">
            <span class="set-lab">服务商</span>
            <select class="set-select" data-d4-01-model-provider aria-label="Model provider" :value="mForm.providerId" @change="onModelProvider">
              <option value="">选择服务商</option>
              <option v-for="p in providerOptions" :key="p.providerId" :value="p.providerId">{{ p.displayName }}</option>
            </select>
          </label>
          <label class="setting-row">
            <span class="set-lab">模型 ID<small>服务商那边的模型名</small></span>
            <input class="set-input mono" data-d4-01-model-remote aria-label="Remote model ID" placeholder="例如 deepseek-chat" :value="mForm.remoteModelId" @input="onModelRemote" />
          </label>
          <label class="setting-row">
            <span class="set-lab">显示名称</span>
            <input class="set-input" data-d4-01-model-name aria-label="Model display name" placeholder="可选" :value="mForm.displayName" @input="onModelName" />
          </label>
          <label class="setting-row">
            <span class="set-lab">范围</span>
            <select class="set-select" data-d4-01-model-scope aria-label="Model scope" :value="mForm.scope" @change="onModelScope">
              <option value="PERSONAL">个人</option>
              <option value="ORGANIZATION">组织</option>
            </select>
          </label>
          <div class="setting-row">
            <span class="set-lab">能力</span>
            <div class="d401-caps" data-d4-01-model-create-caps role="group" aria-label="模型能力">
              <label v-for="c in CAPABILITY_CHOICES" :key="c.id">
                <input
                  type="checkbox"
                  :data-d4-01-model-create-cap="c.id"
                  :checked="mForm.capabilities.includes(c.id)"
                  @change="toggleCreateCap(c.id)"
                />
                {{ c.label }}
              </label>
            </div>
          </div>
          <div class="setting-row set-actions">
            <DsButton variant="primary" size="sm" data-d4-01-model-create @click="createModel">注册模型</DsButton>
          </div>
        </div>
      </div>
    </section>

    <section v-if="tab === 'defaults' && defaults" data-d4-01-pane="defaults">
      <div class="set-sec">
        <h3>我的默认模型</h3>
        <div class="set-group d401-defaults" data-d4-01-defaults-personal>
        <label class="setting-row">
          <span class="set-lab">文本对话</span>
          <select class="set-select" data-d4-01-default-personal-chat :value="defaults.personal.chat || ''" @change="onDefault('chat', $event, 'PERSONAL')">
            <option
              v-for="o in defaultOptions('chat', defaults.personal.chat)"
              :key="o.value + (o.disabled ? ':x' : '')"
              :value="o.value"
              :disabled="o.disabled"
              :data-d4-01-default-unavailable="o.unavailableFor"
            >{{ o.label }}</option>
          </select>
        </label>
        <label class="setting-row">
          <span class="set-lab">工具调用</span>
          <select class="set-select" data-d4-01-default-personal-tool :value="defaults.personal['tool-calling'] || ''" @change="onDefault('tool-calling', $event, 'PERSONAL')">
            <option
              v-for="o in defaultOptions('tool-calling', defaults.personal['tool-calling'])"
              :key="o.value + (o.disabled ? ':x' : '')"
              :value="o.value"
              :disabled="o.disabled"
              :data-d4-01-default-unavailable="o.unavailableFor"
            >{{ o.label }}</option>
          </select>
        </label>
        <label class="setting-row">
          <span class="set-lab">图像生成</span>
          <select class="set-select" data-d4-01-default-personal-image :value="defaults.personal['image-generation'] || ''" @change="onDefault('image-generation', $event, 'PERSONAL')">
            <option
              v-for="o in defaultOptions('image-generation', defaults.personal['image-generation'])"
              :key="o.value + (o.disabled ? ':x' : '')"
              :value="o.value"
              :disabled="o.disabled"
              :data-d4-01-default-unavailable="o.unavailableFor"
            >{{ o.label }}</option>
          </select>
        </label>
        <label class="setting-row">
          <span class="set-lab">视频生成<small>无可用传输（未接通）</small></span>
          <select class="set-select" data-d4-01-default-personal-video disabled aria-disabled="true">
            <option value="">未接通</option>
          </select>
        </label>
        </div>
      </div>
      <div class="set-sec">
        <h3>组织默认模型 <small v-if="!defaults.canManageOrganization" class="muted">（只读）</small></h3>
        <div class="set-group d401-defaults" data-d4-01-defaults-organization>
        <label class="setting-row">
          <span class="set-lab">文本对话</span>
          <select class="set-select" data-d4-01-default-org-chat :value="defaults.organization.chat || ''" @change="onDefault('chat', $event, 'ORGANIZATION')">
            <option
              v-for="o in defaultOptions('chat', defaults.organization.chat)"
              :key="o.value + (o.disabled ? ':x' : '')"
              :value="o.value"
              :disabled="o.disabled"
              :data-d4-01-default-unavailable="o.unavailableFor"
            >{{ o.label }}</option>
          </select>
        </label>
        <label class="setting-row">
          <span class="set-lab">工具调用</span>
          <select class="set-select" data-d4-01-default-org-tool :value="defaults.organization['tool-calling'] || ''" @change="onDefault('tool-calling', $event, 'ORGANIZATION')">
            <option
              v-for="o in defaultOptions('tool-calling', defaults.organization['tool-calling'])"
              :key="o.value + (o.disabled ? ':x' : '')"
              :value="o.value"
              :disabled="o.disabled"
              :data-d4-01-default-unavailable="o.unavailableFor"
            >{{ o.label }}</option>
          </select>
        </label>
        <label class="setting-row">
          <span class="set-lab">图像生成</span>
          <select class="set-select" data-d4-01-default-org-image :value="defaults.organization['image-generation'] || ''" @change="onDefault('image-generation', $event, 'ORGANIZATION')">
            <option
              v-for="o in defaultOptions('image-generation', defaults.organization['image-generation'])"
              :key="o.value + (o.disabled ? ':x' : '')"
              :value="o.value"
              :disabled="o.disabled"
              :data-d4-01-default-unavailable="o.unavailableFor"
            >{{ o.label }}</option>
          </select>
        </label>
        <label class="setting-row">
          <span class="set-lab">视频生成<small>无可用传输（未接通）</small></span>
          <select class="set-select" data-d4-01-default-org-video disabled aria-disabled="true">
            <option value="">未接通</option>
          </select>
        </label>
        </div>
        <p v-if="role !== 'ADMIN'" class="set-cap" data-d4-01-org-hint>组织默认模型需要管理员修改。</p>
      </div>
    </section>
    <section v-if="tab === 'protocols'" data-d4-01-pane="protocols">
      <ModelProtocols />
    </section>
  </div>
</template>
