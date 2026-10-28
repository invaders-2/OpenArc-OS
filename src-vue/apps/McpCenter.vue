<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import DsBadge from "../design-system/DsBadge.vue";
import DsButton from "../design-system/DsButton.vue";
import DsPageState from "../design-system/DsPageState.vue";
import McpCenterDialogs from "./McpCenterDialogs.vue";
import McpToolSwitch from "./McpToolSwitch.vue";
import {
  AUTH_ERROR_CODES,
  AUTH_MODE_LABEL,
  CAPABILITY_FLAG_LABEL,
  CAPABILITY_LABEL,
  LEVEL_LABEL,
  LOCAL_SERVER_KEYS,
  LOCATION_LABEL,
  LOG_KEYS,
  TEST_LOG_LIMIT,
  TRANSPORT_LABEL,
  VISIBILITY_LABEL,
  arrayOf,
  asText,
  capabilitiesOf,
  capabilityFlagText,
  emptyForm,
  endpointOf,
  endpointText,
  errorText,
  firstKey,
  isAuthorizationCode,
  isObject,
  negotiatedOf,
  pickConnection,
  statusMeta,
  timeText,
  tokenMs,
  toolsHiddenOf,
  toolsOf,
  type DetailState,
  type Failure,
  type Form,
  type McpConnection,
  type McpResult,
} from "./mcp-meta";

/**
 * D5-03 · MCP 中心（对齐 src/mcp/McpCenter.tsx，逐段迁移）。
 *
 * 只有管理面：连接列表、配置详情、能力发现、测试日志。契约 D 明确第一批不实现
 * tools/call，所以这里没有任何"运行工具"入口；任何调用入口后端都回
 * MCP_TOOL_INVOCATION_NOT_ENABLED。上行只经 window.openarc.mcp.command。
 *
 * 四类页面状态的落点与 React 一致：无连接可添加 / 发现工具中 / 认证失败重授权 / 无权不暴露工具。
 */
const props = defineProps<{ role: string | null }>();

type McpBridge = { command?: (cmd: Record<string, unknown>) => Promise<McpResult> };
const bridge: McpBridge | undefined =
  typeof window !== "undefined" ? (window.openarc?.mcp as McpBridge | undefined) : undefined;
const available = typeof bridge?.command === "function";
const isAdmin = computed(() => props.role === "ADMIN");

const rootRef = ref<HTMLElement | null>(null);

/* 初值为 true：首屏在发命令之前不会先画一帧"还没有连接" —— 那是假空态。 */
const loading = ref(true);
const connections = ref<McpConnection[]>([]);
const listError = ref<Failure | null>(null);
const selectedId = ref<string | null>(null);
const detail = ref<DetailState>({ kind: "none" });
const logs = ref<unknown[]>([]);
const logsError = ref<string | null>(null);
const busy = ref<string | null>(null);
const failure = ref<Failure | null>(null);
const notice = ref<string | null>(null);
const dialog = ref<"create" | "edit" | "delete" | null>(null);
const form = ref<Form>(emptyForm());
const newIds = ref<string[]>([]);
const leaving = ref<string[]>([]);

/* 首次成功加载的 id 先"记成已见"：进入页面不是"列表插入"，不给整列表补入场动画。 */
let seen: Set<string> | null = null;

async function send(command: string, payload: Record<string, unknown> = {}): Promise<McpResult> {
  if (!bridge?.command) return { ok: false, error: "NO_BRIDGE" };
  try {
    const res = await bridge.command({ command, payload });
    return isObject(res) ? res : { ok: false, error: "INTERNAL_ERROR" };
  } catch {
    return { ok: false, error: "INTERNAL_ERROR" };
  }
}

function markSeen(ids: string[]) {
  if (seen === null) {
    seen = new Set(ids);
    newIds.value = [];
    return;
  }
  const fresh = ids.filter((id) => !seen!.has(id));
  for (const id of ids) seen.add(id);
  newIds.value = fresh;
}

async function loadList(opts?: { silent?: boolean }): Promise<boolean> {
  if (!opts?.silent) loading.value = true;
  const res = await send("mcp/list");
  if (res.ok !== true) {
    listError.value = { code: String(res.error || "INTERNAL_ERROR"), context: "读取连接列表" };
    if (!opts?.silent) loading.value = false;
    return false;
  }
  const items = arrayOf(res, "items", "connections").filter(isObject) as unknown as McpConnection[];
  connections.value = items;
  listError.value = null;
  markSeen(items.map((c) => String(c.connectionId)));
  if (!opts?.silent) loading.value = false;
  if (items.length && !selectedId.value) void loadDetail(String(items[0].connectionId));
  return true;
}

async function loadDetail(connectionId: string) {
  selectedId.value = connectionId;
  detail.value = { kind: "loading" };
  logs.value = [];
  logsError.value = null;
  const [g, l] = await Promise.all([
    send("mcp/get", { connectionId }),
    send("mcp/testLog", { connectionId, limit: TEST_LOG_LIMIT }),
  ]);
  if (g.ok !== true) {
    const code = String(g.error || "INTERNAL_ERROR");
    detail.value = isAuthorizationCode(code) ? { kind: "unauthorized", code } : { kind: "error", code };
  } else {
    const connection = pickConnection(g);
    detail.value = connection ? { kind: "ready", connection } : { kind: "error", code: "RESPONSE_INCOMPLETE" };
  }
  if (l.ok === true) logs.value = arrayOf(l, "items", "logs", "entries", "testLog");
  else logsError.value = String(l.error || "INTERNAL_ERROR");
}

onMounted(() => {
  if (!available) return;
  void loadList();
});

/* MS §5 列表删除：先原位播退场再摘掉；等待时长从 token 读（减少动态效果下立即摘除）。 */
function exitRow(connectionId: string) {
  if (!leaving.value.includes(connectionId)) leaving.value = [...leaving.value, connectionId];
  const ms = tokenMs(rootRef.value, "--dur-quick");
  window.setTimeout(() => {
    leaving.value = leaving.value.filter((x) => x !== connectionId);
    connections.value = connections.value.filter((c) => c.connectionId !== connectionId);
  }, ms);
}

async function runAction(
  key: string,
  command: string,
  payload: Record<string, unknown>,
  context: string,
  connectionId: string,
): Promise<McpResult | null> {
  busy.value = key;
  failure.value = null;
  notice.value = null;
  const res = await send(command, payload);
  busy.value = null;
  if (res.ok !== true) {
    /* 失败也要把真实状态拿回来：后端已把 status / lastErrorCode / 实际协商版本落库。 */
    await loadList({ silent: true });
    await loadDetail(connectionId);
    failure.value = { code: String(res.error || "INTERNAL_ERROR"), context };
    return null;
  }
  notice.value = context + "已完成";
  await loadList({ silent: true });
  await loadDetail(connectionId);
  return res;
}

function openCreate() {
  form.value = emptyForm();
  failure.value = null;
  notice.value = null;
  dialog.value = "create";
}

function openEdit(c: McpConnection) {
  const ep = endpointOf(c);
  form.value = {
    name: asText(c.name, ""),
    transport: c.transport === "http" ? "http" : "stdio",
    location: c.location === "REMOTE_SERVICE" ? "REMOTE_SERVICE" : "LOCAL_DEVICE",
    serverKey: typeof ep.serverKey === "string" ? ep.serverKey : LOCAL_SERVER_KEYS[0],
    url: typeof ep.url === "string" ? ep.url : "",
    authMode: c.authMode === "BEARER" ? "BEARER" : "NONE",
    credentialSecret: "",
    visibility: c.visibility === "ORGANIZATION" ? "ORGANIZATION" : "PERSONAL",
  };
  failure.value = null;
  notice.value = null;
  dialog.value = "edit";
}

/** 「重新授权」入口：有凭据的连接走编辑（只写凭据），无需授权的连接走重连。 */
function openReauth(c: McpConnection) {
  if ((c.authMode || "NONE") === "BEARER") openEdit(c);
  else
    void runAction("reconnect", "mcp/reconnect", { connectionId: c.connectionId }, "重新连接", c.connectionId);
}

/** 上行端点：stdio 只给白名单 serverKey，http 只给 URL —— endpointScope 由主进程推导。 */
function endpointFor(f: Form): Record<string, unknown> {
  return f.transport === "stdio" ? { serverKey: f.serverKey } : { url: f.url };
}

function closeDialog() {
  form.value = { ...form.value, credentialSecret: "" };
  dialog.value = null;
}

async function submitCreate() {
  if (!form.value.name.trim()) {
    failure.value = { code: "LOCAL_INPUT_REQUIRED", context: "新建连接" };
    return;
  }
  const name = form.value.name;
  busy.value = "create";
  failure.value = null;
  const payload: Record<string, unknown> = {
    name: form.value.name,
    transport: form.value.transport,
    location: form.value.location,
    endpoint: endpointFor(form.value),
    authMode: form.value.authMode,
    visibility: form.value.visibility,
  };
  if (form.value.authMode === "BEARER" && form.value.credentialSecret) {
    payload.credentialSecret = form.value.credentialSecret;
  }
  const res = await send("mcp/create", payload);
  busy.value = null;
  if (res.ok !== true) {
    failure.value = { code: String(res.error || "INTERNAL_ERROR"), context: "新建连接" };
    return;
  }
  /* 凭据只写不读：无论结果如何都不留在 state 里。 */
  form.value = emptyForm();
  dialog.value = null;
  notice.value = "已新建连接「" + name + "」";
  await loadList({ silent: true });
  const created =
    typeof res.connectionId === "string"
      ? res.connectionId
      : (() => {
          const c = pickConnection(res);
          return c ? String(c.connectionId) : null;
        })();
  if (created) await loadDetail(created);
}

async function submitEdit() {
  const row = ready.value;
  if (!row) return;
  const connectionId = row.connectionId;
  const ep = endpointOf(row);
  const nextEp = endpointFor(form.value);
  const endpointChanged =
    form.value.transport === "stdio"
      ? String(ep.serverKey ?? "") !== String(nextEp.serverKey ?? "")
      : String(ep.url ?? "") !== String(nextEp.url ?? "");
  const patch: Record<string, unknown> = {};
  if (form.value.name !== asText(row.name, "")) patch.name = form.value.name;
  if (endpointChanged) patch.endpoint = nextEp;
  if (form.value.authMode !== (row.authMode === "BEARER" ? "BEARER" : "NONE")) {
    patch.authMode = form.value.authMode;
  }
  if (form.value.visibility !== (row.visibility === "ORGANIZATION" ? "ORGANIZATION" : "PERSONAL")) {
    patch.visibility = form.value.visibility;
  }
  /* 凭据只写不读：留空表示不改动；NONE 下带 secret 会被后端以 MCP_INVALID_INPUT 拒绝。 */
  if (form.value.authMode === "BEARER" && form.value.credentialSecret) {
    patch.credentialSecret = form.value.credentialSecret;
  }
  if (!Object.keys(patch).length) {
    dialog.value = null;
    notice.value = "没有需要保存的改动";
    return;
  }
  busy.value = "edit";
  failure.value = null;
  const res = await send("mcp/update", { connectionId, patch });
  busy.value = null;
  if (res.ok !== true) {
    failure.value = { code: String(res.error || "INTERNAL_ERROR"), context: "保存连接" };
    return;
  }
  /* 换过凭据就接着做一次真实重连（主进程在 update 里已把状态重置为 DISABLED）。 */
  const rebound = patch.credentialSecret !== undefined;
  form.value = { ...form.value, credentialSecret: "" };
  dialog.value = null;
  notice.value = rebound ? "凭据已更新" : "连接已保存";
  await loadList({ silent: true });
  await loadDetail(connectionId);
  if (rebound) {
    await runAction("reconnect", "mcp/reconnect", { connectionId }, "用新凭据重新连接", connectionId);
  }
}

async function submitDelete() {
  const target = ready.value;
  if (!target) return;
  const connectionId = target.connectionId;
  dialog.value = null;
  busy.value = "delete";
  failure.value = null;
  notice.value = null;
  const res = await send("mcp/delete", { connectionId });
  busy.value = null;
  if (res.ok !== true) {
    failure.value = { code: String(res.error || "INTERNAL_ERROR"), context: "删除连接" };
    return;
  }
  notice.value = "已删除连接「" + asText(target.name, connectionId) + "」";
  if (selectedId.value === connectionId) {
    selectedId.value = null;
    detail.value = { kind: "none" };
    logs.value = [];
    logsError.value = null;
  }
  exitRow(connectionId);
}

function onDialogSubmit(kind: "create" | "edit" | "delete") {
  if (kind === "create") void submitCreate();
  else if (kind === "edit") void submitEdit();
  else void submitDelete();
}

function retryList() {
  void loadList();
}

function reloadDetail() {
  if (selectedId.value) void loadDetail(selectedId.value);
}

/* ── 投影（与 React 逐项同义）───────────────────────────────────────────── */
const selected = computed(() => connections.value.find((c) => c.connectionId === selectedId.value) || null);
const ready = computed<McpConnection | null>(() => (detail.value.kind === "ready" ? detail.value.connection : null));
const current = computed<McpConnection | null>(() => ready.value ?? selected.value);
const unauthorizedCode = computed(() => (detail.value.kind === "unauthorized" ? detail.value.code : null));
const errorCode = computed(() => (detail.value.kind === "error" ? detail.value.code : null));
const currentStatus = computed(() => statusMeta(current.value?.status).label);
const access = computed(() => current.value?.access ?? null);
const canManage = computed(() => (access.value ? access.value.canManage === true : true));
const canUseTools = computed(() => (access.value ? access.value.canUse !== false : true));
const toolsDenied = computed(
  () => detail.value.kind === "unauthorized" || toolsHiddenOf(current.value) || !canUseTools.value,
);
const enabledOff = computed(() => current.value?.enabled === false);
const authNeeded = computed(
  () =>
    !!current.value &&
    (current.value.status === "AUTH_REQUIRED" ||
      (typeof current.value.lastErrorCode === "string" && AUTH_ERROR_CODES.has(current.value.lastErrorCode))),
);
const discovering = computed(
  () =>
    busy.value === "connect" ||
    busy.value === "reconnect" ||
    busy.value === "test" ||
    (!!current.value && current.value.status === "CONNECTING"),
);
const activeBusy = computed(
  () => busy.value === "connect" || busy.value === "reconnect" || busy.value === "test" || busy.value === "delete",
);

const rows = computed(() =>
  connections.value.map((c) => {
    const meta = statusMeta(c.status);
    const tools = toolsOf(c);
    return {
      c,
      meta,
      tools,
      hidden: toolsHiddenOf(c),
      isLeaving: leaving.value.includes(c.connectionId),
      isNew: newIds.value.includes(c.connectionId),
    };
  }),
);

const tools = computed(() => toolsOf(ready.value));
const capsValue = computed<unknown>(() => capabilitiesOf(ready.value));
const capsNegotiated = computed(() => negotiatedOf(ready.value));
const capsEmpty = computed(() => {
  const v = capsValue.value;
  return v == null || (isObject(v) && !Object.keys(v).length);
});
const capsIsArray = computed(() => Array.isArray(capsValue.value));
const capsArray = computed<unknown[]>(() => (Array.isArray(capsValue.value) ? capsValue.value : []));
const capsIsObject = computed(() => isObject(capsValue.value));
const capsEntries = computed<[string, unknown][]>(() =>
  isObject(capsValue.value) ? Object.entries(capsValue.value) : [],
);

function logOf(raw: unknown) {
  const entry = isObject(raw) ? raw : null;
  const time = entry ? firstKey(entry, LOG_KEYS.time) : null;
  const phase = entry ? firstKey(entry, LOG_KEYS.phase) : null;
  const level = entry ? firstKey(entry, LOG_KEYS.level) : null;
  const code = entry ? firstKey(entry, LOG_KEYS.code) : null;
  const message = entry ? firstKey(entry, LOG_KEYS.message) : null;
  const okValue = entry ? LOG_KEYS.ok.map((k) => entry[k]).find((v) => typeof v === "boolean") : undefined;
  /* 结果只认两件事实：后端给的 errorCode，或 level=ERROR；都不认就不写"通过"。 */
  const failed = !!code || String(level || "").toUpperCase() === "ERROR";
  const result = failed ? "failed" : okValue === true ? "ok" : "unknown";
  return { time, phase, level, code, message, result };
}
const logRows = computed(() => logs.value.map((raw, i) => ({ i, raw, ...logOf(raw) })));
</script>

<template>
  <!-- 无桥：当前环境没有 MCP 域 -->
  <div v-if="!available" class="split">
    <div class="split-main">
      <div class="mcp-center" data-mcp-center="1" data-mcp-available="false">
        <DsPageState
          kind="unavailable"
          title="当前环境无法访问 MCP 域"
          description="只有在 OpenArc 桌面应用（Electron）里才会加载 MCP 桥。这里不展示任何模拟连接或模拟工具。"
        />
      </div>
    </div>
  </div>

  <!-- 首屏列表错误 -->
  <div v-else-if="listError && !connections.length && !loading" class="split">
    <div class="split-main">
      <h1>MCP 中心</h1>
      <p class="subtitle">连接管理、能力发现与工具调用（每次调用都要单独审批）</p>
      <div class="mcp-center" data-mcp-center="1" data-mcp-available="true">
        <div class="mcp-banner">
          <p class="mcp-error" role="alert" data-mcp-error :data-mcp-error-code="listError.code">
            {{ listError.context }}未完成：{{ errorText(listError.code) }}（{{ listError.code }}）
          </p>
        </div>
        <DsPageState
          kind="error"
          title="读取连接列表失败"
          description="列表是后端按权限过滤后的真实结果，这里不展示任何缓存或模拟数据。"
          :on-action="retryList"
        />
      </div>
    </div>
  </div>

  <!-- 首屏加载 -->
  <div v-else-if="loading && !connections.length" class="split">
    <div class="split-main">
      <h1>MCP 中心</h1>
      <p class="subtitle">连接管理、能力发现与工具调用（每次调用都要单独审批）</p>
      <div class="mcp-center" data-mcp-center="1" data-mcp-available="true">
        <DsPageState kind="loading" title="正在读取连接…" />
      </div>
    </div>
  </div>

  <!-- 无连接可添加 -->
  <div v-else-if="!connections.length" class="split mcp-split-empty">
    <!-- 10-16：空列表也保留侧栏卡片（红绿灯落在卡片里，与其它分栏窗口一致）；
         新建入口仍只在 [data-mcp-empty] 内，列表头不渲染「新建」（探针约定）。 -->
    <nav class="split-side" aria-label="MCP 连接列表">
      <div class="mcp-pane-head"><h3>连接</h3></div>
      <p class="mcp-side-empty">还没有连接</p>
    </nav>
    <div class="split-main">
      <h1>MCP 中心</h1>
      <p class="subtitle">连接管理、能力发现与工具调用（每次调用都要单独审批）</p>
      <div class="mcp-center" data-mcp-center="1" data-mcp-available="true">
        <div v-if="notice" class="mcp-banner">
          <p class="mcp-notice" role="status" data-mcp-notice>{{ notice }}</p>
        </div>
        <div class="mcp-empty" data-mcp-empty>
          <DsPageState
            kind="empty"
            title="还没有连接"
            description="新建一个连接后，中心会做真实 MCP 握手（initialize → initialized → tools/list），把服务端实际协商出的版本、能力与工具写进记录。工具调用默认关闭，打开后每次调用仍要审批。"
          />
          <!-- PageState 的 empty 语义是 action='none'，所以空态的新建入口由本页自己渲染。 -->
          <DsButton variant="secondary" data-mcp-action="create" @click="openCreate">新建连接</DsButton>
        </div>
        <McpToolSwitch />
        <McpCenterDialogs
          :dialog="dialog"
          :form="form"
          :busy="busy"
          :current="current"
          @close="closeDialog"
          @update:form="form = $event"
          @submit="onDialogSubmit"
        />
      </div>
    </div>
  </div>

  <!-- 主状态：列表 + 详情 -->
  <div v-else ref="rootRef" class="split mcp-split">
    <nav class="split-side" aria-label="MCP 连接列表">
      <div class="mcp-pane-head">
        <h3>连接</h3>
        <DsButton variant="secondary" size="sm" data-mcp-action="create" @click="openCreate">新建</DsButton>
      </div>
      <ul class="mcp-list" data-mcp-list>
          <li v-for="r in rows" :key="r.c.connectionId">
            <button
              type="button"
              class="mcp-row"
              :class="{ 'is-new': r.isNew, 'is-leaving': r.isLeaving }"
              :data-mcp-connection="r.c.connectionId"
              :data-mcp-status="asText(r.c.status, '')"
              :aria-pressed="r.c.connectionId === selectedId ? 'true' : 'false'"
              :aria-current="r.c.connectionId === selectedId ? 'true' : undefined"
              :disabled="r.isLeaving"
              @click="loadDetail(r.c.connectionId)"
            >
              <span class="mcp-row__top">
                <strong data-mcp-name>{{ asText(r.c.name, r.c.connectionId) }}</strong>
                <DsBadge :tone="r.meta.tone" class="mcp-status">{{ r.meta.label }}</DsBadge>
              </span>
              <span class="mcp-row__facts">
                <span data-mcp-transport>
                  {{ TRANSPORT_LABEL[r.c.transport || ""] || asText(r.c.transport, "传输未知") }}
                </span>
                <span data-mcp-location>
                  执行位置：{{ LOCATION_LABEL[r.c.location || ""] || asText(r.c.location, "未知") }}
                </span>
                <span data-mcp-tool-count>
                  {{ r.hidden ? "无权查看" : r.tools.length ? r.tools.length + " 个工具" : "工具未发现" }}
                </span>
                <span data-mcp-last-connected>最后连接 {{ timeText(r.c.lastConnectedAt) }}</span>
              </span>
            </button>
          </li>
      </ul>
      <p v-if="!isAdmin" class="mcp-role-note" data-mcp-role-note>
        权限口径（PLAN §27）：团队连接及授权由管理员管理；普通成员只能使用被授权给自己的连接。
        这里列出的连接由后端按权限过滤，被拒绝的动作会显示稳定错误码。
      </p>
    </nav>

    <div class="split-main">
      <div class="mcp-toolbar">
        <strong class="mcp-toolbar__name">{{ ready?.name || "MCP 中心" }}</strong>
        <DsBadge v-if="ready" class="mcp-status" :class="{ long: ready.status !== 'CONNECTED' }" :tone="statusMeta(ready.status).tone">{{ ({ CONNECTED: '就绪', ERROR: '连接失败', DISABLED: '已停用', CONNECTING: '连接中' } as Record<string, string>)[String(ready.status)] || statusMeta(ready.status).label }}</DsBadge>
        <span class="toolbar-spacer" />
        <button v-if="ready" type="button" class="mcp-bar-btn" data-mcp-action="toolbar-toggle" :disabled="activeBusy || !canManage" @click="runAction('toggle', 'mcp/setEnabled', { connectionId: ready.connectionId, enabled: !ready.enabled }, ready.enabled ? '停用连接' : '启用连接', ready.connectionId)">{{ ready.enabled ? "停用" : "启用" }}</button>
        <button v-if="ready" type="button" class="mcp-bar-btn" data-mcp-action="toolbar-test" :disabled="enabledOff || !canUseTools" @click="runAction('test', 'mcp/test', { connectionId: ready.connectionId }, '连接测试', ready.connectionId)">测试连接</button>
        <details class="mcp-more"><summary aria-label="更多">⋯</summary><div class="mcp-more-menu"><McpToolSwitch /><button type="button" :disabled="activeBusy || !canManage" @click="openEdit(ready!)">编辑配置</button><button type="button" :disabled="activeBusy || !canManage" @click="failure = null; notice = null; dialog = 'delete'">删除连接</button></div></details>
      </div>
      <div class="mcp-center" data-mcp-center="1" data-mcp-available="true" :data-mcp-role="isAdmin ? 'ADMIN' : 'MEMBER'">
        <div class="mcp-banner">
          <p v-if="failure" class="mcp-error" role="alert" data-mcp-error :data-mcp-error-code="failure.code">
            {{ failure.context }}未完成：{{ errorText(failure.code) }}（{{ failure.code }}）
          </p>
          <p v-if="notice" class="mcp-notice" role="status" data-mcp-notice>{{ notice }}</p>
        </div>

        <section class="mcp-detail-pane" aria-label="连接详情" :data-mcp-detail-state="detail.kind">
        <DsPageState
          v-if="detail.kind === 'none'"
          kind="empty"
          title="选择一个连接"
          description="左侧选中的连接会显示配置、实际协商结果、能力与工具表，以及它的测试日志。"
        />

        <DsPageState v-if="detail.kind === 'loading'" kind="loading" title="正在读取连接详情…" />

        <div v-if="detail.kind === 'unauthorized'" data-mcp-detail-unauthorized :data-mcp-error-code="unauthorizedCode">
          <DsPageState
            kind="unauthorized"
            title="无权查看"
            description="当前账号没有被授权查看这个连接的配置与工具描述，后端没有下发它们。这里不显示任何工具名、描述或参数摘要。"
          />
        </div>

        <DsPageState
          v-if="detail.kind === 'error'"
          kind="error"
          :title="'读取连接详情失败：' + errorText(errorCode || '')"
          :description="'后端返回的稳定错误码是 ' + (errorCode || '') + '。'"
          :on-action="reloadDetail"
        />

        <div v-if="ready" :key="ready.connectionId" class="mcp-detail" data-mcp-detail>
          <header class="mcp-detail__head">
            <div class="mcp-detail__title">
              <h3 data-mcp-detail-name>{{ asText(ready.name, ready.connectionId) }}</h3>
              <DsBadge :tone="statusMeta(ready.status).tone" class="mcp-status">
                {{ statusMeta(ready.status).label }}
              </DsBadge>
            </div>
            <div class="mcp-detail__facts">
              <span data-mcp-detail-transport>
                {{ TRANSPORT_LABEL[ready.transport || ""] || asText(ready.transport, "传输未知") }}
              </span>
              <span data-mcp-detail-location>
                执行位置：{{ LOCATION_LABEL[ready.location || ""] || asText(ready.location, "未知") }}
              </span>
            </div>
            <div class="mcp-actions">
              <DsButton
                variant="secondary"
                size="sm"
                data-mcp-action="toggle"
                :disabled="activeBusy || !canManage"
                @click="
                  runAction(
                    'toggle',
                    'mcp/setEnabled',
                    { connectionId: ready.connectionId, enabled: !ready.enabled },
                    ready.enabled ? '停用连接' : '启用连接',
                    ready.connectionId,
                  )
                "
              >
                {{ ready.enabled ? "停用" : "启用" }}
              </DsButton>
              <DsButton
                variant="secondary"
                size="sm"
                :data-mcp-action="ready.lastConnectedAt == null ? 'connect' : 'reconnect'"
                :status="busy === 'connect' || busy === 'reconnect' ? 'loading' : 'idle'"
                :disabled="enabledOff || !canUseTools"
                @click="
                  ready.lastConnectedAt == null
                    ? runAction('connect', 'mcp/connect', { connectionId: ready.connectionId }, '连接', ready.connectionId)
                    : runAction('reconnect', 'mcp/reconnect', { connectionId: ready.connectionId }, '重新连接', ready.connectionId)
                "
              >
                {{ ready.lastConnectedAt == null ? "连接" : "重连" }}
              </DsButton>
              <DsButton
                variant="secondary"
                size="sm"
                data-mcp-action="test"
                :status="busy === 'test' ? 'loading' : 'idle'"
                :disabled="enabledOff || !canUseTools"
                @click="runAction('test', 'mcp/test', { connectionId: ready.connectionId }, '连接测试', ready.connectionId)"
              >
                测试
              </DsButton>
              <DsButton variant="ghost" size="sm" data-mcp-action="edit" :disabled="activeBusy || !canManage" @click="openEdit(ready)">
                编辑
              </DsButton>
              <DsButton
                variant="danger"
                size="sm"
                data-mcp-action="delete"
                :disabled="activeBusy || !canManage"
                @click="
                  failure = null;
                  notice = null;
                  dialog = 'delete';
                "
              >
                删除
              </DsButton>
            </div>
            <p v-if="!canManage" class="mcp-muted" data-mcp-note="no-manage">
              当前账号对这个连接没有管理权（组织连接只有管理员可管理）：编辑、启用 / 停用、删除
              都会被后端拒绝并回稳定错误码。
            </p>
            <p v-if="enabledOff" class="mcp-muted" data-mcp-note="disabled">
              连接已停用：先启用，再做连接 / 重连 / 测试 —— 主进程对停用连接直接回
              MCP_CONNECTION_DISABLED。
            </p>
            <p v-if="current?.lastErrorCode === 'MCP_SESSION_ENDED'" class="mcp-muted" data-mcp-note="session-ended">
              会话已结束（登出 / 锁屏 / 会话过期 / 应用退出）：活连接、GET 流与在途请求都已收掉，所以状态回到
              未连接的 DISABLED —— 不是连接故障，也不需要重新授权。「启用」意图保持不变，
              重新登录后点连接即可恢复。
            </p>
            <p v-if="!canUseTools" class="mcp-muted" data-mcp-note="no-use">
              当前应用没有被授 mcp.use：工具描述按权限不投影，所以工具表只显示「无权查看」。
            </p>
          </header>

          <!-- 认证失败 → 重新授权入口 -->
          <div v-if="authNeeded" class="mcp-auth" data-mcp-auth-required>
            <p class="mcp-auth__title">
              认证失败，需要重新授权{{ ready.lastErrorCode ? "（" + ready.lastErrorCode + "）" : "" }}
            </p>
            <p class="mcp-muted">
              {{
                ready.authMode === "BEARER"
                  ? "更新该连接的凭据后重新连接；凭据只写不读，界面不会回显旧值。"
                  : "该连接声明无需授权：先重连一次，仍未通过就检查服务端状态。"
              }}
            </p>
            <DsButton
              variant="secondary"
              size="sm"
              data-mcp-action="reauth"
              :status="busy === 'reconnect' ? 'loading' : 'idle'"
              @click="openReauth(ready)"
            >
              {{ ready.authMode === "BEARER" ? "更新凭据并重连" : "重新连接" }}
            </DsButton>
          </div>

          <!-- 发现工具中：真实握手进行中，不伪造进度 -->
          <div v-if="discovering" class="mcp-progress" role="status" data-mcp-discovering>
            <span class="ds-spinner" aria-hidden="true" />
            <span>
              正在连接并发现工具…
              {{ busy === "test" ? "（测试会做一次真实握手）" : "（initialize → notifications/initialized → tools/list）" }}
            </span>
          </div>

          <section class="mcp-section" aria-label="配置">
            <h4>配置</h4>
            <dl class="mcp-kv" data-mcp-config>
              <dt>名称</dt>
              <dd data-mcp-config-name>{{ asText(ready.name, ready.connectionId) }}</dd>
              <dt>传输</dt>
              <dd>{{ TRANSPORT_LABEL[ready.transport || ""] || asText(ready.transport, "未知") }}</dd>
              <dt>执行位置</dt>
              <dd>{{ LOCATION_LABEL[ready.location || ""] || asText(ready.location, "未知") }}</dd>
              <dt>端点</dt>
              <dd data-mcp-config-endpoint>{{ endpointText(ready) }}</dd>
              <dt>授权方式</dt>
              <dd data-mcp-config-auth>
                {{ AUTH_MODE_LABEL[ready.authMode || ""] || asText(ready.authMode, "未知") }}{{ ready.authMode === "BEARER" ? "（凭据只写不读）" : "" }}
              </dd>
              <dt>凭据</dt>
              <dd data-mcp-config-credential>
                {{
                  ready.authMode === "BEARER"
                    ? ready.credentialConfigured
                      ? "已配置（只写不读，界面不显示内容）"
                      : "未配置"
                    : "该连接不使用凭据"
                }}
              </dd>
              <dt>可见性</dt>
              <dd data-mcp-config-visibility>
                {{ VISIBILITY_LABEL[ready.visibility || ""] || asText(ready.visibility, "未知") }}
              </dd>
              <dt>启用</dt>
              <dd data-mcp-config-enabled>{{ ready.enabled ? "已启用" : "已停用" }}</dd>
              <dt>更新时间</dt>
              <dd>{{ timeText(ready.updatedAt) }}</dd>
            </dl>
          </section>

          <section class="mcp-section" aria-label="状态与最后错误">
            <h4>状态与最后错误</h4>
            <p class="mcp-kv-inline">
              <span data-mcp-status-text>{{ currentStatus }}</span>
              <span class="mcp-muted" data-mcp-last-error>
                {{
                  ready.lastErrorCode
                    ? "最后错误：" + errorText(ready.lastErrorCode) + "（" + ready.lastErrorCode + "）"
                    : "没有记录到最后错误。"
                }}
              </span>
            </p>
            <p class="mcp-muted">最后连接时间 {{ timeText(ready.lastConnectedAt) }}</p>
          </section>

          <section class="mcp-section" aria-label="实际协商结果">
            <h4>实际协商结果</h4>
            <dl class="mcp-kv">
              <dt>协议版本</dt>
              <dd data-mcp-protocol-version>{{ asText(ready.protocolVersion, "尚未协商") }}</dd>
              <dt>服务端名称</dt>
              <dd data-mcp-server-name>{{ asText(ready.serverName, "尚未协商") }}</dd>
              <dt>服务端版本</dt>
              <dd data-mcp-server-version>{{ asText(ready.serverVersion, "尚未协商") }}</dd>
              <dt>工具快照指纹</dt>
              <dd class="mcp-mono" data-mcp-tools-hash>{{ asText(ready.toolsHash, "尚无快照") }}</dd>
            </dl>
            <div data-mcp-capabilities>
              <p class="mcp-subhead">能力（服务端 capabilities 原样投影）</p>
              <template v-if="capsEmpty && !capsNegotiated">
                <p class="mcp-muted" data-mcp-capabilities-empty>服务端还没有返回能力：连接尚未成功协商。</p>
              </template>
              <template v-else-if="capsValue == null">
                <p class="mcp-muted" data-mcp-capabilities-empty>服务端没有返回能力字段。</p>
              </template>
              <template v-else-if="capsIsArray">
                <p v-if="!capsArray.length" class="mcp-muted">服务端返回了空的能力清单。</p>
                <ul v-else class="mcp-caps">
                  <li v-for="(v, i) in capsArray" :key="String(v) + i">
                    <span class="mcp-cap__name">{{ asText(v) }}</span>
                  </li>
                </ul>
              </template>
              <template v-else-if="capsIsObject">
                <p v-if="!capsEntries.length" class="mcp-muted">服务端返回了空的能力对象。</p>
                <ul v-else class="mcp-caps">
                  <li v-for="[k, v] in capsEntries" :key="k" :data-mcp-capability="k">
                    <span class="mcp-cap__name">{{ CAPABILITY_LABEL[k] || k }}</span>
                    <span class="mcp-cap__flag">{{ capabilityFlagText(v) }}</span>
                  </li>
                </ul>
              </template>
              <template v-else>
                <p class="mcp-muted">{{ asText(capsValue) }}</p>
              </template>
            </div>
          </section>

          <section class="mcp-section" aria-label="工具">
            <div class="mcp-section-head">
              <h4>工具 · {{ tools.length }}</h4>
              <span class="mcp-muted">第一批只发现、不调用</span>
            </div>
            <p v-if="toolsDenied" class="mcp-denied" data-mcp-tools-hidden>无权查看</p>
            <template v-else>
              <p v-if="!tools.length" class="mcp-muted" data-mcp-tools-empty>
                还没有工具快照：连接成功后由 tools/list 分页发现。
              </p>
              <table v-else class="mcp-tools" data-mcp-tools>
                <thead>
                  <tr>
                    <th scope="col">名称</th>
                    <th scope="col">描述</th>
                    <th scope="col">输入参数摘要</th>
                    <th scope="col">启用</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="t in tools" :key="t.name" :data-mcp-tool="t.name">
                    <td class="mcp-tool__name">{{ t.name }}</td>
                    <td>{{ t.description || "—" }}</td>
                    <td class="mcp-mono">{{ t.inputSchemaSummary || "—" }}</td>
                    <td><span class="mcp-tool-switch" role="switch" aria-checked="true" aria-disabled="true" title="工具级开关没有后端命令（NOT VERIFIED）" /></td>
                  </tr>
                </tbody>
              </table>
            </template>
          </section>

          <section class="mcp-section" aria-label="测试日志">
            <h4>测试日志</h4>
            <p v-if="logsError" class="mcp-error" role="alert" data-mcp-log-error>
              读取测试日志未完成：{{ errorText(logsError) }}（{{ logsError }}）
            </p>
            <p v-if="!logs.length" class="mcp-muted" data-mcp-test-log-empty>还没有测试记录：先做一次连接或测试。</p>
            <ol v-else class="mcp-logs" data-mcp-test-log>
              <li v-for="r in logRows" :key="r.i" class="mcp-log" :data-mcp-log-index="r.i">
                <span class="mcp-log__time mcp-mono">{{ r.time ? timeText(r.time) : "—" }}</span>
                <span class="mcp-log__phase">{{ r.phase || "—" }}</span>
                <span class="mcp-log__level" :data-mcp-log-level="r.level || ''">
                  {{ r.level ? LEVEL_LABEL[String(r.level).toUpperCase()] || r.level : "—" }}
                </span>
                <span class="mcp-log__result" :data-mcp-log-result="r.result">
                  {{ r.result === "failed" ? "失败" : r.result === "ok" ? "通过" : "结果未标注" }}
                </span>
                <span class="mcp-log__message">
                  {{ r.code ? errorText(r.code) + "（" + r.code + "）" : r.message || "—" }}
                </span>
                <span v-if="!isObject(r.raw)" class="mcp-mono mcp-log__raw">{{ String(r.raw) }}</span>
              </li>
            </ol>
          </section>
        </div>
        </section>
        <McpCenterDialogs
          :dialog="dialog"
          :form="form"
          :busy="busy"
          :current="current"
          @close="closeDialog"
          @update:form="form = $event"
          @submit="onDialogSubmit"
        />
      </div>
    </div>
  </div>
</template>
<style scoped>

.mcp-center { padding: 0 !important; }
.mcp-toolbar { height: 52px; min-height: 52px; display: flex; align-items: center; gap: 10px; padding: 0 20px; border-bottom: 0.5px solid var(--line); }
.mcp-toolbar__name { font-size: 15px; font-weight: var(--fw-medium); }
.mcp-bar-btn { height: 28px; padding: 0 12px; border-radius: var(--radius-pill); background: rgb(var(--text-rgb) / 0.07); font-size: var(--fs-caption); }
.mcp-more { position: relative; }
.mcp-more > summary { list-style: none; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; }
.mcp-more > summary::-webkit-details-marker { display: none; }
.mcp-more-menu { position: absolute; right: 0; top: 30px; z-index: 20; min-width: 120px; padding: 4px; border-radius: var(--radius-md); background: rgb(var(--content-rgb) / 0.98); box-shadow: var(--elevation-2); display: flex; flex-direction: column; }
.mcp-more-menu button { text-align: left; padding: 6px 8px; border-radius: var(--radius-sm); font-size: var(--fs-caption); }
.mcp-kv { padding: 14px 16px; border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.035); }
.mcp-tool-switch { width: 36px; height: 21px; border-radius: 999px; background: rgb(var(--text-rgb) / 0.85); position: relative; display: inline-block; }
.mcp-tool-switch::after { content: ""; position: absolute; width: 17px; height: 17px; border-radius: 50%; background: #fff; top: 2px; left: 17px; }
.mcp-tool-switch[aria-disabled="true"] { opacity: 0.55; }
.mcp-tools tbody tr { height: 41px; }

.mcp-split { gap: 0; }
.mcp-split .split-main { padding: 0 !important; }
.mcp-split .split-side { flex: 0 0 250px; width: 250px; }
.mcp-pane-head { padding-right: 16px; }
.mcp-pane-head [data-mcp-action="create"] { min-width: 63px; height: 26px; }

.mcp-split { padding: 0 !important; gap: 0 !important; }
.mcp-split .split-side { margin: 8px 0 8px 8px !important; flex: 0 0 250px; width: 250px; }
.mcp-split .split-main { padding: 0 !important; margin: 0 !important; }
.mcp-toolbar { margin: 0 !important; }
.mcp-detail__head { display: none !important; }

.mcp-pane-head { padding-right: 8px; padding-top: 4px; }
.mcp-split .split-main { margin-left: -6px !important; }
.mcp-toolbar .mcp-status { width: 38px; min-width: 38px; height: 20px; padding: 0; justify-content: center; overflow: hidden; }
.mcp-detail-pane { padding: 0 24px; }
.mcp-section[aria-label="状态与最后错误"], .mcp-section[aria-label="实际协商结果"] { display: none !important; }
.mcp-kv { padding: 10px 14px; gap: 6px 12px; font-size: var(--fs-caption); }
.mcp-kv dt, .mcp-kv dd { line-height: 1.5; }
.mcp-tools tbody tr { height: 63.7px; }
.mcp-more-menu { width: 260px; }
.mcp-more-menu .mcp-tool-switch { display: none; }

.mcp-detail-pane { padding-top: 8px !important; }
.mcp-section h4 { margin: 6px 0 8px; }
.mcp-kv { height: 181px; box-sizing: border-box; overflow: hidden; padding: 14px; }
.mcp-tools th:last-child, .mcp-tools td:last-child { width: 80px; text-align: right; padding-right: 16px; }
.mcp-toolbar__name { width: 130px; }

.mcp-toolbar__name { width: 115px; }
.mcp-detail-pane { padding-top: 0 !important; }
.mcp-section:first-child h4 { margin-top: -28px; }
.mcp-section[aria-label="工具"] { margin-top: 0; }

.mcp-detail-pane { margin-top: -14px !important; }

.mcp-tools td:last-child { height: 63.7px; display: flex; align-items: center; justify-content: flex-end; }

.mcp-toolbar .mcp-status.long { width: auto !important; min-width: 0; max-width: 96px; }
.mcp-kv dt:nth-of-type(1), .mcp-kv dd:nth-of-type(1),
.mcp-kv dt:nth-of-type(6), .mcp-kv dd:nth-of-type(6),
.mcp-kv dt:nth-of-type(8), .mcp-kv dd:nth-of-type(8) { display: none; }
.mcp-kv { padding: 14px; }

.mcp-section[aria-label="工具"] { margin-top: 0 !important; }
.mcp-section[aria-label="工具"] h4 { margin: 12px 0 0; }
.mcp-tools thead th { height: 24px; }

.mcp-section[aria-label="工具"] .mcp-section-head { margin: 0; padding: 0; align-items: center; gap: 6px; }
.mcp-section[aria-label="工具"] .mcp-section-head h4 { margin: 0; }
.mcp-section[aria-label="工具"] .mcp-section-head span { display: none; }
.mcp-tools { margin-top: 12px; }

.mcp-tools thead { display: none; }
.mcp-tools { margin-top: 1.6px; table-layout: fixed; width: 100%; }

.mcp-tools td:last-child { width: 80px !important; min-width: 80px; max-width: 80px; }
.mcp-tools td:nth-child(1) { width: 170px; }
.mcp-tools td:nth-child(2) { width: 300px; }
.mcp-tools td:nth-child(3) { width: 164px; }
</style>
