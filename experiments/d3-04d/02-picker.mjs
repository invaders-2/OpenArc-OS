/** D3-04D 探针 02 · Resource Picker 交集 / 零泄漏 / Ceiling / Token。 */
import { Probe, createResourceFixture } from "./lib.mjs";
const p = new Probe("02-picker", "Resource Picker 授权交集 / 零泄漏 / Type-Dept Ceiling / Token 重新授权");
const f = await createResourceFixture();
const admin = f.adminCtx();
try {
  const A = f.authService.createDepartment({ context: admin, name: "PickA2" });
  f.authService.addDepartmentMember({ context: admin, departmentId: A.department.id, userId: f.users.admin, membershipRole: "member" });
  const imp = await f.resourceService.importText({ context: admin, text: "picker probe", name: "PickProbe", scope: "DEPARTMENT", departmentId: A.department.id });
  f.authService.grantResourcePermission({ context: admin, principalType: "DEPARTMENT", principalId: A.department.id, resourceId: imp.resource.resourceId, permissionSet: "VIEWER" });
  const pp = await f.governanceService.createUser({ context: admin, identifier: "pp@openarc.test", password: "pp-password-1", displayName: "PP" });
  f.authService.addDepartmentMember({ context: admin, departmentId: A.department.id, userId: pp.userId, membershipRole: "member" });
  const ppLogin = await f.identity.login({ identifier: "pp@openarc.test", password: "pp-password-1" });
  const ppCtx = { sessionRef: ppLogin.session.ref, appId: "resource-library" };
  const q = await f.pickerService.query({ context: ppCtx, appId: "resource-library", query: "picker probe", limit: 10 });
  p.assert("Picker 返回 User ∩ App 交集", q.ok && q.items.some((i) => i.resourceId === imp.resource.resourceId), "total=" + q.total);
  p.assert("Picker 不返回绝对路径 / internal key", !JSON.stringify(q).includes("objects/") && !JSON.stringify(q).includes("/private/"), "");
  const dana = f.ctx("dana");
  const denied = await f.pickerService.query({ context: dana, appId: "resource-library", query: "picker probe", limit: 10 });
  p.assert("无权用户 0 结果且不泄漏 name", denied.total === 0 && !JSON.stringify(denied).includes("PickProbe"), "");
  // 内置 App 有 baseline 全局 grant；先撤销再验证 "无 grant → 0"
  for (const g of f.store.appGrantsForApp("image-generator")) f.governanceService.revokeAppAccess({ context: admin, grantId: g.id });
  const qApp = await f.pickerService.query({ context: admin, appId: "image-generator", query: "picker probe", limit: 10 });
  p.assert("App 无 grant → 0", qApp.total === 0, "");
  const choice = f.pickerService.choose({ context: ppCtx, appId: "resource-library", resourceRef: imp.resource.resourceId, requestedActions: ["resource.read"] });
  p.assert("choose 返回 ResourceRef + token", choice.ok && choice.resourceRef.startsWith("resource://") && !!choice.selectionToken, "");
  const access = f.governanceService.listResourceAccess({ context: admin, resourceRef: imp.resource.resourceId });
  f.authService.revokeResourcePermission({ context: admin, grantId: access.grants.find((g) => g.principalType === "DEPARTMENT").grantId });
  p.assert("撤权后 token 校验立即 DENY", f.pickerService.validateSelection({ context: ppCtx, selectionToken: choice.selectionToken, action: "resource.read" }).ok === false, "");
} finally { f.close(); }
p.finish();
if (p.verdict() === "FAIL") process.exitCode = 1;
