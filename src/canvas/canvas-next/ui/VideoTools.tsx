/** 视频工具条里的 AI 编辑弹层：替换 / 移除 / 续写 / 重拍（逻辑见 ../videoTools.ts） */
import { useState } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { clampTrim, outOf, trimIsFull } from "../model";
import type { CanvasStore } from "../store";
import { aiVideoEdit, modelFor, opMode, RETAKE_CAMERAS, type VideoAiOp } from "../videoTools";
import { Icon, type IconName } from "./Icon";
import { openPop } from "./overlay";

const OPS: Array<[VideoAiOp, IconName, string, string]> = [
  ["replace", "wand", "替换物体", "把画面里的某样东西换掉"],
  ["remove", "eraser", "移除物体", "去掉画面里的某样东西并补全背景"],
  ["extend", "rundown", "续写视频", "接着最后一帧往后生成"],
  ["retake", "camera", "重拍片段", "选一段换机位重新拍（按使用区间）"],
];

/** 工具条「AI 编辑」：先选操作，再填内容 */
export function videoAiMenu(store: CanvasStore, node: CanvasNode, anchor: Element) {
  openPop(anchor, (close) => <>
    <div className="mh">AI 视频编辑</div>
    {OPS.map(([op, ic, label, desc]) => {
      const m = modelFor(store, opMode(op), store.modelOf(node));
      return <button key={op} className="mi" data-vai={op} title={m ? "" : `需要支持「${opMode(op)}」的视频模型`} onClick={() => { close(); setTimeout(() => videoAiForm(store, node, anchor, op), 140); }}>
        <span className="ic"><Icon name={ic} size="s" /></span><span>{label}<span className="d">{m ? desc : `没有支持「${opMode(op)}」的模型`}</span></span>
      </button>;
    })}
  </>, "up");
}

export function videoAiForm(store: CanvasStore, node: CanvasNode, anchor: Element, op: VideoAiOp) {
  openPop(anchor, (close) => <VideoAiForm store={store} node={node} op={op} close={close} />, "up", "left", "vai-pop");
}

function VideoAiForm({ store, node, op, close }: { store: CanvasStore; node: CanvasNode; op: VideoAiOp; close: () => void }) {
  const [a, setA] = useState(op === "retake" ? RETAKE_CAMERAS[0] : ""); const [b, setB] = useState("");
  const m = modelFor(store, opMode(op), store.modelOf(node));
  const o = outOf(node); const t = o ? clampTrim(o.dur, o.trim) : null; const part = !!(o?.trim && !trimIsFull(o.dur, o.trim));
  const go = () => { close(); void aiVideoEdit(store, node, op, a, b); };
  const stop = (e: React.KeyboardEvent) => { e.stopPropagation(); if ((e.metaKey || e.ctrlKey) && e.key === "Enter") go(); };
  const title = op === "replace" ? "替换物体" : op === "remove" ? "移除物体" : op === "extend" ? "续写视频" : "重拍片段";
  return <div className="vai" data-vai-form={op}>
    <div className="mh">{title}{m ? <span className="vai-model">{m.name} · {opMode(op)}</span> : null}</div>
    {!m ? <div className="gp-warn"><Icon name="alert" size="s" /><span>还没有支持「{opMode(op)}」的视频模型（如 Seedance），请在设置 › 模型里添加。</span></div> : null}
    {op === "replace" ? <>
      <label>要替换的东西</label><input autoFocus value={a} placeholder="例如：桌上的白色杯子" onChange={(e) => setA(e.target.value)} onKeyDown={stop} />
      <label>换成</label><input value={b} placeholder="例如：一束红玫瑰" onChange={(e) => setB(e.target.value)} onKeyDown={stop} />
    </> : op === "remove" ? <>
      <label>要移除的东西</label><input autoFocus value={a} placeholder="例如：右下角的路人" onChange={(e) => setA(e.target.value)} onKeyDown={stop} />
    </> : op === "extend" ? <>
      <label>接下来发生什么（可不填）</label><textarea autoFocus rows={3} value={a} placeholder="例如：镜头慢慢拉远，主角走出画面" onChange={(e) => setA(e.target.value)} onKeyDown={stop} />
    </> : <>
      <label>新机位</label>
      <div className="seg wrap">{RETAKE_CAMERAS.map((c) => <button key={c} className={a === c ? "on" : ""} onClick={() => setA(c)}>{c}</button>)}</div>
      <label>补充说明（可不填）</label><input value={b} placeholder="例如：节奏放慢一些" onChange={(e) => setB(e.target.value)} onKeyDown={stop} />
      <p className="vai-note">{part && t ? `只重拍使用区间 ${Math.round(t.in * 10) / 10}s–${Math.round(t.out * 10) / 10}s：先把这一段裁成单独的节点再生成。` : "没有设使用区间，会重拍整段。拖动视频下方的入点 / 出点可以只重拍一段。"}</p>
    </>}
    <div className="vai-foot"><span className="vai-note">会在右侧新建视频节点并开始生成，按服务商用量计费</span><button className="btn solid" data-vai-go disabled={!m} onClick={go}><Icon name="sparkle" size="s" />生成</button></div>
  </div>;
}
