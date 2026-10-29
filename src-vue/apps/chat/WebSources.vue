<script setup lang="ts">
import { computed, ref } from "vue";
import { ChevronRight, ExternalLink } from "lucide-vue-next";
import SiteIcon from "./SiteIcon.vue";
import { cardOf, type Source } from "./web";

/**
 * 回答下方的来源（ChatGPT / Perplexity 式）：默认露出前 3 张卡片（网页缩略图 + 网站 logo + 网站名 + 标题），
 * 「全部 N 个来源」展开其余。点卡片在预览侧栏打开，右上角 ↗ 直接在 OpenArc 浏览器打开。
 */
const props = defineProps<{ sources: Source[] }>();
const emit = defineEmits<{ (e: "open", url: string, title: string, ev: MouseEvent): void; (e: "browse", url: string): void }>();
const FIRST = 3;
const all = ref(false);
const shown = computed(() => (all.value ? props.sources : props.sources.slice(0, FIRST)));
const stack = computed(() => [...new Set(props.sources.map((s) => s.host))].slice(0, 4));
const siteOf = (s: Source) => cardOf(s.url)?.siteName || s.host;
const titleOf = (s: Source) => (s.title && s.title !== s.host ? s.title : cardOf(s.url)?.title || s.title);
const snippetOf = (s: Source) => s.snippet || cardOf(s.url)?.description || "";
</script>

<template>
  <div class="web-src" data-chat-sources>
    <div class="web-src-head">
      <span class="web-src-label">来源</span>
      <button v-if="sources.length > FIRST" type="button" class="web-src-btn" :aria-expanded="all" data-chat-sources-toggle @click="all = !all">
        <span class="web-src-stack" aria-hidden="true"><SiteIcon v-for="h in stack" :key="h" :host="h" :size="16" /></span>
        <span data-chat-sources-count>{{ all ? "收起" : "全部 " + sources.length + " 个来源" }}</span>
        <ChevronRight :size="14" class="web-src-chev" :class="{ open: all }" />
      </button>
      <span v-else class="web-src-count" data-chat-sources-count>{{ sources.length }} 个来源</span>
    </div>
    <ol class="web-src-list" data-chat-sources-list>
      <li v-for="(s, i) in shown" :key="s.url" class="web-src-item">
        <a :href="s.url" class="web-src-card" :class="{ 'has-thumb': !!cardOf(s.url)?.image }" data-chat-source :title="s.url" @click.prevent="emit('open', s.url, titleOf(s), $event)">
          <span v-if="cardOf(s.url)?.image" class="web-src-thumb" data-chat-source-thumb><img :src="cardOf(s.url)!.image" alt="" loading="lazy" /></span>
          <span class="web-src-body">
            <span class="web-src-top">
              <SiteIcon :host="s.host" :size="16" />
              <span class="web-src-host" data-chat-source-site>{{ siteOf(s) }}</span>
              <span v-if="s.cited" class="web-src-tag">已引用</span>
              <span v-else-if="s.read" class="web-src-tag">已读</span>
              <span class="web-src-n">{{ i + 1 }}</span>
            </span>
            <span class="web-src-title">{{ titleOf(s) }}</span>
            <span v-if="snippetOf(s)" class="web-src-snippet">{{ snippetOf(s) }}</span>
            <span class="web-src-url">{{ s.url.replace(/^https?:\/\/(www\.)?/, "") }}</span>
          </span>
        </a>
        <button type="button" class="web-src-go" data-chat-source-browse title="在浏览器打开" aria-label="在浏览器打开" @click="emit('browse', s.url)"><ExternalLink :size="13" /></button>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.web-src { margin: 10px 0 0; }
.web-src-head { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; }
.web-src-label { font-size: 12.5px; font-weight: 600; color: rgb(var(--text-rgb) / 0.7); }
.web-src-count { font-size: 12px; color: rgb(var(--text-rgb) / 0.45); }
.web-src-btn { display: inline-flex; align-items: center; gap: 7px; height: 26px; margin-left: auto; padding: 0 10px 0 6px; border-radius: 999px; background: rgb(var(--text-rgb) / 0.05); font-size: 12px; color: rgb(var(--text-rgb) / 0.7); }
.web-src-btn:hover { background: rgb(var(--text-rgb) / 0.09); color: var(--text); }
.web-src-stack { display: inline-flex; }
.web-src-stack > :deep(.site-ic) + :deep(.site-ic) { margin-left: -5px; }
.web-src-stack > :deep(.site-ic) { box-shadow: 0 0 0 1.5px var(--bg, #fff); }
.web-src-chev { opacity: 0.6; transition: transform 150ms cubic-bezier(0.33, 1, 0.68, 1); }
.web-src-chev.open { transform: rotate(90deg); }
.web-src-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; margin: 0; padding: 0; list-style: none; }
.web-src-item { position: relative; min-width: 0; }
.web-src-card { display: flex; flex-direction: column; height: 100%; overflow: hidden; border-radius: 12px; background: rgb(var(--text-rgb) / 0.045); box-shadow: inset 0 0 0 1px rgb(var(--text-rgb) / 0.06); color: var(--text); text-decoration: none; box-sizing: border-box; }
.web-src-card:hover { background: rgb(var(--text-rgb) / 0.08); }
.web-src-thumb { display: block; aspect-ratio: 1.91 / 1; overflow: hidden; background: rgb(var(--text-rgb) / 0.06); }
.web-src-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
.web-src-body { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px 9px; min-width: 0; }
.web-src-top { display: flex; align-items: center; gap: 6px; min-width: 0; padding-right: 22px; font-size: 12px; color: rgb(var(--text-rgb) / 0.62); }
.web-src-host { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.web-src-tag { flex: none; padding: 0 6px; border-radius: 999px; background: rgb(var(--text-rgb) / 0.07); font-size: 11px; line-height: 18px; }
.web-src-n { flex: none; margin-left: auto; font-size: 11px; font-variant-numeric: tabular-nums; color: rgb(var(--text-rgb) / 0.35); }
.web-src-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 13px; line-height: 1.45; }
.web-src-snippet { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 12px; line-height: 1.45; color: rgb(var(--text-rgb) / 0.55); }
.web-src-card.has-thumb .web-src-snippet { -webkit-line-clamp: 1; }
.web-src-url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: rgb(var(--text-rgb) / 0.4); }
.web-src-go { position: absolute; right: 6px; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 6px; color: rgb(var(--text-rgb) / 0.55); background: rgb(var(--surface-rgb, 255 255 255) / 0.85); opacity: 0; transition: opacity 120ms ease; top: 6px; }
.web-src-item:hover .web-src-go, .web-src-go:focus-visible { opacity: 1; }
.web-src-go:hover { color: var(--text); background: rgb(var(--text-rgb) / 0.12); }
.web-src-card:not(.has-thumb) ~ .web-src-go { top: 6px; }
</style>
