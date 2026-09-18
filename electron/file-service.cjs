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

  /**
   * 系统级回收站（软删除）。存储布局：
   *   <userData>/files/.trash/<trashId>.<ext>   被移出的物理文件
   *   <userData>/files/.trash/index.json        回收站索引
   * 索引条目 = { id, origId, folderId, name, ext, size, mtime, deletedAt, file }。
   *
   * 为什么目录名是 `.trash`：folderId 白名单 ID_RE 不允许点号，因此渲染层
   * **无法**把 .trash 当作一个普通文件夹访问 —— 回收站只能走它专属的通道。
   */
  const trashDir = path.join(root, ".trash");
  fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
  const trashIndexFile = path.join(trashDir, "index.json");

  function readTrashIndex() {
    try {
      const raw = JSON.parse(fs.readFileSync(trashIndexFile, "utf8"));
      return Array.isArray(raw && raw.entries) ? raw.entries : [];
    } catch {
      return [];
    }
  }

  /** 与 writeIndex 同一套原子写法：先写 tmp，再 rename。 */
  function writeTrashIndex(entries) {
    const tmp = trashIndexFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2));
    fs.renameSync(tmp, trashIndexFile);
  }

  /** 只认索引里记录的物理文件名：就算索引被写坏，也走不出回收站目录。 */
  const trashFileOf = (e) => path.basename(String(e.file || e.id));

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

  /** 索引里记录的物理文件名（老数据只有 id）。 */
  const fileOf = (e) => e.file || String(e.id);

  function list(folderId) {
    const dir = dirOf(folderId);
    if (!dir) return { ok: false, error: "INVALID_INPUT" };
    return { ok: true, entries: readIndex(dir) };
  }

  /**
   * 兼容早期数据：那时把文件存成无扩展名的 <id>，缩略图会退化成系统通用文档图标。
   * 这里给物理文件补上扩展名并写回索引（幂等、失败不影响读取）。
   */
  function migrateLegacyFiles() {
    let dirs = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      return;
    }
    for (const d of dirs) {
      const dir = path.join(root, d.name);
      const entries = readIndex(dir);
      let changed = false;
      for (const e of entries) {
        if (e.file) continue;
        const plain = path.join(dir, String(e.id));
        const target = e.ext ? path.join(dir, e.id + "." + e.ext) : plain;
        try {
          if (e.ext && fs.existsSync(plain) && !fs.existsSync(target)) fs.renameSync(plain, target);
        } catch {
          /* 迁移失败保持旧路径：读/删仍可用，只是缩略图仍是图标 */
        }
        if (fs.existsSync(target)) {
          e.file = path.basename(target);
          changed = true;
        }
      }
      if (changed) writeIndex(dir, entries);
    }
  }
  migrateLegacyFiles();

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
        const ext = extOf(name);
        // **必须带扩展名落盘**：macOS 的 createThumbnailFromPath 靠扩展名判断类型，
        // 无扩展名时它只返回"通用文档图标"（缩略图就会变成一个白页图标）。
        const file = id + (ext ? "." + ext : "");
        fs.copyFileSync(String(p), path.join(dir, file));
        const entry = { id, name, ext, size: st.size, mtime: Date.now(), file };
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
    const victim = entries.find((e) => e.id === id);
    if (victim) {
      try {
        fs.unlinkSync(path.join(dir, fileOf(victim)));
      } catch {
        /* 文件已不存在也算删除成功 */
      }
    }
    const next = entries.filter((e) => e.id !== id);
    writeIndex(dir, next);
    return { ok: true, entries: next };
  }

  /**
   * 软删除：条目从原文件夹移入回收站，索引里保留原 folderId / 原名 / 删除时间。
   * 顺序是**先移动物理文件 → 写回收站索引 → 最后才改原索引**：
   * 中间任何一步崩溃都只是"多出一条记录"，不会丢数据（与 remove 的永久删除语义完全分开）。
   */
  function trash(folderId, id) {
    const dir = dirOf(folderId);
    if (!dir) return { ok: false, error: "INVALID_INPUT" };
    const victim = readIndex(dir).find((e) => e.id === id);
    if (!victim) return { ok: false, error: "NOT_FOUND" };
    const trashId = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const ext = extOf(victim.name);
    const file = trashId + (ext ? "." + ext : "");
    const src = path.join(dir, fileOf(victim));
    const dst = path.join(trashDir, file);
    let moved = false;
    try {
      fs.renameSync(src, dst);
      moved = true;
    } catch {
      moved = false;
    }
    if (!moved) {
      try {
        fs.copyFileSync(src, dst);
        fs.unlinkSync(src);
        moved = true;
      } catch {
        moved = false;
      }
    }
    // 物理文件不见了（外部删掉）也允许收进回收站，只保留元数据。
    if (!moved && fs.existsSync(src)) return { ok: false, error: "FILE_IO" };
    const tEntries = readTrashIndex();
    tEntries.push({
      id: trashId,
      origId: victim.id,
      folderId: String(folderId),
      name: victim.name,
      ext,
      size: victim.size,
      mtime: victim.mtime,
      deletedAt: Date.now(),
      file,
    });
    writeTrashIndex(tEntries);
    const next = readIndex(dir).filter((e) => e.id !== id);
    writeIndex(dir, next);
    return { ok: true, entries: next, trashId };
  }

  /** 回收站内容：按删除时间倒序（最近删的在最前）。 */
  function listTrash() {
    const entries = readTrashIndex().slice().sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
    return { ok: true, entries };
  }

  /**
   * 恢复：原文件夹不存在就重建它（dirOf 的既有行为），重名自动加后缀。
   * 原条目 id 没被占用时**复用原 id** —— 桌面图标位置按 id 记录，换 id 会让文件"跳位置"。
   */
  function restore(id) {
    const trashId = safeId(id);
    if (!trashId) return { ok: false, error: "INVALID_INPUT" };
    const tEntries = readTrashIndex();
    const entry = tEntries.find((e) => e.id === trashId);
    if (!entry) return { ok: false, error: "NOT_FOUND" };
    const folderId = safeId(entry.folderId);
    if (!folderId) return { ok: false, error: "INVALID_FOLDER" };
    const recreated = !fs.existsSync(path.join(root, folderId));
    const dir = dirOf(folderId);
    if (!dir) return { ok: false, error: "INVALID_FOLDER" };
    const dstEntries = readIndex(dir);
    const name = uniqueName(dstEntries, entry.name);
    const origId = safeId(entry.origId);
    const canReuse = origId && !dstEntries.some((e) => e.id === origId);
    const newId = canReuse ? origId : "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const ext = extOf(name);
    const file = newId + (ext ? "." + ext : "");
    const src = path.join(trashDir, trashFileOf(entry));
    const dst = path.join(dir, file);
    let moved = false;
    try {
      fs.renameSync(src, dst);
      moved = true;
    } catch {
      moved = false;
    }
    if (!moved) {
      try {
        fs.copyFileSync(src, dst);
        fs.unlinkSync(src);
        moved = true;
      } catch {
        moved = false;
      }
    }
    if (!moved) return { ok: false, error: "FILE_MISSING" };
    // 先落目标索引，再从回收站移除：崩溃时最多"两处都在"，不会"两边都没有"。
    dstEntries.push({ id: newId, name, ext, size: entry.size, mtime: entry.mtime, file });
    writeIndex(dir, dstEntries);
    writeTrashIndex(tEntries.filter((e) => e.id !== trashId));
    return { ok: true, folderId, recreated, id: newId, entries: dstEntries };
  }

  /** 永久删除单个回收站条目。 */
  function purge(id) {
    const trashId = safeId(id);
    if (!trashId) return { ok: false, error: "INVALID_INPUT" };
    const tEntries = readTrashIndex();
    const entry = tEntries.find((e) => e.id === trashId);
    if (!entry) return { ok: false, error: "NOT_FOUND" };
    try {
      fs.unlinkSync(path.join(trashDir, trashFileOf(entry)));
    } catch {
      /* 文件已不存在也算删除成功 */
    }
    const next = tEntries.filter((e) => e.id !== trashId);
    writeTrashIndex(next);
    return { ok: true, entries: next };
  }

  /** 清空回收站：删掉所有物理文件并写回空索引。 */
  function empty() {
    const tEntries = readTrashIndex();
    for (const entry of tEntries) {
      try {
        fs.unlinkSync(path.join(trashDir, trashFileOf(entry)));
      } catch {
        /* 同上：文件不在不影响清空 */
      }
    }
    writeTrashIndex([]);
    return { ok: true, removed: tEntries.length };
  }

  /**
   * 复制到另一个文件夹：新 id + 目标内去重名，逐字节复制（原条目保持不变）。
   */
  function copy(folderId, ids, toFolderId) {
    const from = dirOf(folderId);
    const to = dirOf(toFolderId);
    if (!from || !to) return { ok: false, error: "INVALID_INPUT" };
    const src = readIndex(from);
    const dst = readIndex(to);
    const added = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const e = src.find((x) => x.id === id);
      if (!e) continue;
      try {
        const nid = "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const name = uniqueName(dst, e.name);
        const ext = extOf(name);
        const file = nid + (ext ? "." + ext : "");
        fs.copyFileSync(path.join(from, fileOf(e)), path.join(to, file));
        const entry = { id: nid, name, ext, size: e.size, mtime: Date.now(), file };
        dst.push(entry);
        added.push(entry);
      } catch {
        /* 单个失败不影响整批 */
      }
    }
    writeIndex(to, dst);
    return { ok: true, entries: dst, added };
  }

  /**
   * 移动到另一个文件夹：id 不变，优先 rename；跨卷失败退化为"复制 + 删除"。
   */
  function move(folderId, ids, toFolderId) {
    if (folderId === toFolderId) return { ok: false, error: "SAME_FOLDER" };
    const from = dirOf(folderId);
    const to = dirOf(toFolderId);
    if (!from || !to) return { ok: false, error: "INVALID_INPUT" };
    const src = readIndex(from);
    const dst = readIndex(to);
    const movedIds = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const e = src.find((x) => x.id === id);
      if (!e) continue;
      const name = uniqueName(dst, e.name);
      const ext = extOf(name);
      const file = e.id + (ext ? "." + ext : "");
      const srcPath = path.join(from, fileOf(e));
      const dstPath = path.join(to, file);
      let ok = false;
      try {
        fs.renameSync(srcPath, dstPath);
        ok = true;
      } catch {
        ok = false;
      }
      if (!ok) {
        try {
          fs.copyFileSync(srcPath, dstPath);
          fs.unlinkSync(srcPath);
          ok = true;
        } catch {
          ok = false;
        }
      }
      if (!ok) continue;
      dst.push({ ...e, name, ext, file, mtime: Date.now() });
      movedIds.push(e.id);
    }
    const keep = src.filter((x) => !movedIds.includes(x.id));
    writeIndex(from, keep);
    writeIndex(to, dst);
    return { ok: true, from: keep, to: dst, movedIds };
  }

  /**
   * 读取条目内容，给渲染层做 Quick Look 预览。
   * 只返回 **data URL / 文本**，不返回磁盘路径；超过上限的直接拒绝（避免把大文件塞进 IPC）。
   */
  const MIME = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
    mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm",
    mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", flac: "audio/flac",
    pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json",
    csv: "text/csv", log: "text/plain", xml: "text/xml", yml: "text/yaml", yaml: "text/yaml",
  };
  const MAX_READ = 12 * 1024 * 1024;
  const TEXT_LIMIT = 200000;

  function read(folderId, id) {
    const dir = dirOf(folderId);
    if (!dir) return { ok: false, error: "INVALID_INPUT" };
    const entry = readIndex(dir).find((e) => e.id === id);
    if (!entry) return { ok: false, error: "NOT_FOUND" };
    try {
      const file = path.join(dir, fileOf(entry));
      const st = fs.statSync(file);
      if (st.size > MAX_READ) return { ok: false, error: "TOO_LARGE", entry };
      const buf = fs.readFileSync(file);
      // MIME 以**物理扩展名**为准（改名不该改变文件真实类型），显示名仅作回退
      const mime = MIME[extOf(fileOf(entry))] || MIME[entry.ext] || "application/octet-stream";
      const kind = mime.startsWith("image/")
        ? "image"
        : mime.startsWith("video/")
          ? "video"
          : mime.startsWith("audio/")
            ? "audio"
            : mime === "application/pdf"
              ? "pdf"
              : mime.startsWith("text/") || mime === "application/json"
                ? "text"
                : "other";
      const out = { ok: true, entry, mime, kind, dataUrl: "data:" + mime + ";base64," + buf.toString("base64") };
      if (kind === "text") out.text = buf.toString("utf8").slice(0, TEXT_LIMIT);
      return out;
    } catch {
      return { ok: false, error: "INTERNAL_ERROR", entry };
    }
  }

  /**
   * **只给主进程用**：拿到条目的磁盘路径（缩略图生成需要真实路径）。
   * 刻意不挂到 preload 上 —— 渲染进程永远拿不到路径。
   */
  function resolve(folderId, id) {
    const dir = dirOf(folderId);
    if (!dir) return null;
    const entry = readIndex(dir).find((e) => e.id === id);
    if (!entry) return null;
    return { path: path.join(dir, fileOf(entry)), entry };
  }

  return { importPaths, list, rename, remove, read, resolve, copy, move, trash, listTrash, restore, purge, empty };
}

module.exports = { createFileService };
