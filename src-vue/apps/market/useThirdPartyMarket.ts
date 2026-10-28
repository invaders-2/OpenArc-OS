import { computed, reactive, ref } from "vue";
import { t } from "../../i18n";
import { marketCall } from "./commandClient";
import { asText, normalizeHealth, normalizeThirdList, type ThirdApp, type ThirdHealth, type ThirdInstalled, type ThirdList, type ThirdRejected } from "./marketNormalization";

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
export const thirdErrorText = (code: string): string => THIRD_ERROR_TEXT[code] || t("操作失败（{code}）", { code });

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
export function healthFallbackText(reason: string | null | undefined): string {
  if (!reason) return "—";
  if (reason === "pointer-cleared") return t("没有安装指针（使用内置版本）");
  if (reason === "pointer-missing") return t("安装指针文件缺失");
  if (reason === "pointer-invalid") return t("安装指针无效");
  if (reason === "MARKET_UPDATE_NOT_READY") return t("公钥缺失或更新服务未就绪");
  if (reason === "MARKET_UPDATE_SIGNATURE_INVALID") return t("签名校验未通过");
  if (reason === "MARKET_UPDATE_DIGEST_MISMATCH") return t("内容摘要不一致");
  return reason;
}

export function useThirdPartyMarket({ matchesQuery }: { matchesQuery: (...values: string[]) => boolean }) {
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
    await Promise.all(thirdList.value.installed.map(async (item) => {
      try {
        const res = await marketCall("market/update/health", { appId: item.id });
        thirdHealth[item.id] = res.ok ? normalizeHealth(res.value) : {
          ok: false, effectiveSource: "unknown", installedLoadable: false, loader: null, loadUrl: null,
          fallbackReason: null, installed: null, error: res.error, detail: res.detail,
        };
      } catch {
        thirdHealth[item.id] = null;
      }
    }));
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
    thirdList.value = normalizeThirdList(res.value, t("原因未知"));
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
    thirdNotice.value = installed.alreadyInstalled === true
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

  function systemVersionText(): string {
    return thirdList.value ? thirdList.value.systemVersion : "—";
  }
  function compatibilityOf(app: ThirdApp): { ok: boolean; text: string } {
    const system = systemVersionText();
    if (!parseSemverText(system)) return { ok: false, text: t("系统版本未知，无法判定兼容性") };
    if (app.minSystemVersion && compareSemverText(system, app.minSystemVersion) < 0) return { ok: false, text: t("不兼容：需要系统 ≥ {min}，当前 {system}", { min: app.minSystemVersion, system }) };
    if (app.maxSystemVersion && compareSemverText(system, app.maxSystemVersion) > 0) return { ok: false, text: t("不兼容：最高支持系统 {max}，当前 {system}", { max: app.maxSystemVersion, system }) };
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
    if (health.effectiveSource === "builtin" && health.installed && health.installed.version) return t("已安装包不可加载，回退内置版本：{reason}", { reason: healthFallbackText(health.fallbackReason || (health.installed && health.installed.reason)) });
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

  return {
    thirdList, thirdLoaded, thirdListError, thirdBusy, thirdNotice, thirdActionError,
    thirdSourceUrl, thirdSourceDraft, thirdSourceError, thirdHealth, installPick, rollbackPick,
    localApps, onlineApps, installedApps, rejectedEntries, installedOf, catalogApps,
    loadThirdSource, loadThirdHealth, loadThirdParty, saveThirdSource,
    askInstall, askRollback, acceptInstall, acceptRollback,
    compatibilityOf, packageText, shaShort, signatureText, installedHealthText,
    localStateText, onlineStateText,
  };
}
