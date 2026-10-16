<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ChevronLeft, ChevronRight, Download, Pause, Play, Plus, Trash2, X } from "lucide-vue-next";
import { iconUrl } from "../apps";
import { useShellStore } from "../stores/shell";
import { fileUrl, kindOfExt } from "../wallpapers";

/**
 * 视频剪辑（10-15）：把访达里的视频片段按顺序拼接、裁剪入出点，用本机 FFmpeg 导出 MP4。
 *   · 素材 = 访达（桌面 + 各文件夹）里的视频；预览走只读文件协议（主进程回 Range，可拖动）；
 *   · 导出参数模板固定在主进程（electron/video-service.cjs），这里只给条目引用 + 入出点；
 *   · 成片保存到桌面「视频剪辑」文件夹；工程（片段顺序与入出点）存本机 localStorage。
 */
type Asset = { key: string; folderId: string; id: string; name: string };
type Clip = { uid: string; folderId: string; id: string; name: string; duration: number; start: number; end: number };

const shell = useShellStore();
const bridge = window.openarc?.video;
const KEY = "oa-video-project";
const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    return null;
  }
})();
const project = reactive<{ name: string; resolution: string; clips: Clip[] }>({
  name: typeof saved?.name === "string" ? saved.name : "未命名剪辑",
  resolution: typeof saved?.resolution === "string" ? saved.resolution : "1080p",
  clips: Array.isArray(saved?.clips) ? saved.clips : [],
});
watch(project, () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(project));
  } catch {
    /* 存储不可用 */
  }
}, { deep: true });

const ff = ref<{ available: boolean; version?: string } | null>(null);
const assets = ref<Asset[]>([]);
const selected = ref<string | null>(project.clips[0]?.uid ?? null);
const clip = computed(() => project.clips.find((c) => c.uid === selected.value) ?? null);
const player = ref<HTMLVideoElement | null>(null);
const playing = ref(false);
const playAll = ref(false);
const now = ref(0);
const exporting = ref(false);
const progress = ref(0);
const message = ref("");
const adding = ref<string | null>(null);

const total = computed(() => project.clips.reduce((s, c) => s + (c.end - c.start), 0));
const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};
const baseName = (n: string) => n.replace(/\.[^.]+$/, "");

async function loadAssets() {
  const b = window.openarc?.files;
  if (!b) return;
  const out: Asset[] = [];
  for (const fid of ["desktop", ...shell.folders.map((f) => f.id)]) {
    const res = await b.list(fid).catch(() => null);
    for (const e of res?.entries ?? []) if (kindOfExt(e.ext) === "video") out.push({ key: fid + "/" + e.id, folderId: fid, id: e.id, name: e.name });
  }
  assets.value = out;
}

async function add(a: Asset) {
  if (!bridge || adding.value) return;
  adding.value = a.key;
  message.value = "";
  const info = await bridge.probe(a.folderId, a.id).catch(() => null);
  adding.value = null;
  if (!info?.ok || !info.duration) {
    message.value = info?.error === "FFMPEG_MISSING" ? "没有找到 FFmpeg" : "无法读取这个视频";
    return;
  }
  const c: Clip = { uid: "c" + Date.now().toString(36), folderId: a.folderId, id: a.id, name: a.name, duration: info.duration, start: 0, end: info.duration };
  project.clips.push(c);
  select(c.uid);
}
function remove(uid: string) {
  const i = project.clips.findIndex((c) => c.uid === uid);
  project.clips.splice(i, 1);
  selected.value = project.clips[Math.min(i, project.clips.length - 1)]?.uid ?? null;
}
function move(n: number) {
  const i = project.clips.findIndex((c) => c.uid === selected.value);
  const j = i + n;
  if (i < 0 || j < 0 || j >= project.clips.length) return;
  const [c] = project.clips.splice(i, 1);
  project.clips.splice(j, 0, c);
}
function select(uid: string) {
  selected.value = uid;
  playAll.value = false;
  requestAnimationFrame(() => {
    const v = player.value;
    if (v && clip.value) v.currentTime = clip.value.start;
  });
}
function setIn() {
  const c = clip.value;
  if (c && player.value) c.start = Math.min(+player.value.currentTime.toFixed(2), c.end - 0.1);
}
function setOut() {
  const c = clip.value;
  if (c && player.value) c.end = Math.max(+player.value.currentTime.toFixed(2), c.start + 0.1);
}
function clamp(c: Clip) {
  c.start = Math.max(0, Math.min(Number(c.start) || 0, c.duration - 0.1));
  c.end = Math.max(c.start + 0.1, Math.min(Number(c.end) || c.duration, c.duration));
}

function onLoaded() {
  if (player.value && clip.value) player.value.currentTime = clip.value.start;
  if (playAll.value) void player.value?.play();
}
function onTime() {
  const v = player.value;
  const c = clip.value;
  if (!v || !c) return;
  now.value = v.currentTime;
  if (v.currentTime >= c.end) {
    if (playAll.value) {
      const i = project.clips.findIndex((x) => x.uid === c.uid);
      const next = project.clips[i + 1];
      if (next) {
        selected.value = next.uid;
        return;
      }
      playAll.value = false;
    }
    v.pause();
    v.currentTime = c.end;
  }
}
function togglePlay() {
  const v = player.value;
  if (!v || !clip.value) return;
  if (v.paused) {
    if (v.currentTime >= clip.value.end - 0.05) v.currentTime = clip.value.start;
    void v.play();
  } else v.pause();
}
function previewAll() {
  if (!project.clips.length) return;
  playAll.value = true;
  if (selected.value === project.clips[0].uid && player.value) {
    player.value.currentTime = project.clips[0].start;
    void player.value.play();
  } else selected.value = project.clips[0].uid;
}

const ERR: Record<string, string> = {
  FFMPEG_MISSING: "没有找到 FFmpeg",
  BUSY: "已有导出任务在进行",
  CANCELLED: "已取消导出",
  CLIP_TOO_SHORT: "有片段太短（至少 0.1 秒）",
  TOO_LONG: "成片超过 2 小时",
  NOT_FOUND: "有素材已不在访达里",
  ENCODE_FAILED: "编码失败",
  IMPORT_FAILED: "成片保存失败",
};
async function exportVideo() {
  if (!bridge || !project.clips.length || exporting.value) return;
  exporting.value = true;
  progress.value = 0;
  message.value = "";
  const folder = shell.ensureFolder("视频剪辑");
  const r = await bridge.export({
    clips: project.clips.map((c) => ({ folderId: c.folderId, id: c.id, start: c.start, end: c.end })),
    resolution: project.resolution,
    folderId: folder.id,
    name: project.name,
  }).catch(() => null);
  exporting.value = false;
  if (r?.ok && r.entry) {
    message.value = `已导出「${r.entry.name}」到桌面「视频剪辑」文件夹`;
    shell.notify({ appId: "video", title: "视频导出完成", body: r.entry.name });
  } else {
    message.value = (ERR[r?.error ?? ""] ?? "导出失败") + (r?.detail ? `：${r.detail}` : "");
  }
}

let offProgress: (() => void) | null = null;
onMounted(async () => {
  offProgress = bridge?.onProgress((e) => (progress.value = e.ratio)) ?? null;
  ff.value = bridge ? await bridge.status().catch(() => ({ available: false })) : null;
  void loadAssets();
});
onBeforeUnmount(() => offProgress?.());
</script>

<template>
  <div class="split video-app">
    <nav class="split-side" aria-label="素材">
      <div class="split-section">素材 <small class="planned-count">{{ assets.length }}</small></div>
      <div class="notes-list">
        <button v-for="a in assets" :key="a.key" type="button" class="notes-item vd-asset" :disabled="!ff?.available" @click="add(a)">
          <span class="notes-item-name">{{ baseName(a.name) }}</span>
          <small>{{ adding === a.key ? "正在读取…" : "点按加入时间线" }}</small>
          <Plus class="vd-asset-plus" :size="13" />
        </button>
        <p v-if="!assets.length" class="planned-note">访达里还没有视频。把 mp4 / mov 拖进访达即可在这里使用。</p>
      </div>
      <p class="planned-note">
        {{ !bridge ? "需要 OpenArc 桌面应用。" : ff === null ? "正在检测 FFmpeg…" : ff.available ? `本机 ${ff.version}` : "没有找到 FFmpeg：请先安装（例如 brew install ffmpeg）。" }}
      </p>
    </nav>

    <div class="split-main vd-main">
      <div class="pane-toolbar">
        <input v-model="project.name" class="notes-title" aria-label="剪辑名称" />
        <div class="toolbar-spacer" />
        <select v-model="project.resolution" class="vd-select" aria-label="导出分辨率">
          <option value="1080p">1080p</option>
          <option value="720p">720p</option>
          <option value="480p">480p</option>
          <option value="source">与首个片段一致</option>
        </select>
        <button v-if="exporting" class="planned-today" @click="bridge?.cancel()"><X :size="12" /> 取消</button>
        <button v-else class="planned-cta vd-export" :disabled="!project.clips.length || !ff?.available" @click="exportVideo">
          <Download :size="13" /> 导出
        </button>
      </div>
      <div v-if="exporting" class="vd-progress" role="progressbar" :aria-valuenow="Math.round(progress * 100)"><span :style="{ width: progress * 100 + '%' }" /></div>
      <p v-if="message" class="vd-msg">{{ message }}</p>

      <div v-if="!project.clips.length" class="empty-content">
        <img class="large-icon" :src="iconUrl('video')" alt="" draggable="false" />
        <h2 class="planned-title">从左侧加入片段</h2>
        <p>按顺序拼接多个视频，裁剪每段的入点和出点，然后导出成一个 MP4。</p>
      </div>
      <template v-else>
        <div class="vd-stage">
          <video
            v-if="clip"
            ref="player"
            :key="clip.uid"
            class="vd-video"
            :src="fileUrl(clip.folderId, clip.id)"
            preload="auto"
            @loadedmetadata="onLoaded"
            @timeupdate="onTime"
            @play="playing = true"
            @pause="playing = false"
          />
        </div>
        <div class="vd-controls">
          <button class="music-play" :aria-label="playing ? '暂停' : '播放片段'" @click="togglePlay"><Pause v-if="playing" :size="15" /><Play v-else :size="15" /></button>
          <button class="planned-today" @click="previewAll">预览全片</button>
          <span class="mono vd-time">{{ fmt(now) }}</span>
          <div class="toolbar-spacer" />
          <template v-if="clip">
            <label class="vd-field">入点 <input v-model.number="clip.start" type="number" step="0.1" min="0" @change="clamp(clip)" /></label>
            <button class="planned-today" title="把入点设为当前播放位置" @click="setIn">设为当前</button>
            <label class="vd-field">出点 <input v-model.number="clip.end" type="number" step="0.1" min="0" @change="clamp(clip)" /></label>
            <button class="planned-today" title="把出点设为当前播放位置" @click="setOut">设为当前</button>
          </template>
        </div>
        <div class="vd-timeline" role="list" aria-label="时间线">
          <button
            v-for="c in project.clips"
            :key="c.uid"
            type="button"
            role="listitem"
            class="vd-clip"
            :aria-current="c.uid === selected ? 'true' : undefined"
            :style="{ flexGrow: Math.max(0.5, c.end - c.start) }"
            @click="select(c.uid)"
          >
            <span class="vd-clip-name">{{ baseName(c.name) }}</span>
            <small>{{ fmt(c.end - c.start) }}</small>
          </button>
        </div>
        <div class="vd-footer">
          <span>{{ project.clips.length }} 个片段 · 总长 {{ fmt(total) }}</span>
          <div class="toolbar-spacer" />
          <template v-if="clip">
            <button class="icon-button" aria-label="前移" title="前移" @click="move(-1)"><ChevronLeft :size="15" /></button>
            <button class="icon-button" aria-label="后移" title="后移" @click="move(1)"><ChevronRight :size="15" /></button>
            <button class="icon-button" aria-label="移出时间线" title="移出时间线" @click="remove(clip.uid)"><Trash2 :size="14" /></button>
          </template>
        </div>
      </template>
    </div>
  </div>
</template>
