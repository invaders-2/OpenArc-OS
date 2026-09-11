/**
 * D3-04 的最小落地 · 本地文件服务。
 *
 * 存储布局：
 *   <userData>/files/<folderId>/<entryId>        数据本体（以 entry id 命名，无扩展名）
 *   <userData>/files/<folderId>/index.json       条目索引 { id, name, ext, size, mtime }
 *
 * 设计约束：
 *   · 索引先写临时文件再 rename，避免半截 JSON 让整个文件夹不可读；
 *   · folderId 只允许 [A-Za-z0-9_-]，从根上堵住路径穿越；
 *   · 单个文件失败不影响整批导入（多选拖入时尤其重要）；
 *   · 本模块**不做鉴权** —— 鉴权在 main.cjs 的 trusted(event) 一处收口。
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME = 200;

function createFileService({ userDataDir }) {
  const root = path.join(userDataDir, "files");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  const safeId = (v) => (ID_RE.test(String(v ?? "")) ? String(v) : null);

  /** 取（必要时创建）某个文件夹的存储目录；folderId 非法直接拒绝。 */
  function dirOf(folderId) {
    const id = safeId(folderId);
    if (!id) return null;
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  function readIndex(dir) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
      return Array.isArray(raw && raw.entries) ? raw.entries : [];
    } catch {
      return [];
    }
  }

  function writeIndex(dir, entries) {
    const file = path.join(dir, "index.json");
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2));
    fs.renameSync(tmp, file);
  }

  const extOf = (name) => {
    const i = name.lastIndexOf(".");
    return i > 0 ? name.slice(i + 1).toLowerCase() : "";
  };

  /** 重名不覆盖：自动加 " 2" / " 3" 后缀（与 Finder 的"副本"习惯一致）。 */
  function uniqueName(entries, name) {
    const clean = String(name).trim().slice(0, MAX_NAME) || "未命名";
    const used = new Set(entries.map((e) => e.name));
    if (!used.has(clean)) return clean;
    const dot = clean.lastIndexOf(".");
    const base = dot > 0 ? clean.slice(0, dot) : clean;
    const ext = dot > 0 ? clean.slice(dot) : "";
    for (let i = 2; ; i += 1) {
      const cand = base + " " + i + ext;
      if (!used.has(cand)) return cand;
    }
  }

  function list(folderId) {
    const dir = dirOf(folderId);
    if (!dir) return { ok: false, error: "INVALID_INPUT" };
    return { ok: true, entries: readIndex(dir) };
  }

  function importPaths(folderId, paths) {
    const dir = dirOf(folderId);
    if (!dir) return { ok: false, error: "INVALID_INPUT" };
    const entries = readIndex(dir);
    const added = [];
    for (const p of Array.isArray(paths) ? paths : []) {
      try {
        const st = fs.statSync(String(p));
        if (!st.isFile()) continue; // 目录暂不支持（需要递归，留给后续）
        const id = "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const name = uniqueName(entries, path.basename(String(p)));
        fs.copyFileSync(String(p), path.join(dir, id));
        const entry = { id, name, ext: extOf(name), size: st.size, mtime: Date.now() };
        entries.push(entry);
        added.push(entry);
      } catch {
        /* 单个文件失败不拖垮整批 */
      }
    }
    writeIndex(dir, entries);
    return { ok: true, entries, added };
  }

  function rename(folderId, id, name) {
    const dir = dirOf(folderId);
    const clean = String(name ?? "").replace(/[/\\]/g, "").trim();
    if (!dir || !clean) return { ok: false, error: "INVALID_INPUT" };
    const entries = readIndex(dir);
    const entry = entries.find((e) => e.id === id);
    if (!entry) return { ok: false, error: "NOT_FOUND" };
    entry.name = uniqueName(entries.filter((e) => e.id !== id), clean);
    entry.ext = extOf(entry.name);
    writeIndex(dir, entries);
    return { ok: true, entries };
  }

  function remove(folderId, id) {
    const dir = dirOf(folderId);
    if (!dir) return { ok: false, error: "INVALID_INPUT" };
    const entries = readIndex(dir);
    if (entries.some((e) => e.id === id)) {
      try {
        fs.unlinkSync(path.join(dir, String(id)));
      } catch {
        /* 文件已不存在也算删除成功 */
      }
    }
    const next = entries.filter((e) => e.id !== id);
    writeIndex(dir, next);
    return { ok: true, entries: next };
  }

  return { importPaths, list, rename, remove };
}

module.exports = { createFileService };
