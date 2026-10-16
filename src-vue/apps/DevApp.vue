<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Trash2 } from "lucide-vue-next";
import { appById } from "../apps";
import { devlog } from "../devlog";
import { useShellStore } from "../stores/shell";

/**
 * 开发者（10-15）：只展示**本机真实可读**的信息，不放演示数据。
 *   · 运行环境：UA 里的 Electron / Chromium 版本、平台、CPU 线程、屏幕、JS 堆；
 *   · 窗口：壳层窗口域的实时状态（id / 应用 / 几何 / 层级 / 可见）；
 *   · 日志：启动以来渲染进程的错误、警告与未处理拒绝（devlog.ts）。
 */
const shell = useShellStore();
const tab = ref<"env" | "windows" | "logs">("env");
const tick = ref(0);
let timer = 0;
onMounted(() => (timer = window.setInterval(() => (tick.value += 1), 2000)));
onBeforeUnmount(() => window.clearInterval(timer));

const ua = navigator.userAgent;
const ver = (name: string) => ua.match(new RegExp(name + "/([\\d.]+)"))?.[1] ?? "—";
const env = computed(() => {
  void tick.value;
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  const mb = (n: number) => (n / 1048576).toFixed(0) + " MB";
  return [
    ["Electron", ver("Electron")],
    ["Chromium", ver("Chrome")],
    ["平台", (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform],
    ["CPU 线程", String(navigator.hardwareConcurrency ?? "—")],
    ["屏幕", `${screen.width} × ${screen.height} @${window.devicePixelRatio}x`],
    ["窗口区域", `${window.innerWidth} × ${window.innerHeight}`],
    ["语言", navigator.language],
    ["JS 堆", mem ? `${mb(mem.usedJSHeapSize)} / ${mb(mem.jsHeapSizeLimit)}` : "—"],
    ["原生桥", window.openarc ? "已连接（preload）" : "未连接（浏览器预览）"],
    ["运行时长", `${Math.round(performance.now() / 60000)} 分钟`],
  ];
});
const logs = computed(() => [...devlog.items].reverse());
const time = (t: number) => new Date(t).toLocaleTimeString("zh-CN", { hour12: false });
const TABS = [
  ["env", "本地运行环境"],
  ["windows", "窗口"],
  ["logs", "日志"],
] as const;
</script>

<template>
  <div class="split planned-app dev-app">
    <nav class="split-side" aria-label="开发者">
      <div class="split-section">开发者</div>
      <button
        v-for="[id, label] in TABS"
        :key="id"
        type="button"
        class="split-nav"
        :aria-current="tab === id ? 'true' : undefined"
        @click="tab = id"
      >
        <span class="split-nav-label">{{ label }}</span>
        <small v-if="id === 'windows'" class="planned-count">{{ shell.windows.length }}</small>
        <small v-if="id === 'logs'" class="planned-count">{{ devlog.items.length }}</small>
      </button>
    </nav>
    <div class="split-main dev-main">
      <div class="pane-toolbar">
        <strong class="pane-title">{{ TABS.find((t) => t[0] === tab)?.[1] }}</strong>
        <div class="toolbar-spacer" />
        <button v-if="tab === 'logs' && devlog.items.length" class="icon-button" aria-label="清空日志" title="清空日志" @click="devlog.items.splice(0)">
          <Trash2 :size="14" />
        </button>
      </div>

      <dl v-if="tab === 'env'" class="dev-kv">
        <template v-for="[k, v] in env" :key="k">
          <dt>{{ k }}</dt>
          <dd>{{ v }}</dd>
        </template>
      </dl>

      <div v-else-if="tab === 'windows'" class="dev-table">
        <div class="dev-tr dev-th"><span>应用</span><span>ID</span><span>位置</span><span>尺寸</span><span>层级</span><span>状态</span></div>
        <div v-for="w in shell.windows" :key="w.id" class="dev-tr" :class="{ focused: w.id === shell.focusedWindowId }">
          <span>{{ appById(w.appId)?.name ?? w.appId }}</span>
          <span class="mono">{{ w.id }}</span>
          <span class="mono">{{ Math.round(w.bounds.x) }}, {{ Math.round(w.bounds.y) }}</span>
          <span class="mono">{{ Math.round(w.bounds.w) }} × {{ Math.round(w.bounds.h) }}</span>
          <span class="mono">{{ w.z }}</span>
          <span>{{ !w.visible ? "已最小化" : w.maximized ? "最大化" : w.id === shell.focusedWindowId ? "聚焦" : "可见" }}</span>
        </div>
      </div>

      <div v-else class="dev-logs">
        <p v-if="!logs.length" class="planned-note">启动以来没有错误或警告。</p>
        <div v-for="(l, i) in logs" :key="i" class="dev-log" :data-level="l.level">
          <span class="mono dev-log-t">{{ time(l.t) }}</span>
          <span class="dev-log-lv">{{ { error: "错误", warn: "警告", reject: "拒绝" }[l.level] }}</span>
          <pre class="mono dev-log-msg">{{ l.msg }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>
