/**
 * D3-02 探针 02 · User ∩ App 权限交集 / Memory 保护 / App 状态与撤销。
 */
import { Probe, createFixture } from "./lib.mjs";

const p = new Probe("02-app-authorization", "User ∩ App 权限交集 / Memory 保护 / Disabled App / Revoke");
const f = await createFixture();
const { svc, ctx, resources, domain } = f;
const ALLOW = (r) => r.decision === "ALLOW";

try {
  let r = svc.authorize({ context: ctx("alice", "image-generator"), action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  p.assert("User ALLOW + App DENY → DENY", !ALLOW(r) && r.reasonCode === "APP_ACTION_NOT_GRANTED", r.reasonCode);

  r = svc.authorize({ context: ctx("erin", "image-generator"), action: domain.ACTION.READ, resource: resources.deptBImage.resourceId });
  p.assert("User DENY + App ALLOW → DENY", !ALLOW(r), r.reasonCode);

  const g = svc.grantAppResourcePermission({ context: f.adminCtx, appId: "image-generator", resourceId: resources.alpha.resourceId, actions: ["resource.read", "resource.view", "resource.preview"] });
  r = svc.authorize({ context: ctx("alice", "image-generator"), action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  p.assert("User ALLOW + App ALLOW → ALLOW", ALLOW(r), r.reasonCode);

  svc.revokeAppResourcePermission({ context: f.adminCtx, grantId: g.grant.id });
  r = svc.authorize({ context: ctx("alice", "image-generator"), action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  p.assert("App revoke → 下一请求立即 DENY", !ALLOW(r), r.reasonCode);

  r = svc.authorize({ context: ctx("bob", "image-generator"), action: domain.ACTION.READ, resource: resources.memorySecret.resourceId });
  p.assert("App Image only → Memory read DENY", !ALLOW(r), r.reasonCode);

  svc.grantAppResourcePermission({ context: f.adminCtx, appId: "image-generator", actions: ["resource.read", "resource.view"] });
  r = svc.authorize({ context: ctx("bob", "image-generator"), action: domain.ACTION.READ, resource: resources.memorySecret.resourceId });
  p.assert("全局 App grant 不覆盖 memory → 仍 DENY", !ALLOW(r), r.reasonCode);

  svc.setAppStatus({ context: f.adminCtx, appId: "image-generator", status: "disabled" });
  r = svc.authorize({ context: ctx("bob", "resource-library"), action: domain.ACTION.READ, resource: resources.memorySecret.resourceId });
  p.assert("built-in resource-library 仍可用（只禁用了 image-generator）", ALLOW(r), r.reasonCode);
  r = svc.authorize({ context: ctx("alice", "image-generator"), action: domain.ACTION.READ, resource: resources.alpha.resourceId });
  p.assert("disabled App → DENY APP_DISABLED", !ALLOW(r) && r.reasonCode === "APP_DISABLED", r.reasonCode);
  svc.setAppStatus({ context: f.adminCtx, appId: "image-generator", status: "enabled" });

  const up = svc.evaluateAppPermissionUpgrade({ currentActions: ["resource.read"], requestedActions: ["resource.read", "resource.delete"] });
  p.assert("App read → read+delete 必须重新批准", up.requiresReapproval === true && up.added.includes("resource.delete"), JSON.stringify(up.added));
} finally {
  f.close();
}

p.finish();
if (p.verdict() === "FAIL") process.exitCode = 1;
