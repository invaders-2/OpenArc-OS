type Bridge = {
  canvas?: { command?: (request: Record<string, unknown>) => Promise<Record<string, unknown>> };
  media?: { command?: (request: Record<string, unknown>) => Promise<Record<string, unknown>>; onEvent?: (cb: (event: unknown) => void) => () => void };
};

function bridge(): Bridge {
  return ((window as unknown as { openarc?: Bridge }).openarc || {}) as Bridge;
}

export function backendExportAvailable(): boolean {
  const api = bridge();
  return typeof api.media?.command === "function" && typeof api.canvas?.command === "function";
}

function base64FromDataUrl(url: string): { base64: string; mime: string } | null {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.*)$/i.exec(url);
  if (!match) return null;
  return { mime: match[1] || "application/octet-stream", base64: match[2] || "" };
}

async function urlToBase64(url: string, kind: "video" | "audio"): Promise<{ base64: string; mime: string }> {
  const direct = base64FromDataUrl(url);
  if (direct) return direct;
  const api = bridge();
  if (url.startsWith("openarc-asset:")) {
    const ref = url.slice("openarc-asset:".length);
    const res = await api.canvas?.command?.({ type: "canvas/readAsset", ref }) as Record<string, any> | undefined;
    const dataUrl = String((res && (res.dataUrl || res.url || (res.asset && (res.asset.dataUrl || res.asset.url)))) || "");
    const parsed = dataUrl ? base64FromDataUrl(dataUrl) : null;
    if (!parsed) throw new Error("ASSET_READ_FAILED");
    return parsed;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error("ASSET_FETCH_FAILED");
  const buffer = await response.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return { base64: btoa(binary), mime: response.headers.get("content-type") || (kind === "video" ? "video/mp4" : "audio/mpeg") };
}

export type BackendExportClip = { url: string; mediaKind: "video" | "audio"; inPoint: number; outPoint: number };

/** 画布 id → 固定的 UUID（SHA-1 截取，按 v5 格式置版本 / 变体位），同一张画布每次导出都进同一个媒体项目 */
async function canvasProjectUuid(canvasId: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode("openarc-canvas-export:" + String(canvasId || "default")))).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export async function exportTimelineMp4({ clips, canvasId, onProgress }: { clips: BackendExportClip[]; canvasId: string; onProgress?: (value: number) => void }): Promise<{ relativePath: string }> {
  const api = bridge();
  if (typeof api.media?.command !== "function") throw new Error("MEDIA_SERVICE_UNAVAILABLE");
  if (typeof api.canvas?.command !== "function") throw new Error("CANVAS_BRIDGE_UNAVAILABLE");
  if (!clips.length) throw new Error("EMPTY_TIMELINE");
  const projectId = await canvasProjectUuid(canvasId); // 媒体服务只认 UUID 形式的项目 ID
  // 媒体服务返回 { ok, value } 信封：在这里拆开，失败时把服务给的原因带出去
  const command = async (cmd: string, payload: Record<string, unknown>): Promise<any> => {
    const r: any = await api.media!.command!({ command: cmd, payload });
    if (r && r.ok === false) throw new Error(String(r.message || r.error || cmd + " 失败"));
    return r && typeof r === "object" && "value" in r && r.ok === true ? r.value : r;
  };
  onProgress?.(3);
  await command("media/project/ensure", { projectId, projectName: "Canvas 导出" });
  const videoClips: Array<Record<string, unknown>> = [];
  const audioClips: Array<Record<string, unknown>> = [];
  // 视频轨、音频轨各自从 0 开始依次排（配音 / 音乐垫在画面下面），成片时长取两轨里较长的
  let vCursor = 0; let aCursor = 0;
  let videoIndex = 0;
  let audioIndex = 0;
  for (let i = 0; i < clips.length; i += 1) {
    const clip = clips[i];
    const media = await urlToBase64(clip.url, clip.mediaKind);
    const extOf: Record<string, string> = { "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/ogg": ".ogg" };
    const name = "canvas-" + projectId + "-" + i + (extOf[String(media.mime).toLowerCase()] || (clip.mediaKind === "video" ? ".mp4" : ".mp3"));
    const saved = await command("media/asset/save", { projectId, name, mime: media.mime, base64: media.base64 });
    const asset = (saved && saved.asset) as Record<string, unknown> | undefined;
    if (!asset || !asset.id) throw new Error("ASSET_SAVE_FAILED");
    const durationMs = Math.max(100, Math.round((clip.outPoint - clip.inPoint) * 1000));
    const sourceInMs = Math.max(0, Math.round(clip.inPoint * 1000));
    const sourceOutMs = Math.max(sourceInMs + 100, Math.round(clip.outPoint * 1000));
    const entry = {
      id: "clip-" + (clip.mediaKind === "video" ? "v" + (videoIndex += 1) : "a" + (audioIndex += 1)),
      trackId: clip.mediaKind === "video" ? "video-track" : "audio-track",
      assetId: String(asset.id),
      name,
      timelineStartMs: clip.mediaKind === "video" ? vCursor : aCursor,
      durationMs,
      sourceInMs,
      sourceOutMs,
      volume: 1,
    };
    if (clip.mediaKind === "video") videoClips.push(entry); else audioClips.push(entry);
    if (clip.mediaKind === "video") vCursor += durationMs; else aCursor += durationMs;
    onProgress?.(5 + Math.round(((i + 1) / clips.length) * 35));
  }
  if (!videoClips.length) throw new Error("NO_VISUAL_CLIP");
  const timeline = {
    schemaVersion: "1.0",
    projectId,
    version: 1,
    timebase: 1000,
    canvas: { width: 1280, height: 720, fps: 30 },
    durationMs: Math.max(0, vCursor, aCursor),
    outputProfileId: null,
    tracks: [
      { id: "video-track", type: "video", name: "视频", order: 0, locked: false, muted: false, hidden: false, clips: videoClips },
      { id: "audio-track", type: "voice", name: "音频", order: 1, locked: false, muted: false, hidden: false, clips: audioClips },
    ].filter((track) => track.clips.length > 0),
    transitions: [],
  };
  onProgress?.(45);
  const rendered = await command("media/render/submit", { projectId, projectName: "Canvas 导出", timeline });
  const renderJob = (rendered && rendered.job) as Record<string, unknown> | undefined;
  if (!renderJob || !renderJob.id) throw new Error("RENDER_SUBMIT_FAILED");
  onProgress?.(60);
  await command("media/render/run", { workerId: "canvas_export_worker", timeoutMs: 600000 });
  onProgress?.(90);
  const exported = await command("media/render/export", { projectId, jobId: renderJob.id, target: "finder", name: "剪辑时间线-" + (() => { const d = new Date(); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; })() + ".mp4", requestedName: "timeline-" + canvasId });
  const payload = (exported && (exported.export || exported.artifact || exported)) as Record<string, unknown>;
  const relativePath = String((payload && (payload.relativePath || payload.path)) || "");
  if (!relativePath) throw new Error("EXPORT_PATH_MISSING");
  onProgress?.(100);
  return { relativePath };
}
