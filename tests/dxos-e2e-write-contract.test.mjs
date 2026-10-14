/**
 * DX OS · 写链路端到端探针的**离线契约测试**（不启动 Electron、不联网、不新增依赖）。
 *
 * 只做一件事：把 experiments/dxos-e2e-write/run-all.mjs 声明的 WRITE_CONTRACT / WHITELISTS
 * 与**产品真实导出**逐条对齐，防止写命令清单 / 通道名与 domain、bootstrap、preload 漂移：
 *   · 通道来自 electron/preload.cjs —— 在 vm 沙箱里用假 electron 模块执行真实 preload，
 *     读取 contextBridge.exposeInMainWorld("openarc", ...) 实际暴露出来的对象（不是正则猜的）；
 *   · 命令白名单来自各 domain / bootstrap 的真实导出（Object.keys，不是 copy）；
 *   · sessionRef 注入面静态核对 electron/main.cjs 的 register*Ipc 装配点；
 *   · 探针脚本自身必须隔离 userData、只读真实 profile、可重复、正常退出并清理；
 *   · 隔离身份库的 SQLite 读取**只允许**指向隔离 userData，绝不允许指向真实 profile。
 *
 * 运行：node --test tests/dxos-e2e-write-contract.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { WRITE_CONTRACT, WHITELISTS, REPORT_REL } from "../experiments/dxos-e2e-write/run-all.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const requireFromRoot = createRequire(path.join(ROOT, "package.json"));

const PROBE_PATH = path.join(ROOT, "experiments", "dxos-e2e-write", "run-all.mjs");
const PRELOAD_PATH = path.join(ROOT, "electron", "preload.cjs");
const MAIN_PATH = path.join(ROOT, "electron", "main.cjs");

/** 在 vm 沙箱里执行真实 preload.cjs（假 electron），返回 contextBridge 真实暴露的 openarc 对象。 */
function loadExposedPreload() {
  const source = fs.readFileSync(PRELOAD_PATH, "utf8");
  const exposed = {};
  const ipcRenderer = { invoke: () => Promise.resolve({ ok: true }), on: () => {}, removeListener: () => {}, send: () => {} };
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
  return exposed.openarc;
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

test("WRITE_CONTRACT 非空、id 唯一、必填字段齐备", () => {
  assert.ok(WRITE_CONTRACT.length >= 40, "写链路契约至少 40 条（当前 " + WRITE_CONTRACT.length + "）");
  const ids = new Set();
  for (const entry of WRITE_CONTRACT) {
    assert.equal(typeof entry.id, "string");
    assert.ok(!ids.has(entry.id), "契约 id 重复：" + entry.id);
    ids.add(entry.id);
    assert.ok(["write", "read", "reject"].includes(entry.kind), entry.id + " kind 非法");
    assert.ok(["ok", "error", "ok-or-structured"].includes(entry.expect), entry.id + " expect 非法");
    assert.equal(typeof entry.channel, "string", entry.id + " 缺 channel");
    assert.equal(typeof entry.command, "string", entry.id + " 缺 command");
    assert.equal(typeof entry.section, "string", entry.id + " 缺 section");
  }
});

test("七个写链路域的命令全部来自真实 domain / bootstrap 导出", () => {
  const sections = new Set(WRITE_CONTRACT.map((entry) => entry.section));
  for (const required of ["task", "skill", "developer", "media", "automation", "platform", "integration", "reject"]) {
    assert.ok(sections.has(required), "契约缺少 " + required + " 章节");
  }
  for (const entry of WRITE_CONTRACT) {
    if (!entry.whitelist) continue;
    const commands = loadWhitelist(entry.whitelist);
    assert.ok(commands.includes(entry.command), entry.whitelist + " 不包含 " + entry.command + "（真实导出 " + commands.length + " 条）");
  }
});

test("WHITELISTS 全部指向真实存在且可加载的模块", () => {
  assert.equal(Object.keys(WHITELISTS).length, 7, "白名单来源应为 7 个真实导出");
  for (const [exportName, rel] of Object.entries(WHITELISTS)) {
    assert.equal(typeof rel, "string");
    assert.ok(fs.existsSync(path.join(ROOT, rel)), "缺少模块 " + rel);
    assert.ok(loadWhitelist(exportName).length > 0, exportName + " 为空");
  }
});

test("契约里每个通道都真实存在于 preload 暴露面（且带 command()）", () => {
  const api = loadExposedPreload();
  assert.ok(api && typeof api === "object", "preload 必须暴露 openarc");
  const used = [...new Set(WRITE_CONTRACT.map((entry) => entry.channel))];
  for (const channel of used) {
    const domain = api[channel];
    assert.ok(domain && typeof domain === "object", "通道不存在：" + channel);
    assert.equal(typeof domain.command, "function", channel + " 缺少 command()");
  }
});

test("写链路每个动作都要能落到真实存储：命令名与已落地实现一一对应", () => {
  const impl = {
    "agent/project/create": "electron/agent-service.cjs",
    "agent/task/create": "electron/agent-service.cjs",
    "agent/task/get": "electron/agent-service.cjs",
    "agent/task/events": "electron/agent-service.cjs",
    "agent/task/answer": "electron/agent-service.cjs",
    "agent/task/pause": "electron/agent-service.cjs",
    "agent/task/list": "electron/agent-service.cjs",
    "agent/task/cancel": "electron/agent-service.cjs",
    "skill/enable": "electron/skill-service.cjs",
    "skill/disable": "electron/skill-service.cjs",
    "skill/run": "electron/skill-service.cjs",
    "developer/install": "electron/developer-service.cjs",
    "developer/enable": "electron/developer-service.cjs",
    "developer/disable": "electron/developer-service.cjs",
    "developer/rollback": "electron/developer-service.cjs",
    "developer/uninstall": "electron/developer-service.cjs",
    "developer/runtime/report": "electron/developer-service.cjs",
    "developer/network/request": "electron/developer-service.cjs",
    "media/project/ensure": "electron/media-service.cjs",
    "media/asset/save": "electron/media-service.cjs",
    "media/render/submit": "electron/media-service.cjs",
    "media/render/run": "electron/media-service.cjs",
    "media/render/cancel": "electron/media-service.cjs",
    "automation/create": "electron/automation-service.cjs",
    "automation/enable": "electron/automation-service.cjs",
    "automation/runNow": "electron/automation-service.cjs",
    "automation/cancel": "electron/automation-service.cjs",
    "automation/disable": "electron/automation-service.cjs",
    "platform/data/snapshot/create": "electron/platform-service.cjs",
    "platform/data/snapshot/list": "electron/platform-service.cjs",
    "platform/data/snapshot/verify": "electron/platform-service.cjs",
    "platform/data/snapshot/restore": "electron/platform-service.cjs",
    "integration/plugins/enable": "electron/plugin-service.cjs",
    "integration/plugins/disable": "electron/plugin-service.cjs",
    "integration/dingtalk/channels/save": "electron/plugin-service.cjs",
  };
  for (const [command, rel] of Object.entries(impl)) {
    const abs = path.join(ROOT, rel);
    assert.ok(fs.existsSync(abs), "实现模块不存在：" + rel);
    assert.ok(fs.readFileSync(abs, "utf8").includes("\"" + command + "\""), rel + " 未实现命令 " + command);
  }
  for (const entry of WRITE_CONTRACT) {
    if (!entry.whitelist || entry.section === "reject" || entry.kind !== "write") continue;
    assert.ok(impl[entry.command], "契约写命令缺少实现登记：" + entry.command);
  }
});

test("sessionRef 由主进程注入（UI 写命令不能自报身份）", () => {
  const main = fs.readFileSync(MAIN_PATH, "utf8");
  for (const registrar of ["registerSkillIpc", "registerAgentIpc", "registerMediaIpc", "registerAutomationIpc", "registerPlatformIpc", "registerDeveloperIpc", "registerIntegrationIpc"]) {
    assert.ok(main.includes(registrar), "main.cjs 未装配 " + registrar);
  }
  // 每个 register*Ipc 调用都必须注入 identity（sessionRef 推导来源）与 isTrusted（trusted 边界）。
  const registrationBlock = main.slice(main.indexOf("registerAgentIpc("), main.indexOf("protocol.handle(\"openarc-resource\""));
  assert.ok(/identity:\s*identity\.service/.test(registrationBlock), "写域注册必须注入 identity.service 以推导 sessionRef");
  assert.ok(registrationBlock.includes("isTrusted: trusted"), "写域注册必须注入 trusted 边界");
  // 主进程唯一身份来源：identity.service.current（渲染层给不了）。
  assert.ok(/identity\.service\s*&&\s*identity\.service\.current/.test(main) || /identity\.service\.current/.test(main), "main.cjs 必须从 identity.service.current 推导 sessionRef");
  const preload = fs.readFileSync(PRELOAD_PATH, "utf8");
  for (const channel of ["agent:command", "skill:command", "media:command", "automation:command", "platform:command", "developer:command", "integration:command"]) {
    assert.ok(preload.includes(channel), "preload 未暴露 " + channel);
  }
  assert.ok(!/sessionRef\s*[:=]\s*payload/.test(preload), "preload 不得把渲染层 payload 当 sessionRef");
});

test("探针只用隔离 userData 打开 SQLite，真实 profile 仅只读 stat/hash", () => {
  const source = fs.readFileSync(PROBE_PATH, "utf8");
  assert.ok(source.includes("--user-data-dir="), "探针必须传 --user-data-dir 隔离真实 profile");
  assert.ok(source.includes("mkdtempSync"), "探针必须使用临时 userData 目录");
  assert.ok(source.includes("DatabaseSync"), "探针必须用 SQLite 读回隔离库");
  // DatabaseSync 的唯一落点是隔离 userData 下的 identity.db
  const dbOpen = source.match(/new DatabaseSync\([^)]*\)/g) || [];
  assert.ok(dbOpen.length >= 1, "探针必须读取隔离库");
  assert.ok(dbOpen.every((call) => call.includes("dbPath")), "DatabaseSync 只能接收隔离库路径变量 dbPath：" + JSON.stringify(dbOpen));
  assert.ok(source.includes("const dbPath = path.join(userDataDir, \"identity.db\")"), "dbPath 必须由隔离 userData 拼接");
  assert.ok(!/new DatabaseSync\([^)]*realProfilePath/.test(source), "绝不能用 SQLite 打开真实 profile");
  // 真实 profile 只读：出现 realProfilePath 的地方只能是快照函数
  assert.ok(source.includes("snapshotProfile(realProfilePath)"), "必须对真实 profile 做前后快照");
  assert.ok(/function snapshotProfile\(/.test(source) && /sha256File\(abs\)/.test(source), "快照必须用 stat + sha256（只读）");
  assert.ok(/identityUnchanged/.test(source), "必须断言真实身份库未变");
  assert.ok(!/writeFileSync\([^)]*realProfilePath/.test(source), "绝不写真实 profile");
  assert.ok(!/rmSync\([^)]*realProfilePath/.test(source), "绝不删真实 profile");
});

test("探针可重复、正常退出、清理临时目录、写指定报告路径", () => {
  const source = fs.readFileSync(PROBE_PATH, "utf8");
  assert.equal(REPORT_REL, "artifacts/dxos-e2e-write/report.json");
  assert.ok(source.includes(REPORT_REL.split("/").pop()), "探针必须写 report.json");
  assert.ok(source.includes("artifacts") && source.includes("dxos-e2e-write"), "探针必须写 artifacts/dxos-e2e-write");
  assert.ok(source.includes("window.close()"), "探针必须正常关窗退出");
  assert.ok(source.includes("rmSync"), "探针必须删除隔离临时目录");
  assert.ok(source.includes("WRITE_CONTRACT"), "探针必须自驱动 WRITE_CONTRACT（契约即驱动清单）");
  assert.ok(source.includes("realProfileProcessesBefore") || source.includes("listProcessesFor(realProfilePath)"), "探针必须记录真实 profile 进程对照");
  assert.ok(!/OPENARC_E2E_SEED_TOOL_GRANTS|OPENARC_IDENTITY_ADMIN|OPENARC_ALLOW_SESSION_TTL_OVERRIDE/.test(source), "探针不得启用测试专用播种 / admin / TTL 开关");
  // 重新启用两种独立的环境：重启持久化要求同一 userData 二次启动
  assert.ok((source.match(/startApp\(/g) || []).length >= 3, "探针必须支持同一 userData 二次启动（重启持久化）");
  assert.ok(source.includes("closeApp"), "探针必须有关闭流程");
  // 不联网：除本机 CDP / loopback 外不出现外部主机
  // evil.example.org 是**刻意被拒绝**的白名单外主机（只在 developer/network/request 拒绝用例里出现，
  // 产品在 DNS/网络之前就 fail closed）；除此之外不得出现外部主机。
  const hosts = [...source.matchAll(/https?:\/\/[a-z0-9.-]+/gi)].map((m) => m[0]);
  const external = hosts.filter((h) => !/127\.0\.0\.1|localhost/.test(h) && !/evil\.example\.org/.test(h));
  assert.deepEqual(external, [], "探针不得引用外部主机：" + JSON.stringify(external));
  assert.ok(!/fetch\([^)]*evil\.example\.org/.test(source), "探针不得真的请求被拒主机");
});

test("探针导出的契约与自身的运行时驱动一致（section 覆盖 1-9 全部写链路）", () => {
  const sections = WRITE_CONTRACT.reduce((acc, entry) => { acc[entry.section] = (acc[entry.section] || 0) + 1; return acc; }, {});
  // 1 任务 / 2 技能 / 3 开发者 / 4 媒体 / 5 自动化 / 6 平台 / 7 集成 / 9 拒绝
  for (const [section, min] of Object.entries({ task: 8, skill: 5, developer: 12, media: 9, automation: 9, platform: 5, integration: 4, reject: 4 })) {
    assert.ok((sections[section] || 0) >= min, section + " 契约条目不足（" + (sections[section] || 0) + " < " + min + "）");
  }
  const writes = WRITE_CONTRACT.filter((entry) => entry.kind === "write").map((entry) => entry.command);
  for (const required of [
    "agent/task/create", "agent/task/pause", "agent/task/cancel",
    "skill/enable", "skill/disable",
    "developer/install", "developer/enable", "developer/disable", "developer/rollback", "developer/uninstall",
    "media/asset/save", "media/render/submit", "media/render/run", "media/render/cancel",
    "automation/create", "automation/enable", "automation/runNow", "automation/cancel",
    "platform/data/snapshot/create", "platform/data/snapshot/restore",
    "integration/plugins/enable",
  ]) assert.ok(writes.includes(required), "缺少写命令 " + required);
});
