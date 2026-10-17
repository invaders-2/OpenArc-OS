/**
 * 画布共享 · 后端核心（P1）：三档角色 / 判定顺序 / 目标校验 / 命令 / 审计 / 迁移。
 *
 * 被测的是产品真实代码：canvas-domain / canvas-store / canvas-service / canvas-bootstrap /
 * identity-store(v29) / authorization-store(strict)。数据一律在 :memory: 或临时目录，
 * 不碰真实 identity.db。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createResourceFixture, pw } from "./resource-fixtures.mjs";
import { CanvasStore } from "../electron/canvas-store.cjs";
import { CanvasService } from "../electron/canvas-service.cjs";
import { IdentityStore } from "../electron/identity-store.cjs";

const require = createRequire(import.meta.url);
const canvasBootstrap = require("../electron/canvas-bootstrap.cjs");
const domain = require("../electron/canvas-domain.cjs");

async function fixture() {
  const fx = await createResourceFixture();
  const store = new CanvasStore({ identity: fx.identity, clock: fx.clock });
  const service = new CanvasService({
    identity: fx.identity, store, resourceStore: fx.resourceStore, authService: fx.authService,
    authStore: fx.store, clock: fx.clock,
  });
  const ctx = (key, extra = {}) => ({ sessionRef: fx.sessions[key], appId: "canvas", source: "ui", ...extra });
  // 额外同组织账号：eve（ACTIVE）用于候选人/共享目标；frank（DISABLED）用于停用校验。
  for (const key of ["eve", "frank"]) {
    const created = await fx.identity.createUser({ identifier: key + "@openarc.test", password: pw(key), displayName: key, teamId: fx.orgId });
    const login = await fx.identity.login({ identifier: key + "@openarc.test", password: pw(key) });
    fx.users[key] = created.userId;
    fx.sessions[key] = login.session.ref;
  }
  const disabled = fx.identity.setUserStatus(fx.users.frank, "DISABLED");
  assert.equal(disabled.ok, true, JSON.stringify(disabled));
  return { fx, store, service, ctx };
}

async function canvasOwnedBy(f, key = "alice", title = "共享画布") {
  const created = f.service.createCanvas({ context: f.ctx(key), title });
  assert.equal(created.ok, true, JSON.stringify(created));
  return created.canvas.canvasId;
}

const canvasAudit = (fx) => fx.store.authorizationAudit().filter((row) => String(row.action || "").startsWith("canvas."));
const emptyDoc = () => ({ nodes: [], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] });

function expectError(result, error, detail) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error, error, JSON.stringify(result));
  if (detail !== undefined) assert.equal(result.detail, detail, JSON.stringify(result));
}

test("角色矩阵：VIEWER / EDITOR / MANAGER × view·edit·save·share·visibility·remove·transfer·delete", async () => {
  const f = await fixture();
  try {
    const cases = [
      { role: "VIEWER", canEdit: false, canManage: false },
      { role: "EDITOR", canEdit: true, canManage: false },
      { role: "MANAGER", canEdit: true, canManage: true },
    ];
    for (const c of cases) {
      const canvasId = await canvasOwnedBy(f, "alice", "矩阵 " + c.role);
      assert.equal(f.service.shareCanvas({ context: f.ctx("alice"), canvasId, userId: f.fx.users.dana, role: c.role }).ok, true);

      const access = f.service.accessGet({ context: f.ctx("dana"), canvasId });
      assert.equal(access.ok, true, JSON.stringify(access));
      assert.equal(access.access.allow, true);
      assert.equal(access.access.source, "SHARE_" + c.role);
      assert.equal(access.capabilities.canView, true);
      assert.equal(access.capabilities.canEdit, c.canEdit);
      assert.equal(access.capabilities.canManage, c.canManage);
      assert.equal(access.capabilities.canShare, c.canManage);
      assert.equal(access.capabilities.canTrash, false);
      assert.equal(access.capabilities.canPurge, false);

      // 读
      assert.equal(f.service.getCanvas({ context: f.ctx("dana"), canvasId }).ok, true);

      // 编辑 + 保存（各自用当时的 revision，避免把版本检查混进权限断言）
      const view = f.service.getCanvas({ context: f.ctx("dana"), canvasId });
      const cmd = f.service.applyCommand({
        context: f.ctx("dana"), canvasId, baseRevision: view.canvas.revision,
        command: { type: "node.add", node: { id: "n_" + c.role, type: "prompt", x: 0, y: 0 } },
      });
      if (c.canEdit) {
        assert.equal(cmd.ok, true, JSON.stringify(cmd));
        const afterCmd = f.service.getCanvas({ context: f.ctx("dana"), canvasId });
        const save = f.service.saveCanvas({ context: f.ctx("dana"), canvasId, baseRevision: afterCmd.canvas.revision, doc: afterCmd.canvas.doc });
        assert.equal(save.ok, true, JSON.stringify(save));
      } else {
        expectError(cmd, "READ_ONLY");
        expectError(f.service.saveCanvas({ context: f.ctx("dana"), canvasId, baseRevision: view.canvas.revision, doc: view.canvas.doc }), "READ_ONLY");
      }

      // 改共享 / 改可见性 / 移除
      const shareAttempt = f.service.shareCanvas({ context: f.ctx("dana"), canvasId, userId: f.fx.users.eve, role: "VIEWER" });
      const visibilityAttempt = f.service.setVisibility({ context: f.ctx("dana"), canvasId, visibility: "ORGANIZATION" });
      const removeAttempt = f.service.removeShare({ context: f.ctx("dana"), canvasId, userId: f.fx.users.eve });
      if (c.canManage) {
        assert.equal(shareAttempt.ok, true, JSON.stringify(shareAttempt));
        assert.equal(visibilityAttempt.ok, true, JSON.stringify(visibilityAttempt));
        assert.equal(removeAttempt.ok, true, JSON.stringify(removeAttempt));
        assert.equal(removeAttempt.removed, true);
      } else {
        expectError(shareAttempt, "READ_ONLY");
        expectError(visibilityAttempt, "READ_ONLY");
        expectError(removeAttempt, "READ_ONLY");
      }

      // 转移 / 删除：MANAGER 也不行
      expectError(f.service.transferOwner({ context: f.ctx("dana"), canvasId, newOwnerUserId: f.fx.users.eve }), "READ_ONLY");
      expectError(f.service.trashCanvas({ context: f.ctx("dana"), canvasId }), "READ_ONLY");
    }

    // 所有者（alice 是 MEMBER，不是超管）：全部允许
    const owned = await canvasOwnedBy(f, "alice", "所有者矩阵");
    assert.equal(f.service.shareCanvas({ context: f.ctx("alice"), canvasId: owned, userId: f.fx.users.dana, role: "VIEWER" }).ok, true);
    assert.equal(f.service.setVisibility({ context: f.ctx("alice"), canvasId: owned, visibility: "ORGANIZATION" }).ok, true);
    assert.equal(f.service.removeShare({ context: f.ctx("alice"), canvasId: owned, userId: f.fx.users.dana }).removed, true);
    assert.equal(f.service.transferOwner({ context: f.ctx("alice"), canvasId: owned, newOwnerUserId: f.fx.users.eve }).ok, true);
    // 转移后 alice 是 EDITOR：不能删、不能再转移
    expectError(f.service.trashCanvas({ context: f.ctx("alice"), canvasId: owned }), "READ_ONLY");
    expectError(f.service.transferOwner({ context: f.ctx("alice"), canvasId: owned, newOwnerUserId: f.fx.users.dana }), "READ_ONLY");

    // 超管：可管理别人的画布
    const supers = await canvasOwnedBy(f, "alice", "超管矩阵");
    assert.equal(f.service.shareCanvas({ context: f.ctx("admin"), canvasId: supers, userId: f.fx.users.dana, role: "MANAGER" }).ok, true);
    assert.equal(f.service.setVisibility({ context: f.ctx("admin"), canvasId: supers, visibility: "ORGANIZATION" }).ok, true);
    assert.equal(f.service.transferOwner({ context: f.ctx("admin"), canvasId: supers, newOwnerUserId: f.fx.users.eve }).ok, true);
    assert.equal(f.service.trashCanvas({ context: f.ctx("admin"), canvasId: supers }).ok, true);

    // 组织可见（未共享）：只读底线
    const org = await canvasOwnedBy(f, "alice", "组织可见");
    assert.equal(f.service.setVisibility({ context: f.ctx("alice"), canvasId: org, visibility: "ORGANIZATION" }).ok, true);
    const orgAccess = f.service.accessGet({ context: f.ctx("eve"), canvasId: org });
    assert.equal(orgAccess.ok, true);
    assert.equal(orgAccess.access.source, "ORG_POLICY");
    assert.equal(orgAccess.capabilities.canEdit, false);
    expectError(f.service.saveCanvas({ context: f.ctx("eve"), canvasId: org, baseRevision: 1, doc: emptyDoc() }), "READ_ONLY");
    expectError(f.service.shareCanvas({ context: f.ctx("eve"), canvasId: org, userId: f.fx.users.dana, role: "VIEWER" }), "READ_ONLY");
    expectError(f.service.setVisibility({ context: f.ctx("eve"), canvasId: org, visibility: "PRIVATE" }), "READ_ONLY");
    expectError(f.service.transferOwner({ context: f.ctx("eve"), canvasId: org, newOwnerUserId: f.fx.users.dana }), "READ_ONLY");
    expectError(f.service.trashCanvas({ context: f.ctx("eve"), canvasId: org }), "READ_ONLY");

    // 外组织：什么都看不到
    expectError(f.service.getCanvas({ context: f.ctx("bob"), canvasId: org }), "NOT_FOUND_OR_FORBIDDEN");
    expectError(f.service.accessGet({ context: f.ctx("bob"), canvasId: org }), "NOT_FOUND_OR_FORBIDDEN");
    assert.equal(f.service.listCanvases({ context: f.ctx("bob") }).items.some((item) => item.canvasId === org), false);
  } finally { f.fx.close(); }
});

test("判定顺序：显式 share 先于 ORGANIZATION，不被组织可见降级；角色优先级 VIEWER<EDITOR<MANAGER<OWNER", async () => {
  const f = await fixture();
  try {
    const canvasId = await canvasOwnedBy(f, "alice", "优先级");
    assert.equal(f.service.setVisibility({ context: f.ctx("alice"), canvasId, visibility: "ORGANIZATION" }).ok, true);
    assert.equal(f.service.shareCanvas({ context: f.ctx("alice"), canvasId, userId: f.fx.users.dana, role: "EDITOR" }).ok, true);
    const editor = f.service.accessGet({ context: f.ctx("dana"), canvasId });
    assert.equal(editor.access.source, "SHARE_EDITOR", "组织可见不能把显式 EDITOR 降级");
    assert.equal(editor.capabilities.canEdit, true);
    assert.equal(f.service.saveCanvas({ context: f.ctx("dana"), canvasId, baseRevision: 1, doc: emptyDoc() }).ok, true);

    assert.equal(f.service.updateShareRole({ context: f.ctx("alice"), canvasId, userId: f.fx.users.dana, role: "VIEWER" }).ok, true);
    const viewer = f.service.accessGet({ context: f.ctx("dana"), canvasId });
    assert.equal(viewer.access.source, "SHARE_VIEWER");
    assert.equal(viewer.capabilities.canEdit, false);

    assert.equal(f.service.updateShareRole({ context: f.ctx("alice"), canvasId, userId: f.fx.users.dana, role: "MANAGER" }).ok, true);
    const manager = f.service.accessGet({ context: f.ctx("dana"), canvasId });
    assert.equal(manager.access.source, "SHARE_MANAGER");
    assert.equal(manager.capabilities.canManage, true);

    const orgOnly = f.service.accessGet({ context: f.ctx("eve"), canvasId });
    assert.equal(orgOnly.access.source, "ORG_POLICY");
    assert.equal(orgOnly.capabilities.canEdit, false);

    assert.deepEqual(domain.ROLE_RANK, { VIEWER: 1, EDITOR: 2, MANAGER: 3, OWNER: 4 });
    assert.equal(domain.normalizeShareRole("CONTRIBUTOR"), "EDITOR");
    assert.equal(domain.normalizeShareRole("owner"), null);

    // 历史脏行（外组织 share）不得成为读取后门
    f.store.upsertShare({ canvasId, userId: f.fx.users.bob, role: "EDITOR", grantedBy: f.fx.users.alice });
    expectError(f.service.getCanvas({ context: f.ctx("bob"), canvasId }), "NOT_FOUND_OR_FORBIDDEN");
  } finally { f.fx.close(); }
});

test("共享目标校验：不存在 / 外组织 / 停用 / owner 自己 / 空 / 非法角色一律结构化拒绝并记 DENY", async () => {
  const f = await fixture();
  try {
    const canvasId = await canvasOwnedBy(f, "alice", "目标校验");
    const owner = f.ctx("alice", { requestId: "req-target" });
    expectError(f.service.shareCanvas({ context: owner, canvasId, userId: "", role: "VIEWER" }), "INVALID_INPUT", "target");
    expectError(f.service.shareCanvas({ context: owner, canvasId, userId: "usr_does_not_exist", role: "VIEWER" }), "INVALID_INPUT", "target");
    expectError(f.service.shareCanvas({ context: owner, canvasId, userId: f.fx.users.bob, role: "VIEWER" }), "INVALID_INPUT", "target-org");
    expectError(f.service.shareCanvas({ context: owner, canvasId, userId: f.fx.users.frank, role: "VIEWER" }), "INVALID_INPUT", "target-disabled");
    expectError(f.service.shareCanvas({ context: owner, canvasId, userId: f.fx.users.alice, role: "VIEWER" }), "INVALID_INPUT", "owner");
    for (const role of ["OWNER", "ADMIN", "", "EDITORX"]) {
      expectError(f.service.shareCanvas({ context: owner, canvasId, userId: f.fx.users.eve, role }), "INVALID_INPUT", "role");
    }
    // 失败尝试没有落共享行；外组织用户仍打不开
    assert.equal(f.store.sharesOf(canvasId).length, 0);
    expectError(f.service.getCanvas({ context: f.ctx("bob"), canvasId }), "NOT_FOUND_OR_FORBIDDEN");

    const denies = canvasAudit(f.fx).filter((row) => row.decision === "DENY" && row.action === "canvas.share.grant");
    assert.ok(denies.length >= 6, "拒绝的写尝试必须记 DENY，实际 " + denies.length);
    assert.ok(denies.every((row) => row.app_id === "canvas" && row.resource_ref === "canvas:" + canvasId));

    // 更新角色同样校验目标
    assert.equal(f.service.shareCanvas({ context: owner, canvasId, userId: f.fx.users.dana, role: "VIEWER" }).ok, true);
    expectError(f.service.updateShareRole({ context: owner, canvasId, userId: f.fx.users.bob, role: "EDITOR" }), "INVALID_INPUT", "target-org");
    expectError(f.service.updateShareRole({ context: owner, canvasId, userId: f.fx.users.eve, role: "EDITOR" }), "NOT_FOUND", "share");
    expectError(f.service.removeShare({ context: owner, canvasId, userId: f.fx.users.alice }), "INVALID_INPUT", "owner");
  } finally { f.fx.close(); }
});

test("撤销/降级立即生效：降级后保存 READ_ONLY，移除后保存与打开都被拒", async () => {
  const f = await fixture();
  try {
    const canvasId = await canvasOwnedBy(f, "alice", "撤销即时生效");
    assert.equal(f.service.shareCanvas({ context: f.ctx("alice"), canvasId, userId: f.fx.users.dana, role: "EDITOR" }).ok, true);
    const first = f.service.saveCanvas({ context: f.ctx("dana"), canvasId, baseRevision: 1, doc: emptyDoc() });
    assert.equal(first.ok, true, JSON.stringify(first));

    assert.equal(f.service.updateShareRole({ context: f.ctx("alice"), canvasId, userId: f.fx.users.dana, role: "VIEWER" }).ok, true);
    expectError(f.service.saveCanvas({ context: f.ctx("dana"), canvasId, baseRevision: first.canvas.revision, doc: emptyDoc() }), "READ_ONLY", "SHARE_VIEWER");
    const meta = f.service.metaCanvas({ context: f.ctx("dana"), canvasId });
    assert.equal(meta.ok, true);
    assert.equal(meta.meta.access.canEdit, false);

    const removed = f.service.removeShare({ context: f.ctx("alice"), canvasId, userId: f.fx.users.dana });
    assert.equal(removed.ok, true);
    assert.equal(removed.removed, true);
    expectError(f.service.saveCanvas({ context: f.ctx("dana"), canvasId, baseRevision: 1, doc: emptyDoc() }), "NOT_FOUND_OR_FORBIDDEN");
    expectError(f.service.getCanvas({ context: f.ctx("dana"), canvasId }), "NOT_FOUND_OR_FORBIDDEN");
    assert.equal(f.service.listCanvases({ context: f.ctx("dana") }).items.some((item) => item.canvasId === canvasId), false);
    // 幂等移除：不重复写审计
    const before = canvasAudit(f.fx).length;
    const again = f.service.removeShare({ context: f.ctx("alice"), canvasId, userId: f.fx.users.dana });
    assert.deepEqual([again.ok, again.removed], [true, false]);
    assert.equal(canvasAudit(f.fx).length, before);
  } finally { f.fx.close(); }
});

test("审计：grant/update/revoke/visibility 字段完整，写共享与审计同事务（strict 失败回滚）", async () => {
  const f = await fixture();
  try {
    const canvasId = await canvasOwnedBy(f, "alice", "审计画布");
    const owner = f.ctx("alice", { requestId: "req-audit-1" });
    assert.equal(f.service.shareCanvas({ context: owner, canvasId, userId: f.fx.users.dana, role: "VIEWER" }).ok, true);
    const grant = canvasAudit(f.fx).find((row) => row.action === "canvas.share.grant");
    assert.ok(grant, "必须写 grant 审计");
    assert.equal(grant.actor_user_id, f.fx.users.alice);
    assert.equal(grant.target_user_id, f.fx.users.dana);
    assert.equal(grant.app_id, "canvas");
    assert.equal(grant.resource_ref, "canvas:" + canvasId);
    assert.equal(grant.decision, "ALLOW");
    assert.equal(grant.reason_code, "OK");
    assert.equal(grant.permission_source, "OWNER_POLICY");
    assert.equal(grant.request_id, "req-audit-1");
    assert.equal(grant.old_permissions, "[]");
    assert.equal(grant.new_permissions, '["VIEWER"]');

    assert.equal(f.service.updateShareRole({ context: owner, canvasId, userId: f.fx.users.dana, role: "EDITOR" }).ok, true);
    const update = canvasAudit(f.fx).find((row) => row.action === "canvas.share.update");
    assert.equal(update.old_permissions, '["VIEWER"]');
    assert.equal(update.new_permissions, '["EDITOR"]');

    assert.equal(f.service.setVisibility({ context: owner, canvasId, visibility: "ORGANIZATION" }).ok, true);
    const vis = canvasAudit(f.fx).find((row) => row.action === "canvas.visibility.set");
    assert.equal(vis.old_permissions, '["PRIVATE"]');
    assert.equal(vis.new_permissions, '["ORGANIZATION"]');

    assert.equal(f.service.removeShare({ context: owner, canvasId, userId: f.fx.users.dana }).ok, true);
    const revoke = canvasAudit(f.fx).find((row) => row.action === "canvas.share.revoke");
    assert.equal(revoke.old_permissions, '["EDITOR"]');
    assert.equal(revoke.new_permissions, "[]");

    // strict：审计失败 → 整笔回滚
    const badAuth = { auditAuthorization({ strict }) { if (strict) throw new Error("audit-down"); } };
    const broken = new CanvasService({
      identity: f.fx.identity, store: f.store, resourceStore: f.fx.resourceStore,
      authService: f.fx.authService, authStore: badAuth, clock: f.fx.clock,
    });
    const canvas2 = await canvasOwnedBy(f, "alice", "审计事务");
    expectError(broken.shareCanvas({ context: f.ctx("alice"), canvasId: canvas2, userId: f.fx.users.eve, role: "VIEWER" }), "INTERNAL_ERROR", "audit");
    assert.equal(f.store.shareOf({ canvasId: canvas2, userId: f.fx.users.eve }), null, "审计失败必须回滚共享写入");
    expectError(broken.setVisibility({ context: f.ctx("alice"), canvasId: canvas2, visibility: "ORGANIZATION" }), "INTERNAL_ERROR", "audit");
    assert.equal(f.store.boardById(canvas2).visibility, "PRIVATE", "审计失败必须回滚可见性写入");
  } finally { f.fx.close(); }
});

test("成员列表：只有 canManage 能拿到成员 ID；其他人只看到成员数 + 自己的角色", async () => {
  const f = await fixture();
  try {
    const canvasId = await canvasOwnedBy(f, "alice", "列表可见性");
    assert.equal(f.service.shareCanvas({ context: f.ctx("alice"), canvasId, userId: f.fx.users.eve, role: "VIEWER" }).ok, true);
    assert.equal(f.service.shareCanvas({ context: f.ctx("alice"), canvasId, userId: f.fx.users.dana, role: "EDITOR" }).ok, true);

    const ownerView = f.service.listShares({ context: f.ctx("alice"), canvasId });
    assert.equal(ownerView.ok, true);
    assert.equal(ownerView.canManage, true);
    assert.equal(ownerView.owner.userId, f.fx.users.alice);
    assert.equal(ownerView.visibility, "PRIVATE");
    assert.deepEqual(ownerView.shares.map((s) => s.userId).sort(), [f.fx.users.dana, f.fx.users.eve].sort());
    assert.ok(ownerView.shares.every((s) => s.displayName && s.username && s.status === "ACTIVE"));

    // MANAGER 也能看
    assert.equal(f.service.updateShareRole({ context: f.ctx("alice"), canvasId, userId: f.fx.users.dana, role: "MANAGER" }).ok, true);
    const managerView = f.service.listShares({ context: f.ctx("dana"), canvasId });
    assert.equal(managerView.canManage, true);
    assert.equal(managerView.shares.length, 2);

    // VIEWER 只能看到人数 + 自己，且响应里没有其他成员 ID
    const viewerView = f.service.listShares({ context: f.ctx("eve"), canvasId });
    assert.equal(viewerView.ok, true);
    assert.equal(viewerView.canManage, false);
    assert.equal(viewerView.shares, null);
    assert.equal(viewerView.shareCount, 2);
    assert.equal(viewerView.myRole, "VIEWER");
    const serialized = JSON.stringify(viewerView);
    assert.equal(serialized.includes(f.fx.users.dana), false, "无管理权不得看到其他成员 ID");
    assert.equal(serialized.includes(f.fx.users.eve), false, "只给角色，不给成员 ID");

    // 编辑者同样只能看到人数
    assert.equal(f.service.updateShareRole({ context: f.ctx("alice"), canvasId, userId: f.fx.users.dana, role: "EDITOR" }).ok, true);
    const editorView = f.service.listShares({ context: f.ctx("dana"), canvasId });
    assert.equal(editorView.canManage, false);
    assert.equal(editorView.shares, null);
    assert.equal(editorView.myRole, "EDITOR");

    expectError(f.service.listShares({ context: f.ctx("bob"), canvasId }), "NOT_FOUND_OR_FORBIDDEN");
  } finally { f.fx.close(); }
});

test("候选人：同组织 ACTIVE、排除 owner 与已共享；只有 canManage 可调用", async () => {
  const f = await fixture();
  try {
    const canvasId = await canvasOwnedBy(f, "alice", "候选人");
    assert.equal(f.service.shareCanvas({ context: f.ctx("alice"), canvasId, userId: f.fx.users.dana, role: "VIEWER" }).ok, true);
    const list = f.service.shareCandidates({ context: f.ctx("alice"), canvasId });
    assert.equal(list.ok, true, JSON.stringify(list));
    const ids = list.items.map((item) => item.userId);
    assert.equal(ids.includes(f.fx.users.alice), false, "排除 owner");
    assert.equal(ids.includes(f.fx.users.dana), false, "排除已共享");
    assert.equal(ids.includes(f.fx.users.frank), false, "排除停用账号");
    assert.equal(ids.includes(f.fx.users.bob), false, "排除外组织");
    assert.equal(ids.includes(f.fx.users.eve), true);
    assert.ok(list.items.every((item) => item.status === "ACTIVE" && item.displayName && item.username));

    const searched = f.service.shareCandidates({ context: f.ctx("alice"), canvasId, query: "EVE" });
    assert.deepEqual(searched.items.map((item) => item.userId), [f.fx.users.eve]);

    assert.equal(f.service.shareCandidates({ context: f.ctx("dana"), canvasId }).ok, false, "非管理者不能看候选人");
    assert.equal(f.service.shareCandidates({ context: f.ctx("dana"), canvasId }).error, "READ_ONLY");
    expectError(f.service.shareCandidates({ context: f.ctx("bob"), canvasId }), "NOT_FOUND_OR_FORBIDDEN");
  } finally { f.fx.close(); }
});

test("访问查询：canView 可调，返回 access{allow,actions,source} + capabilities，不给成员列表", async () => {
  const f = await fixture();
  try {
    const canvasId = await canvasOwnedBy(f, "alice", "访问查询");
    assert.equal(f.service.shareCanvas({ context: f.ctx("alice"), canvasId, userId: f.fx.users.dana, role: "EDITOR" }).ok, true);
    const res = f.service.accessGet({ context: f.ctx("dana"), canvasId, requestId: "x" });
    assert.equal(res.ok, true);
    assert.equal(res.visibility, "PRIVATE");
    assert.equal(res.owner.userId, f.fx.users.alice);
    assert.deepEqual(res.share, { role: "EDITOR" });
    assert.equal(res.access.allow, true);
    assert.equal(res.access.source, "SHARE_EDITOR");
    assert.ok(Array.isArray(res.access.actions) && res.access.actions.includes("resource.edit"));
    assert.equal(res.capabilities.canEdit, true);
    assert.equal(res.capabilities.canManage, false);
    assert.equal(Object.prototype.hasOwnProperty.call(res, "shares"), false);
    assert.equal(JSON.stringify(res).includes(f.fx.users.eve), false);
  } finally { f.fx.close(); }
});

test("可见性：非法值拒绝、不改 updated_at/revision、写审计；非法值不再静默变 PRIVATE", async () => {
  const f = await fixture();
  try {
    const canvasId = await canvasOwnedBy(f, "alice", "可见性");
    const before = f.store.boardById(canvasId);
    for (const value of ["WHATEVER", "", null, "public", "ORGANIZATION_EDIT"]) {
      expectError(f.service.setVisibility({ context: f.ctx("alice"), canvasId, visibility: value }), "INVALID_INPUT", "visibility");
    }
    const unchanged = f.store.boardById(canvasId);
    assert.equal(unchanged.visibility, "PRIVATE");
    assert.equal(unchanged.updated_at, before.updated_at);
    assert.equal(unchanged.revision, before.revision);

    const changed = f.service.setVisibility({ context: f.ctx("alice"), canvasId, visibility: "organization" });
    assert.equal(changed.ok, true);
    const after = f.store.boardById(canvasId);
    assert.equal(after.visibility, "ORGANIZATION");
    assert.equal(after.updated_at, before.updated_at, "可见性不能改 updated_at");
    assert.equal(after.revision, before.revision);
    assert.equal(changed.changed, true);
    // 同值不重复写审计
    const count = canvasAudit(f.fx).filter((row) => row.action === "canvas.visibility.set").length;
    assert.equal(f.service.setVisibility({ context: f.ctx("alice"), canvasId, visibility: "ORGANIZATION" }).changed, false);
    assert.equal(canvasAudit(f.fx).filter((row) => row.action === "canvas.visibility.set").length, count);
  } finally { f.fx.close(); }
});

test("所有权转移：单事务改 owner、删目标 share、旧 owner 降 EDITOR、审计两行、不动 updated_at", async () => {
  const f = await fixture();
  try {
    const canvasId = await canvasOwnedBy(f, "alice", "转移");
    assert.equal(f.service.shareCanvas({ context: f.ctx("alice"), canvasId, userId: f.fx.users.dana, role: "VIEWER" }).ok, true);
    const before = f.store.boardById(canvasId);
    const res = f.service.transferOwner({ context: f.ctx("alice"), canvasId, newOwnerUserId: f.fx.users.dana });
    assert.equal(res.ok, true, JSON.stringify(res));
    const after = f.store.boardById(canvasId);
    assert.equal(after.owner_user_id, f.fx.users.dana);
    assert.equal(after.updated_at, before.updated_at, "转移不能改 updated_at");
    assert.equal(after.revision, before.revision);
    assert.equal(f.store.shareOf({ canvasId, userId: f.fx.users.dana }), null, "新 owner 不需要 share 行");
    assert.equal(domain.normalizeShareRole(f.store.shareOf({ canvasId, userId: f.fx.users.alice }).role), "EDITOR");

    const transferred = f.service.accessGet({ context: f.ctx("alice"), canvasId });
    assert.equal(transferred.access.source, "SHARE_EDITOR");
    assert.equal(transferred.capabilities.canManage, false);
    assert.equal(f.service.saveCanvas({ context: f.ctx("alice"), canvasId, baseRevision: after.revision, doc: emptyDoc() }).ok, true, "旧 owner 仍是编辑者");
    expectError(f.service.shareCanvas({ context: f.ctx("alice"), canvasId, userId: f.fx.users.eve, role: "VIEWER" }), "READ_ONLY");
    assert.equal(f.service.setVisibility({ context: f.ctx("dana"), canvasId, visibility: "ORGANIZATION" }).ok, true);

    const rows = canvasAudit(f.fx).filter((row) => String(row.action).startsWith("canvas.owner."));
    assert.deepEqual(rows.map((row) => row.action).sort(), ["canvas.owner.grant", "canvas.owner.revoke"]);
    const revoke = rows.find((row) => row.action === "canvas.owner.revoke");
    const grant = rows.find((row) => row.action === "canvas.owner.grant");
    assert.deepEqual([revoke.target_user_id, revoke.old_permissions, revoke.new_permissions], [f.fx.users.alice, '["OWNER"]', '["EDITOR"]']);
    assert.deepEqual([grant.target_user_id, grant.old_permissions, grant.new_permissions], [f.fx.users.dana, '["VIEWER"]', '["OWNER"]']);

    // 非法目标
    const canvas2 = await canvasOwnedBy(f, "alice", "转移校验");
    expectError(f.service.transferOwner({ context: f.ctx("alice"), canvasId: canvas2, newOwnerUserId: f.fx.users.bob }), "INVALID_INPUT", "target-org");
    expectError(f.service.transferOwner({ context: f.ctx("alice"), canvasId: canvas2, newOwnerUserId: f.fx.users.frank }), "INVALID_INPUT", "target-disabled");
    expectError(f.service.transferOwner({ context: f.ctx("alice"), canvasId: canvas2, newOwnerUserId: "usr_missing" }), "INVALID_INPUT", "target");
    expectError(f.service.transferOwner({ context: f.ctx("alice"), canvasId: canvas2, newOwnerUserId: f.fx.users.alice }), "INVALID_INPUT", "owner");
    assert.equal(f.store.boardById(canvas2).owner_user_id, f.fx.users.alice);
  } finally { f.fx.close(); }
});

test("永久删除：同事务清共享/命令；直接删 board 由 FK 级联清共享（遗留服务最小防护）", async () => {
  const f = await fixture();
  try {
    const canvasId = await canvasOwnedBy(f, "alice", "清理");
    assert.equal(f.service.shareCanvas({ context: f.ctx("alice"), canvasId, userId: f.fx.users.dana, role: "EDITOR" }).ok, true);
    assert.equal(f.service.applyCommand({ context: f.ctx("alice"), canvasId, baseRevision: 1, command: { type: "node.add", node: { id: "n1", type: "prompt", x: 0, y: 0 } } }).ok, true);
    assert.ok(f.store.sharesOf(canvasId).length > 0);
    assert.equal(f.service.purgeCanvas({ context: f.ctx("alice"), canvasId }).ok, true);
    assert.equal(f.store.sharesOf(canvasId).length, 0);
    assert.equal(f.store.recentCommands(canvasId, 10).length, 0);
    assert.equal(f.store.boardById(canvasId), null);

    // integration-store.deleteBoard 这类"直接删 board"的路径：v29 的 FK 级联保证不留孤儿
    const canvas2 = await canvasOwnedBy(f, "alice", "级联");
    assert.equal(f.service.shareCanvas({ context: f.ctx("alice"), canvasId: canvas2, userId: f.fx.users.dana, role: "VIEWER" }).ok, true);
    f.fx.identity.connection.prepare("DELETE FROM canvas_boards WHERE id = ?").run(canvas2);
    assert.equal(f.fx.identity.connection.prepare("SELECT COUNT(*) AS c FROM canvas_shares WHERE canvas_id = ?").get(canvas2).c, 0);
  } finally { f.fx.close(); }
});

test("列表 access.canEdit 语义不变：编辑者 true、查看者/组织可见 false，shareRole 归一", async () => {
  const f = await fixture();
  try {
    const canvasId = await canvasOwnedBy(f, "alice", "列表语义");
    assert.equal(f.service.shareCanvas({ context: f.ctx("alice"), canvasId, userId: f.fx.users.dana, role: "EDITOR" }).ok, true);
    const editorItem = f.service.listCanvases({ context: f.ctx("dana") }).items.find((item) => item.canvasId === canvasId);
    assert.equal(editorItem.access.canEdit, true);
    assert.equal(editorItem.access.canManage, false);
    assert.equal(editorItem.shareRole, "EDITOR");

    assert.equal(f.service.updateShareRole({ context: f.ctx("alice"), canvasId, userId: f.fx.users.dana, role: "VIEWER" }).ok, true);
    const viewerItem = f.service.listCanvases({ context: f.ctx("dana") }).items.find((item) => item.canvasId === canvasId);
    assert.equal(viewerItem.access.canEdit, false);
    assert.equal(viewerItem.shareRole, "VIEWER");

    assert.equal(f.service.setVisibility({ context: f.ctx("alice"), canvasId, visibility: "ORGANIZATION" }).ok, true);
    const orgItem = f.service.listCanvases({ context: f.ctx("eve") }).items.find((item) => item.canvasId === canvasId);
    assert.ok(orgItem);
    assert.equal(orgItem.access.canEdit, false);
    assert.equal(orgItem.access.source, "ORG_POLICY");
  } finally { f.fx.close(); }
});

test("命令面：新命令进入 RENDERER_COMMANDS，并经唯一 canvas:command 真实分发", async () => {
  const f = await fixture();
  try {
    for (const command of ["canvas/share", "canvas/share/update", "canvas/share/remove", "canvas/share/candidates", "canvas/shares", "canvas/access/get", "canvas/owner/transfer", "canvas/visibility"]) {
      assert.ok(canvasBootstrap.RENDERER_COMMANDS.includes(command), "白名单缺少 " + command);
    }
    const canvasId = await canvasOwnedBy(f, "alice", "IPC");
    const handlers = new Map();
    const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) };
    const identity = { current: f.fx.sessions.alice };
    canvasBootstrap.registerCanvasIpc({ ipcMain, service: f.service, identity, isTrusted: () => true });
    const handler = handlers.get("canvas:command");

    const shared = await handler({}, { command: "canvas/share", payload: { canvasId, userId: f.fx.users.dana, role: "EDITOR", requestId: "ipc-1" } });
    assert.equal(shared.ok, true, JSON.stringify(shared));
    assert.equal(shared.changed, "CREATED");
    const access = await handler({}, { command: "canvas/access/get", payload: { canvasId } });
    assert.equal(access.ok, true);
    assert.equal(access.owner.userId, f.fx.users.alice);
    const bad = await handler({}, { command: "canvas/visibility", payload: { canvasId, visibility: "NOPE" } });
    assert.equal(bad.error, "INVALID_INPUT");
    assert.equal(bad.detail, "visibility");
    const removed = await handler({}, { command: "canvas/share/remove", payload: { canvasId, userId: f.fx.users.dana } });
    assert.equal(removed.ok, true);
    assert.equal(removed.removed, true);
    // payload 里自报的 userId 不影响身份：仍是 alice 在操作
    const audit = canvasAudit(f.fx).find((row) => row.action === "canvas.share.grant");
    assert.equal(audit.actor_user_id, f.fx.users.alice);
    assert.equal(audit.request_id, "ipc-1");
  } finally { f.fx.close(); }
});

const OLD_SHARES_SQL = `
CREATE TABLE canvas_shares (
  canvas_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('VIEWER','CONTRIBUTOR','EDITOR')),
  granted_by TEXT,
  at         INTEGER NOT NULL,
  PRIMARY KEY (canvas_id, user_id)
);`;

/** 造一个"真实老库"：v28 schema + 旧 canvas_shares（无 created_at / FK / MANAGER）。 */
function seedOldCanvasShares(dbPath, rows, { orphan = false } = {}) {
  const store = new IdentityStore({ path: dbPath }).open();
  try {
    assert.equal(store.schemaVersion, 28);
    store.connection.prepare("INSERT INTO canvas_boards (id, organization_id, owner_user_id, name, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .run("cv_old", "team_old", "usr_owner", "旧画布", 100, 100);
    store.connection.exec("DROP TABLE canvas_shares");
    store.connection.exec(OLD_SHARES_SQL);
    store.connection.exec("CREATE INDEX idx_canvas_shares_user ON canvas_shares(user_id)");
    for (const row of rows) {
      store.connection.prepare("INSERT INTO canvas_shares (canvas_id, user_id, role, granted_by, at) VALUES (?,?,?,?,?)").run(...row);
    }
    if (orphan) {
      store.connection.prepare("INSERT INTO canvas_shares (canvas_id, user_id, role, granted_by, at) VALUES (?,?,?,?,?)")
        .run("cv_gone", "usr_orphan", "VIEWER", "usr_owner", 999);
    }
  } finally { store.close(); }
}

test("迁移 canvas_shares：旧 VIEWER/EDITOR/CONTRIBUTOR 数据重建后可写 MANAGER、行不丢、可重复执行", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-canvas-sharing-migration-"));
  const dbPath = path.join(dir, "identity.db");
  const oldRows = [
    ["cv_old", "usr_viewer", "VIEWER", "usr_owner", 111],
    ["cv_old", "usr_editor", "EDITOR", "usr_owner", 222],
    ["cv_old", "usr_legacy", "CONTRIBUTOR", "usr_owner", 333],
  ];
  try {
    seedOldCanvasShares(dbPath, oldRows);

    // 第一次：CanvasStore 就绪时显式迁移（事务内）
    const identity = new IdentityStore({ path: dbPath }).open();
    try {
      assert.equal(identity.schemaVersion, 28, "画布共享迁移不抢版本号（v29 属于任务合并包）");
      new CanvasStore({ identity });
      const columns = identity.connection.prepare("PRAGMA table_info(canvas_shares)").all().map((c) => c.name);
      assert.ok(columns.includes("created_at"), "必须补 created_at");
      const ddl = identity.connection.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='canvas_shares'").get().sql;
      assert.ok(ddl.includes("'MANAGER'"), "CHECK 必须允许 MANAGER");
      const fks = identity.connection.prepare("PRAGMA foreign_key_list(canvas_shares)").all();
      assert.equal(fks.length, 1, "canvas_shares 必须有 FK");
      assert.equal(fks[0].table, "canvas_boards");
      assert.equal(fks[0].on_delete, "CASCADE");

      const rows = identity.connection.prepare("SELECT * FROM canvas_shares ORDER BY user_id").all();
      assert.equal(rows.length, 3, "旧数据一行不能丢");
      assert.deepEqual(rows.map((r) => [r.user_id, r.role, r.created_at]), [
        ["usr_editor", "EDITOR", 222],
        ["usr_legacy", "CONTRIBUTOR", 333],
        ["usr_viewer", "VIEWER", 111],
      ]);
      identity.connection.prepare("INSERT INTO canvas_shares (canvas_id, user_id, role, granted_by, at, created_at) VALUES (?,?,?,?,?,?)")
        .run("cv_old", "usr_manager", "MANAGER", "usr_owner", 444, 444);
      assert.equal(identity.connection.prepare("SELECT role FROM canvas_shares WHERE user_id='usr_manager'").get().role, "MANAGER");
      const indexes = identity.connection.prepare("PRAGMA index_list(canvas_shares)").all().map((i) => i.name);
      assert.ok(indexes.includes("idx_canvas_shares_user"));
      assert.ok(identity.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_canvas_boards_org_visibility'").get());
    } finally { identity.close(); }

    // 第二次：再跑一次迁移（新 CanvasStore）→ 空跑，数据不变
    const replay = new IdentityStore({ path: dbPath }).open();
    try {
      new CanvasStore({ identity: replay });
      const rows = replay.connection.prepare("SELECT user_id, role, created_at FROM canvas_shares ORDER BY user_id").all();
      assert.equal(rows.length, 4);
      assert.equal(rows.find((r) => r.user_id === "usr_manager").role, "MANAGER");
      assert.equal(rows.find((r) => r.user_id === "usr_legacy").role, "CONTRIBUTOR");
      assert.equal(rows.find((r) => r.user_id === "usr_manager").created_at, 444);
      // FK 级联：删 board 清共享
      replay.connection.prepare("DELETE FROM canvas_boards WHERE id = ?").run("cv_old");
      assert.equal(replay.connection.prepare("SELECT COUNT(*) AS c FROM canvas_shares").get().c, 0);
      assert.deepEqual(replay.connection.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { replay.close(); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("迁移 canvas_shares：失败整级回滚（旧表与数据原样保留，无半成品表）；孤儿行不阻塞迁移", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-canvas-sharing-migration-fail-"));
  const dbPath = path.join(dir, "identity.db");
  try {
    seedOldCanvasShares(dbPath, [["cv_old", "usr_viewer", "VIEWER", "usr_owner", 111]], { orphan: true });
    const identity = new IdentityStore({ path: dbPath }).open();
    try {
      // 让迁移在第一次读 canvas_boards 时失败（FK 父表不存在）
      identity.connection.exec("ALTER TABLE canvas_boards RENAME TO canvas_boards_hidden");
      assert.throws(() => new CanvasStore({ identity }), /canvas_boards/);
      const ddl = identity.connection.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='canvas_shares'").get().sql;
      assert.equal(ddl.includes("'MANAGER'"), false, "失败后旧表必须原样保留");
      assert.equal(identity.connection.prepare("SELECT COUNT(*) AS c FROM canvas_shares").get().c, 2, "失败后行数不变");
      assert.equal(identity.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='canvas_shares_next'").get(), undefined, "不能留下半成品表");
      // 恢复父表后重试成功；孤儿行（board 不存在）被清掉，不阻塞 FK
      identity.connection.exec("ALTER TABLE canvas_boards_hidden RENAME TO canvas_boards");
      new CanvasStore({ identity });
      const rows = identity.connection.prepare("SELECT user_id, role, created_at FROM canvas_shares ORDER BY user_id").all();
      assert.deepEqual(rows.map((r) => [r.user_id, r.role, r.created_at]), [["usr_viewer", "VIEWER", 111]]);
      assert.equal(identity.connection.prepare("SELECT 1 FROM canvas_shares WHERE user_id='usr_orphan'").get(), undefined);
    } finally { identity.close(); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restore 收紧：只有 canRestore（所有者/超管）能恢复回收站画布；EDITOR/MANAGER/VIEWER 一律 READ_ONLY", async () => {
  const f = await fixture();
  try {
    // 同组织 VIEWER（fixture 只有 dana/eve 两个额外账号，这里按同一方式补一个只读用户）
    const gina = await f.fx.identity.createUser({ identifier: "gina@openarc.test", password: pw("gina"), displayName: "gina", teamId: f.fx.orgId });
    const ginaSession = await f.fx.identity.login({ identifier: "gina@openarc.test", password: pw("gina") });
    f.fx.users.gina = gina.userId;
    f.fx.sessions.gina = ginaSession.session.ref;

    const canvasId = await canvasOwnedBy(f, "alice", "恢复收紧");
    assert.equal(f.service.shareCanvas({ context: f.ctx("alice"), canvasId, userId: f.fx.users.dana, role: "EDITOR" }).ok, true);
    assert.equal(f.service.shareCanvas({ context: f.ctx("alice"), canvasId, userId: f.fx.users.eve, role: "MANAGER" }).ok, true);
    assert.equal(f.service.shareCanvas({ context: f.ctx("alice"), canvasId, userId: f.fx.users.gina, role: "VIEWER" }).ok, true);

    // 能力投影：只有 owner / 超管 canRestore
    assert.equal(f.service.accessGet({ context: f.ctx("dana"), canvasId }).capabilities.canRestore, false);
    assert.equal(f.service.accessGet({ context: f.ctx("eve"), canvasId }).capabilities.canRestore, false);
    assert.equal(f.service.accessGet({ context: f.ctx("gina"), canvasId }).capabilities.canRestore, false);
    assert.equal(f.service.accessGet({ context: f.ctx("alice"), canvasId }).capabilities.canRestore, true);
    assert.equal(f.service.accessGet({ context: f.ctx("admin"), canvasId }).capabilities.canRestore, true);

    assert.equal(f.service.trashCanvas({ context: f.ctx("alice"), canvasId }).ok, true);
    assert.ok(f.store.boardById(canvasId).deleted_at, "画布已进回收站");

    // 编辑者 / 管理共享 / 查看者：恢复被拒，且画布仍留在回收站（没有半截状态）
    expectError(f.service.restoreCanvas({ context: f.ctx("dana"), canvasId }), "READ_ONLY", "SHARE_EDITOR");
    expectError(f.service.restoreCanvas({ context: f.ctx("eve"), canvasId }), "READ_ONLY", "SHARE_MANAGER");
    expectError(f.service.restoreCanvas({ context: f.ctx("gina"), canvasId }), "READ_ONLY", "SHARE_VIEWER");
    assert.ok(f.store.boardById(canvasId).deleted_at, "被拒后仍在回收站");
    // 外组织：看不到
    expectError(f.service.restoreCanvas({ context: f.ctx("bob"), canvasId }), "NOT_FOUND_OR_FORBIDDEN");

    // 所有者可以恢复；恢复后编辑者仍可编辑
    const restored = f.service.restoreCanvas({ context: f.ctx("alice"), canvasId });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(f.store.boardById(canvasId).deleted_at, null);
    const view = f.service.getCanvas({ context: f.ctx("dana"), canvasId });
    assert.equal(f.service.saveCanvas({ context: f.ctx("dana"), canvasId, baseRevision: view.canvas.revision, doc: emptyDoc() }).ok, true);

    // 超管同样可以恢复别人的画布（canRestore）
    const other = await canvasOwnedBy(f, "alice", "超管恢复");
    assert.equal(f.service.trashCanvas({ context: f.ctx("alice"), canvasId: other }).ok, true);
    assert.equal(f.service.restoreCanvas({ context: f.ctx("admin"), canvasId: other }).ok, true);
    assert.equal(f.store.boardById(other).deleted_at, null);
  } finally { f.fx.close(); }
});

