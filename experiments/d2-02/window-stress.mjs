/**
 * D2-02B · 窗口压力流程与差分比对（§15 / §22 / §23 / §24 / §25 / §27 / §31 / §39）。
 *
 * 方法：**差分比对**。
 *   探针在 Node 侧用产品真实的 `electron/window-manager.cjs` 重放同一串命令，
 *   得到"域应当处于的状态"；同时在真实产品页上做对应的 UI 操作，读回 DOM。
 *   每一步都要求 **DOM 逐窗口等于域的投影**：
 *   位置 / 尺寸 / 层级 / 焦点 / 最小化 / 缩放手柄，一项都不能漂。
 *
 * 为什么不是"点一遍看没崩"：
 *   那样最多证明"没抛异常"。DOM 与域各漂各的（比如 React 抄错一份 bounds、
 *   层级不跟 order 走）在肉眼和崩溃日志里都看不见，但它是"唯一状态权威"失效的
 *   最直接症状。差分比对是唯一能在每一步都抓住它的判据。
 *
 * 起始盘面是**四个互不重叠的最小尺寸窗口**（由 manager 自己序列化出来），
 * 而不是让它们按默认 22px 层叠：层叠时下层窗口的标题栏根本点不到，
 * 探针会退化成"只能测最上面那个"。分开摆也更接近真实用法。
 *
 * 覆盖：聚焦 / 拖动 / 缩放（含越界）/ 最小化 / 最大化 / 还原 / 关闭、
 *       系统级覆盖层开关（含残留检查）、产品自身的删除确认对话框、
 *       宿主窗口缩小后的工作区收拢（§23/§24），以及每一步的域不变量。
 *
 * 范围声明：跑在 Chromium 而不是 Electron，因此未覆盖原生视图与真实合成的交互；
 * 那一部分由 experiments/d2-02/native-view-lifecycle 与 Gate 七组探针承担。
 */
import { createRequire } from "node:module";
import { Probe, VERDICT, appUrl, serveDist, launch, sleep } from "./lib/app.mjs";

const require = createRequire(import.meta.url);
const domain = require("../../electron/window-domain.cjs");
const manager = require("../../electron/window-manager.cjs");

const SEED_W = 1440;
const SEED_H = 1000;

const p = new Probe("window-stress", "窗口压力流程与 DOM↔域 差分比对");

/* 起始盘面：四个最小尺寸窗口，四象限摆开，互不重叠。 */
const seedState = manager.applyAll(domain.createState(), [
  { type: "window/open", appId: "home", bounds: { x: 20, y: 60, w: 560, h: 400 }, meta: { title: "应用中心", icon: "apps" } },
  {
    type: "window/open",
    appId: "browser",
    bounds: { x: 620, y: 60, w: 560, h: 400 },
    meta: { title: "浏览器", icon: "safari", url: "https://example.com" },
  },
  { type: "window/open", appId: "files", bounds: { x: 20, y: 480, w: 560, h: 400 }, meta: { title: "文件", icon: "finder" } },
  {
    type: "window/open",
    appId: "settings",
    bounds: { x: 620, y: 480, w: 560, h: 400 },
    meta: { title: "系统设置", icon: "settings" },
  },
]);

const server = await serveDist();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: SEED_W, height: SEED_H } });

const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errs.push(m.text());
});

const SEED = manager.serialize(seedState);
/**
 * 桌面文件夹也预置。第 17 步要验证的是"删除确认对话框不影响窗口状态"，
 * 而"右键新建文件夹"的落点取决于点击坐标 —— 那时窗口已经铺到右下角，
 * 点位随时可能被窗口盖住，断言会退化成"点不到"的假失败。
 * 摆在右上角的空白桌面（窗口都不在那里），把位置变量去掉。
 */
const SEED_FOLDERS = JSON.stringify([{ id: "fseed", name: "压力测试", x: 1180, y: 180 }]);
await page.addInitScript(
  ([seed, folders]) => {
    try {
      if (!localStorage.getItem("oa-wins")) localStorage.setItem("oa-wins", seed);
      if (!localStorage.getItem("oa-folders")) localStorage.setItem("oa-folders", folders);
    } catch {
      /* ignore */
    }
  },
  [SEED, SEED_FOLDERS],
);
await page.goto(appUrl());
await page.waitForSelector(".desktop", { timeout: 15000 });
await sleep(500);

/** 真实宿主尺寸 —— 重放必须用同一个 host，否则 clamp 结果对不上。 */
const HOST = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
p.note(`宿主尺寸 ${HOST.width}×${HOST.height}（重放与产品必须用同一份）`);

/* ══════════════════════════════════════════════════════════════════════════
   读回 DOM：窗口 id 从它自己的关闭按钮 aria-label 取（"关闭<id>"）
   ══════════════════════════════════════════════════════════════════════════ */
const readDom = () =>
  page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll(".window")) {
      const closeLabel = el.querySelector(".window-title .traffic .close")?.getAttribute("aria-label") || "";
      const id = closeLabel.replace(/^关闭/, "");
      out[id] = {
        left: Math.round(parseFloat(el.style.left) || 0),
        top: Math.round(parseFloat(el.style.top) || 0),
        width: Math.round(parseFloat(el.style.width) || 0),
        height: Math.round(parseFloat(el.style.height) || 0),
        z: Number(el.style.zIndex || 0),
        active: el.classList.contains("active"),
        minimized: el.classList.contains("minimized"),
        hasResizeHandle: !!el.querySelector(".resize"),
      };
    }
    return out;
  });

/** 域的投影 = 期望的 DOM 形状。公式来自组件契约（zIndex = 10 + w.z 等）。 */
const project = (state) => {
  const out = {};
  for (const w of state.windows) {
    out[w.id] = {
      left: w.bounds.x,
      top: w.bounds.y,
      width: w.bounds.w,
      height: w.bounds.h,
      z: 10 + w.z,
      active: state.focused === w.id,
      minimized: w.state === domain.WSTATE.MINIMIZED,
      hasResizeHandle: w.state !== domain.WSTATE.MAXIMIZED,
    };
  }
  return out;
};

const KEYS = ["left", "top", "width", "height", "z", "active", "minimized", "hasResizeHandle"];

const diff = (expect, actual) => {
  const bad = [];
  for (const id of new Set([...Object.keys(expect), ...Object.keys(actual)])) {
    const e = expect[id];
    const a = actual[id];
    if (!e) {
      bad.push(`窗口 ${id} 出现在 DOM 里但不在域里`);
      continue;
    }
    if (!a) {
      bad.push(`窗口 ${id} 在域里但 DOM 里没有`);
      continue;
    }
    for (const k of KEYS) if (e[k] !== a[k]) bad.push(`${id}.${k}: 域=${e[k]} DOM=${a[k]}`);
  }
  return bad;
};

/* ══════════════════════════════════════════════════════════════════════════
   步骤执行器：先算命令 → 再动 UI → 再比对
   ══════════════════════════════════════════════════════════════════════════ */
// deserialize 收的是**已解析**的对象（产品侧同样先 JSON.parse 再传进来）
let expected = manager.deserialize(JSON.parse(SEED), [manager.areaOf(HOST)]);
let stepNo = 0;
const failures = [];

async function step(name, makeCommands, run, settle = 320) {
  stepNo += 1;
  const commands = makeCommands(expected);
  await run();
  await sleep(settle);
  expected = manager.applyAll(expected, commands);
  const actual = await readDom();
  const bad = diff(project(expected), actual);
  const inv = domain.invariants(expected);
  const ok = bad.length === 0 && inv.length === 0;
  if (!ok) failures.push({ step: stepNo, name, bad, inv });
  p.assert(
    `${String(stepNo).padStart(2, "0")}.${name}`,
    ok,
    ok ? "" : bad.length ? `DOM 与域不一致：${bad.join("；")}` : `域不变量被破坏：${inv.join("；")}`,
  );
  return actual;
}

const win = (title) => page.locator(`.window[aria-label="${title}窗口"]`);

/**
 * 点窗口里的任何东西之前，`section.window` 的 onPointerDown 会先把它聚焦（若尚未聚焦）。
 * 重放必须带上这一步，否则"域与 DOM 一致"的断言会因为少算一条命令而假失败。
 */
const focusFirst = (s, id) => (s.focused === id ? [] : [{ type: "window/focus", id }]);

/** 拖动标题栏：位移精确等于 (dx,dy)。组件把位移算出来，clamp 由域做。 */
async function dragBy(title, dx, dy, startOffset = 100) {
  const box = await win(title).locator(".window-title").boundingBox();
  const x0 = Math.round(box.x) + startOffset;
  const y0 = Math.round(box.y) + 22;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x0 + dx, y0 + dy, { steps: 1 });
  await page.mouse.up();
}

const dragTo = (title, dx, dy) => dragBy(title, dx, dy);

async function resizeBy(title, dx, dy) {
  const box = await win(title).locator(".resize").boundingBox();
  const x0 = Math.round(box.x + box.width / 2);
  const y0 = Math.round(box.y + box.height / 2);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  // Playwright 不能把指针移到视口之外，因此夹到视口内 ——
  // 组件算出的位移量仍然很大，足以触发域的 clamp。
  await page.mouse.move(
    Math.max(2, Math.min(SEED_W - 2, x0 + dx)),
    Math.max(2, Math.min(SEED_H - 2, y0 + dy)),
    { steps: 1 },
  );
  await page.mouse.up();
}

/* ══════════════════════════════════════════════════════════════════════════
   压力序列
   ══════════════════════════════════════════════════════════════════════════ */
const d0 = await readDom();
p.assert("00.seededDesktopMatchesDomain", diff(project(expected), d0).length === 0, `起始盘面就不一致：${diff(project(expected), d0).join("；")}`);
p.assert(
  "00.nothingIsFocusedAfterRestore",
  expected.focused === null && Object.values(d0).every((w) => !w.active),
  `恢复后不应预设焦点，实测 focused=${expected.focused}`,
);

// 01：点标题栏切换焦点（同时置顶）
await step(
  "focusFilesByTitleClick",
  (s) => focusFirst(s, "files"),
  () => win("文件").locator(".window-title").click({ position: { x: 260, y: 22 } }),
);

// 02：小幅拖动
await step(
  "dragFilesByMinus10x30",
  (s) => {
    const b = domain.byId(s, "files").bounds;
    return [...focusFirst(s, "files"), { type: "window/move", id: "files", x: b.x - 10, y: b.y - 30, host: HOST }];
  },
  () => dragTo("文件", -10, -30),
);

// 03：**指针离开标题栏之后必须继续跟手**。
//     这一条覆盖的是刚修掉的真缺陷：原先监听器挂在标题栏元素上并依赖
//     setPointerCapture，而捕获实测并不总会生效 —— 指针一离开 44px 的标题栏，
//     窗口就不跟手了（缩放手柄只有 22px，更早断）。
await step(
  "dragKeepsTrackingAfterPointerLeavesTitleBar",
  (s) => {
    const b = domain.byId(s, "files").bounds;
    return [...focusFirst(s, "files"), { type: "window/move", id: "files", x: b.x + 240, y: b.y + 260, host: HOST }];
  },
  () => dragTo("文件", 240, 260),
);

// 04：拖到右下越界 —— 域必须把标题栏留在可抓范围内（clamp 是域的职责）
const OVER_X = 800;
const OVER_Y = 200;
await step(
  "dragPastBottomRightIsClampedByDomain",
  (s) => {
    const b = domain.byId(s, "files").bounds;
    return [...focusFirst(s, "files"), { type: "window/move", id: "files", x: b.x + OVER_X, y: b.y + OVER_Y, host: HOST }];
  },
  () => dragTo("文件", OVER_X, OVER_Y),
);

// 05：缩放（点缩放手柄先聚焦该窗口）
const RW = 60;
const RH = 40;
await step(
  "resizeBrowserBy60x40",
  (s) => {
    const b = domain.byId(s, "browser").bounds;
    return [
      ...focusFirst(s, "browser"),
      { type: "window/resize", id: "browser", w: b.w + RW, h: b.h + RH, host: HOST },
    ];
  },
  () => resizeBy("浏览器", RW, RH),
);

// 06：缩放远低于最小尺寸 —— 域必须 clamp，而不是听组件的话
await step(
  "resizeBelowMinimumIsClamped",
  (s) => {
    const b = domain.byId(s, "browser").bounds;
    return [...focusFirst(s, "browser"), { type: "window/resize", id: "browser", w: b.w - 5000, h: b.h - 5000, host: HOST }];
  },
  () => resizeBy("浏览器", -5000, -5000),
);

// 07：最小化（焦点交还最上层剩余窗口）
await step(
  "minimizeSettings",
  (s) => [...focusFirst(s, "settings"), { type: "window/minimize", id: "settings" }],
  () => win("系统设置").locator(".window-title .traffic .minimize").click(),
);

// 08：最大化（保存 restore 快照）
await step(
  "maximizeHome",
  (s) => [...focusFirst(s, "home"), { type: "window/maximize", id: "home", host: HOST }],
  () => win("应用中心").locator(".window-title .traffic .maximize").click(),
);

// 09：双击已最大化的窗口 → 还原。
//     这一条就是"window/unmaximize 必须在产品里可达"的守卫：
//     只发 maximize 的实现会让用户放大后再也回不来。
await step(
  "doubleClickRestoresMaximized",
  () => [{ type: "window/unmaximize", id: "home" }],
  () => win("应用中心").locator(".window-title").dblclick({ position: { x: 300, y: 22 } }),
);

// 10：再次最大化 → 缩放手柄必须消失
await step(
  "maximizeAgainHidesResizeHandle",
  () => [{ type: "window/maximize", id: "home", host: HOST }],
  () => win("应用中心").locator(".window-title .traffic .maximize").click(),
);

// 11：最大化状态下拖动必须无效（域里 move 被拒，DOM 也不许动）。
//     期望命令是空的：组件在 MAXIMIZED 时根本不发起拖动。
await step(
  "dragWhileMaximizedIsNoop",
  () => [],
  () => dragTo("应用中心", 120, 80),
);

// 12：还原，尺寸回到快照而不是最大化后的矩形
await step(
  "unmaximizeRestoresSnapshot",
  () => [{ type: "window/unmaximize", id: "home" }],
  () => win("应用中心").locator(".window-title").dblclick({ position: { x: 300, y: 22 } }),
);

// 13：关闭浏览器
await step(
  "closeBrowser",
  (s) => [...focusFirst(s, "browser"), { type: "window/close", id: "browser" }],
  () => win("浏览器").locator(".window-title .traffic .close").click(),
);

// 13-15：系统级覆盖层开关 —— 不动窗口状态，但绝不能留下残留遮挡层
await step(
  "openSearchOverlay",
  () => [],
  async () => {
    await page.locator('.topbar button[aria-label="全局搜索"]').click();
    await sleep(320);
  },
);
await step(
  "closeSearchOverlayWithEscape",
  () => [],
  async () => {
    await page.keyboard.press("Escape");
    await sleep(320);
  },
);
await step(
  "openAndCloseAiPanel",
  () => [],
  async () => {
    await page.locator('.topbar button[aria-label="全局 AI"]').click();
    await sleep(320);
    await page.locator('.ai-panel button[aria-label="关闭AI面板"]').click();
    await sleep(320);
  },
);

// 17：产品自身的删除确认对话框（Dialog 的真实消费路径）。
//     走的是"右键文件夹 → 菜单末项(删除) → 确认"，全程真实键盘 + 真实点击，
//     覆盖 ContextMenu 的键盘导航与 Dialog 的按钮语义。
await step(
  "folderDeleteDialogLeavesWindowsUntouched",
  () => [],
  async () => {
    await page.locator(".desktop-folder").first().click({ button: "right" });
    await sleep(280);
    await page.keyboard.press("End"); // 跳到末项 = 删除
    await page.keyboard.press("Enter");
    await sleep(420);
    await page.locator('[role="dialog"] button.primary.danger').click(); // 确认删除
    await sleep(420);
  },
);

// 17：宿主窗口缩小 —— 所有窗口必须被收拢回可见工作区（§23 / §24 同一条不变量）
const SMALL = { width: 1040, height: 760 };
await step(
  "shrinkHostReflowsAllWindows",
  () => [{ type: "system/reflow", areas: [manager.areaOf(SMALL)], host: SMALL }],
  async () => {
    await page.setViewportSize(SMALL);
  },
  700,
);

/* ══════════════════════════════════════════════════════════════════════════
   收尾断言
   ══════════════════════════════════════════════════════════════════════════ */
const finalDom = await readDom();
const cap = manager.areaOf(SMALL);
const outside = Object.entries(finalDom)
  .filter(([, w]) => w.left < cap.x || w.top < cap.y || w.left + w.width > cap.x + cap.width || w.top + w.height > cap.y + cap.height)
  .map(([id, w]) => `${id}@${w.left},${w.top} ${w.width}×${w.height}`);
p.assert(
  "18.allWindowsInsideWorkAreaAfterShrink",
  outside.length === 0,
  `缩小宿主后越出工作区的窗口：${outside.join("；")}（工作区 ${cap.x},${cap.y} ${cap.width}×${cap.height}）`,
);
p.assert(
  "19.allWindowsRespectMinimumSize",
  Object.values(finalDom).every((w) => w.width >= domain.MIN_WINDOW_W && w.height >= domain.MIN_WINDOW_H),
  `有窗口被压到最小尺寸之下：${JSON.stringify(Object.entries(finalDom).map(([id, w]) => [id, w.width, w.height]))}`,
);
p.assert("20.domainInvariantsHoldAtEnd", domain.invariants(expected).length === 0, `违规：${JSON.stringify(domain.invariants(expected))}`);
p.assert(
  "21.noResidualOverlay",
  (await page.locator(".menu-shade").count()) === 0 &&
    (await page.locator('[role="dialog"]').count()) === 0 &&
    (await page.evaluate(() => !document.querySelector(".desktop-surface")?.hasAttribute("inert"))),
  "覆盖层 / 对话框 / inert 有残留，桌面会永久不可点",
);
p.assert("22.stateMatchesDomainAtEnd", diff(project(expected), finalDom).length === 0, `最终 DOM 与域不一致：${diff(project(expected), finalDom).join("；")}`);
p.assert("23.noPageErrors", errs.length === 0, `页面报错：${errs.slice(0, 3).join(" | ")}`);

if (failures.length) {
  p.note(`共 ${failures.length} 步出现 DOM↔域 漂移；第一步是 ${failures[0].step}.${failures[0].name}`);
  p.note(`首步差异：${failures[0].bad.join("；") || failures[0].inv.join("；")}`);
}

await browser.close();
server.close();
const res = p.write();
console.log(`\n== ${p.id} 结论：${res.verdict} — ${JSON.stringify(res.counts)}`);
console.log(`   产物：${res.file}`);
process.exit(res.verdict === VERDICT.FAIL ? 1 : 0);
