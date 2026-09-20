/**
 * D5-02 · 无限画布宿主（OpenArc 应用窗口内容）。
 *
 * 结构（PLAN §22）：左侧资源 / 中央画布 / 右侧属性 / 底部缩放 —— 全部由**上游画布本身**提供，
 * 这里只加一层 OpenArc 外壳：项目与状态、只读标记、模型状态提示，以及 sandbox iframe。
 *
 * 边界：
 *   · 画布页面在 sandbox="allow-scripts" 的 iframe 里（opaque origin）：没有 openarc 桥、
 *     没有 IPC、没有文件系统、没有凭据；它只能通过 postMessage 请求宿主；
 *   · 宿主把画布请求翻译成**受控命令**（canvas:command / model:command），身份与权限由主进程裁决；
 *   · 画布没有自己的密钥与服务地址：/api/config 由宿主用 OpenArc 已配置模型合成（无 provider/无 key）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Window as WinDomain } from "../../electron/window-domain.cjs";

type Rpc = { ch: string; dir: string; kind: string; id?: number; method?: string; params?: Record<string, unknown>; command?: Record<string, unknown>; baseRevision?: number };

const CH = "openarc.canvas";
/** 上游编辑器页只认 ?id：宿主先决定打开哪个画布，再把 id 交给它（不附带任何凭据）。*/
const IFRAME_BASE = "openarc-canvas://bundle/index.html";
const frameSrcFor = (canvasId: string) => IFRAME_BASE + "?id=" + encodeURIComponent(canvasId);

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
  const tasks = useRef(new Map<string, Promise<Record<string, unknown>>>());
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

  /** 把 OpenArc 已配置模型投影成画布认识的 /api/config 形状（**没有 provider、没有密钥、没有地址**）。*/
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
      video_models: [],
      ms_chat_models: [],
      comfy_instances: [],
      api_providers: [],
      image_model: pick("image-generation", image),
      chat_model: pick("chat", chat),
      chat_capability: chat.length > 0,
      image_capability: image.length > 0,
      // 明确的缺项（不静默、不回落）
      unsupported: { "video-generation": "OpenArc 模型服务当前没有视频传输", "comfy": "ComfyUI 不在 OpenArc 画布范围内" },
    };
  }, [modelCmd]);

  const refreshList = useCallback(async () => {
    const res = await canvasCmd({ type: "canvas/list" });
    if (!res || !res.ok) { setStatus("读取画布列表失败：" + String(res && res.error)); return; }
    const list: CanvasListItem[] = (res.items || []).map((c: any) => ({ canvasId: c.canvasId, title: c.title, icon: c.icon, updatedAt: c.updatedAt, kind: c.kind, access: c.access }));
    setItems(list);
  }, [canvasCmd]);

  const openCanvas = useCallback(async (canvasId: string) => {
    const res = await canvasCmd({ type: "canvas/get", canvasId });
    if (!res || !res.ok) { setNotice("打开画布失败：" + String(res && res.error)); return; }
    const c = res.canvas;
    setCurrent({ canvasId: c.canvasId, title: c.title, revision: c.revision, updatedAt: Number(c.updatedAt || 0), canEdit: !!c.access?.canEdit });
    setStatus("已打开 " + c.title + "（revision " + c.revision + "）");
    // 编辑器页需要 ?id；换画布 = 换一次 src（画布不做跨项目复用）。
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

  /** 宿主 RPC：画布页面的每一条请求都在这里被翻译成受控命令。 */
  const handleCall = useCallback(async (method: string, params: Record<string, any>): Promise<any> => {
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
        return { canvas: toCanvasPayload(res.canvas) };
      }
      case "canvas.save": {
        const body = (params.body || {}) as any;
        const cur = currentRef.current;
        const canvasId = String(params.canvasId || (cur && cur.canvasId) || "");
        // 上游用 updated_at（毫秒时间戳）做基准，OpenArc 存储用单调 revision：
        // 时间戳一致 ⟺ 同一个版本；不一致就是过期基准 → 交给存储做版本检查并返回冲突。
        const base = cur && Number(body.base_updated_at || 0) === Number(cur.updatedAt) ? cur.revision : -1;
        const res = await canvasCmd({
          type: "canvas/save", canvasId,
          baseRevision: base,
          doc: { nodes: body.nodes || [], connections: body.connections || [], viewport: body.viewport || { x: 0, y: 0, scale: 1 }, logs: body.logs || [] },
          title: body.title, icon: body.icon,
        });
        if (!res.ok && res.error === "REVISION_CONFLICT") {
          const cur = (res.detail && res.detail.canvas) || null;
          setStatus("版本冲突：已在别处修改，保留双方内容");
          return { __conflict: true, detail: { canvas: cur ? toCanvasPayload(cur) : null, updated_at: cur ? cur.updatedAt : 0 } };
        }
        if (!res.ok) { setStatus("保存失败：" + String(res.error)); return { __status: 502, body: { error: res.error } }; }
        setCurrent({ canvasId: res.canvas.canvasId, title: res.canvas.title, revision: res.canvas.revision, updatedAt: Number(res.canvas.updatedAt || 0), canEdit: !!res.canvas.access?.canEdit });
        setStatus("已保存（revision " + res.canvas.revision + "）");
        return { canvas: toCanvasPayload(res.canvas) };
      }
      case "canvas.trash": { const r = await canvasCmd({ type: "canvas/trash", canvasId: params.canvasId }); await refreshList(); return r.ok ? { canvas: toCanvasPayload(r.canvas) } : { __status: 502, body: { error: r.error } }; }
      case "canvas.restore": { const r = await canvasCmd({ type: "canvas/restore", canvasId: params.canvasId }); await refreshList(); return r.ok ? { canvas: toCanvasPayload(r.canvas) } : { __status: 502, body: { error: r.error } }; }
      case "canvas.purge": { const r = await canvasCmd({ type: "canvas/purge", canvasId: params.canvasId }); await refreshList(); return r; }
      case "canvas.touch": return { ok: true };
      case "canvas.meta": {
        const body = (params.body || {}) as any;
        if (body.title == null && body.icon == null) return {};
        const cur = currentRef.current;
        const r = await canvasCmd({ type: "canvas/save", canvasId: params.canvasId, baseRevision: cur ? cur.revision : null, doc: null, title: body.title, icon: body.icon });
        return r.ok ? { canvas: toCanvasPayload(r.canvas) } : { __status: 502, body: { error: r.error } };
      }
      case "canvas.assetStates": {
        const urls: string[] = Array.isArray((params.body || {}).urls) ? (params.body as any).urls : [];
        const refs = urls.filter((u) => u.startsWith("openarc-asset:")).map((u) => u.slice("openarc-asset:".length));
        const exists: Record<string, boolean> = {};
        if (!refs.length) return { exists };
        const res = await canvasCmd({ type: "canvas/assetStates", refs });
        const states = (res && res.exists) || {};
        urls.forEach((u) => {
          if (!u.startsWith("openarc-asset:")) { exists[u] = true; return; }
          const st = states[u.slice("openarc-asset:".length)];
          exists[u] = !!st && st.state === "AVAILABLE";
        });
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
          if (dataUrl) out.push({ url: dataUrl, name: f.name, kind: String(f.type || "").startsWith("video") ? "video" : "image" });
        }
        return { files: out };
      }
      case "model.chat": {
        const body = (params.body || {}) as any;
        const label = String(body.model || "");
        const configId = labelToConfig.current.get(label) || null;
        const system = String(body.system_prompt || "You are a helpful assistant.");
        const history = Array.isArray(body.messages) ? body.messages : [];
        const messages = [{ role: "system", content: system }]
          .concat(history.slice(-20).map((m: any) => ({ role: m && m.role === "assistant" ? "assistant" : "user", content: String((m && m.content) || "") })))
          .concat([{ role: "user", content: String(body.message || "") }]);
        const res = await modelCmd({ type: "canvas/chat", configId, messages, requestId: "canvas_" + Date.now().toString(36) });
        if (!res || !res.ok) {
          const code = String((res && res.error) || "MODEL_ERROR");
          const hint = code === "CAPABILITY_UNAVAILABLE" ? "该模型没有 chat 能力或未配置默认模型"
            : code === "MODEL_CONFIG_UNAVAILABLE" ? "没有可用的模型配置（请在 设置 → 模型 里配置）"
            : code === "CREDENTIAL_MISSING" ? "该模型缺少凭据" : code;
          setNotice("模型调用失败：" + hint);
          return { __status: 502, body: { error: code, message: hint } };
        }
        return { text: String(res.text || ""), model: label, requestId: res.requestId || null, usage: res.usage || null };
      }
      case "model.imageTask": {
        const body = (params.body || {}) as any;
        const label = String(body.model || "");
        const configId = labelToConfig.current.get(label) || null;
        const taskId = "oa_img_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const promise = modelCmd({ type: "canvas/image", configId, prompt: String(body.prompt || ""), size: body.size || null, count: Number(body.count) || 1, requestId: taskId })
          .then((res: any) => {
            if (!res || !res.ok) {
              const code = String((res && res.error) || "MODEL_ERROR");
              const hint = code === "CAPABILITY_UNAVAILABLE" ? "该模型未声明 image-generation 能力（OpenArc 不会用文本接口顶替）"
                : code === "MODEL_CONFIG_UNAVAILABLE" ? "没有可用的图片模型（请在 设置 → 模型 里配置并设默认）"
                : code === "CREDENTIAL_MISSING" ? "该模型缺少凭据" : code;
              setNotice("图片生成失败：" + hint);
              return { ok: false, error: hint };
            }
            return { ok: true, images: (res.images || []).map((i: any) => i.dataUrl || i.url).filter(Boolean) };
          });
        tasks.current.set(taskId, promise);
        return { task_id: taskId, status: "pending" };
      }
      case "model.imageTaskResult": {
        const p = tasks.current.get(String(params.taskId));
        if (!p) return { status: "failed", error: "任务不存在（宿主已重启）" };
        const r = await p;
        if (!r.ok) return { status: "failed", error: String(r.error) };
        return { status: "succeeded", result: { images: r.images, task_id: params.taskId, provider: "openarc" } };
      }
      case "model.queryTask": {
        const p = tasks.current.get(String((params.body || {}).task_id));
        if (!p) return { status: "failed", error: "任务不存在" };
        const r = await p;
        return r.ok ? { status: "succeeded", result: { images: r.images } } : { status: "failed", error: String(r.error) };
      }
      default: return { __status: 501, body: { error: "OPENARC_UNSUPPORTED", message: "不在 OpenArc 画布范围内的能力：" + method } };
    }
  }, [buildConfig, canvasCmd, items, modelCmd, openCanvas, refreshList]);

  // 画布页面的请求 → 受控命令 → 回包
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const d = event.data as Rpc;
      if (!d || d.ch !== CH || d.dir !== "canvas->host") return;
      if (d.kind === "hello-request") {
        setFrameReady(true);
        const cur = currentRef.current;
        frameRef.current?.contentWindow?.postMessage({ ch: CH, dir: "host->canvas", kind: "hello", canEdit: cur ? cur.canEdit : false, readOnly: cur ? !cur.canEdit : true, canvasId: cur ? cur.canvasId : null }, "*");
        return;
      }
      if (d.kind === "context-request") {
        const cur = currentRef.current;
        frameRef.current?.contentWindow?.postMessage({ ch: CH, dir: "host->canvas", kind: "context", canEdit: cur ? cur.canEdit : false, readOnly: cur ? !cur.canEdit : true }, "*");
        return;
      }
      if (d.kind === "adapter-ready" || d.kind === "adapter-timeout") {
        setStatus(d.kind === "adapter-ready" ? "画布就绪" : "画布适配器未就绪");
        return;
      }
      if (d.kind === "blocked") { setNotice("只读画布：没有编辑权限（手工与 AI 修改都会被同一条权限规则拒绝）"); return; }
      if (d.kind === "call" && typeof d.id === "number" && d.method) {
        void handleCall(d.method, (d.params || {}) as Record<string, any>).then((value) => {
          frameRef.current?.contentWindow?.postMessage({ ch: CH, dir: "host->canvas", kind: "result", id: d.id, ok: true, value }, "*");
        }).catch((err) => {
          frameRef.current?.contentWindow?.postMessage({ ch: CH, dir: "host->canvas", kind: "result", id: d.id, ok: false, error: { error: "HOST_ERROR", message: String((err && err.message) || err) } }, "*");
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [handleCall]);

  // 首次：取列表 → 没有就建一个 → 打开（编辑器页必须带 ?id）。
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

/** 主进程画布文档 → 上游画布认识的载荷（字段名保持一致，不做二次发明）。*/
function toCanvasPayload(c: any) {
  const doc = c.doc || { nodes: [], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] };
  return {
    id: c.canvasId,
    title: c.title,
    icon: c.icon || "🧩",
    kind: c.kind || "classic",
    project: "default",
    nodes: doc.nodes || [],
    connections: doc.connections || [],
    viewport: doc.viewport || { x: 0, y: 0, scale: 1 },
    logs: doc.logs || [],
    updated_at: Number(c.updatedAt || 0),
    created_at: Number(c.createdAt || 0),
    revision: Number(c.revision || 1),
    access: c.access || null,
  };
}
