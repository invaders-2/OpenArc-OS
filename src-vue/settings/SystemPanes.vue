<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useShellStore } from "../stores/shell";
import LocalProxyPanel from "./LocalProxyPanel.vue";

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

onMounted(async () => {
  if (["about", "disk", "runtime"].includes(props.pane)) info.value = await window.openarc?.system?.info().catch(() => null);
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
const sample = new Date().toLocaleString("zh-CN", { dateStyle: "full", timeStyle: "short" });
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
        <span class="set-lab">界面语言<small>菜单、按钮、弹窗和系统应用</small></span>
        <div class="segmented text" role="group" aria-label="界面语言">
          <button aria-pressed="true">简体中文</button>
          <button disabled title="英文界面尚未提供">English</button>
        </div>
      </div>
      <div class="setting-row"><span class="set-lab">日期与时间格式<small>示例：{{ sample }}</small></span><span class="set-val">跟随界面语言</span></div>
      <div class="setting-row"><span class="set-lab">时区</span><span class="set-val">{{ tz }}（跟随系统）</span></div>
      <div class="setting-row"><span class="set-lab">项目内容语言<small>项目名、文件和正文不会因为切换界面语言而自动翻译</small></span><span class="set-val">由项目决定</span></div>
    </div>
  </template>

  <!-- 隐私与安全性 -->
  <template v-else-if="pane === 'privacy'">
    <p class="settings-lead">系统权限是整机的安全底线，助理和所有应用都受它约束；应用自己的声明不能绕过这里的限制。</p>
    <div class="set-group">
      <div class="setting-row">
        <span class="set-lab">写操作需要确认<small>助理创建、修改、删除文件或调用有副作用的工具前，都会先请你确认</small></span>
        <span class="badge ok">始终开启</span>
      </div>
      <div class="setting-row">
        <span class="set-lab">天气联网<small>允许「天气」把城市名或经纬度发给 Open-Meteo 查询预报</small></span>
        <button type="button" role="switch" class="switch" :aria-checked="weatherOn" aria-label="天气联网" @click="setWeather(!weatherOn)" />
      </div>
      <div class="setting-row">
        <span class="set-lab">应用与工具权限<small>哪些应用可用、可以调用哪些工具，由「组织」统一授予</small></span>
        <button class="planned-today" @click="shell.activateApp('organization')">打开组织</button>
      </div>
    </div>
    <section class="set-sec">
      <h3>本机记录</h3>
      <div class="set-group">
        <div class="setting-row">
          <span class="set-lab">最近使用的应用<small>应用程序弹窗第一行的记录，只保存在这台电脑</small></span>
          <button class="planned-today" :disabled="recentCleared" @click="clearRecent">{{ recentCleared ? "已清除" : "清除记录" }}</button>
        </div>
      </div>
    </section>
  </template>

  <!-- 网络 -->
  <template v-else-if="pane === 'network'">
    <div class="set-group">
      <div class="setting-row">
        <span class="set-lab">界面联网<small>窗口界面本身不直接访问网络；联网只经后台的固定通道（模型服务商、浏览器、天气）</small></span>
        <span class="badge ok">已隔离</span>
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
      <div class="set-hero-sub">为工作与智能协作打造的桌面系统</div>
    </div>
    <div v-if="info" class="set-group">
      <div class="setting-row"><span class="set-lab">系统版本</span><span class="set-val mono">{{ info.appVersion }}</span></div>
      <div class="setting-row"><span class="set-lab">运行环境</span><span class="set-val mono">Electron {{ info.electron }} · Chromium {{ info.chrome }}</span></div>
      <div class="setting-row"><span class="set-lab">操作系统</span><span class="set-val">{{ platformName }} {{ info.osRelease }} · {{ info.arch }}</span></div>
      <div class="setting-row"><span class="set-lab">处理器与内存</span><span class="set-val">{{ info.cpus }} 核 · {{ GB(info.memory) }}</span></div>
      <div class="setting-row"><span class="set-lab">软件更新<small>更新通道尚未接入</small></span><span class="set-val">—</span></div>
    </div>
    <p v-else class="set-cap">系统信息只在 OpenArc 桌面应用里可用。</p>
  </template>

  <!-- 应用权限 -->
  <template v-else-if="pane === 'apps'">
    <p class="settings-lead">决定哪些应用可用。应用声明的能力只对有权打开它的人生效，实际操作仍受隐私与安全设置约束。</p>
    <p v-if="appsError" class="set-cap">{{ appsError }}</p>
    <div v-else-if="apps" class="set-group">
      <div v-for="a in apps" :key="a.appId" class="setting-row">
        <span class="set-lab">{{ a.name }}<small><code>{{ a.appId }}</code> · 授权 {{ a.grantCount }}</small></span>
        <span class="badge" :class="{ ok: a.status === 'enabled' }">{{ STATUS[a.status] || a.status }}</span>
      </div>
      <p v-if="!apps.length" class="set-cap gov-empty">没有可管理的应用。</p>
    </div>
    <div class="set-sec"><button class="planned-today" @click="shell.activateApp('organization')">在「组织」中管理</button></div>
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
      <section class="set-sec">
        <div class="set-group">
          <div class="setting-row">
            <span class="set-lab">生成任务缓存<small>缓存清理尚未接入；删除文件请用访达或回收站</small></span>
            <span class="set-val">—</span>
          </div>
        </div>
      </section>
    </template>
    <p v-else class="set-cap">磁盘信息只在 OpenArc 桌面应用里可用。</p>
  </template>

  <!-- 本地运行环境 -->
  <template v-else-if="pane === 'runtime'">
    <p class="settings-lead">重任务在本机受监督的子进程里运行。缺少依赖时功能会明确提示，不会用模拟结果代替。</p>
    <div class="set-group">
      <div class="setting-row">
        <span class="set-lab">任务运行时<small>对话、自动化与 Skill 试运行</small></span>
        <span class="badge" :class="{ ok: taskAvail }">{{ taskAvail ? "可用" : "不可用" }}</span>
      </div>
      <div class="setting-row">
        <span class="set-lab">FFmpeg<small>视频剪辑导出</small></span>
        <span v-if="ff?.available" class="badge ok">{{ ff.version }}</span>
        <span v-else class="set-val">{{ ff === null ? "检测中…" : "未安装（brew install ffmpeg）" }}</span>
      </div>
      <div class="setting-row">
        <span class="set-lab">MCP 连接<small>外部工具与数据源</small></span>
        <button class="planned-today" @click="shell.activateApp('mcp-center')">打开 MCP 中心</button>
      </div>
      <div v-if="info" class="setting-row">
        <span class="set-lab">Node.js</span>
        <span class="set-val mono">{{ info.node }}</span>
      </div>
    </div>
  </template>
</template>
