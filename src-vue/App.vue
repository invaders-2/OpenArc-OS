<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch, watchEffect } from "vue";
import { useShellStore } from "./stores/shell";
import { useIdentityStore } from "./stores/identity";
import { installNativeSync } from "./shell/native-sync";
import { installBrowserRuntime } from "./shell/browser-runtime";
import { installAutomationRuntime } from "./automation-runtime";
import { applyCursors } from "../src/desktop/cursors";
import Wallpaper from "./shell/Wallpaper.vue";
import Desktop from "./shell/Desktop.vue";
import WindowLayer from "./shell/WindowLayer.vue";
import Overlays from "./shell/Overlays.vue";
import Dock from "./shell/Dock.vue";
import Launchpad from "./shell/Launchpad.vue";
import AppsPopover from "./shell/AppsPopover.vue";
import AssistPanel from "./shell/AssistPanel.vue";
import ControlCenter from "./shell/ControlCenter.vue";
import QuickLook from "./shell/QuickLook.vue";
import NotificationCenter from "./shell/NotificationCenter.vue";
/* 全局 AI：10-16 起改为 Vue 的助理浮层（shell/AssistPanel.vue），同一条 task 桥，旧 React AIPanel 不再挂载。 */
import { markRaw } from "vue";
import ReactIsland from "./bridge/ReactIsland.vue";
import { ApprovalPrompt } from "../src/approval/ApprovalPrompt";
/**
 * 10-16 · 审批弹窗（D4-03C4 Trusted Approval UI）：既有 React 实现原样复用。
 * 之前只挂在 React 外壳里，Vue 外壳下 AI 的写入类操作（回收站 / 画布编辑 / 打开网址 / 存回资源库）
 * 会一直停在「等待你确认」却看不到弹窗。登录后常驻：没有待批请求时它什么都不渲染。
 */
const ApprovalPromptRaw = markRaw(ApprovalPrompt);
import BootSurface from "./identity/BootSurface.vue";
import BootRetry from "./identity/BootRetry.vue";
import SetupScreen from "./identity/SetupScreen.vue";
import LoginScreen from "./identity/LoginScreen.vue";
import LockScreen from "./identity/LockScreen.vue";
import type { LockWallpaper } from "./identity/LockStageWallpaper.vue";

const shell = useShellStore();
const identity = useIdentityStore();
let disposeSystemTheme: (() => void) | null = null;
let disposeIdentityEvent: (() => void) | null = null;
let disposeNativeSync: (() => void) | null = null;
let disposeAutomation: (() => void) | null = null;
let disposeBrowserRuntime: (() => void) | null = null;

/**
 * 壳根：class 与 data-* 与既有产品逐项一致（src/main.tsx:3274-3282）。
 * 注意 class 字符串里的空格：既有实现用模板字符串拼出来，是 "desktop  "（两个空格）
 * 这种形态；这里保持同形，避免后续按 className 对齐契约时出现假差异。
 */
const rootClass = computed(
  () => "desktop " + (shell.dark ? "dark" : "") + " " + (shell.reduced ? "reduced" : ""),
);

/**
 * 门禁四态（src/main.tsx:3270-3271 的同一条判定）：
 *   checking        → 只画启动态（恢复结果出来前桌面内容根本不存在）
 *   uninitialized   → 初始化向导
 *   unauthenticated → 登录
 *   locked          → 桌面 DOM 保留 + inert + 锁屏覆盖
 *   ready/unavailable → 桌面
 */
const gate = computed(() => identity.phase);
const locked = computed(() => gate.value === "locked");
const showDesktop = computed(
  () => gate.value === "unavailable" || gate.value === "ready" || gate.value === "locked",
);

/**
 * 锁屏/登录壁纸：same 跟随桌面当前壁纸；自定义条目解析成 src/kind/style
 * （与 src/main.tsx:963-973 的 lockWallpaperProp 同义）。
 */
const lockWallpaper = computed<LockWallpaper>(() => {
  const resolved = shell.resolveLockWallpaper();
  const st = resolved.style;
  return {
    id: resolved.id,
    src: resolved.src,
    kind: resolved.kind,
    style: st
      ? { objectFit: st.fit, transform: `scale(${st.zoom}) translate(${st.x}%, ${st.y}%)` }
      : undefined,
  };
});

/**
 * 内置主题色壁纸跟随外观（10-15 按界面原型：「壁纸分浅色与深色两版，切换外观时自动跟随」）。
 * 只在当前壁纸是两张内置主题色之一时切换；自定义壁纸不动。
 */
watch(
  () => shell.dark,
  (dark) => {
    if (shell.wallpaper === "theme-light" || shell.wallpaper === "theme-dark") {
      const next = dark ? "theme-dark" : "theme-light";
      if (shell.wallpaper !== next) shell.setWallpaper(next);
    }
  },
  { immediate: true },
);

/** 自绘光标：与既有产品同一处（src/main.tsx:1732 的 applyCursors）写根上的 CSS 变量。 */
watchEffect(() => {
  applyCursors({ enabled: shell.cursorCustom, size: shell.cursorSize, dark: shell.dark });
});

onMounted(() => {
  shell.loadDesktopState();
  // 只在当前选中的是自定义壁纸时才拉 wallpapers 目录：默认内置壁纸不需要文件 IPC，
  // 避免在未注册 files handler 的探针环境里刷主进程 stderr。设置页打开时另有一次刷新。
  if (shell.wallpaper.startsWith("custom:") || shell.lockWallpaper.startsWith("custom:")) {
    void shell.refreshWallpapers();
  }
  disposeSystemTheme = shell.watchSystemTheme();
  shell.watchHostSize();
  disposeIdentityEvent = identity.subscribe();
  disposeNativeSync = installNativeSync();
  disposeBrowserRuntime = installBrowserRuntime();
  disposeAutomation = installAutomationRuntime((n) => shell.notify(n));
  void identity.boot();
});
onBeforeUnmount(() => {
  if (disposeSystemTheme) disposeSystemTheme();
  if (disposeIdentityEvent) disposeIdentityEvent();
  if (disposeNativeSync) disposeNativeSync();
  if (disposeBrowserRuntime) disposeBrowserRuntime();
  if (disposeAutomation) disposeAutomation();
});
</script>

<template>
  <div
    :class="rootClass"
    :style="shell.rootStyle"
    :data-glass="shell.glass"
    :data-identity-gate="gate"
    :data-wallpaper="shell.wallpaper"
  >
    <Wallpaper />

    <BootRetry
      v-if="gate === 'checking' && identity.bootError"
      :message="identity.bootError"
      @retry="identity.retry()"
    />
    <BootSurface v-else-if="gate === 'checking'" />

    <SetupScreen
      v-else-if="gate === 'uninitialized'"
      :busy="identity.busy"
      :error="identity.error"
      :default-identifier="identity.snapshot.identifier || ''"
      @submit="(input) => identity.initialize(input)"
    />

    <LoginScreen
      v-else-if="gate === 'unauthenticated'"
      :busy="identity.busy"
      :error="identity.error"
      :default-identifier="identity.snapshot.identifier || ''"
      :wallpaper="lockWallpaper"
      @submit="(input) => identity.login(input)"
    />

    <div v-if="showDesktop" class="desktop-surface" :inert="locked ? true : undefined">
      <Desktop />
      <WindowLayer />
      <Dock />
    </div>

    <ControlCenter v-if="showDesktop && shell.controlCenterOpen" />
    <Launchpad v-if="showDesktop && shell.searchOpen" />
    <AppsPopover v-if="showDesktop && shell.appsOpen" />
    <NotificationCenter v-if="showDesktop" />
    <AssistPanel v-if="showDesktop && shell.aiOpen" />
    <QuickLook v-if="showDesktop && shell.quickLookOpen" />
    <ReactIsland v-if="showDesktop" class="approval-island" :component="ApprovalPromptRaw" :props="{}" />
    <Overlays v-if="showDesktop" />

    <LockScreen
      v-if="gate === 'locked'"
      :snapshot="identity.snapshot"
      :busy="identity.busy"
      :error="identity.error"
      :wallpaper="lockWallpaper"
      @unlock="(password) => identity.unlock(password)"
      @logout="identity.logout()"
    />
  </div>
</template>
