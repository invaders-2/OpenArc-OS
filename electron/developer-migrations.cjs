/**
 * B7b · 声明式数据迁移（源 server/developerProjectMigrations.ts:1-170）。
 *
 * ## 逐字对应
 *   · 路径硬化           源 :91-96  projectPath
 *   · 快照落盘           源 :36-89  safeId / snapshotDir / save / has / restore / saveForward / delete
 *   · 声明式操作         源 :111-170 applyDeclarativeProjectMigration（mkdir / write / move / remove + 标记文件）
 *
 * ## 本移植新增的三件硬要求（源没有，但 B7b 任务书写明）
 *   1. 幂等：applyDeclarativeProjectMigration 先读根标记 .dx-app-project.json，dataVersion 已等于 to
 *      时直接返回 0（不重复写、不重复移动）。
 *   2. 可回滚：applyDeclarativeMigrationChain 在动任何节点前，对每个根做 subtree 快照；
 *      任一迁移抛错即恢复全部快照，返回 { ok:false, rolledBack:true }。
 *   3. 失败不半应用：快照能力缺失时**在动手之前**结构化拒绝（DEVELOPER_MIGRATION_SNAPSHOT_UNSUPPORTED）；
 *      校验（格式 / 操作数 / 路径 / 体积）也在动手之前完成。
 *
 * ## 依赖注入
 *   · fsAdapter —— B6 dxos-fs.cjs 的 createDxosFs() 返回对象（createNode/findByPath/listChildren/
 *     moveNode/purgeNode/renameNode/setContent/snapshotSubtree/restoreSubtreeSnapshot）。
 *     缺方法一律结构化 DEVELOPER_FS_UNAVAILABLE，不伪造成功。
 *   · snapshotRoot —— 快照目录；测试用临时目录，生产由装配处给 <userData>/dxos 下路径。
 *
 * OUT：远端更新 / 云端市场 —— 本文件零网络。
 */
"use strict";

const nodeFs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CHANNEL = "developer:command";
const EVENT_CHANNEL = "developer:event";

const MIGRATION_FORMAT = "dx-project-migration/v1";
const SNAPSHOT_FORMAT = "dx-app-project-snapshot/v1";
const PROJECT_MARKER = ".dx-app-project.json";
const MAX_OPERATIONS = 200;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;

const APPLY_METHODS = ["createNode", "findByPath", "listChildren", "moveNode", "purgeNode", "renameNode", "setContent"];
const SNAPSHOT_METHODS = ["snapshotSubtree", "restoreSubtreeSnapshot"];

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, detail = null) => ({ ok: false, error: String(error), detail });

function assertFsAdapter(fsAdapter, methods) {
  const missing = methods.filter((name) => !fsAdapter || typeof fsAdapter[name] !== "function");
  if (missing.length) {
    const error = new Error("开发者项目虚拟文件树不可用：" + missing.join(","));
    error.code = "DEVELOPER_FS_UNAVAILABLE";
    error.missing = missing;
    throw error;
  }
}

// 源 :30-34 safeId
function safeId(value, label) {
  const id = String(value || "");
  if (!/^[a-zA-Z0-9_.+-]{1,180}$/.test(id)) throw new Error(label + " 不合法");
  return id;
}

// 源 :91-96 projectPath
function projectPath(value) {
  const rel = String(value == null ? "" : value).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/g, "");
  const parts = rel.split("/");
  if (!rel || rel.length > 500 || rel.startsWith("/") || /^[a-z]:/i.test(rel) || parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".") || part.length > 80 || /[\\:*?"<>|]/.test(part))) {
    throw new Error("迁移项目路径不合法：" + (rel || "(空)"));
  }
  return rel;
}

// 源 :98-109 ensureParent
function ensureParent(fsAdapter, rootId, rel, ownerId) {
  const parts = rel.split("/");
  const leaf = parts.pop();
  let parentId = rootId;
  for (const name of parts) {
    const existing = fsAdapter.listChildren(parentId).nodes.find((node) => node.name === name);
    if (existing && existing.type === "file") throw new Error("迁移路径中存在同名文件：" + name);
    const folder = existing || fsAdapter.createNode({ name, type: "folder", parentId, ownerId });
    parentId = folder.id;
  }
  return { parentId, leaf };
}

function readMarker(fsAdapter, rootId) {
  const marker = fsAdapter.listChildren(rootId).nodes.find((node) => node.type === "file" && node.name === PROJECT_MARKER);
  if (!marker) return null;
  let value = {};
  try { value = JSON.parse(marker.content || "{}"); } catch { value = {}; }
  return { marker, value };
}

/**
 * 迁移文档的**动手前**校验（源只在 apply 里做，这里提前到快照之前）。
 * 返回归一化操作数量；失败抛错，调用方保证此时还没有任何写入。
 */
function validateDeclarativeMigrationDocument(raw, from, to) {
  const doc = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (doc.format !== MIGRATION_FORMAT) throw new Error("迁移 " + from + "→" + to + " 缺少 format=" + MIGRATION_FORMAT);
  const operations = Array.isArray(doc.operations) ? doc.operations : [];
  if (!operations.length || operations.length > MAX_OPERATIONS) throw new Error("迁移 " + from + "→" + to + " operations 必须包含 1–" + MAX_OPERATIONS + " 项");
  for (let index = 0; index < operations.length; index += 1) {
    const op = operations[index] && typeof operations[index] === "object" && !Array.isArray(operations[index]) ? operations[index] : {};
    const kind = String(op.op || "");
    try {
      if (kind === "mkdir") { projectPath(op.path); continue; }
      if (kind === "write") {
        projectPath(op.path);
        const content = typeof op.content === "string" ? op.content : JSON.stringify(op.content === undefined ? null : op.content, null, 2);
        if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) throw new Error("迁移写入文件超过 2 MB：" + projectPath(op.path));
        continue;
      }
      if (kind === "move") { projectPath(op.from); projectPath(op.to); continue; }
      if (kind === "remove") { projectPath(op.path); continue; }
      throw new Error("不支持的声明式迁移操作：" + (kind || "(空)"));
    } catch (error) {
      const wrapped = new Error(String((error && error.message) || error));
      wrapped.operationIndex = index;
      throw wrapped;
    }
  }
  return operations.length;
}

/**
 * 源 :111-170 applyDeclarativeProjectMigration（幂等增强：标记 dataVersion 已到 to 即跳过）。
 * @returns 实际执行的操作数（跳过一次则 0）
 */
function applyDeclarativeProjectMigration({ rootId, ownerId, raw, from, to, fsAdapter = null } = {}) {
  assertFsAdapter(fsAdapter, APPLY_METHODS);
  const operations = validateDeclarativeMigrationDocument(raw, from, to);
  // 幂等：根标记已经指向目标 dataVersion，就不再重复执行（源靠调用方 cursor 保证，这里自洽）。
  const existingMarker = readMarker(fsAdapter, rootId);
  if (existingMarker && Number(existingMarker.value.dataVersion) === Number(to)) return 0;
  const doc = raw;
  for (const item of doc.operations) {
    const op = item && typeof item === "object" && !Array.isArray(item) ? item : {};
    const kind = String(op.op || "");
    if (kind === "mkdir") {
      const dirPath = projectPath(op.path);
      const existing = fsAdapter.findByPath(rootId, dirPath);
      if (existing && existing.type === "file") throw new Error("迁移无法创建目录，存在同名文件：" + dirPath);
      if (!existing) ensureParent(fsAdapter, rootId, dirPath + "/.placeholder", ownerId);
      continue;
    }
    if (kind === "write") {
      const targetPath = projectPath(op.path);
      const content = typeof op.content === "string" ? op.content : JSON.stringify(op.content === undefined ? null : op.content, null, 2);
      if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) throw new Error("迁移写入文件超过 2 MB：" + targetPath);
      const existing = fsAdapter.findByPath(rootId, targetPath);
      if (existing && existing.type === "folder") throw new Error("迁移无法覆盖同名目录：" + targetPath);
      if (existing && op.ifMissing === true) continue;
      if (existing) fsAdapter.setContent(existing.id, content);
      else {
        const target = ensureParent(fsAdapter, rootId, targetPath, ownerId);
        fsAdapter.createNode({ name: target.leaf, type: "file", parentId: target.parentId, ownerId, content });
      }
      continue;
    }
    if (kind === "move") {
      const fromPath = projectPath(op.from);
      const toPath = projectPath(op.to);
      const source = fsAdapter.findByPath(rootId, fromPath);
      if (!source) {
        if (op.ifExists === true) continue;
        throw new Error("迁移源路径不存在：" + fromPath);
      }
      if (fsAdapter.findByPath(rootId, toPath)) throw new Error("迁移目标路径已存在：" + toPath);
      const target = ensureParent(fsAdapter, rootId, toPath, ownerId);
      fsAdapter.moveNode(source.id, target.parentId);
      fsAdapter.renameNode(source.id, target.leaf);
      continue;
    }
    if (kind === "remove") {
      const targetPath = projectPath(op.path);
      const existing = fsAdapter.findByPath(rootId, targetPath);
      if (existing) fsAdapter.purgeNode(existing.id);
      else if (op.ifExists !== true) throw new Error("迁移删除路径不存在：" + targetPath);
      continue;
    }
    throw new Error("不支持的声明式迁移操作：" + (kind || "(空)"));
  }
  const marker = readMarker(fsAdapter, rootId);
  if (marker) {
    fsAdapter.setContent(marker.marker.id, JSON.stringify({ ...marker.value, dataVersion: to, migratedAt: Date.now() }, null, 2));
  } else {
    // 源里 .dx-app-project.json 由项目根装配处预置；这里在首次成功应用后补建，
    // 否则同一份迁移第二次执行会因 move 源已消失而失败 —— 幂等的前提是标记必须存在。
    fsAdapter.createNode({
      name: PROJECT_MARKER, type: "file", parentId: rootId, ownerId,
      content: JSON.stringify({ dataVersion: to, migratedAt: Date.now() }, null, 2),
    });
  }
  return operations;
}

function defaultSnapshotRoot() { return path.join(os.tmpdir(), "openarc-developer-app-project-snapshots"); }

/** 源 :18-89 的快照持久层（JSON 文件，一个 owner 一份）。 */
class DeveloperMigrationSnapshotStore {
  constructor({ snapshotRoot = null, fsImpl = nodeFs } = {}) {
    this.snapshotRoot = snapshotRoot || defaultSnapshotRoot();
    this.fs = fsImpl || nodeFs;
  }

  // 源 :36-38 snapshotDir
  snapshotDir(appId, historyId) {
    return path.join(this.snapshotRoot, safeId(appId, "APP ID"), safeId(historyId, "历史版本 ID"));
  }

  // 源 :40-49 saveDeveloperProjectSnapshot
  saveSnapshot({ appId, historyId, ownerId, rootId, fsAdapter = null } = {}) {
    assertFsAdapter(fsAdapter, ["snapshotSubtree"]);
    const record = { format: SNAPSHOT_FORMAT, appId, historyId, ownerId, rootId, snapshot: fsAdapter.snapshotSubtree(rootId) };
    const dir = this.snapshotDir(appId, historyId);
    this.fs.mkdirSync(dir, { recursive: true });
    this.fs.writeFileSync(path.join(dir, safeId(ownerId, "账户 ID") + ".json"), JSON.stringify(record), "utf8");
    return record;
  }

  // 源 :51-54 hasDeveloperProjectSnapshots
  hasSnapshots(appId, historyId) {
    const dir = this.snapshotDir(appId, historyId);
    return this.fs.existsSync(dir) && this.fs.readdirSync(dir).some((name) => name.endsWith(".json"));
  }

  // 源 :56-64 deleteDeveloperProjectSnapshots / deleteDeveloperProjectSnapshot
  deleteSnapshots(appId) {
    const root = path.join(this.snapshotRoot, safeId(appId, "APP ID"));
    if (this.fs.existsSync(root)) this.fs.rmSync(root, { recursive: true, force: true });
  }
  deleteSnapshot(appId, historyId) {
    const dir = this.snapshotDir(appId, historyId);
    if (this.fs.existsSync(dir)) this.fs.rmSync(dir, { recursive: true, force: true });
  }

  // 源 :66-76 restoreDeveloperProjectSnapshots
  restoreSnapshots({ appId, historyId, fsAdapter = null } = {}) {
    assertFsAdapter(fsAdapter, ["restoreSubtreeSnapshot"]);
    const dir = this.snapshotDir(appId, historyId);
    if (!this.fs.existsSync(dir)) throw new Error("该历史版本没有项目数据快照");
    const restored = [];
    for (const name of this.fs.readdirSync(dir).filter((item) => item.endsWith(".json"))) {
      const record = JSON.parse(this.fs.readFileSync(path.join(dir, name), "utf8"));
      if (record.format !== SNAPSHOT_FORMAT || record.appId !== appId || record.historyId !== historyId) throw new Error("项目数据快照身份不匹配");
      restored.push({ ownerId: record.ownerId, rootId: record.rootId, nodes: fsAdapter.restoreSubtreeSnapshot(record.rootId, record.snapshot) });
    }
    return restored;
  }

  // 源 :79-89 saveForwardDeveloperProjectSnapshots
  saveForwardSnapshots({ appId, referenceHistoryId, newHistoryId, fsAdapter = null } = {}) {
    const dir = this.snapshotDir(appId, referenceHistoryId);
    if (!this.fs.existsSync(dir)) throw new Error("缺少用于建立正向回滚点的项目快照");
    const saved = [];
    for (const name of this.fs.readdirSync(dir).filter((item) => item.endsWith(".json"))) {
      const reference = JSON.parse(this.fs.readFileSync(path.join(dir, name), "utf8"));
      if (reference.format !== SNAPSHOT_FORMAT || reference.appId !== appId) throw new Error("正向回滚项目快照身份不匹配");
      saved.push(this.saveSnapshot({ appId, historyId: newHistoryId, ownerId: reference.ownerId, rootId: reference.rootId, fsAdapter }));
    }
    return saved.length;
  }

  /**
   * 迁移链：先快照 → 再逐个 apply → 任一失败恢复全部快照。
   * documents: [{ from, to, document }]，必须 from/to 连续。
   * roots:     [{ ownerId, rootId }]
   */
  applyChain({ appId, historyId, roots, documents, fsAdapter = null } = {}) {
    try { assertFsAdapter(fsAdapter, APPLY_METHODS); }
    catch (error) { return fail("DEVELOPER_FS_UNAVAILABLE", { missing: error.missing || [], message: String((error && error.message) || error) }); }
    const chain = Array.isArray(documents) ? documents : [];
    const targets = Array.isArray(roots) ? roots : [];
    if (!chain.length) return fail("INVALID_INPUT", "documents");
    if (!targets.length) return fail("INVALID_INPUT", "roots");
    // 1) 动手前校验：链连续 + 每份文档格式/操作/路径合法。
    for (let index = 0; index < chain.length; index += 1) {
      const step = chain[index] || {};
      if (index > 0 && Number(chain[index - 1].to) !== Number(step.from)) return fail("INVALID_INPUT", "migration-chain-not-contiguous");
      if (Number(step.to) !== Number(step.from) + 1) return fail("INVALID_INPUT", "migration-step-not-sequential");
      try { validateDeclarativeMigrationDocument(step.document, step.from, step.to); }
      catch (error) { return fail(String((error && error.message) || error), { stage: "validate", from: step.from, to: step.to }); }
    }
    // 2) 动手前确认快照能力（失败不半应用：宁可不做，也不能做一半）。
    try { assertFsAdapter(fsAdapter, SNAPSHOT_METHODS); }
    catch (error) { return fail("DEVELOPER_MIGRATION_SNAPSHOT_UNSUPPORTED", { missing: error.missing || [], message: String((error && error.message) || error) }); }
    const snapshotHistoryId = historyId || ("migration-" + Date.now());
    try {
      for (const target of targets) this.saveSnapshot({ appId, historyId: snapshotHistoryId, ownerId: target.ownerId, rootId: target.rootId, fsAdapter });
      let applied = 0;
      for (const target of targets) {
        for (const step of chain) applied += applyDeclarativeProjectMigration({ rootId: target.rootId, ownerId: target.ownerId, raw: step.document, from: step.from, to: step.to, fsAdapter });
      }
      return ok({ applied, historyId: snapshotHistoryId, roots: targets.length, documents: chain.length });
    } catch (error) {
      // 3) 失败回滚：恢复全部根快照；恢复本身失败也要如实报告，不能吞。
      let rolledBack = false;
      let rollbackError = null;
      try { this.restoreSnapshots({ appId, historyId: snapshotHistoryId, fsAdapter }); rolledBack = true; }
      catch (restoreFailure) { rollbackError = String((restoreFailure && restoreFailure.message) || restoreFailure); }
      return fail(String((error && error.message) || error), {
        stage: "apply", rolledBack,
        rollbackError,
        operationIndex: error && error.operationIndex !== undefined ? error.operationIndex : null,
        historyId: snapshotHistoryId,
      });
    }
  }
}

// ===========================================================================
// 命令面切片（并入 developer:command）
// ===========================================================================

const DEVELOPER_MIGRATION_COMMANDS = Object.freeze([
  { command: "developer/migrations/apply", risk: "write", credential: "none", summary: "对单个项目根应用一份声明式迁移（幂等）" },
  { command: "developer/migrations/applyChain", risk: "write", credential: "none", summary: "快照后应用连续迁移链；失败恢复全部快照（不半应用）" },
  { command: "developer/migrations/saveSnapshot", risk: "write", credential: "none", summary: "为项目根保存历史版本快照" },
  { command: "developer/migrations/restoreSnapshot", risk: "write", credential: "none", summary: "按历史版本恢复项目数据快照" },
  { command: "developer/migrations/snapshotStatus", risk: "read", credential: "none", summary: "报告指定版本是否已有项目数据快照" },
  { command: "developer/migrations/deleteSnapshots", risk: "delete", credential: "none", summary: "删除某个 APP 的全部项目数据快照" },
  { command: "developer/migrations/deleteSnapshot", risk: "delete", credential: "none", summary: "删除某个历史版本的项目数据快照" },
]);

const DEVELOPER_MIGRATION_REGISTRY = new Map(DEVELOPER_MIGRATION_COMMANDS.map((entry) => [entry.command, entry]));

function createDeveloperMigrationExtension({ store = null, fsAdapter = null } = {}) {
  const requireStore = () => {
    if (!store || typeof store.applyChain !== "function") return fail("DEVELOPER_MIGRATION_UNAVAILABLE", "store-not-configured");
    return null;
  };
  const handlers = {
    "developer/migrations/apply": (payload) => ok({
      applied: applyDeclarativeProjectMigration({
        rootId: payload.rootId, ownerId: payload.ownerId, raw: payload.document,
        from: Number(payload.from), to: Number(payload.to), fsAdapter,
      }),
    }),
    "developer/migrations/applyChain": (payload) => store.applyChain({
      appId: payload.appId, historyId: payload.historyId, roots: payload.roots, documents: payload.documents, fsAdapter,
    }),
    "developer/migrations/saveSnapshot": (payload) => ok({
      record: store.saveSnapshot({ appId: payload.appId, historyId: payload.historyId, ownerId: payload.ownerId, rootId: payload.rootId, fsAdapter }),
    }),
    "developer/migrations/restoreSnapshot": (payload) => ok({
      restored: store.restoreSnapshots({ appId: payload.appId, historyId: payload.historyId, fsAdapter }),
    }),
    "developer/migrations/snapshotStatus": (payload) => ok({
      available: store.hasSnapshots(payload.appId, payload.historyId),
    }),
    "developer/migrations/deleteSnapshots": (payload) => { store.deleteSnapshots(payload.appId); return ok({ deleted: true }); },
    "developer/migrations/deleteSnapshot": (payload) => { store.deleteSnapshot(payload.appId, payload.historyId); return ok({ deleted: true }); },
  };
  const dispatch = ({ command, payload } = {}) => {
    const entry = DEVELOPER_MIGRATION_REGISTRY.get(String(command || ""));
    if (!entry) return fail("DEVELOPER_COMMAND_NOT_ALLOWED", String(command || ""));
    const missing = requireStore(); if (missing) return missing;
    const handler = handlers[entry.command];
    if (typeof handler !== "function") return fail("NOT_IMPLEMENTED", entry.command);
    try { return handler(payload && typeof payload === "object" ? payload : {}, {}); }
    catch (error) { return fail(String((error && error.message) || error), error && error.missing ? { missing: error.missing } : null); }
  };
  return { channel: CHANNEL, eventChannel: EVENT_CHANNEL, registry: DEVELOPER_MIGRATION_COMMANDS.map((e) => ({ ...e })), commandNames: DEVELOPER_MIGRATION_COMMANDS.map((e) => e.command), dispatch, handlers };
}

module.exports = {
  CHANNEL, EVENT_CHANNEL, MIGRATION_FORMAT, SNAPSHOT_FORMAT, PROJECT_MARKER, MAX_OPERATIONS, MAX_WRITE_BYTES,
  APPLY_METHODS, SNAPSHOT_METHODS, assertFsAdapter, safeId, projectPath, ensureParent,
  validateDeclarativeMigrationDocument, applyDeclarativeProjectMigration,
  defaultSnapshotRoot, DeveloperMigrationSnapshotStore,
  DEVELOPER_MIGRATION_COMMANDS, DEVELOPER_MIGRATION_REGISTRY, createDeveloperMigrationExtension,
};
