import type { useShellStore } from "../stores/shell";

export async function launchCanvasSkill(skill: { name: string }, shell: ReturnType<typeof useShellStore>): Promise<{ ok: boolean; error?: string }> {
  const api = window.openarc?.canvas;
  if (!api?.command) return { ok: false, error: "当前环境没有画布桥，无法打开画布 Agent" };
  const created = await api.command({ type: "canvas/create", title: skill.name }).catch(() => null);
  const box = created && typeof created === "object" ? created as Record<string, any> : {};
  const canvas = box.canvas || box.value?.canvas;
  const id = String(canvas?.canvasId || "");
  if (!id) return { ok: false, error: String(box.error || "创建画布失败") };
  shell.openCanvasWithSkill(id, skill.name);
  return { ok: true };
}
