/**
 * Stage 2 · 无限画布在线更新：真实 static-web 包 → market/update/install → 协议优先加载；
 * 以及回退/回滚/占位包拒绝/老 js-module 兼容（全部离线，注入假 GitHub 源，不接触真实主机）。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SCRIPT = path.join(ROOT, "scripts", "oa-canvas-package.mjs");

const domain = require("../electron/market-update-domain.cjs");
const { createMarketUpdateBundle } = require("../electron/market-update-service.cjs");
const { writeZip, readZip } = require("../electron/canvas-dxos-zip.cjs");
const { createCanvasBundleResolver } = require("../electron/canvas-package-resolver.cjs");

const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-canvas-update-")); tmpDirs.push(dir); return dir; }
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const session = { sessionRef: "sess-canvas" };

function makeKeyFixture(dir) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  const keysFile = path.join(dir, "app-update-keys.json");
  fs.writeFileSync(keysFile, JSON.stringify({ canvas: der.subarray(der.length - 32).toString("base64") }));
  const keyFile = path.join(dir, "update-signing.key");
  fs.writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  return { privateKey, keysFile, keyFile };
}

/** 造一棵可区分的真实静态树（marker 用于证明加载的是这一版）。 */
function makeStaticSource(dir, marker) {
  fs.mkdirSync(path.join(dir, "static", "js"), { recursive: true });
  fs.writeFileSync(path.join(dir, "static", "canvas-list.html"), "<!doctype html><html><head><meta charset=\"utf-8\"><title>list</title></head><body>" + marker + "</body></html>");
  fs.writeFileSync(path.join(dir, "static", "canvas.html"), "<!doctype html><title>canvas</title>");
  fs.writeFileSync(path.join(dir, "static", "js", "app.js"), "window.__marker=" + JSON.stringify(marker) + ";");
  fs.writeFileSync(path.join(dir, "static", "openarc-marker.json"), JSON.stringify({ marker }));
  return dir;
}

function builtinTree(dir, label) {
  fs.mkdirSync(path.join(dir, "static"), { recursive: true });
  fs.writeFileSync(path.join(dir, "static", "canvas-list.html"), "<!doctype html><title>" + label + "</title>");
  return dir;
}

function runPack(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: ROOT });
}

// ── 假 GitHub 源（离线） ──────────────────────────────────────────────────
const API_URL = domain.releasesApiUrl(null);
const assetUrl = (version) => "https://github.com/invaders-2/OpenArc-OS/releases/download/canvas-v" + version + "/canvas-" + version + ".zip";
function makeRelease(version) {
  return {
    tag_name: "canvas-v" + version, draft: false, prerelease: false,
    html_url: "https://github.com/invaders-2/OpenArc-OS/releases/tag/canvas-v" + version,
    published_at: "2026-01-01T00:00:00Z",
    assets: [{ name: "canvas-" + version + ".zip", browser_download_url: assetUrl(version), size: 1024 }],
  };
}
function jsonResponse(value) { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }
function makeFetch(routes) {
  return async (url) => {
    const route = routes[String(url)];
    if (!route) return new Response("not found", { status: 404 });
    return route();
  };
}
function makeAuthorization() {
  return { resolveActor: () => ({ ok: true, user: { id: "u1" } }), store: { auditAuthorization: () => {} } };
}
function makeService(userDataDir, keysFile, zips) {
  const routes = {
    [API_URL]: () => jsonResponse(Object.keys(zips).map(makeRelease)),
    ...Object.fromEntries(Object.entries(zips).map(([version, bytes]) => [assetUrl(version), () => new Response(bytes, { status: 200 })])),
  };
  return createMarketUpdateBundle({
    userDataDir, keysFile, fetchImpl: makeFetch(routes), authorization: makeAuthorization(),
    sourceKind: "github-releases", builtinVersion: "0.1.0", clock: () => 1,
  });
}
function makeResolver(userDataDir, keysFile, builtinRoot) {
  return createCanvasBundleResolver({ userDataDir, keysFile, distRoot: builtinRoot, publicRoot: path.join(os.tmpdir(), "oa-canvas-no-public") });
}
const stateDirOf = (userDataDir) => path.join(userDataDir, "dxos", "apps", "canvas");
const install = (service, version) => service.execute("market/update/install", { confirm: true, ...(version ? { version } : {}) }, session);

// ═══════════════════════════════════════════════════════════════════════════
// ① 打包脚本产出真实 static-web 包
// ═══════════════════════════════════════════════════════════════════════════
test("打包脚本：static-web 真实包（逐文件 sha256 + manifest.sig + latest.json），回读可复核", () => {
  const keys = makeKeyFixture(tempDir());
  const source = makeStaticSource(path.join(tempDir(), "tree"), "A");
  const out = path.join(tempDir(), "out");
  const res = runPack(["--version", "0.2.0", "--kind", "static-web", "--source", source, "--key-file", keys.keyFile, "--out", out]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const zipFile = path.join(out, "canvas-0.2.0.zip");
  assert.ok(fs.existsSync(zipFile));
  const zipBytes = fs.readFileSync(zipFile);
  const entries = readZip(zipBytes, { maxEntries: 2000, maxEntryBytes: 16 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 });
  const map = new Map(entries.map((entry) => [entry.name, entry.data]));
  assert.ok(map.has("manifest.json") && map.has("manifest.sig"));
  const manifest = JSON.parse(map.get("manifest.json").toString("utf8"));
  assert.equal(manifest.kind, "static-web");
  assert.equal(manifest.entry, "static/canvas-list.html");
  assert.deepEqual(Object.keys(manifest.files).sort(), ["static/canvas-list.html", "static/canvas.html", "static/js/app.js", "static/openarc-marker.json"].sort());
  for (const [rel, hash] of Object.entries(manifest.files)) assert.equal(sha256(map.get(rel)), hash, rel);
  const verified = domain.verifyManifestSignature({ manifestBytes: map.get("manifest.json"), signatureBase64: map.get("manifest.sig").toString("utf8"), publicKeyBase64: JSON.parse(fs.readFileSync(keys.keysFile, "utf8")).canvas });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  const latest = JSON.parse(fs.readFileSync(path.join(out, "updates", "canvas", "latest.json"), "utf8"));
  assert.equal(latest.version, "0.2.0");
  assert.equal(latest.sha256, sha256(zipBytes));
  assert.equal(latest.placeholder, undefined);
});

test("打包脚本：默认不再产出占位产物；--placeholder 必带 placeholder:true；static-web+placeholder 拒绝", () => {
  const keys = makeKeyFixture(tempDir());
  const out = path.join(tempDir(), "out");
  // 显式 --source 不存在 → 非零退出（不静默产占位）
  const missing = runPack(["--version", "0.2.0", "--source", path.join(tempDir(), "nope"), "--key-file", keys.keyFile, "--out", out]);
  assert.equal(missing.status, 3, missing.stdout + missing.stderr);
  // js-module 缺 --source → 非零退出
  const jsNoSource = runPack(["--version", "0.2.0", "--kind", "js-module", "--key-file", keys.keyFile, "--out", out]);
  assert.equal(jsNoSource.status, 3, jsNoSource.stdout + jsNoSource.stderr);
  // static-web + --placeholder 是错误组合
  const badCombo = runPack(["--version", "0.2.0", "--kind", "static-web", "--placeholder", "--key-file", keys.keyFile, "--out", out]);
  assert.equal(badCombo.status, 2, badCombo.stdout + badCombo.stderr);
  // 合法占位包：manifest.placeholder=true，latest.json 也标记
  const ph = runPack(["--version", "0.0.9", "--placeholder", "--key-file", keys.keyFile, "--out", out]);
  assert.equal(ph.status, 0, ph.stderr || ph.stdout);
  const entries = readZip(fs.readFileSync(path.join(out, "canvas-0.0.9.zip")), { maxEntries: 100, maxEntryBytes: 1e6, maxTotalBytes: 1e7 });
  const manifest = JSON.parse(entries.find((entry) => entry.name === "manifest.json").data.toString("utf8"));
  assert.equal(manifest.placeholder, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "updates", "canvas", "latest.json"), "utf8")).placeholder, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 安装 → 协议优先加载已安装版本；回滚 → 回到上一版
// ═══════════════════════════════════════════════════════════════════════════
test("install → 协议加载已安装版本；再装新版；rollback 回到上一版（真实 static-web 包）", async () => {
  const keys = makeKeyFixture(tempDir());
  const userData = tempDir();
  const outA = path.join(tempDir(), "outA");
  const outB = path.join(tempDir(), "outB");
  const packA = runPack(["--version", "0.2.0", "--source", makeStaticSource(path.join(tempDir(), "srcA"), "A"), "--key-file", keys.keyFile, "--out", outA]);
  const packB = runPack(["--version", "0.3.0", "--source", makeStaticSource(path.join(tempDir(), "srcB"), "B"), "--key-file", keys.keyFile, "--out", outB]);
  assert.equal(packA.status, 0, packA.stderr);
  assert.equal(packB.status, 0, packB.stderr);
  const service = makeService(userData, keys.keysFile, {
    "0.2.0": fs.readFileSync(path.join(outA, "canvas-0.2.0.zip")),
    "0.3.0": fs.readFileSync(path.join(outB, "canvas-0.3.0.zip")),
  });
  const builtinRoot = builtinTree(path.join(tempDir(), "builtin"), "BUILTIN");
  const resolver = makeResolver(userData, keys.keysFile, builtinRoot);

  // 安装前：走内置
  assert.equal(resolver.resolve().source, "dist");
  assert.equal(resolver.resolve().fallbackReason, "pointer-missing");

  const first = await install(service, "0.2.0");
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.installed.kind, "static-web");
  const current = JSON.parse(fs.readFileSync(path.join(stateDirOf(userData), "current.json"), "utf8"));
  assert.equal(current.version, "0.2.0");
  assert.equal(current.kind, "static-web");
  assert.equal(current.entry, "static/canvas-list.html");

  const resolvedA = resolver.resolve();
  assert.equal(resolvedA.source, "installed");
  assert.equal(resolvedA.version, "0.2.0");
  assert.ok(resolvedA.root.endsWith(path.join("apps", "canvas", "0.2.0")), resolvedA.root);
  const markerA = await resolver.handle("openarc-canvas://bundle/static/openarc-marker.json");
  assert.equal(markerA.status, 200);
  assert.equal(JSON.parse(await markerA.text()).marker, "A");
  assert.equal(markerA.headers.get("x-openarc-canvas-source"), "installed");
  assert.equal(markerA.headers.get("x-openarc-canvas-version"), "0.2.0");

  // 安装新版 → 协议立即切到新版（同一 resolver，无需重启）
  const second = await install(service, "0.3.0");
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.value.previous.version, "0.2.0");
  const markerB = await resolver.handle("openarc-canvas://bundle/static/openarc-marker.json");
  assert.equal(JSON.parse(await markerB.text()).marker, "B");
  assert.equal(markerB.headers.get("x-openarc-canvas-version"), "0.3.0");

  // rollback → 回到上一版
  const rolled = await service.execute("market/update/rollback", {}, session);
  assert.equal(rolled.ok, true, JSON.stringify(rolled));
  assert.equal(rolled.value.rolledBackTo, "0.2.0");
  const resolvedBack = resolver.resolve();
  assert.equal(resolvedBack.source, "installed");
  assert.equal(resolvedBack.version, "0.2.0");
  const markerBack = await resolver.handle("openarc-canvas://bundle/static/openarc-marker.json");
  assert.equal(JSON.parse(await markerBack.text()).marker, "A");
});

test("回退：current.json 改坏 → 自动回内置 bundle，画布入口仍可加载（不白屏/不 500）", async () => {
  const keys = makeKeyFixture(tempDir());
  const userData = tempDir();
  const out = path.join(tempDir(), "out");
  const pack = runPack(["--version", "0.2.0", "--source", makeStaticSource(path.join(tempDir(), "src"), "A"), "--key-file", keys.keyFile, "--out", out]);
  assert.equal(pack.status, 0, pack.stderr);
  const service = makeService(userData, keys.keysFile, { "0.2.0": fs.readFileSync(path.join(out, "canvas-0.2.0.zip")) });
  assert.equal((await install(service, "0.2.0")).ok, true);
  const builtinRoot = builtinTree(path.join(tempDir(), "builtin"), "BUILTIN");
  const resolver = makeResolver(userData, keys.keysFile, builtinRoot);
  assert.equal((await resolver.handle("openarc-canvas://bundle/static/openarc-marker.json")).status, 200);

  fs.writeFileSync(path.join(stateDirOf(userData), "current.json"), "{ corrupted");
  const list = await resolver.handle("openarc-canvas://bundle/static/canvas-list.html");
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("x-openarc-canvas-source"), "dist");
  assert.equal(list.headers.get("x-openarc-canvas-fallback"), "pointer-invalid");
  assert.match(await list.text(), /BUILTIN/);
  const marker = await resolver.handle("openarc-canvas://bundle/static/openarc-marker.json");
  assert.equal(marker.status, 404, "内置 bundle 没有画布包里的 marker");
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 兼容回归 & 占位包拒绝
// ═══════════════════════════════════════════════════════════════════════════
test("兼容回归：老 openarc-app/v1 JS 模块包（无 kind）仍可校验安装", async () => {
  const keys = makeKeyFixture(tempDir());
  const userData = tempDir();
  const version = "0.1.5";
  const js = Buffer.from("console.log('legacy canvas');");
  const css = Buffer.from(".legacy{color:red}");
  const manifest = {
    format: "openarc-app/v1", id: "canvas", name: "无限画布", version, build: 1,
    entry: "index.js", styles: ["index.css"],
    files: { "index.js": sha256(js), "index.css": sha256(css) },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const signature = crypto.sign(null, manifestBytes, keys.privateKey).toString("base64");
  const zipBytes = writeZip([
    { name: "manifest.json", data: manifestBytes },
    { name: "manifest.sig", data: Buffer.from(signature, "utf8") },
    { name: "index.js", data: js },
    { name: "index.css", data: css },
  ]);
  const service = makeService(userData, keys.keysFile, { [version]: zipBytes });
  const res = await install(service, version);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.installed.version, version);
  assert.equal(res.value.installed.kind, "js-module");
  // 老格式不是 static-web：协议不会拿它当画布，仍然回内置。
  const resolver = makeResolver(userData, keys.keysFile, builtinTree(path.join(tempDir(), "builtin"), "BUILTIN"));
  const resolved = resolver.resolve();
  assert.equal(resolved.source, "dist");
  assert.equal(resolved.fallbackReason, "not-static-web");
});

test("占位包（manifest.placeholder=true）安装被拒：MARKET_UPDATE_UNSUPPORTED", async () => {
  const keys = makeKeyFixture(tempDir());
  const userData = tempDir();
  const out = path.join(tempDir(), "out");
  assert.equal(runPack(["--version", "0.0.9", "--placeholder", "--key-file", keys.keyFile, "--out", out]).status, 0);
  const service = makeService(userData, keys.keysFile, { "0.0.9": fs.readFileSync(path.join(out, "canvas-0.0.9.zip")) });
  const res = await install(service, "0.0.9");
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, domain.MARKET_UPDATE_ERR_UNSUPPORTED);
  assert.equal(fs.existsSync(path.join(stateDirOf(userData), "0.0.9")), false, "占位包不得落盘");
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ V0.01 云端发版链路：两段/前导零版本 + 密钥指纹校验 + 产物复核；工作流静态断言
// ═══════════════════════════════════════════════════════════════════════════
const ZIP_LIMITS = { maxEntries: 2000, maxEntryBytes: 16 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 };
const WORKFLOW_FILE = path.join(ROOT, ".github", "workflows", "release-canvas.yml");

test("发版：--version 0.01（两段/前导零）产出 canvas-0.01.zip 与 latest.json，显示串原样保留", () => {
  const keys = makeKeyFixture(tempDir());
  const source = makeStaticSource(path.join(tempDir(), "tree"), "V001");
  const out = path.join(tempDir(), "out");
  const res = runPack(["--version", "0.01", "--kind", "static-web", "--source", source, "--key-file", keys.keyFile, "--out", out]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const zipFile = path.join(out, "canvas-0.01.zip");
  assert.ok(fs.existsSync(zipFile), "两段版本资产名必须是 canvas-0.01.zip");
  const entries = readZip(fs.readFileSync(zipFile), ZIP_LIMITS);
  const map = new Map(entries.map((entry) => [entry.name, entry.data]));
  const manifest = JSON.parse(map.get("manifest.json").toString("utf8"));
  assert.equal(manifest.version, "0.01", "manifest.version 必须原样保留 0.01，不能改写成 0.1.0");
  assert.equal(manifest.kind, "static-web");
  assert.equal(manifest.entry, "static/canvas-list.html");
  const latest = JSON.parse(fs.readFileSync(path.join(out, "updates", "canvas", "latest.json"), "utf8"));
  assert.equal(latest.version, "0.01");
  assert.equal(latest.asset, "updates/canvas/canvas-0.01.zip");
  assert.equal(latest.sha256, sha256(fs.readFileSync(zipFile)));
  assert.ok(fs.existsSync(path.join(out, "updates", "canvas", "canvas-0.01.zip")), "ModelScope 同路径资产必须存在");
  // 应用侧既有域函数也认得这个版本串（发布不能被版本格式卡住）
  assert.equal(domain.parseCanvasAsset("canvas-0.01.zip").version, "0.01");
  const normalized = domain.normalizeManifest(manifest);
  assert.equal(normalized.ok, true, JSON.stringify(normalized));
  assert.equal(normalized.value.version, "0.01");
  assert.equal(domain.compareSemver(normalized.value.version, "0.1.0"), 0);
});

test("发版：--check-key 私钥与仓库公钥不配对即非零退出；配对则 0，且不回显私钥", () => {
  const keys = makeKeyFixture(tempDir());
  const other = makeKeyFixture(tempDir());
  const ok = spawnSync(process.execPath, [SCRIPT, "--check-key", "--key-file", keys.keyFile, "--keys-file", keys.keysFile], { encoding: "utf8", cwd: ROOT });
  assert.equal(ok.status, 0, ok.stderr || ok.stdout);
  assert.match(ok.stdout, /密钥配对校验：OK/);
  assert.doesNotMatch(ok.stdout + ok.stderr, /PRIVATE KEY/, "不得回显私钥内容");
  const mismatch = spawnSync(process.execPath, [SCRIPT, "--check-key", "--key-file", keys.keyFile, "--keys-file", other.keysFile], { encoding: "utf8", cwd: ROOT });
  assert.equal(mismatch.status, 5, mismatch.stdout + mismatch.stderr);
  assert.match(mismatch.stderr, /不配对/);
  assert.doesNotMatch(mismatch.stdout + mismatch.stderr, /PRIVATE KEY/, "不得回显私钥内容");
});

test("发版：--verify 用仓库公钥复核产物；篡改 manifest 一个字节必须失败", () => {
  const keys = makeKeyFixture(tempDir());
  const other = makeKeyFixture(tempDir());
  const out = path.join(tempDir(), "out");
  const pack = runPack(["--version", "0.01", "--source", makeStaticSource(path.join(tempDir(), "src"), "V"), "--key-file", keys.keyFile, "--out", out]);
  assert.equal(pack.status, 0, pack.stderr);
  const zipFile = path.join(out, "canvas-0.01.zip");
  const good = spawnSync(process.execPath, [SCRIPT, "--verify", zipFile, "--keys-file", keys.keysFile], { encoding: "utf8", cwd: ROOT });
  assert.equal(good.status, 0, good.stderr || good.stdout);
  assert.match(good.stdout, /仓库公钥验签 \+ 逐文件 sha256：OK/);
  // 换一把不配对的公钥 → 验签失败
  const wrong = spawnSync(process.execPath, [SCRIPT, "--verify", zipFile, "--keys-file", other.keysFile], { encoding: "utf8", cwd: ROOT });
  assert.equal(wrong.status, 5, wrong.stdout + wrong.stderr);
  // 篡改 manifest.json 一个字节（保留原签名）→ 验签必须失败
  const entries = readZip(fs.readFileSync(zipFile), ZIP_LIMITS);
  const tamperedManifest = Buffer.from(entries.find((entry) => entry.name === "manifest.json").data);
  tamperedManifest[tamperedManifest.length - 1] ^= 0x01;
  const rebuilt = writeZip(entries.map((entry) => (entry.name === "manifest.json" ? { name: entry.name, data: tamperedManifest } : { name: entry.name, data: entry.data })));
  const tamperedFile = path.join(out, "canvas-0.01-tampered.zip");
  fs.writeFileSync(tamperedFile, rebuilt);
  const bad = spawnSync(process.execPath, [SCRIPT, "--verify", tamperedFile, "--keys-file", keys.keysFile], { encoding: "utf8", cwd: ROOT });
  assert.equal(bad.status, 5, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /验签失败/);
});

test("发版工作流静态断言：YAML 可解析、触发/Secret/脚本路径齐备、无明文私钥", () => {
  const yaml = require("yaml");
  assert.ok(fs.existsSync(WORKFLOW_FILE), "缺少 .github/workflows/release-canvas.yml");
  const text = fs.readFileSync(WORKFLOW_FILE, "utf8");
  const doc = yaml.parse(text);
  assert.equal(doc.name, "Release Canvas");
  assert.deepEqual(doc.on.push.tags, ["canvas-v*"], "必须由 push tag canvas-v* 触发");
  assert.ok(doc.on.workflow_dispatch && doc.on.workflow_dispatch.inputs && doc.on.workflow_dispatch.inputs.version, "必须有 workflow_dispatch 手动触发且可传 version");
  assert.equal(doc.permissions.contents, "write", "建 Release 需要 contents: write");

  const runs = [];
  for (const job of Object.values(doc.jobs)) for (const step of (job.steps || [])) if (typeof step.run === "string") runs.push(step.run);
  const allRuns = runs.join("\n");
  assert.ok(allRuns.includes("--check-key"), "工作流必须先做密钥指纹校验");
  assert.ok(allRuns.includes("--keys-file resources/app-update-keys.json"), "指纹校验必须与仓库公钥配对");
  assert.ok(allRuns.includes("--kind static-web") && allRuns.includes("--source dist/novai-canvas"), "打包命令必须与任务书一致");
  assert.ok(allRuns.includes("scripts/oa-canvas-package.mjs"), "工作流引用打包脚本");
  assert.ok(allRuns.includes("scripts/oa-modelscope-sync.mjs"), "工作流引用 ModelScope 同步脚本");
  assert.ok(allRuns.includes("--verify"), "工作流必须用仓库公钥复核产物");
  for (const rel of ["scripts/oa-canvas-package.mjs", "scripts/oa-modelscope-sync.mjs", "resources/app-update-keys.json"]) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), "工作流引用的路径不存在：" + rel);
  }

  assert.match(text, /secrets\.OA_UPDATE_SIGNING_KEY/, "私钥必须走 Secret OA_UPDATE_SIGNING_KEY");
  assert.match(text, /secrets\.MODELSCOPE_TOKEN/, "ModelScope 凭据必须走 Secret MODELSCOPE_TOKEN");
  assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text), "工作流不得出现私钥明文");

  // 缺 Secret 时必须明确提示「更新源未同步」，且不把该 job 判失败
  assert.match(text, /更新源未同步/);
  assert.match(text, /steps\.token\.outputs\.present/, "缺 token 的分支必须由 token 检测步骤驱动");
  assert.match(allRuns, /oa-modelscope-sync\.mjs --dry-run/, "同步前必须有产物预检");

  // 文档里的 Secret 名与工作流一致
  const docs = fs.readFileSync(path.join(ROOT, "docs", "canvas-online-update.md"), "utf8");
  assert.match(docs, /OA_UPDATE_SIGNING_KEY/);
  assert.match(docs, /MODELSCOPE_TOKEN/);
  assert.match(docs, /canvas-v0\.01/, "文档必须给出打 tag 的发版示例");

  // 所有 run 步骤拼起来必须能被 bash 解析（语法级静态检查）
  const bash = spawnSync("bash", ["-n", "-c", allRuns], { encoding: "utf8" });
  assert.equal(bash.status, 0, "run 步骤 shell 语法错误：" + bash.stderr);
});
