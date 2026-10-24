<script setup lang="ts">
import { t } from "../i18n";
/**
 * 音乐（Vue 壳层）· 本地音乐库 + 访达来源。
 *
 * 音乐库走 window.openarc.media.command 的 media/library/*（electron/media-service.cjs → media-library.cjs）：
 *   · config/get、config/set-dirs：扫描目录（目录由用户输入绝对路径，主进程校验存在性；绝对路径不过界面）
 *   · scan / tracks：扫描与曲目列表（限深 6 层 / 单库 5000 首；标签缺失回文件名）
 *   · lyrics：本地 .lrc / 内嵌歌词优先；在线查询需要主进程注入 fetch，未注入即如实不可用
 *   · artwork/targets、artwork/put：缺封面清单与本地选图写入封面缓存
 *   · meta/set：把曲名 / 歌手 / 专辑写进音乐库覆盖层（合并保存，不改音频文件）
 * 访达来源保留原行为：只读文件协议 openarc-file://media 流式播放，不暴露磁盘路径；
 * 播放状态提到 music-state.ts 单例，桌面音乐卡与本应用共用同一「当前曲目 / 播放 / 进度」。
 *
 * 两条缺失按事实呈现、不做假数据：
 *   1) 媒体域没有读取曲目字节 / 封面的命令，所以音乐库曲目暂不能播放、封面不能预览；
 *   2) 在线歌词 / 在线刮削需要注入 fetch，未注入时明确报「未接入」。
 */
import { computed, onMounted, ref } from "vue";
import { Clock, Disc3, FileText, FolderOpen, Heart, ListMusic, Music2, Pause, Play, RefreshCw, Settings2, Shuffle, SkipBack, SkipForward, Upload, Volume2 } from "lucide-vue-next";
import { currentTrack, ensureLoaded, musicState, playAt as playFinderTrack, seek as seekFinder, setVolume, step as stepFinder, toggle as toggleFinder } from "./music-state";
import type { MusicTrack } from "./music-state";
import DsButton from "../design-system/DsButton.vue";
import DsDialog from "../design-system/DsDialog.vue";
import DsPageState from "../design-system/DsPageState.vue";
import DsSearchField from "../design-system/DsSearchField.vue";
import DsTextField from "../design-system/DsTextField.vue";

/* ── 媒体域桥（唯一入口 command({command,payload})，返回 {ok,value} / {ok:false,error,message}） ── */
type MediaResult = { ok?: boolean; value?: unknown; error?: string; message?: string; detail?: unknown };
type MediaBridge = { command: (command: { command: string; payload?: Record<string, unknown> }) => Promise<MediaResult> };
const mediaBridge: MediaBridge | null =
  typeof window === "undefined" ? null : ((window.openarc?.media as MediaBridge | undefined) ?? null);

const MEDIA_ERROR_TEXT: Record<string, string> = {
  NO_BRIDGE: "桌面桥没有接入媒体域，音乐库不可用",
  MEDIA_NOT_READY: "媒体域还没装配好，音乐库暂不可用",
  MEDIA_UNAUTHENTICATED: "当前会话未认证，媒体命令被拒绝",
  MEDIA_FORBIDDEN: "没有权限执行这个媒体命令",
  MEDIA_INVALID_INPUT: "输入不完整或格式不正确",
  MEDIA_NOT_FOUND: "找不到这条记录（文件可能已被移动，请重新扫描）",
  MEDIA_CONFLICT: "状态冲突，请刷新后重试",
  MEDIA_DEPENDENCY_UNAVAILABLE: "这项能力还没有装配",
  MEDIA_COMMAND_NOT_ALLOWED: "这个媒体命令没有被白名单允许",
  MEDIA_INTERNAL: "媒体服务出错",
  DXOS_ERR_INTERNAL: "媒体服务出错",
};

async function send(command: string, payload: Record<string, unknown> = {}): Promise<MediaResult> {
  if (!mediaBridge || typeof mediaBridge.command !== "function") return { ok: false, error: "NO_BRIDGE" };
  try {
    return (await mediaBridge.command({ command, payload })) || { ok: false, error: "MEDIA_INTERNAL" };
  } catch (error) {
    return { ok: false, error: "MEDIA_INTERNAL", message: String((error as Error)?.message || error) };
  }
}
function valueOf(result: MediaResult): Record<string, unknown> | null {
  return result.ok === true && result.value && typeof result.value === "object" ? (result.value as Record<string, unknown>) : null;
}
function mediaErrorText(result: MediaResult | null): string {
  if (!result) return "媒体服务没有返回结果";
  const code = String(result.error || "MEDIA_INTERNAL");
  const message = typeof result.message === "string" && result.message.trim() ? result.message.trim() : t(MEDIA_ERROR_TEXT[code] || "媒体服务调用失败");
  const suffix = code === "NO_BRIDGE" ? "" : "（" + code + "）";
  return message + suffix;
}
function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function optionalText(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}
function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function listOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
function baseName(path: string): string {
  const parts = String(path || "").split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(path || "");
}

/* ── 类型 ── */
type Source = "library" | "finder";
type LibTrack = {
  id: string;
  title: string;
  fileName: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  duration?: number;
  ext: string;
  size: number;
  folder?: string;
  hasLyrics: boolean;
  albumImage?: string;
  artistImage?: string;
  year?: number;
  trackNo?: number;
  genre?: string[];
};
type ArtworkAlbum = { artist: string; album: string; key: string };
type ArtworkTargets = { artists: string[]; albums: ArtworkAlbum[] };
type LyricsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; text: string; source: string }
  | { status: "empty"; message?: string; code?: string }
  | { status: "error"; message: string };

function normalizeLibTrack(raw: unknown): LibTrack {
  const item = recordOf(raw);
  return {
    id: textOf(item.id),
    title: textOf(item.title) || textOf(item.fileName) || "未命名曲目",
    fileName: textOf(item.fileName),
    artist: optionalText(item.artist),
    album: optionalText(item.album),
    albumArtist: optionalText(item.albumArtist),
    duration: numberOf(item.duration),
    ext: textOf(item.ext),
    size: numberOf(item.size) || 0,
    folder: optionalText(item.folder),
    hasLyrics: item.hasLyrics === true,
    albumImage: optionalText(item.albumImage),
    artistImage: optionalText(item.artistImage),
    year: numberOf(item.year),
    trackNo: numberOf(item.trackNo),
    genre: Array.isArray(item.genre) ? item.genre.map(String) : undefined,
  };
}

/* ── 通用格式 ── */
const fmt = (seconds?: number) => {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "—";
  return Math.floor(seconds / 60) + ":" + String(Math.floor(seconds % 60)).padStart(2, "0");
};
const sizeText = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
};
const baseNameOf = (name: string) => name.replace(/\.[^.]+$/, "");
const trackSubLine = (track: LibTrack) => {
  const tagged = [track.artist, track.album].filter(Boolean).join(" · ");
  if (tagged) return tagged;
  if (track.fileName && track.fileName !== track.title) return track.fileName;
  return "无标签信息（以文件名兜底）";
};
const LYRICS_SOURCE: Record<string, string> = { sidecar: "同名 .lrc 文件", embedded: "音频内嵌歌词", lrclib: "在线歌词（lrclib）" };

/* ══════════════════════════════════════════════════════════════════════════
   导航 / 搜索
   ══════════════════════════════════════════════════════════════════════════ */
const source = ref<Source>("library");
const query = ref("");

function selectSource(next: Source) {
  if (source.value === next) return;
  source.value = next;
  query.value = "";
}

/* ══════════════════════════════════════════════════════════════════════════
   音乐库（media/library/*）
   ══════════════════════════════════════════════════════════════════════════ */
const libTracks = ref<LibTrack[]>([]);
const libLoading = ref(false);
const libScanning = ref(false);
const libLoaded = ref(false);
const libFailure = ref<string | null>(null);
const libFailureCode = ref("");
const libConfigured = ref(false);
const libDirs = ref<string[]>([]);
const libDirNames = ref<string[]>([]);
const libSessionTrackCount = ref(0);

const dirsDialog = ref(false);
const dirsDraft = ref("");
const dirsBusy = ref(false);
const dirsError = ref("");
const dirsErrors = ref<string[]>([]);

const libState = computed<"unavailable" | "loading" | "error" | "unconfigured" | "empty" | "ready">(() => {
  if (!mediaBridge) return "unavailable";
  if (libFailure.value && libTracks.value.length === 0 && !libLoading.value && !libScanning.value) return "error";
  if ((libLoading.value || libScanning.value) && libTracks.value.length === 0) return "loading";
  if (!libConfigured.value) return "unconfigured";
  if (libTracks.value.length === 0) return "empty";
  return "ready";
});

const libCountLabel = computed(() => {
  if (!mediaBridge) return t("媒体桥未接入");
  if (!libConfigured.value) return t("未配置扫描目录");
  if (libScanning.value) return t("正在扫描…");
  if (libLoading.value) return t("正在读取…");
  return libSessionTrackCount.value && libSessionTrackCount.value !== libTracks.value.length
    ? t("{n} 首（会话缓存 {count}）", { n: libTracks.value.length, count: libSessionTrackCount.value })
    : t("{n} 首", { n: libTracks.value.length });
});

async function loadLibraryConfig() {
  if (!mediaBridge) return;
  const result = await send("media/library/config/get");
  if (!result.ok) {
    libFailure.value = mediaErrorText(result);
    libFailureCode.value = String(result.error || "");
    return;
  }
  const config = recordOf(valueOf(result)?.config);
  libConfigured.value = config.configured === true;
  libDirs.value = listOf<unknown>(config.dirs).map(String);
  const dirNames = listOf<unknown>(config.dirNames).map(String);
  libDirNames.value = dirNames.length ? dirNames : libDirs.value.map(baseName);
  libSessionTrackCount.value = numberOf(config.trackCount) || 0;
}

async function loadLibraryTracks() {
  if (!mediaBridge) return;
  libLoading.value = true;
  libFailure.value = null;
  libFailureCode.value = "";
  const result = await send("media/library/tracks");
  libLoading.value = false;
  if (!result.ok) {
    libFailure.value = mediaErrorText(result);
    libFailureCode.value = String(result.error || "");
    return;
  }
  libTracks.value = listOf<unknown>(valueOf(result)?.tracks).map(normalizeLibTrack).filter((track) => track.id);
  libLoaded.value = true;
  libSessionTrackCount.value = libTracks.value.length;
}

async function scanLibrary() {
  if (!mediaBridge) return;
  libScanning.value = true;
  libFailure.value = null;
  libFailureCode.value = "";
  const result = await send("media/library/scan", {});
  libScanning.value = false;
  if (!result.ok) {
    libFailure.value = mediaErrorText(result);
    libFailureCode.value = String(result.error || "");
    return;
  }
  libTracks.value = listOf<unknown>(valueOf(result)?.tracks).map(normalizeLibTrack).filter((track) => track.id);
  libLoaded.value = true;
  libSessionTrackCount.value = libTracks.value.length;
  syncSelectedFromList();
}

async function initLibrary() {
  if (!mediaBridge) return;
  await loadLibraryConfig();
  if (libConfigured.value) await loadLibraryTracks();
}

function openDirs() {
  dirsDraft.value = "";
  dirsError.value = "";
  dirsErrors.value = [];
  dirsDialog.value = true;
  void loadLibraryConfig();
}

async function saveDirs(nextDirs: string[]) {
  dirsBusy.value = true;
  dirsError.value = "";
  dirsErrors.value = [];
  const result = await send("media/library/config/set-dirs", { dirs: nextDirs });
  dirsBusy.value = false;
  if (!result.ok) {
    dirsError.value = mediaErrorText(result);
    return;
  }
  const value = recordOf(valueOf(result));
  libDirs.value = listOf<unknown>(value.dirs).map(String);
  const dirNames = listOf<unknown>(value.dirNames).map(String);
  libDirNames.value = dirNames.length ? dirNames : libDirs.value.map(baseName);
  dirsErrors.value = listOf<unknown>(value.errors).map(String);
  libConfigured.value = libDirs.value.length > 0;
  if (!libConfigured.value) {
    libTracks.value = [];
    libLoaded.value = false;
  }
  if (libConfigured.value) await scanLibrary();
}

async function addDir() {
  const path = dirsDraft.value.trim();
  if (!path) {
    dirsError.value = t("请填写一个绝对路径；空值不会提交。");
    return;
  }
  if (libDirs.value.includes(path)) {
    dirsError.value = t("这个目录已经在扫描清单里。");
    return;
  }
  await saveDirs([...libDirs.value, path]);
  if (!dirsError.value && libDirs.value.includes(path)) dirsDraft.value = "";
}

async function removeDir(index: number) {
  const next = libDirs.value.filter((_, i) => i !== index);
  await saveDirs(next);
}

/* ══════════════════════════════════════════════════════════════════════════
   曲目详情：歌词 / 元数据 / 封面
   ══════════════════════════════════════════════════════════════════════════ */
const trackDialog = ref(false);
const selectedLibId = ref<string | null>(null);
const selectedLib = computed(() => libTracks.value.find((track) => track.id === selectedLibId.value) || null);

const lyrics = ref<LyricsState>({ status: "idle" });
const metaTitle = ref("");
const metaArtist = ref("");
const metaAlbum = ref("");
const metaBusy = ref(false);
const metaError = ref("");
const metaNotice = ref("");

const artTargets = ref<ArtworkTargets | null>(null);
const artLoading = ref(false);
const artError = ref("");
const artNotice = ref("");
const artBusy = ref(false);
const artFileInput = ref<HTMLInputElement | null>(null);
const artScope = ref<"artist" | "album">("album");

const missingArtist = computed(() => {
  const track = selectedLib.value;
  if (!track?.artist || !artTargets.value) return false;
  return artTargets.value.artists.includes(track.artist);
});
const missingAlbum = computed(() => {
  const track = selectedLib.value;
  if (!track?.artist || !track.album || !artTargets.value) return false;
  return artTargets.value.albums.some((item) => item.artist === track.artist && item.album === track.album);
});
const canUploadArtist = computed(() => Boolean(selectedLib.value?.artist));
const canUploadAlbum = computed(() => Boolean(selectedLib.value?.artist && selectedLib.value?.album));
const artworkState = computed<"loading" | "error" | "idle" | "empty" | "ready">(() => {
  if (artLoading.value) return "loading";
  if (artError.value) return "error";
  if (!artTargets.value) return "idle";
  if (artTargets.value.artists.length === 0 && artTargets.value.albums.length === 0) return "empty";
  return "ready";
});

function syncSelectedFromList() {
  const track = selectedLib.value;
  if (!track) return;
  metaTitle.value = track.title;
  metaArtist.value = track.artist || "";
  metaAlbum.value = track.album || "";
}

function openTrack(track: LibTrack) {
  selectedLibId.value = track.id;
  trackDialog.value = true;
  lyrics.value = { status: "idle" };
  artTargets.value = null;
  artError.value = "";
  artNotice.value = "";
  metaError.value = "";
  metaNotice.value = "";
  syncSelectedFromList();
  void loadLyrics();
  void loadArtworkTargets();
}

async function loadLyrics() {
  const track = selectedLib.value;
  if (!track) return;
  lyrics.value = { status: "loading" };
  const result = await send("media/library/lyrics", { trackId: track.id });
  if (!result.ok) {
    lyrics.value = { status: "empty", code: String(result.error || ""), message: mediaErrorText(result) };
    return;
  }
  const value = recordOf(valueOf(result)?.lyrics);
  const text = textOf(value.lyrics);
  if (!text.trim()) {
    lyrics.value = { status: "empty" };
    return;
  }
  lyrics.value = { status: "ready", text, source: textOf(value.source) };
}

async function saveMeta() {
  const track = selectedLib.value;
  if (!track) return;
  const title = metaTitle.value.trim();
  if (!title) {
    metaError.value = "曲名不能为空；留空会覆盖成空标题。";
    return;
  }
  metaBusy.value = true;
  metaError.value = "";
  metaNotice.value = "";
  const result = await send("media/library/meta/set", {
    items: [{ id: track.id, title, artist: metaArtist.value.trim(), album: metaAlbum.value.trim() }],
  });
  if (!result.ok) {
    metaBusy.value = false;
    metaError.value = mediaErrorText(result);
    return;
  }
  const updated = numberOf(valueOf(result)?.updated) || 0;
  metaNotice.value = t("已写入 {n} 条元数据；正在重新扫描以应用覆盖层…", { n: updated });
  await scanLibrary();
  metaBusy.value = false;
  metaNotice.value = "已保存并应用。元数据只写本机音乐库覆盖层（library-meta.json），不改音频文件本身。";
}

async function loadArtworkTargets() {
  artLoading.value = true;
  artError.value = "";
  const result = await send("media/library/artwork/targets");
  artLoading.value = false;
  if (!result.ok) {
    artError.value = mediaErrorText(result);
    return;
  }
  const value = recordOf(valueOf(result));
  artTargets.value = {
    artists: listOf<unknown>(value.artists).map(String),
    albums: listOf<unknown>(value.albums).map((item) => {
      const row = recordOf(item);
      return { artist: textOf(row.artist), album: textOf(row.album), key: textOf(row.key) };
    }),
  };
}

function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取本地图片失败"));
    reader.onload = () => {
      const text = String(reader.result || "");
      const comma = text.indexOf(",");
      resolve(comma >= 0 ? text.slice(comma + 1) : text);
    };
    reader.readAsDataURL(file);
  });
}
function pickArtwork(scope: "artist" | "album") {
  artScope.value = scope;
  artFileInput.value?.click();
}
async function onArtworkFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  const track = selectedLib.value;
  if (!file || !track) return;
  const scope = artScope.value;
  const artist = track.artist || "";
  const album = track.album || "";
  if (scope === "artist" && !artist) {
    artError.value = "这条曲目没有歌手信息，无法登记歌手照片。";
    return;
  }
  if (scope === "album" && (!artist || !album)) {
    artError.value = "这条曲目没有歌手 + 专辑信息，无法登记专辑封面。";
    return;
  }
  const key = scope === "artist" ? artist : artist + "\n" + album;
  artBusy.value = true;
  artError.value = "";
  artNotice.value = "";
  try {
    const base64 = await readFileBase64(file);
    const result = await send("media/library/artwork/put", { scope, key, base64 });
    if (!result.ok) {
      artError.value = mediaErrorText(result);
      return;
    }
    const id = textOf(valueOf(result)?.id);
    artNotice.value = t("已写入本地封面缓存（id {id}）。当前版本没有读取封面字节的命令，界面无法预览这张图；重新扫描后曲目会记录 albumImage。", { id });
    await loadArtworkTargets();
    await scanLibrary();
  } catch (error) {
    artError.value = String((error as Error)?.message || error);
  } finally {
    artBusy.value = false;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   访达来源：状态与播放器在 music-state.ts 单例里（桌面音乐卡共用）
   ══════════════════════════════════════════════════════════════════════════ */
const finderTracks = computed(() => musicState.tracks);
const finderFailure = computed(() => (typeof window !== "undefined" && !window.openarc?.files ? "文件桥未接入，访达来源不可用。" : ""));

async function loadFinder() {
  await ensureLoaded(true);
}
function playFinderAt(i: number) {
  void playFinderTrack(i);
}
function onSeek(event: Event) {
  seekFinder(Number((event.target as HTMLInputElement).value));
}

/* ══════════════════════════════════════════════════════════════════════════
   过滤 / 派生
   ══════════════════════════════════════════════════════════════════════════ */
const filteredLibTracks = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return libTracks.value;
  return libTracks.value.filter((track) =>
    [track.title, track.fileName, track.artist, track.album, track.folder].some((value) => (value || "").toLowerCase().includes(needle)),
  );
});
const filteredFinderTracks = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return finderTracks.value;
  return finderTracks.value.filter((track) => track.name.toLowerCase().includes(needle) || track.folder.toLowerCase().includes(needle));
});
const volume = ref(0.8);
function onVolume(e: Event) { const value = Number((e.target as HTMLInputElement).value); volume.value = value; setVolume(value); }
function shuffleFinder() { if (!finderTracks.value.length) return; playFinderAt(Math.floor(Math.random() * finderTracks.value.length)); }
const finderEmpty = computed(() => musicState.loaded && !musicState.loading && !finderFailure.value && finderTracks.value.length === 0);
const finderNoResult = computed(() => musicState.loaded && finderTracks.value.length > 0 && filteredFinderTracks.value.length === 0);
const libNoResult = computed(() => libTracks.value.length > 0 && filteredLibTracks.value.length === 0);
const trackDialogTitle = computed(() => selectedLib.value?.title || t("曲目详情"));
const finderPlayingHint = computed(() => {
  const track = currentTrack.value;
  if (!track) return "";
  const name = baseNameOf(track.name);
  return musicState.playing ? t("桌面小组件与访达来源共用播放状态，正在播放：{name}", { name }) : t("访达当前曲目：{name}", { name });
});
const playerTitle = computed(() => {
  if (source.value === "library") return selectedLib.value ? selectedLib.value.title : t("未选择曲目");
  return currentTrack.value ? baseNameOf(currentTrack.value.name) : t("未在播放");
});
const playerMeta = computed(() => {
  if (source.value === "library") {
    const track = selectedLib.value;
    if (!track) return t("在列表里选一首，可以看歌词、编辑元数据或补封面。");
    return [track.artist, track.album, track.ext.toUpperCase()].filter(Boolean).join(" · ");
  }
  if (musicState.error) return musicState.error;
  return currentTrack.value ? currentTrack.value.folder + " · " + currentTrack.value.ext.toUpperCase() + " · " + sizeText(currentTrack.value.size) : t("双击访达列表里的曲目开始播放。");
});

onMounted(() => {
  void initLibrary();
  void ensureLoaded();
});
</script>

<template>
  <div class="split music-app" data-music-app="1" :data-music-source="source" :data-music-library-state="libState">
    <nav class="split-side music-side" :aria-label="t('音乐')">
      <div class="split-section">{{ t("资料库") }}</div>
      <button type="button" class="split-nav" :aria-current="source === 'library' ? 'true' : undefined" @click="selectSource('library')">
        <Music2 :size="16" :stroke-width="1.25" /><span class="split-nav-label">{{ t("全部歌曲") }}</span>
        <small class="music-count">{{ libConfigured ? libTracks.length : "—" }}</small>
      </button>
      <button type="button" class="split-nav music-nav-muted" disabled title="最近播放没有后端数据（NOT VERIFIED）"><Clock :size="16" /> <span class="split-nav-label">{{ t("最近播放") }}</span></button>
      <button type="button" class="split-nav music-nav-muted" disabled title="喜欢没有后端数据（NOT VERIFIED）"><Heart :size="16" /> <span class="split-nav-label">{{ t("喜欢") }}</span></button>
      <button type="button" class="split-nav" :aria-current="source === 'finder' ? 'true' : undefined" @click="selectSource('finder')">
        <FolderOpen :size="16" :stroke-width="1.25" /><span class="split-nav-label">{{ t("访达音频") }}</span><small class="music-count">{{ finderTracks.length }}</small>
      </button>
      <div class="split-section">{{ t("歌单") }}</div>
      <p class="music-side-note" data-music-playlists-unverified>{{ t("还没有歌单；歌单能力未接入（NOT VERIFIED）。") }}</p>
      <div class="split-section">{{ t("扫描目录") }}</div>
      <ul v-if="libDirs.length" class="music-dirs" data-music-dirs>
        <li v-for="(dir, i) in libDirs" :key="dir" class="music-dir"><ListMusic :size="12" :stroke-width="1.5" aria-hidden="true" /><span class="music-dir__name" :title="dir">{{ libDirNames[i] || baseName(dir) }}</span></li>
      </ul>
      <p v-else class="music-side-note">{{ t("还没有扫描目录。加一个本机文件夹后，应用会索引其中的音频（只读）。") }}</p>
      <div class="music-side-actions"><DsButton size="sm" variant="secondary" @click="openDirs"><Settings2 :size="13" :stroke-width="1.5" /> {{ t("管理扫描目录") }}</DsButton></div>
    </nav>

    <div class="split-main music-main">
      <div class="music-toolbar">
        <strong class="music-title">{{ source === "library" ? t("全部歌曲") : t("访达音频") }}</strong>
        <span class="toolbar-spacer" />
        <button type="button" class="music-shuffle" :disabled="source !== 'finder' || !finderTracks.length" :title="source === 'library' ? '随机播放只对访达音频可用' : '随机播放'" data-music-shuffle @click="shuffleFinder"><Shuffle :size="14" /> {{ t("随机播放") }}</button>
        <div class="music-search">
          <DsSearchField :value="query" :placeholder="source === 'library' ? t('按曲名 / 歌手 / 专辑筛选') : t('按文件名筛选')" label="筛选曲目" @update:value="query = $event" />
        </div>
        <span class="music-count-label">{{ source === "library" ? libCountLabel : musicState.loading ? t("正在读取…") : finderTracks.length + " 首" }}</span>
        <DsButton v-if="source === 'library'" size="sm" variant="secondary" :status="libScanning ? 'loading' : 'idle'" :disabled="!mediaBridge || !libConfigured" @click="scanLibrary()">
          <RefreshCw :size="14" :stroke-width="1.5" /> {{ t("扫描") }}
        </DsButton>
        <DsButton v-else size="sm" variant="secondary" :status="musicState.loading ? 'loading' : 'idle'" @click="loadFinder">
          <RefreshCw :size="14" :stroke-width="1.5" /> {{ t("刷新") }}
        </DsButton>
      </div>

      <p v-if="source === 'library' && libFailure && libTracks.length" class="music-banner" role="alert" :data-music-error-code="libFailureCode">刷新音乐库未完成：{{ libFailure }}</p>
      <p v-if="source === 'finder' && finderFailure" class="music-banner" role="alert" data-music-finder-error>{{ finderFailure }}</p>

      <div v-if="(source === 'library' && libState === 'ready') || (source === 'finder' && !musicState.loading && !finderEmpty && !finderFailure)" class="music-table-head" data-music-list-header>
        <span>#</span><span>{{ t("标题") }}</span><span>{{ t("艺人") }}</span><span>{{ t("时长") }}</span>
      </div>
      <template v-if="source === 'library'">
        <DsPageState v-if="libState === 'unavailable'" kind="unavailable" :title="t('音乐库不可用')" description="当前环境没有 window.openarc.media 媒体桥；访达来源仍然可用。" data-music-unavailable="media-bridge" />
        <DsPageState v-else-if="libState === 'loading'" kind="loading" :title="t('正在读取音乐库…')" :description="t('第一次读取会扫描目录并解析标签，曲目多时需要一会儿；界面不显示假进度。')" />
        <DsPageState v-else-if="libState === 'error'" kind="error" :title="t('读取音乐库失败')" :description="libFailure || ''" :on-action="() => loadLibraryTracks()" />
        <DsPageState v-else-if="libState === 'unconfigured'" kind="empty" :title="t('还没有设置音乐库目录')" :description="t('音乐库只读取你指定的本机文件夹（限深 6 层、单库 5000 首）；标签缺失时用文件名兜底。')" :action-label="t('设置扫描目录')" :on-action="openDirs" data-music-empty="unconfigured" />
        <DsPageState v-else-if="libState === 'empty'" kind="empty" :title="t('扫描目录里没有可识别的音频')" :description="t('支持 mp3 / flac / wav / m4a / aac / ogg / opus / wma。换一个目录或把音频放进去后重新扫描。')" :action-label="t('重新扫描')" :on-action="scanLibrary" data-music-empty="no-tracks" />
        <div v-else class="music-list" role="list" data-music-library-list>
          <div v-if="libNoResult" class="music-empty-inline">{{ t("没有匹配的曲目；搜索只作用于已载入的列表。") }}</div>
          <button
            v-for="track in filteredLibTracks"
            :key="track.id"
            type="button"
            role="listitem"
            class="music-row music-row--lib"
            :data-music-track-id="track.id"
            @click="openTrack(track)"
          >
            <span class="music-row-no">{{ filteredLibTracks.indexOf(track) + 1 }}</span>
            <span class="music-row-title"><span class="music-art" aria-hidden="true"><Disc3 :size="16" :stroke-width="1.25" /></span><span class="music-name">{{ track.title }}</span></span>
            <span class="music-row-artist">{{ track.artist || track.ext.toUpperCase() }}</span>
            <span class="music-row-dur">{{ fmt(track.duration) }}</span>
          </button>
        </div>
      </template>

      <template v-else>
        <DsPageState v-if="musicState.loading && !finderTracks.length" kind="loading" :title="t('正在读取访达里的音频…')" />
        <DsPageState v-else-if="finderFailure" kind="unavailable" :title="t('访达来源不可用')" :description="finderFailure" />
        <DsPageState v-else-if="finderEmpty" kind="empty" :title="t('访达里还没有音频')" :description="t('把 mp3 / m4a / wav 等音频拖进访达（桌面或任意文件夹），刷新后就能在这里播放。')" :on-action="loadFinder" :action-label="t('重新读取')" />
        <div v-else class="music-list" role="list" data-music-finder-list>
          <div v-if="finderNoResult" class="music-empty-inline">{{ t("没有匹配的音频；搜索只作用于已载入的列表。") }}</div>
          <button
            v-for="(track, i) in filteredFinderTracks"
            :key="track.key"
            type="button"
            role="listitem"
            class="music-row"
            :aria-current="currentTrack && currentTrack.key === track.key ? 'true' : undefined"
            @dblclick="playFinderAt(finderTracks.indexOf(track))"
            @keydown.enter="playFinderAt(finderTracks.indexOf(track))"
          >
            <span class="music-row-no"><span v-if="currentTrack && currentTrack.key === track.key && musicState.playing" class="music-eq" data-music-playing-eq><i /><i /><i /></span><template v-else>{{ finderTracks.indexOf(track) + 1 }}</template></span>
            <span class="music-row-title"><span class="music-art" aria-hidden="true"><Disc3 :size="16" :stroke-width="1.25" /></span><span class="music-name">{{ baseNameOf(track.name) }}</span></span>
            <span class="music-row-artist">{{ track.ext.toUpperCase() }} · {{ track.folder }}</span>
            <span class="music-row-dur">{{ currentTrack && currentTrack.key === track.key && musicState.duration ? fmt(musicState.duration) : "—" }}</span>
          </button>
        </div>
      </template>

      <div class="music-bar" data-music-player :data-music-player-mode="source">
        <div class="music-now-cover"><Disc3 :size="22" :stroke-width="1.2" /></div>
        <div class="music-now-text">
          <b class="music-now-name">{{ playerTitle }}</b>
          <span class="music-now-meta">{{ playerMeta }}</span>
        </div>
        <div class="music-ctrls">
          <button class="icon-button" :aria-label="t('上一首')" :disabled="source !== 'finder' || !finderTracks.length" @click="stepFinder(-1)"><SkipBack :size="15" /></button>
          <button class="music-play" :aria-label="source === 'library' ? t('音乐库曲目暂不能播放') : musicState.playing ? t('暂停') : t('播放')" :disabled="source !== 'finder' || !currentTrack" @click="toggleFinder">
            <Pause v-if="source === 'finder' && musicState.playing" :size="16" /><Play v-else :size="16" />
          </button>
          <button class="icon-button" :aria-label="t('下一首')" :disabled="source !== 'finder' || !finderTracks.length" @click="stepFinder(1)"><SkipForward :size="15" /></button>
        </div>
        <div class="music-progress">
          <small>{{ fmt(musicState.time) }}</small>
          <input type="range" min="0" :max="musicState.duration || 0" step="0.1" :value="musicState.time" :aria-label="t('播放进度')" :disabled="source !== 'finder' || !currentTrack" @input="onSeek" />
          <small>{{ fmt(musicState.duration) }}</small>
        </div>
        <div class="music-volume"><Volume2 :size="14" /><input type="range" min="0" max="1" step="0.01" :value="volume" aria-label="音量" @input="onVolume" /></div>
      </div>
    </div>

    <DsDialog :open="dirsDialog" :title="t('音乐库扫描目录')" @close="dirsDialog = false">
      <div class="music-dialog-body">
        <p class="music-hint">{{ t("目录必须是本机存在的绝对路径；保存时主进程会重新校验，不存在的目录会被丢弃并在下面列出。目录清单会替换整个扫描列表。") }}</p>
        <ul v-if="libDirs.length" class="music-dir-list" data-music-dir-list>
          <li v-for="(dir, i) in libDirs" :key="dir" class="music-dir-row">
            <span class="music-dir-row__name" :title="dir">{{ libDirNames[i] || baseName(dir) }}</span>
            <button type="button" class="music-dir-row__remove" :aria-label="'移除目录 ' + (libDirNames[i] || baseName(dir))" :disabled="dirsBusy" @click="removeDir(i)">{{ t("移除") }}</button>
          </li>
        </ul>
        <p v-else class="music-hint">{{ t("还没有目录。") }}</p>
        <DsTextField :label="t('添加目录（绝对路径）')" :model-value="dirsDraft" :placeholder="t('/Users/你的名字/Music')" :hint="t('添加后会立刻重新扫描；完整路径只在主进程与这个输入框里使用。')" @update:model-value="dirsDraft = $event" />
        <div class="music-actions">
          <DsButton size="sm" :status="dirsBusy ? 'loading' : 'idle'" :disabled="!dirsDraft.trim()" @click="addDir">
            <FolderOpen :size="14" :stroke-width="1.5" /> {{ t("添加并扫描") }}
          </DsButton>
          <DsButton size="sm" variant="secondary" :disabled="dirsBusy" @click="scanLibrary()">
            <RefreshCw :size="14" :stroke-width="1.5" /> {{ t("重新扫描现有目录") }}
          </DsButton>
        </div>
        <p v-if="dirsError" class="music-error" role="alert" data-music-dirs-error>{{ dirsError }}</p>
        <ul v-if="dirsErrors.length" class="music-error-list" role="alert" data-music-dirs-errors>
          <li v-for="line in dirsErrors" :key="line">{{ line }}</li>
        </ul>
        <p class="music-hint">{{ t("绝对路径不会出现在曲目列表里；接口只回目录名与是否存在。") }}</p>
      </div>
      <template #footer>
        <DsButton variant="ghost" @click="dirsDialog = false">{{ t("关闭") }}</DsButton>
      </template>
    </DsDialog>

    <DsDialog class="music-track-dialog" :open="trackDialog" :title="trackDialogTitle" @close="trackDialog = false">
      <div v-if="selectedLib" class="music-dialog-body" data-music-track-detail>
        <dl class="music-kv">
          <dt>{{ t("歌手") }}</dt>
          <dd>{{ selectedLib.artist || "—" }}</dd>
          <dt>{{ t("专辑") }}</dt>
          <dd>{{ selectedLib.album || "—" }}</dd>
          <dt>{{ t("格式") }}</dt>
          <dd>{{ selectedLib.ext.toUpperCase() }} · {{ sizeText(selectedLib.size) }} · {{ fmt(selectedLib.duration) }}</dd>
          <dt>{{ t("子目录") }}</dt>
          <dd>{{ selectedLib.folder || t("根目录") }}</dd>
          <dt>{{ t("歌词") }}</dt>
          <dd>{{ selectedLib.hasLyrics ? t("扫描时已找到") : t("扫描时未找到") }}</dd>
          <dt>{{ t("封面") }}</dt>
          <dd>{{ selectedLib.albumImage || selectedLib.artistImage ? t("缓存里已登记（当前不能预览）") : t("还没有登记") }}</dd>
        </dl>

        <section class="music-section" :aria-label="t('歌词')" data-music-lyrics :data-music-lyrics-state="lyrics.status">
          <div class="music-section-head">
            <strong>{{ t("歌词") }}</strong>
            <DsButton size="sm" variant="secondary" :status="lyrics.status === 'loading' ? 'loading' : 'idle'" @click="loadLyrics">
              <FileText :size="13" :stroke-width="1.5" /> {{ t("读取歌词") }}
            </DsButton>
          </div>
          <p v-if="lyrics.status === 'idle'" class="music-hint">{{ t("打开曲目时会自动读取；本地同名 .lrc 与内嵌歌词优先，在线查询需要主进程注入网络请求。") }}</p>
          <p v-else-if="lyrics.status === 'loading'" class="music-hint">{{ t("正在读取歌词…") }}</p>
          <p v-else-if="lyrics.status === 'empty'" class="music-hint" data-music-lyrics-empty>
            {{ lyrics.message || t("没有找到歌词：既没有同名 .lrc，也没有内嵌歌词。") }}
          </p>
          <p v-else-if="lyrics.status === 'error'" class="music-error" role="alert">{{ lyrics.message }}</p>
          <template v-else>
            <p class="music-hint">来源：{{ LYRICS_SOURCE[lyrics.source] || lyrics.source || t("未知") }}</p>
            <pre class="music-lyrics">{{ lyrics.text }}</pre>
          </template>
        </section>

        <section class="music-section" :aria-label="t('元数据')" data-music-meta>
          <div class="music-section-head"><strong>{{ t("元数据") }}</strong></div>
          <p class="music-hint">{{ t("只写本机音乐库覆盖层（library-meta.json），不改音频文件；保存后会重新扫描以应用。") }}</p>
          <DsTextField label="曲名" :model-value="metaTitle" @update:model-value="metaTitle = $event" />
          <DsTextField label="歌手" :model-value="metaArtist" @update:model-value="metaArtist = $event" />
          <DsTextField label="专辑" :model-value="metaAlbum" @update:model-value="metaAlbum = $event" />
          <div class="music-actions">
            <DsButton size="sm" :status="metaBusy ? 'loading' : 'idle'" :disabled="!metaTitle.trim()" @click="saveMeta">{{ t("保存元数据") }}</DsButton>
          </div>
          <p v-if="metaError" class="music-error" role="alert" data-music-meta-error>{{ metaError }}</p>
          <p v-if="metaNotice" class="music-hint" data-music-meta-notice>{{ metaNotice }}</p>
        </section>

        <section class="music-section" :aria-label="t('封面')" data-music-artwork :data-music-artwork-state="artworkState">
          <div class="music-section-head">
            <strong>{{ t("封面与歌手照片") }}</strong>
            <DsButton size="sm" variant="secondary" :status="artLoading ? 'loading' : 'idle'" @click="loadArtworkTargets">{{ t("重新读取缺少清单") }}</DsButton>
          </div>
          <p class="music-hint">{{ t("封面字节写入本机缓存；当前版本没有读取封面字节的命令，所以列表与这里都不展示封面图，也不放占位假图。可先用清单确认缺哪些，再从本机选图登记。") }}</p>
          <p v-if="artError" class="music-error" role="alert" data-music-artwork-error>{{ artError }}</p>
          <p v-else-if="artworkState === 'loading'" class="music-hint">{{ t("正在读取缺少封面的条目…") }}</p>
          <p v-else-if="artworkState === 'idle'" class="music-hint">{{ t("还没有读取缺少清单。") }}</p>
          <template v-else-if="artworkState === 'empty'">
            <p class="music-hint" data-music-artwork-empty>{{ t("没有缺少封面或歌手照片的条目。若曲库为空，检查扫描目录与标签。") }}</p>
          </template>
          <template v-else>
            <p class="music-hint" data-music-artwork-summary>缺少歌手照片 {{ artTargets?.artists.length || 0 }} 项、缺少专辑封面 {{ artTargets?.albums.length || 0 }} 项。</p>
            <p class="music-hint">
              当前曲目：{{ missingArtist ? t("缺少歌手照片") : t("歌手照片已登记") }} · {{ missingAlbum ? t("缺少专辑封面") : t("专辑封面已登记或缺少歌手/专辑标签") }}
            </p>
          </template>
          <div class="music-actions">
            <DsButton size="sm" variant="secondary" :disabled="!canUploadArtist || artBusy" @click="pickArtwork('artist')">
              <Upload :size="13" :stroke-width="1.5" /> {{ t("本机选图设为歌手照片") }}
            </DsButton>
            <DsButton size="sm" variant="secondary" :disabled="!canUploadAlbum || artBusy" @click="pickArtwork('album')">
              <Upload :size="13" :stroke-width="1.5" /> {{ t("本机选图设为专辑封面") }}
            </DsButton>
            <input ref="artFileInput" type="file" accept="image/*" hidden aria-hidden="true" tabindex="-1" @change="onArtworkFile" />
          </div>
          <p v-if="artNotice" class="music-hint" data-music-artwork-notice>{{ artNotice }}</p>
        </section>
      </div>
      <template #footer>
        <DsButton variant="ghost" @click="trackDialog = false">{{ t("关闭") }}</DsButton>
      </template>
    </DsDialog>
  </div>
</template>

<style scoped>
/* 只写音乐应用自身需要的布局；颜色 / 间距 / 圆角 / 时长全部走 design-system token。 */
.music-app {
  min-height: 0;
}
.music-count {
  margin-left: auto;
  font-size: var(--fs-micro);
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.music-count-label {
  color: var(--muted);
  font-size: var(--fs-micro);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.music-side-note {
  margin: var(--space-2) var(--space-2) 0;
  font-size: var(--fs-micro);
  line-height: var(--lh-relaxed);
  color: var(--muted);
  overflow-wrap: anywhere;
}
.music-dirs {
  list-style: none;
  margin: 0;
  padding: 0 var(--space-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.music-dir {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--fs-caption);
  color: var(--text);
}
.music-dir svg {
  flex: none;
  color: var(--muted);
}
.music-dir__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.music-side-actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
}
.music-side-actions :deep(.ds-btn) {
  justify-content: flex-start;
  width: 100%;
}
.music-main {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  padding: var(--space-4) var(--space-4) 0;
}
.music-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  flex-wrap: wrap;
  margin-bottom: var(--space-3);
}
.music-title {
  font-size: var(--fs-secondary);
  font-weight: var(--fw-medium);
  margin: 0 4px;
  white-space: nowrap;
}
.music-search {
  flex: 1 1 160px;
  min-width: 120px;
  max-width: 260px;
}
.music-search :deep(.ds-search) {
  width: 100%;
}
.music-banner {
  margin: 0 0 var(--space-2);
  font-size: var(--fs-caption);
  color: var(--failed);
  overflow-wrap: anywhere;
}
.music-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 4px 12px 12px;
}
.music-empty-inline {
  padding: var(--space-6) var(--space-4);
  text-align: center;
  font-size: var(--fs-caption);
  color: var(--muted);
}
.music-row--lib {
  height: 52px;
  grid-template-columns: 32px minmax(0, 1fr) 120px 64px 92px;
}
.music-art {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  background: var(--sunken);
  color: var(--muted);
}
.music-track-main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.music-track-main .music-name {
  font-size: var(--fs-secondary);
}
.music-sub {
  font-size: var(--fs-micro);
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.music-ext {
  text-align: right;
}
.music-now-meta {
  font-size: var(--fs-micro);
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.music-play:disabled {
  background: var(--sunken);
  color: var(--muted);
}
.music-play:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
.music-playback-note {
  margin: 2px 0 0;
  font-size: var(--fs-micro);
  line-height: var(--lh-relaxed);
  color: var(--muted);
  overflow-wrap: anywhere;
}
.music-bar {
  flex-wrap: wrap;
}
.music-progress {
  margin-top: 2px;
}
.music-dialog-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  max-height: 62vh;
  overflow: auto;
  padding-right: var(--space-1);
}
.music-hint {
  margin: 0;
  font-size: var(--fs-caption);
  line-height: var(--lh-relaxed);
  color: var(--muted);
  overflow-wrap: anywhere;
}
.music-error {
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--failed);
  overflow-wrap: anywhere;
}
.music-error-list {
  margin: 0;
  padding-left: var(--space-4);
  font-size: var(--fs-caption);
  color: var(--failed);
  overflow-wrap: anywhere;
}
.music-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.music-dir-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.music-dir-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--sunken);
  font-size: var(--fs-caption);
}
.music-dir-row__name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.music-dir-row__remove {
  flex: none;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: var(--fs-micro);
}
.music-dir-row__remove:hover:not(:disabled) {
  background: var(--row-hover);
  color: var(--text);
}
.music-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.music-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.music-section-head strong {
  font-size: var(--fs-secondary);
  font-weight: var(--fw-medium);
}
.music-kv {
  margin: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--space-1) var(--space-3);
  font-size: var(--fs-caption);
}
.music-kv dt {
  color: var(--muted);
}
.music-kv dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.music-lyrics {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--sunken);
  color: var(--text);
  font: var(--fs-caption) / var(--lh-relaxed) var(--font-ui);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.music-track-dialog :deep(.dialog) {
  width: min(560px, calc(100% - 64px));
}
@media (max-width: 720px) {
  .music-row--lib {
    grid-template-columns: 32px minmax(0, 1fr) 64px 72px;
  }
  .music-row--lib .music-meta:nth-of-type(1) {
    display: none;
  }
}

/* task-13：原型布局（侧栏 200 / 工具条 52 / 表格行 56 / 播放条 72） */
.music-app .split-side { flex: 0 0 200px; margin: 8px 0 8px 8px !important; padding: 44px 8px 10px; }
.music-app .split-main { padding: 0; padding-top: 0 !important; }
.music-side .split-section { padding: 12px 10px 4px; font-size: var(--fs-micro); font-weight: var(--fw-medium); color: var(--muted); }
.music-side .split-nav { min-height: 32px; padding: 0 10px; gap: 9px; }
.music-nav-muted { opacity: 0.5; cursor: default; }
.music-toolbar { height: 52px; min-height: 52px; margin: 0; padding: 0 20px; border-bottom: 0.5px solid var(--line); }
.music-title { font-size: 15px; font-weight: var(--fw-medium); }
.music-shuffle { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 12px; border-radius: var(--radius-pill); background: rgb(var(--text-rgb) / 0.07); font-size: var(--fs-caption); }
.music-table-head { display: grid; grid-template-columns: 40px minmax(0, 1fr) 200px 72px; align-items: center; gap: 10px; height: 30px; padding: 0 20px; color: var(--muted); font-size: var(--fs-micro); border-bottom: 0.5px solid var(--line); }
.music-table-head span:last-child { text-align: right; }
.music-list { padding: 0 20px; }
.music-row { display: grid; grid-template-columns: 40px minmax(0, 1fr) 200px 72px; align-items: center; gap: 10px; height: 56px; padding: 0; border-radius: 0; border-bottom: 0.5px solid var(--line); text-align: left; }
.music-row:hover { background: rgb(var(--text-rgb) / 0.04); }
.music-row[aria-current="true"] { background: rgb(var(--text-rgb) / 0.08); }
.music-row-no { display: flex; align-items: center; justify-content: flex-start; color: var(--muted); font-size: var(--fs-caption); font-variant-numeric: tabular-nums; }
.music-row-title { display: flex; align-items: center; gap: 9px; min-width: 0; }
.music-row-title .music-art { width: 28px; height: 28px; flex: none; border-radius: 5px; display: grid; place-items: center; background: rgb(var(--text-rgb) / 0.08); color: var(--muted); }
.music-row-title .music-name { font-size: var(--fs-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.music-row-artist { color: var(--muted); font-size: var(--fs-caption); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.music-row-dur { text-align: right; color: var(--muted); font-size: var(--fs-caption); font-variant-numeric: tabular-nums; }
.music-eq { display: inline-flex; align-items: flex-end; gap: 2px; height: 12px; }
.music-eq i { width: 3px; background: var(--text); animation: music-eq 0.9s ease-in-out infinite alternate; }
.music-eq i:nth-child(1) { height: 6px; }
.music-eq i:nth-child(2) { height: 11px; animation-delay: 0.15s; }
.music-eq i:nth-child(3) { height: 8px; animation-delay: 0.3s; }
@keyframes music-eq { from { transform: scaleY(0.5); } to { transform: scaleY(1); } }
.music-bar { flex: none; height: 72px; margin: 0; padding: 0 20px; display: flex; align-items: center; gap: 14px; border-top: 0.5px solid var(--line); background: rgb(var(--content-rgb) / 0.6); }
.music-now-cover { width: 44px; height: 44px; flex: none; border-radius: 8px; display: grid; place-items: center; background: rgb(var(--text-rgb) / 0.1); color: var(--muted); }
.music-now-text { width: 150px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.music-now-text b { font-size: var(--fs-caption); font-weight: var(--fw-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.music-now-text span { color: var(--muted); font-size: var(--fs-micro); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.music-bar .music-ctrls { flex: none; }
.music-bar .music-progress { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
.music-bar .music-progress input { flex: 1; }
.music-bar .music-progress small { color: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.music-volume { flex: none; display: flex; align-items: center; gap: 6px; color: var(--muted); }
.music-volume input { width: 90px; }

.music-list { padding: 0 12px; }
.music-table-head { grid-template-columns: 44px 279px minmax(0, 1fr) 72px; padding: 0 12px; }
.music-row { grid-template-columns: 44px 279px minmax(0, 1fr) 72px; height: 40px; }
.music-bar .music-progress { flex: none; width: 196px; margin-left: 24px; }
.music-volume { margin-left: auto; }

.music-table-head { margin: 0 12px; padding: 0; width: auto; }
.music-bar .music-progress { height: 16px; align-items: center; }
.music-bar .music-progress input { height: 16px; }
</style>
