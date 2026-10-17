<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { Download, RefreshCw, RotateCcw, Search } from "lucide-vue-next";
import { APPS, appById, iconUrl, type AppEntry } from "../apps";
import { useShellStore } from "../stores/shell";
import DsBadge from "../design-system/DsBadge.vue";
import DsButton from "../design-system/DsButton.vue";
import DsDialog from "../design-system/DsDialog.vue";
import CanvasUpdatePanel from "./CanvasUpdatePanel.vue";
import { UPDATE_STATUS_COMMAND, appCardUpdate, formatTimestamp, normalizeAppUpdateStatus } from "./appUpdateLogic";
import type { AppUpdateStatus } from "./appUpdateLogic";

/**
 * 应用市场（10-15，task-24 扩展）：本机应用目录 + 第三方应用 + 全应用更新健康。
 *
 * 三个视图（同一个应用窗口内切换，不新开窗口）：
 *   · 应用：注册表里的内置应用，显示内置版本与本机更新状态；点「版本与更新」进通用更新面板；
 *   · 第三方：market/thirdparty/list｜install｜rollback｜source/get｜source/set。目录条目展示来源
 *     （本地 / 在线）、版本、兼容性、包 sha256 与签名校验口径；安装必须二次确认；安装失败/目录失败/
 *     无公钥/不可加载都按后端结构化结果如实展示，不伪造商品与成功。
 *   · 更新健康：逐应用调用 market/update/health，展示 status 的 loadable / loadUrl 与
 *     effectiveSource / installedLoadable / fallbackReason；缺公钥、无发布包、不可加载分别说明。
 *
 * 诚实边界：第三方市场只读目录、安装的是本机目录/白名单 HTTPS 源里的真实包；没有目录/没有在线源/
 * 目录里没有包都显示真实空态或错误码，不造商品。所有安装/回滚都经过 DsDialog 二次确认。
 */
const shell = useShellStore();
type View = "apps" | "thirdparty" | "health";
const view = ref<View>("apps");
const query = ref("");
const cat = ref("全部");
const detail = ref<string | null>(null);
const autoInstall = ref(false);
const statuses = reactive<Record<string, AppUpdateStatus | null>>({});
const statusBusy = ref(false);

const META: Record<string, { cat: string; desc: string }> = {
  home: { cat: "系统", desc: "浏览与打开全部应用" },
  files: { cat: "系统", desc: "管理桌面与文件夹里的文件" },
  trash: { cat: "系统", desc: "恢复或彻底删除已移除的文件" },
  settings: { cat: "系统", desc: "外观、账户、模型与隐私设置" },
  dev: { cat: "系统", desc: "运行环境、窗口状态与运行日志" },
  declare: { cat: "创作", desc: "为 AI 生成图片写入标准来源声明" },
  canvas: { cat: "创作", desc: "无限画布：图像、视频与工作流" },
  photos: { cat: "创作", desc: "汇总访达里的全部图片" },
  music: { cat: "创作", desc: "播放访达里的音频文件" },
  notes: { cat: "创作", desc: "Markdown / 纯文本文稿，自动保存" },
  video: { cat: "创作", desc: "拼接、裁剪视频并用本机 FFmpeg 导出" },
  chat: { cat: "效率", desc: "和助理对话、交代任务" },
  automation: { cat: "效率", desc: "按时间自动让助理完成任务" },
  calendar: { cat: "效率", desc: "月视图与本机日程" },
  weather: { cat: "效率", desc: "当前天气与 7 日预报（Open-Meteo）" },
  browser: { cat: "效率", desc: "受控的网页浏览与下载" },
  projects: { cat: "团队与资源", desc: "项目与成员协作" },
  organization: { cat: "团队与资源", desc: "成员、角色与权限治理" },
  "resource-library": { cat: "团队与资源", desc: "可被助理引用的资源" },
  skills: { cat: "团队与资源", desc: "技能的安装与管理" },
  "mcp-center": { cat: "团队与资源", desc: "连接外部工具与数据源（MCP）" },
  integrations: { cat: "团队与资源", desc: "领星、紫鸟、钉钉、夸克、天气与黄历等可选服务的开关与凭据" },
};
const CATS = ["全部", "系统", "创作", "效率", "团队与资源"];
const meta = (a: AppEntry) => META[a.id] ?? { cat: "其他", desc: "" };
const apps = computed(() => {
  const q = query.value.trim().toLowerCase();
  return APPS.filter((a) => a.id !== "market")
    .filter((a) => cat.value === "全部" || meta(a).cat === cat.value)
    .filter((a) => !q || a.name.toLowerCase().includes(q) || meta(a).desc.toLowerCase().includes(q));
});
const inDock = (id: string) => shell.dockIds.includes(id);
const card = (a: AppEntry) => appCardUpdate(statuses[a.id] ?? null);
const statusCurrent = (id: string): string => {
  const s = statuses[id];
  if (!s) return "none";
  return s.current ? s.current.version : "builtin:" + s.builtinVersion;
};
const statusLatest = (id: string): string => {
  const s = statuses[id];
  return s && s.latest ? s.latest.version : "";
};
const statusChecked = (id: string): string => {
  const s = statuses[id];
  return s && s.checkedAt != null ? String(s.checkedAt) : "";
};
const UPDATE_APP_NAME: Record<string, string> = { canvas: "无限画布" };
const detailName = computed(() => {
  const id = detail.value;
  if (!id) return "";
  return UPDATE_APP_NAME[id] || appById(id)?.name || id;
});

function openDetail(id: string, upgrade = false) {
  detail.value = id;
  autoInstall.value = upgrade;
}
function closeDetail() {
  detail.value = null;
  autoInstall.value = false;
  void loadStatuses();
}

/* ── 市场命令桥（market:command 唯一通道；marketUpdate / market 两个桥指向同一 IPC） ── */
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

/** 只读本机记录（status 不联网）；读不到就如实留空，不编造更新状态。 */
async function loadStatuses() {
  statusBusy.value = true;
  const targets = APPS.filter((a) => a.id !== "market");
  await Promise.all(targets.map(async (a) => {
    try {
      const raw = await marketCall(UPDATE_STATUS_COMMAND, { appId: a.id });
      statuses[a.id] = raw.ok ? normalizeAppUpdateStatus(raw.value) : null;
    } catch {
      statuses[a.id] = null;
    }
  }));
  statusBusy.value = false;
}

/* ── 第三方应用 ─────────────────────────────────────────────────────────── */
type ThirdApp = {
  id: string; name: string; version: string;
  packageUrl: string | null; packageFile: string | null;
  sha256: string; size: number | null;
  minSystemVersion: string | null; maxSystemVersion: string | null;
  entry: string | null; description: string | null; author: string | null; homepage: string | null;
  source: "local" | "online";
};
type ThirdRejected = { id: string | null; reason: string };
type ThirdInstalled = { id: string; name: string | null; version: string | null; status: string; source: string | null; installedAt: number | null; currentVersion: string | null; effectiveSource: string };
type ThirdCatalog = { present: boolean; ok: boolean; apps: ThirdApp[]; rejected: ThirdRejected[]; error: string | null; detail: string | null };
type ThirdOnline = { configured: boolean; ok: boolean; apps: ThirdApp[]; rejected: ThirdRejected[]; error: string | null; detail: string | null };
type ThirdList = { systemVersion: string; local: ThirdCatalog; online: ThirdOnline; installed: ThirdInstalled[] };
type ThirdHealth = {
  ok: boolean; effectiveSource: string; installedLoadable: boolean;
  loader: string | null; loadUrl: string | null; fallbackReason: string | null;
  installed: { version: string | null; digest: string | null; kind: string | null; entry: string | null; reason: string | null; detail: string | null } | null;
  error: string | null; detail: string | null;
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
  return THIRD_ERROR_TEXT[code] || "操作失败（" + code + "）";
}

function asText(value: unknown): string { return typeof value === "string" ? value : ""; }
function asNum(value: unknown): number | null { return Number.isFinite(Number(value)) ? Number(value) : null; }
function normalizeThirdApp(raw: any, source: "local" | "online"): ThirdApp | null {
  if (!raw || typeof raw !== "object") return null;
  const id = asText(raw.id);
  if (!id) return null;
  return {
    id, name: asText(raw.name) || id, version: asText(raw.version) || "—",
    packageUrl: asText(raw.packageUrl) || null, packageFile: asText(raw.packageFile) || null,
    sha256: asText(raw.sha256), size: asNum(raw.size),
    minSystemVersion: asText(raw.minSystemVersion) || null, maxSystemVersion: asText(raw.maxSystemVersion) || null,
    entry: asText(raw.entry) || null, description: asText(raw.description) || null,
    author: asText(raw.author) || null, homepage: asText(raw.homepage) || null,
    source: raw.source === "online" ? "online" : source,
  };
}
function normalizeRejected(raw: any): ThirdRejected[] {
  return (Array.isArray(raw) ? raw : []).filter((item) => item && typeof item === "object").map((item: any) => ({ id: asText(item.id) || null, reason: asText(item.reason) || "原因未知" }));
}
function normalizeThirdList(raw: any): ThirdList {
  const box = raw && typeof raw === "object" ? raw : {};
  const local = box.local && typeof box.local === "object" ? box.local : {};
  const online = box.online && typeof box.online === "object" ? box.online : {};
  return {
    systemVersion: asText(box.systemVersion) || "—",
    local: {
      present: local.present === true, ok: local.ok === true,
      apps: (Array.isArray(local.apps) ? local.apps : []).map((app: any) => normalizeThirdApp(app, "local")).filter(Boolean) as ThirdApp[],
      rejected: normalizeRejected(local.rejected), error: asText(local.error) || null, detail: asText(local.detail) || null,
    },
    online: {
      configured: online.configured === true, ok: online.ok === true,
      apps: (Array.isArray(online.apps) ? online.apps : []).map((app: any) => normalizeThirdApp(app, "online")).filter(Boolean) as ThirdApp[],
      rejected: normalizeRejected(online.rejected), error: asText(online.error) || null, detail: asText(online.detail) || null,
    },
    installed: (Array.isArray(box.installed) ? box.installed : []).map((item: any) => ({
      id: asText(item.id), name: asText(item.name) || null, version: asText(item.version) || null,
      status: asText(item.status) || "installed", source: asText(item.source) || null,
      installedAt: asNum(item.installedAt), currentVersion: asText(item.currentVersion) || null,
      effectiveSource: asText(item.effectiveSource) || "builtin",
    })).filter((item: ThirdInstalled) => !!item.id),
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
    installed: installed ? {
      version: asText(installed.version) || null, digest: asText(installed.digest) || null,
      kind: asText(installed.kind) || null, entry: asText(installed.entry) || null,
      reason: asText(installed.reason) || null, detail: asText(installed.detail) || null,
    } : null,
    error: asText(box.error) || null,
    detail: asText(box.detail) || null,
  };
}

const thirdList = ref<ThirdList | null>(null);
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

const localApps = computed(() => thirdList.value ? thirdList.value.local.apps : []);
const onlineApps = computed(() => thirdList.value ? thirdList.value.online.apps : []);
const installedApps = computed(() => thirdList.value ? thirdList.value.installed : []);
const rejectedEntries = computed(() => {
  const list: ThirdRejected[] = [];
  if (thirdList.value) list.push(...thirdList.value.local.rejected, ...thirdList.value.online.rejected);
  return list;
});
const installedOf = (id: string): ThirdInstalled | null => installedApps.value.find((entry) => entry.id === id) || null;

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
  await Promise.all(thirdList.value.installed.map(async (item) => {
    try {
      const res = await marketCall("market/update/health", { appId: item.id });
      thirdHealth[item.id] = res.ok ? normalizeHealth(res.value) : { ok: false, effectiveSource: "unknown", installedLoadable: false, loader: null, loadUrl: null, fallbackReason: null, installed: null, error: res.error, detail: res.detail };
    } catch {
      thirdHealth[item.id] = null;
    }
  }));
}
async function loadThirdParty() {
  thirdBusy.value = "list";
  thirdListError.value = null;
  const res = await marketCall("market/thirdparty/list");
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
  if (!res.ok) { thirdSourceError.value = { code: res.error, detail: res.detail }; return; }
  await loadThirdParty();
  thirdNotice.value = thirdSourceDraft.value.trim() ? "已保存在线目录地址，刷新后读取在线目录。" : "已清除在线目录地址（本地目录与已安装列表不受影响）。";
}
function askInstall(app: ThirdApp) { installPick.value = app; thirdActionError.value = null; }
function askRollback(item: ThirdInstalled) { rollbackPick.value = item; thirdActionError.value = null; }
async function acceptInstall() {
  const app = installPick.value;
  installPick.value = null;
  if (!app) return;
  thirdBusy.value = "install:" + app.id;
  thirdActionError.value = null;
  thirdNotice.value = "";
  const res = await marketCall("market/thirdparty/install", { appId: app.id, confirm: true });
  thirdBusy.value = null;
  if (!res.ok) { thirdActionError.value = { code: res.error, detail: res.detail }; return; }
  const value = res.value && typeof res.value === "object" ? (res.value as any) : {};
  const installed = value.installed && typeof value.installed === "object" ? value.installed : {};
  thirdNotice.value = installed.alreadyInstalled === true
    ? "这个版本已经安装过（后端返回 alreadyInstalled）。"
    : "已安装 " + (asText(installed.version) || app.version) + "；安装后按 App 的加载器生效。";
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
  if (!res.ok) { thirdActionError.value = { code: res.error, detail: res.detail }; return; }
  const value = res.value && typeof res.value === "object" ? (res.value as any) : {};
  thirdNotice.value = "已回滚 " + item.id + " 到 " + (asText(value.rolledBackTo) || "上一个版本") + "。";
  await loadThirdParty();
}

/* ── 兼容性 / 签名 / 包信息展示 ─────────────────────────────────────────── */
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
function compatibilityOf(app: ThirdApp): { ok: boolean; text: string } {
  const system = thirdList.value ? thirdList.value.systemVersion : "—";
  if (!parseSemverText(system)) return { ok: false, text: "系统版本未知，无法判定兼容性" };
  if (app.minSystemVersion && compareSemverText(system, app.minSystemVersion) < 0) {
    return { ok: false, text: "不兼容：需要系统 ≥ " + app.minSystemVersion + "，当前 " + system };
  }
  if (app.maxSystemVersion && compareSemverText(system, app.maxSystemVersion) > 0) {
    return { ok: false, text: "不兼容：最高支持系统 " + app.maxSystemVersion + "，当前 " + system };
  }
  return { ok: true, text: "兼容当前系统 " + system };
}
function shaShort(app: ThirdApp): string { return app.sha256 ? app.sha256.slice(0, 12) + "…" : "未声明"; }
function packageText(app: ThirdApp): string {
  if (app.packageFile) return "本地包 " + app.packageFile;
  if (app.packageUrl) {
    try { return "在线包 " + new URL(app.packageUrl).host; } catch { return "在线包"; }
  }
  return "未声明安装包";
}
function signatureText(app: ThirdApp): string {
  return "签名：安装时按 app-update-keys.json 的 " + app.id + " 公钥验签；目录只声明 sha256，未安装前不做预校验。";
}
function installedHealthText(id: string): string {
  const health = thirdHealth[id];
  if (!health) return "加载健康：未读取";
  if (health.error) return "加载健康失败：" + health.error;
  if (health.effectiveSource === "installed" && health.installedLoadable) return "已安装包可加载（验签与摘要通过）";
  if (health.effectiveSource === "builtin" && health.installed && health.installed.version) return "已安装包不可加载，回退内置版本：" + (health.fallbackReason || health.installed.reason || "未知原因");
  return "当前使用随包内置版本";
}
const localStateText = computed(() => {
  const list = thirdList.value;
  if (!list) return "正在读取…";
  if (!list.local.present) return "没有本地第三方目录（未找到 third-party.json）";
  if (!list.local.ok) return "本地目录存在但格式不合法";
  return "已读取本地目录（" + list.local.apps.length + " 个应用）";
});
const onlineStateText = computed(() => {
  const list = thirdList.value;
  if (!list) return "在线目录读取中…";
  if (!list.online.ok) return "";
  return "已读取在线目录（" + list.online.apps.length + " 个应用）";
});
function compatTone(app: ThirdApp): "success" | "danger" {
  return compatibilityOf(app).ok ? "success" : "danger";
}
function healthFallbackText(reason: string | null | undefined): string {
  if (!reason) return "—";
  if (reason === "pointer-cleared") return "没有安装指针（使用内置版本）";
  if (reason === "pointer-missing") return "安装指针文件缺失";
  if (reason === "pointer-invalid") return "安装指针无效";
  if (reason === "MARKET_UPDATE_NOT_READY") return "公钥缺失或更新服务未就绪";
  if (reason === "MARKET_UPDATE_SIGNATURE_INVALID") return "签名校验未通过";
  if (reason === "MARKET_UPDATE_DIGEST_MISMATCH") return "内容摘要不一致";
  return reason;
}

/* ── 全应用更新健康（market/update/health） ─────────────────────────────── */
type HealthRow = { app: AppEntry; status: AppUpdateStatus | null; health: ThirdHealth | null; error: { code: string; detail: string } | null };
const healthRows = ref<HealthRow[]>([]);
function healthVersionText(row: HealthRow): string {
  const status = statuses[row.app.id];
  if (!status) return "—";
  if (status.current) return status.current.version;
  return "builtin " + status.builtinVersion;
}
const healthBusy = ref(false);
async function loadHealthRows() {
  healthBusy.value = true;
  const rows = await Promise.all(APPS.filter((a) => a.id !== "market").map(async (a) => {
    const status = statuses[a.id] ?? null;
    try {
      const res = await marketCall("market/update/health", { appId: a.id });
      return { app: a, status, health: res.ok ? normalizeHealth(res.value) : null, error: res.ok ? null : { code: res.error, detail: res.detail } } as HealthRow;
    } catch {
      return { app: a, status, health: null, error: { code: "DXOS_ERR_INTERNAL", detail: "" } } as HealthRow;
    }
  }));
  healthRows.value = rows;
  healthBusy.value = false;
}
function switchView(next: View) {
  view.value = next;
  detail.value = null;
  if (next === "thirdparty" && !thirdList.value && !thirdBusy.value) void loadThirdParty();
  if (next === "health" && !healthRows.value.length && !healthBusy.value) void loadHealthRows();
}

onMounted(() => {
  void loadStatuses();
});
</script>

<template>
  <div class="split market-app">
    <nav class="split-side" aria-label="应用市场">
      <label class="ds-search notes-search">
        <Search class="ds-search__icon" :size="13" />
        <input v-model="query" class="ds-search__input" type="search" placeholder="搜索应用" aria-label="搜索应用" />
      </label>
      <div class="split-section">市场</div>
      <button type="button" class="split-nav" :aria-current="view === 'apps' ? 'true' : undefined" data-market-view="apps" @click="switchView('apps')">
        <span class="split-nav-label">内置应用</span>
      </button>
      <button type="button" class="split-nav" :aria-current="view === 'thirdparty' ? 'true' : undefined" data-market-view="thirdparty" @click="switchView('thirdparty')">
        <span class="split-nav-label">第三方应用</span>
        <small v-if="thirdList" class="planned-count">{{ installedApps.length }}</small>
      </button>
      <button type="button" class="split-nav" :aria-current="view === 'health' ? 'true' : undefined" data-market-view="health" @click="switchView('health')">
        <span class="split-nav-label">更新健康</span>
      </button>
      <template v-if="view === 'apps'">
        <div class="split-section">分类</div>
        <button v-for="c in CATS" :key="c" type="button" class="split-nav" :aria-current="cat === c ? 'true' : undefined" @click="cat = c">
          <span class="split-nav-label">{{ c }}</span>
        </button>
      </template>
      <p class="planned-note">
        {{ view === 'apps'
          ? '内置应用来自 OpenArc 注册表；版本与更新只读本机记录，检查更新才会联网。'
          : view === 'thirdparty'
            ? '第三方应用来自本地目录或白名单 HTTPS 在线目录；安装需要二次确认，失败会如实显示错误码。'
            : '逐应用展示已安装包的加载路径、生效来源与回退原因；缺公钥/无发布包/不可加载都会单独说明。' }}
      </p>
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
      <template v-else-if="view === 'apps'">
        <div class="pane-toolbar">
          <strong class="pane-title">{{ cat === "全部" ? "全部应用" : cat }}</strong>
          <span class="badge">{{ apps.length }} 个</span>
          <div class="toolbar-spacer" />
          <DsButton size="sm" variant="secondary" data-market-refresh-status :status="statusBusy ? 'loading' : 'idle'" :disabled="statusBusy" @click="loadStatuses">
            <RefreshCw :size="13" :stroke-width="1.5" /> 刷新全部状态
          </DsButton>
        </div>
        <div class="market-grid" data-market-apps>
          <div
            v-for="a in apps"
            :key="a.id"
            class="market-card"
            :data-app-card="a.id"
            :data-app-version="a.version"
            :data-app-update-current="statusCurrent(a.id)"
            :data-app-update-latest="statusLatest(a.id)"
            :data-app-update-checked="statusChecked(a.id)"
            :data-app-loadable="statuses[a.id] ? (statuses[a.id]!.loadable ? '1' : '0') : ''"
            :data-app-load-url="statuses[a.id]?.loadUrl || ''"
          >
            <img class="market-icon" :src="iconUrl(a.icon)" alt="" draggable="false" />
            <div class="market-info">
              <div class="market-name">
                {{ a.name }}
                <small class="market-tag">v{{ a.version }}</small>
              </div>
              <div class="market-desc">{{ meta(a).desc }}</div>
              <div class="market-desc" :data-app-update-detail="a.id">
                <DsBadge size="sm" :tone="card(a).tone">{{ card(a).badge }}</DsBadge>
                {{ card(a).detail }}
              </div>
              <div v-if="statuses[a.id] && statuses[a.id]!.loadUrl" class="market-desc mono market-load-url" :data-app-load-url-text="a.id">加载地址：{{ statuses[a.id]!.loadUrl }}</div>
              <div v-else-if="statuses[a.id] && !statuses[a.id]!.loadable" class="market-desc market-load-url" :data-app-not-loadable="a.id">安装包加载：未接入（安装不会生效）</div>
            </div>
            <div class="market-btns">
              <button class="market-open" :data-app-open="a.id" @click="shell.activateApp(a.id)">打开</button>
              <button
                class="market-pin"
                :data-app-update-open="a.id"
                :data-app-update-upgrade="card(a).canUpgrade ? 'true' : 'false'"
                @click="openDetail(a.id, card(a).canUpgrade)"
              >{{ card(a).canUpgrade ? "升级" : "版本与更新" }}</button>
              <button
                v-if="a.id !== 'trash'"
                class="market-pin"
                :aria-pressed="inDock(a.id)"
                :title="inDock(a.id) ? '从程序坞移除' : '添加到程序坞'"
                @click="shell.toggleDock(a.id)"
              >{{ inDock(a.id) ? "已在程序坞" : "加到程序坞" }}</button>
            </div>
          </div>
        </div>
      </template>

      <template v-else-if="view === 'thirdparty'">
        <div class="pane-toolbar">
          <strong class="pane-title">第三方应用</strong>
          <span class="badge" data-third-count>{{ localApps.length + onlineApps.length }} 个目录条目</span>
          <span class="badge" data-third-installed-count>{{ installedApps.length }} 已安装</span>
          <div class="toolbar-spacer" />
          <DsButton size="sm" variant="secondary" data-third-refresh :status="thirdBusy === 'list' ? 'loading' : 'idle'" :disabled="!!thirdBusy" @click="loadThirdParty">
            <RefreshCw :size="13" :stroke-width="1.5" /> 刷新
          </DsButton>
        </div>

        <p v-if="thirdNotice" class="tp-notice" role="status" data-third-notice>{{ thirdNotice }}</p>
        <p v-if="thirdActionError" class="tp-error" role="alert" :data-third-action-error="thirdActionError?.code">
          {{ thirdErrorText(thirdActionError?.code || "") }}<span v-if="thirdActionError?.detail">：{{ thirdActionError?.detail }}</span>
          <code class="tp-code">{{ thirdActionError?.code }}</code>
        </p>
        <p v-if="thirdListError" class="tp-error" role="alert" :data-third-list-error="thirdListError?.code">
          {{ thirdErrorText(thirdListError?.code || "") }}<span v-if="thirdListError?.detail">：{{ thirdListError?.detail }}</span>
          <code class="tp-code">{{ thirdListError?.code }}</code>
        </p>
        <p class="set-cap" data-third-load-support>
          加载支持：第三方应用由通用 openarc-app:// 解析器判定是否可加载；安装时后端会做签名、摘要与加载复核，
          缺公钥 / 不可加载会结构化拒绝，界面不会把安装失败显示成生效。
        </p>

        <section class="set-sec">
          <h3>在线目录来源</h3>
          <div class="tp-source">
            <input
              v-model="thirdSourceDraft"
              class="tp-input"
              type="url"
              placeholder="https://（白名单主机的在线目录 JSON；留空只用本地目录）"
              aria-label="在线目录地址"
              data-third-source-input
            />
            <DsButton size="sm" variant="secondary" data-third-source-save :status="thirdBusy === 'source' ? 'loading' : 'idle'" :disabled="!!thirdBusy" @click="saveThirdSource">保存来源</DsButton>
            <DsButton size="sm" variant="ghost" data-third-source-clear :disabled="!!thirdBusy" @click="thirdSourceDraft = ''; saveThirdSource()">清除</DsButton>
          </div>
          <p class="set-cap" data-third-source-current>
            当前在线目录：{{ thirdSourceUrl || "未设置（只读取本地目录）" }}。只允许 HTTPS + 白名单主机；在线目录读取失败不影响本地目录与已安装列表。
          </p>
          <p v-if="thirdSourceError" class="tp-error" role="alert" :data-third-source-error="thirdSourceError?.code">
            {{ thirdErrorText(thirdSourceError?.code || "") }}<span v-if="thirdSourceError?.detail">：{{ thirdSourceError?.detail }}</span>
            <code class="tp-code">{{ thirdSourceError?.code }}</code>
          </p>
        </section>

        <section class="set-sec">
          <h3>已安装的第三方应用</h3>
          <p v-if="!installedApps.length" class="set-cap" data-third-installed-empty>还没有通过第三方目录安装的应用。</p>
          <div v-else class="tp-list" data-third-installed>
            <div v-for="item in installedApps" :key="item.id" class="tp-row" :data-third-installed-app="item.id">
              <div class="tp-main">
                <div class="tp-name">{{ item.name || item.id }} <small class="market-tag">{{ item.version || "—" }}</small></div>
                <div class="tp-meta">
                  id {{ item.id }} · 状态 {{ item.status }} · 来源 {{ item.source || "—" }} · 生效 {{ item.effectiveSource === "installed" ? "已安装版本" : "随包内置版本" }}
                  <span v-if="item.installedAt"> · 安装于 {{ formatTimestamp(item.installedAt) }}</span>
                </div>
                <div class="tp-meta" :data-third-health="item.id">
                  {{ installedHealthText(item.id) }}
                  <span v-if="thirdHealth[item.id]?.fallbackReason"> · 回退原因 {{ healthFallbackText(thirdHealth[item.id]?.fallbackReason) }}</span>
                  <span v-if="thirdHealth[item.id]?.loadUrl"> · 加载地址 <code class="tp-code">{{ thirdHealth[item.id]?.loadUrl }}</code></span>
                </div>
              </div>
              <div class="tp-actions">
                <DsButton size="sm" variant="secondary" :data-third-rollback="item.id" :status="thirdBusy === 'rollback:' + item.id ? 'loading' : 'idle'" :disabled="!!thirdBusy" @click="askRollback(item)">
                  <RotateCcw :size="13" :stroke-width="1.5" /> 回滚
                </DsButton>
              </div>
            </div>
          </div>
        </section>

        <section class="set-sec">
          <h3>本地目录</h3>
          <p class="set-cap" data-third-local-state>
            {{ localStateText }}
          </p>
          <p v-if="thirdList?.local.error" class="tp-error" role="alert" :data-third-local-error="thirdList?.local.error">
            {{ thirdErrorText(thirdList?.local.error || "") }}<span v-if="thirdList?.local.detail">：{{ thirdList?.local.detail }}</span>
            <code class="tp-code">{{ thirdList?.local.error }}</code>
          </p>
          <div v-if="localApps.length" class="tp-list" data-third-local-list>
            <div v-for="app in localApps" :key="'local-' + app.id" class="tp-row" :data-third-app="app.id" data-third-app-source="local">
              <div class="tp-main">
                <div class="tp-name">{{ app.name }} <small class="market-tag">v{{ app.version }}</small> <DsBadge size="sm" tone="neutral">本地</DsBadge></div>
                <div class="tp-meta">id {{ app.id }} · {{ app.description || "没有描述" }}<span v-if="app.author"> · 作者 {{ app.author }}</span></div>
                <div class="tp-meta" :data-third-package="app.id">
                  {{ packageText(app) }} · {{ app.size ? app.size + " 字节" : "未声明体积" }} · sha256 <code class="tp-code">{{ shaShort(app) }}</code>
                </div>
                <div class="tp-meta" :data-third-compat="app.id" :data-third-compat-ok="compatibilityOf(app).ok ? '1' : '0'">
                  <DsBadge size="sm" :tone="compatTone(app)">{{ compatibilityOf(app).ok ? "兼容" : "不兼容" }}</DsBadge>
                  {{ compatibilityOf(app).text }}
                </div>
                <div class="tp-meta tp-sig" :data-third-signature="app.id">{{ signatureText(app) }}</div>
              </div>
              <div class="tp-actions">
                <DsButton
                  size="sm"
                  variant="secondary"
                  :data-third-install="app.id"
                  :status="thirdBusy === 'install:' + app.id ? 'loading' : 'idle'"
                  :disabled="!!thirdBusy || !compatibilityOf(app).ok"
                  @click="askInstall(app)"
                >
                  <Download :size="13" :stroke-width="1.5" /> {{ installedOf(app.id)?.version === app.version ? "重新安装" : "安装" }}
                </DsButton>
              </div>
            </div>
          </div>
        </section>

        <section class="set-sec">
          <h3>在线目录</h3>
          <p v-if="!thirdSourceUrl" class="set-cap" data-third-online-unconfigured>未设置在线目录（只读取本地目录）。</p>
          <p v-else-if="thirdList?.online.error" class="tp-error" role="alert" :data-third-online-error="thirdList?.online.error">
            {{ thirdErrorText(thirdList?.online.error || "") }}<span v-if="thirdList?.online.detail">：{{ thirdList?.online.detail }}</span>
            <code class="tp-code">{{ thirdList?.online.error }}</code>
          </p>
          <p v-else class="set-cap" data-third-online-state>
            {{ onlineStateText }}
          </p>
          <div v-if="onlineApps.length" class="tp-list" data-third-online-list>
            <div v-for="app in onlineApps" :key="'online-' + app.id" class="tp-row" :data-third-app="app.id" data-third-app-source="online">
              <div class="tp-main">
                <div class="tp-name">{{ app.name }} <small class="market-tag">v{{ app.version }}</small> <DsBadge size="sm" tone="neutral">在线</DsBadge></div>
                <div class="tp-meta">id {{ app.id }} · {{ app.description || "没有描述" }}<span v-if="app.author"> · 作者 {{ app.author }}</span></div>
                <div class="tp-meta" :data-third-package="app.id">
                  {{ packageText(app) }} · {{ app.size ? app.size + " 字节" : "未声明体积" }} · sha256 <code class="tp-code">{{ shaShort(app) }}</code>
                </div>
                <div class="tp-meta" :data-third-compat="app.id" :data-third-compat-ok="compatibilityOf(app).ok ? '1' : '0'">
                  <DsBadge size="sm" :tone="compatTone(app)">{{ compatibilityOf(app).ok ? "兼容" : "不兼容" }}</DsBadge>
                  {{ compatibilityOf(app).text }}
                </div>
                <div class="tp-meta tp-sig" :data-third-signature="app.id">{{ signatureText(app) }}</div>
              </div>
              <div class="tp-actions">
                <DsButton
                  size="sm"
                  variant="secondary"
                  :data-third-install="app.id"
                  :status="thirdBusy === 'install:' + app.id ? 'loading' : 'idle'"
                  :disabled="!!thirdBusy || !compatibilityOf(app).ok"
                  @click="askInstall(app)"
                >
                  <Download :size="13" :stroke-width="1.5" /> {{ installedOf(app.id)?.version === app.version ? "重新安装" : "安装" }}
                </DsButton>
              </div>
            </div>
          </div>
        </section>

        <section v-if="rejectedEntries.length" class="set-sec" data-third-rejected>
          <h3>目录中被拒绝的条目</h3>
          <p class="set-cap">这些条目没有通过目录校验，不会出现在可安装列表里（逐条如实列出原因）。</p>
          <ul class="tp-rejected">
            <li v-for="(item, index) in rejectedEntries" :key="index">
              <code class="tp-code">{{ item.id || "<无 id>" }}</code> — {{ item.reason }}
            </li>
          </ul>
        </section>

        <DsDialog :open="!!installPick" title="安装第三方应用" @close="installPick = null">
          <template v-if="installPick">
            <p>将安装 <strong>{{ installPick.name }}</strong>（{{ installPick.id }}）v{{ installPick.version }}。</p>
            <p class="set-cap">{{ packageText(installPick) }}；{{ compatibilityOf(installPick).text }}。</p>
            <p class="set-cap">{{ signatureText(installPick) }}</p>
            <p class="set-cap">安装只在你点击确认后开始；失败会如实返回错误码，不会把失败当成安装成功。</p>
          </template>
          <template #footer>
            <DsButton variant="ghost" size="sm" @click="installPick = null">取消</DsButton>
            <DsButton variant="primary" size="sm" data-third-install-confirm @click="acceptInstall">确认安装</DsButton>
          </template>
        </DsDialog>

        <DsDialog :open="!!rollbackPick" title="回滚第三方应用" @close="rollbackPick = null">
          <template v-if="rollbackPick">
            <p>将把 <strong>{{ rollbackPick.name || rollbackPick.id }}</strong> 从当前版本回滚到上一个可用的已安装版本 / 内置版本（由更新服务判定）。</p>
            <p class="set-cap">回滚只在你点击确认后开始；没有可回滚目标时后端会结构化拒绝。</p>
          </template>
          <template #footer>
            <DsButton variant="ghost" size="sm" @click="rollbackPick = null">取消</DsButton>
            <DsButton variant="primary" size="sm" data-third-rollback-confirm @click="acceptRollback">确认回滚</DsButton>
          </template>
        </DsDialog>
      </template>

      <template v-else>
        <div class="pane-toolbar">
          <strong class="pane-title">更新健康</strong>
          <span class="badge">{{ healthRows.length }} 个应用</span>
          <div class="toolbar-spacer" />
          <DsButton size="sm" variant="secondary" data-health-refresh :status="healthBusy ? 'loading' : 'idle'" :disabled="healthBusy" @click="loadHealthRows">
            <RefreshCw :size="13" :stroke-width="1.5" /> 重新检查
          </DsButton>
        </div>
        <p class="set-cap">
          逐应用读取本机安装状态（market/update/health，不联网）。缺公钥、无安装包、不可加载都会明确说明；
          检查更新（联网）仍在「版本与更新」里按需触发。
        </p>
        <div class="hp-list" data-health-list>
          <div v-for="row in healthRows" :key="row.app.id" class="hp-row" :data-health-app="row.app.id" :data-health-source="row.health ? row.health?.effectiveSource : ''" :data-health-loadable="row.health ? (row.health.installedLoadable ? '1' : '0') : ''">
            <div class="hp-name">{{ row.app.name }} <small class="market-tag">{{ healthVersionText(row) }}</small></div>
            <div class="hp-cell">
              <DsBadge v-if="row.error" size="sm" tone="danger">健康检查失败</DsBadge>
              <DsBadge v-else-if="row.health" size="sm" :tone="row.health.installedLoadable ? 'success' : 'neutral'">{{ row.health.installedLoadable ? "已安装包可加载" : "使用内置/不可加载" }}</DsBadge>
              <span v-else class="set-cap">未读取</span>
            </div>
            <div class="hp-detail">
              <template v-if="row.error">
                <span class="tp-error">{{ thirdErrorText(row.error?.code || "") }} <code class="tp-code">{{ row.error?.code }}</code><span v-if="row.error?.detail"> · {{ row.error?.detail }}</span></span>
              </template>
              <template v-else-if="row.health">
                <span>生效来源：{{ row.health?.effectiveSource === "installed" ? "已安装版本" : "随包内置版本" }}</span>
                <span v-if="row.health?.loader"> · 加载器 <code class="tp-code">{{ row.health?.loader }}</code></span>
                <span v-if="row.health?.loadUrl"> · 加载地址 <code class="tp-code">{{ row.health?.loadUrl }}</code></span>
                <span v-if="row.health?.installed && row.health.installed.version"> · 已安装 v{{ row.health.installed.version }}<span v-if="row.health?.installed?.digest">（摘要 {{ row.health?.installed?.digest.slice(0, 12) }}…）</span></span>
                <span v-if="row.health?.fallbackReason"> · 回退原因 {{ healthFallbackText(row.health?.fallbackReason) }}</span>
                <span v-if="row.health?.installed && row.health.installed.detail"> · {{ row.health.installed.detail }}</span>
              </template>
              <span v-else class="set-cap">还没有读取到健康结果。</span>
            </div>
          </div>
          <p v-if="!healthRows.length && healthBusy" class="set-cap" role="status">正在读取全部应用的加载健康…</p>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.market-load-url {
  white-space: normal;
  overflow-wrap: anywhere;
}
.tp-notice {
  margin: 0 0 8px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: rgb(var(--text-rgb) / 0.045);
  font-size: var(--fs-caption);
  color: var(--text);
  overflow-wrap: anywhere;
}
.tp-error {
  margin: 0 0 8px;
  font-size: var(--fs-caption);
  color: var(--failed);
  overflow-wrap: anywhere;
}
.tp-code {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  overflow-wrap: anywhere;
}
.tp-input {
  box-sizing: border-box;
  flex: 1 1 240px;
  min-width: 0;
  min-height: 30px;
  padding: 5px 10px;
  border: 0;
  border-radius: var(--radius-md);
  background: var(--sunken);
  color: var(--text);
  font: inherit;
  font-size: var(--fs-secondary);
}
.tp-input:focus {
  outline: 2px solid var(--text);
  outline-offset: 1px;
}
.tp-source {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.tp-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tp-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  border-radius: var(--radius-lg);
  background: rgb(var(--text-rgb) / 0.035);
}
.tp-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.tp-name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: var(--fs-secondary);
  font-weight: var(--fw-medium);
}
.tp-meta {
  margin: 0;
  font-size: var(--fs-micro);
  color: var(--muted);
  overflow-wrap: anywhere;
}
.tp-sig {
  color: var(--muted);
}
.tp-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}
.tp-rejected {
  margin: 0;
  padding-left: 18px;
  font-size: var(--fs-caption);
  color: var(--muted);
  overflow-wrap: anywhere;
}
.hp-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.hp-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 12px;
  padding: 9px 14px;
  border-radius: var(--radius-md);
}
.hp-row + .hp-row {
  box-shadow: inset 0 0.5px 0 var(--line);
}
.hp-name {
  flex: none;
  min-width: 150px;
  font-size: var(--fs-secondary);
  font-weight: var(--fw-medium);
}
.hp-cell {
  flex: none;
}
.hp-detail {
  flex: 1 1 320px;
  min-width: 0;
  font-size: var(--fs-micro);
  color: var(--muted);
  overflow-wrap: anywhere;
}
@media (max-width: 900px) {
  .tp-row {
    flex-direction: column;
  }
  .tp-actions {
    align-self: flex-end;
  }
}
</style>
