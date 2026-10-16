<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import DsBadge from "../design-system/DsBadge.vue";
import DsButton from "../design-system/DsButton.vue";
import DsPageState from "../design-system/DsPageState.vue";

/**
 * D3-03 · 设备管理 Pane（对齐 src/device/DevicePane.tsx）。
 *
 * 三条口径照搬：
 *   §6  DEVICE_STATUS 与 CONNECTIVITY 是两根轴，分别显示，不塌缩
 *   §48 只画 bridge 返回的 publicDevice 字段；配对 secret 只活在本次 state
 *   §49/§51 管理动作只在 Super Admin 出现，但后端才是权威（ok:false 显示 reasonCode）
 * 浏览器预览无 device 桥时显示「当前环境无法访问设备域」，不伪造数据。
 */
type PublicDevice = {
  deviceId: string;
  displayName: string;
  platform: string;
  architecture: string;
  status: string;
  connectivity: string;
  credentialVersion?: number;
  lastSeenAt?: number | null;
};
type Pairing = {
  id: string;
  status: string;
  expiresAt?: number | null;
};
type AuditItem = { at?: number | null; actor_user_id?: string | null; event?: string | null; reason_code?: string | null };
type DeviceResult = {
  ok?: boolean;
  error?: string;
  items?: unknown;
  device?: unknown;
  pairing?: unknown;
  secret?: unknown;
};
type ActionError = { code: string; context: string };
type Tone = "neutral" | "success" | "warning" | "danger";

const props = withDefaults(defineProps<{ role?: string | null }>(), { role: null });

const bridge = typeof window !== "undefined" ? (window.openarc?.device as { command: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>> } | undefined) : undefined;
const available = typeof bridge?.command === "function";
const isSuperAdmin = computed(() => props.role === "ADMIN");

const STATUS_META: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: "待激活 PENDING", tone: "neutral" },
  ACTIVE: { label: "已授权 ACTIVE", tone: "success" },
  DISABLED: { label: "已禁用 DISABLED", tone: "warning" },
  REVOKED: { label: "已撤销 REVOKED", tone: "danger" },
};
const CONNECTIVITY_META: Record<string, { label: string; tone: Tone }> = {
  ONLINE: { label: "在线 ONLINE", tone: "success" },
  OFFLINE: { label: "离线 OFFLINE", tone: "neutral" },
  UNKNOWN: { label: "连接未知 UNKNOWN", tone: "neutral" },
};
const PAIRING_STATUS_LABEL: Record<string, string> = {
  ISSUED: "未使用（单次有效）",
  CONSUMED: "已使用",
  EXPIRED: "已过期",
  REVOKED: "已撤销",
};
const REASON_LABEL: Record<string, string> = {
  NOT_SUPER_ADMIN: "当前账号不是 Super Admin",
  DEVICE_REVOKED: "设备已撤销，需要重新配对并换发新凭据",
  DEVICE_DISABLED: "设备已被禁用，管理员启用后可恢复",
  DEVICE_PENDING: "设备尚未激活",
  DEVICE_OFFLINE: "设备当前离线，等待网络恢复",
  INVALID_STATUS_TRANSITION: "当前状态下不允许该操作",
  PAIRING_TOKEN_EXPIRED: "配对码已过期",
  PAIRING_TOKEN_REVOKED: "配对码已撤销",
  PAIRING_TOKEN_ALREADY_USED: "配对码已被使用（单次有效）",
  PAIRING_TOKEN_UNKNOWN: "配对码不存在",
  NOT_FOUND_OR_FORBIDDEN: "设备不存在，或当前账号无权操作",
  SESSION_EXPIRED: "会话已过期，请重新登录",
  SESSION_REVOKED: "会话已失效，请重新登录",
};

const asArray = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const timeText = (ts: number | null | undefined): string => {
  if (ts == null || !Number.isFinite(Number(ts))) return "—";
  return new Date(Number(ts)).toLocaleString("zh-CN", { hour12: false });
};
const countdownText = (expiresAt: number | null | undefined, now: number): string => {
  if (expiresAt == null || !Number.isFinite(Number(expiresAt))) return "—";
  const total = Math.max(0, Math.floor((Number(expiresAt) - now) / 1000));
  const s = total % 60;
  return Math.floor(total / 60) + ":" + String(s).padStart(2, "0");
};

const loading = ref(false);
const devices = ref<PublicDevice[]>([]);
const pairings = ref<Pairing[]>([]);
const audit = ref<AuditItem[]>([]);
const busy = ref<string | null>(null);
const error = ref<ActionError | null>(null);
const secret = ref<{ pairingId: string; value: string; expiresAt: number | null } | null>(null);
const renaming = ref<{ deviceId: string; value: string } | null>(null);
const now = ref(Date.now());
let timer: number | null = null;
onMounted(() => {
  timer = window.setInterval(() => (now.value = Date.now()), 1000);
});
onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer);
});

async function send(command: Record<string, unknown>): Promise<DeviceResult> {
  if (!bridge?.command) return { ok: false, error: "INTERNAL_ERROR" };
  try {
    const res = (await bridge.command(command)) as DeviceResult | null;
    return res && typeof res === "object" ? res : { ok: false, error: "INTERNAL_ERROR" };
  } catch {
    return { ok: false, error: "INTERNAL_ERROR" };
  }
}

async function loadDevices() {
  const res = await send({ type: "device/list" });
  if (res.ok) {
    devices.value = asArray<PublicDevice>(res.items);
    return true;
  }
  error.value = { code: String(res.error || "INTERNAL_ERROR"), context: "读取设备列表" };
  return false;
}
async function loadPairings() {
  const res = await send({ type: "device/pairing.list" });
  if (res.ok) {
    pairings.value = asArray<Pairing>(res.items);
    return true;
  }
  error.value = { code: String(res.error || "INTERNAL_ERROR"), context: "读取配对凭据" };
  return false;
}
async function loadAudit() {
  const res = await send({ type: "device/audit" });
  if (res.ok) {
    audit.value = asArray<AuditItem>(res.items);
    return true;
  }
  error.value = { code: String(res.error || "INTERNAL_ERROR"), context: "读取设备审计" };
  return false;
}
async function refresh() {
  loading.value = true;
  error.value = null;
  await loadDevices();
  await loadPairings();
  if (isSuperAdmin.value) await loadAudit();
  loading.value = false;
}
onMounted(() => {
  if (!available) return;
  void refresh();
});

async function runAction(key: string, command: Record<string, unknown>, context: string) {
  busy.value = key;
  error.value = null;
  const res = await send(command);
  busy.value = null;
  if (!res.ok) {
    error.value = { code: String(res.error || "INTERNAL_ERROR"), context };
    return null;
  }
  await refresh();
  return res;
}
async function startPairing() {
  busy.value = "pair";
  error.value = null;
  const res = await send({ type: "device/pairing.create" });
  busy.value = null;
  const pairing = (res.pairing as Pairing | undefined) || undefined;
  if (!res.ok || !pairing || typeof res.secret !== "string" || !res.secret) {
    error.value = { code: String(res.error || "INTERNAL_ERROR"), context: "开始配对" };
    return;
  }
  secret.value = { pairingId: pairing.id, value: res.secret, expiresAt: pairing.expiresAt ?? null };
  await refresh();
}
async function revokePairing(pairingId: string) {
  const res = await runAction("pairing:" + pairingId, { type: "device/pairing.revoke", pairingId }, "撤销配对");
  if (res && secret.value?.pairingId === pairingId) secret.value = null;
}
async function submitRename() {
  if (!renaming.value) return;
  const current = renaming.value;
  const res = await runAction(
    "rename:" + current.deviceId,
    { type: "device/rename", deviceId: current.deviceId, displayName: current.value },
    "重命名设备",
  );
  if (res) renaming.value = null;
}
function pairingStatusOf(p: Pairing): string {
  if (p.status === "ISSUED" && p.expiresAt != null && now.value >= Number(p.expiresAt)) return "EXPIRED";
  return p.status;
}
function statusMeta(d: PublicDevice) {
  return STATUS_META[d.status] || { label: d.status + "（未知状态）", tone: "neutral" as Tone };
}
function connMeta(d: PublicDevice) {
  return CONNECTIVITY_META[d.connectivity] || { label: d.connectivity + "（未知连接）", tone: "neutral" as Tone };
}
const failureText = computed(() => (error.value ? REASON_LABEL[error.value.code] || "设备操作失败" : ""));

function onRenameInput(e: Event) {
  if (renaming.value) renaming.value = { deviceId: renaming.value.deviceId, value: (e.target as HTMLInputElement).value };
}
function startRename(d: PublicDevice) {
  renaming.value = { deviceId: d.deviceId, value: d.displayName };
}
function cancelRename() {
  renaming.value = null;
}
</script>

<template>
  <div v-if="!available" class="device-pane" data-device-pane="devices" data-device-available="false">
    <DsPageState
      kind="unavailable"
      title="当前环境无法访问设备域"
      description="只有在 OpenArc 桌面应用（Electron）里才会加载设备桥。这里不展示任何模拟设备。"
    />
  </div>

  <div
    v-else
    class="device-pane"
    data-device-pane="devices"
    data-device-available="true"
    :data-device-role="isSuperAdmin ? 'ADMIN' : 'MEMBER'"
  >
    <p v-if="error" class="device-error" role="alert" data-device-error :data-device-reason="error.code">
      {{ error.context }}未完成：{{ failureText }}（{{ error.code }}）
    </p>

    <p v-if="!isSuperAdmin" class="device-note" data-device-role-note>
      当前账号不是 Super Admin：设备管理入口不可用，后端也会拒绝这些操作。
    </p>

    <section class="device-section" aria-label="设备配对">
      <div class="device-section-head">
        <h3>配对</h3>
        <DsButton
          v-if="isSuperAdmin"
          variant="secondary"
          size="sm"
          data-device-action="pair"
          :status="busy === 'pair' ? 'loading' : 'idle'"
          @click="startPairing"
        >开始配对</DsButton>
      </div>

      <div v-if="secret" class="device-pairing-secret" data-device-pairing-panel>
        <p class="device-note">加入码只显示这一次，关闭后无法再查看。</p>
        <code class="device-secret" data-device-pairing-secret>{{ secret.value }}</code>
        <p class="device-meta" data-device-pairing-expires>
          剩余 {{ countdownText(secret.expiresAt, now) }} · 到期 {{ timeText(secret.expiresAt) }}
        </p>
      </div>

      <div class="device-pairing-list" data-device-pairings>
        <template v-if="pairings.length">
          <div
            v-for="p in pairings"
            :key="p.id"
            class="device-pairing-row"
            :data-device-pairing="p.id"
            :data-device-pairing-status="pairingStatusOf(p)"
            data-device-pairing-single="true"
          >
            <span class="device-meta">配对 {{ p.id.slice(0, 12) }}…</span>
            <DsBadge
              :tone="pairingStatusOf(p) === 'ISSUED' ? 'neutral' : pairingStatusOf(p) === 'REVOKED' || pairingStatusOf(p) === 'EXPIRED' ? 'warning' : 'neutral'"
            >
              {{ PAIRING_STATUS_LABEL[pairingStatusOf(p)] || pairingStatusOf(p) }}
            </DsBadge>
            <span class="device-meta" data-device-pairing-expiry>
              到期 {{ timeText(p.expiresAt) }}
              <template v-if="pairingStatusOf(p) === 'ISSUED'"> · 剩余 {{ countdownText(p.expiresAt, now) }}</template>
            </span>
            <DsButton
              v-if="isSuperAdmin && pairingStatusOf(p) === 'ISSUED'"
              variant="ghost"
              size="sm"
              :data-device-pairing-revoke="p.id"
              :disabled="busy === 'pairing:' + p.id"
              @click="revokePairing(p.id)"
            >撤销</DsButton>
          </div>
        </template>
        <p v-else class="device-meta">没有待使用的配对凭据。</p>
      </div>
    </section>

    <section class="device-section" aria-label="设备列表">
      <div class="device-section-head">
        <h3>已注册设备</h3>
        <DsButton variant="ghost" size="sm" data-device-action="refresh" :status="loading ? 'loading' : 'idle'" @click="refresh">刷新</DsButton>
      </div>

      <p v-if="loading && !devices.length" class="device-meta">正在读取设备…</p>
      <DsPageState
        v-if="!loading && !devices.length && !error"
        kind="empty"
        title="还没有设备"
        description="使用「开始配对」生成加入码，在目标设备上注册。"
      />

      <div class="device-list" data-device-list>
        <article
          v-for="d in devices"
          :key="d.deviceId"
          class="device-row"
          :data-device-id="d.deviceId"
          :data-device-name="d.displayName"
          :data-device-status="d.status"
          :data-device-connectivity="d.connectivity"
        >
          <div class="device-row__main">
            <strong data-device-display-name>{{ d.displayName }}</strong>
            <span class="device-meta" data-device-platform>{{ d.platform }} · {{ d.architecture }}</span>
            <span class="device-meta" data-device-last-seen>最近在线 {{ timeText(d.lastSeenAt) }}</span>
            <span class="device-meta" data-device-credential-version>
              凭据 v{{ Number.isFinite(Number(d.credentialVersion)) ? d.credentialVersion : 0 }}
            </span>
          </div>
          <div class="device-row__badges">
            <span data-device-status-badge><DsBadge :tone="statusMeta(d).tone">{{ statusMeta(d).label }}</DsBadge></span>
            <span data-device-connectivity-badge><DsBadge :tone="connMeta(d).tone">{{ connMeta(d).label }}</DsBadge></span>
          </div>
          <div v-if="isSuperAdmin" class="device-actions">
            <DsButton
              variant="ghost"
              size="sm"
              data-device-action="rename"
              :data-device-id="d.deviceId"
              @click="startRename(d)"
            >重命名</DsButton>
            <DsButton
              v-if="d.status === 'ACTIVE'"
              variant="ghost"
              size="sm"
              data-device-action="disable"
              :data-device-id="d.deviceId"
              :disabled="busy === 'disable:' + d.deviceId"
              @click="runAction('disable:' + d.deviceId, { type: 'device/disable', deviceId: d.deviceId }, '禁用设备')"
            >禁用</DsButton>
            <DsButton
              v-if="d.status === 'DISABLED'"
              variant="ghost"
              size="sm"
              data-device-action="enable"
              :data-device-id="d.deviceId"
              :disabled="busy === 'enable:' + d.deviceId"
              @click="runAction('enable:' + d.deviceId, { type: 'device/enable', deviceId: d.deviceId }, '启用设备')"
            >启用</DsButton>
            <DsButton
              v-if="d.status !== 'REVOKED'"
              variant="danger"
              size="sm"
              data-device-action="revoke"
              :data-device-id="d.deviceId"
              :disabled="busy === 'revoke:' + d.deviceId"
              @click="runAction('revoke:' + d.deviceId, { type: 'device/revoke', deviceId: d.deviceId }, '撤销设备')"
            >撤销</DsButton>
          </div>
          <form
            v-if="renaming?.deviceId === d.deviceId"
            class="device-rename"
            @submit.prevent="submitRename"
          >
            <input
              class="device-rename-input"
              data-device-rename-input
              aria-label="设备名称"
              :value="renaming.value"
              @input="onRenameInput"
            />
            <DsButton variant="secondary" size="sm" type="submit" data-device-rename-confirm>保存</DsButton>
            <DsButton variant="ghost" size="sm" @click="cancelRename">取消</DsButton>
          </form>
        </article>
      </div>
    </section>

    <section v-if="isSuperAdmin" class="device-section" aria-label="设备审计">
      <div class="device-section-head">
        <h3>审计</h3>
      </div>
      <div class="device-audit" data-device-audit>
        <template v-if="audit.length">
          <div v-for="(a, i) in [...audit].slice(-20).reverse()" :key="String(a.at) + ':' + (a.event || '') + ':' + i" class="device-audit-row">
            <span class="device-meta">{{ timeText(a.at) }}</span>
            <span data-device-audit-event>{{ a.event || "—" }}</span>
            <span class="device-meta">{{ a.reason_code || "" }}</span>
            <span class="device-meta">{{ a.actor_user_id || "—" }}</span>
          </div>
        </template>
        <p v-else class="device-meta">暂无设备审计事件。</p>
      </div>
    </section>
  </div>
</template>
