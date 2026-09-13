/**
 * D3-04A · Managed Store —— 本地内容对象的文件系统层。
 *
 * 设计要点（§15–§20 §28–§33 §53）：
 *   · Store root 由调用方按平台规范给出（Electron userData/library），本模块不猜路径。
 *   · 正式 object filename **只由 SHA-256 生成**：objects/sha256/ab/<hash>。
 *     用户文件名 / 路径 / 显示名永不参与最终位置。
 *   · Import 先写 staging，再原子 rename 进 objects；DB 与 FS 之间没有真正的 ACID，
 *     所以 promote 之后仍允许出现"object 已写、DB 未提交"的可 GC 孤儿（§54）。
 *   · 大文件全程 stream + 增量 hash，绝不 readFile() 整个文件（§28）。
 */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { once } = require("node:events");
const domain = require("./resource-domain.cjs");

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

class ImportCancelledError extends Error {
  constructor() {
    super("import-cancelled");
    this.code = domain.REASON.IMPORT_CANCELLED;
  }
}

class ManagedStore {
  /** @param opts.root 形如 <userData>/library 的绝对路径 */
  constructor({ root } = {}) {
    if (!root || typeof root !== "string") throw new Error("ManagedStore 需要 root");
    this.root = path.resolve(root);
  }

  // --- 布局 -----------------------------------------------------------------

  ensureLayout() {
    for (const dir of ["objects", "objects/sha256", "staging", "thumbnails", "generated", "cache", "trash"]) {
      fs.mkdirSync(path.join(this.root, dir), { recursive: true, mode: DIR_MODE });
    }
    return this;
  }

  listLayout() {
    return ["objects", "staging", "thumbnails", "generated", "cache", "trash"].map((d) => path.join(this.root, d));
  }

  /** 内部 key → 绝对路径。key 只能由 domain 生成，且再次做 store 内校验。 */
  resolveKey(internalKey) {
    const key = domain.toInternalKey(internalKey);
    if (!key || domain.hasTraversal(key)) return null;
    const target = path.join(this.root, key);
    return domain.isPathInside(this.root, target) ? target : null;
  }

  objectInternalKey(checksum) {
    return domain.contentInternalKey(checksum);
  }

  objectPath(checksum) {
    const key = domain.contentInternalKey(checksum);
    return key ? this.resolveKey(key) : null;
  }

  stagingPath(jobId) {
    const key = domain.stagingKeyFor(jobId);
    return key ? this.resolveKey(key) : null;
  }

  // --- 磁盘空间 -------------------------------------------------------------

  availableBytes() {
    try {
      const st = fs.statfsSync(this.root);
      return Number(st.bavail) * Number(st.bsize);
    } catch {
      return null;
    }
  }

  /** 导入前做合理空间检查（§31）：目标大小 + 10% 余量。 */
  hasSpaceFor(size, { multiplier = 1.1, reserveBytes = 32 * 1024 * 1024 } = {}) {
    if (!Number.isFinite(size) || size < 0) return { ok: true, checked: false };
    const free = this.availableBytes();
    if (free == null) return { ok: true, checked: false };
    return { ok: free >= Math.ceil(size * multiplier) + reserveBytes, checked: true, free, required: Math.ceil(size * multiplier) + reserveBytes };
  }

  // --- staging --------------------------------------------------------------

  ensureStagingDir() {
    fs.mkdirSync(path.join(this.root, "staging"), { recursive: true, mode: DIR_MODE });
  }

  /**
   * 把可读流写进 staging，同时增量算 SHA-256。
   * 全程 O(1) 内存（不整文件读入）。返回 checksum + size。
   */
  async stageFromStream(jobId, readable, { bytesTotal = null, onProgress = null, signal = null } = {}) {
    this.ensureStagingDir();
    const target = this.stagingPath(jobId);
    if (!target) throw domain.fail(domain.REASON.PATH_ESCAPE);
    const hash = crypto.createHash("sha256");
    let processed = 0;
    const out = fs.createWriteStream(target, { mode: FILE_MODE });
    const report = (phase) => onProgress && onProgress({ phase, bytesTotal, bytesProcessed: processed });
    try {
      report(domain.IMPORT_PHASE.STAGING);
      for await (const chunk of readable) {
        if (signal && signal.aborted) throw new ImportCancelledError();
        hash.update(chunk);
        if (!out.write(chunk)) await once(out, "drain");
        processed += chunk.length;
        report(domain.IMPORT_PHASE.STAGING);
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    } catch (err) {
      try {
        out.destroy();
      } catch {
        /* ignore */
      }
      this.removeStaging(jobId);
      throw err;
    }
    return { checksum: hash.digest("hex"), size: processed, stagingPath: target };
  }

  async stageFromFile(jobId, sourcePath, { onProgress = null, signal = null, sourceSize = null } = {}) {
    const readable = fs.createReadStream(sourcePath, { highWaterMark: 1024 * 1024 });
    return this.stageFromStream(jobId, readable, { bytesTotal: sourceSize, onProgress, signal });
  }

  async stageFromBuffer(jobId, buffer, { onProgress = null, signal = null } = {}) {
    const { Readable } = require("node:stream");
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ""), "utf8");
    return this.stageFromStream(jobId, Readable.from([buf]), { bytesTotal: buf.length, onProgress, signal });
  }

  removeStaging(jobId) {
    const target = this.stagingPath(jobId);
    if (!target) return { removed: false };
    try {
      fs.rmSync(target, { force: true });
      return { removed: true };
    } catch {
      return { removed: false };
    }
  }

  listStaging() {
    try {
      return fs.readdirSync(path.join(this.root, "staging"));
    } catch {
      return [];
    }
  }

  // --- 对象 -----------------------------------------------------------------

  /** 把 staging 原子 rename 进 objects/sha256/…。同内容已存在时删除 staging 并复用。 */
  async promoteStaging(jobId, checksum) {
    const staging = this.stagingPath(jobId);
    const objectPath = this.objectPath(checksum);
    if (!staging || !objectPath) return { ok: false, error: domain.REASON.PATH_ESCAPE };
    await fsp.mkdir(path.dirname(objectPath), { recursive: true, mode: DIR_MODE });
    if (fs.existsSync(objectPath)) {
      // 内容已存在（dedupe）：只删 staging，不再写 object。
      try {
        fs.rmSync(staging, { force: true });
      } catch {
        /* ignore */
      }
      return { ok: true, existed: true, objectPath };
    }
    try {
      await fsp.rename(staging, objectPath);
      return { ok: true, existed: false, objectPath };
    } catch (err) {
      if (err && (err.code === "ENOSPC" || err.code === "EXDEV")) return { ok: false, error: err.code === "ENOSPC" ? domain.REASON.ENOSPC : domain.REASON.INTERNAL_ERROR };
      return { ok: false, error: domain.REASON.INTERNAL_ERROR };
    }
  }

  objectStat(checksum) {
    const p = this.objectPath(checksum);
    if (!p) return { exists: false, size: null };
    try {
      const st = fs.statSync(p);
      return { exists: st.isFile(), size: st.size, mtime: st.mtimeMs };
    } catch {
      return { exists: false, size: null };
    }
  }

  readObject(checksum, range = null) {
    const p = this.objectPath(checksum);
    if (!p || !fs.existsSync(p)) return null;
    return fs.createReadStream(p, range ? { start: range.start, end: range.end, highWaterMark: 1024 * 1024 } : { highWaterMark: 1024 * 1024 });
  }

  /** 重新流式哈希对象，验证完整性（不整文件读入）。 */
  async hashObject(checksum, { signal = null } = {}) {
    const p = this.objectPath(checksum);
    if (!p || !fs.existsSync(p)) return { ok: false, error: domain.REASON.OBJECT_MISSING };
    const hash = crypto.createHash("sha256");
    let size = 0;
    const rs = fs.createReadStream(p, { highWaterMark: 1024 * 1024 });
    for await (const chunk of rs) {
      if (signal && signal.aborted) return { ok: false, error: domain.REASON.IMPORT_CANCELLED };
      hash.update(chunk);
      size += chunk.length;
    }
    const actual = hash.digest("hex");
    return { ok: actual === checksum, actual, size, error: actual === checksum ? null : domain.REASON.CHECKSUM_MISMATCH };
  }

  async readText(checksum, { maxBytes = domain.MAX_READ_TEXT_BYTES } = {}) {
    const p = this.objectPath(checksum);
    if (!p || !fs.existsSync(p)) return { ok: false, error: domain.REASON.OBJECT_MISSING };
    const st = fs.statSync(p);
    if (st.size > maxBytes) return { ok: false, error: domain.REASON.CONTENT_TOO_LARGE, size: st.size };
    const text = await fsp.readFile(p, "utf8");
    return { ok: true, text, size: st.size };
  }

  removeObject(checksum) {
    const p = this.objectPath(checksum);
    if (!p) return { removed: false };
    try {
      fs.rmSync(p, { force: true });
      return { removed: true };
    } catch {
      return { removed: false };
    }
  }

  /** 递归列出 objects 下的内部 key（orphan GC / startup 扫描用）。 */
  listObjectKeys() {
    const rootDir = path.join(this.root, "objects", "sha256");
    const out = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.isFile()) out.push(domain.toInternalKey(path.relative(this.root, full)));
      }
    };
    walk(rootDir);
    return out;
  }
}

module.exports = { ManagedStore, ImportCancelledError };
