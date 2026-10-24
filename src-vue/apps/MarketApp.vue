<script setup lang="ts">
import { t } from "../i18n";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import {
  ArrowDownCircle,
  ChevronRight,
  Code,
  Compass,
  Download,
  LayoutGrid,
  Package,
  Palette,
  Pin,
  PinOff,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Users,
  Zap,
} from "lucide-vue-next";
import { APPS, APP_CATEGORY, appById, iconUrl, type AppEntry } from "../apps";
import { useShellStore } from "../stores/shell";
import DsBadge from "../design-system/DsBadge.vue";
import DsButton from "../design-system/DsButton.vue";
import DsDialog from "../design-system/DsDialog.vue";
import DsPageState from "../design-system/DsPageState.vue";
import CanvasUpdatePanel from "./CanvasUpdatePanel.vue";
import { UPDATE_STATUS_COMMAND, appCardUpdate, formatTimestamp, normalizeAppUpdateStatus } from "./appUpdateLogic";
import type { AppUpdateStatus } from "./appUpdateLogic";

/**
 * 应用市场：发现 / 分类 / 外部应用 / 更新 / 加载状态，一个窗口内切换视图。
 *
 * 发现页 hero 的每一屏都来自本机真实状态（可更新数量、集成插件启用数、第三方安装数）；
 * 读不到就写读不到，没有内容就写没有，不编造推荐文案与海报。
 *
 * 外部应用分两类真值：
 *   · 集成服务 = integration/plugins/health 的 enabled / status / dependencies 投影，
 *     未启用 → 安装插件（调用真实 enable），缺依赖或缺凭据 → 连接，依赖就绪 → 打开；
 *     后两者都跳到「第三方集成」应用，那里才是配置凭据的地方；
 *   · 第三方应用两段路由：<dxos>/market/third-party.json（本地目录）优先，其次 resources/market/third-party.json；
 *     在线目录只在主进程侧读取白名单 HTTPS 源。
 *
 * 三处离线真值：
 *   · OpenAI 兼容协议只能转译为既有 agent 入口名（chat / apply），不接受任意工具名；
 *   · 生成参数不在本页面暴露，避免契约漂移；
 *   · 任何安装 / 回滚都走二次确认，失败原样显示后端错误码。
 */
const shell = useShellStore();

type View = "apps" | "external" | "updates" | "health";
const view = ref<View>("apps");
const cat = ref("全部");
const query = ref("");
const detail = ref<string | null>(null);
const autoInstall = ref(false);

/* ── 应用目录元数据 ─────────────────────────────────────────────────────── */
const DESC: Record<string, string> = {
  home: "浏览与打开全部应用",
  files: "管理桌面与文件夹里的文件",
  trash: "恢复或彻底删除已移除的文件",
  settings: "外观、账户、模型与隐私设置",
  dev: "运行环境、窗口状态与运行日志",
  declare: "为 AI 生成图片写入标准来源声明",
  canvas: "无限画布：图像、视频与工作流",
  photos: "汇总访达里的全部图片",
  music: "播放访达里的音频文件",
  notes: "Markdown / 纯文本文稿，自动保存",
  video: "拼接、裁剪视频并用本机 FFmpeg 导出",
  chat: "和助理对话、交代任务",
  automation: "按时间自动让助理完成任务",
  calendar: "月视图与本机日程",
  weather: "当前天气与 7 日预报（Open-Meteo）",
  browser: "受控的网页浏览与下载",
  projects: "项目与成员协作",
  organization: "成员、角色与权限治理",
  "resource-library": "可被助理引用的资源",
  skills: "技能的安装与管理",
  "mcp-center": "连接外部工具与数据源（MCP）",
  protocols: "模型与供应商协议",
  integrations: "领星、紫鸟、钉钉、夸克、天气与黄历等可选服务的开关与凭据",
};
const CATEGORIES = ["创作", "效率", "开发", "系统", "团队与资源"];
const CAT_ICON: Record<string, unknown> = { 创作: Palette, 效率: Zap, 开发: Code, 系统: LayoutGrid, "团队与资源": Users };
const descOf = (a: AppEntry): string => DESC[a.id] || "";
const catOf = (a: AppEntry): string => APP_CATEGORY[a.id] || "其他";

const normalizedQuery = computed(() => query.value.trim().toLowerCase());
const matchesQuery = (...values: string[]): boolean => {
  const q = normalizedQuery.value;
  return !q || values.some((value) => String(value || "").toLowerCase().indexOf(q) >= 0);
};

/* ── 应用更新状态 ───────────────────────────────────────────────────────── */
const statuses = reactive<Record<string, AppUpdateStatus | null>>({});
const statusBusy = ref(false);
const statusLoaded = ref(false);
const card = (a: AppEntry) => appCardUpdate(statuses[a.id] ?? null);
const upgradable = computed(() => APPS.filter((a) => a.id !== "market" && card(a).canUpgrade));
const upToDate = computed(() => APPS.filter((a) => a.id !== "market" && !card(a).canUpgrade));
const updatableList = computed(() => upgradable.value.filter((a) => matchesQuery(a.name, descOf(a))));
const upToDateList = computed(() => upToDate.value.filter((a) => matchesQuery(a.name, descOf(a))));
/** 应用页签 = 注册表 ∪ catalog.apps，按 id 去重：注册表给图标 / 安装更新状态，catalog 给详情 / 发布时间 / 精选 / 提示词。 */
const APP_CATEGORY_ID: Record<string, string> = { 创作: "creative", 效率: "efficiency", 团队与资源: "team-resource", 系统: "system", 开发: "dev" };
const apps = computed(() => {
  const rows: Array<AppEntry & { catalog: CatalogApp | null }> = [];
  const seen = new Set<string>();
  for (const entry of APPS) {
    if (entry.id === "market") continue;
    rows.push({ ...entry, catalog: marketCatalogApps.value.find((item) => item.id === entry.id) || null });
    seen.add(entry.id);
  }
  // catalog 里有、注册表里没有的应用也列出来（详情里有「本地市场 App」说明）
  for (const item of marketCatalogApps.value) {
    if (seen.has(item.id)) continue;
    rows.push({ id: item.id, name: item.name, icon: "apps", version: item.version, catalog: item });
    seen.add(item.id);
  }
  const categoryId = APP_CATEGORY_ID[cat.value] || "";
  return rows
    .filter((row) => cat.value === "全部" || catOf(row) === cat.value || (!!categoryId && !!row.catalog && (row.catalog.categoryIds || []).includes(categoryId)))
    .filter((row) => matchesQuery(row.name, descOf(row), row.catalog ? row.catalog.summary : ""));
});
const lastCheckedText = computed(() => {
  const stamps = Object.values(statuses)
    .filter((entry): entry is AppUpdateStatus => !!entry && entry.checkedAt != null)
    .map((entry) => Number(entry.checkedAt))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!stamps.length) return t("还没有检查过更新");
  return t("上次检查 {time}", { time: formatTimestamp(Math.max(...stamps)) });
});

/* ── 市场命令桥（market:command 唯一通道） ─────────────────────────────── */
interface MarketResult {
  ok: boolean;
  value?: unknown;
  error: string;
  detail: string;
}
async function marketCall(command: string, payload: Record<string, unknown> = {}): Promise<MarketResult> {
  const api = window.openarc?.marketUpdate || window.openarc?.market;
  if (!api || typeof api.command !== "function") {
    return { ok: false, error: "MARKET_NOT_READY", detail: "当前环境没有市场桥（只在 OpenArc 桌面应用里可用）" };
  }
  let raw: unknown;
  try {
    raw = await api.command({ command, payload });
  } catch (error) {
    const message = error && typeof error === "object" ? String((error as { message?: unknown }).message || error) : String(error);
    return { ok: false, error: "DXOS_ERR_INTERNAL", detail: message };
  }
  const box = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (box.ok === true) return { ok: true, value: box.value, error: "", detail: "" };
  return { ok: false, value: box.value, error: typeof box.error === "string" ? box.error : "DXOS_ERR_INTERNAL", detail: typeof box.detail === "string" ? box.detail : "" };
}

async function loadStatuses() {
  statusBusy.value = true;
  const targets = APPS.filter((a) => a.id !== "market");
  await Promise.all(
    targets.map(async (a) => {
      try {
        const raw = await marketCall(UPDATE_STATUS_COMMAND, { appId: a.id });
        statuses[a.id] = raw.ok ? normalizeAppUpdateStatus(raw.value) : null;
      } catch {
        statuses[a.id] = null;
      }
    }),
  );
  statusBusy.value = false;
  statusLoaded.value = true;
}

const statusCurrent = (id: string): string => {
  const status = statuses[id];
  if (!status) return "none";
  return status.current ? status.current.version : "builtin:" + status.builtinVersion;
};
const statusLatest = (id: string): string => {
  const status = statuses[id];
  return status && status.latest ? status.latest.version : "";
};
const statusChecked = (id: string): string => {
  const status = statuses[id];
  return status && status.checkedAt != null ? String(status.checkedAt) : "";
};

/* ── 集成服务（外部应用） ───────────────────────────────────────────────── */
type IntegrationDep = { id: string; kind: string; label: string; required: boolean; status: string; detail: string };
type IntegrationPlugin = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  status: string;
  dependencies: IntegrationDep[];
  missingRequired: string[];
  detail: string;
};
const INTEGRATION_ERROR_TEXT: Record<string, string> = {
  BRIDGE_ABSENT: "当前环境没有集成桥（只在 OpenArc 桌面应用里可用）",
  INTEGRATION_NOT_READY: "集成域还没有装配好",
  INTEGRATION_COMMAND_NOT_ALLOWED: "当前构建没有登记这条集成命令",
  INTEGRATION_INVALID_INPUT: "请求参数不合法，操作已停止",
  INTEGRATION_UNAVAILABLE: "集成依赖不可用",
  INTEGRATION_NOT_FOUND: "主进程没有登记这个集成插件",
  DXOS_ERR_INTERNAL: "集成服务内部出错",
};
function integrationErrorText(code: string): string {
  return INTEGRATION_ERROR_TEXT[code] || t("操作失败（{code}）", { code });
}
async function integrationCall(command: string, payload: Record<string, unknown> = {}): Promise<MarketResult> {
  const api = window.openarc?.integration;
  if (!api || typeof api.command !== "function") {
    return { ok: false, error: "BRIDGE_ABSENT", detail: "" };
  }
  let raw: unknown;
  try {
    raw = await api.command({ command, payload });
  } catch (error) {
    const message = error && typeof error === "object" ? String((error as { message?: unknown }).message || error) : String(error);
    return { ok: false, error: "DXOS_ERR_INTERNAL", detail: message };
  }
  const box = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (box.ok === true) return { ok: true, value: box.value, error: "", detail: "" };
  return { ok: false, value: box.value, error: typeof box.error === "string" ? box.error : "DXOS_ERR_INTERNAL", detail: typeof box.detail === "string" ? box.detail : "" };
}

const integrationPlugins = ref<IntegrationPlugin[]>([]);
const integrationLoaded = ref(false);
const integrationBusy = ref<string | null>(null);
const integrationError = ref<{ code: string; detail: string } | null>(null);
const externalError = ref<{ code: string; detail: string } | null>(null);

function normalizeIntegrationPlugin(raw: any): IntegrationPlugin | null {
  if (!raw || typeof raw !== "object") return null;
  const id = asText(raw.id);
  if (!id) return null;
  const deps = Array.isArray(raw.dependencies) ? raw.dependencies : [];
  return {
    id,
    name: asText(raw.name) || id,
    description: asText(raw.description),
    enabled: raw.enabled === true,
    status: asText(raw.status) || "disabled",
    dependencies: deps
      .filter((entry: any) => entry && typeof entry === "object")
      .map((entry: any) => ({
        id: asText(entry.id),
        kind: asText(entry.kind),
        label: asText(entry.label),
        required: entry.required === true,
        status: asText(entry.status) || "unknown",
        detail: asText(entry.detail),
      })),
    missingRequired: (Array.isArray(raw.missingRequired) ? raw.missingRequired : []).map(asText).filter(Boolean),
    detail: asText(raw.detail),
  };
}
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

type ExternalState = "install" | "connect" | "open";
const EXTERNAL_PILL: Record<ExternalState, string> = { install: "安装插件", connect: "连接", open: "打开" };
function credentialPending(plugin: IntegrationPlugin): boolean {
  return plugin.dependencies.some((dep) => dep.kind === "credential" && dep.status !== "ok");
}
function externalStateOf(plugin: IntegrationPlugin): ExternalState {
  if (!plugin.enabled) return "install";
  if (plugin.status === "unavailable" || plugin.missingRequired.length > 0) return "connect";
  if (credentialPending(plugin)) return "connect";
  return "open";
}
function externalStateTextOf(plugin: IntegrationPlugin): string {
  if (!plugin.enabled) return t("未启用 · 默认关闭");
  if (plugin.status === "unavailable") return t("已启用 · 缺少依赖：{detail}", { detail: plugin.detail || t("依赖未就绪") });
  if (credentialPending(plugin)) return t("已启用 · 凭据未配置或未验证");
  if (plugin.status === "degraded") return t("已启用 · {detail}", { detail: plugin.detail || t("部分可选依赖不可用") });
  return t("已启用 · 依赖就绪");
}
const externalPlugins = computed(() => integrationPlugins.value.filter((plugin) => matchesQuery(plugin.name, plugin.description)));
const discoverExternal = computed(() => externalPlugins.value.slice(0, 4));
const enabledIntegrationCount = computed(() => integrationPlugins.value.filter((plugin) => plugin.enabled).length);
const monogram = (name: string): string => (name || "?").trim().slice(0, 1).toUpperCase();

async function externalAction(plugin: IntegrationPlugin) {
  externalError.value = null;
  if (externalStateOf(plugin) === "install") {
    integrationBusy.value = "enable:" + plugin.id;
    const res = await integrationCall("integration/plugins/enable", { id: plugin.id });
    integrationBusy.value = null;
    if (!res.ok) {
      externalError.value = { code: res.error, detail: res.detail };
      return;
    }
    await loadIntegrations();
    return;
  }
  shell.activateApp("integrations");
}

/* ── hero 轮播（只读真实计数；减少动态时停用） ─────────────────────────── */
type HeroSlide = { key: string; eyebrow: string; title: string; note: string; target: View };
const heroIndex = ref(0);
const systemMotionReduced = ref(false);
let motionQuery: MediaQueryList | null = null;
let heroTimer: ReturnType<typeof setInterval> | null = null;
const motionOff = computed(() => shell.reduced || systemMotionReduced.value);

const heroSlides = computed<HeroSlide[]>(() => {
  if (!statusLoaded.value) {
    return [{ key: "loading", eyebrow: t("应用市场"), title: t("正在读取本机应用状态…"), note: t("只读本机记录，不联网。"), target: "apps" }];
  }
  const slides: HeroSlide[] = [
    upgradable.value.length
      ? {
          key: "updates",
          eyebrow: t("应用更新"),
          title: t("有 {n} 个应用可以更新", { n: upgradable.value.length }),
          note: lastCheckedText.value,
          target: "updates",
        }
      : {
          key: "updates",
          eyebrow: t("应用更新"),
          title: t("所有应用都是最新版本"),
          note: lastCheckedText.value,
          target: "updates",
        },
  ];
  if (integrationError.value) {
    slides.push({
      key: "external",
      eyebrow: t("外部应用"),
      title: t("读不到集成服务状态"),
      note: integrationErrorText(integrationError.value.code),
      target: "external",
    });
  } else {
    slides.push({
      key: "external",
      eyebrow: t("外部应用"),
      title: enabledIntegrationCount.value
        ? t("已启用 {n} 个集成服务", { n: enabledIntegrationCount.value })
        : t("还没有启用集成服务"),
      note: integrationLoaded.value ? t("共登记 {n} 个集成插件", { n: integrationPlugins.value.length }) : t("正在读取集成插件…"),
      target: "external",
    });
  }
  if (thirdLoaded.value) {
    slides.push({
      key: "thirdparty",
      eyebrow: t("第三方应用"),
      title: installedApps.value.length
        ? t("已安装 {n} 个第三方应用", { n: installedApps.value.length })
        : t("还没有安装第三方应用"),
      note: localApps.value.length + onlineApps.value.length
        ? t("目录里有 {n} 个可安装条目", { n: localApps.value.length + onlineApps.value.length })
        : t("当前没有可安装的目录条目"),
      target: "external",
    });
  }
  return slides;
});
const heroSlide = computed<HeroSlide | null>(() => {
  const list = heroSlides.value;
  if (!list.length) return null;
  return list[Math.min(heroIndex.value, list.length - 1)];
});
const HERO_MARK_APP: Record<string, string> = { loading: "market", updates: "canvas", external: "integrations", thirdparty: "market" };
const heroMarkIcon = computed(() => {
  const id = HERO_MARK_APP[heroSlide.value?.key || "updates"] || "market";
  return iconUrl(appById(id)?.icon || "app-store");
});
function stopHeroTimer() {
  if (heroTimer) {
    clearInterval(heroTimer);
    heroTimer = null;
  }
}
function startHeroTimer() {
  stopHeroTimer();
  if (motionOff.value || heroSlides.value.length < 2) return;
  heroTimer = setInterval(() => {
    heroIndex.value = (heroIndex.value + 1) % heroSlides.value.length;
  }, 4200);
}
function onMotionChange(event: MediaQueryListEvent) {
  systemMotionReduced.value = event.matches;
}
function goHero(slide: HeroSlide | null) {
  if (!slide) return;
  cat.value = "全部";
  switchView(slide.target);
}

/* ── 第三方应用 ─────────────────────────────────────────────────────────── */
type ThirdApp = {
  id: string;
  name: string;
  version: string;
  packageUrl: string | null;
  packageFile: string | null;
  sha256: string;
  size: number | null;
  minSystemVersion: string | null;
  maxSystemVersion: string | null;
  entry: string | null;
  description: string | null;
  author: string | null;
  homepage: string | null;
  source: "local" | "online";
};
type ThirdRejected = { id: string | null; reason: string };
type ThirdInstalled = {
  id: string;
  name: string | null;
  version: string | null;
  status: string;
  source: string | null;
  installedAt: number | null;
  currentVersion: string | null;
  effectiveSource: string;
};
type ThirdCatalog = { present: boolean; ok: boolean; apps: ThirdApp[]; rejected: ThirdRejected[]; error: string | null; detail: string | null };
type ThirdOnline = { configured: boolean; ok: boolean; apps: ThirdApp[]; rejected: ThirdRejected[]; error: string | null; detail: string | null };
type ThirdList = { systemVersion: string; local: ThirdCatalog; online: ThirdOnline; installed: ThirdInstalled[] };
type ThirdHealth = {
  ok: boolean;
  effectiveSource: string;
  installedLoadable: boolean;
  loader: string | null;
  loadUrl: string | null;
  fallbackReason: string | null;
  installed: { version: string | null; digest: string | null; kind: string | null; entry: string | null; reason: string | null; detail: string | null } | null;
  error: string | null;
  detail: string | null;
};

const THIRD_ERROR_TEXT: Record<string, string> = {
  MARKET_THIRDPARTY_NOT_READY: "第三方市场服务未装配（不可用）",
  MARKET_THIRDPARTY_COMMAND_NOT_ALLOWED: "当前构建没有登记这条第三方市场命令",
  MARKET_THIRDPARTY_INVALID_INPUT: "请求参数不合法，操作已停止",
  MARKET_THIRDPARTY_UNAUTHENTICATED: "当前会话未登录",
  MARKET_THIRDPARTY_CATALOG_MISSING: "没有第三方应用目录",
  MARKET_THIRDPARTY_CATALOG_INVALID: "第三方应用目录格式不合法",
  MARKET_THIRDPARTY_NOT_FOUND: "目录里没有这个第三方应用",
  MARKET_THIRDPARTY_RESERVED_APP: "第三方应用不能使用内置应用 id",
  MARKET_THIRDPARTY_NOT_COMPATIBLE: "与当前系统版本不兼容，已拒绝安装",
  MARKET_THIRDPARTY_DIGEST_MISMATCH: "包摘要与目录声明不一致，已拒绝安装",
  MARKET_THIRDPARTY_DOWNLOAD_FAILED: "下载/读取安装包失败",
  MARKET_THIRDPARTY_SOURCE_NOT_ALLOWED: "在线目录只允许 HTTPS + 白名单主机",
  MARKET_THIRDPARTY_INSTALL_FAILED: "安装失败（后端已回滚安装状态）",
  MARKET_THIRDPARTY_NOT_LOADABLE: "该应用暂不支持安装包加载，本次不会生效",
  MARKET_THIRDPARTY_SIGNATURE_INVALID: "安装包签名校验未通过",
  MARKET_THIRDPARTY_RESTORE_FAILED: "回滚失败",
  MARKET_NOT_READY: "市场桥不可用（只在 OpenArc 桌面应用里可用）",
  DXOS_ERR_INTERNAL: "市场服务内部出错",
};
function thirdErrorText(code: string): string {
  return THIRD_ERROR_TEXT[code] || t("操作失败（{code}）", { code });
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function asNum(value: unknown): number | null {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}
function normalizeThirdApp(raw: any, source: "local" | "online"): ThirdApp | null {
  if (!raw || typeof raw !== "object") return null;
  const id = asText(raw.id);
  if (!id) return null;
  return {
    id,
    name: asText(raw.name) || id,
    version: asText(raw.version) || "—",
    packageUrl: asText(raw.packageUrl) || null,
    packageFile: asText(raw.packageFile) || null,
    sha256: asText(raw.sha256),
    size: asNum(raw.size),
    minSystemVersion: asText(raw.minSystemVersion) || null,
    maxSystemVersion: asText(raw.maxSystemVersion) || null,
    entry: asText(raw.entry) || null,
    description: asText(raw.description) || null,
    author: asText(raw.author) || null,
    homepage: asText(raw.homepage) || null,
    source: raw.source === "online" ? "online" : source,
  };
}
function normalizeRejected(raw: any): ThirdRejected[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((item) => item && typeof item === "object")
    .map((item: any) => ({ id: asText(item.id) || null, reason: asText(item.reason) || t("原因未知") }));
}
function normalizeThirdList(raw: any): ThirdList {
  const box = raw && typeof raw === "object" ? raw : {};
  const local = box.local && typeof box.local === "object" ? box.local : {};
  const online = box.online && typeof box.online === "object" ? box.online : {};
  return {
    systemVersion: asText(box.systemVersion) || "—",
    local: {
      present: local.present === true,
      ok: local.ok === true,
      apps: (Array.isArray(local.apps) ? local.apps : []).map((app: any) => normalizeThirdApp(app, "local")).filter(Boolean) as ThirdApp[],
      rejected: normalizeRejected(local.rejected),
      error: asText(local.error) || null,
      detail: asText(local.detail) || null,
    },
    online: {
      configured: online.configured === true,
      ok: online.ok === true,
      apps: (Array.isArray(online.apps) ? online.apps : []).map((app: any) => normalizeThirdApp(app, "online")).filter(Boolean) as ThirdApp[],
      rejected: normalizeRejected(online.rejected),
      error: asText(online.error) || null,
      detail: asText(online.detail) || null,
    },
    installed: (Array.isArray(box.installed) ? box.installed : [])
      .map((item: any) => ({
        id: asText(item.id),
        name: asText(item.name) || null,
        version: asText(item.version) || null,
        status: asText(item.status) || "installed",
        source: asText(item.source) || null,
        installedAt: asNum(item.installedAt),
        currentVersion: asText(item.currentVersion) || null,
        effectiveSource: asText(item.effectiveSource) || "builtin",
      }))
      .filter((item: ThirdInstalled) => !!item.id),
  };
}
function normalizeHealth(raw: any): ThirdHealth {
  const box = raw && typeof raw === "object" ? raw : {};
  const installed = box.installed && typeof box.installed === "object" ? box.installed : null;
  return {
    ok: box.ok !== false,
    effectiveSource: asText(box.effectiveSource) || "builtin",
    installedLoadable: box.installedLoadable === true,
    loader: asText(box.loader) || null,
    loadUrl: asText(box.loadUrl) || null,
    fallbackReason: asText(box.fallbackReason) || null,
    installed: installed
      ? {
          version: asText(installed.version) || null,
          digest: asText(installed.digest) || null,
          kind: asText(installed.kind) || null,
          entry: asText(installed.entry) || null,
          reason: asText(installed.reason) || null,
          detail: asText(installed.detail) || null,
        }
      : null,
    error: asText(box.error) || null,
    detail: asText(box.detail) || null,
  };
}

const thirdList = ref<ThirdList | null>(null);
const thirdLoaded = ref(false);
const thirdListError = ref<{ code: string; detail: string } | null>(null);
const thirdBusy = ref<string | null>(null);
const thirdNotice = ref("");
const thirdActionError = ref<{ code: string; detail: string } | null>(null);
const thirdSourceUrl = ref<string | null>(null);
const thirdSourceDraft = ref("");
const thirdSourceError = ref<{ code: string; detail: string } | null>(null);
const thirdHealth = reactive<Record<string, ThirdHealth | null>>({});
const installPick = ref<ThirdApp | null>(null);
const rollbackPick = ref<ThirdInstalled | null>(null);

const localApps = computed(() => (thirdList.value ? thirdList.value.local.apps : []));
const onlineApps = computed(() => (thirdList.value ? thirdList.value.online.apps : []));
const installedApps = computed(() => (thirdList.value ? thirdList.value.installed : []));
const rejectedEntries = computed(() => {
  const list: ThirdRejected[] = [];
  if (thirdList.value) list.push(...thirdList.value.local.rejected, ...thirdList.value.online.rejected);
  return list;
});
const installedOf = (id: string): ThirdInstalled | null => installedApps.value.find((entry) => entry.id === id) || null;
const catalogApps = computed(() => {
  const list: ThirdApp[] = [];
  for (const app of localApps.value) if (matchesQuery(app.name, app.description || "", app.id)) list.push(app);
  for (const app of onlineApps.value) {
    if (localApps.value.some((entry) => entry.id === app.id)) continue;
    if (matchesQuery(app.name, app.description || "", app.id)) list.push(app);
  }
  return list;
});

async function loadThirdSource() {
  const res = await marketCall("market/thirdparty/source/get");
  if (res.ok) {
    const value = res.value && typeof res.value === "object" ? (res.value as any) : {};
    thirdSourceUrl.value = typeof value.url === "string" ? value.url : null;
    thirdSourceDraft.value = thirdSourceUrl.value || "";
    thirdSourceError.value = null;
  } else {
    thirdSourceError.value = { code: res.error, detail: res.detail };
  }
}
async function loadThirdHealth() {
  if (!thirdList.value) return;
  await Promise.all(
    thirdList.value.installed.map(async (item) => {
      try {
        const res = await marketCall("market/update/health", { appId: item.id });
        thirdHealth[item.id] = res.ok
          ? normalizeHealth(res.value)
          : {
              ok: false,
              effectiveSource: "unknown",
              installedLoadable: false,
              loader: null,
              loadUrl: null,
              fallbackReason: null,
              installed: null,
              error: res.error,
              detail: res.detail,
            };
      } catch {
        thirdHealth[item.id] = null;
      }
    }),
  );
}
async function loadThirdParty() {
  thirdBusy.value = "list";
  thirdListError.value = null;
  const res = await marketCall("market/thirdparty/list");
  thirdLoaded.value = true;
  if (!res.ok) {
    thirdListError.value = { code: res.error, detail: res.detail };
    thirdList.value = null;
    thirdBusy.value = null;
    await loadThirdSource();
    return;
  }
  thirdList.value = normalizeThirdList(res.value);
  await loadThirdSource();
  await loadThirdHealth();
  thirdBusy.value = null;
}
async function saveThirdSource() {
  thirdBusy.value = "source";
  thirdSourceError.value = null;
  thirdNotice.value = "";
  const res = await marketCall("market/thirdparty/source/set", { url: thirdSourceDraft.value.trim() });
  thirdBusy.value = null;
  if (!res.ok) {
    thirdSourceError.value = { code: res.error, detail: res.detail };
    return;
  }
  await loadThirdParty();
  thirdNotice.value = thirdSourceDraft.value.trim() ? t("已保存在线目录地址，刷新后读取在线目录。") : t("已清除在线目录地址（本地目录与已安装列表不受影响）。");
}
function askInstall(app: ThirdApp) {
  installPick.value = app;
  thirdActionError.value = null;
}
function askRollback(item: ThirdInstalled) {
  rollbackPick.value = item;
  thirdActionError.value = null;
}
async function acceptInstall() {
  const app = installPick.value;
  installPick.value = null;
  if (!app) return;
  thirdBusy.value = "install:" + app.id;
  thirdActionError.value = null;
  thirdNotice.value = "";
  const res = await marketCall("market/thirdparty/install", { appId: app.id, confirm: true });
  thirdBusy.value = null;
  if (!res.ok) {
    thirdActionError.value = { code: res.error, detail: res.detail };
    return;
  }
  const value = res.value && typeof res.value === "object" ? (res.value as any) : {};
  const installed = value.installed && typeof value.installed === "object" ? value.installed : {};
  thirdNotice.value =
    installed.alreadyInstalled === true
      ? t("这个版本已经安装过（后端返回 alreadyInstalled）。")
      : t("已安装 {version}；安装后按 App 的加载器生效。", { version: asText(installed.version) || app.version });
  await loadThirdParty();
}
async function acceptRollback() {
  const item = rollbackPick.value;
  rollbackPick.value = null;
  if (!item) return;
  thirdBusy.value = "rollback:" + item.id;
  thirdActionError.value = null;
  thirdNotice.value = "";
  const res = await marketCall("market/thirdparty/rollback", { appId: item.id });
  thirdBusy.value = null;
  if (!res.ok) {
    thirdActionError.value = { code: res.error, detail: res.detail };
    return;
  }
  const value = res.value && typeof res.value === "object" ? (res.value as any) : {};
  thirdNotice.value = t("已回滚 {id} 到 {version}。", { id: item.id, version: asText(value.rolledBackTo) || t("上一个版本") });
  await loadThirdParty();
}

/* ── 兼容性 / 包信息 ───────────────────────────────────────────────────── */
function parseSemverText(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value || ""));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
function compareSemverText(left: string, right: string): number {
  const a = parseSemverText(left);
  const b = parseSemverText(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}
function systemVersionText(): string {
  return thirdList.value ? thirdList.value.systemVersion : "—";
}
function compatibilityOf(app: ThirdApp): { ok: boolean; text: string } {
  const system = systemVersionText();
  if (!parseSemverText(system)) return { ok: false, text: t("系统版本未知，无法判定兼容性") };
  if (app.minSystemVersion && compareSemverText(system, app.minSystemVersion) < 0) {
    return { ok: false, text: t("不兼容：需要系统 ≥ {min}，当前 {system}", { min: app.minSystemVersion, system }) };
  }
  if (app.maxSystemVersion && compareSemverText(system, app.maxSystemVersion) > 0) {
    return { ok: false, text: t("不兼容：最高支持系统 {max}，当前 {system}", { max: app.maxSystemVersion, system }) };
  }
  return { ok: true, text: t("兼容当前系统 {system}", { system }) };
}
function shaShort(app: ThirdApp): string {
  return app.sha256 ? app.sha256.slice(0, 12) + "…" : t("未声明");
}
function packageText(app: ThirdApp): string {
  if (app.packageFile) return t("本地包 {name}", { name: app.packageFile });
  if (app.packageUrl) {
    try {
      return t("在线包 {host}", { host: new URL(app.packageUrl).host });
    } catch {
      return t("在线包");
    }
  }
  return t("未声明安装包");
}
function signatureText(app: ThirdApp): string {
  return t("签名：安装时按 app-update-keys.json 的 {id} 公钥验签；目录只声明 sha256，未安装前不做预校验。", { id: app.id });
}
function installedHealthText(id: string): string {
  const health = thirdHealth[id];
  if (!health) return t("加载健康：未读取");
  if (health.error) return t("加载健康失败：{code}", { code: health.error });
  if (health.effectiveSource === "installed" && health.installedLoadable) return t("已安装包可加载（验签与摘要通过）");
  if (health.effectiveSource === "builtin" && health.installed && health.installed.version) {
    return t("已安装包不可加载，回退内置版本：{reason}", { reason: healthFallbackText(health.fallbackReason || (health.installed && health.installed.reason)) });
  }
  return t("当前使用随包内置版本");
}
const localStateText = computed(() => {
  const list = thirdList.value;
  if (!list) return t("正在读取…");
  if (!list.local.present) return t("没有本地第三方目录（未找到 third-party.json）");
  if (!list.local.ok) return t("本地目录存在但格式不合法");
  return t("已读取本地目录（{n} 个应用）", { n: list.local.apps.length });
});
const onlineStateText = computed(() => {
  const list = thirdList.value;
  if (!list) return t("在线目录读取中…");
  if (!list.online.ok) return "";
  return t("已读取在线目录（{n} 个应用）", { n: list.online.apps.length });
});
function healthFallbackText(reason: string | null | undefined): string {
  if (!reason) return "—";
  if (reason === "pointer-cleared") return t("没有安装指针（使用内置版本）");
  if (reason === "pointer-missing") return t("安装指针文件缺失");
  if (reason === "pointer-invalid") return t("安装指针无效");
  if (reason === "MARKET_UPDATE_NOT_READY") return t("公钥缺失或更新服务未就绪");
  if (reason === "MARKET_UPDATE_SIGNATURE_INVALID") return t("签名校验未通过");
  if (reason === "MARKET_UPDATE_DIGEST_MISMATCH") return t("内容摘要不一致");
  return reason;
}

/* ── 全应用更新健康 ─────────────────────────────────────────────────────── */
type HealthRow = { app: AppEntry; status: AppUpdateStatus | null; health: ThirdHealth | null; error: { code: string; detail: string } | null };
const healthRows = ref<HealthRow[]>([]);
const healthBusy = ref(false);
const healthRowsFiltered = computed(() => healthRows.value.filter((row) => matchesQuery(row.app.name, descOf(row.app))));
function healthVersionText(row: HealthRow): string {
  const status = statuses[row.app.id];
  if (!status) return "—";
  if (status.current) return status.current.version;
  return t("内置 {version}", { version: status.builtinVersion });
}
async function loadHealthRows() {
  healthBusy.value = true;
  const rows = await Promise.all(
    APPS.filter((a) => a.id !== "market").map(async (a) => {
      const status = statuses[a.id] ?? null;
      try {
        const res = await marketCall("market/update/health", { appId: a.id });
        return { app: a, status, health: res.ok ? normalizeHealth(res.value) : null, error: res.ok ? null : { code: res.error, detail: res.detail } } as HealthRow;
      } catch {
        return { app: a, status, health: null, error: { code: "DXOS_ERR_INTERNAL", detail: "" } } as HealthRow;
      }
    }),
  );
  healthRows.value = rows;
  healthBusy.value = false;
}

/* ── 视图与导航 ─────────────────────────────────────────────────────────── */
const pageTitle = computed(() => {
  if (view.value === "external") return t("外部应用");
  if (view.value === "updates") return t("更新");
  if (view.value === "health") return t("加载状态");
  return cat.value === "全部" ? t("发现") : t(cat.value);
});
const pageSub = computed(() => {
  if (view.value === "external") {
    const catalog = localApps.value.length + onlineApps.value.length;
    return t("{plugins} 个集成服务 · {catalog} 个目录条目 · {installed} 已安装", {
      plugins: integrationPlugins.value.length,
      catalog,
      installed: installedApps.value.length,
    });
  }
  if (view.value === "updates") return upgradable.value.length ? t("{n} 个可用更新", { n: upgradable.value.length }) : t("所有应用都是最新版本");
  if (view.value === "health") return t("{n} 个应用", { n: healthRows.value.length });
  if (view.value === "apps") {
    if (marketTab.value === "official") return t("{n} 个官方技能 · {m} 个模板", { n: officialSkills.value.length, m: marketTemplates.value.length });
    if (marketTab.value === "new") return latestEntries.value.length ? t("{n} 个按上线时间倒序的条目", { n: latestEntries.value.length }) : t("本地目录没有上线时间数据");
    if (marketTab.value === "featured") return featuredRails.value.length ? t("{n} 个精选项目", { n: featuredRails.value.reduce((sum, rail) => sum + rail.items.length, 0) }) : t("本地目录没有精选条目");
    if (marketTab.value === "all") return t("{n} 个应用 · {m} 个官方技能 · {k} 个模板", { n: apps.value.length, m: officialSkills.value.length, k: marketTemplates.value.length });
  }
  return t("{n} 个应用", { n: apps.value.length });
});

/* ══ TapNow 结构对齐：全部 / 应用 / 官方技能 / 最新上线 / 精选项目 ═════════
   数据只来自本地：
     · 应用 = 本地应用注册表（src-vue/apps.ts 的 APPS / APP_CATEGORY / DESC）；
     · 官方技能 = 技能域 skill/list 里 origin === "official" 的条目（本地技能定义，含 systemPrompt /
       SKILL.md 的 source.instructions），不安装代码、不联网；
     · 「最新上线 / 精选项目」需要 publishedAt / featured / railPages 这类字段，随包的
       resources/market/catalog.json 当前 apps / skillPacks 都是 0 条（market/catalog 实测），
       所以这两页只显示空态并写清来源，绝不编造条目。 */
type MarketTab = "all" | "apps" | "official" | "new" | "featured";
const MARKET_TABS: readonly { id: MarketTab; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "apps", label: "应用" },
  { id: "official", label: "官方技能" },
  { id: "new", label: "最新上线" },
  { id: "featured", label: "精选项目" },
];
const marketTab = ref<MarketTab>("all");

/* ── 本地市场清单（market/catalog）：技能包 / 模板 / rails 的真实数据源 ────
   全部来自 resources/market/catalog.json（随包目录，只读）；没有网络请求。
   catalog 里的官方技能包 id 与 skill/list 的 origin=official 技能同 id，界面按 id 合并：
   live 技能给「是否已添加」，catalog 给提示词 / 六段 / 发布时间 / 精选。 */
type CatalogSections = Record<string, string>;
type CatalogSkillPack = { id: string; name: string; version: string; description: string; summary: string; prompt: string; sections: CatalogSections; category: string; featured: boolean; publishedAt: number; tags: string[] };
type TemplateKind = "text" | "image" | "video" | "audio";
type TemplateDocNode = { id: string; kind: TemplateKind | "table"; x: number; y: number; w: number; h: number; title: string; text: string; prompt: string; params?: Record<string, unknown>; table?: { title: string; columns: string[]; rows: string[][] } };
type TemplateDoc = { nodes: TemplateDocNode[]; edges: { id: string; from: string; to: string }[] };
type MarketTemplate = { id: string; name: string; version: string; kind: TemplateKind; category: string; summary: string; prompt: string; nodeTitle: string; steps: { title: string; detail: string }[]; tags: string[]; featured: boolean; publishedAt: number; sections: CatalogSections; doc?: TemplateDoc | null };
type CatalogApp = { id: string; name: string; version: string; subtitle: string; summary: string; prompt: string; sections: CatalogSections; category: string; categoryIds: string[]; tags: string[]; featured: boolean; publishedAt: number; builtIn: boolean; sourceUrl: string; package: AppPackageInfo | null };
type RailPage = { id: string; title: string; itemIds: string[] };
const catalogSkillPacks = ref<CatalogSkillPack[]>([]);
const marketTemplates = ref<MarketTemplate[]>([]);
const marketCatalogApps = ref<CatalogApp[]>([]);
const catalogRails = ref<RailPage[]>([]);
const catalogError = ref<{ code: string; detail: string } | null>(null);
const catalogLoaded = ref(false);
const SECTION_KEYS = ["what", "context", "how", "output", "scope", "followUp"] as const;
function asSections(raw: unknown): CatalogSections {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const box = raw as Record<string, unknown>;
  const out: CatalogSections = {};
  for (const key of SECTION_KEYS) if (typeof box[key] === "string" && String(box[key]).trim()) out[key] = String(box[key]).trim();
  return out;
}
const objRows = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item)) as Record<string, unknown>[] : []);
const strOf = (value: unknown): string => (typeof value === "string" ? value : "");
const numOf = (value: unknown): number => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0);
const TEMPLATE_KINDS: TemplateKind[] = ["text", "image", "video", "audio"];
const TEMPLATE_NODE_KINDS = ["text", "image", "video", "audio", "table"];
function asAppPackage(raw: unknown): AppPackageInfo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const box = raw as Record<string, unknown>;
  const url = strOf(box.url);
  const sha256 = strOf(box.sha256);
  const size = Number(box.size);
  const version = strOf(box.version);
  if (!url || !sha256 || !version || !Number.isFinite(size) || size < 1) return null;
  return { url, sha256, size, version };
}
/** catalog 里的模板 doc（主进程已校验；这里只读并做形状兜底，不重写规则）。 */
function asTemplateDoc(raw: unknown): TemplateDoc | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const box = raw as Record<string, unknown>;
  const nodes = objRows(box.nodes).map((node) => {
    const kind = strOf(node.kind);
    const tableRaw = node.table && typeof node.table === "object" && !Array.isArray(node.table) ? (node.table as Record<string, unknown>) : null;
    return {
      id: strOf(node.id),
      kind: (TEMPLATE_NODE_KINDS.includes(kind) ? kind : "text") as TemplateDocNode["kind"],
      x: Number(node.x) || 0, y: Number(node.y) || 0,
      w: Number(node.w) || 260, h: Number(node.h) || 220,
      title: strOf(node.title), text: strOf(node.text), prompt: strOf(node.prompt),
      params: node.params && typeof node.params === "object" && !Array.isArray(node.params) ? (node.params as Record<string, unknown>) : undefined,
      table: tableRaw ? {
        title: strOf(tableRaw.title) || "多维表格",
        columns: Array.isArray(tableRaw.columns) ? tableRaw.columns.map((x) => String(x)) : [],
        rows: Array.isArray(tableRaw.rows) ? tableRaw.rows.map((row) => (Array.isArray(row) ? row.map((x) => String(x)) : [])) : [],
      } : undefined,
    };
  }).filter((node) => node.id);
  if (!nodes.length) return null;
  const edges = objRows(box.edges).map((edge) => ({ id: strOf(edge.id), from: strOf(edge.from), to: strOf(edge.to) })).filter((edge) => edge.from && edge.to);
  return { nodes, edges };
}
async function loadMarketCatalog() {
  catalogLoaded.value = true;
  const r = await marketCall("market/catalog");
  if (!r.ok) { catalogError.value = { code: r.error, detail: r.detail }; catalogSkillPacks.value = []; marketTemplates.value = []; marketCatalogApps.value = []; catalogRails.value = []; return; }
  const box = r.value && typeof r.value === "object" ? (r.value as Record<string, unknown>) : {};
  catalogSkillPacks.value = objRows(box.skillPacks).map((item) => ({
    id: strOf(item.id), name: strOf(item.name), version: strOf(item.version), description: strOf(item.description),
    summary: strOf(item.summary), prompt: strOf(item.prompt), sections: asSections(item.sections),
    category: strOf(item.category), featured: item.featured === true, publishedAt: numOf(item.publishedAt),
    tags: Array.isArray(item.tags) ? item.tags.map((x) => String(x)).slice(0, 12) : [],
  })).filter((item) => item.id && item.name);
  marketTemplates.value = objRows(box.templates).map((item) => ({
    id: strOf(item.id), name: strOf(item.name), version: strOf(item.version) || "1.0.0",
    kind: (TEMPLATE_KINDS as string[]).includes(strOf(item.kind)) ? (strOf(item.kind) as TemplateKind) : "text",
    category: strOf(item.category), summary: strOf(item.summary), prompt: strOf(item.prompt),
    nodeTitle: strOf(item.nodeTitle) || strOf(item.name),
    steps: objRows(item.steps).map((step) => ({ title: strOf(step.title), detail: strOf(step.detail) })).filter((step) => step.title || step.detail).slice(0, 12),
    tags: Array.isArray(item.tags) ? item.tags.map((x) => String(x)).slice(0, 12) : [],
    featured: item.featured === true, publishedAt: numOf(item.publishedAt), sections: asSections(item.sections),
    doc: asTemplateDoc(item.doc),
  })).filter((item) => item.id && item.name && item.prompt);
  marketCatalogApps.value = objRows(box.apps).map((item) => ({
    id: strOf(item.id), name: strOf(item.name), version: strOf(item.version), subtitle: strOf(item.subtitle),
    summary: strOf(item.summary), prompt: strOf(item.prompt), sections: asSections(item.sections),
    category: strOf(item.category), categoryIds: Array.isArray(item.categoryIds) ? item.categoryIds.map((x) => String(x)).slice(0, 30) : [],
    tags: Array.isArray(item.tags) ? item.tags.map((x) => String(x)).slice(0, 12) : [],
    featured: item.featured === true, publishedAt: numOf(item.publishedAt),
    builtIn: item.builtIn === true, sourceUrl: strOf(item.sourceUrl),
    package: asAppPackage(item.package),
  })).filter((item) => item.id && item.name);
  catalogRails.value = objRows(box.railPages).map((item) => ({
    id: strOf(item.id), title: strOf(item.title),
    itemIds: Array.isArray(item.itemIds) ? item.itemIds.map((x) => String(x)).slice(0, 30) : [],
  })).filter((item) => item.id && item.title);
  catalogCategories.value = objRows(box.categories).map((item) => ({ id: strOf(item.id), name: strOf(item.name), count: numOf(item.count) })).filter((item) => item.id && item.name);
  catalogError.value = null;
}
const catalogCategories = ref<{ id: string; name: string; count: number }[]>([]);
const catalogCategoryNames = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {};
  for (const item of catalogCategories.value) out[item.id] = item.name;
  return out;
});
const categoryNameOf = (id: string): string => (id ? catalogCategoryNames.value[id] || id : "");

type MarketSkill = {
  id: string;
  name?: string;
  description?: string;
  origin?: string;
  builtin?: boolean;
  layer?: string;
  kind?: string;
  enabled?: boolean;
  systemPrompt?: string;
  exposure?: string;
  source?: { instructions?: string; files?: { path?: string; content?: string }[] };
  v2?: { inputs?: string[]; output?: string; steps?: { title?: string; detail?: string }[] };
};
const marketSkills = ref<MarketSkill[]>([]);
const skillsError = ref<{ code: string; detail: string } | null>(null);
const skillsLoaded = ref(false);
async function skillCall(command: string, payload: Record<string, unknown> = {}): Promise<MarketResult> {
  const api = window.openarc?.skill;
  if (!api || typeof api.command !== "function") return { ok: false, error: "SKILL_NOT_READY", detail: "当前环境没有技能桥（只在 OpenArc 桌面应用里可用）" };
  try {
    const raw = await api.command({ command, payload });
    const box = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    if (box.ok === true) return { ok: true, value: box.value, error: "", detail: "" };
    return { ok: false, value: box.value, error: typeof box.error === "string" ? box.error : "SKILL_INTERNAL", detail: typeof box.detail === "string" ? box.detail : "" };
  } catch (error) {
    return { ok: false, error: "SKILL_INTERNAL", detail: error && typeof error === "object" ? String((error as { message?: unknown }).message || "") : String(error) };
  }
}
function normalizeMarketSkill(raw: unknown): MarketSkill | null {
  if (!raw || typeof raw !== "object") return null;
  const box = raw as Record<string, unknown>;
  const id = typeof box.id === "string" ? box.id : "";
  if (!id) return null;
  return {
    id,
    name: typeof box.name === "string" ? box.name : "",
    description: typeof box.description === "string" ? box.description : "",
    origin: typeof box.origin === "string" ? box.origin : "",
    builtin: box.builtin === true,
    layer: typeof box.layer === "string" ? box.layer : "",
    kind: typeof box.kind === "string" ? box.kind : "",
    exposure: typeof box.exposure === "string" ? box.exposure : "",
    enabled: box.enabled !== false,
    systemPrompt: typeof box.systemPrompt === "string" ? box.systemPrompt : "",
    source: box.source && typeof box.source === "object" ? (box.source as MarketSkill["source"]) : undefined,
    v2: box.v2 && typeof box.v2 === "object" ? (box.v2 as MarketSkill["v2"]) : undefined,
  };
}
async function loadMarketSkills() {
  const r = await skillCall("skill/list");
  skillsLoaded.value = true;
  if (!r.ok) {
    skillsError.value = { code: r.error, detail: r.detail };
    marketSkills.value = [];
    return;
  }
  const box = r.value && typeof r.value === "object" ? (r.value as Record<string, unknown>) : {};
  const items = Array.isArray(box.items) ? box.items : Array.isArray(box.skills) ? box.skills : [];
  marketSkills.value = items.map(normalizeMarketSkill).filter(Boolean) as MarketSkill[];
  skillsError.value = null;
}
/** 官方技能行：live skill/list（origin=official）给「是否已添加」，catalog 技能包给提示词 / 六段 / 发布时间 / 精选，按 id 合并。 */
type SkillRow = {
  id: string; name: string; description: string; prompt: string; sections: CatalogSections;
  publishedAt: number; featured: boolean; enabled: boolean; catalogOnly: boolean;
  layer: string; kind: string; category: string;
};
const officialSkillRows = computed<SkillRow[]>(() => {
  const live = new Map(marketSkills.value.filter((s) => s.origin === "official").map((s) => [s.id, s]));
  const rows: SkillRow[] = [];
  for (const pack of catalogSkillPacks.value) {
    const row = live.get(pack.id);
    rows.push({
      id: pack.id,
      name: pack.name || (row && row.name) || pack.id,
      description: pack.summary || pack.description || (row && row.description) || "",
      prompt: pack.prompt || (row ? skillPrompt(row) : ""),
      sections: pack.sections,
      publishedAt: pack.publishedAt,
      featured: pack.featured,
      enabled: row ? row.enabled !== false : false,
      catalogOnly: !row,
      layer: (row && row.layer) || "",
      kind: (row && row.kind) || "",
      category: pack.category,
    });
    live.delete(pack.id);
  }
  for (const row of live.values()) {
    rows.push({
      id: row.id, name: row.name || row.id, description: row.description || "", prompt: skillPrompt(row),
      sections: {}, publishedAt: 0, featured: false, enabled: row.enabled !== false, catalogOnly: false,
      layer: row.layer || "", kind: row.kind || "", category: "",
    });
  }
  return rows;
});
const officialSkills = officialSkillRows;
const visibleOfficialSkills = computed(() => officialSkillRows.value.filter((row) => matchesQuery(row.name, row.id, row.description)));
/** 技能提示词：systemPrompt → SKILL.md 指令 → v2 分步说明；都为空就如实说没有 */
const skillPrompt = (s: MarketSkill): string => {
  const direct = String(s.systemPrompt || "").trim();
  if (direct) return direct;
  const instructions = String((s.source && s.source.instructions) || "").trim();
  if (instructions) return instructions;
  const steps = Array.isArray(s.v2 && s.v2.steps) ? (s.v2!.steps as { title?: string; detail?: string }[]) : [];
  return steps.map((x) => [x.title, x.detail].filter(Boolean).join("：")).filter(Boolean).join("\n").trim();
};
const skillPromptSource = (s: MarketSkill): string => {
  if (String(s.systemPrompt || "").trim()) return t("本地技能定义的 systemPrompt");
  if (String((s.source && s.source.instructions) || "").trim()) return t("本地 SKILL.md（source.instructions）");
  if (Array.isArray(s.v2 && s.v2.steps) && (s.v2!.steps as unknown[]).length) return t("本地技能定义的分步说明");
  return "";
};

/* ── 详情（六段）+ 四个 CTA ────────────────────────────────────────────── */
type DetailSection = { key: string; title: string; body: string; empty: boolean; source: string };
type DetailCta = { enabled: boolean; reason: string };
type AppPackageInfo = { url: string; sha256: string; size: number; version: string };
type MarketDetail = {
  kind: "app" | "skill" | "template" | "catalog-app";
  id: string;
  name: string;
  subtitle: string;
  sections: DetailSection[];
  prompt: string;
  promptSource: string;
  copy: DetailCta;
  chat: DetailCta;
  agent: DetailCta;
  try: DetailCta;
  added: boolean;
  appId?: string;
  template?: MarketTemplate;
  /** 详情头部的那行来源说明（应用分注册表 / 注册表+清单两种） */
  metaLabel?: string;
  /** task-31：内置应用的更新入口 / 外部条目的安装包信息（都走既有通道） */
  builtIn?: boolean;
  packaged?: AppPackageInfo | null;
  update?: DetailCta;
  release?: DetailCta;
  install?: DetailCta;
};
const marketDetail = ref<MarketDetail | null>(null);
const marketNotice = ref("");
const hasSkillBridge = (): boolean => typeof window.openarc?.skill?.command === "function";
const hasAgentBridge = (): boolean => typeof window.openarc?.agent?.command === "function";
const section = (key: string, title: string, body: string, source: string): DetailSection => ({ key, title, body: body || t("暂无"), empty: !body, source });
const EMPTY_INPUT_SOURCE = t("本地数据源没有「你需要提供什么」字段（应用注册表没有输入声明；技能只有导入分析后的 v2.inputs 才有）");
const EMPTY_HOW_SOURCE = t("本地数据源没有实现说明字段");
const EMPTY_OUTPUT_SOURCE = t("本地数据源没有输出声明字段");
const EMPTY_SCOPE_SOURCE = t("本地数据源没有边界声明字段");

function openAppMarketDetail(id: string) {
  const app = appById(id);
  const catalogApp = marketCatalogApps.value.find((item) => item.id === id) || null;
  if (!app && !catalogApp) return;
  const name = app ? app.name : catalogApp!.name;
  const description = (catalogApp && (catalogApp.summary || catalogApp.subtitle)) || (app ? descOf(app) : "");
  const sec = catalogApp ? catalogApp.sections : {};
  const prompt = catalogApp ? catalogApp.prompt : "";
  // 纯函数投影（market-domain.projectMarketplaceAppDetail）：来源/安装/更新策略集中在主进程侧校验
  const projection = catalogApp ? projectAppDetail(catalogApp) : null;
  const facts = [
    app ? t("分类：{cat}", { cat: catOf(app) }) : "",
    t("版本 v{version}", { version: app ? app.version : catalogApp!.version }),
    app ? (inDock(id) ? t("已在程序坞") : t("不在程序坞")) : t("不在应用注册表"),
    catalogApp && catalogApp.publishedAt ? t("上线：{v}", { v: new Date(catalogApp.publishedAt).toLocaleDateString("zh-CN") }) : "",
    catalogApp && catalogApp.featured ? t("精选") : "",
  ].filter(Boolean).join(" · ");
  marketNotice.value = "";
  marketDetail.value = {
    kind: "app",
    id,
    name,
    subtitle: description,
    sections: [
      section("what", t("它能帮你做什么"), sec.what || description, sec.what ? SECTION_SOURCE_CATALOG : t("本地应用注册表的简介（src-vue/apps.ts DESC）")),
      section("context", t("你需要提供什么"), sec.context || "", sec.context ? SECTION_SOURCE_CATALOG : EMPTY_INPUT_SOURCE),
      section("how", t("它是如何工作的"), sec.how || "", sec.how ? SECTION_SOURCE_CATALOG : EMPTY_HOW_SOURCE),
      section("get", t("你将获得什么"), sec.output || "", sec.output ? SECTION_SOURCE_CATALOG : EMPTY_OUTPUT_SOURCE),
      section("scope", t("适用范围与边界"), sec.scope || facts, sec.scope ? SECTION_SOURCE_CATALOG : t("本地应用注册表的分类 / 版本 / 程序坞状态；边界说明：" + t("暂无"))),
      section("follow", t("接下来还可以怎么做"), sec.followUp || "", sec.followUp ? SECTION_SOURCE_CATALOG : t("见下方按钮：立即体验 / 添加到程序坞 / 版本与更新")),
    ],
    prompt,
    promptSource: prompt ? SECTION_SOURCE_CATALOG : t("应用注册表没有提示词字段"),
    copy: prompt ? { enabled: true, reason: "" } : { enabled: false, reason: t("这个应用条目没有提示词，无可复制内容") },
    chat: prompt ? { enabled: true, reason: "" } : { enabled: false, reason: t("应用没有提示词，无法带到对话里；请用「立即体验」在应用内使用") },
    agent: { enabled: false, reason: t("本地应用目录没有 Agent 技能定义，应用不能直接添加到 Agent") },
    try: app ? { enabled: true, reason: "" } : { enabled: false, reason: t("这个本地市场 App 不在应用注册表里，无法打开") },
    added: !!app,
    appId: app ? app.id : undefined,
    builtIn: !!(catalogApp && catalogApp.builtIn),
    metaLabel: catalogApp && catalogApp.builtIn
      ? t("内置 · 随包更新（本地市场清单 + 应用注册表）")
      : (catalogApp
        ? (app ? t("本地应用 · 应用注册表 + 本地市场清单") : t("本地市场 App"))
        : t("本地应用 · 应用注册表")),
    packaged: projection && projection.packageUrl
      ? { url: projection.packageUrl, sha256: projection.packageSha256, size: projection.packageSize, version: projection.packageVersion }
      : null,
    // 内置：检查更新走既有 market/update/health 命令；版本与更新打开现成的「更新」页
    update: projection && projection.updateCommand
      ? { enabled: true, reason: "" }
      : { enabled: false, reason: t("只有内置应用有随包更新记录") },
    release: { enabled: true, reason: "" },
    // 外部条目：现有第三方通道只按在线目录 appId 安装，不接受任意包地址
    install: projection
      ? {
          enabled: projection.install.enabled,
          reason: projection.install.reason === "NO_PACKAGE"
            ? t("这个条目没有安装包信息")
            : t("第三方安装包通道未接：现有通道只按在线目录 appId 安装，不接受任意包地址"),
        }
      : { enabled: false, reason: t("这个条目没有安装包信息") },
  };
}
const SECTION_SOURCE_CATALOG = t("本地市场清单（resources/market/catalog.json，只读）");
function openSkillMarketDetail(s: SkillRow) {
  const prompt = String(s.prompt || "").trim();
  const sec = s.sections || {};
  const facts = [s.layer ? t("层：{v}", { v: s.layer }) : "", s.kind ? t("类型：{v}", { v: s.kind }) : "", s.enabled ? t("已添加到 Agent") : t("未添加")].filter(Boolean).join(" · ");
  marketNotice.value = "";
  marketDetail.value = {
    kind: "skill",
    id: s.id,
    name: s.name || s.id,
    subtitle: s.description || "",
    sections: [
      section("what", t("它能帮你做什么"), sec.what || String(s.description || "").trim(), sec.what ? SECTION_SOURCE_CATALOG : t("本地技能定义的 description（skill/list，origin=official）")),
      section("context", t("你需要提供什么"), sec.context || "", sec.context ? SECTION_SOURCE_CATALOG : EMPTY_INPUT_SOURCE),
      section("how", t("它是如何工作的"), sec.how || prompt, sec.how ? SECTION_SOURCE_CATALOG : t("本地技能定义的 systemPrompt")),
      section("get", t("你将获得什么"), sec.output || "", sec.output ? SECTION_SOURCE_CATALOG : EMPTY_OUTPUT_SOURCE),
      section("scope", t("适用范围与边界"), sec.scope || facts, sec.scope ? SECTION_SOURCE_CATALOG : t("本地技能定义的 layer / kind 与添加状态；" + "边界说明：" + t("暂无"))),
      section("follow", t("接下来还可以怎么做"), sec.followUp || "", sec.followUp ? SECTION_SOURCE_CATALOG : t("见下方按钮：复制提示词 / 在对话中试用 / 添加到 Agent")),
    ],
    prompt,
    promptSource: prompt ? (s.catalogOnly ? SECTION_SOURCE_CATALOG : t("本地技能定义的 systemPrompt")) : t("本地技能定义没有提示词字段"),
    copy: prompt ? { enabled: true, reason: "" } : { enabled: false, reason: t("这个技能在本地定义里没有提示词，无法复制") },
    chat: prompt ? { enabled: true, reason: "" } : { enabled: false, reason: t("没有提示词可带进对话") },
    agent: hasAgentBridge() && hasSkillBridge() && !s.catalogOnly
      ? { enabled: true, reason: "" }
      : { enabled: false, reason: s.catalogOnly ? t("这个技能包来自本地清单，但技能域没有同名技能，不能添加到 Agent") : t("当前构建没有 Agent 桥（或技能桥），无法添加到 Agent") },
    try: { enabled: false, reason: t("技能不是独立应用；请用「在对话中试用」或「添加到 Agent」") },
    added: s.enabled !== false,
  };
}
function openTemplateMarketDetail(template: MarketTemplate) {
  const sec = template.sections || {};
  const stepsText = template.steps.map((step) => (step.title ? "· " + step.title + (step.detail ? "：" + step.detail : "") : "· " + step.detail)).join("\n");
  const facts = [template.category ? t("分类：{v}", { v: categoryNameOf(template.category) }) : "", template.version ? "v" + template.version : "", template.publishedAt ? t("上线：{v}", { v: new Date(template.publishedAt).toLocaleDateString("zh-CN") }) : "", template.featured ? t("精选") : ""].filter(Boolean).join(" · ");
  marketNotice.value = "";
  marketDetail.value = {
    kind: "template",
    id: template.id,
    name: template.name,
    subtitle: template.summary || "",
    sections: [
      section("what", t("它能帮你做什么"), sec.what || template.summary, sec.what ? SECTION_SOURCE_CATALOG : t("本地市场清单的模板 summary")),
      section("context", t("你需要提供什么"), sec.context || "", sec.context ? SECTION_SOURCE_CATALOG : EMPTY_INPUT_SOURCE),
      section("how", t("它是如何工作的"), sec.how || stepsText, sec.how ? SECTION_SOURCE_CATALOG : t("本地市场清单的模板步骤（画布真实 starter flow）")),
      section("get", t("你将获得什么"), sec.output || "", sec.output ? SECTION_SOURCE_CATALOG : EMPTY_OUTPUT_SOURCE),
      section("scope", t("适用范围与边界"), sec.scope || facts, sec.scope ? SECTION_SOURCE_CATALOG : t("本地市场清单的模板分类 / 版本 / 上线时间；" + "边界说明：" + t("暂无"))),
      section("follow", t("接下来还可以怎么做"), sec.followUp || "", sec.followUp ? SECTION_SOURCE_CATALOG : t("见下方按钮：立即体验（新建画布并写好首节点）/ 复制提示词 / 在对话中试用")),
    ],
    prompt: template.prompt,
    promptSource: t("本地市场清单的模板 prompt"),
    copy: template.prompt ? { enabled: true, reason: "" } : { enabled: false, reason: t("这个模板在本地清单里没有提示词，无法复制") },
    chat: template.prompt ? { enabled: true, reason: "" } : { enabled: false, reason: t("没有提示词可带进对话") },
    agent: { enabled: false, reason: t("模板是画布工作流，不是 Agent 技能，不能添加到 Agent") },
    try: { enabled: true, reason: "" },
    added: false,
    template,
  };
}
function openCatalogAppDetail(id: string) {
  const app = marketCatalogApps.value.find((item) => item.id === id);
  if (!app) return;
  const sec = app.sections || {};
  const facts = [app.category ? t("分类：{v}", { v: app.category }) : "", app.version ? "v" + app.version : "", app.publishedAt ? t("上线：{v}", { v: new Date(app.publishedAt).toLocaleDateString("zh-CN") }) : ""].filter(Boolean).join(" · ");
  marketNotice.value = "";
  marketDetail.value = {
    kind: "catalog-app",
    id: app.id,
    name: app.name,
    subtitle: app.subtitle || app.summary || "",
    sections: [
      section("what", t("它能帮你做什么"), sec.what || app.summary, sec.what ? SECTION_SOURCE_CATALOG : t("本地市场清单的 App summary")),
      section("context", t("你需要提供什么"), sec.context || "", sec.context ? SECTION_SOURCE_CATALOG : EMPTY_INPUT_SOURCE),
      section("how", t("它是如何工作的"), sec.how || "", sec.how ? SECTION_SOURCE_CATALOG : EMPTY_HOW_SOURCE),
      section("get", t("你将获得什么"), sec.output || "", sec.output ? SECTION_SOURCE_CATALOG : EMPTY_OUTPUT_SOURCE),
      section("scope", t("适用范围与边界"), sec.scope || facts, sec.scope ? SECTION_SOURCE_CATALOG : t("本地市场清单的 App 分类 / 版本 / 上线时间；" + "边界说明：" + t("暂无"))),
      section("follow", t("接下来还可以怎么做"), sec.followUp || "", sec.followUp ? SECTION_SOURCE_CATALOG : t("见下方按钮：复制提示词 / 在对话中试用")),
    ],
    prompt: app.prompt || "",
    promptSource: app.prompt ? SECTION_SOURCE_CATALOG : t("本地市场清单的 App 没有提示词字段"),
    copy: app.prompt ? { enabled: true, reason: "" } : { enabled: false, reason: t("这个应用条目在本地清单里没有提示词，无可复制内容") },
    chat: app.prompt ? { enabled: true, reason: "" } : { enabled: false, reason: t("应用没有提示词，无法带到对话里") },
    agent: { enabled: false, reason: t("本地市场清单的 App 没有 Agent 技能定义，不能直接添加到 Agent") },
    try: { enabled: false, reason: t("本地市场 App 条目没有可执行入口；请用「应用」页签里的内置应用") },
    added: false,
  };
}
function closeMarketDetail() {
  marketDetail.value = null;
  marketNotice.value = "";
}
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "true");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
/** 打开对话并把提示词填进输入框（ChatApp 的 textarea 是 v-model，派发 input 事件即可写入其 draft） */
function fillChatDraft(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const el = document.querySelector<HTMLTextAreaElement>("[data-chat-input]");
      if (el && !el.disabled) {
        el.value = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.focus();
        try { el.setSelectionRange(text.length, text.length); } catch { /* 不支持选区的实现 */ }
        resolve(true);
        return;
      }
      if (Date.now() - started > 2600) { resolve(false); return; }
      window.setTimeout(tick, 120);
    };
    tick();
  });
}
/** 与 electron/market-domain.cjs projectMarketplaceAppDetail 同形的纯投影（桥只回清单原字段，策略在这里复述）。 */
function projectAppDetail(app: CatalogApp) {
  const pkg = app.package;
  const builtIn = app.builtIn === true;
  return {
    builtIn,
    sourceUrl: app.sourceUrl || "",
    packageUrl: pkg ? pkg.url : "",
    packageSize: pkg ? pkg.size : 0,
    packageSha256: pkg ? pkg.sha256 : "",
    packageVersion: pkg ? pkg.version : "",
    updateCommand: builtIn ? "market/update/health" : null,
    install: pkg
      ? { enabled: false, reason: "THIRD_PARTY_PACKAGE_CHANNEL_NOT_WIRED" }
      : { enabled: false, reason: "NO_PACKAGE" },
  };
}
function packageSizeText(size: number): string {
  if (!Number.isFinite(size) || size < 1) return "—";
  if (size >= 1024 * 1024 * 1024) return (size / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  if (size >= 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + " MB";
  return Math.round(size / 1024) + " KB";
}
async function detailCheckUpdate() {
  const d = marketDetail.value;
  if (!d || !d.update || !d.update.enabled || !d.appId) { if (d && d.update) marketNotice.value = d.update.reason; return; }
  const res = await marketCall(UPDATE_STATUS_COMMAND, { appId: d.appId });
  if (!res.ok) { marketNotice.value = t("检查更新失败（{code}）", { code: res.error }); return; }
  const status = normalizeAppUpdateStatus(res.value);
  statuses[d.appId] = status;
  const info = appCardUpdate(status);
  marketNotice.value = info.canUpgrade
    ? t("有新版本可用（{badge}；在「更新」页安装）", { badge: info.badge })
    : info.badge.indexOf("未检查") >= 0
      ? t("检查完成：{badge}（本次没有可取到的更新记录）", { badge: info.badge })
      : t("已是最新版本（{badge}）", { badge: info.badge });
}
function detailVersionPanel() {
  closeMarketDetail();
  switchView("updates");
}
function detailInstallPackage() {
  const d = marketDetail.value;
  if (d && d.install) marketNotice.value = d.install.reason;
}
async function detailCopy() {
  const d = marketDetail.value;
  if (!d || !d.copy.enabled) return;
  marketNotice.value = (await copyToClipboard(d.prompt)) ? t("已复制提示词") : t("复制失败：剪贴板不可用");
}
async function detailChat() {
  const d = marketDetail.value;
  if (!d || !d.chat.enabled) return;
  const copied = await copyToClipboard(d.prompt);
  shell.activateApp("chat");
  const filled = await fillChatDraft(d.prompt);
  marketNotice.value = filled
    ? t("已在对话里填好提示词（同时复制到剪贴板）")
    : copied ? t("对话窗口没就绪：提示词已复制，粘贴即可") : t("对话窗口没就绪，且剪贴板不可用");
}
async function detailAgent() {
  const d = marketDetail.value;
  if (!d || !d.agent.enabled) return;
  if (d.kind !== "skill") { marketNotice.value = d.agent.reason; return; }
  const r = await skillCall("skill/enable", { skillId: d.id });
  if (!r.ok) { marketNotice.value = t("添加到 Agent 失败（{code}）", { code: r.error }); return; }
  await loadMarketSkills();
  marketDetail.value = { ...d, added: true };
  marketNotice.value = t("已添加到 Agent");
}
/* ── 「最新上线 / 精选项目」的真实条目（catalog Apps ∪ 官方技能包 ∪ 模板） ── */
type MarketEntry = { kind: "skill" | "template" | "catalog-app"; id: string; name: string; summary: string; publishedAt: number; featured: boolean; category: string };
const marketEntries = computed<MarketEntry[]>(() => [
  ...officialSkillRows.value.filter((row) => row.publishedAt > 0).map<MarketEntry>((row) => ({ kind: "skill", id: row.id, name: row.name, summary: row.description, publishedAt: row.publishedAt, featured: row.featured, category: row.category })),
  ...marketTemplates.value.map<MarketEntry>((item) => ({ kind: "template", id: item.id, name: item.name, summary: item.summary, publishedAt: item.publishedAt, featured: item.featured, category: item.category })),
  ...marketCatalogApps.value.map<MarketEntry>((item) => ({ kind: "catalog-app", id: item.id, name: item.name, summary: item.summary || item.subtitle, publishedAt: item.publishedAt, featured: item.featured, category: item.category })),
]);
const latestEntries = computed<MarketEntry[]>(() => marketEntries.value.filter((entry) => entry.publishedAt > 0).sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 40));
const featuredRails = computed<{ id: string; title: string; items: MarketEntry[] }[]>(() => {
  const byId = new Map(marketEntries.value.map((entry) => [entry.id, entry]));
  const rails = catalogRails.value.map((rail) => ({ id: rail.id, title: rail.title, items: rail.itemIds.map((id) => byId.get(id)).filter(Boolean) as MarketEntry[] })).filter((rail) => rail.items.length);
  if (rails.length) return rails;
  const featured = marketEntries.value.filter((entry) => entry.featured).sort((a, b) => b.publishedAt - a.publishedAt);
  return featured.length ? [{ id: "featured", title: t("精选项目"), items: featured }] : [];
});
const latestVisible = computed(() => latestEntries.value.filter((entry) => matchesQuery(entry.name, entry.summary)));
const entryKindLabel = (kind: MarketEntry["kind"]): string => (kind === "skill" ? t("官方技能") : kind === "template" ? t("项目模板") : t("本地应用"));
const entryDate = (entry: MarketEntry): string => (entry.publishedAt ? new Date(entry.publishedAt).toLocaleDateString("zh-CN") : "");
function useTemplateById(id: string) {
  const item = marketTemplates.value.find((x) => x.id === id);
  if (item) void useTemplate(item);
}
async function copyTemplatePrompt(template: MarketTemplate) {
  marketNotice.value = (await copyToClipboard(template.prompt)) ? t("已复制「{name}」的提示词", { name: template.name }) : t("复制失败：剪贴板不可用");
}
function openMarketEntry(entry: MarketEntry) {
  if (entry.kind === "template") { const item = marketTemplates.value.find((x) => x.id === entry.id); if (item) openTemplateMarketDetail(item); return; }
  if (entry.kind === "skill") { const row = officialSkillRows.value.find((x) => x.id === entry.id); if (row) openSkillMarketDetail(row); return; }
  openCatalogAppDetail(entry.id);
}

/* ── 模板「立即体验」：canvas/create + 写首节点（提示词走既有画布桥） ── */
const DOMAIN_NODE_TYPE: Record<TemplateKind, string> = { text: "smart-text", image: "smart-image", video: "smart-video", audio: "smart-audio" };
const TEMPLATE_NODE_SIZE: Record<TemplateKind, [number, number]> = { text: [320, 220], image: [300, 300], video: [360, 220], audio: [320, 180] };
/** Vue 响应式代理不能过 IPC（structured clone）：跨桥前一律转纯对象。 */
function plainClone<T>(value: T): T {
  try { return JSON.parse(JSON.stringify(value)) as T; } catch { return value; }
}
/** 模板 doc 节点 → 画布服务端文档节点（type 走既有 DOMAIN 映射，提示词放 data.gen.prompt）。 */
function templateServerNode(node: TemplateDocNode, template: MarketTemplate): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: node.id,
    type: DOMAIN_NODE_TYPE[node.kind as TemplateKind] || "text",
    kind: node.kind,
    x: node.x, y: node.y, w: node.w, h: node.h,
    text: node.text || "",
  };
  // 表格节点的 type 是 "table"（与 DOMAIN_NODE_TYPE 的 smart-* 不同名）
  if (node.kind === "table") {
    out.type = "table";
    // catalog 文档来自响应式 ref：必须转成纯对象，否则 IPC structured clone 会抛 "could not be cloned"
    if (node.table) out.data = { table: plainClone(node.table) };
    return out;
  }
  const gen: Record<string, unknown> = { title: node.title || template.nodeTitle || template.name };
  const prompt = node.prompt || (node.kind === template.kind ? template.prompt : "");
  if (prompt) gen.prompt = prompt;
  if (node.params && Object.keys(node.params).length) gen.params = plainClone(node.params);
  out.data = { gen };
  return out;
}
async function useTemplate(template: MarketTemplate) {
  marketNotice.value = "";
  try {
    await applyTemplate(template);
  } catch (error) {
    const message = error && typeof error === "object" ? String((error as { message?: unknown }).message || error) : String(error);
    marketNotice.value = t("立即体验失败（{code}）", { code: message.slice(0, 120) });
  }
}
async function applyTemplate(template: MarketTemplate) {
  marketNotice.value = "";
  const api = (window as unknown as { openarc?: { canvas?: { command?: (command: Record<string, unknown>) => Promise<Record<string, any>> } } }).openarc?.canvas;
  if (!api || typeof api.command !== "function") { marketNotice.value = t("当前环境没有画布桥（只在 OpenArc 桌面应用里可用）"); return; }
  const created = await api.command({ type: "canvas/create", title: template.name }).catch(() => null);
  // canvas:command 的结果是 { ok:true, canvas }（ok() 直接展开负载，没有再包一层 value）
  const createdBox = created && typeof created === "object" ? (created as Record<string, unknown>) : {};
  const canvasRaw = createdBox.canvas || (createdBox.value && typeof createdBox.value === "object" ? (createdBox.value as Record<string, unknown>).canvas : null);
  const canvas = canvasRaw && typeof canvasRaw === "object" ? (canvasRaw as Record<string, unknown>) : null;
  const canvasId = canvas ? String(canvas.canvasId || "") : "";
  if (!canvasId) { marketNotice.value = t("创建画布失败（{code}）", { code: String((created && created.error) || "UNKNOWN") }); return; }
  // 模板带完整 doc → 一次铺完整工作流；没有 doc 才退回「只建首节点」。
  const doc = template.doc && template.doc.nodes.length ? template.doc : null;
  const nodes = doc ? doc.nodes.map((item) => templateServerNode(item, template)) : [templateServerNode({
    id: "n_" + Date.now().toString(36), kind: template.kind, x: 120, y: 120,
    w: (TEMPLATE_NODE_SIZE[template.kind] || TEMPLATE_NODE_SIZE.text)[0],
    h: (TEMPLATE_NODE_SIZE[template.kind] || TEMPLATE_NODE_SIZE.text)[1],
    title: template.nodeTitle || template.name, text: "", prompt: template.prompt,
  }, template)];
  const connections = doc ? doc.edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to })) : [];
  const saved = await api.command({
    type: "canvas/save", canvasId, baseRevision: null,
    doc: { nodes, connections, comments: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] },
  }).catch(() => null);
  if (!saved || saved.ok !== true) {
    marketNotice.value = t("画布已创建，但写入工作流失败（{code}）", { code: String((saved && saved.error) || "UNKNOWN") });
    return;
  }
  marketNotice.value = doc
    ? t("已创建画布「{name}」：{n} 个节点 / {m} 条连线，正在打开 AI Studio", { name: template.name, n: nodes.length, m: connections.length })
    : t("已创建画布「{name}」并写好首节点，正在打开 AI Studio", { name: template.name });
  shell.activateApp("canvas");
}
function detailTry() {
  const d = marketDetail.value;
  if (!d || !d.try.enabled) { if (d) marketNotice.value = d.try.reason; return; }
  if (d.kind === "template" && d.template) { void useTemplate(d.template); return; }
  if (!d.appId) { marketNotice.value = d.try.reason; return; }
  shell.activateApp(d.appId);
  closeMarketDetail();
}

const showHero = computed(() => view.value === "apps" && cat.value === "全部" && !normalizedQuery.value);
const isDiscover = computed(() => view.value === "apps" && cat.value === "全部");
const isCategory = (name: string) => view.value === "apps" && cat.value === name;

const detailName = computed(() => {
  const id = detail.value;
  if (!id) return "";
  const UPDATE_APP_NAME: Record<string, string> = { canvas: "无限画布" };
  return UPDATE_APP_NAME[id] || appById(id)?.name || id;
});

function switchView(next: View) {
  view.value = next;
  detail.value = null;
  if (next === "external") {
    if (!thirdLoaded.value && !thirdBusy.value) void loadThirdParty();
    if (!integrationLoaded.value && !integrationBusy.value) void loadIntegrations();
  }
  if (next === "health" && !healthRows.value.length && !healthBusy.value) void loadHealthRows();
}
function openDiscover() {
  cat.value = "全部";
  marketTab.value = "all";
  switchView("apps");
}
function openCategory(name: string) {
  cat.value = name;
  marketTab.value = "apps";
  switchView("apps");
}
function openDetail(id: string, upgrade = false) {
  detail.value = id;
  autoInstall.value = upgrade;
}
function closeDetail() {
  detail.value = null;
  autoInstall.value = false;
  void loadStatuses();
}
const inDock = (id: string) => shell.dockIds.includes(id);

watch(
  () => [motionOff.value, heroSlides.value.length] as const,
  () => {
    heroIndex.value = 0;
    startHeroTimer();
  },
);

onMounted(() => {
  motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  systemMotionReduced.value = motionQuery.matches;
  motionQuery.addEventListener("change", onMotionChange);
  startHeroTimer();
  void loadStatuses();
  void loadIntegrations();
  void loadMarketSkills();
  void loadMarketCatalog();
});
onBeforeUnmount(() => {
  stopHeroTimer();
  if (motionQuery) motionQuery.removeEventListener("change", onMotionChange);
});
</script>

<template>
  <div class="split market-app">
    <nav class="split-side mk-side" :aria-label="t('应用市场')">
      <button
        type="button"
        class="split-nav mk-nav"
        :aria-current="isDiscover ? 'page' : undefined"
        data-market-view="apps"
        @click="openDiscover()"
      >
        <Compass :size="16" :stroke-width="1.5" />
        <span class="split-nav-label">{{ t("发现") }}</span>
      </button>
      <button
        v-for="c in CATEGORIES"
        :key="c"
        type="button"
        class="split-nav mk-nav"
        :aria-current="isCategory(c) ? 'page' : undefined"
        :data-market-cat="c"
        @click="openCategory(c)"
      >
        <component :is="CAT_ICON[c]" :size="16" :stroke-width="1.5" />
        <span class="split-nav-label">{{ t(c) }}</span>
      </button>
      <button
        type="button"
        class="split-nav mk-nav"
        :aria-current="view === 'external' ? 'page' : undefined"
        data-market-view="external"
        @click="switchView('external')"
      >
        <Package :size="16" :stroke-width="1.5" />
        <span class="split-nav-label">{{ t("外部应用") }}</span>
        <small v-if="installedApps.length" class="mk-nav-count" data-market-external-count>{{ installedApps.length }}</small>
      </button>
      <button
        type="button"
        class="split-nav mk-nav"
        :aria-current="view === 'updates' || view === 'health' ? 'page' : undefined"
        data-market-view="updates"
        @click="switchView('updates')"
      >
        <ArrowDownCircle :size="16" :stroke-width="1.5" />
        <span class="split-nav-label">{{ t("更新") }}</span>
        <small v-if="upgradable.length" class="mk-nav-count mk-nav-count--strong" data-market-update-count>{{ upgradable.length }}</small>
      </button>
    </nav>

    <div class="split-main market-main">
      <CanvasUpdatePanel
        v-if="detail"
        :key="detail"
        :app-id="detail"
        :app-name="detailName"
        :auto-install="autoInstall"
        @back="closeDetail"
      />
      <div v-else :key="view + '|' + cat" class="mk-view">
        <header class="mk-bar">
          <h1 class="mk-title" data-market-title>{{ pageTitle }}</h1>
          <span class="mk-sub" data-market-sub>{{ pageSub }}</span>
          <span class="toolbar-spacer" />
          <label class="ds-search mk-search">
            <Search class="ds-search__icon" :size="13" />
            <input v-model="query" class="ds-search__input" type="search" :placeholder="t('搜索应用')" :aria-label="t('搜索应用')" @keydown.esc="query = ''" />
          </label>
          <DsButton
            v-if="view === 'updates'"
            size="sm"
            variant="secondary"
            data-market-refresh-status
            :status="statusBusy ? 'loading' : 'idle'"
            :disabled="statusBusy"
            @click="loadStatuses"
          >
            <RefreshCw :size="13" :stroke-width="1.5" /> {{ t("刷新") }}
          </DsButton>
          <DsButton
            v-if="view === 'health'"
            size="sm"
            variant="secondary"
            data-health-refresh
            :status="healthBusy ? 'loading' : 'idle'"
            :disabled="healthBusy"
            @click="loadHealthRows"
          >
            <RefreshCw :size="13" :stroke-width="1.5" /> {{ t("重新检查") }}
          </DsButton>
        </header>

        <nav v-if="view === 'apps'" class="mk-tabs" role="tablist" :aria-label="t('应用市场分类')" data-market-tabs>
          <button
            v-for="tb in MARKET_TABS"
            :key="tb.id"
            type="button"
            role="tab"
            class="mk-tab"
            :class="{ on: marketTab === tb.id }"
            :aria-selected="marketTab === tb.id"
            :data-market-tab="tb.id"
            @click="marketTab = tb.id"
          >{{ t(tb.label) }}</button>
        </nav>

        <template v-if="view === 'apps'">
          <section
            v-if="showHero && marketTab === 'all'"
            class="mk-hero"
            data-market-hero
            :data-market-hero-index="Math.min(heroIndex, heroSlides.length - 1)"
          >
            <Transition name="mk-hero-fade">
              <button v-if="heroSlide" :key="heroSlide.key" type="button" class="mk-hero-slide" :aria-label="heroSlide.title" @click="goHero(heroSlide)">
                <img class="mk-hero-mark" :src="heroMarkIcon" alt="" aria-hidden="true" draggable="false" />
                <span class="mk-hero-eyebrow">{{ heroSlide.eyebrow }}</span>
                <strong class="mk-hero-title">{{ heroSlide.title }}</strong>
                <span v-if="heroSlide.note" class="mk-hero-note">{{ heroSlide.note }}</span>
              </button>
            </Transition>
            <div v-if="heroSlides.length > 1" class="mk-hero-dots">
              <button
                v-for="(slide, index) in heroSlides"
                :key="slide.key"
                type="button"
                class="mk-hero-dot"
                :class="{ on: index === Math.min(heroIndex, heroSlides.length - 1) }"
                :aria-label="t('第 {n} 屏：{title}', { n: index + 1, title: slide.title })"
                :aria-current="index === Math.min(heroIndex, heroSlides.length - 1) ? 'true' : undefined"
                data-market-hero-dot
                :data-market-hero-dot-index="index"
                @click.stop="heroIndex = index"
              />
            </div>
          </section>

          <section v-if="marketTab === 'all' || marketTab === 'apps'" class="mk-section">
            <header class="mk-section-head">
              <h2>{{ normalizedQuery ? t("搜索结果") : cat === "全部" ? t("应用") : t(cat) }}</h2>
            </header>
            <div v-if="apps.length" class="mk-grid" data-market-apps>
              <article
                v-for="a in apps"
                :key="a.id"
                class="mk-card"
                :data-app-card="a.id"
                :data-app-version="a.version"
                :data-app-update-current="statusCurrent(a.id)"
                :data-app-update-latest="statusLatest(a.id)"
                :data-app-update-checked="statusChecked(a.id)"
                :data-app-loadable="statuses[a.id] ? (statuses[a.id]!.loadable ? '1' : '0') : ''"
                :data-app-load-url="statuses[a.id]?.loadUrl || ''"
                :data-market-app-catalog="a.catalog ? '1' : '0'"
                :data-market-app-published="a.catalog ? (a.catalog.publishedAt || '') : ''"
                :data-market-app-featured="a.catalog && a.catalog.featured ? '1' : '0'"
              >
                <button
                  type="button"
                  class="mk-card-main"
                  :data-app-update-open="a.id"
                  :data-canvas-update-open="a.id === 'canvas' ? a.id : undefined"
                  :data-app-update-upgrade="card(a).canUpgrade ? 'true' : 'false'"
                  :title="t('版本与更新')"
                  @click="openDetail(a.id, card(a).canUpgrade)"
                >
                  <img class="mk-card-icon" :src="iconUrl(a.icon)" alt="" draggable="false" />
                  <span class="mk-card-text">
                    <span class="mk-card-name">{{ a.name }}</span>
                    <span class="mk-card-desc">{{ (a.catalog && a.catalog.summary) || descOf(a) }}</span>
                    <span class="mk-card-meta" :data-app-update-detail="a.id">v{{ a.version }} · {{ card(a).badge }}</span>
                    <span class="mk-card-meta mk-card-meta--added" :data-market-app-added="a.id">{{ t("已添加") }}<template v-if="a.catalog && a.catalog.publishedAt"> · {{ new Date(a.catalog.publishedAt).toLocaleDateString("zh-CN") }}</template><template v-if="a.catalog && a.catalog.featured"> · {{ t("精选") }}</template></span>
                  </span>
                </button>
                <div class="mk-card-actions">
                  <button
                    v-if="card(a).canUpgrade"
                    type="button"
                    class="mk-pill"
                    :data-market-update-action="a.id"
                    @click="openDetail(a.id, true)"
                  >{{ t("更新") }}</button>
                  <button
                    v-else
                    type="button"
                    class="mk-pill mk-pill--primary"
                    :data-app-open="a.id"
                    @click="shell.activateApp(a.id)"
                  >{{ t("开始使用") }}</button>
                  <button
                    type="button"
                    class="mk-pill"
                    :data-market-app-detail="a.id"
                    @click="openAppMarketDetail(a.id)"
                  >{{ t("详情") }}</button>
                  <button
                    v-if="a.id !== 'trash'"
                    type="button"
                    class="mk-pin"
                    :aria-pressed="inDock(a.id)"
                    :aria-label="inDock(a.id) ? t('从程序坞移除') : t('添加到程序坞')"
                    :title="inDock(a.id) ? t('从程序坞移除') : t('添加到程序坞')"
                    @click="shell.toggleDock(a.id)"
                  >
                    <PinOff v-if="inDock(a.id)" :size="13" :stroke-width="1.5" />
                    <Pin v-else :size="13" :stroke-width="1.5" />
                  </button>
                </div>
              </article>
            </div>
            <DsPageState
              v-else
              kind="empty"
              :title="normalizedQuery ? t('没有找到匹配的应用') : t('这个分类还没有应用')"
              :description="normalizedQuery ? t('换一个关键词试试，或清空左侧搜索框。') : t('分类来自应用注册表；这个分类目前没有任何应用。')"
            />
          </section>

          <section v-if="marketTab === 'all' || marketTab === 'official'" class="mk-section" data-market-skills-section>
            <header class="mk-section-head">
              <h2>{{ t("官方技能") }}</h2>
              <span class="mk-section-note">{{ t("来自本地技能定义（origin=official）与本地市场清单（resources/market/catalog.json）。技能不安装代码：可以复制提示词、在对话里试用，或添加到 Agent。") }}</span>
              <span class="mk-section-count" data-market-skill-count>{{ officialSkills.length }}</span>
            </header>
            <p v-if="skillsError" class="mk-error" role="alert" :data-market-skill-error="skillsError.code">
              {{ t("技能清单读取失败（{code}）", { code: skillsError.code }) }}<span v-if="skillsError.detail">：{{ skillsError.detail }}</span>
            </p>
            <p v-else-if="!skillsLoaded" class="mk-cap" role="status">{{ t("正在读取本地技能…") }}</p>
            <div v-else-if="visibleOfficialSkills.length" class="mk-grid" data-market-skills>
              <article
                v-for="s in visibleOfficialSkills"
                :key="s.id"
                class="mk-card"
                :data-market-skill="s.id"
                :data-market-skill-enabled="s.enabled === false ? '0' : '1'"
                :data-market-skill-added="s.enabled ? '1' : '0'"
                :data-market-skill-published="s.publishedAt || ''"
                :data-market-skill-featured="s.featured ? '1' : '0'"
              >
                <button type="button" class="mk-card-main" :data-market-skill-open="s.id" @click="openSkillMarketDetail(s)">
                  <span class="mk-card-tile mk-card-tile--skill"><Sparkles :size="16" :stroke-width="1.5" /></span>
                  <span class="mk-card-text">
                    <span class="mk-card-name">{{ s.name || s.id }}</span>
                    <span class="mk-card-desc">{{ s.description || t("没有描述") }}</span>
                    <span class="mk-card-meta">{{ s.enabled ? t("已添加") : t("未添加") }}<template v-if="s.publishedAt"> · {{ new Date(s.publishedAt).toLocaleDateString("zh-CN") }}</template><template v-if="s.featured"> · {{ t("精选") }}</template></span>
                  </span>
                </button>
                <div class="mk-card-actions">
                  <button type="button" class="mk-pill mk-pill--primary" :data-market-skill-use="s.id" @click="openSkillMarketDetail(s)">{{ t("开始使用") }}</button>
                </div>
              </article>
            </div>
            <DsPageState
              v-else
              kind="empty"
              :title="t('本地没有官方技能')"
              :description="t('技能域这次返回的清单里没有 origin=official 的技能（来源：skill/list，本地技能定义）。')"
            />
          </section>

          <section v-if="marketTab === 'all'" class="mk-section" data-market-templates-section>
            <header class="mk-section-head">
              <h2>{{ t("项目模板") }}</h2>
              <span class="mk-section-note">{{ t("来自本地市场清单的 6 条画布 starter flow；「立即体验」会新建画布并写好首节点提示词。") }}</span>
              <span class="mk-section-count" data-market-template-count>{{ marketTemplates.length }}</span>
            </header>
            <p v-if="catalogError" class="mk-error" role="alert" :data-market-catalog-error="catalogError.code">
              {{ t("本地市场清单读取失败（{code}）", { code: catalogError.code }) }}<span v-if="catalogError.detail">：{{ catalogError.detail }}</span>
            </p>
            <div v-else-if="marketTemplates.length" class="mk-grid" data-market-templates>
              <article
                v-for="tpl in marketTemplates"
                :key="tpl.id"
                class="mk-card"
                :data-market-template="tpl.id"
                :data-market-template-kind="tpl.kind"
                :data-market-template-featured="tpl.featured ? '1' : '0'"
                :data-market-template-published="tpl.publishedAt || ''"
                :data-market-template-doc="tpl.doc ? tpl.doc.nodes.length + '/' + tpl.doc.edges.length : ''"
              >
                <button type="button" class="mk-card-main" :data-market-template-open="tpl.id" @click="openTemplateMarketDetail(tpl)">
                  <span class="mk-card-tile"><LayoutGrid :size="16" :stroke-width="1.5" /></span>
                  <span class="mk-card-text">
                    <span class="mk-card-name">{{ tpl.name }}</span>
                    <span class="mk-card-desc">{{ tpl.summary || t("没有描述") }}</span>
                    <span class="mk-card-meta"><template v-if="tpl.doc">{{ tpl.doc.nodes.length }} {{ t("个节点") }} · {{ tpl.doc.edges.length }} {{ t("条连线") }}</template><template v-else>{{ tpl.steps.length }} {{ t("步") }}</template><template v-if="tpl.category"> · {{ categoryNameOf(tpl.category) }}</template><template v-if="tpl.publishedAt"> · {{ new Date(tpl.publishedAt).toLocaleDateString("zh-CN") }}</template></span>
                  </span>
                </button>
                <div class="mk-card-actions">
                  <button type="button" class="mk-pill mk-pill--primary" :data-market-template-use="tpl.id" @click="useTemplate(tpl)">{{ t("立即体验") }}</button>
                  <button type="button" class="mk-pill" :data-market-template-copy="tpl.id" @click="copyTemplatePrompt(tpl)">{{ t("复制提示词") }}</button>
                </div>
              </article>
            </div>
            <p v-else-if="!catalogLoaded" class="mk-cap" role="status">{{ t("正在读取本地市场清单…") }}</p>
            <DsPageState v-else kind="empty" :title="t('本地没有项目模板')" :description="t('随包的 resources/market/catalog.json 里没有 templates 条目。')" />
          </section>

          <section v-if="marketTab === 'new'" class="mk-section" data-market-new-section>
            <header class="mk-section-head">
              <h2>{{ t("最新上线") }}</h2>
              <span class="mk-section-note">{{ t("来源：本地市场清单的 publishedAt（技能包 / 模板 / 本地 App），按时间倒序。") }}</span>
              <span class="mk-section-count" data-market-latest-count>{{ latestVisible.length }}</span>
            </header>
            <p v-if="catalogError" class="mk-error" role="alert" :data-market-catalog-error="catalogError.code">{{ t("本地市场清单读取失败（{code}）", { code: catalogError.code }) }}</p>
            <div v-else-if="latestVisible.length" class="mk-grid" data-market-latest>
              <article
                v-for="entry in latestVisible"
                :key="entry.kind + ':' + entry.id"
                class="mk-card"
                :data-market-entry="entry.kind + ':' + entry.id"
                :data-market-entry-kind="entry.kind"
                :data-market-entry-published="entry.publishedAt"
              >
                <button type="button" class="mk-card-main" :data-market-entry-open="entry.kind + ':' + entry.id" @click="openMarketEntry(entry)">
                  <span class="mk-card-tile"><component :is="entry.kind === 'skill' ? Sparkles : LayoutGrid" :size="16" :stroke-width="1.5" /></span>
                  <span class="mk-card-text">
                    <span class="mk-card-name">{{ entry.name }}</span>
                    <span class="mk-card-desc">{{ entry.summary || t("没有描述") }}</span>
                    <span class="mk-card-meta">{{ entryKindLabel(entry.kind) }} · {{ entryDate(entry) }}</span>
                  </span>
                </button>
                <div class="mk-card-actions">
                  <button v-if="entry.kind === 'template'" type="button" class="mk-pill mk-pill--primary" :data-market-entry-use="entry.id" @click="useTemplateById(entry.id)">{{ t("立即体验") }}</button>
                  <button v-else type="button" class="mk-pill" :data-market-entry-detail="entry.kind + ':' + entry.id" @click="openMarketEntry(entry)">{{ t("详情") }}</button>
                </div>
              </article>
            </div>
            <DsPageState v-else kind="empty" :title="t('本地没有「最新上线」条目')" :description="t('随包 catalog.json 里没有带 publishedAt 的技能包 / 模板 / 本地 App。')" />
          </section>

          <section v-if="marketTab === 'featured'" class="mk-section" data-market-featured-section>
            <header class="mk-section-head">
              <h2>{{ t("精选项目") }}</h2>
              <span class="mk-section-note">{{ t("来源：本地市场清单的 railPages（精选 rails）；没有 rails 时退回 featured 条目。") }}</span>
            </header>
            <template v-if="featuredRails.length">
              <div v-for="rail in featuredRails" :key="rail.id" class="mk-section" :data-market-rail="rail.id">
                <header class="mk-section-head">
                  <h2>{{ rail.title }}</h2>
                  <span class="mk-section-count">{{ rail.items.length }}</span>
                </header>
                <div class="mk-grid" data-market-rail-items>
                  <article
                    v-for="entry in rail.items"
                    :key="rail.id + ':' + entry.id"
                    class="mk-card"
                    :data-market-entry="entry.kind + ':' + entry.id"
                    :data-market-entry-kind="entry.kind"
                  >
                    <button type="button" class="mk-card-main" :data-market-entry-open="entry.kind + ':' + entry.id" @click="openMarketEntry(entry)">
                      <span class="mk-card-tile"><component :is="entry.kind === 'skill' ? Sparkles : LayoutGrid" :size="16" :stroke-width="1.5" /></span>
                      <span class="mk-card-text">
                        <span class="mk-card-name">{{ entry.name }}</span>
                        <span class="mk-card-desc">{{ entry.summary || t("没有描述") }}</span>
                        <span class="mk-card-meta">{{ entryKindLabel(entry.kind) }}<template v-if="entry.publishedAt"> · {{ entryDate(entry) }}</template></span>
                      </span>
                    </button>
                    <div class="mk-card-actions">
                      <button v-if="entry.kind === 'template'" type="button" class="mk-pill mk-pill--primary" :data-market-entry-use="entry.id" @click="useTemplateById(entry.id)">{{ t("立即体验") }}</button>
                      <button v-else type="button" class="mk-pill" :data-market-entry-detail="entry.kind + ':' + entry.id" @click="openMarketEntry(entry)">{{ t("详情") }}</button>
                    </div>
                  </article>
                </div>
              </div>
            </template>
            <DsPageState v-else kind="empty" :title="t('本地没有精选项目')" :description="t('随包 catalog.json 里没有 railPages / featured 条目。')" />
          </section>

          <section v-if="cat === '全部' && !normalizedQuery && marketTab === 'all'" class="mk-section">
            <header class="mk-section-head">
              <h2>{{ t("外部应用") }}</h2>
              <span class="mk-section-note">{{ t("状态来自集成插件的依赖与凭据检查。") }}</span>
              <button type="button" class="mk-link" data-market-external-more @click="switchView('external')">
                {{ t("查看全部") }}<ChevronRight :size="13" :stroke-width="1.5" />
              </button>
            </header>
            <p v-if="integrationError" class="mk-error" role="alert" :data-market-integration-error="integrationError.code">
              {{ integrationErrorText(integrationError.code) }}<span v-if="integrationError.detail">：{{ integrationError.detail }}</span>
            </p>
            <div v-else-if="discoverExternal.length" class="mk-grid" data-market-external>
              <article
                v-for="plugin in discoverExternal"
                :key="plugin.id"
                class="mk-card"
                :data-market-external="plugin.id"
                :data-market-external-state="externalStateOf(plugin)"
              >
                <div class="mk-card-tile">{{ monogram(plugin.name) }}</div>
                <div class="mk-card-text">
                  <span class="mk-card-name">{{ plugin.name }}</span>
                  <span class="mk-card-meta mk-card-meta--wrap">{{ externalStateTextOf(plugin) }}</span>
                </div>
                <div class="mk-card-actions">
                  <button
                    type="button"
                    class="mk-pill"
                    :class="{ 'mk-pill--primary': externalStateOf(plugin) === 'open' }"
                    :data-market-external-action="plugin.id"
                    :disabled="integrationBusy === 'enable:' + plugin.id"
                    @click="externalAction(plugin)"
                  >{{ t(EXTERNAL_PILL[externalStateOf(plugin)]) }}</button>
                </div>
              </article>
            </div>
            <p v-else-if="integrationBusy === 'list'" class="mk-cap" role="status">{{ t("正在读取集成插件…") }}</p>
            <DsPageState v-else kind="empty" title="没有登记任何集成插件" description="主进程的集成目录为空；登记可选插件后这里会出现。" />
          </section>
        </template>

        <template v-else-if="view === 'external'">
          <section class="mk-section" data-market-integration-section>
            <header class="mk-section-head">
              <h2>{{ t("集成服务") }}</h2>
              <span class="mk-section-count">{{ t("{enabled} / {total} 已启用", { enabled: enabledIntegrationCount, total: integrationPlugins.length }) }}</span>
              <span class="toolbar-spacer" />
              <DsButton
                size="sm"
                variant="secondary"
                data-market-integration-refresh
                :status="integrationBusy === 'list' ? 'loading' : 'idle'"
                :disabled="integrationBusy === 'list'"
                @click="loadIntegrations"
              >
                <RefreshCw :size="13" :stroke-width="1.5" /> {{ t("刷新") }}
              </DsButton>
            </header>
            <p class="mk-cap">{{ t("安装插件 = 未启用；连接 = 已启用但缺依赖或凭据；打开 = 已启用且依赖就绪。连接与打开都会跳到「第三方集成」应用。") }}</p>
            <p v-if="integrationError" class="mk-error" role="alert" :data-market-integration-error="integrationError.code">
              {{ integrationErrorText(integrationError.code) }}<span v-if="integrationError.detail">：{{ integrationError.detail }}</span>
            </p>
            <p v-if="externalError" class="mk-error" role="alert" :data-market-external-error="externalError.code">
              {{ integrationErrorText(externalError.code) }}<span v-if="externalError.detail">：{{ externalError.detail }}</span><code class="mk-code">{{ externalError.code }}</code>
            </p>
            <div v-if="externalPlugins.length" class="mk-grid" data-market-external>
              <article
                v-for="plugin in externalPlugins"
                :key="plugin.id"
                class="mk-card"
                :data-market-external="plugin.id"
                :data-market-external-state="externalStateOf(plugin)"
                :data-market-external-status="plugin.status"
              >
                <div class="mk-card-tile">{{ monogram(plugin.name) }}</div>
                <div class="mk-card-text">
                  <span class="mk-card-name">{{ plugin.name }}</span>
                  <span class="mk-card-desc">{{ plugin.description || t("没有描述") }}</span>
                  <span class="mk-card-meta mk-card-meta--wrap">{{ externalStateTextOf(plugin) }}</span>
                </div>
                <div class="mk-card-actions">
                  <button
                    type="button"
                    class="mk-pill"
                    :class="{ 'mk-pill--primary': externalStateOf(plugin) === 'open' }"
                    :data-market-external-action="plugin.id"
                    :aria-busy="integrationBusy === 'enable:' + plugin.id ? 'true' : undefined"
                    :disabled="integrationBusy === 'enable:' + plugin.id"
                    @click="externalAction(plugin)"
                  >
                    <span v-if="integrationBusy === 'enable:' + plugin.id" class="mk-ring" aria-hidden="true">
                      <svg viewBox="0 0 16 16"><circle class="mk-ring-track" cx="8" cy="8" r="6" /><circle class="mk-ring-arc" cx="8" cy="8" r="6" /></svg>
                    </span>
                    <template v-else>{{ t(EXTERNAL_PILL[externalStateOf(plugin)]) }}</template>
                  </button>
                </div>
              </article>
            </div>
            <p v-else-if="integrationBusy === 'list'" class="mk-cap" role="status">{{ t("正在读取集成插件…") }}</p>
            <DsPageState
              v-else-if="!integrationError"
              kind="empty"
              :title="normalizedQuery ? t('没有找到匹配的集成服务') : t('没有登记任何集成插件')"
              :description="normalizedQuery ? t('清空左侧搜索框可以看全部集成服务。') : t('主进程的集成目录为空；登记可选插件后这里会出现。')"
            />
          </section>

          <section class="mk-section" data-third-section>
            <header class="mk-section-head">
              <h2>{{ t("第三方应用") }}</h2>
              <span class="mk-section-count" data-third-count>{{ t("{n} 个目录条目", { n: localApps.length + onlineApps.length }) }}</span>
              <span class="mk-section-count" data-third-installed-count>{{ t("{n} 已安装", { n: installedApps.length }) }}</span>
              <span class="toolbar-spacer" />
              <DsButton
                size="sm"
                variant="secondary"
                data-third-refresh
                :status="thirdBusy === 'list' ? 'loading' : 'idle'"
                :disabled="!!thirdBusy"
                @click="loadThirdParty"
              >
                <RefreshCw :size="13" :stroke-width="1.5" /> {{ t("刷新") }}
              </DsButton>
            </header>
            <p class="mk-cap" data-third-load-support>{{ t("安装前会校验签名与完整性；校验不通过的安装包不会被安装。") }}</p>
            <p class="mk-cap" data-third-local-state>
              {{ localStateText }} · <template v-if="thirdList?.online.configured">{{ onlineStateText || t("在线目录读取失败") }}</template><template v-else>{{ t("未设置在线目录（只读取本地目录）。") }}</template>
            </p>
            <p v-if="thirdNotice" class="mk-notice" role="status" data-third-notice>{{ thirdNotice }}</p>
            <p v-if="thirdActionError" class="mk-error" role="alert" :data-third-action-error="thirdActionError?.code">
              {{ thirdErrorText(thirdActionError?.code || "") }}<span v-if="thirdActionError?.detail">：{{ thirdActionError?.detail }}</span><code class="mk-code">{{ thirdActionError?.code }}</code>
            </p>
            <p v-if="thirdListError" class="mk-error" role="alert" :data-third-list-error="thirdListError?.code">
              {{ thirdErrorText(thirdListError?.code || "") }}<span v-if="thirdListError?.detail">：{{ thirdListError?.detail }}</span><code class="mk-code">{{ thirdListError?.code }}</code>
            </p>
            <p v-if="thirdList?.local.error" class="mk-error" role="alert" :data-third-local-error="thirdList?.local.error">
              {{ thirdErrorText(thirdList?.local.error || "") }}<span v-if="thirdList?.local.detail">：{{ thirdList?.local.detail }}</span><code class="mk-code">{{ thirdList?.local.error }}</code>
            </p>
            <p v-if="thirdList?.online.error" class="mk-error" role="alert" :data-third-online-error="thirdList?.online.error">
              {{ thirdErrorText(thirdList?.online.error || "") }}<span v-if="thirdList?.online.detail">：{{ thirdList?.online.detail }}</span><code class="mk-code">{{ thirdList?.online.error }}</code>
            </p>
            <div v-if="catalogApps.length" class="mk-grid" data-third-local-list>
              <article
                v-for="app in catalogApps"
                :key="app.source + '-' + app.id"
                class="mk-card"
                :data-third-app="app.id"
                :data-third-app-source="app.source"
              >
                <div class="mk-card-tile"><Package :size="18" :stroke-width="1.5" /></div>
                <div class="mk-card-text">
                  <span class="mk-card-name">{{ app.name }}<small class="mk-tag">v{{ app.version }}</small></span>
                  <span class="mk-card-desc">{{ app.description || t("没有描述") }}</span>
                  <span
                    class="mk-card-meta mk-card-meta--wrap"
                    :data-third-package="app.id"
                    :data-third-compat="app.id"
                    :data-third-compat-ok="compatibilityOf(app).ok ? '1' : '0'"
                    :data-third-signature="app.id"
                  >{{ packageText(app) }} · sha256 {{ shaShort(app) }} · {{ compatibilityOf(app).text }}</span>
                </div>
                <div class="mk-card-actions">
                  <button
                    type="button"
                    class="mk-pill"
                    :data-third-install="app.id"
                    :aria-busy="thirdBusy === 'install:' + app.id ? 'true' : undefined"
                    :disabled="!!thirdBusy || !compatibilityOf(app).ok"
                    @click="askInstall(app)"
                  >
                    <span v-if="thirdBusy === 'install:' + app.id" class="mk-ring" aria-hidden="true">
                      <svg viewBox="0 0 16 16"><circle class="mk-ring-track" cx="8" cy="8" r="6" /><circle class="mk-ring-arc" cx="8" cy="8" r="6" /></svg>
                    </span>
                    <template v-else>{{ installedOf(app.id)?.version === app.version ? t("重新安装") : t("获取") }}</template>
                  </button>
                </div>
              </article>
            </div>
            <p v-else-if="thirdBusy === 'list'" class="mk-cap" role="status">{{ t("正在读取第三方目录…") }}</p>
            <DsPageState
              v-else-if="thirdList"
              kind="empty"
              :title="normalizedQuery ? t('没有找到匹配的第三方应用') : t('没有可安装的第三方应用')"
              :description="normalizedQuery ? t('清空左侧搜索框可以看全部目录条目。') : thirdList.local.present ? t('本地目录里没有条目，在线目录也没有可安装的应用。') : t('本机没有 third-party.json，也没有设置在线目录。')"
            />

            <details v-if="installedApps.length" class="mk-details" data-third-installed data-third-installed-section>
              <summary>{{ t("已安装的第三方应用（{n}）", { n: installedApps.length }) }}</summary>
              <div class="mk-details-body">
                <div v-for="item in installedApps" :key="item.id" class="mk-row" :data-third-installed-app="item.id">
                  <div class="mk-row-text">
                    <b>{{ item.name || item.id }}<small class="mk-tag">{{ item.version || "—" }}</small></b>
                    <span>
                      id {{ item.id }} · {{ t("状态") }} {{ item.status }} · {{ t("来源") }} {{ item.source || "—" }} · {{ t("生效") }} {{ item.effectiveSource === "installed" ? t("已安装版本") : t("随包内置版本") }}<template v-if="item.installedAt"> · {{ t("安装于 {time}", { time: formatTimestamp(item.installedAt) }) }}</template>
                    </span>
                    <span :data-third-health="item.id">
                      {{ installedHealthText(item.id) }}<template v-if="thirdHealth[item.id]?.fallbackReason"> · {{ t("回退原因") }} {{ healthFallbackText(thirdHealth[item.id]?.fallbackReason) }}</template><template v-if="thirdHealth[item.id]?.loadUrl"> · {{ t("加载地址") }} <code class="mk-code">{{ thirdHealth[item.id]?.loadUrl }}</code></template>
                    </span>
                  </div>
                  <div class="mk-card-actions">
                    <DsButton
                      size="sm"
                      variant="secondary"
                      :data-third-rollback="item.id"
                      :status="thirdBusy === 'rollback:' + item.id ? 'loading' : 'idle'"
                      :disabled="!!thirdBusy"
                      @click="askRollback(item)"
                    >
                      <RotateCcw :size="13" :stroke-width="1.5" /> {{ t("回滚") }}
                    </DsButton>
                  </div>
                </div>
              </div>
            </details>
            <p v-else-if="thirdList" class="mk-cap" data-third-installed-empty>{{ t("还没有通过第三方目录安装的应用。") }}</p>

            <details class="mk-details" data-third-source>
              <summary>
                {{ t("在线目录来源") }}
                <span class="mk-details-state" data-third-source-current>{{ thirdSourceUrl || t("未设置（只读取本地目录）") }}</span>
              </summary>
              <div class="mk-details-body">
                <div class="mk-source-row">
                  <input
                    v-model="thirdSourceDraft"
                    class="mk-input"
                    type="url"
                    :placeholder="t('https://（白名单主机的在线目录 JSON；留空只用本地目录）')"
                    :aria-label="t('在线目录地址')"
                    data-third-source-input
                  />
                  <DsButton size="sm" variant="secondary" data-third-source-save :status="thirdBusy === 'source' ? 'loading' : 'idle'" :disabled="!!thirdBusy" @click="saveThirdSource">{{ t("保存来源") }}</DsButton>
                  <DsButton size="sm" variant="ghost" data-third-source-clear :disabled="!!thirdBusy" @click="thirdSourceDraft = ''; saveThirdSource()">{{ t("清除") }}</DsButton>
                </div>
                <p class="mk-cap">{{ t("只允许 HTTPS + 白名单主机；在线目录读取失败不影响本地目录与已安装列表。") }}</p>
                <p v-if="thirdSourceError" class="mk-error" role="alert" :data-third-source-error="thirdSourceError?.code">
                  {{ thirdErrorText(thirdSourceError?.code || "") }}<span v-if="thirdSourceError?.detail">：{{ thirdSourceError?.detail }}</span><code class="mk-code">{{ thirdSourceError?.code }}</code>
                </p>
              </div>
            </details>

            <details v-if="rejectedEntries.length" class="mk-details" data-third-rejected>
              <summary>{{ t("目录中被拒绝的条目（{n}）", { n: rejectedEntries.length }) }}</summary>
              <div class="mk-details-body">
                <p class="mk-cap">{{ t("这些条目没有通过目录校验，不会出现在可安装列表里（逐条如实列出原因）。") }}</p>
                <ul class="mk-rejected">
                  <li v-for="(item, index) in rejectedEntries" :key="index"><code class="mk-code">{{ item.id || t("<无 id>") }}</code> — {{ item.reason }}</li>
                </ul>
              </div>
            </details>
          </section>
        </template>

        <template v-else-if="view === 'updates'">
          <section class="mk-section">
            <header class="mk-section-head">
              <h2>{{ t("可用更新") }}</h2>
              <span class="mk-section-count">{{ updatableList.length }}</span>
            </header>
            <div v-if="updatableList.length" class="mk-list" data-market-updates>
              <div v-for="a in updatableList" :key="a.id" class="mk-row" :data-market-update="a.id">
                <img class="mk-row-icon" :src="iconUrl(a.icon)" alt="" draggable="false" />
                <div class="mk-row-text">
                  <b>{{ a.name }}</b>
                  <span>{{ card(a).detail }}</span>
                </div>
                <button type="button" class="mk-pill mk-pill--primary" :data-market-update-action="a.id" @click="openDetail(a.id, true)">{{ t("更新") }}</button>
              </div>
            </div>
            <DsPageState
              v-else
              kind="empty"
              :title="normalizedQuery ? t('没有匹配的可用更新') : t('所有应用都是最新版本')"
              :description="normalizedQuery ? t('清空左侧搜索框可以看全部应用。') : t('更新状态只读本机记录；检查更新在「版本与更新」里由你手动触发。')"
            />
          </section>
          <section class="mk-section">
            <header class="mk-section-head">
              <h2>{{ t("已安装") }}</h2>
              <span class="mk-section-count">{{ upToDateList.length }}</span>
            </header>
            <div class="mk-list" data-market-installed>
              <div v-for="a in upToDateList" :key="a.id" class="mk-row" :data-market-installed-app="a.id">
                <img class="mk-row-icon" :src="iconUrl(a.icon)" alt="" draggable="false" />
                <div class="mk-row-text">
                  <b>{{ a.name }}</b>
                  <span>{{ card(a).detail }}</span>
                </div>
                <button type="button" class="mk-link" :data-market-update-open="a.id" @click="openDetail(a.id, false)">{{ t("版本与更新") }}</button>
              </div>
            </div>
          </section>
          <button type="button" class="mk-health-link" data-market-health-open @click="switchView('health')">
            <LayoutGrid :size="13" :stroke-width="1.5" />
            <span>{{ t("查看各应用的加载状态") }}</span>
            <ChevronRight :size="13" :stroke-width="1.5" />
          </button>
        </template>

        <template v-else>
          <section class="mk-section">
            <p class="mk-cap">{{ t("每个应用当前实际使用的版本，以及没有使用新版本的原因。只读本机记录，不联网。") }}</p>
            <div class="mk-group" data-health-list>
              <div
                v-for="row in healthRowsFiltered"
                :key="row.app.id"
                class="mk-row"
                :data-health-app="row.app.id"
                :data-health-source="row.health ? row.health.effectiveSource : ''"
                :data-health-loadable="row.health ? (row.health.installedLoadable ? '1' : '0') : ''"
              >
                <div class="mk-row-text">
                  <b>{{ row.app.name }}<small class="mk-tag">{{ healthVersionText(row) }}</small></b>
                  <span>
                    <template v-if="row.error">
                      {{ thirdErrorText(row.error.code) }} <code class="mk-code">{{ row.error.code }}</code><span v-if="row.error.detail"> · {{ row.error.detail }}</span>
                    </template>
                    <template v-else-if="row.health">
                      {{ row.health.effectiveSource === "installed" ? t("生效来源：已安装版本") : t("生效来源：随包内置版本") }}
                      <template v-if="row.health.loader"> · {{ t("加载器") }} <code class="mk-code">{{ row.health.loader }}</code></template>
                      <template v-if="row.health.loadUrl"> · {{ t("加载地址") }} <code class="mk-code">{{ row.health.loadUrl }}</code></template>
                      <template v-if="row.health.installed && row.health.installed.version"> · {{ t("已安装") }} v{{ row.health.installed.version }}</template>
                      <template v-if="row.health.fallbackReason"> · {{ t("回退原因") }} {{ healthFallbackText(row.health.fallbackReason) }}</template>
                      <template v-if="row.health.installed && row.health.installed.detail"> · {{ row.health.installed.detail }}</template>
                    </template>
                    <template v-else>{{ t("还没有读取到健康结果。") }}</template>
                  </span>
                </div>
                <DsBadge v-if="row.error" size="sm" tone="danger">{{ t("健康检查失败") }}</DsBadge>
                <DsBadge v-else-if="row.health" size="sm" :tone="row.health.installedLoadable ? 'success' : 'neutral'">{{ row.health.installedLoadable ? t("已安装包可加载") : t("使用内置或不可加载") }}</DsBadge>
                <span v-else class="mk-cap">{{ t("未读取") }}</span>
              </div>
            </div>
            <p v-if="!healthRowsFiltered.length && healthBusy" class="mk-cap" role="status">{{ t("正在读取全部应用的加载健康…") }}</p>
            <DsPageState
              v-else-if="!healthRowsFiltered.length"
              kind="empty"
              :title="normalizedQuery ? t('没有匹配的应用') : t('还没有读取到健康结果')"
              :description="normalizedQuery ? t('清空左侧搜索框可以看全部应用。') : t('点击右上角的重新检查读取每个应用的加载状态。')"
            />
            <button type="button" class="mk-link" data-market-health-back @click="switchView('updates')">‹ {{ t("返回更新") }}</button>
          </section>
        </template>
      </div>

      <DsDialog
        class="mk-detail-dialog"
        :open="!!marketDetail"
        :title="marketDetail ? (marketDetail.kind === 'skill' ? t('关于这个 Skill') : marketDetail.kind === 'template' ? t('关于这个模板') : t('关于这个应用')) : t('详情')"
        @close="closeMarketDetail"
      >
        <div v-if="marketDetail" class="mk-detail" data-market-detail :data-market-detail-kind="marketDetail.kind" :data-market-detail-id="marketDetail.id">
          <header class="mk-detail-head">
            <h2 class="mk-detail-title" data-market-detail-title>{{ marketDetail.name }}</h2>
            <p v-if="marketDetail.subtitle" class="mk-detail-sub" data-market-detail-sub>{{ marketDetail.subtitle }}</p>
            <p v-if="marketDetail.packaged" class="mk-detail-sub mk-detail-sub--meta" data-market-detail-package>
              {{ t("来源：") }}<span data-market-detail-package-url>{{ marketDetail.packaged.url }}</span> · {{ t("大小：") }}{{ packageSizeText(marketDetail.packaged.size) }} · SHA-256：<span data-market-detail-package-sha>{{ marketDetail.packaged.sha256 }}</span>
            </p>
            <p class="mk-detail-sub mk-detail-sub--meta" data-market-detail-meta>
              {{ marketDetail.metaLabel || (marketDetail.kind === "skill" ? t("官方技能 · 本地技能定义 / 本地市场清单") : marketDetail.kind === "template" ? t("项目模板 · 本地市场清单") : marketDetail.kind === "catalog-app" ? t("本地市场 App") : t("本地应用 · 应用注册表")) }}
              <span v-if="marketDetail.kind === 'skill'"> · {{ marketDetail.added ? t("已添加") : t("未添加") }}</span>
              <span v-if="marketDetail.kind === 'template' && marketDetail.template?.doc"> · {{ marketDetail.template.doc.nodes.length }} {{ t("个节点") }} / {{ marketDetail.template.doc.edges.length }} {{ t("条连线") }}</span>
            </p>
          </header>

          <div class="mk-detail-sections">
          <section class="mk-detail-section" :data-market-detail-section="sec.key" v-for="sec in marketDetail.sections" :key="sec.key">
            <h3>{{ sec.title }}</h3>
            <p v-if="!sec.empty" class="mk-detail-body" :data-market-detail-body="sec.key">{{ sec.body }}</p>
            <p v-else class="mk-detail-body mk-detail-body--empty" :data-market-detail-body="sec.key" :data-market-detail-empty="sec.key">{{ t("暂无") }}</p>
            <p class="mk-detail-source">{{ t("来源：{source}", { source: sec.source }) }}</p>
          </section>
          </div>

          <footer class="mk-detail-foot">
          <div class="mk-detail-ctas">
            <DsButton size="sm" variant="secondary" data-market-detail-copy :disabled="!marketDetail.copy.enabled" :title="marketDetail.copy.enabled ? t('复制提示词') : marketDetail.copy.reason" @click="detailCopy">{{ t("复制提示词") }}</DsButton>
            <DsButton size="sm" variant="primary" data-market-detail-try :disabled="!marketDetail.try.enabled" :title="marketDetail.try.enabled ? '' : marketDetail.try.reason" @click="detailTry">{{ t("立即体验") }}</DsButton>
            <DsButton size="sm" variant="secondary" data-market-detail-chat :disabled="!marketDetail.chat.enabled" :title="marketDetail.chat.enabled ? t('在对话中试用') : marketDetail.chat.reason" @click="detailChat">{{ t("在对话中试用") }}</DsButton>
            <DsButton size="sm" variant="secondary" data-market-detail-agent :disabled="!marketDetail.agent.enabled" :title="marketDetail.agent.enabled ? t('添加到 Agent') : marketDetail.agent.reason" @click="detailAgent">{{ t("添加到 Agent") }}</DsButton>
            <DsButton v-if="marketDetail.update" size="sm" variant="secondary" data-market-detail-check-update :disabled="!marketDetail.update.enabled" :title="marketDetail.update.enabled ? t('检查更新') : marketDetail.update.reason" @click="detailCheckUpdate">{{ t("检查更新") }}</DsButton>
            <DsButton v-if="marketDetail.release" size="sm" variant="secondary" data-market-detail-version @click="detailVersionPanel">{{ t("版本与更新") }}</DsButton>
            <DsButton v-if="marketDetail.install" size="sm" variant="secondary" data-market-detail-install :disabled="!marketDetail.install.enabled" :title="marketDetail.install.reason" @click="detailInstallPackage">{{ t("安装") }}</DsButton>
          </div>
          <p v-if="!marketDetail.copy.enabled" class="mk-detail-reason" data-market-detail-copy-reason>{{ t("复制提示词不可用：") }}{{ marketDetail.copy.reason }}</p>
          <p v-if="!marketDetail.chat.enabled" class="mk-detail-reason" data-market-detail-chat-reason>{{ t("在对话中试用不可用：") }}{{ marketDetail.chat.reason }}</p>
          <p v-if="!marketDetail.agent.enabled" class="mk-detail-reason" data-market-detail-agent-reason>{{ t("添加到 Agent 不可用：") }}{{ marketDetail.agent.reason }}</p>
          <p v-if="!marketDetail.try.enabled" class="mk-detail-reason" data-market-detail-try-reason>{{ t("立即体验不可用：") }}{{ marketDetail.try.reason }}</p>
          <p v-if="marketDetail.update && !marketDetail.update.enabled" class="mk-detail-reason" data-market-detail-update-reason>{{ t("检查更新不可用：") }}{{ marketDetail.update.reason }}</p>
          <p v-if="marketDetail.install && !marketDetail.install.enabled" class="mk-detail-reason" data-market-detail-install-reason>{{ t("安装不可用：") }}{{ marketDetail.install.reason }}</p>
          <p v-if="marketNotice" class="mk-detail-notice" role="status" data-market-detail-notice>{{ marketNotice }}</p>
          </footer>
        </div>
      </DsDialog>

      <DsDialog :open="!!installPick" :title="t('安装第三方应用')" @close="installPick = null">
        <template v-if="installPick">
          <p>{{ t("将安装") }} <strong>{{ installPick.name }}</strong>（{{ installPick.id }}）v{{ installPick.version }}。</p>
          <p class="mk-cap">{{ packageText(installPick) }}；{{ compatibilityOf(installPick).text }}。</p>
          <p class="mk-cap">{{ signatureText(installPick) }}</p>
          <p class="mk-cap">{{ t("安装只在你点击确认后开始；失败会如实返回错误码，不会把失败当成安装成功。") }}</p>
        </template>
        <template #footer>
          <DsButton variant="ghost" size="sm" @click="installPick = null">{{ t("取消") }}</DsButton>
          <DsButton variant="primary" size="sm" data-third-install-confirm @click="acceptInstall">{{ t("确认安装") }}</DsButton>
        </template>
      </DsDialog>

      <DsDialog :open="!!rollbackPick" :title="t('回滚第三方应用')" @close="rollbackPick = null">
        <template v-if="rollbackPick">
          <p>{{ t("将把") }} <strong>{{ rollbackPick.name || rollbackPick.id }}</strong> {{ t("从当前版本回滚到上一个可用的已安装版本 / 内置版本（由更新服务判定）。") }}</p>
          <p class="mk-cap">{{ t("回滚只在你点击确认后开始；没有可回滚目标时后端会结构化拒绝。") }}</p>
        </template>
        <template #footer>
          <DsButton variant="ghost" size="sm" @click="rollbackPick = null">{{ t("取消") }}</DsButton>
          <DsButton variant="primary" size="sm" data-third-rollback-confirm @click="acceptRollback">{{ t("确认回滚") }}</DsButton>
        </template>
      </DsDialog>
    </div>
  </div>
</template>

<style scoped>
/* 侧栏：搜索 + 分类导航（选中态只靠背景明度差，不描边） */
.market-app .mk-side { flex-basis: 200px; gap: 2px; }
.market-app .mk-side { margin-right: 0; }
.market-app .split-main { padding: 0; padding-top: 0 !important; }
.market-app .mk-view { gap: 0; }
.market-app .mk-bar { height: 52px; min-height: 52px; align-items: center; padding: 0 24px; }
.market-app .mk-search { width: 200px; height: 30px; margin: 0; flex: none; }
.market-app .mk-hero { height: 220px; margin: 8px 24px 22px; }
.market-app .mk-view > section, .market-app .mk-view > div:not(.mk-bar) { padding-left: 24px; padding-right: 24px; }
.market-app .mk-grid { gap: 12px; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); }
.market-app .mk-card { min-height: 80px; }
.mk-search { margin: 2px 2px 10px; }
.mk-nav { min-height: 32px; }
.mk-nav svg { flex: none; color: var(--muted); }
.mk-nav:hover svg,
.mk-nav[aria-current="page"] svg { color: var(--text); }
.mk-nav[aria-current="page"] {
  background: rgb(var(--text-rgb) / 0.1);
  color: var(--text);
  font-weight: var(--fw-medium);
}
.mk-nav-count {
  margin-left: auto;
  min-width: 18px;
  height: 16px;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: rgb(var(--text-rgb) / 0.08);
  color: var(--muted);
  font-size: var(--fs-micro);
  font-variant-numeric: tabular-nums;
  display: inline-grid;
  place-items: center;
}
.mk-nav-count--strong {
  background: rgb(var(--text-rgb) / 0.12);
  color: var(--text);
}

/* 视图切换：160ms opacity .6→1 + y4→0（减少动态时由时长 token 归零） */
.mk-view {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  animation: mk-view-in var(--dur-quick) var(--ease-standard) both;
}
@keyframes mk-view-in {
  from { opacity: 0.6; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
.mk-bar { display: flex; align-items: baseline; gap: var(--space-2); min-height: 28px; padding-right: 44px; }
.mk-title {
  margin: 0;
  font-size: var(--fs-title);
  font-weight: var(--fw-medium);
  letter-spacing: var(--tracking-tight);
}
.mk-sub { font-size: var(--fs-caption); color: var(--muted); }

/* hero：中性灰阶底，同一支 --text-rgb 通道分层，无彩色 */
.mk-hero {
  position: relative;
  height: 208px;
  border-radius: var(--radius-lg);
  overflow: hidden;
  box-shadow: var(--elevation-1);
  background-color: rgb(var(--content-rgb) / var(--content-alpha));
  background-image:
    radial-gradient(120% 150% at 6% 0%, rgb(var(--text-rgb) / 0.16), transparent 62%),
    radial-gradient(100% 130% at 88% 6%, rgb(var(--text-rgb) / 0.1), transparent 58%),
    linear-gradient(160deg, rgb(var(--text-rgb) / 0.07), rgb(var(--text-rgb) / 0.02) 62%);
  isolation: isolate;
}
.mk-hero::before {
  content: "";
  position: absolute;
  inset: 0 0 auto;
  height: 48%;
  background: linear-gradient(180deg, rgb(var(--text-rgb) / 0.05), transparent);
  pointer-events: none;
}
.mk-hero-mark {
  position: absolute;
  right: 16px;
  top: 50%;
  width: 232px;
  height: 232px;
  transform: translateY(-50%) rotate(-6deg);
  object-fit: contain;
  filter: grayscale(1);
  opacity: 0.09;
  pointer-events: none;
}
.mk-hero-slide {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-end;
  gap: var(--space-1);
  padding: var(--space-5) var(--space-6);
  text-align: left;
  color: var(--text);
  cursor: pointer;
}
.mk-hero-slide:focus-visible { outline: 2px solid var(--focus); outline-offset: -4px; border-radius: var(--radius-lg); }
.mk-hero-eyebrow { font-size: var(--fs-caption); color: var(--muted); }
.mk-hero-title {
  max-width: 76%;
  font-size: var(--fs-display);
  line-height: var(--lh-tight);
  letter-spacing: var(--tracking-tight);
  font-weight: var(--fw-medium);
}
.mk-hero-note { font-size: var(--fs-caption); color: var(--muted); }
.mk-hero-dots { position: absolute; right: var(--space-5); bottom: var(--space-4); display: flex; gap: var(--space-1); }
.mk-hero-dot {
  width: 6px;
  height: 6px;
  padding: 0;
  border-radius: var(--radius-pill);
  background: rgb(var(--text-rgb) / 0.45);
  transition: width var(--dur-standard) var(--ease-standard), background var(--dur-standard) var(--ease-standard);
}
.mk-hero-dot.on { width: 18px; background: var(--text); }
.mk-hero-fade-enter-active,
.mk-hero-fade-leave-active { transition: opacity var(--dur-slow) var(--ease-standard); }
.mk-hero-fade-enter-from,
.mk-hero-fade-leave-to { opacity: 0; }

.mk-section { display: flex; flex-direction: column; gap: var(--space-3); }
.mk-section-head { display: flex; align-items: center; gap: var(--space-2); min-height: 24px; }
.mk-section-head h2 {
  margin: 0;
  font-size: var(--fs-headline);
  font-weight: var(--fw-medium);
  letter-spacing: var(--tracking-tight);
}
.mk-section-count { font-size: var(--fs-caption); color: var(--muted); font-variant-numeric: tabular-nums; }
.mk-section-note {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--fs-caption);
  color: var(--muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.mk-section-count + .mk-section-count { margin-left: calc(-1 * var(--space-1)); }

/* 应用 / 外部应用两列卡片：靠明度差 + 阴影分层，不描边 */
.mk-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: var(--space-3); }
.mk-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 64px;
  padding: var(--space-3);
  border-radius: var(--radius-lg);
  background: rgb(var(--text-rgb) / 0.045);
  box-shadow: var(--elevation-1);
  transition:
    background var(--dur-feedback) var(--ease-standard),
    box-shadow var(--dur-feedback) var(--ease-standard),
    transform var(--dur-feedback) var(--ease-standard);
}
.mk-card:hover,
.mk-card:focus-within {
  background: rgb(var(--text-rgb) / 0.07);
  box-shadow: var(--elevation-card-hover);
  transform: translateY(-1px);
}
.mk-card-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 0;
  text-align: left;
  color: var(--text);
  cursor: pointer;
}
.mk-card-icon { width: 40px; height: 40px; flex: none; object-fit: contain; }
.mk-card-tile {
  width: 40px;
  height: 40px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: var(--radius-md);
  background: rgb(var(--text-rgb) / 0.08);
  color: var(--text);
  font-size: var(--fs-headline);
  font-weight: var(--fw-medium);
}
.mk-card-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mk-card-name {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--fs-secondary);
  font-weight: var(--fw-medium);
  color: var(--text);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.mk-card-desc { font-size: var(--fs-caption); color: var(--muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.mk-card-meta {
  font-size: var(--fs-micro);
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.mk-card-meta--wrap {
  white-space: normal;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-height: var(--lh-normal);
}
.mk-card-actions { flex: none; display: flex; align-items: center; gap: var(--space-1); }

/* ── TapNow 对齐：市场页签 / 技能卡 / 六段详情 ───────────────────────── */
.mk-tabs {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  flex-wrap: wrap;
  padding: 2px;
  border-radius: var(--radius-pill);
  background: var(--sunken);
  align-self: flex-start;
}
.mk-tab {
  height: 26px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--muted);
  font-size: var(--fs-secondary);
  font-weight: var(--fw-medium);
  cursor: default;
}
.mk-tab:hover { color: var(--text); }
.mk-tab.on { background: rgb(var(--content-rgb) / var(--content-alpha)); color: var(--text); box-shadow: var(--elevation-1); }
.mk-tab:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
.mk-card-meta--added { color: var(--muted); }
.mk-card-tile--skill { color: var(--text); }
.mk-detail { display: flex; flex-direction: column; gap: var(--space-2); max-height: min(72vh, 430px); }
.mk-detail-sections { display: flex; flex-direction: column; gap: var(--space-3); overflow: auto; min-height: 0; padding-right: 2px; }
.mk-detail-foot { flex: none; display: flex; flex-direction: column; gap: var(--space-1); padding-top: var(--space-2); box-shadow: inset 0 0.5px 0 var(--line); }
.mk-detail-head { display: flex; flex-direction: column; gap: 2px; }
.mk-detail-title { margin: 0; font-size: var(--fs-heading); font-weight: var(--fw-medium); color: var(--text); }
.mk-detail-sub { margin: 0; font-size: var(--fs-secondary); color: var(--muted); line-height: var(--lh-relaxed); }
.mk-detail-sub--meta { font-size: var(--fs-micro); }
.mk-detail-section { display: flex; flex-direction: column; gap: 2px; padding-top: var(--space-2); box-shadow: inset 0 0.5px 0 var(--line); }
.mk-detail-section h3 { margin: 6px 0 0; font-size: var(--fs-caption); font-weight: var(--fw-medium); color: var(--text); }
.mk-detail-body { margin: 0; font-size: var(--fs-secondary); line-height: var(--lh-relaxed); color: var(--text); overflow-wrap: anywhere; white-space: pre-wrap; }
.mk-detail-body--empty { color: var(--muted); }
.mk-detail-source { margin: 0; font-size: var(--fs-micro); color: var(--muted); }
.mk-detail-ctas { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.mk-detail-reason { margin: 0; font-size: var(--fs-micro); color: var(--muted); }
.mk-detail-notice { margin: 0; font-size: var(--fs-caption); color: var(--text); }

.mk-tag { font-size: var(--fs-micro); font-weight: var(--fw-regular); color: var(--muted); font-variant-numeric: tabular-nums; }

.mk-pill {
  min-width: 64px;
  height: 26px;
  padding: 0 14px;
  border-radius: var(--radius-pill);
  background: rgb(var(--text-rgb) / 0.08);
  color: var(--text);
  font-size: var(--fs-secondary);
  font-weight: var(--fw-medium);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  cursor: pointer;
  transition: background var(--dur-feedback) var(--ease-standard), opacity var(--dur-feedback) var(--ease-standard);
}
.mk-pill:hover { background: rgb(var(--text-rgb) / 0.14); }
.mk-pill--primary { background: var(--accent); color: var(--on-accent); }
.mk-pill--primary:hover { background: var(--accent); opacity: 0.88; }
.mk-pill:disabled { opacity: var(--disabled-opacity); cursor: not-allowed; }

.mk-pin {
  width: 26px;
  height: 26px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: var(--radius-pill);
  color: var(--muted);
  opacity: 0;
  cursor: pointer;
  transition:
    opacity var(--dur-feedback) var(--ease-standard),
    background var(--dur-feedback) var(--ease-standard),
    color var(--dur-feedback) var(--ease-standard);
}
.mk-card:hover .mk-pin,
.mk-card:focus-within .mk-pin,
.mk-pin[aria-pressed="true"] { opacity: 1; }
.mk-pin:hover { background: rgb(var(--text-rgb) / 0.08); color: var(--text); }

/* 未知总量用不定环（不伪造百分比）；减少动态时环静止但按钮仍带 aria-busy/禁用态 */
.mk-ring {
  width: 14px;
  height: 14px;
  flex: none;
  display: inline-grid;
  place-items: center;
  animation: mk-ring-spin 900ms linear infinite;
}
.mk-ring svg { width: 100%; height: 100%; }
.mk-ring circle { fill: none; stroke-width: 2; }
.mk-ring-track { stroke: rgb(var(--text-rgb) / 0.2); }
.mk-ring-arc { stroke: var(--text); stroke-linecap: round; stroke-dasharray: 20 38; }
.mk-pill--primary .mk-ring-track { stroke: rgb(var(--on-accent-rgb) / 0.3); }
.mk-pill--primary .mk-ring-arc { stroke: var(--on-accent); }
@keyframes mk-ring-spin { to { transform: rotate(360deg); } }

.mk-list { display: flex; flex-direction: column; }
.mk-group { display: flex; flex-direction: column; padding: var(--space-1); border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.025); }
.mk-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  transition: background var(--dur-feedback) var(--ease-standard);
}
.mk-row:hover { background: rgb(var(--text-rgb) / 0.04); }
.mk-row-icon { width: 32px; height: 32px; flex: none; object-fit: contain; }
.mk-row-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mk-row-text b {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--fs-secondary);
  font-weight: var(--fw-medium);
}
.mk-row-text span { font-size: var(--fs-caption); color: var(--muted); overflow-wrap: anywhere; }

.mk-link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0;
  color: var(--muted);
  font-size: var(--fs-caption);
  cursor: pointer;
  transition: color var(--dur-feedback) var(--ease-standard);
}
.mk-link:hover { color: var(--text); }
.mk-health-link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  align-self: flex-start;
  padding: 0;
  color: var(--muted);
  font-size: var(--fs-caption);
  cursor: pointer;
  transition: color var(--dur-feedback) var(--ease-standard);
}
.mk-health-link:hover { color: var(--text); }

.mk-cap { margin: 0; font-size: var(--fs-caption); color: var(--muted); line-height: var(--lh-normal); overflow-wrap: anywhere; }
.mk-error { margin: 0; font-size: var(--fs-caption); color: var(--failed); line-height: var(--lh-normal); overflow-wrap: anywhere; }
.mk-notice {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: rgb(var(--text-rgb) / 0.045);
  font-size: var(--fs-caption);
  line-height: var(--lh-normal);
  overflow-wrap: anywhere;
}
.mk-code { font-family: var(--font-mono); font-size: var(--fs-micro); overflow-wrap: anywhere; }

.mk-details { padding: var(--space-1) var(--space-3); border-radius: var(--radius-lg); background: rgb(var(--text-rgb) / 0.025); }
.mk-details > summary {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) 0;
  font-size: var(--fs-caption);
  color: var(--muted);
  cursor: pointer;
  list-style: none;
}
.mk-details > summary::-webkit-details-marker { display: none; }
.mk-details[open] > summary { color: var(--text); }
.mk-details-state { margin-left: auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--muted); }
.mk-details-body { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-1) 0 var(--space-3); }

.mk-source-row { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); }
.mk-input {
  box-sizing: border-box;
  flex: 1 1 240px;
  min-width: 0;
  min-height: 30px;
  padding: var(--space-1) var(--space-2);
  border: 0;
  border-radius: var(--radius-md);
  background: rgb(var(--text-rgb) / 0.06);
  color: var(--text);
  font: inherit;
  font-size: var(--fs-secondary);
}
.mk-input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
.mk-rejected { margin: 0; padding-left: var(--space-4); font-size: var(--fs-caption); color: var(--muted); overflow-wrap: anywhere; }

/* 键盘焦点环：2px 中性轮廓 + 2px 间隔（DESIGN_SYSTEM §7），显式声明，不依赖 UA 默认 */
.mk-nav:focus-visible,
.mk-card-main:focus-visible,
.mk-pill:focus-visible,
.mk-pin:focus-visible,
.mk-link:focus-visible,
.mk-health-link:focus-visible,
.mk-hero-dot:focus-visible,
.mk-input:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

/* task-8 final overrides */
.market-app .mk-side { margin: 8px 0 8px 8px !important; }
.market-app .mk-hero { margin: 8px 24px 22px; }
.market-app .mk-grid { grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); }

.market-app .mk-bar { padding-right: 16px; }
.market-app .mk-hero { margin-bottom: 18px; }
</style>


