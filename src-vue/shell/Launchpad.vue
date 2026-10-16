<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { ArrowRight, Contrast, Lock, Search, SlidersHorizontal, Sparkles } from "lucide-vue-next";
import { APPS, iconUrl } from "../apps";
import { useShellStore } from "../stores/shell";
import { useIdentityStore } from "../stores/identity";

const shell = useShellStore();
const identity = useIdentityStore();
const query = ref("");
const sel = ref(0);
const input = ref<HTMLInputElement | null>(null);

/**
 * 全局搜索面板（聚焦搜索）。10-15 按界面原型升级：
 *   - 结果分组：应用 / 动作 / 交给全局 AI；空查询时列出全部应用（与既有产品一致）
 *   - ↑↓ 选择、回车执行、Esc 关闭（Esc 由 Overlays 统一处理）
 * DOM 与 class（.search-shade / .search-panel / .search-input / .search-result）沿用既有产品。
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
  const apps: Hit[] = APPS.filter((a) => !q || a.name.toLowerCase().includes(q)).map((a) => ({
    key: "app:" + a.id,
    label: a.name,
    hint: "应用",
    icon: iconUrl(a.icon),
    run: () => shell.activateApp(a.id),
  }));
  if (!q) return [{ head: "应用", items: apps }];

  const acts: Hit[] = [];
  if ("切换深色浅色外观主题".includes(q))
    acts.push({
      key: "theme",
      label: shell.dark ? "切换到浅色外观" : "切换到深色外观",
      hint: "动作",
      glyph: Contrast,
      run: () => shell.setTheme(shell.dark ? "light" : "dark"),
    });
  if ("控制中心材质玻璃".includes(q))
    acts.push({ key: "cc", label: "打开控制中心", hint: "动作", glyph: SlidersHorizontal, run: () => shell.toggleControlCenter() });
  if (identity.available && "锁定屏幕".includes(q))
    acts.push({ key: "lock", label: "锁定屏幕", hint: "动作", glyph: Lock, run: () => identity.lock() });
  const ai: Hit[] = [
    {
      key: "ai",
      label: `让全局 AI 处理："${raw}"`,
      hint: "全局 AI",
      glyph: Sparkles,
      run: () => shell.toggleAI(),
    },
  ];
  return [
    { head: "应用", items: apps },
    { head: "动作", items: acts },
    { head: "全局 AI", items: ai },
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
      aria-label="搜索应用"
      @click.stop
    >
      <div class="search-input">
        <Search class="search-glyph" :size="20" />
        <input
          ref="input"
          v-model="query"
          type="search"
          aria-label="搜索应用名称"
          placeholder="搜索应用、动作，或直接交给全局 AI"
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
