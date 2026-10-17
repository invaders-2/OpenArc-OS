<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import DsButton from "../design-system/DsButton.vue";
import { t } from "../i18n";
import { useShellStore } from "../stores/shell";
import {
  describeProtocolDetail,
  filterProtocols,
  modelProtocolErrorText,
  normalizeProtocolResult,
  protocolCapabilitiesText,
  protocolKey,
  protocolKindLabel,
  PROTOCOL_KIND_ALL,
  type ProtocolDetail,
  type ProtocolItem,
} from "../../src/settings/modelProtocolLogic";
import { providerInitials, resolveProviderLogo } from "./providerLogos";
import {
  parseProtocolDraft,
  protocolEngineText,
  protocolExecutionView,
  protocolSaveView,
  protocolSettingsErrorText,
  protocolSourceText,
  protocolValidateView,
} from "./protocolSettingsLogic";

/**
 * 系统设置 › 模型与服务商 › 协议设置。
 *
 * 把只读的「协议中心」补成可配置：列表（kind + 状态）、详情、protocol/validate 校验、
 * protocol/save 保存自定义 declarative 协议（失败逐条 issues）。
 * 命令与投影规则复用 src/settings/modelProtocolLogic.ts（协议中心同一份口径）；
 * v2 / legacy、execution 与前提、ported 全部按后端返回如实标注。
 */
const shell = useShellStore();
const logoTheme = computed<"light" | "dark">(() => (shell.dark ? "dark" : "light"));

const bridge = () => (window as any).openarc?.model;
async function cmd(command: string, payload: Record<string, unknown> = {}): Promise<any> {
  const b = bridge();
  if (!b) return { ok: false, error: "NO_BRIDGE" };
  try {
    return await b.command({ command, payload });
  } catch {
    return { ok: false, error: "DXOS_ERR_INTERNAL" };
  }
}

const items = ref<ProtocolItem[]>([]);
const loading = ref(true);
const errorCode = ref<string | null>(null);
const problem = ref("");
const kind = ref<string>(PROTOCOL_KIND_ALL);
const status = ref<"all" | "ok" | "cond" | "off">("all");

const statusOf = (it: ProtocolItem): "ok" | "cond" | "off" =>
  it.execution === "unavailable" ? "off" : it.execution === "conditional" ? "cond" : "ok";
const STATUS_LABEL = { ok: "可执行", cond: "需要前提", off: "不可执行" } as const;
const count = (pred: (it: ProtocolItem) => boolean) => items.value.filter(pred).length;
const shown = computed(() =>
  filterProtocols(items.value, kind.value, "").filter((it) => status.value === "all" || statusOf(it) === status.value),
);

function logoFor(it: ProtocolItem | null | undefined) {
  if (!it) return null;
  return resolveProviderLogo(
    { providerId: String(it.id || ""), protocol: String(it.id || ""), displayName: String(it.label || "") },
    logoTheme.value,
  );
}
const initialsFor = (it: ProtocolItem) => providerInitials(it.label || it.id);

/* ── 详情 ── */
const selectedKey = ref<string | null>(null);
const selected = computed(() => items.value.find((it) => protocolKey(it) === selectedKey.value) || null);
const detail = ref<ProtocolDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref("");
const rawProtocol = ref<any>(null);

const facts = (it: ProtocolItem) => {
  const execution = protocolExecutionView(it);
  return [
    ["类型", protocolKindLabel(String(it.kind || ""))],
    ["来源", protocolSourceText(it.source)],
    ["执行方式", protocolEngineText(it.engine)],
    ["可执行性", t(execution.label)],
    ["版本", it.activeVersion == null ? t("未返回") : "v" + String(it.activeVersion)],
    ["能力", protocolCapabilitiesText(it) || t("未返回")],
  ];
};

async function load() {
  loading.value = true;
  errorCode.value = null;
  const res = await cmd("protocol/list");
  loading.value = false;
  if (!res || res.ok !== true) {
    errorCode.value = String((res && res.error) || "DXOS_ERR_INTERNAL");
    items.value = [];
    problem.value = "";
    return;
  }
  const view = normalizeProtocolResult(res);
  items.value = view.items;
  problem.value = view.problem || "";
  if (!selectedKey.value && items.value.length) void select(items.value[0]);
}

async function select(it: ProtocolItem) {
  const key = protocolKey(it);
  selectedKey.value = key;
  detail.value = null;
  detailError.value = "";
  rawProtocol.value = null;
  detailLoading.value = true;
  const res = await cmd("protocol/get", { kind: it.kind, id: it.id });
  if (selectedKey.value !== key) return;
  detailLoading.value = false;
  if (!res || res.ok !== true) {
    const code = String((res && res.error) || "DXOS_ERR_INTERNAL");
    // legacy 没有声明式定义体：这是事实，不是故障，也不给它编一份。
    detailError.value = code === "PROTOCOL_NOT_FOUND"
      ? "这个协议由内置执行器直接实现，没有可展示的声明式定义体；可以把它当作参照，在下面写一份新的 v2 协议。"
      : protocolSettingsErrorText(code);
    draftKind.value = it.kind === "provider" ? "provider" : "model";
    return;
  }
  detail.value = describeProtocolDetail(res);
  const raw = res.protocol;
  if (raw && typeof raw === "object") {
    rawProtocol.value = raw;
    draft.value = JSON.stringify(raw, null, 2);
    if (typeof raw.kind === "string" && raw.kind) draftKind.value = raw.kind;
  }
}

/* ── 校验 / 保存 ── */
const draft = ref("");
const draftKind = ref<"model" | "provider">("model");
const validateView = ref<ReturnType<typeof protocolValidateView> | null>(null);
const saveView = ref<ReturnType<typeof protocolSaveView> | null>(null);
const busy = ref(false);

function onDraftKind(e: Event) {
  draftKind.value = (e.target as HTMLSelectElement).value as "model" | "provider";
}

async function runValidate() {
  const parsed = parseProtocolDraft(draft.value);
  if (!parsed.ok) {
    validateView.value = { ok: false, code: "INVALID_INPUT", issues: [], text: parsed.message };
    return;
  }
  busy.value = true;
  const res = await cmd("protocol/validate", { protocol: parsed.value });
  busy.value = false;
  validateView.value = protocolValidateView(res);
}

async function runSave() {
  const parsed = parseProtocolDraft(draft.value);
  if (!parsed.ok) {
    saveView.value = { ok: false, code: "INVALID_INPUT", entryId: null, text: parsed.message };
    return;
  }
  busy.value = true;
  const res = await cmd("protocol/save", { kind: draftKind.value, protocol: parsed.value });
  busy.value = false;
  saveView.value = protocolSaveView(res);
  const validation = protocolValidateView(res);
  saveView.value = { ...saveView.value, text: saveView.value.ok ? saveView.value.text : saveView.value.text + "（" + validation.text + "）" };
  if (saveView.value.ok) await load();
}

onMounted(load);
</script>

<template>
  <div class="pset" data-protocol-settings>
    <div class="pset-bar">
      <span class="pset-filters pset-seg">
        <button
          v-for="k in [['all', '全部'], ['model', '模型协议'], ['provider', '服务商协议']] as const"
          :key="k[0]"
          type="button"
          class="pset-chip"
          :class="{ on: kind === k[0] }"
          :data-protocol-settings-kind="k[0]"
          @click="kind = k[0]"
        >{{ t(k[1]) }} <small>{{ k[0] === "all" ? items.length : count((it) => it.kind === k[0]) }}</small></button>
      </span>
      <span class="pset-filters pset-seg">
        <button
          v-for="s in (['all', 'ok', 'cond', 'off'] as const)"
          :key="s"
          type="button"
          class="pset-chip"
          :class="{ on: status === s }"
          :data-protocol-settings-status="s"
          @click="status = s"
        >{{ s === "all" ? t("全部状态") : t(STATUS_LABEL[s]) }} <small>{{ s === "all" ? items.length : count((it) => statusOf(it) === s) }}</small></button>
      </span>
      <span class="toolbar-spacer" />
      <DsButton variant="ghost" size="sm" data-protocol-settings-reload :disabled="loading" @click="load">{{ loading ? t("读取中…") : t("重新读取") }}</DsButton>
    </div>

    <p v-if="errorCode" class="pset-msg pset-msg-bad" data-protocol-settings-error :data-protocol-settings-error-code="errorCode">
      {{ modelProtocolErrorText(errorCode) }}
    </p>
    <p v-else-if="problem" class="pset-msg">{{ problem }}</p>

    <div class="pset-body">
      <div class="pset-list" data-protocol-settings-list>
        <p v-if="loading && !items.length" class="set-cap">{{ t("正在读取协议…") }}</p>
        <p v-else-if="!shown.length" class="set-cap" data-protocol-settings-empty>{{ t("没有匹配的协议。") }}</p>
        <button
          v-for="it in shown"
          :key="protocolKey(it)"
          type="button"
          class="pset-row"
          :class="{ on: selectedKey === protocolKey(it) }"
          :data-protocol-settings-row="protocolKey(it)"
          :data-protocol-settings-engine="String(it.engine || '')"
          :data-protocol-settings-execution="String(it.execution || '')"
          :data-protocol-settings-ported="String(it.ported)"
          @click="select(it)"
        >
          <span
            class="pset-logo"
            :data-protocol-settings-logo="logoFor(it)?.key ?? ''"
            :data-protocol-settings-logo-kind="logoFor(it) ? 'brand' : 'initial'"
            :data-protocol-settings-logo-render="logoFor(it)?.render ?? 'initial'"
            :data-protocol-settings-logo-theme="logoTheme"
          >
            <span
              v-if="logoFor(it)?.render === 'mask'"
              class="pset-logo-mark"
              :style="{ maskImage: 'url(' + logoFor(it)!.url + ')', WebkitMaskImage: 'url(' + logoFor(it)!.url + ')' }"
            />
            <img v-else-if="logoFor(it)" :src="logoFor(it)!.url" :alt="logoFor(it)!.label" />
            <template v-else>{{ initialsFor(it) }}</template>
          </span>
          <span class="pset-row-main">
            <b>{{ it.label || it.id }}</b>
            <small>{{ it.id }}</small>
          </span>
          <span class="pset-dot" :data-s="statusOf(it)">{{ t(STATUS_LABEL[statusOf(it)]) }}</span>
        </button>
      </div>

      <section v-if="selected" class="pset-detail" :data-protocol-settings-detail="protocolKey(selected)">
        <header class="pset-head">
          <b>{{ selected.label || selected.id }}</b>
          <span>{{ selected.id }}</span>
        </header>

        <div class="pset-facts">
          <div v-for="f in facts(selected)" :key="f[0]" class="pset-fact">
            <span class="pset-fact-k">{{ t(f[0]) }}</span>
            <span class="pset-fact-v">{{ t(f[1]) }}</span>
          </div>
        </div>
        <p v-if="statusOf(selected) !== 'ok'" class="pset-msg" data-protocol-settings-premise>
          {{ t("前提：{detail}", { detail: protocolExecutionView(selected).detail }) }}
        </p>

        <p v-if="detailLoading" class="set-cap">{{ t("正在读取协议定义…") }}</p>
        <p v-else-if="detailError" class="pset-msg" data-protocol-settings-detail-note>{{ detailError }}</p>
        <template v-else-if="detail && detail.found">
          <p v-if="detail.summary && detail.summary !== '未返回'" class="pset-summary">{{ detail.summary }}</p>
          <p class="pset-groups">
            <span v-for="g in detail.groups" :key="g.key" class="pset-group" :class="{ on: g.declared }">
              {{ g.label.split(" ")[0] }} {{ g.declared ? g.count : t("未声明") }}
            </span>
          </p>
          <table v-if="detail.operations.length" class="pset-table" data-protocol-settings-operations>
            <thead><tr><th>{{ t("接口") }}</th><th>{{ t("方法") }}</th><th>{{ t("路径") }}</th></tr></thead>
            <tbody><tr v-for="op in detail.operations" :key="op.id"><td>{{ op.id }}</td><td>{{ op.method }}</td><td class="mono">{{ op.path }}</td></tr></tbody>
          </table>
          <table v-if="detail.workflows.length" class="pset-table" data-protocol-settings-workflows>
            <thead><tr><th>{{ t("工作流") }}</th><th>{{ t("提交接口") }}</th></tr></thead>
            <tbody><tr v-for="wf in detail.workflows" :key="wf.id"><td>{{ wf.id }}</td><td>{{ wf.submit }}</td></tr></tbody>
          </table>
          <table v-if="detail.profiles.length" class="pset-table" data-protocol-settings-profiles>
            <thead><tr><th>{{ t("模型") }}</th><th>{{ t("名称") }}</th><th>{{ t("能力") }}</th><th>{{ t("工作流") }}</th></tr></thead>
            <tbody><tr v-for="pf in detail.profiles" :key="pf.id"><td>{{ pf.id }}</td><td>{{ pf.label }}</td><td>{{ pf.capabilities.length ? pf.capabilities.join("、") : t("未声明") }}</td><td>{{ pf.workflowCount }}</td></tr></tbody>
          </table>
          <p class="set-cap">{{ t("版本 v{version} · 校验值", { version: detail.version }) }} <code>{{ String(detail.hash).slice(0, 12) }}</code></p>
        </template>

        <details class="pset-editor" data-protocol-settings-editor>
          <summary>{{ t("高级：校验或保存自定义协议") }}</summary>
          <div class="pset-editor-head">
            <span class="set-cap">{{ t("粘贴协议定义 JSON，先校验再保存；只写入本机协议库。") }}</span>
            <select class="set-select" data-protocol-settings-draft-kind :value="draftKind" @change="onDraftKind">
              <option value="model">{{ t("模型协议") }}</option>
              <option value="provider">{{ t("服务商协议") }}</option>
            </select>
          </div>
          <textarea
            v-model="draft"
            class="pset-draft mono"
            data-protocol-settings-draft
            spellcheck="false"
            rows="10"
            :aria-label="t('协议定义 JSON')"
            placeholder='粘贴 dx-protocol/v2 定义，例如 {"schemaVersion":"dx-protocol/v2","kind":"model","id":"my-proto",...}'
          />
          <div class="pset-editor-actions">
            <DsButton variant="secondary" size="sm" data-protocol-settings-validate :disabled="busy" @click="runValidate">{{ t("校验") }}</DsButton>
            <DsButton variant="primary" size="sm" data-protocol-settings-save :disabled="busy" @click="runSave">{{ t("保存到本机") }}</DsButton>
            <span v-if="rawProtocol" class="set-cap">{{ t("已载入 {id}，改动只会写入本机协议库。", { id: String(rawProtocol.id || "") }) }}</span>
          </div>
          <p
            v-if="validateView"
            class="pset-msg"
            :class="{ 'pset-msg-bad': !validateView.ok }"
            data-protocol-settings-validate-result
            :data-protocol-settings-validate-ok="String(validateView.ok)"
            :data-protocol-settings-error-code="validateView.code || ''"
            :data-protocol-settings-issue-count="validateView.issues.length"
          >{{ validateView.text }}</p>
          <ul v-if="validateView && validateView.issues.length" class="pset-issues" data-protocol-settings-issues>
            <li v-for="(issue, index) in validateView.issues" :key="index" :data-protocol-settings-issue="index">{{ issue }}</li>
          </ul>
          <p
            v-if="saveView"
            class="pset-msg"
            :class="{ 'pset-msg-bad': !saveView.ok }"
            data-protocol-settings-save-result
            :data-protocol-settings-save-ok="String(saveView.ok)"
            :data-protocol-settings-error-code="saveView.code || ''"
            :data-protocol-settings-entry-id="saveView.entryId || ''"
          >{{ saveView.text }}</p>
        </details>
      </section>
      <section v-else class="pset-detail pset-detail-empty">
        <p class="set-cap">{{ t("从左边选一个协议，查看它的接口、工作流与可执行性；也可以在下方直接校验、保存自定义协议。") }}</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.pset { display: flex; flex-direction: column; gap: 12px; }
.pset-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
/* 筛选：分段控件（sunken 轨道 + 选中项抬起），不用描边胶囊（设计语言 §3.1 选中态 / §6 DsSegmented） */
.pset-seg { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 2px; border-radius: var(--radius-md); background: var(--sunken); }
.pset-chip { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); font-size: var(--fs-caption); cursor: pointer; }
.pset-chip small { color: var(--muted); font-size: var(--fs-micro); }
.pset-chip:hover { color: var(--text); }
.pset-chip.on { background: rgb(var(--content-rgb) / 1); color: var(--text); font-weight: var(--fw-medium); box-shadow: 0 0.5px 2px rgb(0 0 0 / 0.12); }
.pset-body { display: grid; grid-template-columns: minmax(220px, 280px) minmax(0, 1fr); gap: 16px; align-items: start; }
.pset-list { display: flex; flex-direction: column; gap: 2px; max-height: 460px; overflow: auto; scrollbar-width: none; padding: 4px; border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.035); }
.pset-list::-webkit-scrollbar { display: none; }
.pset-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border-radius: var(--radius-md); background: transparent; color: var(--text); text-align: left; }
.pset-row:hover { background: var(--row-hover); }
.pset-row.on { background: rgb(var(--sidebar-selected-rgb, 224 224 224)); }
.pset-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.pset-row-main b { font-weight: var(--fw-medium); font-size: var(--fs-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pset-row-main small { color: var(--muted); font-size: var(--fs-caption); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pset-logo { flex: none; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; background: var(--sunken); color: var(--text); font-size: var(--fs-caption); font-weight: var(--fw-medium); overflow: hidden; }
.pset-logo[data-protocol-settings-logo-kind="brand"] { background: transparent; width: auto; min-width: 28px; max-width: 96px; padding: 0 3px; color: var(--text); }
.pset-logo-mark { width: 18px; height: 18px; background-color: currentColor; -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat; -webkit-mask-position: center; mask-position: center; -webkit-mask-size: contain; mask-size: contain; }
.pset-logo img { display: block; max-width: 90px; max-height: 20px; object-fit: contain; }
.pset-dot { flex: none; font-size: var(--fs-caption); color: var(--muted); }
.pset-dot[data-s="off"] { color: var(--failed); }
.pset-detail { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.pset-head { display: flex; align-items: baseline; gap: 8px; }
.pset-head b { font-size: var(--fs-headline); font-weight: var(--fw-medium); }
.pset-head span { color: var(--muted); font-size: var(--fs-caption); }
.pset-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 16px; padding: 12px 16px; border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.035); }
.pset-fact { display: flex; gap: 12px; font-size: var(--fs-secondary); min-width: 0; }
.pset-fact-k { flex: none; width: 64px; color: var(--muted); }
.pset-fact-v { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pset-summary { margin: 0; font-size: var(--fs-secondary); color: var(--text); line-height: 1.6; }
.pset-groups { margin: 0; display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: var(--fs-caption); color: var(--muted); }
.pset-group.on { color: var(--text); }
.pset-table { width: 100%; border-collapse: collapse; font-size: var(--fs-caption); }
.pset-table th, .pset-table td { text-align: left; padding: 6px 8px; box-shadow: inset 0 -0.5px 0 var(--line); }
.pset-table th { color: var(--muted); font-weight: var(--fw-regular); }
.pset-msg { margin: 0; font-size: var(--fs-caption); color: var(--text); }
.pset-msg-bad { color: var(--failed); }
.pset-editor { display: flex; flex-direction: column; gap: 8px; padding: 12px 16px; border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.035); }
.pset-editor > summary { cursor: pointer; font-size: var(--fs-secondary); color: var(--muted); list-style: none; }
.pset-editor > summary::-webkit-details-marker { display: none; }
.pset-editor[open] > summary { color: var(--text); margin-bottom: 4px; }
.pset-editor-head { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
.pset-editor-head .set-cap { margin: 0; }
.pset-draft { width: 100%; box-sizing: border-box; resize: vertical; padding: 8px 10px; border: 0; border-radius: var(--radius-md); background: var(--sunken); color: var(--text); font-size: var(--fs-caption); line-height: var(--lh-normal); }
.pset-draft:focus { outline: none; background: rgb(var(--text-rgb) / 0.1); }
.pset-editor-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pset-issues { margin: 0; padding-left: 18px; font-size: var(--fs-caption); color: var(--failed); }
.pset-detail-empty { padding: 10px; }
@media (max-width: 720px) { .pset-body { grid-template-columns: 1fr; } }
</style>
