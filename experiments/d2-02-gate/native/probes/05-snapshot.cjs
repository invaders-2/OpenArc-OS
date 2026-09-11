/**
 * 探针 05 · 混合方案的两种缓解策略对比（§8 / §10）。
 *
 * 已知约束（01/04 号探针实测）：
 *   · 单矩形原生视图无法表达一般性的部分遮挡
 *   · 整块隐藏会让"未遮挡区域"一起消失
 *   · 原生 child 窗口虽然由 OS 精确裁剪，但父窗口里的 DOM 覆盖层永远盖不住它
 *
 * 于是提出第三种缓解：**用页面快照填充**。
 *   把 `view.webContents.capturePage()` 的结果作为 DOM 图片贴回视口，
 *   原生视图只保留"最大空闲矩形"（或整块隐藏），其余区域由快照补齐。
 *   视觉上合成结果与"窗口压住网页"一致；代价是被快照覆盖的区域不再实时、不可交互。
 *
 * 本探针要测的就是这个代价到底有多大、是否可接受：
 *   · 视觉：合成帧上四个"本应看见网页"的点是否都呈现网页
 *   · 输入：快照区点击落到 DOM 还是网页
 *   · 时效：页面变化后快照是否过期
 */
const { BrowserWindow, WebContentsView, session, app } = require("electron");
const L = require("./_lib.cjs");

const { W, H, VIEWPORT } = L.LAYOUT;
const B_CENTER = { x: 450, y: 430, width: 200, height: 200 };
// 视口被 B_CENTER 挖洞后的四条空闲带（用于选"最大空闲矩形"）
const rings = () => {
  const v = VIEWPORT;
  const b = B_CENTER;
  return {
    top: { x: v.x, y: v.y, width: v.width, height: b.y - v.y },
    bottom: { x: v.x, y: b.y + b.height, width: v.width, height: v.y + v.height - (b.y + b.height) },
    left: { x: v.x, y: v.y, width: b.x - v.x, height: v.height },
    right: { x: b.x + b.width, y: v.y, width: v.x + v.width - (b.x + b.width), height: v.height },
  };
};
const area = (r) => r.width * r.height;

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
      session: session.fromPartition("openarc-gate-snapshot"),
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

  const js = (c) => win.webContents.executeJavaScript(c);

  /** 抓一帧真实合成帧并按视口坐标采样（含四个"本应看见网页"的锚点）。 */
  async function shot(name) {
    const cb = win.getContentBounds();
    // 采样点必须避开居中文字：网页把 "PAGE" 居中渲染，DOM 窗口 B 把 "Window B" 居中渲染，
    // 而 B_CENTER 的正中又恰好等于视口正中 —— 直接采正中会读到白色文字（曾导致两条断言假失败）。
    // 因此 inB 取 B 矩形内侧左上角 24px，四周围锚点也都在文字包围盒之外。
    const probe = {
      leftOfB: { x: VIEWPORT.x + 40, y: VIEWPORT.y + VIEWPORT.height / 2 },
      rightOfB: { x: VIEWPORT.x + VIEWPORT.width - 40, y: VIEWPORT.y + VIEWPORT.height / 2 },
      belowB: { x: VIEWPORT.x + VIEWPORT.width / 2, y: VIEWPORT.y + VIEWPORT.height - 30 },
      aboveB: { x: VIEWPORT.x + VIEWPORT.width / 2, y: VIEWPORT.y + 18 },
      inB: { x: B_CENTER.x + 24, y: B_CENTER.y + 24 },
      domWindowVisible: { x: 250, y: VIEWPORT.y - 200 },
    };
    const s = L.shoot({ x: cb.x, y: cb.y, width: W, height: H }, name);
    if (!s.ok) throw new Error("screencapture 失败 " + name);
    const px = L.readPixels(s.file, W, probe);
    const c = L.colors(px);
    const at = (n) => {
      const m = (c[n] || "").match(/\d+/g);
      return m ? { r: +m[0], g: +m[1], b: +m[2] } : null;
    };
    return { file: s.file, c, at, is: (n, col) => L.near(at(n), col) };
  }
  async function clickAt(x, y, label) {
    await js("window.__hits = []");
    await view.webContents.executeJavaScript("window.__hits = []");
    const cb = win.getContentBounds();
    const p = L.screenPoint(cb, x, y);
    L.warp(p.x, p.y);
    await sleep(70);
    const cur = L.cursorPos();
    const drift = cur ? Math.hypot(cur.x - p.x, cur.y - p.y) : null;
    L.cliclick([`c:${p.x},${p.y}`]);
    await sleep(400);
    const dom = await js("window.__hits");
    const page = await view.webContents.executeJavaScript("window.__hits");
    return { label, valid: drift !== null && drift <= 8, drift, dom: dom.length, page: page.length, domTargets: dom.map((e) => e.target) };
  }
  const cd = (r) => `[${r.label}] DOM ${r.dom}${r.domTargets?.length ? "(" + r.domTargets.join(",") + ")" : ""} / 网页 ${r.page}`;

  /** 生成快照并贴进 #viewport，pointer-events:none 以便下层 DOM 仍可交互。 */
  async function applySnapshot() {
    const img = await view.webContents.capturePage();
    const dataUrl = "data:image/png;base64," + img.toPNG().toString("base64");
    await js(`
      (() => {
        let s = document.getElementById("snap");
        if (!s) {
          s = document.createElement("img");
          s.id = "snap";
          s.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;object-fit:fill";
          document.getElementById("viewport").appendChild(s);
        }
        s.src = ${JSON.stringify(dataUrl)};
        s.dataset.on = "1";
        return { w: s.naturalWidth, h: s.naturalHeight };
      })()
    `);
    await sleep(250);
    return dataUrl.length;
  }
  const clearSnapshot = () => js(`(() => { const s = document.getElementById("snap"); if (s) s.remove(); })()`);

  const ringsNow = rings();
  const ranked = Object.entries(ringsNow).sort((a, b) => area(b[1]) - area(a[1]));
  const largest = ranked[0];
  const nominalVisible = VIEWPORT.width * VIEWPORT.height - area(B_CENTER);
  report.geometry = {
    viewport: VIEWPORT,
    domWindow: B_CENTER,
    rings: ringsNow,
    ringAreas: Object.fromEntries(Object.entries(ringsNow).map(([k, v]) => [k, area(v)])),
    largestRing: { name: largest[0], rect: largest[1], area: area(largest[1]) },
    nominalVisibleArea: nominalVisible,
    largestRingShare: area(largest[1]) / nominalVisible,
  };

  // ============ 基线：不缓解（真值锚点） ============
  await js(`window.__set("wB", ${JSON.stringify(B_CENTER)})`);
  view.setBounds(VIEWPORT);
  view.setVisible(true);
  await clearSnapshot();
  await sleep(600);
  const m0 = await shot("05-center-nomitigation.png");
  report.baseline = m0.c;
  add(
    "snap.baselineAllFivePointsShowPage",
    m0.is("leftOfB", L.BLUE) && m0.is("rightOfB", L.BLUE) && m0.is("belowB", L.BLUE) && m0.is("aboveB", L.BLUE) && m0.is("inB", L.BLUE),
    `不缓解时四周围与 B 的位置全是网页 ${m0.c.leftOfB}/${m0.c.rightOfB}/${m0.c.belowB}/${m0.c.aboveB}/${m0.c.inB} → B 完全不可见，这就是要修的观感`,
    m0.c,
  );

  // ============ 策略一：只收缩到最大空闲矩形 ============
  view.setBounds(largest[1]);
  view.setVisible(true);
  await sleep(600);
  const m1 = await shot("05-strategy1-clip-only.png");
  const s1 = ["leftOfB", "rightOfB", "belowB", "aboveB"].filter((k) => m1.is(k, L.BLUE));
  const s1lost = ["leftOfB", "rightOfB", "belowB", "aboveB"].filter((k) => !m1.is(k, L.BLUE));
  report.clipOnly = { bounds: largest[1], colors: m1.c, visible: s1, lost: s1lost };
  add(
    "snap.clipOnlyIsInsufficient",
    s1lost.length > 0,
    `只保留最大空闲矩形「${largest[0]}」：可见 ${s1.join("+") || "无"}，${s1lost.join("+")} 变成 ${s1lost.map((k) => m1.c[k]).join("/")} → 观感仍是坏的`,
    report.clipOnly,
  );

  // ============ 策略二：收缩到最大空闲矩形 + 快照补齐其余 ============
  const snapLen = await applySnapshot();
  await sleep(600);
  const m2 = await shot("05-strategy2-clip-plus-snapshot.png");
  const allShown = ["leftOfB", "rightOfB", "belowB", "aboveB"].every((k) => m2.is(k, L.BLUE));
  report.clipPlusSnapshot = { bounds: largest[1], snapshotBytes: snapLen, colors: m2.c };
  add(
    "snap.clipPlusSnapshotCompositeCorrect",
    allShown && m2.is("inB", L.YELLOW),
    `四条空闲带 ${m2.c.leftOfB}/${m2.c.rightOfB}/${m2.c.belowB}/${m2.c.aboveB} 全部呈现网页，` +
      `B 自身 ${m2.c.inB} 正常显示 → 收缩 + 快照补齐后，合成结果与"窗口压住网页"一致`,
    report.clipPlusSnapshot,
  );

  const k1 = await clickAt(VIEWPORT.x + VIEWPORT.width - 40, VIEWPORT.y + VIEWPORT.height / 2, "快照区（rightOfB）");
  report.snapshotClick = k1;
  add(
    "snap.snapshotAreaIsNotInteractiveWithPage",
    k1.valid && k1.page === 0 && k1.dom > 0,
    `${cd(k1)} → 快照区点击不进网页（快照是静态图），代价明确：被快照覆盖的区域不可交互`,
    k1,
  );
  const k2 = await clickAt(B_CENTER.x + 40, B_CENTER.y + 60, "重叠区（B 上）");
  report.domClick = k2;
  add("snap.domWindowStillInteractiveOverSnapshot", k2.valid && k2.dom > 0 && k2.page === 0, cd(k2), k2);

  // ============ 时效性：页面变化后快照过期 ============
  await view.webContents.executeJavaScript(
    "document.body.style.background='#00aa00';window.__hits=[]",
  );
  await sleep(700);
  const m3 = await shot("05-strategy2-stale-snapshot.png");
  report.staleness = { before: m2.c, afterPageChanged: m3.c };
  const liveChanged = m3.is("leftOfB", [0, 170, 0]); // leftOfB 在活动矩形内
  const snapStale = !m3.is("rightOfB", [0, 170, 0]) && m3.is("rightOfB", L.BLUE);
  add(
    "snap.staleSnapshotDetectable",
    liveChanged && snapStale,
    `页面底色改成 rgb(0,170,0) 后：活动矩形内 ${m3.c.leftOfB} 已更新，快照区 ${m3.c.rightOfB} 仍是旧色 → ` +
      `快照会过期，必须有失效策略（内容变化或交互时立即重取）`,
    report.staleness,
  );

  // ============ 策略三：整块隐藏（对照，代价最大） ============
  await clearSnapshot();
  view.webContents.executeJavaScript("document.body.style.background='#0000ff'");
  await sleep(400);
  view.setVisible(false);
  await sleep(600);
  const m4 = await shot("05-strategy3-hide-all.png");
  report.hideAll = m4.c;
  add(
    "snap.hideAllLosesEverything",
    !["leftOfB", "rightOfB", "belowB", "aboveB"].some((k) => m4.is(k, L.BLUE)),
    `整块隐藏后四条空闲带 ${m4.c.leftOfB}/${m4.c.rightOfB}/${m4.c.belowB}/${m4.c.aboveB} 全部不是网页 → 代价最大，仅在对话框/搜索/AI 面板这类"整块覆盖"场景才合理`,
    m4.c,
  );

  win.destroy();
};
