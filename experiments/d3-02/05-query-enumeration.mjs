/**
 * D3-02 探针 05 · 授权查询过滤 / Anti Enumeration / Notification 重新授权。
 */
import { Probe, createFixture } from "./lib.mjs";

const p = new Probe("05-query-enumeration", "搜索过滤 / Anti Enumeration / Notification Reauthorization");
const f = await createFixture();
const { svc, ctx, resources, created, depts, domain } = f;

try {
  const list = svc.listAuthorizedResources({ context: ctx("alice", "resource-library") });
  const ids = list.items.map((i) => i.resourceId);
  p.assert("listAuthorizedResources 只含可访问资源", ids.includes(resources.alpha.resourceId) && !ids.includes(resources.omega.resourceId) && !ids.includes(resources.memorySecret.resourceId), JSON.stringify(ids));

  for (const q of ["Omega", "Secret", "memory"]) {
    const res = svc.searchAuthorizedResources({ context: ctx("alice", "resource-library"), query: q });
    p.assert("搜索 " + q + " → 0 结果", res.count === 0 && res.items.length === 0, "count=" + res.count);
  }

  const photoDesign = svc.searchAuthorizedResources({ context: ctx("alice", "photoshop"), query: "Design" });
  const photoOrg = svc.searchAuthorizedResources({ context: ctx("alice", "photoshop"), query: "Org" });
  p.assert("App Search = User ∩ App", photoDesign.count === 1 && photoOrg.count === 0, "design=" + photoDesign.count + ", org=" + photoOrg.count);

  const guessed = svc.getResource({ context: ctx("alice", "resource-library"), resource: resources.omega.resourceId });
  p.assert("猜 resourceId → NOT_FOUND_OR_FORBIDDEN", guessed.ok === false && guessed.error === "NOT_FOUND_OR_FORBIDDEN", JSON.stringify(guessed).slice(0, 120));
  p.assert("猜 resourceId 不泄漏 metadata", !JSON.stringify(guessed).includes("Omega") && !JSON.stringify(guessed).includes("resourceType"), "");

  const note = svc.notificationReauthorize({ context: ctx("alice", "resource-library"), resource: resources.omega.resourceId });
  p.assert("notificationReauthorize 不泄漏标题", note.available === false && !JSON.stringify(note).includes("Omega"), note.message);

  const audit = f.store.authorizationAudit();
  const real = audit.find((a) => a.resource_ref === "resource://" + resources.omega.resourceId && a.decision === "DENY");
  p.assert("内部 Audit 记录真实原因且不含 name", !!real && !audit.some((a) => JSON.stringify(a).includes("Omega")), real ? real.reason_code : "missing");

  const add = svc.addDepartmentMember({ context: f.adminCtx, departmentId: depts.B.id, userId: created.alice, membershipRole: "member" });
  const nowVisible = svc.getResource({ context: ctx("alice", "resource-library"), resource: resources.omega.resourceId });
  p.assert("授权变化后同一 Resource 才可见（对照）", add.ok === true && nowVisible.ok === true && nowVisible.resource.name === "Secret Resource Omega", nowVisible.error || "visible");
} finally {
  f.close();
}

p.finish();
if (p.verdict() === "FAIL") process.exitCode = 1;
