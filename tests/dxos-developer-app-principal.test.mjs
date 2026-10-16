/**
 * X7 · 开发者 App 的 app_principals 登记与权限策略落库（全离线：真 node:sqlite + 真 KDF，无网络）。
 *
 * 背景：developer App 之前只存在于 developer-store（user_installed_apps / app_market_releases），
 * 未登记进 app_principals；saveAppPermissionPolicy 的 appById(hostApp) 校验
 * （local-account-service.cjs:977）因此对 app.<manifest.id>.* 返回 DXOS_ERR_NOT_FOUND。
 *
 * 覆盖任务书条目：
 *   ① 安装后 app_principals 出现该 App（app_id = dev-<manifest.id>、built_in = 0、publisher = openarc-developer）
 *   ② 幂等：重复 install / enable 不产生第二行
 *   ③ saveAppPermissionPolicy 对开发者声明的 app.<id>.* 落库并可经快照读回
 *   ④ 卸载语义：principal 与该 App 的 grant 同清，运行时事件保留
 *   ⑤ host App 行为不变 + 未登记 App 仍 DXOS_ERR_NOT_FOUND
 *   ⑥ 非法权限码 / 越权 / built_in 守卫仍结构化拒绝
 *
 * 只跑本文件：node --test tests/dxos-developer-app-principal.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const { AuthorizationStore } = require("../electron/authorization-store.cjs");
const { AuthorizationService } = require("../electron/authorization-service.cjs");
const { IdentityService } = require("../electron/identity-service.cjs");
const { IdentityLogger } = require("../electron/identity-log.cjs");
const { SessionSecretStore, memoryBackend } = require("../electron/session-secret-store.cjs");
const { LocalAccountService, HOST_APP_ID } = require("../electron/local-account-service.cjs");
const { createDeveloperBundle } = require("../electron/developer-service.cjs");
const { createDeveloperStore } = require("../electron/developer-store.cjs");
const { createDeveloperAppCatalogAdapter } = require("../electron/developer-domain.cjs");
const { writeZip } = require("../electron/canvas-dxos-zip.cjs");

const ADMIN_ID = "admin@openarc.test";
const ADMIN_PW = "admin-password-1";
const USER_PW = "user-password-1";
const FIXED_NOW = 1_700_000_000_000;
const dirs = [];
const stores = [];

after(() => {
  while (stores.length) { try { stores.pop().close(); } catch { /* 已关闭 */ } }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** 开发者包：manifest.id = demo → 安装 appId = dev-demo；权限码覆盖三种命名空间。 */
function buildPackage(overrides = {}) {
  const manifest = Object.assign({
    format: "dx-app/v2",
    id: "demo",
    name: "Demo App",
    description: "a demo developer application",
    version: "1.0.0",
    build: 1,
    // project.read → app.demo.project.read（developer-domain.cjs:491）
    // app.dev-demo.custom 原样保留（前缀 = 安装 appId）
    // dev.custom 无 app. 前缀，既有语义宿主是 HOST_APP_ID
    permissions: ["project.read", "app.dev-demo.custom", "dev.custom"],
  }, overrides);
  return writeZip([
    { name: "dx-app.json", data: Buffer.from(JSON.stringify(manifest)) },
    { name: "index.html", data: Buffer.from("<html><body>demo</body></html>") },
  ]).toString("base64");
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-x7-"));
  dirs.push(dir);
  const clock = () => FIXED_NOW;
  const logger = new IdentityLogger();
  const identity = new IdentityStore({ path: path.join(dir, "identity.db"), clock }).open();
  stores.push(identity);
  const authStore = new AuthorizationStore({ identity, clock });
  const authorization = new AuthorizationService({ identity, authStore });
  const secrets = new SessionSecretStore(memoryBackend());
  const identityService = new IdentityService({ store: identity, secrets, logger, allowAdmin: true });
  const svc = new LocalAccountService({ identity, authStore, authorization, identityService });
  const developer = createDeveloperBundle({
    userDataDir: dir,
    identityStore: identity,
    authorization,
    authStore,
    clock,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async () => { throw new Error("本测试不联网"); },
  });
  // 与 main.cjs 同一条晚绑定接线：developer-store → catalog adapter → local-account-service。
  const developerStore = createDeveloperStore({ db: identity.connection, dataRoot: path.join(dir, "dxos"), clock });
  svc.attachAppCatalog(createDeveloperAppCatalogAdapter({ store: developerStore }));
  return { dir, identity, authStore, authorization, identityService, svc, developer, developerStore };
}

async function bootstrapped() {
  const fx = fixture();
  const boot = await fx.svc.bootstrap({ identifier: ADMIN_ID, password: ADMIN_PW, displayName: "Admin" });
  assert.equal(boot.ok, true, "bootstrap: " + JSON.stringify(boot));
  return { ...fx, boot, ctx: { sessionRef: boot.sessionRef, appId: HOST_APP_ID, source: "ui" } };
}

const callDev = (fx, command, payload) =>
  fx.developer.execute(command, payload || {}, { sessionRef: fx.boot.sessionRef, requestId: "req-x7" });

const principalRows = (fx, appId) =>
  fx.identity.connection.prepare("SELECT * FROM app_principals WHERE app_id = ?").all(String(appId));

test("X7-01 · 安装后 app_principals 出现 dev-<manifest.id>，字段来源正确且只有一行", async () => {
  const fx = await bootstrapped();
  assert.equal(fx.developer.dependencies.authStore, true, "装配点必须把 authStore 接进 developerBundle");

  const installed = await callDev(fx, "developer/install", { package: buildPackage() });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(installed.value.appId, "dev-demo");

  const row = fx.authStore.appById("dev-demo");
  assert.ok(row, "安装后 app_principals 必须有 dev-demo");
  assert.equal(row.name, "Demo App");
  assert.equal(row.publisher, "openarc-developer");
  assert.equal(row.status, "enabled");
  assert.equal(row.built_in, 0, "开发者 App 必须 built_in = 0，内置 App 才为 1");
  assert.equal(principalRows(fx, "dev-demo").length, 1);
});

test("X7-02 · 幂等：重复安装 + enable 不产生第二行，created_at 不重建", async () => {
  const fx = await bootstrapped();
  await callDev(fx, "developer/install", { package: buildPackage() });
  const first = fx.authStore.appById("dev-demo");

  const again = await callDev(fx, "developer/install", { package: buildPackage(), allowSameVersion: true });
  assert.equal(again.ok, true, JSON.stringify(again));
  const disabled = await callDev(fx, "developer/disable", { appId: "dev-demo" });
  assert.equal(disabled.ok, true, JSON.stringify(disabled));
  const enabled = await callDev(fx, "developer/enable", { appId: "dev-demo" });
  assert.equal(enabled.ok, true, JSON.stringify(enabled));

  const rows = principalRows(fx, "dev-demo");
  assert.equal(rows.length, 1, "install / disable / enable 任一都不产生第二行");
  assert.equal(rows[0].created_at, first.created_at, "同一行：created_at 不因重复登记被重置");
  assert.equal(rows[0].status, "enabled", "disable 是每用户安装态，不得把机器级 principal 标成 disabled");
});

test("X7-03 · saveAppPermissionPolicy 对开发者 app.<id>.* 落库，并可经快照读回", async () => {
  const fx = await bootstrapped();
  await callDev(fx, "developer/install", { package: buildPackage() });

  const snap0 = fx.svc.appPermissionSnapshot({ userId: fx.boot.user.id });
  const codes = snap0.permissionManifests.flatMap((m) => m.permissions.map((p) => p.code));
  assert.ok(codes.includes("app.demo.project.read"), JSON.stringify(codes));
  assert.ok(codes.includes("app.dev-demo.custom"), JSON.stringify(codes));

  const deny = fx.svc.saveAppPermissionPolicy({
    context: fx.ctx,
    permissionCode: "app.demo.project.read",
    policy: { decision: "deny", dataScope: "self" },
  });
  assert.equal(deny.ok, true, JSON.stringify(deny));
  const allow = fx.svc.saveAppPermissionPolicy({
    context: fx.ctx,
    permissionCode: "app.dev-demo.custom",
    policy: { decision: "allow" },
  });
  assert.equal(allow.ok, true, JSON.stringify(allow));

  const snap = fx.svc.appPermissionSnapshot({ userId: fx.boot.user.id });
  assert.equal(snap.permissionPolicies["app.demo.project.read"].decision, "deny");
  assert.equal(snap.permissionPolicies["app.demo.project.read"].dataScope, "self");
  assert.equal(snap.permissionPolicies["app.dev-demo.custom"].decision, "allow");

  // 两条 grant 都落在已登记的 dev-demo 上（外键能写进去本身就是 principal 存在的证据）
  const rows = fx.authStore.allAppGrants().filter((r) => r.app_id === "dev-demo");
  assert.equal(rows.length, 2, JSON.stringify(rows.map((r) => r.resource_id)));

  // 同一次登记也让开发者 App 的"打开规则"能写进 app_resource_grants（app_id 外键指向 app_principals）
  const access = fx.svc.saveAppAccessRule({ context: fx.ctx, appId: "dev-demo", rule: { mode: "all" } });
  assert.equal(access.ok, true, JSON.stringify(access));
  assert.equal(
    fx.authStore.allAppGrants().filter((r) => r.app_id === "dev-demo" && r.resource_type === "app-access").length,
    1,
  );
});

test("X7-04 · 卸载语义：principal 与该 App 的 grant 同清，运行时事件保留", async () => {
  const fx = await bootstrapped();
  await callDev(fx, "developer/install", { package: buildPackage() });
  assert.equal(
    fx.svc.saveAppPermissionPolicy({ context: fx.ctx, permissionCode: "app.dev-demo.custom", policy: { decision: "allow" } }).ok,
    true,
  );
  assert.ok(fx.authStore.appById("dev-demo"));

  const un = await callDev(fx, "developer/uninstall", { appId: "dev-demo" });
  assert.equal(un.ok, true, JSON.stringify(un));

  assert.equal(fx.authStore.appById("dev-demo"), null, "卸载后 principal 必须消失");
  assert.equal(fx.authStore.allAppGrants().filter((r) => r.app_id === "dev-demo").length, 0, "该 App 的 grant 一并清理");
  const snap = fx.svc.appPermissionSnapshot({ userId: fx.boot.user.id });
  assert.equal(snap.permissionPolicies["app.dev-demo.custom"], undefined);

  // 审计事实不随卸载消失（源 developerApps.ts:1157-1171 语义）
  const events = fx.identity.connection
    .prepare("SELECT event_type FROM app_runtime_events WHERE app_id = 'dev-demo'")
    .all()
    .map((r) => r.event_type);
  assert.ok(events.includes("app.uninstall"), JSON.stringify(events));
});

test("X7-05 · host App 行为不变：内置 code 仍 hostApp、未登记 App 仍 NOT_FOUND、无前缀回落 HOST_APP_ID", async () => {
  const fx = await bootstrapped();
  await callDev(fx, "developer/install", { package: buildPackage() });

  // 内置 host App：既有行为原样（app.photoshop.export → photoshop）
  const ps = fx.svc.saveAppPermissionPolicy({ context: fx.ctx, permissionCode: "app.photoshop.export", policy: { decision: "allow" } });
  assert.equal(ps.ok, true, JSON.stringify(ps));
  assert.equal(fx.authStore.allAppGrants().find((r) => r.resource_id === "app.photoshop.export").app_id, "photoshop");

  // 无 app. 前缀的开发者声明：既有语义宿主是 HOST_APP_ID，未被本次解析改写
  const custom = fx.svc.saveAppPermissionPolicy({ context: fx.ctx, permissionCode: "dev.custom", policy: { decision: "allow" } });
  assert.equal(custom.ok, true, JSON.stringify(custom));
  assert.equal(fx.authStore.allAppGrants().find((r) => r.resource_id === "dev.custom").app_id, HOST_APP_ID);

  // 未登记 App：仍结构化 NOT_FOUND（校验强度未放宽）
  const ghost = fx.svc.saveAppPermissionPolicy({ context: fx.ctx, permissionCode: "app.ghost.export", policy: { decision: "allow" } });
  assert.equal(ghost.error, "DXOS_ERR_NOT_FOUND", JSON.stringify(ghost));

  // 卸载后再写同一开发者权限码：清单已随包清空，仍 NOT_FOUND
  await callDev(fx, "developer/uninstall", { appId: "dev-demo" });
  const after = fx.svc.saveAppPermissionPolicy({ context: fx.ctx, permissionCode: "app.demo.project.read", policy: { decision: "allow" } });
  assert.equal(after.error, "DXOS_ERR_NOT_FOUND", JSON.stringify(after));
});

test("X7-06 · 非法码 / 越权仍结构化拒绝；deleteApp 不删内置 principal", async () => {
  const fx = await bootstrapped();
  assert.equal(
    fx.svc.saveAppPermissionPolicy({ context: fx.ctx, permissionCode: "not-a-permission", policy: { decision: "allow" } }).error,
    "DXOS_ERR_INVALID_INPUT",
  );

  // 非超级管理员：与既有测试同一条闸门
  const created = await fx.svc.createAuthUser({ context: fx.ctx, identifier: "member@openarc.test", password: USER_PW, displayName: "M", role: "user" });
  assert.equal(created.ok, true, JSON.stringify(created));
  const login = await fx.svc.login({ identifier: "member@openarc.test", password: USER_PW });
  assert.equal(login.ok, true, JSON.stringify(login));
  const memberCtx = { sessionRef: login.sessionRef, appId: HOST_APP_ID, source: "ui" };
  assert.equal(
    fx.svc.saveAppPermissionPolicy({ context: memberCtx, permissionCode: "app.photoshop.export", policy: { decision: "allow" } }).error,
    "NOT_SUPER_ADMIN",
  );

  // built_in 守卫：卸载路径不可能删掉内置 App 的 principal
  const before = fx.authStore.appById("photoshop");
  const removed = fx.authStore.deleteApp("photoshop");
  assert.equal(removed.changed, false);
  assert.deepEqual(fx.authStore.appById("photoshop"), before);
});

test("X7-07 · 未显式传 authStore 时回落到 authorization.store（同一条写通道）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-x7-"));
  dirs.push(dir);
  const clock = () => FIXED_NOW;
  const identity = new IdentityStore({ path: path.join(dir, "identity.db"), clock }).open();
  stores.push(identity);
  const authStore = new AuthorizationStore({ identity, clock });
  // 只给 authorization.store，不给 options.authStore —— 验证回落分支真的接上。
  const authorization = {
    store: authStore,
    resolveActor: ({ context }) => (context && context.sessionRef ? { ok: true, user: { id: "u-x7" } } : { ok: false, error: "no-session" }),
  };
  const developer = createDeveloperBundle({ userDataDir: dir, identityStore: identity, authorization, clock });
  assert.equal(developer.dependencies.authStore, true, "authorization.store 必须能作为回落通道");

  const installed = await developer.execute("developer/install", { package: buildPackage() }, { sessionRef: "sess-x7" });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  const row = authStore.appById("dev-demo");
  assert.ok(row && row.built_in === 0 && row.publisher === "openarc-developer", JSON.stringify(row));
});
