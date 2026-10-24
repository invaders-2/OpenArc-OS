/**
 * 选中单个节点时：节点上方工具条 + 节点下方生成面板。
 * 生成面板：输入（可拖动排序）→ 提示词（@ 引用上游分段）→ 提示 → 请求预览 → 底栏（模型 / 参数 / 张数 / 发送）。
 * 上游连着多维表格时，面板中间出现「生成输入」逐行列表与批量设置。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { afterInputsChanged, title } from "../actions";
import { buildRequest, rolesFor, ROLE_LABEL, runNode, stopNode } from "../engine";
import { bgColor, CAMERAS, clamp, clampParams, genOf, NODE_BG, NODE_TAG, tagColor, inputsOf, isGenKind, outOf, ratioWH, refsIn, sectionsOf, srcOf, STYLES, textOf, TYPE_ICON, TYPE_LABEL, VMODES, type AudioParams, type GenKind, type ImageParams, type ModelSpec, type TextParams, type VideoParams, type VideoMode } from "../model";
import { batchOf, batchRows, OUTPUT_MODES, rowsToRun, withBatch, type BatchSettings } from "../table";
import { useCtl, useS } from "./ctx";
import { Icon, type IconName } from "./Icon";
import { download } from "./menus";
import { saveNodeToLibrary } from "./Library";
import { closePop, openPop } from "./overlay";
import { useAssetUrl } from "./useAsset";
import { useEditorState } from "./editors/registry";

export function SelectionUI() {
  const ctl = useCtl(); const ui = useS((s) => s.ui); const doc = useS((s) => s.doc); useS((s) => s.view); const runtime = useS((s) => s.runtime);
  const editing = useEditorState();
  const id = ui.sel.size === 1 && !ui.dragging && !editing ? [...ui.sel][0] : null;
  const node = id ? doc.nodes.find((n) => n.id === id) : undefined;
  const tbRef = useRef<HTMLDivElement>(null); const gpRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ tb: { left: number; top: number } | null; gp: { left: number; top: number } | null }>({ tb: null, gp: null });
  const [enterKey, setEnterKey] = useState(id);
  useEffect(() => { if (id !== enterKey) setEnterKey(id); }, [id, enterKey]);
  useLayoutEffect(() => {
    if (!node) return; const sr = ctl.rect(); const a = ctl.toScreen(node.x, node.y), b = ctl.toScreen(node.x + node.w, node.y + 24 + node.h);
    const cx = (a.x + b.x) / 2 - sr.left; let tb = null, gp = null;
    if (tbRef.current) { const tw = tbRef.current.offsetWidth; const ty = a.y - sr.top - 52; tb = ty > sr.height - 60 || b.y < sr.top ? { left: -9999, top: -9999 } : { left: clamp(cx - tw / 2, 8, sr.width - tw - 8), top: Math.max(8, ty) }; }
    if (gpRef.current) { const gw = gpRef.current.offsetWidth, gh = gpRef.current.offsetHeight; let top = b.y - sr.top + 14; const safeB = gpRef.current.closest(".cn-root.in-win") ? 76 : 8; /* 嵌在系统窗口里：底部给会弹出的 Dock 让位 */ if (top + gh > sr.height - safeB) top = Math.max(8, sr.height - gh - safeB); gp = { left: clamp(cx - gw / 2, 8, sr.width - gw - 8), top }; }
    if (JSON.stringify(tb) !== JSON.stringify(pos.tb) || JSON.stringify(gp) !== JSON.stringify(pos.gp)) setPos({ tb, gp });
  });
  if (!node) return null;
  const run = runtime[node.id];
  return <>
    <Toolbar key={"t" + node.id} refEl={tbRef} node={node} running={!!run} progress={run?.progress || 0} style={pos.tb || { left: -9999, top: -9999 }} />
    {isGenKind(node.kind) ? <div id="gp" key={"g" + node.id} ref={gpRef} className="float enter" style={pos.gp || { left: -9999, top: -9999 }} onPointerDown={(e) => e.stopPropagation()}><GenPanel node={node} /></div> : null}
  </>;
}

function Toolbar({ node, running, progress, style, refEl }: { node: CanvasNode; running: boolean; progress: number; style: React.CSSProperties; refEl: React.RefObject<HTMLDivElement | null> }) {
  const ctl = useCtl(); const store = ctl.store; const out = isGenKind(node.kind) ? outOf(node) : null; const g = isGenKind(node.kind) ? genOf(node) : null;
  const B = (act: string, ic: IconName, tip: string, lab = "", on?: (el: HTMLElement) => void) => <button key={act} className={"ib tipT" + (lab ? " lab" : "")} data-tb={act} data-tip={tip} onClick={(e) => on ? on(e.currentTarget) : edit(act, e.currentTarget)}><Icon name={ic} />{lab}</button>;
  /** TapNow「背景颜色」：无色 + 7 种低饱和色，竖排弹出 */
  const bgBtn = () => <button key="bg" className="ib tipT bgdot-btn" data-tb="bg" data-tip="背景颜色" onClick={(e) => openPop(e.currentTarget, (close) => <div className="swatches v">
    <button className={"sw none" + (!g!.bg ? " on" : "")} aria-label="无" onClick={() => { close(); store.patchGen(node.id, { bg: undefined }, { history: true }); }} />
    {NODE_BG.map(([k, c]) => <button key={k} className={"sw" + (g!.bg === k ? " on" : "")} style={{ background: c }} aria-label={k} onClick={() => { close(); store.patchGen(node.id, { bg: k }, { history: true }); }} />)}
  </div>, "down", "left", "pop-sw")}><i className="bgdot" style={{ background: bgColor(g!.bg) || "var(--fg)" }} /></button>;
  /** TapNow「Pin」：6 种亮色标签，再点同色取消 */
  const tagBtn = () => <button key="pin" className={"ib tipT" + (g!.tag ? " on" : "")} data-tb="pin" data-tip={g!.tag ? "颜色标记" : "标记"} onClick={(e) => openPop(e.currentTarget, (close) => <div className="swatches h">
    {NODE_TAG.map(([k, c]) => <button key={k} className={"sw" + (g!.tag === k ? " on" : "")} style={{ background: c }} aria-label={k} onClick={() => { close(); store.patchGen(node.id, g!.tag === k ? { tag: undefined, pinned: false } : { tag: k, pinned: true }, { history: true }); }} />)}
  </div>, "up", "left", "pop-sw")}><Icon name="tag" />{g!.tag ? <i className="tagmini" style={{ background: tagColor(g!.tag)! }} /> : null}</button>;
  const edit = (k: string, el: Element) => window.dispatchEvent(new CustomEvent("cn:editor", { detail: { kind: k, id: node.id, anchor: el } }));
  let items: React.ReactElement[] = [];
  if (running) items = [<span key="e" className="est">生成中</span>, B("stop", "x", "停止生成", "", () => stopNode(store, node.id))];
  else if (node.kind === "image") items = !out ? [B("upload", "upload", "上传图片", "上传", () => window.dispatchEvent(new CustomEvent("cn:upload", { detail: { target: node.id, at: { x: node.x + 120, y: node.y + 120 } } })))]
    : [B("crop", "crop", "裁剪"), B("angle", "cube", "多角度"), B("mask", "brush", "局部重绘"), B("relight", "sun", "重打光"), B("more", "more", "更多"), <span key="s" className="vsep" />, tagBtn(), B("lib", "libadd", "保存到素材库", "", () => { store.patchGen(node.id, { fav: true }); store.toast(`「${g!.title}」已保存到素材库`); }), B("dl", "download", "下载", "", () => void download(node, store)), B("full", "expand", "全屏查看", "", () => window.dispatchEvent(new CustomEvent("cn:lightbox", { detail: node.id })))];
  else if (node.kind === "text") items = [bgBtn(), tagBtn(), <span key="s" className="vsep" />, B("copy", "copy", "复制全部", "", async () => { try { await navigator.clipboard.writeText(textOf(node)); store.toast("已复制全部内容"); } catch { store.toast("剪贴板不可用"); } }), B("lib", "libadd", "保存到素材库", "", (el) => { const r = el.getBoundingClientRect(); void saveNodeToLibrary(ctl, node, { x: r.left, y: r.bottom + 6 }); }), B("full", "expand", "全屏编辑", "", () => window.dispatchEvent(new CustomEvent("cn:textdoc", { detail: node.id })))];
  else if (node.kind === "video" && out) items = [B("frame", "frame", "截取当前帧为图片"), B("dl", "download", "下载", "", () => void download(node, store)), B("full", "expand", "全屏播放", "", () => window.dispatchEvent(new CustomEvent("cn:lightbox", { detail: node.id })))];
  else if (node.kind === "audio" && out) items = [B("dl", "download", "下载", "", () => void download(node, store))];
  if (!items.length) return null;
  return <div id="ntb" ref={refEl} className="float enter" style={style} onPointerDown={(e) => e.stopPropagation()}>{items}</div>;
}

/* ---------------- 生成面板 ---------------- */
function GenPanel({ node }: { node: CanvasNode }) {
  const ctl = useCtl(); const store = ctl.store;
  const doc = useS((s) => s.doc); const run = useS((s) => s.runtime[node.id]); const preview = useS((s) => s.ui.preview); const pick = useS((s) => s.ui.pick); useS((s) => s.models);
  const kind = node.kind as GenKind; const g = genOf(node); const m = store.modelOf(node); const p = g.params;
  const allIns = inputsOf(doc, node.id); const ins = allIns.filter((x) => x.node.kind !== "table"); const tables = allIns.filter((x) => x.node.kind === "table");
  const { roles, ignored } = rolesFor(kind, p, m, ins);
  const imgIns = ins.filter((x) => x.node.kind === "image");
  const optsRef = useRef<HTMLDivElement>(null); const [fit, setFit] = useState(true);
  useLayoutEffect(() => { const o = optsRef.current; if (o) setFit(o.scrollWidth <= o.clientWidth + 1); });
  const [draft, setDraft] = useState(g.prompt); const lastId = useRef(node.id);
  const [vadv, setVadv] = useState(false);
  useEffect(() => { if (lastId.current !== node.id || document.activeElement?.id !== "gpPrompt") { setDraft(g.prompt); lastId.current = node.id; } }, [g.prompt, node.id]);
  const commitPrompt = (v: string) => { if (v !== genOf(store.node(node.id)!).prompt) store.patchGen(node.id, { prompt: v }); };

  const warns: string[] = [];
  if (!m) warns.push(`还没有可用的${TYPE_LABEL[kind]}模型，请在 设置 › 模型 里添加。`);
  if (m && kind === "image" && imgIns.length && !m.i2i) warns.push(`${m.name} 不支持参考图，${imgIns.length} 张图片输入不会发送。`);
  else if (m && kind === "image" && imgIns.length > (m.maxRefs || 0)) warns.push(`${m.name} 最多接收 ${m.maxRefs} 张参考图，按连线顺序只发送前 ${m.maxRefs} 张。`);
  if (m && kind === "text" && imgIns.length && !m.vision) warns.push(`${m.name} 不读图片，${imgIns.length} 张图片输入会被忽略。`);
  if (kind === "video") { const vp = p as VideoParams; if (["视频编辑", "视频延长", "参考视频生视频"].includes(vp.mode) && !ins.some((x) => x.node.kind === "video") && !tables.length) warns.push(`「${vp.mode}」需要连入一段视频。`); if (vp.mode === "数字人" && !(imgIns.length && ins.some((x) => x.node.kind === "audio"))) warns.push("「数字人」需要 1 张人像和 1 段音频。"); if (imgIns.length && vp.mode === "文生视频") warns.push("当前是文生视频，图片输入不会发送。切到「首帧」可以用上第 1 张图。"); }
  refsIn(g.prompt, ins).missing.forEach((r) => warns.push(`找不到引用「@${r}」：确认上游节点里有这一段。`));

  const set = (patch: Partial<typeof p>) => store.patchGen(node.id, (gg) => ({ params: { ...gg.params, ...patch } as typeof p }));
  const send = () => { commitPrompt(draft); runNode(store, node.id).catch((err) => { console.error(err); store.toast("生成出错：" + (err instanceof Error ? err.message : String(err))); }); };
  const est = m ? (kind === "image" ? `约 ${m.secs * ((p as ImageParams).count || 1)}s` : `约 ${m.secs}s`) : "";

  // 输入芯片拖动排序
  const chipDrag = useRef<{ moved: boolean } | null>(null);
  const onChipDown = (e: React.PointerEvent, edgeId: string) => {
    if ((e.target as HTMLElement).closest("[data-rm]")) return; e.stopPropagation();
    const chip = e.currentTarget as HTMLElement; const box = chip.parentElement!; const chips = [...box.querySelectorAll<HTMLElement>(".chip-in")];
    const from = chips.indexOf(chip); const rects = chips.map((c) => c.getBoundingClientRect()); const step = rects.length > 1 ? rects[1].left - rects[0].left : 46;
    let moved = false, to = from; const sx = e.clientX; chip.setPointerCapture(e.pointerId); chipDrag.current = { moved: false };
    chip.onpointermove = (ev) => { const dx = ev.clientX - sx; if (!moved && Math.abs(dx) < 4) return; if (!moved) { moved = true; chipDrag.current!.moved = true; chip.classList.add("dragging"); chips.forEach((c) => c !== chip && c.classList.add("shift")); } chip.style.transform = `translateX(${dx}px) scale(1.06)`; to = clamp(Math.round(from + dx / step), 0, chips.length - 1); chips.forEach((c, i) => { if (c === chip) return; let off = 0; if (from < to && i > from && i <= to) off = -step; if (from > to && i < from && i >= to) off = step; c.style.transform = off ? `translateX(${off}px)` : ""; }); };
    chip.onpointerup = () => { chip.onpointermove = null; chips.forEach((c) => { c.style.transform = ""; c.classList.remove("shift", "dragging"); }); if (!moved) { chipDrag.current = null; chipMenu(edgeId, chip); return; } setTimeout(() => (chipDrag.current = null), 50); if (to !== from) { const list = allIns.map((x) => x.edge.id); const [it] = list.splice(from, 1); list.splice(to, 0, it); store.reorderInputs(node.id, list); afterInputsChanged(store, node.id); store.toast(`「${title(store.node(allIns[from].node.id)!)}」移到第 ${to + 1} 位`); } };
  };
  const chipMenu = (edgeId: string, anchor: Element) => {
    const x = allIns.find((y) => y.edge.id === edgeId)!; const i = allIns.indexOf(x); const src = x.node;
    const move = (d: number) => { const list = allIns.map((y) => y.edge.id); [list[i], list[i + d]] = [list[i + d], list[i]]; store.reorderInputs(node.id, list); afterInputsChanged(store, node.id); };
    openPop(anchor, (close) => <>
      <div className="mh">输入 {i + 1} · {title(src)}</div>
      <button className="mi" disabled={i === 0} onClick={() => { close(); move(-1); }}><Icon name="up" size="s" />前移一位</button>
      <button className="mi" disabled={i === allIns.length - 1} onClick={() => { close(); move(1); }}><Icon name="down" size="s" />后移一位</button>
      {src.kind === "text" ? <button className="mi" onClick={() => { close(); const key = Object.keys(sectionsOf(textOf(src)))[0] || ""; const v = (draft ? draft + " " : "") + "@" + title(src) + (key ? "·" + key : ""); setDraft(v); commitPrompt(v); ctl.focusPrompt(); }}><Icon name="link" size="s" />在提示词里引用</button> : null}
      <button className="mi" onClick={() => { close(); ctl.focusNode(src.id); }}><Icon name="search" size="s" />在画布中定位</button>
      <button className="mi danger" onClick={() => { close(); store.removeEdge(edgeId); afterInputsChanged(store, node.id); }}><Icon name="x" size="s" />移除这个输入</button>
    </>);
  };
  const refMenu = (ta: HTMLTextAreaElement) => {
    const opts: Array<[string, string]> = []; ins.forEach((x) => { if (x.node.kind === "text") Object.keys(sectionsOf(textOf(x.node))).forEach((k) => opts.push([title(x.node), k])); });
    if (!opts.length) return store.toast("上游没有可引用的分段文本。连一个输出“海报1/海报2…”的文本节点试试");
    openPop(ta, (close) => <><div className="mh">引用上游文本中的一段</div>{opts.map(([t, k]) => <button key={t + k} className="mi" onClick={() => { close(); const v = ta.value.replace(/@$/, "@" + t + "·" + k + " "); setDraft(v); commitPrompt(v); setTimeout(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = v.length; }, 0); }}><Icon name="text" size="s" />{t} › {k}</button>)}</>);
  };

  const ph = kind === "text" ? (g.manual ? "这是手写文本节点。写一条指令可以让模型改写它，或双击节点直接编辑" : (p as TextParams).output === "table" ? "描述要拆成哪些行、每行包含什么，上游文字和素材会一起发送" : (p as TextParams).output === "storyboard" ? "描述这条片子的内容，会拆成逐镜头的分镜表" : "写给模型的指令，上游连进来的文字和图片会作为上下文") : kind === "video" ? "描述镜头运动、主体动作和氛围" : kind === "audio" ? "描述想要的音乐或声音" : "描述任何你想要生成的内容，输入 @ 引用上游节点";
  const pill = (k: string, content: React.ReactNode, on = false, extraCls = "") => <button key={"p-" + k} className={"pill" + (on ? " on" : "") + (extraCls ? " " + extraCls : "")} data-p={k} onClick={(e) => paramPop(ctl, node, k, e.currentTarget)}>{content}</button>;
  const vline = (k: string) => <span key={k} className="vline" />;
  const foot: React.ReactNode[] = [pill("model", <><Icon name="sparkle" size="s" />{m?.name || "未配置模型"}<Icon name="down" size="xs" /></>)];
  if (kind === "image") { const ip = p as ImageParams; foot.push(vline("v1"), pill("ratio", <><Icon name="ratio" size="s" />{ip.ratio} <span className="sub">·</span> {ip.size}{ip.search ? <span className="sub"> · 联网</span> : null}</>)); if (m?.style) foot.push(vline("v2"), pill("style", <><Icon name="palette" size="s" /><span className="lbl">{ip.style === "无" ? "风格" : ip.style}</span></>, ip.style !== "无")); if (m?.camera) foot.push(vline("v3"), pill("camera", <><Icon name="camera" size="s" /><span className="lbl">{ip.camera.on ? CAMERAS.body[ip.camera.body] : "摄影机控制"}</span></>, ip.camera.on)); }
  // 视频：同 TapNow，一个合并参数块「生成方式 · 比例 · 清晰度 · 时长」+ 有声开关 + 高级设置抽屉
  if (kind === "video") { const vp = p as VideoParams; foot.push(vline("v1"), pill("vset", <><Icon name="ratio" size="s" />{vp.mode}{(m?.ratios || []).length && vp.ratio ? <> <span className="sub">·</span> {vp.ratio}</> : null} <span className="sub">·</span> {vp.res}{m?.durs && !m.durs.length ? <> <span className="sub">·</span> 自动时长</> : vp.dur ? <> <span className="sub">·</span> {vp.dur}s</> : null}</>));
    if (m?.audio) foot.push(<button key="vs" className={"pill sq-pill tipT" + (vp.sound ? " on" : "")} data-p="vsound" data-tip={vp.sound ? "生成音频：开" : "生成音频：关"} onClick={() => set({ sound: !vp.sound })}><Icon name="audio" size="s" /></button>);
    foot.push(<button key="va" className={"pill sq-pill tipT" + (vadv ? " on" : "")} data-p="vadv" data-tip="高级设置" onClick={() => setVadv(!vadv)}><Icon name="settings" size="s" /></button>); }
  if (kind === "text") { const tp = p as TextParams; foot.push(vline("v0"), pill("output", <><Icon name={tp.output === "table" || tp.output === "storyboard" ? "grid" : "text"} size="s" />{OUTPUT_MODES.find((o) => o[0] === (tp.output || "text"))![1]}<Icon name="down" size="xs" /></>, tp.output === "table" || tp.output === "storyboard")); if (m?.search) foot.push(vline("v1"), <button key="ts" className={"pill" + (tp.search ? " on" : "")} data-p="tsearch" onClick={() => set({ search: !tp.search })}><Icon name="search" size="s" />联网{tp.search ? "：开" : "：关"}</button>); }
  if (kind === "audio") { const ap = p as AudioParams; foot.push(vline("v1"), pill("akind", <><Icon name="audio" size="s" />{ap.kind}</>), vline("v2"), pill("adur", <>{ap.dur}</>)); }
  return <>
    <div className="gp-in">
      <button className={"sq tipT" + (pick === node.id ? " on" : "")} data-p="pick" data-tip="从画布选择输入" onClick={() => { const on = pick !== node.id; store.setUI({ pick: on ? node.id : null }); if (on) store.toast("点画布上的节点，把它连成这个节点的输入；Esc 结束"); }}><Icon name="cursor" size="s" /></button>
      {allIns.map((x) => { const src = srcOf(x.node); const role = roles.get(x.edge.id); const show = kind === "video" && x.node.kind !== "text" && x.node.kind !== "table"; return (
        <button key={x.edge.id} className={"chip-in" + (src ? "" : " txt") + (ignored.has(x.edge.id) ? " ignored" : "")} data-chip={x.edge.id} title={title(x.node)} draggable={false}
          onPointerDown={(e) => onChipDown(e, x.edge.id)} onPointerEnter={() => store.setUI({ hlEdge: x.edge.id, hlNode: x.node.id })} onPointerLeave={() => store.setUI({ hlEdge: null, hlNode: null })}>
          {src ? <ChipImg src={src} /> : <Icon name={x.node.kind === "table" ? "grid" : TYPE_ICON[x.node.kind as GenKind] || "layers"} size="s" />}
          <span className="ord">{x.order + 1}</span>
          {show ? <span className="role">{ignored.has(x.edge.id) ? "忽略" : ROLE_LABEL[role!]}</span> : null}
          <span className="x" data-rm={x.edge.id} onPointerDown={(e) => { e.stopPropagation(); store.removeEdge(x.edge.id); afterInputsChanged(store, node.id); store.toast(`已移除输入「${title(x.node)}」`); }}><Icon name="x" size="xs" /></span>
        </button>); })}
      <button className="sq tipT" data-p="addin" data-tip="添加输入" onClick={(e) => openPop(e.currentTarget, (close) => <>
        <button className="mi" onClick={() => { close(); store.setUI({ pick: node.id }); store.toast("点画布上的节点，把它连成这个节点的输入；Esc 结束"); }}><Icon name="cursor" size="s" />从画布选择</button>
        <button className="mi" onClick={() => { close(); window.dispatchEvent(new CustomEvent("cn:upload", { detail: { at: { x: node.x - 360, y: node.y + 120 }, linkTo: node.id } })); }}><Icon name="upload" size="s" />上传图片</button>
        <button className="mi" onClick={() => { close(); store.setUI({ drawer: "assets" }); window.dispatchEvent(new CustomEvent("cn:lib-link", { detail: node.id })); }}><Icon name="folder" size="s" />从素材库选择</button>
      </>)}><Icon name="plus" size="s" /></button>
      <span className="grow" />
      <button className={"linkbtn" + (preview ? " on" : "")} data-p="preview" onClick={() => store.setUI({ preview: !preview })}><Icon name="text" size="xs" />请求预览</button>
    </div>
    <textarea id="gpPrompt" placeholder={ph} value={draft} onChange={(e) => { setDraft(e.target.value); if (e.target.value.endsWith("@")) refMenu(e.target); }} onBlur={() => commitPrompt(draft)}
      onKeyDown={(e) => { e.stopPropagation(); if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); send(); } if (e.key === "Escape") { (e.target as HTMLTextAreaElement).blur(); store.setUI({ sel: new Set(), pick: null }); } }} />
    {tables.length ? <BatchPanel node={node} /> : null}
    {warns.map((w) => <div key={w} className="gp-warn"><Icon name="alert" size="s" /><span>{w}</span></div>)}
    {preview ? <div className="gp-prev"><pre>{JSON.stringify(previewOf(ctl, node), null, 2)}</pre></div> : null}
    <div className="gp-foot">
      <div className={"gp-opts" + (fit ? " fit" : "")} ref={optsRef}>{foot}</div>
      <div className="gp-act">
        <button className="pill ghost mic" data-p="mic" title="语音输入" onClick={(e) => voice(ctl, node, e.currentTarget, (v) => { setDraft(v); commitPrompt(v); })}><Icon name="mic" size="s" /></button>
        {kind === "image" ? pill("count", <>{(p as ImageParams).count}×</>) : null}
        {kind === "video" ? pill("vtimes", <>{(p as VideoParams).times || 1}×</>) : null}
        <span className="sendgrp"><span className="est tnum" title="预计耗时">{est}{m?.local ? " · 本机" : ""}</span>
          {run ? <button className="send busy" data-p="stop" title="停止生成" onClick={() => stopNode(store, node.id)}><i className="ring"><svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9" /></svg></i><span className="sqr" /></button>
            : <button className="send" data-p="send" title="生成 ⌘↵" onClick={send}><Icon name="send" size="s" /></button>}
        </span>
      </div>
    </div>
    {kind === "video" && vadv ? <div className="gp-adv">
      <div className="row"><span>多镜头<span className="d">按提示词里的分镜自动切镜头{m?.multiShot ? "" : "（当前模型不支持，会忽略）"}</span></span><button className={"sw" + ((p as VideoParams).multiShot ? " on" : "")} data-p="vmulti" disabled={!m?.multiShot} onClick={() => set({ multiShot: !(p as VideoParams).multiShot })} /></div>
    </div> : null}
  </>;
}

function ChipImg({ src }: { src: string }) { const u = useAssetUrl(src); return u ? <img src={u} alt="" draggable={false} /> : <Icon name="image" size="s" />; }

/** 请求预览：生成节点给出发给后端的请求；连着表格时给出第一行的请求和总行数 */
function previewOf(ctl: ReturnType<typeof useCtl>, node: CanvasNode) {
  const store = ctl.store; const rows = batchRows(store.state.doc, node.id);
  const req = buildRequest(store, node, rows[0]); if (!req) return { error: "没有可用模型" };
  const { model, ...rest } = req;
  return { ...rest, model: { configId: model.id, name: model.name }, ...(rows.length ? { batch: { rows: rowsToRun(rows, batchOf(node).settings).length, previewRow: rows[0]?.row } } : {}) };
}

/* ---------------- 批量（上游连着多维表格） ---------------- */
function BatchPanel({ node }: { node: CanvasNode }) {
  const ctl = useCtl(); const store = ctl.store; const doc = useS((s) => s.doc);
  const rows = batchRows(doc, node.id); const { settings: s, journal } = batchOf(node); const todo = new Set(rowsToRun(rows, s).map((r) => r.row));
  const setS = (patch: Partial<BatchSettings>) => store.updateNode(node.id, (n) => withBatch(n, { settings: patch }));
  const stOf = (row: number) => journal?.rows.find((r) => r.row === row);
  const first = rows.filter((r) => todo.has(r.row)).slice(0, s.concurrency).map((r) => r.row);
  return <div className="gp-batch">
    <div className="bh"><Icon name="grid" size="s" /><b>生成输入</b><span className="tnum">{s.manual ? `独立运行 · 已选 ${s.selected.filter((x) => rows.some((r) => r.row === x)).length}/${rows.length}` : `批量 ${todo.size} 行 · 首批 ${Math.min(s.concurrency, todo.size)}`}</span><span className="sp" />{journal ? <button className="linkbtn" onClick={() => store.updateNode(node.id, (n) => withBatch(n, { journal: null }))} title="清除上次运行记录，下次从头生成">重置记录</button> : null}</div>
    <div className="blist">
      {rows.map((r) => { const j = stOf(r.row); const sel = s.manual ? s.selected.includes(r.row) : first.includes(r.row); return (
        <button key={r.row} className={"brow" + (sel ? " sel" : "") + (todo.has(r.row) ? "" : " skip") + (s.manual ? "" : " dim")} onClick={() => { if (!s.manual) return; setS({ selected: s.selected.includes(r.row) ? s.selected.filter((x) => x !== r.row) : [...s.selected, r.row].sort((a, b) => a - b) }); }}>
          <span className="n tnum">{r.row}</span>
          <span className="md">{r.media.slice(0, 3).map((md) => <RowThumb key={md.nodeId} src={md.src} kind={md.kind} />)}</span>
          <p>{r.text || "仅媒体输入"}</p>
          <span className={"st" + (j?.status === "completed" ? " ok" : j?.status === "failed" ? " bad" : "")}>{j ? { completed: "已完成", failed: "失败", running: "生成中", pending: "待生成" }[j.status] : ""}</span>
        </button>); })}
      {!rows.length ? <div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>上游表格还没有行</span></div> : null}
    </div>
    <div className="bctl">
      <label title="同时生成几行（1–8）">并发数<input type="number" min={1} max={8} value={s.concurrency} onChange={(e) => setS({ concurrency: clamp(+e.target.value || 1, 1, 8) })} onKeyDown={(e) => e.stopPropagation()} /></label>
      {!s.manual ? <label title="从第几行开始">起始行<input type="number" min={1} max={Math.max(1, rows.length)} value={s.startRow} onChange={(e) => setS({ startRow: clamp(+e.target.value || 1, 1, Math.max(1, rows.length)) })} onKeyDown={(e) => e.stopPropagation()} /><span style={{ color: "var(--fg3)" }}>/ {rows.length}</span></label> : null}
      <button className={"tg" + (s.manual ? " on" : "")} onClick={() => setS({ manual: !s.manual })}>独立运行</button>
      <button className="tg" title="某一行失败后的处理" onClick={() => setS({ failure: s.failure === "stop" ? "continue" : "stop" })}>{s.failure === "stop" ? "遇错停止" : "遇错继续"}</button>
    </div>
  </div>;
}
function RowThumb({ src, kind }: { src: string; kind: string }) { const u = useAssetUrl(src); return u ? <img src={u} alt="" /> : <i><Icon name={kind === "video" ? "video" : kind === "audio" ? "audio" : "image"} size="xs" /></i>; }

/* ---------------- 参数弹层 ---------------- */
function paramPop(ctl: ReturnType<typeof useCtl>, node: CanvasNode, k: string, anchor: Element) {
  const store = ctl.store; const kind = node.kind as GenKind;
  const cur = () => { const n = store.node(node.id)!; return { g: genOf(n), m: store.modelOf(n) as ModelSpec | undefined }; };
  const set = (patch: Record<string, unknown>) => store.patchGen(node.id, (gg) => ({ params: { ...gg.params, ...patch } as typeof gg.params }));
  if (k === "model") {
    const list = store.modelsOf(kind);
    return openPop(anchor, (close) => <>
      <div className="mh">{TYPE_LABEL[kind]}模型 · 来自 设置 › 模型</div>
      {list.map((x) => <button key={x.id} className={"mi" + (x.id === cur().m?.id ? " on" : "")} data-v={x.id} onClick={() => { close(); store.rememberModel(kind, x.id); store.patchGen(node.id, (gg) => ({ params: clampParams(kind, gg.params, x) })); if (kind === "video") afterInputsChanged(store, node.id); }}>
        <span style={{ flex: 1 }}><span style={{ display: "flex", gap: 6, alignItems: "center" }}>{x.name}{x.tags.map((t) => <span key={t} className={"tag" + (t === "NEW" ? " new" : "")}>{t}</span>)}{x.specSource === "guess" ? <span className="tag" data-spec-source="guess" title="服务商没有提供该模型的参数规格，下面的比例 / 档位 / 选项是按模型名推断的，以实际生成为准">未验证</span> : null}</span>
          {kind === "video" ? <span className="mtags">{x.res?.length && !x.tags.some((t) => t.toLowerCase() === x.res![x.res!.length - 1].toLowerCase()) ? <span className="tag">{x.res[x.res.length - 1]}</span> : null}{x.durs?.length ? <span className="tag tnum">{Math.min(...x.durs) === Math.max(...x.durs) ? x.durs[0] + "S" : Math.min(...x.durs) + "-" + Math.max(...x.durs) + "S"}</span> : null}{x.audio ? <span className="tag"><Icon name="audio" size="xs" /></span> : null}<span className="tag">{(x.modes || []).length} 种方式</span></span> : null}
          <span className="d">{x.vendor}{kind === "image" ? ` · ${x.i2i ? "最多 " + x.maxRefs + " 张参考图" : "仅文生图"}` : kind === "video" ? "" : kind === "text" ? (x.vision ? " · 能读图" : " · 只读文字") : ""}{x.specSource === "guess" ? " · 参数按名字推断" : ""}</span></span>
      </button>)}
      {!list.length ? <div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>还没有配置{TYPE_LABEL[kind]}模型</span></div> : null}
      {ctl.host.openModelSettings ? <><div className="msep" /><button className="mi" onClick={() => { close(); ctl.host.openModelSettings!(); }}><Icon name="settings" size="s" />模型设置</button></> : null}
    </>, "up");
  }
  const { m } = cur(); if (!m) return;
  if (k === "ratio") return openPop(anchor, () => <RatioPop node={node} />, "up");
  if (k === "style") return openPop(anchor, (close) => <><div className="mh">风格预设</div><div className="styles">{STYLES.map(([s, bg]) => <button key={s} className={(cur().g.params as ImageParams).style === s ? "on" : ""} onClick={() => { close(); set({ style: s }); }}><i style={{ background: bg }} />{s}</button>)}</div></>, "up");
  if (k === "camera") return openPop(anchor, () => <CameraPop node={node} />, "up");
  if (k === "count") return openPop(anchor, (close) => <><div className="mh">一次生成几张</div>{[4, 2, 1].map((c) => <button key={c} className={"mi" + ((cur().g.params as ImageParams).count === c ? " on" : "")} disabled={!m.batch?.includes(c)} onClick={() => { close(); set({ count: c }); }}>{c}×<span className="k">{m.batch?.includes(c) ? (c > 1 ? (store.state.ui.batchMode === "stack" ? "堆叠在本节点" : "铺开成新节点") : "") : "该模型不支持"}</span></button>)}</>, "up");
  if (k === "vtimes") return openPop(anchor, (close) => <><div className="mh">一次生成几条</div>{[4, 2, 1].map((c) => <button key={c} className={"mi" + (((cur().g.params as VideoParams).times || 1) === c ? " on" : "")} disabled={!(m.times || [1]).includes(c)} onClick={() => { close(); set({ times: c }); }}>{c}×<span className="k">{(m.times || [1]).includes(c) ? (c > 1 ? "每条单独计费" : "") : "该模型不支持"}</span></button>)}</>, "up");
  if (k === "mode") return openPop(anchor, (close) => <><div className="mh">生成方式 · 会按输入自动选择</div>{(Object.keys(VMODES) as Array<keyof typeof VMODES>).map((x) => { const ok = (m.modes || []).includes(x); return <button key={x} className={"mi" + ((cur().g.params as VideoParams).mode === x ? " on" : "")} disabled={!ok} onClick={() => { close(); set({ mode: x }); }}><span style={{ flex: 1 }}>{x}<span className="d">{ok ? (x === "参考生视频" ? "最多 " + m.maxRefs + " 张参考图" : VMODES[x].need) : m.name + " 不支持"}</span></span><span className="k tnum">{VMODES[x].api}</span></button>; })}</>, "up");
  if (k === "vset") return openPop(anchor, () => <VideoSetPop node={node} m={m} />, "up");
  if (k === "vratio") return openPop(anchor, () => <SegPop node={node} groups={[["比例", "ratio", m.ratios || []], ["分辨率", "res", m.res || []]]} />, "up");
  if (k === "dur") return openPop(anchor, () => <DurPop node={node} m={m} />, "up");
  if (k === "akind") return openPop(anchor, (close) => <><div className="mh">类型</div>{(m.kinds || []).map((x) => <button key={x} className={"mi" + ((cur().g.params as AudioParams).kind === x ? " on" : "")} onClick={() => { close(); set({ kind: x }); }}>{x}</button>)}</>, "up");
  if (k === "adur") return openPop(anchor, (close) => <><div className="mh">时长</div>{(m.adurs || []).map((x) => <button key={x} className={"mi" + ((cur().g.params as AudioParams).dur === x ? " on" : "")} onClick={() => { close(); set({ dur: x }); }}>{x}</button>)}</>, "up");
  if (k === "output") return openPop(anchor, (close) => <><div className="mh">输出</div>{OUTPUT_MODES.map(([v, l, d]) => <button key={v} className={"mi" + (((cur().g.params as TextParams).output || "text") === v ? " on" : "")} onClick={() => { close(); set({ output: v }); }}><span className="ic"><Icon name={v === "text" ? "text" : "grid"} size="s" /></span><span>{l}<span className="d">{d}</span></span></button>)}<div className="msep" /><div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>表格会建在右侧并自动连线，再跑一次会更新同一张表</span></div></>, "up");
}

function useNodeParams<T>(node: CanvasNode) { const n = useS((s) => s.doc.nodes.find((x) => x.id === node.id)) || node; return genOf(n).params as T; }
function RatioPop({ node }: { node: CanvasNode }) {
  const ctl = useCtl(); const store = ctl.store; const p = useNodeParams<ImageParams>(node); const m = store.modelOf(node)!;
  const set = (patch: Partial<ImageParams>) => store.patchGen(node.id, (g) => ({ params: { ...(g.params as ImageParams), ...patch } }));
  const shape = (r: string) => { const [w, h] = ratioWH(r, 20); return <i style={{ width: w, height: h }} />; };
  return <>
    <div className="mh">画质</div><div className="seg">{(m.sizes || []).map((s) => <button key={s} className={p.size === s ? "on" : ""} onClick={() => set({ size: s })}>{s}</button>)}</div>
    <div className="mh">比例</div><div className="ratio-grid">{(m.ratios || []).map((r) => <button key={r} className={p.ratio === r ? "on" : ""} onClick={() => set({ ratio: r })}>{shape(r)}{r}</button>)}</div>
    {m.search ? <><div className="mh">联网搜索</div><div className="seg"><button className={p.search ? "on" : ""} onClick={() => set({ search: true })}>开</button><button className={!p.search ? "on" : ""} onClick={() => set({ search: false })}>关</button></div></> : <div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>{m.name} 不支持联网搜索</span></div>}
  </>;
}
function CameraPop({ node }: { node: CanvasNode }) {
  const store = useCtl().store; const p = useNodeParams<ImageParams>(node); const c = p.camera;
  const setC = (patch: Partial<ImageParams["camera"]>) => store.patchGen(node.id, (g) => ({ params: { ...(g.params as ImageParams), camera: { ...(g.params as ImageParams).camera, ...patch } } }));
  const seg = (label: string, key: "body" | "lens" | "aperture", list: string[]) => <><div className="mh">{label}</div><div className="seg">{list.map((b, i) => <button key={b} className={c[key] === i ? "on" : ""} onClick={() => setC({ [key]: i, on: true })}>{b}</button>)}</div></>;
  return <>
    <div className="row"><b>摄影机控制</b><button className={"sw" + (c.on ? " on" : "")} aria-label="启用" onClick={() => setC({ on: !c.on })} /></div>
    {seg("机身", "body", CAMERAS.body)}{seg("镜头", "lens", CAMERAS.lens)}
    <div className="mh">焦段 <b className="tnum" style={{ color: "var(--fg)" }}>{CAMERAS.focal[c.focal]}mm</b></div>
    <div style={{ padding: "0 10px 8px" }}><input type="range" className="slider" min={0} max={CAMERAS.focal.length - 1} value={c.focal} onChange={(e) => setC({ focal: +e.target.value, on: true })} /></div>
    {seg("光圈", "aperture", CAMERAS.aperture)}
  </>;
}
function SegPop({ node, groups }: { node: CanvasNode; groups: Array<[string, "ratio" | "res", string[]]> }) {
  const store = useCtl().store; const p = useNodeParams<VideoParams>(node);
  return <>{groups.map(([label, key, list]) => <div key={key}><div className="mh">{label}</div><div className="seg">{list.map((v) => <button key={v} className={p[key] === v ? "on" : ""} onClick={() => store.patchGen(node.id, (g) => ({ params: { ...(g.params as VideoParams), [key]: v } }))}>{v}</button>)}</div></div>)}</>;
}
/** 视频参数合并浮层（TapNow 同款分组：生成方式 / 比例 / 清晰度 / 生成时长 / 生成音频） */
function VideoSetPop({ node, m }: { node: CanvasNode; m: ModelSpec }) {
  const store = useCtl().store; const p = useNodeParams<VideoParams>(node);
  const set = (patch: Partial<VideoParams>) => store.patchGen(node.id, (g) => ({ params: { ...(g.params as VideoParams), ...patch } }));
  const shape = (r: string) => { const [w, h] = ratioWH(r, 16); return <i style={{ width: w, height: h }} />; };
  const modes = (m.modes || []) as VideoMode[];
  return <div className="vset">
    {modes.length > 1 ? <><div className="mh">生成方式</div><div className="seg wrap">{modes.map((x) => <button key={x} className={p.mode === x ? "on" : ""} title={VMODES[x].need} onClick={() => set({ mode: x })}>{x}</button>)}</div></> : null}
    {(m.ratios || []).length ? <><div className="mh">比例</div><div className="ratio-grid">{(m.ratios || []).map((r) => <button key={r} className={p.ratio === r ? "on" : ""} onClick={() => set({ ratio: r })}>{shape(r)}{r}</button>)}</div></> : null}
    {(m.res || []).length ? <><div className="mh">清晰度</div><div className="seg">{(m.res || []).map((r) => <button key={r} className={p.res === r ? "on" : ""} onClick={() => set({ res: r })}>{r}</button>)}</div></> : null}
    {(m.durs || []).length ? <><div className="mh">生成时长</div><div className="seg wrap">{(m.durs || []).map((d) => <button key={d} className={p.dur === d ? "on" : ""} onClick={() => set({ dur: d })}>{d}s</button>)}</div></> : <><div className="mh">生成时长</div><div className="lg-dim" style={{ padding: "2px 0 6px" }}>由模型自动决定</div></>}
    {m.audio ? <><div className="mh">生成音频</div><div className="seg"><button className={p.sound ? "on" : ""} onClick={() => set({ sound: true })}>开启</button><button className={!p.sound ? "on" : ""} onClick={() => set({ sound: false })}>关闭</button></div></> : null}
  </div>;
}
function DurPop({ node, m }: { node: CanvasNode; m: ModelSpec }) {
  const store = useCtl().store; const p = useNodeParams<VideoParams>(node);
  const set = (patch: Partial<VideoParams>) => store.patchGen(node.id, (g) => ({ params: { ...(g.params as VideoParams), ...patch } }));
  return <><div className="mh">时长</div><div className="seg">{(m.durs || []).map((d) => <button key={d} className={p.dur === d ? "on" : ""} onClick={() => set({ dur: d })}>{d}s</button>)}</div>
    {m.audio ? <div className="row"><span>同时生成声音</span><button className={"sw" + (p.sound ? " on" : "")} onClick={() => set({ sound: !p.sound })} /></div> : null}</>;
}

/* ---------------- 语音输入 ---------------- */
function voice(ctl: ReturnType<typeof useCtl>, node: CanvasNode, btn: HTMLElement, onText: (v: string) => void) {
  const SR = (window as unknown as { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any }).SpeechRecognition || (window as unknown as { webkitSpeechRecognition?: new () => any }).webkitSpeechRecognition;
  if (!SR) { ctl.store.toast("当前环境没有语音识别服务，可以用系统听写（按两下 Fn）输入"); return; }
  const r = new SR(); r.lang = "zh-CN"; r.interimResults = false; btn.classList.add("rec"); ctl.store.toast("正在听…说完会自动填进提示词", 2000);
  r.onresult = (e: any) => { const t = String(e.results?.[0]?.[0]?.transcript || ""); const cur = genOf(ctl.store.node(node.id)!).prompt; onText((cur ? cur + "，" : "") + t); };
  r.onerror = () => ctl.store.toast("没有听清，可以再试一次"); r.onend = () => btn.classList.remove("rec"); r.start();
  void closePop;
}
