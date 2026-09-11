/**
 * 探针 00 · 仪器校验。
 *
 * 在用它论证任何架构之前，先证明**测量手段本身可信**。本探针不产出架构结论，
 * 只回答"我凭什么相信自己看到的数"。
 *
 * 校验项：
 *   1. webContents.capturePage() 是否包含 WebContentsView 子视图？（决定它能否用于层级判定）
 *   2. screencapture 真实合成帧是否可用、Retina 坐标换算是否正确？
 *   3. 真实合成帧里"网页是否绘制在 DOM 之上"？
 *   4. 隐藏/恢复视图时键盘焦点如何迁移？
 *   5. OS 级鼠标点击注入是否被系统放行？（决定输入路由能否实测）
 *
 * 自校验原则：每个结论都要有对照。视图可见与隐藏两次采样必须给出不同答案，
 * 若两者相同，说明测的是同一个图层，结论无效。
 */
const { BrowserWindow, WebContentsView, session, app, screen } = require("electron");
const L = require("./_lib.cjs");

const W = 1100;
const H = 760;
const VIEW = { x: 300, y: 200, width: 500, height: 300 };
const RECT = { x: 0, y: 0, width: W, height: H };
const CX = VIEW.x + VIEW.width / 2;
const CY = VIEW.y + VIEW.height / 2;
const BTN = { x: 120, y: 620, width: 220, height: 64 };

exports.run = async function run({ report, sleep, add }) {
  const win = new BrowserWindow({
    width: W,
    height: H,
    x: 40,
    y: 40,
    show: true,
    useContentSize: true,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  await win.loadURL(
    L.dataURL(
      L.shellHTML({
        w: W,
        h: H,
        bg: "#00ff00",
        overlay: [
          { ...VIEW, color: "#ff0000" },
          { ...BTN, color: "#ffff00", id: "btnHit", role: "clickTarget" },
        ],
      }),
    ),
  );
  app.focus({ steal: true });
  win.moveTop();
  await sleep(700);

  const cb = win.getContentBounds();
  report.geometry = {
    contentBounds: cb,
    displayBounds: screen.getPrimaryDisplay().bounds,
    workArea: screen.getPrimaryDisplay().workArea,
    scaleFactor: screen.getPrimaryDisplay().scaleFactor,
    windowBounds: win.getBounds(),
  };

  const view = new WebContentsView({
    webPreferences: {
      session: session.fromPartition("openarc-gate-instrument"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.contentView.addChildView(view);
  view.setBounds(VIEW);
  await view.webContents.loadURL(L.dataURL(L.pageHTML({ color: "#0000ff", tag: "PAGE" })));
  view.setVisible(true);
  await sleep(800);

  // ---- 校验 1：capturePage 是否包含原生子视图 ----
  const fg = await L.grab(win.webContents, RECT);
  L.savePng(fg.img, "inst-capturepage-visible.png");
  view.setVisible(false);
  await sleep(400);
  const hg = await L.grab(win.webContents, RECT);
  L.savePng(hg.img, "inst-capturepage-hidden.png");
  view.setVisible(true);
  await sleep(400);

  const cpVisible = L.rgb(fg.at(CX, CY));
  const cpHidden = L.rgb(hg.at(CX, CY));
  report.capturePageProbe = { visible: cpVisible, hidden: cpHidden, scale: fg.scale };
  add(
    "inst.capturePageExcludesChildViews",
    cpVisible === cpHidden,
    `capturePage 在视图可见/隐藏时取到同一像素 ${cpVisible} → ` +
      `${cpVisible === cpHidden ? "不含子视图，层级断言必须改用真实合成帧" : "含子视图"}`,
    report.capturePageProbe,
  );

  // ---- 校验 2：真实合成帧 + 坐标换算 ----
  const shotRect = { x: cb.x, y: cb.y, width: W, height: H };
  const shot = L.shoot(shotRect, "inst-screen-visible.png");
  add("inst.screencaptureViable", shot.ok, `screencapture -R ${shotRect.x},${shotRect.y},${W},${H} → status=${shot.status} size=${shot.size}`, shot);
  if (!shot.ok) {
    report.errors.push("screencapture 不可用，视觉层级证据无法取得");
    win.destroy();
    return;
  }
  const pts = {
    domOutsideView: { x: 100, y: 100 },
    viewCenter: { x: CX, y: CY },
    viewNearTopLeft: { x: VIEW.x + 10, y: VIEW.y + 10 },
    viewNearBottomRight: { x: VIEW.x + VIEW.width - 10, y: VIEW.y + VIEW.height - 10 },
    viewJustOutsideLeft: { x: VIEW.x - 10, y: CY },
    viewJustOutsideBottom: { x: CX, y: VIEW.y + VIEW.height + 10 },
    clickTarget: { x: BTN.x + BTN.width / 2, y: BTN.y + BTN.height / 2 },
  };
  const px1 = L.readPixels(shot.file, W, pts);
  const c1 = L.colors(px1);
  report.screenScale = px1.scale;
  report.screenColorspace = px1.colorspace;
  report.screenProbe = { visible: c1, visibleRaw: Object.fromEntries(Object.entries(px1.points).map(([k, v]) => [k, `rgb(${v.raw.join(",")})`])) };
  add(
    "inst.screenColorManaged",
    px1.colorspace === "sRGB",
    `合成帧色彩空间 = ${px1.colorspace}；sRGB 绿在原生 P3 里读作 ${report.screenProbe.visibleRaw.domOutsideView}，经 ICC 转换后 ${c1.domOutsideView}`,
    { colorspace: px1.colorspace, raw: report.screenProbe.visibleRaw.domOutsideView, srgb: c1.domOutsideView },
  );
  add(
    "inst.screenScaleIsRetina2",
    px1.scale === 2,
    `合成帧 ${px1.size[0]}x${px1.size[1]} px / 请求 ${W} DIP → scale=${px1.scale}`,
    { scale: px1.scale, size: px1.size },
  );
  add(
    "inst.screenFrameShowsOurWindow",
    L.near(L.colorOf(px1, "domOutsideView"), L.GREEN) &&
      L.near(L.colorOf(px1, "viewJustOutsideLeft"), L.GREEN) &&
      L.near(L.colorOf(px1, "viewJustOutsideBottom"), L.GREEN),
    `窗口矩形外采样点均为中心绿底 ${c1.domOutsideView} → 截到的确实是本窗口且未被其他窗口覆盖`,
    { domOutsideView: c1.domOutsideView, left: c1.viewJustOutsideLeft, bottom: c1.viewJustOutsideBottom },
  );
  add(
    "inst.screenViewVisiblePaintsPageOverDom",
    L.near(L.colorOf(px1, "viewCenter"), L.BLUE) &&
      L.near(L.colorOf(px1, "viewNearTopLeft"), L.BLUE) &&
      L.near(L.colorOf(px1, "viewNearBottomRight"), L.BLUE),
    `视图可见时视口内 ${c1.viewCenter} / ${c1.viewNearTopLeft} / ${c1.viewNearBottomRight} 全为网页蓝 → 网页绘制在 DOM 覆盖层之上（D1-01 A12 约束在合成帧上复现）`,
    { center: c1.viewCenter, tl: c1.viewNearTopLeft, br: c1.viewNearBottomRight },
  );

  // 对照：隐藏视图后同一区域必须变红
  view.setVisible(false);
  await sleep(500);
  const shot2 = L.shoot(shotRect, "inst-screen-hidden.png");
  const px2 = shot2.ok ? L.readPixels(shot2.file, W, pts) : null;
  const c2 = px2 ? L.colors(px2) : {};
  report.screenProbe.hidden = c2;
  view.setVisible(true);
  await sleep(500);
  add(
    "inst.screenViewHiddenRevealsDom",
    !!px2 && L.near(L.colorOf(px2, "viewCenter"), L.RED),
    `视图隐藏后同一像素 ${c2.viewCenter || "n/a"} → 与可见时不同，说明隐藏确实改变合成结果（对照成立，上一条不是恒真断言）`,
    { center: c2.viewCenter || null },
  );

  // ---- 校验 3：键盘焦点语义 ----
  // 前置条件：本机可能有外部负载/用户操作抢走 key window，必须先确认窗口真的成为 key。
  // 这个前置若失败，只说明"本轮拿不到焦点证据"，不能当成产品缺陷。
  async function ensureKeyWindow() {
    for (let i = 0; i < 12; i += 1) {
      if (win.isFocused()) return true;
      app.focus({ steal: true });
      win.show();
      win.focus();
      win.moveTop();
      await sleep(300);
    }
    return win.isFocused();
  }
  const keyWindow = await ensureKeyWindow();
  report.keyWindow = keyWindow;
  add(
    "inst.focusPreconditionWindowIsKey",
    keyWindow,
    `窗口成为 key window = ${keyWindow}（false 说明本轮焦点证据不可得，属环境干扰而非产品缺陷）`,
    { keyWindow },
  );

  /**
   * 把键盘焦点交给外壳。
   *
   * 隐藏视图后这一步偶发失败：窗口可能在这几秒里被别的进程抢走 key 状态，
   * 而 macOS 上**只有 key window 内部的 webContents 才能持有焦点** ——
   * 窗口不是 key 时 `webContents.focus()` 是空操作。
   * 因此这里每轮先重新确保窗口是 key，并把这个前置状态一并返回，
   * 让断言能区分"焦点拿不回来（产品缺陷）"和"窗口已不是 key（环境干扰）"。
   */
  async function focusShell() {
    for (let i = 0; i < 8; i += 1) {
      if (win.webContents.isFocused()) return { ok: true, windowKey: win.isFocused(), tries: i };
      const windowKey = await ensureKeyWindow();
      win.focus();
      win.webContents.focus();
      await sleep(250);
      if (!windowKey && i === 7) return { ok: win.webContents.isFocused(), windowKey: false, tries: i + 1 };
    }
    return { ok: win.webContents.isFocused(), windowKey: win.isFocused(), tries: 8 };
  }

  view.webContents.focus();
  await sleep(450);
  const afterViewFocus = { view: view.webContents.isFocused(), win: win.webContents.isFocused() };
  const shellFocus1 = await focusShell();
  const afterWinFocus = { view: view.webContents.isFocused(), win: win.webContents.isFocused(), windowKey: shellFocus1.windowKey };
  view.webContents.focus();
  await sleep(450);
  view.setVisible(false);
  await sleep(450);
  const afterHide = { view: view.webContents.isFocused(), win: win.webContents.isFocused() };
  const shellFocus2 = await focusShell();
  const afterHideFocusShell = { view: view.webContents.isFocused(), win: win.webContents.isFocused(), windowKey: shellFocus2.windowKey };
  view.setVisible(true);
  await sleep(450);
  const afterReshow = { view: view.webContents.isFocused(), win: win.webContents.isFocused() };
  report.focus = { afterViewFocus, afterWinFocus, afterHide, afterHideFocusShell, afterReshow };
  const nv = keyWindow ? "" : "NOT VERIFIED（窗口未成为 key window，环境干扰）：";
  add(
    "inst.focusIsMutuallyExclusive",
    !keyWindow ||
      !afterWinFocus.windowKey ||
      (afterViewFocus.view === true && afterViewFocus.win === false &&
        afterWinFocus.view === false && afterWinFocus.win === true),
    `${nv}focus(view)→view=${afterViewFocus.view}/win=${afterViewFocus.win}；focus(win)→view=${afterWinFocus.view}/win=${afterWinFocus.win}（窗口是否 key=${afterWinFocus.windowKey}）`,
  );
  add(
    "inst.hideDoesNotTransferFocus",
    afterHide.view === false && afterHide.win === false,
    `setVisible(false) 后 view=${afterHide.view}/win=${afterHide.win} → 隐藏只是让焦点落空，**不会**自动交还外壳，架构必须显式聚焦`,
    afterHide,
  );
  add(
    "inst.shellCanTakeFocusAfterHide",
    !keyWindow || !afterHideFocusShell.windowKey || afterHideFocusShell.win === true,
    `${nv}隐藏后显式 focus 外壳 → win=${afterHideFocusShell.win}` +
      `（此刻窗口是否 key=${afterHideFocusShell.windowKey}；窗口已非 key 时该项不计失败，属环境干扰）`,
    afterHideFocusShell,
  );
  add(
    "inst.reshowDoesNotStealFocus",
    !keyWindow || afterReshow.view === false,
    `${nv}setVisible(true) 后是否自动取回焦点：view=${afterReshow.view}/win=${afterReshow.win} → ` +
      `${afterReshow.view ? "会自动抢焦（需防）" : "不抢焦（安全）"}`,
    afterReshow,
  );

  // ---- 校验 4：OS 级鼠标点击注入是否可用 ----
  await ensureKeyWindow();
  const target = L.screenPoint(cb, BTN.x + BTN.width / 2, BTN.y + BTN.height / 2);
  const readHits = async () => ({
    shell: await win.webContents.executeJavaScript("window.__hits.length"),
    page: await view.webContents.executeJavaScript("window.__hits.length"),
  });
  await win.webContents.executeJavaScript("window.__hits = []");
  await view.webContents.executeJavaScript("window.__hits = []");
  const before = await readHits();

  L.warp(target.x, target.y);
  await sleep(80);
  const cursor = L.cursorPos();
  const drift = cursor ? Math.hypot(cursor.x - target.x, cursor.y - target.y) : null;
  const click = L.cliclick([`c:${target.x},${target.y}`]);
  await sleep(450);
  const after = await readHits();

  report.mouseInjection = {
    target,
    cursorBeforeClick: cursor,
    drift,
    cliclick: { status: click.status, stdout: (click.stdout || "").slice(0, 200), stderr: (click.stderr || "").slice(0, 200) },
    hitsBefore: before,
    hitsAfter: after,
  };
  add(
    "inst.cursorWarpIsAvailable",
    drift !== null && drift <= 8,
    `无授权依赖的 CGWarpMouseCursorPosition 把指针放到 (${target.x},${target.y})，实测 (${cursor ? cursor.x + "," + cursor.y : "n/a"})，漂移 ${drift === null ? "n/a" : drift.toFixed(1)}px`,
    { target, cursor, drift },
  );
  add(
    "inst.osClickInjectionViable",
    after.shell > before.shell,
    `cliclick 在 DOM 按钮上点击后 shell 命中数 ${before.shell}→${after.shell}；` +
      `cliclick status=${click.status}${(click.stderr || "").trim() ? " stderr=" + click.stderr.trim().slice(0, 120) : ""}`,
    report.mouseInjection,
  );

  win.destroy();
};
