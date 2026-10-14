/**
 * B5a · 媒体域装配 + media:command 分发（唯一执行入口）。
 *
 * 装配真实模块（不 mock、不新增依赖）：
 *   · media-store.cjs        电影项目 / 素材 / 渲染作业 + 封面缓存（configureMediaStore）
 *   · video-render-worker.cjs 受监督子进程：probe / poster / render / health
 *   · dxos-foundation-runner.cjs 超时 / 取消 / 输出上限 / 退出码归一化
 *   · dxos-foundation-events.cjs / dxos-foundation-errors.cjs 事件信封与脱敏
 *
 * 边界：
 *   · 渲染层自报的 userId / role / appId / sessionRef 一律忽略；actor 由 authorization.resolveActor
 *     从可信 sessionRef 推导（与 skill-service.cjs:216-225 同一条边界）。
 *   · <userData>/dxos/media 由 dxos-foundation-paths.cjs:18 统一登记；本文件不拼第二套路径。
 *   · 返回值统一过 media-domain.cjs 的 redactMediaValue —— 不含凭据、绝对值路径；
 *     所有投影只回相对文件名（硬约束："返回值不含绝对路径"）。
 *   · ffmpeg / ffprobe 未安装 → 子进程回 MEDIA_DEPENDENCY_UNAVAILABLE，本文件原样透出，
 *     绝不把"没跑成"包装成成功；sharp 只在探测图片素材时惰性 require，缺失同样结构化失败。
 *
 * 与源（server/video/videoWorker.ts）的差异：源 worker 在渲染循环里直接续租数据库租约；
 * 本实现把租约心跳放回**主进程**（worker 只回 progress 观测），并在租约丢失时取消子进程，
 * 因为数据库连接属于主进程，子进程不该持有它。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { resolveDxosPaths, ensureDxosLayout } = require("./dxos-foundation-paths.cjs");
const { createSupervisedRunner } = require("./dxos-foundation-runner.cjs");
const { createEventChannel } = require("./dxos-foundation-events.cjs");

const mediaDomain = require("./media-domain.cjs");
const mediaStore = require("./media-store.cjs");
const foundationErrors = require("./dxos-foundation-errors.cjs");

// B5e：媒体域剩余部分（逐文件移植；依赖全部经 configureMediaExtensions 注入，未注入即结构化不可用）
const mediaBackgroundRemoval = require("./media-background-removal.cjs");
const mediaAiDeclaration = require("./media-ai-image-declaration.cjs");
const mediaShortDrama = require("./media-short-drama.cjs");
const mediaLibrary = require("./media-library.cjs");
const mediaIllustrator = require("./media-illustrator.cjs");
const mediaFigmaPreview = require("./media-figma-preview.cjs");
const mediaDirector3D = require("./media-director3d.cjs");
const mediaPublicMedia = require("./media-public-media.cjs");
// B5f：providerStore 复用 B4 已经用过的 B2 只读桥（不新造协议层）。
const { createProviderAdapter } = require("./provider-adapter-bridge.cjs");

/**
 * B5e 依赖注入总线：一次调用把同一批依赖分发给 8 个子模块。
 * 任何一项缺失都不在这里兜底 —— 命令执行时各自回结构化 MEDIA_DEPENDENCY_UNAVAILABLE。
 */
function configureMediaExtensions(options) {
  const ext = options && typeof options === "object" ? options : {};
  const clock = typeof ext.clock === "function" ? ext.clock : undefined;
  mediaBackgroundRemoval.configureBackgroundRemoval({
    modelDir: ext.modelDir || null,
    modelPath: ext.modelPath || null,
    models: ext.models || undefined,
    onnxRuntime: ext.onnxRuntime || null,
    onnxSessionFactory: ext.onnxSessionFactory || null,
    sharpLoader: ext.sharpLoader || null,
  });
  mediaAiDeclaration.configureAiImageDeclaration({ sharpLoader: ext.sharpLoader || null });
  mediaShortDrama.configureShortDrama({
    dataDir: ext.dataDir || null,
    fsAdapter: ext.fsAdapter || null,
    fetchImpl: ext.fetchImpl || null,
    providerStore: ext.providerStore || null,
    modelGateway: ext.modelGateway || null,
    mediaStore: ext.mediaStore || null,
    renderSubmit: ext.renderSubmit || null,
    clock: clock,
    logger: ext.logger || null,
  });
  mediaLibrary.configureMediaLibrary({
    dataDir: ext.dataDir || null,
    fetchImpl: ext.fetchImpl || null,
    musicMetadataLoader: ext.musicMetadataLoader || null,
    clock: clock,
  });
  mediaIllustrator.configureIllustrator({
    dataDir: ext.dataDir || null,
    tmpDir: ext.tmpDir || null,
    illustratorAvailable: ext.illustratorAvailable === true,
    illustratorAdapter: ext.illustratorAdapter || null,
    clock: clock,
  });
  mediaFigmaPreview.configureFigmaPreview({
    dataDir: ext.dataDir || null,
    fetchImpl: ext.fetchImpl || null,
    viteBuild: ext.viteBuild || null,
    vuePlugin: ext.vuePlugin || null,
  });
  mediaDirector3D.configureDirector3D({
    dataDir: ext.dataDir || null,
    models: ext.director3dModels || undefined,
    modelCatalog: ext.director3dCatalog || null,
    clock: clock,
  });
  mediaPublicMedia.configurePublicMedia({ dataDir: ext.dataDir || null, sharpLoader: ext.sharpLoader || null, clock: clock });
  return { configured: true };
}

// ---------------------------------------------------------------------------
// B5f：媒体域扩展依赖的真实装配件（全部复用既有模块，不新造协议层 / 网络层）
// ---------------------------------------------------------------------------

/**
 * 短剧选模型的只读提供方面：把 B2 provider-protocol-store/service 投影成
 * firstUsableProvider(caps)（caps: "llm" | "image"）。
 * 复用 B4 已经在用的 provider-adapter-bridge.cjs:171 只读桥（绝不含 api_key），
 * 缺 store/service 即 null —— 命令侧继续 MEDIA_DEPENDENCY_UNAVAILABLE，绝不伪造。
 */
function createMediaProviderStore({ providerProtocol = null, providerAdapter = null } = {}) {
  let adapter = providerAdapter;
  if (!adapter && providerProtocol && providerProtocol.store && providerProtocol.service) {
    try { adapter = createProviderAdapter({ store: providerProtocol.store, service: providerProtocol.service }); }
    catch { adapter = null; }
  }
  if (!adapter || typeof adapter.firstUsable !== "function") return null;
  return Object.freeze({
    firstUsableProvider(caps) { return adapter.firstUsable(caps); },
    allProviders() { return typeof adapter.all === "function" ? adapter.all() : []; },
  });
}

/** 超时 → AbortSignal；未给合法 timeout 时不建 controller（沿用既有出口默认行为）。 */
async function withTimeoutSignal(timeoutMs, run) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return run(null);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.round(ms)));
  try { return await run(controller.signal); }
  finally { clearTimeout(timer); }
}

/**
 * B5f · B2 模型出口 → 短剧要的 modelGateway（callChat / generateImages / editImages）。
 * 三条路径全部走 provider-protocol-service 的既有出口（call / generateImage / legacyExecute），
 * 密钥只在 service 内部解出；这里只把落盘产物读成短剧能消费的 b64。
 * 未装配 provider-protocol（或 service 缺 call）即返回 null。
 */
function createMediaModelGateway({ providerProtocol = null, mediaDir = null } = {}) {
  const service = providerProtocol && providerProtocol.service ? providerProtocol.service : null;
  if (!service || typeof service.call !== "function") return null;

  function gatewayError(what, response) {
    const code = response && response.error === "MODEL_TIMEOUT" ? MEDIA_ERR_TIMEOUT : MEDIA_ERR_INTERNAL;
    const detail = String((response && (response.detail || response.error)) || "unknown").slice(0, 300);
    return createMediaError(code, what + "失败：" + detail, { dependency: "modelGateway" });
  }

  /** 产物 → 短剧 persistImages 能消费的 { type: "b64" | "url", value, mime }。 */
  function toImage(item) {
    if (!item || typeof item !== "object") return null;
    const file = typeof item.mediaPath === "string" && item.mediaPath
      ? item.mediaPath
      : mediaDir && typeof item.fileName === "string" && item.fileName
        ? path.join(mediaDir, item.fileName)
        : null;
    if (file) {
      try { return { type: "b64", value: fs.readFileSync(file).toString("base64"), mime: item.mime || "image/png" }; }
      catch { /* 文件已被清理：退回 URL 形态，绝不伪造图片 */ }
    }
    if (typeof item.dataUrl === "string" && item.dataUrl.startsWith("data:")) {
      const comma = item.dataUrl.indexOf(",");
      if (comma > 0) {
        const meta = item.dataUrl.slice(5, comma);
        return { type: "b64", value: item.dataUrl.slice(comma + 1), mime: item.mime || meta.split(";")[0] || "image/png" };
      }
    }
    if (typeof item.url === "string" && item.url) return { type: "url", value: item.url };
    if (typeof item.sourceUrl === "string" && item.sourceUrl) return { type: "url", value: item.sourceUrl };
    return null;
  }

  return Object.freeze({
    /** 短剧 generateDramaOutline / VisualDesign / Storyboards 的 callChat 出口。 */
    async callChat(provider, model, input = {}, params = {}, timeoutMs) {
      const response = await withTimeoutSignal(timeoutMs, (signal) => service.call({
        providerId: provider && provider.id,
        model: model,
        messages: [{ role: "user", content: String((input && input.prompt) || "") }],
        params: Object.assign({}, params, input && input.system ? { system: String(input.system) } : {}),
        signal: signal,
      }));
      if (!response || response.ok !== true) throw gatewayError("模型对话调用", response);
      return { text: response.text == null ? "" : String(response.text) };
    },
    /** 短剧 generateImages 出口（OpenAI 兼容 images/generations）。 */
    async generateImages(provider, model, params = {}, timeoutMs) {
      const response = await withTimeoutSignal(timeoutMs, (signal) => service.generateImage({
        providerId: provider && provider.id,
        model: model,
        prompt: String((params && params.prompt) || ""),
        size: (params && params.size) || null,
        count: Number(params && params.n) || 1,
        params: params && typeof params === "object" ? params : {},
        signal: signal,
      }));
      if (!response || response.ok !== true) throw gatewayError("图像生成调用", response);
      return { images: (response.images || []).map(toImage).filter(Boolean) };
    },
    /** 短剧 editImages 出口（legacy 协议族统一出口 legacyExecute）。 */
    async editImages(provider, model, params = {}, inputs = [], timeoutMs) {
      if (typeof service.legacyExecute !== "function") throw gatewayError("参考图编辑调用", { error: "MODEL_GATEWAY_UNSUPPORTED" });
      const response = await withTimeoutSignal(timeoutMs, (signal) => service.legacyExecute({
        providerId: provider && provider.id,
        action: "editImages",
        model: model,
        prompt: String((params && params.prompt) || ""),
        params: params && typeof params === "object" ? params : {},
        inputs: Array.isArray(inputs) ? inputs : [],
        timeoutMs: timeoutMs,
        signal: signal,
      }));
      if (!response || response.ok !== true) throw gatewayError("参考图编辑调用", response);
      return { images: (response.images || []).map(toImage).filter(Boolean) };
    },
  });
}

/**
 * B5f · Illustrator 依赖探测：只看可执行文件（不启动、不联网、不读配置）。
 * 显式 ILLUSTRATOR_PATH 优先；macOS 扫描 /Applications 下的 Adobe Illustrator*。
 */
function probeIllustratorAvailability(options = {}) {
  const explicit = typeof options.path === "string" && options.path ? options.path : process.env.ILLUSTRATOR_PATH;
  if (explicit) { try { return fs.statSync(explicit).isFile(); } catch { return false; } }
  if (process.platform !== "darwin") return false;
  let entries = [];
  try { entries = fs.readdirSync("/Applications"); } catch { return false; }
  for (const entry of entries) {
    if (!/^Adobe Illustrator/i.test(entry)) continue;
    const binary = path.join("/Applications", entry, "Adobe Illustrator.app", "Contents", "MacOS", "Adobe Illustrator");
    try { if (fs.statSync(binary).isFile()) return true; } catch { /* 继续找下一个版本 */ }
  }
  return false;
}

/** 模型目录里第一个 .onnx（不下载、不校验 sha；真实校验留给 background removal 自己）。 */
function findOnnxModelFile(modelDir) {
  if (!modelDir) return null;
  let entries = [];
  try { entries = fs.readdirSync(modelDir); } catch { return null; }
  for (const name of entries) {
    if (!/\.onnx$/i.test(name)) continue;
    const file = path.join(modelDir, name);
    try { if (fs.statSync(file).isFile()) return file; } catch { /* 下一个 */ }
  }
  return null;
}

/**
 * B5f · onnxruntime / 模型文件探测：惰性 require（不在模块顶层加载重原生依赖），
 * 探测结果原样交给 bundle —— 探测到就注入真 runtime，探测不到就 null（不假接）。
 */
function probeOnnxAvailability(options = {}) {
  const modelDir = typeof options.modelDir === "string" && options.modelDir ? options.modelDir : null;
  let runtime = null;
  let reason = null;
  try { runtime = require("onnxruntime-node"); }
  catch { reason = "onnxruntime-node 未安装"; }
  const modelPath = findOnnxModelFile(modelDir);
  if (!modelPath) reason = reason ? reason + "；模型目录没有 .onnx 文件" : "模型目录没有 .onnx 文件";
  return { available: !!runtime && !!modelPath, runtime: runtime, modelPath: modelPath, modelDir: modelDir, reason: reason };
}

/** 统一取 URL 文本：string / URL 对象 / Request（或任何带 url、href 的入参）。 */
function inboundUrlText(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input.url === "string") return input.url;
  if (input && typeof input.href === "string") return input.href;
  return "";
}

/**
 * dx-os.com 云端点判定。
 * 为什么先规范化：只看 input.url 会漏掉 URL 对象；不剥尾随点会漏掉 api.dx-os.com.
 * 这类 DNS 等价写法（host 大小写与端口由 URL 解析归一，尾点不会）。
 */
function isDxosCloudInput(input) {
  let host = "";
  try { host = new URL(inboundUrlText(input)).hostname; } catch { return false; /* 相对 / 非法 URL 交给 fetch 自己报错 */ }
  host = host.toLowerCase().replace(/\.+$/, "");
  return host === "dx-os.com" || host.endsWith(".dx-os.com");
}

/** 只允许本地 / 用户自配端点：拒绝云端点 dx-os.com（媒体域不得替用户回连 DX 云）。 */
function createGuardedFetch(baseFetch) {
  if (typeof baseFetch !== "function") return null;
  return function mediaGuardedFetch(input, init) {
    if (isDxosCloudInput(input)) {
      throw createMediaError(MEDIA_ERR_FORBIDDEN, "媒体域禁止访问云端 dx-os.com 端点（只用本地 / 用户自配端点）", { host: "dx-os.com" });
    }
    return baseFetch(input, init);
  };
}

const {
  createMediaError,
  normalizeMediaError,
  redactMediaValue,
  isMediaCommand,
  mediaCommandNotAllowed,
  listMediaCommands,
  MEDIA_ERR_INVALID_INPUT,
  MEDIA_ERR_UNAUTHENTICATED,
  MEDIA_ERR_NOT_FOUND,
  MEDIA_ERR_FORBIDDEN,
  MEDIA_ERR_CONFLICT,
  MEDIA_ERR_DEPENDENCY_UNAVAILABLE,
  MEDIA_ERR_TIMEOUT,
  MEDIA_ERR_CANCELLED,
  MEDIA_ERR_CHILD_FAILED,
  MEDIA_ERR_PROBE_FAILED,
  MEDIA_ERR_POSTER_FAILED,
  MEDIA_ERR_RENDER_FAILED,
  MEDIA_ERR_INTERNAL,
  MEDIA_EVENT_CHANNEL,
  MEDIA_POSTER_SIZES,
} = mediaDomain;

/** 媒体能力承载的 App Principal：与 skill-service.cjs:34 / agent-service.cjs:48 同一约定。 */
const HOST_APP_ID = "ai";

const RESULT_PREFIX = "OPENARC_MEDIA_RESULT ";
const PROGRESS_PREFIX = "OPENARC_MEDIA_PROGRESS ";

const DEFAULT_LEASE_MS = 30000;
const DEFAULT_WORKER_TIMEOUT_MS = 300000;
const DEFAULT_POSTER_TIMEOUT_MS = 60000;
const MAX_BASE64_BYTES = 256 * 1024 * 1024;
const MAX_ARTIFACTS = 500;
/** worker 自持 deadline 提前 runner 1s；这里给 runner 留 5s 余量，保证结构化结果先于 runner 兜底。 */
const RUNNER_MARGIN_MS = 5000;

const RENDER_STATUSES = Object.freeze(["queued", "running", "interrupted", "completed", "failed", "cancelled"]);

const asStr = (value, max = 512) => (typeof value === "string" ? value.slice(0, max) : value == null ? undefined : String(value).slice(0, max));
const requireStr = (value, max = 512) => { const text = asStr(value, max); return text && text.length ? text : null; };
const boundedTimeout = (value, fallback, max) => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.round(value)));
};

/** 与 media-domain 的输入校验口径一致的 base64 解码（只认显式字段，不猜路径）。 */
function decodeBase64(payload, field) {
  const raw = payload[field] !== undefined ? payload[field] : payload.data !== undefined ? payload.data : payload.buffer;
  let buffer;
  if (Buffer.isBuffer(raw)) buffer = raw;
  else if (raw instanceof Uint8Array) buffer = Buffer.from(raw);
  else if (Array.isArray(raw) && raw.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) buffer = Buffer.from(raw);
  else if (typeof raw === "string" && raw.length) {
    const base64 = raw.startsWith("data:") && raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
    buffer = Buffer.from(base64, "base64");
  } else {
    throw createMediaError(MEDIA_ERR_INVALID_INPUT, "需要媒体字节载荷（字段：base64 / data）");
  }
  if (!buffer.length) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "媒体载荷为空");
  if (buffer.length > MAX_BASE64_BYTES) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "媒体载荷超过 " + MAX_BASE64_BYTES + " 字节上限");
  return buffer;
}

/** B5e：二进制出口。base64url 不含 '/'，绕开 foundation 的绝对路径替换（避免图片字节被误脱敏）。 */
function encodeBinary(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function normalizePosterSize(value) {
  const size = Number(value);
  if (!MEDIA_POSTER_SIZES.includes(size)) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "封面尺寸只支持 " + MEDIA_POSTER_SIZES.join(" / "));
  return size;
}

/**
 * 解析外部二进制绝对路径。
 *
 * 为什么必需：executor-launcher.cjs:82 用**显式 env** spawn 子进程（只注入调用方给的键），
 * 子进程没有继承 PATH。若只按名字 spawn ffmpeg/ffprobe，worker 在受监督通道下必然 ENOENT
 * （实测：直接跑 worker 能成功、经 runner 就 MEDIA_DEPENDENCY_UNAVAILABLE）。因此这里在
 * 主进程把二进制解析成绝对路径，再经 spec.env 注入 worker；解析不到就是真的没装，
 * 交由 worker 回结构化的 MEDIA_DEPENDENCY_UNAVAILABLE。
 */
function resolveBinary(name, override) {
  // 显式配置优先（即使路径不存在）：错误配置必须由 worker 如实回依赖不可用，而不是偷偷换一个二进制。
  if (typeof override === "string" && override.length > 0) return override;
  const explicit = process.env[name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"];
  if (explicit) return explicit;
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean)
    .concat(["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin", "/bin"]);
  for (const dir of new Set(dirs)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* 继续找 */ }
    }
  }
  return null;
}

function createMediaBundle(options = {}) {
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const logger = typeof options.logger === "function" ? options.logger : null;
  const userDataDir = options.userDataDir || null;
  const identityStore = options.identityStore || null;
  const authorization = options.authorization || null;
  const runner = options.runner && typeof options.runner.start === "function" ? options.runner : createSupervisedRunner({ clock: clock });
  const workerEntry = options.workerEntry || path.join(__dirname, "video-render-worker.cjs");
  const leaseMs = Number.isFinite(options.leaseMs) ? Math.max(1000, options.leaseMs) : DEFAULT_LEASE_MS;
  const workerTimeoutMs = Number.isFinite(options.workerTimeoutMs) ? options.workerTimeoutMs : DEFAULT_WORKER_TIMEOUT_MS;
  const posterTimeoutMs = Number.isFinite(options.posterTimeoutMs) ? options.posterTimeoutMs : DEFAULT_POSTER_TIMEOUT_MS;
  const ffmpegPath = resolveBinary("ffmpeg", options.ffmpegPath || null);
  const ffprobePath = resolveBinary("ffprobe", options.ffprobePath || null);
  /** worker 的显式 env：只注入解析到的二进制绝对路径（不注入 PATH，避免外部影响）。 */
  const workerEnv = {};
  if (ffmpegPath) workerEnv.FFMPEG_PATH = ffmpegPath;
  if (ffprobePath) workerEnv.FFPROBE_PATH = ffprobePath;

  const paths = userDataDir ? resolveDxosPaths(userDataDir) : null;
  const mediaDir = paths ? paths.directory.media : null;
  const db = identityStore ? identityStore.connection || identityStore.db || null : null;

  if (mediaDir) {
    try { fs.mkdirSync(mediaDir, { recursive: true }); } catch { /* 装配不阻断：具体命令再抛结构化落盘错误 */ }
    if (userDataDir) { try { ensureDxosLayout(userDataDir); } catch { /* 同上 */ } }
  }
  mediaStore.configureMediaStore({ db: db, mediaDir: mediaDir, clock: clock });

  // B5e：把注入面分发给媒体域剩余 8 个子模块。dataDir 统一取 <userData>/dxos/media；
  // fsAdapter / fetchImpl / modelGateway / viteBuild / illustratorAvailable 等全部来自调用方，
  // 缺失时各命令回结构化 MEDIA_DEPENDENCY_UNAVAILABLE（绝不兜底、不假执行）。
  // B5f：先算出**生效后**的注入面（含 mediaExtensions 覆盖），既喂给子模块，也用于
  // dependencies / media/health 的如实上报 —— 报告与实际配置同源，不各写一份。
  const extensionOptions = Object.assign({
    dataDir: mediaDir,
    fsAdapter: options.fsAdapter || null,
    fetchImpl: options.fetchImpl || null,
    mediaStore: mediaStore,
    clock: clock,
    logger: logger,
    sharpLoader: options.sharpLoader || null,
    onnxSessionFactory: options.onnxSessionFactory || null,
    onnxRuntime: options.onnxRuntime || null,
    modelPath: options.modelPath || null,
    modelDir: options.modelDir || null,
    models: options.models || undefined,
    providerStore: options.providerStore || null,
    modelGateway: options.modelGateway || null,
    renderSubmit: options.renderSubmit || null,
    musicMetadataLoader: options.musicMetadataLoader || null,
    illustratorAvailable: options.illustratorAvailable === true,
    viteBuild: options.viteBuild || null,
    vuePlugin: options.vuePlugin || null,
    tmpDir: options.tmpDir || null,
    director3dModels: options.director3dModels || undefined,
    director3dCatalog: options.director3dCatalog || null,
  }, options.mediaExtensions || {});
  configureMediaExtensions(extensionOptions);

  /** B5f：每个注入项「是否生效 + 为空原因」；false 的项同时进 MEDIA_DEPENDENCY_UNAVAILABLE 分支。 */
  const extensionDependencyReport = {
    fsAdapter: { injected: !!extensionOptions.fsAdapter, reason: "缺少 fsAdapter：注入 B6 dxos-fs 适配器后短剧画布 / 素材才能落盘" },
    fetchImpl: { injected: typeof extensionOptions.fetchImpl === "function", reason: "缺少 fetchImpl：注入主进程 fetch 后下载生成图片 / 刮削封面 / 拉取 Figma 清单才可用" },
    providerStore: { injected: !!extensionOptions.providerStore, reason: "缺少 providerStore：注入 B2 provider-protocol 选型面后短剧 AI 生成才可用" },
    modelGateway: { injected: !!extensionOptions.modelGateway, reason: "缺少 modelGateway：注入 B2 provider-protocol-service 出口后短剧 AI 生成才可用" },
    viteBuild: { injected: typeof extensionOptions.viteBuild === "function", reason: "本仓无随包 Vite 构建器（vite 只在 devDependencies）：Figma 预览构建保持结构化不可用" },
    illustratorAvailable: { injected: extensionOptions.illustratorAvailable === true, reason: "未探测到本机 Adobe Illustrator 可执行文件" },
    onnxRuntime: { injected: !!extensionOptions.onnxRuntime, reason: "onnxruntime-node 未安装 / 未探测到：本地抠图保持结构化不可用" },
    onnxSessionFactory: { injected: typeof extensionOptions.onnxSessionFactory === "function", reason: "未注入推理会话工厂：本地抠图保持结构化不可用" },
    modelPath: { injected: !!extensionOptions.modelPath, reason: "未找到 .onnx 模型文件：本地抠图保持结构化不可用" },
    modelDir: { injected: !!extensionOptions.modelDir, reason: "未装配模型目录" },
  };
  const extensionDependencies = Object.freeze(Object.fromEntries(
    Object.entries(extensionDependencyReport).map(([name, entry]) => [name, entry.injected === true]),
  ));
  const dependencyNotes = Object.freeze(Object.fromEntries(
    Object.entries(extensionDependencyReport).map(([name, entry]) => [name, entry.injected === true ? null : entry.reason]),
  ));

  const subDirs = mediaDir ? {
    assets: path.join(mediaDir, "assets"),
    renders: path.join(mediaDir, "renders"),
    posters: path.join(mediaDir, "posters"),
    tmp: path.join(mediaDir, "tmp"),
  } : null;

  function ensureDirs() {
    if (!subDirs) throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "媒体目录未装配（缺少 userDataDir）", { dependency: "mediaDir" });
    for (const dir of Object.values(subDirs)) fs.mkdirSync(dir, { recursive: true });
    return subDirs;
  }

  // ---- 事件（P1 信封；bootstrap 的 send 经 setEventSink 注入） ----
  const channel = createEventChannel({ domain: mediaDomain.MEDIA_EVENT_DOMAIN, clock: clock });
  let eventSink = null;
  function setEventSink(fn) { eventSink = typeof fn === "function" ? fn : null; return true; }
  function emit(kind, payload) {
    const event = channel.emit(kind, payload);
    if (eventSink) { try { eventSink(event); } catch { /* 事件推送失败不改变业务结果 */ } }
    return event;
  }

  // -------------------------------------------------------------------------
  // 受监督子进程调用
  // -------------------------------------------------------------------------

  function writeSpecFile(spec) {
    const dirs = ensureDirs();
    const file = path.join(dirs.tmp, randomUUID() + ".json");
    fs.writeFileSync(file, JSON.stringify(spec), { mode: 0o600 });
    return file;
  }

  /**
   * 启动一次 worker 并等它 settle。
   * 返回 { runner, envelope }：envelope 是 worker 的 OPENARC_MEDIA_RESULT 或由 runner 事实归一的失败。
   */
  async function invokeWorker(op, spec, opts = {}) {
    const timeoutMs = boundedTimeout(opts.timeoutMs, workerTimeoutMs, 3600000);
    const specPath = writeSpecFile(spec === undefined ? {} : spec);
    let lastEnvelope = null;
    let buffer = "";
    const onEvent = (event) => {
      if (!event || event.type !== "stdout" || !event.text) return;
      buffer += event.text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith(RESULT_PREFIX)) {
          try { lastEnvelope = JSON.parse(line.slice(RESULT_PREFIX.length)); } catch { lastEnvelope = null; }
        } else if (line.startsWith(PROGRESS_PREFIX)) {
          try {
            const progress = JSON.parse(line.slice(PROGRESS_PREFIX.length));
            if (typeof opts.onProgress === "function") opts.onProgress(progress);
          } catch { /* 单条进度行损坏不影响渲染结果 */ }
        }
      }
    };
    let handle = null;
    try {
      handle = runner.start({ entry: workerEntry, args: [op, specPath], env: workerEnv, timeoutMs: timeoutMs + RUNNER_MARGIN_MS, maxStdoutBytes: 8 * 1024 * 1024, onEvent });
      if (typeof opts.onHandle === "function") opts.onHandle(handle);
      const runnerResult = await handle.result;
      if (lastEnvelope) return { runner: runnerResult, envelope: lastEnvelope };
      if (runnerResult.timedOut) return { runner: runnerResult, envelope: { ok: false, error: MEDIA_ERR_TIMEOUT, message: "媒体子进程超时（" + timeoutMs + "ms）" } };
      if (runnerResult.cancelled) return { runner: runnerResult, envelope: { ok: false, error: MEDIA_ERR_CANCELLED, message: "媒体子进程已取消" } };
      return { runner: runnerResult, envelope: { ok: false, error: MEDIA_ERR_CHILD_FAILED, message: "媒体子进程未返回结构化结果（exit " + runnerResult.code + "）" } };
    } finally {
      try { fs.rmSync(specPath, { force: true }); } catch { /* 临时 spec 清理失败不改变结果 */ }
    }
  }

  /** 调用 worker；失败一律 throw 领域错误（绝不吞掉）。 */
  async function runWorker(op, spec, opts = {}) {
    const { envelope } = await invokeWorker(op, spec, opts);
    if (!envelope || envelope.ok !== true) {
      const code = envelope && typeof envelope.error === "string" ? envelope.error : MEDIA_ERR_CHILD_FAILED;
      const detail = envelope && envelope.dependency ? { dependency: envelope.dependency } : undefined;
      throw createMediaError(code, (envelope && envelope.message) || "媒体子进程失败", detail);
    }
    return envelope.result;
  }

  // -------------------------------------------------------------------------
  // 封面缓存（render 走受监督 worker）
  // -------------------------------------------------------------------------
  const posterCache = subDirs
    ? mediaStore.createVideoPosterCache(subDirs.posters, async (source, target, size) => {
        await runWorker("poster", { source: source, target: target, size: size, timeoutMs: posterTimeoutMs }, { timeoutMs: posterTimeoutMs });
      })
    : null;

  // -------------------------------------------------------------------------
  // 路径 / 素材解析
  // -------------------------------------------------------------------------

  /** 只允许媒体根内的绝对路径（渲染层拿不到路径；调用方一般是 assetId）。 */
  function assertWithinMediaRoot(value) {
    if (!mediaDir) throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "媒体目录未装配", { dependency: "mediaDir" });
    const resolved = path.resolve(String(value || ""));
    const root = path.resolve(mediaDir) + path.sep;
    if (!resolved.startsWith(root)) throw createMediaError(MEDIA_ERR_FORBIDDEN, "只允许访问媒体目录内的文件");
    return resolved;
  }

  function sourcePathFor(payload, userId) {
    if (payload.assetId) return mediaStore.mediaAssetAbsolutePath(String(payload.assetId), userId);
    if (payload.filePath) return assertWithinMediaRoot(payload.filePath);
    return null;
  }

  /** 图片素材探测：只在需要时惰性 require sharp；缺失即结构化依赖不可用。 */
  async function probeImageBuffer(buffer, mime) {
    let sharp;
    try {
      sharp = require("sharp");
    } catch {
      throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "sharp 未安装，无法探测图片素材", { dependency: "sharp" });
    }
    const metadata = await sharp(buffer, { failOn: "error" }).metadata();
    return { durationMs: 5000, sizeBytes: buffer.length, formatName: metadata.format || mime, hasVideo: true, hasAudio: false, width: metadata.width, height: metadata.height };
  }

  /** 探测素材：素材 / base64 / 媒体根内路径三选一（源 mediaProbe.ts:139-153 的语义）。 */
  async function probeAsset(payload, userId, timeoutMs) {
    const mime = String(payload.mime || "").toLowerCase();
    const name = String(payload.name || "");
    if (payload.base64 !== undefined || payload.data !== undefined || payload.buffer !== undefined) {
      const buffer = decodeBase64(payload, "base64");
      if (mime.startsWith("image/")) return probeImageBuffer(buffer, mime);
      if (/\.(srt|vtt)$/i.test(name)) {
        const preview = buffer.subarray(0, Math.min(buffer.length, 4096)).toString("utf8");
        if (!preview.trim()) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "字幕文件为空");
        return { durationMs: 0, sizeBytes: buffer.length, formatName: path.extname(name).slice(1), hasVideo: false, hasAudio: false };
      }
      const dirs = ensureDirs();
      const extension = /^\.[a-z0-9]{1,8}$/.test(path.extname(name).toLowerCase())
        ? path.extname(name).toLowerCase()
        : mime.startsWith("video/") ? ".mp4" : mime.startsWith("audio/") ? ".wav" : ".bin";
      const temp = path.join(dirs.tmp, randomUUID() + extension);
      fs.writeFileSync(temp, buffer, { flag: "wx" });
      try {
        return await runWorker("probe", { filePath: temp, timeoutMs: timeoutMs }, { timeoutMs: timeoutMs });
      } finally {
        try { fs.rmSync(temp, { force: true }); } catch { /* 清理失败不影响探测结果 */ }
      }
    }
    const sourcePath = sourcePathFor(payload, userId);
    if (!sourcePath) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "media/probe 需要 assetId / filePath / base64 之一");
    if (!fs.existsSync(sourcePath)) throw createMediaError(MEDIA_ERR_NOT_FOUND, "待探测文件不存在");
    return runWorker("probe", { filePath: sourcePath, timeoutMs: timeoutMs }, { timeoutMs: timeoutMs });
  }

  // -------------------------------------------------------------------------
  // 渲染作业执行（受监督子进程 + 主进程租约心跳）
  // -------------------------------------------------------------------------

  function cleanupPartial(partialPath) {
    try { if (partialPath && fs.existsSync(partialPath)) fs.rmSync(partialPath, { force: true }); } catch { /* 忽略 */ }
  }

  /**
   * 领取并执行一个排队 / 中断的渲染作业。
   * 返回 { ran, job }；worker 失败时作业置 failed（绝不写 completed），错误文本结构化落库。
   */
  async function runOneRenderJob(context) {
    const workerId = requireStr(context && context.workerId, 80) || "media-" + randomUUID();
    const claim = mediaStore.claimNextVideoRenderJob(workerId, leaseMs);
    if (!claim) return { ran: false, job: null };
    const jobId = claim.id;
    emit("progress", { command: "media/render/run", phase: "claimed", jobId: jobId, workerId: workerId });
    let timer = null;
    let handle = null;
    let leaseLost = false;
    let partialPath = "";
    try {
      const execution = mediaStore.renderJobExecutionData(claim, workerId);
      partialPath = execution.partialPath;
      const spec = { plan: execution.plan, partialPath: partialPath, timeoutMs: boundedTimeout(context && context.timeoutMs, workerTimeoutMs, 3600000) };
      timer = setInterval(() => {
        const renewed = mediaStore.heartbeatVideoRenderJob(jobId, workerId, leaseMs);
        if (!renewed) {
          leaseLost = true;
          if (handle && typeof handle.cancel === "function") handle.cancel("LEASE_LOST");
        }
      }, Math.max(1000, Math.floor(leaseMs / 3)));
      const { envelope } = await invokeWorker("render", spec, {
        timeoutMs: spec.timeoutMs,
        onHandle: (h) => { handle = h; },
        onProgress: (progress) => {
          if (timer && typeof progress.ratio === "number") {
            // 源 videoWorker.ts:43 的进度区间：2..96
            mediaStore.heartbeatVideoRenderJob(jobId, workerId, leaseMs, 2 + progress.ratio * 94);
          }
          emit("progress", { command: "media/render/run", phase: "render", jobId: jobId, ratio: progress.ratio });
        },
      });
      const current = mediaStore.getVideoRenderJob(jobId);
      if (!current || current.status !== "running" || current.worker_id !== workerId) {
        cleanupPartial(partialPath);
        return { ran: true, job: mediaStore.publicVideoRenderJob(mediaStore.getVideoRenderJob(jobId)), leaseLost: leaseLost };
      }
      if (!envelope || envelope.ok !== true) {
        const message = (envelope && envelope.message) || "渲染子进程失败";
        mediaStore.failVideoRenderJob(jobId, workerId, message);
        emit("progress", { command: "media/render/run", phase: "failed", jobId: jobId, error: (envelope && envelope.error) || MEDIA_ERR_RENDER_FAILED });
        cleanupPartial(partialPath);
        return { ran: true, job: mediaStore.publicVideoRenderJob(mediaStore.getVideoRenderJob(jobId)), error: envelope };
      }
      mediaStore.completeVideoRenderJob(jobId, workerId, partialPath);
      emit("progress", { command: "media/render/run", phase: "completed", jobId: jobId });
      return { ran: true, job: mediaStore.publicVideoRenderJob(mediaStore.getVideoRenderJob(jobId)) };
    } catch (error) {
      cleanupPartial(partialPath);
      const current = mediaStore.getVideoRenderJob(jobId);
      if (current && current.status === "running" && current.worker_id === workerId) {
        mediaStore.failVideoRenderJob(jobId, workerId, (error && error.message) || String(error));
      }
      throw error;
    } finally {
      if (timer) clearInterval(timer);
    }
  }

  // -------------------------------------------------------------------------
  // 产物清单（只回相对路径）
  // -------------------------------------------------------------------------
  function listArtifacts() {
    if (!subDirs) return [];
    const out = [];
    const groups = [["asset", subDirs.assets], ["render", subDirs.renders], ["poster", subDirs.posters]];
    for (const [kind, dir] of groups) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (kind === "render" && name.includes(".partial.")) continue;
        const full = path.join(dir, name);
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        if (!stat.isFile()) continue;
        out.push({ kind: kind, id: kind === "poster" ? path.basename(name, path.extname(name)) : name, fileName: name, relativePath: kind + "s/" + name, bytes: stat.size, mtime: stat.mtimeMs });
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_ARTIFACTS);
  }

  // -------------------------------------------------------------------------
  // 命令分发
  // -------------------------------------------------------------------------

  async function ensureProject(payload, userId) {
    const projectId = requireStr(payload.projectId, 80);
    if (!projectId) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "projectId 必填");
    return mediaStore.ensureVideoProject({ id: projectId, ownerId: userId, name: requireStr(payload.projectName, 120) || undefined });
  }

  async function dispatch(command, payload, context) {
    const userId = context.userId;
    switch (command) {
      // ---------------- 项目 / 素材 ----------------
      case "media/project/ensure": {
        const projectId = await ensureProject(payload, userId);
        return { projectId: projectId };
      }
      case "media/asset/save": {
        const projectId = requireStr(payload.projectId, 80);
        if (!projectId) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "projectId 必填");
        const name = requireStr(payload.name, 255);
        if (!name) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "素材 name 必填");
        const mime = requireStr(payload.mime, 120) || "application/octet-stream";
        const buffer = decodeBase64(payload, "base64");
        const timeoutMs = boundedTimeout(payload.timeoutMs, workerTimeoutMs, 3600000);
        const probe = await probeAsset({ base64: buffer, name: name, mime: mime, timeoutMs: timeoutMs }, userId, timeoutMs);
        const asset = mediaStore.saveVideoAsset({ projectId: projectId, ownerId: userId, projectName: requireStr(payload.projectName, 120) || undefined, name: name, mime: mime, buffer: buffer, probe: probe });
        return { asset: asset };
      }
      case "media/asset/list": {
        const projectId = requireStr(payload.projectId, 80);
        if (!projectId) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "projectId 必填");
        return { assets: mediaStore.listVideoAssetRows(projectId, userId).map(mediaStore.videoAssetView) };
      }
      case "media/asset/delete": {
        const id = requireStr(payload.assetId, 80) || requireStr(payload.id, 80);
        if (!id) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "assetId 必填");
        return { deleted: mediaStore.deleteVideoAsset(id, userId) };
      }

      // ---------------- 探测 / 封面 ----------------
      case "media/probe": {
        const timeoutMs = boundedTimeout(payload.timeoutMs, workerTimeoutMs, 3600000);
        return { probe: await probeAsset(payload, userId, timeoutMs) };
      }
      case "media/poster/get": {
        const size = normalizePosterSize(payload.size === undefined ? 640 : payload.size);
        const source = sourcePathFor(payload, userId);
        if (!source) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "media/poster/get 需要 assetId 或 filePath");
        if (!fs.existsSync(source)) throw createMediaError(MEDIA_ERR_NOT_FOUND, "封面源文件不存在");
        if (!posterCache) throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "封面缓存未装配", { dependency: "mediaDir" });
        // cached 必须反映"调用前缓存文件是否已存在且非空"，而不是恒 true：
        // keyFor 与 posterCache 内部同一个 key（source stat + size + poster-v1），先在目标目录探一次。
        let cached = false;
        try {
          const key = await posterCache.keyFor(source, size);
          const cachedFile = path.join(subDirs.posters, key + ".jpg");
          cached = (await fs.promises.stat(cachedFile)).size > 0;
        } catch { cached = false; }
        const target = await posterCache(source, size);
        const stat = fs.statSync(target);
        return { poster: { id: path.basename(target, ".jpg"), fileName: path.basename(target), size: size, bytes: stat.size, cached: cached } };
      }
      case "media/poster/invalidate": {
        const size = normalizePosterSize(payload.size === undefined ? 640 : payload.size);
        const source = sourcePathFor(payload, userId);
        if (!source) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "media/poster/invalidate 需要 assetId 或 filePath");
        if (!posterCache) throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "封面缓存未装配", { dependency: "mediaDir" });
        return { invalidated: await posterCache.invalidate(source, size) };
      }

      // ---------------- 渲染作业 ----------------
      case "media/render/submit": {
        const projectId = requireStr(payload.projectId, 80);
        if (!projectId) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "projectId 必填");
        const job = mediaStore.createVideoRenderJob({ projectId: projectId, ownerId: userId, projectName: requireStr(payload.projectName, 120) || undefined, timeline: payload.timeline });
        emit("progress", { command: command, phase: "queued", jobId: job.id });
        return { job: mediaStore.publicVideoRenderJob(job) };
      }
      case "media/render/get": {
        const id = requireStr(payload.jobId, 80) || requireStr(payload.id, 80);
        if (!id) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "jobId 必填");
        const job = mediaStore.getVideoRenderJob(id, userId);
        if (!job) throw createMediaError(MEDIA_ERR_NOT_FOUND, "渲染任务不存在");
        return { job: mediaStore.publicVideoRenderJob(job) };
      }
      case "media/render/list": {
        const statuses = Array.isArray(payload.statuses) ? payload.statuses.filter((s) => RENDER_STATUSES.includes(s)) : [];
        const jobs = mediaStore.listVideoRenderJobs({ ownerId: userId, projectId: requireStr(payload.projectId, 80) || undefined, statuses: statuses, limit: payload.limit });
        return { jobs: jobs.map(mediaStore.publicVideoRenderJob) };
      }
      case "media/render/run": {
        const workerId = requireStr(payload.workerId, 80);
        if (payload.workerId !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(String(payload.workerId))) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "workerId 形态非法");
        const result = await runOneRenderJob({ userId: userId, workerId: workerId, timeoutMs: payload.timeoutMs });
        return result;
      }
      case "media/render/cancel": {
        const id = requireStr(payload.jobId, 80) || requireStr(payload.id, 80);
        if (!id) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "jobId 必填");
        const job = mediaStore.cancelVideoRenderJob(id, userId);
        emit("progress", { command: command, phase: "cancelled", jobId: id });
        return { job: mediaStore.publicVideoRenderJob(job) };
      }
      case "media/render/heartbeat": {
        const id = requireStr(payload.jobId, 80) || requireStr(payload.id, 80);
        const workerId = requireStr(payload.workerId, 80);
        if (!id || !workerId) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "heartbeat 需要 jobId 与 workerId");
        const renewed = mediaStore.heartbeatVideoRenderJob(id, workerId, leaseMs, payload.progress);
        return { jobId: id, renewed: renewed };
      }
      case "media/render/recover": {
        return { recovered: mediaStore.recoverExpiredVideoJobs() };
      }

      // ---------------- 产物 / 健康 ----------------
      case "media/artifact/list": {
        return { artifacts: listArtifacts() };
      }
      case "media/health": {
        let ffmpeg = null;
        let ffprobe = null;
        let workerReachable = false;
        try {
          const health = await runWorker("health", {}, { timeoutMs: 30000 });
          ffmpeg = health ? health.ffmpeg || null : null;
          ffprobe = health ? health.ffprobe || null : null;
          workerReachable = true;
        } catch { workerReachable = false; }
        const dependencies = Object.assign({
          database: !!db,
          mediaDirectory: !!mediaDir,
          identity: !!authorization,
          worker: workerReachable,
          // 键名避开 isSecretKey 的子串（dxos-foundation-mask.cjs:12）
          ffmpegBinary: !!ffmpeg,
          ffprobeBinary: !!ffprobe,
        }, extensionDependencies);
        const ok = dependencies.database && dependencies.mediaDirectory && workerReachable && dependencies.ffmpegBinary && dependencies.ffprobeBinary;
        // B5f：每条 false 的注入项都给出为空原因（dependencyNotes 与 dependencies 同源）。
        return { status: ok ? "ok" : "degraded", dependencies: dependencies, dependencyNotes: dependencyNotes, ffmpeg: ffmpeg, ffprobe: ffprobe, commands: listMediaCommands().length, eventChannel: MEDIA_EVENT_CHANNEL, leaseMs: leaseMs };
      }

      // ---------------- B5e：本地抠图（源 backgroundRemoval.ts） ----------------
      case "media/background-removal/status": {
        const probe = await mediaBackgroundRemoval.probeBackgroundRemovalDependencies();
        if (!probe.ok) throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "本地抠图依赖不可用", probe.detail);
        return { models: await mediaBackgroundRemoval.backgroundRemovalStatus(), dependencies: { onnxruntime: true, sharp: true } };
      }
      case "media/background-removal/remove": {
        const modelId = requireStr(payload.modelId, 80) || "ben2-base";
        const buffer = decodeBase64(payload, "base64");
        const image = await mediaBackgroundRemoval.removeImageBackground(buffer, modelId);
        return { image: encodeBinary(image), mime: "image/png", bytes: image.length, modelId: modelId };
      }

      // ---------------- B5e：AI 图像声明（源 aiImageDeclaration.ts） ----------------
      case "media/ai-declaration/apply": {
        const name = requireStr(payload.name, 255);
        if (!name) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "图片 name 必填");
        const data = decodeBase64(payload, "base64");
        const declared = await mediaAiDeclaration.addDeclaration(name, data);
        if (!declared) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "不支持的图片格式：" + name + "（支持 JPG、PNG、WebP）");
        return { fileName: mediaAiDeclaration.normalizedJpegName(name), mime: "image/jpeg", bytes: declared.length, data: encodeBinary(declared) };
      }
      case "media/ai-declaration/read": {
        const name = requireStr(payload.name, 255);
        if (!name) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "图片 name 必填");
        const data = decodeBase64(payload, "base64");
        return { declaration: mediaAiDeclaration.readDeclaration(name, data) };
      }
      case "media/ai-declaration/process": {
        const files = (Array.isArray(payload.files) ? payload.files : []).map((file) => ({
          name: String((file && file.name) || ""),
          data: decodeBase64(file || {}, "base64"),
        }));
        const result = await mediaAiDeclaration.processDeclarationUpload(files);
        return { fileName: result.filename, mime: result.mime, imageCount: result.imageCount, bytes: result.data.length, data: encodeBinary(result.data) };
      }

      // ---------------- B5e：短剧工坊（源 shortDrama.ts） ----------------
      case "media/short-drama/list": {
        return { projects: mediaShortDrama.listDramaProjects() };
      }
      case "media/short-drama/create": {
        const name = requireStr(payload.name, 50);
        if (!name) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "请输入项目名称");
        return { project: mediaShortDrama.createDramaProject(name, userId) };
      }
      case "media/short-drama/update": {
        const projectId = requireStr(payload.projectId, 80);
        if (!projectId) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "projectId 必填");
        return { project: mediaShortDrama.updateDramaProject(projectId, payload.patch && typeof payload.patch === "object" ? payload.patch : payload) };
      }
      case "media/short-drama/shot/add": {
        const projectId = requireStr(payload.projectId, 80);
        if (!projectId) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "projectId 必填");
        return { shot: mediaShortDrama.addDramaShot(projectId, payload.shot && typeof payload.shot === "object" ? payload.shot : {}) };
      }
      case "media/short-drama/shot/update": {
        const projectId = requireStr(payload.projectId, 80);
        const shotId = requireStr(payload.shotId, 80);
        if (!projectId || !shotId) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "projectId 与 shotId 必填");
        return { shot: mediaShortDrama.updateDramaShot(projectId, shotId, payload.patch && typeof payload.patch === "object" ? payload.patch : {}) };
      }
      case "media/short-drama/outline": {
        const projectId = requireStr(payload.projectId, 80);
        if (!projectId) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "projectId 必填");
        return { project: await mediaShortDrama.generateDramaOutline(projectId, payload.episodeCount) };
      }
      case "media/short-drama/visual-design": {
        const projectId = requireStr(payload.projectId, 80);
        if (!projectId) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "projectId 必填");
        return { project: await mediaShortDrama.generateDramaVisualDesign(projectId) };
      }
      case "media/short-drama/storyboards": {
        const projectId = requireStr(payload.projectId, 80);
        if (!projectId) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "projectId 必填");
        return { project: await mediaShortDrama.generateDramaStoryboards(projectId, requireStr(payload.episodeId, 80) || undefined) };
      }
      case "media/short-drama/shot/image": {
        const projectId = requireStr(payload.projectId, 80);
        const shotId = requireStr(payload.shotId, 80);
        if (!projectId || !shotId) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "projectId 与 shotId 必填");
        return await mediaShortDrama.generateDramaShotImage(projectId, shotId);
      }
      case "media/short-drama/render": {
        const projectId = requireStr(payload.projectId, 80);
        if (!projectId) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "projectId 必填");
        return await mediaShortDrama.submitDramaRender(projectId, { ownerId: userId });
      }

      // ---------------- B5e：本地音乐库（源 library.ts） ----------------
      case "media/library/config/get": {
        return { config: mediaLibrary.getConfig() };
      }
      case "media/library/config/set-dirs": {
        return mediaLibrary.setDirs(Array.isArray(payload.dirs) ? payload.dirs : []);
      }
      case "media/library/scan": {
        const options = Array.isArray(payload.dirs) && payload.dirs.length ? { dirs: payload.dirs } : {};
        return { tracks: await mediaLibrary.scan(options) };
      }
      case "media/library/tracks": {
        return { tracks: await mediaLibrary.listTracks() };
      }
      case "media/library/artwork/targets": {
        return await mediaLibrary.artworkTargets();
      }
      case "media/library/artwork/put": {
        const scope = payload.scope === "artist" ? "artist" : payload.scope === "album" ? "album" : null;
        const key = requireStr(payload.key, 300);
        if (!scope || !key) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "artwork/put 需要 scope（artist / album）与 key");
        const buffer = decodeBase64(payload, "base64");
        const id = mediaLibrary.putArtwork(scope, key, buffer);
        return { id: id, url: "/api/library/artwork/" + id, scope: scope, key: key };
      }
      case "media/library/meta/set": {
        return { updated: mediaLibrary.setMeta(Array.isArray(payload.items) ? payload.items : []) };
      }
      case "media/library/lyrics": {
        const id = requireStr(payload.trackId, 80) || requireStr(payload.id, 80);
        if (!id) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "trackId 必填");
        return { lyrics: await mediaLibrary.getLyrics(id, payload.online !== false) };
      }

      // ---------------- B5e：Illustrator（源 illustratorConfig.ts / illustratorTempExports.ts） ----------------
      case "media/illustrator/config/get": {
        const unavailable = mediaIllustrator.illustratorUnavailable("本机未安装 Adobe Illustrator，无法读取配置");
        if (unavailable) throw unavailable;
        return { config: mediaIllustrator.readIllustratorConfig() };
      }
      case "media/illustrator/config/update": {
        const unavailable = mediaIllustrator.illustratorUnavailable("本机未安装 Adobe Illustrator，无法更新配置");
        if (unavailable) throw unavailable;
        return { config: mediaIllustrator.updateIllustratorConfig(payload.patch && typeof payload.patch === "object" ? payload.patch : {}) };
      }
      case "media/illustrator/temp-export/prepare": {
        const unavailable = mediaIllustrator.illustratorUnavailable("本机未安装 Adobe Illustrator，无法准备临时导出");
        if (unavailable) throw unavailable;
        const name = requireStr(payload.name, 80) || "Illustrator";
        const prepared = mediaIllustrator.prepareIllustratorTempExport(userId, name);
        return { exportId: prepared.id, fileName: prepared.name };
      }
      case "media/illustrator/temp-export/cleanup": {
        const unavailable = mediaIllustrator.illustratorUnavailable("本机未安装 Adobe Illustrator，无需清理临时导出");
        if (unavailable) throw unavailable;
        return mediaIllustrator.cleanupIllustratorTempExports(userId);
      }

      // ---------------- B5e：Figma 预览（源 figmaPreview.ts） ----------------
      case "media/figma-preview/files": {
        const sourceUrl = requireStr(payload.sourceUrl, 512);
        if (!sourceUrl) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "sourceUrl 必填");
        return await mediaFigmaPreview.fetchFigmaPreviewFiles(sourceUrl);
      }
      case "media/figma-preview/build": {
        const projectId = requireStr(payload.projectId, 80);
        if (!projectId) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "projectId 必填");
        return await mediaFigmaPreview.buildFigmaPreview(projectId, Array.isArray(payload.files) ? payload.files : []);
      }

      // ---------------- B5e：导演台 3D 模型目录（源 director3dModels.ts） ----------------
      case "media/director3d/models/list": {
        return { models: mediaDirector3D.director3DModelStatus() };
      }
      case "media/director3d/models/file": {
        const id = requireStr(payload.modelId, 80) || requireStr(payload.id, 80);
        if (!id) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "modelId 必填");
        const resolved = mediaDirector3D.director3DModelFile(id);
        const stat = fs.statSync(resolved.path);
        return { model: { id: resolved.model.id, version: resolved.model.version, format: resolved.model.format, kind: resolved.model.kind, size: resolved.model.size, bytes: stat.size, fileName: path.basename(resolved.path) } };
      }

      // ---------------- B5e：公共媒体（源 publicMedia.ts 本地部分） ----------------
      case "media/public-media/list": {
        return { items: mediaPublicMedia.listPublicMedia() };
      }
      case "media/public-media/url": {
        const fileName = requireStr(payload.fileName, 255);
        if (!fileName) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "fileName 必填");
        return { url: mediaPublicMedia.publicMediaUrl(fileName) };
      }
      case "media/public-media/normalize": {
        const buffer = decodeBase64(payload, "base64");
        const normalized = await mediaPublicMedia.normalizePublicImageForApimartVideo({
          buf: buffer,
          mime: requireStr(payload.mime, 120) || "image/png",
          name: requireStr(payload.name, 255) || "reference",
        });
        return { name: normalized.name, mime: normalized.mime, bytes: normalized.buf.length, data: encodeBinary(normalized.buf) };
      }

      default:
        throw mediaCommandNotAllowed(command);
    }
  }

  /** sessionRef → actor；不可解析时返回 { ok:false }，绝不伪造身份。 */
  function resolveActor(context) {
    if (!authorization || typeof authorization.resolveActor !== "function") return { ok: false, message: "授权服务未装配" };
    try {
      const result = authorization.resolveActor({ context: context });
      if (!result || result.ok !== true || !result.user || result.user.id == null) return { ok: false, message: (result && (result.error || result.reason)) || "会话无效" };
      return result;
    } catch (error) {
      return { ok: false, message: String((error && error.message) || error) };
    }
  }

  /**
   * 唯一分发入口：白名单 → actor 解析 → dispatch → 脱敏；失败统一 normalizeMediaError。
   * 每次执行前后各发一条 progress 事件（P1 信封），供渲染层显示与丢帧判定。
   */
  async function execute(command, payload, ctx = {}) {
    if (!isMediaCommand(command)) return normalizeMediaError(mediaCommandNotAllowed(command));
    const context = {
      sessionRef: requireStr(ctx && ctx.sessionRef, 160) || null,
      appId: requireStr(ctx && ctx.appId, 60) || HOST_APP_ID,
      source: "media",
      requestId: requireStr(ctx && ctx.requestId, 100) || null,
    };
    emit("progress", { command: command, phase: "begin", requestId: context.requestId });
    const actorResult = resolveActor(context);
    if (!actorResult.ok) {
      emit("progress", { command: command, phase: "rejected", reason: "unauthenticated", requestId: context.requestId });
      return normalizeMediaError(createMediaError(MEDIA_ERR_UNAUTHENTICATED, actorResult.message || "当前会话未认证，media 命令被拒绝"));
    }
    context.userId = String(actorResult.user.id);
    context.actor = actorResult.user;
    const body = payload && typeof payload === "object" ? payload : {};
    try {
      const value = await dispatch(command, body, context);
      emit("progress", { command: command, phase: "completed", requestId: context.requestId });
      return { ok: true, value: redactMediaValue(value) };
    } catch (error) {
      emit("progress", { command: command, phase: "failed", requestId: context.requestId });
      return normalizeMediaError(error);
    }
  }

  /** 应用退出：取消在途 worker（绝不写 Task / Job 状态）。 */
  function dispose() {
    let cancelled = 0;
    try { cancelled = runner.cancelAll("MEDIA_SHUTDOWN"); } catch { /* 已停 */ }
    return { cancelled: cancelled };
  }

  // B5f：媒体域 core 依赖 + B5e 扩展注入面（同一个 extensionDependencies 快照），
  // dependencies 给布尔事实，dependencyNotes 给每条 false 的原因（缺失不降级成假成功）。
  const dependencies = Object.freeze(Object.assign({
    userDataDir: !!userDataDir,
    mediaDir: !!mediaDir,
    database: !!db,
    identity: !!authorization,
    posterCache: !!posterCache,
    // 键名避开 isSecretKey 的子串（dxos-foundation-mask.cjs:12）
    runner: typeof runner.start === "function",
    workerEntry: !!workerEntry,
    // 键名避开 isSecretKey 的子串（dxos-foundation-mask.cjs:12）
    ffmpegBinary: !!ffmpegPath,
    ffprobeBinary: !!ffprobePath,
  }, extensionDependencies));

  return {
    execute,
    setEventSink,
    emitEvent: emit,
    dispose,
    posterCache,
    paths: mediaDir ? { root: mediaDir } : null,
    dependencies,
    dependencyNotes,
    leaseMs,
    /** 供测试与实验直接调用（不经 IPC）：受监督 worker 一步。 */
    runWorker,
    runOneRenderJob,
  };
}

module.exports = {
  createMediaBundle,
  configureMediaExtensions,
  // B5f：真实依赖装配件 / 探测（main.cjs 用；测试可直接复用同一实现做进程内真跑）
  createMediaProviderStore,
  createMediaModelGateway,
  createGuardedFetch,
  probeIllustratorAvailability,
  probeOnnxAvailability,
  findOnnxModelFile,
  HOST_APP_ID,
  DEFAULT_LEASE_MS,
  DEFAULT_WORKER_TIMEOUT_MS,
  DEFAULT_POSTER_TIMEOUT_MS,
};
