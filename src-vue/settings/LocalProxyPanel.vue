<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Globe, RefreshCw, Wifi } from "lucide-vue-next";
import DsBadge from "../design-system/DsBadge.vue";
import DsButton from "../design-system/DsButton.vue";
import DsPageState from "../design-system/DsPageState.vue";
import {
  domainBridge,
  failureText,
  invokeDomain,
  resultFailure,
  resultValue,
  type FailureView,
} from "../bridge/domain";
import { t } from "../i18n";

/**
 * 本机代理（0.6.1 · 设置 › 网络，接既有 desktop:command 的 desktop/proxy/detect）。
 *
 * 默认零出网：只扫描本机回环监听、系统代理与环境变量。
 * 只有用户显式点「连通测试」才带 probe=true 去访问 Google Gemini 模型列表 —— 按钮上写明会出网。
 * 这里不写系统代理配置，也不假装已经接管应用出网。
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

const hasBridge = ref(!!domainBridge(typeof window === "undefined" ? null : window, "desktop"));
const loading = ref(false);
const probing = ref(false);
const error = ref<FailureView | null>(null);
const value = ref<DetectValue | null>(null);

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

onMounted(() => {
  void detect(false);
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

    <!-- 0.6.1：手动代理。按 local-proxy-domain.cjs 的白名单，desktop 域只有 desktop/proxy/detect（只读），
         没有 set / clear 命令；因此这里只展示状态与「未接入」原因，不提供会假装生效的输入。 -->
    <h4 class="proxy-h">{{ t("手动代理") }}</h4>
    <div class="set-group">
      <div class="setting-row">
        <span class="set-lab">{{ t("当前代理来源") }}<small>{{ t("系统代理 / 启动环境 / 本机代理进程，由只读探测汇总") }}</small></span>
        <span class="set-val">{{ candidates.length ? t("检测到 {n} 个候选", { n: candidates.length }) : t("未检测到候选") }}</span>
      </div>
      <div class="setting-row">
        <span class="set-lab">{{ t("手动代理地址") }}<small>{{ t("缺少 desktop/proxy/set 保存命令，本项未接入") }}</small></span>
        <input class="proxy-manual-input" disabled :placeholder="t('未接入：没有保存命令')" :aria-label="t('手动代理地址（未接入）')" />
      </div>
      <div class="setting-row">
        <span class="set-lab">{{ t("保存并生效") }}<small>{{ t("需要主进程新增受控写入命令并处理权限与回滚；当前不存在") }}</small></span>
        <button type="button" class="planned-today" disabled :title="t('主进程未提供 desktop/proxy/set')">{{ t("保存（未接入）") }}</button>
      </div>
      <div class="setting-row">
        <span class="set-lab">{{ t("恢复系统默认") }}<small>{{ t("同样依赖写入命令；当前不可用") }}</small></span>
        <button type="button" class="planned-today" disabled :title="t('主进程未提供 desktop/proxy/clear')">{{ t("恢复（未接入）") }}</button>
      </div>
    </div>
    <p class="set-cap">{{ t("能力清单：读取探测 = 可用（desktop/proxy/detect）；手动配置 / 保存 / 清除 = 不可用。界面不会把地址写进 localStorage 或任何地方，也不会假装已经接管应用出网。") }}</p>

    <DsPageState
      v-if="!hasBridge"
      kind="unavailable"
      :title="t('当前环境没有本机代理探测的桥')"
      :description="t('浏览器预览不提供 desktop:command；请在 OpenArc 桌面应用中打开设置。')"
    />
    <DsPageState v-else-if="error" kind="error" :title="t('代理探测失败')" :description="failureText(error)" :on-action="() => void detect(false)" />
    <template v-else-if="value">
      <div class="set-group">
        <div class="setting-row">
          <span class="set-lab">{{ t("探测目标") }}<small>{{ value.target?.label || t("未登记") }} · {{ value.target?.url || "—" }}</small></span>
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
  width: 220px;
  min-height: 30px;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: rgb(var(--text-rgb) / 0.04);
  color: var(--muted);
  font-size: var(--fs-caption);
}
.proxy-manual-input:disabled { cursor: not-allowed; opacity: 0.75; }
</style>
