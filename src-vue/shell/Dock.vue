<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { iconUrl } from "../apps";
import { useShellStore } from "../stores/shell";
import Orb from "./Orb.vue";
import { installDockMagnify } from "./dock-magnify";

const shell = useShellStore();
const dockEl = ref<HTMLElement | null>(null);

/**
 * 最大化时程序坞自动隐藏（与 React \`src/main.tsx\` anyMaximized / dockPeek 同义）：
 * 最大化窗口铺到屏幕底边，程序坞不再压在内容上；指针碰到屏幕底边 8px 再唤出，离开后收回。
 */
const anyMaximized = computed(() => shell.windows.some((w) => w.maximized && w.visible));
const peek = ref(false);
watch(anyMaximized, (v) => {
  if (!v) peek.value = false;
});
const hidden = computed(() => anyMaximized.value && !peek.value);

/**
 * 鱼眼放大（10-15 按原型补齐）：与 React 版同一套算法（dock-magnify.ts）。
 * 成员 / 顺序 / 图标尺寸变化时重新测量；减少动态效果时整套关闭。
 */
let uninstall: (() => void) | null = null;
const signature = computed(
  () => shell.mainDockApps.map((a) => a.id).join(",") + "|" + shell.dockSize + "|" + !!shell.trashApp,
);
function reinstall() {
  uninstall?.();
  uninstall = dockEl.value ? installDockMagnify(dockEl.value, shell.reduced) : null;
}
onMounted(() => {
  reinstall();
  void shell.refreshTrashState();
});
watch([signature, () => shell.reduced], () => nextTick(reinstall));
onBeforeUnmount(() => uninstall?.());

/**
 * 回收站空桶 / 满桶：既有产品由真实存储内容决定（\`trashHasContent\`），本阶段不接 IPC，
 * 因此用同一语义的**本地投影** \`oa-folder-trash\`（既有产品也写这个键）来判断。
 */
const trashIcon = computed(() => {
  if (shell.trashFull) return "trash-full";
  try {
    const raw = JSON.parse(localStorage.getItem("oa-folder-trash") || "[]");
    return Array.isArray(raw) && raw.length ? "trash-full" : "trash";
  } catch {
    return "trash";
  }
});

/**
 * 程序坞（既有产品 src/desktop/components.tsx:379 的 Dock / DockItem / DockTooltip）。
 *
 * 条目来自应用注册表 + oa-dock（与既有产品同一个键）：左侧是应用，中间是分隔线，
 * 分隔线右侧依次是"全局 AI"与回收站。底板两层（阴影在下、玻璃在上）也照搬 ——
 * 它们是既有 styles.css 的 .dock-shadow / .dock-glass，不自己画。
 */
</script>

<template>
  <div v-if="hidden" class="dock-hint" aria-hidden="true" @pointerenter="peek = true" />
  <nav ref="dockEl" class="dock" :class="{ hidden }" aria-label="应用栏" @pointerleave="peek = false">
    <span class="dock-shadow" aria-hidden="true" />
    <span class="dock-glass" aria-hidden="true" />

    <button
      v-for="app in shell.mainDockApps"
      :key="app.id"
      class="dock-item"
      :aria-label="'打开' + app.name"
      :data-dock-id="app.id"
      @click="shell.activateApp(app.id)"
    >
      <img class="dock-icon" :src="iconUrl(app.icon)" alt="" draggable="false" />
      <span class="dock-tooltip" aria-hidden="true">{{ app.name }}</span>
      <span class="running-dot" :class="{ running: shell.runningApps.has(app.id) }" />
    </button>

    <div class="dock-divider" />

    <button class="dock-item" aria-label="打开全局 AI" @click="shell.toggleAI()">
      <Orb class="dock-icon" :size="shell.dockSize" :animated="!shell.reduced" />
      <span class="dock-tooltip" aria-hidden="true">全局 AI</span>
      <span class="running-dot" />
    </button>

    <button
      v-if="shell.trashApp"
      class="dock-item"
      aria-label="打开回收站"
      @click="shell.activateApp('trash')"
    >
      <img class="dock-icon" :src="iconUrl(trashIcon)" alt="" draggable="false" />
      <span class="dock-tooltip" aria-hidden="true">回收站</span>
      <span class="running-dot" :class="{ running: shell.runningApps.has('trash') }" />
    </button>
  </nav>
</template>
