/**
 * B6c · 平台域测试（全离线：无 Electron、无网络、DNS 解析器全部注入假实现）。
 *
 * 覆盖本轮验收条目：
 *   ① 命令表 risk / credential / summary（11 条）
 *   ② 网络安全：内网 / 保留 / Fake-IP 判定；域白名单精确与通配；HTTPS / 内嵌凭据 / 端口围栏；DNS 公网校验
 *   ③ 供应商测试安全：连通性提示词识别、视频计费前置、保守分辨率
 *   ④ 数据保护：快照创建 / 列表 / 校验 / 恢复往返；损坏拒绝；恢复前置（databasesClosed）；凭据目录排除
 *   ⑤ 诊断脱敏：输出不含绝对路径 / 环境变量 / 明文密钥；进程诊断只含白名单字段
 *   ⑥ 运行时事件记录 + 应用诊断（真实 IdentityStore，v25 表）
 *
 * 只读源：server/networkSafety.ts、server/developerNetwork.ts、server/providerTestSafety.ts、
 *          server/systemDataProtection.ts、server/appDiagnostics.ts、server/processDiagnostics.ts。
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { IdentityStore, SCHEMA_VERSION } = require("../electron/identity-store.cjs");
const platformDomain = require("../electron/platform-domain.cjs");
const { createPlatformBundle } = require("../electron/platform-service.cjs");

const tmpDirs = [];
const openStores = [];
afterEach(() => {
  while (openStores.length) { try { openStores.pop().close(); } catch { /* 已关 */ } }
});
after(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

const FIXED_NOW = 1_700_000_000_000;
const PUBLIC_DNS = async () => [{ address: "93.184.216.34", family: 4 }];

function makeAuth() {
  return {
    resolveActor({ context }) {
      return context && context.sessionRef ? { ok: true, user: { id: "u-platform" } } : { ok: false, error: "no-session" };
    },
  };
}

function openBundle(overrides = {}) {
  const dir = tempDir("dxos-platform-");
  const bundle = createPlatformBundle(Object.assign({
    userDataDir: dir,
    authorization: makeAuth(),
    appVersion: "9.9.9-test",
    appName: "OpenArc OS Test",
    environment: { locale: "zh-CN" },
    clock: () => FIXED_NOW,
    lookup: PUBLIC_DNS,
  }, overrides));
  return {
    dir,
    bundle,
    dxos: path.join(dir, "dxos"),
    backups: path.join(dir, "dxos", "backups"),
    call: (command, payload, ctx) => bundle.execute(command, payload || {}, Object.assign({ sessionRef: "sess-test", requestId: "req-test" }, ctx || {})),
  };
}

// ── ① 命令表 ─────────────────────────────────────────────────────────────
test("命令表：11 条，risk 合法、needsCredential 为布尔、未知命令不猜风险", () => {
  const commands = platformDomain.listPlatformCommands();
  assert.equal(commands.length, 11);
  const allowedRisks = new Set(Object.keys(platformDomain.RISK_LEVELS));
  for (const entry of commands) {
    assert.ok(allowedRisks.has(entry.risk), entry.command + " risk=" + entry.risk);
    assert.equal(typeof entry.needsCredential, "boolean", entry.command);
    assert.ok(entry.summary && entry.summary.length > 0, entry.command);
  }
  assert.equal(platformDomain.isPlatformCommand("platform/nope"), false);
  assert.equal(platformDomain.platformCommandRisk("platform/nope"), null);
  assert.equal(platformDomain.platformCommandRisk("platform/health"), "read");
  assert.equal(platformDomain.platformCommandRisk("platform/data/snapshot/restore"), "destructive");
});

// ── ② 网络安全 ───────────────────────────────────────────────────────────
test("networkSafety：内网 / 保留 / Fake-IP 判定与源逐条一致", () => {
  const privateOnes = ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1", "192.168.1.1", "192.0.2.5", "192.88.99.1", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "::1", "fc00::1", "fe80::1", "2001:db8::1", "not-an-ip"];
  for (const address of privateOnes) assert.equal(platformDomain.isPrivateNetworkAddress(address), true, address);
  for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2001:4860:4860::8888", "2606:4700:4700::1111"]) {
    assert.equal(platformDomain.isPrivateNetworkAddress(address), false, address);
  }
  assert.equal(platformDomain.isVpnSyntheticNetworkAddress("198.18.0.1"), true);
  assert.equal(platformDomain.isVpnSyntheticNetworkAddress("198.19.0.1"), true);
  assert.equal(platformDomain.isVpnSyntheticNetworkAddress("8.8.8.8"), false);
  assert.equal(platformDomain.isVpnSyntheticNetworkAddress("::1"), false);
  // IPv4-mapped IPv6 必须归一化后再判（源 networkSafety.ts:24-33）
  assert.equal(platformDomain.isPrivateNetworkAddress("::ffff:127.0.0.1"), true);
  assert.equal(platformDomain.isPrivateNetworkAddress("::ffff:8.8.8.8"), false);
});

test("domainAllowed：精确匹配 + *. 通配不匹配裸域（developerNetwork.ts:26-29 口径）", () => {
  assert.equal(platformDomain.domainAllowed("api.example.com", ["api.example.com"]), true);
  assert.equal(platformDomain.domainAllowed("API.Example.com", ["api.example.com"]), true);
  assert.equal(platformDomain.domainAllowed("evil.com", ["api.example.com"]), false);
  assert.equal(platformDomain.domainAllowed("api.example.com", ["*.example.com"]), true);
  assert.equal(platformDomain.domainAllowed("example.com", ["*.example.com"]), false);
  assert.equal(platformDomain.domainAllowed("example.com.evil.com", ["*.example.com"]), false);
  assert.equal(platformDomain.domainAllowed("api.example.com", []), false);
});

test("evaluateOutboundUrl：HTTPS / 无内嵌凭据 / 443 / 白名单围栏", () => {
  const policy = { domains: ["api.example.com", "*.trusted.example"] };
  const ok = platformDomain.evaluateOutboundUrl("https://api.example.com/v1/models", policy);
  assert.equal(ok.host, "api.example.com");
  for (const bad of ["http://api.example.com", "https://user:pass@api.example.com", "https://api.example.com:8443", "not-a-url"]) {
    assert.throws(() => platformDomain.evaluateOutboundUrl(bad, policy), (error) => error.code === platformDomain.PLATFORM_ERR_INVALID_INPUT, bad);
  }
  assert.throws(() => platformDomain.evaluateOutboundUrl("https://evil.example/", policy), (error) => error.code === platformDomain.PLATFORM_ERR_FORBIDDEN);
});

test("evaluableAddressesArePublic：空 / 内网 / 公网三种判定", () => {
  assert.equal(platformDomain.evaluableAddressesArePublic([]).reason, "DNS_EMPTY");
  assert.equal(platformDomain.evaluableAddressesArePublic([{ address: "10.0.0.1" }]).reason, "PRIVATE_ADDRESS");
  assert.equal(platformDomain.evaluableAddressesArePublic([{ address: "8.8.8.8" }]).public, true);
});

test("platform/network/evaluate：白名单命中放行、白名单拒绝、内网 DNS 拒绝（假解析器，离线）", async () => {
  const fx = openBundle();
  const hit = await fx.call("platform/network/evaluate", { url: "https://api.example.com/v1", domains: ["api.example.com"] });
  assert.equal(hit.ok, true, JSON.stringify(hit));
  assert.equal(hit.value.allowed, true);
  assert.deepEqual(hit.value.addresses, ["93.184.216.34"]);

  const deniedDomain = await fx.call("platform/network/evaluate", { url: "https://evil.example/v1", domains: ["api.example.com"] });
  assert.equal(deniedDomain.ok, false);
  assert.equal(deniedDomain.error, platformDomain.PLATFORM_ERR_FORBIDDEN);

  const privateDns = openBundle({ lookup: async () => [{ address: "127.0.0.1", family: 4 }] });
  const blocked = await privateDns.call("platform/network/evaluate", { url: "https://api.example.com/v1", domains: ["api.example.com"] });
  assert.equal(blocked.ok, true);
  assert.equal(blocked.value.allowed, false);
  assert.equal(blocked.value.reason, "PRIVATE_ADDRESS");

  const dnsFail = openBundle({ lookup: async () => { throw new Error("ENOTFOUND"); } });
  const failed = await dnsFail.call("platform/network/evaluate", { url: "https://api.example.com/v1", domains: ["api.example.com"] });
  assert.equal(failed.ok, true);
  assert.equal(failed.value.allowed, false);
  assert.equal(failed.value.reason, "DNS_FAILED");
});

// ── ③ 供应商测试安全 ─────────────────────────────────────────────────────
test("providerTestSafety：连通性提示词识别与视频计费前置", () => {
  for (const value of ["用一个词回复ok", "用一个词回答OK", "reply with one word ok", "RespondWithOneWordOk", "  replywithonewordok  "]) {
    assert.equal(platformDomain.isConnectivityProbePrompt(value), true, value);
  }
  assert.equal(platformDomain.isConnectivityProbePrompt("请画一只猫"), false);
  assert.throws(() => platformDomain.assertExplicitVideoTestPrompt(""), (error) => error.code === platformDomain.PLATFORM_ERR_INVALID_INPUT);
  assert.throws(() => platformDomain.assertExplicitVideoTestPrompt("用一个词回复ok"), (error) => error.code === platformDomain.PLATFORM_ERR_FORBIDDEN);
  assert.equal(platformDomain.assertExplicitVideoTestPrompt("  一只猫在弹钢琴  "), "一只猫在弹钢琴");
  assert.equal(platformDomain.conservativeVideoTestResolution(undefined), "480p");
  assert.equal(platformDomain.conservativeVideoTestResolution("720P"), "720p");
});

test("checkProviderTest：视频探测词阻断、文本连通性放行、providerOrigin 口径", () => {
  const videoProbe = platformDomain.checkProviderTest({ kind: "video", prompt: "用一个词回复ok", resolution: "" });
  assert.equal(videoProbe.allowed, false);
  assert.ok(videoProbe.reasons.includes("CONNECTIVITY_PROBE_BLOCKED"));
  assert.equal(videoProbe.resolution, "480p");

  const videoOk = platformDomain.checkProviderTest({ kind: "video", prompt: "一只猫在弹钢琴", resolution: "720p" });
  assert.equal(videoOk.allowed, true);
  assert.equal(videoOk.resolution, "720p");

  const textProbe = platformDomain.checkProviderTest({ kind: "text", prompt: "用一个词回复ok" });
  assert.equal(textProbe.allowed, true);

  const embedded = platformDomain.checkProviderTest({ kind: "text", providerOrigin: "https://user:pass@example.com" });
  assert.equal(embedded.allowed, false);
  assert.ok(embedded.reasons.includes("PROVIDER_ORIGIN_HAS_CREDENTIALS"));

  const insecure = platformDomain.checkProviderTest({ kind: "text", providerOrigin: "http://example.com" });
  assert.equal(insecure.allowed, false);
  assert.ok(insecure.reasons.includes("PROVIDER_ORIGIN_NOT_HTTPS"));

  const viaIpc = platformDomain.toPlatformIpcResult(() => platformDomain.checkProviderTest({ kind: "video", prompt: "用一个词回复ok" }));
  return viaIpc.then((res) => {
    assert.equal(res.ok, true);
    assert.equal(res.value.allowed, false);
  });
});

// ── ④ 数据保护 ───────────────────────────────────────────────────────────
function seedData(fx) {
  fs.writeFileSync(path.join(fx.dxos, "providers.json"), JSON.stringify({ providers: [] }), "utf8");
  fs.writeFileSync(path.join(fx.dxos, "skills.json"), JSON.stringify({ skills: [] }), "utf8");
  fs.mkdirSync(path.join(fx.dxos, "notes"), { recursive: true });
  fs.writeFileSync(path.join(fx.dxos, "notes", "a.txt"), "hello", "utf8");
}

test("数据保护：快照创建 / 列表 / 校验 / 恢复往返（恢复需 databasesClosed=true）", async () => {
  const fx = openBundle();
  seedData(fx);

  const created = await fx.call("platform/data/snapshot/create", { reason: "unit-test" });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.value.manifest.reason, "unit-test");
  assert.ok(created.value.manifest.files.some((file) => file.path === "providers.json"));
  assert.ok(created.value.fileCount >= 3);
  const id = created.value.manifest.id;

  const listed = await fx.call("platform/data/snapshot/list", {});
  assert.equal(listed.ok, true);
  assert.equal(listed.value.snapshots.length, 1);
  assert.equal(listed.value.snapshots[0].id, id);

  const verified = await fx.call("platform/data/snapshot/verify", { id });
  assert.equal(verified.ok, true);
  assert.equal(verified.value.valid, true);
  assert.deepEqual(verified.value.failures, []);

  // 改动数据 + 新增文件，恢复后必须回到快照时刻
  fs.writeFileSync(path.join(fx.dxos, "notes", "a.txt"), "changed", "utf8");
  fs.writeFileSync(path.join(fx.dxos, "extra.json"), "{}", "utf8");

  const refused = await fx.call("platform/data/snapshot/restore", { id, databasesClosed: false });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, platformDomain.PLATFORM_ERR_INVALID_INPUT);

  const restored = await fx.call("platform/data/snapshot/restore", { id, databasesClosed: true });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(fs.readFileSync(path.join(fx.dxos, "notes", "a.txt"), "utf8"), "hello");
  assert.equal(fs.existsSync(path.join(fx.dxos, "extra.json")), false, "恢复必须回退未入快照的新文件");
  assert.ok(restored.value.rollbackRelativeDir.startsWith("backups/"));
  // IPC 出口不含绝对路径
  assert.equal(JSON.stringify(created).includes(fx.dir), false);
  assert.equal(JSON.stringify(restored).includes(fx.dir), false);
});

test("数据保护：损坏快照被校验拒绝，恢复拒绝且不动当前数据", async () => {
  const fx = openBundle();
  seedData(fx);
  const created = await fx.call("platform/data/snapshot/create", { reason: "corrupt-test" });
  const id = created.value.manifest.id;
  const payload = path.join(fx.backups, id, "data", "providers.json");
  fs.writeFileSync(payload, JSON.stringify({ providers: [{ tampered: true }] }), "utf8");

  const verified = await fx.call("platform/data/snapshot/verify", { id });
  assert.equal(verified.ok, true);
  assert.equal(verified.value.valid, false);
  assert.ok(verified.value.failures.some((line) => line.includes("checksum")));

  const before = fs.readFileSync(path.join(fx.dxos, "providers.json"), "utf8");
  const restored = await fx.call("platform/data/snapshot/restore", { id, databasesClosed: true });
  assert.equal(restored.ok, false);
  assert.equal(restored.error, platformDomain.PLATFORM_ERR_INTEGRITY_FAILED);
  assert.equal(fs.readFileSync(path.join(fx.dxos, "providers.json"), "utf8"), before, "校验失败绝不能先动数据");
});

test("数据保护：快照排除 credentials 目录与 backups 自身（硬约束：不含明文密钥）", async () => {
  const fx = openBundle();
  seedData(fx);
  fs.mkdirSync(path.join(fx.dxos, "credentials"), { recursive: true });
  fs.writeFileSync(path.join(fx.dxos, "credentials", "dxprov.acme.api_key.bin"), "SUPER-SECRET-MARKER", "utf8");

  const created = await fx.call("platform/data/snapshot/create", { reason: "exclude-credentials" });
  assert.equal(created.ok, true);
  const id = created.value.manifest.id;
  assert.equal(created.value.manifest.files.some((file) => file.path.startsWith("credentials/")), false);
  assert.equal(created.value.manifest.files.some((file) => file.path.startsWith("backups/")), false);
  assert.equal(fs.existsSync(path.join(fx.backups, id, "data", "credentials")), false);
  const rawManifest = fs.readFileSync(path.join(fx.backups, id, "manifest.json"), "utf8");
  assert.equal(rawManifest.includes("SUPER-SECRET-MARKER"), false);

  const integrity = await fx.call("platform/data/integrity", {});
  assert.equal(integrity.ok, true);
  assert.equal(integrity.value.ok, true);
});

test("数据保护：完整性检查拒绝损坏 JSON", async () => {
  const fx = openBundle();
  fs.writeFileSync(path.join(fx.dxos, "providers.json"), "{ this is not json", "utf8");
  const result = await fx.call("platform/data/integrity", {});
  assert.equal(result.ok, true);
  assert.equal(result.value.ok, false);
  assert.ok(result.value.failures.some((line) => line.includes("providers.json")));
  assert.equal(result.value.dataRoot, "<userData>/dxos");
});

// ── ⑤ 诊断脱敏 ───────────────────────────────────────────────────────────
test("诊断：进程诊断不含环境变量 / 绝对路径，主进程内存与句柄齐全", async () => {
  const fx = openBundle();
  const marker = "OPENARC_B6C_DIAG_MARKER_9f2c";
  process.env.OPENARC_B6C_DIAG_SECRET = marker;
  try {
    const result = await fx.call("platform/diagnostics/process", {});
    assert.equal(result.ok, true);
    assert.equal(result.value.main.pid, process.pid);
    assert.equal(typeof result.value.main.memory.rss, "number");
    assert.equal(typeof result.value.main.handles.active, "number");
    assert.deepEqual(result.value.children, []);
    const text = JSON.stringify(result);
    assert.equal(text.includes(marker), false, "诊断输出绝不能带环境变量值");
    assert.equal(text.includes(fx.dir), false, "诊断输出绝不能带绝对路径");
    assert.equal(Object.prototype.hasOwnProperty.call(result.value.main, "env"), false);
  } finally {
    delete process.env.OPENARC_B6C_DIAG_SECRET;
  }
});

test("诊断：受监督子进程只投影白名单字段（env / executable path 被丢弃）", async () => {
  const fx = openBundle({
    processes: () => [{
      source: "runtime-supervisor",
      instanceId: "inst-1",
      status: "READY",
      startedAt: 123,
      exitCode: null,
      // 下面两个字段必须被投影层丢弃
      env: { SECRET: "leak" },
      executablePath: "/Applications/Secret.app/Contents/MacOS/x",
    }],
  });
  const result = await fx.call("platform/diagnostics/process", {});
  assert.equal(result.value.children.length, 1);
  const child = result.value.children[0];
  assert.deepEqual(Object.keys(child).sort(), ["endedAt", "exitCode", "instanceId", "memory", "pid", "role", "signal", "source", "startedAt", "status"].sort());
  const text = JSON.stringify(result);
  assert.equal(text.includes("leak"), false);
  assert.equal(text.includes("Secret.app"), false);
});

test("诊断：应用诊断只含版本 / 环境 / 数据库 / 迁移 / 存储，且无绝对路径", async () => {
  const fx = openBundle();
  seedData(fx);
  const result = await fx.call("platform/diagnostics/app", {});
  assert.equal(result.ok, true);
  assert.equal(result.value.app.version, "9.9.9-test");
  assert.equal(result.value.environment.platform, process.platform);
  assert.equal(result.value.environment.locale, "zh-CN");
  assert.equal(result.value.database.available, false);
  assert.equal(result.value.storage.available, true);
  assert.ok(result.value.storage.categories.some((category) => category.name === "providers.json"));
  assert.equal(result.value.integrity.ok, true);
  assert.equal(JSON.stringify(result).includes(fx.dir), false);
});

test("诊断：processMemorySnapshot 形状与源一致", () => {
  const snapshot = platformDomain.processMemorySnapshot("worker", "start", { workerId: "w1" }, FIXED_NOW);
  assert.equal(snapshot.role, "worker");
  assert.equal(snapshot.event, "start");
  assert.equal(snapshot.pid, process.pid);
  assert.equal(snapshot.workerId, "w1");
  assert.equal(typeof snapshot.rss, "number");
  assert.equal(snapshot.ts, new Date(FIXED_NOW).toISOString());
});

test("诊断：startDesktopParentMonitor 未配置父进程时是 no-op，父进程消失时回调一次", async () => {
  const noop = platformDomain.startDesktopParentMonitor("t", () => { throw new Error("must-not-fire"); }, { env: {} });
  noop.stop();

  let fired = 0;
  platformDomain.startDesktopParentMonitor("t", () => { fired += 1; }, {
    env: { DX_DESKTOP_PID: "424242" },
    killImpl: () => { throw new Error("ESRCH"); },
    intervalMs: 5,
    logger: () => {},
  });
  const deadline = Date.now() + 500;
  while (fired === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fired, 1);
});

// ── ⑥ 运行时事件 + 应用诊断（真实 IdentityStore） ────────────────────────
test("运行时事件：记录后可按 appId 查询，detail 中的密钥被脱敏", async () => {
  const dir = tempDir("dxos-platform-db-");
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  openStores.push(store);
  const bundle = createPlatformBundle({
    userDataDir: dir,
    identityStore: store,
    authorization: makeAuth(),
    appVersion: "9.9.9-test",
    clock: () => FIXED_NOW,
    lookup: PUBLIC_DNS,
  });
  const call = (command, payload, ctx) => bundle.execute(command, payload || {}, Object.assign({ sessionRef: "sess-test" }, ctx || {}));

  const recorded = await call("platform/diagnostics/record", { appId: "app-x", version: "1.0.0", build: 7, eventType: "runtime.ready", detail: { message: "apiKey=sk-abc123456789" } });
  assert.equal(recorded.ok, true, JSON.stringify(recorded));

  const diagnostics = await call("platform/diagnostics/app", { appId: "app-x", days: 30 });
  assert.equal(diagnostics.ok, true);
  assert.equal(diagnostics.value.runtime.summary.length, 1);
  assert.equal(diagnostics.value.runtime.summary[0].eventType, "runtime.ready");
  assert.ok(diagnostics.value.runtime.recent.length >= 1);
  const detail = diagnostics.value.runtime.recent[0].detail;
  assert.equal(detail.includes("sk-abc123456789"), false, "运行时事件 detail 必须脱敏");
  assert.equal(diagnostics.value.migrations.current, SCHEMA_VERSION);
  assert.deepEqual(diagnostics.value.migrations.pending, []);
});
