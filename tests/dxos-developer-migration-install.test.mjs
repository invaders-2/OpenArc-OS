/**
 * B7f · 安装 / 升级接入声明式迁移（developer-service.cjs + developer-migrations.cjs）。
 *
 * 断言：
 *   ① 升级 dataVersion 且有迁移声明 → 迁移成功、dataVersion 更新、项目标记更新；
 *   ② 迁移失败 → 整批回滚（快照恢复），安装态 / 当前版本不变（不半应用）；
 *   ③ 无迁移声明 → 保持原来的 CONFLICT 拒绝语义。
 *
 * 全离线：真实 IdentityStore + B6 虚拟文件树 + 真实迁移引擎，不联网。
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const { writeZip } = require("../electron/canvas-dxos-zip.cjs");
const { createDxosFs } = require("../electron/dxos-fs.cjs");
const mig = require("../electron/developer-migrations.cjs");
const { createDeveloperBundle } = require("../electron/developer-service.cjs");

const tmpDirs = [];
after(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
function tempDir(prefix) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(dir); return dir; }

function manifest(overrides = {}) {
  return Object.assign({
    format: "dx-app/v2", id: "demo", name: "Demo App", description: "a demo developer application",
    version: "1.0.0", build: 1, entry: "index.html", dataVersion: 1,
  }, overrides);
}
function pack(manifestValue, migrationFiles = []) {
  const entries = [
    { name: "dx-app.json", data: Buffer.from(JSON.stringify(manifestValue)) },
    { name: "index.html", data: Buffer.from("<html><body>demo</body></html>") },
  ];
  for (const [file, doc] of migrationFiles) entries.push({ name: file, data: Buffer.from(JSON.stringify(doc)) });
  return writeZip(entries);
}
const MIG = mig.MIGRATION_FORMAT;

function openFixture() {
  const dir = tempDir("dxos-dev-mig-install-");
  const identity = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  const vfs = createDxosFs({ dataDir: path.join(dir, "fs") });
  const root = vfs.createNode({ name: "Project", type: "folder", parentId: null, ownerId: "u1" });
  const snapshotRoot = path.join(dir, "dxos", "developer-apps", "migrations");
  const bundle = createDeveloperBundle({
    userDataDir: dir,
    identityStore: identity,
    authorization: { resolveActor: () => ({ ok: true, user: { id: "u1" } }) },
    migrationFs: vfs,
    migrationSnapshotRoot: snapshotRoot,
    clock: () => 1_700_000_000_000,
  });
  const call = (command, payload) => bundle.execute(command, payload || {}, { sessionRef: "sess-mig" });
  return { dir, identity, vfs, root, snapshotRoot, bundle, call };
}
const markerVersion = (vfs, rootId) => {
  const marker = vfs.findByPath(rootId, mig.PROJECT_MARKER);
  return marker ? Number(JSON.parse(marker.content).dataVersion) : null;
};

test("升级有迁移声明：迁移成功、dataVersion 更新、项目标记更新并可回滚快照", async () => {
  const fx = openFixture();
  try {
    const v1 = await fx.call("developer/install", { package: pack(manifest()).toString("base64") });
    assert.equal(v1.ok, true, JSON.stringify(v1));
    assert.equal(v1.value.manifest.dataVersion, 1);

    const v2 = pack(manifest({
      version: "1.1.0", build: 2, dataVersion: 2,
      migrations: [{ from: 1, to: 2, type: "declarative", file: "migrations/1-2.json" }],
    }), [["migrations/1-2.json", { format: MIG, operations: [{ op: "write", path: "src/created.txt", content: "v2" }] }]]);
    const installed = await fx.call("developer/install", { package: v2.toString("base64"), migrationRoots: [{ ownerId: "u1", rootId: fx.root.id }] });
    assert.equal(installed.ok, true, JSON.stringify(installed));
    assert.equal(installed.value.version, "1.1.0");
    assert.equal(installed.value.manifest.dataVersion, 2);
    assert.equal(fx.vfs.findByPath(fx.root.id, "src/created.txt").content, "v2", "迁移必须落到项目根");
    assert.equal(markerVersion(fx.vfs, fx.root.id), 2, "项目标记 dataVersion 必须更新");
    assert.ok(fs.existsSync(path.join(fx.snapshotRoot, "dev-demo", "1.1.0+2")), "升级必须留迁移快照");

    const got = await fx.call("developer/get", { appId: "dev-demo" });
    assert.equal(got.value.manifest.dataVersion, 2);
  } finally { try { fx.identity.close(); } catch { /* 已关 */ } }
});

test("迁移失败：整批回滚到快照，安装态与当前版本不变（不半应用）", async () => {
  const fx = openFixture();
  try {
    await fx.call("developer/install", { package: pack(manifest()).toString("base64") });
    const good = pack(manifest({
      version: "1.1.0", build: 2, dataVersion: 2,
      migrations: [{ from: 1, to: 2, type: "declarative", file: "migrations/1-2.json" }],
    }), [["migrations/1-2.json", { format: MIG, operations: [{ op: "write", path: "ok.txt", content: "ok" }] }]]);
    assert.equal((await fx.call("developer/install", { package: good.toString("base64"), migrationRoots: [{ ownerId: "u1", rootId: fx.root.id }] })).ok, true);

    // v3 的迁移 move 一个不存在的源 → 引擎失败 → 必须回滚到快照，且安装不落盘。
    const bad = pack(manifest({
      version: "1.2.0", build: 3, dataVersion: 3,
      migrations: [{ from: 2, to: 3, type: "declarative", file: "migrations/2-3.json" }],
    }), [["migrations/2-3.json", { format: MIG, operations: [{ op: "move", from: "missing.txt", to: "z.txt" }] }]]);
    const failed = await fx.call("developer/install", { package: bad.toString("base64"), migrationRoots: [{ ownerId: "u1", rootId: fx.root.id }] });
    assert.equal(failed.ok, false);
    assert.equal(failed.error, "DEVELOPER_CONFLICT");
    assert.equal(fx.vfs.findByPath(fx.root.id, "z.txt"), null, "失败迁移不得留下半个文件");
    assert.equal(markerVersion(fx.vfs, fx.root.id), 2, "回滚后标记必须回到 2");

    const got = await fx.call("developer/get", { appId: "dev-demo" });
    assert.equal(got.ok, true);
    assert.equal(got.value.version, "1.1.0", "安装态必须停在上一版本");
    assert.equal(got.value.manifest.dataVersion, 2);
  } finally { try { fx.identity.close(); } catch { /* 已关 */ } }
});

test("无迁移声明：dataVersion 变化保持原 CONFLICT 拒绝语义", async () => {
  const fx = openFixture();
  try {
    await fx.call("developer/install", { package: pack(manifest()).toString("base64") });
    const noMigration = pack(manifest({ version: "1.1.0", build: 2, dataVersion: 2 }));
    const rejected = await fx.call("developer/install", { package: noMigration.toString("base64") });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, "DEVELOPER_CONFLICT");
    const got = await fx.call("developer/get", { appId: "dev-demo" });
    assert.equal(got.value.version, "1.0.0");
    assert.equal(got.value.manifest.dataVersion, 1);
  } finally { try { fx.identity.close(); } catch { /* 已关 */ } }
});
