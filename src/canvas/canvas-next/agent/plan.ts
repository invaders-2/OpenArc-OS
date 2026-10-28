/**
 * 执行计划卡（「手动确认」模式）：Agent 先回一个 ```openarc-plan 代码块，内容是 JSON 数组
 *   [{ "step": "新建 3 个图片节点，分别连到产品图" }, …]
 * 面板把它渲染成计划卡，用户点「按此计划执行」后，以「自动规划」方式发起执行；
 * 每次写入画布仍然走 OpenArc 的可信批准。运行时提示词见 electron/task-harness-orchestrator.cjs。
 */
export type PlanCard = { steps: string[]; status: "open" | "approved" | "revising" };

export const PLAN_MAX = 8;
const BLOCK = /```openarc-plan\s*\n?([\s\S]*?)```/i;
const clean = (v: unknown, max: number) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

/** 从回复里取出计划块；没有或格式不对返回 null（原文照常显示） */
export function parsePlan(text: string): { rest: string; steps: string[] } | null {
  const m = BLOCK.exec(String(text || "")); if (!m) return null;
  let raw: unknown; try { raw = JSON.parse(m[1]); } catch { return null; }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { steps?: unknown }).steps) ? (raw as { steps: unknown[] }).steps : null;
  if (!list) return null;
  const steps = list.map((it) => clean(it && typeof it === "object" ? (it as { step?: unknown; title?: unknown }).step ?? (it as { title?: unknown }).title : it, 160)).filter(Boolean).slice(0, PLAN_MAX);
  if (!steps.length) return null;
  return { rest: String(text).replace(BLOCK, "").trim(), steps };
}

/** 确认执行时发给 Agent 的消息：把计划原样带上，避免执行时又改主意 */
export function planGoal(goal: string, steps: string[]): string {
  return `按下面已确认的计划执行${goal ? `（原始需求：${goal}）` : ""}：\n` + steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
}
