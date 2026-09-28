/**
 * D5-03 第二批验收 · v20 旧库构造驱动。
 *
 * 升级路径用例需要一个"**已存在的 v20 库**"，而且这个库里要有一次**真实的治理撤销** ——
 * 否则验不出"撤权在升级之后是否保持"。本驱动跑的是 **旧提交（git archive）的 electron/ 代码**，
 * 只调用旧代码自己的装配与治理 API（createIdentityService + governanceService），
 * **不写一行 SQL**：库由产品自己建，撤销走产品自己的治理入口。
 *
 * 用法：node mcp-policy-legacy-v20-driver.cjs <旧 electron/identity-bootstrap.cjs 绝对路径> <userDataDir> <identifier> <password>
 */
"use strict";

const [bootPath, userDataDir, identifier, password] = process.argv.slice(2);
if (!bootPath || !userDataDir || !identifier || !password) {
  process.stdout.write(JSON.stringify({ error: "usage: <bootstrap.cjs> <userDataDir> <identifier> <password>" }));
  process.exit(2);
}
const { createIdentityService } = require(bootPath);

(async () => {
  const svc = createIdentityService({ userDataDir, safeStorage: null, allowAdmin: true, serviceIdentity: "svc_d503b_upgrade" });
  const init = await svc.service.dispatch({ type: "identity/initialize", identifier, password, displayName: "Upgrade Admin" });
  const login = await svc.service.dispatch({ type: "identity/login", identifier, password });
  // 治理上下文与产品桥（governance-bootstrap.cjs）同形：命令不带 appId 时缺省 resource-library。
  const ctx = { sessionRef: login && login.snapshot ? login.snapshot.sessionRef : null, appId: "resource-library", source: "ui" };
  const access = svc.governanceService.getAppAccess({ context: ctx, appId: "mcp-center" });
  const grant = access && access.ok ? (access.grants || []).find((g) => g.resourceType === "mcp") : null;
  const revoke = grant ? svc.governanceService.revokeAppAccess({ context: ctx, grantId: grant.grantId }) : { ok: false, error: "NO_MCP_GRANT" };
  // 这里要的是**全表**语义：L1 证的是"这次真实撤销之后整库再没有 mcp-center 的 mcp 行"，
  // 与旁证 evidenceOf() 的整表 SQL（WHERE app_id='mcp-center'，不带 organization_id）同形。
  // 按组织取会漏掉"行落到别的组织/无主行"这种最该被这条 0 抓到的形态，故不走 appGrantsForApp。
  const mcpRowsAfterRevoke = svc.authStore.allAppGrants().filter((g) => g.app_id === "mcp-center" && g.resource_type === "mcp");
  const revokeAudit = svc.store.connection
    .prepare("SELECT id, app_id, action, old_permissions, new_permissions FROM authorization_audit WHERE action = 'governance.revokeAppPermission' ORDER BY id DESC LIMIT 3")
    .all();
  process.stdout.write(JSON.stringify({
    initOk: !!(init && init.ok),
    initError: (init && init.error) || null,
    loginOk: !!(login && login.ok),
    loginError: (login && login.error) || null,
    orgId: login && login.snapshot ? login.snapshot.teamId : null,
    seededMcpGrantId: grant ? grant.grantId : null,
    revokeOk: !!(revoke && revoke.ok),
    revokeError: (revoke && revoke.error) || null,
    mcpRowsAfterRevoke: mcpRowsAfterRevoke.length,
    revokeAudit,
  }));
  svc.store.close();
})().catch((e) => {
  process.stdout.write(JSON.stringify({ error: String((e && e.message) || e) }));
  process.exitCode = 1;
});
