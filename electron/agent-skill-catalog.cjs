"use strict";
/**
 * 全局 AI 技能（第 2 期）：把技能中心里**已启用、当前用户可见**的提示词 / 工作流技能交给 AI 使用。
 *
 * 用法和 Claude 的 skills 一样：AI 先看到技能的名字和一句话说明（skill.list，或首轮提示里的目录），
 * 需要时用 skill.load 读出完整说明和附带文件，再按说明去做。技能本身不执行任何东西，
 * 真正的动作仍然走 AI 已有的受控工具（读写工作文件夹要审批等）。
 *
 * 只读、无副作用；技能正文是用户导入的资料，按不可信参考数据对待。
 */

const MAX_LIST = 60;
const MAX_INSTRUCTIONS = 30000;
const MAX_FILE_CHARS = 30000;
const MAX_FILES = 80;

const clip = (text, max) => { const s = String(text == null ? "" : text); return s.length > max ? s.slice(0, max) : s; };

/** 和 skill-service 的 visibleSkills 同一条可见规则 + 只给启用的、不是系统能力的技能。 */
function usableSkills(listSkills, userId) {
  let all = [];
  try { all = typeof listSkills === "function" ? listSkills() : []; } catch { all = []; }
  const uid = String(userId || "");
  return (Array.isArray(all) ? all : []).filter((s) => s && s.enabled !== false && s.layer !== "capability" && s.id !== "chat"
    && (s.builtin === true || s.origin === "official" || (uid && s.ownerUserId === uid)));
}

function instructionsOf(skill) {
  const src = skill && skill.source && typeof skill.source === "object" ? skill.source : null;
  if (src && typeof src.instructions === "string" && src.instructions.trim()) return src.instructions;
  if (typeof skill.systemPrompt === "string" && skill.systemPrompt.trim()) return skill.systemPrompt;
  return "";
}

function filesOf(skill) {
  const files = skill && skill.source && Array.isArray(skill.source.files) ? skill.source.files : [];
  return files.filter((f) => f && typeof f.path === "string").slice(0, MAX_FILES);
}

function summary(skill) {
  return { id: String(skill.id), name: clip(skill.name || skill.id, 80), description: clip(skill.description || "", 300) };
}

function createSkillCatalog({ listSkills }) {
  return {
    list({ userId, query = "" } = {}) {
      const q = String(query || "").trim().toLowerCase();
      const items = usableSkills(listSkills, userId)
        .filter((s) => !q || [s.id, s.name, s.description].some((v) => String(v || "").toLowerCase().includes(q)))
        .slice(0, MAX_LIST)
        .map(summary);
      return { skills: items, count: items.length };
    },
    load({ userId, skillId, file = null } = {}) {
      const id = String(skillId || "").trim();
      const skill = usableSkills(listSkills, userId).find((s) => String(s.id) === id || String(s.name) === id);
      if (!skill) throw Object.assign(new Error("SKILL_NOT_FOUND"), { code: "SKILL_NOT_FOUND" });
      const files = filesOf(skill);
      if (file) {
        const want = String(file).replace(/\\/g, "/").replace(/^\.\//, "");
        const hit = files.find((f) => f.path.replace(/\\/g, "/") === want);
        if (!hit) throw Object.assign(new Error("SKILL_FILE_NOT_FOUND"), { code: "SKILL_FILE_NOT_FOUND" });
        const content = String(hit.content == null ? "" : hit.content);
        return { ...summary(skill), file: hit.path, content: clip(content, MAX_FILE_CHARS), truncated: content.length > MAX_FILE_CHARS, untrusted: true };
      }
      const text = instructionsOf(skill);
      return {
        ...summary(skill),
        instructions: clip(text, MAX_INSTRUCTIONS) || "（这个技能没有文字说明。）",
        truncated: text.length > MAX_INSTRUCTIONS,
        files: files.map((f) => ({ path: f.path, chars: String(f.content == null ? "" : f.content).length })),
        untrusted: true,
      };
    },
    /** 首轮提示里的技能目录（最多 30 条，一行一个）。没有技能时返回空串。 */
    promptCatalog({ userId } = {}) {
      const items = usableSkills(listSkills, userId).slice(0, 30);
      if (!items.length) return "";
      return items.map((s) => "- " + clip(s.name || s.id, 60) + " (id: " + s.id + "): " + clip(String(s.description || "").replace(/\s+/g, " "), 160)).join("\n");
    },
  };
}

/** Tool adapter provider（executionProvider = "SkillCatalog"），只读。 */
function createSkillCatalogProvider({ catalog }) {
  if (!catalog) return null;
  return {
    toolIds: ["skill.list", "skill.load"],
    async prepare() { return { plan: { provider: "SkillCatalog" } }; },
    async execute({ context, args, contract }) {
      const userId = context && context.actorUserId;
      try {
        const toolId = contract && contract.toolId;
        if (toolId === "skill.load" || (!toolId && args && args.skillId)) return { ok: true, result: catalog.load({ userId, skillId: args.skillId, file: args.file || null }) };
        return { ok: true, result: catalog.list({ userId, query: (args && args.query) || "" }) };
      } catch (e) {
        return { ok: false, error: (e && e.code) || "SKILL_UNAVAILABLE" };
      }
    },
    async verify({ result }) { return { ok: !!result, detail: {} }; },
  };
}

module.exports = { createSkillCatalog, createSkillCatalogProvider, usableSkills };
