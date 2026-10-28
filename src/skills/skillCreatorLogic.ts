import type { SkillRecord, SkillV2 } from "./skillCenterLogic";

export type CreatorMessage = { id: string; role: "user" | "assistant"; text: string; at: number };
export type CreatorDraft = { id: string; name: string; description: string; systemPrompt: string; v2: SkillV2; warnings: string[] };

export function creatorDocument(messages: CreatorMessage[], currentInstructions = ""): string {
  const conversation = messages.filter((message) => message.role === "user" && message.text.trim()).map((message) => message.text.trim()).join("\n\n");
  return [currentInstructions.trim() ? "现有 Skill 说明：\n" + currentInstructions.trim() : "", "创建与迭代要求（按对话顺序理解，只修改明确要求的部分）：\n" + conversation].filter(Boolean).join("\n\n").slice(0, 64000);
}

export function creatorDraftOf(skill: SkillRecord, previous?: SkillV2 | null, warnings: string[] = []): CreatorDraft {
  const v2 = skill.v2;
  if (!v2) throw new Error("分析结果缺少 v2 工作流");
  return {
    id: skill.id,
    name: skill.name || skill.id,
    description: skill.description || "",
    systemPrompt: skill.systemPrompt || "",
    v2: { ...v2, version: previous && Number(previous.version) > 0 ? Number(previous.version) + 1 : 1 },
    warnings,
  };
}

export function creatorVersionText(draft: CreatorDraft | null): string {
  return draft ? `第 ${Math.max(1, Number(draft.v2.version) || 1)} 版 · ${draft.v2.steps?.length || 0} 个步骤` : "尚未生成";
}
