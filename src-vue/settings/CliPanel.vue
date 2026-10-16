<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import DsButton from "../design-system/DsButton.vue";
import {
  cliErrorText,
  cliInstallHint,
  cliInstalledText,
  cliLoggedInText,
  cliStatusView,
  formatCliValue,
  normalizeCliList,
  normalizeCliModels,
  type CliTool,
} from "./cliPanelLogic";

/**
 * 系统设置 › 模型与服务商 › CLI。
 *
 * 通道 cli:command（契约冻结见 cliPanelLogic.ts 顶部）。每个工具一张卡：
 * 名称 / 是否安装 / 版本 / 缺失原因 / 能力标签；展开后是 状态 · 模型列表 · 额度 · 登录 · 登出。
 * 未安装一律给「怎么装」的执行提示；需要浏览器授权的把链接或口令如实展示，绝不假装已登录。
 * 界面不出现原始错误码（只留在 data-cli-error-code）。
 */
const bridge = () => (window as any).openarc?.cli;
const hasBridge = ref(!!bridge());

async function cmd(command: string, payload: Record<string, unknown> = {}): Promise<any> {
  const b = bridge();
  if (!b) return { ok: false, error: "NO_BRIDGE" };
  try {
    return await b.command({ command, payload });
  } catch {
    return { ok: false, error: "DXOS_ERR_INTERNAL" };
  }
}

const tools = ref<CliTool[]>([]);
const loading = ref(false);
const loadErrorCode = ref<string | null>(null);
const loadErrorText = ref("");

const expanded = ref<string | null>(null);
const statusMap = ref<Record<string, any>>({});
const modelsMap = ref<Record<string, any>>({});
const creditMap = ref<Record<string, any>>({});
const loginMap = ref<Record<string, any>>({});
const toolError = ref<Record<string, { code: string; text: string } | null>>({});
const busy = ref<string | null>(null);

const isBusy = (id: string, command: string) => busy.value === id + ":" + command;

async function run(command: string, toolId: string, apply: (reply: any) => void) {
  busy.value = toolId + ":" + command;
  const reply = await cmd(command, { tool: toolId });
  busy.value = null;
  if (!reply || reply.ok !== true) {
    const code = String((reply && reply.error) || "MALFORMED_REPLY");
    toolError.value = { ...toolError.value, [toolId]: { code, text: cliErrorText(code) } };
    return null;
  }
  toolError.value = { ...toolError.value, [toolId]: null };
  apply(reply);
  return reply;
}

async function load() {
  hasBridge.value = !!bridge();
  if (!hasBridge.value) return;
  loading.value = true;
  loadErrorCode.value = null;
  const reply = await cmd("cli/list");
  loading.value = false;
  const view = normalizeCliList(reply);
  tools.value = view.tools;
  if (view.problem) {
    loadErrorCode.value = String((reply && reply.error) || "MALFORMED_REPLY");
    loadErrorText.value = view.problem;
  }
  if (tools.value.length && expanded.value && !tools.value.some((tool) => tool.id === expanded.value)) expanded.value = null;
}

async function toggle(tool: CliTool) {
  if (expanded.value === tool.id) {
    expanded.value = null;
    return;
  }
  expanded.value = tool.id;
  if (!statusMap.value[tool.id]) await refreshStatus(tool.id);
}

const refreshStatus = (id: string) =>
  run("cli/status", id, (reply) => {
    statusMap.value = { ...statusMap.value, [id]: reply };
  });
const loadModels = (id: string) =>
  run("cli/models", id, (reply) => {
    modelsMap.value = { ...modelsMap.value, [id]: reply };
  });
const loadCredit = (id: string) =>
  run("cli/credit", id, (reply) => {
    creditMap.value = { ...creditMap.value, [id]: reply };
  });
const checkLogin = (id: string) =>
  run("cli/login/status", id, (reply) => {
    loginMap.value = { ...loginMap.value, [id]: { ...(loginMap.value[id] || {}), status: reply.status, statusDetail: reply.detail ?? null } };
  });
async function startLogin(id: string) {
  const reply = await run("cli/login/start", id, (r) => {
    loginMap.value = {
      ...loginMap.value,
      [id]: { ...(loginMap.value[id] || {}), started: true, url: r.url ?? null, code: r.code ?? null, startDetail: r.detail ?? null },
    };
  });
  // 发起成功不等于已登录：立刻向 cli/login/status 要真实状态。
  if (reply) await checkLogin(id);
}
async function logout(id: string) {
  const reply = await run("cli/logout", id, () => undefined);
  if (reply) {
    loginMap.value = { ...loginMap.value, [id]: { ...(loginMap.value[id] || {}), status: "idle", statusDetail: "已登出。" } };
    await refreshStatus(id);
  }
}

const loginViewFor = (id: string) => {
  const entry = loginMap.value[id];
  return entry && entry.status ? cliStatusView(entry.status) : null;
};
const statusDetailFor = (id: string) => {
  const reply = statusMap.value[id];
  if (!reply) return null;
  const value = reply.value && typeof reply.value === "object" ? reply.value : reply;
  return {
    installed: cliInstalledText(value.installed),
    version: value.version == null || value.version === "" ? "未返回" : String(value.version),
    loggedIn: cliLoggedInText(value.loggedIn),
    detail: value.detail == null || value.detail === "" ? null : String(value.detail),
    runtime: value.runtime && typeof value.runtime === "object" ? value.runtime : null,
  };
};
const modelsFor = (id: string) => normalizeCliModels(modelsMap.value[id]);
const creditFor = (id: string) => {
  const reply = creditMap.value[id];
  if (!reply) return "未返回";
  const value = reply.value && typeof reply.value === "object" ? reply.value : reply;
  return formatCliValue(value.credit);
};
const runtimeRows = (runtime: any) =>
  runtime
    ? [
        ["命令", runtime.command],
        ["模式", runtime.mode],
        ["Home", runtime.home],
        ["标签", runtime.label],
        ["服务商", runtime.provider],
      ].filter((row) => row[1] != null && row[1] !== "")
    : [];
const busyHint = computed(() => (busy.value ? "调用中…" : ""));

onMounted(load);
</script>

<template>
  <div class="cli" data-cli-panel>
    <p v-if="!hasBridge" class="cli-msg cli-msg-bad" data-cli-no-bridge>{{ cliErrorText("NO_BRIDGE") }}</p>
    <template v-else>
      <div class="cli-bar">
        <span class="set-cap">列出本机命令行工具的安装状态、登录、模型与额度。CLI 由后端的 cli:command 通道提供。</span>
        <span class="toolbar-spacer" />
        <small v-if="busyHint" class="set-cap">{{ busyHint }}</small>
        <DsButton variant="ghost" size="sm" data-cli-reload :disabled="loading" @click="load">{{ loading ? "读取中…" : "重新读取" }}</DsButton>
      </div>

      <p v-if="loadErrorCode" class="cli-msg cli-msg-bad" data-cli-error :data-cli-error-code="loadErrorCode">{{ loadErrorText }}</p>

      <div class="cli-list" data-cli-list>
        <article
          v-for="tool in tools"
          :key="tool.id"
          class="cli-card"
          :data-cli-tool="tool.id"
          :data-cli-installed="String(tool.installed)"
          :data-cli-login-required="String(tool.loginRequired)"
        >
          <header class="cli-head" :data-cli-expand="tool.id" @click="toggle(tool)">
            <b>{{ tool.name || tool.id }}</b>
            <span class="cli-badge" :data-tone="tool.installed ? 'ok' : 'off'" :data-cli-state="tool.installed ? 'installed' : 'missing'">{{ cliInstalledText(tool.installed) }}</span>
            <small v-if="tool.version" class="mono" data-cli-version>{{ tool.version }}</small>
            <span class="toolbar-spacer" />
            <span class="set-cap">{{ expanded === tool.id ? "收起" : "展开" }}</span>
          </header>

          <p v-if="tool.detail" class="set-cap" data-cli-detail>{{ tool.detail }}</p>
          <p v-if="!tool.installed" class="cli-hint" data-cli-install-hint>{{ cliInstallHint(tool) }}</p>

          <div v-if="tool.capabilities.length" class="cli-caps" data-cli-capabilities>
            <span v-for="cap in tool.capabilities" :key="cap" class="cli-cap">{{ cap }}</span>
          </div>

          <p v-if="toolError[tool.id]" class="cli-msg cli-msg-bad" data-cli-tool-error :data-cli-error-code="toolError[tool.id]!.code">{{ toolError[tool.id]!.text }}</p>

          <div v-if="expanded === tool.id" class="cli-body" data-cli-body>
            <div class="cli-actions">
              <DsButton variant="secondary" size="sm" data-cli-action="status" :disabled="isBusy(tool.id, 'cli/status')" @click="refreshStatus(tool.id)">状态</DsButton>
              <DsButton variant="secondary" size="sm" data-cli-action="models" :disabled="isBusy(tool.id, 'cli/models')" @click="loadModels(tool.id)">模型列表</DsButton>
              <DsButton variant="secondary" size="sm" data-cli-action="credit" :disabled="isBusy(tool.id, 'cli/credit')" @click="loadCredit(tool.id)">额度</DsButton>
              <DsButton variant="primary" size="sm" data-cli-action="login-start" :disabled="isBusy(tool.id, 'cli/login/start')" @click="startLogin(tool.id)">发起登录</DsButton>
              <DsButton variant="secondary" size="sm" data-cli-action="login-status" :disabled="isBusy(tool.id, 'cli/login/status')" @click="checkLogin(tool.id)">检查登录状态</DsButton>
              <DsButton variant="ghost" size="sm" data-cli-action="logout" :disabled="isBusy(tool.id, 'cli/logout')" @click="logout(tool.id)">登出</DsButton>
            </div>

            <section v-if="statusDetailFor(tool.id)" class="cli-block" data-cli-status :data-cli-logged-in="String(statusMap[tool.id]?.value?.loggedIn ?? statusMap[tool.id]?.loggedIn ?? '')">
              <b>状态</b>
              <div class="cli-rows">
                <span>安装：{{ statusDetailFor(tool.id)!.installed }}</span>
                <span>版本：{{ statusDetailFor(tool.id)!.version }}</span>
                <span>登录：{{ statusDetailFor(tool.id)!.loggedIn }}</span>
              </div>
              <p v-if="statusDetailFor(tool.id)!.detail" class="set-cap" data-cli-status-detail>{{ statusDetailFor(tool.id)!.detail }}</p>
              <div v-if="runtimeRows(statusDetailFor(tool.id)!.runtime).length" class="cli-rows" data-cli-runtime>
                <span v-for="row in runtimeRows(statusDetailFor(tool.id)!.runtime)" :key="String(row[0])">{{ row[0] }}：{{ row[1] }}</span>
              </div>
            </section>

            <section v-if="loginMap[tool.id]" class="cli-block" data-cli-login :data-cli-status-state="String(loginMap[tool.id].status || 'unknown')">
              <b>登录</b>
              <p class="set-cap" data-cli-login-state>{{ loginViewFor(tool.id) ? loginViewFor(tool.id)!.label + "：" + loginViewFor(tool.id)!.detail : "还没拿到登录状态，点「检查登录状态」。" }}</p>
              <p v-if="loginMap[tool.id].url" class="cli-url" data-cli-login-url>授权链接：<a :href="String(loginMap[tool.id].url)" target="_blank" rel="noreferrer">{{ loginMap[tool.id].url }}</a></p>
              <p v-else-if="loginMap[tool.id].code == null && loginMap[tool.id].started" class="set-cap" data-cli-login-no-url>后端没有返回授权链接，请按下面的说明或口令完成授权。</p>
              <p v-if="loginMap[tool.id].code != null && loginMap[tool.id].code !== ''" class="cli-url" data-cli-login-code>授权口令：<code>{{ loginMap[tool.id].code }}</code></p>
              <p v-if="loginMap[tool.id].startDetail" class="set-cap" data-cli-login-detail>{{ loginMap[tool.id].startDetail }}</p>
              <p v-if="loginMap[tool.id].statusDetail" class="set-cap" data-cli-login-status-detail>{{ loginMap[tool.id].statusDetail }}</p>
            </section>

            <section v-if="modelsMap[tool.id]" class="cli-block" data-cli-models>
              <b>模型列表</b>
              <p v-if="modelsFor(tool.id).cached !== null" class="set-cap">{{ modelsFor(tool.id).cached ? "来自缓存" : "本次实时读取" }}</p>
              <ul v-if="modelsFor(tool.id).models.length" class="cli-models">
                <li v-for="model in modelsFor(tool.id).models" :key="model.id" :data-cli-model="model.id"><code>{{ model.id }}</code><span>{{ model.name }}</span></li>
              </ul>
              <p v-else class="set-cap" data-cli-models-empty>这个工具没有返回模型，或它本身不需要模型列表。</p>
            </section>

            <section v-if="creditMap[tool.id]" class="cli-block" data-cli-credit>
              <b>额度</b>
              <p class="set-cap" data-cli-credit-value>{{ creditFor(tool.id) }}</p>
            </section>
          </div>
        </article>
      </div>

      <p v-if="!tools.length && !loading" class="set-cap" data-cli-empty>后端没有返回任何 CLI 工具。</p>
    </template>
  </div>
</template>

<style scoped>
.cli { display: flex; flex-direction: column; gap: 10px; }
.cli-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cli-list { display: flex; flex-direction: column; gap: 8px; }
.cli-card { display: flex; flex-direction: column; gap: 6px; padding: 10px; border-radius: var(--radius-md); background: rgb(var(--text-rgb) / 0.035); }
.cli-head { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.cli-head b { font-size: var(--fs-secondary); font-weight: var(--fw-medium); }
.cli-badge { padding: 1px 7px; border-radius: var(--radius-pill); font-size: var(--fs-micro); border: 1px solid var(--line); color: var(--muted); }
.cli-badge[data-tone="ok"] { color: var(--accent); border-color: var(--accent); }
.cli-badge[data-tone="off"] { color: var(--failed); border-color: var(--failed); }
.cli-hint { font-size: var(--fs-caption); color: var(--text); padding: 6px 8px; border-radius: var(--radius-sm); background: var(--sunken); }
.cli-msg { font-size: var(--fs-caption); color: var(--text); }
.cli-msg-bad { color: var(--failed); }
.cli-caps { display: flex; flex-wrap: wrap; gap: 4px; }
.cli-cap { padding: 1px 7px; border-radius: var(--radius-pill); border: 1px solid var(--line); font-size: var(--fs-micro); color: var(--muted); }
.cli-body { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--line); padding-top: 8px; }
.cli-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.cli-block { display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-caption); }
.cli-block b { font-weight: var(--fw-medium); font-size: var(--fs-caption); }
.cli-rows { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--muted); }
.cli-models { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; max-height: 220px; overflow: auto; }
.cli-models li { display: flex; gap: 8px; align-items: baseline; }
.cli-models li span { color: var(--muted); font-size: var(--fs-micro); }
.cli-url { word-break: break-all; }
.cli-url code { font-family: var(--font-mono); }
</style>
