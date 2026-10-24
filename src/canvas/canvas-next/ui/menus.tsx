/** 添加节点 / 右键 / ⊕ 端口菜单，以及节点内按钮动作 */
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { connect, copySelection, deleteSelection, duplicate, hasClip, paste, spreadHistory, title } from "../actions";
import { runChain } from "../engine";
import { genOf, inputsOf, isGenKind, outOf, TYPE_ICON, uid, type GenKind, NODE_DEFAULT_SIZE } from "../model";
import { emptyTable, withTable } from "../table";
import type { Ctl } from "./ctx";
import type { CanvasStore } from "../store";
import { Icon } from "./Icon";
import { openPop } from "./overlay";
import { groupSelection, LEGACY_DEFAULT, ungroup } from "./LegacyNodes";
import { saveNodeToLibrary } from "./Library";

type At = Element | { x: number; y: number };
const ITEMS: Array<[GenKind | "table", string, string]> = [["text", "文本", "脚本、广告词、品牌文案"], ["image", "图片", "宣传图、海报、封面"], ["video", "视频", "宣传视频、动画、电影"], ["audio", "音频", "音乐、配音、音效"], ["table", "多维表格", "逐行批量：一行一条生成任务"]];
const iconOf = (t: GenKind | "table") => (t === "table" ? "grid" : TYPE_ICON[t]);

export function createAt(ctl: Ctl, t: GenKind | "table", at: { x: number; y: number }, fromId: string | null = null): CanvasNode {
  const store = ctl.store;
  const n = t === "table" ? withTable({ id: uid("t"), kind: "table", x: Math.round(at.x - 210), y: Math.round(at.y - 40), w: 420, h: 220, text: "多维表格" }, emptyTable()) : store.newNode(t, at.x - (t === "text" ? 140 : 120), at.y - 40);
  store.addNodes([n], [], { select: true });
  if (fromId) connect(store, fromId, n.id, { quiet: true });
  if (t !== "table") ctl.focusPrompt();
  return store.node(n.id)!;
}

/** 辅助节点（3D / 时间线 / 片场 / 便签）：数据结构沿用旧版 CanvasDoc */
export function createLegacy(ctl: Ctl, kind: "model3d" | "timeline" | "scene3d" | "note", at: { x: number; y: number }) {
  const d = LEGACY_DEFAULT[kind]; let x = Math.round(at.x - d.w / 2), y = Math.round(at.y - 40);
  // 不压在已有节点上：往下挪到空位
  const hit = () => ctl.store.state.doc.nodes.some((o) => o.kind !== "group" && x < o.x + o.w + 20 && x + d.w + 20 > o.x && y < o.y + o.h + 44 && y + d.h + 44 > o.y);
  for (let i = 0; i < 40 && hit(); i++) y += 60;
  const n = { id: uid("n"), kind, x, y, w: d.w, h: d.h, text: d.text, ...(kind === "timeline" ? { clips: [] } : {}) } as CanvasNode;
  ctl.store.addNodes([n], [], { select: true });
}

export function addMenu(ctl: Ctl, anchor: At, at: { x: number; y: number }, fromId: string | null = null) {
  const store = ctl.store; const from = fromId ? store.node(fromId) : null;
  openPop(anchor, (close) => <>
    <div className="mh">添加节点{from ? ` · 自动连到「${title(from)}」` : ""}</div>
    {ITEMS.map(([t, l, d]) => <button key={t} className="mi" data-t={t} onClick={() => { close(); createAt(ctl, t, at, fromId); }}><span className="ic"><Icon name={iconOf(t)} size="s" /></span><span>{l}<span className="d">{d}</span></span></button>)}
    {from ? null : <><div className="mh">辅助工具</div>
      {([["model3d", "3D", "文生 / 图生 3D 模型", "cube"], ["timeline", "剪辑时间线", "把视频 / 音频排成一条片子并导出", "video"], ["scene3d", "3D 片场", "摆放几何体和模型，调机位", "cube"], ["note", "便签", "随手记一段说明", "pencil"]] as const).map(([k, l, d, ic]) => <button key={k} className="mi" data-t={k} onClick={() => { close(); createLegacy(ctl, k, at); }}><span className="ic"><Icon name={ic} size="s" /></span><span>{l}<span className="d">{d}</span></span></button>)}</>}
    {from ? null : <><div className="mh">添加资源</div><button className="mi" data-t="upload" onClick={() => { close(); window.dispatchEvent(new CustomEvent("cn:upload", { detail: { at } })); }}><span className="ic"><Icon name="upload" size="s" /></span><span>上传<span className="d">图片、视频、音频，也可以直接拖进画布</span></span></button></>}
  </>);
}

export function portMenu(ctl: Ctl, n: CanvasNode, side: "in" | "out", at: { x: number; y: number }) {
  const store = ctl.store;
  const types = ITEMS.filter(([t]) => (side === "out" ? !(t === "image" && n.kind === "audio") : !(n.kind === "image" && t === "audio")) && !(side === "in" && t === "table" && n.kind === "table"));
  const make = (t: GenKind | "table") => {
    const sz = t === "table" ? { w: 420, h: 220 } : NODE_DEFAULT_SIZE[t]; const w = sz.w; const h = sz.h;
    const x = side === "out" ? n.x + n.w + 120 : n.x - w - 120; let y = n.y + (n.h - h) / 2;
    // 同一侧已经有节点时往下避让，不叠在一起（先后从同一个 ⊕ 拉出多个节点）
    const hit = (yy: number) => store.state.doc.nodes.some((o) => o.x < x + w + 30 && o.x + o.w + 30 > x && o.y < yy + h + 56 && o.y + o.h + 56 > yy);
    for (let i = 0; i < 40 && hit(y); i++) y += 40;
    const c = createAt(ctl, t, { x: x + (t === "text" ? 140 : t === "table" ? 210 : 120), y: y + 40 });
    if (t !== "table" && (c.x !== x || c.y !== y)) store.updateNode(c.id, (q) => ({ ...q, x, y })); // 按算好的空位落位（各类型默认宽度不同）
    side === "out" ? connect(store, n.id, c.id, { quiet: true, select: true }) : connect(store, c.id, n.id, { quiet: true, select: false });
    store.setUI({ sel: new Set([c.id]) });
  };
  openPop(at, (close) => side === "out" ? <>
    <div className="mh">从「{title(n)}」继续生成</div>
    {types.map(([t, l, d]) => <button key={t} className="mi" data-t={t} onClick={() => { close(); make(t); }}><span className="ic"><Icon name={iconOf(t)} size="s" /></span><span>{l}<span className="d">{d}</span></span></button>)}
    <div className="msep" /><div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>也可以按住 ⊕ 拖到其他节点上直接连线</span></div>
  </> : <>
    <div className="mh">给「{title(n)}」添加输入</div>
    <button className="mi" data-k="up" onClick={() => { close(); window.dispatchEvent(new CustomEvent("cn:upload", { detail: { at: { x: n.x - 360, y: n.y + 120 }, linkTo: n.id } })); }}><span className="ic"><Icon name="upload" size="s" /></span><span>上传图片</span></button>
    <button className="mi" data-k="lib" onClick={() => { close(); store.setUI({ drawer: "assets" }); window.dispatchEvent(new CustomEvent("cn:lib-link", { detail: n.id })); }}><span className="ic"><Icon name="folder" size="s" /></span><span>从素材库选择</span></button>
    <button className="mi" data-k="pick" onClick={() => { close(); store.setUI({ sel: new Set([n.id]), pick: n.id }); store.toast("点画布上的节点，把它连成输入；Esc 结束"); }}><span className="ic"><Icon name="cursor" size="s" /></span><span>从画布选择</span></button>
    <div className="msep" />
    {types.map(([t, l]) => <button key={t} className="mi" data-t={t} onClick={() => { close(); make(t); }}><span className="ic"><Icon name={iconOf(t)} size="s" /></span><span>新建{l}节点<span className="d">作为第 {inputsOf(store.state.doc, n.id).length + 1} 个输入</span></span></button>)}
  </>);
}

export function nodeMenu(ctl: Ctl, at: { x: number; y: number }) {
  const store = ctl.store; const sel = [...store.state.ui.sel]; const n = store.node(sel[0]); if (!n) return; const multi = sel.length > 1;
  const gen = isGenKind(n.kind); const g = gen ? genOf(n) : null; const out = gen ? outOf(n) : null;
  openPop(at, (close) => {
    const act = (f: () => void) => () => { close(); f(); };
    return <>
      <button className="mi" data-k="lib" disabled={!(n.kind === "image" && out)} onClick={act(() => { store.patchGen(n.id, { fav: true }); store.toast(`「${title(n)}」已收藏`); })}><Icon name="star" size="s" />收藏</button>
      <button className="mi" data-k="assetlib" disabled={!gen || !(out?.url || out?.text)} onClick={act(() => void saveNodeToLibrary(ctl, n, at))}><Icon name="libadd" size="s" />存入资产库<span className="k">个人 / 团队</span></button>
      <button className="mi" data-k="allhist" disabled={!g || g.hist.length < 2} onClick={act(() => spreadHistory(store, n.id))}><Icon name="layers" size="s" />应用所有历史<span className="k">{g && g.hist.length > 1 ? g.hist.length + " 个版本" : ""}</span></button>
      <button className="mi" data-k="runup" disabled={!gen} onClick={act(() => void runChain(store, n.id, "up"))}><Icon name="runup" size="s" />运行到此（含上游）</button>
      <button className="mi" data-k="rundown" onClick={act(() => void runChain(store, n.id, "down"))}><Icon name="rundown" size="s" />从此运行下游</button>
      <button className="mi" data-k="dl" disabled={!out} onClick={act(() => void download(n, store))}><Icon name="download" size="s" />下载</button>
      <div className="msep" />
      <button className="mi" data-k="copy" onClick={act(() => copySelection(store))}><Icon name="copy" size="s" />复制<span className="k">⌘C</span></button>
      <button className="mi" data-k="paste" disabled={!hasClip()} onClick={act(() => paste(store))}><Icon name="copy" size="s" />粘贴<span className="k">⌘V</span></button>
      <button className="mi" data-k="dup" onClick={act(() => duplicate(store))}><Icon name="layers" size="s" />副本<span className="k">⌘D</span></button>
      {multi ? <button className="mi" data-k="group" onClick={act(() => groupSelection(store))}><Icon name="layers" size="s" />编组<span className="k">⌘G</span></button> : null}
      {n.kind === "group" ? <button className="mi" data-k="ungroup" onClick={act(() => ungroup(store, n.id))}><Icon name="layers" size="s" />取消分组<span className="k">⇧⌘G</span></button> : null}
      <button className="mi danger" data-k="del" onClick={act(() => deleteSelection(store))}><Icon name="trash" size="s" />删除{multi ? ` ${sel.length} 个` : ""}<span className="k">⌫, del</span></button>
      <div className="msep" />
      <button className="mi" data-k="clip" onClick={act(async () => { try { await navigator.clipboard.writeText(out?.text || g?.prompt || title(n)); store.toast("已复制到剪贴板"); } catch { store.toast("剪贴板不可用"); } })}><Icon name="copy" size="s" />复制到剪贴板</button>
    </>;
  });
}

export function blankMenu(ctl: Ctl, at: { x: number; y: number }, w: { x: number; y: number }) {
  const store = ctl.store;
  openPop(at, (close) => <>
    <button className="mi" data-k="up" onClick={() => { close(); window.dispatchEvent(new CustomEvent("cn:upload", { detail: { at: w } })); }}><Icon name="upload" size="s" />上传</button>
    <button className="mi" data-k="assets" onClick={() => { close(); store.setUI({ drawer: "assets" }); }}><Icon name="folder" size="s" />添加资产</button>
    <button className="mi" data-k="add" onClick={() => { close(); setTimeout(() => addMenu(ctl, at, w), 140); }}><Icon name="plus" size="s" />添加节点<span className="k"><Icon name="right" size="xs" /></span></button>
    <div className="msep" />
    <button className="mi" data-k="undo" onClick={() => { close(); store.undo(); }}><Icon name="undo" size="s" />撤销<span className="k">⌘Z</span></button>
    <button className="mi" data-k="redo" onClick={() => { close(); store.redo(); }}><Icon name="redo" size="s" />重做<span className="k">⇧⌘Z</span></button>
    <button className="mi" data-k="paste" disabled={!hasClip()} onClick={() => { close(); paste(store); }}><Icon name="copy" size="s" />粘贴<span className="k">⌘V</span></button>
  </>);
}

export function onNodeAct(ctl: Ctl, n: CanvasNode, act: string, e: React.SyntheticEvent) {
  const store = ctl.store; e.stopPropagation();
  if (act === "errok") { store.patchGen(n.id, { err: undefined }); return; }
  if (act === "fav") { const fav = !genOf(n).fav; store.patchGen(n.id, { fav }); store.toast(fav ? `已收藏「${title(n)}」到素材库` : "已取消收藏"); return; }
  if (act === "vprev" || act === "vnext") { const g = genOf(n); const hi = (g.hi + (act === "vnext" ? 1 : -1) + g.hist.length) % g.hist.length; const o = g.hist[hi]; store.updateNode(n.id, (x) => { const y = { ...x }; if (o?.w && o.h && (x.kind === "image" || x.kind === "video")) y.h = Math.round(Math.max(100, Math.min(520, (x.w * o.h) / o.w))); return y; }); store.patchGen(n.id, { hi }); }
}

/** 下载节点结果：资源库引用 / 远程地址先取成字节，按类型补扩展名（Electron 里 a[download] 只认能直接取到的地址） */
export async function download(n: CanvasNode, store?: CanvasStore) {
  const o = outOf(n); if (!o) return; const name = (genOf(n).title || "openarc").replace(/[\\/:*?"<>|]/g, "_");
  const save = (blob: Blob, ext: string) => { const a = document.createElement("a"); const u = URL.createObjectURL(blob); a.href = u; a.download = name + "." + ext; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 60_000); };
  if (o.text && !o.url) return save(new Blob([o.text], { type: "text/markdown" }), "md");
  let url = o.url || o.frame || ""; if (!url) return;
  try {
    if (url.startsWith("openarc-asset:")) { const d = store ? await store.backend.resolveAsset(url) : null; if (!d) throw new Error("资源不可用"); url = d; }
    else if (/^https?:\/\//i.test(url) && store?.backend.importRemote) { const ref = await store.backend.importRemote(store.state.canvasId, url, name); const d = ref.startsWith("openarc-asset:") ? await store.backend.resolveAsset(ref) : null; if (d) url = d; }
    const blob = await (await fetch(url)).blob();
    const ext = (blob.type.split("/")[1] || (n.kind === "video" ? "mp4" : n.kind === "audio" ? "mp3" : "png")).replace("jpeg", "jpg").replace("quicktime", "mov").replace("mpeg", "mp3").replace(/[^a-z0-9]/g, "");
    save(blob, ext);
    store?.toast(`已下载「${name}.${ext}」`);
  } catch (err) { store?.toast("下载失败：" + (err instanceof Error ? err.message : "未知错误")); }
}
