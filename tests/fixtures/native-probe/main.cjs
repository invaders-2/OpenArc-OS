/**
 * D1-01 原生能力探针（在真实 Electron 主进程中运行）。
 * 由 tests/native-view.mjs 拉起，不依赖 Playwright，因此不受浏览器驱动版本限制。
 */
const { app, BrowserWindow, WebContentsView, screen, session } = require("electron");
const path = require("node:path");
const geometry = require("../../../electron/geometry.cjs");
const { safeURL } = require("../../../electron/policy.cjs");

const out = (line) => process.stdout.write(line + "\n");
const report = { checks: [], versions: {}, displays: [], errors: [] };
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok: !!ok, detail: String(detail) });
  out(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    report.versions = {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform + "/" + process.arch,
    };
    report.displays = screen.getAllDisplays().map((d) => ({
      id: d.id,
      scaleFactor: d.scaleFactor,
      workArea: d.workArea,
      internal: d.internal,
    }));
    check("Environment: 主进程报告版本信息", true, JSON.stringify(report.versions));
    check(
      "Environment: 能读取显示器与缩放",
      report.displays.length > 0,
      JSON.stringify(report.displays),
    );

    const page = path.join(__dirname, "page.html");

    // ---------- 原生窗口生命周期 ----------
    const win = new BrowserWindow({
      width: 900,
      height: 600,
      x: 60,
      y: 60,
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    await win.loadFile(page);
    win.show();
    await sleep(300);
    check("Desktop: 创建原生 BrowserWindow", !!win && !win.isDestroyed());
    check("Desktop: 窗口可见", win.isVisible());

    win.minimize();
    await sleep(300);
    check("Desktop: 最小化生效", win.isMinimized());
    win.restore();
    await sleep(300);
    check("Desktop: 恢复生效", !win.isMinimized());
    win.maximize();
    await sleep(300);
    check("Desktop: 最大化生效", win.isMaximized());
    win.unmaximize();
    await sleep(200);
    check("Desktop: 还原生效", !win.isMaximized());

    win.setBounds({ x: 123, y: 77, width: 800, height: 500 });
    const rt = win.getBounds();
    check(
      "Desktop: 位置与尺寸可设置并读回",
      rt.x === 123 && rt.y === 77 && rt.width === 800 && rt.height === 500,
      JSON.stringify(rt),
    );

    // ---------- 渲染进程隔离（不可信页面视角）----------
    const uiGlobals = await win.webContents.executeJavaScript(
      "({require:typeof window.require,process:typeof window.process})",
    );
    check(
      "Security: 界面渲染进程无 Node 全局",
      uiGlobals.require === "undefined" && uiGlobals.process === "undefined",
      JSON.stringify(uiGlobals),
    );

    // ---------- 真实 WebContentsView ----------
    const isolated = session.fromPartition("openarc-native-probe");
    isolated.setPermissionRequestHandler((_w, _p, cb) => cb(false));
    const view = new WebContentsView({
      webPreferences: {
        session: isolated,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    check(
      "BrowserView: 构造出真实 WebContentsView（非 iframe）",
      view.constructor.name === "WebContentsView",
      view.constructor.name,
    );

    win.contentView.addChildView(view);
    view.setBounds({ x: 20, y: 120, width: 400, height: 300 });
    view.setVisible(true);
    await view.webContents.loadURL("data:text/html,<h1>view</h1>");
    check("BrowserView: 挂载并可导航", true, view.webContents.getURL().slice(0, 40));

    const b1 = view.getBounds();
    check(
      "BrowserView: bounds 可设置",
      b1.x === 20 && b1.y === 120 && b1.width === 400 && b1.height === 300,
      JSON.stringify(b1),
    );
    view.setBounds({ x: 40, y: 140, width: 320, height: 240 });
    const b2 = view.getBounds();
    check(
      "BrowserView: move/resize 生效",
      b2.x === 40 && b2.y === 140 && b2.width === 320 && b2.height === 240,
      JSON.stringify(b2),
    );
    view.setVisible(false);
    check("BrowserView: hide 生效", !view.getVisible());
    view.setVisible(true);
    check("BrowserView: show 生效", view.getVisible());

    // 导航策略：接入与 electron/main.cjs 相同的策略后，非 http(s) 必须被阻止。
    // 注意：WebContentsView 默认并不拦 file://，保护来自 OpenArc 的策略层。
    let prevented = 0;
    view.webContents.on("will-navigate", (e, url) => {
      if (!safeURL(url)) {
        e.preventDefault();
        prevented += 1;
      }
    });
    // 主进程 loadURL 不受 will-navigate 约束，保护来自调用前的 safeURL 预校验
    check(
      "BrowserView: 策略层拒绝非 http(s) 地址",
      safeURL("file:///etc/passwd") === null &&
        safeURL("javascript:alert(1)") === null &&
        safeURL("https://example.com") !== null,
    );
    // 页面内跳转由 will-navigate 拦截
    await view.webContents.loadURL(
      "data:text/html,<a id=go href='file:///etc/passwd'>go</a>",
    );
    await view.webContents.executeJavaScript("document.getElementById('go').click()");
    await sleep(600);
    const afterClick = view.webContents.getURL();
    check(
      "BrowserView: 页面内跳转到 file:// 被阻止",
      !afterClick.startsWith("file:"),
      `prevented=${prevented} url=${afterClick.slice(0, 40)}`,
    );
    await view.webContents.loadURL("data:text/html,<h1>reload</h1>");
    view.webContents.reload();
    check("BrowserView: reload 不抛错", true);

    // ---------- 安全：网页侧能力 ----------
    const viewGlobals = await view.webContents.executeJavaScript(
      "({require:typeof window.require,process:typeof window.process,module:typeof window.module,ipc:typeof window.ipcRenderer,openarc:typeof window.openarc})",
    );
    check(
      "A13: 不可信网页拿不到 Node / IPC / 系统桥接",
      Object.values(viewGlobals).every((v) => v === "undefined"),
      JSON.stringify(viewGlobals),
    );
    check(
      "A13: 网页与界面使用不同会话分区",
      win.webContents.session !== view.webContents.session,
    );

    // ---------- 原生层级与焦点 ----------
    const second = new BrowserWindow({ width: 300, height: 200, show: false });
    await second.loadFile(page);
    second.show();
    // macOS 下应用未激活时 focus() 不一定立即生效，重试后再断言
    const focusWithRetry = async (w) => {
      for (let i = 0; i < 8 && !w.isFocused(); i += 1) {
        w.focus();
        await sleep(250);
      }
      return w.isFocused();
    };
    const firstFocused = await focusWithRetry(win);
    const secondFocused = await focusWithRetry(second);
    check(
      "Desktop: 多原生窗口焦点可切换且互斥",
      firstFocused && secondFocused && !win.isFocused(),
      `first=${firstFocused} second=${secondFocused} firstNow=${win.isFocused()}`,
    );
    check(
      "Desktop: 可枚举多个原生窗口",
      BrowserWindow.getAllWindows().length === 2,
      String(BrowserWindow.getAllWindows().length),
    );
    second.destroy();
    check(
      "Desktop: 销毁窗口生效",
      BrowserWindow.getAllWindows().length === 1,
      String(BrowserWindow.getAllWindows().length),
    );

    // ---------- A05：屏幕外检测与归位（使用项目共享几何模块）----------
    const areas = screen.getAllDisplays().map((d) => d.workArea);
    const offscreen = { x: areas[0].x + areas[0].width + 400, y: 200, w: 600, h: 400 };
    const clamped = geometry.clampWindow(offscreen, areas);
    // 原始值确实在可见区之外，收拢后完整落回工作区
    const rawOutside = !areas.some((a) => geometry.inside(geometry.rectOf(offscreen), a));
    const clampedInside = areas.some((a) => geometry.inside(geometry.rectOf(clamped), a));
    check(
      "A05: 屏幕外窗口可被检测并收拢回可见区",
      rawOutside && clampedInside,
      `raw=${JSON.stringify(offscreen)} -> clamped=${JSON.stringify(clamped)}`,
    );

    win.destroy();
    check("Desktop: 关闭窗口生效", win.isDestroyed());

    out("RESULT " + JSON.stringify(report));
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
    out("RESULT " + JSON.stringify(report));
  }
  app.quit();
});
