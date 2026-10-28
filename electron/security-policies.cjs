const path = require("node:path");
const { pathToFileURL } = require("node:url");

/** 只读文件协议必须在 app ready 前登记；安全探针在 ready 后加载 main 时保持既有跳过行为。 */
function registerFileProtocolScheme({ app, protocol }) {
  if (app.isReady()) return;
  protocol.registerSchemesAsPrivileged([
    { scheme: "openarc-file", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  ]);
}

/** 安全预览、画布与已安装应用包协议；渲染层只拿 capability URL，不接触本地路径。 */
function registerResourceProtocolSchemes({ protocol }) {
  protocol.registerSchemesAsPrivileged([
    { scheme: "openarc-resource", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false } },
    { scheme: "openarc-canvas", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
    { scheme: "openarc-app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  ]);
}

/** D1-05 冻结的 sender + senderFrame.url 双重边界。 */
function createTrustedSender({ getWindow, uiURL, devOrigin }) {
  return function trusted(event) {
    const win = getWindow();
    if (event.sender !== win?.webContents) return false;
    const url = event.senderFrame?.url;
    if (url === uiURL) return true;
    return devOrigin !== null && typeof url === "string" && url.startsWith(devOrigin + "/");
  };
}

function installShellSecurityPolicies({ win, uiURL, devOrigin }) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (url === uiURL) return;
    if (devOrigin !== null && url.startsWith(devOrigin + "/")) return;
    event.preventDefault();
    try { console.warn("[openarc] 已拦截应用内导航出网（主框架）：", String(url).slice(0, 300)); } catch { /* ignore */ }
    globalThis.__OPENARC_BLOCKED_NAVIGATIONS__ = (globalThis.__OPENARC_BLOCKED_NAVIGATIONS__ || []).concat([{ url: String(url).slice(0, 300), isMainFrame: true, at: Date.now() }]);
  });

  const appDir = pathToFileURL(path.join(__dirname, "..", "dist")).toString();
  const isAppPage = (url) => {
    if (typeof url !== "string") return false;
    if (url.startsWith(appDir)) return true;
    return devOrigin !== null && url.startsWith(devOrigin + "/");
  };
  const micOnly = (url, mediaTypes) => {
    const types = Array.isArray(mediaTypes) && mediaTypes.length ? mediaTypes : ["audio"];
    return isAppPage(url) && types.includes("audio") && !types.includes("video");
  };
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission !== "media") return callback(true);
    callback(micOnly(details?.requestingUrl || wc?.getURL?.(), details?.mediaTypes));
  });
  win.webContents.session.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    if (permission !== "media") return true;
    return micOnly(details?.requestingUrl || requestingOrigin || wc?.getURL?.(), details?.mediaTypes);
  });

  const NAV_ALLOWED = (url) => {
    const value = String(url || "");
    if (value === uiURL) return true;
    if (value === "about:blank") return true;
    if (value.startsWith("openarc-canvas://bundle/")) return true;
    return false;
  };
  const blockedNavigations = [];
  const onFrameNavigate = (...args) => {
    const first = args[0];
    const isDetails = !!first && typeof first === "object" && typeof first.url === "string";
    const event = first;
    const url = isDetails ? first.url : args[1];
    const isMainFrame = isDetails ? !!first.isMainFrame : !!args[3];
    if (NAV_ALLOWED(String(url))) return;
    try { if (event && typeof event.preventDefault === "function") event.preventDefault(); } catch { /* 拦不住也要留证 */ }
    const row = { url: String(url).slice(0, 300), isMainFrame, at: Date.now() };
    blockedNavigations.push(row);
    if (blockedNavigations.length > 50) blockedNavigations.shift();
    globalThis.__OPENARC_BLOCKED_NAVIGATIONS__ = blockedNavigations;
    try { console.warn("[openarc] 已拦截应用内导航出网：", row.url); } catch { /* ignore */ }
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send("native:state", { type: "canvas-navigation-blocked", url: row.url, isMainFrame: row.isMainFrame, at: row.at });
    }
  };
  if (typeof win.webContents.on === "function") {
    try { win.webContents.on("will-frame-navigate", (...args) => onFrameNavigate(...args)); } catch { /* 旧版本没有该事件 */ }
  }
  globalThis.__OPENARC_BLOCKED_NAVIGATIONS__ = blockedNavigations;
}

/** 证书错误一律 fail closed，没有“继续访问”旁路。 */
function installCertificateErrorPolicy({ app, getWindow }) {
  app.on("certificate-error", (event, _wc, url, error, _certificate, callback) => {
    event.preventDefault();
    callback(false);
    const win = getWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send("native:state", { type: "certificate-error", url: String(url || ""), error: String(error || "") });
    }
  });
}

module.exports = {
  registerFileProtocolScheme,
  registerResourceProtocolSchemes,
  createTrustedSender,
  installShellSecurityPolicies,
  installCertificateErrorPolicy,
};
