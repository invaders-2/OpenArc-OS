<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import DsBadge from "../design-system/DsBadge.vue";
import {
  MCP_AGENT_TOOLS_COMMAND,
  MCP_TOOL_SWITCH_COMMAND,
  TOOL_SWITCH_BOUNDARY_TEXT,
  TOOL_SWITCH_RISK_TEXT,
  agentToolApprovalText,
  agentToolParamText,
  agentToolRiskText,
  agentToolsEmptyText,
  agentToolsQuery,
  normalizeAgentToolsResult,
  normalizeToolSwitchResult,
  toolSwitchErrorText,
  toolSwitchNextValue,
  toolSwitchPayload,
  toolSwitchReadState,
  toolSwitchStateText,
  toolSwitchToggleText,
  type AgentToolsView,
} from "../../src/mcp/mcpCenterLogic";

/**
 * MCP 中心 ·「工具调用」区块（10-16 从旧 React 页迁入，逻辑复用 src/mcp/mcpCenterLogic.ts）。
 *   · 开关：唯一写入口 mcp/toolInvocation/set；先写后读，显示的永远是后端真实状态（不乐观切换）；
 *   · 工具清单：mcp/agentTools 只读聚合（已连接服务端的工具、风险等级、是否逐次审批）；
 *   · 这里没有「直接调用工具」的入口：调用一律走审批链，未批准不外发。
 */
const bridge = window.openarc?.mcp;
async function send(command: string, payload: Record<string, unknown> = {}): Promise<any> {
  if (!bridge?.command) return { ok: false, error: "NO_BRIDGE" };
  try {
    return (await bridge.command({ command, payload })) || { ok: false, error: "INTERNAL_ERROR" };
  } catch {
    return { ok: false, error: "INTERNAL_ERROR" };
  }
}
const view = ref<AgentToolsView | null>(null);
const loading = ref(true);
const busy = ref(false);
const failure = ref("");
const expanded = ref(false);
const state = computed(() => toolSwitchReadState(view.value, loading.value));

async function load() {
  loading.value = true;
  view.value = normalizeAgentToolsResult(await send(MCP_AGENT_TOOLS_COMMAND, agentToolsQuery(null, false)));
  loading.value = false;
}
async function toggle() {
  if (busy.value) return;
  const next = toolSwitchNextValue(state.value);
  if (next === null) return;
  busy.value = true;
  failure.value = "";
  const parsed = normalizeToolSwitchResult(await send(MCP_TOOL_SWITCH_COMMAND, toolSwitchPayload(next)));
  await load();
  busy.value = false;
  if (parsed.ok !== true) failure.value = toolSwitchErrorText(parsed.error || "INTERNAL_ERROR");
}
defineExpose({ reload: load });
onMounted(load);
</script>

<template>
  <section class="set-sec mcp-tools" data-mcp-tool-switch>
    <h3>工具调用</h3>
    <div class="set-group">
      <div class="setting-row">
        <span class="set-lab">
          允许 Agent 发起 MCP 工具调用
          <small role="status" data-mcp-tool-switch-state>{{ toolSwitchStateText(state) }}</small>
        </span>
        <span
          class="au-switch"
          role="switch"
          tabindex="0"
          :aria-checked="state.kind === 'ready' && state.enabled"
          :aria-disabled="state.kind !== 'ready' || busy"
          :aria-label="state.kind === 'ready' ? toolSwitchToggleText(state.enabled) : '工具调用开关（状态未知）'"
          data-mcp-tool-switch-toggle
          @click="toggle"
          @keydown.enter="toggle"
          @keydown.space.prevent="toggle"
        />
      </div>
      <div v-if="view?.ok" class="setting-row">
        <span class="set-lab">
          可用工具
          <small>{{ view.count ? `${view.connectedServers} 个服务端 · ${view.count} 个工具${view.truncated ? "（仅显示前一部分）" : ""}` : agentToolsEmptyText(view.connectedServers) }}</small>
        </span>
        <button v-if="view.count" class="planned-today" @click="expanded = !expanded">{{ expanded ? "收起" : "查看" }}</button>
      </div>
    </div>
    <p v-if="failure" class="mcp-error" role="alert" data-mcp-tool-switch-error>{{ failure }}</p>
    <p class="set-cap">{{ TOOL_SWITCH_RISK_TEXT }}</p>
    <p class="set-cap" :data-boundary="TOOL_SWITCH_BOUNDARY_TEXT.length">这里只有开关，没有「直接运行工具」的入口：每次调用都会弹出审批，没批准不会发出去。</p>
    <ul v-if="expanded && view?.tools.length" class="mcp-tool-list" data-mcp-agent-tools>
      <li v-for="t in view.tools" :key="t.fname" :data-mcp-agent-tool="t.fname">
        <div class="mcp-tool-top">
          <strong>{{ t.toolName || t.fname }}</strong>
          <small>{{ t.serverName || t.serverId }}</small>
          <DsBadge :tone="t.riskClass === 'EXTERNAL_SIDE_EFFECT' ? 'warning' : 'neutral'">{{ agentToolRiskText(t.riskClass) }}</DsBadge>
          <small>{{ agentToolApprovalText(t.requiresApproval) }}</small>
        </div>
        <p v-if="t.description" class="set-cap">{{ t.description }}</p>
        <p class="set-cap mono">{{ agentToolParamText(t.paramText) }}</p>
      </li>
    </ul>
  </section>
</template>
