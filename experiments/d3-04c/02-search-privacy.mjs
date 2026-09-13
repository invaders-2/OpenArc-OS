/** D3-04C 探针 02 · 搜索零泄漏：无权资源 0 结果，且不泄漏 total/highlight/tag/owner/existence。 */
import { Probe, createResourceFixture, pw } from "./lib.mjs";

const p = new Probe("02-search-privacy", "Authorized Search 零泄漏 / ACL-aware total / 跨组织 / 部门边界");
const f = await createResourceFixture();
const alice = f.ctx("alice");
const dana = f.ctx("dana");
const bob = f.ctx("bob");
const admin = f.adminCtx();
try {
  // alice 私有 Memory
  const secret = await f.resourceService.createResource({ context: alice, resourceType: "memory", name: "Omega秘密计划", content: "TopSecretBody 绝密计划", memorySubtype: "project-memory" });
  // 部门 B 资源（admin 创建到 Department B，仅授予 Dept B 成员 erin）
  const deptB = f.authService.createDepartment({ context: admin, name: "Dept B" });
  const erinCreated = await f.identity.createUser({ identifier: "erin@openarc.test", password: pw("erin"), displayName: "erin", teamId: f.orgId });
  f.authService.addDepartmentMember({ context: admin, departmentId: deptB.department.id, userId: erinCreated.userId, membershipRole: "member" });
  const deptRes = f.authService.registerResource({ context: admin, resourceType: "text", scope: "DEPARTMENT", departmentId: deptB.department.id, name: "部门B专案", description: "部门B机密", tags: ["部门B"] });
  const grantB = f.authService.grantResourcePermission({ context: admin, principalType: "DEPARTMENT", principalId: deptB.department.id, resourceId: deptRes.resource.resourceId, permissionSet: "VIEWER" });
  const erinLogin = await f.identity.login({ identifier: "erin@openarc.test", password: pw("erin") });
  const erin = { sessionRef: erinLogin.session.ref, appId: "resource-library", source: "ui" };
  p.assert("准备：私有 Memory + 部门 B 资源创建成功", secret.ok && deptRes.ok && grantB.ok && erinCreated.ok, "");
  const erinFind = await f.searchService.search({ context: erin, query: "部门B", limit: 10 });
  p.assert("Dept B 成员 erin 可搜到部门 B 资源（授权存在）", erinFind.ok && erinFind.total === 1, "total=" + erinFind.total);

  // 授权者 alice 本人可搜到
  const own = await f.searchService.search({ context: alice, query: "Omega", limit: 10 });
  p.assert("owner 可搜到自己的 Memory", own.ok && own.total === 1, "total=" + own.total);

  // 无权用户 dana / bob 全部 0，且响应不含任何提示
  for (const [who, ctx] of [["dana", dana], ["bob", bob]]) {
    for (const q of ["Omega", "TopSecretBody", "绝密计划", "部门B", "机密", "project"]) {
      const r = await f.searchService.search({ context: ctx, query: q, limit: 10 });
      // 去掉回显的 query，检查是否夹带任何未授权资源名 / 正文 / ref
      const json = JSON.stringify({ ...r, query: undefined });
      const leak = ["Omega秘密计划", "TopSecretBody", "绝密计划", "部门B专案", "部门B机密", "resource://"].some((s) => json.includes(s));
      p.assert(who + " 搜「" + q + "」= 0 且无泄漏", r.ok && r.total === 0 && r.items.length === 0 && !leak, leak ? "LEAK" : "ok");
    }
  }

  // 猜 resourceId 也不泄漏
  const get = f.resourceService.get({ context: dana, resourceRef: secret.resource.resourceId });
  const insp = f.resourceService.getInspector({ context: dana, resourceRef: secret.resource.resourceId });
  const idx = f.searchService.indexStatus({ context: dana, resourceRef: secret.resource.resourceId });
  const pv = await f.previewService.preview({ context: dana, resourceRef: secret.resource.resourceId });
  p.assert("猜 ID：get / inspector / indexStatus / preview 全部 NOT_FOUND_OR_FORBIDDEN", !get.ok && !insp.ok && !idx.ok && !pv.ok, "");
  p.assert("错误只收敛为 NOT_FOUND_OR_FORBIDDEN，不区分存在性", get.error === "NOT_FOUND_OR_FORBIDDEN" && pv.error === "NOT_FOUND_OR_FORBIDDEN", get.error + "/" + pv.error);

  // 显式 Viewer 分享后 dana 可搜到
  const viewerGrant = f.authService.grantResourcePermission({ context: admin, principalType: "USER", principalId: f.users.dana, resourceId: secret.resource.resourceId, permissionSet: "VIEWER" });
  const shared = await f.searchService.search({ context: dana, query: "TopSecretBody", limit: 10 });
  p.assert("显式 Viewer 分享后可搜到", viewerGrant.ok && shared.ok && shared.total === 1, "total=" + shared.total);
  // 撤销后立即 0
  f.authService.revokeResourcePermission({ context: admin, grantId: viewerGrant.grant.id });
  const revoked = await f.searchService.search({ context: dana, query: "TopSecretBody", limit: 10 });
  p.assert("撤销后下一请求立即 0", revoked.total === 0, "total=" + revoked.total);
} finally {
  f.close();
}
p.finish();
if (p.verdict() === "FAIL") process.exitCode = 1;
