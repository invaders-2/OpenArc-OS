/**
 * 素材抽屉里的「资源库 / 我的资产库 / 团队资产库」。
 *   资源库      canvas/libraryList：OpenArc 资源库里画布可引用的图片（含生成结果），点一下放到画布
 *   资产库      canvas/assetLibrary/list + get：个人（PRIVATE）与团队共享的资产库；图片 / 视频放成素材节点，提示词放成文本节点
 *   上传        canvas/assetLibrary/import 存进当前资产库（团队库即对团队成员可见）
 * 节点右键「存入资产库」也走 import（见 saveNodeToLibrary）。
 */
import { useEffect, useMemo, useState } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { replaceNodeMedia } from "../actions";
import { genOf, outOf, uid, type GenKind } from "../model";
import { useCtl, type Ctl } from "./ctx";
import { Icon } from "./Icon";
import { openPop } from "./overlay";
import { useAssetUrl } from "./useAsset";

type Lib = { id: string; name: string; visibility?: string; access?: string; itemCount?: number };
type Item = { id: string; kind?: string; title?: string; prompt?: string; mediaKind?: string; media?: { kind?: string; mime?: string }; coverRef?: string; resourceRef?: string; previewUrl?: string; url?: string };
type Res = { ref: string; name?: string; mimeType?: string; thumbnail?: string };
type Cmd = (r: Record<string, unknown>) => Promise<Record<string, any>>;

const cmdOf = (): Cmd | null => { const c = (window as unknown as { openarc?: { canvas?: { command?: Cmd } } }).openarc?.canvas?.command; return typeof c === "function" ? c : null; };
const isPersonal = (l: Lib) => l.access === "owner" && String(l.visibility || "").toUpperCase() === "PRIVATE";
const refOf = (it: Item) => { const r = it.resourceRef || it.coverRef || it.url || it.previewUrl || ""; return r && !/^(openarc-asset:|data:|https?:)/.test(r) ? "openarc-asset:" + r.replace(/^openarc-resource:/, "") : r; };
const mediaOf = (it: Item): "image" | "video" | "audio" | null => { const k = String(it.mediaKind || it.media?.kind || it.kind || ""); if (it.kind === "prompt") return null; return /video/.test(k) ? "video" : /audio/.test(k) ? "audio" : /image|asset|character|scene|prop|style/.test(k) || refOf(it) ? "image" : null; };

function place(ctl: Ctl, kind: GenKind, title: string, out: { url?: string; text?: string; w?: number; h?: number }) {
  const store = ctl.store;
  // 替换模式：素材库点一个素材 → 替换目标节点的当前版本（不新增节点）
  const target = store.state.ui.replace;
  if (target && store.node(target) && out.url) { replaceNodeMedia(store, target, { url: out.url, w: out.w, h: out.h }); store.setUI({ replace: null }); return; }
  const c = ctl.center();
  const n = store.newNode(kind, c.x - 120, c.y - 120, { title, uploaded: kind !== "text", manual: kind === "text", hist: [out] });
  store.addNodes([n], [], { select: true }); store.toast("已放到画布中央");
}

export function LibrarySection({ q }: { q: string }) {
  const ctl = useCtl(); const store = ctl.store;
  const [tab, setTab] = useState<"res" | "mine" | "team">("res");
  const [libs, setLibs] = useState<Lib[] | null>(null); const [items, setItems] = useState<Item[]>([]); const [res, setRes] = useState<Res[]>([]);
  const [libId, setLibId] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [tick, setTick] = useState(0);
  const cmd = cmdOf();
  useEffect(() => { if (!cmd) return; void cmd({ type: "canvas/assetLibrary/list" }).then((r) => setLibs(r && r.ok ? (r.libraries || []) : [])).catch(() => setLibs([])); }, [cmd, tick]);
  const pool = useMemo(() => (libs || []).filter((l) => (tab === "team" ? !isPersonal(l) : isPersonal(l))), [libs, tab]);
  useEffect(() => { if (tab !== "res" && pool.length && !pool.some((l) => l.id === libId)) setLibId(pool[0].id); }, [pool, tab, libId]);
  useEffect(() => {
    if (!cmd) return; setErr("");
    if (tab === "res") { setBusy(true); void cmd({ type: "canvas/libraryList", limit: 60, query: q }).then((r) => setRes(r && r.ok ? (r.items || []) : [])).catch(() => setErr("读取资源库失败")).finally(() => setBusy(false)); return; }
    if (!libId) { setItems([]); return; }
    setBusy(true); void cmd({ type: "canvas/assetLibrary/get", libraryId: libId }).then((r) => { if (!r || !r.ok) throw new Error(String(r?.error || "")); setItems(r.items || []); }).catch(() => setErr("读取资产库失败")).finally(() => setBusy(false));
  }, [cmd, tab, libId, q, tick]);
  if (!cmd) return <div className="sec"><span>资源库</span><span className="lg-dim">桌面版可用</span></div>;
  const shown = tab === "res" ? [] : items.filter((it) => !q || [it.title, it.prompt].join(" ").includes(q));
  const upload = () => {
    if (!libId) return store.toast("先选一个资产库");
    const fi = document.createElement("input"); fi.type = "file"; fi.accept = "image/*,video/*,audio/*"; fi.multiple = true;
    fi.onchange = async () => {
      for (const f of [...(fi.files || [])]) {
        const dataUrl = await new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result || "")); r.onerror = () => no(new Error("读取失败")); r.readAsDataURL(f); });
        const r = await cmd({ type: "canvas/assetLibrary/import", libraryId: libId, name: f.name, mime: f.type || "image/png", dataUrl }).catch(() => null);
        if (!r || !r.ok) { store.toast("上传失败：" + String(r?.error || "未知错误")); break; }
      }
      setTick((t) => t + 1); store.toast("已存入资产库");
    };
    fi.click();
  };
  return <>
    <div className="sec"><span>资源库</span>{busy ? <i className="spn" /> : null}</div>
    <div className="tabs lib-tabs">{([["res", "资源库"], ["mine", "我的资产库"], ["team", "团队资产库"]] as const).map(([k, l]) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}</div>
    {tab !== "res" ? <div className="lib-bar">
      {pool.length > 1 ? <button className="pill" onClick={(e) => openPop(e.currentTarget, (close) => <>{pool.map((l) => <button key={l.id} className={"mi" + (l.id === libId ? " on" : "")} onClick={() => { close(); setLibId(l.id); }}>{l.name}<span className="k tnum">{l.itemCount ?? ""}</span></button>)}</>)}>{pool.find((l) => l.id === libId)?.name || "选择资产库"}<Icon name="down" size="xs" /></button> : <span className="lg-dim">{pool[0]?.name || (tab === "team" ? "还没有加入团队资产库" : "还没有个人资产库")}</span>}
      <span className="grow" />{libId ? <button className="pill" onClick={upload}><Icon name="upload" size="xs" />上传</button> : null}
      {tab === "mine" && !pool.length ? <button className="pill" onClick={() => void cmd({ type: "canvas/assetLibrary/ensure" }).then(() => setTick((t) => t + 1))}>创建</button> : null}
    </div> : null}
    {err ? <div className="lg-dim" style={{ padding: "4px 0" }}>{err}</div> : null}
    {tab === "res" ? <div className="agrid">{res.map((r) => <ResTile key={r.ref} r={r} onUse={() => place(ctl, /video/.test(r.mimeType || "") ? "video" : "image", r.name || "素材", { url: r.ref })} />)}{!res.length && !busy ? <span className="lg-dim" style={{ gridColumn: "1/-1" }}>资源库里还没有可用的图片</span> : null}</div>
      : <div className="agrid">{shown.map((it) => <ItemTile key={it.id} it={it} onUse={() => { const m = mediaOf(it); if (m) place(ctl, m, it.title || "素材", { url: refOf(it) }); else place(ctl, "text", it.title || "提示词", { text: it.prompt || it.title || "" }); }} />)}{!shown.length && !busy ? <span className="lg-dim" style={{ gridColumn: "1/-1" }}>这个资产库是空的</span> : null}</div>}
  </>;
}
function ResTile({ r, onUse }: { r: Res; onUse: () => void }) { return <div className="a" title={r.name} onClick={onUse}>{r.thumbnail ? <img src={r.thumbnail} alt="" /> : <Icon name="image" />}</div>; }
function ItemTile({ it, onUse }: { it: Item; onUse: () => void }) {
  const m = mediaOf(it); const url = useAssetUrl(m === "image" ? (it.previewUrl && it.previewUrl.startsWith("data:") ? it.previewUrl : refOf(it)) : "");
  return <div className={"a" + (m ? "" : " txt")} title={it.title || ""} onClick={onUse}>{url ? <img src={url} alt="" /> : m === "video" ? <Icon name="video" /> : m === "audio" ? <Icon name="audio" /> : <span className="atext"><Icon name="text" size="xs" />{it.title || "提示词"}</span>}</div>;
}

/** 节点右键「存入资产库」：图片 / 视频 / 音频结果，或文本节点的内容（存成提示词） */
export async function saveNodeToLibrary(ctl: Ctl, n: CanvasNode, anchor: { x: number; y: number }) {
  const cmd = cmdOf(); const store = ctl.store; if (!cmd) return store.toast("资产库只在桌面版里可用");
  const r = await cmd({ type: "canvas/assetLibrary/list" }).catch(() => null); const libs: Lib[] = r && r.ok ? r.libraries || [] : [];
  if (!libs.length) { const e = await cmd({ type: "canvas/assetLibrary/ensure" }).catch(() => null); if (e && e.ok && e.library) libs.push(e.library); }
  const save = async (lib: Lib) => {
    const g = genOf(n); const o = outOf(n);
    if (n.kind === "text") { const x = await cmd({ type: "canvas/assetLibrary/upsert", libraryId: lib.id, item: { kind: "prompt", title: g.title, prompt: o?.text || g.prompt } }).catch(() => null); return store.toast(x && x.ok ? `已存入「${lib.name}」` : "存入失败：" + String(x?.error || "")); }
    if (!o?.url) return store.toast("这个节点还没有结果");
    const dataUrl = o.url.startsWith("data:") ? o.url : await store.backend.resolveAsset(o.url);
    if (!dataUrl || !dataUrl.startsWith("data:")) return store.toast("读取素材失败");
    const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1] || "image/png";
    const x = await cmd({ type: "canvas/assetLibrary/import", libraryId: lib.id, name: g.title + "." + (mime.split("/")[1] || "png"), title: g.title, mime, dataUrl }).catch(() => null);
    store.toast(x && x.ok ? `已存入「${lib.name}」${isPersonal(lib) ? "" : "，团队成员都能用"}` : "存入失败：" + String(x?.error || ""));
  };
  if (libs.length === 1) return save(libs[0]);
  openPop(anchor, (close) => <><div className="mh">存入哪个资产库</div>{libs.map((l) => <button key={l.id} className="mi" onClick={() => { close(); void save(l); }}><Icon name={isPersonal(l) ? "user" : "layers"} size="s" />{l.name}<span className="k">{isPersonal(l) ? "个人" : "团队"}</span></button>)}</>);
}
export { uid };
