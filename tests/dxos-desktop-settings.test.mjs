/**
 * task-22 · 设置真实能力：手动代理保存/清除、缓存清理、系统更新检查。
 * 全部离线：更新源用注入 fetch 假实现；代理 applyProxy / safeStorage 用假实现。
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
const { createLocalProxyService } = require("../electron/local-proxy-service.cjs");
const { createDesktopCacheService } = require("../electron/desktop-cache-service.cjs");
const { createDesktopUpdateService } = require("../electron/desktop-update-service.cjs");
const { registerLocalProxyIpc } = require("../electron/local-proxy-bootstrap.cjs");
const domain = require("../electron/local-proxy-domain.cjs");
const sourceAdapters = require("../electron/market-update-sources.cjs");

const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
function tempDir(prefix = "oa-settings-") { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(dir); return dir; }
const sha256hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const session = { sessionRef: "sess-settings" };

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(Buffer.from(value, "utf8").toString("base64"), "utf8"),
    decryptString: (buffer) => Buffer.from(buffer.toString("utf8"), "base64").toString("utf8"),
  };
}

function makeProxyService(dir, extra = {}) {
  const calls = [];
  const applyProxy = extra.applyProxy === undefined
    ? async (input) => { calls.push(input); return { applied: true, scope: "electron-session", note: "fake" }; }
    : extra.applyProxy;
  const service = createLocalProxyService({
    userDataDir: dir,
    safeStorage: extra.safeStorage === undefined ? fakeSafeStorage() : extra.safeStorage,
    applyProxy,
    clock: () => 1_700_000_000_000,
  });
  return { service, calls };
}

// ── ① 手动代理：保存 / 回读 / 清除 / 加密 / 应用 ───────────────────────────
test("① proxy/set：校验 + safeStorage 加密落盘 + 回读 + 应用到出网层", async () => {
  const dir = tempDir();
  const { service, calls } = makeProxyService(dir);
  const set = await service.execute("desktop/proxy/set", { url: "http://127.0.0.1:7897" });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.value.configured, true);
  assert.equal(set.value.url, "http://127.0.0.1:7897");
  assert.equal(set.value.storage, "safeStorage");
  assert.equal(set.value.applied, true);
  assert.equal(set.value.appliedScope, "electron-session");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { url: "http://127.0.0.1:7897", enabled: true });

  const configFile = path.join(dir, "dxos", "settings", "proxy.json");
  const rawText = fs.readFileSync(configFile, "utf8");
  assert.match(JSON.parse(rawText).enc, /safeStorage/);
  assert.equal(rawText.includes("127.0.0.1:7897"), false, "加密落盘不得包含明文地址");
  assert.equal(rawText.includes("7897"), false);

  const state = await service.execute("desktop/proxy/state", {});
  assert.equal(state.value.configured, true);
  assert.equal(state.value.url, "http://127.0.0.1:7897");
  assert.equal(state.value.applied, true);
});

test("① proxy/clear：删除配置并恢复直连；再次读取为空", async () => {
  const dir = tempDir();
  const { service, calls } = makeProxyService(dir);
  assert.equal((await service.execute("desktop/proxy/set", { url: "https://127.0.0.1:8080" })).ok, true);
  const cleared = await service.execute("desktop/proxy/clear", {});
  assert.equal(cleared.ok, true, JSON.stringify(cleared));
  assert.equal(cleared.value.configured, false);
  assert.equal(cleared.value.changed, true);
  assert.equal(fs.existsSync(path.join(dir, "dxos", "settings", "proxy.json")), false);
  assert.deepEqual(calls[calls.length - 1], { url: null, enabled: false });
  const state = await service.execute("desktop/proxy/state", {});
  assert.equal(state.value.configured, false);
});

test("① 代理 URL 校验：非法 scheme / 凭据 / 路径 / 空值全部拒绝且不写盘", async () => {
  const dir = tempDir();
  const { service } = makeProxyService(dir);
  for (const url of ["ftp://127.0.0.1:21", "http://user:pass@127.0.0.1:7897", "http://127.0.0.1:7897/foo", "http://127.0.0.1:7897?x=1", "   "]) {
    const result = await service.execute("desktop/proxy/set", { url });
    assert.equal(result.ok, false, url);
    assert.equal(result.error, "LOCAL_PROXY_INVALID_INPUT", url);
  }
  assert.equal(fs.existsSync(path.join(dir, "dxos", "settings", "proxy.json")), false);
});

test("① 无 safeStorage / 无 applyProxy：明文落盘并如实标注仅登记；应用失败不阻断保存", async () => {
  const plainDir = tempDir();
  const plain = makeProxyService(plainDir, { safeStorage: null });
  const saved = await plain.service.execute("desktop/proxy/set", { url: "http://127.0.0.1:7897", enabled: false });
  assert.equal(saved.value.storage, "file");
  assert.equal(saved.value.configured, true);
  assert.equal(saved.value.enabled, false);
  assert.equal(fs.readFileSync(path.join(plainDir, "dxos", "settings", "proxy.json"), "utf8").includes("127.0.0.1:7897"), true);

  const registerOnlyDir = tempDir();
  const registerOnly = makeProxyService(registerOnlyDir, { applyProxy: null });
  const registered = await registerOnly.service.execute("desktop/proxy/set", { url: "http://127.0.0.1:7897" });
  assert.equal(registered.value.applied, false);
  assert.equal(registered.value.appliedScope, "registration-only");
  assert.match(registered.value.applyNote, /仅登记/);

  const failingDir = tempDir();
  const failing = makeProxyService(failingDir, { applyProxy: async () => { throw new Error("setProxy boom"); } });
  const appliedFailed = await failing.service.execute("desktop/proxy/set", { url: "http://127.0.0.1:7897" });
  assert.equal(appliedFailed.ok, true, "配置保存本身不能被出网层失败拖崩");
  assert.equal(appliedFailed.value.applied, false);
  assert.match(appliedFailed.value.applyError, /boom/);
  assert.equal(fs.existsSync(path.join(failingDir, "dxos", "settings", "proxy.json")), true);
});

test("① 重启后 applyPersistedProxy 重新应用；detect 的 configured 来源读取已保存配置", async () => {
  const dir = tempDir();
  const first = makeProxyService(dir);
  assert.equal((await first.service.execute("desktop/proxy/set", { url: "http://127.0.0.1:7897" })).ok, true);
  const second = makeProxyService(dir);
  const persisted = await second.service.applyPersistedProxy();
  assert.equal(persisted.configured, true);
  assert.equal(persisted.applied, true);
  assert.deepEqual(second.calls[0], { url: "http://127.0.0.1:7897", enabled: true });

  const detectService = createLocalProxyService({
    userDataDir: dir, safeStorage: fakeSafeStorage(), platform: "win32",
    execFile: async () => { throw new Error("no tools"); },
  });
  const detected = await detectService.detect({});
  assert.ok(detected.candidates.some((candidate) => candidate.url === "http://127.0.0.1:7897" && candidate.kind === "configured"));
});

test("① desktop:command 端到端：proxy/state 走 trusted 边界", async () => {
  const dir = tempDir();
  const { service } = makeProxyService(dir);
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) };
  registerLocalProxyIpc({ ipcMain, service, isTrusted: () => true, identity: { current: "sess-1" } });
  const invoke = (raw) => handlers.get("desktop:command")({}, raw);
  await invoke({ command: "desktop/proxy/set", payload: { url: "http://127.0.0.1:7897" } });
  const state = await invoke({ command: "desktop/proxy/state", payload: {} });
  assert.equal(state.ok, true);
  assert.equal(state.value.configured, true);
  assert.equal(state.value.url, "http://127.0.0.1:7897");
});

// ── ② 缓存清理 ─────────────────────────────────────────────────────────────
test("② cache/clear：dryRun 只统计；confirm 后释放字节；凭据/数据库/备份不动", async () => {
  const dir = tempDir();
  const dxos = path.join(dir, "dxos");
  const write = (relative, bytes) => { const file = path.join(dxos, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.alloc(bytes, 1)); return file; };
  write("cache/a.bin", 100);
  write("cache/sub/b.bin", 50);
  write("temp/c.bin", 20);
  write("fs/cache/d.bin", 10);
  write("credentials/secret.bin", 999);
  write("identity.db", 500);
  write("backups/snap.json", 300);
  write("settings/proxy.json", 2);

  const service = createDesktopCacheService({ userDataDir: dir, clock: () => 1_700_000_000_000 });
  const dry = await service.execute("desktop/cache/clear", { dryRun: true });
  assert.equal(dry.ok, true, JSON.stringify(dry));
  assert.ok(dry.value.wouldFreeBytes >= 180, JSON.stringify(dry.value));
  assert.equal(dry.value.freedBytes, 0);
  assert.equal(fs.existsSync(path.join(dxos, "cache", "a.bin")), true, "dryRun 不得删除");

  const cleared = await service.execute("desktop/cache/clear", { confirm: true });
  assert.equal(cleared.ok, true, JSON.stringify(cleared));
  assert.equal(cleared.value.freedBytes, dry.value.wouldFreeBytes);
  assert.ok(cleared.value.removedFiles + cleared.value.removedDirs >= 3);
  assert.equal(fs.existsSync(path.join(dxos, "cache", "a.bin")), false);
  assert.equal(fs.existsSync(path.join(dxos, "fs", "cache", "d.bin")), false);
  assert.equal(fs.existsSync(path.join(dxos, "credentials", "secret.bin")), true);
  assert.equal(fs.existsSync(path.join(dxos, "identity.db")), true);
  assert.equal(fs.existsSync(path.join(dxos, "backups", "snap.json")), true);
  assert.equal(JSON.stringify(cleared.value).includes(dxos), false, "不得回传绝对路径");
});

test("② cache/clear：没有 confirm 拒绝；未装配时 desktop 命令结构化不可用", async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "dxos", "cache"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dxos", "cache", "x"), "x");
  const service = createDesktopCacheService({ userDataDir: dir });
  const refused = await service.execute("desktop/cache/clear", {});
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "LOCAL_PROXY_INVALID_INPUT");

  const desktop = createLocalProxyService({ userDataDir: dir });
  const unavailable = await desktop.execute("desktop/cache/clear", { confirm: true });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error, "LOCAL_PROXY_DEPENDENCY_UNAVAILABLE");
});

// ── ③ 系统更新检查 / 下载 ─────────────────────────────────────────────────
function makeGithubFetch({ tag = "v2.0.0", assetUrl = "https://github.com/invaders-2/OpenArc-OS/releases/download/v2.0.0/OpenArc-OS-2.0.0.dmg", body = Buffer.from("installer-bytes") } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/releases")) {
      return new Response(JSON.stringify([{
        tag_name: tag, name: "OpenArc OS " + tag, draft: false, html_url: "https://github.com/invaders-2/OpenArc-OS/releases/tag/" + tag,
        published_at: "2026-10-01T00:00:00Z",
        assets: [{ name: "OpenArc-OS-2.0.0.dmg", size: body.length, browser_download_url: assetUrl }],
      }]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url) === assetUrl) return new Response(body, { status: 200 });
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls, body };
}

test("③ GitHub 更新检查：当前版本 / 新版本 / 下载信息；只检查不安装", async () => {
  const dir = tempDir();
  const { fetchImpl, calls } = makeGithubFetch();
  const service = createDesktopUpdateService({ userDataDir: dir, currentVersion: "1.0.0", fetchImpl, clock: () => 1_700_000_000_000 });
  const checked = await service.execute("desktop/update/check", {});
  assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.equal(checked.value.currentVersion, "1.0.0");
  assert.equal(checked.value.updateAvailable, true);
  assert.equal(checked.value.installSupported, false);
  assert.equal(checked.value.latest.version, "2.0.0");
  assert.equal(checked.value.latest.assets[0].name, "OpenArc-OS-2.0.0.dmg");
  assert.equal(checked.value.latest.assets[0].downloadUrl, "https://github.com/invaders-2/OpenArc-OS/releases/download/v2.0.0/OpenArc-OS-2.0.0.dmg");
  assert.ok(calls.length >= 1);
  assert.equal(fs.existsSync(path.join(dir, "dxos", "updates", "downloads")), false, "check 不下载");

  const downloaded = await service.execute("desktop/update/download", {});
  assert.equal(downloaded.ok, true, JSON.stringify(downloaded));
  assert.equal(downloaded.value.installed, false);
  assert.equal(downloaded.value.relativePath, "updates/downloads/OpenArc-OS-2.0.0.dmg");
  assert.equal(fs.existsSync(path.join(dir, "dxos", downloaded.value.relativePath)), true);
  assert.equal(JSON.stringify(downloaded.value).includes(dir), false);
});

test("③ 旧版本 / 无预发布：updateAvailable=false；source 校验", async () => {
  const dir = tempDir();
  const old = createDesktopUpdateService({ userDataDir: dir, currentVersion: "3.0.0", fetchImpl: makeGithubFetch({ tag: "v2.0.0" }).fetchImpl });
  const checked = await old.execute("desktop/update/check", {});
  assert.equal(checked.value.updateAvailable, false);

  const badKind = await old.execute("desktop/update/source/set", { kind: "ftp" });
  assert.equal(badKind.ok, false);
  assert.equal(badKind.error, "LOCAL_PROXY_INVALID_INPUT");
  const badRepo = await old.execute("desktop/update/source/set", { kind: "github-releases", owner: "../evil", repo: "x" });
  assert.equal(badRepo.ok, false);
  const good = await old.execute("desktop/update/source/set", { kind: "github-releases", owner: "invaders-2", repo: "OpenArc-OS", channel: "beta" });
  assert.equal(good.ok, true, JSON.stringify(good));
  const read = await old.execute("desktop/update/source/get", {});
  assert.equal(read.value.owner, "invaders-2");
  assert.equal(read.value.channel, "beta");
});

test("③ ModelScope 更新源：清单 + 资产下载；sha256 不一致拒绝且不落盘", async () => {
  const dir = tempDir();
  const body = Buffer.from("modelscope-installer");
  const manifest = { version: "2.1.0", notes: "fixes", publishedAt: 1700000000000, assets: [{ name: "OpenArc-OS-2.1.0.zip", path: "updates/system/OpenArc-OS-2.1.0.zip", size: body.length, sha256: sha256hex(body) }] };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const manifestPath = "updates/system/latest.json";
  const assetPath = "updates/system/OpenArc-OS-2.1.0.zip";
  const routes = {
    [sourceAdapters.modelscopeFilesUrl("bllack", "OpenArc-OS", "master")]: () => new Response(JSON.stringify({ Data: { Files: [
      { Path: manifestPath, Size: manifestBytes.length, Sha256: sha256hex(manifestBytes), Type: "blob" },
      { Path: assetPath, Size: body.length, Sha256: sha256hex(body), Type: "blob" },
    ] } }), { status: 200 }),
    [sourceAdapters.modelscopeDownloadUrl("bllack", "OpenArc-OS", "master", manifestPath)]: () => new Response(manifestBytes, { status: 200 }),
    [sourceAdapters.modelscopeDownloadUrl("bllack", "OpenArc-OS", "master", assetPath)]: () => new Response(body, { status: 200 }),
  };
  const fetchImpl = async (url) => routes[String(url)] ? routes[String(url)]() : new Response("not found", { status: 404 });
  const service = createDesktopUpdateService({ userDataDir: dir, currentVersion: "1.0.0", fetchImpl });
  assert.equal((await service.execute("desktop/update/source/set", { kind: "modelscope-repo", owner: "bllack", repo: "OpenArc-OS" })).ok, true);
  const checked = await service.execute("desktop/update/check", {});
  assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.equal(checked.value.latest.version, "2.1.0");
  assert.equal(checked.value.latest.assets[0].downloadUrl, sourceAdapters.modelscopeDownloadUrl("bllack", "OpenArc-OS", "master", assetPath));
  const downloaded = await service.execute("desktop/update/download", { assetName: "OpenArc-OS-2.1.0.zip" });
  assert.equal(downloaded.ok, true, JSON.stringify(downloaded));
  assert.equal(downloaded.value.sha256, sha256hex(body));

  // 同一份清单把 sha256 改错：下载必须拒绝且不覆盖已下载文件。
  const badManifest = { ...manifest, assets: [{ ...manifest.assets[0], sha256: "0".repeat(64) }] };
  const badBytes = Buffer.from(JSON.stringify(badManifest));
  const badRoutes = {
    [sourceAdapters.modelscopeFilesUrl("bllack", "OpenArc-OS", "master")]: () => new Response(JSON.stringify({ Data: { Files: [
      { Path: manifestPath, Size: badBytes.length, Sha256: sha256hex(badBytes), Type: "blob" },
      { Path: assetPath, Size: body.length, Sha256: sha256hex(body), Type: "blob" },
    ] } }), { status: 200 }),
    [sourceAdapters.modelscopeDownloadUrl("bllack", "OpenArc-OS", "master", manifestPath)]: () => new Response(badBytes, { status: 200 }),
    [sourceAdapters.modelscopeDownloadUrl("bllack", "OpenArc-OS", "master", assetPath)]: () => new Response(body, { status: 200 }),
  };
  const badFetch = async (url) => badRoutes[String(url)] ? badRoutes[String(url)]() : new Response("not found", { status: 404 });
  const badService = createDesktopUpdateService({ userDataDir: dir, currentVersion: "1.0.0", fetchImpl: badFetch });
  assert.equal((await badService.execute("desktop/update/source/set", { kind: "modelscope-repo", owner: "bllack", repo: "OpenArc-OS" })).ok, true);
  const failed = await badService.execute("desktop/update/download", { assetName: "OpenArc-OS-2.1.0.zip" });
  assert.equal(failed.ok, false, JSON.stringify(failed));
  assert.equal(failed.error, "LOCAL_PROXY_INTERNAL");
});

test("③ 非白名单资产 URL 被过滤，不能借更新检查访问任意主机", async () => {
  const dir = tempDir();
  const service = createDesktopUpdateService({ userDataDir: dir, currentVersion: "1.0.0", fetchImpl: makeGithubFetch({ assetUrl: "https://evil.example.com/x.dmg" }).fetchImpl });
  const checked = await service.execute("desktop/update/check", {});
  assert.equal(checked.ok, true);
  assert.equal(checked.value.latest.assets.length, 0);
  assert.equal(checked.value.downloadAvailable, false);
  const download = await service.execute("desktop/update/download", {});
  assert.equal(download.ok, false);
});

// ── ④ 装配契约 ────────────────────────────────────────────────────────────
test("④ main.cjs 装配：三个能力都走 desktop:command，代理 applyProxy/safeStorage 已接", () => {
  const main = fs.readFileSync(path.join(ROOT, "electron", "runtime-composition.cjs"), "utf8");
  assert.ok(main.includes('require("./desktop-cache-service.cjs")'));
  assert.ok(main.includes('require("./desktop-update-service.cjs")'));
  assert.ok(main.includes("createDesktopCacheService({ userDataDir"));
  assert.ok(main.includes("createDesktopUpdateService({"));
  assert.ok(main.includes("currentVersion: app.getVersion()"));
  assert.ok(main.includes("applyProxy: async ({ url, enabled })"));
  assert.ok(main.includes("session.setProxy"));
  assert.ok(main.includes("safeStorage,"));
  assert.ok(main.includes("applyPersistedProxy()"));
  assert.equal(domain.isLocalProxyCommand("desktop/proxy/set"), true);
  assert.equal(domain.isLocalProxyCommand("desktop/cache/clear"), true);
  assert.equal(domain.isLocalProxyCommand("desktop/update/check"), true);
});
