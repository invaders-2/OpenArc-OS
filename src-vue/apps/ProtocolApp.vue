<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Boxes, Cable, CircleAlert, CircleCheck, CircleDashed, Layers, Search } from "lucide-vue-next";
import DsBadge from "../design-system/DsBadge.vue";
import { useShellStore } from "../stores/shell";
import {
  buildProtocolPayload,
  describeProtocolDetail,
  filterProtocols,
  modelProtocolErrorText,
  normalizeProtocolResult,
  protocolCapabilitiesText,
  protocolKey,
  protocolKindLabel,
  protocolRowStatus,
  PROTOCOL_KIND_ALL,
  type ProtocolDetail,
  type ProtocolItem,
} from "../../src/settings/modelProtocolLogic";

/**
 * 协议中心（10-16，对齐 DX OS API 设置里的协议表，独立成应用；与 MCP 中心并列）。
 *
 * 协议 = OpenArc 和各家模型服务「怎么说话」：对话 / 生图 / 视频 / 改图的接口、工作流与模型 profile。
 *   · 列表：model:command protocol/list（72 条，模型协议 + 供应商协议，含是否可执行与前提）；
 *   · 详情：protocol/get（操作、工作流、模型 profile 的真实声明；legacy 协议没有声明体，如实显示）；
 *   · 只读：协议的校验 / 保存入口在「系统设置 › 模型与服务商 › 协议设置」，这里只查看；凭据也在那里。
 * 投影逻辑复用 src/settings/modelProtocolLogic.ts（与旧 React 页同一份、同一组单测）。
 */
const shell = useShellStore();
const bridge = window.openarc?.model;
async function cmd(command: string, payload: Record<string, unknown> = {}): Promise<any> {
  if (!bridge) return { ok: false, error: "NO_BRIDGE" };
  try {
    return await bridge.command({ command, payload });
  } catch {
    return { ok: false, error: "INTERNAL_ERROR" };
  }
}

const items = ref<ProtocolItem[]>([]);
const loading = ref(true);
const error = ref("");
const problem = ref("");
const kind = ref<string>(PROTOCOL_KIND_ALL);
const status = ref<"all" | "ok" | "cond" | "off">("all");
const query = ref("");

async function load() {
  loading.value = true;
  const res = await cmd("protocol/list");
  loading.value = false;
  if (!res || res.ok !== true) {
    const code = String((res && res.error) || "INTERNAL_ERROR");
    error.value = modelProtocolErrorText(code) + "（" + code + "）";
    return;
  }
  const n = normalizeProtocolResult(res);
  items.value = n.items;
  problem.value = n.problem || "";
  if (!selectedKey.value && items.value.length) void select(items.value[0]);
}

const statusOf = (it: ProtocolItem): "ok" | "cond" | "off" => (it.execution === "unavailable" ? "off" : it.execution === "conditional" ? "cond" : "ok");
const STATUS_LABEL = { ok: "可用", cond: "需要前提", off: "不可用" } as const;
const STATUS_ICON = { ok: CircleCheck, cond: CircleDashed, off: CircleAlert } as const;
const count = (pred: (it: ProtocolItem) => boolean) => items.value.filter(pred).length;
const shown = computed(() => filterProtocols(items.value, kind.value, query.value).filter((it) => status.value === "all" || statusOf(it) === status.value));

/* ── 详情 ── */
const selectedKey = ref<string | null>(null);
const selected = computed(() => items.value.find((it) => protocolKey(it) === selectedKey.value) || null);
const detail = ref<ProtocolDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref("");
async function select(it: ProtocolItem) {
  const key = protocolKey(it);
  selectedKey.value = key;
  detail.value = null;
  detailError.value = "";
  detailLoading.value = true;
  const res = await cmd("protocol/get", buildProtocolPayload("protocol/get", { kind: it.kind, id: it.id }));
  if (selectedKey.value !== key) return;
  detailLoading.value = false;
  if (!res || res.ok !== true) {
    const code = String((res && res.error) || "INTERNAL_ERROR");
    // legacy 执行器的协议没有声明式定义体：这是事实，不是故障
    detailError.value = code === "PROTOCOL_NOT_FOUND" ? "这个协议由内置执行器直接实现，没有可展示的声明式定义。" : modelProtocolErrorText(code) + "（" + code + "）";
    return;
  }
  detail.value = describeProtocolDetail(res);
}
const ENGINE: Record<string, string> = { v2: "声明式引擎", legacy: "内置执行器" };
const SOURCE: Record<string, string> = { builtin: "内置", user: "自建", custom: "自建", plugin: "插件" };
const facts = (it: ProtocolItem) => [
  ["类型", protocolKindLabel(String(it.kind || ""))],
  ["来源", SOURCE[String(it.source || "")] || String(it.source || "—")],
  ["执行方式", ENGINE[String(it.engine || "")] || String(it.engine || "—")],
  ["版本", it.activeVersion == null ? "—" : "v" + String(it.activeVersion)],
  ["能力", protocolCapabilitiesText(it) || "—"],
];

onMounted(load);
</script>

<template>
  <div class="split protocol-app" data-protocol-center>
    <nav class="split-side" aria-label="协议分类">
      <label class="ds-search sk-search">
        <Search :size="14" class="ds-search__icon" />
        <input v-model="query" class="ds-search__input" type="search" placeholder="搜索协议" aria-label="搜索协议" />
      </label>
      <div class="split-section">类型</div>
      <button class="split-nav" :aria-current="kind === 'all' ? 'true' : undefined" data-protocol-kind="all" @click="kind = 'all'">
        <Layers :size="16" /> <span class="split-nav-label">全部协议</span><small class="planned-count">{{ items.length }}</small>
      </button>
      <button class="split-nav" :aria-current="kind === 'model' ? 'true' : undefined" data-protocol-kind="model" @click="kind = 'model'">
        <Boxes :size="16" /> <span class="split-nav-label">模型协议</span><small class="planned-count">{{ count((it) => it.kind === "model") }}</small>
      </button>
      <button class="split-nav" :aria-current="kind === 'provider' ? 'true' : undefined" data-protocol-kind="provider" @click="kind = 'provider'">
        <Cable :size="16" /> <span class="split-nav-label">供应商协议</span><small class="planned-count">{{ count((it) => it.kind === "provider") }}</small>
      </button>
      <div class="split-section">状态</div>
      <button v-for="s in (['ok', 'cond', 'off'] as const)" :key="s" class="split-nav" :aria-current="status === s ? 'true' : undefined" :data-protocol-status="s" @click="status = status === s ? 'all' : s">
        <component :is="STATUS_ICON[s]" :size="16" /> <span class="split-nav-label">{{ STATUS_LABEL[s] }}</span><small class="planned-count">{{ count((it) => statusOf(it) === s) }}</small>
      </button>
      <p class="planned-note">协议是 OpenArc 和各家模型服务的「说话方式」。密钥、服务商，以及协议的自定义、校验与保存在「系统设置 › 模型与服务商」里配置。</p>
    </nav>

    <div class="split-main pc-main">
      <div class="pane-toolbar">
        <strong class="pane-title">协议中心</strong>
        <small class="dr-crumb">{{ shown.length }} 个</small>
        <div class="toolbar-spacer" />
        <button class="planned-today" @click="shell.activateApp('settings')">模型与服务商</button>
      </div>
      <p v-if="problem" class="set-cap">{{ problem }}</p>

      <div v-if="error" class="empty-content">
        <h2 class="planned-title">读取协议失败</h2>
        <p>{{ error }}</p>
        <button class="planned-today" @click="load">重试</button>
      </div>
      <div v-else class="sk-split">
        <div class="sk-list" data-protocol-list>
          <p v-if="loading && !items.length" class="set-cap">正在读取…</p>
          <p v-else-if="!shown.length" class="set-cap">没有匹配的协议。</p>
          <button
            v-for="it in shown"
            :key="protocolKey(it)"
            class="sk-item pc-item"
            :class="{ on: selectedKey === protocolKey(it) }"
            :data-protocol="protocolKey(it)"
            @click="select(it)"
          >
            <span class="pc-item-top">
              <span class="sk-item-name">{{ it.label || it.id }}</span>
              <span class="pc-dot" :data-s="statusOf(it)" :title="STATUS_LABEL[statusOf(it)]" />
            </span>
            <small>{{ protocolKindLabel(String(it.kind || "")) }} · {{ protocolCapabilitiesText(it) || "—" }}</small>
          </button>
        </div>

        <section v-if="selected" class="sk-detail" :data-protocol-detail="protocolKey(selected)">
          <header class="sk-detail-head">
            <div>
              <h2>{{ selected.label || selected.id }}</h2>
              <p class="sk-meta"><code>{{ selected.id }}</code></p>
            </div>
            <DsBadge :tone="protocolRowStatus(selected).tone">{{ STATUS_LABEL[statusOf(selected)] }}</DsBadge>
          </header>
          <p v-if="statusOf(selected) !== 'ok'" class="vd-msg sk-msg pc-cond">{{ protocolRowStatus(selected).detail }}</p>

          <div class="set-group pc-facts">
            <div v-for="f in facts(selected)" :key="f[0]" class="setting-row">
              <span class="set-lab">{{ f[0] }}</span>
              <span class="set-val">{{ f[1] }}</span>
            </div>
          </div>

          <p v-if="detailLoading" class="set-cap">正在读取协议定义…</p>
          <p v-else-if="detailError" class="set-cap">{{ detailError }}</p>
          <template v-else-if="detail && detail.found">
            <p v-if="detail.summary !== '未返回'" class="pc-summary">{{ detail.summary }}</p>
            <div class="pc-groups">
              <span v-for="g in detail.groups" :key="g.key" class="badge" :class="{ ok: g.declared }">{{ g.label.split(" ")[0] }} {{ g.declared ? g.count : "—" }}</span>
            </div>
            <div v-if="detail.operations.length" class="sk-block">
              <h3>接口</h3>
              <table class="pc-table">
                <thead><tr><th>名称</th><th>方法</th><th>路径</th></tr></thead>
                <tbody>
                  <tr v-for="op in detail.operations" :key="op.id"><td class="mono">{{ op.id }}</td><td>{{ op.method }}</td><td class="mono">{{ op.path }}</td></tr>
                </tbody>
              </table>
            </div>
            <div v-if="detail.workflows.length" class="sk-block">
              <h3>工作流</h3>
              <table class="pc-table">
                <thead><tr><th>名称</th><th>提交方式</th></tr></thead>
                <tbody>
                  <tr v-for="wf in detail.workflows" :key="wf.id"><td class="mono">{{ wf.id }}</td><td class="mono">{{ wf.submit }}</td></tr>
                </tbody>
              </table>
            </div>
            <div v-if="detail.profiles.length" class="sk-block">
              <h3>支持的模型</h3>
              <table class="pc-table">
                <thead><tr><th>模型</th><th>名称</th><th>能力</th><th>工作流</th></tr></thead>
                <tbody>
                  <tr v-for="pf in detail.profiles" :key="pf.id"><td class="mono">{{ pf.id }}</td><td>{{ pf.label }}</td><td>{{ pf.capabilities.join("、") || "—" }}</td><td>{{ pf.workflowCount }}</td></tr>
                </tbody>
              </table>
            </div>
            <p class="set-cap">版本 v{{ detail.version }} · 校验值 <code>{{ String(detail.hash).slice(0, 12) }}</code></p>
          </template>
        </section>
        <section v-else class="sk-detail sk-detail-empty">
          <Layers :size="28" />
          <p>选择一个协议查看接口、工作流和支持的模型。</p>
        </section>
      </div>
    </div>
  </div>
</template>
