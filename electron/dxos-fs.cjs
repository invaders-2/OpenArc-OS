"use strict";
/**
 * B6b · DX OS 虚拟文件树（逐函数移植 server/fs.ts:1-1451）。
 *
 * ==== 与 OpenArc 既有文件 / 资源体系的关系与边界（为什么必须并存）====
 *   · electron/file-service.cjs —— 真实磁盘上的「桌面 / 访达」读写入口（OS 文件、系统对话框、
 *     真实路径权限）。它管的是用户电脑上真实存在的文件。本文件不调用它，也不写任何真实文件；
 *     全部状态落 <userData>/dxos/fs/（fs.json + blobs/ + cache/fs-thumbnails/）。
 *   · electron/folder-trash.cjs —— 真实文件夹回收站（把真实目录移入回收站再恢复）。
 *     本文件有自己的软删标记 trashed / trashedTs（源 fs.ts:42-45、1015-1098），两者互不影响。
 *   · electron/resource-*.cjs —— 资源域（素材库 / 上传附件 / 校验和 / 预览），真源是 sqlite 的
 *     resource_* 表。本文件不读写 resource_*、不注册 IPC；它是 Agent / 技能产物落地的「项目虚拟树」，
 *     只在 fsAdapter 之后被上层调用。
 *   为什么不能复用既有体系：DX 语义里有三样既有体系完全没有的东西 ——
 *     ① 隐藏根 + 桌面面包屑（.系统目录 / listChildren 的 path，源 fs.ts:485-500）；
 *     ② 共享盘（share='public' / 'department:<id>'，沿祖先继承的可见性，源 fs.ts:846-926）；
 *     ③ 内容寻址不可变 blob + Journal 批量提交 + 子树快照（sha256 路径、revision 乐观锁、
 *        dx-fs-subtree/v1，源 fs.ts:51-116、303-459、1321-1380）。
 *     硬塞进真实文件 / 资源体系，会让「真实文件」和「Agent 工作区」两套生命周期互相污染。
 *
 * ==== 相对路径硬化（与源 fs.ts 的唯一有意差异，源 fs.ts:642-660）====
 *   源 resolvePath 会把 '..' 当普通目录名（cleanName 不删点号），在 Agent 场景下构成越界写风险。
 *   本移植在 resolvePath 入口拒绝绝对路径与 '.' / '..' 段（FS_PATH_ESCAPE，statusCode 400）；
 *   findByPath 沿用源的 try/catch → null。除此之外逐函数照搬源语义。
 *
 * ==== 云与商业化 OUT ====
 *   源 fs.ts:606-635 的 upsertCloudCanvasFile 只是把调用方给的字节按稳定 UUID 落进虚拟树，
 *   本文件不联网，不引用 dxosProtocol / apiQuota / cloudEntitlement / publicMedia / api.dx-os.com；
 *   函数名保留是为了和源逐字对应。
 *
 * ==== 依赖注入 ====
 *   createDxosFs({ dataDir, userDataDir, clock, idFactory })
 *     · dataDir     —— 虚拟树数据目录（默认由 dxos-foundation-paths.cjs 的 directory.fs 给出）；
 *     · userDataDir —— 只给 userDataDir 时，经 resolveDxosFsDir(userDataDir)（dxos-foundation-paths.cjs）
 *                      取 <userData>/dxos/fs；
 *     · clock       —— 可选，返回毫秒（默认 Date.now）；节点 created_ts / updated_ts 仍按源
 *                      fs.ts:170-172 取「秒」。
 *   dataPath()（源 fs.ts:12-14）在这里展开为：
 *     FILE          = <dataDir>/fs.json
 *     BLOB_DIR      = <dataDir>/blobs
 *     THUMBNAIL_DIR = <dataDir>/cache/fs-thumbnails
 */
const {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { resolveDxosFsDir } = require("./dxos-foundation-paths.cjs");

const FS_FORMAT = "dx-fs/v2";            // 源 fs.ts:16
const SYSTEM_ROOT_NAME = ".系统目录";     // 源 fs.ts:15
const BLOB_SHA256_RE = /^[a-f0-9]{64}$/; // 源 fs.ts:52 / 118 / 449 三处同形校验
const TEXTUAL_EXT = ["txt", "md", "json", "csv", "log", "js", "ts", "css", "html", "xml", "yaml", "yml"]; // 源 fs.ts:1237
const USER_FOLDER_ALIASES = {            // 源 fs.ts:716-721
  "文稿": ["文稿"],
  "项目": ["项目", "画布"],
  "助理缓存": ["助理缓存"],
  "助理空间": ["助理空间"],
};

/** 与源 Object.assign(new Error(...), { statusCode, code }) 等价（源 fs.ts:244/283/336/398/401/411/424）。 */
function fsError(message, statusCode, code) {
  const error = new Error(message);
  if (statusCode !== undefined) error.statusCode = statusCode;
  if (code !== undefined) error.code = code;
  return error;
}

/** dataDir 解析：优先显式 dataDir；否则用 dxos-foundation-paths.cjs 登记的 directory.fs。 */
function resolveFsDataDir(options) {
  const opts = options || {};
  if (typeof opts.dataDir === "string" && opts.dataDir.trim() !== "") return resolve(opts.dataDir);
  if (typeof opts.userDataDir === "string" && opts.userDataDir.trim() !== "") {
    return resolveDxosFsDir(opts.userDataDir);
  }
  throw fsError("createDxosFs 需要 dataDir 或 userDataDir", 400, "FS_DATA_DIR_REQUIRED");
}

function createDxosFs(options) {
  const opts = options || {};
  const dataDir = resolveFsDataDir(opts);
  const clock = typeof opts.clock === "function" ? opts.clock : () => Date.now();
  const idFactory = typeof opts.idFactory === "function" ? opts.idFactory : randomUUID;

  const FILE = join(dataDir, "fs.json");                          // 源 fs.ts:12
  const BLOB_DIR = join(dataDir, "blobs");                        // 源 fs.ts:13
  const THUMBNAIL_DIR = join(dataDir, "cache", "fs-thumbnails");  // 源 fs.ts:14
  const LOCK_FILE = FILE + ".lock";                               // 源 fs.ts:17
  const revisionByList = new WeakMap();                           // 源 fs.ts:18
  let readOnlyDiskCache = null;                                   // 源 fs.ts:184

  /** 源 fs.ts:170-172：节点时间戳是秒（注入的 clock 返回毫秒）。 */
  function now() { return Math.floor(Number(clock()) / 1000); }

  // ── Blob（源 fs.ts:48-168）─────────────────────────────────────────────
  function legacyBlobPath(id) { return join(BLOB_DIR, id); } // 源:48-50

  function contentBlobPath(sha256) { // 源:51-54
    if (!BLOB_SHA256_RE.test(sha256)) throw new Error("内容 Blob SHA-256 无效");
    return join(BLOB_DIR, "sha256", sha256.slice(0, 2), sha256);
  }

  function blobPath(id) { // 源:55-62
    const legacy = legacyBlobPath(id);
    try {
      const node = readOnlyDiskState().nodes.find((item) => item.id === id);
      if (node && node.blobSha256) return contentBlobPath(node.blobSha256);
    } catch (error) {
      // 源注释：callers will surface the missing/corrupt source
    }
    return legacy;
  }

  function thumbnailPath(id, size) { // 源:63-65
    return join(THUMBNAIL_DIR, id + (size ? "-" + size : "") + ".jpg");
  }

  function hasThumbnail(id, size) { return existsSync(thumbnailPath(id, size)); } // 源:66-68

  function saveThumbnail(id, buf, size) { // 源:69-72
    if (!existsSync(THUMBNAIL_DIR)) mkdirSync(THUMBNAIL_DIR, { recursive: true });
    writeFileSync(thumbnailPath(id, size), buf);
  }

  function deleteThumbnail(id) { // 源:73-81
    for (const size of [undefined, 256, 320]) {
      try {
        if (existsSync(thumbnailPath(id, size))) unlinkSync(thumbnailPath(id, size));
      } catch (error) { /* 源: ignore */ }
    }
  }

  function hasBlob(id) { return existsSync(blobPath(id)); } // 源:82-84

  function stageContentAddressedBlob(buf, expectedSha256) { // 源:85-116
    const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (expectedSha256 && sha256 !== expectedSha256) throw new Error("Blob SHA-256 与 Artifact 记录不一致");
    const target = contentBlobPath(sha256);
    if (existsSync(target)) {
      const existing = readFileSync(target);
      if (existing.byteLength !== data.byteLength || createHash("sha256").update(existing).digest("hex") !== sha256) throw new Error("不可变 Blob 已损坏：" + sha256);
      return { sha256: sha256, path: target, bytes: data.byteLength, created: false };
    }
    mkdirSync(dirname(target), { recursive: true });
    const temp = target + "." + process.pid + "." + String(idFactory()).slice(0, 8) + ".tmp";
    let fd;
    try {
      fd = openSync(temp, "wx");
      writeFileSync(fd, data);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      try { renameSync(temp, target); }
      catch (error) {
        if (!existsSync(target)) throw error;
        unlinkSync(temp);
      }
    } catch (error) {
      try { if (fd !== undefined) closeSync(fd); } catch (cleanupError) { /* 源: ignore */ }
      try { if (existsSync(temp)) unlinkSync(temp); } catch (cleanupError) { /* 源: ignore */ }
      throw error;
    }
    const published = readFileSync(target);
    if (published.byteLength !== data.byteLength || createHash("sha256").update(published).digest("hex") !== sha256) throw new Error("不可变 Blob 发布后校验失败：" + sha256);
    return { sha256: sha256, path: target, bytes: data.byteLength, created: true };
  }

  function hasContentAddressedBlob(sha256) { // 源:117-119
    return BLOB_SHA256_RE.test(sha256) && existsSync(contentBlobPath(sha256));
  }

  function writeLegacyBlob(id, buf) { // 源:120-132
    const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    if (!existsSync(BLOB_DIR)) mkdirSync(BLOB_DIR, { recursive: true });
    deleteThumbnail(id);
    const target = legacyBlobPath(id);
    const temp = target + "." + process.pid + "." + String(idFactory()).slice(0, 8) + ".tmp";
    try {
      writeFileSync(temp, data);
      renameSync(temp, target);
    } catch (error) {
      try { if (existsSync(temp)) unlinkSync(temp); } catch (cleanupError) { /* 源: ignore cleanup failure */ }
      throw error;
    }
  }

  function clearContentBlobReference(id) { // 源:133-139
    const list = load();
    const node = list.find((item) => item.id === id);
    if (!node || !node.blobSha256) return;
    delete node.blobSha256;
    persist(list);
  }

  function saveBlob(id, buf) { // 源:140-143
    writeLegacyBlob(id, buf);
    clearContentBlobReference(id);
  }

  function adoptBlobFile(id, sourcePath) { // 源:144-156
    if (!existsSync(BLOB_DIR)) mkdirSync(BLOB_DIR, { recursive: true });
    deleteThumbnail(id);
    const target = legacyBlobPath(id);
    try {
      renameSync(sourcePath, target);
    } catch (error) {
      if (error.code !== "EXDEV") throw error;
      copyFileSync(sourcePath, target);
      unlinkSync(sourcePath);
    }
    clearContentBlobReference(id);
  }

  function readBlob(id) { // 源:157-159
    return hasBlob(id) ? readFileSync(blobPath(id)) : null;
  }

  function deleteBlob(id) { // 源:160-168
    deleteThumbnail(id);
    try {
      const legacy = legacyBlobPath(id);
      if (existsSync(legacy)) unlinkSync(legacy);
    } catch (error) { /* 源: ignore */ }
  }

  // ── 磁盘真源与乐观锁（源 fs.ts:174-301）───────────────────────────────
  function seed() { // 源:174-181
    const t = now();
    const docId = idFactory();
    return [
      { id: docId, name: "文稿", type: "folder", parentId: null, created_ts: t, updated_ts: t },
      { id: idFactory(), name: "便签.txt", type: "file", parentId: null, content: "欢迎使用 DX OS 文件。\n右键桌面可以新建文件夹或文件。", created_ts: t, updated_ts: t },
    ];
  }

  function diskStateSignature() { // 源:186-190
    if (!existsSync(FILE)) return "missing";
    const stat = statSync(FILE);
    return stat.size + ":" + stat.mtimeMs + ":" + stat.ctimeMs + ":" + stat.ino;
  }

  function readDiskState() { // 源:192-202
    if (!existsSync(FILE)) return { format: FS_FORMAT, revision: 0, nodes: [] };
    const parsed = JSON.parse(readFileSync(FILE, "utf-8"));
    if (Array.isArray(parsed)) return { format: FS_FORMAT, revision: 0, nodes: parsed };
    if (!parsed || typeof parsed !== "object") throw new Error("fs.json 已损坏：根结构无效");
    const state = parsed;
    if (state.format !== FS_FORMAT || !Number.isSafeInteger(state.revision) || Number(state.revision) < 0 || !Array.isArray(state.nodes)) {
      throw new Error("fs.json 已损坏：版本或节点结构无效");
    }
    const result = { format: FS_FORMAT, revision: Number(state.revision), nodes: state.nodes };
    if ("lastCommitId" in state && typeof state.lastCommitId === "string") result.lastCommitId = state.lastCommitId;
    return result;
  }

  function readOnlyDiskState() { // 源:204-215
    const before = diskStateSignature();
    if (readOnlyDiskCache && readOnlyDiskCache.signature === before) return readOnlyDiskCache.state;
    let state = readDiskState();
    let after = diskStateSignature();
    if (before !== after) {
      state = readDiskState();
      after = diskStateSignature();
    }
    readOnlyDiskCache = { signature: after, state: state };
    return state;
  }

  function load() { // 源:217-230
    try {
      if (!existsSync(FILE)) {
        const s = seed();
        persist(s, 0);
        return s;
      }
      const state = readDiskState();
      revisionByList.set(state.nodes, state.revision);
      return state.nodes;
    } catch (error) {
      throw new Error("无法读取文件系统真源：" + (error instanceof Error ? error.message : String(error)));
    }
  }

  function waitForFsLock() { // 源:232-248
    const deadline = Date.now() + 2000;
    while (true) {
      try {
        const fd = openSync(LOCK_FILE, "wx");
        writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8");
        return fd;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(LOCK_FILE).mtimeMs > 30000) unlinkSync(LOCK_FILE);
        } catch (statError) { /* 源: another process released or recovered the lock */ }
        if (Date.now() >= deadline) throw fsError("文件系统正被其他进程修改，请重试", 409, "FS_LOCK_TIMEOUT");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  }

  function releaseFsLock(fd) { // 源:250-254
    try { closeSync(fd); } finally {
      try { if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE); } catch (error) { /* 源: best effort */ }
    }
  }

  function writeDiskState(state) { // 源:256-273
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const temp = FILE + "." + process.pid + "." + String(idFactory()).slice(0, 8) + ".tmp";
    let fd;
    try {
      fd = openSync(temp, "wx");
      writeFileSync(fd, JSON.stringify(state, null, 2), "utf-8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, FILE);
      readOnlyDiskCache = null;
    } catch (error) {
      try { if (fd !== undefined) closeSync(fd); } catch (cleanupError) { /* 源: ignore cleanup failure */ }
      try { if (existsSync(temp)) unlinkSync(temp); } catch (cleanupError) { /* 源: ignore cleanup failure */ }
      throw error;
    }
  }

  function persist(list, explicitExpectedRevision) { // 源:275-292
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const expectedRevision = explicitExpectedRevision == null ? revisionByList.get(list) : explicitExpectedRevision;
    const lock = waitForFsLock();
    try {
      const current = readDiskState();
      const expected = expectedRevision == null ? current.revision : expectedRevision;
      if (current.revision !== expected) {
        throw fsError("文件系统版本冲突：期望 " + expected + "，当前 " + current.revision, 409, "FS_REVISION_CONFLICT");
      }
      // 源注释：普通写会关闭上一 Journal 的可恢复发布标记。
      const next = { format: FS_FORMAT, revision: current.revision + 1, nodes: list };
      writeDiskState(next);
      revisionByList.set(list, next.revision);
    } finally {
      releaseFsLock(lock);
    }
  }

  function getFsRevision() { return readOnlyDiskState().revision; } // 源:294-296

  function getFsCommitState() { // 源:298-301
    const state = readOnlyDiskState();
    return { revision: state.revision, lastCommitId: state.lastCommitId };
  }

  // ── Artifact / Text 批量计划与发布（源 fs.ts:303-459）─────────────────
  function buildTextBatchTarget(baseNodes, rootId, upserts) { // 源:320-332
    const byId = new Map(baseNodes.map((node) => [node.id, Object.assign({}, node)]));
    for (const node of upserts) byId.set(node.id, Object.assign({}, node));
    const nodes = [...byId.values()];
    const root = nodes.find((node) => node.id === rootId && node.type === "folder" && !node.trashed);
    if (!root) throw new Error("文本批量计划的根目录不存在");
    for (const node of upserts) {
      if (node.parentId && !nodes.some((parent) => parent.id === node.parentId && parent.type === "folder" && !parent.trashed)) {
        throw new Error("文本批量计划包含无效父目录：" + node.name);
      }
    }
    return nodes;
  }

  function prepareFsArtifactBatchPlan(rootId, writes, fixed) { // 源:334-381
    const state = readDiskState();
    if (fixed && state.revision !== fixed.baseRevision) throw fsError("文件系统版本已离开 Journal 基线", 409, "FS_REVISION_CONFLICT");
    if (fixed) return Object.assign({}, fixed, { targetNodes: buildTextBatchTarget(state.nodes, fixed.rootId, fixed.upserts) });
    const nodes = state.nodes.map((node) => Object.assign({}, node));
    const root = nodes.find((node) => node.id === rootId && node.type === "folder" && !node.trashed);
    if (!root) throw new Error("文本批量计划的根目录不存在");
    const upserts = new Map();
    const resultNodeIds = {};
    const t = now();
    for (const write of writes) {
      const path = String(write.path || "").replace(/\\/g, "/").trim();
      const parts = path.split("/").filter(Boolean);
      const leaf = parts.pop();
      if (!leaf || path.startsWith("/") || /^[a-zA-Z]:/.test(path) || parts.some((part) => part === "." || part === "..")) throw new Error("无效的文本提交路径：" + path);
      let parentId = rootId;
      for (const raw of parts) {
        const name = cleanName(raw);
        if (!name || name !== raw) throw new Error("无效的目录名：" + raw);
        let folder = nodes.find((node) => node.parentId === parentId && node.name === name && !node.trashed);
        if (folder && folder.type !== "folder") throw new Error("路径被文件占用：" + raw);
        if (!folder) {
          folder = { id: idFactory(), name: name, type: "folder", parentId: parentId, ownerId: write.ownerId, created_ts: t, updated_ts: t };
          nodes.push(folder);
          upserts.set(folder.id, folder);
        }
        parentId = folder.id;
      }
      const name = cleanName(leaf);
      if (!name || name !== leaf) throw new Error("无效的文件名：" + leaf);
      const existing = nodes.find((node) => node.parentId === parentId && node.name === name && !node.trashed);
      if (existing && existing.type !== "file") throw new Error("路径被目录占用：" + path);
      const file = write.kind === "text"
        ? existing
          ? Object.assign({}, existing, { content: String(write.content == null ? "" : write.content), size: Buffer.byteLength(String(write.content == null ? "" : write.content), "utf8"), updated_ts: t })
          : { id: idFactory(), name: name, type: "file", parentId: parentId, ownerId: write.ownerId, content: String(write.content == null ? "" : write.content), size: Buffer.byteLength(String(write.content == null ? "" : write.content), "utf8"), created_ts: t, updated_ts: t }
        : existing
          ? Object.assign({}, existing, { mime: write.mime, size: write.bytes, blobSha256: write.blobSha256, updated_ts: t })
          : { id: idFactory(), name: name, type: "file", parentId: parentId, ownerId: write.ownerId, mime: write.mime, size: write.bytes, blobSha256: write.blobSha256, created_ts: t, updated_ts: t };
      if (write.kind === "text") delete file.blobSha256;
      else delete file.content;
      if (existing) nodes.splice(nodes.indexOf(existing), 1, file);
      else nodes.push(file);
      upserts.set(file.id, file);
      resultNodeIds[path] = file.id;
    }
    return { format: "dx-fs-artifact-plan/v2", baseRevision: state.revision, targetRevision: state.revision + 1, rootId: rootId, upserts: [...upserts.values()], targetNodes: nodes, resultNodeIds: resultNodeIds };
  }

  function prepareFsTextBatchPlan(rootId, writes, fixed) { // 源:383-385
    return prepareFsArtifactBatchPlan(rootId, writes.map((write) => Object.assign({}, write, { kind: "text" })), fixed);
  }

  function serializeFsTextBatchPlan(plan) { // 源:387-390
    const record = Object.assign({}, plan);
    delete record.targetNodes;
    return record;
  }

  function verifyPlanContentBlobs(plan) { // 源:394-404
    for (const node of plan.upserts) {
      if (!node.blobSha256) continue;
      const path = contentBlobPath(node.blobSha256);
      if (!existsSync(path)) throw fsError("Commit Journal Blob 缺失：" + node.blobSha256, undefined, "BLOB_MISSING");
      const data = readFileSync(path);
      if (createHash("sha256").update(data).digest("hex") !== node.blobSha256 || (typeof node.size === "number" && data.byteLength !== node.size)) {
        throw fsError("Commit Journal Blob 完整性校验失败：" + node.blobSha256, undefined, "BLOB_INVALID");
      }
    }
  }

  function verifyPublishedArtifactPlan(plan, current) { // 源:406-414
    for (const expected of plan.upserts) {
      const actual = current.nodes.find((node) => node.id === expected.id);
      if (!actual || actual.parentId !== expected.parentId || actual.name !== expected.name || actual.type !== expected.type
        || actual.content !== expected.content || actual.blobSha256 !== expected.blobSha256 || actual.mime !== expected.mime || actual.size !== expected.size) {
        throw fsError("已发布 Commit Journal 节点不匹配：" + expected.name, undefined, "FS_PUBLISHED_MISMATCH");
      }
    }
  }

  function publishFsTextBatchPlan(plan, commitId, afterPublish) { // 源:416-433
    const lock = waitForFsLock();
    try {
      verifyPlanContentBlobs(plan);
      const current = readDiskState();
      const alreadyPublished = Boolean(commitId && current.revision === plan.targetRevision && current.lastCommitId === commitId);
      if (alreadyPublished) verifyPublishedArtifactPlan(plan, current);
      else {
        if (current.revision !== plan.baseRevision) throw fsError("文件系统版本冲突：期望 " + plan.baseRevision + "，当前 " + current.revision, 409, "FS_REVISION_CONFLICT");
        writeDiskState(Object.assign({ format: FS_FORMAT, revision: plan.targetRevision, nodes: plan.targetNodes }, commitId ? { lastCommitId: commitId } : {}));
      }
      if (afterPublish) afterPublish();
    } finally {
      releaseFsLock(lock);
    }
    for (const id of Object.values(plan.resultNodeIds)) deleteBlob(id);
    return plan.resultNodeIds;
  }

  function collectOrphanContentBlobs(collectOptions) { // 源:437-459
    const o = collectOptions || {};
    const protectedHashes = new Set(o.protectedHashes || []);
    for (const node of readDiskState().nodes) if (node.blobSha256) protectedHashes.add(node.blobSha256);
    const root = join(BLOB_DIR, "sha256");
    const candidates = [];
    const deleted = [];
    const minAgeMs = Math.max(0, o.minAgeMs == null ? 24 * 60 * 60 * 1000 : o.minAgeMs);
    if (!existsSync(root)) return { candidates: candidates, deleted: deleted };
    for (const prefix of readdirSync(root, { withFileTypes: true })) {
      if (!prefix.isDirectory()) continue;
      const dir = join(root, prefix.name);
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !BLOB_SHA256_RE.test(entry.name) || protectedHashes.has(entry.name)) continue;
        const path = join(dir, entry.name);
        if (Date.now() - statSync(path).mtimeMs < minAgeMs) continue;
        candidates.push(entry.name);
        if (!o.dryRun) {
          try { unlinkSync(path); deleted.push(entry.name); } catch (error) { /* 源: next GC pass retries */ }
        }
      }
    }
    return { candidates: candidates, deleted: deleted };
  }

  // ── 节点树（源 fs.ts:461-703）─────────────────────────────────────────
  function sortNodes(nodes) { // 源:461-466
    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name, "zh");
    });
  }

  function uniqueName(list, parentId, name) { // 源:469-478
    const siblings = new Set(list.filter((n) => n.parentId === parentId && !n.trashed).map((n) => n.name));
    if (!siblings.has(name)) return name;
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let i = 2;
    while (siblings.has(base + " (" + i + ")" + ext)) i++;
    return base + " (" + i + ")" + ext;
  }

  function cleanName(name) { // 源:481-483
    return String(name || "").replace(/[\/\\:*?"<>|]/g, "").trim().slice(0, 80);
  }

  function listChildren(parentId) { // 源:485-500
    const list = load();
    const nodes = sortNodes(list.filter((n) => n.parentId === parentId && !n.trashed));
    let hasSystemRoot = false;
    let cur = parentId ? list.find((n) => n.id === parentId) : null;
    const chain = [];
    const guard = new Set();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      if (isSystemDirectory(cur)) hasSystemRoot = true;
      else chain.unshift({ id: cur.id, name: cur.name });
      cur = cur.parentId ? list.find((n) => n.id === cur.parentId) || null : null;
    }
    return { nodes: nodes, path: hasSystemRoot ? chain : [{ id: null, name: "桌面" }].concat(chain) };
  }

  function getNode(id) { // 源:502-505
    const node = readOnlyDiskState().nodes.find((item) => item.id === id);
    return node ? Object.assign({}, node) : null;
  }

  function readNodeNameSnapshot() { // 源:508-515
    const names = new Map();
    for (const node of readOnlyDiskState().nodes) {
      if (!names.has(node.id)) names.set(node.id, node.name);
    }
    return names;
  }

  function readNodeHierarchySnapshot() { // 源:518-537
    const nodes = new Map();
    for (const node of readOnlyDiskState().nodes) {
      if (!nodes.has(node.id)) nodes.set(node.id, { id: node.id, parentId: node.parentId, trashed: node.trashed });
    }
    function ancestorMatches(id, matches) {
      const seen = new Set();
      let node = nodes.get(id);
      while (node && !seen.has(node.id)) {
        if (matches(node)) return true;
        seen.add(node.id);
        node = node.parentId ? nodes.get(node.parentId) : undefined;
      }
      return false;
    }
    return {
      isInTrash: (id) => ancestorMatches(id, (node) => !!node.trashed),
      isWithinRoot: (rootId, id) => ancestorMatches(id, (node) => node.id === rootId),
    };
  }

  function isInTrash(id) { // 源:539-549
    const list = readOnlyDiskState().nodes;
    let current = list.find((node) => node.id === id);
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      if (current.trashed) return true;
      seen.add(current.id);
      current = current.parentId ? list.find((node) => node.id === current.parentId) : undefined;
    }
    return false;
  }

  function createNode(input) { // 源:551-603
    const list = load();
    const parentId = input.parentId == null ? null : input.parentId;
    const parent = parentId ? list.find((n) => n.id === parentId && n.type === "folder") : undefined;
    if (parentId && !parent) throw new Error("父目录不存在");
    if (parentId && isInTrash(parentId)) throw new Error("父目录已在废纸篓中");
    const inShareZone = (() => {
      let p = parent;
      while (p) {
        if (p.share) return true;
        p = p.parentId ? list.find((n) => n.id === p.parentId) : undefined;
      }
      return false;
    })();
    if (!inShareZone && parent && parent.ownerId && input.ownerId && parent.ownerId !== input.ownerId) throw new Error("不能在其他用户的文件夹中创建内容");
    const type = input.type === "file" ? "file" : "folder";
    const rawName = cleanName(input.name || "") || (type === "folder" ? "未命名文件夹" : "未命名文件.txt");
    const name = uniqueName(list, parentId, rawName);
    const t = now();
    const isUpload = input.mime !== undefined || input.size !== undefined;
    const node = { id: idFactory(), name: name, type: type, parentId: parentId };
    // 源:589-590：共享区内 ownerId 只记录创建者本人；私人区继承父目录所有者。
    if (input.ownerId || (!inShareZone && parent && parent.ownerId)) node.ownerId = input.ownerId || parent.ownerId;
    if (input.share) node.share = input.share;
    if (input.system) node.system = true;
    if (type === "file" && !isUpload) node.content = input.content == null ? "" : input.content;
    if (input.mime !== undefined) node.mime = input.mime;
    if (input.size !== undefined) node.size = input.size;
    node.created_ts = t;
    node.updated_ts = t;
    list.push(node);
    persist(list);
    return node;
  }

  function upsertCloudCanvasFile(input) { // 源:606-635（纯本地，无网络）
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id)) throw new Error("云端素材 ID 无效");
    const list = load();
    const project = list.find((node) => node.id === input.projectId && node.type === "folder" && !node.trashed);
    if (!project || project.ownerId !== input.ownerId) throw new Error("只能向自己的画布项目导入云端素材");
    const existing = list.find((node) => node.id === input.id);
    if (existing && !isWithinRoot(input.projectId, existing.id)) throw new Error("云端素材 ID 与其他项目冲突");
    const t = now();
    let node;
    if (existing) {
      if (existing.type !== "file") throw new Error("云端素材 ID 与文件夹冲突");
      node = Object.assign({}, existing, { name: cleanName(input.name) || existing.name, parentId: input.projectId, ownerId: input.ownerId, mime: input.mime || "application/octet-stream", size: input.content.byteLength, trashed: false, updated_ts: t });
      delete node.content;
      delete node.trashedTs;
      list.splice(list.indexOf(existing), 1, node);
    } else {
      node = { id: input.id, name: uniqueName(list, input.projectId, cleanName(input.name) || "云端素材"), type: "file", parentId: input.projectId, ownerId: input.ownerId, mime: input.mime || "application/octet-stream", size: input.content.byteLength, created_ts: t, updated_ts: t };
      list.push(node);
    }
    persist(list);
    saveBlob(node.id, input.content);
    return node;
  }

  /** 源 fs.ts:642-660 + 【相对路径硬化】文件头说明。 */
  function assertSafeRelativePath(relPath) {
    const normalized = String(relPath || "").replace(/\\/g, "/");
    if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) throw fsError("路径必须是虚拟树内的相对路径：" + relPath, 400, "FS_PATH_ESCAPE");
    const parts = normalized.split("/");
    if (parts.some((part) => part.trim() === "." || part.trim() === "..")) throw fsError("路径不得包含 . 或 .. 段：" + relPath, 400, "FS_PATH_ESCAPE");
    return normalized;
  }

  function resolvePath(rootId, relPath, createDirs) { // 源:642-660
    const normalized = assertSafeRelativePath(relPath);
    const parts = normalized.split("/").map((s) => s.trim()).filter(Boolean);
    const leaf = parts.pop() || "";
    let pid = rootId;
    for (const seg of parts) {
      const list = load();
      let folder = list.find((n) => n.parentId === pid && n.type === "folder" && n.name === seg && !n.trashed);
      if (!folder) {
        if (!createDirs) throw new Error("路径不存在：" + seg);
        folder = createNode({ name: seg, type: "folder", parentId: pid });
      }
      pid = folder.id;
    }
    return { parentId: pid, leaf: leaf };
  }

  function findByPath(rootId, relPath) { // 源:663-670
    try {
      const resolved = resolvePath(rootId, relPath, false);
      return load().find((n) => n.parentId === resolved.parentId && n.name === resolved.leaf && !n.trashed) || null;
    } catch (error) {
      return null;
    }
  }

  function isWithinRoot(rootId, nodeId) { // 源:672-682
    const list = readOnlyDiskState().nodes;
    let current = list.find((node) => node.id === nodeId);
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      if (current.id === rootId) return true;
      seen.add(current.id);
      current = current.parentId ? list.find((node) => node.id === current.parentId) : undefined;
    }
    return false;
  }

  function ensureFolder(name, parentId, ownerId) { // 源:685-691（返回文件夹 id 字符串）
    const list = load();
    const clean = cleanName(name) || "未命名文件夹";
    const found = list.find((n) => n.parentId === (parentId == null ? null : parentId) && n.type === "folder" && n.name === clean && !n.trashed);
    if (found) return found.id;
    return createNode({ name: clean, type: "folder", parentId: parentId == null ? null : parentId, ownerId: ownerId }).id;
  }

  function isSystemDirectory(node) { // 源:693-695
    return node.type === "folder" && node.system === true && node.name === SYSTEM_ROOT_NAME;
  }

  function ensureSystemRoot() { // 源:698-703
    const list = load();
    const existing = list.find((n) => n.parentId === null && isSystemDirectory(n) && !n.trashed);
    if (existing) return existing;
    return createNode({ name: SYSTEM_ROOT_NAME, type: "folder", parentId: null, system: true });
  }

  function moveFolderToSystemRoot(node, systemRootId) { // 源:705-714
    if (node.parentId === systemRootId) return node;
    const list = load();
    const current = list.find((n) => n.id === node.id);
    if (!current) return node;
    current.parentId = systemRootId;
    current.updated_ts = now();
    persist(list);
    return current;
  }

  function userFolderBaseName(name) { return name.replace(/ \(\d+\)$/, ""); } // 源:723-725

  function consolidateUserFolders(name, ownerId, systemRootId) { // 源:733-766
    const aliases = USER_FOLDER_ALIASES[name] || [name];
    const list = load();
    const matches = list.filter((node) =>
      node.type === "folder"
      && node.ownerId === ownerId
      && !node.trashed
      && aliases.includes(userFolderBaseName(node.name)));
    if (!matches.length) return null;
    const preferredNames = name === "项目" ? ["项目", "画布"] : [name];
    matches.sort((a, b) => {
      const ai = preferredNames.indexOf(a.name);
      const bi = preferredNames.indexOf(b.name);
      if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      return a.created_ts - b.created_ts || a.id.localeCompare(b.id);
    });
    const keeper = matches[0];
    const duplicateIds = new Set(matches.slice(1).map((node) => node.id));
    if (!duplicateIds.size && keeper.name === name && keeper.parentId === systemRootId) return keeper;
    keeper.name = name;
    keeper.parentId = systemRootId;
    keeper.updated_ts = now();
    for (const node of list) {
      if (!node.parentId || !duplicateIds.has(node.parentId)) continue;
      node.parentId = keeper.id;
      node.name = uniqueName(list.filter((item) => item.id !== node.id && !duplicateIds.has(item.id)), keeper.id, node.name);
      node.updated_ts = now();
    }
    const consolidated = list.filter((node) => !duplicateIds.has(node.id));
    persist(consolidated, revisionByList.get(list));
    return consolidated.find((node) => node.id === keeper.id) || keeper;
  }

  function ensureUserFolder(name, ownerId) { // 源:769-777
    const clean = cleanName(name) || "未命名文件夹";
    const systemRoot = ensureSystemRoot();
    const found = consolidateUserFolders(clean, ownerId, systemRoot.id);
    if (found) return found;
    createNode({ name: clean, type: "folder", parentId: systemRoot.id, ownerId: ownerId });
    return consolidateUserFolders(clean, ownerId, systemRoot.id);
  }

  function ensureCanvasRoot(ownerId) { return ensureUserFolder("项目", ownerId); } // 源:780-782

  function createCanvasProjectFolder(ownerId, title) { // 源:785-789
    const root = ensureCanvasRoot(ownerId);
    const canvasRoot = ensureFolder("无限画布", root.id, ownerId);
    return createNode({ name: title || "未命名项目", type: "folder", parentId: canvasRoot, ownerId: ownerId });
  }

  function renameNode(id, name) { // 源:791-805
    const list = load();
    const node = list.find((n) => n.id === id);
    if (!node) throw new Error("节点不存在");
    const clean = cleanName(name);
    if (!clean) throw new Error("名称不能为空");
    node.name = uniqueName(list.filter((n) => n.id !== id), node.parentId, clean);
    node.updated_ts = now();
    persist(list);
    return node;
  }

  function setContent(id, content) { // 源:807-820
    const list = load();
    const node = list.find((n) => n.id === id);
    if (!node) throw new Error("节点不存在");
    if (node.type !== "file") throw new Error("只能编辑文件内容");
    node.content = String(content == null ? "" : content);
    delete node.blobSha256;
    node.size = Buffer.byteLength(node.content, "utf8");
    deleteBlob(id);
    node.updated_ts = now();
    persist(list);
    return node;
  }

  function setBinaryContent(id, content, mime) { // 源:822-835
    const list = load();
    const node = list.find((n) => n.id === id);
    if (!node) throw new Error("节点不存在");
    if (node.type !== "file") throw new Error("只能写入文件内容");
    delete node.content;
    delete node.blobSha256;
    node.mime = String(mime || "application/octet-stream").slice(0, 160);
    node.size = content.byteLength;
    node.updated_ts = now();
    writeLegacyBlob(id, content);
    persist(list);
    return node;
  }

  function claimOwnerlessNodes(ownerId) { // 源:838-844
    const list = load();
    let count = 0;
    for (const node of list) if (!node.ownerId && !node.share && !node.system) { node.ownerId = ownerId; count++; }
    if (count) persist(list);
    return count;
  }

  // ── 共享区：公共盘 / 部门盘（源 fs.ts:846-926）────────────────────────
  function ensurePublicRoot() { // 源:850-856
    const systemRoot = ensureSystemRoot();
    const list = load();
    const existing = list.find((n) => n.share === "public" && !n.trashed);
    if (existing) return moveFolderToSystemRoot(existing, systemRoot.id);
    return createNode({ name: "公共文件", type: "folder", parentId: systemRoot.id, share: "public", system: true });
  }

  function ensureDepartmentRoot(departmentId, departmentName) { // 源:858-865
    const share = "department:" + departmentId;
    const systemRoot = ensureSystemRoot();
    const list = load();
    const existing = list.find((n) => n.share === share && !n.trashed);
    if (existing) return moveFolderToSystemRoot(existing, systemRoot.id);
    return createNode({ name: (departmentName || "部门") + "（部门）", type: "folder", parentId: systemRoot.id, share: share, system: true });
  }

  function shareZoneOf(id) { // 源:868-876
    const list = readOnlyDiskState().nodes;
    let node = list.find((n) => n.id === id) || null;
    while (node) {
      if (node.share) return node.share;
      node = node.parentId ? list.find((n) => n.id === node.parentId) || null : null;
    }
    return null;
  }

  function setCanvasFolderShare(id, canvasId, shared) { // 源:879-894
    const list = load();
    const node = list.find((item) => item.id === id && item.type === "folder");
    if (!node) throw new Error("项目文件夹不存在");
    const marker = "canvas:" + canvasId;
    let changed = false;
    if (shared) {
      if (node.share && node.share !== marker) throw new Error("项目文件夹已属于其他共享区");
      if (node.share !== marker) { node.share = marker; changed = true; }
    } else if (node.share === marker) {
      delete node.share;
      changed = true;
    }
    if (changed) { node.updated_ts = now(); persist(list); }
    return node;
  }

  function setAssetLibraryFolderShare(id, libraryId, shared) { // 源:897-912
    const list = load();
    const node = list.find((item) => item.id === id && item.type === "folder");
    if (!node) throw new Error("资产库文件夹不存在");
    const marker = "asset-library:" + libraryId;
    let changed = false;
    if (shared) {
      if (node.share && node.share !== marker) throw new Error("资产库文件夹已属于其他共享区");
      if (node.share !== marker) { node.share = marker; changed = true; }
    } else if (node.share === marker) {
      delete node.share;
      changed = true;
    }
    if (changed) { node.updated_ts = now(); persist(list); }
    return node;
  }

  function renameShareRoot(share, name) { // 源:915-919
    const list = load();
    const root = list.find((n) => n.share === share && !n.trashed);
    if (root) { root.name = uniqueName(list.filter((n) => n.id !== root.id), null, cleanName(name) || root.name); root.updated_ts = now(); persist(list); }
  }

  function removeShareRoot(share) { // 源:922-926
    const list = load();
    const root = list.find((n) => n.share === share && !n.trashed);
    if (root) { root.system = false; removeNode(root.id); }
  }

  function claimNodeOwner(id, ownerId) { // 源:929-945
    const list = load();
    const root = list.find((node) => node.id === id);
    if (!root) throw new Error("节点不存在");
    const ids = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of list) if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) { ids.add(node.id); changed = true; }
    }
    for (const node of list) {
      if (ids.has(node.id) && node.ownerId && node.ownerId !== ownerId) throw new Error("目录包含其他用户的内容，不能认领");
    }
    for (const node of list) if (ids.has(node.id)) node.ownerId = ownerId;
    persist(list);
    return ids.size;
  }

  function moveNode(id, parentId) { // 源:947-965
    const list = load();
    const node = list.find((n) => n.id === id);
    if (!node) throw new Error("节点不存在");
    if (isInTrash(id)) throw new Error("节点已在废纸篓中");
    if (parentId && isInTrash(parentId)) throw new Error("目标目录已在废纸篓中");
    if (id === parentId) throw new Error("不能移动到自身");
    let p = parentId ? list.find((n) => n.id === parentId) : null;
    while (p) {
      if (p.id === id) throw new Error("不能移动到自己的子目录");
      p = p.parentId ? list.find((n) => n.id === p.parentId) || null : null;
    }
    node.parentId = parentId;
    node.name = uniqueName(list.filter((n) => n.id !== id), parentId, node.name);
    node.updated_ts = now();
    persist(list);
    return node;
  }

  function copyNode(id, targetParentId) { // 源:968-1012
    const list = load();
    const src = list.find((n) => n.id === id);
    if (!src) throw new Error("节点不存在");
    if (isInTrash(id)) throw new Error("节点已在废纸篓中");
    if (targetParentId && isInTrash(targetParentId)) throw new Error("目标目录已在废纸篓中");
    if (targetParentId && !list.find((n) => n.id === targetParentId && n.type === "folder")) {
      throw new Error("目标目录不存在");
    }
    if (src.type === "folder") {
      let p = targetParentId ? list.find((n) => n.id === targetParentId) : null;
      while (p) {
        if (p.id === src.id) throw new Error("不能复制到自己的子目录");
        p = p.parentId ? list.find((x) => x.id === p.parentId) || null : null;
      }
    }
    const t = now();
    const additions = [];
    const clone = (node, parentId) => {
      const name = uniqueName([...list, ...additions], parentId, node.name);
      const copy = { id: idFactory(), name: name, type: node.type, parentId: parentId };
      if (node.ownerId !== undefined) copy.ownerId = node.ownerId;
      if (node.type === "file" && node.content !== undefined) copy.content = node.content;
      if (node.mime !== undefined) copy.mime = node.mime;
      if (node.size !== undefined) copy.size = node.size;
      if (node.blobSha256 !== undefined) copy.blobSha256 = node.blobSha256;
      copy.created_ts = t;
      copy.updated_ts = t;
      additions.push(copy);
      if (node.type === "file" && !node.blobSha256 && hasBlob(node.id)) writeLegacyBlob(copy.id, readFileSync(blobPath(node.id)));
      if (node.type === "folder") {
        for (const child of list.filter((c) => c.parentId === node.id)) clone(child, copy.id);
      }
      return copy;
    };
    const root = clone(src, targetParentId == null ? null : targetParentId);
    persist([...list, ...additions], revisionByList.get(list));
    return root;
  }

  function removeNode(id) { // 源:1015-1023（软删：只标记被删的根节点）
    const list = load();
    const node = list.find((n) => n.id === id);
    if (!node) return 0;
    node.trashed = true;
    node.trashedTs = now();
    persist(list);
    return 1;
  }

  function purgeNode(id) { // 源:1026-1044
    const list = load();
    const toDelete = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of list) {
        if (n.parentId && toDelete.has(n.parentId) && !toDelete.has(n.id)) {
          toDelete.add(n.id);
          changed = true;
        }
      }
    }
    for (const n of list) {
      if (toDelete.has(n.id) && n.type === "file") deleteBlob(n.id);
    }
    persist(list.filter((n) => !toDelete.has(n.id)), revisionByList.get(list));
    return toDelete.size;
  }

  function listTrash() { // 源:1057-1075
    const list = load();
    const byId = new Map(list.map((n) => [n.id, n]));
    const pathOf = (n) => {
      const segs = [];
      let cur = n.parentId ? byId.get(n.parentId) : undefined;
      const guard = new Set();
      while (cur && !guard.has(cur.id)) {
        guard.add(cur.id);
        segs.unshift(cur.name);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      return segs.join("/") || "桌面";
    };
    return list
      .filter((n) => n.trashed)
      .sort((a, b) => (b.trashedTs || 0) - (a.trashedTs || 0))
      .map((n) => ({ id: n.id, name: n.name, type: n.type, origPath: pathOf(n), trashedTs: n.trashedTs || 0, size: n.size, mime: n.mime }));
  }

  function restoreNode(id) { // 源:1078-1091
    const list = load();
    const node = list.find((n) => n.id === id);
    if (!node || !node.trashed) return null;
    const parent = node.parentId ? list.find((n) => n.id === node.parentId) : null;
    if (node.parentId && (!parent || parent.trashed)) node.parentId = null;
    node.name = uniqueName(list.filter((n) => n.id !== id), node.parentId, node.name);
    node.trashed = false;
    delete node.trashedTs;
    node.updated_ts = now();
    persist(list);
    return node;
  }

  function emptyTrash() { // 源:1094-1098
    let count = 0;
    for (const t of listTrash()) count += purgeNode(t.id);
    return count;
  }

  // ── 统计 / 搜索 / 快照 / 打包（源 fs.ts:1100-1451）────────────────────
  function fileBytes(node) { // 源:1100-1112
    if (node.type !== "file") return 0;
    if (typeof node.size === "number") return Math.max(0, node.size);
    if (node.content !== undefined) return Buffer.byteLength(node.content, "utf8");
    if (hasBlob(node.id)) {
      try {
        return readFileSync(blobPath(node.id)).byteLength;
      } catch (error) {
        return 0;
      }
    }
    return 0;
  }

  function programFor(node) { // 源:1114-1125
    const mime = (node.mime || "").toLowerCase();
    const ext = (node.name.split(".").pop() || "").toLowerCase();
    if (mime.startsWith("image/")) return "相册";
    if (mime.startsWith("video/")) return "视频";
    if (mime.startsWith("audio/")) return "音乐";
    if (ext === "md" || ext === "markdown" || mime.startsWith("text/") || ["txt", "json", "log", "js", "ts", "css", "html", "xml", "yaml", "yml", "csv"].includes(ext)) return "文本编辑器";
    if (mime.includes("word") || ["doc", "docx"].includes(ext)) return "文稿";
    if (mime.includes("spreadsheet") || mime.includes("excel") || ["xls", "xlsx"].includes(ext)) return "表格";
    if (mime === "application/pdf" || ext === "pdf") return "PDF";
    return "文件";
  }

  function subtreeSize(list, rootId) { // 源:1127-1140
    const ids = new Set([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of list) {
        if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
          ids.add(node.id);
          changed = true;
        }
      }
    }
    return list.reduce((sum, node) => (ids.has(node.id) ? sum + fileBytes(node) : sum), 0);
  }

  function subtreeByteSize(rootId) { return subtreeSize(load(), rootId); } // 源:1142-1144

  function storageReport(userNames) { // 源:1163-1202
    const names = userNames || {};
    const list = load();
    const files = list.filter((node) => node.type === "file");
    const totalBytes = files.reduce((sum, node) => sum + fileBytes(node), 0);
    const byOwner = new Map();
    const byProgram = new Map();
    for (const node of files) {
      const bytes = fileBytes(node);
      const ownerKey = node.ownerId || "unowned";
      const ownerName = node.ownerId ? names[node.ownerId] || "未知账户" : "未归属";
      const owner = byOwner.get(ownerKey) || { id: ownerKey, name: ownerName, bytes: 0, count: 0 };
      owner.bytes += bytes;
      owner.count += 1;
      byOwner.set(ownerKey, owner);
      const programName = programFor(node);
      const program = byProgram.get(programName) || { id: programName, name: programName, bytes: 0, count: 0 };
      program.bytes += bytes;
      program.count += 1;
      byProgram.set(programName, program);
    }
    const rootItems = list
      .filter((node) => node.parentId === null && !node.trashed)
      .map((node) => ({
        id: node.id,
        name: node.name,
        type: node.type,
        ownerId: node.ownerId || null,
        ownerName: node.ownerId ? names[node.ownerId] || "未知账户" : node.share ? "共享区" : "未归属",
        program: node.type === "file" ? programFor(node) : node.share ? "共享区" : "文件夹",
        bytes: subtreeSize(list, node.id),
        deletable: !node.system,
      }))
      .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name, "zh"));
    return {
      totalBytes: totalBytes,
      byOwner: [...byOwner.values()].sort((a, b) => b.bytes - a.bytes),
      byProgram: [...byProgram.values()].sort((a, b) => b.bytes - a.bytes),
      rootItems: rootItems,
    };
  }

  function storageChildren(parentId, userNames) { // 源:1208-1234
    const names = userNames || {};
    const list = load();
    const items = list
      .filter((node) => node.parentId === parentId && !node.trashed)
      .map((node) => ({
        id: node.id,
        name: node.name,
        type: node.type,
        ownerId: node.ownerId || null,
        ownerName: node.ownerId ? names[node.ownerId] || "未知账户" : node.share ? "共享区" : "未归属",
        program: node.type === "file" ? programFor(node) : node.share ? "共享区" : "文件夹",
        bytes: node.type === "folder" ? subtreeSize(list, node.id) : fileBytes(node),
        deletable: !node.system,
      }))
      .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name, "zh"));
    const path = [{ id: null, name: "桌面" }];
    const chain = [];
    let cur = list.find((n) => n.id === parentId) || null;
    const guard = new Set();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      chain.unshift({ id: cur.id, name: cur.name });
      cur = cur.parentId ? list.find((n) => n.id === cur.parentId) || null : null;
    }
    return { path: [...path, ...chain], items: items };
  }

  function isTextual(node) { // 源:1238-1242
    const mime = (node.mime || "").toLowerCase();
    const ext = (node.name.split(".").pop() || "").toLowerCase();
    return node.content !== undefined || mime.startsWith("text/") || TEXTUAL_EXT.includes(ext);
  }

  function nodeText(node) { // 源:1243-1253
    if (node.content !== undefined) return node.content;
    if (isTextual(node) && hasBlob(node.id)) {
      try {
        return readFileSync(blobPath(node.id)).toString("utf8");
      } catch (error) {
        return null;
      }
    }
    return null;
  }

  function searchNodes(rootId, query, searchOptions) { // 源:1264-1313
    const o = searchOptions || {};
    const q = String(query || "").trim().toLowerCase();
    if (!q) return [];
    const byName = o.name !== false;
    const byContent = o.content !== false;
    const limit = Math.max(1, Math.min(200, o.limit || 50));
    const list = load();
    const byId = new Map(list.map((n) => [n.id, n]));
    const pathOf = (n) => {
      const segs = [];
      let cur = n;
      while (cur && cur.id !== rootId) {
        segs.unshift(cur.name);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      return segs.join("/");
    };
    const scope = [];
    const collect = (pid) => {
      for (const n of list) {
        if (n.parentId === pid && !n.trashed) {
          scope.push(n);
          if (n.type === "folder") collect(n.id);
        }
      }
    };
    collect(rootId);
    const out = [];
    for (const n of scope) {
      if (out.length >= limit) break;
      if (byName && n.name.toLowerCase().includes(q)) {
        out.push({ id: n.id, name: n.name, type: n.type, path: pathOf(n) });
        continue;
      }
      if (byContent && n.type === "file") {
        const text = nodeText(n);
        if (text && text.toLowerCase().includes(q)) {
          const i = text.toLowerCase().indexOf(q);
          const snippet = text.slice(Math.max(0, i - 30), i + q.length + 40).replace(/\s+/g, " ").trim();
          out.push({ id: n.id, name: n.name, type: n.type, path: pathOf(n), snippet: snippet });
        }
      }
    }
    return out;
  }

  function snapshotSubtree(rootId) { // 源:1330-1351
    const list = load();
    if (!list.some((node) => node.id === rootId && node.type === "folder")) throw new Error("快照根目录不存在");
    const ids = new Set();
    let parents = new Set([rootId]);
    while (parents.size) {
      const next = new Set();
      for (const node of list) {
        if (node.parentId && parents.has(node.parentId) && !ids.has(node.id)) {
          ids.add(node.id);
          if (node.type === "folder") next.add(node.id);
        }
      }
      parents = next;
    }
    const nodes = list.filter((node) => ids.has(node.id)).map((node) => Object.assign({}, node));
    const blobs = {};
    for (const node of nodes) {
      if (node.type === "file" && hasBlob(node.id)) blobs[node.id] = readFileSync(blobPath(node.id)).toString("base64");
    }
    return { format: "dx-fs-subtree/v1", rootId: rootId, createdAt: Number(clock()), nodes: nodes, blobs: blobs };
  }

  function restoreSubtreeSnapshot(rootId, snapshot) { // 源:1354-1380
    if (!snapshot || snapshot.format !== "dx-fs-subtree/v1" || snapshot.rootId !== rootId || !Array.isArray(snapshot.nodes)) throw new Error("项目快照无效");
    const list = load();
    if (!list.some((node) => node.id === rootId && node.type === "folder")) throw new Error("恢复根目录不存在");
    const removed = new Set();
    let parents = new Set([rootId]);
    while (parents.size) {
      const next = new Set();
      for (const node of list) {
        if (node.parentId && parents.has(node.parentId) && !removed.has(node.id)) {
          removed.add(node.id);
          if (node.type === "folder") next.add(node.id);
        }
      }
      parents = next;
    }
    for (const id of removed) deleteBlob(id);
    const preserved = list.filter((node) => !removed.has(node.id));
    const preservedIds = new Set(preserved.map((node) => node.id));
    const snapshotIds = new Set(snapshot.nodes.map((node) => node.id));
    if (snapshot.nodes.some((node) => preservedIds.has(node.id) || (node.parentId !== rootId && (!node.parentId || !snapshotIds.has(node.parentId))))) throw new Error("项目快照节点关系无效");
    persist([...preserved, ...snapshot.nodes.map((node) => Object.assign({}, node))], revisionByList.get(list));
    for (const [id, base64] of Object.entries(snapshot.blobs || {})) {
      if (snapshotIds.has(id)) saveBlob(id, Buffer.from(base64, "base64"));
    }
    return snapshot.nodes.length;
  }

  function subtree(rootId, maxDepth) { // 源:1383-1395
    const depthLimit = maxDepth == null ? 5 : maxDepth;
    const list = load();
    const out = [];
    const rec = (pid, depth) => {
      if (depth > depthLimit) return;
      for (const k of sortNodes(list.filter((n) => n.parentId === pid && !n.trashed))) {
        out.push({ name: k.name, type: k.type, depth: depth });
        if (k.type === "folder") rec(k.id, depth + 1);
      }
    };
    rec(rootId, 0);
    return out;
  }

  function collectZipEntries(ids) { // 源:1398-1434
    const list = load();
    const byId = new Map(list.map((n) => [n.id, n]));
    const out = [];
    const usedTop = new Set();
    const uniqTop = (name) => {
      if (!usedTop.has(name)) {
        usedTop.add(name);
        return name;
      }
      const dot = name.lastIndexOf(".");
      let i = 2;
      let f;
      do {
        f = dot > 0 ? name.slice(0, dot) + " (" + i + ")" + name.slice(dot) : name + " (" + i + ")";
        i++;
      } while (usedTop.has(f));
      usedTop.add(f);
      return f;
    };
    const fileData = (n) =>
      n.content !== undefined ? Buffer.from(n.content, "utf8") : hasBlob(n.id) ? readFileSync(blobPath(n.id)) : Buffer.alloc(0);
    const addTree = (n, prefix) => {
      if (n.type === "file") {
        out.push({ name: prefix + n.name, data: fileData(n) });
        return;
      }
      for (const k of list.filter((c) => c.parentId === n.id)) addTree(k, prefix + n.name + "/");
    };
    for (const id of ids) {
      const n = byId.get(id);
      if (!n) continue;
      if (n.type === "file") out.push({ name: uniqTop(n.name), data: fileData(n) });
      else addTree(n, "");
    }
    return out;
  }

  function countSubtree(id) { // 源:1437-1451
    const list = load();
    const ids = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of list) {
        if (n.parentId && ids.has(n.parentId) && !ids.has(n.id)) {
          ids.add(n.id);
          changed = true;
        }
      }
    }
    return ids.size;
  }

  return Object.freeze({
    dataDir: dataDir,
    file: FILE,
    blobDir: BLOB_DIR,
    thumbnailDir: THUMBNAIL_DIR,
    format: FS_FORMAT,
    systemRootName: SYSTEM_ROOT_NAME,
    // Blob（源 fs.ts:51-159）
    contentBlobPath: contentBlobPath,
    blobPath: blobPath,
    thumbnailPath: thumbnailPath,
    hasThumbnail: hasThumbnail,
    saveThumbnail: saveThumbnail,
    deleteThumbnail: deleteThumbnail,
    hasBlob: hasBlob,
    hasContentAddressedBlob: hasContentAddressedBlob,
    stageContentAddressedBlob: stageContentAddressedBlob,
    saveBlob: saveBlob,
    adoptBlobFile: adoptBlobFile,
    readBlob: readBlob,
    // 版本 / 批量计划（源 fs.ts:294-459）
    getFsRevision: getFsRevision,
    getFsCommitState: getFsCommitState,
    prepareFsArtifactBatchPlan: prepareFsArtifactBatchPlan,
    prepareFsTextBatchPlan: prepareFsTextBatchPlan,
    serializeFsTextBatchPlan: serializeFsTextBatchPlan,
    serializeFsArtifactBatchPlan: serializeFsTextBatchPlan,
    publishFsTextBatchPlan: publishFsTextBatchPlan,
    publishFsArtifactBatchPlan: publishFsTextBatchPlan,
    collectOrphanContentBlobs: collectOrphanContentBlobs,
    // 树（源 fs.ts:485-703）
    listChildren: listChildren,
    getNode: getNode,
    readNodeNameSnapshot: readNodeNameSnapshot,
    readNodeHierarchySnapshot: readNodeHierarchySnapshot,
    isInTrash: isInTrash,
    createNode: createNode,
    upsertCloudCanvasFile: upsertCloudCanvasFile,
    resolvePath: resolvePath,
    findByPath: findByPath,
    isWithinRoot: isWithinRoot,
    ensureFolder: ensureFolder,
    ensureSystemRoot: ensureSystemRoot,
    ensureUserFolder: ensureUserFolder,
    ensureCanvasRoot: ensureCanvasRoot,
    createCanvasProjectFolder: createCanvasProjectFolder,
    renameNode: renameNode,
    setContent: setContent,
    setBinaryContent: setBinaryContent,
    claimOwnerlessNodes: claimOwnerlessNodes,
    // 共享区（源 fs.ts:850-945）
    ensurePublicRoot: ensurePublicRoot,
    ensureDepartmentRoot: ensureDepartmentRoot,
    shareZoneOf: shareZoneOf,
    setCanvasFolderShare: setCanvasFolderShare,
    setAssetLibraryFolderShare: setAssetLibraryFolderShare,
    renameShareRoot: renameShareRoot,
    removeShareRoot: removeShareRoot,
    claimNodeOwner: claimNodeOwner,
    // 移动 / 复制 / 回收站（源 fs.ts:947-1098）
    moveNode: moveNode,
    copyNode: copyNode,
    removeNode: removeNode,
    purgeNode: purgeNode,
    listTrash: listTrash,
    restoreNode: restoreNode,
    emptyTrash: emptyTrash,
    // 统计 / 搜索 / 快照 / 打包（源 fs.ts:1100-1451）
    subtreeByteSize: subtreeByteSize,
    storageReport: storageReport,
    storageChildren: storageChildren,
    searchNodes: searchNodes,
    snapshotSubtree: snapshotSubtree,
    restoreSubtreeSnapshot: restoreSubtreeSnapshot,
    subtree: subtree,
    collectZipEntries: collectZipEntries,
    countSubtree: countSubtree,
  });
}

module.exports = {
  createDxosFs,
  resolveFsDataDir,
  FS_FORMAT,
  SYSTEM_ROOT_NAME,
};
