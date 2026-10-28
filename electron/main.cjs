const { app, protocol } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  registerFileProtocolScheme,
  registerResourceProtocolSchemes,
  createTrustedSender,
  installShellSecurityPolicies,
  installCertificateErrorPolicy,
} = require("./security-policies.cjs");
const { bootRuntime, registerRuntimeDomains } = require("./runtime-composition.cjs");
const { registerFilesIpc } = require("./files-ipc.cjs");
const { installDisplayHandlers, registerWindowBrowserIpc } = require("./window-browser-ipc.cjs");
const {
  installApplicationMenu,
  createShellWindow,
  recoverFromStartupFailure,
  installWindowClosedHandler,
  loadShell,
  installAppLifecycle,
} = require("./app-lifecycle.cjs");

// 唯一组合根：协议注册仍在 app ready 前，服务实例全部由同一 context 共享。
registerFileProtocolScheme({ app, protocol });

const devURL = process.env.OA_DEV_SERVER ? new URL(process.env.OA_DEV_SERVER).href : null;
const devOrigin = devURL ? new URL(devURL).origin : null;
const UI_ENTRY = process.env.OA_UI === "react" ? "index.html" : "vue.html";
const uiURL = devURL || pathToFileURL(path.join(__dirname, "../dist/" + UI_ENTRY)).href;
if (devURL) console.log("[openarc] 开发预览：加载 " + devURL + "（OA_DEV_SERVER 已设置）");
registerResourceProtocolSchemes({ protocol });

const isMac = process.platform === "darwin";
/**
 * 仅测试用的平台覆盖（截图 / 自动化验收）：在任意宿主上渲染指定平台的窗口 chrome。
 *
 * 只认 win32 / darwin 两个字面值，其它值一律忽略；不设置时等于真实平台，
 * 所以生产路径与改动前完全等价（tests/win-titlebar.test.mjs 锁住这一点）。
 * 它只决定**窗口 chrome 与上报的平台**；应用菜单的角色跟随真实 OS（那是系统级行为），
 * 玻璃材质也跟随真实 OS（mica 只有 Windows 有）。
 */
const FORCED_PLATFORM =
  process.env.OA_FORCE_PLATFORM === "win32" || process.env.OA_FORCE_PLATFORM === "darwin"
    ? process.env.OA_FORCE_PLATFORM
    : "";
const uiPlatform = FORCED_PLATFORM || process.platform;
const isMacChrome = uiPlatform === "darwin";
if (FORCED_PLATFORM) {
  console.warn("[openarc] OA_FORCE_PLATFORM=" + FORCED_PLATFORM + "（仅测试用平台覆盖；真实平台 " + process.platform + "）");
}
const glass = isMac
  ? { transparent: true, vibrancy: "under-window", backgroundColor: "#00000000" }
  : { backgroundMaterial: "mica", backgroundColor: "#00000000" };

const context = {
  win: null,
  controller: null,
  identity: null,
  files: null,
  identityBootFailure: null,
  browserControl: null,
  mediaBundle: null,
  automationBundle: null,
  platformBundle: null,
  uiURL,
  uiPlatform,
  isMacChrome,
  glass,
  displayInfo: null,
  trusted: null,
};
context.trusted = createTrustedSender({ getWindow: () => context.win, uiURL, devOrigin });

app.whenReady().then(async () => {
  installApplicationMenu({ isMac });
  // runtime-boot.cjs 保证 identity 先于 modelProxy.start；不得在组合根另起顺序。
  await bootRuntime(context);
  createShellWindow(context);
  installDisplayHandlers(context);
  installShellSecurityPolicies({ win: context.win, uiURL, devOrigin });
  registerRuntimeDomains(context);
  registerFilesIpc(context);
  registerWindowBrowserIpc(context);
  installCertificateErrorPolicy({ app, getWindow: () => context.win });
  installWindowClosedHandler(context);
  loadShell(context);
}).catch((error) => recoverFromStartupFailure(context, error));

// 与改动前相同：退出监听在主模块求值阶段登记，重复 quit 由 lifecycle 内部守卫。
installAppLifecycle(context);
