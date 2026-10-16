"use strict";
/**
 * B4c · 工作区技能（多 Agent 工作空间注册/列举/删除）。
 * 源：server/agentWorkspaceSkills.ts:1-201。
 *
 * 逐字对应：
 *   · MAX_AGENT_COUNT / MAX_AGENT_PROMPT_CHARS / MAX_ORCHESTRATOR_CHARS  agentWorkspaceSkills.ts:6-8
 *   · yamlValue / frontmatter / slug / workspacePrefix / filesUnder      :29-62
 *   · parseAgent / referencedSkillText / modelProfile                    :64-113
 *   · detectAgentWorkspace                                               :115-130
 *   · registerAgentWorkspace                                             :132-189
 *   · deleteAgentWorkspaceProfiles                                       :191-196
 *   · deleteAgentWorkspaceProfilesForPack                                :198-201
 * 新增（父任务点名的"列举"）：listAgentWorkspaceProfiles —— 源无对应函数，
 *   按同一前缀过滤读回 agent_profiles，不新增表、不改既有表结构。
 *
 * 【数据库】源用模块级 ccsDb（better-sqlite3）直连 agent_profiles。本文件改成注入的
 *   node:sqlite DatabaseSync（prepare/run/get/all），事务用模块内 writeTransaction()
 *   等价实现 ccsDb.transaction(fn).immediate()，与 electron/agent-task-store.cjs:138-161 对齐。
 *   表由 v22/v23 迁移建好（electron/dxos-foundation-schema.cjs:220），本文件绝不建表/改表。
 *
 * 【OUT】源未 import dxosProtocol（云端 AI 任务）/ apiQuota（计费）/ cloudEntitlement（权益），
 *   本文件同样不含；注册只写本地 agent_profiles 与本地 skills.json（经注入 skillStore）。
 *
 * 【依赖注入】configureSkillWorkspace({ db, fsImpl, skillStore, clock, logger })
 *   · db         node:sqlite DatabaseSync；未注入抛结构化 AGENT_DEPENDENCY_UNAVAILABLE。
 *   · fsImpl     默认 node:fs（只用到 existsSync/readFileSync/readdirSync）。
 *   · skillStore 默认惰性 require ./skill-store.cjs；只调 saveCustomSkill 写编排 Skill。
 *   · clock      默认 Date.now。
 */

const nodeFs = require("node:fs");
const { basename, join, relative, resolve, sep } = require("node:path");

/** 结构化依赖缺失码（与 agent-task-store.cjs:48 同一约定）。 */
const AGENT_DEPENDENCY_UNAVAILABLE = "AGENT_DEPENDENCY_UNAVAILABLE";

/** agentWorkspaceSkills.ts:6-8 上限，原样保留。 */
const MAX_AGENT_COUNT = 24;
const MAX_AGENT_PROMPT_CHARS = 56000;
const MAX_ORCHESTRATOR_CHARS = 64000;

function dependencyUnavailable(name, detail) {
  const err = new Error("工作区技能依赖不可用：" + String(name));
  err.name = "AgentDependencyUnavailableError";
  err.code = AGENT_DEPENDENCY_UNAVAILABLE;
  err.dependency = String(name);
  if (detail !== undefined) err.detail = detail;
  return err;
}

// ---------------------------------------------------------------------------
// 注入中心（源用模块级 ccsDb / readFileSync）
// ---------------------------------------------------------------------------
let deps = {
  db: null,
  fsImpl: nodeFs,
  skillStore: null,
  clock: () => Date.now(),
  logger: null,
};

function configureSkillWorkspace(patch = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw dependencyUnavailable("configureSkillWorkspace", "配置必须是对象");
  }
  const next = { ...deps };
  if (Object.prototype.hasOwnProperty.call(patch, "db")) next.db = patch.db || null;
  if (Object.prototype.hasOwnProperty.call(patch, "skillStore")) next.skillStore = patch.skillStore || null;
  if (Object.prototype.hasOwnProperty.call(patch, "logger")) next.logger = patch.logger || null;
  if (patch.fsImpl && typeof patch.fsImpl === "object") next.fsImpl = Object.assign({}, nodeFs, patch.fsImpl);
  if (typeof patch.clock === "function") next.clock = patch.clock;
  deps = next;
  return { ...deps };
}

/** 仅供测试：清空注入，恢复"未接入"状态。 */
function resetSkillWorkspaceForTests() {
  deps = { db: null, fsImpl: nodeFs, skillStore: null, clock: () => Date.now(), logger: null };
  return { ...deps };
}

function now() {
  return deps.clock();
}

function fs() {
  return deps.fsImpl || nodeFs;
}

function requireDb() {
  if (!deps.db) throw dependencyUnavailable("db");
  return deps.db;
}

/** 源 writeTransaction 的等价实现（agent-task-store.cjs:138-154）。 */
function writeTransaction(work) {
  const db = requireDb();
  if (db.isTransaction || db.inTransaction) return work();
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = work();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* 已回滚 */ }
    throw error;
  }
}

/** 解析技能存储：显式注入优先，其次惰性 require skill-store.cjs（B4a 冻结契约）。 */
function resolveSkillStore() {
  if (deps.skillStore) return deps.skillStore;
  try {
    // eslint-disable-next-line global-require
    return require("./skill-store.cjs");
  } catch (error) {
    if (error && error.code === "MODULE_NOT_FOUND" && /skill-store\.cjs/.test(String(error.message))) {
      throw dependencyUnavailable("skillStore", "electron/skill-store.cjs 尚未接入（B4a 并行波次）");
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// agentWorkspaceSkills.ts:29-113 YAML / frontmatter / 文件遍历
// ---------------------------------------------------------------------------
function text(file) {
  return String(fs().readFileSync(file, "utf8")).replace(/^\uFEFF/, "");
}

/** agentWorkspaceSkills.ts:29-32 */
function yamlValue(source, key) {
  const match = String(source || "").match(new RegExp("(?:^|\\n)" + key + ":\\s*([^\\r\\n#]+)", "i"));
  return (match && match[1] ? match[1].trim() : "").replace(/^['"]|['"]$/g, "") || "";
}

/** agentWorkspaceSkills.ts:34-37 */
function frontmatter(markdown) {
  const match = String(markdown || "").match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  return { yaml: (match && match[1]) || "" };
}

/** agentWorkspaceSkills.ts:39-42 */
function slug(value, fallback) {
  const normalized = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 42);
  return /^[a-z]/.test(normalized) ? normalized : fallback;
}

/** agentWorkspaceSkills.ts:44-46 */
function workspacePrefix(packId) {
  return "workspace_" + String(packId || "").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 10);
}

/** agentWorkspaceSkills.ts:48-62 */
function filesUnder(root, folder, matcher) {
  const start = join(root, folder);
  if (!fs().existsSync(start)) return [];
  const result = [];
  const walk = (dir) => {
    for (const entry of fs().readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && matcher.test(entry.name)) result.push(absolute);
    }
  };
  walk(start);
  return result.sort();
}

/** agentWorkspaceSkills.ts:64-76 */
function parseAgent(file, root) {
  const markdown = text(file);
  const yaml = frontmatter(markdown).yaml;
  const fallback = basename(file).replace(/\.md$/i, "");
  return {
    path: relative(root, file).replace(/\\/g, "/"),
    name: yamlValue(yaml, "name") || fallback,
    description: yamlValue(yaml, "description") || (fallback + " Agent"),
    model: yamlValue(yaml, "model") || "balanced",
    skills: yamlValue(yaml, "skills").split(",").map((item) => item.trim()).filter(Boolean),
    body: markdown,
  };
}

/** agentWorkspaceSkills.ts:78-111 */
function referencedSkillText(root, names, agentBody) {
  const parts = [];
  const loaded = new Set();
  let referenceSource = String(agentBody || "");
  let chars = 0;
  for (const name of names) {
    const file = [join(root, "skills", name, "SKILL.md"), join(root, "skills", name + "-skill", "SKILL.md")].find((candidate) => fs().existsSync(candidate));
    if (!file) continue;
    loaded.add(resolve(file).toLowerCase());
    const remaining = MAX_AGENT_PROMPT_CHARS - chars;
    if (remaining <= 0) break;
    const source = text(file);
    referenceSource += "\n" + source;
    const clipped = source.slice(0, remaining);
    parts.push("\n\n===== 绑定 Skill：" + name + " =====\n" + clipped);
    chars += clipped.length;
  }
  const mentioned = [...referenceSource.matchAll(/(?:resources|tools|skills|assets)\/[A-Za-z0-9._\/-]+/g)]
    .map((match) => match[0].replace(/[),.;:'"`]+$/, ""));
  for (const path of [...new Set(mentioned)]) {
    const file = resolve(root, path.replace(/\//g, sep));
    if (!file.startsWith(resolve(root) + sep) || loaded.has(file.toLowerCase()) || !fs().existsSync(file)) continue;
    if (!/\.(md|txt|json|ya?ml)$/i.test(file)) continue;
    const remaining = MAX_AGENT_PROMPT_CHARS - chars;
    if (remaining <= 0) break;
    try {
      const clipped = text(file).slice(0, remaining);
      parts.push("\n\n===== 工作空间资料：" + path + " =====\n" + clipped);
      loaded.add(file.toLowerCase());
      chars += clipped.length;
    } catch { /* 忽略目录或不可读资料 */ }
  }
  return parts.join("");
}

/** agentWorkspaceSkills.ts:113 */
function modelProfile(model) {
  return /opus|reason|think/i.test(String(model || "")) ? "reasoning" : "balanced";
}

// ---------------------------------------------------------------------------
// agentWorkspaceSkills.ts:115-130 detectAgentWorkspace
// ---------------------------------------------------------------------------
function detectAgentWorkspace(root) {
  const manifestPath = ["agent-workspace.yaml", "agent-workspace.yml"].map((name) => join(root, name)).find((file) => fs().existsSync(file));
  const agentFiles = filesUnder(root, "agents", /\.md$/i).slice(0, MAX_AGENT_COUNT);
  const coordinatorPath = ["CLAUDE.md", "AGENTS.md"].map((name) => join(root, name)).find((file) => fs().existsSync(file));
  if (manifestPath && !agentFiles.length) throw new Error("Agent Workspace 缺少 agents/*.md");
  if (!manifestPath && (!coordinatorPath || !agentFiles.length)) return null;
  const manifest = manifestPath ? text(manifestPath) : "";
  const format = yamlValue(manifest, "format");
  if (manifestPath && format && format !== "dx-agent-workspace/v1") throw new Error("不支持的 Agent Workspace 格式：" + format);
  return {
    manifestPath,
    manifest,
    agentFiles,
    coordinatorPath,
    id: yamlValue(manifest, "id"),
    name: yamlValue(manifest, "name"),
    entryAgent: yamlValue(manifest, "entryAgent") || "orchestrator",
  };
}

// ---------------------------------------------------------------------------
// agentWorkspaceSkills.ts:132-189 registerAgentWorkspace
// ---------------------------------------------------------------------------
function registerAgentWorkspace(pack, root) {
  const detected = detectAgentWorkspace(root);
  if (!detected) return null;
  const prefix = workspacePrefix(pack.id);
  const agents = detected.agentFiles.map((file) => parseAgent(file, root));
  const used = new Set();
  const profiles = agents.map((agent, index) => {
    let suffix = slug(agent.name, "agent_" + (index + 1));
    while (used.has(suffix)) suffix = suffix + "_" + (index + 1);
    used.add(suffix);
    return { agent, id: prefix + "_" + suffix };
  });
  const timestamp = now();
  const db = requireDb();
  const upsert = db.prepare("INSERT INTO agent_profiles(" +
    "id,name,description,capability_scopes_json,model_profile,max_model_calls,max_tool_calls,system_prompt,builtin,enabled,created_at,updated_at,allowed_risks_json" +
    ") VALUES (?,?,?,?,?,?,?,?,0,1,?,?,?) " +
    "ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description," +
    "capability_scopes_json=excluded.capability_scopes_json,model_profile=excluded.model_profile," +
    "max_model_calls=excluded.max_model_calls,max_tool_calls=excluded.max_tool_calls," +
    "system_prompt=excluded.system_prompt,builtin=0,enabled=1,updated_at=excluded.updated_at," +
    "allowed_risks_json=excluded.allowed_risks_json");
  writeTransaction(() => {
    for (const profile of profiles) {
      const prompt = (profile.agent.body + referencedSkillText(root, profile.agent.skills, profile.agent.body)).slice(0, MAX_AGENT_PROMPT_CHARS);
      upsert.run(profile.id, profile.agent.name, profile.agent.description,
        JSON.stringify(["system:*", "file:*", "skill:*", "mcp:*", "app:*"]), modelProfile(profile.agent.model),
        12, 40, prompt, timestamp, timestamp, JSON.stringify(["read", "write", "delete", "external", "system"]));
    }
  });

  const registry = profiles.map(({ agent, id }) =>
    "- " + id + "：" + agent.name + "；" + agent.description + "；绑定 Skills：" + (agent.skills.join(", ") || "无")).join("\n");
  const coordinator = detected.coordinatorPath ? text(detected.coordinatorPath) : "";
  const rules = "\n\n[DX OS Agent Workspace 运行规则]\n这是一个多 Agent 工作空间，不是单提示词。你是总控 Agent，必须通过 delegate_agents 把各阶段交给下面的专业 Agent Profile；不要冒充子 Agent 一次性生成全部内容。\n可用 Agent Profile：\n" + registry + "\n执行要求：\n1. children.agentProfileId 必须使用上面的完整 ID。\n2. 串行阶段用 dependsOn 建立依赖；可独立验证的任务才并行。\n3. 每个 instruction 写清输入、输出路径、绑定 Skill 和验收条件。\n4. 审核或门禁失败时仅回改受影响阶段，并进行有界重试。\n5. 汇总并验证子 Agent 产物后才调用 finish_task。\n";
  const systemPrompt = (coordinator + rules).slice(0, MAX_ORCHESTRATOR_CHARS);
  const skillId = prefix + "_orchestrator";
  const steps = profiles.slice(0, 8).map(({ agent, id }) => ({ title: agent.name, detail: agent.description, uses: "agent:" + id }));
  const skillStore = resolveSkillStore();
  if (!skillStore || typeof skillStore.saveCustomSkill !== "function") throw dependencyUnavailable("skillStore.saveCustomSkill");
  skillStore.saveCustomSkill({
    id: skillId,
    name: detected.name || pack.name,
    description: ("多 Agent 工作空间：" + profiles.map((item) => item.agent.name).join("、")).slice(0, 180),
    kind: "procedure", layer: "workflow", origin: "imported", systemPrompt,
    source: {
      format: "agentskills/v1",
      sourcePath: detected.coordinatorPath ? basename(detected.coordinatorPath) : basename(detected.manifestPath || "agent-workspace.yaml"),
      instructions: coordinator || detected.manifest,
      files: profiles.map(({ agent }) => ({ path: agent.path, content: agent.body })),
      metadata: { name: detected.name || pack.name, description: "Agent Workspace orchestrator", packId: pack.id, packName: pack.name },
    },
    v2: {
      triggers: ["用户显式调用该工作空间", "任务需要多个专业 Agent 分阶段协作"],
      inputs: ["用户目标", "项目文件与素材"],
      steps,
      allowedTools: ["delegate_agents", "finish_task"],
      permissions: { readsFiles: true, writesFiles: true, network: false, sensitive: [] },
      output: "由总控 Agent 汇总并验证的工作空间产物",
      checks: ["所有必需阶段完成", "审核与门禁通过", "最终产物已验证"],
      analyzedAt: timestamp, version: 2,
      sourceName: detected.manifestPath ? basename(detected.manifestPath) : "auto-detected",
    },
  });
  return {
    kind: "agent-workspace",
    agentCount: profiles.length,
    entryAgent: detected.entryAgent,
    agentProfileIds: profiles.map((item) => item.id),
    orchestratorSkillId: skillId,
  };
}

/** ESCAPE '\' 的 LIKE 前缀（源 agentWorkspaceSkills.ts:200 的转义规则）。 */
function likePrefix(packId) {
  return workspacePrefix(packId).replace(/_/g, "\\_") + "\\_%";
}

const PROFILE_COLUMNS = "id,name,description,capability_scopes_json AS capabilityScopesJson,model_profile AS modelProfile," +
  "max_model_calls AS maxModelCalls,max_tool_calls AS maxToolCalls,system_prompt AS systemPrompt," +
  "builtin,enabled,created_at AS createdAt,updated_at AS updatedAt,allowed_risks_json AS allowedRisksJson";

/** 新增：按 packId 前缀列举工作空间 Agent Profile（源无对应查询，语义与 deleteForPack 前缀一致）。 */
function listAgentWorkspaceProfiles(packId) {
  const rows = requireDb().prepare("SELECT " + PROFILE_COLUMNS + " FROM agent_profiles WHERE id LIKE ? ESCAPE '\\' AND builtin=0 ORDER BY id").all(likePrefix(packId));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    modelProfile: row.modelProfile,
    maxModelCalls: row.maxModelCalls,
    maxToolCalls: row.maxToolCalls,
    systemPrompt: row.systemPrompt,
    builtin: !!row.builtin,
    enabled: !!row.enabled,
    capabilityScopes: safeJson(row.capabilityScopesJson, []),
    allowedRisks: safeJson(row.allowedRisksJson, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

function safeJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

// ---------------------------------------------------------------------------
// agentWorkspaceSkills.ts:191-196 deleteAgentWorkspaceProfiles
// ---------------------------------------------------------------------------
function deleteAgentWorkspaceProfiles(ids) {
  if (!ids || !ids.length) return 0;
  // 保留历史 Run 的外键与审计记录，但从后续委派候选中移除。
  const disable = requireDb().prepare("UPDATE agent_profiles SET enabled=0,updated_at=? WHERE id=? AND builtin=0");
  return writeTransaction(() => {
    let changed = 0;
    for (const id of ids) changed += disable.run(now(), id).changes || 0;
    return changed;
  });
}

// ---------------------------------------------------------------------------
// agentWorkspaceSkills.ts:198-201 deleteAgentWorkspaceProfilesForPack
// ---------------------------------------------------------------------------
function deleteAgentWorkspaceProfilesForPack(packId) {
  const result = requireDb().prepare("UPDATE agent_profiles SET enabled=0,updated_at=? WHERE id LIKE ? ESCAPE '\\' AND builtin=0").run(now(), likePrefix(packId));
  return result.changes || 0;
}

module.exports = {
  AGENT_DEPENDENCY_UNAVAILABLE,
  MAX_AGENT_COUNT,
  MAX_AGENT_PROMPT_CHARS,
  MAX_ORCHESTRATOR_CHARS,
  dependencyUnavailable,
  configureSkillWorkspace,
  resetSkillWorkspaceForTests,
  yamlValue,
  frontmatter,
  slug,
  workspacePrefix,
  filesUnder,
  parseAgent,
  referencedSkillText,
  modelProfile,
  detectAgentWorkspace,
  registerAgentWorkspace,
  listAgentWorkspaceProfiles,
  deleteAgentWorkspaceProfiles,
  deleteAgentWorkspaceProfilesForPack,
};
