import { computed, ref } from "vue";
import { t } from "../../i18n";
import { integrationCall } from "./commandClient";
import { normalizeIntegrationPlugin, type IntegrationPlugin } from "./marketNormalization";

const INTEGRATION_ERROR_TEXT: Record<string, string> = {
  BRIDGE_ABSENT: "当前环境没有集成桥（只在 OpenArc 桌面应用里可用）",
  INTEGRATION_NOT_READY: "集成域还没有装配好",
  INTEGRATION_COMMAND_NOT_ALLOWED: "当前构建没有登记这条集成命令",
  INTEGRATION_INVALID_INPUT: "请求参数不合法，操作已停止",
  INTEGRATION_UNAVAILABLE: "集成依赖不可用",
  INTEGRATION_NOT_FOUND: "主进程没有登记这个集成插件",
  DXOS_ERR_INTERNAL: "集成服务内部出错",
};
export const integrationErrorText = (code: string): string => INTEGRATION_ERROR_TEXT[code] || t("操作失败（{code}）", { code });

type ExternalState = "install" | "connect" | "open";
export const EXTERNAL_PILL: Record<ExternalState, string> = { install: "安装插件", connect: "连接", open: "打开" };
const credentialPending = (plugin: IntegrationPlugin): boolean => plugin.dependencies.some((dep) => dep.kind === "credential" && dep.status !== "ok");
const externalStateOf = (plugin: IntegrationPlugin): ExternalState => {
  if (!plugin.enabled) return "install";
  if (plugin.status === "unavailable" || plugin.missingRequired.length > 0) return "connect";
  if (credentialPending(plugin)) return "connect";
  return "open";
};
const externalStateTextOf = (plugin: IntegrationPlugin): string => {
  if (!plugin.enabled) return t("未启用 · 默认关闭");
  if (plugin.status === "unavailable") return t("已启用 · 缺少依赖：{detail}", { detail: plugin.detail || t("依赖未就绪") });
  if (credentialPending(plugin)) return t("已启用 · 凭据未配置或未验证");
  if (plugin.status === "degraded") return t("已启用 · {detail}", { detail: plugin.detail || t("部分可选依赖不可用") });
  return t("已启用 · 依赖就绪");
};
export const monogram = (name: string): string => (name || "?").trim().slice(0, 1).toUpperCase();

export function useIntegrations({ matchesQuery, activateApp }: { matchesQuery: (...values: string[]) => boolean; activateApp: (id: string) => void }) {
  const integrationPlugins = ref<IntegrationPlugin[]>([]);
  const integrationLoaded = ref(false);
  const integrationBusy = ref<string | null>(null);
  const integrationError = ref<{ code: string; detail: string } | null>(null);
  const externalError = ref<{ code: string; detail: string } | null>(null);

  async function loadIntegrations() {
    integrationBusy.value = "list";
    const res = await integrationCall("integration/plugins/health", {});
    integrationBusy.value = null;
    integrationLoaded.value = true;
    if (!res.ok) {
      integrationError.value = { code: res.error, detail: res.detail };
      integrationPlugins.value = [];
      return;
    }
    const box = res.value && typeof res.value === "object" ? (res.value as Record<string, unknown>) : {};
    const items = Array.isArray(box.items) ? box.items : [];
    integrationPlugins.value = items.map(normalizeIntegrationPlugin).filter(Boolean) as IntegrationPlugin[];
    integrationError.value = null;
  }
  async function externalAction(plugin: IntegrationPlugin) {
    externalError.value = null;
    if (externalStateOf(plugin) === "install") {
      integrationBusy.value = "enable:" + plugin.id;
      const res = await integrationCall("integration/plugins/enable", { id: plugin.id });
      integrationBusy.value = null;
      if (!res.ok) { externalError.value = { code: res.error, detail: res.detail }; return; }
      await loadIntegrations();
      return;
    }
    activateApp("integrations");
  }
  const externalPlugins = computed(() => integrationPlugins.value.filter((plugin) => matchesQuery(plugin.name, plugin.description)));
  const discoverExternal = computed(() => externalPlugins.value.slice(0, 4));
  const enabledIntegrationCount = computed(() => integrationPlugins.value.filter((plugin) => plugin.enabled).length);
  return {
    integrationPlugins, integrationLoaded, integrationBusy, integrationError, externalError,
    externalPlugins, discoverExternal, enabledIntegrationCount,
    loadIntegrations, externalAction, externalStateOf, externalStateTextOf,
  };
}
