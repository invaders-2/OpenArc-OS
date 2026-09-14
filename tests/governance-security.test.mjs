/** D3-04D · governance-security —— 提权 / 枚举 / stale / Renderer 边界。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const { GOVERNANCE_COMMANDS } = require("../electron/governance-bootstrap.cjs");
const { RENDERER_COMMANDS } = require("../electron/resource-bootstrap.cjs");

const f = await createResourceFixture();
after(() => f.close());
const admin = f.adminCtx();

test("特权洗白：AI 无 useByAgent 时任何 App 都读不到", async () => {
  const alice = f.ctx("alice");
  const r = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Launder", content: "launder token" });
  // dana 只有 VIEWER（可读但无 useByAgent）
  f.authService.grantResourcePermission({ context: alice, principalType: "USER", principalId: f.users.dana, resourceId: r.resource.resourceId, permissionSet: "VIEWER" });
  f.governanceService.grantAppAccess({ context: admin, appId: "photoshop", resourceId: r.resource.resourceId, actions: ["resource.read", "resource.view", "resource.search"] });
  f.governanceService.grantAppAccess({ context: admin, appId: "canvas", resourceId: r.resource.resourceId, actions: ["resource.read", "resource.view", "resource.search"] });
  const danaPs = { sessionRef: f.sessions.dana, appId: "photoshop", agentSessionId: "ags" };
  const danaCanvas = { sessionRef: f.sessions.dana, appId: "canvas", agentSessionId: "ags" };
  assert.equal(f.authService.authorize({ context: danaPs, action: "resource.read", resource: r.resource.resourceId, agent: true }).decision, "DENY");
  assert.equal(f.authService.authorize({ context: danaCanvas, action: "resource.read", resource: r.resource.resourceId, agent: true }).decision, "DENY");
  // 显式授予 useByAgent 后，在 App 同时有 read 时 AI 才可读
  f.authService.grantResourcePermission({ context: alice, principalType: "USER", principalId: f.users.dana, resourceId: r.resource.resourceId, actions: ["resource.read", "resource.view", "resource.search", "resource.useByAgent"] });
  assert.equal(f.authService.authorize({ context: danaPs, action: "resource.read", resource: r.resource.resourceId, agent: true }).decision, "ALLOW");
});

test("直接猜 ResourceRef：preview / search / picker 全部 DENY 且无存在性提示", async () => {
  const alice = f.ctx("alice");
  const r = await f.resourceService.createResource({ context: alice, resourceType: "memory", name: "Hidden", content: "hidden token", memorySubtype: "project-memory" });
  const dana = f.ctx("dana");
  assert.equal((await f.previewService.preview({ context: dana, resourceRef: r.resource.resourceId })).error, "NOT_FOUND_OR_FORBIDDEN");
  assert.equal(f.searchService.indexStatus({ context: dana, resourceRef: r.resource.resourceId }).error, "NOT_FOUND_OR_FORBIDDEN");
  assert.equal(f.pickerService.choose({ context: dana, appId: "resource-library", resourceRef: r.resource.resourceId, requestedActions: ["resource.read"] }).ok, false);
});

test("禁用用户后已打开的 Renderer 下一请求立即 DENY", async () => {
  const created = await f.governanceService.createUser({ context: admin, identifier: "sec1@openarc.test", password: "sec1-password-1", displayName: "SEC1" });
  const login = await f.identity.login({ identifier: "sec1@openarc.test", password: "sec1-password-1" });
  const ctx = { sessionRef: login.session.ref, appId: "resource-library" };
  assert.equal((await f.resourceService.createResource({ context: ctx, resourceType: "text", name: "BeforeDisable", content: "x" })).ok, true);
  f.governanceService.setUserStatus({ context: admin, userId: created.userId, status: "DISABLED" });
  assert.equal((await f.resourceService.createResource({ context: ctx, resourceType: "text", name: "AfterDisable", content: "x" })).ok, false);
  assert.equal((await f.searchService.search({ context: ctx, query: "x", limit: 5 })).ok, false);
});

test("治理 / 资源命令白名单不含 raw SQL / 凭据读取入口", () => {
  const forbidden = /rawsql|raw_acl|writegrantrow|setroleunsafe|readcredential|readinternalpath|readfile\(|writefile\(/i;
  for (const cmd of [...GOVERNANCE_COMMANDS, ...RENDERER_COMMANDS]) {
    assert.equal(forbidden.test(cmd), false, "命令名不得包含危险入口: " + cmd);
  }
  assert.ok(GOVERNANCE_COMMANDS.includes("governance/listUsers"));
  assert.ok(GOVERNANCE_COMMANDS.includes("governance/listAudit"));
  // preload 不得暴露通用 fs
  const preload = fs.readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
  assert.equal(/readFile\s*:|writeFile\s*:|readdir\s*:|rawSql\s*:/i.test(preload), false);
});
