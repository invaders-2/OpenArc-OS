/**
 * B7d · 领星集成（组合：映射表格 + 本地数据缓存 + 同步作业 + 凭据）。
 *
 * 组成（逐字对应源文件）：
 *   · server/lingxingMappings.ts:1-289   → integration-lingxing-mappings.cjs
 *   · server/lingxingLocalData.ts:1-787  → integration-lingxing-local-data.cjs
 *
 * 任务书硬约束落地：
 *   · **云 API 一律走注入 transport**（plugin-service 注入 options.transport）；未注入即
 *     结构化 INTEGRATION_UNAVAILABLE，绝不假数据；
 *   · **凭据一律走 credential-store（safeStorage）**：本模块只保存 credentialRef + 掩码，
 *     明文只进 safeStorage 后端；投影只给掩码；
 *   · 名称与输出字段与源逐字对应；失败抛带 code 的 Error，由 plugin-service 转结构化。
 */
"use strict";

const { INTEGRATION_ERR_UNAVAILABLE, INTEGRATION_ERR_INVALID_INPUT } = require("./plugin-registry.cjs");
const { createLingxingMappings } = require("./integration-lingxing-mappings.cjs");
const { createLingxingLocalData } = require("./integration-lingxing-local-data.cjs");
const { maskSecret } = require("./integration-dingtalk.cjs");

const CREDENTIAL_REF = "lingxing.credential";

const asStr = (value, max = 4096) => (typeof value === "string" ? value.slice(0, max) : value == null ? "" : String(value).slice(0, max));
function fail(code, detail) { const error = new Error(detail); error.code = code; return error; }

function createLingxingIntegration(options = {}) {
  const dataDir = options.dataDir ? String(options.dataDir) : null;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const transport = typeof options.transport === "function" ? options.transport : null;
  const credentials = options.credentials && typeof options.credentials === "object" ? options.credentials : null;

  const mappings = createLingxingMappings({ dataDir, readWorkbook: options.readWorkbook, clock });
  const localData = createLingxingLocalData({ dataDir, clock, transport });

  const credentialsAvailable = () => !!credentials && typeof credentials.available === "function" && credentials.available() === true;
  function readSecret() {
    if (!credentialsAvailable() || typeof credentials.get !== "function") return "";
    try { return asStr(credentials.get(CREDENTIAL_REF), 4096); } catch { return ""; }
  }

  function status() {
    const mapping = mappings.getLingxingMapping();
    const cache = localData.lingxingCacheStats();
    return {
      transportInjected: typeof transport === "function",
      dataDir,
      mapping: { uploaded: !!mapping, asinCount: mapping ? mapping.asinCount : 0, rowCount: mapping ? mapping.rowCount : 0 },
      cache: { rows: cache.rows, days: cache.days.length, cacheDays: cache.cacheDays, bytes: cache.bytes },
      safeStorageAvailable: credentialsAvailable(),
      credentialSet: !!readSecret(),
    };
  }

  // ── 凭据（只落 credentialRef；明文进 safeStorage） ──
  function saveCredential(input = {}) {
    const secret = asStr(input && input.secret, 4096).trim();
    if (!secret) throw fail(INTEGRATION_ERR_INVALID_INPUT, "凭据不能为空");
    if (!credentialsAvailable() || typeof credentials.put !== "function") {
      throw fail(INTEGRATION_ERR_UNAVAILABLE, "safeStorage 不可用，领星凭据无法加密保存；为不落明文，本功能停用");
    }
    credentials.put(CREDENTIAL_REF, secret);
    return { ref: CREDENTIAL_REF, credentialSet: true, mask: maskSecret(secret) };
  }
  function credentialStatus() {
    const secret = readSecret();
    return { ref: CREDENTIAL_REF, credentialSet: !!secret, mask: maskSecret(secret), safeStorageAvailable: credentialsAvailable() };
  }
  function clearCredential() {
    if (credentialsAvailable() && typeof credentials.delete === "function") { try { credentials.delete(CREDENTIAL_REF); } catch { /* 忽略 */ } }
    return { ref: CREDENTIAL_REF, credentialSet: false };
  }

  return {
    CREDENTIAL_REF,
    dataDir,
    mappings,
    localData,
    credentialsAvailable,
    status,
    // 映射（源 lingxingMappings.ts 函数名逐字）
    importLingxingMapping: (file) => mappings.importLingxingMapping(file),
    getLingxingMapping: () => mappings.getLingxingMapping(),
    getLingxingMappingFile: () => mappings.getLingxingMappingFile(),
    clearLingxingMapping: () => mappings.clearLingxingMapping(),
    // 本地缓存 / 同步作业（源 lingxingLocalData.ts 函数名逐字）
    lingxingCacheStats: () => localData.lingxingCacheStats(),
    getLingxingCacheJob: (id) => localData.getLingxingCacheJob(id),
    startLingxingCacheSync: (days) => localData.startLingxingCacheSync(days),
    lingxingLocalRows: (date, limit, offset) => localData.lingxingLocalRows(date, limit, offset),
    queryLingxingLocalData: (queryOptions) => localData.queryLingxingLocalData(queryOptions),
    clearLingxingStoredData: (scope) => localData.clearLingxingStoredData(scope),
    // 广告缓存 / 同步作业
    lingxingAdvertisingCacheStats: () => localData.lingxingAdvertisingCacheStats(),
    getLingxingAdvertisingCacheJob: (id) => localData.getLingxingAdvertisingCacheJob(id),
    startLingxingAdvertisingCacheSync: (days, profileIds) => localData.startLingxingAdvertisingCacheSync(days, profileIds),
    stopLingxingAdvertisingCacheJob: (id) => localData.stopLingxingAdvertisingCacheJob(id),
    listCachedLingxingAdvertisingStores: () => localData.listCachedLingxingAdvertisingStores(),
    queryLingxingAdvertisingCache: (queryOptions) => localData.queryLingxingAdvertisingCache(queryOptions),
    // 凭据
    saveCredential,
    credentialStatus,
    clearCredential,
    whenIdle: () => localData.whenIdle(),
    close: () => localData.close(),
  };
}

module.exports = { createLingxingIntegration, CREDENTIAL_REF };
