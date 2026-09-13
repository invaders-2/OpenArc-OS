/**
 * D3-04A · 最小 Resource Library 入口（真实产品入口，非完整资源库 UI）。
 *
 * 只展示 Store Core 真正能保证的东西：Import / Link、ResourceRef、name、type、
 * size、storage mode、availability。导入成功后显示描述符。
 * 渲染进程不拿绝对路径：文件选择发生在主进程 dialog，路径从不回渲染进程。
 */
import { useCallback, useEffect, useState } from "react";

type ResourceDescriptor = {
  resourceId: string;
  resourceRef: string;
  name: string;
  resourceType: string;
  mimeType: string;
  size: number | null;
  storageMode: string;
  availability: string;
  version: number;
  trashed: boolean;
  source?: { label?: string };
};

type ListResult = { ok?: boolean; error?: string; items?: ResourceDescriptor[]; count?: number };

export function ResourceLibraryPlaceholder() {
  const bridge = typeof window !== "undefined" ? window.openarc?.resource : undefined;
  const [items, setItems] = useState<ResourceDescriptor[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!bridge) return;
    const res = (await bridge.command({ type: "resource/list" })) as ListResult;
    if (res && res.ok && Array.isArray(res.items)) {
      setItems(res.items);
      setError(null);
    } else {
      setError(String((res && res.error) || "INTERNAL_ERROR"));
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (type: string) => {
    if (!bridge) return;
    setBusy(true);
    setError(null);
    try {
      const res = (await bridge.command({ type })) as { ok?: boolean; error?: string };
      if (!res || !res.ok) setError(String((res && res.error) || "INTERNAL_ERROR"));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!bridge) {
    return (
      <div className="empty-content" data-d3-04a="unavailable">
        <h1>资源库</h1>
        <span className="badge">不可用</span>
        <p>资源存储需要主进程服务。当前环境没有 OpenArc 服务。</p>
      </div>
    );
  }

  return (
    <div className="app-content" data-d3-04a="resource-library">
      <div className="eyebrow">LOCAL RESOURCE LIBRARY · D3-04A</div>
      <h1>资源库 · 存储底座</h1>
      <p className="subtitle">Managed = 复制进 OpenArc；Linked = 只引用本机文件，不复制内容。</p>
      <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
        <button type="button" disabled={busy} data-d3-04a-action="import" onClick={() => void run("resource/pickImport")}>
          Import File
        </button>
        <button type="button" disabled={busy} data-d3-04a-action="link" onClick={() => void run("resource/pickLink")}>
          Link File
        </button>
      </div>
      {error ? (
        <p data-d3-04a-error style={{ color: "#ffb4b4" }}>
          {error}
        </p>
      ) : null}
      <ul data-d3-04a-list style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
        {items.map((r) => (
          <li key={r.resourceId} data-d3-04a-item={r.resourceId} style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, padding: 10 }}>
            <strong>{r.name}</strong>
            <div style={{ opacity: 0.7, fontSize: 12 }}>
              {r.resourceRef} · {r.resourceType} · {r.storageMode} · {r.availability}
            </div>
            <div style={{ opacity: 0.55, fontSize: 12 }}>
              {r.size == null ? "-" : r.size + " bytes"} · v{r.version} · {r.source ? r.source.label : ""}
            </div>
          </li>
        ))}
      </ul>
      {items.length === 0 ? (
        <p data-d3-04a-empty style={{ opacity: 0.6 }}>
          还没有资源。用 Import File 添加第一个。
        </p>
      ) : null}
    </div>
  );
}
