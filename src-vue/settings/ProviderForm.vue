<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import DsButton from "../design-system/DsButton.vue";
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
  return preset.credentialMode === "dual" ? "双密钥" : "单密钥";
}
function statusText(status: string): string {
  if (status === "available") return "协议已注册";
  if (status === "pending") return "协议实现中";
  return "协议未确认";
}
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
    <div class="mp2-head"><b>{{ mode === "edit" ? "编辑服务商" : "添加服务商" }}</b></div>

    <!-- 预设：点一下填好名称 / 地址 / adapterType / 凭据形态；不自动创建、不自动写密钥 -->
    <div class="mp2-field" data-d4-01-presets>
      <span>预设 <small>点一下自动填名称、API 地址与协议；密钥仍需自己填并确认提交</small></span>
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
          :title="p.name + ' · ' + p.adapterType + ' · ' + presetModeLabel(p)"
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
          <span class="pform-preset-label">{{ p.name }}</span>
          <span v-if="presetStatus(p) === 'pending'" class="pform-preset-pending" :data-d4-01-preset-pending="p.id">协议实现中</span>
        </button>
      </div>
    </div>

    <!-- 协议（adapterType）：只读展示，由预设写入；编辑态即服务商当前协议 -->
    <div class="mp2-field">
      <span>协议（adapterType） <small>镜像桥按它选 provider 协议；由预设决定</small></span>
      <div class="mp2-static mono" data-d4-01-provider-adapter>{{ currentAdapter }}</div>
      <small v-if="mode === 'edit'" class="set-cap" data-d4-01-preset-current-adapter>当前协议：{{ currentAdapter }}</small>
    </div>

    <!-- 选中预设的详情：文档 / 凭据形态 / 协议状态 / 推荐模型 -->
    <div v-if="activePreset" class="mp2-preset-detail" :data-d4-01-preset-detail="activePreset.id">
      <div class="mp2-row">
        <a class="pform-docs mono" :href="activePreset.docsUrl" target="_blank" rel="noreferrer" data-d4-01-preset-docs>{{ activePreset.docsUrl }}</a>
        <span class="badge" data-d4-01-preset-mode-label>{{ presetModeLabel(activePreset) }}</span>
        <span class="badge" :class="{ ok: activeStatus === 'available', warn: activeStatus === 'pending' }" data-d4-01-preset-protocol-status>{{ statusText(activeStatus) }}</span>
      </div>
      <p class="set-cap" data-d4-01-preset-notes>{{ activePreset.notes }}</p>
      <p v-if="activeStatus === 'pending'" class="pform-warn" data-d4-01-preset-pending-notice>
        协议「{{ currentAdapter }}」还没在当前构建里注册（由另外的包实现中）：可以保存服务商，但调用会失败。
      </p>
      <p v-else-if="activeStatus === 'unknown'" class="pform-warn" data-d4-01-preset-protocol-unknown>
        没拿到协议表，无法确认「{{ currentAdapter }}」是否已落地。
      </p>
      <div class="mp2-row" data-d4-01-preset-models>
        <template v-if="activePreset.models.length">
          <span class="set-cap">推荐模型</span>
          <span v-for="m in activePreset.models.slice(0, 4)" :key="m.id" class="badge mono" :title="m.capabilities.join('、')">{{ m.id }}</span>
          <span v-if="presetRecommendedCaps.length" class="set-cap" :data-d4-01-preset-caps="presetRecommendedCaps.join(',')">能力：{{ presetRecommendedCaps.join('、') }}</span>
        </template>
        <span v-else class="set-cap" data-d4-01-preset-models-catalog>模型列表由 catalog 动态拉取（本家没有公开清单，不编造）</span>
      </div>
    </div>

    <label class="mp2-field"><span>名称</span>
      <input class="set-input" data-d4-01-provider-name aria-label="服务商名称" placeholder="例如 DeepSeek" :value="form.displayName" @input="form.displayName = ($event.target as HTMLInputElement).value" />
      <small v-if="attempted && validation.fieldErrors.displayName" class="pform-err" data-d4-01-provider-name-error>{{ validation.fieldErrors.displayName }}</small>
    </label>
    <label class="mp2-field"><span>API 地址</span>
      <input class="set-input mono" data-d4-01-provider-url aria-label="API 地址" placeholder="https://api.example.com/v1" :value="form.baseUrl" @input="onBaseUrl" />
      <small v-if="attempted && validation.fieldErrors.baseUrl" class="pform-err" data-d4-01-provider-url-error>{{ validation.fieldErrors.baseUrl }}</small>
    </label>
    <div v-if="validation.needsInsecureOptIn" class="mp2-field" data-d4-01-provider-insecure-opt>
      <label class="mp2-insecure">
        <input type="checkbox" data-d4-01-provider-insecure-http aria-label="允许不安全 HTTP（明文直连）" :checked="form.allowInsecureHttp" @change="form.allowInsecureHttp = ($event.target as HTMLInputElement).checked" />
        <span>允许不安全 HTTP（明文直连）</span>
      </label>
      <p class="mp2-insecure-warn" data-d4-01-provider-insecure-warning>{{ PROVIDER_INSECURE_WARNING }}</p>
      <small v-if="attempted && validation.fieldErrors.insecureHttp" class="pform-err" data-d4-01-provider-insecure-error>{{ validation.fieldErrors.insecureHttp }}</small>
    </div>

    <template v-if="isDual">
      <label class="mp2-field"><span>Access Key <small>{{ mode === "edit" ? "替换密钥：只写入系统钥匙串，留空表示不更换" : "只写入系统钥匙串" }}</small></span>
        <input class="set-input mono" data-d4-01-provider-secret-access aria-label="Access Key" type="password" placeholder="ak_..." :value="dualAccess" @input="dualAccess = ($event.target as HTMLInputElement).value" />
      </label>
      <label class="mp2-field"><span>Secret Key <small>与 Access Key 一起提交（组合成一组凭据）</small></span>
        <input class="set-input mono" data-d4-01-provider-secret-key aria-label="Secret Key" type="password" placeholder="sk_..." :value="dualSecret" @input="dualSecret = ($event.target as HTMLInputElement).value" />
      </label>
      <small v-if="attempted && secretError" class="pform-err" data-d4-01-provider-secret-error>{{ secretError }}</small>
    </template>
    <label v-else class="mp2-field"><span>API 密钥 <small>{{ mode === "edit" ? "替换密钥：只写入系统钥匙串，留空表示不更换" : "只写入系统钥匙串" }}</small></span>
      <input class="set-input" data-d4-01-provider-secret aria-label="API 密钥" type="password" :placeholder="secretPlaceholder" :value="form.credentialSecret" @input="form.credentialSecret = ($event.target as HTMLInputElement).value" />
    </label>

    <label class="mp2-field"><span>范围 <small data-d4-01-provider-scope-hint>{{ scopeHint }}</small></span>
      <select class="set-select" data-d4-01-provider-scope aria-label="范围" :disabled="scopeDisabled" :value="form.scope" @change="form.scope = ($event.target as HTMLSelectElement).value">
        <option v-for="o in PROVIDER_SCOPE_OPTIONS" :key="o.id" :value="o.id">{{ o.label }}</option>
      </select>
      <small v-if="attempted && validation.fieldErrors.scope" class="pform-err" data-d4-01-provider-scope-error>{{ validation.fieldErrors.scope }}</small>
    </label>
    <label v-if="mode === 'edit'" class="mp2-field"><span>启用-停用 <small>停用后该服务商下的模型不再被调用</small></span>
      <select class="set-select" data-d4-01-provider-status aria-label="启用状态" :value="form.status" @change="form.status = ($event.target as HTMLSelectElement).value">
        <option v-for="o in PROVIDER_STATUS_OPTIONS" :key="o.id" :value="o.id">{{ o.label }}</option>
      </select>
    </label>
    <p v-if="validation.originChanged" class="pform-hint" data-d4-01-provider-origin-hint>
      API 地址的 origin 变了（{{ form.baseUrl }}）。凭据与 origin 绑定：旧密钥不会自动发往新地址。
      <template v-if="validation.requiresNewCredential">请在「API 密钥」里粘贴新密钥后一起保存；若只改地址不换密钥，保存后调用可能被 ENDPOINT_BLOCKED 拒绝。</template>
      <template v-else>你已填写新密钥，保存时会按新地址重新绑定。</template>
    </p>
    <div class="mp2-actions">
      <DsButton v-if="mode === 'edit'" variant="ghost" size="sm" data-d4-01-provider-cancel @click="emit('cancel')">取消</DsButton>
      <DsButton v-if="mode === 'edit'" variant="primary" size="sm" data-d4-01-provider-save :disabled="off" @click="submit">{{ busy ? "保存中…" : "保存修改" }}</DsButton>
      <DsButton v-else variant="primary" size="sm" data-d4-01-provider-create :disabled="off" @click="submit">添加服务商</DsButton>
    </div>
  </form>
</template>

<style scoped>
.mp2-formset { display: flex; flex-direction: column; gap: 12px; }
.mp2-insecure { display: flex; align-items: center; gap: 8px; font-size: var(--fs-secondary); cursor: pointer; }
.mp2-insecure input { margin: 0; }
.mp2-insecure-warn { margin: 6px 0 0; color: var(--warning-text, #a05a00); font-size: var(--fs-micro); line-height: 1.6; }
.pform-err { color: var(--failed, #ff453a); font-size: var(--fs-micro); line-height: 1.6; }
.pform-hint { margin: 0; color: var(--warning-text, #a05a00); font-size: var(--fs-micro); line-height: 1.6; }
.pform-warn { margin: 0; color: var(--warning-text, #a05a00); font-size: var(--fs-micro); line-height: 1.6; }
/* 预设一排：沿用 .d401-tabs button / .mp2-prov 的既有形状（radius-pill + sunken + hover 提亮），不引入新视觉体系。 */
.mp2-preset-row { display: flex; flex-wrap: wrap; gap: 6px; }
.mp2-preset { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px; border-radius: var(--radius-pill); background: var(--sunken); color: var(--text); font-size: var(--fs-micro); }
.mp2-preset:hover { background: rgb(var(--text-rgb) / 0.1); }
.mp2-preset.on { background: rgb(var(--content-rgb) / var(--content-alpha)); box-shadow: inset 0 0 0 1px var(--line); }
.pform-preset-label { max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pform-preset-pending { font-size: var(--fs-micro); color: var(--warning-text, #a05a00); }
.pform-logo { width: 18px; height: 18px; flex: none; display: grid; place-items: center; color: var(--muted); }
.pform-logo img { display: block; max-width: 18px; max-height: 18px; object-fit: contain; }
.pform-logo-mark { width: 16px; height: 16px; background-color: currentColor; -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat; -webkit-mask-position: center; mask-position: center; -webkit-mask-size: contain; mask-size: contain; }
.mp2-preset-detail { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: var(--radius-md); background: var(--sunken); }
.pform-docs { font-size: var(--fs-micro); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
</style>
