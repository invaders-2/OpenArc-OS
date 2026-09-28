/**
 * D5-03 第一批 · MCP 中心（连接管理与能力发现）。
 *
 * 本批**只有管理面**：连接列表、配置详情、能力表、测试日志。
 * 契约 D 明确第一批不实现 tools/call，所以这里**没有任何"运行工具 / 调用工具"入口** ——
 * 不是把它藏起来，而是它不存在；后端对任何调用入口回 MCP_TOOL_INVOCATION_NOT_ENABLED。
 *
 * 渲染层边界（与 device / model / canvas 桥同一口径）：
 *   · 只经 preload 暴露的 window.openarc.mcp.command 发 mcp:command；
 *   · 不做任何网络请求、不读凭据文件、不写 localStorage；
 *   · sessionRef 由主进程注入 —— 这里**不发** userId / role / sessionRef / appId；
 *   · credentialSecret 只写不读：送出去后立刻从 state 清空，界面永不复现密钥，
 *     投影里也没有 credentialRef（契约 A：凭据永不回渲染层）。
 *
 * 上行形状跟既有命令面一致（model-bootstrap / canvas-bootstrap 的
 * raw.command + raw.payload 口径）：{ command: "mcp/xxx", payload: {...} }。
 *
 * 四类页面状态（PLAN §22「MCP」行）的落点见文件末尾的 STATE_BRANCHES。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, TextField } from "../design-system/primitives";
import type { Tone } from "../design-system/primitives";
import { PageState } from "../design-system/page-states";
import { Dialog } from "../desktop/Dialog";

/* ══════════════════════════════════════════════════════════════════════════
   契约 A：记录（渲染层只读投影，不含 credentialRef）
   ══════════════════════════════════════════════════════════════════════════ */
type McpTool = { name: string; description?: string; inputSchemaSummary?: string };

type McpConnection = {
  connectionId: string;
  name?: string;
  transport?: string;
  location?: string;
  /* 契约 A 写的是 endpointJson / capabilitiesJson / toolsJson；
     主进程实现（electron/mcp-domain.cjs projectConnection）投影的是
     endpoint / capabilities / tools / toolsHidden。两边都读（见 endpointOf /
     capabilitiesOf / toolsRawOf），渲染层不因为字段命名差异要求后端改名。 */
  endpointJson?: { serverKey?: string; url?: string; endpointScope?: string } | null;
  endpoint?: { serverKey?: string; url?: string; endpointScope?: string } | null;
  authMode?: string;
  /** 主进程投影的"凭据已配置"布尔：凭据本身（credentialRef/secret）永不过桥。 */
  credentialConfigured?: boolean;
  enabled?: boolean;
  status?: string;
  lastErrorCode?: string | null;
  protocolVersion?: string | null;
  serverName?: string | null;
  serverVersion?: string | null;
  capabilitiesJson?: unknown;
  capabilities?: unknown;
  toolsJson?: unknown;
  tools?: unknown;
  toolsHash?: string | null;
  visibility?: string;
  ownerUserId?: string | null;
  organizationId?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  lastConnectedAt?: number | null;
  /**
   * PLAN §22「无权不暴露工具描述」的真实落点：主进程只有 App 持有 mcp.use 时才投影
   * 工具描述，否则给 toolsHidden=true 且 tools=[]、toolsHash=null（mcp-service #mayUse）。
   * toolsRedacted 是契约草稿里的旧名，一并容忍。
   */
  toolsHidden?: boolean;
  toolsRedacted?: boolean;
  /** 权限口径的事实位（mcp-service #safe）：由后端判定，界面据此禁用无权的动作并说明原因。 */
  access?: {
    canView?: boolean;
    canUse?: boolean;
    canManage?: boolean;
    isOwner?: boolean;
    connectionScope?: string;
  } | null;
};

type McpResult = Record<string, unknown> & { ok?: boolean; error?: unknown };
type McpBridge = { command: (cmd: Record<string, unknown>) => Promise<McpResult> };

/** 契约 C：本地连接不接受任意命令行，只接受白名单 serverKey（第一批只有这一个）。 */
const LOCAL_SERVER_KEYS = ["openarc-test-echo"] as const;

/* 契约 C：endpointScope 沿用模型服务口径（electron/model-domain.cjs 的 ENDPOINT_SCOPE：
   LOCALHOST / LAN_EXPLICIT / REMOTE_HTTPS）。它由主进程按地址推导后写进记录，
   渲染层不给"手选范围"的假控件 —— 所以这里只有显示用的取名表。 */

const TEST_LOG_LIMIT = 20;

/* ══════════════════════════════════════════════════════════════════════════
   文案：状态 / 错误码 / 两端轴
   ══════════════════════════════════════════════════════════════════════════ */

/** 契约 A 的五个状态。未登记状态**照原样显示**，不塌缩成"统一不可用"。 */
const STATUS_META: Record<string, { label: string; tone: Tone }> = {
  DISABLED: { label: "已停用 DISABLED", tone: "neutral" },
  CONNECTING: { label: "连接中 CONNECTING", tone: "neutral" },
  READY: { label: "就绪 READY", tone: "success" },
  ERROR: { label: "错误 ERROR", tone: "danger" },
  AUTH_REQUIRED: { label: "需重新授权 AUTH_REQUIRED", tone: "warning" },
};

const TRANSPORT_LABEL: Record<string, string> = {
  stdio: "stdio（本地进程）",
  http: "http（远程服务）",
};

/** 执行位置与传输是**两根轴**，分别显示，不合并（DESIGN_SYSTEM §6 / 契约 A）。 */
const LOCATION_LABEL: Record<string, string> = {
  LOCAL_DEVICE: "本地设备",
  REMOTE_SERVICE: "远程服务",
};

const VISIBILITY_LABEL: Record<string, string> = {
  PERSONAL: "仅本人 PERSONAL",
  ORGANIZATION: "组织 ORGANIZATION",
};

const AUTH_MODE_LABEL: Record<string, string> = {
  NONE: "无需授权 NONE",
  BEARER: "Bearer 凭据 BEARER",
};

const SCOPE_LABEL: Record<string, string> = {
  LOCALHOST: "仅本机 LOCALHOST",
  LAN_EXPLICIT: "局域网（显式放开）LAN_EXPLICIT",
  REMOTE_HTTPS: "公网 HTTPS REMOTE_HTTPS",
};

/**
 * 稳定错误码 → 人话。这不是权限判定，只是后端拒绝之后的解释文案；
 * 未登记的码走 fallback，把原始码原样显示出来（"未知码也有提示"）。
 */
const ERROR_LABEL: Record<string, string> = {
  /* 主进程错误码表：electron/mcp-domain.cjs 的 ERROR_CODE（逐条对齐，不自己造码）。 */
  MCP_CONNECTION_NOT_FOUND: "连接不存在，可能已被删除，或当前账号无权访问",
  MCP_COMMAND_NOT_ALLOWED: "命令不在 mcp:command 白名单内",
  MCP_INVALID_INPUT: "输入不完整或被拒绝",
  MCP_UNAUTHORIZED: "当前账号或该应用没有被授这个动作",
  MCP_LOCAL_SERVER_NOT_ALLOWED: "本地服务不在白名单：第一批只允许登记过的本地测试服务",
  MCP_ENDPOINT_BLOCKED: "端点被拒绝：只接受 http(s)，且禁止 file://、元数据地址、URL 内嵌凭据与明文远程",
  MCP_CONNECTION_DISABLED: "连接已停用：先「启用」再做连接 / 重连 / 测试",
  MCP_CONNECTION_BUSY: "该连接上已有一次握手在进行，稍后重试",
  MCP_PROTOCOL_ERROR: "MCP 协议错误：服务端没有按 JSON-RPC 2.0 响应",
  MCP_PROTOCOL_VERSION_UNSUPPORTED: "服务端协议版本不在受支持列表内",
  MCP_TIMEOUT: "服务端没有在限定时间内响应",
  MCP_UNREACHABLE: "连不上服务端（本地进程未起来，或远程不可达）",
  MCP_AUTH_REQUIRED: "认证失败，需要重新授权或更新凭据",
  MCP_CREDENTIAL_MISSING: "该连接声明需要 Bearer 凭据，但还没有可用的凭据",
  MCP_CREDENTIAL_STORE_UNAVAILABLE: "凭据存储不可用，无法保存或读取凭据",
  MCP_TOOL_DISCOVERY_FAILED: "tools/list 没有成功返回：工具清单未发现",
  MCP_TOOL_INVOCATION_NOT_ENABLED: "第一批不开放工具调用，这里只做连接管理与能力发现",
  MCP_RECONNECT_LIMIT: "重连次数已达上限，已停止重试（不空转）",
  MCP_SESSION_ENDED: "会话已结束（登出 / 锁屏 / 应用退出），连接已收掉；重新登录后可再次连接",
  MCP_INTERNAL_ERROR: "主进程内部错误",
  /* 渲染层自己的事实位（不是后端码，前缀刻意与 MCP_ 区分开）。 */
  LOCAL_INPUT_REQUIRED: "名称不能为空（界面上先行拦截，没有发给后端）",
  RESPONSE_INCOMPLETE: "主进程返回的记录不完整，界面不猜内容",
  NO_BRIDGE: "桌面桥未接入（当前环境没有 MCP 域）",
  INTERNAL_ERROR: "主进程返回异常",
  SESSION_EXPIRED: "会话已过期，请重新登录",
  SESSION_REVOKED: "会话已失效，请重新登录",
};

/**
 * 后端以"拒绝"作答时，哪些码按「无权」渲染。
 *
 * MCP_CONNECTION_NOT_FOUND **不在此列**：主进程对"别人的个人连接"故意回这个码
 * （不暴露存在），把它显示成"无权"反而泄露了"它存在"。这里照它的原意显示"不存在或无权访问"。
 */
const AUTHORIZATION_CODES = new Set(["MCP_UNAUTHORIZED", "FORBIDDEN", "UNAUTHORIZED", "PERMISSION_DENIED"]);

/**
 * 「需重新授权」的判定：主进程只在这两条码上把 status 落成 AUTH_REQUIRED
 * （mcp-domain.toStatus：MCP_AUTH_REQUIRED / MCP_CREDENTIAL_MISSING）。
 * status === "AUTH_REQUIRED" 是主路径，错误码是兜底，避免入口消失。
 */
const AUTH_ERROR_CODES = new Set(["MCP_AUTH_REQUIRED", "MCP_CREDENTIAL_MISSING"]);

const isAuthorizationCode = (code: string) => AUTHORIZATION_CODES.has(code);

const errorText = (code: string) => ERROR_LABEL[code] || "MCP 操作失败";

/* ══════════════════════════════════════════════════════════════════════════
   小工具
   ══════════════════════════════════════════════════════════════════════════ */
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const asText = (v: unknown, fallback = "—"): string => {
  if (typeof v === "string") return v.trim() ? v : fallback;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : fallback;
  if (typeof v === "boolean") return v ? "是" : "否";
  return fallback;
};

const timeText = (ts: unknown): string => {
  const n = Number(ts);
  if (ts == null || !Number.isFinite(n)) return "—";
  return new Date(n).toLocaleString("zh-CN", { hour12: false });
};

/** 契约名优先，主进程实现名兜底（见 McpConnection 上的字段注释）。 */
const endpointOf = (c: McpConnection | null): Record<string, unknown> => {
  const v = c ? (c.endpointJson ?? c.endpoint) : null;
  return isObject(v) ? v : {};
};

const capabilitiesOf = (c: McpConnection | null): unknown =>
  c ? (c.capabilitiesJson ?? c.capabilities) : null;

const toolsRawOf = (c: McpConnection | null): unknown => {
  const v = c ? (c.toolsJson ?? c.tools) : null;
  return Array.isArray(v) ? v : null;
};

/** 工具描述被权限隐去：主进程 toolsHidden，或契约草稿名 toolsRedacted。 */
const toolsHiddenOf = (c: McpConnection | null): boolean =>
  !!c && (c.toolsHidden === true || c.toolsRedacted === true);

/** 协商是否已经发生过：没有协商结果时不假装"服务端没有能力"。 */
const negotiatedOf = (c: McpConnection | null): boolean =>
  !!c && (c.protocolVersion != null || c.status === "READY");

const toolsOf = (c: McpConnection | null): McpTool[] => {
  const raw = toolsRawOf(c);
  if (!raw) return [];
  return (raw as unknown[]).filter(isObject).map((t) => ({
    name: asText(t.name, "（未命名工具）"),
    description: typeof t.description === "string" ? t.description : undefined,
    inputSchemaSummary:
      typeof t.inputSchemaSummary === "string" ? t.inputSchemaSummary : undefined,
  }));
};

const statusMeta = (status: unknown): { label: string; tone: Tone } => {
  const key = typeof status === "string" ? status : "";
  return STATUS_META[key] || { label: (key || "未知状态") + "（未登记）", tone: "neutral" };
};

/** 响应字段名未被契约钉死，按 device / model 的既有口径容错读取。 */
const arrayOf = (res: McpResult, ...keys: string[]): unknown[] => {
  for (const k of keys) {
    const v = res[k];
    if (Array.isArray(v)) return v;
  }
  return [];
};

const pickConnection = (res: McpResult): McpConnection | null => {
  for (const k of ["connection", "item", "record"]) {
    const v = res[k];
    if (isObject(v) && typeof v.connectionId === "string") return v as unknown as McpConnection;
  }
  // 有的命令把记录平铺在顶层：只在真带 connectionId 时才认，避免把 {ok:true} 当记录。
  if (typeof res.connectionId === "string") return res as unknown as McpConnection;
  return null;
};

/**
 * 从 token 读**实际**时长。
 *
 * 必须读组件自己所在的元素，不能读 documentElement：产品内开关 .reduced 挂在
 * .desktop 上（main.tsx），:root 拿不到它的覆盖值。减少动态效果的两条路径
 * （产品内开关 / 系统级媒体查询）都把 --dur-* 归零，所以这里读到的就是终值 ——
 * 逻辑等待与动画时长因此不会分叉。
 */
const tokenMs = (el: HTMLElement | null, name: string): number => {
  if (!el || typeof window === "undefined") return 0;
  const raw = window.getComputedStyle(el).getPropertyValue(name).trim();
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return 0;
  if (raw.endsWith("ms")) return n;
  if (raw.endsWith("s")) return n * 1000;
  return n;
};

/* ══════════════════════════════════════════════════════════════════════════
   详情状态机
   ══════════════════════════════════════════════════════════════════════════ */
type DetailState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "ready"; connection: McpConnection }
  | { kind: "unauthorized"; code: string }
  | { kind: "error"; code: string };

type Failure = { code: string; context: string };

type Form = {
  name: string;
  transport: "stdio" | "http";
  location: "LOCAL_DEVICE" | "REMOTE_SERVICE";
  serverKey: string;
  url: string;
  authMode: "NONE" | "BEARER";
  credentialSecret: string;
  visibility: "PERSONAL" | "ORGANIZATION";
};

const emptyForm = (): Form => ({
  name: "",
  transport: "stdio",
  location: "LOCAL_DEVICE",
  serverKey: LOCAL_SERVER_KEYS[0],
  url: "",
  authMode: "NONE",
  credentialSecret: "",
  visibility: "PERSONAL",
});

type DialogKind = "create" | "edit" | "delete" | null;

/* ══════════════════════════════════════════════════════════════════════════
   页面
   ══════════════════════════════════════════════════════════════════════════ */
export function McpCenter({ role }: { role: string | null }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const bridge =
    typeof window !== "undefined" ? (window.openarc?.mcp as McpBridge | undefined) : undefined;
  const available = typeof bridge?.command === "function";
  const isAdmin = role === "ADMIN";

  /* 初值为 true：首屏在 useEffect 发命令之前不会先画一帧"还没有连接" ——
     那是**假空态**（列表其实还没回来）。真加载态与真空态必须分开。 */
  const [loading, setLoading] = useState(true);
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [listError, setListError] = useState<Failure | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({ kind: "none" });
  const [logs, setLogs] = useState<unknown[]>([]);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [newIds, setNewIds] = useState<string[]>([]);
  const [leaving, setLeaving] = useState<string[]>([]);

  /* 首次成功加载的 id 先"记成已见"：进入页面不是"列表插入"，不给整列表补入场动画。
     之后新增的行才走 MS §5 的列表插入动效。 */
  const seenRef = useRef<Set<string> | null>(null);

  const send = useCallback(
    async (command: string, payload: Record<string, unknown> = {}): Promise<McpResult> => {
      if (!bridge?.command) return { ok: false, error: "NO_BRIDGE" };
      try {
        const res = await bridge.command({ command, payload });
        return isObject(res) ? res : { ok: false, error: "INTERNAL_ERROR" };
      } catch {
        // 桥异常与后端异常一样收敛成可见错误码，不允许"点了没反应"。
        return { ok: false, error: "INTERNAL_ERROR" };
      }
    },
    [bridge],
  );

  const markSeen = (ids: string[]) => {
    if (seenRef.current === null) {
      seenRef.current = new Set(ids);
      setNewIds([]);
      return;
    }
    const fresh = ids.filter((id) => !seenRef.current!.has(id));
    for (const id of ids) seenRef.current.add(id);
    setNewIds(fresh);
  };

  const loadList = useCallback(
    async (opts?: { silent?: boolean }): Promise<boolean> => {
      if (!opts?.silent) setLoading(true);
      const res = await send("mcp/list");
      if (res.ok !== true) {
        setListError({ code: String(res.error || "INTERNAL_ERROR"), context: "读取连接列表" });
        if (!opts?.silent) setLoading(false);
        return false;
      }
      const items = arrayOf(res, "items", "connections").filter(isObject) as unknown as McpConnection[];
      setConnections(items);
      setListError(null);
      markSeen(items.map((c) => String(c.connectionId)));
      if (!opts?.silent) setLoading(false);
      return true;
    },
    [send],
  );

  const loadDetail = useCallback(
    async (connectionId: string) => {
      setSelectedId(connectionId);
      setDetail({ kind: "loading" });
      setLogs([]);
      setLogsError(null);
      const [g, l] = await Promise.all([
        send("mcp/get", { connectionId }),
        send("mcp/testLog", { connectionId, limit: TEST_LOG_LIMIT }),
      ]);
      if (g.ok !== true) {
        const code = String(g.error || "INTERNAL_ERROR");
        setDetail(
          isAuthorizationCode(code) ? { kind: "unauthorized", code } : { kind: "error", code },
        );
      } else {
        const connection = pickConnection(g);
        setDetail(
          connection ? { kind: "ready", connection } : { kind: "error", code: "RESPONSE_INCOMPLETE" },
        );
      }
      if (l.ok === true) setLogs(arrayOf(l, "items", "logs", "entries", "testLog"));
      else setLogsError(String(l.error || "INTERNAL_ERROR"));
    },
    [send],
  );

  useEffect(() => {
    if (!available) return;
    void loadList();
    // 只在挂载时拉一次；后续由动作成功后显式刷新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available]);

  /* MS §5 列表删除：先在原位播 160ms 退场（后续行自然移位），再真正摘掉这一行。
     等待时长从 token 读：减少动态效果下 --dur-quick = 0ms，立即摘除 ——
     功能不依赖动画结束（tokens.css 的硬要求）。 */
  const exitRow = (connectionId: string) => {
    setLeaving((cur) => (cur.includes(connectionId) ? cur : [...cur, connectionId]));
    const ms = tokenMs(rootRef.current, "--dur-quick");
    window.setTimeout(() => {
      setLeaving((cur) => cur.filter((x) => x !== connectionId));
      setConnections((cur) => cur.filter((c) => c.connectionId !== connectionId));
    }, ms);
  };

  const runAction = async (
    key: string,
    command: string,
    payload: Record<string, unknown>,
    context: string,
    connectionId: string,
  ) => {
    setBusy(key);
    setFailure(null);
    setNotice(null);
    const res = await send(command, payload);
    setBusy(null);
    if (res.ok !== true) {
      /* 失败也要把真实状态拿回来：后端已把 status / lastErrorCode / 实际协商版本落库，
         不刷新的话右侧还是失败前的旧投影（PLAN §22「认证失败重授权」入口会被延迟）。 */
      await loadList({ silent: true });
      await loadDetail(connectionId);
      setFailure({ code: String(res.error || "INTERNAL_ERROR"), context });
      return null;
    }
    setNotice(context + "已完成");
    await loadList({ silent: true });
    await loadDetail(connectionId);
    return res;
  };

  const openCreate = () => {
    setForm(emptyForm());
    setFailure(null);
    setNotice(null);
    setDialog("create");
  };

  const openEdit = (c: McpConnection) => {
    const ep = endpointOf(c);
    setForm({
      name: asText(c.name, ""),
      transport: c.transport === "http" ? "http" : "stdio",
      location: c.location === "REMOTE_SERVICE" ? "REMOTE_SERVICE" : "LOCAL_DEVICE",
      serverKey: typeof ep.serverKey === "string" ? ep.serverKey : LOCAL_SERVER_KEYS[0],
      url: typeof ep.url === "string" ? ep.url : "",
      authMode: c.authMode === "BEARER" ? "BEARER" : "NONE",
      credentialSecret: "",
      visibility: c.visibility === "ORGANIZATION" ? "ORGANIZATION" : "PERSONAL",
    });
    setFailure(null);
    setNotice(null);
    setDialog("edit");
  };

  /** 「重新授权」入口：有凭据的连接走编辑（只写凭据），无需授权的连接走重连。 */
  const openReauth = (c: McpConnection) => {
    if ((c.authMode || "NONE") === "BEARER") openEdit(c);
    else
      void runAction(
        "reconnect",
        "mcp/reconnect",
        { connectionId: c.connectionId },
        "重新连接",
        c.connectionId,
      );
  };

  /** 上行端点：stdio 只给白名单 serverKey，http 只给 URL —— endpointScope 由主进程推导。 */
  const endpointFor = (f: Form): Record<string, unknown> =>
    f.transport === "stdio" ? { serverKey: f.serverKey } : { url: f.url };

  const submitCreate = async () => {
    if (!form.name.trim()) {
      setFailure({ code: "LOCAL_INPUT_REQUIRED", context: "新建连接" });
      return;
    }
    setBusy("create");
    setFailure(null);
    const payload: Record<string, unknown> = {
      name: form.name,
      transport: form.transport,
      location: form.location,
      endpoint: endpointFor(form),
      authMode: form.authMode,
      visibility: form.visibility,
    };
    if (form.authMode === "BEARER" && form.credentialSecret) {
      payload.credentialSecret = form.credentialSecret;
    }
    const res = await send("mcp/create", payload);
    setBusy(null);
    if (res.ok !== true) {
      setFailure({ code: String(res.error || "INTERNAL_ERROR"), context: "新建连接" });
      return;
    }
    // 凭据只写不读：无论结果如何都不留在 state 里。
    setForm(emptyForm());
    setDialog(null);
    setNotice("已新建连接「" + payload.name + "」");
    await loadList({ silent: true });
    const created =
      typeof res.connectionId === "string"
        ? res.connectionId
        : (() => {
            const c = pickConnection(res);
            return c ? String(c.connectionId) : null;
          })();
    if (created) await loadDetail(created);
  };

  const submitEdit = async () => {
    if (detail.kind !== "ready") return;
    const connectionId = detail.connection.connectionId;
    const row = detail.connection;
    const ep = endpointOf(row);
    const nextEp = endpointFor(form);
    const endpointChanged =
      form.transport === "stdio"
        ? String(ep.serverKey ?? "") !== String(nextEp.serverKey ?? "")
        : String(ep.url ?? "") !== String(nextEp.url ?? "");
    const patch: Record<string, unknown> = {};
    if (form.name !== asText(row.name, "")) patch.name = form.name;
    if (endpointChanged) patch.endpoint = nextEp;
    if (form.authMode !== (row.authMode === "BEARER" ? "BEARER" : "NONE")) {
      patch.authMode = form.authMode;
    }
    if (
      form.visibility !==
      (row.visibility === "ORGANIZATION" ? "ORGANIZATION" : "PERSONAL")
    ) {
      patch.visibility = form.visibility;
    }
    // 凭据只写不读：留空表示不改动；NONE 下带 secret 会被后端以 MCP_INVALID_INPUT 拒绝。
    if (form.authMode === "BEARER" && form.credentialSecret) {
      patch.credentialSecret = form.credentialSecret;
    }
    if (!Object.keys(patch).length) {
      setDialog(null);
      setNotice("没有需要保存的改动");
      return;
    }
    setBusy("edit");
    setFailure(null);
    const res = await send("mcp/update", { connectionId, patch });
    setBusy(null);
    if (res.ok !== true) {
      setFailure({ code: String(res.error || "INTERNAL_ERROR"), context: "保存连接" });
      return;
    }
    // 换过凭据就接着做一次真实重连：主进程在 update 里已把状态重置为 DISABLED，
    // 「更新凭据并重连」这个入口不能只更新不重连（否则按钮文案在骗人）。
    const rebound = patch.credentialSecret !== undefined;
    setForm((f) => ({ ...f, credentialSecret: "" }));
    setDialog(null);
    setNotice(rebound ? "凭据已更新" : "连接已保存");
    await loadList({ silent: true });
    await loadDetail(connectionId);
    if (rebound) {
      await runAction(
        "reconnect",
        "mcp/reconnect",
        { connectionId },
        "用新凭据重新连接",
        connectionId,
      );
    }
  };

  const submitDelete = async () => {
    const target = detail.kind === "ready" ? detail.connection : null;
    if (!target) return;
    const connectionId = target.connectionId;
    setDialog(null);
    setBusy("delete");
    setFailure(null);
    setNotice(null);
    const res = await send("mcp/delete", { connectionId });
    setBusy(null);
    if (res.ok !== true) {
      setFailure({ code: String(res.error || "INTERNAL_ERROR"), context: "删除连接" });
      return;
    }
    setNotice("已删除连接「" + asText(target.name, connectionId) + "」");
    if (selectedId === connectionId) {
      setSelectedId(null);
      setDetail({ kind: "none" });
      setLogs([]);
      setLogsError(null);
    }
    exitRow(connectionId);
  };

  if (!available) {
    return (
      <div className="mcp-center" data-mcp-center="1" data-mcp-available="false">
        <PageState
          kind="unavailable"
          title="当前环境无法访问 MCP 域"
          description="只有在 OpenArc 桌面应用（Electron）里才会加载 MCP 桥。这里不展示任何模拟连接或模拟工具。"
        />
      </div>
    );
  }

  const selected = connections.find((c) => c.connectionId === selectedId) || null;
  const current = detail.kind === "ready" ? detail.connection : selected;
  const currentStatus = statusMeta(current?.status).label;
  /* 权限事实位来自后端投影（mcp-service #safe 的 access）。
     access 缺失时不禁用任何动作 —— 界面不自己当权限权威，由后端拒绝并回码。 */
  const access = current?.access ?? null;
  const canManage = access ? access.canManage === true : true;
  const canUseTools = access ? access.canUse !== false : true;
  const toolsDenied = detail.kind === "unauthorized" || toolsHiddenOf(current) || !canUseTools;
  const enabledOff = current?.enabled === false;
  const authNeeded =
    !!current &&
    (current.status === "AUTH_REQUIRED" ||
      (typeof current.lastErrorCode === "string" && AUTH_ERROR_CODES.has(current.lastErrorCode)));
  const discovering =
    busy === "connect" ||
    busy === "reconnect" ||
    busy === "test" ||
    (!!current && current.status === "CONNECTING");
  const activeBusy =
    busy === "connect" || busy === "reconnect" || busy === "test" || busy === "delete";

  const dialogs = (
    <>
      <Dialog
        open={dialog === "create"}
        title="新建 MCP 连接"
        onClose={() => {
          setForm((f) => ({ ...f, credentialSecret: "" }));
          setDialog(null);
        }}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              data-mcp-submit="create"
              status={busy === "create" ? "loading" : "idle"}
              onClick={() => void submitCreate()}
            >
              新建
            </Button>
          </>
        }
      >
        <div className="mcp-form" data-mcp-dialog="create">
          <TextField
            label="名称"
            data-mcp-field="name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <label className="mcp-field">
            <span>传输</span>
            <select
              data-mcp-field="transport"
              value={form.transport}
              onChange={(e) =>
                setForm({ ...form, transport: e.target.value === "http" ? "http" : "stdio" })
              }
            >
              <option value="stdio">stdio（本地进程）</option>
              <option value="http">http（远程服务）</option>
            </select>
          </label>
          <label className="mcp-field">
            <span>执行位置</span>
            <select
              data-mcp-field="location"
              value={form.location}
              onChange={(e) =>
                setForm({
                  ...form,
                  location: e.target.value === "REMOTE_SERVICE" ? "REMOTE_SERVICE" : "LOCAL_DEVICE",
                })
              }
            >
              <option value="LOCAL_DEVICE">本地设备</option>
              <option value="REMOTE_SERVICE">远程服务</option>
            </select>
          </label>
          {form.transport === "stdio" ? (
            <label className="mcp-field">
              <span>本地服务</span>
              <select
                data-mcp-field="serverKey"
                value={form.serverKey}
                onChange={(e) => setForm({ ...form, serverKey: e.target.value })}
              >
                {LOCAL_SERVER_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <small className="mcp-hint">
                本地连接只接受白名单服务键：主进程把它映射到受控程序与固定参数，界面不提供任意命令行。
              </small>
            </label>
          ) : (
            <>
              <TextField
                label="端点地址"
                data-mcp-field="url"
                placeholder="https://"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
              />
              <small className="mcp-hint" data-mcp-hint="endpoint">
                端点范围由主进程按地址推导并写进记录（本机 → LOCALHOST，公网 https → REMOTE_HTTPS，
                局域网默认拒绝），界面不提供手选。只接受 http(s)，禁止 file://、元数据地址与 URL
                内嵌凭据。
              </small>
            </>
          )}
          <label className="mcp-field">
            <span>授权方式</span>
            <select
              data-mcp-field="authMode"
              value={form.authMode}
              onChange={(e) =>
                setForm({ ...form, authMode: e.target.value === "BEARER" ? "BEARER" : "NONE" })
              }
            >
              <option value="NONE">无需授权 NONE</option>
              <option value="BEARER">Bearer 凭据 BEARER</option>
            </select>
          </label>
          {form.authMode === "BEARER" ? (
            <TextField
              label="凭据"
              type="password"
              data-mcp-field="credentialSecret"
              hint="只写不读：送出后不再显示，界面与命令返回值都不含凭据本身。"
              value={form.credentialSecret}
              onChange={(e) => setForm({ ...form, credentialSecret: e.target.value })}
            />
          ) : null}
          <label className="mcp-field">
            <span>可见性</span>
            <select
              data-mcp-field="visibility"
              value={form.visibility}
              onChange={(e) =>
                setForm({
                  ...form,
                  visibility: e.target.value === "ORGANIZATION" ? "ORGANIZATION" : "PERSONAL",
                })
              }
            >
              <option value="PERSONAL">仅本人 PERSONAL</option>
              <option value="ORGANIZATION">组织 ORGANIZATION</option>
            </select>
          </label>
        </div>
      </Dialog>

      <Dialog
        open={dialog === "edit"}
        title="编辑 MCP 连接"
        onClose={() => {
          setForm((f) => ({ ...f, credentialSecret: "" }));
          setDialog(null);
        }}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              data-mcp-submit="edit"
              status={busy === "edit" ? "loading" : "idle"}
              onClick={() => void submitEdit()}
            >
              保存
            </Button>
          </>
        }
      >
        <div className="mcp-form" data-mcp-dialog="edit">
          {current ? (
            <p className="mcp-muted" data-mcp-edit-fixed>
              传输 {TRANSPORT_LABEL[current.transport || ""] || asText(current.transport)} · 执行位置{" "}
              {LOCATION_LABEL[current.location || ""] || asText(current.location)}
              。两项在建连接时确定，要改请新建连接。
            </p>
          ) : null}
          <TextField
            label="名称"
            data-mcp-field="name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          {form.transport === "stdio" ? (
            <label className="mcp-field">
              <span>本地服务</span>
              <select
                data-mcp-field="serverKey"
                value={form.serverKey}
                onChange={(e) => setForm({ ...form, serverKey: e.target.value })}
              >
                {LOCAL_SERVER_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <TextField
                label="端点地址"
                data-mcp-field="url"
                placeholder="https://"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
              />
<small className="mcp-hint">端点范围由主进程按地址推导，界面不提供手选。</small>
            </>
          )}
          <label className="mcp-field">
            <span>授权方式</span>
            <select
              data-mcp-field="authMode"
              value={form.authMode}
              onChange={(e) =>
                setForm({ ...form, authMode: e.target.value === "BEARER" ? "BEARER" : "NONE" })
              }
            >
              <option value="NONE">无需授权 NONE</option>
              <option value="BEARER">Bearer 凭据 BEARER</option>
            </select>
          </label>
          {form.authMode === "BEARER" ? (
            <TextField
              label="更新凭据"
              type="password"
              data-mcp-field="credentialSecret"
              hint="留空表示不改动；新凭据送出后即从界面消失。"
              value={form.credentialSecret}
              onChange={(e) => setForm({ ...form, credentialSecret: e.target.value })}
            />
          ) : null}
          <label className="mcp-field">
            <span>可见性</span>
            <select
              data-mcp-field="visibility"
              value={form.visibility}
              onChange={(e) =>
                setForm({
                  ...form,
                  visibility: e.target.value === "ORGANIZATION" ? "ORGANIZATION" : "PERSONAL",
                })
              }
            >
              <option value="PERSONAL">仅本人 PERSONAL</option>
              <option value="ORGANIZATION">组织 ORGANIZATION</option>
            </select>
          </label>
        </div>
      </Dialog>

      <Dialog
        open={dialog === "delete"}
        title="删除连接"
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button variant="danger" data-mcp-submit="delete" onClick={() => void submitDelete()}>
              删除
            </Button>
          </>
        }
      >
        <div data-mcp-dialog="delete">
          <p>
            将删除连接「{current ? asText(current.name, current.connectionId) : ""}
            」及它的能力快照与测试日志。
          </p>
          <p className="mcp-muted">
            删除后不可恢复；远端服务本身不会被改动。请确认当前选中的就是这一个连接。
          </p>
        </div>
      </Dialog>
    </>
  );

  /* ── 首屏与列表错误（PLAN §22 的状态位）───────────────────────────────── */
  if (listError && !connections.length && !loading) {
    return (
      <div className="mcp-center" data-mcp-center="1" data-mcp-available="true">
        <div className="mcp-banner">
          <p className="mcp-error" role="alert" data-mcp-error data-mcp-error-code={listError.code}>
            {listError.context}未完成：{errorText(listError.code)}（{listError.code}）
          </p>
        </div>
        <PageState
          kind="error"
          title="读取连接列表失败"
          description="列表是后端按权限过滤后的真实结果，这里不展示任何缓存或模拟数据。"
          onAction={() => void loadList()}
        />
      </div>
    );
  }

  if (loading && !connections.length) {
    return (
      <div className="mcp-center" data-mcp-center="1" data-mcp-available="true">
        <PageState kind="loading" title="正在读取连接…" />
      </div>
    );
  }

  /* 无连接可添加（PLAN §22：空状态解释下一步） */
  if (!connections.length) {
    return (
      <div className="mcp-center" data-mcp-center="1" data-mcp-available="true">
        {notice ? (
          <div className="mcp-banner">
            <p className="mcp-notice" role="status" data-mcp-notice>
              {notice}
            </p>
          </div>
        ) : null}
        <div className="mcp-empty" data-mcp-empty>
          <PageState
            kind="empty"
            title="还没有连接"
            description="新建一个连接后，中心会做真实 MCP 握手（initialize → initialized → tools/list），把服务端实际协商出的版本、能力与工具写进记录。第一批不开放工具调用。"
          />
          {/* PageState 的 empty 语义是 action='none'（共享规范，不为这一页改），
              所以空态的新建入口由本页自己渲染 —— 否则列表为空时无法建第一条连接。 */}
          <Button variant="secondary" data-mcp-action="create" onClick={openCreate}>
            新建连接
          </Button>
        </div>
        {dialogs}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="mcp-center"
      data-mcp-center="1"
      data-mcp-available="true"
      data-mcp-role={isAdmin ? "ADMIN" : "MEMBER"}
    >
      <div className="mcp-banner">
        <div className="mcp-banner__row">
          <p className="mcp-banner__title">MCP 中心</p>
          <span className="mcp-muted">连接管理与能力发现（第一批不开放工具调用）</span>
        </div>
        {failure ? (
          <p className="mcp-error" role="alert" data-mcp-error data-mcp-error-code={failure.code}>
            {failure.context}未完成：{errorText(failure.code)}（{failure.code}）
          </p>
        ) : null}
        {notice ? (
          <p className="mcp-notice" role="status" data-mcp-notice>
            {notice}
          </p>
        ) : null}
      </div>

      <div className="mcp-split">
        <section className="mcp-list-pane" aria-label="MCP 连接列表">
          <div className="mcp-pane-head">
            <h3>连接</h3>
            <Button variant="secondary" size="sm" data-mcp-action="create" onClick={openCreate}>
              新建
            </Button>
          </div>
          <ul className="mcp-list" data-mcp-list>
            {connections.map((c) => {
              const meta = statusMeta(c.status);
              const tools = toolsOf(c);
              const hidden = toolsHiddenOf(c);
              const isLeaving = leaving.includes(c.connectionId);
              return (
                <li key={c.connectionId}>
                  <button
                    type="button"
                    className={
                      "mcp-row" +
                      (newIds.includes(c.connectionId) ? " is-new" : "") +
                      (isLeaving ? " is-leaving" : "")
                    }
                    data-mcp-connection={c.connectionId}
                    data-mcp-status={asText(c.status, "")}
                    aria-pressed={c.connectionId === selectedId}
                    disabled={isLeaving}
                    onClick={() => void loadDetail(c.connectionId)}
                  >
                    <span className="mcp-row__top">
                      <strong data-mcp-name>{asText(c.name, c.connectionId)}</strong>
                      <Badge tone={meta.tone} className="mcp-status">
                        {meta.label}
                      </Badge>
                    </span>
                    <span className="mcp-row__facts">
                      <span data-mcp-transport>
                        {TRANSPORT_LABEL[c.transport || ""] || asText(c.transport, "传输未知")}
                      </span>
                      <span data-mcp-location>
                        执行位置：{LOCATION_LABEL[c.location || ""] || asText(c.location, "未知")}
                      </span>
                      <span data-mcp-tool-count>
                        {hidden ? "无权查看" : tools.length ? tools.length + " 个工具" : "工具未发现"}
                      </span>
                      <span data-mcp-last-connected>最后连接 {timeText(c.lastConnectedAt)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {!isAdmin ? (
            <p className="mcp-role-note" data-mcp-role-note>
              权限口径（PLAN §27）：团队连接及授权由管理员管理；普通成员只能使用被授权给自己的连接。
              这里列出的连接由后端按权限过滤，被拒绝的动作会显示稳定错误码。
            </p>
          ) : null}
        </section>

        <section className="mcp-detail-pane" aria-label="连接详情" data-mcp-detail-state={detail.kind}>
          {detail.kind === "none" ? (
            <PageState
              kind="empty"
              title="选择一个连接"
              description="左侧选中的连接会显示配置、实际协商结果、能力与工具表，以及它的测试日志。"
            />
          ) : null}

          {detail.kind === "loading" ? (
            <PageState kind="loading" title="正在读取连接详情…" />
          ) : null}

          {detail.kind === "unauthorized" ? (
            <div data-mcp-detail-unauthorized data-mcp-error-code={detail.code}>
              <PageState
                kind="unauthorized"
                title="无权查看"
                description="当前账号没有被授权查看这个连接的配置与工具描述，后端没有下发它们。这里不显示任何工具名、描述或参数摘要。"
              />
            </div>
          ) : null}

          {detail.kind === "error" ? (
            <PageState
              kind="error"
              title={"读取连接详情失败：" + errorText(detail.code)}
              description={"后端返回的稳定错误码是 " + detail.code + "。"}
              onAction={() => selectedId && void loadDetail(selectedId)}
            />
          ) : null}

          {detail.kind === "ready" ? (
            <div className="mcp-detail" key={detail.connection.connectionId} data-mcp-detail>
              <header className="mcp-detail__head">
                <div className="mcp-detail__title">
                  <h3 data-mcp-detail-name>
                    {asText(detail.connection.name, detail.connection.connectionId)}
                  </h3>
                  <Badge tone={statusMeta(detail.connection.status).tone} className="mcp-status">
                    {statusMeta(detail.connection.status).label}
                  </Badge>
                </div>
                <div className="mcp-detail__facts">
                  <span data-mcp-detail-transport>
                    {TRANSPORT_LABEL[detail.connection.transport || ""] ||
                      asText(detail.connection.transport, "传输未知")}
                  </span>
                  <span data-mcp-detail-location>
                    执行位置：
                    {LOCATION_LABEL[detail.connection.location || ""] ||
                      asText(detail.connection.location, "未知")}
                  </span>
                </div>
                <div className="mcp-actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    data-mcp-action="toggle"
                    disabled={activeBusy || !canManage}
                    onClick={() =>
                      void runAction(
                        "toggle",
                        "mcp/setEnabled",
                        {
                          connectionId: detail.connection.connectionId,
                          enabled: !detail.connection.enabled,
                        },
                        detail.connection.enabled ? "停用连接" : "启用连接",
                        detail.connection.connectionId,
                      )
                    }
                  >
                    {detail.connection.enabled ? "停用" : "启用"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    data-mcp-action={detail.connection.lastConnectedAt == null ? "connect" : "reconnect"}
                    status={busy === "connect" || busy === "reconnect" ? "loading" : "idle"}
                    disabled={enabledOff || !canUseTools}
                    onClick={() =>
                      void runAction(
                        detail.connection.lastConnectedAt == null ? "connect" : "reconnect",
                        detail.connection.lastConnectedAt == null ? "mcp/connect" : "mcp/reconnect",
                        { connectionId: detail.connection.connectionId },
                        detail.connection.lastConnectedAt == null ? "连接" : "重新连接",
                        detail.connection.connectionId,
                      )
                    }
                  >
                    {detail.connection.lastConnectedAt == null ? "连接" : "重连"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    data-mcp-action="test"
                    status={busy === "test" ? "loading" : "idle"}
                    disabled={enabledOff || !canUseTools}
                    onClick={() =>
                      void runAction(
                        "test",
                        "mcp/test",
                        { connectionId: detail.connection.connectionId },
                        "连接测试",
                        detail.connection.connectionId,
                      )
                    }
                  >
                    测试
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-mcp-action="edit"
                    disabled={activeBusy || !canManage}
                    onClick={() => openEdit(detail.connection)}
                  >
                    编辑
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    data-mcp-action="delete"
                    disabled={activeBusy || !canManage}
                    onClick={() => {
                      setFailure(null);
                      setNotice(null);
                      setDialog("delete");
                    }}
                  >
                    删除
                  </Button>
                </div>
                {!canManage ? (
                  <p className="mcp-muted" data-mcp-note="no-manage">
                    当前账号对这个连接没有管理权（组织连接只有管理员可管理）：编辑、启用 / 停用、删除
                    都会被后端拒绝并回稳定错误码。
                  </p>
                ) : null}
                {enabledOff ? (
                  <p className="mcp-muted" data-mcp-note="disabled">
                    连接已停用：先启用，再做连接 / 重连 / 测试 —— 主进程对停用连接直接回
                    MCP_CONNECTION_DISABLED。
                  </p>
                ) : null}
                {current?.lastErrorCode === "MCP_SESSION_ENDED" ? (
                  <p className="mcp-muted" data-mcp-note="session-ended">
                    会话已结束（登出 / 锁屏 / 应用退出）：活连接、GET 流与在途请求都已收掉，所以状态回到
                    未连接的 DISABLED —— 不是连接故障，也不需要重新授权。「启用」意图保持不变，
                    重新登录后点连接即可恢复。
                  </p>
                ) : null}
                {!canUseTools ? (
                  <p className="mcp-muted" data-mcp-note="no-use">
                    当前应用没有被授 mcp.use：工具描述按权限不投影，所以工具表只显示「无权查看」。
                  </p>
                ) : null}
              </header>

              {/* 认证失败 → 重新授权入口（PLAN §22：认证失败重授权） */}
              {authNeeded ? (
                <div className="mcp-auth" data-mcp-auth-required>
                  <p className="mcp-auth__title">
                    认证失败，需要重新授权
                    {detail.connection.lastErrorCode
                      ? "（" + detail.connection.lastErrorCode + "）"
                      : ""}
                  </p>
                  <p className="mcp-muted">
                    {detail.connection.authMode === "BEARER"
                      ? "更新该连接的凭据后重新连接；凭据只写不读，界面不会回显旧值。"
                      : "该连接声明无需授权：先重连一次，仍未通过就检查服务端状态。"}
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    data-mcp-action="reauth"
                    status={busy === "reconnect" ? "loading" : "idle"}
                    onClick={() => openReauth(detail.connection)}
                  >
                    {detail.connection.authMode === "BEARER" ? "更新凭据并重连" : "重新连接"}
                  </Button>
                </div>
              ) : null}

              {/* 发现工具中：真实握手进行中，不伪造进度 */}
              {discovering ? (
                <div className="mcp-progress" role="status" data-mcp-discovering>
                  <span className="ds-spinner" aria-hidden="true" />
                  <span>
                    正在连接并发现工具…
                    {busy === "test"
                      ? "（测试会做一次真实握手）"
                      : "（initialize → notifications/initialized → tools/list）"}
                  </span>
                </div>
              ) : null}

              <section className="mcp-section" aria-label="配置">
                <h4>配置</h4>
                <dl className="mcp-kv" data-mcp-config>
                  <dt>名称</dt>
                  <dd data-mcp-config-name>
                    {asText(detail.connection.name, detail.connection.connectionId)}
                  </dd>
                  <dt>传输</dt>
                  <dd>
                    {TRANSPORT_LABEL[detail.connection.transport || ""] ||
                      asText(detail.connection.transport, "未知")}
                  </dd>
                  <dt>执行位置</dt>
                  <dd>
                    {LOCATION_LABEL[detail.connection.location || ""] ||
                      asText(detail.connection.location, "未知")}
                  </dd>
                  <dt>端点</dt>
                  <dd data-mcp-config-endpoint>{endpointText(detail.connection)}</dd>
                  <dt>授权方式</dt>
                  <dd data-mcp-config-auth>
                    {AUTH_MODE_LABEL[detail.connection.authMode || ""] ||
                      asText(detail.connection.authMode, "未知")}
                    {detail.connection.authMode === "BEARER" ? "（凭据只写不读）" : ""}
                  </dd>
                  <dt>凭据</dt>
                  <dd data-mcp-config-credential>
                    {detail.connection.authMode === "BEARER"
                      ? detail.connection.credentialConfigured
                        ? "已配置（只写不读，界面不显示内容）"
                        : "未配置"
                      : "该连接不使用凭据"}
                  </dd>
                  <dt>可见性</dt>
                  <dd data-mcp-config-visibility>
                    {VISIBILITY_LABEL[detail.connection.visibility || ""] ||
                      asText(detail.connection.visibility, "未知")}
                  </dd>
                  <dt>启用</dt>
                  <dd data-mcp-config-enabled>{detail.connection.enabled ? "已启用" : "已停用"}</dd>
                  <dt>更新时间</dt>
                  <dd>{timeText(detail.connection.updatedAt)}</dd>
                </dl>
              </section>

              <section className="mcp-section" aria-label="状态与最后错误">
                <h4>状态与最后错误</h4>
                <p className="mcp-kv-inline">
                  <span data-mcp-status-text>{currentStatus}</span>
                  <span className="mcp-muted" data-mcp-last-error>
                    {detail.connection.lastErrorCode
                      ? "最后错误：" +
                        errorText(detail.connection.lastErrorCode) +
                        "（" +
                        detail.connection.lastErrorCode +
                        "）"
                      : "没有记录到最后错误。"}
                  </span>
                </p>
                <p className="mcp-muted">最后连接时间 {timeText(detail.connection.lastConnectedAt)}</p>
              </section>

              <section className="mcp-section" aria-label="实际协商结果">
                <h4>实际协商结果</h4>
                <dl className="mcp-kv">
                  <dt>协议版本</dt>
                  <dd data-mcp-protocol-version>
                    {asText(detail.connection.protocolVersion, "尚未协商")}
                  </dd>
                  <dt>服务端名称</dt>
                  <dd data-mcp-server-name>{asText(detail.connection.serverName, "尚未协商")}</dd>
                  <dt>服务端版本</dt>
                  <dd data-mcp-server-version>
                    {asText(detail.connection.serverVersion, "尚未协商")}
                  </dd>
                  <dt>工具快照指纹</dt>
                  <dd className="mcp-mono" data-mcp-tools-hash>
                    {asText(detail.connection.toolsHash, "尚无快照")}
                  </dd>
                </dl>
                <div data-mcp-capabilities>
                  <p className="mcp-subhead">能力（服务端 capabilities 原样投影）</p>
                  <CapabilityList
                    value={capabilitiesOf(detail.connection)}
                    negotiated={negotiatedOf(detail.connection)}
                  />
                </div>
              </section>

              <section className="mcp-section" aria-label="工具">
                <div className="mcp-section-head">
                  <h4>工具</h4>
                  <span className="mcp-muted">第一批只发现、不调用</span>
                </div>
                {toolsDenied ? (
                  <p className="mcp-denied" data-mcp-tools-hidden>
                    无权查看
                  </p>
                ) : (
                  <ToolsTable tools={toolsOf(detail.connection)} />
                )}
              </section>

              <section className="mcp-section" aria-label="测试日志">
                <h4>测试日志</h4>
                {logsError ? (
                  <p className="mcp-error" role="alert" data-mcp-log-error>
                    读取测试日志未完成：{errorText(logsError)}（{logsError}）
                  </p>
                ) : null}
                <TestLogList logs={logs} />
              </section>
            </div>
          ) : null}
        </section>
      </div>
      {dialogs}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   子组件
   ══════════════════════════════════════════════════════════════════════════ */

const endpointText = (c: McpConnection): string => {
  const ep = endpointOf(c);
  if (c.transport === "http") {
    const url = asText(ep.url, "（未记录端点）");
    const scope = asText(ep.endpointScope, "");
    return scope ? url + " · " + (SCOPE_LABEL[scope] || scope) : url;
  }
  const key = asText(ep.serverKey, "（未记录本地服务）");
  return "本地服务键 " + key + "（主进程映射到受控程序与固定参数）";
};

/** MCP capability 的取值形态：true / {} / {listChanged:true} —— 原样翻译，不猜能力。 */
const CAPABILITY_LABEL: Record<string, string> = {
  tools: "工具 tools",
  resources: "资源 resources",
  prompts: "提示模板 prompts",
  logging: "日志 logging",
  completions: "补全 completions",
  experimental: "实验特性 experimental",
};

const CAPABILITY_FLAG_LABEL: Record<string, string> = {
  listChanged: "列表变更通知",
  subscribe: "支持订阅",
};

const capabilityFlagText = (v: unknown): string => {
  if (v === true) return "支持";
  if (v === false || v == null) return "不支持";
  if (isObject(v)) {
    const on = Object.entries(v)
      .filter(([, x]) => x === true)
      .map(([k]) => CAPABILITY_FLAG_LABEL[k] || k);
    return on.length ? on.join(" · ") : "已声明，但没有开启子能力";
  }
  return asText(v);
};

function CapabilityList({ value, negotiated }: { value: unknown; negotiated: boolean }) {
  const empty = value == null || (isObject(value) && !Object.keys(value).length);
  if (!negotiated && empty) {
    return (
      <p className="mcp-muted" data-mcp-capabilities-empty>
        服务端还没有返回能力：连接尚未成功协商。
      </p>
    );
  }
  if (value == null) {
    return (
      <p className="mcp-muted" data-mcp-capabilities-empty>
        服务端没有返回能力字段。
      </p>
    );
  }
  if (Array.isArray(value)) {
    if (!value.length) return <p className="mcp-muted">服务端返回了空的能力清单。</p>;
    return (
      <ul className="mcp-caps">
        {value.map((v, i) => (
          <li key={String(v) + i}>
            <span className="mcp-cap__name">{asText(v)}</span>
          </li>
        ))}
      </ul>
    );
  }
  if (isObject(value)) {
    const entries = Object.entries(value);
    if (!entries.length) return <p className="mcp-muted">服务端返回了空的能力对象。</p>;
    return (
      <ul className="mcp-caps">
        {entries.map(([k, v]) => (
          <li key={k} data-mcp-capability={k}>
            <span className="mcp-cap__name">{CAPABILITY_LABEL[k] || k}</span>
            <span className="mcp-cap__flag">{capabilityFlagText(v)}</span>
          </li>
        ))}
      </ul>
    );
  }
  return <p className="mcp-muted">{asText(value)}</p>;
}

function ToolsTable({ tools }: { tools: McpTool[] }) {
  if (!tools.length) {
    return (
      <p className="mcp-muted" data-mcp-tools-empty>
        还没有工具快照：连接成功后由 tools/list 分页发现。
      </p>
    );
  }
  return (
    <table className="mcp-tools" data-mcp-tools>
      <thead>
        <tr>
          <th scope="col">名称</th>
          <th scope="col">描述</th>
          <th scope="col">输入参数摘要</th>
        </tr>
      </thead>
      <tbody>
        {tools.map((t) => (
          <tr key={t.name} data-mcp-tool={t.name}>
            <td className="mcp-tool__name">{t.name}</td>
            <td>{t.description || "—"}</td>
            <td className="mcp-mono">{t.inputSchemaSummary || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * 测试日志条目的字段名没有在契约里钉死，按常见别名容错读取；
 * 一条都对不上时**原样打印这一条**（宁可难看，也不编造字段含义）。
 */
const LOG_KEYS = {
  /* 主进程 mcp-service.testLog 的投影就是 { at, level, event, errorCode, detail }；
     其余别名是容错，不是契约。 */
  time: ["at", "timestamp", "time", "startedAt", "createdAt"],
  phase: ["event", "phase", "stage", "step", "kind", "type"],
  level: ["level", "severity"],
  code: ["errorCode", "error", "code", "reason", "failureCode"],
  message: ["detail", "message", "summary", "text"],
  ok: ["ok", "success", "passed"],
};

const LEVEL_LABEL: Record<string, string> = {
  INFO: "信息",
  WARN: "注意",
  WARNING: "注意",
  ERROR: "失败",
  DEBUG: "调试",
};

const firstKey = (o: Record<string, unknown>, keys: string[]): string | null => {
  for (const k of keys) {
    const v = o[k];
    if (v == null || v === "") continue;
    if (typeof v === "number" || typeof v === "string") return String(v);
  }
  return null;
};

function TestLogList({ logs }: { logs: unknown[] }) {
  if (!logs.length) {
    return (
      <p className="mcp-muted" data-mcp-test-log-empty>
        还没有测试记录：先做一次连接或测试。
      </p>
    );
  }
  return (
    <ol className="mcp-logs" data-mcp-test-log>
      {logs.map((raw, i) => {
        const entry = isObject(raw) ? raw : null;
        const time = entry ? firstKey(entry, LOG_KEYS.time) : null;
        const phase = entry ? firstKey(entry, LOG_KEYS.phase) : null;
        const level = entry ? firstKey(entry, LOG_KEYS.level) : null;
        const code = entry ? firstKey(entry, LOG_KEYS.code) : null;
        const message = entry ? firstKey(entry, LOG_KEYS.message) : null;
        const okValue = entry
          ? LOG_KEYS.ok.map((k) => entry[k]).find((v) => typeof v === "boolean")
          : undefined;
        /* 结果只认两件事实：后端给的 errorCode，或 level=ERROR。
           两者都没有就写"结果未标注"，不把 INFO 记成"通过"。 */
        const failed = !!code || String(level || "").toUpperCase() === "ERROR";
        const result = failed ? "failed" : okValue === true ? "ok" : "unknown";
        return (
          <li className="mcp-log" key={i} data-mcp-log-index={i}>
            <span className="mcp-log__time mcp-mono">{time ? timeText(time) : "—"}</span>
            <span className="mcp-log__phase">{phase || "—"}</span>
            <span className="mcp-log__level" data-mcp-log-level={level || ""}>
              {level ? LEVEL_LABEL[String(level).toUpperCase()] || level : "—"}
            </span>
            <span className="mcp-log__result" data-mcp-log-result={result}>
              {result === "failed" ? "失败" : result === "ok" ? "通过" : "结果未标注"}
            </span>
            <span className="mcp-log__message">
              {code ? errorText(code) + "（" + code + "）" : message || "—"}
            </span>
            {!entry ? <span className="mcp-mono mcp-log__raw">{String(raw)}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   STATE_BRANCHES —— 「四类页面状态」在代码里的确切分支（供自查/评审逐条对照）

   1 无连接可添加    connections.length === 0（且不在首屏 loading / 无列表错误）
                     → <PageState kind="empty" title="还没有连接"> + 「新建连接」（openCreate），
                       data-mcp-empty
   2 发现工具中      discovering === true（busy ∈ {connect,reconnect,test} 或 status === "CONNECTING"）
                     → .mcp-progress + .ds-spinner，data-mcp-discovering；**没有百分比与进度条**
   3 认证失败重授权  authNeeded === true（status === "AUTH_REQUIRED"，或 lastErrorCode ∈ AUTH_ERROR_CODES）
                     → .mcp-auth + 「更新凭据并重连 / 重新连接」，data-mcp-auth-required；
                       BEARER 走编辑对话框（mcp/update，凭据只写不读），NONE 走 mcp/reconnect
   4 无权不暴露工具  主路径：记录可见但 toolsHidden === true（App 没有 mcp.use，主进程
                     mcp-service #mayUse 不投影工具描述）→ 工具段只显示「无权查看」，
                       data-mcp-tools-hidden；
                     极端路径：mcp/get 被后端以 MCP_UNAUTHORIZED 拒绝 → 详情只剩
                       <PageState kind="unauthorized" title="无权查看">，
                       配置、能力与工具表都不渲染。
                     （MCP_CONNECTION_NOT_FOUND 刻意**不**按"无权"渲染：主进程用它
                       对"别人的个人连接"保持不暴露存在，界面照原意显示"不存在或无权访问"。）
   ══════════════════════════════════════════════════════════════════════════ */
