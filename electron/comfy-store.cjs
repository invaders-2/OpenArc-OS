"use strict";
/**
 * B7e1 · ComfyUI 存储层：配置 / 插件开关 / 工作流定义 / 运行记录的唯一落盘点。
 *
 * ## 来源（只读参照 DX OS 0.5.1 app.asar.unpacked/server）
 *   · comfyui.ts:86-104        defaultConfig / ensureDataDir
 *   · comfyui.ts:215-243       loadComfyConfig / saveComfyConfig（含 lan / remote 地址校验）
 *   · comfyWorkflows.ts:144-171  随包工作流注入（旧 ID 一次性迁移）
 *   · comfyWorkflows.ts:211-242  运行记录读取 + 原子落盘（temp + rename，上限 500）
 *   · comfyWorkflows.ts:272-327  ensureDataDir / readStoreFile / legacyStorePaths / readStore / writeStore
 *   · comfyWorkflows.ts:516-597  saveComfyWorkflow / deleteComfyWorkflow（内置不可删）
 *
 * ## 与源不同的点（有意为之）
 *   · 源用 dataPaths 的固定目录 + comfyWorkflows.ts 的 4 个 JSON 文件；本移植统一落到
 *     <userData>/dxos/comfy.json 与 <userData>/dxos/comfy-workflows/{presets,runs}.json，
 *     路径解析复用 dxos-foundation-paths.cjs，不拼第二套目录。
 *   · 源把 cover / sharp 图片处理揉在一起；本批次不做封面（硬约束：sharp 仅惰性 require，
 *     且任务书未要求封面），因此没有 COVER_DIR / removeCover 分支。
 *   · 运行记录不落 SQLite（与源一致，JSON 足够），但写入仍是原子替换，避免半截文件。
 */

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { resolveDxosPaths, ensureDxosLayout } = require("./dxos-foundation-paths.cjs");
const workflow = require("./comfy-workflow.cjs");
const comfyDomain = require("./comfy-domain.cjs");

const {
  COMFY_ERR_INVALID_INPUT,
  COMFY_ERR_NOT_FOUND,
  COMFY_ERR_CONFLICT,
  createComfyError,
} = comfyDomain;

const STATE_VERSION = 1;
const MAX_RUNS = 500;
const RUN_STATUSES = Object.freeze(["queued", "uploading", "running", "completed", "failed", "cancelled"]);

function readJsonFile(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function createComfyStore(options = {}) {
  const userDataDir = options.userDataDir ? String(options.userDataDir) : null;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const env = options.env && typeof options.env === "object" ? options.env : process.env;
  const injectedBundled = Array.isArray(options.bundledWorkflows) ? options.bundledWorkflows : null;
  const paths = userDataDir ? resolveDxosPaths(userDataDir) : null;
  const root = paths ? paths.root : null;
  const configPath = root ? path.join(root, "comfy.json") : null;
  const workflowsDir = paths ? paths.directory["comfy-workflows"] : null;
  const presetsPath = workflowsDir ? path.join(workflowsDir, "presets.json") : null;
  const runsPath = workflowsDir ? path.join(workflowsDir, "runs.json") : null;
  const instancesDir = workflowsDir ? path.join(workflowsDir, "instances") : null;

  // 运行记录是进程内热态 + 落盘冷态；读一次后保持内存，写时截断到最近 500 条。
  const runs = new Map();
  let runsLoaded = false;

  function ensureLayout() {
    if (!userDataDir || !root || !workflowsDir) throw createComfyError(COMFY_ERR_INVALID_INPUT, "ComfyUI 存储未装配（缺少 userDataDir）");
    ensureDxosLayout(userDataDir);
    fs.mkdirSync(workflowsDir, { recursive: true });
  }

  /** 原子写：先写临时文件再 rename，绝不留下半截 JSON（源 comfyWorkflows.ts:316-327 同形）。 */
  function atomicWrite(file, value) {
    ensureLayout();
    const tempPath = file + "." + process.pid + "." + randomUUID() + ".tmp";
    try {
      fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
      fs.renameSync(tempPath, file);
    } finally {
      try { fs.rmSync(tempPath, { force: true }); } catch { /* 临时文件清理失败不改变写入结果 */ }
    }
  }

  // ---- 配置 / 插件开关 ----

  function defaultState() {
    return { version: STATE_VERSION, enabled: false, config: workflow.normalizeComfyConfig({}, { env: env }) };
  }

  function readState() {
    const raw = readJsonFile(configPath);
    if (!raw) return defaultState();
    // 兼容两种历史形状：{config:...} 与源 comfyui.json 的扁平静态配置。
    const sourceConfig = raw.config && typeof raw.config === "object" ? raw.config : raw;
    return { version: STATE_VERSION, enabled: raw.enabled === true, config: workflow.normalizeComfyConfig(sourceConfig, { env: env }) };
  }

  function writeState(state) {
    atomicWrite(configPath, { version: STATE_VERSION, enabled: state.enabled === true, config: state.config });
    return state;
  }

  function getConfig() {
    return readState().config;
  }

  /** 源 comfyui.ts:229-243：lan 必须有效主机名，remote 必须完整 http(s) 地址。 */
  function saveConfig(input) {
    const state = readState();
    const next = workflow.normalizeComfyConfig({ ...state.config, ...(input && typeof input === "object" ? input : {}) }, { env: env });
    for (const instance of next.instances) {
      if (instance.mode === "lan" && !workflow.normalizeComfyLanHost(instance.lanHost)) {
        throw createComfyError(COMFY_ERR_INVALID_INPUT, (instance.name || "局域网 ComfyUI") + "：请填写有效的局域网 IP 或主机名");
      }
      if (instance.mode === "remote" && !workflow.normalizeComfyBaseUrl(instance.baseUrl)) {
        throw createComfyError(COMFY_ERR_INVALID_INPUT, (instance.name || "云端 ComfyUI") + "：请填写完整的 HTTP 或 HTTPS 公网地址");
      }
    }
    writeState({ version: STATE_VERSION, enabled: state.enabled, config: next });
    return next;
  }

  function getPluginState() {
    const state = readState();
    return { enabled: state.enabled === true, version: state.version };
  }

  function setPluginEnabled(enabled) {
    const state = readState();
    writeState({ version: STATE_VERSION, enabled: enabled === true, config: state.config });
    return { enabled: enabled === true };
  }

  function getInstance(instanceId) {
    const id = String(instanceId || "");
    return getConfig().instances.find((item) => item.id === id) || null;
  }

  function upsertInstance(input) {
    const state = readState();
    const instance = workflow.normalizeComfyInstance(input, state.config.instances.length);
    if (instance.mode === "lan" && !workflow.normalizeComfyLanHost(instance.lanHost)) throw createComfyError(COMFY_ERR_INVALID_INPUT, (instance.name || "局域网 ComfyUI") + "：请填写有效的局域网 IP 或主机名");
    if (instance.mode === "remote" && !workflow.normalizeComfyBaseUrl(instance.baseUrl)) throw createComfyError(COMFY_ERR_INVALID_INPUT, (instance.name || "云端 ComfyUI") + "：请填写完整的 HTTP 或 HTTPS 公网地址");
    const instances = state.config.instances.slice();
    const index = instances.findIndex((item) => item.id === instance.id);
    if (index >= 0) instances.splice(index, 1, instance);
    else instances.push(instance);
    const config = workflow.normalizeComfyConfig({ ...state.config, instances: instances }, { env: env });
    writeState({ version: STATE_VERSION, enabled: state.enabled, config: config });
    return config.instances.find((item) => item.id === instance.id);
  }

  function deleteInstance(instanceId) {
    const state = readState();
    const id = String(instanceId || "");
    const next = state.config.instances.filter((item) => item.id !== id);
    if (next.length === state.config.instances.length) throw createComfyError(COMFY_ERR_NOT_FOUND, "ComfyUI 实例不存在");
    writeState({ version: STATE_VERSION, enabled: state.enabled, config: workflow.normalizeComfyConfig({ ...state.config, instances: next }, { env: env }) });
    return { deleted: id };
  }

  // ---- 工作流定义 ----

  function bundledItems() {
    return injectedBundled || workflow.bundledComfyWorkflows();
  }

  function readPresets() {
    ensureLayout();
    const raw = readJsonFile(presetsPath);
    const stored = raw && Array.isArray(raw.items) ? raw.items : [];
    const seeded = workflow.withBundledComfyWorkflows(stored, bundledItems());
    if (JSON.stringify(seeded) !== JSON.stringify(stored)) atomicWrite(presetsPath, { version: STATE_VERSION, items: seeded });
    return seeded;
  }

  function writePresets(items) {
    atomicWrite(presetsPath, { version: STATE_VERSION, items: items.slice(0, 500) });
    return items;
  }

  function listPresets() {
    return readPresets();
  }

  function getPreset(id) {
    const want = String(id || "");
    return readPresets().find((item) => item.id === want) || null;
  }

  /** 源 comfyWorkflows.ts:516-552 的 saveComfyWorkflow（不含封面）。 */
  function savePreset(input) {
    const source = input && typeof input === "object" ? input : {};
    const items = readPresets();
    const existing = source.id ? items.find((item) => item.id === source.id) : undefined;
    const graph = workflow.apiWorkflow(source.workflow || (existing && existing.workflow));
    const now = clock();
    const fields = workflow.safeFields(source.fields != null ? source.fields : existing && existing.fields, graph);
    const outputs = workflow.safeOutputs(source.outputs != null ? source.outputs : existing && existing.outputs, graph);
    const declared = Array.isArray(source.capabilities != null ? source.capabilities : existing && existing.capabilities)
      ? (source.capabilities != null ? source.capabilities : existing.capabilities).filter((value) => workflow.COMFY_CAPABILITIES.has(value))
      : [];
    const preset = {
      id: existing ? existing.id : randomUUID(),
      ownerId: existing ? existing.ownerId : "shared",
      name: String(source.name || (existing && existing.name) || "未命名工作流").trim() || "未命名工作流",
      description: String(source.description || (existing && existing.description) || "").trim(),
      coverUrl: "coverUrl" in source ? String(source.coverUrl || "") : String((existing && existing.coverUrl) || ""),
      instanceId: String(source.instanceId || (existing && existing.instanceId) || "").trim(),
      workflow: graph,
      fields: fields,
      outputs: outputs,
      capabilities: declared.length ? [...new Set(declared)] : workflow.inferComfyWorkflowCapabilities(fields, outputs),
      aliases: [...new Set((source.aliases != null ? source.aliases : (existing && existing.aliases) || []).map((value) => String(value).trim()).filter(Boolean))].slice(0, 20),
      agentSummary: String(source.agentSummary != null ? source.agentSummary : (existing && existing.agentSummary) || source.description || (existing && existing.description) || "").trim().slice(0, 500),
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      builtin: !!(existing && existing.builtin),
      recommended: !!(existing && existing.recommended),
    };
    if (!preset.instanceId) throw createComfyError(COMFY_ERR_INVALID_INPUT, "请选择默认 ComfyUI 实例");
    if (preset.instanceId !== workflow.AUTO_INSTANCE_ID && !getConfig().instances.some((item) => item.id === preset.instanceId)) {
      throw createComfyError(COMFY_ERR_NOT_FOUND, "所选 ComfyUI 实例不存在");
    }
    // 封面上传（sharp）本批次未移植：这里只原样保留既有字符串，不新增封面能力。
    if (existing) items.splice(items.indexOf(existing), 1, preset);
    else items.push(preset);
    writePresets(items);
    return preset;
  }

  /** 源 comfyWorkflows.ts:588-597：内置推荐工作流不可删除。 */
  function deletePreset(id) {
    const want = String(id || "");
    const items = readPresets();
    const deleted = items.find((item) => item.id === want);
    if (deleted && deleted.builtin) throw createComfyError(COMFY_ERR_CONFLICT, "内置推荐工作流不能删除，可以直接编辑映射和参数");
    const next = items.filter((item) => item.id !== want);
    if (next.length === items.length) throw createComfyError(COMFY_ERR_NOT_FOUND, "API 工作流不存在");
    writePresets(next);
    return { deleted: want };
  }

  function listAgentManifests() {
    return readPresets().map(workflow.comfyWorkflowAgentManifest);
  }

  // ---- 运行记录 ----

  function loadRuns() {
    if (runsLoaded) return;
    runsLoaded = true;
    const raw = readJsonFile(runsPath);
    const items = raw && Array.isArray(raw.items) ? raw.items : [];
    for (const run of items) {
      if (run && typeof run.id === "string" && typeof run.presetId === "string" && typeof run.status === "string") runs.set(run.id, run);
    }
  }

  function persistRuns() {
    const retained = [...runs.values()].sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0)).slice(0, MAX_RUNS);
    atomicWrite(runsPath, { version: STATE_VERSION, items: retained });
  }

  function addRun(run) {
    loadRuns();
    runs.set(run.id, run);
    persistRuns();
    return run;
  }

  function updateRun(run, patch) {
    loadRuns();
    Object.assign(run, patch, { updatedAt: clock() });
    runs.set(run.id, run);
    const durable = patch && (patch.status !== undefined || patch.results !== undefined || patch.error !== undefined || patch.promptId !== undefined || patch.instanceId !== undefined);
    if (durable) persistRuns();
    return run;
  }

  function getRun(id, ownerId) {
    loadRuns();
    const run = runs.get(String(id || ""));
    if (!run) return null;
    if (ownerId != null && run.ownerId !== ownerId) return null;
    return run;
  }

  function listRuns(ownerId, options = {}) {
    loadRuns();
    const statuses = Array.isArray(options.statuses) ? options.statuses.filter((item) => RUN_STATUSES.includes(item)) : [];
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(200, Math.floor(options.limit))) : 50;
    return [...runs.values()]
      .filter((run) => (ownerId == null || run.ownerId === ownerId) && (!statuses.length || statuses.includes(run.status)))
      .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
      .slice(0, limit);
  }

  function runStats() {
    loadRuns();
    let active = 0;
    for (const run of runs.values()) if (run.status === "queued" || run.status === "uploading" || run.status === "running") active += 1;
    return { total: runs.size, active: active, completed: runs.size - active };
  }

  return {
    paths: root ? { root: root, configPath: configPath, workflowsDir: workflowsDir, presetsPath: presetsPath, runsPath: runsPath, instancesDir: instancesDir } : null,
    ensureLayout: ensureLayout,
    readState: readState,
    getConfig: getConfig,
    saveConfig: saveConfig,
    getPluginState: getPluginState,
    setPluginEnabled: setPluginEnabled,
    getInstance: getInstance,
    upsertInstance: upsertInstance,
    deleteInstance: deleteInstance,
    listPresets: listPresets,
    getPreset: getPreset,
    savePreset: savePreset,
    deletePreset: deletePreset,
    listAgentManifests: listAgentManifests,
    addRun: addRun,
    updateRun: updateRun,
    getRun: getRun,
    listRuns: listRuns,
    runStats: runStats,
    RUN_STATUSES: RUN_STATUSES,
  };
}

module.exports = { createComfyStore, STATE_VERSION, MAX_RUNS, RUN_STATUSES, readJsonFile };
