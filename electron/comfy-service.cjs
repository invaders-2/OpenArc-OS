"use strict";
/**
 * B7e1 · ComfyUI 域装配 + comfy:command 分发（唯一执行入口）。
 *
 * 机制（任务书 item 1 / 2）：
 *   · ComfyUI 是**可选插件、默认关闭**：<userData>/dxos/comfy.json 的 enabled 缺省 false；
 *   · 依赖探测只读本机文件系统（ComfyUI Python 与安装路径），不联网、不下载；
 *   · 未启用 → INTEGRATION_UNAVAILABLE；已启用但缺 Python / main.py → COMFY_DEPENDENCY_UNAVAILABLE，
 *     detail 给出 missing + install（"缺什么 / 怎么装"），**绝不假运行**；
 *   · 所有重活（启动实例 / 停止实例 / 提交运行）都走受监督子进程：
 *     dxos-foundation-runner.cjs（超时 / 取消 / 输出上限）+ comfy-worker.cjs（唯一 worker 入口）；
 *     主进程只编排（写 spec、跟踪 handle、回推 P1 事件），绝不自己 spawn / fetch ComfyUI；
 *   · 工作流解析 / 参数校验 / 节点映射全部复用 comfy-workflow.cjs 的纯函数。
 *
 * 边界：
 *   · 渲染层自报的 userId / role / appId / sessionRef 一律忽略；sessionRef 由 bootstrap 从可信身份注入；
 *   · 返回值统一过 comfy-domain.cjs 的 redactComfyValue —— 绝对路径变成 <path>，凭据字段掩码；
 *   · 云发布 / 云更新 / api.dx-os.com / 云端实时房间一律 OUT（任务书硬约束）：这里没有云同步、
 *     没有远端更新、没有实时房间；实例模式只保留 local / lan / remote。
 *
 * 与源（comfyWorkflows.ts resolveRunInstance:606-652）的差异：源会用 /system_stats 与 /queue
 * 探测多实例并做负载选路；本移植的实例选择是**纯本地配置**（首个启用实例），不做网络探测 ——
 * 离线环境下不能把"探测不到"包装成"没有实例"。
 */

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { createSupervisedRunner } = require("./dxos-foundation-runner.cjs");
const { createEventChannel } = require("./dxos-foundation-events.cjs");
const comfyDomain = require("./comfy-domain.cjs");
const workflow = require("./comfy-workflow.cjs");
const comfyBridge = require("./comfy-bridge.cjs");
const { createComfyStore } = require("./comfy-store.cjs");

const HOST_APP_ID = "ai";
const RESULT_PREFIX = "OPENARC_COMFY_RESULT ";
const PROGRESS_PREFIX = "OPENARC_COMFY_PROGRESS ";
/** worker 自持 deadline 提前 runner 1s；这里再留 5s，保证结构化结果先于 runner 兜底。 */
const RUNNER_MARGIN_MS = 5000;
const DEFAULT_INSTANCE_TIMEOUT_MS = 120000;
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_SPEC_BYTES = 64 * 1024 * 1024;
const MAX_RUN_FILES = 32;
const MAX_FILE_BYTES = 32 * 1024 * 1024;

const INSTALL_PYTHON = "安装 Python 3.10+（python.org，或 macOS 用 brew install python@3.12），再安装 ComfyUI：git clone https://github.com/comfyanonymous/ComfyUI 后执行 pip install -r requirements.txt；也可下载官方 ComfyUI Portable。装好后在 comfy/instances/save 里填写 pythonPath。";
const INSTALL_COMFY = "把 ComfyUI 放到本机任意目录（含 main.py），在 comfy/instances/save 里填写 rootDir 与 mainPath；rootDir 里若存在 ComfyUI/main.py 或 main.py 会被自动解析。";
const INSTALL_ROOT = "可选：填写 ComfyUI 根目录（rootDir），便于自动解析 pythonPath 与 mainPath。";

const {
  COMFY_ERR_INVALID_INPUT,
  COMFY_ERR_UNAUTHENTICATED,
  COMFY_ERR_NOT_FOUND,
  COMFY_ERR_CONFLICT,
  COMFY_ERR_DEPENDENCY_UNAVAILABLE,
  COMFY_ERR_INTEGRATION_UNAVAILABLE,
  COMFY_ERR_TIMEOUT,
  COMFY_ERR_CANCELLED,
  COMFY_ERR_CHILD_FAILED,
  COMFY_ERR_FORBIDDEN,
  COMFY_ERR_INTERNAL,
  isComfyCommand,
  comfyCommandNotAllowed,
  createComfyError,
  normalizeComfyError,
  redactComfyValue,
  listComfyCommands,
  COMFY_EVENT_CHANNEL,
  COMFY_EVENT_DOMAIN,
} = comfyDomain;

const asStr = (value, max = 512) => (typeof value === "string" ? value.slice(0, max) : value == null ? undefined : String(value).slice(0, max));
const requireStr = (value, max = 512) => { const text = asStr(value, max); return text && text.length ? text : null; };
const boundedTimeout = (value, fallback, max) => (Number.isFinite(value) ? Math.max(1, Math.min(max, Math.round(value))) : fallback);

function createComfyBundle(options = {}) {
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const logger = typeof options.logger === "function" ? options.logger : null;
  const userDataDir = options.userDataDir ? String(options.userDataDir) : null;
  const runner = options.runner && typeof options.runner.start === "function" ? options.runner : createSupervisedRunner({ clock: clock });
  const workerEntry = options.workerEntry || path.join(__dirname, "comfy-worker.cjs");
  const store = options.store || createComfyStore({
    userDataDir: userDataDir,
    clock: clock,
    env: options.env,
    bundledWorkflows: options.bundledWorkflows,
  });
  const bundledWorkflowsDir = options.bundledWorkflowsDir ? String(options.bundledWorkflowsDir) : null;
  const instanceTimeoutMs = Number.isFinite(options.instanceTimeoutMs) ? options.instanceTimeoutMs : DEFAULT_INSTANCE_TIMEOUT_MS;
  const runTimeoutMs = Number.isFinite(options.runTimeoutMs) ? options.runTimeoutMs : DEFAULT_RUN_TIMEOUT_MS;
  /** 额外随包目录：缺省用 comfy-workflow.cjs 内嵌的三份；目录存在时增量合并。 */
  const extraBundled = bundledWorkflowsDir ? workflow.loadBundledWorkflows(bundledWorkflowsDir) : [];

  // ---- 事件（P1 信封；bootstrap 的 send 经 setEventSink 注入） ----
  const channel = createEventChannel({ domain: COMFY_EVENT_DOMAIN, clock: clock });
  let eventSink = null;
  function setEventSink(fn) { eventSink = typeof fn === "function" ? fn : null; return true; }
  function emit(kind, payload) {
    const event = channel.emit(kind, payload);
    if (eventSink) { try { eventSink(event); } catch { /* 事件推送失败不改变业务结果 */ } }
    return event;
  }

  /** 在途运行：runId → { handle }。取消 / 关应用只动这里记录的受监督句柄。 */
  const activeRuns = new Map();

  // -------------------------------------------------------------------------
  // 依赖探测（只读文件系统；无网络）
  // -------------------------------------------------------------------------
  function dependencyReport() {
    const config = store.getConfig();
    const rootDir = config.rootDir || "";
    const pythonPath = config.pythonPath || "";
    const mainPath = config.mainPath || "";
    const pythonExists = !!pythonPath && fs.existsSync(pythonPath);
    const mainExists = !!mainPath && fs.existsSync(mainPath);
    const rootExists = !!rootDir && fs.existsSync(rootDir);
    const dependencies = [
      { id: "comfy.python", kind: "python", label: "ComfyUI Python 运行时", required: true, status: pythonExists ? "ok" : "missing", detail: pythonExists ? pythonPath : "未找到 ComfyUI 使用的 Python 解释器（pythonPath 为空或不存在）", install: INSTALL_PYTHON },
      { id: "comfy.install", kind: "binary", label: "ComfyUI 安装路径（main.py）", required: true, status: mainExists ? "ok" : "missing", detail: mainExists ? mainPath : "未找到 ComfyUI main.py（mainPath 为空或不存在）", install: INSTALL_COMFY },
      { id: "comfy.root", kind: "binary", label: "ComfyUI 根目录", required: false, status: rootExists ? "ok" : "missing", detail: rootDir || "未配置 rootDir", install: INSTALL_ROOT },
    ];
    const missingItems = dependencies.filter((item) => item.required && item.status !== "ok");
    const missing = missingItems.map((item) => item.label);
    const missingIds = missingItems.map((item) => item.id);
    const install = [INSTALL_PYTHON, INSTALL_COMFY].filter((_, index) => (index === 0 ? !pythonExists : !mainExists));
    return {
      dependencies: dependencies,
      missing: missing,
      missingIds: missingIds,
      install: install.join(" "),
      pythonPath: pythonExists ? pythonPath : null,
      mainPath: mainExists ? mainPath : null,
      rootDir: rootDir || null,
      bundled: { embedded: workflow.bundledComfyWorkflows().length, extraDirectory: extraBundled.length },
    };
  }

  function assertEnabled() {
    const plugin = store.getPluginState();
    if (plugin.enabled !== true) {
      throw createComfyError(COMFY_ERR_INTEGRATION_UNAVAILABLE, "ComfyUI 为可选插件，默认关闭；请先 comfy/plugin/enable", {
        install: "先在「ComfyUI · 插件」里启用（comfy/plugin/enable），再登记本机安装路径与实例。",
      });
    }
    return plugin;
  }

  function assertAvailable() {
    const plugin = assertEnabled();
    const report = dependencyReport();
    if (report.missing.length) {
      throw createComfyError(COMFY_ERR_DEPENDENCY_UNAVAILABLE, "ComfyUI 依赖缺失：" + report.missing.join("、"), {
        dependency: report.missingIds[0] || report.missing[0],
        missing: report.missing,
        missingIds: report.missingIds,
        install: report.install,
      });
    }
    return { plugin: plugin, report: report };
  }

  // -------------------------------------------------------------------------
  // 受监督子进程编排
  // -------------------------------------------------------------------------
  function ensureTmpDir() {
    if (!store.paths || !store.paths.workflowsDir) {
      throw createComfyError(COMFY_ERR_DEPENDENCY_UNAVAILABLE, "ComfyUI 运行目录未装配（缺少 userDataDir）", { dependency: "comfyDir", install: "以真实应用启动（main.cjs 会注入 userDataDir）后重试。" });
    }
    const dir = path.join(store.paths.workflowsDir, "tmp");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * 把桥接扩展写到实例真正启动的 main.py 旁边（源 comfyui.ts:241 / :602 的同一动作）。
   * 安装失败不阻断启动（例如安装目录只读），但要把失败事实如实回给调用方，不静默吞掉。
   */
  function installBridge(config) {
    if (!config || !config.mainPath) return { installed: false, changed: false, reason: "尚未配置 mainPath" };
    try {
      const result = comfyBridge.installComfyBridgeForMainPath(config.mainPath);
      return { installed: true, changed: result.changed, initChanged: result.initChanged, scriptChanged: result.scriptChanged };
    } catch (error) {
      return { installed: false, changed: false, reason: String((error && error.message) || error).slice(0, 200) };
    }
  }

  function writeSpecFile(spec) {
    const dir = ensureTmpDir();
    const text = JSON.stringify(spec);
    if (Buffer.byteLength(text, "utf8") > MAX_SPEC_BYTES) {
      throw createComfyError(COMFY_ERR_INVALID_INPUT, "ComfyUI spec 超过大小上限（" + MAX_SPEC_BYTES + " 字节）");
    }
    const file = path.join(dir, randomUUID() + ".json");
    fs.writeFileSync(file, text, { mode: 0o600 });
    return file;
  }

  /** worker 的显式 env：executor-launcher 只注入这里给的键，PATH/HOME 需显式带上（python 子进程用）。 */
  function workerEnv() {
    return {
      PATH: String(process.env.PATH || ""),
      HOME: String(process.env.HOME || ""),
      TMPDIR: String(process.env.TMPDIR || ""),
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    };
  }

  /** 启动一次 worker，返回 { handle, result }；result 解析 stdout 里的结构化结果行。 */
  function startWorker(op, spec, opts = {}) {
    const timeoutMs = boundedTimeout(opts.timeoutMs, instanceTimeoutMs, 60 * 60 * 1000);
    let specPath = "";
    try { specPath = writeSpecFile(spec === undefined ? {} : spec); }
    catch (error) { return { handle: null, result: Promise.resolve({ runner: null, envelope: normalizeComfyError(error) }) }; }
    let envelope = null;
    let buffer = "";
    const onEvent = (event) => {
      if (!event || event.type !== "stdout" || !event.text) return;
      buffer += event.text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith(RESULT_PREFIX)) {
          try { envelope = JSON.parse(line.slice(RESULT_PREFIX.length)); } catch { envelope = null; }
        } else if (line.startsWith(PROGRESS_PREFIX)) {
          try {
            const progress = JSON.parse(line.slice(PROGRESS_PREFIX.length));
            if (typeof opts.onProgress === "function") opts.onProgress(progress);
          } catch { /* 单条进度行损坏不影响运行结果 */ }
        }
      }
    };
    let handle = null;
    try {
      handle = runner.start({
        entry: workerEntry,
        args: [op, specPath],
        env: workerEnv(),
        timeoutMs: timeoutMs + RUNNER_MARGIN_MS,
        maxStdoutBytes: 16 * 1024 * 1024,
        onEvent: onEvent,
      });
    } catch (error) {
      try { fs.rmSync(specPath, { force: true }); } catch { /* 清理失败不改变结果 */ }
      return { handle: null, result: Promise.resolve({ runner: null, envelope: { ok: false, error: COMFY_ERR_CHILD_FAILED, message: "无法启动 ComfyUI 子进程：" + String((error && error.message) || error) } }) };
    }
    if (typeof opts.onHandle === "function") opts.onHandle(handle);
    const result = handle.result.then((runnerResult) => {
      try { fs.rmSync(specPath, { force: true }); } catch { /* 忽略 */ }
      if (envelope) return { runner: runnerResult, envelope: envelope };
      if (runnerResult && runnerResult.timedOut) return { runner: runnerResult, envelope: { ok: false, error: COMFY_ERR_TIMEOUT, message: "ComfyUI 子进程超时（" + timeoutMs + "ms）" } };
      if (runnerResult && runnerResult.cancelled) return { runner: runnerResult, envelope: { ok: false, error: COMFY_ERR_CANCELLED, message: "ComfyUI 子进程已取消" } };
      return { runner: runnerResult, envelope: { ok: false, error: COMFY_ERR_CHILD_FAILED, message: "ComfyUI 子进程未返回结构化结果（exit " + (runnerResult ? runnerResult.code : "?") + "）" } };
    });
    return { handle: handle, result: result };
  }

  /** 调用 worker 并等待；失败一律 throw 领域错误（绝不吞掉）。 */
  async function runWorker(op, spec, opts = {}) {
    const outcome = await startWorker(op, spec, opts).result;
    const envelope = outcome.envelope;
    if (!envelope || envelope.ok !== true) {
      const code = envelope && typeof envelope.error === "string" ? envelope.error : COMFY_ERR_CHILD_FAILED;
      const detail = envelope && envelope.dependency ? { dependency: envelope.dependency } : undefined;
      throw createComfyError(code, (envelope && envelope.message) || "ComfyUI 子进程失败", detail);
    }
    return envelope.result;
  }

  // -------------------------------------------------------------------------
  // 工作流辅助
  // -------------------------------------------------------------------------
  function presetSummary(preset) {
    return {
      id: preset.id,
      name: preset.name,
      description: preset.description,
      instanceId: preset.instanceId,
      createdAt: preset.createdAt,
      updatedAt: preset.updatedAt,
      builtin: preset.builtin === true,
      recommended: preset.recommended === true,
      capabilities: preset.capabilities || [],
      aliases: preset.aliases || [],
      agentSummary: preset.agentSummary || "",
      fieldCount: (preset.fields || []).length,
      outputCount: (preset.outputs || []).length,
      agent: workflow.comfyWorkflowAgentManifest(preset),
    };
  }

  function publicRun(run) {
    return {
      id: run.id,
      presetId: run.presetId,
      instanceId: run.instanceId,
      status: run.status,
      progress: run.progress,
      promptId: run.promptId || "",
      error: run.error || "",
      results: run.results || [],
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      startedAt: run.startedAt || null,
      completedAt: run.completedAt || null,
    };
  }

  function resolveInstanceFor(preset, instanceIdValue) {
    const config = store.getConfig();
    const wanted = requireStr(instanceIdValue, 80) || preset.instanceId || workflow.AUTO_INSTANCE_ID;
    let instance = null;
    if (wanted === workflow.AUTO_INSTANCE_ID) {
      instance = config.instances.find((item) => item.enabled) || null;
      if (!instance) throw createComfyError(COMFY_ERR_NOT_FOUND, "没有启用的 ComfyUI 实例；请先在 comfy/instances/save 登记并启用");
    } else {
      instance = config.instances.find((item) => item.id === wanted) || null;
      if (!instance) throw createComfyError(COMFY_ERR_NOT_FOUND, "ComfyUI 实例不存在：" + wanted);
    }
    return { instance: instance, baseUrl: workflow.comfyInstanceBaseUrl(config, instance) };
  }

  /** 把渲染层给的 base64 素材解码成 uploads；只保留声明过的 fieldId。 */
  function collectFiles(preset, body) {
    const raw = Array.isArray(body.files) ? body.files.slice(0, MAX_RUN_FILES) : [];
    const files = {};
    const buffers = {};
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const fieldId = requireStr(entry.fieldId, 80);
      if (!fieldId) continue;
      const field = (preset.fields || []).find((item) => item.id === fieldId);
      if (!field) throw createComfyError(COMFY_ERR_INVALID_INPUT, "素材指向不存在的字段：" + fieldId);
      const base64 = typeof entry.base64 === "string" ? entry.base64 : "";
      const bytes = base64 ? Buffer.from(base64, "base64") : Buffer.alloc(0);
      if (!bytes.length) throw createComfyError(COMFY_ERR_INVALID_INPUT, "素材为空：" + (asStr(entry.name, 120) || field.label));
      if (bytes.length > MAX_FILE_BYTES) throw createComfyError(COMFY_ERR_INVALID_INPUT, "单个素材超过 " + MAX_FILE_BYTES + " 字节上限");
      buffers[fieldId] = bytes;
      files[fieldId] = { name: asStr(entry.name, 200) || "upload.bin", mime: asStr(entry.mime, 120) || "application/octet-stream" };
    }
    return { files: files, buffers: buffers };
  }

  // -------------------------------------------------------------------------
  // 运行提交 / 收尾
  // -------------------------------------------------------------------------
  function onRunProgress(run, progress) {
    const patch = {};
    const phase = progress && typeof progress.phase === "string" ? progress.phase : "";
    if (phase === "uploading") patch.status = "uploading";
    else if (phase === "submitting" || phase === "submitted" || phase === "polling") patch.status = "running";
    if (progress && progress.promptId && !run.promptId) patch.promptId = asStr(progress.promptId, 200) || "";
    if (Number.isFinite(progress && progress.percent)) patch.progress = Math.max(run.progress || 0, Math.min(99, Math.round(progress.percent)));
    else if (phase === "submitted") patch.progress = Math.max(run.progress || 0, 20);
    else if (phase === "polling") patch.progress = Math.max(run.progress || 0, Math.min(90, (run.progress || 0) + 1));
    if (Object.keys(patch).length) store.updateRun(run, patch);
    emit("progress", { command: "comfy/run/start", phase: phase || "progress", runId: run.id, progress: store.getRun(run.id) ? run.progress : null, promptId: run.promptId || null });
  }

  function finalizeRun(run, runnerResult, envelope) {
    let patch = null;
    if (envelope && envelope.ok === true) {
      const result = envelope.result || {};
      patch = { status: "completed", progress: 100, results: Array.isArray(result.results) ? result.results : [], promptId: result.promptId || run.promptId || "", completedAt: clock() };
    } else if (runnerResult && runnerResult.cancelled) {
      patch = { status: "cancelled", error: "已取消" };
    } else if (runnerResult && runnerResult.timedOut) {
      patch = { status: "failed", error: "ComfyUI 运行超时" };
    } else {
      patch = { status: "failed", error: (envelope && envelope.message) || "ComfyUI 运行失败" };
    }
    store.updateRun(run, patch);
    activeRuns.delete(run.id);
    emit("progress", { command: "comfy/run/start", phase: patch.status, runId: run.id, error: patch.error || null, count: patch.results ? patch.results.length : 0 });
    return patch;
  }

  async function startRun(body, context) {
    assertAvailable();
    const presetId = requireStr(body.presetId, 80) || requireStr(body.id, 80);
    if (!presetId) throw createComfyError(COMFY_ERR_INVALID_INPUT, "presetId 必填");
    const preset = store.getPreset(presetId);
    if (!preset) throw createComfyError(COMFY_ERR_NOT_FOUND, "API 工作流不存在");
    const resolved = resolveInstanceFor(preset, body.instanceId);
    const collected = collectFiles(preset, body);
    const prepared = workflow.prepareComfyRun(preset, body.values, collected.files);
    const timeoutMs = boundedTimeout(body.timeoutMs, runTimeoutMs, 60 * 60 * 1000);
    const now = clock();
    const run = {
      id: randomUUID(), ownerId: context.userId, presetId: preset.id, instanceId: resolved.instance.id,
      status: "queued", progress: 0, promptId: "", error: "", results: [], createdAt: now, updatedAt: now,
    };
    store.addRun(run);
    emit("progress", { command: "comfy/run/start", phase: "queued", runId: run.id, presetId: preset.id, instanceId: resolved.instance.id });
    const spec = {
      baseUrl: resolved.baseUrl,
      runId: run.id,
      prompt: prepared.prompt,
      outputs: preset.outputs || [],
      uploads: prepared.uploads.map((upload) => ({ ...upload, base64: collected.buffers[upload.fieldId] ? collected.buffers[upload.fieldId].toString("base64") : "" })),
      timeoutMs: timeoutMs,
    };
    const started = startWorker("run", spec, { timeoutMs: timeoutMs, onProgress: (progress) => onRunProgress(run, progress) });
    activeRuns.set(run.id, { handle: started.handle, runId: run.id });
    started.result.then((outcome) => finalizeRun(run, outcome.runner, outcome.envelope)).catch((error) => {
      store.updateRun(run, { status: "failed", error: String((error && error.message) || error) });
      activeRuns.delete(run.id);
    });
    return { run: publicRun(store.getRun(run.id) || run) };
  }

  // -------------------------------------------------------------------------
  // 分发
  // -------------------------------------------------------------------------
  async function dispatch(command, body, context) {
    switch (command) {
      case "comfy/health": {
        const plugin = store.getPluginState();
        const report = dependencyReport();
        return {
          enabled: plugin.enabled,
          dependencies: report.dependencies,
          missing: report.missing,
          install: report.install,
          workflows: store.listPresets().length,
          runs: store.runStats(),
          commands: listComfyCommands().length,
          eventChannel: COMFY_EVENT_CHANNEL,
          workerEntryPresent: !!workerEntry,
          runnerPresent: typeof runner.start === "function",
          eventSinkPresent: !!eventSink,
        };
      }

      case "comfy/plugin/get": return { plugin: store.getPluginState() };
      case "comfy/plugin/enable": {
        const plugin = store.setPluginEnabled(true);
        return { plugin: plugin, dependencies: dependencyReport().dependencies };
      }
      case "comfy/plugin/disable": return { plugin: store.setPluginEnabled(false) };

      case "comfy/dependencies/probe": return dependencyReport();

      case "comfy/bridge/install": {
        const config = store.getConfig();
        if (!config.mainPath) throw createComfyError(COMFY_ERR_DEPENDENCY_UNAVAILABLE, "尚未配置 ComfyUI mainPath，无法安装桥接扩展", { dependency: "comfy.install", install: INSTALL_COMFY });
        const result = comfyBridge.installComfyBridgeForMainPath(config.mainPath);
        return { path: result.path, changed: result.changed, initChanged: result.initChanged, scriptChanged: result.scriptChanged };
      }

      case "comfy/bridge/archive": {
        const zip = comfyBridge.comfyBridgeArchive();
        return {
          fileName: "dx-os-comfy-bridge.zip",
          bytes: zip.length,
          base64: zip.toString("base64"),
          instructions: "解压后把 dx_os_bridge 整个文件夹复制到 ComfyUI/custom_nodes/，再完全重启 ComfyUI（只刷新网页无效）。",
        };
      }

      case "comfy/instances/list": return { instances: store.getConfig().instances };

      case "comfy/instances/save": {
        const input = body.instance && typeof body.instance === "object" ? body.instance : body;
        // 兼容 instanceId 与源字段名 id：两者都指向同一个实例主键。
        const instance = store.upsertInstance({ ...input, id: input.id || input.instanceId });
        // 源 comfyui.ts:241：保存配置时顺手把桥接扩展写到 main.py 旁边（写失败只回报，不改变保存结果）。
        return { instance: instance, bridge: installBridge(store.getConfig()) };
      }

      case "comfy/instances/delete": {
        const id = requireStr(body.instanceId, 80) || requireStr(body.id, 80);
        if (!id) throw createComfyError(COMFY_ERR_INVALID_INPUT, "instanceId 必填");
        return store.deleteInstance(id);
      }

      case "comfy/instances/start": {
        assertAvailable();
        const id = requireStr(body.instanceId, 80) || requireStr(body.id, 80);
        if (!id) throw createComfyError(COMFY_ERR_INVALID_INPUT, "instanceId 必填");
        const config = store.getConfig();
        const instance = config.instances.find((item) => item.id === id);
        if (!instance) throw createComfyError(COMFY_ERR_NOT_FOUND, "ComfyUI 实例不存在");
        if (instance.mode !== "local") throw createComfyError(COMFY_ERR_FORBIDDEN, "只有本机实例由本应用启动；局域网 / 云端实例请在对应主机启动");
        if (!store.paths) throw createComfyError(COMFY_ERR_DEPENDENCY_UNAVAILABLE, "ComfyUI 运行目录未装配", { dependency: "comfyDir" });
        const timeoutMs = boundedTimeout(body.timeoutMs, instanceTimeoutMs, 60 * 60 * 1000);
        // 源 comfyui.ts:602：本机实例启动前安装桥接扩展。
        const bridge = installBridge(config);
        const runtime = await runWorker("instance-start", {
          instanceId: instance.id, pythonPath: config.pythonPath, mainPath: config.mainPath, rootDir: config.rootDir,
          listen: config.listen, port: instance.port, gpu: instance.gpu, outputDir: instance.outputDir || config.outputDir,
          extraArgs: instance.extraArgs || config.extraArgs, stateDir: store.paths.instancesDir, timeoutMs: timeoutMs,
        }, { timeoutMs: timeoutMs });
        return { instance: instance, runtime: runtime, bridge: bridge };
      }

      case "comfy/instances/stop": {
        assertEnabled();
        const id = requireStr(body.instanceId, 80) || requireStr(body.id, 80);
        if (!id) throw createComfyError(COMFY_ERR_INVALID_INPUT, "instanceId 必填");
        const instance = store.getInstance(id);
        if (!instance) throw createComfyError(COMFY_ERR_NOT_FOUND, "ComfyUI 实例不存在");
        if (!store.paths) throw createComfyError(COMFY_ERR_DEPENDENCY_UNAVAILABLE, "ComfyUI 运行目录未装配", { dependency: "comfyDir" });
        const timeoutMs = boundedTimeout(body.timeoutMs, 30000, 600000);
        const result = await runWorker("instance-stop", {
          instanceId: instance.id, port: instance.port, stateDir: store.paths.instancesDir, timeoutMs: timeoutMs,
        }, { timeoutMs: timeoutMs });
        return { instance: instance, runtime: result };
      }

      case "comfy/workflows/list": return { items: store.listPresets().map(presetSummary) };
      case "comfy/workflows/get": {
        const id = requireStr(body.id, 80) || requireStr(body.presetId, 80);
        if (!id) throw createComfyError(COMFY_ERR_INVALID_INPUT, "工作流 id 必填");
        const preset = store.getPreset(id);
        if (!preset) throw createComfyError(COMFY_ERR_NOT_FOUND, "API 工作流不存在");
        return { workflow: preset, agent: workflow.comfyWorkflowAgentManifest(preset) };
      }

      case "comfy/workflows/parse": {
        let value = body.workflow;
        if (value == null && typeof body.json === "string") {
          try { value = JSON.parse(body.json); } catch { throw createComfyError(COMFY_ERR_INVALID_INPUT, "工作流 JSON 解析失败"); }
        }
        return workflow.inspectComfyWorkflow(value);
      }

      case "comfy/workflows/import":
      case "comfy/workflows/save": {
        let graph = body.workflow;
        if (graph == null && typeof body.json === "string") {
          try { graph = JSON.parse(body.json); } catch { throw createComfyError(COMFY_ERR_INVALID_INPUT, "工作流 JSON 解析失败"); }
        }
        if (graph == null) throw createComfyError(COMFY_ERR_INVALID_INPUT, "缺少 workflow（API 工作流 JSON）");
        const preset = store.savePreset({
          id: body.id || body.presetId,
          name: body.name,
          description: body.description,
          instanceId: body.instanceId,
          workflow: graph,
          fields: body.fields,
          outputs: body.outputs,
          capabilities: body.capabilities,
          aliases: body.aliases,
          agentSummary: body.agentSummary,
        });
        return { workflow: preset, agent: workflow.comfyWorkflowAgentManifest(preset) };
      }

      case "comfy/workflows/delete": {
        const id = requireStr(body.id, 80) || requireStr(body.presetId, 80);
        if (!id) throw createComfyError(COMFY_ERR_INVALID_INPUT, "工作流 id 必填");
        return store.deletePreset(id);
      }

      case "comfy/workflows/agent-manifests": return { manifests: store.listAgentManifests() };

      case "comfy/run/start": return startRun(body, context);

      case "comfy/run/get": {
        const id = requireStr(body.runId, 80) || requireStr(body.id, 80);
        if (!id) throw createComfyError(COMFY_ERR_INVALID_INPUT, "runId 必填");
        const run = store.getRun(id, context.userId);
        if (!run) throw createComfyError(COMFY_ERR_NOT_FOUND, "运行记录不存在");
        return { run: publicRun(run) };
      }

      case "comfy/run/list": {
        const statuses = Array.isArray(body.statuses) ? body.statuses : [];
        return { runs: store.listRuns(context.userId, { statuses: statuses, limit: body.limit }).map(publicRun) };
      }

      case "comfy/run/results": {
        const id = requireStr(body.runId, 80) || requireStr(body.id, 80);
        if (!id) throw createComfyError(COMFY_ERR_INVALID_INPUT, "runId 必填");
        const run = store.getRun(id, context.userId);
        if (!run) throw createComfyError(COMFY_ERR_NOT_FOUND, "运行记录不存在");
        return { runId: run.id, status: run.status, results: run.results || [] };
      }

      case "comfy/run/cancel": {
        const id = requireStr(body.runId, 80) || requireStr(body.id, 80);
        if (!id) throw createComfyError(COMFY_ERR_INVALID_INPUT, "runId 必填");
        const run = store.getRun(id, context.userId);
        if (!run) throw createComfyError(COMFY_ERR_NOT_FOUND, "运行记录不存在");
        const active = activeRuns.get(id);
        let cancelled = false;
        if (active && active.handle && typeof active.handle.cancel === "function") cancelled = active.handle.cancel("COMFY_CANCELLED") === true;
        store.updateRun(run, { status: "cancelled", error: "用户取消" });
        activeRuns.delete(id);
        emit("progress", { command: "comfy/run/cancel", phase: "cancelled", runId: id, cancelled: cancelled });
        return { run: publicRun(run), cancelled: cancelled };
      }

      default: throw comfyCommandNotAllowed(command);
    }
  }

  /**
   * 唯一执行入口：白名单 → 认证 → dispatch → 脱敏；失败统一 normalizeComfyError。
   * 每次执行前后各发一条 progress 事件（P1 信封），供渲染层显示与丢帧判定。
   */
  async function execute(command, payload, ctx = {}) {
    if (!isComfyCommand(command)) return normalizeComfyError(comfyCommandNotAllowed(command));
    const context = {
      sessionRef: requireStr(ctx && ctx.sessionRef, 160) || null,
      appId: requireStr(ctx && ctx.appId, 60) || HOST_APP_ID,
      source: "comfy",
      requestId: requireStr(ctx && ctx.requestId, 100) || null,
    };
    emit("progress", { command: command, phase: "begin", requestId: context.requestId });
    if (!context.sessionRef) {
      emit("progress", { command: command, phase: "rejected", reason: "unauthenticated", requestId: context.requestId });
      return normalizeComfyError(createComfyError(COMFY_ERR_UNAUTHENTICATED, "当前会话未认证，comfy 命令被拒绝"));
    }
    context.userId = String(context.sessionRef);
    const body = payload && typeof payload === "object" ? payload : {};
    try {
      const value = await dispatch(command, body, context);
      emit("progress", { command: command, phase: "completed", requestId: context.requestId });
      return { ok: true, value: redactComfyValue(value) };
    } catch (error) {
      emit("progress", { command: command, phase: "failed", requestId: context.requestId });
      return normalizeComfyError(error);
    }
  }

  /** 应用退出：取消在途 worker（绝不伪造完成状态）。 */
  function dispose() {
    let cancelled = 0;
    if (runner && typeof runner.cancelAll === "function") { try { cancelled = runner.cancelAll("COMFY_SHUTDOWN"); } catch { /* 已停 */ } }
    for (const [, active] of activeRuns) {
      const run = store.getRun(active.runId);
      if (run && (run.status === "queued" || run.status === "uploading" || run.status === "running")) store.updateRun(run, { status: "cancelled", error: "应用退出" });
    }
    activeRuns.clear();
    return { cancelled: cancelled };
  }

  const dependencies = Object.freeze({
    userDataDir: !!userDataDir,
    store: !!store,
    runner: typeof runner.start === "function",
    workerEntry: !!workerEntry,
  });

  return {
    execute: execute,
    setEventSink: setEventSink,
    installBridge: installBridge,
    emitEvent: emit,
    dispose: dispose,
    store: store,
    paths: store.paths,
    dependencies: dependencies,
    probeDependencies: dependencyReport,
    isComfyCommand: isComfyCommand,
    commands: listComfyCommands(),
    runWorker: runWorker,
    startWorker: startWorker,
    publicRun: publicRun,
    activeRunCount: () => activeRuns.size,
  };
}

module.exports = { createComfyBundle, HOST_APP_ID, DEFAULT_INSTANCE_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS };
