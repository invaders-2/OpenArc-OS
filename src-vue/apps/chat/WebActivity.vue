<script setup lang="ts">
import { computed, ref } from "vue";
import { BookOpen, ChevronRight, Globe, Search } from "lucide-vue-next";
import SiteIcon from "./SiteIcon.vue";
import { hostOf, webSummary, type WebAct } from "./web";

/**
 * 联网过程（参照 Codex / ChatGPT）：
 *   · 进行中：「正在搜索：xxx」带流光，下面逐条列出已搜 / 已读，默认展开；
 *   · 结束后：收成一行「搜索了 2 次，读了 3 个网页 · 9 个网站」+ 图标叠放，点开看每次的搜索词和结果。
 */
const props = defineProps<{ acts: WebAct[]; live: boolean }>();
const emit = defineEmits<{ (e: "open", url: string, title: string, ev: MouseEvent): void }>();

const flipped = ref(false);
const open = computed(() => (props.live ? !flipped.value : flipped.value));
const moreOpen = ref<Set<string>>(new Set());
const current = computed(() => (props.live ? [...props.acts].reverse().find((a) => a.phase === "start") || null : null));
const headText = computed(() => {
  const c = current.value;
  if (c) return c.kind === "search" ? "正在搜索：" + c.query : "正在读取：" + (hostOf(c.url || "") || c.url);
  return webSummary(props.acts);
});
const stack = computed(() => {
  const hosts: string[] = [];
  for (const a of props.acts) {
    const list = a.kind === "fetch" && a.url ? [a.url] : a.results.map((r) => r.url);
    for (const u of list) { const h = hostOf(u); if (h && !hosts.includes(h)) hosts.push(h); }
  }
  return hosts.slice(0, 4);
});
const SHOW = 4;
function toggleMore(key: string) { const n = new Set(moreOpen.value); if (n.has(key)) n.delete(key); else n.add(key); moreOpen.value = n; }
const failText = (a: WebAct) => (a.error === "WEB_NO_RESULTS" ? "没有搜到结果" : a.error === "WEB_BLOCKED_HOST" ? "这个地址不允许访问" : a.error === "WEB_TIMEOUT" ? "超时" : "失败");
</script>

<template>
  <section class="web-act" :class="{ live: !!current }" data-chat-web :data-chat-web-open="open ? '1' : '0'">
    <button type="button" class="web-head" :aria-expanded="open" data-chat-web-toggle @click="flipped = !flipped">
      <Globe :size="14" class="web-led" />
      <span class="web-head-text" data-chat-web-summary>{{ headText }}</span>
      <span v-if="!current && stack.length" class="web-stack" aria-hidden="true"><SiteIcon v-for="h in stack" :key="h" :host="h" :size="16" /></span>
      <ChevronRight :size="15" class="web-chev" :class="{ open }" />
    </button>
    <ol v-if="open" class="web-steps" data-chat-web-steps>
      <li v-for="a in acts" :key="a.key" class="web-step" :data-chat-web-kind="a.kind" :data-chat-web-phase="a.phase" :class="{ 'is-failed': a.phase === 'done' && !a.ok, 'is-running': a.phase === 'start' }">
        <template v-if="a.kind === 'search'">
          <div class="web-step-line">
            <Search :size="13" class="web-step-ic" />
            <span class="web-step-text"><span class="web-verb">{{ a.phase === "start" ? "正在搜索" : "已搜索" }}</span><span class="web-query" data-chat-web-query>{{ a.query }}</span></span>
            <small v-if="a.phase === 'done'" class="web-step-meta">{{ a.ok ? a.results.length + " 个结果" : failText(a) }}</small>
          </div>
          <ul v-if="a.phase === 'done' && a.results.length" class="web-results" data-chat-web-results>
            <li v-for="r in (moreOpen.has(a.key) ? a.results : a.results.slice(0, SHOW))" :key="r.url">
              <a :href="r.url" class="web-result" data-chat-web-result :title="r.url" @click.prevent="emit('open', r.url, r.title, $event)">
                <SiteIcon :host="hostOf(r.url)" :size="14" />
                <span class="web-result-title">{{ r.title }}</span>
                <span class="web-result-host">{{ hostOf(r.url) }}</span>
              </a>
            </li>
            <li v-if="a.results.length > SHOW"><button type="button" class="web-more" @click="toggleMore(a.key)">{{ moreOpen.has(a.key) ? "收起" : "再显示 " + (a.results.length - SHOW) + " 条" }}</button></li>
          </ul>
        </template>
        <div v-else class="web-step-line">
          <BookOpen :size="13" class="web-step-ic" />
          <span class="web-step-text">
            <span class="web-verb">{{ a.phase === "start" ? "正在读取" : a.ok ? "已读取" : "读取失败" }}</span>
            <a :href="a.url" class="web-page" data-chat-web-page :title="a.url" @click.prevent="emit('open', a.url!, a.title || '', $event)">
              <SiteIcon :host="hostOf(a.url || '')" :size="14" />
              <span class="web-page-title">{{ a.title || hostOf(a.url || "") }}</span>
              <span v-if="a.title" class="web-result-host">{{ hostOf(a.url || "") }}</span>
            </a>
          </span>
          <small v-if="a.phase === 'done' && !a.ok" class="web-step-meta">{{ failText(a) }}</small>
        </div>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.web-act { margin: 0 0 8px; }
.web-head { display: flex; align-items: center; gap: 7px; max-width: 100%; height: 26px; padding: 0 2px; font-size: 13px; color: var(--muted); text-align: left; }
.web-head:hover { color: var(--text); }
.web-led { flex: none; opacity: 0.7; }
.web-head-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.web-act.live .web-head-text { background: linear-gradient(90deg, rgb(var(--text-rgb) / 0.45), rgb(var(--text-rgb) / 0.95), rgb(var(--text-rgb) / 0.45)); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: web-shimmer 1.6s linear infinite; }
@keyframes web-shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
.web-stack { display: inline-flex; flex: none; }
.web-stack > :deep(.site-ic) + :deep(.site-ic) { margin-left: -5px; }
.web-stack > :deep(.site-ic) { box-shadow: 0 0 0 1.5px var(--bg, #fff); }
.web-chev { flex: none; opacity: 0.6; transition: transform 150ms cubic-bezier(0.33, 1, 0.68, 1); }
.web-chev.open { transform: rotate(90deg); }
.web-steps { margin: 2px 0 4px 7px; padding: 2px 0 2px 14px; border-left: 1px solid rgb(var(--text-rgb) / 0.1); display: flex; flex-direction: column; gap: 4px; list-style: none; }
.web-step-line { display: flex; align-items: center; gap: 6px; min-height: 24px; font-size: 13px; color: rgb(var(--text-rgb) / 0.66); }
.web-step-ic { flex: none; opacity: 0.55; }
.web-step-text { display: inline-flex; align-items: center; gap: 6px; min-width: 0; flex: 1 1 auto; }
.web-verb { flex: none; }
.web-query { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.web-step-meta { flex: none; font-size: 12px; color: rgb(var(--text-rgb) / 0.45); }
.web-step.is-failed .web-step-meta { color: var(--warning-text, #a05a00); }
.web-step.is-running .web-verb { background: linear-gradient(90deg, rgb(var(--text-rgb) / 0.4), rgb(var(--text-rgb) / 0.9), rgb(var(--text-rgb) / 0.4)); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: web-shimmer 1.6s linear infinite; }
.web-results { display: flex; flex-direction: column; gap: 1px; margin: 2px 0 2px 19px; padding: 0; list-style: none; }
.web-result, .web-page { display: flex; align-items: center; gap: 7px; min-width: 0; height: 26px; padding: 0 8px 0 6px; border-radius: 7px; color: var(--text); font-size: 12.5px; text-decoration: none; }
.web-page { display: inline-flex; height: 24px; padding: 0 6px; background: rgb(var(--text-rgb) / 0.05); }
.web-result:hover, .web-page:hover { background: rgb(var(--text-rgb) / 0.07); }
.web-result-title, .web-page-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.web-result-title { flex: 0 1 auto; }
.web-result-host { flex: none; font-size: 12px; color: rgb(var(--text-rgb) / 0.45); }
.web-more { margin-left: 6px; height: 22px; font-size: 12px; color: rgb(var(--text-rgb) / 0.55); }
.web-more:hover { color: var(--text); }
@media (prefers-reduced-motion: reduce) { .web-act.live .web-head-text, .web-step.is-running .web-verb { animation: none; color: var(--muted); background: none; } }
</style>
