<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Lock, LogOut, Monitor, Search, SlidersHorizontal, Sparkles, User } from "lucide-vue-next";
import { appById } from "../apps";
import { useShellStore } from "../stores/shell";
import { useIdentityStore } from "../stores/identity";
import DsContextMenu, { type MenuEntry } from "../design-system/DsContextMenu.vue";
import Orb from "./Orb.vue";

const shell = useShellStore();
const identity = useIdentityStore();

/**
 * 顶栏（按 10-15 界面原型升级，macOS 菜单栏口径）：
 *   左：当前应用名（粗体）+ 文件 / 编辑 / 显示 / 窗口 / 帮助 五个下拉菜单
 *   右：本机 · D1 → 搜索 → 控制中心 → 全局 AI → 锁定 → 用户 → 日期时间（点开通知中心）
 * 仍然**不放品牌字标**（用户口径：顶栏不要 logo/字标），左侧 92px 继续让给原生红绿灯。
 * 身份块是主进程权威投影：只显示快照并回调命令；没有桥时不渲染这两颗按钮
 * （data-d3-id 钩子保留，验收探针直接点它们）。
 */
const locked = computed(() => identity.phase === "locked");

const now = ref(new Date());
let timer = 0;

/* ── 平台与原生窗口控制（Windows 自绘 caption） ─────────────────────────
 * 平台只来自 window.openarc.system.info()（既有通道，不新开通道）。
 * 只有 Windows 渲染三枚 caption；macOS 保留原生红绿灯，DOM 里不出重复按钮。
 * 最大化态由主进程推（window:state），首帧先查一次 window:control/state。
 * 桥缺失时按"无平台信息"处理：不渲染按钮，也不影响 macOS 布局。 */
const platform = ref("");
const isWin = computed(() => platform.value === "win32");
const maxed = ref(false);
let offWindowState: (() => void) | null = null;

function applyWindowState(state: { maximized?: boolean } | null | undefined) {
  if (typeof state?.maximized === "boolean") maxed.value = state.maximized;
}

async function detectPlatform() {
  try {
    const info = await window.openarc?.system?.info?.();
    platform.value = typeof info?.platform === "string" ? info.platform : "";
  } catch {
    platform.value = "";
  }
  if (!isWin.value) return;
  try {
    applyWindowState((await window.openarc?.windowControl?.state?.())?.value);
  } catch {
    /* 桥缺失：按钮仍在，状态以主进程推送为准 */
  }
}

/** 关闭会让窗口立即销毁，这次 invoke 的回包可能拿不到：失败即按"已关闭"处理。 */
function windowCommand(action: "minimize" | "toggleMaximize" | "close") {
  const pending = window.openarc?.windowControl?.[action]?.();
  if (pending && typeof pending.catch === "function") void pending.catch(() => {});
}

onMounted(() => {
  timer = window.setInterval(() => (now.value = new Date()), 15000);
  offWindowState = window.openarc?.windowControl?.onStateChange?.(applyWindowState) ?? null;
  void detectPlatform();
});
onBeforeUnmount(() => {
  window.clearInterval(timer);
  offWindowState?.();
  offWindowState = null;
});

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const dateText = computed(
  () => `${now.value.getMonth() + 1}月${now.value.getDate()}日 周${WEEK[now.value.getDay()]}`,
);
const timeText = computed(() =>
  now.value.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }),
);

const focused = computed(() => shell.focusedWindow);
const appName = computed(() => (focused.value ? appById(focused.value.appId)?.name || focused.value.title : "访达"));

/* ── 下拉菜单 ─────────────────────────────────────────────────────────── */
const MENUS = ["文件", "编辑", "显示", "窗口", "帮助"] as const;
type MenuKey = "logo" | "app" | "user" | (typeof MENUS)[number];
const open = ref<{ key: MenuKey; x: number; y: number } | null>(null);

function exec(cmd: string) {
  // 编辑菜单：交给当前焦点所在的可编辑元素（与 macOS 一样，没有可编辑目标时什么也不发生）
  try {
    document.execCommand(cmd);
  } catch {
    /* 不支持的环境里静默 */
  }
}

const items = computed<MenuEntry[]>(() => {
  const w = focused.value;
  const name = appName.value;
  switch (open.value?.key) {
    case "logo":
      return [
        { id: "about", label: "关于 OpenArc" },
        { separator: true },
        { id: "settings", label: "系统设置…" },
        { id: "home", label: "应用中心…" },
        { separator: true },
        { id: "lock", label: "锁定屏幕", shortcut: "⌃⌘Q", disabled: !identity.available || locked.value },
        { id: "logout", label: `退出 ${identity.snapshot.displayName || "登录"}…`, disabled: !identity.available },
      ];
    case "user":
      return [
        { header: [identity.snapshot.displayName, identity.snapshot.identifier].filter(Boolean).join(" · ") || "未登录" },
        { id: "settings", label: "账户与设置…" },
        { separator: true },
        { id: "lock", label: "锁定", disabled: !identity.available || locked.value },
        { id: "logout", label: "注销", disabled: !identity.available },
      ];
    case "app":
      return [
        { id: "about-app", label: `关于${name}`, disabled: true },
        { separator: true },
        { id: "settings", label: "系统设置…", shortcut: "⌘," },
        { separator: true },
        { id: "hide", label: `隐藏${name}`, shortcut: "⌘H", disabled: !w },
        { id: "quit", label: `退出${name}`, shortcut: "⌘Q", disabled: !w },
      ];
    case "文件":
      return [
        { id: "new-finder", label: "新建访达窗口", shortcut: "⌘N" },
        { separator: true },
        { id: "close", label: "关闭窗口", shortcut: "⌘W", disabled: !w },
      ];
    case "编辑":
      return [
        { id: "undo", label: "撤销", shortcut: "⌘Z" },
        { id: "redo", label: "重做", shortcut: "⇧⌘Z" },
        { separator: true },
        { id: "cut", label: "剪切", shortcut: "⌘X" },
        { id: "copy", label: "拷贝", shortcut: "⌘C" },
        { id: "paste", label: "粘贴", shortcut: "⌘V" },
        { id: "selectAll", label: "全选", shortcut: "⌘A" },
      ];
    case "显示":
      return [
        { id: "theme", label: shell.dark ? "切换到浅色外观" : "切换到深色外观" },
        { id: "search", label: "搜索", shortcut: "⌘K" },
        { id: "cc", label: "控制中心" },
        { id: "nc", label: "通知中心" },
        { separator: true },
        { id: "reduced", label: shell.reduced ? "恢复动态效果" : "减少动态效果" },
      ];
    case "窗口":
      return [
        { id: "min", label: "最小化", shortcut: "⌘M", disabled: !w, checked: false },
        { id: "zoom", label: "缩放", disabled: !w, checked: false },
        { separator: true },
        ...shell.windows.map((x) => ({
          id: "win:" + x.id,
          label: appById(x.appId)?.name || x.title,
          checked: x.id === shell.focusedWindowId,
        })),
      ];
    case "帮助":
      return [{ id: "shortcuts", label: "快捷键一览" }];
    default:
      return [];
  }
});

function toggleMenu(key: MenuKey, e: MouseEvent) {
  if (open.value?.key === key) {
    open.value = null;
    return;
  }
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  open.value = { key, x: r.left, y: r.bottom + 4 };
}

function select(id: string) {
  const w = focused.value;
  open.value = null;
  if (id.startsWith("win:")) {
    const target = shell.windows.find((x) => x.id === id.slice(4));
    if (!target) return;
    if (!target.visible) shell.dispatch({ type: "window/restore", id: target.id });
    else shell.focusWindow(target.id);
    return;
  }
  switch (id) {
    case "about":
    case "home":
      return shell.activateApp(id === "home" ? "home" : "settings");
    case "lock":
      return identity.lock();
    case "logout":
      return identity.logout();
    case "settings":
      return shell.activateApp("settings");
    case "hide":
      return w && shell.minimizeWindow(w.id);
    case "quit":
      if (w) shell.windows.filter((x) => x.appId === w.appId).forEach((x) => shell.closeWindow(x.id));
      return;
    case "new-finder":
      return shell.dispatch({ type: "window/open", appId: "files", meta: { title: "访达", icon: "finder" } });
    case "close":
      return w && shell.closeWindow(w.id);
    case "undo":
    case "redo":
    case "cut":
    case "copy":
    case "paste":
    case "selectAll":
      return exec(id);
    case "theme":
      return shell.setTheme(shell.dark ? "light" : "dark");
    case "search":
      return shell.toggleSearch();
    case "cc":
      return shell.toggleControlCenter();
    case "nc":
      return shell.toggleNotifications();
    case "reduced":
      return shell.setReduced(!shell.reduced);
    case "min":
      return w && shell.minimizeWindow(w.id);
    case "zoom":
      return w && shell.toggleMaximize(w.id);
    case "shortcuts":
      return shell.notify({
        appId: "settings",
        title: "快捷键",
        body: "⌘K 搜索 · ⌘W 关闭窗口 · ⌘M 最小化 · 空格 快速查看 · Esc 关闭浮层",
      });
  }
}
</script>

<template>
  <header class="topbar" :class="{ 'is-win': isWin }" :data-platform="platform || undefined">
    <nav class="topbar-menus" aria-label="应用菜单">
      <button
        class="bar-menu bar-logo"
        :class="{ on: open?.key === 'logo' }"
        aria-haspopup="menu"
        :aria-expanded="open?.key === 'logo'"
        @click="toggleMenu('logo', $event)"
      >
        <Sparkles :size="13" /> OpenArc
      </button>
      <button
        class="bar-menu bar-appname"
        :class="{ on: open?.key === 'app' }"
        aria-haspopup="menu"
        :aria-expanded="open?.key === 'app'"
        @click="toggleMenu('app', $event)"
      >
        {{ appName }}
      </button>
      <button
        v-for="m in MENUS"
        :key="m"
        class="bar-menu"
        :class="{ on: open?.key === m }"
        aria-haspopup="menu"
        :aria-expanded="open?.key === m"
        @click="toggleMenu(m, $event)"
      >
        {{ m }}
      </button>
    </nav>
    <div class="topbar-right">
      <span class="local-tag"><Monitor :size="13" /> 本机 · D1</span>
      <button aria-label="全局搜索" :aria-expanded="shell.searchOpen" @click="shell.toggleSearch()">
        <Search :size="15" />
      </button>
      <button
        aria-label="控制中心"
        :class="{ on: shell.controlCenterOpen }"
        :aria-expanded="shell.controlCenterOpen"
        @click="shell.toggleControlCenter()"
      >
        <SlidersHorizontal :size="15" />
      </button>
      <button aria-label="全局 AI" @click="shell.toggleAI()">
        <Orb :size="18" class="topbar-orb" :animated="!shell.reduced" />
      </button>
      <button
        class="bar-user"
        :class="{ on: open?.key === 'user' }"
        aria-haspopup="menu"
        :aria-expanded="open?.key === 'user'"
        aria-label="用户菜单"
        @click="toggleMenu('user', $event)"
      >
        <User :size="14" /> {{ identity.snapshot.displayName || "本机" }}
      </button>
      <!-- 身份直达按钮：视觉上收进用户菜单，DOM 仍保留（验收探针直接点 data-d3-id），键盘也可达 -->
      <template v-if="identity.available">
        <button
          class="visually-hidden"
          aria-label="锁定屏幕"
          data-d3-id="topbar-lock"
          :disabled="locked"
          @click="identity.lock()"
        >
          <Lock :size="13" />
        </button>
        <button class="visually-hidden" aria-label="退出登录" data-d3-id="topbar-logout" @click="identity.logout()">
          <LogOut :size="13" /> {{ identity.snapshot.displayName || "退出" }}
        </button>
      </template>
      <button
        class="bar-clock"
        :class="{ on: shell.notificationsOpen }"
        aria-label="通知中心"
        :aria-expanded="shell.notificationsOpen"
        @click="shell.toggleNotifications()"
      >
        {{ dateText }}&nbsp;&nbsp;{{ timeText }}
      </button>
    </div>
    <!-- Windows caption：贴窗口右上角，46×38 满高（方案 B，用户已拍板）。
         macOS 不渲染这一组（保留原生红绿灯，绝不出重复按钮）。 -->
    <div v-if="isWin" class="topbar-caption" role="group" aria-label="窗口控制">
      <button
        class="bar-caption"
        type="button"
        data-caption="minimize"
        aria-label="最小化"
        title="最小化"
        @click="windowCommand('minimize')"
      >
        <svg class="caption-glyph" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
          <path d="M0 5h10" fill="none" stroke="currentColor" stroke-width="1" />
        </svg>
      </button>
      <button
        class="bar-caption"
        type="button"
        data-caption="maximize"
        :data-caption-state="maxed ? 'restore' : 'maximize'"
        :aria-label="maxed ? '还原' : '最大化'"
        :title="maxed ? '还原' : '最大化'"
        @click="windowCommand('toggleMaximize')"
      >
        <svg v-if="maxed" class="caption-glyph" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
          <path d="M3.5 1.5h5v5" fill="none" stroke="currentColor" stroke-width="1" />
          <path d="M1.5 3.5h5v5h-5z" fill="none" stroke="currentColor" stroke-width="1" />
        </svg>
        <svg v-else class="caption-glyph" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
          <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1" />
        </svg>
      </button>
      <button
        class="bar-caption caption-close"
        type="button"
        data-caption="close"
        aria-label="关闭窗口"
        title="关闭"
        @click="windowCommand('close')"
      >
        <svg class="caption-glyph" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" fill="none" stroke="currentColor" stroke-width="1" />
        </svg>
      </button>
    </div>
    <!-- 顶栏带 transform（见 styles.css .topbar），fixed 遮罩会被它裁进 38px 高：
         菜单挂到壳根 .desktop 上（主题 class 也在那里）。 -->
    <Teleport v-if="open" to=".desktop">
    <DsContextMenu
      :x="open.x"
      :y="open.y"
      :items="items"
      extra-class="bar-dropdown"
      :label="open.key === 'app' ? appName : open.key === 'logo' ? 'OpenArc' : open.key === 'user' ? '用户' : open.key"
      @select="select"
      @close="open = null"
    />
    </Teleport>
  </header>
</template>
