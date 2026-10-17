<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Download, Eye, RefreshCw } from "lucide-vue-next";
import DsBadge from "../design-system/DsBadge.vue";
import DsButton from "../design-system/DsButton.vue";
import DsPageState from "../design-system/DsPageState.vue";
import {
  domainBridge,
  failureText,
  formatBytes,
  invokeDomain,
  resultFailure,
  resultValue,
  type FailureView,
} from "../bridge/domain";

/**
 * 系统字体（0.6.1 · 设置 › 外观，接既有 systemFonts:command）。
 *
 * 只读本机字体目录的清单（id / 字体族 / 字节数），按需才读单个字体字节做本机预览。
 * 桥面拿不到字体绝对路径；预览用 FontFace 在渲染进程里临时注册，卸载时删除。
 * 字体只在内存里预览，不写入、不替换系统字体。
 */
type FontEntry = { id: string; families: string[]; bytes: number };
type ListValue = {
  fonts?: FontEntry[];
  total?: number;
  offset?: number;
  limit?: number;
  hasMore?: boolean;
  source?: string;
  rootCount?: number;
};

const hasBridge = ref(!!domainBridge(typeof window === "undefined" ? null : window, "systemFonts"));
const loading = ref(false);
const error = ref<FailureView | null>(null);
const fonts = ref<FontEntry[]>([]);
const meta = ref<{ total: number; hasMore: boolean; rootCount: number; limit: number } | null>(null);
const query = ref("");
const previewFamily = ref("");
const previewName = ref("");
const previewError = ref<FailureView | null>(null);
const previewBusy = ref<string | null>(null);
const previewSize = ref(16);
const SAMPLE = "OpenArc OS · 系统字体预览 0123456789";
const loadedFaces: FontFace[] = [];

const visible = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return fonts.value;
  return fonts.value.filter((font) => font.families.join(" ").toLowerCase().includes(q) || font.id.toLowerCase().includes(q));
});

async function send(command: string, payload: Record<string, unknown> = {}) {
  if (!hasBridge.value) return { ok: false, error: "BRIDGE_ABSENT" };
  return invokeDomain("systemFonts", command, payload);
}

async function load(append = false) {
  loading.value = true;
  error.value = null;
  const offset = append ? fonts.value.length : 0;
  const reply = await send("systemFonts/list", { offset, limit: 40, refresh: !append });
  loading.value = false;
  const value = resultValue<ListValue>(reply);
  if (!value) {
    error.value = resultFailure(reply);
    return;
  }
  const next = Array.isArray(value.fonts) ? value.fonts : [];
  fonts.value = append ? [...fonts.value, ...next] : next;
  meta.value = {
    total: Number(value.total) || 0,
    hasMore: value.hasMore === true,
    rootCount: Number(value.rootCount) || 0,
    limit: Number(value.limit) || 40,
  };
}

async function preview(font: FontEntry) {
  previewBusy.value = font.id;
  previewError.value = null;
  const reply = await send("systemFonts/read", { id: font.id });
  const value = resultValue<{ data?: string; encoding?: string; families?: string[]; bytes?: number }>(reply);
  previewBusy.value = null;
  if (!value?.data) {
    previewError.value = resultFailure(reply);
    return;
  }
  try {
    const base64 = value.data.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const family = "oa-preview-" + font.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
    const face = new FontFace(family, bytes.buffer);
    await face.load();
    document.fonts.add(face);
    loadedFaces.push(face);
    previewFamily.value = family;
    previewName.value = (value.families?.length ? value.families.join(" / ") : font.families.join(" / ")) || font.id;
  } catch {
    previewError.value = { code: "FONT_PREVIEW_FAILED", message: "系统拒绝在当前窗口解析这个字体文件；清单信息仍然有效。" };
  }
}

onMounted(() => {
  void load(false);
});
onBeforeUnmount(() => {
  for (const face of loadedFaces) {
    try {
      document.fonts.delete(face);
    } catch {
      /* 已卸载 */
    }
  }
});
</script>

<template>
  <section class="set-sec font-sec" data-system-fonts>
    <div class="set-sh">
      <h3>系统字体</h3>
      <span class="font-actions">
        <label class="font-search">
          <span class="font-search-label">搜索</span>
          <input v-model="query" type="search" placeholder="字体族或 id" aria-label="搜索本机字体" />
        </label>
        <DsButton size="sm" variant="ghost" :status="loading ? 'loading' : 'idle'" data-system-fonts-refresh @click="load(false)">
          <RefreshCw :size="13" /> 刷新清单
        </DsButton>
      </span>
    </div>
    <p class="set-cap">
      只读本机字体目录：清单由主进程扫描，字体字节按需读取，单个字体上限 64 MB；界面拿不到文件路径，也不安装、不替换系统字体。
    </p>

    <DsPageState
      v-if="!hasBridge"
      kind="unavailable"
      title="当前环境没有系统字体域的桥"
      description="浏览器预览不提供 systemFonts:command；请在 OpenArc 桌面应用中打开设置。"
    />
    <DsPageState v-else-if="error" kind="error" title="读不到本机字体" :description="failureText(error)" :on-action="() => void load(false)" />
    <DsPageState
      v-else-if="!fonts.length && !loading"
      kind="empty"
      title="本机字体目录里没有可读取的字体"
      :description="meta ? '扫描到 ' + meta.rootCount + ' 个字体目录，但没有返回字体文件。' : '扫描结果为空。'"
    />

    <template v-else>
      <div v-if="meta" class="font-meta">
        共 {{ meta.total }} 个字体 · 当前载入 {{ fonts.length }} 个 · 每次 {{ meta.limit }} 个
        <template v-if="query.trim()"> · 搜索命中 {{ visible.length }} 个（只作用于已载入的页）</template>
      </div>

      <ul class="font-list" data-system-fonts-list>
        <li v-for="font in visible" :key="font.id" class="font-row" :data-system-font="font.id">
          <span class="font-family">{{ font.families.length ? font.families.join(" / ") : font.id }}</span>
          <span class="font-bytes">{{ formatBytes(font.bytes) }}</span>
          <DsButton size="sm" variant="ghost" :status="previewBusy === font.id ? 'loading' : 'idle'" @click="preview(font)">
            <Eye :size="13" /> 预览
          </DsButton>
        </li>
      </ul>
      <p v-if="!visible.length" class="set-cap">当前这页没有匹配的字体；可以继续载入下一页再搜索。</p>

      <div v-if="meta?.hasMore" class="font-more">
        <DsButton size="sm" variant="secondary" :status="loading ? 'loading' : 'idle'" @click="load(true)">
          <Download :size="13" /> 载入更多（{{ fonts.length }} / {{ meta.total }}）
        </DsButton>
      </div>

      <div v-if="previewFamily" class="font-preview" data-system-fonts-preview>
        <div class="font-preview-head">
          <span>预览：{{ previewName }}</span>
          <span class="toolbar-spacer" />
          <label class="font-size">
            字号
            <input v-model.number="previewSize" type="range" min="12" max="40" step="1" aria-label="预览字号" />
            <span class="font-size-value">{{ previewSize }}px</span>
          </label>
        </div>
        <p class="font-sample" :style="{ fontFamily: previewFamily, fontSize: previewSize + 'px' }">{{ SAMPLE }}</p>
        <p class="set-cap">预览只在本窗口内临时注册，离开后自动移除；不会替换系统或界面字体。</p>
      </div>
      <p v-if="previewError" class="font-error" role="alert">{{ failureText(previewError) }}</p>
    </template>
  </section>
</template>

<style scoped>
.font-sec .set-sh { align-items: center; }
.font-actions { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.font-search { display: flex; align-items: center; gap: var(--space-1); font-size: var(--fs-caption); color: var(--muted); }
.font-search-label { font-size: var(--fs-micro); }
.font-search input {
  min-height: 26px;
  width: 150px;
  padding: 2px var(--space-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: rgb(var(--content-rgb) / 0.5);
  color: var(--text);
  font-size: var(--fs-caption);
}
.font-search input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.font-meta { font-size: var(--fs-micro); color: var(--muted); margin-bottom: var(--space-2); }
.font-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; max-height: 320px; overflow: auto; }
.font-row { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-1) var(--space-2); border-radius: var(--radius-sm); background: rgb(var(--text-rgb) / 0.03); }
.font-row:hover { background: rgb(var(--text-rgb) / 0.06); }
.font-family { flex: 1 1 auto; min-width: 0; font-size: var(--fs-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.font-bytes { font-size: var(--fs-micro); color: var(--muted); font-variant-numeric: tabular-nums; }
.font-more { margin-top: var(--space-2); }
.font-preview { margin-top: var(--space-3); padding: var(--space-3); border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.04); }
.font-preview-head { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; font-size: var(--fs-caption); color: var(--muted); }
.font-size { display: flex; align-items: center; gap: var(--space-1); }
.font-size input { width: 96px; }
.font-size-value { font-variant-numeric: tabular-nums; }
.font-sample { margin: var(--space-2) 0; font-weight: var(--fw-regular); color: var(--text); line-height: var(--lh-normal); overflow-wrap: anywhere; }
.font-error { margin: var(--space-2) 0 0; color: var(--failed); font-size: var(--fs-caption); }
</style>
