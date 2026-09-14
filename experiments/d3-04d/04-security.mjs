/** D3-04D 探针 04 · 治理安全：洗白 / 枚举 / 停用 / Memory 管理≠自动读。 */
import { Probe, createResourceFixture } from "./lib.mjs";
const p = new Probe("04-security", "Privilege laundering / Enumeration / Disabled / Memory admin-read");
const f = await createResourceFixture();
const admin = f.adminCtx();
try {
  const alice = f.ctx("alice");
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "SecProbe", content: "sec probe token" });
  f.authService.grantResourcePermission({ context: alice, principalType: "USER", principalId: f.users.dana, resourceId: r.resource.resourceId, permissionSet: "VIEWER" });
  f.governanceService.grantAppAccess({ context: admin, appId: "photoshop", resourceId: r.resource.resourceId, actions: ["resource.read", "resource.view", "resource.search"] });
  const agentPs = { sessionRef: f.sessions.dana, appId: "photoshop", agentSessionId: "ags" };
  p.assert("AI 无 useByAgent：VIEWER + App read 仍 DENY", f.authService.authorize({ context: agentPs, action: "resource.read", resource: r.resource.resourceId }).decision === "DENY", "");
  const mem = await f.resourceService.createResource({ context: alice, resourceType: "memory", name: "AdminMemory", content: "adminmem", memorySubtype: "project-memory" });
  p.assert("Super Admin 内容读取 DENY（管理 ≠ 自动读）", f.authService.authorize({ context: admin, action: "resource.read", resource: mem.resource.resourceId }).decision === "DENY", "");
  p.assert("Super Admin 仍可治理访问说明", f.governanceService.listResourceAccess({ context: admin, resourceRef: mem.resource.resourceId }).ok === true, "");
  p.assert("猜 ResourceRef：preview DENY", (await f.previewService.preview({ context: f.ctx("bob"), resourceRef: mem.resource.resourceId })).error === "NOT_FOUND_OR_FORBIDDEN", "");
  const created = await f.governanceService.createUser({ context: admin, identifier: "secp@openarc.test", password: "secp-password-1", displayName: "SECP" });
  const login = await f.identity.login({ identifier: "secp@openarc.test", password: "secp-password-1" });
  const ctx = { sessionRef: login.session.ref, appId: "resource-library" };
  assertOk(p, "停用前可创建资源", (await f.resourceService.createResource({ context: ctx, resourceType: "text", name: "Before", content: "x" })).ok === true);
  f.governanceService.setUserStatus({ context: admin, userId: created.userId, status: "DISABLED" });
  p.assert("停用后下一请求立即 DENY", (await f.resourceService.createResource({ context: ctx, resourceType: "text", name: "After", content: "x" })).ok === false, "");
} finally { f.close(); }
function assertOk(probe, name, cond) { probe.assert(name, cond, ""); }
p.finish();
if (p.verdict() === "FAIL") process.exitCode = 1;
