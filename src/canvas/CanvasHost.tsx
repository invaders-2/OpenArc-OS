/**
 * D5-02 入口与宿主 chrome · NOVAI 画布应用宿主（OpenArc 应用窗口内容）。
 *
 * 结构：**入口 = 上游原版列表首页 static/canvas-list.html（"画布工作台"：无限画布标题、开始创作、
 * 继续上次、新建画布与画布卡片列表）**，由 openarc-canvas:// 只读协议原样服务整棵 static/。
 * 首页上的每个入口都**直接打开真实编辑器 static/canvas.html?id=…**（不插欢迎页、不插选画布遮挡层），
 * 编辑器自带的返回按钮回到列表页：首页 ⇄ 编辑器就是完整的往返路径。
 * 宿主**不画任何 chrome**（没有顶部操作条、状态行、提示横幅）：OpenArc 只负责协议服务、消息闸门、
 * 账号分桶与资源失效复核，界面外观完全交给上游原版页面 —— 删除就是删除，不用 CSS 遮挡冒充。
 *
 * 边界（入口换成列表页后**仍然成立**）：
 *   · 应用页面在 sandbox="allow-scripts allow-same-origin allow-modals" 的 iframe 里：origin 是
 *     openarc-canvas://bundle，与 OpenArc 外壳（file://）**不同源**，页面拿不到 window.openarc / IPC / fs / 凭据；
 *     allow-modals 只放行 alert / confirm / prompt / print 这类模态对话（上游首页卡片菜单的「删除 / 重命名 /
 *     复制画布」与所有 alert 错误提示都要靠它们，此前缺这个标志时 Chromium 直接忽略），**不新增**文件系统、
 *     网络、origin、脚本执行或跨源能力；实例 token 校验 / CSP / 只读闸一律未动；
 *   · 宿主**只接受当前这一个应用帧**的消息：event.source 必须是本帧，且必须带本次挂载的随机 token
 *     （更深的子帧由外层中继附加 token，子帧自己拿不到 token）；
 *   · 账号作用域：入口 URL 的 #oa= 钥匙按"账号 + 本次挂载"生成，页面 localStorage/BroadcastChannel
 *     一律按该钥匙分桶（内存实现，不落盘）；切账号时窗口整体重建，旧页面与旧通道随之失效。
 *     页面内部跳转（列表 → 编辑器）会丢掉 fragment，所以桥在 fragment 之外回落到 oa:mount 找回同一把钥匙；
 *   · 每个应用页都靠桥的 800ms alive 心跳喂看门狗（入口不再固定是带中继的外壳页）；
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
/** 入口 = 上游原版列表首页（无限画布）；画布编辑器由首页上的入口直接打开。*/
const IFRAME_BASE = "openarc-canvas://bundle/static/canvas-list.html";
const ASSET_PREFIX = "openarc-asset:";
const randomToken = () => "t_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
/** 不透明账号钥匙：账号 + 本次挂载，页面只拿它做作用域分桶，不含任何凭据。*/
function keyOf(seed: string) {
  let h = 5381;
  for (let i = 0; i < seed.length; i += 1) h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  return "k" + h.toString(36) + Math.random().toString(36).slice(2, 6);
}

type CanvasListItem = { canvasId: string; title: string; icon: string; updatedAt: number; createdAt?: number; kind?: string; access?: { canEdit: boolean; source: string }; boardX?: number | null; boardY?: number | null; nodes?: number; edges?: number };

export function CanvasHost({ win, onOpenModelSettings }: { win: WinDomain; onOpenModelSettings?: () => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  /** "打开 OpenArc 总 API 设置"是宿主能力，不是页面能力：页面只能请求这一个固定动作（无参数）。*/
  const openModelSettings = useRef(onOpenModelSettings);
  openModelSettings.current = onOpenModelSettings;
  /** 环境"减少动态效果"：随 hello/context 传给应用页，守卫脚本据此跳过动效（跨不了 sandbox 的类名靠这个事实传）。*/
  const reducedMotion = () => (typeof document !== "undefined" && !!document.querySelector(".desktop.reduced")) ? true : false;
  const [items, setItems] = useState<CanvasListItem[]>([]);
  const [frameKey, setFrameKey] = useState(0);
  const [frameSrc, setFrameSrc] = useState<string>("");
  const [current, setCurrent] = useState<{ canvasId: string; title: string; revision: number; updatedAt: number; canEdit: boolean } | null>(null);
  // 宿主不再有状态行与提示横幅（那是 chrome），但 status/notice 的**写点全部保留**：
  // notice 另以根节点上的只读属性暴露给探针（资源失效复核 F3c 的证据通道），status 由看门狗与适配器路径写入。
  const [status, setStatus] = useState("初始化…");
  const [notice, setNotice] = useState<string>("");
  /** 清单外模型名被拒的次数（DOM 只读证据通道：data-canvas-model-not-found）。*/
  const [modelNotFound, setModelNotFound] = useState(0);
  /** 应用帧最后一次心跳（看门狗用）：被非预期导航/崩溃打断时整帧重置，绝不留在错误页上。*/
  const lastBeat = useRef(Date.now());
  /** 本帧说过的消息条数：iframe 换了文档之后用它判断"换出来的还是不是应用页"。*/
  const beatSeq = useRef(0);
  /** 帧加载后的说话窗口（见 onFrameLoad）。*/
  const loadCheck = useRef<number | null>(null);

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
    /**
     * 默认值只认 OpenArc 的**显式配置**，两种情况必须分开（这是"禁止静默换模型"的落点）：
     *   · def == null —— OpenArc 里根本没配该能力默认：回落到清单第一个可用模型只是**展示便利**
     *     （新节点有个开箱可用的初值），不是替换谁的显式配置，保持原行为；
     *   · def != null 却不在可用清单里（能力不符 / 被停用 / 不存在 / 没有 model.use 授权）——
     *     **绝不回落**：投影空字符串，让守卫脚本把该能力明确显示为不可用（原因见 defaultFact）。
     */
    const pick = (cap: string, list: any[]) => {
      const def = defaults.personal?.[cap] || defaults.organization?.[cap] || null;
      if (!def) return list[0] ? label(list[0]) : "";
      const found = list.find((m) => m.configId === def);
      return found ? label(found) : "";
    };
    /**
     * 显式默认的可用性事实：由模型服务（唯一真源）判定原因，不在页面侧猜。
     *   defaultUsable = null（没配该能力默认）/ true（显式默认可用）/ false（显式默认不可用 + defaultReason）
     * 服务没给事实时 fail-closed 按"清单里找不到就是不可用"，绝不悄悄回落。
     */
    const defaultFact = (cap: string) => {
      const def = defaults.personal?.[cap] || defaults.organization?.[cap] || null;
      if (!def) return { defaultUsable: null, defaultReason: null };
      const fact = res && res.defaultsState ? res.defaultsState[cap] : null;
      if (fact && typeof fact.usable === "boolean") return { defaultUsable: fact.usable, defaultReason: fact.usable ? null : (fact.reason || null) };
      const found = usable(cap).some((m) => m.configId === def);
      return { defaultUsable: found, defaultReason: found ? null : "MODEL_NOT_FOUND" };
    };
    /**
     * 供应商投影：**只含该能力下有可用模型的 provider**（OpenArc 是唯一真源，页面侧不再造供应商）。
     * 字段名严格按上游消费点取名 —— canvas.js 读 p.id / p.name / p.enabled /
     * p.chat_models / p.image_models / p.video_models（:713-800、:1141-1162、:7833/:8254）。
     * **不投影** baseUrl / protocol / credentialRef / has_key：页面既拿不到地址也拿不到凭据，
     * 因此不可能出现"看着连上了"的伪造供应商。
     */
    const providersOf = (cap: "chat" | "image-generation") => {
      const out = new Map<string, { id: string; name: string; models: string[] }>();
      for (const m of usable(cap)) {
        const id = String(m.providerId || "");
        if (!id) continue;
        if (!out.has(id)) out.set(id, { id, name: String(m.providerName || id), models: [] });
        out.get(id)!.models.push(label(m));
      }
      return out;
    };
    const chatProviders = providersOf("chat");
    const imageProviders = providersOf("image-generation");
    const apiProviders = Array.from(new Set([...chatProviders.keys(), ...imageProviders.keys()])).map((id) => ({
      id, name: String((chatProviders.get(id) || imageProviders.get(id))!.name), enabled: true,
      chat_models: chatProviders.get(id)?.models || [], image_models: imageProviders.get(id)?.models || [],
      video_models: [],
    }));
    /**
     * 能力事实三件套，语义互不重叠（守卫脚本按它决定"未接通"还是"未配置"）：
     *   transport  传输是否存在（null = OpenArc 根本没接通这个能力）
     *   available  = transport != null（能力本身在不在）
     *   configured = 该能力有没有可用模型（缺模型是"未配置"，不是"不可用"）
     * 第四个事实 defaultUsable/defaultReason 见 defaultFact()：显式默认坏了也是"不可用"，但原因不同
     * （CAPABILITY_UNAVAILABLE / MODEL_DISABLED / MODEL_NOT_FOUND / MODEL_UNAUTHORIZED）。
     */
    const capability = (transport: string | null, configured: boolean, reason: string | null) => ({ available: !!transport, transport, configured, reason });
    return {
      chat_models: chat.map(label),
      image_models: image.map(label),
      // 视频/ComfyUI 在 OpenArc 里没有传输：投影一律为空，并把原因交给守卫脚本（绝不显示为已连接）。
      video_models: [], ms_chat_models: [], comfy_instances: [],
      api_providers: apiProviders,
      image_model: pick("image-generation", image),
      chat_model: pick("chat", chat),
      provider_count: apiProviders.length,
      chat_model_count: chat.length,
      image_model_count: image.length,
      /**
       * 能力可用性事实。**守卫脚本真的读它**（public/novai-canvas/openarc-canvas-guard.js 按
       * available / transport / reason 决定禁用哪些下拉、写什么说明、给不给"打开 OpenArc 总 API 设置"）。
       * 未接通的能力一律 available:false + reason —— 不是装饰字段。
       */
      capabilities: {
        chat: { ...capability("openarc-model-service", chat.length > 0, chat.length ? null : "OpenArc 总 API 设置里还没有可用的文本模型"), ...defaultFact("chat") },
        "image-generation": { ...capability("openarc-model-service", image.length > 0, image.length ? null : "OpenArc 总 API 设置里还没有可用的生图模型"), ...defaultFact("image-generation") },
        "video-generation": capability(null, false, "OpenArc 未接通视频传输（不可用）"),
        comfy: capability(null, false, "OpenArc 未接入 ComfyUI（不可用）"),
      },
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
    await toShell({ kind: "context", canEdit: c ? c.canEdit : false, readOnly: c ? !c.canEdit : true, canvasId: c ? c.canvasId : null, reducedMotion: reducedMotion() });
  }, [toShell]);

  // 宿主「减少动态效果」是实时开关：sandbox iframe 读不到外壳的类名，只能由宿主把事实重新推过去
  //（应用页的守卫按 data-openarc-reduced-motion 关掉自己的动效）。
  useEffect(() => {
    const root = typeof document !== "undefined" ? document.querySelector(".desktop") : null;
    if (!root || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => { void pushContext(currentRef.current); });
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [pushContext]);

  /** 宿主 RPC：应用页面的每一条请求都在这里被翻译成受控命令。*/
  const handleCall = useCallback(async (method: string, params: Record<string, any>): Promise<any> => {
    const cur = currentRef.current;
    const canvasId = (cur && cur.canvasId) || null;
    switch (method) {
      // —— 应用外壳 ——
      case "app.openModelSettings":
        openModelSettings.current?.();
        return { ok: true, app: "settings", pane: "model", label: "打开 OpenArc 总 API 设置" };
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
        const canEdit = !!res.canvas.access?.canEdit;
        setCurrent({ canvasId: res.canvas.canvasId, title: res.canvas.title, revision: res.canvas.revision, updatedAt: Number(res.canvas.updatedAt || 0), canEdit });
        // 页面自己发起的打开（列表卡片 / 直链）与 canvas.create 同一口径：current 变了就立刻把
        // 只读事实推给页面，否则页面停在 hello 那一刻的 canEdit:false 上（重开的画布改不动、也存不了）。
        await pushContext({ canvasId: res.canvas.canvasId, canEdit });
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
      /** 只读：AI 新增标记（页面据此给对应节点加来源标记 + 一次性 160ms 淡入）。*/
      case "canvas.agentMarks": {
        const target = String(params.canvasId || canvasId || "");
        if (!target) return { ok: false, error: "CANVAS_NOT_OPEN", marks: [] };
        return await agentMarksOf(canvasCmd, target);
      }
      case "canvas.save": {
        const body = (params.body || {}) as any;
        const target = String(params.canvasId || canvasId || "");
        const want = Number(body.base_updated_at || 0);
        /**
         * 页面声明的是"它最后一次成功同步的 updated_at"，要映射成 revision 才能做乐观并发检查。
         * 宿主的 current 快照在别处写入（宿主 IPC / AI / 其它窗口）之后最多落后 2.5s，拿落后快照判定会把
         * **已经对齐**的基线误判成 -1：页面只能靠反复重试等快照追上，而追上那一刻它就用手里的旧文档
         * 覆盖了对方（第八 / 十 / 十一批实测的"500ms 待保存窗口"缺陷）。这里按存储的当前事实对齐一次再映射：
         * 基线真的过期才冲突 —— 语义没放宽，只是不再用过期快照判"过期"。
         */
        let snapshot = currentRef.current;
        if (snapshot && want !== Number(snapshot.updatedAt) && (!snapshot.canvasId || snapshot.canvasId === target)) {
          const fresh = await canvasCmd({ type: "canvas/meta", canvasId: target });
          if (fresh && fresh.ok && fresh.meta) {
            snapshot = { canvasId: target, title: fresh.meta.title, revision: Number(fresh.meta.revision || 1), updatedAt: Number(fresh.meta.updatedAt || 0), canEdit: !!fresh.meta.access?.canEdit };
            setCurrent(snapshot);
          }
        }
        const base = snapshot && want === Number(snapshot.updatedAt) ? snapshot.revision : -1;
        const res = await canvasCmd({
          type: "canvas/save", canvasId: target, baseRevision: base,
          doc: refsBack({ nodes: body.nodes || [], connections: body.connections || [], viewport: body.viewport || { x: 0, y: 0, scale: 1 }, logs: body.logs || [] }),
          title: body.title, icon: body.icon,
        });
        if (!res.ok && res.error === "REVISION_CONFLICT") {
          const c = (res.detail && res.detail.canvas) || null;
          setStatus("版本冲突：已在别处修改，保留双方内容");
          // 冲突回包就是页面做三方合并要用的 remote。它必须和 canvas.get 一样是**可显示形态**
          // （资源引用解析成当前用户有权读的 data URL）：否则页面拿 ref 与本地 data URL 比较，
          // 会把"没改过的图片字段"误判成远端改动，合并时把显示用的地址换掉。
          const doc = c ? await resolveRefs(c.doc) : null;
          return { __conflict: true, detail: { canvas: c ? upstreamCanvas(c, doc) : null, updated_at: c ? c.updatedAt : 0 } };
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
        // 页面传的是清单里的标签（displayName · configId 尾号）：不在当前 OpenArc 清单 = 明确报错，
        // **绝不静默回落到"该能力的默认模型"**。判定发生在任何 canvas/run 之前：0 次 provider 请求。
        const wanted = String(body.model || "");
        const configId = wanted ? labelToConfig.current.get(wanted) : null;
        if (wanted && !configId) { setModelNotFound((n) => n + 1); setNotice("模型不在 OpenArc 清单里（已拒绝，不回落）：" + wanted); return rejectUnknownModel("model.chat", wanted); }
        const run = await canvasCmd({ type: "canvas/run", canvasId, kind: "chat", nodeId: body.nodeId || null });
        if (!run || !run.ok) { setNotice("无法开始生成：" + String((run && run.error) || "UNKNOWN")); return { __status: 502, body: { error: (run && run.error) || "RUN_FAILED" } }; }
        const system = String(body.system_prompt || "You are a helpful assistant.");
        const history = Array.isArray(body.messages) ? body.messages : [];
        const messages = [{ role: "system", content: system }]
          .concat(history.slice(-20).map((m: any) => ({ role: m && m.role === "assistant" ? "assistant" : "user", content: String((m && m.content) || "") })))
          .concat([{ role: "user", content: String(body.message || "") }]);
        const res = await canvasCmd({
          type: "canvas/modelChat", canvasId, runId: run.runId, messages,
          configId,
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
        const wantedImage = String(body.model || "");
        const imageConfigId = wantedImage ? labelToConfig.current.get(wantedImage) : null;
        if (wantedImage && !imageConfigId) { setModelNotFound((n) => n + 1); setNotice("模型不在 OpenArc 清单里（已拒绝，不回落）：" + wantedImage); return rejectUnknownModel("model.imageTask", wantedImage); }
        const run = await canvasCmd({ type: "canvas/run", canvasId, kind: "image", nodeId: body.nodeId || null });
        if (!run || !run.ok) { setNotice("无法开始生成：" + String((run && run.error) || "UNKNOWN")); return { __status: 502, body: { error: (run && run.error) || "RUN_FAILED" } }; }
        const taskId = "oa_img_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const promise = (async () => {
          const res = await canvasCmd({
            type: "canvas/modelImage", canvasId, runId: run.runId, prompt: String(body.prompt || ""),
            size: body.size || null, count: Number(body.count) || 1,
            configId: imageConfigId,
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
      beatSeq.current += 1;
      if (d.kind === "alive") return;
      if (d.kind === "hello-request") {
        const cur = currentRef.current;
        frameWin.postMessage({
          ch: CH, dir: "host->canvas", kind: "hello", token: instanceToken.current,
          canEdit: cur ? cur.canEdit : false, readOnly: cur ? !cur.canEdit : true, canvasId: cur ? cur.canvasId : null,
          account: "openarc", accountKey: (frameSrc.split("#oa=")[1] || null), reducedMotion: reducedMotion(),
        }, "*");
        return;
      }
      if (d.kind === "context-request") {
        const cur = currentRef.current;
        frameWin.postMessage({ ch: CH, dir: "host->canvas", kind: "context", canEdit: cur ? cur.canEdit : false, readOnly: cur ? !cur.canEdit : true, canvasId: cur ? cur.canvasId : null, accountKey: (frameSrc.split("#oa=")[1] || null), reducedMotion: reducedMotion() }, "*");
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

  /** 整帧重置：换新实例 token + 把应用帧重挂载回 bundle 入口（旧页面与旧 token 立即失效）。
   *  看门狗（长时间不心跳）与"iframe 换了文档"复核共用这一条路径。*/
  const resetAppFrame = useCallback((reason: string) => {
    lastBeat.current = Date.now();
    instanceToken.current = randomToken();
    setNotice(reason);
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
  }, []);

  // 应用帧看门狗：正常情况下外壳中继每 800ms 发一次心跳。若连续 8s 没有任何消息，
  // 说明该帧被非预期导航/崩溃打断（例如页面自我导航到外部站点被 CSP/宿主拦下后停在错误页）——
  // 这里整帧重置到 bundle 入口（新 token），保证用户不会卡在错误页上，也保证旧页面立即失效。
  useEffect(() => {
    const timer = setInterval(() => {
      const frameWin = frameRef.current?.contentWindow;
      if (!frameWin || !frameSrc) return;
      if (Date.now() - lastBeat.current < 8000) return;
      resetAppFrame("应用页面被非预期导航/崩溃中断，已重置（旧页面与旧实例 token 立即失效）");
    }, 3000);
    return () => clearInterval(timer);
  }, [frameSrc, resetAppFrame]);

  /** 帧内文档被换掉之后的复核：iframe 自我导航出网是被**父文档的 CSP frame-src** 拦下的，
   *  导航根本没走到主进程（will-frame-navigate 不触发），帧里落的是 Chromium 错误页；
   *  错误页同样会触发 iframe 的 load，所以只能按"换了文档之后还说不说话"判定：加载完成 3s 内
   *  连一条本帧消息都没有 = 换出来的不是应用页 → 立即整帧重置回入口（不用等 8s 看门狗）。*/
  const onFrameLoad = useCallback(() => {
    if (loadCheck.current) window.clearTimeout(loadCheck.current);
    const seen = beatSeq.current;
    loadCheck.current = window.setTimeout(() => {
      loadCheck.current = null;
      if (beatSeq.current === seen) resetAppFrame("应用页面被非预期导航替换，已立即重置（旧页面与旧实例 token 立即失效）");
    }, 3000);
  }, [resetAppFrame]);
  useEffect(() => () => { if (loadCheck.current) window.clearTimeout(loadCheck.current); }, []);

  // 主进程拦截的应用内导航出网：证据留在宿主 notice 状态里（不再有计数徽标）
  useEffect(() => {
    const off = (window as any).openarc?.onNativeState?.((e: any) => {
      if (String(e?.type || "") !== "canvas-navigation-blocked") return;
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

  // 当前画布轮询：revision 跟着 OpenArc 存储走；同时做**引用资源可用性复核**
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

  return (
    <div
      className="browser-shell"
      data-canvas-host={win.id}
      data-canvas-app="novai-full"
      // 宿主不再画提示横幅（横幅是 chrome）。这一对**只读属性**是资源失效复核等路径的
      // 行为证据通道，供探针与门禁读取 —— 不是 UI，也没有用 CSS 把任何东西藏起来。
      data-canvas-asset-notice={notice ? "1" : "0"}
      data-canvas-asset-notice-text={notice || undefined}
      // 清单外模型名的拒绝计数（只读证据：配合"0 次 provider 请求"，证明没有静默回落）
      data-canvas-model-not-found={modelNotFound}
    >
      {frameSrc ? (
        <iframe
          key={frameKey}
          ref={frameRef}
          title="NOVAI 无限画布（OpenArc 集成）"
          className="canvas-host-frame"
          data-canvas-frame
          data-canvas-app-frame
          // allow-modals 只放行 alert / confirm / prompt / print 这类模态对话（上游卡片菜单的删除/重命名/复制
          // 与错误提示要用），不新增文件系统 / 网络 / origin / 脚本执行 / 跨源能力：帧仍与外壳不同源，
          // 实例 token 校验、CSP、只读闸一律未动。
          sandbox="allow-scripts allow-same-origin allow-modals"
          onLoad={onFrameLoad}
          src={frameSrc}
        />
      ) : (
        <div className="web-viewport" data-canvas-frame-pending>正在准备应用…</div>
      )}
    </div>
  );
}

/**
 * 「AI 新增」标记（MOTION_SYSTEM §6）：从**画布命令账本**里读出真正由 AI 新增、且**现在仍在文档里**
 * 的节点 / 连线 id。只读：走既有 canvas/log 与 canvas/get，不新增命令面、不动任何权限口径。
 * 判据是账本本身（actorKind=AGENT + outcome=APPLIED + 命令里带 id），**不是**"这次改动是远端同步来的"
 * —— 本地用户新增、别的窗口的 USER 操作都会走同一条远端同步路径，按同步来源猜会把它们全打成 AI。
 * 日志记的是命令，不是结果：只有命令里带了 id 的新增才能对上号（AI 的 canvas.edit 就是这么传的）；
 * node.copy / 未带 id 的新增在账本里没有 id 可对 —— 不猜、不标记（没有证据，而不是"漏了"）。
 */
async function agentMarksOf(canvasCmd: (p: Record<string, unknown>) => Promise<any>, target: string) {
  const log = await canvasCmd({ type: "canvas/log", canvasId: target, limit: 200 });
  if (!log || !log.ok) return { ok: false, error: String((log && log.error) || "LOG_UNAVAILABLE"), marks: [] };
  const got = await canvasCmd({ type: "canvas/get", canvasId: target });
  if (!got || !got.ok) return { ok: false, error: String((got && got.error) || "DOC_UNAVAILABLE"), marks: [] };
  const doc = (got.canvas && got.canvas.doc) || {};
  const liveNodes = new Set<string>((doc.nodes || []).map((n: any) => String(n && n.id)));
  const liveEdges = new Set<string>((doc.connections || []).map((c: any) => String(c && c.id)));
  const marks: Array<{ nodeIds: string[]; edgeIds: string[]; commandType: string; resultRevision: number | null; at: number | null }> = [];
  for (const row of ((log.items || []) as any[])) {
    if (String(row && row.actorKind).toUpperCase() !== "AGENT") continue;
    if (String(row && row.outcome).toUpperCase() !== "APPLIED") continue;
    const cmd = (row && row.command) || {};
    const type = String(cmd.type || "");
    const nodeIds: string[] = [];
    const edgeIds: string[] = [];
    if (type === "node.add" && cmd.node && cmd.node.id) nodeIds.push(String(cmd.node.id));
    if (type === "edge.connect" && cmd.id) edgeIds.push(String(cmd.id));
    // 只回**仍存在于当前文档里**的 id：命令是历史，节点可能已经被删掉/撤销掉。
    const liveN = nodeIds.filter((id) => liveNodes.has(id));
    const liveE = edgeIds.filter((id) => liveEdges.has(id));
    if (!liveN.length && !liveE.length) continue;
    marks.push({ nodeIds: liveN, edgeIds: liveE, commandType: type, resultRevision: Number(row.resultRevision) || null, at: Number(row.at) || null });
  }
  return { ok: true, canvasId: target, marks, scanned: ((log.items || []) as any[]).length };
}

/** 清单外模型名的统一拒绝载荷（MODEL_NOT_FOUND；不建 run、不发 provider 请求）。*/
function rejectUnknownModel(method: string, label: string) {
  return {
    __status: 502,
    body: {
      // error 是稳定错误码（门禁断言用）；detail 是人话（上游错误弹窗优先显示它，避免只给一个错误码）。
      error: "MODEL_NOT_FOUND",
      detail: "该模型不在当前 OpenArc 模型清单里（不会改用其它模型）：" + label,
      message: "当前 OpenArc 模型清单里没有这个模型（不会改用其它模型）：" + label,
      model: label, method,
    },
  };
}

function explain(code: string) {
  if (code === "MODEL_NOT_FOUND") return "该模型不在当前 OpenArc 模型清单里（不会改用其它模型，请在 设置 → 模型 / AI 里登记）";
  if (code === "CAPABILITY_UNAVAILABLE") return "该模型没有这项能力（OpenArc 不会用文本接口顶替）";
  if (code === "MODEL_CONFIG_UNAVAILABLE") return "没有可用的模型配置（请在 设置 → 模型 里配置）";
  if (code === "CREDENTIAL_MISSING") return "该模型缺少凭据";
  if (code === "PROXY_UNAUTHORIZED") return "没有权限使用该模型（应用授权已被撤销或未授予）";
  if (code === "BUDGET_EXHAUSTED") return "本次生成的任务预算已用尽";
  if (code === "TASK_CANCELLED" || code === "RUN_STOPPED") return "生成已停止";
  if (code === "CANVAS_CHANGED") return "画布在生成期间已被修改，结果未写入（保留你的内容）";
  return code;
}
