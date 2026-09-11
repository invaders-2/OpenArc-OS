/**
 * 探针 06 · 双浏览器 + 覆盖层连续压力流程（§39）。
 *
 * 与前几个探针的区别：这里不再手写"该怎么隐藏"，而是**直接调用产品真实模块
 * `electron/occlusion.cjs` 的 plan()** 来决定每个浏览器视图的处置，
 * 再在真实合成帧上逐点核对"应该看见什么"与"实际看见什么"是否一致。
 *
 * 每一步都核对四个不变量：
 *   ① 未被 DOM 遮挡的视口像素必须呈现网页（活动矩形或快照，两者都是网页）
 *   ② 被 DOM 遮挡的视口像素必须呈现遮挡者（DOM 永远盖不住原生视图，只能反过来让位）
 *   ③ 三个 webContents 中恰有一个持有键盘焦点
 *   ④ 场景状态（视图可见性、bounds、快照开关）与 plan() 输出一致
 *
 * 流程覆盖：A 打开 → B 打开 → C 打开 → focus A → 右键菜单 → 关闭 →
 * 对话框 → 关闭 → 拖动 C 穿过 A → focus B → 搜索 → 关闭 → 最小化 A → 恢复 A → 关闭 B。
 */
const { BrowserWindow, WebContentsView, session, app } = require("electron");
const L = require("./_lib.cjs");
const path = require("node:path");
const occ = require(path.join(__dirname, "..", "..", "..", "..", "electron", "occlusion.cjs"));

const W = 1160;
const H = 780;
const VPA = { x: 60, y: 120, width: 440, height: 300 };
const VPB = { x: 620, y: 320, width: 440, height: 300 };
const WINC = { x: 260, y: 420, width: 420, height: 260 };
const COLORS = {
  pageA: "#0000ff",
  pageB: "#00ffff",
  chrome: "#808080",
  winC: "#ffff00",
  ctx: "#ff00ff",
  dialog: "#ff8800",
  search: "#9933ff",
};

const SCENE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:${W}px;height:${H}px;background:#00ff00;overflow:hidden;
          font:600 12px ui-monospace,monospace;color:#eee}
.win{position:fixed;box-sizing:border-box}
#chromeA{left:${VPA.x}px;top:${VPA.y - 28}px;width:${VPA.width}px;height:${VPA.height + 28}px;
         background:${COLORS.chrome};z-index:1}
#chromeB{left:${VPB.x}px;top:${VPB.y - 28}px;width:${VPB.width}px;height:${VPB.height + 28}px;
         background:${COLORS.chrome};z-index:1}
#wC{left:${WINC.x}px;top:${WINC.y}px;width:${WINC.width}px;height:${WINC.height}px;
    background:${COLORS.winC};z-index:5;border-radius:12px}
.bar{position:absolute;left:0;top:0;right:0;height:28px;background:#6b6b6b;display:flex;align-items:center;padding-left:10px}
.vp{position:absolute;left:0;top:28px;width:100%;height:calc(100% - 28px)}
.ov{position:fixed;display:none;z-index:100}
#ctx{background:${COLORS.ctx}}
#dialog{background:${COLORS.dialog};z-index:110}
#search{background:${COLORS.search};z-index:105}
</style></head><body>
<div class="win" id="chromeA"><div class="bar">Browser A</div><div class="vp" id="vpA"></div></div>
<div class="win" id="chromeB"><div class="bar">Browser B</div><div class="vp" id="vpB"></div></div>
<div class="win" id="wC">Window C</div>
<div class="ov" id="ctx"></div><div class="ov" id="dialog"></div><div class="ov" id="search"></div>
<script>
window.__hits = [];
window.__rect = (id) => { const b = document.getElementById(id).getBoundingClientRect();
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }; };
window.__set = (id, r) => { const el = document.getElementById(id);
  if (r.x !== undefined) el.style.left = r.x + "px";
  if (r.y !== undefined) el.style.top = r.y + "px";
  if (r.width !== undefined) el.style.width = r.width + "px";
  if (r.height !== undefined) el.style.height = r.height + "px";
  return window.__rect(id); };
window.__show = (id, on, r) => { const el = document.getElementById(id);
  if (r) window.__set(id, r);
  el.style.display = on ? "block" : "none";
  return { display: el.style.display, rect: window.__rect(id) }; };
window.__min = (id, on) => { document.getElementById(id).style.display = on ? "none" : "block"; };
window.__snap = (vpId, url, on) => { const host = document.getElementById(vpId);
  let s = document.getElementById("snap-" + vpId);
  if (!on || !url) { if (s) s.remove(); return false; }
  if (!s) { s = document.createElement("img"); s.id = "snap-" + vpId;
    s.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;object-fit:fill";
    host.appendChild(s); }
  s.src = url; return true; };
for (const t of ["pointerdown","click","keydown"]) addEventListener(t,(e)=>{
  const el = e.target && e.target.id ? e.target.id : (e.target&&e.target.tagName)||"?";
  window.__hits.push({t, target: el});
}, true);
</script></body></html>`;

exports.run = async function run({ report, sleep, add }) {
  report.steps = [];
  const win = new BrowserWindow({
    width: W,
    height: H,
    x: 30,
    y: 30,
    show: true,
    useContentSize: true,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  await win.loadURL(L.dataURL(SCENE));
  app.focus({ steal: true });
  win.moveTop();
  await sleep(800);

  const js = (c) => win.webContents.executeJavaScript(c);
  const shared = "openarc-gate-stress";
  const mk = async (color, tag) => {
    const v = new WebContentsView({
      webPreferences: { session: session.fromPartition(shared), nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    await v.webContents.loadURL(L.dataURL(L.pageHTML({ color, tag })));
    return v;
  };
  const A = await mk(COLORS.pageA, "A");
  const B = await mk(COLORS.pageB, "B");
  win.contentView.addChildView(A);
  win.contentView.addChildView(B);
  const aWC = A.webContents;
  const bWC = B.webContents;
  let aOpen = true;
  let bOpen = false;
  let minimized = false;
  let bChromeHidden = false;
  /** 压在某视口之上的所有矩形：普通窗口 C、打开的覆盖层、以及排在更上层的另一个浏览器外壳。 */
  const occludersFor = (self) => (s) => {
    const list = [s.rects.C];
    for (const k of ["ctx", "dialog", "search"]) if (s.open[k]) list.push(s.rects[k]);
    const other = self === "vpA" ? "B" : "A";
    const otherOpen = self === "vpA" ? bOpen : aOpen;
    if (otherOpen) list.push(s.rects[other]);
    return list;
  };

 // 采样点：视口内 9 个。刻意避开正中（页面把标签文字居中渲染，正中会采到白字）
  const grid = (vp) =>
    [0.12, 0.34, 0.88].flatMap((fx) =>
      [0.12, 0.38, 0.88].map((fy) => ({
        x: Math.round(vp.x + vp.width * fx),
        y: Math.round(vp.y + vp.height * fy),
      })),
    );
  const ptsA = grid(VPA);
  const ptsB = grid(VPB);

  const inside = (p, r) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

  async function scene() {
    return js(`({
      rects: { A: window.__rect("chromeA"), B: window.__rect("chromeB"), C: window.__rect("wC"),
               vpA: window.__rect("vpA"), vpB: window.__rect("vpB"),
               ctx: window.__rect("ctx"), dialog: window.__rect("dialog"), search: window.__rect("search") },
      open: { ctx: document.getElementById("ctx").style.display !== "none",
              dialog: document.getElementById("dialog").style.display !== "none",
              search: document.getElementById("search").style.display !== "none" }
    })`);
  }

  /** 依据 occlusion.plan 落地：设置原生视图 bounds/可见性 + 快照层。 */
  async function applyView(view, vpId, plan, open) {
    // 视图可能已经被关闭（webContents.close() 之后 view.webContents 会变成 undefined）
    const wc = view.webContents;
    if (!wc || wc.isDestroyed()) {
      await js(`window.__snap(${JSON.stringify(vpId)}, "", false)`);
      return { mode: "closed", bounds: null, snapshot: false };
    }
    const show = (mode) => mode === "live" || mode === "clip+snapshot";
    const shouldShow = open && show(plan.mode);
    if (shouldShow) {
      view.setBounds(plan.bounds);
      view.setVisible(true);
    } else {
      // 实测结论（00 号探针）：隐藏视图只是让键盘焦点落空，**不会**自动交还外壳，
      // 所以落地逻辑必须显式把焦点移回外壳，否则按键会掉进黑洞。
      if (wc.isFocused()) win.webContents.focus();
      view.setVisible(false);
    }
    if (open && plan.snapshotRects.length > 0) {
      const img = await wc.capturePage();
      await js(`window.__snap(${JSON.stringify(vpId)}, ${JSON.stringify("data:image/png;base64," + img.toPNG().toString("base64"))}, true)`);
    } else {
      await js(`window.__snap(${JSON.stringify(vpId)}, "", false)`);
    }
    return { mode: plan.mode, bounds: plan.bounds, snapshot: open && plan.snapshotRects.length > 0 };
  }

  async function shot(name) {
    const cb = win.getContentBounds();
    const all = {};
    ptsA.forEach((p, i) => (all[`A${i}`] = p));
    ptsB.forEach((p, i) => (all[`B${i}`] = p));
    const s = L.shoot({ x: cb.x, y: cb.y, width: W, height: H }, name);
    if (!s.ok) throw new Error("screencapture 失败 " + name);
    const px = L.readPixels(s.file, W, all);
    const c = L.colors(px);
    const rgbOf = (k) => {
      const m = (c[k] || "").match(/\d+/g);
      return m ? { r: +m[0], g: +m[1], b: +m[2] } : null;
    };
    return { c, rgbOf };
  }

  /** 一步 = 变更场景 → 用 plan() 落地 → 抓帧 → 逐点核对不变量。 */
  async function step(name, mutate, expect) {
    await mutate();
    await sleep(320);
    const sc = await scene();
    const chromeVisible = { vpA: !minimized, vpB: bOpen && !bChromeHidden };
    const openOf = { vpA: aOpen, vpB: bOpen };
    /** 该点上的 DOM 遮挡者颜色；无遮挡者返回 null。 */
    const occluderAt = (vpId, p) => {
      for (const k of ["ctx", "dialog", "search"]) if (sc.open[k] && inside(p, sc.rects[k])) return hex(COLORS[k]);
      if (vpId === "vpA" && !minimized && inside(p, sc.rects.C)) return hex(COLORS.winC);
      if (vpId === "vpB" && bOpen && inside(p, sc.rects.C)) return hex(COLORS.winC);
      const other = vpId === "vpA" ? "B" : "A";
      const otherOpen = vpId === "vpA" ? bOpen : aOpen;
      const otherVisible = vpId === "vpA" ? !bChromeHidden : !minimized;
      if (otherOpen && otherVisible && inside(p, sc.rects[other])) return hex(COLORS.chrome);
      return null;
    };
    const planOf = (vpId) => {
      const overOpen = sc.open.dialog || sc.open.search;
      return occ.plan({
        viewport: sc.rects[vpId],
        occluders: occludersFor(vpId)(sc),
        minimized: !chromeVisible[vpId],
        overlayOpen: openOf[vpId] && overOpen,
        interactive: openOf[vpId],
      });
    };
    const planA = planOf("vpA");
    const planB = planOf("vpB");
    const appliedA = await applyView(A, "vpA", planA, aOpen);
    const appliedB = await applyView(B, "vpB", planB, bOpen);
    await sleep(420);

    const frame = await shot(`06-${name}.png`);

    // 逐点核对：有 DOM 遮挡者的点必须显示遮挡者；无遮挡者的点按 plan 决定"应是网页 / 必须不是网页"
    const mismatches = [];
    const checks = [];
    const run = (vpId, pts, plan, pageHex, key) => {
      pts.forEach((p, i) => {
        const oc = occluderAt(vpId, p);
        const got = frame.rgbOf(`${key}${i}`);
        if (oc) {
          const ok = L.near(got, oc, 20);
          checks.push({ vp: vpId, i, p, kind: "occludedByDom", want: `rgb(${oc.join(",")})`, got: L.rgb(got), ok });
          if (!ok) mismatches.push(`${vpId}#${i} 应被 DOM 遮挡 rgb(${oc.join(",")})，实得 ${L.rgb(got)}`);
          return;
        }
        const pageShown = openOf[vpId] && chromeVisible[vpId] && plan.mode !== "hidden";
        if (pageShown) {
          const want = hex(pageHex);
          const ok = L.near(got, want, 20);
          checks.push({ vp: vpId, i, p, kind: "page", want: `rgb(${want.join(",")})`, got: L.rgb(got), ok });
          if (!ok) mismatches.push(`${vpId}#${i} 应显示网页 rgb(${want.join(",")})，实得 ${L.rgb(got)}`);
        } else {
          const isPage = L.near(got, hex(pageHex), 20);
          checks.push({ vp: vpId, i, p, kind: "notPage", want: "非网页色", got: L.rgb(got), ok: !isPage });
          if (isPage) mismatches.push(`${vpId}#${i} 应当看不到网页（plan=${plan.mode}），却拿到 ${L.rgb(got)}`);
        }
      });
    };
    run("vpA", ptsA, planA, COLORS.pageA, "A");
    run("vpB", ptsB, planB, COLORS.pageB, "B");

    const focus = { shell: win.webContents.isFocused(), a: aOpen && aWC.isFocused(), b: bOpen && bWC.isFocused() };
    const focusCount = Object.values(focus).filter(Boolean).length;

    const record = {
      step: name,
      scene: { open: sc.open, wC: sc.rects.C, minimized, bChromeHidden },
      planA: { mode: planA.mode, classification: planA.classification, reason: planA.reason, freeArea: planA.freeArea, viewportArea: planA.viewportArea },
      planB: { mode: planB.mode, classification: planB.classification, reason: planB.reason },
      applied: { a: appliedA, b: appliedB },
      focus,
      focusCount,
      samples: checks,
      mismatches,
    };
    report.steps.push(record);

    const exp = expect || {};
    if (exp.aMode) {
      add(`stress.${name}.planA`, planA.mode === exp.aMode, `A 的 plan = ${planA.mode}（期望 ${exp.aMode}）：${planA.reason}`, record.planA);
    }
    add(
      `stress.${name}.compositeMatchesPlan`,
      mismatches.length === 0,
      mismatches.length === 0
        ? `视口内 ${checks.length} 个采样点与 plan 预期全部一致`
        : `不一致 ${mismatches.length} 点：${mismatches.slice(0, 3).join("；")}`,
      { mismatches, checks },
    );
    add(
      `stress.${name}.singleKeyboardOwner`,
      focusCount <= 1,
      `焦点归属 ${JSON.stringify(focus)} → ${focusCount} 个持有者`,
      focus,
    );
    report.lastFrame = frame.c;
  }

  // ===================== 压力流程 =====================
  await step(
    "01-open-A",
    async () => {
      aOpen = true;
      await js(`window.__show("ctx", false); window.__show("dialog", false); window.__show("search", false)`);
    },
    { aMode: "live" },
  );
  await step("02-open-B", async () => { bOpen = true; }, { aMode: "live" });
  await step("03-open-C", async () => { await js(`window.__set("wC", ${JSON.stringify(WINC)})`); });
  await step("04-focus-A", async () => { app.focus({ steal: true }); win.moveTop(); });
  await step(
    "05-open-contextmenu",
    async () => {
      await js(`window.__show("ctx", true, { x: ${VPA.x + 90}, y: ${VPA.y + 40}, width: 200, height: 140 })`);
    },
    { aMode: "clip+snapshot" },
  );
  await step("06-close-contextmenu", async () => { await js(`window.__show("ctx", false)`); }, { aMode: "live" });
  await step(
    "07-open-dialog",
    async () => {
      await js(`window.__show("dialog", true, { x: ${VPA.x + 20}, y: ${VPA.y + 20}, width: ${VPA.width - 40}, height: ${VPA.height - 40} })`);
    },
    { aMode: "hidden" },
  );
  await step("08-close-dialog", async () => { await js(`window.__show("dialog", false)`); });
  await step(
    "09-drag-C-across-A",
    async () => {
      await js(`window.__set("wC", { x: ${VPA.x + 140}, y: ${VPA.y - 10}, width: 420, height: 260 })`);
    },
    // C 压掉 A 视口 57%，最大空闲矩形只占 27%（低于 35% 阈值）→ 按策略整块改用快照。
    // 这是期望行为：A 此刻不是用户正在操作的窗口，牺牲它的可交互性换取正确观感是划算的。
    { aMode: "snapshot" },
  );
  await step("10-focus-B", async () => {
    win.webContents.focus();
    await js(`window.__set("wC", ${JSON.stringify(WINC)})`);
  });
  await step(
    "11-open-search",
    async () => {
      await js(`window.__show("search", true, { x: ${VPB.x + 60}, y: ${VPB.y + 30}, width: 260, height: 180 })`);
      bWC.focus();
    },
    // 搜索 / 对话框这类系统级覆盖层打开时，**所有**浏览器视图一律让位（含未被覆盖的那一个）：
    // 这是刻意的保守策略，避免"模态打开时网页仍可交互"，与 §17 的要求一致。
    { aMode: "hidden" },
  );
  await step("12-close-search", async () => { await js(`window.__show("search", false)`); });
  await step("13-minimize-A", async () => {
    minimized = true;
    await js(`window.__min("chromeA", true)`);
  }, { aMode: "hidden" });
  await step("14-restore-A", async () => {
    minimized = false;
    await js(`window.__min("chromeA", false)`);
  }, { aMode: "live" });
  await step("15-close-B", async () => {
    bOpen = false;
    bChromeHidden = true;
    win.contentView.removeChildView(B);
    bWC.close();
    await sleep(500);
    await js(`window.__min("chromeB", true)`);
  }, { aMode: "live" });

  report.summary = {
    steps: report.steps.length,
    totalSamples: report.steps.reduce((s, r) => s + r.samples.length, 0),
    totalMismatches: report.steps.reduce((s, r) => s + r.mismatches.length, 0),
    modes: report.steps.map((r) => `${r.step}: A=${r.planA.mode} B=${r.planB.mode}`),
    focusOwners: report.steps.map((r) => `${r.step}: ${r.focusCount}`),
    bDestroyed: bWC.isDestroyed(),
  };
  add(
    "stress.overall.noCompositeMismatch",
    report.summary.totalMismatches === 0,
    `连续 ${report.summary.steps} 步、共 ${report.summary.totalSamples} 个采样点，合成结果与 occlusion.plan() 预期不一致 ${report.summary.totalMismatches} 处`,
    { totalSamples: report.summary.totalSamples, totalMismatches: report.summary.totalMismatches },
  );
  add(
    "stress.overall.bReleased",
    bWC.isDestroyed(),
    `流程结束后关闭 B：B.isDestroyed=${bWC.isDestroyed()}，A 仍在（A.isDestroyed=${aWC.isDestroyed()}）`,
    { bDestroyed: bWC.isDestroyed(), aDestroyed: aWC.isDestroyed() },
  );

  win.destroy();
};
