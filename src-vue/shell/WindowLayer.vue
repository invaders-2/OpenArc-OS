<script setup lang="ts">
import { useShellStore, type ShellWindow } from "../stores/shell";
import { useIdentityStore } from "../stores/identity";
import SettingsContent from "../settings/SettingsContent.vue";
import FilesApp from "../apps/FilesApp.vue";
import ResourceLibraryApp from "../apps/ResourceLibraryApp.vue";
import McpCenter from "../apps/McpCenter.vue";
import SkillsApp from "../apps/SkillsApp.vue";
import ProjectsApp from "../apps/ProjectsApp.vue";
import GovernanceApp from "../apps/GovernanceApp.vue";
import TrashApp from "../apps/TrashApp.vue";
import HomeApp from "../apps/HomeApp.vue";
import PlannedApp from "../apps/PlannedApp.vue";
import NotesApp from "../apps/NotesApp.vue";
import MusicApp from "../apps/MusicApp.vue";
import CalendarApp from "../apps/CalendarApp.vue";
import DevApp from "../apps/DevApp.vue";
import ChatApp from "../apps/ChatApp.vue";
import AutomationApp from "../apps/AutomationApp.vue";
import MarketApp from "../apps/MarketApp.vue";
import WeatherApp from "../apps/WeatherApp.vue";
import VideoApp from "../apps/VideoApp.vue";
import DeclareApp from "../apps/DeclareApp.vue";
import DramaApp from "../apps/DramaApp.vue";
import { markRaw, toRaw } from "vue";
import ReactIsland from "../bridge/ReactIsland.vue";
import { CanvasHost } from "../../src/canvas/CanvasHost";
import { BrowserApp } from "../../src/browser/BrowserApp";
import {
  browserCommand,
  browserRuntime,
  dismissNotice,
  nativeVisibleOf,
  reportViewportReserve,
  snapshotsOf,
} from "./browser-runtime";

/**
 * 浏览器 = 既有 React BrowserApp 原样复用（标签栏 / 地址栏 / 提示 / 下载面板 / 原生视口）。
 * 运行期事实来自 browser-runtime.ts，窗口与标签状态仍只在窗口域；原生视图由主进程按意图管理。
 */
const BrowserAppRaw = markRaw(BrowserApp);
function browserProps(id: string) {
  const win = toRaw(shell.model).windows.find((w) => w.id === id);
  return {
    win,
    runtime: browserRuntime.runtime,
    downloads: browserRuntime.downloads,
    notices: browserRuntime.notices,
    nativeVisible: nativeVisibleOf(id),
    onCommand: (c: any) => shell.dispatch(c),
    onNavigate: (tabId: string, url: string) => void window.openarc?.navigate?.(id, url, tabId),
    onAction: (tabId: string, action: string) => void window.openarc?.action?.(id, action, tabId),
    onBrowser: browserCommand,
    onDismissNotice: dismissNotice,
    onPanelOpenChange: (open: boolean) => (browserRuntime.panelOpen = open),
    onViewportReserve: reportViewportReserve,
  };
}

/** AI Studio = 既有 NOVAI 画布宿主（React 原样复用，见 bridge/ReactIsland.vue）。 */
const CanvasHostRaw = markRaw(CanvasHost);
function canvasProps(id: string) {
  const win = toRaw(shell.model).windows.find((w) => w.id === id);
  return {
    win,
    onOpenModelSettings: () => {
      shell.requestModelSettings();
      shell.activateApp("settings");
    },
  };
}

const shell = useShellStore();
const identity = useIdentityStore();

/**
 * 窗口层（既有产品 src/desktop/components.tsx:552 的 Window / TitleBar）。
 *
 * 关键契约：.window 的几何写在 left/top/width/height 上、层级 = 10 + z，
 * .window-title 里**没有标题文字**，只有 .traffic 三个按钮 —— 标题只在 aria-label 上。
 * 这些都与既有实现逐项一致（168 个 data-* 契约后续要按同一套 DOM 对齐）。
 */
/**
 * 拖动 / 缩放（10-15 补齐：Vue 壳层此前没有接手势）。与 React 同口径
 * （src/desktop/components.tsx 的 startDrag / startResize / trackPointer）：
 * 位移在这里算、clamp 在窗口域里做；监听挂在 window 上，指针离开标题栏也不断手。
 */
const INTERACTIVE = "button,input,select,textarea,a,label,[role=switch],[contenteditable=true]";
function track(e: PointerEvent, onMove: (p: PointerEvent) => void) {
  const id = e.pointerId;
  const move = (ev: PointerEvent) => ev.pointerId === id && onMove(ev);
  const stop = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
}
const host = () => ({ width: window.innerWidth, height: window.innerHeight });
function startDrag(e: PointerEvent, win: ShellWindow) {
  if (e.button !== 0 || win.maximized) return;
  if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
  e.preventDefault();
  const sx = e.clientX;
  const sy = e.clientY;
  const { x: x0, y: y0 } = win.bounds;
  track(e, (p) => shell.dispatch({ type: "window/move", id: win.id, x: x0 + p.clientX - sx, y: y0 + p.clientY - sy, host: host() }));
}
/** 正文里的工具条（访达等分栏窗口的 .pane-toolbar）也能按住拖窗口，与 React 一致。 */
function onBodyPointerDown(e: PointerEvent, win: ShellWindow) {
  if ((e.target as HTMLElement).closest(".pane-toolbar")) startDrag(e, win);
}
/** 分栏窗口的工具条盖住了标题栏，双击它（非按钮处）也要能最大化/还原。 */
function onBodyDblClick(e: MouseEvent, win: ShellWindow) {
  const t = e.target as HTMLElement;
  if (t.closest(".pane-toolbar") && !t.closest(INTERACTIVE)) shell.toggleMaximize(win.id);
}
function startResize(e: PointerEvent, win: ShellWindow) {
  if (e.button !== 0 || win.maximized) return;
  e.preventDefault();
  const sx = e.clientX;
  const sy = e.clientY;
  const { w: w0, h: h0 } = win.bounds;
  track(e, (p) => shell.dispatch({ type: "window/resize", id: win.id, w: w0 + p.clientX - sx, h: h0 + p.clientY - sy, host: host() }));
}
function resizeByKey(e: KeyboardEvent, win: ShellWindow) {
  if (!e.key.startsWith("Arrow")) return;
  e.preventDefault();
  const dx = e.key === "ArrowRight" ? 20 : e.key === "ArrowLeft" ? -20 : 0;
  const dy = e.key === "ArrowDown" ? 20 : e.key === "ArrowUp" ? -20 : 0;
  // 取最新几何：连续按键时模板里的 win 还是上一帧的快照
  const cur = shell.windows.find((w) => w.id === win.id)?.bounds ?? win.bounds;
  shell.dispatch({ type: "window/resize", id: win.id, w: cur.w + dx, h: cur.h + dy, host: host() });
}

function styleOf(win: ShellWindow) {
  return {
    left: win.bounds.x + "px",
    top: win.bounds.y + "px",
    width: win.bounds.w + "px",
    height: win.bounds.h + "px",
    zIndex: 10 + win.z,
  };
}
</script>

<template>
  <section
    v-for="win in shell.windows"
    :key="win.id"
    :data-window-id="win.id"
    :aria-label="win.title + '窗口'"
    class="window"
    :class="{ active: win.id === shell.focusedWindowId, minimized: !win.visible }"
    :style="styleOf(win)"
    @pointerdown="shell.focusWindow(win.id)"
  >
    <div class="window-title" @pointerdown="startDrag($event, win)" @dblclick="shell.toggleMaximize(win.id)">
      <div class="traffic">
        <!-- 红灯语义同 React（components.tsx closeAction）：App 窗口收进 Dock，只有系统设置真的关闭 -->
        <button
          class="close"
          :aria-label="(win.appId === 'settings' ? '关闭' : '最小化') + win.id"
          @click="win.appId === 'settings' ? shell.closeWindow(win.id) : shell.minimizeWindow(win.id)"
        >
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
        </button>
        <button class="minimize" :aria-label="'最小化' + win.id" @click="shell.minimizeWindow(win.id)">
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14" /></svg>
        </button>
        <button class="maximize" :aria-label="(win.maximized ? '还原' : '最大化') + win.id" @click="shell.toggleMaximize(win.id)">
          <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1 4.6 L4.6 4.6 L4.6 1 Z" fill="currentColor" />
            <path d="M9 5.4 L5.4 5.4 L5.4 9 Z" fill="currentColor" />
          </svg>
        </button>
      </div>
    </div>
    <div class="window-body" @pointerdown="onBodyPointerDown($event, win)" @dblclick="onBodyDblClick($event, win)">
      <HomeApp v-if="win.appId === 'home'" />
      <SettingsContent
        v-else-if="win.appId === 'settings'"
        :role="identity.snapshot.role"
        :pane-request="shell.modelSettingsRequest"
      />
      <FilesApp v-else-if="win.appId === 'files'" />
      <ResourceLibraryApp v-else-if="win.appId === 'resource-library'" />
      <McpCenter v-else-if="win.appId === 'mcp-center'" :role="identity.snapshot.role" />
      <SkillsApp v-else-if="win.appId === 'skills'" />
      <ProjectsApp v-else-if="win.appId === 'projects'" />
      <GovernanceApp v-else-if="win.appId === 'organization'" />
      <TrashApp v-else-if="win.appId === 'trash'" />
      <NotesApp v-else-if="win.appId === 'notes'" />
      <MusicApp v-else-if="win.appId === 'music'" />
      <CalendarApp v-else-if="win.appId === 'calendar'" />
      <DevApp v-else-if="win.appId === 'dev'" />
      <ChatApp v-else-if="win.appId === 'chat'" />
      <AutomationApp v-else-if="win.appId === 'automation'" />
      <MarketApp v-else-if="win.appId === 'market'" />
      <WeatherApp v-else-if="win.appId === 'weather'" />
      <VideoApp v-else-if="win.appId === 'video'" />
      <DeclareApp v-else-if="win.appId === 'declare'" />
      <DramaApp v-else-if="win.appId === 'drama'" />
      <ReactIsland
        v-else-if="win.appId === 'browser'"
        :component="BrowserAppRaw"
        :props="browserProps(win.id)"
      />
      <ReactIsland v-else-if="win.appId === 'canvas'" :component="CanvasHostRaw" :props="canvasProps(win.id)" />
      <PlannedApp v-else :app-id="win.appId" />
    </div>
    <!-- 快照层：原生视图被收缩 / 隐藏后，把网页画面补回 DOM（与 components.tsx:607 同一结构） -->
    <div v-if="snapshotsOf(win.id).length" class="window-snapshot-layer" aria-hidden="true" :data-window="win.id">
      <img
        v-for="snap in snapshotsOf(win.id)"
        :key="`${snap.rect.x},${snap.rect.y},${snap.rect.width},${snap.rect.height}`"
        :src="snap.dataUrl"
        alt=""
        draggable="false"
        :style="{
          position: 'absolute',
          left: snap.rect.x - win.bounds.x + 'px',
          top: snap.rect.y - win.bounds.y + 'px',
          width: snap.rect.width + 'px',
          height: snap.rect.height + 'px',
        }"
      />
    </div>
    <button
      v-if="!win.maximized"
      class="resize"
      :aria-label="'调整' + win.id + '大小'"
      @pointerdown="startResize($event, win)"
      @keydown="resizeByKey($event, win)"
    >⌟</button>
  </section>
</template>
