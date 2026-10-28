/**
 * 多维表格节点。单元格 / 列名默认只读，双击进入编辑，Esc 或失焦退出（DX OS 的编辑状态机）。
 * 最左侧「输入」列显示连进表格的素材：1 个素材时每行共用，多个时逐行对应。
 */
import { useEffect, useRef } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { inputModeOf, mediaForRow, rowHeight, tableMedia, tableOf, TABLE_LIMITS, withTable, type TableData } from "../table";
import { useCtl, useS } from "./ctx";
import { Icon } from "./Icon";
import { useAssetUrl } from "./useAsset";

export function TableNodeBody({ node, sel }: { node: CanvasNode; sel: boolean }) {
  const ctl = useCtl(); const store = ctl.store;
  const doc = useS((s) => s.doc); const editCell = useS((s) => s.ui.editCell);
  const t = tableOf(node); const media = tableMedia(doc, node.id); const mode = inputModeOf(t, media);
  const save = (fn: (t: TableData) => TableData, history = false) => store.updateNode(node.id, (n) => withTable(n, fn(tableOf(n))), { history });
  const key = (r: number | "h", c: number) => `${node.id}:${r}:${c}`;
  const startEdit = (k: string) => { store.snapshot(); store.setUI({ editCell: k, sel: new Set([node.id]) }); };
  const stopEdit = () => store.setUI({ editCell: null });
  const addRow = (at = t.rows.length) => { if (t.rows.length >= TABLE_LIMITS.rows) return store.toast("表格最多允许 5000 行。"); save((x) => ({ ...x, rows: [...x.rows.slice(0, at), x.columns.map(() => ""), ...x.rows.slice(at)] }), true); };
  const addCol = () => { if (t.columns.length >= TABLE_LIMITS.cols) return store.toast("表格最多允许 200 列。"); save((x) => ({ ...x, columns: [...x.columns, "字段 " + (x.columns.length + 1)], rows: x.rows.map((r) => [...r, ""]) }), true); };
  const delCol = (i: number) => { if (t.columns.length <= 1) return store.toast("至少保留一列"); save((x) => ({ ...x, columns: x.columns.filter((_, j) => j !== i), rows: x.rows.map((r) => r.filter((_, j) => j !== i)) }), true); };
  const delRow = (i: number) => save((x) => ({ ...x, rows: x.rows.filter((_, j) => j !== i) }), true);
  return (
    <>
      <div className="nhead"><Icon name="grid" size="xs" /><span className="t">{t.title}</span><span className="tnum" style={{ color: "var(--fg3)", fontSize: 11 }}>{t.rows.length} × {t.columns.length}{media.length ? ` · ${media.length} 个输入` : ""}</span></div>
      <div className="nbody" style={{ height: node.h }}>
        <div className="tnode">
          <div className="tgrid" onWheel={(e) => { if (sel || editCell) e.stopPropagation(); }}>
            <table style={{ width: (media.length ? 96 : 0) + t.columns.length * 132 + 30 }}>
              <colgroup>{media.length ? <col style={{ width: 96 }} /> : null}{t.columns.map((_, i) => <col key={i} style={{ width: 132 }} />)}<col style={{ width: 30 }} /></colgroup>
              <thead><tr>
                {media.length ? <th className="tin"><div className="h">输入 · {mode === "sequence" ? "逐行" : "共用"}</div></th> : null}
                {t.columns.map((c, i) => <th key={i}><div className="h">
                  <Cell tag="input" cellKey={key("h", i)} value={c} editing={editCell === key("h", i)} onStart={() => startEdit(key("h", i))} onStop={stopEdit} onChange={(v) => save((x) => ({ ...x, columns: x.columns.map((y, j) => (j === i ? v.slice(0, 120) : y)) }))} />
                  <button className="xcol" title="删除列" onPointerDown={(e) => { e.stopPropagation(); delCol(i); }}><Icon name="x" size="xs" /></button>
                </div></th>)}
                <th className="tact" />
              </tr></thead>
              <tbody>
                {t.rows.map((row, r) => {
                  const rm = mediaForRow(t, media, r);
                  return <tr key={r} style={{ height: rowHeight(row, media.length > 0) }}>
                    {media.length ? <td className="tin"><div className="mcell">{rm.length ? rm.slice(0, 4).map((m) => <MediaThumb key={m.nodeId} src={m.src} kind={m.kind} title={m.title} />) : <em>—</em>}</div></td> : null}
                    {row.map((v, c) => <td key={c}><Cell tag="textarea" cellKey={key(r, c)} value={v} editing={editCell === key(r, c)} onStart={() => startEdit(key(r, c))} onStop={stopEdit} onChange={(nv) => save((x) => ({ ...x, rows: x.rows.map((rr, i) => (i === r ? rr.map((y, j) => (j === c ? nv.slice(0, TABLE_LIMITS.cell) : y)) : rr)) }))} /></td>)}
                    <td className="tact"><button title="删除这一行" onPointerDown={(e) => { e.stopPropagation(); delRow(r); }}><Icon name="trash" size="xs" /></button></td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
          <div className="tfoot">
            <button onPointerDown={(e) => { e.stopPropagation(); addRow(); }}><Icon name="plus" size="xs" />行</button>
            <button onPointerDown={(e) => { e.stopPropagation(); addCol(); }}><Icon name="plus" size="xs" />列</button>
            <span className="sp" />
            <span className="meta">双击单元格编辑</span>
          </div>
        </div>
      </div>
      <div className="rz" data-rz title="拖动调整大小" />
    </>
  );
}

function Cell({ tag, value, editing, onStart, onStop, onChange, cellKey }: { tag: "input" | "textarea"; value: string; editing: boolean; onStart: () => void; onStop: () => void; onChange: (v: string) => void; cellKey?: string }) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => { if (editing) ref.current?.focus({ preventScroll: true }); }, [editing]);
  const common = {
    ref, value, readOnly: !editing, "data-cell": cellKey,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
    onDoubleClick: (e: React.MouseEvent) => { e.stopPropagation(); onStart(); },
    onPointerDown: (e: React.PointerEvent) => { if (editing) e.stopPropagation(); },
    onBlur: () => { if (editing) onStop(); },
    onKeyDown: (e: React.KeyboardEvent) => { e.stopPropagation(); if (e.key === "Escape" || (tag === "input" && e.key === "Enter")) (e.target as HTMLElement).blur(); },
  };
  return tag === "input" ? <input {...common} /> : <textarea {...common} rows={2} cols={1} />;
}

function MediaThumb({ src, kind, title }: { src: string; kind: string; title: string }) {
  const url = useAssetUrl(src);
  return url ? <img src={url} alt="" title={title} draggable={false} /> : <span className="mi-ph" title={title}><Icon name={kind === "video" ? "video" : kind === "audio" ? "audio" : "image"} size="s" /></span>;
}
