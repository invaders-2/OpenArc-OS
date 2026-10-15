/**
 * B7a · 开发者平台装配 + developer:command 分发（唯一执行入口）。
 *
 * 生命周期全链路（装载 → 启用 → 禁用 → 回滚 → 卸载）：
 *   ① install   解析 dx-app/v2 包 → 清单 / 权限 / 工具 / 入口校验 → 写包目录 → 写
 *               app_market_releases（本地清单缓存，当前版本 revoked_at IS NULL）→ 写
 *               user_installed_apps（启用）→ 落 app_runtime_events；重复/降级/数据版本变化按源拒绝。
 *               B7h：包字节 + release.json 全部落盘（唯一可失败前置动作）之后，才在
 *               "迁移快照 + 单个数据库事务"里执行迁移与激活；任一步失败一律回到调用前状态
 *               （迁移快照恢复 + 安装态 / 版本不变），不再出现"数据已迁移、版本未更新"。
 *   ② enable    把当前版本写回 user_installed_apps（不改包）。
 *   ③ disable   只移除 user_installed_apps 行；包目录、清单缓存、回滚点全部保留。
 *   ④ rollback  从 app_market_releases 的历史行（revoked_at 非空）取上一版本，重新置为当前版本；
 *               启用状态下同步 user_installed_apps 的 installed_version/build（回滚后运行时状态一致）。
 *   ⑤ uninstall 清 user_installed_apps + app_market_releases + 包目录 + 凭据绑定 + app_principals 身份；
 *               **运行时事件与网络审计保留**（审计事实不随卸载消失）。
 *   X7：install / enable 幂等登记 app_principals（app_id = "dev-" + manifest.id，built_in = 0），
 *       没有它 saveAppPermissionPolicy 的 appById(hostApp) 校验会拒绝开发者 App 的权限策略。
 *
 * 出网治理（源 server/developerNetwork.ts:12-128 的口径，不另造一套）：
 *   · 未声明 network.domains → DEVELOPER_ERR_NETWORK_NOT_DECLARED（拒绝而不是放行）；
 *   · HTTPS + 无内嵌凭据 + 端口 443 + 域名白名单 → platform-domain.evaluateOutboundUrl；
 *   · DNS 解析结果必须全部是公网地址 → platform-domain.evaluableAddressesArePublic；
 *   · 每 (userId, appId) 每分钟 60 次限流（source:12-19 enforceRateLimit，超限先于校验）；
 *   · 每次实际请求落 app_network_audit（origin / pathname / status / bytes / credential_ref）。
 *   · 凭据发送：本批不装配 provider 密钥读取，显式拒绝而不是假造 Authorization 头。
 *
 * 边界：
 *   · sessionRef 由主进程注入；payload.userId / role / appId 一律忽略（与 platform/media 同界）。
 *   · 返回值统一过 domain.redactDeveloperValue：不含绝对路径、不含密钥。
 *   · DNS 解析器与 fetch 可注入（测试全部离线）；默认才用 node:dns/promises 与 globalThis.fetch。
 *
 * 逐函数移植自只读源（行号为源文件行号）：
 *   · server/developerApps.ts:893-970    importDeveloperApp（校验 → 暂存 → 原子替换 → 索引提交）
 *   · server/developerApps.ts:991-1033   listDeveloperAppHistory / pruneDeveloperAppHistory
 *   · server/developerApps.ts:1085-1088  运行时事件
 *   · server/developerApps.ts:1117-1155  rollbackDeveloperApp
 *   · server/developerApps.ts:1157-1171  deleteDeveloperApp
 *   · server/developerNetwork.ts:70-128  developerNetworkRequest（限流 / 白名单 / DNS / 重定向 / 大小限制 / 审计）
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { resolveDxosPaths, ensureDxosLayout } = require("./dxos-foundation-paths.cjs");
const domain = require("./developer-domain.cjs");
const { createDeveloperStore } = require("./developer-store.cjs");
// B7f：声明式数据迁移引擎（快照 + 失败回滚到快照，不半应用）。
const migrationDomain = require("./developer-migrations.cjs");

const HOST_APP_ID = "ai";
/** X7：开发者 App 在 app_principals.publisher 的来源标记（内置为 'openarc-builtin'）。 */
const DEVELOPER_APP_PUBLISHER = "openarc-developer";
const MAX_NETWORK_BODY_BYTES = 2 * 1024 * 1024;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

const asStr = (value, max = 512) => (typeof value === "string" ? value.slice(0, max) : value == null ? undefined : String(value).slice(0, max));
const requireStr = (value, max = 512) => { const text = asStr(value, max); return text && text.length ? text : null; };
const requireAppId = (payload) => {
  const appId = requireStr(payload && payload.appId, 100);
  if (!appId) throw domain.createDeveloperError(domain.DEVELOPER_ERR_INVALID_INPUT, "需要 appId");
  return appId;
};
const decodePackage = (payload) => {
  const raw = Buffer.isBuffer(payload && payload.buffer) ? payload.buffer : (Buffer.isBuffer(payload && payload.package) ? payload.package : (payload && (payload.packageBase64 || payload.package)));
  if (Buffer.isBuffer(raw)) return raw;
  if (typeof raw !== "string" || !raw.length) throw domain.createDeveloperError(domain.DEVELOPER_ERR_INVALID_INPUT, "需要开发者包内容（base64 或 Buffer）");
  const buffer = Buffer.from(raw, "base64");
  if (!buffer.length) throw domain.createDeveloperError(domain.DEVELOPER_ERR_INVALID_INPUT, "开发者包 base64 解码为空");
  return buffer;
};

function createDeveloperBundle(options = {}) {
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const logger = typeof options.logger === "function" ? options.logger : null;
  const userDataDir = options.userDataDir || null;
  const identityStore = options.identityStore || null;
  const authorization = options.authorization || null;
  // X7：app_principals 的写入通道。与 agent-bundle 同一装配边界：主进程传 identity.authStore
  // （main.cjs），此处也接受 authorization.store；两者都缺时保持"未登记"降级 —— 不伪造 principal，
  // install / enable / uninstall 本身照常工作（见 registerAppPrincipal / removeAppPrincipal）。
  const authStore = options.authStore && typeof options.authStore.upsertApp === "function"
    ? options.authStore
    : (authorization && authorization.store && typeof authorization.store.upsertApp === "function" ? authorization.store : null);
  const systemVersion = asStr(options.systemVersion, 60) || domain.DEVELOPER_SYSTEM_VERSION;
  const injectedLookup = typeof options.lookup === "function" ? options.lookup : null;
  const injectedFetch = typeof options.fetchImpl === "function" ? options.fetchImpl : null;
  // Y4：宿主侧 App 托管 MCP 注册表（electron/mcp-app-registry.cjs）。
  // 未注入 = 与从前逐字一致（不注册、不连接），不假装"已绑定 MCP 生命周期"。
  const appMcpRegistry = options.appMcpRegistry && typeof options.appMcpRegistry === "object" ? options.appMcpRegistry : null;

  const paths = userDataDir ? resolveDxosPaths(userDataDir) : null;
  const dataRoot = paths ? paths.root : null;
  const db = identityStore ? identityStore.connection || identityStore.db || null : null;
  // B7h：store 可注入，测试据此在 writePackage /
  // activateRelease 上注入故障；生产路径不传即真实落盘层。
  const store = options.store && typeof options.store === "object" ? options.store : createDeveloperStore({ db, dataRoot, clock });
  const limiter = domain.createDeveloperRateLimiter({ now: clock });

  // B7f：声明式迁移的注入面（B6 虚拟文件树 + 快照目录）。
  //   · migrationFs 未注入时保持结构化依赖缺失（绝不假执行迁移）；
  //   · snapshotRoot 默认 <userData>/dxos/developer-apps/migrations（对齐任务书 item 2）。
  const migrationFs = options.migrationFs && typeof options.migrationFs === "object" ? options.migrationFs : null;
  const migrationSnapshotRoot = options.migrationSnapshotRoot ? String(options.migrationSnapshotRoot) : (dataRoot ? path.join(dataRoot, "developer-apps", "migrations") : null);
  const migrationStore = migrationSnapshotRoot ? new migrationDomain.DeveloperMigrationSnapshotStore({ snapshotRoot: migrationSnapshotRoot }) : null;

  if (dataRoot) {
    try { ensureDxosLayout(userDataDir); } catch { /* 装配不阻断：具体命令再抛结构化错误 */ }
  }

  let defaultLookup = null;
  function resolveLookup() {
    if (injectedLookup) return injectedLookup;
    if (!defaultLookup) {
      try { defaultLookup = require("node:dns/promises").lookup; }
      catch { defaultLookup = null; }
    }
    if (!defaultLookup) throw domain.createDeveloperError(domain.DEVELOPER_ERR_DEPENDENCY_UNAVAILABLE, "DNS 解析器未装配");
    return defaultLookup;
  }

  function resolveFetch() {
    if (injectedFetch) return injectedFetch;
    if (typeof globalThis.fetch === "function") return globalThis.fetch;
    throw domain.createDeveloperError(domain.DEVELOPER_ERR_DEPENDENCY_UNAVAILABLE, "出网请求需要 fetch 实现");
  }

  // -------------------------------------------------------------------------
  // 读取与投影
  // -------------------------------------------------------------------------

  function loadApp(appId) {
    const current = store.currentRelease(appId);
    if (!current) throw domain.createDeveloperError(domain.DEVELOPER_ERR_NOT_FOUND, "开发者应用不存在：" + appId);
    const release = store.readRelease(appId, current.packagePath);
    return { current, release, manifest: release.manifest, capabilities: release.capabilities || null };
  }

  function projectApp(userId, appId) {
    const current = store.currentRelease(appId);
    if (!current) return null;
    let release = null;
    try { release = store.readRelease(appId, current.packagePath); } catch { release = null; }
    const installed = store.getInstalled(userId, appId);
    return {
      appId,
      enabled: !!installed,
      version: current.version,
      build: current.build,
      releaseChannel: current.channel,
      installedAt: installed ? installed.installedAt : null,
      updatedAt: installed ? installed.updatedAt : null,
      packageSize: current.packageSize,
      sha256: current.sha256,
      historyCount: store.listHistory(appId).length,
      manifest: release ? domain.projectManifest(release.manifest) : null,
      capabilities: release ? domain.projectCapabilities(release.capabilities) : domain.projectCapabilities(null),
    };
  }

  /** 运行时事件是"事后审计"：写失败不回滚已经完成的安装 / 启用，只记一条 warning。 */
  function recordEvent(userId, appId, manifestLike, eventType, detail) {
    try {
      store.recordRuntimeEvent({
        userId,
        appId,
        version: manifestLike && manifestLike.version ? manifestLike.version : "0.0.0",
        build: manifestLike && manifestLike.build ? manifestLike.build : 0,
        eventType,
        detail,
        now: clock(),
      });
    } catch (error) {
      if (logger) logger("[OpenArc developer] runtime event failed: " + String((error && error.message) || error));
    }
  }

  // -------------------------------------------------------------------------
  // Y4：App 托管 MCP 生命周期（启用 / 禁用 / 卸载 与宿主注册表绑定）
  // -------------------------------------------------------------------------
  // 为什么放在这里：开发者 App 的 MCP 声明随包解析（capabilities.mcp：normalizeMcpList 只保留
  // 白名单 serverKey），启用状态由 user_installed_apps 表达；两者拼起来才是"这个 App 现在托管了
  // 哪些 MCP、该不该连"。注册表内部仍走 mcp-domain.cjs:72 LOCAL_SERVERS 与 :112
  // validateRemoteEndpoint 的既有策略，本层不做第二套判定。
  //
  // 失败只如实记录（app_runtime_events + logger）并降级，绝不改写 App 的启用 / 卸载结果，
  // 也不静默吞掉原因；未注入注册表时这些函数全部跳过（既有返回形状逐字不变）。

  /** 安装 / 启用：把 App 声明交给注册表（注册成功才落库 / 连接；不合规整批拒绝）。 */
  async function syncAppMcp(userId, appId, sourceRoot, capabilities, manifestLike) {
    if (!appMcpRegistry || typeof appMcpRegistry.sync !== "function") return { ok: true, skipped: "NO_REGISTRY" };
    const declarations = Array.isArray(capabilities && capabilities.mcp) ? capabilities.mcp : [];
    if (!declarations.length) return { ok: true, skipped: "NO_DECLARATIONS" };
    try {
      const res = await appMcpRegistry.sync(String(appId), sourceRoot == null ? null : String(sourceRoot), declarations);
      if (!res || res.ok !== true) {
        const reason = (res && (res.error || res.detail)) || "SYNC_FAILED";
        recordEvent(userId, appId, manifestLike || {}, "app.mcp.sync.error", { reason: String(reason).slice(0, 200), policy: res && res.policy ? res.policy : null });
        if (logger) logger("[OpenArc developer] App 托管 MCP 注册失败（已降级，不影响安装 / 启用）：" + appId + " → " + String(reason).slice(0, 200));
        return { ok: false, error: res && res.error, policy: res && res.policy, detail: res && res.detail };
      }
      return { ok: true, connected: res.connected, servers: res.servers, skipped: res.skipped };
    } catch (error) {
      const reason = String((error && error.message) || error);
      recordEvent(userId, appId, manifestLike || {}, "app.mcp.sync.error", { reason: reason.slice(0, 200) });
      if (logger) logger("[OpenArc developer] App 托管 MCP 注册异常（已降级）：" + appId + " → " + reason.slice(0, 200));
      return { ok: false, error: "MCP_APP_SYNC_FAILED", detail: reason };
    }
  }

  /** 启用 / 禁用：按已登记记录重新判定（启用才连接；禁用 = 断开 + DISABLED）。 */
  async function setAppMcpEnabled(userId, appId, enabled, manifestLike) {
    if (!appMcpRegistry || typeof appMcpRegistry.setAppEnabled !== "function") return { ok: true, skipped: "NO_REGISTRY" };
    try {
      const res = await appMcpRegistry.setAppEnabled(String(appId), enabled === true);
      if (!res || res.ok !== true) {
        const reason = (res && (res.error || res.detail)) || "SET_ENABLED_FAILED";
        recordEvent(userId, appId, manifestLike || {}, "app.mcp.lifecycle.error", { action: enabled === true ? "enable" : "disable", reason: String(reason).slice(0, 200), rejected: res && Array.isArray(res.rejected) ? res.rejected.length : 0 });
        if (logger) logger("[OpenArc developer] App 托管 MCP " + (enabled === true ? "启用" : "禁用") + "判定失败（已降级）：" + appId + " → " + String(reason).slice(0, 200));
      }
      return res || { ok: false, error: "SET_ENABLED_FAILED" };
    } catch (error) {
      const reason = String((error && error.message) || error);
      recordEvent(userId, appId, manifestLike || {}, "app.mcp.lifecycle.error", { action: enabled === true ? "enable" : "disable", reason: reason.slice(0, 200) });
      if (logger) logger("[OpenArc developer] App 托管 MCP 生命周期异常（已降级）：" + appId + " → " + reason.slice(0, 200));
      return { ok: false, error: "MCP_APP_LIFECYCLE_FAILED", detail: reason };
    }
  }

  /** 卸载：清理该 App 的全部托管记录（断开 + 删除；别的记录不动）。 */
  async function removeAppMcp(userId, appId, manifestLike) {
    if (!appMcpRegistry || typeof appMcpRegistry.remove !== "function") return { ok: true, skipped: "NO_REGISTRY" };
    try {
      const res = await appMcpRegistry.remove(String(appId));
      if (!res || res.ok !== true) {
        const reason = (res && (res.error || res.detail)) || "REMOVE_FAILED";
        recordEvent(userId, appId, manifestLike || {}, "app.mcp.lifecycle.error", { action: "uninstall", reason: String(reason).slice(0, 200) });
        if (logger) logger("[OpenArc developer] App 托管 MCP 卸载清理失败（已降级）：" + appId + " → " + String(reason).slice(0, 200));
      }
      return res || { ok: false, error: "REMOVE_FAILED" };
    } catch (error) {
      const reason = String((error && error.message) || error);
      recordEvent(userId, appId, manifestLike || {}, "app.mcp.lifecycle.error", { action: "uninstall", reason: reason.slice(0, 200) });
      if (logger) logger("[OpenArc developer] App 托管 MCP 卸载清理异常（已降级）：" + appId + " → " + reason.slice(0, 200));
      return { ok: false, error: "MCP_APP_REMOVE_FAILED", detail: reason };
    }
  }

  // -------------------------------------------------------------------------
  // X7：app_principals 登记（开发者 App 的机器级身份）
  // -------------------------------------------------------------------------
  // 为什么必须登记：saveAppPermissionPolicy 用 appById(hostApp) 保证"权限宿主 App 存在"
  // （local-account-service.cjs:1001）。内置 App 由 identity-store 播种，开发者 App 原先只存在于
  // developer-store（user_installed_apps / app_market_releases），因此 app.<manifest.id>.* 形态的
  // 权限策略在落库时命中 DXOS_ERR_NOT_FOUND。
  // 幂等来源：AuthorizationStore.upsertApp 是 ON CONFLICT(app_id) DO UPDATE（authorization-store.cjs:69-70），
  // 重复 install / enable 只更新同一行，不产生第二行。
  function registerAppPrincipal(appId, manifest) {
    if (!authStore) return null;
    const name = manifest && manifest.name ? String(manifest.name) : String(appId);
    return authStore.upsertApp({
      appId: String(appId),
      name,
      publisher: DEVELOPER_APP_PUBLISHER,
      status: "enabled",
      builtIn: 0,
    });
  }

  /** 卸载清理：见 authorization-store.deleteApp（先删 grant，再删 built_in = 0 的 principal）。 */
  function removeAppPrincipal(appId) {
    if (!authStore || typeof authStore.deleteApp !== "function") return null;
    return authStore.deleteApp(String(appId));
  }

  // -------------------------------------------------------------------------
  // B7f：声明式数据迁移（manifest.migrations；快照 + 失败回滚，不半应用）
  // -------------------------------------------------------------------------

  function readMigrationDocument(files, file) {
    const entry = files.find((item) => item.name === file);
    if (!entry) throw domain.createDeveloperError(domain.DEVELOPER_ERR_PACKAGE_INVALID, "迁移文件不存在：" + file);
    try { return JSON.parse(entry.data.toString("utf8")); }
    catch { throw domain.createDeveloperError(domain.DEVELOPER_ERR_MANIFEST_INVALID, "迁移文件不是有效 JSON：" + file); }
  }

  /** 从现有 dataVersion 连续覆盖到目标 dataVersion 的迁移链；不连续即拒绝（不猜缺失迁移）。 */
  function buildMigrationChain(prepared, fromVersion) {
    const declared = Array.isArray(prepared.manifest.migrations) ? prepared.manifest.migrations : [];
    if (!declared.length) return null;
    const steps = declared.filter((item) => item.from >= fromVersion).sort((a, b) => a.from - b.from);
    if (!steps.length) return null;
    if (steps[0].from !== fromVersion || steps[steps.length - 1].to !== prepared.manifest.dataVersion) {
      throw domain.createDeveloperError(domain.DEVELOPER_ERR_MANIFEST_INVALID, "声明式迁移链不连续：需要从 dataVersion " + fromVersion + " 连续覆盖到 " + prepared.manifest.dataVersion);
    }
    for (let index = 1; index < steps.length; index += 1) {
      if (steps[index].from !== steps[index - 1].to) throw domain.createDeveloperError(domain.DEVELOPER_ERR_MANIFEST_INVALID, "声明式迁移链不连续：" + steps[index - 1].to + " → " + steps[index].from);
    }
    return steps.map((item) => ({ from: item.from, to: item.to, document: readMigrationDocument(prepared.files, item.file) }));
  }

  function normalizeMigrationRoot(item, fallbackOwner) {
    if (!item || typeof item !== "object" || !item.rootId) return null;
    return { ownerId: item.ownerId != null && String(item.ownerId) ? String(item.ownerId) : fallbackOwner, rootId: String(item.rootId) };
  }

  /** 项目根来源：payload.migrationRoots 优先，其次 bundle 注入的 migrationRoots（数组或 (ctx)=>数组）。 */
  function resolveMigrationRoots(payload, context) {
    const injected = options.migrationRoots;
    const source = Array.isArray(payload && payload.migrationRoots)
      ? payload.migrationRoots
      : (typeof injected === "function" ? injected({ payload, context }) : injected);
    return (Array.isArray(source) ? source : []).map((item) => normalizeMigrationRoot(item, context && context.userId)).filter(Boolean);
  }

  /** 升级迁移：失败抛结构化错误（引擎已回滚快照），调用方据此中止安装，绝不半应用。 */
  function applyDeclaredMigrations({ payload, context, appId, prepared, fromVersion }) {
    if (!migrationStore) throw domain.createDeveloperError(domain.DEVELOPER_ERR_DEPENDENCY_UNAVAILABLE, "声明式迁移需要迁移快照存储", { dependency: "migrationSnapshotRoot" });
    if (!migrationFs) throw domain.createDeveloperError(domain.DEVELOPER_ERR_DEPENDENCY_UNAVAILABLE, "声明式迁移需要 B6 虚拟文件树", { dependency: "migrationFs" });
    const chain = buildMigrationChain(prepared, fromVersion);
    if (!chain) throw domain.createDeveloperError(domain.DEVELOPER_ERR_MANIFEST_INVALID, "dataVersion 变化但没有声明可用的迁移链");
    const roots = resolveMigrationRoots(payload, context);
    if (!roots.length) throw domain.createDeveloperError(domain.DEVELOPER_ERR_INVALID_INPUT, "声明式迁移需要至少一个项目根（migrationRoots）", { appId });
    const historyId = domain.appReleaseKey(prepared.manifest);
    const result = migrationStore.applyChain({ appId, historyId, roots, documents: chain, fsAdapter: migrationFs });
    if (!result.ok) throw domain.createDeveloperError(domain.DEVELOPER_ERR_CONFLICT, "声明式迁移失败，已回滚到快照，安装未生效：" + domain.sanitizeDeveloperText(result.error, 200), { rolledBack: !!(result.detail && result.detail.rolledBack), historyId });
    return { applied: result.applied, historyId, roots: roots.length };
  }

  /** 回滚迁移：目标版本有快照（或升级前快照）则恢复；否则保持原 CONFLICT 拒绝语义。 */
  function applyRollbackMigrations({ appId, current, targetRelease, allowDataVersionChange }) {
    if (allowDataVersionChange === true) return null;
    if (targetRelease.manifest.dataVersion === current.dataVersion) return null;
    if (!migrationStore) throw domain.createDeveloperError(domain.DEVELOPER_ERR_CONFLICT, "历史版本 dataVersion=" + targetRelease.manifest.dataVersion + "，当前为 " + current.dataVersion + "；没有数据快照时禁止回滚");
    if (!migrationFs) throw domain.createDeveloperError(domain.DEVELOPER_ERR_DEPENDENCY_UNAVAILABLE, "回滚迁移需要 B6 虚拟文件树", { dependency: "migrationFs" });
    const candidates = [...new Set([domain.appReleaseKey(targetRelease.manifest), domain.appReleaseKey(current)])];
    for (const historyId of candidates) {
      if (!migrationStore.hasSnapshots(appId, historyId)) continue;
      try { migrationStore.restoreSnapshots({ appId, historyId, fsAdapter: migrationFs }); return { restoredFrom: historyId }; }
      catch (error) { throw domain.createDeveloperError(domain.DEVELOPER_ERR_CONFLICT, "回滚数据快照失败：" + domain.sanitizeDeveloperText((error && error.message) || error, 200), { historyId }); }
    }
    throw domain.createDeveloperError(domain.DEVELOPER_ERR_CONFLICT, "历史版本 dataVersion=" + targetRelease.manifest.dataVersion + "，当前为 " + current.dataVersion + "；没有数据快照时禁止回滚");
  }

  /**
   * B7h：把"写发布记录 + 启用"合成一个数据库事务（安装失败时两者必须同生共死）。
   * node:sqlite 的 DatabaseSync 没有 better-sqlite3 的 db.transaction()，用 BEGIN/COMMIT/ROLLBACK 复刻；
   * 已在事务内则直接执行，避免嵌套 BEGIN 报错。
   */
  function transaction(fn) {
    if (!db) return fn();
    if (db.isTransaction || db.inTransaction) return fn();
    if (typeof db.transaction === "function") return db.transaction(fn)();
    db.exec("BEGIN");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* 已回滚 */ }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // ① 装载
  // -------------------------------------------------------------------------

  async function install(payload, context) {
    const userId = String(context.userId);
    const buffer = decodePackage(payload);
    const prepared = domain.prepareDeveloperApp(domain.readPackageEntries(buffer), { systemVersion });
    const appId = "dev-" + prepared.manifest.id;
    const existing = store.currentRelease(appId);
    let existingManifest = null;
    if (existing) {
      try { existingManifest = store.readRelease(appId, existing.packagePath).manifest; }
      catch { existingManifest = null; }
    }
    if (existingManifest && payload.allowDowngrade !== true) {
      const comparison = domain.compareAppVersion(prepared.manifest, existingManifest);
      if (comparison < 0) throw domain.createDeveloperError(domain.DEVELOPER_ERR_CONFLICT, "不能降级安装：当前 " + domain.appReleaseKey(existingManifest) + "，安装包 " + domain.appReleaseKey(prepared.manifest));
      if (comparison === 0 && prepared.manifest.releaseChannel !== "dev" && payload.allowSameVersion !== true) throw domain.createDeveloperError(domain.DEVELOPER_ERR_CONFLICT, "已安装相同版本：" + domain.appReleaseKey(prepared.manifest));
    }
    // B7h：数据版本变化必须先声明迁移链；这一条在任何落盘 / 数据库副作用之前判定。
    const dataVersionChanged = !!existingManifest && prepared.manifest.dataVersion !== existingManifest.dataVersion;
    const needsDataMigration = dataVersionChanged && payload.allowDataVersionChange !== true;
    if (needsDataMigration) {
      const declared = Array.isArray(prepared.manifest.migrations) && prepared.manifest.migrations.length > 0;
      if (!declared) throw domain.createDeveloperError(domain.DEVELOPER_ERR_CONFLICT, "数据版本从 " + existingManifest.dataVersion + " 变为 " + prepared.manifest.dataVersion + "；该包未声明声明式数据迁移，已停止更新以保护项目文件");
    }
    const sha = store.sha256(buffer);
    // ① 可失败前置动作：包字节 + release.json 一起原子落盘。这一步失败只清理自己的暂存目录，
    //    迁移与数据库都还没被触碰（不存在"数据已迁移、版本未更新"的中间态）。
    const written = store.writePackage(appId, prepared.manifest, prepared.files, { packageBytes: buffer.length, sha256: sha, capabilities: prepared.capabilities });
    // ② 带快照 / 单个事务的步骤：先迁移（引擎自带项目快照），再在同一数据库事务里写发布记录与启用。
    //    任一步失败：迁移快照恢复（项目数据回到调用前）+ 包目录清理 + 数据库事务回滚（安装态 / 版本不变）。
    let migration = null;
    try {
      if (needsDataMigration) migration = applyDeclaredMigrations({ payload, context, appId, prepared, fromVersion: existingManifest.dataVersion });
      transaction(() => {
        store.activateRelease({ appId, userId, manifest: prepared.manifest, packagePath: written.storageRelPath, packageSize: buffer.length, sha256: sha, now: clock() });
        store.setInstalled(userId, appId, prepared.manifest, clock());
        // X7：principal 与"发布记录 + 启用"同一事务 —— 任一步失败则安装整体回滚，
        // 不留下"已装载但没有 app_principals 身份"的中间态。
        registerAppPrincipal(appId, prepared.manifest);
      });
    } catch (error) {
      rollbackInstall({ appId, written, migration });
      throw error;
    }
    recordEvent(userId, appId, prepared.manifest, existingManifest ? "app.upgrade" : "app.install", { source: asStr(payload.sourceName, 160) || null, from: existingManifest ? domain.appReleaseKey(existingManifest) : null });
    const projected = projectApp(userId, appId);
    if (!appMcpRegistry) return projected;
    // Y4：包字节与安装态都已提交，才注册 App 声明的托管 MCP；注册失败只记录并降级，不回滚安装本身。
    const mcp = await syncAppMcp(userId, appId, written.storageRelPath, prepared.capabilities, prepared.manifest);
    return { ...projected, mcp };
  }

  /**
   * B7h：安装失败时把已完成的可逆副作用退回调用前状态。
   *   · 迁移已成功但后续激活失败 → 恢复迁移前项目快照（引擎只在自身失败时回滚，成功路径不会）；
   *   · 包目录删除；数据库由本地 transaction() 回滚，这里不再动。
   * 快照恢复失败必须出声：此时项目数据可能停在迁移后状态。
   */
  function rollbackInstall({ appId, written, migration }) {
    if (migration) {
      try { migrationStore.restoreSnapshots({ appId, historyId: migration.historyId, fsAdapter: migrationFs }); }
      catch (error) { if (logger) logger("[OpenArc developer] 安装回滚：迁移快照恢复失败：" + String((error && error.message) || error)); }
    }
    try { fs.rmSync(written.absoluteDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  }

  function validatePackage(payload) {
    const buffer = decodePackage(payload);
    const prepared = domain.prepareDeveloperApp(domain.readPackageEntries(buffer), { systemVersion });
    return {
      appId: "dev-" + prepared.manifest.id,
      name: prepared.manifest.name,
      version: prepared.manifest.version,
      build: prepared.manifest.build,
      releaseChannel: prepared.manifest.releaseChannel,
      minSystemVersion: prepared.manifest.minSystemVersion,
      maxSystemVersion: prepared.manifest.maxSystemVersion || null,
      dataVersion: prepared.manifest.dataVersion,
      entry: prepared.manifest.entry,
      fileCount: prepared.files.length,
      packageBytes: buffer.length,
      unpackedBytes: prepared.files.reduce((sum, file) => sum + file.data.length, 0),
      permissions: prepared.capabilities.permissions,
      tools: prepared.capabilities.tools.map((tool) => ({ name: tool.name, risk: tool.risk, handlerType: tool.handlerType })),
      dependencies: prepared.capabilities.dependencies.length,
      mcp: prepared.capabilities.mcp.length,
      skills: prepared.capabilities.skills.length,
      warnings: prepared.capabilities.warnings,
    };
  }

  // -------------------------------------------------------------------------
  // ② / ③ 启用 / 禁用
  // -------------------------------------------------------------------------

  async function enable(payload, context) {
    const userId = String(context.userId);
    const appId = requireAppId(payload);
    const { current, manifest } = loadApp(appId);
    const already = store.getInstalled(userId, appId);
    store.setInstalled(userId, appId, { version: current.version, build: current.build, releaseChannel: current.channel }, clock());
    // X7：幂等补登记 —— 覆盖本次能力之前就已安装、principal 尚未写入的 App。
    // 登记失败不改变"启用"这一已完成的用户状态（与 recordEvent 同口径），但要让调用方看见：
    // 抛出的错误由外层 execute 归一为结构化失败，不由这里吞掉。
    registerAppPrincipal(appId, manifest);
    if (!already) recordEvent(userId, appId, { version: current.version, build: current.build }, "app.enable", null);
    const projected = projectApp(userId, appId);
    if (!appMcpRegistry) return { ...projected, changed: !already };
    // Y4：启用 = 按既有白名单 / 策略重新判定后才连接；判定失败只记录并降级，不改"已启用"事实。
    const mcp = await setAppMcpEnabled(userId, appId, true, current);
    return { ...projected, changed: !already, mcp };
  }

  async function disable(payload, context) {
    const userId = String(context.userId);
    const appId = requireAppId(payload);
    const { current } = loadApp(appId);
    const already = store.getInstalled(userId, appId);
    if (already) {
      store.removeInstalled(userId, appId);
      recordEvent(userId, appId, { version: current.version, build: current.build }, "app.disable", null);
    }
    const projected = projectApp(userId, appId);
    if (!appMcpRegistry) return { ...projected, changed: !!already };
    // Y4：禁用 = 断开 + DISABLED；即使注册表失败，"已禁用"事实也已生效（连接由注册表如实收敛）。
    const mcp = await setAppMcpEnabled(userId, appId, false, current);
    return { ...projected, changed: !!already, mcp };
  }

  // -------------------------------------------------------------------------
  // ④ 回滚
  // -------------------------------------------------------------------------

  function rollback(payload, context) {
    const userId = String(context.userId);
    const appId = requireAppId(payload);
    const { current } = loadApp(appId);
    const history = store.listHistory(appId);
    if (!history.length) throw domain.createDeveloperError(domain.DEVELOPER_ERR_CONFLICT, "没有可回滚的历史版本：" + appId);
    let target = history[0];
    const wanted = requireStr(payload.historyId, 100);
    if (wanted) {
      const found = history.find((item) => item.version + "+" + item.build === wanted || item.version === wanted);
      if (!found) throw domain.createDeveloperError(domain.DEVELOPER_ERR_NOT_FOUND, "历史版本不存在：" + wanted);
      target = found;
    }
    const targetRelease = store.readRelease(appId, target.packagePath);
    // B7f：dataVersion 不同先恢复快照（有则回滚数据，无则保持原来的拒绝语义）。
    applyRollbackMigrations({ appId, current, targetRelease, allowDataVersionChange: payload.allowDataVersionChange });
    store.activateRelease({ appId, userId, manifest: targetRelease.manifest, packagePath: target.packagePath, packageSize: target.packageSize, sha256: target.sha256, now: clock() });
    // 启用状态下同步 user_installed_apps，保证"回滚后运行时状态一致"。
    if (store.getInstalled(userId, appId)) store.setInstalled(userId, appId, targetRelease.manifest, clock());
    recordEvent(userId, appId, targetRelease.manifest, "app.rollback", { from: current.version + "+" + current.build, to: target.version + "+" + target.build });
    return { ...projectApp(userId, appId), rolledBackFrom: { version: current.version, build: current.build } };
  }

  // -------------------------------------------------------------------------
  // ⑤ 卸载
  // -------------------------------------------------------------------------

  async function uninstall(payload, context) {
    const userId = String(context.userId);
    const appId = requireAppId(payload);
    const current = store.currentRelease(appId);
    if (!current) throw domain.createDeveloperError(domain.DEVELOPER_ERR_NOT_FOUND, "开发者应用不存在：" + appId);
    store.removeInstalled(userId, appId);
    store.purgeCredentials(appId);
    store.removeAppPackages(appId);
    store.purgeReleases(appId);
    // X7：App 机器级身份随卸载一并清理（先删该 App 的 grant，再删 built_in = 0 的 principal）；
    // 运行时事件与网络审计保留（审计事实不随卸载消失，源语义）。
    removeAppPrincipal(appId);
    recordEvent(userId, appId, { version: current.version, build: current.build }, "app.uninstall", null);
    if (!appMcpRegistry) return { appId, uninstalled: true, version: current.version, build: current.build };
    // Y4：卸载 = 清理该 App 的全部托管 MCP 记录（断开 + 删除）；失败只记录并降级。
    const mcp = await removeAppMcp(userId, appId, current);
    return { appId, uninstalled: true, version: current.version, build: current.build, mcp };
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  function list(payload, context) {
    const userId = String(context.userId);
    const apps = store.listAppIds().map((appId) => projectApp(userId, appId)).filter(Boolean);
    return { apps, count: apps.length };
  }

  function get(payload, context) {
    const userId = String(context.userId);
    const appId = requireAppId(payload);
    const app = projectApp(userId, appId);
    if (!app) throw domain.createDeveloperError(domain.DEVELOPER_ERR_NOT_FOUND, "开发者应用不存在：" + appId);
    return app;
  }

  function history(payload) {
    const appId = requireAppId(payload);
    const current = store.currentRelease(appId);
    if (!current) throw domain.createDeveloperError(domain.DEVELOPER_ERR_NOT_FOUND, "开发者应用不存在：" + appId);
    return {
      appId,
      current: { version: current.version, build: current.build, releaseChannel: current.channel, publishedAt: current.publishedAt },
      history: store.listHistory(appId).map((item) => ({ version: item.version, build: item.build, releaseChannel: item.channel, dataVersion: item.dataVersion, publishedAt: item.publishedAt, revokedAt: item.revokedAt })),
    };
  }

  // -------------------------------------------------------------------------
  // 出网（源 developerNetwork.ts）
  // -------------------------------------------------------------------------

  async function assertPublicDns(url) {
    let addresses;
    try { addresses = await resolveLookup()(url.hostname, { all: true, verbatim: true }); }
    catch (error) {
      throw domain.createDeveloperError(domain.DEVELOPER_ERR_NETWORK_BLOCKED, "网络请求 DNS 解析失败：" + domain.sanitizeDeveloperText(error && error.message, 200));
    }
    const verdict = domain.evaluableAddressesArePublic(addresses);
    if (!verdict.public) throw domain.createDeveloperError(domain.DEVELOPER_ERR_NETWORK_BLOCKED, "网络请求解析到了内网或保留地址");
    return verdict;
  }

  async function networkEvaluate(payload) {
    const appId = requireAppId(payload);
    const { manifest } = loadApp(appId);
    const policy = domain.requireNetworkPolicy(manifest);
    const target = domain.validateDeveloperNetworkUrl(payload.url, policy);
    let addresses;
    try { addresses = await resolveLookup()(target.host, { all: true, verbatim: true }); }
    catch (error) {
      return { allowed: false, host: target.host, origin: target.origin, reason: "DNS_FAILED", addresses: [], detail: domain.sanitizeDeveloperText(error && error.message, 300) };
    }
    const list = Array.isArray(addresses) ? addresses : [];
    const verdict = domain.evaluableAddressesArePublic(list);
    const mapped = list.map((item) => String(item && item.address != null ? item.address : item));
    if (!verdict.public) return { allowed: false, host: target.host, origin: target.origin, reason: verdict.reason, addresses: mapped };
    return { allowed: true, host: target.host, origin: target.origin, reason: null, addresses: mapped };
  }

  async function networkRequest(payload, context) {
    const userId = String(context.userId);
    const appId = requireAppId(payload);
    const { manifest } = loadApp(appId);
    // 源 developerNetwork.ts:71：限流先于一切校验（被拒绝的请求同样消耗配额）。
    limiter.enforce(userId, appId);
    const policy = domain.requireNetworkPolicy(manifest);
    let target = domain.validateDeveloperNetworkUrl(payload.url, policy);
    const method = String(payload.method || "GET").toUpperCase();
    if (!policy.methods.includes(method)) throw domain.createDeveloperError(domain.DEVELOPER_ERR_FORBIDDEN, "APP 未声明网络方法：" + method);
    const headers = { Accept: "application/json, text/plain, */*" };
    const requested = payload.headers && typeof payload.headers === "object" && !Array.isArray(payload.headers) ? payload.headers : {};
    for (const [name, value] of Object.entries(requested)) {
      const key = name.toLowerCase();
      if (key === "accept" || key === "content-type") headers[key] = String(value).slice(0, 500);
    }
    const bindingId = requireStr(payload.credentialId || payload.secretRef, 120);
    if (bindingId) {
      // 本批不装配 provider 密钥读取：显式拒绝，绝不假造 Authorization。
      throw domain.createDeveloperError(domain.DEVELOPER_ERR_DEPENDENCY_UNAVAILABLE, "凭据发送未装配：缺少 provider 密钥来源（providerId → secret 读取绑定；app_credential_bindings 只存引用不存密钥）", { dependency: "providerStore" });
    }
    let body;
    if (method !== "GET" && payload.body !== undefined) {
      body = typeof payload.body === "string" ? payload.body : JSON.stringify(payload.body);
      if (!headers["content-type"]) headers["content-type"] = typeof payload.body === "string" ? "text/plain; charset=utf-8" : "application/json";
      if (Buffer.byteLength(body, "utf8") > MAX_NETWORK_BODY_BYTES) throw domain.createDeveloperError(domain.DEVELOPER_ERR_INVALID_INPUT, "网络请求体不能超过 2 MB");
    }
    const fetchImpl = resolveFetch();
    let response = null;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      await assertPublicDns(target.url);
      let signal;
      try { signal = AbortSignal.timeout(30_000); } catch { signal = undefined; }
      response = await fetchImpl(target.url, { method, headers, body, redirect: "manual", signal });
      if (!response || !REDIRECT_STATUS.has(response.status)) break;
      const location = response.headers && typeof response.headers.get === "function" ? response.headers.get("location") : null;
      if (!location || redirect === 3) throw domain.createDeveloperError(domain.DEVELOPER_ERR_NETWORK_BLOCKED, "网络请求重定向过多或缺少 Location");
      target = domain.validateDeveloperNetworkUrl(new URL(location, target.url).toString(), policy);
    }
    if (!response) throw domain.createDeveloperError(domain.DEVELOPER_ERR_INTERNAL, "网络请求失败");
    const declaredBytes = Number(response.headers && typeof response.headers.get === "function" ? response.headers.get("content-length") || 0 : 0);
    if (declaredBytes > policy.maxResponseBytes) throw domain.createDeveloperError(domain.DEVELOPER_ERR_NETWORK_BLOCKED, "网络响应超过 APP 声明的大小限制");
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > policy.maxResponseBytes) throw domain.createDeveloperError(domain.DEVELOPER_ERR_NETWORK_BLOCKED, "网络响应超过 APP 声明的大小限制");
    const contentType = response.headers && typeof response.headers.get === "function" ? response.headers.get("content-type") || "application/octet-stream" : "application/octet-stream";
    store.insertNetworkAudit({ userId, appId, method, origin: target.url.origin, pathname: target.url.pathname.slice(0, 500), status: response.status, responseBytes: data.byteLength, credentialRef: false, now: clock() });
    if (payload.responseType === "base64") return { status: response.status, ok: !!response.ok, url: target.url.toString(), contentType, encoding: "base64", bytes: data.byteLength };
    const text = data.toString("utf8");
    if (payload.responseType === "json" || contentType.includes("application/json")) {
      try { return { status: response.status, ok: !!response.ok, url: target.url.toString(), contentType, body: JSON.parse(text) }; }
      catch { /* 回退文本 */ }
    }
    return { status: response.status, ok: !!response.ok, url: target.url.toString(), contentType, body: text };
  }

  // -------------------------------------------------------------------------
  // 凭据绑定 / 运行时事件 / 健康
  // -------------------------------------------------------------------------

  function credentialBind(payload, context) {
    const userId = String(context.userId);
    const appId = requireAppId(payload);
    loadApp(appId);
    const binding = store.bindCredential(userId, appId, payload);
    recordEvent(userId, appId, store.currentRelease(appId) || {}, "app.credential.bind", { bindingId: binding.bindingId });
    return binding;
  }

  function credentialList(payload, context) {
    const userId = String(context.userId);
    const appId = requireAppId(payload);
    loadApp(appId);
    return { appId, bindings: store.listCredentials(userId, appId) };
  }

  function credentialUnbind(payload, context) {
    const userId = String(context.userId);
    const appId = requireAppId(payload);
    const bindingId = requireStr(payload.bindingId, 100);
    if (!bindingId) throw domain.createDeveloperError(domain.DEVELOPER_ERR_INVALID_INPUT, "需要 bindingId");
    const removed = store.unbindCredential(userId, appId, bindingId);
    return { appId, bindingId, removed: removed > 0 };
  }

  function runtimeReport(payload, context) {
    const userId = String(context.userId);
    const appId = requireAppId(payload);
    const current = store.currentRelease(appId);
    if (!current) throw domain.createDeveloperError(domain.DEVELOPER_ERR_NOT_FOUND, "开发者应用不存在：" + appId);
    const eventType = requireStr(payload.eventType, 60);
    if (!eventType) throw domain.createDeveloperError(domain.DEVELOPER_ERR_INVALID_INPUT, "需要 eventType");
    return store.recordRuntimeEvent({ userId, appId, version: current.version, build: current.build, eventType, detail: payload.detail, now: clock() });
  }

  /**
   * B7h：health 不再报静态白名单长度，而是"实际可达命令数"= 基座 16 条 + 已装配切片的命令数。
   * context.extensionStatus 由 developer-bootstrap.cjs 在装配点计算并注入：
   *   { extensions: { lab, collab, migrations, realtime }, extensionCommands, degraded, error }。
   * 未注入（直接调用 bundle）时只报基座可达数，不假装知道切片状态。
   */
  function health(context) {
    const tables = store.tableReport();
    const missing = Object.keys(tables).filter((name) => tables[name] !== true);
    const baseCommands = Object.keys(domain.DEVELOPER_BASE_COMMANDS).length;
    const injected = context && context.extensionStatus && typeof context.extensionStatus === "object" ? context.extensionStatus : null;
    const extensionCommands = injected && Number.isFinite(injected.extensionCommands) ? Math.max(0, Math.trunc(injected.extensionCommands)) : 0;
    const extensions = injected && injected.extensions && typeof injected.extensions === "object" ? injected.extensions : null;
    return {
      ok: !!db && missing.length === 0,
      tables,
      tablesReady: missing.length === 0,
      missingTables: missing,
      dataRootReady: !!dataRoot,
      installedApps: store.listAppIds().length,
      commands: baseCommands + extensionCommands,
      declaredCommands: domain.listDeveloperCommands().length,
      extensions,
      degraded: injected ? injected.degraded === true : false,
      degradedReason: injected && injected.error ? injected.error : null,
      network: { httpsOnly: true, dnsPublicCheck: true, rateLimitPerMinute: limiter.limit },
    };
  }

  // -------------------------------------------------------------------------
  // 分发 / 身份 / 出口
  // -------------------------------------------------------------------------

  async function dispatch(command, payload, context) {
    const body = payload && typeof payload === "object" ? payload : {};
    switch (command) {
      case "developer/install": return install(body, context);
      case "developer/uninstall": return uninstall(body, context);
      case "developer/enable": return enable(body, context);
      case "developer/disable": return disable(body, context);
      case "developer/rollback": return rollback(body, context);
      case "developer/list": return list(body, context);
      case "developer/get": return get(body, context);
      case "developer/history": return history(body);
      case "developer/validate": return validatePackage(body);
      case "developer/credential/bind": return credentialBind(body, context);
      case "developer/credential/list": return credentialList(body, context);
      case "developer/credential/unbind": return credentialUnbind(body, context);
      case "developer/network/evaluate": return networkEvaluate(body);
      case "developer/network/request": return networkRequest(body, context);
      case "developer/runtime/report": return runtimeReport(body, context);
      case "developer/health": return health(context);
      default: throw domain.developerCommandNotAllowed(command);
    }
  }

  function resolveActor(context) {
    if (!authorization || typeof authorization.resolveActor !== "function") return { ok: false, message: "授权服务未装配" };
    try {
      const result = authorization.resolveActor({ context });
      if (!result || result.ok !== true || !result.user || result.user.id == null) return { ok: false, message: (result && (result.error || result.reason)) || "会话无效" };
      return result;
    } catch (error) {
      return { ok: false, message: String((error && error.message) || error) };
    }
  }

  async function execute(command, payload, ctx = {}) {
    if (!domain.isDeveloperCommand(command)) return domain.normalizeDeveloperError(domain.developerCommandNotAllowed(command));
    const context = {
      sessionRef: requireStr(ctx && ctx.sessionRef, 160) || null,
      appId: requireStr(ctx && ctx.appId, 60) || HOST_APP_ID,
      source: "developer",
      requestId: requireStr(ctx && ctx.requestId, 100) || null,
      // B7h：装配点注入的切片状态，只用于 health 投影（不参与命令分发）。
      extensionStatus: ctx && ctx.extensionStatus && typeof ctx.extensionStatus === "object" ? ctx.extensionStatus : null,
    };
    const actorResult = resolveActor(context);
    if (!actorResult.ok) return domain.normalizeDeveloperError(domain.createDeveloperError(domain.DEVELOPER_ERR_UNAUTHENTICATED, actorResult.message || "当前会话未认证，developer 命令被拒绝"));
    context.userId = String(actorResult.user.id);
    context.actor = actorResult.user;
    // 除纯解析（validate）与健康检查外，其余命令都需要真实数据库连接：缺连接一律结构化拒绝。
    if (!db && command !== "developer/health" && command !== "developer/validate") {
      return domain.normalizeDeveloperError(domain.createDeveloperError(domain.DEVELOPER_ERR_DEPENDENCY_UNAVAILABLE, "开发者平台需要数据库连接", { dependency: "identityStore" }));
    }
    try {
      const value = await dispatch(command, payload, context);
      return { ok: true, value: domain.redactDeveloperValue(value) };
    } catch (error) {
      return domain.normalizeDeveloperError(error);
    }
  }

  return {
    execute,
    health,
    paths: dataRoot ? { root: dataRoot, apps: store.paths ? store.paths.root : null } : null,
    dependencies: Object.freeze({
      userDataDir: !!userDataDir,
      database: !!db,
      identity: !!authorization,
      // X7：principal 登记通道是否接上（未接上时 install/enable 不写 app_principals，如实报 false）。
      authStore: !!authStore,
      // Y4：App 托管 MCP 注册表是否接上（未接上时启用/禁用/卸载不碰 MCP 连接，如实报 false）。
      appMcpRegistry: !!appMcpRegistry,
      injectedLookup: typeof injectedLookup === "function",
      injectedFetch: typeof injectedFetch === "function",
    }),
  };
}

module.exports = { createDeveloperBundle, HOST_APP_ID };
