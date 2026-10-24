/**
 * Agent 状态：对话、技能、记忆、上下文、历史对话。
 * 技能与记忆存在本机（localStorage）：用户记忆跨画布，画布记忆按 canvasId 分开；技能是 SKILL.md 文本。
 * 桌面版接后端时，只需把 load/save 换成对应命令（见 BACKEND_TODO）。
 */
import { useSyncExternalStore } from "react";

export type ToolStep = { label: string; state: "wait" | "run" | "done" | "skip" | "error"; secs?: string; run?: () => Promise<void> };
export type AgentMsg = {
  id: string;
  role: "u" | "a";
  text: string;
  html?: boolean;
  streaming?: boolean;
  skill?: string;
  ctx?: Array<{ id: string; title: string; kind: string; src?: string }>;
  think?: { live: boolean; open: boolean; secs: string; lines: string[] };
  tools?: ToolStep[];
  toolsOpen?: boolean;
  confirm?: { title: string; state: "wait" | "run" | "done" | "stopped" | "cancel"; rows: Array<[string, string]> };
  results?: string[];
  acts?: string[];
  memSaved?: { scope: string; text: string };
  summary?: boolean;
  error?: string;
  /** 好评 / 差评 */
  fb?: "up" | "down";
  /** 本条回复从开始到结束的总耗时（秒），用于「处理了 …」 */
  took?: number;
  /** 处理过程（思考 + 步骤）是否展开；完成后默认折叠 */
  procOpen?: boolean;
};
export type Skill = { name: string; desc: string; kw: string; src: "官方" | "我的"; on: boolean; md: string };
export type Conv = { id: string; title: string; msgs: AgentMsg[]; at: number };

const OFFICIAL: Array<[string, string, string]> = [
  ["头脑风暴", "基于我的核心创意，发展三个差异明显的故事方向", "头脑风暴"],
  ["电商套图", "产品图 + 产品信息 → 卖点文案 → 3 张海报", "卖点海报"], ["首帧视频", "选中的图片做首帧 / 首尾帧，出一条短片", "视频"],
  ["整理画布", "按上下游关系把节点排成列", "整理"], ["换背景", "保持产品不变，换一个场景", "换背景"],
  ["分镜脚本", "把一句创意拆成分镜表，并逐镜头生成画面", "分镜"], ["表格批量出图", "把需求拆成多维表格，再逐行批量出图", "表格"],
  ["提示词润色", "把口语描述改写成模型更容易理解的提示词", "润色"], ["多角度展示", "一张产品图扩成正 / 侧 / 背 / 俯 4 个角度", "多角度"],
  ["模特试戴", "把产品放到模特身上，保持产品细节", "模特"], ["小红书封面", "3:4 竖版封面 + 大字标题", "封面"],
];
const md = (name: string, desc: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\n1. 读取已选节点和画布上的相关输入\n2. ${desc}\n3. 新建的节点标记为 Agent，连线顺序与输入一致\n4. 手动确认模式下先给出计划，确认后再调用生成`;

function read<T>(k: string, fb: T): T { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) as T : fb; } catch { return fb; } }
function write(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 存不下就只留内存 */ } }

export class AgentState {
  msgs: AgentMsg[] = [];
  busy = false;
  stop = false;
  draft = "";
  skill: string | null = null;
  mode: "manual" | "auto" = "manual";
  model = "Auto";
  pinned: string[] = [];
  muted = new Set<string>();
  memOn: boolean;
  memUser: string[];
  memCanvas: string[];
  skills: Skill[];
  convs: Conv[];
  prevOpen = false;
  /** 本对话的模型：发出第一条消息后锁定（同 TapNow「模型已锁定」），新对话才能换 */
  lockedModel: string | null = null;
  hintOff: boolean = read("canvas-next:agent:hint-off", false);
  private ls = new Set<() => void>();
  private v = 0;

  constructor(public canvasId: string) {
    this.memOn = read("canvas-next:mem:on", true);
    this.memUser = read("canvas-next:mem:user", [] as string[]);
    this.memCanvas = read("canvas-next:mem:canvas:" + canvasId, [] as string[]);
    const mine = read("canvas-next:skills:mine", [] as Skill[]);
    const off = new Set(read("canvas-next:skills:off", [] as string[]));
    this.skills = [...mine, ...OFFICIAL.map(([name, desc, kw]) => ({ name, desc, kw, src: "官方" as const, on: !off.has(name), md: md(name, desc) }))];
    this.convs = read("canvas-next:convs:" + canvasId, [] as Conv[]);
    this.mode = read("canvas-next:agent:mode", "manual");
  }
  subscribe = (l: () => void) => { this.ls.add(l); return () => { this.ls.delete(l); }; };
  version = () => this.v;
  emit() { this.v++; this.ls.forEach((l) => l()); }

  saveMem() { write("canvas-next:mem:on", this.memOn); write("canvas-next:mem:user", this.memUser); write("canvas-next:mem:canvas:" + this.canvasId, this.memCanvas); this.emit(); }
  saveSkills() { write("canvas-next:skills:mine", this.skills.filter((s) => s.src === "我的")); write("canvas-next:skills:off", this.skills.filter((s) => s.src === "官方" && !s.on).map((s) => s.name)); this.emit(); }
  saveConvs() { write("canvas-next:convs:" + this.canvasId, this.convs.slice(0, 30).map((c) => ({ ...c, msgs: c.msgs.map((m) => ({ ...m, tools: m.tools?.map((t) => ({ label: t.label, state: t.state, secs: t.secs })) })) }))); }
  setMode(m: "manual" | "auto") { this.mode = m; write("canvas-next:agent:mode", m); this.emit(); }
  skillsOn() { return this.skills.filter((s) => s.on); }
  dismissHint() { this.hintOff = true; write("canvas-next:agent:hint-off", true); this.emit(); }
  memory() { return this.memOn ? [...this.memUser, ...this.memCanvas] : []; }
  /** 把当前对话存进历史（新对话 / 切换时调用） */
  archive() {
    const u = this.msgs.find((m) => m.role === "u"); if (!u) return;
    this.convs = [{ id: "cv_" + Date.now().toString(36), title: u.text.slice(0, 24), msgs: this.msgs, at: Date.now() }, ...this.convs.filter((c) => c.msgs !== this.msgs)];
    this.saveConvs();
  }
}

export function useAgent(a: AgentState) { useSyncExternalStore(a.subscribe, a.version); return a; }
