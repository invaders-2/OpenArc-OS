/**
 * D3-02 探针 03 · Agent 授权：resource.useByAgent / 不能借 User 或 App 提权。
 */
import { Probe, createFixture } from "./lib.mjs";

const p = new Probe("03-agent-authorization", "Agent useByAgent / 借权防护 / Manual-AI parity");
const f = await createFixture();
const { svc, ctx, resources, created, collections, domain } = f;
const ALLOW = (r) => r.decision === "ALLOW";

try {
  let r = svc.authorize({ context: ctx("erin", "ai", { agentSessionId: "ags_1" }), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  p.assert("User+App read ALLOW 但无 useByAgent → Agent DENY", !ALLOW(r) && r.reasonCode === "AGENT_USE_NOT_AUTHORIZED", r.reasonCode);

  svc.grantResourcePermission({ context: f.adminCtx, principalType: "USER", principalId: created.erin, collectionId: collections.design.id, actions: ["resource.useByAgent"] });
  r = svc.authorize({ context: ctx("erin", "ai", { agentSessionId: "ags_1" }), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  p.assert("grant useByAgent → Agent ALLOW", ALLOW(r), r.reasonCode);

  r = svc.authorize({ context: ctx("alice", "ai", { agentSessionId: "ags_2" }), action: domain.ACTION.READ, resource: resources.deptBImage.resourceId });
  p.assert("Agent 借高权限 App 提权 → DENY", !ALLOW(r), r.reasonCode);

  r = svc.authorize({ context: ctx("erin", "browser", { agentSessionId: "ags_3" }), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  p.assert("App 借 Agent 权限提权 → DENY", !ALLOW(r), r.reasonCode);

  const manual = svc.authorize({ context: ctx("erin", "ai", { source: "manual" }), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  const agentSrc = svc.authorize({ context: ctx("erin", "ai", { source: "agent" }), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  p.assert("manual / AI same context → same decision", manual.decision === agentSrc.decision, manual.decision + " vs " + agentSrc.decision);

  const agentRead = svc.authorize({ context: ctx("erin", "ai", { agentSessionId: "ags_4" }), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  const agentDelete = svc.authorize({ context: ctx("erin", "ai", { agentSessionId: "ags_4" }), action: domain.ACTION.DELETE, resource: resources.designHero.resourceId });
  p.assert("Agent 逐动作判定：read ALLOW / delete DENY", ALLOW(agentRead) && !ALLOW(agentDelete), agentRead.reasonCode + " / " + agentDelete.reasonCode);
} finally {
  f.close();
}

p.finish();
if (p.verdict() === "FAIL") process.exitCode = 1;
