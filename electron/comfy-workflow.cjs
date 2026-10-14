"use strict";
/**
 * B7e1 · ComfyUI 工作流纯逻辑（解析 / 参数校验 / 节点映射 / 能力推断 / 运行结果提取）。
 *
 * 为什么与 service 分开：这些函数是"工作流事实"的唯一判定点，必须能脱离 Electron、
 * 脱离网络、脱离子进程单独钉死；service 只负责编排与回推事件，worker 只负责真实 I/O。
 *
 * ## 来源（只读参照 DX OS 0.5.1 app.asar.unpacked/server，行号为源行号）
 *   · comfyui.ts:14-32          normalizeComfyPath / normalizeComfyBaseUrl
 *   · comfyui.ts:34-46          defaultRoot（COMFYUI_ROOT 覆盖 → 便携目录探测）
 *   · comfyui.ts:106-179        parseArgs / normalizeInstance / normalizeComfyLanHost /
 *                               portablePathNeedsRebase / resolveComfyLocalPaths
 *   · comfyui.ts:181-213        normalizeComfyConfig（id / 端口去重）
 *   · comfyui.ts:540-553        comfyInstanceBaseUrl
 *   · comfyWorkflows.ts:17-25   ComfyFieldType / Capability / InputRole / OutputRole 集合
 *   · comfyWorkflows.ts:73-81   randomComfySeed
 *   · comfyWorkflows.ts:83-116  COMFY_CAPABILITIES / COMFY_INPUT_ROLES / COMFY_OUTPUT_ROLES /
 *                               inferComfyWorkflowCapabilities
 *   · comfyWorkflows.ts:118-136 comfyWorkflowAgentManifest
 *   · comfyWorkflows.ts:144-171 bundledComfyWorkflows / withBundledComfyWorkflows（旧 ID 一次迁移）
 *   · comfyWorkflows.ts:244-264 comfyMediaSlotIndex / mapComfyMediaFields
 *   · comfyWorkflows.ts:340-367 apiWorkflow（逐字错误文案）
 *   · comfyWorkflows.ts:369-406 safeFields
 *   · comfyWorkflows.ts:408-466 connectedSourceIds / pruneSkippedComfyBranches
 *   · comfyWorkflows.ts:468-497 safeOutputs / inspectComfyWorkflow
 *   · comfyWorkflows.ts:721-764 comfyResultsFromHistory
 *   · comfyWorkflows.ts:804-836 executeRun 的参数应用段（本文件抽成 prepareComfyRun，纯函数）
 *
 * ## 与源不同的点（有意为之）
 *   · 随包 workflows 不再从 import.meta.url 读磁盘（CJS 没有 import.meta），而是把三份内置
 *     API 工作流随包内嵌为常量；loadBundledWorkflows(dir) 仍支持从外部目录增量加载（本地导入）。
 *   · prepareComfyRun 是源 executeRun:804-836 的**纯函数化**：把"上传文件"从主进程挪到受监督
 *     worker，因此这里只产出 uploads 清单（fieldId / nodeId / input / name / mime），不碰网络。
 *   · 非 Windows 平台不猜测 E:\ 便携目录；默认根为空，交由 service 判断"依赖缺失"。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomInt, randomUUID } = require("node:crypto");

const comfyDomain = require("./comfy-domain.cjs");

const {
  COMFY_ERR_INVALID_INPUT,
  createComfyError,
  comfyWorkflowInvalid,
} = comfyDomain;

const COMFY_RANDOM_SEED_MAX = 0xFFFFFFFF;
const AUTO_INSTANCE_ID = "auto";

/** comfyWorkflows.ts:17-25 */
const COMFY_FIELD_TYPES = Object.freeze(["image", "video", "audio", "file", "text", "textarea", "number", "slider", "select", "boolean", "seed"]);
const MEDIA_FIELD_TYPES = Object.freeze(["image", "video", "audio", "file"]);

const COMFY_CAPABILITIES = new Set([
  "media.image.generate", "media.image.edit", "media.image.upscale",
  "media.video.generate", "media.video.image_to_video", "media.video.first_last_frame", "media.video.multi_reference",
  "media.video.video_to_video", "media.video.audio_reference", "media.video.multimodal",
  "media.audio.synthesize", "media.audio.music_generate", "app.comfy.workflow.run",
]);
const COMFY_INPUT_ROLES = new Set([
  "source_image", "reference_image", "style_reference", "character_reference", "product_reference",
  "first_frame", "last_frame", "mask", "control_image", "source_video", "reference_video",
  "audio", "voice_reference", "prompt", "negative_prompt", "parameter",
]);
const COMFY_OUTPUT_ROLES = new Set(["result", "preview", "mask", "control", "intermediate"]);

const ALLOWED_OUTPUT_TYPES = Object.freeze(["image", "video", "audio", "file", "text"]);

// ---------------------------------------------------------------------------
// 路径 / 地址规约（源 comfyui.ts:14-179）
// ---------------------------------------------------------------------------

/** 源 comfyui.ts:15-20 —— 接受从文档 / 终端 / 富文本复制来的路径。 */
function normalizeComfyPath(value) {
  return String(value || "")
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .trim();
}

/** 源 comfyui.ts:22-32 —— 只认 http/https、无账号密码 / query / hash 的绝对地址。 */
function normalizeComfyBaseUrl(value) {
  const raw = normalizeComfyPath(value).replace(/\/+$/, "");
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/** 源 comfyui.ts:132-136 */
function normalizeComfyLanHost(value) {
  const host = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!host || host.includes("/") || host.includes("@") || host.includes(":") || !/^[a-z0-9.-]+$/i.test(host)) return "";
  return host;
}

/**
 * 源 comfyui.ts:34-46 的 defaultRoot。
 * Windows 分支逐字保留；非 Windows 只探测少数常见位置，探测不到返回空串
 * （"缺什么"必须由依赖探测如实报告，不猜一个不存在的路径去假装可用）。
 */
function defaultComfyRoot(env = process.env) {
  const configured = normalizeComfyPath(env.COMFYUI_ROOT);
  if (configured) return configured;
  if (process.platform === "win32") {
    for (let code = 67; code <= 67 + 25; code += 1) {
      const candidate = String.fromCharCode(code) + ":\\ComfyUI_windows_portable";
      if (fs.existsSync(path.join(candidate, "python_embeded", "python.exe")) && fs.existsSync(path.join(candidate, "ComfyUI", "main.py"))) {
        return candidate;
      }
    }
    return "E:\\ComfyUI_windows_portable";
  }
  const home = os.homedir();
  const candidates = [
    env.COMFYUI_HOME ? normalizeComfyPath(env.COMFYUI_HOME) : "",
    home ? path.join(home, "ComfyUI") : "",
    "/opt/ComfyUI",
    "/usr/local/ComfyUI",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "main.py")) || fs.existsSync(path.join(candidate, "ComfyUI", "main.py"))) return candidate;
  }
  return "";
}

/** 源 comfyui.ts:138-144 */
function portablePathNeedsRebase(value, rootDir, suffix) {
  if (!value || process.platform !== "win32") return false;
  const normalizedPath = path.win32.normalize(value).toLowerCase();
  const normalizedRoot = path.win32.normalize(rootDir).toLowerCase();
  const expectedSuffix = path.win32.join("ComfyUI_windows_portable", ...suffix).toLowerCase();
  return normalizedPath.endsWith(expectedSuffix) && !normalizedPath.startsWith(normalizedRoot + "\\");
}

/** 源 comfyui.ts:146-179；候选表按平台补齐 POSIX 运行时（Windows 表逐字保留）。 */
function resolveComfyLocalPaths(rootDirValue, pythonPathValue, mainPathValue) {
  const rootDir = normalizeComfyPath(rootDirValue);
  const sourceLayout = path.basename(rootDir).toLowerCase() === "comfyui";
  const insideRoot = (candidate) => {
    if (!candidate) return false;
    const relative = path.relative(path.resolve(rootDir), path.resolve(candidate));
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  };
  const mainCandidates = [
    path.join(rootDir, "ComfyUI", "main.py"),
    path.join(rootDir, "main.py"),
    path.join(rootDir, "resources", "ComfyUI", "main.py"),
    path.join(rootDir, "resources", "app", "ComfyUI", "main.py"),
  ];
  const windowsPython = [
    path.join(rootDir, "python_embeded", "python.exe"),
    path.join(rootDir, ".venv", "Scripts", "python.exe"),
    path.join(rootDir, "venv", "Scripts", "python.exe"),
    path.join(rootDir, "python.exe"),
    path.join(rootDir, "ComfyUI", ".venv", "Scripts", "python.exe"),
    path.join(rootDir, "ComfyUI", "venv", "Scripts", "python.exe"),
  ];
  const posixPython = [
    path.join(rootDir, "python_embeded", "bin", "python3"),
    path.join(rootDir, ".venv", "bin", "python"),
    path.join(rootDir, "venv", "bin", "python"),
    path.join(rootDir, "bin", "python"),
    path.join(rootDir, "ComfyUI", ".venv", "bin", "python"),
    path.join(rootDir, "ComfyUI", "venv", "bin", "python"),
  ];
  const pythonCandidates = process.platform === "win32" ? windowsPython : posixPython;
  const configuredMain = normalizeComfyPath(mainPathValue);
  const configuredPython = normalizeComfyPath(pythonPathValue);
  return {
    mainPath: mainCandidates.find((candidate) => fs.existsSync(candidate))
      || (configuredMain && insideRoot(configuredMain) && fs.existsSync(configuredMain) ? configuredMain : sourceLayout ? mainCandidates[1] : mainCandidates[0]),
    // 打包版 ComfyUI 的 Python 运行时可能在 rootDir 之外：显式路径原样保留，
    // 存在性交给状态 / 启动校验，不静默替换成别的解释器（源 comfyui.ts:172-177 同义）。
    pythonPath: configuredPython
      || pythonCandidates.find((candidate) => fs.existsSync(candidate))
      || (sourceLayout ? pythonCandidates[1] : pythonCandidates[0]),
  };
}

/** 源 comfyui.ts:106-108 */
function parseComfyArgs(text) {
  return (String(text || "").match(/(?:[^\s"]+|"[^"]*")+/g) || []).map((arg) => arg.replace(/^"|"$/g, ""));
}

/** 源 comfyui.ts:110-130 —— mode 只保留 local / lan / remote（runninghub / tunnel 为云端服务，OUT）。 */
function normalizeComfyInstance(input, index) {
  const source = input && typeof input === "object" ? input : {};
  const gpu = Number.isFinite(Number(source.gpu)) ? Math.max(0, Math.floor(Number(source.gpu))) : index;
  const port = Number.isFinite(Number(source.port)) ? Math.max(1, Math.min(65535, Math.floor(Number(source.port)))) : 8288 + index;
  const id = String(source.id || ("gpu-" + gpu)).trim().replace(/[^a-zA-Z0-9_-]/g, "-") || ("gpu-" + index);
  const mode = source.mode === "lan" || source.mode === "remote" ? source.mode : "local";
  return {
    id: id,
    name: String(source.name || ("GPU " + gpu)).trim() || ("GPU " + gpu),
    mode: mode,
    gpu: gpu,
    port: port,
    enabled: source.enabled !== false,
    baseUrl: normalizeComfyBaseUrl(source.baseUrl) || undefined,
    lanHost: normalizeComfyLanHost(source.lanHost) || undefined,
    outputDir: normalizeComfyPath(source.outputDir) || undefined,
    extraArgs: String(source.extraArgs || "").trim() || undefined,
  };
}

/** 源 comfyui.ts:86-100 的默认配置（Windows 便携默认值保留，其它平台根目录由探测决定）。 */
function defaultComfyConfig(env = process.env) {
  const rootDir = defaultComfyRoot(env);
  return {
    rootDir: rootDir,
    pythonPath: rootDir ? path.join(rootDir, "python_embeded", process.platform === "win32" ? "python.exe" : path.join("bin", "python3")) : "",
    mainPath: rootDir ? path.join(rootDir, "ComfyUI", "main.py") : "",
    listen: "127.0.0.1",
    outputDir: "",
    extraArgs: "",
    instances: [
      { id: "gpu-0", name: "本机 ComfyUI", mode: "local", gpu: 0, port: 8188, enabled: true },
    ],
  };
}

/**
 * 源 comfyui.ts:181-213 的 normalizeComfyConfig。
 * 差异：仅纯配置归一化，不读写磁盘（落盘在 comfy-store.cjs）。
 */
function normalizeComfyConfig(input, options = {}) {
  const base = defaultComfyConfig(options.env);
  const source = input && typeof input === "object" ? input : {};
  const rootDir = normalizeComfyPath(source.rootDir) || base.rootDir;
  let resolved = resolveComfyLocalPaths(rootDir, source.pythonPath, source.mainPath);
  let mainPath = resolved.mainPath;
  let pythonPath = resolved.pythonPath;
  if (portablePathNeedsRebase(mainPath, rootDir, ["ComfyUI", "main.py"])) {
    mainPath = path.join(rootDir, "ComfyUI", "main.py");
  }
  const config = {
    rootDir: rootDir,
    pythonPath: pythonPath,
    mainPath: mainPath,
    listen: String(source.listen || base.listen).trim() || "127.0.0.1",
    outputDir: normalizeComfyPath(source.outputDir) || base.outputDir,
    extraArgs: String(source.extraArgs || base.extraArgs).trim(),
    instances: Array.isArray(source.instances) ? source.instances.map(normalizeComfyInstance) : base.instances,
  };
  const seenIds = new Set();
  const seenPorts = new Set();
  config.instances = config.instances.map((inst, index) => {
    const baseId = inst.id;
    let id = baseId;
    let idSuffix = 2;
    while (seenIds.has(id)) id = baseId + "-" + (idSuffix++);
    seenIds.add(id);
    // 源 comfyui.ts:205-209：端口冲突只在后出现的实例上解决，保留先出现的实例端口。
    if (seenPorts.has(inst.port)) inst.port = 8288 + index;
    while (seenPorts.has(inst.port)) inst.port += 1;
    seenPorts.add(inst.port);
    return { ...inst, id: id };
  });
  return config;
}

/** 源 comfyui.ts:540-553 —— 只保留 local / lan / remote 三支。 */
function comfyInstanceBaseUrl(config, inst) {
  const instance = inst && typeof inst === "object" ? inst : {};
  if (instance.mode === "remote") {
    const baseUrl = normalizeComfyBaseUrl(instance.baseUrl);
    if (!baseUrl) throw createComfyError(COMFY_ERR_INVALID_INPUT, "云端 ComfyUI 地址无效，请填写完整的 HTTP 或 HTTPS 地址");
    return baseUrl;
  }
  if (instance.mode === "lan") {
    const host = normalizeComfyLanHost(instance.lanHost);
    if (!host) throw createComfyError(COMFY_ERR_INVALID_INPUT, "局域网 ComfyUI 地址无效，请填写 IP 或主机名");
    return "http://" + host + ":" + instance.port;
  }
  const listen = config && config.listen ? config.listen : "127.0.0.1";
  const host = listen === "0.0.0.0" ? "127.0.0.1" : listen;
  return "http://" + host + ":" + instance.port;
}

// ---------------------------------------------------------------------------
// 能力推断 / Agent 清单（源 comfyWorkflows.ts:83-136）
// ---------------------------------------------------------------------------

/** 源 comfyWorkflows.ts:96-116 */
function inferComfyWorkflowCapabilities(fields, outputs) {
  const primaryOutputs = outputs.filter((output) => output.primary !== false && (output.role === "result" || output.primary === true));
  const outputKinds = new Set((primaryOutputs.length ? primaryOutputs : outputs).map((output) => output.type));
  const mediaFields = fields.filter((field) => ["image", "video", "audio"].includes(field.type));
  const images = mediaFields.filter((field) => field.type === "image");
  const videos = mediaFields.filter((field) => field.type === "video");
  const audios = mediaFields.filter((field) => field.type === "audio");
  const capabilities = new Set(["app.comfy.workflow.run"]);
  if (outputKinds.has("image")) capabilities.add(images.length ? "media.image.edit" : "media.image.generate");
  if (outputKinds.has("video")) {
    if (images.some((field) => field.role === "first_frame") && images.some((field) => field.role === "last_frame")) capabilities.add("media.video.first_last_frame");
    else if ((images.length && (videos.length || audios.length)) || (videos.length && audios.length)) capabilities.add("media.video.multimodal");
    else if (images.length > 1) capabilities.add("media.video.multi_reference");
    else if (images.length === 1) capabilities.add("media.video.image_to_video");
    else if (videos.length) capabilities.add("media.video.video_to_video");
    else if (audios.length) capabilities.add("media.video.audio_reference");
    else capabilities.add("media.video.generate");
  }
  if (outputKinds.has("audio")) capabilities.add("media.audio.synthesize");
  return [...capabilities];
}

/** 源 comfyWorkflows.ts:118-136 */
function comfyWorkflowAgentManifest(preset) {
  const capabilities = (preset.capabilities || []).filter((value) => COMFY_CAPABILITIES.has(value));
  const declaredOrInferred = capabilities.length ? capabilities : inferComfyWorkflowCapabilities(preset.fields || [], preset.outputs || []);
  const fields = preset.fields || [];
  const outputs = preset.outputs || [];
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    summary: String(preset.agentSummary || preset.description || preset.name || "").slice(0, 500),
    aliases: (preset.aliases || []).slice(0, 20),
    capabilities: [...new Set(["app.comfy.workflow.run", ...declaredOrInferred])],
    recommended: preset.recommended === true,
    inputs: fields.map((field) => ({
      id: field.id,
      label: field.label,
      type: field.type,
      role: field.role || (field.type === "text" || field.type === "textarea" ? "prompt" : field.type === "audio" ? "audio" : field.type === "image" ? "reference_image" : field.type === "video" ? "reference_video" : "parameter"),
      required: field.required === true,
      ...(field.mediaSlot ? { slot: field.mediaSlot } : {}),
      ...(field.description ? { description: field.description } : {}),
    })),
    outputs: outputs.map((output, index) => ({
      id: output.id,
      label: output.label,
      type: output.type,
      role: output.role || "result",
      primary: output.primary === true || (!outputs.some((item) => item.primary === true) && index === 0),
    })),
  };
}

// ---------------------------------------------------------------------------
// 随机种子 / 媒体槽位（源 comfyWorkflows.ts:73-81 / 244-264）
// ---------------------------------------------------------------------------

/** 源 comfyWorkflows.ts:73-81 */
function randomComfySeed(field) {
  const configuredMin = Number(field && field.min);
  const configuredMax = Number(field && field.max);
  const min = Number.isFinite(configuredMin) ? Math.max(0, Math.ceil(configuredMin)) : 0;
  const max = Number.isFinite(configuredMax)
    ? Math.max(min, Math.min(COMFY_RANDOM_SEED_MAX, Math.floor(configuredMax)))
    : Math.max(min, COMFY_RANDOM_SEED_MAX);
  return randomInt(min, max + 1);
}

/** 源 comfyWorkflows.ts:244-246 */
function comfyMediaSlotIndex(field, fallbackIndex) {
  return Number(field && field.mediaSlot) > 0 ? Math.floor(Number(field.mediaSlot)) - 1 : fallbackIndex;
}

/** 源 comfyWorkflows.ts:248-264 */
function mapComfyMediaFields(fields, inputs) {
  const cursor = { image: 0, video: 0, audio: 0, file: 0 };
  const mapped = new Map();
  const missingRequired = [];
  for (const field of fields) {
    if (!MEDIA_FIELD_TYPES.includes(field.type)) continue;
    const index = comfyMediaSlotIndex(field, cursor[field.type]);
    cursor[field.type] = Math.max(cursor[field.type], index + 1);
    const input = inputs[field.type][index];
    if (input !== undefined) mapped.set(field.id, input);
    else if (field.required) missingRequired.push(field);
  }
  return { mapped: mapped, missingRequired: missingRequired };
}

// ---------------------------------------------------------------------------
// 工作流解析 / 字段 / 输出（源 comfyWorkflows.ts:340-497，逐字）
// ---------------------------------------------------------------------------

/** 源 comfyWorkflows.ts:340-367 */
function apiWorkflow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw comfyWorkflowInvalid("工作流必须是 JSON 对象");
  const source = value;
  if (Array.isArray(source.nodes) && !Object.values(source).some((item) => item && typeof item === "object" && !Array.isArray(item) && typeof item.class_type === "string")) {
    throw comfyWorkflowInvalid("这不是 ComfyUI API 工作流，请在 ComfyUI 中选择“导出（API）”");
  }
  const prompt = source.prompt && typeof source.prompt === "object" && !Array.isArray(source.prompt) ? source.prompt : source;
  const entries = Object.entries(prompt);
  if (!entries.length) throw comfyWorkflowInvalid("工作流中没有节点");
  const normalized = {};
  for (const [nodeId, raw] of entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw comfyWorkflowInvalid("节点 " + nodeId + " 格式无效");
    const node = raw;
    if (typeof node.class_type !== "string" || !node.class_type) {
      throw comfyWorkflowInvalid("这不是 ComfyUI API 工作流，请在 ComfyUI 中选择“导出（API）”");
    }
    normalized[nodeId] = {
      class_type: node.class_type,
      inputs: node.inputs && typeof node.inputs === "object" && !Array.isArray(node.inputs) ? structuredClone(node.inputs) : {},
      ...(node._meta && typeof node._meta === "object" ? { _meta: structuredClone(node._meta) } : {}),
    };
  }
  return normalized;
}

/** 源 comfyWorkflows.ts:369-406 */
function safeFields(value, workflow) {
  if (!Array.isArray(value)) return [];
  const usedMediaSlots = new Map();
  return value.map((raw, index) => {
    const item = raw && typeof raw === "object" ? raw : {};
    const nodeId = String(item.nodeId || "");
    const input = String(item.input || "");
    if (!workflow[nodeId] || !(input in workflow[nodeId].inputs)) throw comfyWorkflowInvalid("映射字段 " + (index + 1) + " 指向不存在的节点输入");
    const type = COMFY_FIELD_TYPES.includes(item.type) ? item.type : "text";
    const mediaType = MEDIA_FIELD_TYPES.includes(type);
    let mediaSlot;
    if (mediaType) {
      const used = usedMediaSlots.get(type) || new Set();
      mediaSlot = Math.min(20, Math.max(1, Math.floor(Number(item.mediaSlot) || 1)));
      while (used.has(mediaSlot) && mediaSlot < 20) mediaSlot += 1;
      if (used.has(mediaSlot)) throw comfyWorkflowInvalid(type + " 映射槽位超过 20 个");
      used.add(mediaSlot);
      usedMediaSlots.set(type, used);
    }
    return {
      id: String(item.id || randomUUID()),
      label: String(item.label || input),
      type: type,
      nodeId: nodeId,
      input: input,
      ...(item.description ? { description: String(item.description) } : {}),
      ...("default" in item ? { default: item.default } : {}),
      required: item.required === true,
      ...(COMFY_INPUT_ROLES.has(item.role) ? { role: item.role } : {}),
      ...(mediaSlot ? { mediaSlot: mediaSlot, missingPolicy: item.missingPolicy === "default" ? "default" : "skip" } : {}),
      ...(Number.isFinite(Number(item.min)) ? { min: Number(item.min) } : {}),
      ...(Number.isFinite(Number(item.max)) ? { max: Number(item.max) } : {}),
      ...(Number.isFinite(Number(item.step)) ? { step: Number(item.step) } : {}),
      ...(Array.isArray(item.options) ? { options: item.options.map((option) => ({ label: String(option.label), value: option.value })) } : {}),
    };
  });
}

/** 源 comfyWorkflows.ts:468-484 */
function safeOutputs(value, workflow) {
  if (!Array.isArray(value)) return [];
  return value.map((raw, index) => {
    const item = raw && typeof raw === "object" ? raw : {};
    const nodeId = String(item.nodeId || "");
    if (!workflow[nodeId]) throw comfyWorkflowInvalid("输出 " + (index + 1) + " 指向不存在的节点");
    return {
      id: String(item.id || randomUUID()),
      label: String(item.label || workflow[nodeId]._meta && workflow[nodeId]._meta.title || ("输出 " + (index + 1))),
      nodeId: nodeId,
      type: ALLOWED_OUTPUT_TYPES.includes(item.type) ? item.type : "image",
      ...(COMFY_OUTPUT_ROLES.has(item.role) ? { role: item.role } : { role: "result" }),
      primary: item.primary === true,
    };
  });
}

/** 源 comfyWorkflows.ts:408-412 */
function connectedSourceIds(node) {
  return Object.values(node.inputs)
    .filter((value) => Array.isArray(value) && value.length === 2)
    .map((value) => String(value[0]));
}

/** 源 comfyWorkflows.ts:414-466（含"未传可选素材会关闭全部输出"的拒绝语义）。 */
function pruneSkippedComfyBranches(prompt, skippedRootIds, outputNodeIds, mediaRootIds) {
  const skippedRootList = [...skippedRootIds];
  const skippedRoots = new Set(skippedRootList.filter((id) => !!prompt[id]));
  const mediaRoots = new Set([...(mediaRootIds || skippedRootList)].filter((id) => !!prompt[id]));
  const mediaOrigins = new Map();
  for (const nodeId of Object.keys(prompt)) mediaOrigins.set(nodeId, new Set(mediaRoots.has(nodeId) ? [nodeId] : []));

  let changed = true;
  while (changed) {
    changed = false;
    for (const [nodeId, node] of Object.entries(prompt)) {
      const origins = mediaOrigins.get(nodeId);
      for (const sourceId of connectedSourceIds(node)) {
        for (const origin of mediaOrigins.get(sourceId) || []) {
          if (origins.has(origin)) continue;
          origins.add(origin);
          changed = true;
        }
      }
    }
  }

  const skipped = new Set(skippedRoots);
  for (const [nodeId, origins] of mediaOrigins) {
    if (!origins.size || skipped.has(nodeId)) continue;
    if ([...origins].every((origin) => skippedRoots.has(origin))) skipped.add(nodeId);
  }
  const outputs = [...outputNodeIds];
  if (outputs.length && outputs.every((nodeId) => skipped.has(nodeId))) {
    throw createComfyError(COMFY_ERR_INVALID_INPUT, "未传入的可选素材会关闭当前工作流的全部输出；请使用支持可变输入的批次/列表节点，或把该字段的缺省策略改为“使用默认素材”");
  }
  for (const nodeId of skipped) delete prompt[nodeId];
  for (const node of Object.values(prompt)) {
    for (const [input, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 && skipped.has(String(value[0]))) delete node.inputs[input];
    }
  }
  return skipped;
}

/** 源 comfyWorkflows.ts:486-497 */
function inspectComfyWorkflow(value) {
  const workflow = apiWorkflow(value);
  return {
    workflow: workflow,
    nodes: Object.entries(workflow).map(([id, node]) => ({
      id: id,
      classType: node.class_type,
      title: String(node._meta && node._meta.title || node.class_type),
      inputs: Object.entries(node.inputs).map(([name, value]) => ({ name: name, value: value, connected: Array.isArray(value) && value.length === 2 })),
    })),
  };
}

// ---------------------------------------------------------------------------
// 运行参数应用（源 comfyWorkflows.ts:804-836 的纯函数化）
// ---------------------------------------------------------------------------

/**
 * 校验并应用一次运行参数。
 *   preset  已校验的工作流定义（fields / outputs / workflow）
 *   values  { fieldId: value }（渲染层给的值）
 *   files   { fieldId: { name, mime } }（已解码的媒体清单；字节由 worker 持有）
 * 返回 { prompt, skipped, uploads }；任何非法映射 / 缺必填 / 可选素材关闭全部输出都抛结构化错误。
 */
function prepareComfyRun(preset, values, files) {
  const provided = values && typeof values === "object" ? values : {};
  const fileMap = files && typeof files === "object" ? files : {};
  const fields = Array.isArray(preset.fields) ? preset.fields : [];
  const outputs = Array.isArray(preset.outputs) ? preset.outputs : [];
  const prompt = structuredClone(preset.workflow);
  const skippedRoots = new Set();
  const uploads = [];
  const suppliedMediaNodes = new Set(Object.keys(fileMap).map((fieldId) => {
    const field = fields.find((item) => item.id === fieldId);
    return field ? field.nodeId : null;
  }).filter(Boolean));
  for (const field of fields) {
    const node = prompt[field.nodeId];
    if (!node) throw comfyWorkflowInvalid("映射节点已不存在：" + field.nodeId);
    if (MEDIA_FIELD_TYPES.includes(field.type)) {
      const file = fileMap[field.id];
      if (!file) {
        if (field.required) throw createComfyError(COMFY_ERR_INVALID_INPUT, "请上传" + field.label);
        if (field.missingPolicy !== "default") {
          if (suppliedMediaNodes.has(field.nodeId)) throw createComfyError(COMFY_ERR_INVALID_INPUT, "节点 " + field.nodeId + " 同时包含已提供和未提供的媒体映射，无法只跳过其中一个输入");
          skippedRoots.add(field.nodeId);
        }
        continue;
      }
      uploads.push({
        fieldId: field.id,
        nodeId: field.nodeId,
        input: field.input,
        name: String(file.name || "upload.bin").slice(0, 200),
        mime: String(file.mime || "application/octet-stream").slice(0, 120),
      });
      continue;
    }
    let value = field.id in provided ? provided[field.id] : field.default;
    if (field.type === "seed" && (value === "" || value === -1 || value === "random")) value = randomComfySeed(field);
    if (value === undefined && field.required) throw createComfyError(COMFY_ERR_INVALID_INPUT, "请填写" + field.label);
    if (value !== undefined) node.inputs[field.input] = value;
  }
  const mediaRootIds = fields.filter((field) => MEDIA_FIELD_TYPES.includes(field.type)).map((field) => field.nodeId);
  const skipped = pruneSkippedComfyBranches(prompt, skippedRoots, outputs.map((output) => output.nodeId), mediaRootIds);
  return { prompt: prompt, skipped: skipped, uploads: uploads };
}

/** 源 comfyWorkflows.ts:721-764 */
function comfyResultsFromHistory(preset, item) {
  const wanted = new Set((preset.outputs || []).map((output) => output.nodeId));
  const outputMappings = new Map((preset.outputs || []).map((output) => [output.nodeId, output]));
  const results = [];
  const seenOutputFiles = new Set();
  for (const [nodeId, output] of Object.entries(item.outputs || {})) {
    if (wanted.size && !wanted.has(nodeId)) continue;
    const mapping = outputMappings.get(nodeId);
    for (const key of ["images", "gifs", "videos", "audio"]) {
      const values = Array.isArray(output[key]) ? output[key] : [];
      for (const file of values) {
        const name = String(file.filename || file.name || "");
        if (!name) continue;
        const subfolder = String(file.subfolder || "");
        const outputType = String(file.type || "output");
        const fileKey = outputType + ":" + subfolder + ":" + name;
        if (seenOutputFiles.has(fileKey)) continue;
        seenOutputFiles.add(fileKey);
        results.push({
          name: name,
          type: mapping && mapping.type && mapping.type !== "text" ? mapping.type : key === "images" ? "image" : key === "audio" ? "audio" : "video",
          subfolder: subfolder,
          outputType: outputType,
          nodeId: nodeId,
          label: mapping && mapping.label,
        });
      }
    }
    if (mapping && mapping.type === "text") {
      const textValues = [];
      const collectText = (value) => {
        if (typeof value === "string" && value.trim()) textValues.push(value.trim());
        else if (Array.isArray(value)) value.forEach(collectText);
      };
      for (const [key, value] of Object.entries(output)) {
        if (["images", "gifs", "videos", "audio"].includes(key)) continue;
        if (/^(text|texts|string|strings|value|values|result|results|output)$/i.test(key)) collectText(value);
      }
      for (const [index, text] of [...new Set(textValues)].entries()) {
        results.push({ name: mapping.label || ("文字输出 " + (index + 1)), type: "text", nodeId: nodeId, label: mapping.label, text: text });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 随包工作流（源 comfyWorkflows.ts:144-171）
// ---------------------------------------------------------------------------

/** 源 BUNDLED_COMFY_WORKFLOW_SOURCES 的 legacyIds（导入时的一次性身份迁移）。 */
const BUNDLED_COMFY_WORKFLOW_LEGACY_IDS = Object.freeze([[], ["c4af11de-46f0-4f6e-a869-48a25caed26c"], ["87642386-c837-41d6-afcb-d78b6b3ac2d9"]]);

// 三份内置 API 工作流（MiniMax-H3 / Qwen2.1 文生图 / Qwen2.1 图生图）随包内嵌；
// 源用 import.meta.url 读 ./bundled-comfy-workflows/*.json，CJS 改为内嵌常量，
// 保证安装包不依赖源码目录结构，也不新增仓库文件。
const BUNDLED_COMFY_WORKFLOW_JSON = "[{\"id\":\"builtin-minimax-h3\",\"ownerId\":\"shared\",\"name\":\"MiniMax_H3\",\"description\":\"推荐的 MiniMax H3 多模态视频工作流，可直接编辑图片、视频、音频与提示词映射。\",\"coverUrl\":\"\",\"instanceId\":\"auto\",\"workflow\":{\"1\":{\"class_type\":\"SaveVideo\",\"inputs\":{\"filename_prefix\":\"video/MiniMax_H3\",\"format\":\"auto\",\"codec\":\"auto\",\"video\":[\"14\",0]},\"_meta\":{\"title\":\"保存视频\"}},\"2\":{\"class_type\":\"ResolutionSelector\",\"inputs\":{\"aspect_ratio\":\"16:9 (Widescreen)\",\"megapixels\":0.4,\"multiple\":32},\"_meta\":{\"title\":\"Resolution Selector (Size)\"}},\"3\":{\"class_type\":\"VAELoader\",\"inputs\":{\"vae_name\":\"minimax_h3_video_vae_fp16.safetensors\"},\"_meta\":{\"title\":\"VAE加载器\"}},\"4\":{\"class_type\":\"VAELoader\",\"inputs\":{\"vae_name\":\"minimax_h3_audio_vae_fp32.safetensors\"},\"_meta\":{\"title\":\"VAE加载器\"}},\"5\":{\"class_type\":\"VAEDecodeAudio\",\"inputs\":{\"samples\":[\"9\",0],\"vae\":[\"4\",0]},\"_meta\":{\"title\":\"VAE解码_Audio\"}},\"6\":{\"class_type\":\"VAEDecode\",\"inputs\":{\"samples\":[\"9\",0],\"vae\":[\"3\",0]},\"_meta\":{\"title\":\"VAE解码\"}},\"7\":{\"class_type\":\"KSamplerSelect\",\"inputs\":{\"sampler_name\":\"res_multistep\"},\"_meta\":{\"title\":\"K采样器选择\"}},\"8\":{\"class_type\":\"BasicScheduler\",\"inputs\":{\"scheduler\":\"simple\",\"steps\":20,\"denoise\":1,\"model\":[\"11\",0]},\"_meta\":{\"title\":\"基础调度器\"}},\"9\":{\"class_type\":\"SamplerCustomAdvanced\",\"inputs\":{\"noise\":[\"13\",0],\"guider\":[\"10\",0],\"sampler\":[\"7\",0],\"sigmas\":[\"8\",0],\"latent_image\":[\"17\",1]},\"_meta\":{\"title\":\"自定义采样器(高级)\"}},\"10\":{\"class_type\":\"BasicGuider\",\"inputs\":{\"model\":[\"11\",0],\"conditioning\":[\"17\",0]},\"_meta\":{\"title\":\"基础引导\"}},\"11\":{\"class_type\":\"UNETLoader\",\"inputs\":{\"unet_name\":\"minimax_h3_ref2va_pruned_int8_convrot.safetensors\",\"weight_dtype\":\"default\"},\"_meta\":{\"title\":\"UNET加载器\"}},\"12\":{\"class_type\":\"CLIPLoader\",\"inputs\":{\"clip_name\":\"qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors\",\"type\":\"minimax\",\"device\":\"default\"},\"_meta\":{\"title\":\"CLIP加载器\"}},\"13\":{\"class_type\":\"RandomNoise\",\"inputs\":{\"noise_seed\":1096692781543804},\"_meta\":{\"title\":\"随机噪波\"}},\"14\":{\"class_type\":\"CreateVideo\",\"inputs\":{\"fps\":24,\"bit_depth\":8,\"images\":[\"6\",0],\"audio\":[\"5\",0]},\"_meta\":{\"title\":\"创建视频\"}},\"15\":{\"class_type\":\"ComfyMathExpression\",\"inputs\":{\"expression\":\"max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17\",\"speak_and_recognation\":{\"__value__\":[false,true]},\"values.a\":[\"16\",0]},\"_meta\":{\"title\":\"数学表达式\"}},\"16\":{\"class_type\":\"PrimitiveFloat\",\"inputs\":{\"value\":8},\"_meta\":{\"title\":\"Float (Duration)\"}},\"17\":{\"class_type\":\"MiniMaxH3ReferenceToVideo\",\"inputs\":{\"prompt\":[\"19\",0],\"width\":[\"2\",0],\"height\":[\"2\",1],\"length\":[\"15\",1],\"ref_image_size\":\"match\",\"speak_and_recognation\":{\"__value__\":[false,true]},\"clip\":[\"12\",0],\"vae\":[\"3\",0],\"audio_vae\":[\"4\",0],\"ref_images.ref_image_0\":[\"18\",0],\"ref_images.ref_image_1\":[\"20\",0],\"ref_images.ref_image_2\":[\"21\",0],\"ref_images.ref_image_3\":[\"22\",0],\"ref_images.ref_image_4\":[\"23\",0],\"ref_videos.ref_video_0\":[\"24\",0],\"ref_videos.ref_video_1\":[\"26\",0],\"ref_videos.ref_video_2\":[\"27\",0],\"ref_video_audios.ref_video_audio_0\":[\"25\",0],\"ref_video_audios.ref_video_audio_1\":[\"28\",0],\"ref_video_audios.ref_video_audio_2\":[\"29\",0]},\"_meta\":{\"title\":\"MiniMax H3 Reference to Video\"}},\"18\":{\"class_type\":\"LoadImage\",\"inputs\":{\"image\":\"5 (1).jpg\"},\"_meta\":{\"title\":\"加载图像\"}},\"19\":{\"class_type\":\"PrimitiveStringMultiline\",\"inputs\":{\"value\":\"【远景全景】暴风雨笼罩海岸线，巨型怪兽从海面缓缓浮出水面\\n【中景切换】机甲迈步冲向怪兽，金属关节摩擦，灯光穿透雨幕\\n【近距离特写】怪兽利爪撞击机甲装甲，火花四处飞溅\\n【全景高潮】机甲启动等离子炮，强光炸开，巨大冲击波席卷海面\",\"speak_and_recognation\":{\"__value__\":[false,true]}},\"_meta\":{\"title\":\"Input Text (Prompt)\"}},\"20\":{\"class_type\":\"LoadImage\",\"inputs\":{\"image\":\"5 (1).jpg\"},\"_meta\":{\"title\":\"加载图像\"}},\"21\":{\"class_type\":\"LoadImage\",\"inputs\":{\"image\":\"5 (1).jpg\"},\"_meta\":{\"title\":\"加载图像\"}},\"22\":{\"class_type\":\"LoadImage\",\"inputs\":{\"image\":\"5 (1).jpg\"},\"_meta\":{\"title\":\"加载图像\"}},\"23\":{\"class_type\":\"LoadImage\",\"inputs\":{\"image\":\"5 (1).jpg\"},\"_meta\":{\"title\":\"加载图像\"}},\"24\":{\"class_type\":\"VHS_LoadVideo\",\"inputs\":{\"video\":\"generation_04d0c2d1.mp4\",\"force_rate\":0,\"custom_width\":0,\"custom_height\":0,\"frame_load_cap\":0,\"skip_first_frames\":0,\"select_every_nth\":1,\"format\":\"AnimateDiff\"},\"_meta\":{\"title\":\"加载视频\"}},\"25\":{\"class_type\":\"LoadAudio\",\"inputs\":{\"audio\":\"不要躲避我的眼睛 - 王馨平.flac\"},\"_meta\":{\"title\":\"加载音频\"}},\"26\":{\"class_type\":\"VHS_LoadVideo\",\"inputs\":{\"video\":\"generation_04d0c2d1.mp4\",\"force_rate\":0,\"custom_width\":0,\"custom_height\":0,\"frame_load_cap\":0,\"skip_first_frames\":0,\"select_every_nth\":1,\"format\":\"AnimateDiff\"},\"_meta\":{\"title\":\"加载视频\"}},\"27\":{\"class_type\":\"VHS_LoadVideo\",\"inputs\":{\"video\":\"generation_04d0c2d1.mp4\",\"force_rate\":0,\"custom_width\":0,\"custom_height\":0,\"frame_load_cap\":0,\"skip_first_frames\":0,\"select_every_nth\":1,\"format\":\"AnimateDiff\"},\"_meta\":{\"title\":\"加载视频\"}},\"28\":{\"class_type\":\"LoadAudio\",\"inputs\":{\"audio\":\"不要躲避我的眼睛 - 王馨平.flac\"},\"_meta\":{\"title\":\"加载音频\"}},\"29\":{\"class_type\":\"LoadAudio\",\"inputs\":{\"audio\":\"不要躲避我的眼睛 - 王馨平.flac\"},\"_meta\":{\"title\":\"加载音频\"}}},\"fields\":[{\"id\":\"1789012631554-48m2yq5e6vx\",\"label\":\"图1\",\"type\":\"image\",\"nodeId\":\"18\",\"input\":\"image\",\"required\":false,\"mediaSlot\":1,\"missingPolicy\":\"skip\",\"role\":\"reference_image\"},{\"id\":\"1789012641135-m7k3r13gw3e\",\"label\":\"图2\",\"type\":\"image\",\"nodeId\":\"20\",\"input\":\"image\",\"required\":false,\"mediaSlot\":2,\"missingPolicy\":\"skip\",\"role\":\"reference_image\"},{\"id\":\"1789012656952-du63yrobabi\",\"label\":\"图3\",\"type\":\"image\",\"nodeId\":\"21\",\"input\":\"image\",\"required\":false,\"mediaSlot\":3,\"missingPolicy\":\"skip\",\"role\":\"reference_image\"},{\"id\":\"1789012667501-43rthg48hik\",\"label\":\"图4\",\"type\":\"image\",\"nodeId\":\"22\",\"input\":\"image\",\"required\":false,\"mediaSlot\":4,\"missingPolicy\":\"skip\",\"role\":\"reference_image\"},{\"id\":\"1789012689916-mgxl0ops5q\",\"label\":\"图5\",\"type\":\"image\",\"nodeId\":\"23\",\"input\":\"image\",\"required\":false,\"mediaSlot\":5,\"missingPolicy\":\"skip\",\"role\":\"reference_image\"},{\"id\":\"1789012725611-5jw5b6kcd39\",\"label\":\"视频1\",\"type\":\"video\",\"nodeId\":\"24\",\"input\":\"video\",\"required\":false,\"mediaSlot\":1,\"missingPolicy\":\"skip\",\"role\":\"reference_video\"},{\"id\":\"1789012736877-07ypj7ofvup\",\"label\":\"视频2\",\"type\":\"video\",\"nodeId\":\"26\",\"input\":\"video\",\"required\":false,\"mediaSlot\":2,\"missingPolicy\":\"skip\",\"role\":\"reference_video\"},{\"id\":\"1789012750426-l7hv9ytsi3p\",\"label\":\"视频3\",\"type\":\"video\",\"nodeId\":\"27\",\"input\":\"video\",\"required\":false,\"mediaSlot\":3,\"missingPolicy\":\"skip\",\"role\":\"reference_video\"},{\"id\":\"1789012759526-dtg7zx6sm1s\",\"label\":\"音频1\",\"type\":\"audio\",\"nodeId\":\"25\",\"input\":\"audio\",\"required\":false,\"mediaSlot\":1,\"missingPolicy\":\"skip\",\"role\":\"audio\"},{\"id\":\"1789012772293-6n98llejg4\",\"label\":\"音频2\",\"type\":\"audio\",\"nodeId\":\"28\",\"input\":\"audio\",\"required\":false,\"mediaSlot\":2,\"missingPolicy\":\"skip\",\"role\":\"audio\"},{\"id\":\"1789012780475-668pmuavnve\",\"label\":\"音频3\",\"type\":\"audio\",\"nodeId\":\"29\",\"input\":\"audio\",\"required\":false,\"mediaSlot\":3,\"missingPolicy\":\"skip\",\"role\":\"audio\"},{\"id\":\"1789012801924-yqdpj7t9gxp\",\"label\":\"提示词\",\"type\":\"textarea\",\"nodeId\":\"19\",\"input\":\"value\",\"default\":\"【远景全景】暴风雨笼罩海岸线，巨型怪兽从海面缓缓浮出水面\\n【中景切换】机甲迈步冲向怪兽，金属关节摩擦，灯光穿透雨幕\\n【近距离特写】怪兽利爪撞击机甲装甲，火花四处飞溅\\n【全景高潮】机甲启动等离子炮，强光炸开，巨大冲击波席卷海面\",\"required\":false,\"role\":\"prompt\"},{\"id\":\"1789013200352-b8pl43kjjl\",\"label\":\"比例\",\"type\":\"select\",\"nodeId\":\"2\",\"input\":\"aspect_ratio\",\"default\":\"16:9 (Widescreen)\",\"required\":true,\"role\":\"parameter\",\"options\":[{\"label\":\"1:1 (Square)\",\"value\":\"1:1 (Square)\"},{\"label\":\"2:3 (Portrait Photo)\",\"value\":\"2:3 (Portrait Photo)\"},{\"label\":\"3:2 (Photo)\",\"value\":\"3:2 (Photo)\"},{\"label\":\"3:4 (Portrait Standard)\",\"value\":\"3:4 (Portrait Standard)\"},{\"label\":\"4:3 (Standard)\",\"value\":\"4:3 (Standard)\"},{\"label\":\"9:16 (Portrait Widescreen)\",\"value\":\"9:16 (Portrait Widescreen)\"},{\"label\":\"16:9 (Widescreen)\",\"value\":\"16:9 (Widescreen)\"},{\"label\":\"21:9 (Ultrawide)\",\"value\":\"21:9 (Ultrawide)\"}]},{\"id\":\"1789013208220-vopbrn6wqnq\",\"label\":\"时间\",\"type\":\"number\",\"nodeId\":\"16\",\"input\":\"value\",\"default\":8,\"required\":true,\"min\":1,\"max\":30,\"step\":1,\"role\":\"parameter\"},{\"id\":\"1789179953977-45ojx4rurgr\",\"label\":\"分辨率\",\"type\":\"number\",\"nodeId\":\"2\",\"input\":\"megapixels\",\"default\":0.4,\"required\":true,\"min\":0.1,\"max\":16,\"step\":1,\"role\":\"parameter\"},{\"id\":\"1789551890200-lksrr4d1zh\",\"label\":\"随机噪波\",\"type\":\"seed\",\"nodeId\":\"13\",\"input\":\"noise_seed\",\"default\":1096692781543804,\"required\":false,\"role\":\"parameter\",\"min\":0,\"max\":18446744073709552000,\"step\":10}],\"outputs\":[{\"id\":\"1789012859287-uh5jm2teqdb\",\"label\":\"保存视频\",\"nodeId\":\"1\",\"type\":\"video\",\"role\":\"result\",\"primary\":true}],\"capabilities\":[\"media.video.multi_reference\",\"media.video.multimodal\",\"media.video.audio_reference\",\"media.video.video_to_video\"],\"aliases\":[],\"agentSummary\":\"推荐的 MiniMax H3 多模态视频工作流，支持图片、视频、音频与提示词映射。\",\"createdAt\":0,\"updatedAt\":0,\"builtin\":true,\"recommended\":true},{\"id\":\"builtin-qwen21-text-to-image\",\"ownerId\":\"shared\",\"name\":\"Qwen2.1-文生图\",\"description\":\"使用 Qwen Image 2.1 根据提示词生成图片。\",\"coverUrl\":\"\",\"instanceId\":\"auto\",\"workflow\":{\"1\":{\"class_type\":\"EmptyLatentImage\",\"inputs\":{\"width\":1920,\"height\":1080,\"batch_size\":1},\"_meta\":{\"title\":\"空Latent\"}},\"3\":{\"class_type\":\"UNETLoader\",\"inputs\":{\"unet_name\":\"qwen_image_2.1_bf16.safetensors\",\"weight_dtype\":\"default\"},\"_meta\":{\"title\":\"UNET加载器\"}},\"4\":{\"class_type\":\"TextEncodeQwenImage21\",\"inputs\":{\"prompt\":[\"12\",0],\"negative_prompt\":\"\",\"resolution\":1024,\"clip\":[\"6\",0]},\"_meta\":{\"title\":\"Text Encode Qwen Image 2.1\"}},\"6\":{\"class_type\":\"CLIPLoader\",\"inputs\":{\"clip_name\":\"qwen3vl_8b_bf16.safetensors\",\"type\":\"qwen_image\",\"device\":\"default\"},\"_meta\":{\"title\":\"CLIP加载器\"}},\"7\":{\"class_type\":\"VAELoader\",\"inputs\":{\"vae_name\":\"qwen_image_2.1_vae_bf16.safetensors\"},\"_meta\":{\"title\":\"VAE加载器\"}},\"8\":{\"class_type\":\"KSampler\",\"inputs\":{\"seed\":0,\"steps\":10,\"cfg\":1,\"sampler_name\":\"euler\",\"scheduler\":\"simple\",\"denoise\":1,\"model\":[\"10\",0],\"positive\":[\"4\",0],\"negative\":[\"4\",1],\"latent_image\":[\"1\",0]},\"_meta\":{\"title\":\"K采样器\"}},\"9\":{\"class_type\":\"VAEDecode\",\"inputs\":{\"samples\":[\"8\",0],\"vae\":[\"7\",0]},\"_meta\":{\"title\":\"VAE解码\"}},\"10\":{\"class_type\":\"QwenImage21Cache\",\"inputs\":{\"device\":\"auto\",\"dtype\":\"default\",\"model\":[\"14\",0]},\"_meta\":{\"title\":\"Qwen Image 2.1 Cache\"}},\"11\":{\"class_type\":\"PreviewImage\",\"inputs\":{\"images\":[\"9\",0]},\"_meta\":{\"title\":\"预览图像\"}},\"12\":{\"class_type\":\"PrimitiveStringMultiline\",\"inputs\":{\"value\":\"\"},\"_meta\":{\"title\":\"Input Text (Prompt)\"}},\"14\":{\"class_type\":\"LoraLoaderModelOnly\",\"inputs\":{\"lora_name\":\"Qwen-Image-2.1-viggle-turbo-v0.2.1-6step-lora-r256.safetensors\",\"strength_model\":0.5,\"model\":[\"3\",0]},\"_meta\":{\"title\":\"LoRA加载器(仅模型)\"}}},\"fields\":[{\"id\":\"qwen21-t2i-width\",\"label\":\"宽度\",\"type\":\"number\",\"nodeId\":\"1\",\"input\":\"width\",\"default\":1920,\"required\":true,\"role\":\"parameter\",\"min\":16,\"max\":16384,\"step\":80},{\"id\":\"qwen21-t2i-height\",\"label\":\"高度\",\"type\":\"number\",\"nodeId\":\"1\",\"input\":\"height\",\"default\":1080,\"required\":true,\"role\":\"parameter\",\"min\":16,\"max\":16384,\"step\":80},{\"id\":\"qwen21-t2i-prompt\",\"label\":\"提示词\",\"type\":\"textarea\",\"nodeId\":\"12\",\"input\":\"value\",\"default\":\"\",\"required\":true,\"role\":\"prompt\"},{\"id\":\"qwen21-t2i-seed\",\"label\":\"随机种子\",\"type\":\"seed\",\"nodeId\":\"8\",\"input\":\"seed\",\"default\":\"random\",\"required\":false,\"role\":\"parameter\",\"min\":0,\"max\":4294967295,\"step\":1}],\"outputs\":[{\"id\":\"qwen21-t2i-output\",\"label\":\"生成图片\",\"nodeId\":\"11\",\"type\":\"image\",\"role\":\"result\",\"primary\":true}],\"capabilities\":[\"media.image.generate\"],\"aliases\":[\"Qwen 2.1 文生图\",\"通义文生图\",\"Qwen Image 2.1\"],\"agentSummary\":\"使用 Qwen Image 2.1 按提示词和指定宽高生成图片。\",\"createdAt\":0,\"updatedAt\":0,\"builtin\":true,\"recommended\":true},{\"id\":\"builtin-qwen21-image-to-image\",\"ownerId\":\"shared\",\"name\":\"Qwen2.1-图生图\",\"description\":\"使用 Qwen Image 2.1 结合一至六张参考图进行图片编辑和生成。\",\"coverUrl\":\"\",\"instanceId\":\"auto\",\"workflow\":{\"2\":{\"class_type\":\"UNETLoader\",\"inputs\":{\"unet_name\":\"qwen_image_2.1_bf16.safetensors\",\"weight_dtype\":\"default\"},\"_meta\":{\"title\":\"UNET加载器\"}},\"3\":{\"class_type\":\"LoadImage\",\"inputs\":{\"image\":\"\"},\"_meta\":{\"title\":\"加载图像\"}},\"5\":{\"class_type\":\"CLIPLoader\",\"inputs\":{\"clip_name\":\"qwen3vl_8b_bf16.safetensors\",\"type\":\"qwen_image\",\"device\":\"default\"},\"_meta\":{\"title\":\"CLIP加载器\"}},\"6\":{\"class_type\":\"KSampler\",\"inputs\":{\"seed\":0,\"steps\":10,\"cfg\":1,\"sampler_name\":\"euler\",\"scheduler\":\"simple\",\"denoise\":1,\"model\":[\"9\",0],\"positive\":[\"8\",0],\"negative\":[\"8\",1],\"latent_image\":[\"8\",2]},\"_meta\":{\"title\":\"K采样器\"}},\"7\":{\"class_type\":\"VAEDecode\",\"inputs\":{\"samples\":[\"6\",0],\"vae\":[\"10\",0]},\"_meta\":{\"title\":\"VAE解码\"}},\"8\":{\"class_type\":\"TextEncodeQwenImage21\",\"inputs\":{\"prompt\":[\"12\",0],\"negative_prompt\":\"\",\"resolution\":1024,\"clip\":[\"5\",0],\"images.image_1\":[\"3\",0],\"images.image_2\":[\"15\",0],\"images.image_3\":[\"16\",0],\"vae\":[\"10\",0],\"images.image_4\":[\"17\",0],\"images.image_5\":[\"18\",0],\"images.image_6\":[\"19\",0]},\"_meta\":{\"title\":\"Text Encode Qwen Image 2.1\"}},\"9\":{\"class_type\":\"QwenImage21Cache\",\"inputs\":{\"device\":\"auto\",\"dtype\":\"default\",\"model\":[\"14\",0]},\"_meta\":{\"title\":\"Qwen Image 2.1 Cache\"}},\"10\":{\"class_type\":\"VAELoader\",\"inputs\":{\"vae_name\":\"qwen_image_2.1_vae_bf16.safetensors\"},\"_meta\":{\"title\":\"VAE加载器\"}},\"11\":{\"class_type\":\"PreviewImage\",\"inputs\":{\"images\":[\"7\",0]},\"_meta\":{\"title\":\"预览图像\"}},\"12\":{\"class_type\":\"PrimitiveStringMultiline\",\"inputs\":{\"value\":\"\"},\"_meta\":{\"title\":\"Input Text (Prompt)\"}},\"14\":{\"class_type\":\"LoraLoaderModelOnly\",\"inputs\":{\"lora_name\":\"Qwen-Image-2.1-viggle-turbo-v0.2.1-6step-lora-r256.safetensors\",\"strength_model\":0.5,\"model\":[\"2\",0]},\"_meta\":{\"title\":\"LoRA加载器(仅模型)\"}},\"15\":{\"class_type\":\"LoadImage\",\"inputs\":{\"image\":\"\"},\"_meta\":{\"title\":\"加载图像\"}},\"16\":{\"class_type\":\"LoadImage\",\"inputs\":{\"image\":\"\"},\"_meta\":{\"title\":\"加载图像\"}},\"17\":{\"class_type\":\"LoadImage\",\"inputs\":{\"image\":\"\"},\"_meta\":{\"title\":\"加载图像\"}},\"18\":{\"class_type\":\"LoadImage\",\"inputs\":{\"image\":\"\"},\"_meta\":{\"title\":\"加载图像\"}},\"19\":{\"class_type\":\"LoadImage\",\"inputs\":{\"image\":\"\"},\"_meta\":{\"title\":\"加载图像\"}}},\"fields\":[{\"id\":\"qwen21-i2i-image-1\",\"label\":\"图1\",\"type\":\"image\",\"nodeId\":\"3\",\"input\":\"image\",\"required\":true,\"role\":\"source_image\",\"mediaSlot\":1,\"missingPolicy\":\"skip\"},{\"id\":\"qwen21-i2i-image-2\",\"label\":\"图2\",\"type\":\"image\",\"nodeId\":\"15\",\"input\":\"image\",\"required\":false,\"role\":\"reference_image\",\"mediaSlot\":2,\"missingPolicy\":\"skip\"},{\"id\":\"qwen21-i2i-image-3\",\"label\":\"图3\",\"type\":\"image\",\"nodeId\":\"16\",\"input\":\"image\",\"required\":false,\"role\":\"reference_image\",\"mediaSlot\":3,\"missingPolicy\":\"skip\"},{\"id\":\"qwen21-i2i-image-4\",\"label\":\"图4\",\"type\":\"image\",\"nodeId\":\"17\",\"input\":\"image\",\"required\":false,\"role\":\"reference_image\",\"mediaSlot\":4,\"missingPolicy\":\"skip\"},{\"id\":\"qwen21-i2i-image-5\",\"label\":\"图5\",\"type\":\"image\",\"nodeId\":\"18\",\"input\":\"image\",\"required\":false,\"role\":\"reference_image\",\"mediaSlot\":5,\"missingPolicy\":\"skip\"},{\"id\":\"qwen21-i2i-image-6\",\"label\":\"图6\",\"type\":\"image\",\"nodeId\":\"19\",\"input\":\"image\",\"required\":false,\"role\":\"reference_image\",\"mediaSlot\":6,\"missingPolicy\":\"skip\"},{\"id\":\"qwen21-i2i-seed\",\"label\":\"随机种子\",\"type\":\"seed\",\"nodeId\":\"6\",\"input\":\"seed\",\"default\":\"random\",\"required\":false,\"role\":\"parameter\",\"min\":0,\"max\":4294967295,\"step\":1},{\"id\":\"qwen21-i2i-prompt\",\"label\":\"提示词\",\"type\":\"textarea\",\"nodeId\":\"12\",\"input\":\"value\",\"default\":\"\",\"required\":true,\"role\":\"prompt\"}],\"outputs\":[{\"id\":\"qwen21-i2i-output\",\"label\":\"生成图片\",\"nodeId\":\"11\",\"type\":\"image\",\"role\":\"result\",\"primary\":true}],\"capabilities\":[\"media.image.edit\"],\"aliases\":[\"Qwen 2.1 图生图\",\"通义图生图\",\"Qwen Image 2.1 编辑\"],\"agentSummary\":\"使用一至六张参考图片和提示词，通过 Qwen Image 2.1 完成图片编辑或融合生成。\",\"createdAt\":0,\"updatedAt\":0,\"builtin\":true,\"recommended\":true}]";

let bundledCache = null;
function bundledComfyWorkflows() {
  if (!bundledCache) bundledCache = JSON.parse(BUNDLED_COMFY_WORKFLOW_JSON);
  return bundledCache;
}

/** 从外部目录增量加载随包 / 本地工作流（目录不存在或单文件损坏都不阻断，返回已加载项）。 */
function loadBundledWorkflows(dir) {
  const root = normalizeComfyPath(dir);
  if (!root || !fs.existsSync(root)) return [];
  let names = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  const items = [];
  for (const name of names.sort()) {
    if (!name.toLowerCase().endsWith(".json")) continue;
    try {
      const value = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
      if (value && typeof value === "object" && !Array.isArray(value) && typeof value.id === "string") items.push(value);
    } catch { /* 单个损坏文件跳过，不改动其它加载结果 */ }
  }
  return items;
}

/** 源 comfyWorkflows.ts:154-171 —— 旧 ID 一次性迁移 + 同名去重，绝不覆盖用户已保存的图。 */
function withBundledComfyWorkflows(items, bundled) {
  const sources = bundled || bundledComfyWorkflows();
  const next = [...items];
  for (const [index, preset] of sources.entries()) {
    const legacyIds = BUNDLED_COMFY_WORKFLOW_LEGACY_IDS[index] || [];
    const legacyIndex = next.findIndex((item) => legacyIds.includes(item.id));
    if (legacyIndex >= 0) {
      if (!next.some((item) => item.id === preset.id)) {
        next.splice(legacyIndex, 1, { ...next[legacyIndex], id: preset.id, builtin: true, recommended: true });
      } else next.splice(legacyIndex, 1);
      continue;
    }
    const samePreset = next.some((item) => item.id === preset.id || String(item.name || "").trim().toLowerCase() === String(preset.name || "").trim().toLowerCase());
    if (!samePreset) next.push(structuredClone(preset));
  }
  return next;
}

module.exports = {
  COMFY_RANDOM_SEED_MAX,
  AUTO_INSTANCE_ID,
  COMFY_FIELD_TYPES,
  MEDIA_FIELD_TYPES,
  COMFY_CAPABILITIES,
  COMFY_INPUT_ROLES,
  COMFY_OUTPUT_ROLES,
  BUNDLED_COMFY_WORKFLOW_LEGACY_IDS,
  normalizeComfyPath,
  normalizeComfyBaseUrl,
  normalizeComfyLanHost,
  defaultComfyRoot,
  defaultComfyConfig,
  portablePathNeedsRebase,
  resolveComfyLocalPaths,
  parseComfyArgs,
  normalizeComfyInstance,
  normalizeComfyConfig,
  comfyInstanceBaseUrl,
  inferComfyWorkflowCapabilities,
  comfyWorkflowAgentManifest,
  randomComfySeed,
  comfyMediaSlotIndex,
  mapComfyMediaFields,
  apiWorkflow,
  safeFields,
  safeOutputs,
  connectedSourceIds,
  pruneSkippedComfyBranches,
  inspectComfyWorkflow,
  prepareComfyRun,
  comfyResultsFromHistory,
  bundledComfyWorkflows,
  loadBundledWorkflows,
  withBundledComfyWorkflows,
};
