/**
 * 只读探针：画布权限/共享的**当前**行为（P1 后端核心完成后）。
 * 运行：node experiments/dxos-canvas-sharing/probe.mjs
 *
 * 全部数据在 :memory: SQLite 里构造，不碰真实 identity.db。
 * 本文件是取证/回归探针，不是产品代码：它逐条打印 DESIGN §0.5 的三个 bug 是否已修，
 * 以及三档角色/审计/成员列表的实际返回；任一断言失败时以非 0 退出。
 */
import { createRequire } from "node:module";
import { createResourceFixture } from "../../tests/resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const { CanvasStore } = require("../../electron/canvas-store.cjs");
const { CanvasService } = require("../../electron/canvas-service.cjs");

const out = (label, value) => console.log(label + ": " + JSON.stringify(value));
let failures = 0;
const check = (label, condition, evidence) => {
  console.log((condition ? "PASS " : "FAIL ") + label + (evidence === undefined ? "" : " :: " + JSON.stringify(evidence)));
  if (!condition) failures += 1;
};

const fx = await createResourceFixture();
const store = new CanvasStore({ identity: fx.identity, clock: fx.clock });
const service = new CanvasService({ identity: fx.identity, store, resourceStore: fx.resourceStore, authService: fx.authService, authStore: fx.store, clock: fx.clock });
const ctx = (key, extra = {}) => ({ sessionRef: fx.sessions[key], appId: "canvas", source: "ui", ...extra });

try {
  const created = service.createCanvas({ context: ctx("admin"), title: "共享调研画布" });
  const canvasId = created.canvas.canvasId;
  out("admin create", { ok: created.ok, canvasId, access: created.canvas.access });

  // ── bug 1：显式 share 必须优先于 ORGANIZATION ─────────────────────────────
  service.shareCanvas({ context: ctx("admin"), canvasId, userId: fx.users.alice, role: "VIEWER" });
  out("set visibility ORGANIZATION", (() => { const r = service.setVisibility({ context: ctx("admin"), canvasId, visibility: "ORGANIZATION" }); return { ok: r.ok, visibility: r.ok ? r.canvas.visibility : null }; })());
  service.shareCanvas({ context: ctx("admin"), canvasId, userId: fx.users.alice, role: "EDITOR" });
  const orgEditor = service.getCanvas({ context: ctx("alice"), canvasId });
  out("alice getCanvas (ORG+EDITOR)", { ok: orgEditor.ok, access: orgEditor.canvas.access });
  check("bug1 组织可见不把显式 EDITOR 降级", orgEditor.ok && orgEditor.canvas.access.canEdit === true && orgEditor.canvas.access.source === "SHARE_EDITOR", orgEditor.canvas?.access);
  check("bug1 编辑者可以保存", service.saveCanvas({ context: ctx("alice"), canvasId, baseRevision: orgEditor.canvas.revision, doc: orgEditor.canvas.doc }).ok === true);
  const orgOnly = service.getCanvas({ context: ctx("dana"), canvasId });
  check("bug1 组织内未共享成员仍是只读 ORG_POLICY", orgOnly.ok && orgOnly.canvas.access.canEdit === false && orgOnly.canvas.access.source === "ORG_POLICY", orgOnly.canvas?.access);

  // ── bug 2：共享目标必须存在 / ACTIVE / 同组织 / 非 owner ────────────────────
  const missing = service.shareCanvas({ context: ctx("admin"), canvasId, userId: "usr_does_not_exist", role: "VIEWER" });
  const foreign = service.shareCanvas({ context: ctx("admin"), canvasId, userId: fx.users.bob, role: "VIEWER" });
  const toOwner = service.shareCanvas({ context: ctx("admin"), canvasId, userId: fx.users.admin, role: "VIEWER" });
  out("share nonexistent user", missing);
  out("share bob (foreign team) VIEWER", foreign);
  out("share to owner", toOwner);
  check("bug2 不存在用户被拒", missing.ok === false && missing.error === "INVALID_INPUT" && missing.detail === "target");
  check("bug2 外组织成员被拒", foreign.ok === false && foreign.error === "INVALID_INPUT" && foreign.detail === "target-org");
  check("bug2 owner 自己不能当共享目标", toOwner.ok === false && toOwner.detail === "owner");
  const bobGet = service.getCanvas({ context: ctx("bob"), canvasId });
  const bobList = service.listCanvases({ context: ctx("bob") });
  check("bug2 外组织成员打不开也列不到", bobGet.ok === false && bobList.ok === true && bobList.items.some((c) => c.canvasId === canvasId) === false, { bobGet });

  // ── bug 3（后端部分）：撤销/降级后立即拒绝保存 ────────────────────────────
  const danaCanvas = service.createCanvas({ context: ctx("admin"), title: "撤销即时生效" }).canvas.canvasId;
  service.shareCanvas({ context: ctx("admin"), canvasId: danaCanvas, userId: fx.users.dana, role: "EDITOR" });
  const firstSave = service.saveCanvas({ context: ctx("dana"), canvasId: danaCanvas, baseRevision: 1, doc: { nodes: [], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] } });
  check("bug3 编辑者撤销前可以保存", firstSave.ok === true);
  service.updateShareRole({ context: ctx("admin"), canvasId: danaCanvas, userId: fx.users.dana, role: "VIEWER" });
  const downgraded = service.saveCanvas({ context: ctx("dana"), canvasId: danaCanvas, baseRevision: firstSave.canvas.revision, doc: firstSave.canvas.doc });
  out("downgraded save", downgraded);
  check("bug3 降级为 VIEWER 后立即 READ_ONLY", downgraded.ok === false && downgraded.error === "READ_ONLY" && downgraded.detail === "SHARE_VIEWER");
  service.removeShare({ context: ctx("admin"), canvasId: danaCanvas, userId: fx.users.dana });
  const revoked = service.saveCanvas({ context: ctx("dana"), canvasId: danaCanvas, baseRevision: 1, doc: { nodes: [], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] } });
  out("revoked save", revoked);
  check("bug3 撤销共享后立即 NOT_FOUND_OR_FORBIDDEN", revoked.ok === false && revoked.error === "NOT_FOUND_OR_FORBIDDEN");

  // ── 三档：MANAGER 能改共享/可见性，但不能转移/删除 ─────────────────────────
  const managerCanvas = service.createCanvas({ context: ctx("admin"), title: "MANAGER 画布" }).canvas.canvasId;
  const managerShare = service.shareCanvas({ context: ctx("admin"), canvasId: managerCanvas, userId: fx.users.dana, role: "MANAGER" });
  out("share dana MANAGER", { ok: managerShare.ok, changed: managerShare.changed, role: managerShare.share?.role });
  const managerAccess = service.accessGet({ context: ctx("dana"), canvasId: managerCanvas });
  out("dana access (MANAGER)", managerAccess);
  check("MANAGER canManage/canEdit，但 canTrash=false", managerAccess.capabilities.canManage === true && managerAccess.capabilities.canEdit === true && managerAccess.capabilities.canTrash === false);
  check("MANAGER 能改可见性", service.setVisibility({ context: ctx("dana"), canvasId: managerCanvas, visibility: "ORGANIZATION" }).ok === true);
  check("MANAGER 不能转移所有者", service.transferOwner({ context: ctx("dana"), canvasId: managerCanvas, newOwnerUserId: fx.users.alice }).error === "READ_ONLY");
  check("MANAGER 不能删画布", service.trashCanvas({ context: ctx("dana"), canvasId: managerCanvas }).error === "READ_ONLY");

  // ── 可见性：非法值拒绝且不改 updated_at ────────────────────────────────────
  const beforeVisibility = store.boardById(canvasId);
  const badVisibility = service.setVisibility({ context: ctx("admin"), canvasId, visibility: "WHATEVER" });
  const afterVisibility = store.boardById(canvasId);
  out("visibility invalid value", badVisibility);
  check("非法 visibility 被拒，不再静默变 PRIVATE", badVisibility.ok === false && badVisibility.error === "INVALID_INPUT" && badVisibility.detail === "visibility");
  check("改可见性不更新 updated_at", afterVisibility.updated_at === beforeVisibility.updated_at && afterVisibility.visibility === "ORGANIZATION");

  // ── 成员列表：无管理权只看到人数/自己的角色 ────────────────────────────────
  const viewerList = service.listShares({ context: ctx("alice"), canvasId });
  out("alice (EDITOR) listShares", { ok: viewerList.ok, canManage: viewerList.canManage, shares: viewerList.shares, shareCount: viewerList.shareCount, myRole: viewerList.myRole });
  check("无管理权拿不到成员 ID 列表", viewerList.ok === true && viewerList.canManage === false && viewerList.shares === null && viewerList.shareCount >= 1);
  const ownerList = service.listShares({ context: ctx("admin"), canvasId });
  check("owner 能拿完整成员列表", ownerList.ok === true && ownerList.canManage === true && Array.isArray(ownerList.shares));

  // ── 审计：每个写命令都有行 ────────────────────────────────────────────────
  const auditRows = fx.store.authorizationAudit().filter((row) => String(row.action || "").startsWith("canvas."));
  out("authorization_audit canvas rows", auditRows.map((row) => ({ action: row.action, decision: row.decision, actor: row.actor_user_id, target: row.target_user_id, resource: row.resource_ref, old: row.old_permissions, new: row.new_permissions })));
  check("共享/改角色/移除/可见性都有审计", ["canvas.share.grant", "canvas.share.update", "canvas.share.revoke", "canvas.visibility.set"].every((action) => auditRows.some((row) => row.action === action)));
  check("拒绝的写尝试记 DENY", auditRows.some((row) => row.decision === "DENY"));
  check("审计 resource_ref = canvas:<id>", auditRows.every((row) => row.resource_ref == null || row.resource_ref.startsWith("canvas:")));

  // ── 存储层：角色与时间字段 ────────────────────────────────────────────────
  out("share rows", store.sharesOf(canvasId).map((s) => ({ user: s.user_id, role: s.role, granted_by: s.granted_by, at: s.at, created_at: s.created_at })));
} finally {
  fx.close();
}

if (failures) {
  console.error("\n" + failures + " 项未通过");
  process.exitCode = 1;
} else {
  console.log("\n全部检查通过");
}
