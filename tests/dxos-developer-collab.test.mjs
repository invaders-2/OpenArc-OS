/**
 * B7b · 开发者协同项目（源 developerCollabProjects.ts:1-235）。
 * 测的是产品真实代码 + 真实 IdentityStore / IntegrationStore：成员与角色必须落既有
 * projects / project_members，且**不得**出现第二套 ACL 表。全程离线。
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createFixture } from "./authorization-fixtures.mjs";

const require = createRequire(import.meta.url);
const { IntegrationStore } = require("../electron/integration-store.cjs");
const collabModule = require("../electron/developer-collab.cjs");

const fixture = await createFixture();
after(() => fixture.close());

const store = new IntegrationStore({ identity: fixture.identity });
const collab = new collabModule.DeveloperCollabProjects({ identity: fixture.identity, store, authService: fixture.svc });
const ctx = (key) => ({ ...fixture.ctx(key), appId: "developer" });
const db = fixture.identity.connection;

function membersRows(projectId) {
  return db.prepare("SELECT user_id, role FROM project_members WHERE project_id = ? ORDER BY user_id").all(projectId);
}

test("创建协同项目：落既有 projects 行，owner 即会话用户", () => {
  const created = collab.createProject({ context: ctx("alice"), name: "协同五子棋", kind: "game", document: { board: [] }, appId: "dx-gomoku" });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.project.access, "owner");
  assert.equal(created.project.version, 1);
  assert.equal(created.project.appId, "dx-gomoku");
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(created.project.id);
  assert.equal(row.owner_user_id, fixture.created.alice);
  assert.equal(row.status, "active");
  // 元数据承载在 description 的 dx-collab/v1 前置块里（不改表结构）。
  assert.ok(row.description.startsWith(collabModule.COLLAB_META_PREFIX));
});

test("可见性：owner / 成员 / public 三类可见，非成员不可见", () => {
  const created = collab.createProject({ context: ctx("alice"), name: "私密项目", appId: "dx-demo" });
  const pid = created.project.id;
  assert.equal(collab.listProjects({ context: ctx("alice"), appId: "dx-demo" }).items.length, 1);
  assert.equal(collab.listProjects({ context: ctx("bob"), appId: "dx-demo" }).items.length, 0);
  assert.equal(collab.getProject({ context: ctx("bob"), projectId: pid }).error, "NOT_FOUND_OR_FORBIDDEN");
  collab.setMembers({ context: ctx("alice"), projectId: pid, members: [{ userId: fixture.created.bob, access: "read" }] });
  const bobList = collab.listProjects({ context: ctx("bob"), appId: "dx-demo" });
  assert.equal(bobList.items.length, 1);
  assert.equal(collab.getProject({ context: ctx("bob"), projectId: pid }).project.access, "read");
});

test("版本乐观锁：baseVersion 落后返回 VERSION_CONFLICT，不写入", () => {
  const created = collab.createProject({ context: ctx("alice"), name: "版本项目", appId: "dx-version" });
  const pid = created.project.id;
  const updated = collab.updateProject({ context: ctx("alice"), projectId: pid, baseVersion: 1, document: { board: [1] } });
  assert.equal(updated.ok, true);
  assert.equal(updated.project.version, 2);
  assert.deepEqual(updated.project.document, { board: [1] });
  const stale = collab.updateProject({ context: ctx("alice"), projectId: pid, baseVersion: 1, document: { board: [2] } });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "VERSION_CONFLICT");
  assert.equal(stale.detail.currentVersion, 2);
  assert.deepEqual(collab.getProject({ context: ctx("alice"), projectId: pid }).project.document, { board: [1] });
});

test("成员与角色：edit -> editor / read -> viewer，落 project_members；owner-only 且整批原子", () => {
  const created = collab.createProject({ context: ctx("alice"), name: "成员项目", appId: "dx-members" });
  const pid = created.project.id;
  const set = collab.setMembers({ context: ctx("alice"), projectId: pid, members: [
    { userId: fixture.created.bob, access: "edit" },
    { userId: fixture.created.erin, access: "read" },
  ] });
  assert.equal(set.ok, true);
  assert.deepEqual(set.project.members.map((member) => member.access).sort(), ["edit", "read"]);
  // 直接读库断言：访问级别确实落成 project_members 的 viewer / editor。
  assert.deepEqual(Object.fromEntries(membersRows(pid).map((row) => [row.user_id, row.role])), {
    [fixture.created.bob]: "editor",
    [fixture.created.erin]: "viewer",
  });

  // 非 owner（bob=editor）不能改成员。
  const denied = collab.setMembers({ context: ctx("bob"), projectId: pid, members: [] });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "FORBIDDEN");
  assert.equal(denied.detail, "owner-only");
  assert.equal(membersRows(pid).length, 2, "被拒绝的请求不能改动成员表");

  // 跨组织目标（frank 属外部 team）整批拒绝，且不能半应用。
  const cross = collab.setMembers({ context: ctx("alice"), projectId: pid, members: [{ userId: fixture.created.frank, access: "edit" }] });
  assert.equal(cross.ok, false);
  assert.equal(cross.error, "INVALID_INPUT");
  assert.equal(membersRows(pid).length, 2, "非法成员必须整批拒绝，不半应用");
});

test("成员变更集：基线版本冲突不覆盖；remove 生效", () => {
  const created = collab.createProject({ context: ctx("alice"), name: "变更集项目", appId: "dx-changeset" });
  const pid = created.project.id;
  collab.setMembers({ context: ctx("alice"), projectId: pid, members: [
    { userId: fixture.created.bob, access: "edit" },
    { userId: fixture.created.erin, access: "read" },
  ] });
  const revision = collab.getProject({ context: ctx("alice"), projectId: pid }).project.revision;

  const applied = collab.applyMemberChangeset({ context: ctx("alice"), projectId: pid, baseRevision: revision, changes: [
    { userId: fixture.created.erin, remove: true },
    { userId: fixture.created.charlie, access: "edit" },
  ] });
  assert.equal(applied.ok, true);
  // 用 map 比较，避免依赖随机生成的 userId 字典序。
  assert.deepEqual(Object.fromEntries(applied.project.members.map((member) => [member.userId, member.access])), {
    [fixture.created.bob]: "edit",
    [fixture.created.charlie]: "edit",
  });
  assert.equal(rowsRole(pid, fixture.created.charlie), "editor");

  const stale = collab.applyMemberChangeset({ context: ctx("alice"), projectId: pid, baseRevision: revision, changes: [{ userId: fixture.created.erin, access: "edit" }] });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "MEMBER_SET_CONFLICT");
  assert.equal(rowsRole(pid, fixture.created.erin), null, "冲突变更不得写库");

  function rowsRole(projectId, userId) {
    const row = db.prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?").get(projectId, userId);
    return row ? row.role : null;
  }
});

test("共享设置：非 restricted 清空成员，public 项目对同组织可读", () => {
  const created = collab.createProject({ context: ctx("alice"), name: "共享项目", appId: "dx-share" });
  const pid = created.project.id;
  collab.setMembers({ context: ctx("alice"), projectId: pid, members: [{ userId: fixture.created.bob, access: "edit" }] });
  const shared = collab.setSharing({ context: ctx("alice"), projectId: pid, visibility: "public", publicAccess: "read" });
  assert.equal(shared.ok, true);
  assert.equal(shared.project.visibility, "public");
  assert.equal(shared.project.members.length, 0, "源语义：非 restricted 清空成员，访问改走 public");
  const charlie = collab.getProject({ context: ctx("charlie"), projectId: pid });
  assert.equal(charlie.ok, true);
  assert.equal(charlie.project.access, "read");
  const sharedEdit = collab.setSharing({ context: ctx("alice"), projectId: pid, visibility: "restricted", publicAccess: "edit", members: [{ userId: fixture.created.bob, access: "edit" }] });
  assert.equal(sharedEdit.project.visibility, "restricted");
  assert.equal(sharedEdit.project.members.length, 1);
  // restricted 下非成员回到不可见。
  assert.equal(collab.getProject({ context: ctx("charlie"), projectId: pid }).error, "NOT_FOUND_OR_FORBIDDEN");
});

test("邀请口令：创建 -> 撤销 -> 兑换落 project_members", () => {
  const created = collab.createProject({ context: ctx("alice"), name: "邀请项目", appId: "dx-invite" });
  const pid = created.project.id;
  const invite = collab.createInvite({ context: ctx("alice"), projectId: pid, access: "edit" });
  assert.equal(invite.ok, true);
  assert.match(invite.code, /^DXP-[0-9A-F]{10}$/);
  assert.equal(invite.invite.codeHint, invite.code.slice(-5));
  const redeemed = collab.redeemInvite({ context: ctx("bob"), projectId: pid, code: invite.code });
  assert.equal(redeemed.ok, true);
  assert.equal(rowsRole(pid, fixture.created.bob), "editor");
  assert.equal(collab.redeemInvite({ context: ctx("erin"), projectId: pid, code: "DXP-0000000000" }).error, "INVALID_INVITE");
  collab.revokeInvite({ context: ctx("alice"), projectId: pid });
  assert.equal(collab.redeemInvite({ context: ctx("erin"), projectId: pid, code: invite.code }).error, "INVALID_INVITE");

  function rowsRole(projectId, userId) {
    const row = db.prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?").get(projectId, userId);
    return row ? row.role : null;
  }
});

test("实时房间准入：roomAccess 给出 owner + 成员名单", () => {
  const created = collab.createProject({ context: ctx("alice"), name: "房间项目", appId: "dx-room" });
  collab.setMembers({ context: ctx("alice"), projectId: created.project.id, members: [{ userId: fixture.created.bob, access: "read" }] });
  const access = collab.roomAccess({ context: ctx("alice"), projectId: created.project.id });
  assert.equal(access.ok, true);
  assert.equal(access.access, "owner");
  assert.deepEqual([...access.allowedUserIds].sort(), [fixture.created.alice, fixture.created.bob].sort());
  assert.equal(collab.roomAccess({ context: ctx("charlie"), projectId: created.project.id }).error, "NOT_FOUND_OR_FORBIDDEN");
});

test("删除即归档：列表不再返回，projects 行仍可查", () => {
  const created = collab.createProject({ context: ctx("alice"), name: "待归档", appId: "dx-archive" });
  const deleted = collab.deleteProject({ context: ctx("alice"), projectId: created.project.id });
  assert.equal(deleted.ok, true);
  assert.equal(db.prepare("SELECT status FROM projects WHERE id = ?").get(created.project.id).status, "archived");
  assert.equal(collab.listProjects({ context: ctx("alice"), appId: "dx-archive" }).items.length, 0);
  assert.equal(collab.getProject({ context: ctx("alice"), projectId: created.project.id }).error, "NOT_FOUND_OR_FORBIDDEN");
});

test("不建第二套 ACL：数据库里不存在 developer_collab_* 表", () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'developer_collab%'").all();
  assert.deepEqual(tables, []);
  const aclTables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('projects','project_members')").all().map((row) => row.name).sort();
  assert.deepEqual(aclTables, ["project_members", "projects"]);
});

test("命令面：developer/collab/* 通过唯一 developer:command 分发", () => {
  const extension = collabModule.createDeveloperCollabExtension({ collab });
  assert.equal(extension.channel, "developer:command");
  const listed = extension.dispatch({ command: "developer/collab/list", payload: { appId: "dx-gomoku" }, context: ctx("alice") });
  assert.equal(listed.ok, true);
  const created = extension.dispatch({ command: "developer/collab/create", payload: { name: "命令创建", appId: "dx-cmd" }, context: ctx("alice") });
  assert.equal(created.ok, true);
  assert.equal(created.project.appId, "dx-cmd");
  const denied = extension.dispatch({ command: "developer/collab/nope", payload: {}, context: ctx("alice") });
  assert.equal(denied.error, "DEVELOPER_COMMAND_NOT_ALLOWED");
  const unavailable = collabModule.createDeveloperCollabExtension({}).dispatch({ command: "developer/collab/list", payload: {}, context: ctx("alice") });
  assert.equal(unavailable.error, "DEVELOPER_COLLAB_UNAVAILABLE");
});
