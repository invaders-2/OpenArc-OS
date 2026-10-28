"use strict";
/**
 * B4b · 技能包（ZIP）导入/导出/卸载（源 server/skillPacks.ts:1-664）。
 *
 * 移植映射（逐函数对照源行号）：
 *   · parseOnlineSkillSource          ← skillPacks.ts:65-99   （纯字符串解析，不执行、不联网）
 *   · readZip / safePath              ← skillPacks.ts:59-63,101-143（危险路径拒绝）
 *   · loadIndex / saveIndex / decodeUploadName / writeJsonAtomic ← :145-155, :165-170
 *   · bundled 状态与安装              ← :158-286
 *   · listSkillPacks / importSkillPack ← :288-331
 *   · onlineInstallerEnvironment      ← :334-346（纯环境变量拼装，保留）
 *   · registerSkillPackRoutes / importRegisteredSkillPack / syncSkillPackRoutes ← :397-435
 *   · importOnlineSkillPack           ← :439-474
 *   · deleteSkillPack / renameSkillPack ← :476-498
 *   · translateSkillPackDisplay       ← :500-530
 *   · runSkillPack / entryPointHelp   ← :552-585
 *   · listPackSkillDocs / readPackSkillDoc / buildPackSkillContext / readPackSkillContext ← :587-664
 *
 * 依赖与云商业化处置（硬约束：DX OS 只读 / 不联网 / 不 npm install / 不新增第三方依赖）：
 *   · skillPacks.ts:12 import { callChat } from './protocols.ts' —— 远端 LLM 翻译。
 *     改注入 providerAdapter（形状对齐 B2 electron/provider-protocol-service.cjs:151 call）；
 *     未注入时抛结构化 AGENT_DEPENDENCY_UNAVAILABLE，绝不静默降级。
 *   · skillPacks.ts:439-474 importOnlineSkillPack —— ModelScope 在线安装（spawn npx，联网）。
 *     改注入 runner；未注入时先结构化失败，本文件自身不发起任何网络请求（OUT：云端）。
 *   · skillPacks.ts:552-585 runSkillPack / entryPointHelp —— spawn docker 执行包内 Python。
 *     本批禁止执行外来程序；改注入 runner；未注入即 AGENT_DEPENDENCY_UNAVAILABLE。
 *   · skillPacks.ts:450-455 npx 路径探测 —— 依赖 Node 自带 npm，本仓不复刻，交给注入 runner。
 *   · skillPacks.ts:11 skills.ts listSkills / saveCustomSkill / deleteCustomSkillsForPack /
 *     resolveChatTarget / updateCustomSkillDisplay —— 属 B4a electron/skill-store.cjs，
 *     经注入调用（skill-import.cjs 负责真正的 saveCustomSkill 落库）。
 *   · skillPacks.ts:13 dataPaths.ts dataPath —— 用 B1 dxos-foundation-paths.cjs:41 resolveDxosPaths
 *     解析 <userData>/dxos/skill-packs 与 <userData>/dxos/bundled-skill-packs.json。
 *   · skillPacks.ts:14 agentWorkspaceSkills.ts registerAgentWorkspace /
 *     deleteAgentWorkspaceProfiles(+ForPack) —— 已由 B4c electron/skill-workspace.cjs 落地，
 *     经注入适配器接入（skill-service.cjs 装配 agentWorkspace）；未注入时结构化拒绝。
 *   · 源文件未 import dxosProtocol / apiQuota / cloudEntitlement：无云端 AI 任务、无计费、
 *     无权益门禁代码需要移除（本批 OUT 项逐条已在上方 registry 注明）。
 *   · ZIP 解压只用 node:zlib.inflateRawSync；落盘只经注入 fsImpl（默认 node:fs）。
 */
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { inflateRawSync } = require("node:zlib");
const { resolveDxosPaths, DXOS_LAYOUT } = require("./dxos-foundation-paths.cjs");
const {
  createDxosError,
  DXOS_ERR_INVALID_INPUT,
  DXOS_ERR_CHILD_FAILED,
} = require("./dxos-foundation-errors.cjs");
const skillImport = require("./skill-import.cjs");

/** 源 skillPacks.ts:22-24。 */
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** 源 skillPacks.ts:25-26（源为 Windows 路径常量，这里改成跨平台可注入默认值）。 */
const SANDBOX_IMAGE = process.env.SKILL_SANDBOX_IMAGE || "fastapi-fastapi-app:latest";
const DEFAULT_RUN_DIR = process.env.SKILL_SANDBOX_RUN_DIR || path.join(os.tmpdir(), "ccs-skill-runs");

/** 结构化依赖缺失码：与 agent-runtime-deps.cjs:17 同一约定。 */
const AGENT_DEPENDENCY_UNAVAILABLE = "AGENT_DEPENDENCY_UNAVAILABLE";

/** 源 skillPacks.ts:229-236 的预置包清单；expectedSkillCount 参数化以便测试注入。 */
const DEFAULT_BUNDLED_SPECS = Object.freeze([
  Object.freeze({
    key: "minimax-h3-skills",
    version: 1,
    id: "official-minimax-h3-skills",
    name: "MiniMax H3 Skills",
    sourceName: "MiniMax H3 Skills（系统预置）",
    directory: "minimax-h3-skills",
    expectedSkillCount: 9,
    matchName: /^MiniMax H3 Skills$/i,
  }),
]);

function fail(reason, message) {
  const err = createDxosError(DXOS_ERR_INVALID_INPUT, "Skill 包错误：" + message);
  err.kind = "SKILL_PACK_FAILED";
  err.reason = reason;
  throw err;
}

function dependencyUnavailable(name, detail) {
  const err = new Error("技能包依赖不可用：" + String(name));
  err.name = "AgentDependencyUnavailableError";
  err.code = AGENT_DEPENDENCY_UNAVAILABLE;
  err.dependency = String(name);
  if (detail !== undefined) err.detail = detail;
  return err;
}

// ══════════════════════════════════════════════════════════════════════
// 注入中心（源直接 import skills.ts / protocols.ts / dataPaths.ts / agentWorkspaceSkills.ts）
// ══════════════════════════════════════════════════════════════════════
function defaultDeps() {
  return {
    userDataDir: null,       // 必填：<userData>，用于解析 <userData>/dxos/
    dataDir: null,           // 可选：直接给出 <userData>/dxos 数据根（与 configureSkillStore 的 dataDir 同义）
    paths: null,             // 可选：resolveDxosPaths() 结果；提供时优先于 userDataDir/dataDir
    appDir: null,            // 可选：应用根（默认 electron/ 的上级），用于定位随包 resources/
    bundledDir: null,        // 可选：bundled-skill-packages 目录（显式注入，优先级最高）
    fsImpl: null,            // 可选：node:fs 替身
    skillStore: null,        // B4a electron/skill-store.cjs 导出集合
    providerAdapter: null,   // B2：{ call } 或 { callChat }
    agentWorkspace: null,    // 已实现（B4c skill-workspace.cjs）：registerAgentWorkspace / deleteAgentWorkspaceProfiles(+ForPack)
    runner: null,            // 本机子进程（在线安装 / docker）；{ spawn } 或 { run }
    clock: () => Date.now(),
    idFactory: () => crypto.randomUUID(),
    logger: null,
    bundledSpecs: null,      // 可选：覆盖预置包清单
  };
}

let deps = defaultDeps();

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 只接受白名单键；注入 skillStore 时同步下发给 skill-import.cjs。 */
function configureSkillPack(patch = {}) {
  if (!isPlainObject(patch)) throw dependencyUnavailable("configureSkillPack", "配置必须是对象");
  const next = { ...deps };
  for (const key of Object.keys(defaultDeps())) if (patch[key] !== undefined) next[key] = patch[key];
  deps = next;
  if (patch.skillStore !== undefined) skillImport.configureSkillImport({ skillStore: patch.skillStore });
  return snapshot();
}

/** 仅供测试：清空注入，恢复"未接入"状态。 */
function resetSkillPackForTests() {
  deps = defaultDeps();
  skillImport.resetSkillImportForTests();
  return snapshot();
}

function snapshot() {
  return { ...deps };
}

function skillPackDeps() {
  return deps;
}

function resolveFs() {
  return deps.fsImpl && typeof deps.fsImpl.readFileSync === "function" ? deps.fsImpl : fs;
}

/**
 * 解析 <userData>/dxos/ 布局（dxos-foundation-paths.cjs:41）。
 * 优先级：预解析 paths > dataDir（直接给 dxos 数据根，与 configureSkillStore 对齐）> userDataDir。
 */
function resolvePaths() {
  if (deps.paths && deps.paths.root && deps.paths.directory) return deps.paths;
  if (deps.dataDir) {
    const directory = {};
    for (const name of DXOS_LAYOUT.directories) directory[name] = path.join(deps.dataDir, name);
    return { root: deps.dataDir, directory };
  }
  if (!deps.userDataDir) throw dependencyUnavailable("userDataDir", "需要注入 userDataDir / dataDir 或预解析 paths");
  return resolveDxosPaths(deps.userDataDir);
}

function skillPacksDir() {
  return resolvePaths().directory["skill-packs"];
}

function indexFile() {
  return path.join(skillPacksDir(), "index.json");
}

function bundledStateFile() {
  return path.join(resolvePaths().root, "bundled-skill-packs.json");
}

/**
 * 随包技能包的候选目录（先命中的目录胜出）：
 *   ① 显式注入 deps.bundledDir（测试 / 宿主定制）
 *   ② 环境变量 DX_BUNDLED_SKILL_PACKAGES_DIR / DX_BUNDLED_SKILL_PACKS_DIR
 *   ③ <应用根>/resources/bundled-skill-packages（随包，优先扫描）
 *   ④ <应用根>/electron/bundled-skill-packages（历史缺省，保留兼容）
 * 本仓不搬运任何第三方包，目录为空是有效空态。
 */
function bundledPackageDirs() {
  const dirs = [];
  if (deps.bundledDir) dirs.push(String(deps.bundledDir));
  if (process.env.DX_BUNDLED_SKILL_PACKAGES_DIR) dirs.push(process.env.DX_BUNDLED_SKILL_PACKAGES_DIR);
  if (process.env.DX_BUNDLED_SKILL_PACKS_DIR) dirs.push(process.env.DX_BUNDLED_SKILL_PACKS_DIR);
  const appDir = deps.appDir ? String(deps.appDir) : path.join(__dirname, "..");
  dirs.push(path.join(appDir, "resources", "bundled-skill-packages"));
  dirs.push(path.join(appDir, "electron", "bundled-skill-packages"));
  return [...new Set(dirs.filter(Boolean).map((dir) => path.resolve(dir)))];
}

function bundledPackageDir() {
  return bundledPackageDirs()[0];
}

function packageRoot(id) {
  return path.join(skillPacksDir(), id);
}

function sourceRoot(id) {
  return path.join(packageRoot(id), "source");
}

/** 解析技能存储：显式注入优先，其次惰性 require ./skill-store.cjs。 */
function resolveSkillStore() {
  if (deps.skillStore) return deps.skillStore;
  try {
    // eslint-disable-next-line global-require
    return require("./skill-store.cjs");
  } catch (error) {
    if (error && error.code === "MODULE_NOT_FOUND" && /skill-store\.cjs/.test(String(error.message))) {
      throw dependencyUnavailable("skillStore", "electron/skill-store.cjs 尚未接入（B4a 并行波次）");
    }
    throw error;
  }
}

function requireSkillStoreMethod(name) {
  const store = resolveSkillStore();
  if (!store || typeof store[name] !== "function") throw dependencyUnavailable("skillStore." + name);
  return store[name].bind(store);
}

function resolveProviderAdapter() {
  if (deps.providerAdapter) return deps.providerAdapter;
  try {
    // eslint-disable-next-line global-require
    const service = require("./provider-protocol-service.cjs");
    if (service && typeof service.call === "function") return service;
  } catch { /* 未接入时按依赖缺失处理 */ }
  throw dependencyUnavailable("providerAdapter", "B2 provider-protocol-service 未注入");
}

/**
 * 源 :500-530 用 callChat(provider, model, {system,prompt}, {}, 120_000)。
 * 优先用注入的 callChat；否则把输入映射到 B2 provider-protocol-service.call
 * （provider-protocol-service.cjs:151 的 { providerId, model, messages, params, signal }）。
 */
function invokeChat(provider, model, input, params, timeoutMs, signal) {
  const adapter = resolveProviderAdapter();
  if (typeof adapter.callChat === "function") return adapter.callChat(provider, model, input, params, timeoutMs, signal);
  if (typeof adapter.call !== "function") throw dependencyUnavailable("providerAdapter.callChat");
  const messages = [];
  if (input && input.system) messages.push({ role: "system", content: String(input.system) });
  if (Array.isArray(input && input.messages)) messages.push(...input.messages);
  else messages.push({ role: "user", content: String((input && input.prompt) || "") });
  return Promise.resolve(adapter.call({
    providerId: provider && provider.id,
    model,
    messages,
    params: { ...(params || {}) },
    signal: signal || null,
  })).then((result) => {
    if (result && result.ok === false) {
      throw createDxosError(DXOS_ERR_CHILD_FAILED, "模型调用失败：" + String(result.error || "unknown"));
    }
    return {
      text: String((result && result.text) || ""),
      usage: result && result.usage,
      latencyMs: (result && result.latencyMs) || 0,
      raw: result,
    };
  });
}

function requireAgentWorkspace() {
  if (deps.agentWorkspace) return deps.agentWorkspace;
  throw dependencyUnavailable("agentWorkspace", "未注入 Agent Workspace 适配器：由 skill-service 装配后注入");
}

function registerAgentWorkspace(pack, root) {
  const adapter = requireAgentWorkspace();
  if (typeof adapter.registerAgentWorkspace !== "function") throw dependencyUnavailable("agentWorkspace.registerAgentWorkspace");
  return adapter.registerAgentWorkspace(pack, root);
}

function deleteAgentWorkspaceProfiles(ids) {
  if (!ids || !ids.length) return undefined;
  const adapter = requireAgentWorkspace();
  if (typeof adapter.deleteAgentWorkspaceProfiles !== "function") throw dependencyUnavailable("agentWorkspace.deleteAgentWorkspaceProfiles");
  return adapter.deleteAgentWorkspaceProfiles(ids);
}

function deleteAgentWorkspaceProfilesForPack(packId) {
  const adapter = requireAgentWorkspace();
  if (typeof adapter.deleteAgentWorkspaceProfilesForPack !== "function") throw dependencyUnavailable("agentWorkspace.deleteAgentWorkspaceProfilesForPack");
  return adapter.deleteAgentWorkspaceProfilesForPack(packId);
}

// ══════════════════════════════════════════════════════════════════════
// 源 skillPacks.ts:69-99：在线来源解析（纯解析，静态检查不联网）
// ══════════════════════════════════════════════════════════════════════
function safePath(value) {
  const normalized = String(value).replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/i.test(normalized) || normalized.split("/").includes("..")) {
    fail("UNSAFE_PATH", "存在不安全路径：" + value);
  }
  return normalized;
}

/**
 * 识别 ModelScope 页面 URL、npx、ModelScope SDK 与官方 bash 安装命令。
 * 这里只提取 collection，不会执行用户粘贴的 shell，也不会联网（源 :65-68）。
 */
function parseOnlineSkillSource(text) {
  const raw = String(text || "").trim();
  if (!raw) fail("EMPTY_SOURCE", "请粘贴在线 Skill 地址或安装命令");
  if (raw.length > 12_000) fail("SOURCE_TOO_LONG", "导入内容过长");

  const normalizedUrls = raw.replace(/(?=https:\/\/(?:www\.)?modelscope\.cn\/)/ig, "\n");
  const urlMatches = [...normalizedUrls.matchAll(/https:\/\/(?:www\.)?modelscope\.cn\/(collections|skills)\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)/ig)];
  const urlMatch = urlMatches.at(-1);
  const collectionMatch = raw.match(/--collection(?:=|\s+)["']?([a-z0-9_.-]+)\/([a-z0-9_.-]+)/i);
  const pageKind = urlMatch && urlMatch[1] && urlMatch[1].toLowerCase() === "skills" ? "skills" : "collections";
  const owner = (urlMatch && urlMatch[2]) || (collectionMatch && collectionMatch[1]);
  const collectionName = (urlMatch && urlMatch[3]) || (collectionMatch && collectionMatch[2]);
  if (!owner || !collectionName) {
    fail("UNRECOGNIZED_SOURCE", "无法识别在线 Skill；请粘贴 npx skills add 命令、ModelScope Skill/collection 地址、ModelScope SDK 或官方 bash 安装命令");
  }
  const collection = owner + "/" + collectionName;
  const method = /\bnpx\s+skills\s+add\b/i.test(raw)
    ? "npx"
    : /\bmodelscope\s+download\b/i.test(raw)
      ? "modelscope"
      : /install\.sh\s*\|\s*bash/i.test(raw)
        ? "bash"
        : "url";
  return {
    provider: "ModelScope",
    method,
    collection,
    sourceUrl: "https://www.modelscope.cn/" + (urlMatch ? pageKind : "collections") + "/" + collection,
    name: collectionName.replace(/[-_]+/g, " ").trim() || collectionName,
  };
}

// ══════════════════════════════════════════════════════════════════════
// 源 skillPacks.ts:101-143：读全部 ZIP 条目（危险路径拒绝）
// ══════════════════════════════════════════════════════════════════════
function u16(buf, offset) { return buf.readUInt16LE(offset); }
function u32(buf, offset) { return buf.readUInt32LE(offset); }

function readZip(buffer) {
  if (buffer.length > MAX_PACKAGE_BYTES) fail("PACKAGE_TOO_LARGE", "压缩包不能超过 32 MB");
  const searchFrom = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= searchFrom; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) fail("INVALID_ZIP", "不是有效的 ZIP 文件");
  const count = u16(buffer, eocd + 10);
  const centralOffset = u32(buffer, eocd + 16);
  if (!count || count > 1024 || centralOffset >= buffer.length) fail("INVALID_ZIP", "压缩包目录无效");
  const files = [];
  let total = 0;
  let pos = centralOffset;
  for (let index = 0; index < count; index++) {
    if (pos + 46 > buffer.length || u32(buffer, pos) !== 0x02014b50) fail("INVALID_ZIP", "压缩包目录损坏");
    const method = u16(buffer, pos + 10);
    const compressedSize = u32(buffer, pos + 20);
    const uncompressedSize = u32(buffer, pos + 24);
    const filenameSize = u16(buffer, pos + 28);
    const extraSize = u16(buffer, pos + 30);
    const commentSize = u16(buffer, pos + 32);
    const localOffset = u32(buffer, pos + 42);
    const end = pos + 46 + filenameSize + extraSize + commentSize;
    if (end > buffer.length) fail("INVALID_ZIP", "压缩包目录不完整");
    const name = safePath(buffer.subarray(pos + 46, pos + 46 + filenameSize).toString("utf8"));
    pos = end;
    if (name.endsWith("/")) continue;
    if (uncompressedSize > MAX_FILE_BYTES || compressedSize > MAX_FILE_BYTES) fail("ENTRY_TOO_LARGE", "文件过大：" + name);
    total += uncompressedSize;
    if (total > MAX_UNPACKED_BYTES) fail("PACKAGE_TOO_LARGE", "解压总内容超过 128 MB 限制");
    if (localOffset + 30 > buffer.length || u32(buffer, localOffset) !== 0x04034b50) fail("INVALID_ZIP", "文件头损坏：" + name);
    const localNameSize = u16(buffer, localOffset + 26);
    const localExtraSize = u16(buffer, localOffset + 28);
    const start = localOffset + 30 + localNameSize + localExtraSize;
    const finish = start + compressedSize;
    if (finish > buffer.length) fail("INVALID_ZIP", "文件不完整：" + name);
    const raw = buffer.subarray(start, finish);
    const data = method === 0
      ? raw
      : method === 8
        ? inflateRawSync(raw, { maxOutputLength: MAX_FILE_BYTES })
        : fail("UNSUPPORTED_COMPRESSION", "不支持的压缩方式：" + name);
    files.push({ name, data });
  }
  return files;
}

// ══════════════════════════════════════════════════════════════════════
// 源 skillPacks.ts:145-186：索引与 bundled 状态
// ══════════════════════════════════════════════════════════════════════
function loadIndex() {
  try {
    const parsed = JSON.parse(resolveFs().readFileSync(indexFile(), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function decodeUploadName(value) {
  const text = String(value == null ? "" : value);
  // 兼容 Multer 将 UTF-8 文件名按 latin1 读取后的常见乱码；正常中文不二次转换（源 :148-153）。
  if (/[^\x00-\xff]/.test(text)) return text;
  const decoded = Buffer.from(text, "latin1").toString("utf8");
  return decoded.includes("\uFFFD") ? text : decoded;
}

function saveIndex(packs) {
  writeJsonAtomic(indexFile(), packs);
}

function writeJsonAtomic(file, value) {
  const f = resolveFs();
  f.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + "." + process.pid + "." + deps.idFactory() + ".tmp";
  try {
    f.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx" });
    f.renameSync(temporary, file);
  } finally {
    try { f.unlinkSync(temporary); } catch { /* rename 成功或临时文件从未创建 */ }
  }
}

function loadBundledState() {
  try {
    const value = JSON.parse(resolveFs().readFileSync(bundledStateFile(), "utf8"));
    return {
      installed: value.installed && typeof value.installed === "object" ? value.installed : {},
      installing: value.installing && typeof value.installing === "object" ? value.installing : {},
      failed: value.failed && typeof value.failed === "object" ? value.failed : {},
    };
  } catch { return { installed: {}, installing: {}, failed: {} }; }
}

function saveBundledState(state) {
  writeJsonAtomic(bundledStateFile(), state);
}

function cleanupBundledStaging(id) {
  const f = resolveFs();
  const dir = skillPacksDir();
  if (!f.existsSync(dir)) return;
  const prefix = "." + id + ".";
  for (const entry of f.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(prefix) && entry.name.endsWith(".installing")) {
      f.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
    }
  }
}

function installBundledZip(packageFile, id, expectedSkillCount, specName) {
  const f = resolveFs();
  const files = readZip(f.readFileSync(packageFile));
  const skillCount = files.filter((entry) => /(^|\/)SKILL\.md$/i.test(entry.name)).length;
  if (skillCount !== expectedSkillCount) {
    fail("BUNDLED_SKILL_COUNT", (specName || id) + " ZIP 中应包含 " + expectedSkillCount + " 个 Skill，实际为 " + skillCount);
  }
  cleanupBundledStaging(id);
  const stagingPackage = path.join(skillPacksDir(), "." + id + "." + deps.idFactory() + ".installing");
  const stagingSource = path.join(stagingPackage, "source");
  f.mkdirSync(stagingSource, { recursive: true });
  try {
    for (const file of files) {
      const target = path.resolve(stagingSource, file.name);
      if (!target.startsWith(stagingSource + path.sep)) fail("UNSAFE_PATH", "ZIP 中存在越界路径：" + file.name);
      f.mkdirSync(path.dirname(target), { recursive: true });
      f.writeFileSync(target, file.data, { flag: "wx" });
    }
    const installedSkillCount = collectOnlineEntries(stagingSource)
      .filter((entry) => /(^|\/)SKILL\.md$/i.test(entry.name)).length;
    if (installedSkillCount !== expectedSkillCount) fail("BUNDLED_SKILL_COUNT", (specName || id) + " 解压校验失败：" + installedSkillCount);
    f.rmSync(packageRoot(id), { recursive: true, force: true });
    f.renameSync(stagingPackage, packageRoot(id));
    return installedSkillCount;
  } catch (error) {
    try { f.rmSync(stagingPackage, { recursive: true, force: true }); } catch { /* 清理失败不覆盖原始异常 */ }
    throw error;
  }
}

/** 源 skillPacks.ts:228-286：首次运行时把发布包内精选 Skill 复制到用户数据目录。 */
function ensureBundledSkillPacks() {
  const specs = Array.isArray(deps.bundledSpecs) ? deps.bundledSpecs : DEFAULT_BUNDLED_SPECS;
  const state = loadBundledState();
  const packs = loadIndex();
  let installed = 0;
  for (const spec of specs) {
    const expectedCount = Number(spec.expectedSkillCount || 9);
    if (Number(state.installed[spec.key] || 0) >= spec.version) continue;
    // 开发版或旧测试版可能已由用户手动导入同一套 Skill，保留它并避免重复显示（源 :238-246）。
    const existing = packs.find((pack) => pack.id === spec.id || (spec.matchName && spec.matchName.test(pack.name)));
    if (existing) {
      state.installed[spec.key] = spec.version;
      delete state.installing[spec.key];
      delete state.failed[spec.key];
      continue;
    }
    const interrupted = state.installing[spec.key];
    if (interrupted && interrupted.version >= spec.version) {
      state.failed[spec.key] = {
        version: spec.version,
        failedAt: deps.clock(),
        message: "上次 ZIP 安装被异常中断；已停止自动重试以保证 DX OS 可以启动",
      };
      delete state.installing[spec.key];
      if (deps.logger && typeof deps.logger.warn === "function") deps.logger.warn("系统预置 Skill 上次安装被异常中断，已跳过自动重试：" + spec.name);
      continue;
    }
    if (Number((state.failed[spec.key] && state.failed[spec.key].version) || 0) >= spec.version) continue;
    const bundledPackage = bundledPackageDirs()
      .map((dir) => path.join(dir, spec.directory + ".zip"))
      .find((candidate) => resolveFs().existsSync(candidate));
    if (!bundledPackage) continue;
    state.installing[spec.key] = { version: spec.version, startedAt: deps.clock() };
    saveBundledState(state);
    try {
      const skillCount = installBundledZip(bundledPackage, spec.id, expectedCount, spec.name);
      packs.push({
        id: spec.id,
        name: spec.name,
        sourceName: spec.sourceName,
        importedAt: deps.clock(),
        skillCount,
        entryPoints: [],
      });
      saveIndex(packs);
      state.installed[spec.key] = spec.version;
      delete state.installing[spec.key];
      delete state.failed[spec.key];
      saveBundledState(state);
      installed += 1;
    } catch (error) {
      cleanupBundledStaging(spec.id);
      state.failed[spec.key] = {
        version: spec.version,
        failedAt: deps.clock(),
        message: String(error instanceof Error ? error.message : error).slice(0, 500),
      };
      delete state.installing[spec.key];
      saveBundledState(state);
      if (deps.logger && typeof deps.logger.warn === "function") {
        deps.logger.warn("系统预置 Skill ZIP 安装失败，DX OS 将继续启动：" + state.failed[spec.key].message);
      }
    }
  }
  saveBundledState(state);
  return installed;
}

/** 随包包名只允许文件名安全字符；绝对路径与 `..` 一律结构化拒绝。 */
const SAFE_BUNDLED_NAME_RE = /^[A-Za-z0-9._-]+$/;

function ensureSafeBundledName(raw) {
  const name = raw == null ? "" : String(raw).trim();
  if (!name) fail("EMPTY_NAME", "请提供随包技能包名");
  if (name.startsWith("/") || name.startsWith("\\") || /^[a-z]:/i.test(name)) {
    fail("UNSAFE_PATH", "随包包名不能是绝对路径：" + name);
  }
  const base = name.replace(/\.zip$/i, "");
  if (!base || base.includes("..") || !SAFE_BUNDLED_NAME_RE.test(base)) {
    fail("UNSAFE_PATH", "随包包名含不安全字符：" + name);
  }
  return base;
}

/**
 * 列出随包目录里的技能包（`*.zip`）。目录不存在或为空 → 空数组，是有效空态，不报错。
 * 同名包按目录优先级去重（先命中的目录胜出）。
 */
function listBundledSkillPackages() {
  const f = resolveFs();
  const seen = new Set();
  const items = [];
  for (const dir of bundledPackageDirs()) {
    let entries;
    try { entries = f.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of [...entries].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      if (!entry.isFile() || !/\.zip$/i.test(entry.name)) continue;
      const key = String(entry.name).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const file = path.join(dir, entry.name);
      let bytes = 0;
      try { bytes = f.statSync(file).size; } catch { bytes = 0; }
      items.push({ name: entry.name, id: entry.name.replace(/\.zip$/i, ""), file, directory: dir, bytes });
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

/** 按包名（可带或不带 .zip）在当前随包目录中定位；找不到 → 结构化 NOT_FOUND（附扫描目录）。 */
function resolveBundledSkillPackage(name) {
  const base = ensureSafeBundledName(name);
  const fileName = base + ".zip";
  const found = listBundledSkillPackages().find((item) => item.name.toLowerCase() === fileName.toLowerCase());
  if (!found) {
    fail("NOT_FOUND", "随包目录中找不到技能包：" + fileName + "（扫描目录：" + bundledPackageDirs().join(" / ") + "）");
  }
  const f = resolveFs();
  if (!f.existsSync(found.file) || !f.statSync(found.file).isFile()) {
    fail("NOT_FOUND", "随包技能包不是可读文件：" + found.file);
  }
  return found;
}

/** 读取随包技能包字节（只读、不落盘、不执行包内文件）。 */
function readBundledSkillPackage(name) {
  const found = resolveBundledSkillPackage(name);
  return resolveFs().readFileSync(found.file);
}

/**
 * 导入随包技能包到本地 skill-packs 目录（`<userData>/dxos/skill-packs`）。
 * 只做"读出 ZIP → 现有 importSkillPack 落盘/登记"；不联网、不执行包内文件。
 * 需要注入 userDataDir / dataDir / paths（与其它 skill-pack 命令一致）。
 */
function importBundledSkillPack(name) {
  const found = resolveBundledSkillPackage(name);
  const buffer = resolveFs().readFileSync(found.file);
  // 随包导入必须先确认是可用的技能包：空包 / 没有 SKILL.md 的一律结构化拒绝，不落半个包。
  const files = readZip(buffer);
  if (!files.length) fail("EMPTY_PACKAGE", "随包技能包为空：" + found.name);
  if (!files.some((entry) => /(^|\/)SKILL\.md$/i.test(entry.name))) fail("NO_SKILL_FOUND", "随包技能包内没有 SKILL.md：" + found.name);
  return { ...importSkillPack(buffer, found.name), bundledPath: found.file };
}

function commonTopLevel(files) {
  const first = files.length && files[0] ? files[0].name.split("/")[0] : undefined;
  return first && files.length && files.every((file) => file.name.startsWith(first + "/")) ? first + "/" : "";
}

// ══════════════════════════════════════════════════════════════════════
// 源 skillPacks.ts:288-331：列表与导入
// ══════════════════════════════════════════════════════════════════════
function listSkillPacks() {
  return loadIndex().map((pack) => ({
    ...pack,
    name: decodeUploadName(pack.name),
    sourceName: decodeUploadName(pack.sourceName),
    skillDocs: listPackSkillDocs(pack.id),
  }));
}

function importSkillPack(buffer, sourceName) {
  const files = readZip(buffer);
  if (!files.length) fail("EMPTY_PACKAGE", "压缩包为空");
  const id = deps.idFactory();
  const root = sourceRoot(id);
  const prefix = commonTopLevel(files);
  resolveFs().mkdirSync(root, { recursive: true });
  try {
    for (const file of files) {
      const target = path.resolve(root, file.name.slice(prefix.length));
      if (!target.startsWith(root + path.sep)) fail("UNSAFE_PATH", "检测到越界写入");
      resolveFs().mkdirSync(path.dirname(target), { recursive: true });
      resolveFs().writeFileSync(target, file.data);
    }
  } catch (error) {
    resolveFs().rmSync(packageRoot(id), { recursive: true, force: true });
    throw error;
  }
  const entryPoints = files
    .map((file) => file.name.slice(prefix.length))
    .filter((entryPath) => /\.py$/i.test(entryPath))
    .map((entryPath, index) => ({ id: "python_" + (index + 1), runtime: "python", path: entryPath }));
  const skillCount = files.filter((file) => /(^|\/)SKILL\.md$/i.test(file.name)).length;
  const decodedSourceName = decodeUploadName(sourceName);
  const name = decodedSourceName.replace(/\.zip$/i, "").replace(/[-_]+/g, " ").trim() || "未命名 Skill 包";
  const pack = { id, name, sourceName: decodedSourceName, importedAt: deps.clock(), skillCount, entryPoints };
  saveIndex([...loadIndex(), pack]);
  return pack;
}

// ══════════════════════════════════════════════════════════════════════
// 源 skillPacks.ts:334-346：在线安装器环境（纯函数）
// ══════════════════════════════════════════════════════════════════════
function onlineInstallerEnvironment(base = process.env) {
  const environment = { ...base };
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") || "PATH";
  const separator = process.platform === "win32" ? ";" : ":";
  const runtimeDirectory = path.dirname(process.execPath);
  const currentPath = String(environment[pathKey] || "");
  const entries = currentPath.split(separator).filter(Boolean);
  if (!entries.some((entry) => path.resolve(entry).toLowerCase() === path.resolve(runtimeDirectory).toLowerCase())) {
    entries.unshift(runtimeDirectory);
  }
  environment[pathKey] = entries.join(separator);
  return environment;
}

// ══════════════════════════════════════════════════════════════════════
// 本机子进程执行器（可注入；未注入即依赖缺失）
// ══════════════════════════════════════════════════════════════════════
function spawnCollect(command, args, options, timeoutMs) {
  const runner = deps.runner;
  if (!runner || (typeof runner.spawn !== "function" && typeof runner.run !== "function")) {
    throw dependencyUnavailable("runner", "本机子进程执行未注入：在线安装与 docker 沙箱执行属 OUT 能力");
  }
  if (typeof runner.run === "function") {
    return Promise.resolve(runner.run({ command, args, cwd: options.cwd, timeoutMs, env: options.env }))
      .then((result) => ({
        code: result && result.code != null ? result.code : 0,
        output: String((result && result.output) || ""),
      }));
  }
  return new Promise((resolveRun, rejectRun) => {
    const child = runner.spawn(command, args, options);
    let output = "";
    const append = (chunk) => { if (output.length < 48_000) output += chunk.toString("utf8"); };
    if (child.stdout) child.stdout.on("data", append);
    if (child.stderr) child.stderr.on("data", append);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); rejectRun(error); });
    child.once("close", (code) => { clearTimeout(timer); resolveRun({ code: code == null ? 1 : code, output: output.trim() }); });
  });
}

function runOnlineInstaller(command, args, cwd, timeoutMs = 240_000) {
  return spawnCollect(command, args, { cwd, windowsHide: true, shell: false, env: onlineInstallerEnvironment() }, timeoutMs)
    .then((result) => {
      if (result.code === 0) return result.output.trim();
      throw createDxosError(DXOS_ERR_CHILD_FAILED, result.output.trim() || "在线安装器退出码：" + (result.code == null ? 1 : result.code));
    });
}

function containsSkillDoc(root) {
  const f = resolveFs();
  if (!f.existsSync(root)) return false;
  for (const entry of f.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory() && containsSkillDoc(target)) return true;
    if (entry.isFile() && /^SKILL\.md$/i.test(entry.name)) return true;
  }
  return false;
}

function collectOnlineEntries(root) {
  const f = resolveFs();
  const entries = [];
  const walk = (folder, relative) => {
    for (const entry of f.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === "node_modules" || entry.name === ".git") continue;
      const absolute = path.join(folder, entry.name);
      const relPath = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isDirectory()) walk(absolute, relPath);
      else if (entry.isFile()) {
        if (f.statSync(absolute).size > MAX_FILE_BYTES) fail("ENTRY_TOO_LARGE", "文件过大：" + relPath);
        entries.push({ name: relPath.replace(/\\/g, "/"), data: f.readFileSync(absolute) });
      }
    }
  };
  walk(root, "");
  return entries;
}

// ══════════════════════════════════════════════════════════════════════
// 源 skillPacks.ts:397-435：路由注册与迁移
// ══════════════════════════════════════════════════════════════════════
function registerSkillPackRoutes(pack, buffer) {
  if (!pack.skillCount) return [];
  const archive = buffer || skillImport.buildZip(collectOnlineEntries(sourceRoot(pack.id)));
  const idPrefix = "pack_" + pack.id.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 10);
  return skillImport.importSkillPackage(archive, { idPrefix, packId: pack.id, packName: pack.name }).skills;
}

function importRegisteredSkillPack(buffer, sourceName, options = {}) {
  const pack = importSkillPack(buffer, sourceName);
  try {
    const registered = registerSkillPackRoutes(pack, buffer);
    if (options.enabled === false) {
      const store = resolveSkillStore();
      for (const skill of registered) store.setSkillEnabled(skill.id, false);
    }
    const workspace = registerAgentWorkspace(pack, sourceRoot(pack.id));
    if (workspace) Object.assign(pack, workspace);
    else pack.kind = "skill-collection";
    const packs = loadIndex();
    const index = packs.findIndex((item) => item.id === pack.id);
    if (index >= 0) packs[index] = pack;
    saveIndex(packs);
    const skills = requireSkillStoreMethod("listSkills")().filter((skill) => skill.source && skill.source.metadata && skill.source.metadata.packId === pack.id);
    return { pack, skills, workspace };
  } catch (error) {
    // 回滚只做本层能保证的清理；Agent Profile / 技能存储未注入时不覆盖原始异常（硬约束 3）。
    try { deleteAgentWorkspaceProfilesForPack(pack.id); } catch { /* 保留原始异常 */ }
    try {
      resolveFs().rmSync(packageRoot(pack.id), { recursive: true, force: true });
      saveIndex(loadIndex().filter((item) => item.id !== pack.id));
      const store = resolveSkillStore();
      if (store && typeof store.deleteCustomSkillsForPack === "function") store.deleteCustomSkillsForPack(pack.id);
    } catch { /* 保留原始异常 */ }
    throw error;
  }
}

/** 源 :424-435：启动迁移，为旧版本已导入的完整包补齐 Agent 路由 Skill。 */
function syncSkillPackRoutes() {
  let registered = 0;
  const packs = loadIndex();
  for (const pack of packs) {
    if (!resolveFs().existsSync(sourceRoot(pack.id))) continue;
    if (pack.skillCount) registered += registerSkillPackRoutes(pack).length;
    const workspace = registerAgentWorkspace(pack, sourceRoot(pack.id));
    if (workspace) Object.assign(pack, workspace);
    else pack.kind || (pack.kind = "skill-collection");
  }
  saveIndex(packs);
  return registered;
}

/**
 * 源 :439-474：一键在线导入。源会 spawn npx 联网下载。
 * 这里不发起任何网络请求：必须注入 runner 才会走到子进程；否则结构化依赖缺失。
 */
async function importOnlineSkillPack(text) {
  const source = parseOnlineSkillSource(text);
  const runner = deps.runner;
  if (!runner || (typeof runner.spawn !== "function" && typeof runner.run !== "function")) {
    throw dependencyUnavailable("runner.onlineInstaller", "在线导入（ModelScope）属 OUT 能力，未注入本机安装器");
  }
  const f = resolveFs();
  const workspace = f.mkdtempSync(path.join(os.tmpdir(), "dx-os-skill-"));
  try {
    f.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ private: true }), "utf8");
    const skillArgs = [
      "-y", "skills", "add", source.sourceUrl,
      "--agent", "codex", "--skill", "*", "-y", "--copy", "--full-depth",
    ];
    // 源在 Windows 上探测随包 npx-cli.js；本仓不携带 npm 运行时，统一交给注入 runner 决定。
    const executable = process.platform === "win32" ? process.execPath : "npx";
    await runOnlineInstaller(executable, skillArgs, workspace);

    const roots = [
      path.join(workspace, ".agents", "skills"),
      path.join(workspace, ".codex", "skills"),
      path.join(workspace, ".claude", "skills"),
      path.join(workspace, ".cursor", "skills"),
    ];
    const installedRoot = roots.find(containsSkillDoc) || (containsSkillDoc(workspace) ? workspace : "");
    if (!installedRoot) fail("NO_SKILL_FOUND", "安装完成，但没有发现 SKILL.md");
    const entries = collectOnlineEntries(installedRoot);
    if (!entries.some((entry) => /(^|\/)SKILL\.md$/i.test(entry.name))) fail("NO_SKILL_FOUND", "安装结果中没有 SKILL.md");
    const archive = skillImport.buildZip(entries);
    const { pack, skills } = importRegisteredSkillPack(archive, source.name + ".zip");
    return { pack, source, skills };
  } finally {
    try { f.rmSync(workspace, { recursive: true, force: true }); } catch { /* 清理失败不回滚结果 */ }
  }
}

// ══════════════════════════════════════════════════════════════════════
// 源 skillPacks.ts:476-498：卸载与重命名
// ══════════════════════════════════════════════════════════════════════
function deleteSkillPack(id) {
  const packs = loadIndex();
  const pack = packs.find((item) => item.id === id);
  if (!pack) return false;
  deleteAgentWorkspaceProfiles(pack.agentProfileIds);
  deleteAgentWorkspaceProfilesForPack(pack.id);
  resolveFs().rmSync(packageRoot(id), { recursive: true, force: true });
  saveIndex(packs.filter((item) => item.id !== id));
  requireSkillStoreMethod("deleteCustomSkillsForPack")(id);
  return true;
}

function renameSkillPack(id, name) {
  const packs = loadIndex();
  const pack = packs.find((item) => item.id === id);
  if (!pack) fail("NOT_FOUND", "Skill 包不存在");
  const nextName = String(name || "").trim();
  if (!nextName) fail("EMPTY_NAME", "名称不能为空");
  pack.name = nextName.slice(0, 80);
  saveIndex(packs);
  return pack;
}

// ══════════════════════════════════════════════════════════════════════
// 源 skillPacks.ts:500-530：用当前 LLM 一次性翻译包名及包内 Skill 显示名称
// ══════════════════════════════════════════════════════════════════════
async function translateSkillPackDisplay(id) {
  const pack = getPack(id);
  const listSkills = requireSkillStoreMethod("listSkills");
  const updateCustomSkillDisplay = requireSkillStoreMethod("updateCustomSkillDisplay");
  const skills = listSkills().filter((skill) => skill.source && skill.source.metadata && skill.source.metadata.packId === id);
  if (!skills.length) fail("NO_SKILLS", "包内没有可翻译的 Skill");
  const { provider, model } = requireSkillStoreMethod("resolveChatTarget")({});
  const payload = {
    packName: pack.name,
    skills: skills.map((skill) => ({ id: skill.id, name: skill.name, description: String(skill.description || "").slice(0, 500) })),
  };
  const result = await invokeChat(provider, model, {
    system: "你是软件界面本地化翻译器。把包名、Skill 名称和简介翻译成简体中文；保留 MiniMax、H3、API、JSAPI、POI、Python 等产品名和技术缩写。只返回严格 JSON，不要 Markdown。JSON 结构必须与输入一致，id 原样保留。",
    prompt: JSON.stringify(payload),
  }, {}, 120_000);
  const text = String(result.text || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) fail("BAD_TRANSLATION", "翻译模型未返回有效 JSON");
  let parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { fail("BAD_TRANSLATION", "翻译结果解析失败"); }
  if (typeof parsed.packName === "string" && parsed.packName.trim()) renameSkillPack(id, parsed.packName);
  const allowedIds = new Set(skills.map((skill) => skill.id));
  for (const item of Array.isArray(parsed.skills) ? parsed.skills : []) {
    const skillId = String(item.id || "");
    if (!allowedIds.has(skillId) || typeof item.name !== "string") continue;
    updateCustomSkillDisplay(skillId, item.name, typeof item.description === "string" ? item.description : undefined);
  }
  return {
    pack: getPack(id),
    skills: listSkills().filter((skill) => skill.source && skill.source.metadata && skill.source.metadata.packId === id),
    model,
  };
}

function getPack(id) {
  const pack = loadIndex().find((item) => item.id === id);
  if (!pack) fail("NOT_FOUND", "Skill 包不存在");
  return pack;
}

// ══════════════════════════════════════════════════════════════════════
// 源 skillPacks.ts:552-585：docker 沙箱运行（本批 OUT，仅注入 runner 才可用）
// ══════════════════════════════════════════════════════════════════════
function dockerRun(args, timeoutMs = 120_000) {
  return spawnCollect("docker", args, { windowsHide: true }, timeoutMs);
}

async function runSkillPack(id, entryPointId, args) {
  const pack = getPack(id);
  const entry = (pack.entryPoints || []).find((item) => item.id === entryPointId);
  if (!entry) fail("NO_ENTRY_POINT", "未找到可运行入口");
  const f = resolveFs();
  const source = sourceRoot(id);
  const runId = deps.idFactory();
  const workspace = path.join(DEFAULT_RUN_DIR, id, runId);
  f.mkdirSync(path.dirname(workspace), { recursive: true });
  f.cpSync(source, workspace, { recursive: true, dereference: false });
  const sourcePath = path.resolve(workspace, entry.path);
  if (!sourcePath.startsWith(workspace + path.sep) || !f.existsSync(sourcePath)) fail("NO_ENTRY_POINT", "入口文件不存在");
  const cleanArgs = args.map(String).filter((arg) => arg.length <= 500 && !arg.includes("\u0000")).slice(0, 32);
  const result = await dockerRun([
    "run", "--rm", "--network", "none", "--read-only", "--pids-limit", "64", "--memory", "512m", "--cpus", "1",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "-v", workspace + ":/workspace:rw", "--workdir", "/workspace", "--entrypoint", "python", SANDBOX_IMAGE,
    entry.path, ...cleanArgs,
  ]);
  return { runId, exitCode: result.code, output: result.output, workspace: "runs/" + runId };
}

const helpCache = new Map();

async function entryPointHelp(id, entryPointId) {
  const key = id + ":" + entryPointId;
  const cached = helpCache.get(key);
  if (cached) return cached;
  const result = await runSkillPack(id, entryPointId, ["--help"]);
  const help = (result.output || "").slice(0, 8_000);
  if (help) helpCache.set(key, help);
  return help;
}

// ══════════════════════════════════════════════════════════════════════
// 源 skillPacks.ts:587-664：包内文档与测试上下文
// ══════════════════════════════════════════════════════════════════════
function listPackSkillDocs(id) {
  const pack = getPack(id);
  const f = resolveFs();
  const root = sourceRoot(pack.id);
  const docs = [];
  const walk = (dir, rel) => {
    for (const entry of f.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const relPath = rel ? rel + "/" + entry.name : entry.name;
      if (entry.isDirectory()) walk(abs, relPath);
      else if (/^SKILL\.md$/i.test(entry.name)) {
        const text = f.readFileSync(abs, "utf8");
        const description = text.match(/(?:^|\n)description:\s*([^\r\n]+)/i);
        docs.push({
          path: relPath,
          preview: (description && description[1] ? description[1].trim().replace(/^['"]|['"]$/g, "") : "").slice(0, 120) || relPath,
        });
      }
    }
  };
  walk(root, "");
  return docs.slice(0, 24);
}

function readPackSkillDoc(id, docPath) {
  const pack = getPack(id);
  const f = resolveFs();
  const root = sourceRoot(pack.id);
  const target = path.resolve(root, String(docPath).replace(/\\/g, "/"));
  if (!target.startsWith(root + path.sep) || !/SKILL\.md$/i.test(target) || !f.existsSync(target)) fail("NOT_FOUND", "文档不存在");
  return f.readFileSync(target, "utf8");
}

/** 源 skillPacks.ts:615-655：为无代码 Skill 的 AI 测试构造完整上下文。 */
function buildPackSkillContext(root, docPath) {
  const f = resolveFs();
  const normalized = String(docPath).replace(/\\/g, "/");
  const target = path.resolve(root, normalized);
  const last = target.split(/[\\/]/).at(-1) || "";
  if (!target.startsWith(root + path.sep) || !/^SKILL\.md$/i.test(last) || !f.existsSync(target)) fail("NOT_FOUND", "文档不存在");
  const skillText = f.readFileSync(target, "utf8");
  const dir = path.dirname(target);
  const mentioned = new Set(
    [...skillText.matchAll(/(?:references|assets)\/[A-Za-z0-9._/-]+/g)].map((match) => match[0].replace(/[),.;:'"\u0060]+$/, "")),
  );
  const resources = [];
  const walk = (folder) => {
    for (const entry of f.readdirSync(folder, { withFileTypes: true })) {
      const abs = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (abs !== target && /\.(md|txt|ya?ml|json)$/i.test(entry.name)) {
        const relative = abs.slice(dir.length + 1).replace(/\\/g, "/");
        resources.push({ path: relative, content: f.readFileSync(abs, "utf8") });
      }
    }
  };
  walk(dir);
  resources.sort((a, b) => Number(mentioned.has(b.path)) - Number(mentioned.has(a.path)) || a.path.localeCompare(b.path));
  let used = skillText.length;
  const included = [];
  for (const resource of resources) {
    if (used + resource.content.length > 64_000) continue;
    included.push(resource);
    used += resource.content.length;
  }
  return {
    sourcePath: normalized,
    instructions: skillText,
    resources: included,
    context: [
      skillText,
      ...included.map((resource) => "\n\n===== Skill resource: " + resource.path + " =====\n" + resource.content),
    ].join(""),
  };
}

function readPackSkillContext(id, docPath) {
  const pack = getPack(id);
  const docs = listPackSkillDocs(id);
  const selected = docPath || (docs.length === 1 ? docs[0].path : "");
  if (!selected) fail("NO_SKILL_DOC", docs.length ? "请选择要测试的 Skill" : "包内没有 SKILL.md");
  if (!docs.some((doc) => doc.path === selected)) fail("NOT_FOUND", "文档不存在");
  return buildPackSkillContext(sourceRoot(pack.id), selected);
}

module.exports = {
  // 依赖与配置
  AGENT_DEPENDENCY_UNAVAILABLE,
  configureSkillPack,
  resetSkillPackForTests,
  skillPackDeps,
  // 常量（测试与后续波次复用）
  MAX_PACKAGE_BYTES,
  MAX_UNPACKED_BYTES,
  MAX_FILE_BYTES,
  SANDBOX_IMAGE,
  DEFAULT_BUNDLED_SPECS,
  // 路径
  skillPacksDir,
  indexFile,
  bundledStateFile,
  bundledPackageDir,
  bundledPackageDirs,
  packageRoot,
  sourceRoot,
  // 解析
  parseOnlineSkillSource,
  safePath,
  readZipEntries: readZip,
  onlineInstallerEnvironment,
  // bundled
  ensureBundledSkillPacks,
  listBundledSkillPackages,
  resolveBundledSkillPackage,
  readBundledSkillPackage,
  importBundledSkillPack,
  loadBundledState,
  saveBundledState,
  // 包生命周期
  listSkillPacks,
  importSkillPack,
  registerSkillPackRoutes,
  importRegisteredSkillPack,
  syncSkillPackRoutes,
  importOnlineSkillPack,
  deleteSkillPack,
  renameSkillPack,
  translateSkillPackDisplay,
  runSkillPack,
  entryPointHelp,
  listPackSkillDocs,
  readPackSkillDoc,
  buildPackSkillContext,
  readPackSkillContext,
  getPack,
};
