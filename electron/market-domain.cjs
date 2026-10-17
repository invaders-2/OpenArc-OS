/**
 * B7c · 本地市场域（移植 server/marketplace.ts:1-335 的**本地规范化部分**）。
 *
 * 逐函数对应：
 *   marketplace.ts:116   stringValue(value, max)
 *   marketplace.ts:117-124 optionalUrl（只允许 HTTPS，开发用 localhost）
 *   marketplace.ts:125-128 stringArray
 *   marketplace.ts:129   channel
 *   marketplace.ts:130   category
 *   marketplace.ts:131-134 identifier
 *   marketplace.ts:136-139 bannerColor
 *   marketplace.ts:141-170 normalizeMarketplaceBanner
 *   marketplace.ts:181-205 normalizeApp
 *   marketplace.ts:216-233 分类（含 software / games 兜底）
 *
 * OUT（一律不引入，任务书硬约束）：
 *   · DEFAULT_MARKETPLACE_API_BASE_URL = https://api.dx-os.com（marketplace.ts:1）
 *   · request() / marketplaceExplore() / marketplaceAppDetail()（marketplace.ts:172-179、207-335）
 *     —— 云发布 / 审核 / 灰度 / 下载一律不做；本文件只有本地清单的读取与校验。
 *
 * 本文件只做纯函数：没有 fs、没有网络、没有 Electron。落盘读取在 market-service.cjs。
 */
"use strict";

// ── 统一错误码 ──
const MARKET_ERR_CATALOG_MISSING = "MARKET_CATALOG_MISSING";
const MARKET_ERR_MANIFEST_INVALID = "MARKET_MANIFEST_INVALID";
const MARKET_ERR_NOT_FOUND = "MARKET_NOT_FOUND";
const MARKET_ERR_INVALID_INPUT = "MARKET_INVALID_INPUT";
const MARKET_ERR_UNAUTHENTICATED = "MARKET_UNAUTHENTICATED";
const MARKET_ERR_COMMAND_NOT_ALLOWED = "MARKET_COMMAND_NOT_ALLOWED";
const MARKET_ERR_INTERNAL = "MARKET_INTERNAL";

const MARKET_ERROR_CODES = Object.freeze([
  MARKET_ERR_CATALOG_MISSING,
  MARKET_ERR_MANIFEST_INVALID,
  MARKET_ERR_NOT_FOUND,
  MARKET_ERR_INVALID_INPUT,
  MARKET_ERR_UNAUTHENTICATED,
  MARKET_ERR_COMMAND_NOT_ALLOWED,
  MARKET_ERR_INTERNAL,
]);

const MARKET_COMMANDS = Object.freeze([
  "market/catalog",
  "market/apps/list",
  "market/apps/get",
  "market/skillpacks/list",
  "market/skillpacks/get",
  "market/health",
  // task-19 B：第三方应用目录 / 安装 / 回滚 / 在线目录源（执行端是 market-third-party-service.cjs）。
  "market/thirdparty/list",
  "market/thirdparty/install",
  "market/thirdparty/rollback",
  "market/thirdparty/source/get",
  "market/thirdparty/source/set",
]);

const MARKET_COMMAND_SET = new Set(MARKET_COMMANDS);
function isMarketCommand(command) { return typeof command === "string" && MARKET_COMMAND_SET.has(command); }

function createMarketError(code, message, detail) {
  const err = new Error(String(message == null ? code : message));
  err.name = "MarketError";
  err.code = MARKET_ERROR_CODES.includes(code) ? code : MARKET_ERR_INTERNAL;
  if (detail !== undefined) err.detail = detail;
  return err;
}

function normalizeMarketError(err) {
  if (err && typeof err === "object" && MARKET_ERROR_CODES.includes(err.code)) {
    return { ok: false, error: err.code, detail: String(err.message || err.code).slice(0, 400) };
  }
  return { ok: false, error: MARKET_ERR_INTERNAL, detail: String((err && err.message) || err || MARKET_ERR_INTERNAL).slice(0, 400) };
}

function marketCommandNotAllowed(command) {
  return createMarketError(MARKET_ERR_COMMAND_NOT_ALLOWED, "未知或未授权的 market 命令：" + String(command == null ? "" : command), { command: command == null ? null : String(command) });
}

// ── marketplace.ts:116-139 逐字移植 ──
function stringValue(value, max = 500) { return String(value || "").trim().slice(0, max); }

function optionalUrl(value) {
  const text = stringValue(value, 2048);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname)) ? url.toString() : undefined;
  } catch { return undefined; }
}

function stringArray(value, limit) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringValue(item, 2048)).filter(Boolean).slice(0, limit);
}

function channel(value) { return value === "beta" || value === "dev" ? value : "stable"; }
function category(value) { return value === "games" ? "games" : "software"; }
function identifier(value, max = 120) {
  const text = stringValue(value, max);
  return /^[a-zA-Z0-9._-]+$/.test(text) ? text : "";
}
function bannerColor(value) {
  const color = stringValue(value, 7).toUpperCase();
  return /^#[0-9A-F]{6}$/.test(color) ? color : undefined;
}

// ── marketplace.ts:141-170 逐字移植 ──
function normalizeMarketplaceBanner(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = stringValue(value.id, 120);
  const title = stringValue(value.title, 180);
  if (!id || !title) return null;
  const tone = value.tone === "green" || value.tone === "purple" || value.tone === "dark" ? value.tone : "blue";
  const linkUrl = optionalUrl(value.linkUrl);
  const destinationMode = value.destinationMode === "external" && linkUrl ? "external" : "collection";
  const appIds = [...new Set(stringArray(value.appIds, 50).map((appId) => identifier(appId)).filter(Boolean))];
  const appId = identifier(value.appId) || appIds[0] || undefined;
  return {
    id, tag: stringValue(value.tag, 60), title, description: stringValue(value.description, 500),
    imageUrl: optionalUrl(value.imageUrl), appId, appIds,
    targetMode: value.targetMode === "category" ? "category" : "manual",
    categoryId: identifier(value.categoryId) || undefined,
    actionLabel: stringValue(value.actionLabel, 40) || undefined,
    destinationMode, linkUrl: destinationMode === "external" ? linkUrl : undefined,
    textColor: bannerColor(value.textColor), edgeLeftColor: bannerColor(value.edgeLeftColor), edgeRightColor: bannerColor(value.edgeRightColor),
    tone,
  };
}

// ── marketplace.ts:181-205 逐字移植（导出名加 Marketplace 前缀以示同源） ──
function normalizeMarketplaceApp(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = stringValue(value.id, 120);
  const name = stringValue(value.name, 120);
  const version = stringValue(value.version, 64);
  const build = Number(value.build);
  if (!/^[a-zA-Z0-9._-]+$/.test(id) || !name || !version || !Number.isSafeInteger(build) || build < 1) return null;
  return {
    id, name,
    category: category(value.category),
    categoryIds: [...new Set(stringArray(value.categoryIds, 30).map((item) => identifier(item)).filter(Boolean))],
    subtitle: stringValue(value.subtitle, 160),
    summary: stringValue(value.summary, 800),
    iconUrl: optionalUrl(value.iconUrl),
    coverImageUrl: optionalUrl(value.coverImageUrl),
    tags: stringArray(value.tags, 12),
    featured: value.featured === true,
    version, build,
    channel: channel(value.channel),
    packageSize: Math.max(0, Math.round(Number(value.packageSize) || 0)),
    minSystemVersion: stringValue(value.minSystemVersion, 64) || "0.1.0",
    publishedAt: Math.max(0, Math.round(Number(value.publishedAt) || 0)),
  };
}

/** 本地技能包条目（源 marketplace.ts 无对应字段：本地市场新增，形状尽量贴近 App 摘要）。 */
function normalizeLocalSkillPack(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = identifier(value.id);
  const name = stringValue(value.name, 120);
  const version = stringValue(value.version, 64);
  if (!id || !name || !version) return null;
  let entry = stringValue(value.entry, 240);
  // 相对路径白名单：拒绝绝对路径与目录穿越（本地清单也不允许指向任意磁盘位置）。
  if (entry && (entry.startsWith("/") || entry.startsWith("\\") || entry.split(/[\\/]+/).includes(".."))) entry = "";
  return {
    id, name, version,
    description: stringValue(value.description, 1200),
    icon: stringValue(value.icon, 200),
    tags: stringArray(value.tags, 12),
    packageSize: Math.max(0, Math.round(Number(value.packageSize) || 0)),
    entry: entry || undefined,
    publishedAt: Math.max(0, Math.round(Number(value.publishedAt) || 0)),
  };
}

/**
 * market-service.cjs 的纯函数核心：校验并规范化**本地**清单。
 *
 * 合法清单（catalog.json）：对象 + version===1 + apps / skillPacks 至少一个是数组；
 * 逐条不合格的 App / 技能包被丢弃并计数；整份清单结构性不合法、或某一非空数组 0 条有效 → 拒绝。
 */
function normalizeLocalManifest(raw, { generatedAt = 0 } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: createMarketError(MARKET_ERR_MANIFEST_INVALID, "本地市场清单必须是 JSON 对象") };
  }
  const version = Number(raw.version);
  if (version !== 1) {
    return { ok: false, error: createMarketError(MARKET_ERR_MANIFEST_INVALID, "本地市场清单 version 必须为 1（收到 " + stringValue(raw.version, 40) + "）") };
  }
  const hasApps = raw.apps !== undefined;
  const hasSkillPacks = raw.skillPacks !== undefined;
  if (!hasApps && !hasSkillPacks) {
    return { ok: false, error: createMarketError(MARKET_ERR_MANIFEST_INVALID, "本地市场清单缺少 apps 或 skillPacks 数组") };
  }
  if (hasApps && !Array.isArray(raw.apps)) {
    return { ok: false, error: createMarketError(MARKET_ERR_MANIFEST_INVALID, "本地市场清单 apps 必须是数组") };
  }
  if (hasSkillPacks && !Array.isArray(raw.skillPacks)) {
    return { ok: false, error: createMarketError(MARKET_ERR_MANIFEST_INVALID, "本地市场清单 skillPacks 必须是数组") };
  }

  const appList = hasApps ? raw.apps : [];
  const skillList = hasSkillPacks ? raw.skillPacks : [];
  const apps = appList.map(normalizeMarketplaceApp).filter(Boolean);
  const skillPacks = skillList.map(normalizeLocalSkillPack).filter(Boolean);
  const rejected = { apps: appList.length - apps.length, skillPacks: skillList.length - skillPacks.length };
  if (appList.length > 0 && apps.length === 0) {
    return { ok: false, error: createMarketError(MARKET_ERR_MANIFEST_INVALID, "本地市场清单 apps 全部非法（" + appList.length + " 条）") };
  }
  if (skillList.length > 0 && skillPacks.length === 0) {
    return { ok: false, error: createMarketError(MARKET_ERR_MANIFEST_INVALID, "本地市场清单 skillPacks 全部非法（" + skillList.length + " 条）") };
  }

  const counts = new Map();
  for (const app of apps) {
    if (!app.categoryIds.length) app.categoryIds = [app.category];
    for (const id of app.categoryIds) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const categories = (Array.isArray(raw.categories) ? raw.categories : []).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const id = identifier(value.id);
    const name = stringValue(value.name, 80);
    if (!id || !name || ["all", "updates", "developer", "system"].includes(id)) return [];
    return [{
      id, name,
      icon: stringValue(value.icon, 12),
      description: stringValue(value.description, 240),
      count: Math.max(0, Math.round(Number(value.count) || counts.get(id) || 0)),
    }];
  });
  if (!categories.length) categories.push(
    { id: "software", name: "普通软件", icon: "▦", description: "", count: counts.get("software") || 0 },
    { id: "games", name: "游戏", icon: "◈", description: "", count: counts.get("games") || 0 },
  );

  const pageRaw = raw.page && typeof raw.page === "object" && !Array.isArray(raw.page) ? raw.page : {};
  return {
    ok: true,
    value: {
      generatedAt: Math.max(0, Math.round(Number(raw.generatedAt) || generatedAt || 0)),
      page: { id: identifier(pageRaw.id) || "local", title: stringValue(pageRaw.title, 120) || "本地市场" },
      source: "local",
      categories,
      apps,
      skillPacks,
      rejected,
    },
  };
}

module.exports = {
  MARKET_COMMANDS, isMarketCommand, createMarketError, normalizeMarketError, marketCommandNotAllowed,
  MARKET_ERR_CATALOG_MISSING, MARKET_ERR_MANIFEST_INVALID, MARKET_ERR_NOT_FOUND, MARKET_ERR_INVALID_INPUT,
  MARKET_ERR_UNAUTHENTICATED, MARKET_ERR_COMMAND_NOT_ALLOWED, MARKET_ERR_INTERNAL, MARKET_ERROR_CODES,
  stringValue, optionalUrl, stringArray, channel, category, identifier, bannerColor,
  normalizeMarketplaceBanner, normalizeMarketplaceApp, normalizeLocalSkillPack, normalizeLocalManifest,
};
