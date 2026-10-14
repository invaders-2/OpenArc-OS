/**
 * B4a1 · 技能目录与存储回归测试（全离线）。
 *
 * 覆盖（对应本轮验收条目）：
 *   ① 内置技能数量与关键字段（15 条、id 顺序、kind/name/description、参数 schema、分类）
 *   ② 启用/禁用持久化（写 <dataDir>/skills.json 后重读）
 *   ③ 自定义技能增 / 改 / 删（含校验与 displayOverride 保留）
 *   ④ 按 pack 删除自定义技能
 *   ⑤ capability 映射（SYSTEM_CAPABILITY_SKILL_MAP / listSystemCapabilities）
 *   ⑥ resolve* 在注入 / 未注入 providerAdapter 两种情形
 *
 * 只读源：server/skills.ts:1-703、server/skillPacks.ts:16-21。
 * 全部用例使用 os.tmpdir 临时目录 + 纯内存假 provider adapter，不触网、不执行 DX OS、不依赖 Electron。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const store = require("../electron/skill-store.cjs");

const {
  AGENT_DEPENDENCY_UNAVAILABLE,
  SKILLS,
  IMAGE_SIZES,
  SYSTEM_CAPABILITY_SKILL_MAP,
  PROCEDURE_BASE_SKILL_IDS,
  configureSkillStore,
  resetSkillStoreForTests,
  skillStorePaths,
  mergeSkillSourceForUpdate,
  listSkills,
  listFunctionalSkills,
  listSystemCapabilities,
  setSkillEnabled,
  saveCustomSkill,
  updateCustomSkillDisplay,
  deleteCustomSkill,
  deleteCustomSkillsForPack,
  agentSkillTools,
  resolveChatTarget,
  resolveVisionTarget,
  resolveVisionTargets,
} = store;

const tmpDirs = [];

/** 每个用例一个全新临时 dataDir，避免用例间共享 skills.json。 */
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-skill-store-"));
  tmpDirs.push(dir);
  configureSkillStore({ dataDir: dir });
  return dir;
}

afterEach(() => {
  resetSkillStoreForTests();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function readSkillsFile(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "skills.json"), "utf-8"));
}

function model(name, caps, over = {}) {
  return Object.assign({ model: name, caps: caps, protocol: "openai" }, over);
}

function provider(over = {}) {
  return Object.assign(
    {
      id: "p1",
      name: "站点1",
      base_url: "http://127.0.0.1:1/v1",
      api_key: "k",
      protocol: "openai",
      source: "api",
      enabled: true,
      sort: 1,
      created_ts: 1,
      models: [],
    },
    over,
  );
}

/** 假 provider/store 适配器，形状对齐 { firstUsable, all, autoFallback, revealProvider }。 */
function adapter(providers, extras = {}) {
  return Object.assign(
    {
      firstUsable: (kind) =>
        providers.find((p) => p.enabled && (p.models || []).some((m) => (m.caps || []).includes(kind))) || null,
      all: () => providers.slice(),
      autoFallback: () => true,
      revealProvider: (id) => providers.find((p) => p.id === id) || null,
    },
    extras,
  );
}

// ── ① 内置技能目录 ──────────────────────────────────────────────────────────

test("内置技能：15 条、id 顺序、关键字段与参数 schema 逐字对齐 skills.ts:135-438", () => {
  assert.equal(SKILLS.length, 15);
  assert.deepEqual(
    SKILLS.map((s) => s.id),
    [
      "chat",
      "writing",
      "rewrite",
      "code",
      "analysis",
      "generate_image",
      "midjourney",
      "upscale_image",
      "generate_video",
      "edit_image",
      "text_to_speech",
      "transcribe_audio",
      "generate_music",
      "batch_image_group_process",
      "describe_image",
    ],
  );
  const byId = new Map(SKILLS.map((s) => [s.id, s]));
  assert.equal(byId.get("chat").kind, "text");
  assert.equal(byId.get("chat").name, "对话回复");
  assert.equal(
    byId.get("chat").systemPrompt,
    "你是一个直接、自然、可靠的中文对话助手。回答用户问题；不需要生成图片；不输出无关解释。",
  );
  assert.equal(byId.get("writing").name, "写作生成");
  assert.equal(byId.get("rewrite").name, "文本改写");
  assert.equal(byId.get("code").name, "代码助手");
  assert.equal(byId.get("analysis").name, "文本分析");
  // 文字技能统一 instruction schema
  for (const id of ["chat", "writing", "rewrite", "code", "analysis"]) {
    assert.deepEqual(byId.get(id).inputSchema.required, ["instruction"]);
    assert.equal(byId.get(id).inputSchema.properties.instruction.type, "string");
  }
  // 图像类
  assert.equal(byId.get("generate_image").kind, "image");
  assert.deepEqual(byId.get("generate_image").inputSchema.required, ["prompt"]);
  assert.deepEqual(byId.get("generate_image").inputSchema.properties.size.enum, IMAGE_SIZES);
  assert.equal(byId.get("midjourney").kind, "midjourney");
  assert.deepEqual(byId.get("midjourney").inputSchema.required, ["operation"]);
  assert.equal(byId.get("midjourney").inputSchema.properties.operation.enum.length, 14);
  assert.ok(byId.get("midjourney").inputSchema.properties.operation.enum.includes("inpaint"));
  assert.equal(byId.get("upscale_image").kind, "image_upscale");
  assert.equal(byId.get("generate_video").kind, "video");
  assert.equal(byId.get("generate_video").inputSchema.properties.aspect_ratio.enum.length, 6);
  assert.deepEqual(byId.get("edit_image").inputSchema.required, ["image", "prompt"]);
  assert.deepEqual(byId.get("text_to_speech").inputSchema.required, ["text"]);
  assert.deepEqual(byId.get("transcribe_audio").inputSchema.required, ["audio"]);
  assert.deepEqual(byId.get("generate_music").inputSchema.required, ["prompt"]);
  assert.equal(byId.get("batch_image_group_process").kind, "image_batch");
  assert.equal(byId.get("batch_image_group_process").inputSchema.properties.groupMode.enum.length, 4);
  assert.equal(byId.get("describe_image").kind, "image_describe");
  assert.deepEqual(byId.get("describe_image").inputSchema.required, ["image"]);
  // 内置定义本身不带 builtin 字段；分类时补上（源 SKILLS 同样不带）
  assert.equal(byId.get("chat").builtin, undefined);
});

test("classifySkill 分类：chat / official preset / 系统能力 / 面向产品目录", () => {
  freshStore();
  const all = listSkills();
  assert.equal(all.length, 15);
  const chat = all.find((s) => s.id === "chat");
  assert.deepEqual(
    { builtin: chat.builtin, layer: chat.layer, origin: chat.origin, exposure: chat.exposure, visibleInApp: chat.visibleInApp },
    { builtin: true, layer: "preset", origin: "official", exposure: "internal", visibleInApp: true },
  );
  const writing = all.find((s) => s.id === "writing");
  assert.deepEqual(
    { builtin: writing.builtin, layer: writing.layer, origin: writing.origin, exposure: writing.exposure, allowImplicitInvocation: writing.allowImplicitInvocation, visibleInApp: writing.visibleInApp },
    { builtin: true, layer: "preset", origin: "official", exposure: "slash", allowImplicitInvocation: false, visibleInApp: true },
  );
  const image = all.find((s) => s.id === "generate_image");
  assert.deepEqual(
    { builtin: image.builtin, layer: image.layer, origin: image.origin, exposure: image.exposure, allowImplicitInvocation: image.allowImplicitInvocation, visibleInApp: image.visibleInApp },
    { builtin: true, layer: "capability", origin: "system", exposure: "internal", allowImplicitInvocation: false, visibleInApp: false },
  );
  assert.deepEqual(listFunctionalSkills().map((s) => s.id), ["writing", "rewrite", "code", "analysis"]);
});

test("内置技能默认全部启用，agentSkillTools 与源一样不暴露任何内置技能", () => {
  freshStore();
  assert.ok(listSkills().every((s) => s.enabled === true));
  assert.deepEqual(agentSkillTools(), []);
});

// ── ⑤ capability 映射 ───────────────────────────────────────────────────────

test("capability 映射：10 条、工具名 → skillId 与源逐字一致", () => {
  freshStore();
  assert.deepEqual(SYSTEM_CAPABILITY_SKILL_MAP, {
    media_generate_image: "generate_image",
    media_midjourney: "midjourney",
    media_upscale_image: "upscale_image",
    media_generate_video: "generate_video",
    media_edit_image: "edit_image",
    media_batch_image: "batch_image_group_process",
    media_describe_image: "describe_image",
    media_text_to_speech: "text_to_speech",
    media_transcribe_audio: "transcribe_audio",
    media_generate_music: "generate_music",
  });
  const caps = listSystemCapabilities();
  assert.equal(caps.length, 10);
  assert.deepEqual(
    caps.map((c) => [c.toolName, c.skillId]),
    Object.entries(SYSTEM_CAPABILITY_SKILL_MAP),
  );
  for (const cap of caps) {
    assert.equal(cap.definition.id, cap.skillId);
    assert.equal(cap.definition.builtin, true);
  }
  assert.deepEqual(PROCEDURE_BASE_SKILL_IDS.length, 14);
  assert.deepEqual(PROCEDURE_BASE_SKILL_IDS, [
    "writing", "rewrite", "analysis", "code", "chat", "generate_image", "upscale_image",
    "midjourney", "generate_video", "text_to_speech", "transcribe_audio", "generate_music",
    "edit_image", "describe_image",
  ]);
});

// ── ② 启用/禁用持久化 ───────────────────────────────────────────────────────

test("启用/禁用持久化：写 skills.json 后重读仍生效，未知 id 返回 null", () => {
  const dir = freshStore();
  const updated = setSkillEnabled("writing", false);
  assert.equal(updated.id, "writing");
  assert.equal(updated.enabled, false);
  assert.deepEqual(readSkillsFile(dir), { enabled: { writing: false }, custom: [] });
  const reread = listSkills().find((s) => s.id === "writing");
  assert.equal(reread.enabled, false);
  // 其他技能不受影响
  assert.equal(listSkills().find((s) => s.id === "code").enabled, true);
  assert.equal(setSkillEnabled("not_a_skill", true), null);
  // 重新启用并覆盖落盘
  assert.equal(setSkillEnabled("writing", true).enabled, true);
  assert.deepEqual(readSkillsFile(dir).enabled, { writing: true });
});

test("兼容旧格式：纯 Record<string, boolean> 视为 enabled 覆盖（skills.ts:441,456）", () => {
  const dir = freshStore();
  fs.writeFileSync(path.join(dir, "skills.json"), JSON.stringify({ code: false }), "utf-8");
  const skills = listSkills();
  assert.equal(skills.find((s) => s.id === "code").enabled, false);
  assert.equal(skills.find((s) => s.id === "writing").enabled, true);
  // 读旧格式后写回新格式
  setSkillEnabled("writing", false);
  assert.deepEqual(readSkillsFile(dir), { enabled: { code: false, writing: false }, custom: [] });
});

test("损坏的 skills.json 回退为空 store，不抛错", () => {
  const dir = freshStore();
  fs.writeFileSync(path.join(dir, "skills.json"), "{not json", "utf-8");
  assert.equal(listSkills().length, 15);
  assert.ok(listSkills().every((s) => s.enabled === true));
});

// ── ③ 自定义技能增 / 改 / 删 ─────────────────────────────────────────────────

test("自定义技能：新建（校验 / 默认字段 / 落盘）", () => {
  const dir = freshStore();
  const created = saveCustomSkill({ id: "My_Skill", name: "我的技能", systemPrompt: "你是助手" });
  assert.equal(created.id, "my_skill");
  assert.equal(created.builtin, false);
  assert.equal(created.enabled, true);
  assert.equal(created.kind, "text");
  assert.equal(created.layer, "preset");
  assert.equal(created.origin, "user");
  assert.equal(created.exposure, "slash");
  assert.equal(created.allowImplicitInvocation, false);
  assert.equal(created.visibleInApp, true);
  // 源 skills.ts:576：inputSchema 描述取 obj.description || name
  assert.deepEqual(created.inputSchema, {
    type: "object",
    properties: { instruction: { type: "string", description: "我的技能" } },
    required: ["instruction"],
  });
  const file = readSkillsFile(dir);
  assert.equal(file.custom.length, 1);
  assert.equal(file.custom[0].id, "my_skill");
  // 同 id 再保存为更新而不是新增
  saveCustomSkill({ id: "my_skill", name: "改名", systemPrompt: "新提示" });
  assert.equal(readSkillsFile(dir).custom.length, 1);
  assert.equal(listSkills().find((s) => s.id === "my_skill").name, "改名");
  // 非法输入
  assert.throws(() => saveCustomSkill({ id: "1bad", name: "x", systemPrompt: "y" }), /以小写字母开头/);
  assert.throws(() => saveCustomSkill({ id: "writing", name: "x", systemPrompt: "y" }), /内置技能/);
  assert.throws(() => saveCustomSkill({ id: "ok_id", name: "", systemPrompt: "y" }), /缺少名称/);
  assert.throws(() => saveCustomSkill({ id: "ok_id", name: "x", systemPrompt: "" }), /system prompt/);
});

test("自定义技能：procedure / imported 分类与 v2 结构化工作流", () => {
  freshStore();
  const source = {
    format: "agentskills/v1",
    sourcePath: "packA/demo.md",
    instructions: "步骤说明",
    files: [{ path: "a.md", content: "x" }],
    metadata: { name: "demo", packId: "packA" },
  };
  const imported = saveCustomSkill({ id: "imported_demo", name: "导入技能", systemPrompt: "sp", source });
  assert.equal(imported.kind, "text");
  assert.equal(imported.layer, "workflow");
  assert.equal(imported.origin, "imported");
  const procedural = saveCustomSkill({
    id: "proc_demo",
    name: "流程技能",
    systemPrompt: "sp",
    v2: { triggers: ["t"], inputs: [], steps: [{ title: "s1", detail: "d1" }], allowedTools: [], permissions: { readsFiles: false, writesFiles: false, network: false, sensitive: [] }, output: "o", checks: [], version: 1 },
  });
  assert.equal(procedural.kind, "procedure");
  assert.equal(procedural.layer, "workflow");
  assert.equal(procedural.v2.steps.length, 1);
});

test("自定义技能：updateCustomSkillDisplay 只改显示名与简介并打 displayOverride", () => {
  const dir = freshStore();
  const source = { format: "agentskills/v1", sourcePath: "p/demo.md", instructions: "", files: [], metadata: { packId: "packA" } };
  saveCustomSkill({ id: "display_demo", name: "原名", description: "原简介", systemPrompt: "sp", source });
  const updated = updateCustomSkillDisplay("display_demo", "新名", "新简介");
  assert.equal(updated.id, "display_demo");
  assert.equal(updated.name, "新名");
  assert.equal(updated.description, "新简介");
  assert.equal(updated.systemPrompt, "sp");
  assert.equal(updated.source.metadata.displayOverride, true);
  assert.equal(readSkillsFile(dir).custom[0].name, "新名");
  assert.throws(() => updateCustomSkillDisplay("nope", "x"), /不存在/);
  assert.throws(() => updateCustomSkillDisplay("display_demo", "  "), /名称不能为空/);
});

test("自定义技能：displayOverride 在重新导入同一 pack 时保留用户命名（skills.ts:554-560）", () => {
  freshStore();
  const source = { format: "agentskills/v1", sourcePath: "p/demo.md", instructions: "", files: [], metadata: { packId: "packA" } };
  saveCustomSkill({ id: "keep_demo", name: "原名", systemPrompt: "sp", source });
  updateCustomSkillDisplay("keep_demo", "用户命名", "用户简介");
  // 同 pack 重新导入：应保留用户命名
  const reimported = saveCustomSkill({ id: "keep_demo", name: "包内新名", description: "包内新简介", systemPrompt: "sp2", source });
  assert.equal(reimported.name, "用户命名");
  assert.equal(reimported.description, "用户简介");
  // 不同 pack 不保留
  const other = saveCustomSkill({
    id: "keep_demo",
    name: "别的包名",
    systemPrompt: "sp",
    source: { format: "agentskills/v1", sourcePath: "q/demo.md", instructions: "", files: [], metadata: { packId: "packB" } },
  });
  assert.equal(other.name, "别的包名");
});

test("自定义技能：删除（内置只能停用），并清理 enabled 覆盖", () => {
  const dir = freshStore();
  saveCustomSkill({ id: "gone_demo", name: "待删", systemPrompt: "sp" });
  setSkillEnabled("gone_demo", false);
  assert.equal(deleteCustomSkill("gone_demo"), true);
  assert.equal(deleteCustomSkill("gone_demo"), false);
  assert.equal(readSkillsFile(dir).custom.length, 0);
  assert.deepEqual(readSkillsFile(dir).enabled, {});
  assert.equal(listSkills().find((s) => s.id === "gone_demo"), undefined);
  assert.throws(() => deleteCustomSkill("writing"), /内置技能不能删除/);
});

// ── ④ 按 pack 删除 ──────────────────────────────────────────────────────────

test("按 pack 删除：只移除该 pack 的路由技能并清理 enabled", () => {
  const dir = freshStore();
  const packSource = (packId) => ({ format: "agentskills/v1", sourcePath: packId + "/x.md", instructions: "", files: [], metadata: { packId } });
  saveCustomSkill({ id: "pack_a_one", name: "A1", systemPrompt: "sp", source: packSource("packA") });
  saveCustomSkill({ id: "pack_a_two", name: "A2", systemPrompt: "sp", source: packSource("packA") });
  saveCustomSkill({ id: "pack_b_one", name: "B1", systemPrompt: "sp", source: packSource("packB") });
  saveCustomSkill({ id: "plain_one", name: "P1", systemPrompt: "sp" });
  setSkillEnabled("pack_a_one", false);
  assert.equal(deleteCustomSkillsForPack("packA"), 2);
  assert.equal(deleteCustomSkillsForPack("packA"), 0);
  assert.deepEqual(listSkills().filter((s) => !s.builtin).map((s) => s.id).sort(), ["pack_b_one", "plain_one"]);
  const file = readSkillsFile(dir);
  assert.deepEqual(file.custom.map((s) => s.id), ["pack_b_one", "plain_one"]);
  assert.equal(file.enabled.pack_a_one, undefined);
});

// ── mergeSkillSourceForUpdate ───────────────────────────────────────────────

test("mergeSkillSourceForUpdate：保留显示覆盖、不修改入参", () => {
  const existing = { format: "agentskills/v1", sourcePath: "a", instructions: "i", files: [], metadata: { packId: "p", name: "old" } };
  const incoming = { format: "agentskills/v1", sourcePath: "b", instructions: "j", files: [], metadata: { packId: "p" } };
  const merged = mergeSkillSourceForUpdate(existing, incoming, true);
  assert.equal(merged.sourcePath, "b");
  assert.equal(merged.metadata.displayOverride, true);
  assert.equal(incoming.metadata.displayOverride, undefined);
  const notPreserved = mergeSkillSourceForUpdate(existing, incoming, false);
  assert.equal(notPreserved, incoming);
  // skills.ts:95-97：incoming 缺省时 source = existing，preserveDisplay=true 仍会复制并打上 displayOverride（不改入参）
  const fallback = mergeSkillSourceForUpdate(existing, undefined, true);
  assert.notEqual(fallback, existing);
  assert.equal(fallback.metadata.displayOverride, true);
  assert.equal(existing.metadata.displayOverride, undefined);
  assert.equal(mergeSkillSourceForUpdate(existing, undefined, false), existing);
  assert.equal(mergeSkillSourceForUpdate(undefined, undefined, true), undefined);
});

// ── ⑥ resolve*：未注入 / 注入 ───────────────────────────────────────────────

test("resolve*：未注入 providerAdapter 抛结构化 AGENT_DEPENDENCY_UNAVAILABLE，reset 后再次拒绝", () => {
  freshStore();
  for (const [name, fn] of [
    ["resolveChatTarget", () => resolveChatTarget()],
    ["resolveVisionTarget", () => resolveVisionTarget()],
    ["resolveVisionTargets", () => resolveVisionTargets({}, 2)],
  ]) {
    assert.throws(fn, (error) => {
      assert.equal(error.code, AGENT_DEPENDENCY_UNAVAILABLE, name + " 的 code");
      assert.equal(error.dependency, "providerAdapter", name + " 的 dependency");
      return true;
    });
  }
  // 注入后再 reset 应回到未注入状态
  configureSkillStore({ providerAdapter: adapter([provider({ models: [model("m1", ["llm"])] })]) });
  assert.equal(resolveChatTarget().model, "m1");
  resetSkillStoreForTests();
  assert.throws(() => resolveChatTarget(), (error) => error.code === AGENT_DEPENDENCY_UNAVAILABLE);
});

test("resolveChatTarget：按首选 provider / 显式 model / 鉴权过滤选型", () => {
  const p1 = provider({ id: "p1", name: "首选", sort: 1, models: [model("m1", ["llm"]), model("v1", ["llm", "llm.chat.vision"])] });
  const p2 = provider({ id: "p2", name: "次选", sort: 2, models: [model("m2", ["llm"])] });
  configureSkillStore({ providerAdapter: adapter([p1, p2]) });
  assert.deepEqual(resolveChatTarget(), {
    provider: { id: "p1", base_url: "http://127.0.0.1:1/v1", api_key: "k", protocol: "openai" },
    model: "m1",
    providerName: "首选",
  });
  assert.equal(resolveChatTarget({ providerId: "p2" }).model, "m2");
  assert.deepEqual(resolveChatTarget({ model: "v1" }), {
    provider: { id: "p1", base_url: "http://127.0.0.1:1/v1", api_key: "k", protocol: "openai" },
    model: "v1",
    providerName: "首选",
  });
  // 源 skills.ts:650 的固有行为：首选站点上没有指定模型时，仍回退该站点的第一个 llm 模型
  assert.deepEqual([resolveChatTarget({ model: "m2" }).provider.id, resolveChatTarget({ model: "m2" }).model], ["p1", "m1"]);
  // p1 无对应 llm 模型时跳到 p2
  const noLlm = provider({ id: "p1", sort: 1, models: [model("img", ["image"])] });
  configureSkillStore({ providerAdapter: adapter([noLlm, p2]) });
  assert.equal(resolveChatTarget().provider.id, "p2");
  // 未鉴权的 api 站点被跳过；cli 站点可用
  const noKey = provider({ id: "p1", api_key: "", models: [model("m1", ["llm"])] });
  configureSkillStore({ providerAdapter: adapter([noKey, p2]) });
  assert.equal(resolveChatTarget().provider.id, "p2");
  const cli = provider({ id: "cli1", source: "cli", api_key: "", models: [model("cm", ["llm"])] });
  configureSkillStore({ providerAdapter: adapter([cli]) });
  assert.equal(resolveChatTarget().provider.id, "cli1");
  // 无可用站点
  configureSkillStore({ providerAdapter: adapter([provider({ enabled: false, models: [model("m1", ["llm"])] })]) });
  assert.throws(() => resolveChatTarget(), /还没有可用的模型站点/);
});

test("resolveVisionTargets：只选 llm.chat.vision，尊重 imageLimit 与 preferred/autoFallback", () => {
  const p1 = provider({ id: "p1", name: "视觉A", sort: 1, models: [model("v1", ["llm", "llm.chat.vision"], { inputs: { images: { max: 2 } } })] });
  const p2 = provider({ id: "p2", name: "视觉B", sort: 2, models: [model("v2", ["llm", "llm.chat.vision"])] });
  configureSkillStore({ providerAdapter: adapter([p1, p2]) });
  assert.deepEqual(resolveVisionTargets({}, 1).map((t) => [t.provider.id, t.model, t.providerName]), [["p1", "v1", "视觉A"], ["p2", "v2", "视觉B"]]);
  assert.deepEqual(resolveVisionTarget().model, "v1");
  // v1 上限 2：请求 3 张时被剔除
  assert.deepEqual(resolveVisionTargets({}, 3).map((t) => t.model), ["v2"]);
  // imageLimit 注入：全部上限 1 时请求 3 张无候选
  configureSkillStore({
    providerAdapter: adapter([p1, p2], { imageLimit: () => 1 }),
  });
  assert.throws(() => resolveVisionTargets({}, 3), /没有可用的视觉模型/);
  // 显式 provider 首选；autoFallback=false 时只保留指定候选
  configureSkillStore({ providerAdapter: adapter([p1, p2], { autoFallback: () => false }) });
  assert.deepEqual(resolveVisionTarget({ providerId: "p2" }).model, "v2");
  assert.deepEqual(resolveVisionTargets({ providerId: "p2" }, 1).map((t) => t.model), ["v2"]);
  // 无视觉模型
  configureSkillStore({ providerAdapter: adapter([provider({ models: [model("m1", ["llm"])] })]) });
  assert.throws(() => resolveVisionTarget(), /没有可用的视觉模型/);
});

test("configureSkillStore 落点：skills.json 与 skill-packs 目录名沿用源（dataPath 同义）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-skill-paths-"));
  tmpDirs.push(dir);
  const paths = configureSkillStore({ dataDir: dir, bundledDir: path.join(dir, "bundled") });
  assert.equal(paths.dataDir, dir);
  assert.equal(paths.bundledDir, path.join(dir, "bundled"));
  assert.deepEqual(skillStorePaths(), {
    dataDir: dir,
    bundledDir: path.join(dir, "bundled"),
    skillsFile: path.join(dir, "skills.json"),
    skillPacksDir: path.join(dir, "skill-packs"),
    bundledStateFile: path.join(dir, "bundled-skill-packs.json"),
  });
});
