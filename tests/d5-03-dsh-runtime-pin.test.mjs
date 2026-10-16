/**
 * D5-03 · dsh 运行时 PIN 契约。
 *
 * 只认项目本地安装（精确 0.1.5-rc.2）：默认解析 = 仓库根；OPENARC_DSH_RUNTIME / OPENARC_DSH_BIN
 * 显式覆盖同样必须校验，任何不符一律抛稳定错误码，绝不回退到 DSH Desktop 共享运行时、用户 PATH
 * 或任何未知版本。ACP SDK 只认项目内那一份（1.4.0）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "..");
const { resolveDshRuntime, resolveDshBin, resolveAcpSdk, dshVersion } = require("../electron/harness-adapter.cjs");

const PINNED_DSH = "0.1.5-rc.2";
const PINNED_SDK = "1.4.0";
const SHARED_RUNTIME = path.join(os.homedir(), "Library", "Application Support", "DSH Desktop", "runtime");
const PROJECT_DSH_PKG = path.join(ROOT, "node_modules", "@deepseek-ai", "dsh", "package.json");
const PROJECT_BIN = path.join(ROOT, "node_modules", ".bin", "dsh");

const saved = { OPENARC_DSH_RUNTIME: process.env.OPENARC_DSH_RUNTIME, OPENARC_DSH_BIN: process.env.OPENARC_DSH_BIN };
after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

/** 只保留抛错/返回值本身，便于断言"要么抛错、要么返回这个值"，绝不吞掉失败。 */
function capture(fn) {
  try { return { threw: false, value: fn() }; }
  catch (e) { return { threw: true, value: undefined, code: e && e.code ? e.code : null, message: String((e && e.message) || e) }; }
}
/** 造一个声明了任意版本的假 dsh 运行时（只用于覆盖校验，不参与真实链路）。 */
function fakeRuntime(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d5-03-rt-"));
  const pkgDir = path.join(dir, "node_modules", "@deepseek-ai", "dsh");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version }));
  return dir;
}
function tempDir(prefix = "oa-d5-03-tmp-") { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function cleanup(...dirs) { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }

test("D5-03-A · 默认解析 = 项目本地运行时根，dsh 版本 PIN 0.1.5-rc.2，bin 落在项目内", () => {
  delete process.env.OPENARC_DSH_RUNTIME;
  delete process.env.OPENARC_DSH_BIN;

  const runtime = resolveDshRuntime();
  assert.equal(runtime, ROOT, "默认运行时根必须是仓库根（node_modules/@deepseek-ai/dsh 所在处）");
  assert.equal(runtime, path.resolve(import.meta.dirname, ".."));
  assert.equal(dshVersion(), PINNED_DSH);
  assert.equal(dshVersion(runtime), PINNED_DSH);

  const installed = JSON.parse(fs.readFileSync(PROJECT_DSH_PKG, "utf8"));
  assert.equal(installed.name, "@deepseek-ai/dsh");
  assert.equal(installed.version, PINNED_DSH, "项目内安装的 dsh 必须就是 PIN 版本");

  const bin = resolveDshBin();
  assert.equal(bin, PROJECT_BIN);
  assert.equal(fs.existsSync(bin), true, "node_modules/.bin/dsh 必须存在");

  // devDependency 必须是精确版本（无 ^ / ~），npm ci 才能复现同一条运行时。
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.devDependencies["@deepseek-ai/dsh"], PINNED_DSH);
  assert.equal(/[~^]/.test(pkg.devDependencies["@deepseek-ai/dsh"]), false);
});

test("D5-03-B · OPENARC_DSH_RUNTIME 指向没有 dsh 的目录 → DSH_RUNTIME_MISSING", () => {
  const empty = tempDir();
  const missing = path.join(os.tmpdir(), "oa-d5-03-does-not-exist-" + Date.now());
  try {
    for (const target of [empty, missing]) {
      process.env.OPENARC_DSH_RUNTIME = target;
      const r = capture(() => resolveDshRuntime());
      assert.equal(r.threw, true, "缺失时必须抛错，绝不返回任何路径：" + target);
      assert.equal(r.value, undefined);
      assert.equal(r.code, "DSH_RUNTIME_MISSING");
      assert.match(r.message, /DSH_RUNTIME_MISSING/);
    }
  } finally { delete process.env.OPENARC_DSH_RUNTIME; cleanup(empty); }
});

test("D5-03-C · 版本不符的运行时 → DSH_VERSION_MISMATCH，且与\"缺失\"可区分", () => {
  const wrong = fakeRuntime("9.9.9-not-the-pin");
  try {
    process.env.OPENARC_DSH_RUNTIME = wrong;
    const r = capture(() => resolveDshRuntime());
    assert.equal(r.threw, true, "版本不符必须抛错，绝不回退");
    assert.equal(r.value, undefined);
    assert.equal(r.code, "DSH_VERSION_MISMATCH");
    assert.notEqual(r.code, "DSH_RUNTIME_MISSING", "版本不符与缺失必须是两个可区分的错误码");
    assert.match(r.message, /0\.1\.5-rc\.2/, "错误必须写明 PIN 版本");
    assert.match(r.message, /9\.9\.9-not-the-pin/, "错误必须写明实际版本");
  } finally { delete process.env.OPENARC_DSH_RUNTIME; cleanup(wrong); }
});

test("D5-03-D · 不回退证明：共享运行时真实存在时，项目运行时不可用也绝不返回它", (t) => {
  const sharedBin = path.join(SHARED_RUNTIME, "node_modules", ".bin", "dsh");
  const sharedPkg = path.join(SHARED_RUNTIME, "node_modules", "@deepseek-ai", "dsh", "package.json");
  // 回退目标是否真实可用决定了这条证明是否非空：本机确实装了共享运行时；换机器也不该因此变红。
  const sharedPresent = fs.existsSync(sharedPkg) && fs.existsSync(sharedBin);
  t.diagnostic(sharedPresent
    ? "回退目标真实存在（非空证明）：" + SHARED_RUNTIME
    : "本机没有 DSH Desktop 共享运行时 → 存在性证明为空；下方抛错/notEqual 断言仍然执行");
  assert.notEqual(ROOT, SHARED_RUNTIME);

  const empty = tempDir();
  const wrong = fakeRuntime("0.2.0-rc.1"); // 正是共享运行时那一版，回退若存在必然命中
  try {
    for (const [label, target] of [["缺失", empty], ["版本不符", wrong]]) {
      process.env.OPENARC_DSH_RUNTIME = target;
      const r = capture(() => resolveDshRuntime());
      const bin = capture(() => resolveDshBin());
      assert.equal(r.threw, true, label + "时必须抛错");
      assert.notEqual(r.value, SHARED_RUNTIME, label + "时不得返回共享运行时");
      assert.notEqual(bin.value, sharedBin, label + "时不得返回共享运行时的 bin");
      assert.equal(String(r.message).includes(SHARED_RUNTIME), false, label + "时错误信息不得指向共享运行时");
    }
  } finally { delete process.env.OPENARC_DSH_RUNTIME; cleanup(empty, wrong); }

  // 正向：默认解析出来的也不是共享运行时，bin 也不指向它。
  delete process.env.OPENARC_DSH_RUNTIME;
  assert.notEqual(resolveDshRuntime(), SHARED_RUNTIME);
  assert.notEqual(resolveDshBin(), sharedBin);
  const runtimeSource = fs.readFileSync(path.join(ROOT, "electron", "harness-adapter.cjs"), "utf8");
  assert.equal(runtimeSource.includes("Application Support"), false, "适配器不得再持有共享运行时路径字面量");
});

test("D5-03-E · ACP SDK 只认项目内那一份，版本 1.4.0（与锁文件一致）", () => {
  const sdk = resolveAcpSdk();
  assert.ok(sdk, "ACP SDK 必须解析得到");
  assert.equal(fs.existsSync(sdk), true);
  /*
   * worktree 下 node_modules 是指向主仓的符号链接，Node 默认 preserveSymlinks=false，
   * require.resolve 返回的是 realpath 之后的物理路径，直接拿字面 ROOT 前缀判定必然失败。
   * 改用「解析后的物理路径必须落在本项目 node_modules 的真实位置之下」：
   * 主仓（node_modules 是实体目录）与 worktree（符号链接）会落到同一个物理安装根，
   * 共享运行时 / 全局安装是另一个物理根，仍然被排除 —— 只是换成可比坐标系，不放宽范围。
   */
  const projectModulesReal = fs.realpathSync(path.join(ROOT, "node_modules"));
  const sdkReal = fs.realpathSync(sdk);
  assert.ok(sdkReal.startsWith(projectModulesReal + path.sep), "SDK 必须来自本项目 node_modules 的真实位置：" + sdkReal);
  assert.equal(sdk.startsWith(SHARED_RUNTIME + path.sep), false, "SDK 不得来自共享运行时");

  const sdkPkg = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(sdk)), "package.json"), "utf8"));
  assert.equal(sdkPkg.name, "@agentclientprotocol/sdk");
  assert.equal(sdkPkg.version, PINNED_SDK);

  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  const entry = lock.packages["node_modules/@agentclientprotocol/sdk"];
  assert.equal(entry.version, PINNED_SDK, "锁文件必须锁 1.4.0");
  assert.equal(entry.resolved, "https://registry.npmjs.org/@agentclientprotocol/sdk/-/sdk-1.4.0.tgz");
  assert.match(entry.integrity, /^sha512-/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).devDependencies["@agentclientprotocol/sdk"], PINNED_SDK);

  // 切换运行时不得改变 SDK 解析结果（不得改用别处副本）。
  const fake = fakeRuntime(PINNED_DSH);
  try {
    process.env.OPENARC_DSH_RUNTIME = fake;
    assert.equal(resolveAcpSdk(), sdk);
  } finally { delete process.env.OPENARC_DSH_RUNTIME; cleanup(fake); }
});

test("D5-03-F · 源码级锁：resolveDshRuntime 默认分支不含共享运行时路径字面量", () => {
  const source = fs.readFileSync(path.join(ROOT, "electron", "harness-adapter.cjs"), "utf8");
  const from = source.indexOf("function resolveDshRuntime(");
  assert.ok(from > 0, "必须能找到 resolveDshRuntime");
  const to = source.indexOf("\n}", from);
  assert.ok(to > from, "必须能切出 resolveDshRuntime 函数体");
  const body = source.slice(from, to + 2);
  for (const forbidden of ["DSH Desktop", "Application Support", "homedir", "OPENARC_DSH_RUNTIME ||"]) {
    assert.equal(body.includes(forbidden), false, "resolveDshRuntime 默认分支不得出现 " + forbidden + "：\n" + body);
  }
  assert.ok(body.includes("PROJECT_RUNTIME_ROOT"), "默认分支必须解析到项目运行时根：\n" + body);
  assert.ok(body.includes("assertDshRuntime"), "默认分支必须经过版本校验：\n" + body);
});

test("D5-03-G · OPENARC_DSH_BIN 覆盖同样校验版本，合法覆盖仍可用", () => {
  const dir = tempDir("oa-d5-03-bindir-");
  const fakeBin = path.join(dir, "node_modules", ".bin", "dsh");
  fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
  fs.writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  try {
    // 不属于任何 @deepseek-ai/dsh 安装 → 缺失
    process.env.OPENARC_DSH_BIN = fakeBin;
    const orphan = capture(() => resolveDshBin());
    assert.equal(orphan.threw, true, "无法证明版本的 bin 覆盖必须抛错");
    assert.equal(orphan.code, "DSH_RUNTIME_MISSING");

    // 落在版本不符的运行时里 → 版本不符
    const wrong = fakeRuntime("1.2.3");
    const wrongBin = path.join(wrong, "node_modules", ".bin", "dsh");
    fs.mkdirSync(path.dirname(wrongBin), { recursive: true });
    fs.symlinkSync(path.join(wrong, "node_modules", "@deepseek-ai", "dsh", "package.json"), wrongBin);
    process.env.OPENARC_DSH_BIN = wrongBin;
    const mismatch = capture(() => resolveDshBin());
    assert.equal(mismatch.threw, true);
    assert.equal(mismatch.code, "DSH_VERSION_MISMATCH");
    cleanup(wrong);

    // 合法覆盖：项目内那份真实 bin 仍可显式指定
    process.env.OPENARC_DSH_BIN = PROJECT_BIN;
    assert.equal(resolveDshBin(), PROJECT_BIN);
  } finally { delete process.env.OPENARC_DSH_BIN; cleanup(dir); }
});
