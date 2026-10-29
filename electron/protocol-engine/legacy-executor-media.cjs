"use strict";
/**
 * W4c · legacy 协议执行器：视频 / 音频 / 图片编辑 + Midjourney。
 *
 * 忠实移植自 DX OS：server/protocols.ts（只读源，不执行、不修改）。
 * 逐条对应（源文件:行号）：
 *   collectVideoUrls                        protocols.ts:5372
 *   extractVideoTaskId                      protocols.ts:5389
 *   videoStatus                             protocols.ts:5397
 *   mediaDataUrl                            protocols.ts:5405
 *   volcengineVideoReferenceContentItems    protocols.ts:5415
 *   generateVolcengineVideos                protocols.ts:5457
 *   collectMediaUrls                        protocols.ts:5542
 *   extractUploadedMediaUrl                 protocols.ts:5559
 *   apimartUploadPaths                      protocols.ts:5563
 *   uploadApimartMedia                      protocols.ts:5569
 *   agTokenReferenceUrl / agTokenTaskView   protocols.ts:5609 / :5615
 *   throwIfAgTokenTaskFailed                protocols.ts:5647
 *   generateAgTokenVideos                   protocols.ts:5658
 *   zkkiReferenceUrl / generateZkkiVideos   protocols.ts:5821 / :5827
 *   minimaxReferenceUrl / generateMinimaxVideos protocols.ts:5915 / :5921
 *   generateVideos / generateVideosUnmetered protocols.ts:6023 / :6035
 *   audioRuntimeDefinition / generateSpeech protocols.ts:6314 / :6324
 *   transcribeAudio / collectAudioUrls      protocols.ts:6389 / :6429
 *   generateMusic                           protocols.ts:6441
 *   editImages / editImagesUnmetered        protocols.ts:6501 / :6512
 *   Midjourney 全族                          protocols.ts:4639-4968
 *       isMidjourneyProvider / midjourneyResponseData / midjourneyTaskId / midjourneyTaskStatus /
 *       midjourneyErrorDetail / midjourneyRemoteImages / midjourneyAspectRatio / midjourneyVersion /
 *       midjourneyReferenceUrls / callMidjourneyJson / midjourneyTask / submitMidjourney /
 *       getMidjourneyTask / submitMidjourneyAction / submitMidjourneyModal / generateMidjourneyImages
 *
 * 复用的同批 W4b 图片执行器（electron/protocol-engine/legacy-executor-images.cjs）：
 *   parseImagePayload / imageTaskId / imageTaskStatus / openAiImageQuality / isGptBestAsyncImageProvider /
 *   isApibOpenAiImageProvider / apibImageAspectRatio / prepareApibEditInputs / usesGenerationEndpointForImageEdit /
 *   editOpenAiCompatibleGenerationImages / generateApimartImages / generateGeminiImages /
 *   generateVolcengineImages / requestZkkiImages / requestGrok2ApiImages
 *
 * 端口未注入依赖（一律返回 { ok:false, error:"LEGACY_DEPENDENCY_UNAVAILABLE", detail:"<缺什么、怎么补>" }，不做假实现）：
 *   1. cliTools 原生适配（cli:jimeng / jimeng-cli）：generateJimengVideo / generateJimengImage —— B7e2 后续：
 *      CLI 端口已注入则调用，未注入即结构化拒绝（electron/legacy-cli-ports.cjs）
 *   2. agentCliTools 原生适配（cli:codex / cli:gemini）：editCodexImage / editGeminiCliImage —— 同上
 *   3. runninghub：generateRunningHubVideos / editRunningHubImages — B7e2 端口（electron/plugin-runninghub.cjs）
 *   4. modelscope：editModelScopeImages — B7e2 端口（electron/plugin-modelscope.cjs）
 *   5. agnes 原生适配：generateAgnesVideos / editAgnesImages — B7e3 端口（electron/plugin-agnes.cjs）；
 *      插件关闭 / 未注入端口时结构化拒绝
 *   6. apiQuota 云计费（apiQuota.ts:280 withDirectApiQuota）属 OUT，未移植：本模块只执行上游 *Unmetered 路径，
 *      不伪造预扣/结算；需要计费门禁的调用方请在调用前使用 electron/dxos-foundation-quota.cjs 自行预扣/结算。
 *   7. sharp 仅惰性 require（在 W4b legacy-executor-images.cjs 的 prepareApibEditInputs 内），未写入 package.json；
 *      缺失时返回结构化错误（见 BATCH.sharp）。
 *
 * 移除项（明确 OUT，绝不向 api.dx-os.com 发请求）：
 *   1. verifyDxTemporaryUrl 对 api.dx-os.com /v1/media/temp/ 参考素材的 Range GET 探测
 *      （源 protocols.ts:5677-5705，探测体在 :5680-5704）：B2 任务明确排除"一切 api.dx-os.com 调用"，
 *      该联网探测属 OUT。本函数改为恒返回「不是 DX 临时 URL」，调用方沿用源 :5680 的等价分支
 *      原样使用该 URL，参考素材不丢失（详见函数内注释）。
 *
 * 与源实现的差异（可测试性，不改变协议语义）：
 *   · 所有网络请求统一走 electron/protocol-engine/transport.cjs 的 transport.fetch，默认 defaultProtocolTransport。
 *   · 所有轮询等待统一走可注入 clock（默认 defaultProtocolClock），替代源里直接使用的全局 fetch / setTimeout / Date.now。
 *   · Midjourney 默认 API root 仍为源 :4639 的 https://api.apimart.ai，可用 options.apiRoot 覆盖（仅测试/自建站点）。
 */

const { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { PROTOCOLS, normalizeProtocol, normalizeProtocolId, buildAuthHeaders, joinUrl } = require("./legacy-protocols.cjs");
const { defaultProtocolTransport, defaultProtocolClock } = require("./transport.cjs");
const images = require("./legacy-executor-images.cjs");
const legacyExecutorPorts = require("../legacy-executor-ports.cjs");

const LEGACY_DEPENDENCY_UNAVAILABLE = "LEGACY_DEPENDENCY_UNAVAILABLE";

/** 结构化「依赖不可用」结果（硬约束 8）。 */
function unavailable(detail) {
  return { ok: false, error: LEGACY_DEPENDENCY_UNAVAILABLE, detail };
}

/** CLI 协议族端口未注入时的结构化拒绝前缀（B7e2 后续；注入/调用见 electron/legacy-cli-ports.cjs）。 */
const CLI_PORT_DETAIL = "CLI 端口未注入（需安装对应 CLI，由主进程经 electron/legacy-cli-ports.cjs 注入 cliJimeng/cliCodex/cliGemini）";

/** 可选插件端口未注入时的说明，供 detail 使用（只写「缺什么、怎么补」，不再写「未移植」）。 */
const BATCH = {
  runninghub: "runninghub 端口未注入：需启用 runninghub 插件并配置凭据（由主进程经 electron/plugin-service.cjs 注入）",
  modelscope: "modelscope 端口未注入：需启用 modelscope 插件并配置凭据（由主进程经 electron/plugin-service.cjs 注入）",
  agnes: "agnes 端口未注入：需启用 agnes 插件并配置凭据（由主进程经 electron/plugin-service.cjs 注入）",
  sharp: "sharp 惰性可选依赖（未安装；不得写入 package.json）",
};

function resolveTransport(transport) {
  return transport && typeof transport.fetch === "function" ? transport : defaultProtocolTransport;
}

function resolveClock(clock) {
  return clock && typeof clock.now === "function" && typeof clock.sleep === "function" ? clock : defaultProtocolClock;
}

// 源：protocols.ts:3415-3420（legacy-protocols.cjs 未导出 assertRunnableProtocol，按冻结接口做等价判定）
function assertRunnableProtocol(id, surface) {
  const key = String(id || "").trim().toLowerCase();
  if (!key || key === "midjourney") return;
  const runnable = typeof normalizeProtocolId === "function" ? normalizeProtocolId(key, "") : normalizeProtocol(key, "");
  if (!runnable) throw new Error(surface + " 协议「" + key + "」还在待适配，暂时不能直接调用。");
}

// 源：protocols.ts:5405
function mediaDataUrl(input) {
  return "data:" + (input.mime || "application/octet-stream") + ";base64," + input.buf.toString("base64");
}

// ── 视频：通用响应收集 ───────────────────────────────────────────────

// 源：protocols.ts:5372-5387
function collectVideoUrls(value, out = [], depth = 0, keyHint = "") {
  if (depth > 8 || value == null) return out;
  if (typeof value === "string") {
    if (/^(https?:\/\/|asset:\/\/)/i.test(value) && (keyHint || /\.(mp4|webm|mov|m4v)(\?|$)/i.test(value))) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectVideoUrls(item, out, depth + 1, keyHint);
    return out;
  }
  if (typeof value !== "object") return out;
  for (const key of ["video_url", "videoUrl", "url", "uri", "download_url", "downloadUrl", "video", "videos", "outputs", "results", "content", "data", "detail", "result"]) {
    if (key in value) collectVideoUrls(value[key], out, depth + 1, /video|url|output|result|content|download/i.test(key) ? key : keyHint);
  }
  return out;
}

// 源：protocols.ts:5389-5395
function extractVideoTaskId(payload) {
  const roots = [payload, payload && payload.data, payload && payload.result, payload && payload.output]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value) => value && typeof value === "object");
  const candidates = roots.flatMap((value) => [value.request_id, value.requestId, value.id, value.task_id, value.taskId]);
  return candidates.map((value) => String(value || "").trim()).find(Boolean) || "";
}

// 源：protocols.ts:5397-5403
function videoStatus(payload) {
  const data = payload && payload.data;
  const node = Array.isArray(data)
    ? data.find((value) => value && typeof value === "object") || payload
    : data && typeof data === "object" ? data : payload;
  return String((node && (node.status || node.task_status || node.taskStatus)) || (payload && payload.status) || "").trim().toUpperCase();
}

// ── 视频：火山方舟 ───────────────────────────────────────────────────

// 源：protocols.ts:5409-5455
async function volcengineVideoReferenceContentItems(input) {
  const publicUrl = String(input.publicUrl || "").trim();
  if (/^asset:\/\//i.test(publicUrl)) {
    return [{ type: "video_url", video_url: { url: publicUrl }, role: "reference_video" }];
  }
  if (!input.buf || !input.buf.length) throw new Error("火山方舟视频参考缺少可读取的视频文件；请重新上传视频。");
  const frameDir = mkdtempSync(join(tmpdir(), "dx-volcengine-frames-"));
  const sourceExt = /webm/i.test(input.mime) ? ".webm" : /quicktime/i.test(input.mime) ? ".mov" : ".mp4";
  const source = join(frameDir, "source" + sourceExt);
  const pattern = join(frameDir, "frame-%03d.jpg");
  try {
    writeFileSync(source, input.buf);
    const executable = String(process.env.FFMPEG_PATH || "ffmpeg").trim();
    const result = await new Promise((resolve) => {
      const child = spawn(executable, [
        "-hide_banner", "-loglevel", "error", "-y", "-i", source,
        "-vf", "fps=1,scale='min(768,iw)':-2", "-frames:v", "4", pattern,
      ], { windowsHide: true });
      const stderr = [];
      const timer = setTimeout(() => child.kill(), 90000);
      child.stderr.on("data", (chunk) => {
        if (stderr.reduce((total, item) => total + item.length, 0) < 2 * 1024 * 1024) stderr.push(Buffer.from(chunk));
      });
      child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, stderr: "", error }); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ code: code == null ? -1 : code, stderr: Buffer.concat(stderr).toString("utf8") }); });
    });
    if (result.error || result.code !== 0) {
      const detail = String((result.error && result.error.message) || result.stderr || ("exit=" + result.code)).trim().slice(0, 300);
      throw new Error("火山方舟无法读取视频参考，请确认 FFmpeg 可用：" + detail);
    }
    const frames = readdirSync(frameDir).filter((name) => /^frame-\d+\.jpg$/i.test(name)).sort().slice(0, 4);
    if (!frames.length) throw new Error("火山方舟未能从参考视频提取画面。");
    return frames.map((name) => ({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64," + readFileSync(join(frameDir, name)).toString("base64") },
      role: "reference_image",
    }));
  } finally {
    rmSync(frameDir, { recursive: true, force: true });
  }
}

// 源：protocols.ts:5457-5540
async function generateVolcengineVideos(provider, model, params, input, timeoutMs = 600000, transport, clock) {
  const net = resolveTransport(transport);
  const time = resolveClock(clock);
  const requestedModel = String(model || "").trim();
  const prompt = String(params.prompt || "").trim();
  if (!requestedModel) throw new Error("缺少 Seedance 视频模型");
  if (!prompt) throw new Error("缺少视频提示词");
  const imageList = [...(params.images || []), ...(input ? [{ ...input, kind: "image" }] : [])];
  const videos = params.videos || [];
  const audios = params.audios || [];
  const content = [{ type: "text", text: prompt }];
  let firstFrameUsed = false;
  let lastFrameUsed = false;
  for (const image of imageList.slice(0, 9)) {
    const url = String(image.publicUrl || mediaDataUrl(image));
    const explicitRole = String(image.role || "").trim().toLowerCase();
    let role = explicitRole;
    if (!["first_frame", "last_frame", "reference_image"].includes(role)) {
      role = params.multimodal ? "reference_image" : firstFrameUsed ? "" : "first_frame";
    }
    if (!role || (role === "first_frame" && firstFrameUsed) || (role === "last_frame" && lastFrameUsed)) continue;
    if (role === "first_frame") firstFrameUsed = true;
    if (role === "last_frame") lastFrameUsed = true;
    content.push({ type: "image_url", image_url: { url }, role });
  }
  for (const video of videos.slice(0, 3)) content.push(...await volcengineVideoReferenceContentItems(video));
  for (const audio of audios.slice(0, 3)) {
    content.push({ type: "audio_url", audio_url: { url: audio.publicUrl || mediaDataUrl(audio) }, role: "reference_audio" });
  }
  const resolutionRaw = String(params.resolution || "").trim().toLowerCase();
  const resolution = ({ "480": "480p", "720": "720p", "1080": "1080p" })[resolutionRaw] || resolutionRaw;
  const body = {
    model: requestedModel,
    content,
    duration: Math.max(1, Math.min(60, Math.round(Number(params.duration) || 5))),
    ...(params.aspect_ratio || params.size ? { ratio: String(params.aspect_ratio || params.size) } : {}),
    ...(["480p", "720p", "1080p"].includes(resolution) ? { resolution } : {}),
    ...(params.watermark ? { watermark: true } : {}),
    ...(params.generate_audio ? { generate_audio: true } : {}),
    ...(params.camerafixed ? { camerafixed: true } : {}),
    ...(params.seed !== undefined ? { seed: params.seed } : {}),
    ...(params.return_last_frame ? { return_last_frame: true } : {}),
  };
  const def = PROTOCOLS.volcengine;
  const submitUrl = joinUrl(provider.base_url, "/api/v3/contents/generations/tasks");
  const headers = { Accept: "application/json", "Content-Type": "application/json", ...buildAuthHeaders(def, provider.api_key) };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const submit = await net.fetch(submitUrl, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    const submitText = await submit.text();
    let payload;
    try { payload = JSON.parse(submitText); } catch { payload = submitText; }
    if (!submit.ok) throw new Error("火山方舟视频接口 HTTP " + submit.status + ": " + submitText.slice(0, 500));
    let urls = collectVideoUrls(payload).filter((url, index, list) => list.indexOf(url) === index);
    const taskId = extractVideoTaskId(payload);
    if (!urls.length && !taskId) throw new Error("火山方舟未返回任务 ID：" + submitText.slice(0, 500));
    const deadline = time.now() + timeoutMs;
    while (!urls.length && taskId && time.now() < deadline) {
      await time.sleep(2000);
      const taskUrl = joinUrl(provider.base_url, "/api/v3/contents/generations/tasks/" + encodeURIComponent(taskId));
      const task = await net.fetch(taskUrl, { headers: { Accept: "application/json", ...buildAuthHeaders(def, provider.api_key) }, signal: ctrl.signal });
      const taskText = await task.text();
      try { payload = JSON.parse(taskText); } catch { payload = taskText; }
      if (!task.ok) throw new Error("火山方舟任务查询 HTTP " + task.status + ": " + taskText.slice(0, 500));
      urls = collectVideoUrls(payload).filter((url, index, list) => list.indexOf(url) === index);
      const status = videoStatus(payload);
      if (["FAILED", "FAILURE", "ERROR", "CANCELED", "CANCELLED", "TIMEOUT", "REJECTED"].includes(status)) {
        throw new Error("火山方舟视频任务失败：" + taskText.slice(0, 500));
      }
    }
    if (!urls.length) throw new Error("火山方舟视频生成超时或没有返回视频地址。");
    return { videos: urls.map((value) => ({ type: "url", value })), raw: payload };
  } catch (error) {
    if (ctrl.signal.aborted) throw new Error("火山方舟视频生成超时，请稍后重试。");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ── 视频：APIMart 媒体上传 ───────────────────────────────────────────

// 源：protocols.ts:5542-5557
function collectMediaUrls(value, out = [], depth = 0) {
  if (depth > 6 || value == null) return out;
  if (typeof value === "string") {
    if (/^(https?:\/\/|asset:\/\/)/i.test(value.trim())) out.push(value.trim());
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMediaUrls(item, out, depth + 1);
    return out;
  }
  if (typeof value !== "object") return out;
  for (const key of ["url", "uri", "asset_url", "assetUrl", "file_url", "fileUrl", "download_url", "downloadUrl", "data", "file", "asset", "result"]) {
    if (key in value) collectMediaUrls(value[key], out, depth + 1);
  }
  return out;
}

// 源：protocols.ts:5559-5561
function extractUploadedMediaUrl(payload) {
  return collectMediaUrls(payload).find((value) => /^(https?:\/\/|asset:\/\/)/i.test(value)) || "";
}

// 源：protocols.ts:5563-5567
function apimartUploadPaths(kind) {
  if (kind === "image") return ["/v1/uploads/images"];
  if (kind === "video") return ["/v1/uploads/videos", "/v1/uploads/files", "/v1/uploads/images"];
  return ["/v1/uploads/audios", "/v1/uploads/files", "/v1/uploads/images"];
}

// 源：protocols.ts:5569-5607
async function uploadApimartMedia(provider, input, timeoutMs, transport) {
  const net = resolveTransport(transport);
  if (String(input.publicUrl || "").match(/^https?:\/\//i)) return String(input.publicUrl);
  const headers = { Accept: "application/json", ...buildAuthHeaders(PROTOCOLS.apimart, provider.api_key) };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let lastError = "";
    for (const endpoint of apimartUploadPaths(input.kind)) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(input.buf)], { type: input.mime || "application/octet-stream" }), input.name || ("input." + input.kind));
      try {
        const resp = await net.fetch(joinUrl(provider.base_url, endpoint), { method: "POST", headers, body: form, signal: ctrl.signal });
        const text = await resp.text();
        let payload;
        try { payload = JSON.parse(text); } catch { payload = text; }
        if (!resp.ok) { lastError = "HTTP " + resp.status + ": " + text.slice(0, 240); continue; }
        const url = extractUploadedMediaUrl(payload);
        if (url) return url;
        lastError = "上传响应未包含可用地址";
      } catch (error) {
        if (ctrl.signal.aborted) throw error;
        lastError = String((error && error.message) || error);
      }
    }
    throw new Error("APIMart " + (input.kind === "image" ? "图片" : input.kind === "video" ? "视频" : "音频") + "上传失败：" + (lastError || "未找到可用上传入口"));
  } finally {
    clearTimeout(timer);
  }
}

// ── 视频：AGToken ────────────────────────────────────────────────────

// 源：protocols.ts:5609-5613
function agTokenReferenceUrl(input) {
  const url = String(input.publicUrl || "").trim();
  if (/^https:\/\//i.test(url)) return url;
  throw new Error("AGToken 的" + (input.kind === "image" ? "图片" : input.kind === "video" ? "视频" : "音频") + "素材必须是公网可直接读取的 HTTPS 文件 URL。");
}

// 源：protocols.ts:5615-5643
function agTokenTaskView(payload) {
  const node = payload && payload.data && typeof payload.data === "object"
    ? payload.data
    : payload && payload.output && typeof payload.output === "object"
      ? payload.output
      : payload;
  const taskId = String((node && (node.task_id || node.id)) || (payload && (payload.task_id || payload.id)) || "").trim();
  const status = String((node && (node.task_status || node.status)) || (payload && payload.status) || "").trim().toUpperCase();
  const rawResult = String((node && (node.result_url || node.video_url || (node.content && node.content.video_url))) || (payload && payload.content && payload.content.video_url) || "").trim();
  const resultUrl = /^(https?:\/\/|asset:\/\/)/i.test(rawResult) ? rawResult : "";
  const nestedError = typeof (node && node.error) === "string"
    ? node.error
    : typeof (payload && payload.error) === "string"
      ? payload.error
      : (node && node.error && node.error.message) || (payload && payload.error && payload.error.message);
  const error = String(
    (node && (node.fail_reason || node.failure_reason || node.message)) ||
    nestedError ||
    (payload && (payload.fail_reason || payload.failure_reason || payload.message)) ||
    (rawResult && !resultUrl ? rawResult : "") ||
    "",
  ).trim();
  return { taskId, status, resultUrl, error };
}

const AGTOKEN_FAILED_STATUSES = new Set(["FAILURE", "FAILED", "ERROR", "REJECTED", "CANCELED", "CANCELLED", "TIMEOUT"]);

// 源：protocols.ts:5647-5656
function throwIfAgTokenTaskFailed(view, fallback) {
  if (AGTOKEN_FAILED_STATUSES.has(view.status)) {
    throw new Error("AGToken 视频任务失败：" + (view.error || String(fallback || "").slice(0, 500)));
  }
  if (!view.resultUrl && view.error && /(拒绝|失败|错误|不支持|无效|违规|敏感|reject|fail|error|invalid|unsafe|policy)/i.test(view.error)) {
    throw new Error("AGToken 视频任务失败：" + view.error);
  }
}

// 源：protocols.ts:5658-5819
async function generateAgTokenVideos(provider, model, params, input, timeoutMs, transport, clock) {
  const net = resolveTransport(transport);
  const time = resolveClock(clock);
  const requestedModel = String(model || "").trim();
  const prompt = String(params.prompt || "").trim();
  if (!requestedModel) throw new Error("缺少 AGToken 视频模型");
  if (!requestedModel.endsWith("（国内）")) throw new Error("AGToken 公开模型名必须保留“国内”后缀。");
  if (!prompt) throw new Error("缺少视频提示词");

  const imageList = [...(params.images || []), ...(input ? [{ ...input, kind: "image" }] : [])];
  const videos = params.videos || [];
  const audios = params.audios || [];
  const imageUrls = imageList.map(agTokenReferenceUrl);
  const videoUrls = videos.map(agTokenReferenceUrl);
  const audioUrls = audios.map(agTokenReferenceUrl);
  // 源：protocols.ts:5677-5705（D2 移除项，见文件头）：不再对 api.dx-os.com 的 /v1/media/temp/
  // 发起 Range GET 探测。此判定恒为「不是 DX 临时 URL」，调用方沿用源 :5680 该分支的处理：原样使用 URL。
  const verifyDxTemporaryUrl = async (url) => {
    try { new URL(url); } catch { throw new Error("大雄图床返回了无效的参考素材地址"); }
    return false;
  };
  for (const url of [...imageUrls, ...videoUrls, ...audioUrls]) await verifyDxTemporaryUrl(url);
  const base = String(provider.base_url || "").replace(/\/+$/, "").replace(/\/v1$/i, "");
  const isWan = /^wan3\.0-video(?:-prime)?（国内）$/i.test(requestedModel);
  const isSeedance = /^doubao-seedance-2-[05]-/i.test(requestedModel);
  const durationValue = Number(params.duration);
  const duration = Number.isFinite(durationValue) ? Math.round(durationValue) : 5;
  const ratio = String(params.aspect_ratio || params.size || (isWan ? "adaptive" : "16:9"));
  const resolution = String(params.resolution || (isWan ? "1080p" : "720p"));
  const wanNeedsCompatibility = isWan && (imageUrls.length > 0 || videoUrls.length > 0 || audioUrls.length > 0);

  let submitPath;
  let queryPath;
  let body;
  const extraHeaders = {};
  if (wanNeedsCompatibility) {
    submitPath = "/api/v1/services/aigc/video-generation/video-synthesis";
    queryPath = (taskId) => "/api/v1/tasks/" + encodeURIComponent(taskId);
    extraHeaders["X-DashScope-Async"] = "enable";
    const media = [
      ...imageUrls.map((url, index) => ({ type: String((imageList[index] && imageList[index].role) || "reference_image"), url })),
      ...videoUrls.map((url, index) => ({ type: String((videos[index] && videos[index].role) || "reference_video"), url })),
      ...audioUrls.map((url, index) => ({ type: String((audios[index] && audios[index].role) || "reference_audio"), url })),
    ];
    body = {
      model: requestedModel,
      input: { prompt, ...(media.length ? { media } : {}) },
      parameters: {
        resolution: resolution.toUpperCase(), ratio, duration,
        audio: params.generate_audio !== false,
        ...(params.seed !== undefined ? { seed: params.seed } : {}),
        watermark: params.watermark === true,
      },
    };
  } else if (isSeedance) {
    submitPath = "/api/v3/contents/generations/tasks";
    queryPath = (taskId) => "/api/v3/contents/generations/tasks/" + encodeURIComponent(taskId);
    const content = [{ type: "text", text: prompt }];
    imageUrls.forEach((url, index) => content.push({ type: "image_url", image_url: { url }, role: String((imageList[index] && imageList[index].role) || "reference_image") }));
    videoUrls.forEach((url, index) => content.push({ type: "video_url", video_url: { url }, role: String((videos[index] && videos[index].role) || "reference_video") }));
    audioUrls.forEach((url, index) => content.push({ type: "audio_url", audio_url: { url }, role: String((audios[index] && audios[index].role) || "reference_audio") }));
    body = {
      model: requestedModel, content, resolution: resolution.toLowerCase(), ratio, duration,
      generate_audio: params.generate_audio !== false,
      watermark: params.watermark === true,
      ...(params.seed !== undefined ? { seed: params.seed } : {}),
      ...(params.return_last_frame ? { return_last_frame: true } : {}),
      ...(requestedModel.startsWith("doubao-seedance-2-5-") && (videoUrls.length || audioUrls.length) ? { omni_reference_task_type: "reference" } : {}),
    };
  } else {
    if (videoUrls.length || audioUrls.length) throw new Error("AG 统一接口只接受图片参考；视频或音频参考请使用 Seedance/Wan 模型。");
    submitPath = "/v1/video/generations";
    queryPath = (taskId) => "/v1/video/generations/" + encodeURIComponent(taskId);
    body = {
      model: requestedModel, prompt, duration,
      ...(imageUrls.length === 1 ? { image: imageUrls[0] } : imageUrls.length ? { images: imageUrls } : {}),
      size: ratio,
      metadata: { resolution: resolution.toLowerCase(), ratio, generate_audio: params.generate_audio !== false, watermark: params.watermark === true },
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const deadline = time.now() + timeoutMs;
  const headers = { Accept: "application/json", "Content-Type": "application/json", ...extraHeaders, ...buildAuthHeaders(PROTOCOLS["agtoken-video"], provider.api_key) };
  let lastPayload = null;
  try {
    const submit = await net.fetch(joinUrl(base, submitPath), { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    const submitText = await submit.text();
    try { lastPayload = JSON.parse(submitText); } catch { lastPayload = submitText; }
    if (!submit.ok) throw new Error("HTTP " + submit.status + ": " + submitText.slice(0, 500));
    let view = agTokenTaskView(lastPayload);
    throwIfAgTokenTaskFailed(view, submitText);
    if (view.resultUrl) return { videos: [{ type: "url", value: view.resultUrl }], raw: lastPayload };
    if (!view.taskId) throw new Error("AGToken 未返回任务 ID：" + submitText.slice(0, 500));
    const taskId = view.taskId;
    const basePollDelay = Math.min(5000, Math.max(25, Math.floor(timeoutMs / 4)));
    const maxPollDelay = Math.min(30000, Math.max(basePollDelay, Math.floor(timeoutMs / 2)));
    let pollDelay = basePollDelay;
    while (time.now() < deadline && !ctrl.signal.aborted) {
      await time.sleep(pollDelay);
      let query;
      try {
        query = await net.fetch(joinUrl(base, queryPath(taskId)), { headers: { Accept: "application/json", ...buildAuthHeaders(PROTOCOLS["agtoken-video"], provider.api_key) }, signal: ctrl.signal });
      } catch (error) {
        if (ctrl.signal.aborted) throw error;
        lastPayload = { taskId, transientQueryError: String((error && error.message) || error) };
        pollDelay = Math.min(maxPollDelay, Math.max(basePollDelay, pollDelay * 2));
        continue;
      }
      const queryText = await query.text();
      try { lastPayload = JSON.parse(queryText); } catch { lastPayload = queryText; }
      if (query.status === 429 || query.status >= 500) {
        const retryAfterSeconds = Number(query.headers.get("retry-after") || 0);
        pollDelay = retryAfterSeconds > 0
          ? Math.min(maxPollDelay, Math.max(basePollDelay, retryAfterSeconds * 1000))
          : Math.min(maxPollDelay, Math.max(basePollDelay, pollDelay * 2));
        continue;
      }
      if (!query.ok) throw new Error("AGToken 任务查询失败（HTTP " + query.status + "）：" + queryText.slice(0, 500));
      pollDelay = basePollDelay;
      view = agTokenTaskView(lastPayload);
      throwIfAgTokenTaskFailed(view, queryText);
      if (view.resultUrl) return { videos: [{ type: "url", value: view.resultUrl }], raw: lastPayload };
    }
    throw new Error("AGToken 本地等待已结束，远程任务 " + taskId + " 未被判定失败；请继续查询该任务，不要重复提交。");
  } catch (error) {
    if (ctrl.signal.aborted) throw new Error("AGToken 本地等待已结束；远程任务可能仍在排队，请勿重复提交。");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ── 视频：ZKKI ───────────────────────────────────────────────────────

// 源：protocols.ts:5821-5825
function zkkiReferenceUrl(input) {
  const url = String(input.publicUrl || "").trim();
  if (/^https:\/\//i.test(url)) return url;
  throw new Error("ZKKI 的" + (input.kind === "image" ? "图片" : input.kind === "video" ? "视频" : "音频") + "参考素材必须是公网可直接读取的 HTTPS 文件 URL。");
}

// 源：protocols.ts:5827-5913
async function generateZkkiVideos(provider, model, params, input, timeoutMs, transport, clock) {
  const net = resolveTransport(transport);
  const time = resolveClock(clock);
  const requestedModel = String(model || "").trim();
  const prompt = String(params.prompt || "").trim();
  if (!requestedModel) throw new Error("缺少 ZKKI 视频模型");
  if (!prompt) throw new Error("缺少视频提示词");
  const imageList = [...(params.images || []), ...(input ? [{ ...input, kind: "image" }] : [])];
  const videos = params.videos || [];
  const audios = params.audios || [];
  const isTextOnly = /global-standard-t2v$/i.test(requestedModel);
  if (isTextOnly && (imageList.length || videos.length || audios.length)) throw new Error(requestedModel + " 是纯文生视频模型，不支持参考素材。");
  const duration = Math.max(4, Math.min(30, Math.round(Number(params.duration) || 5)));
  const requestBody = (inlineImages = false) => {
    const media = [
      ...imageList.map((item) => ({ type: String(item.role || "reference_image"), url: inlineImages ? mediaDataUrl(item) : zkkiReferenceUrl(item) })),
      ...videos.map((item) => ({ type: String(item.role || "reference_video"), url: zkkiReferenceUrl(item) })),
      ...audios.map((item) => ({ type: String(item.role || "reference_audio"), url: zkkiReferenceUrl(item) })),
    ];
    return {
      model: requestedModel,
      input: { prompt, ...(media.length ? { media } : {}) },
      parameters: {
        duration,
        ratio: String(params.aspect_ratio || params.size || "16:9"),
        resolution: String(params.resolution || "720p"),
        generate_audio: params.generate_audio !== false,
        watermark: params.watermark === true,
      },
    };
  };
  const base = String(provider.base_url || "").replace(/\/+$/, "").replace(/\/v1$/i, "");
  const auth = buildAuthHeaders(PROTOCOLS["zkki-model"], provider.api_key);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const deadline = time.now() + timeoutMs;
  let lastPayload = null;
  try {
    const submitRequest = (inlineImages = false) => net.fetch(joinUrl(base, "/v1/videos"), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", ...auth },
      body: JSON.stringify(requestBody(inlineImages)),
      signal: ctrl.signal,
    });
    let submit = await submitRequest();
    let submitText = await submit.text();
    if (!submit.ok && imageList.length && /fail_to_fetch_task|resource not found|image_url[^\n]*not valid/i.test(submitText)) {
      submit = await submitRequest(true);
      submitText = await submit.text();
    }
    try { lastPayload = JSON.parse(submitText); } catch { lastPayload = submitText; }
    if (!submit.ok) throw new Error("HTTP " + submit.status + ": " + submitText.slice(0, 500));
    const taskId = String((lastPayload && (lastPayload.id || lastPayload.task_id)) || (lastPayload && lastPayload.data && (lastPayload.data.id || lastPayload.data.task_id)) || "").trim();
    if (!taskId) throw new Error("ZKKI 未返回任务 ID：" + submitText.slice(0, 500));
    while (time.now() < deadline && !ctrl.signal.aborted) {
      await time.sleep(Math.min(5000, Math.max(25, Math.floor(timeoutMs / 4))));
      const query = await net.fetch(joinUrl(base, "/v1/videos/" + encodeURIComponent(taskId)), { headers: { Accept: "application/json", ...auth }, signal: ctrl.signal });
      const queryText = await query.text();
      try { lastPayload = JSON.parse(queryText); } catch { lastPayload = queryText; }
      if (!query.ok) throw new Error("ZKKI 任务查询失败（HTTP " + query.status + "）：" + queryText.slice(0, 500));
      const node = lastPayload && lastPayload.data && typeof lastPayload.data === "object" ? lastPayload.data : lastPayload;
      const status = String((node && node.status) || (lastPayload && lastPayload.status) || "").trim().toLowerCase();
      if (status === "completed") {
        const content = await net.fetch(joinUrl(base, "/v1/videos/" + encodeURIComponent(taskId) + "/content"), { headers: { Accept: "video/*", ...auth }, signal: ctrl.signal });
        if (!content.ok) throw new Error("ZKKI 视频下载失败（HTTP " + content.status + "）：" + (await content.text()).slice(0, 500));
        const mime = String(content.headers.get("content-type") || "video/mp4").split(";")[0] || "video/mp4";
        const encoded = Buffer.from(await content.arrayBuffer()).toString("base64");
        return { videos: [{ type: "url", value: "data:" + mime + ";base64," + encoded }], raw: lastPayload };
      }
      if (["failed", "cancelled", "canceled", "expired"].includes(status)) {
        const message = String((node && node.error && node.error.message) || (node && node.error) || (node && node.message) || status);
        throw new Error("ZKKI 视频任务失败：" + message);
      }
    }
    throw new Error("ZKKI 本地等待已结束，远程任务 " + taskId + " 可能仍在处理中，请勿重复提交。");
  } catch (error) {
    if (ctrl.signal.aborted) throw new Error("ZKKI 本地等待已结束；远程任务可能仍在处理中，请勿重复提交。");
    if (/fetch failed/i.test(String((error && error.message) || error))) throw new Error("ZKKI 网络请求失败：" + String((error && error.cause) || (error && error.message) || error));
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ── 视频：MiniMax H3 ─────────────────────────────────────────────────

// 源：protocols.ts:5915-5919
function minimaxReferenceUrl(input) {
  const url = String(input.publicUrl || "").trim();
  if (/^https?:\/\//i.test(url)) return url;
  throw new Error("MiniMax H3 的参考素材必须使用公网 URL。请在生成节点的“素材传输”中选择大雄图床、临时图床或手动公网地址并上传。");
}

// 源：protocols.ts:5921-6021
async function generateMinimaxVideos(provider, model, params, input, timeoutMs = 600000, transport, clock) {
  const net = resolveTransport(transport);
  const time = resolveClock(clock);
  const prompt = String(params.prompt || "").trim();
  if (!prompt) throw new Error("缺少 MiniMax H3 视频提示词");
  const imageList = [...(params.images || []), ...(input ? [{ ...input, kind: "image" }] : [])].slice(0, 9);
  const videos = (params.videos || []).slice(0, 3);
  const audios = (params.audios || []).slice(0, 3);
  const content = [{ type: "text", text: prompt }];
  let hasFrame = false;
  let hasReference = false;
  for (const image of imageList) {
    const requestedRole = String(image.role || "").trim().toLowerCase();
    const role = requestedRole === "first_frame" || requestedRole === "last_frame" ? requestedRole : "reference_image";
    if (role === "first_frame" || role === "last_frame") hasFrame = true;
    else hasReference = true;
    content.push({ type: "image_url", image_url: { url: minimaxReferenceUrl(image) }, role });
  }
  for (const video of videos) {
    hasReference = true;
    content.push({ type: "video_url", video_url: { url: minimaxReferenceUrl(video) }, role: "reference_video" });
  }
  for (const audio of audios) {
    hasReference = true;
    content.push({ type: "audio_url", audio_url: { url: minimaxReferenceUrl(audio) }, role: "reference_audio" });
  }
  if (hasFrame && hasReference) throw new Error("MiniMax H3 的首尾帧模式与 reference_image/reference_video/reference_audio 多模态参考模式不能混用。");

  const requestedRatio = String(params.aspect_ratio || params.size || "16:9").trim().toLowerCase();
  const ratios = new Set(["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
  let ratio = ratios.has(requestedRatio) ? requestedRatio : "16:9";
  if (hasFrame) ratio = "adaptive";
  else if (content.length === 1 && ratio === "adaptive") ratio = "16:9";
  const resolutionText = String(params.resolution || "").trim().toUpperCase();
  const resolution = resolutionText.includes("2K") || resolutionText.includes("1080") ? "2K" : "768P";
  const body = {
    model: String(model || "").trim() || "MiniMax-H3",
    content,
    resolution,
    duration: Math.max(4, Math.min(15, Math.round(Number(params.duration) || 5))),
    ratio,
    aigc_watermark: params.watermark === true,
  };
  const headers = { Accept: "application/json", "Content-Type": "application/json", ...buildAuthHeaders(PROTOCOLS.minimax, provider.api_key) };
  const base = String(provider.base_url || "").replace(/\/+$/, "").replace(/\/(?:v1|v2)$/i, "");
  const submitUrl = base + "/v2/video_generation";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const submit = await net.fetch(submitUrl, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    const submitText = await submit.text();
    let payload;
    try { payload = JSON.parse(submitText); } catch { payload = submitText; }
    if (!submit.ok) throw new Error("MiniMax H3 创建任务失败（HTTP " + submit.status + "）：" + submitText.slice(0, 500));
    const submitBusiness = payload && payload.base_resp;
    if (submitBusiness && submitBusiness.status_code != null && Number(submitBusiness.status_code) !== 0) {
      throw new Error("MiniMax H3 业务错误：" + String(submitBusiness.status_msg || submitBusiness.status_code));
    }
    const immediateUrl = String((payload && payload.task && (payload.task.content && payload.task.content.url || payload.task.url)) || "").trim();
    if (immediateUrl) return { videos: [{ type: "url", value: immediateUrl }], raw: payload };
    const taskId = String((payload && (payload.task_id || (payload.task && payload.task.id))) || "").trim();
    if (!taskId) throw new Error("MiniMax H3 未返回任务 ID：" + submitText.slice(0, 500));
    const queryUrl = base + "/v2/query/video_generation/" + encodeURIComponent(taskId);
    const deadline = time.now() + timeoutMs;
    while (time.now() < deadline && !ctrl.signal.aborted) {
      await time.sleep(5000);
      const query = await net.fetch(queryUrl, { headers: { Accept: "application/json", ...buildAuthHeaders(PROTOCOLS.minimax, provider.api_key) }, signal: ctrl.signal });
      const queryText = await query.text();
      if (!query.ok) {
        if ([502, 503, 504].includes(query.status)) continue;
        throw new Error("MiniMax H3 查询任务失败（HTTP " + query.status + "）：" + queryText.slice(0, 500));
      }
      try { payload = JSON.parse(queryText); } catch { throw new Error("MiniMax H3 查询返回的不是有效 JSON：" + queryText.slice(0, 300)); }
      const task = payload && payload.task;
      if (!task || typeof task !== "object") throw new Error("MiniMax H3 查询响应缺少 task：" + queryText.slice(0, 500));
      const status = String(task.status || "").trim().toLowerCase();
      if (["queued", "running", "preparing", "processing", "submitted", "pending"].includes(status)) continue;
      if (["succeeded", "success", "completed", "done"].includes(status)) {
        const url = String((task.content && task.content.url) || task.url || task.file_id || "").trim();
        if (!url) throw new Error("MiniMax H3 生成成功，但没有返回视频地址。");
        return { videos: [{ type: "url", value: url }], raw: payload };
      }
      if (["failed", "fail", "error", "cancelled", "cancel", "canceled"].includes(status)) {
        const message = String((payload.base_resp && payload.base_resp.status_msg) || task.message || status);
        throw new Error("MiniMax H3 任务失败：" + message);
      }
    }
    throw new Error("MiniMax H3 视频生成超时；远程任务 " + taskId + " 可能仍在运行，请勿重复提交。");
  } catch (error) {
    if (ctrl.signal.aborted) throw new Error("MiniMax H3 视频生成超时，请稍后重试。");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ── 视频：统一入口 ───────────────────────────────────────────────────

// 源：protocols.ts:6023-6033（源用 withDirectApiQuota 包 unmetered；见文件头第 6 条）
async function generateVideos(provider, model, params, input, timeoutMs = 600000, transport, clock) {
  const net = resolveTransport(transport);
  const time = resolveClock(clock);
  return generateVideosUnmetered(provider, model, params, input, timeoutMs, net, time);
}

const DECLARED_VIDEO_RUNTIME_PROTOCOL_IDS = new Set(["v2-unified", "grok", "xai", "grok2api", "kling", "pixverse", "pika", "vidu", "wanxiang", "minimax", "volcengine"]);

// 源：protocols.ts:6035-6312
async function generateVideosUnmetered(provider, model, params, input, timeoutMs, net, time) {
  const rawProtocol = String(provider.protocol || "").trim().toLowerCase();
  if (rawProtocol === "agtoken" || rawProtocol === "agtoken-video") return generateAgTokenVideos(provider, model, params, input, timeoutMs, net, time);
  if (rawProtocol === "zkki" || rawProtocol === "zkki-model") return generateZkkiVideos(provider, model, params, input, timeoutMs, net, time);
  if (rawProtocol === "minimax") return generateMinimaxVideos(provider, model, params, input, timeoutMs, net, time);
  if (rawProtocol === "cli:jimeng" || rawProtocol === "jimeng-cli") {
    // B7e2 后续：CLI 端口已注入则调用，未注入仍结构化拒绝。
    const port = legacyExecutorPorts.getLegacyExecutorPort("cliJimeng");
    if (typeof port === "function") return port("video.generate", { provider, model, params, input, timeoutMs, transport: net, clock: time });
    return unavailable(CLI_PORT_DETAIL + "：generateJimengVideo（protocols.ts:6050）");
  }
  const declaredRuntime = DECLARED_VIDEO_RUNTIME_PROTOCOL_IDS.has(rawProtocol);
  // B7e2：端口已注入则调用注入实现；未注入仍返回结构化 LEGACY_DEPENDENCY_UNAVAILABLE（B2 行为不变）。
  if (rawProtocol === "agnes") {
    const port = legacyExecutorPorts.getLegacyExecutorPort("generateAgnesVideos");
    if (typeof port === "function") return port(provider, model, params, timeoutMs, net, time);
    return unavailable(BATCH.agnes + "：generateAgnesVideos（protocols.ts:6063）");
  }
  if (rawProtocol === "volcengine") return generateVolcengineVideos(provider, model, params, input, timeoutMs, net, time);
  if (rawProtocol === "runninghub") {
    const port = legacyExecutorPorts.getLegacyExecutorPort("generateRunningHubVideos");
    if (typeof port === "function") return port(provider, model, params, timeoutMs, net, time);
    return unavailable(BATCH.runninghub + "：generateRunningHubVideos（protocols.ts:6065）");
  }
  assertRunnableProtocol(provider.protocol, "视频生成");
  const proto = normalizeProtocol(provider.protocol);
  if (proto !== "openai" && proto !== "apimart" && proto !== "apimart-media" && !declaredRuntime) {
    throw new Error("视频测试目前支持 OpenAI 兼容和 APIMart 站点。");
  }
  const runtimeDef = PROTOCOLS[declaredRuntime ? rawProtocol : proto] || {};
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(runtimeDef.headers || {}),
    ...buildAuthHeaders(runtimeDef, provider.api_key),
  };
  const imageRefs = [...(params.images || []), ...(input ? [{ ...input, kind: "image" }] : [])];
  const videoRefs = params.videos || [];
  const audioRefs = params.audios || [];
  const duration = Math.max(1, Math.min(60, Number(params.duration) || 5));
  const aspect = String(params.aspect_ratio || params.size || "16:9").trim() || "16:9";
  const requestedModel = String(model || "").trim();
  if (!requestedModel) throw new Error("缺少视频模型");
  if (!String(params.prompt || "").trim()) throw new Error("缺少视频提示词");

  const declaredOperations = declaredRuntime && PROTOCOLS[rawProtocol] ? (PROTOCOLS[rawProtocol].operations || {}) : {};
  const declaredOperation = videoRefs.length && declaredOperations["video.edit"]
    ? declaredOperations["video.edit"]
    : imageRefs.length
      ? declaredOperations["video.image_to_video"] || declaredOperations["video.generate"]
      : declaredOperations["video.generate"];

  const buildCommonBody = () => ({
    model: requestedModel,
    prompt: String(params.prompt || "").trim(),
    duration,
    ...(params.size ? { size: params.size } : {}),
    ...(aspect ? { aspect_ratio: aspect } : {}),
    ...(params.resolution ? { resolution: params.resolution } : {}),
    ...(params.enhance_prompt ? { enhance_prompt: true } : {}),
    ...(params.enable_upsample ? { enable_upsample: true } : {}),
    ...(params.watermark ? { watermark: true } : {}),
    ...(params.seed !== undefined ? { seed: params.seed } : {}),
    ...(params.camerafixed ? { camerafixed: true } : {}),
    ...(params.return_last_frame ? { return_last_frame: true } : {}),
    ...(params.generate_audio ? { generate_audio: true } : {}),
    ...(params.multimodal ? { multimodal: true } : {}),
    ...(params.trusted_asset ? { trusted_asset: true } : {}),
  });

  let body;
  if (proto === "apimart" || proto === "apimart-media") {
    const lowerModel = requestedModel.toLowerCase();
    const isVeo31 = lowerModel.startsWith("veo3.1");
    const isSeedance25 = /seedance-?2[.-]5/i.test(lowerModel);
    const apimartModel = isVeo31
      ? (({ "veo3.1": "veo3.1-fast", "veo3.1-pro": "veo3.1-quality", "veo3.1-preview": "veo3.1-fast" })[lowerModel] || lowerModel)
      : requestedModel;
    if (isVeo31 && (videoRefs.length || audioRefs.length)) throw new Error("APIMart VEO 3.1 当前只支持文字和图片参考，不支持参考视频或参考音频。");
    if (isVeo31 && apimartModel === "veo3.1-lite" && imageRefs.length) throw new Error("APIMart veo3.1-lite 不支持图片输入，请改用 veo3.1-fast 或 veo3.1-quality。");

    const imageUrls = await Promise.all(imageRefs.slice(0, isVeo31 ? 3 : isSeedance25 ? 30 : 9).map((ref) => uploadApimartMedia(provider, ref, 120000, net)));
    const videoUrls = await Promise.all(videoRefs.slice(0, isSeedance25 ? 10 : 3).map((ref) => uploadApimartMedia(provider, ref, 180000, net)));
    const audioUrls = await Promise.all(audioRefs.slice(0, isSeedance25 ? 10 : 3).map((ref) => uploadApimartMedia(provider, ref, 180000, net)));

    if (isVeo31) {
      const veoDuration = Math.max(4, Math.min(8, duration));
      body = {
        prompt: String(params.prompt || "").trim(),
        model: apimartModel,
        duration: veoDuration,
        aspect_ratio: aspect === "9:16" ? "9:16" : "16:9",
        resolution: String(params.resolution || "").toLowerCase() === "4k"
          ? "4k"
          : String(params.resolution || "").toLowerCase().includes("1080")
            ? "1080p"
            : "720p",
        ...(params.generate_audio ? { generate_audio: true } : {}),
      };
      if (imageUrls.length && apimartModel !== "veo3.1-lite") {
        body.image_urls = imageUrls;
        if (imageUrls.length === 2) body.generation_type = "frame";
        else if (imageUrls.length >= 3 && apimartModel !== "veo3.1-quality") body.generation_type = "reference";
      }
    } else {
      body = {
        prompt: String(params.prompt || "").trim(),
        model: apimartModel || "doubao-seedance-2.0",
        duration: Math.max(4, Math.min(isSeedance25 ? 30 : 15, duration)),
        size: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"].includes(aspect) ? aspect : "16:9",
        resolution: params.resolution || "720p",
        generate_audio: params.generate_audio !== false,
        ...(params.seed !== undefined ? { seed: params.seed } : {}),
        ...(params.return_last_frame ? { return_last_frame: true } : {}),
        ...(params.nsfw_check ? { nsfw_check: true } : {}),
        ...(params.tools && params.tools.length ? { tools: params.tools } : {}),
      };
      const roleImages = imageRefs.some((ref) => String(ref.role || "").trim());
      if (roleImages) {
        body.image_with_roles = imageUrls.map((url, index) => ({ url, role: String((imageRefs[index] && imageRefs[index].role) || "reference_image").trim() || "reference_image" }));
      } else if (imageUrls.length) {
        body.image_urls = imageUrls;
      }
      if (videoUrls.length) body.video_urls = videoUrls;
      if (audioUrls.length) body.audio_urls = audioUrls;
      if (/^minimax-(?:h3|hailuo)/i.test(apimartModel)) {
        const h3 = /^minimax-h3/i.test(apimartModel);
        const max = /-max$/i.test(apimartModel);
        const hailuo02 = /-02$/i.test(apimartModel);
        const defaultDuration = h3 || hailuo02 ? 5 : 6;
        const requestedDuration = Number(params.duration == null ? defaultDuration : params.duration);
        const resolution = String(params.resolution || (h3 ? (max ? "768P" : "2K") : "768p"));
        const allowedResolutions = h3 ? (max ? ["480p", "768p", "1080p"] : ["2k", "768p"]) : hailuo02 ? ["512p", "768p", "1080p"] : ["768p", "1080p"];
        if (!allowedResolutions.includes(resolution.toLowerCase())) throw new Error(apimartModel + " 不支持分辨率 " + resolution);
        if (!Number.isInteger(requestedDuration) || (h3 ? (requestedDuration < (max ? 5 : 4) || requestedDuration > 15) : ![defaultDuration, 10].includes(requestedDuration))) throw new Error(apimartModel + " 不支持时长 " + requestedDuration);
        if (!h3 && resolution.toLowerCase() === "1080p" && requestedDuration !== defaultDuration) throw new Error(apimartModel + " 在 1080p 下仅支持 " + defaultDuration + " 秒");
        if (!h3 && (videoUrls.length || audioUrls.length || imageUrls.length > (hailuo02 ? 2 : 1))) throw new Error(apimartModel + " 不支持当前参考素材组合");
        if (/-fast$/i.test(apimartModel) && !imageUrls.length) throw new Error(apimartModel + " 需要首帧图片");
        body = {
          model: apimartModel, prompt: String(params.prompt || "").trim(), duration: requestedDuration, resolution: h3 ? resolution.toUpperCase() : resolution.toLowerCase(),
          ...(h3 ? {
            aspect_ratio: aspect,
            ...(body.image_urls ? { image_urls: body.image_urls } : {}),
            ...(body.image_with_roles ? { image_with_roles: body.image_with_roles } : {}),
            ...(videoUrls.length ? { video_urls: videoUrls } : {}),
            ...(audioUrls.length ? { audio_urls: audioUrls } : {}),
          } : {
            ...(imageUrls[0] ? { first_frame_image: imageUrls[0] } : {}),
            ...(hailuo02 && imageUrls[1] ? { last_frame_image: imageUrls[1] } : {}),
            prompt_optimizer: params.prompt_optimizer !== false,
          }),
          ...(!(max && resolution.toLowerCase() === "1080p") ? { watermark: params.watermark === true } : {}),
        };
      }
    }
  } else {
    body = buildCommonBody();
    if (imageRefs.length) {
      const imageValues = imageRefs.slice(0, 9).map((ref) => String(ref.publicUrl || mediaDataUrl(ref)));
      const template = (declaredOperation && declaredOperation.bodyTemplate) || {};
      if ((!declaredRuntime || "image" in template) && (!("reference_images" in template) || imageValues.length === 1)) {
        body.image = rawProtocol === "grok2api" || rawProtocol === "xai" ? { url: imageValues[0] } : imageValues[0];
      }
      if ("reference_images" in template && imageValues.length > 1) body.reference_images = imageValues.map((url) => ({ url }));
      if (!declaredRuntime || "images" in template) body.images = imageValues;
      const roles = imageRefs.slice(0, 9).map((ref) => String(ref.role || "").trim());
      if (roles.some(Boolean)) body.image_roles = roles;
    }
    if (videoRefs.length) {
      const videoValues = videoRefs.slice(0, 3).map((ref) => String(ref.publicUrl || mediaDataUrl(ref)));
      const template = (declaredOperation && declaredOperation.bodyTemplate) || {};
      if ("video" in template) body.video = rawProtocol === "grok2api" || rawProtocol === "xai" ? { url: videoValues[0] } : videoValues[0];
      if (!declaredRuntime || "videos" in template) body.videos = videoValues;
    }
    if (audioRefs.length) {
      const audioValues = audioRefs.slice(0, 3).map((ref) => String(ref.publicUrl || mediaDataUrl(ref)));
      const template = (declaredOperation && declaredOperation.bodyTemplate) || {};
      if ("reference_audios" in template) body.reference_audios = audioValues.map((url) => ({ url }));
      if (!declaredRuntime || "audios" in template) body.audios = audioValues;
    }
    if (declaredRuntime) {
      const allowed = new Set(Object.keys((declaredOperation && declaredOperation.bodyTemplate) || {}));
      for (const key of Object.keys(body)) if (!allowed.has(key)) delete body[key];
    }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const declaredPath = String((declaredOperation && declaredOperation.path) || "").trim();
    const submitUrls = proto === "apimart" || proto === "apimart-media"
      ? [joinUrl(provider.base_url, "/v1/videos/generations")]
      : declaredPath
        ? [joinUrl(provider.base_url, declaredPath)]
        : [joinUrl(provider.base_url, "/v1/videos/generations"), joinUrl(provider.base_url, "/v2/videos/generations")];
    let payload = null;
    let submitUrl = submitUrls[0];
    let lastError = "";
    for (let i = 0; i < submitUrls.length; i++) {
      submitUrl = submitUrls[i];
      const resp = await net.fetch(submitUrl, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
      const text = await resp.text();
      let candidate;
      try { candidate = JSON.parse(text); } catch { candidate = text; }
      if (!resp.ok) {
        lastError = "HTTP " + resp.status + ": " + text.slice(0, 500);
        if (i < submitUrls.length - 1 && [404, 405].includes(resp.status)) continue;
        throw new Error(lastError);
      }
      payload = candidate;
      break;
    }
    if (payload == null) throw new Error(lastError || "视频提交失败");
    let urls = collectVideoUrls(payload).filter((url, index, list) => list.indexOf(url) === index);
    const taskId = extractVideoTaskId(payload);
    if (!urls.length && !taskId) throw new Error("视频提交响应未包含任务 ID 或视频地址：" + JSON.stringify(payload).slice(0, 500));
    if (!urls.length && taskId) {
      const base = String(provider.base_url || "").replace(/\/+$/, "").replace(/\/v1$|\/v2$/i, "");
      const taskUrls = proto === "grok2api" || proto === "xai"
        ? [base + "/v1/videos/" + encodeURIComponent(taskId)]
        : proto === "apimart" || proto === "apimart-media"
          ? [base + "/v1/tasks/" + encodeURIComponent(taskId) + "?language=zh", base + "/tasks/" + encodeURIComponent(taskId) + "?language=zh"]
          : [
              base + (submitUrl.includes("/v2/") ? "/v2" : "/v1") + "/videos/generations/" + encodeURIComponent(taskId),
              base + "/v2/tasks/" + encodeURIComponent(taskId),
              base + "/v1/videos/generations/" + encodeURIComponent(taskId),
              base + "/v1/tasks/" + encodeURIComponent(taskId),
              base + "/tasks/" + encodeURIComponent(taskId),
            ];
      const deadline = time.now() + timeoutMs;
      while (time.now() < deadline) {
        await time.sleep(2000);
        let taskPayload = null;
        let queryError = "";
        for (const taskUrl of taskUrls) {
          try {
            const taskResp = await net.fetch(taskUrl, { headers: { Accept: "application/json", ...buildAuthHeaders(runtimeDef, provider.api_key) }, signal: ctrl.signal });
            const taskText = await taskResp.text();
            if (!taskResp.ok) { queryError = "HTTP " + taskResp.status + ": " + taskText.slice(0, 300); continue; }
            taskPayload = JSON.parse(taskText);
            break;
          } catch (error) { queryError = String((error && error.message) || error); }
        }
        if (!taskPayload) throw new Error("视频任务查询失败：" + (queryError || taskId));
        urls = collectVideoUrls(taskPayload).filter((url, index, list) => list.indexOf(url) === index);
        if (urls.length) break;
        const status = videoStatus(taskPayload);
        if (["FAILED", "FAILURE", "ERROR", "CANCELED", "CANCELLED", "TIMEOUT", "REJECTED"].includes(status)) {
          throw new Error("视频任务失败：" + JSON.stringify(taskPayload).slice(0, 500));
        }
      }
    }
    if (!urls.length) throw new Error("视频接口调用成功，但没有返回视频地址");
    return { videos: urls.map((value) => ({ type: "url", value })), raw: payload };
  } catch (error) {
    if (ctrl.signal.aborted) throw new Error("视频生成超时，请重试或换更快的模型。");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ── 音频 ─────────────────────────────────────────────────────────────

const DECLARED_AUDIO_RUNTIME_PROTOCOL_IDS = new Set(["v2-unified", "grok2api", "suno", "minimax", "volcengine-speech"]);

// 源：protocols.ts:6314-6322
function audioRuntimeDefinition(protocol, intent) {
  const raw = String(protocol || "").trim().toLowerCase();
  const normalized = normalizeProtocol(raw);
  const protocolId = DECLARED_AUDIO_RUNTIME_PROTOCOL_IDS.has(raw) || raw === "apimart-media" ? raw : normalized;
  const def = PROTOCOLS[protocolId];
  const operation = def && def.operations ? def.operations[intent] : undefined;
  if (!def || !operation || !operation.path) throw new Error("音频协议「" + (raw || protocolId) + "」不支持 " + intent);
  return { def, operation, protocolId };
}

// 源：protocols.ts:6324-6387
async function generateSpeech(provider, model, params, timeoutMs = 300000, transport) {
  const net = resolveTransport(transport);
  const input = String(params.input || "").trim();
  if (!input) throw new Error("缺少要合成的文本");
  let officialApimart = false;
  try {
    const host = new URL(provider.base_url).hostname.toLowerCase();
    officialApimart = normalizeProtocol(provider.protocol) === "apimart" || host === "api.apimart.ai" || host.endsWith(".apimart.ai") || host === "apib.ai" || host.endsWith(".apib.ai");
  } catch { /* fetch 会给出具体的地址错误 */ }
  if (officialApimart && String(model).trim().toLowerCase() !== "gpt-4o-mini-tts") throw new Error("APIMart 官方 TTS 当前仅支持 gpt-4o-mini-tts；" + model + " 不是可用于语音合成的模型");
  if (officialApimart && input.length > 4096) throw new Error("APIMart TTS 文本不能超过 4096 个字符");
  const responseFormat = String(params.response_format || (officialApimart ? "wav" : "mp3")).toLowerCase();
  const voice = String(params.voice || "alloy").toLowerCase();
  if (officialApimart && !["wav", "opus", "aac", "flac", "pcm"].includes(responseFormat)) throw new Error("APIMart TTS 不支持输出格式 " + responseFormat);
  if (officialApimart && !["alloy", "echo", "fable", "onyx", "nova", "shimmer"].includes(voice)) throw new Error("APIMart TTS 不支持音色 " + voice);
  const { def, operation } = audioRuntimeDefinition(provider.protocol, "audio.tts");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    if (String(provider.protocol || "").trim().toLowerCase() === "volcengine-speech") {
      const requestId = randomUUID();
      const speechRate = Math.max(-50, Math.min(100, Math.round(((Number(params.speed) || 1) - 1) * 100)));
      const resp = await net.fetch(joinUrl(provider.base_url, String(operation.path)), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": provider.api_key,
          "X-Api-Resource-Id": model,
          "X-Api-Request-Id": requestId,
          "X-Control-Require-Usage-Tokens-Return": "*",
        },
        body: JSON.stringify({ req_params: { text: input, speaker: params.voice || "zh_female_vv_uranus_bigtts", audio_params: { format: responseFormat, sample_rate: 24000, speech_rate: speechRate, loudness_rate: 0, pitch_rate: 0 } } }),
        signal: ctrl.signal,
      });
      const text = await resp.text();
      if (!resp.ok) throw new Error("豆包语音合成失败（HTTP " + resp.status + "）：" + text.slice(0, 500));
      const chunks = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line.replace(/^data:\s*/, "")));
      const failed = chunks.find((chunk) => Number(chunk && chunk.code) !== 0);
      if (failed) throw new Error("豆包语音合成失败：" + String(failed.message || failed.code));
      const data = Buffer.concat(chunks.map((chunk) => Buffer.from(String((chunk && chunk.data) || ""), "base64")).filter((chunk) => chunk.length));
      if (!data.length) throw new Error("豆包语音合成成功，但没有返回音频数据");
      const mime = ({ wav: "audio/wav", pcm: "audio/L16", ogg_opus: "audio/ogg", mp3: "audio/mpeg" })[responseFormat] || "application/octet-stream";
      return { data, mime, raw: chunks };
    }
    const resp = await net.fetch(joinUrl(provider.base_url, String(operation.path)), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(def.headers || {}), ...buildAuthHeaders(def, provider.api_key) },
      body: JSON.stringify({
        model,
        input,
        voice,
        response_format: responseFormat,
        speed: Math.max(0.25, Math.min(4, Number(params.speed) || 1)),
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error("语音合成失败（HTTP " + resp.status + "）：" + (await resp.text()).slice(0, 500));
    const fallbackMime = ({ wav: "audio/wav", opus: "audio/ogg", aac: "audio/aac", flac: "audio/flac", pcm: "audio/L16", mp3: "audio/mpeg" })[responseFormat] || "application/octet-stream";
    return { data: Buffer.from(await resp.arrayBuffer()), mime: (resp.headers.get("content-type") || fallbackMime).split(";")[0] };
  } catch (error) {
    if (ctrl.signal.aborted) throw new Error("语音合成超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// 源：protocols.ts:6389-6427
async function transcribeAudio(provider, model, input, params = {}, timeoutMs = 300000, transport) {
  const net = resolveTransport(transport);
  const intent = params.translate ? "audio.translate" : "audio.transcribe";
  const { def, operation } = audioRuntimeDefinition(provider.protocol, intent);
  const form = new FormData();
  form.append("model", model);
  form.append("file", new Blob([new Uint8Array(input.buf)], { type: input.mime || "audio/mpeg" }), input.name || "audio.mp3");
  if (!params.translate && params.language) form.append("language", params.language);
  if (params.prompt) form.append("prompt", params.prompt);
  form.append("response_format", params.response_format || "json");
  if (params.temperature !== undefined) form.append("temperature", String(params.temperature));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await net.fetch(joinUrl(provider.base_url, String(operation.path)), {
      method: "POST",
      headers: { Accept: "application/json", ...(def.headers || {}), ...buildAuthHeaders(def, provider.api_key) },
      body: form,
      signal: ctrl.signal,
    });
    const rawText = await resp.text();
    let raw;
    try { raw = JSON.parse(rawText); } catch { raw = rawText; }
    if (!resp.ok) throw new Error("音频" + (params.translate ? "翻译" : "转写") + "失败（HTTP " + resp.status + "）：" + rawText.slice(0, 500));
    const text = typeof raw === "string" ? raw : String((raw && raw.text) || (raw && raw.data && raw.data.text) || "").trim();
    if (!text) throw new Error("音频接口成功，但没有返回文本");
    return { text, raw };
  } catch (error) {
    if (ctrl.signal.aborted) throw new Error("音频处理超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// 源：protocols.ts:6429-6439
function collectAudioUrls(value, out = [], depth = 0, keyHint = "") {
  if (depth > 6 || value == null) return out;
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value) && (/audio|music|url|output|result|content|download/i.test(keyHint) || /\.(mp3|wav|m4a|aac|flac|ogg)(\?|#|$)/i.test(value))) out.push(value);
    return out;
  }
  if (Array.isArray(value)) { value.forEach((item) => collectAudioUrls(item, out, depth + 1, keyHint)); return out; }
  if (typeof value !== "object") return out;
  for (const [key, item] of Object.entries(value)) collectAudioUrls(item, out, depth + 1, /audio|music|url|output|result|content|download/i.test(key) ? key : keyHint);
  return out;
}

// 源：protocols.ts:6441-6496
async function generateMusic(provider, model, params, timeoutMs = 900000, transport, clock) {
  const net = resolveTransport(transport);
  const time = resolveClock(clock);
  const prompt = String(params.prompt || "").trim();
  if (!prompt) throw new Error("缺少音乐生成提示词");
  const { def, operation, protocolId } = audioRuntimeDefinition(provider.protocol, "audio.music");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await net.fetch(joinUrl(provider.base_url, String(operation.path)), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", ...(def.headers || {}), ...buildAuthHeaders(def, provider.api_key) },
      body: JSON.stringify(protocolId === "volcengine-speech"
        ? { model: "seed-audio-1.0", text_prompt: prompt, audio_config: { format: "mp3", sample_rate: 48000 } }
        : (() => {
            // Suno 族必填：version（v6 / v6-wild / v6-mini）与 custom_model_id 二选一、至少一个，否则 400。
            // 与 provider-adapter-apimart.cjs#generateAudio 同口径；非 Suno 模型不加这个字段。
            const body = { model, prompt, title: params.title || "", lyrics: params.lyrics || "", style: params.style || "", instrumental: params.instrumental === true };
            if (/^suno/i.test(String(model || ""))) {
              const customModelId = String(params.custom_model_id || "").trim();
              const custom = params.custom === true;
              body.custom = custom;
              body.prompt = prompt.slice(0, custom ? 5000 : 3000);
              if (customModelId) body.custom_model_id = customModelId;
              else body.version = String(params.version || "v6");
            }
            return body;
          })()),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = text; }
    if (!resp.ok) throw new Error("音乐生成失败（HTTP " + resp.status + "）：" + text.slice(0, 500));
    let urls = collectAudioUrls(payload).filter((url, index, list) => list.indexOf(url) === index);
    const taskId = extractVideoTaskId(payload);
    if (!urls.length && taskId) {
      const base = String(provider.base_url || "").replace(/\/+$/, "").replace(/\/v1$|\/v2$/i, "");
      const taskUrls = protocolId === "apimart-media"
        ? [base + "/v1/tasks/" + encodeURIComponent(taskId) + "?language=zh", base + "/tasks/" + encodeURIComponent(taskId) + "?language=zh"]
        : [base + "/v2/music/generations/" + encodeURIComponent(taskId), base + "/v2/tasks/" + encodeURIComponent(taskId), base + "/v1/tasks/" + encodeURIComponent(taskId), base + "/tasks/" + encodeURIComponent(taskId)];
      const deadline = time.now() + timeoutMs;
      while (time.now() < deadline) {
        await time.sleep(2000);
        let taskPayload = null;
        for (const url of taskUrls) {
          const taskResp = await net.fetch(url, { headers: { Accept: "application/json", ...buildAuthHeaders(def, provider.api_key) }, signal: ctrl.signal });
          if (!taskResp.ok) continue;
          taskPayload = await taskResp.json();
          break;
        }
        if (!taskPayload) throw new Error("音乐任务查询失败：" + taskId);
        urls = collectAudioUrls(taskPayload).filter((url, index, list) => list.indexOf(url) === index);
        if (urls.length) break;
        if (["FAILED", "FAILURE", "ERROR", "CANCELED", "CANCELLED", "TIMEOUT", "REJECTED"].includes(videoStatus(taskPayload))) throw new Error("音乐任务失败：" + JSON.stringify(taskPayload).slice(0, 500));
      }
    }
    if (!urls.length) throw new Error("音乐接口成功，但没有返回音频地址");
    return { audios: urls.map((value) => ({ type: "url", value })), raw: payload };
  } catch (error) {
    if (ctrl.signal.aborted) throw new Error("音乐生成超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ── Midjourney（源：protocols.ts:4639-4968）─────────────────────────

const MIDJOURNEY_API_ROOT = "https://api.apimart.ai";
const MIDJOURNEY_SPEEDS = ["relax", "fast", "turbo"];
const MIDJOURNEY_SUCCESS_STATUSES = new Set(["SUCCEEDED", "SUCCESS", "COMPLETED", "DONE", "FINISHED"]);
const MIDJOURNEY_FAILED_STATUSES = new Set(["FAILED", "FAILURE", "ERROR", "CANCELED", "CANCELLED", "TIMEOUT", "REJECTED"]);
const MIDJOURNEY_ACTION_PATHS = {
  upscale: "/v1/midjourney/generations/upscale",
  variation: "/v1/midjourney/generations/variation",
  low_variation: "/v1/midjourney/generations/low-variation",
  high_variation: "/v1/midjourney/generations/high-variation",
  reroll: "/v1/midjourney/generations/reroll",
  zoom: "/v1/midjourney/generations/zoom",
  pan: "/v1/midjourney/generations/pan",
  inpaint: "/v1/midjourney/generations/inpaint",
  remix_subtle: "/v1/midjourney/generations/remix-subtle",
  remix_strong: "/v1/midjourney/generations/remix-strong",
};

function midjourneyOptions(options) {
  return {
    root: String((options && options.apiRoot) || MIDJOURNEY_API_ROOT).replace(/\/+$/, ""),
    transport: resolveTransport(options && options.transport),
    clock: resolveClock(options && options.clock),
  };
}

// 源：protocols.ts:4656-4659
function isMidjourneyProvider(provider) {
  const protocol = String(provider.protocol || "").trim().toLowerCase();
  return protocol === "midjourney" || normalizeProtocol(protocol) === "apimart";
}

// 源：protocols.ts:4661-4667
function midjourneyResponseData(raw) {
  if (!raw || typeof raw !== "object") return {};
  const data = raw.data;
  if (Array.isArray(data)) return data.find((item) => item && typeof item === "object") || raw;
  if (data && typeof data === "object") return data;
  return raw;
}

// 源：protocols.ts:4669-4680
function midjourneyTaskId(raw) {
  const data = midjourneyResponseData(raw);
  const candidates = [data, data && data.data, data && data.task, raw && raw.result, raw && raw.task, raw];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    for (const key of ["task_id", "taskId", "submit_id", "submitId", "id"]) {
      const value = String(candidate[key] || "").trim();
      if (value) return value;
    }
  }
  return "";
}

// 源：protocols.ts:4682-4685
function midjourneyTaskStatus(raw) {
  const data = midjourneyResponseData(raw);
  return String((data && (data.status || data.task_status || data.taskStatus)) || (raw && raw.status) || "").trim().toUpperCase();
}

// 源：protocols.ts:4687-4697
function midjourneyErrorDetail(raw, fallback = "Midjourney 请求失败") {
  const data = midjourneyResponseData(raw);
  const error = data && data.error && typeof data.error === "object" ? data.error : {};
  return String(
    error.message ||
    (data && data.message) ||
    (data && data.fail_reason) ||
    (raw && raw.message) ||
    fallback,
  );
}

// 源：protocols.ts:4699-4717
function midjourneyRemoteImages(raw) {
  const data = midjourneyResponseData(raw);
  const values = Array.isArray(data && data.image_urls) ? data.image_urls
    : Array.isArray(data && data.imageUrls) ? data.imageUrls
      : [];
  const urls = values.map((value) => String(value || "").trim()).filter(Boolean);
  if (urls.length) return [...new Set(urls)];
  const resultImages = Array.isArray(data && data.result && data.result.images) ? data.result.images : [];
  for (const item of resultImages) {
    const value = String((item && item.url) || item || "").trim();
    if (value) urls.push(value);
  }
  if (urls.length) return [...new Set(urls)];
  for (const key of ["image_url", "imageUrl", "grid_image_url", "gridImageUrl"]) {
    const value = String((data && data[key]) || "").trim();
    if (value) urls.push(value);
  }
  return [...new Set(urls)];
}

// 源：protocols.ts:4719-4732
function midjourneyAspectRatio(size = "") {
  const raw = String(size || "").trim().toLowerCase().replace("*", "x");
  if (/^\d{1,2}:\d{1,2}$/.test(raw)) return raw;
  const match = raw.match(/^(\d{2,5})x(\d{2,5})$/);
  if (!match) return "1:1";
  let width = Number(match[1]);
  let height = Number(match[2]);
  if (!width || !height) return "1:1";
  const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
  const d = gcd(width, height) || 1;
  width = Math.round(width / d);
  height = Math.round(height / d);
  return width + ":" + height;
}

// 源：protocols.ts:4734-4741
// 名字里没有版本号（如 APIMart 的 "midjourney"）就返回 ""、不传 version，交给上游默认（以前写死 6.1）。
function midjourneyVersion(model) {
  const raw = String(model || "").trim();
  const match = raw.match(/(\d+(?:\.\d+)?)/);
  return match ? match[1] : "";
}
// relax 排队实测常常十几分钟，默认 fast；调用方明确给了 relax / turbo 就照用
function midjourneySpeed(value) {
  const v = String(value || "").trim().toLowerCase();
  return MIDJOURNEY_SPEEDS.includes(v) ? v : "fast";
}

// 源：protocols.ts:4743-4756
async function midjourneyReferenceUrls(referenceImages = []) {
  const urls = [];
  for (const ref of referenceImages.slice(0, 4)) {
    const direct = String((ref && ref.url) || "").trim();
    if (direct.startsWith("http://") || direct.startsWith("https://") || direct.startsWith("data:image/")) { urls.push(direct); continue; }
    if (ref && ref.buf && ref.mime) urls.push("data:" + ref.mime + ";base64," + ref.buf.toString("base64"));
  }
  return [...new Set(urls)];
}

// 源：protocols.ts:4758-4791
async function callMidjourneyJson(provider, path, body, timeoutMs, options) {
  const opt = midjourneyOptions(options);
  if (!isMidjourneyProvider(provider)) throw new Error("Midjourney 目前仅支持 APIMart 协议站点。");
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...buildAuthHeaders(PROTOCOLS.apimart, provider.api_key),
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await opt.transport.fetch(opt.root + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let raw;
    try { raw = JSON.parse(text); } catch { raw = { message: text.slice(0, 500) }; }
    if (!resp.ok) throw new Error(midjourneyErrorDetail(raw, "Midjourney 接口错误（" + resp.status + "）"));
    return raw;
  } finally {
    clearTimeout(timer);
  }
}

// 源：protocols.ts:4793-4821
async function midjourneyTask(provider, taskId, timeoutMs, options) {
  const opt = midjourneyOptions(options);
  if (!isMidjourneyProvider(provider)) throw new Error("Midjourney 目前仅支持 APIMart 协议站点。");
  const safeTaskId = String(taskId || "").trim();
  if (!safeTaskId) throw new Error("Midjourney 任务 ID 不合法。");
  const headers = { Accept: "application/json", ...buildAuthHeaders(PROTOCOLS.apimart, provider.api_key) };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await opt.transport.fetch(opt.root + "/v1/midjourney/" + encodeURIComponent(safeTaskId), {
      method: "GET",
      headers,
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let raw;
    try { raw = JSON.parse(text); } catch { raw = { message: text.slice(0, 500) }; }
    if (!resp.ok) throw new Error(midjourneyErrorDetail(raw, "查询 Midjourney 任务失败（" + resp.status + "）"));
    return raw;
  } finally {
    clearTimeout(timer);
  }
}

// 源：protocols.ts:4823-4856
async function submitMidjourney(provider, model, params, timeoutMs = 300000, options) {
  const prompt = String(params.prompt || "").trim();
  const mode = String(params.mode || "imagine").trim().toLowerCase();
  if (mode !== "blend" && !prompt) throw new Error("缺少 Midjourney 提示词");
  const speed = midjourneySpeed(params.speed);
  const version = midjourneyVersion(params.version || model);
  const body = { size: midjourneyAspectRatio(params.size), speed, metadata: { source: "ccs-os" } };
  if (prompt) body.prompt = prompt;
  if (mode !== "blend" && version) body.version = version;
  // niji-6 / niji 7：要带 niji:true，否则上游当成 MJ 主线 v6 出图
  if (mode !== "blend" && /niji/i.test(String(model || "") + " " + String(params.version || ""))) body.niji = true;
  const refs = await midjourneyReferenceUrls(params.reference_images || []);
  if (refs.length) body.image_urls = refs;
  if (mode === "blend" && (refs.length < 2 || refs.length > 4)) throw new Error("Midjourney 多图融合需要 2 到 4 张图片。");
  if (mode === "edit" && !refs.length) throw new Error("Midjourney 图片编辑需要至少一张参考图。");
  const path = mode === "blend"
    ? "/v1/midjourney/generations/blend"
    : mode === "edit"
      ? "/v1/midjourney/generations/edits"
      : "/v1/midjourney/generations";
  const raw = await callMidjourneyJson(provider, path, body, timeoutMs, options);
  const taskId = midjourneyTaskId(raw);
  if (!taskId) throw new Error("Midjourney 未返回任务 ID：" + JSON.stringify(raw).slice(0, 500));
  return { taskId, status: midjourneyTaskStatus(raw) || "queued", raw };
}

// 源：protocols.ts:4858-4873
async function getMidjourneyTask(provider, taskId, timeoutMs = 300000, options) {
  const raw = await midjourneyTask(provider, taskId, timeoutMs, options);
  const status = midjourneyTaskStatus(raw);
  if (MIDJOURNEY_FAILED_STATUSES.has(status)) {
    return { status: "failed", taskId, images: [], raw, error: midjourneyErrorDetail(raw) };
  }
  const urls = midjourneyRemoteImages(raw);
  if (MIDJOURNEY_SUCCESS_STATUSES.has(status) || urls.length) {
    return { status: "succeeded", taskId, images: urls.map((value) => ({ type: "url", value })), raw };
  }
  return { status: "running", taskId, images: [], raw, message: "Midjourney 任务仍在生成中" };
}

// 源：protocols.ts:4875-4915
async function submitMidjourneyAction(provider, params, timeoutMs = 300000, options) {
  const action = String(params.action || "").trim().toLowerCase();
  if (!MIDJOURNEY_ACTION_PATHS[action]) throw new Error("不支持的 Midjourney 操作。");
  const taskId = String(params.task_id || "").trim();
  if (!/^[A-Za-z0-9_.:-]{1,240}$/.test(taskId)) throw new Error("Midjourney 任务 ID 不合法。");
  const speed = midjourneySpeed(params.speed);
  const body = { task_id: taskId, speed, metadata: { source: "ccs-os" } };
  const customId = String(params.custom_id || "").trim();
  if (customId) body.custom_id = customId;
  if (["upscale", "variation", "low_variation", "high_variation", "remix_subtle", "remix_strong"].includes(action) && !customId) {
    const index = Number(params.index || 0);
    if (![1, 2, 3, 4].includes(index)) throw new Error("Midjourney 图片序号应为 1 到 4。");
    body.index = index;
  } else if (["zoom", "pan"].includes(action) && [1, 2, 3, 4].includes(Number(params.index || 0))) {
    body.index = Number(params.index);
  }
  if (action === "zoom" && params.zoom_ratio !== undefined) {
    const zoomRatio = Number(params.zoom_ratio);
    if (zoomRatio <= 1 || zoomRatio > 4) throw new Error("Midjourney 缩放比例应大于 1 且不超过 4。");
    body.zoom_ratio = zoomRatio;
  }
  if (action === "pan" && !customId) {
    const direction = String(params.direction || "").trim().toLowerCase();
    if (!["left", "right", "up", "down"].includes(direction)) throw new Error("Midjourney 平移方向仅支持 left、right、up 或 down。");
    body.direction = direction;
  }
  if (["remix_subtle", "remix_strong"].includes(action)) {
    const prompt = String(params.prompt || "").trim();
    if (prompt) body.prompt = prompt;
  }
  const raw = await callMidjourneyJson(provider, MIDJOURNEY_ACTION_PATHS[action], body, timeoutMs, options);
  const newTaskId = midjourneyTaskId(raw);
  if (!newTaskId) throw new Error("Midjourney 未返回任务 ID：" + JSON.stringify(raw).slice(0, 500));
  return { taskId: newTaskId, status: midjourneyTaskStatus(raw) || "queued", action, raw };
}

// 源：protocols.ts:4917-4939
async function submitMidjourneyModal(provider, params, timeoutMs = 300000, options) {
  const taskId = String(params.task_id || "").trim();
  if (!/^[A-Za-z0-9_.:-]{1,240}$/.test(taskId)) throw new Error("Midjourney 任务 ID 不合法。");
  const speed = midjourneySpeed(params.speed);
  const refs = await midjourneyReferenceUrls(params.mask_image ? [params.mask_image] : []);
  const maskUrl = refs[0];
  if (!maskUrl) throw new Error("Midjourney 局部重绘需要一个遮罩图片。");
  const raw = await callMidjourneyJson(provider, "/v1/midjourney/generations/modal", {
    task_id: taskId,
    prompt: String(params.prompt || "").trim(),
    mask_url: maskUrl,
    speed,
    metadata: { source: "ccs-os" },
  }, timeoutMs, options);
  const newTaskId = midjourneyTaskId(raw);
  if (!newTaskId) throw new Error("Midjourney 未返回任务 ID：" + JSON.stringify(raw).slice(0, 500));
  return { taskId: newTaskId, status: midjourneyTaskStatus(raw) || "submitted", raw };
}

// 源：protocols.ts:4941-4968
async function generateMidjourneyImages(provider, model, params, timeoutMs = 600000, referenceImages = [], options) {
  const opt = midjourneyOptions(options);
  const prompt = String(params.prompt || "").trim();
  if (!prompt) throw new Error("缺少 Midjourney 提示词");
  const submit = await submitMidjourney(
    provider,
    model,
    { prompt, size: params.size, version: model, speed: midjourneySpeed(params.speed), mode: referenceImages.length ? "edit" : "imagine", reference_images: referenceImages },
    Math.min(timeoutMs, 180000),
    options,
  );
  const deadline = opt.clock.now() + timeoutMs;
  let lastRaw = submit.raw;
  for (;;) {
    const task = await getMidjourneyTask(provider, submit.taskId, Math.min(timeoutMs, 180000), options);
    lastRaw = task.raw;
    if (task.status === "succeeded") return { images: task.images, raw: lastRaw };
    if (task.status === "failed") throw new Error(task.error || "Midjourney 任务失败");
    if (opt.clock.now() >= deadline) throw new Error("Midjourney 生成超时，请稍后再试。");
    await opt.clock.sleep(2500);
  }
}

// ── 图片编辑（OpenAI 兼容 /v1/images/edits，multipart/form-data）──────
// 单图用字段名 image；多图用 image[]（gpt-image 系列）。不手动设 Content-Type，
// 交给 fetch 依据 FormData 生成 multipart boundary。

// 源：protocols.ts:4347-4356（W4b 未导出，本地实现）
function imageTaskErrorDetail(value, fallback) {
  if (typeof value === "string") return value.trim() || fallback;
  if (value == null) return fallback;
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized !== "{}" ? serialized : fallback;
  } catch { return fallback; }
}

// 源：protocols.ts:4404-4434（W4b 未导出，本地实现）
async function pollGptBestImageTask(provider, taskId, headers, timeoutMs, net, time) {
  const deadline = time.now() + Math.max(timeoutMs, 14 * 60000);
  let lastPayload = null;
  while (time.now() < deadline) {
    await time.sleep(2500);
    const taskPath = images.isGptBestAsyncImageProvider(provider)
      ? "/v1/images/tasks/" + encodeURIComponent(taskId)
      : "/v1/tasks/" + encodeURIComponent(taskId);
    const response = await net.fetch(joinUrl(provider.base_url, taskPath), { headers, signal: AbortSignal.timeout(45000) });
    const text = await response.text();
    try { lastPayload = JSON.parse(text); } catch { lastPayload = text; }
    if (!response.ok) throw new Error("图片任务查询失败 HTTP " + response.status + ": " + text.slice(0, 500));
    const parsed = images.parseImagePayload(lastPayload);
    if (parsed.length) return { images: parsed, raw: lastPayload };
    const status = images.imageTaskStatus(lastPayload);
    if (["FAILURE", "FAILED", "ERROR", "CANCELED", "CANCELLED", "REJECTED"].includes(status)) {
      const node = lastPayload && lastPayload.data && typeof lastPayload.data === "object" ? lastPayload.data : lastPayload;
      throw new Error(imageTaskErrorDetail(node && (node.fail_reason || node.error || node.message), "图片任务失败（" + taskId + "）"));
    }
  }
  throw new Error("GPT-Best 图片任务仍在处理中（task_id=" + taskId + "），请稍后重试。");
}

// 源：protocols.ts:6501-6510（源用 withDirectApiQuota 包 unmetered；见文件头第 6 条）
async function editImages(provider, model, params, inputs, timeoutMs = 300000, transport, clock) {
  const net = resolveTransport(transport);
  const time = resolveClock(clock);
  return editImagesUnmetered(provider, model, params, inputs, timeoutMs, net, time);
}

// 源：protocols.ts:6512-6620
async function editImagesUnmetered(provider, model, params, inputs, timeoutMs, net, time) {
  const rawProto = String(provider.protocol || "").trim().toLowerCase();
  // B7e2 后续：CLI 协议族端口已注入则调用，未注入仍结构化拒绝（B2 行为不变）。
  if (rawProto === "cli:jimeng" || rawProto === "jimeng-cli") {
    const port = legacyExecutorPorts.getLegacyExecutorPort("cliJimeng");
    if (typeof port === "function") return port("image.edit", { provider, model, params, inputs, timeoutMs, transport: net, clock: time });
    return unavailable(CLI_PORT_DETAIL + "：cli:jimeng 图片编辑（protocols.ts:6516 generateJimengImage）");
  }
  if (rawProto === "cli:codex" || rawProto === "codex-cli") {
    const port = legacyExecutorPorts.getLegacyExecutorPort("cliCodex");
    if (typeof port === "function") return port("image.edit", { provider, model, params, inputs, timeoutMs, transport: net, clock: time });
    return unavailable(CLI_PORT_DETAIL + "：cli:codex 图片编辑（protocols.ts:6530 editCodexImage）");
  }
  if (rawProto === "cli:gemini" || rawProto === "gemini-cli") {
    const port = legacyExecutorPorts.getLegacyExecutorPort("cliGemini");
    if (typeof port === "function") return port("image.edit", { provider, model, params, inputs, timeoutMs, transport: net, clock: time });
    return unavailable(CLI_PORT_DETAIL + "：cli:gemini 图片编辑（protocols.ts:6539 editGeminiCliImage）");
  }
  // B7e2：端口已注入则调用注入实现；未注入仍返回结构化 LEGACY_DEPENDENCY_UNAVAILABLE（B2 行为不变）。
  if (rawProto === "agnes") {
    const port = legacyExecutorPorts.getLegacyExecutorPort("editAgnesImages");
    if (typeof port === "function") return port(provider, model, params, inputs, timeoutMs, net, time);
    return unavailable(BATCH.agnes + "：editAgnesImages（protocols.ts:6545）");
  }
  if (rawProto === "modelscope") {
    const port = legacyExecutorPorts.getLegacyExecutorPort("editModelScopeImages");
    if (typeof port === "function") return port(provider, model, params, inputs, timeoutMs, net, time);
    return unavailable(BATCH.modelscope + "：editModelScopeImages（protocols.ts:6546）");
  }
  if (rawProto === "volcengine") return images.generateVolcengineImages(provider, model, params, inputs, timeoutMs, net);
  if (rawProto === "runninghub") {
    const port = legacyExecutorPorts.getLegacyExecutorPort("editRunningHubImages");
    if (typeof port === "function") return port(provider, model, params, inputs, timeoutMs, net, time);
    return unavailable(BATCH.runninghub + "：editRunningHubImages（protocols.ts:6548）");
  }
  if (rawProto === "xai" || rawProto === "grok2api") {
    if (!inputs.length) throw new Error("图像编辑需要至少一张参考图");
    return images.requestGrok2ApiImages(provider, model, params, inputs, timeoutMs, net);
  }
  if (rawProto === "zkki" || rawProto === "zkki-model") {
    if (!inputs.length) throw new Error("图像编辑需要至少一张参考图");
    return images.requestZkkiImages(provider, model, params, inputs, timeoutMs, net);
  }
  if (rawProto === "midjourney") return generateMidjourneyImages(provider, model, params, timeoutMs, inputs, { transport: net, clock: time });
  assertRunnableProtocol(rawProto, "图像编辑");
  const proto = normalizeProtocol(provider.protocol);
  if (!inputs.length) throw new Error("图像编辑需要至少一张参考图");
  const useApibOpenAiCompatibility = images.isApibOpenAiImageProvider(provider);
  if ((proto === "apimart" || proto === "apimart-gemini" || proto === "apimart-media") && !useApibOpenAiCompatibility) {
    return images.generateApimartImages(provider, model, params, timeoutMs, inputs, net, time);
  }
  if (proto === "gemini") return images.generateGeminiImages(provider, model, params, timeoutMs, inputs, net);
  if (proto !== "openai" && !useApibOpenAiCompatibility) {
    throw new Error("当前模型协议「" + (rawProto || proto) + "」暂不支持参考图生成，请选择已声明图像编辑能力的模型。");
  }
  if (useApibOpenAiCompatibility || rawProto === "gemini-generations" || (rawProto === "openai-image" && images.usesGenerationEndpointForImageEdit(model))) {
    return images.editOpenAiCompatibleGenerationImages(provider, model, params, inputs, timeoutMs, net, time);
  }
  const def = PROTOCOLS.openai;
  const useGptBestAsync = images.isGptBestAsyncImageProvider(provider);
  const url = joinUrl(provider.base_url, "/v1/images/edits" + (useGptBestAsync ? "?async=true" : ""));
  const headers = {
    Accept: "application/json",
    ...(def.headers || {}),
    ...buildAuthHeaders(def, provider.api_key),
  };
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", String(params.prompt || "").trim());
  if (useApibOpenAiCompatibility) form.append("size", images.apibImageAspectRatio(params.size));
  else if (params.size && params.size !== "auto") form.append("size", params.size);
  const quality = images.openAiImageQuality(provider, model, params.quality);
  if (quality) form.append("quality", quality);
  if (params.n) form.append("n", String(Math.max(1, Math.min(4, Number(params.n) || 1))));
  const outboundInputs = useApibOpenAiCompatibility ? await images.prepareApibEditInputs(inputs) : inputs;
  if (!Array.isArray(outboundInputs)) return outboundInputs;
  const field = outboundInputs.length > 1 ? "image[]" : "image";
  for (const img of outboundInputs) {
    form.append(field, new Blob([new Uint8Array(img.buf)], { type: img.mime || "image/png" }), img.name || "image.png");
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await net.fetch(url, { method: "POST", headers, body: form, signal: ctrl.signal });
    const text = await resp.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = text; }
    if (!resp.ok) {
      const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
      throw new Error("HTTP " + resp.status + ": " + detail.slice(0, 500));
    }
    const parsed = images.parseImagePayload(payload);
    if (parsed.length) return { images: parsed, raw: payload };
    const taskId = images.imageTaskId(payload);
    if (taskId) return pollGptBestImageTask(provider, taskId, headers, timeoutMs, net, time);
    return { images: [], raw: payload };
  } catch (error) {
    if (ctrl.signal.aborted) throw new Error("图像编辑超时，请重试或换更快的模型。");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  generateVideos,
  generateSpeech,
  transcribeAudio,
  generateMusic,
  editImages,
  uploadApimartMedia,
  generateVolcengineVideos,
  volcengineVideoReferenceContentItems,
  generateMinimaxVideos,
  submitMidjourney,
  getMidjourneyTask,
  submitMidjourneyAction,
  submitMidjourneyModal,
  generateMidjourneyImages,
  // 可控接缝 / 常量（供聚合出口与测试使用）
  LEGACY_DEPENDENCY_UNAVAILABLE,
  MIDJOURNEY_API_ROOT,
  MIDJOURNEY_ACTION_PATHS,
};
