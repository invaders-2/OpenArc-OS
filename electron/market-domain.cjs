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


/** 应用条目的来源/更新元数据（task-31）：只收 https，长度/大小/摘要全部有界。 */
const APP_PACKAGE_LIMITS = Object.freeze({ url: 2048, sha256: 64, size: 20 * 1024 * 1024 * 1024, version: 64 });
function httpsUrl(value, max) {
  const text = stringValue(value, max);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch { return undefined; }
}
function normalizeAppPackage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const url = httpsUrl(value.url, APP_PACKAGE_LIMITS.url);
  const sha256 = stringValue(value.sha256, APP_PACKAGE_LIMITS.sha256).toLowerCase();
  const size = Number(value.size);
  const version = stringValue(value.version, APP_PACKAGE_LIMITS.version);
  if (!url || !/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(size) || size < 1 || size > APP_PACKAGE_LIMITS.size || !version) return null;
  return { url, sha256, size, version };
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
  const sourceUrl = httpsUrl(value.sourceUrl, APP_PACKAGE_LIMITS.url);
  const appPackage = normalizeAppPackage(value.package);
  const app = {
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
    // task-21 additive：详情六段与可复制提示词（本地清单可给真实文案；缺省为空，界面据此显示「暂无」）
    prompt: stringValue(value.prompt, 4000),
    sections: normalizeSections(value.sections),
    // task-31 additive：来源 / 更新元数据（可选；非法字段丢弃并计入 rejected）
    builtIn: value.builtIn === true,
    sourceUrl: sourceUrl || "",
    package: appPackage,
  };
  // 给了但不合法：字段丢弃，清单统计 rejected.appSources / rejected.appPackages（条目本身保留）。
  if (value.sourceUrl !== undefined && !sourceUrl) app.__sourceInvalid = true;
  if (value.package !== undefined && !appPackage) app.__packageInvalid = true;
  return app;
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
    // task-21 additive：官方技能包在本地清单里也能带真实提示词 / 六段 / 分类 / 精选
    category: identifier(value.category) || "",
    summary: stringValue(value.summary, 1200),
    prompt: stringValue(value.prompt, 4000),
    featured: value.featured === true,
    sections: normalizeSections(value.sections),
  };
}

/** 六段详情（additive：本地清单可以给真实文案；缺字段一律空串，界面据此显示「暂无」）。 */
const SECTION_KEYS = Object.freeze(["what", "context", "how", "output", "scope", "followUp"]);
const SECTION_MAX = 1200;
function normalizeSections(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const key of SECTION_KEYS) {
    const text = stringValue(value[key], SECTION_MAX);
    if (text) out[key] = text;
  }
  return out;
}

const TEMPLATE_KINDS = Object.freeze(["text", "image", "video", "audio"]);
const TEMPLATE_STEPS_MAX = 12;
const TEMPLATE_STEP_TITLE_MAX = 160;
const TEMPLATE_STEP_DETAIL_MAX = 800;

/**
 * 项目模板（task-21 新增，additive）：把画布已有的 starter flow 写成**真实**条目。
 * 必填 id / name / prompt（模板要能「复制提示词」与「立即体验」）；步骤、分类、精选、发布时间可选且有界。
 * 非法条目返回 null，由调用方丢弃并计入 rejected.templates。
 */
function normalizeMarketplaceTemplate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = identifier(value.id);
  const name = stringValue(value.name, 120);
  const prompt = stringValue(value.prompt, 4000);
  if (!id || !name || !prompt) return null;
  const steps = (Array.isArray(value.steps) ? value.steps : []).slice(0, TEMPLATE_STEPS_MAX).flatMap((step) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) return [];
    const title = stringValue(step.title, TEMPLATE_STEP_TITLE_MAX);
    const detail = stringValue(step.detail, TEMPLATE_STEP_DETAIL_MAX);
    if (!title && !detail) return [];
    return [{ title, detail }];
  });
  const doc = normalizeTemplateDoc(value.doc);
  const template = {
    id, name,
    version: stringValue(value.version, 64) || "1.0.0",
    kind: TEMPLATE_KINDS.includes(value.kind) ? value.kind : "text",
    category: identifier(value.category) || "",
    summary: stringValue(value.summary, 1200),
    prompt,
    steps,
    nodeTitle: stringValue(value.nodeTitle, 120) || (steps[0] && steps[0].title) || name,
    tags: stringArray(value.tags, 12),
    featured: value.featured === true,
    publishedAt: Math.max(0, Math.round(Number(value.publishedAt) || 0)),
    sections: normalizeSections(value.sections),
    doc: doc || null,
  };
  // 给了 doc 但不合法：模板保留（可退回只建首节点），由清单统计 rejected.templateDocs。
  if (value.doc !== undefined && !doc) template.__docInvalid = true;
  return template;
}

/** 精选 rails（additive）：id + title 必填；itemIds 有界并只保留合法 id 形状。 */
function normalizeRailPages(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const id = identifier(item.id);
    const title = stringValue(item.title, 80);
    if (!id || !title) return [];
    const itemIds = [...new Set(stringArray(item.itemIds, 30).map((entry) => identifier(entry)).filter(Boolean))];
    return [{ id, title, itemIds }];
  });
}


/* ── 模板文档（task-26）：真实画布文档子集 ──────────────────────────────
   节点 = { id, kind, x, y, w, h, title, text, prompt, params?, table? }；连线 = { id, from, to }。
   全部有界：节点 ≤30、连线 ≤60、id 唯一、kind 白名单、坐标 ±200000、尺寸 40–4000、
   文案 ≤4000、连线端点必须存在；任一不合法 → 整个 doc 丢弃（模板本身保留，退回「只建首节点」）。 */
const TEMPLATE_NODE_KINDS = Object.freeze(["text", "image", "video", "audio", "table"]);
const TEMPLATE_DOC_LIMITS = Object.freeze({ nodes: 30, edges: 60, coord: 200000, minSize: 40, maxSize: 4000, title: 120, copy: 4000, columns: 12, column: 60, rows: 50, cell: 500 });
const TEXT_OUTPUTS = Object.freeze(["text", "table", "storyboard"]);

function boundedNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeTemplateTable(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const title = stringValue(value.title, TEMPLATE_DOC_LIMITS.title) || "多维表格";
  const rawColumns = Array.isArray(value.columns) ? value.columns : [];
  const columns = rawColumns.slice(0, TEMPLATE_DOC_LIMITS.columns)
    .map((column) => stringValue(column, TEMPLATE_DOC_LIMITS.column))
    .filter(Boolean);
  if (!columns.length) return null;
  const rawRows = Array.isArray(value.rows) ? value.rows : [];
  const rows = rawRows.slice(0, TEMPLATE_DOC_LIMITS.rows).map((row) => {
    const cells = Array.isArray(row) ? row : [];
    const out = columns.map((_, index) => stringValue(cells[index], TEMPLATE_DOC_LIMITS.cell));
    return out;
  });
  return { title, columns, rows };
}

function normalizeTemplateParams(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out = {};
  if (TEXT_OUTPUTS.includes(value.output)) out.output = value.output;
  if (typeof value.ratio === "string" && /^[0-9]{1,2}:[0-9]{1,2}$/.test(value.ratio)) out.ratio = value.ratio;
  if (Number.isFinite(Number(value.count))) out.count = boundedNumber(value.count, 1, 1, 8);
  if (Number.isFinite(Number(value.dur))) out.dur = boundedNumber(value.dur, 5, 1, 60);
  if (typeof value.mode === "string" && value.mode.trim()) out.mode = stringValue(value.mode, 24);
  return Object.keys(out).length ? out : undefined;
}

function normalizeTemplateDoc(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawNodes = Array.isArray(value.nodes) ? value.nodes : [];
  const rawEdges = Array.isArray(value.edges) ? value.edges : (Array.isArray(value.connections) ? value.connections : []);
  if (!rawNodes.length || rawNodes.length > TEMPLATE_DOC_LIMITS.nodes) return null;
  if (rawEdges.length > TEMPLATE_DOC_LIMITS.edges) return null;
  const nodes = [];
  const seen = new Set();
  for (const raw of rawNodes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const id = stringValue(raw.id, 120);
    if (!/^[a-zA-Z0-9._:-]+$/.test(id) || seen.has(id)) return null;
    if (!TEMPLATE_NODE_KINDS.includes(raw.kind)) return null;
    seen.add(id);
    const width = boundedNumber(raw.w, 260, TEMPLATE_DOC_LIMITS.minSize, TEMPLATE_DOC_LIMITS.maxSize);
    const height = boundedNumber(raw.h, 220, TEMPLATE_DOC_LIMITS.minSize, TEMPLATE_DOC_LIMITS.maxSize);
    const node = {
      id, kind: raw.kind,
      x: boundedNumber(raw.x, 0, -TEMPLATE_DOC_LIMITS.coord, TEMPLATE_DOC_LIMITS.coord),
      y: boundedNumber(raw.y, 0, -TEMPLATE_DOC_LIMITS.coord, TEMPLATE_DOC_LIMITS.coord),
      w: Math.round(width), h: Math.round(height),
      title: stringValue(raw.title, TEMPLATE_DOC_LIMITS.title),
      text: stringValue(raw.text, TEMPLATE_DOC_LIMITS.copy),
      prompt: stringValue(raw.prompt, TEMPLATE_DOC_LIMITS.copy),
    };
    const params = normalizeTemplateParams(raw.params);
    if (params) node.params = params;
    if (raw.kind === "table") {
      const table = normalizeTemplateTable(raw.table);
      if (!table) return null;
      node.table = table;
    }
    nodes.push(node);
  }
  const edges = [];
  const edgeIds = new Set();
  for (let index = 0; index < rawEdges.length; index += 1) {
    const raw = rawEdges[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const from = stringValue(raw.from, 120);
    const to = stringValue(raw.to, 120);
    if (!seen.has(from) || !seen.has(to) || from === to) return null;
    let id = stringValue(raw.id, 120);
    if (!id) id = "e_" + index;
    if (edgeIds.has(id)) return null;
    edgeIds.add(id);
    edges.push({ id, from, to });
  }
  return { nodes, edges };
}

/**
 * market-service.cjs 的纯函数核心：校验并规范化**本地**清单。
 *
 * 合法清单（catalog.json）：对象 + version===1 + apps / skillPacks 至少一个是数组；
 * 逐条不合格的 App / 技能包被丢弃并计数；整份清单结构性不合法、或某一非空数组 0 条有效 → 拒绝。
 */

/** 详情投影（task-31）：应用条目 → 界面详情要用的来源/更新/安装信息（纯函数，单测覆盖）。 */
function projectMarketplaceAppDetail(app) {
  const source = app && typeof app === "object" ? app : {};
  const pkg = source.package && typeof source.package === "object" ? source.package : null;
  return {
    builtIn: source.builtIn === true,
    sourceUrl: typeof source.sourceUrl === "string" ? source.sourceUrl : "",
    packageUrl: pkg && typeof pkg.url === "string" ? pkg.url : "",
    packageSize: pkg && Number.isFinite(Number(pkg.size)) ? Number(pkg.size) : 0,
    packageSha256: pkg && typeof pkg.sha256 === "string" ? pkg.sha256 : "",
    packageVersion: pkg && typeof pkg.version === "string" ? pkg.version : "",
    updateCommand: source.builtIn === true ? "market/update/health" : null,
    install: pkg
      ? { enabled: false, reason: "THIRD_PARTY_PACKAGE_CHANNEL_NOT_WIRED" }
      : { enabled: false, reason: "NO_PACKAGE" },
  };
}

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
  // task-21 additive：templates / railPages 可选；给了就必须是数组（形状错误仍按清单非法处理）。
  if (raw.templates !== undefined && !Array.isArray(raw.templates)) {
    return { ok: false, error: createMarketError(MARKET_ERR_MANIFEST_INVALID, "本地市场清单 templates 必须是数组") };
  }

  const appList = hasApps ? raw.apps : [];
  const skillList = hasSkillPacks ? raw.skillPacks : [];
  const templateList = Array.isArray(raw.templates) ? raw.templates : [];
  const apps = appList.map(normalizeMarketplaceApp).filter(Boolean);
  const appSourcesInvalid = apps.filter((app) => app.__sourceInvalid === true).length;
  const appPackagesInvalid = apps.filter((app) => app.__packageInvalid === true).length;
  for (const app of apps) { delete app.__sourceInvalid; delete app.__packageInvalid; }
  const skillPacks = skillList.map(normalizeLocalSkillPack).filter(Boolean);
  const templates = templateList.map(normalizeMarketplaceTemplate).filter(Boolean);
  // 文档不合法只丢弃 doc（模板退回首节点），单独计数；不把整条模板判死。
  const templateDocsInvalid = templates.filter((template) => template.__docInvalid === true).length;
  for (const template of templates) delete template.__docInvalid;
  const rejected = {
    apps: appList.length - apps.length,
    skillPacks: skillList.length - skillPacks.length,
    templates: templateList.length - templates.length,
    templateDocs: templateDocsInvalid,
    appSources: appSourcesInvalid,
    appPackages: appPackagesInvalid,
  };
  if (appList.length > 0 && apps.length === 0) {
    return { ok: false, error: createMarketError(MARKET_ERR_MANIFEST_INVALID, "本地市场清单 apps 全部非法（" + appList.length + " 条）") };
  }
  if (skillList.length > 0 && skillPacks.length === 0) {
    return { ok: false, error: createMarketError(MARKET_ERR_MANIFEST_INVALID, "本地市场清单 skillPacks 全部非法（" + skillList.length + " 条）") };
  }
  if (templateList.length > 0 && templates.length === 0) {
    return { ok: false, error: createMarketError(MARKET_ERR_MANIFEST_INVALID, "本地市场清单 templates 全部非法（" + templateList.length + " 条）") };
  }

  const counts = new Map();
  for (const app of apps) {
    if (!app.categoryIds.length) app.categoryIds = [app.category];
    for (const id of app.categoryIds) counts.set(id, (counts.get(id) || 0) + 1);
  }
  // 分类计数也把技能包与模板算进去（分类不再只统计 App）
  for (const pack of skillPacks) if (pack.category) counts.set(pack.category, (counts.get(pack.category) || 0) + 1);
  for (const template of templates) if (template.category) counts.set(template.category, (counts.get(template.category) || 0) + 1);
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
      templates,
      railPages: normalizeRailPages(raw.railPages),
      rejected,
    },
  };
}

module.exports = {
  MARKET_COMMANDS, isMarketCommand, createMarketError, normalizeMarketError, marketCommandNotAllowed,
  MARKET_ERR_CATALOG_MISSING, MARKET_ERR_MANIFEST_INVALID, MARKET_ERR_NOT_FOUND, MARKET_ERR_INVALID_INPUT,
  MARKET_ERR_UNAUTHENTICATED, MARKET_ERR_COMMAND_NOT_ALLOWED, MARKET_ERR_INTERNAL, MARKET_ERROR_CODES,
  stringValue, optionalUrl, stringArray, channel, category, identifier, bannerColor,
  normalizeMarketplaceBanner, normalizeMarketplaceApp, normalizeLocalSkillPack, normalizeMarketplaceTemplate,
  normalizeRailPages, normalizeSections, SECTION_KEYS, TEMPLATE_KINDS, TEMPLATE_NODE_KINDS,
  normalizeTemplateDoc, normalizeTemplateTable, normalizeTemplateParams, TEMPLATE_DOC_LIMITS, normalizeLocalManifest,
  normalizeAppPackage, httpsUrl, APP_PACKAGE_LIMITS, projectMarketplaceAppDetail,
};
