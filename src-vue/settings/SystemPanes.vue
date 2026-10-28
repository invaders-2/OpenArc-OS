<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useShellStore } from "../stores/shell";
import DsButton from "../design-system/DsButton.vue";
import LocalProxyPanel from "./LocalProxyPanel.vue";
import { failureText, formatBytes, formatTime, invokeDomain, resultFailure, resultValue, type FailureView } from "../bridge/domain";
import { locale, setLocale, t } from "../i18n";

/**
 * 系统设置的其余分区（10-15 按原型补齐）。原则同其它应用：只显示真实能读到的信息，
 * 后台没有的能力（手动代理、软件更新通道等）如实标注「尚未接入」，不放示例数据。
 */
const props = defineProps<{ pane: "language" | "privacy" | "network" | "about" | "apps" | "disk" | "runtime" }>();
const shell = useShellStore();
const info = ref<any>(null);
const ff = ref<{ available: boolean; version?: string } | null>(null);
const apps = ref<any[] | null>(null);
const appsError = ref("");
/** 平台诊断（0.6.1）：真实数据库 / 迁移 / dxos 数据占用；用于「软件更新」与「缓存」两块。 */
const diagnostics = ref<any>(null);
const diagnosticsError = ref("");

/* ── task-28：系统更新（desktop/update/*，真实检查 / 下载 / 更新源） ───────── */
type UpdateSource = { kind: string; owner: string; repo: string; channel: string; source?: string; updatedAt?: number; error?: string | null };
type UpdateAsset = { name: string; size: number | null; downloadUrl: string; sha256: string | null };
type UpdateCheck = {
  currentVersion?: string;
  source?: { kind?: string; owner?: string; repo?: string; channel?: string; origin?: string };
  checkedAt?: number;
  latest?: { version?: string; tag?: string; name?: string | null; notesUrl?: string | null; publishedAt?: number; assets?: UpdateAsset[] } | null;
  updateAvailable?: boolean;
  downloadAvailable?: boolean;
  installSupported?: boolean;
  note?: string;
};
type UpdateDownload = { version?: string; assetName?: string; bytes?: number; sha256?: string; relativePath?: string; downloadedAt?: number; installed?: boolean; note?: string };
const updateSource = ref<UpdateSource | null>(null);
const updateSourceError = ref<FailureView | null>(null);
const updateFailure = ref<FailureView | null>(null);
const updateNotice = ref("");
const updateBusy = ref<string | null>(null);
const updateCheck = ref<UpdateCheck | null>(null);
const updateDownload = ref<UpdateDownload | null>(null);
const sourceForm = ref({ kind: "github-releases", owner: "", repo: "", channel: "stable" });

async function loadUpdateSource() {
  const reply = await invokeDomain("desktop", "desktop/update/source/get", {});
  const next = resultValue<UpdateSource>(reply);
  if (next) {
    updateSource.value = next;
    updateSourceError.value = null;
    sourceForm.value = {
      kind: next.kind || "github-releases",
      owner: next.owner || "",
      repo: next.repo || "",
      channel: next.channel || "stable",
    };
  } else {
    updateSourceError.value = resultFailure(reply);
  }
}

async function saveUpdateSource() {
  updateBusy.value = "source";
  updateFailure.value = null;
  updateNotice.value = "";
  const reply = await invokeDomain("desktop", "desktop/update/source/set", { ...sourceForm.value });
  updateBusy.value = null;
  if (!resultValue<UpdateSource>(reply)) {
    updateFailure.value = resultFailure(reply);
    return;
  }
  updateNotice.value = t("更新源已保存。");
  await loadUpdateSource();
}

async function checkUpdate() {
  updateBusy.value = "check";
  updateFailure.value = null;
  updateNotice.value = "";
  updateDownload.value = null;
  const reply = await invokeDomain("desktop", "desktop/update/check", {});
  updateBusy.value = null;
  const next = resultValue<UpdateCheck>(reply);
  if (next) {
    updateCheck.value = next;
    updateNotice.value = next.updateAvailable
      ? t("发现新版本 {version}（只检查 / 下载，不自动安装）。", { version: next.latest?.version || "?" })
      : t("当前已是最新版本（{version}）。", { version: next.currentVersion || "?" });
  } else {
    updateFailure.value = resultFailure(reply);
  }
}

async function downloadUpdate(assetName: string) {
  updateBusy.value = "download:" + assetName;
  updateFailure.value = null;
  updateNotice.value = "";
  const reply = await invokeDomain("desktop", "desktop/update/download", { assetName });
  updateBusy.value = null;
  const next = resultValue<UpdateDownload>(reply);
  if (!next) {
    updateFailure.value = resultFailure(reply);
    return;
  }
  updateDownload.value = next;
  updateNotice.value = t("已下载 {name}（{bytes}），未安装。", { name: next.assetName || assetName, bytes: formatBytes(next.bytes) });
}

/* ── task-28：缓存清理（desktop/cache/clear；dryRun 先统计，confirm 才删除） ── */
type CacheResult = {
  dryRun?: boolean;
  freedBytes?: number;
  wouldFreeBytes?: number;
  removedFiles?: number;
  removedDirs?: number;
  roots?: string[];
  skipped?: { path: string; reason: string }[];
  checkedAt?: number;
};
const cacheResult = ref<CacheResult | null>(null);
const cacheFailure = ref<FailureView | null>(null);
const cacheNotice = ref("");
const cacheBusy = ref<string | null>(null);
const cacheConfirmed = ref(false);

async function scanCache() {
  cacheBusy.value = "scan";
  cacheFailure.value = null;
  cacheNotice.value = "";
  const reply = await invokeDomain("desktop", "desktop/cache/clear", { dryRun: true });
  cacheBusy.value = null;
  const next = resultValue<CacheResult>(reply);
  if (next) {
    cacheResult.value = next;
    cacheNotice.value = t("扫描完成：可清理 {bytes}，{files} 个文件；尚未删除任何内容。", { bytes: formatBytes(next.wouldFreeBytes), files: next.removedFiles ?? 0 });
  } else {
    cacheFailure.value = resultFailure(reply);
  }
}

async function clearCache() {
  if (!cacheConfirmed.value) {
    cacheFailure.value = { code: "LOCAL_PROXY_INVALID_INPUT", message: t("请先勾选「我理解会删除这些缓存文件」。") };
    return;
  }
  cacheBusy.value = "clear";
  cacheFailure.value = null;
  cacheNotice.value = "";
  const reply = await invokeDomain("desktop", "desktop/cache/clear", { confirm: true });
  cacheBusy.value = null;
  const next = resultValue<CacheResult>(reply);
  if (next) {
    cacheResult.value = next;
    cacheConfirmed.value = false;
    cacheNotice.value = t("清理完成：释放 {bytes}，删除 {files} 个文件、{dirs} 个目录。", {
      bytes: formatBytes(next.freedBytes),
      files: next.removedFiles ?? 0,
      dirs: next.removedDirs ?? 0,
    });
  } else {
    cacheFailure.value = resultFailure(reply);
  }
}

async function loadDiagnostics() {
  const platform = window.openarc?.platform;
  if (!platform) {
    diagnosticsError.value = "平台诊断桥不可用（浏览器预览）";
    return;
  }
  const reply = await platform.command({ command: "platform/diagnostics/app", payload: {} }).catch(() => null);
  const value = resultValue<any>(reply);
  if (value) {
    diagnostics.value = value;
    diagnosticsError.value = "";
  } else {
    diagnosticsError.value = "平台诊断命令没有返回可用结果";
  }
}

onMounted(async () => {
  if (["about", "disk", "runtime"].includes(props.pane)) info.value = await window.openarc?.system?.info().catch(() => null);
  if (["about", "disk"].includes(props.pane)) await loadDiagnostics();
  if (props.pane === "about") await loadUpdateSource();
  if (props.pane === "disk") await scanCache();
  if (props.pane === "runtime") ff.value = (await window.openarc?.video?.status().catch(() => null)) ?? null;
  if (props.pane === "network") await loadUploadConsent();
  if (props.pane === "apps") {
    const g = (window as any).openarc?.governance;
    if (!g) appsError.value = "组织服务只在 OpenArc 桌面应用里可用。";
    else {
      const r = await g.command({ type: "governance/listApps" }).catch(() => null);
      if (r?.ok) apps.value = r.items;
      else appsError.value = r?.error === "FORBIDDEN" ? "查看应用权限需要管理员身份。" : "暂时读不到应用权限。";
    }
  }
});

const GB = (n: number) => (n / 1024 ** 3).toFixed(n > 100 * 1024 ** 3 ? 0 : 1) + " GB";
const MB = (n: number) => (n > 1024 ** 3 ? GB(n) : (n / 1024 ** 2).toFixed(1) + " MB");
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const sample = computed(() => new Date().toLocaleString(locale.value, { dateStyle: "full", timeStyle: "short" }));
const platformName = computed(() => ({ darwin: "macOS", win32: "Windows", linux: "Linux" })[info.value?.platform as string] ?? info.value?.platform);
const diskUsedPct = computed(() => (info.value?.disk ? (1 - info.value.disk.free / info.value.disk.total) * 100 : 0));
const dataPct = computed(() => (info.value?.disk && info.value?.data ? (info.value.data.used / info.value.disk.total) * 100 : 0));

/* 隐私：天气联网开关与本机使用记录 */
const weatherOn = ref(localStorage.getItem("oa-weather-consent") === "true");
function setWeather(v: boolean) {
  weatherOn.value = v;
  try {
    localStorage.setItem("oa-weather-consent", JSON.stringify(v));
  } catch {
    /* 存储不可用 */
  }
}
const recentCleared = ref(false);
type UploadConsentState = { allowed: boolean; destination: string; retention: string; maxBytes: number; last?: { status: number; at: number } | null };
const uploadConsent = ref<UploadConsentState | null>(null);
const uploadConsentError = ref("");
const uploadConsentBusy = ref(false);
async function loadUploadConsent() {
  const bridge = window.openarc?.uploadConsent;
  if (!bridge) { uploadConsentError.value = "上传授权服务只在 OpenArc 桌面应用里可用。"; return; }
  const reply = await bridge.command({ command: "uploadConsent/get", payload: {} }).catch(() => null);
  if (reply?.ok) { uploadConsent.value = reply.value as UploadConsentState; uploadConsentError.value = ""; }
  else uploadConsentError.value = String(reply?.message || reply?.error || "暂时读不到上传授权状态");
}
async function setUploadConsent(allowed: boolean) {
  const bridge = window.openarc?.uploadConsent;
  if (!bridge || uploadConsentBusy.value) return;
  uploadConsentBusy.value = true;
  uploadConsentError.value = "";
  const reply = await bridge.command({ command: "uploadConsent/set", payload: { allowed } }).catch(() => null);
  uploadConsentBusy.value = false;
  if (reply?.ok) uploadConsent.value = reply.value as UploadConsentState;
  else uploadConsentError.value = String(reply?.message || reply?.error || "上传授权保存失败");
}
function clearRecent() {
  shell.recentLaunch = [];
  try {
    localStorage.removeItem("oa-recent-apps");
  } catch {
    /* 存储不可用 */
  }
  recentCleared.value = true;
}
const taskAvail = !!window.openarc?.task;
const STATUS: Record<string, string> = { enabled: "已启用", disabled: "已停用" };
</script>

<template>
  <!-- 语言与地区 -->
  <template v-if="pane === 'language'">
    <div class="set-group">
      <div class="setting-row">
        <span class="set-lab">{{ t("界面语言") }}<small>{{ t("菜单、按钮、弹窗和系统应用") }}</small></span>
        <div class="segmented text" role="group" :aria-label="t('界面语言')">
          <button :aria-pressed="locale === 'zh-CN'" @click="setLocale('zh-CN')">简体中文</button>
          <button :aria-pressed="locale === 'en-US'" @click="setLocale('en-US')">English</button>
        </div>
      </div>
      <div class="setting-row"><span class="set-lab">{{ t("日期与时间格式") }}<small>{{ t("示例：{sample}", { sample }) }}</small></span><span class="set-val">{{ t("跟随界面语言") }}</span></div>
      <div class="setting-row"><span class="set-lab">{{ t("时区") }}</span><span class="set-val">{{ t("{tz}（跟随系统）", { tz }) }}</span></div>
      <div class="setting-row"><span class="set-lab">{{ t("项目内容语言") }}<small>{{ t("项目名、文件和正文不会因为切换界面语言而自动翻译") }}</small></span><span class="set-val">{{ t("由项目决定") }}</span></div>
    </div>
  </template>

  <!-- 隐私与安全性 -->
  <template v-else-if="pane === 'privacy'">
    <p class="settings-lead">{{ t("系统权限是整机的安全底线，助理和所有应用都受它约束；应用自己的声明不能绕过这里的限制。") }}</p>
    <div class="set-group">
      <div class="setting-row">
        <span class="set-lab">{{ t("写操作需要确认") }}<small>{{ t("助理创建、修改、删除文件或调用有副作用的工具前，都会先请你确认") }}</small></span>
        <span class="badge ok">{{ t("始终开启") }}</span>
      </div>
      <div class="setting-row">
        <span class="set-lab">{{ t("天气联网") }}<small>{{ t("允许「天气」把城市名或经纬度发给 Open-Meteo 查询预报") }}</small></span>
        <button type="button" role="switch" class="switch" :aria-checked="weatherOn" :aria-label="t('天气联网')" @click="setWeather(!weatherOn)" />
      </div>
      <div class="setting-row">
        <span class="set-lab">{{ t("应用与工具权限") }}<small>{{ t("哪些应用可用、可以调用哪些工具，由「组织治理」统一授予") }}</small></span>
        <button class="planned-today" @click="shell.activateApp('organization')">{{ t("打开组织治理") }}</button>
      </div>
    </div>
    <section class="set-sec">
      <h3>{{ t("本机记录") }}</h3>
      <div class="set-group">
        <div class="setting-row">
          <span class="set-lab">{{ t("最近使用的应用") }}<small>{{ t("应用程序弹窗第一行的记录，只保存在这台电脑") }}</small></span>
          <button class="planned-today" :disabled="recentCleared" @click="clearRecent">{{ recentCleared ? t("已清除") : t("清除记录") }}</button>
        </div>
      </div>
    </section>
  </template>

  <!-- 网络 -->
  <template v-else-if="pane === 'network'">
    <div class="set-group">
      <div class="setting-row">
        <span class="set-lab">{{ t("界面联网") }}<small>{{ t("窗口界面本身不直接访问网络；联网只经后台的固定通道（模型服务商、浏览器、天气）") }}</small></span>
        <span class="badge ok">{{ t("已隔离") }}</span>
      </div>
    </div>
    <section class="set-sec" data-upload-consent>
      <h3>{{ t("第三方素材上传") }}</h3>
      <div class="set-group">
        <div class="setting-row">
          <span class="set-lab">{{ t("允许上传到 Litterbox") }}<small>{{ t("仅在你明确开启后，画布或媒体素材才会发送到第三方；模型服务授权不等于图床授权") }}</small></span>
          <button type="button" role="switch" class="switch" :aria-checked="uploadConsent?.allowed === true" :aria-label="t('允许上传到 Litterbox')" :disabled="uploadConsentBusy" data-upload-consent-toggle @click="setUploadConsent(!(uploadConsent?.allowed === true))" />
        </div>
        <div class="setting-row"><span class="set-lab">{{ t("目的地") }}</span><span class="set-val">{{ uploadConsent?.destination || "Litterbox（catbox.moe）" }}</span></div>
        <div class="setting-row"><span class="set-lab">{{ t("保留期与大小限制") }}</span><span class="set-val">{{ uploadConsent?.retention || "24h" }} · {{ formatBytes(uploadConsent?.maxBytes ?? 200 * 1024 * 1024) }}</span></div>
        <div v-if="uploadConsent?.last?.status === 4" class="setting-row" role="alert" data-upload-consent-failed><span class="set-lab">{{ t("最近上传失败") }}<small>{{ t("可检查网络后重试；失败记录不含素材正文、密钥或公开 URL") }}</small></span><span class="badge">{{ t("失败") }}</span></div>
      </div>
      <p v-if="uploadConsentError" class="gov-error" role="alert" data-upload-consent-error>{{ uploadConsentError }}</p>
    </section>
    <!-- 0.6.1：本机代理探测（desktop/proxy/detect；默认零出网，显式 probe 才访问 Google） -->
    <LocalProxyPanel />
  </template>

  <!-- 系统信息 -->
  <template v-else-if="pane === 'about'">
    <div class="about-hero">
      <span class="about-orb" aria-hidden="true" />
      <div class="set-hero-name">OpenArc OS</div>
      <div class="set-hero-sub">{{ t("为工作与智能协作打造的桌面系统") }}</div>
    </div>
    <div v-if="info" class="set-group">
      <div class="setting-row"><span class="set-lab">{{ t("系统版本") }}</span><span class="set-val mono">{{ info.appVersion }}</span></div>
      <div class="setting-row"><span class="set-lab">{{ t("运行环境") }}</span><span class="set-val mono">Electron {{ info.electron }} · Chromium {{ info.chrome }}</span></div>
      <div class="setting-row"><span class="set-lab">{{ t("操作系统") }}</span><span class="set-val">{{ platformName }} {{ info.osRelease }} · {{ info.arch }}</span></div>
      <div class="setting-row"><span class="set-lab">{{ t("处理器与内存") }}</span><span class="set-val">{{ t("{n} 核", { n: info.cpus }) }} · {{ GB(info.memory) }}</span></div>
    </div>
    <p v-else class="set-cap">{{ t("系统信息只在 OpenArc 桌面应用里可用。") }}</p>

    <!-- task-28：软件更新（desktop/update/*）。只检查 / 下载，不静默安装。 -->
    <section class="set-sec" data-system-update>
      <h3>{{ t("软件更新") }}</h3>
      <div class="set-group">
        <div class="setting-row">
          <span class="set-lab">{{ t("当前版本") }}<small>{{ t("来自 system:info 的真实版本") }}</small></span>
          <span class="set-val mono">{{ info?.appVersion || "—" }}</span>
        </div>
        <div class="setting-row">
          <span class="set-lab">{{ t("更新源") }}<small>{{ updateSource ? t("来源：{origin}", { origin: updateSource.source === "file" ? t("本机配置") : t("默认值") }) : t("尚未读取") }}</small></span>
          <span class="set-val mono">{{ updateSource ? updateSource.kind + " · " + updateSource.owner + "/" + updateSource.repo + " · " + updateSource.channel : "—" }}</span>
        </div>
        <div class="setting-row">
          <span class="set-lab">{{ t("检查更新") }}<small>{{ t("只检查远端清单，不上传本机内容；下载后再由你决定是否安装") }}</small></span>
          <DsButton size="sm" variant="secondary" :status="updateBusy === 'check' ? 'loading' : 'idle'" :disabled="updateBusy !== null" data-update-check @click="checkUpdate">{{ t("检查更新") }}</DsButton>
        </div>
        <div class="setting-row">
          <span class="set-lab">{{ t("安装边界") }}<small>{{ t("主进程只下载安装包到 dxos/updates/downloads，不执行、不替换当前应用") }}</small></span>
          <span class="badge">{{ t("不自动安装") }}</span>
        </div>
      </div>
      <p v-if="updateSourceError" class="gov-error" role="alert">{{ failureText(updateSourceError) }}</p>
      <p v-if="updateFailure" class="gov-error" role="alert" :data-update-error="updateFailure.code">{{ failureText(updateFailure) }}<span v-if="updateFailure.detail" class="muted"> · {{ String(updateFailure.detail) }}</span></p>
      <p v-if="updateNotice" class="set-cap" role="status" data-update-notice>{{ updateNotice }}</p>

      <div v-if="updateCheck" class="set-group" data-update-result>
        <div class="setting-row">
          <span class="set-lab">{{ t("远端最新版本") }}</span>
          <span class="set-val">
            <template v-if="updateCheck.latest">{{ updateCheck.latest.version || "—" }}（{{ updateCheck.latest.tag || "—" }}）</template>
            <template v-else>{{ t("远端没有返回版本") }}</template>
            <span class="badge" :class="{ ok: updateCheck.updateAvailable }">{{ updateCheck.updateAvailable ? t("有新版本") : t("已是最新") }}</span>
          </span>
        </div>
        <div v-if="updateCheck.latest?.publishedAt" class="setting-row">
          <span class="set-lab">{{ t("发布时间") }}</span>
          <span class="set-val">{{ formatTime(updateCheck.latest.publishedAt) }}</span>
        </div>
        <div v-if="updateCheck.latest?.notesUrl" class="setting-row">
          <span class="set-lab">{{ t("更新说明") }}</span>
          <a class="set-val update-link" :href="updateCheck.latest.notesUrl" target="_blank" rel="noreferrer">{{ updateCheck.latest.notesUrl }}</a>
        </div>
        <div v-if="updateCheck.latest?.assets?.length" class="setting-row update-assets-row">
          <span class="set-lab">{{ t("可下载的安装包") }}<small>{{ t("下载只写相对目录，文件名由主进程白名单校验") }}</small></span>
          <ul class="update-assets">
            <li v-for="asset in updateCheck.latest.assets" :key="asset.name">
              <span class="mono">{{ asset.name }}</span>
              <span class="muted">{{ asset.size != null ? formatBytes(asset.size) : "—" }}</span>
              <span v-if="asset.sha256" class="muted mono">sha256 {{ asset.sha256.slice(0, 12) }}…</span>
              <DsButton size="sm" variant="ghost" :status="updateBusy === 'download:' + asset.name ? 'loading' : 'idle'" :disabled="updateBusy !== null" data-update-download :data-asset="asset.name" @click="downloadUpdate(asset.name)">{{ t("下载") }}</DsButton>
            </li>
          </ul>
        </div>
        <div v-else class="setting-row">
          <span class="set-lab">{{ t("可下载的安装包") }}</span>
          <span class="set-val">{{ t("远端没有提供安装包") }}</span>
        </div>
        <div v-if="updateDownload" class="setting-row" data-update-download-result>
          <span class="set-lab">{{ t("最近下载") }}</span>
          <span class="set-val">
            {{ updateDownload.assetName }} · {{ formatBytes(updateDownload.bytes) }} ·
            <span class="mono">{{ updateDownload.relativePath }}</span>
            <span class="badge">{{ updateDownload.installed ? t("已安装") : t("未安装") }}</span>
          </span>
        </div>
      </div>

      <h4 class="set-subtitle">{{ t("更新源设置") }}</h4>
      <div class="set-group">
        <div class="setting-row">
          <span class="set-lab">{{ t("来源类型") }}<small>{{ t("github-releases 读 GitHub Releases；modelscope-repo 读仓库内的 updates/system/latest.json") }}</small></span>
          <select v-model="sourceForm.kind" class="set-select" data-update-source-kind>
            <option value="github-releases">github-releases</option>
            <option value="modelscope-repo">modelscope-repo</option>
          </select>
        </div>
        <div class="setting-row">
          <span class="set-lab">{{ t("通道") }}<small>{{ t("stable 排除预发布；beta 包含预发布") }}</small></span>
          <select v-model="sourceForm.channel" class="set-select" data-update-source-channel>
            <option value="stable">stable</option>
            <option value="beta">beta</option>
          </select>
        </div>
        <div class="setting-row">
          <span class="set-lab">owner / repo</span>
          <span class="update-owner-repo">
            <input v-model="sourceForm.owner" class="set-input mono" placeholder="owner" aria-label="更新源 owner" data-update-source-owner />
            <input v-model="sourceForm.repo" class="set-input mono" placeholder="repo" aria-label="更新源 repo" data-update-source-repo />
            <DsButton size="sm" variant="secondary" :status="updateBusy === 'source' ? 'loading' : 'idle'" :disabled="updateBusy !== null" data-update-source-save @click="saveUpdateSource">{{ t("保存更新源") }}</DsButton>
          </span>
        </div>
      </div>
      <p class="set-cap">{{ t("更新源只接受白名单主机与 HTTPS；owner/repo 只能使用字母、数字、点、下划线与短横线。") }}</p>
    </section>
  </template>

  <!-- 应用权限 -->
  <template v-else-if="pane === 'apps'">
    <p class="settings-lead">{{ t("决定哪些应用可用。应用声明的能力只对有权打开它的人生效，实际操作仍受隐私与安全设置约束。") }}</p>
    <p v-if="appsError" class="set-cap">{{ appsError }}</p>
    <div v-else-if="apps" class="set-group">
      <div v-for="a in apps" :key="a.appId" class="setting-row">
        <span class="set-lab">{{ a.name }}<small><code>{{ a.appId }}</code> · 授权 {{ a.grantCount }}</small></span>
        <span class="badge" :class="{ ok: a.status === 'enabled' }">{{ STATUS[a.status] ? t(STATUS[a.status]) : a.status }}</span>
      </div>
      <p v-if="!apps.length" class="set-cap gov-empty">{{ t("没有可管理的应用。") }}</p>
    </div>
    <div class="set-sec"><button class="planned-today" @click="shell.activateApp('organization')">{{ t("在「组织治理」中管理") }}</button></div>
  </template>

  <!-- 磁盘空间 -->
  <template v-else-if="pane === 'disk'">
    <template v-if="info?.disk">
      <div class="disk-head">
        <b>{{ t("已使用 {used} / {total}", { used: GB(info.disk.total - info.disk.free), total: GB(info.disk.total) }) }}</b>
        <span class="set-val">{{ t("可用 {free}", { free: GB(info.disk.free) }) }}</span>
      </div>
      <div class="disk-bar" role="img" :aria-label="t('磁盘已使用 {n}%', { n: Math.round(diskUsedPct) })">
        <i class="disk-oa" :style="{ width: Math.max(0.6, dataPct) + '%' }" />
        <i class="disk-other" :style="{ width: Math.max(0, diskUsedPct - dataPct) + '%' }" />
      </div>
      <div class="disk-legend">
        <span><i class="disk-oa" />{{ t("OpenArc 数据 {size}", { size: MB(info.data.used) }) }}{{ info.data.truncated ? t("（文件过多，只统计了一部分）") : "" }}</span>
        <span><i class="disk-other" />{{ t("其它") }}</span>
      </div>
    </template>
    <p v-else class="set-cap">{{ t("磁盘信息只在 OpenArc 桌面应用里可用。") }}</p>

    <!-- 0.6.1：缓存与数据占用。分类占用来自 platform/diagnostics/app（真实、只读）；
         清理命令在主进程不存在，因此只显示「未接入」，不放可点的假清理。 -->
    <section class="set-sec">
      <h3>{{ t("缓存与数据占用") }}</h3>
      <template v-if="diagnostics?.storage?.available">
        <div class="set-group">
          <div class="setting-row">
            <span class="set-lab">{{ t("OpenArc 数据总量") }}<small>{{ t("dxos 数据目录；只统计字节与文件数，不返回路径") }}</small></span>
            <span class="set-val">{{ MB(diagnostics.storage.totalBytes) }} · {{ t("{n} 个文件", { n: diagnostics.storage.totalFiles }) }}</span>
          </div>
          <div v-for="cat in (diagnostics.storage.categories || []).slice(0, 6)" :key="cat.name" class="setting-row">
            <span class="set-lab">{{ cat.name }}<small>{{ t("{n} 个文件", { n: cat.files }) }}</small></span>
            <span class="set-val">{{ MB(cat.bytes) }}</span>
          </div>
          <div class="setting-row">
            <span class="set-lab">{{ t("数据库") }}<small>{{ diagnostics.database?.fileName || "identity.db" }}</small></span>
            <span class="set-val">{{ diagnostics.database?.available ? (diagnostics.database?.ok ? t("完整") : t("校验失败")) : t("不可用") }} · user_version {{ diagnostics.database?.userVersion ?? "—" }}</span>
          </div>
          <div class="setting-row">
            <span class="set-lab">{{ t("迁移") }}<small>schema {{ diagnostics.migrations?.supported ?? "—" }}</small></span>
            <span class="set-val">{{ diagnostics.migrations?.upToDate ? t("已是最新") : t("有待应用迁移（{n}）", { n: (diagnostics.migrations?.pending || []).length }) }}</span>
          </div>
          <div class="setting-row">
            <span class="set-lab">{{ t("缓存清理") }}<small>{{ t("只扫 dxos 下 cache / temp / tmp；保护凭据、备份、数据库与私钥") }}</small></span>
            <span class="update-actions">
              <DsButton size="sm" variant="ghost" :status="cacheBusy === 'scan' ? 'loading' : 'idle'" :disabled="cacheBusy !== null" data-cache-scan @click="scanCache">{{ t("重新扫描") }}</DsButton>
              <DsButton size="sm" variant="danger" :status="cacheBusy === 'clear' ? 'loading' : 'idle'" :disabled="cacheBusy !== null || !cacheConfirmed" data-cache-clear @click="clearCache">{{ t("清理缓存") }}</DsButton>
            </span>
          </div>
          <div class="setting-row">
            <span class="set-lab">{{ t("清理确认") }}<small>{{ t("删除不可恢复；只有勾选后清理按钮才可用") }}</small></span>
            <label class="update-check">
              <input v-model="cacheConfirmed" type="checkbox" data-cache-confirm />
              {{ t("我理解会删除这些缓存文件") }}
            </label>
          </div>
        </div>
        <p v-if="cacheFailure" class="gov-error" role="alert" :data-cache-error="cacheFailure.code">{{ failureText(cacheFailure) }}<span v-if="cacheFailure.detail" class="muted"> · {{ String(cacheFailure.detail) }}</span></p>
        <p v-if="cacheNotice" class="set-cap" role="status" data-cache-notice>{{ cacheNotice }}</p>
        <div v-if="cacheResult" class="set-group" data-cache-result>
          <div class="setting-row">
            <span class="set-lab">{{ t(cacheResult.dryRun ? "可清理" : "清理前统计") }}</span>
            <span class="set-val">{{ formatBytes(cacheResult.wouldFreeBytes) }} · {{ cacheResult.roots?.length ?? 0 }} {{ t("个缓存目录") }}</span>
          </div>
          <div class="setting-row">
            <span class="set-lab">{{ t("上次清理释放") }}</span>
            <span class="set-val">{{ formatBytes(cacheResult.freedBytes) }} · {{ t("删除 {files} 个文件、{dirs} 个目录", { files: cacheResult.removedFiles ?? 0, dirs: cacheResult.removedDirs ?? 0 }) }}</span>
          </div>
          <div v-if="cacheResult.roots?.length" class="setting-row">
            <span class="set-lab">{{ t("扫描目录") }}</span>
            <span class="set-val mono update-paths">{{ cacheResult.roots.join(" · ") }}</span>
          </div>
          <div v-if="cacheResult.skipped?.length" class="setting-row">
            <span class="set-lab">{{ t("跳过 {n} 项", { n: cacheResult.skipped.length }) }}<small>{{ t("凭据 / 备份 / 数据库 / 私钥 / 符号链接一律不删") }}</small></span>
            <span class="set-val update-paths">{{ cacheResult.skipped.slice(0, 6).map((item) => item.path + "（" + item.reason + "）").join(" · ") }}</span>
          </div>
          <div class="setting-row">
            <span class="set-lab">{{ t("扫描时间") }}</span>
            <span class="set-val">{{ cacheResult.checkedAt ? formatTime(cacheResult.checkedAt) : "—" }}</span>
          </div>
        </div>
        <p class="set-cap">{{ t("口径说明：上方「OpenArc 数据」统计整个 userData（含数据库与其它缓存）；这里按 dxos 数据目录分类拆分，两者数值不同是正常的。") }}</p>
      </template>
      <p v-else class="set-cap">{{ t("平台诊断不可用{detail}；缓存清理命令在主进程不存在。", { detail: diagnosticsError ? "：" + diagnosticsError : "" }) }}</p>
    </section>
  </template>

  <!-- 本地运行环境 -->
  <template v-else-if="pane === 'runtime'">
    <p class="settings-lead">{{ t("重任务在本机受监督的子进程里运行。缺少依赖时功能会明确提示，不会用模拟结果代替。") }}</p>
    <div class="set-group">
      <div class="setting-row">
        <span class="set-lab">{{ t("任务运行时") }}<small>{{ t("对话、自动化与 Skill 试运行") }}</small></span>
        <span class="badge" :class="{ ok: taskAvail }">{{ taskAvail ? t("可用") : t("不可用") }}</span>
      </div>
      <div class="setting-row">
        <span class="set-lab">FFmpeg<small>{{ t("视频剪辑导出") }}</small></span>
        <span v-if="ff?.available" class="badge ok">{{ ff.version }}</span>
        <span v-else class="set-val">{{ ff === null ? t("检测中…") : t("未安装（brew install ffmpeg）") }}</span>
      </div>
      <div class="setting-row">
        <span class="set-lab">{{ t("MCP 连接") }}<small>{{ t("外部工具与数据源") }}</small></span>
        <button class="planned-today" @click="shell.activateApp('mcp-center')">{{ t("打开 MCP 中心") }}</button>
      </div>
      <div v-if="info" class="setting-row">
        <span class="set-lab">Node.js</span>
        <span class="set-val mono">{{ info.node }}</span>
      </div>
    </div>
  </template>
</template>

<style scoped>
.set-subtitle { margin: var(--space-4) 0 var(--space-2); font-size: var(--fs-caption); font-weight: var(--fw-medium); }
.set-select { min-height: 26px; padding: 2px var(--space-2); border: 0; border-radius: var(--radius-md); background: var(--sunken); color: var(--text); font-size: var(--fs-caption); }
.update-assets { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; width: 100%; }
.update-assets li { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; padding: 2px 0; }
.update-link { overflow-wrap: anywhere; }
.update-actions { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.update-check { display: inline-flex; align-items: center; gap: var(--space-1); font-size: var(--fs-caption); color: var(--muted); }
.update-owner-repo { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.update-paths { overflow-wrap: anywhere; max-width: 520px; }
</style>
