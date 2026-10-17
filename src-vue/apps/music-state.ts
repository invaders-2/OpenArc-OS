/**
 * 音乐播放的共享状态（0.6.1 · 桌面小组件复用）。
 *
 * 为什么单独一层：播放器原本藏在 MusicApp.vue 的 setup 里，窗口一关就丢状态，
 * 桌面小组件也拿不到「当前曲目」。这里把音频元素与播放状态提到模块级单例：
 *   · MusicApp 只是这套状态的视图；
 *   · DesktopWidgets 提供当前曲目与播放控制；
 *   · 关闭音乐窗口不会停止播放（与 macOS 音乐一致，也是小组件继续可用的前提）。
 *
 * 数据源不变：仍然只列访达（桌面 + 各文件夹）里的真实音频，经只读文件协议播放。
 */
import { computed, reactive } from "vue";
import { fileUrl, kindOfExt } from "../wallpapers";
import { useShellStore } from "../stores/shell";

export type MusicTrack = {
  key: string;
  folderId: string;
  id: string;
  name: string;
  ext: string;
  size: number;
  folder: string;
};

export const musicState = reactive({
  tracks: [] as MusicTrack[],
  loading: false,
  loaded: false,
  index: -1,
  playing: false,
  time: 0,
  duration: 0,
  error: "",
});

export const currentTrack = computed<MusicTrack | null>(() => musicState.tracks[musicState.index] ?? null);

let audio: HTMLAudioElement | null = null;

function ensureAudio(): HTMLAudioElement | null {
  if (typeof Audio === "undefined") return null;
  if (audio) return audio;
  audio = new Audio();
  audio.addEventListener("play", () => (musicState.playing = true));
  audio.addEventListener("pause", () => (musicState.playing = false));
  audio.addEventListener("timeupdate", () => (musicState.time = audio ? audio.currentTime : 0));
  audio.addEventListener("loadedmetadata", () => (musicState.duration = audio && Number.isFinite(audio.duration) ? audio.duration : 0));
  audio.addEventListener("ended", () => step(1));
  return audio;
}

/** 列音频（桌面 + 各文件夹）；loaded 后复用，force 才重扫。 */
export async function ensureLoaded(force = false): Promise<void> {
  if (musicState.loading) return;
  if (musicState.loaded && !force) return;
  const bridge = typeof window === "undefined" ? undefined : window.openarc?.files;
  musicState.loaded = true;
  if (!bridge) return;
  musicState.loading = true;
  const shell = useShellStore();
  const out: MusicTrack[] = [];
  const folders = ["desktop", ...shell.folders.map((folder) => folder.id)];
  for (const folderId of folders) {
    const reply = await bridge.list(folderId).catch(() => null);
    for (const entry of reply?.entries ?? []) {
      if (kindOfExt(entry.ext) !== "audio") continue;
      const folder = folderId === "desktop" ? "桌面" : shell.folders.find((item) => item.id === folderId)?.name ?? "文件夹";
      out.push({ key: folderId + "/" + entry.id, folderId, id: entry.id, name: entry.name, ext: entry.ext, size: entry.size ?? 0, folder });
    }
  }
  musicState.tracks = out.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  if (musicState.index >= musicState.tracks.length) musicState.index = -1;
  musicState.loading = false;
}

/** 播放第 i 首；真正播放失败时把原因留在状态里（界面正文只显示人话）。 */
export async function playAt(index: number): Promise<void> {
  const track = musicState.tracks[index];
  if (!track) return;
  const player = ensureAudio();
  if (!player) return;
  musicState.index = index;
  musicState.error = "";
  player.src = fileUrl(track.folderId, track.id);
  try {
    await player.play();
  } catch {
    musicState.error = "这个格式无法播放";
  }
}

export function toggle(): void {
  const player = ensureAudio();
  if (!player) return;
  if (!currentTrack.value) {
    void playAt(0);
    return;
  }
  if (player.paused) void player.play().catch(() => (musicState.error = "这个格式无法播放"));
  else player.pause();
}

export function step(delta: number): void {
  if (!musicState.tracks.length) return;
  const next = (musicState.index + delta + musicState.tracks.length) % musicState.tracks.length;
  void playAt(next);
}

export function seek(seconds: number): void {
  const player = ensureAudio();
  if (!player || !Number.isFinite(seconds)) return;
  player.currentTime = Math.max(0, Math.min(seconds, musicState.duration || seconds));
}
