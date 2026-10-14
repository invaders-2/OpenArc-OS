/**
 * B7a · 开发者平台落盘层（SQLite v22 六表 + <userData>/dxos/developer-apps 包目录）。
 *
 * 唯一权威划分（任务书要求：不新建第二套开发者平台存储）：
 *   · user_installed_apps       —— 每用户"当前启用"事实（行存在 = 启用；installed_version/build 指当前版本）
 *   · user_app_install_state    —— 每用户安装状态标记（首次安装时 INSERT OR IGNORE，记录 migrated_at）
 *   · app_market_releases       —— **本地清单缓存**：每个已安装版本一行（revoked_at IS NULL = 当前版本，
 *                                  revoked_at 非空 = 可回滚历史）；package_path 是相对 <userData>/dxos 的路径
 *   · app_credential_bindings   —— App 出网凭据引用（只存 provider 元数据，绝不存密钥）
 *   · app_runtime_events        —— 运行时事件（装载 / 启用 / 禁用 / 回滚 / 卸载 / ready / error）
 *   · app_network_audit         —— 出网审计（origin / pathname / status / bytes / credential_ref）
 *
 * 为什么版本指针放在 app_market_releases 的 revoked_at 而不是新列：
 *   v22 这六张表是本任务唯一允许的持久化面，**不改表结构**（新表 / 新列要走迁移，版本号由 Lead 定）。
 *   每次安装 / 升级 / 回滚只把当前版本置 revoked_at=NULL、其余历史版本置为发布时间；单一"当前版本"
 *   指针因此是可判定的，不需要第二份状态文件。
 *
 * 包字节落 <userData>/dxos/developer-apps/packages/<appId>/<releaseKey>-<rand>/：
 *   source/        解压后的文件（入口 / 资源 / skill / mcp）
 *   release.json   **归一化后的清单与能力投影**（源 developerApps.ts:931 的 release.json 同用途），
 *                  供 list / get / history 回读；不含任何绝对路径
 *
 * 逐函数移植自只读源（行号为源文件行号）：
 *   · server/developerApps.ts:914-970   importDeveloperApp 的暂存 → 原子 rename → 失败清理
 *   · server/developerApps.ts:972-1033  historyRecord / listDeveloperAppHistory / pruneDeveloperAppHistory
 *   · server/developerApps.ts:1117-1155 rollbackDeveloperApp（在本层是 activateRelease + 保留历史）
 *   · server/developerApps.ts:1157-1171 deleteDeveloperApp
 *   · server/developerApps.ts:21-24     audit（app_network_audit）
 *   · server/developerApps.ts:1039-1088 运行时观测记录
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const domain = require("./developer-domain.cjs");
const foundationErrors = require("./dxos-foundation-errors.cjs");

const APP_ROOT_NAME = "developer-apps";
const PACKAGES_DIR_NAME = "packages";
const RELEASE_FILE = "release.json";

const DEVELOPER_TABLES = Object.freeze([
  "user_installed_apps",
  "user_app_install_state",
  "app_market_releases",
  "app_credential_bindings",
  "app_runtime_events",
  "app_network_audit",
]);

const CLAIM_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;

function asInt(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num) : 0;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function createDeveloperStore(options = {}) {
  const db = options.db || null;
  const dataRoot = options.dataRoot ? path.resolve(String(options.dataRoot)) : null;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const fsImpl = options.fsImpl && typeof options.fsImpl.writeFileSync === "function" ? options.fsImpl : fs;
  const appRoot = dataRoot ? path.join(dataRoot, APP_ROOT_NAME) : null;
  const packagesRoot = appRoot ? path.join(appRoot, PACKAGES_DIR_NAME) : null;

  if (appRoot) {
    try { fsImpl.mkdirSync(appRoot, { recursive: true }); } catch { /* 装配不阻断，具体命令再抛 */ }
  }

  function assertReady() {
    if (!db) throw domain.createDeveloperError(domain.DEVELOPER_ERR_DEPENDENCY_UNAVAILABLE, "开发者平台需要数据库连接");
    if (!packagesRoot) throw domain.createDeveloperError(domain.DEVELOPER_ERR_DEPENDENCY_UNAVAILABLE, "开发者平台需要 userDataDir");
    return { db, appRoot, packagesRoot };
  }

  function tableExists(name) {
    if (!db) return false;
    try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name); }
    catch { return false; }
  }

  function tableReport() {
    const report = {};
    for (const name of DEVELOPER_TABLES) report[name] = tableExists(name);
    return report;
  }

  function run(fn) {
    if (db && typeof db.transaction === "function") return db.transaction(fn)();
    return fn();
  }

  // -------------------------------------------------------------------------
  // 包目录
  // -------------------------------------------------------------------------

  function assertClaim(value, label) {
    const text = String(value == null ? "" : value);
    if (!CLAIM_RE.test(text)) throw domain.createDeveloperError(domain.DEVELOPER_ERR_INVALID_INPUT, label + " 不合法");
    return text;
  }

  function resolvePackagePath(storageRelPath) {
    const { packagesRoot: root } = assertReady();
    const rel = domain.safePath(storageRelPath);
    const target = path.resolve(dataRoot, rel);
    const expectedPrefix = root + path.sep;
    if (target !== root && !target.startsWith(expectedPrefix)) throw domain.createDeveloperError(domain.DEVELOPER_ERR_PATH_ESCAPE, "安装包存储路径越界");
    return target;
  }

  /** 源 developerApps.ts:914-934：先写暂存目录，再原子改名成最终版本目录。 */
  function writePackage(appId, manifest, files, meta = {}) {
    const { packagesRoot: root } = assertReady();
    const claim = assertClaim(appId, "appId");
    const releaseKey = domain.appReleaseKey(manifest).replace(/[^a-zA-Z0-9.+-]/g, "-");
    const appDir = path.join(root, claim);
    const staging = path.join(appDir, ".staging-" + randomUUID());
    const stagingSource = path.join(staging, "source");
    const finalDir = path.join(appDir, releaseKey + "-" + randomUUID().slice(0, 8));
    fsImpl.mkdirSync(stagingSource, { recursive: true });
    try {
      for (const file of files) {
        const target = path.resolve(stagingSource, file.name);
        if (target !== stagingSource && !target.startsWith(stagingSource + path.sep)) throw domain.createDeveloperError(domain.DEVELOPER_ERR_PATH_ESCAPE, "检测到越界写入");
        fsImpl.mkdirSync(path.dirname(target), { recursive: true });
        fsImpl.writeFileSync(target, file.data);
      }
      const payload = {
        appId: claim,
        releaseKey: domain.appReleaseKey(manifest),
        version: manifest.version,
        build: manifest.build,
        releaseChannel: manifest.releaseChannel,
        dataVersion: manifest.dataVersion,
        name: manifest.name,
        entry: manifest.entry,
        storagePath: path.relative(dataRoot, path.join(finalDir, "source")).split(path.sep).join("/"),
        packageBytes: asInt(meta.packageBytes),
        sha256: String(meta.sha256 || ""),
        importedAt: clock(),
        // 只落归一化清单与能力投影；不写绝对路径、不写原始包装载名以外的用户输入。
        manifest,
        capabilities: meta.capabilities || null,
      };
      fsImpl.writeFileSync(path.join(staging, RELEASE_FILE), JSON.stringify(payload, null, 2), "utf8");
      fsImpl.mkdirSync(path.dirname(finalDir), { recursive: true });
      fsImpl.renameSync(staging, finalDir);
      return { absoluteDir: finalDir, storageRelPath: payload.storagePath, release: payload };
    } catch (error) {
      try { fsImpl.rmSync(staging, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
      try { fsImpl.rmSync(finalDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
      throw error;
    }
  }

  function readRelease(appId, storageRelPath) {
    const target = resolvePackagePath(storageRelPath);
    const releaseFile = path.join(path.dirname(target), RELEASE_FILE);
    if (!fsImpl.existsSync(releaseFile)) throw domain.createDeveloperError(domain.DEVELOPER_ERR_INTEGRITY_FAILED, "安装包缺少 release.json：" + domain.safePath(storageRelPath));
    let payload;
    try { payload = JSON.parse(fsImpl.readFileSync(releaseFile, "utf8")); }
    catch { throw domain.createDeveloperError(domain.DEVELOPER_ERR_INTEGRITY_FAILED, "安装包 release.json 损坏"); }
    if (!payload || payload.appId !== appId || !payload.manifest || !domain.isValidSemver(payload.manifest.version)) {
      throw domain.createDeveloperError(domain.DEVELOPER_ERR_INTEGRITY_FAILED, "安装包 release.json 与 appId 不一致");
    }
    return payload;
  }

  /** 源 developerApps.ts:1157-1171：卸载清理包目录 + 历史。 */
  function removeAppPackages(appId) {
    const { packagesRoot: root } = assertReady();
    const claim = assertClaim(appId, "appId");
    const target = path.resolve(root, claim);
    if (target !== path.join(root, claim)) throw domain.createDeveloperError(domain.DEVELOPER_ERR_PATH_ESCAPE, "卸载路径越界");
    fsImpl.rmSync(target, { recursive: true, force: true });
    return true;
  }

  // -------------------------------------------------------------------------
  // user_installed_apps / user_app_install_state
  // -------------------------------------------------------------------------

  function getInstalled(userId, appId) {
    if (!db) return null;
    try {
      return db.prepare("SELECT user_id AS userId,app_id AS appId,installed_at AS installedAt,installed_version AS version,installed_build AS build,release_channel AS releaseChannel,updated_at AS updatedAt FROM user_installed_apps WHERE user_id=? AND app_id=?").get(String(userId), String(appId)) || null;
    } catch { return null; }
  }

  function listInstalled(userId) {
    if (!db) return [];
    try {
      return db.prepare("SELECT app_id AS appId,installed_at AS installedAt,installed_version AS version,installed_build AS build,release_channel AS releaseChannel,updated_at AS updatedAt FROM user_installed_apps WHERE user_id=? ORDER BY installed_at DESC").all(String(userId));
    } catch { return []; }
  }

  /** 源 userPreferences.ts:109-110 的同一写入语义（存在则更新版本，不改 installed_at）。 */
  function setInstalled(userId, appId, manifest, now = clock()) {
    assertReady();
    db.prepare("INSERT OR IGNORE INTO user_app_install_state(user_id,migrated_at) VALUES (?,?)").run(String(userId), now);
    db.prepare("INSERT INTO user_installed_apps(user_id,app_id,installed_at,installed_version,installed_build,release_channel,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id,app_id) DO UPDATE SET installed_version=excluded.installed_version,installed_build=excluded.installed_build,release_channel=excluded.release_channel,updated_at=excluded.updated_at")
      .run(String(userId), String(appId), now, String(manifest.version), asInt(manifest.build), String(manifest.releaseChannel), now);
    return getInstalled(userId, appId);
  }

  function removeInstalled(userId, appId) {
    if (!db) return 0;
    const info = db.prepare("DELETE FROM user_installed_apps WHERE user_id=? AND app_id=?").run(String(userId), String(appId));
    return info && Number.isFinite(info.changes) ? info.changes : 0;
  }

  // -------------------------------------------------------------------------
  // app_market_releases（本地清单缓存 / 当前版本指针 / 回滚历史）
  // -------------------------------------------------------------------------

  function releaseRow(row) {
    if (!row) return null;
    return {
      appId: row.app_id,
      version: row.version,
      build: asInt(row.build),
      channel: row.channel,
      packagePath: row.package_path,
      packageSize: asInt(row.package_size),
      sha256: row.sha256,
      dataVersion: asInt(row.data_version),
      minSystemVersion: row.min_system_version,
      maxSystemVersion: row.max_system_version || null,
      releaseNotes: row.release_notes || "",
      publishedAt: asInt(row.published_at),
      revokedAt: row.revoked_at == null ? null : asInt(row.revoked_at),
    };
  }

  /** 机器级已装载过的 appId 清单（app_market_releases 是机器级本地清单缓存）。 */
  function listAppIds() {
    if (!db) return [];
    try {
      return db.prepare("SELECT app_id AS appId FROM app_market_releases GROUP BY app_id ORDER BY MAX(published_at) DESC").all().map((row) => row.appId);
    } catch { return []; }
  }

  function listReleases(appId) {
    if (!db) return [];
    const rows = db.prepare("SELECT * FROM app_market_releases WHERE app_id=? ORDER BY published_at DESC,build DESC").all(String(appId));
    return rows.map(releaseRow);
  }

  function currentRelease(appId) {
    if (!db) return null;
    const row = db.prepare("SELECT * FROM app_market_releases WHERE app_id=? AND revoked_at IS NULL ORDER BY published_at DESC,build DESC LIMIT 1").get(String(appId));
    return releaseRow(row);
  }

  function listHistory(appId) {
    if (!db) return [];
    const rows = db.prepare("SELECT * FROM app_market_releases WHERE app_id=? AND revoked_at IS NOT NULL ORDER BY published_at DESC,build DESC").all(String(appId));
    return rows.map(releaseRow);
  }

  /**
   * 源 developerApps.ts:928-934 / 1134-1141：写入一个版本并把它置为当前版本。
   * 先把其他版本标记为历史，再 UPSERT 当前版本（同一 (app_id,version,build,channel) 复装只更新时间）。
   */
  function activateRelease(input) {
    const { db: conn } = assertReady();
    const appId = String(input.appId);
    const manifest = input.manifest;
    const channel = ["stable", "beta", "dev"].includes(manifest.releaseChannel) ? manifest.releaseChannel : "dev";
    const now = input.now == null ? clock() : input.now;
    const write = () => {
      conn.prepare("UPDATE app_market_releases SET revoked_at=? WHERE app_id=? AND revoked_at IS NULL AND NOT (version=? AND build=? AND channel=?)")
        .run(now, appId, String(manifest.version), asInt(manifest.build), channel);
      conn.prepare("INSERT INTO app_market_releases(app_id,version,build,channel,delivery,package_path,package_size,sha256,signature,signing_key_id,min_system_version,max_system_version,data_version,mandatory,rollout_percent,release_notes,publisher_user_id,published_at,revoked_at,review_status,reviewed_by,reviewed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(app_id,version,build,channel) DO UPDATE SET package_path=excluded.package_path,package_size=excluded.package_size,sha256=excluded.sha256,min_system_version=excluded.min_system_version,max_system_version=excluded.max_system_version,data_version=excluded.data_version,release_notes=excluded.release_notes,publisher_user_id=excluded.publisher_user_id,published_at=excluded.published_at,revoked_at=NULL")
        .run(appId, String(manifest.version), asInt(manifest.build), channel, "dx-app", String(input.packagePath), asInt(input.packageSize), String(input.sha256 || ""), "local", "local", String(manifest.minSystemVersion), manifest.maxSystemVersion || null, asInt(manifest.dataVersion), 0, 100, String(manifest.releaseNotes || ""), String(input.userId || ""), now, null, "approved", "local", now);
    };
    run(write);
    return currentRelease(appId);
  }

  function purgeReleases(appId) {
    if (!db) return 0;
    const info = db.prepare("DELETE FROM app_market_releases WHERE app_id=?").run(String(appId));
    return info && Number.isFinite(info.changes) ? info.changes : 0;
  }

  // -------------------------------------------------------------------------
  // app_runtime_events
  // -------------------------------------------------------------------------

  function recordRuntimeEvent(input) {
    const { db: conn } = assertReady();
    if (!tableExists("app_runtime_events")) throw domain.createDeveloperError(domain.DEVELOPER_ERR_DEPENDENCY_UNAVAILABLE, "app_runtime_events 表不存在");
    const eventType = String(input.eventType || "").slice(0, 60);
    if (!eventType) throw domain.createDeveloperError(domain.DEVELOPER_ERR_INVALID_INPUT, "运行时事件缺少 eventType");
    conn.prepare("INSERT INTO app_runtime_events(id,app_id,version,build,user_id,event_type,detail,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(randomUUID(), String(input.appId), String(input.version || "0.0.0"), asInt(input.build), String(input.userId || "unknown"), eventType, domain.sanitizeDeveloperText(input.detail, 4000), asInt(input.now == null ? clock() : input.now));
    return { recorded: true, appId: String(input.appId), eventType };
  }

  function listRuntimeEvents(userId, appId, limit = 100) {
    if (!db || !tableExists("app_runtime_events")) return [];
    const capped = Math.max(1, Math.min(500, asInt(limit) || 100));
    return db.prepare("SELECT event_type AS eventType,version,build,detail,created_at AS createdAt FROM app_runtime_events WHERE user_id=? AND app_id=? ORDER BY created_at DESC LIMIT ?").all(String(userId), String(appId), capped);
  }

  function purgeRuntimeEvents(appId) {
    if (!db || !tableExists("app_runtime_events")) return 0;
    const info = db.prepare("DELETE FROM app_runtime_events WHERE app_id=?").run(String(appId));
    return info && Number.isFinite(info.changes) ? info.changes : 0;
  }

  // -------------------------------------------------------------------------
  // app_network_audit
  // -------------------------------------------------------------------------

  function insertNetworkAudit(input) {
    const { db: conn } = assertReady();
    if (!tableExists("app_network_audit")) throw domain.createDeveloperError(domain.DEVELOPER_ERR_DEPENDENCY_UNAVAILABLE, "app_network_audit 表不存在");
    conn.prepare("INSERT INTO app_network_audit(user_id,app_id,method,origin,pathname,status,response_bytes,credential_ref,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(String(input.userId), String(input.appId), String(input.method).slice(0, 12), String(input.origin).slice(0, 300), String(input.pathname || "").slice(0, 500), asInt(input.status), asInt(input.responseBytes), input.credentialRef ? 1 : 0, asInt(input.now == null ? clock() : input.now));
    return true;
  }

  function listNetworkAudit(userId, appId, limit = 100) {
    if (!db || !tableExists("app_network_audit")) return [];
    const capped = Math.max(1, Math.min(500, asInt(limit) || 100));
    return db.prepare("SELECT method,origin,pathname,status,response_bytes AS responseBytes,credential_ref AS credentialRef,created_at AS createdAt FROM app_network_audit WHERE user_id=? AND app_id=? ORDER BY created_at DESC LIMIT ?").all(String(userId), String(appId), capped);
  }

  function purgeNetworkAudit(appId) {
    if (!db || !tableExists("app_network_audit")) return 0;
    const info = db.prepare("DELETE FROM app_network_audit WHERE app_id=?").run(String(appId));
    return info && Number.isFinite(info.changes) ? info.changes : 0;
  }

  // -------------------------------------------------------------------------
  // app_credential_bindings（只存 provider 引用，不存密钥）
  // -------------------------------------------------------------------------

  function bindCredential(userId, appId, input) {
    const { db: conn } = assertReady();
    if (!tableExists("app_credential_bindings")) throw domain.createDeveloperError(domain.DEVELOPER_ERR_DEPENDENCY_UNAVAILABLE, "app_credential_bindings 表不存在");
    const bindingId = String(input.bindingId == null ? "" : input.bindingId).trim();
    const providerId = String(input.providerId == null ? "" : input.providerId).trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{1,80}$/.test(bindingId)) throw domain.createDeveloperError(domain.DEVELOPER_ERR_INVALID_INPUT, "Credential bindingId 不合法");
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{1,80}$/.test(providerId)) throw domain.createDeveloperError(domain.DEVELOPER_ERR_INVALID_INPUT, "Credential providerId 不合法");
    const authType = ["bearer", "api-key-header"].includes(String(input.authType)) ? String(input.authType) : "bearer";
    const headerName = authType === "api-key-header" ? String(input.headerName || "x-api-key").trim().toLowerCase() : null;
    if (headerName && !/^[a-z][a-z0-9-]{1,60}$/.test(headerName)) throw domain.createDeveloperError(domain.DEVELOPER_ERR_INVALID_INPUT, "Credential Header 名称不合法");
    conn.prepare("INSERT INTO app_credential_bindings(user_id,app_id,binding_id,provider_id,auth_type,header_name,bound_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id,app_id,binding_id) DO UPDATE SET provider_id=excluded.provider_id,auth_type=excluded.auth_type,header_name=excluded.header_name,bound_at=excluded.bound_at")
      .run(String(userId), String(appId), bindingId, providerId, authType, headerName, clock());
    return { bindingId, appId: String(appId), providerId, authType, headerName, boundAt: clock() };
  }

  function listCredentials(userId, appId) {
    if (!db || !tableExists("app_credential_bindings")) return [];
    return db.prepare("SELECT binding_id AS bindingId,provider_id AS providerId,auth_type AS authType,header_name AS headerName,bound_at AS boundAt FROM app_credential_bindings WHERE user_id=? AND app_id=? ORDER BY bound_at DESC").all(String(userId), String(appId));
  }

  function unbindCredential(userId, appId, bindingId) {
    if (!db || !tableExists("app_credential_bindings")) return 0;
    const info = db.prepare("DELETE FROM app_credential_bindings WHERE user_id=? AND app_id=? AND binding_id=?").run(String(userId), String(appId), String(bindingId));
    return info && Number.isFinite(info.changes) ? info.changes : 0;
  }

  function purgeCredentials(appId) {
    if (!db || !tableExists("app_credential_bindings")) return 0;
    const info = db.prepare("DELETE FROM app_credential_bindings WHERE app_id=?").run(String(appId));
    return info && Number.isFinite(info.changes) ? info.changes : 0;
  }

  return {
    tableExists,
    tableReport,
    writePackage,
    readRelease,
    removeAppPackages,
    getInstalled,
    listInstalled,
    setInstalled,
    removeInstalled,
    listAppIds,
    listReleases,
    currentRelease,
    listHistory,
    activateRelease,
    purgeReleases,
    recordRuntimeEvent,
    listRuntimeEvents,
    purgeRuntimeEvents,
    insertNetworkAudit,
    listNetworkAudit,
    purgeNetworkAudit,
    bindCredential,
    listCredentials,
    unbindCredential,
    purgeCredentials,
    sha256,
    paths: appRoot ? { root: appRoot, packages: packagesRoot } : null,
  };
}

module.exports = {
  createDeveloperStore,
  DEVELOPER_TABLES,
  APP_ROOT_NAME,
  PACKAGES_DIR_NAME,
  RELEASE_FILE,
  sha256,
};
