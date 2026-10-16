#!/usr/bin/env node
/**
 * OpenArc OS · V0.01 发版链路本机复现（与 GitHub Actions 用同一条命令链）。
 *
 *   npm run build
 *   node scripts/oa-canvas-package.mjs --check-key --keys-file resources/app-update-keys.json
 *   node scripts/oa-canvas-package.mjs --kind static-web --source dist/novai-canvas --version 0.01 --keys-file resources/app-update-keys.json
 *   node scripts/oa-canvas-package.mjs --verify dist-updates/canvas-0.01.zip --keys-file resources/app-update-keys.json
 *
 * 额外用「应用侧既有校验逻辑」（market-update-domain.cjs）独立证明：
 *   · 仓库公钥能验 manifest.sig；逐文件 sha256 全部命中；
 *   · 篡改 manifest.json 一个字节 → 验签必须失败。
 *
 * 输出：artifacts/dxos-release-v001/report.json + dist-updates/（zip / latest.json）+ 终端证据。
 * 用法：node experiments/dxos-release-v001/run-all.mjs [--skip-build] [--version 0.01]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ARTIFACT_DIR = path.join(ROOT, "artifacts", "dxos-release-v001");
const OUT_DIR = path.join(ARTIFACT_DIR, "dist-updates");
const KEYS_FILE = path.join(ROOT, "resources", "app-update-keys.json");
const KEY_FILE = path.join(ROOT, ".keys", "update-signing.key");
const PACKAGE_SCRIPT = path.join(ROOT, "scripts", "oa-canvas-package.mjs");
const SOURCE_DIR = path.join(ROOT, "dist", "novai-canvas");

const domain = require(path.join(ROOT, "electron", "market-update-domain.cjs"));
const { readZip } = require(path.join(ROOT, "electron", "canvas-dxos-zip.cjs"));

const args = process.argv.slice(2);
const valueOf = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const version = valueOf("--version") || "0.01";
const skipBuild = args.includes("--skip-build");
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const fail = (message) => { console.error("[dxos-release-v001] ✗ " + message); process.exit(1); };

function run(label, argv, options = {}) {
  const bin = options.bin || process.execPath;
  console.log("\n$ " + [bin, ...argv].map((part) => (part.includes(" ") ? JSON.stringify(part) : part)).join(" "));
  const result = spawnSync(bin, argv, { cwd: ROOT, encoding: "utf8", ...options });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (stdout.trim()) console.log(stdout.trimEnd());
  if (stderr.trim()) console.error(stderr.trimEnd());
  if (result.status !== 0 && !options.allowFailure) fail(label + " 失败（exit=" + result.status + "）");
  return { status: result.status, stdout, stderr };
}

// ── 前置：构建产物与密钥 ─────────────────────────────────────────────────────
if (!skipBuild) run("npm run build", ["run", "build"], { bin: "npm" });
if (!fs.existsSync(path.join(SOURCE_DIR, "static", "canvas-list.html"))) fail("dist/novai-canvas 不是真实静态树；先 npm run build");
if (!fs.existsSync(KEY_FILE)) fail("缺少本机签名私钥 " + KEY_FILE + "；先 node scripts/oa-update-keygen.mjs");

fs.rmSync(OUT_DIR, { recursive: true, force: true });

// ── 与 CI 完全相同的三步 ─────────────────────────────────────────────────────
run("--check-key", [PACKAGE_SCRIPT, "--check-key", "--key-file", KEY_FILE, "--keys-file", KEYS_FILE]);
run("package 0.01", [PACKAGE_SCRIPT, "--kind", "static-web", "--source", SOURCE_DIR, "--version", version,
  "--key-file", KEY_FILE, "--keys-file", KEYS_FILE, "--out", OUT_DIR]);

const zipFile = path.join(OUT_DIR, "canvas-" + version + ".zip");
const latestFile = path.join(OUT_DIR, "updates", "canvas", "latest.json");
run("--verify", [PACKAGE_SCRIPT, "--verify", zipFile, "--keys-file", KEYS_FILE]);

// ── 应用侧既有校验逻辑独立复核 ───────────────────────────────────────────────
const zipBytes = fs.readFileSync(zipFile);
const entries = readZip(zipBytes, { maxEntries: 2000, maxEntryBytes: 16 * 1024 * 1024, maxTotalBytes: domain.MAX_PACKAGE_BYTES });
const map = new Map(entries.map((entry) => [entry.name, entry.data]));
const manifestBytes = map.get(domain.MANIFEST_NAME);
const signatureBase64 = map.get(domain.MANIFEST_SIGNATURE_NAME).toString("utf8").trim();
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const repoKeys = JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
const latest = JSON.parse(fs.readFileSync(latestFile, "utf8"));

const verified = domain.verifyManifestSignature({ manifestBytes, signatureBase64, publicKeyBase64: repoKeys.canvas });
if (!verified.ok) fail("仓库公钥验签失败：" + verified.reason);

let fileHashFailures = 0;
for (const [rel, hash] of Object.entries(manifest.files)) {
  const data = map.get(rel);
  if (!data || sha256(data) !== hash) { fileHashFailures += 1; console.error("  ✗ 摘要不一致：" + rel); }
}
if (fileHashFailures) fail("逐文件 sha256 校验失败 " + fileHashFailures + " 个");

// 篡改 1：manifest.json 一个字节 → 验签必须失败
const tampered = Buffer.from(manifestBytes);
tampered[tampered.length - 1] ^= 0x01;
const tamperedResult = domain.verifyManifestSignature({ manifestBytes: tampered, signatureBase64, publicKeyBase64: repoKeys.canvas });
if (tamperedResult.ok) fail("篡改 manifest 一个字节后验签仍然通过（不可接受）");

// 篡改 2：把某个文件的 sha256 改一位 → 逐文件摘要比对必须不命中
const firstFile = Object.keys(manifest.files)[0];
const wrongHash = (manifest.files[firstFile][0] === "0" ? "1" : "0") + manifest.files[firstFile].slice(1);
const payloadBytes = map.get(firstFile);
const payloadMatchesWrong = sha256(payloadBytes) === wrongHash;
if (payloadMatchesWrong) fail("篡改摘要后仍命中（不可接受）");

const normalized = domain.normalizeManifest(manifest);
if (!normalized.ok) fail("manifest 未通过应用侧 normalizeManifest：" + normalized.error.message);
if (latest.sha256 !== sha256(zipBytes)) fail("latest.json.sha256 与 zip 不一致");
if (latest.version !== version || manifest.version !== version) fail("版本串不是 " + version);
if (latest.asset !== "updates/canvas/canvas-" + version + ".zip") fail("latest.json.asset 约定不符：" + latest.asset);

const report = {
  generatedAt: new Date().toISOString(),
  version,
  manifestVersion: manifest.version,
  semver: { major: normalized.value.semver.major, minor: normalized.value.semver.minor, patch: normalized.value.semver.patch },
  kind: manifest.kind,
  entry: manifest.entry,
  fileCount: Object.keys(manifest.files).length,
  zipEntryCount: entries.length,
  sourceBytes: entries.filter((e) => e.name !== domain.MANIFEST_NAME && e.name !== domain.MANIFEST_SIGNATURE_NAME).reduce((s, e) => s + e.data.length, 0),
  zipFile,
  zipBytes: zipBytes.length,
  zipSha256: sha256(zipBytes),
  manifestSha256: sha256(manifestBytes),
  latestAsset: latest.asset,
  latestSha256: latest.sha256,
  builtinVersion: domain.APP_BUILTIN_VERSIONS.canvas,
  compareWithBuiltin: domain.compareSemver(version, domain.APP_BUILTIN_VERSIONS.canvas),
  publicKeyBase64: repoKeys.canvas,
  publicKeyFingerprint: sha256(Buffer.from(repoKeys.canvas, "base64")),
  signatureVerifiedWithRepoPublicKey: verified.ok,
  perFileSha256Verified: fileHashFailures === 0,
  tamperManifestByteSignature: tamperedResult,
  tamperFileHashStillMatches: payloadMatchesWrong,
  checks: [
    "check-key: 私钥公钥与 resources/app-update-keys.json 配对",
    "package: --version " + version + " 产出 canvas-" + version + ".zip + updates/canvas/latest.json",
    "--verify: 仓库公钥验签 + 逐文件 sha256",
    "domain.verifyManifestSignature(repoPublicKey) = ok",
    "篡改 manifest 一个字节 → 验签失败（" + tamperedResult.reason + "）",
  ],
};

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
fs.writeFileSync(path.join(ARTIFACT_DIR, "report.json"), JSON.stringify(report, null, 2) + "\n");

console.log("\n════════ V0.01 本机发版证据 ════════");
console.log("版本：" + report.version + "（内置版本 " + report.builtinVersion + "，compareSemver=" + report.compareWithBuiltin + "）");
console.log("形态：" + report.kind + " / entry：" + report.entry + " / 名称：" + manifest.name + " / build：" + manifest.build);
console.log("文件数：" + report.fileCount + "（zip 共 " + report.zipEntryCount + " 条目）");
console.log("zip：" + report.zipFile);
console.log("zip 字节：" + report.zipBytes);
console.log("zip sha256：" + report.zipSha256);
console.log("manifest 原始字节 sha256：" + report.manifestSha256);
console.log("公钥 sha256 指纹：" + report.publicKeyFingerprint);
console.log("仓库公钥验签：" + (verified.ok ? "OK" : "FAILED") + " / 逐文件 sha256：" + (report.perFileSha256Verified ? "OK" : "FAILED"));
console.log("篡改 manifest 一字节后验签：" + JSON.stringify(tamperedResult));
console.log("report：" + path.join(ARTIFACT_DIR, "report.json"));
