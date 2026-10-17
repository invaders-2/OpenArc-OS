/** task-68 · 内置 AI/画布/文件/MCP 工具权限幂等播种（只补 grant，不绕过审批）。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const { seedBuiltinAppToolGrants, BUILTIN_APP_PERMISSIONS, BASELINE_POLICY_KEY } = require("../electron/builtin-app-grants.cjs");
const { createToolAuthAdapter } = require("../electron/agent-service.cjs");
const authz = require("../electron/authorization-domain.cjs");

function actionsOf(f, appId) {
  const grants = f.store.appGrantsForApp(appId, f.orgId) || [];
  const out = new Set();
  for (const grant of grants) {
    let list = grant.actions;
    if (typeof list === "string") { try { list = JSON.parse(list); } catch { list = []; } }
    for (const action of Array.isArray(list) ? list : []) out.add(String(action));
  }
  return out;
}

test("AI 内置应用补齐画布/浏览器/资源/文件/MCP/网络/音乐权限；二次播种幂等", async () => {
  const f = await createResourceFixture();
  try {
    const first = seedBuiltinAppToolGrants({ authStore: f.store, organizationId: f.orgId, grantedBy: f.users.admin });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.ok(first.changed.length >= 1);
    const ai = actionsOf(f, "ai");
    for (const expected of [
      authz.TOOL_ACTION.CANVAS_READ, authz.TOOL_ACTION.CANVAS_EDIT,
      authz.TOOL_ACTION.BROWSER_READ, authz.TOOL_ACTION.BROWSER_NAVIGATE,
      authz.TOOL_ACTION.RESOURCE_READ_METADATA, authz.TOOL_ACTION.RESOURCE_SEARCH,
      authz.TOOL_ACTION.RESOURCE_TRASH, "files.read", "files.write", "music.play", "mcp.call", "network.fetch",
    ]) assert.ok(ai.has(expected), "AI 缺权限 " + expected);
    assert.ok(actionsOf(f, "canvas").has(authz.TOOL_ACTION.CANVAS_EDIT));
    assert.ok(actionsOf(f, "browser").has(authz.TOOL_ACTION.BROWSER_NAVIGATE));
    assert.ok(actionsOf(f, "resource-library").has(authz.TOOL_ACTION.RESOURCE_TRASH));

    const auditBefore = f.identity.connection.prepare("SELECT COUNT(*) AS n FROM authorization_audit WHERE action='app.toolBaselineSeed'").get().n;
    assert.ok(Number(auditBefore) >= 1);

    const second = seedBuiltinAppToolGrants({ authStore: f.store, organizationId: f.orgId, grantedBy: f.users.admin });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.changed.length, 0, "第二次不能重复写 grant/审计");
    const auditAfter = f.identity.connection.prepare("SELECT COUNT(*) AS n FROM authorization_audit WHERE action='app.toolBaselineSeed'").get().n;
    assert.equal(auditAfter, auditBefore);
    const grantRows = f.identity.connection.prepare("SELECT COUNT(*) AS n FROM app_resource_grants WHERE organization_id=? AND app_id='ai' AND scope='TOOL' AND resource_type='tool'").get(f.orgId).n;
    assert.equal(Number(grantRows), 1, "同一 app 只能有一条 TOOL 基线行");
  } finally { f.close(); }
});

test("canUseAppPermission：画布/文件/MCP/网络返回 true；地图只给对应内置应用，不交叉提权", async () => {
  const f = await createResourceFixture();
  try {
    seedBuiltinAppToolGrants({ authStore: f.store, organizationId: f.orgId, grantedBy: f.users.admin });
    const auth = createToolAuthAdapter({ authStore: f.store, authorization: f.authService });
    const actor = { id: f.users.admin, organizationId: f.orgId, sessionRef: f.sessions.admin };
    for (const permission of [
      authz.TOOL_ACTION.CANVAS_READ, authz.TOOL_ACTION.CANVAS_EDIT,
      authz.TOOL_ACTION.BROWSER_NAVIGATE, authz.TOOL_ACTION.RESOURCE_TRASH,
      "files.read", "files.write", "music.play", "mcp.call", "network.fetch",
    ]) assert.equal(auth.canUseAppPermission(actor, permission), true, "AI 应允许 " + permission);

    const canvasAuth = createToolAuthAdapter({ authStore: f.store, authorization: f.authService });
    // 适配器固定用 HOST_APP_ID=ai 判定；这里验证未播种的 App 单独判定不会因 AI 授权而误判。
    const actorWithoutOrg = { id: "usr_nobody", organizationId: "org_nobody" };
    for (const permission of ["files.read", "mcp.call", "network.fetch"]) {
      assert.equal(canvasAuth.canUseAppPermission(actorWithoutOrg, permission), false, "无组织授权不能 false positive: " + permission);
    }
    // 只授予 canvas app 的权限不应让 ai 获得（构造反向检查：清空 ai 后 canvas 仍保留）。
    const aiGrant = (f.store.appGrantsForApp("ai", f.orgId) || []).find((g) => g.scope === "TOOL");
    if (aiGrant) f.store.revokeAppGrant(aiGrant.id, { by: f.users.admin });
    assert.equal(auth.canUseAppPermission(actor, "files.read"), false, "删除 AI 基线后必须立即拒绝");
    assert.ok(actionsOf(f, "canvas").has(authz.TOOL_ACTION.CANVAS_EDIT), "其他内置应用的授权不能被误删");
  } finally { f.close(); }
});

test("播种不创建 approval/lease，也不替用户批准受控写", async () => {
  const f = await createResourceFixture();
  try {
    seedBuiltinAppToolGrants({ authStore: f.store, organizationId: f.orgId, grantedBy: f.users.admin });
    const tables = f.identity.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tool_approvals','side_effect_calls','side_effect_leases')").all().map((row) => row.name);
    for (const table of tables) {
      const count = f.identity.connection.prepare("SELECT COUNT(*) AS n FROM " + table).get().n;
      assert.equal(Number(count), 0, table + " 不应因播种产生行");
    }
    const grant = (f.store.appGrantsForApp("ai", f.orgId) || []).find((row) => row.scope === "TOOL");
    assert.ok(grant);
    assert.equal(JSON.parse(grant.actions).includes(authz.TOOL_ACTION.CANVAS_EDIT), true);
    const provision = f.store.policyProvisionByKey({ organizationId: f.orgId, appId: "ai", policyKey: BASELINE_POLICY_KEY });
    assert.ok(provision && provision.provisioned_at != null);
  } finally { f.close(); }
});

test("撤销后不会被下一次播种重新补回（幂等墓碑）", async () => {
  const f = await createResourceFixture();
  try {
    seedBuiltinAppToolGrants({ authStore: f.store, organizationId: f.orgId, grantedBy: f.users.admin });
    const grant = (f.store.appGrantsForApp("ai", f.orgId) || []).find((row) => row.scope === "TOOL");
    assert.ok(grant);
    f.store.revokeAppGrant(grant.id, { by: f.users.admin });
    const again = seedBuiltinAppToolGrants({ authStore: f.store, organizationId: f.orgId, grantedBy: f.users.admin });
    assert.equal(again.changed.length, 0);
    const regranted = (f.store.appGrantsForApp("ai", f.orgId) || []).find((row) => row.scope === "TOOL");
    assert.equal(regranted, undefined, "已撤销的基线不能被重启/登录悄悄补回");
    assert.equal(actionsOf(f, "ai").has(authz.TOOL_ACTION.CANVAS_EDIT), false);
  } finally { f.close(); }
});
