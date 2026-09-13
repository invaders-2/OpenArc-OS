/**
 * D3-02 · enumeration.test
 * Anti Enumeration：无权用户猜 resourceId 不得泄漏任何 metadata（§38 §39 §70）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFixture } from "./authorization-fixtures.mjs";

const f = await createFixture();
after(() => f.close());
const { svc, ctx, resources, created, domain } = f;

test("无权用户 getResource(Secret Omega) → NOT_FOUND_OR_FORBIDDEN，零 metadata", () => {
  const res = svc.getResource({ context: ctx("alice", "resource-library"), resource: resources.omega.resourceId });
  assert.equal(res.ok, false);
  assert.equal(res.error, "NOT_FOUND_OR_FORBIDDEN");
  const json = JSON.stringify(res);
  assert.ok(!json.includes("Omega"));
  assert.ok(!json.includes("Secret"));
  assert.ok(!json.includes("ownerUserId"));
  assert.ok(!json.includes("resourceType"));
});

test("resolveResourceRef 对无权资源同样不返回 ref", () => {
  const res = svc.resolveResourceRef({ context: ctx("alice", "resource-library"), resource: resources.omega.resourceId });
  assert.equal(res.ok, false);
  assert.equal(res.resourceRef, undefined);
});

test("notificationReauthorize 只给通用提示，不泄漏原 Resource metadata", () => {
  const res = svc.notificationReauthorize({ context: ctx("alice", "resource-library"), resource: resources.omega.resourceId });
  assert.equal(res.available, false);
  assert.ok(res.message.includes("无权") || res.message.includes("不可用"));
  assert.ok(!JSON.stringify(res).includes("Omega"));
  assert.equal(res.resourceRef, null);
});

test("搜索 Omega / Secret / memory → 0 结果，不泄漏 count / title / tag", () => {
  for (const q of ["Omega", "Secret", "memory"]) {
    const res = svc.searchAuthorizedResources({ context: ctx("alice", "resource-library"), query: q });
    assert.equal(res.ok, true);
    assert.equal(res.count, 0);
    assert.deepEqual(res.items, []);
  }
});

test("内部 Audit 记录真实原因，但不写入 Resource name/path", () => {
  const audit = f.store.authorizationAudit();
  const denied = audit.find((a) => a.resource_ref === "resource://" + resources.omega.resourceId && a.decision === "DENY");
  assert.ok(denied);
  assert.ok(["DEPARTMENT_DENIED", "NOT_FOUND_OR_FORBIDDEN", "USER_ACTION_NOT_GRANTED"].includes(denied.reason_code));
  assert.ok(!audit.some((a) => JSON.stringify(a).includes("Omega")));
});

test("授权条件变化后同一 Resource 才可见（对照，证明过滤由 Policy 决定）", () => {
  // omega 是 Department B 资源。把 alice 加入 Department B 后，
  // 她通过 Department B 的 VIEWER grant 获得访问 —— 与资源名字无关。
  const add = svc.addDepartmentMember({ context: f.adminCtx, departmentId: f.depts.B.id, userId: created.alice, membershipRole: "member" });
  assert.equal(add.ok, true);
  const res = svc.getResource({ context: ctx("alice", "resource-library"), resource: resources.omega.resourceId });
  assert.equal(res.ok, true);
  assert.equal(res.resource.name, "Secret Resource Omega");
});
