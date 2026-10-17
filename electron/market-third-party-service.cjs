"use strict";
/**
 * task-19 B · 第三方应用目录与安装（本地 catalog + 在线源）。
 *
 * 命令族：market/thirdparty/list | install | rollback | source/get | source/set
 *
 * 信任链（与官方应用同一套，不另造）：
 *   ① 目录条目形状校验：非内置 id、semver、HTTPS 白名单 URL 或安全相对 packageFile、sha256；
 *   ② 兼容性：minSystemVersion / maxSystemVersion 对当前 app 版本逐条判定，不满足直接拒绝；
 *   ③ 包摘要：下载/读取后 sha256 必须与目录声明一致；
 *   ④ 包签名：交给 market-update-service 的同一条 installPackageBuffer（manifest.sig + 逐文件 sha256
 *      + 原子切换 + 安装后加载复核）；失败时 update service 自己恢复旧指针并清掉新目录；
 *   ⑤ 注册表：安装前写 "installing"，成功后写 "installed"；任何失败都移除，绝不留下"目录里有、磁盘没有"。
 *
 * 在线目录源只允许 HTTPS + 既有白名单主机（与更新源同一份 ALLOWED_HOSTS），逐跳校验重定向；
 * 目录体积上限 2MB。在线目录失败不影响本地目录与已安装列表（结构化 error 字段回显）。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const domain = require("./market-update-domain.cjs");
const thirdDomain = require("./market-third-party-domain.cjs");
const { resolveDxosPaths } = require("./dxos-foundation-paths.cjs");

const HOST_APP_ID = "market-center";
const REGISTRY_FORMAT = "openarc-third-party-installed/v1";
const MAX_CATALOG_BYTES = thirdDomain.MAX_CATALOG_BYTES;

const asStr = (value, max = 300) => (typeof value === "string" ? value.slice(0, max) : value == null ? "" : String(value).slice(0, max));
const sha256Hex = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/** 已安装第三方应用注册表：<dxos>/market/third-party-installed.json。 */
class ThirdPartyRegistry {
  constructor({ userDataDir, clock = null } = {}) {
    if (!userDataDir) throw new Error("ThirdPartyRegistry 需要 userDataDir");
    this.file = path.join(resolveDxosPaths(String(userDataDir)).root, "market", "third-party-installed.json");
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.cache = null;
  }
  read() {
    if (this.cache) return this.cache;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { raw = null; }
    const apps = raw && raw.format === REGISTRY_FORMAT && raw.apps && typeof raw.apps === "object" && !Array.isArray(raw.apps) ? raw.apps : {};
    this.cache = { format: REGISTRY_FORMAT, apps };
    return this.cache;
  }
  has(id) { return Object.prototype.hasOwnProperty.call(this.read().apps, String(id || "")); }
  ids() { return Object.keys(this.read().apps); }
  get(id) { const apps = this.read().apps; return apps[String(id || "")] || null; }
  list() { return Object.entries(this.read().apps).map(([id, entry]) => ({ id, ...entry })).sort((a, b) => a.id.localeCompare(b.id)); }
  set(entry) {
    const state = this.read();
    state.apps[entry.id] = { ...entry, updatedAt: Number(this.clock()) };
    writeJsonAtomic(this.file, state);
    return state.apps[entry.id];
  }
  remove(id) {
    const state = this.read();
    if (!Object.prototype.hasOwnProperty.call(state.apps, id)) return false;
    delete state.apps[id];
    writeJsonAtomic(this.file, state);
    return true;
  }
}

function createThirdPartyRegistry(options = {}) { return new ThirdPartyRegistry(options); }

/**
 * @param {object} options
 * @param {{execute:Function, installPackageBuffer:Function, rollback:Function}} options.updateService
 * @param {ThirdPartyRegistry} options.registry
 * @param {string} options.systemVersion 当前应用版本（兼容性判定）
 */
function createThirdPartyMarket(options = {}) {
  const userDataDir = options.userDataDir ? String(options.userDataDir) : "";
  if (!userDataDir) throw new Error("createThirdPartyMarket 需要 userDataDir");
  const dxosRoot = resolveDxosPaths(userDataDir).root;
  const appDir = options.appDir ? String(options.appDir) : path.join(__dirname, "..");
  const catalogFile = options.catalogFile ? String(options.catalogFile) : path.join(dxosRoot, "market", "third-party.json");
  const bundledCatalogFile = path.join(appDir, "resources", "market", "third-party.json");
  const sourceFile = path.join(dxosRoot, "market", "third-party-source.json");
  const registry = options.registry && typeof options.registry.has === "function" ? options.registry : createThirdPartyRegistry({ userDataDir, clock: options.clock });
  const updateService = options.updateService && typeof options.updateService.installPackageBuffer === "function" ? options.updateService : null;
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : (typeof fetch === "function" ? fetch : null);
  const authorization = options.authorization && typeof options.authorization === "object" ? options.authorization : null;
  const systemVersion = domain.parseSemver(options.systemVersion) ? domain.parseSemver(options.systemVersion).version : domain.DEFAULT_BUILTIN_VERSION;
  const maxPackageBytes = Number.isFinite(Number(options.maxPackageBytes)) && Number(options.maxPackageBytes) > 0 ? Number(options.maxPackageBytes) : domain.MAX_PACKAGE_BYTES;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const logger = typeof options.logger === "function" ? options.logger : null;

  function readSourceUrl() {
    try {
      const raw = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
      return raw && typeof raw.url === "string" && raw.url.trim() ? raw.url.trim() : null;
    } catch { return null; }
  }

  function validateOnlineUrl(url) {
    if (typeof url !== "string" || !url.trim()) throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_INVALID_INPUT, "在线目录 URL 不能为空");
    let parsed;
    try { parsed = new URL(url.trim()); } catch { throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_SOURCE_NOT_ALLOWED, "在线目录 URL 不合法"); }
    if (parsed.protocol !== "https:") throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_SOURCE_NOT_ALLOWED, "在线目录只允许 HTTPS");
    try { domain.assertAllowedUrl(parsed.toString(), domain.ALLOWED_HOSTS); }
    catch { throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_SOURCE_NOT_ALLOWED, "在线目录主机不在白名单：" + parsed.hostname); }
    return parsed.toString();
  }

  function setSource(url) {
    if (url == null || url === "") {
      try { fs.rmSync(sourceFile, { force: true }); } catch { /* 忽略 */ }
      return { url: null };
    }
    const normalized = validateOnlineUrl(url);
    writeJsonAtomic(sourceFile, { url: normalized, updatedAt: Number(clock()) });
    return { url: normalized };
  }

  function readCatalogFile(file) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
    let raw;
    try { raw = JSON.parse(text); } catch { return { present: true, ok: false, apps: [], rejected: [], error: thirdDomain.MARKET_THIRDPARTY_ERR_CATALOG_INVALID, detail: "第三方目录不是合法 JSON" }; }
    const normalized = thirdDomain.normalizeCatalog(raw, { source: "local" });
    if (!normalized.ok) return { present: true, ok: false, apps: [], rejected: [], error: normalized.error.code, detail: normalized.error.message };
    return { present: true, ok: true, apps: normalized.value.apps, rejected: normalized.value.rejected };
  }

  /** 本地目录：优先 <dxos>/market/third-party.json，其次随包 resources/market/third-party.json。 */
  function localCatalog() {
    const primary = readCatalogFile(catalogFile);
    if (primary) return { ...primary, dir: path.dirname(catalogFile) };
    const bundled = readCatalogFile(bundledCatalogFile);
    if (bundled) return { ...bundled, dir: path.dirname(bundledCatalogFile) };
    return { present: false, ok: true, apps: [], rejected: [], dir: path.dirname(catalogFile) };
  }

  async function fetchLimited(url, accept, maxBytes) {
    let current = validateOnlineUrl(url);
    for (let hop = 0; hop < 6; hop += 1) {
      let response;
      try { response = await fetchImpl(current, { redirect: "manual", headers: { accept, "user-agent": "OpenArc-OS-thirdparty-market" } }); }
      catch (error) { throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_DOWNLOAD_FAILED, "网络请求失败：" + asStr(error && error.message, 200)); }
      if (!response || typeof response.status !== "number") throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_DOWNLOAD_FAILED, "网络响应无效");
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers && typeof response.headers.get === "function" ? response.headers.get("location") : null;
        if (!location) throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_DOWNLOAD_FAILED, "重定向缺少 Location");
        current = validateOnlineUrl(new URL(location, current).toString());
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_DOWNLOAD_FAILED, "下载失败 HTTP " + response.status);
      let buffer;
      try { buffer = Buffer.from(await response.arrayBuffer()); } catch { throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_DOWNLOAD_FAILED, "响应读取失败"); }
      if (!buffer.length) throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_DOWNLOAD_FAILED, "响应为空");
      if (buffer.length > maxBytes) throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_DOWNLOAD_FAILED, "响应超过体积上限 " + maxBytes + " 字节");
      return buffer;
    }
    throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_DOWNLOAD_FAILED, "重定向次数过多");
  }

  async function onlineCatalog() {
    const url = readSourceUrl();
    if (!url) return { configured: false, ok: false, apps: [], rejected: [], error: null, detail: null };
    if (!fetchImpl) return { configured: true, url, ok: false, apps: [], rejected: [], error: thirdDomain.MARKET_THIRDPARTY_ERR_NOT_READY, detail: "没有可用的 fetch 实现" };
    try {
      const bytes = await fetchLimited(url, "application/json", MAX_CATALOG_BYTES);
      let raw;
      try { raw = JSON.parse(bytes.toString("utf8")); } catch { throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_CATALOG_INVALID, "在线目录不是合法 JSON"); }
      const normalized = thirdDomain.normalizeCatalog(raw, { source: "online" });
      if (!normalized.ok) throw normalized.error;
      return { configured: true, url, ok: true, apps: normalized.value.apps, rejected: normalized.value.rejected, error: null, detail: null };
    } catch (error) {
      const normalized = thirdDomain.normalizeThirdPartyError(error);
      return { configured: true, url, ok: false, apps: [], rejected: [], error: normalized.error, detail: normalized.detail };
    }
  }

  async function findEntry(appId, { online = true } = {}) {
    const local = localCatalog();
    const fromLocal = local.ok && local.apps.find((entry) => entry.id === appId);
    if (fromLocal) return { entry: { ...fromLocal, source: "local" }, catalogDir: local.dir };
    if (!online) return null;
    const remote = await onlineCatalog();
    const fromOnline = remote.ok && remote.apps.find((entry) => entry.id === appId);
    return fromOnline ? { entry: { ...fromOnline, source: "online" }, catalogDir: null } : null;
  }

  async function readPackageBytes(entry, catalogDir) {
    if (entry.packageFile) {
      if (!catalogDir) throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_INVALID_INPUT, "packageFile 只能用于本地目录");
      const file = path.resolve(catalogDir, entry.packageFile);
      if (!file.startsWith(path.resolve(catalogDir) + path.sep)) throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_INVALID_INPUT, "packageFile 越界");
      try { return fs.readFileSync(file); }
      catch (error) { throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_DOWNLOAD_FAILED, "本地包读取失败：" + asStr(error && error.message, 200)); }
    }
    if (!fetchImpl) throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_NOT_READY, "没有可用的 fetch 实现");
    return fetchLimited(entry.packageUrl, "application/octet-stream", maxPackageBytes);
  }

  function resolveActor(context) {
    if (!authorization || typeof authorization.resolveActor !== "function") return { ok: false, message: "授权服务未装配" };
    try {
      const result = authorization.resolveActor({ context });
      if (!result || result.ok !== true || !result.user || result.user.id == null) return { ok: false, message: (result && (result.error || result.reason)) || "会话无效" };
      return result;
    } catch (error) { return { ok: false, message: String((error && error.message) || error) }; }
  }

  function writeAudit(actor, { appId, action, decision, reasonCode, version, requestId }) {
    try {
      const store = authorization && authorization.store;
      if (!store || typeof store.auditAuthorization !== "function") return false;
      store.auditAuthorization({
        userId: actor && actor.user ? actor.user.id : null,
        action, resourceType: "app", resourceId: appId, decision, reasonCode,
        appId: HOST_APP_ID, source: "THIRD_PARTY_MARKET", requestId: requestId || null,
        permissions: actor && actor.isSuper ? ["SUPER_ADMIN"] : ["USER"],
        oldPermissions: null, newPermissions: version ? [{ kind: "third_party", version }] : null,
      });
      return true;
    } catch { return false; }
  }

  function installedList() {
    return registry.list().map((item) => {
      const current = updateService ? updateService.readCurrent(item.id) : null;
      return {
        id: item.id, name: item.name || null, version: item.version || null,
        status: item.status || "installed", source: item.source || null,
        installedAt: item.installedAt || null,
        currentVersion: current ? current.version : null,
        effectiveSource: current ? "installed" : "builtin",
      };
    });
  }

  async function list({ online = true } = {}) {
    const local = localCatalog();
    const remote = online === false ? { configured: !!readSourceUrl(), ok: false, apps: [], rejected: [], error: null, detail: null } : await onlineCatalog();
    return {
      systemVersion,
      local: { present: local.present, ok: local.ok, apps: local.apps, rejected: local.rejected, error: local.error || null, detail: local.detail || null },
      online: remote.configured === false
        ? { configured: false, ok: false, apps: [], rejected: [], error: null, detail: null }
        : { configured: true, ok: remote.ok, apps: remote.apps, rejected: remote.rejected, error: remote.error || null, detail: remote.detail || null },
      installed: installedList(),
    };
  }

  async function install({ appId, confirm } = {}, actor, context) {
    const requestId = context && context.requestId ? context.requestId : null;
    let id = null;
    if (!updateService) {
      const normalized = thirdDomain.normalizeThirdPartyError(thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_NOT_READY, "在线更新服务尚未装配"));
      writeAudit(actor, { appId: "unknown", action: "unknown.thirdparty.install", decision: "DENY", reasonCode: normalized.error, requestId });
      return normalized;
    }
    try {
      id = typeof appId === "string" ? appId.trim() : "";
      if (!domain.APP_ID_RE.test(id)) throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_INVALID_INPUT, "第三方应用 id 不合法");
      if (thirdDomain.isReservedAppId(id)) throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_RESERVED_APP, "不能通过第三方目录覆盖内置应用：" + id);
      if (confirm !== true) throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_INVALID_INPUT, "install 必须显式 confirm:true");
      const found = await findEntry(id);
      if (!found) throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_NOT_FOUND, "第三方目录里没有该应用：" + id);
      const entry = found.entry;
      const compatibility = thirdDomain.checkCompatibility(entry, systemVersion);
      if (!compatibility.ok) throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_NOT_COMPATIBLE, compatibility.detail);
      const already = registry.get(id);
      const current = updateService.readCurrent(id);
      if (already && already.status === "installed" && already.version === entry.version && current && current.version === entry.version) {
        return { ok: true, value: { installed: { appId: id, version: entry.version, alreadyInstalled: true }, previous: null } };
      }
      const bytes = await readPackageBytes(entry, found.catalogDir);
      if (entry.size != null && bytes.length !== entry.size) throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_DIGEST_MISMATCH, "包体积与目录声明不一致（" + bytes.length + " != " + entry.size + "）");
      if (sha256Hex(bytes) !== entry.sha256) throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_DIGEST_MISMATCH, "包 sha256 与目录声明不一致");
      // 先登记为 installing：update service / 通用解析器在安装过程中就能识别这个 appId；失败恢复成安装前的注册表状态。
      const previousRegistry = registry.get(id);
      registry.set({ id, name: entry.name, version: entry.version, status: "installing", source: entry.source, sha256: entry.sha256, installedAt: null });
      let result;
      try {
        result = updateService.installPackageBuffer({ appId: id, bytes, version: entry.version });
      } catch (error) {
        if (previousRegistry) registry.set(previousRegistry); else registry.remove(id);
        const code = error && error.code ? String(error.code) : "";
        if (code === domain.MARKET_UPDATE_ERR_NOT_LOADABLE) throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_NOT_LOADABLE, asStr(error.message, 300));
        if (code === domain.MARKET_UPDATE_ERR_SIGNATURE_INVALID) throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_SIGNATURE_INVALID, asStr(error.message, 300));
        if (code === domain.MARKET_UPDATE_ERR_DIGEST_MISMATCH) throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_DIGEST_MISMATCH, asStr(error.message, 300));
        throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_INSTALL_FAILED, asStr(error && error.message, 300));
      }
      const installedEntry = registry.set({ id, name: entry.name, version: result.installed.version, status: "installed", source: entry.source, sha256: entry.sha256, digest: result.installed.digest, kind: result.installed.kind, entry: result.installed.entry, installedAt: Number(clock()) });
      writeAudit(actor, { appId: id, action: id + ".thirdparty.install", decision: "ALLOW", reasonCode: "ALLOW", version: result.installed.version, requestId });
      return { ok: true, value: { installed: { appId: id, version: installedEntry.version, digest: installedEntry.digest, kind: installedEntry.kind, entry: installedEntry.entry }, previous: result.previous || null } };
    } catch (error) {
      if (id && registry.has(id) && registry.get(id).status === "installing") registry.remove(id);
      const normalized = thirdDomain.normalizeThirdPartyError(error);
      writeAudit(actor, { appId: id || "unknown", action: (id || "unknown") + ".thirdparty.install", decision: "DENY", reasonCode: normalized.error, requestId });
      return normalized;
    }
  }

  async function rollback({ appId } = {}, actor, context) {
    const requestId = context && context.requestId ? context.requestId : null;
    const id = typeof appId === "string" ? appId.trim() : "";
    try {
      if (!updateService) throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_NOT_READY, "在线更新服务尚未装配");
      if (!domain.APP_ID_RE.test(id) || !registry.has(id)) throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_NOT_FOUND, "没有安装过该第三方应用：" + id);
      const result = await updateService.rollback({ appId: id }, actor, context);
      if (!result || result.ok !== true) {
        throw thirdDomain.createThirdPartyError(thirdDomain.MARKET_THIRDPARTY_ERR_RESTORE_FAILED, "回滚失败：" + asStr(result && (result.detail || result.error), 300));
      }
      const current = updateService.readCurrent(id);
      const existing = registry.get(id) || { id };
      registry.set({ ...existing, status: current ? "installed" : "rolled-back", currentVersion: current ? current.version : null });
      writeAudit(actor, { appId: id, action: id + ".thirdparty.rollback", decision: "ALLOW", reasonCode: "ALLOW", version: result.value && result.value.rolledBackTo, requestId });
      return { ok: true, value: result.value };
    } catch (error) {
      const normalized = thirdDomain.normalizeThirdPartyError(error);
      writeAudit(actor, { appId: id || "unknown", action: (id || "unknown") + ".thirdparty.rollback", decision: "DENY", reasonCode: normalized.error, requestId });
      return normalized;
    }
  }

  function sourceInfo() {
    return { url: readSourceUrl() };
  }

  async function execute(command, payload = {}, context = {}) {
    try {
      if (!thirdDomain.isThirdPartyCommand(command)) return thirdDomain.normalizeThirdPartyError(thirdDomain.thirdPartyCommandNotAllowed(command));
      const sessionRef = context && context.sessionRef ? String(context.sessionRef) : null;
      if (!sessionRef) return { ok: false, error: thirdDomain.MARKET_THIRDPARTY_ERR_UNAUTHENTICATED, detail: "market/thirdparty 需要已认证会话" };
      const actor = resolveActor(context);
      if (!actor.ok) return { ok: false, error: thirdDomain.MARKET_THIRDPARTY_ERR_UNAUTHENTICATED, detail: actor.message || "会话无效" };
      const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
      switch (command) {
        case "market/thirdparty/list": return { ok: true, value: await list({ online: body.online !== false }) };
        case "market/thirdparty/install": return await install({ appId: body.appId, confirm: body.confirm === true }, actor, context);
        case "market/thirdparty/rollback": return await rollback({ appId: body.appId }, actor, context);
        case "market/thirdparty/source/get": return { ok: true, value: sourceInfo() };
        case "market/thirdparty/source/set": return { ok: true, value: setSource(body.url) };
        default: return thirdDomain.normalizeThirdPartyError(thirdDomain.thirdPartyCommandNotAllowed(command));
      }
    } catch (error) {
      if (logger) { try { logger("thirdparty-market-failed", { command, message: asStr(error && error.message, 200) }); } catch { /* 忽略 */ } }
      return thirdDomain.normalizeThirdPartyError(error);
    }
  }

  return {
    hostAppId: HOST_APP_ID,
    commands: thirdDomain.THIRDPARTY_COMMANDS.slice(),
    registry,
    catalogFile,
    sourceFile,
    systemVersion,
    execute,
    list,
    install,
    rollback,
    setSource,
    sourceInfo,
  };
}

module.exports = { createThirdPartyRegistry, createThirdPartyMarket, ThirdPartyRegistry, REGISTRY_FORMAT };
