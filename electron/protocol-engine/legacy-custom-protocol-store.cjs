"use strict";
/**
 * DX OS 旧版自定义协议仓库（customProtocolStore）移植。
 * 源：DXSRC/protocols.ts
 *   · :2984-2988  CustomProtocolKind / CustomProtocolStore 形状（provider/model 两张扁平表）
 *   · :3009       CUSTOM_PROTOCOL_FILE = process.env.DX_CUSTOM_PROTOCOL_FILE || dataPath('custom-protocols.json')
 *   · :3022-3024  protocolObject（只接受非数组对象）
 *   · :3026-3071  normalizeCustomProtocol（id 规则 / 禁覆盖内置 / label / runtimeProtocol / auth / models / executor）
 *   · :3073-3078  persistCustomProtocols（mkdir + tmp + rename 原子写）
 *   · :3080-3083  installCustomProtocols（写回 PROTOCOLS / PROVIDER_PROTOCOLS）
 *   · :3135-3155  loadCustomProtocols（缺文件跳过；整体损坏忽略；单条损坏忽略）
 *   · :3157-3168  saveCustomProtocol
 *   · :3170-3179  removeCustomProtocol
 *   · :3181       loadCustomProtocols() 于模块初始化时调用
 *
 * 与 dx-protocol/v2（repository.cjs）的边界：
 *   · v2 是带版本 / hash / declarative executor 的仓库（custom-protocols-v2.json + protocol-packages），
 *     由 provider-protocol-service.cjs:633-641 装配，出口为 listProtocolsV2/getProtocolV2/isCustomProtocolV2。
 *   · 本文件移植的是旧版扁平仓库（custom-protocols.json），只存"数据型"协议定义，
 *     安装进 legacy-protocols.cjs 的 PROTOCOLS / PROVIDER_PROTOCOLS，供协议详情列表标注 origin。
 *   两者文件不同、条目形状不同、出口不同：互不读取、互不覆盖，也不互相遮蔽。
 *
 * 本地化改造：
 *   · 源 dataPath('custom-protocols.json') 在本仓展开为 <userData>/dxos/custom-protocols.json
 *     （dxos-foundation-paths.cjs 约定；platform-service.cjs:62 的完整性清单同样登记该文件名）。
 *   · 源 :3181 在模块加载即读盘；本移植改由 legacy-protocols.cjs 的列表 / 详情函数惰性触发，
 *     避免纯数据模块在 import 阶段就去解析仓库路径（见 legacy-protocols.cjs 列表接线处）。
 *   · 源 :3026 的 kind 由 TS 类型约束；.cjs 丢失类型后在此显式校验，保持同样的失败关闭。
 */
const fs = require("node:fs");
const path = require("node:path");
const { resolveDxosPaths } = require("../dxos-foundation-paths.cjs");

const CUSTOM_PROTOCOL_FILE_NAME = "custom-protocols.json";

const state = {
  loaded: false,
  store: { provider: {}, model: {} },
  storeFile: null,
  userDataDir: null,
  installed: { provider: new Set(), model: new Set() },
  lastLoad: null,
};

/** 惰性取 legacy 协议表：避免与 legacy-protocols.cjs 顶层 require 形成循环。 */
function legacyTables() {
  return require("./legacy-protocols.cjs");
}

/** 源 :3009 dataPath('custom-protocols.json') 的本仓落点。 */
function customProtocolStoreFilePath(userDataDir) {
  return path.join(resolveDxosPaths(userDataDir).root, CUSTOM_PROTOCOL_FILE_NAME);
}

function protocolObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** 源 :2984 的 TS 联合类型在 .cjs 里的运行时等价物。 */
function assertKind(kind) {
  if (kind !== "provider" && kind !== "model") throw new Error("自定义协议 kind 只能是 provider 或 model。");
  return kind;
}

/**
 * 解析落盘路径。优先级：显式 storeFile > DX_CUSTOM_PROTOCOL_FILE（源 :3009）> 显式 userDataDir >
 * v2 仓库同目录（生产接线）> 无。
 * v2 仓库文件由 provider-protocol-service.cjs:636-639 定为 <userData>/dxos/custom-protocols-v2.json，
 * 旧版扁平仓库就在同一目录；仓库未配置时返回 null，如实表示"无 store"，不猜路径。
 */
function resolveStoreFile() {
  if (state.storeFile) return state.storeFile;
  const envFile = String(process.env.DX_CUSTOM_PROTOCOL_FILE || "").trim();
  if (envFile) return envFile;
  if (state.userDataDir) return customProtocolStoreFilePath(state.userDataDir);
  try {
    const repository = require("./repository.cjs");
    const dir = typeof repository.protocolRepositoryDataDir === "function" ? repository.protocolRepositoryDataDir() : null;
    if (dir) return path.join(dir, CUSTOM_PROTOCOL_FILE_NAME);
  } catch { /* 仓库不可用时按无 store 处理 */ }
  return null;
}

/** 源 :3026-3071 逐分支移植。 */
function normalizeCustomProtocol(kind, value) {
  assertKind(kind);
  const tables = legacyTables();
  const raw = protocolObject(value);
  const id = String(raw.id || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9:_-]{1,63}$/.test(id)) throw new Error("协议 id 只能使用小写字母、数字、冒号、下划线和短横线，长度 2-64。");
  if (tables.BUILTIN_MODEL_PROTOCOL_IDS.has(id) || tables.BUILTIN_PROVIDER_PROTOCOL_IDS.has(id)) throw new Error(`内置协议「${id}」不能覆盖，请换一个自定义 id。`);
  const label = String(raw.label || "").trim();
  if (!label) throw new Error("缺少协议名称 label。");
  const runtimeProtocol = String(raw.runtimeProtocol || "openai").trim().toLowerCase();
  if (!tables.PROTOCOLS[runtimeProtocol] && !tables.PROVIDER_PROTOCOLS[runtimeProtocol]) throw new Error(`运行协议「${runtimeProtocol}」不存在，请选择已有协议。`);
  const auth = protocolObject(raw.auth);
  const models = protocolObject(raw.models);
  const common = {
    ...raw,
    // 源 :3039-3042：原生 adapter 执行本地代码；旧版 / 自建 JSON 只能引用既有数据型 runtimeProtocol，
    // 不能自带 executor 声明，这里一律清空。
    executor: undefined,
    id,
    label,
    summary: String(raw.summary || `${label} 自定义协议`).trim(),
    runtimeProtocol,
    categories: Array.isArray(raw.categories) ? raw.categories.map(String).filter(Boolean) : [],
    auth: {
      type: ["bearer", "google_api_key", "api_key_header", "none"].includes(String(auth.type || "")) ? auth.type : "bearer",
      ...(auth.header ? { header: String(auth.header) } : {}),
      ...(auth.prefix != null ? { prefix: String(auth.prefix) } : {}),
    },
    models: {
      endpoint: String(models.endpoint || "/v1/models"),
      kind: ["openai", "anthropic", "gemini"].includes(String(models.kind || "")) ? models.kind : "openai",
    },
  };
  if (kind === "provider") return { ...common, kind: "provider-protocol", runtimeProtocol };
  return {
    ...common,
    kind: "model-protocol-package",
    scope: "model",
    capabilities: protocolObject(raw.capabilities),
    operations: protocolObject(raw.operations),
    modelProfiles: protocolObject(raw.modelProfiles),
    uiSchemas: protocolObject(raw.uiSchemas),
    paramSchema: protocolObject(raw.paramSchema),
  };
}

/** 摘除当前安装的自建协议；内置 id 绝不在 `installed` 里（normalizeCustomProtocol 已禁止覆盖）。 */
function uninstallCustomProtocols() {
  const tables = legacyTables();
  if (!tables || !tables.PROTOCOLS || !tables.PROVIDER_PROTOCOLS) return;
  for (const id of state.installed.model) if (!tables.BUILTIN_MODEL_PROTOCOL_IDS.has(id)) delete tables.PROTOCOLS[id];
  for (const id of state.installed.provider) if (!tables.BUILTIN_PROVIDER_PROTOCOL_IDS.has(id)) delete tables.PROVIDER_PROTOCOLS[id];
  state.installed = { provider: new Set(), model: new Set() };
}

/** 源 :3080-3083：把 store 里的自建协议写回两张 legacy 表，详情列表因此能读到它们。 */
function installCustomProtocols() {
  const tables = legacyTables();
  uninstallCustomProtocols();
  for (const [id, protocol] of Object.entries(state.store.model)) {
    tables.PROTOCOLS[id] = protocol;
    state.installed.model.add(id);
  }
  for (const [id, protocol] of Object.entries(state.store.provider)) {
    tables.PROVIDER_PROTOCOLS[id] = protocol;
    state.installed.provider.add(id);
  }
}

/** 源 :3073-3078：先写同名 .tmp 再 rename，避免读到半截文件。 */
function persistCustomProtocols(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state.store, null, 2), "utf-8");
  fs.renameSync(temp, file);
}

/**
 * 源 :3135-3155：整体损坏安全忽略（不影响内置表），单条非法逐条忽略并记录原因。
 * 返回结构化结果，调用方可如实知道"哪些没装进来"，而不是伪造 origin。
 */
function loadCustomProtocols() {
  const file = resolveStoreFile();
  const result = { file, ok: true, error: null, detail: null, ignored: [], providerCount: 0, modelCount: 0 };
  state.loaded = false;
  state.store = { provider: {}, model: {} };
  uninstallCustomProtocols();
  state.lastLoad = result;
  if (!file) return result;
  if (!fs.existsSync(file)) return result;
  let parsed;
  try {
    parsed = protocolObject(JSON.parse(fs.readFileSync(file, "utf-8")));
  } catch (error) {
    result.ok = false;
    result.error = "STORE_FILE_CORRUPT";
    result.detail = String((error && error.message) || error).slice(0, 300);
    return result;
  }
  for (const kind of ["provider", "model"]) {
    for (const [key, raw] of Object.entries(protocolObject(parsed[kind]))) {
      try {
        const protocol = normalizeCustomProtocol(kind, raw);
        state.store[kind][protocol.id] = protocol;
      } catch (error) {
        result.ignored.push({
          kind,
          id: String((raw && raw.id) || key).slice(0, 64),
          reason: String((error && error.message) || error).slice(0, 200),
        });
      }
    }
  }
  result.providerCount = Object.keys(state.store.provider).length;
  result.modelCount = Object.keys(state.store.model).length;
  state.loaded = true;
  installCustomProtocols();
  return result;
}

/** 首次读盘；无落盘路径时保持 loaded=false，让后续 configure 仍能触发装载。 */
function ensureLoaded() {
  if (state.loaded) return state.lastLoad;
  return loadCustomProtocols();
}

/** 源 :3157-3168。先校验再落盘；落盘失败回滚内存表，保证不产生"只在内存里"的假条目。 */
function saveCustomProtocol(kind, value) {
  assertKind(kind);
  ensureLoaded();
  const protocol = normalizeCustomProtocol(kind, value);
  const file = resolveStoreFile();
  if (!file) throw new Error("自定义协议仓库未配置落盘路径，拒绝保存以免丢失。");
  const collection = state.store[kind];
  const previous = collection[protocol.id];
  collection[protocol.id] = protocol;
  installCustomProtocols();
  try {
    persistCustomProtocols(file);
  } catch (error) {
    if (previous === undefined) delete collection[protocol.id];
    else collection[protocol.id] = previous;
    installCustomProtocols();
    throw error;
  }
  state.loaded = true;
  return protocol;
}

/** 源 :3170-3179。 */
function removeCustomProtocol(kind, idValue) {
  assertKind(kind);
  ensureLoaded();
  const id = String(idValue || "").trim().toLowerCase();
  const collection = state.store[kind];
  if (!collection[id]) throw new Error(`自定义${kind === "provider" ? "平台" : "模型"}协议「${id}」不存在。`);
  const file = resolveStoreFile();
  if (!file) throw new Error("自定义协议仓库未配置落盘路径，拒绝删除以免状态不一致。");
  const previous = collection[id];
  delete collection[id];
  installCustomProtocols();
  try {
    persistCustomProtocols(file);
  } catch (error) {
    collection[id] = previous;
    installCustomProtocols();
    throw error;
  }
  return id;
}

/**
 * 源 :3375/:3385 的 origin 判定：builtin；否则 remote（本地不联网，未移植）；否则 custom。
 * 自建条目以 store 为准，store 损坏 / 不可用时它们根本没进表，这里不会把内置表说成自建。
 */
function originOf(kind, idValue) {
  assertKind(kind);
  ensureLoaded();
  const tables = legacyTables();
  const id = String(idValue || "").trim().toLowerCase();
  const builtin = kind === "provider" ? tables.BUILTIN_PROVIDER_PROTOCOL_IDS : tables.BUILTIN_MODEL_PROTOCOL_IDS;
  if (builtin.has(id)) return "builtin";
  if (state.store[kind][id]) return "custom";
  return "custom";
}

function listCustomProtocolIds(kind) {
  assertKind(kind);
  ensureLoaded();
  return Object.keys(state.store[kind]).sort();
}

/** 供配置 / 诊断如实读取装载状态，不隐藏损坏与逐条忽略。 */
function customProtocolStoreStatus() {
  return {
    file: resolveStoreFile(),
    loaded: state.loaded,
    providerIds: Object.keys(state.store.provider).sort(),
    modelIds: Object.keys(state.store.model).sort(),
    installedProviderIds: [...state.installed.provider].sort(),
    installedModelIds: [...state.installed.model].sort(),
    lastLoad: state.lastLoad ? { ...state.lastLoad, ignored: state.lastLoad.ignored.map((item) => ({ ...item })) } : null,
  };
}

/** 数据目录 / 文件注入（与 repository.cjs 的 configureProtocolRepository 同风格）。 */
function configureCustomProtocolStore(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "storeFile")) state.storeFile = options.storeFile ? String(options.storeFile) : null;
  if (Object.prototype.hasOwnProperty.call(options, "userDataDir")) state.userDataDir = options.userDataDir ? String(options.userDataDir) : null;
  state.loaded = false;
  state.lastLoad = null;
  state.store = { provider: {}, model: {} };
  uninstallCustomProtocols();
  return customProtocolStoreStatus();
}

function resetCustomProtocolStoreForTests() {
  state.storeFile = null;
  state.userDataDir = null;
  state.loaded = false;
  state.lastLoad = null;
  state.store = { provider: {}, model: {} };
  uninstallCustomProtocols();
}

module.exports = {
  CUSTOM_PROTOCOL_FILE_NAME,
  customProtocolStoreFilePath,
  configureCustomProtocolStore,
  loadCustomProtocols,
  ensureLoaded,
  normalizeCustomProtocol,
  saveCustomProtocol,
  removeCustomProtocol,
  originOf,
  listCustomProtocolIds,
  customProtocolStoreStatus,
  resetCustomProtocolStoreForTests,
};
