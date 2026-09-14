/** D3-04D · governance-app-access —— App 列表 / 授权 / 撤权 / 禁用 / 权限扩大契约。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const admin = f.adminCtx();

test("listApps 列出已注册 App Principal（含内置）", () => {
  const apps = f.governanceService.listApps({ context: admin });
  assert.equal(apps.ok, true);
  const ids = apps.items.map((a) => a.appId);
  for (const expected of ["resource-library", "canvas", "browser", "ai", "image-generator", "video-generator", "photoshop", "illustrator", "mcp-center", "skill-runtime"]) {
    assert.ok(ids.includes(expected), "缺少 App " + expected);
  }
});

test("App Grant：授予 / 查看 / 撤销", async () => {
  const alice = f.ctx("alice");
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "AppRes", content: "app token" });
  const grant = f.governanceService.grantAppAccess({ context: admin, appId: "canvas", resourceId: r.resource.resourceId, actions: ["resource.read", "resource.view"] });
  assert.equal(grant.ok, true);
  const view = f.governanceService.getAppAccess({ context: admin, appId: "canvas" });
  assert.ok(view.grants.some((g) => g.resourceId === r.resource.resourceId));
  const rev = f.governanceService.revokeAppAccess({ context: admin, grantId: grant.grant.id });
  assert.equal(rev.ok, true);
  const after2 = f.governanceService.getAppAccess({ context: admin, appId: "canvas" });
  assert.equal(after2.grants.some((g) => g.resourceId === r.resource.resourceId), false);
});

test("App 禁用后下一读取立即 DENY；重新启用恢复", async () => {
  const alice = f.ctx("alice");
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "AppDisable", content: "disable token" });
  f.governanceService.grantAppAccess({ context: admin, appId: "canvas", resourceId: r.resource.resourceId, actions: ["resource.read", "resource.view", "resource.search"] });
  const canvasCtx = { sessionRef: f.sessions.alice, appId: "canvas" };
  assert.equal(f.authService.authorize({ context: canvasCtx, action: "resource.read", resource: r.resource.resourceId }).decision, "ALLOW");
  f.governanceService.setAppStatus({ context: admin, appId: "canvas", status: "disabled" });
  assert.equal(f.authService.authorize({ context: canvasCtx, action: "resource.read", resource: r.resource.resourceId }).decision, "DENY");
  f.governanceService.setAppStatus({ context: admin, appId: "canvas", status: "enabled" });
  assert.equal(f.authService.authorize({ context: canvasCtx, action: "resource.read", resource: r.resource.resourceId }).decision, "ALLOW");
});

test("App 权限扩大（read → read+delete）必须重新批准", () => {
  const contract = f.governanceService.evaluateAppPermissionUpgrade({ currentActions: ["resource.read", "resource.view"], requestedActions: ["resource.read", "resource.view", "resource.delete"] });
  assert.equal(contract.requiresReapproval, true);
  assert.deepEqual(contract.added, ["resource.delete"]);
  const noChange = f.governanceService.evaluateAppPermissionUpgrade({ currentActions: ["resource.read"], requestedActions: ["resource.read"] });
  assert.equal(noChange.requiresReapproval, false);
});
