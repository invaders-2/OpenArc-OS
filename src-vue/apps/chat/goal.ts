import type { ChatFile, Pick } from "./types";
import { sizeText } from "./preview";

/**
 * 发给 AI 的一句话 = 已选技能 / MCP 的说明行 + 用户原文 + 附件清单。
 * 任务记录里只存这一段文字，界面显示时再拆回来（气泡里显示原文 + 文件卡片 + 技能标签）。
 */
const KIND_CN: Record<string, string> = { image: "图片", video: "视频", audio: "音频", pdf: "PDF", doc: "文档" };
const CN_KIND: Record<string, string> = Object.fromEntries(Object.entries(KIND_CN).map(([k, v]) => [v, k]));
const ATTACH_HEAD = "[附件]";
const ATTACH_NOTE = "（这些文件在 AI 工作文件夹里，用 workspace_read 读取；回答里提到它们时用 Markdown 链接写相对路径。）";

export function buildGoal(text: string, files: ChatFile[], picks: Pick[]) {
  const lines: string[] = [];
  for (const p of picks) {
    if (p.kind === "skill") lines.push("[使用技能] " + p.name + "（id: " + p.id + "）：先用 skill_load 加载这个技能，再按它的说明做。");
    else lines.push("[使用 MCP] " + p.name + "（connectionId: " + p.id + "）：需要时调用这个 MCP 服务提供的工具。");
  }
  let goal = (lines.length ? lines.join("\n") + "\n\n" : "") + (text || (files.length ? "请看附件。" : ""));
  if (files.length) {
    goal += "\n\n" + ATTACH_HEAD + "\n" + files.map((f) => "- " + f.path + "（" + (KIND_CN[f.kind] || "文件") + "，" + sizeText(f.size) + (f.ref ? "，引用" : "") + "）").join("\n") + "\n" + ATTACH_NOTE;
  }
  return goal;
}

export type ParsedGoal = { text: string; files: ChatFile[]; picks: Pick[] };
const parsedCache = new Map<string, ParsedGoal>();

export function parseGoal(goal: string): ParsedGoal {
  const src = String(goal || "");
  const hit = parsedCache.get(src); if (hit) return hit;
  let body = src;
  const picks: Pick[] = [];
  // 开头的技能 / MCP 说明行
  for (;;) {
    const m = /^\[(使用技能|使用 MCP)\] (.+?)（(?:id|connectionId): ([^）]+)）：[^\n]*\n?/.exec(body);
    if (!m) break;
    picks.push({ kind: m[1] === "使用技能" ? "skill" : "mcp", id: m[3], name: m[2] });
    body = body.slice(m[0].length);
  }
  if (picks.length) body = body.replace(/^\n+/, "");
  // 末尾的附件清单
  const files: ChatFile[] = [];
  const at = body.lastIndexOf("\n\n" + ATTACH_HEAD + "\n");
  if (at >= 0) {
    const block = body.slice(at + ATTACH_HEAD.length + 3).split("\n");
    for (const line of block) {
      const m = /^- (.+?)（([^，）]+)，([^，）]+)(，引用)?）$/.exec(line.trim());
      if (!m) continue;
      const path = m[1];
      files.push({ path, name: path.split("/").pop() || path, size: parseSize(m[3]), kind: CN_KIND[m[2]] || "doc", state: "ready", ref: !!m[4] });
    }
    if (files.length) body = body.slice(0, at);
  }
  if (files.length && body === "请看附件。") body = "";
  const out = { text: body, files, picks };
  if (parsedCache.size > 400) parsedCache.clear();
  parsedCache.set(src, out);
  return out;
}

/** 对话标题：去掉技能行和附件清单后的第一行。 */
export function goalTitle(goal: string) {
  const p = parseGoal(goal);
  const first = p.text.split("\n").find((l) => l.trim())?.trim() || "";
  return first || (p.files.length ? "附件：" + p.files.map((f) => f.name).join("、") : String(goal || "").split("\n")[0]);
}

function parseSize(s: string) {
  const m = /^([\d.]+)\s*(B|KB|MB)$/.exec(s.trim()); if (!m) return 0;
  const n = Number(m[1]);
  return Math.round(m[2] === "MB" ? n * 1024 * 1024 : m[2] === "KB" ? n * 1024 : n);
}
