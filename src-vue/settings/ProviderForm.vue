<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import DsButton from "../design-system/DsButton.vue";
import DsDialog from "../design-system/DsDialog.vue";
import { t } from "../i18n";
import { useShellStore } from "../stores/shell";
import { resolveProviderLogo } from "./providerLogos";
import {
  PROVIDER_PRESETS,
  combineDualCredential,
  dualCredentialFieldError,
  presetDraftPatch,
  presetModelCapabilities,
  presetProtocolStatus,
  type ProviderPreset,
} from "./providerPresets";
import {
  PROVIDER_INSECURE_WARNING,
  PROVIDER_SCOPE_OPTIONS,
  PROVIDER_STATUS_OPTIONS,
  blankProviderDraft,
  buildProviderSubmitPayload,
  needsInsecureOptIn,
  normalizeAdapterType,
  providerScopeHint,
  scopeSelectDisabled,
  validateProviderDraft,
  type ProviderDraft,
} from "./providerFormLogic";

/**
 * 「添加服务商」与「编辑服务商」共用同一套字段与校验。
 * 组件只负责草稿、校验与 payload 组装；命令与结构化错误由上层 ModelSettings 统一处理。
 *
 * 预设（providerPresets.ts）：点一下把名称 / API 地址 / adapterType / 凭据形态写进草稿，
 * **不自动建服务商**，也不自动写密钥；双密钥预设（Lovart）显示两个输入，提交时组合成 JSON。
 * knownProtocols = 上层从 protocol/list 拿到的协议 id；为 null 表示拿不到（不假装知道）。
 */
const props = withDefaults(
  defineProps<{
    mode?: "create" | "edit";
    busy?: boolean;
    initial?: Partial<ProviderDraft> & { credentialConfigured?: boolean };
    knownProtocols?: string[] | null;
  }>(),
  { mode: "create", busy: false, initial: () => ({}), knownProtocols: null },
);

const emit = defineEmits<{
  submit: [event: { mode: "create" | "edit"; payload: Record<string, unknown>; credentialSecret: string; originChanged: boolean }];
  invalid: [code: string];
  cancel: [];
}>();

const shell = useShellStore();
const logoTheme = computed<"light" | "dark">(() => (shell.dark ? "dark" : "light"));

const form = reactive<ProviderDraft>({ ...blankProviderDraft(), ...props.initial, credentialSecret: "" });
const attempted = ref(false);
const selectedPresetId = ref<string | null>(null);
const dualAccess = ref("");
const dualSecret = ref("");
const secretError = ref<string | null>(null);

/** 父组件每次重渲染都会新建 initial 字面量；只在「值真的变了」时重置草稿，避免抹掉用户输入。 */
const fingerprint = computed(() =>
  JSON.stringify([
    props.initial.providerId ?? "",
    props.initial.displayName ?? "",
    props.initial.baseUrl ?? "",
    props.initial.endpointScope ?? "",
    props.initial.scope ?? "",
    props.initial.status ?? "",
    props.initial.allowInsecureHttp === true,
    props.initial.credentialConfigured === true,
    props.initial.adapterType ?? "",
  ]),
);
watch(
  fingerprint,
  () => {
    Object.assign(form, blankProviderDraft(), props.initial, { credentialSecret: "" });
    selectedPresetId.value = null;
    dualAccess.value = "";
    dualSecret.value = "";
    secretError.value = null;
    attempted.value = false;
  },
  { immediate: true },
);
/** 地址一旦不再是公网明文 http，就必须显式清零开关，否则编辑保存会把旧值原样留下。 */
watch(
  () => form.baseUrl,
  () => {
    if (!needsInsecureOptIn(form.baseUrl)) form.allowInsecureHttp = false;
  },
);

const validation = computed(() =>
  validateProviderDraft(form, {
    initialBaseUrl: props.mode === "edit" ? props.initial.baseUrl ?? "" : "",
    credentialConfigured: props.initial.credentialConfigured === true,
  }),
);
const off = computed(() => props.busy || !String(form.displayName || "").trim() || !String(form.baseUrl || "").trim());
const scopeHint = computed(() => providerScopeHint(props.mode));
const scopeDisabled = computed(() => scopeSelectDisabled({ busy: props.busy }));

/** 当前草稿协议：预设在用户点击时写进来；编辑态初值来自服务商自身，不会被预设误改。 */
const currentAdapter = computed(() => normalizeAdapterType(form.adapterType));
const isDual = computed(() => String(form.credentialMode || "single") === "dual");
const activePreset = computed<ProviderPreset | null>(() =>
  selectedPresetId.value ? PROVIDER_PRESETS.find((p) => p.id === selectedPresetId.value) || null : null,
);
const activeStatus = computed(() => (activePreset.value ? presetProtocolStatus(activePreset.value, props.knownProtocols) : "unknown"));
const currentProtocolStatus = computed(() => {
  const known = PROVIDER_PRESETS.find((p) => p.adapterType === currentAdapter.value);
  return known ? presetProtocolStatus(known, props.knownProtocols) : "unknown";
});
const presetRecommendedCaps = computed(() => (activePreset.value ? presetModelCapabilities(activePreset.value) : []));

function presetStatus(preset: ProviderPreset) {
  return presetProtocolStatus(preset, props.knownProtocols);
}
function presetLogo(preset: ProviderPreset) {
  return resolveProviderLogo({ providerId: preset.id, displayName: preset.name, adapterType: preset.adapterType }, logoTheme.value);
}
function presetModeLabel(preset: ProviderPreset): string {
  return preset.credentialMode === "dual" ? t("双密钥") : t("单密钥");
}
function statusText(status: string): string {
  if (status === "available") return t("可直接使用");
  if (status === "pending") return t("接入中");
  return t("状态未知");
}
/** 预设名去掉括号里的补充说明，按钮上放得下；完整名称在 title 里。 */
function shortName(name: string): string {
  return name.replace(/[（(].*$/, "").trim() || name;
}
/** 接口类型用人能读懂的名字；内部 adapterType 只在 title 里给排障用。 */
const adapterLabel = computed(() => {
  const a = currentAdapter.value;
  if (!a || a === "openai-compatible") return t("OpenAI 兼容接口");
  const preset = PROVIDER_PRESETS.find((p) => p.adapterType === a);
  return preset ? t("{name} 接口", { name: shortName(t(preset.name)) }) : a;
});
/** 点预设：只写表单，不建 provider、不写密钥。 */
function applyPreset(preset: ProviderPreset) {
  const patch = presetDraftPatch(preset);
  form.displayName = patch.displayName;
  form.baseUrl = patch.baseUrl;
  form.adapterType = patch.adapterType;
  form.credentialMode = patch.credentialMode;
  form.credentialSecret = "";
  dualAccess.value = "";
  dualSecret.value = "";
  secretError.value = null;
  selectedPresetId.value = preset.id;
}

/* 「获取密钥」：先二次确认，再交给主进程 browser/openExternal 在系统浏览器打开。 */
const keyUrl = ref<string | null>(null);
const keyError = ref("");
async function openKeyUrl() {
  const url = keyUrl.value;
  keyUrl.value = null;
  keyError.value = "";
  if (!url) return;
  const browser = (window as any).openarc?.browser;
  if (!browser || typeof browser.command !== "function") {
    keyError.value = t("当前环境没有外部浏览器桥；请手动打开服务商控制台。");
    return;
  }
  const res = await browser.command({ type: "browser/openExternal", url }).catch(() => null);
  if (res && res.error) keyError.value = String(res.error);
}

const secretPlaceholder = computed(() => {
  if (props.mode === "edit") {
    return props.initial.credentialConfigured === true
      ? "已保存（只写入，不再显示）· 粘贴新密钥可替换"
      : "粘贴密钥";
  }
  return "粘贴密钥";
});

function reset() {
  Object.assign(form, blankProviderDraft());
  selectedPresetId.value = null;
  dualAccess.value = "";
  dualSecret.value = "";
  secretError.value = null;
  attempted.value = false;
}
defineExpose({ reset });

function submit() {
  attempted.value = true;
  secretError.value = null;
  const v = validation.value;
  if (!v.ok) {
    if (v.code) emit("invalid", v.code);
    return;
  }
  let credentialSecret = String(form.credentialSecret || "");
  if (isDual.value) {
    const error = dualCredentialFieldError({ accessKey: dualAccess.value, secretKey: dualSecret.value });
    secretError.value = error;
    if (error) {
      emit("invalid", "INVALID_INPUT");
      return;
    }
    credentialSecret = combineDualCredential({ accessKey: dualAccess.value, secretKey: dualSecret.value });
  }
  // 装配走纯逻辑：create 的凭据必须随 payload 一次落库（单密钥与双密钥组合值都在这里进 payload）。
  const built = buildProviderSubmitPayload(props.mode, form, credentialSecret);
  emit("submit", {
    mode: props.mode,
    payload: built.payload,
    credentialSecret: built.credentialSecret,
    originChanged: props.mode === "edit" ? v.originChanged : false,
  });
}

function onBaseUrl(event: Event) {
  form.baseUrl = (event.target as HTMLInputElement).value;
}
</script>

<template>
  <form
    class="mp2-formset"
    data-d4-01-provider-form
    :data-d4-01-provider-form-mode="mode"
    @submit.prevent="submit"
  >
    <!-- 预设：点一下填好名称 / 地址 / adapterType / 凭据形态；不自动创建、不自动写密钥 -->
    <div class="mp2-field" data-d4-01-presets>
      <span>{{ t("常用服务商") }} <small>{{ t("点一下自动填好名称和地址，密钥仍需自己粘贴") }}</small></span>
      <div class="mp2-preset-row">
        <button
          v-for="p in PROVIDER_PRESETS"
          :key="p.id"
          type="button"
          class="mp2-preset"
          :class="{ on: selectedPresetId === p.id }"
          :data-d4-01-preset="p.id"
          :data-d4-01-preset-name="p.name"
          :data-d4-01-preset-adapter="p.adapterType"
          :data-d4-01-preset-mode="p.credentialMode"
          :data-d4-01-preset-status="presetStatus(p)"
          :data-d4-01-preset-selected="selectedPresetId === p.id ? 'true' : 'false'"
          :aria-pressed="selectedPresetId === p.id"
          :title="t(p.name) + ' · ' + presetModeLabel(p)"
          @click="applyPreset(p)"
        >
          <span
            class="pform-logo"
            :class="{ 'pform-logo-brand': presetLogo(p) }"
            :data-d4-01-preset-logo="presetLogo(p)?.key ?? ''"
            :data-d4-01-preset-logo-kind="presetLogo(p) ? 'brand' : 'initial'"
            :style="presetLogo(p) ? { color: 'var(--text)' } : undefined"
            aria-hidden="true"
          >
            <span
              v-if="presetLogo(p)?.render === 'mask'"
              class="pform-logo-mark"
              :style="{ maskImage: 'url(' + presetLogo(p)!.url + ')', WebkitMaskImage: 'url(' + presetLogo(p)!.url + ')' }"
            />
            <img v-else-if="presetLogo(p)" :src="presetLogo(p)!.url" :alt="presetLogo(p)!.label" />
            <template v-else>{{ p.name.slice(0, 1) }}</template>
          </span>
          <span class="pform-preset-label">{{ shortName(t(p.name)) }}</span>
          <span v-if="presetStatus(p) === 'pending'" class="pform-preset-pending" :data-d4-01-preset-pending="p.id">{{ t("接入中") }}</span>
        </button>
      </div>
    </div>

    <!-- 接口协议：只读展示，由预设写入；编辑态即服务商当前协议（内部 id 只放在 title 里） -->
    <div class="mp2-field pform-inline">
      <span>{{ t("接口类型") }}</span>
      <div class="mp2-static" data-d4-01-provider-adapter :data-d4-01-preset-current-adapter="mode === 'edit' ? currentAdapter : undefined" :title="currentAdapter">{{ adapterLabel }}</div>
    </div>

    <!-- 选中预设的详情：文档 / 凭据形态 / 协议状态 / 推荐模型 -->
    <div v-if="activePreset" class="mp2-preset-detail" :data-d4-01-preset-detail="activePreset.id">
      <div class="mp2-row">
        <a class="pform-docs" :href="activePreset.docsUrl" target="_blank" rel="noreferrer" data-d4-01-preset-docs>{{ activePreset.docsUrl }}</a>
        <span class="ds-badge ds-badge--sm ds-badge--neutral" data-d4-01-preset-mode-label>{{ presetModeLabel(activePreset) }}</span>
        <span class="ds-badge ds-badge--sm" :class="activeStatus === 'available' ? 'ds-badge--success' : activeStatus === 'pending' ? 'ds-badge--warning' : 'ds-badge--neutral'" data-d4-01-preset-protocol-status>{{ statusText(activeStatus) }}</span>
        <DsButton size="sm" variant="secondary" data-d4-01-preset-key :disabled="!activePreset.apiKeyUrl" :title="activePreset.apiKeyUrl ? t('在系统浏览器打开服务商控制台获取 API Key（需确认）') : t('该预设没有登记官方 API Key 页面')" @click="keyUrl = activePreset.apiKeyUrl || null">{{ t("获取密钥") }}</DsButton>
      </div>
      <p v-if="!activePreset.apiKeyUrl" class="set-cap" data-d4-01-preset-key-missing>{{ t("这个服务商没有登记获取密钥的页面，请到它的控制台自行获取。") }}</p>
      <p class="set-cap" data-d4-01-preset-notes>{{ t(activePreset.notes) }}</p>
      <p v-if="activeStatus === 'pending'" class="pform-warn" data-d4-01-preset-pending-notice>
        {{ t("这个服务商的接口还在接入中：可以先保存，但现在调用会失败。") }}
      </p>
      <p v-else-if="activeStatus === 'unknown'" class="pform-warn" data-d4-01-preset-protocol-unknown>
        {{ t("暂时无法确认这个服务商的接口是否可用。") }}
      </p>
      <div class="mp2-row" data-d4-01-preset-models>
        <template v-if="activePreset.models.length">
          <span class="set-cap">{{ t("推荐模型") }}</span>
          <span v-for="m in activePreset.models.slice(0, 4)" :key="m.id" class="ds-badge ds-badge--sm ds-badge--neutral" :title="m.capabilities.join('、')">{{ m.id }}</span>
          <span v-if="presetRecommendedCaps.length" class="set-cap" :data-d4-01-preset-caps="presetRecommendedCaps.join(',')">{{ t("能力：{caps}", { caps: presetRecommendedCaps.join("、") }) }}</span>
        </template>
        <span v-else class="set-cap" data-d4-01-preset-models-catalog>{{ t("没有公开的模型清单；添加后在服务商详情里「拉取模型」即可。") }}</span>
      </div>
    </div>

    <label class="mp2-field"><span>{{ t("名称") }}</span>
      <input class="set-input" data-d4-01-provider-name :aria-label="t('服务商名称')" :placeholder="t('例如 DeepSeek')" :value="form.displayName" @input="form.displayName = ($event.target as HTMLInputElement).value" />
      <small v-if="attempted && validation.fieldErrors.displayName" class="pform-err" data-d4-01-provider-name-error>{{ t(validation.fieldErrors.displayName) }}</small>
    </label>
    <label class="mp2-field"><span>{{ t("API 地址") }}</span>
      <input class="set-input mono" data-d4-01-provider-url :aria-label="t('API 地址')" placeholder="https://api.example.com/v1" :value="form.baseUrl" @input="onBaseUrl" />
      <small v-if="attempted && validation.fieldErrors.baseUrl" class="pform-err" data-d4-01-provider-url-error>{{ t(validation.fieldErrors.baseUrl) }}</small>
    </label>
    <div v-if="validation.needsInsecureOptIn" class="mp2-field" data-d4-01-provider-insecure-opt>
      <label class="mp2-insecure">
        <input type="checkbox" data-d4-01-provider-insecure-http :aria-label="t('允许不安全 HTTP（明文直连）')" :checked="form.allowInsecureHttp" @change="form.allowInsecureHttp = ($event.target as HTMLInputElement).checked" />
        <span>{{ t("允许不安全 HTTP（明文直连）") }}</span>
      </label>
      <p class="mp2-insecure-warn" data-d4-01-provider-insecure-warning>{{ t(PROVIDER_INSECURE_WARNING) }}</p>
      <small v-if="attempted && validation.fieldErrors.insecureHttp" class="pform-err" data-d4-01-provider-insecure-error>{{ t(validation.fieldErrors.insecureHttp) }}</small>
    </div>

    <template v-if="isDual">
      <label class="mp2-field"><span>Access Key <small>{{ mode === "edit" ? t("替换密钥：只写入系统钥匙串，留空表示不更换") : t("只写入系统钥匙串") }}</small></span>
        <input class="set-input mono" data-d4-01-provider-secret-access aria-label="Access Key" type="password" placeholder="ak_..." :value="dualAccess" @input="dualAccess = ($event.target as HTMLInputElement).value" />
      </label>
      <label class="mp2-field"><span>Secret Key <small>{{ t("与 Access Key 一起提交（组合成一组凭据）") }}</small></span>
        <input class="set-input mono" data-d4-01-provider-secret-key aria-label="Secret Key" type="password" placeholder="sk_..." :value="dualSecret" @input="dualSecret = ($event.target as HTMLInputElement).value" />
      </label>
      <small v-if="attempted && secretError" class="pform-err" data-d4-01-provider-secret-error>{{ t(secretError) }}</small>
    </template>
    <label v-else class="mp2-field"><span>{{ t("API 密钥") }} <small>{{ mode === "edit" ? t("替换密钥：只写入系统钥匙串，留空表示不更换") : t("只写入系统钥匙串") }}</small></span>
      <input class="set-input" data-d4-01-provider-secret aria-label="API 密钥" type="password" :placeholder="t(secretPlaceholder)" :value="form.credentialSecret" @input="form.credentialSecret = ($event.target as HTMLInputElement).value" />
    </label>

    <label class="mp2-field"><span>{{ t("范围") }} <small data-d4-01-provider-scope-hint>{{ t(scopeHint) }}</small></span>
      <select class="set-select" data-d4-01-provider-scope :aria-label="t('范围')" :disabled="scopeDisabled" :value="form.scope" @change="form.scope = ($event.target as HTMLSelectElement).value">
        <option v-for="o in PROVIDER_SCOPE_OPTIONS" :key="o.id" :value="o.id">{{ t(o.label) }}</option>
      </select>
      <small v-if="attempted && validation.fieldErrors.scope" class="pform-err" data-d4-01-provider-scope-error>{{ t(validation.fieldErrors.scope) }}</small>
    </label>
    <label v-if="mode === 'edit'" class="mp2-field"><span>{{ t("状态") }} <small>{{ t("停用后该服务商下的模型不再被调用") }}</small></span>
      <select class="set-select" data-d4-01-provider-status :aria-label="t('启用状态')" :value="form.status" @change="form.status = ($event.target as HTMLSelectElement).value">
        <option v-for="o in PROVIDER_STATUS_OPTIONS" :key="o.id" :value="o.id">{{ t(o.label) }}</option>
      </select>
    </label>
    <p v-if="validation.originChanged" class="pform-hint" data-d4-01-provider-origin-hint>
      {{ t("API 地址的域名变了（{url}）。为安全起见，旧密钥不会自动发往新地址。", { url: form.baseUrl }) }}
      <template v-if="validation.requiresNewCredential">{{ t("请在「API 密钥」里粘贴新密钥后一起保存；只改地址不换密钥，之后的调用会被拦截。") }}</template>
      <template v-else>{{ t("你已填写新密钥，保存时会按新地址重新绑定。") }}</template>
    </p>
    <div class="mp2-actions">
      <DsButton v-if="mode === 'edit'" variant="ghost" size="sm" data-d4-01-provider-cancel @click="emit('cancel')">{{ t("取消") }}</DsButton>
      <DsButton v-if="mode === 'edit'" variant="primary" size="sm" data-d4-01-provider-save :disabled="off" @click="submit">{{ busy ? t("保存中…") : t("保存修改") }}</DsButton>
      <DsButton v-else variant="primary" size="sm" data-d4-01-provider-create :disabled="off" @click="submit">{{ t("添加") }}</DsButton>
    </div>

    <DsDialog :open="keyUrl !== null" :title="t('获取 API 密钥')" @close="keyUrl = null">
      <p class="set-cap">{{ t("将在系统浏览器打开服务商控制台；OpenArc 不会读取或代填你的密钥。") }}</p>
      <p class="mp2-static" data-d4-01-preset-key-url>{{ keyUrl }}</p>
      <p v-if="keyError" class="pform-err" role="alert" data-d4-01-preset-key-error>{{ keyError }}</p>
      <template #footer>
        <button class="ghost" type="button" @click="keyUrl = null">{{ t("取消") }}</button>
        <button class="primary" type="button" data-d4-01-preset-key-confirm @click="openKeyUrl">{{ t("打开控制台") }}</button>
      </template>
    </DsDialog>
  </form>
</template>

<style scoped>
.mp2-formset { display: flex; flex-direction: column; gap: 14px; }
.mp2-formset :deep(.mp2-field > span) { font-size: var(--fs-secondary); color: var(--text); }
.mp2-formset :deep(.mp2-field > span small) { margin-left: 6px; font-size: var(--fs-caption); color: var(--muted); }
.pform-inline { flex-direction: row; align-items: baseline; justify-content: space-between; }
.pform-inline .mp2-static { color: var(--muted); }
.mp2-insecure { display: flex; align-items: center; gap: 8px; font-size: var(--fs-secondary); cursor: pointer; }
.mp2-insecure input { margin: 0; }
.mp2-insecure-warn { margin: 6px 0 0; color: var(--warning-text, #a05a00); font-size: var(--fs-caption); line-height: 1.6; }
.pform-err { color: var(--failed, #ff453a); font-size: var(--fs-caption); line-height: 1.6; }
.pform-hint { margin: 0; color: var(--warning-text, #a05a00); font-size: var(--fs-caption); line-height: 1.6; }
.pform-warn { margin: 0; color: var(--warning-text, #a05a00); font-size: var(--fs-caption); line-height: 1.6; }
/* 常用服务商：四列等宽小方块（控件 8 圆角、sunken 底、无描边）；选中 = 深一级底 + 500 字重（设计语言 §3.1 选中态）。 */
.mp2-preset-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.mp2-preset { display: flex; align-items: center; gap: 8px; min-width: 0; height: 32px; padding: 0 10px; border-radius: var(--radius-md); background: var(--sunken); color: var(--text); font-size: var(--fs-secondary); }
.mp2-preset:hover { background: rgb(var(--text-rgb) / 0.1); }
.mp2-preset.on { background: rgb(var(--text-rgb) / 0.14); font-weight: var(--fw-medium); }
.pform-preset-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pform-preset-pending { margin-left: auto; font-size: var(--fs-micro); color: var(--muted); }
.pform-logo { width: 16px; height: 16px; flex: none; display: grid; place-items: center; color: var(--muted); }
.pform-logo img { display: block; max-width: 16px; max-height: 16px; object-fit: contain; }
.pform-logo-mark { width: 16px; height: 16px; background-color: currentColor; -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat; -webkit-mask-position: center; mask-position: center; -webkit-mask-size: contain; mask-size: contain; }
.mp2-preset-detail { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: var(--radius-md); background: var(--sunken); }
.pform-docs { font-size: var(--fs-caption); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; flex: 1; min-width: 0; }
@media (max-width: 560px) { .mp2-preset-row { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
