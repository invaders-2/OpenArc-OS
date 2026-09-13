/**
 * D3-02 测试夹具。
 *
 * 所有 authorization-*.test.mjs 共用这一份场景，保证"测的这条线"就是同一套
 * IdentityStore + AuthorizationStore + AuthorizationService。
 *
 * 场景（与 §32 §44 §73 对应）：
 *   Organization（D3-01 root team, admin 即 Super Admin）
 *   ├── Department A「Design」
 *   │   ├── alice  (member)          —— 拥有 PERSONAL 资源 Project Alpha
 *   │   ├── dana   (department-admin) —— 部门管理边界 / delegation 用例
 *   │   ├── erin   (member, viewer)  —— read-only / no self-escalation
 *   │   └── charlie(member, 自定义 read+manageAccess grant)
 *   └── Department B「Marketing」
 *       └── bob    (member)          —— Secret Omega / Personal Memory Secret 的 owner
 *   frank（另一个 team）—— cross-organization 用例
 *
 * Apps（built-in）：resource-library / image-generator / photoshop / ai / canvas / browser
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const { AuthorizationStore } = require("../electron/authorization-store.cjs");
const { AuthorizationService } = require("../electron/authorization-service.cjs");
const domain = require("../electron/authorization-domain.cjs");

export const pw = (name) => name + "-password-1";

export const USER_KEYS = ["admin", "alice", "bob", "dana", "erin", "charlie", "frank"];

export async function createFixture({ dbPath = ":memory:" } = {}) {
  const identity = new IdentityStore({ path: dbPath }).open();
  const store = new AuthorizationStore({ identity });
  const svc = new AuthorizationService({ identity, authStore: store });

  await identity.initialize({ identifier: "admin@openarc.test", password: pw("admin"), displayName: "Admin" });
  const adminLogin = await identity.login({ identifier: "admin@openarc.test", password: pw("admin") });
  const admin = adminLogin.user;
  const orgId = admin.team_id;

  const identifierFor = (k) => (k === "frank" ? "frank@foreign.test" : k + "@openarc.test");

  const created = {};
  for (const key of ["alice", "bob", "dana", "erin", "charlie"]) {
    const res = await identity.createUser({ identifier: identifierFor(key), password: pw(key), displayName: key, teamId: orgId });
    if (!res.ok) throw new Error("createUser " + key + " failed: " + res.error);
    created[key] = res.userId;
  }

  // 另一个 team 的成员：cross-organization 用例（teamId 由 D3-01 模型承载 organizationId）
  const foreignTeam = domain.newId("DEPARTMENT").replace("dept_", "team_");
  identity.connection
    .prepare("INSERT INTO teams (id, name, root, created_at) VALUES (?, 'Foreign Workspace', 0, ?)")
    .run(foreignTeam, identity.clock());
  const frankRes = await identity.createUser({ identifier: identifierFor("frank"), password: pw("frank"), displayName: "frank", teamId: foreignTeam });
  created.frank = frankRes.userId;

  const sessions = {};
  for (const key of ["alice", "bob", "dana", "erin", "charlie", "frank"]) {
    const login = await identity.login({ identifier: identifierFor(key), password: pw(key) });
    if (!login.ok) throw new Error("login " + key + " failed: " + login.error);
    sessions[key] = login.session.ref;
  }
  sessions.admin = adminLogin.session.ref;

  const adminCtx = { sessionRef: sessions.admin, appId: "resource-library", source: "ui" };
  const ctx = (key, appId = "resource-library", extra = {}) => ({ sessionRef: sessions[key], appId, source: "ui", ...extra });

  // ── Departments ──────────────────────────────────────────────────────────
  const deptA = svc.createDepartment({ context: adminCtx, name: "Design" });
  const deptB = svc.createDepartment({ context: adminCtx, name: "Marketing" });
  if (!deptA.ok || !deptB.ok) throw new Error("createDepartment failed");

  svc.addDepartmentMember({ context: adminCtx, departmentId: deptA.department.id, userId: created.alice, membershipRole: "member" });
  svc.addDepartmentMember({ context: adminCtx, departmentId: deptA.department.id, userId: created.erin, membershipRole: "member" });
  svc.addDepartmentMember({ context: adminCtx, departmentId: deptA.department.id, userId: created.charlie, membershipRole: "member" });
  svc.addDepartmentMember({ context: adminCtx, departmentId: deptA.department.id, userId: created.dana, membershipRole: "department-admin" });
  svc.addDepartmentMember({ context: adminCtx, departmentId: deptB.department.id, userId: created.bob, membershipRole: "member" });

  // ── Collections ──────────────────────────────────────────────────────────
  const designCol = svc.createCollection({ context: adminCtx, name: "Design Assets", departmentId: deptA.department.id, scope: "DEPARTMENT" });
  const marketingCol = svc.createCollection({ context: adminCtx, name: "Marketing Assets", departmentId: deptB.department.id, scope: "DEPARTMENT" });
  if (!designCol.ok || !marketingCol.ok) throw new Error("createCollection failed");

  // ── Resources ────────────────────────────────────────────────────────────
  const mkRes = (args, byKey) => {
    const r = svc.registerResource({ context: ctx(byKey || "admin"), ...args });
    if (!r.ok) throw new Error("registerResource failed: " + JSON.stringify(args) + " -> " + r.error);
    return r.resource;
  };
  const resources = {
    alpha: mkRes({ resourceId: "res_alpha_fixture_0001", resourceType: "project", ownerUserId: created.alice, scope: "PERSONAL", name: "Project Alpha", tags: ["project"] }, "alice"),
    omega: mkRes({ resourceId: "res_omega_fixture_0001", resourceType: "document", ownerUserId: created.bob, scope: "DEPARTMENT", departmentId: deptB.department.id, collectionId: marketingCol.collection.id, name: "Secret Resource Omega", tags: ["secret", "omega"] }, "admin"),
    memorySecret: mkRes({ resourceId: "res_memory_fixture_0001", resourceType: "memory", ownerUserId: created.bob, scope: "PERSONAL", name: "Personal Memory Secret", tags: ["memory"] }, "bob"),
    deptBImage: mkRes({ resourceId: "res_deptbimg_fixture_01", resourceType: "image", ownerUserId: created.bob, scope: "DEPARTMENT", departmentId: deptB.department.id, collectionId: marketingCol.collection.id, name: "Department B Image" }, "admin"),
    designHero: mkRes({ resourceId: "res_designhero_fix_001", resourceType: "image", ownerUserId: created.dana, scope: "DEPARTMENT", departmentId: deptA.department.id, collectionId: designCol.collection.id, name: "Design Hero" }, "admin"),
    orgDoc: mkRes({ resourceId: "res_orgdoc_fixture_001", resourceType: "document", ownerUserId: created.admin, scope: "ORGANIZATION", name: "Org Handbook" }, "admin"),
  };

  // ── Department A: VIEWER on Design collection ────────────────────────────
  const grantDeptA = svc.grantResourcePermission({ context: adminCtx, principalType: "DEPARTMENT", principalId: deptA.department.id, collectionId: designCol.collection.id, permissionSet: "VIEWER" });
  if (!grantDeptA.ok) throw new Error("grant dept A failed: " + grantDeptA.error);

  // charlie: 只有 read + manageAccess（用于 delegation ceiling 用例）
  svc.grantResourcePermission({ context: adminCtx, principalType: "USER", principalId: created.charlie, resourceId: resources.designHero.resourceId, actions: ["resource.read", "resource.manageAccess"] });
  // dana: read + manageAccess（她被委托管理部门，但 ceiling 不包含 edit/delete）
  svc.grantResourcePermission({ context: adminCtx, principalType: "USER", principalId: created.dana, resourceId: resources.designHero.resourceId, actions: ["resource.read", "resource.manageAccess"] });
  // bob: EDITOR on Department B image（用于 reparent 后 B policy 重新计算）
  svc.grantResourcePermission({ context: adminCtx, principalType: "DEPARTMENT", principalId: deptB.department.id, resourceId: resources.omega.resourceId, permissionSet: "VIEWER" });

  // ── App grants ───────────────────────────────────────────────────────────
  const appGrant = (args) => {
    const r = svc.grantAppResourcePermission({ context: adminCtx, ...args });
    if (!r.ok) throw new Error("grantApp failed: " + JSON.stringify(args) + " -> " + r.error);
    return r;
  };
  // resource-library 作为系统内置 UI：对普通资源全局开放全部动作，并显式覆盖 memory（§41）
  appGrant({ appId: "resource-library", actions: domain.RESOURCE_ACTIONS });
  appGrant({ appId: "resource-library", resourceType: "memory", actions: domain.RESOURCE_ACTIONS });
  // image-generator：仅 resourceType=image
  appGrant({ appId: "image-generator", resourceType: "image", actions: ["resource.view", "resource.preview", "resource.read", "resource.download"] });
  // photoshop：Design Collection read + edit
  appGrant({ appId: "photoshop", collectionId: designCol.collection.id, actions: ["resource.view", "resource.search", "resource.preview", "resource.read", "resource.edit", "resource.download"] });
  // ai：image + project + document 的 read（Agent 场景）
  appGrant({ appId: "ai", resourceType: "image", actions: ["resource.view", "resource.read", "resource.search", "resource.preview", "resource.useByAgent"] });
  appGrant({ appId: "ai", resourceType: "project", actions: ["resource.view", "resource.read", "resource.search", "resource.preview", "resource.useByAgent"] });
  // canvas：全局不授予；只给它 image read 用于 "App 不能借 Agent 提权" 对照
  appGrant({ appId: "canvas", resourceType: "image", actions: ["resource.view", "resource.read"] });

  return {
    identity,
    store,
    svc,
    domain,
    orgId,
    created,
    sessions,
    admin,
    adminCtx,
    ctx,
    depts: { A: deptA.department, B: deptB.department },
    collections: { design: designCol.collection, marketing: marketingCol.collection },
    resources,
    foreignTeam,
    close() {
      identity.close();
      if (dbPath !== ":memory:") fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    },
  };
}

/** 独立临时目录（迁移 / race 用例需要真实文件库）。 */
export function tempDbPath(prefix = "oa-d3-02-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, dbPath: path.join(dir, "identity.db") };
}
