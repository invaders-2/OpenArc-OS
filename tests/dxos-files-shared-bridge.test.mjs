/**
 * task-16 · DX 虚拟文件树共享盘 / 部门盘 / 快照 / 搜索 / 统计的受控桥
 *（platform:command 新命令；不新增 preload 顶层键）。
 *
 * 真实 dxos-fs（临时目录）+ 真实 platform-service；authorization 用假实现提供成员关系。
 * 断言：可见性（public / department）、快照往返、搜索/统计、绝对路径不出桥、依赖缺失结构化失败。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createDxosFs } = require("../electron/dxos-fs.cjs");
const { createPlatformBundle } = require("../electron/platform-service.cjs");

const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

const ACTORS = {
  admin: { userId: "u-admin", isSuper: true, departmentIds: ["dept-a"], adminDeptIds: ["dept-a"] },
  memberA: { userId: "u-member-a", isSuper: false, departmentIds: ["dept-a"], adminDeptIds: [] },
  outsider: { userId: "u-outside", isSuper: false, departmentIds: ["dept-b"], adminDeptIds: [] },
};

function authorization() {
  return {
    resolveActor: ({ context }) => {
      if (!context || !context.sessionRef) return { ok: false, error: "no-session" };
      const actor = ACTORS[context.sessionRef];
      if (!actor) return { ok: false, error: "unknown-session" };
      return { ok: true, user: { id: actor.userId, team_id: "org-1", role: actor.isSuper ? "ADMIN" : "MEMBER" }, ...actor };
    },
  };
}

function makeBundle({ withFs = true } = {}) {
  const dir = tempDir("oa-files-shared-");
  const fsStore = withFs ? createDxosFs({ dataDir: path.join(dir, "fs") }) : null;
  const bundle = createPlatformBundle({
    userDataDir: dir,
    authorization: authorization(),
    fsStore,
    clock: () => Date.now(),
  });
  return { dir, fsStore, bundle };
}

function call(bundle, session, command, payload = {}) {
  return bundle.execute(command, payload, { sessionRef: session, appId: "ai", requestId: "req-fs" });
}

test("shared/roots：public 对所有人可见；部门盘只对本部门成员/超管可见", async () => {
  const { bundle, fsStore } = makeBundle();
  const publicRoot = fsStore.ensurePublicRoot();
  const deptRoot = fsStore.ensureDepartmentRoot("dept-a", "设计");
  const deptB = fsStore.ensureDepartmentRoot("dept-b", "运营");

  const admin = await call(bundle, "admin", "platform/fs/shared/roots");
  assert.equal(admin.ok, true, JSON.stringify(admin));
  const adminIds = admin.value.roots.map((root) => root.id);
  assert.ok(adminIds.includes(publicRoot.id));
  assert.ok(adminIds.includes(deptRoot.id));
  assert.ok(adminIds.includes(deptB.id), "超管能看到所有部门盘");

  const memberA = await call(bundle, "memberA", "platform/fs/shared/roots");
  assert.equal(memberA.ok, true);
  const memberIds = memberA.value.roots.map((root) => root.id);
  assert.ok(memberIds.includes(publicRoot.id));
  assert.ok(memberIds.includes(deptRoot.id));
  assert.equal(memberIds.includes(deptB.id), false, "不能看到其他部门盘");

  const outsider = await call(bundle, "outsider", "platform/fs/shared/roots");
  const outsiderIds = outsider.value.roots.map((root) => root.id);
  assert.ok(outsiderIds.includes(publicRoot.id));
  assert.equal(outsiderIds.includes(deptRoot.id), false);
});
test("shared/list + search + stats：真实节点投影，不含 blob / 绝对路径", async () => {
  const { dir, bundle, fsStore } = makeBundle();
  const publicRoot = fsStore.ensurePublicRoot();
  const fileNode = fsStore.createNode({ name: "公告.txt", type: "file", parentId: publicRoot.id, mime: "text/plain", content: "共享盘里的公告正文" });
  fsStore.createNode({ name: "素材文件夹", type: "folder", parentId: publicRoot.id });

  const listed = await call(bundle, "memberA", "platform/fs/shared/list", { nodeId: publicRoot.id });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.value.node.share, "public");
  assert.equal(listed.value.children.length, 2);
  const fileView = listed.value.children.find((entry) => entry.id === fileNode.id);
  assert.equal(fileView.name, "公告.txt");
  assert.equal(fileView.type, "file");
  assert.equal(fileView.content, undefined, "不能把文件正文带过桥");
  assert.equal(JSON.stringify(listed.value).includes(dir), false, "不得暴露绝对路径");

  const searched = await call(bundle, "memberA", "platform/fs/search", { nodeId: publicRoot.id, query: "公告", limit: 10 });
  assert.equal(searched.ok, true, JSON.stringify(searched));
  assert.ok(searched.value.results.some((row) => row.id === fileNode.id));

  const stats = await call(bundle, "memberA", "platform/fs/stats", { nodeId: publicRoot.id });
  assert.equal(stats.ok, true, JSON.stringify(stats));
  assert.ok(stats.value.entries >= 2);
  assert.ok(stats.value.bytes >= 0);

  const foreign = await call(bundle, "outsider", "platform/fs/shared/list", { nodeId: fsStore.ensureDepartmentRoot("dept-a", "设计").id });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, "PLATFORM_FORBIDDEN");
});

test("快照：创建 → 修改 → 恢复往返；非 owner / 非管理员恢复被拒", async () => {
  const { bundle, fsStore } = makeBundle();
  const deptRoot = fsStore.ensureDepartmentRoot("dept-a", "设计");
  const page = fsStore.createNode({ name: "首页.txt", type: "file", parentId: deptRoot.id, mime: "text/plain", content: "v1" });

  const created = await call(bundle, "admin", "platform/fs/snapshot/create", { nodeId: deptRoot.id, reason: "测试" });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.match(created.value.snapshotId, /^snap_/);
  assert.ok(created.value.nodeCount >= 1);
  assert.equal(created.value.blobs, undefined, "快照 blob 不过桥");

  fsStore.removeNode(page.id);
  assert.equal(fsStore.getNode(page.id).trashed === true || !fsStore.listChildren(deptRoot.id).nodes.some((n) => n.id === page.id), true);

  const memberRestore = await call(bundle, "memberA", "platform/fs/snapshot/restore", { snapshotId: created.value.snapshotId });
  assert.equal(memberRestore.ok, false);
  assert.equal(memberRestore.error, "PLATFORM_NOT_FOUND", "快照属于创建者，其他用户不可见");

  const restored = await call(bundle, "admin", "platform/fs/snapshot/restore", { snapshotId: created.value.snapshotId });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.ok(fsStore.listChildren(deptRoot.id).nodes.some((node) => node.id === page.id), "恢复后节点回到目录");
  const again = await call(bundle, "admin", "platform/fs/snapshot/restore", { snapshotId: created.value.snapshotId });
  assert.equal(again.ok, false, "快照恢复后不可重复使用");
});

test("拒绝与不可用：非法 nodeId、文件节点当目录、未注入 fsStore 的依赖缺失", async () => {
  const { bundle, fsStore } = makeBundle();
  const publicRoot = fsStore.ensurePublicRoot();
  const file = fsStore.createNode({ name: "a.txt", type: "file", parentId: publicRoot.id, content: "x" });

  const bad = await call(bundle, "memberA", "platform/fs/shared/list", { nodeId: "no-such-node" });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "PLATFORM_NOT_FOUND");
  const notFolder = await call(bundle, "memberA", "platform/fs/search", { nodeId: file.id, query: "x" });
  assert.equal(notFolder.ok, false);
  assert.equal(notFolder.error, "PLATFORM_INVALID_INPUT");
  const badSnapshot = await call(bundle, "admin", "platform/fs/snapshot/restore", { snapshotId: "not-a-snapshot" });
  assert.equal(badSnapshot.ok, false);
  assert.equal(badSnapshot.error, "PLATFORM_INVALID_INPUT");

  const missing = makeBundle({ withFs: false });
  const unavailable = await call(missing.bundle, "admin", "platform/fs/shared/roots");
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error, "PLATFORM_DEPENDENCY_UNAVAILABLE");
  const health = await call(missing.bundle, "admin", "platform/health");
  assert.equal(health.value.filesShared.available, false);
});
