/** D4-03 · governance-tool-grant —— App TOOL-scope 权限的产品入口（查看 / 授予 / 撤销）+ IPC 路由。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const { GOVERNANCE_COMMANDS, registerGovernanceIpc } = require("../electron/governance-bootstrap.cjs");
const { TOOL_ACTIONS } = require("../electron/authorization-domain.cjs");

const f = await createResourceFixture();
after(() => f.close());
const admin = f.adminCtx();
const APP = "ai";

test("治理 IPC 白名单显式登记 TOOL-scope 命令", () => {
  for (const c of ["governance/getAppToolAccess", "governance/grantAppToolAccess", "governance/revokeAppToolAccess"]) {
    assert.ok(GOVERNANCE_COMMANDS.includes(c), "缺少命令 " + c);
  }
});

test("ADMIN 可查看可授予范围；初始未授予任何工具权限", () => {
  const view = f.governanceService.getAppToolAccess({ context: admin, appId: APP });
  assert.equal(view.ok, true);
  assert.equal(view.app.appId, APP);
  assert.deepEqual(view.availableActions, [...TOOL_ACTIONS]);
  assert.deepEqual(view.grants, []);
  assert.deepEqual(view.grantedActions, []);
});

test("ADMIN 授予后 getAppToolAccess 可见，可执行侧同步放行", () => {
  const grant = f.governanceService.grantAppToolAccess({ context: admin, appId: APP, actions: ["tool.resource.search", "tool.resource.readMetadata"] });
  assert.equal(grant.ok, true);
  assert.equal(grant.scope, "TOOL");
  const view = f.governanceService.getAppToolAccess({ context: admin, appId: APP });
  assert.equal(view.grants.length, 1);
  assert.deepEqual([...view.grants[0].actions].sort(), [...grant.actions].sort());
  const d = f.authService.authorizeTool({ context: { sessionRef: f.sessions.admin, appId: APP }, action: "tool.resource.search" });
  assert.equal(d.decision, "ALLOW");
});

test("再次授予是并集：不覆盖既有动作、不产生第二条 grant", () => {
  const grant = f.governanceService.grantAppToolAccess({ context: admin, appId: APP, actions: ["tool.test.echo"] });
  assert.equal(grant.ok, true);
  const view = f.governanceService.getAppToolAccess({ context: admin, appId: APP });
  assert.equal(view.grants.length, 1);
  assert.deepEqual([...view.grantedActions].sort(), ["tool.resource.readMetadata", "tool.resource.search", "tool.test.echo"]);
});

test("ADMIN 按 grantId 撤销后消失，可执行侧重新 DENY", () => {
  const view = f.governanceService.getAppToolAccess({ context: admin, appId: APP });
  const rev = f.governanceService.revokeAppToolAccess({ context: admin, grantId: view.grants[0].grantId });
  assert.equal(rev.ok, true);
  assert.equal(rev.changed, true);
  const after2 = f.governanceService.getAppToolAccess({ context: admin, appId: APP });
  assert.deepEqual(after2.grants, []);
  assert.deepEqual(after2.grantedActions, []);
  const d = f.authService.authorizeTool({ context: { sessionRef: f.sessions.admin, appId: APP }, action: "tool.resource.search" });
  assert.equal(d.decision, "DENY");
  assert.equal(f.governanceService.revokeAppToolAccess({ context: admin, grantId: "GRANT_missing" }).ok, false);
});

test("旧 grantAppAccess 对 tool.* 仍 INVALID_INPUT（入口分离，未放宽资源授权）", () => {
  const res = f.governanceService.grantAppAccess({ context: admin, appId: APP, actions: ["tool.resource.search"] });
  assert.equal(res.ok, false);
  assert.equal(res.error, "INVALID_INPUT");
  const mixed = f.governanceService.grantAppAccess({ context: admin, appId: APP, actions: ["resource.read", "tool.resource.search"] });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.error, "INVALID_INPUT");
  assert.deepEqual(f.governanceService.getAppToolAccess({ context: admin, appId: APP }).grants, []);
});

test("空 / 未知 / 混合 resource 动作被拒，且不产生隐式 grant", () => {
  for (const actions of [[], null, undefined, [""], ["tool.nope"], ["resource.read", "tool.resource.search"], ["tool.resource.search", "resource.read"]]) {
    const res = f.governanceService.grantAppToolAccess({ context: admin, appId: APP, actions });
    assert.equal(res.ok, false, "应拒绝: " + JSON.stringify(actions));
    assert.equal(res.error, "INVALID_INPUT");
  }
  const view = f.governanceService.getAppToolAccess({ context: admin, appId: APP });
  assert.deepEqual(view.grants, []);
  assert.deepEqual(view.grantedActions, []);
});

test("MEMBER 会话调用 view / grant / revoke 一律被拒", () => {
  const alice = f.ctx("alice");
  assert.equal(f.governanceService.getAppToolAccess({ context: alice, appId: APP }).ok, false);
  assert.equal(f.governanceService.grantAppToolAccess({ context: alice, appId: APP, actions: ["tool.resource.search"] }).ok, false);
  const made = f.governanceService.grantAppToolAccess({ context: admin, appId: APP, actions: ["tool.resource.search"] });
  assert.equal(made.ok, true);
  assert.equal(f.governanceService.revokeAppToolAccess({ context: alice, grantId: made.grantId }).ok, false);
  assert.equal(f.governanceService.getAppToolAccess({ context: admin, appId: APP }).grants.length, 1);
  assert.equal(f.governanceService.revokeAppToolAccess({ context: admin, grantId: made.grantId }).ok, true);
});

test("部门管理员不是全局 ADMIN：TOOL 授予 / 撤销仍被拒", () => {
  const dana = f.ctx("dana");
  const made = f.governanceService.grantAppToolAccess({ context: admin, appId: APP, actions: ["tool.resource.search"] });
  assert.equal(made.ok, true);
  assert.equal(f.governanceService.grantAppToolAccess({ context: dana, appId: APP, actions: ["tool.test.echo"] }).ok, false);
  assert.equal(f.governanceService.revokeAppToolAccess({ context: dana, grantId: made.grantId }).ok, false);
  assert.equal(f.governanceService.revokeAppToolAccess({ context: admin, grantId: made.grantId }).ok, true);
});

test("revokeAppToolAccess 绝不误撤 resource-scope grant", async () => {
  const alice = f.ctx("alice");
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "ToolGuard", content: "x" });
  const resGrant = f.governanceService.grantAppAccess({ context: admin, appId: APP, resourceId: r.resource.resourceId, actions: ["resource.read"] });
  assert.equal(resGrant.ok, true);
  const denied = f.governanceService.revokeAppToolAccess({ context: admin, grantId: resGrant.grant.id });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "NOT_FOUND_OR_FORBIDDEN");
  assert.ok(f.governanceService.getAppAccess({ context: admin, appId: APP }).grants.some((g) => g.grantId === resGrant.grant.id));
});

test("授予 / 撤销产生 authorization_audit 记录", () => {
  const before = f.store.authorizationAudit().length;
  const grant = f.governanceService.grantAppToolAccess({ context: admin, appId: APP, actions: ["tool.test.echo"] });
  assert.equal(grant.ok, true);
  const audit = f.store.authorizationAudit();
  assert.ok(audit.length > before);
  assert.ok(audit.some((a) => a.action === "tool.grant" && a.decision === "ALLOW" && a.app_id === APP));
  const beforeRevoke = f.store.authorizationAudit().length;
  assert.equal(f.governanceService.revokeAppToolAccess({ context: admin, grantId: grant.grantId }).ok, true);
  const afterRevoke = f.store.authorizationAudit();
  assert.ok(afterRevoke.length > beforeRevoke);
  assert.ok(afterRevoke.slice(beforeRevoke).some((a) => a.action === "governance.revokeAppPermission" && a.decision === "ALLOW"));
});

test("governance:command 路由：sessionRef 由主进程注入，ADMIN 成功 / MEMBER 被拒", async () => {
  let handler = null;
  const ipcMain = { handle: (channel, fn) => { if (channel === "governance:command") handler = fn; } };
  const identity = { current: f.sessions.admin };
  registerGovernanceIpc({ ipcMain, service: f.governanceService, authorization: f.authService, identity, isTrusted: () => true });
  assert.equal(typeof handler, "function");
  const call = (command) => handler({}, command);

  assert.equal((await call({ type: "governance/getAppToolAccess", appId: APP })).ok, true);
  const grant = await call({ type: "governance/grantAppToolAccess", appId: APP, actions: ["tool.resource.trash"] });
  assert.equal(grant.ok, true);
  assert.ok((await call({ type: "governance/getAppToolAccess", appId: APP })).grantedActions.includes("tool.resource.trash"));
  assert.equal((await call({ type: "governance/revokeAppToolAccess", grantId: grant.grantId })).ok, true);
  assert.equal((await call({ type: "governance/rawSql" })).error, "INVALID_INPUT");

  identity.current = f.sessions.alice;
  const memberView = await call({ type: "governance/getAppToolAccess", appId: APP, role: "ADMIN", sessionRef: f.sessions.admin });
  assert.equal(memberView.ok, false);
  const memberGrant = await call({ type: "governance/grantAppToolAccess", appId: APP, actions: ["tool.resource.search"], role: "ADMIN" });
  assert.equal(memberGrant.ok, false);
  const memberRevoke = await call({ type: "governance/revokeAppToolAccess", grantId: "GRANT_any", role: "ADMIN" });
  assert.equal(memberRevoke.ok, false);
});
