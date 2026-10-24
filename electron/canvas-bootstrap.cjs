/**
 * D5-02 · 画布装配 + IPC。
 *
 * 渲染进程（OpenArc 外壳里的画布宿主）只暴露**受控画布命令**：
 *   - 画布页面本身运行在 sandbox iframe 里，没有 openarc 桥、没有 IPC、没有文件系统、没有凭据；
 *     它的所有请求都由宿主经这里转发（见 public/novai-canvas/openarc-bridge.js）。
 *   - 身份与会话一律由主进程从已认证 session 推导；payload 里的 userId/owner 一律忽略。
 */
"use strict";

const { CanvasStore } = require("./canvas-store.cjs");
const { CanvasService } = require("./canvas-service.cjs");
// B5d：画布域扩展命令（素材库 / 协作 / 内核能力 / Agent 附件 / .dxcanvas）走同一个 canvas:command。
const { extendRendererCommands } = require("./canvas-dxos-commands.cjs");

const HOST_APP_ID = "canvas";

/** 宿主（渲染层）可下发的画布命令白名单（含 B5d 扩展命令）。新增能力必须显式登记。 */
const RENDERER_COMMANDS = extendRendererCommands([
  "canvas/create",
  "canvas/list",
  "canvas/get",
  "canvas/meta",
  "canvas/recent",
  "canvas/save",
  "canvas/trash",
  "canvas/restore",
  "canvas/purge",
  "canvas/share",
  // 共享的独立入口：改角色 / 移除 / 成员列表 / 候选人 / 访问查询 / 所有权转移（同一 envelope + 审计）
  "canvas/share/update",
  "canvas/share/remove",
  "canvas/share/candidates",
  "canvas/shares",
  "canvas/access/get",
  "canvas/owner/transfer",
  "canvas/visibility",
  "canvas/command",
  "canvas/undo",
  "canvas/log",
  "canvas/assetStates",
  // D5-02 Closure：一次生成 = 一个 Task（预算/停止/审计归属）；图片统一进资源库
  "canvas/run",
  "canvas/runStop",
  "canvas/runState",
  "canvas/runStatus",
  "canvas/runs",
  "canvas/runFinish",
  "canvas/modelChat",
  // 智能画布（上游 1e20abe5 起）的流式 LLM：与 canvas/modelChat 同一套前置，增量经 model:event 下行。
  "canvas/modelChatStream",
  "canvas/modelImage",
  "canvas/modelImageEdit",
  "canvas/model3d",
  "canvas/importAsset",
  "canvas/readAsset",
  // 10-23：新画布发给模型的素材一律换成 https 临时链接（Litterbox 24h），不再塞 base64
  "canvas/assetPublicUrl",
  // 10-23：模型返回的远程结果（https）由主进程下载进资源库（画布页 CSP 不显示外链，且结果链接会过期）
  "canvas/importRemote",
  // 10-16：画布「素材库」面板 = OpenArc 资源库里画布可引用的图片（缩略图 + 引用）
  "canvas/libraryList",
  "canvas/feedback/submit",
]);
const CANVAS_COMMAND_NOT_ALLOWED = "CANVAS_COMMAND_NOT_ALLOWED";

const asStr = (v, max = 512) => (typeof v === "string" ? v.slice(0, max) : v == null ? undefined : String(v).slice(0, max));

/**
 * 画布图片面板的「风格 / 摄影机 / 联网」在**主进程边界**归一（只解析一次，后续链路不再猜）：
 *   · style：字符串、trim 后 ≤40 字符；空 / 非字符串 → 不发送（不编造）；
 *   · camera：{ body, lens, focal, aperture }。每个字段接受**字符串**（≤40）或**索引**；
 *     索引按画布面板的取值表收敛到合法范围（越界夹到边界，不丢也不越权）；
 *   · webSearch：只认 boolean true。
 * 取值表与画布页 src/canvas/canvas-next/model.ts#CAMERAS 逐项一致（tests/style-camera-forward.test.mjs 做漂移核对）。
 */
const CAMERA_PARTS = Object.freeze({
  body: Object.freeze(["Sony Venice", "ARRI Alexa 35", "RED V-Raptor", "iPhone 17 Pro"]),
  lens: Object.freeze(["Zeiss Ultra Prime", "Cooke S7/i", "Canon K35"]),
  focal: Object.freeze([8, 14, 24, 35, 50, 75, 125]),
  aperture: Object.freeze(["ƒ/1.4", "ƒ/2", "ƒ/2.8", "ƒ/4", "ƒ/8"]),
});
const CAMERA_TEXT_MAX = 40;
const STYLE_TEXT_MAX = 40;

function sanitizeStyle(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().slice(0, STYLE_TEXT_MAX);
  return text || null;
}

function sanitizeCamera(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const key of Object.keys(CAMERA_PARTS)) {
    const raw = value[key];
    if (raw == null || raw === "") continue;
    if (typeof raw === "number") {
      const parts = CAMERA_PARTS[key];
      const index = Number.isFinite(raw) ? Math.trunc(raw) : 0;
      out[key] = parts[Math.max(0, Math.min(parts.length - 1, index))];
      continue;
    }
    const text = String(raw).trim().slice(0, CAMERA_TEXT_MAX);
    if (text) out[key] = text;
  }
  return Object.keys(out).length ? out : null;
}

/** 面板选项 → modelCall/模型出口需要的三个字段（没有就不带键，避免「空值也发」）。 */
function imagePanelOptions(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const style = sanitizeStyle(source.style);
  const camera = sanitizeCamera(source.camera);
  const webSearch = source.webSearch === true;
  return {
    ...(style ? { style } : {}),
    ...(camera ? { camera } : {}),
    ...(webSearch ? { webSearch: true } : {}),
  };
}

function createCanvasBundle({ identity = null, identityStore = null, resourceStore = null, resourceService = null, authService = null, authStore = null, clock = null, logger = null } = {}) {
  const idStore = identityStore || identity;
  if (!idStore) throw new Error("createCanvasBundle 需要 identityStore");
  const store = new CanvasStore({ identity: idStore, clock });
  // authStore 与治理/资源域共用同一个实例：共享/可见性/转移的审计与业务写入同一条连接、同一个事务。
  const service = new CanvasService({ identity: idStore, store, resourceStore, resourceService, authService, authStore, clock, logger });
  return { store, service };
}

function registerCanvasIpc({ ipcMain, service, identity, isTrusted, hostAppId = HOST_APP_ID, extension = null, assetPublicUrl = null, importRemote = null }) {
  if (typeof ipcMain.removeHandler === "function") {
    try { ipcMain.removeHandler("canvas:command"); } catch { /* not registered */ }
  }
  ipcMain.handle("canvas:command", async (e, raw) => {
    if (isTrusted && !isTrusted(e)) throw Error("Forbidden");
    if (!service) return { ok: false, error: "INTERNAL_ERROR", detail: "canvas-not-ready" };
    if (!raw || typeof raw !== "object") return { ok: false, error: "INVALID_INPUT" };
    // 命令名只接受**字符串**：canvas/command 这类命令把具体的画布命令放在 command 字段（对象）里。
    const command = typeof raw.command === "string" ? asStr(raw.command, 80) : asStr(raw.type, 80);
    if (!RENDERER_COMMANDS.includes(command)) return { ok: false, error: CANVAS_COMMAND_NOT_ALLOWED, detail: asStr(command, 80) || null };
    const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
    // 身份只来自主进程：渲染层传的 userId / owner / sessionRef 一律忽略。
    const context = { sessionRef: identity?.current ?? null, appId: hostAppId, source: "ui", requestId: asStr(payload.requestId, 80) };
    try {
      switch (command) {
        case "canvas/create":
          return service.createCanvas({ context, title: asStr(payload.title, 200), icon: asStr(payload.icon, 16), kind: asStr(payload.kind, 20) });
        case "canvas/list":
          return service.listCanvases({ context, includeTrashed: !!payload.includeTrashed });
        case "canvas/get":
          return service.getCanvas({ context, canvasId: asStr(payload.canvasId, 120) });
        case "canvas/meta":
          return service.metaCanvas({ context, canvasId: asStr(payload.canvasId, 120) });
        case "canvas/recent":
          return service.recentCanvases({ context, limit: Number(payload.limit) || 12 });
        case "canvas/save":
          return service.saveCanvas({
            context, canvasId: asStr(payload.canvasId, 120),
            baseRevision: payload.baseRevision == null ? null : Number(payload.baseRevision),
            doc: payload.doc, title: asStr(payload.title, 200), icon: asStr(payload.icon, 16),
          });
        case "canvas/trash": return service.trashCanvas({ context, canvasId: asStr(payload.canvasId, 120) });
        case "canvas/restore": return service.restoreCanvas({ context, canvasId: asStr(payload.canvasId, 120) });
        case "canvas/purge": return service.purgeCanvas({ context, canvasId: asStr(payload.canvasId, 120) });
        case "canvas/share":
          return service.shareCanvas({ context, canvasId: asStr(payload.canvasId, 120), userId: asStr(payload.userId, 120), role: asStr(payload.role, 20) });
        case "canvas/share/update":
          return service.updateShareRole({ context, canvasId: asStr(payload.canvasId, 120), userId: asStr(payload.userId, 120), role: asStr(payload.role, 20) });
        case "canvas/share/remove":
          return service.removeShare({ context, canvasId: asStr(payload.canvasId, 120), userId: asStr(payload.userId, 120) });
        case "canvas/share/candidates":
          return service.shareCandidates({
            context, canvasId: asStr(payload.canvasId, 120),
            query: asStr(payload.query, 120) || "",
            limit: Math.max(1, Math.min(50, Number(payload.limit) || 20)),
          });
        case "canvas/shares": return service.listShares({ context, canvasId: asStr(payload.canvasId, 120) });
        case "canvas/access/get": return service.accessGet({ context, canvasId: asStr(payload.canvasId, 120) });
        case "canvas/owner/transfer":
          return service.transferOwner({ context, canvasId: asStr(payload.canvasId, 120), newOwnerUserId: asStr(payload.newOwnerUserId, 120) });
        case "canvas/visibility": return service.setVisibility({ context, canvasId: asStr(payload.canvasId, 120), visibility: asStr(payload.visibility, 20) });
        case "canvas/command":
          return service.applyCommand({
            context, canvasId: asStr(payload.canvasId, 120),
            baseRevision: payload.baseRevision == null ? null : Number(payload.baseRevision),
            command: payload.command, actorKind: "USER",
          });
        case "canvas/undo":
          return service.undoLastCommand({ context, canvasId: asStr(payload.canvasId, 120), baseRevision: payload.baseRevision == null ? null : Number(payload.baseRevision) });
        case "canvas/log": return service.commandLog({ context, canvasId: asStr(payload.canvasId, 120), limit: Number(payload.limit) || 20 });
        case "canvas/assetStates": return service.assetStates({ context, refs: Array.isArray(payload.refs) ? payload.refs : [] });
        // ---- 生成运行：预算 / 停止 / 模型调用（唯一入口） ----
        case "canvas/run":
          return service.startRun({ context, canvasId: asStr(payload.canvasId, 120), nodeId: asStr(payload.nodeId, 120), kind: asStr(payload.kind, 20), configId: asStr(payload.configId, 120) || null });
        case "canvas/runStop":
          return service.stopRun({ context, canvasId: asStr(payload.canvasId, 120), runId: asStr(payload.runId, 120), reason: asStr(payload.reason, 60) });
        case "canvas/runStatus":
          return service.runStatus({ context, canvasId: asStr(payload.canvasId, 120), runId: asStr(payload.runId, 120) });
        case "canvas/runState":
          return service.runState({ context, canvasId: asStr(payload.canvasId, 120), runId: asStr(payload.runId, 120) });
        case "canvas/runs":
          return service.listRuns({ context, canvasId: asStr(payload.canvasId, 120), limit: Number(payload.limit) || 20 });
        case "canvas/runFinish":
          return service.finishRun({ context, canvasId: asStr(payload.canvasId, 120), runId: asStr(payload.runId, 120), status: asStr(payload.status, 20) });
        case "canvas/modelChat":
          return service.modelCall({
            context, canvasId: asStr(payload.canvasId, 120), runId: asStr(payload.runId, 120), kind: "chat",
            messages: Array.isArray(payload.messages) ? payload.messages.slice(0, 64) : [], configId: asStr(payload.configId, 120),
          });
        case "canvas/modelChatStream":
          return service.modelChatStream({
            context, canvasId: asStr(payload.canvasId, 120), runId: asStr(payload.runId, 120),
            messages: Array.isArray(payload.messages) ? payload.messages.slice(0, 64) : [], configId: asStr(payload.configId, 120),
            requestId: asStr(payload.requestId, 80), webSearch: payload.webSearch === true,
          });
        case "canvas/modelImage": {
          const canvasId = asStr(payload.canvasId, 120);
          const params = {
            prompt: asStr(payload.prompt, 4000), size: asStr(payload.size, 32), ratio: asStr(payload.ratio, 32) || null, resolution: asStr(payload.resolution, 32) || null, customSize: asStr(payload.customSize, 64) || null, customRatio: asStr(payload.customRatio, 32) || null, count: Math.max(1, Math.min(4, Number(payload.count) || 1)), configId: asStr(payload.configId, 120),
            // 风格 / 摄影机 / 联网：只在这里解析一次，再原样交给 canvas-service → model-service
            ...imagePanelOptions(payload),
          };
          if (payload.async === true) {
            let runId = asStr(payload.runId, 120) || null;
            if (!runId) {
              const started = service.startRun({ context, canvasId, nodeId: asStr(payload.nodeId, 120) || null, kind: "image", configId: params.configId || null });
              if (!started || started.ok !== true) return started || { ok: false, error: "RUN_UNAVAILABLE" };
              runId = started.runId;
            } else {
              const run = service.store.runById(runId);
              if (!run || String(run.canvas_id) !== String(canvasId) || run.status !== "RUNNING") return { ok: false, error: "RUN_NOT_FOUND" };
            }
            const launched = service.startAsyncModelCall({ context, canvasId, runId, nodeId: asStr(payload.nodeId, 120) || null, ...params });
            if (!launched || launched.ok !== true) return launched;
            return { ok: true, async: true, runId, taskId: launched.taskId || null };
          }
          return service.modelCall({ context, canvasId, runId: asStr(payload.runId, 120), kind: "image", ...params });
        }
        case "canvas/modelImageEdit": {
          const canvasId = asStr(payload.canvasId, 120);
          if (!canvasId) return { ok: false, error: "INVALID_INPUT" };
          const requestedRunId = asStr(payload.runId, 120) || null;
          let started = null;
          let ownsRun = false;
          if (requestedRunId) {
            const existing = service.store.runById(requestedRunId);
            if (!existing || String(existing.canvas_id) !== String(canvasId) || existing.status !== "RUNNING") return { ok: false, error: "RUN_NOT_FOUND", detail: "run-must-be-running-on-canvas" };
            started = { ok: true, runId: requestedRunId };
          } else {
            started = service.startRun({ context, canvasId, nodeId: asStr(payload.nodeId, 120) || null, kind: "image" });
            if (!started || started.ok !== true) return started && started.ok === false ? started : { ok: false, error: "RUN_UNAVAILABLE" };
            ownsRun = true;
          }
          let terminal = "FAILED";
          try {
            // 10-23：优先走模型配置自带凭据的编辑出口（Lovart：重绘 / 擦除 / 扩图 / 多角度 / 重打光 / 增强 / 抠图 / 图生图）
            if (typeof service.modelService.editImage === "function") {
              const inputs = (Array.isArray(payload.inputDataUrls) ? payload.inputDataUrls : []).filter((x) => typeof x === "string").slice(0, 8).map((x) => x.slice(0, 12 * 1024 * 1024));
              let sourceDataUrl = typeof payload.sourceDataUrl === "string" ? payload.sourceDataUrl.slice(0, 12 * 1024 * 1024) : "";
              // 局部重绘 / 擦除：挖空图之外再带一张原图（支持遮罩的模型按「原图 + 遮罩」发，才看得到要改的东西）
              const originalDataUrl = typeof payload.originalDataUrl === "string" && payload.originalDataUrl.startsWith("data:image/") ? payload.originalDataUrl.slice(0, 12 * 1024 * 1024) : "";
              const maskPngDataUrl = typeof payload.maskPngDataUrl === "string" && payload.maskPngDataUrl.startsWith("data:image/png") ? payload.maskPngDataUrl.slice(0, 8 * 1024 * 1024) : "";
              if (!sourceDataUrl && typeof payload.sourceRef === "string" && payload.sourceRef) {
                const ref = asStr(payload.sourceRef, 2000);
                if (/^https:\/\//i.test(ref)) inputs.unshift(ref); // 远程原图：交给适配器下载后上传成附件
                else { const r = service.readAsset({ context, ref }); if (r && r.ok && r.dataUrl) sourceDataUrl = r.dataUrl; }
              }
              const direct = await service.modelService.editImage({ context: { ...context, appId: "canvas" }, configId: asStr(payload.configId, 120) || null, mode: asStr(payload.mode, 20) || "prompt", prompt: asStr(payload.prompt, 4000), sourceDataUrl, originalDataUrl, maskPngDataUrl, inputs, requestId: "canvas_edit_" + started.runId });
              if (!(direct && direct.ok === false && direct.detail === "adapter-no-image-edit")) {
                if (!direct || direct.ok !== true) return direct && direct.ok === false ? direct : { ok: false, error: "IMAGE_EDIT_FAILED" };
                terminal = "DONE";
                return { ok: true, images: Array.isArray(direct.images) ? direct.images : [], runId: started.runId };
              }
            }
            const resolved = service.modelService.resolveModel({ context: { ...context, appId: "canvas" }, capability: "image-generation", configId: asStr(payload.configId, 120) || null });
            if (!resolved || resolved.ok !== true) return resolved && resolved.ok === false ? resolved : { ok: false, error: "MODEL_CONFIG_UNAVAILABLE" };
            const protocol = service.modelService.providerProtocol && service.modelService.providerProtocol.service;
            if (!protocol || typeof protocol.generateImageEdit !== "function") return { ok: false, error: "IMAGE_EDIT_UNAVAILABLE", detail: "lovart-image-edit-required" };
            const result = await protocol.generateImageEdit({ providerId: resolved.snapshot.providerId, model: resolved.snapshot.modelId, prompt: asStr(payload.prompt, 4000), mode: asStr(payload.mode, 20) || "redraw", sourceDataUrl: typeof payload.sourceDataUrl === "string" ? payload.sourceDataUrl.slice(0, 12 * 1024 * 1024) : "", requestId: "canvas_edit_" + started.runId });
            if (!result || result.ok !== true) return result && result.ok === false ? result : { ok: false, error: "IMAGE_EDIT_FAILED" };
            terminal = "DONE";
            return { ok: true, images: Array.isArray(result.images) ? result.images : [], runId: started.runId };
          } finally {
            if (ownsRun) { try { service.finishRun({ context, canvasId, runId: started.runId, status: terminal }); } catch { /* ignore */ } }
          }
        }
        case "canvas/model3d": {
          const canvasId = asStr(payload.canvasId, 120);
          if (!canvasId) return { ok: false, error: "INVALID_INPUT" };
          const started = service.startRun({ context, canvasId, nodeId: asStr(payload.nodeId, 120) || null, kind: "3d", configId: asStr(payload.configId, 120) || null });
          // 没开成运行时直接把原因带回（之前会回一个没有 runId 的「成功」，前端无从查询进度、什么也不发生）
          if (!started || started.ok !== true) return started && started.ok === false ? started : { ok: false, error: "RUN_UNAVAILABLE" };
          if (payload.async === true) {
            const runId = started.runId;
            service.asyncRuns.set(runId, { status: "RUNNING", result: null, error: null, startedAt: Date.now(), finishedAt: null, canvasId });
            void (async () => {
              try {
                const resolved = service.modelService.resolveModel({ context: { ...context, appId: "canvas" }, capability: "3d-generation", configId: asStr(payload.configId, 120) || null });
                if (!resolved || resolved.ok !== true) throw new Error(String((resolved && resolved.error) || "MODEL_CONFIG_UNAVAILABLE"));
                const protocol = service.modelService.providerProtocol && service.modelService.providerProtocol.service;
                if (!protocol || typeof protocol.generate3d !== "function") throw new Error("MODEL_3D_UNAVAILABLE");
                const mode3d = asStr(payload.mode, 10) === "image" ? "image" : "text";
                const result = await protocol.generate3d({ providerId: resolved.snapshot.providerId, model: resolved.snapshot.modelId, prompt: asStr(payload.prompt, 4000), imageDataUrl: typeof payload.sourceDataUrl === "string" ? payload.sourceDataUrl.slice(0, 12 * 1024 * 1024) : null, mode: mode3d, requestId: "canvas_3d_" + runId });
                const current = service.asyncRuns.get(runId);
                if (current && current.status === "STOPPED") return;
                if (result && result.ok === true) service.asyncRuns.set(runId, { ...(service.asyncRuns.get(runId) || {}), status: "DONE", result: { ok: true, modelUrl: result.modelUrl, mediaPath: result.mediaPath, taskId: result.taskId }, finishedAt: Date.now() });
                else service.asyncRuns.set(runId, { ...(service.asyncRuns.get(runId) || {}), status: "FAILED", error: String((result && (result.error || result.detail)) || "MODEL_3D_FAILED"), finishedAt: Date.now() });
              } catch (error) { service.asyncRuns.set(runId, { ...(service.asyncRuns.get(runId) || {}), status: "FAILED", error: String((error && error.message) || "MODEL_3D_FAILED"), finishedAt: Date.now() }); }
              finally { const entry = service.asyncRuns.get(runId); if (entry && entry.status !== "STOPPED") { try { service.finishRun({ context, canvasId, runId, status: entry.status === "DONE" ? "DONE" : "FAILED" }); } catch { /* ignore */ } } }
            })();
            return { ok: true, async: true, runId, taskId: started.taskId || null };
          }
          if (!started || started.ok !== true) return started && started.ok === false ? started : { ok: false, error: "RUN_UNAVAILABLE" };
          let terminal = "FAILED";
          try {
            const resolved = service.modelService.resolveModel({ context: { ...context, appId: "canvas" }, capability: "3d-generation", configId: asStr(payload.configId, 120) || null });
            if (!resolved || resolved.ok !== true) return resolved && resolved.ok === false ? resolved : { ok: false, error: "MODEL_CONFIG_UNAVAILABLE" };
            const protocol = service.modelService.providerProtocol && service.modelService.providerProtocol.service;
            if (!protocol || typeof protocol.generate3d !== "function") return { ok: false, error: "MODEL_3D_UNAVAILABLE", detail: "tripo-3d-provider-required" };
            const mode3d = asStr(payload.mode, 10) === "image" ? "image" : "text";
            const result = await protocol.generate3d({ providerId: resolved.snapshot.providerId, model: resolved.snapshot.modelId, prompt: asStr(payload.prompt, 4000), imageUrl: asStr(payload.imageUrl, 2000) || null, imageDataUrl: typeof payload.sourceDataUrl === "string" ? payload.sourceDataUrl.slice(0, 12 * 1024 * 1024) : null, mode: mode3d, requestId: "canvas_3d_" + started.runId });
            if (!result || result.ok !== true) {
              if (result && result.error === "CREDIT_INSUFFICIENT") return { ok: false, error: "CREDIT_INSUFFICIENT", code: "2010", detail: "Tripo 额度不足" };
              return result && result.ok === false ? result : { ok: false, error: "MODEL_3D_FAILED" };
            }
            terminal = "DONE";
            return { ok: true, modelUrl: result.modelUrl, mediaPath: result.mediaPath, taskId: result.taskId, runId: started.runId };
          } finally {
            try { service.finishRun({ context, canvasId, runId: started.runId, status: terminal }); } catch { /* ignore */ }
          }
        }
        case "canvas/feedback/submit":
          return service.submitFeedback({ context, category: asStr(payload.category, 20), text: asStr(payload.text, 4000), canvasId: asStr(payload.canvasId, 120) || null, nodeId: asStr(payload.nodeId, 120) || null, appVersion: asStr(payload.appVersion, 80) || null });
        case "canvas/importAsset":
          return service.importAsset({ context, canvasId: asStr(payload.canvasId, 120), name: asStr(payload.name, 120), dataUrl: typeof payload.dataUrl === "string" ? payload.dataUrl.slice(0, 280 * 1024 * 1024) : "" });
        case "canvas/readAsset":
          return service.readAsset({ context, ref: asStr(payload.ref, 200) });
        case "canvas/assetPublicUrl":
          if (typeof assetPublicUrl !== "function") return { ok: false, error: "DEPENDENCY_UNAVAILABLE", detail: "asset-public-url-not-ready" };
          return await assetPublicUrl({ context, canvasId: asStr(payload.canvasId, 120), ref: asStr(payload.ref, 200), dataUrl: typeof payload.dataUrl === "string" ? payload.dataUrl : null });
        case "canvas/importRemote":
          if (typeof importRemote !== "function") return { ok: false, error: "DEPENDENCY_UNAVAILABLE", detail: "import-remote-not-ready" };
          return await importRemote({ context, canvasId: asStr(payload.canvasId, 120), url: asStr(payload.url, 4000), name: asStr(payload.name, 120) });
        case "canvas/libraryList":
          return service.libraryList({ context, limit: Number(payload.limit) || 60, query: asStr(payload.query, 120) || "" });
        default: {
          // B5d：白名单里的扩展命令先交给同一个扩展分发；未命中/未装配一律回落既有错误码，不放行任意命令。
          if (extension && typeof extension.dispatch === "function") {
            // 扩展分发两种等价形状都兼容：B5c 扩展用 { command, payload, context }，
            // 位置参数形状（dispatch(command, payload, ctx)）也接受 —— 只差在声明参数个数。
            const dispatched = extension.dispatch.length >= 2
              ? extension.dispatch(command, payload, context)
              : extension.dispatch({ command, payload, context });
            if (dispatched != null) return dispatched;
          }
          return { ok: false, error: CANVAS_COMMAND_NOT_ALLOWED, detail: asStr(command, 80) || null };
        }
      }
    } catch (err) {
      try { console.error("[canvas] command failed", { command: typeof raw.command === "string" ? raw.command : raw.type, message: err && err.message ? String(err.message).slice(0, 300) : "unknown" }); } catch { /* ignore */ }
      return { ok: false, error: "INTERNAL_ERROR" };
    }
  });
}

function disposeCanvasIpc({ ipcMain } = {}) {
  if (ipcMain && typeof ipcMain.removeHandler === "function") {
    try { ipcMain.removeHandler("canvas:command"); } catch { /* ignore */ }
  }
}

module.exports = {
  createCanvasBundle, registerCanvasIpc, disposeCanvasIpc, RENDERER_COMMANDS, CANVAS_COMMAND_NOT_ALLOWED, HOST_APP_ID,
  // 面板参数边界归一（单测直接核对；与画布页 CAMERAS 表做漂移核对）
  CAMERA_PARTS, STYLE_TEXT_MAX, sanitizeStyle, sanitizeCamera, imagePanelOptions,
};
