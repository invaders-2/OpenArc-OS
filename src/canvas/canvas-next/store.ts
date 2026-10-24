/**
 * 画布状态。单一 store + useSyncExternalStore：
 *   doc      —— 持久化文档（CanvasDoc），所有改动经 mutate()，可撤销，防抖保存到后端；
 *   view     —— 视口；
 *   ui       —— 选择、弹层、抽屉等纯界面状态；
 *   runtime  —— 生成中的节点（进度、流式文本、AbortController），不进文档；
 *   models   —— 后端模型清单（ModelSpec）。
 */
import { useSyncExternalStore } from "react";
import type { CanvasDoc, CanvasEdge, CanvasNode } from "../react-canvas/reactCanvasStore";
import type { CanvasBackend } from "./backend/types";
import { genOf, isGenKind, newNode, uid, withGen, type GenData, type GenKind, type ModelSpec } from "./model";

export type View = { x: number; y: number; k: number };
export type RunState = { status: "running"; progress: number; runId?: string; stream?: string; abort: AbortController; startedAt: number; batch?: { done: number; total: number } };
export type RunLog = { id: string; node: string; title: string; type: GenKind | "table"; model: string; status: "done" | "error" | "stopped"; secs: number; time: string; thumb?: string; error?: string };
export type Toast = { id: number; html: string; out?: boolean };
export type Conn = { id: string; rev: boolean; a: { x: number; y: number }; p: { x: number; y: number }; sx: number; sy: number; over: string | null };

export type UIState = {
  sel: Set<string>;
  edge: string | null;
  drawer: null | "assets" | "history" | "comments";
  filesOpen: boolean;
  agentOpen: boolean;
  agentFull: boolean;
  mini: boolean;
  hideEdges: boolean;
  snap: boolean;
  cmtMode: boolean;
  pick: string | null;
  agentPick: boolean;
  conn: Conn | null;
  editText: string | null;
  editCell: string | null;
  hlEdge: string | null;
  hlNode: string | null;
  preview: boolean;
  batchMode: "stack" | "spread";
  dragging: boolean;
  theme: "dark" | "light";
  themePref: "dark" | "light" | "system";
};

export type CanvasState = {
  canvasId: string;
  name: string;
  doc: CanvasDoc;
  version: number | null;
  saving: "idle" | "saving" | "saved" | "error" | "conflict";
  loaded: boolean;
  view: View;
  ui: UIState;
  runtime: Record<string, RunState>;
  runs: RunLog[];
  models: ModelSpec[];
  toasts: Toast[];
  undo: CanvasDoc[];
  redo: CanvasDoc[];
  /** 多人协作：本端 id、通道（host 宿主 / local 同机窗口 / lan 局域网）、在线的其他人 */
  collab: { clientId: string | null; transport: string | null; peers: Array<{ id: string; cursor: { x: number; y: number } | null; seenAt: number; name?: string }> };
};

type Listener = () => void;

export class CanvasStore {
  state: CanvasState;
  readonly backend: CanvasBackend;
  private listeners = new Set<Listener>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private toastSeq = 0;
  private modelOff: (() => void) | null = null;

  constructor(backend: CanvasBackend, canvasId: string, name = "未命名画布") {
    this.backend = backend;
    let pref: UIState["themePref"] = "system";
    try { pref = (localStorage.getItem("openarc-canvas-theme") as UIState["themePref"]) || "system"; } catch { /* 无存储时用默认 */ }
    this.state = {
      canvasId, name, doc: { nodes: [], edges: [], comments: [] }, version: null, saving: "idle", loaded: false,
      view: { x: 0, y: 0, k: 1 },
      ui: { sel: new Set(), edge: null, drawer: null, filesOpen: false, agentOpen: typeof innerWidth === "number" ? innerWidth > 760 : true, agentFull: false, mini: false, hideEdges: false, snap: false, cmtMode: false, pick: null, agentPick: false, conn: null, editText: null, editCell: null, hlEdge: null, hlNode: null, preview: false, batchMode: "stack", dragging: false, theme: "dark", themePref: pref },
      runtime: {}, runs: [], models: [], toasts: [], undo: [], redo: [],
      collab: { clientId: null, transport: null, peers: [] },
    };
    try { const r = localStorage.getItem("canvas-next:runs:" + canvasId); if (r) this.state.runs = JSON.parse(r); } catch { /* 忽略 */ }
  }

  subscribe = (l: Listener) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getState = () => this.state;
  private emit() { for (const l of [...this.listeners]) l(); }
  /** 保存冲突时的合并函数（协作层设置）：返回要重存的文档 */
  rebase: ((ours: CanvasDoc, remote: CanvasDoc) => CanvasDoc) | null = null;
  setCollab(patch: Partial<CanvasState["collab"]>) { this.state = { ...this.state, collab: { ...this.state.collab, ...patch } }; this.emit(); }
  /** 远端改动：不进撤销栈，也不由本端保存（发起方负责落盘） */
  applyRemote(fn: (doc: CanvasDoc) => CanvasDoc) { const prev = this.state.doc; const next = fn(prev); if (next === prev) return; this.state = { ...this.state, doc: next }; this.cleanSel(); this.emit(); }
  set(patch: Partial<CanvasState>) { this.state = { ...this.state, ...patch }; this.emit(); }
  setUI(patch: Partial<UIState>) { this.state = { ...this.state, ui: { ...this.state.ui, ...patch } }; this.emit(); }
  setView(v: View) { this.state = { ...this.state, view: v }; this.emit(); }

  /* ---------- 加载 / 保存 ---------- */
  async load() {
    const [loaded, models] = await Promise.all([this.backend.loadDoc(this.state.canvasId), this.backend.listModels().catch(() => [] as ModelSpec[])]);
    this.set({ doc: loaded.doc, version: loaded.version, loaded: true, models });
    this.watchModelDirectory();
    if (loaded.error) this.toast(`画布已从本机副本打开（${loaded.error}）`);
    if (loaded.migrated) this.toast("这张画布来自旧版本，已按新格式打开；原始内容保留了备份");
  }
  /** 设置页增删 / 启停模型后，后端作废缓存并通知；这里只重拉下拉用的 models，文档与撤销栈不动。 */
  private watchModelDirectory() {
    if (this.modelOff || typeof this.backend.onModelsChanged !== "function") return;
    this.modelOff = this.backend.onModelsChanged(() => { void this.reloadModels(); });
  }
  async reloadModels() {
    const models = await this.backend.listModels().catch(() => this.state.models);
    this.set({ models });
  }
  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveNow(), 800);
  }
  async saveNow() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.set({ saving: "saving" });
    const r = await this.backend.saveDoc(this.state.canvasId, this.state.doc, this.state.version);
    if (r.ok) this.set({ saving: "saved", version: r.version });
    else if (r.conflict && this.rebase && r.remote && r.remoteVersion) {
      // 协作中：以当前文档为准合并远端新增后，按远端版本号重存一次
      const merged = this.rebase(this.state.doc, r.remote); if (merged !== this.state.doc) this.applyRemote(() => merged);
      const again = await this.backend.saveDoc(this.state.canvasId, this.state.doc, r.remoteVersion);
      if (again.ok) this.set({ saving: "saved", version: again.version }); else { this.set({ saving: "conflict" }); this.toast("和协作者的改动冲突：已停止自动保存，刷新后会载入最新版本"); }
    }
    else if (r.conflict) { this.set({ saving: "conflict" }); this.toast("画布在别处被修改过：已停止自动保存，刷新后会载入最新版本"); }
    else this.set({ saving: "error" });
  }

  /* ---------- 文档改动 ---------- */
  /** 改文档。history:true 时先存一份撤销快照（拖动等连续操作只在开始时存一次） */
  mutate(fn: (doc: CanvasDoc) => CanvasDoc, opts: { history?: boolean } = {}) {
    const prev = this.state.doc; const next = fn(prev); if (next === prev) return;
    const undo = opts.history ? [...this.state.undo.slice(-59), prev] : this.state.undo;
    this.state = { ...this.state, doc: next, undo, redo: opts.history ? [] : this.state.redo }; this.emit(); this.scheduleSave();
  }
  snapshot() { this.state = { ...this.state, undo: [...this.state.undo.slice(-59), this.state.doc], redo: [] }; }
  undo() { const u = this.state.undo; if (!u.length) return this.toast("没有可撤销的操作"); this.state = { ...this.state, doc: u[u.length - 1], undo: u.slice(0, -1), redo: [...this.state.redo, this.state.doc] }; this.cleanSel(); this.emit(); this.scheduleSave(); }
  redo() { const r = this.state.redo; if (!r.length) return this.toast("没有可重做的操作"); this.state = { ...this.state, doc: r[r.length - 1], redo: r.slice(0, -1), undo: [...this.state.undo, this.state.doc] }; this.cleanSel(); this.emit(); this.scheduleSave(); }
  private cleanSel() { const ids = new Set(this.state.doc.nodes.map((n) => n.id)); const sel = new Set([...this.state.ui.sel].filter((x) => ids.has(x))); this.state = { ...this.state, ui: { ...this.state.ui, sel } }; }

  node = (id: string | null | undefined) => (id ? this.state.doc.nodes.find((n) => n.id === id) : undefined);
  updateNode(id: string, fn: (n: CanvasNode) => CanvasNode, opts: { history?: boolean } = {}) {
    this.mutate((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? fn(n) : n)) }), opts);
  }
  patchGen(id: string, patch: Partial<GenData> | ((g: GenData) => Partial<GenData>), opts: { history?: boolean } = {}) {
    this.updateNode(id, (n) => withGen(n, typeof patch === "function" ? patch(genOf(n)) : patch), opts);
  }
  addNodes(nodes: CanvasNode[], edges: CanvasEdge[] = [], opts: { select?: boolean; history?: boolean } = {}) {
    this.mutate((d) => {
      let ns = [...d.nodes, ...nodes];
      // 新边追加到目标节点的输入顺序末尾
      for (const e of edges) ns = ns.map((n) => (n.id === e.to && isGenKind(n.kind) ? withGen(n, { order: [...genOf(n).order.filter((x) => d.edges.some((de) => de.id === x) || edges.some((ne) => ne.id === x)), e.id] }) : n));
      return { ...d, nodes: ns, edges: [...d.edges, ...edges] };
    }, { history: opts.history ?? true });
    if (opts.select) this.setUI({ sel: new Set(nodes.map((n) => n.id)), edge: null });
  }
  newNode(kind: GenKind, x: number, y: number, extra: Parameters<typeof newNode>[3] = {}) { return newNode(kind, x, y, extra, this.defaultModel(kind)); }
  removeNodes(ids: string[]) {
    const set = new Set(ids); ids.forEach((id) => this.state.runtime[id]?.abort.abort());
    this.mutate((d) => ({ ...d, nodes: d.nodes.filter((n) => !set.has(n.id)), edges: d.edges.filter((e) => !set.has(e.from) && !set.has(e.to)) }), { history: true });
    this.setUI({ sel: new Set([...this.state.ui.sel].filter((x) => !set.has(x))) });
  }
  removeEdge(id: string) {
    const e = this.state.doc.edges.find((x) => x.id === id); if (!e) return;
    this.mutate((d) => ({ ...d, edges: d.edges.filter((x) => x.id !== id), nodes: d.nodes.map((n) => (n.id === e.to && isGenKind(n.kind) ? withGen(n, { order: genOf(n).order.filter((x) => x !== id) }) : n)) }), { history: true });
  }
  addEdge(from: string, to: string): CanvasEdge {
    const edge: CanvasEdge = { id: uid("e"), from, to };
    this.addNodes([], [edge]);
    return edge;
  }
  /** 重新排列某节点的输入顺序 */
  reorderInputs(id: string, edgeIds: string[]) { this.patchGen(id, { order: edgeIds }, { history: true }); }

  /* ---------- 模型 ---------- */
  modelsOf(kind: GenKind) { return this.state.models.filter((m) => m.kind === kind); }
  defaultModel(kind: GenKind): ModelSpec | undefined {
    let stored = ""; try { stored = localStorage.getItem("openarc:canvas:model:" + this.state.canvasId + ":" + kind) || ""; } catch { /* 忽略 */ }
    const list = this.modelsOf(kind); return list.find((m) => m.id === stored) || list[0];
  }
  rememberModel(kind: GenKind, id: string) { try { localStorage.setItem("openarc:canvas:model:" + this.state.canvasId + ":" + kind, id); } catch { /* 忽略 */ } }
  modelOf(node: CanvasNode): ModelSpec | undefined {
    if (!isGenKind(node.kind)) return undefined;
    const p = genOf(node).params as { model?: string };
    return this.modelsOf(node.kind).find((m) => m.id === p.model) || this.defaultModel(node.kind);
  }

  /* ---------- 运行态 ---------- */
  setRun(id: string, r: RunState | null) { const rt = { ...this.state.runtime }; if (r) rt[id] = r; else delete rt[id]; this.set({ runtime: rt }); }
  patchRun(id: string, patch: Partial<RunState>) { const cur = this.state.runtime[id]; if (!cur) return; this.state = { ...this.state, runtime: { ...this.state.runtime, [id]: { ...cur, ...patch } } }; this.emit(); }
  logRun(r: Omit<RunLog, "id" | "time">) {
    const d = new Date(); const time = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const runs = [{ ...r, id: uid("r"), time }, ...this.state.runs].slice(0, 200); this.set({ runs });
    try { localStorage.setItem("canvas-next:runs:" + this.state.canvasId, JSON.stringify(runs.map((x) => ({ ...x, thumb: x.thumb && x.thumb.length < 4000 ? x.thumb : undefined })))); } catch { /* 忽略 */ }
  }

  /* ---------- 提示 ---------- */
  toast(html: string, ms = 2600) {
    const id = ++this.toastSeq; this.set({ toasts: [...this.state.toasts, { id, html }] });
    setTimeout(() => { this.set({ toasts: this.state.toasts.map((t) => (t.id === id ? { ...t, out: true } : t)) }); setTimeout(() => this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) }), 170); }, ms);
  }
}

export function useStore<T>(store: CanvasStore, sel: (s: CanvasState) => T): T {
  return useSyncExternalStore(store.subscribe, () => sel(store.getState()));
}
