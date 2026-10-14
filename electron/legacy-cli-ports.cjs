/**
 * B7e2 后续 · cli:jimeng / cli:codex / cli:gemini 的 legacy 执行器端口实现。
 *
 * 背景（只读源：server/protocols.ts）：
 *   B2 把 protocols.ts 里三个 CLI 协议的执行分支留成结构化占位，一律返回
 *   { ok:false, error:"LEGACY_DEPENDENCY_UNAVAILABLE", detail:"cliTools / agentCliTools 批次未移植" }。
 *   B3 已交付 electron/agent-cli-tools.cjs（即梦）与 electron/agent-cli-bridge.cjs（codex / gemini /
 *   antigravity），本文件把它们按源调用点适配成 3 个 legacy 执行器端口（白名单见 legacy-executor-ports.cjs）：
 *
 *     cliJimeng(operation, payload)
 *       · "image.generate" 源 protocols.ts:5287-5294 generateJimengImage
 *       · "image.edit"     源 protocols.ts:6516-6525 generateJimengImage
 *       · "video.generate" 源 protocols.ts:6043-6061 generateJimengVideo
 *     cliCodex(operation, payload) / cliGemini(operation, payload)（tool = codex / gemini）
 *       · "image.generate" 源 protocols.ts:5295-5298 / 5299-5302
 *       · "image.edit"     源 protocols.ts:6527-6535 / 6536-6544
 *       · "chat"           源 protocols.ts:3649-3652 runAgentCliChat
 *       · "describeImage"  源 protocols.ts:6636-6645 runAgentCliChat（imagePaths）
 *       · "models"         agentCliModels（源 fetchModelCatalog 无 CLI 分支；此处补上，不再假报不可用）
 *
 * 返回值约定（与 legacy-executor-ports.cjs 一致，也是 B7e2 端口的约定）：
 *   成功 → 源协议形状：生成 / 编辑 { images, raw }，视频 { videos, raw }，对话 { text, latencyMs, raw }，
 *          图片理解 string，模型目录 [{ model, type }]；
 *   失败 → 结构化 { ok:false, error, detail }（CLI 未安装 / 入参非法 / 执行失败），绝不假成功。
 *
 * 为什么是一个 CLI 一个端口（而不是一个动作一个）：
 *   runninghub / modelscope 端口按源适配函数名拆分；三个 CLI 协议共享同一套 B3 适配器与同一个
 *   「CLI 已安装」前提，按协议族收敛成 3 个端口后，注入点（main.cjs）只需判 3 次安装状态。
 *
 * OUT（不引入）：api.dx-os.com、云发布 / 更新、云端实时房间。
 */

"use strict";

const fs = require("node:fs");
const agentCliTools = require("./agent-cli-tools.cjs");
const agentCliBridge = require("./agent-cli-bridge.cjs");
const { installLegacyExecutorPort } = require("./legacy-executor-ports.cjs");

/** 端口名（与 legacy-executor-ports.cjs 白名单同名）。 */
const LEGACY_CLI_PORT_NAMES = Object.freeze(["cliJimeng", "cliCodex", "cliGemini"]);

/** 协议 id（含别名）→ 端口名；执行器按协议分支取端口时使用。 */
const CLI_PROTOCOL_PORT = Object.freeze({
  "cli:jimeng": "cliJimeng",
  "jimeng-cli": "cliJimeng",
  "cli:codex": "cliCodex",
  "codex-cli": "cliCodex",
  "cli:gemini": "cliGemini",
  "gemini-cli": "cliGemini",
});

/** 每个端口支持的动作（诊断用）。 */
const CLI_PORT_OPERATIONS = Object.freeze({
  cliJimeng: Object.freeze(["image.generate", "image.edit", "video.generate"]),
  cliCodex: Object.freeze(["image.generate", "image.edit", "chat", "describeImage", "models"]),
  cliGemini: Object.freeze(["image.generate", "image.edit", "chat", "describeImage", "models"]),
});

/** 未安装时的可执行提示（注入点会据此跳过注册；端口内再查一次兜底）。 */
const CLI_INSTALL_HINT = Object.freeze({
  cliJimeng: "未检测到即梦（dreamina）CLI：端口未注入；安装后重启应用，或设置 JIMENG_BIN / DREAMINA_BIN",
  cliCodex: "未检测到 OpenAI Codex CLI：端口未注入；安装 codex 后重启应用，或设置 CODEX_BIN",
  cliGemini: "未检测到 Gemini / Antigravity CLI：端口未注入；安装 gemini / agy 后重启应用，或设置 GEMINI_BIN / ANTIGRAVITY_BIN",
});

const CLI_UNINSTALLED = "CLI_UNAVAILABLE";
const CLI_INVALID_INPUT = "LEGACY_CLI_INVALID_INPUT";
const CLI_EXECUTION_FAILED = "LEGACY_CLI_EXECUTION_FAILED";
const CLI_UNKNOWN_OPERATION = "LEGACY_CLI_UNKNOWN_OPERATION";

/** 源默认值：protocols.ts:5290 / :5296 / :5300 / :6521 / :6522 / :6523。 */
const JIMENG_DEFAULT_IMAGE_MODEL = "jimeng-5.0Pro";
const JIMENG_DEFAULT_VIDEO_MODEL = "seedance2.0fast";
const CODEX_DEFAULT_IMAGE_MODEL = "gpt-image-2";
const GEMINI_DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-image";
const CLI_CHAT_MIN_TIMEOUT_MS = 900000;

const MAX_DETAIL = 400;

const asStr = (value, max = 4096) => (typeof value === "string" ? value.slice(0, max) : value == null ? "" : String(value).slice(0, max));
const promptOf = (params) => String((params && params.prompt) || "").trim();

/** 源 protocols.ts:3454 messagesFrom。 */
function messagesFrom(input) {
  if (input && Array.isArray(input.messages) && input.messages.length) return input.messages;
  return [{ role: "user", content: String((input && input.prompt) || "ping") }];
}

/** 源 protocols.ts:3650 的 CLI 对话提示词拼装。 */
function cliChatPrompt(input) {
  return [
    input && input.system ? "系统要求：\n" + input.system : "",
    ...messagesFrom(input).map((message) => (message.role === "assistant" ? "助手" : "用户") + "：\n" + String(message.content == null ? "" : message.content)),
    "请直接回答用户，输出纯文本，不要修改项目文件。",
  ].filter(Boolean).join("\n\n");
}

/** 源形状 GenImage[] / GenVideo[]：type 固定 url（与源 map 一致，不擅改 b64）。 */
function toGenMedia(values) {
  return (Array.isArray(values) ? values : []).map((value) => ({ type: "url", value }));
}

function failure(error, detail) {
  return { ok: false, error, detail: asStr(detail, MAX_DETAIL) };
}

function createLegacyCliPorts(options = {}) {
  const tools = options.tools && typeof options.tools === "object" ? options.tools : agentCliTools;
  const bridge = options.bridge && typeof options.bridge === "object" ? options.bridge : agentCliBridge;

  /** 安装探测：任一实现缺失一律视为未安装（宁可不注入，也不假成功）。 */
  function detect(name) {
    try {
      if (name === "cliJimeng") return typeof tools.jimengCliInstalled === "function" && tools.jimengCliInstalled() === true;
      if (name === "cliCodex") return typeof bridge.agentCliInstalled === "function" && bridge.agentCliInstalled("codex") === true;
      if (name === "cliGemini") return typeof bridge.agentCliInstalled === "function" && bridge.agentCliInstalled("gemini") === true;
      return false;
    } catch { return false; }
  }

  const installed = {};
  for (const name of LEGACY_CLI_PORT_NAMES) installed[name] = detect(name);

  function cleanupTemp(paths) {
    for (const file of paths) { try { fs.unlinkSync(file); } catch { /* best effort temp cleanup */ } }
  }

  // 源 protocols.ts:5287-5294 / 6516-6525 / 6043-6061
  async function cliJimeng(operation, payload = {}) {
    if (!installed.cliJimeng) return failure(CLI_UNINSTALLED, CLI_INSTALL_HINT.cliJimeng);
    const params = payload.params && typeof payload.params === "object" ? payload.params : {};
    const { model } = payload;
    try {
      if (operation === "image.generate") {
        const result = await tools.generateJimengImage(promptOf(params), model || JIMENG_DEFAULT_IMAGE_MODEL, String(params.size || "1024x1024"));
        if (result && result.ok === false) return result;
        return { images: toGenMedia(result && result.images), raw: result && result.raw };
      }
      if (operation === "image.edit") {
        const inputs = Array.isArray(payload.inputs) ? payload.inputs : [];
        if (!inputs.length) return failure(CLI_INVALID_INPUT, "图像编辑需要至少一张参考图");
        // 参考图落临时文件；generateJimengImage 的 finally 负责删除（源 6518-6524 同此）。
        const imagePaths = inputs.map((input) => tools.tempMediaFile(input.buf, input.mime || "image/png", ".png"));
        const result = await tools.generateJimengImage(promptOf(params), model || JIMENG_DEFAULT_IMAGE_MODEL, String(params.size || "1024x1024"), imagePaths);
        if (result && result.ok === false) return result;
        return { images: toGenMedia(result && result.images), raw: result && result.raw };
      }
      if (operation === "video.generate") {
        const input = payload.input;
        const imageRefs = [...(Array.isArray(params.images) ? params.images : []), ...(input ? [{ ...input, kind: "image" }] : [])];
        const videoRefs = Array.isArray(params.videos) ? params.videos : [];
        const audioRefs = Array.isArray(params.audios) ? params.audios : [];
        const result = await tools.generateJimengVideo(promptOf(params), model || JIMENG_DEFAULT_VIDEO_MODEL, {
          imagePaths: imageRefs.map((ref) => tools.tempMediaFile(ref.buf, ref.mime || "image/png", ".png")),
          imageRoles: imageRefs.map((ref) => String(ref.role || "reference_image")),
          videoPaths: videoRefs.map((ref) => tools.tempMediaFile(ref.buf, ref.mime || "video/mp4", ".mp4")),
          audioPaths: audioRefs.map((ref) => tools.tempMediaFile(ref.buf, ref.mime || "audio/mpeg", ".mp3")),
          duration: Number(params.duration) || 5,
          aspect_ratio: String(params.aspect_ratio || params.size || "16:9"),
          resolution: params.resolution,
          multimodal: params.multimodal === true || videoRefs.length > 0 || audioRefs.length > 0,
        });
        if (result && result.ok === false) return result;
        return { videos: toGenMedia(result && result.videos), raw: result && result.raw };
      }
      return failure(CLI_UNKNOWN_OPERATION, "cliJimeng 不支持的动作：" + String(operation));
    } catch (error) {
      return failure(CLI_EXECUTION_FAILED, "即梦 CLI 执行失败：" + asStr((error && error.message) || error, MAX_DETAIL));
    }
  }

  // 源 protocols.ts:5295-5298 / 6527-6535 / 3649-3652 / 6636-6645；models 为端口补充
  async function agentPort(portName, tool, operation, payload) {
    if (!installed[portName]) return failure(CLI_UNINSTALLED, CLI_INSTALL_HINT[portName]);
    const params = payload.params && typeof payload.params === "object" ? payload.params : {};
    const { model, timeoutMs } = payload;
    const label = tool === "codex" ? "Codex" : "Gemini";
    try {
      if (operation === "image.generate") {
        const size = String(params.size || "1024x1024");
        const result = tool === "codex"
          ? await bridge.generateCodexImage(promptOf(params), model || CODEX_DEFAULT_IMAGE_MODEL, size)
          : await bridge.generateGeminiCliImage(promptOf(params), model || GEMINI_DEFAULT_IMAGE_MODEL, size, timeoutMs);
        return { images: toGenMedia(result && result.images), raw: result && result.raw };
      }
      if (operation === "image.edit") {
        const inputs = Array.isArray(payload.inputs) ? payload.inputs : [];
        if (!inputs.length) return failure(CLI_INVALID_INPUT, "图像编辑需要至少一张参考图");
        const imagePaths = inputs.map((input) => tools.tempMediaFile(input.buf, input.mime || "image/png", ".png"));
        try {
          const size = String(params.size || "1024x1024");
          const result = tool === "codex"
            ? await bridge.editCodexImage(promptOf(params), imagePaths, model || CODEX_DEFAULT_IMAGE_MODEL, size)
            : await bridge.editGeminiCliImage(promptOf(params), imagePaths, model || GEMINI_DEFAULT_IMAGE_MODEL, size, timeoutMs);
          return { images: toGenMedia(result && result.images), raw: result && result.raw };
        } finally {
          cleanupTemp(imagePaths); // 源 6532-6534 / 6541-6543
        }
      }
      if (operation === "chat") {
        const timeout = Math.max(Number(timeoutMs) || 0, CLI_CHAT_MIN_TIMEOUT_MS); // 源 3651
        return await bridge.runAgentCliChat(tool, cliChatPrompt(payload.input), model, timeout);
      }
      if (operation === "describeImage") {
        const dataUrls = Array.isArray(payload.dataUrls) ? payload.dataUrls : [];
        const imagePaths = dataUrls.map((value) => {
          const match = String(value).match(/^data:([^;,]+);base64,(.+)$/s); // 源 6638
          if (!match) throw new Error("CLI 图片理解只支持本地图片数据。");
          const extension = match[1].includes("jpeg") ? ".jpg" : match[1].includes("webp") ? ".webp" : ".png";
          return tools.tempMediaFile(Buffer.from(match[2], "base64"), match[1], extension);
        });
        try {
          const response = await bridge.runAgentCliChat(tool, String(payload.prompt || "") + "\n\n请直接回答用户，输出纯文本，不要修改项目文件。", model, timeoutMs, { imagePaths });
          return String((response && response.text) || "");
        } finally {
          // 源描述里没有 finally（临时文件会留在 <tmp>/DXOS/cli-temp）；端口这里 best-effort 清理，语义不变。
          cleanupTemp(imagePaths);
        }
      }
      if (operation === "models") {
        const catalog = await bridge.agentCliModels(tool);
        const items = Array.isArray(catalog && catalog.model_items) ? catalog.model_items : [];
        return items.map((item) => ({ model: item.model, name: item.name, type: item.type }));
      }
      return failure(CLI_UNKNOWN_OPERATION, portName + " 不支持的动作：" + String(operation));
    } catch (error) {
      return failure(CLI_EXECUTION_FAILED, label + " CLI 执行失败：" + asStr((error && error.message) || error, MAX_DETAIL));
    }
  }

  const ports = {
    cliJimeng,
    cliCodex: (operation, payload) => agentPort("cliCodex", "codex", operation, payload),
    cliGemini: (operation, payload) => agentPort("cliGemini", "gemini", operation, payload),
  };

  const reasons = {};
  for (const name of LEGACY_CLI_PORT_NAMES) reasons[name] = installed[name] ? "" : CLI_INSTALL_HINT[name];

  return { ports, installed, reasons, operations: CLI_PORT_OPERATIONS };
}

/**
 * 按「对应 CLI 是否已安装」注册端口：已安装才注册，未安装如实跳过（执行器继续结构化不可用）。
 * options.tools / options.bridge 可注入替身（离线测试）；options.install === false 则只探测不注册。
 */
function installLegacyCliPorts(options = {}) {
  const created = createLegacyCliPorts(options);
  const enabled = options.install !== false;
  const applied = [];
  const skipped = [];
  for (const name of LEGACY_CLI_PORT_NAMES) {
    if (!enabled || !created.installed[name]) { skipped.push(name); continue; }
    const result = installLegacyExecutorPort(name, created.ports[name]);
    if (result && result.ok) applied.push(name);
    else skipped.push(name);
  }
  return { applied: applied.sort(), skipped: skipped.sort(), installed: created.installed, reasons: created.reasons, operations: CLI_PORT_OPERATIONS };
}

module.exports = {
  LEGACY_CLI_PORT_NAMES,
  CLI_PROTOCOL_PORT,
  CLI_PORT_OPERATIONS,
  CLI_INSTALL_HINT,
  CLI_UNINSTALLED,
  CLI_INVALID_INPUT,
  CLI_EXECUTION_FAILED,
  CLI_UNKNOWN_OPERATION,
  createLegacyCliPorts,
  installLegacyCliPorts,
};
