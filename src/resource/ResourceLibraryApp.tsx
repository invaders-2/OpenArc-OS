/**
 * D3-04B · Resource Library App（三栏：Navigation / Content / Inspector）。
 *
 * 只通过 window.openarc.resource.command 访问资源；没有 raw fs / 绝对路径。
 * 授权、查询过滤、版本、Trash 全部由主进程 ResourceService（D3-04A/D3-02）决定，
 * 本组件只做展示与 UX。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "../desktop/Dialog";
import { Button, SearchField } from "../design-system/primitives";

type Descriptor = {
  resourceId: string;
  resourceRef: string;
  resourceType: string;
  mimeType: string;
  name: string;
  description: string;
  storageMode: string;
  size: number | null;
  version: number;
  scope: string | null;
  departmentId: string | null;
  collectionId: string | null;
  ownerUserId: string | null;
  storageDeviceId: string | null;
  memorySubtype: string | null;
  language: string | null;
  availability: string;
  trashed: boolean;
  favorite: boolean;
  recentAt: number | null;
  createdAt: number;
  updatedAt: number;
  source?: { label?: string };
  snippet?: { text: string; spans: { text: string; match: boolean }[]; truncated: boolean; matched: boolean };
  matchedFields?: string[];
  indexStatus?: string;
};

type PreviewState = {
  kind: string;
  availability: string;
  mimeType?: string;
  size?: number | null;
  version?: number;
  text?: string;
  truncated?: boolean;
  url?: string;
  error?: string;
  thumbnailUrl?: string;
};

type CollectionView = { collectionId: string; name: string; description: string; resourceCount: number; editable: boolean; scope: string };
type TagView = { tagId: string; name: string; source?: string };
type VersionView = { version: number; size: number | null; createdAt: number; createdBy: string | null; source: string };

type Inspector = {
  resource: Descriptor;
  location: { storageMode: string; deviceId: string | null; availability: string };
  capabilities: { effective: Record<string, boolean>; effectiveActions: string[]; userActions: string[]; appActions: string[]; userDenied: string | null; appDenied: string | null };
  tags: TagView[];
  collection: CollectionView | null;
  versions: VersionView[];
  relations: { outgoing: number; incoming: number };
  provenance: { source: string; memorySubtype: string | null; language: string | null; generatedSourceTaskId: string | null; generatedSourceCallId: string | null; generatedSourceModel: string | null };
  trashed: boolean;
  favorite: boolean;
};

const NAV: { id: string; label: string; empty: string }[] = [
  { id: "all", label: "全部", empty: "还没有资源。用「导入」或「新建」添加第一个。" },
  { id: "memory", label: "Memory", empty: "暂无 Memory。用「新建」创建一条。" },
  { id: "documents", label: "文档", empty: "暂无文档资源。" },
  { id: "images", label: "图片", empty: "暂无图片资源。" },
  { id: "videos", label: "视频", empty: "暂无视频资源。" },
  { id: "audio", label: "音频", empty: "暂无音频资源。" },
  { id: "code", label: "代码", empty: "暂无代码资源。" },
  { id: "prompts", label: "Prompt", empty: "暂无 Prompt 资源。" },
  { id: "generated", label: "生成产物", empty: "暂无生成产物。" },
  { id: "favorites", label: "收藏", empty: "还没有收藏任何资源。" },
  { id: "recent", label: "最近", empty: "还没有最近打开的记录。" },
  { id: "trash", label: "回收站", empty: "回收站是空的。" },
];

const CREATE_TYPES = [
  { id: "memory", label: "Memory" },
  { id: "text", label: "Text" },
  { id: "code", label: "Code" },
  { id: "prompt", label: "Prompt" },
];
const MEMORY_SUBTYPES = [
  { id: "personal-preference", label: "个人偏好" },
  { id: "project-memory", label: "项目记忆" },
  { id: "decision-memory", label: "决策记忆" },
  { id: "conversation-memory", label: "对话记忆" },
  { id: "agent-memory", label: "Agent 记忆" },
];
const AVAILABILITY_LABEL: Record<string, string> = {
  AVAILABLE: "可用",
  SOURCE_MISSING: "源文件丢失",
  SOURCE_CHANGED: "源文件已变化",
  DEVICE_OFFLINE: "设备离线",
  DEVICE_DISABLED: "设备已停用",
  DEVICE_REVOKED: "设备已撤销",
  DEVICE_UNKNOWN: "设备未知",
  INTEGRITY_FAILED: "完整性错误",
  TRASHED: "回收站",
  UNKNOWN: "未知",
};

const fmtSize = (n: number | null) => (n == null ? "-" : n < 1024 ? n + " bytes" : n < 1024 * 1024 ? (n / 1024).toFixed(1) + " KB" : (n / 1024 / 1024).toFixed(1) + " MB");
const fmtTime = (t: number | null) => (t == null ? "-" : new Date(t).toLocaleString());

export function ResourceLibraryApp() {
  const bridge = typeof window !== "undefined" ? window.openarc?.resource : undefined;
  const [category, setCategory] = useState("all");
  const [view, setView] = useState<"grid" | "list">(() => (typeof localStorage !== "undefined" && localStorage.getItem("oa-resource-view") === "list" ? "list" : "grid"));
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("updated");
  const [direction, setDirection] = useState("desc");
  const [filterCollection, setFilterCollection] = useState<string | null>(null);
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [items, setItems] = useState<Descriptor[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [collections, setCollections] = useState<CollectionView[]>([]);
  const [tags, setTags] = useState<TagView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspector, setInspector] = useState<Inspector | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchMode, setSearchMode] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [indexStatus, setIndexStatus] = useState<{ indexStatus: string; stale: boolean; documentVersion: number | null; resourceVersion: number | null; indexedAt: number | null } | null>(null);
  const [reindexing, setReindexing] = useState<{ processed: number; remaining: number; total: number } | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [editor, setEditor] = useState<{ resourceRef: string; name: string; content: string; expectedVersion: number; resourceType: string } | null>(null);
  const [conflict, setConflict] = useState<{ resourceRef: string; draft: string; name: string; currentVersion: number } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ resourceRef: string; name: string; references: number } | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const cmd = useCallback(
    async (payload: Record<string, unknown>): Promise<any> => {
      if (!bridge) return { ok: false, error: "NO_BRIDGE" };
      try {
        return await bridge.command(payload);
      } catch {
        return { ok: false, error: "INTERNAL_ERROR" };
      }
    },
    [bridge],
  );

  const reload = useCallback(
    async (nextOffset = 0) => {
      if (!bridge) return;
      setBusy(true);
      const filter: Record<string, unknown> = {};
      if (filterCollection) filter.collectionId = filterCollection;
      if (filterTag) filter.tagId = filterTag;
      const q = query.trim();
      setSearchMode(!!q);
      if (q) filter.category = category;
      const res = q
        ? await cmd({ type: "resource/search", query: q, filter, limit: 60, offset: nextOffset })
        : await cmd({ type: "resource/query", category, filter, sort, direction, limit: 60, offset: nextOffset });
      if (res && res.ok) {
        setItems((prev) => (nextOffset === 0 ? res.items : [...prev, ...res.items]));
        setTotal(res.total);
        setHasMore(!!res.hasMore);
        setOffset(nextOffset);
        setError(q && res.totalIsLowerBound ? "结果可能不完整（索引扫描达到上限）" : null);
      } else {
        setError(String((res && res.error) || "INTERNAL_ERROR"));
      }
      setBusy(false);
    },
    [bridge, cmd, category, query, filterCollection, filterTag, sort, direction],
  );

  const loadPreview = useCallback(
    async (resourceRef: string) => {
      setPreview(null);
      const res = await cmd({ type: "resource/preview", resourceRef });
      if (res && res.ok) {
        setPreview(res as PreviewState);
        if (res.kind === "image") {
          const th = await cmd({ type: "resource/thumbnail", resourceRef });
          if (th && th.ok && th.url) setPreview((prev) => (prev ? { ...prev, thumbnailUrl: th.url } : prev));
        }
      } else {
        setPreview({ kind: "error", availability: String((res && res.error) || "ERROR"), error: String((res && res.error) || "ERROR") });
      }
    },
    [cmd],
  );

  const loadIndexStatus = useCallback(
    async (resourceRef: string) => {
      const res = await cmd({ type: "resource/indexStatus", resourceRef });
      if (res && res.ok) setIndexStatus(res);
      else setIndexStatus(null);
    },
    [cmd],
  );

  const rebuildIndex = useCallback(async () => {
    setReindexing({ processed: 0, remaining: 1, total: 0 });
    for (let i = 0; i < 500; i += 1) {
      const res = await cmd({ type: "resource/reindex", mode: "all", limit: 200 });
      if (!res || !res.ok) {
        setError(String((res && res.error) || "INDEX_FAILED"));
        break;
      }
      setReindexing({ processed: res.processed, remaining: res.remaining, total: res.total });
      if (res.remaining <= 0) break;
    }
    if (selectedId) void loadIndexStatus(selectedId);
    await reload(0);
  }, [cmd, selectedId, loadIndexStatus, reload]);

  const loadCollections = useCallback(async () => {
    const res = await cmd({ type: "resource/listCollections" });
    if (res && res.ok) setCollections(res.items || []);
  }, [cmd]);

  const loadTags = useCallback(async () => {
    const res = await cmd({ type: "resource/listTags" });
    if (res && res.ok) setTags(res.items || []);
  }, [cmd]);

  useEffect(() => {
    void reload(0);
  }, [reload]);
  useEffect(() => {
    void loadCollections();
  }, [loadCollections]);
  useEffect(() => {
    if (typeof localStorage !== "undefined") localStorage.setItem("oa-resource-view", view);
  }, [view]);

  const select = useCallback(
    async (resourceId: string, { touch = true }: { touch?: boolean } = {}) => {
      setSelectedId(resourceId);
      const res = await cmd({ type: "resource/inspector", resourceRef: resourceId });
      if (res && res.ok) setInspector(res as Inspector);
      else setInspector(null);
      if (touch) void cmd({ type: "resource/touchRecent", resourceRef: resourceId });
      void loadPreview(resourceId);
      void loadIndexStatus(resourceId);
    },
    [cmd, loadPreview, loadIndexStatus],
  );

  const afterMutation = useCallback(
    async (message: string) => {
      setNotice(message);
      await Promise.all([reload(0), loadCollections(), loadTags()]);
      if (selectedId) {
        const res = await cmd({ type: "resource/inspector", resourceRef: selectedId });
        if (res && res.ok) setInspector(res as Inspector);
        else if (!res || res.error === "NOT_FOUND_OR_FORBIDDEN") {
          setInspector(null);
          setSelectedId(null);
        }
      }
    },
    [reload, loadCollections, loadTags, selectedId, cmd],
  );

  const doImport = async () => {
    setError(null);
    const res = await cmd({ type: "resource/pickImport" });
    if (!res || !res.ok) {
      if (res && res.error !== "CANCELLED") setError(String(res.error));
      return;
    }
    await afterMutation("已导入并复制到 OpenArc");
    await select(res.resource.resourceId);
  };
  const doLink = async () => {
    setError(null);
    const res = await cmd({ type: "resource/pickLink" });
    if (!res || !res.ok) {
      if (res && res.error !== "CANCELLED") setError(String(res.error));
      return;
    }
    await afterMutation("已创建 Linked 资源（未复制内容）");
    await select(res.resource.resourceId);
  };

  const openEditor = async (resourceRef: string) => {
    const info = await cmd({ type: "resource/get", resourceRef });
    if (!info || !info.ok) {
      setError(String((info && info.error) || "INTERNAL_ERROR"));
      return;
    }
    const read = await cmd({ type: "resource/readText", resourceRef });
    if (!read || !read.ok) {
      setError(String((read && read.error) || "INTERNAL_ERROR"));
      return;
    }
    setEditor({ resourceRef, name: info.resource.name, content: read.text, expectedVersion: info.resource.version, resourceType: info.resource.resourceType });
  };

  const saveEditor = async () => {
    if (!editor) return;
    const res = await cmd({ type: "resource/replaceText", resourceRef: editor.resourceRef, content: editor.content, expectedVersion: editor.expectedVersion });
    if (res && res.ok) {
      setEditor(null);
      await afterMutation("已保存为新版本 v" + res.resource.version);
      return;
    }
    if (res && res.error === "VERSION_CONFLICT") {
      const current = Number(res.current || 0);
      setConflict({ resourceRef: editor.resourceRef, draft: editor.content, name: editor.name, currentVersion: current });
      setEditor(null);
      return;
    }
    setError(String((res && res.error) || "INTERNAL_ERROR"));
  };

  const saveAsNew = async () => {
    if (!conflict) return;
    const res = await cmd({ type: "resource/create", resourceType: "text", name: conflict.name + " (副本)", content: conflict.draft });
    if (res && res.ok) {
      setConflict(null);
      await afterMutation("已另存为新资源");
      await select(res.resource.resourceId);
    } else {
      setError(String((res && res.error) || "INTERNAL_ERROR"));
    }
  };

  const confirmPermanentDelete = async (resourceRef: string, name: string) => {
    returnFocus.current = document.activeElement as HTMLElement;
    const res = await cmd({ type: "resource/incomingReferences", resourceRef });
    const references = res && res.ok ? (res.items || []).length : 0;
    setPendingDelete({ resourceRef, name, references });
  };

  const navItems = useMemo(() => NAV, []);
  const currentNav = navItems.find((n) => n.id === category);
  const inTrash = category === "trash";
  const caps = inspector?.capabilities.effective || {};
  const canEdit = !!caps.canEdit;
  const canDelete = inTrash ? !!caps.canDelete : !!caps.canDelete;

  if (!bridge) {
    return (
      <div className="empty-content" data-d3-04b="unavailable">
        <h1>资源库</h1>
        <span className="badge">不可用</span>
        <p>资源存储需要主进程服务。当前环境没有 OpenArc 服务。</p>
      </div>
    );
  }

  return (
    <div className="rl-app" data-d3-04a="resource-library" data-d3-04b="app">
      <nav className="rl-nav" aria-label="资源库导航">
        <div className="rl-nav-section">Categories</div>
        {navItems.map((n) => (
          <button
            key={n.id}
            type="button"
            className={"rl-nav-item" + (category === n.id ? " is-active" : "")}
            data-d3-04b-nav={n.id}
            aria-current={category === n.id ? "page" : undefined}
            onClick={() => {
              setCategory(n.id);
              setFilterCollection(null);
              setFilterTag(null);
              setSelectedId(null);
              setInspector(null);
            }}
          >
            {n.label}
          </button>
        ))}
        <div className="rl-nav-section">
          Collections
          <button type="button" className="rl-nav-add" aria-label="新建 Collection" data-d3-04b-action="new-collection" onClick={() => { returnFocus.current = document.activeElement as HTMLElement; setCollectionOpen(true); }}>
            +
          </button>
        </div>
        <button type="button" className={"rl-nav-item" + (filterCollection === "unfiled" ? " is-active" : "")} data-d3-04b-nav="unfiled" onClick={() => { setFilterCollection("unfiled"); setCategory("all"); }}>
          Unfiled
        </button>
        {collections.map((c) => (
          <button
            key={c.collectionId}
            type="button"
            className={"rl-nav-item" + (filterCollection === c.collectionId ? " is-active" : "")}
            data-d3-04b-nav={"col:" + c.collectionId}
            onClick={() => {
              setFilterCollection(c.collectionId);
              setCategory("all");
            }}
          >
            {c.name} <span className="rl-count">{c.resourceCount}</span>
          </button>
        ))}
        <div className="rl-nav-section">Tags</div>
        <div className="rl-tag-list">
          {tags.map((t) => (
            <button key={t.tagId} type="button" className={"rl-tag" + (filterTag === t.tagId ? " is-active" : "")} data-d3-04b-tag={t.tagId} onClick={() => { setFilterTag(filterTag === t.tagId ? null : t.tagId); setCategory("all"); }}>
              {t.name}
            </button>
          ))}
        </div>
      </nav>

      <section className="rl-content" aria-label="资源列表">
        <div className="rl-toolbar">
          <SearchField value={query} onValueChange={setQuery} placeholder="全文搜索（本地索引，中文可用）" label="全文搜索" />
          <div className="rl-toolbar-actions">
            <Button variant="secondary" size="sm" data-d3-04a-action="import" onClick={doImport}>导入</Button>
            <Button variant="secondary" size="sm" data-d3-04a-action="link" onClick={doLink}>链接文件</Button>
            <Button variant="primary" size="sm" data-d3-04b-action="create" onClick={() => { returnFocus.current = document.activeElement as HTMLElement; setCreateOpen(true); }}>新建</Button>
            <label className="rl-field">
              <span>排序</span>
              <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="排序字段">
                <option value="updated">更新时间</option>
                <option value="created">创建时间</option>
                <option value="name">名称</option>
                <option value="size">大小</option>
              </select>
            </label>
            <Button variant="ghost" size="sm" aria-label="切换排序方向" onClick={() => setDirection(direction === "asc" ? "desc" : "asc")}>{direction === "asc" ? "↑" : "↓"}</Button>
            <div className="rl-viewtoggle" role="group" aria-label="视图切换">
              <button type="button" aria-pressed={view === "grid"} data-d3-04b-view="grid" onClick={() => setView("grid")}>Grid</button>
              <button type="button" aria-pressed={view === "list"} data-d3-04b-view="list" onClick={() => setView("list")}>List</button>
            </div>
          </div>
        </div>

        {error ? <p className="rl-error" data-d3-04b-error role="alert">{error}</p> : null}
        {notice ? <p className="rl-notice" data-d3-04b-notice role="status">{notice}</p> : null}
        {reindexing ? <p className="rl-notice" data-d3-04c-reindex role="status">索引重建：{reindexing.processed} 已处理 / 剩余 {reindexing.remaining}</p> : null}
        {searchMode ? <p className="rl-searchmode" data-d3-04c-search-mode role="status">全文搜索：{total} 条授权结果</p> : null}

        {items.length === 0 && !busy ? (
          <p className="rl-empty" data-d3-04a-empty>{currentNav ? currentNav.empty : "暂无资源。"}</p>
        ) : null}

        <div className={view === "grid" ? "rl-grid" : "rl-list"} data-d3-04b-view-mode={view} role="list" aria-label="资源">
          {items.map((r) => (
            <button
              key={r.resourceId}
              type="button"
              role="listitem"
              className={"rl-card" + (selectedId === r.resourceId ? " is-selected" : "")}
              data-d3-04a-item={r.resourceId}
              data-d3-04b-item={r.resourceId}
              aria-label={r.name + "，" + r.resourceType + "，" + AVAILABILITY_LABEL[r.availability]}
              onClick={() => void select(r.resourceId)}
              onDoubleClick={() => void openEditor(r.resourceRef)}
            >
              <div className="rl-card-top">
                <span className="rl-type">{r.resourceType}</span>
                {r.favorite ? <span className="rl-fav" aria-label="已收藏">★</span> : null}
              </div>
              <div className="rl-card-name">{r.name}</div>
              {r.snippet && r.snippet.matched ? (
                <div className="rl-card-snippet" data-d3-04c-snippet>
                  {r.snippet.spans.map((s, i) => (s.match ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
                  {r.snippet.truncated ? "…" : ""}
                </div>
              ) : null}
              {r.matchedFields && r.matchedFields.length ? <div className="rl-card-fields" data-d3-04c-fields>命中：{r.matchedFields.join(" / ")}</div> : null}
              <div className="rl-card-meta">{r.storageMode} · {r.availability === "AVAILABLE" ? "可用" : AVAILABILITY_LABEL[r.availability]}</div>
              <div className="rl-card-foot">
                <span>{fmtSize(r.size)}</span>
                <span>v{r.version}</span>
              </div>
              <div className="rl-card-ref">{r.resourceRef}</div>
            </button>
          ))}
        </div>

        {hasMore ? (
          <div className="rl-more">
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void reload(offset + 60)}>加载更多（{items.length}/{total}）</Button>
          </div>
        ) : null}
      </section>

      <aside className="rl-inspector" aria-label="资源检查器">
        {!inspector ? (
          <p className="rl-empty">选择一个资源查看详情。</p>
        ) : (
          <div className="rl-inspector-body" data-d3-04b-inspector-ref={inspector.resource.resourceId}>
            <h2 data-d3-04b-inspector-name>{inspector.resource.name}</h2>
            <div className="rl-badges">
              <span className="rl-type">{inspector.resource.resourceType}</span>
              {inspector.resource.memorySubtype ? <span className="rl-type">{inspector.resource.memorySubtype}</span> : null}
              <span className="rl-type">{inspector.resource.storageMode}</span>
              <span className="rl-type">{AVAILABILITY_LABEL[inspector.resource.availability]}</span>
              {inspector.favorite ? <span className="rl-type">★ 收藏</span> : null}
            </div>

            <div className="rl-actions">
              {!inspector.trashed ? (
                <Button variant="ghost" size="sm" data-d3-04b-action="favorite" aria-pressed={inspector.favorite} onClick={async () => { await cmd({ type: "resource/setFavorite", resourceRef: inspector.resource.resourceId, favorite: !inspector.favorite }); await afterMutation(inspector.favorite ? "已取消收藏" : "已收藏"); }}>{inspector.favorite ? "取消收藏" : "收藏"}</Button>
              ) : null}
              {["memory", "text", "code", "prompt"].includes(inspector.resource.resourceType) && !inspector.trashed ? (
                <Button variant="secondary" size="sm" data-d3-04b-action="edit" disabled={!canEdit} onClick={() => void openEditor(inspector.resource.resourceRef)}>编辑内容</Button>
              ) : null}
              {!inspector.trashed ? (
                <Button variant="danger" size="sm" data-d3-04b-action="delete" disabled={!canDelete} onClick={async () => { await cmd({ type: "resource/delete", resourceRef: inspector.resource.resourceId }); await afterMutation("已移入回收站"); }}>删除</Button>
              ) : (
                <>
                  <Button variant="secondary" size="sm" data-d3-04b-action="restore" onClick={async () => { await cmd({ type: "resource/restore", resourceRef: inspector.resource.resourceId }); await afterMutation("已恢复"); }}>恢复</Button>
                  <Button variant="danger" size="sm" data-d3-04b-action="permanent-delete" onClick={() => void confirmPermanentDelete(inspector.resource.resourceId, inspector.resource.name)}>永久删除</Button>
                </>
              )}
            </div>

            <section className="rl-block" aria-label="预览" data-d3-04c-preview={preview ? preview.kind : "none"}>
              <h3>Preview</h3>
              {!preview ? <p className="rl-note">加载中…</p> : preview.kind === "text" ? (
                <pre className="rl-preview-text" data-d3-04c-preview-text>{preview.text}{preview.truncated ? "\n…（已截断）" : ""}</pre>
              ) : preview.kind === "image" && preview.url ? (
                <img className="rl-preview-media" data-d3-04c-preview-image src={preview.thumbnailUrl || preview.url} alt={inspector.resource.name} />
              ) : preview.kind === "video" && preview.url ? (
                <video className="rl-preview-media" data-d3-04c-preview-video controls preload="metadata" src={preview.url} />
              ) : preview.kind === "audio" && preview.url ? (
                <audio data-d3-04c-preview-audio controls src={preview.url} />
              ) : preview.kind === "pdf" && preview.url ? (
                <iframe className="rl-preview-pdf" data-d3-04c-preview-pdf title="PDF Preview" src={preview.url} />
              ) : (
                <p className="rl-note" data-d3-04c-preview-error>{preview.error || preview.availability || "预览不可用"}</p>
              )}
            </section>

            <dl className="rl-meta">
              <div><dt>Description</dt><dd>{(inspector.resource as any).description || "-"}</dd></div>
              <div><dt>MIME</dt><dd>{inspector.resource.mimeType}</dd></div>
              <div><dt>Size</dt><dd>{fmtSize(inspector.resource.size)}</dd></div>
              <div><dt>Owner</dt><dd>{inspector.resource.ownerUserId || "-"}</dd></div>
              <div><dt>Scope</dt><dd>{inspector.resource.scope || "-"}</dd></div>
              <div><dt>Department</dt><dd>{inspector.resource.departmentId || "-"}</dd></div>
              <div><dt>Collection</dt><dd>{inspector.collection ? inspector.collection.name : "Unfiled"}</dd></div>
              <div><dt>Version</dt><dd>v{inspector.resource.version}</dd></div>
              <div><dt>Created</dt><dd>{fmtTime(inspector.resource.createdAt)}</dd></div>
              <div><dt>Updated</dt><dd>{fmtTime(inspector.resource.updatedAt)}</dd></div>
              <div><dt>Storage Device</dt><dd>{inspector.resource.storageDeviceId || "-"}</dd></div>
              <div><dt>Source Type</dt><dd>{inspector.resource.source ? inspector.resource.source.label : "-"}</dd></div>
              {inspector.provenance.generatedSourceModel ? <div><dt>Model</dt><dd>{inspector.provenance.generatedSourceModel}</dd></div> : null}
            </dl>

            <section className="rl-block" aria-label="标签">
              <h3>标签</h3>
              <div className="rl-tag-list">
                {inspector.tags.map((t) => (
                  <span key={t.tagId} className="rl-tag">
                    {t.name}
                    {!inspector.trashed && canEdit ? <button type="button" aria-label={"移除标签 " + t.name} onClick={async () => { await cmd({ type: "resource/removeTag", resourceRef: inspector.resource.resourceId, tagId: t.tagId }); await afterMutation("已移除标签"); }}>×</button> : null}
                  </span>
                ))}
              </div>
              {!inspector.trashed && canEdit ? (
                <form className="rl-inline" onSubmit={async (e) => { e.preventDefault(); const input = e.currentTarget.elements.namedItem("tag") as HTMLInputElement; const name = input.value; if (!name.trim()) return; await cmd({ type: "resource/assignTag", resourceRef: inspector.resource.resourceId, name }); input.value = ""; await afterMutation("已添加标签"); }}>
                  <input name="tag" data-d3-04b-tag-input placeholder="添加标签" aria-label="添加标签" />
                  <Button size="sm" type="submit" data-d3-04b-tag-add>添加</Button>
                </form>
              ) : null}
            </section>

            <section className="rl-block" aria-label="Collection 归属">
              <h3>Collection</h3>
              {!inspector.trashed && canEdit ? (
                <select
                  data-d3-04b-collection
                  aria-label="移动到 Collection"
                  value={inspector.collection ? inspector.collection.collectionId : ""}
                  onChange={async (e) => { await cmd({ type: "resource/setCollection", resourceRef: inspector.resource.resourceId, collectionId: e.target.value || null }); await afterMutation("已移动 Collection"); }}
                >
                  <option value="">Unfiled</option>
                  {collections.map((c) => <option key={c.collectionId} value={c.collectionId}>{c.name}</option>)}
                </select>
              ) : (
                <p>{inspector.collection ? inspector.collection.name : "Unfiled"}</p>
              )}
              {inspector.collection && inspector.collection.editable ? (
                <div className="rl-inline">
                  <Button variant="ghost" size="sm" data-d3-04b-action="rename-collection" onClick={async () => { const name = window.prompt("重命名 Collection", inspector.collection!.name); if (name) { await cmd({ type: "resource/updateCollection", collectionId: inspector.collection!.collectionId, name }); await afterMutation("Collection 已重命名"); } }}>重命名</Button>
                  <Button variant="danger" size="sm" data-d3-04b-action="delete-collection" onClick={async () => { const res = await cmd({ type: "resource/deleteCollection", collectionId: inspector.collection!.collectionId }); await afterMutation(res && res.ok ? "Collection 已删除，资源转入 Unfiled（" + res.movedToUnfiled + "）" : "删除失败"); }}>删除 Collection</Button>
                </div>
              ) : null}
            </section>

            <section className="rl-block" aria-label="权限">
              <h3>权限</h3>
              <p className="rl-cap" data-d3-04b-cap="canRead">Can Read: {String(!!caps.canRead)}</p>
              <p className="rl-cap" data-d3-04b-cap="canEdit">Can Edit: {String(!!caps.canEdit)}</p>
              <p className="rl-cap" data-d3-04b-cap="canDelete">Can Delete: {String(!!caps.canDelete)}</p>
              <p className="rl-cap" data-d3-04b-cap="canManageAccess">Can Manage Access: {String(!!caps.canManageAccess)}</p>
              <p className="rl-cap" data-d3-04b-cap="canUseByAgent">Can Use by Agent: {String(!!caps.canUseByAgent)}</p>
              <p className="rl-cap-note">当前 App（resource-library）与 User 的能力交集；App 无权限时操作同样被拒。</p>
            </section>

            {inspector.versions.length > 0 ? (
              <section className="rl-block" aria-label="版本历史">
                <h3>Versions</h3>
                <ul className="rl-versions">
                  {inspector.versions.slice().reverse().map((v) => (
                    <li key={v.version}>
                      <span>v{v.version}</span>
                      <span>{fmtSize(v.size)}</span>
                      <span>{fmtTime(v.createdAt)}</span>
                      {!inspector.trashed && canEdit && v.version !== inspector.resource.version ? (
                        <Button size="sm" variant="ghost" data-d3-04b-restore-version={v.version} onClick={async () => { await cmd({ type: "resource/restoreVersion", resourceRef: inspector.resource.resourceId, version: v.version, expectedVersion: inspector.resource.version }); await afterMutation("已恢复为 v" + (inspector.resource.version + 1)); }}>恢复</Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section className="rl-block" aria-label="引用关系">
              <h3>Relations</h3>
              <p>引用：{inspector.relations.incoming} incoming · {inspector.relations.outgoing} outgoing</p>
            </section>

            <section className="rl-block" aria-label="索引">
              <h3>Index</h3>
              <p className="rl-cap" data-d3-04c-index-status>Index Status: {indexStatus ? indexStatus.indexStatus + (indexStatus.stale ? "（STALE）" : "") : "-"}</p>
              <p className="rl-cap" data-d3-04c-index-version>Indexed Version: {indexStatus && indexStatus.documentVersion != null ? "v" + indexStatus.documentVersion : "-"} / Resource Version: {indexStatus && indexStatus.resourceVersion != null ? "v" + indexStatus.resourceVersion : "-"}</p>
              <div className="rl-inline">
                <Button variant="secondary" size="sm" data-d3-04c-action="reindex" disabled={!!reindexing} onClick={() => void cmd({ type: "resource/reindex", resourceRef: inspector.resource.resourceId }).then(() => { void loadIndexStatus(inspector.resource.resourceId); void reload(0); })}>重新索引</Button>
                <Button variant="ghost" size="sm" data-d3-04c-action="rebuild-index" disabled={!!reindexing} onClick={() => void rebuildIndex()}>重建全部索引</Button>
              </div>
              <p className="rl-cap-note">索引是派生数据；Authorization 每次搜索实时检查，不依赖索引。</p>
            </section>
          </div>
        )}
      </aside>

      <Dialog open={createOpen} title="新建资源" onClose={() => setCreateOpen(false)} returnFocusTo={returnFocus.current} footer={<Button variant="primary" data-d3-04b-action="create-submit" onClick={async () => { const form = document.querySelector<HTMLFormElement>("#rl-create-form"); if (!form) return; const data = new FormData(form); const res = await cmd({ type: "resource/create", resourceType: data.get("type"), name: data.get("name"), content: data.get("content"), memorySubtype: data.get("memorySubtype") || null, collectionId: data.get("collectionId") || null, tags: String(data.get("tags") || "").split(",").map((s) => s.trim()).filter(Boolean) }); if (res && res.ok) { setCreateOpen(false); await afterMutation("已创建资源"); await select(res.resource.resourceId); } else setError(String((res && res.error) || "INTERNAL_ERROR")); }}>创建</Button>}>
        <form id="rl-create-form" className="rl-form">
          <label>类型
            <select name="type" defaultValue="memory" data-d3-04b-create-type>
              {CREATE_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>
          <label>名称<input name="name" data-d3-04b-create-name required defaultValue="" /></label>
          <label>Memory 类型
            <select name="memorySubtype" data-d3-04b-create-subtype defaultValue="personal-preference">
              {MEMORY_SUBTYPES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <label>Collection
            <select name="collectionId" defaultValue="">
              <option value="">Unfiled</option>
              {collections.map((c) => <option key={c.collectionId} value={c.collectionId}>{c.name}</option>)}
            </select>
          </label>
          <label>标签（逗号分隔）<input name="tags" defaultValue="" /></label>
          <label>内容<textarea name="content" data-d3-04b-create-content rows={6} defaultValue="" /></label>
        </form>
      </Dialog>

      <Dialog open={collectionOpen} title="新建 Collection" onClose={() => setCollectionOpen(false)} returnFocusTo={returnFocus.current} footer={<Button variant="primary" data-d3-04b-action="collection-submit" onClick={async () => { const el = document.querySelector<HTMLInputElement>("#rl-collection-name"); const name = el ? el.value : ""; const res = await cmd({ type: "resource/createCollection", name }); if (res && res.ok) { setCollectionOpen(false); await afterMutation("Collection 已创建"); } else setError(String((res && res.error) || "INTERNAL_ERROR")); }}>创建</Button>}>
        <label className="rl-form">名称<input id="rl-collection-name" data-d3-04b-collection-name defaultValue="" /></label>
      </Dialog>

      <Dialog open={!!editor} title="编辑内容" onClose={() => setEditor(null)} returnFocusTo={returnFocus.current} footer={<Button variant="primary" data-d3-04b-save onClick={() => void saveEditor()}>保存</Button>}>
        {editor ? (
          <div className="rl-form">
            <p className="rl-note">{editor.name} · v{editor.expectedVersion} · 保存会形成新版本</p>
            <textarea data-d3-04b-editor rows={14} value={editor.content} onChange={(e) => setEditor({ ...editor, content: e.target.value })} />
          </div>
        ) : null}
      </Dialog>

      <Dialog open={!!conflict} title="版本冲突" onClose={() => setConflict(null)} returnFocusTo={returnFocus.current} footer={<div className="rl-inline"><Button variant="secondary" data-d3-04b-conflict-reload onClick={async () => { if (!conflict) return; await select(conflict.resourceRef); setConflict(null); }}>重新加载</Button><Button variant="primary" data-d3-04b-conflict-saveas onClick={() => void saveAsNew()}>另存为新资源</Button></div>}>
        <p data-d3-04b-conflict>资源已被其他操作更新（当前 v{conflict ? conflict.currentVersion : "?"}）。你的草稿不会覆盖它。</p>
      </Dialog>

      <Dialog open={!!pendingDelete} title="永久删除" onClose={() => setPendingDelete(null)} returnFocusTo={returnFocus.current} footer={<div className="rl-inline"><Button variant="secondary" onClick={() => setPendingDelete(null)}>取消</Button><Button variant="danger" data-d3-04b-permanent-confirm onClick={async () => { if (!pendingDelete) return; const res = await cmd({ type: "resource/permanentDelete", resourceRef: pendingDelete.resourceRef }); setPendingDelete(null); await afterMutation(res && res.ok ? "已永久删除" : "删除失败"); }}>永久删除</Button></div>}>
        <p>不可恢复。{pendingDelete && pendingDelete.references > 0 ? "被 " + pendingDelete.references + " 个对象引用。" : "没有对象引用它。"}</p>
      </Dialog>
    </div>
  );
}
