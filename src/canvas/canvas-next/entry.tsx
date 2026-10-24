/**
 * 桌面版接入点：和旧的 ReactCanvasApp 同样的 props，换入口时只改 import。
 *
 *   import { NextCanvasApp as ReactCanvasApp } from "../canvas-next/entry";
 *
 * 画布 id 来自窗口（win.canvasId / win.meta.canvasId）或 ?canvas=；都没有时显示画布列表。
 * 宿主能力优先用 props，其次用旧版约定的 window.__openarc* 钩子。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeCanvasId } from "../react-canvas/reactCanvasStore";
import { saveDoc } from "../react-canvas/persistence";
import { createBridgeBackend } from "./backend/bridge";
import { CanvasApp } from "./CanvasApp";
import { newNode } from "./model";
import type { HostActions } from "./ui/ctx";
import { shellDark } from "./ui/theme";
import { Icon, Logo } from "./ui/Icon";
import "./ui/canvas-next.css";

/** 开发模式下把画布状态挂到 window.__cn，便于端到端测试读取；打包版不挂 */
const exposeForDev = typeof location !== "undefined" && /^http:\/\/(127\.0\.0\.1|localhost):/.test(location.origin) ? (s: unknown) => { (window as unknown as { __cn: unknown }).__cn = s; } : undefined;

type Win = { canvasId?: unknown; meta?: Record<string, unknown> } | undefined;
type Props = {
  win?: unknown;
  /** 当前登录用户的显示名（Agent 问候、头像首字、评论署名） */
  userName?: string;
  /** 入口页打开其它应用窗口（应用市场 / Skill 中心）：由外壳注入，宿主没有就不显示这两个入口 */
  onOpenApp?: (appId: string) => void;
  onOpenMcpCenter?: () => void; onOpenModelSettings?: () => void; onOpenSettings?: () => void; onBackToWorkspace?: () => void;
};
type Entry = { id: string; name: string; updatedAt?: number; nodes?: number };

const hook = <T,>(name: string): T | undefined => { const f = (window as unknown as Record<string, unknown>)[name]; return typeof f === "function" ? (f as T) : undefined; };
const cmd = () => { const c = (window as unknown as { openarc?: { canvas?: { command?: (r: Record<string, unknown>) => Promise<Record<string, any>> } } }).openarc?.canvas?.command; return typeof c === "function" ? c : null; };

async function listCanvases(): Promise<Entry[]> {
  const c = cmd(); if (!c) return [];
  const res = await c({ type: "canvas/list" }).catch(() => null);
  const raw = res && res.ok ? (Array.isArray(res.items) ? res.items : Array.isArray(res.canvases) ? res.canvases : []) : [];
  return raw.map((r: Record<string, unknown>) => ({ id: normalizeCanvasId(String(r.canvasId ?? r.id ?? "")), name: String(r.title ?? r.name ?? "未命名画布"), updatedAt: Number(r.updatedAt || 0) })).filter((e: Entry) => e.id !== "default");
}

function fromWin(win: unknown): Entry | null {
  const w = win as Win; const id = w?.canvasId ?? w?.meta?.canvasId;
  if (typeof id === "string" && id.trim()) return { id: normalizeCanvasId(id), name: typeof w?.meta?.title === "string" && w.meta.title ? w.meta.title : "画布" };
  const q = new URLSearchParams(location.search).get("canvas");
  return q ? { id: normalizeCanvasId(q), name: "画布" } : null;
}

export function NextCanvasApp(props: Props) {
  // 只按「画布 id + 标题」判断窗口指定的画布有没有变：外壳每次重绘都会给新的 win 对象，
  // 不能因此把当前画布重置（在窗口里从列表打开的画布 win 不带 id，旧写法会被打回列表）。
  const fx = fromWin(props.win); const fixedKey = fx ? fx.id + "\u0000" + fx.name : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fixed = useMemo(() => fx, [fixedKey]);
  const [active, setActive] = useState<Entry | null>(fixed);
  useEffect(() => { if (fixed) setActive(fixed); }, [fixed]);
  const backend = useMemo(() => createBridgeBackend(), []);
  // 外壳传进来的回调每次渲染都是新函数：经 ref 取最新的，host 本身保持稳定（host 变了画布会整个重建、丢掉进行中的生成）
  const latest = useRef(props); latest.current = props;
  const host: HostActions = useMemo(() => {
    const ms = latest.current.onOpenModelSettings || hook<() => void>("__openarcOpenModelSettings");
    const mcp = latest.current.onOpenMcpCenter || hook<() => void>("__openarcOpenMcpCenter");
    return {
      // 返回 = 回到画布列表（和旧版一样在同一个窗口里切画布）；关窗口交给窗口自己的红绿灯
      backToList: () => setActive(null),
      ...(ms ? { openModelSettings: () => (latest.current.onOpenModelSettings || hook<() => void>("__openarcOpenModelSettings"))?.() } : {}),
      ...(mcp ? { openMcpCenter: () => (latest.current.onOpenMcpCenter || hook<() => void>("__openarcOpenMcpCenter"))?.() } : {}),
      openShare: hook("__openarcOpenShare"),
      openCanvas: (id: string) => setActive({ id, name: "画布" }),
      listCanvases: async () => (await listCanvases()).map((e) => ({ id: e.id, name: e.name })),
      ...(props.userName ? { user: { name: props.userName, initial: Array.from(props.userName)[0].toUpperCase() } } : {}),
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.userName]);
  if (!active) return <CanvasList onOpen={setActive} onOpenApp={props.onOpenApp} winInset={props.win ? 84 : undefined} />;
  return <CanvasApp key={active.id} backend={backend} canvasId={active.id} name={active.name} host={host} winInset={props.win ? 84 : undefined} onReady={exposeForDev} />;
}

/** 跟外壳的深浅色：外壳切外观只改 .desktop 的 class，不会重传 props，所以列表页自己订阅 */
function useShellDark() {
  const [dark, setDark] = useState(shellDark);
  useEffect(() => {
    const sync = () => setDark(shellDark());
    const shell = document.querySelector(".desktop");
    const mo = shell ? new MutationObserver(sync) : null;
    if (shell) mo?.observe(shell, { attributes: true, attributeFilter: ["class"] });
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener?.("change", sync);
    return () => { mo?.disconnect(); mq.removeEventListener?.("change", sync); };
  }, []);
  return dark;
}

/** 创作入口页签：只有「画布」可用；片场 / 剪辑本轮没实现，如实禁用并标「未开放」，不做假入口 */
const ENTRIES = [
  { id: "canvas", label: "画布", hint: "想做一张什么样的图？", placeholder: "例如：给一款白色运动水壶做三张电商主图", on: true },
  { id: "stage", label: "片场", hint: "想搭一个什么样的世界？", placeholder: "", on: false },
  { id: "engine", label: "剪辑", hint: "想把素材剪成什么样？", placeholder: "", on: false },
] as const;

const whenOf = (ts?: number) => (ts ? new Date(ts).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

/** 描述太长时按字数截断做画布名（不切在半个字上：Array.from 按码点切） */
function titleOf(text: string) {
  const chars = Array.from(text);
  return chars.length > 24 ? chars.slice(0, 24).join("") + "…" : text;
}

/** 没指定画布时的入口页（Launch Pad）：左侧最近画布 + 中央一句话创作 + 顶部入口页签 */
function CanvasList({ onOpen, onOpenApp, winInset }: { onOpen: (e: Entry) => void; onOpenApp?: (appId: string) => void; winInset?: number }) {
  const [list, setList] = useState<Entry[] | null>(null); const [err, setErr] = useState("");
  const [entry, setEntry] = useState<"canvas" | "stage" | "engine">("canvas");
  const [desc, setDesc] = useState(""); const [busy, setBusy] = useState(false);
  const dark = useShellDark();
  const cur = ENTRIES.find((e) => e.id === entry) || ENTRIES[0];
  useEffect(() => { void listCanvases().then(setList).catch(() => setList([])); }, []);
  const create = async () => {
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const text = desc.trim(); const title = text ? titleOf(text) : "未命名画布";
      const c = cmd(); let id = normalizeCanvasId("c" + Date.now().toString(36));
      if (c) {
        const res = await c({ type: "canvas/create", title }).catch(() => null);
        if (!res || !res.ok) { setErr("新建失败（" + String(res?.error || "UNKNOWN") + "）"); return; }
        id = normalizeCanvasId(String(res.canvasId || res.canvas?.id || res.canvas?.canvasId || res.id || id));
      }
      // 描述写成首个文本节点（内容与提示词都落上，进画布就看得到自己那句话）；写失败不挡进入，如实提示
      if (text) {
        try {
          const node = newNode("text", 0, 0, { title: "创作说明", prompt: text, hist: [{ text, meta: { at: Date.now() } }] });
          const saved = await saveDoc(id, { nodes: [node], edges: [], comments: [] }, null);
          if (!saved.ok) setErr("描述已留在本机，但没能同步到画布：" + String(saved.error || "保存失败"));
        } catch (e) { setErr("描述写入失败：" + (e instanceof Error ? e.message : "未知错误")); }
      }
      onOpen({ id, name: title });
    } finally { setBusy(false); }
  };
  const recent = (list || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 8);
  // 窗口里左上角要给系统红绿灯让位：外壳传 winInset，这里写成 CSS 变量给顶部条用
  const rootStyle = winInset ? ({ "--win-inset": winInset + "px" } as unknown as import("react").CSSProperties) : undefined;
  return <div className="cn-root lp" data-theme={dark ? "dark" : "light"} style={rootStyle}>
    <header className="lp-top">
      <div className="lp-brand"><Logo /><b>画布</b></div>
      <nav className="lp-tabs" role="tablist" aria-label="创作入口">
        {ENTRIES.map((e) => <button key={e.id} role="tab" aria-selected={entry === e.id} disabled={!e.on}
          className={"lp-tab" + (entry === e.id ? " on" : "")}
          title={e.on ? e.hint : e.label + "暂未开放"}
          onClick={() => { if (e.on) setEntry(e.id); }}>
          {e.label}{e.on ? null : <span className="lp-soon">未开放</span>}
        </button>)}
      </nav>
      <div className="lp-apps">
        {onOpenApp ? <>
          <button className="lp-app" onClick={() => onOpenApp("market")}><Icon name="grid" size="s" />应用市场</button>
          <button className="lp-app" onClick={() => onOpenApp("skills")}><Icon name="sparkle" size="s" />Skill 中心</button>
        </> : null}
      </div>
    </header>
    <div className="lp-body">
      <aside className="lp-side">
        <div className="lp-side-h">最近用过</div>
        <button className="lp-new" onClick={() => void create()} disabled={busy}><Icon name="plus" size="s" />新建画布</button>
        <div className="lp-recent">
          {recent.map((e) => <button key={e.id} className="lp-recent-i" onClick={() => onOpen(e)} title={e.name}>
            <span className="n">{e.name}</span><span className="t">{whenOf(e.updatedAt)}</span>
          </button>)}
          {list && !recent.length ? <p className="lp-side-empty">还没有画布</p> : null}
        </div>
      </aside>
      <main className="lp-main">
        <div className="lp-hero">
          <h1>{cur.hint}</h1>
          <p className="lp-sub">用一句话说清楚要做什么，进来就是一个带说明的画布。</p>
          <div className="lp-pad">
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} disabled={busy}
              placeholder={cur.on ? cur.placeholder : "这个入口暂未开放"}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void create(); } }} />
            <div className="lp-pad-foot">
              <span className="lp-hint">⌘↵ 直接开始</span>
              <span className="sp" />
              <button className="btn solid lp-go" onClick={() => void create()} disabled={busy}>{busy ? "正在创建…" : "开始制作"}</button>
            </div>
          </div>
          {err ? <div className="gp-warn lp-err"><Icon name="alert" size="s" /><span>{err}</span></div> : null}
        </div>
        <section className="lp-all">
          <div className="lp-all-h"><span>全部画布</span><span className="sp" /><span className="n">{list ? list.length + " 张" : ""}</span></div>
          <div className="cn-grid">{(list || []).map((e) => <button key={e.id} className="cn-card" onClick={() => onOpen(e)}><span className="pv"><Icon name="layers" /></span><b>{e.name}</b><small>{whenOf(e.updatedAt)}</small></button>)}</div>
          {list && !list.length ? <p className="lp-empty">还没有画布，上面写一句就能开始。</p> : null}
        </section>
      </main>
    </div>
  </div>;
}
