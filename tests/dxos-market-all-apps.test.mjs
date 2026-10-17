/**
 * 应用商店升级机制泛化到所有应用 · 离线单测（不联网、不启动 Electron、不新增依赖）。
 *
 * 覆盖任务书验收点：
 *   ① 版本条目表与注册表一致（每个应用都有版本、不允许缺失）；
 *   ② 任意已注册 appId 的 status / check / install / rollback；
 *   ③ 「无发布包」是正常状态；「有包但渲染层不支持加载」→ install 结构化 NOT_LOADABLE；
 *   ④ 非法 appId（未知 / 大写 / 路径片段）一律 INVALID_INPUT；
 *   ⑤ 签名 / 摘要失败仍然拒绝，且不落地；
 *   ⑥ 发现路径按 appId 走 updates/<appId>/latest.json 与 <appId>-<version>.zip；
 *   ⑦ 注入第二个加载器后，同一套安装 / 回滚机制对第二个应用完全成立（目录互不串）；
 *   ⑧ 通用更新界面逻辑：loadable=false 时不放行安装、文案如实；商店源码每个应用都带版本。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  APP_UPDATE_SELECTORS,
  appCardUpdate,
  appUpdateView,
  normalizeAppUpdateStatus,
  pendingInstallAction,
} from "../src-vue/apps/appUpdateLogic.ts";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const domain = require("../electron/market-update-domain.cjs");
const sourceAdapters = require("../electron/market-update-sources.cjs");
const { createMarketUpdateBundle } = require("../electron/market-update-service.cjs");
const { writeZip } = require("../electron/canvas-dxos-zip.cjs");

const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-market-all-apps-")); tmpDirs.push(dir); return dir; }

const sha256hex = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const session = { sessionRef: "sess-all-apps" };
const MS_OWNER = "bllack";
const MS_REPO = "OpenArc-OS";
const KEYPAIR = (() => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  return { publicKeyBase64: der.subarray(der.length - 32).toString("base64"), privateKey };
})();
const FOREIGN_KEY = crypto.generateKeyPairSync("ed25519").privateKey;
const appStateDir = (dir, appId) => path.join(dir, "dxos", "apps", appId);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function jsonResponse(value) { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }
function binResponse(buffer) { return new Response(buffer, { status: 200 }); }

function makeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push(String(url));
    const route = routes[String(url)];
    return route ? route() : new Response("not found", { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

/** 构造 <appId>-<version>.zip（js-module，id 必须等于 appId）。 */
function buildPackage({ appId, version, privateKey = KEYPAIR.privateKey, tamperIndex = false, foreignSignature = false }) {
  const js = Buffer.from("/* " + appId + " " + version + " */");
  const css = Buffer.from("." + appId + "-" + version.replace(/\./g, "_") + "{color:red}");
  const manifest = {
    format: "openarc-app/v1", id: appId, name: appId, version, build: 1,
    entry: "index.js", styles: ["index.css"],
    files: { "index.js": sha256hex(js), "index.css": sha256hex(css) },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const signature = crypto.sign(null, manifestBytes, foreignSignature ? FOREIGN_KEY : privateKey).toString("base64");
  return writeZip([
    { name: "manifest.json", data: manifestBytes },
    { name: "manifest.sig", data: Buffer.from(signature, "utf8") },
    { name: "index.js", data: tamperIndex ? Buffer.from("/* tampered */") : js },
    { name: "index.css", data: css },
  ]);
}

function msRevisionsRoute() {
  return {
    [sourceAdapters.modelscopeRevisionsUrl(MS_OWNER, MS_REPO)]: () => jsonResponse({ Data: { RevisionMap: { Branches: [{ Name: "master", Revision: "master" }], Tags: [] } } }),
  };
}

/** 某 appId 在 ModelScope 上的清单 + 资产路由（默认自洽）。 */
function msAppRoutes(appId, version, options = {}) {
  const zip = buildPackage({ appId, version, ...options });
  const manifestPath = "updates/" + appId + "/latest.json";
  const asset = options.asset || ("updates/" + appId + "/" + appId + "-" + version + ".zip");
  const manifestBytes = options.manifestJson != null
    ? Buffer.from(options.manifestJson)
    : Buffer.from(JSON.stringify({ version, build: 1, asset, sha256: sha256hex(zip) }));
  const files = [
    { Path: manifestPath, Size: manifestBytes.length, Sha256: options.manifestListingSha || sha256hex(manifestBytes), Type: "blob" },
    { Path: asset, Size: zip.length, Sha256: options.assetListingSha || sha256hex(zip), Type: "blob" },
  ];
  return {
    zip, manifestPath, asset, manifestBytes, filesList: files,
    routes: {
      [sourceAdapters.modelscopeFilesUrl(MS_OWNER, MS_REPO, "master")]: () => jsonResponse({ Data: { Files: files } }),
      [sourceAdapters.modelscopeDownloadUrl(MS_OWNER, MS_REPO, "master", manifestPath)]: () => binResponse(manifestBytes),
      [sourceAdapters.modelscopeDownloadUrl(MS_OWNER, MS_REPO, "master", asset)]: () => binResponse(zip),
    },
  };
}

function makeBundle(routes = {}, options = {}) {
  const dir = tempDir();
  const keysFile = path.join(dir, "app-update-keys.json");
  fs.writeFileSync(keysFile, JSON.stringify({ canvas: KEYPAIR.publicKeyBase64, notes: KEYPAIR.publicKeyBase64 }));
  const audits = [];
  const fetchImpl = makeFetch(routes);
  const bundle = createMarketUpdateBundle({
    userDataDir: dir,
    keysFile,
    fetchImpl,
    authorization: { resolveActor: () => ({ ok: true, user: { id: "u1" }, isSuper: false }), store: { auditAuthorization: (row) => audits.push(row) } },
    sourceKind: "modelscope-repo",
    builtinVersion: "0.1.0",
    clock: () => 1_700_000_000_000,
    ...options,
  });
  return { bundle, dir, keysFile, audits, fetchImpl };
}

/* ══════════════════════════════════════════════════════════════════════════
   ① 版本条目表与注册表一致性
   ══════════════════════════════════════════════════════════════════════════ */

function parseRegistryVersions() {
  const source = fs.readFileSync(path.join(ROOT, "src-vue", "apps.ts"), "utf8");
  const out = {};
  for (const line of source.split(String.fromCharCode(10))) {
    const match = /^\s*\{\s*id:\s*"([^"]+)",\s*name:\s*"[^"]*",\s*icon:\s*"[^"]*",\s*version:\s*"([^"]+)"\s*\},?\s*$/.exec(line);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

test("① 注册表一致性：每个应用都有版本，且与后端 APP_BUILTIN_VERSIONS 逐项一致", () => {
  const registry = parseRegistryVersions();
  const backend = domain.APP_BUILTIN_VERSIONS;
  assert.ok(Object.keys(registry).length >= 20, "注册表应用数太少，解析可能失败：" + Object.keys(registry).length);
  assert.deepEqual(Object.keys(registry).sort(), Object.keys(backend).sort(), "前端注册表 id 集合必须与后端一致（不允许缺失 / 多余）");
  for (const [id, version] of Object.entries(registry)) {
    assert.ok(domain.parseSemver(version), id + " 的版本不是合法语义化版本：" + version);
    assert.equal(version, backend[id], id + " 的前后端内置版本不一致");
    assert.equal(domain.builtinVersionForApp(id), version, id + " 的 builtinVersionForApp 必须回同值");
  }
  assert.ok(registry.canvas && registry.notes && registry.market, "必须包含 canvas / notes / market");
});

test("①b 后端版本表本身：全部是合法 semver，且默认 canvas 内置版本 = 0.1.0", () => {
  for (const [id, version] of Object.entries(domain.APP_BUILTIN_VERSIONS)) {
    assert.ok(domain.parseSemver(version), id + " 版本非法");
  }
  assert.equal(domain.builtinVersionForApp("canvas"), "0.1.0");
  assert.equal(domain.builtinVersionForApp("notes"), "0.1.0");
});

/* ══════════════════════════════════════════════════════════════════════════
   ② 任意 appId 的 status / check / install / rollback
   ══════════════════════════════════════════════════════════════════════════ */

test("② status：任意已注册 appId 都返回版本与加载支持字段；canvas 可加载、notes 不可", async () => {
  const { bundle } = makeBundle();
  const notes = await bundle.execute("market/update/status", { appId: "notes" }, session);
  assert.equal(notes.ok, true, JSON.stringify(notes));
  assert.equal(notes.value.appId, "notes");
  assert.equal(notes.value.builtinVersion, "0.1.0");
  assert.equal(notes.value.current, null);
  assert.equal(notes.value.latest, null);
  assert.equal(notes.value.updateAvailable, false);
  assert.equal(notes.value.canRollback, false);
  assert.equal(notes.value.loadable, false);
  assert.equal(notes.value.loader, null);
  assert.equal(notes.value.packageKind, null);
  assert.ok(notes.value.loadReason && notes.value.loadReason.indexOf("暂不支持安装包加载") >= 0);

  const canvas = await bundle.execute("market/update/status", { appId: "canvas" }, session);
  assert.equal(canvas.value.loadable, true);
  assert.equal(canvas.value.loader, "openarc-canvas");
  assert.equal(canvas.value.packageKind, "static-web", "canvas 声明的包形态是 static-web");

  const fallback = await bundle.execute("market/update/status", {}, session);
  assert.equal(fallback.value.appId, "canvas", "缺省 appId 仍是 canvas（历史兼容）");
});

test("②b normalize：checkedAt=null 不能变成 0（「从没检查过」≠「检查过且无更新」）", () => {
  const none = normalizeAppUpdateStatus({ appId: "notes", checkedAt: null, latest: null, loadable: false });
  assert.ok(none);
  assert.equal(none.checkedAt, null, "null 必须保持 null");
  assert.equal(normalizeAppUpdateStatus({ appId: "notes", checkedAt: 0, latest: null }).checkedAt, null, "0 也按没检查过处理");
  assert.equal(normalizeAppUpdateStatus({ appId: "notes", checkedAt: 1_700_000_000_000, latest: null }).checkedAt, 1_700_000_000_000);
  const card = appCardUpdate(none);
  assert.match(card.badge, /暂不支持安装包加载/, "从没检查过的不可加载应用不应显示「无可用更新」");
});

test("③ 无发布包：check 对任意 appId 都如实回「无可用更新」，不是错误；install 结构化拒绝", async () => {
  const empty = { ...msRevisionsRoute(), [sourceAdapters.modelscopeFilesUrl(MS_OWNER, MS_REPO, "master")]: () => jsonResponse({ Data: { Files: [] } }) };
  const { bundle } = makeBundle(empty);
  const check = await bundle.execute("market/update/check", { appId: "notes" }, session);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(check.value.latest, null);
  assert.equal(check.value.updateAvailable, false);
  assert.equal(check.value.appId, "notes");
  const install = await bundle.execute("market/update/install", { appId: "notes", confirm: true }, session);
  assert.equal(install.ok, false);
  assert.equal(install.error, "MARKET_UPDATE_NOT_LOADABLE", "没有加载路径的应用在下载之前就被结构化拒绝");
});

test("④ 有包但渲染层不支持加载：check 如实报有更新，install → NOT_LOADABLE，且不落任何文件", async () => {
  const fixture = msAppRoutes("notes", "0.2.0");
  const { bundle, dir } = makeBundle({ ...msRevisionsRoute(), ...fixture.routes });
  const check = await bundle.execute("market/update/check", { appId: "notes" }, session);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(check.value.latest.version, "0.2.0");
  assert.equal(check.value.updateAvailable, true, "有发布包必须如实报有新版本");
  assert.equal(check.value.loadable, false, "但渲染层不支持加载");

  const install = await bundle.execute("market/update/install", { appId: "notes", confirm: true }, session);
  assert.equal(install.ok, false, JSON.stringify(install));
  assert.equal(install.error, "MARKET_UPDATE_NOT_LOADABLE");
  assert.equal(fs.existsSync(path.join(appStateDir(dir, "notes"), "0.2.0")), false, "拒绝时必须不落地版本目录");
  assert.equal(fs.existsSync(path.join(appStateDir(dir, "notes"), "current.json")), false, "拒绝时不得切换指针");
});

test("⑤ 回滚：任意 appId 从没装过 → 幂等回「就在内置版本」（结构化回包，不是崩溃）", async () => {
  // 2026-10 可靠性修复：没有可回退的已安装版本时，rollback 不再报 ROLLBACK_UNAVAILABLE，
  // 而是幂等成功并如实回报 rolledBackTo="builtin" / previous=null（不写盘、不造指针）。
  const { bundle, dir } = makeBundle();
  for (const appId of ["notes", "canvas", "photos"]) {
    const rollback = await bundle.execute("market/update/rollback", { appId }, session);
    assert.equal(rollback.ok, true, appId + " → " + JSON.stringify(rollback));
    assert.deepEqual(rollback.value, { rolledBackTo: "builtin", previous: null }, appId);
    assert.equal(fs.existsSync(path.join(appStateDir(dir, appId), "current.json")), false, appId + " 本来就没装过，不得凭空写指针");
  }
});

test("⑥ 非法 appId：未知 / 大写 / 路径片段一律 INVALID_INPUT", async () => {
  const { bundle } = makeBundle({ ...msRevisionsRoute() });
  const bad = ["nope", "Notes", "notes/../x", "../canvas", "a b", "canvas-x".repeat(20)];
  for (const appId of bad) {
    assert.equal((await bundle.execute("market/update/status", { appId }, session)).error, "MARKET_UPDATE_INVALID_INPUT", "status appId=" + appId);
    assert.equal((await bundle.execute("market/update/check", { appId }, session)).error, "MARKET_UPDATE_INVALID_INPUT", "check appId=" + appId);
    assert.equal((await bundle.execute("market/update/install", { appId, confirm: true }, session)).error, "MARKET_UPDATE_INVALID_INPUT", "install appId=" + appId);
    assert.equal((await bundle.execute("market/update/rollback", { appId }, session)).error, "MARKET_UPDATE_INVALID_INPUT", "rollback appId=" + appId);
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   ⑦ 发现路径按 appId；泛化安装 / 回滚（注入第二个加载器）
   ══════════════════════════════════════════════════════════════════════════ */

test("⑦ 发现路径按 appId：notes 走 updates/notes/latest.json，不会去读 canvas 的清单", async () => {
  const fixture = msAppRoutes("notes", "0.2.0");
  const { bundle, fetchImpl } = makeBundle({ ...msRevisionsRoute(), ...fixture.routes });
  const check = await bundle.execute("market/update/check", { appId: "notes" }, session);
  assert.equal(check.ok, true, JSON.stringify(check));
  const called = fetchImpl.calls;
  assert.ok(called.some((url) => url.indexOf("FilePath=updates%2Fnotes%2Flatest.json") >= 0 || url.indexOf("FilePath=updates/notes/latest.json") >= 0), "必须按 notes 的清单路径取版本：" + JSON.stringify(called.slice(0, 4)));
  assert.equal(called.some((url) => url.indexOf("updates%2Fcanvas%2Flatest.json") >= 0), false, "不得偷看 canvas 的清单");
});

test("⑦b 清单资产名必须属于该 appId：notes 清单引用 canvas-*.zip → INVALID_INPUT", async () => {
  const fixture = msAppRoutes("notes", "0.2.0", { asset: "updates/notes/canvas-0.2.0.zip" });
  const { bundle } = makeBundle({ ...msRevisionsRoute(), ...fixture.routes });
  const check = await bundle.execute("market/update/check", { appId: "notes" }, session);
  assert.equal(check.ok, false, JSON.stringify(check));
  assert.equal(check.error, "MARKET_UPDATE_INVALID_INPUT");
});

test("⑧ 注入第二个加载器后：notes 的完整 install / rollback 走真实信任链，目录与 canvas 互不串", async () => {
  const loaders = { canvas: "openarc-canvas", notes: "openarc-notes" };
  const f2 = msAppRoutes("notes", "0.2.0");
  const f3 = msAppRoutes("notes", "0.3.0");
  let active = f2;
  const filesUrl = sourceAdapters.modelscopeFilesUrl(MS_OWNER, MS_REPO, "master");
  const manifestUrl = sourceAdapters.modelscopeDownloadUrl(MS_OWNER, MS_REPO, "master", "updates/notes/latest.json");
  const routes = {
    ...msRevisionsRoute(),
    [filesUrl]: () => jsonResponse({ Data: { Files: active.filesList } }),
    [manifestUrl]: () => binResponse(active.manifestBytes),
    [sourceAdapters.modelscopeDownloadUrl(MS_OWNER, MS_REPO, "master", f2.asset)]: () => binResponse(f2.zip),
    [sourceAdapters.modelscopeDownloadUrl(MS_OWNER, MS_REPO, "master", f3.asset)]: () => binResponse(f3.zip),
  };
  const { bundle, dir, audits } = makeBundle(routes, { packageLoaders: loaders });

  const install2 = await bundle.execute("market/update/install", { appId: "notes", confirm: true }, session);
  assert.equal(install2.ok, true, JSON.stringify(install2));
  assert.equal(install2.value.installed.appId, "notes");
  assert.equal(install2.value.installed.version, "0.2.0");
  assert.ok(fs.existsSync(path.join(appStateDir(dir, "notes"), "0.2.0", "manifest.sig")), "notes 版本目录必须真实落盘");
  assert.equal(readJson(path.join(appStateDir(dir, "notes"), "current.json")).version, "0.2.0");
  assert.equal(fs.existsSync(path.join(appStateDir(dir, "canvas"), "current.json")), false, "canvas 的指针不能被 notes 安装碰到");
  assert.ok(audits.some((row) => row.action === "notes.update.install" && row.decision === "ALLOW" && row.appId === "notes"), "审计 action 必须按 appId");

  const status = await bundle.execute("market/update/status", { appId: "notes" }, session);
  assert.equal(status.value.current.version, "0.2.0");
  assert.equal(status.value.packageKind, "js-module", "packageKind 取已安装包形态");
  assert.equal(status.value.loadable, true, "注入加载器后 notes 可加载");

  // 再装 0.3.0 后回滚回 0.2.0：同一套机制对第二个应用成立
  active = f3;
  const install3 = await bundle.execute("market/update/install", { appId: "notes", confirm: true }, session);
  assert.equal(install3.ok, true, JSON.stringify(install3));
  assert.deepEqual(install3.value.previous, { version: "0.2.0" });
  const rbStatus = await bundle.execute("market/update/status", { appId: "notes" }, session);
  assert.equal(rbStatus.value.current.version, "0.3.0");
  assert.equal(rbStatus.value.canRollback, true);
  const rollback = await bundle.execute("market/update/rollback", { appId: "notes" }, session);
  assert.equal(rollback.ok, true, JSON.stringify(rollback));
  assert.equal(rollback.value.rolledBackTo, "0.2.0");
  assert.equal(readJson(path.join(appStateDir(dir, "notes"), "current.json")).version, "0.2.0");
  assert.ok(audits.some((row) => row.action === "notes.update.rollback" && row.decision === "ALLOW" && row.appId === "notes"));
  assert.equal(fs.existsSync(path.join(appStateDir(dir, "canvas"), "current.json")), false, "全程 canvas 目录保持干净");
});

test("⑨ 签名 / 摘要失败按 appId 拒绝，且不落地", async () => {
  const tampered = msAppRoutes("notes", "0.4.0", { tamperIndex: true });
  const loaders = { canvas: "openarc-canvas", notes: "openarc-notes" };
  const b1 = makeBundle({ ...msRevisionsRoute(), ...tampered.routes }, { packageLoaders: loaders });
  const r1 = await b1.bundle.execute("market/update/install", { appId: "notes", confirm: true }, session);
  assert.equal(r1.ok, false, JSON.stringify(r1));
  assert.equal(r1.error, "MARKET_UPDATE_DIGEST_MISMATCH");
  assert.equal(fs.existsSync(path.join(appStateDir(b1.dir, "notes"), "0.4.0")), false, "摘要失败不得落地");

  const badSig = msAppRoutes("notes", "0.5.0", { foreignSignature: true });
  const b2 = makeBundle({ ...msRevisionsRoute(), ...badSig.routes }, { packageLoaders: loaders });
  const r2 = await b2.bundle.execute("market/update/install", { appId: "notes", confirm: true }, session);
  assert.equal(r2.ok, false, JSON.stringify(r2));
  assert.equal(r2.error, "MARKET_UPDATE_SIGNATURE_INVALID");
  assert.equal(fs.existsSync(path.join(appStateDir(b2.dir, "notes"), "0.5.0")), false, "验签失败不得落地");
});

test("⑩ 即使注入了加载器，未注册应用仍然拒绝（注册表是边界）", async () => {
  const { bundle } = makeBundle({ ...msRevisionsRoute() }, { packageLoaders: { nope: "openarc-nope" } });
  const status = await bundle.execute("market/update/status", { appId: "nope" }, session);
  assert.equal(status.ok, false);
  assert.equal(status.error, "MARKET_UPDATE_INVALID_INPUT");
});

/* ══════════════════════════════════════════════════════════════════════════
   ⑪ 通用更新界面逻辑 + 商店源码契约
   ══════════════════════════════════════════════════════════════════════════ */

const notesStatus = {
  appId: "notes", current: null, builtinVersion: "0.1.0",
  source: { kind: "modelscope-repo", owner: "bllack", repo: "OpenArc-OS" },
  checkedAt: 1_700_000_000_000,
  latest: { version: "0.2.0", notesUrl: null, publishedAt: 1_700_000_000_000 },
  updateAvailable: true, canRollback: false,
  packageKind: null, loadable: false, loader: null, loadReason: "该应用暂不支持安装包加载（本期只有无限画布接入了已安装包的加载路径）",
};

test("⑪ loadable=false + 有新版本：界面进入 unsupported，不放行安装，文案如实", () => {
  const normalized = normalizeAppUpdateStatus(notesStatus);
  assert.ok(normalized);
  const view = appUpdateView({ status: normalized, busy: null, errorCode: null, appId: "notes", appName: "文稿" });
  assert.equal(view.phase, "unsupported");
  assert.equal(view.dataState, "unsupported");
  assert.equal(view.loadable, false);
  assert.equal(view.canInstall, false, "不允许放行安装");
  assert.equal(view.canCheck, true);
  assert.match(view.badge, /暂不支持安装包加载/);
  assert.match(view.title, /暂不支持安装包加载/);
  assert.match(view.title, /0\.2\.0/);
  assert.match(view.detail, /不会安装/);
  assert.equal(pendingInstallAction(normalized), null, "确认门也不会为不可加载的应用产出安装动作");
});

test("⑪b loadable=true + 有新版本：界面进入 available，可安装", () => {
  const loadable = normalizeAppUpdateStatus({ ...notesStatus, loadable: true, loader: "openarc-notes" });
  const view = appUpdateView({ status: loadable, busy: null, errorCode: null, appId: "notes", appName: "文稿" });
  assert.equal(view.phase, "available");
  assert.equal(view.dataState, "available");
  assert.equal(view.loadable, true);
  assert.equal(view.canInstall, true);
  assert.deepEqual(pendingInstallAction(loadable), { kind: "install", version: "0.2.0" });
});

test("⑪c 商店卡片：每个应用的版本 + 有无更新 / 能否升级，一眼可见且不臆造", () => {
  const blocked = appCardUpdate(normalizeAppUpdateStatus(notesStatus));
  assert.equal(blocked.canUpgrade, false);
  assert.match(blocked.badge, /有新版本 0\.2\.0/, "有发布包必须提示有新版本");
  assert.match(blocked.detail, /暂不支持安装包加载/, "同时如实标注不支持加载");
  const available = appCardUpdate(normalizeAppUpdateStatus({ ...notesStatus, loadable: true }));
  assert.equal(available.canUpgrade, true);
  assert.match(available.badge, /有新版本 0\.2\.0/);
  const latest = appCardUpdate(normalizeAppUpdateStatus({ ...notesStatus, updateAvailable: false, loadable: true }));
  assert.equal(latest.canUpgrade, false);
  assert.match(latest.badge, /已是最新/);
  const noRelease = appCardUpdate(normalizeAppUpdateStatus({ ...notesStatus, updateAvailable: false, latest: null }));
  assert.equal(noRelease.canUpgrade, false);
  assert.match(noRelease.badge, /无可用更新/, "检查过但没有发布包 → 无可用更新（不是错误）");
  assert.match(noRelease.detail, /暂不支持安装包加载/);
  assert.equal(appCardUpdate(null).canUpgrade, false, "读不到状态时不臆造可升级");
});

test("⑪d 源码契约：面板带泛化取证属性；商店为每个应用渲染版本与更新条目", () => {
  const panel = fs.readFileSync(path.join(ROOT, "src-vue", "apps", "CanvasUpdatePanel.vue"), "utf8");
  for (const selector of APP_UPDATE_SELECTORS) {
    const match = /^\[data-([a-z0-9-]+)/.exec(selector);
    assert.ok(match, "选择器形状不合法：" + selector);
    assert.ok(panel.indexOf("data-" + match[1]) >= 0, selector + " 在面板源码里找不到");
  }
  const market = fs.readFileSync(path.join(ROOT, "src-vue", "apps", "MarketApp.vue"), "utf8");
  assert.ok(market.indexOf("data-app-version") >= 0, "商店卡片缺少版本取证属性");
  assert.ok(market.indexOf("a.version") >= 0, "商店卡片必须渲染注册表版本");
  assert.ok(market.indexOf("data-app-update-open") >= 0, "非画布应用必须有版本与更新入口");
  assert.ok(market.indexOf("data-canvas-update-open") >= 0, "画布专用「在线更新」入口必须保留可用");
  assert.ok(market.indexOf("appCardUpdate") >= 0, "商店卡片状态必须走通用逻辑");
});
