/**
 * D3-02 · authorization-policy.test
 * 冻结授权公式与 DEFAULT DENY + ADDITIVE ALLOW 的入口判据（§68 §79）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFixture, pw } from "./authorization-fixtures.mjs";

const f = await createFixture();
after(() => f.close());
const { svc, ctx, resources, domain, sessions } = f;

test("valid user + allowed action → ALLOW", () => {
  const r = svc.authorize({ context: ctx("erin", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  assert.equal(r.decision, "ALLOW");
  assert.ok(r.effectivePermissions.includes(domain.ACTION.READ));
});

test("valid user + denied action → DENY", () => {
  const r = svc.authorize({ context: ctx("erin", "resource-library"), action: domain.ACTION.DELETE, resource: resources.designHero.resourceId });
  assert.equal(r.decision, "DENY");
  assert.equal(r.reasonCode, "USER_ACTION_NOT_GRANTED");
});

test("PERSONAL owner → ALLOW via OWNER_POLICY（不是无 ACL 行 → allow）", () => {
  const r = svc.authorize({ context: ctx("alice", "resource-library"), action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  assert.equal(r.decision, "ALLOW");
  assert.ok(r.allowSources.includes("OWNER_POLICY"));
});

test("DEFAULT DENY: 无任何 grant 的非 owner → DENY", () => {
  const r = svc.authorize({ context: ctx("erin", "resource-library"), action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  assert.equal(r.decision, "DENY");
});

test("invalid session → DENY SESSION_REVOKED", () => {
  const r = svc.authorize({ context: { sessionRef: "sref_does-not-exist", appId: "resource-library" }, action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  assert.equal(r.decision, "DENY");
  assert.equal(r.reasonCode, "SESSION_REVOKED");
});

test("missing sessionRef → DENY", () => {
  const r = svc.authorize({ context: { appId: "resource-library" }, action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  assert.equal(r.decision, "DENY");
});

test("disabled user → DENY USER_DISABLED；Re-enable 后旧 session 失效（D3-05 §9）", async () => {
  f.identity.setUserStatus(f.created.erin, "DISABLED");
  const r = svc.authorize({ context: ctx("erin", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  assert.equal(r.decision, "DENY");
  assert.equal(r.reasonCode, "USER_DISABLED");
  f.identity.setUserStatus(f.created.erin, "ACTIVE");
  // D3-05：Re-enable 不静默恢复旧 session —— 必须重新登录
  assert.equal(f.identity.validateSession(sessions.erin, { sensitive: true }).ok, false);
  const relogin = await f.identity.login({ identifier: "erin@openarc.test", password: pw("erin") });
  assert.equal(relogin.ok, true);
  sessions.erin = relogin.session.ref;
});

test("unknown app → DENY APP_UNKNOWN；缺 appId → DENY APP_REQUIRED", () => {
  const unknown = svc.authorize({ context: ctx("alice", "no-such-app"), action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  assert.equal(unknown.reasonCode, "APP_UNKNOWN");
  const missing = svc.authorize({ context: { sessionRef: ctx("alice", "resource-library").sessionRef }, action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  assert.equal(missing.reasonCode, "APP_REQUIRED");
});

test("invalid action → DENY INVALID_INPUT", () => {
  const r = svc.authorize({ context: ctx("alice", "resource-library"), action: "resource.notAnAction", resource: resources.alpha.resourceId });
  assert.equal(r.decision, "DENY");
  assert.equal(r.reasonCode, "INVALID_INPUT");
});

test("未知 resourceId → 对外 NOT_FOUND_OR_FORBIDDEN", () => {
  const r = svc.authorize({ context: ctx("alice", "resource-library"), action: domain.ACTION.READ, resource: "res_nonexistent_000000" });
  assert.equal(r.decision, "DENY");
  assert.equal(r.reasonCode, "NOT_FOUND_OR_FORBIDDEN");
});

test("决策固定携带 policyVersion / requestId / source，且 source 不改变决策", () => {
  const manual = svc.authorize({ context: ctx("erin", "resource-library", { source: "manual", requestId: "req_1" }), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  const agentish = svc.authorize({ context: ctx("erin", "resource-library", { source: "agent", requestId: "req_2" }), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  assert.equal(manual.policyVersion, "d3-02-v1");
  assert.equal(manual.decision, agentish.decision);
  assert.equal(manual.requestId, "req_1");
});
