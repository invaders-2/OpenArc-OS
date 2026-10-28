/**
 * B6d · fsAdapter 接线回归测试（全离线：假 ipcMain / 假 authorization / 临时 userData，不启动 Electron）。
 *
 * 覆盖本轮验收条目：
 *   ① 装配契约（源码级 + 进程内真实构造）：main.cjs 走 createDxosFsAdapterForUserData，
 *      同一份实例喂给 createAgentBundle / createSkillBundle，健康报告 fsAdapter=true；
 *   ② 装配失败如实反映：目录建不出时保持 null → 健康 false，文件工具仍结构化拒绝；
 *   ③ 端到端：agent:command → agent/tool/call 的 fs_read / fs_write 经注入 fsAdapter
 *      在 <userData>/dxos/fs 真实落盘（fs.json + blobs）；
 *   ④ 越界写仍被拒：'..' / 绝对路径 / 无效 Run 工作区三种围栏都不因接线失效；
 *   ⑤ project/snapshot 与 project/run 的 fs_list 经同一份 fsAdapter 可用；
 *   ⑥ skill/run 的产物落盘走 fsAdapter（未注入时仍 SKILL_DEPENDENCY_UNAVAILABLE）。
 *
 * 只读源：electron/main.cjs、agent-service.cjs、skill-service.cjs、dxos-fs-adapter.cjs、
 *         agent-runtime-workspace.cjs、agent-builtin-tools.cjs、agent-project-snapshot.cjs。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const agentDomain = require("../electron/agent-domain.cjs");
const { createAgentBundle, createDxosFsAdapterForUserData } = require("../electron/agent-service.cjs");
const { createSkillBundle } = require("../electron/skill-service.cjs");
const { registerAgentIpc } = require("../electron/agent-bootstrap.cjs");
const skillStore = require("../electron/skill-store.cjs");
const skillRunner = require("../electron/skill-runner.cjs");
const skillAnalyzer = require("../electron/skill-analyzer.cjs");
const skillWorkspace = require("../electron/skill-workspace.cjs");
const skillImport = require("../electron/skill-import.cjs");
const skillPack = require("../electron/skill-pack.cjs");

const tmpDirs = [];
afterEach(() => {
  // 技能域是模块级注入；每个用例后清空，避免共享单例把上一例的 adapter 带进下一例。
  skillStore.resetSkillStoreForTests();
  skillRunner.resetSkillRunnerForTests();
  skillAnalyzer.resetSkillAnalyzerForTests();
  skillWorkspace.resetSkillWorkspaceForTests();
  skillImport.resetSkillImportForTests();
  skillPack.resetSkillPackForTests();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** 假 ipcMain：与 Electron 同形（handle / removeHandler / invoke）。 */
function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { if (handlers.has(channel)) throw new Error("重复注册 handler：" + channel); handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
    invoke(channel, event, raw) { const fn = handlers.get(channel); if (!fn) throw new Error("没有 handler：" + channel); return fn(event, raw); },
  };
}

const makeAuth = (actorId = "u1") => ({ resolveActor: () => ({ ok: true, user: { id: actorId, role: "ADMIN", team_id: "org1" }, organizationId: "org1" }) });
const writeGrants = { appGrantsForApp: () => [{ appId: "ai", actions: ["files.read", "files.write"] }] };

const AGENT_EVENT = { sender: "shell", senderFrame: { url: "file:///app/dist/index.html" } };

/** 经 agent:command 的调用面（与 tests/dxos-agent-ipc.test.mjs 同一手法）。 */
function makeAgentCall(bundle) {
  const ipcMain = fakeIpcMain();
  registerAgentIpc({ ipcMain, bundle, identity: { current: "session-1" }, isTrusted: (event) => !!event && event.sender === "shell", send: () => {} });
  return (command, payload) => ipcMain.invoke("agent:command", AGENT_EVENT, { command, payload });
}

// ---------------------------------------------------------------------------
// ① 装配契约（源码级 + 进程内真实构造）
// ---------------------------------------------------------------------------
test("装配契约：main.cjs 用 createDxosFsAdapterForUserData 装配，同一份实例喂 agent/skill bundle，健康报告 fsAdapter=true", async () => {
  const main = fs.readFileSync(path.join(process.cwd(), "electron", "runtime-composition.cjs"), "utf8");
  assert.ok(main.includes("createDxosFsAdapterForUserData"), "main.cjs 必须用共享装配函数构造 fsAdapter");
  assert.ok(main.includes('createDxosFsAdapterForUserData(app.getPath("userData"))'), "必须落在 <userData>/dxos/fs");
  assert.ok(/let\s+dxosFsAdapter\s*=\s*null;/.test(main), "装配失败要能保持 null");
  assert.ok(/try\s*\{[\s\S]*?createDxosFsAdapterForUserData[\s\S]*?\}\s*catch/.test(main), "装配必须包 try/catch，失败不得假装可用");
  // 负向：不得再写死 fsAdapter: null
  assert.ok(!/fsAdapter:\s*null/.test(main), "main.cjs 不得再把 fsAdapter 写死 null");
  const skillCall = main.slice(main.indexOf("createSkillBundle({"), main.indexOf("registerSkillIpc({"));
  const agentCall = main.slice(main.indexOf("createAgentBundle({"), main.indexOf("registerAgentIpc({"));
  assert.match(skillCall, /fsAdapter:\s*dxosFsAdapter/, "createSkillBundle 必须收到 fsAdapter");
  assert.match(agentCall, /fsAdapter:\s*dxosFsAdapter/, "createAgentBundle 必须收到 fsAdapter");

  // 进程内真实构造（与 main.cjs 同一段代码）：两个 bundle 的健康报告都应 true。
  const dir = tempDir("dxos-fs-wiring-health-");
  const adapter = createDxosFsAdapterForUserData(dir);
  assert.equal(adapter.dataDir, path.join(dir, "dxos", "fs"));
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  const agent = createAgentBundle({ identityStore: store, authorization: makeAuth(), authStore: writeGrants, modelService: null, userDataDir: dir, fsAdapter: adapter });
  const agentHealth = await agent.execute("agent/health", {}, { sessionRef: "s1" });
  assert.equal(agentHealth.ok, true);
  assert.equal(agentHealth.value.dependencies.fsAdapter, true);
  const skill = createSkillBundle({ userDataDir: dir, identityStore: null, authorization: makeAuth(), fsAdapter: adapter });
  const skillHealth = await skill.execute("skill/health", {}, { sessionRef: "s1" });
  assert.equal(skillHealth.ok, true);
  assert.equal(skillHealth.value.dependencies.fsAdapter, true);
  store.close();
});

test("装配失败如实反映：目录建不出时保持 fsAdapter=null，健康 false 且文件工具结构化拒绝", async () => {
  const dir = tempDir("dxos-fs-wiring-fail-");
  const blocked = path.join(dir, "blocked");
  fs.writeFileSync(blocked, "x"); // <blocked>/dxos/fs 无法建出（ENOTDIR）
  let adapter = null;
  try { adapter = createDxosFsAdapterForUserData(blocked); } catch { adapter = null; } // 等价 main.cjs 的 catch
  assert.equal(adapter, null);

  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  const bundle = createAgentBundle({ identityStore: store, authorization: makeAuth(), authStore: writeGrants, modelService: null, userDataDir: dir, fsAdapter: adapter });
  const call = makeAgentCall(bundle);
  const health = await call("agent/health", {});
  assert.equal(health.value.dependencies.fsAdapter, false);
  const write = await call("agent/tool/call", { tool: "fs_write", rootNodeId: "nope", arguments: { path: "a.txt", content: "x" } });
  assert.equal(write.ok, false);
  assert.equal(write.error, agentDomain.AGENT_ERR_DEPENDENCY_UNAVAILABLE);
  assert.equal(write.detail.dependency, "fsAdapter");
  store.close();
});

// ---------------------------------------------------------------------------
// ② 端到端：agent/tool/call 的 fs_read / fs_write 走注入的 fsAdapter
// ---------------------------------------------------------------------------
test("端到端：agent:command → fs_write / fs_read 经注入 fsAdapter 在 <userData>/dxos/fs 真实落盘", async () => {
  const dir = tempDir("dxos-fs-wiring-e2e-");
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  const adapter = createDxosFsAdapterForUserData(dir);
  const root = adapter.createNode({ name: "项目", type: "folder", parentId: null });
  const bundle = createAgentBundle({ identityStore: store, authorization: makeAuth(), authStore: writeGrants, modelService: null, userDataDir: dir, fsAdapter: adapter });
  const call = makeAgentCall(bundle);

  const write = await call("agent/tool/call", { tool: "fs_write", rootNodeId: root.id, arguments: { path: "notes/a.txt", content: "hello" } });
  assert.equal(write.ok, true, JSON.stringify(write));
  assert.equal(adapter.findByPath(root.id, "notes/a.txt").content, "hello");

  const fsJson = path.join(dir, "dxos", "fs", "fs.json");
  assert.ok(fs.existsSync(fsJson), "fs.json 必须真实落在 <userData>/dxos/fs");
  assert.match(fs.readFileSync(fsJson, "utf8"), /a\.txt/);

  const read = await call("agent/tool/call", { tool: "fs_read", rootNodeId: root.id, arguments: { path: "notes/a.txt" } });
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(read.value.result.content, "hello");
  assert.equal(read.value.result.name, "a.txt");

  const health = await call("agent/health", {});
  assert.equal(health.value.dependencies.fsAdapter, true);
  store.close();
});

test("workspace 层：agent-runtime-deps 收到同一份 fsAdapter（project/run 之外的触盘能力也接通）", () => {
  const deps = require("../electron/agent-runtime-deps.cjs");
  const dir = tempDir("dxos-fs-wiring-deps-");
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  const adapter = createDxosFsAdapterForUserData(dir);
  createAgentBundle({ identityStore: store, authorization: makeAuth(), authStore: writeGrants, modelService: null, userDataDir: dir, fsAdapter: adapter });
  // agent-runtime-workspace.cjs:40-42 的 fs() 就是从这里取；收到即说明全部触盘能力接通。
  assert.equal(deps.requireDependency("fsAdapter"), adapter);

  // 未注入时仍是结构化依赖缺失（不静默降级）。
  createAgentBundle({ identityStore: store, authorization: makeAuth(), authStore: writeGrants, modelService: null, userDataDir: dir, fsAdapter: null });
  assert.equal(deps.hasDependency("fsAdapter"), false);
  assert.throws(() => deps.requireDependency("fsAdapter"), (error) => error.code === "AGENT_DEPENDENCY_UNAVAILABLE" && error.dependency === "fsAdapter");
  store.close();
});

// ---------------------------------------------------------------------------
// ③ 越界写仍被拒（围栏不因接线失效）
// ---------------------------------------------------------------------------
test("围栏不失效：'..' / 绝对路径 / 无效 Run 工作区三种越界写都被拒，且没有落盘", async () => {
  const dir = tempDir("dxos-fs-wiring-fence-");
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  const adapter = createDxosFsAdapterForUserData(dir);
  const root = adapter.createNode({ name: "项目", type: "folder", parentId: null });
  const bundle = createAgentBundle({ identityStore: store, authorization: makeAuth(), authStore: writeGrants, modelService: null, userDataDir: dir, fsAdapter: adapter });
  const call = makeAgentCall(bundle);

  const escape = await call("agent/tool/call", { tool: "fs_write", rootNodeId: root.id, arguments: { path: "../escape.txt", content: "x" } });
  assert.equal(escape.ok, false);
  assert.equal(escape.error, agentDomain.AGENT_ERR_INVALID_INPUT);

  const absolute = await call("agent/tool/call", { tool: "fs_write", rootNodeId: root.id, arguments: { path: "/tmp/openarc-escape.txt", content: "x" } });
  assert.equal(absolute.ok, false);
  assert.equal(absolute.error, agentDomain.AGENT_ERR_INVALID_INPUT);

  // runId 存在时，写操作必须先过真实 Run Workspace 门禁（agent-runtime-workspace.cjs:121）；
  // run 不存在 → 拒绝，不是绕过门禁直接写。
  const guarded = await call("agent/tool/call", { tool: "fs_write", runId: "run-not-exist", rootNodeId: root.id, arguments: { path: "ok.txt", content: "x" } });
  assert.equal(guarded.ok, false);
  assert.equal(guarded.error, agentDomain.AGENT_ERR_FORBIDDEN);

  assert.equal(adapter.findByPath(root.id, "escape.txt"), null);
  assert.equal(adapter.findByPath(root.id, "ok.txt"), null);
  store.close();
});

// ---------------------------------------------------------------------------
// ④ project/snapshot 与 project/run
// ---------------------------------------------------------------------------
const REVIEW_JSON = '{"complete":true,"reason":"账本与原始目标一致","missingActions":[]}';

/** project/run 的假适配器（真实 fallback / toolLoop / toolRunner 仍走产品代码）。 */
function makeProjectAgent(plan) {
  const requests = [];
  const events = [];
  const prepared = {
    trace: { runId: "run-b6d", steps: [] },
    systemPromptAdditions: [],
    route: {
      model: { providerId: "p1", model: "m-primary", provider: { id: "p1", name: "主站点" } },
      modelRoutes: [{ providerId: "p1", model: "m-primary", provider: { id: "p1", name: "主站点" } }],
      tools: [{ type: "function", function: { name: "fs_list", description: "列目录", parameters: { type: "object", properties: {} } } }, { type: "function", function: { name: "fs_read", description: "读文件", parameters: { type: "object", properties: {} } } }],
      toolDescriptors: [{ name: "fs_list", source: "file", risk: "read" }, { name: "fs_read", source: "file", risk: "read" }],
    },
  };
  const runtime = { runId: "run-b6d", signal: new AbortController().signal, prepared };
  const agentRuntime = {
    normalizeEnvelope: (raw, actor) => ({ ...raw, actorId: actor.id }),
    prepare: () => runtime, create: () => runtime,
    start: (id) => events.push(["start", id]), append: (id, type, data) => events.push([type, data]),
    complete: (id, result) => events.push(["complete", result]), fail: (id, error) => events.push(["fail", String((error && error.message) || error)]), cancel: (id) => events.push(["cancel", id]),
  };
  const usage = { beginAgentUsage: () => ({ id: "u1", startedAt: 1 }), finishAgentUsage: () => ({}) };
  const capability = {
    discoverCapabilityTargetsForUser: async () => ({}),
    normalizeCapabilityReferences: (value) => (value && typeof value === "object" ? value : {}),
    normalizeCapabilityRequirements: (value) => (value && typeof value === "object" ? value : {}),
    selectedCapabilityTargets: () => [],
  };
  let index = 0;
  const providerAdapter = {
    autoFallback: () => false,
    chatWithTools: async (request) => {
      requests.push(request);
      if (!request.tools || request.tools.length === 0) return { content: REVIEW_JSON };
      const response = plan[index] || { content: "已完成", toolCalls: [] };
      index += 1;
      return response;
    },
  };
  return { projectAgent: { agentRuntime, usage, capability, providerAdapter }, requests, events };
}

test("project/snapshot：写 .ccs-ai 快照经注入 fsAdapter 落到虚拟树（不再结构化缺 fsAdapter）", async () => {
  const dir = tempDir("dxos-fs-wiring-snapshot-");
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  const adapter = createDxosFsAdapterForUserData(dir);
  const root = adapter.createNode({ name: "快照项目", type: "folder", parentId: null });
  const bundle = createAgentBundle({ identityStore: store, authorization: makeAuth(), authStore: writeGrants, modelService: null, userDataDir: dir, fsAdapter: adapter });
  const call = makeAgentCall(bundle);

  const project = await call("agent/project/create", { name: "快照项目", rootNodeId: root.id });
  assert.equal(project.ok, true);
  const snapshot = await call("agent/project/snapshot", { projectId: project.value.project.id });
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  assert.equal(snapshot.value.written, true);
  const node = adapter.findByPath(root.id, ".ccs-ai/project.json");
  assert.ok(node, "project.json 必须写进虚拟树");
  const payload = JSON.parse(node.content);
  assert.equal(payload.projectId, project.value.project.id);
  store.close();
});

test("project/run：初始 fs_list 经注入 fsAdapter 读到真实项目内容，整轮跑完不再停在 fs_list 依赖缺失", async () => {
  const dir = tempDir("dxos-fs-wiring-run-");
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  const adapter = createDxosFsAdapterForUserData(dir);
  const root = adapter.createNode({ name: "运行项目", type: "folder", parentId: null });
  adapter.createNode({ name: "a.txt", type: "file", parentId: root.id, content: "hello from fs" });
  const { projectAgent, requests } = makeProjectAgent([
    { content: "", toolCalls: [{ id: "c1", name: "fs_read", arguments: JSON.stringify({ path: "a.txt" }) }] },
    { content: "已读取 a.txt", toolCalls: [] },
  ]);
  const bundle = createAgentBundle({ identityStore: store, authorization: makeAuth(), authStore: writeGrants, modelService: null, userDataDir: dir, fsAdapter: adapter, projectAgent });
  const call = makeAgentCall(bundle);

  const project = await call("agent/project/create", { name: "运行项目", rootNodeId: root.id });
  assert.equal(project.ok, true);
  const run = await call("agent/project/run", { projectId: project.value.project.id, instruction: "读取 a.txt" });
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.value.outcome.complete, true);
  assert.equal(run.value.outcome.text, "已读取 a.txt");
  assert.equal(run.value.outcome.filesChanged, false, "fs_read 是只读工具");

  // 初始清单来自真实 fs_list（虚拟树里的 a.txt），不是空/占位。
  const systems = requests.map((request) => String(request.system || "")).join("\n");
  assert.match(systems, /a\.txt/, "初始 fs_list 必须读到虚拟树里的 a.txt");
  // 工具 observation 回填：第二条计划请求能看到真实读取内容。
  assert.ok(requests.some((request) => Array.isArray(request.messages) && request.messages.some((message) => message.role === "tool" && /hello from fs/.test(String(message.content)))), "fs_read 结果必须回填给模型");
  store.close();
});

test("对照：未注入 fsAdapter 时 fs_list 仍结构化拒绝（dependency=fsAdapter），项目运行停在该步", async () => {
  const dir = tempDir("dxos-fs-wiring-run-bare-");
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  const { projectAgent } = makeProjectAgent([{ content: "不会走到这里", toolCalls: [] }]);
  const bundle = createAgentBundle({ identityStore: store, authorization: makeAuth(), authStore: writeGrants, modelService: null, userDataDir: dir, fsAdapter: null, projectAgent });
  const call = makeAgentCall(bundle);

  // agent/tool/call 的 fs_list 就是 project/run 的第一步，依赖名如实为 fsAdapter。
  const listed = await call("agent/tool/call", { tool: "fs_list", rootNodeId: "root-x", arguments: {} });
  assert.equal(listed.ok, false);
  assert.equal(listed.error, agentDomain.AGENT_ERR_DEPENDENCY_UNAVAILABLE);
  assert.equal(listed.detail.dependency, "fsAdapter");

  const project = await call("agent/project/create", { name: "裸项目", rootNodeId: "root-x" });
  assert.equal(project.ok, true);
  const run = await call("agent/project/run", { projectId: project.value.project.id, instruction: "读取 a.txt" });
  assert.equal(run.ok, false);
  assert.equal(run.error, agentDomain.AGENT_ERR_DEPENDENCY_UNAVAILABLE);
  assert.match(JSON.stringify(run), /fsAdapter/, "失败必须来自 fs_list 的 fsAdapter 依赖缺失");
  store.close();
});

// ---------------------------------------------------------------------------
// ⑤ skill/run 产物落盘
// ---------------------------------------------------------------------------
function makeMediaProviderAdapter() {
  const provider = { id: "p-media", name: "媒体站点", base_url: "http://127.0.0.1:1/v1", api_key: "FAKE_KEY", protocol: "openai", enabled: true, models: [{ model: "m-img", caps: ["image"], protocol: "openai" }] };
  return { firstUsable: () => provider, all: () => [provider], revealProvider: () => provider, autoFallback: () => false };
}
const makeMediaAdapter = () => ({ generateImages: async () => ({ images: [{ type: "b64", value: Buffer.from("IMG_BYTES").toString("base64") }] }) });

test("skill/run：产物经注入 fsAdapter 落到 <userData>/dxos/fs；未注入时仍 SKILL_DEPENDENCY_UNAVAILABLE", async () => {
  const dir = tempDir("dxos-fs-wiring-skill-");
  const adapter = createDxosFsAdapterForUserData(dir);
  const bundle = createSkillBundle({ userDataDir: dir, identityStore: null, authorization: makeAuth(), providerAdapter: makeMediaProviderAdapter(), mediaAdapter: makeMediaAdapter(), fsAdapter: adapter });
  const res = await bundle.execute("skill/run", { skillId: "generate_image", arguments: { prompt: "一只猫" } }, { sessionRef: "s1" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.images.length, 1);
  const saved = adapter.findByPath(null, "生成图片/" + res.value.images[0].name);
  assert.ok(saved, "产物必须落在虚拟树「生成图片」下");
  assert.ok(fs.existsSync(path.join(dir, "dxos", "fs", "fs.json")));
  assert.ok(fs.existsSync(path.join(dir, "dxos", "fs", "blobs")), "blob 必须真实落盘");

  // 未注入 fsAdapter：结构化拒绝保留（dependency 字段）。
  const bare = createSkillBundle({ userDataDir: tempDir("dxos-fs-wiring-skill-bare-"), identityStore: null, authorization: makeAuth(), providerAdapter: makeMediaProviderAdapter(), mediaAdapter: makeMediaAdapter(), fsAdapter: null });
  const missing = await bare.execute("skill/run", { skillId: "generate_image", arguments: { prompt: "一只猫" } }, { sessionRef: "s1" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "SKILL_DEPENDENCY_UNAVAILABLE");
  assert.equal(missing.detail.dependency, "fsAdapter");

  // B7 / B5 未装配的 mediaAdapter 依旧结构化拒绝，且报的就是它自己（fsAdapter 接线不掩盖别的缺失）。
  const noMedia = createSkillBundle({ userDataDir: tempDir("dxos-fs-wiring-skill-nomedia-"), identityStore: null, authorization: makeAuth(), providerAdapter: makeMediaProviderAdapter(), mediaAdapter: null, fsAdapter: adapter });
  const noMediaRes = await noMedia.execute("skill/run", { skillId: "generate_image", arguments: { prompt: "一只猫" } }, { sessionRef: "s1" });
  assert.equal(noMediaRes.ok, false);
  assert.equal(noMediaRes.error, "SKILL_DEPENDENCY_UNAVAILABLE");
  assert.equal(noMediaRes.detail.dependency, "mediaAdapter");
});
