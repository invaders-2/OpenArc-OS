/**
 * 探针 04 · 候选 D：原生 child 窗口（§6 / §7）。
 *
 * 候选 D 的诱惑在于"让操作系统去做层级与裁剪"。本探针要分别测清它的**收益**与**代价**：
 *   收益：两个原生窗口之间的部分遮挡由 OS 精确裁剪（这正是单矩形视图做不到的）
 *   代价：child 窗口是独立 OS 窗口，父窗口里的 DOM 覆盖层**盖不住它**；
 *         它是真实窗口，会进入系统的窗口列表（Mission Control / 窗口切换）
 *
 * 另外测一个可能的补救手段：把外壳窗口临时提升到 child 之上（setAlwaysOnTop 层级），
 * 看能否让 DOM 覆盖层重新盖住浏览器窗口。
 */
const { BrowserWindow, app, screen } = require("electron");
const L = require("./_lib.cjs");

const W = 1100;
const H = 760;
const CHILD = { x: 300, y: 260, width: 480, height: 320 };
const DOMWIN = { x: 120, y: 140, width: 420, height: 280 };

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
  await win.loadURL(L.dataURL(L.shellGate()));
  app.focus({ steal: true });
  win.moveTop();
  await sleep(800);
  const cb0 = win.getContentBounds();
  const shellWindowsBefore = L.osWindows(process.pid);
  report.shell = { contentBounds: cb0, osWindowsBefore: shellWindowsBefore };

  const js = (c) => win.webContents.executeJavaScript(c);
  await js(`window.__set("wB", ${JSON.stringify(DOMWIN)})`);
  await sleep(300);

  /** 抓一帧并按屏幕 DIP 坐标采样（这里直接用屏幕坐标，跨窗口场景更直观）。 */
  async function shot(name, screenPoints) {
    const cb = win.getContentBounds();
    const s = L.shoot({ x: cb.x, y: cb.y, width: W, height: H }, name);
    if (!s.ok) throw new Error(`screencapture 失败 ${name}`);
    // 把屏幕 DIP 坐标换算成 rect 内坐标
    const local = Object.fromEntries(
      Object.entries(screenPoints).map(([k, p]) => [k, { x: p.x - cb.x, y: p.y - cb.y }]),
    );
    const px = L.readPixels(s.file, W, local);
    const c = L.colors(px);
    const at = (n) => {
      const m = (c[n] || "").match(/\d+/g);
      return m ? { r: +m[0], g: +m[1], b: +m[2] } : null;
    };
    return { file: s.file, c, at, is: (n, col) => L.near(at(n), col), cb };
  }

  // child 窗口的屏幕矩形 = 外壳内容区原点 + child 内容偏移
  const childScreen = { x: cb0.x + CHILD.x, y: cb0.y + CHILD.y, width: CHILD.width, height: CHILD.height };
  // child 页面把标签文字居中，所以正中不能采；改用左下内侧与两个对角
  const overlapRect = { x: CHILD.x - 120, y: CHILD.y - 20, width: 300, height: 240 };
  const points = {
    childLow: { x: childScreen.x + 40, y: childScreen.y + CHILD.height - 40 },
    childTopLeft: { x: childScreen.x + 14, y: childScreen.y + 14 },
    childBottomRight: { x: childScreen.x + CHILD.width - 14, y: childScreen.y + CHILD.height - 14 },
    childCorner: { x: childScreen.x + 3, y: childScreen.y + 3 },
    domWinVisible: { x: cb0.x + DOMWIN.x + 40, y: cb0.y + DOMWIN.y + 40 },
    domWinOnly: { x: childScreen.x - 60, y: childScreen.y + 100 },
    desk: { x: cb0.x + 60, y: cb0.y + 700 },
  };
  report.points = points;

  // ---- 建 child 窗口 ----
  const child = new BrowserWindow({
    parent: win,
    frame: false,
    transparent: true,
    hasShadow: false,
    roundedCorners: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    x: childScreen.x,
    y: childScreen.y,
    width: CHILD.width,
    height: CHILD.height,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  await child.loadURL(L.dataURL(L.pageHTML({ color: "#ff6600", tag: "CHILD" })));
  child.showInactive();
  await sleep(900);
  const gb = child.getBounds();
  report.child = { requested: childScreen, actualBounds: gb, isVisible: child.isVisible() };
  add(
    "child.createdAsNativeWindow",
    child.isVisible() && Math.abs(gb.x - childScreen.x) <= 2 && Math.abs(gb.y - childScreen.y) <= 2 &&
      gb.width === CHILD.width && gb.height === CHILD.height,
    `child.getBounds() = ${JSON.stringify(gb)}，请求 ${JSON.stringify({ x: childScreen.x, y: childScreen.y, width: CHILD.width, height: CHILD.height })}`,
    report.child,
  );

  const childWindows = L.osWindows(process.pid);
  report.child.osWindows = childWindows;
  add(
    "child.appearsInSystemWindowList",
    childWindows.count > shellWindowsBefore.count,
    `本进程在屏 OS 窗口数 ${shellWindowsBefore.count} → ${childWindows.count}；新增窗口 bounds ${JSON.stringify(childWindows.windows.filter((w) => w.w === CHILD.width))} → ` +
      `child 是真实 OS 窗口，会进入 Mission Control / 窗口切换（产品可见后果，不是"内部窗口"）`,
    { before: shellWindowsBefore, after: childWindows },
  );

  const m1 = await shot("04-child-over-shell.png", points);
  report.overShell = m1.c;
  add(
    "child.paintsAboveShellDom",
    m1.is("childLow", [255, 102, 0]) && m1.is("childTopLeft", [255, 102, 0]) && m1.is("childBottomRight", [255, 102, 0]),
    `child 区域内三处采样 ${m1.c.childLow} / ${m1.c.childTopLeft} / ${m1.c.childBottomRight} 全为 child 页面色 → 原生 child 窗口绘在外壳之上`,
    m1.c,
  );

  // ---- DOM 覆盖层能否盖住 child ----
  await js(`window.__set("wB", { x: ${childScreen.x - cb0.x - 20}, y: ${childScreen.y - cb0.y - 20}, width: ${CHILD.width + 40}, height: ${CHILD.height + 40} })`);
  await sleep(500);
  const m2 = await shot("04-dom-over-child.png", points);
  report.domOverChild = m2.c;
  add(
    "child.shellDomCannotCoverChild",
    m2.is("childLow", [255, 102, 0]) && !m2.is("childLow", L.YELLOW),
    `把 DOM 窗口 B（黄）放大到完全覆盖 child 区域后，child 内仍是 ${m2.c.childLow} → **外壳里的 DOM 覆盖层盖不住原生 child 窗口**`,
    m2.c,
  );

  // ---- 提升外壳窗口层级能否反过来盖住 child ----
  child.setAlwaysOnTop(false);
  win.setAlwaysOnTop(true, "floating");
  win.moveTop();
  await sleep(900);
  const m3 = await shot("04-shell-raised.png", points);
  report.shellRaised = { colors: m3.c, winAlwaysOnTop: win.isAlwaysOnTop(), childAlwaysOnTop: child.isAlwaysOnTop() };
  const shellCovered = m3.is("childLow", L.YELLOW);
  add(
    "child.shellCannotBeRaisedAboveChild",
    !shellCovered,
    `外壳 setAlwaysOnTop(true,"floating") + moveTop 后 child 内仍为 ${m3.c.childLow}（child 内容色）→ ` +
      `**父窗口无法被抬到自己的 child 窗口之上**（win.isAlwaysOnTop=${report.shellRaised.winAlwaysOnTop} 已生效但无效）。` +
      `这意味着候选 D 下，外壳里的任何 DOM 覆盖层（右键菜单 / 对话框 / 搜索 / AI 面板）都永远盖不住浏览器窗口`,
    report.shellRaised,
  );
  win.setAlwaysOnTop(true);
  win.moveTop();
  await sleep(700);

  // ---- child 与 DOM 窗口的部分遮挡 ----
  // 把 DOM 窗口 B 移到与 child 部分重叠；child 是独立窗口，OS 会精确裁剪
  await js(`window.__set("wB", ${JSON.stringify(overlapRect)})`);
  await sleep(700);
  const m4 = await shot("04-partial-overlap.png", points);
  report.partialOverlap = { domWindow: overlapRect, colors: m4.c };
  add(
    "child.partialOverlapClippedByOs",
    m4.is("childLow", [255, 102, 0]) && m4.is("domWinOnly", L.YELLOW),
    `DOM 窗口 B 与 child 部分重叠（同一帧内同时采样）：child 矩形内 ${m4.c.childLow} 完整可见（child 在上），` +
      `child 之外的 B 部分 ${m4.c.domWinOnly} 正常显示 → 两个原生窗口之间的部分遮挡由 OS 精确裁剪，` +
      `这是单矩形原生视图做不到的（对照 01 号探针：同场景下原生视图只能整块隐藏或收缩）`,
    m4.c,
  );

  // ---- 圆角与透明 ----
  const m5 = await shot("04-child-corner.png", points);
  report.childCorner = { corner: m5.c.childCorner };
  add(
    "child.roundedCornersApplied",
    !m5.is("childCorner", [255, 102, 0]),
    `child（roundedCorners: true）左上角 3px 处采样 ${m5.c.childCorner}，不是 child 内容色 → 圆角由窗口形状承担，原生窗口支持真实圆角`,
    report.childCorner,
  );

  child.destroy();
  await sleep(600);
  const after = L.osWindows(process.pid);
  report.afterChildDestroy = after;
  add(
    "child.destroyRemovesSystemWindow",
    after.count === shellWindowsBefore.count,
    `销毁 child 后本进程在屏 OS 窗口数回到 ${after.count}（初始 ${shellWindowsBefore.count}）`,
    { before: shellWindowsBefore, after },
  );

  win.destroy();
};
