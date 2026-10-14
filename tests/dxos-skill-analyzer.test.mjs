/**
 * B4c · 技能分析（skill-analyzer.cjs）与工作区技能（skill-workspace.cjs）离线测试。
 *
 * 覆盖：
 *   1) analyzeSkillDocument 的推断分支：id 归一化、能力白名单、步骤 uses、resources、v2 结构
 *   2) 失败路径：无工具调用 / 结构化结果无法解析 / 无工作流步骤 / 依赖缺失
 *   3) planPackRunArgs 参数数组清洗与工具缺失
 *   4) runPackAiTest 多目标回退与全部失败聚合
 *   5) 工作区技能：检测 / 注册落库（临时 SQLite）/ 列举 / 按 id 与按 pack 停用
 *
 * 全部离线：模型出口用注入桩；workspace 用 node:sqlite 内存库 + 临时目录真实文件。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const analyzer = require("../electron/skill-analyzer.cjs");
const skillWorkspace = require("../electron/skill-workspace.cjs");
const skillStore = require("../electron/skill-store.cjs");
const builtinTools = require("../electron/agent-builtin-tools.cjs");
const foundationSchema = require("../electron/dxos-foundation-schema.cjs");

const tempDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeSkillStore() {
  return {
    PROCEDURE_BASE_SKILL_IDS: skillStore.PROCEDURE_BASE_SKILL_IDS,
    resolveChatTarget: () => ({ provider: { id: "prov-1", name: "测试站点" }, model: "m-1" }),
  };
}

/** 用行为函数装配 analyzer；行为可返回结构化对象 / 原始 JSON 串 / "NO_TOOL"。 */
function configureWith(behavior) {
  const calls = [];
  const modelAdapter = {
    call: async (request) => {
      calls.push(request);
      const payload = typeof behavior === "function" ? behavior(request, calls.length) : behavior;
      if (payload instanceof Error) throw payload;
      if (payload === "NO_TOOL") return { ok: true, text: "无工具结果" };
      if (payload === "FAIL") return { ok: false, error: "PROVIDER_PROTOCOL_ERROR" };
      return { ok: true, text: "", toolCalls: [{ id: "c1", name: "submit_skill_analysis", arguments: typeof payload === "string" ? payload : JSON.stringify(payload) }] };
    },
  };
  analyzer.configureSkillAnalyzer({ modelAdapter, skillStore: makeSkillStore(), builtinTools });
  return { modelAdapter, calls };
}

function validPayload(overrides = {}) {
  return {
    id: "Weekly Report",
    name: "周报生成",
    description: "生成周报",
    triggers: ["写周报", "整理周会"],
    inputs: ["工作要点"],
    steps: [{ title: "收集", detail: "收集要点" }, { title: "生图", detail: "生成配图", uses: "generate_image" }],
    allowedTools: ["generate_image", "writing"],
    readsFiles: true,
    writesFiles: true,
    network: false,
    sensitive: [],
    output: "周报文件",
    checks: ["检查格式"],
    systemPrompt: "你是周报助手",
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════
// skill-analyzer.cjs
// ══════════════════════════════════════════════════════════════════════

test("analyzer 推断：id 归一化 / 能力白名单 / 步骤 uses / v2 结构与 systemPrompt", async () => {
  analyzer.resetSkillAnalyzerForTests();
  const { calls } = configureWith(validPayload());
  const result = await analyzer.analyzeSkillDocument("# 文档正文", "周报.md");

  assert.equal(result.skill.id, "weekly_report");
  assert.equal(result.skill.name, "周报生成");
  assert.equal(result.skill.kind, "procedure");
  assert.equal(result.skill.v2.version, 1);
  assert.equal(result.skill.v2.sourceName, "周报.md");
  assert.deepEqual(result.skill.v2.allowedTools, ["generate_image", "writing"]);
  assert.deepEqual(result.skill.v2.steps.map((s) => s.title), ["收集", "生图"]);
  assert.equal(result.skill.v2.steps[1].uses, "generate_image");
  assert.equal("uses" in result.skill.v2.steps[0], false);
  assert.equal(result.skill.v2.permissions.readsFiles, true);
  assert.equal(result.skill.v2.permissions.network, false);
  assert.deepEqual(result.warnings, []);

  // systemPrompt = 模型提炼 + 工作流 + 完成前自查
  assert.match(result.skill.systemPrompt, /你是周报助手/);
  assert.match(result.skill.systemPrompt, /工作流（按序执行）：/);
  assert.match(result.skill.systemPrompt, /2\. 生图【用 generate_image】：生成配图/);
  assert.match(result.skill.systemPrompt, /完成前自查：/);

  // 模型出口：provider 选型来自技能存储，调用用 providerId + 分析工具
  assert.equal(calls.length, 1);
  assert.equal(calls[0].providerId, "prov-1");
  assert.equal(calls[0].model, "m-1");
  assert.equal(calls[0].tools[0].function.name, "submit_skill_analysis");
  assert.match(calls[0].messages[0].content, /第三方 Skill 文档（来源：周报.md）/);
});

test("analyzer 警告：忽略不存在的能力 / 额外联网 / 敏感动作", async () => {
  analyzer.resetSkillAnalyzerForTests();
  configureWith(validPayload({ allowedTools: ["writing", "not_a_tool"], steps: [{ title: "写文案", detail: "直接用模型写" }], network: true, sensitive: ["发送消息", "删除数据"] }));
  const result = await analyzer.analyzeSkillDocument("doc", "x.md");

  assert.deepEqual(result.skill.v2.allowedTools, ["writing"]);
  assert.equal(result.skill.v2.permissions.network, true);
  assert.deepEqual(result.skill.v2.permissions.sensitive, ["发送消息", "删除数据"]);
  assert.equal(result.warnings.length, 3);
  assert.match(result.warnings[0], /忽略了不存在的能力：not_a_tool/);
  assert.match(result.warnings[1], /联网（如爬网页）/);
  assert.match(result.warnings[2], /敏感动作声明：发送消息、删除数据/);
});

test("analyzer 步骤 uses：只保留基础能力；白名单漏掉的基础能力自动补齐", async () => {
  analyzer.resetSkillAnalyzerForTests();
  configureWith(validPayload({
    allowedTools: [],
    steps: [
      { title: "a", detail: "d", uses: "midjourney" },
      { title: "b", detail: "d", uses: "fs_read" },
      { title: "c", detail: "d", uses: "hacking" },
    ],
  }));
  const result = await analyzer.analyzeSkillDocument("doc", "x.md");

  assert.deepEqual(result.skill.v2.steps.filter((s) => s.uses).map((s) => s.uses), ["midjourney"]);
  assert.deepEqual(result.skill.v2.allowedTools, ["midjourney"]);
});

test("analyzer 白名单接受内置文件工具名（fs_read）且不产生警告", async () => {
  analyzer.resetSkillAnalyzerForTests();
  configureWith(validPayload({ allowedTools: ["fs_read", "fs_write", "writing"], steps: [{ title: "读文件", detail: "读取项目文件" }] }));
  const result = await analyzer.analyzeSkillDocument("doc", "x.md");

  assert.deepEqual(result.skill.v2.allowedTools, ["fs_read", "fs_write", "writing"]);
  assert.deepEqual(result.warnings, []);
});

test("analyzer 失败：模型未返回 submit_skill_analysis 工具调用", async () => {
  analyzer.resetSkillAnalyzerForTests();
  configureWith("NO_TOOL");
  await assert.rejects(() => analyzer.analyzeSkillDocument("doc", "x.md"), /模型未返回结构化结果/);
});

test("analyzer 失败：结构化结果不是合法 JSON", async () => {
  analyzer.resetSkillAnalyzerForTests();
  configureWith("{不是 JSON");
  await assert.rejects(() => analyzer.analyzeSkillDocument("doc", "x.md"), /结构化结果无法解析/);
});

test("analyzer 失败：没有识别出工作流步骤", async () => {
  analyzer.resetSkillAnalyzerForTests();
  configureWith(validPayload({ steps: [{ detail: "无标题" }, { title: "", detail: "空标题" }] }));
  await assert.rejects(() => analyzer.analyzeSkillDocument("doc", "x.md"), /没有识别出工作流步骤/);
});

test("analyzer 依赖缺失：未注入 modelAdapter 时抛结构化 AGENT_DEPENDENCY_UNAVAILABLE", async () => {
  analyzer.resetSkillAnalyzerForTests();
  analyzer.configureSkillAnalyzer({ skillStore: makeSkillStore(), builtinTools });
  await assert.rejects(() => analyzer.analyzeSkillDocument("doc", "x.md"), (error) => {
    assert.equal(error.code, "AGENT_DEPENDENCY_UNAVAILABLE");
    assert.equal(error.dependency, "modelAdapter");
    return true;
  });
});

test("analyzer 模型出口失败：provider 返回 ok=false 时抛调用错误", async () => {
  analyzer.resetSkillAnalyzerForTests();
  configureWith("FAIL");
  await assert.rejects(() => analyzer.analyzeSkillDocument("doc", "x.md"), /技能分析模型调用失败：PROVIDER_PROTOCOL_ERROR/);
});

test("planPackRunArgs：清洗参数数组并回填 note/blocked", async () => {
  analyzer.resetSkillAnalyzerForTests();
  const calls = [];
  const modelAdapter = {
    call: async (request) => {
      calls.push(request);
      return { ok: true, toolCalls: [{ id: "a1", name: "submit_run_args", arguments: JSON.stringify({ args: ["--prompt", "一只猫", "--n", "2"], note: "默认 2 张", blocked: "" }) }] };
    },
  };
  analyzer.configureSkillAnalyzer({ modelAdapter, skillStore: makeSkillStore(), builtinTools });
  const result = await analyzer.planPackRunArgs({ instruction: "生成两只猫的图", helpText: "--prompt --n", docs: "" });

  assert.deepEqual(result.args, ["--prompt", "一只猫", "--n", "2"]);
  assert.equal(result.note, "默认 2 张");
  assert.equal(result.blocked, "");
  assert.equal(calls[0].tools[0].function.name, "submit_run_args");
});

test("planPackRunArgs 失败：未返回 submit_run_args", async () => {
  analyzer.resetSkillAnalyzerForTests();
  const modelAdapter = { call: async () => ({ ok: true, text: "直接回答", toolCalls: [] }) };
  analyzer.configureSkillAnalyzer({ modelAdapter, skillStore: makeSkillStore(), builtinTools });
  await assert.rejects(() => analyzer.planPackRunArgs({ instruction: "x", helpText: "", docs: "" }), /未能生成运行参数/);
});

test("runPackAiTest：按有序目标回退，记录失败站点", async () => {
  analyzer.resetSkillAnalyzerForTests();
  const seen = [];
  const modelAdapter = {
    call: async (request) => {
      seen.push(request.model);
      if (request.model === "m-1") throw Object.assign(new Error("HTTP 500 upstream error"), { code: "PROVIDER_PROTOCOL_ERROR" });
      return { ok: true, text: "测试产物", latencyMs: 12 };
    },
  };
  const providerAdapter = {
    all: () => [{ id: "p1", name: "站点A", enabled: true, api_key: "k", base_url: "https://a", models: [{ model: "m-1", caps: ["llm"] }, { model: "m-2", caps: ["llm"] }] }],
    autoFallback: () => true,
  };
  analyzer.configureSkillAnalyzer({ modelAdapter, providerAdapter, skillStore: makeSkillStore(), builtinTools });
  const result = await analyzer.runPackAiTest({ instruction: "测试任务", context: "ctx", sourceName: "demo" });

  assert.equal(result.text, "测试产物");
  assert.equal(result.model, "m-2");
  assert.equal(result.provider, "站点A");
  assert.deepEqual(seen, ["m-1", "m-2"]);
  assert.equal(result.fallbacks.length, 1);
  assert.match(result.fallbacks[0], /站点A\/m-1：HTTP 500/);
});

test("runPackAiTest 失败：没有可用目标时结构化报错", async () => {
  analyzer.resetSkillAnalyzerForTests();
  const modelAdapter = { call: async () => ({ ok: true, text: "x" }) };
  const providerAdapter = { all: () => [], autoFallback: () => false };
  analyzer.configureSkillAnalyzer({ modelAdapter, providerAdapter, skillStore: makeSkillStore(), builtinTools });
  await assert.rejects(() => analyzer.runPackAiTest({ instruction: "测试", context: "", sourceName: "demo" }), /还没有可用的 LLM 模型站点/);
});

// ══════════════════════════════════════════════════════════════════════
// skill-workspace.cjs（临时 SQLite + 真实临时目录）
// ══════════════════════════════════════════════════════════════════════

function newDb() {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const statement of foundationSchema.dxosDdl()) db.exec(statement);
  return db;
}

function writeWorkspaceDir({ withManifest = true, withAgents = true, format = "dx-agent-workspace/v1" } = {}) {
  const root = tempDir("dxos-ws-");
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills", "imagegen"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "imagegen", "SKILL.md"), "参考内容：白底主图提示词", "utf8");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "这是总控规则。", "utf8");
  if (withManifest) {
    fs.writeFileSync(path.join(root, "agent-workspace.yaml"), [
      "format: " + format,
      "id: demo",
      "name: 演示工作空间",
      "entryAgent: orchestrator",
    ].join("\n"), "utf8");
  }
  if (withAgents) {
    fs.writeFileSync(path.join(root, "agents", "orchestrator.md"), [
      "---",
      "name: Orchestrator",
      "description: 负责调度",
      "model: opus",
      "skills: imagegen",
      "---",
      "总控 Agent 正文",
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(root, "agents", "writer.md"), [
      "---",
      "name: Writer",
      "description: 负责写作",
      "---",
      "写作 Agent 正文",
    ].join("\n"), "utf8");
  }
  return root;
}

function configureWorkspace(db) {
  const savedSkills = [];
  const skillStoreStub = {
    PROCEDURE_BASE_SKILL_IDS: skillStore.PROCEDURE_BASE_SKILL_IDS,
    saveCustomSkill: (input) => { savedSkills.push(input); return input; },
  };
  skillWorkspace.configureSkillWorkspace({ db, skillStore: skillStoreStub, clock: () => 1700000000000 });
  return { savedSkills, skillStoreStub };
}

for (const [label, options, expectNull] of [
  ["空目录", { withManifest: false, withAgents: false }, true],
  ["只有 coordinator+agents 无 manifest（自动识别）", { withManifest: false, withAgents: true }, false],
]) {
  test("workspace 检测：" + label, () => {
    const db = newDb();
    configureWorkspace(db);
    const root = writeWorkspaceDir(options);
    const detected = skillWorkspace.detectAgentWorkspace(root);
    assert.equal(detected === null, expectNull);
    if (!expectNull) assert.equal(detected.entryAgent, "orchestrator");
  });
}

test("workspace 检测：有 manifest 无 agents/*.md 抛错", () => {
  configureWorkspace(newDb());
  const root = writeWorkspaceDir({ withManifest: true, withAgents: false });
  assert.throws(() => skillWorkspace.detectAgentWorkspace(root), /缺少 agents\/\*\.md/);
});

test("workspace 检测：不支持的 format 抛错", () => {
  configureWorkspace(newDb());
  const root = writeWorkspaceDir({ format: "other/v9" });
  assert.throws(() => skillWorkspace.detectAgentWorkspace(root), /不支持的 Agent Workspace 格式：other\/v9/);
});

test("workspace 注册：写 agent_profiles、编排 Skill 与绑定 Skill 正文", () => {
  const db = newDb();
  const { savedSkills } = configureWorkspace(db);
  const root = writeWorkspaceDir();

  const registration = skillWorkspace.registerAgentWorkspace({ id: "pack1", name: "包1" }, root);
  assert.equal(registration.kind, "agent-workspace");
  assert.equal(registration.agentCount, 2);
  assert.equal(registration.entryAgent, "orchestrator");
  assert.deepEqual(registration.agentProfileIds, ["workspace_pack1_orchestrator", "workspace_pack1_writer"]);
  assert.equal(registration.orchestratorSkillId, "workspace_pack1_orchestrator");

  const rows = db.prepare("SELECT id,name,model_profile,enabled,system_prompt,builtin,capability_scopes_json FROM agent_profiles WHERE id LIKE 'workspace_pack1%' ORDER BY id").all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "workspace_pack1_orchestrator");
  assert.equal(rows[0].model_profile, "reasoning");
  assert.equal(rows[1].model_profile, "balanced");
  assert.equal(rows[0].enabled, 1);
  assert.equal(rows[0].builtin, 0);
  // agent_profile.system_prompt = Agent 正文 + 绑定 Skill 正文（源 agentWorkspaceSkills.ts:155）
  assert.match(rows[0].system_prompt, /总控 Agent 正文/);
  assert.match(rows[0].system_prompt, /参考内容：白底主图提示词/);
  assert.deepEqual(JSON.parse(rows[0].capability_scopes_json), ["system:*", "file:*", "skill:*", "mcp:*", "app:*"]);

  // 编排 Skill：id/层/来源与 v2.steps 映射到 agent profile
  assert.equal(savedSkills.length, 1);
  const skill = savedSkills[0];
  assert.equal(skill.id, "workspace_pack1_orchestrator");
  assert.equal(skill.kind, "procedure");
  assert.equal(skill.layer, "workflow");
  assert.equal(skill.origin, "imported");
  assert.deepEqual(skill.v2.allowedTools, ["delegate_agents", "finish_task"]);
  assert.deepEqual(skill.v2.steps.map((s) => s.uses), ["agent:workspace_pack1_orchestrator", "agent:workspace_pack1_writer"]);
  assert.equal(skill.source.metadata.packId, "pack1");
  // 总控规则与 Agent 注册表进入编排 Skill 的 systemPrompt，而非某个 agent_profile
  assert.match(skill.systemPrompt, /这是总控规则。/);
  assert.match(skill.systemPrompt, /DX OS Agent Workspace 运行规则/);
  assert.match(skill.systemPrompt, /workspace_pack1_writer/);
  assert.equal(skill.source.sourcePath, "CLAUDE.md");
});

test("workspace 列举/按 id 停用/重新注册加回/按 pack 停用", () => {
  const db = newDb();
  configureWorkspace(db);
  const root = writeWorkspaceDir();
  const registration = skillWorkspace.registerAgentWorkspace({ id: "pack1", name: "包1" }, root);

  const listed = skillWorkspace.listAgentWorkspaceProfiles("pack1");
  assert.equal(listed.length, 2);
  assert.equal(listed.every((item) => item.enabled), true);
  assert.deepEqual(listed.map((item) => item.id).sort(), [...registration.agentProfileIds].sort());
  assert.ok(Array.isArray(listed[0].allowedRisks));

  // 其它 pack 前缀不串味
  assert.equal(skillWorkspace.listAgentWorkspaceProfiles("pack2").length, 0);

  const changed = skillWorkspace.deleteAgentWorkspaceProfiles([registration.agentProfileIds[0]]);
  assert.equal(changed, 1);
  assert.equal(db.prepare("SELECT enabled FROM agent_profiles WHERE id=?").get(registration.agentProfileIds[0]).enabled, 0);
  assert.equal(db.prepare("SELECT enabled FROM agent_profiles WHERE id=?").get(registration.agentProfileIds[1]).enabled, 1);

  // 重新导入同 pack 会 upsert 并重新启用
  skillWorkspace.registerAgentWorkspace({ id: "pack1", name: "包1" }, root);
  assert.equal(db.prepare("SELECT enabled FROM agent_profiles WHERE id=?").get(registration.agentProfileIds[0]).enabled, 1);

  const disabled = skillWorkspace.deleteAgentWorkspaceProfilesForPack("pack1");
  assert.equal(disabled, 2);
  assert.equal(skillWorkspace.listAgentWorkspaceProfiles("pack1").every((item) => item.enabled === false), true);
});

test("workspace 依赖缺失：未注入 db 时抛结构化 AGENT_DEPENDENCY_UNAVAILABLE", () => {
  skillWorkspace.resetSkillWorkspaceForTests();
  skillWorkspace.configureSkillWorkspace({ skillStore: { saveCustomSkill: () => ({}) } });
  const root = writeWorkspaceDir();
  assert.throws(() => skillWorkspace.registerAgentWorkspace({ id: "pack1", name: "包1" }, root), (error) => {
    assert.equal(error.code, "AGENT_DEPENDENCY_UNAVAILABLE");
    assert.equal(error.dependency, "db");
    return true;
  });
});
