/** 画布上的编辑动作（连线、删除、复制粘贴、上传……），界面和 Agent 共用 */
import type { CanvasEdge, CanvasNode } from "../react-canvas/reactCanvasStore";
import { autoVideoMode, connectBlock, genOf, inputsOf, isGenKind, uid, withGen, type GenKind, type VideoParams } from "./model";
import type { CanvasStore } from "./store";
import { tableAutoSize, tableMedia, tableOf } from "./table";

/** 连线；成功后选中下游节点，并按输入自动切换视频生成方式 */
export function connect(store: CanvasStore, from: string, to: string, opts: { quiet?: boolean; select?: boolean } = {}): CanvasEdge | null {
  const block = connectBlock(store.state.doc, from, to);
  if (block) { if (!opts.quiet) store.toast(block); return null; }
  const e = store.addEdge(from, to);
  afterInputsChanged(store, to);
  if (opts.select !== false) store.setUI({ sel: new Set([to]), edge: null });
  if (!opts.quiet) { const a = store.node(from)!, b = store.node(to)!; store.toast(`已连接：「${title(a)}」作为「${title(b)}」的第 ${inputsOf(store.state.doc, to).length} 个输入`); }
  return e;
}
export const title = (n: CanvasNode) => (isGenKind(n.kind) ? genOf(n).title : n.kind === "table" ? tableOf(n).title : n.text || n.kind);

/** 输入变化后的联动：视频节点自动选生成方式；表格自动调尺寸 */
export function afterInputsChanged(store: CanvasStore, id: string) {
  const n = store.node(id); if (!n) return;
  if (n.kind === "video") { const m = store.modelOf(n); if (m) { const mode = autoVideoMode(store.state.doc, id, m); if (mode && mode !== (genOf(n).params as VideoParams).mode) store.patchGen(id, (g) => ({ params: { ...(g.params as VideoParams), mode } })); } }
  if (n.kind === "table") { const s = tableAutoSize(tableOf(n), tableMedia(store.state.doc, id).length ? 1 : 0); if (s.w > n.w) store.updateNode(id, (x) => ({ ...x, w: s.w })); }
}

export function deleteSelection(store: CanvasStore) {
  const { ui } = store.state;
  if (ui.edge) { const e = store.state.doc.edges.find((x) => x.id === ui.edge); store.removeEdge(ui.edge); store.setUI({ edge: null }); if (e) afterInputsChanged(store, e.to); return; }
  if (!ui.sel.size) return;
  const ids = [...ui.sel]; const touched = store.state.doc.edges.filter((e) => ui.sel.has(e.from) && !ui.sel.has(e.to)).map((e) => e.to);
  store.removeNodes(ids); touched.forEach((t) => afterInputsChanged(store, t));
  store.toast(`已删除 ${ids.length} 个节点 · ⌘Z 撤销`);
}

let clip: { nodes: CanvasNode[]; edges: CanvasEdge[] } | null = null;
export const hasClip = () => !!clip;
export function copySelection(store: CanvasStore, quiet = false) {
  const sel = store.state.ui.sel; if (!sel.size) return;
  const nodes = store.state.doc.nodes.filter((n) => sel.has(n.id)); const edges = store.state.doc.edges.filter((e) => sel.has(e.from) && sel.has(e.to));
  clip = JSON.parse(JSON.stringify({ nodes, edges }));
  if (!quiet) store.toast(`已复制 ${nodes.length} 个节点`);
}
export function paste(store: CanvasStore, dx = 40) {
  if (!clip) return; const map: Record<string, string> = {};
  const edges = clip.edges.map((e) => ({ id: uid("e"), from: "", to: "", _old: e }));
  const nodes = clip.nodes.map((n) => { const c: CanvasNode = JSON.parse(JSON.stringify(n)); c.id = uid("n"); map[n.id] = c.id; c.x += dx; c.y += dx; return c; });
  const realEdges = edges.map((e) => ({ id: e.id, from: map[e._old.from], to: map[e._old.to] }));
  // 输入顺序里的旧 edge id 换成新的
  const fixed = nodes.map((c) => (isGenKind(c.kind) ? withGen(c, { order: realEdges.filter((e) => e.to === c.id).map((e) => e.id) }) : c));
  store.mutate((d) => ({ ...d, nodes: [...d.nodes, ...fixed], edges: [...d.edges, ...realEdges] }), { history: true });
  store.setUI({ sel: new Set(fixed.map((n) => n.id)), edge: null });
}
export function duplicate(store: CanvasStore) { const keep = clip; copySelection(store, true); paste(store, 30); clip = keep; }

/** 上传图片：新建节点，或填进指定节点，或作为某节点的输入 */
export async function addFiles(store: CanvasStore, files: File[], at: { x: number; y: number }, opts: { target?: string; linkTo?: string; replace?: string } = {}) {
  let dx = 0; const made: string[] = [];
  for (const f of files) {
    const kind: GenKind | null = f.type.startsWith("image/") ? "image" : f.type.startsWith("video/") ? "video" : f.type.startsWith("audio/") ? "audio" : null;
    if (!kind) { store.toast(`不支持的文件：${f.name}`); continue; }
    if (f.size > (kind === "image" ? 20 : 200) * 1024 * 1024) { store.toast(`${f.name} 超过 ${kind === "image" ? 20 : 200}MB，未添加`); continue; }
    const dataUrl = await new Promise<string>((r, j) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result)); fr.onerror = () => j(fr.error); fr.readAsDataURL(f); }).catch(() => "");
    if (!dataUrl) { store.toast("读取失败：" + f.name); continue; }
    const wh = kind === "image" ? await new Promise<[number, number]>((r) => { const im = new Image(); im.onload = () => r([im.naturalWidth, im.naturalHeight]); im.onerror = () => r([1, 1]); im.src = dataUrl; }) : [16, 9];
    const url = await store.backend.importAsset(store.state.canvasId, dataUrl, f.name);
    const name = f.name.replace(/\.[^.]+$/, "").slice(0, 24);
    // 「替换」：只换当前版本，节点本身不动（位置/尺寸/连线/提示词保留）
    if (opts.replace && store.node(opts.replace)) { replaceNodeMedia(store, opts.replace, { url, w: wh[0], h: wh[1] }); continue; }
    if (opts.target && store.node(opts.target)) {
      const t = store.node(opts.target)!; const g = genOf(t);
      store.updateNode(t.id, (n) => withGen({ ...n, h: kind === "image" ? Math.round(Math.max(100, Math.min(520, n.w * wh[1] / wh[0]))) : n.h }, { hist: [...g.hist, { url, w: wh[0], h: wh[1] }], hi: g.hist.length, uploaded: true }), { history: true });
      made.push(t.id); opts = { ...opts, target: undefined }; continue;
    }
    const w = kind === "image" ? 240 : 320; const h = kind === "image" ? Math.round(Math.max(100, Math.min(520, w * wh[1] / wh[0]))) : kind === "video" ? 180 : 120;
    const n = store.newNode(kind, at.x + dx - w / 2, at.y - h / 2, { title: name, uploaded: true, hist: [{ url, w: wh[0], h: wh[1] }], w, h });
    store.addNodes([n]); made.push(n.id); dx += w + 30;
    if (opts.linkTo && store.node(opts.linkTo)) connect(store, n.id, opts.linkTo, { quiet: true, select: false });
  }
  if (opts.linkTo && store.node(opts.linkTo)) { store.setUI({ sel: new Set([opts.linkTo]) }); store.toast("已上传并连成输入"); return; }
  if (made.length) { store.setUI({ sel: new Set(made) }); store.toast(`已添加 ${made.length} 个文件`); }
}

/**
 * 「替换」：只换当前版本的媒体（url / 封帧 / 宽高），节点位置、尺寸、连线、提示词、参数都不动。
 */
export function replaceNodeMedia(store: CanvasStore, id: string, next: { url?: string; frame?: string; w?: number; h?: number }) {
  const n = store.node(id); if (!n || !next.url) return false;
  store.patchGen(id, (g) => ({
    hist: g.hist.map((h, i) => (i === g.hi ? { ...h, ...next, ...(n.kind === "video" && !next.frame ? { frame: h.frame || next.url } : {}) } : h)),
  }), { history: true });
  store.toast(`已替换「${title(n)}」的当前版本`);
  return true;
}

/** 把节点的所有历史版本铺开成独立节点 */
export function spreadHistory(store: CanvasStore, id: string) {
  const n = store.node(id)!; const g = genOf(n); const made: CanvasNode[] = [];
  g.hist.forEach((o, i) => { if (i === g.hi) return; made.push(withGen({ ...n, id: uid("n"), x: n.x + (made.length + 1) * (n.w + 30), data: undefined }, { ...g, title: g.title + " · 版本" + (i + 1), hist: [o], hi: 0, order: [] })); });
  store.addNodes(made, [], { select: true });
  store.toast(`已把 ${made.length} 个历史版本铺开成节点`);
}

/**
 * 把「当前版本」单独提成一个新节点：只带这一版（hist:[o], hi:0, order:[]，与 spreadHistory 同形状），
 * 放在原节点右侧（x + w + 30、y 对齐），标题「原标题 · 版本 n」；原节点完全不动。
 */
export function extractCurrentVersion(store: CanvasStore, id: string) {
  const n = store.node(id); if (!n) return null;
  const g = genOf(n); const o = g.hist[g.hi]; if (!o) return null;
  const made = withGen({ ...n, id: uid("n"), x: n.x + n.w + 30, y: n.y, data: undefined },
    { ...g, title: g.title + " · 版本 " + (g.hi + 1), hist: [o], hi: 0, order: [] });
  store.addNodes([made], [], { select: true });
  store.toast(`已提取版本 ${g.hi + 1} 为新节点`);
  return made;
}

/** 多选对齐：左边 / 顶边 / 水平等距（只改位置，不改尺寸） */
export function alignSelection(store: CanvasStore, mode: "left" | "top" | "hgap") {
  const nodes = [...store.state.ui.sel].map((id) => store.node(id)).filter((n): n is CanvasNode => !!n);
  if (nodes.length < 2) return;
  if (mode === "left") {
    const x = Math.min(...nodes.map((n) => n.x));
    nodes.forEach((n) => store.updateNode(n.id, (k) => ({ ...k, x })));
    store.toast(`已左对齐 ${nodes.length} 个节点`);
    return;
  }
  if (mode === "top") {
    const y = Math.min(...nodes.map((n) => n.y));
    nodes.forEach((n) => store.updateNode(n.id, (k) => ({ ...k, y })));
    store.toast(`已顶对齐 ${nodes.length} 个节点`);
    return;
  }
  const sorted = [...nodes].sort((a, b) => a.x - b.x);
  const first = sorted[0], last = sorted[sorted.length - 1];
  const totalW = sorted.reduce((sum, n) => sum + n.w, 0);
  const gap = ((last.x + last.w) - first.x - totalW) / Math.max(1, sorted.length - 1);
  let cursor = first.x;
  sorted.forEach((n) => { const x = Math.round(cursor); store.updateNode(n.id, (k) => ({ ...k, x })); cursor += n.w + gap; });
  store.toast(`已水平等距 ${sorted.length} 个节点`);
}

/** 双击文本节点直接书写后提交 */
export function commitText(store: CanvasStore, id: string, text: string) {
  const n = store.node(id); store.setUI({ editText: null }); if (!n) return;
  const g = genOf(n); const cur = g.hist[g.hi]?.text || "";
  if (cur === text) return;
  store.patchGen(id, { hist: [...g.hist.slice(0, Math.max(0, g.hist.length - (g.manual ? 1 : 0))), { text }], hi: Math.max(0, g.hist.length - (g.manual ? 1 : 0)), manual: true }, { history: true });
}
