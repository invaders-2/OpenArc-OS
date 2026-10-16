/**
 * photos 域 · 存储层（来源清单 + 虚拟文件夹 + 本地目录索引 + 相对路径围栏）。
 *
 * 逐函数移植自只读源 server/photoSources.ts（行号为源行号）：
 *   · :11-13   落盘根 photos / sources-shared.json / sources-<sha256(userId)>.json
 *   · :15-20   parseLibrary —— 文件损坏时回空库，绝不让坏 JSON 崩掉整个域
 *   · :21-35   readSharedSources —— 兼容旧的按账号来源索引（保留 source.id，local: URL 不失效）
 *   · :36-39   read —— 来源共享、文件夹与归属按用户隔离
 *   · :40-49   saveSharedSources / savePersonal（原子写；源 :48 的 savePersonal 是直写）
 *   · :50-64   addPhotoSource / removePhotoSource
 *   · :65-95   createPhotoFolder / removePhotoFolder / assignPhotoFolder
 *   · :96-114  resolvePhotoSourceFile —— id 前缀 + 相对路径围栏 + realpath 二次围栏
 *   · :115-145 listPhotoSources 的目录递归
 *
 * 落盘位置（任务要求：必须在既有 dxos 数据根之下）：<userData>/dxos/photos。
 * 用 resolveDxosPaths 而不是自己拼 "<userData>/dxos"：dxos-foundation-paths.cjs:29-37 是
 * DX 数据根的唯一定义处；但**不**把 photos 加进 DXOS_LAYOUT.directories ——
 * dxos-foundation.test.mjs 精确断言该数组内容（同类取舍见 file-transfer-service.cjs:14-17），
 * 首次写入时本模块自建目录。
 *
 * 为什么同步 fs：源 photoSources.ts 全是同步读写，且单次目录索引是 24 层 / 10 万条上限的
 * 一次性操作；换成异步只会让调用面复杂，不改变语义。命令入口本身是 async，不阻塞事件循环之外的东西。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const domain = require("./photos-domain.cjs");
const { resolveDxosPaths } = require("./dxos-foundation-paths.cjs");

/** <userData>/dxos/photos（源 photoSources.ts:11 dataPath('photos')）。 */
const PHOTOS_ROOT_NAME = domain.PHOTOS_DIR_NAME;
const THUMBNAIL_CACHE_DIR_NAME = path.join("cache", "photo-thumbnails");

/** 解析并围栏 photos 落盘根：必须严格落在 <userData>/dxos 之下。 */
function resolvePhotosRoot(userDataDir) {
  const dxosRoot = resolveDxosPaths(userDataDir).root;
  const root = path.join(dxosRoot, PHOTOS_ROOT_NAME);
  if (!domain.isContainedPath(dxosRoot, root)) {
    throw domain.createPhotosError(domain.PHOTOS_ERR_PATH_ESCAPE, "photos 目录不在 dxos 数据根之下");
  }
  return root;
}

function emptyLibrary() {
  return { sources: [], folders: [], assignments: {} };
}

class DiskPhotoLibrary {
  constructor({ root, clock = null, logger = null } = {}) {
    if (typeof root !== "string" || !root.trim()) throw new Error("DiskPhotoLibrary 需要 root");
    this.root = path.resolve(root);
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.logger = logger || null;
  }

  now() {
    return this.clock();
  }

  directoryPath() {
    return this.root;
  }

  sharedFilePath() {
    return path.join(this.root, domain.PHOTOS_SOURCES_SHARED_FILE);
  }

  userFilePath(userId) {
    return path.join(this.root, domain.photosUserFileName(userId));
  }

  thumbnailCachePath(key) {
    return path.join(this.root, THUMBNAIL_CACHE_DIR_NAME, key + ".jpg");
  }

  /** 源 photoSources.ts:15-20：坏 JSON / 缺字段都退化成空库，不抛。 */
  #parseLibrary(file) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return {
        sources: Array.isArray(data && data.sources) ? data.sources : [],
        folders: Array.isArray(data && data.folders) ? data.folders : [],
        assignments: data && typeof data.assignments === "object" && data.assignments ? data.assignments : {},
      };
    } catch {
      return emptyLibrary();
    }
  }

  /** 原子写：临时文件 + rename，避免掉电/并发写坏来源清单。 */
  #atomicWrite(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + "." + randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temporary, text);
      fs.renameSync(temporary, file);
    } catch (error) {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* 清理失败不覆盖原错误 */ }
      throw error;
    }
  }

  /** 源 photoSources.ts:21-35：主文件缺失时从旧的按账号索引里回收来源并升级为共享文件。 */
  readSharedSources() {
    const shared = this.sharedFilePath();
    if (fs.existsSync(shared)) return this.#parseLibrary(shared).sources;
    const sources = [];
    if (!fs.existsSync(this.root)) return sources;
    let names = [];
    try { names = fs.readdirSync(this.root); } catch { return sources; }
    for (const name of names.filter((item) => domain.PHOTOS_SOURCES_LEGACY_RE.test(item)).sort()) {
      const legacy = this.#parseLibrary(path.join(this.root, name));
      for (const source of legacy.sources) {
        if (!source || typeof source.id !== "string") continue;
        if (!sources.some((item) => item.id === source.id)) sources.push(source);
      }
    }
    if (sources.length) this.saveSharedSources(sources);
    return sources;
  }

  saveSharedSources(sources) {
    this.#atomicWrite(this.sharedFilePath(), JSON.stringify({ sources }, null, 2));
  }

  /** 源 photoSources.ts:36-39：来源共享，个人组织信息按 userId 隔离。 */
  read(userId) {
    const personal = this.#parseLibrary(this.userFilePath(userId));
    return { sources: this.readSharedSources(), folders: personal.folders, assignments: personal.assignments };
  }

  savePersonal(userId, data) {
    this.#atomicWrite(this.userFilePath(userId), JSON.stringify({ folders: data.folders, assignments: data.assignments }, null, 2));
  }

  /** 源 photoSources.ts:50-61。真实路径去重：软链接到同一目录不会产生第二条来源。 */
  addSource(requestedPath) {
    const input = domain.normalizeSourcePath(requestedPath);
    let real;
    try {
      real = fs.realpathSync(path.resolve(input));
    } catch {
      throw domain.createPhotosError(domain.PHOTOS_ERR_NOT_FOUND, "文件夹不存在或不可访问");
    }
    let stat;
    try { stat = fs.statSync(real); } catch { throw domain.createPhotosError(domain.PHOTOS_ERR_NOT_FOUND, "文件夹不存在或不可访问"); }
    if (!stat.isDirectory()) throw domain.createPhotosError(domain.PHOTOS_ERR_INVALID_INPUT, "请选择文件夹");
    const sources = this.readSharedSources();
    const existing = sources.find((source) => source && source.path === real);
    if (existing) return { source: existing, created: false };
    const source = { id: randomUUID(), name: path.basename(real) || real, path: real };
    sources.push(source);
    this.saveSharedSources(sources);
    return { source, created: true };
  }

  /** 源 photoSources.ts:62-64：源是静默过滤；本仓按验收要求把未知 id 暴露成 NOT_FOUND。 */
  removeSource(id) {
    const sources = this.readSharedSources();
    const existing = sources.find((source) => source && source.id === id);
    if (!existing) throw domain.createPhotosError(domain.PHOTOS_ERR_NOT_FOUND, "照片来源不存在");
    this.saveSharedSources(sources.filter((source) => source && source.id !== id));
    return { id, removed: true };
  }

  /** 源 photoSources.ts:65-73。 */
  createFolder(userId, name, parentId) {
    const clean = domain.normalizeFolderName(name);
    const data = this.read(userId);
    if (parentId && !data.folders.some((folder) => folder && folder.id === parentId)) {
      throw domain.createPhotosError(domain.PHOTOS_ERR_NOT_FOUND, "上级文件夹不存在");
    }
    const folder = { id: randomUUID(), name: clean, parentId: parentId || null };
    data.folders.push(folder);
    this.savePersonal(userId, data);
    return folder;
  }

  /** 源 photoSources.ts:74-85：级联删子文件夹，并清掉这些文件夹上的全部归属。 */
  removeFolder(userId, id) {
    const data = this.read(userId);
    if (!data.folders.some((folder) => folder && folder.id === id)) {
      throw domain.createPhotosError(domain.PHOTOS_ERR_NOT_FOUND, "文件夹不存在");
    }
    const removed = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of data.folders) {
        if (folder && folder.parentId && removed.has(folder.parentId) && !removed.has(folder.id)) {
          removed.add(folder.id);
          changed = true;
        }
      }
    }
    data.folders = data.folders.filter((folder) => folder && !removed.has(folder.id));
    data.assignments = Object.fromEntries(Object.entries(data.assignments).filter(([, folderId]) => !removed.has(folderId)));
    this.savePersonal(userId, data);
    return { id, removed: true, removedFolderIds: [...removed] };
  }

  /** 源 photoSources.ts:86-95：folderId=null 表示移出；解析不到的图片 id 记入 skipped。 */
  assignFolder(userId, ids, folderId) {
    const data = this.read(userId);
    if (folderId && !data.folders.some((folder) => folder && folder.id === folderId)) {
      throw domain.createPhotosError(domain.PHOTOS_ERR_NOT_FOUND, "文件夹不存在");
    }
    let assigned = 0;
    let cleared = 0;
    const skipped = [];
    // 批量归类只读一次来源清单：源 photoSources.ts:89-90 逐条 resolve 会重复读文件。
    const sources = this.readSharedSources();
    for (const id of ids) {
      if (!this.#resolveWithSources(sources, id)) {
        skipped.push(id);
        continue;
      }
      if (folderId) {
        data.assignments[id] = folderId;
        assigned += 1;
      } else if (data.assignments[id]) {
        delete data.assignments[id];
        cleared += 1;
      }
    }
    this.savePersonal(userId, data);
    return { folderId: folderId || null, assigned, cleared, skipped };
  }

  /**
   * 源 photoSources.ts:96-114：local:<sourceId>:<relativePath>。
   * 两层围栏：先做纯路径围栏（parseLocalPhotoId），再用 realpath 校验目录内 + 真实文件 + 媒体白名单。
   */
  resolveSourceFile(userId, id) {
    return this.#resolveWithSources(this.readSharedSources(), id);
  }

  /** 从已读入的来源清单里解析（避免同一批操作重复读盘）。 */
  #resolveWithSources(sources, id) {
    const parsed = domain.parseLocalPhotoId(id);
    if (!parsed) return null;
    const source = sources.find((item) => item && item.id === parsed.sourceId);
    if (!source || typeof source.path !== "string") return null;
    let sourceReal;
    try { sourceReal = fs.realpathSync(source.path); } catch { return null; }
    const target = path.resolve(sourceReal, parsed.relativePath);
    const inside = path.relative(sourceReal, target);
    if (inside.startsWith("..") || path.isAbsolute(inside)) return null;
    try {
      const real = fs.realpathSync(target);
      const realInside = path.relative(sourceReal, real);
      if (realInside.startsWith("..") || path.isAbsolute(realInside)) return null;
      if (!fs.statSync(real).isFile()) return null;
      const mime = domain.photosMimeForName(real);
      if (!mime) return null;
      const stat = fs.statSync(real);
      return { path: real, name: path.basename(real), mime, size: stat.size, updated_ts: stat.mtimeMs / 1000 };
    } catch {
      return null;
    }
  }

  /**
   * 源 photoSources.ts:115-145 的目录递归（不含虚拟树图库）。
   * 与源差异：条目/文件夹稳定排序；显式分页；来源/文件夹/虚拟文件夹超 100 条时给 truncated 标记，
   * 避免 foundation redactValue 把数组静默截到 100 项时渲染层无从判断。
   */
  listSources(userId, pagination) {
    const data = this.read(userId);
    const items = [];
    const folders = [];
    let walkCapReached = false;
    for (const source of data.sources) {
      if (!source || typeof source.path !== "string" || typeof source.id !== "string") continue;
      let sourceReal;
      try { sourceReal = fs.realpathSync(source.path); } catch { continue; }
      const rootFolderId = "local-root:" + source.id;
      const visited = new Set();
      const stack = [{ directory: sourceReal, parentId: rootFolderId, depth: 0 }];
      while (stack.length) {
        const current = stack.pop();
        if (current.depth > domain.PHOTOS_MAX_WALK_DEPTH || items.length > domain.PHOTOS_MAX_INDEX_ITEMS) {
          walkCapReached = true;
          break;
        }
        let entries;
        try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const full = path.join(current.directory, entry.name);
          const relative = path.relative(sourceReal, full).split(path.sep).join("/");
          if (!relative || relative.startsWith("..")) continue;
          // 源 photoSources.ts:127：目录 id = local-folder:<sourceId>:<relativePath>。
          if (entry.isDirectory()) {
            const folderId = "local-folder:" + source.id + ":" + relative;
            if (visited.has(folderId)) continue;
            visited.add(folderId);
            folders.push({ id: folderId, name: entry.name, parentId: current.parentId, sourceId: source.id, path: relative });
            stack.push({ directory: full, parentId: folderId, depth: current.depth + 1 });
            continue;
          }
          if (!entry.isFile()) continue;
          const mime = domain.photosMimeForName(entry.name);
          if (!mime) continue;
          try {
            const stat = fs.statSync(full);
            const id = domain.PHOTOS_LOCAL_PREFIX + source.id + ":" + relative;
            items.push({ id, name: entry.name, sourceId: source.id, relativePath: relative, folderPath: relative.split("/").slice(0, -1).join("/"), mime, size: stat.size, updated_ts: stat.mtimeMs / 1000 });
          } catch { /* 文件在索引时被移动（源 photoSources.ts:139 同一取舍） */ }
        }
      }
    }
    items.sort((left, right) => left.relativePath.localeCompare(right.relativePath) || left.id.localeCompare(right.id));
    folders.sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id));
    const sourceViews = data.sources.map((source) => ({
      id: source && source.id,
      name: source && source.name,
      available: !!(source && typeof source.path === "string" && fs.existsSync(source.path)),
    })).sort((left, right) => String(left.name).localeCompare(String(right.name)) || String(left.id).localeCompare(String(right.id)));
    const page = domain.paginate(items, pagination);
    const MAX = domain.PHOTOS_PAGE_LIMIT_MAX;
    return {
      sources: sourceViews.slice(0, MAX),
      sourcesTotal: sourceViews.length,
      sourcesTruncated: sourceViews.length > MAX,
      folders: folders.slice(0, MAX).map((folder) => ({ id: folder.id, name: folder.name, parentId: folder.parentId, sourceId: folder.sourceId, path: folder.path })),
      foldersTotal: folders.length,
      foldersTruncated: folders.length > MAX,
      virtualFolders: data.folders.slice(0, MAX).map((folder) => ({ id: folder.id, name: folder.name, parentId: folder.parentId == null ? null : folder.parentId })),
      virtualFoldersTotal: data.folders.length,
      virtualFoldersTruncated: data.folders.length > MAX,
      items: page.items.map((item) => domain.photoItemView(item, data.assignments[item.id])),
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      truncated: page.truncated,
      walkCapReached,
    };
  }

  /** 缩略图缓存键：路径 + mtime + size + 尺寸；源文件改了就不会命中旧缩略图。 */
  thumbnailCacheKey(file, size) {
    return domain.signatureHash([file.path, String(file.updated_ts), String(file.size), String(size)].join("\0")).slice(0, 48);
  }

  snapshot() {
    let sourceCount = 0;
    try { sourceCount = this.readSharedSources().length; } catch { sourceCount = 0; }
    return { sources: sourceCount };
  }
}

module.exports = { DiskPhotoLibrary, resolvePhotosRoot, PHOTOS_ROOT_NAME, THUMBNAIL_CACHE_DIR_NAME, emptyLibrary };
