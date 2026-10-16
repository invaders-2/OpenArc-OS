/**
 * DX OS 0.6.1 · 系统字体域服务（唯一做文件 I/O 的一层）。
 *
 * 逐行移植自只读源 server/systemFonts.ts 的 systemFontRegistry（源 :66-114）：
 *   · :68-100 refresh：TTL 缓存 + 单飞（pending），扫描期只读 name 表，绝不把字体字节读进内存
 *   · :72-73  深度 5 / 访问 1 万项上限
 *   · :79-85  跳过 symlink，只认 .ttf/.otf/.ttc/.otc
 *   · :87-88  realpath 必须仍在根内；isFile 且 12 <= size <= MAX_BYTES
 *   · :89-90  families 非空才收录；id = sha256(realpath:size:mtimeMs)
 *   · :101-102 list：只回 { id, families, bytes }，绝不出绝对路径
 *   · :103-112 read：id 命中 → realpath 未变且仍在根内 → size+mtime 未变 → 才读字节
 *
 * 与源的差异（都写在对应位置）：
 *   · 源 open() 由 registry 自己持有；这里把 fs 调用收成可注入的 io 适配器，
 *     使"真实字体目录"与"受控边界"两种测试都能覆盖（默认即 node:fs/promises）。
 *   · 源 list() 回全表；这里分页并把 limit 顶到 100（foundation redactValue 的数组上限）。
 *   · 源按 HTTP octet-stream 回裸字节；这里回 base64url（media-service.cjs:367 口径）。
 *   · 源没有下行事件；这里在缓存刷新完成时推一条 progress（只读观测，不改变返回形状）。
 */
"use strict";

const fsp = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { join, resolve, extname } = require("node:path");
const domain = require("./system-fonts-domain.cjs");

/** 默认 io 适配器：只暴露 service 真正用到的方法，禁止泛化调用。 */
function defaultIoAdapter() {
  return {
    realpath: (target) => fsp.realpath(target),
    readdir: (target, options) => fsp.readdir(target, options),
    stat: (target) => fsp.stat(target),
    open: (target, flags) => fsp.open(target, flags),
  };
}

/**
 * 源 :19-64 的 reader 抽取：service 侧只负责"从已打开的句柄读一段"，
 * 边界判定留在 domain.fontFamilies（一处规约，两处调用）。
 */
async function readTableBytes(handle, offset, length) {
  const buffer = Buffer.alloc(length);
  const result = await handle.read(buffer, 0, length, offset);
  return buffer.subarray(0, result.bytesRead);
}

function createSystemFontsService(options = {}) {
  const io = options.io || options.fs || defaultIoAdapter();
  if (!io || typeof io.realpath !== "function" || typeof io.readdir !== "function" || typeof io.stat !== "function" || typeof io.open !== "function") {
    throw domain.createSystemFontsError(domain.SYSTEM_FONTS_ERR_INVALID_INPUT, "createSystemFontsService 需要 realpath/readdir/stat/open 的 io 适配器");
  }
  // 显式传入 roots（含空数组）即完全以调用方为准；未传才落到平台默认目录（源 :11-15）。
  const roots = Array.isArray(options.roots) ? options.roots.map((item) => String(item)) : domain.systemFontDirectories(options);
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes >= 12 ? options.maxBytes : domain.MAX_FONT_BYTES;
  const cacheTtlMs = Number.isFinite(options.cacheTtlMs) && options.cacheTtlMs >= 0 ? options.cacheTtlMs : domain.FONT_CACHE_TTL_MS;
  const maxScanDepth = Number.isSafeInteger(options.maxScanDepth) && options.maxScanDepth >= 0 ? options.maxScanDepth : domain.MAX_SCAN_DEPTH;
  const maxScanEntries = Number.isSafeInteger(options.maxScanEntries) && options.maxScanEntries > 0 ? options.maxScanEntries : domain.MAX_SCAN_ENTRIES;
  const now = typeof options.now === "function" ? options.now : () => Date.now();

  let entries = new Map();
  let refreshedAt = null;
  let pending = null;
  let eventSink = typeof options.onEvent === "function" ? options.onEvent : null;
  let sequence = 0;

  function emit(kind, payload) {
    if (typeof eventSink !== "function") return false;
    sequence += 1;
    const event = domain.createSystemFontsEvent({ kind, payload, sequence, at: now() });
    try { eventSink(event); } catch { /* 事件推送失败不改变业务路径（同 media-bootstrap.cjs:23） */ }
    return true;
  }

  /** 源 :76-94 —— 单个根目录的受限递归扫描。 */
  async function scanRoot(directory, next, state) {
    let root;
    try { root = await io.realpath(resolve(directory)); } catch { return; }

    async function walk(path, depth) {
      if (depth > maxScanDepth || state.visited >= maxScanEntries) return;
      let files;
      try { files = await io.readdir(path, { withFileTypes: true }); } catch { return; }
      for (const file of files) {
        if (++state.visited > maxScanEntries) return;
        if (file.isSymbolicLink()) continue;
        const pathName = join(path, file.name);
        if (file.isDirectory()) { await walk(pathName, depth + 1); continue; }
        if (!file.isFile() || !domain.FONT_EXTENSIONS.includes(extname(file.name).toLowerCase())) continue;
        try {
          const safe = await io.realpath(pathName);
          if (!domain.isWithin(root, safe)) continue;
          const info = await io.stat(safe);
          if (!info.isFile() || info.size < 12 || info.size > maxBytes) continue;
          const handle = await io.open(safe, "r");
          let families;
          try { families = await domain.fontFamilies((offset, length) => readTableBytes(handle, offset, length), { maxBytes }); }
          finally { await handle.close(); }
          if (!families.length) continue;
          const id = createHash("sha256").update(safe + ":" + info.size + ":" + info.mtimeMs).digest("hex");
          next.set(id, { id, families, bytes: info.size, path: safe, root, mtime: info.mtimeMs });
        } catch { /* broken or unsupported font: skip, do not fail the catalog（源 :92） */ }
      }
    }

    await walk(root, 0);
  }

  /** 源 :68-100 refresh：TTL 内直接复用，扫描中只允许一个 pending。 */
  async function refresh(force = false) {
    if (!force && refreshedAt !== null && now() - refreshedAt < cacheTtlMs) return { refreshed: false, count: entries.size, visited: 0, truncated: false, at: refreshedAt };
    if (pending) return pending;
    pending = (async () => {
      const next = new Map();
      const state = { visited: 0 };
      for (const directory of roots) await scanRoot(directory, next, state);
      entries = next;
      refreshedAt = now();
      const truncated = state.visited >= maxScanEntries;
      emit("progress", { phase: "refreshed", count: entries.size, visited: state.visited, truncated, at: refreshedAt });
      return { refreshed: true, count: entries.size, visited: state.visited, truncated, at: refreshedAt };
    })().finally(() => { pending = undefined; });
    return pending;
  }

  /** 源 :101-102 —— 只回 id / families / bytes；这里加分页，不改单条形状。 */
  async function listFonts(page = {}) {
    await refresh(page.refresh === true);
    const { limit, offset } = domain.normalizePage(page);
    const all = [...entries.values()].map((entry) => ({ id: entry.id, families: entry.families, bytes: entry.bytes }));
    const safeOffset = Math.min(offset, all.length);
    const fonts = all.slice(safeOffset, safeOffset + limit);
    return {
      fonts,
      total: all.length,
      offset: safeOffset,
      limit,
      hasMore: safeOffset + fonts.length < all.length,
      source: "host",
      rootCount: roots.length,
    };
  }

  /**
   * 源 :103-112 —— 读单个字体字节。
   * 校验顺序有意与源不同：先判"是否超上限"，再判"是否变更"，
   * 这样 64 MB 上限有一个独立、可判别（SYSTEM_FONTS_TOO_LARGE）的失败码，
   * 不会和其它变更原因混在一个错误里；两条判定本身与源 :109 完全一致。
   */
  async function readFont(id) {
    if (!domain.isSystemFontId(id)) throw domain.createSystemFontsError(domain.SYSTEM_FONTS_ERR_INVALID_INPUT, "字体 ID 无效", { id: id == null ? null : String(id).slice(0, 64) });
    await refresh(false);
    const entry = entries.get(id);
    if (!entry) throw domain.createSystemFontsError(domain.SYSTEM_FONTS_ERR_NOT_FOUND, "字体不存在，请重新打开字体列表", { id });
    try {
      const safe = await io.realpath(entry.path);
      if (safe !== entry.path || !domain.isWithin(entry.root, safe)) throw domain.createSystemFontsError(domain.SYSTEM_FONTS_ERR_NOT_FOUND, "字体路径无效", { id });
      const handle = await io.open(safe, "r");
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > maxBytes) throw domain.createSystemFontsError(domain.SYSTEM_FONTS_ERR_TOO_LARGE, "字体文件超过 64 MB 上限", { id, size: info.size, maxBytes });
        if (info.size !== entry.bytes || info.mtimeMs !== entry.mtime) throw domain.createSystemFontsError(domain.SYSTEM_FONTS_ERR_CHANGED, "字体已变更，请重新打开字体列表", { id });
        const data = await handle.readFile();
        return { id, bytes: data.length, families: entry.families, encoding: "base64url", data: domain.encodeFontBytes(data) };
      } finally {
        try { await handle.close(); } catch { /* 关闭失败不覆盖主结果 */ }
      }
    } catch (err) {
      if (domain.isSystemFontsError(err)) throw err;
      // 源 :119 的 HTTP catch 把所有读取期失败收敛成 404；IPC 侧对应 NOT_FOUND。
      throw domain.createSystemFontsError(domain.SYSTEM_FONTS_ERR_NOT_FOUND, "字体不可用或已变更", { id });
    }
  }

  /** 只读缓存事实，供健康检查与测试；绝不出绝对路径，进 IPC 也会被脱敏（故不注册为命令）。 */
  function stats() {
    return { count: entries.size, refreshedAt, rootCount: roots.length, maxBytes, cacheTtlMs, maxScanDepth, maxScanEntries };
  }

  function setEventSink(sink) {
    eventSink = typeof sink === "function" ? sink : null;
    return true;
  }

  return { roots: roots.slice(), listFonts, readFont, refresh, stats, setEventSink };
}

module.exports = { createSystemFontsService, defaultIoAdapter, readTableBytes };
