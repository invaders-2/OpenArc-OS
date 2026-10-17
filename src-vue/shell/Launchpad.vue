<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { ArrowRight, Contrast, Lock, Search, SlidersHorizontal, Sparkles } from "lucide-vue-next";
import { APPS, appDisplayName, iconUrl } from "../apps";
import { useShellStore } from "../stores/shell";
import { useIdentityStore } from "../stores/identity";
import { t } from "../i18n";

const shell = useShellStore();
const identity = useIdentityStore();
const query = ref("");
const sel = ref(0);
const input = ref<HTMLInputElement | null>(null);

/**
 * 全局搜索面板（聚焦搜索）。10-15 按界面原型升级：
 *   - 结果分组：应用 / 动作 / 交给全局 AI；空查询时列出全部应用（与既有产品一致）
 *   - ↑↓ 选择、回车执行、Esc 关闭（Esc 由 Overlays 统一处理）
 * 0.6.1：应用名与固定文案经 i18n；搜索同时匹配中英文应用名。
 */
interface Hit {
  key: string;
  label: string;
  hint: string;
  icon?: string;
  glyph?: unknown;
  run: () => void;
}
interface Group {
  head: string;
  items: Hit[];
}

const groups = computed<Group[]>(() => {
  const raw = query.value.trim();
  const q = raw.toLowerCase();
  const apps: Hit[] = APPS.filter((a) => !q || appDisplayName(a).toLowerCase().includes(q) || a.name.toLowerCase().includes(q)).map((a) => ({
    key: "app:" + a.id,
    label: appDisplayName(a),
    hint: t("应用"),
    icon: iconUrl(a.icon),
    run: () => shell.activateApp(a.id),
  }));
  if (!q) return [{ head: t("应用"), items: apps }];

  const acts: Hit[] = [];
  const hits = (terms: string) => terms.toLowerCase().includes(q);
  if (hits("切换深色浅色外观主题 dark light theme appearance"))
    acts.push({
      key: "theme",
      label: shell.dark ? t("切换到浅色外观") : t("切换到深色外观"),
      hint: t("动作"),
      glyph: Contrast,
      run: () => shell.setTheme(shell.dark ? "light" : "dark"),
    });
  if (hits("控制中心材质玻璃 control center material glass"))
    acts.push({ key: "cc", label: t("打开控制中心"), hint: t("动作"), glyph: SlidersHorizontal, run: () => shell.toggleControlCenter() });
  if (identity.available && hits("锁定屏幕 lock screen"))
    acts.push({ key: "lock", label: t("锁定屏幕"), hint: t("动作"), glyph: Lock, run: () => identity.lock() });
  const ai: Hit[] = [
    {
      key: "ai",
      label: t("让全局 AI 处理：{query}", { query: raw }),
      hint: t("全局 AI"),
      glyph: Sparkles,
      run: () => shell.toggleAI(),
    },
  ];
  return [
    { head: t("应用"), items: apps },
    { head: t("动作"), items: acts },
    { head: t("全局 AI"), items: ai },
  ].filter((g) => g.items.length);
});
const flat = computed(() => groups.value.flatMap((g) => g.items));

watch(query, () => (sel.value = 0));
onMounted(() => nextTick(() => input.value?.focus()));

function go(hit: Hit | undefined) {
  if (!hit) return;
  shell.closeSearch();
  hit.run();
}
function onKey(e: KeyboardEvent) {
  if (e.key === "ArrowDown") {
    sel.value = Math.min(flat.value.length - 1, sel.value + 1);
    e.preventDefault();
  } else if (e.key === "ArrowUp") {
    sel.value = Math.max(0, sel.value - 1);
    e.preventDefault();
  } else if (e.key === "Enter") {
    go(flat.value[sel.value]);
  }
}
</script>

<template>
  <div class="search-shade" @click="shell.closeSearch()">
    <div
      class="search-panel"
      role="dialog"
      aria-modal="true"
      :aria-label="t('搜索应用')"
      @click.stop
    >
      <div class="search-input">
        <Search class="search-glyph" :size="20" />
        <input
          ref="input"
          v-model="query"
          type="search"
          :aria-label="t('搜索应用名称')"
          :placeholder="t('搜索应用、动作，或直接交给全局 AI')"
          @keydown="onKey"
        />
        <kbd class="search-kbd">esc</kbd>
      </div>
      <div class="search-results" role="listbox">
        <template v-for="g in groups" :key="g.head">
          <div class="search-group">{{ g.head }}</div>
          <button
            v-for="hit in g.items"
            :key="hit.key"
            class="search-result"
            :class="{ active: flat[sel] === hit }"
            role="option"
            :aria-selected="flat[sel] === hit"
            @mouseenter="sel = flat.indexOf(hit)"
            @click="go(hit)"
          >
            <img v-if="hit.icon" class="result-icon" :src="hit.icon" alt="" />
            <span v-else class="result-glyph"><component :is="hit.glyph" :size="17" /></span>
            <span class="result-label">{{ hit.label }}</span>
            <span class="result-hint">{{ hit.hint }}</span>
            <ArrowRight :size="16" />
          </button>
        </template>
      </div>
    </div>
  </div>
</template>
