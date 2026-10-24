/**
 * 节点渲染。生成类节点（文本 / 图片 / 视频 / 音频）、多维表格、旧版节点（只读占位）。
 * 生成中用 TapNow 的 node-loading 图层栈；失败用「提示」遮罩；结果 180ms 淡入。
 */
import { Markdown, TextSkeleton } from "./markdown";
import { GroupBody, Model3DBody, NoteBody, Scene3DBody, TimelineBody } from "./LegacyNodes";
import { memo, useEffect, useRef, useState } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { bgColor, genOf, isGenKind, outOf, tagColor, TYPE_ICON, TYPE_LABEL, type GenOutput } from "../model";
import type { RunState } from "../store";
import { Icon } from "./Icon";
import { TableNodeBody } from "./TableNode";
import { useAssetUrl } from "./useAsset";

export type NodeViewProps = {
  node: CanvasNode;
  sel: boolean;
  run?: RunState;
  editing: boolean;
  drop: boolean;
  noconn: boolean;
  hl: boolean;
  /** 上游素材第一张（生成中模糊做底） */
  loadSrc?: string;
  batchInfo?: string;
  onAct: (node: CanvasNode, act: string, e: React.SyntheticEvent) => void;
  onTextCommit: (id: string, text: string) => void;
};

const legacyLabel: Record<string, string> = { model3d: "3D 模型", timeline: "剪辑时间线", scene3d: "3D 片场", note: "便签", group: "分组", "smart-batch": "批量", "smart-loop": "循环" };

export const NodeView = memo(function NodeView(p: NodeViewProps) {
  const { node, run } = p;
  const enterRef = useRef(true);
  const [entering, setEntering] = useState(true);
  useEffect(() => { const t = setTimeout(() => { enterRef.current = false; setEntering(false); }, 200); return () => clearTimeout(t); }, []);
  const cls = ["node", entering ? "enter" : "", p.sel ? "sel" : "", run ? "running" : "", p.drop ? "drop" : "", p.noconn ? "noconn" : "", p.hl ? "hl" : ""].filter(Boolean).join(" ");
  const style = { left: node.x, top: node.y, width: node.w };
  if (node.kind === "table") return (
    <div className={cls + " tnode-wrap"} data-id={node.id} style={style}>
      <TableNodeBody node={node} sel={p.sel} />
      <Ports h={node.h} />
    </div>
  );
  if (node.kind === "group") return (
    <div className={cls + " gnode"} data-id={node.id} style={style}>
      <div className="nhead"><Icon name="layers" size="xs" /><span className="t">{node.text && node.text !== "分组" ? node.text : "分组"}</span></div>
      <div className="nbody gbody" style={{ height: node.h }}><GroupBody node={node} /></div>
      <div className="rz" data-rz title="拖动调整大小" />
    </div>
  );
  if (!isGenKind(node.kind)) {
    const body = node.kind === "note" ? <NoteBody node={node} /> : node.kind === "timeline" ? <TimelineBody node={node} /> : node.kind === "model3d" ? <Model3DBody node={node} /> : node.kind === "scene3d" ? <Scene3DBody node={node} />
      : <div className="ph"><Icon name="layers" /><span>旧版「{legacyLabel[node.kind] || node.kind}」节点，新画布里只显示</span></div>;
    return (
      <div className={cls + " lgnode lg-" + node.kind} data-id={node.id} style={style}>
        <div className="nhead"><Icon name={node.kind === "model3d" || node.kind === "scene3d" ? "cube" : node.kind === "timeline" ? "video" : node.kind === "note" ? "pencil" : "layers"} size="xs" /><span className="t">{legacyLabel[node.kind] || node.kind}</span></div>
        <div className="nbody" style={{ height: node.h }}>{body}</div>
        <div className="rz" data-rz title="拖动调整大小" />
        {node.kind === "model3d" || node.kind === "timeline" ? <Ports h={node.h} /> : null}
      </div>
    );
  }
  const g = genOf(node); const out = outOf(node); const running = !!run;
  return (
    <div className={cls} data-id={node.id} style={style}>
      <div className="nhead">
        <Icon name={TYPE_ICON[node.kind]} size="xs" /><span className="t">{g.title}</span>
        {g.tag || g.pinned ? <i className="tagdot" title="颜色标记" style={{ background: tagColor(g.tag || "red")! }} /> : null}{g.agent ? <span className="pinmark">Agent</span> : null}
        {running ? <span className="st tnum" style={{ color: "var(--fg2)" }}>{run!.batch ? `${run!.batch.done}/${run!.batch.total}` : <i className="runsig" role="status" aria-label="生成中" />}</span>
          : g.err ? <span className="st" style={{ color: "var(--bad)" }}><Icon name="alert" size="xs" /></span>
          : out ? <span className="st" style={{ color: "var(--fg3)" }}><Icon name="check" size="xs" /></span> : null}
      </div>
      <div className={"nbody" + (g.bg ? " tinted" : "")} style={{ height: node.h, ...(g.bg ? { ["--tint" as string]: bgColor(g.bg)! } : {}) }}>
        <Body {...p} out={out} running={running} />
        {g.hist.length > 1 && !running && node.kind !== "text" ? <div className="vstrip tnum"><button data-act="vprev" onPointerDown={(e) => p.onAct(node, "vprev", e)}><Icon name="left" size="xs" /></button>{g.hi + 1}/{g.hist.length}<button data-act="vnext" onPointerDown={(e) => p.onAct(node, "vnext", e)}><Icon name="right" size="xs" /></button></div> : null}
        {node.kind === "image" && out && !running ? <button className={"favstar" + (g.fav ? " on" : "")} data-act="fav" title={g.fav ? "取消收藏" : "收藏到素材库"} onPointerDown={(e) => p.onAct(node, "fav", e)}><Icon name="star" size="s" /></button> : null}
        {p.batchInfo && !running ? <span className="bbadge tnum">{p.batchInfo}</span> : null}
        {g.err && !running ? <div className="nerr"><b>提示</b><span>{g.err}</span><button data-act="errok" onPointerDown={(e) => p.onAct(node, "errok", e)}>确认</button></div> : null}
      </div>
      <div className="rz" data-rz title="拖动调整大小" />
      <Ports h={node.h} />
    </div>
  );
});

function Ports({ h }: { h: number }) {
  return <>{(["in", "out"] as const).map((s) => <div key={s} className={"pz " + s} data-port={s} style={{ top: 24 + h / 2 }}><div className="pf"><div className="port"><Icon name="plus" /></div></div></div>)}</>;
}

function Body(p: NodeViewProps & { out: GenOutput | null; running: boolean }) {
  const { node, out, running } = p; const g = genOf(node);
  // 文本节点生成中：同 TapNow 用骨架线；流式有内容后直接按 Markdown 渲染并跟随光标
  if (running && node.kind === "text") return p.run?.stream ? <div className="ntext md-wrap streaming"><Markdown text={p.run.stream} /><span className="caret" /></div> : <TextSkeleton />;
  if (running) return <><Loading src={p.loadSrc} /><span className="nl-lab tnum">{p.run?.batch ? `逐行生成 ${p.run.batch.done}/${p.run.batch.total}` : "生成中"}</span></>;
  if (node.kind === "image") {
    if (out?.url) return <MediaImg src={out.url} alpha={false} />;
    return <div className="ph"><Icon name="image" /><span>{g.uploaded ? "拖入或上传图片" : "选中后在下方描述要生成的画面"}</span></div>;
  }
  if (node.kind === "text") {
    if (p.editing) return <TextEditor node={node} onCommit={p.onTextCommit} />;
    if (out?.text) return <div className="ntext md-wrap"><Markdown text={out.text} /></div>;
    return <div className="ph"><Icon name="text" /><span>双击直接书写，或在下方写指令让模型生成</span></div>;
  }
  if (node.kind === "video") {
    if (out && (out.frame || out.url)) return <VideoBody out={out} />;
    return <div className="ph"><Icon name="video" /><span>连入图片作为首帧 / 尾帧 / 参考，或直接写提示词</span></div>;
  }
  if (out) return <AudioBody out={out} />;
  return <div className="ph"><Icon name="audio" /><span>音乐、配音或音效</span></div>;
}

function MediaImg({ src, alpha }: { src: string; alpha: boolean }) {
  const url = useAssetUrl(src); const [fresh, setFresh] = useState(true);
  useEffect(() => { setFresh(true); const t = setTimeout(() => setFresh(false), 200); return () => clearTimeout(t); }, [url]);
  return url ? <img src={url} className={(alpha ? "alpha" : "") + (fresh ? " fresh" : "")} alt="" draggable={false} /> : <div className="ph"><Icon name="image" /><span>资源不可用</span></div>;
}

function Loading({ src }: { src?: string }) {
  const url = useAssetUrl(src || "");
  return (
    <div className={"nl" + (url ? "" : " empty")}>
      {url ? <img className="nl-blur" src={url} alt="" draggable={false} /> : null}
      <div className={"nl-shadow" + (url ? "" : " empty")} />
      <div className="nl-enter"><div className="nl-dots nl-stars" /><div className="nl-dots nl-sweep" /><div className="nl-glow" /><div className="nl-dots nl-burst" /><div className="nl-dither" /></div>
    </div>
  );
}

function VideoBody({ out }: { out: GenOutput }) {
  const frame = useAssetUrl(out.frame || ""); const url = useAssetUrl(out.url || "");
  const [playing, setPlaying] = useState(false); const vref = useRef<HTMLVideoElement>(null);
  if (playing && url) return <video ref={vref} src={url} autoPlay controls onEnded={() => setPlaying(false)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />;
  return <>
    {frame ? <img src={frame} alt="" draggable={false} /> : url ? <video src={url} muted preload="metadata" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
    <button className="play" data-act="play" onPointerDown={(e) => { e.stopPropagation(); if (url) setPlaying(true); }}><Icon name="play" /></button>
    <span className="vinfo tnum">{out.dur ? out.dur + "s" : ""}{out.res ? " · " + out.res : ""}</span><i className="vprog" />
  </>;
}

function AudioBody({ out }: { out: GenOutput }) {
  const url = useAssetUrl(out.url || ""); const aref = useRef<HTMLAudioElement>(null);
  const [t, setT] = useState(0); const [on, setOn] = useState(false);
  const bars = out.bars && out.bars.length ? out.bars : Array.from({ length: 48 }, (_, i) => .2 + Math.abs(Math.sin(i * .5)) * .6);
  const dur = out.dur || 0; const frac = dur ? t / dur : 0;
  return <>
    {url ? <audio ref={aref} src={url} onTimeUpdate={(e) => setT((e.target as HTMLAudioElement).currentTime)} onEnded={() => { setOn(false); setT(0); }} /> : null}
    <div className="wave">{bars.map((b, i) => <i key={i} className={on && i / bars.length <= frac ? "on" : ""} style={{ height: Math.round(b * 70) + "%" }} />)}</div>
    <div className="actl"><button className="p" data-act="play" onPointerDown={(e) => { e.stopPropagation(); const a = aref.current; if (!a) { setOn(true); let i = 0; const tm = setInterval(() => { i += .25; setT(i); if (i >= dur) { clearInterval(tm); setOn(false); setT(0); } }, 250); return; } if (a.paused) { void a.play(); setOn(true); } else { a.pause(); setOn(false); } }}><Icon name="play" /></button><span className="tnum" style={{ fontSize: 11, color: "var(--fg2)" }}>0:{String(Math.round(dur)).padStart(2, "0")}</span></div>
  </>;
}

function TextEditor({ node, onCommit }: { node: CanvasNode; onCommit: (id: string, text: string) => void }) {
  const [v, setV] = useState(outOf(node)?.text || ""); const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return <div className="ntext edit" onPointerDown={(e) => e.stopPropagation()}><textarea ref={ref} id="txtEdit" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => onCommit(node.id, v)} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); (e.target as HTMLTextAreaElement).blur(); } }} /></div>;
}

export { TYPE_LABEL };
