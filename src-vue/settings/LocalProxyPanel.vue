<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Globe, RefreshCw, Wifi } from "lucide-vue-next";
import DsBadge from "../design-system/DsBadge.vue";
import DsButton from "../design-system/DsButton.vue";
import DsPageState from "../design-system/DsPageState.vue";
import {
  domainBridge,
  failureText,
  formatTime,
  invokeDomain,
  resultFailure,
  resultValue,
  type FailureView,
} from "../bridge/domain";
import { t } from "../i18n";

/**
 * 本机代理（0.6.1 · 设置 › 网络；task-28 接真实写入能力）。
 *
 * 命令（desktop:command，白名单见 electron/local-proxy-domain.cjs）：
 *   · desktop/proxy/detect  只读扫描（默认零出网；probe=true 才连通测试）
 *   · desktop/proxy/state   读取手动代理配置与"是否已作用到出网层"
 *   · desktop/proxy/set     保存手动代理（仅 http/https、无内嵌凭据）
 *   · desktop/proxy/clear   清除手动代理并恢复直连
 * 说明：模型 / 协议出网是独立开关（模型与服务商 › 模型出网代理），这里不混用。
 */
type Candidate = { url: string; source: string; kind: string };
type ProbeResult = Candidate & { reachable?: boolean; status?: number; latencyMs?: number; error?: string };
type Unavailable = { source: string; reason: string };
type DetectValue = {
  command?: string;
  target?: { id?: string; label?: string; url?: string };
  requiresRestart?: boolean;
  probeEnabled?: boolean;
  timeoutMs?: number;
  loopbackOnly?: boolean;
  candidateCount?: number;
  candidates?: Candidate[];
  probes?: ProbeResult[];
  unavailable?: Unavailable[];
  network?: { attempted?: boolean; reason?: string; url?: string; host?: string; via?: string; probed?: number };
};
type ProxyState = {
  command?: string;
  configured?: boolean;
  url?: string | null;
  enabled?: boolean;
  storage?: string;
  updatedAt?: number | null;
  configError?: string | null;
  applied?: boolean;
  appliedScope?: string;
  applyNote?: string | null;
  applyError?: string | null;
  scopes?: { electronSession?: string; modelEgress?: string };
};

const hasBridge = ref(!!domainBridge(typeof window === "undefined" ? null : window, "desktop"));
const loading = ref(false);
const probing = ref(false);
const error = ref<FailureView | null>(null);
const value = ref<DetectValue | null>(null);

const proxyState = ref<ProxyState | null>(null);
const proxyStateError = ref<FailureView | null>(null);
const manualUrl = ref("");
const manualEnabled = ref(true);
const proxyBusy = ref<string | null>(null);
const proxyFailure = ref<FailureView | null>(null);
const proxyNotice = ref("");
const clearArmed = ref(false);
let clearTimer = 0;

const KIND_TEXT: Record<string, string> = {
  configured: "当前设置",
  env: "启动环境",
  process: "代理进程",
  system: "系统代理",
  lsof: "lsof",
  proc: "进程",
  unknown: "未知来源",
};
const candidates = computed(() => value.value?.candidates ?? []);
const probes = computed(() => value.value?.probes ?? []);
const unavailable = computed(() => value.value?.unavailable ?? []);
const networkAttempted = computed(() => value.value?.network?.attempted === true);

const STORAGE_TEXT: Record<string, string> = {
  safeStorage: "系统安全存储（加密）",
  file: "本机配置文件（明文）",
};
const SCOPE_TEXT: Record<string, string> = {
  "electron-session": "已作用到 Electron 网络会话",
  "registration-only": "仅登记配置（出网层未注入）",
};
const appliedNote = computed(() => {
  const state = proxyState.value;
  if (!state) return "";
  if (state.applyError) return t("应用到出网层失败：{reason}", { reason: state.applyError });
  if (!state.configured) return t("当前没有手动代理配置，应用走直连 / 系统设置。");
  if (!state.enabled) return t("已保存但未启用；当前不接管出网。");
  return state.applyNote || (state.applied ? t("已作用到出网层。") : t("已保存；尚未作用到出网层。"));
});

async function detect(probe = false) {
  if (!hasBridge.value) return;
  if (probe) probing.value = true;
  else loading.value = true;
  error.value = null;
  const reply = await invokeDomain("desktop", "desktop/proxy/detect", probe ? { probe: true } : {});
  loading.value = false;
  probing.value = false;
  const next = resultValue<DetectValue>(reply);
  if (next) value.value = next;
  else error.value = resultFailure(reply);
}

async function loadProxyState() {
  if (!hasBridge.value) return;
  const reply = await invokeDomain("desktop", "desktop/proxy/state", {});
  const next = resultValue<ProxyState>(reply);
  if (next) {
    proxyState.value = next;
    proxyStateError.value = null;
    manualUrl.value = next.url || "";
    manualEnabled.value = next.enabled !== false;
  } else {
    proxyStateError.value = resultFailure(reply);
  }
}

async function saveProxy() {
  const url = manualUrl.value.trim();
  if (!url) {
    proxyFailure.value = { code: "LOCAL_PROXY_INVALID_INPUT", message: t("请填写代理地址，例如 http://127.0.0.1:7890") };
    return;
  }
  proxyBusy.value = "save";
  proxyFailure.value = null;
  proxyNotice.value = "";
  clearArmed.value = false;
  const reply = await invokeDomain("desktop", "desktop/proxy/set", { url, enabled: manualEnabled.value });
  proxyBusy.value = null;
  if (!resultValue<ProxyState>(reply)) {
    proxyFailure.value = resultFailure(reply);
    return;
  }
  proxyNotice.value = t("已保存手动代理；下面的状态与生效范围是主进程返回值。");
  await Promise.all([loadProxyState(), detect(false)]);
}

async function clearProxy() {
  if (!clearArmed.value) {
    clearArmed.value = true;
    window.clearTimeout(clearTimer);
    clearTimer = window.setTimeout(() => (clearArmed.value = false), 4000);
    return;
  }
  window.clearTimeout(clearTimer);
  clearArmed.value = false;
  proxyBusy.value = "clear";
  proxyFailure.value = null;
  proxyNotice.value = "";
  const reply = await invokeDomain("desktop", "desktop/proxy/clear", {});
  proxyBusy.value = null;
  if (!resultValue<ProxyState>(reply)) {
    proxyFailure.value = resultFailure(reply);
    return;
  }
  proxyNotice.value = t("已清除手动代理配置；主进程已尝试恢复直连。");
  await Promise.all([loadProxyState(), detect(false)]);
}

onMounted(() => {
  void Promise.all([detect(false), loadProxyState()]);
});
</script>

<template>
  <section class="set-sec proxy-sec" data-local-proxy>
    <div class="set-sh">
      <h3>{{ t("本机代理") }}</h3>
      <span class="proxy-actions">
        <DsButton size="sm" variant="ghost" :status="loading ? 'loading' : 'idle'" data-proxy-scan @click="detect(false)">
          <RefreshCw :size="13" /> {{ t("重新扫描（不出网）") }}
        </DsButton>
        <DsButton size="sm" variant="secondary" :status="probing ? 'loading' : 'idle'" data-proxy-probe @click="detect(true)">
          <Wifi :size="13" /> {{ t("连通测试（会出网）") }}
        </DsButton>
      </span>
    </div>
    <p class="set-cap">{{ t("默认只在本机扫描回环监听、系统代理与环境变量，不联网。「连通测试」会经候选代理访问 {url}，属于显式出网动作。", { url: value?.target?.url || t("Google Gemini 模型列表") }) }}</p>

    <!-- task-28：手动代理真实保存 / 清除 / 回读。 -->
    <h4 class="proxy-h">{{ t("手动代理") }}</h4>
    <DsPageState
      v-if="!hasBridge"
      kind="unavailable"
      :title="t('当前环境没有本机代理探测的桥')"
      :description="t('浏览器预览不提供 desktop:command；请在 OpenArc 桌面应用中打开设置。')"
    />
    <DsPageState
      v-else-if="proxyStateError"
      kind="error"
      :title="t('读不到手动代理状态')"
      :description="failureText(proxyStateError)"
      :on-action="() => void loadProxyState()"
    />
    <template v-else>
      <div class="set-group">
        <div class="setting-row">
          <span class="set-lab">{{ t("手动代理地址") }}<small>{{ t("只接受 http / https，且不能带账号密码；保存后主进程会尝试应用到出网层") }}</small></span>
          <input
            v-model="manualUrl"
            class="proxy-manual-input mono"
            type="text"
            inputmode="url"
            spellcheck="false"
            placeholder="http://127.0.0.1:7890"
            :aria-label="t('手动代理地址')"
            :disabled="proxyBusy !== null"
            data-proxy-manual-url
          />
        </div>
        <div class="setting-row">
          <span class="set-lab">{{ t("启用手动代理") }}<small>{{ t("关闭后配置保留但不接管出网") }}</small></span>
          <button
            type="button"
            role="switch"
            class="switch"
            :aria-checked="manualEnabled"
            :aria-label="t('启用手动代理')"
            :disabled="proxyBusy !== null"
            data-proxy-manual-enabled
            @click="manualEnabled = !manualEnabled"
          />
        </div>
        <div class="setting-row">
          <span class="set-lab">{{ t("保存与清除") }}<small>{{ t("保存写入主进程配置；清除会删除配置并恢复直连（需要二次确认）") }}</small></span>
          <span class="proxy-actions">
            <DsButton size="sm" variant="primary" :status="proxyBusy === 'save' ? 'loading' : 'idle'" :disabled="proxyBusy !== null" data-proxy-manual-save @click="saveProxy">{{ t("保存手动代理") }}</DsButton>
            <DsButton
              size="sm"
              :variant="clearArmed ? 'danger' : 'ghost'"
              :status="proxyBusy === 'clear' ? 'loading' : 'idle'"
              :disabled="proxyBusy !== null"
              data-proxy-manual-clear
              @click="clearProxy"
            >{{ clearArmed ? t("确认清除？") : t("清除手动代理") }}</DsButton>
          </span>
        </div>
      </div>
      <p v-if="proxyFailure" class="proxy-error" role="alert" :data-proxy-error="proxyFailure.code">{{ failureText(proxyFailure) }}<span v-if="proxyFailure.detail" class="proxy-detail"> · {{ String(proxyFailure.detail) }}</span></p>
      <p v-if="proxyNotice" class="proxy-note" role="status">{{ proxyNotice }}</p>

      <div v-if="proxyState" class="set-group">
        <div class="setting-row">
          <span class="set-lab">{{ t("配置状态") }}</span>
          <span class="proxy-actions">
            <DsBadge :tone="proxyState.configured ? 'success' : 'neutral'">{{ proxyState.configured ? t("已配置") : t("未配置") }}</DsBadge>
            <DsBadge v-if="proxyState.configured" :tone="proxyState.enabled ? 'success' : 'warning'">{{ proxyState.enabled ? t("已启用") : t("未启用") }}</DsBadge>
          </span>
        </div>
        <div class="setting-row">
          <span class="set-lab">{{ t("保存的地址") }}</span>
          <span class="set-val mono">{{ proxyState.url || "—" }}</span>
        </div>
        <div class="setting-row">
          <span class="set-lab">{{ t("存储方式") }}</span>
          <span class="set-val">{{ proxyState.storage ? t(STORAGE_TEXT[proxyState.storage] || proxyState.storage) : "—" }}</span>
        </div>
        <div class="setting-row">
          <span class="set-lab">{{ t("应用到出网层") }}<small>{{ t("由主进程返回 applied 与作用范围；仅登记时会如实标注") }}</small></span>
          <span class="set-val">{{ proxyState.applied ? t("已生效") + " · " + (proxyState.appliedScope ? t(SCOPE_TEXT[proxyState.appliedScope] || proxyState.appliedScope) : "—") : t("未生效") }}</span>
        </div>
        <div class="setting-row">
          <span class="set-lab">{{ t("生效说明") }}</span>
          <span class="set-val">{{ appliedNote }}</span>
        </div>
        <div class="setting-row">
          <span class="set-lab">{{ t("最近更新") }}</span>
          <span class="set-val">{{ proxyState.updatedAt ? formatTime(proxyState.updatedAt) : "—" }}</span>
        </div>
        <div v-if="proxyState.configError" class="setting-row">
          <span class="set-lab">{{ t("配置错误") }}</span>
          <span class="set-val proxy-error">{{ proxyState.configError }}</span>
        </div>
      </div>
      <p class="set-cap">{{ t("模型 / 协议出网是独立开关，不在这里修改：它只在「模型与服务商 › 模型出网代理」里保存（model/proxy/set）。") }}</p>
    </template>

    <DsPageState v-if="error" kind="error" :title="t('代理探测失败')" :description="failureText(error)" :on-action="() => void detect(false)" />
    <template v-else-if="value">
      <h4 class="proxy-h">{{ t("只读探测") }}</h4>
      <div class="set-group">
        <div class="setting-row">
          <span class="set-lab">{{ t("探测目标") }}<small>{{ value.target?.label ? t(value.target.label) : t("未登记") }} · {{ value.target?.url || "—" }}</small></span>
          <span class="set-val mono">{{ value.target?.id || "—" }}</span>
        </div>
        <div class="setting-row">
          <span class="set-lab">{{ t("扫描范围") }}<small>{{ t("只扫回环地址，不枚举其它进程") }}</small></span>
          <span class="set-val">{{ value.loopbackOnly ? t("本机回环") : "—" }}</span>
        </div>
        <div class="setting-row">
          <span class="set-lab">{{ t("这次是否出网") }}</span>
          <DsBadge :tone="networkAttempted ? 'warning' : 'neutral'">{{ networkAttempted ? t("已出网（显式 probe）") : t("未出网") }}</DsBadge>
        </div>
        <div class="setting-row">
          <span class="set-lab">{{ t("生效方式") }}</span>
          <span class="set-val">{{ value.requiresRestart ? t("探测结果只作诊断，改动需要在系统里设置后才生效") : "—" }}</span>
        </div>
      </div>

      <h4 class="proxy-h">{{ t("发现的本机代理（{n}）", { n: candidates.length }) }}</h4>
      <DsPageState
        v-if="!candidates.length"
        kind="empty"
        :title="t('没有发现本机代理')"
        :description="t('系统代理、HTTPS_PROXY 环境变量与常见代理进程（mihomo / clash / v2ray 等）都没有返回候选；界面不会编造一个可用的代理。')"
      />
      <ul v-else class="proxy-rows">
        <li v-for="candidate in candidates" :key="candidate.url" class="proxy-row" :data-proxy-candidate="candidate.url">
          <span class="mono proxy-url">{{ candidate.url }}</span>
          <DsBadge size="sm">{{ KIND_TEXT[candidate.kind] ? t(KIND_TEXT[candidate.kind]) : candidate.kind }}</DsBadge>
          <span class="proxy-source">{{ candidate.source }}</span>
        </li>
      </ul>

      <template v-if="networkAttempted">
        <h4 class="proxy-h">{{ t("连通测试结果（{n}）", { n: probes.length }) }}</h4>
        <ul v-if="probes.length" class="proxy-rows">
          <li v-for="probe in probes" :key="probe.url" class="proxy-row" :data-proxy-probe="probe.url">
            <span class="mono proxy-url">{{ probe.url }}</span>
            <DsBadge size="sm" :tone="probe.reachable ? 'success' : 'warning'">{{ probe.reachable ? t("可达") : t("不可达") }}</DsBadge>
            <span class="proxy-source">
              <template v-if="probe.reachable">HTTP {{ probe.status ?? "?" }} · {{ probe.latencyMs ?? "?" }} ms</template>
              <template v-else>{{ probe.error || t("连接失败") }}</template>
            </span>
          </li>
        </ul>
        <p v-else class="set-cap">{{ t("没有候选可测试；因此这次没有发出任何请求。") }}</p>
      </template>

      <template v-if="unavailable.length">
        <h4 class="proxy-h">{{ t("不可用的探测来源（{n}）", { n: unavailable.length }) }}</h4>
        <ul class="proxy-rows">
          <li v-for="item in unavailable" :key="item.source" class="proxy-row">
            <Globe :size="14" />
            <span class="proxy-source">{{ item.source }}：{{ item.reason }}</span>
          </li>
        </ul>
      </template>

      <p class="set-cap">{{ t("这里只做诊断，不修改系统代理、也不接管应用出网；候选来自当前设置 / 启动环境 / 系统代理 / 代理进程，结果不保证重启后仍然存在。") }}</p>
    </template>
    <DsPageState v-else kind="loading" :title="t('正在扫描本机代理')" :description="t('只读本机回环监听与系统设置，不联网。')" />
  </section>
</template>

<style scoped>
.proxy-sec .set-sh { align-items: center; }
.proxy-actions { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.proxy-h { margin: var(--space-4) 0 var(--space-2); font-size: var(--fs-caption); font-weight: var(--fw-medium); }
.proxy-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
.proxy-row { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; padding: var(--space-2); border-radius: var(--radius-sm); background: rgb(var(--text-rgb) / 0.03); }
.proxy-url { font-size: var(--fs-caption); overflow-wrap: anywhere; }
.proxy-source { font-size: var(--fs-micro); color: var(--muted); flex: 1 1 200px; overflow-wrap: anywhere; }
.proxy-manual-input {
  width: 240px;
  min-height: 30px;
  padding: var(--space-1) var(--space-2);
  border: 0;
  border-radius: var(--radius-md);
  background: var(--sunken);
  color: var(--text);
  font-size: var(--fs-caption);
}
.proxy-manual-input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.proxy-note { margin: var(--space-2) 0 0; font-size: var(--fs-caption); color: var(--muted); }
.proxy-error { margin: var(--space-2) 0 0; color: var(--failed); font-size: var(--fs-caption); }
.proxy-detail { color: var(--muted); }
</style>
