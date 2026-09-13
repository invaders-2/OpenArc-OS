/**
 * D3-02 探针 01 · 授权公式 / DEFAULT DENY / Scope / Session Gate。
 */
import { Probe, createFixture } from "./lib.mjs";

const p = new Probe("01-authorization-policy", "授权公式 / DEFAULT DENY + ADDITIVE ALLOW / Scope / Session Gate");
const f = await createFixture();
const { svc, ctx, resources, domain } = f;
const ALLOW = (r) => r.decision === "ALLOW";

try {
  let r = svc.authorize({ context: ctx("alice", "resource-library"), action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  p.assert("Personal owner read → ALLOW via OWNER_POLICY", ALLOW(r) && r.allowSources.includes("OWNER_POLICY"), r.reasonCode);

  r = svc.authorize({ context: ctx("erin", "resource-library"), action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  p.assert("非 owner 无 grant → DEFAULT DENY", !ALLOW(r), r.reasonCode);

  r = svc.authorize({ context: ctx("erin", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  p.assert("Department inherited VIEWER → read ALLOW", ALLOW(r) && r.allowSources.includes("DEPARTMENT_GRANT"), r.reasonCode);

  r = svc.authorize({ context: ctx("erin", "resource-library"), action: domain.ACTION.EDIT, resource: resources.designHero.resourceId });
  p.assert("Department inherited VIEWER → edit DENY", !ALLOW(r), r.reasonCode);

  r = svc.authorize({ context: ctx("alice", "resource-library"), action: domain.ACTION.READ, resource: resources.orgDoc.resourceId });
  p.assert("ORGANIZATION scope → ORG_POLICY read ALLOW", ALLOW(r) && r.allowSources.includes("ORG_POLICY"), r.reasonCode);

  r = svc.authorize({ context: ctx("alice", "resource-library"), action: domain.ACTION.EDIT, resource: resources.orgDoc.resourceId });
  p.assert("ORGANIZATION scope → edit DENY", !ALLOW(r), r.reasonCode);

  r = svc.authorize({ context: ctx("bob", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  p.assert("cross department → DENY", !ALLOW(r), r.reasonCode);

  r = svc.authorize({ context: { sessionRef: "sref_missing", appId: "resource-library" }, action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  p.assert("invalid session → DENY", !ALLOW(r) && r.reasonCode === "SESSION_REVOKED", r.reasonCode);

  f.identity.lock(f.sessions.erin);
  r = svc.authorize({ context: ctx("erin", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  p.assert("locked session → DENY + REQUIRE_REAUTH", !ALLOW(r) && r.reasonCode === "SESSION_LOCKED" && r.challenge === "REAUTH", r.reasonCode + "/" + r.challenge);
  await f.identity.unlock(f.sessions.erin, "erin-password-1");
  f.sessions.erin = f.identity.allSessions().find((s) => s.user_id === f.created.erin && s.revoked_at == null).ref;

  f.identity.setUserStatus(f.created.erin, "DISABLED");
  r = svc.authorize({ context: ctx("erin", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  p.assert("disabled user → DENY USER_DISABLED", !ALLOW(r) && r.reasonCode === "USER_DISABLED", r.reasonCode);
  f.identity.setUserStatus(f.created.erin, "ACTIVE");

  r = svc.authorize({ context: ctx("alice", "no-such-app"), action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  p.assert("unknown app → DENY", !ALLOW(r) && r.reasonCode === "APP_UNKNOWN", r.reasonCode);

  r = svc.authorize({ context: ctx("alice", "resource-library"), action: "resource.teleport", resource: resources.alpha.resourceId });
  p.assert("invalid action → DENY", !ALLOW(r) && r.reasonCode === "INVALID_INPUT", r.reasonCode);

  const manual = svc.authorize({ context: ctx("erin", "resource-library", { source: "manual" }), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  const agentSource = svc.authorize({ context: ctx("erin", "resource-library", { source: "agent" }), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  p.assert("source 只进审计：manual / agent 决策一致", manual.decision === agentSource.decision && manual.reasonCode === agentSource.reasonCode, manual.decision + " vs " + agentSource.decision);
} finally {
  f.close();
}

p.finish();
if (p.verdict() === "FAIL") process.exitCode = 1;
