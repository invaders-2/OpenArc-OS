/**
 * B5c · 画布域命令面（扩展既有 canvas:command，不新建画布域）。
 *
 * 源：B5c 任务书要求的三件事在这里落地——素材库、.dxcanvas 打包、协作、内核能力、Agent 附件
 * 都通过**同一个 canvas:command** 暴露；每条命令登记 risk / credential / 中文 summary。
 *
 * 与既有实现的边界（为什么必须由本文件扩展，而不是新建 IPC）：
 *   · canvas-bootstrap.cjs:17-44 已有 RENDERER_COMMANDS 白名单与 canvas:command 处理器；
 *     本模块**不改它**，而是导出 extendRendererCommands() 与 dispatch()，由装配处接进去。
 *   · preload.cjs:140-142 只有 canvas.command(...) 一个顶层键；本批次**不新增顶层键**，
 *     因此所有请求与下行都走 canvas:command 的请求/应答（下行用 canvas/collab/events 拉取）。
 *   · 仓库当前**没有** canvas:event 通道（实测 preload.cjs:140-142 只有 command）——所以不能
 *     "沿用"一条不存在的通道；这里复用既有 canvas:command 应答面，并在 onEvent 注入点预留
 *     （hub.onBroadcast → events 队列；若 Lead 后续开 canvas:event，直接接同一个队列）。
 *
 * OUT（一律不引入）：dxosProtocol 云 AI、apiQuota、cloudEntitlement、publicMedia 上传、
 * api.dx-os.com、canvasCloudSync / dx-canvas-cloud 协议 —— 本文件零引用。
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildCanvasPackage, parseCanvasPackage, remapCanvasPackageDocument, sha256 } = require("./canvas-dxos-package.cjs");
const { CanvasCollabHub } = require("./canvas-dxos-collab.cjs");
const { buildCanvasKernelCapabilities, toCatalogDescriptors } = require("./canvas-dxos-capabilities.cjs");
const { extractAttachments } = require("./canvas-dxos-agent-attachments.cjs");
const { createCanvasNodeRegistry, ERROR: NODE_ERROR } = require("./canvas-node-registry.cjs");

const CHANNEL = "canvas:command";
const MAX_INLINE_PACKAGE_BYTES = 32 * 1024 * 1024;

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, detail = null) => ({ ok: false, error: String(error), detail });
const asStr = (value, max = 200) => (typeof value === "string" ? value.slice(0, max) : value == null ? null : String(value).slice(0, max));
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

/**
 * 命令登记表。每一条都必须有中文 summary / risk / credential（测试逐条断言）。
 * risk 取值与既有 agent 工具目录一致：read | write | delete | external。
 */
const DXOS_CANVAS_COMMANDS = Object.freeze([
  // ---- 素材库（源 canvasAssetLibrary.ts 全部入口） ----
  { command: "canvas/assetLibrary/characterCreate", risk: "write", credential: "none", summary: "新建 AI 角色（名称/描述/提示词/参考图）" },
  { command: "canvas/assetLibrary/characterList", risk: "read", credential: "none", summary: "列出 AI 角色" },
  { command: "canvas/assetLibrary/characterUpdate", risk: "write", credential: "none", summary: "更新 AI 角色" },
  { command: "canvas/assetLibrary/characterDelete", risk: "write", credential: "none", summary: "删除 AI 角色" },
  { command: "canvas/assetLibrary/folderList", risk: "read", credential: "none", summary: "列出素材库文件夹（复用条目 group_name）" },
  { command: "canvas/assetLibrary/folderCreate", risk: "write", credential: "none", summary: "新建素材库文件夹" },
  { command: "canvas/assetLibrary/folderRename", risk: "write", credential: "none", summary: "重命名素材库文件夹" },
  { command: "canvas/assetLibrary/folderMove", risk: "write", credential: "none", summary: "把素材条目移动到文件夹" },
  { command: "canvas/assetLibrary/list", risk: "read", credential: "none", summary: "列举当前用户可见的素材库（本人 + 组织可见）" },
  { command: "canvas/assetLibrary/ensure", risk: "write", credential: "none", summary: "取得或创建默认素材库，并补齐系统提示词" },
  { command: "canvas/assetLibrary/create", risk: "write", credential: "none", summary: "新建一个素材库" },
  { command: "canvas/assetLibrary/get", risk: "read", credential: "none", summary: "读取素材库及其全部条目" },
  { command: "canvas/assetLibrary/items", risk: "read", credential: "none", summary: "按 kind / 关键词筛选素材库条目" },
  { command: "canvas/assetLibrary/import", risk: "write", credential: "none", summary: "导入素材字节（同 checksum 复用同一 ResourceRef 去重）" },
  { command: "canvas/assetLibrary/syncSources", risk: "write", credential: "none", summary: "从文件 / 画布节点同步素材进资产库（所有者 + 可见性权限 + sourceKey 去重）" },
  { command: "canvas/assetMembers/list", risk: "read", credential: "none", summary: "列出素材库逐成员 ACL（仅所有者可见）" },
  { command: "canvas/assetMembers/set", risk: "write", credential: "none", summary: "设置素材库成员 read/edit 权限（仅所有者）" },
  { command: "canvas/assetMembers/remove", risk: "delete", credential: "none", summary: "移除素材库成员 ACL（仅所有者）" },
  { command: "canvas/assetLibrary/upsert", risk: "write", credential: "none", summary: "写入或更新 asset / prompt / workflow 条目（含版本历史与关联字段）" },
  { command: "canvas/assetLibrary/update", risk: "write", credential: "none", summary: "按基准版本更新素材库名称 / 可见性（version+1）" },
  { command: "canvas/assetLibrary/reference", risk: "read", credential: "none", summary: "返回条目的稳定 ResourceRef 与当前引用计数" },
  { command: "canvas/assetLibrary/attach", risk: "write", credential: "none", summary: "把素材库条目作为节点挂到画布上" },
  { command: "canvas/assetLibrary/delete", risk: "delete", credential: "none", summary: "删除素材条目（系统提示词受保护不可删）" },
  // ---- 协作（本机 / 局域网会话；云同步 OUT） ----
  { command: "canvas/collab/join", risk: "write", credential: "none", summary: "加入画布协作房间（鉴权后广播 presence）" },
  { command: "canvas/collab/leave", risk: "write", credential: "none", summary: "离开画布协作房间并广播 presence" },
  { command: "canvas/collab/presence", risk: "read", credential: "none", summary: "读取画布房间的在线成员" },
  { command: "canvas/collab/heartbeat", risk: "write", credential: "none", summary: "刷新本会话的最后活跃时间" },
  { command: "canvas/collab/cursor", risk: "write", credential: "none", summary: "广播光标位置（有限坐标，限速）" },
  { command: "canvas/collab/patch", risk: "write", credential: "none", summary: "广播补丁；基准版本落后时明确返回冲突，不广播过期补丁" },
  { command: "canvas/collab/events", risk: "read", credential: "none", summary: "拉取本会话来收到过的下行事件（presence / cursor / patch）" },
  { command: "canvas/collab/rooms", risk: "read", credential: "none", summary: "列出本进程内的协作房间（本机调试）" },
  { command: "canvas/collab/sweep", risk: "write", credential: "none", summary: "清理超过空闲超时的协作会话并广播 presence" },
  // ---- 邀请码（只存 hash；兑换后落既有 canvas_shares，权限仍走同一套三档） ----
  { command: "canvas/invites/get", risk: "read", credential: "none", summary: "读取画布当前有效邀请（仅管理员/所有者可见，无邀请返回 null）" },
  { command: "canvas/invites/create", risk: "write", credential: "none", summary: "生成邀请口令（只存 sha256 与末 4 位提示，明文只返回一次）" },
  { command: "canvas/invites/revoke", risk: "delete", credential: "none", summary: "撤销画布当前邀请口令" },
  { command: "canvas/invites/redeem", risk: "write", credential: "none", summary: "兑换邀请口令并加入画布（只读→VIEWER、编辑→EDITOR）" },
  // ---- 画布插件：数据 / 受控网络（必须已安装、已启用且声明 canvas 清单） ----
  { command: "canvas/plugins/data", risk: "write", credential: "none", summary: "读写画布插件的用户数据（容量取 Manifest host.storage，key 白名单字符）" },
  { command: "canvas/plugins/network", risk: "external", credential: "none", summary: "按插件 Manifest 网络白名单发起受控请求（复用 developerNetwork 策略与审计）" },
  { command: "canvas/plugins/registry", risk: "read", credential: "none", summary: "读取/重建画布插件运行期注册表 registry.json（含 tombstone）" },
  { command: "canvas/plugins/execute", risk: "external", credential: "none", summary: "按 executor.type 分派插件执行（skill/mcp-tool/agent-tool/workflow；builtin 403、app-bridge 409）" },
  // ---- A03：17 个 builtin.* 节点的运行期注册表 / 参数校验 / 执行器分派 ----
  { command: "canvas/nodes/list", risk: "read", credential: "none", summary: "列举画布节点运行期注册表（17 个 builtin.* + 已注册插件节点，含参数 schema / 端口 / 执行器可用性）" },
  { command: "canvas/nodes/get", risk: "read", credential: "none", summary: "读取单个节点类型的定义、参数 schema 与执行器可用性" },
  { command: "canvas/nodes/validate", risk: "read", credential: "none", summary: "校验节点参数或 from→to 端口连接；不合法返回结构化错误，不落文档" },
  { command: "canvas/nodes/execute", risk: "external", credential: "none", summary: "执行一个节点（本地节点纯计算；生成 / 媒体 / 客户端渲染未注入执行器时结构化不可用）" },
  // ---- 内核能力（源 canvasKernelCapabilities.ts 的投影） ----
  { command: "canvas/capabilities/list", risk: "read", credential: "none", summary: "投影画布可被 Agent 调用的能力清单（含 risk / 副作用）" },
  { command: "canvas/protocolTasks/list", risk: "read", credential: "none", summary: "查询画布生成的 ai_protocol_tasks 三元组状态（provider/model protocol + profile + intent）" },
  // ---- Agent 附件（源 canvasAgentAttachments.ts + 本仓挂载语义） ----
  { command: "canvas/agentAttachments/list", risk: "read", credential: "none", summary: "列举挂载到画布上的 Agent 附件" },
  { command: "canvas/agentAttachments/extract", risk: "read", credential: "none", summary: "把 Agent 附件抽取为文本（不落盘、不挂载）" },
  { command: "canvas/agentAttachments/mount", risk: "write", credential: "none", summary: "把 Agent 产物导入资源域并挂载为画布节点" },
  { command: "canvas/agentAttachments/unmount", risk: "delete", credential: "none", summary: "卸载 Agent 附件节点（资源本身保留）" },
  // ---- .dxcanvas 打包（源 canvasPackage.ts） ----
  { command: "canvas/package/export", risk: "read", credential: "none", summary: "把画布与其素材打成 .dxcanvas（内联返回，超过 32MB 拒绝内联）" },
  { command: "canvas/package/import", risk: "write", credential: "none", summary: "解析 .dxcanvas，导入素材并新建画布" },
]);

const REGISTRY = new Map(DXOS_CANVAS_COMMANDS.map((entry) => [entry.command, entry]));

/** 与 canvas-bootstrap.RENDERER_COMMANDS 合并（不覆盖既有命令）。 */
function extendRendererCommands(baseCommands) {
  const base = Array.isArray(baseCommands) ? baseCommands : [];
  return Object.freeze([...new Set([...base, ...DXOS_CANVAS_COMMANDS.map((entry) => entry.command)])]);
}

/** tempDir 既可能是路径，也可能是返回路径的函数（与 canvas-service.attachRuntime 同一约定）。 */
function packageTempDir(dir) {
  if (typeof dir === "function") { try { return dir() || path.join(os.tmpdir(), "openarc-canvas-dxos"); } catch { return path.join(os.tmpdir(), "openarc-canvas-dxos"); } }
  return dir || path.join(os.tmpdir(), "openarc-canvas-dxos");
}

/** 异步节点执行的失败细节 → 一句可读文案（校验错误列出前 3 条 path + message）。 */
function asyncFailureDetail(detail) {
  if (!detail) return "";
  if (typeof detail === "string") return "：" + detail.slice(0, 300);
  if (typeof detail !== "object") return "";
  const errors = Array.isArray(detail.errors) ? detail.errors : [];
  if (errors.length) {
    const text = errors.slice(0, 3).map((e) => (e && e.path ? String(e.path) + " " : "") + ((e && e.message) || "")).filter(Boolean).join("；");
    return "：" + text.slice(0, 300);
  }
  const reason = detail.reason || detail.executorId || detail.capability || "";
  return reason ? "：" + String(reason).slice(0, 200) : "";
}

/**
 * A03 默认生成执行器：image-generator / llm 接既有 canvas/run → modelCall 链路（真实 Task 预算与停止归属）。
 * task-55：video-generator 接 model 域的协议引擎（legacyExecute action=videos：提交/轮询/产物落库由引擎完成）。
 * 音频 / Midjourney 仍无对应执行器，由 supports() 明确排除，命令层结构化不可用。
 */
function createCanvasGenerationPort(canvasService) {
  const port = async ({ type, params, context, canvasId, nodeId }) => {
    if (!canvasService || typeof canvasService.startRun !== "function" || typeof canvasService.modelCall !== "function") return fail("DEPENDENCY_UNAVAILABLE", "canvasService");
    if (type !== "builtin.image-generator" && type !== "builtin.llm") return fail("CANVAS_NODE_EXECUTOR_UNAVAILABLE", { type, capability: "model-generation", reason: "unsupported-model-kind" });
    if (!canvasId) return fail("INVALID_INPUT", "canvasId");
    const kind = type === "builtin.llm" ? "chat" : "image";
    const started = canvasService.startRun({ context, canvasId, nodeId, kind, configId: (params && params.configId) || null });
    if (!started || started.ok !== true) return started && started.ok === false ? started : fail("RUN_UNAVAILABLE");
    const runId = started.runId;
    let terminal = "FAILED";
    try {
      const result = kind === "image"
        ? await canvasService.modelCall({
          context, canvasId, runId, kind: "image", prompt: String(params.prompt || ""),
          size: params.size, ratio: params.ratio, resolution: params.resolution,
          customSize: params.customSize, customRatio: params.customRatio,
          count: params.count, configId: params.configId,
        })
        : await canvasService.modelCall({
          context, canvasId, runId, kind: "chat", configId: params.configId,
          messages: Array.isArray(params.messages) && params.messages.length ? params.messages : [{ role: "user", content: String(params.prompt || "") }],
        });
      if (!result || result.ok !== true) return result && result.ok === false ? result : fail("MODEL_ERROR");
      terminal = "DONE";
      if (kind === "image") {
        const images = Array.isArray(result.images) ? result.images : (result.value && Array.isArray(result.value.images) ? result.value.images : []);
        return ok({ outputs: { images }, modelResult: result });
      }
      const text = typeof result.text === "string" ? result.text : (result.value && typeof result.value.text === "string" ? result.value.text : "");
      return ok({ outputs: { text }, modelResult: result });
    } finally {
      try { canvasService.finishRun({ context, canvasId, runId, status: terminal }); } catch { /* run 已终态时幂等 */ }
    }
  };
  port.supports = (type) => type === "builtin.image-generator" || type === "builtin.llm";
  return port;
}

/** task-55：画布视频节点 → model 协议引擎视频生成（提交/轮询/产物落库均复用既有 legacy 执行器）。 */
function createCanvasVideoGenerationPort(canvasService) {
  const port = async ({ type, params, context, canvasId, nodeId }) => {
    if (!canvasService || !canvasService.modelService) return fail("CANVAS_NODE_EXECUTOR_UNAVAILABLE", { type, capability: "video-generation", reason: "model-service-unavailable" });
    const modelService = canvasService.modelService;
    const protocol = modelService.providerProtocol && modelService.providerProtocol.service;
    if (!protocol || typeof protocol.legacyExecute !== "function") return fail("CANVAS_NODE_EXECUTOR_UNAVAILABLE", { type, capability: "video-generation", reason: "video-provider-unavailable" });
    const resolved = modelService.resolveModel({ context, capability: "video-generation", configId: params.configId });
    if (!resolved.ok) return fail(resolved.error || "MODEL_CONFIG_UNAVAILABLE", { capability: "video-generation", configId: params.configId || null });
    const started = canvasService.startRun({ context, canvasId, nodeId, kind: "video", configId: params.configId || null });
    if (!started || started.ok !== true) return started && started.ok === false ? started : fail("RUN_UNAVAILABLE");
    const runId = started.runId;
    let terminal = "FAILED";
    try {
      // 10-23：图生视频 / 首尾帧 / 参考 —— 输入素材按角色排好，优先用资源库原始引用读字节（服务商可能只认自家上传的附件）
      const list = (key) => (Array.isArray(params[key]) ? params[key] : []);
      const media = (urls, refs, roles, preferUrl = false) => urls.map((url, i) => {
        const ref = typeof refs[i] === "string" ? refs[i] : "";
        // 音视频已有公网临时链接时直接用（几十上百 MB 不该转成 data URL 塞进请求）
        if (preferUrl && typeof url === "string" && /^https:\/\//i.test(url)) return { value: url, role: roles[i] || null };
        if (ref.startsWith("openarc-asset:") && typeof canvasService.readAsset === "function") {
          const r = canvasService.readAsset({ context, ref });
          if (r && r.ok && r.dataUrl) return { value: r.dataUrl, role: roles[i] || null };
        }
        return typeof url === "string" && url ? { value: url, role: roles[i] || null } : null;
      }).filter(Boolean);
      const images = media(list("images"), list("imageRefs"), list("imageRoles"));
      const order = { first_frame: 0, last_frame: 1 };
      images.sort((a, b) => (order[a.role] ?? 2) - (order[b.role] ?? 2));
      const videos = media(list("videos"), list("videoRefs"), [], true);
      const audios = media(list("audios"), list("audioRefs"), [], true);
      const inputsAll = [...images, ...videos, ...audios].map((x) => x.value);
      const vparams = {
        size: params.size, ratio: params.ratio, resolution: params.resolution, count: params.count,
        duration: params.duration, modelType: params.modelType, generateAudio: params.generateAudio, multiShot: params.multiShot,
        imageRoles: images.map((x) => x.role),
        mediaKinds: [...images.map(() => "image"), ...videos.map(() => "video"), ...audios.map(() => "audio")],
      };
      // 优先走模型配置自带凭据的视频出口（Lovart 等）；适配器没有时再回落协议引擎
      if (typeof modelService.generateVideo === "function") {
        const direct = await modelService.generateVideo({ context, configId: params.configId, prompt: String(params.prompt || ""), inputs: inputsAll, params: vparams, requestId: "canvas_video_" + runId });
        if (!(direct && direct.ok === false && direct.detail === "adapter-no-video")) {
          if (!direct || direct.ok !== true) return direct && direct.ok === false ? direct : fail("VIDEO_GENERATION_FAILED");
          terminal = "DONE";
          return ok({ outputs: { videos: direct.videos }, modelResult: direct });
        }
      }
      const result = await protocol.legacyExecute({
        providerId: resolved.snapshot.providerId,
        action: "videos",
        model: resolved.snapshot.modelId,
        prompt: String(params.prompt || ""),
        params: {
          size: params.size, ratio: params.ratio, resolution: params.resolution, count: params.count,
          duration: params.duration, modelType: params.modelType, generateAudio: params.generateAudio, multiShot: params.multiShot,
          imageRoles: images.map((x) => x.role),
        },
        input: images[0] ? images[0].value : null,
        inputs: [...images, ...videos, ...audios].map((x) => x.value),
        requestId: "canvas_video_" + runId,
        timeoutMs: 600000,
      });
      if (!result || result.ok !== true) return result && result.ok === false ? result : fail("VIDEO_GENERATION_FAILED");
      terminal = "DONE";
      return ok({ outputs: { videos: Array.isArray(result.videos) ? result.videos : [] }, modelResult: result });
    } finally {
      try { canvasService.finishRun({ context, canvasId, runId, status: terminal }); } catch { /* run 已终态时幂等 */ }
    }
  };
  port.supports = (type) => type === "builtin.video-generator" && !!(canvasService.modelService && canvasService.modelService.providerProtocol && canvasService.modelService.providerProtocol.service);
  return port;
}

/** task-55 同构：音频节点 → model 协议引擎 legacyExecute action=audio（提交/产物落库由引擎完成）。 */
function createCanvasAudioGenerationPort(canvasService) {
  const port = async ({ type, params, context, canvasId, nodeId }) => {
    if (!canvasService || !canvasService.modelService) return fail("CANVAS_NODE_EXECUTOR_UNAVAILABLE", { type, capability: "audio-generation", reason: "model-service-unavailable" });
    const modelService = canvasService.modelService;
    const protocol = modelService.providerProtocol && modelService.providerProtocol.service;
    if (!protocol || typeof protocol.legacyExecute !== "function") return fail("CANVAS_NODE_EXECUTOR_UNAVAILABLE", { type, capability: "audio-generation", reason: "audio-provider-unavailable" });
    const resolved = modelService.resolveModel({ context, capability: "audio-generation", configId: params.configId });
    if (!resolved.ok) return fail(resolved.error || "MODEL_CONFIG_UNAVAILABLE", { capability: "audio-generation", configId: params.configId || null });
    const started = canvasService.startRun({ context, canvasId, nodeId, kind: "audio", configId: params.configId || null });
    if (!started || started.ok !== true) return started && started.ok === false ? started : fail("RUN_UNAVAILABLE");
    const runId = started.runId;
    let terminal = "FAILED";
    try {
      // 优先走模型配置自带凭据的音频出口（APIMart：配音 / Suno / Flow Music）；适配器没有时再回落协议引擎
      if (typeof modelService.generateAudio === "function") {
        const direct = await modelService.generateAudio({ context, configId: params.configId, prompt: String(params.prompt || ""), params: { kind: params.kind, duration: params.duration }, requestId: "canvas_audio_" + runId });
        if (!(direct && direct.ok === false && direct.detail === "adapter-no-audio")) {
          if (!direct || direct.ok !== true) return direct && direct.ok === false ? direct : fail("AUDIO_GENERATION_FAILED");
          // 配音是直接返回的音频数据：存进画布资源，节点里只放引用
          const audios = [];
          for (const a of direct.audios) {
            if (a.dataUrl && typeof canvasService.importAsset === "function") {
              const saved = await canvasService.importAsset({ context, canvasId, name: "生成音频", dataUrl: a.dataUrl });
              audios.push(saved && saved.ok && saved.ref ? { url: saved.ref } : a);
            } else audios.push(a);
          }
          terminal = "DONE";
          return ok({ outputs: { audios }, modelResult: { ...direct, audios } });
        }
      }
      const result = await protocol.legacyExecute({
        providerId: resolved.snapshot.providerId,
        action: "audio",
        model: resolved.snapshot.modelId,
        prompt: String(params.prompt || ""),
        params: { size: params.size, ratio: params.ratio, resolution: params.resolution, count: params.count, kind: params.kind, duration: params.duration },
        requestId: "canvas_audio_" + runId,
        timeoutMs: 600000,
      });
      if (!result || result.ok !== true) return result && result.ok === false ? result : fail("AUDIO_GENERATION_FAILED");
      terminal = "DONE";
      return ok({ outputs: { audios: Array.isArray(result.audios) ? result.audios : [] }, modelResult: result });
    } finally {
      try { canvasService.finishRun({ context, canvasId, runId, status: terminal }); } catch { /* run 已终态时幂等 */ }
    }
  };
  port.supports = (type) => type === "builtin.audio-generator" && !!(canvasService.modelService && canvasService.modelService.providerProtocol && canvasService.modelService.providerProtocol.service);
  return port;
}

/**
 * 扩展装配。services 里没有的依赖会让对应命令结构化失败（不做假实现）。
 * @param hub 可注入现成 hub（测试用）；不注入则本函数自建并接管 onBroadcast → 事件队列。
 */
function createCanvasDxosExtension({ identity, store, canvasService = null, resourceService = null, assetLibrary = null, attachments = null, hub = null, authorize = null, tempDir = null, nodeTypes = [], nodeDefinitions = [], nodePorts = null, clock = null } = {}) {
  if (!identity) throw new Error("createCanvasDxosExtension 需要 identity");
  // A03：内置节点注册表在装配时建好；生成 / 媒体处理端口可选注入，未注入即结构化不可用。
  // 装配了真实 canvasService 时，image-generator / llm 走默认生成端口（复用 canvas/run + modelCall 链路）。
  const resolvedNodePorts = nodePorts && typeof nodePorts === "object" ? { ...nodePorts } : {};
  if (typeof resolvedNodePorts.generation !== "function" && canvasService && typeof canvasService.startRun === "function" && typeof canvasService.modelCall === "function") {
    resolvedNodePorts.generation = createCanvasGenerationPort(canvasService);
  }
  if (typeof resolvedNodePorts.videoGeneration !== "function" && canvasService) {
    resolvedNodePorts.videoGeneration = createCanvasVideoGenerationPort(canvasService);
  }
  if (typeof resolvedNodePorts.audioGeneration !== "function" && canvasService) {
    resolvedNodePorts.audioGeneration = createCanvasAudioGenerationPort(canvasService);
  }
  const nodeRegistry = createCanvasNodeRegistry({ extraDefinitions: Array.isArray(nodeDefinitions) ? nodeDefinitions : [], ports: resolvedNodePorts, canvasService });
  const events = new Map(); // "canvasId\u0000clientId" → array
  // 画布插件宿主（数据 / 受控网络）：依赖 developerBundle，宿主在装配后晚绑定。
  let pluginHost = null;
  const keepEvent = (delivery) => {
    const recipients = Array.isArray(delivery.to) ? delivery.to : [];
    for (const clientId of recipients) {
      const key = String(delivery.canvasId) + "\u0000" + String(clientId);
      const queue = events.get(key) || [];
      queue.push({ ...delivery, to: undefined });
      if (queue.length > 200) queue.splice(0, queue.length - 200);
      events.set(key, queue);
    }
  };
  // hub 级 authorize 必须显式注入（CanvasCollabHub 缺省拒绝）：本扩展的 canvas/collab/join 在
  // 命令层已经做了真实鉴权（session + getCanvas 访问判定），故这里显式给出判定，而不是依赖默认拒绝。
  // 调用方仍可传 authorize 覆盖；注入现成 hub 时以 hub 自身配置为准。
  const collabAuthorize = typeof authorize === "function"
    ? authorize
    : (request) => !!(request && request.canvasId && request.clientId && request.userId);
  const collabHub = hub || new CanvasCollabHub({ clock, authorize: collabAuthorize });
  collabHub.onBroadcast = keepEvent;

  const actorOf = (context) => {
    const view = identity.validateSession(context && context.sessionRef, { sensitive: false });
    return view && view.ok ? view.user : null;
  };

  /**
   * 默认素材解析：优先走既有 canvas-service.readAsset（与画布页面同一条受控读取路径，
   * 含"资源属于当前用户本人"的兜底），失败再退回 resource-service.readDataUrl。
   */
  const resolveAssetDefault = (resourceId, context) => {
    let dataUrl = null;
    let name = null;
    if (canvasService && typeof canvasService.readAsset === "function") {
      // canvas-service.readAsset 只认裸 resourceId / resource://（authorization-domain.parseResourceRef），
      // 不能把 openarc-asset: 前缀原样传进去。
      const read = canvasService.readAsset({ context, ref: String(resourceId) });
      if (read && read.ok) { dataUrl = read.dataUrl; name = read.name; }
    }
    if (!dataUrl && resourceService && typeof resourceService.readDataUrl === "function") {
      const data = resourceService.readDataUrl({ context, resourceRef: String(resourceId), maxBytes: 64 * 1024 * 1024 });
      if (data && data.ok) { dataUrl = data.dataUrl; name = data.name; }
    }
    if (!dataUrl) return null;
    const match = /^data:([^;,]{1,120});base64,([A-Za-z0-9+/=]*)$/.exec(dataUrl);
    if (!match) return null;
    return { data: Buffer.from(match[2], "base64"), name, mime: match[1] };
  };

  const handlers = {
    "canvas/assetLibrary/list": (payload, context) => assetLibrary.listLibraries({ context }),
    "canvas/assetLibrary/characterCreate": (payload, context) => assetLibrary.characterCreate({ context, libraryId: asStr(payload.libraryId, 120), name: asStr(payload.name, 80), description: asStr(payload.description, 500) || "", prompt: asStr(payload.prompt, 4000) || "", referenceUrls: Array.isArray(payload.referenceUrls) ? payload.referenceUrls : [] }),
    "canvas/assetLibrary/characterList": (payload, context) => assetLibrary.characterList({ context, libraryId: asStr(payload.libraryId, 120) }),
    "canvas/assetLibrary/characterUpdate": (payload, context) => assetLibrary.characterUpdate({ context, libraryId: asStr(payload.libraryId, 120), itemId: asStr(payload.id, 80), name: payload.name, description: payload.description, prompt: payload.prompt, referenceUrls: payload.referenceUrls }),
    "canvas/assetLibrary/characterDelete": (payload, context) => assetLibrary.characterDelete({ context, libraryId: asStr(payload.libraryId, 120), itemId: asStr(payload.id, 80) }),
    "canvas/assetLibrary/folderList": (payload, context) => assetLibrary.folderList({ context, libraryId: asStr(payload.libraryId, 120) }),
    "canvas/assetLibrary/folderCreate": (payload, context) => assetLibrary.folderCreate({ context, libraryId: asStr(payload.libraryId, 120), name: asStr(payload.name, 60) }),
    "canvas/assetLibrary/folderRename": (payload, context) => assetLibrary.folderRename({ context, libraryId: asStr(payload.libraryId, 120), from: asStr(payload.from, 60), to: asStr(payload.to, 60) }),
    "canvas/assetLibrary/folderMove": (payload, context) => assetLibrary.folderMove({ context, libraryId: asStr(payload.libraryId, 120), itemId: asStr(payload.itemId, 80), folder: asStr(payload.folder, 60) }),
    "canvas/assetLibrary/ensure": (payload, context) => assetLibrary.ensureDefaultLibrary({ context }),
    "canvas/assetLibrary/create": (payload, context) => assetLibrary.createLibrary({ context, name: asStr(payload.name, 120), visibility: asStr(payload.visibility, 20) }),
    "canvas/assetLibrary/get": (payload, context) => assetLibrary.getLibrary({ context, libraryId: asStr(payload.libraryId, 120) }),
    "canvas/assetLibrary/items": (payload, context) => assetLibrary.listItems({ context, libraryId: asStr(payload.libraryId, 120), kind: asStr(payload.kind, 20), query: asStr(payload.query, 120) }),
    "canvas/assetLibrary/import": (payload, context) => assetLibrary.importAssetItem({
      context, libraryId: asStr(payload.libraryId, 120), name: asStr(payload.name, 120), mime: asStr(payload.mime, 120),
      dataUrl: typeof payload.dataUrl === "string" ? payload.dataUrl.slice(0, 12 * 1024 * 1024) : null,
      base64: typeof payload.base64 === "string" ? payload.base64.slice(0, 12 * 1024 * 1024) : null,
      sourcePath: asStr(payload.sourcePath, 500), title: asStr(payload.title, 160), group: asStr(payload.group, 40),
      tags: Array.isArray(payload.tags) ? payload.tags : [], sourceKey: asStr(payload.sourceKey, 500),
    }),
    "canvas/assetLibrary/upsert": (payload, context) => assetLibrary.upsertItem({ context, libraryId: asStr(payload.libraryId, 120), item: payload.item && typeof payload.item === "object" ? payload.item : {} }),
    "canvas/assetLibrary/update": (payload, context) => assetLibrary.updateLibrary({ context, libraryId: asStr(payload.libraryId, 120), name: asStr(payload.name, 120), visibility: asStr(payload.visibility, 20), publicAccess: asStr(payload.publicAccess, 20), baseVersion: num(payload.baseVersion) }),
    "canvas/assetLibrary/reference": (payload, context) => assetLibrary.referenceItem({ context, libraryId: asStr(payload.libraryId, 120), itemId: asStr(payload.itemId, 120) }),
    "canvas/assetLibrary/attach": (payload, context) => assetLibrary.attachItemToCanvas({ context, libraryId: asStr(payload.libraryId, 120), itemId: asStr(payload.itemId, 120), canvasId: asStr(payload.canvasId, 120), x: num(payload.x) || 0, y: num(payload.y) || 0 }),
    "canvas/assetLibrary/delete": (payload, context) => assetLibrary.deleteItem({ context, libraryId: asStr(payload.libraryId, 120), itemId: asStr(payload.itemId, 120) }),
    "canvas/assetLibrary/syncSources": (payload, context) => assetLibrary.syncSources({
      context, libraryId: asStr(payload.libraryId, 120),
      items: Array.isArray(payload.items) ? payload.items.slice(0, 600) : [],
    }),
    "canvas/assetMembers/list": (payload, context) => assetLibrary.listMembers({ context, libraryId: asStr(payload.libraryId, 120) }),
    "canvas/assetMembers/set": (payload, context) => assetLibrary.setMember({ context, libraryId: asStr(payload.libraryId, 120), userId: asStr(payload.userId, 120), role: asStr(payload.role, 20) }),
    "canvas/assetMembers/remove": (payload, context) => assetLibrary.removeMember({ context, libraryId: asStr(payload.libraryId, 120), userId: asStr(payload.userId, 120) }),

    "canvas/collab/join": (payload, context) => {
      const user = actorOf(context);
      if (!user) return fail("NOT_FOUND_OR_FORBIDDEN");
      const canvasId = asStr(payload.canvasId, 120);
      if (!canvasService || typeof canvasService.getCanvas !== "function") return fail("CANVAS_UNAVAILABLE");
      const view = canvasService.getCanvas({ context, canvasId });
      if (!view || !view.ok) return view && view.error ? view : fail("NOT_FOUND");
      return collabHub.join({
        canvasId, clientId: asStr(payload.clientId, 120), userId: user.id,
        username: asStr(payload.username, 80) || user.display_name || user.identifier || user.id,
        canEdit: !!(view.canvas.access && view.canvas.access.canEdit),
      });
    },
    "canvas/collab/leave": (payload) => collabHub.leave({ canvasId: asStr(payload.canvasId, 120), clientId: asStr(payload.clientId, 120) }),
    "canvas/collab/presence": (payload) => ok({ presence: collabHub.presence(asStr(payload.canvasId, 120)) }),
    "canvas/collab/heartbeat": (payload) => collabHub.heartbeat({ canvasId: asStr(payload.canvasId, 120), clientId: asStr(payload.clientId, 120) }),
    "canvas/collab/cursor": (payload) => collabHub.cursor({ canvasId: asStr(payload.canvasId, 120), clientId: asStr(payload.clientId, 120), x: payload.x, y: payload.y, nodeId: asStr(payload.nodeId, 120) }),
    "canvas/collab/patch": (payload) => collabHub.submitPatch({
      canvasId: asStr(payload.canvasId, 120), clientId: asStr(payload.clientId, 120),
      baseRevision: num(payload.baseRevision), currentRevision: num(payload.currentRevision),
      payload: payload.patch && typeof payload.patch === "object" ? { patches: Array.isArray(payload.patch.patches) ? payload.patch.patches : [], upserts: Array.isArray(payload.patch.upserts) ? payload.patch.upserts : [], deletedIds: Array.isArray(payload.patch.deletedIds) ? payload.patch.deletedIds : [], connections: Array.isArray(payload.patch.connections) ? payload.patch.connections : [] } : {},
    }),
    "canvas/collab/events": (payload) => {
      const key = String(asStr(payload.canvasId, 120) || "") + "\u0000" + String(asStr(payload.clientId, 120) || "");
      const queue = events.get(key) || [];
      events.set(key, []);
      return ok({ events: queue });
    },
    "canvas/collab/rooms": () => ok({ rooms: collabHub.liveRooms() }),
    "canvas/collab/sweep": () => collabHub.sweepIdle(),

    // ---- 邀请码（canvas-service 内与 share 同一事务/审计；只存 sha256） ----
    "canvas/invites/get": (payload, context) => {
      if (!canvasService || typeof canvasService.getCanvasInvite !== "function") return fail("DEPENDENCY_UNAVAILABLE", "canvasService.getCanvasInvite");
      return canvasService.getCanvasInvite({ context, canvasId: asStr(payload.canvasId, 120) });
    },
    "canvas/invites/create": (payload, context) => {
      if (!canvasService || typeof canvasService.createCanvasInvite !== "function") return fail("DEPENDENCY_UNAVAILABLE", "canvasService.createCanvasInvite");
      return canvasService.createCanvasInvite({ context, canvasId: asStr(payload.canvasId, 120), permission: asStr(payload.permission, 20) });
    },
    "canvas/invites/revoke": (payload, context) => {
      if (!canvasService || typeof canvasService.revokeCanvasInvite !== "function") return fail("DEPENDENCY_UNAVAILABLE", "canvasService.revokeCanvasInvite");
      return canvasService.revokeCanvasInvite({ context, canvasId: asStr(payload.canvasId, 120) });
    },
    "canvas/invites/redeem": (payload, context) => {
      if (!canvasService || typeof canvasService.redeemCanvasInvite !== "function") return fail("DEPENDENCY_UNAVAILABLE", "canvasService.redeemCanvasInvite");
      return canvasService.redeemCanvasInvite({ context, code: asStr(payload.code, 40) });
    },

    // ---- 画布插件数据 / 受控网络（宿主晚绑定 developerBundle；未绑定即结构化不可用） ----
    "canvas/plugins/data": (payload, context) => {
      const user = actorOf(context);
      if (!user) return fail("NOT_FOUND_OR_FORBIDDEN");
      if (!pluginHost) return fail("DEPENDENCY_UNAVAILABLE", "canvasPluginHost");
      return pluginHost.data({
        userId: user.id,
        pluginId: asStr(payload.pluginId, 80),
        action: asStr(payload.action, 20),
        key: asStr(payload.key, 160),
        value: payload.value,
      });
    },
    "canvas/plugins/network": (payload, context) => {
      const user = actorOf(context);
      if (!user) return fail("NOT_FOUND_OR_FORBIDDEN");
      if (!pluginHost) return fail("DEPENDENCY_UNAVAILABLE", "canvasPluginHost");
      return pluginHost.network({
        sessionRef: context && context.sessionRef,
        userId: user.id,
        pluginId: asStr(payload.pluginId, 80),
        request: payload.request && typeof payload.request === "object" ? payload.request : {},
      });
    },
    "canvas/plugins/registry": (payload, context) => {
      const user = actorOf(context);
      if (!user) return fail("NOT_FOUND_OR_FORBIDDEN");
      if (!pluginHost) return fail("DEPENDENCY_UNAVAILABLE", "canvasPluginHost");
      return pluginHost.registry({ rebuild: payload.rebuild === true, userId: user.id });
    },
    "canvas/plugins/execute": (payload, context) => {
      const user = actorOf(context);
      if (!user) return fail("NOT_FOUND_OR_FORBIDDEN");
      if (!pluginHost) return fail("DEPENDENCY_UNAVAILABLE", "canvasPluginHost");
      return pluginHost.execute({
        userId: user.id,
        pluginId: asStr(payload.pluginId, 80),
        executorType: asStr(payload.executorType, 40) || "workflow",
        action: asStr(payload.action, 80) || "execute",
        input: payload.input == null ? null : payload.input,
      });
    },

    "canvas/protocolTasks/list": (payload, context) => {
      if (!canvasService || typeof canvasService.protocolTasks !== "function") return fail("CANVAS_UNAVAILABLE");
      return canvasService.protocolTasks({ context, canvasId: asStr(payload.canvasId, 120), limit: num(payload.limit) || 50 });
    },
    "canvas/capabilities/list": () => {
      const projection = buildCanvasKernelCapabilities({ nodeTypes });
      return ok({ projection, descriptors: toCatalogDescriptors(projection.capabilities), registry: DXOS_CANVAS_COMMANDS.map((entry) => ({ ...entry })) });
    },

    "canvas/nodes/list": () => ok({ registry: nodeRegistry.summary(), nodes: nodeRegistry.list() }),
    "canvas/nodes/get": (payload) => {
      const type = asStr(payload.type, 120);
      if (!type) return fail("INVALID_INPUT", "type");
      const node = nodeRegistry.describe(type);
      return node ? ok({ node }) : fail(NODE_ERROR.NODE_TYPE_UNKNOWN, { type });
    },
    "canvas/nodes/validate": (payload) => {
      if (payload.connection && typeof payload.connection === "object") {
        return nodeRegistry.validateConnection({
          from: asStr(payload.connection.from, 120), fromPort: asStr(payload.connection.fromPort, 80),
          to: asStr(payload.connection.to, 120), toPort: asStr(payload.connection.toPort, 80),
        });
      }
      const type = asStr(payload.type, 120);
      if (!type) return fail("INVALID_INPUT", "type");
      if (payload.ports && typeof payload.ports === "object") return nodeRegistry.validatePorts(type, payload.ports);
      return nodeRegistry.validateParams(type, payload.params == null ? {} : payload.params);
    },
    "canvas/nodes/execute": async (payload, context) => {
      const user = actorOf(context);
      if (!user) return fail("NOT_FOUND_OR_FORBIDDEN");
      const canvasId = asStr(payload.canvasId, 120);
      const type = asStr(payload.type, 120);
      if (payload.async === true && canvasService && typeof canvasService.startRun === "function" && /video-generator|audio-generator|model3d/.test(String(type || ""))) {
        const kind = String(type).includes("video") ? "video" : String(type).includes("audio") ? "audio" : "3d";
        // 10-23：带上节点选的模型（不带时按「默认视频模型」解析，没设默认就会 MODEL_CONFIG_UNAVAILABLE）
        const started = canvasService.startRun({ context, canvasId, nodeId: asStr(payload.nodeId, 120) || null, kind, configId: payload.params && typeof payload.params.configId === "string" ? payload.params.configId.slice(0, 120) : null });
        if (!started || started.ok !== true) return started || fail("RUN_UNAVAILABLE");
        const runId = started.runId;
        canvasService.asyncRuns.set(runId, { status: "RUNNING", result: null, error: null, startedAt: Date.now(), finishedAt: null, canvasId });
        void (async () => {
          try {
            const result = await nodeRegistry.execute({ type, params: payload.params, context, canvasId, nodeId: asStr(payload.nodeId, 120), writeBack: payload.writeBack === true, node: payload.node && typeof payload.node === "object" ? payload.node : null });
            const current = canvasService.asyncRuns.get(runId);
            if (current && current.status === "STOPPED") return;
            if (result && result.ok === true) canvasService.asyncRuns.set(runId, { ...(canvasService.asyncRuns.get(runId) || {}), status: "DONE", result, finishedAt: Date.now() });
            // 失败原因要带出来：只给错误码（如 CANVAS_NODE_PARAMS_INVALID）时，画布只能显示一个裸 code，
            // 参数校验的 errors[] 会整条丢掉（真机就是这样丢了"params.images[0] 长度超过 400"）。
            else canvasService.asyncRuns.set(runId, { ...(canvasService.asyncRuns.get(runId) || {}), status: "FAILED", error: String((result && result.error) || "NODE_EXECUTION_FAILED") + asyncFailureDetail(result && result.detail), finishedAt: Date.now() });
          } catch (error) { canvasService.asyncRuns.set(runId, { ...(canvasService.asyncRuns.get(runId) || {}), status: "FAILED", error: String((error && error.message) || "NODE_EXECUTION_FAILED"), finishedAt: Date.now() }); }
          finally { const entry = canvasService.asyncRuns.get(runId); if (entry && entry.status !== "STOPPED") { try { canvasService.finishRun({ context, canvasId, runId, status: entry.status === "DONE" ? "DONE" : "FAILED" }); } catch { /* ignore */ } } }
        })();
        return { ok: true, async: true, runId, taskId: started.taskId || null };
      }
      const result = await nodeRegistry.execute({
        type: asStr(payload.type, 120), params: payload.params, context,
        canvasId, nodeId: asStr(payload.nodeId, 120),
        writeBack: payload.writeBack === true, node: payload.node && typeof payload.node === "object" ? payload.node : null,
      });
      if (!result || result.ok !== true || !canvasService || typeof canvasService.importAsset !== "function") return result;
      let importError = null;
      const resourceType = String(payload.type || "").includes("video") ? "video" : String(payload.type || "").includes("audio") ? "audio" : String(payload.type || "").includes("model3d") ? "model" : "image";
      const visit = async (value) => {
        if (Array.isArray(value)) { const out = []; for (const item of value) out.push(await visit(item)); return out; }
        if (!value || typeof value !== "object") return value;
        const copy = { ...value };
        const dataUrl = typeof copy.dataUrl === "string" && copy.dataUrl.startsWith("data:") ? copy.dataUrl : (typeof copy.url === "string" && copy.url.startsWith("data:") ? copy.url : null);
        if (dataUrl) {
          const imported = await canvasService.importAsset({ context, canvasId, name: "节点产物-" + Date.now().toString(36), dataUrl, resourceType });
          if (imported && imported.ok && imported.ref) { copy.url = imported.ref; copy.ref = imported.ref; copy.dataUrl = null; }
          else importError = String((imported && (imported.error || imported.detail)) || "ASSET_IMPORT_FAILED");
        }
        for (const key of Object.keys(copy)) { if (key !== "url" && key !== "dataUrl" && copy[key] && typeof copy[key] === "object") copy[key] = await visit(copy[key]); }
        return copy;
      };
      const outputs = await visit(result.outputs);
      return { ...result, outputs, result: outputs, ...(importError ? { assetFallback: "base64", assetImportError: importError } : {}) };
    },

    "canvas/agentAttachments/list": (payload, context) => attachments.list({ context, canvasId: asStr(payload.canvasId, 120), includeRemoved: !!payload.includeRemoved }),
    "canvas/agentAttachments/extract": (payload) => {
      const files = Array.isArray(payload.files) ? payload.files : [];
      const normalized = files.slice(0, 12).map((file) => ({
        name: asStr(file && file.name, 300),
        mime: asStr(file && file.mime, 120),
        size: num(file && file.size),
        buffer: Buffer.from(typeof (file && (file.base64 || file.dataUrl)) === "string" ? String(file.base64 || file.dataUrl).replace(/^data:[^;]*;base64,/, "") : "", "base64"),
      }));
      const extracted = extractAttachments(normalized);
      if (!extracted.ok) return extracted;
      return ok({ attachments: extracted.attachments.map(({ buffer, ...rest }) => rest) });
    },
    "canvas/agentAttachments/mount": (payload, context) => {
      const files = (Array.isArray(payload.files) ? payload.files : []).slice(0, 12).map((file) => ({
        name: asStr(file && file.name, 300), mime: asStr(file && file.mime, 120), size: num(file && file.size),
        buffer: Buffer.from(typeof (file && (file.base64 || file.dataUrl)) === "string" ? String(file.base64 || file.dataUrl).replace(/^data:[^;]*;base64,/, "") : "", "base64"),
      }));
      return attachments.mount({ context, canvasId: asStr(payload.canvasId, 120), files, runId: asStr(payload.runId, 120) });
    },
    "canvas/agentAttachments/unmount": (payload, context) => attachments.unmount({ context, canvasId: asStr(payload.canvasId, 120), attachmentId: asStr(payload.attachmentId, 120) }),

    "canvas/package/export": (payload, context) => {
      if (!canvasService || typeof canvasService.getCanvas !== "function") return fail("CANVAS_UNAVAILABLE");
      const canvasId = asStr(payload.canvasId, 120);
      const view = canvasService.getCanvas({ context, canvasId });
      if (!view || !view.ok) return view && view.error ? view : fail("NOT_FOUND");
      const buffer = buildCanvasPackage(view.canvas.doc, (resourceId) => resolveAssetDefault(resourceId, context), {
        canvasId, title: view.canvas.title, icon: view.canvas.icon, kind: view.canvas.kind, revision: view.canvas.revision,
      });
      if (buffer.byteLength > MAX_INLINE_PACKAGE_BYTES) return fail("LIMIT_EXCEEDED", "package-too-large-to-inline");
      return ok({ byteLength: buffer.byteLength, sha256: sha256(buffer), base64: buffer.toString("base64"), format: "dx-canvas-package/v1" });
    },
    "canvas/package/import": async (payload, context) => {
      if (!canvasService) return fail("CANVAS_UNAVAILABLE");
      if (!resourceService || typeof resourceService.importManaged !== "function") return fail("RESOURCE_UNAVAILABLE");
      const base64 = typeof payload.base64 === "string" ? payload.base64 : "";
      if (!base64) return fail("INVALID_INPUT", "base64");
      const buffer = Buffer.from(base64, "base64");
      if (!buffer.length) return fail("INVALID_INPUT", "empty");
      let parsed;
      // 解析失败必须是"结构化失败"，不能把异常抛回 IPC 边界（否则渲染层只看到 INTERNAL_ERROR）。
      try { parsed = parseCanvasPackage(buffer); }
      catch (error) { return fail(String((error && error.message) || error), "package"); }
      const created = canvasService.createCanvas({
        context,
        title: String(payload.title || parsed.manifest.canvas.title || "导入画布").slice(0, 200) + "（导入）",
        icon: parsed.manifest.canvas.icon || "🧩",
        kind: parsed.manifest.canvas.kind || "classic",
      });
      if (!created.ok) return created;
      const canvasId = created.canvas.canvasId;
      const dir = packageTempDir(tempDir);
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
      const mediaIds = new Map();
      try {
        for (const asset of parsed.assets) {
          const safe = String(asset.name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "asset";
          const file = path.join(dir, "dxcanvas-" + crypto.randomBytes(4).toString("hex") + "-" + safe);
          fs.writeFileSync(file, asset.data);
          try {
            const imported = await resourceService.importManaged({ context: { ...context, appId: "resource-library" }, sourcePath: file, name: safe, mimeType: asset.mime, scope: "PERSONAL" });
            if (!imported || !imported.ok) throw new Error(imported && imported.error ? imported.error : "IMPORT_FAILED");
            const ref = imported.resource && (imported.resource.resourceId || imported.resource.resourceRef);
            mediaIds.set(asset.sourceId, String(ref).replace(/^resource:\/\//, "").replace(/^openarc-asset:/, ""));
          } finally {
            try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
          }
        }
        const doc = remapCanvasPackageDocument(parsed.manifest.document, mediaIds, canvasId);
        const saved = canvasService.saveCanvas({ context, canvasId, baseRevision: created.canvas.revision, doc });
        if (!saved.ok) throw new Error(saved.error);
        return ok({ canvas: saved.canvas, canvasId, importedAssets: mediaIds.size });
      } catch (error) {
        // 失败回滚：导入失败的画布不留在列表里（资源对象由资源域 GC 处理，不在这里硬删）。
        try { canvasService.purgeCanvas({ context, canvasId }); } catch { /* best effort */ }
        return fail(String((error && error.message) || error));
      }
    },
  };

  const dispatch = ({ command, payload, context } = {}) => {
    const entry = REGISTRY.get(String(command || ""));
    if (!entry) return fail("CANVAS_COMMAND_NOT_ALLOWED", String(command || ""));
    const handler = handlers[entry.command];
    if (typeof handler !== "function") return fail("NOT_IMPLEMENTED", entry.command);
    const safePayload = payload && typeof payload === "object" ? payload : {};
    return handler(safePayload, context || {});
  };

  return {
    channel: CHANNEL,
    registry: DXOS_CANVAS_COMMANDS.map((entry) => ({ ...entry })),
    /** 晚绑定画布插件宿主（main 在 developerBundle 装配后调用；未绑定即命令结构化不可用）。 */
    configurePlugins({ pluginHost: next = null } = {}) {
      pluginHost = next && typeof next.data === "function" && typeof next.network === "function" ? next : null;
      return { configured: !!pluginHost };
    },
    commandNames: DXOS_CANVAS_COMMANDS.map((entry) => entry.command),
    extendRendererCommands: () => extendRendererCommands([]),
    hub: collabHub,
    events: {
      drain(canvasId, clientId) {
        const key = String(canvasId || "") + "\u0000" + String(clientId || "");
        const queue = events.get(key) || [];
        events.set(key, []);
        return queue;
      },
      size() { let total = 0; for (const queue of events.values()) total += queue.length; return total; },
    },
    dispatch,
    handlers,
    /** A03：运行期节点注册表（内置 + 本次装配传入的插件定义，同一 register 路径）。 */
    nodes: {
      registry: () => nodeRegistry.summary(),
      list: () => nodeRegistry.list(),
      get: (type) => nodeRegistry.describe(type),
      register: (definition) => nodeRegistry.register(definition, { origin: "plugin" }),
    },
  };
}

/**
 * 把扩展接到既有 canvas:command 上：先试扩展，再落回 base。
 * base 为空时只处理扩展命令（未登记命令返回 CANVAS_COMMAND_NOT_ALLOWED）。
 */
function combineCanvasCommandHandlers({ base = null, extension, identity = null, isTrusted = null, hostAppId = "canvas" } = {}) {
  if (!extension) throw new Error("combineCanvasCommandHandlers 需要 extension");
  return async (event, raw) => {
    if (typeof isTrusted === "function" && !isTrusted(event)) throw Error("Forbidden");
    if (!raw || typeof raw !== "object") return fail("INVALID_INPUT");
    const command = typeof raw.command === "string" ? raw.command : typeof raw.type === "string" ? raw.type : "";
    const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
    if (REGISTRY.has(command)) {
      const context = { sessionRef: identity ? identity.current : null, appId: hostAppId, source: "ui", requestId: asStr(payload.requestId, 80) };
      try { return extension.dispatch({ command, payload, context }); }
      catch { return fail("INTERNAL_ERROR"); }
    }
    if (typeof base === "function") return base(event, raw);
    return fail("CANVAS_COMMAND_NOT_ALLOWED", command);
  };
}

/**
 * Electron 侧注册（供装配处调用）：**只注册一个** canvas:command。
 * 注意：Electron 不允许同一通道二次 handle，所以这里先 removeHandler 再 handle；
 * 若 canvas-bootstrap 已注册，装配处应改为把 combineCanvasCommandHandlers 的结果交给它，
 * 或在本函数之前不要注册（见报告"待接线"）。
 */
function registerCanvasDxosIpc({ ipcMain, extension, base = null, identity = null, isTrusted = null, channel = CHANNEL } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("registerCanvasDxosIpc 需要 ipcMain");
  if (typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler(channel); } catch { /* not registered */ } }
  ipcMain.handle(channel, combineCanvasCommandHandlers({ base, extension, identity, isTrusted }));
}

function describeCommands() { return DXOS_CANVAS_COMMANDS.map((entry) => ({ ...entry })); }

module.exports = {
  CHANNEL, MAX_INLINE_PACKAGE_BYTES, DXOS_CANVAS_COMMANDS, REGISTRY,
  extendRendererCommands, createCanvasDxosExtension, combineCanvasCommandHandlers, registerCanvasDxosIpc, describeCommands,
  createCanvasGenerationPort, createCanvasVideoGenerationPort, createCanvasAudioGenerationPort,
};
