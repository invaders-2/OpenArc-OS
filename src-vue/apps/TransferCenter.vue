<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RefreshCw, Trash2, Upload } from "lucide-vue-next";
import DsBadge from "../design-system/DsBadge.vue";
import DsButton from "../design-system/DsButton.vue";
import DsPageState from "../design-system/DsPageState.vue";
import {
  domainBridge,
  failureText,
  formatBytes,
  formatTime,
  invokeDomain,
  resultFailure,
  resultValue,
  type FailureView,
} from "../bridge/domain";

/**
 * 传输中心（0.6.1 · 访达 › 传输中心，接既有 fileTransfer:command）。
 *
 * 复用的是分片传输真接口：begin → chunk（4 MiB 一块，base64）→ complete，
 * 以及 status / cancel / cleanup / health。落盘根由主进程固定，暂存文件 24 小时过期；
 * 这里不声称已经写入访达的资料库，也不展示宿主路径。
 */
type HealthValue = {
  status?: string;
  directory?: string;
  chunkBytes?: number;
  maxBytes?: number;
  ttlMs?: number;
  sessions?: number;
  inFlight?: number;
  expired?: number;
  bytes?: number;
};
type TransferView = { id: string; size: number; offset: number; chunkBytes: number; expiresAt: number; sha256?: string };
type LocalTransfer = {
  id: string;
  name: string;
  size: number;
  offset: number;
  expiresAt: number;
  sha256?: string;
  state: "uploading" | "done" | "failed" | "cancelled";
  error?: string;
};

const hasBridge = ref(!!domainBridge(typeof window === "undefined" ? null : window, "fileTransfer"));
const health = ref<HealthValue | null>(null);
const healthError = ref<FailureView | null>(null);
const error = ref<FailureView | null>(null);
const notice = ref("");
const loading = ref(false);
const busy = ref<string | null>(null);
const transfers = ref<LocalTransfer[]>([]);
const pickName = ref("");

const PROJECT_ID = "openarc-transfer";
const uploads = computed(() => transfers.value.filter((item) => item.state === "uploading").length);
const doneCount = computed(() => transfers.value.filter((item) => item.state === "done").length);

async function send(command: string, payload: Record<string, unknown> = {}) {
  if (!hasBridge.value) return { ok: false, error: "BRIDGE_ABSENT" };
  return invokeDomain("fileTransfer", command, payload);
}

async function loadHealth() {
  loading.value = true;
  healthError.value = null;
  const reply = await send("fileTransfer/health", {});
  loading.value = false;
  const value = resultValue<HealthValue>(reply);
  if (value) health.value = value;
  else healthError.value = resultFailure(reply);
}

function mergeView(id: string, view: TransferView, patch: Partial<LocalTransfer> = {}) {
  transfers.value = transfers.value.map((item) =>
    item.id === id
      ? {
          ...item,
          offset: Number(view.offset) || 0,
          size: Number(view.size) || item.size,
          expiresAt: Number(view.expiresAt) || item.expiresAt,
          sha256: view.sha256 || item.sha256,
          ...patch,
        }
      : item,
  );
}

async function refreshStatus(transfer: LocalTransfer) {
  const reply = await send("fileTransfer/status", { id: transfer.id });
  const value = resultValue<TransferView>(reply);
  if (value) mergeView(transfer.id, value);
  else error.value = resultFailure(reply);
}

function readChunk(file: File, start: number, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const buffer = reader.result as ArrayBuffer;
      const bytes = new Uint8Array(buffer);
      let binary = "";
      const step = 0x8000;
      for (let i = 0; i < bytes.length; i += step) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + step)) as unknown as number[]);
      }
      resolve(btoa(binary));
    };
    reader.onerror = () => reject(new Error("本机读取文件块失败"));
    reader.readAsArrayBuffer(file.slice(start, start + size));
  });
}

async function upload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  pickName.value = "";
  error.value = null;
  notice.value = "";
  busy.value = "upload";
  const beginReply = await send("fileTransfer/begin", {
    size: file.size,
    projectId: PROJECT_ID,
    revision: 0,
    kind: "source",
    name: file.name,
    mime: file.type || "application/octet-stream",
  });
  const begin = resultValue<TransferView>(beginReply);
  if (!begin) {
    busy.value = null;
    error.value = resultFailure(beginReply);
    return;
  }
  const local: LocalTransfer = {
    id: begin.id,
    name: file.name,
    size: begin.size,
    offset: begin.offset,
    expiresAt: begin.expiresAt,
    state: "uploading",
  };
  transfers.value = [local, ...transfers.value];
  const chunkBytes = Math.max(1, Number(begin.chunkBytes) || health.value?.chunkBytes || 4 * 1024 * 1024);
  try {
    let offset = begin.offset;
    while (offset < begin.size) {
      const data = await readChunk(file, offset, Math.min(chunkBytes, begin.size - offset));
      const reply = await send("fileTransfer/chunk", { id: begin.id, offset, data, encoding: "base64" });
      const view = resultValue<TransferView>(reply);
      if (!view) {
        error.value = resultFailure(reply);
        transfers.value = transfers.value.map((item) => (item.id === begin.id ? { ...item, state: "failed", error: failureText(resultFailure(reply)) } : item));
        busy.value = null;
        return;
      }
      offset = view.offset;
      mergeView(begin.id, view);
    }
    const completeReply = await send("fileTransfer/complete", { id: begin.id });
    const complete = resultValue<TransferView>(completeReply);
    if (!complete) {
      error.value = resultFailure(completeReply);
      transfers.value = transfers.value.map((item) => (item.id === begin.id ? { ...item, state: "failed", error: failureText(resultFailure(completeReply)) } : item));
    } else {
      mergeView(begin.id, complete, { state: "done" });
      notice.value = "「" + file.name + "」已传完并通过整文件校验；暂存文件在 " + formatTime(complete.expiresAt) + " 过期。";
      await loadHealth();
    }
  } catch (cause) {
    transfers.value = transfers.value.map((item) => (item.id === begin.id ? { ...item, state: "failed", error: String((cause as Error)?.message || cause) } : item));
    error.value = { code: "TRANSFER_READ_FAILED", message: "本机读取文件失败，传输已停止；可以在列表里取消这次暂存。" };
  } finally {
    busy.value = null;
  }
}

async function cancel(transfer: LocalTransfer) {
  busy.value = transfer.id;
  const reply = await send("fileTransfer/cancel", { id: transfer.id });
  busy.value = null;
  if (!resultValue(reply)) {
    error.value = resultFailure(reply);
    return;
  }
  transfers.value = transfers.value.map((item) => (item.id === transfer.id ? { ...item, state: "cancelled" } : item));
  await loadHealth();
}

async function cleanup() {
  busy.value = "cleanup";
  error.value = null;
  const reply = await send("fileTransfer/cleanup", {});
  busy.value = null;
  const value = resultValue<{ removed?: number; sessions?: number }>(reply);
  if (!value) {
    error.value = resultFailure(reply);
    return;
  }
  notice.value = "已回收 " + (value.removed ?? 0) + " 个过期会话 / 孤儿暂存文件；当前会话 " + (value.sessions ?? 0) + " 个。";
  await loadHealth();
}

const percent = (transfer: LocalTransfer) => (transfer.size > 0 ? Math.min(100, Math.round((transfer.offset / transfer.size) * 100)) : 0);
const STATE_TEXT: Record<LocalTransfer["state"], string> = {
  uploading: "传输中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
const STATE_TONE: Record<LocalTransfer["state"], "neutral" | "success" | "danger"> = {
  uploading: "neutral",
  done: "success",
  failed: "danger",
  cancelled: "neutral",
};

onMounted(() => {
  void loadHealth();
});
</script>

<template>
  <div class="transfer-center" data-transfer-center>
    <div class="transfer-head">
      <div>
        <h2>传输中心</h2>
        <p class="set-cap">大文件按分片写入主进程固定的暂存目录（{{ health?.directory || "dxos/file-transfers" }}），默认 24 小时过期；这里拿不到宿主路径。</p>
      </div>
      <div class="transfer-actions">
        <DsButton size="sm" variant="ghost" :status="loading ? 'loading' : 'idle'" data-transfer-refresh @click="loadHealth">
          <RefreshCw :size="13" /> 刷新状态
        </DsButton>
        <DsButton size="sm" variant="secondary" :status="busy === 'cleanup' ? 'loading' : 'idle'" data-transfer-cleanup @click="cleanup">
          <Trash2 :size="13" /> 回收过期暂存
        </DsButton>
      </div>
    </div>

    <DsPageState
      v-if="!hasBridge"
      kind="unavailable"
      title="当前环境没有文件传输域的桥"
      description="浏览器预览不提供 fileTransfer:command；请在 OpenArc 桌面应用中打开访达。"
    />
    <DsPageState v-else-if="healthError" kind="error" title="读不到文件传输状态" :description="failureText(healthError)" :on-action="loadHealth" />

    <template v-else>
      <p v-if="error" class="transfer-error" role="alert" :data-transfer-error="error.code">{{ failureText(error) }}</p>
      <p v-if="notice" class="transfer-notice" role="status">{{ notice }}</p>

      <div v-if="health" class="transfer-health">
        <div class="transfer-stat"><span>暂存会话</span><b>{{ health.sessions ?? 0 }}</b></div>
        <div class="transfer-stat"><span>在途</span><b>{{ health.inFlight ?? 0 }}</b></div>
        <div class="transfer-stat"><span>已过期</span><b>{{ health.expired ?? 0 }}</b></div>
        <div class="transfer-stat"><span>分片大小</span><b>{{ formatBytes(health.chunkBytes) }}</b></div>
        <div class="transfer-stat"><span>单文件上限</span><b>{{ formatBytes(health.maxBytes) }}</b></div>
        <div class="transfer-stat"><span>本窗口</span><b>{{ uploads }} 进行 / {{ doneCount }} 完成</b></div>
      </div>

      <label class="transfer-pick" :class="{ busy: busy === 'upload' }">
        <Upload :size="15" />
        <span>{{ busy === "upload" ? "正在分片上传…" : "选择文件导入传输暂存" }}</span>
        <input type="file" hidden :disabled="busy === 'upload'" @change="upload" />
      </label>
      <p class="transfer-note">传输到的是本机暂存区：完成 ≠ 已保存到资料库。要归档请走访达的导入 / 资源库入口。</p>

      <DsPageState
        v-if="!transfers.length"
        kind="empty"
        title="本窗口还没有发起过传输"
        description="选择文件后会真实走 begin → chunk → complete；服务端拒绝时会显示结构化原因，不会伪造进度。"
      />
      <ul v-else class="transfer-list">
        <li v-for="transfer in transfers" :key="transfer.id" class="transfer-row" :data-transfer-item="transfer.id" :data-transfer-state="transfer.state">
          <div class="transfer-row-head">
            <span class="transfer-name">{{ transfer.name }}</span>
            <DsBadge size="sm" :tone="STATE_TONE[transfer.state]">{{ STATE_TEXT[transfer.state] }}</DsBadge>
            <span class="transfer-meta mono">{{ formatBytes(transfer.offset) }} / {{ formatBytes(transfer.size) }} · {{ percent(transfer) }}%</span>
          </div>
          <div class="transfer-bar" role="progressbar" :aria-valuenow="percent(transfer)" aria-valuemin="0" aria-valuemax="100" :aria-label="transfer.name + ' 传输进度'">
            <i :style="{ width: percent(transfer) + '%' }" />
          </div>
          <div class="transfer-row-foot">
            <span class="transfer-meta">过期 {{ formatTime(transfer.expiresAt) }}<template v-if="transfer.sha256"> · sha256 {{ transfer.sha256.slice(0, 16) }}…</template></span>
            <span class="toolbar-spacer" />
            <DsButton v-if="transfer.state === 'uploading'" size="sm" variant="ghost" :status="busy === transfer.id ? 'loading' : 'idle'" @click="refreshStatus(transfer)">查询状态</DsButton>
            <DsButton v-if="transfer.state === 'uploading' || transfer.state === 'failed'" size="sm" variant="danger" :status="busy === transfer.id ? 'loading' : 'idle'" @click="cancel(transfer)">取消</DsButton>
            <span v-if="transfer.error" class="transfer-error">{{ transfer.error }}</span>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.transfer-center { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4) var(--space-5); min-height: 0; height: 100%; overflow: auto; }
.transfer-head { display: flex; align-items: flex-start; gap: var(--space-3); justify-content: space-between; flex-wrap: wrap; }
.transfer-head h2 { margin: 0; font-size: var(--fs-title); font-weight: var(--fw-medium); letter-spacing: var(--tracking-tight); }
.transfer-actions { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.transfer-health { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: var(--space-2); }
.transfer-stat { display: flex; flex-direction: column; gap: 2px; padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: rgb(var(--text-rgb) / 0.04); }
.transfer-stat span { font-size: var(--fs-micro); color: var(--muted); }
.transfer-stat b { font-size: var(--fs-secondary); font-weight: var(--fw-medium); font-variant-numeric: tabular-nums; }
.transfer-pick {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  align-self: flex-start;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: rgb(var(--accent-rgb));
  color: rgb(var(--on-accent-rgb));
  font-size: var(--fs-secondary);
  cursor: pointer;
}
.transfer-pick.busy { opacity: 0.7; pointer-events: none; }
.transfer-note { margin: 0; font-size: var(--fs-micro); color: var(--muted); line-height: var(--lh-relaxed); }
.transfer-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.transfer-row { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3); border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.04); }
.transfer-row-head, .transfer-row-foot { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.transfer-name { font-size: var(--fs-secondary); font-weight: var(--fw-medium); overflow-wrap: anywhere; }
.transfer-meta { font-size: var(--fs-micro); color: var(--muted); font-variant-numeric: tabular-nums; }
.transfer-bar { height: 4px; border-radius: var(--radius-pill); background: rgb(var(--text-rgb) / 0.1); overflow: hidden; }
.transfer-bar i { display: block; height: 100%; background: rgb(var(--accent-rgb)); transition: width var(--dur-quick) var(--ease-standard); }
.transfer-error { margin: 0; color: var(--failed); font-size: var(--fs-caption); }
.transfer-notice { margin: 0; color: var(--muted); font-size: var(--fs-caption); }
</style>
