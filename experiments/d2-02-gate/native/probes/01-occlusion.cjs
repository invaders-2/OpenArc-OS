/**
 * 探针 01 · 遮挡与层级（真实合成帧）。
 *
 * 回答：
 *   · DOM 窗口压住网页视口时，到底谁在谁上面？（视觉真值）
 *   · 全遮挡时"整块隐藏原生视图"能不能救？
 *   · **部分遮挡**时"整块隐藏"和"收缩 bounds"分别付出什么代价？
 *   · 单矩形原生视图能否正确表达一般性的部分遮挡？
 *   · 圆角窗口下方形原生视图会不会从圆角处漏出来？
 *
 * 判据全部来自 screencapture 真实合成帧（经 ICC→sRGB 色彩管理），
 * 因为实测 webContents.capturePage() 不包含 WebContentsView 子视图。
 */
const { BrowserWindow, WebContentsView, session, app } = require("electron");
const L = require("./_lib.cjs");

const { W, H, A, B0, C, VIEWPORT } = L.LAYOUT;

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

  const view = new WebContentsView({
    webPreferences: {
      session: session.fromPartition("openarc-gate-occlusion"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.contentView.addChildView(view);
  await view.webContents.loadURL(L.dataURL(L.pageHTML({ color: "#0000ff", tag: "PAGE" })));
  view.setBounds(VIEWPORT);
  view.setVisible(true);
  await sleep(700);

  const js = (code) => win.webContents.executeJavaScript(code);
  const pageJs = (code) => view.webContents.executeJavaScript(code);
  const setB = (r) => js(`window.__set("wB", ${JSON.stringify(r)})`);
  const setView = (r) => {
    view.setBounds(r);
    view.setVisible(r.width > 0 && r.height > 0);
  };

  /** 抓一帧真实合成帧，并按锚点 + 额外点在 sRGB 下采样。 */
  async function measure(name, extra = {}) {
    const cb = win.getContentBounds();
    const vp = await js("window.__vp()");
    const pts = { ...L.anchorPoints(vp), ...extra };
    const s = L.shoot({ x: cb.x, y: cb.y, width: W, height: H }, name);
    if (!s.ok) throw new Error(`screencapture 失败：${name} status=${s.status} size=${s.size}`);
    const px = L.readPixels(s.file, W, pts);
    const c = L.colors(px);
    const at = (n) => {
      const m = (c[n] || "").match(/\d+/g);
      return m ? { r: +m[0], g: +m[1], b: +m[2] } : null;
    };
    return { name, file: s.file, vp, px, c, at, is: (n, col) => L.near(at(n), col), colors: c };
  }

  /** 真实 OS 级点击：返回两侧命中数。漂移过大视为环境干扰，重试一次。 */
  async function clickAt(dipX, dipY, label) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await js("window.__hits = []");
      await pageJs("window.__hits = []");
      const cb = win.getContentBounds();
      const p = L.screenPoint(cb, dipX, dipY);
      L.warp(p.x, p.y);
      await sleep(70);
      const cur = L.cursorPos();
      const drift = cur ? Math.hypot(cur.x - p.x, cur.y - p.y) : null;
      if (drift !== null && drift > 8) {
        await sleep(250);
        continue;
      }
      L.cliclick([`c:${p.x},${p.y}`]);
      await sleep(400);
      const shell = await js("window.__hits");
      const page = await pageJs("window.__hits");
      return {
        label,
        attempt: attempt + 1,
        dip: { x: dipX, y: dipY },
        screen: p,
        drift,
        valid: drift !== null && drift <= 8,
        domHits: shell.length,
        pageHits: page.length,
        domTargets: shell.map((h) => h.target),
        pageEvents: page.map((h) => h.t),
      };
    }
    return { label, valid: false, drift: null, domHits: 0, pageHits: 0, note: "环境干扰导致点击未送达" };
  }
  const desc = (r) =>
    `[${r.label}] DOM ${r.domHits} 次${r.domTargets?.length ? "(" + r.domTargets.join(",") + ")" : ""} / 网页 ${r.pageHits} 次` +
    `${r.valid ? "" : " ⚠️漂移过大，本次无效"}`;
  const toDom = (r) => r.valid && r.domHits > 0 && r.pageHits === 0;
  const toPage = (r) => r.valid && r.pageHits > 0 && r.domHits === 0;

  // ===================== 基线：无遮挡 =====================
  await setB(B0);
  setView(VIEWPORT);
  await sleep(500);
  const m1 = await measure("01-baseline.png");
  report.baseline = m1.c;
  add(
    "occl.baseline.allSurfacesPainted",
    m1.is("aCenter", L.MAGENTA) && m1.is("bCenter", L.YELLOW) && m1.is("vCenter", L.BLUE) &&
      m1.is("vLeft", L.BLUE) && m1.is("vRight", L.BLUE) && m1.is("desktop", L.GREEN),
    `A=${m1.c.aCenter} B=${m1.c.bCenter} 视口=${m1.c.vCenter} 桌面=${m1.c.desktop}`,
    m1.c,
  );
  const k1 = await clickAt(VIEWPORT.x + VIEWPORT.width / 2, VIEWPORT.y + VIEWPORT.height / 2, "基线·视口中心");
  const k2 = await clickAt(B0.x + B0.width / 2, B0.y + B0.height / 2, "基线·DOM 窗口 B");
  report.clicks = { baselineViewport: k1, baselineDom: k2 };
  add("occl.baseline.clickInViewportGoesToPage", toPage(k1), desc(k1), k1);
  add("occl.baseline.clickOnDomWindowGoesToDom", toDom(k2), desc(k2), k2);

  // ===================== 全遮挡：B 完全盖住视口 =====================
  await setB(VIEWPORT);
  await sleep(450);
  const m2 = await measure("01-full-overlap-nomitigation.png");
  report.fullOverlap = { before: m2.c };
  add(
    "occl.full.pagePaintsOverDomWindow",
    m2.is("vCenter", L.BLUE) && m2.is("vLeft", L.BLUE) && m2.is("vRight", L.BLUE),
    `B 完全覆盖视口且 DOM 内 z 序高于浏览器外壳，视口内仍是网页 ${m2.c.vCenter} → DOM 层级对原生视图无效`,
    m2.c,
  );
  add(
    "occl.full.domWindowBodyEntirelyHidden",
    !m2.is("vCenter", L.YELLOW),
    `被盖住的 B 在合成帧里找不到黄色（vCenter=${m2.c.vCenter}）→ B"在最上层"只是 DOM 内部事实`,
    { vCenter: m2.c.vCenter },
  );
  const k3 = await clickAt(VIEWPORT.x + VIEWPORT.width / 2, VIEWPORT.y + VIEWPORT.height / 2, "全遮挡·重叠区");
  report.fullOverlap.clickNoMitigation = k3;
  add("occl.full.clickInOverlapGoesToPage", toPage(k3), `${desc(k3)} → 鼠标输入跟随真实层级`, k3);

  view.setVisible(false);
  await sleep(500);
  const m3 = await measure("01-full-overlap-hidden.png");
  report.fullOverlap.afterHide = m3.c;
  add(
    "occl.full.hideMitigationRevealsDom",
    m3.is("vCenter", L.YELLOW),
    `整块隐藏原视视图后重叠区变为 ${m3.c.vCenter}（B 的黄）`,
    { vCenter: m3.c.vCenter },
  );
  const k4 = await clickAt(VIEWPORT.x + VIEWPORT.width / 2, VIEWPORT.y + VIEWPORT.height / 2, "全遮挡·隐藏后");
  report.fullOverlap.clickAfterHide = k4;
  add("occl.full.clickGoesToDomAfterHide", toDom(k4), desc(k4), k4);
  setView(VIEWPORT);
  await sleep(400);

  // ===================== 部分遮挡：B 压住视口左侧 =====================
  const B_LEFT = { x: 200, y: VIEWPORT.y, width: 350, height: VIEWPORT.height };
  const extraLeft = { bOutsideViewport: { x: 250, y: VIEWPORT.y + VIEWPORT.height / 2 } };
  const overlapW = B_LEFT.x + B_LEFT.width - VIEWPORT.x;
  const freeW = VIEWPORT.width - overlapW;
  await setB(B_LEFT);
  setView(VIEWPORT);
  await sleep(500);
  const m4 = await measure("01-partial-left-nomitigation.png", extraLeft);
  report.partialLeft = {
    viewport: VIEWPORT,
    domWindow: B_LEFT,
    overlapWidth: overlapW,
    unobstructedWidth: freeW,
    viewportArea: VIEWPORT.width * VIEWPORT.height,
    unobstructedArea: freeW * VIEWPORT.height,
    before: m4.c,
  };
  add(
    "occl.partial.pagePaintsOverOverlappingPart",
    m4.is("vLeft", L.BLUE),
    `重叠处采样 ${m4.c.vLeft} 为网页蓝 → 网页盖住了 B 的重叠部分`,
    { vLeft: m4.c.vLeft },
  );
  add(
    "occl.partial.domVisibleOnlyOutsideViewport",
    m4.is("bOutsideViewport", L.YELLOW),
    `B 在视口之外的部分仍可见（${m4.c.bOutsideViewport}）→ 合成结果被切成两段，视觉已不自洽`,
    { bOutsideViewport: m4.c.bOutsideViewport },
  );

  view.setVisible(false);
  await sleep(500);
  const m5 = await measure("01-partial-left-hidden.png");
  const lostArea = freeW * VIEWPORT.height;
  report.partialLeft.hideCost = {
    after: m5.c,
    lostDipArea: lostArea,
    lostRatio: lostArea / (VIEWPORT.width * VIEWPORT.height),
  };
  add(
    "occl.partial.hideLosesUnobstructedArea",
    !m5.is("vRight", L.BLUE) && m5.is("vRight", [128, 128, 128]),
    `右侧本应可见的 ${freeW}×${VIEWPORT.height} DIP（占视口 ${((lostArea / (VIEWPORT.width * VIEWPORT.height)) * 100).toFixed(0)}%）也一并消失：` +
      `采样 ${m5.c.vRight} = 浏览器外壳灰，不是网页 → 整块隐藏的代价是"未遮挡区域一起丢"`,
    report.partialLeft.hideCost,
  );

  const SHRUNK = { x: B_LEFT.x + B_LEFT.width, y: VIEWPORT.y, width: freeW, height: VIEWPORT.height };
  setView(SHRUNK);
  await sleep(500);
  const m6 = await measure("01-partial-left-rectshrink.png");
  report.partialLeft.rectShrink = { bounds: SHRUNK, after: m6.c };
  add(
    "occl.partial.rectShrinkKeepsPageVisible",
    m6.is("vRight", L.BLUE),
    `收缩到未遮挡矩形 ${JSON.stringify(SHRUNK)} 后右侧 ${m6.c.vRight} 仍为网页`,
    { vRight: m6.c.vRight },
  );
  add(
    "occl.partial.rectShrinkRevealsDomInOverlap",
    m6.is("vLeft", L.YELLOW),
    `重叠区采样 ${m6.c.vLeft}（期望 B 的黄）→ 收缩后 DOM 恢复可见，视觉与输入同时正确`,
    { vLeft: m6.c.vLeft },
  );
  const k5 = await clickAt(VIEWPORT.x + VIEWPORT.width - 60, VIEWPORT.y + VIEWPORT.height / 2, "部分遮挡·收缩后未遮挡区");
  const k6 = await clickAt(VIEWPORT.x + 60, VIEWPORT.y + VIEWPORT.height / 2, "部分遮挡·收缩后重叠区");
  report.partialLeft.clicks = [k5, k6];
  add("occl.partial.clickInVisibleAreaGoesToPage", toPage(k5), desc(k5), k5);
  add("occl.partial.clickInOverlapGoesToDom", toDom(k6), desc(k6), k6);

  // ===================== 部分遮挡：B 压住视口中心（剩余为非矩形） =====================
  const B_CENTER = { x: 450, y: 430, width: 200, height: 200 };
  const shouldBePage = {
    leftOfB: { x: VIEWPORT.x + 40, y: VIEWPORT.y + VIEWPORT.height / 2 },
    rightOfB: { x: VIEWPORT.x + VIEWPORT.width - 40, y: VIEWPORT.y + VIEWPORT.height / 2 },
    belowB: { x: VIEWPORT.x + VIEWPORT.width / 2, y: VIEWPORT.y + VIEWPORT.height - 30 },
  };
  await setB(B_CENTER);
  setView(VIEWPORT);
  await sleep(500);
  const m7 = await measure("01-partial-center-nomitigation.png", shouldBePage);
  const nominalVisible = VIEWPORT.width * VIEWPORT.height - B_CENTER.width * B_CENTER.height;
  report.partialCenter = {
    viewport: VIEWPORT,
    domWindow: B_CENTER,
    nominalVisibleArea: nominalVisible,
    nominalVisiblePoints: { leftOfB: m7.c.leftOfB, rightOfB: m7.c.rightOfB, belowB: m7.c.belowB },
  };
  add(
    "occl.partialCenter.baselinePointsAllShowPage",
    m7.is("leftOfB", L.BLUE) && m7.is("rightOfB", L.BLUE) && m7.is("belowB", L.BLUE),
    `不缓解时三个"本应看见网页"的点全为蓝（${m7.c.leftOfB} / ${m7.c.rightOfB} / ${m7.c.belowB}）→ 它们是真值锚点`,
    report.partialCenter.nominalVisiblePoints,
  );

  const bandLeft = { x: VIEWPORT.x, y: VIEWPORT.y, width: B_CENTER.x - VIEWPORT.x, height: VIEWPORT.height };
  setView(bandLeft);
  await sleep(500);
  const m8 = await measure("01-partial-center-single-rect.png", shouldBePage);
  const recoverable = bandLeft.width * bandLeft.height;
  const visibleNow = ["leftOfB", "rightOfB", "belowB"].filter((k) => m8.is(k, L.BLUE));
  const lostNow = ["leftOfB", "rightOfB", "belowB"].filter((k) => !m8.is(k, L.BLUE));
  report.partialCenter.singleRect = {
    bounds: bandLeft,
    recoverableArea: recoverable,
    recoveredRatio: recoverable / nominalVisible,
    colors: { leftOfB: m8.c.leftOfB, rightOfB: m8.c.rightOfB, belowB: m8.c.belowB },
    visibleNow,
    lostNow,
  };
  add(
    "occl.partialCenter.singleRectCannotRepresent",
    lostNow.length > 0 && visibleNow.length > 0,
    `取"剩余区域里最大的单个轴对齐矩形"= 左竖带 ${bandLeft.width}×${bandLeft.height}：` +
      `只能保住 ${visibleNow.join("+") || "无"}；${lostNow.join("+")} 本应显示网页却变成 ${lostNow.map((k) => m8.c[k]).join("/")}。` +
      `可恢复面积 ${recoverable} / 应可见 ${nominalVisible} = ${((recoverable / nominalVisible) * 100).toFixed(0)}% → 单一矩形无法表达一般性部分遮挡`,
    report.partialCenter.singleRect,
  );

  // ===================== 圆角裁剪 =====================
  await setB(B0);
  setView(VIEWPORT);
  await sleep(500);
  const ctlPoint = { x: A.x + 2, y: A.y + A.height - 2 };
  const m9 = await measure("01-rounded-corners.png", { domCornerControl: ctlPoint });
  report.corners = {
    chromeRect: C,
    viewport: VIEWPORT,
    windowBottomLeft: m9.c.winBottomLeft,
    windowBottomRight: m9.c.winBottomRight,
    domWindowCornerControl: m9.c.domCornerControl,
    domWindowCornerPoint: ctlPoint,
  };
  add(
    "occl.corner.domBorderRadiusClipsOwnContent",
    m9.is("domCornerControl", L.GREEN),
    `对照：普通 DOM 窗口 A 的圆角外采样 ${m9.c.domCornerControl} 露出桌面绿 → border-radius 确实裁剪 DOM 自身内容`,
    { control: m9.c.domCornerControl, point: ctlPoint },
  );
  const leakBL = m9.is("winBottomLeft", L.BLUE);
  const leakBR = m9.is("winBottomRight", L.BLUE);
  add(
    "occl.corner.nativeViewLeaksThroughRoundedWindow",
    leakBL || leakBR,
    `浏览器窗口圆角 ${C.radius}px，原生视图是方角矩形：左下 ${m9.c.winBottomLeft}、右下 ${m9.c.winBottomRight} → ` +
      `${leakBL || leakBR ? "网页从圆角处漏出，圆角裁剪对原生层无效" : "未漏出"}`,
    report.corners,
  );

  // ===================== 原生窗口自身的圆角是否会裁剪原生视图 =====================
  // 把原生视图铺满整个窗口内容区，看 macOS 窗口底角的圆角处是否被裁掉。
  setView({ x: 0, y: 0, width: W, height: H });
  await sleep(600);
  const m10 = await measure("01-window-native-corners.png", {
    winNativeBottomLeft: { x: 2, y: H - 2 },
    winNativeBottomRight: { x: W - 2, y: H - 2 },
    winNativeTopLeft: { x: 2, y: 2 },
    winNativeTopRight: { x: W - 2, y: 2 },
  });
  const blPage = m10.is("winNativeBottomLeft", L.BLUE);
  const brPage = m10.is("winNativeBottomRight", L.BLUE);
  const tlPage = m10.is("winNativeTopLeft", L.BLUE);
  const trPage = m10.is("winNativeTopRight", L.BLUE);
  report.windowNativeCorners = {
    windowContent: { x: 0, y: 0, width: W, height: H },
    bottomLeft: m10.c.winNativeBottomLeft,
    bottomRight: m10.c.winNativeBottomRight,
    topLeft: m10.c.winNativeTopLeft,
    topRight: m10.c.winNativeTopRight,
    bottomCornersClippedByWindowShape: !blPage && !brPage,
    topCornersStillPage: tlPage && trPage,
  };
  add(
    "occl.corner.nativeWindowShapeClipsNativeView",
    !blPage && !brPage && tlPage && trPage,
    `原生视图铺满整窗内容区：底角 ${m10.c.winNativeBottomLeft} / ${m10.c.winNativeBottomRight} 被窗口圆角裁掉（非网页色），` +
      `顶角 ${m10.c.winNativeTopLeft} / ${m10.c.winNativeTopRight} 仍是网页（内容区顶部不圆角）→ ` +
      `**macOS 原生窗口自身的圆角会裁剪原生视图，DOM 的 border-radius 不会**。这是唯一可用的圆角手段。`,
    report.windowNativeCorners,
  );

  // ===================== 原生视图自带的圆角能力 =====================
  // Electron 44 的 View 基类提供 setBorderRadius，文档注明"被圆角切掉的区域仍然接收点击"。
  // 后者本身就是一次"视觉与输入不一致"，必须实测。
  const hasRadius = typeof view.setBorderRadius === "function";
  report.setBorderRadius = { available: hasRadius };
  add("occl.corner.setBorderRadiusAvailable", hasRadius, `view.setBorderRadius 类型 = ${typeof view.setBorderRadius}`, { available: hasRadius });
  if (hasRadius) {
    await setB(B0);
    setView(VIEWPORT);
    view.setBorderRadius(C.radius);
    await sleep(600);
    const m11 = await measure("01-border-radius-applied.png", {
      cutoutTopLeft: { x: VIEWPORT.x + 4, y: VIEWPORT.y + 4 },
    });
    report.setBorderRadius.applied = {
      radius: C.radius,
      windowBottomLeft: m11.c.winBottomLeft,
      windowBottomRight: m11.c.winBottomRight,
      cutoutTopLeft: m11.c.cutoutTopLeft,
    };
    add(
      "occl.corner.borderRadiusFixesNativeCorner",
      !m11.is("winBottomLeft", L.BLUE) && !m11.is("winBottomRight", L.BLUE),
      `view.setBorderRadius(${C.radius}) 后窗口底角 ${m11.c.winBottomLeft} / ${m11.c.winBottomRight} 不再是网页 → 原生视图圆角可修好 DOM 圆角处的漏色`,
      report.setBorderRadius.applied,
    );
    const k7 = await clickAt(VIEWPORT.x + 4, VIEWPORT.y + 4, "圆角切掉区域（文档称仍接收点击）");
    report.setBorderRadius.cutoutClick = k7;
    add(
      "occl.corner.cutoutStillCapturesClick",
      k7.valid ? k7.pageHits > 0 : false,
      `${desc(k7)} → 文档所述"被圆角切掉的区域仍然接收点击"` +
        `${k7.valid && k7.pageHits > 0 ? " 成立：视觉上是 DOM，点击却进了网页，视觉与输入不一致" : " 未成立"}`,
      k7,
    );
    view.setBorderRadius(0);
    await sleep(300);
  }

  win.destroy();
};
