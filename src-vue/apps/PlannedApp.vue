<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Sparkles } from "lucide-vue-next";
import { appById, iconUrl } from "../apps";
import { useShellStore } from "../stores/shell";
import { kindOfExt } from "../wallpapers";

/**
 * 原型里有、后台还没接的应用（10-15）：外壳按原型（侧栏分组 + 内容区），内容如实显示空态。
 * 不放任何演示数据。两处例外用的是真实数据 / 纯本地计算：
 *   · 日历：月视图是纯日期计算；日程来源未接入 → 每天都没有日程
 *   · 相册：汇总访达（桌面 + 各文件夹）里真实存在的图片，缩略图走文件服务
 */
const props = defineProps<{ appId: string }>();
const shell = useShellStore();
const app = computed(() => appById(props.appId));

type Spec = { side: [string, string[]][]; title: string; body: string; action?: "ai" };
const SPECS: Record<string, Spec> = {








  browser: {
    side: [],
    title: "浏览器正在迁移到新壳层",
    body: "浏览器使用原生网页视图，需要与窗口几何、遮挡与下载协同，迁移进行中。当前请在旧版界面中使用浏览器。",
  },
};
const spec = computed<Spec>(
  () => SPECS[props.appId] ?? { side: [], title: "该应用尚未接入", body: "内容接入后会在这里显示。" },
);
const active = ref("");

/* ── 相册：访达里的真实图片 ── */
type Photo = { key: string; folderId: string; id: string; name: string; ext: string; thumb: string };
const photos = ref<Photo[]>([]);
const loading = ref(false);
async function loadPhotos() {
  const b = window.openarc?.files;
  if (!b) return;
  loading.value = true;
  const folderIds = ["desktop", ...shell.folders.map((f) => f.id)];
  const out: Photo[] = [];
  for (const fid of folderIds) {
    const res = await b.list(fid).catch(() => null);
    for (const e of res?.entries ?? []) {
      if (kindOfExt(e.ext) !== "image") continue;
      out.push({ key: fid + "/" + e.id, folderId: fid, id: e.id, name: e.name, ext: e.ext, thumb: "" });
    }
  }
  photos.value = out;
  loading.value = false;
  // 必须遍历响应式的 photos.value：改原始对象不会触发重渲染
  for (const p of photos.value) {
    const t = await b.thumb?.(p.folderId, p.id).catch(() => null);
    if (t?.ok && t.dataUrl) p.thumb = t.dataUrl;
  }
}
onMounted(() => {
  if (props.appId === "photos") void loadPhotos();
});
</script>

<template>
  <!-- 相册 -->
  <div v-if="appId === 'photos'" class="split planned-app">
    <nav class="split-side" aria-label="相册">
      <div class="split-section">相册</div>
      <button type="button" class="split-nav" aria-current="true">全部照片</button>
      <p class="planned-note">汇总访达（桌面与各文件夹）里的图片。</p>
    </nav>
    <div class="split-main">
      <div class="pane-toolbar">
        <strong class="pane-title">全部照片</strong>
        <span class="badge">{{ photos.length }} 张</span>
      </div>
      <div v-if="!photos.length" class="empty-content">
        <img class="large-icon" :src="iconUrl('photos')" alt="" draggable="false" />
        <p>{{ loading ? "正在读取…" : "访达里还没有图片。把图片拖进访达即可在这里看到。" }}</p>
      </div>
      <div v-else class="photo-grid">
        <button
          v-for="p in photos"
          :key="p.key"
          class="photo-cell"
          :title="p.name"
          @dblclick="shell.openPreview(p.folderId, p)"
        >
          <img v-if="p.thumb" :src="p.thumb" alt="" draggable="false" />
          <span v-else class="photo-ph">{{ p.ext }}</span>
        </button>
      </div>
    </div>
  </div>

  <!-- 其它：原型外壳 + 真实空态 -->
  <div v-else :class="spec.side.length ? 'split planned-app' : 'planned-app planned-solo'">
    <nav v-if="spec.side.length" class="split-side" :aria-label="app?.name">
      <template v-for="[group, items] in spec.side" :key="group">
        <div class="split-section">{{ group }}</div>
        <button
          v-for="(it, i) in items"
          :key="it"
          type="button"
          class="split-nav"
          :aria-current="(active || spec.side[0][1][0]) === it ? 'true' : undefined"
          @click="active = it"
        >
          <span class="split-nav-label">{{ it }}</span>
          <small v-if="i === 0 && group === spec.side[0][0]" class="planned-count">0</small>
        </button>
      </template>
    </nav>
    <div class="split-main">
      <div class="empty-content">
        <img class="large-icon" :src="iconUrl(app?.icon || 'apps')" alt="" draggable="false" />
        <h2 class="planned-title">{{ spec.title }}</h2>
        <p>{{ spec.body }}</p>
        <button v-if="spec.action === 'ai'" class="planned-cta" @click="shell.toggleAI()">
          <Sparkles :size="14" /> 让全局 AI 开始一项任务
        </button>
      </div>
    </div>
  </div>
</template>
