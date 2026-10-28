/**
 * 堆叠节点（卡片叠在一起的封面）、堆叠画廊（双击展开）、分组运行确认框。
 */
import { useEffect, useState } from "react";
import type { CanvasDoc, CanvasNode } from "../../react-canvas/reactCanvasStore";
import { renderCanvasThumb } from "../../react-canvas/exportCanvas";
import { savePersonalTemplate } from "../personalTemplates";
import { title } from "../actions";
import { planGroup, runGroup, type GroupPlan } from "../engine";
import { isGenKind, outOf, TYPE_ICON, TYPE_LABEL, type GenKind } from "../model";
import { isStack, stackCover, stackItems, takeFromStack, unstack } from "../stack";
import { useCtl, useS, type Ctl } from "./ctx";
import { Icon } from "./Icon";
import { saveNodesToLibrary } from "./Library";
import { downloadMany } from "./menus";
import { closeModal, ModalHead, openModal } from "./overlay";
import { useAssetUrl } from "./useAsset";

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

function Thumb({ src, kind, text, className }: { src: string; kind: string; text?: string; className?: string }) {
  const url = useAssetUrl(src);
  if (url) return <img className={className} src={url} alt="" draggable={false} />;
  if (text) return <div className={(className || "") + " st-text"}>{text}</div>;
  return <div className={(className || "") + " st-ph"}><Icon name={isGenKind(kind) ? TYPE_ICON[kind] : "layers"} /></div>;
}

/** 画布上的堆叠：最多 3 张错开叠放，右上角数量 */
export function StackBody({ node }: { node: CanvasNode }) {
  const doc = useS((s) => s.doc); const cover = stackCover(doc, node); const count = stackItems(doc, node).length;
  return <div className="stack-body">
    <div className="stack-cards">
      {cover.slice().reverse().map((c, i, arr) => <div key={c.id} className="stack-card" style={{ transform: `translate(${(arr.length - 1 - i) * 8}px,${(arr.length - 1 - i) * -8}px) rotate(${(arr.length - 1 - i) * 2.5}deg)`, zIndex: i }}>
        <Thumb src={c.src} kind={c.kind} text={c.text} />
      </div>)}
    </div>
    <span className="stack-count tnum">{count}</span>
    <button className="stack-open" data-act="stack-open" onPointerDown={stop} onClick={(e) => { stop(e); window.dispatchEvent(new CustomEvent("cn:stack", { detail: node.id })); }}>展开</button>
  </div>;
}

/** 双击堆叠 / 点「展开」：画廊里看全部成员，可移出、下载、存素材库、加入对话、取消堆叠 */
export function StackGalleryHost() {
  const ctl = useCtl();
  useEffect(() => {
    const on = (e: Event) => { const id = (e as CustomEvent).detail as string; if (isStack(ctl.store.node(id))) openModal(() => <StackGallery ctl={ctl} id={id} />, "stack-gallery"); };
    addEventListener("cn:stack", on); return () => removeEventListener("cn:stack", on);
  }, [ctl]);
  return null;
}

function StackGallery({ ctl, id }: { ctl: Ctl; id: string }) {
  const store = ctl.store; const doc = useS((s) => s.doc); const s = doc.nodes.find((n) => n.id === id);
  useEffect(() => { if (!isStack(s)) closeModal(); }, [s]);
  if (!s || !isStack(s)) return null;
  const items = stackItems(doc, s);
  const toAgent = () => { items.forEach((n) => window.dispatchEvent(new CustomEvent("cn:agent-pick", { detail: n.id }))); store.setUI({ agentOpen: true }); store.toast(`已把 ${items.length} 个节点加入对话`); };
  return <>
    <ModalHead title={<>堆叠 · {items.length} 个节点</>} icon="layers" />
    <div className="mbd">
      <div className="stack-actions">
        <button className="btn" data-stack="agent" onClick={toAgent}><Icon name="msg" size="s" />加入对话</button>
        <button className="btn" data-stack="lib" onClick={(e) => void saveNodesToLibrary(ctl, items, e.currentTarget)}><Icon name="libadd" size="s" />存素材库</button>
        <button className="btn" data-stack="dl" onClick={() => void downloadMany(items, store, store.state.name + "-堆叠")}><Icon name="download" size="s" />全部下载</button>
        <span className="sp" />
        <button className="btn" data-stack="unstack" onClick={() => { closeModal(); unstack(store, id); }}><Icon name="split" size="s" />取消堆叠</button>
      </div>
      <div className="stack-grid">
        {items.map((n) => <StackItem key={n.id} n={n} onTake={() => takeFromStack(store, id, n.id)} />)}
      </div>
      <p className="stack-tip">把画布上的节点拖到堆叠上就能放进来；移出的节点放在堆叠右侧。</p>
    </div>
  </>;
}

function StackItem({ n, onTake }: { n: CanvasNode; onTake: () => void }) {
  const o = isGenKind(n.kind) ? outOf(n) : null;
  const src = n.kind === "image" ? o?.url || "" : n.kind === "video" ? o?.frame || "" : "";
  return <div className="stack-item" data-stack-item={n.id}>
    <button className="stack-thumb" title="在画布上查看" onClick={() => { closeModal(); if (o) window.dispatchEvent(new CustomEvent("cn:lightbox", { detail: n.id })); }}>
      <Thumb src={src} kind={n.kind} text={n.kind === "text" ? (o?.text || "").slice(0, 160) : ""} />
    </button>
    <div className="stack-meta"><span className="t">{title(n)}</span><button className="linkbtn" data-stack-take onClick={onTake}>移出</button></div>
  </div>;
}

/* ---------- 分组运行 ---------- */
const fmtSecs = (s: number) => (s < 60 ? `${Math.round(s)} 秒` : `${Math.round(s / 60)} 分钟`);

/** 运行前确认：列出要跑的节点数、预计调用次数（按类型 / 模型）、预计耗时、跳过的节点 */
export function confirmRunGroup(ctl: Ctl, ids: string[], label = "分组") {
  const plan = planGroup(ctl.store, ids);
  if (!plan.total) { ctl.store.toast(plan.skipped.length ? `没有可运行的节点：${plan.skipped[0].title}（${plan.skipped[0].why}）` : "分组里没有可运行的生成节点"); return; }
  openModal((close) => <RunGroupConfirm ctl={ctl} plan={plan} label={label} close={close} />, "rungroup");
}
function RunGroupConfirm({ ctl, plan, label, close }: { ctl: Ctl; plan: GroupPlan; label: string; close: () => void }) {
  const [busy, setBusy] = useState(false);
  const kinds = (Object.keys(plan.byKind) as GenKind[]).filter((k) => plan.byKind[k]);
  const go = async () => {
    setBusy(true); close();
    ctl.store.toast(`开始运行「${label}」：${plan.total} 个节点，按依赖分 ${plan.levels.length} 步`);
    const r = await runGroup(ctl.store, plan);
    ctl.store.toast(r.failed || r.skipped ? `「${label}」运行结束：成功 ${r.ok}，失败 ${r.failed}${r.skipped ? `，${r.skipped} 个因上游失败未运行` : ""}` : `「${label}」运行完成：${r.ok} 个节点`, 5000);
  };
  return <>
    <ModalHead title={<>运行「{label}」</>} icon="play" />
    <div className="mbd rg">
      <div className="rg-sum">
        <div><b className="tnum">{plan.total}</b><span>个节点</span></div>
        <div><b className="tnum">{plan.calls}</b><span>次模型调用</span></div>
        <div><b className="tnum">≈{fmtSecs(plan.secs)}</b><span>预计耗时</span></div>
      </div>
      <div className="sec"><span>预计消耗</span></div>
      {kinds.map((k) => <div key={k} className="row"><span>{TYPE_LABEL[k]}</span><b className="tnum">{plan.byKind[k]} 次</b></div>)}
      {plan.byModel.map((m) => <div key={m.name} className="row sub"><span>{m.name}</span><span className="tnum">{m.calls} 次</span></div>)}
      {plan.skipped.length ? <><div className="sec"><span>不会运行（{plan.skipped.length}）</span></div>
        {plan.skipped.slice(0, 6).map((x) => <div key={x.id} className="row sub"><span>{x.title}</span><span>{x.why}</span></div>)}</> : null}
      <p className="rg-note">按服务商的用量计费；已有结果的节点会追加一个新版本。同一步里互不依赖的节点并行运行，某个节点失败时它的下游不再运行。</p>
      <div className="rg-foot"><button className="btn" onClick={close}>取消</button><button className="btn solid" data-rg="go" disabled={busy} onClick={() => void go()}><Icon name="play" size="s" />运行 {plan.total} 个节点</button></div>
    </div>
  </>;
}

/** 分组 / 多选里可运行的节点 id（堆叠展开成员） */
export function runnableIds(store: Ctl["store"], nodes: CanvasNode[]): string[] {
  const doc = store.state.doc; const out: string[] = [];
  for (const n of nodes) {
    if (n.kind === "group") (isStack(n) ? stackItems(doc, n) : (n.children || []).map((c) => store.node(c)).filter((x): x is CanvasNode => !!x)).forEach((c) => { if (isGenKind(c.kind)) out.push(c.id); });
    else if (isGenKind(n.kind)) out.push(n.id);
  }
  return [...new Set(out)];
}
export const groupLabel = (n: CanvasNode) => (isStack(n) ? "堆叠" : n.text && n.text !== "分组" ? n.text : "分组");

/* ---------- 分组 / 选中节点「存为我的模板」（TapNow Create Template） ---------- */
/** 分组 / 堆叠展开成员，取出子画布（只保留两端都在里面的连线） */
export function subDoc(store: Ctl["store"], nodes: CanvasNode[]): CanvasDoc {
  const doc = store.state.doc; const ids = new Set<string>();
  for (const n of nodes) { if (n.kind === "group") (n.children || []).forEach((c) => { if (store.node(c)) ids.add(c); }); else ids.add(n.id); }
  return { nodes: doc.nodes.filter((n) => ids.has(n.id)), edges: doc.edges.filter((e) => ids.has(e.from) && ids.has(e.to)), comments: [] };
}
export function saveAsTemplate(ctl: Ctl, nodes: CanvasNode[], name: string) {
  const sub = subDoc(ctl.store, nodes);
  if (!sub.nodes.length) { ctl.store.toast("没有可保存的节点"); return; }
  openModal((close) => <SaveTemplate ctl={ctl} doc={sub} name={name} close={close} />, "rungroup");
}
function SaveTemplate({ ctl, doc, name, close }: { ctl: Ctl; doc: CanvasDoc; name: string; close: () => void }) {
  const [title, setTitle] = useState(name); const [desc, setDesc] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const save = async () => {
    if (!title.trim()) { setErr("请填写模板名称"); return; }
    setBusy(true); setErr("");
    const coverDataUrl = await renderCanvasThumb({ doc, width: 480, height: 480, theme: ctl.store.state.ui.theme, structure: true, fit: "fill" }).catch(() => undefined);
    const r = await savePersonalTemplate({ title, prompt: desc, doc, coverDataUrl });
    setBusy(false);
    if (!r.ok) { setErr(r.error || "保存失败"); return; }
    close(); ctl.store.toast(`已存为我的模板「${title.trim()}」：${doc.nodes.length} 个节点`);
  };
  return <>
    <ModalHead title="存为我的模板" icon="layout" />
    <div className="mbd rg">
      <div className="sec"><span>模板名称</span></div>
      <input className="rg-input" autoFocus value={title} maxLength={40} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      <div className="sec"><span>说明（可选）</span></div>
      <textarea className="rg-input" rows={3} value={desc} maxLength={300} onChange={(e) => setDesc(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      <p className="rg-note">保存 {doc.nodes.length} 个节点和它们之间的 {doc.edges.length} 条连线；提示词和参数会保存，生成结果不保存。{err ? <><br /><span style={{ color: "var(--bad)" }}>{err}</span></> : null}</p>
      <div className="rg-foot"><button className="btn" onClick={close}>取消</button><button className="btn solid" data-tpl="save" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</button></div>
    </div>
  </>;
}
