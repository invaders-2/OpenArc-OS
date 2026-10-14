/**
 * B7d · 厂商路径机制测试（全离线：临时目录 + 注入 env，不联网、不启动任何厂商程序）。
 *
 * 覆盖任务书验收点：
 *   ① 三种提供方式各自命中：显式注入 > 环境变量 > <userData>/dxos/vendor > <应用根>/resources/vendor；
 *   ② 全部缺失时的结构化 INTEGRATION_UNAVAILABLE，detail 必须说明放置位置；
 *   ③ 路径越界（..）与非法解析（相对路径 / 非文件 / 不存在）结构化拒绝；
 *   ④ 夸克是文件、紫鸟运行时是目录或文件，两种形状各自可用。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createQuarkIntegration, resolveQuarkCliPath, QUARK_VENDOR_HINT } = require("../electron/integration-quark.cjs");
const { createZiniaoIntegration, resolveZiniaoRuntime, ZINIAO_VENDOR_HINT } = require("../electron/integration-ziniao.cjs");

const INTEGRATION_UNAVAILABLE = "INTEGRATION_UNAVAILABLE";
const INTEGRATION_INVALID_INPUT = "INTEGRATION_INVALID_INPUT";

const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
function tempDir(prefix = "dxos-vendor-") { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(dir); return dir; }
function writeFile(file, content = "// 假厂商文件\n") { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, "utf8"); return file; }

/** 造一套"四个来源都存在"的目录，用于验证优先级。 */
function vendorFixture() {
  const root = tempDir();
  const explicit = writeFile(path.join(root, "explicit", "quark-drive.cjs"));
  const env = writeFile(path.join(root, "env", "quark-drive.cjs"));
  const userData = path.join(root, "userData");
  const userVendor = writeFile(path.join(userData, "dxos", "vendor", "quark-drive.cjs"));
  const appDir = path.join(root, "app");
  const bundled = writeFile(path.join(appDir, "resources", "vendor", "quark-drive.cjs"));
  return { root, explicit, env, userData, userVendor, appDir, bundled };
}

// ── 夸克：四级优先级 ─────────────────────────────────────────────────────
test("夸克厂商路径：显式注入 > 环境变量 > <userData>/dxos/vendor > <应用根>/resources/vendor", () => {
  const fx = vendorFixture();
  const env = { DX_QUARK_CLI_PATH: fx.env };

  const byExplicit = resolveQuarkCliPath({ cliPath: fx.explicit, env, userDataDir: fx.userData, appDir: fx.appDir });
  assert.equal(byExplicit.path, fx.explicit);
  assert.equal(byExplicit.source, "explicit");

  const byEnv = resolveQuarkCliPath({ env, userDataDir: fx.userData, appDir: fx.appDir });
  assert.equal(byEnv.path, fx.env);
  assert.equal(byEnv.source, "env:DX_QUARK_CLI_PATH");

  const byUserData = resolveQuarkCliPath({ env: {}, userDataDir: fx.userData, appDir: fx.appDir });
  assert.equal(byUserData.path, fx.userVendor);
  assert.equal(byUserData.source, "userData");

  const byBundled = resolveQuarkCliPath({ env: {}, appDir: fx.appDir });
  assert.equal(byBundled.path, fx.bundled);
  assert.equal(byBundled.source, "bundled");
});

test("夸克厂商路径：可从 <dxos>/integrations/<plugin> 形式的 dataDir 反推 <userData>/dxos", () => {
  const fx = vendorFixture();
  const dataDir = path.join(fx.userData, "dxos", "integrations", "quark");
  const resolved = resolveQuarkCliPath({ env: {}, dataDir, appDir: path.join(fx.root, "no-app") });
  assert.equal(resolved.path, fx.userVendor);
  assert.equal(resolved.source, "userData");
});

test("夸克厂商路径：越界 / 相对路径 / 非文件一律结构化拒绝", () => {
  const fx = vendorFixture();
  const dir = path.join(fx.root, "a-directory");
  fs.mkdirSync(dir, { recursive: true });

  // 用字符串拼出带 .. 的原始路径：path.join 会把 .. 归一化掉，测不到越界拒绝。
  const traversal = fx.root + path.sep + "sub" + path.sep + ".." + path.sep + "quark-drive.cjs";
  assert.throws(() => resolveQuarkCliPath({ cliPath: traversal, env: {}, appDir: fx.appDir }), (error) => error.code === INTEGRATION_INVALID_INPUT && /越界/.test(error.message));
  assert.throws(() => resolveQuarkCliPath({ cliPath: "quark-drive.cjs", env: {}, appDir: fx.appDir }), (error) => error.code === INTEGRATION_INVALID_INPUT && /绝对路径/.test(error.message));
  assert.throws(() => resolveQuarkCliPath({ cliPath: dir, env: {}, appDir: fx.appDir }), (error) => error.code === INTEGRATION_INVALID_INPUT && /不是文件/.test(error.message));
  assert.throws(() => resolveQuarkCliPath({ cliPath: path.join(fx.root, "missing.cjs"), env: {}, appDir: fx.appDir }), (error) => error.code === INTEGRATION_INVALID_INPUT && /不存在/.test(error.message));
  assert.throws(() => resolveQuarkCliPath({ env: { DX_QUARK_CLI_PATH: dir }, appDir: fx.appDir }), (error) => error.code === INTEGRATION_INVALID_INPUT && /不是文件/.test(error.message));
});

test("夸克全部缺失：结构化 INTEGRATION_UNAVAILABLE，detail 说明放置位置", async () => {
  const root = tempDir();
  const emptyApp = path.join(root, "app");
  fs.mkdirSync(emptyApp, { recursive: true });
  const integration = createQuarkIntegration({ dataDir: path.join(root, "userData", "dxos", "integrations", "quark"), appDir: emptyApp, env: {} });

  assert.equal(integration.status().cliConfigured, false);
  assert.equal(integration.status().cliSource, null);
  assert.equal(integration.cliAvailable(), false);
  assert.match(QUARK_VENDOR_HINT, /<userData>\/dxos\/vendor\/quark-drive\.cjs/);

  await assert.rejects(() => integration.quarkSearch("报表"), (error) => error.code === INTEGRATION_UNAVAILABLE && error.message.includes(QUARK_VENDOR_HINT));
  await assert.rejects(() => integration.quarkStatus(), (error) => error.code === INTEGRATION_UNAVAILABLE);
  assert.throws(() => integration.quarkStartLogin(), (error) => error.code === INTEGRATION_UNAVAILABLE && error.message.includes(QUARK_VENDOR_HINT));
});

// ── 紫鸟：四级优先级 + 运行时形状 ────────────────────────────────────────
test("紫鸟厂商运行时：显式注入 > 环境变量 > <userData>/dxos/vendor > <应用根>/resources/vendor", () => {
  const root = tempDir();
  const explicit = path.join(root, "explicit-runtime");
  const envDir = path.join(root, "env-runtime");
  const userData = path.join(root, "userData");
  const userRuntime = path.join(userData, "dxos", "vendor", "ziniao");
  const appDir = path.join(root, "app");
  const bundledRuntime = path.join(appDir, "resources", "vendor", "ziniao");
  for (const dir of [explicit, envDir, userRuntime, bundledRuntime]) fs.mkdirSync(dir, { recursive: true });

  const byExplicit = resolveZiniaoRuntime({ runtimePath: explicit, env: { DX_ZINIAO_RUNTIME: envDir }, userDataDir: userData, appDir });
  assert.equal(byExplicit.path, explicit);
  assert.equal(byExplicit.source, "explicit");

  const byEnv = resolveZiniaoRuntime({ env: { DX_ZINIAO_RUNTIME: envDir }, userDataDir: userData, appDir });
  assert.equal(byEnv.path, envDir);
  assert.equal(byEnv.source, "env:DX_ZINIAO_RUNTIME");

  const byUserData = resolveZiniaoRuntime({ env: {}, userDataDir: userData, appDir });
  assert.equal(byUserData.path, userRuntime);
  assert.equal(byUserData.source, "userData");

  const byBundled = resolveZiniaoRuntime({ env: {}, appDir });
  assert.equal(byBundled.path, bundledRuntime);
  assert.equal(byBundled.source, "bundled");
});

test("紫鸟厂商运行时：越界 / 不存在 / 非文件非目录结构化拒绝；文件与目录都可用", () => {
  const root = tempDir();
  const appDir = path.join(root, "app");
  const runtimeFile = writeFile(path.join(root, "ziniao-python"));
  const runtimeDir = path.join(root, "runtime-dir");
  fs.mkdirSync(runtimeDir, { recursive: true });

  assert.equal(resolveZiniaoRuntime({ runtimePath: runtimeDir, env: {}, appDir }).path, runtimeDir);
  assert.equal(resolveZiniaoRuntime({ runtimePath: runtimeFile, env: {}, appDir }).path, runtimeFile);
  const traversal = root + path.sep + "a" + path.sep + ".." + path.sep + "ziniao";
  assert.throws(() => resolveZiniaoRuntime({ runtimePath: traversal, env: {}, appDir }), (error) => error.code === INTEGRATION_INVALID_INPUT && /越界/.test(error.message));
  assert.throws(() => resolveZiniaoRuntime({ runtimePath: "relative-runtime", env: {}, appDir }), (error) => error.code === INTEGRATION_INVALID_INPUT && /绝对路径/.test(error.message));
  assert.throws(() => resolveZiniaoRuntime({ runtimePath: path.join(root, "missing-runtime"), env: {}, appDir }), (error) => error.code === INTEGRATION_INVALID_INPUT && /不存在/.test(error.message));
});

test("紫鸟全部缺失：requireRuntime 结构化 INTEGRATION_UNAVAILABLE，status.runtime 如实报告", () => {
  const root = tempDir();
  const appDir = path.join(root, "app");
  fs.mkdirSync(appDir, { recursive: true });
  const integration = createZiniaoIntegration({ dataDir: path.join(root, "userData", "dxos", "integrations", "ziniao"), appDir, env: {} });

  assert.deepEqual(integration.status().runtime, { configured: false, source: null, path: null, available: false });
  assert.throws(() => integration.requireRuntime(), (error) => error.code === INTEGRATION_UNAVAILABLE && error.message.includes(ZINIAO_VENDOR_HINT));
  assert.match(ZINIAO_VENDOR_HINT, /<userData>\/dxos\/vendor\/ziniao\//);

  const userData = path.join(root, "userData");
  fs.mkdirSync(path.join(userData, "dxos", "vendor", "ziniao"), { recursive: true });
  const present = createZiniaoIntegration({ dataDir: path.join(userData, "dxos", "integrations", "ziniao"), appDir, env: {} });
  assert.equal(present.status().runtime.available, true);
  assert.equal(present.status().runtime.source, "userData");
  assert.equal(present.requireRuntime().path, path.join(userData, "dxos", "vendor", "ziniao"));
});
