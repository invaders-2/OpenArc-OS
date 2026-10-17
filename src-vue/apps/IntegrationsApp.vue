<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Activity, ListChecks, PlugZap, RefreshCw, ShieldCheck } from "lucide-vue-next";
import DsBadge from "../design-system/DsBadge.vue";
import DsButton from "../design-system/DsButton.vue";
import DsPageState from "../design-system/DsPageState.vue";
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

const tab = ref<"services" | "audit">("services");
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

onMounted(() => {
  void loadOverview();
});
</script>

<template>
  <div class="split integrations-app">
    <nav class="split-side" aria-label="第三方集成">
      <div class="split-section">集成</div>
      <button
        type="button"
        class="split-nav"
        :aria-current="tab === 'services' ? 'true' : undefined"
        data-integrations-tab="services"
        @click="tab = 'services'"
      >
        <PlugZap :size="16" /> <span class="split-nav-label">服务</span>
        <small class="integr-count">{{ plugins.length }}</small>
      </button>
      <button
        type="button"
        class="split-nav"
        :aria-current="tab === 'audit' ? 'true' : undefined"
        data-integrations-tab="audit"
        @click="tab = 'audit'"
      >
        <ListChecks :size="16" /> <span class="split-nav-label">审计</span>
        <small class="integr-count">{{ catalog.length }}</small>
      </button>

      <template v-if="tab === 'services'">
        <div class="split-section">全部服务</div>
        <button
          v-for="item in plugins"
          :key="item.id"
          type="button"
          class="split-nav integr-service"
          :data-integration-service="item.id"
          :data-integration-enabled="item.enabled ? 'true' : 'false'"
          :aria-current="selected === item.id && tab === 'services' ? 'true' : undefined"
          @click="selectPlugin(item.id)"
        >
          <span class="split-nav-label">{{ item.name }}</span>
          <span class="integr-service-state">
            <DsBadge size="sm" :tone="healthTone(healthById[item.id] ?? null)">{{ healthLabel(healthById[item.id] ?? null) }}</DsBadge>
          </span>
        </button>
        <p v-if="!plugins.length && !loading" class="planned-note">主进程没有登记任何集成插件。</p>
      </template>

      <p class="integr-side-note">插件默认全部关闭；启用不改依赖、不联网。连通测试只访问各服务登记的主机，不读取凭据。</p>
    </nav>

    <div class="split-main integr-main">
      <div class="pane-toolbar">
        <strong class="pane-title">{{ tab === "audit" ? "命令与审计" : "第三方集成" }}</strong>
        <div class="toolbar-spacer" />
        <DsBadge v-if="summary" size="sm">
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

      <div v-else-if="tab === 'audit'" class="integr-body" data-integrations-audit>
        <label class="integr-filter">
          <span>过滤命令</span>
          <input v-model="auditFilter" type="search" placeholder="命令 / 摘要 / 风险" aria-label="过滤集成命令" />
        </label>
        <p class="integr-note">
          命令目录由主进程冻结（risk / credential 是后端登记值），右侧是本次窗口内真实调用过的命令与结果。这里不做“调用成功”的推定。
        </p>
        <section class="integr-sec">
          <h3>命令目录</h3>
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
        <section class="integr-sec">
          <h3>本次窗口的调用记录</h3>
          <DsPageState v-if="!logEntries.length" kind="empty" title="还没有调用过集成命令" description="刷新、启用、测试连通性或保存凭据后，这里会出现真实结果。" />
          <ul v-else class="integr-rows">
            <li v-for="(entry, index) in logEntries" :key="entry.at + '-' + index" class="integr-row" :data-integration-log="entry.command">
              <span class="mono integr-log-time">{{ formatTime(entry.at) }}</span>
              <DsBadge size="sm" :tone="entry.ok ? 'success' : 'danger'">{{ entry.ok ? "成功" : "失败" }}</DsBadge>
              <span class="mono integr-command-name">{{ entry.command }}</span>
              <span class="integr-row-desc">{{ entry.ok ? "" : entry.code + (entry.detail ? " · " + entry.detail : "") }}</span>
            </li>
          </ul>
        </section>
      </div>

      <div v-else class="integr-body" data-integrations-services>
        <DsPageState v-if="!plugins.length && !loading" kind="empty" title="没有可管理的集成服务" description="主进程的插件登记表为空。" />
        <template v-else-if="current">
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
            <p class="integr-note">
              服务声明能力：{{ current.capabilities.length ? current.capabilities.join(" / ") : "无运行时能力依赖" }} ·
              必需依赖 {{ current.requiredDependencies.length }} 项、可选依赖 {{ current.optionalDependencies.length }} 项
            </p>
          </header>

          <p v-if="actionError" class="integr-error" role="alert" :data-integration-error="actionError.code">{{ failureText(actionError) }}<span v-if="actionError.detail" class="integr-detail"> · {{ detailText(actionError.detail) }}</span></p>
          <p v-if="actionNotice" class="integr-ok" role="status">{{ actionNotice }}</p>
          <p v-if="detailError" class="integr-error" role="alert">{{ failureText(detailError) }}</p>
          <p v-if="detailNote" class="integr-note">{{ detailNote }}</p>

          <section class="integr-sec">
            <h3>依赖与状态</h3>
            <DsPageState v-if="!currentHealth" kind="loading" title="正在读取依赖健康" />
            <template v-else>
              <ul class="integr-rows">
                <li v-for="dep in currentHealth.dependencies" :key="dep.id" class="integr-row" :data-integration-dep="dep.id">
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

          <section v-if="pluginCatalog.length" class="integr-sec">
            <h3>相关命令</h3>
            <ul class="integr-rows">
              <li v-for="item in pluginCatalog" :key="item.command" class="integr-row integr-command">
                <span class="mono integr-command-name">{{ item.command }}</span>
                <DsBadge size="sm">{{ RISK_TEXT[item.risk] || item.risk }}</DsBadge>
                <DsBadge v-if="item.credential" size="sm" tone="warning">触碰凭据</DsBadge>
                <span class="integr-row-desc">{{ item.summary }}</span>
              </li>
            </ul>
          </section>
        </template>
      </div>
    </div>
  </div>
</template>

