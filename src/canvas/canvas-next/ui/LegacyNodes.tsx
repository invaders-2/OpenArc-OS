/**
 * 旧版节点在新画布里的可编辑实现：便签、分组、剪辑时间线、3D 模型（文生 / 图生 3D）、3D 片场。
 * 数据结构沿用 CanvasDoc（node.text / clips / scene / url / children），旧画布和新画布读写同一份。
 * 节点内可交互区域都包在 data-act 里：不触发拖动，节点靠标题栏拖。
 */
import { useEffect, useRef, useState } from "react";
import { Model3DViewer } from "../../react-canvas/Model3DViewer";
import { Scene3D } from "../../react-canvas/Scene3D";
import type { CanvasNode, Scene3DData, TimelineClip } from "../../react-canvas/reactCanvasStore";
import { exportTimelineWebM, downloadTimelineBlob } from "../../react-canvas/timelineExport";
import { backendExportAvailable, exportTimelineMp4 } from "../../react-canvas/timelineExportBackend";
import { outOf, uid } from "../model";
import { useCtl, useS } from "./ctx";
import { Icon } from "./Icon";
import { useAssetUrl } from "./useAsset";
import { confirmRunGroup, groupLabel, runnableIds } from "./StackNode";
import { kbd } from "../keys";

const stop = (e: React.SyntheticEvent) => e.stopPropagation();
const clipLen = (c: TimelineClip) => Math.max(0, c.outPoint - c.inPoint);

/* ---------------- 便签 ---------------- */
export function NoteBody({ node }: { node: CanvasNode }) {
  const store = useCtl().store; const [v, setV] = useState(node.text || "");
  useEffect(() => setV(node.text || ""), [node.text]);
  return <div className="lg-note" data-act="note">
    <textarea value={v} placeholder="写点什么…" onPointerDown={stop} onKeyDown={stop} onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v !== node.text) { store.snapshot(); store.updateNode(node.id, (n) => ({ ...n, text: v })); } }} />
  </div>;
}

/* ---------------- 分组 ---------------- */
export function GroupBody({ node }: { node: CanvasNode }) {
  const store = useCtl().store; const n = (node.children || []).filter((id) => store.node(id)).length;
  const ctl = useCtl();
  return <div className="lg-group"><span>{n} 个节点</span><small>{kbd("拖动标题移动整组 · ⇧⌘G 取消分组")}</small>
    <span className="lg-group-acts">
      <button className="linkbtn" data-act="rungroup" onPointerDown={stop} onClick={() => confirmRunGroup(ctl, runnableIds(store, [node]), groupLabel(node))}><Icon name="play" size="xs" />运行分组</button>
      <button className="linkbtn" data-act="ungroup" onPointerDown={stop} onClick={() => ungroup(store, node.id)}>取消分组</button>
    </span></div>;
}
/** ⌘G：把选中的节点放进一个分组框（分组本身也是节点，排在最底层） */
export function groupSelection(store: ReturnType<typeof useCtl>["store"]) {
  const ids = [...store.state.ui.sel].filter((id) => store.node(id) && store.node(id)!.kind !== "group"); if (ids.length < 2) { store.toast("至少选中 2 个节点再分组"); return; }
  const ns = ids.map((id) => store.node(id)!); const pad = 28;
  const x = Math.min(...ns.map((n) => n.x)) - pad, y = Math.min(...ns.map((n) => n.y)) - pad - 10;
  const w = Math.max(...ns.map((n) => n.x + n.w)) - x + pad, h = Math.max(...ns.map((n) => n.y + n.h + 24)) - y + pad - 24;
  const g: CanvasNode = { id: uid("g"), kind: "group", x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), text: "分组", children: ids };
  store.addNodes([g], [], { select: true, history: true }); store.toast(`已把 ${ids.length} 个节点编为一组`);
}
export function ungroup(store: ReturnType<typeof useCtl>["store"], gid?: string) {
  const ids = gid ? [gid] : [...store.state.ui.sel].filter((id) => store.node(id)?.kind === "group"); if (!ids.length) return;
  store.snapshot(); store.mutate((d) => ({ ...d, nodes: d.nodes.filter((n) => !ids.includes(n.id)) }), { history: false }); store.setUI({ sel: new Set() }); store.toast("已取消分组");
}

/* ---------------- 剪辑时间线 ---------------- */
export function TimelineBody({ node }: { node: CanvasNode }) {
  const store = useCtl().store; const doc = useS((s) => s.doc);
  const [adding, setAdding] = useState(false); const [busy, setBusy] = useState<string | null>(null); const [prev, setPrev] = useState(false);
  const clips = node.clips || []; const media = clips.filter((c) => c.type !== "subtitle"); const subs = clips.filter((c) => c.type === "subtitle");
  // 视频轨、音频轨并排：总长取较长的一轨（和导出一致）
  const trackLen = (k: "video" | "audio") => media.filter((c) => c.mediaKind === k).reduce((s, c) => s + clipLen(c), 0);
  const total = Math.max(trackLen("video"), trackLen("audio"), ...subs.map((c) => Number(c.end) || 0), 0);
  const set = (next: TimelineClip[], history = true) => { if (history) store.snapshot(); store.updateNode(node.id, (n) => ({ ...n, clips: next.map((c, i) => ({ ...c, order: i })) })); };
  const patch = (id: string, p: Partial<TimelineClip>) => set(clips.map((c) => (c.id === id ? { ...c, ...p } : c)), false);
  const sources = doc.nodes.filter((n) => (n.kind === "video" || n.kind === "audio") && (outOf(n)?.url || n.url));
  const move = (id: string, d: -1 | 1) => { const list = [...media]; const i = list.findIndex((c) => c.id === id); const j = i + d; if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; set([...list, ...subs]); };
  const exportIt = async (fmt: "mp4" | "webm") => {
    if (!media.length) return; setBusy(fmt === "mp4" ? "导出 MP4…" : "导出 WebM…");
    try {
      if (fmt === "mp4") { const r = await exportTimelineMp4({ clips: media.map((c) => ({ url: c.url, mediaKind: c.mediaKind, inPoint: c.inPoint, outPoint: c.outPoint })), canvasId: store.state.canvasId, onProgress: (v) => setBusy(`导出 MP4… ${Math.round(v > 1 ? v : v * 100)}%`) /* 导出模块报 0–100 */ }); store.toast("已导出 MP4：" + r.relativePath.split("/").pop() + "（导出文件夹已在访达中打开）", 5000); }
      else {
        const resolved = await Promise.all(clips.map(async (c) => (c.url && c.url.startsWith("openarc-asset:") ? { ...c, url: (await store.backend.resolveAsset(c.url)) || c.url } : c)));
        const blob = await exportTimelineWebM({ clips: resolved.map((c) => ({ url: c.url, mediaKind: c.mediaKind, inPoint: c.inPoint, outPoint: c.outPoint, type: c.type, text: c.text, start: c.start, end: c.end, fadeIn: c.fadeIn, fadeOut: c.fadeOut })), fileName: "timeline.webm", onProgress: (cur: number, tot: number) => setBusy(`导出 WebM… ${Math.round((cur / Math.max(1, tot)) * 100)}%`) } as never);
        downloadTimelineBlob(blob, "剪辑时间线.webm");
      }
    } catch (err) { store.toast("导出失败：" + (err instanceof Error ? err.message : "未知错误"), 4000); }
    finally { setBusy(null); }
  };
  return <div className="lg-tl" data-act="timeline" onPointerDown={stop} onWheel={stop}>
    <div className="lg-row">
      <button className="pill" onClick={() => setAdding(!adding)}><Icon name="plus" size="xs" />添加片段</button>
      <button className="pill" onClick={() => set([...clips, { id: uid("sub"), sourceNodeId: "", url: "", mediaKind: "video", inPoint: 0, outPoint: 2, order: clips.length, type: "subtitle", text: "新字幕", start: 0, end: 2 }])}><Icon name="text" size="xs" />添加字幕</button>
      <span className="grow" /><span className="tnum lg-dim">总长 {total.toFixed(1)}s</span>
    </div>
    {adding ? <div className="lg-src">{sources.length ? sources.map((s) => <button key={s.id} className="mi" onClick={() => { const url = outOf(s)?.url || s.url || ""; set([...media, { id: uid("clip"), sourceNodeId: s.id, url, mediaKind: s.kind === "audio" ? "audio" : "video", inPoint: 0, outPoint: Math.max(1, Number(outOf(s)?.dur) || 5), order: media.length }, ...subs]); setAdding(false); }}><Icon name={s.kind === "audio" ? "audio" : "video"} size="xs" />{(s.data as { gen?: { title?: string } } | undefined)?.gen?.title || s.text || (s.kind === "audio" ? "音频" : "视频")}<span className="d">{[outOf(s)?.dur ? Number(outOf(s)!.dur).toFixed(1).replace(/\.0$/, "") + "s" : "", outOf(s)?.res || "", (outOf(s)?.meta as { model?: string } | undefined)?.model || ""].filter(Boolean).join(" · ")}</span></button>) : <span className="lg-dim">画布上还没有生成好的视频 / 音频</span>}</div> : null}
    <div className="lg-clips">
      {!clips.length ? <div className="lg-dim lg-empty">还没有片段：点「添加片段」把画布上的视频 / 音频排进来</div> : null}
      {media.map((c, i) => <div key={c.id} className="lg-clip">
        <span className="tnum lg-idx">{i + 1}</span><Icon name={c.mediaKind === "audio" ? "audio" : "video"} size="xs" />
        <label>入<input type="number" step="0.1" min={0} value={c.inPoint} onKeyDown={stop} onChange={(e) => patch(c.id, { inPoint: Math.max(0, Math.min(Number(e.target.value) || 0, c.outPoint - .1)) })} /></label>
        <label>出<input type="number" step="0.1" min={0} value={c.outPoint} onKeyDown={stop} onChange={(e) => patch(c.id, { outPoint: Math.max(c.inPoint + .1, Math.min(Number(e.target.value) || 0, 3600)) })} /></label>
        {c.mediaKind === "video" ? <label>淡入<input type="number" step="50" min={0} max={1000} value={c.fadeIn || 0} onKeyDown={stop} onChange={(e) => patch(c.id, { fadeIn: Math.max(0, Math.min(1000, Number(e.target.value) || 0)) })} /></label> : null}
        <span className="tnum lg-dim">{clipLen(c).toFixed(1)}s</span><span className="grow" />
        <button className="ib" disabled={i === 0} onClick={() => move(c.id, -1)} aria-label="上移"><Icon name="up" size="xs" /></button>
        <button className="ib" disabled={i === media.length - 1} onClick={() => move(c.id, 1)} aria-label="下移"><Icon name="down" size="xs" /></button>
        <button className="ib" onClick={() => set(clips.filter((x) => x.id !== c.id))} aria-label="移除"><Icon name="x" size="xs" /></button>
      </div>)}
      {subs.map((c) => <div key={c.id} className="lg-clip sub">
        <Icon name="text" size="xs" /><input className="lg-subtext" value={c.text || ""} onKeyDown={stop} onChange={(e) => patch(c.id, { text: e.target.value })} />
        <label>起<input type="number" step="0.1" min={0} value={c.start || 0} onKeyDown={stop} onChange={(e) => patch(c.id, { start: Number(e.target.value) || 0 })} /></label>
        <label>止<input type="number" step="0.1" min={0} value={c.end || 0} onKeyDown={stop} onChange={(e) => patch(c.id, { end: Number(e.target.value) || 0 })} /></label>
        <button className="ib" onClick={() => set(clips.filter((x) => x.id !== c.id))} aria-label="移除"><Icon name="x" size="xs" /></button>
      </div>)}
    </div>
    {prev && media.length ? <TimelinePreview clips={media} onClose={() => setPrev(false)} /> : null}
    <div className="lg-row">
      <button className="pill" disabled={!media.length} onClick={() => setPrev(!prev)}><Icon name="play" size="xs" />{prev ? "关闭预览" : "预览"}</button>
      <span className="grow" />{busy ? <span className="lg-dim">{busy}</span> : null}
      {backendExportAvailable() ? <button className="pill" disabled={!media.length || !!busy} onClick={() => void exportIt("mp4")}><Icon name="download" size="xs" />导出 MP4</button> : null}
      <button className="pill" disabled={!media.length || !!busy} onClick={() => void exportIt("webm")}><Icon name="download" size="xs" />导出 WebM</button>
    </div>
  </div>;
}
function TimelinePreview({ clips, onClose }: { clips: TimelineClip[]; onClose: () => void }) {
  const [i, setI] = useState(0); const c = clips[Math.min(i, clips.length - 1)]; const url = useAssetUrl(c.url); const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { const v = ref.current; if (!v || !url) return; v.currentTime = c.inPoint; void v.play().catch(() => undefined); }, [url, c.inPoint]);
  return <div className="lg-prev">
    {c.mediaKind === "audio" ? <audio ref={ref as never} src={url} onTimeUpdate={(e) => { if (e.currentTarget.currentTime >= c.outPoint) (i + 1 < clips.length ? setI(i + 1) : onClose()); }} controls /> : <video ref={ref} src={url} muted={false} onTimeUpdate={(e) => { if (e.currentTarget.currentTime >= c.outPoint) (i + 1 < clips.length ? setI(i + 1) : onClose()); }} />}
    <span className="tnum lg-dim">片段 {i + 1}/{clips.length}</span>
  </div>;
}

/* ---------------- 3D 模型（文生 / 图生 3D） ---------------- */
export function Model3DBody({ node }: { node: CanvasNode }) {
  const store = useCtl().store; const [mode, setMode] = useState<"text" | "image">("text"); const [ref, setRef] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const runRef = useRef<string | null>(null);
  const [prompt, setPrompt] = useState(node.text || ""); const url = useAssetUrl(node.url || "");
  // 3D 模型跟随用户选择（设置 › 模型 里有「3D 生成」能力的都列出来），记住上次选的
  const [models3d, setModels3d] = useState<Array<{ id: string; name: string; vendor: string }>>([]);
  const [model3d, setModel3d] = useState<string>(() => { try { return localStorage.getItem("canvas-next:model3d") || ""; } catch { return ""; } });
  useEffect(() => { let dead = false; const api = (window as unknown as { openarc?: { model?: { command?: (r: Record<string, unknown>) => Promise<Record<string, any>> } } }).openarc?.model?.command; if (!api) return;
    void api({ command: "canvas/models", payload: {} }).then((r) => { if (dead) return; const rows = (Array.isArray(r?.models) ? r.models : []).filter((m: any) => Array.isArray(m.capabilities) && m.capabilities.includes("3d-generation")).map((m: any) => ({ id: String(m.configId), name: String(m.displayName || m.remoteModelId || "3D 模型"), vendor: String(m.providerName || "") })); setModels3d(rows); if (rows.length && !rows.some((x: { id: string }) => x.id === model3d)) setModel3d(rows[0].id); }).catch(() => undefined);
    return () => { dead = true; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const cmd = () => (window as unknown as { openarc?: { canvas?: { command?: (r: Record<string, unknown>) => Promise<Record<string, any>> } } }).openarc?.canvas?.command;
  const run = async () => {
    const c = cmd(); if (!c) { setErr("未连接桌面后端"); return; }
    if (!model3d) { setErr("还没有可用的 3D 模型：在 设置 › 模型 里添加 Tripo 等 3D 服务"); return; }
    if (mode === "image" && !ref) { setErr("先选一张参考图"); return; }
    setBusy(true); setErr(""); store.updateNode(node.id, (n) => ({ ...n, text: prompt }));
    try {
      const cid = store.state.canvasId;
      let r = await c({ type: "canvas/model3d", canvasId: cid, nodeId: node.id, async: true, configId: model3d, prompt: prompt || "a small object", mode, sourceDataUrl: mode === "image" ? ref : null });
      if (r && r.async === true && r.runId) {
        runRef.current = String(r.runId); const end = Date.now() + 10 * 60_000; let fin: Record<string, any> | null = null;
        while (Date.now() < end) { await new Promise((ok) => setTimeout(ok, 1500)); const st = await c({ type: "canvas/runStatus", canvasId: cid, runId: r.runId }); if (!st || st.ok !== true) throw new Error(String(st?.error || "查询状态失败")); if (st.status === "DONE") { fin = st.result || {}; break; } if (st.status === "FAILED") throw new Error(String(st.error || "3D 生成失败")); if (st.status === "STOPPED") { setErr("已停止"); return; } }
        if (!fin) throw new Error("生成超时（10 分钟）"); r = fin;
      }
      if (!r || r.ok !== true) throw new Error(String(r?.detail || r?.error || "3D 生成失败"));
      store.snapshot(); store.updateNode(node.id, (n) => ({ ...n, url: String(r.modelUrl || r.url || "") }));
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      const zh: Record<string, string> = {
        CREDENTIAL_MISSING: "3D 服务还没有填密钥：在 设置 › 模型 里给 Tripo3D 填上 API Key",
        MODEL_CONFIG_UNAVAILABLE: "选中的 3D 模型不可用：在 设置 › 模型 里检查是否已启用",
        CREDIT_INSUFFICIENT: "3D 服务额度不足，充值后再试",
        MODEL_3D_UNAVAILABLE: "当前没有可用的 3D 生成服务",
      };
      setErr(zh[code] || code || "3D 生成失败");
    } finally { setBusy(false); runRef.current = null; }
  };
  const pick = () => { const fi = document.createElement("input"); fi.type = "file"; fi.accept = "image/*"; fi.onchange = () => { const f = fi.files?.[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => setRef(String(rd.result || "")); rd.readAsDataURL(f); }; fi.click(); };
  return <div className="lg-3d" data-act="model3d" onPointerDown={stop} onWheel={stop}>
    {url ? <div className="lg-3dview"><Model3DViewer url={url} /></div> : <div className="lg-3dempty"><Icon name="cube" /><span>{busy ? "生成中，通常 1～3 分钟" : "描述一个物体，或用一张图生成 3D 模型"}</span></div>}
    <div className="lg-row"><div className="seg"><button className={mode === "text" ? "on" : ""} onClick={() => setMode("text")}>文生 3D</button><button className={mode === "image" ? "on" : ""} onClick={() => setMode("image")}>图生 3D</button></div>
      <span className="grow" />{models3d.length ? <select className="lg-model" value={model3d} title="3D 模型" onKeyDown={stop} onChange={(e) => { setModel3d(e.target.value); try { localStorage.setItem("canvas-next:model3d", e.target.value); } catch { /* 忽略 */ } }}>{models3d.map((m) => <option key={m.id} value={m.id}>{m.name}{m.vendor ? " · " + m.vendor : ""}</option>)}</select> : <span className="lg-dim">未配置 3D 模型</span>}
      {mode === "image" ? <button className="pill" onClick={pick}>{ref ? <img src={ref} alt="" className="lg-ref" /> : <Icon name="upload" size="xs" />}{ref ? "换一张" : "选参考图"}</button> : null}</div>
    <textarea className="lg-prompt" value={prompt} placeholder="描述要生成的 3D 物体" onKeyDown={stop} onChange={(e) => setPrompt(e.target.value)} onBlur={() => store.updateNode(node.id, (n) => ({ ...n, text: prompt }))} />
    {err ? <div className="gp-warn"><Icon name="alert" size="s" /><span>{err}</span></div> : null}
    <div className="lg-row"><span className="grow" />
      {busy ? <button className="pill" onClick={async () => { const c = cmd(); if (c && runRef.current) await c({ type: "canvas/runStop", canvasId: store.state.canvasId, runId: runRef.current, reason: "USER_STOP" }); }}>停止</button> : null}
      <button className="btn solid" disabled={busy} onClick={() => void run()}><Icon name="sparkle" size="s" />{busy ? "生成中…" : url ? "重新生成" : "生成 3D"}</button></div>
  </div>;
}

/* ---------------- 3D 片场 ---------------- */
const emptyScene = (): Scene3DData => ({ objects: [], camera: { position: [6, 5, 8], target: [0, 0, 0] }, background: "#111111" });
export function Scene3DBody({ node }: { node: CanvasNode }) {
  const store = useCtl().store; const [selId, setSel] = useState(""); const data = node.scene || emptyScene();
  const commit = (scene: Scene3DData) => store.updateNode(node.id, (n) => ({ ...n, scene }));
  const obj = data.objects.find((o) => o.id === selId);
  const upd = (p: Partial<Scene3DData["objects"][number]>) => commit({ ...data, objects: data.objects.map((o) => (o.id === selId ? { ...o, ...p } : o)) });
  return <div className="lg-scene" data-act="scene3d" onPointerDown={stop} onWheel={stop}>
    <div className="lg-sceneview"><Scene3D node={node} onChange={commit} /></div>
    <div className="lg-row"><span className="lg-dim">添加</span>
      {(["cube", "sphere", "cylinder", "plane"] as const).map((t) => <button key={t} className="pill" onClick={() => { const id = uid("obj"); store.snapshot(); /* 新物体沿 X 轴依次排开（每排 5 个），不叠在原点；平面铺在地上 */ const k = data.objects.filter((o) => o.type !== "plane" && o.type !== "gltf").length; commit({ ...data, objects: [...data.objects, { id, type: t, position: t === "plane" ? [0, 0.01, 0] : [((k % 5) - 2) * 1.4, .5, Math.floor(k / 5) * -1.4], rotation: [0, 0, 0], scale: [1, 1, 1], color: "#e8e8e8" }] }); setSel(id); }}>{{ cube: "立方体", sphere: "球体", cylinder: "圆柱", plane: "平面" }[t]}</button>)}
      <span className="grow" /><button className="pill" onClick={() => { store.snapshot(); commit({ ...data, objects: [] }); setSel(""); }}>清空</button></div>
    <div className="lg-row wrap">{data.objects.map((o, i) => <button key={o.id} className={"pill" + (o.id === selId ? " on" : "")} onClick={() => setSel(o.id)}>{o.name || { cube: "立方体", sphere: "球体", cylinder: "圆柱", plane: "平面", gltf: "模型" }[o.type]} {i + 1}</button>)}{!data.objects.length ? <span className="lg-dim">还没有物体</span> : null}</div>
    {obj ? <div className="lg-insp">
      {(["position", "rotation", "scale"] as const).map((k) => <div key={k} className="lg-vec"><span>{{ position: "位置", rotation: "旋转", scale: "缩放" }[k]}</span>{[0, 1, 2].map((ax) => <input key={ax} type="number" step="0.1" value={obj[k][ax]} onKeyDown={stop} onChange={(e) => { const v = [...obj[k]] as [number, number, number]; v[ax] = Number(e.target.value) || 0; upd({ [k]: v }); }} />)}</div>)}
      <div className="lg-row"><label className="lg-dim">颜色 <input type="color" value={obj.color} onChange={(e) => upd({ color: e.target.value })} /></label><span className="grow" /><button className="pill" onClick={() => { store.snapshot(); commit({ ...data, objects: data.objects.filter((o) => o.id !== obj.id) }); setSel(""); }}>删除物体</button></div>
    </div> : null}
  </div>;
}

export const LEGACY_DEFAULT: Record<string, { w: number; h: number; text: string }> = {
  timeline: { w: 560, h: 300, text: "剪辑时间线" }, model3d: { w: 420, h: 400, text: "" }, scene3d: { w: 640, h: 520, text: "3D 片场" }, note: { w: 240, h: 180, text: "" },
};
