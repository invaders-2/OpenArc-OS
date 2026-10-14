/**
 * B7b · 声明式迁移（源 developerProjectMigrations.ts:1-170）。
 * 被测：electron/developer-migrations.cjs；虚拟文件树用 B6 的 createDxosFs（真实实现，离线）。
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mig = require("../electron/developer-migrations.cjs");
const { createDxosFs } = require("../electron/dxos-fs.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oa-developer-migrations-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
function makeRoot() {
  seq += 1;
  const dataDir = path.join(tmp, "fs-" + seq);
  const vfs = createDxosFs({ dataDir });
  const root = vfs.createNode({ name: "Project" + seq, type: "folder", parentId: null, ownerId: "u1" });
  return { vfs, root, dataDir };
}
function makeStore(name) {
  return new mig.DeveloperMigrationSnapshotStore({ snapshotRoot: path.join(tmp, "snapshots-" + name) });
}

test("apply：mkdir / write / move 落位并写回标记", () => {
  const { vfs, root } = makeRoot();
  vfs.createNode({ name: "readme.txt", type: "file", parentId: root.id, ownerId: "u1", content: "hello" });
  const doc = {
    format: mig.MIGRATION_FORMAT,
    operations: [
      { op: "mkdir", path: "src" },
      { op: "write", path: "src/main.js", content: "console.log(1)" },
      { op: "move", from: "readme.txt", to: "src/readme.txt" },
    ],
  };
  assert.equal(mig.applyDeclarativeProjectMigration({ rootId: root.id, ownerId: "u1", raw: doc, from: 1, to: 2, fsAdapter: vfs }), 3);
  assert.equal(vfs.findByPath(root.id, "src/main.js").content, "console.log(1)");
  assert.equal(vfs.findByPath(root.id, "src/readme.txt").content, "hello");
  assert.equal(vfs.findByPath(root.id, "readme.txt"), null);
  const marker = JSON.parse(vfs.findByPath(root.id, mig.PROJECT_MARKER).content);
  assert.equal(marker.dataVersion, 2);
});

test("幂等：同一份迁移第二次执行返回 0，且不重复移动 / 不重复写", () => {
  const { vfs, root } = makeRoot();
  const doc = {
    format: mig.MIGRATION_FORMAT,
    operations: [
      { op: "write", path: "once.txt", content: "v1" },
      { op: "move", from: "once.txt", to: "moved.txt" },
    ],
  };
  assert.equal(mig.applyDeclarativeProjectMigration({ rootId: root.id, ownerId: "u1", raw: doc, from: 1, to: 2, fsAdapter: vfs }), 2);
  assert.equal(mig.applyDeclarativeProjectMigration({ rootId: root.id, ownerId: "u1", raw: doc, from: 1, to: 2, fsAdapter: vfs }), 0, "第二次必须跳过");
  assert.equal(vfs.findByPath(root.id, "moved.txt").content, "v1");
  assert.equal(vfs.findByPath(root.id, "once.txt"), null);
  // 用 ifMissing 的 write 也保持幂等。
  const idem = { format: mig.MIGRATION_FORMAT, operations: [{ op: "write", path: "moved.txt", content: "v2", ifMissing: true }] };
  mig.applyDeclarativeProjectMigration({ rootId: root.id, ownerId: "u1", raw: idem, from: 2, to: 3, fsAdapter: vfs });
  assert.equal(vfs.findByPath(root.id, "moved.txt").content, "v1");
});

test("动手前校验：非法操作 / 越界路径 / 超限体积都不会产生任何写入", () => {
  const { vfs, root } = makeRoot();
  const bad = { format: mig.MIGRATION_FORMAT, operations: [{ op: "write", path: "newfile.txt", content: "x" }, { op: "bogus", path: "y" }] };
  assert.throws(() => mig.applyDeclarativeProjectMigration({ rootId: root.id, ownerId: "u1", raw: bad, from: 1, to: 2, fsAdapter: vfs }), /不支持的声明式迁移操作/);
  assert.equal(vfs.findByPath(root.id, "newfile.txt"), null, "校验失败必须在动手之前，不能留下半个文件");
  assert.throws(() => mig.validateDeclarativeMigrationDocument({ format: mig.MIGRATION_FORMAT, operations: [{ op: "write", path: "../escape.txt", content: "x" }] }, 1, 2), /路径不合法/);
  assert.throws(() => mig.validateDeclarativeMigrationDocument({ format: "wrong/v1", operations: [{ op: "mkdir", path: "a" }] }, 1, 2), /缺少 format/);
  assert.throws(() => mig.validateDeclarativeMigrationDocument({ format: mig.MIGRATION_FORMAT, operations: [] }, 1, 2), /必须包含 1–200 项/);
  assert.throws(() => mig.validateDeclarativeMigrationDocument({ format: mig.MIGRATION_FORMAT, operations: [{ op: "write", path: "big.txt", content: "x".repeat(mig.MAX_WRITE_BYTES + 1) }] }, 1, 2), /超过 2 MB/);
  assert.throws(() => mig.projectPath("/abs"), /不合法/);
  assert.throws(() => mig.projectPath("a/../b"), /不合法/);
  assert.throws(() => mig.projectPath(".hidden/x"), /不合法/);
  assert.equal(mig.projectPath("src/ok.js"), "src/ok.js");
  // 源 :30-34 safeId 允许点号，但拒绝路径分隔符 / 空串。
  assert.equal(mig.safeId("dx-app", "APP ID"), "dx-app");
  assert.throws(() => mig.safeId("a/b", "APP ID"), /不合法/);
  assert.throws(() => mig.safeId("", "APP ID"), /不合法/);
});

test("迁移链：应用失败恢复全部快照（不半应用）", () => {
  const { vfs, root } = makeRoot();
  const store = makeStore("chain");
  vfs.createNode({ name: "keep.txt", type: "file", parentId: root.id, ownerId: "u1", content: "keep" });
  const docs = [
    { from: 1, to: 2, document: { format: mig.MIGRATION_FORMAT, operations: [{ op: "write", path: "newfile.txt", content: "x" }] } },
    { from: 2, to: 3, document: { format: mig.MIGRATION_FORMAT, operations: [{ op: "move", from: "missing.txt", to: "z.txt" }] } },
  ];
  const result = store.applyChain({ appId: "dx-demo", historyId: "h-fail", roots: [{ ownerId: "u1", rootId: root.id }], documents: docs, fsAdapter: vfs });
  assert.equal(result.ok, false);
  assert.equal(result.detail.rolledBack, true);
  assert.match(result.error, /迁移源路径不存在/);
  assert.equal(vfs.findByPath(root.id, "newfile.txt"), null, "失败后第一个迁移的写入必须被回滚");
  assert.equal(vfs.findByPath(root.id, "keep.txt").content, "keep", "原有内容不受影响");
  assert.equal(vfs.findByPath(root.id, mig.PROJECT_MARKER), null, "回滚后标记也不应残留");

  // 成功路径：连续链顺序应用。
  const okDocs = [
    { from: 1, to: 2, document: { format: mig.MIGRATION_FORMAT, operations: [{ op: "write", path: "a.txt", content: "A" }] } },
    { from: 2, to: 3, document: { format: mig.MIGRATION_FORMAT, operations: [{ op: "write", path: "b.txt", content: "B" }] } },
  ];
  const applied = store.applyChain({ appId: "dx-demo", historyId: "h-ok", roots: [{ ownerId: "u1", rootId: root.id }], documents: okDocs, fsAdapter: vfs });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.applied, 2);
  assert.equal(vfs.findByPath(root.id, "a.txt").content, "A");
  assert.equal(vfs.findByPath(root.id, "b.txt").content, "B");

  // 校验失败：链里有不支持的 op → 在动手前拒绝（detail.stage = validate）。
  const invalid = store.applyChain({ appId: "dx-demo", historyId: "h-invalid", roots: [{ ownerId: "u1", rootId: root.id }], documents: [
    { from: 5, to: 6, document: { format: mig.MIGRATION_FORMAT, operations: [{ op: "bogus", path: "x" }] } },
  ], fsAdapter: vfs });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.detail.stage, "validate");

  // 链不连续：第二段 from 与第一段 to 对不上 → 拒绝。
  const discontinuous = store.applyChain({ appId: "dx-demo", historyId: "h-disc", roots: [{ ownerId: "u1", rootId: root.id }], documents: [
    { from: 5, to: 6, document: okDocs[0].document },
    { from: 8, to: 9, document: okDocs[1].document },
  ], fsAdapter: vfs });
  assert.equal(discontinuous.ok, false);
  assert.equal(discontinuous.detail, "migration-chain-not-contiguous");
});

test("快照：保存 / 判定 / 正向回滚点 / 恢复 / 删除", () => {
  const { vfs, root } = makeRoot();
  const store = makeStore("snapshot");
  const file = vfs.createNode({ name: "state.txt", type: "file", parentId: root.id, ownerId: "u1", content: "v1" });
  store.saveSnapshot({ appId: "dx-snap", historyId: "h1", ownerId: "u1", rootId: root.id, fsAdapter: vfs });
  assert.equal(store.hasSnapshots("dx-snap", "h1"), true);
  assert.equal(store.hasSnapshots("dx-snap", "nope"), false);

  vfs.setContent(file.id, "v2");
  assert.equal(vfs.findByPath(root.id, "state.txt").content, "v2");
  const restored = store.restoreSnapshots({ appId: "dx-snap", historyId: "h1", fsAdapter: vfs });
  assert.equal(restored.length, 1);
  assert.equal(vfs.findByPath(root.id, "state.txt").content, "v1");

  assert.equal(store.saveForwardSnapshots({ appId: "dx-snap", referenceHistoryId: "h1", newHistoryId: "h2", fsAdapter: vfs }), 1);
  assert.equal(store.hasSnapshots("dx-snap", "h2"), true);
  store.deleteSnapshot("dx-snap", "h2");
  assert.equal(store.hasSnapshots("dx-snap", "h2"), false);
  store.deleteSnapshots("dx-snap");
  assert.equal(store.hasSnapshots("dx-snap", "h1"), false);
  assert.throws(() => store.restoreSnapshots({ appId: "dx-snap", historyId: "h1", fsAdapter: vfs }), /没有项目数据快照/);
});

test("结构化拒绝：缺 fsAdapter / 缺快照能力不半应用", () => {
  const { vfs, root } = makeRoot();
  const store = makeStore("refuse");
  const doc = { format: mig.MIGRATION_FORMAT, operations: [{ op: "write", path: "x.txt", content: "x" }] };
  let thrown = null;
  try { mig.applyDeclarativeProjectMigration({ rootId: root.id, ownerId: "u1", raw: doc, from: 1, to: 2, fsAdapter: null }); }
  catch (error) { thrown = error; }
  assert.equal(thrown && thrown.code, "DEVELOPER_FS_UNAVAILABLE");

  const noSnapshot = { ...vfs, snapshotSubtree: undefined, restoreSubtreeSnapshot: undefined };
  const unsupported = store.applyChain({ appId: "dx-x", historyId: "h", roots: [{ ownerId: "u1", rootId: root.id }], documents: [{ from: 1, to: 2, document: doc }], fsAdapter: noSnapshot });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error, "DEVELOPER_MIGRATION_SNAPSHOT_UNSUPPORTED");
  assert.equal(vfs.findByPath(root.id, "x.txt"), null, "快照能力缺失时必须先拒绝，不写半个");

  const noFs = store.applyChain({ appId: "dx-x", historyId: "h", roots: [{ ownerId: "u1", rootId: root.id }], documents: [{ from: 1, to: 2, document: doc }], fsAdapter: null });
  assert.equal(noFs.error, "DEVELOPER_FS_UNAVAILABLE");
});

test("命令面：developer/migrations/* 通过唯一切片分发", () => {
  const { vfs, root } = makeRoot();
  const store = makeStore("command");
  const extension = mig.createDeveloperMigrationExtension({ store, fsAdapter: vfs });
  assert.equal(extension.channel, "developer:command");
  const applied = extension.dispatch({ command: "developer/migrations/apply", payload: {
    rootId: root.id, ownerId: "u1", from: 1, to: 2,
    document: { format: mig.MIGRATION_FORMAT, operations: [{ op: "write", path: "cmd.txt", content: "C" }] },
  } });
  assert.equal(applied.ok, true);
  assert.equal(applied.applied, 1);
  const status = extension.dispatch({ command: "developer/migrations/snapshotStatus", payload: { appId: "dx-cmd", historyId: "none" } });
  assert.equal(status.available, false);
  assert.equal(extension.dispatch({ command: "developer/migrations/nope", payload: {} }).error, "DEVELOPER_COMMAND_NOT_ALLOWED");
  assert.equal(mig.createDeveloperMigrationExtension({}).dispatch({ command: "developer/migrations/snapshotStatus", payload: { appId: "a", historyId: "b" } }).error, "DEVELOPER_MIGRATION_UNAVAILABLE");
});
