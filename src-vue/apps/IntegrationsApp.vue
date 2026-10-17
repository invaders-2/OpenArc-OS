<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Activity, ExternalLink, ListChecks, Palette, PenTool, PlugZap, RefreshCw, ShieldCheck } from "lucide-vue-next";
import DsBadge from "../design-system/DsBadge.vue";
import DsButton from "../design-system/DsButton.vue";
import DsDialog from "../design-system/DsDialog.vue";
import DsPageState from "../design-system/DsPageState.vue";
import { useShellStore } from "../stores/shell";
import {
  detailText,
  domainBridge,
  failureText,
  formatTime,
  invokeDomain,
  resultFailure,
  resultValue,
  type CommandReply,
  type FailureView,
} from "../bridge/domain";

/**
 * 第三方集成入口（0.6.1 · 接既有 integration:command，不新增 IPC）。
 *
 * 数据全部来自主进程真值：
 *   · integration/plugins/list   登记表（默认全关）
 *   · integration/plugins/health 依赖探测（默认不出网；只有显式「连通测试」才带 probeNetwork=true）
 *   · integration/<id>/status    各服务自己的状态投影（只回掩码，不回明文）
 *   · integration/commands       命令目录（risk / credential / 摘要），审计页直接读它
 * 没有任何演示数据：没有桥 = 不可用态；未配置 = 空态 + 下一步说明；启用失败 = 后端原文。
 */
type PluginItem = {
  id: string;
  name: string;
  description: string;
  kind: string;
  version: string;
  enabled: boolean;
  requiredDependencies: string[];
  optionalDependencies: string[];
  capabilities: string[];
};
type DepStatus = {
  id: string;
  kind: string;
  label: string;
  required: boolean;
  status: "ok" | "missing" | "unknown" | string;
  detail?: string;
  install?: string;
};
type PluginHealth = {
  id: string;
  name: string;
  kind: string;
  version: string;
  description: string;
  enabled: boolean;
  status: "disabled" | "healthy" | "degraded" | "unavailable" | string;
  dependencies: DepStatus[];
  capabilities: { name: string; available: boolean }[];
  missingRequired: string[];
  missingOptional: string[];
  detail: string;
};
type CommandMeta = { command: string; risk: string; credential: boolean; summary: string };
type LogEntry = { at: number; command: string; ok: boolean; code?: string; detail?: string };

const bridge = domainBridge(typeof window === "undefined" ? null : window, "integration");
const hasBridge = ref(!!bridge);
const shell = useShellStore();

const allAudit = ref(false);
const loading = ref(false);
const overviewError = ref<FailureView | null>(null);
const plugins = ref<PluginItem[]>([]);
const healthById = ref<Record<string, PluginHealth>>({});
const summary = ref<{ commands: number; plugins: number; enabled: string[] } | null>(null);
const selected = ref<string | null>(null);

const detailLoading = ref(false);
const detailError = ref<FailureView | null>(null);
const detailNote = ref("");
const statusValue = ref<Record<string, unknown> | null>(null);
const credentialValue = ref<Record<string, unknown> | null>(null);
const dingtalkChannels = ref<Record<string, unknown>[]>([]);
const quarkAccount = ref<Record<string, unknown> | null>(null);
const actionBusy = ref<string | null>(null);
const actionError = ref<FailureView | null>(null);
const actionNotice = ref("");

const catalog = ref<CommandMeta[]>([]);
const catalogError = ref<FailureView | null>(null);
const logEntries = ref<LogEntry[]>([]);
const auditFilter = ref("");

const credentialSecret = ref("");
const channelForm = ref({ name: "", webhook: "", secret: "" });

/* ── 设计工具（Figma / Illustrator）：不是 integration 插件，单独一栏 ──────────
   数据面：MCP 配置来自 mcp/list（没有登记就如实显示）；来源与启动能力来自既有 media / browser 命令。
   Figma：预览文件清单 / 构建（构建器未注入时结构化不可用）+ 系统浏览器打开（用户二次确认）。
   Illustrator：本机检测（未安装时 media/illustrator/config/get 结构化不可用）+ 启动命令未注册。 */
type DesignToolId = "figma" | "illustrator";
type DesignProbe = { ok: boolean; code: string; detail: string; value: Record<string, unknown> | null };
type McpItem = {
  connectionId: string; name: string; transport: string; location: string; enabled: boolean;
  status: string; serverName: string | null; endpoint: Record<string, unknown> | null;
};
const DESIGN_TOOLS: { id: DesignToolId; name: string; description: string; sourceHint: string }[] = [
  { id: "figma", name: "Figma", description: "设计稿预览：拉取 Figma 预览文件清单、用注入的构建器打包成可预览页面。", sourceHint: "预览文件清单走 media/figma-preview/files；打包走 media/figma-preview/build（需要主进程注入 Vite 构建器）。" },
  { id: "illustrator", name: "Adobe Illustrator", description: "本机 Illustrator：读取/写入 Illustrator 配置、准备临时导出与预览。", sourceHint: "配置与临时导出走 media/illustrator/*（需要本机安装 Illustrator 并注入适配器）。" },
];
const designSelected = ref<DesignToolId | null>(null);
const mcpItems = ref<McpItem[]>([]);
const mcpError = ref<FailureView | null>(null);
const designBusy = ref<string | null>(null);
const designProbes = ref<Record<DesignToolId, DesignProbe | null>>({ figma: null, illustrator: null });
const figmaSourceUrl = ref("");
const figmaFetchBusy = ref(false);
const figmaFetch = ref<{ ok: boolean; count: number; code: string; detail: string } | null>(null);
const figmaOpenAsk = ref(false);
const launchNotice = ref("");
const launchError = ref("");

async function callDomain(domain: string, command: string, payload: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const api = typeof window === "undefined" ? null : (window as any).openarc?.[domain];
  if (!api || typeof api.command !== "function") return { ok: false, error: "BRIDGE_ABSENT" };
  try {
    const reply = await api.command({ command, payload });
    return reply && typeof reply === "object" ? reply : { ok: false, error: "MALFORMED_REPLY" };
  } catch (error) {
    return { ok: false, error: "BRIDGE_ERROR", detail: error instanceof Error ? error.message : String(error) };
  }
}
function toProbe(reply: Record<string, any>): DesignProbe {
  return {
    ok: reply.ok === true,
    code: typeof reply.error === "string" ? reply.error : (reply.ok === true ? "" : "DXOS_ERR_INTERNAL"),
    detail: typeof reply.detail === "string" ? reply.detail : (reply.detail == null ? "" : JSON.stringify(reply.detail)),
    value: reply.value && typeof reply.value === "object" ? reply.value : null,
  };
}
async function loadMcpConfig() {
  const reply = await callDomain("mcp", "mcp/list", {});
  if (reply.ok === true && Array.isArray(reply.items)) {
    mcpItems.value = reply.items.map((item: any) => ({
      connectionId: String(item && item.connectionId || ""),
      name: String(item && item.name || ""),
      transport: String(item && item.transport || ""),
      location: String(item && item.location || ""),
      enabled: item && item.enabled === true,
      status: String(item && item.status || ""),
      serverName: item && typeof item.serverName === "string" ? item.serverName : null,
      endpoint: item && item.endpoint && typeof item.endpoint === "object" ? item.endpoint : null,
    }));
    mcpError.value = null;
  } else {
    mcpItems.value = [];
    mcpError.value = resultFailure(reply) || { code: "MCP_UNAVAILABLE", message: "" };
  }
}
function mcpMatches(tool: DesignToolId): McpItem[] {
  const pattern = tool === "figma" ? /figma/i : /illustrator|adobe/i;
  return mcpItems.value.filter((item) => {
    const haystack = [item.name, item.serverName || "", JSON.stringify(item.endpoint || {})].join(" ");
    return pattern.test(haystack);
  });
}
async function probeDesign(tool: DesignToolId) {
  designBusy.value = tool;
  launchNotice.value = "";
  launchError.value = "";
  const reply = tool === "figma"
    ? await callDomain("media", "media/figma-preview/build", { projectId: "designprobe", files: [] })
    : await callDomain("media", "media/illustrator/config/get", {});
  designProbes.value = { ...designProbes.value, [tool]: toProbe(reply) };
  designBusy.value = null;
}
function mcpMatchesSelected(): McpItem[] {
  return designSelected.value ? mcpMatches(designSelected.value) : [];
}
async function probeSelectedDesign(): Promise<void> {
  if (designSelected.value) await probeDesign(designSelected.value);
}
async function selectDesign(tool: DesignToolId) {
  allAudit.value = false;
  designSelected.value = tool;
  actionError.value = null;
  actionNotice.value = "";
  await Promise.all([loadMcpConfig(), probeDesign(tool)]);
}
function leaveDesign() {
  designSelected.value = null;
  launchNotice.value = "";
  launchError.value = "";
}
async function fetchFigmaFiles() {
  const url = figmaSourceUrl.value.trim();
  figmaFetch.value = null;
  if (!/^https:\/\//i.test(url)) {
    figmaFetch.value = { ok: false, count: 0, code: "INVALID_INPUT", detail: "预览清单地址必须是 HTTPS" };
    return;
  }
  figmaFetchBusy.value = true;
  const reply = await callDomain("media", "media/figma-preview/files", { sourceUrl: url });
  figmaFetchBusy.value = false;
  const probe = toProbe(reply);
  const files = reply.ok === true && Array.isArray(reply.value && reply.value.files) ? reply.value.files.length : 0;
  figmaFetch.value = { ok: probe.ok, count: files, code: probe.code, detail: probe.detail };
}
async function openFigmaExternal() {
  figmaOpenAsk.value = false;
  launchNotice.value = "";
  launchError.value = "";
  const reply = await callDomain("browser", "browser/openExternal", { url: "https://www.figma.com/" });
  if (reply && reply.ok === true) launchNotice.value = "已请求系统浏览器打开 Figma（实际打开由系统浏览器决定）。";
  else launchError.value = (reply && typeof reply.error === "string" ? reply.error : "BROWSER_UNAVAILABLE") + (reply && typeof reply.detail === "string" ? "：" + reply.detail : "");
}

/** 每个服务自己的状态命令；表里没有的服务只读依赖健康，不臆造状态。 */
const STATUS_COMMAND: Record<string, string> = {
  dingtalk: "integration/dingtalk/status",
  lingxing: "integration/lingxing/status",
  ziniao: "integration/ziniao/status",
  quark: "integration/quark/status",
  runninghub: "integration/runninghub/status",
  modelscope: "integration/modelscope/status",
  agnes: "integration/agnes/status",
};

/** 凭据表单只给后端确实有 save 命令的服务；字段名是各域 IPC 契约里的入参名。 */
const CREDENTIAL_FORM: Record<string, { command: string; field: string; label: string; hint: string }> = {
  lingxing: { command: "integration/lingxing/credential/save", field: "secret", label: "领星 API 凭据", hint: "写入系统安全存储；界面只回掩码，不回明文。" },
  ziniao: { command: "integration/ziniao/credential/save", field: "secret", label: "紫鸟账号凭据", hint: "写入系统安全存储；界面只回掩码，不回明文。" },
  runninghub: { command: "integration/runninghub/credentials/save", field: "apiKey", label: "RunningHub API Key", hint: "写入系统安全存储；界面只回掩码。" },
  modelscope: { command: "integration/modelscope/credentials/save", field: "accessToken", label: "ModelScope 访问令牌", hint: "写入系统安全存储；界面只回掩码。" },
  agnes: { command: "integration/agnes/credentials/save", field: "apiKey", label: "Agnes API Key", hint: "写入系统安全存储；界面只回掩码。" },
};

const current = computed(() => plugins.value.find((item) => item.id === selected.value) ?? null);
const currentHealth = computed(() => (selected.value ? healthById.value[selected.value] ?? null : null));
const currentStatusCommand = computed(() => (selected.value ? STATUS_COMMAND[selected.value] ?? null : null));
const credentialForm = computed(() => (selected.value ? CREDENTIAL_FORM[selected.value] ?? null : null));

const STATUS_TONE: Record<string, "neutral" | "success" | "warning" | "danger"> = {
  healthy: "success",
  degraded: "warning",
  unavailable: "warning",
  missing: "warning",
  ok: "success",
  disabled: "neutral",
  unknown: "neutral",
};
const STATUS_TEXT: Record<string, string> = {
  healthy: "正常",
  degraded: "降级",
  unavailable: "不可用",
  disabled: "未启用",
  ok: "就绪",
  missing: "缺失",
  unknown: "未探测",
};
const DEP_KIND_TEXT: Record<string, string> = { binary: "本机程序", python: "Python 包", network: "网络", credential: "凭据" };
const RISK_TEXT: Record<string, string> = { read: "只读", use: "会产生外部动作", manage: "会修改配置", destructive: "破坏性", external: "会出网" };

function statusText(value: unknown): string {
  const key = String(value ?? "");
  return STATUS_TEXT[key] || key || "未知";
}
function healthTone(item: PluginHealth | null): "neutral" | "success" | "warning" | "danger" {
  if (!item) return "neutral";
  return item.enabled ? STATUS_TONE[item.status] ?? "neutral" : "neutral";
}
function healthLabel(item: PluginHealth | null): string {
  if (!item) return "未读取";
  return item.enabled ? statusText(item.status) : "未启用";
}

function record(command: string, reply: CommandReply) {
  const failure = resultFailure(reply);
  logEntries.value = [
    { at: Date.now(), command, ok: !failure, code: failure?.code, detail: failure ? detailText(failure.detail) || failure.message : undefined },
    ...logEntries.value,
  ].slice(0, 120);
}

async function send(command: string, payload: Record<string, unknown> = {}): Promise<CommandReply> {
  if (!bridge) return { ok: false, error: "BRIDGE_ABSENT" };
  const reply = await invokeDomain("integration", command, payload);
  record(command, reply);
  return reply;
}

async function loadOverview() {
  if (!bridge) return;
  loading.value = true;
  overviewError.value = null;
  const [healthReply, listReply, commandsReply] = await Promise.all([
    send("integration/health", {}),
    send("integration/plugins/list", {}),
    send("integration/commands", {}),
  ]);
  loading.value = false;

  const healthValue = resultValue<{ commands?: number; plugins?: number; enabled?: string[] }>(healthReply);
  if (healthValue) summary.value = { commands: Number(healthValue.commands) || 0, plugins: Number(healthValue.plugins) || 0, enabled: Array.isArray(healthValue.enabled) ? healthValue.enabled : [] };
  else overviewError.value = resultFailure(healthReply);

  const listValue = resultValue<{ items?: PluginItem[] }>(listReply);
  if (listValue) {
    plugins.value = Array.isArray(listValue.items) ? listValue.items : [];
    if (!selected.value || !plugins.value.some((item) => item.id === selected.value)) selected.value = plugins.value[0]?.id ?? null;
  } else if (!overviewError.value) overviewError.value = resultFailure(listReply);

  const catalogValue = resultValue<{ items?: CommandMeta[] }>(commandsReply);
  if (catalogValue) {
    catalog.value = Array.isArray(catalogValue.items) ? catalogValue.items : [];
    catalogError.value = null;
  } else {
    catalogError.value = resultFailure(commandsReply);
  }

  await Promise.all(plugins.value.map((item) => loadHealth(item.id)));
  if (selected.value) await loadDetail();
}

async function loadHealth(id: string, probeNetwork = false) {
  const reply = await send("integration/plugins/health", { id, probeNetwork, force: probeNetwork });
  const value = resultValue<{ plugin?: PluginHealth }>(reply);
  if (value?.plugin) healthById.value = { ...healthById.value, [id]: value.plugin };
}

async function loadDetail() {
  const id = selected.value;
  if (!id) return;
  detailLoading.value = true;
  detailError.value = null;
  detailNote.value = "";
  statusValue.value = null;
  credentialValue.value = null;
  dingtalkChannels.value = [];
  quarkAccount.value = null;
  actionError.value = null;
  credentialSecret.value = "";
  channelForm.value = { name: "", webhook: "", secret: "" };
  try {
    await loadHealth(id);
    // 未启用的插件对状态 / 凭据 / 频道命令一律结构化拒绝（gate）；这是预期状态，不当错误显示。
    if (!current.value?.enabled) {
      detailNote.value = "服务未启用；启用后这里显示运行时状态、凭据读取结果与连通测试。";
      return;
    }
    const statusCommand = STATUS_COMMAND[id];
    if (statusCommand && id !== "weather" && id !== "almanac") {
      const reply = await send(statusCommand, {});
      const value = resultValue<Record<string, unknown>>(reply);
      if (value) statusValue.value = value;
      else detailError.value = resultFailure(reply);
    }
    if (id === "dingtalk") await loadDingtalkChannels();
    if (id === "quark") {
      const reply = await send("integration/quark/account", {});
      const value = resultValue<Record<string, unknown>>(reply);
      quarkAccount.value = value ?? null;
      const credReply = await send("integration/quark/credential/status", {});
      credentialValue.value = resultValue<Record<string, unknown>>(credReply);
    } else if (credentialForm.value) {
      const credCommand = id === "lingxing" ? "integration/lingxing/credential/status" : id === "ziniao" ? "integration/ziniao/credential/status" : null;
      if (credCommand) {
        const reply = await send(credCommand, {});
        credentialValue.value = resultValue<Record<string, unknown>>(reply);
      }
    }
  } finally {
    detailLoading.value = false;
  }
}

async function selectPlugin(id: string) {
  allAudit.value = false;
  designSelected.value = null;
  launchNotice.value = "";
  launchError.value = "";
  selected.value = id;
  actionNotice.value = "";
  await loadDetail();
}

async function toggleEnabled() {
  const item = current.value;
  if (!item) return;
  const command = item.enabled ? "integration/plugins/disable" : "integration/plugins/enable";
  actionBusy.value = "toggle";
  actionError.value = null;
  actionNotice.value = "";
  const reply = await send(command, { id: item.id });
  actionBusy.value = null;
  const value = resultValue<Record<string, unknown>>(reply);
  if (!value) {
    actionError.value = resultFailure(reply);
    return;
  }
  actionNotice.value = item.enabled ? "已停用；配置与凭据保留，可再次启用。" : "已启用；依赖缺失时会在下方如实标注降级原因。";
  await loadOverview();
  await loadHealth(item.id);
  if (selected.value === item.id) await loadDetail();
}

async function testConnectivity() {
  const item = current.value;
  if (!item) return;
  actionBusy.value = "probe";
  actionError.value = null;
  actionNotice.value = "";
  const reply = await send("integration/plugins/health", { id: item.id, probeNetwork: true, force: true });
  actionBusy.value = null;
  const value = resultValue<{ plugin?: PluginHealth }>(reply);
  if (!value?.plugin) {
    actionError.value = resultFailure(reply);
    return;
  }
  healthById.value = { ...healthById.value, [item.id]: value.plugin };
  const networks = value.plugin.dependencies.filter((dep) => dep.kind === "network");
  if (!networks.length) actionNotice.value = "这个服务没有登记网络依赖，不需要连通测试。";
  else if (networks.every((dep) => dep.status === "ok")) actionNotice.value = "连通测试完成：登记的网络依赖全部可达。";
  else actionNotice.value = "连通测试完成：有网络依赖不可达或无法确认，原因见下方依赖明细。";
}

async function saveCredential() {
  const item = current.value;
  const form = credentialForm.value;
  if (!item || !form) return;
  const secret = credentialSecret.value.trim();
  if (!secret) {
    actionError.value = { code: "INVALID", message: "请先填写凭据再保存。" };
    return;
  }
  actionBusy.value = "credential";
  actionError.value = null;
  actionNotice.value = "";
  const reply = await send(form.command, { [form.field]: secret });
  const value = resultValue<Record<string, unknown>>(reply);
  actionBusy.value = null;
  if (!value) {
    actionError.value = resultFailure(reply);
    return;
  }
  credentialSecret.value = "";
  actionNotice.value = "凭据已写入系统安全存储；下方只显示掩码。";
  await loadDetail();
}

async function loadDingtalkChannels() {
  const reply = await send("integration/dingtalk/channels", {});
  const value = resultValue<{ items?: Record<string, unknown>[] }>(reply);
  dingtalkChannels.value = Array.isArray(value?.items) ? value!.items! : [];
}

async function saveDingtalkChannel() {
  const form = channelForm.value;
  if (!form.webhook.trim()) {
    actionError.value = { code: "INVALID", message: "Webhook 不能为空。" };
    return;
  }
  actionBusy.value = "channel";
  actionError.value = null;
  actionNotice.value = "";
  const reply = await send("integration/dingtalk/channels/save", {
    name: form.name.trim() || "机器人",
    webhook: form.webhook.trim(),
    secret: form.secret.trim(),
  });
  actionBusy.value = null;
  if (!resultValue(reply)) {
    actionError.value = resultFailure(reply);
    return;
  }
  actionNotice.value = "机器人已保存；Webhook 与加签密钥写入安全存储，列表只回掩码。";
  channelForm.value = { name: "", webhook: "", secret: "" };
  await loadDingtalkChannels();
  await loadHealth("dingtalk");
}

async function deleteDingtalkChannel(id: string) {
  actionBusy.value = "channel";
  actionError.value = null;
  const reply = await send("integration/dingtalk/channels/delete", { id });
  actionBusy.value = null;
  if (!resultValue(reply)) actionError.value = resultFailure(reply);
  await loadDingtalkChannels();
  await loadHealth("dingtalk");
}

async function quarkLogin() {
  actionBusy.value = "quark";
  actionError.value = null;
  actionNotice.value = "";
  const reply = await send("integration/quark/login/start", {});
  actionBusy.value = null;
  const value = resultValue<Record<string, unknown>>(reply);
  if (!value) {
    actionError.value = resultFailure(reply);
    return;
  }
  const url = typeof value.url === "string" ? value.url : "";
  actionNotice.value = url ? "已发起扫码登录，请在浏览器打开：" + url : "已发起扫码登录，请按终端提示完成授权。";
  await loadDetail();
}

async function quarkStopLogin() {
  actionBusy.value = "quark";
  const reply = await send("integration/quark/login/stop", {});
  actionBusy.value = null;
  if (!resultValue(reply)) actionError.value = resultFailure(reply);
  else actionNotice.value = "已停止当前登录流程。";
}

async function quarkLogout() {
  actionBusy.value = "quark";
  actionError.value = null;
  const reply = await send("integration/quark/logout", {});
  actionBusy.value = null;
  if (!resultValue(reply)) actionError.value = resultFailure(reply);
  else {
    actionNotice.value = "已退出夸克登录。";
    await loadDetail();
  }
}

/** 状态投影里只显示原始标量；嵌套结构交给审计日志，别在界面上编造摘要。 */
function scalarRows(value: Record<string, unknown> | null): { key: string; text: string }[] {
  if (!value) return [];
  const rows: { key: string; text: string }[] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null || raw === undefined) continue;
    if (typeof raw === "object") continue;
    if (typeof raw === "boolean") rows.push({ key, text: raw ? "是" : "否" });
    else if (typeof raw === "number") rows.push({ key, text: String(raw) });
    else if (typeof raw === "string" && raw.length) rows.push({ key, text: raw.length > 180 ? raw.slice(0, 180) + "…" : raw });
  }
  return rows;
}

const statusRows = computed(() => scalarRows(statusValue.value));
const credentialRows = computed(() => scalarRows(credentialValue.value));
const filteredCatalog = computed(() => {
  const q = auditFilter.value.trim().toLowerCase();
  if (!q) return catalog.value;
  return catalog.value.filter((item) => (item.command + " " + item.summary + " " + item.risk).toLowerCase().includes(q));
});
const pluginCatalog = computed(() => {
  const id = selected.value;
  if (!id) return [];
  return catalog.value.filter((item) => item.command.startsWith("integration/" + id + "/") || item.command.startsWith("integration/plugins/"));
});
const enabledCount = computed(() => plugins.value.filter((item) => item.enabled).length);
/** 详情页第三区只列与当前服务相关的真实调用；全部记录在「全部命令与审计」里。 */
const serviceLogs = computed(() => {
  const id = selected.value;
  if (!id) return [];
  return logEntries.value.filter((entry) => entry.command.startsWith("integration/" + id + "/") || entry.command.startsWith("integration/plugins/"));
});
const pageTitle = computed(() => {
  if (allAudit.value) return "全部命令与审计";
  if (designSelected.value) return "设计工具";
  return current.value ? current.value.name : "第三方集成";
});
function openAllAudit() {
  allAudit.value = true;
  designSelected.value = null;
}
function closeAllAudit() {
  allAudit.value = false;
}

onMounted(() => {
  void loadOverview();
  void loadMcpConfig();
});
</script>

<template>
  <div class="split integrations-app">
    <nav class="split-side" aria-label="第三方集成">
      <div class="split-section">全部服务</div>
      <button
        v-for="item in plugins"
        :key="item.id"
        type="button"
        class="split-nav integr-service"
        :data-integration-service="item.id"
        :data-integration-enabled="item.enabled ? 'true' : 'false'"
        :aria-current="selected === item.id && !allAudit && !designSelected ? 'true' : undefined"
        @click="selectPlugin(item.id)"
      >
        <span class="split-nav-label integr-service-name">{{ item.name }}</span>
        <DsBadge size="sm" :tone="healthTone(healthById[item.id] ?? null)">{{ healthLabel(healthById[item.id] ?? null) }}</DsBadge>
      </button>
      <p v-if="!plugins.length && !loading" class="planned-note">主进程没有登记任何集成插件。</p>

      <div class="split-section">设计工具</div>
      <button
        v-for="tool in DESIGN_TOOLS"
        :key="tool.id"
        type="button"
        class="split-nav integr-service"
        :data-design-tool-entry="tool.id"
        :aria-current="designSelected === tool.id && !allAudit ? 'true' : undefined"
        @click="selectDesign(tool.id)"
      >
        <PenTool v-if="tool.id === 'figma'" :size="16" />
        <Palette v-else :size="16" />
        <span class="split-nav-label integr-service-name">{{ tool.name }}</span>
        <DsBadge size="sm" :tone="mcpMatches(tool.id).length ? 'success' : 'neutral'">{{ mcpMatches(tool.id).length ? "MCP 已登记" : "未登记 MCP" }}</DsBadge>
      </button>

      <div class="split-section">审计</div>
      <button
        type="button"
        class="split-nav integr-audit-link"
        :aria-current="allAudit ? 'true' : undefined"
        data-integrations-all-audit-link
        @click="openAllAudit"
      >
        <ListChecks :size="16" />
        <span class="split-nav-label">全部命令与审计</span>
        <small class="integr-count">{{ catalog.length }}</small>
      </button>
      <p class="integr-side-note">插件默认全部关闭；启用不改依赖、不联网。连通测试只访问各服务登记的主机，不读取凭据。</p>
    </nav>

    <div class="split-main integr-main">
      <div class="pane-toolbar">
        <strong class="pane-title">{{ pageTitle }}</strong>
        <span v-if="!allAudit && !designSelected && current" class="badge">{{ current.enabled ? "已启用" : "未启用" }}</span>
        <span v-else-if="allAudit" class="badge">{{ catalog.length }} 条命令 · {{ logEntries.length }} 条记录</span>
        <div class="toolbar-spacer" />
        <DsBadge v-if="summary" size="sm" class="integr-summary">
          <Activity :size="12" />
          {{ summary.commands }} 条命令 · 已启用 {{ enabledCount }}/{{ plugins.length }}
        </DsBadge>
        <DsButton size="sm" variant="ghost" :status="loading ? 'loading' : 'idle'" data-integrations-refresh @click="loadOverview">
          <RefreshCw :size="13" /> 刷新
        </DsButton>
      </div>

      <DsPageState
        v-if="!hasBridge"
        kind="unavailable"
        title="当前环境没有集成域的桥"
        description="浏览器预览不提供 integration:command；请在 OpenArc 桌面应用中打开这个应用。"
      />

      <DsPageState
        v-else-if="overviewError"
        kind="error"
        title="读不到集成插件"
        :description="failureText(overviewError)"
        :on-action="loadOverview"
      />

      <div v-else-if="allAudit" class="integr-body" data-integrations-audit="all">
        <div class="integr-audit-bar">
          <DsButton size="sm" variant="ghost" data-integration-audit-back @click="closeAllAudit">返回服务</DsButton>
          <label class="integr-filter">
            <span>过滤命令</span>
            <input v-model="auditFilter" type="search" placeholder="命令 / 摘要 / 风险" aria-label="过滤集成命令" />
          </label>
        </div>
        <p class="integr-note integr-page-note">
          命令目录与 risk / credential 都由主进程冻结；右侧是本次窗口真实调用过的命令与结果。不把“调用过”推定成“调用成功”。
        </p>
        <div class="integr-detail-layout integr-detail-layout--wide">
          <section class="integr-zone" data-integration-zone="detail">
            <h2 class="integr-zone-title">命令目录<span class="integr-zone-count">{{ filteredCatalog.length }}</span></h2>
            <DsPageState v-if="catalogError" kind="error" title="命令目录读不到" :description="failureText(catalogError)" />
            <DsPageState v-else-if="!catalog.length" kind="empty" title="没有登记任何集成命令" />
            <ul v-else class="integr-rows">
              <li v-for="item in filteredCatalog" :key="item.command" class="integr-row integr-command" :data-integration-command="item.command">
                <span class="mono integr-command-name">{{ item.command }}</span>
                <DsBadge size="sm">{{ RISK_TEXT[item.risk] || item.risk }}</DsBadge>
                <DsBadge v-if="item.credential" size="sm" tone="warning">触碰凭据</DsBadge>
                <span class="integr-row-desc">{{ item.summary }}</span>
              </li>
            </ul>
          </section>
          <section class="integr-zone" data-integration-zone="audit">
            <h2 class="integr-zone-title">本次窗口的调用记录<span class="integr-zone-count">{{ logEntries.length }}</span></h2>
            <DsPageState v-if="!logEntries.length" kind="empty" title="还没有调用过集成命令" description="刷新、启用、测试连通性或保存凭据后，这里会出现真实结果。" />
            <ul v-else class="integr-rows">
              <li v-for="(entry, index) in logEntries" :key="entry.at + '-' + index" class="integr-row integr-log-row" :data-integration-log="entry.command">
                <span class="mono integr-log-time">{{ formatTime(entry.at) }}</span>
                <DsBadge size="sm" :tone="entry.ok ? 'success' : 'danger'">{{ entry.ok ? "成功" : "失败" }}</DsBadge>
                <span class="mono integr-command-name">{{ entry.command }}</span>
                <span class="integr-row-desc">{{ entry.ok ? "" : entry.code + (entry.detail ? " · " + entry.detail : "") }}</span>
              </li>
            </ul>
          </section>
        </div>
      </div>

      <div v-else-if="designSelected" class="integr-body" :data-design-tool-panel="designSelected">
        <div class="integr-detail-layout">
          <section class="integr-zone" data-integration-zone="detail">
            <header class="integr-hero">
              <div class="integr-hero-head">
                <h1>{{ designSelected === "figma" ? "Figma" : "Adobe Illustrator" }}</h1>
                <DsBadge :tone="mcpMatchesSelected().length ? 'success' : 'warning'">{{ mcpMatchesSelected().length ? "MCP 已登记" : "未登记 MCP" }}</DsBadge>
                <DsBadge size="sm" tone="neutral">{{ designSelected === "figma" ? "设计稿预览" : "本机 Illustrator" }}</DsBadge>
                <span class="integr-version">{{ designSelected === "figma" ? "media/figma-preview" : "media/illustrator" }}</span>
              </div>
              <p class="integr-desc">{{ designSelected === "figma" ? DESIGN_TOOLS[0].description : DESIGN_TOOLS[1].description }}</p>
              <div class="integr-actions">
                <DsButton size="sm" variant="ghost" data-design-back @click="leaveDesign">返回服务</DsButton>
                <DsButton size="sm" variant="secondary" :status="designBusy === designSelected ? 'loading' : 'idle'" data-design-refresh @click="probeSelectedDesign()">
                  <RefreshCw :size="13" /> 重新检查
                </DsButton>
                <DsButton v-if="designSelected === 'figma'" size="sm" variant="primary" data-design-open-figma @click="figmaOpenAsk = true">
                  <ExternalLink :size="13" /> 在系统浏览器打开 Figma
                </DsButton>
                <DsButton v-else size="sm" variant="primary" disabled data-design-launch-unavailable>启动 Illustrator（未注册命令）</DsButton>
              </div>
              <p v-if="launchNotice" class="integr-ok" role="status" data-design-launch-notice>{{ launchNotice }}</p>
              <p v-if="launchError" class="integr-error" role="alert" data-design-launch-error>{{ launchError }}</p>
            </header>
          </section>

          <section class="integr-zone" data-integration-zone="status">
            <h2 class="integr-zone-title">状态与依赖</h2>
            <section class="integr-sec" data-design-mcp>
              <h3>MCP 配置</h3>
              <DsPageState v-if="mcpError" kind="error" title="MCP 配置读不到" :description="failureText(mcpError)" />
              <template v-else-if="mcpMatchesSelected().length">
                <ul class="integr-rows">
                  <li v-for="conn in mcpMatchesSelected()" :key="conn.connectionId" class="integr-row" :data-design-mcp-connection="conn.connectionId">
                    <span class="integr-dep-label">{{ conn.name }}</span>
                    <DsBadge size="sm">{{ conn.transport }}</DsBadge>
                    <DsBadge size="sm" :tone="conn.enabled ? 'success' : 'neutral'">{{ conn.enabled ? "已启用" : "未启用" }}</DsBadge>
                    <span class="integr-row-desc">{{ conn.serverName || conn.status }}</span>
                  </li>
                </ul>
                <div class="integr-actions"><DsButton size="sm" variant="secondary" data-design-open-mcp @click="shell.activateApp('mcp-center')">去 MCP 中心管理</DsButton></div>
              </template>
              <template v-else>
                <DsPageState
                  kind="empty"
                  title="未登记 MCP"
                  :description="designSelected === 'figma' ? 'MCP 中心里没有名称 / 端点包含 figma 的连接；添加 stdio 或 HTTP server 后才会在这里出现。' : 'MCP 中心里没有名称 / 端点包含 illustrator 或 adobe 的连接；添加后才会在这里出现。'"
                />
                <div class="integr-actions"><DsButton size="sm" variant="secondary" data-design-open-mcp @click="shell.activateApp('mcp-center')">去 MCP 中心添加</DsButton></div>
              </template>
            </section>

            <section class="integr-sec" data-design-source>
              <h3>来源与能力</h3>
              <p class="integr-note">{{ designSelected === "figma" ? DESIGN_TOOLS[0].sourceHint : DESIGN_TOOLS[1].sourceHint }}</p>
              <template v-if="designSelected === 'figma'">
                <div class="integr-row" data-design-probe="figma" :data-design-probe-ok="designProbes.figma?.ok ? '1' : '0'">
                  <span class="integr-dep-label">预览构建器</span>
                  <DsBadge size="sm" :tone="designProbes.figma?.ok ? 'success' : 'warning'">{{ designProbes.figma ? (designProbes.figma.ok ? "可用" : "不可用") : "未探测" }}</DsBadge>
                  <span class="integr-row-desc" data-design-probe-detail="figma">{{ designProbes.figma && !designProbes.figma.ok ? designProbes.figma.code + (designProbes.figma.detail ? " · " + designProbes.figma.detail : "") : (designProbes.figma ? "构建器已注入" : "尚未检查") }}</span>
                </div>
                <form class="integr-form" @submit.prevent="fetchFigmaFiles">
                  <label class="integr-field"><span>Figma 预览文件清单地址（HTTPS）</span><input v-model="figmaSourceUrl" placeholder="https://…/preview.json" data-design-figma-url /></label>
                  <DsButton type="submit" size="sm" variant="secondary" :status="figmaFetchBusy ? 'loading' : 'idle'" data-design-figma-fetch>拉取清单</DsButton>
                </form>
                <p v-if="figmaFetch" :class="figmaFetch.ok ? 'integr-ok' : 'integr-error'" :data-design-figma-result="figmaFetch.ok ? 'ok' : 'error'">
                  {{ figmaFetch.ok ? "已拉取 " + figmaFetch.count + " 个白名单文件" : "拉取失败：" + figmaFetch.code + (figmaFetch.detail ? " · " + figmaFetch.detail : "") }}
                </p>
              </template>
              <template v-else>
                <div class="integr-row" data-design-probe="illustrator" :data-design-probe-ok="designProbes.illustrator?.ok ? '1' : '0'">
                  <span class="integr-dep-label">本机 Illustrator</span>
                  <DsBadge size="sm" :tone="designProbes.illustrator?.ok ? 'success' : 'warning'">{{ designProbes.illustrator ? (designProbes.illustrator.ok ? "可用" : "不可用") : "未探测" }}</DsBadge>
                  <span class="integr-row-desc" data-design-probe-detail="illustrator">{{ designProbes.illustrator && !designProbes.illustrator.ok ? designProbes.illustrator.code + (designProbes.illustrator.detail ? " · " + designProbes.illustrator.detail : "") : (designProbes.illustrator ? "本机 Illustrator 可用" : "尚未检查") }}</span>
                </div>
              </template>
            </section>

            <section class="integr-sec" data-design-launch>
              <h3>启动 / 打开</h3>
              <p v-if="designSelected === 'figma'" class="integr-note">Figma 没有本机客户端启动命令，这里用系统浏览器打开 figma.com；只在你确认后调用 browser/openExternal。</p>
              <p v-else class="integr-note">当前构建没有注册启动 Adobe Illustrator 的命令（media/illustrator 只提供配置与临时导出）；检测到本机安装后仍可在系统中启动 Illustrator。</p>
            </section>
          </section>
        </div>
      </div>

      <div v-else class="integr-body" data-integrations-services>
        <DsPageState v-if="!plugins.length && !loading" kind="empty" title="没有可管理的集成服务" description="主进程的插件登记表为空。" />
        <div v-else-if="current" class="integr-detail-layout">
          <section class="integr-zone integr-zone--detail" data-integration-zone="detail">
            <header class="integr-hero">
              <div class="integr-hero-head">
                <h1>{{ current.name }}</h1>
                <DsBadge :tone="healthTone(currentHealth)">{{ healthLabel(currentHealth) }}</DsBadge>
                <DsBadge v-if="current.enabled" size="sm" tone="neutral">已启用</DsBadge>
                <span class="integr-version">v{{ current.version }}</span>
              </div>
              <p class="integr-desc">{{ current.description }}</p>
              <div class="integr-actions">
                <DsButton
                  :variant="current.enabled ? 'secondary' : 'primary'"
                  size="sm"
                  :status="actionBusy === 'toggle' ? 'loading' : 'idle'"
                  :data-integration-toggle="current.id"
                  @click="toggleEnabled"
                >
                  {{ current.enabled ? "停用" : "启用" }}
                </DsButton>
                <DsButton size="sm" variant="secondary" :status="actionBusy === 'probe' ? 'loading' : 'idle'" data-integration-probe @click="testConnectivity">
                  <ShieldCheck :size="13" /> 连通测试
                </DsButton>
                <DsButton size="sm" variant="ghost" :status="detailLoading ? 'loading' : 'idle'" @click="loadDetail">重新读取</DsButton>
              </div>
            </header>

            <p v-if="actionError" class="integr-error" role="alert" :data-integration-error="actionError.code">{{ failureText(actionError) }}<span v-if="actionError.detail" class="integr-detail"> · {{ detailText(actionError.detail) }}</span></p>
            <p v-if="actionNotice" class="integr-ok" role="status">{{ actionNotice }}</p>
            <p v-if="detailError" class="integr-error" role="alert">{{ failureText(detailError) }}</p>
            <p v-if="detailNote" class="integr-note">{{ detailNote }}</p>

            <section v-if="credentialForm || credentialRows.length" class="integr-sec">
              <h3>凭据</h3>
              <div v-if="credentialRows.length" class="integr-kv-wrap">
                <dl class="integr-kv">
                  <template v-for="row in credentialRows" :key="row.key">
                    <dt>{{ row.key }}</dt>
                    <dd>{{ row.text }}</dd>
                  </template>
                </dl>
              </div>
              <p v-if="!credentialRows.length" class="integr-note">还没有读到凭据状态；保存一次后这里只显示掩码，不显示明文。</p>
              <form v-if="credentialForm" class="integr-form" @submit.prevent="saveCredential">
                <label class="integr-field">
                  <span>{{ credentialForm.label }}</span>
                  <input v-model="credentialSecret" type="password" autocomplete="off" :placeholder="credentialForm.label" />
                </label>
                <DsButton type="submit" size="sm" variant="primary" :status="actionBusy === 'credential' ? 'loading' : 'idle'" :disabled="!credentialSecret.trim()">保存到安全存储</DsButton>
              </form>
              <p class="integr-note">{{ credentialForm?.hint || "凭据只交给主进程写入系统安全存储。" }}</p>
            </section>

            <section v-if="current.id === 'dingtalk'" class="integr-sec">
              <h3>钉钉群机器人</h3>
              <DsPageState v-if="!dingtalkChannels.length" kind="empty" title="还没有添加机器人" description="在下方填写群机器人的 Webhook（与加签密钥）；未配置时消息发送保持不可用。" />
              <ul v-else class="integr-rows">
                <li v-for="channel in dingtalkChannels" :key="String(channel.id)" class="integr-row" :data-dingtalk-channel="String(channel.id)">
                  <span class="integr-dep-label">{{ channel.name }}</span>
                  <DsBadge size="sm" :tone="channel.enabled ? 'success' : 'neutral'">{{ channel.enabled ? "启用" : "停用" }}</DsBadge>
                  <span class="integr-row-desc mono">{{ channel.webhookMask || "" }} {{ channel.secretSet ? "· 加签已保存" : "· 未设置加签" }}</span>
                  <DsButton size="sm" variant="danger" :status="actionBusy === 'channel' ? 'loading' : 'idle'" @click="deleteDingtalkChannel(String(channel.id))">删除</DsButton>
                </li>
              </ul>
              <form class="integr-form integr-form-col" @submit.prevent="saveDingtalkChannel">
                <label class="integr-field"><span>名称</span><input v-model="channelForm.name" placeholder="例如：运营群" /></label>
                <label class="integr-field"><span>Webhook</span><input v-model="channelForm.webhook" placeholder="https://oapi.dingtalk.com/robot/send?access_token=…" /></label>
                <label class="integr-field"><span>加签密钥（可选）</span><input v-model="channelForm.secret" type="password" autocomplete="off" placeholder="SEC…" /></label>
                <DsButton type="submit" size="sm" variant="primary" :status="actionBusy === 'channel' ? 'loading' : 'idle'" :disabled="!channelForm.webhook.trim()">保存机器人</DsButton>
              </form>
            </section>

            <section v-if="current.id === 'quark'" class="integr-sec">
              <h3>夸克登录态</h3>
              <div v-if="quarkAccount" class="integr-kv-wrap">
                <dl class="integr-kv">
                  <template v-for="row in scalarRows(quarkAccount)" :key="row.key">
                    <dt>{{ row.key }}</dt>
                    <dd>{{ row.text }}</dd>
                  </template>
                </dl>
              </div>
              <p v-else class="integr-note">没有读到登录态（官方 CLI 未配置或尚未登录时如实为空）。</p>
              <div class="integr-actions">
                <DsButton size="sm" variant="secondary" :status="actionBusy === 'quark' ? 'loading' : 'idle'" @click="quarkLogin">扫码登录</DsButton>
                <DsButton size="sm" variant="ghost" @click="quarkStopLogin">停止登录</DsButton>
                <DsButton size="sm" variant="danger" @click="quarkLogout">退出登录</DsButton>
              </div>
              <p class="integr-note">登录态由夸克官方 CLI 自己保存；桥面拿不到 token。</p>
            </section>
          </section>

          <section class="integr-zone integr-zone--status" data-integration-zone="status">
            <h2 class="integr-zone-title">状态与依赖</h2>
            <section class="integr-sec">
              <h3>依赖健康</h3>
              <DsPageState v-if="!currentHealth" kind="loading" title="正在读取依赖健康" />
              <template v-else>
                <ul class="integr-rows">
                  <li v-for="dep in currentHealth.dependencies" :key="dep.id" class="integr-row integr-dep-row" :data-integration-dep="dep.id">
                    <span class="integr-dep-label">{{ dep.label }}</span>
                    <DsBadge size="sm">{{ DEP_KIND_TEXT[dep.kind] || dep.kind }}</DsBadge>
                    <DsBadge size="sm" :tone="STATUS_TONE[dep.status] ?? 'neutral'">{{ statusText(dep.status) }}</DsBadge>
                    <DsBadge v-if="dep.required" size="sm" tone="neutral">必需</DsBadge>
                    <span class="integr-row-desc">{{ dep.detail || dep.install || "" }}</span>
                  </li>
                </ul>
                <p v-if="currentHealth.detail" class="integr-note">{{ currentHealth.detail }}</p>
              </template>
            </section>

            <section v-if="statusRows.length" class="integr-sec">
              <h3>服务状态</h3>
              <dl class="integr-kv">
                <template v-for="row in statusRows" :key="row.key">
                  <dt>{{ row.key }}</dt>
                  <dd>{{ row.text }}</dd>
                </template>
              </dl>
            </section>

            <section class="integr-sec">
              <h3>声明能力</h3>
              <p class="integr-note">{{ current.capabilities.length ? current.capabilities.join(" / ") : "无运行时能力依赖" }}</p>
              <p class="integr-note">必需依赖 {{ current.requiredDependencies.length }} 项 · 可选依赖 {{ current.optionalDependencies.length }} 项 · 版本 v{{ current.version }}</p>
            </section>
          </section>

          <section class="integr-zone integr-zone--audit" data-integration-zone="audit" data-integrations-audit="service">
            <div class="integr-zone-head">
              <h2 class="integr-zone-title">命令与审计</h2>
              <DsButton size="sm" variant="ghost" data-integration-audit-all @click="openAllAudit">全部命令与审计</DsButton>
            </div>
            <section class="integr-sec">
              <h3>相关命令<span class="integr-zone-count">{{ pluginCatalog.length }}</span></h3>
              <DsPageState v-if="!pluginCatalog.length" kind="empty" title="没有与此服务关联的命令" description="命令目录来自主进程 integration/commands；这里只列真实登记项。" />
              <ul v-else class="integr-rows">
                <li v-for="item in pluginCatalog" :key="item.command" class="integr-row integr-command" :data-integration-command="item.command">
                  <span class="mono integr-command-name">{{ item.command }}</span>
                  <DsBadge size="sm">{{ RISK_TEXT[item.risk] || item.risk }}</DsBadge>
                  <DsBadge v-if="item.credential" size="sm" tone="warning">触碰凭据</DsBadge>
                  <span class="integr-row-desc">{{ item.summary }}</span>
                </li>
              </ul>
            </section>
            <section class="integr-sec">
              <h3>本次窗口调用<span class="integr-zone-count">{{ serviceLogs.length }}</span></h3>
              <DsPageState v-if="!serviceLogs.length" kind="empty" title="还没有调用过这个服务的命令" description="启用、连通测试、保存凭据或读取状态后，这里会出现真实结果。" />
              <ul v-else class="integr-rows">
                <li v-for="(entry, index) in serviceLogs" :key="entry.at + '-' + index" class="integr-row integr-log-row" :data-integration-log="entry.command">
                  <span class="mono integr-log-time">{{ formatTime(entry.at) }}</span>
                  <DsBadge size="sm" :tone="entry.ok ? 'success' : 'danger'">{{ entry.ok ? "成功" : "失败" }}</DsBadge>
                  <span class="mono integr-command-name">{{ entry.command }}</span>
                  <span class="integr-row-desc">{{ entry.ok ? "" : entry.code + (entry.detail ? " · " + entry.detail : "") }}</span>
                </li>
              </ul>
            </section>
          </section>
        </div>
      </div>
    </div>

    <DsDialog :open="figmaOpenAsk" title="在系统浏览器打开 Figma" @close="figmaOpenAsk = false">
      <p>这会在系统默认浏览器里打开 <code class="mono">https://www.figma.com/</code>。Figma 没有本机客户端启动命令；当前版本也不会自动登录或读取 Figma 凭据。</p>
      <p class="integr-note">只在你确认后调用 browser/openExternal；打开结果由系统浏览器决定，应用不跟踪外部标签页。</p>
      <template #footer>
        <DsButton size="sm" variant="ghost" @click="figmaOpenAsk = false">取消</DsButton>
        <DsButton size="sm" variant="primary" data-design-open-confirm @click="openFigmaExternal">确认打开</DsButton>
      </template>
    </DsDialog>
  </div>
</template>
