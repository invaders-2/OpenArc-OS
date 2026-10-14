/**
 * B6c · 平台域装配 + platform:command 分发（唯一执行入口）。
 *
 * 装真实模块（不 mock、不新增依赖）：
 *   · server/appDiagnostics.ts:4-8      sanitize → platform-domain.sanitizePlatformText
 *   · server/appDiagnostics.ts:10-23    recordAppRuntimeEvent / appRuntimeDiagnostics
 *   · server/processDiagnostics.ts:44-115 diagnosticsDirectory / rotate / startProcessDiagnostics
 *   · server/systemDataProtection.ts    create / verify / restore / checkCurrentDataIntegrity
 *   · server/networkSafety.ts           platform-domain 的纯判定 + 这里的 DNS 解析（可注入）
 *   · server/providerTestSafety.ts      platform-domain 的三个纯函数
 *   · dxos-foundation-paths.cjs         <userData>/dxos 布局（diagnostics 已在册；
 *                                       backups 按任务书要求落在 <userData>/dxos/backups，
 *                                       本文件用 paths.root 拼出，不改地基模块）
 *   · dxos-foundation-events/errors     事件信封与脱敏（失败形状与 agent / skill / media 一致）
 *
 * 边界：
 *   · 渲染层自报的 userId / role / appId / sessionRef 一律忽略；actor 由 authorization.resolveActor
 *     从可信 sessionRef 推导（与 media-service.cjs:557-566 同一条边界）。
 *   · 返回值统一过 platform-domain.redactPlatformValue —— 不含绝对路径、不含环境变量、
 *     不含 credential-store 的明文；快照明文排除 credentials 目录（硬约束）。
 *   · DNS 解析器可通过 options.lookup 注入；默认才用 node:dns/promises（测试全部离线注入）。
 *   · 诊断输出绝不读 process.env；主进程内存 / 句柄只在主进程内计算。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const { resolveDxosPaths, ensureDxosLayout } = require("./dxos-foundation-paths.cjs");
const platformDomain = require("./platform-domain.cjs");
const foundationErrors = require("./dxos-foundation-errors.cjs");

const {
  createPlatformError,
  normalizePlatformError,
  redactPlatformValue,
  isPlatformCommand,
  platformCommandNotAllowed,
  listPlatformCommands,
  sanitizePlatformText,
  PLATFORM_ERR_INVALID_INPUT,
  PLATFORM_ERR_UNAUTHENTICATED,
  PLATFORM_ERR_DEPENDENCY_UNAVAILABLE,
  PLATFORM_ERR_INTEGRITY_FAILED,
  PLATFORM_ERR_RESTORE_FAILED,
} = platformDomain;

/** 平台能力承载的 App Principal：与 media-service.cjs:62 / skill-service.cjs / agent-service.cjs 同一约定。 */
const HOST_APP_ID = "ai";

/** 快照根目录名：<userData>/dxos/backups（任务书要求；源 systemDataProtection.ts:15 为 dataPath('backups','system')）。 */
const BACKUPS_DIR_NAME = "backups";

/** 快照采集**绝不触碰**的顶层目录：备份自身（避免递归）、凭据（硬约束：不含明文密钥）、CLI 临时目录。 */
const EXCLUDED_TOP_LEVEL = new Set([BACKUPS_DIR_NAME, "credentials", "cli-temp"]);

/** 源 systemDataProtection.ts:34：临时 / WAL 文件不进入快照。 */
const TRANSIENT_FILE_RE = /(?:^|[.-])(?:tmp|shm|wal)$/i;

/** 源 systemDataProtection.ts:100 的 JSON 完整性清单 + OpenArc 既有可能存在的两份。 */
const INTEGRITY_FILES = Object.freeze(["providers.json", "skills.json", "mcp.json", "mcp.system.json", "custom-protocols.json", "fs.json"]);

/** 存储占用 / 快照采集的遍历上限（避免大目录把主进程拖死）。 */
const MAX_SCAN_ENTRIES = 20000;
const MAX_SCAN_DEPTH = 6;

const asStr = (value, max = 512) => (typeof value === "string" ? value.slice(0, max) : value == null ? undefined : String(value).slice(0, max));
const requireStr = (value, max = 512) => { const text = asStr(value, max); return text && text.length ? text : null; };
const clampInt = (value, min, max, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
};

/** 惰性取 identity-store 的 schema 常量，避免与地基模块形成硬耦合。 */
let identityStoreModule = null;
function schemaConstants() {
  if (!identityStoreModule) {
    try { identityStoreModule = require("./identity-store.cjs"); } catch { identityStoreModule = null; }
  }
  return {
    SCHEMA_VERSION: identityStoreModule && Number.isFinite(identityStoreModule.SCHEMA_VERSION) ? identityStoreModule.SCHEMA_VERSION : null,
    MIGRATIONS: identityStoreModule && Array.isArray(identityStoreModule.MIGRATIONS) ? identityStoreModule.MIGRATIONS : [],
  };
}

function hashFile(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function createPlatformBundle(options = {}) {
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const logger = typeof options.logger === "function" ? options.logger : null;
  const userDataDir = options.userDataDir || null;
  const identityStore = options.identityStore || null;
  const authorization = options.authorization || null;
  const appVersion = asStr(options.appVersion, 60) || "unknown";
  const appName = asStr(options.appName, 80) || "OpenArc OS";
  const environmentInfo = options.environment && typeof options.environment === "object" && !Array.isArray(options.environment) ? options.environment : {};
  const processesProvider = typeof options.processes === "function" ? options.processes : () => [];
  const metricsProvider = typeof options.metrics === "function" ? options.metrics : () => ({});
  const injectedLookup = typeof options.lookup === "function" ? options.lookup : null;

  const paths = userDataDir ? resolveDxosPaths(userDataDir) : null;
  const dataRoot = paths ? paths.root : null;
  const backupsRoot = dataRoot ? path.join(dataRoot, BACKUPS_DIR_NAME) : null;
  const diagnosticsDir = paths ? paths.directory.diagnostics : null;
  const db = identityStore ? identityStore.connection || identityStore.db || null : null;

  if (dataRoot) {
    try { ensureDxosLayout(userDataDir); } catch { /* 装配不阻断：具体命令再抛结构化落盘错误 */ }
    try { fs.mkdirSync(backupsRoot, { recursive: true }); } catch { /* 同上 */ }
  }

  function assertStorage() {
    if (!dataRoot || !backupsRoot) throw createPlatformError(PLATFORM_ERR_DEPENDENCY_UNAVAILABLE, "平台数据目录未装配（缺少 userDataDir）", { dependency: "userDataDir" });
    return { dataRoot, backupsRoot };
  }

  // -------------------------------------------------------------------------
  // 数据保护：快照创建 / 校验 / 列表 / 恢复（源 systemDataProtection.ts）
  // -------------------------------------------------------------------------

  /** 源 systemDataProtection.ts:29-40 collectFiles —— 顶层排除 + 临时文件排除 + 只收普通文件。 */
  function collectDataFiles(folder, root = folder) {
    if (!fs.existsSync(folder)) return [];
    const files = [];
    let entries;
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return []; }
    for (const entry of entries) {
      if (root === folder && EXCLUDED_TOP_LEVEL.has(entry.name)) continue;
      if (TRANSIENT_FILE_RE.test(entry.name)) continue;
      const absolute = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...collectDataFiles(absolute, root));
      else if (entry.isFile()) files.push({ absolute, path: path.relative(root, absolute).split(path.sep).join("/") });
    }
    return files;
  }

  /** 源 systemDataProtection.ts:42-66 createSystemDataSnapshot（落盘根改为 <userData>/dxos/backups）。 */
  function createSnapshot(reason = "manual-backup") {
    const { backupsRoot: root } = assertStorage();
    fs.mkdirSync(root, { recursive: true });
    const id = new Date(clock()).toISOString().replace(/[:.]/g, "-").toLowerCase() + "-" + randomUUID().slice(0, 8);
    const staging = platformDomain.snapshotPathWithin(root, id + "-staging");
    const target = platformDomain.snapshotPathWithin(root, id);
    const payload = path.join(staging, "data");
    fs.mkdirSync(payload, { recursive: true });
    const files = collectDataFiles(dataRoot);
    for (const file of files) {
      const destination = path.join(payload, file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(file.absolute, destination, fs.constants.COPYFILE_EXCL);
    }
    const manifest = {
      format: platformDomain.SNAPSHOT_FORMAT,
      id,
      reason: String(reason || "manual-backup").slice(0, 120),
      createdAt: clock(),
      dataLayoutVersion: 1,
      files: files.map((file) => {
        const copied = path.join(payload, file.path);
        return { path: file.path, size: fs.statSync(copied).size, sha256: hashFile(copied) };
      }),
    };
    fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    fs.renameSync(staging, target);
    return { manifest, relativeDir: path.posix.join(BACKUPS_DIR_NAME, id), fileCount: manifest.files.length };
  }

  /** 源 systemDataProtection.ts:68-80 verifySystemDataSnapshot（损坏返回决策而不是抛错，便于 IPC 稳定投影）。 */
  function verifySnapshot(id) {
    assertStorage();
    const root = platformDomain.snapshotPathWithin(backupsRoot, id);
    const manifestPath = path.join(root, "manifest.json");
    if (!fs.existsSync(manifestPath)) return { valid: false, manifest: null, failures: ["manifest.json: missing"] };
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
    catch { return { valid: false, manifest: null, failures: ["manifest.json: unreadable"] }; }
    if (!manifest || manifest.format !== platformDomain.SNAPSHOT_FORMAT || manifest.id !== platformDomain.safeSnapshotId(id)) {
      return { valid: false, manifest: null, failures: ["manifest.json: format"] };
    }
    const failures = [];
    const payload = path.resolve(root, "data");
    for (const file of Array.isArray(manifest.files) ? manifest.files : []) {
      const resolved = path.resolve(payload, String(file.path || ""));
      if (!resolved.startsWith(payload + path.sep) || !fs.existsSync(resolved)) { failures.push(String(file.path || "?") + ": missing"); continue; }
      const stat = fs.statSync(resolved);
      if (stat.size !== file.size || hashFile(resolved) !== file.sha256) failures.push(String(file.path || "?") + ": checksum");
    }
    return { valid: failures.length === 0, manifest, failures };
  }

  function listSnapshots() {
    assertStorage();
    if (!fs.existsSync(backupsRoot)) return { snapshots: [] };
    const snapshots = [];
    for (const entry of fs.readdirSync(backupsRoot, { withFileTypes: true })) {
      // 跳过创建中的 staging 目录与恢复暂存的 rollback 目录：它们不是可恢复的快照。
      if (!entry.isDirectory() || entry.name.endsWith("-staging") || entry.name.startsWith("rollback-")) continue;
      if (!/^[a-z0-9][a-z0-9-]{5,100}$/.test(entry.name)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(backupsRoot, entry.name, "manifest.json"), "utf8"));
        snapshots.push({ id: entry.name, reason: asStr(manifest.reason, 120) || null, createdAt: Number.isFinite(manifest.createdAt) ? manifest.createdAt : null, fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0 });
      } catch {
        snapshots.push({ id: entry.name, reason: null, createdAt: null, fileCount: 0, unreadable: true });
      }
    }
    return { snapshots: snapshots.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) };
  }

  /**
   * 源 systemDataProtection.ts:82-96 restoreSystemDataSnapshot + 失败回滚。
   *
   * 源在恢复前直接删除全部数据目录；本实现改为**先搬到回滚目录**，复制失败时原样搬回，
   * 保证"恢复失败不丢数据"（任务书要求：校验与失败回滚）。
   * databasesClosed 必须由调用方显式声明为 true（源 :84 同一前置）。
   */
  function restoreSnapshot(id, databasesClosed = false) {
    const { dataRoot: root, backupsRoot: rootBackups } = assertStorage();
    if (databasesClosed !== true) throw createPlatformError(PLATFORM_ERR_INVALID_INPUT, "恢复数据快照前必须停止 DX OS 数据库服务");
    const verified = verifySnapshot(id);
    if (!verified.valid) throw createPlatformError(PLATFORM_ERR_INTEGRITY_FAILED, "数据快照校验失败：" + verified.failures.join("；"), { failures: verified.failures });
    const payload = path.join(platformDomain.snapshotPathWithin(rootBackups, id), "data");
    const rollback = platformDomain.snapshotPathWithin(rootBackups, "rollback-" + platformDomain.safeSnapshotId(id));
    try { fs.rmSync(rollback, { recursive: true, force: true }); } catch { /* 上一次残留 */ }
    fs.mkdirSync(rollback, { recursive: true });
    const moved = [];
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.name === BACKUPS_DIR_NAME) continue;
        const target = path.join(root, entry.name);
        if (path.resolve(target) === path.resolve(rootBackups)) continue;
        fs.renameSync(target, path.join(rollback, entry.name));
        moved.push(entry.name);
      }
    } catch (error) {
      // 搬迁中途失败：把已搬走的原样放回，绝不留下"半空"的数据目录。
      for (const name of moved) {
        try { fs.renameSync(path.join(rollback, name), path.join(root, name)); } catch { /* 尽力而为 */ }
      }
      throw createPlatformError(PLATFORM_ERR_RESTORE_FAILED, "恢复数据快照失败（数据未改动）：" + String((error && error.message) || error));
    }
    try {
      for (const entry of fs.readdirSync(payload, { withFileTypes: true })) {
        fs.cpSync(path.join(payload, entry.name), path.join(root, entry.name), { recursive: true });
      }
    } catch (error) {
      // 复制失败：清掉半成品，再把回滚目录搬回。
      for (const name of moved) { try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); } catch { /* 尽力而为 */ } }
      for (const name of moved) { try { fs.renameSync(path.join(rollback, name), path.join(root, name)); } catch { /* 尽力而为 */ } }
      throw createPlatformError(PLATFORM_ERR_RESTORE_FAILED, "恢复数据快照失败，已回滚到恢复前状态：" + String((error && error.message) || error));
    }
    return { manifest: verified.manifest, restoredFiles: verified.manifest.files.length, rollbackRelativeDir: path.posix.join(BACKUPS_DIR_NAME, path.basename(rollback)) };
  }

  /** 源 systemDataProtection.ts:98-106 checkCurrentDataIntegrity（dataRoot 以占位符回渲染层）。 */
  function checkDataIntegrity() {
    if (!dataRoot) return { ok: false, dataRoot: "<userData>/dxos", available: false, failures: ["dataRoot: missing"] };
    const failures = [];
    for (const name of INTEGRITY_FILES) {
      const file = path.join(dataRoot, name);
      if (!fs.existsSync(file)) continue;
      try { JSON.parse(fs.readFileSync(file, "utf8")); } catch { failures.push(name + ": JSON 损坏"); }
    }
    return { ok: failures.length === 0, dataRoot: "<userData>/dxos", available: true, failures };
  }

  // -------------------------------------------------------------------------
  // 诊断（源 appDiagnostics.ts / processDiagnostics.ts）
  // -------------------------------------------------------------------------

  function tableExists(name) {
    if (!db) return false;
    try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name); } catch { return false; }
  }

  /** 源 appDiagnostics.ts:15-23 appRuntimeDiagnostics（表不存在时返回空集合而不是伪造）。 */
  function appRuntimeDiagnostics(appId, days = 30) {
    const since = clock() - clampInt(days, 1, 90, 30) * 86_400_000;
    const empty = { appId, since: null, summary: [], recent: [], network: [] };
    if (!db || !appId || !tableExists("app_runtime_events")) return empty;
    let summary = [];
    let recent = [];
    try {
      summary = db.prepare("SELECT version,build,event_type AS eventType,COUNT(*) AS count,MAX(created_at) AS lastAt FROM app_runtime_events WHERE app_id=? AND created_at>=? GROUP BY version,build,event_type ORDER BY lastAt DESC").all(String(appId), since);
    } catch { summary = []; }
    try {
      recent = db.prepare("SELECT version,build,event_type AS eventType,detail,created_at AS createdAt FROM app_runtime_events WHERE app_id=? AND created_at>=? ORDER BY created_at DESC LIMIT 100").all(String(appId), since);
    } catch { recent = []; }
    let network = [];
    if (tableExists("app_network_audit")) {
      try {
        network = db.prepare("SELECT origin,method,status,COUNT(*) AS count,SUM(response_bytes) AS responseBytes,MAX(created_at) AS lastAt FROM app_network_audit WHERE app_id=? AND created_at>=? GROUP BY origin,method,status ORDER BY lastAt DESC LIMIT 100").all(String(appId), since);
      } catch { network = []; }
    }
    return { appId, since, summary, recent, network };
  }

  function databaseStatus() {
    if (!db) return { available: false, ok: null, integrity: null, userVersion: null, schemaVersion: null, sizeBytes: null, fileName: null };
    let integrity = null;
    let ok = null;
    try {
      const rows = db.prepare("PRAGMA quick_check").all();
      integrity = Array.isArray(rows) && rows.length ? String(Object.values(rows[0])[0]) : "unknown";
      ok = integrity === "ok";
    } catch { integrity = "unavailable"; ok = false; }
    let userVersion = null;
    try { userVersion = Number(db.prepare("PRAGMA user_version").get().user_version); } catch { userVersion = null; }
    let sizeBytes = null;
    const dbPath = identityStore && typeof identityStore.path === "string" ? identityStore.path : null;
    if (dbPath) { try { sizeBytes = fs.statSync(dbPath).size; } catch { sizeBytes = null; } }
    const { SCHEMA_VERSION } = schemaConstants();
    return { available: true, ok, integrity, userVersion, schemaVersion: SCHEMA_VERSION, sizeBytes, fileName: dbPath ? path.basename(dbPath) : null };
  }

  function migrationStatus() {
    const { SCHEMA_VERSION, MIGRATIONS } = schemaConstants();
    let current = null;
    try { current = db ? Number(db.prepare("PRAGMA user_version").get().user_version) : null; } catch { current = null; }
    const pending = MIGRATIONS.filter((migration) => Number(migration && migration.version) > (current == null ? 0 : current)).map((migration) => migration.version);
    return { current, supported: SCHEMA_VERSION, pending, upToDate: pending.length === 0 };
  }

  /** 有界遍历：只统计字节 / 文件数，绝不返回绝对路径。 */
  function measureTree(root) {
    let bytes = 0;
    let files = 0;
    let visited = 0;
    const walk = (folder, depth) => {
      if (visited >= MAX_SCAN_ENTRIES || depth > MAX_SCAN_DEPTH) return;
      let entries;
      try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (visited >= MAX_SCAN_ENTRIES) return;
        visited += 1;
        const absolute = path.join(folder, entry.name);
        try {
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) walk(absolute, depth + 1);
          else if (entry.isFile()) { bytes += fs.statSync(absolute).size; files += 1; }
        } catch { /* 单项失败不改变整体统计 */ }
      }
    };
    walk(root, 0);
    return { bytes, files };
  }

  function storageUsage() {
    if (!dataRoot) return { available: false, categories: [], totalBytes: 0, totalFiles: 0 };
    const categories = [];
    let totalBytes = 0;
    let totalFiles = 0;
    let entries = [];
    try { entries = fs.readdirSync(dataRoot, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      const absolute = path.join(dataRoot, entry.name);
      let usage = { bytes: 0, files: 0 };
      if (entry.isDirectory()) usage = measureTree(absolute);
      else if (entry.isFile()) { try { usage = { bytes: fs.statSync(absolute).size, files: 1 }; } catch { usage = { bytes: 0, files: 0 }; } }
      else continue;
      categories.push({ name: entry.name, bytes: usage.bytes, files: usage.files });
      totalBytes += usage.bytes;
      totalFiles += usage.files;
    }
    categories.sort((a, b) => b.bytes - a.bytes);
    return { available: true, categories, totalBytes, totalFiles };
  }

  function appDiagnostics(input, context) {
    const appId = requireStr(input.appId, 100);
    const days = clampInt(input.days, 1, 90, 30);
    const runtime = appId ? appRuntimeDiagnostics(appId, days) : { appId: null, since: null, summary: [], recent: [], network: [] };
    return {
      generatedAt: clock(),
      app: { name: appName, version: appVersion, actorId: context && context.userId ? String(context.userId) : null },
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        electron: process.versions.electron || null,
        chrome: process.versions.chrome || null,
        locale: asStr(environmentInfo.locale, 40) || null,
      },
      database: databaseStatus(),
      migrations: migrationStatus(),
      storage: storageUsage(),
      integrity: checkDataIntegrity(),
      runtime,
    };
  }

  /** 源 processDiagnostics.ts:59-75 的可投影子集 + 句柄摘要；环境变量从不出现在结果里。 */
  function processDiagnostics() {
    const memory = process.memoryUsage();
    const resources = typeof process.getActiveResourcesInfo === "function" ? process.getActiveResourcesInfo() : [];
    const types = {};
    for (const name of resources) types[String(name)] = (types[String(name)] || 0) + 1;
    const uptimeSeconds = Math.round(process.uptime());
    const main = {
      role: "main",
      pid: process.pid,
      ppid: typeof process.ppid === "number" ? process.ppid : null,
      node: process.version,
      electron: process.versions.electron || null,
      uptimeSeconds,
      startedAt: clock() - uptimeSeconds * 1000,
      memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external, arrayBuffers: memory.arrayBuffers },
      handles: { active: resources.length, types },
    };
    const children = [];
    if (typeof processesProvider === "function") {
      let rows = [];
      try { rows = processesProvider(); } catch { rows = []; }
      for (const row of Array.isArray(rows) ? rows.slice(0, 100) : []) {
        if (!row || typeof row !== "object") continue;
        // 只投影显式白名单字段：绝不透传调用方对象里的 env / executable path。
        children.push({
          source: asStr(row.source, 40) || null,
          instanceId: asStr(row.instanceId, 120) || null,
          pid: Number.isSafeInteger(row.pid) ? row.pid : null,
          role: asStr(row.role, 40) || null,
          status: asStr(row.status, 40) || null,
          startedAt: Number.isFinite(row.startedAt) ? row.startedAt : null,
          endedAt: Number.isFinite(row.endedAt) ? row.endedAt : null,
          exitCode: Number.isFinite(row.exitCode) ? row.exitCode : null,
          signal: asStr(row.signal, 40) || null,
          memory: row.memory && typeof row.memory === "object" ? { rss: Number(row.memory.rss) || 0, heapUsed: Number(row.memory.heapUsed) || 0 } : null,
        });
      }
    }
    return { generatedAt: clock(), main, children };
  }

  /** 源 appDiagnostics.ts:10-13 recordAppRuntimeEvent（userId 由主进程从可信 actor 注入）。 */
  function recordRuntimeEvent(input, context) {
    if (!db) throw createPlatformError(PLATFORM_ERR_DEPENDENCY_UNAVAILABLE, "运行时事件需要数据库连接");
    if (!tableExists("app_runtime_events")) throw createPlatformError(PLATFORM_ERR_DEPENDENCY_UNAVAILABLE, "app_runtime_events 表不存在");
    const appId = requireStr(input.appId, 100);
    if (!appId) throw createPlatformError(PLATFORM_ERR_INVALID_INPUT, "记录运行时事件需要 appId");
    const eventType = requireStr(input.eventType, 60);
    if (!eventType) throw createPlatformError(PLATFORM_ERR_INVALID_INPUT, "记录运行时事件需要 eventType");
    const version = requireStr(input.version, 60) || "0.0.0";
    const build = Number.isFinite(input.build) ? Math.round(input.build) : 0;
    const detail = sanitizePlatformText(input.detail, 4000);
    db.prepare("INSERT INTO app_runtime_events(id,app_id,version,build,user_id,event_type,detail,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(randomUUID(), appId, version, build, context && context.userId ? String(context.userId) : "unknown", eventType.slice(0, 60), detail, clock());
    return { recorded: true, appId, eventType };
  }

  // -------------------------------------------------------------------------
  // 网络安全（源 networkSafety.ts + developerNetwork.ts 同口径）
  // -------------------------------------------------------------------------

  let defaultLookup = null;
  function resolveLookup() {
    if (injectedLookup) return injectedLookup;
    if (!defaultLookup) defaultLookup = require("node:dns/promises").lookup;
    return defaultLookup;
  }

  /**
   * 出网判定：
   *   ① 纯逻辑围栏（HTTPS / 无内嵌凭据 / 443 / 域白名单）— platform-domain.evaluateOutboundUrl；
   *   ② DNS 解析后的公网校验（源 developerNetwork.ts:39-42 assertPublicDns）。
   * 判定结果是**值**（allowed 布尔 + reason），而不是异常，便于调用方稳定处理。
   */
  async function evaluateNetwork(input) {
    const policy = { domains: Array.isArray(input.domains) ? input.domains.map((item) => String(item)).slice(0, 200) : [] };
    const target = platformDomain.evaluateOutboundUrl(input.url, policy);
    let addresses;
    try {
      addresses = await resolveLookup()(target.host, { all: true, verbatim: true });
    } catch (error) {
      return { allowed: false, host: target.host, origin: target.origin, reason: "DNS_FAILED", addresses: [], detail: sanitizePlatformText(error && error.message, 300) };
    }
    const list = Array.isArray(addresses) ? addresses : [];
    const verdict = platformDomain.evaluableAddressesArePublic(list);
    if (!verdict.public) return { allowed: false, host: target.host, origin: target.origin, reason: verdict.reason, addresses: list.map((item) => String(item && item.address != null ? item.address : item)) };
    return { allowed: true, host: target.host, origin: target.origin, reason: null, addresses: list.map((item) => String(item && item.address != null ? item.address : item)) };
  }

  // -------------------------------------------------------------------------
  // 进程诊断落盘（源 processDiagnostics.ts:44-115）
  // -------------------------------------------------------------------------

  let processMonitor = null;

  /** 源 processDiagnostics.ts:77-115 startProcessDiagnostics（目录已在 <userData>/dxos/diagnostics）。 */
  function startProcessMonitor(role, monitorOptions = {}) {
    if (!diagnosticsDir) return { path: null, sample: () => {}, stop() {} };
    const safeRole = String(role || "main").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40) || "node";
    const file = path.join(diagnosticsDir, "memory-" + safeRole + ".jsonl");
    const intervalMs = Math.max(10_000, Number(monitorOptions.intervalMs) || 5 * 60_000);
    const maxLogBytes = Math.max(256 * 1024, Number(monitorOptions.maxLogBytes) || 2 * 1024 * 1024);
    let stopped = false;
    let warned = false;
    const sample = (event = "sample") => {
      if (stopped) return;
      try {
        fs.mkdirSync(diagnosticsDir, { recursive: true });
        if (fs.existsSync(file) && fs.statSync(file).size >= maxLogBytes) {
          const previous = file + ".1";
          if (fs.existsSync(previous)) fs.rmSync(previous, { force: true });
          fs.renameSync(file, previous);
        }
        const metrics = metricsProvider && typeof metricsProvider === "function" ? metricsProvider() || {} : {};
        fs.appendFileSync(file, JSON.stringify(platformDomain.processMemorySnapshot(safeRole, event, metrics, clock())) + "\n", "utf8");
      } catch (error) {
        if (!warned) { warned = true; if (logger) logger("[OpenArc " + safeRole + "] memory diagnostics unavailable: " + String((error && error.message) || error)); }
      }
    };
    sample("start");
    const timer = setInterval(sample, intervalMs);
    timer.unref?.();
    const handle = {
      path: path.posix.join("diagnostics", path.basename(file)),
      sample,
      stop() {
        if (stopped) return;
        try { sample("stop"); } catch { /* 已停 */ }
        stopped = true;
        clearInterval(timer);
      },
    };
    processMonitor = handle;
    return handle;
  }

  // -------------------------------------------------------------------------
  // 健康 / 分发 / 身份
  // -------------------------------------------------------------------------

  function health() {
    return {
      ok: true,
      network: { engine: "networkSafety", httpsOnly: true, dnsPublicCheck: true },
      storage: { dataRootReady: !!dataRoot, backupsReady: !!backupsRoot },
      database: { available: !!db },
      processMonitor: { running: !!processMonitor },
      commands: listPlatformCommands().length,
    };
  }

  async function dispatch(command, payload, context) {
    const body = payload && typeof payload === "object" ? payload : {};
    switch (command) {
      case "platform/diagnostics/app": return appDiagnostics(body, context);
      case "platform/diagnostics/process": return processDiagnostics();
      case "platform/diagnostics/record": return recordRuntimeEvent(body, context);
      case "platform/data/integrity": return checkDataIntegrity();
      case "platform/data/snapshot/create": return createSnapshot(body.reason);
      case "platform/data/snapshot/verify": return verifySnapshot(body.id);
      case "platform/data/snapshot/list": return listSnapshots();
      case "platform/data/snapshot/restore": return restoreSnapshot(body.id, body.databasesClosed === true);
      case "platform/network/evaluate": return evaluateNetwork(body);
      case "platform/provider/test-check": return platformDomain.checkProviderTest(body);
      case "platform/health": return health();
      default: throw platformCommandNotAllowed(command);
    }
  }

  /** sessionRef → actor；不可解析时返回 { ok:false }，绝不伪造身份（与 media-service.cjs:557-566 同形）。 */
  function resolveActor(context) {
    if (!authorization || typeof authorization.resolveActor !== "function") return { ok: false, message: "授权服务未装配" };
    try {
      const result = authorization.resolveActor({ context: context });
      if (!result || result.ok !== true || !result.user || result.user.id == null) return { ok: false, message: (result && (result.error || result.reason)) || "会话无效" };
      return result;
    } catch (error) {
      return { ok: false, message: String((error && error.message) || error) };
    }
  }

  /** 唯一分发入口：白名单 → actor 解析 → dispatch → 脱敏；失败统一 normalizePlatformError。 */
  async function execute(command, payload, ctx = {}) {
    if (!isPlatformCommand(command)) return normalizePlatformError(platformCommandNotAllowed(command));
    const context = {
      sessionRef: requireStr(ctx && ctx.sessionRef, 160) || null,
      appId: requireStr(ctx && ctx.appId, 60) || HOST_APP_ID,
      source: "platform",
      requestId: requireStr(ctx && ctx.requestId, 100) || null,
    };
    const actorResult = resolveActor(context);
    if (!actorResult.ok) return normalizePlatformError(createPlatformError(PLATFORM_ERR_UNAUTHENTICATED, actorResult.message || "当前会话未认证，platform 命令被拒绝"));
    context.userId = String(actorResult.user.id);
    context.actor = actorResult.user;
    const body = payload && typeof payload === "object" ? payload : {};
    try {
      const value = await dispatch(command, body, context);
      return { ok: true, value: redactPlatformValue(value) };
    } catch (error) {
      return normalizePlatformError(error);
    }
  }

  function dispose() {
    try { if (processMonitor && typeof processMonitor.stop === "function") processMonitor.stop(); } catch { /* 已停 */ }
    processMonitor = null;
    return { stopped: true };
  }

  const dependencies = Object.freeze({
    userDataDir: !!userDataDir,
    dataDir: !!dataRoot,
    backupsDir: !!backupsRoot,
    diagnosticsDir: !!diagnosticsDir,
    database: !!db,
    identity: !!authorization,
    // 键名避开 isSecretKey 的子串（dxos-foundation-mask.cjs:12）
    injectedLookup: typeof injectedLookup === "function",
    processes: typeof processesProvider === "function",
  });

  return {
    execute,
    dispose,
    health,
    startProcessMonitor,
    paths: dataRoot ? { root: dataRoot, backups: backupsRoot, diagnostics: diagnosticsDir } : null,
    dependencies,
  };
}

module.exports = {
  createPlatformBundle,
  HOST_APP_ID,
  BACKUPS_DIR_NAME,
  EXCLUDED_TOP_LEVEL,
  INTEGRITY_FILES,
};
