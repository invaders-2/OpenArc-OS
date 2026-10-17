<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ArrowLeft, RefreshCw, RotateCcw } from "lucide-vue-next";
import DsBadge from "../design-system/DsBadge.vue";
import DsButton from "../design-system/DsButton.vue";
import DsDialog from "../design-system/DsDialog.vue";
import {
  UPDATE_CHECK_COMMAND,
  UPDATE_ROLLBACK_COMMAND,
  UPDATE_SOURCES_COMMAND,
  UPDATE_STATUS_COMMAND,
  appConfirmCopy,
  appConfirmDecision as confirmDecision,
  appUpdateView,
  formatTimestamp,
  installSuccessText,
  normalizeAppUpdateSources,
  normalizeAppUpdateStatus,
  pendingInstallAction,
  pendingRollbackAction,
  repositoryText,
  rollbackSuccessText,
  runningVersion,
  sourceKindLabel,
  sourceOptions,
  sourceSetRequest,
  sourceText,
} from "./appUpdateLogic";
import type {
  AppUpdateBusy,
  AppUpdatePendingAction,
  AppUpdateSources,
  AppUpdateStatus,
} from "./appUpdateLogic";

/**
 * 应用市场 › 应用「版本与更新」通用面板（按 appId 驱动）。
 *
 * 由画布专用面板泛化而来：同一个组件既服务画布，也服务商店里的其它应用。
 * 复用既有写法：外壳 .pane-toolbar / .pane-title / .set-group / .setting-row / .set-lab / .set-val /
 * .set-cap / .set-sec / .segmented.text，按钮与徽标用 DsButton / DsBadge，二次确认用 DsDialog
 * （Esc + 焦点陷阱 + 焦点恢复都是原语自带），图标沿用 lucide-vue-next。
 * 状态/文案/命令门全部来自 appUpdateLogic.ts，本组件不自己判断状态。
 *
 * 取证属性：data-canvas-update-* 是历史探针契约（画布入口继续可用，逐字保留）；
 * data-app-update-* 是泛化后的通用契约（按 appId 驱动）。
 */
const props = withDefaults(defineProps<{ appId?: string; appName?: string; autoInstall?: boolean }>(), {
  appId: "canvas",
  appName: "无限画布",
  autoInstall: false,
});
const emit = defineEmits<{ back: [] }>();

const status = ref<AppUpdateStatus | null>(null);
const sources = ref<AppUpdateSources | null>(null);
const busy = ref<AppUpdateBusy>("status");
const errorCode = ref<string | null>(null);
const errorDetail = ref("");
const notice = ref("");
const sourceBusy = ref(false);
/** 换源后原来的检查结果不再对应当前源，先如实退回「未检查」，等用户重新检查。 */
const sourceStale = ref(false);
const pending = ref<AppUpdatePendingAction | null>(null);
/** 从商店卡片直接点「升级」进来时，状态就绪后自动打开二次确认层（不是静默安装）。 */
let autoInstallArmed = props.autoInstall;

interface BridgeResult {
  ok: boolean;
  value?: unknown;
  error: string;
  detail: string;
}

const sourceOptionList = computed(() => sourceOptions(sources.value));
const selectedKind = computed(() => status.value?.source.kind || sources.value?.kind || "");
const effectiveStatus = computed<AppUpdateStatus | null>(() => {
  const current = status.value;
  if (!current || !sourceStale.value) return current;
  return { ...current, checkedAt: null, latest: null, updateAvailable: false };
});
const view = computed(() =>
  appUpdateView({ status: effectiveStatus.value, busy: busy.value, errorCode: errorCode.value, sources: sources.value, appId: props.appId, appName: props.appName }),
);
const confirmView = computed(() => appConfirmCopy(pending.value, status.value, sources.value, props.appName));
const notesUrl = computed(() => status.value?.latest?.notesUrl || "");
const latestVersion = computed(() => status.value?.latest?.version || "");
const installLabel = computed(() => (latestVersion.value ? "更新到 " + latestVersion.value : "安装更新"));
const anyBusy = computed(
  () => busy.value !== null || sourceBusy.value || view.value.installBusy || view.value.rollbackBusy,
);
const currentDetail = computed(() => {
  const current = status.value;
  if (!current) return "";
  if (!current.current) return "还没有单独安装过，正在用随包内置版本";
  return current.current.installedAt > 0 ? "安装于 " + formatTimestamp(current.current.installedAt) : "已单独安装";
});

/** 唯一命令出口：只认 {command,payload}，ok!==true 一律当失败，不半信任回包。 */
async function call(command: string, payload: Record<string, unknown>): Promise<BridgeResult> {
  const api = window.openarc?.marketUpdate;
  if (!api || typeof api.command !== "function") {
    return { ok: false, error: "MARKET_UPDATE_NOT_READY", detail: "当前环境没有在线更新桥（只在 OpenArc 桌面应用里可用）" };
  }
  let raw: unknown;
  try {
    raw = await api.command({ command, payload });
  } catch (error) {
    const message = error && typeof error === "object" ? String((error as { message?: unknown }).message || error) : String(error);
    return { ok: false, error: "MARKET_UPDATE_DOWNLOAD_FAILED", detail: message };
  }
  const box = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (box.ok === true) return { ok: true, value: box.value, error: "", detail: "" };
  return {
    ok: false,
    value: box.value,
    error: typeof box.error === "string" ? box.error : "MARKET_UPDATE_NOT_READY",
    detail: typeof box.detail === "string" ? box.detail : "",
  };
}

function applyStatus(result: BridgeResult) {
  if (result.ok) {
    const next = normalizeAppUpdateStatus(result.value);
    if (next) {
      status.value = next;
      errorCode.value = null;
      errorDetail.value = "";
      return;
    }
    errorCode.value = "DXOS_ERR_INTERNAL";
    errorDetail.value = "更新状态回包形状不合法";
    return;
  }
  errorCode.value = result.error;
  errorDetail.value = result.detail;
}

function applySources(next: AppUpdateSources | null) {
  sources.value = next;
  const selected = next?.selected;
  if (selected && selected.kind && status.value) {
    status.value = { ...status.value, source: { kind: selected.kind, owner: selected.owner, repo: selected.repo } };
  }
}

async function loadStatus() {
  busy.value = "status";
  applyStatus(await call(UPDATE_STATUS_COMMAND, { appId: props.appId }));
  busy.value = null;
}

async function loadSources() {
  const result = await call(UPDATE_SOURCES_COMMAND, { appId: props.appId });
  applySources(result.ok ? normalizeAppUpdateSources(result.value) : null);
}

async function runCheck() {
  notice.value = "";
  errorCode.value = null;
  busy.value = "check";
  const result = await call(UPDATE_CHECK_COMMAND, { appId: props.appId });
  busy.value = null;
  applyStatus(result);
  if (result.ok) sourceStale.value = false;
}

function askInstall() {
  const action = pendingInstallAction(effectiveStatus.value);
  if (!action) return;
  notice.value = "";
  pending.value = action;
}

function askRollback() {
  const action = pendingRollbackAction(status.value);
  if (!action) return;
  notice.value = "";
  pending.value = action;
}

function cancelPending() {
  pending.value = null;
}

async function acceptPending() {
  const decision = confirmDecision(pending.value, "confirm", props.appId);
  pending.value = null;
  if (!decision.invoke) return;
  const isRollback = decision.command === UPDATE_ROLLBACK_COMMAND;
  busy.value = isRollback ? "rollback" : "install";
  errorCode.value = null;
  notice.value = "";
  const result = await call(decision.command, decision.payload);
  if (result.ok) {
    notice.value = isRollback ? rollbackSuccessText(result.value) : installSuccessText(result.value);
    sourceStale.value = false;
    await loadStatus();
  } else {
    busy.value = null;
    errorCode.value = result.error;
    errorDetail.value = result.detail;
  }
}

async function chooseSource(kind: string) {
  const request = sourceSetRequest(status.value?.source ?? null, kind);
  if (!request.invoke) return;
  sourceBusy.value = true;
  errorCode.value = null;
  notice.value = "";
  const result = await call(request.command, request.payload);
  sourceBusy.value = false;
  if (result.ok) {
    applySources(normalizeAppUpdateSources(result.value) ?? sources.value);
    sourceStale.value = true;
    notice.value = "已切换到 " + sourceKindLabel(kind, sources.value) + "，请重新检查更新。";
    return;
  }
  errorCode.value = result.error;
  errorDetail.value = result.detail;
}

onMounted(() => {
  void loadSources();
  void loadStatus().then(() => {
    if (!autoInstallArmed) return;
    autoInstallArmed = false;
    if (view.value.canInstall) askInstall();
  });
});
</script>

<template>
  <div
    class="cu"
    data-canvas-update="1"
    :data-canvas-update-state="view.dataState"
    :data-canvas-update-busy="busy || 'idle'"
    :data-canvas-update-current="runningVersion(status)"
    :data-canvas-update-builtin="status ? status.builtinVersion : ''"
    :data-canvas-update-latest="latestVersion"
    :data-canvas-update-published="status && status.latest ? formatTimestamp(status.latest.publishedAt) : '—'"
    :data-canvas-update-available="status && status.updateAvailable ? 'true' : 'false'"
    :data-canvas-update-can-rollback="status && status.canRollback ? 'true' : 'false'"
    :data-canvas-update-rollback-target="view.rollbackTarget ? view.rollbackTarget.kind : 'none'"
    :data-canvas-update-source="status ? status.source.kind : ''"
    :data-canvas-update-source-repo="status ? repositoryText(status.source) : ''"
    :data-canvas-update-checked-at="status ? formatTimestamp(status.checkedAt) : '—'"
    :data-canvas-update-loadable="view.loadable ? 'true' : 'false'"
    :data-app-update="props.appId"
    :data-app-update-name="props.appName"
    :data-app-update-phase="view.dataState"
    :data-app-update-loadable="view.loadable ? 'true' : 'false'"
  >
    <div class="pane-toolbar">
      <button type="button" class="cu-back" data-canvas-update-back aria-label="返回应用市场" @click="emit('back')">
        <ArrowLeft :size="15" :stroke-width="1.5" />
      </button>
      <strong class="pane-title">{{ props.appName }} · 版本与更新</strong>
      <span class="toolbar-spacer" />
      <DsButton
        size="sm"
        variant="secondary"
        data-canvas-update-check
        :status="busy === 'check' ? 'loading' : 'idle'"
        :disabled="!view.canCheck || anyBusy"
        @click="runCheck"
      >
        <RefreshCw :size="13" :stroke-width="1.5" /> 检查更新
      </DsButton>
    </div>

    <section class="cu-state">
      <div class="cu-state-row">
        <DsBadge :tone="view.tone">{{ view.badge }}</DsBadge>
        <strong class="cu-state-title" data-canvas-update-title>{{ view.title }}</strong>
      </div>
      <p class="set-cap">{{ view.detail }}</p>
      <p v-if="notice" class="cu-ok" data-canvas-update-notice>{{ notice }}</p>
      <div
        v-if="view.installBusy || view.rollbackBusy"
        class="cu-busy"
        role="status"
        aria-live="polite"
        data-canvas-update-progress
      >
        <span class="ds-spinner" aria-hidden="true" />
        <span>{{ view.installBusy ? "正在下载并校验更新包…（验签 → 校验摘要 → 解压 → 切换到新版本）" : view.rollbackBusyText }}</span>
      </div>
      <p
        v-if="errorCode"
        class="cu-err"
        :data-canvas-update-error-code="errorCode"
        :data-canvas-update-error-detail="errorDetail || undefined"
      >
        原始错误码：<code>{{ errorCode }}</code>
      </p>
    </section>

    <div class="cu-actions">
      <DsButton
        v-if="view.canInstall || view.installBusy"
        variant="primary"
        data-canvas-update-install
        :status="view.installBusy ? 'loading' : 'idle'"
        :disabled="!view.canInstall"
        @click="askInstall"
      >
        {{ installLabel }}
      </DsButton>
      <DsButton
        variant="secondary"
        data-canvas-update-rollback
        :status="view.rollbackBusy ? 'loading' : 'idle'"
        :disabled="!view.canRollbackTarget || anyBusy"
        @click="askRollback"
      >
        <RotateCcw :size="13" :stroke-width="1.5" /> {{ view.rollbackLabel }}
      </DsButton>
    </div>

    <section class="set-sec">
      <h3>版本与来源</h3>
      <div class="set-group">
        <div class="setting-row">
          <span class="set-lab">当前版本<small>{{ currentDetail }}</small></span>
          <span class="set-val mono">{{ runningVersion(status) }}</span>
        </div>
        <div class="setting-row">
          <span class="set-lab">随包内置版本<small>没有单独安装时用的就是它</small></span>
          <span class="set-val mono">{{ status ? status.builtinVersion : "—" }}</span>
        </div>
        <div class="setting-row">
          <span class="set-lab">最新版本<small>来自下面的更新源</small></span>
          <span class="set-val mono">{{ latestVersion || "—" }}</span>
        </div>
        <div class="setting-row">
          <span class="set-lab">发布时间</span>
          <span class="set-val">{{ status && status.latest ? formatTimestamp(status.latest.publishedAt) : "—" }}</span>
        </div>
        <div class="setting-row">
          <span class="set-lab">更新说明</span>
          <span class="set-val">
            <a v-if="notesUrl" class="cu-link" :href="notesUrl" target="_blank" rel="noreferrer" data-canvas-update-notes>查看发布说明</a>
            <span v-else data-canvas-update-notes-none>源里没有提供说明链接</span>
          </span>
        </div>
        <div class="setting-row">
          <span class="set-lab">上次检查</span>
          <span class="set-val">{{ status ? formatTimestamp(status.checkedAt) : "—" }}</span>
        </div>
        <div class="setting-row">
          <span class="set-lab">更新来源<small>{{ sourceText(status && status.source, sources) }}</small></span>
          <span class="set-val">{{ status ? repositoryText(status.source) : "—" }}</span>
        </div>
        <div class="setting-row">
          <span class="set-lab">安装包加载<small>能不能在界面里真正用上装好的包</small></span>
          <span class="set-val">{{ view.loadable ? "已接入（安装后生效）" : "未接入（安装不会生效）" }}</span>
        </div>
        <div class="setting-row">
          <span class="set-lab">回滚<small>{{ view.rollbackStateHint }}</small></span>
          <span class="set-val" data-canvas-update-rollback-state>{{ view.rollbackStateText }}</span>
        </div>
      </div>
    </section>

    <section class="set-sec">
      <h3>切源</h3>
      <div class="segmented text cu-seg" role="group" aria-label="更新源">
        <button
          v-for="option in sourceOptionList"
          :key="option.kind"
          type="button"
          :aria-pressed="selectedKind === option.kind"
          :disabled="anyBusy"
          :data-canvas-update-source-option="option.kind"
          @click="chooseSource(option.kind)"
        >
          {{ option.label }}
        </button>
      </div>
      <p class="set-cap">切源只在你点选时写回本机，不会用默认仓库覆盖你已经保存的选择；换源后需要重新检查更新。</p>
    </section>

    <DsDialog
      :open="!!pending"
      :title="confirmView.title"
      :data-canvas-update-confirm="pending ? pending.kind : undefined"
      @close="cancelPending"
    >
      <p>{{ confirmView.body }}</p>
      <p v-if="pending && pending.kind === 'install' && notesUrl" class="cu-dialog-note">
        发布说明：<a class="cu-link" :href="notesUrl" target="_blank" rel="noreferrer">查看发布说明</a>
      </p>
      <template #footer>
        <DsButton variant="ghost" size="sm" @click="cancelPending">取消</DsButton>
        <DsButton
          variant="primary"
          size="sm"
          :data-canvas-update-confirm-primary="pending ? pending.kind : undefined"
          @click="acceptPending"
        >
          {{ confirmView.primary }}
        </DsButton>
      </template>
    </DsDialog>
  </div>
</template>

<style scoped>
.cu {
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-width: 720px;
}
.cu-back {
  display: grid;
  place-items: center;
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  color: var(--text);
}
.cu-back:hover {
  background: var(--row-hover);
}
/* 状态卡与设置行分组同族：靠 --text-rgb 的 alpha 铺底，不引入新颜色与新圆角。 */
.cu-state {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 16px;
  border-radius: var(--radius-lg);
  background: rgb(var(--text-rgb) / 0.035);
}
.cu-state-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.cu-state-title {
  min-width: 0;
  font-size: var(--fs-secondary);
  font-weight: var(--fw-medium);
  overflow-wrap: anywhere;
}
.cu-state .set-cap {
  margin: 0;
  overflow-wrap: anywhere;
}
.cu-ok {
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--text);
  overflow-wrap: anywhere;
}
.cu-busy {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-caption);
  color: var(--muted);
}
.cu-busy .ds-spinner {
  width: 12px;
  height: 12px;
}
.cu-err {
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--failed);
  overflow-wrap: anywhere;
}
.cu-err code {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
}
.cu-link {
  color: var(--text);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.cu-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
}
.cu-seg {
  align-self: flex-start;
  flex-wrap: wrap;
}
/* 与 .declare-app / .skills-app / .gov-app 同一段：应用内的 set-group 行自带内边距与分隔线。 */
.cu .set-group > .setting-row {
  padding: 11px 16px;
  gap: 16px;
}
.cu .set-group > * + * {
  box-shadow: inset 0 0.5px 0 var(--line);
}
/* 全局 .set-val 是 nowrap；窄窗口下仓库名/版本要能换行而不是被裁掉。 */
.cu .set-val {
  white-space: normal;
  overflow-wrap: anywhere;
  text-align: right;
}
.cu-dialog-note {
  margin: 8px 0 0;
  font-size: var(--fs-caption);
  color: var(--muted);
  overflow-wrap: anywhere;
}
</style>
