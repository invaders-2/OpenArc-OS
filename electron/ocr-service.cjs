/**
 * DX OS 0.6.1 · OCR 服务（唯一执行层）：供应商选择 + 并发闸门 + 300s 超时 + 32MB 上限 +
 * requestPaddleOcr 异步任务（提交→轮询→下载 JSONL→normalize）+ 下行事件。
 *
 * 为什么单独一层：ocr-domain.cjs 只做纯逻辑；本文件承担 I/O（fetch / 惰性 sharp / 凭据解析 / 计时 / 闸门），
 * 并把供应商选择接在**既有** electron/provider-protocol-store.cjs（providers.json + safeStorage）上，
 * 不新建供应商存储（源 ocrRoutes.ts:4,14 的 allProviders / protocol 过滤同义）。
 *
 * 源行号：
 *   · server/ocr.ts:66-86    estimateColors（颜色估计，sharp 缺失即跳过而非假颜色）
 *   · server/ocr.ts:107-125  responseText / json / waitForPoll
 *   · server/ocr.ts:133-169  requestPaddleOcr（multipart 提交 + bearer + 轮询 + JSONL 下载）
 *   · server/ocrRoutes.ts:10-15 并发闸门 + options()（apiQuota / apiModelAccessFilter 为云能力，OUT）
 *   · server/ocrRoutes.ts:16-19 GET /api/ocr/providers
 *   · server/ocrRoutes.ts:21-44 POST /api/ocr/recognize
 *
 * 与源的既定差异（任务书 OUT 范围）：
 *   · 不实现 apiModelAccessFilter / withApiQuotaActor / withDirectApiQuota（云计费配额）；
 *   · requestPaddleOcr 返回 { result, converted }（多带 converted 以便按既有 base64url 约定
 *     可选回传预处理 PNG，见 encodeBinary）；源只返回 OcrResult。
 */
"use strict";

const domain = require("./ocr-domain.cjs");
const modelDomain = require("./model-domain.cjs");
const providerDomain = require("./provider-protocol-domain.cjs");
const { createEventChannel } = require("./dxos-foundation-events.cjs");

/**
 * 是否必须密钥：复用既有 electron/provider-protocol-domain.cjs:174 providerRequiresApiKey
 * （源 protocols.ts:3595）。未知协议按"需要密钥"处理，与 electron/provider-adapter-bridge.cjs:52-59 同口径，
 * 绝不放行一个无法鉴权的站点。实测 paddleocr-vl → true。
 */
function protocolRequiresKey(protocol) {
  try {
    return providerDomain.providerRequiresApiKey(protocol) !== false;
  } catch {
    return true;
  }
}

/**
 * 惰性解析 sharp：任务铁律要求 sharp 不能是直接依赖。
 * 源 server/ocr.ts:1,135,68 用 sharp 做 rotate→png 与颜色采样；缺依赖时回结构化不可用，绝不用假图兜底。
 * 测试/宿主可用 options.sharpLoader 注入同形实现（见 requestPaddleOcr 的调用面）。
 */
function resolveSharp(sharpLoader) {
  if (typeof sharpLoader === "function") {
    try {
      const loaded = sharpLoader();
      if (loaded) return loaded;
    } catch {
      /* 注入的加载器失败 → 落到下面的结构化不可用 */
    }
  }
  try {
    return require("sharp");
  } catch {
    throw domain.createOcrError(
      domain.OCR_ERR_DEPENDENCY_UNAVAILABLE,
      "sharp 未安装，无法把图片转换为 PNG 后再提交 PaddleOCR",
      { dependency: "sharp", hint: "安装 sharp 后重试，或由宿主注入 sharpLoader；纯服务端能力，不影响其它 OCR 命令。" },
    );
  }
}

/** 源 server/ocr.ts:107-116：非 2xx / 无 body / 超过 16MB 都回结构化失败。 */
async function responseText(response, label) {
  if (!response || response.ok !== true) {
    if (response && response.body && typeof response.body.cancel === "function") {
      await response.body.cancel().catch(() => {});
    }
    throw domain.createOcrError(domain.OCR_ERR_PROVIDER_FAILED, label + "失败（HTTP " + String(response && response.status) + "），请检查 Key、接口和额度");
  }
  const reader = response.body && typeof response.body.getReader === "function" ? response.body.getReader() : null;
  if (!reader) throw domain.createOcrError(domain.OCR_ERR_PROVIDER_FAILED, label + "响应为空");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > domain.OCR_MAX_RESPONSE_BYTES) throw domain.createOcrError(domain.OCR_ERR_PROVIDER_FAILED, "OCR 服务响应过大");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 源 server/ocr.ts:117：非 JSON 回结构化失败，不把 SyntaxError 漏出去。 */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw domain.createOcrError(domain.OCR_ERR_PROVIDER_FAILED, "OCR 服务没有返回有效 JSON");
  }
}

/** 源 server/ocr.ts:118-125：轮询间隔 5s，可被 signal 取消。 */
function waitForPoll(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("已取消", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, domain.OCR_POLL_INTERVAL_MS);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** 源 server/ocr.ts:66-86：从 ROI 采样估计文字颜色（明确是估计，不是 OCR 承诺）。 */
async function estimateColors(sharp, image, result) {
  const raw = await sharp(image)
    .resize({ width: 1400, height: 1400, fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const data = raw.data;
  const info = raw.info;
  const sx = info.width / result.width;
  const sy = info.height / result.height;
  for (const region of result.regions.slice(0, 300)) {
    if (region.style && region.style.color) continue;
    const left = Math.floor(region.bbox.x * sx);
    const top = Math.floor(region.bbox.y * sy);
    const right = Math.min(info.width, Math.ceil((region.bbox.x + region.bbox.width) * sx));
    const bottom = Math.min(info.height, Math.ceil((region.bbox.y + region.bbox.height) * sy));
    const step = Math.max(1, Math.floor(Math.max(right - left, bottom - top) / 96));
    const histogram = new Map();
    let samples = 0;
    for (let y = top; y < bottom; y += step) {
      for (let x = left; x < right; x += step) {
        const index = (y * info.width + x) * info.channels;
        const rgb = [data[index], data[index + 1], data[index + 2]].map((v) => Math.min(255, Math.round(v / 32) * 32));
        const key = rgb.join(",");
        histogram.set(key, (histogram.get(key) || 0) + 1);
        samples += 1;
      }
    }
    const ranked = [...histogram].sort((a, b) => b[1] - a[1]);
    const background = ranked[0] ? ranked[0][0].split(",").map(Number) : null;
    const foreground = ranked.find(([key, count]) =>
      count >= samples * 0.025 && background && key.split(",").map(Number).reduce((sum, v, i) => sum + Math.abs(v - background[i]), 0) > 150,
    );
    if (foreground) {
      region.style = {
        ...region.style,
        color: "#" + foreground[0].split(",").map((v) => Number(v).toString(16).padStart(2, "0")).join(""),
        colorSource: "estimated",
      };
    }
  }
}

/**
 * 源 server/ocr.ts:133-169。请求构造：
 *   · bearer Authorization（源 :138，注意源是小写 bearer）；
 *   · FormData：model / optionalPayload / file（PNG Blob，文件名 image.png）（源 :139-142）；
 *   · 提交拿 jobId → 轮询 120 次 → 校验收到的 resultUrl 白名单 → 下载 JSONL 取第一行归一化（源 :144-166）。
 * 与源差异：返回 { result, converted }，converted = { data, info }（用于可选 base64url 预览出口）。
 *
 * @param opts.provider   { base_url, api_key }（base_url 已由调用方过 SSRF 校验）
 * @param opts.input      Buffer（渲染层图片字节；本函数内部用 sharp 转 PNG）
 * @param opts.signal     AbortSignal（300s 超时由 createOcrBundle 的计时器触发）
 * @param opts.fetcher    fetch 同形实现（测试注入）
 * @param opts.pause      轮询等待函数，默认 waitForPoll
 * @param opts.sharpLoader 惰性 sharp 解析器
 */
async function requestPaddleOcr({ provider, input, signal, fetcher = fetch, pause = waitForPoll, sharpLoader = null }) {
  const sharp = resolveSharp(sharpLoader);
  const endpoint = domain.paddleOcrJobUrl(provider.base_url);
  const converted = await sharp(input, { limitInputPixels: domain.OCR_MAX_PIXELS, animated: false }).rotate().png().toBuffer({ resolveWithObject: true });
  if (converted.data.length > domain.OCR_MAX_BYTES) {
    throw domain.createOcrError(domain.OCR_ERR_INVALID_INPUT, "图片转换后超过 32 MB，请缩小图片");
  }
  signal.throwIfAborted();
  const headers = { Authorization: "bearer " + String(provider.api_key == null ? "" : provider.api_key) };
  const body = new FormData();
  body.append("model", domain.OCR_MODEL);
  // 源 :141：关闭方向分类 / 去畸变 / 图表识别，避免额外收费与不确定性。
  body.append("optionalPayload", JSON.stringify({ useDocOrientationClassify: false, useDocUnwarping: false, useChartRecognition: false }));
  body.append("file", new Blob([new Uint8Array(converted.data)], { type: "image/png" }), "image.png");
  const response = await fetcher(endpoint, { method: "POST", redirect: "error", signal, headers, body });
  const submitted = domain.record(parseJson(await responseText(response, "提交 OCR 任务")));
  const jobId = String(domain.record(submitted.data).jobId || "");
  if (!jobId || jobId.length > 256) throw domain.createOcrError(domain.OCR_ERR_PROVIDER_FAILED, "OCR 服务未返回任务 ID，请检查服务版本");
  let resultUrl;
  for (let attempt = 0; attempt < domain.OCR_MAX_POLL_ATTEMPTS; attempt++) {
    signal.throwIfAborted();
    const statusResponse = await fetcher(endpoint.href.replace(/\/+$/, "") + "/" + encodeURIComponent(jobId), { headers, signal, redirect: "error" });
    const status = domain.record(domain.record(parseJson(await responseText(statusResponse, "查询 OCR 任务"))).data);
    if (status.state === "done") {
      resultUrl = domain.paddleResultUrl(domain.record(status.resultUrl).jsonUrl);
      break;
    }
    if (status.state === "failed") throw domain.createOcrError(domain.OCR_ERR_PROVIDER_FAILED, "云端 OCR 任务失败，请检查文件格式、服务额度或到 AIStudio 查看任务");
    if (!["pending", "running"].includes(status.state)) throw domain.createOcrError(domain.OCR_ERR_PROVIDER_FAILED, "OCR 服务返回未知任务状态");
    await pause(signal);
  }
  if (!resultUrl) throw domain.createOcrError(domain.OCR_ERR_TIMEOUT, "OCR 任务等待超时，云端可能仍在处理，请勿立即重复提交");
  // 源 :158-160：结果地址可带签名 query，绝不把 API token 发给对象存储，也不跟随重定向。
  const resultResponse = await fetcher(resultUrl, { signal, redirect: "error" });
  const jsonl = await responseText(resultResponse, "下载 OCR 结果");
  const lines = jsonl.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw domain.createOcrError(domain.OCR_ERR_PROVIDER_FAILED, "OCR 任务完成但结果为空");
  const result = domain.normalizePaddleOcr(parseJson(lines[0]), converted.info.width, converted.info.height);
  if (!result.text && !result.regions.length) {
    throw domain.createOcrError(domain.OCR_ERR_PROVIDER_FAILED, "OCR 没有返回可解析的文字，请核对图片内容及任务结果格式");
  }
  // 源 :167 颜色估计必定执行；sharp 在此已被解析，属真实能力，缺失时上面就回依赖不可用。
  await estimateColors(sharp, converted.data, result);
  signal.throwIfAborted();
  return { result, converted };
}

/**
 * 源 ocrRoutes.ts:10-25 的并发闸门：全局 active>=4 或该用户>=2 即拒绝（HTTP 429 → OCR_BUSY）。
 * 纯内存、进程内，不落盘、不做计费。
 */
function createOcrGate({ maxActive = domain.OCR_MAX_CONCURRENCY, maxPerUser = domain.OCR_MAX_USER_CONCURRENCY } = {}) {
  let active = 0;
  const activeUsers = new Map();
  return {
    maxActive,
    maxPerUser,
    tryAcquire(userKey) {
      const key = String(userKey == null ? "" : userKey);
      if (active >= maxActive || (activeUsers.get(key) || 0) >= maxPerUser) return null;
      active += 1;
      activeUsers.set(key, (activeUsers.get(key) || 0) + 1);
      let released = false;
      return {
        userKey: key,
        release() {
          if (released) return;
          released = true;
          active -= 1;
          const count = (activeUsers.get(key) || 1) - 1;
          if (count) activeUsers.set(key, count);
          else activeUsers.delete(key);
        },
      };
    },
    snapshot() {
      return { active, users: activeUsers.size };
    },
  };
}

/**
 * 源 ocrRoutes.ts:37 的二进制出口约定：base64url 不含 "/"，绕开 foundation 的绝对路径替换
 * （electron/media-service.cjs:367-369 同一实现）。
 */
function encodeBinary(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

/**
 * 源 ocrRoutes.ts:26-34 的入口：渲染层图片字节。源是 multipart 字段 image；
 * 移植侧沿用既有 IPC 载荷约定（media-service.cjs:350-364）：dataUrl / image / base64 / data / bytes。
 */
function decodeOcrImage(payload) {
  const body = payload && typeof payload === "object" ? payload : {};
  let value = body.dataUrl;
  if (value === undefined || value === null) value = body.image;
  if (value === undefined || value === null) value = body.base64;
  if (value === undefined || value === null) value = body.data;
  let buffer = null;
  if (value !== undefined && value !== null) {
    if (typeof value !== "string") throw domain.createOcrError(domain.OCR_ERR_INVALID_INPUT, "OCR 图片载荷必须是 base64 文本");
    const text = value.startsWith("data:") && value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
    const compact = text.replace(/\s+/g, "");
    if (!compact || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) throw domain.createOcrError(domain.OCR_ERR_INVALID_INPUT, "OCR 图片载荷不是有效的 base64");
    buffer = Buffer.from(compact, "base64url");
  } else if (Buffer.isBuffer(body.bytes)) {
    buffer = Buffer.from(body.bytes);
  } else if (Array.isArray(body.bytes) && body.bytes.length && body.bytes.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
    buffer = Buffer.from(body.bytes);
  }
  if (!buffer || !buffer.length) throw domain.createOcrError(domain.OCR_ERR_INVALID_INPUT, "请选择图片（字段：image / base64 / dataUrl / data / bytes）");
  if (buffer.length > domain.OCR_MAX_BYTES) throw domain.createOcrError(domain.OCR_ERR_INVALID_INPUT, "OCR 上传失败，图片不能超过 32 MB");
  return buffer;
}

/**
 * 创建 OCR bundle。
 * @param options.providerStore  ProviderProtocolStore（electron/provider-protocol-store.cjs:75）——唯一供应商来源
 * @param options.fetchImpl      网络实现，默认全局 fetch
 * @param options.sharpLoader    惰性 sharp 解析器，默认 require("sharp")
 * @param options.authorization  可选：{ resolveActor }，注入后用户身份取自可信 sessionRef（同 media-service.cjs:1069）
 * @param options.gate           可选：并发闸门（测试注入/复用）
 * @param options.timeoutMs      单次识别超时，默认 300000（源 ocrRoutes.ts:31）
 * @param options.pause          轮询等待函数（测试注入，避免真等 5s）
 */
function createOcrBundle(options = {}) {
  const providerStore = options.providerStore || null;
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : fetch;
  const sharpLoader = typeof options.sharpLoader === "function" ? options.sharpLoader : null;
  const authorization = options.authorization || null;
  const gate = options.gate || createOcrGate();
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const logger = typeof options.logger === "function" ? options.logger : null;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Number(options.timeoutMs)) : domain.OCR_TIMEOUT_MS;
  const pause = typeof options.pause === "function" ? options.pause : waitForPoll;
  const eventChannel = createEventChannel({ domain: domain.OCR_EVENT_DOMAIN, clock });
  let sink = null;

  function setEventSink(fn) {
    sink = typeof fn === "function" ? fn : null;
    return !!sink;
  }

  function emit(kind, payload) {
    const event = eventChannel[kind](payload);
    if (sink) {
      try {
        sink(event);
      } catch {
        /* 下行失败不改变业务结果（同 media-service.cjs 事件口径） */
      }
    }
    return event;
  }

  /** 源 ocrRoutes.ts:12-15 options()：协议 + 启用 + 有 Key + 模型命中（apiModelAccessFilter 为云能力，OUT）。 */
  function usableProviders() {
    if (!providerStore || typeof providerStore.listPublic !== "function") return [];
    let list = [];
    try {
      list = providerStore.listPublic() || [];
    } catch {
      list = [];
    }
    return list.filter((provider) =>
      provider && provider.protocol === domain.OCR_PROTOCOL && provider.enabled !== false &&
      (!protocolRequiresKey(provider.protocol) || provider.has_key === true) &&
      Array.isArray(provider.models) && provider.models.some((model) => model && (model.model === domain.OCR_MODEL || model.model === domain.OCR_LEGACY_MODEL)),
    );
  }

  function listProviders() {
    return usableProviders().map((provider) => ({ id: provider.id, name: provider.name }));
  }

  /** 源 ocrRoutes.ts:34-38：显式 providerId 优先，否则第一个可用；没有则结构化不可用（含"怎么配"）。 */
  function resolveProvider(providerId) {
    const usable = usableProviders();
    const id = providerId == null ? "" : String(providerId);
    const chosen = id ? usable.find((provider) => provider.id === id) : usable[0];
    if (!chosen) {
      throw domain.createOcrError(domain.OCR_ERR_UNAVAILABLE, "请先在「系统设置 › 模型与服务商」中添加并启用 PaddleOCR 平台，或检查该账号的模型权限", {
        hint: domain.OCR_CONFIG_HINT,
        protocol: domain.OCR_PROTOCOL,
        model: domain.OCR_MODEL,
        keyUrl: domain.OCR_KEY_URL,
      });
    }
    const internal = typeof providerStore.get === "function" ? providerStore.get(chosen.id) : null;
    if (!internal || !internal.api_key) {
      throw domain.createOcrError(domain.OCR_ERR_UNAVAILABLE, "PaddleOCR 供应商缺少 AIStudio Access Token，请补充密钥", {
        hint: domain.OCR_CONFIG_HINT,
        keyUrl: domain.OCR_KEY_URL,
        providerId: chosen.id,
      });
    }
    return { provider: { id: chosen.id, name: chosen.name, base_url: internal.base_url, api_key: internal.api_key } };
  }

  /** 源 ocrRoutes.ts:16-19 GET /api/ocr/providers。 */
  function providers() {
    const list = listProviders();
    return {
      available: list.length > 0,
      providers: list,
      local: false,
      maxBytes: domain.OCR_MAX_BYTES,
      maxPixels: domain.OCR_MAX_PIXELS,
      boundingBoxes: true,
      modes: domain.OCR_MODES.slice(),
      protocol: domain.OCR_PROTOCOL,
      model: domain.OCR_MODEL,
    };
  }

  /** 源 ocrRoutes.ts:21-44 POST /api/ocr/recognize（网关→上传→provider→300s→归一化）。 */
  async function recognize(payload, context) {
    // 源 :23 先查闸门，再解析上传体；这里同序，保证并发拒绝不会先做 HTTP 工作。
    const lease = gate.tryAcquire(context.userKey);
    if (!lease) {
      throw domain.createOcrError(domain.OCR_ERR_BUSY, "OCR 任务较多，请稍后重试", { maxActive: gate.maxActive, maxPerUser: gate.maxPerUser });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const image = decodeOcrImage(payload);
      const resolved = resolveProvider(payload && payload.providerId);
      // 源 ocr.ts:90 的地址约束之外，再走既有 SSRF 判定（model-domain.cjs:29）。
      const endpoint = modelDomain.validateEndpoint(resolved.provider.base_url, { allowLan: false });
      if (!endpoint.ok) {
        throw domain.createOcrError(domain.OCR_ERR_UNAVAILABLE, "OCR 服务地址不可用：" + String(endpoint.reason || endpoint.error), {
          hint: domain.OCR_CONFIG_HINT,
          providerId: resolved.provider.id,
        });
      }
      const output = await requestPaddleOcr({
        provider: resolved.provider,
        input: image,
        signal: controller.signal,
        fetcher: fetchImpl,
        pause,
        sharpLoader,
      });
      if (logger) {
        try {
          logger({ scope: "ocr", command: "ocr/recognize", providerId: resolved.provider.id, regions: output.result.regions.length, at: clock() });
        } catch {
          /* 审计失败不影响识别结果 */
        }
      }
      const result = { ...output.result };
      // 唯一的图片字节出口：base64url，避免 foundation 把 "/" 当绝对路径替换（media-service.cjs:367-369）。
      if (payload && payload.includeImage === true) {
        result.image = { mime: "image/png", bytes: output.converted.data.length, data: encodeBinary(output.converted.data) };
      }
      return result;
    } catch (error) {
      if (controller.signal.aborted) {
        throw domain.createOcrError(domain.OCR_ERR_TIMEOUT, "OCR 已取消或超时；云端可能仍在处理，取消不保证退款");
      }
      if (error && error.name === "AbortError") throw domain.createOcrError(domain.OCR_ERR_CANCELLED, "OCR 已取消");
      throw error;
    } finally {
      clearTimeout(timer);
      lease.release();
    }
  }

  async function dispatch(command, payload, context) {
    switch (command) {
      case "ocr/providers": return providers();
      case "ocr/recognize": return recognize(payload, context);
      default: throw domain.ocrCommandNotAllowed(command);
    }
  }

  /** sessionRef → userId；源 ocrRoutes.ts:9,22 requireAuth + req.auth.user.id。 */
  function resolveUserId(context) {
    if (authorization && typeof authorization.resolveActor === "function") {
      try {
        const result = authorization.resolveActor({ context });
        if (result && result.ok === true && result.user && result.user.id != null) return String(result.user.id);
      } catch {
        /* 授权服务异常 → 落到 sessionRef（fail closed 见下） */
      }
    }
    return context && context.sessionRef ? String(context.sessionRef) : null;
  }

  /** 唯一分发入口：白名单 → 身份 → dispatch → 脱敏；失败统一 normalizeOcrError。 */
  async function execute(command, payload, ctx = {}) {
    if (!domain.isOcrCommand(command)) return domain.normalizeOcrError(domain.ocrCommandNotAllowed(command));
    const context = {
      sessionRef: typeof (ctx && ctx.sessionRef) === "string" ? ctx.sessionRef.slice(0, 160) : null,
      requestId: typeof (ctx && ctx.requestId) === "string" ? ctx.requestId.slice(0, 100) : null,
    };
    const userId = resolveUserId(context);
    if (!userId) {
      emit("progress", { command, phase: "rejected", reason: "unauthenticated", requestId: context.requestId });
      return domain.normalizeOcrError(domain.createOcrError(domain.OCR_ERR_UNAUTHENTICATED, "当前会话未认证，ocr 命令被拒绝"));
    }
    context.userKey = userId;
    emit("progress", { command, phase: "begin", requestId: context.requestId });
    const body = payload && typeof payload === "object" ? payload : {};
    try {
      const value = await dispatch(command, body, context);
      emit("progress", { command, phase: "completed", requestId: context.requestId });
      return { ok: true, value: domain.redactOcrValue(value) };
    } catch (error) {
      emit("progress", { command, phase: "failed", requestId: context.requestId });
      return domain.normalizeOcrError(error);
    }
  }

  const dependencies = Object.freeze({
    providerStore: !!providerStore,
    fetchImpl: typeof fetchImpl === "function",
    sharpLoader: typeof sharpLoader === "function",
    authorization: !!authorization,
  });
  const dependencyNotes = Object.freeze({
    providerStore: providerStore ? null : "缺少 providerStore：注入 B2 provider-protocol-store 后 OCR 才能选到 PaddleOCR 供应商",
    fetchImpl: typeof fetchImpl === "function" ? null : "缺少 fetchImpl：无法调用 PaddleOCR",
    sharpLoader: typeof sharpLoader === "function" ? null : "未注入 sharpLoader：将惰性 require('sharp')，未安装时 ocr/recognize 回 OCR_DEPENDENCY_UNAVAILABLE",
    authorization: authorization ? null : "未注入 authorization：用户身份退回可信 sessionRef",
  });

  return {
    execute,
    setEventSink,
    emitEvent: emit,
    providers,
    listProviders,
    gate,
    timeoutMs,
    dependencies,
    dependencyNotes,
  };
}

module.exports = {
  createOcrBundle,
  createOcrGate,
  requestPaddleOcr,
  responseText,
  parseJson,
  waitForPoll,
  estimateColors,
  resolveSharp,
  protocolRequiresKey,
  encodeBinary,
  decodeOcrImage,
};
