/**
 * B7c · 可选插件框架测试（全离线：无 Electron、无网络；依赖探测全部注入）。
 *
 * 覆盖任务书验收点：
 *   ① 插件默认全部关闭；
 *   ② 依赖缺失 → enable 结构化 { ok:false, error:"INTEGRATION_UNAVAILABLE", detail } 且带安装提示；
 *   ③ 缺依赖显式降级（optional 缺失 / 运行时能力未注入 → degraded / unavailable + 提示）；
 *   ④ 开关持久化到 <userData>/dxos/integrations.json，且"重启后"保持；
 *   ⑤ JSON 保留原格式：未知顶层键、未知插件条目、插件 config 的未知字段都不丢；
 *   ⑥ 三类依赖探测：binary（PATH）、python（包）、network（可达性）。
 *
 * 只读源：electron/plugin-registry.cjs。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createPluginRegistry, STATE_FILE_NAME } = require("../electron/plugin-registry.cjs");

const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-plugin-")); tmpDirs.push(dir); return dir; }

const BINARY_PLUGIN = {
  id: "ghost-tool",
  name: "Ghost 工具",
  kind: "integration",
  version: "0.2.0",
  dependencies: [
    { id: "ghost.bin", kind: "binary", label: "ghostctl", required: true, target: "ghostctl", install: "brew install ghostctl" },
  ],
};
const PYTHON_PLUGIN = {
  id: "py-tool",
  name: "Python 工具",
  kind: "integration",
  dependencies: [
    { id: "py.mod", kind: "python", label: "Python 包 fastapi", required: true, target: "fastapi", install: "pip3 install fastapi" },
  ],
};
const NETWORK_PLUGIN = {
  id: "net-tool",
  name: "网络工具",
  kind: "integration",
  dependencies: [
    { id: "net.host", kind: "network", label: "example 服务", required: true, target: "https://example.test", install: "联网后重试" },
    { id: "net.optional", kind: "network", label: "可选镜像", required: false, target: "https://optional.test", install: "可选，不装也能用" },
  ],
};

// ── ① 默认全关 ────────────────────────────────────────────────────────────
test("默认全关：三个内置插件一律 enabled=false，健康报告为 disabled", async () => {
  const dir = tempDir();
  const registry = createPluginRegistry({ userDataDir: dir });
  const items = registry.list();
  assert.deepEqual(items.map((item) => item.id).sort(), ["almanac", "dingtalk", "weather"]);
  assert.ok(items.every((item) => item.enabled === false), "默认必须全部关闭");
  for (const item of items) {
    const report = await registry.health(item.id);
    assert.equal(report.enabled, false);
    assert.equal(report.status, "disabled");
  }
  assert.equal(fs.existsSync(path.join(dir, "dxos", STATE_FILE_NAME)), false, "未动开关就不该写状态文件");
});

// ── ② 必需依赖缺失 → 结构化拒绝 + 安装提示 ────────────────────────────────
test("依赖缺失：required 依赖 missing → INTEGRATION_UNAVAILABLE + 安装提示，且不改变开关", async () => {
  const dir = tempDir();
  const registry = createPluginRegistry({
    userDataDir: dir,
    plugins: [BINARY_PLUGIN],
    probes: { binary: () => ({ ok: false, status: "missing", detail: "PATH 中找不到 ghostctl" }) },
  });
  const res = await registry.enable("ghost-tool");
  assert.equal(res.ok, false);
  assert.equal(res.error, "INTEGRATION_UNAVAILABLE");
  assert.match(res.detail, /ghostctl/);
  assert.match(res.detail, /brew install ghostctl/);
  assert.equal(registry.isEnabled("ghost-tool"), false, "缺依赖时不得置为已启用");

  const report = await registry.health("ghost-tool");
  assert.equal(report.status, "disabled");
  assert.deepEqual(report.missingRequired, ["ghost.bin"]);
  assert.match(report.detail, /brew install ghostctl/);
});

test("依赖缺失：python 包与 network 探测同样可注入（离线）", async () => {
  const dir = tempDir();
  const registry = createPluginRegistry({
    userDataDir: dir,
    plugins: [PYTHON_PLUGIN, NETWORK_PLUGIN],
    probes: {
      python: () => ({ ok: false, status: "missing", detail: 'python3 -c "import fastapi" 退出码 1' }),
      network: () => ({ ok: false, status: "missing", detail: "网络不可达" }),
    },
  });
  const py = await registry.enable("py-tool");
  assert.equal(py.error, "INTEGRATION_UNAVAILABLE");
  assert.match(py.detail, /pip3 install fastapi/);

  const net = await registry.enable("net-tool", { probeNetwork: true });
  assert.equal(net.error, "INTEGRATION_UNAVAILABLE");
  assert.match(net.detail, /联网后重试/);
});

test("网络探测默认不触发：只有 probeNetwork=true 才调用注入的 network 探测", async () => {
  const dir = tempDir();
  const calls = [];
  const registry = createPluginRegistry({
    userDataDir: dir,
    plugins: [NETWORK_PLUGIN],
    probes: { network: (target) => { calls.push(target); return { ok: true, status: "ok", detail: "" }; } },
  });
  await registry.health("net-tool");
  assert.deepEqual(calls, [], "默认健康报告不得联网");
  await registry.health("net-tool", { probeNetwork: true });
  assert.deepEqual(calls.sort(), ["https://example.test", "https://optional.test"]);
});

// ── ③ 缺依赖显式降级 ──────────────────────────────────────────────────────
test("降级提示：optional 依赖缺失 → status=degraded，但允许启用", async () => {
  const dir = tempDir();
  const registry = createPluginRegistry({
    userDataDir: dir,
    plugins: [{
      id: "degradable", name: "可降级", kind: "integration",
      dependencies: [{ id: "degradable.bin", kind: "binary", label: "ffmpeg", required: false, target: "ffmpeg", install: "brew install ffmpeg" }],
    }],
    probes: { binary: () => ({ ok: false, status: "missing", detail: "PATH 中找不到 ffmpeg" }) },
  });
  const res = await registry.enable("degradable");
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.status, "degraded");
  const report = await registry.health("degradable");
  assert.equal(report.status, "degraded");
  assert.deepEqual(report.missingOptional, ["degradable.bin"]);
  assert.match(report.detail, /brew install ffmpeg/);
});

test("运行时能力未注入：enable 成功但 status=unavailable 且提示注入 fetch", async () => {
  const dir = tempDir();
  const registry = createPluginRegistry({ userDataDir: dir });
  const res = await registry.enable("weather");
  assert.equal(res.ok, true);
  assert.equal(res.value.status, "unavailable");
  const report = await registry.health("weather");
  assert.equal(report.status, "unavailable");
  assert.match(report.detail, /fetch/);

  const withFetch = createPluginRegistry({ userDataDir: dir, capabilities: { fetch: async () => ({}) } });
  const report2 = await withFetch.health("weather");
  assert.equal(report2.status, "healthy", JSON.stringify(report2));
});

// ── ④⑤ 持久化与 JSON 保留原格式 ───────────────────────────────────────────
test("持久化：开关写 <userData>/dxos/integrations.json，重启（新实例）后保持", async () => {
  const dir = tempDir();
  const first = createPluginRegistry({ userDataDir: dir });
  assert.equal((await first.enable("dingtalk")).ok, true);
  const file = path.join(dir, "dxos", STATE_FILE_NAME);
  assert.equal(fs.existsSync(file), true);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.plugins.dingtalk.enabled, true);
  assert.equal(parsed.plugins.weather, undefined, "未动过的插件不写空条目");

  const second = createPluginRegistry({ userDataDir: dir });
  assert.equal(second.isEnabled("dingtalk"), true, "重启后开关必须保持");
  assert.equal(second.isEnabled("weather"), false);
  assert.equal((await second.disable("dingtalk")).ok, true);
  const third = createPluginRegistry({ userDataDir: dir });
  assert.equal(third.isEnabled("dingtalk"), false);
});

test("JSON 保留原格式：未知顶层键 / 未知插件条目 / 插件 config 未知字段都不丢", async () => {
  const dir = tempDir();
  const file = path.join(dir, "dxos", STATE_FILE_NAME);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const seeded = {
    version: 1,
    futureTopLevel: { keep: "me" },
    plugins: {
      weather: { enabled: true, config: { city: "上海", futureFlag: "keep" } },
      "legacy-plugin": { enabled: true, note: "不在当前目录也不删" },
    },
  };
  fs.writeFileSync(file, JSON.stringify(seeded, null, 2) + "\n", "utf8");

  const registry = createPluginRegistry({ userDataDir: dir });
  assert.equal(registry.isEnabled("weather"), true);
  assert.equal(registry.isEnabled("legacy-plugin"), false, "未登记插件视为关闭");
  const written = registry.writePluginConfig("weather", { city: "北京" });
  assert.equal(written.ok, true);

  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(after.futureTopLevel, { keep: "me" });
  assert.deepEqual(after.plugins["legacy-plugin"], { enabled: true, note: "不在当前目录也不删" });
  assert.deepEqual(after.plugins.weather.config, { city: "北京", futureFlag: "keep" }, "config 未知字段必须保留");
  assert.equal(typeof after.updatedAt, "number");
});

test("健康报告不抛异常：未登记插件返回 null，未知探测结果记为 unknown 而非 missing", async () => {
  const dir = tempDir();
  const registry = createPluginRegistry({
    userDataDir: dir,
    plugins: [{ id: "unknown-probe", name: "未知探测", kind: "integration", dependencies: [{ id: "u", kind: "binary", label: "x", required: true, target: "x", install: "装 x" }] }],
    probes: { binary: () => null },
  });
  assert.equal(await registry.health("nope"), null);
  await registry.enable("unknown-probe");
  const report = await registry.health("unknown-probe");
  assert.equal(report.dependencies[0].status, "unknown");
  assert.equal(report.status, "degraded", "探测不了 ≠ 缺失，不能直接判 unavailable");
});

test("二进制探测默认真实走 PATH 扫描（离线）", () => {
  const registry = createPluginRegistry({ userDataDir: tempDir() });
  const nodePath = registry.resolveBinaryPath("node");
  assert.ok(nodePath === null || typeof nodePath === "string");
  assert.equal(registry.resolveBinaryPath("../evil"), null, "非法二进制名一律拒绝");
});
