/**
 * DX OS 0.6.1 · OCR 域纯逻辑（无 I/O）：协议常量 + 命令白名单 + 响应归一化 + 请求地址构造 + 错误规约。
 *
 * 源（只读）：DXSRC/server/ocr.ts（170 行）、DXSRC/server/ocrRoutes.ts（46 行）、DXSRC/shared/ocr.ts（23 行）。
 * 为什么单独一层：ocr:command 是本域唯一顶层 IPC 通道，"哪些命令可被渲染层调用、失败回什么码、
 * PaddleOCR 的多种响应形状如何折叠成 OcrResult" 必须先在一处冻结，再交给 ocr-service.cjs 执行、
 * ocr-bootstrap.cjs 注册。命令表本身即白名单，未登记命令一律 OCR_COMMAND_NOT_ALLOWED。
 *
 * 与源的差异（不实现部分）：
 *   · 源 ocrRoutes.ts:5,13,39 的 apiModelAccessFilter / withDirectApiQuota 属云计费配额，OUT；
 *   · 源 ocr.ts:1-2 的 sharp 依赖不放这里，改由 ocr-service.cjs 惰性 require（缺依赖即结构化不可用）。
 *
 * 行号均为源文件行号：
 *   · shared/ocr.ts:17-22  协议名 / 模型 / baseUrl / keyUrl
 *   · server/ocr.ts:9-64   normalizePaddleOcr
 *   · server/ocr.ts:88-96  paddleOcrJobUrl
 *   · server/ocr.ts:97-106 verifyPaddleOcrConfiguration
 *   · server/ocr.ts:107-125 responseText / json / waitForPoll（执行侧在 ocr-service.cjs）
 *   · server/ocr.ts:126-132 paddleResultUrl
 *   · server/ocrRoutes.ts:17-18 providers 能力与上限
 *   · server/ocrRoutes.ts:20-23 上传上限（32MB）/ 全局 4 / 单用户 2
 *   · server/ocrRoutes.ts:31   300s 超时
 */
"use strict";

const foundationErrors = require("./dxos-foundation-errors.cjs");

/** shared/ocr.ts:17-21：协议名、模型与端点常量逐条照搬。 */
const OCR_PROTOCOL = "paddleocr-vl";
const OCR_MODEL = "PP-StructureV3";
const OCR_LEGACY_MODEL = "PaddleOCR-VL-1.6";
const OCR_BASE_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
const OCR_KEY_URL = "https://aistudio.baidu.com/account/accessToken";
/** server/ocr.ts:63 的 engine 标签。 */
const OCR_ENGINE = "paddleocr-vl-api";

/** server/ocrRoutes.ts:20 multer fileSize；server/ocr.ts:136 转换后上限（同值，源写了两处）。 */
const OCR_MAX_BYTES = 32 * 1024 * 1024;
/** server/ocrRoutes.ts:18 maxPixels；server/ocr.ts:135 sharp limitInputPixels（24M 像素）。 */
const OCR_MAX_PIXELS = 24 * 1024 * 1024;
/** server/ocr.ts:113 响应读取上限 16MB。 */
const OCR_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** server/ocr.ts:21 单页最多 1000 个文本区域。 */
const OCR_MAX_REGIONS = 1000;
/** server/ocr.ts:121 轮询间隔 5s；:148 最多 120 次。 */
const OCR_POLL_INTERVAL_MS = 5000;
const OCR_MAX_POLL_ATTEMPTS = 120;
/** server/ocrRoutes.ts:31 单次识别 300s 超时。 */
const OCR_TIMEOUT_MS = 300000;
/** server/ocrRoutes.ts:23 并发闸门：全局 4、单用户 2。 */
const OCR_MAX_CONCURRENCY = 4;
const OCR_MAX_USER_CONCURRENCY = 2;
/** server/ocrRoutes.ts:18 能力上报里的模式枚举。 */
const OCR_MODES = Object.freeze(["detect", "recognize"]);

/** 下行事件通道：与 preload 的 ocr.onEvent / main.cjs 的 send 同名。 */
const OCR_EVENT_CHANNEL = "ocr:event";
const OCR_EVENT_DOMAIN = "ocr";

/** 本域自有错误码；与其它域并列，不合并。 */
const OCR_ERR_COMMAND_NOT_ALLOWED = "OCR_COMMAND_NOT_ALLOWED";
const OCR_ERR_INVALID_INPUT = "OCR_INVALID_INPUT";
const OCR_ERR_UNAUTHENTICATED = "OCR_UNAUTHENTICATED";
const OCR_ERR_FORBIDDEN = "OCR_FORBIDDEN";
const OCR_ERR_UNAVAILABLE = "OCR_UNAVAILABLE";
const OCR_ERR_BUSY = "OCR_BUSY";
const OCR_ERR_DEPENDENCY_UNAVAILABLE = "OCR_DEPENDENCY_UNAVAILABLE";
const OCR_ERR_TIMEOUT = "OCR_TIMEOUT";
const OCR_ERR_CANCELLED = "OCR_CANCELLED";
const OCR_ERR_PROVIDER_FAILED = "OCR_PROVIDER_FAILED";
const OCR_ERR_INTERNAL = "OCR_INTERNAL";

const OCR_ERROR_CODES = Object.freeze([
  OCR_ERR_COMMAND_NOT_ALLOWED,
  OCR_ERR_INVALID_INPUT,
  OCR_ERR_UNAUTHENTICATED,
  OCR_ERR_FORBIDDEN,
  OCR_ERR_UNAVAILABLE,
  OCR_ERR_BUSY,
  OCR_ERR_DEPENDENCY_UNAVAILABLE,
  OCR_ERR_TIMEOUT,
  OCR_ERR_CANCELLED,
  OCR_ERR_PROVIDER_FAILED,
  OCR_ERR_INTERNAL,
]);

/**
 * ocr:command 白名单。
 *   risk       read | use | manage | destructive（与 media-domain.cjs:153 同级定义）
 *   credential 该命令是否会把真实凭据带进执行路径
 *   summary    中文一句话，供 UI 与审计展示
 * 两条命令对应源 ocrRoutes.ts:16（GET /api/ocr/providers）与 :21（POST /api/ocr/recognize）。
 */
const OCR_COMMANDS = Object.freeze({
  "ocr/providers": { risk: "read", credential: false, summary: "上报 OCR 可用供应商与上限（32MB / 24M 像素 / boundingBoxes / detect+recognize）" },
  "ocr/recognize": { risk: "use", credential: true, summary: "图片字节进、OcrResult 出（PaddleOCR-VL 异步任务提交+轮询）" },
});

const RISK_LEVELS = Object.freeze({ read: 0, use: 1, manage: 2, destructive: 3 });

function isOcrCommand(command) {
  return typeof command === "string" && Object.prototype.hasOwnProperty.call(OCR_COMMANDS, command);
}

function ocrCommandEntry(command) {
  return isOcrCommand(command) ? OCR_COMMANDS[command] : null;
}

function ocrCommandRisk(command) {
  const entry = ocrCommandEntry(command);
  return entry ? entry.risk : null;
}

function ocrCommandRequiresCredential(command) {
  const entry = ocrCommandEntry(command);
  return !!(entry && entry.credential);
}

/** 稳定顺序的命令清单；credential 在 IPC 投影改名 needsCredential（dxos-foundation-mask.cjs:12 会把含 credential 的键掩码）。 */
function listOcrCommands() {
  return Object.keys(OCR_COMMANDS).map((command) => ({
    command,
    risk: OCR_COMMANDS[command].risk,
    needsCredential: OCR_COMMANDS[command].credential,
    summary: OCR_COMMANDS[command].summary,
  }));
}

// ---------------------------------------------------------------------------
// 响应归一化（源 server/ocr.ts:9-64 逐行移植）
// ---------------------------------------------------------------------------

const record = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
/** server/ocr.ts:6：去 HTML 标签、trim、截断 100000。 */
const cleanText = (value) => (typeof value === "string" ? value.replace(/<[^>]*>/g, "").trim().slice(0, 100000) : "");
/** server/ocr.ts:7：仅接受 #rrggbb。 */
const color = (value) => (typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value : undefined);

/**
 * 源 server/ocr.ts:9-64。把 PaddleOCR / PP-StructureV3 的多种响应形状折叠为 OcrResult：
 *   · 页数组键：layoutParsingResults / layout_parsing_results / pages / res_list（源 :13），
 *     都没有时退化成把 result 本身当一页（源 :14）；
 *   · prunedResult / pruned_result / res / 自身（源 :17）；
 *   · overall_ocr_res.rec_texts+rec_polys（源 :52-55）或 parsing_res_list / blocks / items（源 :57-58）；
 *   · bbox 支持 [x1,y1,x2,y2] / [[x,y]...] / 扁平 [x,y,...] / {x,y,width,height}（源 :26-34）；
 *   · 归一化坐标（全 0..1）按目标宽高还原，否则按源图尺寸缩放（源 :36-37）；
 *   · errorCode 非 0 抛错（源 :11）。
 * 抛错用本域错误码包装，保留源文案。
 */
function normalizePaddleOcr(payload, width, height) {
  const response = record(payload);
  if (response.errorCode !== undefined && Number(response.errorCode) !== 0) {
    throw createOcrError(OCR_ERR_PROVIDER_FAILED, "PaddleOCR 服务返回识别错误，请检查服务配置或额度");
  }
  const result = record(response.result || response);
  const rawPages = result.layoutParsingResults || result.layout_parsing_results || result.pages || result.res_list;
  const pages = Array.isArray(rawPages) && rawPages.length ? rawPages : [result];
  const regions = [];
  for (const page of pages.slice(0, 1)) {
    const p = record(page);
    const pruned = record(p.prunedResult || p.pruned_result || p.res || p);
    const sw = Number(pruned.width) > 0 ? Number(pruned.width) : width;
    const sh = Number(pruned.height) > 0 ? Number(pruned.height) : height;
    const add = (value) => {
      if (regions.length >= OCR_MAX_REGIONS) return;
      const item = record(value);
      const text = cleanText(item.block_content !== undefined ? item.block_content : item.text !== undefined ? item.text : item.rec_text !== undefined ? item.rec_text : item.content);
      if (!text || /^(image|figure|picture|seal)$/i.test(String(item.block_label || item.label || ""))) return;
      const raw = item.block_bbox !== undefined ? item.block_bbox : item.bbox !== undefined ? item.bbox : item.box !== undefined ? item.box : item.poly !== undefined ? item.poly : item.points;
      let points = [];
      if (Array.isArray(raw)) {
        if (raw.length === 4 && raw.every((v) => Number.isFinite(Number(v)))) points = [[Number(raw[0]), Number(raw[1])], [Number(raw[2]), Number(raw[3])]];
        else if (raw.every((v) => Array.isArray(v))) points = raw.map((v) => [Number(v[0]), Number(v[1])]);
        else if (raw.length >= 8 && raw.length % 2 === 0) points = Array.from({ length: raw.length / 2 }, (_, i) => [Number(raw[i * 2]), Number(raw[i * 2 + 1])]);
      } else {
        const b = record(raw);
        const x = Number(b.x !== undefined ? b.x : b.left);
        const y = Number(b.y !== undefined ? b.y : b.top);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          points = [
            [x, y],
            [
              Number(b.right !== undefined ? b.right : x + Number(b.width !== undefined ? b.width : b.w)),
              Number(b.bottom !== undefined ? b.bottom : y + Number(b.height !== undefined ? b.height : b.h)),
            ],
          ];
        }
      }
      if (points.length < 2 || points.some((point) => point.some((v) => !Number.isFinite(v)))) return;
      const normalized = points.every((point) => point.every((v) => v >= 0 && v <= 1));
      points = points.map(([x, y]) => [
        Math.max(0, Math.min(width, x * (normalized ? width : width / sw))),
        Math.max(0, Math.min(height, y * (normalized ? height : height / sh))),
      ]);
      const x = Math.min(...points.map((point) => point[0]));
      const y = Math.min(...points.map((point) => point[1]));
      const w = Math.max(...points.map((point) => point[0])) - x;
      const h = Math.max(...points.map((point) => point[1])) - y;
      if (w < 1 || h < 1) return;
      if (regions.some((region) => region.text === text && Math.abs(region.bbox.x - x) < 2 && Math.abs(region.bbox.y - y) < 2)) return;
      const score = Number(item.confidence !== undefined ? item.confidence : item.score !== undefined ? item.score : item.rec_score);
      const style = record(item.style);
      const fontSize = Number(item.font_size !== undefined ? item.font_size : style.fontSize !== undefined ? style.fontSize : style.font_size);
      const fontFamily = cleanText(item.font_family !== undefined ? item.font_family : style.fontFamily !== undefined ? style.fontFamily : style.font_family).slice(0, 120) || undefined;
      const fontColor = color(item.font_color !== undefined ? item.font_color : style.color !== undefined ? style.color : item.color);
      const apiFontSize = fontSize > 0 && fontSize < 2000;
      regions.push({
        id: "ocr-" + regions.length,
        text,
        bbox: { x, y, width: w, height: h },
        polygon: points.length > 2 ? points : undefined,
        confidence: Number.isFinite(score) && score >= 0 ? Math.min(100, score <= 1 ? score * 100 : score) : undefined,
        style: {
          color: fontColor,
          colorSource: fontColor ? "api" : undefined,
          fontFamily,
          fontSize: apiFontSize ? fontSize : Math.max(8, (h / Math.max(1, text.split("\n").length)) * 0.85),
          fontSizeSource: apiFontSize ? "api" : "estimated",
        },
      });
    };
    const ocr = record(pruned.overall_ocr_res || pruned.overallOcrRes);
    const texts = ocr.rec_texts || ocr.recTexts;
    const boxes = ocr.rec_polys || ocr.rec_boxes || ocr.dt_polys || ocr.recPolys;
    if (Array.isArray(texts) && Array.isArray(boxes)) {
      texts.forEach((text, index) => add({ text, poly: boxes[index], score: ocr.rec_scores ? ocr.rec_scores[index] : undefined }));
    }
    if (!regions.length) {
      const items = pruned.parsing_res_list || pruned.parsingResList || pruned.blocks || pruned.items || [];
      if (Array.isArray(items)) items.forEach(add);
    }
  }
  const page = record(pages[0]);
  const markdown = typeof result.markdown === "string" ? result.markdown : record(result.markdown).text || record(page.markdown).text;
  return {
    width,
    height,
    regions,
    text: regions.length ? regions.map((region) => region.text).join("\n") : cleanText(result.text || markdown),
    engine: OCR_ENGINE,
  };
}

// ---------------------------------------------------------------------------
// 请求地址构造（源 server/ocr.ts:88-132）
// ---------------------------------------------------------------------------

/** 源 server/ocr.ts:88-96：非 HTTPS / 带账号 / 查询 / hash 一律拒绝；旧版部署改道官方 jobs API。 */
function paddleOcrJobUrl(baseUrl) {
  let endpoint;
  try {
    endpoint = new URL(String(baseUrl == null ? "" : baseUrl));
  } catch {
    throw createOcrError(OCR_ERR_INVALID_INPUT, "OCR 服务地址必须为不带账号、查询参数的 HTTPS 地址");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw createOcrError(OCR_ERR_INVALID_INPUT, "OCR 服务地址必须为不带账号、查询参数的 HTTPS 地址");
  }
  // 源 :91-93：旧版 AIStudio 部署与 /layout-parsing 路径保留凭据但改道官方 jobs API。
  if (endpoint.hostname === "n1vetck2y2l078qb.aistudio-app.com" || endpoint.pathname.replace(/\/+$/, "") === "/layout-parsing") {
    endpoint = new URL(OCR_BASE_URL);
  } else if (!endpoint.pathname.replace(/\/+$/, "").endsWith("/api/v2/ocr/jobs")) {
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, "") + "/api/v2/ocr/jobs";
  }
  return endpoint;
}

/** 源 server/ocr.ts:97-106：只做配置检查，不联网验证 Key 或额度（不提交收费任务）。 */
function verifyPaddleOcrConfiguration(provider) {
  const value = record(provider);
  paddleOcrJobUrl(value.base_url);
  if (!String(value.api_key == null ? "" : value.api_key).trim()) {
    throw createOcrError(OCR_ERR_INVALID_INPUT, "缺少 AIStudio Access Token");
  }
  return {
    protocol: OCR_PROTOCOL,
    changed: false,
    verification: "configuration",
    attempts: [{ protocol: OCR_PROTOCOL, ok: true, message: "OCR 配置检查通过；未联网验证 Key 或额度，实际识别时验证，不提交收费任务。" }],
    models: [OCR_MODEL],
    model_items: [{ model: OCR_MODEL, name: "PP-StructureV3 文字与版面识别", type: "other", protocol: OCR_PROTOCOL }],
  };
}

/** 源 server/ocr.ts:126-132：结果下载地址只允许百度域名白名单，且必须是 HTTPS/443/无账号。 */
function paddleResultUrl(value) {
  let url;
  try {
    url = new URL(String(value == null ? "" : value));
  } catch {
    throw createOcrError(OCR_ERR_PROVIDER_FAILED, "OCR 结果下载地址不受信任，已停止下载");
  }
  const host = url.hostname.toLowerCase();
  const trusted = ["bcebos.com", "baidubce.com", "aistudio-app.com", "aistudio.baidu.com"].some((suffix) => host === suffix || host.endsWith("." + suffix));
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || !trusted) {
    throw createOcrError(OCR_ERR_PROVIDER_FAILED, "OCR 结果下载地址不受信任，已停止下载");
  }
  return url;
}

// ---------------------------------------------------------------------------
// 错误规约（与 dxos-foundation-errors.cjs 同形）
// ---------------------------------------------------------------------------

function createOcrError(code, message, detail) {
  const err = new Error(foundationErrors.redactText(message == null ? code : message));
  err.name = "OcrError";
  err.code = OCR_ERROR_CODES.includes(code) ? code : OCR_ERR_INTERNAL;
  err.detail = detail === undefined ? undefined : foundationErrors.redactValue(detail);
  return err;
}

function isOcrError(err) {
  return !!err && typeof err === "object" && typeof err.code === "string" && OCR_ERROR_CODES.includes(err.code);
}

function redactOcrValue(value) {
  return foundationErrors.redactValue(value);
}

function normalizeOcrError(err) {
  if (isOcrError(err)) {
    const out = { ok: false, error: err.code, message: foundationErrors.redactText(err.message || err.code) || err.code };
    if (err.detail !== undefined) out.detail = foundationErrors.redactValue(err.detail);
    return out;
  }
  return foundationErrors.normalizeError(err, { fallbackCode: foundationErrors.DXOS_ERR_INTERNAL });
}

function ocrCommandNotAllowed(command) {
  return createOcrError(OCR_ERR_COMMAND_NOT_ALLOWED, "未知或未授权的 ocr 命令：" + String(command == null ? "" : command), {
    command: command == null ? null : String(command),
  });
}

/** 渲染层出口：成功 { ok:true, value }；失败 normalizeOcrError。 */
async function toOcrIpcResult(action) {
  try {
    const value = typeof action === "function" ? await action() : await action;
    return { ok: true, value: redactOcrValue(value) };
  } catch (err) {
    return normalizeOcrError(err);
  }
}

/**
 * 无可用供应商时的结构化不可用提示（源 ocrRoutes.ts:36 文案 + shared/ocr.ts:17-21 的配置四要素）。
 * 必须能回答"怎么配"，绝不假成功。
 */
const OCR_CONFIG_HINT =
  "在「系统设置 › 模型与服务商」新建供应商：base_url 填 " + OCR_BASE_URL + "，协议填 " + OCR_PROTOCOL +
  "，模型填 " + OCR_MODEL + "（或 " + OCR_LEGACY_MODEL + "），密钥填 AIStudio Access Token（" + OCR_KEY_URL + "），并勾选启用。";

module.exports = {
  OCR_PROTOCOL,
  OCR_MODEL,
  OCR_LEGACY_MODEL,
  OCR_BASE_URL,
  OCR_KEY_URL,
  OCR_ENGINE,
  OCR_MAX_BYTES,
  OCR_MAX_PIXELS,
  OCR_MAX_RESPONSE_BYTES,
  OCR_MAX_REGIONS,
  OCR_POLL_INTERVAL_MS,
  OCR_MAX_POLL_ATTEMPTS,
  OCR_TIMEOUT_MS,
  OCR_MAX_CONCURRENCY,
  OCR_MAX_USER_CONCURRENCY,
  OCR_MODES,
  OCR_EVENT_CHANNEL,
  OCR_EVENT_DOMAIN,
  OCR_COMMANDS,
  OCR_ERROR_CODES,
  OCR_ERR_COMMAND_NOT_ALLOWED,
  OCR_ERR_INVALID_INPUT,
  OCR_ERR_UNAUTHENTICATED,
  OCR_ERR_FORBIDDEN,
  OCR_ERR_UNAVAILABLE,
  OCR_ERR_BUSY,
  OCR_ERR_DEPENDENCY_UNAVAILABLE,
  OCR_ERR_TIMEOUT,
  OCR_ERR_CANCELLED,
  OCR_ERR_PROVIDER_FAILED,
  OCR_ERR_INTERNAL,
  OCR_CONFIG_HINT,
  RISK_LEVELS,
  isOcrCommand,
  ocrCommandEntry,
  ocrCommandRisk,
  ocrCommandRequiresCredential,
  listOcrCommands,
  record,
  cleanText,
  color,
  normalizePaddleOcr,
  paddleOcrJobUrl,
  verifyPaddleOcrConfiguration,
  paddleResultUrl,
  createOcrError,
  isOcrError,
  redactOcrValue,
  normalizeOcrError,
  ocrCommandNotAllowed,
  toOcrIpcResult,
};
