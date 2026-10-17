"use strict";
/**
 * task-22 · 缓存清理（只删 <userData>/dxos 下的 cache / temp / tmp 目录内容）。
 *
 * 安全边界：
 *   · 只扫 dxos 根下最多 3 层的 cache / temp / tmp 目录，不跟随符号链接；
 *   · 永不删除 / 不进入 credentials（safeStorage 凭据）、backups（系统快照）、数据库文件
 *     （*.db / *.sqlite / *.sqlite3）与私钥文件（*.key / *.pem / *.p12）；
 *   · 只返回相对路径与字节数，不回传绝对路径；
 *   · 默认要求 confirm:true；dryRun:true 只统计不删除。
 */
const fs = require("node:fs");
const path = require("node:path");

const localProxyDomain = require("./local-proxy-domain.cjs");
const { resolveDxosPaths } = require("./dxos-foundation-paths.cjs");

const CACHE_COMMAND = "desktop/cache/clear";
const MAX_DEPTH = 3;
const CACHE_DIR_NAMES = new Set(["cache", "temp", "tmp"]);
const PROTECTED_DIR_NAMES = new Set(["credentials", "backups", "identity"]);
const PROTECTED_SUFFIXES = [".db", ".sqlite", ".sqlite3", ".db-wal", ".db-shm", ".key", ".pem", ".p12", ".pfx"];
const PROTECTED_NAMES = new Set(["identity.db", "credentials.json", "cookies", "session"]);

function isProtectedFile(name) {
  const lower = String(name || "").toLowerCase();
  if (PROTECTED_NAMES.has(lower)) return true;
  return PROTECTED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function createDesktopCacheService(options = {}) {
  const userDataDir = options.userDataDir ? String(options.userDataDir) : "";
  if (!userDataDir) throw new Error("createDesktopCacheService 需要 userDataDir");
  const fsImpl = options.fsImpl && typeof options.fsImpl.readdirSync === "function" ? options.fsImpl : fs;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const dxosRoot = resolveDxosPaths(userDataDir).root;

  /** 找出所有 cache/temp/tmp 候选目录（不跟随符号链接）。 */
  function findCacheDirs() {
    const found = [];
    const skipped = [];
    function walk(dir, depth) {
      if (depth > MAX_DEPTH) return;
      let entries;
      try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        if (!entry || typeof entry.name !== "string") continue;
        const full = path.join(dir, entry.name);
        const relative = path.relative(dxosRoot, full);
        if (entry.isSymbolicLink()) { skipped.push({ path: relative, reason: "symlink" }); continue; }
        if (!entry.isDirectory()) continue;
        if (PROTECTED_DIR_NAMES.has(entry.name)) { skipped.push({ path: relative, reason: "protected-directory" }); continue; }
        if (CACHE_DIR_NAMES.has(entry.name)) found.push({ dir: full, relative });
        else walk(full, depth + 1);
      }
    }
    if (fsImpl.existsSync(dxosRoot)) walk(dxosRoot, 0);
    return { dirs: found, skipped };
  }

  /** 统计一个候选目录里将被清理的文件；protected 文件计入 skipped。 */
  function measureDir(dir, relative) {
    let bytes = 0;
    let files = 0;
    const skipped = [];
    let entries;
    try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); }
    catch { return { bytes, files, skipped }; }
    function walk(current, currentRelative) {
      let list;
      try { list = fsImpl.readdirSync(current, { withFileTypes: true }); } catch { return; }
      for (const entry of list) {
        if (!entry || typeof entry.name !== "string") continue;
        const full = path.join(current, entry.name);
        const childRelative = path.join(currentRelative, entry.name);
        if (entry.isSymbolicLink()) { skipped.push({ path: childRelative, reason: "symlink" }); continue; }
        if (entry.isDirectory()) {
          if (PROTECTED_DIR_NAMES.has(entry.name)) { skipped.push({ path: childRelative, reason: "protected-directory" }); continue; }
          walk(full, childRelative);
          continue;
        }
        if (!entry.isFile()) continue;
        if (isProtectedFile(entry.name)) { skipped.push({ path: childRelative, reason: "protected-file" }); continue; }
        try { bytes += Number(fsImpl.statSync(full).size) || 0; } catch { /* 统计失败按 0，不阻断清理 */ }
        files += 1;
      }
    }
    walk(dir, relative);
    return { bytes, files, skipped };
  }

  /** 删除候选目录的直接子项（保留 cache/temp 目录本身，避免应用下一轮找不到目录）。 */
  function purgeDir(dir) {
    let removedFiles = 0;
    let removedDirs = 0;
    const skipped = [];
    let entries;
    try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return { removedFiles, removedDirs, skipped }; }
    for (const entry of entries) {
      if (!entry || typeof entry.name !== "string") continue;
      const full = path.join(dir, entry.name);
      const relative = path.relative(dxosRoot, full);
      if (entry.isSymbolicLink()) { skipped.push({ path: relative, reason: "symlink" }); continue; }
      if (entry.isDirectory()) {
        if (PROTECTED_DIR_NAMES.has(entry.name)) { skipped.push({ path: relative, reason: "protected-directory" }); continue; }
        try {
          // 先在删除前把目录里的 protected 文件保住：这里 cache 目录内的 db/key 不允许被整目录删掉。
          const children = fsImpl.readdirSync(full);
          const hasProtected = children.some((name) => isProtectedFile(name) || PROTECTED_DIR_NAMES.has(name));
          if (hasProtected) {
            // 一旦混入数据库 / 凭据文件，整目录保留（宁可少清，不可误删）。
            skipped.push({ path: relative, reason: "protected-content" });
            continue;
          }
          fsImpl.rmSync(full, { recursive: true, force: true });
          removedDirs += 1;
        } catch { skipped.push({ path: relative, reason: "remove-failed" }); }
        continue;
      }
      if (!entry.isFile()) continue;
      if (isProtectedFile(entry.name)) { skipped.push({ path: relative, reason: "protected-file" }); continue; }
      try { fsImpl.rmSync(full, { force: true }); removedFiles += 1; } catch { skipped.push({ path: relative, reason: "remove-failed" }); }
    }
    return { removedFiles, removedDirs, skipped };
  }

  function clear(payload = {}) {
    const input = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    const dryRun = input.dryRun === true;
    if (!dryRun && input.confirm !== true) {
      throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INVALID_INPUT, "cache/clear 必须显式 confirm:true（dryRun:true 可只扫描）");
    }
    const scan = findCacheDirs();
    let freedBytes = 0;
    let wouldFreeBytes = 0;
    let removedFiles = 0;
    let removedDirs = 0;
    const skipped = [...scan.skipped];
    const roots = [];
    for (const candidate of scan.dirs) {
      const measured = measureDir(candidate.dir, candidate.relative);
      wouldFreeBytes += measured.bytes;
      skipped.push(...measured.skipped);
      roots.push(candidate.relative);
      if (dryRun) continue;
      const purged = purgeDir(candidate.dir);
      freedBytes += measured.bytes;
      removedFiles += purged.removedFiles;
      removedDirs += purged.removedDirs;
      skipped.push(...purged.skipped);
    }
    return {
      command: CACHE_COMMAND,
      dryRun,
      freedBytes: dryRun ? 0 : freedBytes,
      wouldFreeBytes,
      removedFiles: dryRun ? 0 : removedFiles,
      removedDirs: dryRun ? 0 : removedDirs,
      roots,
      skipped,
      checkedAt: Number(clock()),
    };
  }

  async function execute(command, payload) {
    try {
      if (command !== CACHE_COMMAND) throw localProxyDomain.localProxyCommandNotAllowed(command);
      return { ok: true, value: localProxyDomain.redactLocalProxyValue(clear(payload)) };
    } catch (error) {
      return localProxyDomain.normalizeLocalProxyError(error);
    }
  }

  return { execute, clear, findCacheDirs, command: CACHE_COMMAND };
}

module.exports = { createDesktopCacheService, CACHE_COMMAND };
