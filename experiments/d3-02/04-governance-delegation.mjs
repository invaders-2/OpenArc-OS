/**
 * D3-02 探针 04 · Super Admin / Department Admin / Delegation Ceiling / No Self Escalation。
 */
import { Probe, createFixture } from "./lib.mjs";

const p = new Probe("04-governance-delegation", "Super Admin / Department Admin / Delegation Ceiling / No Self Escalation");
const f = await createFixture();
const { svc, ctx, resources, created, depts, domain } = f;

try {
  let r = svc.grantResourcePermission({ context: f.adminCtx, principalType: "USER", principalId: created.alice, resourceId: resources.omega.resourceId, permissionSet: "VIEWER" });
  p.assert("Super Admin manage user permission → ALLOW", r.ok === true, r.error || "ok");

  r = svc.addDepartmentMember({ context: ctx("dana", "resource-library"), departmentId: depts.A.id, userId: created.bob, membershipRole: "member" });
  p.assert("Department Admin manage own department → ALLOW", r.ok === true, r.error || "ok");

  r = svc.addDepartmentMember({ context: ctx("dana", "resource-library"), departmentId: depts.B.id, userId: created.alice, membershipRole: "member" });
  p.assert("Department Admin manage other department → DENY", r.ok === false && r.error === "CROSS_DEPARTMENT_DENIED", r.error);

  r = svc.addDepartmentMember({ context: ctx("dana", "resource-library"), departmentId: depts.A.id, userId: created.dana, membershipRole: "department-admin" });
  p.assert("Department Admin self elevate → DENY", r.ok === false && r.error === "SELF_ESCALATION_DENIED", r.error);

  r = svc.setUserRole({ context: ctx("dana", "resource-library"), userId: created.dana, role: "ADMIN" });
  p.assert("Department Admin 给自己 Super Admin → DENY", r.ok === false && r.error === "NOT_SUPER_ADMIN", r.error);

  r = svc.grantResourcePermission({ context: ctx("erin", "resource-library"), principalType: "USER", principalId: created.erin, resourceId: resources.designHero.resourceId, permissionSet: "MANAGER" });
  p.assert("普通 User self grant manager → DENY", r.ok === false, r.error);

  r = svc.grantResourcePermission({ context: ctx("charlie", "resource-library"), principalType: "USER", principalId: created.erin, resourceId: resources.designHero.resourceId, actions: ["resource.delete"] });
  p.assert("grant beyond authority（无 delete）→ DELEGATION_EXCEEDS_AUTHORITY", r.ok === false && r.error === "DELEGATION_EXCEEDS_AUTHORITY", r.error);

  // 目标用户必须在**另一个部门**：先用 Super Admin 造一个 Marketing 成员 gina。
  const gina = await svc.createUser({ context: f.adminCtx, identifier: "gina@openarc.test", password: "gina-password-1", displayName: "gina" });
  svc.addDepartmentMember({ context: f.adminCtx, departmentId: depts.B.id, userId: gina.userId, membershipRole: "member" });
  r = svc.grantResourcePermission({ context: ctx("dana", "resource-library"), principalType: "USER", principalId: gina.userId, resourceId: resources.designHero.resourceId, permissionSet: "VIEWER" });
  p.assert("Department Admin 跨部门授予用户 → DENY", r.ok === false && r.error === "CROSS_DEPARTMENT_DENIED", r.error);

  r = svc.grantResourcePermission({ context: ctx("charlie", "resource-library"), principalType: "USER", principalId: created.erin, resourceId: resources.designHero.resourceId, actions: ["resource.read"] });
  p.assert("grantor 拥有该权限 → ALLOW", r.ok === true, r.error || "ok");
  const rev1 = svc.revokeResourcePermission({ context: f.adminCtx, grantId: r.grant.id });
  const rev2 = svc.revokeResourcePermission({ context: f.adminCtx, grantId: r.grant.id });
  p.assert("重复 revoke → 幂等 NO_CHANGE", rev1.changed === true && rev2.changed === false && rev2.reasonCode === "NO_CHANGE", JSON.stringify(rev2));

  const before = svc.authorize({ context: ctx("bob", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  const prevDepartment = r.ok ? before.decision : before.decision;
  p.note("bob 当前对 designHero 的决策：" + before.decision + " (" + before.reasonCode + ")；prev=" + prevDepartment);
} finally {
  f.close();
}

p.finish();
if (p.verdict() === "FAIL") process.exitCode = 1;
