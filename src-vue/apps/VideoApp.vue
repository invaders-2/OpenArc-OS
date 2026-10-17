<script setup lang="ts">
import { t } from "../i18n";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ChevronLeft, ChevronRight, Download, Pause, Play, Plus, Trash2, X } from "lucide-vue-next";
import { iconUrl } from "../apps";
import { useShellStore } from "../stores/shell";
import { fileUrl, kindOfExt } from "../wallpapers";

/**
 * 视频剪辑（10-15；task-32 升级多轨 + Agent 粗剪）。
 *   快速单轨：访达视频顺序拼接 / 入出点 / 本机 FFmpeg 导出 MP4（原能力保留）。
 *   多轨编辑：media 域真实时间线（视频/音频/字幕轨、clip in/out、转场、时长对齐），
 *            渲染计划预览 → 提交渲染（media/render/submit）；粗剪走 media/rough-cut。
 *   所有命令经 window.openarc.media.command（{ok,value} / {ok:false,error,detail}）。
 *   本机限制：访达文件读取上限 12 MB，更大的素材不能经此导入多轨工程（如实提示）。
 */
type Asset = { key: string; folderId: string; id: string; name: string };
type QuickClip = { uid: string; folderId: string; id: string; name: string; duration: number; start: number; end: number };
type MediaAsset = { id: string; projectId?: string; kind: string; name: string; durationMs?: number; hasAudio?: boolean; hasVideo?: boolean; width?: number; height?: number };
type TransitionType = "none" | "fade" | "dissolve";
type TimelineClip = {
  id: string;
  trackId: string;
  assetId?: string;
  name: string;
  timelineStartMs: number;
  durationMs: number;
  sourceInMs: number;
  sourceOutMs: number;
  volume: number;
  transitionIn?: { type: TransitionType; durationMs: number };
};
type TrackType = "video" | "music" | "subtitle";
type Track = { id: string; type: TrackType; name: string; order: number; locked: boolean; muted: boolean; hidden: boolean; clips: TimelineClip[] };
type Timeline = {
  schemaVersion: "1.0";
  projectId: string;
  version: number;
  timebase: 1000;
  canvas: { width: number; height: number; fps: number };
  durationMs: number;
  outputProfileId?: string;
  tracks: Track[];
  transitions: unknown[];
};
type MediaIssue = { severity: "error" | "warning"; code: string; message: string };
type RenderPlan = { durationMs?: number; durationAligned?: boolean; inputCount?: number; plan?: { inputs?: { clipId: string; trackType: string; kind: string; transition?: { type: string; durationMs: number } | null }[] } };
type RenderJob = { id?: string; status?: string; progress?: number; error?: string | null };

const shell = useShellStore();
const bridge = window.openarc?.video;
const mediaBridge = window.openarc?.media;
const KEY = "oa-video-project";
const MEDIA_KEY = "oa-video-media-project";
const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    return null;
  }
})();
const savedMedia = (() => {
  try {
    return JSON.parse(localStorage.getItem(MEDIA_KEY) || "null");
  } catch {
    return null;
  }
})();

const project = reactive<{ name: string; resolution: string; clips: QuickClip[] }>({
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

/* ── 多轨工程 ─────────────────────────────────────────────────────────── */
const mode = ref<"quick" | "multi">("quick");
const mediaProjectId = ref<string>(
  typeof savedMedia?.projectId === "string" && savedMedia.projectId
    ? savedMedia.projectId
    : crypto.randomUUID(),
);
const sources = reactive<Record<string, { folderId: string; id: string }>>(
  savedMedia && typeof savedMedia.sources === "object" && savedMedia.sources ? savedMedia.sources : {},
);
function blankTimeline(): Timeline {
  return {
    schemaVersion: "1.0",
    projectId: mediaProjectId.value,
    version: 1,
    timebase: 1000,
    canvas: { width: 1920, height: 1080, fps: 30 },
    durationMs: 0,
    outputProfileId: "default",
    tracks: [
      { id: "tv", type: "video", name: "主视频", order: 0, locked: false, muted: false, hidden: false, clips: [] },
      { id: "tm", type: "music", name: "配乐", order: 1, locked: false, muted: false, hidden: false, clips: [] },
      { id: "ts", type: "subtitle", name: "字幕", order: 2, locked: false, muted: false, hidden: false, clips: [] },
    ],
    transitions: [],
  };
}
const timeline = reactive<Timeline>(
  savedMedia && savedMedia.timeline && Array.isArray(savedMedia.timeline.tracks) && savedMedia.timeline.tracks.length
    ? { ...savedMedia.timeline, projectId: mediaProjectId.value }
    : blankTimeline(),
);
watch([timeline, sources, mediaProjectId], () => {
  try {
    localStorage.setItem(MEDIA_KEY, JSON.stringify({ projectId: mediaProjectId.value, timeline, sources }));
  } catch {
    /* 存储不可用 */
  }
}, { deep: true });

const ff = ref<{ available: boolean; version?: string } | null>(null);
const assets = ref<Asset[]>([]);
const mediaAssets = ref<MediaAsset[]>([]);
const mediaBusy = ref<string | null>(null);
const mediaError = ref("");
const mediaNotice = ref("");
const issues = ref<MediaIssue[]>([]);
const plan = ref<RenderPlan | null>(null);
const job = ref<RenderJob | null>(null);
const selectedMClipId = ref<string | null>(null);
const selectedTrackId = ref<string>("tv");
const roughOpen = ref(false);
const roughInstruction = ref("");
const roughSeconds = ref(8);
const roughBusy = ref(false);
const roughError = ref("");
const roughCandidate = ref<{ timeline?: unknown; durationMs?: number; issues?: MediaIssue[]; adapter?: string | null } | null>(null);
const subtitleDraft = ref("");

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
  return m + ":" + (s - m * 60).toFixed(1).padStart(4, "0");
};
const baseName = (n: string) => n.replace(/\.[^.]+$/, "");

function fmtMs(ms: number) {
  const s = Math.max(0, Number(ms) || 0) / 1000;
  const m = Math.floor(s / 60);
  return m + ":" + (s - m * 60).toFixed(1).padStart(4, "0");
}
function setMode(next: "quick" | "multi") {
  mode.value = next;
  if (next === "multi") void ensureMediaProject();
}

/* ── 快速单轨（原能力） ──────────────────────────────────────────────── */
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
  const c: QuickClip = { uid: "c" + Date.now().toString(36), folderId: a.folderId, id: a.id, name: a.name, duration: info.duration, start: 0, end: info.duration };
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
function clamp(c: QuickClip) {
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
    message.value = "已导出「" + r.entry.name + "」到桌面「视频剪辑」文件夹";
    shell.notify({ appId: "video", title: "视频导出完成", body: r.entry.name });
  } else {
    message.value = (ERR[r?.error ?? ""] ?? "导出失败") + (r?.detail ? "：" + r.detail : "");
  }
}

/* ── 媒体域：项目 / 素材 / 时间线 ─────────────────────────────────────── */
async function mediaCall<T>(command: string, payload: Record<string, unknown>): Promise<T | null> {
  if (!mediaBridge) {
    mediaError.value = "当前环境没有媒体桥（浏览器预览）";
    return null;
  }
  // Vue reactive 对象是 Proxy，不能直接过 IPC（structured clone 会失败）；只发纯数据。
  const plain = JSON.parse(JSON.stringify(payload));
  const reply = await mediaBridge.command({ command, payload: plain }).catch(() => null);
  if (reply && reply.ok === true) {
    mediaError.value = "";
    return reply.value as T;
  }
  const code = reply && typeof reply.error === "string" ? reply.error : "MEDIA_FAILED";
  const detail = reply && reply.detail && typeof reply.detail === "object"
    ? (typeof reply.detail.dependency === "string" ? "（缺少依赖：" + reply.detail.dependency + "）" : "")
    : "";
  mediaError.value = code + (reply && typeof reply.message === "string" ? "：" + reply.message : "") + detail;
  return null;
}
async function ensureMediaProject() {
  if (!mediaBridge) return;
  if (mediaBusy.value === "project") return;
  mediaBusy.value = "project";
  const ensured = await mediaCall<{ projectId: string }>("media/project/ensure", { projectId: mediaProjectId.value, projectName: project.name });
  mediaBusy.value = null;
  if (!ensured) return;
  await Promise.all([loadMediaAssets(), mediaCall("media/health", {})]);
}
async function loadMediaAssets() {
  const value = await mediaCall<{ assets: MediaAsset[] }>("media/asset/list", { projectId: mediaProjectId.value });
  if (value) mediaAssets.value = Array.isArray(value.assets) ? value.assets : [];
}
async function importAsset(a: Asset) {
  if (!mediaBridge || mediaBusy.value) return;
  mediaBusy.value = "import:" + a.key;
  mediaError.value = "";
  mediaNotice.value = "";
  await ensureMediaProject();
  const fileBridge = window.openarc?.files;
  const file = (fileBridge?.read ? await fileBridge.read(a.folderId, a.id).catch(() => null) : null) as
    | { ok?: boolean; error?: string; dataUrl?: string; mime?: string }
    | null;
  if (!file?.ok || !file.dataUrl) {
    mediaBusy.value = null;
    mediaError.value = file?.error === "TOO_LARGE"
      ? "这个素材超过访达 12 MB 读取上限，不能导入多轨工程（可先用快速单轨导出，或换更小的素材）"
      : "读不到这个素材的字节：" + String(file?.error || "UNKNOWN");
    return;
  }
  const base64 = String(file.dataUrl).slice(String(file.dataUrl).indexOf(",") + 1);
  const savedAsset = await mediaCall<{ asset: MediaAsset }>("media/asset/save", {
    projectId: mediaProjectId.value,
    name: a.name,
    mime: file.mime || "video/mp4",
    base64,
  });
  mediaBusy.value = null;
  if (!savedAsset?.asset) return;
  sources[savedAsset.asset.id] = { folderId: a.folderId, id: a.id };
  mediaAssets.value = [savedAsset.asset, ...mediaAssets.value.filter((x) => x.id !== savedAsset.asset.id)];
  addAssetClip(savedAsset.asset);
  mediaNotice.value = "已导入「" + a.name + "」并加入时间线。";
}
function trackForKind(kind: string): Track | undefined {
  if (kind === "audio") return timeline.tracks.find((t) => t.type === "music");
  if (kind === "subtitle") return timeline.tracks.find((t) => t.type === "subtitle");
  return timeline.tracks.find((t) => t.type === "video");
}
function trackEnd(track: Track) {
  return track.clips.reduce((max, c) => Math.max(max, c.timelineStartMs + c.durationMs), 0);
}
function addAssetClip(asset: MediaAsset) {
  const track = trackForKind(asset.kind);
  if (!track) return;
  const durationMs = Math.max(200, Math.round(Number(asset.durationMs) || 3000));
  const c: TimelineClip = {
    id: "c" + Math.random().toString(36).slice(2, 9),
    trackId: track.id,
    assetId: asset.id,
    name: asset.name,
    timelineStartMs: trackEnd(track),
    durationMs,
    sourceInMs: 0,
    sourceOutMs: durationMs,
    volume: 1,
    transitionIn: { type: "none", durationMs: 0 },
  };
  track.clips.push(c);
  timeline.durationMs = Math.max(timeline.durationMs, c.timelineStartMs + c.durationMs);
  timeline.version += 1;
  selectedMClipId.value = c.id;
}
function addSubtitleClip() {
  const text = subtitleDraft.value.trim();
  if (!text) return;
  let track = timeline.tracks.find((t) => t.type === "subtitle");
  if (!track) {
    track = { id: "ts", type: "subtitle", name: "字幕", order: timeline.tracks.length, locked: false, muted: false, hidden: false, clips: [] };
    timeline.tracks.push(track);
  }
  const start = trackEnd(track);
  const durationMs = 2000;
  const c: TimelineClip = {
    id: "c" + Math.random().toString(36).slice(2, 9),
    trackId: track.id,
    name: text,
    timelineStartMs: start,
    durationMs,
    sourceInMs: 0,
    sourceOutMs: durationMs,
    volume: 1,
    transitionIn: { type: "none", durationMs: 0 },
  };
  track.clips.push(c);
  timeline.durationMs = Math.max(timeline.durationMs, start + durationMs);
  subtitleDraft.value = "";
  selectedMClipId.value = c.id;
  mediaNotice.value = "已添加字幕片段；它没有绑定字幕素材，不会进入渲染计划（仅时间线占位）。";
}
function allClips(): { track: Track; clip: TimelineClip }[] {
  const out: { track: Track; clip: TimelineClip }[] = [];
  for (const track of timeline.tracks) for (const c of track.clips) out.push({ track, clip: c });
  return out;
}
const selectedMClip = computed(() => allClips().find((entry) => entry.clip.id === selectedMClipId.value) ?? null);
function selectMClip(track: Track, c: TimelineClip) {
  selectedMClipId.value = c.id;
  selectedTrackId.value = track.id;
}
function removeMClip() {
  const hit = selectedMClip.value;
  if (!hit) return;
  hit.track.clips = hit.track.clips.filter((c) => c.id !== hit.clip.id);
  selectedMClipId.value = null;
  timeline.version += 1;
}
function trackLabel(type: string) {
  return type === "music" ? "音频" : type === "subtitle" ? "字幕" : "视频";
}
function setTrackFlag(track: Track, key: "muted" | "hidden") {
  track[key] = !track[key];
  timeline.version += 1;
}

const clipStart = computed({
  get: () => (selectedMClip.value ? +(selectedMClip.value.clip.timelineStartMs / 1000).toFixed(2) : 0),
  set: (v: number) => {
    const hit = selectedMClip.value;
    if (!hit) return;
    hit.clip.timelineStartMs = Math.max(0, Math.round((Number(v) || 0) * 1000));
    timeline.version += 1;
  },
});
const clipIn = computed({
  get: () => (selectedMClip.value ? +(selectedMClip.value.clip.sourceInMs / 1000).toFixed(2) : 0),
  set: (v: number) => {
    const hit = selectedMClip.value;
    if (!hit) return;
    hit.clip.sourceInMs = Math.max(0, Math.round((Number(v) || 0) * 1000));
    if (hit.clip.sourceOutMs <= hit.clip.sourceInMs) hit.clip.sourceOutMs = hit.clip.sourceInMs + 200;
    hit.clip.durationMs = hit.clip.sourceOutMs - hit.clip.sourceInMs;
    timeline.version += 1;
  },
});
const clipOut = computed({
  get: () => (selectedMClip.value ? +(selectedMClip.value.clip.sourceOutMs / 1000).toFixed(2) : 0),
  set: (v: number) => {
    const hit = selectedMClip.value;
    if (!hit) return;
    hit.clip.sourceOutMs = Math.max(hit.clip.sourceInMs + 100, Math.round((Number(v) || 0) * 1000));
    hit.clip.durationMs = hit.clip.sourceOutMs - hit.clip.sourceInMs;
    timeline.version += 1;
  },
});
const clipTransition = computed({
  get: () => selectedMClip.value?.clip.transitionIn?.type ?? "none",
  set: (v: TransitionType) => {
    const hit = selectedMClip.value;
    if (!hit) return;
    hit.clip.transitionIn = { type: v, durationMs: v === "none" ? 0 : (hit.clip.transitionIn?.durationMs || 200) };
    timeline.version += 1;
  },
});
const clipTransitionMs = computed({
  get: () => selectedMClip.value?.clip.transitionIn?.durationMs ?? 0,
  set: (v: number) => {
    const hit = selectedMClip.value;
    if (!hit) return;
    hit.clip.transitionIn = { type: hit.clip.transitionIn?.type && hit.clip.transitionIn.type !== "none" ? hit.clip.transitionIn.type : "fade", durationMs: Math.max(0, Math.round(Number(v) || 0)) };
    timeline.version += 1;
  },
});
const transitionChoices = computed(() => {
  const hit = selectedMClip.value;
  if (!hit) return ["none"] as TransitionType[];
  if (hit.track.type === "music") return ["none", "fade"];
  if (hit.track.type === "subtitle") return ["none"];
  return ["none", "fade", "dissolve"];
});

const maxEndMs = computed(() => timeline.tracks.reduce((max, t) => Math.max(max, trackEnd(t)), 0));
const alignHint = computed(() => {
  if (!timeline.tracks.some((t) => t.clips.length)) return "";
  if (timeline.durationMs === maxEndMs.value) return "";
  return "声明总长 " + fmtMs(timeline.durationMs) + "，片段最大结束 " + fmtMs(maxEndMs.value) + "；渲染前建议对齐。";
});
function applyTimeline(next: unknown) {
  if (!next || typeof next !== "object") return;
  const value = next as Partial<Timeline>;
  if (Array.isArray(value.tracks)) timeline.tracks = value.tracks as Track[];
  if (value.canvas) timeline.canvas = value.canvas;
  if (typeof value.durationMs === "number") timeline.durationMs = value.durationMs;
  if (typeof value.version === "number") timeline.version = value.version;
}
async function validateTimeline() {
  mediaBusy.value = "validate";
  plan.value = null;
  mediaNotice.value = "";
  const value = await mediaCall<{ timeline?: unknown; durationMs: number; changed: boolean; issues: MediaIssue[]; assetCount: number }>("media/timeline/validate", {
    projectId: mediaProjectId.value,
    timeline,
  });
  mediaBusy.value = null;
  if (!value) return;
  issues.value = Array.isArray(value.issues) ? value.issues : [];
  applyTimeline(value.timeline);
  mediaNotice.value = value.changed
    ? "已对齐总长到 " + fmtMs(value.durationMs) + "（时间线声明值已更新）。"
    : "时间线校验通过；当前总长 " + fmtMs(value.durationMs) + "，素材 " + value.assetCount + " 个。";
}
async function planPreview() {
  mediaBusy.value = "plan";
  const value = await mediaCall<RenderPlan & { timeline?: unknown; issues?: MediaIssue[] }>("media/render/plan", {
    projectId: mediaProjectId.value,
    timeline,
  });
  mediaBusy.value = null;
  if (!value) return;
  plan.value = value;
  if (Array.isArray(value.issues)) issues.value = value.issues;
  if (value.timeline) applyTimeline(value.timeline);
  mediaNotice.value = "渲染计划已生成：总长 " + fmtMs(value.durationMs || 0) + "，输入 " + (value.inputCount || 0) + " 个。";
}
async function submitRender() {
  mediaBusy.value = "submit";
  const value = await mediaCall<{ job: RenderJob }>("media/render/submit", {
    projectId: mediaProjectId.value,
    projectName: project.name,
    timeline,
  });
  mediaBusy.value = null;
  if (!value?.job) return;
  job.value = value.job;
  mediaNotice.value = "渲染任务已提交（" + String(value.job.id || "").slice(0, 12) + "，状态 " + String(value.job.status || "queued") + "）；不会自动执行。";
}
async function refreshJob() {
  if (!job.value?.id) return;
  const value = await mediaCall<{ job: RenderJob }>("media/render/get", { jobId: job.value.id });
  if (value?.job) job.value = value.job;
}
async function runRoughCut() {
  const instruction = roughInstruction.value.trim();
  if (!instruction || roughBusy.value) return;
  roughBusy.value = true;
  roughError.value = "";
  roughCandidate.value = null;
  const value = await mediaCall<{ timeline?: unknown; durationMs?: number; issues?: MediaIssue[]; adapter?: string | null }>("media/rough-cut", {
    projectId: mediaProjectId.value,
    instruction,
    durationMs: Math.max(1, Number(roughSeconds.value) || 8) * 1000,
    canvas: timeline.canvas,
  });
  roughBusy.value = false;
  if (!value) {
    roughError.value = mediaError.value;
    return;
  }
  roughCandidate.value = value;
  mediaNotice.value = "Agent 粗剪返回了候选时间线" + (value.adapter ? "（" + value.adapter + "）" : "") + "；请预览确认后采用。";
}
async function adoptRoughCut() {
  if (!roughCandidate.value?.timeline) return;
  applyTimeline(roughCandidate.value.timeline);
  issues.value = Array.isArray(roughCandidate.value.issues) ? roughCandidate.value.issues : [];
  roughCandidate.value = null;
  timeline.version += 1;
  await validateTimeline();
  await planPreview();
  mediaNotice.value = "已采用 Agent 粗剪时间线；请检查时长与渲染计划，再提交渲染。";
}

const canvasPreset = computed(() => {
  if (project.resolution === "720p") return { width: 1280, height: 720, fps: 30 };
  if (project.resolution === "480p") return { width: 854, height: 480, fps: 30 };
  return { width: 1920, height: 1080, fps: 30 };
});
watch(() => project.resolution, () => {
  timeline.canvas = { ...canvasPreset.value };
}, { immediate: true });

/* ── 预览与生命周期 ───────────────────────────────────────────────────── */
const previewClip = computed(() => {
  const hit = selectedMClip.value;
  if (!hit) return null;
  const src = hit.clip.assetId ? sources[hit.clip.assetId] : undefined;
  return src ? { folderId: src.folderId, id: src.id, name: hit.clip.name } : null;
});
let offProgress: (() => void) | null = null;
onMounted(async () => {
  offProgress = bridge?.onProgress((e) => (progress.value = e.ratio)) ?? null;
  ff.value = bridge ? await bridge.status().catch(() => ({ available: false })) : null;
  void loadAssets();
  void ensureMediaProject();
});
onBeforeUnmount(() => offProgress?.());
</script>

<template>
  <div class="split video-app">
    <nav class="split-side" :aria-label="t('素材')">
      <div class="split-section">{{ t("素材") }} <small class="planned-count">{{ assets.length }}</small></div>
      <div class="notes-list">
        <button v-for="a in assets" :key="a.key" type="button" class="notes-item vd-asset" :disabled="!ff?.available || mediaBusy !== null" @click="mode === 'quick' ? add(a) : importAsset(a)">
          <span class="notes-item-name">{{ baseName(a.name) }}</span>
          <small>{{ mediaBusy === "import:" + a.key ? t("正在导入…") : adding === a.key ? t("正在读取…") : mode === "quick" ? t("点按加入快速剪辑") : t("点按导入多轨并加入") }}</small>
          <Plus class="vd-asset-plus" :size="13" />
        </button>
        <p v-if="!assets.length" class="planned-note">{{ t("访达里还没有视频。把 mp4 / mov 拖进访达即可在这里使用。") }}</p>
      </div>
      <template v-if="mode === 'multi'">
        <div class="split-section">{{ t("多轨素材") }} <small class="planned-count">{{ mediaAssets.length }}</small></div>
        <div class="notes-list">
          <div v-for="a in mediaAssets" :key="a.id" class="notes-item mt-asset" :data-media-asset="a.id">
            <span class="notes-item-name">{{ baseName(a.name) }}</span>
            <small>{{ trackLabel(a.kind) }} · {{ fmtMs(Number(a.durationMs) || 0) }}</small>
            <button class="mt-mini" type="button" @click="addAssetClip(a)">{{ t("加入时间线") }}</button>
          </div>
          <p v-if="!mediaAssets.length" class="planned-note">{{ t("还没有导入多轨素材。从上方访达素材点按导入（单文件 ≤ 12 MB）。") }}</p>
        </div>
      </template>
      <p class="planned-note">
        {{ !bridge ? t("需要 OpenArc 桌面应用。") : ff === null ? t("正在检测 FFmpeg…") : ff.available ? t("本机 ") + ff.version : t("没有找到 FFmpeg：请先安装（例如 brew install ffmpeg）。") }}
      </p>
    </nav>

    <div class="split-main vd-main">
      <div class="pane-toolbar">
        <div class="segmented text" role="group" :aria-label="t('剪辑模式')" data-video-mode>
          <button :aria-pressed="mode === 'quick'" data-video-mode-quick @click="setMode('quick')">{{ t("快速单轨") }}</button>
          <button :aria-pressed="mode === 'multi'" data-video-mode-multi @click="setMode('multi')">{{ t("多轨编辑") }}</button>
        </div>
        <input v-model="project.name" class="notes-title" :aria-label="t('剪辑名称')" />
        <div class="toolbar-spacer" />
        <select v-model="project.resolution" class="vd-select" :aria-label="t('导出分辨率')">
          <option value="1080p">1080p</option>
          <option value="720p">720p</option>
          <option value="480p">480p</option>
          <option value="source">{{ t("与首个片段一致") }}</option>
        </select>
        <template v-if="mode === 'quick'">
          <button v-if="exporting" class="planned-today" @click="bridge?.cancel()"><X :size="12" /> {{ t("取消") }}</button>
          <button v-else class="planned-cta vd-export" :disabled="!project.clips.length || !ff?.available" @click="exportVideo">
            <Download :size="13" /> {{ t("导出") }}
          </button>
        </template>
        <template v-else>
          <button class="planned-today" :disabled="mediaBusy !== null" data-mt-validate @click="validateTimeline">{{ t("校验时间线") }}</button>
          <button class="planned-today" :disabled="mediaBusy !== null" data-mt-plan @click="planPreview">{{ t("预览渲染计划") }}</button>
          <button class="planned-cta" :disabled="mediaBusy !== null || !timeline.tracks.some((t) => t.clips.length)" data-mt-submit @click="submitRender">{{ t("提交渲染") }}</button>
        </template>
      </div>
      <div v-if="exporting" class="vd-progress" role="progressbar" :aria-valuenow="Math.round(progress * 100)"><span :style="{ width: progress * 100 + '%' }" /></div>
      <p v-if="message" class="vd-msg">{{ message }}</p>

      <!-- 快速单轨（保留原界面） -->
      <template v-if="mode === 'quick'">
        <div v-if="!project.clips.length" class="empty-content">
          <img class="large-icon" :src="iconUrl('video')" alt="" draggable="false" />
          <h2 class="planned-title">{{ t("从左侧加入片段") }}</h2>
          <p>{{ t("按顺序拼接多个视频，裁剪每段的入点和出点，然后导出成一个 MP4。") }}</p>
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
            <button class="music-play" :aria-label="playing ? t('暂停') : t('播放片段')" @click="togglePlay"><Pause v-if="playing" :size="15" /><Play v-else :size="15" /></button>
            <button class="planned-today" @click="previewAll">{{ t("预览全片") }}</button>
            <span class="mono vd-time">{{ fmt(now) }}</span>
            <div class="toolbar-spacer" />
            <template v-if="clip">
              <label class="vd-field">{{ t("入点") }} <input v-model.number="clip.start" type="number" step="0.1" min="0" @change="clamp(clip)" /></label>
              <button class="planned-today" :title="t('把入点设为当前播放位置')" @click="setIn">{{ t("设为当前") }}</button>
              <label class="vd-field">{{ t("出点") }} <input v-model.number="clip.end" type="number" step="0.1" min="0" @change="clamp(clip)" /></label>
              <button class="planned-today" :title="t('把出点设为当前播放位置')" @click="setOut">{{ t("设为当前") }}</button>
            </template>
          </div>
          <div class="vd-timeline" role="list" :aria-label="t('时间线')">
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
              <button class="icon-button" :aria-label="t('前移')" :title="t('前移')" @click="move(-1)"><ChevronLeft :size="15" /></button>
              <button class="icon-button" :aria-label="t('后移')" :title="t('后移')" @click="move(1)"><ChevronRight :size="15" /></button>
              <button class="icon-button" :aria-label="t('移出时间线')" :title="t('移出时间线')" @click="remove(clip.uid)"><Trash2 :size="14" /></button>
            </template>
          </div>
        </template>
      </template>

      <!-- 多轨编辑 -->
      <div v-else class="mt" data-mt-editor>
        <p v-if="mediaError" class="mt-error" role="alert" data-mt-error>{{ mediaError }}</p>
        <p v-if="mediaNotice" class="mt-note" role="status" data-mt-notice>{{ mediaNotice }}</p>

        <section class="mt-rough" data-mt-rough>
          <header class="mt-rough-head">
            <b>{{ t("Agent 粗剪") }}</b>
            <small>{{ t("文案 → 候选时间线 → 预览确认 → 采用 → 提交渲染") }}</small>
            <div class="toolbar-spacer" />
            <button class="mt-mini" type="button" @click="roughOpen = !roughOpen">{{ roughOpen ? t("收起") : t("展开") }}</button>
          </header>
          <template v-if="roughOpen">
            <textarea v-model="roughInstruction" class="mt-input mt-textarea" rows="3" data-mt-rough-instruction :placeholder="t('例如：把已导入素材按 3 秒节奏粗剪，配乐淡入，字幕只在开头出现')"></textarea>
            <div class="mt-rough-actions">
              <label class="mt-field">{{ t("目标时长（秒）") }}<input v-model.number="roughSeconds" type="number" min="1" max="7200" /></label>
              <button class="planned-cta" :disabled="roughBusy || !roughInstruction.trim()" data-mt-rough-run @click="runRoughCut">{{ roughBusy ? t("生成中…") : t("生成粗剪") }}</button>
            </div>
            <p v-if="roughError" class="mt-error" data-mt-rough-error>{{ roughError }}</p>
            <div v-if="roughCandidate" class="mt-candidate" data-mt-rough-candidate>
              <p>候选时间线：总长 {{ fmtMs(Number(roughCandidate.durationMs) || 0) }}<template v-if="roughCandidate.adapter"> · 适配器 {{ roughCandidate.adapter }}</template></p>
              <ul v-if="roughCandidate.issues && roughCandidate.issues.length" class="mt-issues">
                <li v-for="i in roughCandidate.issues" :key="i.code" :data-severity="i.severity">{{ i.severity }} · {{ i.code }} · {{ i.message }}</li>
              </ul>
              <div class="mt-rough-actions">
                <button class="planned-cta" data-mt-rough-adopt @click="adoptRoughCut">{{ t("采用并预览") }}</button>
                <button class="planned-today" @click="roughCandidate = null">{{ t("放弃") }}</button>
              </div>
            </div>
          </template>
        </section>

        <p v-if="alignHint" class="mt-hint" data-mt-align-hint>
          <span>{{ alignHint }}</span>
          <button class="mt-mini" type="button" @click="validateTimeline">{{ t("对齐全片") }}</button>
        </p>

        <section class="mt-tracks" data-mt-tracks>
          <div class="mt-ruler"><span>0s</span><span>{{ fmtMs(timeline.durationMs) }}</span></div>
          <div v-for="track in timeline.tracks" :key="track.id" class="mt-track" :data-track-type="track.type">
            <div class="mt-track-head">
              <b>{{ track.name }}</b>
              <small>{{ trackLabel(track.type) }}</small>
              <div class="toolbar-spacer" />
              <button class="mt-mini" type="button" :aria-pressed="track.muted" @click="setTrackFlag(track, 'muted')">{{ track.muted ? t("取消静音") : t("静音") }}</button>
              <button class="mt-mini" type="button" :aria-pressed="track.hidden" @click="setTrackFlag(track, 'hidden')">{{ track.hidden ? t("显示") : t("隐藏") }}</button>
            </div>
            <div class="mt-lane">
              <button
                v-for="c in track.clips"
                :key="c.id"
                type="button"
                class="mt-clip"
                :class="{ on: c.id === selectedMClipId, muted: track.muted, hidden: track.hidden }"
                :data-clip-id="c.id"
                :style="{ left: (c.timelineStartMs / Math.max(1, timeline.durationMs || maxEndMs || 1)) * 100 + '%', width: Math.max(2, (c.durationMs / Math.max(1, timeline.durationMs || maxEndMs || 1)) * 100) + '%' }"
                :title="c.name + ' · ' + fmtMs(c.durationMs)"
                @click="selectMClip(track, c)"
              >
                <span>{{ baseName(c.name) }}</span>
                <i v-if="c.transitionIn && c.transitionIn.type !== 'none'">{{ c.transitionIn.type }}</i>
              </button>
              <p v-if="!track.clips.length" class="mt-empty">{{ t("空轨 · 从左侧「加入时间线」") }}</p>
            </div>
          </div>
          <div v-if="timeline.tracks.find((t) => t.type === 'subtitle')" class="mt-sub-add">
            <input v-model="subtitleDraft" class="mt-input" :placeholder="t('字幕文本（占位，不进入渲染计划）')" :aria-label="t('字幕文本')" data-mt-subtitle />
            <button class="mt-mini" type="button" :disabled="!subtitleDraft.trim()" data-mt-subtitle-add @click="addSubtitleClip">{{ t("添加字幕片段") }}</button>
          </div>
        </section>

        <section v-if="selectedMClip" class="mt-editor" data-mt-clip-editor>
          <header class="mt-editor-head">
            <b>{{ selectedMClip.track.name }} · {{ baseName(selectedMClip.clip.name) }}</b>
            <small v-if="!selectedMClip.clip.assetId">{{ t("无素材（仅占位）") }}</small>
            <div class="toolbar-spacer" />
            <button class="mt-mini" type="button" data-mt-clip-remove @click="removeMClip">{{ t("移出时间线") }}</button>
          </header>
          <div class="mt-editor-grid">
            <label class="mt-field">{{ t("入点（秒）") }}<input v-model.number="clipIn" type="number" step="0.1" min="0" data-mt-clip-in /></label>
            <label class="mt-field">{{ t("出点（秒）") }}<input v-model.number="clipOut" type="number" step="0.1" min="0" data-mt-clip-out /></label>
            <label class="mt-field">{{ t("时间线起点（秒）") }}<input v-model.number="clipStart" type="number" step="0.1" min="0" data-mt-clip-start /></label>
            <span class="mt-field">{{ t("时长") }} <b class="mono">{{ fmtMs(selectedMClip.clip.durationMs) }}</b></span>
            <label class="mt-field">{{ t("转场") }}
              <select v-model="clipTransition" class="vd-select" data-mt-clip-transition>
                <option v-for="type in transitionChoices" :key="type" :value="type">{{ type }}</option>
              </select>
            </label>
            <label v-if="clipTransition !== 'none'" class="mt-field">{{ t("转场时长（毫秒）") }}<input v-model.number="clipTransitionMs" type="number" step="50" min="0" max="5000" data-mt-clip-transition-ms /></label>
          </div>
          <div v-if="previewClip" class="mt-preview">
            <video :key="previewClip.id + selectedMClip.clip.id" class="mt-preview-video" :src="fileUrl(previewClip.folderId, previewClip.id)" preload="metadata" muted />
            <small>{{ t("源素材预览（可拖动）；多轨合成预览请看渲染计划。") }}</small>
          </div>
          <p v-else class="mt-note">{{ t("这段片段没有本地源素材（例如粗剪结果里的素材尚未导入），因此不能在这里预览源画面。") }}</p>
        </section>

        <section v-if="issues.length" class="mt-issues-box" data-mt-issues>
          <h4>校验问题（{{ issues.length }}）</h4>
          <ul class="mt-issues">
            <li v-for="i in issues" :key="i.code + i.message" :data-severity="i.severity">{{ i.severity }} · {{ i.code }} · {{ i.message }}</li>
          </ul>
          <p class="mt-note">{{ t("error 会阻止渲染；warning 只提示重叠等情况。") }}</p>
        </section>

        <section v-if="plan" class="mt-plan" data-mt-plan-result>
          <h4>{{ t("渲染计划预览") }}</h4>
          <div class="mt-plan-rows">
            <span>{{ t("总长") }} <b class="mono">{{ fmtMs(plan.durationMs || 0) }}</b></span>
            <span>{{ t("输入") }} <b>{{ plan.inputCount || 0 }}</b> {{ t("个") }}</span>
            <span>{{ plan.durationAligned ? t("时长已对齐") : t("已声明时长，无需对齐") }}</span>
          </div>
          <ul v-if="plan.plan?.inputs?.length" class="mt-inputs">
            <li v-for="input in plan.plan.inputs" :key="input.clipId">
              <span class="mono">{{ input.clipId }}</span>
              <span>{{ trackLabel(input.trackType) }} · {{ input.kind }}</span>
              <span v-if="input.transition">{{ input.transition.type }} {{ input.transition.durationMs }}ms</span>
            </li>
          </ul>
          <p class="mt-note">{{ t("计划不含磁盘路径；提交后进入队列，不会自动执行。") }}</p>
        </section>

        <section v-if="job" class="mt-job" data-mt-job>
          <h4>{{ t("渲染任务") }}</h4>
          <div class="mt-plan-rows">
            <span class="mono">{{ job.id }}</span>
            <span>{{ t("状态") }} <b>{{ job.status }}</b></span>
            <span v-if="typeof job.progress === 'number'">进度 {{ Math.round((job.progress || 0) * 100) }}%</span>
            <button class="mt-mini" type="button" @click="refreshJob">{{ t("刷新状态") }}</button>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mt { flex: 1; min-height: 0; overflow: auto; padding: 4px 20px 18px; display: flex; flex-direction: column; gap: 10px; }
.mt-error { margin: 0; color: var(--failed); font-size: var(--fs-caption); }
.mt-note { margin: 0; color: var(--muted); font-size: var(--fs-caption); }
.mt-rough { border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 8px 10px; background: rgb(var(--text-rgb) / 0.03); }
.mt-rough-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mt-rough-head small { color: var(--muted); font-size: var(--fs-micro); }
.mt-rough-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
.mt-textarea { width: 100%; min-height: 54px; resize: vertical; box-sizing: border-box; margin-top: 6px; }
.mt-input { min-height: 28px; padding: 3px 8px; border: 1px solid var(--line); border-radius: var(--radius-md); background: rgb(var(--content-rgb) / 0.5); color: var(--text); font-size: var(--fs-caption); }
.mt-input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.mt-field { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-caption); color: var(--muted); }
.mt-field input { width: 84px; min-height: 26px; padding: 2px 6px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: rgb(var(--content-rgb) / 0.5); color: var(--text); font-size: var(--fs-caption); }
.mt-hint { margin: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 10px; border-radius: var(--radius-md); background: rgb(var(--warning-rgb) / 0.12); color: var(--text); font-size: var(--fs-caption); }
.mt-tracks { border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; }
.mt-ruler { display: flex; justify-content: space-between; color: var(--muted); font-size: var(--fs-micro); font-variant-numeric: tabular-nums; }
.mt-track { display: flex; flex-direction: column; gap: 4px; }
.mt-track-head { display: flex; align-items: center; gap: 6px; }
.mt-track-head b { font-size: var(--fs-caption); font-weight: var(--fw-medium); }
.mt-track-head small { color: var(--muted); font-size: var(--fs-micro); }
.mt-lane { position: relative; min-height: 34px; border-radius: var(--radius-sm); background: rgb(var(--text-rgb) / 0.05); overflow: hidden; }
.mt-clip { position: absolute; top: 4px; bottom: 4px; min-width: 8px; padding: 0 6px; border: 0; border-radius: var(--radius-sm); background: rgb(var(--text-rgb) / 0.16); color: var(--text); font-size: var(--fs-micro); text-align: left; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; cursor: pointer; }
.mt-clip.on { box-shadow: inset 0 0 0 2px var(--text); }
.mt-clip.muted { opacity: 0.45; }
.mt-clip.hidden { opacity: 0.25; }
.mt-clip i { margin-left: 4px; opacity: 0.7; font-style: normal; }
.mt-empty { position: absolute; left: 8px; top: 8px; margin: 0; color: var(--muted); font-size: var(--fs-micro); }
.mt-sub-add { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mt-sub-add .mt-input { flex: 1 1 220px; }
.mt-mini { min-height: 22px; padding: 0 8px; border: 1px solid var(--line); border-radius: var(--radius-pill); background: transparent; color: var(--muted); font-size: var(--fs-micro); cursor: pointer; }
.mt-mini:hover { color: var(--text); }
.mt-mini[aria-pressed="true"] { color: var(--text); border-color: var(--text); }
.mt-editor { border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.mt-editor-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mt-editor-head small { color: var(--muted); font-size: var(--fs-micro); }
.mt-editor-grid { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mt-preview { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mt-preview-video { width: 180px; max-height: 110px; border-radius: var(--radius-md); background: #000; }
.mt-candidate { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
.mt-issues-box { border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 8px 10px; }
.mt-issues-box h4 { margin: 0 0 4px; font-size: var(--fs-caption); font-weight: var(--fw-medium); }
.mt-issues { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; font-size: var(--fs-micro); color: var(--muted); }
.mt-issues li[data-severity="error"] { color: var(--failed); }
.mt-plan, .mt-job { border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 8px 10px; }
.mt-plan h4, .mt-job h4 { margin: 0 0 4px; font-size: var(--fs-caption); font-weight: var(--fw-medium); }
.mt-plan-rows { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: var(--fs-caption); color: var(--muted); }
.mt-plan-rows b { color: var(--text); font-weight: var(--fw-medium); }
.mt-inputs { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 1px; font-size: var(--fs-micro); color: var(--muted); }
.mt-inputs li { display: flex; gap: 10px; flex-wrap: wrap; }
</style>
