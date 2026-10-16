<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import DsButton from "../design-system/DsButton.vue";

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
  const name = m ? String(m.displayName || m.remoteModelId || m.configId) : "（该模型已不在清单里）";
  return name + "（已配置为默认" + (m ? "，但没有「" + (CAPABILITY_LABEL[cap] || cap) + "」能力" : "") + "，不可用）";
}

const bridge = () => (window as any).openarc?.model;

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
/* ── 10-16 按界面原型：两栏（服务商列表 | 服务商详情）+ 默认模型，取消分区标签 ── */
const selected = ref<string | null>(null); // providerId 或 "new"
const current = computed(() => providers.value.find((p) => p.providerId === selected.value) || null);
const modelsOf = (providerId: string) => models.value.filter((m) => m.providerId === providerId);
function providerState(p: any): { tone: "ok" | "warn" | "off"; label: string } {
  if (p.status !== "enabled") return { tone: "off", label: "已停用" };
  const c = credStatus.value[p.providerId];
  if (c && c.configured === false) return { tone: "warn", label: "缺少密钥" };
  const t = tests.value[p.providerId];
  if (t && t.ok) return { tone: "ok", label: "连接正常" };
  if (t && !t.ok) return { tone: "warn", label: "连接失败" };
  return { tone: "ok", label: "已启用" };
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
async function submitProvider() {
  const before = providers.value.map((p) => p.providerId);
  await createProvider();
  const added = providers.value.find((p) => !before.includes(p.providerId));
  if (added) selected.value = added.providerId;
}
const editingCaps = ref<string | null>(null);
</script>

<template>
  <div class="d401-settings mp2" data-d4-01="settings">
    <p class="settings-lead">统一管理服务商、地址、密钥与模型。所有接入 OpenArc 的应用通过后台调用，不需要逐个填写；密钥只写入系统钥匙串，不会再显示。</p>
    <p v-if="error" class="d401-error" role="alert" data-d4-01-error :data-d4-01-error-code="error">{{ errText(error) }}</p>
    <p v-if="notice" class="d401-notice" role="status" data-d4-01-notice>{{ notice }}</p>

    <div class="mp2-grid" data-d4-01-pane="providers">
      <!-- 左：服务商列表 -->
      <div class="set-group mp2-provs" data-d4-01-providers>
        <button
          v-for="p in providers"
          :key="p.providerId"
          type="button"
          class="mp2-prov"
          :class="{ on: selected === p.providerId }"
          :data-d4-01-provider="p.providerId"
          @click="selected = p.providerId; addingModel = false"
        >
          <span class="mp2-logo" :style="{ background: logoColor(p.providerId) }" aria-hidden="true">{{ mono(p.displayName) }}</span>
          <span class="mp2-prov-main">
            <b>{{ p.displayName }}</b>
            <small>{{ modelsOf(p.providerId).length }} 个模型</small>
          </span>
          <span class="mp2-dot" :data-tone="providerState(p).tone" :title="providerState(p).label" />
        </button>
        <button type="button" class="mp2-prov" :class="{ on: selected === 'new' }" data-d4-01-provider-add @click="selected = 'new'">
          <span class="mp2-logo mp2-logo-add" aria-hidden="true">＋</span>
          <span class="mp2-prov-main"><b>添加服务商</b></span>
        </button>
      </div>

      <!-- 右：添加服务商 -->
      <div v-if="selected === 'new' || !current" class="set-group mp2-detail" data-d4-01-provider-form>
        <p v-if="providers.length === 0" class="set-cap" data-d4-01-providers-empty>还没有服务商。填写地址与密钥添加第一个，常见的 OpenAI 兼容服务（DeepSeek、通义、火山方舟、硅基流动等）都可以。</p>
        <div class="mp2-head"><b>添加服务商</b></div>
        <label class="mp2-field"><span>名称</span>
          <input class="set-input" data-d4-01-provider-name aria-label="服务商名称" placeholder="例如 DeepSeek" :value="pForm.displayName" @input="onProviderName" />
        </label>
        <label class="mp2-field"><span>API 地址</span>
          <input class="set-input mono" data-d4-01-provider-url aria-label="API 地址" placeholder="https://api.example.com/v1" :value="pForm.baseUrl" @input="onProviderUrl" />
        </label>
        <label class="mp2-field"><span>API 密钥 <small>只写入系统钥匙串</small></span>
          <input class="set-input" data-d4-01-provider-secret aria-label="API 密钥" type="password" placeholder="粘贴密钥" :value="pForm.credentialSecret" @input="onProviderSecret" />
        </label>
        <label class="mp2-field"><span>范围 <small>个人只对自己生效；组织需要管理员</small></span>
          <select class="set-select" data-d4-01-provider-scope aria-label="范围" :value="pForm.scope" @change="onProviderScope">
            <option value="PERSONAL">个人</option>
            <option value="ORGANIZATION">组织</option>
          </select>
        </label>
        <div class="mp2-actions">
          <DsButton variant="primary" size="sm" data-d4-01-provider-create :disabled="busy || !pForm.displayName.trim() || !pForm.baseUrl.trim()" @click="submitProvider">添加服务商</DsButton>
        </div>
      </div>

      <!-- 右：服务商详情 -->
      <div v-else class="set-group mp2-detail" :key="current.providerId" :data-d4-01-provider-detail="current.providerId">
        <div class="mp2-head">
          <span class="mp2-logo" :style="{ background: logoColor(current.providerId) }" aria-hidden="true">{{ mono(current.displayName) }}</span>
          <b class="mp2-title">{{ current.displayName }}</b>
          <span class="badge" :class="{ ok: providerState(current).tone === 'ok', warn: providerState(current).tone === 'warn' }" data-d4-01-provider-status>{{ providerState(current).label }}</span>
        </div>
        <div class="mp2-field"><span>API 地址</span>
          <div class="mp2-static mono">{{ current.baseUrl }}<small> · {{ current.scope === "ORGANIZATION" ? "组织" : "个人" }} · {{ current.adapterType }}</small></div>
        </div>
        <div class="mp2-field"><span>API 密钥 <small :data-d4-01-cred-status="current.providerId">{{ credLabel(current.providerId) }}</small></span>
          <div class="mp2-row">
            <input
              class="set-input"
              :data-d4-01-cred-input="current.providerId"
              :aria-label="'API 密钥：' + current.displayName"
              type="password"
              :placeholder="credStatus[current.providerId]?.configured ? '已保存（只写入，不再显示）· 粘贴新密钥可替换' : '粘贴密钥'"
              :value="credDraft[current.providerId] || ''"
              @input="onCredDraft(current.providerId, $event)"
            />
            <DsButton variant="secondary" size="sm" :data-d4-01-cred-set="current.providerId" :disabled="!credDraft[current.providerId]" @click="saveCred(current.providerId, !!credStatus[current.providerId]?.configured)">保存</DsButton>
            <DsButton v-if="credStatus[current.providerId]?.configured" variant="ghost" size="sm" :data-d4-01-cred-delete="current.providerId" @click="deleteCred(current.providerId)">删除</DsButton>
          </div>
        </div>
        <div class="mp2-row">
          <DsButton variant="secondary" size="sm" :data-d4-01-test="current.providerId" @click="runTest(current.providerId)">测试连接</DsButton>
          <span v-if="tests[current.providerId]" class="badge" :class="{ ok: tests[current.providerId].ok }" :data-d4-01-test-result="current.providerId">{{ tests[current.providerId].ok ? "连接成功" : "连接失败" }}</span>
          <small v-if="tests[current.providerId]" class="set-cap">{{ testLabel(tests[current.providerId]) }}</small>
          <span class="toolbar-spacer" />
          <DsButton v-if="current.status === 'enabled'" variant="ghost" size="sm" :data-d4-01-provider-disable="current.providerId" @click="setProviderStatus(current.providerId, 'disabled')">停用</DsButton>
          <DsButton v-else variant="secondary" size="sm" :data-d4-01-provider-enable="current.providerId" @click="setProviderStatus(current.providerId, 'enabled')">启用</DsButton>
        </div>

        <div class="mp2-field" data-d4-01-pane="models"><span>模型与能力</span>
          <ul class="mp2-models" data-d4-01-models>
            <li v-for="m in modelsOf(current.providerId)" :key="m.configId" :data-d4-01-model="m.configId" :class="{ off: m.status !== 'enabled' }">
              <div class="mp2-model-row">
                <span class="mono mp2-model-id" :title="m.remoteModelId">{{ m.displayName || m.remoteModelId }}</span>
                <span v-for="c in m.capabilities" :key="c" class="badge" :class="{ ok: m.verifiedCapabilities.includes(c) }" :title="m.verifiedCapabilities.includes(c) ? '已验证' : '已声明，未验证'">{{ CAP_SHORT[c] || c }}</span>
                <button class="mp2-link" @click="editingCaps = editingCaps === m.configId ? null : m.configId">编辑</button>
                <button v-if="m.status === 'enabled'" class="mp2-link" :data-d4-01-model-disable="m.configId" @click="setModelStatus(m.configId, 'disabled')">停用</button>
                <button v-else class="mp2-link" :data-d4-01-model-enable="m.configId" @click="setModelStatus(m.configId, 'enabled')">启用</button>
              </div>
              <div v-if="editingCaps === m.configId" class="mp2-caps-edit">
                <label v-for="c in CAPABILITY_CHOICES" :key="c.id">
                  <input type="checkbox" :data-d4-01-model-cap="m.configId" :data-d4-01-model-cap-id="c.id" :checked="draftCaps(m).includes(c.id)" @change="toggleModelCap(m.configId, m, c.id)" />
                  {{ c.label }}
                </label>
                <DsButton variant="secondary" size="sm" :data-d4-01-model-cap-save="m.configId" @click="saveCaps(m.configId); editingCaps = null">保存</DsButton>
              </div>
            </li>
            <li v-if="!modelsOf(current.providerId).length" class="set-cap" data-d4-01-models-empty>还没有模型。可以从服务商拉取，或手动添加。</li>
          </ul>
          <div class="mp2-row">
            <DsButton variant="secondary" size="sm" :data-d4-01-pull="current.providerId" :disabled="pulling === current.providerId" @click="pullModels(current.providerId)">
              {{ pulling === current.providerId ? "拉取中…" : remote[current.providerId] ? "重新拉取" : "拉取模型" }}
            </DsButton>
            <DsButton variant="ghost" size="sm" data-d4-01-model-add @click="startAddModel(current.providerId)">添加自定义模型</DsButton>
          </div>
        </div>

        <div v-if="addingModel && mForm.providerId === current.providerId" class="mp2-sub" data-d4-01-model-form>
          <label class="mp2-field"><span>模型 ID <small>服务商那边的模型名</small></span>
            <input class="set-input mono" data-d4-01-model-remote aria-label="模型 ID" placeholder="例如 deepseek-chat" :value="mForm.remoteModelId" @input="onModelRemote" />
          </label>
          <label class="mp2-field"><span>显示名称 <small>可选</small></span>
            <input class="set-input" data-d4-01-model-name aria-label="显示名称" :value="mForm.displayName" @input="onModelName" />
          </label>
          <div class="mp2-field"><span>能力</span>
            <div class="mp2-caps-edit" data-d4-01-model-create-caps>
              <label v-for="c in CAPABILITY_CHOICES" :key="c.id">
                <input type="checkbox" :data-d4-01-model-create-cap="c.id" :checked="mForm.capabilities.includes(c.id)" @change="toggleCreateCap(c.id)" />
                {{ c.label }}
              </label>
            </div>
          </div>
          <div class="mp2-actions">
            <DsButton variant="ghost" size="sm" @click="addingModel = false">取消</DsButton>
            <DsButton variant="primary" size="sm" data-d4-01-model-create :disabled="!mForm.remoteModelId.trim()" @click="submitModel">添加模型</DsButton>
          </div>
        </div>

        <div v-if="remote[current.providerId]" class="mp2-sub d401-remote" :data-d4-01-remote="current.providerId">
          <div class="d401-remote-head">
            <label class="ds-search d401-remote-search">
              <input
                class="ds-search__input"
                type="search"
                placeholder="筛选模型"
                aria-label="筛选模型"
                :value="remoteFilter[current.providerId] || ''"
                @input="remoteFilter = { ...remoteFilter, [current.providerId]: ($event.target as HTMLInputElement).value }"
              />
            </label>
            <span class="set-val">{{ remoteList(current.providerId).length }} / {{ remote[current.providerId].length }}</span>
            <DsButton variant="primary" size="sm" :disabled="!pickedCount(current.providerId)" @click="registerPicked(current.providerId)">
              注册所选{{ pickedCount(current.providerId) ? `（${pickedCount(current.providerId)}）` : "" }}
            </DsButton>
          </div>
          <ul class="d401-remote-list">
            <li v-for="m in remoteList(current.providerId)" :key="m.id">
              <label :class="{ done: m.registered }">
                <input type="checkbox" :disabled="m.registered" :checked="m.registered || !!picked[current.providerId]?.[m.id]" @change="togglePick(current.providerId, m)" />
                <span class="mono d401-remote-id">{{ m.id }}</span>
                <span v-if="m.registered" class="badge">已注册</span>
                <span v-else class="d401-remote-caps">{{ (m.suggestedCapabilities.length ? m.suggestedCapabilities : ['chat']).map((c) => CAP_SHORT[c] || c).join(" · ") }}</span>
              </label>
            </li>
            <li v-if="!remoteList(current.providerId).length" class="set-cap">没有匹配的模型</li>
          </ul>
          <p class="set-cap">能力按模型名推断，注册后可以点「编辑」修改；「测试连接」通过后才算已验证。</p>
        </div>
      </div>
    </div>

    <!-- 默认模型 -->
    <template v-if="defaults">
      <div class="set-sec" data-d4-01-pane="defaults">
        <h3>默认模型</h3>
        <div class="set-group d401-defaults" data-d4-01-defaults-personal>
          <label v-for="d in [['chat', '文本对话', 'chat'], ['tool-calling', '工具调用', 'tool'], ['image-generation', '图像生成', 'image']]" :key="d[0]" class="setting-row">
            <span class="set-lab">{{ d[1] }}</span>
            <select class="set-select"  v-bind="{ ['data-d4-01-default-personal-' + d[2]]: '' }" :value="defaults.personal[d[0]] || ''" @change="onDefault(d[0], $event, 'PERSONAL')">
              <option v-for="o in defaultOptions(d[0], defaults.personal[d[0]])" :key="o.value + (o.disabled ? ':x' : '')" :value="o.value" :disabled="o.disabled" :data-d4-01-default-unavailable="o.unavailableFor">
                {{ o.value ? o.label : "自动" }}
              </option>
            </select>
          </label>
          <label class="setting-row">
            <span class="set-lab">视频生成<small>无可用传输（未接通）</small></span>
            <select class="set-select" data-d4-01-default-personal-video disabled aria-disabled="true"><option value="">未接通</option></select>
          </label>
        </div>
        <p class="set-cap">「自动」表示使用当前服务商下已配置、且能力匹配的模型。所有应用（AI Studio、对话、Skill、短剧工坊……）都用这里的设置。</p>
      </div>
      <div class="set-sec">
        <h3>组织默认模型 <small v-if="!defaults.canManageOrganization" class="muted">（只读）</small></h3>
        <div class="set-group d401-defaults" data-d4-01-defaults-organization>
          <label v-for="d in [['chat', '文本对话', 'chat'], ['tool-calling', '工具调用', 'tool'], ['image-generation', '图像生成', 'image']]" :key="d[0]" class="setting-row">
            <span class="set-lab">{{ d[1] }}</span>
            <select class="set-select"  v-bind="{ ['data-d4-01-default-org-' + d[2]]: '' }" :disabled="!defaults.canManageOrganization" :value="defaults.organization[d[0]] || ''" @change="onDefault(d[0], $event, 'ORGANIZATION')">
              <option v-for="o in defaultOptions(d[0], defaults.organization[d[0]])" :key="o.value + (o.disabled ? ':x' : '')" :value="o.value" :disabled="o.disabled" :data-d4-01-default-unavailable="o.unavailableFor">
                {{ o.value ? o.label : "未设置" }}
              </option>
            </select>
          </label>
        </div>
        <p v-if="role !== 'ADMIN'" class="set-cap" data-d4-01-org-hint>组织默认模型需要管理员修改。成员没有设置个人默认时，使用组织默认。</p>
        <p class="set-cap">协议（各家服务的调用方式与可用状态）在「协议中心」里查看。</p>
      </div>
    </template>
  </div>
</template>
