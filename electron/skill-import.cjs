"use strict";
/**
 * B4b · 技能包 ZIP 解析与导入（源 server/skillImport.ts:1-248 + server/zip.ts:1-80）。
 *
 * 移植映射（逐函数对照源行号）：
 *   · crc32 / buildZip             ← zip.ts:5-80        （store 打包；本文件额外支持可选 Deflate）
 *   · readSkillTexts               ← skillImport.ts:27-72
 *   · unquoteYaml                  ← skillImport.ts:74-80
 *   · parseSkillFrontmatter        ← skillImport.ts:82-100
 *   · openAiMetadata               ← skillImport.ts:102-110
 *   · sourceFiles                  ← skillImport.ts:112-130
 *   · cleanName / summary / slug   ← skillImport.ts:132-151
 *   · previewSkillPackage          ← skillImport.ts:153-176
 *   · importSkillPackage           ← skillImport.ts:178-214
 *   · skillDocumentFromPackage     ← skillImport.ts:216-248
 *
 * 依赖处置（硬约束：不新增第三方依赖 / 不联网 / 不执行包内文件）：
 *   · skillImport.ts:2 只 import saveCustomSkill 与 SkillDef/SkillSourceSnapshot（技能存储）。
 *     存储属 B4a electron/skill-store.cjs（并行波次产出），这里只经注入适配器调用；
 *     未注入时抛结构化 AGENT_DEPENDENCY_UNAVAILABLE，不自己实现 skills 存储（冻结契约）。
 *   · skillImport.ts 与 zip.ts 均未 import dxosProtocol / apiQuota / cloudEntitlement：
 *     本批无云端 AI 任务、无计费、无权益门禁代码需要移除或改注入。
 *   · ZIP 解压只用 node:zlib.inflateRawSync：纯内存、不落盘、不执行包内任何文件。
 *   · 源 fail() 抛裸 Error；这里统一改抛结构化 DxosError（code + kind + reason），
 *     供 IPC 出口用 normalizeError 判别（dxos-foundation-errors.cjs:74-88）。
 */
const { inflateRawSync, deflateRawSync, constants: zlibConstants } = require("node:zlib");
const {
  createDxosError,
  DXOS_ERR_INVALID_INPUT,
} = require("./dxos-foundation-errors.cjs");

/** 源 skillImport.ts:4-7 的上限常量，原样保留。 */
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 48 * 1024 * 1024;
const MAX_TEXT_ENTRY_BYTES = 384 * 1024;
const MAX_SOURCE_TEXT_BYTES = 2 * 1024 * 1024;

/** 结构化依赖缺失码：与 agent-runtime-deps.cjs:17 同一约定，后续波次据此判定"未接入"。 */
const AGENT_DEPENDENCY_UNAVAILABLE = "AGENT_DEPENDENCY_UNAVAILABLE";

/** 技能导入失败：结构化错误（kind/reason 便于 IPC 出口与测试稳定断言）。 */
function fail(reason, message) {
  const err = createDxosError(DXOS_ERR_INVALID_INPUT, "Skill 导入失败：" + message);
  err.kind = "SKILL_IMPORT_FAILED";
  err.reason = reason;
  throw err;
}

function dependencyUnavailable(name, detail) {
  const err = new Error("技能导入依赖不可用：" + String(name));
  err.name = "AgentDependencyUnavailableError";
  err.code = AGENT_DEPENDENCY_UNAVAILABLE;
  err.dependency = String(name);
  if (detail !== undefined) err.detail = detail;
  return err;
}

// ══════════════════════════════════════════════════════════════════════
// 注入中心（源 skillImport.ts 直接 import saveCustomSkill，这里改成显式注入）
// ══════════════════════════════════════════════════════════════════════
let deps = { skillStore: null };

/** 注入技能存储（B4a electron/skill-store.cjs 导出集合，或测试桩）。 */
function configureSkillImport(patch = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw dependencyUnavailable("configureSkillImport", "配置必须是对象");
  }
  if (patch.skillStore !== undefined) deps = { ...deps, skillStore: patch.skillStore };
  return { ...deps };
}

/** 仅供测试：清空注入，恢复"未接入"状态。 */
function resetSkillImportForTests() {
  deps = { skillStore: null };
  return { ...deps };
}

function getInjectedSkillStore() {
  return deps.skillStore;
}

/**
 * 解析技能存储：显式注入优先，其次惰性 require ./skill-store.cjs。
 * 只在"模块确实不存在"时降级为 AGENT_DEPENDENCY_UNAVAILABLE；模块自身抛错照常透出。
 */
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

// ══════════════════════════════════════════════════════════════════════
// zip.ts：CRC32 与最简 ZIP 打包
// ══════════════════════════════════════════════════════════════════════
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 源 zip.ts:25-80 buildZip：默认 store（无压缩），与源完全一致。
 * 追加 options.compress=true 时改用 Deflate（method 8），让 inflateRawSync 能对称解回；
 * 源调用方不传 options，行为不变。
 */
function buildZip(entries, options = {}) {
  const compress = options && options.compress === true;
  const local = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const crc = crc32(raw);
    const useDeflate = compress && raw.length > 0;
    const payload = useDeflate ? deflateRawSync(raw, { level: zlibConstants.Z_DEFAULT_COMPRESSION }) : raw;
    const method = useDeflate ? 8 : 0;
    const size = payload.length;
    const uncompressed = raw.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // flag: 文件名 UTF-8
    lh.writeUInt16LE(method, 8); // method: store / deflate
    lh.writeUInt16LE(0, 10); // mod time
    lh.writeUInt16LE(0, 12); // mod date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(size, 18); // compressed
    lh.writeUInt32LE(uncompressed, 22); // uncompressed
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28); // extra len
    local.push(lh, nameBuf, payload);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0x0800, 8); // flag UTF-8
    ch.writeUInt16LE(method, 10); // method
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(size, 20);
    ch.writeUInt32LE(uncompressed, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); // extra
    ch.writeUInt16LE(0, 32); // comment
    ch.writeUInt16LE(0, 34); // disk
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42); // local header offset
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + size;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...local, centralBuf, eocd]);
}

// ══════════════════════════════════════════════════════════════════════
// skillImport.ts：只读取标准 Skill 的文本资料
// ══════════════════════════════════════════════════════════════════════
function u16(buf, offset) { return buf.readUInt16LE(offset); }
function u32(buf, offset) { return buf.readUInt32LE(offset); }

/** 源 skillImport.ts:27-72：不把压缩包写入磁盘，也不执行其中任何文件。 */
function readSkillTexts(buffer) {
  if (buffer.length > MAX_PACKAGE_BYTES) fail("PACKAGE_TOO_LARGE", "压缩包不能超过 32 MB");
  const searchFrom = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= searchFrom; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) fail("INVALID_ZIP", "不是有效的 ZIP 文件");
  const entryCount = u16(buffer, eocd + 10);
  const centralOffset = u32(buffer, eocd + 16);
  if (!entryCount || entryCount > 512 || centralOffset >= buffer.length) fail("INVALID_ZIP", "压缩包目录无效");

  const entries = new Map();
  let totalUncompressed = 0;
  let pos = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    if (pos + 46 > buffer.length || u32(buffer, pos) !== 0x02014b50) fail("INVALID_ZIP", "压缩包目录损坏");
    const compression = u16(buffer, pos + 10);
    const compressedSize = u32(buffer, pos + 20);
    const uncompressedSize = u32(buffer, pos + 24);
    const filenameSize = u16(buffer, pos + 28);
    const extraSize = u16(buffer, pos + 30);
    const commentSize = u16(buffer, pos + 32);
    const localOffset = u32(buffer, pos + 42);
    const end = pos + 46 + filenameSize + extraSize + commentSize;
    if (end > buffer.length) fail("INVALID_ZIP", "压缩包目录不完整");
    const name = buffer.subarray(pos + 46, pos + 46 + filenameSize).toString("utf8").replace(/\\/g, "/");
    pos = end;
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) fail("PACKAGE_TOO_LARGE", "解压总内容超出限制");
    const isRootManifest = name === "skill.json";
    const isSkillText = /\.(md|txt|ya?ml|json)$/i.test(name);
    if (!isRootManifest && !isSkillText) continue;
    if (uncompressedSize > MAX_TEXT_ENTRY_BYTES || compressedSize > MAX_TEXT_ENTRY_BYTES) fail("ENTRY_TOO_LARGE", "说明文件过大：" + name);
    if (localOffset + 30 > buffer.length || u32(buffer, localOffset) !== 0x04034b50) fail("INVALID_ZIP", "文件头损坏：" + name);
    const localNameSize = u16(buffer, localOffset + 26);
    const localExtraSize = u16(buffer, localOffset + 28);
    const dataStart = localOffset + 30 + localNameSize + localExtraSize;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) fail("INVALID_ZIP", "文件内容不完整：" + name);
    const raw = buffer.subarray(dataStart, dataEnd);
    const content = compression === 0
      ? raw
      : compression === 8
        ? inflateRawSync(raw, { maxOutputLength: MAX_TEXT_ENTRY_BYTES })
        : fail("UNSUPPORTED_COMPRESSION", "只支持标准 ZIP 的存储或 Deflate 压缩");
    entries.set(name, content.toString("utf8"));
  }
  return entries;
}

/** 源 skillImport.ts:74-80。 */
function unquoteYaml(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
  return trimmed;
}

/** 源 skillImport.ts:82-100：Agent Skills 只强制 name/description 的 YAML 子集解析。 */
function parseSkillFrontmatter(markdown) {
  const match = markdown.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return { metadata: {}, body: markdown };
  const lines = match[1].split(/\r?\n/);
  const metadata = {};
  for (let i = 0; i < lines.length; i++) {
    const field = lines[i].match(/^(name|description):[ \t]*(.*)$/);
    if (!field) continue;
    const key = field[1];
    const value = field[2].trim();
    if (value === "|" || value === ">") {
      const block = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) block.push(lines[++i].trim());
      metadata[key] = value === ">" ? block.join(" ") : block.join("\n");
    } else if (value) metadata[key] = unquoteYaml(value);
  }
  return { metadata, body: markdown.slice(match[0].length) };
}

/** 源 skillImport.ts:102-110。 */
function openAiMetadata(entries, skillDir) {
  const yaml = entries.get(skillDir + "agents/openai.yaml") || entries.get(skillDir + "agents/openai.yml") || "";
  const implicit = yaml.match(/(?:^|\n)\s*allow_implicit_invocation:\s*(true|false)\s*(?:#.*)?(?:\n|$)/i);
  const display = yaml.match(/(?:^|\n)\s*display_name:\s*([^\r\n#]+)/i);
  return {
    ...(implicit ? { allowImplicitInvocation: implicit[1].toLowerCase() === "true" } : {}),
    ...(display ? { displayName: unquoteYaml(display[1]) } : {}),
  };
}

/** 源 skillImport.ts:112-130。 */
function sourceFiles(entries, sourcePath) {
  const dir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/") + 1) : "";
  const instruction = entries.get(sourcePath) || "";
  const mentioned = new Set(
    [...instruction.matchAll(/(?:references|assets)\/[A-Za-z0-9._/-]+/g)].map((match) => match[0].replace(/[),.;:'"`]+$/, "")),
  );
  const candidates = [...entries.entries()]
    .filter(([path]) => path !== sourcePath && path.startsWith(dir))
    .map(([path, content]) => ({ path: path.slice(dir.length), content }))
    .sort((a, b) => Number(mentioned.has(b.path)) - Number(mentioned.has(a.path)) || a.path.localeCompare(b.path));
  const files = [];
  let bytes = 0;
  for (const file of candidates) {
    const size = Buffer.byteLength(file.content, "utf8");
    if (bytes + size > MAX_SOURCE_TEXT_BYTES) continue;
    files.push(file);
    bytes += size;
  }
  return files;
}

/** 源 skillImport.ts:132-135。 */
function cleanName(path) {
  const parts = path.split("/").filter(Boolean);
  const second = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  return (second ? second.replace(/[-_]+/g, " ").trim() : "") || "功能 Skill";
}

/** 源 skillImport.ts:136-146。 */
function summary(markdown, fallback, preferBodyTitle = false) {
  const parsed = parseSkillFrontmatter(markdown);
  const lines = parsed.body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstTitle = lines.find((line) => /^#\s+/.test(line))?.replace(/^#+\s*/, "").trim();
  const firstText = lines.find((line) => !/^#|^```|^[-*]\s|^>/.test(line) && line.length > 12);
  return {
    name: (preferBodyTitle ? firstTitle || parsed.metadata.name : parsed.metadata.name || firstTitle) || fallback,
    description: (parsed.metadata.description || firstText || fallback).slice(0, 180),
  };
}

/** 源 skillImport.ts:147-151。 */
function slug(sourcePath, index) {
  const parts = sourcePath.split("/").filter(Boolean);
  const base = (parts.length >= 2 ? parts[parts.length - 2] : undefined) || ("skill_" + (index + 1));
  const normalized = base.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(normalized) ? normalized.slice(0, 48) : "skill_" + (index + 1);
}

/** 源 skillImport.ts:153-176。 */
function previewSkillPackage(buffer) {
  const entries = readSkillTexts(buffer);
  const manifestText = entries.get("skill.json");
  if (manifestText && entries.has("SKILL.md")) {
    let manifest;
    try { manifest = JSON.parse(manifestText); } catch { fail("INVALID_MANIFEST", "skill.json 不是有效 JSON"); }
    if (manifest.format !== "ccs-skill/v1") fail("INVALID_MANIFEST", "不支持的 Skill 包格式");
    if (manifest.kind && manifest.kind !== "text") fail("UNSUPPORTED_KIND", "第一版只允许导入文本型功能 Skill");
    const systemPrompt = String(manifest.systemPrompt || "").trim();
    if (!systemPrompt) fail("INVALID_MANIFEST", "skill.json 缺少 systemPrompt");
    return [{
      id: String(manifest.id || ""),
      name: String(manifest.name || ""),
      description: String(manifest.description || ""),
      systemPrompt,
      sourcePath: "SKILL.md",
    }];
  }

  const skillFiles = [...entries.entries()].filter(([path]) => /(^|\/)SKILL\.md$/i.test(path));
  if (!skillFiles.length) fail("NO_SKILL_FOUND", "未找到可导入的 SKILL.md；标准包需包含 skill.json 和 SKILL.md");
  return skillFiles.slice(0, 24).map(([sourcePath, markdown], index) => {
    const localizedPath = sourcePath.replace(/SKILL\.md$/i, "SKILL.cn.md");
    const localized = entries.get(localizedPath);
    const info = localized
      ? summary(localized, cleanName(sourcePath), true)
      : summary(markdown, cleanName(sourcePath));
    return { id: slug(sourcePath, index), name: info.name, description: info.description, systemPrompt: markdown, sourcePath };
  });
}

/** 源 skillImport.ts:178-214。 */
function importSkillPackage(buffer, options = {}) {
  const candidates = previewSkillPackage(buffer);
  if (!candidates.length) fail("NO_SKILL_FOUND", "压缩包内没有可导入的 Skill");
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) fail("DUPLICATE_ID", "多个 Skill 生成了相同 ID：" + candidate.id);
    seen.add(candidate.id);
  }
  const skillStore = resolveSkillStore();
  if (!skillStore || typeof skillStore.saveCustomSkill !== "function") {
    throw dependencyUnavailable("skillStore.saveCustomSkill");
  }
  const skills = candidates.map((candidate) => {
    const doc = skillDocumentFromPackage(buffer, candidate.sourcePath);
    const id = options.idPrefix ? (options.idPrefix + "_" + candidate.id).slice(0, 64) : candidate.id;
    return skillStore.saveCustomSkill({
      ...candidate,
      id,
      // 完整包路由同时注入同目录 references，让被 AI 选中后能按原始资料执行（源 :205-206）。
      ...(options.packId ? { systemPrompt: doc.markdown.slice(0, 64_000) } : {}),
      source: {
        ...doc.source,
        metadata: {
          ...doc.source.metadata,
          ...(options.packId ? { packId: options.packId } : {}),
          ...(options.packName ? { packName: options.packName } : {}),
        },
      },
      ...(typeof doc.allowImplicitInvocation === "boolean"
        ? { allowImplicitInvocation: doc.allowImplicitInvocation }
        : {}),
    });
  });
  return {
    skills,
    ...(skills.length === 1 ? { skill: skills[0], readme: candidates[0].systemPrompt } : {}),
  };
}

/** 源 skillImport.ts:216-248：取包内指定（或唯一）SKILL.md，并带上同目录参考文档。 */
function skillDocumentFromPackage(buffer, sourcePath) {
  const candidates = previewSkillPackage(buffer);
  const chosen = sourcePath
    ? candidates.find((c) => c.sourcePath === sourcePath)
    : candidates.length === 1 ? candidates[0] : undefined;
  if (!chosen) fail("NO_SKILL_FOUND", candidates.length > 1 ? "包内有多个 Skill，请指定 sourcePath" : "未找到可解析的 SKILL.md");
  const entries = readSkillTexts(buffer);
  const dir = chosen.sourcePath.includes("/") ? chosen.sourcePath.slice(0, chosen.sourcePath.lastIndexOf("/") + 1) : "";
  const parsed = parseSkillFrontmatter(chosen.systemPrompt);
  const openai = openAiMetadata(entries, dir);
  const files = sourceFiles(entries, chosen.sourcePath);
  // 被 SKILL.md 点名的资料优先，保证大包截断时核心 references 仍进入分析上下文（源 :226）。
  const siblings = files
    .filter((file) => /\.(md|txt)$/i.test(file.path))
    .slice(0, 24)
    .map((file) => "\n\n===== 参考文件：" + file.path + " =====\n" + file.content)
    .join("");
  const source = {
    format: "agentskills/v1",
    sourcePath: chosen.sourcePath,
    instructions: chosen.systemPrompt,
    files,
    metadata: {
      ...parsed.metadata,
      ...(openai.displayName ? { displayName: openai.displayName } : {}),
    },
  };
  return {
    markdown: chosen.systemPrompt + siblings,
    sourcePath: chosen.sourcePath,
    fallback: chosen,
    source,
    allowImplicitInvocation: openai.allowImplicitInvocation,
  };
}

module.exports = {
  AGENT_DEPENDENCY_UNAVAILABLE,
  MAX_PACKAGE_BYTES,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  MAX_TEXT_ENTRY_BYTES,
  MAX_SOURCE_TEXT_BYTES,
  configureSkillImport,
  resetSkillImportForTests,
  getInjectedSkillStore,
  resolveSkillStore,
  dependencyUnavailable,
  crc32,
  buildZip,
  parseSkillFrontmatter,
  previewSkillPackage,
  importSkillPackage,
  skillDocumentFromPackage,
};
