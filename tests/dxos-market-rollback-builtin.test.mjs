/**
 * 「回退到内置版本」的后端验收（离线；真实 static-web 包与协议加载在 dxos-canvas-online-update.test.mjs）。
 *
 * 覆盖 2026-10 可靠性缺口：只装过一个版本时，market/update/rollback 必须能把用户带回随包内置版本，
 * 而不是回 MARKET_UPDATE_ROLLBACK_UNAVAILABLE —— 装了有问题的包之后用户不能被卡在那一版。
 *
 *   ① 只装过一个版本 → 回退内置：内置标记指针、history / 版本目录保留、status 如实
 *   ② 幂等：连续回退不重复写盘、不报错
 *   ③ 原子性：指针写入失败 → 结构化失败，旧指针原封不动，不留临时文件
 *   ④ 有上一版时既有语义不变（优先回上一版）
 *   ⑤ 审计 from→to（内置目标 resourceRef = <appId>@builtin）
 *   ⑥ 指针被改坏时回退动作修复它
 *   ⑦ 回退后仍可再装回同一版本（可再切回）
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
const { createMarketUpdateBundle } = require("../electron/market-update-service.cjs");
const { writeZip } = require("../electron/canvas-dxos-zip.cjs");

const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-market-builtin-")); tmpDirs.push(dir); return dir; }

const sha256hex = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const BUILTIN = "0.1.0";
const REPO_KEYPAIR = (() => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  return { publicKeyBase64: der.subarray(der.length - 32).toString("base64"), privateKey };
})();

/** 最小 openarc-app/v1 js-module 包（与既有测试同一构造方式）。 */
function buildPackage(version, privateKey = REPO_KEYPAIR.privateKey) {
  const js = Buffer.from("console.log(\"canvas " + version + "\");");
  const css = Buffer.from(".canvas-" + version.replace(/\./g, "_") + "{color:red}");
  const manifest = {
    format: "openarc-app/v1", id: "canvas", name: "无限画布", version, build: 1,
    entry: "index.js", styles: ["index.css"],
    files: { "index.js": sha256hex(js), "index.css": sha256hex(css) },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const signature = crypto.sign(null, manifestBytes, privateKey).toString("base64");
  return writeZip([
    { name: "manifest.json", data: manifestBytes },
    { name: "manifest.sig", data: Buffer.from(signature, "utf8") },
    { name: "index.js", data: js },
    { name: "index.css", data: css },
  ]);
}

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

function makeBundle(versions = ["0.1.0"]) {
  const dir = tempDir();
  const keysFile = path.join(dir, "app-update-keys.json");
  fs.writeFileSync(keysFile, JSON.stringify({ canvas: REPO_KEYPAIR.publicKeyBase64 }));
  const audits = [];
  const zips = Object.fromEntries(versions.map((version) => [version, buildPackage(version)]));
  const routes = {
    [API_URL]: () => new Response(JSON.stringify(versions.map(makeRelease)), { status: 200, headers: { "content-type": "application/json" } }),
    ...Object.fromEntries(versions.map((version) => [assetUrl(version), () => new Response(zips[version], { status: 200 })])),
  };
  const bundle = createMarketUpdateBundle({
    userDataDir: dir,
    keysFile,
    fetchImpl: async (url) => {
      const route = routes[String(url)];
      return route ? route() : new Response("not found", { status: 404 });
    },
    authorization: {
      resolveActor: () => ({ ok: true, user: { id: "u1" } }),
      store: { auditAuthorization: (row) => { audits.push(row); } },
    },
    builtinVersion: BUILTIN,
    clock: () => 1_700_000_000_000,
    sourceKind: "github-releases",
  });
  return { bundle, dir, audits, keysFile };
}

const stateDir = (dir) => path.join(dir, "dxos", "apps", "canvas");
const currentFile = (dir) => path.join(stateDir(dir), "current.json");
const historyFile = (dir) => path.join(stateDir(dir), "history.json");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const session = { sessionRef: "sess-1" };
const install = (bundle, version) => bundle.execute("market/update/install", { confirm: true, version }, session);
const rollback = (bundle, payload = {}) => bundle.execute("market/update/rollback", payload, session);

/* ══════════════════════════════════════════════════════════════════════════
   ① 只装过一个版本 → 回退到内置版本
   ══════════════════════════════════════════════════════════════════════════ */

test("① 只装过一个版本：rollback 回退到内置版本，指针写成内置标记，history / 版本目录保留", async () => {
  const { bundle, dir, audits } = makeBundle(["0.2.0"]);
  assert.equal((await install(bundle, "0.2.0")).ok, true);
  assert.deepEqual(readJson(historyFile(dir)).versions, ["0.2.0"]);

  const before = await bundle.execute("market/update/status", { appId: "canvas" }, session);
  assert.equal(before.value.current.version, "0.2.0");
  assert.equal(before.value.canRollback, false, "只装过一个版本：没有上一版已安装版本");
  assert.deepEqual(before.value.rollbackTarget, { kind: "builtin", version: BUILTIN }, "回退入口必须指向内置版本");

  const result = await rollback(bundle);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value, { rolledBackTo: "builtin", previous: { version: "0.2.0" } });

  const pointer = readJson(currentFile(dir));
  assert.equal(pointer.mode, "builtin");
  assert.equal(pointer.version, null);
  assert.equal(pointer.builtinVersion, BUILTIN);
  assert.equal(pointer.rolledBackFrom, "0.2.0", "指针要记下回退前是哪一版");
  assert.equal(pointer.clearedAt, 1_700_000_000_000);

  // 「不要删用户已安装的版本目录」——目录与 history 原样保留，随时可以再切回。
  assert.ok(fs.existsSync(path.join(stateDir(dir), "0.2.0", "manifest.json")), "已安装版本目录必须保留");
  assert.deepEqual(readJson(historyFile(dir)).versions, ["0.2.0"], "history 保留，便于再切回");

  // 回退后 status 必须如实。
  const after = await bundle.execute("market/update/status", { appId: "canvas" }, session);
  assert.equal(after.value.current, null, "回退后没有生效的已安装版本");
  assert.equal(after.value.canRollback, false);
  assert.equal(after.value.rollbackTarget, null, "已经在用内置版本，没有可回退的东西");
  assert.equal(after.value.builtinVersion, BUILTIN);
  assert.equal(after.value.updateAvailable, false);

  const allow = audits.filter((row) => row.action === "canvas.update.rollback" && row.decision === "ALLOW").pop();
  assert.ok(allow, "回退必须写 ALLOW 审计");
  assert.equal(allow.resourceRef, "canvas@builtin", "内置目标的 resourceRef 记为 <appId>@builtin");
  assert.deepEqual(allow.oldPermissions, [{ kind: "installed", version: "0.2.0" }], "审计要留 from");
  assert.deepEqual(allow.newPermissions, [{ kind: "builtin", version: BUILTIN }], "审计要留 to");
});

test("①b 回退内置后 latest 依旧如实：status 仍报 latest=0.2.0，updateAvailable 按内置版本计算", async () => {
  const { bundle, dir } = makeBundle(["0.2.0"]);
  await install(bundle, "0.2.0");
  const checked = await bundle.execute("market/update/check", { appId: "canvas" }, session);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.equal(checked.value.latest.version, "0.2.0");
  assert.equal(checked.value.updateAvailable, false, "当前就是 0.2.0，不算有更新");

  assert.equal((await rollback(bundle)).ok, true);
  const status = await bundle.execute("market/update/status", { appId: "canvas" }, session);
  assert.equal(status.value.latest.version, "0.2.0", "回退不能抹掉上次检查结果");
  assert.equal(status.value.updateAvailable, true, "回到内置 0.1.0 后 0.2.0 确实是新版本");
  assert.equal(status.value.checkedAt, 1_700_000_000_000);
  assert.equal(readJson(currentFile(dir)).mode, "builtin");
});

/* ══════════════════════════════════════════════════════════════════════════
   ② 幂等
   ══════════════════════════════════════════════════════════════════════════ */

test("② 幂等：重复回退不重复写盘、不报错、不造新状态", async () => {
  const { bundle, dir, audits } = makeBundle(["0.2.0"]);
  await install(bundle, "0.2.0");
  const first = await rollback(bundle);
  assert.equal(first.ok, true, JSON.stringify(first));
  const pointerText = fs.readFileSync(currentFile(dir), "utf8");

  const second = await rollback(bundle);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(second.value, { rolledBackTo: "builtin", previous: null }, "已经在内置版本时 previous 为 null");
  assert.equal(fs.readFileSync(currentFile(dir), "utf8"), pointerText, "幂等回退不得改写指针（同一次回退的 clearedAt 不变）");
  assert.equal(fs.readdirSync(stateDir(dir)).filter((name) => name.startsWith("current.json.tmp-")).length, 0, "不得留下临时文件");

  const third = await rollback(bundle);
  assert.equal(third.ok, true);
  assert.deepEqual(third.value, { rolledBackTo: "builtin", previous: null });
  assert.equal(fs.readFileSync(currentFile(dir), "utf8"), pointerText);

  const allows = audits.filter((row) => row.action === "canvas.update.rollback" && row.decision === "ALLOW");
  assert.equal(allows.length, 3, "每次调用都留一条 ALLOW 审计（含幂等 no-op）");
  assert.deepEqual(allows[1].oldPermissions, null, "no-op 没有 from");
  assert.deepEqual(allows[1].newPermissions, [{ kind: "builtin", version: BUILTIN }]);
});

test("②b 从没装过任何版本：rollback 幂等回内置，不写指针", async () => {
  const { bundle, dir } = makeBundle(["0.2.0"]);
  const result = await rollback(bundle);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value, { rolledBackTo: "builtin", previous: null });
  assert.equal(fs.existsSync(currentFile(dir)), false, "从来没装过就不该凭空写出指针文件");
  assert.equal((await bundle.execute("market/update/status", { appId: "canvas" }, session)).value.current, null);
});

/* ══════════════════════════════════════════════════════════════════════════
   ③ 原子性：写入失败不能留下中间态
   ══════════════════════════════════════════════════════════════════════════ */

test("③ 原子性：指针写入失败 → 结构化失败，旧指针原封不动，不留临时文件，可重试", async () => {
  const { bundle, dir, audits } = makeBundle(["0.2.0"]);
  await install(bundle, "0.2.0");
  const pointerBefore = fs.readFileSync(currentFile(dir), "utf8");

  const originalRename = fs.renameSync;
  let failed;
  try {
    fs.renameSync = () => { throw new Error("EIO: simulated rename failure"); };
    failed = await rollback(bundle);
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(failed.ok, false, JSON.stringify(failed));
  assert.equal(failed.error, "DXOS_ERR_INTERNAL", "写入失败要给结构化错误码，不能假装成功");
  assert.match(failed.detail, /simulated rename failure/);
  assert.equal(fs.readFileSync(currentFile(dir), "utf8"), pointerBefore, "失败后指针必须还是原来那一版（既非 installed 也非 builtin 的中间态不允许出现）");
  assert.equal(readJson(currentFile(dir)).version, "0.2.0");
  assert.deepEqual(fs.readdirSync(stateDir(dir)).filter((name) => name.startsWith("current.json.tmp-")), [], "临时文件必须清掉");

  const status = await bundle.execute("market/update/status", { appId: "canvas" }, session);
  assert.equal(status.value.current.version, "0.2.0", "status 与磁盘一致");
  assert.deepEqual(status.value.rollbackTarget, { kind: "builtin", version: BUILTIN });

  const deny = audits.filter((row) => row.action === "canvas.update.rollback" && row.decision === "DENY").pop();
  assert.ok(deny, "失败必须写 DENY 审计");
  assert.equal(deny.reasonCode, "DXOS_ERR_INTERNAL");

  // 恢复后可以正常重试（可重复执行）。
  const retried = await rollback(bundle);
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(readJson(currentFile(dir)).mode, "builtin");
});

/* ══════════════════════════════════════════════════════════════════════════
   ④ 有上一版时既有语义不变
   ══════════════════════════════════════════════════════════════════════════ */

test("④ 有上一版已安装版本：仍优先回到那一版，不回内置", async () => {
  const { bundle, dir, audits } = makeBundle(["0.1.0", "0.2.0"]);
  await install(bundle, "0.1.0");
  await install(bundle, "0.2.0");
  const status = await bundle.execute("market/update/status", { appId: "canvas" }, session);
  assert.equal(status.value.canRollback, true);
  assert.deepEqual(status.value.rollbackTarget, { kind: "installed", version: "0.1.0" });

  const result = await rollback(bundle);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value, { rolledBackTo: "0.1.0", previous: { version: "0.2.0" } }, "既有回滚回包形状不变");
  const pointer = readJson(currentFile(dir));
  assert.equal(pointer.version, "0.1.0");
  assert.equal(pointer.mode, undefined, "回到已安装版本时不写内置标记");
  assert.deepEqual(readJson(historyFile(dir)).versions, ["0.1.0"], "回上一版仍按既有语义截断 history");

  const allow = audits.filter((row) => row.action === "canvas.update.rollback" && row.decision === "ALLOW").pop();
  assert.equal(allow.resourceRef, "canvas@0.1.0", "既有 resourceRef 形状不变");
  assert.deepEqual(allow.oldPermissions, [{ kind: "installed", version: "0.2.0" }]);
  assert.deepEqual(allow.newPermissions, [{ kind: "installed", version: "0.1.0" }]);

  // 再回退一次：现在只剩 0.1.0，没有上一版 → 回退到内置版本。
  const second = await rollback(bundle);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(second.value, { rolledBackTo: "builtin", previous: { version: "0.1.0" } });
  assert.equal(readJson(currentFile(dir)).mode, "builtin");
});

/* ══════════════════════════════════════════════════════════════════════════
   ⑤ 指针被改坏 → 回退动作修复它
   ══════════════════════════════════════════════════════════════════════════ */

test("⑤ 指针被改坏（不是内置标记）：回退动作把它修成明确的内置标记，并如实回报 previous=null", async () => {
  const { bundle, dir } = makeBundle(["0.2.0"]);
  await install(bundle, "0.2.0");
  fs.writeFileSync(currentFile(dir), "{ corrupted");
  assert.equal((await bundle.execute("market/update/status", { appId: "canvas" }, session)).value.current, null);

  const result = await rollback(bundle);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value, { rolledBackTo: "builtin", previous: null }, "指针已读不出版本，只能如实回 previous=null");
  const pointer = readJson(currentFile(dir));
  assert.equal(pointer.mode, "builtin");
  assert.equal(pointer.rolledBackFrom, null);
  assert.deepEqual(fs.readdirSync(stateDir(dir)).filter((name) => name.startsWith("current.json.tmp-")), []);
});

/* ══════════════════════════════════════════════════════════════════════════
   ⑥ 回退后仍可再切回（再装一次同一版本）
   ══════════════════════════════════════════════════════════════════════════ */

test("⑥ 回退内置后再装同一版本仍然成功，指针恢复为已安装（可再切回）", async () => {
  const { bundle, dir, audits } = makeBundle(["0.2.0"]);
  await install(bundle, "0.2.0");
  assert.equal((await rollback(bundle)).ok, true);
  assert.equal(readJson(currentFile(dir)).mode, "builtin");

  const again = await install(bundle, "0.2.0");
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.deepEqual(again.value.previous, null, "回退后没有生效版本，previous 如实为 null");
  const pointer = readJson(currentFile(dir));
  assert.equal(pointer.version, "0.2.0");
  assert.equal(pointer.kind, "js-module");
  assert.equal(pointer.mode, undefined, "重新安装后不再是内置标记");
  assert.deepEqual(fs.readdirSync(stateDir(dir)).filter((name) => name.startsWith(".staging-")), []);
  assert.deepEqual(readJson(historyFile(dir)).versions, ["0.2.0"], "history 里同一版本只留一条");

  const status = await bundle.execute("market/update/status", { appId: "canvas" }, session);
  assert.equal(status.value.current.version, "0.2.0");
  assert.deepEqual(status.value.rollbackTarget, { kind: "builtin", version: BUILTIN }, "只装过这一版，回退入口仍指向内置");
  assert.equal(status.value.canRollback, false);
  assert.ok(audits.some((row) => row.action === "canvas.update.install" && row.decision === "ALLOW"));
});
