/**
 * Stage 1 · 无限画布在线更新：后端核心离线验收（不联网、不启动 Electron、不新增依赖）。
 *
 * 覆盖任务书验收点：
 *   ① 无 Release 时如实回「无可用更新」（不是报错）；install 无 Release → NO_RELEASE
 *   ② 语义化版本比较与通道选择（stable 跳过 prerelease / draft；beta 含 prerelease）
 *   ③ 篡改 manifest.json → 签名校验失败 SIGNATURE_INVALID
 *   ④ 篡改 index.js → 摘要校验失败 DIGEST_MISMATCH
 *   ⑤ 缺 manifest.sig → 直接拒绝 SIGNATURE_INVALID（不静默降级）
 *   ⑥ 非白名单主机 / 非 HTTPS / 重定向越界 → HOST_NOT_ALLOWED
 *   ⑦ zip 目录穿越条目 → 拒绝，且不落任何越界文件
 *   ⑧ 安装后 current 指针 + 整包摘要正确、上一版可回滚；激活前整包再验
 *   ⑨ 未认证 / 未 trusted / 未装配边界；market:command 委托与 NOT_READY
 *   ⑩ install / rollback 授权审计写入（沿用 authStore.auditAuthorization）
 *
 * 所有网络都走注入的 fetchImpl（假 GitHub API / 假资产 / 假重定向），本测试进程不对任何真实主机发起请求。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const domain = require("../electron/market-update-domain.cjs");
const sourceAdapters = require("../electron/market-update-sources.cjs");
const { createMarketUpdateBundle } = require("../electron/market-update-service.cjs");
const { createMarketBundle } = require("../electron/market-service.cjs");
const { writeZip } = require("../electron/canvas-dxos-zip.cjs");
const { registerMarketIpc, disposeMarketIpc } = require("../electron/plugin-bootstrap.cjs");

// ── 临时目录 ────────────────────────────────────────────────────────────────
const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-market-update-")); tmpDirs.push(dir); return dir; }

// ── 包构造 / 假网络 ─────────────────────────────────────────────────────────
const sha256hex = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const REPO_KEYPAIR = (() => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  return { publicKeyBase64: der.subarray(der.length - 32).toString("base64"), privateKey };
})();

function writeKeysFile(dir, publicKeyBase64) {
  const file = path.join(dir, "app-update-keys.json");
  fs.writeFileSync(file, JSON.stringify({ canvas: publicKeyBase64 }));
  return file;
}

/**
 * 构造 canvas-<version>.zip。
 *   manifestBytesOverride：zip 里放的 manifest 字节（签名仍对未篡改的原字节）
 *   tamperIndex：zip 里的 index.js 换成别的字节（manifest 仍记原摘要）
 *   includeSignature：是否放 manifest.sig
 *   extraEntries：额外条目（目录穿越测试用）
 */
function buildPackage({ version, privateKey, indexJs, indexCss, manifestBytesOverride = null, tamperIndex = false, includeSignature = true, extraEntries = [] }) {
  const js = Buffer.from(indexJs ?? "console.log(\"canvas " + version + "\");");
  const css = Buffer.from(indexCss ?? ".canvas-" + version.replace(/\./g, "_") + "{color:red}");
  const manifest = {
    format: "openarc-app/v1", id: "canvas", name: "无限画布", version, build: 1,
    entry: "index.js", styles: ["index.css"],
    files: { "index.js": sha256hex(js), "index.css": sha256hex(css) },
  };
  const originalBytes = Buffer.from(JSON.stringify(manifest));
  const storedManifest = manifestBytesOverride || originalBytes;
  const signature = crypto.sign(null, originalBytes, privateKey).toString("base64");
  const entries = [
    { name: "manifest.json", data: storedManifest },
    ...(includeSignature ? [{ name: "manifest.sig", data: Buffer.from(signature, "utf8") }] : []),
    { name: "index.js", data: tamperIndex ? Buffer.from("/* tampered */") : js },
    { name: "index.css", data: css },
    ...extraEntries,
  ];
  return writeZip(entries);
}

const API_URL = domain.releasesApiUrl(null);
const assetUrl = (version, host = "github.com") => "https://" + host + "/invaders-2/OpenArc-OS/releases/download/canvas-v" + version + "/canvas-" + version + ".zip";

function makeRelease(version, { prerelease = false, draft = false, host = "github.com", assetName = "canvas-" + version + ".zip", tag = "canvas-v" + version, withAsset = true } = {}) {
  return {
    tag_name: tag,
    draft,
    prerelease,
    html_url: "https://github.com/invaders-2/OpenArc-OS/releases/tag/" + tag,
    published_at: "2026-01-01T00:00:00Z",
    assets: withAsset ? [{ name: assetName, browser_download_url: assetUrl(version, host), size: 1024 }] : [],
  };
}

function jsonResponse(value) { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }
function assetResponse(buffer) { return new Response(buffer, { status: 200 }); }
function redirectResponse(location) { return new Response(null, { status: 302, headers: { location } }); }

function makeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), redirect: init.redirect, accept: init.headers && init.headers.accept });
    const route = routes[String(url)];
    if (!route) return new Response("not found", { status: 404 });
    return route();
  };
  impl.calls = calls;
  return impl;
}

function makeAuthorization(audits, { actor = { id: "u1" }, isSuper = false, fail = false } = {}) {
  return {
    resolveActor: () => (fail ? { ok: false, error: "SESSION_REVOKED" } : { ok: true, user: actor, isSuper }),
    store: { auditAuthorization: (row) => { audits.push(row); } },
  };
}

function makeBundle({ routes = {}, releases = [], keypair = REPO_KEYPAIR, authorization, options = {}, actorOptions } = {}) {
  const dir = tempDir();
  const keysFile = writeKeysFile(dir, keypair.publicKeyBase64);
  const audits = [];
  const fetchImpl = makeFetch({
    [API_URL]: () => jsonResponse(releases),
    ...routes,
  });
  const bundle = createMarketUpdateBundle({
    userDataDir: dir,
    keysFile,
    fetchImpl,
    authorization: authorization === undefined ? makeAuthorization(audits, actorOptions) : authorization,
    builtinVersion: "0.0.1",
    clock: () => 1_700_000_000_000,
    // 默认源改为 modelscope-repo 后，①-⑩ 这组 GitHub 用例显式声明 GitHub 源，不再依赖缺省值；
    // 真实默认值与持久化优先级由 M8 / M9 与 makeModelBundle 覆盖。
    sourceKind: "github-releases",
    ...options,
  });
  return { bundle, dir, keysFile, audits, fetchImpl };
}

const canvasStateDir = (dir) => path.join(dir, "dxos", "apps", "canvas");
/** 泛化后：更新源是整机级选择，落在 dxos/updates/source.json（旧位置 apps/canvas/source.json 只读兼容）。 */
const globalSourceFile = (dir) => path.join(dir, "dxos", "updates", "source.json");
const appStateDir = (dir, appId) => path.join(dir, "dxos", "apps", appId);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const session = { sessionRef: "sess-1" };

// ═══════════════════════════════════════════════════════════════════════════
// ① 无 Release：如实回「无可用更新」
// ═══════════════════════════════════════════════════════════════════════════
test("① 无 Release：check 如实回「无可用更新」，不是报错；install → NO_RELEASE", async () => {
  const empty = makeBundle({ releases: [] });
  const check = await empty.bundle.execute("market/update/check", {}, session);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(check.value.latest, null);
  assert.equal(check.value.updateAvailable, false);
  assert.equal(check.value.checkedAt, 1_700_000_000_000);
  assert.equal(check.value.current, null);

  const install = await empty.bundle.execute("market/update/install", { confirm: true }, session);
  assert.equal(install.ok, false);
  assert.equal(install.error, "MARKET_UPDATE_NO_RELEASE");

  // 只有草稿 / 只有非 canvas 资产 → 同样视为「没有可用更新」
  const drafts = makeBundle({ releases: [makeRelease("9.9.9", { draft: true })] });
  const draftCheck = await drafts.bundle.execute("market/update/check", {}, session);
  assert.equal(draftCheck.ok, true);
  assert.equal(draftCheck.value.latest, null);

  const foreign = makeBundle({ releases: [makeRelease("1.0.0", { assetName: "other-1.0.0.zip" })] });
  const foreignCheck = await foreign.bundle.execute("market/update/check", {}, session);
  assert.equal(foreignCheck.ok, true);
  assert.equal(foreignCheck.value.latest, null);
  assert.equal(foreignCheck.value.updateAvailable, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 语义化版本比较与通道选择
// ═══════════════════════════════════════════════════════════════════════════
test("② 版本比较与通道选择：stable 跳 prerelease/draft，取语义化最高；beta 含 prerelease", async () => {
  // 纯函数
  assert.equal(domain.compareSemver("1.10.0", "1.9.0"), 1, "1.10.0 > 1.9.0（不是字符串比较）");
  assert.equal(domain.compareSemver("2.0.0-beta.1", "2.0.0"), -1, "prerelease < release");
  assert.equal(domain.compareSemver("2.0.0-beta.2", "2.0.0-beta.10"), -1, "数字标识符按数值比较");
  assert.equal(domain.compareSemver("1.2.3", "1.2.3"), 0);
  assert.ok(Number.isNaN(domain.compareSemver("nope", "1.0.0")), "非法版本比较回 NaN");
  assert.equal(domain.parseSemver("v1.2.3").version, "1.2.3");
  // 发布友好的版本语法（2026-10）：两段 / 前导零都接受；显示串保留原样，比较按数值规范化。
  assert.equal(domain.parseSemver("1.02.3").version, "1.02.3", "前导零接受且原样保留");
  assert.deepEqual([domain.parseSemver("0.01").major, domain.parseSemver("0.01").minor, domain.parseSemver("0.01").patch], [0, 1, 0]);
  assert.equal(domain.parseSemver("0.01").version, "0.01", "两段版本原样保留（不会被改写成 0.1.0）");
  assert.equal(domain.parseSemver("v0.01").version, "0.01", "v 前缀仍被剥掉");
  assert.equal(domain.compareSemver("0.01", "0.1.0"), 0, "0.01 与 0.1.0 数值等价");
  assert.equal(domain.compareSemver("0.02", "0.01"), 1, "0.02 > 0.01（按数值而非字符串）");
  assert.equal(domain.parseSemver("0.01.2.3"), null, "超过三段非法");
  assert.deepEqual(domain.parseCanvasAsset("canvas-1.2.3.zip").version, "1.2.3");
  assert.equal(domain.parseCanvasAsset("canvas-1.2.zip").version, "1.2", "两段资产名可解析");
  assert.equal(domain.parseCanvasAsset("canvas-0.01.zip").version, "0.01", "canvas-<version>.zip 支持两段 / 前导零");
  assert.equal(domain.parseCanvasAsset("canvas-1.2.3.4.zip"), null);
  assert.equal(domain.parseCanvasAsset("other-1.2.3.zip"), null);

  const releases = [
    makeRelease("1.2.3"),
    makeRelease("1.10.0"),
    makeRelease("2.0.0", { prerelease: true }),      // 更高，但 prerelease
    makeRelease("3.0.0", { draft: true }),           // 最高，但 draft
    makeRelease("9.9.9", { assetName: "canvas-nope.zip" }),
  ];
  const stable = makeBundle({ releases });
  const stableCheck = await stable.bundle.execute("market/update/check", {}, session);
  assert.equal(stableCheck.value.latest.version, "1.10.0");
  assert.equal(stableCheck.value.updateAvailable, true);

  const beta = makeBundle({ releases, options: { channel: "beta" } });
  const betaCheck = await beta.bundle.execute("market/update/check", {}, session);
  assert.equal(betaCheck.value.latest.version, "2.0.0", "beta 通道包含 prerelease（draft 仍排除）");
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 篡改 manifest → 签名失败
// ═══════════════════════════════════════════════════════════════════════════
test("③ 篡改 manifest.json 后签名校验失败 → SIGNATURE_INVALID", async () => {
  const tamperedManifest = Buffer.from(JSON.stringify({
    format: "openarc-app/v1", id: "canvas", name: "HACKED", version: "0.1.0", build: 1,
    entry: "index.js", styles: ["index.css"], files: { "index.js": "a".repeat(64), "index.css": "b".repeat(64) },
  }));
  const zip = buildPackage({ version: "0.1.0", privateKey: REPO_KEYPAIR.privateKey, manifestBytesOverride: tamperedManifest });
  const { bundle } = makeBundle({ releases: [makeRelease("0.1.0")], routes: { [assetUrl("0.1.0")]: () => assetResponse(zip) } });
  const res = await bundle.execute("market/update/install", { confirm: true, version: "0.1.0" }, session);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, "MARKET_UPDATE_SIGNATURE_INVALID");
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ 篡改 index.js → 摘要失败
// ═══════════════════════════════════════════════════════════════════════════
test("④ 篡改 index.js 后摘要校验失败 → DIGEST_MISMATCH", async () => {
  const zip = buildPackage({ version: "0.1.0", privateKey: REPO_KEYPAIR.privateKey, tamperIndex: true });
  const { bundle, dir } = makeBundle({ releases: [makeRelease("0.1.0")], routes: { [assetUrl("0.1.0")]: () => assetResponse(zip) } });
  const res = await bundle.execute("market/update/install", { confirm: true, version: "0.1.0" }, session);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, "MARKET_UPDATE_DIGEST_MISMATCH");
  assert.equal(fs.existsSync(path.join(canvasStateDir(dir), "0.1.0")), false, "验摘要失败不得落地版本目录");
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 缺签名 → 直接拒绝
// ═══════════════════════════════════════════════════════════════════════════
test("⑤ 缺 manifest.sig 直接拒绝（不静默降级）→ SIGNATURE_INVALID", async () => {
  const zip = buildPackage({ version: "0.1.0", privateKey: REPO_KEYPAIR.privateKey, includeSignature: false });
  const { bundle, dir } = makeBundle({ releases: [makeRelease("0.1.0")], routes: { [assetUrl("0.1.0")]: () => assetResponse(zip) } });
  const res = await bundle.execute("market/update/install", { confirm: true, version: "0.1.0" }, session);
  assert.equal(res.ok, false);
  assert.equal(res.error, "MARKET_UPDATE_SIGNATURE_INVALID");
  assert.match(res.detail, /manifest\.sig/);
  assert.equal(fs.existsSync(path.join(canvasStateDir(dir), "0.1.0")), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑥ 主机白名单
// ═══════════════════════════════════════════════════════════════════════════
test("⑥ 非白名单主机 / 非 HTTPS / 重定向越界 → HOST_NOT_ALLOWED", async () => {
  const zip = buildPackage({ version: "0.1.0", privateKey: REPO_KEYPAIR.privateKey });

  // 资产 URL 直接指向非白名单主机
  const evilHost = makeBundle({
    releases: [makeRelease("0.1.0", { host: "evil.example" })],
    routes: { [assetUrl("0.1.0", "evil.example")]: () => assetResponse(zip) },
  });
  const r1 = await evilHost.bundle.execute("market/update/install", { confirm: true, version: "0.1.0" }, session);
  assert.equal(r1.error, "MARKET_UPDATE_HOST_NOT_ALLOWED", JSON.stringify(r1));

  // github.com 302 → 非白名单主机
  const redirected = makeBundle({
    releases: [makeRelease("0.1.0")],
    routes: { [assetUrl("0.1.0")]: () => redirectResponse("https://evil.example/canvas-0.1.0.zip") },
  });
  const r2 = await redirected.bundle.execute("market/update/install", { confirm: true, version: "0.1.0" }, session);
  assert.equal(r2.error, "MARKET_UPDATE_HOST_NOT_ALLOWED", JSON.stringify(r2));

  // 非 HTTPS
  const insecure = makeBundle({
    releases: [{
      ...makeRelease("0.1.0"),
      assets: [{ name: "canvas-0.1.0.zip", browser_download_url: "http://github.com/x/canvas-0.1.0.zip", size: 1 }],
    }],
  });
  const r3 = await insecure.bundle.execute("market/update/install", { confirm: true, version: "0.1.0" }, session);
  assert.equal(r3.error, "MARKET_UPDATE_HOST_NOT_ALLOWED", JSON.stringify(r3));

  // 纯函数
  assert.equal(domain.isAllowedUrl("https://objects.githubusercontent.com/x"), true);
  assert.equal(domain.isAllowedUrl("https://evil.example/x"), false);
  assert.equal(domain.isAllowedUrl("http://github.com/x"), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑦ zip 目录穿越
// ═══════════════════════════════════════════════════════════════════════════
test("⑦ zip 目录穿越条目被拒，且不落任何越界文件", async () => {
  const zip = buildPackage({
    version: "0.1.0",
    privateKey: REPO_KEYPAIR.privateKey,
    extraEntries: [
      { name: "../evil.js", data: Buffer.from("evil") },
      { name: "/abs-evil.js", data: Buffer.from("evil") },
    ],
  });
  const { bundle, dir } = makeBundle({ releases: [makeRelease("0.1.0")], routes: { [assetUrl("0.1.0")]: () => assetResponse(zip) } });
  const res = await bundle.execute("market/update/install", { confirm: true, version: "0.1.0" }, session);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, "MARKET_UPDATE_INVALID_INPUT");
  assert.equal(fs.existsSync(path.join(dir, "evil.js")), false);
  assert.equal(fs.existsSync(path.join(dir, "dxos", "evil.js")), false);
  assert.equal(fs.existsSync(path.join(canvasStateDir(dir), "evil.js")), false);
  assert.equal(domain.isSafeEntryName("../evil.js"), false);
  assert.equal(domain.isSafeEntryName("nested/index.js"), true);
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑧ 安装 / 指针 / 摘要 / 回滚 / 激活前再验
// ═══════════════════════════════════════════════════════════════════════════
test("⑧ 安装后 current 指针与整包摘要正确，上一版可回滚", async () => {
  const pkg1 = buildPackage({ version: "0.1.0", privateKey: REPO_KEYPAIR.privateKey });
  const pkg2 = buildPackage({ version: "0.2.0", privateKey: REPO_KEYPAIR.privateKey });
  const { bundle, dir, audits } = makeBundle({
    releases: [makeRelease("0.1.0"), makeRelease("0.2.0")],
    routes: { [assetUrl("0.1.0")]: () => assetResponse(pkg1), [assetUrl("0.2.0")]: () => assetResponse(pkg2) },
  });
  const stateDir = canvasStateDir(dir);

  const first = await bundle.execute("market/update/install", { confirm: true, version: "0.1.0" }, session);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first.value, { installed: { appId: "canvas", version: "0.1.0", digest: first.value.installed.digest, kind: "js-module", entry: "index.js" }, previous: null });
  assert.match(first.value.installed.digest, /^[a-f0-9]{64}$/);

  const second = await bundle.execute("market/update/install", { confirm: true, version: "0.2.0" }, session);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.value.installed.version, "0.2.0");
  assert.deepEqual(second.value.previous, { version: "0.1.0" });

  const current = readJson(path.join(stateDir, "current.json"));
  assert.equal(current.version, "0.2.0");
  assert.equal(current.installedAt, 1_700_000_000_000);
  const manifestBytes = fs.readFileSync(path.join(stateDir, "0.2.0", "manifest.json"));
  assert.equal(current.digest, sha256hex(manifestBytes), "current.digest = manifest.json 原始字节 sha256");
  assert.equal(current.kind, "js-module");
  assert.equal(current.entry, "index.js");
  assert.equal(Object.keys(current).sort().join(","), "digest,entry,installedAt,kind,version", "指针文件形状 = {version,digest,kind,entry,installedAt}（Stage 2 增加 kind/entry）");
  for (const name of ["index.js", "index.css", "manifest.json", "manifest.sig"]) {
    assert.ok(fs.existsSync(path.join(stateDir, "0.2.0", name)), "缺少 " + name);
  }
  assert.deepEqual(fs.readdirSync(stateDir).filter((n) => n.startsWith(".staging-")), [], "不得留下 staging 目录");
  assert.deepEqual(readJson(path.join(stateDir, "history.json")).versions, ["0.1.0", "0.2.0"]);

  const status = await bundle.execute("market/update/status", {}, session);
  assert.equal(status.value.current.version, "0.2.0");
  assert.equal(status.value.canRollback, true);

  const rollback = await bundle.execute("market/update/rollback", {}, session);
  assert.equal(rollback.ok, true, JSON.stringify(rollback));
  assert.deepEqual(rollback.value, { rolledBackTo: "0.1.0", previous: { version: "0.2.0" } });
  const rolled = readJson(path.join(stateDir, "current.json"));
  assert.equal(rolled.version, "0.1.0");
  assert.equal(rolled.digest, sha256hex(fs.readFileSync(path.join(stateDir, "0.1.0", "manifest.json"))));
  assert.deepEqual(readJson(path.join(stateDir, "history.json")).versions, ["0.1.0"]);
  assert.equal((await bundle.execute("market/update/status", {}, session)).value.canRollback, false);
  assert.ok(audits.some((row) => row.action === "canvas.update.rollback" && row.decision === "ALLOW"));
});

test("⑧b 激活前整包再验：上一版落地后被改 → 回滚拒绝 DIGEST_MISMATCH，当前版不变", async () => {
  const pkg1 = buildPackage({ version: "0.1.0", privateKey: REPO_KEYPAIR.privateKey });
  const pkg2 = buildPackage({ version: "0.2.0", privateKey: REPO_KEYPAIR.privateKey });
  const { bundle, dir, audits } = makeBundle({
    releases: [makeRelease("0.1.0"), makeRelease("0.2.0")],
    routes: { [assetUrl("0.1.0")]: () => assetResponse(pkg1), [assetUrl("0.2.0")]: () => assetResponse(pkg2) },
  });
  const stateDir = canvasStateDir(dir);
  await bundle.execute("market/update/install", { confirm: true, version: "0.1.0" }, session);
  await bundle.execute("market/update/install", { confirm: true, version: "0.2.0" }, session);

  fs.writeFileSync(path.join(stateDir, "0.1.0", "index.js"), "/* changed on disk */");
  const rollback = await bundle.execute("market/update/rollback", {}, session);
  assert.equal(rollback.ok, false, JSON.stringify(rollback));
  assert.equal(rollback.error, "MARKET_UPDATE_DIGEST_MISMATCH");
  assert.equal(readJson(path.join(stateDir, "current.json")).version, "0.2.0", "校验失败不得切换指针");
  assert.ok(audits.some((row) => row.action === "canvas.update.rollback" && row.decision === "DENY" && row.reasonCode === "MARKET_UPDATE_DIGEST_MISMATCH"));
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑨ 未认证 / 未 trusted / 未装配
// ═══════════════════════════════════════════════════════════════════════════
test("⑨a 未认证 / 无效会话 / 非法输入 / 未知命令边界", async () => {
  const { bundle } = makeBundle({ releases: [makeRelease("0.1.0")] });
  const noAuth = makeBundle({ releases: [makeRelease("0.1.0")], authorization: null });
  assert.equal((await bundle.execute("market/update/status", {}, {})).error, "MARKET_UPDATE_UNAUTHENTICATED");
  assert.equal((await noAuth.bundle.execute("market/update/status", {}, { sessionRef: "s" })).error, "MARKET_UPDATE_UNAUTHENTICATED", "无授权服务即未认证");
  assert.equal((await bundle.execute("market/update/nope", {}, session)).error, "MARKET_UPDATE_COMMAND_NOT_ALLOWED");
  assert.equal((await bundle.execute("market/update/install", {}, session)).error, "MARKET_UPDATE_INVALID_INPUT", "缺 confirm 必须拒绝");
  assert.equal((await bundle.execute("market/update/install", { confirm: true, appId: "other" }, session)).error, "MARKET_UPDATE_INVALID_INPUT");
  assert.equal((await bundle.execute("market/update/install", { confirm: true, version: "1.2.3.4" }, session)).error, "MARKET_UPDATE_INVALID_INPUT", "超过三段的版本仍非法");

  const revoked = makeBundle({ releases: [makeRelease("0.1.0")], actorOptions: { fail: true } });
  assert.equal((await revoked.bundle.execute("market/update/status", {}, session)).error, "MARKET_UPDATE_UNAUTHENTICATED");
});

test("⑨b market:command 委托：注入 updateService 时可达，未装配时回 MARKET_UPDATE_NOT_READY", async () => {
  const { bundle } = makeBundle({ releases: [makeRelease("0.1.0")] });
  const market = createMarketBundle({ userDataDir: tempDir(), appDir: ROOT, updateService: bundle });
  const delegated = await market.execute("market/update/sources", {}, session);
  assert.equal(delegated.ok, true, JSON.stringify(delegated));
  assert.equal(delegated.value.owner, "invaders-2");

  const bare = createMarketBundle({ userDataDir: tempDir(), appDir: ROOT });
  const notReady = await bare.execute("market/update/status", {}, session);
  assert.equal(notReady.ok, false);
  assert.equal(notReady.error, "MARKET_UPDATE_NOT_READY");

  // 既有本地市场命令不受影响
  const health = await market.execute("market/health", {}, session);
  assert.equal(health.ok, true);
  assert.equal(health.value.source, "local");
});

test("⑨c trusted 边界：market:command 缺 isTrusted / 伪造 sender 一律 Forbidden", async () => {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
    invoke: (channel, event, payload) => handlers.get(channel)(event, payload),
  };
  const { bundle } = makeBundle({ releases: [makeRelease("0.1.0")] });
  const market = createMarketBundle({ userDataDir: tempDir(), appDir: ROOT, updateService: bundle });
  const trustedSender = { id: "w" };
  const trustedUrl = "file:///app/index.html";
  const trustedGate = (event) => !!event && event.sender === trustedSender && !!event.senderFrame && event.senderFrame.url === trustedUrl;
  const trustedEvent = () => ({ sender: trustedSender, senderFrame: { url: trustedUrl } });
  const fakeEvent = () => ({ sender: { id: "evil" }, senderFrame: { url: "https://evil.example/" } });

  try {
    registerMarketIpc({ ipcMain, bundle: market, identity: { current: "sess-1" } });
    await assert.rejects(() => ipcMain.invoke("market:command", trustedEvent(), { command: "market/update/status" }), /Forbidden/);

    registerMarketIpc({ ipcMain, bundle: market, identity: { current: "sess-1" }, isTrusted: trustedGate });
    await assert.rejects(() => ipcMain.invoke("market:command", fakeEvent(), { command: "market/update/status" }), /Forbidden/);
    const ok = await ipcMain.invoke("market:command", trustedEvent(), { command: "market/update/status" });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.value.appId, "canvas");
  } finally {
    disposeMarketIpc({ ipcMain });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑩ 审计
// ═══════════════════════════════════════════════════════════════════════════
test("⑩ install / rollback 写授权审计（authStore.auditAuthorization 既有用法）", async () => {
  const pkg1 = buildPackage({ version: "0.1.0", privateKey: REPO_KEYPAIR.privateKey });
  const pkg2 = buildPackage({ version: "0.2.0", privateKey: REPO_KEYPAIR.privateKey });
  const badManifest = Buffer.from(JSON.stringify({
    format: "openarc-app/v1", id: "canvas", name: "HACKED", version: "0.3.0", build: 1,
    entry: "index.js", styles: ["index.css"], files: { "index.js": "a".repeat(64), "index.css": "b".repeat(64) },
  }));
  const bad = buildPackage({ version: "0.3.0", privateKey: REPO_KEYPAIR.privateKey, manifestBytesOverride: badManifest });
  const { bundle, audits } = makeBundle({
    releases: [makeRelease("0.1.0"), makeRelease("0.2.0"), makeRelease("0.3.0")],
    routes: {
      [assetUrl("0.1.0")]: () => assetResponse(pkg1),
      [assetUrl("0.2.0")]: () => assetResponse(pkg2),
      [assetUrl("0.3.0")]: () => assetResponse(bad),
    },
  });
  await bundle.execute("market/update/install", { confirm: true, version: "0.1.0" }, { sessionRef: "sess-1", requestId: "req-1" });
  await bundle.execute("market/update/install", { confirm: true, version: "0.2.0" }, { sessionRef: "sess-1" });
  await bundle.execute("market/update/install", { confirm: true, version: "0.3.0" }, { sessionRef: "sess-1" });
  await bundle.execute("market/update/rollback", {}, { sessionRef: "sess-1" });

  const installAllow = audits.find((row) => row.action === "canvas.update.install" && row.decision === "ALLOW");
  assert.ok(installAllow, "install 成功必须写 ALLOW 审计");
  assert.equal(installAllow.appId, "canvas");
  assert.equal(installAllow.actorUserId, "u1");
  assert.equal(installAllow.resourceRef, "canvas@0.1.0");
  assert.equal(installAllow.requestId, "req-1");
  assert.equal(installAllow.permissionSource, "USER");

  const installDeny = audits.find((row) => row.action === "canvas.update.install" && row.decision === "DENY");
  assert.ok(installDeny, "install 失败必须写 DENY 审计");
  assert.equal(installDeny.reasonCode, "MARKET_UPDATE_SIGNATURE_INVALID");

  const rollbackAllow = audits.find((row) => row.action === "canvas.update.rollback" && row.decision === "ALLOW");
  assert.ok(rollbackAllow);
  assert.equal(rollbackAllow.resourceRef, "canvas@0.1.0");
});

// ═══════════════════════════════════════════════════════════════════════════
// sources / 配置 / 真实密钥资源 / 契约接线
// ═══════════════════════════════════════════════════════════════════════════
test("sources：只读回固定仓库与白名单；owner/repo 可配但拒绝任意 URL", async () => {
  const { bundle } = makeBundle({ releases: [] });
  const sources = await bundle.execute("market/update/sources", {}, session);
  assert.equal(sources.ok, true);
  assert.equal(sources.value.owner, "invaders-2");
  assert.equal(sources.value.repo, "OpenArc-OS");
  assert.equal(sources.value.apiUrl, "https://api.github.com/repos/invaders-2/OpenArc-OS/releases?per_page=100");
  assert.deepEqual(sources.value.configurableFields, ["owner", "repo"]);
  for (const host of domain.ALLOWED_HOSTS) assert.ok(sources.value.allowedHosts.includes(host));

  assert.deepEqual(domain.normalizeRepository(null), { owner: "invaders-2", repo: "OpenArc-OS" });
  assert.equal(domain.normalizeRepository({ url: "https://evil.example" }), null);
  assert.equal(domain.normalizeRepository({ owner: "https://evil.example", repo: "x" }), null);
  assert.equal(domain.normalizeRepository({ owner: "ok", repo: "a/b" }), null);
  assert.deepEqual(domain.normalizeRepository({ owner: "acme", repo: "canvas" }), { owner: "acme", repo: "canvas" });

  // 非法配置回落到默认仓库（fail safe）
  const fallback = makeBundle({ releases: [], options: { repository: { owner: "https://evil.example", repo: "x" } } });
  const fallbackSources = await fallback.bundle.execute("market/update/sources", {}, session);
  assert.equal(fallbackSources.value.owner, "invaders-2");
});

test("真实资源与接线：app-update-keys.json / main.cjs / preload.cjs / 脚本齐备", () => {
  const keysFile = path.join(ROOT, "resources", "app-update-keys.json");
  assert.ok(fs.existsSync(keysFile), "必须存在 resources/app-update-keys.json");
  const keys = JSON.parse(fs.readFileSync(keysFile, "utf8"));
  assert.equal(typeof keys.canvas, "string");
  assert.ok(keys.canvas.length >= 40, "canvas 公钥必须是非空 base64");

  const main = fs.readFileSync(path.join(ROOT, "electron", "main.cjs"), "utf8");
  assert.ok(main.includes('require("./market-update-service.cjs")'));
  assert.ok(main.includes("createMarketUpdateBundle({"));
  assert.ok(main.includes("updateService: marketUpdateBundle"));

  const preload = fs.readFileSync(path.join(ROOT, "electron", "preload.cjs"), "utf8");
  assert.ok(preload.includes("marketUpdate:"));
  assert.ok(preload.includes('ipcRenderer.invoke("market:command", command)'));

  assert.ok(fs.existsSync(path.join(ROOT, "scripts", "oa-update-keygen.mjs")));
  assert.ok(fs.existsSync(path.join(ROOT, "scripts", "oa-canvas-package.mjs")));
  assert.ok(fs.existsSync(path.join(ROOT, "docs", "canvas-online-update.md")));
});

test("preload：marketUpdate.command 只走 market:command（vm 沙箱真实执行 preload）", async () => {
  const source = fs.readFileSync(path.join(ROOT, "electron", "preload.cjs"), "utf8");
  const exposed = {};
  const calls = [];
  const electronStub = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); }, on: () => {}, removeListener: () => {}, send: () => {} },
    webUtils: { getPathForFile: () => null },
  };
  vm.runInNewContext(source, {
    require: (id) => { if (id === "electron") return electronStub; throw new Error("unexpected require: " + id); },
    module: { exports: {} }, exports: {}, console, process, Buffer,
    __dirname: path.dirname(path.join(ROOT, "electron", "preload.cjs")),
    __filename: path.join(ROOT, "electron", "preload.cjs"),
  }, { filename: "preload.cjs" });

  const api = exposed.openarc;
  assert.deepEqual(Object.keys(api.marketUpdate), ["command"]);
  await api.marketUpdate.command({ command: "market/update/status", payload: {} });
  assert.deepEqual(calls[0], ["market:command", { command: "market/update/status", payload: {} }]);
  assert.ok(api.market.command({ command: "market/health" }) instanceof Promise);
});

test("源码级：更新纯函数域不发起网络；服务端只经注入 fetch 且逐跳校验重定向", () => {
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const domainSource = stripComments(fs.readFileSync(path.join(ROOT, "electron", "market-update-domain.cjs"), "utf8"));
  assert.equal(/\bfetch\s*\(/.test(domainSource), false, "纯函数域不得有 fetch(");
  assert.equal(/require\(["']node:https?["']\)/.test(domainSource), false, "纯函数域不得引入 http 客户端");

  const serviceSource = fs.readFileSync(path.join(ROOT, "electron", "market-update-service.cjs"), "utf8");
  assert.ok(serviceSource.includes('redirect: "manual"'), "必须手动跟重定向以逐跳校验主机");
  assert.ok(serviceSource.includes("assertAllowedUrl"));
  assert.ok(serviceSource.includes("verifyManifestSignature"));
  assert.ok(serviceSource.includes("auditAuthorization"));
  assert.ok(!serviceSource.includes(".keys/"), "服务端不得引用私钥路径");
});

// ── 仓库密钥 → 打包脚本产物：真实签名链路（需要本地 .keys，缺则跳过） ─────────
const REPO_KEY_PATH = path.join(ROOT, ".keys", "update-signing.key");
test("真实打包产物（dist-updates/canvas-0.1.0.zip）能用仓库公钥验签并安装", { skip: !fs.existsSync(REPO_KEY_PATH) || !fs.existsSync(path.join(ROOT, "dist-updates", "canvas-0.1.0.zip")) }, async () => {
  const zipBytes = fs.readFileSync(path.join(ROOT, "dist-updates", "canvas-0.1.0.zip"));
  const dir = tempDir();
  const audits = [];
  const releases = [makeRelease("0.1.0")];
  const installed = createMarketUpdateBundle({
    userDataDir: dir,
    keysFile: path.join(ROOT, "resources", "app-update-keys.json"),
    fetchImpl: makeFetch({ [API_URL]: () => jsonResponse(releases), [assetUrl("0.1.0")]: () => assetResponse(zipBytes) }),
    authorization: makeAuthorization(audits),
    sourceKind: "github-releases",
    builtinVersion: "0.0.1",
    clock: () => 1_700_000_000_000,
  });
  const res = await installed.execute("market/update/install", { confirm: true }, session);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.installed.version, "0.1.0");
});

// ═══════════════════════════════════════════════════════════════════════════
// ModelScope 仓库源（离线：全部经注入 fetchImpl，不接触真实主机）
// ═══════════════════════════════════════════════════════════════════════════
const MS_OWNER = "bllack";
const MS_REPO = "OpenArc-OS";
const MS_MANIFEST_PATH = sourceAdapters.MANIFEST_PATH;

function msRevisionsRoute(branches, tags) {
  return {
    [sourceAdapters.modelscopeRevisionsUrl(MS_OWNER, MS_REPO)]: () => jsonResponse({
      Code: 200,
      Data: { RevisionMap: { Branches: branches, Tags: tags } },
      Message: "success",
      Success: true,
    }),
  };
}

/** 单个 revision 的 files + manifest + asset 路由；默认 version/build/asset/sha256 自洽。 */
function msRevisionRoutes(version, revision, {
  privateKey = REPO_KEYPAIR.privateKey,
  includeManifest = true,
  manifestJson = null,
  manifestListingSha = null,
  assetListingSha = null,
  tamperAsset = false,
  assetPath = null,
} = {}) {
  const zip = buildPackage({ version, privateKey });
  const asset = assetPath || ("updates/canvas/canvas-" + version + ".zip");
  const manifestBytes = manifestJson != null
    ? Buffer.from(manifestJson)
    : Buffer.from(JSON.stringify({ version, build: 1, asset, sha256: sha256hex(zip) }));
  const files = [];
  if (includeManifest) {
    files.push({ Path: MS_MANIFEST_PATH, Size: manifestBytes.length, Sha256: manifestListingSha || sha256hex(manifestBytes), Type: "blob" });
  }
  files.push({ Path: asset, Size: zip.length, Sha256: assetListingSha || sha256hex(zip), Type: "blob" });
  return {
    zip, asset, manifestBytes, files,
    routes: {
      [sourceAdapters.modelscopeFilesUrl(MS_OWNER, MS_REPO, revision)]: () => jsonResponse({ Code: 200, Data: { Files: files }, Success: true }),
      [sourceAdapters.modelscopeDownloadUrl(MS_OWNER, MS_REPO, revision, MS_MANIFEST_PATH)]: () => assetResponse(manifestBytes),
      [sourceAdapters.modelscopeDownloadUrl(MS_OWNER, MS_REPO, revision, asset)]: () => assetResponse(tamperAsset ? Buffer.from("/* tampered */") : zip),
    },
  };
}

function makeModelBundle(routes, options = {}) {
  return makeBundle({ options: { sourceKind: "modelscope-repo", ...options }, routes });
}

test("M1 源注册表与纯解析：两个实现齐备，GitHub 源仍走既有 domain 纯函数", () => {
  assert.deepEqual(sourceAdapters.sourceKinds().sort(), ["github-releases", "modelscope-repo"]);
  assert.equal(sourceAdapters.isSourceKind("github-releases"), true);
  assert.equal(sourceAdapters.isSourceKind("nope"), false);
  assert.equal(sourceAdapters.getSourceDescriptor("nope"), null);
  assert.equal(domain.DEFAULT_SOURCE_KIND, "modelscope-repo", "默认源必须是 ModelScope");
  assert.deepEqual(sourceAdapters.defaultRepositoryFor("modelscope-repo"), { owner: "bllack", repo: "OpenArc-OS" });
  assert.deepEqual(sourceAdapters.defaultRepositoryFor("github-releases"), { owner: "invaders-2", repo: "OpenArc-OS" });
  assert.equal(sourceAdapters.MANIFEST_PATH, "updates/canvas/latest.json");
  assert.ok(domain.MARKET_UPDATE_ERROR_CODES.includes("MARKET_UPDATE_SOURCE_DIGEST_MISMATCH"));

  assert.deepEqual(
    sourceAdapters.parseRevisionMap({ Data: { RevisionMap: { Branches: [{ Revision: "master" }], Tags: [{ Tag: "canvas-v1", Revision: "sha1" }] } } }),
    { branch: "master", tags: [{ name: "canvas-v1", revision: "sha1" }] },
  );
  assert.equal(sourceAdapters.parseRevisionMap({}), null);
  const files = sourceAdapters.parseFileList({ Data: { Files: [{ Path: "a/b.zip", Size: 10, Sha256: "A".repeat(64), IsLFS: true }] } });
  assert.equal(files[0].sha256, "a".repeat(64));
  assert.equal(files[0].isLfs, true);
  assert.equal(sourceAdapters.parseFileList({}), null);

  const missingFields = sourceAdapters.normalizeModelscopeManifest({ version: "1.2.3" });
  assert.equal(missingFields.ok, false);
  assert.equal(missingFields.error.code, "MARKET_UPDATE_INVALID_INPUT");
  const assetMismatch = sourceAdapters.normalizeModelscopeManifest({ version: "1.2.3", build: 1, asset: "updates/canvas/canvas-9.9.9.zip", sha256: "c".repeat(64) });
  assert.equal(assetMismatch.ok, false);
  const good = sourceAdapters.normalizeModelscopeManifest({ version: "1.2.3", build: 7, asset: "updates/canvas/canvas-1.2.3.zip", sha256: "c".repeat(64) });
  assert.equal(good.ok, true);
  assert.equal(good.value.build, 7);
});

test("M2 ModelScope master 清单：check 发现版本 + 完整离线 install（清单→下载→验签→验摘要→安装）", async () => {
  const fixture = msRevisionRoutes("0.1.0", "master");
  const { bundle, dir } = makeModelBundle({ ...msRevisionsRoute([{ Revision: "master" }], []), ...fixture.routes });

  const check = await bundle.execute("market/update/check", {}, session);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(check.value.latest.version, "0.1.0");
  assert.equal(check.value.updateAvailable, true);
  assert.deepEqual(check.value.source, { kind: "modelscope-repo", owner: "bllack", repo: "OpenArc-OS" });

  const install = await bundle.execute("market/update/install", { confirm: true }, session);
  assert.equal(install.ok, true, JSON.stringify(install));
  assert.equal(install.value.installed.version, "0.1.0");
  assert.match(install.value.installed.digest, /^[a-f0-9]{64}$/);
  const stateDir = canvasStateDir(dir);
  assert.equal(readJson(path.join(stateDir, "current.json")).version, "0.1.0");
  for (const name of ["index.js", "index.css", "manifest.json", "manifest.sig"]) {
    assert.ok(fs.existsSync(path.join(stateDir, "0.1.0", name)), "缺少 " + name);
  }
});

test("M3 ModelScope 仓库还没有清单 → check 如实回「无可用更新」，install → NO_RELEASE", async () => {
  const fixture = msRevisionRoutes("0.1.0", "master", { includeManifest: false });
  const { bundle } = makeModelBundle({ ...msRevisionsRoute([{ Revision: "master" }], []), ...fixture.routes });

  const check = await bundle.execute("market/update/check", {}, session);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(check.value.latest, null);
  assert.equal(check.value.updateAvailable, false);

  const install = await bundle.execute("market/update/install", { confirm: true }, session);
  assert.equal(install.ok, false);
  assert.equal(install.error, "MARKET_UPDATE_NO_RELEASE");
});

test("M4 ModelScope 清单格式错（非法 JSON / 缺字段）→ INVALID_INPUT", async () => {
  const brokenJson = msRevisionRoutes("0.1.0", "master", { manifestJson: "{" });
  const b1 = makeModelBundle({ ...msRevisionsRoute([{ Revision: "master" }], []), ...brokenJson.routes });
  const r1 = await b1.bundle.execute("market/update/check", {}, session);
  assert.equal(r1.ok, false);
  assert.equal(r1.error, "MARKET_UPDATE_INVALID_INPUT", JSON.stringify(r1));

  const missingFields = msRevisionRoutes("0.1.0", "master", { manifestJson: JSON.stringify({ version: "0.1.0" }) });
  const b2 = makeModelBundle({ ...msRevisionsRoute([{ Revision: "master" }], []), ...missingFields.routes });
  const r2 = await b2.bundle.execute("market/update/check", {}, session);
  assert.equal(r2.ok, false);
  assert.equal(r2.error, "MARKET_UPDATE_INVALID_INPUT", JSON.stringify(r2));
});

test("M5 ModelScope tags 路径：分支与 tag 都探测，取语义化最高；tags-only 也能定位清单", async () => {
  const branch = msRevisionRoutes("0.1.0", "master");
  const tag = msRevisionRoutes("0.2.0", "tagsha");
  const both = makeModelBundle({
    ...msRevisionsRoute([{ Revision: "master" }], [{ Tag: "canvas-v0.2.0", Revision: "tagsha" }]),
    ...branch.routes,
    ...tag.routes,
  });
  const check = await both.bundle.execute("market/update/check", {}, session);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(check.value.latest.version, "0.2.0", "tag 上的更高版本必须被发现");
  const calledUrls = both.fetchImpl.calls.map((call) => call.url);
  assert.ok(calledUrls.includes(sourceAdapters.modelscopeFilesUrl(MS_OWNER, MS_REPO, "master")), "必须探测 master 分支");
  assert.ok(calledUrls.includes(sourceAdapters.modelscopeFilesUrl(MS_OWNER, MS_REPO, "tagsha")), "必须探测 tag revision");

  const tagsOnly = makeModelBundle({
    ...msRevisionsRoute([], [{ Tag: "canvas-v0.3.0", Revision: "tagsha2" }]),
    ...msRevisionRoutes("0.3.0", "tagsha2").routes,
  });
  const tagsOnlyCheck = await tagsOnly.bundle.execute("market/update/check", {}, session);
  assert.equal(tagsOnlyCheck.ok, true, JSON.stringify(tagsOnlyCheck));
  assert.equal(tagsOnlyCheck.value.latest.version, "0.3.0");
});

test("M6 ModelScope 交叉摘要：资产与文件清单 Sha256 不一致 → SOURCE_DIGEST_MISMATCH，不落地", async () => {
  const tampered = msRevisionRoutes("0.1.0", "master", { tamperAsset: true });
  const b1 = makeModelBundle({ ...msRevisionsRoute([{ Revision: "master" }], []), ...tampered.routes });
  const check1 = await b1.bundle.execute("market/update/check", {}, session);
  assert.equal(check1.ok, true, JSON.stringify(check1), "清单本身合法，check 应通过");
  const install1 = await b1.bundle.execute("market/update/install", { confirm: true }, session);
  assert.equal(install1.ok, false, JSON.stringify(install1));
  assert.equal(install1.error, "MARKET_UPDATE_SOURCE_DIGEST_MISMATCH");
  assert.equal(fs.existsSync(path.join(canvasStateDir(b1.dir), "0.1.0")), false);

  const listingMismatch = msRevisionRoutes("0.1.0", "master", { assetListingSha: "b".repeat(64) });
  const b2 = makeModelBundle({ ...msRevisionsRoute([{ Revision: "master" }], []), ...listingMismatch.routes });
  const r2 = await b2.bundle.execute("market/update/check", {}, session);
  assert.equal(r2.ok, false);
  assert.equal(r2.error, "MARKET_UPDATE_SOURCE_DIGEST_MISMATCH", JSON.stringify(r2));

  const manifestMismatch = msRevisionRoutes("0.1.0", "master", { manifestListingSha: "d".repeat(64) });
  const b3 = makeModelBundle({ ...msRevisionsRoute([{ Revision: "master" }], []), ...manifestMismatch.routes });
  const r3 = await b3.bundle.execute("market/update/check", {}, session);
  assert.equal(r3.ok, false);
  assert.equal(r3.error, "MARKET_UPDATE_SOURCE_DIGEST_MISMATCH", JSON.stringify(r3));
});

test("M7 ModelScope 主机白名单：观测到的 CDN 重定向可跟，越界主机逐跳拒绝", async () => {
  assert.equal(domain.isAllowedUrl("https://modelscope.cn/x", domain.MODELSCOPE_REPO_HOSTS), true);
  assert.equal(domain.isAllowedUrl("https://cdn-lfs-cn-1.modelscope.cn/x", domain.MODELSCOPE_REPO_HOSTS), true);
  assert.equal(domain.isAllowedUrl("https://cdn-lfs-us-1.modelscope.cn/x", domain.MODELSCOPE_REPO_HOSTS), false, "未观测到的 CDN 分片必须拒绝");
  assert.equal(domain.isAllowedUrl("https://api.github.com/x", domain.MODELSCOPE_REPO_HOSTS), false, "跨源主机必须拒绝");
  assert.equal(domain.isAllowedUrl("https://modelscope.cn/x", domain.GITHUB_RELEASES_HOSTS), false, "GitHub 源不得访问 ModelScope");

  const fixture = msRevisionRoutes("0.1.0", "master");
  const filesUrl = sourceAdapters.modelscopeFilesUrl(MS_OWNER, MS_REPO, "master");
  const manifestUrl = sourceAdapters.modelscopeDownloadUrl(MS_OWNER, MS_REPO, "master", MS_MANIFEST_PATH);
  const assetUrlMs = sourceAdapters.modelscopeDownloadUrl(MS_OWNER, MS_REPO, "master", fixture.asset);

  const allowed = makeModelBundle({
    ...msRevisionsRoute([{ Revision: "master" }], []),
    [filesUrl]: () => jsonResponse({ Data: { Files: fixture.files } }),
    [manifestUrl]: () => assetResponse(fixture.manifestBytes),
    [assetUrlMs]: () => redirectResponse("https://cdn-lfs-cn-1.modelscope.cn/prod/canvas-0.1.0.zip"),
    "https://cdn-lfs-cn-1.modelscope.cn/prod/canvas-0.1.0.zip": () => assetResponse(fixture.zip),
  });
  const okInstall = await allowed.bundle.execute("market/update/install", { confirm: true }, session);
  assert.equal(okInstall.ok, true, JSON.stringify(okInstall));

  const denied = makeModelBundle({
    ...msRevisionsRoute([{ Revision: "master" }], []),
    [filesUrl]: () => jsonResponse({ Data: { Files: fixture.files } }),
    [manifestUrl]: () => assetResponse(fixture.manifestBytes),
    [assetUrlMs]: () => redirectResponse("https://evil.example/canvas-0.1.0.zip"),
  });
  const deniedInstall = await denied.bundle.execute("market/update/install", { confirm: true }, session);
  assert.equal(deniedInstall.ok, false, JSON.stringify(deniedInstall));
  assert.equal(deniedInstall.error, "MARKET_UPDATE_HOST_NOT_ALLOWED");
});

test("M8 源切换：默认源为 ModelScope；显式切 GitHub 持久化且不被新默认覆盖；非法 kind / owner / repo 被拒", async () => {
  const dir = tempDir();
  const keysFile = writeKeysFile(dir, REPO_KEYPAIR.publicKeyBase64);
  const make = (routes = {}) => createMarketUpdateBundle({
    userDataDir: dir,
    keysFile,
    fetchImpl: makeFetch(routes),
    authorization: makeAuthorization([]),
    builtinVersion: "0.0.1",
    clock: () => 1_700_000_000_000,
  });

  const a = make({});
  const before = await a.execute("market/update/sources", {}, session);
  assert.equal(before.value.kind, "modelscope-repo", "默认源必须为 ModelScope");
  assert.equal(before.value.owner, "bllack");
  assert.equal(before.value.repo, "OpenArc-OS");
  assert.deepEqual(before.value.selected, { kind: "modelscope-repo", owner: "bllack", repo: "OpenArc-OS" });
  assert.equal(before.value.defaultSource.kind, "modelscope-repo");
  assert.equal(before.value.manifestPath, "updates/canvas/latest.json");
  assert.deepEqual(before.value.sources.map((item) => item.kind).sort(), ["github-releases", "modelscope-repo"]);
  assert.equal(fs.existsSync(globalSourceFile(dir)), false, "从未选择过就不写 source.json");
  assert.equal(fs.existsSync(path.join(canvasStateDir(dir), "source.json")), false, "旧位置的 source.json 也不再被写入");

  const statusBefore = await a.execute("market/update/status", {}, session);
  assert.deepEqual(statusBefore.value.source, { kind: "modelscope-repo", owner: "bllack", repo: "OpenArc-OS" }, "status.source 必须反映新默认");

  const set = await a.execute("market/update/source/set", { kind: "github-releases" }, session);
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.value.kind, "github-releases");
  assert.equal(set.value.owner, "invaders-2");
  assert.equal(set.value.repo, "OpenArc-OS");
  assert.equal(set.value.apiUrl, "https://api.github.com/repos/invaders-2/OpenArc-OS/releases?per_page=100");
  assert.equal(set.value.manifestPath, null);
  assert.deepEqual(readJson(globalSourceFile(dir)), { kind: "github-releases", owner: "invaders-2", repo: "OpenArc-OS" });

  const b = make({ [API_URL]: () => jsonResponse([makeRelease("0.4.0")]) });
  const after = await b.execute("market/update/sources", {}, session);
  assert.equal(after.value.kind, "github-releases", "已持久化的显式选择必须优先于新默认");
  assert.deepEqual(after.value.selected, { kind: "github-releases", owner: "invaders-2", repo: "OpenArc-OS" });
  assert.equal(after.value.defaultRepository.owner, "invaders-2", "顶层 defaultRepository 仍是 GitHub 默认（legacy 字段）");
  const githubCheck = await b.execute("market/update/check", {}, session);
  assert.equal(githubCheck.ok, true, JSON.stringify(githubCheck));
  assert.deepEqual(githubCheck.value.source, { kind: "github-releases", owner: "invaders-2", repo: "OpenArc-OS" }, "显式选 GitHub 后 check 必须走 GitHub 源");
  assert.equal(githubCheck.value.latest.version, "0.4.0");

  const custom = await a.execute("market/update/source/set", { kind: "modelscope-repo", owner: "acme", repo: "canvas-mirror" }, session);
  assert.equal(custom.ok, true, JSON.stringify(custom));
  assert.equal(custom.value.owner, "acme");
  assert.equal(custom.value.repo, "canvas-mirror");

  for (const payload of [
    { kind: "nope" },
    { kind: "github-releases", owner: "https://evil.example", repo: "x" },
    { kind: "github-releases", owner: "ok", repo: "a/b" },
    { kind: "github-releases", owner: "a b", repo: "x" },
    { kind: "modelscope-repo", owner: 123, repo: "x" },
  ]) {
    const denied = await a.execute("market/update/source/set", payload, session);
    assert.equal(denied.ok, false, JSON.stringify(denied));
    assert.equal(denied.error, "MARKET_UPDATE_INVALID_INPUT", JSON.stringify(payload) + " → " + JSON.stringify(denied));
  }
  assert.deepEqual(readJson(globalSourceFile(dir)), { kind: "modelscope-repo", owner: "acme", repo: "canvas-mirror" });
});

test("M9 持久化优先：已存在的 source.json（旧默认 GitHub）不被新默认 ModelScope 覆盖", async () => {
  const dir = tempDir();
  const keysFile = writeKeysFile(dir, REPO_KEYPAIR.publicKeyBase64);
  const stateDir = canvasStateDir(dir);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "source.json"), JSON.stringify({ kind: "github-releases", owner: "invaders-2", repo: "OpenArc-OS" }));

  const bundle = createMarketUpdateBundle({
    userDataDir: dir,
    keysFile,
    fetchImpl: makeFetch({}),
    authorization: makeAuthorization([]),
    builtinVersion: "0.0.1",
    clock: () => 1_700_000_000_000,
  });
  assert.deepEqual(bundle.readSourceSelection(), { kind: "github-releases", owner: "invaders-2", repo: "OpenArc-OS" });
  assert.equal(bundle.sourceKind, "github-releases");

  const sources = await bundle.execute("market/update/sources", {}, session);
  assert.deepEqual(sources.value.selected, { kind: "github-releases", owner: "invaders-2", repo: "OpenArc-OS" });
  assert.equal(sources.value.defaultSource.kind, "modelscope-repo", "新默认仅对从未选择过的用户生效");
  const status = await bundle.execute("market/update/status", {}, session);
  assert.deepEqual(status.value.source, { kind: "github-releases", owner: "invaders-2", repo: "OpenArc-OS" });
  assert.deepEqual(readJson(path.join(stateDir, "source.json")), { kind: "github-releases", owner: "invaders-2", repo: "OpenArc-OS" }, "构造 / 读取不得改写已保存的选择");
});

