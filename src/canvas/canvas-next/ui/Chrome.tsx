/**
 * 画布四周的浮层：左上标题、右上按钮、左侧工具栏、底部缩放条、小地图、空状态 / 回到节点、
 * 评论、抽屉（素材 / 历史）、搜索 / 模板对话框、文件面板、Agent 收起时的圆球、提示条、全屏查看。
 */
import { shareMenu, SharePanels } from "./SharePanels";
import { LibrarySection } from "./Library";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanvasComment, CanvasNode } from "../../react-canvas/reactCanvasStore";
import { title } from "../actions";
import { bounds, defaultParams, genOf, inputsOf, isGenKind, outOf, srcOf, textOf, TYPE_ICON, TYPE_LABEL, uid, type GenKind, type TextParams, type VideoParams } from "../model";
import { emptyTable, withTable } from "../table";
import { useCtl, useS, type Ctl } from "./ctx";
import { EdgeBadge } from "./Edges";
import { Icon, Logo } from "./Icon";
import { addMenu } from "./menus";
import { ModalHead, openModal, openPop } from "./overlay";
import { applyTheme } from "./theme";
import { useAssetUrl } from "./useAsset";

export function Chrome() {
  const ctl = useCtl(); const store = ctl.store;
  const ui = useS((s) => s.ui); const name = useS((s) => s.name); const runs = useS((s) => s.runs); const nodes = useS((s) => s.doc.nodes); const view = useS((s) => s.view); const saving = useS((s) => s.saving); const peers = useS((s) => s.collab.peers);
  const [renaming, setRenaming] = useState(false);
  const zoomPct = Math.round(view.k * 100);
  return <>
    <div id="tl" className="float cap">
      <span className="logo"><Logo /></span><span className="sep" />
      {renaming ? <input className="ttl" id="ttlIn" autoFocus defaultValue={name} onBlur={(e) => { store.set({ name: e.target.value.trim() || name }); setRenaming(false); }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenaming(false); }} />
        : <span className="ttl" id="ttl" title="点击重命名" onClick={() => setRenaming(true)}>{name}</span>}
      <button className="ib tipB" style={{ width: 28, height: 28 }} id="canvasMenu" data-tip="切换画布 · 设置" onClick={(e) => canvasMenu(ctl, e.currentTarget, () => setRenaming(true))}><Icon name="down" size="s" /></button>
      {ctl.host.badge ? <span className="badge-preview">{ctl.host.badge}</span> : saving === "conflict" ? <span className="badge-preview">版本冲突</span> : saving === "error" ? <span className="badge-preview">未保存</span> : null}
    </div>
    <div id="tr" className="float">
      <div className="cap"><button id="connectAgent" className="tipB" data-tip="在其他 Agent 中打开" onClick={(e) => connectAgentPop(ctl, e.currentTarget)}><Icon name="plug" /><span className="lbl">连接 Agent</span></button></div>
      <div className="cap"><button id="usage" className="tipB" data-tip="本画布模型调用" onClick={(e) => { const c: Record<string, number> = { image: 0, video: 0, text: 0, audio: 0 }; runs.forEach((r) => (c[r.type] = (c[r.type] || 0) + 1)); openPop(e.currentTarget, () => <><div className="mh">本画布模型调用</div>{(["image", "video", "text", "audio"] as GenKind[]).map((k) => <div key={k} className="row"><span>{TYPE_LABEL[k]}</span><b className="tnum">{c[k]} 次</b></div>)}<div className="msep" /><div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>按模型服务商的用量计费</span></div></>, "down", "right"); }}><Icon name="bolt" size="s" /><span className="tnum">{runs.length}</span></button></div>
      {peers.length ? <div className="cap peers tipB" data-tip={`${peers.length + 1} 人在线`}>{peers.slice(0, 3).map((p, i) => <span key={p.id} className="pav">{(p.name || "协")[0]}{i === 2 && peers.length > 3 ? "+" : ""}</span>)}<span className="pav me">{ctl.host.user?.initial || "我"}</span></div> : null}
      <div className="cap"><button id="shareBtn" className="sq tipB" data-tip="共享与协作" onClick={(e) => ctl.host.openShare ? ctl.host.openShare() : store.backend.kind === "bridge" ? shareMenu(e.currentTarget, true, peers.length) : store.toast("共享需要在桌面版里打开这张画布")}><Icon name="share" /></button></div>
    </div>
    <div id="lb" className="float cap">
      <button className="ib primary tipR" id="addBtn" data-tip="添加节点" onClick={(e) => addMenu(ctl, e.currentTarget, ctl.center())}><Icon name="plus" /></button>
      <button className="ib tipR" data-drawer="search" data-tip="节点搜索 ⌘F" onClick={() => openSearch(ctl)}><Icon name="search" /></button>
      <button className={"ib tipR" + (ui.drawer === "assets" ? " on" : "")} data-drawer="assets" data-tip="素材库" onClick={() => store.setUI({ drawer: ui.drawer === "assets" ? null : "assets" })}><Icon name="folder" /></button>
      <button className="ib tipR" data-drawer="templates" data-tip="模板" onClick={() => openTemplates(ctl)}><Icon name="layout" /></button>
      <button className={"ib tipR" + (ui.cmtMode ? " on" : "")} id="cmtBtn" data-tip="评论 C" onClick={() => toggleCmt(ctl)}><Icon name="msg" /></button>
      <button className={"ib tipR" + (ui.drawer === "history" ? " on" : "")} data-drawer="history" data-tip="生成历史" onClick={() => store.setUI({ drawer: ui.drawer === "history" ? null : "history" })}><Icon name="history" /></button>
      <span className="div" />
      <button className="av tipR" id="avatar" data-tip="账户" onClick={(e) => openPop(e.currentTarget, (close) => <><div className="mh">账户</div><div className="row"><span>{ctl.host.user?.name || "本机用户"}</span><span style={{ color: "var(--fg3)", fontSize: 12 }}>{ctl.host.user?.role || ""}</span></div><div className="msep" /><button className="mi" onClick={() => { close(); canvasSettings(ctl); }}><Icon name="settings" size="s" />画布设置</button><button className="mi" onClick={() => { close(); showKeys(); }}><Icon name="grid" size="s" />快捷键</button></>, "right")}>{ctl.host.user?.initial || "我"}</button>
    </div>
    <div id="zb" className="float">
      <div className="cap">
        <button className={"ib tipT" + (ui.mini ? " on" : "")} id="miniBtn" data-tip="小地图" onClick={() => store.setUI({ mini: !ui.mini })}><Icon name="map" /></button>
        <button className={"ib tipT" + (ui.hideEdges ? " on" : "")} id="edgeBtn" data-tip={ui.hideEdges ? "显示连线" : "隐藏连线"} onClick={() => { store.setUI({ hideEdges: !ui.hideEdges }); store.toast(!ui.hideEdges ? "已隐藏连线，输入关系仍然生效" : "已显示连线"); }}><Icon name={ui.hideEdges ? "eye" : "eyeoff"} /></button>
        <button className={"ib tipT" + (ui.snap ? " on" : "")} id="snapBtn" data-tip="网格吸附" onClick={() => { store.setUI({ snap: !ui.snap }); store.toast(!ui.snap ? "拖动节点时吸附到 20px 网格" : "已关闭网格吸附"); }}><Icon name="grid" /></button>
        <button className="ib tipT" id="fitBtn" data-tip="适应画布 ⇧1" onClick={() => ctl.fitTo(store.state.doc.nodes)}><Icon name="fit" /></button>
        <input type="range" id="zoomR" min={15} max={200} step={1} aria-label="缩放" value={zoomPct} onChange={(e) => { const r = ctl.rect(); ctl.zoomAt(+e.target.value / 100, r.left + r.width / 2, r.top + r.height / 2); }} />
        <span id="zoomV" className="tnum">{zoomPct}%</span>
      </div>
      <button className="ib cap tipT" id="themeBtn" data-tip={ui.theme === "light" ? "浅色模式" : "深色模式"} onClick={(e) => themeMenu(ctl, e.currentTarget)}><Icon name={ui.theme === "light" ? "sun" : "moon"} /></button>
      <button className="ib cap tipT" id="help" data-tip="帮助" onClick={(e) => openPop(e.currentTarget, (close) => <><div className="mh">帮助</div><button className="mi" onClick={() => { close(); showKeys(); }}><Icon name="grid" size="s" />快捷键<span className="k">?</span></button></>, "up")}><Icon name="help" /></button>
    </div>
    {ui.mini ? <Minimap /> : null}
    <div id="hint" className="float">滚轮平移 · ⌘/Ctrl+滚轮缩放 · 拖动空白平移 · Shift 拖动框选 · 双击空白添加节点</div>
    <BackToNodes />
    {!nodes.length ? <div id="empty" className="float">
      <div className="l1"><span className="kbd"><Icon name="cursor" size="s" />双击</span>画布自由生成，或从下面开始一条工作流</div>
      <div className="chips">
        {([["t2v", "video", "文字生视频"], ["bg", "image", "图片换背景"], ["i2v", "frame", "首帧生成视频"], ["table", "grid", "表格批量出图"], ["tpl", "layout", "模板"]] as const).map(([k, ic, l]) => <button key={k} data-flow={k} onClick={() => startFlow(ctl, k)}><Icon name={ic} size="s" />{l}</button>)}
      </div>
    </div> : null}
    <EdgeBadge />
    {ui.filesOpen ? <FilesPanel /> : null}
    {ui.cmtMode ? <div className="cmtbox float"><b style={{ fontSize: 13 }}>评论模式</b><span style={{ color: "var(--fg3)", fontSize: 12 }}>点击画布任意位置放置评论，Esc 退出</span></div> : null}
    <Comments />
    {ui.drawer === "assets" || ui.drawer === "history" ? <Drawer kind={ui.drawer} /> : null}
    <SharePanels />
    {!ui.agentOpen ? <button id="orb" className="float" aria-label="打开 Agent" onClick={() => store.setUI({ agentOpen: true })} /> : null}
  </>;
}

/* ---------- 画布菜单 / 设置 ---------- */
function canvasMenu(ctl: Ctl, anchor: Element, rename: () => void) {
  const store = ctl.store;
  openPop(anchor, (close) => <>
    {ctl.host.backToList ? <button className="mi" onClick={() => { close(); ctl.host.backToList!(); }}><Icon name="back" size="s" />返回画布列表</button> : null}
    <button className="mi" onClick={() => { close(); rename(); }}><Icon name="pencil" size="s" />重命名</button>
    <button className="mi" onClick={() => { close(); canvasSettings(ctl); }}><Icon name="settings" size="s" />画布设置</button>
    <CanvasList ctl={ctl} close={close} />
  </>);
  void store;
}
function CanvasList({ ctl, close }: { ctl: Ctl; close: () => void }) {
  const [list, setList] = useState<Array<{ id: string; name: string; nodes?: number }> | null>(null);
  useEffect(() => { void ctl.host.listCanvases?.().then(setList).catch(() => setList([])); }, [ctl]);
  if (!ctl.host.listCanvases) return null;
  return <><div className="msep" /><div className="mh">切换画布</div>{(list || []).map((c) => <button key={c.id} className={"mi" + (c.id === ctl.store.state.canvasId ? " on" : "")} onClick={() => { close(); if (c.id !== ctl.store.state.canvasId) ctl.host.openCanvas?.(c.id); }}><Icon name="layers" size="s" /><span>{c.name}{c.nodes != null ? <span className="d">{c.nodes} 个节点</span> : null}</span></button>)}{!list ? <div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>读取中…</span></div> : null}</>;
}
function canvasSettings(ctl: Ctl) {
  const store = ctl.store;
  openModal(() => <Settings ctl={ctl} />);
  void store;
}
function Settings({ ctl }: { ctl: Ctl }) {
  const batch = useS((s) => s.ui.batchMode); const models = useS((s) => s.models); const store = ctl.store;
  return <><ModalHead title="画布设置" /><div className="mbd">
    <div className="sec"><span>批量生成结果（2× / 4×）的保存方式</span></div>
    <div className="seg">{([["stack", "堆叠在一个节点"], ["spread", "铺开成多个节点"]] as const).map(([k, l]) => <button key={k} className={batch === k ? "on" : ""} onClick={() => { store.setUI({ batchMode: k }); store.toast(k === "stack" ? "批量结果会堆叠，用 ‹ › 切换" : "批量结果会铺开成新节点"); }}>{l}</button>)}</div>
    <div className="sec"><span>新节点默认模型</span></div>
    {(["image", "video", "text", "audio"] as GenKind[]).map((t) => <div key={t} className="row"><span>{TYPE_LABEL[t]}</span><span style={{ color: "var(--fg2)" }}>{store.defaultModel(t)?.name || "未配置"}</span></div>)}
    <p style={{ color: "var(--fg3)", fontSize: 12, margin: "12px 0 0" }}>模型列表来自 设置 › 模型（共 {models.length} 个可用于画布）；比例、画质、参考图上限由模型能力表决定。</p>
  </div></>;
}
function connectAgentPop(ctl: Ctl, anchor: Element) {
  const addr = "openarc://canvas/" + ctl.store.state.canvasId;
  openPop(anchor, (close) => <>
    <div className="mh">在 Agent 中打开这张画布</div>
    <button className="mi" onClick={() => { close(); ctl.store.setUI({ agentOpen: true }); }}><span className="ic"><Logo /></span><span>OpenArc 助手<span className="d">右侧面板，可直接改画布</span></span></button>
    <div className="msep" /><div className="row" style={{ font: "12px var(--mono)", color: "var(--fg2)" }}><span>{addr}</span><button className="btn" style={{ height: 26 }} onClick={async () => { try { await navigator.clipboard.writeText(addr); ctl.store.toast("已复制连接地址"); } catch { ctl.store.toast("复制失败，请手动选中地址"); } }}>复制</button></div>
  </>, "down", "right");
}
function themeMenu(ctl: Ctl, anchor: Element) {
  const store = ctl.store;
  openPop(anchor, (close) => <><div className="mh">外观</div>{([["dark", "moon", "深色"], ["light", "sun", "浅色"], ["system", "monitor", "跟随系统"]] as const).map(([k, ic, t]) => <button key={k} className={"mi" + (store.state.ui.themePref === k ? " on" : "")} data-th={k} onClick={() => { close(); store.setUI({ themePref: k }); try { localStorage.setItem("openarc-canvas-theme", k); } catch { /* 忽略 */ } applyTheme(store); }}><span className="ic"><Icon name={ic} size="s" /></span><span style={{ flex: 1 }}>{t}</span>{store.state.ui.themePref === k ? <span className="k"><Icon name="check" size="s" /></span> : null}</button>)}</>, "up");
}
export function showKeys() {
  const k = [["撤销 / 重做", "⌘Z / ⇧⌘Z"], ["复制 / 粘贴", "⌘C / ⌘V"], ["创建副本", "⌘D"], ["删除", "⌫ / Del"], ["全选", "⌘A"], ["节点搜索", "⌘F"], ["打开 / 收起 Agent", "⌘J"], ["发送生成", "⌘↵"], ["适应画布", "⇧1"], ["放大 / 缩小", "⌘+ / ⌘−"], ["切换深浅色", "⇧⌘L"], ["评论模式", "C"], ["拖动画布", "空格 / 中键 + 拖动"], ["微移节点", "方向键（⇧ 10px）"], ["重命名节点", "双击节点标题"], ["框选", "Shift + 拖动"], ["取消 / 关闭", "Esc"]];
  openModal(() => <><ModalHead title="快捷键" /><div className="mbd"><div className="kbdlist">{k.map(([a, b]) => <div key={a}><span>{a}</span><kbd>{b}</kbd></div>)}</div></div></>);
}
export function toggleCmt(ctl: Ctl) { const on = !ctl.store.state.ui.cmtMode; ctl.store.setUI({ cmtMode: on }); if (on) ctl.store.toast("点击画布放置评论"); }

/* ---------- 搜索 / 模板 / 预置工作流 ---------- */
export function openSearch(ctl: Ctl) { openModal((close) => <SearchModal ctl={ctl} close={close} />, "search"); }
function SearchModal({ ctl, close }: { ctl: Ctl; close: () => void }) {
  const [q, setQ] = useState(""); const [f, setF] = useState<"all" | GenKind | "table">("all"); const doc = useS((s) => s.doc);
  const list = doc.nodes.filter((n) => (f === "all" || n.kind === f) && (!q || (title(n) + (isGenKind(n.kind) ? genOf(n).prompt + textOf(n) : "")).toLowerCase().includes(q.toLowerCase())));
  return <>
    <div className="sinput"><Icon name="search" /><input id="sq" autoFocus placeholder="搜索节点..." value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /><button className="ib" onClick={close}><Icon name="x" /></button></div>
    <div className="tabs">{([["all", "全部"], ["image", "图片"], ["video", "视频"], ["text", "文本"], ["audio", "音频"], ["table", "表格"]] as const).map(([k, l]) => <button key={k} className={f === k ? "on" : ""} onClick={() => setF(k)}>{l}</button>)}</div>
    <div className="dbody" style={{ maxHeight: 360, padding: "0 12px 12px" }}>
      {list.length ? list.map((n) => <NodeRow key={n.id} n={n} onClick={() => { close(); ctl.focusNode(n.id); }} sub={isGenKind(n.kind) ? (textOf(n) || genOf(n).prompt || TYPE_LABEL[n.kind]).slice(0, 60) : "多维表格"} extra={inputsOf(doc, n.id).length ? inputsOf(doc, n.id).length + " 个输入" : ""} />) : <div style={{ minHeight: 240, display: "grid", placeItems: "center", color: "var(--fg3)" }}>暂无可搜索节点</div>}
    </div>
  </>;
}
function NodeRow({ n, sub, extra, onClick }: { n: CanvasNode; sub: string; extra?: string; onClick: () => void }) {
  const src = srcOf(n); const url = useAssetUrl(src);
  return <div className="hrow" data-focus={n.id} onClick={onClick}><span className="th">{url ? <img src={url} alt="" /> : <Icon name={n.kind === "table" ? "grid" : TYPE_ICON[n.kind as GenKind] || "layers"} size="s" />}</span><span className="m"><b>{title(n)}</b><small>{sub}</small></span>{extra ? <span style={{ color: "var(--fg3)", fontSize: 11.5 }}>{extra}</span> : null}</div>;
}
const TEMPLATES = [
  { id: "ecom", name: "电商卖点套图", desc: "产品图 + 产品信息 → 卖点拆解 → 3 张海报" },
  { id: "i2v", name: "首帧生成视频", desc: "一张图作为首帧，写镜头描述出短片" },
  { id: "bg", name: "图片换背景", desc: "上传产品图，描述新背景" },
  { id: "table", name: "多维表格批量出图", desc: "文本 → 多维表格 → 逐行批量生成图片" },
  { id: "story", name: "分镜表到视频", desc: "一句创意 → 分镜表 → 逐镜头生成视频" },
] as const;
export function openTemplates(ctl: Ctl) {
  openModal((close) => <><ModalHead title="模板" /><div className="mbd"><div className="tcards">{TEMPLATES.map((t) => <div key={t.id} className="tcard"><div className="pv" style={{ display: "grid", placeItems: "center", color: "var(--fg3)" }}><Icon name={t.id === "table" || t.id === "story" ? "grid" : t.id === "i2v" ? "video" : "image"} /></div><div className="tb"><b>{t.name}</b><small>{t.desc}</small><button className="btn solid" data-tpl={t.id} onClick={() => { close(); startFlow(ctl, t.id); }}>使用</button></div></div>)}</div></div></>);
}
export function startFlow(ctl: Ctl, kind: string) {
  const store = ctl.store; if (kind === "tpl") return openTemplates(ctl);
  const c = ctl.center(); const made: CanvasNode[] = []; const edges: Array<{ id: string; from: string; to: string }> = [];
  const add = (n: CanvasNode) => { made.push(n); return n; }; const link = (a: CanvasNode, b: CanvasNode) => edges.push({ id: uid("e"), from: a.id, to: b.id });
  const N = (k: GenKind, x: number, y: number, extra: Parameters<typeof store.newNode>[3] = {}) => add(store.newNode(k, x, y, extra));
  if (kind === "t2v") { const t = N("text", c.x - 420, c.y - 100, { title: "视频脚本", prompt: "写一段 10 秒短片的分镜脚本，3 个镜头" }); const v = N("video", c.x, c.y - 90, { title: "短片", prompt: "按上游脚本生成，电影感，节奏紧凑" }); link(t, v); }
  if (kind === "bg") { const s = N("image", c.x - 420, c.y - 120, { title: "原图", uploaded: true }); const o = N("image", c.x, c.y - 120, { title: "换背景", prompt: "保持主体不变，背景换成清晨的木质书桌，左侧窗光" }); link(s, o); }
  if (kind === "i2v") { const s = N("image", c.x - 420, c.y - 120, { title: "首帧", uploaded: true }); const v = N("video", c.x, c.y - 90, { title: "首帧视频", prompt: "镜头缓慢环绕主体，光线从左扫到右" }); link(s, v); }
  if (kind === "ecom") { const p = N("image", c.x - 700, c.y - 250, { title: "产品图", uploaded: true }); const info = N("text", c.x - 710, c.y + 80, { title: "产品信息", manual: true, hist: [{ text: "产品：\n卖点：\n人群：\n风格偏好：" }] }); const t = N("text", c.x - 300, c.y - 120, { title: "卖点拆解", w: 300, h: 240, prompt: "输出 3 个卖点海报方案，以“海报1”“海报2”“海报3”开头，每个包含主标题、画面、文案" }); link(info, t); link(p, t); [0, 1, 2].forEach((i) => { const o = N("image", c.x + 120, c.y - 380 + i * 330, { title: "海报" + (i + 1), w: 220, prompt: `参考 @卖点拆解·海报${i + 1}，基于产品图生成竖版卖点海报` }); link(p, o); link(t, o); }); }
  if (kind === "table" || kind === "story") {
    const story = kind === "story";
    const t = N("text", c.x - 640, c.y - 100, { title: story ? "创意" : "任务拆解", prompt: story ? "一条 15 秒的产品开箱短片，节奏由慢到快" : "把下面的产品拆成 4 张不同场景的宣传图任务", params: { ...(defaultParams("text", store.defaultModel("text")) as TextParams), output: story ? "storyboard" : "table" } });
    const tb = add(withTable({ id: uid("t"), kind: "table", x: Math.round(c.x - 220), y: Math.round(c.y - 140), w: 420, h: 220, text: story ? "分镜表" : "多维表格" }, { ...emptyTable(), title: story ? "分镜表" : "多维表格", sourceId: t.id }));
    const g = N(story ? "video" : "image", c.x + 340, c.y - 120, { title: story ? "逐镜头视频" : "逐行出图", prompt: story ? "按这一行的镜头描述生成" : "按这一行的描述生成宣传图，主体保持一致" });
    link(t, tb); link(tb, g);
  }
  if (!made.length) return;
  store.addNodes(made, edges, { select: false });
  made.forEach((n) => { if (n.kind === "video") { const m = store.modelOf(store.node(n.id)!); const mode = m ? (inputsOf(store.state.doc, n.id).some((x) => x.node.kind === "image") ? "首帧" : null) : null; if (mode && m?.modes?.includes(mode)) store.patchGen(n.id, (g) => ({ params: { ...(g.params as VideoParams), mode } })); } });
  store.setUI({ sel: new Set([made[made.length - 1].id]) }); ctl.fitTo(store.state.doc.nodes.filter((n) => made.some((m) => m.id === n.id)), 120, 1);
  store.toast(`已创建 ${made.length} 个节点并按顺序连好，选中节点点生成，或右键「运行到此（含上游）」`, 4000);
}

/* ---------- 小地图 / 回到节点 ---------- */
function Minimap() {
  const ctl = useCtl(); const doc = useS((s) => s.doc); const view = useS((s) => s.view); const sel = useS((s) => s.ui.sel); const runtime = useS((s) => s.runtime); useS((s) => s.ui.theme);
  const ref = useRef<HTMLCanvasElement>(null); const geo = useRef<{ ox: number; oy: number; s: number } | null>(null);
  useEffect(() => {
    const c = ref.current; if (!c) return; const g = c.getContext("2d")!; g.clearRect(0, 0, c.width, c.height);
    const bb = bounds(doc.nodes); if (!bb) return; const r = ctl.rect(); const css = (k: string) => getComputedStyle(document.querySelector(".cn-root") || document.documentElement).getPropertyValue(k).trim();
    const vw = { x: -view.x / view.k, y: -view.y / view.k, w: r.width / view.k, h: r.height / view.k };
    const all = { x: Math.min(bb.x, vw.x), y: Math.min(bb.y, vw.y), w: 0, h: 0 }; all.w = Math.max(bb.x + bb.w, vw.x + vw.w) - all.x; all.h = Math.max(bb.y + bb.h, vw.y + vw.h) - all.y;
    const s = Math.min((c.width - 20) / all.w, (c.height - 20) / all.h); const ox = 10 - all.x * s + ((c.width - 20) - all.w * s) / 2, oy = 10 - all.y * s + ((c.height - 20) - all.h * s) / 2; geo.current = { ox, oy, s };
    doc.nodes.forEach((n) => { g.fillStyle = sel.has(n.id) ? css("--solid") : runtime[n.id] ? "#8e8e93" : css("--s4"); g.fillRect(ox + n.x * s, oy + n.y * s, Math.max(2, n.w * s), Math.max(2, (n.h + 24) * s)); });
    g.strokeStyle = `rgba(${css("--ink")},.8)`; g.lineWidth = 2; g.strokeRect(ox + vw.x * s, oy + vw.y * s, vw.w * s, vw.h * s);
  });
  return <div id="mini" className="float cap"><canvas ref={ref} width={440} height={280} onClick={(e) => { const gg = geo.current; if (!gg) return; const c = e.currentTarget; const rr = c.getBoundingClientRect(); const mx = ((e.clientX - rr.left) / rr.width) * c.width, my = ((e.clientY - rr.top) / rr.height) * c.height; const wx = (mx - gg.ox) / gg.s, wy = (my - gg.oy) / gg.s; const r = ctl.rect(); const v = ctl.store.state.view; ctl.store.setView({ ...v, x: r.width / 2 - wx * v.k, y: r.height / 2 - wy * v.k }); }} /></div>;
}
function BackToNodes() {
  const ctl = useCtl(); const doc = useS((s) => s.doc); const view = useS((s) => s.view); void view;
  if (!doc.nodes.length) return null; const r = ctl.rect();
  const visible = doc.nodes.some((n) => { const a = ctl.toScreen(n.x, n.y), c = ctl.toScreen(n.x + n.w, n.y + n.h + 24); return c.x > r.left && a.x < r.right && c.y > r.top && a.y < r.bottom; });
  if (visible) return null;
  return <div id="back" className="float cap">当前视窗没有节点，可快速回到内容区域<button id="backBtn" onClick={() => ctl.fitTo(doc.nodes)}>回到节点</button></div>;
}

/* ---------- 评论 ---------- */
function Comments() {
  const ctl = useCtl(); const store = ctl.store; const comments = useS((s) => s.doc.comments); useS((s) => s.view);
  const [open, setOpen] = useState<string | null>(null); const [draft, setDraft] = useState<{ x: number; y: number } | null>(null); const [text, setText] = useState("");
  useEffect(() => { const on = (e: Event) => { setDraft((e as CustomEvent).detail); setText(""); setOpen(null); }; addEventListener("cn:place-comment", on); return () => removeEventListener("cn:place-comment", on); }, []);
  const r = ctl.rect(); const pos = (x: number, y: number) => { const s = ctl.toScreen(x, y); return { left: s.x - r.left, top: s.y - r.top }; };
  const openC = comments.find((c) => c.id === open);
  return <div id="cmts" onPointerDown={(e) => e.stopPropagation()}>
    {comments.map((c, i) => <button key={c.id} className="cpin" style={pos(c.x, c.y)} onClick={() => setOpen(open === c.id ? null : c.id)}>{i + 1}</button>)}
    {draft ? <div className="cbubble" style={{ left: pos(draft.x, draft.y).left + 30, top: pos(draft.x, draft.y).top - 30 }}>
      <textarea autoFocus maxLength={200} placeholder={`输入你的评论…（${text.length}/200）`} style={{ width: "100%", minHeight: 60, resize: "none" }} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><small>{text.length}/200</small><span style={{ display: "flex", gap: 6 }}><button className="btn" style={{ height: 26 }} onClick={() => setDraft(null)}>取消</button><button className="btn solid" style={{ height: 26 }} onClick={() => { const v = text.trim(); if (!v) return; const c: CanvasComment = { id: uid("c"), x: Math.round(draft.x), y: Math.round(draft.y), text: v, createdAt: Date.now(), clientId: "local", author: ctl.host.user?.name || "我" }; store.mutate((d) => ({ ...d, comments: [...d.comments, c] }), { history: true }); setDraft(null); store.toast("评论已发送"); }}>发送</button></span></div>
    </div> : null}
    {openC ? <div className="cbubble" style={{ left: pos(openC.x, openC.y).left + 30, top: pos(openC.x, openC.y).top - 30 }}><b>{openC.author || "协作者"}</b> {openC.text}<small>{new Date(openC.createdAt).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit", month: "numeric", day: "numeric" })} · <button style={{ color: "var(--fg2)", textDecoration: "underline" }} onClick={() => { store.mutate((d) => ({ ...d, comments: d.comments.filter((x) => x.id !== openC.id) }), { history: true }); setOpen(null); }}>删除</button></small></div> : null}
  </div>;
}

/* ---------- 抽屉：素材 / 历史 ---------- */
function Drawer({ kind }: { kind: "assets" | "history" }) {
  const ctl = useCtl(); const store = ctl.store; const doc = useS((s) => s.doc); const runs = useS((s) => s.runs);
  const [hf, setHf] = useState<"all" | GenKind>("all"); const [q, setQ] = useState(""); const [linkTo, setLinkTo] = useState<string | null>(null);
  useEffect(() => { const on = (e: Event) => setLinkTo((e as CustomEvent).detail); addEventListener("cn:lib-link", on); return () => removeEventListener("cn:lib-link", on); }, []);
  const close = () => store.setUI({ drawer: null });
  if (kind === "history") {
    const list = runs.filter((r) => hf === "all" || r.type === hf);
    return <div className="drawer float" id="drawer" onPointerDown={(e) => e.stopPropagation()}>
      <div className="dh"><Icon name="history" size="s" />生成历史<span className="sp" /><button className="ib" style={{ width: 28, height: 28 }} onClick={close}><Icon name="x" size="s" /></button></div>
      <div className="tabs">{([["all", "全部"], ["image", "图片"], ["video", "视频"], ["text", "文本"], ["audio", "音频"]] as const).map(([k, l]) => <button key={k} className={hf === k ? "on" : ""} onClick={() => setHf(k)}>{l}</button>)}</div>
      <div className="dbody">{list.map((r) => <div key={r.id} className="hrow" onClick={() => store.node(r.node) ? ctl.focusNode(r.node) : store.toast("这个节点已经被删除")}><span className="th">{r.thumb ? <Thumb src={r.thumb} /> : <Icon name={r.type === "table" ? "grid" : TYPE_ICON[r.type]} size="s" />}</span><span className="m"><b>{r.title}</b><small>{r.model} · {r.status === "done" ? r.secs + "s" : r.status === "stopped" ? "已停止" : "失败"} · {r.time}</small></span><span style={{ color: "var(--fg3)" }}><Icon name={r.status === "done" ? "check" : "x"} size="s" /></span></div>)}{!list.length ? <p style={{ color: "var(--fg3)", fontSize: 12, padding: 12 }}>还没有生成记录</p> : null}</div>
    </div>;
  }
  const media = doc.nodes.filter((n) => (n.kind === "image" || n.kind === "video") && outOf(n) && (!q || title(n).includes(q)));
  const favs = media.filter((n) => genOf(n).fav);
  const use = (n: CanvasNode) => {
    const target = linkTo ? store.node(linkTo) : null; const o = outOf(n)!;
    const w = target ? { x: target.x - 330, y: target.y + 100 } : ctl.center();
    const c = store.newNode(n.kind as GenKind, w.x - 120, w.y - 120, { title: genOf(n).title, uploaded: true, hist: [o], w: n.w, h: n.h });
    store.addNodes([c], target ? [{ id: uid("e"), from: c.id, to: target.id }] : [], { select: !target });
    if (target) { store.setUI({ sel: new Set([target.id]) }); setLinkTo(null); store.toast(`已作为「${title(target)}」的输入`); } else store.toast("已添加到画布");
  };
  return <div className="drawer float" id="drawer" onPointerDown={(e) => e.stopPropagation()}>
    <div className="dh"><Icon name="folder" size="s" />素材库<span className="sp" /><button className="ib" style={{ width: 28, height: 28 }} onClick={() => { setLinkTo(null); close(); }}><Icon name="x" size="s" /></button></div>
    <div className="dsearch"><Icon name="search" size="s" /><input placeholder="搜索素材" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></div>
    <div className="dbody">
      {linkTo ? <div className="gp-warn" style={{ margin: "0 0 8px" }}><Icon name="link" size="s" /><span>点一张素材，作为「{title(store.node(linkTo)!)}」的输入</span></div> : null}
      <LibrarySection q={q} />
      <div className="sec"><span>收藏</span><span className="tnum">{favs.length}</span></div>
      <div className="agrid">{favs.map((n) => <AssetTile key={n.id} n={n} onUse={use} />)}{!favs.length ? <span style={{ gridColumn: "1/-1", color: "var(--fg3)", fontSize: 12 }}>点图片节点左上角的星标收藏</span> : null}</div>
      <div className="sec"><span>本画布素材</span><span className="tnum">{media.length}</span></div>
      <div className="agrid">{media.map((n) => <AssetTile key={n.id} n={n} onUse={use} />)}</div>
    </div>
  </div>;
}
function AssetTile({ n, onUse }: { n: CanvasNode; onUse: (n: CanvasNode) => void }) {
  const store = useCtl().store; const url = useAssetUrl(srcOf(n)); const fav = genOf(n).fav;
  return <div className="a" title={title(n)} onClick={() => onUse(n)}>{url ? <img src={url} alt="" /> : null}<button className={"fav" + (fav ? " on" : "")} onClick={(e) => { e.stopPropagation(); store.patchGen(n.id, { fav: !fav }); }}><Icon name="star" size="xs" /></button></div>;
}
function Thumb({ src }: { src: string }) { const u = useAssetUrl(src); return u ? <img src={u} alt="" /> : null; }

/* ---------- 文件面板（Agent 产出） ---------- */
function FilesPanel() {
  const ctl = useCtl(); const doc = useS((s) => s.doc); const runtime = useS((s) => s.runtime);
  const outs = doc.nodes.filter((n) => isGenKind(n.kind) && genOf(n).agent);
  return <div id="files" className="float" onPointerDown={(e) => e.stopPropagation()}>
    <div className="fh"><Icon name="folder" size="s" />文件<span className="sp" /><button className="ib" style={{ width: 26, height: 26 }} onClick={() => ctl.store.setUI({ filesOpen: false })}><Icon name="x" size="s" /></button></div>
    {outs.length ? outs.map((n) => <NodeRow key={n.id} n={n} onClick={() => ctl.focusNode(n.id)} sub={`${TYPE_LABEL[n.kind as GenKind]} · ${runtime[n.id] ? "生成中" : outOf(n) ? "已完成" : "待生成"}`} />) : <div className="empty">暂无输出。Agent 在画布上创建的节点会列在这里。</div>}
  </div>;
}

/* ---------- 提示条 / 全屏查看 ---------- */
export function Toasts() {
  const toasts = useS((s) => s.toasts);
  return <div id="toasts">{toasts.map((t) => <div key={t.id} className={"toast" + (t.out ? " out" : "")} dangerouslySetInnerHTML={{ __html: escapeHtml(t.html) }} />)}</div>;
}
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

export function Lightbox() {
  const ctl = useCtl(); const [id, setId] = useState<string | null>(null); const doc = useS((s) => s.doc);
  useEffect(() => { const on = (e: Event) => setId((e as CustomEvent).detail); addEventListener("cn:lightbox", on); return () => removeEventListener("cn:lightbox", on); }, []);
  const [closing, setClosing] = useState(false);
  useLayoutEffect(() => { if (id) setClosing(false); }, [id]);
  const n = id ? doc.nodes.find((x) => x.id === id) : null; if (!n || !isGenKind(n.kind)) return null;
  const g = genOf(n); const o = g.hist[g.hi];
  const close = () => { setClosing(true); setTimeout(() => setId(null), 160); };
  return <div className="lightbox" id="lightbox" tabIndex={-1} ref={(el) => { if (el && document.activeElement !== el && !el.contains(document.activeElement)) el.focus(); }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") close(); if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && g.hist.length > 1) ctl.store.patchGen(n.id, { hi: (g.hi + (e.key === "ArrowLeft" ? -1 : 1) + g.hist.length) % g.hist.length }); }} style={closing ? { animation: "fadeOut 160ms var(--e-exit) forwards" } : undefined} onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
    <button className="ib close" onClick={close}><Icon name="x" /></button>
    {n.kind === "text" ? <div className="txt">{o?.text}</div> : n.kind === "audio" ? <div className="txt">音频 · {o?.dur}s</div> : n.kind === "video" && o?.url ? <LbVideo src={o.url} /> : <LbImg src={o?.url || o?.frame || ""} />}
    <div style={{ color: "var(--fg2)", fontSize: 12 }}>{g.title}{g.hist.length > 1 ? ` · 版本 ${g.hi + 1}/${g.hist.length}` : ""}{o?.meta?.model ? ` · ${o.meta.model}` : ""}{o?.meta?.ratio ? ` · ${o.meta.ratio}` : ""}{o?.meta?.size ? ` · ${o.meta.size}` : ""}</div>
    {g.hist.length > 1 && n.kind !== "text" ? <div className="thumbs">{g.hist.map((h, i) => <button key={i} className={i === g.hi ? "on" : ""} onClick={() => ctl.store.patchGen(n.id, { hi: i })}><Thumb src={h.url || h.frame || ""} /></button>)}</div> : null}
  </div>;
}
function LbImg({ src }: { src: string }) { const u = useAssetUrl(src); return u ? <img className="big" src={u} alt="" /> : null; }
function LbVideo({ src }: { src: string }) { const u = useAssetUrl(src); return u ? <video className="big" src={u} controls autoPlay /> : null; }
