/** D3-04C · resource-preview-authz.test —— Preview 每次重新授权 / revoke 立即生效。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const alice = f.ctx("alice");
const dana = f.ctx("dana");
const admin = f.adminCtx();

test("无权用户 preview -> NOT_FOUND_OR_FORBIDDEN", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "AuthPrev", content: "x" });
  const pv = await f.previewService.preview({ context: dana, resourceRef: r.resource.resourceId });
  assert.equal(pv.ok, false);
  assert.equal(pv.error, "NOT_FOUND_OR_FORBIDDEN");
});

test("Revoke 后 preview 立即 DENY", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "RevokePrev", content: "x" });
  const g = f.authService.grantResourcePermission({ context: admin, principalType: "USER", principalId: f.users.dana, resourceId: r.resource.resourceId, permissionSet: "VIEWER" });
  assert.equal((await f.previewService.preview({ context: dana, resourceRef: r.resource.resourceId })).ok, true);
  f.authService.revokeResourcePermission({ context: admin, grantId: g.grant.id });
  assert.equal((await f.previewService.preview({ context: dana, resourceRef: r.resource.resourceId })).ok, false);
});

test("App 撤权 / 禁用后 preview 立即 DENY", async () => {
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "AppPrev", content: "x" });
  assert.equal((await f.previewService.preview({ context: alice, resourceRef: r.resource.resourceId })).ok, true);
  f.authService.setAppStatus({ context: admin, appId: "resource-library", status: "disabled" });
  assert.equal((await f.previewService.preview({ context: alice, resourceRef: r.resource.resourceId })).ok, false);
  f.authService.setAppStatus({ context: admin, appId: "resource-library", status: "enabled" });
  assert.equal((await f.previewService.preview({ context: alice, resourceRef: r.resource.resourceId })).ok, true);
});

test("capability 签发后 revoke：protocol handler 重新授权 -> 403", async () => {
  const src = f.writeSource("caprev.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 2)]));
  const imp = await f.resourceService.importManaged({ context: alice, sourcePath: src, name: "caprev.png" });
  const g = f.authService.grantResourcePermission({ context: admin, principalType: "USER", principalId: f.users.dana, resourceId: imp.resource.resourceId, permissionSet: "VIEWER" });
  const minted = await f.previewService.preview({ context: dana, resourceRef: imp.resource.resourceId });
  assert.equal(minted.ok, true);
  assert.equal((await f.previewService.handleProtocolRequest(new Request(minted.url))).status, 200);
  f.authService.revokeResourcePermission({ context: admin, grantId: g.grant.id });
  assert.equal((await f.previewService.handleProtocolRequest(new Request(minted.url))).status, 403);
});
