<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Check, Code2, Copy, ExternalLink, FileText, Globe, LoaderCircle, PanelRightClose, X } from "lucide-vue-next";
import { closeItem, closePreview, openInBrowser, preview, sizeText, type PreviewItem } from "./preview";
import { highlightCode, renderMarkdown } from "./markdown";

/**
 * 对话预览侧栏：网页、http 文件、Markdown、代码、图片、视频、音频、PDF、CSV 表格、生成的 HTML。
 * 网页预览不跑脚本（看个大概）；要完整网页点「在浏览器打开」。生成的 HTML 在沙箱里跑，不能联网。
 */
const active = computed<PreviewItem | null>(() => preview.items.find((x) => x.id === preview.activeId) || preview.items[preview.items.length - 1] || null);
/** 每个条目自己的视图模式：网页（渲染 / 阅读）、Markdown·HTML·CSV（渲染 / 源码） */
const modes = ref<Record<string, "render" | "source" | "reader">>({});
const mode = computed(() => (active.value ? modes.value[active.value.id] || "render" : "render"));
function setMode(m: "render" | "source" | "reader") { if (active.value) modes.value = { ...modes.value, [active.value.id]: m }; }
const copied = ref(false);
let copiedTimer = 0;
async function copyText() {
  const t = active.value?.text || "";
  try { await navigator.clipboard.writeText(t); } catch { /* 剪贴板不可用 */ }
  copied.value = true; window.clearTimeout(copiedTimer); copiedTimer = window.setTimeout(() => { copied.value = false; }, 1400);
}
const zoomed = ref(false);
watch(() => preview.activeId, () => { zoomed.value = false; });

const codeLines = computed(() => {
  const it = active.value; if (!it || it.text == null) return [] as string[];
  const html = it.kind === "text" ? escapeHtml(it.text) : highlightCode(it.text, it.lang || "");
  // 按行切开高亮结果（跨行的 span 在每行补齐开闭标签）
  const out: string[] = []; let open: string[] = [];
  for (const line of html.split("\n")) {
    const prefix = open.join("");
    const tags = line.match(/<span[^>]*>|<\/span>/g) || [];
    for (const t of tags) { if (t.startsWith("</")) open.pop(); else open.push(t); }
    out.push(prefix + line + "</span>".repeat(open.length));
    if (out.length >= 20000) break;
  }
  return out;
});
const mdHtml = computed(() => (active.value?.kind === "markdown" ? renderMarkdown(active.value.text || "") : ""));
const readerParas = computed(() => String(active.value?.text || "").split(/\n{1,}/).map((s) => s.trim()).filter(Boolean).slice(0, 600));

/** CSV / TSV：简单解析（支持引号与引号内换行），最多显示 500 行。 */
const csv = computed(() => {
  const it = active.value; if (!it || it.kind !== "csv") return { head: [] as string[], rows: [] as string[][], more: 0 };
  const text = String(it.text || "");
  const sep = it.lang === "tsv" || /\t/.test(text.split("\n")[0] || "") ? "\t" : ",";
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i += 1; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; if (rows.length > 520) break; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift() || [];
  return { head, rows: rows.slice(0, 500), more: Math.max(0, rows.length - 500) };
});

const canSource = computed(() => !!active.value && ["markdown", "html", "csv"].includes(active.value.kind) && active.value.text != null);
const canCopy = computed(() => !!active.value && active.value.text != null && active.value.kind !== "web");
const sourceUrl = computed(() => (active.value?.source.type === "url" && /^https?:/i.test(active.value.source.url) ? active.value.source.url : ""));
const wsPath = computed(() => (active.value?.source.type === "workspace" ? active.value.source.path : ""));
async function openSystem() { if (wsPath.value) await (window as any).openarc?.chat?.command({ command: "workspace/open", path: wsPath.value }).catch(() => null); }

/* 宽度：拖左边缘调整，记在本机（只是个人偏好） */
const width = ref(readWidth());
function readWidth() { try { const v = Number(localStorage.getItem("oa.chat.previewWidth")); return v >= 300 && v <= 1400 ? v : 460; } catch { return 460; } }
let drag: { x: number; w: number } | null = null;
function onDown(e: PointerEvent) { drag = { x: e.clientX, w: width.value }; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp, { once: true }); }
function onMove(e: PointerEvent) { if (!drag) return; width.value = Math.max(300, Math.min(1200, drag.w + (drag.x - e.clientX))); }
function onUp() { drag = null; window.removeEventListener("pointermove", onMove); try { localStorage.setItem("oa.chat.previewWidth", String(width.value)); } catch { /* ignore */ } }
onBeforeUnmount(() => { window.removeEventListener("pointermove", onMove); window.clearTimeout(copiedTimer); });

function escapeHtml(s: string) { return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;")); }
const KIND_LABEL: Record<string, string> = { web: "网页", image: "图片", video: "视频", audio: "音频", pdf: "PDF", markdown: "Markdown", csv: "表格", code: "代码", text: "文本", html: "HTML", file: "文件", loading: "加载中", error: "出错" };
</script>

<template>
  <aside class="chat-preview" data-chat-preview :style="{ width: width + 'px' }" aria-label="预览">
    <div class="chat-preview-grip" title="拖动调整宽度" @pointerdown="onDown" />
    <header class="chat-preview-tabs" role="tablist">
      <button v-for="it in preview.items" :key="it.id" type="button" role="tab" class="chat-preview-tab" :aria-selected="it.id === active?.id" :data-chat-preview-tab="it.kind" :title="it.title" @click="preview.activeId = it.id">
        <LoaderCircle v-if="it.kind === 'loading'" :size="12" class="spin" />
        <Globe v-else-if="it.kind === 'web'" :size="12" />
        <Code2 v-else-if="it.kind === 'code' || it.kind === 'html'" :size="12" />
        <FileText v-else :size="12" />
        <span>{{ it.title }}</span>
        <span class="chat-preview-x" role="button" aria-label="关闭这个预览" @click.stop="closeItem(it.id)"><X :size="11" /></span>
      </button>
      <span class="toolbar-spacer" />
      <button type="button" class="chat-preview-icon" title="收起预览" aria-label="收起预览" data-chat-preview-close @click="closePreview"><PanelRightClose :size="15" /></button>
    </header>

    <div v-if="active" class="chat-preview-bar">
      <span class="chat-preview-kind">{{ KIND_LABEL[active.kind] || active.kind }}<template v-if="active.size"> · {{ sizeText(active.size) }}</template><template v-if="active.truncated"> · 只显示了前一部分</template></span>
      <span class="toolbar-spacer" />
      <div v-if="active.kind === 'web'" class="chat-seg" role="group" aria-label="显示方式">
        <button type="button" :aria-pressed="mode !== 'reader'" @click="setMode('render')">网页</button>
        <button type="button" :aria-pressed="mode === 'reader'" data-chat-preview-reader @click="setMode('reader')">阅读</button>
      </div>
      <div v-if="canSource" class="chat-seg" role="group" aria-label="显示方式">
        <button type="button" :aria-pressed="mode !== 'source'" @click="setMode('render')">预览</button>
        <button type="button" :aria-pressed="mode === 'source'" data-chat-preview-source @click="setMode('source')">源码</button>
      </div>
      <button v-if="canCopy" type="button" class="chat-preview-btn" data-chat-preview-copy @click="copyText"><Check v-if="copied" :size="13" /><Copy v-else :size="13" />{{ copied ? "已复制" : "复制" }}</button>
      <button v-if="sourceUrl" type="button" class="chat-preview-btn" data-chat-preview-browser @click="openInBrowser(sourceUrl)"><ExternalLink :size="13" />在浏览器打开</button>
      <button v-if="wsPath" type="button" class="chat-preview-btn" data-chat-preview-system @click="openSystem"><ExternalLink :size="13" />用系统打开</button>
    </div>

    <div v-if="active" class="chat-preview-body" :data-kind="active.kind">
      <div v-if="active.kind === 'loading'" class="chat-preview-empty"><LoaderCircle :size="18" class="spin" /><p>正在打开…</p></div>
      <div v-else-if="active.kind === 'error'" class="chat-preview-empty" data-chat-preview-error><p>{{ active.error }}</p><button v-if="sourceUrl" type="button" class="chat-preview-btn" @click="openInBrowser(sourceUrl)">改用浏览器打开</button></div>

      <template v-else-if="active.kind === 'web'">
        <article v-if="mode === 'reader'" class="chat-preview-reader"><h2>{{ active.title }}</h2><p v-for="(p, i) in readerParas" :key="i">{{ p }}</p></article>
        <iframe v-else class="chat-preview-frame" :src="active.previewUrl" sandbox="" referrerpolicy="no-referrer" :title="active.title" data-chat-preview-frame />
      </template>
      <div v-else-if="active.kind === 'image'" class="chat-preview-media" :class="{ zoomed }" @click="zoomed = !zoomed"><img :src="active.previewUrl" :alt="active.title" data-chat-preview-image /></div>
      <div v-else-if="active.kind === 'video'" class="chat-preview-media"><video :src="active.previewUrl" controls playsinline data-chat-preview-video /></div>
      <div v-else-if="active.kind === 'audio'" class="chat-preview-media"><audio :src="active.previewUrl" controls data-chat-preview-audio /></div>
      <iframe v-else-if="active.kind === 'pdf'" class="chat-preview-frame" :src="active.previewUrl" :title="active.title" data-chat-preview-pdf />

      <template v-else-if="active.kind === 'markdown'">
        <pre v-if="mode === 'source'" class="chat-preview-src">{{ active.text }}</pre>
        <article v-else class="chat-md chat-preview-doc" data-chat-preview-md v-html="mdHtml" />
      </template>
      <template v-else-if="active.kind === 'html'">
        <div v-if="mode === 'source'" class="chat-preview-code"><ol><li v-for="(l, i) in codeLines" :key="i"><code class="hljs" v-html="l || ' '" /></li></ol></div>
        <iframe v-else class="chat-preview-frame chat-preview-frame-light" :src="active.previewUrl" sandbox="allow-scripts" :title="active.title" data-chat-preview-html />
      </template>
      <template v-else-if="active.kind === 'csv'">
        <pre v-if="mode === 'source'" class="chat-preview-src">{{ active.text }}</pre>
        <div v-else class="chat-preview-table" data-chat-preview-csv>
          <table><thead><tr><th v-for="(h, i) in csv.head" :key="i">{{ h }}</th></tr></thead>
            <tbody><tr v-for="(r, i) in csv.rows" :key="i"><td v-for="(c, j) in r" :key="j">{{ c }}</td></tr></tbody></table>
          <p v-if="csv.more" class="chat-preview-note">还有 {{ csv.more }} 行没显示。</p>
        </div>
      </template>
      <div v-else-if="active.kind === 'code' || active.kind === 'text'" class="chat-preview-code" data-chat-preview-code><ol><li v-for="(l, i) in codeLines" :key="i"><code class="hljs" v-html="l || ' '" /></li></ol></div>
      <div v-else class="chat-preview-empty"><FileText :size="22" /><p>{{ active.title }}</p><small>这种文件没法直接预览。</small><button v-if="wsPath" type="button" class="chat-preview-btn" @click="openSystem">用系统打开</button></div>
    </div>
  </aside>
</template>
