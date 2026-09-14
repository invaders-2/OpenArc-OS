import React, { useCallback, useState } from "react";
import { Button } from "../design-system/primitives";

/** D3-04D · Files：File ≠ Resource Library，但提供受控 Add to Library / Export。 */
type ResBridge = { command: (c: Record<string, unknown>) => Promise<any> };
const bridge = (): ResBridge | undefined => (window as any).openarc?.resource;

export function FilesApp() {
  const [items, setItems] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exportRef, setExportRef] = useState("");

  const cmd = useCallback(async (payload: Record<string, unknown>): Promise<any> => {
    const b = bridge();
    if (!b) return { ok: false, error: "NO_BRIDGE" };
    try { return await b.command(payload); } catch { return { ok: false, error: "INTERNAL_ERROR" }; }
  }, []);

  const add = async (mode: "import" | "link") => {
    const res = await cmd({ type: mode === "import" ? "resource/pickImport" : "resource/pickLink" });
    if (res.ok) { setItems((p) => [...p, res.resource]); setNotice(mode === "import" ? "已纳入资源库（Managed）" : "已链接（Linked）"); setError(null); }
    else if (res.error !== "CANCELLED") setError(res.error);
  };
  const doExport = async () => {
    const res = await cmd({ type: "resource/export", resourceRef: exportRef.trim() });
    if (res.ok) { setNotice("已导出 " + res.bytes + " 字节"); setError(null); } else if (res.error !== "CANCELLED") setError(res.error);
  };
  const doReveal = async () => {
    const res = await cmd({ type: "resource/revealSource", resourceRef: exportRef.trim() });
    if (!res.ok) setError(res.error);
  };

  return (
    <div className="files" data-d3-04d="files">
      <header className="gov-head"><h2>文件</h2></header>
      <p className="gov-meta">File Manager 管理普通文件；Resource Library 管理 OpenArc Resource Object。这里是受控的 Add to Library / Export 入口。</p>
      <div className="gov-form">
        <Button variant="primary" size="sm" data-d3-04d-files-import onClick={() => void add("import")}>添加到资源库（Managed）</Button>
        <Button variant="secondary" size="sm" data-d3-04d-files-link onClick={() => void add("link")}>链接文件（Linked）</Button>
      </div>
      {error ? <p className="gov-error" role="alert" data-d3-04d-files-error>{error}</p> : null}
      {notice ? <p className="gov-notice" role="status" data-d3-04d-files-notice>{notice}</p> : null}
      <ul className="gov-list" data-d3-04d-files-items>
        {items.map((r) => (
          <li key={r.resourceId} data-d3-04d-file={r.resourceId} className="gov-row">
            <span className="gov-name">{r.name}</span>
            <span className="gov-meta">{r.storageMode} · {r.resourceRef}</span>
          </li>
        ))}
      </ul>
      <div className="gov-form">
        <input data-d3-04d-files-ref placeholder="resource://..." value={exportRef} onChange={(e) => setExportRef(e.target.value)} />
        <Button variant="secondary" size="sm" data-d3-04d-files-export onClick={() => void doExport()}>导出为普通文件</Button>
        <Button variant="ghost" size="sm" data-d3-04d-files-reveal onClick={() => void doReveal()}>显示源文件</Button>
      </div>
    </div>
  );
}
