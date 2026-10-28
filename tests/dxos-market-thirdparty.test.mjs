/**
 * task-19 B · 第三方应用目录与安装（本地 catalog + 在线源）。
 *
 * 覆盖：目录校验 / 兼容性 / 摘要 / 签名 / 本地安装 / 在线安装 / 失败不落盘 /
 * 安装后真的能被 openarc-app:// 加载 / 回滚 / 受控在线源 / market:command 委托 / main 装配。
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
const thirdDomain = require("../electron/market-third-party-domain.cjs");
const { createMarketUpdateBundle } = require("../electron/market-update-service.cjs");
const { createAppPackageResolver } = require("../electron/app-package-resolver.cjs");
const { createThirdPartyRegistry, createThirdPartyMarket } = require("../electron/market-third-party-service.cjs");
const { createMarketBundle } = require("../electron/market-service.cjs");
const { writeZip } = require("../electron/canvas-dxos-zip.cjs");

const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-thirdparty-")); tmpDirs.push(dir); return dir; }
const sha256hex = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const session = { sessionRef: "sess-thirdparty" };
const KEYPAIR = (() => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  return { publicKeyBase64: der.subarray(der.length - 32).toString("base64"), privateKey };
})();
const FOREIGN_KEY = crypto.generateKeyPairSync("ed25519").privateKey;

function buildPackage({ appId, version, versionOverride = null, privateKey = KEYPAIR.privateKey, tamper = false }) {
  const js = Buffer.from("/* " + appId + " " + version + " */");
  const css = Buffer.from("." + appId + "{color:red}");
  const manifest = {
    format: "openarc-app/v1", id: appId, name: appId, version: versionOverride || version, build: 1, kind: "js-module", entry: "index.js",
    styles: ["index.css"],
    files: { "index.js": sha256hex(js), "index.css": sha256hex(css) },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const signature = crypto.sign(null, manifestBytes, privateKey).toString("base64");
  return writeZip([
    { name: "manifest.json", data: manifestBytes },
    { name: "manifest.sig", data: Buffer.from(signature, "utf8") },
    { name: "index.js", data: tamper ? Buffer.from("/* tampered */") : js },
    { name: "index.css", data: css },
  ]);
}

function jsonResponse(value) { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }
function binResponse(buffer) { return new Response(buffer, { status: 200 }); }

function setup({ catalog, onlineFetch = null, systemVersion = "0.1.0" } = {}) {
  const dir = tempDir();
  const keysFile = path.join(dir, "app-update-keys.json");
  fs.writeFileSync(keysFile, JSON.stringify({ "notes-plus": KEYPAIR.publicKeyBase64, canvas: KEYPAIR.publicKeyBase64 }));
  const registry = createThirdPartyRegistry({ userDataDir: dir, clock: () => 1_700_000_000_000 });
  const resolver = createAppPackageResolver({ userDataDir: dir, keysFile, isKnownApp: (value) => (registry.has(value) ? value : null) });
  const updateService = createMarketUpdateBundle({
    userDataDir: dir, keysFile, packageResolver: resolver, isKnownApp: (value) => (registry.has(value) ? value : null),
    authorization: { resolveActor: () => ({ ok: true, user: { id: "u1" }, isSuper: false }), store: { auditAuthorization: () => true } },
    clock: () => 1_700_000_000_000,
  });
  const marketDir = path.join(dir, "dxos", "market");
  fs.mkdirSync(path.join(marketDir, "packages"), { recursive: true });
  if (catalog) fs.writeFileSync(path.join(marketDir, "third-party.json"), JSON.stringify(catalog), "utf8");
  const service = createThirdPartyMarket({
    userDataDir: dir, appDir: dir, updateService, registry,
    fetchImpl: onlineFetch || null,
    authorization: { resolveActor: () => ({ ok: true, user: { id: "u1" }, isSuper: false }), store: { auditAuthorization: () => true } },
    systemVersion, clock: () => 1_700_000_000_000,
  });
  return { dir, keysFile, registry, resolver, updateService, service, marketDir };
}

function localCatalog(appId, version, options = {}) {
  const zip = buildPackage({ appId, version, ...options });
  const fileName = appId + "-" + version + ".zip";
  return { zip, fileName, catalog: { format: "openarc-third-party-catalog/v1", apps: [{
    id: appId, name: "增强应用", version,
    packageFile: "packages/" + fileName,
    sha256: options.sha256 || sha256hex(zip),
    size: zip.length,
    minSystemVersion: options.minSystemVersion || null,
    description: "第三方测试应用",
  }] } };
}

test("① 本地目录：list 返回合法条目与拒绝原因；不暴露绝对路径", async () => {
  const fixture = localCatalog("notes-plus", "0.2.0");
  const f = setup({ catalog: fixture.catalog });
  fs.writeFileSync(path.join(f.marketDir, "packages", fixture.fileName), fixture.zip);
  const listed = await f.service.execute("market/thirdparty/list", {}, session);
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.value.local.present, true);
  assert.equal(listed.value.local.apps.length, 1);
  assert.equal(listed.value.local.apps[0].id, "notes-plus");
  assert.equal(JSON.stringify(listed.value).includes(f.dir), false, "不得暴露绝对路径");
});

test("② 本地安装：摘要/签名通过，落盘后 openarc-app:// 能加载；注册表标记 installed", async () => {
  const fixture = localCatalog("notes-plus", "0.2.0");
  const f = setup({ catalog: fixture.catalog });
  fs.writeFileSync(path.join(f.marketDir, "packages", fixture.fileName), fixture.zip);
  const installed = await f.service.execute("market/thirdparty/install", { appId: "notes-plus", confirm: true }, session);
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(installed.value.installed.version, "0.2.0");
  assert.ok(f.registry.has("notes-plus"));
  assert.equal(f.registry.get("notes-plus").status, "installed");
  const loaded = await f.resolver.handle("openarc-app://notes-plus/");
  assert.equal(loaded.status, 200);
  assert.match(await loaded.text(), /notes-plus 0\.2\.0/);
  const status = await f.updateService.execute("market/update/status", { appId: "notes-plus" }, session);
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.value.loadable, true);
  assert.equal(status.value.loader, "openarc-app");
});

test("③ 摘要 / 签名失败：不落目录、不写指针、注册表保持干净", async () => {
  const digestFixture = localCatalog("notes-plus", "0.2.0", { sha256: "0".repeat(64) });
  const f1 = setup({ catalog: digestFixture.catalog });
  fs.writeFileSync(path.join(f1.marketDir, "packages", digestFixture.fileName), digestFixture.zip);
  const digest = await f1.service.execute("market/thirdparty/install", { appId: "notes-plus", confirm: true }, session);
  assert.equal(digest.ok, false);
  assert.equal(digest.error, "MARKET_THIRDPARTY_DIGEST_MISMATCH");
  assert.equal(f1.registry.has("notes-plus"), false);
  assert.equal(fs.existsSync(path.join(f1.dir, "dxos", "apps", "notes-plus", "current.json")), false);

  const signatureFixture = localCatalog("notes-plus", "0.2.0", { privateKey: FOREIGN_KEY });
  const f2 = setup({ catalog: signatureFixture.catalog });
  fs.writeFileSync(path.join(f2.marketDir, "packages", signatureFixture.fileName), signatureFixture.zip);
  const signature = await f2.service.execute("market/thirdparty/install", { appId: "notes-plus", confirm: true }, session);
  assert.equal(signature.ok, false);
  assert.equal(signature.error, "MARKET_THIRDPARTY_SIGNATURE_INVALID");
  assert.equal(f2.registry.has("notes-plus"), false);
});

test("④ 兼容性 / 内置 id 冲突 / 未确认：结构化拒绝且不下载", async () => {
  const incompatible = localCatalog("notes-plus", "0.2.0", { minSystemVersion: "9.0.0" });
  const f = setup({ catalog: incompatible.catalog });
  fs.writeFileSync(path.join(f.marketDir, "packages", incompatible.fileName), incompatible.zip);
  const notCompatible = await f.service.execute("market/thirdparty/install", { appId: "notes-plus", confirm: true }, session);
  assert.equal(notCompatible.ok, false);
  assert.equal(notCompatible.error, "MARKET_THIRDPARTY_NOT_COMPATIBLE");

  const reservedCatalog = { format: "openarc-third-party-catalog/v1", apps: [{ id: "canvas", name: "假画布", version: "0.2.0", packageFile: "packages/x.zip", sha256: sha256hex(Buffer.from("x")) }] };
  const f2 = setup({ catalog: reservedCatalog });
  const reserved = await f2.service.execute("market/thirdparty/install", { appId: "canvas", confirm: true }, session);
  assert.equal(reserved.ok, false);
  assert.equal(reserved.error, "MARKET_THIRDPARTY_RESERVED_APP");

  const noConfirm = await f.service.execute("market/thirdparty/install", { appId: "notes-plus" }, session);
  assert.equal(noConfirm.ok, false);
  assert.equal(noConfirm.error, "MARKET_THIRDPARTY_INVALID_INPUT");
});

test("⑤ 在线目录：受控 HTTPS 源，安装后同样真的能加载", async () => {
  const zip = buildPackage({ appId: "weather-plus", version: "0.3.0" });
  const catalog = { format: "openarc-third-party-catalog/v1", apps: [{
    id: "weather-plus", name: "增强天气", version: "0.3.0",
    packageUrl: "https://modelscope.cn/api/v1/models/bllack/OpenArc-OS/repo?Revision=master&FilePath=updates%2Fweather-plus-0.3.0.zip",
    sha256: sha256hex(zip),
  }] };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("thirdparty.json")) return jsonResponse(catalog);
    if (String(url).includes("weather-plus-0.3.0.zip")) return binResponse(zip);
    return new Response("not found", { status: 404 });
  };
  const f = setup({ onlineFetch: fetchImpl });
  fs.writeFileSync(path.join(f.keysFile), JSON.stringify({ "notes-plus": KEYPAIR.publicKeyBase64, "weather-plus": KEYPAIR.publicKeyBase64, canvas: KEYPAIR.publicKeyBase64 }));
  const sourceSet = await f.service.execute("market/thirdparty/source/set", { url: "https://modelscope.cn/repo/thirdparty.json" }, session);
  assert.equal(sourceSet.ok, true, JSON.stringify(sourceSet));
  const listed = await f.service.execute("market/thirdparty/list", {}, session);
  assert.equal(listed.value.online.ok, true, JSON.stringify(listed.value.online));
  const installed = await f.service.execute("market/thirdparty/install", { appId: "weather-plus", confirm: true }, session);
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(installed.value.installed.version, "0.3.0");
  assert.ok(calls.some((url) => url.includes("weather-plus-0.3.0.zip")));
  assert.equal((await f.resolver.handle("openarc-app://weather-plus/")).status, 200);
});

test("⑥ 在线源只允许白名单 HTTPS 主机；非法地址结构化拒绝", async () => {
  const f = setup({});
  const http = await f.service.execute("market/thirdparty/source/set", { url: "http://modelscope.cn/x.json" }, session);
  assert.equal(http.ok, false);
  assert.equal(http.error, "MARKET_THIRDPARTY_SOURCE_NOT_ALLOWED");
  const nonAllow = await f.service.execute("market/thirdparty/source/set", { url: "https://evil.example.com/x.json" }, session);
  assert.equal(nonAllow.ok, false);
  assert.equal(nonAllow.error, "MARKET_THIRDPARTY_SOURCE_NOT_ALLOWED");
});

test("⑦ 新版本安装失败：旧版本继续生效，注册表与指针不被破坏", async () => {
  const v2 = localCatalog("notes-plus", "0.2.0");
  const f = setup({ catalog: v2.catalog });
  fs.writeFileSync(path.join(f.marketDir, "packages", v2.fileName), v2.zip);
  assert.equal((await f.service.execute("market/thirdparty/install", { appId: "notes-plus", confirm: true }, session)).ok, true);
  assert.equal(f.updateService.readCurrent("notes-plus").version, "0.2.0");

  const v3Bad = localCatalog("notes-plus", "0.3.0", { tamper: true });
  fs.writeFileSync(path.join(f.marketDir, "packages", v3Bad.fileName), v3Bad.zip);
  fs.writeFileSync(path.join(f.marketDir, "third-party.json"), JSON.stringify(v3Bad.catalog), "utf8");
  const failed = await f.service.execute("market/thirdparty/install", { appId: "notes-plus", confirm: true }, session);
  assert.equal(failed.ok, false, JSON.stringify(failed));
  assert.equal(f.updateService.readCurrent("notes-plus").version, "0.2.0", "失败不得切换指针");
  assert.equal(f.registry.get("notes-plus").version, "0.2.0", "失败不得改写注册表");
  const loaded = await f.resolver.handle("openarc-app://notes-plus/");
  assert.equal(loaded.status, 200);
  assert.match(await loaded.text(), /notes-plus 0\.2\.0/);
});

test("⑧ 回滚：第三方应用回退到上一版 / 内置，注册表同步状态", async () => {
  const v2 = localCatalog("notes-plus", "0.2.0");
  const f = setup({ catalog: v2.catalog });
  fs.writeFileSync(path.join(f.marketDir, "packages", v2.fileName), v2.zip);
  assert.equal((await f.service.execute("market/thirdparty/install", { appId: "notes-plus", confirm: true }, session)).ok, true);
  const v3 = localCatalog("notes-plus", "0.3.0");
  fs.writeFileSync(path.join(f.marketDir, "packages", v3.fileName), v3.zip);
  fs.writeFileSync(path.join(f.marketDir, "third-party.json"), JSON.stringify(v3.catalog), "utf8");
  assert.equal((await f.service.execute("market/thirdparty/install", { appId: "notes-plus", confirm: true }, session)).ok, true);
  const back = await f.service.execute("market/thirdparty/rollback", { appId: "notes-plus" }, session);
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(back.value.rolledBackTo, "0.2.0");
  assert.equal(f.updateService.readCurrent("notes-plus").version, "0.2.0");
  const builtin = await f.service.execute("market/thirdparty/rollback", { appId: "notes-plus" }, session);
  assert.equal(builtin.ok, true, JSON.stringify(builtin));
  assert.equal(builtin.value.rolledBackTo, "builtin");
  assert.equal(f.updateService.readCurrent("notes-plus"), null);
});

test("⑨ market:command 委托 + 未认证拒绝", async () => {
  const fixture = localCatalog("notes-plus", "0.2.0");
  const f = setup({ catalog: fixture.catalog });
  fs.writeFileSync(path.join(f.marketDir, "packages", fixture.fileName), fixture.zip);
  const market = createMarketBundle({ userDataDir: f.dir, updateService: f.updateService, thirdPartyService: f.service });
  const listed = await market.execute("market/thirdparty/list", {}, session);
  assert.equal(listed.ok, true, JSON.stringify(listed));
  const anonymous = await market.execute("market/thirdparty/list", {}, {});
  assert.equal(anonymous.ok, false);
  assert.equal(anonymous.error, "MARKET_UNAUTHENTICATED");
  assert.ok(market.commands.includes("market/thirdparty/install"));
});

test("⑩ 目录里的 packageUrl 也必须过 HTTPS 白名单；坏条目进 rejected 而不是被安装", async () => {
  const badCatalog = { format: "openarc-third-party-catalog/v1", apps: [{
    id: "evil-app", name: "坏应用", version: "0.2.0",
    packageUrl: "https://evil.example.com/evil-app-0.2.0.zip",
    sha256: "a".repeat(64),
  }] };
  const f = setup({ catalog: badCatalog });
  const listed = await f.service.execute("market/thirdparty/list", {}, session);
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.value.local.apps.length, 0, "白名单外的 packageUrl 不应进入可安装列表");
  assert.equal(listed.value.local.rejected.length, 1);
  assert.match(listed.value.local.rejected[0].reason, /白名单/);
  const install = await f.service.execute("market/thirdparty/install", { appId: "evil-app", confirm: true }, session);
  assert.equal(install.ok, false);
  assert.equal(install.error, "MARKET_THIRDPARTY_NOT_FOUND");
});

test("⑪ main.cjs 装配契约：注册表/解析器/更新服务/第三方服务/市场委托", () => {
  const main = fs.readFileSync(path.join(ROOT, "electron", "runtime-composition.cjs"), "utf8");
  assert.ok(main.includes('require("./market-third-party-service.cjs")'));
  assert.ok(main.includes("createThirdPartyRegistry({"), "必须创建第三方注册表");
  assert.ok(main.includes("createThirdPartyMarket({"), "必须创建第三方市场服务");
  assert.ok(main.includes("isKnownApp: (value) =>"), "解析器/更新服务必须动态识别第三方 appId");
  assert.ok(main.includes("thirdPartyService: thirdPartyMarket"), "market bundle 必须委托第三方命令");
  for (const command of thirdDomain.THIRDPARTY_COMMANDS) {
    assert.ok(main.includes("createThirdPartyMarket") || main.includes(command));
  }
});
