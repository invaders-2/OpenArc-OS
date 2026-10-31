/**
 * 提示词里的 @ 引用（对齐 TapNow：在下游节点的提示词里 @ 上游节点）。
 *
 * 存储：提示词仍是一段纯文本，引用写成记号 `@{节点id}`，引用文本节点的一段写成 `@{节点id#海报1}`。
 * 编辑器把记号渲染成带缩略图的胶囊；发给模型前 resolveMentions() 把记号换成模型看得懂的文字
 * （图片 → 「图1」、视频 → 「视频1」、文本 → 原文），其它地方显示时用 plainPrompt() 换成「@标题」。
 *
 * 引用模式（gen.refMode = "mention"）：节点里插入过引用后，只有提示词里 @ 到的上游才会发送，
 * 已连接但没被 @ 的输入在面板里变灰并提示。旧画布没有这个标记，行为不变（所有连线都发送）。
 */
import type { CanvasDoc, CanvasNode } from "../react-canvas/reactCanvasStore";
import { genOf, isGenKind, sectionsOf, textOf, type GenKind, type InputRef } from "./model";

export const MENTION_RE = /@\{([A-Za-z0-9_-]+)(?:#([^}\n]{1,40}))?\}/g;
export type Mention = { id: string; section?: string; start: number; end: number; raw: string };

export const mentionToken = (id: string, section?: string) => "@{" + id + (section ? "#" + section : "") + "}";

export function parseMentions(prompt: string): Mention[] {
  const out: Mention[] = []; const re = new RegExp(MENTION_RE.source, "g"); let m: RegExpExecArray | null;
  while ((m = re.exec(prompt || ""))) out.push({ id: m[1], section: m[2] || undefined, start: m.index, end: m.index + m[0].length, raw: m[0] });
  return out;
}
export const mentionedIds = (prompt: string) => new Set(parseMentions(prompt).map((m) => m.id));
export const hasMentions = (prompt: string) => parseMentions(prompt).length > 0;

/** 能被 @ 的上游：生成类节点（图片 / 视频 / 音频 / 文本）；表格、分组走自己的逻辑 */
export const mentionable = (n: CanvasNode | undefined) => !!n && isGenKind(n.kind);

const nodeTitle = (n: CanvasNode) => (isGenKind(n.kind) ? genOf(n).title : n.text || n.kind);
/** 显示用：记号换成「@标题」或「@标题·海报1」（找不到节点时保留「@已删除节点」） */
export function plainPrompt(prompt: string, doc: CanvasDoc | { nodes: CanvasNode[] }): string {
  if (!prompt || prompt.indexOf("@{") < 0) return prompt || "";
  return prompt.replace(new RegExp(MENTION_RE.source, "g"), (_s, id: string, sec?: string) => {
    const n = doc.nodes.find((x) => x.id === id);
    return "@" + (n ? nodeTitle(n) : "已删除节点") + (sec ? "·" + sec : "");
  });
}

/** 同类上游的编号：第几张图 / 第几段视频…（按连线顺序，从 1 起）——胶囊角标与发给模型的「图1」一致 */
export function kindIndex(ins: InputRef[], nodeId: string): number {
  const hit = ins.find((x) => x.node.id === nodeId); if (!hit) return 0;
  return ins.filter((x) => x.node.kind === hit.node.kind).findIndex((x) => x.node.id === nodeId) + 1;
}
export const KIND_SHORT: Record<GenKind, string> = { image: "图", video: "视频", audio: "音频", text: "文本" };

/** 引用模式下没被 @ 的输入（不发送）；不在引用模式时为空 */
export function unmentionedInputs(node: CanvasNode, ins: InputRef[]): Set<string> {
  const g = genOf(node); const out = new Set<string>();
  if (g.refMode !== "mention") return out;
  const ids = mentionedIds(g.prompt);
  for (const x of ins) if (mentionable(x.node) && !ids.has(x.node.id)) out.add(x.edge.id);
  return out;
}

export type SentRef = { nodeId: string; kind: GenKind; role?: string };
/**
 * 发给模型前把记号换成文字。sent = 这次真正发送的输入（顺序即编号）：
 * 图片 → 「图N」（首帧 / 尾帧 / 人像按角色）、视频 → 「视频N」、音频 → 「音频N」、文本 → 原文（或其中一段）。
 * 没发送的（断开 / 模型不收）退回成「标题」。
 */
export function resolveMentions(prompt: string, doc: CanvasDoc, sent: SentRef[]): { text: string; usedText: Set<string> } {
  const usedText = new Set<string>();
  if (!prompt || prompt.indexOf("@{") < 0) return { text: prompt || "", usedText };
  const text = prompt.replace(new RegExp(MENTION_RE.source, "g"), (_s, id: string, sec?: string) => {
    const n = doc.nodes.find((x) => x.id === id); if (!n) return "";
    const t = nodeTitle(n);
    if (n.kind === "text") {
      usedText.add(id);
      const body = sec ? sectionsOf(textOf(n))[sec] : textOf(n);
      return body && body.trim() ? `「${body.trim()}」` : `「${t}」`;
    }
    const s = sent.find((x) => x.nodeId === id);
    if (!s) return `「${t}」`;
    const role = s.role === "first_frame" ? "首帧图" : s.role === "last_frame" ? "尾帧图" : s.role === "portrait" ? "人像图" : s.role === "source_video" ? "源视频" : s.role === "driving_audio" ? "驱动音频" : "";
    if (role) return `「${role}」`;
    const idx = sent.filter((x) => x.kind === s.kind).findIndex((x) => x.nodeId === id) + 1;
    return `「${KIND_SHORT[s.kind]}${idx}」`;
  });
  return { text: text.replace(/[ \t]{2,}/g, " "), usedText };
}

/** 在末尾补上引用（已经有了就不重复）；返回新提示词 */
export function appendMention(prompt: string, id: string, section?: string): string {
  if (parseMentions(prompt).some((m) => m.id === id && (m.section || "") === (section || ""))) return prompt;
  const tok = mentionToken(id, section);
  return prompt ? prompt.replace(/\s*$/, "") + " " + tok + " " : tok + " ";
}

/** plainPrompt 的反向：模型改写回来的「@标题」按上游节点标题换回记号（长标题优先，避免前缀误配） */
export function relinkMentions(text: string, nodes: CanvasNode[]): string {
  if (!text || text.indexOf("@") < 0) return text;
  const list = nodes.filter(mentionable).map((n) => ({ id: n.id, t: nodeTitle(n) })).filter((x) => x.t).sort((a, b) => b.t.length - a.t.length);
  let out = ""; let i = 0;
  while (i < text.length) {
    if (text[i] === "@" && text[i + 1] !== "{") {
      const hit = list.find((x) => text.startsWith(x.t, i + 1));
      if (hit) {
        let j = i + 1 + hit.t.length; let sec = "";
        const sm = /^·((?:海报|镜头|方案)\d)/.exec(text.slice(j)); if (sm) { sec = sm[1]; j += sm[0].length; }
        out += mentionToken(hit.id, sec || undefined); i = j; continue;
      }
    }
    out += text[i]; i++;
  }
  return out;
}
