/** D3-04B 探针 02 · Memory Privacy / User∩App / Capability breakdown / Revoke / Migration。 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Probe, createResourceFixture, reopenResourceRuntime, tempRoot } from "./lib.mjs";

const require = createRequire(import.meta.url);
const { IdentityStore, SCHEMA_VERSION } = require("../../electron/identity-store.cjs");
const { DatabaseSync } = require("node:sqlite");

const p = new Probe("02-authorization-isolation", "Memory Privacy / User∩App / Capability breakdown / Revoke / Migration");
const f = await createResourceFixture();
const alice = f.ctx("alice");
const dana = f.ctx("dana");
const bob = f.ctx("bob");
try {
  const mem = await f.resourceService.createResource({ context: alice, resourceType: "memory", name: "私人测试记忆", content: "top secret" });
  const ref = mem.resource.resourceId;
  p.assert("User B（同组织）get/read/inspector 全部不可见", !f.resourceService.get({ context: dana, resourceRef: ref }).ok && !(await f.resourceService.readText({ context: dana, resourceRef: ref })).ok && !f.resourceService.getInspector({ context: dana, resourceRef: ref }).ok, "");
  p.assert("跨组织 query 返回 0", f.resourceService.queryResources({ context: bob, category: "all" }).total === 0, "");

  const g = f.authService.grantResourcePermission({ context: f.adminCtx(), principalType: "USER", principalId: f.users.dana, resourceId: ref, permissionSet: "VIEWER" });
  p.assert("Grant Viewer -> resource-library 可读", g.ok && (await f.resourceService.readText({ context: dana, resourceRef: ref })).ok, "");
  p.assert("App DENY：image-generator 不能读 Memory", !(await f.resourceService.readText({ context: { ...dana, appId: "image-generator" }, resourceRef: ref })).ok, "");

  const insp = f.resourceService.getInspector({ context: dana, resourceRef: ref });
  p.assert("Capability breakdown：user/app/effective 分离", insp.ok && insp.capabilities.userActions.includes("resource.read") && insp.capabilities.appActions.includes("resource.read") && insp.capabilities.effective.canEdit === false, "");

  const agentDenied = f.authService.authorize({ context: { ...dana, appId: "resource-library", agentSessionId: "ags" }, action: "resource.read", resource: ref });
  p.assert("Agent 无 useByAgent -> DENY", agentDenied.decision === "DENY" && agentDenied.reasonCode === "AGENT_USE_NOT_AUTHORIZED", agentDenied.reasonCode);

  f.authService.revokeResourcePermission({ context: f.adminCtx(), grantId: g.grant.id });
  p.assert("Revoke -> 下一请求 DENY", !f.resourceService.getInspector({ context: dana, resourceRef: ref }).ok, "");

  f.authService.setAppStatus({ context: f.adminCtx(), appId: "resource-library", status: "disabled" });
  const reenabled = f.authService.setAppStatus({ context: f.adminCtx(), appId: "resource-library", status: "enabled" });
  p.assert("Disabled App 仍可被 Super Admin 重新启用（治理不依赖目标 App enabled）", reenabled.ok === true, JSON.stringify(reenabled).slice(0, 80));
} finally {
  f.close();
}

// migration v4 -> v5
{
  const root = tempRoot("oa-d3-04b-probe-mig");
  const dbPath = path.join(root, "identity.db");
  const storeRoot = path.join(root, "library");
  await (async () => {
    const fx = await createResourceFixture({ dbPath, storeRoot });
    const ctx = fx.ctx("alice");
    const src = fx.writeSource("legacy.txt", "legacy");
    const imp = await fx.resourceService.importManaged({ context: ctx, sourcePath: src, name: "Legacy" });
    const snapshot = { ref: imp.resource.resourceRef, users: fx.identity.allUsers().length };
    fx.identity.close();
    const raw = new DatabaseSync(dbPath);
    // D3-04C 引入 v6：降级到 v4 时必须同时移除 v6 派生表，否则重开会重复 CREATE
    for (const t of ["resource_search_fts", "resource_search_docs", "resource_index_jobs", "resource_preview_cache"]) raw.exec("DROP TABLE IF EXISTS " + t);
    for (const t of ["projects", "project_members", "project_resources", "canvas_boards", "canvas_resource_nodes"]) raw.exec("DROP TABLE IF EXISTS " + t);
    for (const t of ["resource_recent", "resource_favorites", "resource_tags", "tags"]) raw.exec("DROP TABLE IF EXISTS " + t);
    for (const col of ["memory_subtype", "language", "attributes"]) raw.exec("ALTER TABLE library_resources DROP COLUMN " + col);
    raw.exec("PRAGMA user_version = 4");
    raw.close();
    const reopened = reopenResourceRuntime({ dbPath, storeRoot });
    p.assert("v4 -> v5 升级成功，旧 Resource 可读", reopened.identity.schemaVersion === SCHEMA_VERSION && reopened.identity.allUsers().length === snapshot.users, "v" + reopened.identity.schemaVersion);
    const login = await reopened.identity.login({ identifier: "alice@openarc.test", password: "alice-password-1" });
    const read = await reopened.resourceService.readText({ context: { sessionRef: login.session.ref, appId: "resource-library" }, resourceRef: snapshot.ref });
    p.assert("迁移后 D3-04A 内容保留", read.ok && read.text === "legacy", read.error || "ok");
    reopened.identity.close();
  })();
  fs.rmSync(root, { recursive: true, force: true });
}

p.finish();
if (p.verdict() === "FAIL") process.exitCode = 1;
