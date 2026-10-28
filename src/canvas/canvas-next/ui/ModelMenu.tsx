/**
 * 模型选择弹层（节点生成面板 / 画布助手共用同一个，保证长相和行为一致）：
 *   标题「X模型 · 来自 设置 › 模型」→ 模型列表（名称 + 标签 + 厂商说明，当前项高亮并打勾）
 *   → 可选尾注 → 「模型设置」入口。
 */
import type { ReactNode } from "react";
import type { GenKind, ModelSpec } from "../model";
import { TYPE_LABEL } from "../model";
import { Icon } from "./Icon";

const KIND_TITLE: Record<GenKind, string> = { ...TYPE_LABEL, text: "对话" } as Record<GenKind, string>;

function detail(x: ModelSpec, kind: GenKind) {
  if (kind === "image") return ` · ${x.i2i ? "最多 " + x.maxRefs + " 张参考图" : "仅文生图"}`;
  if (kind === "text") return x.vision ? " · 能读图" : " · 只读文字";
  return "";
}

export function ModelMenu({ kind, list, currentId, onPick, onSettings, close, title, note }: {
  kind: GenKind; list: ModelSpec[]; currentId?: string | null; onPick: (m: ModelSpec) => void; onSettings?: () => void; close: () => void;
  /** 标题后半句；默认「来自 设置 › 模型」 */ title?: string; /** 列表下方的灰色尾注 */ note?: ReactNode;
}) {
  return <>
    <div className="mh">{(kind === "text" && title ? "对话" : TYPE_LABEL[kind]) + "模型 · " + (title || "来自 设置 › 模型")}</div>
    {list.map((x) => <button key={x.id} className={"mi" + (x.id === currentId ? " on" : "")} data-v={x.id} data-chat-model={kind === "text" ? x.id : undefined} onClick={() => { close(); onPick(x); }}>
      <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>{x.name}{x.tags.map((t) => <span key={t} className={"tag" + (t === "NEW" ? " new" : "")}>{t}</span>)}{x.specSource === "guess" ? <span className="tag" data-spec-source="guess" title="服务商没有提供该模型的参数规格，比例 / 档位 / 选项是按模型名推断的，以实际生成为准">未验证</span> : null}</span>
        {kind === "video" ? <span className="mtags">{x.res?.length && !x.tags.some((t) => t.toLowerCase() === x.res![x.res!.length - 1].toLowerCase()) ? <span className="tag">{x.res[x.res.length - 1]}</span> : null}{x.durs?.length ? <span className="tag tnum">{Math.min(...x.durs) === Math.max(...x.durs) ? x.durs[0] + "S" : Math.min(...x.durs) + "-" + Math.max(...x.durs) + "S"}</span> : null}{x.audio ? <span className="tag"><Icon name="audio" size="xs" /></span> : null}<span className="tag">{(x.modes || []).length} 种方式</span></span> : null}
        <span className="d">{x.vendor}{detail(x, kind)}</span></span>
      {x.id === currentId ? <span className="k"><Icon name="check" size="s" /></span> : null}
    </button>)}
    {!list.length ? <div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>还没有配置{KIND_TITLE[kind]}模型</span></div> : null}
    {note || onSettings ? <div className="msep" /> : null}
    {note ? <div className="row" style={{ color: "var(--fg3)", fontSize: 12 }}><span>{note}</span></div> : null}
    {onSettings ? <button className="mi" onClick={() => { close(); onSettings(); }}><Icon name="settings" size="s" />模型设置</button> : null}
  </>;
}
