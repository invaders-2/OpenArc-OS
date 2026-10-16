/**
 * DX OS · B2–B7 端到端探针的**离线契约测试**（不启动 Electron、不联网、不新增依赖）。
 *
 * 只做一件事：把 experiments/dxos-e2e/run-all.mjs 里声明的 CONTRACT / WHITELISTS
 * 与**产品真实导出**逐条对齐，防止探针的域清单 / 命令清单与 preload / bootstrap 漂移：
 *   · 域清单（39 个顶层键 + 每个键的真实形状）来自 electron/preload.cjs —— 在一个 vm 沙箱里
 *     用假的 electron 模块执行真实 preload，读取 contextBridge.exposeInMainWorld("openarc", …)
 *     实际暴露出来的对象（不是正则猜的）；
 *   · 命令清单来自各 domain / bootstrap 的真实导出（AGENT_COMMANDS / MODEL_COMMANDS / …）；
 *   · trusted 边界来自 electron/main.cjs 的 trusted() 双条件静态核对；
 *   · 探针脚本自身必须从 CONTRACT 驱动运行时、必须隔离 userData、必须正常退出并清理。
 *
 * 运行：node --test tests/dxos-e2e-contract.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { CONTRACT, WHITELISTS } from "../experiments/dxos-e2e/run-all.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const requireFromRoot = createRequire(path.join(ROOT, "package.json"));

const PROBE_PATH = path.join(ROOT, "experiments", "dxos-e2e", "run-all.mjs");
const PRELOAD_PATH = path.join(ROOT, "electron", "preload.cjs");
const MAIN_PATH = path.join(ROOT, "electron", "main.cjs");
const RAW_CAPABILITIES = ["ipcRenderer", "ipcMain", "webContents", "BrowserWindow", "require", "process", "module", "global", "electron", "shell", "fs"];

/** 在 vm 沙箱里执行真实 preload.cjs（假 electron），返回 contextBridge 真实暴露的 openarc 对象。 */
function loadExposedPreload() {
  const source = fs.readFileSync(PRELOAD_PATH, "utf8");
  const exposed = {};
  const ipcCalls = [];
  const ipcRenderer = {
    invoke: (...args) => { ipcCalls.push(["invoke", args]); return Promise.resolve({ ok: true }); },
    on: (...args) => { ipcCalls.push(["on", args]); },
    removeListener: (...args) => { ipcCalls.push(["removeListener", args]); },
    send: (...args) => { ipcCalls.push(["send", args]); },
  };
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer,
    webUtils: { getPathForFile: () => "" },
  };
  const sandboxRequire = (id) => (id === "electron" ? electron : requireFromRoot(id));
  const moduleShim = { exports: {} };
  const context = vm.createContext({
    require: sandboxRequire,
    module: moduleShim,
    exports: moduleShim.exports,
    console,
    process,
    __dirname: path.dirname(PRELOAD_PATH),
    __filename: PRELOAD_PATH,
  });
  vm.runInContext(source, context, { filename: PRELOAD_PATH });
  return { api: exposed.openarc, exposedNames: Object.keys(exposed), ipcCalls };
}

/** 读取某个真实白名单导出的全部命令名（数组或对象字面量）。 */
function loadWhitelist(exportName) {
  const rel = WHITELISTS[exportName];
  assert.equal(typeof rel, "string", "WHITELISTS 缺少 " + exportName);
  const abs = path.join(ROOT, rel);
  assert.ok(fs.existsSync(abs), "白名单模块不存在：" + rel);
  const mod = requireFromRoot(abs);
  const value = mod[exportName];
  assert.ok(value != null, rel + " 未导出 " + exportName);
  return Array.isArray(value) ? value.slice() : Object.keys(value);
}

test("preload 真实暴露的顶层键恰为 39，且与探针契约逐字一致", () => {
  const { api, exposedNames } = loadExposedPreload();
  assert.deepEqual(exposedNames, ["openarc"], "preload 只应 exposeInMainWorld openarc");
  assert.ok(api && typeof api === "object", "openarc 必须是对象");
  const keys = Object.keys(api);
  assert.equal(keys.length, 39, "顶层键必须恰为 39（当前 " + keys.length + "）");
  assert.equal(new Set(keys).size, 39, "顶层键不得重复");
  assert.deepEqual(keys, CONTRACT.topLevel.map((entry) => entry.key), "探针 CONTRACT.topLevel 顺序/集合必须与 preload 真实导出一致");
});

test("每个顶层键的真实形状与契约一致（函数 / 域对象成员）", () => {
  const { api } = loadExposedPreload();
  for (const entry of CONTRACT.topLevel) {
    const value = api[entry.key];
    assert.ok(value != null, "缺少顶层键 " + entry.key);
    if (entry.kind === "function") {
      assert.equal(typeof value, "function", entry.key + " 必须是函数");
      continue;
    }
    assert.equal(typeof value, "object", entry.key + " 必须是域对象");
    for (const member of entry.members) {
      assert.equal(typeof value[member], "function", entry.key + "." + member + " 必须是函数");
    }
    // 契约必须如实列出全部成员，避免漏掉新的暴露面
    assert.deepEqual(Object.keys(value).sort(), entry.members.slice().sort(), entry.key + " 的成员集合与契约不一致");
  }
});

test("域对象不自带原始能力（ipcRenderer / webContents / require / process…）", () => {
  const { api } = loadExposedPreload();
  const hits = [];
  for (const key of Object.keys(api)) {
    const value = api[key];
    if (typeof value !== "object" || value == null) {
      if (RAW_CAPABILITIES.includes(key)) hits.push(key);
      continue;
    }
    for (const member of Object.keys(value)) if (RAW_CAPABILITIES.includes(member)) hits.push(key + "." + member);
  }
  assert.deepEqual(hits, [], "桥面不得暴露原始能力：" + JSON.stringify(hits));
  const source = fs.readFileSync(PRELOAD_PATH, "utf8");
  assert.ok(/contextBridge\.exposeInMainWorld\(\s*["']openarc["']/.test(source), "preload 必须且只能经 contextBridge 暴露 openarc");
});

test("健康 / 只读命令清单来自真实 domain / bootstrap 导出", () => {
  const allEntries = [
    ...CONTRACT.health.map((entry) => Object.assign({ group: "health" }, entry)),
    ...CONTRACT.extra.map((entry) => Object.assign({ group: "extra" }, entry)),
  ];
  const seenIds = new Set();
  for (const entry of allEntries) {
    assert.ok(!seenIds.has(entry.id), "命令 id 重复：" + entry.id);
    seenIds.add(entry.id);
    if (!entry.whitelist) continue;
    const commands = loadWhitelist(entry.whitelist);
    if (entry.command) {
      assert.ok(commands.includes(entry.command), entry.whitelist + " 不包含 " + entry.command + "（真实导出 " + commands.length + " 条）");
    }
  }
});

test("B3–B7 八个域 health + model/mcp/canvas/task 等价只读命令齐备且真实登记", () => {
  const commands = CONTRACT.health.map((entry) => entry.command);
  const required = [
    "agent/health", "skill/health", "media/health", "platform/health",
    "developer/health", "integration/health", "market/health", "automation/health",
    "protocol/list", "mcp/list", "canvas/list", "task/list",
  ];
  for (const command of required) assert.ok(commands.includes(command), "健康矩阵缺少 " + command);
  const expectedChannels = ["agent", "skill", "media", "automation", "platform", "developer", "integration", "market", "model", "mcp", "canvas", "task"];
  assert.deepEqual(CONTRACT.health.map((entry) => entry.channel), expectedChannels, "健康矩阵通道顺序必须与契约一致");
  for (const entry of CONTRACT.health) {
    const commands = loadWhitelist(entry.whitelist);
    assert.ok(commands.includes(entry.command), entry.whitelist + " 不包含 " + entry.command);
  }
});

test("每个契约通道 / 函数都真实存在于 preload 暴露面", () => {
  const { api } = loadExposedPreload();
  const check = (entry) => {
    if (entry.channel) {
      const domain = api[entry.channel];
      assert.ok(domain && typeof domain === "object", "通道不存在：" + entry.channel);
      if (entry.command) assert.equal(typeof domain.command, "function", entry.channel + " 缺少 command()");
      if (entry.method) assert.equal(typeof domain[entry.method], "function", entry.channel + " 缺少方法 " + entry.method);
      return;
    }
    if (entry.fn) assert.equal(typeof api[entry.fn], "function", "顶层函数不存在：" + entry.fn);
  };
  for (const entry of CONTRACT.extra) check(entry);
  for (const entry of CONTRACT.health) check(entry);
});

test("trusted 边界：main.cjs trusted() 双条件与 preload 无原始能力（静态核对）", () => {
  const main = fs.readFileSync(MAIN_PATH, "utf8");
  assert.ok(/function trusted\(/.test(main), "main.cjs 必须有 trusted()");
  assert.ok(/event\.sender\s*!==\s*win\?\.webContents/.test(main), "trusted() 必须校验 event.sender === win.webContents");
  assert.ok(/event\.senderFrame\?\.url/.test(main) && /url\s*===\s*uiURL/.test(main), "trusted() 必须校验 senderFrame.url 属于外壳页");
  const mainTrusted = main.slice(main.indexOf("function trusted("), main.indexOf("function trusted(") + 700);
  assert.ok(/return false/.test(mainTrusted), "trusted() 不匹配时必须 fail closed（return false）");
  // 每个命令通道都已经在 main.cjs 可达的模块里显式注册（主进程入口只负责装配）。
  const CHANNEL_REGISTRATIONS = [
    { endpoint: "identity:command", module: "electron/identity-bootstrap.cjs" },
    { endpoint: "windows:sync", module: "electron/main.cjs" },
    { endpoint: "browser:command", module: "electron/main.cjs" },
    { endpoint: "files:list", module: "electron/main.cjs" },
    { endpoint: "agent:command", module: "electron/agent-bootstrap.cjs" },
    { endpoint: "skill:command", module: "electron/skill-bootstrap.cjs" },
    { endpoint: "media:command", module: "electron/media-bootstrap.cjs" },
    { endpoint: "platform:command", module: "electron/platform-bootstrap.cjs" },
    { endpoint: "developer:command", module: "electron/developer-bootstrap.cjs" },
    { endpoint: "integration:command", module: "electron/plugin-bootstrap.cjs" },
    { endpoint: "market:command", module: "electron/plugin-bootstrap.cjs" },
    { endpoint: "automation:command", module: "electron/automation-bootstrap.cjs" },
    { endpoint: "model:command", module: "electron/model-bootstrap.cjs" },
    { endpoint: "mcp:command", module: "electron/mcp-bootstrap.cjs" },
    { endpoint: "canvas:command", module: "electron/canvas-bootstrap.cjs" },
    { endpoint: "task:command", module: "electron/task-bootstrap.cjs" },
    // 0.6.1 新增五域（独立通道；并入 canvas:command / platform:command 需改冻结白名单，见 main.cjs 注册块注释）。
    { endpoint: "systemFonts:command", module: "electron/system-fonts-bootstrap.cjs" },
    { endpoint: "ocr:command", module: "electron/ocr-bootstrap.cjs" },
    { endpoint: "fileTransfer:command", module: "electron/file-transfer-bootstrap.cjs" },
    { endpoint: "codexCanvas:command", module: "electron/codex-canvas-bootstrap.cjs" },
    { endpoint: "desktop:command", module: "electron/local-proxy-bootstrap.cjs" },
    // 0.6.2 新增三域（独立通道；命令表即各域 domain 的冻结白名单）。
    { endpoint: "photos:command", module: "electron/photos-bootstrap.cjs" },
    { endpoint: "photocraft:command", module: "electron/photocraft-bootstrap.cjs" },
    { endpoint: "appExchange:command", module: "electron/app-exchange-bootstrap.cjs" },
    // CLI 域（对齐 DX OS 0.6.1 /api/cli/*；独立通道，命令表即 cli-domain.cjs 的冻结白名单）。
    { endpoint: "cli:command", module: "electron/cli-bootstrap.cjs" },
  ];
  for (const { endpoint, module: rel } of CHANNEL_REGISTRATIONS) {
    const abs = path.join(ROOT, rel);
    assert.ok(fs.existsSync(abs), "接线模块不存在：" + rel);
    assert.ok(fs.readFileSync(abs, "utf8").includes(endpoint), rel + " 未注册命令通道 " + endpoint);
  }
  for (const registrar of ["registerIdentityIpc", "registerMcpIpc", "registerCanvasIpc", "registerTaskIpc", "registerSkillIpc", "registerAgentIpc", "registerMediaIpc", "registerAutomationIpc", "registerPlatformIpc", "registerDeveloperIpc", "registerIntegrationIpc", "registerMarketIpc", "registerSystemFontsIpc", "registerOcrIpc", "registerFileTransferIpc", "registerCodexCanvasIpc", "registerLocalProxyIpc", "registerPhotosIpc", "registerPhotocraftIpc", "registerAppExchangeIpc", "registerCliIpc"]) {
    assert.ok(main.includes(registrar), "main.cjs 未装配 " + registrar);
  }
});

test("探针脚本自驱动契约、隔离 userData、正常退出并清理（静态核对）", () => {
  const source = fs.readFileSync(PROBE_PATH, "utf8");
  assert.ok(source.includes("CONTRACT.health"), "探针必须遍历 CONTRACT.health");
  assert.ok(source.includes("CONTRACT.extra"), "探针必须遍历 CONTRACT.extra");
  assert.ok(source.includes("window.openarc"), "探针必须经渲染层 window.openarc 命令面驱动");
  assert.ok(source.includes("--user-data-dir="), "探针必须传 --user-data-dir 隔离真实 profile");
  assert.ok(source.includes("mkdtempSync"), "探针必须使用临时 userData 目录");
  assert.ok(source.includes("realProfilePath") && source.includes("snapshotProfile"), "探针必须记录并对照真实 profile");
  assert.ok(source.includes("identityUnchanged"), "探针必须断言真实身份库未变");
  assert.ok(source.includes("window.close()"), "探针必须正常关窗退出");
  assert.ok(source.includes("rmSync"), "探针必须删除隔离临时目录");
  assert.ok(source.includes("artifacts") && source.includes("report.json"), "探针必须写 artifacts/dxos-e2e/report.json");
  assert.ok(!/OPENARC_E2E_SEED_TOOL_GRANTS|OPENARC_IDENTITY_ADMIN/.test(source), "探针不得启用测试专用播种 / admin 开关");
});

test("WHITELISTS 全部指向真实存在且可加载的模块", () => {
  assert.equal(Object.keys(WHITELISTS).length, 12, "白名单来源应为 12 个真实导出");
  for (const [exportName, rel] of Object.entries(WHITELISTS)) {
    assert.equal(typeof rel, "string");
    const abs = path.join(ROOT, rel);
    assert.ok(fs.existsSync(abs), "缺少模块 " + rel);
    const entries = loadWhitelist(exportName);
    assert.ok(entries.length > 0, exportName + " 为空");
  }
});
