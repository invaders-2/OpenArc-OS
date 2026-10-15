/**
 * B7a · 开发者平台域测试（全离线：无 Electron、无网络；DNS 与 fetch 全部注入假实现）。
 *
 * 覆盖任务书验收条目：
 *   ① 命令表 risk / credential / 中文 summary
 *   ② 清单校验：合法 / 缺字段 / 危险权限 / 危险字段 / 路径越界 / 入口不存在 / 工具声明非法 / 危险扩展名
 *   ③ 全链路：装载 → 启用 → 禁用 → 回滚 → 卸载；版本回滚后运行时状态一致
 *   ④ 出网：白名单命中 / 白名单拒绝 / 未声明白名单拒绝 / DNS 非公网拒绝 / 限流 / 审计落表
 *   ⑤ 版本拒绝：同版本（stable）/ 降级 / dataVersion 变化
 *   ⑥ 卸载保留运行时事件与网络审计（审计事实不随卸载消失）
 *
 * 只读源：server/developerApps.ts、server/developerNetwork.ts、shared/appLifecycle.ts。
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { IdentityStore } = require("../electron/identity-store.cjs");
const { writeZip } = require("../electron/canvas-dxos-zip.cjs");
const domain = require("../electron/developer-domain.cjs");
const { createDeveloperBundle } = require("../electron/developer-service.cjs");
const { createDeveloperStore } = require("../electron/developer-store.cjs");

const FIXED_NOW = 1_700_000_000_000;
const PUBLIC_DNS = async () => [{ address: "93.184.216.34", family: 4 }];

const tmpDirs = [];
const openStores = [];
afterEach(() => { while (openStores.length) { try { openStores.pop().close(); } catch { /* 已关 */ } } });
after(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function makeAuth() {
  return { resolveActor: ({ context }) => (context && context.sessionRef ? { ok: true, user: { id: "u-developer" } } : { ok: false, error: "no-session" }) };
}

function fakeFetch(body = "{\"ok\":true}", status = 200, headers = { "content-type": "application/json" }) {
  return async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (headers[String(name).toLowerCase()] == null ? null : headers[String(name).toLowerCase()]) },
    arrayBuffer: async () => Buffer.from(body, "utf8"),
  });
}

function makeManifest(overrides = {}) {
  return Object.assign({
    format: "dx-app/v2",
    id: "demo",
    name: "Demo App",
    description: "a demo developer application",
    version: "1.0.0",
    build: 1,
    permissions: ["project.read"],
  }, overrides);
}

function buildPackage(manifest = makeManifest(), extraEntries = []) {
  return writeZip([
    { name: "dx-app.json", data: Buffer.from(JSON.stringify(manifest)) },
    { name: "index.html", data: Buffer.from("<html><body>demo</body></html>") },
    ...extraEntries,
  ]);
}

function openBundle(overrides = {}) {
  const dir = tempDir("dxos-developer-");
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  openStores.push(store);
  const bundle = createDeveloperBundle(Object.assign({
    userDataDir: dir,
    identityStore: store,
    authorization: makeAuth(),
    clock: () => FIXED_NOW,
    lookup: PUBLIC_DNS,
    fetchImpl: fakeFetch(),
  }, overrides));
  return {
    dir,
    store,
    bundle,
    db: store.connection,
    call: (command, payload, ctx) => bundle.execute(command, payload || {}, Object.assign({ sessionRef: "sess-test", requestId: "req-test" }, ctx || {})),
  };
}

// ── ① 命令表 ─────────────────────────────────────────────────────────────
test("命令表：B7a 16 条 + B7b 54 条 = 70 条 developer 命令，risk / needsCredential / 中文 summary 齐全", async () => {
  const commands = domain.listDeveloperCommands();
  assert.equal(commands.length, 70);
  const allowedRisks = new Set(Object.keys(domain.RISK_LEVELS));
  for (const entry of commands) {
    assert.ok(allowedRisks.has(entry.risk), entry.command + " risk=" + entry.risk);
    assert.equal(typeof entry.needsCredential, "boolean", entry.command);
    assert.ok(entry.summary && entry.summary.length > 0, entry.command);
  }
  assert.equal(domain.isDeveloperCommand("developer/nope"), false);
  assert.equal(domain.developerCommandRisk("developer/nope"), null);
  assert.equal(domain.developerCommandRisk("developer/uninstall"), "destructive");
  assert.equal(domain.developerCommandRisk("developer/network/request"), "use");
  assert.deepEqual(
    commands.filter((entry) => entry.needsCredential).map((entry) => entry.command),
    ["developer/credential/bind", "developer/credential/list", "developer/credential/unbind", "developer/network/request"],
  );
  const fx = openBundle();
  const denied = await fx.call("developer/nope", {});
  assert.equal(denied.ok, false);
  assert.equal(denied.error, domain.DEVELOPER_ERR_COMMAND_NOT_ALLOWED);
});

test("版本语义：SemVer / build 比较 / appReleaseKey / 系统兼容（源 appLifecycle.ts 口径）", () => {
  assert.equal(domain.isValidSemver("1.2.3"), true);
  assert.equal(domain.isValidSemver("1.2"), false);
  assert.equal(domain.compareAppVersion({ version: "1.2.0", build: 1 }, { version: "1.10.0", build: 1 }), -1);
  assert.equal(domain.compareAppVersion({ version: "1.0.0", build: 2 }, { version: "1.0.0", build: 1 }), 1);
  assert.equal(domain.appReleaseKey({ version: "1.0.0", build: 3 }), "1.0.0+3");
  assert.equal(domain.systemSupportsApp("99.0.0", undefined, "0.5.5"), false);
  assert.equal(domain.systemSupportsApp("0.1.0", "99.0.0", "0.5.5"), true);
  assert.throws(() => domain.safePath("../evil.html"), (error) => error.code === domain.DEVELOPER_ERR_PATH_ESCAPE);
  assert.throws(() => domain.safePath("/etc/passwd"), (error) => error.code === domain.DEVELOPER_ERR_PATH_ESCAPE);
  assert.equal(domain.safePath("./a/b.html"), "a/b.html");
});

test("出网纯判定：白名单精确 / 通配不匹配裸域（复用 developerNetwork.ts:26-29 口径）", () => {
  assert.equal(domain.domainAllowed("api.example.com", ["api.example.com"]), true);
  assert.equal(domain.domainAllowed("example.com", ["*.example.com"]), false);
  assert.equal(domain.domainAllowed("api.example.com", ["*.example.com"]), true);
  assert.equal(domain.domainAllowed("example.com.evil.com", ["*.example.com"]), false);
  assert.equal(domain.evaluableAddressesArePublic([]).reason, "DNS_EMPTY");
  assert.equal(domain.evaluableAddressesArePublic([{ address: "10.0.0.1" }]).reason, "PRIVATE_ADDRESS");
  assert.equal(domain.evaluableAddressesArePublic([{ address: "8.8.8.8" }]).public, true);
});

test("限流器：（userId, appId）每分钟 60 次，窗口滑出后恢复", () => {
  let now = FIXED_NOW;
  const limiter = domain.createDeveloperRateLimiter({ limit: 3, windowMs: 60_000, now: () => now });
  limiter.enforce("u1", "app");
  limiter.enforce("u1", "app");
  limiter.enforce("u1", "app");
  assert.throws(() => limiter.enforce("u1", "app"), (error) => error.code === domain.DEVELOPER_ERR_RATE_LIMITED);
  assert.equal(limiter.enforce("u1", "other-app"), 1, "不同 appId 不共享配额");
  now += 61_000;
  assert.equal(limiter.enforce("u1", "app"), 1, "窗口滑出后恢复");
});

// ── ② 清单校验 ───────────────────────────────────────────────────────────
async function validate(fx, manifest, extraEntries) {
  return fx.call("developer/validate", { package: buildPackage(manifest, extraEntries).toString("base64") });
}

test("清单校验：合法包通过，入口 / 权限 / 工具被读取", async () => {
  const fx = openBundle();
  const res = await validate(fx, makeManifest({
    entry: "app/main.html",
    permissions: ["project.read", "project.write"],
    agent: { toolManifest: "agent.tools.json" },
  }), [
    { name: "app/main.html", data: Buffer.from("<html><body>entry</body></html>") },
    { name: "agent.tools.json", data: Buffer.from(JSON.stringify({ tools: [{ name: "demo_tool", title: "工具", risk: "read", handler: { type: "app-api", endpoint: "/x" } }] })) },
  ]);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.appId, "dev-demo");
  assert.equal(res.value.entry, "app/main.html");
  assert.ok(res.value.permissions.some((item) => item.includes("project.read")));
  assert.deepEqual(res.value.tools, [{ name: "demo_tool", risk: "read", handlerType: "app-api" }]);
});

test("清单校验：缺字段 / 非法版本 / 非法 build / 入口不存在全部拒绝", async () => {
  const fx = openBundle();
  const cases = [
    [{ format: undefined }, domain.DEVELOPER_ERR_MANIFEST_INVALID],
    [{ name: "x" }, domain.DEVELOPER_ERR_MANIFEST_INVALID],
    [{ description: "short" }, domain.DEVELOPER_ERR_MANIFEST_INVALID],
    [{ version: "1.2" }, domain.DEVELOPER_ERR_MANIFEST_INVALID],
    [{ build: 0 }, domain.DEVELOPER_ERR_MANIFEST_INVALID],
    [{ entry: "missing.html" }, domain.DEVELOPER_ERR_MANIFEST_INVALID],
    [{ format: "dx-app/v9" }, domain.DEVELOPER_ERR_MANIFEST_INVALID],
  ];
  for (const [override, code] of cases) {
    const res = await validate(fx, makeManifest(override));
    assert.equal(res.ok, false, JSON.stringify(override));
    assert.equal(res.error, code, JSON.stringify(override) + " → " + JSON.stringify(res));
  }
});

test("清单校验：危险权限 / 危险字段 / 恶意入口路径被拒绝（fail closed）", async () => {
  const fx = openBundle();
  const dangerousPermissions = await validate(fx, makeManifest({ permissions: ["system.exec"] }));
  assert.equal(dangerousPermissions.ok, false);
  assert.equal(dangerousPermissions.error, domain.DEVELOPER_ERR_PERMISSION_REJECTED);

  const shell = await validate(fx, makeManifest({ permissions: ["shell.exec"] }));
  assert.equal(shell.error, domain.DEVELOPER_ERR_PERMISSION_REJECTED);

  const oauth = await validate(fx, makeManifest({ oauth: [{ id: "x", authorizationUrl: "https://a/", tokenUrl: "https://b/", clientId: "c", domains: ["a"] }] }));
  assert.equal(oauth.ok, false);
  assert.equal(oauth.error, domain.DEVELOPER_ERR_MANIFEST_FIELD_REJECTED);

  const cloud = await validate(fx, makeManifest({ cloud: { room: "x" } }));
  assert.equal(cloud.error, domain.DEVELOPER_ERR_MANIFEST_FIELD_REJECTED);

  const traversal = await validate(fx, makeManifest({ entry: "../evil.html" }));
  assert.equal(traversal.ok, false);
  assert.equal(traversal.error, domain.DEVELOPER_ERR_PATH_ESCAPE);
});

test("包围栏：ZIP 内 ../ 条目与危险扩展名被拒绝", async () => {
  const fx = openBundle();
  const traversal = buildPackage(makeManifest(), [{ name: "../evil.html", data: Buffer.from("<html></html>") }]);
  const res = await fx.call("developer/validate", { package: traversal.toString("base64") });
  assert.equal(res.ok, false);
  assert.equal(res.error, domain.DEVELOPER_ERR_PATH_ESCAPE);

  const binary = buildPackage(makeManifest(), [{ name: "payload.exe", data: Buffer.from("MZ") }]);
  const denied = await fx.call("developer/validate", { package: binary.toString("base64") });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, domain.DEVELOPER_ERR_PACKAGE_INVALID);
});

test("工具声明：risk / handler.type 非法即拒绝；危险工具权限被拒绝", async () => {
  const fx = openBundle();
  const badRisk = await validate(fx, makeManifest({ agent: { toolManifest: "agent.tools.json" } }), [
    { name: "agent.tools.json", data: Buffer.from(JSON.stringify({ tools: [{ name: "demo_tool", risk: "nuke" }] })) },
  ]);
  assert.equal(badRisk.ok, false);
  assert.equal(badRisk.error, domain.DEVELOPER_ERR_MANIFEST_INVALID);

  const badHandler = await validate(fx, makeManifest({ agent: { toolManifest: "agent.tools.json" } }), [
    { name: "agent.tools.json", data: Buffer.from(JSON.stringify({ tools: [{ name: "demo_tool", handler: { type: "shell" } }] })) },
  ]);
  assert.equal(badHandler.error, domain.DEVELOPER_ERR_MANIFEST_INVALID);

  const badPermission = await validate(fx, makeManifest({ agent: { toolManifest: "agent.tools.json" } }), [
    { name: "agent.tools.json", data: Buffer.from(JSON.stringify({ tools: [{ name: "demo_tool", permission: "credential.read" }] })) },
  ]);
  assert.equal(badPermission.error, domain.DEVELOPER_ERR_PERMISSION_REJECTED);
});

// ── ③ 全链路 ─────────────────────────────────────────────────────────────
test("全链路：装载 → 启用 → 禁用 → 回滚 → 卸载；回滚后运行时状态一致", async () => {
  // 单调时钟：app_runtime_events 按 created_at 排序，同一毫秒的多条事件顺序才可判定。
  let tick = 0;
  const fx = openBundle({ clock: () => FIXED_NOW + tick++ });
  const v1 = buildPackage(makeManifest({ version: "1.0.0", build: 1 }));
  const v2 = buildPackage(makeManifest({ version: "1.1.0", build: 2 }));

  const installed = await fx.call("developer/install", { package: v1.toString("base64"), sourceName: "demo-v1.zip" });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(installed.value.appId, "dev-demo");
  assert.equal(installed.value.enabled, true);
  assert.equal(installed.value.version, "1.0.0");
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS count FROM user_app_install_state").get().count, 1);

  const upgraded = await fx.call("developer/install", { package: v2.toString("base64") });
  assert.equal(upgraded.ok, true, JSON.stringify(upgraded));
  assert.equal(upgraded.value.version, "1.1.0");
  assert.equal(upgraded.value.historyCount, 1);

  const history = await fx.call("developer/history", { appId: "dev-demo" });
  assert.equal(history.ok, true);
  assert.deepEqual(history.value.history.map((item) => item.version), ["1.0.0"]);

  const disabled = await fx.call("developer/disable", { appId: "dev-demo" });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.value.enabled, false);
  assert.equal(disabled.value.changed, true, "禁用确实改变启用状态");
  assert.equal(disabled.value.version, "1.1.0", "禁用不改变当前版本");
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS count FROM user_installed_apps").get().count, 0);

  const rolledBack = await fx.call("developer/rollback", { appId: "dev-demo" });
  assert.equal(rolledBack.ok, true, JSON.stringify(rolledBack));
  assert.equal(rolledBack.value.version, "1.0.0", "回滚切回上一版本");
  assert.equal(rolledBack.value.enabled, false, "禁用状态下回滚不自动启用");
  assert.equal(rolledBack.value.rolledBackFrom.version, "1.1.0");

  const enabled = await fx.call("developer/enable", { appId: "dev-demo" });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.value.version, "1.0.0");
  assert.equal(enabled.value.changed, true, "启用确实改变启用状态");
  const row = fx.db.prepare("SELECT installed_version AS version,installed_build AS build FROM user_installed_apps WHERE app_id='dev-demo'").get();
  assert.deepEqual({ version: row.version, build: row.build }, { version: "1.0.0", build: 1 });

  const events = fx.db.prepare("SELECT event_type AS type,version FROM app_runtime_events WHERE app_id='dev-demo' ORDER BY created_at").all();
  const types = events.map((item) => item.type);
  assert.deepEqual(types, ["app.install", "app.upgrade", "app.disable", "app.rollback", "app.enable"]);
  assert.equal(events.find((item) => item.type === "app.rollback").version, "1.0.0");

  const uninstalled = await fx.call("developer/uninstall", { appId: "dev-demo" });
  assert.equal(uninstalled.ok, true);
  assert.equal(uninstalled.value.uninstalled, true);
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS count FROM user_installed_apps").get().count, 0);
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS count FROM app_market_releases").get().count, 0);
  assert.equal(fs.existsSync(path.join(fx.dir, "dxos", "developer-apps", "packages", "dev-demo")), false);
  const after_ = await fx.call("developer/list", {});
  assert.equal(after_.value.count, 0);
  assert.ok(fx.db.prepare("SELECT COUNT(*) AS count FROM app_runtime_events").get().count >= 6, "卸载后运行时事件保留（审计事实）");
});

test("版本拒绝：stable 同版本 / 降级 / dataVersion 变化（无迁移时）", async () => {
  const fx = openBundle();
  await fx.call("developer/install", { package: buildPackage(makeManifest({ releaseChannel: "stable", version: "1.0.0", build: 1 })).toString("base64") });

  const same = await fx.call("developer/install", { package: buildPackage(makeManifest({ releaseChannel: "stable", version: "1.0.0", build: 1 })).toString("base64") });
  assert.equal(same.ok, false);
  assert.equal(same.error, domain.DEVELOPER_ERR_CONFLICT);

  const downgrade = await fx.call("developer/install", { package: buildPackage(makeManifest({ version: "0.9.0", build: 1 })).toString("base64") });
  assert.equal(downgrade.ok, false);
  assert.equal(downgrade.error, domain.DEVELOPER_ERR_CONFLICT);

  const dataChange = await fx.call("developer/install", { package: buildPackage(makeManifest({ version: "2.0.0", build: 1, dataVersion: 2 })).toString("base64") });
  assert.equal(dataChange.ok, false);
  assert.equal(dataChange.error, domain.DEVELOPER_ERR_CONFLICT);
});

test("隔离：不存在的 appId 一律结构化 NOT_FOUND，不伪造结果", async () => {
  const fx = openBundle();
  for (const command of ["developer/enable", "developer/disable", "developer/rollback", "developer/uninstall", "developer/get", "developer/history"]) {
    const res = await fx.call(command, { appId: "dev-missing" });
    assert.equal(res.ok, false, command);
    assert.equal(res.error, domain.DEVELOPER_ERR_NOT_FOUND, command);
  }
});

// ── ④ 出网 ───────────────────────────────────────────────────────────────
test("出网：白名单命中放行 + 审计落表；白名单外 / 未声明 / DNS 非公网一律拒绝", async () => {
  const fx = openBundle();
  await fx.call("developer/install", { package: buildPackage(makeManifest({ network: { domains: ["api.example.com"], methods: ["GET"] } })).toString("base64") });

  const hit = await fx.call("developer/network/evaluate", { appId: "dev-demo", url: "https://api.example.com/v1" });
  assert.equal(hit.ok, true, JSON.stringify(hit));
  assert.equal(hit.value.allowed, true);
  assert.deepEqual(hit.value.addresses, ["93.184.216.34"]);

  const outside = await fx.call("developer/network/evaluate", { appId: "dev-demo", url: "https://evil.example/v1" });
  assert.equal(outside.ok, false);
  assert.equal(outside.error, domain.DEVELOPER_ERR_NETWORK_BLOCKED);

  const request = await fx.call("developer/network/request", { appId: "dev-demo", url: "https://api.example.com/v1" });
  assert.equal(request.ok, true, JSON.stringify(request));
  assert.equal(request.value.body.ok, true);
  const audit = fx.db.prepare("SELECT method,origin,status,response_bytes AS bytes FROM app_network_audit").all();
  assert.equal(audit.length, 1);
  assert.deepEqual({ method: audit[0].method, origin: audit[0].origin, status: audit[0].status }, { method: "GET", origin: "https://api.example.com", status: 200 });
  assert.equal(JSON.stringify(request).includes(fx.dir), false, "返回值不含绝对路径");

  const noPolicy = await fx.call("developer/install", { package: buildPackage(makeManifest({ id: "nonet", version: "1.0.0", build: 1 })).toString("base64") });
  assert.equal(noPolicy.ok, true);
  const denied = await fx.call("developer/network/evaluate", { appId: "dev-nonet", url: "https://api.example.com/v1" });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, domain.DEVELOPER_ERR_NETWORK_NOT_DECLARED, "未配置白名单必须拒绝而不是放行");
});

test("出网：DNS 解析到内网 / 解析失败被拒绝（假解析器，离线）", async () => {
  const privateDns = openBundle({ lookup: async () => [{ address: "127.0.0.1", family: 4 }] });
  await privateDns.call("developer/install", { package: buildPackage(makeManifest({ network: { domains: ["api.example.com"] } })).toString("base64") });
  const evaluated = await privateDns.call("developer/network/evaluate", { appId: "dev-demo", url: "https://api.example.com/v1" });
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.value.allowed, false);
  assert.equal(evaluated.value.reason, "PRIVATE_ADDRESS");
  const requested = await privateDns.call("developer/network/request", { appId: "dev-demo", url: "https://api.example.com/v1" });
  assert.equal(requested.ok, false);
  assert.equal(requested.error, domain.DEVELOPER_ERR_NETWORK_BLOCKED);

  const dnsFail = openBundle({ lookup: async () => { throw new Error("ENOTFOUND"); } });
  await dnsFail.call("developer/install", { package: buildPackage(makeManifest({ network: { domains: ["api.example.com"] } })).toString("base64") });
  const failed = await dnsFail.call("developer/network/evaluate", { appId: "dev-demo", url: "https://api.example.com/v1" });
  assert.equal(failed.value.reason, "DNS_FAILED");
  const failedRequest = await dnsFail.call("developer/network/request", { appId: "dev-demo", url: "https://api.example.com/v1" });
  assert.equal(failedRequest.error, domain.DEVELOPER_ERR_NETWORK_BLOCKED);
});

test("出网：HTTPS / 内嵌凭据 / 端口 / 未声明方法围栏", async () => {
  const fx = openBundle();
  await fx.call("developer/install", { package: buildPackage(makeManifest({ network: { domains: ["api.example.com"], methods: ["GET"] } })).toString("base64") });
  const insecure = await fx.call("developer/network/request", { appId: "dev-demo", url: "http://api.example.com/v1" });
  assert.equal(insecure.error, domain.DEVELOPER_ERR_INVALID_INPUT);
  const embedded = await fx.call("developer/network/request", { appId: "dev-demo", url: "https://user:pass@api.example.com/v1" });
  assert.equal(embedded.error, domain.DEVELOPER_ERR_INVALID_INPUT);
  const port = await fx.call("developer/network/request", { appId: "dev-demo", url: "https://api.example.com:8443/v1" });
  assert.equal(port.error, domain.DEVELOPER_ERR_INVALID_INPUT);
  const method = await fx.call("developer/network/request", { appId: "dev-demo", url: "https://api.example.com/v1", method: "POST" });
  assert.equal(method.error, domain.DEVELOPER_ERR_FORBIDDEN);
});

test("出网限流：每分钟 60 次后第 61 次被拒绝（时钟固定）", async () => {
  const fx = openBundle();
  await fx.call("developer/install", { package: buildPackage(makeManifest({ network: { domains: ["api.example.com"] } })).toString("base64") });
  for (let index = 0; index < 60; index += 1) {
    const res = await fx.call("developer/network/request", { appId: "dev-demo", url: "https://api.example.com/v1" });
    assert.equal(res.ok, true, "第 " + (index + 1) + " 次应放行：" + JSON.stringify(res));
  }
  const limited = await fx.call("developer/network/request", { appId: "dev-demo", url: "https://api.example.com/v1" });
  assert.equal(limited.ok, false);
  assert.equal(limited.error, domain.DEVELOPER_ERR_RATE_LIMITED);
});

// ── 凭据绑定 / 运行时事件 ────────────────────────────────────────────────
test("凭据绑定：只存 provider 引用与 header 名，不存密钥；网络请求携带凭据被显式拒绝", async () => {
  const fx = openBundle();
  await fx.call("developer/install", { package: buildPackage(makeManifest({ network: { domains: ["api.example.com"] } })).toString("base64") });
  const bound = await fx.call("developer/credential/bind", { appId: "dev-demo", bindingId: "acme", providerId: "dxprov.acme", authType: "api-key-header", headerName: "X-Api-Key" });
  assert.equal(bound.ok, true, JSON.stringify(bound));
  assert.equal(bound.value.headerName, "x-api-key");
  assert.equal(JSON.stringify(bound).includes("api_key"), false);
  const row = fx.db.prepare("SELECT provider_id AS providerId,auth_type AS authType,header_name AS header FROM app_credential_bindings").get();
  assert.deepEqual({ providerId: row.providerId, authType: row.authType, header: row.header }, { providerId: "dxprov.acme", authType: "api-key-header", header: "x-api-key" });
  const listed = await fx.call("developer/credential/list", { appId: "dev-demo" });
  assert.equal(listed.value.bindings.length, 1);
  const sent = await fx.call("developer/network/request", { appId: "dev-demo", url: "https://api.example.com/v1", credentialId: "acme" });
  assert.equal(sent.ok, false);
  assert.equal(sent.error, domain.DEVELOPER_ERR_DEPENDENCY_UNAVAILABLE, "本批不装配密钥读取，显式拒绝而不是假造 Authorization");
  const unbound = await fx.call("developer/credential/unbind", { appId: "dev-demo", bindingId: "acme" });
  assert.equal(unbound.value.removed, true);
});

test("运行时事件：report 落 app_runtime_events 且 detail 中的密钥被脱敏", async () => {
  const fx = openBundle();
  await fx.call("developer/install", { package: buildPackage(makeManifest()).toString("base64") });
  const reported = await fx.call("developer/runtime/report", { appId: "dev-demo", eventType: "runtime.ready", detail: { message: "apiKey=sk-abc123456789" } });
  assert.equal(reported.ok, true, JSON.stringify(reported));
  const row = fx.db.prepare("SELECT detail FROM app_runtime_events WHERE event_type='runtime.ready'").get();
  assert.equal(row.detail.includes("sk-abc123456789"), false, "运行时事件 detail 必须脱敏");
});

test("健康：六张 v22 表全部就绪，未装配数据库时给出结构化拒绝", async () => {
  const fx = openBundle();
  const health = await fx.call("developer/health", {});
  assert.equal(health.ok, true);
  assert.equal(health.value.tablesReady, true);
  assert.deepEqual(health.value.missingTables, []);
  // B7h：commands 是"实际可达数"。直接调 bundle（未接四切片）只有 16 条基座命令；
  // 静态白名单长度仍在 declaredCommands 里可对照。
  assert.equal(health.value.commands, 16);
  assert.equal(health.value.declaredCommands, 70);
  assert.equal(health.value.extensions, null, "未装配切片时不假装知道切片状态");
  assert.equal(health.value.degraded, false);
  assert.equal(health.value.network.rateLimitPerMinute, 60);

  const dir = tempDir("dxos-developer-nodb-");
  const bare = createDeveloperBundle({ userDataDir: dir, authorization: makeAuth(), clock: () => FIXED_NOW });
  const notReady = await bare.execute("developer/list", {}, { sessionRef: "s" });
  assert.equal(notReady.ok, false);
  assert.equal(notReady.error, domain.DEVELOPER_ERR_DEPENDENCY_UNAVAILABLE);
});

test("B4e 收口 · App 目录适配器：已安装 App 进入 catalog，权限清单带标签（源 auth.ts:630-679）", async () => {
  const fx = openBundle();
  const installed = await fx.call("developer/install", { package: buildPackage(makeManifest()).toString("base64") });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  const appId = installed.value.appId;
  const store = createDeveloperStore({ db: fx.db, dataRoot: path.join(fx.dir, "dxos"), clock: () => FIXED_NOW });
  const adapter = domain.createDeveloperAppCatalogAdapter({ store });

  // 未安装该 App 的用户 / 无用户：不越权、不猜用户，返回空目录
  assert.deepEqual(adapter.listInstalledApps({ userId: "u-other" }), []);
  assert.deepEqual(adapter.listInstalledApps({}), []);

  const items = adapter.listInstalledApps({ userId: "u-developer" });
  assert.equal(items.length, 1, JSON.stringify(items));
  assert.equal(items[0].id, appId);
  assert.equal(items[0].name, "Demo App");
  assert.ok(items[0].desc.length > 0);

  const manifests = adapter.listPermissionManifests();
  assert.equal(manifests.length, 1, JSON.stringify(manifests));
  assert.equal(manifests[0].appId, appId);
  assert.equal(manifests[0].appName, "Demo App");
  const perm = manifests[0].permissions.find((item) => item.code.endsWith("project.read"));
  assert.ok(perm, JSON.stringify(manifests));
  assert.ok(perm.label && perm.description, JSON.stringify(perm));

  // 形状不符的 store：结构化拒绝，不静默降级成空目录
  assert.throws(
    () => domain.createDeveloperAppCatalogAdapter({ store: {} }),
    (error) => error.code === domain.DEVELOPER_ERR_INVALID_INPUT,
  );
});

test("Y3 · 权限清单按用户过滤：A 用户只看自己已安装的 App，不传 user 保留源全量语义（源 auth.ts:652-679）", async () => {
  // 源 auth.ts:632-634：installedIds 来自当前 userId 的已安装集合；这里按 sessionRef 区分两个用户。
  const bySession = {
    resolveActor: ({ context }) => {
      const sessionRef = context && context.sessionRef;
      if (!sessionRef) return { ok: false, error: "no-session" };
      return { ok: true, user: { id: sessionRef === "sess-b" ? "u-b" : "u-developer" } };
    },
  };
  const fx = openBundle({ authorization: bySession });
  const installedA = await fx.call("developer/install", { package: buildPackage(makeManifest()).toString("base64") });
  assert.equal(installedA.ok, true, JSON.stringify(installedA));
  const installedB = await fx.call(
    "developer/install",
    { package: buildPackage(makeManifest({ id: "second", name: "Second App" })).toString("base64") },
    { sessionRef: "sess-b" },
  );
  assert.equal(installedB.ok, true, JSON.stringify(installedB));

  const store = createDeveloperStore({ db: fx.db, dataRoot: path.join(fx.dir, "dxos"), clock: () => FIXED_NOW });
  const adapter = domain.createDeveloperAppCatalogAdapter({ store });

  // A 用户只看自己的：u-developer 装了 demo，看不到 u-b 的 second。
  assert.deepEqual(adapter.listPermissionManifests({ userId: "u-developer" }).map((m) => m.appId), ["dev-demo"]);
  assert.deepEqual(adapter.listPermissionManifests({ userId: "u-b" }).map((m) => m.appId), ["dev-second"]);
  // 没有任何安装记录的用户返回空清单，不伪造。
  assert.deepEqual(adapter.listPermissionManifests({ userId: "u-nobody" }), []);
  // 不传 user：源 auth.ts:686 未传 installedIds 的全量语义，既有契约不变。
  assert.deepEqual(adapter.listPermissionManifests().map((m) => m.appId).sort(), ["dev-demo", "dev-second"]);
  assert.deepEqual(adapter.listPermissionManifests({}).map((m) => m.appId).sort(), ["dev-demo", "dev-second"]);
});
