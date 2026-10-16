<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Pause, Play, SkipBack, SkipForward } from "lucide-vue-next";
import { iconUrl } from "../apps";
import { useShellStore } from "../stores/shell";
import { fileUrl, kindOfExt } from "../wallpapers";

/**
 * 音乐（10-15）：播放访达（桌面 + 各文件夹）里真实存在的音频。
 * 音频经只读文件协议 openarc-file://media 流式播放（主进程回 Range），不暴露磁盘路径。
 */
type Track = { key: string; folderId: string; id: string; name: string; ext: string; size: number; folder: string };
const shell = useShellStore();
const tracks = ref<Track[]>([]);
const loading = ref(false);
const index = ref(-1);
const playing = ref(false);
const time = ref(0);
const duration = ref(0);
const error = ref("");
const audio = new Audio();

const current = computed(() => tracks.value[index.value] ?? null);
const baseName = (n: string) => n.replace(/\.[^.]+$/, "");
const fmt = (s: number) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "0:00");
const mb = (b: number) => (b / 1048576).toFixed(1) + " MB";

async function load() {
  const b = window.openarc?.files;
  if (!b) return;
  loading.value = true;
  const out: Track[] = [];
  for (const fid of ["desktop", ...shell.folders.map((f) => f.id)]) {
    const res = await b.list(fid).catch(() => null);
    for (const e of res?.entries ?? []) {
      if (kindOfExt(e.ext) !== "audio") continue;
      const folder = fid === "desktop" ? "桌面" : shell.folders.find((f) => f.id === fid)?.name ?? "文件夹";
      out.push({ key: fid + "/" + e.id, folderId: fid, id: e.id, name: e.name, ext: e.ext, size: e.size ?? 0, folder });
    }
  }
  tracks.value = out.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  loading.value = false;
}

async function playAt(i: number) {
  const t = tracks.value[i];
  if (!t) return;
  index.value = i;
  error.value = "";
  // 走只读文件协议流式播放（主进程回 Range，可拖动、无大小上限）
  audio.src = fileUrl(t.folderId, t.id);
  await audio.play().catch(() => {
    error.value = "这个格式无法播放";
  });
}
function toggle() {
  if (!current.value) return void playAt(0);
  if (audio.paused) void audio.play();
  else audio.pause();
}
const step = (n: number) => tracks.value.length && void playAt((index.value + n + tracks.value.length) % tracks.value.length);
function seek(e: Event) {
  audio.currentTime = Number((e.target as HTMLInputElement).value);
}

audio.addEventListener("play", () => (playing.value = true));
audio.addEventListener("pause", () => (playing.value = false));
audio.addEventListener("timeupdate", () => (time.value = audio.currentTime));
audio.addEventListener("loadedmetadata", () => (duration.value = audio.duration));
audio.addEventListener("ended", () => step(1));

onMounted(load);
onBeforeUnmount(() => {
  audio.pause();
  audio.removeAttribute("src");
});
</script>

<template>
  <div class="split music-app">
    <nav class="split-side" aria-label="音乐">
      <div class="split-section">资料库</div>
      <button type="button" class="split-nav" aria-current="true">
        <span class="split-nav-label">全部歌曲</span><small class="planned-count">{{ tracks.length }}</small>
      </button>
      <p class="planned-note">汇总访达（桌面与各文件夹）里的音频文件。</p>
    </nav>
    <div class="split-main music-main">
      <div class="pane-toolbar">
        <strong class="pane-title">全部歌曲</strong>
      </div>
      <div v-if="!tracks.length" class="empty-content">
        <img class="large-icon" :src="iconUrl('music')" alt="" draggable="false" />
        <p>{{ loading ? "正在读取…" : "访达里还没有音频。把 mp3 / m4a / wav 拖进访达即可在这里播放。" }}</p>
      </div>
      <div v-else class="music-list" role="list">
        <button
          v-for="(t, i) in tracks"
          :key="t.key"
          type="button"
          role="listitem"
          class="music-row"
          :aria-current="i === index ? 'true' : undefined"
          @dblclick="playAt(i)"
          @keydown.enter="playAt(i)"
        >
          <span class="music-no">{{ i === index && playing ? "♪" : i + 1 }}</span>
          <span class="music-name">{{ baseName(t.name) }}</span>
          <span class="music-meta">{{ t.ext.toUpperCase() }}</span>
          <span class="music-meta">{{ t.folder }}</span>
          <span class="music-meta">{{ mb(t.size) }}</span>
        </button>
      </div>
      <div class="music-bar">
        <div class="music-ctrls">
          <button class="icon-button" aria-label="上一首" @click="step(-1)"><SkipBack :size="15" /></button>
          <button class="music-play" :aria-label="playing ? '暂停' : '播放'" @click="toggle">
            <Pause v-if="playing" :size="16" /><Play v-else :size="16" />
          </button>
          <button class="icon-button" aria-label="下一首" @click="step(1)"><SkipForward :size="15" /></button>
        </div>
        <div class="music-now">
          <div class="music-now-name">{{ error || (current ? baseName(current.name) : "未在播放") }}</div>
          <div class="music-progress">
            <small>{{ fmt(time) }}</small>
            <input type="range" min="0" :max="duration || 0" step="0.1" :value="time" aria-label="播放进度" :disabled="!current" @input="seek" />
            <small>{{ fmt(duration) }}</small>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
