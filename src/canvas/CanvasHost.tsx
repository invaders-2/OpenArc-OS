/**
 * D5-02 · 无限画布宿主（OpenArc 应用窗口内容）。
 *
 * 结构（PLAN §22）：左侧资源 / 中央画布 / 右侧属性 / 底部缩放 —— 全部由**上游画布本身**提供，
 * 这里只加一层 OpenArc 外壳：项目与状态、只读标记、模型状态提示，以及 sandbox iframe。
 *
 * 边界（Closure 加强）：
 *   · 画布页面在 sandbox="allow-scripts" 的 iframe 里（opaque origin）：没有 openarc 桥、没有 IPC、
 *     没有文件系统、没有凭据；它只能通过 postMessage 请求宿主；
 *   · 宿主**只接受当前这一个画布实例**的消息：\`event.source\` 必须是本帧，且必须带本次挂载的随机 token
 *     （旧实例 / 其他 iframe 无法冒用）；
 *   · 每次生成 = 一个 Task（预算/停止/审计归属）：模型调用只能经 \`canvas/modelChat|modelImage\`，
 *     停止经 \`canvas/runStop\`；停止或画布被改动后的迟到结果一律不返回给画布；
 *   · 本地导入图片进**资源库**，画布文档只存 \`openarc-asset:<ResourceRef>\`；老文档里的 data URL 原样兼容。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Window as WinDomain } from "../../electron/window-domain.cjs";

type Rpc = { ch: string; dir: string; kind: string; id?: number; token?: string; method?: string; params?: Record<string, unknown> };

const CH = "openarc.canvas";
/** 上游编辑器页只认 ?id：宿主先决定打开哪个画布，再把 id 交给它（不附带任何凭据）。*/
const IFRAME_BASE = "openarc-canvas://bundle/index.html";
const frameSrcFor = (canvasId: string) => IFRAME_BASE + "?id=" + encodeURIComponent(canvasId);
const ASSET_PREFIX = "openarc-asset:";
const randomToken = () => "t_" + Math.random().toString(36).slice(2) + Date.now().toString(36);

type CanvasListItem = { canvasId: string; title: string; icon: string; updatedAt: number; kind?: string; access?: { canEdit: boolean; source: string } };

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

  /** 本次挂载的实例 token：只有带它的消息才被接受（重挂载后旧实例立即失效）。*/
  const instanceToken = useRef(randomToken());
  /** data URL ⇄ 稳定 ResourceRef 的双向映射（文档里只存 ref）。*/
  const refByDataUrl = useRef(new Map<string, string>());
  const dataUrlByRef = useRef(new Map<string, string>());
  /** 画布任务 id → 生成运行（停止/迟到结果都按 run 判定）。*/
  const runByTask = useRef(new Map<string, { runId: string; promise: Promise<Record<string, unknown>> }>());
  const labelToConfig = useRef(new Map<string, string>());
  const currentRef = useRef<typeof current>(null);
  currentRef.current = current;

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
      unsupported: { "video-generation": "OpenArc 模型服务当前没有视频传输", comfy: "ComfyUI 不在 OpenArc 画布范围内" },
    };
  }, [modelCmd]);

  const refreshList = useCallback(async () => {
    const res = await canvasCmd({ type: "canvas/list" });
    if (!res || !res.ok) { setStatus("读取画布列表失败：" + String(res && res.error)); return; }
    setItems((res.items || []).map((c: any) => ({ canvasId: c.canvasId, title: c.title, icon: c.icon, updatedAt: c.updatedAt, kind: c.kind, access: c.access })));
  }, [canvasCmd]);

  const openCanvas = useCallback(async (canvasId: string) => {
    const res = await canvasCmd({ type: "canvas/get", canvasId });
    if (!res || !res.ok) { setNotice("打开画布失败：" + String(res && res.error)); return; }
    const c = res.canvas;
    setCurrent({ canvasId: c.canvasId, title: c.title, revision: c.revision, updatedAt: Number(c.updatedAt || 0), canEdit: !!c.access?.canEdit });
    setStatus("已打开 " + c.title + "（revision " + c.revision + "）");
    setFrameSrc(frameSrcFor(c.canvasId));
    setFrameKey((k) => k + 1);
  }, [canvasCmd]);

  const createCanvas = useCallback(async () => {
    const title = "画布 " + new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    const res = await canvasCmd({ type: "canvas/create", title, icon: "🧩", kind: "classic" });
    if (!res || !res.ok) { setNotice("创建画布失败：" + String(res && res.error)); return; }
    await refreshList();
    await openCanvas(res.canvas.canvasId);
  }, [canvasCmd, openCanvas, refreshList]);

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

  /** 保存回写：显示用的 data URL 换回稳定 ref（旧的、非本会话的 data URL 原样保留，不静默丢图）。*/
  const refsBack = useCallback((doc: any) => {
    for (const n of (doc && doc.nodes) || []) {
      const u = typeof n.url === "string" ? n.url : "";
      const ref = u ? refByDataUrl.current.get(u) : null;
      if (ref) n.url = ref;
    }
    return doc;
  }, []);

  /** 宿主 RPC：画布页面的每一条请求都在这里被翻译成受控命令。*/
  const handleCall = useCallback(async (method: string, params: Record<string, any>): Promise<any> => {
    const cur = currentRef.current;
    const canvasId = (cur && cur.canvasId) || null;
    switch (method) {
      case "model.config": return await buildConfig();
      case "canvas.workflows": return { workflows: [] };
      case "canvas.list": return { canvases: items.map((c) => ({ id: c.canvasId, title: c.title, icon: c.icon, updated_at: c.updatedAt, project: "default", kind: c.kind || "classic" })) };
      case "canvas.trashList": return { canvases: [] };
      case "canvas.create": {
        const res = await canvasCmd({ type: "canvas/create", title: params.title, icon: params.icon, kind: params.kind });
        if (!res.ok) return { __status: 502, body: { error: res.error } };
        await refreshList();
        setCurrent({ canvasId: res.canvas.canvasId, title: res.canvas.title, revision: res.canvas.revision, updatedAt: Number(res.canvas.updatedAt || 0), canEdit: true });
        return { canvas: toCanvasPayload(res.canvas) };
      }
      case "canvas.get": {
        const res = await canvasCmd({ type: "canvas/get", canvasId: params.canvasId });
        if (!res.ok) return { __status: 404, body: { error: res.error } };
        setCurrent({ canvasId: res.canvas.canvasId, title: res.canvas.title, revision: res.canvas.revision, updatedAt: Number(res.canvas.updatedAt || 0), canEdit: !!res.canvas.access?.canEdit });
        setStatus("已打开 " + res.canvas.title + "（revision " + res.canvas.revision + "）");
        const doc = await resolveRefs(res.canvas.doc);
        return { canvas: toCanvasPayload(res.canvas, doc) };
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
          return { __conflict: true, detail: { canvas: c ? toCanvasPayload(c) : null, updated_at: c ? c.updatedAt : 0 } };
        }
        if (!res.ok) { setStatus("保存失败：" + String(res.error)); return { __status: 502, body: { error: res.error } }; }
        setCurrent({ canvasId: res.canvas.canvasId, title: res.canvas.title, revision: res.canvas.revision, updatedAt: Number(res.canvas.updatedAt || 0), canEdit: !!res.canvas.access?.canEdit });
        setStatus("已保存（revision " + res.canvas.revision + "）");
        return { canvas: toCanvasPayload(res.canvas) };
      }
      case "canvas.trash": { const r = await canvasCmd({ type: "canvas/trash", canvasId: params.canvasId }); await refreshList(); return r.ok ? { canvas: toCanvasPayload(r.canvas) } : { __status: 502, body: { error: r.error } }; }
      case "canvas.restore": { const r = await canvasCmd({ type: "canvas/restore", canvasId: params.canvasId }); await refreshList(); return r.ok ? { canvas: toCanvasPayload(r.canvas) } : { __status: 502, body: { error: r.error } }; }
      case "canvas.purge": return await canvasCmd({ type: "canvas/purge", canvasId: params.canvasId });
      case "canvas.touch": return { ok: true };
      case "canvas.meta": {
        const body = (params.body || {}) as any;
        if (body.title == null && body.icon == null) return {};
        const r = await canvasCmd({ type: "canvas/save", canvasId: params.canvasId, baseRevision: cur ? cur.revision : null, doc: null, title: body.title, icon: body.icon });
        return r.ok ? { canvas: toCanvasPayload(r.canvas) } : { __status: 502, body: { error: r.error } };
      }
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
      case "canvas.assetDownload": return { __status: 501, body: { error: "OPENARC_UNSUPPORTED", message: "资源下载不在画布范围内" } };
      case "canvas.mediaPreview": return { __status: 501, body: { error: "OPENARC_UNSUPPORTED", message: "媒体预览不在画布范围内" } };
      case "canvas.upload": {
        const files: File[] = Array.isArray((params.form as any)?.getAll?.("files")) ? (params.form as any).getAll("files") : [];
        const out: any[] = [];
        for (const f of files.slice(0, 8)) {
          if (Number(f.size) > 8 * 1024 * 1024) { setNotice("图片过大（>8MB）未导入：" + f.name); continue; }
          const dataUrl = await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result || "")); r.readAsDataURL(f); });
          if (!dataUrl) continue;
          const res = await canvasCmd({ type: "canvas/importAsset", canvasId, name: f.name, dataUrl });
          if (!res || !res.ok || !res.ref) { setNotice("导入资源库失败（" + String((res && res.error) || "UNKNOWN") + "）：" + f.name + " 未写入画布"); continue; }
          dataUrlByRef.current.set(String(res.ref).slice(ASSET_PREFIX.length), dataUrl);
          refByDataUrl.current.set(dataUrl, res.ref);
          out.push({ url: dataUrl, name: f.name, kind: String(f.type || "").startsWith("video") ? "video" : "image" });
        }
        return { files: out };
      }
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
      default: return { __status: 501, body: { error: "OPENARC_UNSUPPORTED", message: "不在 OpenArc 画布范围内的能力：" + method } };
    }
  }, [buildConfig, canvasCmd, items, modelCmd, openCanvas, refreshList, refsBack, resolveRefs]);

  // 画布页面的请求 → 受控命令 → 回包（**只接受当前实例**）
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const d = event.data as Rpc;
      if (!d || d.ch !== CH || d.dir !== "canvas->host") return;
      const frameWin = frameRef.current?.contentWindow;
      if (!frameWin || event.source !== frameWin) return;            // 其他 iframe / 其他窗口一律忽略
      if (d.kind !== "hello-request" && d.token !== instanceToken.current) return; // 旧实例 / 伪造 token 一律忽略
      if (d.kind === "hello-request") {
        setFrameReady(true);
        const cur = currentRef.current;
        frameWin.postMessage({ ch: CH, dir: "host->canvas", kind: "hello", token: instanceToken.current, canEdit: cur ? cur.canEdit : false, readOnly: cur ? !cur.canEdit : true, canvasId: cur ? cur.canvasId : null }, "*");
        return;
      }
      if (d.kind === "context-request") {
        const cur = currentRef.current;
        frameWin.postMessage({ ch: CH, dir: "host->canvas", kind: "context", canEdit: cur ? cur.canEdit : false, readOnly: cur ? !cur.canEdit : true }, "*");
        return;
      }
      if (d.kind === "adapter-ready" || d.kind === "adapter-timeout") { setStatus(d.kind === "adapter-ready" ? "画布就绪" : "画布适配器未就绪"); return; }
      if (d.kind === "blocked") { setNotice("只读画布：没有编辑权限（手工与 AI 修改都会被同一条权限规则拒绝）"); return; }
      if (d.kind === "call" && typeof d.id === "number" && d.method) {
        void handleCall(d.method, (d.params || {}) as Record<string, any>).then((value) => {
          frameWin.postMessage({ ch: CH, dir: "host->canvas", kind: "result", id: d.id, ok: true, value }, "*");
        }).catch((err) => {
          frameWin.postMessage({ ch: CH, dir: "host->canvas", kind: "result", id: d.id, ok: false, error: { error: "HOST_ERROR", message: String((err && err.message) || err) } }, "*");
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [handleCall]);

  // 首次：取列表 → 没有就建一个 → 打开（编辑器页必须带 ?id）
  useEffect(() => {
    void (async () => {
      const res = await canvasCmd({ type: "canvas/list" });
      const list: any[] = res && res.ok ? (res.items || []) : [];
      if (list.length) { await refreshList(); await openCanvas(String(list[0].canvasId)); return; }
      await createCanvas();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="canvas-host" data-canvas-host={win.id} style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="canvas-host-bar" data-canvas-bar style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: "1px solid var(--line)", flexShrink: 0 }}>
        <strong data-canvas-title>{current ? current.title : "无限画布"}</strong>
        <span className="muted" data-canvas-revision>{current ? "revision " + current.revision : "未打开"}</span>
        <select
          aria-label="选择画布"
          data-canvas-picker
          value={current ? current.canvasId : ""}
          onChange={(e) => { const id = e.target.value; if (id) void openCanvas(id); }}
          style={{ maxWidth: 220 }}
        >
          <option value="">选择画布…</option>
          {items.map((c) => <option key={c.canvasId} value={c.canvasId}>{c.title}</option>)}
        </select>
        <button type="button" data-canvas-create onClick={() => void createCanvas()}>新建画布</button>
        <span className="muted" data-canvas-status>{status}</span>
        {current && !current.canEdit ? <span data-canvas-readonly style={{ color: "var(--failed)" }}>只读（无编辑权限）</span> : null}
        <span className="muted" data-canvas-models style={{ marginLeft: "auto" }}>
          {modelInfo ? "模型：文本 " + modelInfo.chat + " / 图片 " + modelInfo.image : "模型：读取中…"}
        </span>
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
          title="NOVAI 无限画布"
          data-canvas-frame
          data-frame-ready={frameReady ? "1" : "0"}
          sandbox="allow-scripts"
          src={frameSrc}
          style={{ flex: 1, minHeight: 0, width: "100%", border: "0", background: "var(--bg)" }}
        />
      ) : (
        <div data-canvas-frame-pending style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)" }}>
          正在准备画布…
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

/** 主进程画布文档 → 上游画布认识的载荷（字段名保持一致，不做二次发明）。*/
function toCanvasPayload(c: any, docOverride?: any) {
  const doc = docOverride || c.doc || { nodes: [], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] };
  return {
    id: c.canvasId, title: c.title, icon: c.icon || "🧩", kind: c.kind || "classic", project: "default",
    nodes: doc.nodes || [], connections: doc.connections || [],
    viewport: doc.viewport || { x: 0, y: 0, scale: 1 }, logs: doc.logs || [],
    updated_at: Number(c.updatedAt || 0), created_at: Number(c.createdAt || 0), revision: Number(c.revision || 1),
    access: c.access || null,
  };
}
