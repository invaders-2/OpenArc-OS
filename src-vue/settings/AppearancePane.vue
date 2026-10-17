<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ChevronDown, Monitor, Moon, Sun } from "lucide-vue-next";
import { useShellStore, type GlassMode } from "../stores/shell";
import { useIdentityStore } from "../stores/identity";
import { errorText } from "../../src/identity/types";
import { CURSOR_SIZE_MAX, CURSOR_SIZE_MIN } from "../../src/desktop/cursors";
import {
  WALLPAPER_ID,
  WALLPAPER_ROW,
  WALLPAPER_STYLE,
  fileUrl,
  kindOfExt,
  type WallpaperItem,
  type WallpaperStyle,
} from "../wallpapers";
import Avatar from "../identity/Avatar.vue";
import AvatarPicker from "../identity/AvatarPicker.vue";
import DsDialog from "../design-system/DsDialog.vue";
import DsContextMenu from "../design-system/DsContextMenu.vue";
import SystemFontsPanel from "./SystemFontsPanel.vue";
import { t } from "../i18n";

/**
 * 「外观与交互」pane 正文（对齐 src/main.tsx:2663-2891 的 appearanceBody）。
 *
 * 控件顺序是硬要求：
 *   外观 → 减少动态效果 → 材质 → 程序坞图标大小 → 桌面图标大小 →
 *   使用自绘光标 → 光标大小 → 壁纸 → 锁屏壁纸 → 个人资料。
 * 状态全部走 shell store（oa-* 同键），个人资料走 identity:command，
 * 壁纸的上传 / 列出 / 删除走真实文件 IPC（openarc.files）。
 */
/** 10-15 按原型拆成两个分区：appearance（外观）与 account（账户：个人资料）。 */
const props = withDefaults(defineProps<{ section?: "appearance" | "account" }>(), { section: "appearance" });
const shell = useShellStore();
const SCALES = [
  { v: 0.9, l: "更多空间" },
  { v: 1, l: "标准" },
  { v: 1.1, l: "较大" },
  { v: 1.2, l: "大" },
];
const identity = useIdentityStore();

// 设置页打开时拉一次 wallpapers 目录（真实文件 IPC）；失败在 store 内吞掉，不假造条目。
onMounted(() => {
  void shell.refreshWallpapers();
});

/* ── 控件事件（避免模板里写类型断言）────────────────────────────────────── */
function onTheme(next: "system" | "light" | "dark") {
  shell.setTheme(next);
}
function onGlass(next: GlassMode) {
  shell.setGlass(next);
}
function onGlassSelect(e: Event) {
  shell.setGlass((e.target as HTMLSelectElement).value as GlassMode);
}
function onDockSize(e: Event) {
  shell.setDockSize(Number((e.target as HTMLInputElement).value));
}
function onDeskIcon(e: Event) {
  shell.setDeskIconSize(Number((e.target as HTMLInputElement).value));
}
function onCursorSize(e: Event) {
  shell.setCursorSize(Number((e.target as HTMLInputElement).value));
}

/* ── 壁纸选择器 ─────────────────────────────────────────────────────────── */
const wallpapersOpen = ref(false);
const replaceInput = ref<HTMLInputElement | null>(null);
const replaceTarget = ref<string | null>(null);
const menu = ref<{ x: number; y: number; entryId: string } | null>(null);
const styleTarget = ref<string | null>(null);

function toggleWallpapers() {
  wallpapersOpen.value = !wallpapersOpen.value;
}
function closeMenu() {
  menu.value = null;
}

const styleEntry = computed(() =>
  styleTarget.value ? shell.customWallpapers.find((e) => e.id === styleTarget.value) ?? null : null,
);
const styleOf = (id: string): WallpaperStyle => shell.wallpaperStyle[id] ?? WALLPAPER_STYLE;
const mediaStyle = (id: string) => {
  const st = styleOf(id);
  return { objectFit: st.fit, transform: `scale(${st.zoom}) translate(${st.x}%, ${st.y}%)` };
};
const shownItems = computed<WallpaperItem[]>(() =>
  wallpapersOpen.value ? shell.wallpaperItems : shell.wallpaperItems.slice(0, WALLPAPER_ROW),
);

function onDesktopUpload(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  void shell.uploadWallpaper(file, "desktop");
}
function onLockUpload(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  void shell.uploadWallpaper(file, "lock");
}
function onReplaceChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  const target = replaceTarget.value;
  replaceTarget.value = null;
  if (file && target) void shell.replaceWallpaper(file, target);
}
function openWallpaperMenu(x: number, y: number, entryId: string) {
  menu.value = { x, y, entryId };
}
function openMenuAt(e: MouseEvent, entryId: string) {
  openWallpaperMenu(e.clientX, e.clientY, entryId);
}
function openMenuFromButton(e: MouseEvent, entryId: string) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  openWallpaperMenu(r.left, r.bottom + 4, entryId);
}
const menuItems = [
  { id: "size", label: t("调整尺寸…") },
  { id: "replace", label: t("替换图片…") },
  { separator: true },
  { id: "delete-wallpaper", label: t("删除"), danger: true },
];
function onMenuSelect(id: string) {
  const entryId = menu.value?.entryId;
  menu.value = null;
  if (!entryId) return;
  if (id === "size") styleTarget.value = entryId;
  else if (id === "replace") {
    replaceTarget.value = entryId;
    replaceInput.value?.click();
  } else if (id === "delete-wallpaper") void shell.deleteWallpaper(entryId);
}

/* ── 壁纸尺寸对话框 ─────────────────────────────────────────────────────── */
const style = computed<WallpaperStyle>(() => (styleTarget.value ? styleOf(styleTarget.value) : WALLPAPER_STYLE));
function setFit(fit: WallpaperStyle["fit"]) {
  if (styleTarget.value) shell.patchWallpaperStyle(styleTarget.value, { fit });
}
function setZoom(e: Event) {
  if (styleTarget.value) shell.patchWallpaperStyle(styleTarget.value, { zoom: Number((e.target as HTMLInputElement).value) / 100 });
}
function setAxis(axis: "x" | "y", e: Event) {
  if (styleTarget.value) shell.patchWallpaperStyle(styleTarget.value, { [axis]: Number((e.target as HTMLInputElement).value) });
}
function resetStyle() {
  if (styleTarget.value) shell.patchWallpaperStyle(styleTarget.value, { ...WALLPAPER_STYLE });
}
function closeStyle() {
  styleTarget.value = null;
}

/* ── 个人资料（改资料免密码，入口只在系统设置）───────────────────────────── */
const profileName = ref("");
const profileAvatar = ref<string | null>(null);
const profileSaved = ref(false);
const savedFlash = ref<number | null>(null);

watch(
  [() => identity.snapshot.displayName, () => identity.snapshot.avatarRef],
  () => {
    profileName.value = identity.snapshot.displayName ?? "";
    profileAvatar.value = identity.snapshot.avatarRef;
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (savedFlash.value) window.clearTimeout(savedFlash.value);
});

const ROLE_LABEL: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员", viewer: "访客" };
const heroSub = computed(() => {
  const sn = identity.snapshot;
  return [sn.identifier, sn.role ? t(ROLE_LABEL[sn.role] || sn.role) : null, t("本机账号")].filter(Boolean).join(" · ");
});
const profileNameDirty = computed(() => profileName.value.trim() !== (identity.snapshot.displayName ?? ""));
const profileAvatarDirty = computed(
  () => profileAvatar.value !== null && profileAvatar.value !== identity.snapshot.avatarRef,
);
const profileCanSave = computed(
  () => !identity.busy && profileName.value.trim().length > 0 && (profileNameDirty.value || profileAvatarDirty.value),
);

function onNameInput(e: Event) {
  profileName.value = (e.target as HTMLInputElement).value;
  profileSaved.value = false;
}
function onAvatarChange(next: string) {
  profileAvatar.value = next;
  profileSaved.value = false;
}
async function saveProfile() {
  if (!profileCanSave.value) return;
  profileSaved.value = false;
  const input: { displayName?: string; avatarRef?: string } = {};
  if (profileNameDirty.value) input.displayName = profileName.value.trim();
  if (profileAvatarDirty.value && profileAvatar.value) input.avatarRef = profileAvatar.value;
  const res = await identity.updateProfile(input);
  if (res && (res as { ok?: boolean }).ok !== false) {
    profileSaved.value = true;
    if (savedFlash.value) window.clearTimeout(savedFlash.value);
    savedFlash.value = window.setTimeout(() => (profileSaved.value = false), 2000);
  }
}
</script>

<template>
  <template v-if="props.section === 'appearance'">
    <div class="set-group">
      <div class="setting-row">
        <span class="set-lab">{{ t("外观") }}</span>
        <div class="segmented text" role="group" :aria-label="t('外观')">
          <button :aria-pressed="shell.theme === 'light'" @click="onTheme('light')"><Sun :size="14" /> {{ t("浅色") }}</button>
          <button :aria-pressed="shell.theme === 'dark'" @click="onTheme('dark')"><Moon :size="14" /> {{ t("深色") }}</button>
          <button :aria-pressed="shell.theme === 'system'" @click="onTheme('system')"><Monitor :size="14" /> {{ t("自动") }}</button>
        </div>
      </div>
      <div class="setting-row">
        <span class="set-lab">{{ t("窗口材质") }}<small>{{ t("外壳与浮层使用磨砂玻璃；内容区始终保持清晰") }}</small></span>
        <div class="segmented text" role="group" :aria-label="t('材质')">
          <button :aria-pressed="shell.glass === 'full'" @click="onGlass('full')">{{ t("完整玻璃") }}</button>
          <button :aria-pressed="shell.glass === 'reduced'" @click="onGlass('reduced')">{{ t("降低材质") }}</button>
          <button :aria-pressed="shell.glass === 'solid'" @click="onGlass('solid')">{{ t("实色") }}</button>
        </div>
        <!-- 探针钩子：device-ui 依赖 .material-select 在设置打开时就在 DOM 里（隐藏镜像）。 -->
        <select class="material-select" hidden aria-hidden="true" tabindex="-1" :value="shell.glass" @change="onGlassSelect">
          <option value="full">{{ t("完整玻璃") }}</option>
          <option value="reduced">{{ t("降低材质") }}</option>
          <option value="solid">{{ t("实色") }}</option>
        </select>
      </div>
      <div class="setting-row">
        <span class="set-lab">{{ t("减少动态效果") }}<small>{{ t("窗口与菜单改为即时切换或短淡变，拖动仍然跟手") }}</small></span>
        <button
          type="button"
          role="switch"
          :aria-checked="shell.reduced"
          :aria-label="t('减少动态效果')"
          class="switch"
          @click="shell.setReduced(!shell.reduced)"
        />
      </div>
      <div class="setting-row">
        <span class="set-lab">{{ t("界面缩放") }}<small>{{ t("调整窗口内文字与控件的大小（浏览器与 AI Studio 不缩放）") }}</small></span>
        <div class="segmented text" role="group" :aria-label="t('界面缩放')">
          <button v-for="o in SCALES" :key="o.v" :aria-pressed="shell.uiScale === o.v" @click="shell.setUiScale(o.v)">{{ t(o.l) }}</button>
        </div>
      </div>
    </div>

    <section class="set-sec">
      <div class="set-sh">
        <h3>{{ t("桌面壁纸") }}</h3>
        <span class="wallpaper-actions">
      <button
        v-if="shell.wallpaperItems.length > WALLPAPER_ROW"
        class="control-button"
        :aria-expanded="wallpapersOpen"
        @click="toggleWallpapers"
      >
        {{ wallpapersOpen ? t("收起") : t("查看更多") }}
        <ChevronDown :size="13" />
      </button>
      <label class="control-button">
        {{ t("上传壁纸") }}
        <input type="file" accept="image/*,video/*" hidden @change="onDesktopUpload" />
      </label>
    </span>
      </div>
    <input
      ref="replaceInput"
      type="file"
      accept="image/*,video/*"
      :aria-label="t('替换壁纸图片')"
      hidden
      @change="onReplaceChange"
    />
    <div class="wallpaper-grid">
      <template v-for="it in shownItems" :key="it.id">
        <button
          v-if="it.kind === 'preset'"
          class="wallpaper-option"
          :class="{ on: shell.wallpaper === it.id }"
          :data-wallpaper="it.id"
          :aria-pressed="shell.wallpaper === it.id"
          @click="shell.setWallpaper(it.id)"
        >
          <span>{{ t(it.name) }}</span>
        </button>
        <div v-else class="wallpaper-cell">
          <button
            class="wallpaper-option"
            :class="{ on: shell.wallpaper === 'custom:' + it.id }"
            :aria-pressed="shell.wallpaper === 'custom:' + it.id"
            @click="shell.setWallpaper('custom:' + it.id)"
            @contextmenu.prevent="openMenuAt($event, it.id)"
          >
            <video
              v-if="kindOfExt(it.ext) === 'video'"
              :src="fileUrl(WALLPAPER_ID, it.id)"
              :style="mediaStyle(it.id)"
              muted
              loop
              autoplay
              playsinline
            />
            <img v-else :src="fileUrl(WALLPAPER_ID, it.id)" :style="mediaStyle(it.id)" alt="" />
            <span>{{ t(it.name) }}</span>
          </button>
          <button class="wallpaper-more" :aria-label="t('壁纸选项')" :title="t('壁纸选项')" @click="openMenuFromButton($event, it.id)">
            ⋯
          </button>
          <button class="wallpaper-del" :aria-label="t('删除壁纸')" :title="t('删除壁纸')" @click="shell.deleteWallpaper(it.id)">
            ✕
          </button>
        </div>
      </template>
    </div>
      <p class="set-cap">{{ t("选「浅色 / 深色主题色」时，壁纸跟随外观自动切换。") }}</p>
    </section>

    <section class="set-sec">
      <div class="set-sh">
        <h3>{{ t("锁屏壁纸") }}</h3>
        <span class="wallpaper-actions">
      <label class="control-button" data-d3-id="settings-lock-wallpaper-upload">
        {{ t("上传壁纸") }}
        <input type="file" accept="image/*,video/*" hidden @change="onLockUpload" />
      </label>
    </span>
      </div>
    <div class="wallpaper-grid">
      <button
        class="wallpaper-option"
        :class="{ on: shell.lockWallpaper === 'same' }"
        data-lock-wallpaper="same"
        data-d3-id="settings-lock-wallpaper-same"
        :aria-pressed="shell.lockWallpaper === 'same'"
        @click="shell.setLockWallpaper('same')"
      >
        <span>{{ t("同桌面") }}</span>
      </button>
      <template v-for="it in shell.wallpaperItems" :key="it.id">
        <button
          v-if="it.kind === 'preset'"
          class="wallpaper-option"
          :class="{ on: shell.lockWallpaper === it.id }"
          :data-lock-wallpaper="it.id"
          :aria-pressed="shell.lockWallpaper === it.id"
          @click="shell.setLockWallpaper(it.id)"
        >
          <span>{{ t(it.name) }}</span>
        </button>
        <button
          v-else
          class="wallpaper-option"
          :class="{ on: shell.lockWallpaper === 'custom:' + it.id }"
          :data-lock-wallpaper="'custom:' + it.id"
          :aria-pressed="shell.lockWallpaper === 'custom:' + it.id"
          @click="shell.setLockWallpaper('custom:' + it.id)"
        >
          <video
            v-if="kindOfExt(it.ext) === 'video'"
            :src="fileUrl(WALLPAPER_ID, it.id)"
            :style="mediaStyle(it.id)"
            muted
            loop
            autoplay
            playsinline
          />
          <img v-else :src="fileUrl(WALLPAPER_ID, it.id)" :style="mediaStyle(it.id)" alt="" />
          <span>{{ t(it.name) }}</span>
        </button>
      </template>
    </div>
      <p class="set-cap">{{ t("登录界面与锁屏共用同一张，独立于桌面。") }}</p>
    </section>

    <section class="set-sec">
      <h3>{{ t("程序坞与桌面") }}</h3>
      <div class="set-group">
      <div class="setting-row">
        <span class="set-lab">{{ t("程序坞图标大小") }}<small>{{ t("拖动滑块调整 Dock 图标尺寸") }}</small></span>
        <span class="setting-range-wrap">
          <input
            class="setting-range"
            type="range"
            min="32"
            max="80"
            step="1"
            :value="shell.dockSize"
            :aria-label="t('程序坞图标大小')"
            @input="onDockSize"
          />
          <span class="setting-range-value">{{ shell.dockSize }}px</span>
        </span>
      </div>
      <div class="setting-row">
        <span class="set-lab">{{ t("桌面图标大小") }}<small>{{ t("拖动滑块调整桌面文件夹与文件的尺寸") }}</small></span>
        <span class="setting-range-wrap">
          <input
            class="setting-range"
            type="range"
            min="40"
            max="96"
            step="1"
            :value="shell.deskIcon"
            :aria-label="t('桌面图标大小')"
            @input="onDeskIcon"
          />
          <span class="setting-range-value">{{ shell.deskIcon }}px</span>
        </span>
      </div>
      <div class="setting-row">
        <span class="set-lab">{{ t("使用自绘光标") }}<small>{{ t("用系统风格的自绘光标替换默认光标") }}</small></span>
        <button
          type="button"
          role="switch"
          :aria-checked="shell.cursorCustom"
          :aria-label="t('使用自绘光标')"
          class="switch"
          @click="shell.setCursorCustom(!shell.cursorCustom)"
        />
      </div>
      <div class="setting-row">
        <span class="set-lab">{{ t("光标大小") }}<small>{{ t("拖动滑块调整自绘光标尺寸") }}</small></span>
        <span class="setting-range-wrap">
          <input
            class="setting-range"
            type="range"
            :min="CURSOR_SIZE_MIN"
            :max="CURSOR_SIZE_MAX"
            step="1"
            :value="shell.cursorSize"
            :disabled="!shell.cursorCustom"
            :aria-label="t('光标大小')"
            @input="onCursorSize"
          />
          <span class="setting-range-value">{{ shell.cursorSize }}px</span>
        </span>
      </div>
      <div class="setting-row">
        <span class="set-lab">{{ t("桌面小组件") }}<small>{{ t("日期与进行中的任务") }}</small></span>
        <button
          type="button"
          role="switch"
          :aria-checked="shell.widgets"
          :aria-label="t('桌面小组件')"
          class="switch"
          @click="shell.setWidgets(!shell.widgets)"
        />
      </div>
      </div>
    </section>

    <!-- 0.6.1：系统字体（只读本机字体清单，按需预览；systemFonts:command） -->
    <SystemFontsPanel />
  </template>

  <template v-else>
    <div class="set-hero">
      <span class="set-hero-avatar"><Avatar :avatar-ref="profileAvatar" :name="profileName" /></span>
      <div>
        <div class="set-hero-name">{{ profileName || t("未命名用户") }}</div>
        <div class="set-hero-sub">{{ heroSub }}</div>
      </div>
    </div>
    <div class="set-group set-profile">
      <div class="setting-row">
        <span class="set-lab">{{ t("头像") }}<small>{{ t("选一个图标或上传图片") }}</small></span>
        <span class="profile-avatar" data-d3-id="settings-avatar">
          <Avatar :avatar-ref="profileAvatar" :name="profileName" />
        </span>
      </div>
      <div class="set-block">
        <AvatarPicker
          :avatar-ref="profileAvatar"
          :disabled="identity.busy"
          id-prefix="settings-avatar"
          @change="onAvatarChange"
        />
      </div>
      <label class="setting-row field">
        <span class="set-lab">{{ t("显示名") }}</span>
        <input :value="profileName" :placeholder="t('显示名')" autocomplete="off" data-d3-id="settings-name" @input="onNameInput" />
      </label>
      <div class="setting-row profile-actions">
        <span class="set-lab profile-hint">{{ t("保存后立即生效，不需要输入密码。") }}</span>
        <button type="button" class="primary" :disabled="!profileCanSave" data-d3-id="settings-save" @click="saveProfile">
          {{ identity.busy ? t("正在保存…") : profileSaved ? t("已保存") : t("保存") }}
        </button>
      </div>
    </div>
    <p v-if="identity.error" class="auth-error" role="alert" data-d3-id="settings-error">
      {{ errorText(identity.error.code, identity.error.detail) }}
    </p>
  </template>

  <DsContextMenu
    v-if="menu"
    :x="menu.x"
    :y="menu.y"
    :items="menuItems"
    :label="t('壁纸菜单')"
    @select="onMenuSelect"
    @close="closeMenu"
  />

  <DsDialog
    :open="styleTarget !== null"
    :title="styleEntry ? t('调整「{name}」', { name: styleEntry.name }) : t('调整壁纸尺寸')"
    @close="closeStyle"
  >
    <div class="setting-row">
      <span>{{ t("显示方式") }}</span>
      <div class="segmented text" role="group" :aria-label="t('显示方式')">
        <button :aria-pressed="style.fit === 'cover'" @click="setFit('cover')">{{ t("填充") }}</button>
        <button :aria-pressed="style.fit === 'contain'" @click="setFit('contain')">{{ t("适应") }}</button>
        <button :aria-pressed="style.fit === 'fill'" @click="setFit('fill')">{{ t("拉伸") }}</button>
      </div>
    </div>
    <div class="setting-row">
      <span>
        {{ t("缩放") }}
        <span class="footnote"> {{ t("只改画法，不动原图") }}</span>
      </span>
      <span class="setting-range-wrap">
        <input
          class="setting-range"
          type="range"
          min="50"
          max="200"
          step="1"
          :value="Math.round(style.zoom * 100)"
          :aria-label="t('壁纸缩放')"
          @input="setZoom"
        />
        <span class="setting-range-value">{{ Math.round(style.zoom * 100) }}%</span>
      </span>
    </div>
    <div class="setting-row">
      <span>{{ t("水平位置") }}</span>
      <span class="setting-range-wrap">
        <input class="setting-range" type="range" min="-50" max="50" step="1" :value="style.x" :aria-label="t('水平位置')" @input="setAxis('x', $event)" />
        <span class="setting-range-value">{{ style.x }}%</span>
      </span>
    </div>
    <div class="setting-row">
      <span>{{ t("垂直位置") }}</span>
      <span class="setting-range-wrap">
        <input class="setting-range" type="range" min="-50" max="50" step="1" :value="style.y" :aria-label="t('垂直位置')" @input="setAxis('y', $event)" />
        <span class="setting-range-value">{{ style.y }}%</span>
      </span>
    </div>
    <template #footer>
      <button class="ghost" @click="resetStyle">{{ t("恢复默认") }}</button>
      <button class="primary" @click="closeStyle">{{ t("完成") }}</button>
    </template>
  </DsDialog>
</template>
