/**
 * B7c · 本地市场装配 + market:command 分发（唯一执行入口）。
 *
 * 只做**本地清单**（任务书 item 4）：
 *   · 从"随包目录"或"本地目录"读取 catalog.json（默认文件名；可注入）；
 *   · 列出可用 App 与技能包；清单结构非法 → MARKET_MANIFEST_INVALID；
 *   · **不联网、不下载、不安装** —— 本文件没有 fetch / http / net，也不含任何 api.dx-os.com。
 *
 * OUT（任务书硬约束，一律不引入）：云发布 / 审核 / 灰度 / 下载 / 远端更新；
 *   源 marketplace.ts:1 的 DEFAULT_MARKETPLACE_API_BASE_URL 及其 request()/marketplaceExplore()
 *   /marketplaceAppDetail() 全部不做（本地部分只有纯规范化，见 market-domain.cjs）。
 *
 * 目录来源优先级（第一个存在 catalog.json 的胜出）：
 *   ① options.marketDir（显式注入，测试用）
 *   ② <appDir>/resources/market（随包）
 *   ③ <userData>/dxos/market（本地）
 * 绝对路径永不过桥：payload 只含 source:"local" 与文件名，不含目录。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const marketDomain = require("./market-domain.cjs");
const { resolveDxosPaths } = require("./dxos-foundation-paths.cjs");

const HOST_APP_ID = "market-center";
const DEFAULT_MANIFEST_NAME = "catalog.json";
const CATALOG_CACHE_MS = 5000;

const asStr = (value, max = 200) => (typeof value === "string" ? value.slice(0, max) : value == null ? undefined : String(value).slice(0, max));

function createMarketBundle(options = {}) {
  const userDataDir = options.userDataDir ? String(options.userDataDir) : null;
  const appDir = options.appDir ? String(options.appDir) : null;
  const marketDir = options.marketDir ? String(options.marketDir) : null;
  const manifestName = asStr(options.manifestName, 80) || DEFAULT_MANIFEST_NAME;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const logger = typeof options.logger === "function" ? options.logger : null;

  function candidateDirs() {
    const dirs = [];
    if (marketDir) dirs.push(marketDir);
    if (appDir) dirs.push(path.join(appDir, "resources", "market"));
    if (userDataDir) dirs.push(path.join(resolveDxosPaths(userDataDir).root, "market"));
    return dirs;
  }

  /** 只认"目录下存在清单文件"的候选；都不存在时返回第一个候选用于报错。 */
  function resolveCatalogDir() {
    const dirs = candidateDirs();
    for (const dir of dirs) {
      try { if (fs.statSync(path.join(dir, manifestName)).isFile()) return dir; } catch { /* 继续 */ }
    }
    return dirs[0] || null;
  }

  let cache = null;
  function readRawManifest() {
    const dir = resolveCatalogDir();
    if (!dir) return { ok: false, error: marketDomain.createMarketError(marketDomain.MARKET_ERR_CATALOG_MISSING, "没有配置本地市场目录（marketDir / resources/market / <userData>/dxos/market 都不存在）") };
    const file = path.join(dir, manifestName);
    let stat;
    try { stat = fs.statSync(file); } catch {
      return { ok: false, error: marketDomain.createMarketError(marketDomain.MARKET_ERR_CATALOG_MISSING, "本地市场清单不存在：" + manifestName) };
    }
    if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size && clock() - cache.at < CATALOG_CACHE_MS) {
      return { ok: true, raw: cache.raw };
    }
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch (error) {
      return { ok: false, error: marketDomain.createMarketError(marketDomain.MARKET_ERR_CATALOG_MISSING, "本地市场清单读取失败：" + asStr(error && error.message, 200)) };
    }
    let raw;
    try { raw = JSON.parse(text); } catch {
      return { ok: false, error: marketDomain.createMarketError(marketDomain.MARKET_ERR_MANIFEST_INVALID, "本地市场清单不是合法 JSON") };
    }
    cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, at: clock(), raw };
    return { ok: true, raw };
  }

  function loadCatalog() {
    const read = readRawManifest();
    if (!read.ok) return { ok: false, error: read.error.code, detail: read.error.message };
    const normalized = marketDomain.normalizeLocalManifest(read.raw, { generatedAt: clock() });
    if (!normalized.ok) return { ok: false, error: normalized.error.code, detail: normalized.error.message };
    return { ok: true, value: normalized.value };
  }

  function catalogStatus() {
    const read = readRawManifest();
    if (!read.ok) return { present: false, valid: false, manifestName, appCount: 0, skillPackCount: 0, reason: read.error.code };
    const normalized = marketDomain.normalizeLocalManifest(read.raw, { generatedAt: clock() });
    if (!normalized.ok) return { present: true, valid: false, manifestName, appCount: 0, skillPackCount: 0, reason: normalized.error.code };
    return { present: true, valid: true, manifestName, appCount: normalized.value.apps.length, skillPackCount: normalized.value.skillPacks.length, reason: null };
  }

  function findApp(id) {
    const key = marketDomain.identifier(id);
    if (!key) return { ok: false, error: marketDomain.MARKET_ERR_INVALID_INPUT, detail: "APP ID 不合法" };
    const catalog = loadCatalog();
    if (!catalog.ok) return catalog;
    const app = catalog.value.apps.find((item) => item.id === key);
    if (!app) return { ok: false, error: marketDomain.MARKET_ERR_NOT_FOUND, detail: "本地市场没有该 App：" + key };
    return { ok: true, value: app };
  }

  function findSkillPack(id) {
    const key = marketDomain.identifier(id);
    if (!key) return { ok: false, error: marketDomain.MARKET_ERR_INVALID_INPUT, detail: "技能包 ID 不合法" };
    const catalog = loadCatalog();
    if (!catalog.ok) return catalog;
    const pack = catalog.value.skillPacks.find((item) => item.id === key);
    if (!pack) return { ok: false, error: marketDomain.MARKET_ERR_NOT_FOUND, detail: "本地市场没有该技能包：" + key };
    return { ok: true, value: pack };
  }

  async function execute(command, payload = {}, context = {}) {
    try {
      const sessionRef = context && context.sessionRef ? context.sessionRef : null;
      if (!sessionRef) return { ok: false, error: marketDomain.MARKET_ERR_UNAUTHENTICATED, detail: "market:command 需要已认证会话" };
      if (!marketDomain.isMarketCommand(command)) return marketDomain.normalizeMarketError(marketDomain.marketCommandNotAllowed(command));
      switch (command) {
        case "market/catalog": {
          const catalog = loadCatalog();
          return catalog.ok ? { ok: true, value: catalog.value } : { ok: false, error: catalog.error, detail: catalog.detail };
        }
        case "market/apps/list": {
          const catalog = loadCatalog();
          return catalog.ok ? { ok: true, value: { items: catalog.value.apps, total: catalog.value.apps.length, rejected: catalog.value.rejected.apps } } : { ok: false, error: catalog.error, detail: catalog.detail };
        }
        case "market/skillpacks/list": {
          const catalog = loadCatalog();
          return catalog.ok ? { ok: true, value: { items: catalog.value.skillPacks, total: catalog.value.skillPacks.length, rejected: catalog.value.rejected.skillPacks } } : { ok: false, error: catalog.error, detail: catalog.detail };
        }
        case "market/apps/get": return findApp(payload.id != null ? payload.id : payload.appId);
        case "market/skillpacks/get": return findSkillPack(payload.id != null ? payload.id : payload.skillPackId);
        case "market/health": {
          const status = catalogStatus();
          return { ok: true, value: { ok: true, source: "local", commands: marketDomain.MARKET_COMMANDS.length, ...status } };
        }
        default:
          return marketDomain.normalizeMarketError(marketDomain.marketCommandNotAllowed(command));
      }
    } catch (error) {
      if (logger) { try { logger("market-execute-failed", { message: asStr(error && error.message, 200) }); } catch { /* 忽略 */ } }
      return marketDomain.normalizeMarketError(error);
    }
  }

  return {
    hostAppId: HOST_APP_ID,
    manifestName,
    commands: marketDomain.MARKET_COMMANDS.slice(),
    // 测试与主进程内部用：不经过 IPC，也不返回给渲染层。
    resolveCatalogDir,
    loadCatalog,
    catalogStatus,
    execute,
  };
}

module.exports = { createMarketBundle, HOST_APP_ID, DEFAULT_MANIFEST_NAME };
