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
const { createDeveloperStore } = require("../electron/developer-store.cjs");

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

function openFixture(options = {}) {
  const dir = tempDir("dxos-dev-mig-install-");
  const identity = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  const vfs = createDxosFs({ dataDir: path.join(dir, "fs") });
  const root = vfs.createNode({ name: "Project", type: "folder", parentId: null, ownerId: "u1" });
  const snapshotRoot = path.join(dir, "dxos", "developer-apps", "migrations");
  // B7h：故障注入用真实 store 的包装（只在目标版本上抛），其余调用照常走真实落盘 / SQL。
  const injectedStore = typeof options.wrapStore === "function"
    ? options.wrapStore(createDeveloperStore({ db: identity.connection, dataRoot: path.join(dir, "dxos"), clock: () => 1_700_000_000_000 }))
    : null;
  const bundle = createDeveloperBundle({
    userDataDir: dir,
    identityStore: identity,
    authorization: { resolveActor: () => ({ ok: true, user: { id: "u1" } }) },
    migrationFs: vfs,
    migrationSnapshotRoot: snapshotRoot,
    ...(injectedStore ? { store: injectedStore } : {}),
    clock: () => 1_700_000_000_000,
  });
  const call = (command, payload) => bundle.execute(command, payload || {}, { sessionRef: "sess-mig" });
  return { dir, identity, vfs, root, snapshotRoot, bundle, call };
}

/** B7h：安装相关三张表的调用前快照（失败后必须逐行一致）。 */
function installStateRows(db) {
  const rows = (sql) => db.prepare(sql).all();
  return {
    user_installed_apps: rows("SELECT * FROM user_installed_apps WHERE app_id='dev-demo' ORDER BY user_id"),
    user_app_install_state: rows("SELECT * FROM user_app_install_state ORDER BY user_id"),
    app_market_releases: rows("SELECT * FROM app_market_releases WHERE app_id='dev-demo' ORDER BY version,build,channel"),
  };
}

/** 升级到 1.1.0 / dataVersion 2 的包（写 src/created.txt 的声明式迁移）。 */
function upgradeV2Package() {
  return pack(manifest({
    version: "1.1.0", build: 2, dataVersion: 2,
    migrations: [{ from: 1, to: 2, type: "declarative", file: "migrations/1-2.json" }],
  }), [["migrations/1-2.json", { format: MIG, operations: [{ op: "write", path: "src/created.txt", content: "v2" }] }]]);
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

// ── B7h：安装失败方向的两条用例（此前只覆盖"迁移自己失败"） ──────────────────

test("写包失败：迁移一次都没跑，三张表与调用前逐行一致（不存在数据已迁移、版本未更新）", async () => {
  const fx = openFixture({
    wrapStore: (real) => Object.assign({}, real, {
      writePackage: (appId, manifestValue, files, meta) => {
        if (manifestValue && manifestValue.version === "1.1.0") throw new Error("WRITE_PACKAGE_BOOM");
        return real.writePackage(appId, manifestValue, files, meta);
      },
    }),
  });
  try {
    const v1 = await fx.call("developer/install", { package: pack(manifest()).toString("base64") });
    assert.equal(v1.ok, true, JSON.stringify(v1));
    const before = installStateRows(fx.identity.connection);

    const failed = await fx.call("developer/install", { package: upgradeV2Package().toString("base64"), migrationRoots: [{ ownerId: "u1", rootId: fx.root.id }] });
    assert.equal(failed.ok, false, JSON.stringify(failed));
    assert.equal(fx.vfs.findByPath(fx.root.id, "src/created.txt"), null, "写包失败必须在迁移之前返回，不得留下迁移副作用");
    assert.equal(markerVersion(fx.vfs, fx.root.id), null, "没有迁移执行就不该有项目标记");
    assert.deepEqual(installStateRows(fx.identity.connection), before, "三张表必须与调用前一致");

    const got = await fx.call("developer/get", { appId: "dev-demo" });
    assert.equal(got.value.version, "1.0.0", "安装态 / 版本不变");
    assert.equal(got.value.manifest.dataVersion, 1);
  } finally { try { fx.identity.close(); } catch { /* 已关 */ } }
});

test("激活失败：迁移已落盘也必须按快照恢复，三张表与调用前逐行一致（不半应用）", async () => {
  const fx = openFixture({
    wrapStore: (real) => Object.assign({}, real, {
      activateRelease: (input) => {
        if (input && input.manifest && input.manifest.version === "1.1.0") throw new Error("ACTIVATE_BOOM");
        return real.activateRelease(input);
      },
    }),
  });
  try {
    const v1 = await fx.call("developer/install", { package: pack(manifest()).toString("base64") });
    assert.equal(v1.ok, true, JSON.stringify(v1));
    const before = installStateRows(fx.identity.connection);

    const failed = await fx.call("developer/install", { package: upgradeV2Package().toString("base64"), migrationRoots: [{ ownerId: "u1", rootId: fx.root.id }] });
    assert.equal(failed.ok, false, JSON.stringify(failed));
    // 迁移确实执行过（留下快照）——证明回滚不是"迁移根本没跑"的假象。
    assert.ok(fs.existsSync(path.join(fx.snapshotRoot, "dev-demo", "1.1.0+2")), "激活前必须已执行迁移并留下快照");
    assert.equal(fx.vfs.findByPath(fx.root.id, "src/created.txt"), null, "激活失败必须恢复迁移快照");
    assert.equal(markerVersion(fx.vfs, fx.root.id), null, "项目标记必须回到迁移前（不存在）");
    assert.deepEqual(installStateRows(fx.identity.connection), before, "三张表必须与调用前一致");

    const got = await fx.call("developer/get", { appId: "dev-demo" });
    assert.equal(got.value.version, "1.0.0", "安装态 / 版本不变");
    assert.equal(got.value.manifest.dataVersion, 1);
  } finally { try { fx.identity.close(); } catch { /* 已关 */ } }
});

