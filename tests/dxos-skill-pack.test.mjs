/**
 * B4b · 技能包（ZIP）与导入 测试（离线、无第三方依赖）。
 *
 * 覆盖父任务点名的验收场景：
 *   1) buildZip 往返一致（store 可直读、Deflate 可被 inflateRawSync 解回）
 *   2) 自造最小技能包（内存构造 ZIP，不联网）可导入
 *   3) 包内危险路径（../ 越界、绝对路径、盘符）被拒
 *   4) bundled 预置包安装与状态文件
 *   5) 卸载清理对应自定义技能
 *   6) 非法 ZIP 结构化错误
 * 另含：frontmatter/资源上下文、依赖未注入时 AGENT_DEPENDENCY_UNAVAILABLE、翻译注入路径。
 *
 * 说明：electron/skill-store.cjs（B4a 并行波次）与 B7 Agent Workspace 均通过注入桩接入，
 * 因此本文件不依赖它们是否已落盘；真实模块解析逻辑见 skill-import.cjs/skill-pack.cjs。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { inflateRawSync } from "node:zlib";

const require = createRequire(import.meta.url);
const skillImport = require("../electron/skill-import.cjs");
const skillPack = require("../electron/skill-pack.cjs");

const tempDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** 内存技能存储桩：形状对齐 B4a electron/skill-store.cjs 冻结契约。 */
function makeSkillStore() {
  const skills = new Map();
  const deletedPacks = [];
  return {
    skills,
    deletedPacks,
    listSkills: () => [...skills.values()],
    saveCustomSkill: (input) => {
      const skill = { ...input };
      skills.set(skill.id, skill);
      return skill;
    },
    deleteCustomSkillsForPack: (packId) => {
      deletedPacks.push(packId);
      let removed = 0;
      for (const [id, skill] of skills) {
        if (skill.source && skill.source.metadata && skill.source.metadata.packId === packId) {
          skills.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
    resolveChatTarget: () => ({ provider: { id: "stub-provider" }, model: "stub-model" }),
    updateCustomSkillDisplay: (id, name, description) => {
      const skill = skills.get(id);
      if (skill) {
        skill.name = name;
        if (description !== undefined) skill.description = description;
      }
      return skill;
    },
  };
}

function makeAgentWorkspace() {
  const state = { registered: [], deletedProfiles: [], deletedPacks: [] };
  return {
    state,
    registerAgentWorkspace: (pack, root) => {
      state.registered.push({ id: pack.id, root });
      return null; // 桩：不识别多 Agent 工作空间 → 包按 skill-collection 处理
    },
    deleteAgentWorkspaceProfiles: (ids) => { state.deletedProfiles.push(...(ids || [])); },
    deleteAgentWorkspaceProfilesForPack: (packId) => { state.deletedPacks.push(packId); },
  };
}

/** 每个用例一份干净的注入环境：临时 <userData>/dxos 布局 + 桩适配器。 */
function makeEnv() {
  const userDataDir = tempDir("dxos-skill-pack-");
  const bundledDir = path.join(userDataDir, "bundled-skill-packages");
  fs.mkdirSync(bundledDir, { recursive: true });
  const store = makeSkillStore();
  const workspace = makeAgentWorkspace();
  skillImport.resetSkillImportForTests();
  skillPack.resetSkillPackForTests();
  skillPack.configureSkillPack({ userDataDir, bundledDir, skillStore: store, agentWorkspace: workspace });
  return { userDataDir, bundledDir, store, workspace, dxosRoot: path.join(userDataDir, "dxos") };
}

/** 手工解析 buildZip 产物：返回每个条目的方法、压缩大小与本地数据起点。 */
function centralEntries(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, "EOCD not found");
  const count = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const filenameSize = buffer.readUInt16LE(pos + 28);
    const extraSize = buffer.readUInt16LE(pos + 30);
    const commentSize = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.subarray(pos + 46, pos + 46 + filenameSize).toString("utf8");
    const localNameSize = buffer.readUInt16LE(localOffset + 26);
    const localExtraSize = buffer.readUInt16LE(localOffset + 28);
    out.push({ name, method, compressedSize, dataStart: localOffset + 30 + localNameSize + localExtraSize });
    pos = pos + 46 + filenameSize + extraSize + commentSize;
  }
  return out;
}

function standardPackage(overrides = {}) {
  const manifest = {
    format: "ccs-skill/v1",
    id: "std_1",
    name: "标准技能",
    description: "标准包描述",
    systemPrompt: "你是标准技能",
    ...overrides,
  };
  return skillImport.buildZip([
    { name: "skill.json", data: Buffer.from(JSON.stringify(manifest)) },
    { name: "SKILL.md", data: Buffer.from("# 标准") },
  ]);
}

// ── 1. buildZip 往返 ─────────────────────────────────────────────────────
test("buildZip 往返：store 原样可读，Deflate 可被 inflateRawSync 解回", () => {
  const payload = Buffer.from("往返负载：" + "x".repeat(800));
  const entries = [
    { name: "a/SKILL.md", data: payload },
    { name: "skill.json", data: Buffer.from('{"format":"ccs-skill/v1"}') },
  ];

  const stored = skillImport.buildZip(entries);
  const storedEntries = centralEntries(stored);
  assert.equal(storedEntries[0].method, 0);
  assert.deepEqual(
    stored.subarray(storedEntries[0].dataStart, storedEntries[0].dataStart + storedEntries[0].compressedSize),
    payload,
  );
  const storedPreview = skillImport.previewSkillPackage(stored);
  assert.equal(storedPreview.length, 1);
  assert.equal(storedPreview[0].sourcePath, "a/SKILL.md");
  assert.equal(storedPreview[0].systemPrompt, payload.toString("utf8"));

  const deflated = skillImport.buildZip([{ name: "a/SKILL.md", data: payload }], { compress: true });
  const deflatedEntries = centralEntries(deflated);
  assert.equal(deflatedEntries[0].method, 8);
  const restored = inflateRawSync(
    deflated.subarray(deflatedEntries[0].dataStart, deflatedEntries[0].dataStart + deflatedEntries[0].compressedSize),
  );
  assert.deepEqual(restored, payload);
  assert.equal(skillImport.previewSkillPackage(deflated)[0].systemPrompt, payload.toString("utf8"));
});

// ── 2. 最小技能包导入 ────────────────────────────────────────────────────
test("导入最小技能包：frontmatter 包与 skill.json 标准包（内存构造，不联网）", () => {
  const env = makeEnv();
  const markdown = "---\nname: 演示技能\ndescription: 用于测试导入流程的技能\n---\n\n# 演示\n\n正文内容。";
  const zip = skillImport.buildZip([{ name: "demo/SKILL.md", data: Buffer.from(markdown) }]);

  const preview = skillImport.previewSkillPackage(zip);
  assert.equal(preview.length, 1);
  assert.equal(preview[0].id, "demo");

  const result = skillImport.importSkillPackage(zip);
  assert.equal(result.skills.length, 1);
  assert.equal(result.skill.id, "demo");
  assert.equal(result.skill.name, "演示技能");
  assert.equal(result.skill.description, "用于测试导入流程的技能");
  assert.equal(result.skill.systemPrompt, markdown);
  assert.equal(result.skill.source.format, "agentskills/v1");
  assert.equal(result.skill.source.instructions, markdown);
  assert.equal(env.store.skills.size, 1);

  const std = skillImport.importSkillPackage(standardPackage());
  assert.equal(std.skill.id, "std_1");
  assert.equal(std.skill.systemPrompt, "你是标准技能");
});

test("导入带 references/openai 元数据的包：资源与隐式调用开关进入快照", () => {
  makeEnv();
  const markdown = '---\nname: "带引号名字"\ndescription: >\n  第一行\n  第二行\n---\n\n# 标题\n\n参见 references/guide.md 后继续。';
  const zip = skillImport.buildZip([
    { name: "pkg/SKILL.md", data: Buffer.from(markdown) },
    { name: "pkg/references/guide.md", data: Buffer.from("# 指南") },
    { name: "pkg/agents/openai.yaml", data: Buffer.from("allow_implicit_invocation: true\ndisplay_name: 展示名") },
  ]);
  const doc = skillImport.skillDocumentFromPackage(zip, "pkg/SKILL.md");
  assert.equal(doc.source.metadata.name, "带引号名字");
  assert.equal(doc.source.metadata.description, "第一行 第二行");
  assert.equal(doc.source.metadata.displayName, "展示名");
  assert.equal(doc.allowImplicitInvocation, true);
  assert.ok(doc.source.files.some((file) => file.path === "references/guide.md"));
  assert.ok(doc.markdown.includes("guide.md"));
  assert.equal(doc.source.sourcePath, "pkg/SKILL.md");
});

// ── 3. 危险路径 ──────────────────────────────────────────────────────────
test("包内危险路径（../ 越界 / 绝对路径 / 盘符）被拒", () => {
  const env = makeEnv();
  const dangerous = ["../evil.md", "a/../../evil.md", "/etc/passwd.md", "C:/evil.md", "..\\evil.md"];
  for (const name of dangerous) {
    const zip = skillImport.buildZip([{ name, data: Buffer.from("x") }]);
    assert.throws(
      () => skillPack.importSkillPack(zip, "evil.zip"),
      (error) => {
        assert.equal(error.code, "DXOS_ERR_INVALID_INPUT");
        assert.equal(error.kind, "SKILL_PACK_FAILED");
        assert.equal(error.reason, "UNSAFE_PATH");
        return true;
      },
      "应拒绝危险路径：" + name,
    );
    assert.throws(() => skillPack.readZipEntries(zip), /不安全的路径|不安全路径/, "readZip 也应拒绝：" + name);
  }
  assert.throws(() => skillPack.safePath(".."), /不安全路径/);
  assert.equal(skillPack.safePath("./ok/SKILL.md"), "ok/SKILL.md");
  // 确认危险包没有落盘
  assert.equal(skillPack.listSkillPacks().length, 0);
  assert.ok(!fs.existsSync(path.join(env.dxosRoot, "skill-packs", "index.json")));
});

// ── 4. bundled 预置包安装与状态文件 ─────────────────────────────────────
test("bundled 包安装：落盘、状态文件、幂等", () => {
  const env = makeEnv();
  const userDataDir = env.userDataDir;
  const bundledDir = tempDir("dxos-skill-bundled-");
  skillPack.resetSkillPackForTests();
  skillImport.resetSkillImportForTests();
  skillPack.configureSkillPack({
    userDataDir,
    bundledDir,
    skillStore: makeSkillStore(),
    agentWorkspace: makeAgentWorkspace(),
    bundledSpecs: [{
      key: "test-pack",
      version: 1,
      id: "test-id",
      name: "Test Pack",
      sourceName: "Test Pack",
      directory: "test-pack",
      expectedSkillCount: 1,
      matchName: null,
    }],
    clock: () => 1_700_000_000_000,
  });

  const zip = skillImport.buildZip([
    { name: "test-pack/SKILL.md", data: Buffer.from("---\nname: 测试技能\ndescription: 用于测试预置安装的技能\n---\n\n# 正文") },
  ]);
  fs.writeFileSync(path.join(bundledDir, "test-pack.zip"), zip);

  assert.equal(skillPack.ensureBundledSkillPacks(), 1, "首次应安装 1 个预置包");
  assert.equal(skillPack.ensureBundledSkillPacks(), 0, "第二次应跳过已安装版本");

  const packs = skillPack.listSkillPacks();
  assert.equal(packs.length, 1);
  assert.equal(packs[0].id, "test-id");
  assert.equal(packs[0].skillCount, 1);
  assert.equal(packs[0].skillDocs.length, 1);
  assert.equal(packs[0].skillDocs[0].path, "test-pack/SKILL.md");

  const state = JSON.parse(fs.readFileSync(path.join(env.dxosRoot, "bundled-skill-packs.json"), "utf8"));
  assert.deepEqual(state.installed, { "test-pack": 1 });
  assert.deepEqual(state.installing, {});
  assert.deepEqual(state.failed, {});
  assert.ok(fs.existsSync(path.join(env.dxosRoot, "skill-packs", "index.json")));
  assert.ok(fs.existsSync(path.join(env.dxosRoot, "skill-packs", "test-id", "source", "test-pack", "SKILL.md")));
});

test("bundled 包：ZIP 缺失时静默跳过，不写状态", () => {
  const env = makeEnv();
  skillPack.resetSkillPackForTests();
  skillImport.resetSkillImportForTests();
  skillPack.configureSkillPack({
    userDataDir: env.userDataDir,
    bundledDir: env.bundledDir,
    skillStore: makeSkillStore(),
    agentWorkspace: makeAgentWorkspace(),
    bundledSpecs: [{ key: "missing", version: 1, id: "missing-id", name: "Missing", sourceName: "Missing", directory: "nope", expectedSkillCount: 1 }],
  });
  assert.equal(skillPack.ensureBundledSkillPacks(), 0);
  const state = JSON.parse(fs.readFileSync(path.join(env.dxosRoot, "bundled-skill-packs.json"), "utf8"));
  assert.deepEqual(state.installed, {});
});

// ── 5. 卸载清理 ──────────────────────────────────────────────────────────
test("卸载 Skill 包：清理包目录、索引、Agent Profile 与对应自定义技能", () => {
  const env = makeEnv();
  // 让 Agent Workspace 适配器声明 profile：验证 importRegisteredSkillPack 会把 agentProfileIds 落进索引，
  // deleteSkillPack 再从索引读取并精确清理（而不是依赖内存变量）。
  env.workspace.registerAgentWorkspace = () => ({
    kind: "agent-workspace",
    agentCount: 2,
    entryAgent: "orchestrator",
    agentProfileIds: ["profile-x", "profile-y"],
    orchestratorSkillId: "orch",
  });
  const { pack, skills } = skillPack.importRegisteredSkillPack(standardPackage({ id: "pack_a" }), "我的包.zip");
  assert.deepEqual(pack.agentProfileIds, ["profile-x", "profile-y"]);
  assert.equal(pack.kind, "agent-workspace");
  assert.equal(skills.length, 1);
  assert.equal(env.store.skills.size, 1);
  assert.equal(env.store.listSkills()[0].source.metadata.packId, pack.id);

  assert.equal(skillPack.deleteSkillPack(pack.id), true);
  assert.deepEqual(env.store.deletedPacks, [pack.id]);
  assert.equal(env.store.skills.size, 0);
  assert.equal(skillPack.listSkillPacks().length, 0);
  assert.ok(!fs.existsSync(skillPack.packageRoot(pack.id)));
  assert.deepEqual(env.workspace.state.deletedProfiles, ["profile-x", "profile-y"]);
  assert.deepEqual(env.workspace.state.deletedPacks, [pack.id]);
  assert.equal(skillPack.deleteSkillPack(pack.id), false, "重复卸载应返回 false");
});

// ── 6. 非法 ZIP 结构化错误 ──────────────────────────────────────────────
test("非法 ZIP / 不支持的压缩方式 / 非法 manifest 均返回结构化错误", () => {
  const env = makeEnv();
  for (const bad of [Buffer.from("not a zip"), Buffer.alloc(0), Buffer.from([0x50, 0x4b, 0x03, 0x04])]) {
    assert.throws(
      () => skillImport.previewSkillPackage(bad),
      (error) => {
        assert.equal(error.name, "DxosError");
        assert.equal(error.code, "DXOS_ERR_INVALID_INPUT");
        assert.equal(error.kind, "SKILL_IMPORT_FAILED");
        assert.equal(error.reason, "INVALID_ZIP");
        return true;
      },
    );
    assert.throws(() => skillPack.importSkillPack(bad, "bad.zip"), (error) => {
      assert.equal(error.code, "DXOS_ERR_INVALID_INPUT");
      assert.equal(error.kind, "SKILL_PACK_FAILED");
      assert.equal(error.reason, "INVALID_ZIP");
      return true;
    });
  }

  // 不支持的压缩方式：把本地头与中心目录的 method 改成 12
  const zip = skillImport.buildZip([{ name: "SKILL.md", data: Buffer.from("# x") }]);
  const patched = Buffer.from(zip);
  const eocd = patched.length - 22;
  const centralOffset = patched.readUInt32LE(eocd + 16);
  const localOffset = patched.readUInt32LE(centralOffset + 42);
  patched.writeUInt16LE(12, centralOffset + 10);
  patched.writeUInt16LE(12, localOffset + 8);
  assert.throws(() => skillPack.readZipEntries(patched), (error) => error.reason === "UNSUPPORTED_COMPRESSION");
  assert.throws(() => skillImport.previewSkillPackage(patched), (error) => error.reason === "UNSUPPORTED_COMPRESSION");

  // manifest 非法
  const badFormat = skillImport.buildZip([
    { name: "skill.json", data: Buffer.from('{"format":"unknown/v9","systemPrompt":"x"}') },
    { name: "SKILL.md", data: Buffer.from("# x") },
  ]);
  assert.throws(() => skillImport.previewSkillPackage(badFormat), (error) => error.reason === "INVALID_MANIFEST");
  const badJson = skillImport.buildZip([
    { name: "skill.json", data: Buffer.from("{not json") },
    { name: "SKILL.md", data: Buffer.from("# x") },
  ]);
  assert.throws(() => skillImport.previewSkillPackage(badJson), (error) => error.reason === "INVALID_MANIFEST");
  const noPrompt = skillImport.buildZip([
    { name: "skill.json", data: Buffer.from('{"format":"ccs-skill/v1"}') },
    { name: "SKILL.md", data: Buffer.from("# x") },
  ]);
  assert.throws(() => skillImport.previewSkillPackage(noPrompt), (error) => error.reason === "INVALID_MANIFEST");
  const noSkill = skillImport.buildZip([{ name: "readme.md", data: Buffer.from("hi") }]);
  assert.throws(() => skillImport.previewSkillPackage(noSkill), (error) => error.reason === "NO_SKILL_FOUND");
  void env;
});

// ── 7. 依赖未注入 ────────────────────────────────────────────────────────
test("依赖适配器缺失：技能存储 / 模型适配器 / Agent Workspace 均结构化失败", async () => {
  const userDataDir = tempDir("dxos-skill-dep-");
  const zip = skillImport.buildZip([{ name: "demo/SKILL.md", data: Buffer.from("---\nname: d\ndescription: 描述文本足够长\n---\n# x") }]);

  // 1) 技能存储适配器缺少 saveCustomSkill → AGENT_DEPENDENCY_UNAVAILABLE，不伪造成功
  skillPack.resetSkillPackForTests();
  skillImport.resetSkillImportForTests();
  skillPack.configureSkillPack({ userDataDir, skillStore: {} });
  assert.throws(() => skillImport.importSkillPackage(zip), (error) => {
    assert.equal(error.code, "AGENT_DEPENDENCY_UNAVAILABLE");
    assert.equal(error.name, "AgentDependencyUnavailableError");
    assert.equal(error.dependency, "skillStore.saveCustomSkill");
    return true;
  });
  assert.throws(() => skillPack.importRegisteredSkillPack(zip, "demo.zip"), (error) => error.code === "AGENT_DEPENDENCY_UNAVAILABLE");
  assert.equal(skillPack.listSkillPacks().length, 0, "失败导入不应残留索引");

  // 2) 技能存储可用但 providerAdapter 缺少 call → 翻译结构化失败
  const store = makeSkillStore();
  skillPack.configureSkillPack({ userDataDir, skillStore: store, agentWorkspace: makeAgentWorkspace() });
  const pack = skillPack.importSkillPack(standardPackage({ id: "pack_dep" }), "dep.zip");
  skillPack.registerSkillPackRoutes(pack, standardPackage({ id: "pack_dep" }));
  skillPack.configureSkillPack({ providerAdapter: {} });
  await assert.rejects(
    () => skillPack.translateSkillPackDisplay(pack.id),
    (error) => error.code === "AGENT_DEPENDENCY_UNAVAILABLE" && error.dependency === "providerAdapter.callChat",
  );

  // 3) Agent Workspace 适配器缺失 → importRegisteredSkillPack 结构化失败并回滚
  skillPack.configureSkillPack({ agentWorkspace: null });
  assert.throws(() => skillPack.importRegisteredSkillPack(zip, "demo2.zip"), (error) => {
    assert.equal(error.code, "AGENT_DEPENDENCY_UNAVAILABLE");
    assert.equal(error.dependency, "agentWorkspace");
    return true;
  });
  assert.ok(!skillPack.listSkillPacks().some((item) => item.name === "demo2"), "失败导入应已回滚");
});

// ── 8. 翻译注入路径 ──────────────────────────────────────────────────────
test("translateSkillPackDisplay：经注入 providerAdapter.callChat 更新包名与技能显示名", async () => {
  const env = makeEnv();
  const pack = skillPack.importSkillPack(standardPackage({ id: "pack_t" }), "translatable.zip");
  const routes = skillPack.registerSkillPackRoutes(pack, standardPackage({ id: "pack_t" }));
  const skillId = routes[0].id;

  let captured = null;
  skillPack.configureSkillPack({
    providerAdapter: {
      callChat: async (provider, model, input, params, timeoutMs) => {
        captured = { provider, model, input, params, timeoutMs };
        return { text: "前缀说明 " + JSON.stringify({ packName: "新包名", skills: [{ id: skillId, name: "新技能名", description: "新简介" }] }) + " 后缀" };
      },
    },
  });

  const result = await skillPack.translateSkillPackDisplay(pack.id);
  assert.equal(result.model, "stub-model");
  assert.equal(skillPack.getPack(pack.id).name, "新包名");
  assert.equal(env.store.skills.get(skillId).name, "新技能名");
  assert.equal(env.store.skills.get(skillId).description, "新简介");
  assert.equal(captured.provider.id, "stub-provider");
  assert.equal(captured.timeoutMs, 120_000);
  assert.ok(captured.input.prompt.includes("packName"));

  // callChat 返回非法 JSON → 结构化失败
  skillPack.configureSkillPack({ providerAdapter: { callChat: async () => ({ text: "没有 JSON" }) } });
  await assert.rejects(() => skillPack.translateSkillPackDisplay(pack.id), (error) => error.reason === "BAD_TRANSLATION");
});

// ── 9. 包内文档与上下文 ──────────────────────────────────────────────────
test("listPackSkillDocs / readPackSkillDoc / buildPackSkillContext 拒绝越界并带出资源", () => {
  const env = makeEnv();
  const zip = skillImport.buildZip([
    { name: "pack/SKILL.md", data: Buffer.from("---\nname: ctx\ndescription: 上下文技能描述文本\n---\n\n参见 references/a.md\n更多正文") },
    { name: "pack/references/a.md", data: Buffer.from("# 资源 A") },
  ]);
  const pack = skillPack.importSkillPack(zip, "ctx.zip");
  const docs = skillPack.listPackSkillDocs(pack.id);
  assert.equal(docs.length, 1);
  // commonTopLevel 会剥掉唯一公共顶层目录 "pack/"，这是源 skillPacks.ts:344-353 的行为
  assert.equal(docs[0].path, "SKILL.md");
  const context = skillPack.buildPackSkillContext(skillPack.sourceRoot(pack.id), "SKILL.md");
  assert.ok(context.context.includes("资源 A"));
  assert.equal(context.resources.length, 1);
  assert.throws(() => skillPack.readPackSkillDoc(pack.id, "../../secret.md"), /文档不存在/);
  void env;
});

// ── 10. 与真实 skill-store.cjs 集成（B4a 并行波次产物；离线） ────────────
test("集成真实 electron/skill-store.cjs：导入→注册路由→落盘→卸载", () => {
  const skillStore = require("../electron/skill-store.cjs");
  const userDataDir = tempDir("dxos-skill-integ-");
  const dataDir = path.join(userDataDir, "dxos");
  skillStore.resetSkillStoreForTests();
  skillStore.configureSkillStore({ dataDir, clock: () => 1_700_000_000_000 });
  skillImport.resetSkillImportForTests();
  skillPack.resetSkillPackForTests();
  // 不注入 skillStore：让 skill-import/skill-pack 惰性 require 真实模块
  // 同时验证 dataDir（= <userData>/dxos）与 configureSkillStore 的 dataDir 契约一致
  skillPack.configureSkillPack({ dataDir, agentWorkspace: makeAgentWorkspace() });

  const zip = skillImport.buildZip([
    { name: "mini/SKILL.md", data: Buffer.from("---\nname: 集成技能\ndescription: 与真实技能存储协同工作的技能\n---\n\n# 集成\n\n正文") },
  ]);
  const pack = skillPack.importSkillPack(zip, "integration.zip");
  const routes = skillPack.registerSkillPackRoutes(pack, zip);
  assert.equal(routes.length, 1);

  const saved = skillStore.listSkills().find((skill) => skill.id === routes[0].id);
  assert.ok(saved, "真实技能存储中应存在该自定义技能");
  assert.equal(saved.source.metadata.packId, pack.id);
  assert.equal(saved.source.format, "agentskills/v1");
  assert.equal(saved.name, "集成技能");
  assert.ok(fs.existsSync(path.join(dataDir, "skills.json")));

  const before = skillStore.listSkills().length;
  assert.equal(skillPack.deleteSkillPack(pack.id), true);
  assert.equal(skillStore.listSkills().length, before - 1);
  assert.ok(!skillStore.listSkills().some((skill) => skill.id === routes[0].id));
  skillStore.resetSkillStoreForTests();
});
