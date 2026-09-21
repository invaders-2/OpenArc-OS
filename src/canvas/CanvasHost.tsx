/**
 * D5-02 Full-App · NOVAI 完整应用宿主（OpenArc 应用窗口内容）。
 *
 * 结构（PLAN §22 + §6.1）：**入口就是上游原版 index.html（AI Studio 外壳：首页 + 左侧导航 + 子页 iframe）**，
 * 由 openarc-canvas:// 只读协议原样服务整棵 static/；OpenArc 只在最外层加一条窗口条：
 * 当前项目与 revision、画布选择、只读标记、模型来源、更新/下载已禁用说明与提示区。
 *
 * 边界（页面扩大后**仍然成立**，不因接入首页而放宽）：
 *   · 应用页面在 sandbox="allow-scripts allow-same-origin" 的 iframe 里：origin 是
 *     openarc-canvas://bundle，与 OpenArc 外壳（file://）**不同源**，页面拿不到 window.openarc / IPC / fs / 凭据；
 *   · 宿主**只接受当前这一个外壳实例**的消息：event.source 必须是本帧，且必须带本次挂载的随机 token
 *     （子页的调用由外壳中继附加 token，子页自己拿不到 token）；
 *   · 账号作用域：入口 URL 的 #oa= 钥匙按"账号 + 本次挂载"生成，页面 localStorage/BroadcastChannel
 *     一律按该钥匙分桶（内存实现，不落盘）；切账号时窗口整体重建，旧页面与旧通道随之失效；
 *   · 每次生成 = 一个 Task（预算/停止/审计归属）：模型调用只能经 canvas/modelChat|modelImage；
 *   · 本地导入图片进**资源库**，画布文档只存 openarc-asset:<ResourceRef>。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Window as WinDomain } from "../../electron/window-domain.cjs";

type Rpc = {
  ch: string; dir: string; kind: string; id?: number | string; token?: string; method?: string;
  params?: Record<string, unknown>; frame?: string | null; state?: any; url?: string;
  message?: string; event?: string; ok?: boolean; value?: any; error?: any; reason?: string;
};

const CH = "openarc.canvas";
/** 入口 = 完整应用外壳（首页 + 导航 + 子页）；画布编辑器是它里面的 iframe。*/
const IFRAME_BASE = "openarc-canvas://bundle/index.html";
const ASSET_PREFIX = "openarc-asset:";
const randomToken = () => "t_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
/** 不透明账号钥匙：账号 + 本次挂载，页面只拿它做作用域分桶，不含任何凭据。*/
function keyOf(seed: string) {
  let h = 5381;
  for (let i = 0; i < seed.length; i += 1) h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  return "k" + h.toString(36) + Math.random().toString(36).slice(2, 6);
}

type CanvasListItem = { canvasId: string; title: string; icon: string; updatedAt: number; createdAt?: number; kind?: string; access?: { canEdit: boolean; source: string }; boardX?: number | null; boardY?: number | null; nodes?: number; edges?: number };

export function CanvasHost({ win }: { win: WinDomain }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [items, setItems] = useState<CanvasListItem[]>([]);
  const [frameKey, setFrameKey] = useState(0);
  const [frameSrc, setFrameSrc] = useState<string>("");
  const [current, setCurrent] = useState<{ canvasId: string; title: string; revision: number; updatedAt: number; canEdit: boolean } | null>(null);
  const [status, setStatus] = useState("初始化…");
  const [notice, setNotice] = useState<string>("");
  const [modelInfo, setModelInfo] = useState<{ chat: number; image: number } | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [blockedNav, setBlockedNav] = useState(0);
  /** 应用帧最后一次心跳（看门狗用）：被非预期导航/崩溃打断时整帧重置，绝不留在错误页上。*/
  const lastBeat = useRef(Date.now());

  /** 本次挂载的实例 token：只有带它的宿主消息才被接受（重挂载后旧实例立即失效）。*/
  const instanceToken = useRef(randomToken());
  /** data URL ⇄ 稳定 ResourceRef 的双向映射（文档里只存 ref）。*/
  const refByDataUrl = useRef(new Map<string, string>());
  const dataUrlByRef = useRef(new Map<string, string>());
  /** 画布任务 id → 生成运行（停止/迟到结果都按 run 判定）。*/
  const runByTask = useRef(new Map<string, { runId: string; promise: Promise<Record<string, unknown>> }>());
  const labelToConfig = useRef(new Map<string, string>());
  const currentRef = useRef<typeof current>(null);
  currentRef.current = current;
  /** 画布卡片位置：会话内记忆（宿主不建第二套项目模型；刷新后由上游自动布局）。*/
  const boardPos = useRef(new Map<string, { x: number; y: number }>());
  /** 宿主 → 画布子页的请求（命令/撤销/状态），按 id 等回包。*/
  const shellPending = useRef(new Map<number, (v: any) => void>());
  const shellSeq = useRef(0);

  const canvasCmd = useCallback(async (payload: Record<string, unknown>): Promise<any> => {
    const bridge = (window as any).openarc?.canvas;
    if (!bridge) return { ok: false, error: "NO_BRIDGE" };
    try { return await bridge.command(payload); } catch { return { ok: false, error: "INTERNAL_ERROR" }; }
  }, []);
  const modelCmd = useCallback(async (payload: Record<string, unknown>): Promise<any> => {
    const bridge = (window as any).openarc?.model;
    if (!bridge) return { ok: false, error: "NO_BRIDGE" };
    try { return await bridge.command(payload); } catch { return { ok: false, error: "INTERNAL_ERROR" }; }
  }, []);
  const taskCmd = useCallback(async (payload: Record<string, unknown>): Promise<any> => {
    const bridge = (window as any).openarc?.task;
    if (!bridge) return { ok: false, error: "NO_BRIDGE" };
    try { return await bridge.command(payload); } catch { return { ok: false, error: "INTERNAL_ERROR" }; }
  }, []);

  const buildConfig = useCallback(async () => {
    const res = await modelCmd({ type: "canvas/models" });
    const models: any[] = res && res.ok && Array.isArray(res.models) ? res.models : [];
    const defaults = (res && res.defaults) || { personal: {}, organization: {} };
    const usable = (cap: string) => models.filter((m) => m.status === "enabled" && Array.isArray(m.capabilities) && m.capabilities.includes(cap));
    const label = (m: any) => String(m.displayName || m.remoteModelId || m.configId) + " · " + String(m.configId).slice(-4);
    labelToConfig.current = new Map(models.map((m) => [label(m), m.configId] as [string, string]));
    const chat = usable("chat");
    const image = usable("image-generation");
    setModelInfo({ chat: chat.length, image: image.length });
    const pick = (cap: string, list: any[]) => {
      const def = defaults.personal?.[cap] || defaults.organization?.[cap] || null;
      const found = list.find((m) => m.configId === def);
      return found ? label(found) : (list[0] ? label(list[0]) : "");
    };
    return {
      chat_models: chat.map(label),
      image_models: image.map(label),
      video_models: [], ms_chat_models: [], comfy_instances: [], api_providers: [],
      image_model: pick("image-generation", image),
      chat_model: pick("chat", chat),
      chat_capability: chat.length > 0,
      image_capability: image.length > 0,
      unsupported: { "video-generation": "OpenArc 模型服务当前没有视频传输", comfy: "ComfyUI 不在 OpenArc 集成范围内" },
    };
  }, [modelCmd]);

  const listItem = useCallback((c: any): CanvasListItem => {
    const pos = boardPos.current.get(String(c.canvasId)) || null;
    return {
      canvasId: String(c.canvasId), title: String(c.title || ""), icon: String(c.icon || "🧩"),
      updatedAt: Number(c.updatedAt || 0), createdAt: Number(c.createdAt || 0), kind: String(c.kind || "classic"),
      access: c.access || null, boardX: pos ? pos.x : null, boardY: pos ? pos.y : null,
      nodes: (c.doc && c.doc.nodes ? c.doc.nodes.length : 0), edges: (c.doc && c.doc.connections ? c.doc.connections.length : 0),
    };
  }, []);

  const refreshList = useCallback(async () => {
    const res = await canvasCmd({ type: "canvas/list" });
    if (!res || !res.ok) { setStatus("读取画布列表失败：" + String(res && res.error)); return; }
    setItems((res.items || []).map(listItem));
  }, [canvasCmd, listItem]);

  /** 上游画布清单载荷（字段名与上游一致，不二次发明）。*/
  const upstreamCanvas = useCallback((c: any, docOverride?: any) => {
    const doc = docOverride || c.doc || { nodes: [], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] };
    const pos = boardPos.current.get(String(c.canvasId)) || null;
    return {
      id: c.canvasId, title: c.title, icon: c.icon || "🧩", kind: c.kind || "classic", project: "default",
      nodes: doc.nodes || [], connections: doc.connections || [],
      viewport: doc.viewport || { x: 0, y: 0, scale: 1 }, logs: doc.logs || [],
      updated_at: Number(c.updatedAt || 0), created_at: Number(c.createdAt || 0), revision: Number(c.revision || 1),
      node_count: (doc.nodes || []).length, connection_count: (doc.connections || []).length,
      board_x: pos ? pos.x : null, board_y: pos ? pos.y : null,
      access: c.access || null,
    };
  }, []);

  /** 把文档里的稳定 ref 解析成可显示的数据（只读、逐资源授权）；解析失败保留 ref（画布显示不可用）。*/
  const resolveRefs = useCallback(async (doc: any) => {
    const refs: string[] = [];
    for (const n of (doc && doc.nodes) || []) {
      const u = typeof n.url === "string" ? n.url : "";
      if (u.startsWith(ASSET_PREFIX) && !dataUrlByRef.current.has(u.slice(ASSET_PREFIX.length))) refs.push(u.slice(ASSET_PREFIX.length));
    }
    for (const ref of refs.slice(0, 20)) {
      const res = await canvasCmd({ type: "canvas/readAsset", ref });
      if (res && res.ok && res.dataUrl) {
        dataUrlByRef.current.set(ref, res.dataUrl);
        refByDataUrl.current.set(res.dataUrl, ASSET_PREFIX + ref);
      }
    }
    for (const n of (doc && doc.nodes) || []) {
      const u = typeof n.url === "string" ? n.url : "";
      if (u.startsWith(ASSET_PREFIX)) {
        const resolved = dataUrlByRef.current.get(u.slice(ASSET_PREFIX.length));
        if (resolved) n.url = resolved;
      }
    }
    return doc;
  }, [canvasCmd]);

  /** 保存回写：显示用的 data URL 换回稳定 ref（旧 data URL 原样保留，不静默丢图）。*/
  const refsBack = useCallback((doc: any) => {
    for (const n of (doc && doc.nodes) || []) {
      const u = typeof n.url === "string" ? n.url : "";
      const ref = u ? refByDataUrl.current.get(u) : null;
      if (ref) n.url = ref;
    }
    return doc;
  }, []);

  const bindCanvas = useCallback(async (canvasId: string, title?: string) => {
    const res = await canvasCmd({ type: "canvas/get", canvasId });
    if (!res || !res.ok) { setStatus("打开画布失败：" + String(res && res.error)); return null; }
    const c = res.canvas;
    const next = { canvasId: c.canvasId, title: title || c.title, revision: Number(c.revision || 1), updatedAt: Number(c.updatedAt || 0), canEdit: !!c.access?.canEdit };
    setCurrent(next);
    setStatus("已打开 " + next.title + "（revision " + next.revision + "）");
    return next;
  }, [canvasCmd]);

  /** 宿主 → 画布子页（经外壳中继）：只发受限的几种消息。*/
  const toShell = useCallback(async (msg: Record<string, unknown>, wait = false): Promise<any> => {
    const frameWin = frameRef.current?.contentWindow;
    if (!frameWin) return { ok: false, error: "NO_FRAME" };
    if (!wait) { frameWin.postMessage({ ch: CH, dir: "host->canvas", ...msg }, "*"); return { ok: true }; }
    shellSeq.current += 1;
    const id = shellSeq.current;
    return await new Promise((resolve) => {
      const timer = setTimeout(() => { shellPending.current.delete(id); resolve({ ok: false, error: "SHELL_TIMEOUT" }); }, 15000);
      shellPending.current.set(id, (v) => { clearTimeout(timer); resolve(v); });
      frameWin.postMessage({ ch: CH, dir: "host->canvas", ...msg, id }, "*");
    });
  }, []);

  const pushContext = useCallback(async (c: { canEdit: boolean; canvasId: string } | null) => {
    await toShell({ kind: "context", canEdit: c ? c.canEdit : false, readOnly: c ? !c.canEdit : true, canvasId: c ? c.canvasId : null });
  }, [toShell]);

  const refreshListAndOpen = useCallback(async (canvasId: string) => {
    await refreshList();
    const next = await bindCanvas(canvasId);
    if (next) { await pushContext(next); await toShell({ kind: "open-canvas", canvasId }); }
  }, [bindCanvas, pushContext, refreshList, toShell]);

  const createCanvas = useCallback(async () => {
    const title = "画布 " + new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    const res = await canvasCmd({ type: "canvas/create", title, icon: "🧩", kind: "classic" });
    if (!res || !res.ok) { setNotice("创建画布失败：" + String(res && res.error)); return; }
    await refreshList();
    const next = await bindCanvas(res.canvas.canvasId);
    if (next) { await pushContext(next); await toShell({ kind: "open-canvas", canvasId: next.canvasId }); }
  }, [bindCanvas, canvasCmd, pushContext, refreshList, toShell]);

  /** 宿主 RPC：应用页面的每一条请求都在这里被翻译成受控命令。*/
  const handleCall = useCallback(async (method: string, params: Record<string, any>): Promise<any> => {
    const cur = currentRef.current;
    const canvasId = (cur && cur.canvasId) || null;
    switch (method) {
      // —— 应用外壳 ——
      case "app.info":
        return {
          name: "AI Studio · OpenArc", version: "1.0.117-openarc", repo_url: null, version_url: "", tree_url: "",
          sources: {}, update_disabled: true,
          openarc: { updateDisabled: true, reason: "OpenArc 不检查、不下载、不安装上游程序（更新/下载已禁用）" },
        };
      case "app.changelog":
        return { items: [] };
      case "app.queue": {
        const list = await taskCmd({ type: "task/list" });
        const running = list && list.ok && Array.isArray(list.items) ? list.items.filter((t: any) => String(t.status) === "RUNNING").length : 0;
        return { total: running, position: 0, running, source: "openarc-task-runtime" };
      }
      // —— 首页 ——
      case "canvas.recent": {
        const res = await canvasCmd({ type: "canvas/list" });
        if (!res || !res.ok) return [];
        return (res.items || []).slice(0, 12).map((c: any) => ({ id: c.canvasId, title: c.title, icon: c.icon, kind: c.kind, updated_at: Number(c.updatedAt || 0), created_at: Number(c.createdAt || 0), thumbnail: "" }));
      }
      case "project.list":
        return { projects: [{ id: "default", name: "默认画布", order: 0, canvas_count: items.length }] };
      case "canvas.list":
        return { canvases: items.map((c) => ({ ...upstreamCanvas({ canvasId: c.canvasId, title: c.title, icon: c.icon, kind: c.kind, updatedAt: c.updatedAt, createdAt: c.createdAt, access: c.access, doc: { nodes: new Array(c.nodes || 0), connections: new Array(c.edges || 0) } }), nodes: [], connections: [] })) };
      case "canvas.trashList": {
        const res = await canvasCmd({ type: "canvas/list", includeTrashed: true });
        const trashed = res && res.ok ? (res.items || []).filter((c: any) => c.trashed) : [];
        return { canvases: trashed.map((c: any) => upstreamCanvas(c)) };
      }
      case "canvas.workflows": return { workflows: [] };
      case "canvas.create": {
        const res = await canvasCmd({ type: "canvas/create", title: params.title, icon: params.icon, kind: params.kind });
        if (!res.ok) return { __status: 502, body: { error: res.error } };
        if (params.boardX != null && params.boardY != null) boardPos.current.set(String(res.canvas.canvasId), { x: Number(params.boardX) || 0, y: Number(params.boardY) || 0 });
        await refreshList();
        setCurrent({ canvasId: res.canvas.canvasId, title: res.canvas.title, revision: res.canvas.revision, updatedAt: Number(res.canvas.updatedAt || 0), canEdit: true });
        await pushContext({ canvasId: res.canvas.canvasId, canEdit: true });
        return { canvas: upstreamCanvas(res.canvas) };
      }
      case "canvas.get": {
        const res = await canvasCmd({ type: "canvas/get", canvasId: params.canvasId });
        if (!res.ok) return { __status: 404, body: { error: res.error } };
        setCurrent({ canvasId: res.canvas.canvasId, title: res.canvas.title, revision: res.canvas.revision, updatedAt: Number(res.canvas.updatedAt || 0), canEdit: !!res.canvas.access?.canEdit });
        const doc = await resolveRefs(res.canvas.doc);
        return { canvas: upstreamCanvas(res.canvas, doc) };
      }
      case "canvas.meta": {
        const body = (params.body || {}) as any;
        if (params.httpMethod === "PUT" && body && (body.board_x != null || body.board_y != null)) {
          boardPos.current.set(String(params.canvasId), { x: Number(body.board_x) || 0, y: Number(body.board_y) || 0 });
        }
        const meta = await canvasCmd({ type: "canvas/meta", canvasId: params.canvasId });
        if (!meta || !meta.ok) return { __status: 404, body: { error: (meta && meta.error) || "NOT_FOUND" } };
        if (body && (body.title != null || body.icon != null)) {
          const r = await canvasCmd({ type: "canvas/save", canvasId: params.canvasId, baseRevision: cur ? cur.revision : null, doc: null, title: body.title, icon: body.icon });
          if (r.ok) { await refreshList(); return { canvas: upstreamCanvas(r.canvas) }; }
          return { __status: 502, body: { error: r.error } };
        }
        return Object.assign({}, meta.meta, { canvas: upstreamCanvas({ canvasId: params.canvasId, title: meta.meta.title, icon: meta.meta.icon, kind: meta.meta.kind, updatedAt: meta.meta.updatedAt, revision: meta.meta.revision, access: meta.meta.access }) });
      }
      case "canvas.save": {
        const body = (params.body || {}) as any;
        const target = String(params.canvasId || canvasId || "");
        const base = cur && Number(body.base_updated_at || 0) === Number(cur.updatedAt) ? cur.revision : -1;
        const res = await canvasCmd({
          type: "canvas/save", canvasId: target, baseRevision: base,
          doc: refsBack({ nodes: body.nodes || [], connections: body.connections || [], viewport: body.viewport || { x: 0, y: 0, scale: 1 }, logs: body.logs || [] }),
          title: body.title, icon: body.icon,
        });
        if (!res.ok && res.error === "REVISION_CONFLICT") {
          const c = (res.detail && res.detail.canvas) || null;
          setStatus("版本冲突：已在别处修改，保留双方内容");
          return { __conflict: true, detail: { canvas: c ? upstreamCanvas(c) : null, updated_at: c ? c.updatedAt : 0 } };
        }
        if (!res.ok) { setStatus("保存失败：" + String(res.error)); return { __status: 502, body: { error: res.error } }; }
        setCurrent({ canvasId: res.canvas.canvasId, title: res.canvas.title, revision: res.canvas.revision, updatedAt: Number(res.canvas.updatedAt || 0), canEdit: !!res.canvas.access?.canEdit });
        setStatus("已保存（revision " + res.canvas.revision + "）");
        return { canvas: upstreamCanvas(res.canvas) };
      }
      case "canvas.trash": { const r = await canvasCmd({ type: "canvas/trash", canvasId: params.canvasId }); await refreshList(); return r.ok ? { canvas: upstreamCanvas(r.canvas) } : { __status: 502, body: { error: r.error } }; }
      case "canvas.restore": { const r = await canvasCmd({ type: "canvas/restore", canvasId: params.canvasId }); await refreshList(); return r.ok ? { canvas: upstreamCanvas(r.canvas) } : { __status: 502, body: { error: r.error } }; }
      case "canvas.purge": { const r = await canvasCmd({ type: "canvas/purge", canvasId: params.canvasId }); await refreshList(); return r; }
      case "canvas.touch": return { ok: true };
      case "canvas.assetStates": {
        const urls: string[] = Array.isArray((params.body || {}).urls) ? (params.body as any).urls : [];
        const refs = urls.filter((u) => u.startsWith(ASSET_PREFIX)).map((u) => u.slice(ASSET_PREFIX.length));
        const exists: Record<string, boolean> = {};
        if (!refs.length) return { exists };
        const res = await canvasCmd({ type: "canvas/assetStates", refs });
        const states = (res && res.exists) || {};
        urls.forEach((u) => { exists[u] = u.startsWith(ASSET_PREFIX) ? !!(states[u.slice(ASSET_PREFIX.length)] && states[u.slice(ASSET_PREFIX.length)].state === "AVAILABLE") : true; });
        return { exists };
      }
      case "canvas.upload": {
        // 桥在页面里把文件读成 data URL 再送过来（不把 File 对象丢过 postMessage）；这里只做有界导入。
        const incoming: any[] = Array.isArray((params as any).files) ? (params as any).files : [];
        const out: any[] = [];
        for (const f of incoming.slice(0, 8)) {
          const dataUrl = String((f && f.dataUrl) || "");
          const name = String((f && f.name) || "upload");
          if (!dataUrl.startsWith("data:")) { setNotice("未导入（不是受支持的文件）：" + name); continue; }
          const res = await canvasCmd({ type: "canvas/importAsset", canvasId, name, dataUrl });
          if (!res || !res.ok || !res.ref) { setNotice("导入资源库失败（" + String((res && res.error) || "UNKNOWN") + "）：" + name + " 未写入画布"); continue; }
          dataUrlByRef.current.set(String(res.ref).slice(ASSET_PREFIX.length), dataUrl);
          refByDataUrl.current.set(dataUrl, res.ref);
          out.push({ url: dataUrl, name, kind: String((f && f.type) || "").startsWith("video") ? "video" : "image" });
        }
        return { files: out };
      }
      // —— 模型（唯一入口，每次调用重新授权 + 任务级预算/停止/版本判定）——
      case "model.config": return await buildConfig();
      case "model.chat": {
        const body = (params.body || {}) as any;
        if (!canvasId) return { __status: 502, body: { error: "CANVAS_NOT_OPEN" } };
        const run = await canvasCmd({ type: "canvas/run", canvasId, kind: "chat", nodeId: body.nodeId || null });
        if (!run || !run.ok) { setNotice("无法开始生成：" + String((run && run.error) || "UNKNOWN")); return { __status: 502, body: { error: (run && run.error) || "RUN_FAILED" } }; }
        const system = String(body.system_prompt || "You are a helpful assistant.");
        const history = Array.isArray(body.messages) ? body.messages : [];
        const messages = [{ role: "system", content: system }]
          .concat(history.slice(-20).map((m: any) => ({ role: m && m.role === "assistant" ? "assistant" : "user", content: String((m && m.content) || "") })))
          .concat([{ role: "user", content: String(body.message || "") }]);
        const res = await canvasCmd({
          type: "canvas/modelChat", canvasId, runId: run.runId, messages,
          configId: labelToConfig.current.get(String(body.model || "")) || null,
        });
        const ok = !!(res && res.ok);
        await canvasCmd({ type: "canvas/runFinish", canvasId, runId: run.runId, status: ok ? "DONE" : "FAILED" });
        if (!ok) {
          const code = String((res && res.error) || "MODEL_ERROR");
          setNotice("模型调用失败：" + explain(code));
          return { __status: 502, body: { error: code, message: explain(code) } };
        }
        return { text: String(res.text || ""), model: String(body.model || ""), requestId: res.requestId || null, usage: res.usage || null };
      }
      case "model.imageTask": {
        const body = (params.body || {}) as any;
        if (!canvasId) return { __status: 502, body: { error: "CANVAS_NOT_OPEN" } };
        const run = await canvasCmd({ type: "canvas/run", canvasId, kind: "image", nodeId: body.nodeId || null });
        if (!run || !run.ok) { setNotice("无法开始生成：" + String((run && run.error) || "UNKNOWN")); return { __status: 502, body: { error: (run && run.error) || "RUN_FAILED" } }; }
        const taskId = "oa_img_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const promise = (async () => {
          const res = await canvasCmd({
            type: "canvas/modelImage", canvasId, runId: run.runId, prompt: String(body.prompt || ""),
            size: body.size || null, count: Number(body.count) || 1,
            configId: labelToConfig.current.get(String(body.model || "")) || null,
          });
          const ok = !!(res && res.ok);
          await canvasCmd({ type: "canvas/runFinish", canvasId, runId: run.runId, status: ok ? "DONE" : "FAILED" });
          if (!ok) { const code = String((res && res.error) || "MODEL_ERROR"); setNotice("图片生成失败：" + explain(code)); return { ok: false, error: explain(code), code }; }
          return { ok: true, images: (res.images || []).map((i: any) => i.dataUrl || i.url).filter(Boolean) };
        })();
        runByTask.current.set(taskId, { runId: run.runId, promise });
        return { task_id: taskId, status: "pending" };
      }
      case "model.imageTaskResult": {
        const entry = runByTask.current.get(String(params.taskId));
        if (!entry) return { status: "failed", error: "任务不存在（宿主已重启）" };
        const r = await entry.promise;
        if (!r.ok) return { status: "failed", error: String(r.error) };
        return { status: "succeeded", result: { images: r.images, task_id: params.taskId, provider: "openarc" } };
      }
      case "model.queryTask": {
        const entry = runByTask.current.get(String((params.body || {}).task_id));
        if (!entry) return { status: "failed", error: "任务不存在" };
        const r = await entry.promise;
        return r.ok ? { status: "succeeded", result: { images: r.images } } : { status: "failed", error: String(r.error) };
      }
      case "run.stop": {
        if (!canvasId || !params.runId) return { ok: false, error: "RUN_NOT_FOUND" };
        const res = await canvasCmd({ type: "canvas/runStop", canvasId, runId: params.runId, reason: "USER_STOP" });
        setNotice("已停止生成（后续请求不会再发出）");
        return res || { ok: false };
      }
      default: return { __status: 501, body: { error: "OPENARC_UNSUPPORTED", message: "不在 OpenArc 集成范围内的能力：" + method } };
    }
  }, [buildConfig, canvasCmd, items, pushContext, refreshList, resolveRefs, refsBack, taskCmd, upstreamCanvas]);

  // 应用页面的请求 → 受控命令 → 回包（**只接受当前外壳实例**；子页由外壳中继附加 token）
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const d = event.data as Rpc;
      if (!d || d.ch !== CH || d.dir !== "canvas->host") return;
      const frameWin = frameRef.current?.contentWindow;
      if (!frameWin || event.source !== frameWin) return;                       // 其他 iframe / 其他窗口一律忽略
      const relayed = typeof d.id === "string" && /^f\d+:\d+$/.test(d.id);       // 子页调用（外壳中继）
      if (d.kind !== "hello-request" && d.kind !== "notice" && d.kind !== "alive" && d.token !== instanceToken.current) return; // 旧实例 / 伪造 token 一律忽略
      lastBeat.current = Date.now();
      if (d.kind === "alive") return;
      if (d.kind === "hello-request") {
        setFrameReady(true);
        const cur = currentRef.current;
        frameWin.postMessage({
          ch: CH, dir: "host->canvas", kind: "hello", token: instanceToken.current,
          canEdit: cur ? cur.canEdit : false, readOnly: cur ? !cur.canEdit : true, canvasId: cur ? cur.canvasId : null,
          account: "openarc", accountKey: (frameSrc.split("#oa=")[1] || null),
        }, "*");
        return;
      }
      if (d.kind === "context-request") {
        const cur = currentRef.current;
        frameWin.postMessage({ ch: CH, dir: "host->canvas", kind: "context", canEdit: cur ? cur.canEdit : false, readOnly: cur ? !cur.canEdit : true, canvasId: cur ? cur.canvasId : null, accountKey: (frameSrc.split("#oa=")[1] || null) }, "*");
        return;
      }
      if (d.kind === "notice") { if (d.message) setNotice(String(d.message)); return; }
      if (d.kind === "frame" && d.event === "reset") return;
      if (d.kind === "blocked") { setNotice("只读画布：没有编辑权限（手工与 AI 修改都会被同一条权限规则拒绝）"); return; }
      if (d.kind === "frame") {
        if (d.event === "canvas-closed") { setStatus("已回到应用页面"); }
        return;
      }
      if (d.kind === "adapter-ready" || d.kind === "adapter-timeout") {
        setStatus(d.kind === "adapter-ready" ? "画布就绪" : "画布适配器未就绪");
        const st = (d.state || {}) as any;
        const id = st.canvasId ? String(st.canvasId) : null;
        if (d.kind === "adapter-ready" && id && (!currentRef.current || currentRef.current.canvasId !== id)) {
          void (async () => {
            const next = await bindCanvas(id);
            if (next) await pushContext(next);
          })();
        }
        return;
      }
      if ((d.kind === "command-result" || d.kind === "state") && typeof d.id === "number") {
        const resolve = shellPending.current.get(d.id);
        if (resolve) { shellPending.current.delete(d.id); resolve(d); }
        return;
      }
      if (d.kind === "call" && (typeof d.id === "number" || relayed) && d.method) {
        void handleCall(d.method, (d.params || {}) as Record<string, any>).then((value) => {
          frameWin.postMessage({ ch: CH, dir: "host->canvas", kind: "result", id: d.id, ok: true, value }, "*");
        }).catch((err) => {
          frameWin.postMessage({ ch: CH, dir: "host->canvas", kind: "result", id: d.id, ok: false, error: { error: "HOST_ERROR", message: String((err && err.message) || err) } }, "*");
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [bindCanvas, frameSrc, handleCall, pushContext]);

  // 应用帧看门狗：正常情况下外壳中继每 800ms 发一次心跳。若连续 8s 没有任何消息，
  // 说明该帧被非预期导航/崩溃打断（例如页面自我导航到外部站点被 CSP/宿主拦下后停在错误页）——
  // 这里整帧重置到 bundle 入口（新 token），保证用户不会卡在错误页上，也保证旧页面立即失效。
  useEffect(() => {
    const timer = setInterval(() => {
      const frameWin = frameRef.current?.contentWindow;
      if (!frameWin || !frameSrc) return;
      if (Date.now() - lastBeat.current < 8000) return;
      lastBeat.current = Date.now();
      instanceToken.current = randomToken();
      setFrameReady(false);
      setNotice("应用页面被非预期导航/崩溃中断，已重置（旧页面与旧实例 token 立即失效）");
      void (async () => {
        let seed = "anon";
        try {
          const st: any = await (window as any).openarc?.identity?.command({ type: "identity/status" });
          const s = st?.snapshot;
          if (s && s.userId) seed = String(s.userId) + ":" + String(s.sessionRef || "");
        } catch { /* ignore */ }
        setFrameSrc(IFRAME_BASE + "#oa=" + keyOf(seed + ":" + instanceToken.current));
        setFrameKey((k) => k + 1);
      })();
    }, 3000);
    return () => clearInterval(timer);
  }, [frameSrc]);

  // 主进程拦截的应用内导航出网（宿主级证据的 UI 面）
  useEffect(() => {
    const off = (window as any).openarc?.onNativeState?.((e: any) => {
      if (String(e?.type || "") !== "canvas-navigation-blocked") return;
      setBlockedNav((n) => n + 1);
      setNotice("已拦截应用内导航出网：" + String(e?.url || "").slice(0, 120));
    });
    return () => { try { off?.(); } catch { /* ignore */ } };
  }, []);

  // 账号作用域钥匙：账号 + 本次挂载；窗口重挂载（含切账号）后旧钥匙立即失效。
  useEffect(() => {
    void (async () => {
      let seed = "anon";
      try {
        const st: any = await (window as any).openarc?.identity?.command({ type: "identity/status" });
        const s = st?.snapshot;
        if (s && s.userId) seed = String(s.userId) + ":" + String(s.sessionRef || "") + ":" + String(s.sessionId || "");
      } catch { /* 未登录/不可用就用 anon */ }
      const key = keyOf(seed + ":" + instanceToken.current);
      setFrameSrc(IFRAME_BASE + "#oa=" + key);
    })();
  }, []);

  // 首次：列表 + 模型投影
  useEffect(() => {
    void (async () => {
      await refreshList();
      await buildConfig();
      setStatus("应用已就绪（首页）");
    })();
  }, [buildConfig, refreshList]);

  // 状态栏轮询：当前画布 revision 跟着 OpenArc 存储走；同时做**引用资源可用性复核**
  // （删除 / 撤权之后，宿主的显示缓存必须失效，不能继续拿旧 data URL 顶替 —— 缺项 3）。
  useEffect(() => {
    const timer = setInterval(() => {
      const cur = currentRef.current;
      if (!cur) return;
      void (async () => {
        const res = await canvasCmd({ type: "canvas/meta", canvasId: cur.canvasId });
        if (res && res.ok && res.meta) {
          const rev = Number(res.meta.revision || 1);
          if (rev !== cur.revision || Number(res.meta.updatedAt || 0) !== cur.updatedAt) {
            setCurrent({ ...cur, revision: rev, updatedAt: Number(res.meta.updatedAt || 0), canEdit: !!res.meta.access?.canEdit, title: res.meta.title || cur.title });
          }
        }
        const refs = Array.from(dataUrlByRef.current.keys());
        if (!refs.length) return;
        const st = await canvasCmd({ type: "canvas/assetStates", refs });
        const exists = (st && st.exists) || {};
        const dead = refs.filter((r) => !(exists[r] && exists[r].state === "AVAILABLE"));
        if (!dead.length) return;
        for (const r of dead) {
          const url = dataUrlByRef.current.get(r);
          if (url) refByDataUrl.current.delete(url);
          dataUrlByRef.current.delete(r);
        }
        setNotice("引用资源已删除或无权限（" + dead.length + " 个）：画布上按不可用显示，不会拿旧缓存顶替");
        const got = await canvasCmd({ type: "canvas/get", canvasId: cur.canvasId });
        if (!got || !got.ok) return;
        const doc = await resolveRefs(got.canvas.doc);
        await toShell({ kind: "reload-doc", doc, updatedAt: Number(got.canvas.updatedAt || 0), title: got.canvas.title }, true);
      })();
    }, 2500);
    return () => clearInterval(timer);
  }, [canvasCmd, resolveRefs, toShell]);

  const openHome = useCallback(async () => {
    await toShell({ kind: "command", command: "__noop__" }); // 保持协议单向形状：不新增宿主→页面任意消息
  }, [toShell]);

  return (
    <div className="canvas-host" data-canvas-host={win.id} data-canvas-app="novai-full" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="canvas-host-bar" data-canvas-bar style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: "1px solid var(--line)", flexShrink: 0, flexWrap: "wrap" }}>
        <strong data-canvas-title>{current ? current.title : "AI Studio（完整应用）"}</strong>
        <span className="muted" data-canvas-revision>{current ? "revision " + current.revision : "未打开画布"}</span>
        <select
          aria-label="选择画布"
          data-canvas-picker
          value={current ? current.canvasId : ""}
          onChange={(e) => { const id = e.target.value; if (id) void refreshListAndOpen(id); }}
          style={{ maxWidth: 220 }}
        >
          <option value="">选择画布…</option>
          {items.map((c) => <option key={c.canvasId} value={c.canvasId}>{c.title}</option>)}
        </select>
        <button type="button" data-canvas-create onClick={() => void createCanvas()}>新建画布</button>
        <button type="button" data-canvas-home onClick={() => { setFrameKey((k) => k + 1); setStatus("已回到首页"); }}>回到首页</button>
        <span className="muted" data-canvas-status>{status}</span>
        {current && !current.canEdit ? <span data-canvas-readonly style={{ color: "var(--failed)" }}>只读（无编辑权限）</span> : null}
        <span className="muted" data-canvas-update-disabled title="OpenArc 不检查、不下载、不安装上游程序">更新/下载：已禁用</span>
        <span className="muted" data-canvas-models style={{ marginLeft: "auto" }}>
          {modelInfo ? "模型：文本 " + modelInfo.chat + " / 图片 " + modelInfo.image : "模型：读取中…"}
        </span>
        {blockedNav > 0 ? <span data-canvas-nav-blocked style={{ color: "var(--failed)" }}>已拦截导航出网 {blockedNav} 次</span> : null}
      </div>
      {notice ? (
        <div data-canvas-notice style={{ padding: "4px 10px", fontSize: 12, color: "var(--failed)", borderBottom: "1px solid var(--line)" }}>
          {notice} <button type="button" className="ghost" onClick={() => setNotice("")}>关闭</button>
        </div>
      ) : null}
      {frameSrc ? (
        <iframe
          key={frameKey}
          ref={frameRef}
          title="NOVAI AI Studio（OpenArc 集成）"
          data-canvas-frame
          data-canvas-app-frame
          data-frame-ready={frameReady ? "1" : "0"}
          sandbox="allow-scripts allow-same-origin"
          src={frameSrc}
          style={{ flex: 1, minHeight: 0, width: "100%", border: "0", background: "var(--bg)" }}
        />
      ) : (
        <div data-canvas-frame-pending style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)" }}>
          正在准备应用…
        </div>
      )}
    </div>
  );
}

function explain(code: string) {
  if (code === "CAPABILITY_UNAVAILABLE") return "该模型没有这项能力（OpenArc 不会用文本接口顶替）";
  if (code === "MODEL_CONFIG_UNAVAILABLE") return "没有可用的模型配置（请在 设置 → 模型 里配置）";
  if (code === "CREDENTIAL_MISSING") return "该模型缺少凭据";
  if (code === "PROXY_UNAUTHORIZED") return "没有权限使用该模型（应用授权已被撤销或未授予）";
  if (code === "BUDGET_EXHAUSTED") return "本次生成的任务预算已用尽";
  if (code === "TASK_CANCELLED" || code === "RUN_STOPPED") return "生成已停止";
  if (code === "CANVAS_CHANGED") return "画布在生成期间已被修改，结果未写入（保留你的内容）";
  return code;
}
