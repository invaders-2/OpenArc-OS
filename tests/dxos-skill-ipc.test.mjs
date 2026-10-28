/**
 * B4 · 技能域 IPC 集成测试（全离线：假 ipcMain / 假 webContents，无 Electron、无网络、无第三方依赖）。
 *
 * 覆盖本轮验收条目：
 *   ① 命令表 risk/credential（SKILL_COMMANDS 的 17 条必需命令）
 *   ② trusted(sender) fail closed：缺 isTrusted 或伪造 sender 一律拒绝
 *   ③ 未白名单命令被拒且无副作用（skills.json 不被创建）
 *   ④ skill:event 信封（P1 六字段）与 sequence 单调
 *   ⑤ 返回值无密钥与绝对路径（复用 dxos-foundation-errors.cjs 的脱敏）
 *   ⑥ dispose 后可重复注册
 *   ⑦ skill/run 与 skill/analyze 的真实分支（真实 store + runner/analyzer，假 model/provider）
 *   ⑧ skill/pack/install / import / list / export / uninstall 的真实分支（内存 ZIP）
 *   ⑨ agent-service 里 sources.mcp / sources.skill 接线后 catalog 快照的 available 变化
 *
 * 只读源：electron/skill-domain.cjs、skill-service.cjs、skill-bootstrap.cjs、agent-service.cjs、
 *         agent-tool-catalog.cjs、dxos-foundation-events.cjs、dxos-foundation-errors.cjs。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const skillDomain = require("../electron/skill-domain.cjs");
const skillStore = require("../electron/skill-store.cjs");
const skillImport = require("../electron/skill-import.cjs");
const skillPack = require("../electron/skill-pack.cjs");
const skillRunner = require("../electron/skill-runner.cjs");
const skillAnalyzer = require("../electron/skill-analyzer.cjs");
const skillWorkspace = require("../electron/skill-workspace.cjs");
const { createSkillBundle } = require("../electron/skill-service.cjs");
const { registerSkillIpc, disposeSkillIpc, SKILL_NOT_READY } = require("../electron/skill-bootstrap.cjs");
const catalog = require("../electron/agent-tool-catalog.cjs");
const { createAgentBundle, buildMcpCatalogSource, buildSkillCatalogSource } = require("../electron/agent-service.cjs");

const tmpDirs = [];

afterEach(() => {
  // 每个用例都恢复模块级注入，避免共享单例把上一例的目录/适配器带进下一例。
  skillStore.resetSkillStoreForTests();
  skillImport.resetSkillImportForTests();
  skillPack.resetSkillPackForTests();
  skillRunner.resetSkillRunnerForTests();
  skillAnalyzer.resetSkillAnalyzerForTests();
  skillWorkspace.resetSkillWorkspaceForTests();
  catalog.resetToolCatalogForTests();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** 假授权：只有带 sessionRef 才解析出 actor（与主进程 trusted 边界同形）。 */
function makeAuth() {
  return {
    resolveActor({ context }) {
      return context && context.sessionRef
        ? { ok: true, user: { id: "u-test", organizationId: "org-test" } }
        : { ok: false, error: "no-session" };
    },
  };
}

function makeBundle(overrides = {}) {
  const userDataDir = tempDir("dxos-skill-ipc-");
  const bundle = createSkillBundle(Object.assign({
    userDataDir,
    identityStore: null,
    authorization: makeAuth(),
    providerAdapter: null,
    modelAdapter: null,
    logger: null,
    clock: null,
  }, overrides));
  return { userDataDir, bundle, dxosDir: path.join(userDataDir, "dxos") };
}

const invoke = (bundle, command, payload) => bundle.execute(command, payload || {}, { sessionRef: "sess-test", requestId: "req-test" });

/** 假 ipcMain：只需要 handle / removeHandler，与 electron/skill-bootstrap.cjs:24 的用法一致。 */
function makeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
    async invoke(channel, event, payload) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error("NO_HANDLER " + channel);
      return fn(event, payload);
    },
  };
}

const TRUSTED_SENDER = { id: "trusted-web-contents" };
const TRUSTED_URL = "file:///Application/OpenArc%20OS/index.html";
const trustedEvent = () => ({ sender: TRUSTED_SENDER, senderFrame: { url: TRUSTED_URL } });
const trustedGate = (event) => !!event && event.sender === TRUSTED_SENDER && !!event.senderFrame && event.senderFrame.url === TRUSTED_URL;

function makeProvider() {
  return { id: "p-test", name: "测试站点", base_url: "http://127.0.0.1:1/v1", api_key: "FAKE_PROVIDER_KEY", protocol: "openai", enabled: true, models: [{ model: "m-test", caps: ["llm"], protocol: "openai" }] };
}
function makeProviderAdapter() {
  const provider = makeProvider();
  return { firstUsable: () => provider, all: () => [provider], revealProvider: () => provider, autoFallback: () => false };
}
const MODEL_TEXT = "技能输出文本";
function makeModelAdapter() {
  return { call: async () => ({ ok: true, text: MODEL_TEXT, usage: {} }) };
}

/** 只满足 skill-workspace.cjs:91-94 requireDb / deleteForPack 的最小假 DB。 */
function makeFakeDb() {
  return { exec() {}, prepare() { return { run() { return { changes: 0 }; }, all() { return []; }, get() { return undefined; } }; } };
}

/** 内存构造标准技能包（ccs-skill/v1），不联网、不落外部文件。 */
function standardPackage() {
  const manifest = { format: "ccs-skill/v1", id: "std_1", name: "标准技能", description: "标准包描述", systemPrompt: "你是标准技能" };
  return skillImport.buildZip([
    { name: "skill.json", data: Buffer.from(JSON.stringify(manifest)) },
    { name: "SKILL.md", data: Buffer.from("# 标准") },
  ]);
}

// ── ① 命令表 ─────────────────────────────────────────────────────────────
test("命令表：17 条必需命令、risk/credential/summary 合法", () => {
  const required = [
    "skill/list", "skill/get", "skill/enable", "skill/disable", "skill/save", "skill/delete",
    "skill/run", "skill/analyze",
    "skill/pack/list", "skill/pack/inspectOnline", "skill/pack/installStaged", "skill/pack/install", "skill/pack/import", "skill/pack/export", "skill/pack/uninstall",
    "skill/workspace/list", "skill/health",
  ];
  const commands = skillDomain.listSkillCommands();
  assert.deepEqual(commands.map((entry) => entry.command), required);
  for (const entry of commands) {
    assert.ok(["read", "use", "manage", "destructive"].includes(entry.risk), entry.command + " risk=" + entry.risk);
    assert.equal(typeof entry.credential, "boolean", entry.command);
    assert.ok(entry.summary && /[\u4e00-\u9fff]/.test(entry.summary), entry.command + " summary 必须为中文");
  }
  assert.equal(skillDomain.skillCommandRisk("skill/delete"), "destructive");
  assert.equal(skillDomain.skillCommandRisk("skill/run"), "use");
  assert.equal(skillDomain.skillCommandRisk("skill/list"), "read");
  assert.equal(skillDomain.skillCommandRisk("skill/nope"), null);
  assert.equal(skillDomain.skillCommandRequiresCredential("skill/run"), true);
  assert.equal(skillDomain.skillCommandRequiresCredential("skill/analyze"), true);
  assert.equal(skillDomain.skillCommandRequiresCredential("skill/enable"), false);
  assert.equal(skillDomain.isSkillCommand("skill/health"), true);
  assert.equal(skillDomain.isSkillCommand("skill/nope"), false);
});

// ── ② trusted fail closed ────────────────────────────────────────────────
test("trusted(event)：伪造 sender / 缺 isTrusted 一律拒绝（fail closed）", async () => {
  const { bundle } = makeBundle();
  const ipc = makeIpcMain();
  registerSkillIpc({ ipcMain: ipc, bundle, identity: { current: "sess-test" }, isTrusted: trustedGate });
  const ok = await ipc.invoke("skill:command", trustedEvent(), { command: "skill/list" });
  assert.equal(ok.ok, true);
  assert.ok(Array.isArray(ok.value.items));

  await assert.rejects(
    () => ipc.invoke("skill:command", { sender: { id: "forged" }, senderFrame: { url: TRUSTED_URL } }, { command: "skill/list" }),
    /Forbidden/,
  );
  await assert.rejects(
    () => ipc.invoke("skill:command", { sender: TRUSTED_SENDER, senderFrame: { url: "https://evil.example/app" } }, { command: "skill/list" }),
    /Forbidden/,
  );

  // 未注入 isTrusted：任何调用都拒绝（绝不默认放行）。
  const ipcNoGate = makeIpcMain();
  registerSkillIpc({ ipcMain: ipcNoGate, bundle, identity: { current: "sess-test" }, isTrusted: null });
  await assert.rejects(() => ipcNoGate.invoke("skill:command", trustedEvent(), { command: "skill/list" }), /Forbidden/);

  // 未装配 bundle：稳定的 SKILL_NOT_READY，而不是抛异常。
  const ipcNoBundle = makeIpcMain();
  registerSkillIpc({ ipcMain: ipcNoBundle, bundle: null, identity: { current: "sess-test" }, isTrusted: trustedGate });
  const notReady = await ipcNoBundle.invoke("skill:command", trustedEvent(), { command: "skill/list" });
  assert.equal(notReady.ok, false);
  assert.equal(notReady.error, SKILL_NOT_READY);
});

// ── ③ 未白名单命令 ───────────────────────────────────────────────────────
test("未白名单命令被拒，且不产生任何落盘副作用", async () => {
  const { bundle, dxosDir } = makeBundle();
  const ipc = makeIpcMain();
  registerSkillIpc({ ipcMain: ipc, bundle, identity: { current: "sess-test" }, isTrusted: trustedGate });
  const skillsFile = path.join(dxosDir, "skills.json");
  assert.equal(fs.existsSync(skillsFile), false);
  const denied = await ipc.invoke("skill:command", trustedEvent(), { command: "skill/nuke", payload: { skillId: "writing" } });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "SKILL_COMMAND_NOT_ALLOWED");
  assert.equal(denied.value, undefined);
  assert.equal(fs.existsSync(skillsFile), false);

  // 直接调 execute 同样拒绝（白名单是分发入口的第一道，不是 IPC 层特权）。
  const viaExecute = await invoke(bundle, "skill/nuke", {});
  assert.equal(viaExecute.error, "SKILL_COMMAND_NOT_ALLOWED");
});

// ── ④ 事件信封 ───────────────────────────────────────────────────────────
test("skill:event：P1 信封六字段齐备、sequence 单调、经 send 转发", async () => {
  const { bundle } = makeBundle();
  const ipc = makeIpcMain();
  const events = [];
  registerSkillIpc({ ipcMain: ipc, bundle, identity: { current: "sess-test" }, isTrusted: trustedGate, send: (event) => events.push(event) });
  await ipc.invoke("skill:command", trustedEvent(), { command: "skill/list" });
  await ipc.invoke("skill:command", trustedEvent(), { command: "skill/get", payload: { skillId: "chat" } });
  assert.ok(events.length >= 4, "每次执行至少 begin + completed");
  const fields = ["channel", "domain", "kind", "sequence", "at", "payload"];
  events.forEach((event, index) => {
    for (const field of fields) assert.ok(Object.prototype.hasOwnProperty.call(event, field), "事件 " + index + " 缺 " + field);
    assert.equal(event.channel, "skill:event");
    assert.equal(event.domain, "skill");
    assert.equal(event.kind, "progress");
    assert.equal(typeof event.sequence, "number");
    assert.equal(typeof event.at, "number");
    assert.equal(typeof event.payload, "object");
  });
  const sequences = events.map((event) => event.sequence);
  for (let i = 1; i < sequences.length; i += 1) assert.ok(sequences[i] > sequences[i - 1], "sequence 必须严格单调");
  const phases = events.map((event) => event.payload.phase);
  assert.ok(phases.filter((phase) => phase === "begin").length >= 2);
  assert.ok(phases.filter((phase) => phase === "completed").length >= 2);
});

// ── ⑤ 脱敏 ───────────────────────────────────────────────────────────────
test("返回值不含密钥与绝对路径（文本/字段名两种形态都被脱敏）", async () => {
  const { bundle } = makeBundle();
  const leakedPath = "/Users/wepingli/secret/leak.txt";
  const leakedKey = "sk-abcdef123456";
  skillStore.saveCustomSkill({
    ownerUserId: "u-test",
    id: "leaky",
    name: "泄漏测试技能",
    description: "用于验证返回值脱敏",
    systemPrompt: "读取 " + leakedPath + " 后处理",
    source: {
      format: "agentskills/v1",
      sourcePath: "SKILL.md",
      instructions: "读取 " + leakedPath,
      files: [],
      metadata: { apiKey: leakedKey, note: "key=" + leakedKey },
    },
  });
  const result = await invoke(bundle, "skill/get", { skillId: "leaky" });
  assert.equal(result.ok, true);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(leakedPath), "绝对路径不得过桥");
  assert.ok(!serialized.includes(leakedKey), "裸密钥不得过桥");
  assert.ok(serialized.includes("<path>"), "路径应替换为 <path>");
  assert.ok(serialized.includes("<redacted>") || serialized.includes("****"), "密钥应被掩码");
  // 字段名命中的 apiKey 走字段掩码（dxos-foundation-mask.cjs:59-63）。
  assert.equal(result.value.skill.source.metadata.apiKey, "****3456");

  // health 只暴露布尔依赖清单，不含任何本机路径。
  const { bundle: bundle2 } = makeBundle();
  const health = await invoke(bundle2, "skill/health", {});
  assert.equal(health.ok, true);
  assert.equal(typeof health.value.dependencies.skillStore, "boolean");
  assert.ok(!JSON.stringify(health).includes("wepingli"));
});

// ── ⑥ dispose 后可重复注册 ───────────────────────────────────────────────
test("disposeSkillIpc：移除 handler 后可重复注册，且幂等", async () => {
  const ipc = makeIpcMain();
  const { bundle } = makeBundle();
  registerSkillIpc({ ipcMain: ipc, bundle, identity: { current: "sess-test" }, isTrusted: trustedGate });
  assert.equal((await ipc.invoke("skill:command", trustedEvent(), { command: "skill/list" })).ok, true);

  disposeSkillIpc({ ipcMain: ipc });
  assert.equal(ipc.handlers.has("skill:command"), false);
  await assert.rejects(() => ipc.invoke("skill:command", trustedEvent(), { command: "skill/list" }), /NO_HANDLER/);

  // 重复 dispose 不抛。
  disposeSkillIpc({ ipcMain: ipc });
  disposeSkillIpc({});
  disposeSkillIpc();

  registerSkillIpc({ ipcMain: ipc, bundle, identity: { current: "sess-test" }, isTrusted: trustedGate });
  assert.equal((await ipc.invoke("skill:command", trustedEvent(), { command: "skill/list" })).ok, true);
});

// ── ⑦ skill/run 与 skill/analyze 真实分支 ────────────────────────────────
test("skill/run：真实 skill-runner 文本技能走注入的 modelAdapter", async () => {
  const { bundle } = makeBundle({ providerAdapter: makeProviderAdapter(), modelAdapter: makeModelAdapter() });
  const result = await invoke(bundle, "skill/run", { skillId: "writing", arguments: { instruction: "写一句话" } });
  assert.equal(result.ok, true);
  assert.equal(result.value.text, MODEL_TEXT);
  assert.equal(result.value.meta.model, "m-test");

  // 缺 modelAdapter：结构化依赖缺失，而不是伪造文本。
  const { bundle: bare } = makeBundle();
  const missing = await invoke(bare, "skill/run", { skillId: "writing", arguments: { instruction: "写一句话" } });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "SKILL_DEPENDENCY_UNAVAILABLE");
});

test("skill/run：没有可用模型站点归一到 SKILL_DEPENDENCY_UNAVAILABLE（不伪装成内部错误）", async () => {
  // providerAdapter 已注入但没有任何可用站点：resolveChatTarget 抛普通 Error，
  // 必须在技能域归一到依赖缺失码，而不是 DXOS_ERR_INTERNAL。
  const emptyAdapter = { firstUsable: () => null, all: () => [], revealProvider: () => null, autoFallback: () => false };
  const { bundle } = makeBundle({ providerAdapter: emptyAdapter, modelAdapter: makeModelAdapter() });
  const result = await invoke(bundle, "skill/run", { skillId: "writing", arguments: { instruction: "写一句话" } });
  assert.equal(result.ok, false);
  assert.equal(result.error, "SKILL_DEPENDENCY_UNAVAILABLE");
  assert.notEqual(result.error, "DXOS_ERR_INTERNAL");
  assert.equal(result.detail.dependency, "modelSite");
  assert.match(String(result.detail.reason || result.message), /模型站点/);

  // 连 providerAdapter 都没注入：同样归一到技能域依赖码。
  const { bundle: bare } = makeBundle();
  const missing = await invoke(bare, "skill/run", { skillId: "writing", arguments: { instruction: "写一句话" } });
  assert.equal(missing.error, "SKILL_DEPENDENCY_UNAVAILABLE");
  assert.notEqual(missing.error, "DXOS_ERR_INTERNAL");
});

test("skill/analyze：真实 skill-analyzer 的结构化 tool call 生成 v2 定义", async () => {
  const analysis = {
    id: "weekly_report", name: "周报生成", description: "根据要点生成周报",
    triggers: ["用户要求写周报"], inputs: ["本周要点"],
    steps: [{ title: "整理要点", detail: "汇总输入" }, { title: "写文案", detail: "生成周报", uses: "writing" }],
    allowedTools: ["writing"], readsFiles: false, writesFiles: false, network: false, sensitive: [],
    output: "周报文本", checks: ["无遗漏"], systemPrompt: "你是周报助手。",
  };
  const modelAdapter = { call: async () => ({ ok: true, text: "", toolCalls: [{ id: "c1", name: "submit_skill_analysis", arguments: JSON.stringify(analysis) }] }) };
  const { bundle } = makeBundle({ providerAdapter: makeProviderAdapter(), modelAdapter });
  const result = await invoke(bundle, "skill/analyze", { markdown: "# 周报技能\n生成周报", sourceName: "weekly.md" });
  assert.equal(result.ok, true);
  assert.equal(result.value.skill.id, "weekly_report");
  assert.equal(result.value.skill.kind, "procedure");
  assert.equal(result.value.skill.v2.steps.length, 2);
  assert.ok(result.value.skill.v2.permissions);
});

// ── ⑧ 技能包 真实分支 ────────────────────────────────────────────────────
test("skill/pack：内存 ZIP 的 install / inspect / import / export / uninstall 全链路", async () => {
  const { bundle } = makeBundle({ identityStore: { db: makeFakeDb() } });
  const zip = standardPackage();
  const archiveBase64 = zip.toString("base64");

  const imported = await invoke(bundle, "skill/pack/import", { archiveBase64, idPrefix: "imp" });
  assert.equal(imported.ok, true);
  assert.equal(imported.value.skills.length, 1);
  assert.equal(imported.value.skills[0].id, "imp_std_1");

  const installed = await invoke(bundle, "skill/pack/install", { archiveBase64, sourceName: "std.zip" });
  assert.equal(installed.ok, true);
  assert.ok(installed.value.pack.id);
  assert.equal(installed.value.pack.skillCount, 1);
  assert.equal(installed.value.skills.length, 1);

  const listed = await invoke(bundle, "skill/pack/list", {});
  assert.equal(listed.ok, true);
  assert.equal(listed.value.items.length, 1);

  const exported = await invoke(bundle, "skill/pack/export", { packId: installed.value.pack.id });
  assert.equal(exported.ok, true);
  assert.ok(exported.value.bytes > 0);
  assert.equal(exported.value.skillCount, 1);
  const roundTrip = Buffer.from(exported.value.base64, "base64");
  assert.equal(roundTrip.length, exported.value.bytes);
  assert.ok(skillImport.previewSkillPackage(roundTrip).length >= 1, "导出包必须可被再次解析");

  const removed = await invoke(bundle, "skill/pack/uninstall", { packId: installed.value.pack.id });
  assert.equal(removed.ok, true);
  assert.equal(removed.value.deleted, true);
  const after = await invoke(bundle, "skill/pack/list", {});
  assert.equal(after.value.items.length, 0);
});

// ── ⑨ agent-service catalog 来源接线 ─────────────────────────────────────
test("agent-service：sources.skill / sources.mcp 接线后 catalog 快照 available 变化", async () => {
  const summary = (snapshot) => snapshot.descriptors.filter((descriptor) => descriptor.source === "skill").map((descriptor) => descriptor.status);
  // 未接线：catalog 保持 available:false 的 fallback descriptor。
  catalog.configureToolCatalog({ sources: {}, auth: null, weather: null, clock: null });
  let snapshot = catalog.toolCatalogSnapshot({});
  assert.deepEqual(summary(snapshot), ["unavailable"]);
  assert.deepEqual(snapshot.descriptors.filter((d) => d.source === "mcp").map((d) => d.status), ["unavailable"]);

  // 接线：agent-service 用注入的 store/runner 与 mcp-agent-tools 构造同步来源。
  const fakeSkillStore = { listSkills: () => [{ id: "demo", name: "演示技能", description: "演示", enabled: true, exposure: "agent", allowImplicitInvocation: true, inputSchema: { type: "object", properties: {} } }] };
  const fakeSkillRunner = { runSkill: async () => ({ text: "ran" }) };
  const fakeMcpTools = { callByName: async () => ({ ok: true, text: "mcp" }) };
  const mcpServersSnapshot = () => [{ id: "srv1", name: "服务器", enabled: true, status: "connected", tools: [{ name: "search", description: "搜索", inputSchema: { type: "object", properties: {} } }] }];
  createAgentBundle({ toolCatalog: catalog, skillStore: fakeSkillStore, skillRunner: fakeSkillRunner, mcpAgentTools: fakeMcpTools, mcpServersSnapshot });
  snapshot = catalog.toolCatalogSnapshot({});
  assert.equal(snapshot.descriptors.filter((d) => d.source === "skill" && d.status === "unavailable").length, 0);
  assert.ok(snapshot.descriptors.some((d) => d.source === "skill" && d.status === "ready" && d.handler && d.handler.skillId === "demo"));
  assert.ok(snapshot.descriptors.some((d) => d.source === "mcp" && d.status === "ready"));
  assert.ok(snapshot.summary.sources.skill >= 1);
  assert.ok(snapshot.summary.sources.mcp >= 1);

  // 来源构造器只接受真实能力；缺一即为 null（不注册来源键 → available:false）。
  assert.equal(buildSkillCatalogSource(null, fakeSkillRunner), null);
  assert.equal(buildSkillCatalogSource(fakeSkillStore, null), null);
  assert.equal(buildMcpCatalogSource(null, mcpServersSnapshot), null);
  assert.equal(buildMcpCatalogSource(fakeMcpTools, null), null);
  const skillSource = buildSkillCatalogSource(fakeSkillStore, fakeSkillRunner);
  assert.equal((await skillSource.call("demo", {}, {})).text, "ran");
  const mcpSource = buildMcpCatalogSource(fakeMcpTools, mcpServersSnapshot);
  assert.equal((await mcpSource.call("mcp__srv1__search", {}, {})).text, "mcp");
  assert.equal(mcpSource.list().length, 1);

  // 真实 skill-store：来源接线后 fallback 消失（available），但 store 的分类（exposure=slash/internal）
  // 使其不产出 agent 工具描述符 —— 这是真实语义，不伪造 exposure。
  const dir = tempDir("dxos-skill-ipc-catalog-");
  skillStore.configureSkillStore({ dataDir: dir });
  createAgentBundle({ toolCatalog: catalog, skillStore, skillRunner });
  const real = catalog.toolCatalogSnapshot({});
  assert.equal(real.descriptors.filter((d) => d.source === "skill" && d.status === "unavailable").length, 0, "接线后 skill fallback 必须消失");
  assert.equal(real.descriptors.filter((d) => d.source === "skill").length, 0, "真实 store 无 agent-exposed 技能，不伪造描述符");
});
