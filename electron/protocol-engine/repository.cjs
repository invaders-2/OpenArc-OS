"use strict";
/**
 * dx-protocol/v2 协议仓库。
 * 源：DXSRC/protocol-engine/repository.ts:1-226（自定义协议 JSON 仓库、版本、hash、
 * 系统协议不可覆盖/删除）。
 *
 * 本地化改造（P2 任务要求"本地目录扫描替代远程协议包更新"）：
 * 新增 scanProtocolPackageDirectory()/configureProtocolRepository()，把 DX OS 从
 * https://api.dx-os.com 拉取的远程协议包（protocolUpdates.ts:8,189,215）替换为扫描
 * 本地目录里的 *.json 协议包。优先级：builtin(system) < 本地协议包(package) < 自定义(custom)。
 */
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { validateProtocolV2 } = require("./validator.cjs");
const { getBuiltinProtocolV2, listBuiltinProtocolsV2 } = require("./builtins.cjs");

let storeFile = null;
let packageDirs = [];
let loaded = false;
let store = { format: "dx-custom-protocols/v2", provider: {}, model: {} };
let packageCache = new Map();

function configureProtocolRepository(options = {}) {
  if (options.storeFile !== undefined) { storeFile = options.storeFile ? String(options.storeFile) : null; loaded = false; }
  if (options.packageDirs !== undefined) { packageDirs = Array.isArray(options.packageDirs) ? options.packageDirs.map(String) : []; packageCache = new Map(); }
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
  return JSON.stringify(value);
}

function protocolV2Hash(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** 本地协议包：目录里每个 *.json 可以是单个协议，或协议数组，或 { protocols: [...] }。 */
function scanProtocolPackageDirectory(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
    const file = path.join(dir, entry.name);
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    const candidates = Array.isArray(raw) ? raw : Array.isArray(raw.protocols) ? raw.protocols : [raw];
    for (const candidate of candidates) {
      try {
        const protocol = validateProtocolV2(candidate);
        out.push({ id: protocol.id, kind: protocol.kind, protocol, source: "package", sourcePath: file });
      } catch { /* 损坏的协议包不阻塞其余包 */ }
    }
  }
  return out;
}

function packageEntries() {
  if (!packageCache.size && packageDirs.length) {
    for (const dir of packageDirs) for (const entry of scanProtocolPackageDirectory(dir)) packageCache.set(entry.kind + ":" + entry.id, entry);
  }
  return [...packageCache.values()];
}

function parseEntry(raw, expectedKind) {
  const value = object(raw);
  const id = String(value.id || "");
  const versions = {};
  for (const [versionKey, versionRaw] of Object.entries(object(value.versions))) {
    try {
      const versionObject = object(versionRaw);
      const protocol = validateProtocolV2(versionObject.protocol);
      const version = Number(versionObject.version || versionKey);
      if (protocol.kind !== expectedKind || protocol.id !== id || !Number.isInteger(version) || version < 1) continue;
      const hash = protocolV2Hash(protocol);
      if (versionObject.hash && String(versionObject.hash) !== hash) continue;
      versions[String(version)] = { version, hash, createdAt: Number(versionObject.createdAt) || 0, protocol };
    } catch { /* skip damaged version */ }
  }
  const keys = Object.keys(versions).map(Number).sort((left, right) => left - right);
  if (!id || !keys.length) return null;
  const requestedActive = Number(value.activeVersion);
  const activeVersion = versions[String(requestedActive)] ? requestedActive : keys[keys.length - 1];
  return { id, kind: expectedKind, activeVersion, versions };
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  if (!storeFile) return;
  try {
    if (!fs.existsSync(storeFile)) return;
    const raw = object(JSON.parse(fs.readFileSync(storeFile, "utf8")));
    if (raw.format !== "dx-custom-protocols/v2") return;
    for (const kind of ["provider", "model"]) {
      for (const rawEntry of Object.values(object(raw[kind]))) {
        const entry = parseEntry(rawEntry, kind);
        if (entry) store[kind][entry.id] = entry;
      }
    }
  } catch { /* damaged v2 store does not block startup */ }
}

function persist() {
  if (!storeFile) return;
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  const temporary = storeFile + "." + process.pid + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2) + "\n", "utf8");
  fs.renameSync(temporary, storeFile);
}

function publicEntry(entry, source = "custom") {
  const active = entry.versions[String(entry.activeVersion)];
  return {
    id: entry.id, kind: entry.kind, activeVersion: entry.activeVersion,
    activeHash: active.hash, source, protocol: structuredClone(active.protocol),
    versions: Object.values(entry.versions).sort((left, right) => right.version - left.version).map(({ version, hash, createdAt }) => ({ version, hash, createdAt })),
  };
}

function listProtocolsV2(kind) {
  ensureLoaded();
  const kinds = kind ? [kind] : ["provider", "model"];
  const custom = kinds.flatMap((entryKind) => Object.values(store[entryKind]).map((entry) => publicEntry(entry, "custom")));
  const customKeys = new Set(custom.map((entry) => entry.kind + ":" + entry.id));
  const packages = packageEntries().filter((entry) => kinds.includes(entry.kind) && !customKeys.has(entry.kind + ":" + entry.id)).map((entry) => {
    const hash = protocolV2Hash(entry.protocol);
    return { id: entry.id, kind: entry.kind, activeVersion: 1, activeHash: hash, source: "package", protocol: structuredClone(entry.protocol), versions: [{ version: 1, hash, createdAt: 0 }] };
  });
  const packageKeys = new Set([...customKeys, ...packages.map((entry) => entry.kind + ":" + entry.id)]);
  const system = listBuiltinProtocolsV2()
    .filter((protocol) => kinds.includes(protocol.kind))
    .filter((protocol) => !packageKeys.has(protocol.kind + ":" + protocol.id))
    .map((protocol) => {
      const hash = protocolV2Hash(protocol);
      return { id: protocol.id, kind: protocol.kind, activeVersion: 1, activeHash: hash, source: "system", protocol: structuredClone(protocol), versions: [{ version: 1, hash, createdAt: 0 }] };
    });
  return [...system, ...packages, ...custom].sort((left, right) => left.id.localeCompare(right.id) || left.kind.localeCompare(right.kind));
}

function getProtocolV2(kind, idValue, version) {
  ensureLoaded();
  const id = String(idValue || "").trim().toLowerCase();
  const entry = store[kind][id];
  if (!entry) {
    const packaged = packageEntries().find((item) => item.kind === kind && item.id === id);
    if (packaged) {
      if (version != null && version !== 1) return null;
      const hash = protocolV2Hash(packaged.protocol);
      return { version: 1, hash, createdAt: 0, protocol: structuredClone(packaged.protocol) };
    }
    const protocol = getBuiltinProtocolV2(kind, id);
    if (!protocol || (version != null && version !== 1)) return null;
    return { version: 1, hash: protocolV2Hash(protocol), createdAt: 0, protocol: structuredClone(protocol) };
  }
  const selected = entry.versions[String(version || entry.activeVersion)];
  return selected ? structuredClone(selected) : null;
}

function isCustomProtocolV2(kind, idValue) {
  ensureLoaded();
  const id = String(idValue || "").trim().toLowerCase();
  return !!store[kind][id];
}

function validateCustomProtocolV2(kind, value) {
  const protocol = validateProtocolV2(value);
  if (protocol.kind !== kind) throw new Error("协议 kind 是 " + protocol.kind + "，不能保存到 " + kind + " 仓库。");
  if (protocol.executor.type !== "declarative") throw new Error("用户自定义 v2 协议只能使用 declarative executor。");
  if (getBuiltinProtocolV2(kind, protocol.id)) throw new Error("v2 " + kind + " 协议「" + protocol.id + "」是系统协议，不能被自定义协议覆盖。");
  return protocol;
}

function applyProtocolV2(kind, protocol, createdAt) {
  const collection = store[kind];
  const existing = collection[protocol.id];
  const hash = protocolV2Hash(protocol);
  if (existing) {
    const same = Object.values(existing.versions).find((item) => item.hash === hash);
    if (same) { existing.activeVersion = same.version; return publicEntry(existing); }
  }
  const version = existing ? Math.max(...Object.keys(existing.versions).map(Number)) + 1 : 1;
  const versionEntry = { version, hash, createdAt, protocol };
  const entry = existing || { id: protocol.id, kind, activeVersion: version, versions: {} };
  entry.versions[String(version)] = versionEntry;
  entry.activeVersion = version;
  collection[protocol.id] = entry;
  return publicEntry(entry);
}

function saveProtocolV2(kind, value, createdAt = Date.now()) {
  ensureLoaded();
  const result = applyProtocolV2(kind, validateCustomProtocolV2(kind, value), createdAt);
  persist();
  return result;
}

function saveProtocolV2Bundle(value, createdAt = Date.now()) {
  ensureLoaded();
  const bundle = object(value);
  if (bundle.format !== "dx-agent-protocol-bundle/v1") throw new Error("组合协议 format 必须是 dx-agent-protocol-bundle/v1。");
  const provider = validateCustomProtocolV2("provider", bundle.provider);
  if (!Array.isArray(bundle.models) || !bundle.models.length) throw new Error("组合协议至少需要一个能力协议。");
  if (bundle.models.length > 24) throw new Error("单个组合协议最多包含 24 个能力协议。");
  const models = bundle.models.map((protocol) => validateCustomProtocolV2("model", protocol));
  const keys = ["provider:" + provider.id, ...models.map((protocol) => "model:" + protocol.id)];
  if (new Set(keys).size !== keys.length) throw new Error("组合协议包含重复的协议 ID。");
  const previous = structuredClone(store);
  try {
    const providerEntry = applyProtocolV2("provider", provider, createdAt);
    const modelEntries = models.map((protocol) => applyProtocolV2("model", protocol, createdAt));
    persist();
    return { format: bundle.format, provider: providerEntry, models: modelEntries };
  } catch (error) {
    store = previous;
    throw error;
  }
}

function activateProtocolV2(kind, idValue, version) {
  ensureLoaded();
  const id = String(idValue || "").trim().toLowerCase();
  const entry = store[kind][id];
  if (!entry && getBuiltinProtocolV2(kind, id)) throw new Error("v2 " + kind + " 协议「" + id + "」是系统协议，固定使用版本 1。");
  if (!entry) throw new Error("v2 " + kind + " 协议「" + id + "」不存在。");
  if (!entry.versions[String(version)]) throw new Error("v2 协议「" + id + "」版本 " + version + " 不存在。");
  entry.activeVersion = version;
  persist();
  return publicEntry(entry);
}

function removeProtocolV2(kind, idValue) {
  ensureLoaded();
  const id = String(idValue || "").trim().toLowerCase();
  if (getBuiltinProtocolV2(kind, id)) throw new Error("v2 " + kind + " 协议「" + id + "」是系统协议，不能删除。");
  if (!store[kind][id]) throw new Error("v2 " + kind + " 协议「" + id + "」不存在。");
  delete store[kind][id];
  persist();
  return id;
}

function resetProtocolV2RepositoryForTests() {
  loaded = false;
  store = { format: "dx-custom-protocols/v2", provider: {}, model: {} };
  packageCache = new Map();
}

module.exports = {
  configureProtocolRepository, protocolV2Hash, listProtocolsV2, getProtocolV2, isCustomProtocolV2,
  saveProtocolV2, saveProtocolV2Bundle, activateProtocolV2, removeProtocolV2,
  scanProtocolPackageDirectory, resetProtocolV2RepositoryForTests,
};
