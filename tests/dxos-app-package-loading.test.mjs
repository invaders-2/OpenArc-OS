/**
 * task-19 A · 全部已注册应用的已安装包加载路径。
 *
 * 覆盖：
 *   ① 加载器注册表：每个已注册应用都有 loader / loadUrl（canvas 专用，其余 openarc-app）；
 *   ② 安装 + 加载：notes 包落盘后 openarc-app:// 真的能取到 entry / css（不是只写磁盘）；
 *   ③ 版本切换与回滚：0.2.0 → 0.3.0 → rollback → 0.2.0 → rollback → 内置；
 *   ④ 健康检查：健康 / 被篡改 / 回退内置分别给出结构化 reason；
 *   ⑤ 安装后加载复核失败：指针原子恢复、不切换；
 *   ⑥ 多个应用并行安装：各自目录与协议互不串；
 *   ⑦ main.cjs 装配契约：scheme / resolver / protocol / market bundle 注入。
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
const sourceAdapters = require("../electron/market-update-sources.cjs");
const { createMarketUpdateBundle } = require("../electron/market-update-service.cjs");
const { createAppPackageResolver } = require("../electron/app-package-resolver.cjs");
const { writeZip } = require("../electron/canvas-dxos-zip.cjs");

const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-app-loading-")); tmpDirs.push(dir); return dir; }
const sha256hex = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const session = { sessionRef: "sess-app-loading" };
const MS_OWNER = "bllack";
const MS_REPO = "OpenArc-OS";
const KEYPAIR = (() => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  return { publicKeyBase64: der.subarray(der.length - 32).toString("base64"), privateKey };
})();

function jsonResponse(value) { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }
function binResponse(buffer) { return new Response(buffer, { status: 200 }); }

function buildPackage({ appId, version, kind = "js-module", entry = "index.js" }) {
  const js = Buffer.from("/* " + appId + " " + version + " */");
  const css = Buffer.from("." + appId + "-" + version.replace(/\./g, "_") + "{color:red}");
  const manifest = {
    format: "openarc-app/v1", id: appId, name: appId, version, build: 1, kind, entry, styles: ["index.css"],
    files: { "index.js": sha256hex(js), "index.css": sha256hex(css) },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const signature = crypto.sign(null, manifestBytes, KEYPAIR.privateKey).toString("base64");
  return writeZip([
    { name: "manifest.json", data: manifestBytes },
    { name: "manifest.sig", data: Buffer.from(signature, "utf8") },
    { name: "index.js", data: js },
    { name: "index.css", data: css },
  ]);
}

const revisionsRoute = {
  [sourceAdapters.modelscopeRevisionsUrl(MS_OWNER, MS_REPO)]: () => jsonResponse({ Data: { RevisionMap: { Branches: [{ Name: "master", Revision: "master" }], Tags: [] } } }),
};

/** 某 appId 的清单 + 资产；files 路由由 outside 合并成联合清单。 */
function appRoutes(appId, version) {
  const zip = buildPackage({ appId, version });
  const manifestPath = "updates/" + appId + "/latest.json";
  const asset = "updates/" + appId + "/" + appId + "-" + version + ".zip";
  const manifestBytes = Buffer.from(JSON.stringify({ version, build: 1, asset, sha256: sha256hex(zip) }));
  return {
    zip, manifestPath, asset,
    entries: [
      { Path: manifestPath, Size: manifestBytes.length, Sha256: sha256hex(manifestBytes), Type: "blob" },
      { Path: asset, Size: zip.length, Sha256: sha256hex(zip), Type: "blob" },
    ],
    routes: {
      [sourceAdapters.modelscopeDownloadUrl(MS_OWNER, MS_REPO, "master", manifestPath)]: () => binResponse(manifestBytes),
      [sourceAdapters.modelscopeDownloadUrl(MS_OWNER, MS_REPO, "master", asset)]: () => binResponse(zip),
    },
  };
}

function makeBundle(appIds, options = {}) {
  const dir = options.dir || tempDir();
  const keys = {};
  for (const appId of domain.appIds()) keys[appId] = KEYPAIR.publicKeyBase64;
  const keysFile = options.keysFile || path.join(dir, "app-update-keys.json");
  if (!options.keysFile) fs.writeFileSync(keysFile, JSON.stringify(keys));
  const packageResolver = options.packageResolver === undefined
    ? createAppPackageResolver({ userDataDir: dir, keysFile })
    : options.packageResolver;
  const files = [];
  const routes = { ...revisionsRoute };
  for (const { appId, version } of appIds) {
    const built = appRoutes(appId, version);
    files.push(...built.entries);
    Object.assign(routes, built.routes);
  }
  routes[sourceAdapters.modelscopeFilesUrl(MS_OWNER, MS_REPO, "master")] = () => jsonResponse({ Data: { Files: files } });
  const calls = [];
  const bundle = createMarketUpdateBundle({
    userDataDir: dir,
    keysFile,
    fetchImpl: async (url) => { calls.push(String(url)); const route = routes[String(url)]; return route ? route() : new Response("not found", { status: 404 }); },
    authorization: { resolveActor: () => ({ ok: true, user: { id: "u1" }, isSuper: false }), store: { auditAuthorization: () => true } },
    sourceKind: "modelscope-repo",
    builtinVersion: "0.1.0",
    packageResolver,
    clock: () => 1_700_000_000_000,
  });
  return { dir, keysFile, bundle, packageResolver, calls };
}

const install = (bundle, appId, version) => bundle.execute("market/update/install", { appId, version, confirm: true }, session);
const health = (bundle, appId) => bundle.execute("market/update/health", { appId }, session);

test("① 加载路径注册表：每个已注册应用都可加载（canvas 专用 / 其余 openarc-app）", () => {
  const ids = domain.appIds();
  assert.ok(ids.length >= 20);
  for (const appId of ids) {
    const support = domain.appLoadSupport(appId);
    assert.equal(support.loadable, true, appId + " 必须可加载");
    if (appId === "canvas") {
      assert.equal(support.loader, "openarc-canvas");
      assert.equal(support.loadUrl, "openarc-canvas://bundle/");
    } else {
      assert.equal(support.loader, "openarc-app", appId);
      assert.equal(support.loadUrl, "openarc-app://" + appId + "/", appId);
    }
    assert.equal(domain.APP_PACKAGE_LOADERS[appId], support.loader);
  }
});

test("② 安装 notes 后 openarc-app:// 真的能加载 entry / css（装到磁盘不是终点）", async () => {
  const f = makeBundle([{ appId: "notes", version: "0.2.0" }]);
  const installed = await install(f.bundle, "notes", "0.2.0");
  assert.equal(installed.ok, true, JSON.stringify(installed));
  const current = f.bundle.readCurrent("notes");
  assert.equal(current.version, "0.2.0");

  const hp = await health(f.bundle, "notes");
  assert.equal(hp.ok, true, JSON.stringify(hp));
  assert.equal(hp.value.effectiveSource, "installed");
  assert.equal(hp.value.installedLoadable, true);
  assert.equal(hp.value.installed.version, "0.2.0");
  assert.equal(hp.value.loadUrl, "openarc-app://notes/");

  const entry = await f.packageResolver.handle("openarc-app://notes/");
  assert.equal(entry.status, 200);
  assert.equal(entry.headers.get("x-openarc-app-source"), "installed");
  assert.equal(entry.headers.get("x-openarc-app-version"), "0.2.0");
  assert.match(await entry.text(), /notes 0\.2\.0/);
  const css = await f.packageResolver.handle("openarc-app://notes/index.css");
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);
  // 只服务 manifest.files 的条目
  const manifest = await f.packageResolver.handle("openarc-app://notes/manifest.json");
  assert.equal(manifest.status, 404);
  const traversal = await f.packageResolver.handle("openarc-app://notes/%2e%2e/manifest.json");
  assert.equal(traversal.status, 404);
});

test("③ 版本切换 + 回滚：0.2.0 → 0.3.0 → 0.2.0 → 内置，每一步协议立即反映", async () => {
  const f = makeBundle([{ appId: "notes", version: "0.2.0" }]);
  assert.equal((await install(f.bundle, "notes", "0.2.0")).ok, true);
  const v2 = await f.packageResolver.handle("openarc-app://notes/");
  assert.match(await v2.text(), /notes 0\.2\.0/);

  // 同一份 userData/keys/解析器下换一个发布源（不同 bundle 实例，状态目录共享）。
  const f2 = makeBundle([{ appId: "notes", version: "0.3.0" }], { dir: f.dir, keysFile: f.keysFile, packageResolver: f.packageResolver });
  assert.equal((await install(f2.bundle, "notes", "0.3.0")).ok, true);
  const v3 = await f.packageResolver.handle("openarc-app://notes/");
  assert.match(await v3.text(), /notes 0\.3\.0/);
  assert.equal(v3.headers.get("x-openarc-app-version"), "0.3.0");

  const back = await f2.bundle.execute("market/update/rollback", { appId: "notes" }, session);
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(back.value.rolledBackTo, "0.2.0");
  const v2again = await f.packageResolver.handle("openarc-app://notes/");
  assert.match(await v2again.text(), /notes 0\.2\.0/);

  const builtin = await f2.bundle.execute("market/update/rollback", { appId: "notes" }, session);
  assert.equal(builtin.ok, true, JSON.stringify(builtin));
  assert.equal(builtin.value.rolledBackTo, "builtin");
  const fallback = await f.packageResolver.handle("openarc-app://notes/");
  assert.equal(fallback.status, 404);
  assert.equal(fallback.headers.get("x-openarc-app-source"), "builtin");
  assert.equal(fallback.headers.get("x-openarc-app-fallback"), "pointer-cleared");
  const hp = await health(f2.bundle, "notes");
  assert.equal(hp.value.effectiveSource, "builtin");
  assert.equal(hp.value.installedLoadable, false);
});

test("④ 健康检查：安装文件被篡改 → installedLoadable=false + digest-mismatch，协议回退内置", async () => {
  const f = makeBundle([{ appId: "notes", version: "0.2.0" }]);
  assert.equal((await install(f.bundle, "notes", "0.2.0")).ok, true);
  const installedDir = f.bundle.installedDir("notes", "0.2.0");
  fs.writeFileSync(path.join(installedDir, "index.js"), "/* tampered */");
  const hp = await health(f.bundle, "notes");
  assert.equal(hp.ok, true, JSON.stringify(hp));
  assert.equal(hp.value.installedLoadable, false);
  assert.equal(hp.value.effectiveSource, "builtin");
  assert.equal(hp.value.fallbackReason, "digest-mismatch");
  const response = await f.packageResolver.handle("openarc-app://notes/");
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("x-openarc-app-fallback"), "digest-mismatch");
});

test("⑤ 安装后加载复核失败：指针原子恢复，不留下坏版本", async () => {
  const f = makeBundle([{ appId: "notes", version: "0.2.0" }], {
    packageResolver: { health: () => ({ ok: true, appId: "notes", installedLoadable: false, fallbackReason: "digest-mismatch" }) },
  });
  const installResult = await install(f.bundle, "notes", "0.2.0");
  assert.equal(installResult.ok, false, JSON.stringify(installResult));
  assert.equal(installResult.error, "MARKET_UPDATE_NOT_LOADABLE");
  assert.equal(f.bundle.readCurrent("notes"), null, "首次安装失败不能留下指针");
  assert.equal(fs.existsSync(f.bundle.installedDir("notes", "0.2.0")), false, "失败的新版本目录必须清掉");
});

test("⑥ 多个应用各自安装：目录 / 协议 / 回滚互不串", async () => {
  const f = makeBundle([
    { appId: "notes", version: "0.2.0" },
    { appId: "weather", version: "0.2.0" },
    { appId: "market", version: "0.2.0" },
  ]);
  for (const appId of ["notes", "weather", "market"]) {
    const result = await install(f.bundle, appId, "0.2.0");
    assert.equal(result.ok, true, appId + " " + JSON.stringify(result));
    assert.equal(result.value.installed.appId, appId);
    const response = await f.packageResolver.handle("openarc-app://" + appId + "/");
    assert.equal(response.status, 200, appId);
    assert.match(await response.text(), new RegExp(appId + " 0\\.2\\.0"));
  }
  const rollbackNotes = await f.bundle.execute("market/update/rollback", { appId: "notes" }, session);
  assert.equal(rollbackNotes.ok, true);
  assert.equal((await f.packageResolver.handle("openarc-app://notes/")).status, 404);
  assert.equal((await f.packageResolver.handle("openarc-app://weather/")).status, 200, "回滚 notes 不影响 weather");
  assert.equal((await f.packageResolver.handle("openarc-app://market/")).status, 200);
});

test("⑦ 未知应用 / 缺公钥：结构化不可用，不退化成任意目录服务", async () => {
  const f = makeBundle([]);
  const unknown = await f.packageResolver.handle("openarc-app://../../etc/passwd");
  assert.equal(unknown.status, 404);
  const invalidHealth = await f.bundle.execute("market/update/health", { appId: "no-such-app" }, session);
  assert.equal(invalidHealth.ok, false);
  assert.equal(invalidHealth.error, "MARKET_UPDATE_INVALID_INPUT");
});

test("⑧ main.cjs 装配契约：scheme / resolver / market bundle / protocol", () => {
  const main = fs.readFileSync(path.join(ROOT, "electron", "main.cjs"), "utf8");
  assert.ok(main.includes('scheme: "openarc-app"'), "必须注册 openarc-app 协议 scheme");
  assert.ok(main.includes('require("./app-package-resolver.cjs")'), "main.cjs 必须装配通用解析器");
  assert.ok(main.includes("createAppPackageResolver({"), "必须创建真实解析器实例");
  assert.ok(main.includes("packageResolver: appPackageResolver"), "market install 必须注入同一份解析器做加载复核");
  assert.ok(main.includes('protocol.handle("openarc-app"'), "必须注册 openarc-app 只读协议");
  const commands = domain.MARKET_UPDATE_COMMANDS;
  assert.ok(commands.includes("market/update/health"), "必须暴露加载健康检查命令");
});
