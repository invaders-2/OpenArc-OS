<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useShellStore } from "../stores/shell";
import LocalProxyPanel from "./LocalProxyPanel.vue";
import { resultValue } from "../bridge/domain";
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
  if (props.pane === "runtime") ff.value = (await window.openarc?.video?.status().catch(() => null)) ?? null;
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
        <span class="set-lab">{{ t("应用与工具权限") }}<small>{{ t("哪些应用可用、可以调用哪些工具，由「组织」统一授予") }}</small></span>
        <button class="planned-today" @click="shell.activateApp('organization')">{{ t("打开组织") }}</button>
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
      <div class="setting-row"><span class="set-lab">{{ t("处理器与内存") }}</span><span class="set-val">{{ info.cpus }} 核 · {{ GB(info.memory) }}</span></div>
    </div>
    <p v-else class="set-cap">{{ t("系统信息只在 OpenArc 桌面应用里可用。") }}</p>

    <!-- 0.6.1：软件更新。真实状态只有版本信息；系统更新命令在主进程不存在，不提供假“检查更新”。 -->
    <section class="set-sec">
      <h3>{{ t("软件更新") }}</h3>
      <div class="set-group">
        <div class="setting-row">
          <span class="set-lab">{{ t("当前版本") }}<small>{{ t("来自 system:info 的真实版本") }}</small></span>
          <span class="set-val mono">{{ info?.appVersion || "—" }}</span>
        </div>
        <div class="setting-row">
          <span class="set-lab">{{ t("系统更新通道") }}<small>{{ t("平台域白名单没有系统更新命令；没有远端清单、验签与安装链路") }}</small></span>
          <span class="badge">{{ t("未接入") }}</span>
        </div>
        <div class="setting-row">
          <span class="set-lab">{{ t("检查更新") }}<small>{{ t("缺少主进程更新命令，按钮不可用（不会显示虚构的新版本）") }}</small></span>
          <button type="button" class="planned-today" disabled :title="t('主进程未提供系统更新命令')">{{ t("检查更新（未接入）") }}</button>
        </div>
        <div class="setting-row">
          <span class="set-lab">{{ t("应用更新") }}<small>{{ t("已接入：应用市场按 appId 的更新通道（本期只有画布可加载更新包）") }}</small></span>
          <button type="button" class="planned-today" @click="shell.activateApp('market')">{{ t("打开应用市场") }}</button>
        </div>
      </div>
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
    <div class="set-sec"><button class="planned-today" @click="shell.activateApp('organization')">{{ t("在「组织」中管理") }}</button></div>
  </template>

  <!-- 磁盘空间 -->
  <template v-else-if="pane === 'disk'">
    <template v-if="info?.disk">
      <div class="disk-head">
        <b>已使用 {{ GB(info.disk.total - info.disk.free) }} / {{ GB(info.disk.total) }}</b>
        <span class="set-val">可用 {{ GB(info.disk.free) }}</span>
      </div>
      <div class="disk-bar" role="img" :aria-label="'磁盘已使用 ' + Math.round(diskUsedPct) + '%'">
        <i class="disk-oa" :style="{ width: Math.max(0.6, dataPct) + '%' }" />
        <i class="disk-other" :style="{ width: Math.max(0, diskUsedPct - dataPct) + '%' }" />
      </div>
      <div class="disk-legend">
        <span><i class="disk-oa" />OpenArc 数据 {{ MB(info.data.used) }}{{ info.data.truncated ? "（文件过多，只统计了一部分）" : "" }}</span>
        <span><i class="disk-other" />其它</span>
      </div>
    </template>
    <p v-else class="set-cap">磁盘信息只在 OpenArc 桌面应用里可用。</p>

    <!-- 0.6.1：缓存与数据占用。分类占用来自 platform/diagnostics/app（真实、只读）；
         清理命令在主进程不存在，因此只显示「未接入」，不放可点的假清理。 -->
    <section class="set-sec">
      <h3>{{ t("缓存与数据占用") }}</h3>
      <template v-if="diagnostics?.storage?.available">
        <div class="set-group">
          <div class="setting-row">
            <span class="set-lab">{{ t("OpenArc 数据总量") }}<small>{{ t("dxos 数据目录；只统计字节与文件数，不返回路径") }}</small></span>
            <span class="set-val">{{ MB(diagnostics.storage.totalBytes) }} · {{ diagnostics.storage.totalFiles }} 个文件</span>
          </div>
          <div v-for="cat in (diagnostics.storage.categories || []).slice(0, 6)" :key="cat.name" class="setting-row">
            <span class="set-lab">{{ cat.name }}<small>{{ t("{n} 个文件", { n: cat.files }) }}</small></span>
            <span class="set-val">{{ MB(cat.bytes) }}</span>
          </div>
          <div class="setting-row">
            <span class="set-lab">{{ t("数据库") }}<small>{{ diagnostics.database?.fileName || "identity.db" }}</small></span>
            <span class="set-val">{{ diagnostics.database?.available ? (diagnostics.database?.ok ? "完整" : "校验失败") : "不可用" }} · user_version {{ diagnostics.database?.userVersion ?? "—" }}</span>
          </div>
          <div class="setting-row">
            <span class="set-lab">{{ t("迁移") }}<small>schema {{ diagnostics.migrations?.supported ?? "—" }}</small></span>
            <span class="set-val">{{ diagnostics.migrations?.upToDate ? "已是最新" : "有待应用迁移（" + (diagnostics.migrations?.pending || []).length + "）" }}</span>
          </div>
          <div class="setting-row">
            <span class="set-lab">{{ t("清理缓存") }}<small>{{ t("主进程只有只读统计，没有受控清理命令；不会假装清理") }}</small></span>
            <button type="button" class="planned-today" disabled :title="t('主进程未提供缓存清理命令')">{{ t("清理（未接入）") }}</button>
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
