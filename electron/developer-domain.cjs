/**
 * B7a · 开发者平台纯逻辑（**无 I/O**）：命令白名单 + 风险/凭据属性 + dx-app/v2 清单校验
 * + 包条目围栏 + 出网判定口径 + 版本语义 + 错误规约。
 *
 * 为什么单独一层：developer:command 是本轮新增的顶层 IPC 通道，"哪些命令可被渲染层调用、
 * 每条命令的风险等级、是否触碰凭据、失败时回什么码"必须先在一处冻结，再交给
 * electron/developer-store.cjs 落盘、electron/developer-service.cjs 分发、
 * electron/developer-bootstrap.cjs 注册。命令表本身即白名单：未登记命令一律
 * DEVELOPER_COMMAND_NOT_ALLOWED，不做动态 dispatch。
 *
 * 逐函数移植自只读源（行号为源文件行号）：
 *   · shared/appLifecycle.ts:1-85        isValidSemver / compareSemver / compareAppVersion /
 *                                        appReleaseKey / systemSupportsApp（版本与回滚比较的唯一口径）
 *   · server/developerApps.ts:221-234    safePath / slug / decodeUploadName
 *   · server/developerApps.ts:352-370    cleanStringList / cleanObject / normalizeToolName / normalizePermission
 *   · server/developerApps.ts:375-377    normalizeDependencyId
 *   · server/developerApps.ts:411-475    normalizeManifest（含版本字段 / 权限 / 工具 / 入口）
 *   · server/developerApps.ts:477-531    appApi / automation 声明
 *   · server/developerApps.ts:533-564    network / oauth 声明
 *   · server/developerApps.ts:566-588    migrations 声明
 *   · server/developerApps.ts:589-606    mcp 声明
 *   · server/developerApps.ts:681-756    validateDeclaredPackageFiles / normalizeDependencyList / normalizeToolManifest
 *   · server/developerApps.ts:757-819    normalizePermissions / scanSkillDocs / collectCapabilities
 *   · server/developerApps.ts:829-879    prepareDeveloperApp / simulateDeveloperAppInstall
 *   · server/developerNetwork.ts:26-42   domainAllowed / validateDeveloperNetworkUrl / assertPublicDns
 *     **出网口径不另造一套**：直接复用 electron/platform-domain.cjs 里已移植的同名判定
 *     （platform-domain.cjs:224-262 与源逐条一致）。本批只做"判定 + 拒绝"，未配置白名单时拒绝。
 *
 * 本批刻意排除（与任务书 OUT 一致，出现即拒绝而不是静默忽略）：
 *   · oauth（开发者 OAuth / PKCE 回调）—— DEVELOPER_ERR_MANIFEST_FIELD_REJECTED
 *   · 远端更新相关字段（appUpdates / update / updater / cloud / realtime）
 * 这些字段本来会扩大运行时权限或引入远端对端，fail closed 比"收下不实现"安全。
 *
 * B7x：canvas（画布插件清单）不再整字段拒绝。结构 / 节点命名空间 / 端口类型 / 执行器 /
 *   Agent 动作 / 危险路径全部走 electron/developer-canvas-manifest.cjs 的逐字移植校验，
 *   通过才接受；不通过按具体原因结构化拒绝（见 normalizeCanvasDeclaration）。
 *
 * 未落地项（逐条登记，均为产品决定 / OUT，不是待办）：
 *   · developerOAuth.ts  开发者 OAuth / PKCE 回调：产品决定不开放，oauth 字段出现即
 *     DEVELOPER_ERR_MANIFEST_FIELD_REJECTED（fail closed），不改成"收下不实现"。
 * 已落地（B7x）：src/apps/canvas/builtinCanvasNodes.ts 内置节点端口定义 →
 *   electron/developer-canvas-builtins.cjs；模板清单的 builtin.* 引用与插件节点同一口径
 *   做存在性 / 端口兼容校验，不再跳过（见 developer-canvas-manifest.cjs 顶部说明）。
 * 已落地（B7e3，本文件仍零引用）：
 *   · agnes.ts / agnesEndpoint.ts → electron/plugin-agnes.cjs，注册为可选插件 agnes（integration/agnes/*）
 *     与 legacy 端口 generateAgnesImages / editAgnesImages / generateAgnesVideos；
 *     provider-protocol-domain.cjs / protocol-engine/legacy-executor-media.cjs 的 agnes 登记随之可用。
 */
"use strict";

const path = require("node:path");
const zipLib = require("./canvas-dxos-zip.cjs");
// B7x：画布插件清单校验（源 shared/canvasPluginValidation.ts + canvasPortCompatibility.ts 逐字移植）。
const canvasManifest = require("./developer-canvas-manifest.cjs");
const platformDomain = require("./platform-domain.cjs");
const foundationErrors = require("./dxos-foundation-errors.cjs");
// B7f：B7b 四张命令切片的实现 registry（白名单与实现同源，见下方合流块）。
const developerLabDomain = require("./developer-lab.cjs");
const developerCollabDomain = require("./developer-collab.cjs");
const developerMigrationDomain = require("./developer-migrations.cjs");
const developerRealtimeDomain = require("./developer-realtime.cjs");

// ---------------------------------------------------------------------------
// 版本语义（源 shared/appLifecycle.ts 逐字移植）
// ---------------------------------------------------------------------------

/** 源 shared/appLifecycle.ts:1 DX_OS_VERSION；装配时可注入真实应用版本（options.systemVersion）。 */
const DEVELOPER_SYSTEM_VERSION = "0.5.5";
const DEFAULT_DEVELOPER_APP_VERSION = "0.1.0";
const DEFAULT_DEVELOPER_APP_BUILD = 1;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function isValidSemver(value) {
  return typeof value === "string" && SEMVER_RE.test(value.trim());
}

function semverParts(value) {
  const match = String(value).trim().match(SEMVER_RE);
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] ? match[4].split(".") : [] };
}

function compareSemver(left, right) {
  const a = semverParts(left);
  const b = semverParts(right);
  if (!a || !b) throw createDeveloperError(DEVELOPER_ERR_INVALID_INPUT, "无法比较无效版本：" + String(left) + " / " + String(right));
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    if (an && bn) return Number(av) > Number(bv) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return av > bv ? 1 : -1;
  }
  return 0;
}

function compareAppVersion(left, right) {
  const version = compareSemver(left && left.version, right && right.version);
  if (version) return version;
  const leftBuild = Math.max(0, Math.round(Number(left && left.build) || 0));
  const rightBuild = Math.max(0, Math.round(Number(right && right.build) || 0));
  return leftBuild === rightBuild ? 0 : leftBuild > rightBuild ? 1 : -1;
}

function appReleaseKey(value) {
  return String(value && value.version) + "+" + Math.max(0, Math.round(Number(value && value.build) || 0));
}

/** 源 shared/appLifecycle.ts:81-85；systemVersion 默认源版本，装配时可注入 app.getVersion()。 */
function systemSupportsApp(minSystemVersion, maxSystemVersion, systemVersion = DEVELOPER_SYSTEM_VERSION) {
  if (minSystemVersion && compareSemver(systemVersion, minSystemVersion) < 0) return false;
  if (maxSystemVersion && compareSemver(systemVersion, maxSystemVersion) > 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 错误规约（与 platform / media / agent 同一形状，不产生第二套协议）
// ---------------------------------------------------------------------------

const DEVELOPER_ERR_COMMAND_NOT_ALLOWED = "DEVELOPER_COMMAND_NOT_ALLOWED";
const DEVELOPER_ERR_INVALID_INPUT = "DEVELOPER_INVALID_INPUT";
const DEVELOPER_ERR_UNAUTHENTICATED = "DEVELOPER_UNAUTHENTICATED";
const DEVELOPER_ERR_FORBIDDEN = "DEVELOPER_FORBIDDEN";
const DEVELOPER_ERR_NOT_FOUND = "DEVELOPER_NOT_FOUND";
const DEVELOPER_ERR_CONFLICT = "DEVELOPER_CONFLICT";
const DEVELOPER_ERR_DEPENDENCY_UNAVAILABLE = "DEVELOPER_DEPENDENCY_UNAVAILABLE";
const DEVELOPER_ERR_MANIFEST_INVALID = "DEVELOPER_MANIFEST_INVALID";
const DEVELOPER_ERR_MANIFEST_FIELD_REJECTED = "DEVELOPER_MANIFEST_FIELD_REJECTED";
const DEVELOPER_ERR_PERMISSION_REJECTED = "DEVELOPER_PERMISSION_REJECTED";
const DEVELOPER_ERR_PATH_ESCAPE = "DEVELOPER_PATH_ESCAPE";
const DEVELOPER_ERR_PACKAGE_INVALID = "DEVELOPER_PACKAGE_INVALID";
const DEVELOPER_ERR_NETWORK_NOT_DECLARED = "DEVELOPER_NETWORK_NOT_DECLARED";
const DEVELOPER_ERR_NETWORK_BLOCKED = "DEVELOPER_NETWORK_BLOCKED";
const DEVELOPER_ERR_RATE_LIMITED = "DEVELOPER_RATE_LIMITED";
const DEVELOPER_ERR_INTEGRITY_FAILED = "DEVELOPER_INTEGRITY_FAILED";
const DEVELOPER_ERR_INTERNAL = "DEVELOPER_INTERNAL";

const DEVELOPER_ERROR_CODES = Object.freeze([
  DEVELOPER_ERR_COMMAND_NOT_ALLOWED,
  DEVELOPER_ERR_INVALID_INPUT,
  DEVELOPER_ERR_UNAUTHENTICATED,
  DEVELOPER_ERR_FORBIDDEN,
  DEVELOPER_ERR_NOT_FOUND,
  DEVELOPER_ERR_CONFLICT,
  DEVELOPER_ERR_DEPENDENCY_UNAVAILABLE,
  DEVELOPER_ERR_MANIFEST_INVALID,
  DEVELOPER_ERR_MANIFEST_FIELD_REJECTED,
  DEVELOPER_ERR_PERMISSION_REJECTED,
  DEVELOPER_ERR_PATH_ESCAPE,
  DEVELOPER_ERR_PACKAGE_INVALID,
  DEVELOPER_ERR_NETWORK_NOT_DECLARED,
  DEVELOPER_ERR_NETWORK_BLOCKED,
  DEVELOPER_ERR_RATE_LIMITED,
  DEVELOPER_ERR_INTEGRITY_FAILED,
  DEVELOPER_ERR_INTERNAL,
]);

function createDeveloperError(code, message, detail) {
  const err = new Error(foundationErrors.redactText(message == null ? code : message));
  err.name = "DeveloperError";
  err.code = DEVELOPER_ERROR_CODES.includes(code) ? code : DEVELOPER_ERR_INTERNAL;
  err.detail = detail === undefined ? undefined : foundationErrors.redactValue(detail);
  return err;
}

function isDeveloperError(err) {
  return !!err && typeof err === "object" && typeof err.code === "string" && DEVELOPER_ERROR_CODES.includes(err.code);
}

function redactDeveloperValue(value) {
  return foundationErrors.redactValue(value);
}

function sanitizeDeveloperText(value, max = 4000) {
  const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return foundationErrors.redactText(text).slice(0, Math.max(0, max));
}

function normalizeDeveloperError(err) {
  if (isDeveloperError(err)) {
    const out = { ok: false, error: err.code, message: foundationErrors.redactText(err.message || err.code) || err.code };
    if (err.detail !== undefined) out.detail = foundationErrors.redactValue(err.detail);
    return out;
  }
  return foundationErrors.normalizeError(err, { fallbackCode: foundationErrors.DXOS_ERR_INTERNAL });
}

function developerCommandNotAllowed(command) {
  return createDeveloperError(DEVELOPER_ERR_COMMAND_NOT_ALLOWED, "未知或未授权的 developer 命令：" + String(command == null ? "" : command), { command: command == null ? null : String(command) });
}

async function toDeveloperIpcResult(action) {
  try {
    const value = typeof action === "function" ? await action() : await action;
    return { ok: true, value: redactDeveloperValue(value) };
  } catch (err) {
    return normalizeDeveloperError(err);
  }
}

// ---------------------------------------------------------------------------
// 命令白名单（risk / credential / 中文 summary）
// ---------------------------------------------------------------------------

/**
 * developer:command 白名单。
 *   risk       read | use | manage | destructive（与 platform-domain.cjs:89 同级定义）
 *   credential 该命令是否进入凭据绑定路径（只写 provider 引用，绝不携带 / 返回密钥明文）。
 *   summary    中文一句话，供 UI 与审计展示。
 */
const DEVELOPER_BASE_COMMANDS = Object.freeze({
  "developer/install": { risk: "manage", credential: false, summary: "本地装载：校验 dx-app/v2 清单并原子安装，保留上一版本作为回滚点" },
  "developer/uninstall": { risk: "destructive", credential: false, summary: "卸载本地 App：清理安装目录、清单缓存与凭据绑定；运行时事件与网络审计保留" },
  "developer/enable": { risk: "manage", credential: false, summary: "启用 App：把当前版本写回 user_installed_apps" },
  "developer/disable": { risk: "manage", credential: false, summary: "禁用 App：仅移除用户安装状态，安装文件与回滚点保留" },
  "developer/rollback": { risk: "manage", credential: false, summary: "回滚到上一版本：切换当前版本并保留被替换版本" },
  "developer/list": { risk: "read", credential: false, summary: "列出本机已装载 App（安全投影，不含绝对路径）" },
  "developer/get": { risk: "read", credential: false, summary: "读取单个 App 的清单、启用状态与当前版本" },
  "developer/history": { risk: "read", credential: false, summary: "列出可回滚的历史版本（按发布时间倒序）" },
  "developer/validate": { risk: "read", credential: false, summary: "离线校验开发者包清单与文件围栏（不落盘、不安装）" },
  "developer/credential/bind": { risk: "manage", credential: true, summary: "绑定 App 出网凭据引用（只存 provider 元数据，不存密钥）" },
  "developer/credential/list": { risk: "read", credential: true, summary: "列出 App 已绑定的凭据元数据（不含密钥明文）" },
  "developer/credential/unbind": { risk: "manage", credential: true, summary: "解绑 App 的出网凭据引用" },
  "developer/network/evaluate": { risk: "read", credential: false, summary: "出网判定：HTTPS + App 声明白名单 + DNS 公网地址校验（不发起请求）" },
  "developer/network/request": { risk: "use", credential: true, summary: "按 App 声明的白名单发起出网请求（每分钟 60 次限流 + app_network_audit 审计）" },
  "developer/runtime/report": { risk: "manage", credential: false, summary: "上报一条 App 运行时事件（写入 app_runtime_events）" },
  "developer/health": { risk: "read", credential: false, summary: "开发者平台健康：六张 v22 表 / 安装根目录 / 装配状态" },
});

// ---------------------------------------------------------------------------
// B7f · 白名单合流：B7a 的 16 条 + B7b（lab / collab / migrations / realtime）的 54 条
// ---------------------------------------------------------------------------
//
// 为什么在 domain 层合并：这张表就是唯一白名单（developer-bootstrap.cjs 的 isDeveloperCommand、
// developer-service.cjs 的 health.commands、listDeveloperCommands 都读它）。B7b 四张切片的
// 命令 registry 是各切片的实现清单，直接从这里取，白名单与实现同源，杜绝"登记未实现 / 实现未登记"。
//
// 唯一一次口径归一化：B7a 用 read|use|manage|destructive + credential:boolean，
// B7b 切片用 read|write|delete + credential:"none"；write→manage、delete→destructive。
const EXTENSION_RISK_ALIAS = Object.freeze({
  read: "read", use: "use", manage: "manage", destructive: "destructive", write: "manage", delete: "destructive",
});

function normalizeExtensionCommands(lists) {
  const merged = {};
  for (const list of lists) {
    for (const entry of list || []) {
      if (!entry || typeof entry.command !== "string") continue;
      merged[entry.command] = {
        risk: EXTENSION_RISK_ALIAS[String(entry.risk)] || "read",
        credential: entry.credential === true,
        summary: String(entry.summary || ""),
      };
    }
  }
  return merged;
}

/** B7b 四张切片的 54 条命令（实现方 registry 即真值）。 */
const DEVELOPER_EXTENSION_COMMANDS = Object.freeze(normalizeExtensionCommands([
  developerLabDomain.DEVELOPER_LAB_COMMANDS,
  developerCollabDomain.DEVELOPER_COLLAB_COMMANDS,
  developerMigrationDomain.DEVELOPER_MIGRATION_COMMANDS,
  developerRealtimeDomain.DEVELOPER_REALTIME_COMMANDS,
]));

/** 唯一 developer:command 白名单 = B7a 基础 16 条 + B7b 扩展 54 条（共 70 条）。 */
const DEVELOPER_COMMANDS = Object.freeze({ ...DEVELOPER_BASE_COMMANDS, ...DEVELOPER_EXTENSION_COMMANDS });

const RISK_LEVELS = Object.freeze({ read: 0, use: 1, manage: 2, destructive: 3 });

function isDeveloperCommand(command) {
  return typeof command === "string" && Object.prototype.hasOwnProperty.call(DEVELOPER_COMMANDS, command);
}

function developerCommandEntry(command) {
  return isDeveloperCommand(command) ? DEVELOPER_COMMANDS[command] : null;
}

function developerCommandRisk(command) {
  const entry = developerCommandEntry(command);
  return entry ? entry.risk : null;
}

function developerCommandRequiresCredential(command) {
  const entry = developerCommandEntry(command);
  return !!(entry && entry.credential);
}

/** IPC 投影把 credential 改名 needsCredential：foundation 的密钥字段掩码会按 "credential" 子串命中。 */
function listDeveloperCommands() {
  return Object.keys(DEVELOPER_COMMANDS).map((command) => ({
    command,
    risk: DEVELOPER_COMMANDS[command].risk,
    needsCredential: DEVELOPER_COMMANDS[command].credential,
    summary: DEVELOPER_COMMANDS[command].summary,
  }));
}

// ---------------------------------------------------------------------------
// 路径 / 名称规约（源 developerApps.ts:221-234）
// ---------------------------------------------------------------------------

function safePath(input) {
  const value = String(input == null ? "" : input).replace(/\\/g, "/").replace(/^\.\//, "");
  if (!value || value.startsWith("/") || /^[a-z]:/i.test(value) || value.split("/").includes("..")) {
    throw createDeveloperError(DEVELOPER_ERR_PATH_ESCAPE, "存在不安全路径：" + String(input == null ? "" : input));
  }
  return value;
}

function slug(value) {
  const raw = String(value == null ? "" : value).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 42);
  return /^[a-z]/.test(raw) ? raw : "app-" + (raw || "unknown");
}

function decodeUploadName(value) {
  const text = String(value == null ? "" : value);
  if (/[^\x00-\xff]/.test(text)) return text;
  const decoded = Buffer.from(text, "latin1").toString("utf8");
  return decoded.includes("\uFFFD") ? text : decoded;
}

// ---------------------------------------------------------------------------
// 包条目围栏（源 developerApps.ts:27-45 / 235-280）
// ---------------------------------------------------------------------------

const MAX_PACKAGE_MB = 200;
const MAX_PACKAGE_BYTES = MAX_PACKAGE_MB * 1024 * 1024;
const MAX_UNPACKED_BYTES = 500 * 1024 * 1024;
const MAX_FILE_BYTES = 500 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_APP_MANIFEST_BYTES = 1024 * 1024;
const MAX_ENTRY_COUNT = 2048;

/** 源 developerApps.ts:42 逐项一致。 */
const ALLOWED_EXTENSIONS = new Set([".html", ".css", ".js", ".mjs", ".ts", ".tsx", ".json", ".txt", ".md", ".yaml", ".yml", ".toml", ".py", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".mp3", ".wav", ".ogg", ".webm", ".wasm", ".mix", ".map", ".csf", ".fbx"]);
/** 源 developerApps.ts:45：可执行 / 原生依赖只允许出现在 mcp/ 下，普通资源夹带一律拒绝。 */
const ALLOWED_MCP_RUNTIME_EXTENSIONS = new Set([".pyd", ".dll", ".node", ".so", ".dylib", ".exe", ".pem", ".cfg", ".cat", "._pth", ".zip"]);

/** 解出 ZIP 条目；字节层由 canvas-dxos-zip.cjs 统一解析（CRC / 长度 / 压缩方式）。 */
function readPackageEntries(buffer) {
  if (!Buffer.isBuffer(buffer)) throw createDeveloperError(DEVELOPER_ERR_INVALID_INPUT, "开发者包必须是二进制内容");
  if (!buffer.length) throw createDeveloperError(DEVELOPER_ERR_PACKAGE_INVALID, "压缩包为空");
  if (buffer.length > MAX_PACKAGE_BYTES) throw createDeveloperError(DEVELOPER_ERR_PACKAGE_INVALID, "压缩包不能超过 " + MAX_PACKAGE_MB + " MB");
  let entries;
  try {
    entries = zipLib.readZip(buffer, { maxEntries: MAX_ENTRY_COUNT, maxEntryBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_UNPACKED_BYTES });
  } catch (error) {
    throw createDeveloperError(DEVELOPER_ERR_PACKAGE_INVALID, "不是有效的开发者包：" + String((error && error.message) || error));
  }
  if (!entries.length) throw createDeveloperError(DEVELOPER_ERR_PACKAGE_INVALID, "压缩包为空");
  return entries;
}

/** 源 developerApps.ts:235-280 的目录级规则：安全路径 + 扩展名白名单 + 单文件 / 总量上限。 */
function guardPackageEntries(entries) {
  let total = 0;
  const files = [];
  for (const entry of entries) {
    const name = safePath(entry.name);
    if (!name || name.endsWith("/")) continue;
    const ext = path.posix.extname(name).toLowerCase();
    const bundledMcpRuntime = name.startsWith("mcp/") && ALLOWED_MCP_RUNTIME_EXTENSIONS.has(ext);
    if (!ALLOWED_EXTENSIONS.has(ext) && !bundledMcpRuntime) throw createDeveloperError(DEVELOPER_ERR_PACKAGE_INVALID, "不允许的文件类型：" + name);
    if (entry.data.length > MAX_FILE_BYTES) throw createDeveloperError(DEVELOPER_ERR_PACKAGE_INVALID, "文件过大：" + name);
    total += entry.data.length;
    if (total > MAX_UNPACKED_BYTES) throw createDeveloperError(DEVELOPER_ERR_PACKAGE_INVALID, "解压总内容超过 500 MB 限制");
    files.push({ name, data: entry.data });
  }
  return files;
}

/** 源 developerApps.ts:281-284 commonTopLevel：整包共用一层目录时剥掉它。 */
function commonTopLevel(files) {
  const first = files[0] && files[0].name.split("/")[0];
  if (!first) return "";
  return files.every((file) => file.name.startsWith(first + "/")) ? first + "/" : "";
}

function readJsonFile(files, filePath, label) {
  const file = files.find((item) => item.name === filePath);
  if (!file) return null;
  if (file.data.length > MAX_TEXT_BYTES) throw createDeveloperError(DEVELOPER_ERR_PACKAGE_INVALID, label + " 过大");
  try { return JSON.parse(file.data.toString("utf8")); }
  catch { throw createDeveloperError(DEVELOPER_ERR_PACKAGE_INVALID, label + " 不是有效 JSON"); }
}

// ---------------------------------------------------------------------------
// B7x · canvas 画布插件清单（源 developerApps.ts:379-410 + canvasPluginValidation 逐字移植）
// ---------------------------------------------------------------------------

/**
 * 源 developerApps.ts:379-410 normalizeCanvasDeclaration。
 * 本函数只做文件围栏（路径 / 扩展名 / 大小 / JSON）并把校验委托给
 * electron/developer-canvas-manifest.cjs；结构、节点命名空间、端口类型、执行器、
 * Agent 动作、危险路径的判定全在那一个模块，杜绝两套口径。
 *
 * 错误映射（稳定）：
 *   · 声明结构 / 清单内容不合法 → DEVELOPER_ERR_MANIFEST_INVALID，detail.reason = 清单子码；
 *   · 声明文件不存在 / 解析失败 / 过大 → DEVELOPER_ERR_PACKAGE_INVALID，detail.reason 同上。
 * 通过才接受；不通过不落盘、不产生任何能力。
 */
function normalizeCanvasDeclaration(value, files, pluginId) {
  if (value === undefined || value === null) return undefined;
  let shape;
  try {
    // safePath 在此注入：路径越界保持 DEVELOPER_ERR_PATH_ESCAPE（与入口 / 依赖路径同一口径）。
    shape = canvasManifest.normalizeCanvasDeclarationShape(value, safePath);
  } catch (error) {
    if (isDeveloperError(error)) throw error;
    throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "dx-app.json.canvas " + String((error && error.message) || error), { field: "canvas", reason: (error && error.canvasCode) || "CANVAS_DECLARATION_INVALID" });
  }
  const resolveManifest = (paths, label) => paths.map((rawPath) => {
    const filePath = safePath(rawPath);
    const file = files.find((candidate) => candidate.name === filePath);
    if (!file) throw createDeveloperError(DEVELOPER_ERR_PACKAGE_INVALID, "canvas." + label + " 文件不存在：" + filePath, { field: "canvas", reason: "CANVAS_MANIFEST_FILE_MISSING" });
    if (path.posix.extname(filePath).toLowerCase() !== ".json") throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "canvas." + label + " 只允许 JSON 文件：" + filePath, { field: "canvas", reason: "CANVAS_MANIFEST_NOT_JSON_FILE" });
    if (file.data.length > MAX_TEXT_BYTES) throw createDeveloperError(DEVELOPER_ERR_PACKAGE_INVALID, "canvas." + label + " 文件过大：" + filePath, { field: "canvas", reason: "CANVAS_MANIFEST_TOO_LARGE" });
    return filePath;
  });
  const nodeManifests = resolveManifest(shape.nodeManifests, "nodeManifests");
  const templateManifests = resolveManifest(shape.templateManifests, "templateManifests");
  const parseManifest = (filePath, label) => {
    const file = files.find((candidate) => candidate.name === filePath);
    try { return JSON.parse(file.data.toString("utf8")); }
    catch { throw createDeveloperError(DEVELOPER_ERR_PACKAGE_INVALID, "canvas." + label + " 不是有效 JSON：" + filePath, { field: "canvas", reason: "CANVAS_MANIFEST_NOT_JSON" }); }
  };
  const definitions = [];
  for (const filePath of nodeManifests) {
    try {
      definitions.push(...canvasManifest.validateCanvasNodeManifest(parseManifest(filePath, "nodeManifests"), pluginId).nodes);
    } catch (error) {
      if (isDeveloperError(error)) throw error;
      throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, filePath + " 校验失败：" + String((error && error.message) || error), { field: "canvas", reason: (error && error.canvasCode) || "CANVAS_NODE_MANIFEST_INVALID" });
    }
  }
  // 模板清单把插件节点定义交给 canvasManifest；builtin.* 的内置端口定义已落地到
  // electron/developer-canvas-builtins.cjs，canvasManifest 内部合成 allDefinitions，
  // builtin.* 与插件节点同一口径做存在性 / 端口兼容校验，不再跳过"无法验证"的连线。
  for (const filePath of templateManifests) {
    try {
      canvasManifest.validateCanvasTemplateManifest(parseManifest(filePath, "templateManifests"), pluginId, definitions);
    } catch (error) {
      if (isDeveloperError(error)) throw error;
      throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, filePath + " 校验失败：" + String((error && error.message) || error), { field: "canvas", reason: (error && error.canvasCode) || "CANVAS_TEMPLATE_MANIFEST_INVALID" });
    }
  }
  return { nodeManifests, templateManifests };
}

// ---------------------------------------------------------------------------
// 清单字段规约
// ---------------------------------------------------------------------------

function cleanStringList(value, max = 40) {
  return Array.isArray(value) ? value.map((item) => String(item == null ? "" : item).trim()).filter(Boolean).slice(0, max) : [];
}

function cleanObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function normalizeToolName(value) {
  const name = String(value == null ? "" : value).trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{2,63}$/.test(name)) throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "工具名不合法：" + (name || "(空)"));
  return name;
}

function normalizePermission(value) {
  const permission = String(value == null ? "" : value).trim();
  return /^[a-z][a-z0-9_.:-]{2,96}$/.test(permission) ? permission : "";
}

/** 源 developerApps.ts:367-374：旧 project.* 权限统一改写成 app.<id>.project.*。 */
function normalizeAppPermission(value, appId) {
  const permission = normalizePermission(value);
  if (!permission) return "";
  if (["project.info", "project.list", "project.read"].includes(permission)) return "app." + appId + ".project.read";
  if (["project.write", "project.mkdir"].includes(permission)) return "app." + appId + ".project.write";
  if (permission === "project.remove") return "app." + appId + ".project.delete";
  return permission;
}

/**
 * 危险权限 / 字段（任务书要求"危险字段拒绝"）。
 * 目标是 fail closed：命中即拒绝整个包，而不是"降权后照装"。
 */
const DANGEROUS_PERMISSION_PATTERNS = Object.freeze([
  /^\*$/,
  /^[a-z0-9]+\.\*$/,
  /(^|\.)(exec|shell|spawn|sudo|root|admin|superadmin)$/,
  /(^|\.)system(\.|$)/,
  /(^|\.)(credential|secret|password|token|api[-_]?key)(\.|$)/,
  /(^|\.)fs\.(raw|read-any|write-any)$/,
]);

/**
 * 本批明确不引入的清单字段（任务书 OUT）。出现即拒绝，不做"收下不实现"：
 *   · oauth / oauthRedirect：开发者 OAuth（PKCE 回调）
 *   · appUpdates / update / updater：appUpdates 远端更新
 *   · cloud / realtime：云端实时房间 / 云替身
 *   · appApi / automation：需要画布与工具执行端，本批不实现 —— 拒绝而不是静默丢弃声明
 * canvas 已按 B7x 走 developer-canvas-manifest.cjs 校验后才接受，不在本名单里。
 */
const REJECTED_MANIFEST_FIELDS = Object.freeze([
  "oauth", "oauthRedirect", "appUpdates", "update", "updater", "cloud", "realtime", "appApi", "automation",
]);

function assertPermissionAllowed(permission) {
  if (DANGEROUS_PERMISSION_PATTERNS.some((pattern) => pattern.test(permission))) {
    throw createDeveloperError(DEVELOPER_ERR_PERMISSION_REJECTED, "拒绝危险权限声明：" + permission, { permission });
  }
  return permission;
}

function assertNoPrototypeKeys(value, label) {
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw createDeveloperError(DEVELOPER_ERR_MANIFEST_FIELD_REJECTED, label + " 含原型污染字段：" + key);
    }
  }
}

function assertNoRejectedFields(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  for (const field of REJECTED_MANIFEST_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, field)) {
      throw createDeveloperError(DEVELOPER_ERR_MANIFEST_FIELD_REJECTED, "本版本不接受清单字段：" + field, { field });
    }
  }
  for (const nested of ["market", "publish", "publishing", "gray", "rollout"]) {
    if (Object.prototype.hasOwnProperty.call(raw, nested)) {
      throw createDeveloperError(DEVELOPER_ERR_MANIFEST_FIELD_REJECTED, "本版本不接受远端发布字段：" + nested, { field: nested });
    }
  }
}

// ---------------------------------------------------------------------------
// 清单校验（源 developerApps.ts:411-475，含版本 / 权限 / 工具 / 入口）
// ---------------------------------------------------------------------------

function normalizeNetworkDeclaration(value) {
  if (value === undefined || value === null) return undefined;
  const obj = cleanObject(value);
  const domains = [...new Set(cleanStringList(obj.domains, 32).map((item) => item.toLowerCase()).filter((item) => /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])$/.test(item) && !item.includes("..")))];
  if (!domains.length) throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "dx-app.json.network.domains 至少声明一个有效域名");
  const allowedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
  const methods = [...new Set(cleanStringList(obj.methods, 8).map((item) => item.toUpperCase()).filter((item) => allowedMethods.has(item)))];
  return {
    domains,
    methods: methods.length ? methods : ["GET"],
    maxResponseBytes: Math.max(1024, Math.min(5 * 1024 * 1024, Math.round(Number(obj.maxResponseBytes) || 1024 * 1024))),
  };
}

function normalizeMigrationList(value, files, targetDataVersion) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "dx-app.json.migrations 必须是最多 32 项的数组");
  const migrations = value.map((item) => {
    const obj = cleanObject(item);
    const from = Number(obj.from);
    const to = Number(obj.to);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to !== from + 1 || to > targetDataVersion) throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "迁移版本必须是连续正整数 from → from+1，且不超过 dataVersion");
    if (obj.type !== "declarative") throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "当前只允许 declarative 数据迁移");
    const file = safePath(obj.file);
    if (!file.startsWith("migrations/") || !file.endsWith(".json")) throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "迁移文件必须位于 migrations/*.json");
    if (!files.some((entry) => entry.name === file)) throw createDeveloperError(DEVELOPER_ERR_PACKAGE_INVALID, "迁移文件不存在：" + file);
    readJsonFile(files, file, file);
    return { from, to, type: "declarative", file };
  });
  const keys = new Set();
  for (const migration of migrations) {
    const key = migration.from + "-" + migration.to;
    if (keys.has(key)) throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "迁移版本重复：" + key);
    keys.add(key);
  }
  return migrations;
}

function normalizeMcpList(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).map((item, index) => {
    const obj = cleanObject(item);
    const id = slug(String(obj.id || "mcp-" + (index + 1)));
    const name = String(obj.name || id).trim().slice(0, 60);
    const transport = obj.transport === "http" ? "http" : "stdio";
    return {
      id,
      name,
      transport,
      command: obj.command ? String(obj.command).slice(0, 180) : undefined,
      args: cleanStringList(obj.args, 24).map((arg) => arg.slice(0, 240)),
      url: obj.url ? String(obj.url).slice(0, 500) : undefined,
      autoStart: typeof obj.autoStart === "boolean" ? obj.autoStart : undefined,
    };
  });
}

function normalizeDependencyId(value, fallback) {
  const id = String(value == null ? fallback : value).trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,120}$/.test(id) ? id : slug(id || fallback);
}

function normalizeDependencyList(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 48).map((item, index) => {
    const obj = cleanObject(item);
    const type = obj.type === "mcp" ? "mcp" : "skill";
    const id = type === "mcp"
      ? normalizeDependencyId(obj.id || obj.serverId, "mcp-" + (index + 1))
      : normalizeDependencyId(obj.id || obj.skillId, "skill-" + (index + 1));
    const name = String(obj.name || id).trim().slice(0, 80);
    const source = obj.source === "bundled" || obj.source === "external" || obj.source === "system" ? obj.source : "system";
    return {
      type,
      id,
      name,
      version: obj.version ? String(obj.version).slice(0, 60) : undefined,
      required: obj.required !== false,
      source,
      path: obj.path ? safePath(obj.path) : undefined,
      installHint: obj.installHint ? String(obj.installHint).slice(0, 240) : undefined,
      toolName: obj.toolName ? String(obj.toolName).slice(0, 100) : undefined,
    };
  });
}

const TOOL_RISKS = Object.freeze(["read", "write", "delete", "external", "system"]);
const TOOL_HANDLER_TYPES = Object.freeze(["app-api", "frontend-bridge", "mcp-tool", "skill"]);

/** 源 developerApps.ts:724-756：工具声明校验（name / risk / handler / permission）。 */
function normalizeToolManifest(raw) {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (!Array.isArray(obj.tools)) return [];
  return obj.tools.slice(0, 48).map((item) => {
    const tool = cleanObject(item);
    const handler = cleanObject(tool.handler);
    if (tool.risk !== undefined && !TOOL_RISKS.includes(String(tool.risk))) throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "工具 risk 非法：" + String(tool.risk));
    if (handler.type !== undefined && !TOOL_HANDLER_TYPES.includes(String(handler.type))) throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "工具 handler.type 非法：" + String(handler.type));
    const risk = TOOL_RISKS.includes(String(tool.risk)) ? String(tool.risk) : "read";
    const handlerType = TOOL_HANDLER_TYPES.includes(String(handler.type)) ? String(handler.type) : "frontend-bridge";
    const permission = normalizePermission(tool.permission);
    if (permission) assertPermissionAllowed(permission);
    const confirmation = cleanObject(tool.confirmation);
    const confirmationMessage = String(confirmation.message || "").trim();
    return {
      name: normalizeToolName(tool.name),
      title: String(tool.title || tool.name || "").trim().slice(0, 40),
      description: String(tool.description || "").trim().slice(0, 240),
      whenToUse: cleanStringList(tool.whenToUse, 12).map((hint) => hint.slice(0, 120)),
      inputSchema: cleanObject(tool.inputSchema, { type: "object", properties: {} }),
      outputSchema: tool.outputSchema && typeof tool.outputSchema === "object" && !Array.isArray(tool.outputSchema) ? tool.outputSchema : undefined,
      permission: permission || undefined,
      risk,
      sideEffects: cleanStringList(tool.sideEffects, 12).map((entry) => entry.slice(0, 80)),
      handlerType,
      handler: {
        type: handlerType,
        endpoint: handler.endpoint ? String(handler.endpoint).slice(0, 300) : undefined,
        serverId: handler.serverId ? String(handler.serverId).slice(0, 100) : undefined,
        toolName: handler.toolName ? String(handler.toolName).slice(0, 100) : undefined,
        skillId: handler.skillId ? String(handler.skillId).slice(0, 100) : undefined,
      },
      confirmation: confirmation.required === true ? { required: true, message: confirmationMessage ? confirmationMessage.slice(0, 180) : undefined } : undefined,
    };
  });
}

function normalizeManifest(raw, files, options = {}) {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  assertNoPrototypeKeys(obj, "dx-app.json");
  assertNoRejectedFields(obj);
  if (obj.format !== "dx-app/v1" && obj.format !== "dx-app/v2") throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "dx-app.json 的 format 必须是 dx-app/v1 或 dx-app/v2");

  const entry = safePath(obj.entry || "index.html");
  if (!files.some((file) => file.name === entry)) throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "入口文件不存在：" + entry);

  const id = slug(String(obj.id || obj.name || "developer-app"));
  const name = String(obj.name || "").trim();
  if (name.length < 2) throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "应用名称至少 2 个字符");
  const description = String(obj.description || "").trim();
  if (description.length < 8) throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "description 至少 8 个字符");

  const version = obj.version === undefined ? DEFAULT_DEVELOPER_APP_VERSION : String(obj.version).trim();
  if (!isValidSemver(version)) throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "dx-app.json.version 必须是有效 SemVer，例如 1.2.3");
  const build = obj.build === undefined ? DEFAULT_DEVELOPER_APP_BUILD : Number(obj.build);
  if (!Number.isSafeInteger(build) || build < 1) throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "dx-app.json.build 必须是大于 0 的整数");

  const minSystemVersion = obj.minSystemVersion === undefined ? "0.1.0" : String(obj.minSystemVersion).trim();
  if (!isValidSemver(minSystemVersion)) throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "dx-app.json.minSystemVersion 必须是有效 SemVer");
  const maxSystemVersion = obj.maxSystemVersion === undefined || obj.maxSystemVersion === null || obj.maxSystemVersion === "" ? undefined : String(obj.maxSystemVersion).trim();
  if (maxSystemVersion && !isValidSemver(maxSystemVersion)) throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "dx-app.json.maxSystemVersion 必须是有效 SemVer");
  if (maxSystemVersion && compareAppVersion({ version: minSystemVersion, build: 0 }, { version: maxSystemVersion, build: 0 }) > 0) throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "minSystemVersion 不能高于 maxSystemVersion");
  const systemVersion = String(options.systemVersion || DEVELOPER_SYSTEM_VERSION);
  if (!systemSupportsApp(minSystemVersion, maxSystemVersion, systemVersion)) {
    throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "当前系统不兼容此 APP（要求 " + minSystemVersion + (maxSystemVersion ? "–" + maxSystemVersion : " 或更高版本") + "）");
  }

  const dataVersion = obj.dataVersion === undefined ? 1 : Number(obj.dataVersion);
  if (!Number.isSafeInteger(dataVersion) || dataVersion < 1) throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "dx-app.json.dataVersion 必须是大于 0 的整数");
  if (obj.releaseChannel !== undefined && !["stable", "beta", "dev"].includes(String(obj.releaseChannel))) throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "dx-app.json.releaseChannel 必须是 stable、beta 或 dev");
  if (obj.backgroundMode !== undefined && !["release", "keep-alive"].includes(String(obj.backgroundMode))) throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "dx-app.json.backgroundMode 必须是 release 或 keep-alive");
  if (obj.multiInstance !== undefined && typeof obj.multiInstance !== "boolean") throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "dx-app.json.multiInstance 必须是布尔值");

  const migrations = normalizeMigrationList(obj.migrations, files, dataVersion);
  const network = normalizeNetworkDeclaration(obj.network);
  const permissions = [...new Set(cleanStringList(obj.permissions, 64).map((permission) => normalizeAppPermission(permission, id)).filter(Boolean))];
  for (const permission of permissions) assertPermissionAllowed(permission);
  // B7x：canvas 先过画布插件清单校验，通过才进入归一化清单。
  const canvas = normalizeCanvasDeclaration(obj.canvas, files, id);

  const width = Math.max(420, Math.min(1400, Math.round(Number(obj.defaultSize && obj.defaultSize.width || 860))));
  const height = Math.max(300, Math.min(1000, Math.round(Number(obj.defaultSize && obj.defaultSize.height || 620))));

  return {
    format: obj.format,
    id,
    version,
    build,
    releaseChannel: obj.releaseChannel === "stable" || obj.releaseChannel === "beta" ? obj.releaseChannel : "dev",
    minSystemVersion,
    maxSystemVersion,
    dataVersion,
    migrations,
    releaseNotes: obj.releaseNotes ? String(obj.releaseNotes).trim().slice(0, 4000) : undefined,
    name: name.slice(0, 36),
    subtitle: String(obj.subtitle || "开发者应用").slice(0, 28),
    description: description.slice(0, 180),
    category: ["game", "games"].includes(String(obj.category || "")) ? "games" : "software",
    entry,
    defaultSize: { width, height },
    multiInstance: obj.multiInstance === true,
    backgroundMode: obj.backgroundMode === "keep-alive" ? "keep-alive" : "release",
    agent: obj.agent && typeof obj.agent === "object" && !Array.isArray(obj.agent) ? {
      summary: String(obj.agent.summary || "").slice(0, 400),
      toolManifest: obj.agent.toolManifest ? safePath(obj.agent.toolManifest) : undefined,
      skillDocs: cleanStringList(obj.agent.skillDocs, 16).map(safePath),
    } : undefined,
    mcp: normalizeMcpList(obj.mcp),
    dependencies: normalizeDependencyList(obj.dependencies),
    permissions,
    network,
    canvas,
  };
}

/** 源 developerApps.ts:681-700：清单声明的随包文件必须真的存在。 */
function validateDeclaredPackageFiles(files, manifest) {
  const names = new Set(files.map((file) => file.name));
  const toolManifest = manifest.agent && manifest.agent.toolManifest;
  if (toolManifest && !names.has(toolManifest)) throw createDeveloperError(DEVELOPER_ERR_PACKAGE_INVALID, "agent.toolManifest 文件不存在：" + toolManifest);
  for (const skillPath of manifest.agent && manifest.agent.skillDocs || []) {
    if (!/^skills\/.+\.md$/i.test(skillPath)) throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "agent.skillDocs 必须位于 skills/ 且为 Markdown：" + skillPath);
    if (!names.has(skillPath)) throw createDeveloperError(DEVELOPER_ERR_PACKAGE_INVALID, "agent.skillDocs 文件不存在：" + skillPath);
  }
  for (const dependency of manifest.dependencies || []) {
    if (dependency.source !== "bundled") continue;
    if (!dependency.path) throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "bundled " + dependency.type + " 依赖必须声明 path：" + dependency.id);
    if (dependency.type === "mcp" && dependency.path !== "mcp/mcp.json") throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "bundled MCP 固定使用 mcp/mcp.json：" + dependency.id);
    if (dependency.type === "skill" && !/^skills\/.+\.md$/i.test(dependency.path)) throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "bundled Skill 必须指向 skills/ 下的 Markdown：" + dependency.id);
    if (!names.has(dependency.path)) throw createDeveloperError(DEVELOPER_ERR_PACKAGE_INVALID, "bundled " + dependency.type + " 依赖文件不存在：" + dependency.path);
  }
}

function normalizePermissions(files, manifest, tools) {
  const raw = readJsonFile(files, "permissions.json", "permissions.json");
  const fromFile = raw && typeof raw === "object" && !Array.isArray(raw)
    ? cleanStringList(raw.permissions, 64)
    : cleanStringList(raw, 64);
  const all = [...new Set([
    ...(manifest.permissions || []),
    ...fromFile.map((permission) => normalizeAppPermission(permission, manifest.id)).filter(Boolean),
    ...tools.map((tool) => normalizeAppPermission(tool.permission, manifest.id)).filter(Boolean),
  ])];
  for (const permission of all) assertPermissionAllowed(permission);
  return all.slice(0, 96);
}

function scanSkillDocs(files, manifest) {
  const declared = new Set((manifest.agent && manifest.agent.skillDocs || []).map((item) => item.toLowerCase()));
  return files
    .filter((file) => /^skills\/.+\.md$/i.test(file.name) || declared.has(file.name.toLowerCase()))
    .slice(0, 24)
    .map((file) => {
      const text = file.data.subarray(0, Math.min(file.data.length, MAX_TEXT_BYTES)).toString("utf8");
      const title = text.split(/\r?\n/).find((line) => /^#\s+/.test(line)) ? text.split(/\r?\n/).find((line) => /^#\s+/.test(line)).replace(/^#+\s*/, "").trim() : (file.name.split("/").pop() || "Skill");
      const preview = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#")) || "随应用安装的 Skill 文档。";
      return { path: file.name, title: title.slice(0, 60), preview: preview.slice(0, 180) };
    });
}

/**
 * B7x：canvas 声明的能力投影。清单期已逐条校验；这里只重放解析，抽出
 * 「节点类型 / 执行器 / Agent 动作」供 automation 的 app_action 适配器投影可执行动作。
 * 重放失败按"无声明"处理（不伪造动作），不改变清单期已经做出的接受 / 拒绝结论。
 */
function collectCanvasCapabilities(files, manifest) {
  const canvas = manifest && manifest.canvas;
  if (!canvas) return null;
  const nodes = [];
  const templates = [];
  for (const filePath of canvas.nodeManifests || []) {
    const raw = readJsonFile(files, filePath, filePath);
    if (!raw) continue;
    let validated;
    try { validated = canvasManifest.validateCanvasNodeManifest(raw, manifest.id); }
    catch { continue; }
    for (const node of validated.nodes) {
      nodes.push({
        type: node.type,
        title: node.title,
        executorType: node.executor && node.executor.type ? node.executor.type : null,
        executorToolName: node.executor && node.executor.toolName ? node.executor.toolName : null,
        actions: (node.agent && node.agent.actions || []).map((action) => ({ id: action.id, title: action.title, kind: action.kind })),
      });
    }
  }
  for (const filePath of canvas.templateManifests || []) {
    const raw = readJsonFile(files, filePath, filePath);
    if (!raw || !Array.isArray(raw.templates)) continue;
    for (const template of raw.templates) templates.push({ id: String(template.id || ""), title: String(template.title || "").slice(0, 120), nodeCount: Array.isArray(template.nodes) ? template.nodes.length : 0 });
  }
  return { nodeManifests: canvas.nodeManifests.slice(), templateManifests: canvas.templateManifests.slice(), nodes, templates };
}

/** 源 developerApps.ts:780-819：能力汇总（工具 / 权限 / 依赖 / MCP / Skill / 提示）。 */
function collectCapabilities(files, manifest) {
  const toolPath = manifest.agent && manifest.agent.toolManifest ? safePath(manifest.agent.toolManifest) : "agent.tools.json";
  const rawTools = readJsonFile(files, toolPath, toolPath);
  const tools = rawTools ? normalizeToolManifest(rawTools) : [];
  const permissions = normalizePermissions(files, manifest, tools);
  const mcpMap = new Map();
  for (const item of normalizeMcpList(manifest.mcp)) mcpMap.set(item.id, item);
  const mcp = [...mcpMap.values()];
  const skills = scanSkillDocs(files, manifest);
  const dependencyMap = new Map();
  const addDependency = (dependency) => dependencyMap.set(dependency.type + ":" + dependency.id + ":" + (dependency.toolName || ""), dependency);
  for (const dependency of manifest.dependencies || []) addDependency(dependency);
  for (const item of mcp) addDependency({ type: "mcp", id: item.id, name: item.name, required: true, source: "bundled", installHint: item.command || item.url || "随 APP 包声明的 MCP 服务" });
  for (const skill of skills) addDependency({ type: "skill", id: slug(skill.title), name: skill.title, required: false, source: "bundled", path: skill.path, installHint: skill.preview });
  for (const tool of tools) {
    const handler = tool.handler || { type: tool.handlerType };
    if (handler.type === "skill" && handler.skillId) addDependency({ type: "skill", id: handler.skillId, name: handler.skillId, required: true, source: "system", toolName: tool.name, installHint: "工具 handler.skillId 指向的功能 Skill" });
    if (handler.type === "mcp-tool" && handler.serverId) addDependency({ type: "mcp", id: handler.serverId, name: handler.serverId, required: true, source: "system", toolName: handler.toolName || tool.name, installHint: "工具 handler.serverId 指向的系统 MCP" });
  }
  const dependencies = [...dependencyMap.values()].slice(0, 96);
  const warnings = [];
  if (dependencies.length) warnings.push("此包声明了能力依赖；缺失的依赖会保持待安装状态。");
  if (mcp.length) warnings.push("此包携带 MCP 元数据；本批不启动任何 MCP 子进程。");
  if (tools.length) warnings.push("此包的 Agent 工具已进入能力清单；本批不执行工具。");
  if (skills.length) warnings.push("此包包含 Skill 文档。");
  return { agentSummary: String(manifest.agent && manifest.agent.summary || "").slice(0, 400), tools, permissions, dependencies, mcp, skills, warnings, canvas: collectCanvasCapabilities(files, manifest) };
}

/** 源 developerApps.ts:829-856：完整解析一个开发者包（不落盘）。 */
function prepareDeveloperApp(entries, options = {}) {
  const guarded = guardPackageEntries(entries);
  if (!guarded.length) throw createDeveloperError(DEVELOPER_ERR_PACKAGE_INVALID, "压缩包为空");
  const prefix = commonTopLevel(guarded);
  const files = guarded.map((file) => ({ name: safePath(file.name.slice(prefix.length)), data: file.data })).filter((file) => file.name);
  const manifestFile = files.find((file) => file.name === "dx-app.json");
  if (!manifestFile) throw createDeveloperError(DEVELOPER_ERR_PACKAGE_INVALID, "根目录缺少 dx-app.json");
  if (manifestFile.data.length > MAX_APP_MANIFEST_BYTES) throw createDeveloperError(DEVELOPER_ERR_PACKAGE_INVALID, "dx-app.json 过大（最大 1 MB）");
  let manifestJson;
  try { manifestJson = JSON.parse(manifestFile.data.toString("utf8")); }
  catch { throw createDeveloperError(DEVELOPER_ERR_MANIFEST_INVALID, "dx-app.json 不是有效 JSON"); }
  const manifest = normalizeManifest(manifestJson, files, options);
  validateDeclaredPackageFiles(files, manifest);
  const entryFile = files.find((file) => file.name === (manifest.entry || "index.html"));
  if (entryFile && /\.html?$/i.test(entryFile.name)) {
    const html = entryFile.data.toString("utf8");
    const missing = [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
      .map((match) => match[1].trim())
      .filter((value) => value && !/^(?:[a-z]+:|\/\/|\/|#|\{)/i.test(value))
      .map((value) => value.split(/[?#]/)[0])
      .filter(Boolean)
      .map((value) => safePath(path.posix.join(path.posix.dirname(entryFile.name), value)))
      .filter((target) => !files.some((file) => file.name === target));
    if (missing.length) throw createDeveloperError(DEVELOPER_ERR_PACKAGE_INVALID, "入口引用了不存在的资源：" + [...new Set(missing)].join("、"));
  }
  const capabilities = collectCapabilities(files, manifest);
  return { files, manifest, id: manifest.id, capabilities };
}

// ---------------------------------------------------------------------------
// 出网口径（源 developerNetwork.ts:26-42；判定复用 platform-domain.cjs:224-262）
// ---------------------------------------------------------------------------

function networkPolicyOf(manifest) {
  const network = manifest && manifest.network;
  if (!network || !Array.isArray(network.domains) || !network.domains.length) return null;
  return { domains: network.domains.slice(0, 64), methods: Array.isArray(network.methods) ? network.methods.slice(0, 8) : ["GET"], maxResponseBytes: network.maxResponseBytes };
}

/** 未配置 network 白名单时返回结构化错误（任务书：拒绝而不是放行）。 */
function requireNetworkPolicy(manifest) {
  const policy = networkPolicyOf(manifest);
  if (!policy) throw createDeveloperError(DEVELOPER_ERR_NETWORK_NOT_DECLARED, "App 未声明 network.domains，出网请求一律拒绝", { appId: manifest && manifest.id });
  return policy;
}

function domainAllowed(hostname, patterns) {
  return platformDomain.domainAllowed(hostname, patterns);
}

/** 源 developerNetwork.ts:31-37；平台域错误码映射为开发者域错误码。 */
function validateDeveloperNetworkUrl(raw, policy) {
  try {
    return platformDomain.evaluateOutboundUrl(raw, policy);
  } catch (error) {
    if (error && error.code === platformDomain.PLATFORM_ERR_FORBIDDEN) {
      throw createDeveloperError(DEVELOPER_ERR_NETWORK_BLOCKED, "域名未在 APP 网络白名单中：" + String((error.detail && error.detail.host) || ""));
    }
    throw createDeveloperError(DEVELOPER_ERR_INVALID_INPUT, "网络请求 URL 无效或不是标准 HTTPS");
  }
}

/** 源 developerNetwork.ts:39-42 的判定部分：DNS 为空或任意内网地址即拒绝。 */
function evaluableAddressesArePublic(addresses) {
  return platformDomain.evaluableAddressesArePublic(addresses);
}

/** 源 developerNetwork.ts:12-19：每 (userId, appId) 每分钟 60 次。 */
function createDeveloperRateLimiter(options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 60;
  const windowMs = Number.isFinite(options.windowMs) ? Math.max(1000, Math.floor(options.windowMs)) : 60_000;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const windows = new Map();
  return {
    limit,
    windowMs,
    enforce(userId, appId) {
      const key = String(userId) + ":" + String(appId);
      const timestamp = now();
      const recent = (windows.get(key) || []).filter((stamp) => stamp > timestamp - windowMs);
      if (recent.length >= limit) throw createDeveloperError(DEVELOPER_ERR_RATE_LIMITED, "APP 安全网络请求超过每分钟 " + limit + " 次配额");
      recent.push(timestamp);
      windows.set(key, recent);
      return recent.length;
    },
    count(userId, appId) {
      const key = String(userId) + ":" + String(appId);
      return (windows.get(key) || []).filter((stamp) => stamp > now() - windowMs).length;
    },
    reset(userId, appId) {
      windows.delete(String(userId) + ":" + String(appId));
    },
  };
}

// ---------------------------------------------------------------------------
// IPC 安全投影（只出相对路径 / 无密钥）
// ---------------------------------------------------------------------------

function projectManifest(manifest) {
  if (!manifest) return null;
  return {
    format: manifest.format,
    id: manifest.id,
    version: manifest.version,
    build: manifest.build,
    releaseChannel: manifest.releaseChannel,
    minSystemVersion: manifest.minSystemVersion,
    maxSystemVersion: manifest.maxSystemVersion || null,
    dataVersion: manifest.dataVersion,
    name: manifest.name,
    subtitle: manifest.subtitle,
    description: manifest.description,
    category: manifest.category,
    entry: manifest.entry,
    multiInstance: manifest.multiInstance === true,
    backgroundMode: manifest.backgroundMode,
    permissions: (manifest.permissions || []).slice(0, 96),
    network: manifest.network ? { domains: manifest.network.domains.slice(0, 64), methods: manifest.network.methods.slice(0, 8), maxResponseBytes: manifest.network.maxResponseBytes } : null,
    canvas: manifest.canvas ? { nodeManifests: manifest.canvas.nodeManifests.slice(0, 32), templateManifests: manifest.canvas.templateManifests.slice(0, 32) } : null,
    hasMigrations: !!(manifest.migrations && manifest.migrations.length),
    migrations: (manifest.migrations || []).map((item) => ({ from: item.from, to: item.to })),
  };
}

function projectCapabilities(capabilities) {
  if (!capabilities) return { agentSummary: "", tools: [], permissions: [], dependencies: [], mcp: [], skills: [], warnings: [], canvas: null };
  return {
    agentSummary: capabilities.agentSummary || "",
    tools: (capabilities.tools || []).map((tool) => ({ name: tool.name, title: tool.title, risk: tool.risk, handlerType: tool.handlerType, permission: tool.permission || null, hasConfirmation: !!(tool.confirmation && tool.confirmation.required) })),
    permissions: (capabilities.permissions || []).slice(0, 96),
    dependencies: (capabilities.dependencies || []).map((item) => ({ type: item.type, id: item.id, name: item.name, required: item.required !== false, source: item.source })),
    mcp: (capabilities.mcp || []).map((item) => ({ id: item.id, name: item.name, transport: item.transport, hasUrl: !!item.url, autoStart: item.autoStart === true })),
    skills: (capabilities.skills || []).map((item) => ({ path: item.path, title: item.title })),
    warnings: (capabilities.warnings || []).slice(0, 8),
    // 画布节点动作列表刻意拍平：foundation 的 IPC 脱敏 depth 封顶是 6，嵌套 actions 会被裁成 <max-depth>。
    canvas: capabilities.canvas ? {
      nodeManifests: (capabilities.canvas.nodeManifests || []).slice(0, 32),
      templateManifests: (capabilities.canvas.templateManifests || []).slice(0, 32),
      nodes: (capabilities.canvas.nodes || []).map((node) => ({ type: node.type, title: node.title, executorType: node.executorType || null, executorToolName: node.executorToolName || null, actionCount: (node.actions || []).length })),
      actions: (capabilities.canvas.nodes || []).flatMap((node) => (node && node.executorType === "agent-tool" && node.executorToolName ? (node.actions || []).filter((action) => action && action.kind === "run").map((action) => ({ id: node.type + "." + action.id, title: action.title || node.title, toolName: node.executorToolName, nodeType: node.type })) : [])),
      templates: (capabilities.canvas.templates || []).map((template) => ({ id: template.id, title: template.title, nodeCount: template.nodeCount })),
    } : null,
  };
}

// ---------------------------------------------------------------------------
// B7x · 已安装 App → automation app_action 可执行动作（只投影真实声明，不伪造）
// ---------------------------------------------------------------------------

/**
 * 把一份 release（归一化清单 + 能力投影）投影成 automation 域的 pack：
 *   { id, manifest: { id, name, version, automation: { actions: [{ id, title, toolName, ... }] } } }
 *
 * 只投影真正有执行出口的动作：
 *   · capabilities.tools：每个工具名即 runTool 的 toolName（本仓既有口径不变）；
 *   · capabilities.canvas：只有 executor.type === "agent-tool" 且声明了 kind === "run" 的
 *     节点动作才是可执行动作，toolName 取节点的 agent-tool 名（例如 canvas.ai.generate）；
 *     read / configure 动作不调用执行器，不投影；builtin / skill / mcp-tool / workflow /
 *     app-bridge 执行器本仓没有 runTool 出口，**不投影**（不伪造可执行能力）。
 * 没有任何可用动作时 actions 为空数组 —— 由调用方保持结构化拒绝。
 */
function projectDeveloperAppActions(input) {
  const source = input && typeof input === "object" ? input : {};
  const manifest = source.manifest && typeof source.manifest === "object" ? source.manifest : {};
  const capabilities = source.capabilities && typeof source.capabilities === "object" ? source.capabilities : {};
  const actions = [];
  const seen = new Set();
  const add = (id, title, toolName, extra) => {
    const actionId = String(id || "").trim();
    const target = String(toolName || "").trim();
    if (!actionId || !target || seen.has(actionId)) return;
    seen.add(actionId);
    actions.push(Object.assign({ id: actionId, title: String(title || actionId).slice(0, 60), toolName: target }, extra));
  };
  for (const tool of Array.isArray(capabilities.tools) ? capabilities.tools : []) {
    if (!tool || !tool.name) continue;
    add(tool.name, tool.title || tool.name, tool.name, { source: "tool", handlerType: tool.handlerType || null });
  }
  const canvasNodes = capabilities.canvas && Array.isArray(capabilities.canvas.nodes) ? capabilities.canvas.nodes : [];
  for (const node of canvasNodes) {
    if (!node || node.executorType !== "agent-tool" || !node.executorToolName) continue;
    for (const action of Array.isArray(node.actions) ? node.actions : []) {
      if (!action || action.kind !== "run") continue;
      add(node.type + "." + action.id, action.title || node.title, node.executorToolName, { source: "canvas", nodeType: node.type, actionKind: "run" });
    }
  }
  const appId = String(source.appId || manifest.id || "");
  return {
    id: appId,
    manifest: {
      id: String(manifest.id || appId),
      name: String(manifest.name || ""),
      version: String(manifest.version || ""),
      automation: { actions },
    },
  };
}

/** 从已投影的 pack 列表里解析 app_action 参数（源 automations.ts:122-146 的目录侧）。 */
function normalizeDeveloperAppAction(args, packs) {
  const source = args && typeof args === "object" ? args : {};
  const appId = String(source.appId || "");
  const actionId = String(source.actionId || "");
  if (!appId || !actionId) return null;
  const pack = (Array.isArray(packs) ? packs : []).find((item) => item && item.id === appId && item.manifest && item.manifest.automation && Array.isArray(item.manifest.automation.actions) && item.manifest.automation.actions.some((candidate) => candidate.id === actionId));
  if (!pack) return null;
  return { appId, actionId, values: source.values && typeof source.values === "object" && !Array.isArray(source.values) ? source.values : {} };
}

/**
 * automation 域的 developerApps 适配器（store 注入，主进程只做接线；纯逻辑、无 I/O）。
 * 契约与 automation-service.cjs 的 requireAdapter / executeAppAction 一致：
 *   listPacks / installedAppIds / catalog / normalizeAction / runTool。
 * 未提供 createError 时使用与主进程 automationAdapterError 同形状的错误（name + code + detail），
 * automation 域据此保留 AUTOMATION_INVALID_INPUT / AUTOMATION_NOT_FOUND。
 */
function createDeveloperAppActionAdapter({ store, runTool, createError } = {}) {
  if (!store || typeof store.currentRelease !== "function" || typeof store.readRelease !== "function") {
    throw createDeveloperError(DEVELOPER_ERR_INVALID_INPUT, "createDeveloperAppActionAdapter 需要 developer-store");
  }
  const raise = typeof createError === "function" ? createError : (code, message, detail) => {
    const error = new Error(String(message || code));
    error.name = "AutomationAdapterError";
    error.code = String(code);
    if (detail !== undefined) error.detail = detail;
    return error;
  };
  function packOf(appId) {
    const current = store.currentRelease(appId);
    if (!current) return null;
    let release = null;
    try { release = store.readRelease(appId, current.packagePath); } catch { release = null; }
    if (!release) return null;
    // 没有可用动作时 actions 为空数组；automation 域据此保持结构化拒绝。
    return projectDeveloperAppActions({ appId, manifest: release.manifest, capabilities: release.capabilities });
  }
  function listPacks() {
    return store.listAppIds().map(packOf).filter(Boolean);
  }
  function installedAppIds(userId) {
    return typeof store.listInstalled === "function" ? store.listInstalled(String(userId)).map((row) => row.appId) : [];
  }
  function catalog(userId) {
    const installed = new Set(installedAppIds(userId));
    return listPacks().map((pack) => ({ appId: pack.id, name: pack.manifest.name, version: pack.manifest.version, enabled: installed.has(pack.id), actions: pack.manifest.automation.actions }));
  }
  /** 定义期参数规约（automation-domain.normalizeAppActionArgs 的注入面）。 */
  function normalizeAction(args) {
    const source = args && typeof args === "object" ? args : {};
    const appId = String(source.appId || "");
    const actionId = String(source.actionId || "");
    if (!appId || !actionId) throw raise("AUTOMATION_INVALID_INPUT", "app_action 需要 appId 与 actionId");
    const normalized = normalizeDeveloperAppAction(source, listPacks());
    if (!normalized) throw raise("AUTOMATION_NOT_FOUND", "APP 自动化能力不存在（按已安装 App 的真实 capabilities.tools / capabilities.canvas 声明投影）：" + appId + "/" + actionId, { appId, actionId });
    return normalized;
  }
  return { listPacks, installedAppIds, catalog, normalizeAction, runTool };
}

/**
 * 本地账号目录（B4e）的 developer App 来源适配器（store 注入，主进程只做接线；纯逻辑、无 I/O）。
 *
 * 契约与 local-account-service.cjs 的 deps.appCatalog 一致：
 *   listInstalledApps({ userId, organizationId }) → [{ id, name, desc }]（仅该用户已启用的 App）
 *   listPermissionManifests({ userId }) → [{ appId, appName, permissions: [{ code, label, description }] }]
 *     （给出 userId 时按源 auth.ts:652-655 的 installedIds 过滤，只看该用户已安装的 App；
 *      不传 userId 即源"未传 installedIds"的全量语义 auth.ts:681-683，保持既有契约。）
 *
 * 投影规则逐条对齐源 auth.ts:630-679：
 *   · desc = manifest.subtitle || manifest.description || '已安装应用'（源同序）；
 *   · 权限项 label/description 优先取同一权限声明的工具（capabilities.tools），
 *     其次源内置标准权限表，最后回落权限码末两段 / '<appName> 声明的权限'。
 * 无数据库时 store.listInstalled / listAppIds 返回空数组 —— 返回空目录，不伪造。
 */
function createDeveloperAppCatalogAdapter({ store } = {}) {
  if (!store || typeof store.listInstalled !== "function" || typeof store.currentRelease !== "function" || typeof store.readRelease !== "function") {
    throw createDeveloperError(DEVELOPER_ERR_INVALID_INPUT, "createDeveloperAppCatalogAdapter 需要 developer-store");
  }
  // 源 auth.ts:663-670 的标准权限标签表（原样保留）。
  const STANDARD_PERMISSION_LABELS = Object.freeze({
    "app-api.call": { label: "调用 APP API", description: "允许 Agent 调用这个 APP 对外开放的接口" },
    "ui.notify": { label: "发送系统通知", description: "允许这个 APP 的 Agent 能力发送系统通知" },
    "ui.external": { label: "打开外部页面", description: "允许这个 APP 的 Agent 能力打开外部页面" },
    "file.write": { label: "写入文件", description: "允许这个 APP 的 Agent 能力写入文件" },
    "realtime.room": { label: "使用实时房间", description: "允许这个 APP 创建、发现和加入局域网实时房间" },
    "collab.project": { label: "使用协同项目", description: "允许这个 APP 创建持久项目并按成员或邀请口令协作" },
  });
  function releaseOf(appId) {
    const current = store.currentRelease(appId);
    if (!current) return null;
    try { return store.readRelease(appId, current.packagePath); } catch { return null; }
  }
  function listInstalledApps(input) {
    const userId = input && input.userId != null && String(input.userId) !== "" ? String(input.userId) : null;
    if (!userId) return [];
    const out = [];
    for (const row of store.listInstalled(userId) || []) {
      const appId = row && row.appId ? String(row.appId) : "";
      if (!appId) continue;
      const release = releaseOf(appId);
      if (!release || !release.manifest) continue;
      out.push({
        id: appId,
        name: String(release.manifest.name || appId),
        desc: String(release.manifest.subtitle || release.manifest.description || "已安装应用"),
      });
    }
    return out;
  }

  /**
   * 源 auth.ts:652-655：developerPermissionManifests(installedIds) 按该用户已安装的 App 过滤。
   * 适配器以 userId 为入口（与 listInstalledApps({ userId }) 同形），由 store.listInstalled 得到
   * installedIds；不给 userId 时退回源 :686 调用 permissionManifests() 的全量语义。
   */
  function listPermissionManifests(input = {}) {
    const rawUserId = input && typeof input === "object" ? input.userId : input;
    const userId = rawUserId != null && String(rawUserId) !== "" ? String(rawUserId) : null;
    const appIds = userId
      ? (store.listInstalled(userId) || []).map((row) => row && row.appId).filter(Boolean)
      : store.listAppIds() || [];
    const out = [];
    for (const appId of appIds) {
      const release = releaseOf(appId);
      if (!release || !release.manifest) continue;
      const raw = release.capabilities && Array.isArray(release.capabilities.permissions) ? release.capabilities.permissions : [];
      const codes = [...new Set(raw.map(String).filter(Boolean))];
      if (!codes.length) continue;
      const tools = release.capabilities && Array.isArray(release.capabilities.tools) ? release.capabilities.tools : [];
      const appName = String(release.manifest.name || appId);
      out.push({
        appId,
        appName,
        permissions: codes.map((code) => {
          const tool = tools.find((item) => item && item.permission === code);
          const standard = STANDARD_PERMISSION_LABELS[code.split(".").slice(-2).join(".")];
          return {
            code,
            label: String((tool && tool.title) || (standard && standard.label) || code.split(".").slice(-2).join(".")),
            description: String((tool && tool.description) || (standard && standard.description) || appName + " 声明的权限"),
          };
        }),
      });
    }
    return out;
  }
  return { listInstalledApps, listPermissionManifests };
}

module.exports = {
  DEVELOPER_SYSTEM_VERSION,
  DEFAULT_DEVELOPER_APP_VERSION,
  DEFAULT_DEVELOPER_APP_BUILD,
  DEVELOPER_BASE_COMMANDS,
  DEVELOPER_EXTENSION_COMMANDS,
  DEVELOPER_COMMANDS,
  DEVELOPER_ERROR_CODES,
  DEVELOPER_ERR_COMMAND_NOT_ALLOWED,
  DEVELOPER_ERR_INVALID_INPUT,
  DEVELOPER_ERR_UNAUTHENTICATED,
  DEVELOPER_ERR_FORBIDDEN,
  DEVELOPER_ERR_NOT_FOUND,
  DEVELOPER_ERR_CONFLICT,
  DEVELOPER_ERR_DEPENDENCY_UNAVAILABLE,
  DEVELOPER_ERR_MANIFEST_INVALID,
  DEVELOPER_ERR_MANIFEST_FIELD_REJECTED,
  DEVELOPER_ERR_PERMISSION_REJECTED,
  DEVELOPER_ERR_PATH_ESCAPE,
  DEVELOPER_ERR_PACKAGE_INVALID,
  DEVELOPER_ERR_NETWORK_NOT_DECLARED,
  DEVELOPER_ERR_NETWORK_BLOCKED,
  DEVELOPER_ERR_RATE_LIMITED,
  DEVELOPER_ERR_INTEGRITY_FAILED,
  DEVELOPER_ERR_INTERNAL,
  RISK_LEVELS,
  TOOL_RISKS,
  TOOL_HANDLER_TYPES,
  REJECTED_MANIFEST_FIELDS,
  DANGEROUS_PERMISSION_PATTERNS,
  MAX_PACKAGE_BYTES,
  MAX_FILE_BYTES,
  MAX_ENTRY_COUNT,
  ALLOWED_EXTENSIONS,
  ALLOWED_MCP_RUNTIME_EXTENSIONS,
  isValidSemver,
  compareSemver,
  compareAppVersion,
  appReleaseKey,
  systemSupportsApp,
  safePath,
  slug,
  decodeUploadName,
  createDeveloperError,
  isDeveloperError,
  redactDeveloperValue,
  sanitizeDeveloperText,
  normalizeDeveloperError,
  developerCommandNotAllowed,
  toDeveloperIpcResult,
  isDeveloperCommand,
  developerCommandEntry,
  developerCommandRisk,
  developerCommandRequiresCredential,
  listDeveloperCommands,
  readPackageEntries,
  guardPackageEntries,
  commonTopLevel,
  normalizeNetworkDeclaration,
  normalizeToolManifest,
  normalizeManifest,
  normalizeCanvasDeclaration,
  validateDeclaredPackageFiles,
  collectCapabilities,
  prepareDeveloperApp,
  networkPolicyOf,
  requireNetworkPolicy,
  domainAllowed,
  validateDeveloperNetworkUrl,
  evaluableAddressesArePublic,
  createDeveloperRateLimiter,
  projectManifest,
  projectCapabilities,
  projectDeveloperAppActions,
  normalizeDeveloperAppAction,
  createDeveloperAppActionAdapter,
  createDeveloperAppCatalogAdapter,
};
