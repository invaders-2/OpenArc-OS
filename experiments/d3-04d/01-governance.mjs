/** D3-04D 探针 01 · Organization / Department / User / Scope / Ownership / Audit。 */
import { Probe, createResourceFixture } from "./lib.mjs";
const p = new Probe("01-governance", "Organization / Department / User / Scope / Ownership / Audit");
const f = await createResourceFixture();
const admin = f.adminCtx();
try {
  const A = f.governanceService.createDepartment({ context: admin, name: "ProbeA" });
  const B = f.governanceService.createDepartment({ context: admin, name: "ProbeB" });
  p.assert("Super Admin 创建部门 A / B", A.ok && B.ok, "");
  const u = await f.governanceService.createUser({ context: admin, identifier: "pg@openarc.test", password: "pg-password-1", displayName: "PG" });
  p.assert("创建子用户进入 Identity Store", u.ok && !!f.identity.userByIdentifier("pg@openarc.test"), "");
  const list = f.governanceService.listUsers({ context: admin });
  p.assert("治理列表无 password/secret 字段", !JSON.stringify(list).includes("password_hash") && !JSON.stringify(list).includes("password_salt"), "");

  f.authService.addDepartmentMember({ context: admin, departmentId: A.department.id, userId: u.userId, membershipRole: "member" });
  const moved = f.governanceService.moveUserDepartment({ context: admin, userId: u.userId, fromDepartmentId: A.department.id, toDepartmentId: B.department.id });
  p.assert("用户 A→B：旧成员关系移除、新成员关系生效", moved.ok && !f.store.membershipByPair(A.department.id, u.userId) && !!f.store.membershipByPair(B.department.id, u.userId), "");

  const detail = f.governanceService.getDepartmentDetail({ context: admin, departmentId: B.department.id });
  p.assert("部门详情计数真实", detail.ok && detail.members.length === 1, "members=" + detail.members.length);
  const blocked = f.governanceService.deleteDepartment({ context: admin, departmentId: B.department.id });
  p.assert("非空部门禁止删除（返回 blockers）", blocked.ok === false && blocked.blockers.includes("members"), JSON.stringify(blocked.blockers));

  const r = await f.resourceService.createResource({ context: f.ctx("alice"), resourceType: "text", name: "ProbeRes", content: "probe token" });
  const impact = f.governanceService.previewScopeChange({ context: admin, resourceRef: r.resource.resourceId, scope: "DEPARTMENT", departmentId: B.department.id });
  p.assert("Scope 变更影响预览可计算", impact.ok && impact.impact.toScope === "DEPARTMENT", "gain=" + impact.impact.willGain.length);
  const changed = f.governanceService.changeScope({ context: admin, resourceRef: r.resource.resourceId, scope: "DEPARTMENT", departmentId: B.department.id });
  p.assert("Scope 变更落库", changed.ok && changed.resource.scope === "DEPARTMENT", "");
  const before = f.resourceStore.resourceRowById(r.resource.resourceId).version;
  const transferred = f.governanceService.transferOwnership({ context: admin, resourceId: r.resource.resourceId, newOwnerUserId: u.userId });
  p.assert("Ownership Transfer 保持 ResourceRef 与内容版本", transferred.ok && transferred.resource.resourceRef === r.resource.resourceRef && f.resourceStore.resourceRowById(r.resource.resourceId).version === before, "");
  p.assert("治理操作全部写入 Audit", f.governanceService.listAudit({ context: admin, limit: 100 }).items.length >= 6, "");
} finally { f.close(); }
p.finish();
if (p.verdict() === "FAIL") process.exitCode = 1;
