import React, { useCallback, useEffect, useState } from "react";
import { Button } from "../design-system/primitives";

/** D3-04D · 系统级 Resource Picker（只展示 User ∩ App ∩ 类型 ∩ 动作 的交集）。 */
type ResBridge = { command: (c: Record<string, unknown>) => Promise<any> };
const bridge = (): ResBridge | undefined => (window as any).openarc?.resource;

export function ResourcePicker({
  pickerAppId,
  resourceTypes,
  requestedActions,
  onChoose,
  onCancel,
  title = "选择资源",
}: {
  pickerAppId: string;
  resourceTypes?: string[];
  requestedActions?: string[];
  onChoose: (ref: string) => void;
  onCancel: () => void;
  title?: string;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<any[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    const b = bridge();
    if (!b) { setError("NO_BRIDGE"); return; }
    const res = await b.command({ type: "resource/pickerQuery", pickerAppId, query, resourceTypes, requestedActions, limit: 50 });
    if (res.ok) { setItems(res.items); setError(null); } else setError(res.error);
  }, [pickerAppId, query, resourceTypes, requestedActions]);

  useEffect(() => { void run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const choose = async () => {
    if (!selected) return;
    const b = bridge();
    if (!b) return;
    const res = await b.command({ type: "resource/pickerChoose", pickerAppId, resourceRef: selected, requestedActions });
    if (res.ok) onChoose(res.resourceRef);
    else setError(res.error);
  };

  return (
    <div className="picker" role="dialog" aria-modal="true" aria-label={title} data-d3-04d-picker data-d3-04d-picker-app={pickerAppId}>
      <header className="picker-head">
        <h3>{title}</h3>
        <span className="gov-meta">{pickerAppId}</span>
      </header>
      <div className="picker-search">
        <input data-d3-04d-picker-query placeholder="搜索资源" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void run(); }} />
        <Button variant="secondary" size="sm" data-d3-04d-picker-search onClick={() => void run()}>搜索</Button>
      </div>
      {error ? <p className="gov-error" data-d3-04d-picker-error>{error}</p> : null}
      <ul className="picker-list" data-d3-04d-picker-items>
        {items.map((it) => (
          <li key={it.resourceId}>
            <button type="button" data-d3-04d-picker-item={it.resourceId} aria-pressed={selected === it.resourceId} className={selected === it.resourceId ? "is-selected" : ""} onClick={() => setSelected(it.resourceId)}>
              <span className="gov-name">{it.name}</span>
              <span className="gov-meta">{it.resourceType} · {it.departmentId || "personal"}</span>
            </button>
          </li>
        ))}
      </ul>
      <footer className="picker-foot">
        <Button variant="ghost" size="sm" data-d3-04d-picker-cancel onClick={onCancel}>取消</Button>
        <Button variant="primary" size="sm" data-d3-04d-picker-choose disabled={!selected} onClick={() => void choose()}>选择</Button>
      </footer>
    </div>
  );
}
