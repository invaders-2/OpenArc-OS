/**
 * Agent 规划与执行。
 *
 *   真后端：把画布摘要、已选上下文、记忆、技能（SKILL.md）和操作协议发给对话模型，
 *           模型先用中文说明，需要动画布时在末尾附 ```plan``` JSON（create / connect / run / layout）。
 *   模拟后端：按关键词的规则规划（和预览一致），用来演示与测试。
 *
 * 两条路产出同一种 Plan，执行、确认卡片、结果卡片都共用。
 */
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { connect, title } from "../actions";
import { runNode } from "../engine";
import { bounds, defaultParams, genOf, inputsOf, isGenKind, outOf, srcOf, textOf, uid, type GenKind, type ImageParams, type TextParams, type VideoParams } from "../model";
import type { CanvasStore } from "../store";
import { emptyTable, tableOf, withTable } from "../table";
import type { Ctl } from "../ui/ctx";
import type { AgentState, Skill } from "./state";

export type Step = { label: string; run: () => Promise<void> };
export type Plan = { title: string; intro: string; rows?: Array<[string, string]>; creates?: string; model?: string; calls?: string; eta?: string; steps: Step[] };

/* ================= 执行协议（模型 → 画布操作） ================= */
type Op =
  | { op: "create"; ref?: string; kind: GenKind | "table"; title?: string; prompt?: string; inputs?: string[]; output?: "text" | "table" | "storyboard"; ratio?: string; mode?: string }
  | { op: "connect"; from: string; to: string }
  | { op: "run"; node: string }
  | { op: "update"; node: string; prompt?: string; title?: string }
  | { op: "layout" };

export const PLAN_PROTOCOL = `需要在画布上操作时，在回复最后附一个代码块，语言标注为 plan，内容是 JSON：
{"title":"计划标题","intro":"一句话说明会做什么","steps":[
  {"op":"create","ref":"n1","kind":"text|image|video|audio|table","title":"节点标题","prompt":"提示词","inputs":["已有节点 id 或前面步骤的 ref"],"output":"text|table|storyboard（仅文本节点）","ratio":"3:4（图片/视频，可选）"},
  {"op":"connect","from":"id 或 ref","to":"id 或 ref"},
  {"op":"update","node":"id 或 ref","prompt":"新的提示词"},
  {"op":"run","node":"id 或 ref"},
  {"op":"layout"}
]}
规则：只引用画布摘要里真实存在的节点 id；连线方向是上游 → 下游；生成节点的输入顺序就是 inputs 的顺序；
要批量逐行生成时，先建 output 为 table 的文本节点并 run，再把它生成的表格（会自动出现）连到生成节点——这种情况直接把文本节点 ref 写进生成节点的 inputs，系统会改连到表格；
不需要改动画布时不要附 plan。`;

export function canvasSummary(store: CanvasStore, ctxIds: string[]): string {
  const doc = store.state.doc;
  const rows = doc.nodes.slice(0, 80).map((n) => {
    const ins = inputsOf(doc, n.id).map((x) => x.node.id);
    if (n.kind === "table") { const t = tableOf(n); return { id: n.id, kind: "table", title: t.title, columns: t.columns, rows: t.rows.length, inputs: ins }; }
    if (!isGenKind(n.kind)) return { id: n.id, kind: n.kind };
    const g = genOf(n); const o = outOf(n);
    return { id: n.id, kind: n.kind, title: g.title, prompt: g.prompt.slice(0, 120), output: n.kind === "text" ? (o?.text || "").slice(0, 200) : o ? "有结果" : "未生成", inputs: ins, ...(ctxIds.includes(n.id) ? { selected: true } : {}) };
  });
  return JSON.stringify(rows);
}

export function systemPrompt(store: CanvasStore, a: AgentState, ctxIds: string[], skill: Skill | null): string {
  const mem = a.memory();
  return [
    "你是 OpenArc 画布里的创作助手，能直接在无限画布上建节点、连线、生成。回答用中文，简洁。",
    "节点类型：text（文本 / 大模型，可输出普通文本、多维表格、分镜表）、image、video、audio、table（多维表格，逐行驱动下游批量生成）。",
    "画布摘要（JSON）：" + canvasSummary(store, ctxIds),
    ctxIds.length ? "用户这次选中的上下文节点 id：" + ctxIds.join("、") : "用户没有选中节点。",
    mem.length ? "记忆（用户偏好与项目事实，生成时遵守）：\n- " + mem.join("\n- ") : "",
    skill ? "本次加载的技能：\n" + skill.md : "可用技能：" + a.skillsOn().map((s) => `${s.name}（${s.desc}）`).join("；"),
    PLAN_PROTOCOL,
  ].filter(Boolean).join("\n\n");
}

/** 从模型回复里取出说明文字和 plan */
export function splitReply(text: string): { say: string; plan: { title?: string; intro?: string; steps?: Op[] } | null } {
  const m = /```plan\s*([\s\S]*?)```/i.exec(text);
  if (!m) return { say: text.trim(), plan: null };
  let plan = null; try { plan = JSON.parse(m[1]); } catch { plan = null; }
  return { say: text.replace(m[0], "").trim(), plan };
}

/** 协议操作 → 可执行步骤 */
export function opsToPlan(ctl: Ctl, raw: { title?: string; intro?: string; steps?: Op[] }): Plan | null {
  const store = ctl.store; const ops = Array.isArray(raw.steps) ? raw.steps : []; if (!ops.length) return null;
  const refs = new Map<string, string>(); const resolve = (x: string) => refs.get(x) || (store.node(x) ? x : null);
  const anchor = () => { const bb = bounds(store.state.doc.nodes); return bb ? { x: bb.x + bb.w + 220, y: bb.y + 40 } : ctl.center(); };
  let col = 0; const creates: Record<string, number> = {};
  const steps: Step[] = ops.map((op) => {
    if (op.op === "create") {
      creates[op.kind] = (creates[op.kind] || 0) + 1;
      return { label: `新建${op.kind === "table" ? "多维表格" : { text: "文本", image: "图片", video: "视频", audio: "音频" }[op.kind]}节点「${op.title || ""}」${op.inputs?.length ? "并连入 " + op.inputs.length + " 个输入" : ""}`, run: async () => {
        const a = anchor(); const x = a.x + col * 40, y = a.y + col * 60; col++;
        let n: CanvasNode;
        if (op.kind === "table") n = withTable({ id: uid("t"), kind: "table", x, y, w: 420, h: 220, text: op.title || "多维表格" }, { ...emptyTable(), title: op.title || "多维表格" });
        else {
          const m = store.defaultModel(op.kind); const p = defaultParams(op.kind, m);
          if (op.kind === "text" && op.output) (p as TextParams).output = op.output;
          if ((op.kind === "image" || op.kind === "video") && op.ratio) { const ok = op.kind === "image" ? m?.ratios?.includes(op.ratio) : m?.ratios?.includes(op.ratio); if (ok) (p as ImageParams | VideoParams).ratio = op.ratio; }
          n = store.newNode(op.kind, x, y, { title: op.title || undefined, prompt: op.prompt || "", params: p, agent: true });
        }
        store.addNodes([n], [], { select: false }); if (op.ref) refs.set(op.ref, n.id);
        for (const i of op.inputs || []) { let src = resolve(i); if (!src) continue; const t = store.state.doc.nodes.find((x) => x.kind === "table" && tableOf(x).sourceId === src); if (t && n.kind !== "table") src = t.id; connect(store, src, n.id, { quiet: true, select: false }); }
        ctl.fitTo(store.state.doc.nodes.filter((x) => x.id === n.id || inputsOf(store.state.doc, n.id).some((i) => i.node.id === x.id)), 140, 1);
      } };
    }
    if (op.op === "connect") return { label: "连线", run: async () => { const f = resolve(op.from), t = resolve(op.to); if (f && t) connect(store, f, t, { quiet: true, select: false }); } };
    if (op.op === "update") return { label: "修改提示词", run: async () => { const id = resolve(op.node); if (id) store.patchGen(id, { ...(op.prompt != null ? { prompt: op.prompt } : {}), ...(op.title ? { title: op.title } : {}) }, { history: true }); } };
    if (op.op === "run") return { label: "生成", run: async () => { const id = resolve(op.node); if (!id) return; const ok = await runNode(store, id, { chain: true }); if (!ok && store.node(id) && isGenKind(store.node(id)!.kind) && genOf(store.node(id)!).err) throw new Error(genOf(store.node(id)!).err); } };
    return { label: "整理画布", run: async () => { autoLayout(store); ctl.fitTo(store.state.doc.nodes); } };
  });
  const runs = ops.filter((o) => o.op === "run").length;
  return { title: raw.title || "画布操作", intro: raw.intro || "", steps, creates: Object.entries(creates).map(([k, v]) => `${v} 个${k === "table" ? "表格" : { text: "文本", image: "图片", video: "视频", audio: "音频" }[k as GenKind]}节点`).join("、") || "不新建节点", calls: runs ? runs + " 次生成" : "0", eta: runs ? "视模型而定" : "1 秒内", model: "按节点设置" };
}

/* ================= 规则规划（模拟后端 / 无模型时） ================= */
export function rulePlan(ctl: Ctl, text: string, ctx: CanvasNode[]): Plan | null {
  const store = ctl.store; const doc = () => store.state.doc;
  const anchor = () => { const bb = bounds(doc().nodes); return bb ? { x: bb.x + bb.w + 220, y: bb.y + 40 } : ctl.center(); };
  const findSource = () => {
    const img = ctx.find((n) => n.kind === "image" && outOf(n)) || doc().nodes.find((n) => n.kind === "image" && outOf(n));
    const txt = ctx.find((n) => n.kind === "text" && textOf(n)) || doc().nodes.find((n) => n.kind === "text" && textOf(n));
    return { img, txt };
  };
  const nn = (k: GenKind, x: number, y: number, extra: Parameters<typeof store.newNode>[3]) => { const n = store.newNode(k, x, y, { agent: true, ...extra }); store.addNodes([n], [], { select: false }); return store.node(n.id)!; };
  if (/整理|排版|对齐|布局|排好/.test(text)) return { title: "整理画布", creates: "不新建节点", model: "不调用模型", calls: "0", eta: "1 秒内", intro: "我会按上下游关系把节点分列排好，不改任何内容。", steps: [{ label: `计算 ${doc().nodes.length} 个节点的依赖深度`, run: async () => {} }, { label: "按列排布，同列按原来的上下顺序", run: async () => { store.snapshot(); autoLayout(store); ctl.fitTo(doc().nodes); } }] };
  if (/表格|批量|逐行/.test(text)) {
    const { img, txt } = findSource(); let t: CanvasNode, g: CanvasNode;
    return { title: "表格批量出图", creates: "1 个文本节点、1 张表格、1 个图片节点", model: "文本模型 / 图片模型", calls: "1 次文本 + 按行图片", eta: "视行数而定", intro: "先把需求拆成多维表格，再让图片节点逐行批量生成，每行一个结果节点。", steps: [
      { label: "新建文本节点「任务拆解」，输出设为多维表格", run: async () => { const a = anchor(); t = nn("text", a.x, a.y, { title: "任务拆解", prompt: text, params: { ...(defaultParams("text", store.defaultModel("text")) as TextParams), output: "table" } }); [txt, img].filter(Boolean).forEach((s) => connect(store, s!.id, t.id, { quiet: true, select: false })); ctl.fitTo([t], 160, 1); } },
      { label: "运行，生成多维表格并自动连线", run: async () => { await runNode(store, t.id, { chain: true }); } },
      { label: "新建图片节点，连到表格", run: async () => { const tb = doc().nodes.find((x) => x.kind === "table" && tableOf(x).sourceId === t.id); if (!tb) throw new Error("没有生成表格"); g = nn("image", tb.x + tb.w + 120, tb.y, { title: "逐行出图", prompt: "按这一行的描述生成宣传图，主体保持一致" }); if (img) connect(store, img.id, g.id, { quiet: true, select: false }); connect(store, tb.id, g.id, { quiet: true, select: false }); ctl.fitTo([tb, g], 140, 1); } },
      { label: "逐行批量生成", run: async () => { await runNode(store, g.id, { chain: true }); } }] };
  }
  if (/视频|短片|开箱|动起来/.test(text)) {
    let imgs = ctx.filter((n) => n.kind === "image" && outOf(n)); if (!imgs.length) imgs = doc().nodes.filter((n) => n.kind === "image" && outOf(n)).slice(0, 2); if (!imgs.length) return null; imgs = imgs.slice(0, 2);
    const mode = imgs.length === 2 ? "首尾帧" : "首帧"; let v: CanvasNode;
    return { title: "短片", creates: "1 个视频节点", model: store.defaultModel("video")?.name || "视频模型", calls: "1 次视频生成", eta: `约 ${store.defaultModel("video")?.secs || 20}s`, intro: `用 ${imgs.map((n) => "「" + title(n) + "」").join(" 和 ")} 做${mode}，生成一条视频。`, steps: [
      { label: `读取 ${imgs.length} 张图片：${imgs.map((n, i) => (mode === "首尾帧" ? (i ? "尾帧" : "首帧") : "首帧") + "「" + title(n) + "」").join("、")}`, run: async () => {} },
      { label: `新建视频节点并按顺序连线（模式：${mode}）`, run: async () => { const a = anchor(); v = nn("video", a.x, a.y, { title: "短片", prompt: "镜头缓慢推近，主体从画面中升起，结尾停在主标题，电影感", params: { ...(defaultParams("video", store.defaultModel("video")) as VideoParams), mode } }); imgs.forEach((im) => connect(store, im.id, v.id, { quiet: true, select: false })); ctl.fitTo([...imgs, v], 120, 1); } },
      { label: "生成视频", run: async () => { await runNode(store, v.id, { chain: true }); } }] };
  }
  if (/换背景|背景/.test(text)) {
    const { img } = findSource(); if (!img) return null; let o: CanvasNode;
    return { title: "换背景", creates: "1 个图片节点", model: store.defaultModel("image")?.name || "图片模型", calls: "1 次图片生成", eta: `约 ${store.defaultModel("image")?.secs || 12}s`, intro: `保持「${title(img)}」里的主体不变，生成一张新背景的图。`, steps: [
      { label: `新建图片节点，输入：「${title(img)}」`, run: async () => { o = nn("image", img.x + img.w + 120, img.y, { title: "换背景", prompt: "保持主体外观不变，背景换成清晨的木质书桌，左侧窗光" }); connect(store, img.id, o.id, { quiet: true, select: false }); ctl.fitTo([img, o], 140, 1); } },
      { label: "生成", run: async () => { await runNode(store, o.id, { chain: true }); } }] };
  }
  if (/海报|套图|卖点/.test(text)) {
    const { img, txt } = findSource(); if (!img && !txt) return null; let t: CanvasNode; const outs: CanvasNode[] = [];
    return { title: "卖点海报 × 3", creates: "1 个文本节点、3 个图片节点", model: `${store.defaultModel("text")?.name || "文本模型"} / ${store.defaultModel("image")?.name || "图片模型"}`, calls: "1 次文本 + 3 次图片", eta: "约 40s", intro: `会新建 1 个文本节点和 3 个图片节点，连线顺序都是 ${img ? "「" + title(img) + "」" : ""}${img && txt ? " → " : ""}${txt ? "「" + title(txt) + "」" : ""}。`, steps: [
      { label: `读取${img ? "「" + title(img) + "」" : ""}${txt ? "「" + title(txt) + "」" : ""}`, run: async () => {} },
      { label: "新建文本节点「卖点文案」并连入输入", run: async () => { const a = anchor(); t = nn("text", a.x, a.y + 200, { title: "卖点文案", w: 300, h: 240, prompt: "输出 3 个卖点海报方案，以“海报1”“海报2”“海报3”开头，每个包含主标题、画面、文案" }); [txt, img].filter(Boolean).forEach((s) => connect(store, s!.id, t.id, { quiet: true, select: false })); ctl.fitTo([t], 140, 1); } },
      { label: "运行文案", run: async () => { await runNode(store, t.id, { chain: true }); } },
      { label: "新建 3 个图片节点，用 @卖点文案·海报N 引用对应方案", run: async () => { [0, 1, 2].forEach((i) => { const o = nn("image", t.x + 440, t.y - 320 + i * 330, { title: "海报" + (i + 1), w: 220, prompt: `参考 @卖点文案·海报${i + 1}，基于产品图生成竖版卖点海报` }); if (img) connect(store, img.id, o.id, { quiet: true, select: false }); connect(store, t.id, o.id, { quiet: true, select: false }); outs.push(o); }); ctl.fitTo([t, ...outs], 120, 1); } },
      { label: "并行生成 3 张海报", run: async () => { await Promise.all(outs.map((o) => runNode(store, o.id, { chain: true }))); } }] };
  }
  return null;
}

export function ruleAnswer(store: CanvasStore, text: string, ctx: CanvasNode[]): { text: string; acts: string[] } {
  const doc = store.state.doc; const gen = doc.nodes.filter((n) => isGenKind(n.kind));
  const idle = gen.filter((n) => !outOf(n) && !store.state.runtime[n.id] && !genOf(n).manual && !genOf(n).uploaded); const running = gen.filter((n) => store.state.runtime[n.id]);
  const missing = gen.filter((n) => inputsOf(doc, n.id).some((x) => isGenKind(x.node.kind) && !outOf(x.node)));
  const topic = (ctx[0] ? title(ctx[0]) : doc.nodes.find((n) => n.kind === "text") ? title(doc.nodes.find((n) => n.kind === "text")!) : "这张画布的主题");
  if (/头脑风暴|故事方向|发散/.test(text)) return { text: `围绕「${topic}」发散三个差异明显的方向：\n\n### 方向一 · 极限挑战\n- **核心冲突**：主角在恶劣环境里突破自己\n- **画面**：大远景 + 第一人称速度感\n\n### 方向二 · 日常反差\n- **核心冲突**：平凡场景里突然出现的高光时刻\n- **画面**：生活化近景，节奏先慢后快\n\n### 方向三 · 品牌宣言\n- **核心冲突**：用一句口号串起三段情绪\n- **画面**：留白构图 + 大字标题\n\n**建议收束到方向一**：和现有素材最贴合，最容易出片。要我按这个方向拆分镜吗？`, acts: ["按方向一拆成分镜", "三个方向各出一张概念图", "换三个更大胆的方向"] };
  if (/延续.*记忆|已经确定的设定|设定、风格/.test(text)) return { text: `这张画布目前确定的内容：\n\n- **节点**：${doc.nodes.length} 个，${doc.edges.length} 条连线\n- **已有结果**：${gen.filter((n) => outOf(n)).map((n) => "「" + title(n) + "」").join("、") || "还没有"}\n\n之后的规划和生成都会沿用这些设定。想固定某条规则，可以直接说「记住……」。`, acts: ["记住：海报都用 3:4", "检查一下这张画布还缺什么"] };
  if (/状态|缺|检查|有哪些|看看|总结/.test(text) || !ctx.length) return { text: `这张画布有 ${doc.nodes.length} 个节点、${doc.edges.length} 条连线。\n${running.length ? `· 生成中：${running.map((n) => "「" + title(n) + "」").join("、")}\n` : ""}${idle.length ? `· 还没生成：${idle.map((n) => "「" + title(n) + "」").join("、")}\n` : ""}${missing.length ? `· 上游还没结果：${missing.map((n) => "「" + title(n) + "」").join("、")}\n` : ""}要我直接处理吗？`, acts: ["生成一套卖点海报", "把选中的图片做成一条短片", "把需求拆成表格批量出图", "整理一下画布"] };
  return { text: `已读取 ${ctx.map((n) => "「" + title(n) + "」").join("、")}。可以让我基于它们出海报、做视频、拆表格批量出图，或者换背景。`, acts: ["基于选中节点做一套卖点海报", "用选中的图片做首帧视频", "把选中的图片换成书桌背景"] };
}

export function autoLayout(store: CanvasStore) {
  const doc = store.state.doc; const depth: Record<string, number> = {};
  const d = (id: string, seen = new Set<string>()): number => { if (depth[id] != null) return depth[id]; if (seen.has(id)) return 0; seen.add(id); const ins = inputsOf(doc, id); depth[id] = ins.length ? Math.max(...ins.map((x) => d(x.node.id, seen) + 1)) : 0; return depth[id]; };
  doc.nodes.forEach((n) => d(n.id)); const cols: Record<number, CanvasNode[]> = {}; doc.nodes.forEach((n) => (cols[depth[n.id]] = cols[depth[n.id]] || []).push(n));
  const pos = new Map<string, { x: number; y: number }>(); let x = 0;
  Object.keys(cols).map(Number).sort((a, b) => a - b).forEach((k) => { const col = cols[k].slice().sort((a, b) => a.y - b.y); const total = col.reduce((s, n) => s + n.h + 24 + 50, -50); let y = -total / 2; const w = Math.max(...col.map((n) => n.w)); col.forEach((n) => { pos.set(n.id, { x: Math.round(x + (w - n.w) / 2), y: Math.round(y) }); y += n.h + 24 + 50; }); x += w + 160; });
  store.mutate((dd) => ({ ...dd, nodes: dd.nodes.map((n) => (pos.has(n.id) ? { ...n, ...pos.get(n.id)! } : n)) }), { history: true });
}
export { srcOf };
