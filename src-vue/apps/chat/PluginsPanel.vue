<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ExternalLink, Plug, Search, Sparkles } from "lucide-vue-next";
import { useShellStore } from "../../stores/shell";
import {
  MCP_AGENT_TOOLS_COMMAND, MCP_TOOL_SWITCH_COMMAND, agentToolsQuery, normalizeAgentToolsResult, normalizeToolSwitchResult,
  toolSwitchErrorText, toolSwitchNextValue, toolSwitchPayload, toolSwitchReadState, type AgentToolsView,
} from "../../../src/mcp/mcpCenterLogic";
import type { Pick } from "./types";

/**
 * 对话里的「插件」（对标 Codex Plugins / Claude「技能 + 连接器」）：
 *   · 技能：列出 Skill 中心里当前用户能用的技能，直接开关；「在对话中使用」= 新对话 + 预先选好这个技能；
 *   · MCP 连接：顶部是「允许 AI 调用 MCP 工具」总开关（与 MCP 中心同一个写入口，每次调用仍要审批），
 *     下面是连接列表与开关；「在对话中使用」同上。
 *   · 安装 / 配置仍在 Skill 中心、MCP 中心、应用市场，这里给入口，不另造一套。
 */
const emit = defineEmits<{ use: [pick: Pick] }>();
const shell = useShellStore();
type Bridge = { command: (c: Record<string, unknown>) => Promise<any> } | undefined;
const skillBridge = (window as any).openarc?.skill as Bridge;
const mcpBridge = (window as any).openarc?.mcp as Bridge;
async function call(bridge: Bridge, command: string, payload: Record<string, unknown> = {}) {
  if (!bridge?.command) return { ok: false, error: "NO_BRIDGE" };
  try { return (await bridge.command({ command, payload })) || { ok: false, error: "INTERNAL_ERROR" }; } catch { return { ok: false, error: "INTERNAL_ERROR" }; }
}
const val = (r: any) => (r && r.value && typeof r.value === "object" ? r.value : r || {});

const tab = ref<"skills" | "mcp">("skills");
const query = ref("");
const notice = ref("");
let noticeTimer = 0;
function flash(t: string) { notice.value = t; window.clearTimeout(noticeTimer); noticeTimer = window.setTimeout(() => { notice.value = ""; }, 3000); }

/* ── 技能 ── */
type Skill = { id: string; name: string; description: string; enabled: boolean; builtin: boolean; source: string };
const skills = ref<Skill[]>([]);
const skillsLoaded = ref(false);
const skillError = ref("");
async function loadSkills() {
  const r = await call(skillBridge, "skill/list");
  skillsLoaded.value = true;
  if (r.ok === false) { skillError.value = r.error === "NO_BRIDGE" ? "技能只在 OpenArc 桌面应用里可用" : "读取技能失败（" + String(r.error) + "）"; return; }
  const v = val(r);
  const items = Array.isArray(v.items) ? v.items : Array.isArray(v.skills) ? v.skills : [];
  skills.value = items.filter((x: any) => x && x.id).map((x: any) => ({
    id: String(x.id), name: String(x.name || x.id), description: String(x.description || ""), enabled: x.enabled !== false,
    builtin: x.builtin === true, source: x.builtin === true || x.origin === "official" ? "内置" : x.packId ? "技能包" : "自定义",
  }));
}
async function toggleSkill(s: Skill) {
  const r = await call(skillBridge, s.enabled ? "skill/disable" : "skill/enable", { skillId: s.id });
  if (r.ok === false) { flash("没有改成功（" + String(r.error) + "）"); return; }
  await loadSkills();
}

/* ── MCP ── */
type Conn = { id: string; name: string; enabled: boolean; status: string; transport: string; server: string };
const conns = ref<Conn[]>([]);
const connsLoaded = ref(false);
const connError = ref("");
const toolView = ref<AgentToolsView | null>(null);
const switchBusy = ref(false);
const switchState = computed(() => toolSwitchReadState(toolView.value, !toolView.value));
async function loadMcp() {
  const [r, t] = await Promise.all([call(mcpBridge, "mcp/list"), call(mcpBridge, MCP_AGENT_TOOLS_COMMAND, agentToolsQuery(null, false))]);
  connsLoaded.value = true;
  toolView.value = normalizeAgentToolsResult(t);
  if (r.ok === false) { connError.value = r.error === "NO_BRIDGE" ? "MCP 只在 OpenArc 桌面应用里可用" : "读取 MCP 连接失败（" + String(r.error) + "）"; return; }
  const items = Array.isArray(val(r).items) ? val(r).items : [];
  conns.value = items.filter((x: any) => x && x.connectionId).map((x: any) => ({
    id: String(x.connectionId), name: String(x.name || x.serverName || x.connectionId), enabled: !!x.enabled, status: String(x.status || ""),
    transport: String(x.transport || ""), server: [x.serverName, x.serverVersion].filter(Boolean).join(" "),
  }));
}
async function toggleSwitch() {
  const next = toolSwitchNextValue(switchState.value);
  if (next === null || switchBusy.value) return;
  switchBusy.value = true;
  const parsed = normalizeToolSwitchResult(await call(mcpBridge, MCP_TOOL_SWITCH_COMMAND, toolSwitchPayload(next)));
  await loadMcp();
  switchBusy.value = false;
  if (parsed.ok !== true) flash(toolSwitchErrorText(parsed.error || "INTERNAL_ERROR"));
}
async function toggleConn(c: Conn) {
  const r = await call(mcpBridge, "mcp/setEnabled", { connectionId: c.id, enabled: !c.enabled });
  if (r.ok === false) { flash("没有改成功（" + String(r.error) + "）"); return; }
  await loadMcp();
}
const CONN_STATUS: Record<string, string> = { READY: "已连接", CONNECTING: "连接中", DISABLED: "未启用", ERROR: "连接出错", AUTH_REQUIRED: "需要登录授权" };
const mcpAllowed = computed(() => switchState.value.kind === "ready" && switchState.value.enabled);

const q = computed(() => query.value.trim().toLowerCase());
const shownSkills = computed(() => skills.value.filter((s) => !q.value || (s.name + s.id + s.description).toLowerCase().includes(q.value)));
const shownConns = computed(() => conns.value.filter((c) => !q.value || (c.name + c.server).toLowerCase().includes(q.value)));

function useSkill(s: Skill) {
  if (!s.enabled) { flash("先打开这个技能的开关"); return; }
  emit("use", { kind: "skill", id: s.id, name: s.name });
}
function useConn(c: Conn) {
  if (!mcpAllowed.value) { flash("先打开上面的「允许 AI 调用 MCP 工具」"); return; }
  if (!c.enabled) { flash("先打开这个连接的开关"); return; }
  emit("use", { kind: "mcp", id: c.id, name: c.name });
}

onMounted(() => { void loadSkills(); void loadMcp(); });
</script>

<template>
  <div class="plug" data-chat-plugins>
    <div class="pane-toolbar plug-toolbar">
      <strong class="pane-title plug-title">插件</strong>
      <div class="toolbar-spacer" />
      <button type="button" class="plug-link" data-plug-market @click="shell.activateApp('market')"><ExternalLink :size="13" />去应用市场找更多</button>
    </div>
    <div class="plug-scroll">
      <div class="plug-col">
        <div class="plug-head">
          <h2>让 AI 多会几样本事</h2>
          <p>技能教 AI 按固定流程做事，MCP 连接让 AI 用外部服务的工具。打开开关就能在对话里用；也可以点「在对话中使用」，新开一段对话并先选好它。</p>
        </div>
        <div class="plug-bar">
          <div class="plug-tabs" role="tablist">
            <button type="button" role="tab" :aria-selected="tab === 'skills'" data-plug-tab="skills" @click="tab = 'skills'"><Sparkles :size="14" />技能<small>{{ skills.length }}</small></button>
            <button type="button" role="tab" :aria-selected="tab === 'mcp'" data-plug-tab="mcp" @click="tab = 'mcp'"><Plug :size="14" />MCP 连接<small>{{ conns.length }}</small></button>
          </div>
          <label class="plug-search"><Search :size="14" /><input v-model="query" type="search" placeholder="搜索" aria-label="搜索插件" data-plug-search /></label>
        </div>

        <!-- 技能 -->
        <template v-if="tab === 'skills'">
          <p v-if="skillError" class="plug-msg bad">{{ skillError }}</p>
          <div v-for="s in shownSkills" :key="s.id" class="plug-item" :data-plug-skill="s.id" :data-enabled="s.enabled">
            <span class="plug-ic"><Sparkles :size="16" /></span>
            <span class="plug-text"><b>{{ s.name }}</b><small>{{ s.description || s.id }}</small></span>
            <span class="plug-tag">{{ s.source }}</span>
            <button type="button" class="plug-btn" :data-plug-use-skill="s.id" @click="useSkill(s)">在对话中使用</button>
            <span class="plug-switch" role="switch" tabindex="0" :aria-checked="s.enabled" :aria-label="(s.enabled ? '停用 ' : '启用 ') + s.name" :data-plug-skill-switch="s.id" @click="toggleSkill(s)" @keydown.enter.space.prevent="toggleSkill(s)" />
          </div>
          <p v-if="skillsLoaded && !skillError && !shownSkills.length" class="plug-empty">{{ query ? "没有匹配的技能。" : "还没有技能。可以在 Skill 中心导入技能包。" }}</p>
          <button type="button" class="plug-more" data-plug-open-skills @click="shell.activateApp('skills')"><ExternalLink :size="13" />在 Skill 中心导入或编辑技能</button>
        </template>

        <!-- MCP -->
        <template v-else>
          <div class="plug-master" data-plug-mcp-master>
            <span class="plug-text">
              <b>允许 AI 调用 MCP 工具</b>
              <small>{{ switchState.kind === "ready" ? (switchState.enabled ? "已打开：AI 可以提议调用下面已连接服务的工具，每次调用都要你批准。" : "已关闭：AI 看不到也用不了任何 MCP 工具。") : switchState.kind === "loading" ? "正在读取…" : "暂时读不到开关状态" }}</small>
            </span>
            <span class="plug-switch" role="switch" tabindex="0" :aria-checked="mcpAllowed" aria-label="允许 AI 调用 MCP 工具" data-plug-mcp-switch :data-busy="switchBusy" @click="toggleSwitch" @keydown.enter.space.prevent="toggleSwitch" />
          </div>
          <p v-if="connError" class="plug-msg bad">{{ connError }}</p>
          <div v-for="c in shownConns" :key="c.id" class="plug-item" :data-plug-conn="c.id" :data-enabled="c.enabled">
            <span class="plug-ic"><Plug :size="16" /></span>
            <span class="plug-text"><b>{{ c.name }}</b><small>{{ CONN_STATUS[c.status] || c.status }}{{ c.server ? " · " + c.server : "" }}{{ c.transport ? " · " + c.transport : "" }}</small></span>
            <button type="button" class="plug-btn" :data-plug-use-conn="c.id" @click="useConn(c)">在对话中使用</button>
            <span class="plug-switch" role="switch" tabindex="0" :aria-checked="c.enabled" :aria-label="(c.enabled ? '停用 ' : '启用 ') + c.name" :data-plug-conn-switch="c.id" @click="toggleConn(c)" @keydown.enter.space.prevent="toggleConn(c)" />
          </div>
          <p v-if="connsLoaded && !connError && !shownConns.length" class="plug-empty">{{ query ? "没有匹配的连接。" : "还没有 MCP 连接。可以在 MCP 中心添加。" }}</p>
          <button type="button" class="plug-more" data-plug-open-mcp @click="shell.activateApp('mcp-center')"><ExternalLink :size="13" />在 MCP 中心添加或配置连接</button>
        </template>
      </div>
    </div>
    <div v-if="notice" class="plug-toast" role="status" data-plug-toast>{{ notice }}</div>
  </div>
</template>

<style scoped>
.plug { position: relative; flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.plug-toolbar { gap: 8px; height: 52px; margin: 0; padding: 0 12px 0 20px; flex: none; }
.plug-title { font-size: var(--fs-headline); }
.plug-link, .plug-more { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 10px; border-radius: var(--radius-pill); font-size: var(--fs-caption); color: var(--muted); }
.plug-link:hover, .plug-more:hover { background: rgb(var(--text-rgb) / 0.06); color: var(--text); }
.plug-more { align-self: flex-start; margin-top: 4px; }
.plug-scroll { flex: 1; min-height: 0; overflow: auto; padding: 20px 24px 32px; }
.plug-col { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 8px; }
.plug-head h2 { margin: 6px 0 4px; font-size: var(--fs-title); font-weight: var(--fw-medium); }
.plug-head p { margin: 0 0 8px; color: var(--muted); font-size: var(--fs-secondary); line-height: var(--lh-relaxed); }
.plug-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
.plug-tabs { display: inline-flex; padding: 2px; border-radius: var(--radius-pill); background: rgb(var(--text-rgb) / 0.06); }
.plug-tabs button { display: inline-flex; align-items: center; gap: 5px; padding: 5px 12px; border-radius: var(--radius-pill); font-size: var(--fs-caption); color: var(--muted); }
.plug-tabs button[aria-selected="true"] { background: rgb(var(--content-rgb)); color: var(--text); box-shadow: 0 1px 2px rgb(0 0 0 / 0.12); }
.plug-tabs small { color: var(--muted); font-size: var(--fs-micro, 11px); }
.plug-search { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border-radius: var(--radius-pill); background: rgb(var(--text-rgb) / 0.05); color: var(--muted); }
.plug-search input { width: 160px; border: 0; outline: 0; background: none; color: var(--text); font: inherit; font-size: var(--fs-caption); }
.plug-item, .plug-master { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.035); }
.plug-master { background: none; box-shadow: inset 0 0 0 0.5px var(--line); margin-bottom: 4px; }
.plug-item[data-enabled="false"] .plug-text { opacity: 0.55; }
.plug-ic { flex: none; width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: rgb(var(--content-rgb)); color: var(--text); }
.plug-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.plug-text b { font-size: var(--fs-secondary); font-weight: var(--fw-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plug-text small { color: var(--muted); font-size: var(--fs-caption); line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.plug-tag { flex: none; padding: 1px 7px; border-radius: var(--radius-pill); background: rgb(var(--text-rgb) / 0.06); color: var(--muted); font-size: var(--fs-micro, 11px); }
.plug-btn { flex: none; height: 28px; padding: 0 10px; border-radius: var(--radius-pill); font-size: var(--fs-caption); color: var(--text); background: rgb(var(--content-rgb)); box-shadow: inset 0 0 0 0.5px var(--line); }
.plug-btn:hover { background: rgb(var(--text-rgb) / 0.05); }
.plug-switch { flex: none; position: relative; width: 32px; height: 18px; border-radius: 9px; background: rgb(var(--text-rgb) / 0.18); cursor: pointer; transition: background 0.15s; }
.plug-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / 0.25); transition: transform 0.15s; }
.plug-switch[aria-checked="true"] { background: #34c759; }
.plug-switch[aria-checked="true"]::after { transform: translateX(14px); }
.plug-switch[data-busy="true"] { opacity: 0.6; }
.plug-empty, .plug-msg { margin: 6px 2px; color: var(--muted); font-size: var(--fs-caption); }
.plug-msg.bad { color: var(--failed); }
.plug-toast { position: absolute; left: 50%; bottom: 20px; transform: translateX(-50%); padding: 8px 14px; border-radius: var(--radius-pill); background: var(--text); color: rgb(var(--content-rgb)); font-size: var(--fs-caption); box-shadow: 0 6px 20px rgb(0 0 0 / 0.18); }
</style>
