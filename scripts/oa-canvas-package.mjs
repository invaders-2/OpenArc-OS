#!/usr/bin/env node
/**
 * OpenArc OS · 画布更新包 打包 + 签名 + 校验（本机与 GitHub Actions 同一条命令链）。
 *
 * 包格式 openarc-app/v1，两种形态共用同一签名与逐文件 sha256：
 *   · static-web（Stage 2 默认）：manifest 带 kind:"static-web"、entry:"static/canvas-list.html"，
 *     files 覆盖 --source 指向的整棵静态树（画布是多页静态树，不是 JS 模块应用）。
 *   · js-module（Stage 1 老格式，继续兼容）：manifest.entry:"index.js" + styles:["index.css"]。
 *
 * 三种模式：
 *   · 打包（默认）：--version <ver> [--kind static-web] --source <目录>
 *       node scripts/oa-canvas-package.mjs --kind static-web --source dist/novai-canvas --version 0.01
 *   · 只校验密钥配对（不打包；CI 在打包前单独跑）
 *       node scripts/oa-canvas-package.mjs --check-key --key-file <私钥> --keys-file resources/app-update-keys.json
 *   · 只校验既有产物（用仓库公钥验签 + 逐文件 sha256；不需要私钥）
 *       node scripts/oa-canvas-package.mjs --verify dist-updates/canvas-0.01.zip --keys-file resources/app-update-keys.json
 *
 * 版本：major.minor 或 major.minor.patch 都接受，允许前导零（发布常写 0.01）。
 * 显示串原样保留（manifest.version / 资产名 / tag 都用 "0.01"），比较按数值规范化（0.01 ≡ 0.1.0）。
 *
 * 默认**不再产出占位产物**：找不到真实源直接非零退出。--placeholder 是显式测试开关，
 * 且占位包 manifest 必带 placeholder:true —— 安装 / 加载一律拒绝，防止被当真产物发布。
 *
 * 打包产物：
 *   <out>/canvas-<version>.zip                          GitHub Release 资产（原名上传）
 *   <out>/updates/canvas/canvas-<version>.zip           ModelScope 仓库内的同路径资产
 *   <out>/updates/canvas/latest.json                    ModelScope 版本清单（asset/sha256/version/build）
 *
 * 退出码：2 参数错 / 3 源目录错 / 4 密钥或公钥文件不可用 / 5 签名或摘要校验失败。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { writeZip, readZip } = require(path.join(ROOT, "electron", "canvas-dxos-zip.cjs"));
const domain = require(path.join(ROOT, "electron", "market-update-domain.cjs"));

const args = process.argv.slice(2);
const valueOf = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
const hasFlag = (flag) => args.includes(flag);
const die = (code, message) => { console.error("[oa-canvas-package] " + message); process.exit(code); };
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

const keyPath = path.resolve(valueOf("--key-file") || path.join(ROOT, ".keys", "update-signing.key"));
const keysFile = path.resolve(valueOf("--keys-file") || path.join(ROOT, "resources", "app-update-keys.json"));
const keysFileExplicit = valueOf("--keys-file") != null;
const checkKeyOnly = hasFlag("--check-key");
const verifyArg = valueOf("--verify");

/** SPKI DER 的末 32 字节就是 Ed25519 raw public key。 */
function rawPublicKey(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  return der.subarray(der.length - 32);
}

/** 读仓库内置公钥（resources/app-update-keys.json 的 canvas 字段）。 */
function readExpectedPublicKey() {
  let json;
  try { json = JSON.parse(fs.readFileSync(keysFile, "utf8")); }
  catch { die(4, "读不到公钥文件：" + keysFile); }
  const value = json && typeof json.canvas === "string" ? json.canvas.trim() : "";
  if (!value) die(4, "公钥文件缺少 canvas 字段：" + keysFile);
  const key = domain.toPublicKey(value);
  if (!key) die(4, "公钥文件里的 canvas 不是合法 Ed25519 公钥：" + keysFile);
  return { value, key };
}

/**
 * 密钥指纹校验：从私钥导出公钥，与仓库公钥逐字节比对（只打印公钥 sha256 指纹，绝不打印私钥）。
 * 换密钥时必须同时更新 resources/app-update-keys.json 与 GitHub Secret，否则这里 fail。
 */
function loadPrivateKeyAndCheck() {
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, "utf8"));
  const derived = rawPublicKey(crypto.createPublicKey(privateKey));
  const expected = rawPublicKey(readExpectedPublicKey().key);
  if (!derived.equals(expected)) {
    die(5, "签名私钥与仓库公钥不配对（换密钥时必须同时更新 " + path.relative(ROOT, keysFile) + " 与 Secret）：\n"
      + "  私钥导出公钥指纹 = " + sha256(derived) + "\n"
      + "  仓库公钥指纹     = " + sha256(expected));
  }
  console.log("[oa-canvas-package] 密钥配对校验：OK（公钥 sha256 指纹 " + sha256(derived) + "）");
  return privateKey;
}

// ── 模式一：只校验既有产物（不需要私钥） ─────────────────────────────────────
function verifyPackage(file) {
  const zipPath = path.resolve(file);
  if (!fs.existsSync(zipPath)) die(3, "找不到待校验的 zip：" + zipPath);
  const zipBytes = fs.readFileSync(zipPath);
  let entries;
  try { entries = readZip(zipBytes, { maxEntries: 2000, maxEntryBytes: 16 * 1024 * 1024, maxTotalBytes: domain.MAX_PACKAGE_BYTES }); }
  catch (error) { die(5, "zip 无法读取：" + String((error && error.message) || error)); }
  const map = new Map(entries.map((entry) => [entry.name, entry.data]));
  const manifestBytes = map.get(domain.MANIFEST_NAME);
  const signatureBytes = map.get(domain.MANIFEST_SIGNATURE_NAME);
  if (!manifestBytes) die(5, "zip 缺 " + domain.MANIFEST_NAME);
  if (!signatureBytes) die(5, "zip 缺 " + domain.MANIFEST_SIGNATURE_NAME);

  const expected = readExpectedPublicKey();
  const verified = domain.verifyManifestSignature({
    manifestBytes,
    signatureBase64: signatureBytes.toString("utf8").trim(),
    publicKeyBase64: expected.value,
  });
  if (!verified.ok) die(5, "仓库公钥验签失败：" + verified.reason);

  let raw;
  try { raw = JSON.parse(manifestBytes.toString("utf8")); }
  catch { die(5, "manifest.json 不是合法 JSON"); }
  const normalized = domain.normalizeManifest(raw);
  if (!normalized.ok) die(5, "manifest 非法：" + normalized.error.message);
  const manifest = normalized.value;

  const bad = [];
  for (const [rel, hash] of Object.entries(manifest.files)) {
    const data = map.get(rel);
    if (!data || sha256(data) !== hash) bad.push(rel);
  }
  if (bad.length) die(5, "逐文件 sha256 校验失败 " + bad.length + " 个：\n  " + bad.slice(0, 10).join("\n  "));

  console.log("[oa-canvas-package] 校验模式 · 仓库公钥验签 + 逐文件 sha256：OK");
  console.log("[oa-canvas-package] 文件：" + zipPath);
  console.log("[oa-canvas-package] 形态：" + manifest.kind + " / 版本：" + manifest.version + " / build：" + manifest.build + " / entry：" + manifest.entry);
  console.log("[oa-canvas-package] 文件数：" + Object.keys(manifest.files).length + "（含 manifest.json + manifest.sig，zip 共 " + entries.length + " 条目）");
  console.log("[oa-canvas-package] zip 字节：" + zipBytes.length);
  console.log("[oa-canvas-package] zip sha256：" + sha256(zipBytes));
  console.log("[oa-canvas-package] manifest 原始字节 sha256：" + sha256(manifestBytes));
  console.log("[oa-canvas-package] 公钥 sha256 指纹：" + sha256(rawPublicKey(expected.key)));
}

if (verifyArg) { verifyPackage(verifyArg); process.exit(0); }

if (!fs.existsSync(keyPath)) die(4, "找不到签名私钥：" + keyPath + "\n请先跑：node scripts/oa-update-keygen.mjs");
if (checkKeyOnly) { loadPrivateKeyAndCheck(); process.exit(0); }

// ── 模式二：打包 + 签名 ───────────────────────────────────────────────────────
const versionRaw = valueOf("--version");
if (!versionRaw) die(2, "必须传 --version <semver>，例如 --version 0.01（或 --verify <zip> / --check-key）");
const parsedVersion = domain.parseSemver(versionRaw);
if (!parsedVersion) die(2, "--version 不是合法版本：" + versionRaw + "（支持 major.minor 或 major.minor.patch，允许前导零）");
const version = parsedVersion.version;
const name = valueOf("--name") || "无限画布";
const build = Number(valueOf("--build") || 1);
if (!Number.isSafeInteger(build) || build < 1) die(2, "--build 必须是不小于 1 的整数");
const notes = valueOf("--notes");
const publishedAt = valueOf("--published-at");
const outDir = path.resolve(valueOf("--out") || path.join(ROOT, "dist-updates"));
const sourceArg = valueOf("--source");
const placeholder = hasFlag("--placeholder");
const kindExplicit = valueOf("--kind");
// --placeholder 是显式的测试开关，缺省即老格式 js-module；显式 --kind static-web + --placeholder 才是错误用法。
const kindRaw = kindExplicit || (placeholder ? domain.MANIFEST_KIND_JS : domain.MANIFEST_KIND_STATIC_WEB);
if (kindRaw !== domain.MANIFEST_KIND_STATIC_WEB && kindRaw !== domain.MANIFEST_KIND_JS) {
  die(2, "--kind 只支持 " + domain.MANIFEST_KIND_STATIC_WEB + " 或 " + domain.MANIFEST_KIND_JS);
}
if (placeholder && sourceArg) die(2, "--placeholder 与 --source 不能同时使用");
if (placeholder && kindRaw !== domain.MANIFEST_KIND_JS) die(2, "--placeholder 只支持 js-module 占位形态");

// ── 源目录 ────────────────────────────────────────────────────────────────
function requireDirectory(dir, label) {
  let stat = null;
  try { stat = fs.statSync(dir); } catch { stat = null; }
  if (!stat || !stat.isDirectory()) die(3, label + " 不是目录：" + dir);
  return dir;
}

/** 递归收集静态树里的全部普通文件（POSIX 相对路径，排序保证可复现）。 */
function walkFiles(dir) {
  const out = [];
  const stack = [""];
  while (stack.length) {
    const relDir = stack.pop();
    const absDir = relDir ? path.join(dir, relDir) : dir;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const rel = relDir ? relDir + "/" + entry.name : entry.name;
      if (entry.isDirectory()) { stack.push(rel); continue; }
      if (!entry.isFile()) continue;
      if (rel === domain.MANIFEST_NAME || rel === domain.MANIFEST_SIGNATURE_NAME) continue;
      if (!domain.isSafeEntryName(rel)) die(3, "源目录含不安全相对路径：" + rel);
      out.push(rel);
    }
  }
  out.sort();
  return out;
}

function resolveBuiltinStaticRoot(entry) {
  for (const candidate of [path.join(ROOT, "dist", "novai-canvas"), path.join(ROOT, "public", "novai-canvas")]) {
    let stat = null;
    try { stat = fs.statSync(candidate); } catch { stat = null; }
    if (stat && stat.isDirectory() && fs.existsSync(path.join(candidate, entry))) return candidate;
  }
  return null;
}

// ── 组包 ──────────────────────────────────────────────────────────────────
let manifest;
let filesForZip;
let sourceLabel;
const entryRequested = valueOf("--entry");

if (placeholder) {
  const dir = path.join(outDir, ".canvas-placeholder");
  fs.mkdirSync(dir, { recursive: true });
  const jsBytes = Buffer.from("/* PLACEHOLDER · 仅供链路测试；manifest.placeholder=true，安装/加载一律拒绝。 */\nconsole.log('[openarc] canvas placeholder bundle " + version + "');\n");
  const cssBytes = Buffer.from("/* PLACEHOLDER · 仅供链路测试。 */\n.canvas-placeholder{display:none}\n");
  filesForZip = [
    { name: domain.CANVAS_ENTRY, data: jsBytes },
    { name: domain.CANVAS_STYLE, data: cssBytes },
  ];
  manifest = {
    format: domain.MANIFEST_FORMAT,
    id: domain.CANVAS_APP_ID,
    name,
    version,
    build,
    entry: domain.CANVAS_ENTRY,
    styles: [domain.CANVAS_STYLE],
    files: { [domain.CANVAS_ENTRY]: sha256(jsBytes), [domain.CANVAS_STYLE]: sha256(cssBytes) },
    placeholder: true,
  };
  sourceLabel = "占位产物（--placeholder，不可发布）";
} else if (kindRaw === domain.MANIFEST_KIND_STATIC_WEB) {
  const entry = (entryRequested || domain.CANVAS_STATIC_ENTRY).replace(/\\/g, "/");
  if (!domain.isSafeEntryName(entry) || !/\.html$/i.test(entry)) die(2, "--entry 必须是安全的相对 .html 路径：" + entry);
  const dir = sourceArg ? requireDirectory(path.resolve(sourceArg), "--source") : resolveBuiltinStaticRoot(entry);
  if (!dir) die(3, "找不到内置静态树（" + entry + "）；请显式 --source <目录>。默认不再产出占位产物。");
  const rels = walkFiles(dir);
  if (!rels.includes(entry)) die(3, "--source 目录不含 entry：" + entry + "（实际 " + rels.length + " 个文件）");
  const hashes = {};
  filesForZip = [];
  for (const rel of rels) {
    const data = fs.readFileSync(path.join(dir, rel));
    hashes[rel] = sha256(data);
    filesForZip.push({ name: rel, data });
  }
  manifest = {
    format: domain.MANIFEST_FORMAT,
    id: domain.CANVAS_APP_ID,
    name,
    version,
    build,
    kind: domain.MANIFEST_KIND_STATIC_WEB,
    entry,
    files: hashes,
  };
  sourceLabel = "static-web · " + dir;
} else {
  if (!sourceArg) die(3, "js-module 形态必须显式 --source <含 index.js/index.css 的目录>（默认不再产出占位产物）");
  const dir = requireDirectory(path.resolve(sourceArg), "--source");
  const jsPath = path.join(dir, "index.js");
  const cssPath = path.join(dir, "index.css");
  if (!fs.existsSync(jsPath) || !fs.existsSync(cssPath)) die(3, "--source 目录必须同时含 index.js 与 index.css：" + dir);
  const jsBytes = fs.readFileSync(jsPath);
  const cssBytes = fs.readFileSync(cssPath);
  filesForZip = [
    { name: domain.CANVAS_ENTRY, data: jsBytes },
    { name: domain.CANVAS_STYLE, data: cssBytes },
  ];
  manifest = {
    format: domain.MANIFEST_FORMAT,
    id: domain.CANVAS_APP_ID,
    name,
    version,
    build,
    entry: domain.CANVAS_ENTRY,
    styles: [domain.CANVAS_STYLE],
    files: { [domain.CANVAS_ENTRY]: sha256(jsBytes), [domain.CANVAS_STYLE]: sha256(cssBytes) },
  };
  sourceLabel = "js-module · " + dir;
}

// 显式给了 --keys-file 就强制校验私钥与仓库公钥配对（CI 必须走这条，防止用错私钥签名）。
const privateKey = keysFileExplicit ? loadPrivateKeyAndCheck() : crypto.createPrivateKey(fs.readFileSync(keyPath, "utf8"));
const publicKeyObject = crypto.createPublicKey(privateKey);
const manifestBytes = Buffer.from(JSON.stringify(manifest));
const signature = domain.signManifestBytes(manifestBytes, privateKey);
const selfCheck = domain.verifyManifestSignature({ manifestBytes, signatureBase64: signature, publicKeyObject });
if (!selfCheck.ok) die(5, "自检失败：新签名无法用私钥对应公钥验签（" + selfCheck.reason + "）");

const zipBytes = writeZip([
  { name: domain.MANIFEST_NAME, data: manifestBytes },
  ...filesForZip,
  { name: domain.MANIFEST_SIGNATURE_NAME, data: Buffer.from(signature, "utf8") },
]);

// 回读 zip 复核：条目数 / 逐文件摘要 / manifest 原始字节，任一不一致即非零退出。
const limits = { maxEntries: 2000, maxEntryBytes: 16 * 1024 * 1024, maxTotalBytes: domain.MAX_PACKAGE_BYTES };
const readBack = readZip(zipBytes, limits);
const readMap = new Map(readBack.map((entry) => [entry.name, entry.data]));
if (!readMap.has(domain.MANIFEST_NAME) || !readMap.has(domain.MANIFEST_SIGNATURE_NAME)) die(5, "回读失败：zip 缺 manifest.json / manifest.sig");
if (!readMap.get(domain.MANIFEST_NAME).equals(manifestBytes)) die(5, "回读失败：manifest.json 字节不一致");
for (const [rel, hash] of Object.entries(manifest.files)) {
  const data = readMap.get(rel);
  if (!data || sha256(data) !== hash) die(5, "回读失败：文件摘要不一致 " + rel);
}
const sourceBytes = filesForZip.reduce((sum, entry) => sum + entry.data.length, 0);

fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "canvas-" + version + ".zip");
fs.writeFileSync(outFile, zipBytes);

// ModelScope 源：仓库内约定路径 updates/canvas/latest.json；资产与清单放同一目录，整目录 push 即发布。
const modelscopeDir = path.join(outDir, "updates", "canvas");
const modelscopeZip = path.join(modelscopeDir, "canvas-" + version + ".zip");
fs.mkdirSync(modelscopeDir, { recursive: true });
fs.copyFileSync(outFile, modelscopeZip);
const latestManifest = {
  version,
  build,
  asset: "updates/canvas/canvas-" + version + ".zip",
  sha256: sha256(zipBytes),
  ...(notes ? { notes } : {}),
  ...(publishedAt ? { publishedAt } : {}),
  ...(placeholder ? { placeholder: true } : {}),
};
const latestFile = path.join(modelscopeDir, "latest.json");
fs.writeFileSync(latestFile, JSON.stringify(latestManifest, null, 2) + "\n");

// ── 产物信息 ──────────────────────────────────────────────────────────────
console.log("[oa-canvas-package] 形态：" + (manifest.kind || domain.MANIFEST_KIND_JS) + (placeholder ? "（占位，禁止发布）" : ""));
console.log("[oa-canvas-package] 源：" + sourceLabel);
console.log("[oa-canvas-package] 版本：" + version + " / build：" + build + " / 名称：" + name + " / entry：" + manifest.entry);
console.log("[oa-canvas-package] 文件数：" + Object.keys(manifest.files).length + "（含 manifest.json + manifest.sig，zip 共 " + readBack.length + " 条目）");
console.log("[oa-canvas-package] 源字节：" + sourceBytes + " / zip 字节：" + zipBytes.length);
console.log("[oa-canvas-package] manifest 原始字节 sha256：" + sha256(manifestBytes));
console.log("[oa-canvas-package] zip sha256：" + sha256(zipBytes));
console.log("[oa-canvas-package] 公钥 sha256 指纹：" + sha256(rawPublicKey(publicKeyObject)));
console.log("[oa-canvas-package] 签名自检 + zip 回读复核：OK（Ed25519 / 逐文件 sha256）");
console.log("[oa-canvas-package] 已写：" + outFile);
console.log("[oa-canvas-package] ModelScope 清单：" + latestFile + "（asset=" + latestManifest.asset + " / sha256=" + latestManifest.sha256 + "）");
console.log("");
console.log("发布步骤（本机与 CI 同一条命令链）：");
console.log("  # 0. 密钥指纹校验（与仓库公钥配对，不配对立即失败）");
console.log("  node scripts/oa-canvas-package.mjs --check-key --keys-file resources/app-update-keys.json");
console.log("  # 1. 用仓库公钥复核产物签名与逐文件摘要（不需要私钥）");
console.log("  node scripts/oa-canvas-package.mjs --verify " + outFile + " --keys-file resources/app-update-keys.json");
console.log("  # 2. GitHub：push tag canvas-v" + version + " 或手动触发 .github/workflows/release-canvas.yml");
console.log("  # 3. ModelScope：把 " + modelscopeDir + "/ 整个目录同步到仓库根部（node scripts/oa-modelscope-sync.mjs；工作流在配置了 MODELSCOPE_TOKEN 时自动做，否则明确提示未同步）");
