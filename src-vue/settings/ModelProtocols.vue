<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import DsBadge from "../design-system/DsBadge.vue";
import {
  filterProtocols,
  modelProtocolErrorText,
  normalizeProtocolResult,
  protocolCapabilitiesText,
  protocolKey,
  protocolKindLabel,
  protocolKindOptions,
  protocolRowStatus,
  PROTOCOL_KIND_ALL,
  type ProtocolItem,
} from "../../src/settings/modelProtocolLogic";

/**
 * 模型与服务商 ·「协议」区块（10-16 从旧 React 页迁入，逻辑复用 src/settings/modelProtocolLogic.ts）。
 * 对齐 DX OS API 设置里的协议表：每个模型协议 / 供应商协议能否执行、执行前提是什么，全部来自 protocol/list。
 * 只读：协议的校验 / 保存 / 试执行仍在后端保留，这里不提供入口。
 */
const bridge = window.openarc?.model;
const items = ref<ProtocolItem[]>([]);
const loading = ref(true);
const error = ref("");
const problem = ref("");
const kind = ref(PROTOCOL_KIND_ALL);
const query = ref("");
const open = ref(true);
const expandedKey = ref<string | null>(null);

async function load() {
  loading.value = true;
  error.value = "";
  let res: any = null;
  try {
    res = bridge ? await bridge.command({ command: "protocol/list", payload: {} }) : { ok: false, error: "NO_BRIDGE" };
  } catch {
    res = { ok: false, error: "INTERNAL_ERROR" };
  }
  loading.value = false;
  if (!res || res.ok !== true) {
    error.value = modelProtocolErrorText(String((res && res.error) || "INTERNAL_ERROR")) + "（" + String((res && res.error) || "INTERNAL_ERROR") + "）";
    return;
  }
  const n = normalizeProtocolResult(res);
  items.value = n.items;
  problem.value = n.problem || "";
}
/** 状态短标签（白话）；引擎类型等细节留在展开说明里（protocolRowStatus().detail）。 */
const shortLabel = (it: ProtocolItem) => (it.execution === "unavailable" ? "不可用" : it.execution === "conditional" ? "需要前提" : "可用");
const kinds = computed(() => protocolKindOptions(items.value));
const shown = computed(() => filterProtocols(items.value, kind.value, query.value));
const counts = computed(() => {
  const c = { runnable: 0, conditional: 0, unavailable: 0 };
  for (const it of items.value) {
    if (it.execution === "unavailable") c.unavailable += 1;
    else if (it.execution === "conditional") c.conditional += 1;
    else c.runnable += 1;
  }
  return c;
});
onMounted(load);
</script>

<template>
  <div class="set-sec" data-model-protocols>
    <h3>协议</h3>
    <div class="set-group">
      <div class="setting-row">
        <span class="set-lab">
          模型与供应商协议
          <small v-if="loading">正在读取…</small>
          <small v-else-if="error">{{ error }}</small>
          <small v-else>共 {{ items.length }} 个 · 可用 {{ counts.runnable }} · 需要前提 {{ counts.conditional }} · 不可用 {{ counts.unavailable }}</small>
        </span>
        <button class="planned-today" :disabled="loading || !!error" data-model-protocols-toggle @click="open = !open">{{ open ? "收起" : "查看" }}</button>
      </div>
    </div>
    <p class="set-cap">协议决定 OpenArc 怎么和各家模型服务说话（对话、生图、视频、改图）。「需要前提」表示还缺凭据或外部依赖，展开可以看到具体前提。</p>
    <template v-if="open && !error">
      <div class="mp-bar">
        <div class="mp-kinds">
          <button v-for="k in kinds" :key="k" class="mp-kind" :class="{ on: kind === k }" @click="kind = k">{{ protocolKindLabel(k) }}</button>
        </div>
        <label class="ds-search mp-search">
          <input v-model="query" class="ds-search__input" type="search" placeholder="筛选协议" aria-label="筛选协议" />
        </label>
      </div>
      <p v-if="problem" class="set-cap">{{ problem }}</p>
      <ul class="mp-list" data-model-protocol-list>
        <li v-for="it in shown" :key="protocolKey(it)" :data-model-protocol="protocolKey(it)">
          <button class="mp-row" @click="expandedKey = expandedKey === protocolKey(it) ? null : protocolKey(it)">
            <span class="mp-name">{{ it.label || it.id }}<small>{{ it.id }} · {{ protocolKindLabel(String(it.kind || "")) }}</small></span>
            <span class="mp-caps">{{ protocolCapabilitiesText(it) }}</span>
            <DsBadge :tone="protocolRowStatus(it).tone">{{ shortLabel(it) }}</DsBadge>
          </button>
          <p v-if="expandedKey === protocolKey(it)" class="set-cap mp-detail">{{ protocolRowStatus(it).label }}：{{ protocolRowStatus(it).detail }}</p>
        </li>
        <li v-if="!shown.length" class="set-cap">没有匹配的协议。</li>
      </ul>
    </template>
  </div>
</template>
