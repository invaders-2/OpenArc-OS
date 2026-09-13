/** D3-04C · resource-search-authz.test —— 服务端授权 / Zero Leakage / App / Agent / Department。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const alice = f.ctx("alice");
const dana = f.ctx("dana");
const bob = f.ctx("bob");
const admin = f.adminCtx();

test("Secret Resource Omega / Personal Memory Secret / Department B Private 全部 0 泄漏", async () => {
  await f.resourceService.createResource({ context: admin, resourceType: "document", name: "Secret Resource Omega", content: "omega classified" });
  await f.resourceService.createResource({ context: admin, resourceType: "memory", name: "Personal Memory Secret", content: "secret memory" });
  const deptB = f.authService.createDepartment({ context: admin, name: "Marketing" });
  f.authService.registerResource({ context: admin, resourceType: "document", scope: "DEPARTMENT", departmentId: deptB.department.id, name: "Department B Private Resource", description: "部门B" });
  for (const q of ["Omega", "Secret", "部门B"]) {
    const r = await f.searchService.search({ context: alice, query: q, limit: 10 });
    assert.equal(r.ok, true);
    assert.equal(r.total, 0, q + " 应 0 结果");
    assert.deepEqual(r.items, []);
    assert.equal(JSON.stringify(r).includes("Omega"), false);
    assert.equal(JSON.stringify(r).includes("Private"), false);
  }
});

test("User ∩ App：禁用 resource-library App -> search DENY，重新启用后恢复", async () => {
  await f.resourceService.createResource({ context: alice, resourceType: "text", name: "AppScope", content: "appscope-token" });
  assert.ok((await f.searchService.search({ context: alice, query: "appscope-token", limit: 5 })).total >= 1);
  f.authService.setAppStatus({ context: admin, appId: "resource-library", status: "disabled" });
  const denied = await f.searchService.search({ context: alice, query: "appscope-token", limit: 5 });
  assert.equal(denied.ok, false);
  f.authService.setAppStatus({ context: admin, appId: "resource-library", status: "enabled" });
  assert.ok((await f.searchService.search({ context: alice, query: "appscope-token", limit: 5 })).total >= 1);
});

test("Department 变化：移出部门后立即消失（索引不改也能生效）", async () => {
  // DEPARTMENT scope 资源 + Department grant：alice 是显式 USER grant 也拿不到（必须仍是部门成员）。
  const reg = f.authService.registerResource({ context: admin, resourceType: "text", scope: "DEPARTMENT", departmentId: f.departmentId, name: "DeptRes", description: "deptonly-token" });
  const g = f.authService.grantResourcePermission({ context: admin, principalType: "DEPARTMENT", principalId: f.departmentId, resourceId: reg.resource.resourceId, permissionSet: "VIEWER" });
  assert.equal(g.ok, true);
  assert.equal((await f.searchService.search({ context: alice, query: "deptonly-token", limit: 5 })).total, 1);
  f.authService.removeDepartmentMember({ context: admin, departmentId: f.departmentId, userId: f.users.alice });
  assert.equal((await f.searchService.search({ context: alice, query: "deptonly-token", limit: 5 })).total, 0);
  f.authService.addDepartmentMember({ context: admin, departmentId: f.departmentId, userId: f.users.alice, membershipRole: "member" });
  assert.equal((await f.searchService.search({ context: alice, query: "deptonly-token", limit: 5 })).total, 1);
});

test("Agent：无 useByAgent 时 search DENY；owner 拥有 useByAgent 可搜", async () => {
  const mem = await f.resourceService.createResource({ context: alice, resourceType: "memory", name: "AgentSearch", content: "agentsearch-token" });
  const ownerAgent = await f.searchService.search({ context: { ...alice, agentSessionId: "ags1" }, query: "agentsearch-token", limit: 5 });
  assert.equal(ownerAgent.total, 1, "owner policy 含 useByAgent");
  f.authService.grantResourcePermission({ context: admin, principalType: "USER", principalId: f.users.dana, resourceId: mem.resource.resourceId, permissionSet: "VIEWER" });
  const danaAgent = await f.searchService.search({ context: { ...dana, agentSessionId: "ags2" }, query: "agentsearch-token", limit: 5 });
  assert.equal(danaAgent.total, 0, "dana 无 useByAgent，Agent search 必须 DENY");
});

test("Super Admin 无 Personal Memory content access 时也搜不到", async () => {
  await f.resourceService.createResource({ context: alice, resourceType: "memory", name: "SuperSecret", content: "supersecret-token" });
  const adminSearch = await f.searchService.search({ context: admin, query: "supersecret-token", limit: 5 });
  assert.equal(adminSearch.total, 0);
});

test("跨组织搜索 0 结果", async () => {
  await f.resourceService.createResource({ context: alice, resourceType: "text", name: "OrgOnly", content: "orgonly-token" });
  assert.equal((await f.searchService.search({ context: bob, query: "orgonly-token", limit: 5 })).total, 0);
});
