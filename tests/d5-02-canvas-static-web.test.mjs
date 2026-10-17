/**
 * Stage 2 · 无限画布 static-web 包格式 + 「已安装优先 / 结构化回退」+ 只读协议边界。
 *
 * 纯离线单测（不联网、不启动 Electron、不新增依赖）：
 *   · manifest kind:"static-web" 校验通过 / 字段缺失或非法拒绝（老 js-module 形态仍兼容）；
 *   · 协议生效顺序：已安装版本优先，dist/public 只在安装不可用时保底；
 *   · 回退矩阵：指针缺失/损坏/目录缺失/签名坏/摘要坏/非 static-web/占位包 → 全部内置 + 结构化 reason；
 *   · 只读协议：目录穿越 / 反斜杠 / 未知扩展名 / 畸形百分号编码一律拒绝；
 *   · 全部不可用 → 503 + 说明页（不静默 500、不白屏）。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const domain = require("../electron/market-update-domain.cjs");
const resolverModule = require("../electron/canvas-package-resolver.cjs");
const { createCanvasBundleResolver, readCanvasPointer, CANVAS_BUNDLE_FALLBACK_REASONS } = resolverModule;

const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-canvas-static-web-")); tmpDirs.push(dir); return dir; }
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const STATE_REL = path.join("dxos", "apps", "canvas");

function makeKeyFixture(dir) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  const keysFile = path.join(dir, "app-update-keys.json");
  fs.writeFileSync(keysFile, JSON.stringify({ canvas: der.subarray(der.length - 32).toString("base64") }));
  return { privateKey, keysFile };
}

/** 直接落一个「已安装版本」目录（等价于市场服务安装后的落盘结果）。 */
function writeInstalled(userDataDir, { version, privateKey, files, pointer = {}, manifestPatch = null, digestOverride = undefined }) {
  const stateDir = path.join(userDataDir, STATE_REL);
  const dir = path.join(stateDir, version);
  fs.mkdirSync(dir, { recursive: true });
  const hashes = {};
  for (const [rel, buffer] of Object.entries(files)) hashes[rel] = sha256(Buffer.from(buffer));
  let manifest = { format: "openarc-app/v1", id: "canvas", name: "无限画布", version, build: 1, kind: "static-web", entry: "static/canvas-list.html", files: hashes };
  if (manifestPatch) manifest = { ...manifest, ...manifestPatch };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "manifest.json"), manifestBytes);
  fs.writeFileSync(path.join(dir, "manifest.sig"), Buffer.from(crypto.sign(null, manifestBytes, privateKey).toString("base64"), "utf8"));
  for (const [rel, buffer] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buffer);
  }
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "current.json"), JSON.stringify({
    version,
    digest: digestOverride === undefined ? domain.packageDigest(manifestBytes) : digestOverride,
    kind: manifest.kind || "js-module",
    entry: manifest.entry,
    installedAt: 1,
    ...pointer,
  }));
  return { stateDir, dir, manifestBytes };
}

/** 重写并重新签名 manifest（用于制造 placeholder / 非 static-web / 坏摘要等回退场景）。 */
function patchManifest(dir, privateKey, patch) {
  const raw = { ...JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")), ...patch };
  const bytes = Buffer.from(JSON.stringify(raw));
  fs.writeFileSync(path.join(dir, "manifest.json"), bytes);
  fs.writeFileSync(path.join(dir, "manifest.sig"), crypto.sign(null, bytes, privateKey).toString("base64"));
  return bytes;
}

function builtinTree(dir, label = "BUILTIN") {
  fs.mkdirSync(path.join(dir, "static", "js"), { recursive: true });
  fs.writeFileSync(path.join(dir, "static", "canvas-list.html"), "<!doctype html><title>" + label + "</title>");
  fs.writeFileSync(path.join(dir, "static", "canvas.html"), "<!doctype html><title>editor</title>");
  fs.writeFileSync(path.join(dir, "static", "js", "app.js"), "window.__bundle = " + JSON.stringify(label) + ";");
  return dir;
}

function makeResolver(userDataDir, { keysFile, distRoot, publicRoot }) {
  return createCanvasBundleResolver({ userDataDir, keysFile, distRoot, publicRoot });
}

const FILES = { "static/canvas-list.html": "<!doctype html><title>INSTALLED</title>", "static/js/app.js": "window.__v='install'" };

// ═══════════════════════════════════════════════════════════════════════════
// ① manifest：static-web 校验
// ═══════════════════════════════════════════════════════════════════════════
test("static-web manifest：合法通过（kind/entry/files），字段缺失或非法一律拒绝", () => {
  const good = {
    format: "openarc-app/v1", id: "canvas", kind: "static-web", name: "无限画布", version: "0.2.0", build: 3,
    entry: "static/canvas-list.html",
    files: { "static/canvas-list.html": "a".repeat(64), "static/js/app.js": "b".repeat(64) },
  };
  const ok = domain.normalizeManifest(good);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.kind, "static-web");
  assert.equal(ok.value.entry, "static/canvas-list.html");
  assert.deepEqual(ok.value.styles, []);
  assert.equal(ok.value.placeholder, false);
  assert.deepEqual(Object.keys(ok.value.files), ["static/canvas-list.html", "static/js/app.js"]);

  const cases = [
    [{ ...good, kind: "vue" }, /kind/],
    [{ ...good, kind: undefined }, /entry/],
    [{ ...good, entry: undefined }, /安全/],
    [{ ...good, entry: "../../etc/passwd.html" }, /安全/],
    [{ ...good, entry: "static/canvas-list.txt" }, /html/],
    [{ ...good, entry: "static/other.html" }, /必须包含 entry/],
    [{ ...good, files: {} }, /不能为空/],
    [{ ...good, files: { "static/canvas-list.html": "zz" } }, /sha256/],
    [{ ...good, files: { "../escape.html": "a".repeat(64) } }, /不安全文件名/],
  ];
  for (const [bad, re] of cases) {
    const res = domain.normalizeManifest(bad);
    assert.equal(res.ok, false, "应拒绝：" + JSON.stringify(bad));
    assert.match(res.error.message, re);
  }

  const legacy = domain.normalizeManifest({
    format: "openarc-app/v1", id: "canvas", name: "无限画布", version: "0.1.0", build: 1,
    entry: "index.js", styles: ["index.css"], files: { "index.js": "a".repeat(64), "index.css": "b".repeat(64) },
  });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.value.kind, "js-module");
  assert.equal(legacy.value.entry, "index.js");
  assert.equal(domain.normalizeManifest({ ...good, placeholder: true }).value.placeholder, true);
  assert.equal(domain.CANVAS_STATIC_ENTRY, "static/canvas-list.html");
  assert.ok(CANVAS_BUNDLE_FALLBACK_REASONS.includes("pointer-missing"));
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 生效顺序：已安装优先
// ═══════════════════════════════════════════════════════════════════════════
test("协议：已安装 static-web 版本优先于内置 bundle，响应头给出生效来源与版本", async () => {
  const userData = tempDir();
  const distRoot = builtinTree(path.join(tempDir(), "dist"), "BUILTIN");
  const { privateKey, keysFile } = makeKeyFixture(tempDir());
  writeInstalled(userData, { version: "0.2.0", privateKey, files: FILES });
  const resolver = makeResolver(userData, { keysFile, distRoot, publicRoot: path.join(tempDir(), "none") });

  const resolved = resolver.resolve();
  assert.equal(resolved.ok, true);
  assert.equal(resolved.source, "installed");
  assert.equal(resolved.version, "0.2.0");
  assert.ok(resolved.root.endsWith(path.join("apps", "canvas", "0.2.0")), resolved.root);
  assert.equal(resolved.fallbackReason, null);

  const res = await resolver.handle("openarc-canvas://bundle/static/canvas-list.html");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("x-openarc-canvas-source"), "installed");
  assert.equal(res.headers.get("x-openarc-canvas-version"), "0.2.0");
  assert.match(await res.text(), /INSTALLED/);

  // pointer 每次请求都重读：删掉指针后同一个 resolver 下一次请求应回退内置。
  fs.rmSync(path.join(resolver.stateDir, "current.json"));
  const fallback = await resolver.handle("openarc-canvas://bundle/static/canvas-list.html");
  assert.equal(fallback.headers.get("x-openarc-canvas-source"), "dist");
  assert.equal(fallback.headers.get("x-openarc-canvas-fallback"), "pointer-missing");
  assert.match(await fallback.text(), /BUILTIN/);
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 回退矩阵
// ═══════════════════════════════════════════════════════════════════════════
test("回退矩阵：任一环失败都回落内置 bundle，并给出结构化 reason", async () => {
  const cases = [
    { reason: "pointer-missing", mutate: ({ stateDir }) => fs.rmSync(path.join(stateDir, "current.json")) },
    { reason: "pointer-invalid", mutate: ({ stateDir }) => fs.writeFileSync(path.join(stateDir, "current.json"), "{ not json") },
    // 显式回退到内置版本（market/update/rollback 写的内置标记）：正常状态，不是损坏。
    { reason: "pointer-cleared", mutate: ({ stateDir }) => fs.writeFileSync(path.join(stateDir, "current.json"), JSON.stringify({ mode: "builtin", version: null, builtinVersion: "0.1.0", rolledBackFrom: "0.2.0", clearedAt: 1 })) },
    { reason: "version-dir-missing", mutate: ({ dir }) => fs.rmSync(dir, { recursive: true, force: true }) },
    { reason: "pointer-digest-mismatch", mutate: ({ stateDir }) => { const f = path.join(stateDir, "current.json"); const raw = JSON.parse(fs.readFileSync(f, "utf8")); raw.digest = "f".repeat(64); fs.writeFileSync(f, JSON.stringify(raw)); } },
    { reason: "signature-invalid", mutate: ({ dir }) => fs.writeFileSync(path.join(dir, "manifest.sig"), "AAAA") },
    { reason: "digest-mismatch", mutate: ({ dir }) => fs.writeFileSync(path.join(dir, "static", "js", "app.js"), "TAMPERED") },
    { reason: "file-missing", mutate: ({ dir }) => fs.rmSync(path.join(dir, "static", "js", "app.js")) },
    { reason: "placeholder", mutate: ({ dir, privateKey }) => patchManifest(dir, privateKey, { placeholder: true }) },
    { reason: "not-static-web", mutate: ({ dir, privateKey }) => {
      fs.writeFileSync(path.join(dir, "index.js"), "legacy");
      fs.writeFileSync(path.join(dir, "index.css"), ".legacy{}");
      patchManifest(dir, privateKey, {
        kind: "js-module", entry: "index.js", styles: ["index.css"],
        files: { "index.js": sha256(Buffer.from("legacy")), "index.css": sha256(Buffer.from(".legacy{}")) },
      });
    } },
  ];
  for (const scenario of cases) {
    const userData = tempDir();
    const distRoot = builtinTree(path.join(tempDir(), "dist"), "BUILTIN");
    const { privateKey, keysFile } = makeKeyFixture(tempDir());
    const setup = writeInstalled(userData, { version: "0.2.0", privateKey, files: { ...FILES } });
    scenario.mutate({ ...setup, privateKey, keysFile });
    const resolver = makeResolver(userData, { keysFile, distRoot, publicRoot: path.join(tempDir(), "none") });
    const resolved = resolver.resolve();
    assert.equal(resolved.ok, true, scenario.reason);
    assert.equal(resolved.source, "dist", scenario.reason + " :: " + JSON.stringify(resolved));
    assert.equal(resolved.fallbackReason, scenario.reason, scenario.reason + " :: " + JSON.stringify(resolved));
    const res = await resolver.handle("openarc-canvas://bundle/static/canvas-list.html");
    assert.equal(res.status, 200, scenario.reason);
    assert.equal(res.headers.get("x-openarc-canvas-fallback"), scenario.reason, scenario.reason);
    assert.equal(res.headers.get("x-openarc-canvas-source"), "dist", scenario.reason);
    const body = await res.text();
    assert.match(body, /BUILTIN/, scenario.reason);
  }
});

test("回退：public 是最后一档保底；dist 缺失时用 public", async () => {
  const userData = tempDir();
  const publicRoot = builtinTree(path.join(tempDir(), "public"), "PUBLIC-BUILTIN");
  const { keysFile } = makeKeyFixture(tempDir());
  const resolver = makeResolver(userData, { keysFile, distRoot: path.join(tempDir(), "no-dist"), publicRoot });
  const resolved = resolver.resolve();
  assert.equal(resolved.source, "public");
  assert.equal(resolved.fallbackReason, "pointer-missing");
  const res = await resolver.handle("openarc-canvas://bundle/static/canvas-list.html");
  assert.match(await res.text(), /PUBLIC-BUILTIN/);
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ 只读协议边界
// ═══════════════════════════════════════════════════════════════════════════
test("协议边界：目录穿越 / 反斜杠 / 未知扩展名 / 畸形编码一律拒绝", async () => {
  const userData = tempDir();
  const distRoot = builtinTree(path.join(tempDir(), "dist"), "BUILTIN");
  const { privateKey, keysFile } = makeKeyFixture(tempDir());
  writeInstalled(userData, { version: "0.2.0", privateKey, files: { ...FILES } });
  const resolver = makeResolver(userData, { keysFile, distRoot, publicRoot: path.join(tempDir(), "none") });

  const forbidden = [
    // %2f 不会被 URL 解析成路径分隔符，解码后得到 "static/../secret.html" —— 必须命中 ".." 围栏。
    "openarc-canvas://bundle/static/%2e%2e%2fsecret.html",
    "openarc-canvas://bundle/static%5c..%5csecret.html",
    "openarc-canvas://bundle/static/app.txt",
    "openarc-canvas://bundle/",
  ];
  for (const url of forbidden) {
    const res = await resolver.handle(url);
    assert.equal(res.status, 403, url);
  }
  const malformed = await resolver.handle("openarc-canvas://bundle/%");
  assert.equal(malformed.status, 400);
  // URL 归一化会先把裸 dot-segment 折叠掉：这不是放行，而是归一化后文件不存在（不是 200）。
  const normalizedDot = await resolver.handle("openarc-canvas://bundle/%2e%2e/secret.html");
  assert.notEqual(normalizedDot.status, 200);

  // 允许的静态资源照常返回，且不落到内置 bundle（installed 优先）。
  const js = await resolver.handle("openarc-canvas://bundle/static/js/app.js");
  assert.equal(js.status, 200);
  assert.equal(js.headers.get("content-type"), "text/javascript");
  assert.match(await js.text(), /__v='install'/);
  // 已安装包里不存在的（即使扩展名合法）→ 404，不是 500。
  const missing = await resolver.handle("openarc-canvas://bundle/static/nope.css");
  assert.equal(missing.status, 404);
  // 已安装版本只服务 manifest.files 列过的文件：手工塞进目录但未签名登记的 → 404。
  fs.writeFileSync(path.join(userData, "dxos", "apps", "canvas", "0.2.0", "static", "unlisted.css"), ".x{}");
  const unlisted = await resolver.handle("openarc-canvas://bundle/static/unlisted.css");
  assert.equal(unlisted.status, 404, "未签名的旁挂文件不得被服务");
});

test("全部不可用：503 + 说明页（不静默 500、不白屏），并给出 reason", async () => {
  const userData = tempDir();
  const { keysFile } = makeKeyFixture(tempDir());
  const resolver = makeResolver(userData, { keysFile, distRoot: path.join(tempDir(), "no-dist"), publicRoot: path.join(tempDir(), "no-public") });
  const res = await resolver.handle("openarc-canvas://bundle/static/canvas-list.html");
  assert.equal(res.status, 503);
  const body = await res.text();
  assert.match(body, /无限画布暂时不可用/);
  assert.match(body, /reason=builtin-missing/);
  assert.match(body, /fallbackReason=pointer-missing/);
});

test("readCanvasPointer：指针缺失/损坏/版本非法都给结构化原因", () => {
  const stateDir = path.join(tempDir(), STATE_REL);
  fs.mkdirSync(stateDir, { recursive: true });
  assert.equal(readCanvasPointer(stateDir).reason, "pointer-missing");
  fs.writeFileSync(path.join(stateDir, "current.json"), "nope");
  assert.equal(readCanvasPointer(stateDir).reason, "pointer-invalid");
  fs.writeFileSync(path.join(stateDir, "current.json"), JSON.stringify({ version: "not-semver" }));
  assert.equal(readCanvasPointer(stateDir).reason, "pointer-invalid");
  fs.writeFileSync(path.join(stateDir, "current.json"), JSON.stringify({ version: "1.2.3", digest: "x" }));
  const ok = readCanvasPointer(stateDir);
  assert.equal(ok.ok, true);
  assert.equal(ok.version, "1.2.3");
});
