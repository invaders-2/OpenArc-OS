/** D3-04D · governance-memory —— Personal Memory 隐私：管理 ≠ 自动读。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const admin = f.adminCtx();
const alice = f.ctx("alice");
const dana = f.ctx("dana");

test("Personal Memory：其他用户 / 部门管理员 / Super Admin 均不能读正文", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "memory", name: "私人记忆", content: "secret-memory-body", memorySubtype: "project-memory" });
  const rid = r.resource.resourceId;
  assert.equal(f.authService.authorize({ context: dana, action: "resource.read", resource: rid }).decision, "DENY");
  // Super Admin 能治理但不能自动读内容
  assert.equal(f.authService.authorize({ context: admin, action: "resource.read", resource: rid }).decision, "DENY");
  assert.equal(f.authService.authorize({ context: admin, action: "resource.preview", resource: rid }).decision, "DENY");
  // Super Admin 可以查看/治理访问说明
  const accessRes = f.governanceService.listResourceAccess({ context: admin, resourceRef: rid });
  assert.equal(accessRes.ok, true);
  assert.equal(accessRes.sources.some((s) => s.source === "OWNER_POLICY"), true);
  // 搜索不泄漏
  const search = await f.searchService.search({ context: admin, query: "secret-memory-body", limit: 10 });
  assert.equal(search.total, 0);
  const byName = await f.searchService.search({ context: admin, query: "私人记忆", limit: 10 });
  assert.equal(byName.total, 0);
});

test("普通第三方 App 默认不能读 Memory（即使 app 有 resource.read）", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "memory", name: "AppMemory", content: "app-memory", memorySubtype: "project-memory" });
  // 给 image-generator 一个全局 read grant（不含 resourceType=memory）
  f.governanceService.grantAppAccess({ context: admin, appId: "image-generator", actions: ["resource.read", "resource.view"] });
  const appCtx = { sessionRef: f.sessions.alice, appId: "image-generator" };
  assert.equal(f.authService.authorize({ context: appCtx, action: "resource.read", resource: r.resource.resourceId }).decision, "DENY");
});
