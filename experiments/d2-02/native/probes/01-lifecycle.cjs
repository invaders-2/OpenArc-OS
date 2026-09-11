/**
 * D2-02B 探针 01 · 原生视图生命周期与遮挡结算（§11 / §12 / §13 / §17 / §35）。
 *
 * **它打的是产品真实模块 `electron/native-view-controller.cjs`，不是等价物。**
 * Gate 阶段的 03-multiview / 01-occlusion 证明的是"Electron API 能不能做到"；
 * 本探针证明的是"我们写的那段代码是否真的做到了"。
 *
 * 这组断言存在的直接理由：控制器曾经读 `plan.strategy`，而
 * `electron/occlusion.cjs` 的 `plan()` 返回的字段名是 `mode` —— 读到的是
 * `undefined`，于是"最小化不隐藏视图""对话框打开时原生视图不让位""快照永不补齐"
 * 三件事同时静默失效，而任何 DOM 侧探针都看不到它。
 * 因此这里第一条硬断言就是：**结算结果的 mode 必须落在四个已知取值之内**。
 *
 * 范围声明：本探针跑在 macOS + Electron 44，验证的是控制器行为与几何结算，
 * 不覆盖真实多显示器、GPU 合成性能与 UI 端到端流程。
 */
const { BrowserWindow, session } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const { NativeViewController, VIEW_RADIUS } = require(path.join(ROOT, "electron", "native-view-controller.cjs"));
const occlusion = require(path.join(ROOT, "electron", "occlusion.cjs"));
const manager = require(path.join(ROOT, "electron", "window-manager.cjs"));
const domain = require(path.join(ROOT, "electron", "window-domain.cjs"));

const W = 1100;
const H = 760;
/** 视口：避开窗口边缘，宽高取偶数，便于人工核对坐标。 */
const V = { x: 40, y: 64, width: 640, height: 420 };

const KNOWN_MODES = new Set(["live", "clip+snapshot", "snapshot", "hidden", "closed"]);

const pageHTML = (color, tag) => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:${color};color:#fff;
          font:700 20px ui-monospace,monospace;overflow:hidden}
</style></head><body><div style="padding:24px">${tag}</div>
<script>window.__tag = ${JSON.stringify(tag)}; window.__loads = (window.__loads||0)+1;</script>
</body></html>`;

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = req.url.split("?")[0];
      if (p === "/a") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(pageHTML("#2f6fff", "PAGE-A"));
      } else if (p === "/b") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(pageHTML("#ff7a00", "PAGE-B"));
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("nope");
      }
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/**
 * 从视口右侧压过来、遮住 frac 比例的遮挡者（剩下左侧一条竖带是空闲区）。
 *
 * 用"侧向遮挡"而不是"中心挖洞"：中心挖洞留下的最大空闲矩形只是上下两条
 * 窄带（640×75 ≈ 视口的 18%），根本到不了 CLIP_MIN_RATIO ——
 * 拿它当"应该走 clip"的样本会把期望值写错（第一版就写错了）。
 * 侧向遮挡留下的空闲矩形就是整条竖带，面积比例等于 1-frac，可以精确控制。
 */
const coverRight = (frac) => {
  const w = Math.round(V.width * (1 - frac));
  return { id: "above", x: V.x + w, y: V.y, width: Math.round(V.width * frac) + 10, height: V.height };
};

const sameRect = (a, b) =>
  !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

exports.run = async function run({ report, sleep, add }) {
  const { server, port } = await serve();
  const base = `http://127.0.0.1:${port}`;
  const URL_A = `${base}/a`;
  const URL_B = `${base}/b`;

  const win = new BrowserWindow({
    width: W,
    height: H,
    x: 40,
    y: 40,
    show: true,
    useContentSize: true,
    backgroundColor: "#00000000",
  });

  const events = [];
  const focusCalls = [];
  const logs = [];
  const controller = new NativeViewController({
    parent: win.contentView,
    onFocusShell: () => focusCalls.push(Date.now()),
    onEvent: (e) => events.push(e),
    log: (line) => logs.push(line),
  });

  const intent = (over = {}) => ({
    windowId: "browser",
    appId: "browser",
    url: URL_A,
    present: true,
    focused: true,
    viewport: { ...V },
    occluders: [],
    ...over,
  });

  /** 取控制器内部的原生视图（只用于断言，不改动它）。 */
  const viewOf = (id = "browser") => {
    const e = controller.entries.get(id);
    return e ? e.view : null;
  };

  try {
    /* ══════════════════════════════════════════════════════════════════════
       A. 创建 / 复用 / 几何
       ══════════════════════════════════════════════════════════════════════ */
    const r1 = await controller.sync([intent()], { interactive: true });
    await sleep(200);
    const view1 = viewOf();
    const wcId1 = view1.webContents.id;

    add("create.onFirstSync", controller.stats().entries === 1 && !!view1, `entries=${controller.stats().entries}`);
    add(
      "create.modeIsKnownValue",
      KNOWN_MODES.has(r1[0]?.mode) && r1[0].mode !== "closed",
      `结算 mode=${JSON.stringify(r1[0]?.mode)}（undefined/未知值说明控制器与 occlusion.plan 的字段口径又错位了）`,
    );
    add("create.pageLoaded", view1.webContents.getURL().startsWith(base), `getURL=${view1.webContents.getURL()}`);
    add(
      "geom.boundsFollowIntent",
      sameRect(view1.getBounds(), V),
      `view.getBounds=${JSON.stringify(view1.getBounds())} intent.viewport=${JSON.stringify(V)}`,
    );
    add("geom.visibleWhenLive", view1.getVisible() === true && r1[0].mode === "live", `visible=${view1.getVisible()} mode=${r1[0].mode}`);

    // 同一个 windowId 再次 sync 必须复用同一个原生视图，不能每帧新建
    const r2 = await controller.sync([intent()], { interactive: true });
    add(
      "create.reusesSameView",
      viewOf().webContents.id === wcId1 && controller.stats().entries === 1,
      `wc.id 从 ${wcId1} 变成 ${viewOf().webContents.id}；entries=${controller.stats().entries}`,
    );

    // 几何随意图走：改视口必须真的改到原生视图上
    const V2 = { x: 120, y: 140, width: 520, height: 360 };
    await controller.sync([intent({ viewport: { ...V2 } })], { interactive: true });
    await sleep(120);
    add(
      "geom.boundsTrackIntentChange",
      sameRect(viewOf().getBounds(), V2),
      `改视口后 view.getBounds=${JSON.stringify(viewOf().getBounds())}`,
    );
    await controller.sync([intent()], { interactive: true });
    await sleep(120);

    // 圆角必须由原生侧修，且常量要与样式表里的窗口圆角一致
    const css = fs.readFileSync(path.join(ROOT, "src", "design-system", "tokens.css"), "utf8");
    const tokenRadius = Number((css.match(/--radius-window:\s*(\d+)px/) || [])[1]);
    add(
      "geom.borderRadiusMatchesStyleToken",
      VIEW_RADIUS === tokenRadius && VIEW_RADIUS > 0,
      `VIEW_RADIUS=${VIEW_RADIUS}，tokens.css --radius-window=${tokenRadius}px`,
    );
    add(
      "geom.borderRadiusApiAvailable",
      typeof viewOf().setBorderRadius === "function",
      "View.setBorderRadius 不可用则圆角只能靠 DOM，被切掉的区域仍然接收点击（Electron 文档原文）",
    );

    /* ══════════════════════════════════════════════════════════════════════
       B. 四态结算 —— 每条都与 occlusion.plan 的直接输出对账
       ══════════════════════════════════════════════════════════════════════ */
    // 最小化（present=false）必须真的隐藏视图，否则 DOM 窗口消失了、网页还浮在桌面上
    const rMin = await controller.sync([intent({ present: false })], { interactive: true });
    await sleep(120);
    add(
      "mode.hiddenOnMinimize",
      rMin[0].mode === "hidden" && viewOf().getVisible() === false,
      `mode=${rMin[0].mode} getVisible=${viewOf().getVisible()}`,
    );

    const rRes = await controller.sync([intent()], { interactive: true });
    await sleep(120);
    add(
      "mode.liveAfterRestore",
      rRes[0].mode === "live" && viewOf().getVisible() === true,
      `mode=${rRes[0].mode} getVisible=${viewOf().getVisible()}`,
    );

    // 系统级覆盖层（对话框 / 搜索 / AI 面板）打开时必须整块让位（§17）
    const rOv = await controller.sync([intent()], { interactive: true, overlayOpen: true });
    await sleep(120);
    add(
      "mode.hiddenWhenOverlayOpen",
      rOv[0].mode === "hidden" && viewOf().getVisible() === false,
      `mode=${rOv[0].mode} getVisible=${viewOf().getVisible()}`,
    );
    add(
      "mode.overlayHidesWithoutSnapshot",
      (rOv[0].snapshotRects || []).length === 0,
      `覆盖层场景不应产生快照，实测 snapshotRects=${JSON.stringify(rOv[0].snapshotRects)}`,
    );
    await controller.sync([intent()], { interactive: true });
    await sleep(120);

    // 完全遮挡 → 整块快照
    const full = { id: "above", x: V.x, y: V.y, width: V.width, height: V.height };
    const rFull = await controller.sync([intent({ occluders: [full] })], { interactive: true });
    await sleep(250);
    add(
      "mode.snapshotOnFullOcclusion",
      rFull[0].mode === "snapshot" && sameRect(rFull[0].snapshotRects?.[0], V),
      `mode=${rFull[0].mode} snapshotRects=${JSON.stringify(rFull[0].snapshotRects)}`,
    );
    add(
      "snapshot.hasImageData",
      !!rFull[0].snapshots?.[0]?.dataUrl,
      `完全遮挡时没有产出快照图，DOM 侧就没有东西可补，用户会看到一块空洞。控制器日志：${JSON.stringify(logs.filter((l) => l.includes("快照")).slice(-2))}`,
    );

    // 大部分空闲（遮 55%，剩左侧 45% 竖带 ≥ CLIP_MIN_RATIO 0.35）
    // → 保留那条竖带做实况，其余用快照补齐
    const mostlyFree = coverRight(0.55);
    const rClip = await controller.sync([intent({ occluders: [mostlyFree] })], { interactive: true });
    await sleep(300);
    const planClip = occlusion.plan({ viewport: V, occluders: [mostlyFree], interactive: true });
    add(
      "mode.clipOnLargePartialOcclusion",
      rClip[0].mode === "clip+snapshot",
      `mode=${rClip[0].mode}（期望 clip+snapshot）；largestRatio=${rClip[0].plan?.largestRatio?.toFixed(3)}`,
    );
    add(
      "mode.clipKeepsLargestFreeRectLive",
      viewOf().getVisible() === true && sameRect(rClip[0].bounds, planClip.bounds),
      `controller.bounds=${JSON.stringify(rClip[0].bounds)} plan.bounds=${JSON.stringify(planClip.bounds)} visible=${viewOf().getVisible()}`,
    );
    add(
      "mode.clipReportsSnapshotRects",
      (rClip[0].snapshotRects || []).length === planClip.snapshotRects.length && planClip.snapshotRects.length > 0,
      `snapshotRects=${JSON.stringify(rClip[0].snapshotRects)}`,
    );
    add(
      "snapshot.clipPatchHasImageData",
      (rClip[0].snapshots || []).every((s) => !!s.dataUrl),
      `被补齐的区域没有快照图：${JSON.stringify((rClip[0].snapshots || []).map((s) => !!s.dataUrl))}`,
    );

    // 空闲太少（遮 75%，只剩 25% 竖带 < 0.35）→ 不值得保留活动视图，整块快照
    const mostlyCovered = coverRight(0.75);
    const rSmall = await controller.sync([intent({ occluders: [mostlyCovered] })], { interactive: true });
    await sleep(300);
    add(
      "mode.snapshotOnSmallPartialOcclusion",
      rSmall[0].mode === "snapshot" && viewOf().getVisible() === false,
      `mode=${rSmall[0].mode}（剩 25% 不该保留活动视图）；largestRatio=${rSmall[0].plan?.largestRatio?.toFixed(3)} visible=${viewOf().getVisible()}`,
    );

    // 不可交互（非聚焦窗口）时一律整块快照 —— 半块可点的网页比看不见更糟
    const rNoInter = await controller.sync([intent({ occluders: [mostlyFree] })], { interactive: false });
    await sleep(300);
    add(
      "mode.snapshotWhenNotInteractive",
      rNoInter[0].mode === "snapshot",
      `mode=${rNoInter[0].mode}（interactive=false 时应整块快照）`,
    );

    // 空视口 → 隐藏（而不是 setBounds({width:0}) 留一个零尺寸视图）
    const rEmpty = await controller.sync([intent({ viewport: { x: 0, y: 0, width: 0, height: 0 } })], { interactive: true });
    add("mode.hiddenOnEmptyViewport", rEmpty[0].mode === "hidden", `mode=${rEmpty[0].mode}`);

    /* ══════════════════════════════════════════════════════════════════════
       C. 快照缓存：必须复用，也必须失效
       ══════════════════════════════════════════════════════════════════════ */
    const rSame1 = await controller.sync([intent({ occluders: [full] })], { interactive: true });
    await sleep(250);
    const rSame2 = await controller.sync([intent({ occluders: [full] })], { interactive: true });
    await sleep(150);
    add(
      "snapshot.reusedWhenNothingChanged",
      rSame1[0].snapshots?.[0]?.cached === false && rSame2[0].snapshots?.[0]?.cached === true,
      `第一次 cached=${rSame1[0].snapshots?.[0]?.cached}，第二次 cached=${rSame2[0].snapshots?.[0]?.cached}`,
    );

    const moved = { id: "above", x: V.x + 30, y: V.y + 20, width: V.width, height: V.height };
    const rMoved = await controller.sync([intent({ occluders: [moved] })], { interactive: true });
    await sleep(250);
    add(
      "snapshot.invalidatedWhenOccludersMove",
      rMoved[0].snapshots?.[0]?.cached === false,
      `遮挡者移动后仍复用旧快照（cached=${rMoved[0].snapshots?.[0]?.cached}），用户会看到错位画面`,
    );

    /* ══════════════════════════════════════════════════════════════════════
       D. 导航策略
       ══════════════════════════════════════════════════════════════════════ */
    const beforeNav = viewOf().webContents.getURL();
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<h1>x", "https://u:p@example.com/"]) {
      await controller.sync([intent({ url: bad })], { interactive: true });
      await sleep(60);
    }
    add(
      "nav.rejectsNonHttpAndCredentialed",
      viewOf().webContents.getURL() === beforeNav,
      `URL 从 ${beforeNav} 变成 ${viewOf().webContents.getURL()} —— 不安全的协议被放行了`,
    );

    await controller.sync([intent({ url: URL_B })], { interactive: true });
    await sleep(250);
    add(
      "nav.loadsHttpUrl",
      viewOf().webContents.getURL() === URL_B,
      `期望 ${URL_B}，实测 ${viewOf().webContents.getURL()}`,
    );

    /* ══════════════════════════════════════════════════════════════════════
       E. 会话 / 权限 / 视图内部安全
       ══════════════════════════════════════════════════════════════════════ */
    add(
      "session.partitionIsPerApp",
      NativeViewController.partitionFor("browser") === NativeViewController.partitionFor("browser") &&
        NativeViewController.partitionFor("browser") !== NativeViewController.partitionFor("files") &&
        NativeViewController.partitionFor("browser").startsWith("openarc-app-"),
      `browser=${NativeViewController.partitionFor("browser")} files=${NativeViewController.partitionFor("files")}`,
    );

    const sess = session.fromPartition(NativeViewController.partitionFor("browser"));
    add(
      "session.partitionIsolatedFromDefault",
      sess !== session.defaultSession,
      "应用分区不应退化成 defaultSession（那会与宿主页面共享 cookie 存储）",
    );
    // 行为断言：请求 geolocation 必须被拒。
    // 不用"handler 是否存在"当证据 —— 那种断言恒真，起不到判据作用。
    const permResult = await viewOf().webContents
      .executeJavaScript(
        `new Promise((resolve) => {
           const done = (v) => resolve(v);
           try {
             navigator.geolocation.getCurrentPosition(
               () => done("allowed"),
               () => done("denied"),
             );
             setTimeout(() => done("timeout"), 1500);
           } catch (e) { done("threw"); }
         })`,
        true,
      )
      .catch(() => "eval-failed");
    add(
      "session.geolocationDenied",
      permResult === "denied",
      `视图中请求 geolocation 的结果=${permResult}（应为 denied）`,
    );

    const inner = await viewOf()
      .webContents.executeJavaScript(
        `JSON.stringify({
           require: typeof require,
           process: typeof process,
           openarc: typeof window.openarc,
           isolation: window.isSecureContext,
         })`,
        true,
      )
      .catch((e) => "eval-failed:" + e.message);
    let parsed = null;
    try {
      parsed = JSON.parse(inner);
    } catch {
      /* 保持 null，下面按失败处理 */
    }
    add(
      "sec.noNodeInWebView",
      parsed && parsed.require === "undefined" && parsed.process === "undefined" && parsed.openarc === "undefined",
      `网页视图内的全局：${inner}`,
    );

    /* ══════════════════════════════════════════════════════════════════════
       F. 事件回报
       ══════════════════════════════════════════════════════════════════════ */
    await sleep(150);
    add(
      "evt.nativeStateEmitted",
      events.some((e) => e.type === "native-state" && e.windowId === "browser" && typeof e.url === "string"),
      `收到的事件类型：${JSON.stringify([...new Set(events.map((e) => e.type))])}`,
    );

    events.length = 0;
    await viewOf().webContents.executeJavaScript(`window.open("${base}/a", "_blank")`, true).catch(() => {});
    await sleep(300);
    const popupBlocked = events.some((e) => e.type === "popup-blocked");
    add(
      "evt.popupBlocked",
      popupBlocked,
      `视图内 window.open 的结果：${popupBlocked ? "被拦截并回报 popup-blocked" : "未被拦截"}；事件=${JSON.stringify(events.map((e) => e.type))}`,
    );

    /* ══════════════════════════════════════════════════════════════════════
       G. 多视图独立性（§12）
       ══════════════════════════════════════════════════════════════════════ */
    const V_B = { x: 420, y: 260, width: 520, height: 380 };
    await controller.sync(
      [intent(), { ...intent({ windowId: "browser2", url: URL_A }), viewport: { ...V_B } }],
      { interactive: true },
    );
    await sleep(300);
    const vA = viewOf("browser");
    const vB = viewOf("browser2");
    add(
      "multi.twoIndependentViews",
      !!vA && !!vB && vA.webContents.id !== vB.webContents.id && controller.stats().entries === 2,
      `entries=${controller.stats().entries} wcA=${vA?.webContents.id} wcB=${vB?.webContents.id}`,
    );
    add(
      "multi.boundsIndependent",
      sameRect(vA.getBounds(), V) && sameRect(vB.getBounds(), V_B),
      `A=${JSON.stringify(vA.getBounds())} B=${JSON.stringify(vB.getBounds())}`,
    );
    add(
      "multi.sameAppSharesPartition",
      vA.webContents.session === vB.webContents.session,
      "同一个 App 的两个窗口应共享 session（ADR §16 冻结的契约）",
    );

    /* ══════════════════════════════════════════════════════════════════════
       H. 释放（§11 最后一项：关闭必须真释放，不能留空壳）
       ══════════════════════════════════════════════════════════════════════ */
    const leaked = vB.webContents;
    await controller.sync([intent()], { interactive: true });
    await sleep(250);
    add(
      "close.releasesRemovedWindow",
      controller.stats().entries === 1 && leaked.isDestroyed(),
      `entries=${controller.stats().entries}，被移除窗口的 webContents destroyed=${leaked.isDestroyed()}`,
    );

    const target = viewOf();
    const targetWc = target.webContents;
    add("close.destroyReturnsTrue", controller.destroy("browser") === true, "destroy 应返回 true");
    add("close.destroyIsIdempotent", controller.destroy("browser") === false, "第二次 destroy 应返回 false");
    add("close.statsCleanAfterDestroy", controller.stats().entries === 0, `entries=${controller.stats().entries}`);
    // wc.close() 是异步的：断言"最终真的释放"而不是"同步已释放"。
    // 这里必须提前抓住 webContents 引用 —— 视图销毁之后再取会拿不到。
    await sleep(300);
    const gone = targetWc.isDestroyed();
    add(
      "close.webContentsReallyGone",
      gone,
      `destroy 后 300ms：isDestroyed=${gone}（false 即"关了但没释放"）`,
    );

    // destroyAll 之后控制器必须锁死：父窗口已关，再 sync 不能在死宿主上重建视图
    await controller.sync([intent()], { interactive: true });
    await sleep(200);
    const beforeAll = controller.stats().entries;
    controller.destroyAll();
    const afterAll = controller.stats();
    const resAfterDestroyAll = await controller.sync([intent()], { interactive: true });
    add(
      "close.destroyAllReleasesEverything",
      beforeAll === 1 && afterAll.entries === 0 && afterAll.aliveWebContents === 0,
      `destroyAll 前 entries=${beforeAll}，后 ${JSON.stringify(afterAll)}`,
    );
    add(
      "close.controllerLockedAfterDestroyAll",
      Array.isArray(resAfterDestroyAll) && resAfterDestroyAll.length === 0,
      `destroyAll 之后再 sync 返回 ${JSON.stringify(resAfterDestroyAll)}；应为空数组`,
    );

    /* ══════════════════════════════════════════════════════════════════════
       I. 与 Window Manager 的接线（防止字段口径再次错位）
       ══════════════════════════════════════════════════════════════════════ */
    const host = { width: W, height: H };
    const state = manager.applyAll(domain.createState(), [
      { type: "window/open", appId: "browser", bounds: { x: 60, y: 80, w: 700, h: 500 } },
      { type: "window/open", appId: "home", bounds: { x: 100, y: 120, w: 700, h: 500 } },
    ]);
    const intents = manager.nativeIntents(state, host);
    add(
      "wire.managerProducesOneIntentPerNativeWindow",
      intents.length === 1 && intents[0].windowId === "browser",
      `intents=${JSON.stringify(intents.map((i) => i.windowId))}（只有 browser kind 产出意图）`,
    );
    // 视口 = 窗口矩形挖掉标题栏。这条曾经写错过（少了 16px），
    // 结果原生视图与 DOM 视口锚点错位，表现为"网页整体偏移一截"。
    const b = domain.byId(state, "browser").bounds;
    add(
      "wire.viewportExcludesTitleBar",
      intents[0].viewport.y === b.y + domain.TITLE_BAR_H &&
        intents[0].viewport.height === b.h - domain.TITLE_BAR_H &&
        intents[0].viewport.x === b.x &&
        intents[0].viewport.width === b.w,
      `viewport=${JSON.stringify(intents[0].viewport)} bounds=${JSON.stringify(b)} TITLE_BAR_H=${domain.TITLE_BAR_H}`,
    );
    // home 在 browser 之后打开，因此它是压在 browser 之上的遮挡者
    add(
      "wire.occluderIsTheWindowAbove",
      intents[0].occluders.length === 1 && intents[0].occluders[0].id === "home",
      `occluders=${JSON.stringify(intents[0].occluders)}`,
    );

    const boot = new NativeViewController({
      parent: win.contentView,
      onEvent: () => {},
      log: () => {},
    });
    const wired = await boot.sync(intents, { interactive: true });
    const direct = occlusion.plan({
      viewport: intents[0].viewport,
      occluders: intents[0].occluders,
      minimized: false,
      overlayOpen: false,
      interactive: true,
    });
    add(
      "wire.controllerModeMatchesPlan",
      wired[0]?.mode === direct.mode && KNOWN_MODES.has(wired[0]?.mode),
      `controller.mode=${JSON.stringify(wired[0]?.mode)} plan.mode=${direct.mode}（两者必须同源同名）`,
    );
    boot.destroyAll();
  } finally {
    try {
      controller.destroyAll();
    } catch {
      /* 可能已销毁 */
    }
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      /* ignore */
    }
    server.close();
  }
};
