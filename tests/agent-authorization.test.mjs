/**
 * D3-02 · agent-authorization.test
 * Agent 不是 Super Principal：User 授权 ∩ App 授权 ∩ resource.useByAgent（§26 §60 §72）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFixture } from "./authorization-fixtures.mjs";

const f = await createFixture();
after(() => f.close());
const { svc, ctx, resources, created, collections, domain } = f;

test("User + App read ALLOW，但缺 resource.useByAgent → Agent DENY", () => {
  const r = svc.authorize({ context: ctx("erin", "ai", { agentSessionId: "ags_alpha" }), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  assert.equal(r.decision, "DENY");
  assert.equal(r.reasonCode, "AGENT_USE_NOT_AUTHORIZED");
});

test("grant resource.useByAgent 后，其他权限同时满足 → Agent ALLOW", () => {
  const g = svc.grantResourcePermission({ context: f.adminCtx, principalType: "USER", principalId: created.erin, collectionId: collections.design.id, actions: ["resource.useByAgent"] });
  assert.equal(g.ok, true);
  const r = svc.authorize({ context: ctx("erin", "ai", { agentSessionId: "ags_alpha" }), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  assert.equal(r.decision, "ALLOW");
});

test("Agent 不能借 App 提权：User 无权 → Agent DENY", () => {
  const r = svc.authorize({ context: ctx("alice", "ai", { agentSessionId: "ags_beta" }), action: domain.ACTION.READ, resource: resources.deptBImage.resourceId });
  assert.equal(r.decision, "DENY");
  assert.equal(r.reasonCode, "DEPARTMENT_DENIED");
});

test("App 不能借 Agent 提权：App 无权 → Agent DENY", () => {
  const r = svc.authorize({ context: ctx("erin", "browser", { agentSessionId: "ags_gamma" }), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  assert.equal(r.decision, "DENY");
  assert.equal(r.reasonCode, "APP_ACTION_NOT_GRANTED");
});

test("manual source 与 agent source 对相同 context 决策完全一致（source 只进审计）", () => {
  const manual = svc.authorize({ context: ctx("erin", "ai", { source: "manual" }), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  const agentSource = svc.authorize({ context: ctx("erin", "ai", { source: "agent" }), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  assert.equal(manual.decision, agentSource.decision);
  assert.equal(manual.reasonCode, agentSource.reasonCode);
});

test("相同 agentSessionId 下，多动作决策仍然逐动作判定", () => {
  const read = svc.authorize({ context: ctx("erin", "ai", { agentSessionId: "ags_delta" }), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
  const del = svc.authorize({ context: ctx("erin", "ai", { agentSessionId: "ags_delta" }), action: domain.ACTION.DELETE, resource: resources.designHero.resourceId });
  assert.equal(read.decision, "ALLOW");
  assert.equal(del.decision, "DENY");
});
