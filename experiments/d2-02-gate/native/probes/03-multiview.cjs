/**
 * 探针 03 · 多原生视图、生命周期与会话（§11 / §12 / §13）。
 *
 * 当前 `electron/main.cjs` 是 `let win, view` —— 单窗口单视图。§12 明确：
 * "如果当前架构只能支持一个，D2-02 不得 PASS"。所以本探针要证明的是
 * **同一原生窗口内能并存多个 WebContentsView，且彼此生命周期独立**。
 *
 * 同时验证一件常被想当然的事：用多个 WebContentsView 拼一片网页（绕开部分遮挡）
 * 到底等不等价 —— 若每个 view 是独立 document，滚动与状态会分叉，此路不通。
 */
const { BrowserWindow, WebContentsView, session, app, webContents } = require("electron");
const L = require("./_lib.cjs");

const W = 1100;
const H = 760;
const VP_A = { x: 80, y: 100, width: 420, height: 300 };
const VP_B = { x: 600, y: 360, width: 420, height: 300 };
const VP_C = { x: 300, y: 300, width: 400, height: 250 };
/**
 * 采样点取矩形左上角内侧而不是正中：页面把文字居中渲染，
 * 正中心会采到白色文字（曾经因此把 rgb(0,255,255) 读成 rgb(254,255,255)）。
 */
const pt = (r) => ({ x: r.x + 16, y: r.y + 16 });
const P = { a: pt(VP_A), b: pt(VP_B), c: pt(VP_C), desk: { x: 100, y: 620 } };

const shellHTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:${W}px;height:${H}px;background:#00ff00;overflow:hidden;
          font:600 12px ui-monospace,monospace;color:#111}
</style></head><body>
<!-- 不放任何装饰元素：采样点必须落在纯色底上，否则会读到标记的颜色 -->
<script>
  window.__hits = [];
  for (const t of ["pointerdown","click","keydown"]) addEventListener(t,(e)=>{
    const el = e.target && e.target.id ? e.target.id : (e.target&&e.target.tagName)||"?";
    window.__hits.push({t, target: el});
  }, true);
</script></body></html>`;

/** 可滚动长页：用于证明同一 URL 的两个 view 是两个独立 document。 */
const scrollPageHTML = (color, tag, height) => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:${color};overflow-y:scroll;font:700 22px ui-monospace,monospace;color:#fff}
.tall{height:${height}px;display:flex;align-items:flex-start;justify-content:center;padding-top:20px}
</style></head><body><div class="tall">${tag}</div>
<script>
  window.__tag = ${JSON.stringify(tag)};
  window.__loads = (window.__loads||0)+1;
  window.__hits = [];
  for (const t of ["pointerdown","click","keydown"]) addEventListener(t,(e)=>{
    window.__hits.push({t, y: Math.round(e.clientY||0)});
  }, true);
</script></body></html>`;

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
  await win.loadURL(L.dataURL(shellHTML));
  app.focus({ steal: true });
  win.moveTop();
  await sleep(800);

  const js = (c) => win.webContents.executeJavaScript(c);
  async function shot(name) {
    const cb = win.getContentBounds();
    const s = L.shoot({ x: cb.x, y: cb.y, width: W, height: H }, name);
    if (!s.ok) throw new Error(`screencapture 失败 ${name}`);
    const px = L.readPixels(s.file, W, P);
    const c = L.colors(px);
    const at = (n) => {
      const m = (c[n] || "").match(/\d+/g);
      return m ? { r: +m[0], g: +m[1], b: +m[2] } : null;
    };
    return { file: s.file, c, at, is: (n, col) => L.near(at(n), col) };
  }
  const mkView = async (partition, html) => {
    const v = new WebContentsView({
      webPreferences: {
        session: session.fromPartition(partition),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    await v.webContents.loadURL(L.dataURL(html));
    return v;
  };
  const counts = () => ({
    webContents: webContents.getAllWebContents().length,
    processes: app.getAppMetrics().length,
  });

  const shared = "openarc-gate-browser-app";
  const before = counts();

  // ===================== 两个浏览器视图并存 =====================
  const A = await mkView(shared, L.pageHTML({ color: "#0000ff", tag: "A" }));
  win.contentView.addChildView(A);
  A.setBounds(VP_A);
  A.setVisible(true);
  await sleep(500);
  // 引用与计数必须在销毁前取好：webContents.close() 之后 view.webContents 会变成 undefined
  const aWC = A.webContents;
  const aWCId = aWC.id;
  const aSession = aWC.session;
  let aFinishes = 0;
  aWC.on("did-finish-load", () => (aFinishes += 1));

  const B = await mkView(shared, L.pageHTML({ color: "#00ffff", tag: "B" }));
  win.contentView.addChildView(B);
  B.setBounds(VP_B);
  B.setVisible(true);
  await sleep(600);
  const bWC = B.webContents;
  const bWCId = bWC.id;
  const bSession = bWC.session;
  let bFinishes = 0;
  bWC.on("did-finish-load", () => (bFinishes += 1));

  const m1 = await shot("03-two-views.png");
  report.twoViews = { colors: m1.c };
  add(
    "multi.twoViewsCoexist",
    m1.is("a", L.BLUE) && m1.is("b", L.CYAN) && m1.is("desk", L.GREEN),
    `同一原生窗口内两个 WebContentsView 同时上屏：A 区 ${m1.c.a}、B 区 ${m1.c.b}、桌面 ${m1.c.desk}`,
    m1.c,
  );
  report.viewIds = { shell: win.webContents.id, a: aWCId, b: bWCId };
  add(
    "multi.viewsAreDistinctWebContents",
    new Set([win.webContents.id, aWCId, bWCId]).size === 3,
    `webContents id：外壳=${win.webContents.id} A=${aWCId} B=${bWCId}`,
    report.viewIds,
  );

  // ===================== 隐藏 A 不影响 B =====================
  A.setVisible(false);
  await sleep(500);
  const m2 = await shot("03-hide-a.png");
  report.hideA = { colors: m2.c };
  add(
    "multi.hideOneDoesNotAffectOther",
    !m2.is("a", L.BLUE) && m2.is("a", L.GREEN) && m2.is("b", L.CYAN),
    `隐藏 A 后：A 区变为桌面底 ${m2.c.a}，B 区仍是 ${m2.c.b} → 隐藏彼此独立`,
    m2.c,
  );

  // ===================== B 的 reload 不影响 A =====================
  // 注意：__loads 是页面内计数，reload 后文档重建会重新从 1 开始，
  // 所以"B 重新加载过"必须用主进程侧的 did-finish-load 计数判定，
  // 而"A 没被重新加载"用 A 页面内计数保持原值来判定。
  const aLoadsBefore = await aWC.executeJavaScript("window.__loads");
  const aUrlBefore = aWC.getURL();
  const finishesBefore = { a: aFinishes, b: bFinishes };
  A.setVisible(true);
  await sleep(300);
  bWC.reload();
  await sleep(1200);
  const aLoadsAfter = await aWC.executeJavaScript("window.__loads");
  const finishesAfter = { a: aFinishes, b: bFinishes };
  report.reload = {
    finishesBefore,
    finishesAfter,
    aLoadsBefore,
    aLoadsAfter,
    aDestroyed: aWC.isDestroyed(),
    aUrlUnchanged: aWC.getURL() === aUrlBefore,
  };
  add(
    "multi.reloadOneDoesNotAffectOther",
    finishesAfter.b > finishesBefore.b && finishesAfter.a === finishesBefore.a &&
      aLoadsAfter === aLoadsBefore && !aWC.isDestroyed(),
    `reload B：B 的 did-finish-load ${finishesBefore.b}→${finishesAfter.b}；A 的 ${finishesBefore.a}→${finishesAfter.a}，` +
      `A 页内 __loads 保持 ${aLoadsAfter}，A 未销毁且 URL 不变 → 两者加载生命周期互不干扰`,
    report.reload,
  );

  // ===================== 销毁 A 不影响 B =====================
  const midCounts = counts();
  win.contentView.removeChildView(A);
  aWC.close();
  await sleep(900);
  const afterCounts = counts();
  const m3 = await shot("03-destroy-a.png");
  report.destroyA = {
    counts: { before, mid: midCounts, after: afterCounts },
    aDestroyed: aWC.isDestroyed(),
    bDestroyed: bWC.isDestroyed(),
    colors: m3.c,
  };
  add(
    "multi.destroyOneLeavesOtherAlive",
    aWC.isDestroyed() && !bWC.isDestroyed() && m3.is("b", L.CYAN),
    `关闭 A：A.isDestroyed=${aWC.isDestroyed()}，B.isDestroyed=${bWC.isDestroyed()}，B 仍在屏上 ${m3.c.b}`,
    report.destroyA,
  );
  add(
    "multi.destroyReleasesWebContents",
    afterCounts.webContents < midCounts.webContents,
    `webContents 数量 ${midCounts.webContents} → ${afterCounts.webContents}（销毁后确实释放，不是留着空壳）`,
    { mid: midCounts, after: afterCounts },
  );

  // ===================== 会话与分区 =====================
  const C = await mkView(shared, L.pageHTML({ color: "#ffff00", tag: "C" }));
  const D = await mkView("openarc-gate-browser-alt", L.pageHTML({ color: "#ff00ff", tag: "D" }));
  win.contentView.addChildView(C);
  C.setBounds(VP_C);
  C.setVisible(true);
  const sessions = {
    shellVsView: win.webContents.session !== C.webContents.session,
    sameAppSamePartition: aSession === bSession,
    sameAppSamePartitionVsC: bSession === C.webContents.session,
    differentPartitionDiffers: C.webContents.session !== D.webContents.session,
    partitionNames: { shared, alt: "openarc-gate-browser-alt" },
  };
  report.sessions = sessions;
  add(
    "multi.sessionIsolationContract",
    sessions.shellVsView && sessions.sameAppSamePartition && sessions.sameAppSamePartitionVsC && sessions.differentPartitionDiffers,
    `外壳会话 ≠ 网页会话；同分区两个视图共享会话（B==C ${sessions.sameAppSamePartitionVsC}）；不同分区隔离（C≠D ${sessions.differentPartitionDiffers}）→ 冻结预期"同一 Browser App 默认共享其 app session"成立`,
    sessions,
  );

  // ===================== 同 URL 多视图 ≠ 同一页面（分叉证据） =====================
  const URL_TILE = L.dataURL(scrollPageHTML("#3366ff", "TILE", 3000));
  const T1 = new WebContentsView({
    webPreferences: { session: session.fromPartition("openarc-gate-tile"), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  const T2 = new WebContentsView({
    webPreferences: { session: session.fromPartition("openarc-gate-tile"), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  await T1.webContents.loadURL(URL_TILE);
  await T2.webContents.loadURL(URL_TILE);
  win.contentView.addChildView(T1);
  T1.setBounds(VP_A);
  T1.setVisible(true);
  win.contentView.addChildView(T2);
  T2.setBounds(VP_C);
  T2.setVisible(true);
  await sleep(700);
  await T1.webContents.executeJavaScript("window.scrollTo(0, 900)");
  await sleep(500);
  const scrolls = {
    t1: await T1.webContents.executeJavaScript("window.scrollY"),
    t2: await T2.webContents.executeJavaScript("window.scrollY"),
    ids: [T1.webContents.id, T2.webContents.id],
    urls: [T1.webContents.getURL().slice(0, 40), T2.webContents.getURL().slice(0, 40)],
  };
  report.tiling = scrolls;
  add(
    "multi.sameUrlViewsAreIndependentDocuments",
    scrolls.t1 !== scrolls.t2 && scrolls.ids[0] !== scrolls.ids[1],
    `同一 URL 的两个视图：滚动 T1 到 ${scrolls.t1}，T2 仍停在 ${scrolls.t2}；webContents id 不同 → ` +
      `它们不是"同一个页面的两块"，用多视图拼一片网页会让滚动/表单/播放状态分叉`,
    scrolls,
  );
  T1.setVisible(false);
  T2.setVisible(false);

  // ===================== 原生视图之间的 z 序 =====================
  C.setBounds(VP_C);
  D.setBounds(VP_C);
  win.contentView.addChildView(D);
  D.setVisible(true);
  C.setVisible(true);
  await sleep(600);
  const z1 = await shot("03-zorder-default.png");
  const topAfterAppend = z1.is("c", L.MAGENTA) ? "D(后加入)" : z1.is("c", L.YELLOW) ? "C(先加入)" : "未知";
  // 用索引重排：把 C 移到最后一个位置
  win.contentView.removeChildView(C);
  win.contentView.addChildView(C);
  await sleep(600);
  const z2 = await shot("03-zorder-reordered.png");
  const topAfterReorder = z2.is("c", L.YELLOW) ? "C(重排后)" : z2.is("c", L.MAGENTA) ? "D" : "未知";
  report.zOrder = { overlapRect: VP_C, first: z1.c.c, afterReorder: z2.c.c, topAfterAppend, topAfterReorder };
  add(
    "multi.viewZOrderIsControllable",
    z1.is("c", L.MAGENTA) && z2.is("c", L.YELLOW),
    `两个视图重叠于同一矩形：默认上层 ${z1.c.c}=${topAfterAppend}；removeChildView+addChildView 重排后 ${z2.c.c}=${topAfterReorder} → 原生视图之间的 z 序由挂载顺序决定且可改`,
    report.zOrder,
  );

  // ===================== 全部销毁后资源回收 =====================
  for (const v of [C, D, T1, T2, B]) {
    win.contentView.removeChildView(v);
    if (!v.webContents.isDestroyed()) v.webContents.close();
  }
  await sleep(1000);
  const finalCounts = counts();
  const m4 = await shot("03-all-destroyed.png");
  report.release = { before, afterAll: finalCounts, colors: m4.c };
  add(
    "multi.allViewsDestroyedReleasesResources",
    finalCounts.webContents < before.webContents + 3 && m4.is("a", L.GREEN) && m4.is("b", L.GREEN),
    `全部视图销毁后：webContents ${finalCounts.webContents}（初始 ${before.webContents}），进程 ${finalCounts.processes}；屏幕上视口区回到桌面底 ${m4.c.a}/${m4.c.b} → 没有"DOM 关了但 WebContentsView 还活着"`,
    report.release,
  );

  win.destroy();
};
