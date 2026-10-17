<script setup lang="ts">
/**
 * 设置 · 局域网与设备 · 局域网协作（task-8 A / desktop/lan/*）。
 *
 * 只通过 window.openarc.desktop.command 派发受控命令：
 *   status / start / stop / pairing/create / pair。
 * 行为边界：
 *   · 默认关闭，显式开启后才监听 0.0.0.0 随机端口；关闭后零监听；
 *   · 配对码与令牌都只显示一次：只存在组件内存里，不写 localStorage、不 console.log；
 *     关闭面板或停止服务即从界面清除（停止会由主进程清空令牌 / 配对码 / 房间）；
 *   · 令牌只读，不授予画布编辑权；状态里的错误原样展示，不把失败包装成成功；
 *   · pair 是桌面域命令，真实远端设备无法直接调用；这里把它放在「高级」里作为本机验证入口。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import DsBadge from "../design-system/DsBadge.vue";
import DsButton from "../design-system/DsButton.vue";
import DsDialog from "../design-system/DsDialog.vue";
import DsPageState from "../design-system/DsPageState.vue";

type DesktopResult = { ok?: boolean; value?: unknown; error?: string; message?: string; detail?: unknown };
type LanPairingStatus = { active: boolean; expiresAt: number | null; canvasId: string | null; createdAt: number | null };
type LanStatus = {
  enabled: boolean;
  listening: boolean;
  binding: string | null;
  port: number | null;
  path: string;
  clients: number;
  tokens: number;
  pairing: LanPairingStatus;
  optIn: boolean;
  readOnly: boolean;
  lastError: string | null;
};
type PairingView = { code: string; expiresAt: number | null; port: number | null; binding: string | null; path: string; canvasId: string | null };
type TokenView = { token: string; tokenId: string; expiresAt: number | null; ws: string };

type DesktopBridge = { command?: (command: Record<string, unknown>) => Promise<unknown> };
const bridge = typeof window !== "undefined" ? ((window.openarc as { desktop?: DesktopBridge } | undefined)?.desktop ?? null) : null;
const available = !!bridge && typeof bridge.command === "function";

const LAN_ERROR_TEXT: Record<string, string> = {
  NO_BRIDGE: "当前环境没有桌面桥，局域网协作不可用",
  LOCAL_PROXY_NOT_READY: "桌面域尚未装配",
  LOCAL_PROXY_DEPENDENCY_UNAVAILABLE: "局域网协作服务尚未装配",
  LOCAL_PROXY_INVALID_INPUT: "请求参数不合法",
  LOCAL_PROXY_COMMAND_NOT_ALLOWED: "这个桌面命令没有被白名单允许",
  LOCAL_PROXY_INTERNAL: "桌面域内部错误",
  NOT_READY: "请先开启局域网协作",
  FORBIDDEN: "后端拒绝：会话无效，或局域网协作被禁用",
  INVALID_INPUT: "配对码格式不正确（8 位字母数字，可带连字符）",
  NOT_FOUND: "配对码不存在、已过期或已被使用",
  LAN_INTERNAL: "局域网协作服务内部错误",
};

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function resultErrorText(res: DesktopResult | null, fallback = "操作没有完成"): string {
  if (!res) return fallback;
  const code = String(res.error || "LAN_INTERNAL");
  const detail = textOf(res.detail).trim();
  const message = textOf(res.message).trim();
  const detailText = detail && detail !== code ? detail : message;
  const friendly = LAN_ERROR_TEXT[code] || fallback;
  const suffix = code ? "（" + code + "）" : "";
  return friendly + (detailText && detailText !== friendly ? "：" + detailText : "") + suffix;
}
function statusOf(value: unknown): LanStatus | null {
  const raw = recordOf(value);
  if (typeof raw.enabled !== "boolean" && typeof raw.listening !== "boolean") return null;
  const pairing = recordOf(raw.pairing);
  return {
    enabled: raw.enabled === true,
    listening: raw.listening === true,
    binding: textOf(raw.binding) || null,
    port: numberOf(raw.port),
    path: textOf(raw.path) || "/api/canvas/collab",
    clients: numberOf(raw.clients) || 0,
    tokens: numberOf(raw.tokens) || 0,
    pairing: {
      active: pairing.active === true,
      expiresAt: numberOf(pairing.expiresAt),
      canvasId: textOf(pairing.canvasId) || null,
      createdAt: numberOf(pairing.createdAt),
    },
    optIn: raw.optIn !== false,
    readOnly: raw.readOnly !== false,
    lastError: textOf(raw.lastError) || null,
  };
}

const loading = ref(false);
const busy = ref<string | null>(null);
const failure = ref<{ code: string; text: string } | null>(null);
const notice = ref("");
const status = ref<LanStatus | null>(null);
const statusFailure = ref<string | null>(null);
const pairing = ref<PairingView | null>(null);
const pairInput = ref("");
const pairToken = ref<TokenView | null>(null);
const pairBusy = ref(false);
const pairFailure = ref<string | null>(null);
const stopDialog = ref(false);
const copied = ref<string | null>(null);
const now = ref(Date.now());
let pollTimer: number | null = null;
let clockTimer: number | null = null;
let copyTimer: number | null = null;

const enabled = computed(() => status.value?.enabled === true && status.value?.listening === true);
const statusLabel = computed(() => {
  if (loading.value && !status.value) return "读取中";
  if (statusFailure.value) return "状态未知";
  return enabled.value ? "监听中" : "已关闭";
});
const statusTone = computed<"neutral" | "success" | "warning">(() => (enabled.value ? "success" : statusFailure.value ? "warning" : "neutral"));
const remaining = computed(() => {
  const expires = pairing.value?.expiresAt ?? (status.value?.pairing.active ? status.value.pairing.expiresAt : null);
  if (expires == null) return "";
  const total = Math.max(0, Math.floor((expires - now.value) / 1000));
  return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
});
const statusPairingRemaining = computed(() => {
  const expires = status.value?.pairing.active ? status.value.pairing.expiresAt : null;
  if (expires == null) return "";
  const total = Math.max(0, Math.floor((expires - now.value) / 1000));
  return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
});
const listeningAddress = computed(() => {
  if (!status.value || !status.value.listening) return "";
  return (status.value.binding || "0.0.0.0") + ":" + String(status.value.port ?? "—");
});

async function send(command: string, payload: Record<string, unknown> = {}): Promise<DesktopResult> {
  if (!available || !bridge || typeof bridge.command !== "function") return { ok: false, error: "NO_BRIDGE" };
  try {
    const res = (await bridge.command({ command, payload })) as DesktopResult | null;
    return res && typeof res === "object" ? res : { ok: false, error: "LOCAL_PROXY_INTERNAL" };
  } catch (error) {
    return { ok: false, error: "LOCAL_PROXY_INTERNAL", detail: String((error as Error)?.message || error) };
  }
}

function clearSecrets() {
  pairing.value = null;
  pairToken.value = null;
  pairInput.value = "";
  pairFailure.value = null;
}

function applyStatus(res: DesktopResult) {
  const value = recordOf(res.value);
  const next = statusOf(value.status) || statusOf(value);
  if (!next) {
    statusFailure.value = "状态字段不完整";
    return;
  }
  status.value = next;
  statusFailure.value = null;
  if (!next.listening) {
    /* 主进程已停止（可能是别的入口触发的）：界面上的配对码与令牌立刻作废显示。 */
    pairing.value = null;
    pairToken.value = null;
    pairFailure.value = null;
  }
}

async function loadStatus(silent = false) {
  if (!available) return;
  if (!silent) loading.value = true;
  const res = await send("desktop/lan/status");
  if (!silent) loading.value = false;
  if (!res.ok) {
    statusFailure.value = resultErrorText(res, "读取局域网状态失败");
    return;
  }
  applyStatus(res);
}

async function start() {
  busy.value = "start";
  failure.value = null;
  notice.value = "";
  const res = await send("desktop/lan/start");
  busy.value = null;
  if (!res.ok) {
    failure.value = { code: String(res.error || "LAN_INTERNAL"), text: resultErrorText(res, "开启局域网协作失败") };
    return;
  }
  applyStatus(res);
  await loadStatus(true);
  notice.value = status.value?.listening
    ? "已开启：监听 " + listeningAddress.value + "，未持令牌的连接会被拒绝；令牌只读，不能编辑画布。"
    : "开启命令已返回，但没有拿到监听状态；请查看状态行。";
}

function askStop() {
  stopDialog.value = true;
}

async function stop() {
  busy.value = "stop";
  failure.value = null;
  notice.value = "";
  const res = await send("desktop/lan/stop");
  busy.value = null;
  stopDialog.value = false;
  clearSecrets();
  if (!res.ok) {
    failure.value = { code: String(res.error || "LAN_INTERNAL"), text: resultErrorText(res, "停止局域网协作失败") };
    await loadStatus(true);
    return;
  }
  applyStatus(res);
  await loadStatus(true);
  notice.value = "已停止并撤销：监听已关闭，配对码、已签发令牌与局域网房间都已被主进程清空（不是暂停）。";
}

async function toggle() {
  if (busy.value || loading.value) return;
  if (enabled.value) askStop();
  else await start();
}

async function createPairing() {
  if (!enabled.value) return;
  busy.value = "pairing";
  failure.value = null;
  notice.value = "";
  const res = await send("desktop/lan/pairing/create");
  busy.value = null;
  if (!res.ok) {
    failure.value = { code: String(res.error || "LAN_INTERNAL"), text: resultErrorText(res, "生成配对码失败") };
    return;
  }
  const value = recordOf(res.value);
  const code = textOf(value.code);
  if (!code) {
    failure.value = { code: "LAN_INTERNAL", text: "生成配对码失败：后端没有返回配对码" };
    return;
  }
  pairing.value = {
    code,
    expiresAt: numberOf(value.expiresAt),
    port: numberOf(value.port),
    binding: textOf(value.binding) || null,
    path: textOf(value.path) || "/api/canvas/collab",
    canvasId: textOf(value.canvasId) || null,
  };
  pairToken.value = null;
  pairFailure.value = null;
  notice.value = "已生成一次性配对码：只显示这一次，10 分钟内有效；换到令牌或重新生成都会让旧码作废。";
  await loadStatus(true);
}

async function pairNow() {
  const code = pairInput.value.trim();
  if (!code) {
    pairFailure.value = "先填入配对码。";
    return;
  }
  if (!enabled.value) {
    pairFailure.value = "先开启局域网协作，再验证配对码。";
    return;
  }
  pairBusy.value = true;
  pairFailure.value = null;
  const res = await send("desktop/lan/pair", { code });
  pairBusy.value = false;
  if (!res.ok) {
    pairFailure.value = resultErrorText(res, "配对码换令牌失败");
    return;
  }
  const value = recordOf(res.value);
  const token = textOf(value.token);
  if (!token) {
    pairFailure.value = "配对命令返回成功，但没有令牌；已按失败处理，不显示假令牌。";
    return;
  }
  const ws = recordOf(value.ws);
  pairToken.value = {
    token,
    tokenId: textOf(value.tokenId),
    expiresAt: numberOf(value.expiresAt),
    ws: "ws://" + (textOf(ws.binding) || "127.0.0.1") + ":" + String(numberOf(ws.port) ?? "—") + (textOf(ws.path) || "/api/canvas/collab"),
  };
  pairing.value = null;
  pairInput.value = "";
  notice.value = "已用配对码换取只读令牌；令牌只显示这一次，不写日志、不落盘。";
  await loadStatus(true);
}

async function copy(value: string, key: string) {
  try {
    await navigator.clipboard.writeText(value);
    copied.value = key;
    if (copyTimer !== null) window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      copied.value = null;
      copyTimer = null;
    }, 2000);
  } catch {
    copied.value = "failed:" + key;
  }
}

function formatTime(ts: number | null): string {
  if (ts == null) return "—";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

onMounted(() => {
  if (!available) return;
  void loadStatus();
  pollTimer = window.setInterval(() => void loadStatus(true), 5_000);
  clockTimer = window.setInterval(() => (now.value = Date.now()), 1_000);
});
onBeforeUnmount(() => {
  if (pollTimer !== null) window.clearInterval(pollTimer);
  if (clockTimer !== null) window.clearInterval(clockTimer);
  if (copyTimer !== null) window.clearTimeout(copyTimer);
  pollTimer = null;
  clockTimer = null;
  copyTimer = null;
  /* 关闭面板不再展示配对码/令牌（只显示一次）；如需作废服务端配对码，请停止服务。 */
  clearSecrets();
});
</script>

<template>
  <div v-if="!available" data-lan-panel="1" data-lan-available="false">
    <DsPageState
      kind="unavailable"
      title="当前环境没有桌面桥"
      description="局域网协作需要 OpenArc 桌面应用（Electron）的 desktop 域；这里不展示模拟状态。"
    />
  </div>

  <section v-else class="device-section lan-panel" aria-label="局域网协作" data-lan-panel="1" data-lan-available="true" :data-lan-enabled="enabled ? 'true' : 'false'">
    <div class="device-section-head">
      <h3>局域网协作</h3>
      <DsBadge :tone="statusTone" data-lan-status-badge>{{ statusLabel }}</DsBadge>
    </div>

    <p v-if="failure" class="device-error" role="alert" :data-lan-error="failure.code">{{ failure.text }}</p>
    <p v-if="statusFailure" class="device-error" role="alert" data-lan-status-error>{{ statusFailure }}</p>
    <p v-if="status?.lastError" class="device-error" role="alert" data-lan-last-error>最近一次错误：{{ status.lastError }}</p>
    <p v-if="notice" class="device-note" role="status" data-lan-notice>{{ notice }}</p>

    <div class="lan-toggle-row">
      <button
        type="button"
        role="switch"
        class="switch"
        :aria-checked="enabled"
        aria-label="局域网协作"
        :disabled="busy !== null || loading"
        data-lan-switch
        @click="toggle"
      />
      <div class="lan-toggle-text">
        <strong>{{ enabled ? "局域网协作已开启" : "局域网协作已关闭" }}</strong>
        <span class="device-note">
          {{ enabled
            ? "监听 " + listeningAddress + "；只有持有一次性配对码换来的令牌才能连接，令牌只读，不含编辑权。"
            : "默认关闭：不监听任何端口。开启后会在 0.0.0.0 的随机端口上等待已配对设备。" }}
        </span>
      </div>
      <DsButton
        v-if="!enabled"
        variant="secondary"
        size="sm"
        :status="busy === 'start' ? 'loading' : 'idle'"
        :disabled="loading || busy !== null"
        data-lan-action="start"
        @click="start"
      >开启</DsButton>
      <DsButton
        v-else
        variant="danger"
        size="sm"
        :status="busy === 'stop' ? 'loading' : 'idle'"
        :disabled="busy !== null"
        data-lan-action="stop"
        @click="askStop"
      >停止并撤销</DsButton>
    </div>

    <p class="device-note" data-lan-optin-note>
      这是显式开关（opt-in）：关闭时零监听；停止会清空配对码、已签发令牌与所有局域网房间 —— 正在连接的设备会立即断开。
    </p>
    <p class="device-note" data-lan-scope-note>
      本区的配对码只用于局域网只读协作；下方「配对」是设备域的设备凭据，两者互不相通，不能互相替代。
    </p>

    <dl class="lan-status" data-lan-status>
      <dt>监听地址</dt>
      <dd data-lan-address>{{ status?.listening ? listeningAddress : "未监听" }}</dd>
      <dt>WebSocket 路径</dt>
      <dd data-lan-path>{{ status?.path || "/api/canvas/collab" }}</dd>
      <dt>在线客户端</dt>
      <dd data-lan-clients>{{ status?.clients ?? 0 }} / 32</dd>
      <dt>活动令牌</dt>
      <dd data-lan-tokens>{{ status?.tokens ?? 0 }}</dd>
      <dt>配对码</dt>
      <dd data-lan-pairing-status>
        {{ status?.pairing.active ? "有效 · 剩余 " + statusPairingRemaining + " · 到期 " + formatTime(status.pairing.expiresAt) : "没有有效配对码" }}
      </dd>
      <dt>权限</dt>
      <dd><DsBadge tone="neutral" size="sm">只读（不能编辑画布）</DsBadge></dd>
    </dl>

    <div class="lan-actions">
      <DsButton
        variant="secondary"
        size="sm"
        :status="busy === 'pairing' ? 'loading' : 'idle'"
        :disabled="!enabled || busy !== null"
        data-lan-action="pairing"
        @click="createPairing"
      >生成一次性配对码</DsButton>
      <DsButton variant="ghost" size="sm" :disabled="loading" @click="loadStatus()">刷新状态</DsButton>
    </div>

    <div v-if="pairing" class="device-pairing-secret" data-lan-pairing-panel>
      <p class="device-note">配对码只显示这一次；关闭面板或停止服务后界面不再展示。换到令牌即作废，重新生成会替换旧码。</p>
      <code class="device-secret" data-lan-pairing-code>{{ pairing.code }}</code>
      <p class="device-meta" data-lan-pairing-expiry>
        剩余 {{ remaining }} · 到期 {{ formatTime(pairing.expiresAt) }} · 端口 {{ pairing.port ?? "—" }} · 路径 {{ pairing.path }}
      </p>
      <div class="lan-actions">
        <DsButton variant="secondary" size="sm" @click="copy(pairing.code, 'code')" data-lan-action="copy-code">
          {{ copied === "code" ? "已复制" : copied === "failed:code" ? "复制失败，请手动选中" : "复制配对码" }}
        </DsButton>
      </div>
    </div>

    <div v-if="pairToken" class="device-pairing-secret" data-lan-pair-token-panel>
      <p class="device-note">令牌只显示这一次；不写日志、不落盘。关闭面板或停止服务后界面即清除；服务端令牌在停止时撤销。</p>
      <code class="device-secret" data-lan-pair-token>{{ pairToken.token }}</code>
      <p class="device-meta" data-lan-token-meta>
        到期 {{ formatTime(pairToken.expiresAt) }} · 连接地址 {{ pairToken.ws }} · {{ pairToken.tokenId ? "令牌 " + pairToken.tokenId : "" }}
      </p>
      <div class="lan-actions">
        <DsButton variant="secondary" size="sm" @click="copy(pairToken.token, 'token')" data-lan-action="copy-token">
          {{ copied === "token" ? "已复制" : copied === "failed:token" ? "复制失败，请手动选中" : "复制令牌" }}
        </DsButton>
      </div>
    </div>

    <details class="lan-advanced" data-lan-advanced>
      <summary>高级：用配对码换取只读令牌（本机验证）</summary>
      <p class="device-note">
        pair 是桌面域命令，真实远端设备无法直接调用；这里只用于验证配对码能否换到令牌。换到的令牌只显示一次、只读，
        不要粘贴到日志或工单；关闭面板即从界面清除。
      </p>
      <form class="lan-pair-form" @submit.prevent="pairNow">
        <input
          v-model="pairInput"
          type="text"
          inputmode="text"
          autocomplete="one-time-code"
          aria-label="配对码"
          placeholder="ABCD-EFGH"
          data-lan-pair-input
        />
        <DsButton variant="secondary" size="sm" type="submit" :status="pairBusy ? 'loading' : 'idle'" :disabled="!enabled || pairBusy" data-lan-action="pair">
          换取令牌
        </DsButton>
      </form>
      <p v-if="pairFailure" class="device-error" role="alert" data-lan-pair-error>{{ pairFailure }}</p>
      <p class="device-note">成功后配对码会被消费；如需给另一台设备使用，请重新生成配对码。</p>
    </details>
  </section>

  <DsDialog :open="stopDialog" title="停止并撤销局域网协作" @close="stopDialog = false">
    <div class="lan-dialog">
      <p class="device-note">
        停止会立即撤销：关闭监听、清空一次性配对码、清空已签发令牌并断开所有在线客户端。这不是暂停，重新开启后旧配对码和旧令牌都不能再用。
      </p>
      <p class="device-note">确定要停止「{{ status?.listening ? listeningAddress : "局域网协作" }}」吗？</p>
    </div>
    <template #footer>
      <DsButton variant="ghost" @click="stopDialog = false">取消</DsButton>
      <DsButton variant="danger" :status="busy === 'stop' ? 'loading' : 'idle'" data-lan-action="confirm-stop" @click="stop">停止并撤销</DsButton>
    </template>
  </DsDialog>
</template>

<style scoped>
.lan-panel {
  gap: var(--space-3);
}
.lan-toggle-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  padding: var(--space-3);
  border-radius: var(--radius-lg);
  background: var(--sunken);
}
.lan-toggle-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 260px;
  min-width: 0;
}
.lan-toggle-text strong {
  font-size: var(--fs-secondary);
  font-weight: var(--fw-medium);
}
.lan-status {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--space-1) var(--space-4);
  margin: 0;
  font-size: var(--fs-caption);
}
.lan-status dt {
  color: var(--muted);
}
.lan-status dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
.lan-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  align-items: center;
}
.lan-advanced {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--sunken);
  font-size: var(--fs-caption);
}
.lan-advanced summary {
  cursor: pointer;
  color: var(--muted);
}
.lan-advanced[open] summary {
  color: var(--text);
  margin-bottom: var(--space-2);
}
.lan-pair-form {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  flex-wrap: wrap;
}
.lan-pair-form input {
  flex: 1 1 200px;
  min-width: 140px;
  padding: 7px var(--space-2);
  border-radius: var(--radius-md);
  border: 1px solid var(--line);
  background: rgb(var(--content-rgb) / var(--content-alpha));
  color: var(--text);
  font: inherit;
  font-size: var(--fs-secondary);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.lan-dialog {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
@media (max-width: 720px) {
  .lan-toggle-row {
    align-items: flex-start;
  }
}
</style>
