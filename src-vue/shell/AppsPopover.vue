<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Ellipsis, LayoutGrid, Search } from "lucide-vue-next";
import { APPS, APP_CATEGORIES, APP_CATEGORY, appDisplayName, iconUrl, type AppEntry } from "../apps";
import { useShellStore } from "../stores/shell";
import DsContextMenu from "../design-system/DsContextMenu.vue";
import { t } from "../i18n";

/**
 * 应用程序弹窗（10-15，macOS 27「应用程序」口径）：点程序坞的「应用中心」在程序坞上方弹出，
 * 取代原来的应用中心窗口。
 *   · 顶部：标题 + 搜索框（打开即聚焦）+ 更多菜单；Esc 关闭
 *   · 分类条：再点一次取消筛选
 *   · 无筛选时第一行是最近打开的应用（分隔线），下面是全部应用
 *   · 单击打开；右键：打开 / 加到或移出程序坞
 * 0.6.1：应用名经 appDisplayName()，分类与固定文案经 t()；搜索同时匹配中英文名。
 */
const shell = useShellStore();
const cat = ref<string | null>(null);
const query = ref("");

const all = computed(() => APPS.filter((a) => a.id !== "home"));
const recent = computed(() =>
  shell.recentLaunch
    .map((id: string) => all.value.find((a) => a.id === id))
    .filter((a): a is AppEntry => !!a)
    .slice(0, 7),
);
const list = computed(() => {
  const q = query.value.trim().toLowerCase();
  return all.value.filter(
    (a) =>
      (!cat.value || (APP_CATEGORY[a.id] ?? "其他") === cat.value) &&
      (!q || appDisplayName(a).toLowerCase().includes(q) || a.name.toLowerCase().includes(q) || a.id.includes(q)),
  );
});
const showRecent = computed(() => !cat.value && !query.value && recent.value.length > 0);
const cardIcon = (a: AppEntry) => iconUrl(a.id === "trash" && shell.trashFull ? "trash-full" : a.icon);

function open(a: AppEntry) {
  shell.closeAllOverlays();
  shell.activateApp(a.id);
}

const searchEl = ref<HTMLInputElement | null>(null);
function onSearchKey(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.isComposing && list.value.length) open(list.value[0]);
}
onMounted(() => searchEl.value?.focus());

const menu = ref<{ x: number; y: number; app: AppEntry | null } | null>(null);
const menuItems = computed(() => {
  const a = menu.value?.app;
  if (!a)
    return [
      { id: "market", label: t("打开应用市场…") },
      { id: "settings", label: t("程序坞设置…") },
    ];
  const pinned = shell.dockIds.includes(a.id);
  return [
    { id: "open", label: t("打开") },
    { separator: true },
    { id: "dock", label: pinned ? t("从程序坞移除") : t("添加到程序坞"), disabled: a.id === "trash" },
  ];
});
function onMenu(id: string) {
  const a = menu.value?.app;
  menu.value = null;
  if (id === "open" && a) open(a);
  else if (id === "dock" && a) shell.toggleDock(a.id);
  else if (id === "market" || id === "settings") {
    shell.closeAllOverlays();
    shell.activateApp(id);
  }
}
</script>

<template>
  <div class="apps-shade" @pointerdown.self="shell.closeAllOverlays()" />
  <section class="apps-pop" role="dialog" :aria-label="t('应用程序')">
    <header class="apps-head">
      <LayoutGrid class="apps-head-ico" :size="26" :stroke-width="1.6" />
      <h2>{{ t("应用程序") }}</h2>
      <label class="ds-search apps-search">
        <Search class="ds-search__icon" :size="14" />
        <input ref="searchEl" v-model="query" class="ds-search__input" type="search" :placeholder="t('搜索应用')" :aria-label="t('搜索应用')" @keydown="onSearchKey" />
      </label>
      <button
        class="apps-more"
        :aria-label="t('更多')"
        @click="(e: MouseEvent) => (menu = { x: e.clientX - 160, y: e.clientY + 12, app: null })"
      >
        <Ellipsis :size="18" />
      </button>
    </header>
    <nav class="apps-cats" :aria-label="t('分类')">
      <button
        v-for="c in [...APP_CATEGORIES, '其他']"
        :key="c"
        type="button"
        :aria-pressed="cat === c"
        @click="cat = cat === c ? null : c"
      >
        {{ t(c) }}
      </button>
    </nav>
    <div class="apps-scroll">
      <template v-if="showRecent">
        <div class="apps-grid">
          <button v-for="a in recent" :key="'r' + a.id" type="button" class="apps-cell" :data-app-card="a.id" @click="open(a)" @contextmenu.prevent="menu = { x: $event.clientX, y: $event.clientY, app: a }">
            <img :src="cardIcon(a)" alt="" draggable="false" />
            <span>{{ appDisplayName(a) }}</span>
          </button>
        </div>
        <hr class="apps-sep" />
      </template>
      <div class="apps-grid">
        <button
          v-for="a in list"
          :key="a.id"
          type="button"
          class="apps-cell"
          :data-app-card="showRecent && recent.some((r) => r.id === a.id) ? undefined : a.id"
          @click="open(a)"
          @contextmenu.prevent="menu = { x: $event.clientX, y: $event.clientY, app: a }"
        >
          <img :src="cardIcon(a)" alt="" draggable="false" />
          <span>{{ appDisplayName(a) }}</span>
        </button>
      </div>
      <p v-if="!list.length" class="apps-empty">{{ t("没有匹配「{query}」的应用", { query }) }}</p>
    </div>
    <DsContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menuItems" :label="t('应用菜单')" @select="onMenu" @close="menu = null" />
  </section>
</template>
