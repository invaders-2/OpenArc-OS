"use strict";
/**
 * APIMart（api.apimart.ai / apib.ai）适配器 —— 按官方文档 docs.apimart.ai 与 NOVAI 的实战经验对接。
 *
 * 和普通 OpenAI 兼容站的区别：
 *   · 图片 / 视频都是异步任务：POST 提交 → 返回 data[0].task_id → GET /v1/tasks/{id} 轮询
 *     （状态 submitted / pending / processing / completed / failed / cancelled）。
 *   · 图片结果在 data.result.images[].url[]，视频在 data.result.videos[].url[]；链接有过期时间，调用方负责落盘。
 *   · 尺寸不是 WxH，而是 size=比例 + resolution=档位（1K/2K/4K），按模型能力收敛。
 *   · 参考图放 image_urls；本地图先传 /v1/uploads/images（multipart 字段 file，72 小时有效）换成网址。
 *   · 改图同样走 /v1/images/generations；GPT-Image-2 / 2.5 支持 mask_url（透明区域 = 要改的地方）。
 *   · 对话接口即使不要流式也会回 SSE，所以统一按流读完再拼。
 * 其余（模型清单、流式对话）沿用 OpenAI 兼容实现。
 */
const generic = require("./provider-adapter.cjs");

const ADAPTER_TYPE = "apimart";
const HOST_RE = /(^|\.)(apimart\.ai|apib\.ai)$/i;

function isApimartUrl(baseUrl) {
  try { return HOST_RE.test(new URL(String(baseUrl || "")).hostname); } catch { return false; }
}
const rootOf = (baseUrl) => String(baseUrl || "").replace(/\/+$/, "").replace(/\/v1$/i, "");
const lc = (s) => String(s || "").trim().toLowerCase();

/* ---------------- 模型规格（逐条摘自官方文档，见 provider-apimart-models.cjs） ---------------- */
const catalog = require("./provider-apimart-models.cjs");
const R_DEFAULT = ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "21:9"];

function ratioValue(r) { const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(r)); return m ? Number(m[1]) / Number(m[2]) : null; }
function closestRatio(target, allowed) {
  const list = (allowed || R_DEFAULT).filter((r) => ratioValue(r));
  if (!list.length) return null;
  let best = list[0]; let bestD = Infinity;
  for (const r of list) { const d = Math.abs(Math.log(ratioValue(r) / target)); if (d < bestD) { bestD = d; best = r; } }
  return best;
}
const isAuto = (r) => /^(auto|adaptive|自适应)$/i.test(String(r || "").trim());
/** 面板 / 尺寸 → 这个模型认的比例值（不支持的比例收到最接近的；auto 只在模型支持时保留） */
function pickRatio(allowed, want, size) {
  const list = Array.isArray(allowed) ? allowed : R_DEFAULT;
  if (!list.length) return null;
  const autoVal = list.find((r) => isAuto(r)) || null;
  let r = String(want || "").trim();
  if (!r || isAuto(r)) {
    const m = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(String(size || ""));
    if (isAuto(r) && autoVal) return autoVal;
    if (m) return closestRatio(Number(m[1]) / Number(m[2]), list) || autoVal;
    return autoVal || (list.includes("16:9") ? "16:9" : list[0]);
  }
  if (list.includes(r)) return r;
  const v = ratioValue(r);
  return (v && closestRatio(v, list)) || autoVal || list[0];
}
/** 面板档位（1K / 2K / 720p ...）→ 接口值；按数字最接近收敛 */
function pickRes(res, want, size) {
  if (!Array.isArray(res) || !res.length) return null;
  const num = (x) => { const s = String(x || "").toLowerCase(); const k = /([0-9.]+)\s*k/.exec(s); if (k) return Number(k[1]) * 1000; const p = /([0-9]+)\s*p/.exec(s); if (p) return Number(p[1]) * 1.5; const mp = /([0-9.]+)\s*mp/.exec(s); if (mp) return Number(mp[1]) * 1000; if (/^hd$/.test(s)) return 1080; if (/^fhd$/.test(s)) return 1620; if (/std/.test(s)) return 1080; if (/pro/.test(s)) return 1620; return NaN; };
  let w = String(want || "").trim();
  if (!w) { const m = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(String(size || "")); const long = m ? Math.max(Number(m[1]), Number(m[2])) : 1024; w = long <= 1600 ? "1K" : long <= 3000 ? "2K" : "4K"; }
  const hit = res.find((r) => String(r[0]).toLowerCase() === w.toLowerCase() || String(r[1] || "").toLowerCase() === w.toLowerCase());
  if (hit) return hit[1];
  const target = num(w);
  if (!Number.isFinite(target)) return res[0][1];
  return res.reduce((a, b) => (Math.abs(num(b[0]) - target) < Math.abs(num(a[0]) - target) ? b : a))[1];
}
/** 兼容旧接口：{ ratio, resolution } */
function sizeSpec(model, size, params = {}) {
  const spec = catalog.imageModel(model);
  return {
    ratio: pickRatio(spec ? spec.ratios : R_DEFAULT, params.aspect_ratio || params.ratio, size),
    resolution: spec ? pickRes(spec.res, params.resolution || params.imageSize, size) : pickRes([["1K", "1K"], ["2K", "2K"], ["4K", "4K"]], params.resolution || params.imageSize, size),
  };
}

/* ---------------- HTTP ---------------- */
function apiError(status, body) {
  const msg = body && typeof body === "object" ? ((body.error && (body.error.message || body.error.msg)) || body.message || body.msg || "") : String(body || "").slice(0, 300);
  const error = status === 401 || status === 403 ? "PROVIDER_AUTH_FAILED" : status === 402 ? "PROVIDER_QUOTA_EXCEEDED" : status === 429 ? "PROVIDER_RATE_LIMITED" : "PROVIDER_PROTOCOL_ERROR";
  return { ok: false, error, status, detail: String(msg || ("HTTP " + status)).slice(0, 500) };
}
async function http(fetchImpl, url, { method = "GET", apiKey, json, form, headers: extraHeaders = null, signal, timeoutMs = 60000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => controller.abort(signal && signal.reason);
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const headers = { authorization: "Bearer " + apiKey, accept: "application/json", ...(extraHeaders || {}) };
    let body;
    if (json) { headers["content-type"] = "application/json"; body = JSON.stringify(json); }
    else if (form) body = form;
    const res = await fetchImpl(url, { method, headers, body, signal: controller.signal, redirect: "error" });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) return apiError(res.status, data);
    if (data && typeof data === "object" && data.error && !data.data) return apiError(Number(data.code) || 400, data);
    return { ok: true, data };
  } catch (err) {
    if (signal && signal.aborted) return { ok: false, error: "CANCELLED", detail: "cancelled" };
    const timeout = controller.signal.aborted || String((err && err.message) || "").includes("timeout");
    return { ok: false, error: timeout ? "PROVIDER_TIMEOUT" : "PROVIDER_UNREACHABLE", detail: String((err && err.message) || err).slice(0, 200) };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}
const sleep = (ms, signal) => new Promise((resolve) => { const t = setTimeout(resolve, process.env.APM_FAST ? 1 : ms); if (signal) signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); });

function taskIdOf(payload) {
  const roots = [payload, payload && payload.data].flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => v && typeof v === "object");
  for (const r of roots) { const id = r.task_id || r.taskId || r.id; if (id) return String(id); }
  return "";
}
function urlsIn(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item === "string") { out.push(item); continue; }
    if (!item || typeof item !== "object") continue;
    const u = item.url || item.video_url || item.image_url;
    if (Array.isArray(u)) out.push(...u.filter((x) => typeof x === "string"));
    else if (typeof u === "string") out.push(u);
  }
  return out.filter((u) => /^https?:\/\//i.test(u));
}
function resultUrls(payload, kind) {
  const d = (payload && payload.data) || payload || {};
  const node = Array.isArray(d) ? d[0] || {} : d;
  const res = node.result || node.output || {};
  if (kind === "audio") return (Array.isArray(res.music) ? res.music : Array.isArray(res.audios) ? res.audios : []).map((m) => (m && (m.audio_url || m.url || m.wav_url)) || "").filter((u) => /^https?:\/\//i.test(u));
  const key = kind === "video" ? "videos" : "images";
  let urls = urlsIn(res[key]);
  if (!urls.length && kind === "video") urls = [res.video_url, node.video_url, res.url].filter((u) => typeof u === "string" && /^https?:/i.test(u));
  if (!urls.length && kind === "image" && Array.isArray(d)) urls = urlsIn(d);
  return urls;
}

/** 提交后轮询任务，直到 completed / failed；返回 { ok, urls } */
async function runTask({ fetchImpl, apiKey, baseUrl, path, body, headers = null, kind, signal, timeoutMs, pollMs = 3000, onEvent, queryPath = "/v1/tasks/" }) {
  const root = rootOf(baseUrl);
  const sub = await http(fetchImpl, root + path, { method: "POST", apiKey, json: body, headers, signal, timeoutMs: 120000 });
  if (!sub.ok) return sub;
  const direct = resultUrls(sub.data, kind);
  if (direct.length) return { ok: true, urls: direct };
  const taskId = taskIdOf(sub.data);
  if (!taskId) return { ok: false, error: "PROVIDER_PROTOCOL_ERROR", detail: "APIMart 没有返回任务 ID：" + JSON.stringify(sub.data).slice(0, 300) };
  const deadline = Date.now() + timeoutMs;
  await sleep(Math.min(pollMs, 3000), signal);
  let misses = 0;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) return { ok: false, error: "CANCELLED", detail: "已停止（远程任务 " + taskId + " 可能仍在处理）" };
    const q = await http(fetchImpl, root + queryPath + encodeURIComponent(taskId) + "?language=zh", { apiKey, signal, timeoutMs: 30000 });
    if (!q.ok) {
      if (q.error === "CANCELLED" || ++misses > 5) return { ...q, detail: (q.detail || "") + "（任务 " + taskId + "）" };
      await sleep(pollMs, signal); continue;
    }
    misses = 0;
    const node = (q.data && q.data.data) || q.data || {};
    const status = lc(node.status || node.task_status);
    if (typeof node.progress === "number" && onEvent) { try { onEvent({ type: "progress", progress: node.progress / 100 }); } catch { /* ignore */ } }
    if (["completed", "succeeded", "success", "done", "finished"].includes(status)) {
      const urls = resultUrls(q.data, kind);
      return urls.length ? { ok: true, urls, taskId, cost: node.cost } : { ok: false, error: "PROVIDER_PROTOCOL_ERROR", detail: "任务完成但没有返回结果链接（" + taskId + "）" };
    }
    if (["failed", "failure", "error", "cancelled", "canceled", "rejected", "expired", "timeout"].includes(status)) {
      const e = node.error || {};
      return { ok: false, error: "PROVIDER_TASK_FAILED", detail: String(e.message || node.fail_reason || node.message || status).slice(0, 500) };
    }
    await sleep(pollMs, signal);
  }
  return { ok: false, error: "PROVIDER_TIMEOUT", detail: "本地等待超时，远程任务 " + taskId + " 可能仍在处理，请勿重复提交" };
}

/* ---------------- 素材上传 ---------------- */
function decodeDataUrl(v) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(String(v || ""));
  if (!m) return null;
  return { mime: m[1] || "application/octet-stream", buf: m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3])) };
}
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mp4": "m4a", "audio/aac": "aac" };
// 文档只有 POST /v1/uploads/images；/v1/uploads/videos|audios|files 不存在（探测 404）。
// 音视频参考素材只能用公网可访问 URL 或 asset://，本地文件不假装能上传。
const MEDIA_PATHS = { image: ["/v1/uploads/images"] };
const UPLOAD_KIND_LABEL = { video: "参考视频", audio: "参考音频" };
/** data URL → APIMart 托管网址；https / asset:// 原样返回。音视频本地文件直接 UNSUPPORTED；图片上传失败时小图退回 data URL。 */
async function upload({ fetchImpl, apiKey, baseUrl, value, kind = "image", signal }) {
  const v = String(value || "");
  if (/^(https?:|asset:)/i.test(v)) return { ok: true, url: v };
  if (kind === "video" || kind === "audio") {
    return {
      ok: false,
      error: "UNSUPPORTED",
      kind,
      detail: (UPLOAD_KIND_LABEL[kind] || "这个素材") + "不能从本地上传：APIMart 文档只提供 /v1/uploads/images，音视频参考素材必须用公网可访问的 URL（或 asset:// 素材）—— 先把本地文件传到可公开访问的地方再填网址。",
    };
  }
  const dec = decodeDataUrl(v);
  if (!dec) return { ok: false, error: "INVALID_INPUT", detail: "不支持的素材地址" };
  const root = rootOf(baseUrl);
  let last = null;
  for (const path of MEDIA_PATHS[kind] || MEDIA_PATHS.image) {
    const form = new FormData();
    form.append("file", new Blob([dec.buf], { type: dec.mime }), kind + "." + (EXT[dec.mime] || "bin"));
    const r = await http(fetchImpl, root + path, { method: "POST", apiKey, form, signal, timeoutMs: 120000 });
    if (r.ok) {
      const d = r.data || {};
      const url = d.url || (d.data && (d.data.url || d.data.asset_url || d.data.file_url)) || d.asset_url || d.file_url;
      if (typeof url === "string" && /^(https?:|asset:)/i.test(url)) return { ok: true, url };
    }
    last = r;
  }
  // 上传失败时只有小图才直接内联进请求（大了会被网关 413 拒绝，不如直接说明原因）
  if (kind === "image" && dec.buf.length <= 512 * 1024) return { ok: true, url: v };
  return { ok: false, error: (last && last.error) || "PROVIDER_PROTOCOL_ERROR", detail: (kind === "video" ? "参考视频" : kind === "audio" ? "参考音频" : "参考图") + "上传到 APIMart 失败：" + ((last && last.detail) || "") };
}
const kindOfValue = (v) => { const s = String(v || ""); if (/^data:video\//i.test(s) || /\.(mp4|mov|webm|m4v)(\?|$)/i.test(s)) return "video"; if (/^data:audio\//i.test(s) || /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(s)) return "audio"; return "image"; };

/* ---------------- 图片 ---------------- */
const OFFICIAL_HEADERS = () => ({ "X-APIMart-Response-Version": "2026-07-27", "Idempotency-Key": "oa_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10) });
function imageBody(model, prompt, { size = null, n = 1, params = {}, refs = 0, keepRatio = true } = {}) {
  const spec = catalog.imageModel(model);
  const body = { model, prompt: String(prompt || "").trim() };
  if (!spec) {
    const ss = sizeSpec(model, size, params);
    body.n = n; if (ss.ratio) body.size = ss.ratio; if (ss.resolution) body.resolution = ss.resolution;
  } else {
    if (!spec.noN) body.n = n;
    if (spec.ratioKey && keepRatio) {
      let r = pickRatio(spec.ratios, params.aspect_ratio || params.ratio, size);
      if (r && isAuto(r) && spec.autoNeedsRef && !refs) r = pickRatio(spec.ratios.filter((x) => !isAuto(x)), null, size);
      if (r) body[spec.ratioKey] = r;
    }
    if (spec.resKey) { const v = pickRes(spec.res, params.resolution || params.imageSize, size); if (v) body[spec.resKey] = v; }
    if (spec.extra) Object.assign(body, spec.extra);
  }
  for (const k of ["quality", "output_format", "background", "moderation"]) if (params[k]) body[k] = params[k];
  return body;
}
const imagesOut = (r) => (r.ok ? { ok: true, artifacts: r.urls.map((url) => ({ url })), text: "" } : r);
/** 按模型单次上限拆批：nMax=1 的要几张就并发几次 */
async function runImages({ fetchImpl, apiKey, baseUrl, model, n, mkBody, signal, timeoutMs, onEvent }) {
  const spec = catalog.imageModel(model);
  const per = spec ? Math.max(1, spec.nMax || 1) : 4;
  const batches = []; let left = n;
  while (left > 0) { const k = Math.min(per, left); batches.push(k); left -= k; }
  const headers = spec && spec.official ? OFFICIAL_HEADERS : null;
  const runs = await Promise.all(batches.map((k, i) => runTask({ fetchImpl, apiKey, baseUrl, path: "/v1/images/generations", body: mkBody(k), headers: headers ? headers() : null, kind: "image", signal, timeoutMs, onEvent: i === 0 ? onEvent : undefined })));
  const urls = runs.filter((r) => r.ok).flatMap((r) => r.urls);
  return urls.length ? { ok: true, artifacts: urls.map((url) => ({ url })), text: "" } : runs[0];
}

/** 文生图（model-service.generateImage 走 generateComplete 分支） */
async function generateComplete({ baseUrl, apiKey, kind = "image", model, prompt, size = null, count = 1, params = {}, signal = null, timeoutMs = 600000, fetchImpl = fetch, onEvent } = {}) {
  if (kind !== "image") return { ok: false, error: "CAPABILITY_UNAVAILABLE", detail: "apimart-generate-" + kind };
  const n = Math.max(1, Math.min(4, Number(count) || 1));
  return runImages({ fetchImpl, apiKey, baseUrl, model, n, signal, timeoutMs, onEvent, mkBody: (k) => imageBody(model, prompt, { size, n: k, params }) });
}

/**
 * 改图 / 图生图：mode = prompt | redraw | erase | outpaint ...
 * redraw / erase 且模型支持 mask_url 时：原图（挖空版）同时作为 image_urls[0] 与 mask_url（透明 = 要改的区域）。
 */
async function editImageMode({ baseUrl, apiKey, model, mode = "prompt", prompt = "", promptForHole = "", sourceDataUrl = "", originalDataUrl = "", maskPngDataUrl = "", inputs = [], params = {}, count = 1, signal = null, timeoutMs = 600000, fetchImpl = fetch } = {}) {
  const spec = catalog.imageModel(model);
  if (spec && !spec.refs) return { ok: false, error: "CAPABILITY_UNAVAILABLE", detail: "这个模型只能文生图，不收参考图；请在「模型」里换一个支持图生图的模型" };
  const max = spec ? spec.refs : 16;
  const all = [sourceDataUrl, ...(Array.isArray(inputs) ? inputs : [])].filter(Boolean).slice(0, max);
  if (!all.length) return { ok: false, error: "INVALID_INPUT", detail: "没有原图" };
  const urls = [];
  for (const v of all) { const u = await upload({ fetchImpl, apiKey, baseUrl, value: v, kind: "image", signal }); if (!u.ok) return u; urls.push(u.url); }
  const useMask = !!(spec && spec.mask && sourceDataUrl && ["redraw", "erase"].includes(String(mode)));
  // 有原图时：image_urls[0] = 原图（模型看得到要改的东西），mask_url = 挖空图（透明处 = 要改的区域）
  let maskUrl = null;
  if (useMask && originalDataUrl) {
    const o = await upload({ fetchImpl, apiKey, baseUrl, value: originalDataUrl, kind: "image", signal }); if (!o.ok) return o;
    maskUrl = urls[0]; urls[0] = o.url;
    if (maskPngDataUrl) { const m = await upload({ fetchImpl, apiKey, baseUrl, value: maskPngDataUrl, kind: "image", signal }); if (!m.ok) return m; maskUrl = m.url; }
  }
  const text = useMask ? (String(mode) === "erase" ? ("移除遮罩区域里的内容，按周围环境自然补全。" + (prompt ? "补充：" + prompt : "")) : prompt) : (promptForHole || prompt);
  // 图生图默认跟随原图比例（文档建议不传 size）；扩图 / 面板明确选了比例时才传
  const keepRatio = String(mode) === "outpaint" || !!(params.aspect_ratio || params.ratio);
  const n = Math.max(1, Math.min(4, Number(count) || 1));
  return runImages({ fetchImpl, apiKey, baseUrl, model, n, signal, timeoutMs, mkBody: (k) => {
    const body = imageBody(model, text, { n: k, params, refs: urls.length, keepRatio });
    body.image_urls = urls;
    if (useMask) body.mask_url = maskUrl || urls[0];
    return body;
  } });
}

/** 兼容通用 editImage 签名（只有提示词 + 输入图） */
async function editImage({ baseUrl, apiKey, model, prompt, inputs = [], signal = null, timeoutMs = 600000, fetchImpl = fetch } = {}) {
  const [first, ...rest] = Array.isArray(inputs) ? inputs : [];
  const r = await editImageMode({ baseUrl, apiKey, model, mode: "prompt", prompt, sourceDataUrl: first, inputs: rest, signal, timeoutMs, fetchImpl });
  return r.ok ? { ok: true, images: r.artifacts.map((a) => ({ url: a.url })) } : r;
}

/* ---------------- 视频 ---------------- */
const FRAME_MODES = new Set(["image_to_video", "start_end_to_video"]);
function genericVideoBody(model, prompt, p, imgs, vids, auds) {
  const body = { model, prompt: String(prompt || "").trim(), duration: Math.round(Number(p.duration) || 5) };
  const r = pickRatio(["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], p.ratio, p.size); if (r) body.size = r;
  body.resolution = pickRes([["480p", "480p"], ["720p", "720p"], ["1080p", "1080p"]], p.resolution);
  if (imgs.length) body.image_urls = imgs.map((x) => x.url);
  if (vids.length) body.video_urls = vids;
  if (auds.length) body.audio_urls = auds;
  return body;
}

/** 按文档规格组视频请求体；不合法的组合直接给出中文原因 */
function videoBody(spec, model, prompt, p, imgs, vids, auds) {
  // 动作控制族（kling-v2-6 / kling-v3 motion-control）：契约是 image_url + video_url + character_orientation + keep_original_sound，
  // 不是普通文生 / 图生视频；之前被通用写法塞了 size/image_urls，这里单独组体。
  if (spec.motionControl) {
    const ref = vids[0] || null;
    if (!ref) return { error: "这个模型需要一段参考视频（人物动作来源），且只能用公网可访问的 URL" };
    const body = { model };
    const text = String(prompt || "").trim();
    if (text) body.prompt = text;
    const d = catalog.clampDur(spec.dur, p.duration);
    if (d != null) body.duration = d;
    const first = imgs[0] || null;
    if (first) body.image_url = first.url;
    body.video_url = ref;
    const orientation = String(p.character_orientation || "").trim();
    if (orientation) body.character_orientation = orientation;
    if (typeof p.keep_original_sound === "boolean") body.keep_original_sound = p.keep_original_sound;
    return { body };
  }
  const body = { model, prompt: String(prompt || "").trim() };
  const mode = String(p.modelType || "");
  if (spec.durKey !== null) { const d = catalog.clampDur(spec.dur, p.duration); if (d != null) body[spec.durKey || "duration"] = d; }
  if (spec.ratioKey) { const r = pickRatio(spec.ratios, p.ratio, p.size); if (r) body[spec.ratioKey] = r; }
  if (spec.resKey) { const v = pickRes(spec.res, p.resolution); if (v) body[spec.resKey] = v; }
  if (spec.audioKey && typeof p.generateAudio === "boolean") body[spec.audioKey] = p.generateAudio;
  if (spec.hdDur && /1080/i.test(String(body.resolution || ""))) body.duration = spec.hdDur; // 海螺 1080P 只支持固定时长

  // 首尾帧 vs 参考图：看角色，其次看生成方式
  const first = imgs.find((x) => x.role === "first_frame");
  const last = imgs.find((x) => x.role === "last_frame");
  const wantFrames = !!(first || last) || FRAME_MODES.has(mode);
  let f = null; let l = null; let refs = [];
  if (wantFrames && spec.frames) {
    f = first || imgs.find((x) => x !== last) || null;
    l = spec.noLast ? null : (last || (mode === "start_end_to_video" ? imgs.find((x) => x !== f) : null) || null);
    refs = imgs.filter((x) => x !== f && x !== l);
  } else refs = imgs.slice();
  if (wantFrames && !spec.frames && imgs.length && !spec.refsBy) return { error: "这个模型不支持首帧 / 首尾帧，请换成文生视频或换个模型" };

  if (f || l) {
    if (spec.frames === "roles") body.image_with_roles = [f && { url: f.url, role: "first_frame" }, l && { url: l.url, role: "last_frame" }].filter(Boolean);
    else if (spec.frames === "urls") body.image_urls = [f, l].filter(Boolean).map((x) => x.url);
    else if (spec.frames === "urlsFirst") body.image_urls = [(f || l).url];
    else if (spec.frames === "first") body.first_frame_image = (f || l).url;
    else if (spec.frames === "fields") { if (f) body.first_frame_image = f.url; if (l) body[spec.lastKey || "last_frame_image"] = l.url; if (spec.pairFrames && !(f && l)) { delete body[spec.lastKey || "last_frame_image"]; delete body.first_frame_image; body.image_urls = [(f || l).url]; } }
    if (spec.veo && f && l) body.generation_type = "frame";
  }
  refs = refs.slice(0, Math.max(0, spec.refs - (f ? 1 : 0) - (l ? 1 : 0)));
  if (refs.length) {
    if (!spec.refsBy) { if (!(f || l)) { if (spec.frames === "urlsFirst" || spec.frames === "first" || spec.frames === "urls" || spec.frames === "roles" || spec.frames === "fields") return videoBody(spec, model, prompt, { ...p, modelType: "image_to_video" }, imgs, vids, auds); } }
    else if (spec.refsBy === "urls") { if (body.image_with_roles) body.image_with_roles.push(...refs.map((x) => ({ url: x.url, role: "reference_image" }))); else body.image_urls = [...(body.image_urls || []), ...refs.map((x) => x.url)]; }
    else if (spec.refsBy === "roles") body.image_with_roles = [...(body.image_with_roles || []), ...refs.map((x) => ({ url: x.url, role: "reference" }))];
    else if (spec.refsBy === "img_references") body.img_references = refs.map((x) => x.url);
    if (spec.veo && (body.image_urls || []).length >= 3) body.generation_type = "reference";
  }
  if ((f || l) && (vids.length || auds.length) && spec.frames === "roles" && /seedance|minimax-h3/.test(lc(model))) return { error: "用首尾帧时不能再带参考视频或参考音频，请只保留一种" };

  // 参考视频 / 视频延长 / 视频编辑
  if (vids.length) {
    if ((mode === "video_extend" || mode === "video_edit") && spec.kling4) { body.video_url = vids[0]; body.omni_reference_task_type = mode === "video_extend" ? "extend" : "edit"; delete body.aspect_ratio; }
    else if (mode === "video_extend" && spec.extendKey) body[spec.extendKey] = spec.extendKey.endsWith("s") ? [vids[0]] : vids[0];
    else if (spec.videoKey) { body[spec.videoKey] = vids.slice(0, 5); if (spec.kling4) body.omni_reference_task_type = "reference"; }
    else return { error: "这个模型不收参考视频" };
  } else if (spec.kling4 && refs.length && !(f || l)) body.omni_reference_task_type = "reference";
  if (auds.length) {
    if (!spec.audioRefKey) return { error: "这个模型不收参考音频" };
    body[spec.audioRefKey] = spec.audioRefKey.endsWith("s") ? auds.slice(0, 3) : auds[0];
  }
  if (!body.prompt && !imgs.length && !vids.length) return { error: "请先写提示词" };
  if (spec.modes && spec.modes.length === 1 && spec.modes[0] === "首帧" && !(body.first_frame_image || body.image_urls)) return { error: "这个模型需要一张首帧图" };
  return { body };
}

async function generateVideo({ baseUrl, apiKey, model, prompt = "", inputs = [], params = {}, signal = null, timeoutMs = 900000, fetchImpl = fetch, onEvent } = {}) {
  const p = params && typeof params === "object" ? params : {};
  // MiniMax-H3-Context-IR / Regeneration 不是普通视频生成（前者产提示词、后者要 source_task_id）：直接说明，不套通用字段。
  const excluded = catalog.excludedVideoModel(model);
  if (excluded) return { ok: false, error: "UNSUPPORTED", detail: excluded.excluded };
  const kinds = Array.isArray(p.mediaKinds) ? p.mediaKinds : [];
  const roles = Array.isArray(p.imageRoles) ? p.imageRoles : [];
  const imgs = []; const vids = []; const auds = [];
  let imgIdx = 0;
  for (let i = 0; i < (Array.isArray(inputs) ? inputs.length : 0); i++) {
    const kind = kinds[i] || kindOfValue(inputs[i]);
    const u = await upload({ fetchImpl, apiKey, baseUrl, value: inputs[i], kind, signal });
    if (!u.ok) return u;
    if (kind === "video") vids.push(u.url); else if (kind === "audio") auds.push(u.url);
    else { imgs.push({ url: u.url, role: roles[imgIdx] || null }); imgIdx++; }
  }
  const spec = catalog.videoModel(model);
  let body;
  if (spec) { const built = videoBody(spec, model, prompt, p, imgs, vids, auds); if (built.error) return { ok: false, error: "INVALID_INPUT", detail: built.error }; body = built.body; }
  else body = genericVideoBody(model, prompt, p, imgs, vids, auds);
  const r = await runTask({ fetchImpl, apiKey, baseUrl, path: "/v1/videos/generations", body, kind: "video", signal, timeoutMs, pollMs: 5000, onEvent });
  return r.ok ? { ok: true, artifacts: r.urls.map((url) => ({ url, mime: "video/mp4" })), text: "" } : r;
}

/* ---------------- 音频：配音 / 音乐 / 音效 ---------------- */
async function generateAudio({ baseUrl, apiKey, model, prompt = "", params = {}, signal = null, timeoutMs = 900000, fetchImpl = fetch } = {}) {
  const spec = catalog.audioModel(model);
  const text = String(prompt || "").trim();
  if (!text) return { ok: false, error: "INVALID_INPUT", detail: "请先写提示词" };
  const kind = String(params.kind || "");
  const secs = (() => { const m = /(\d+)/.exec(String(params.duration || "")); return m ? Number(m[1]) : null; })();
  if (!spec || spec.api === "tts") {
    // 配音：同步返回音频文件
    const voice = ((spec && spec.voices) || []).find((v) => v[0] === kind)?.[1] || (/^(alloy|echo|fable|onyx|nova|shimmer)$/.test(kind) ? kind : "nova");
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 180000);
    const onAbort = () => controller.abort(); if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetchImpl(rootOf(baseUrl) + "/v1/audio/speech", { method: "POST", headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" }, body: JSON.stringify({ model, input: text.slice(0, 4096), voice, response_format: "wav" }), signal: controller.signal, redirect: "error" });
      if (!res.ok) { const t = await res.text(); let d = t; try { d = JSON.parse(t); } catch { /* 原文 */ } return apiError(res.status, d); }
      const mime = String(res.headers.get("content-type") || "audio/wav").split(";")[0];
      if (/json/.test(mime)) { const d = await res.json().catch(() => null); return apiError(400, d); }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) return { ok: false, error: "PROVIDER_PROTOCOL_ERROR", detail: "配音接口返回了空音频" };
      return { ok: true, artifacts: [{ b64: buf.toString("base64"), mime: /audio\//.test(mime) ? mime : "audio/wav" }], text: "" };
    } catch (err) {
      return { ok: false, error: signal && signal.aborted ? "CANCELLED" : "PROVIDER_UNREACHABLE", detail: String((err && err.message) || err).slice(0, 200) };
    } finally { clearTimeout(timer); if (signal) signal.removeEventListener("abort", onAbort); }
  }
  let path = "/v1/music/generations"; let body;
  if (spec.api === "suno") {
    if (/音效/.test(kind)) { path = "/v1/music/generations/sounds"; body = { model: "suno", prompt: text, type: /循环/.test(kind) ? "loop" : "one-shot" }; }
    else {
      // 文档：version（v6 / v6-wild / v6-mini）与 custom_model_id 二选一、至少给一个，否则 400。
      const customModelId = String(params.custom_model_id || "").trim();
      const custom = params.custom === true;
      body = {
        model: "suno",
        custom,
        instrumental: kind === "纯音乐",
        prompt: text.slice(0, custom ? 5000 : 3000),
        ...(customModelId ? { custom_model_id: customModelId } : { version: String(params.version || "v6") }),
      };
    }
  } else {
    body = { model: "flowmusic", sound_prompt: text.slice(0, 2000), ...(secs ? { length: Math.max(1, Math.min(240, secs)) } : {}) };
  }
  const r = await runTask({ fetchImpl, apiKey, baseUrl, path, body, kind: "audio", signal, timeoutMs, pollMs: 4000, queryPath: "/v1/music/tasks/" });
  return r.ok ? { ok: true, artifacts: r.urls.map((url) => ({ url, mime: "audio/mpeg" })), text: "" } : r;
}

/* ---------------- 对话：APIMart 非流式也回 SSE，统一用流式读完 ---------------- */
async function chatComplete({ baseUrl, apiKey, model, messages, tools = null, params = {}, signal = null, timeoutMs = 120000, fetchImpl = fetch } = {}) {
  try {
    const out = await generic.chatStream({ baseUrl: v1(baseUrl), apiKey, model, messages, tools, params, signal, timeoutMs, fetchImpl });
    return { ok: true, text: out.text || "", toolCalls: out.toolCalls && out.toolCalls.length ? out.toolCalls : null, usage: out.usage || null };
  } catch (err) {
    const name = String((err && err.name) || "");
    if (name === "AbortError") return { ok: false, error: "CANCELLED" };
    if (name === "TimeoutError") return { ok: false, error: "PROVIDER_TIMEOUT" };
    if (name === "ProviderHttpError") return apiError(err.status, null);
    return { ok: false, error: "PROVIDER_UNREACHABLE", detail: String((err && err.message) || err).slice(0, 200) };
  }
}

/**
 * 模型 id → 画布面板规格。
 *
 * 字段口径（与 provider-adapter-lovart.cjs#uiSpec 一致）：kind / ratios / sizes / batch /
 * maxRefs / i2i / mask / res / durs / modes / times / audio，外加**显式布尔**
 * search / style / camera / audio 与 capabilitiesSource：
 *   · 族规格里的能力来自模型表（APIMart 文档），capabilitiesSource:"spec"；
 *   · 明确 false = 这条链路不支持，不再留给前端按名字猜（"假可用"的根源）。
 *     搜索只对文档点名的联网模型为 true；风格 / 摄影机：canvas/modelImage 出口目前不转发，
 *     一律 false；batch 按模型单次上限（catalog nMax）收敛，视频 / 音频 / 文本恒 [1]。
 *   · 表里没有的模型给**最小 guess 规格**（kind:text + 显式 false），capabilitiesSource:"guess"，
 *     由 model-service 标成 specSource='guess'，前端据此显示「未验证」。
 */
function imageBatchOf(nMax) {
  const max = Math.max(1, Math.min(4, Number(nMax) || 1));
  const out = [];
  for (let n = 1; n <= max; n++) out.push(n);
  return out;
}

const uiSpec = (model) => {
  const img = catalog.imageModel(model);
  if (img) {
    return {
      kind: "image",
      ratios: catalog.uiRatio(img.ratios),
      sizes: img.res.map((r) => r[0]),
      batch: imageBatchOf(img.nMax),
      maxRefs: img.refs,
      i2i: img.refs > 0,
      ...(img.mask ? { mask: true } : {}),
      search: false,
      style: false,
      camera: false,
      audio: false,
      capabilitiesSource: "spec",
    };
  }
  const audio = catalog.audioModel(model);
  if (audio) {
    return { kind: "audio", kinds: [...audio.kinds], adurs: [...audio.adurs], batch: [1], search: false, style: false, camera: false, audio: false, capabilitiesSource: "spec" };
  }
  const excluded = catalog.excludedVideoModel(model);
  if (excluded) {
    return { kind: "video", unsupported: true, reason: excluded.excluded, ratios: [], res: [], durs: [], modes: [], maxRefs: 0, times: [1], batch: [1], search: false, style: false, camera: false, audio: false, capabilitiesSource: "spec" };
  }
  const video = catalog.videoModel(model);
  if (video) {
    return {
      kind: "video",
      ratios: catalog.uiRatio(video.ratios),
      res: video.res.map((r) => r[0]),
      durs: catalog.durList(video.dur),
      modes: [...video.modes],
      maxRefs: video.refs,
      times: [1],
      batch: [1],
      search: false,
      style: false,
      camera: false,
      audio: !!video.audioKey,
      capabilitiesSource: "spec",
    };
  }
  return { kind: "text", search: supportsWebSearch(model), style: false, camera: false, audio: false, batch: [1], capabilitiesSource: "guess" };
};

/* 地址带不带 /v1 都认（NOVAI 里填的是 https://apib.ai）：交给通用实现前补成 …/v1 */
const v1 = (baseUrl) => rootOf(baseUrl) + "/v1";
const chat = (o = {}) => generic.chat({ ...o, baseUrl: v1(o.baseUrl) });

/**
 * 模型清单：用官方元数据接口 /v1/models?expand=category 的分类（chat / image / video / audio）定能力，
 * 不再只靠名字猜（suno 曾被猜成对话、tts 什么都不是）。看图能力 = 官方 Vision / Omni / 多模态标签 ∪ 名字推断。
 */
async function listModels({ baseUrl, apiKey, signal, timeoutMs = 20000, fetchImpl = fetch } = {}) {
  const r = await http(fetchImpl, v1(baseUrl) + "/models?expand=category", { apiKey, signal, timeoutMs });
  const data = r.ok && r.data && Array.isArray(r.data.data) ? r.data.data : null;
  if (!data) return generic.listModels({ baseUrl: v1(baseUrl), apiKey, signal, timeoutMs, fetchImpl });
  const items = data.filter((m) => m && m.id && String(m.id).length <= 200).slice(0, 800).map((m) => {
    const id = String(m.id); const cat = lc(m.category); const tags = (Array.isArray(m.capability_tags) ? m.capability_tags : []).map(String);
    const guess = generic.guessCapabilities(id);
    let caps;
    if (cat === "image") caps = ["image-generation"];
    else if (cat === "video") caps = catalog.excludedVideoModel(id) ? [] : ["video-generation"];
    else if (cat === "audio") caps = /(whisper|transcri|realtime)/i.test(id) ? [] : /audio-preview|gpt-audio/i.test(id) ? ["chat"] : ["audio-generation"];
    else if (cat === "chat") {
      if (tags.includes("Embedding") || /(embed|rerank)/i.test(id)) caps = ["embedding"];
      else { caps = ["chat"]; if (tags.some((t) => /^(Vision|Omni|多模态)$/i.test(t)) || guess.includes("vision-input")) caps.push("vision-input"); }
    } else caps = guess;
    return { id, ownedBy: typeof m.owned_by === "string" ? m.owned_by.slice(0, 80) : null, suggestedCapabilities: caps, ...(cat && cat !== "unknown" ? { category: cat } : {}) };
  });
  return { ok: true, items };
}

/** 文档点名支持联网搜索（/v1/responses + web_search 工具）的模型 */
const WEB_SEARCH = /^(gpt-5\.2-pro|gpt-5\.2-codex|qwen3\.8-max)/i;
const supportsWebSearch = (model) => WEB_SEARCH.test(String(model || ""));
/** 对话消息 → Responses 接口的 input（文字 input_text，图片 input_image） */
function responsesInput(messages) {
  return (Array.isArray(messages) ? messages : []).map((m) => {
    const role = m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user";
    if (typeof m.content === "string") return { role, content: m.content };
    const parts = (Array.isArray(m.content) ? m.content : []).map((p) => {
      if (p && p.type === "text") return { type: role === "assistant" ? "output_text" : "input_text", text: String(p.text || "") };
      if (p && p.type === "image_url") return { type: "input_image", image_url: String((p.image_url && p.image_url.url) || p.image_url || "") };
      return null;
    }).filter(Boolean);
    return { role, content: parts };
  });
}
function responsesText(d) {
  const root = d && d.data && !d.choices && !d.output ? d.data : d;
  const c = root && Array.isArray(root.choices) && root.choices[0] && root.choices[0].message;
  if (c && typeof c.content === "string" && c.content) return c.content;
  if (root && typeof root.output_text === "string" && root.output_text) return root.output_text;
  const out = root && Array.isArray(root.output) ? root.output : [];
  return out.flatMap((o) => (Array.isArray(o && o.content) ? o.content : [])).map((p) => (p && (p.text || p.output_text)) || "").filter(Boolean).join("");
}
/** 流式对话；开了联网且模型支持时改走 /v1/responses + web_search（一次性返回，按一段输出） */
async function chatStream(o = {}) {
  if (!o.webSearch || !supportsWebSearch(o.model)) return generic.chatStream({ ...o, baseUrl: v1(o.baseUrl) });
  const onEvent = typeof o.onEvent === "function" ? o.onEvent : () => {};
  onEvent({ type: "response.start" });
  const r = await http(o.fetchImpl || fetch, v1(o.baseUrl) + "/responses", { method: "POST", apiKey: o.apiKey, json: { model: o.model, input: responsesInput(o.messages), tools: [{ type: "web_search" }], stream: false }, signal: o.signal, timeoutMs: Math.max(Number(o.timeoutMs) || 0, 180000) });
  if (!r.ok) {
    if (r.error === "CANCELLED") throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    if (r.error === "PROVIDER_TIMEOUT") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    throw Object.assign(new Error(r.detail || "provider-http"), { name: "ProviderHttpError", status: r.status || 502 });
  }
  const text = responsesText(r.data);
  if (text) onEvent({ type: "text.delta", text });
  const usage = r.data && (r.data.usage || (r.data.data && r.data.data.usage)) ? generic.mapUsage(r.data.usage || r.data.data.usage) : null;
  if (usage) onEvent({ type: "usage", usage });
  onEvent({ type: "response.complete" });
  return { text, toolCalls: [], usage };
}

module.exports = {
  ...generic,
  listModels,
  chat,
  chatStream,
  ADAPTER_TYPE,
  isApimartUrl,
  sizeSpec,
  generateComplete,
  editImage,
  editImageMode,
  uiSpec,
  generateVideo,
  generateAudio,
  chatComplete,
  upload,
  runTask,
};
