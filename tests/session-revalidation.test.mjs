/**
 * D3-02 · session-revalidation.test
 * 所有 authorize 先进 D3-01 Session Validation；ACL 不能绕过身份状态（§30 §47）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFixture, pw } from "./authorization-fixtures.mjs";

const f = await createFixture();
after(() => f.close());
const { svc, ctx, resources, identity, domain } = f;

test("locked session：受保护动作 → DENY SESSION_LOCKED / REQUIRE_REAUTH（即使 ACL 允许）", () => {
  identity.lock(f.sessions.erin);
  const r = svc.authorize({ context: ctx("erin", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  assert.equal(r.decision, "DENY");
  assert.equal(r.reasonCode, "SESSION_LOCKED");
  assert.equal(r.challenge, "REAUTH");
});

test("unlock 后同一 ACL 恢复可用（锁不是撤销）", async () => {
  const res = await identity.unlock(f.sessions.erin, pw("erin"));
  assert.equal(res.ok, true);
  f.sessions.erin = res.session.ref;
  const r = svc.authorize({ context: ctx("erin", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  assert.equal(r.decision, "ALLOW");
});

test("expired session → DENY SESSION_EXPIRED", () => {
  identity.connection.prepare("UPDATE sessions SET expires_at = 0 WHERE ref = ?").run(f.sessions.charlie);
  const r = svc.authorize({ context: ctx("charlie", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  assert.equal(r.decision, "DENY");
  assert.equal(r.reasonCode, "SESSION_EXPIRED");
});

test("revoked session → DENY SESSION_REVOKED", () => {
  identity.logout(f.sessions.dana);
  const r = svc.authorize({ context: ctx("dana", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  assert.equal(r.decision, "DENY");
  assert.equal(r.reasonCode, "SESSION_REVOKED");
});

test("search / list 同样先过 Session Gate", () => {
  const list = svc.listAuthorizedResources({ context: { sessionRef: "sref_revoked", appId: "resource-library" } });
  assert.equal(list.ok, false);
  assert.equal(list.count, 0);
});
