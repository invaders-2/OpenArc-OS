<script setup lang="ts">
import { computed, ref } from "vue";
import { ChevronRight } from "lucide-vue-next";
import SiteIcon from "./SiteIcon.vue";
import type { Source } from "./web";

/**
 * 回答下方的「来源」（ChatGPT 式）：图标叠放 + 「N 个来源」，点开是来源卡片列表
 * （回答里引用到的标「已引用」，读过全文的标「已读」）。
 */
const props = defineProps<{ sources: Source[] }>();
const emit = defineEmits<{ (e: "open", url: string, title: string, ev: MouseEvent): void }>();
const open = ref(false);
const stack = computed(() => [...new Set(props.sources.map((s) => s.host))].slice(0, 4));
</script>

<template>
  <div class="web-src" data-chat-sources>
    <button type="button" class="web-src-btn" :aria-expanded="open" data-chat-sources-toggle @click="open = !open">
      <span class="web-src-stack" aria-hidden="true"><SiteIcon v-for="h in stack" :key="h" :host="h" :size="16" /></span>
      <span data-chat-sources-count>{{ sources.length }} 个来源</span>
      <ChevronRight :size="14" class="web-src-chev" :class="{ open }" />
    </button>
    <ol v-if="open" class="web-src-list" data-chat-sources-list>
      <li v-for="(s, i) in sources" :key="s.url">
        <a :href="s.url" class="web-src-card" data-chat-source :title="s.url" @click.prevent="emit('open', s.url, s.title, $event)">
          <span class="web-src-top">
            <span class="web-src-n">{{ i + 1 }}</span>
            <SiteIcon :host="s.host" :size="14" />
            <span class="web-src-host">{{ s.host }}</span>
            <span v-if="s.cited" class="web-src-tag">已引用</span>
            <span v-else-if="s.read" class="web-src-tag">已读</span>
          </span>
          <span class="web-src-title">{{ s.title }}</span>
          <span v-if="s.snippet" class="web-src-snippet">{{ s.snippet }}</span>
        </a>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.web-src { margin: 8px 0 0; }
.web-src-btn { display: inline-flex; align-items: center; gap: 7px; height: 28px; padding: 0 10px 0 6px; border-radius: 999px; background: rgb(var(--text-rgb) / 0.05); font-size: 12.5px; color: rgb(var(--text-rgb) / 0.7); }
.web-src-btn:hover { background: rgb(var(--text-rgb) / 0.09); color: var(--text); }
.web-src-stack { display: inline-flex; }
.web-src-stack > :deep(.site-ic) + :deep(.site-ic) { margin-left: -5px; }
.web-src-stack > :deep(.site-ic) { box-shadow: 0 0 0 1.5px var(--bg, #fff); }
.web-src-chev { opacity: 0.6; transition: transform 150ms cubic-bezier(0.33, 1, 0.68, 1); }
.web-src-chev.open { transform: rotate(90deg); }
.web-src-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 6px; margin: 8px 0 0; padding: 0; list-style: none; }
.web-src-card { display: flex; flex-direction: column; gap: 3px; height: 100%; padding: 8px 10px; border-radius: 10px; background: rgb(var(--text-rgb) / 0.045); color: var(--text); text-decoration: none; box-sizing: border-box; }
.web-src-card:hover { background: rgb(var(--text-rgb) / 0.08); }
.web-src-top { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; color: rgb(var(--text-rgb) / 0.55); }
.web-src-n { flex: none; min-width: 14px; font-variant-numeric: tabular-nums; color: rgb(var(--text-rgb) / 0.4); }
.web-src-host { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.web-src-tag { flex: none; margin-left: auto; padding: 0 6px; border-radius: 999px; background: rgb(var(--text-rgb) / 0.07); font-size: 11px; line-height: 18px; }
.web-src-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 13px; line-height: 1.45; }
.web-src-snippet { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 12px; line-height: 1.45; color: rgb(var(--text-rgb) / 0.55); }
</style>
