/**
 * D2-02B · 双浏览器窗口互相独立（§12 / §13 / §32 / §44）。
 *
 * 分两段，两段都必须过：
 *
 *   1. **契约段**（Node，无浏览器）—— 用产品真实模块 window-domain / window-manager /
 *      native-view-controller 验证：同一个 App 可以有两个 Window、两条原生意图、
 *      同一个 session 分区；关掉一个不影响另一个。
 *      §12 的架构前提在这里成立或直接失败。
 *
 *   2. **产品段**（Playwright 打真实产品页 dist/index.html）—— 用真实持久化格式
 *      （由 manager.serialize 产出，不是手搓 JSON）预置两个浏览器窗口，
 *      验证产品自己渲染出两个互不牵连的窗口：地址栏、焦点、层级、位置、
 *      最小化、关闭全部按窗口隔离。
 *
 * 为什么要两段：段 1 若不过，段 2 的"独立"就无从谈起；段 2 若不过，
 * 段 1 通过也只是模块自洽 —— 产品可能压根没消费它。
 *
 * 范围声明：本探针在 Chromium 里跑，不是 Electron。因此它证明的是
 * "DOM 侧两个窗口互相独立"，而"两个 WebContentsView 互相独立"由
 * experiments/d2-02/native-view-lifecycle 的 multi.* 断言证明（各自有各自的证据）。
 */
import { createRequire } from "node:module";
import { Probe, VERDICT, appUrl, serveDist, launch, sleep } from "./lib/app.mjs";

const require = createRequire(import.meta.url);
const domain = require("../../electron/window-domain.cjs");
const manager = require("../../electron/window-manager.cjs");
const { NativeViewController } = require("../../electron/native-view-controller.cjs");

const HOST = { width: 1440, height: 1000 };

const A_BOUNDS = { x: 80, y: 80, w: 700, h: 520 };
const B_BOUNDS = { x: 400, y: 220, w: 700, h: 520 };

/** 用产品自己的命令层造出"两个浏览器窗口"的状态，再让产品自己的序列化写出来。 */
const seededState = () =>
  manager.applyAll(domain.createState(), [
    {
      type: "window/open",
      appId: "browser",
      id: "browser-a",
      bounds: { ...A_BOUNDS },
      meta: { title: "浏览器 A", icon: "safari", url: "https://example.com/a" },
    },
    {
      type: "window/open",
      appId: "browser",
      id: "browser-b",
      bounds: { ...B_BOUNDS },
      meta: { title: "浏览器 B", icon: "safari", url: "https://example.com/b" },
    },
  ]);

const p = new Probe("two-browser", "双浏览器窗口互相独立（契约段 + 产品段）");

/* ══════════════════════════════════════════════════════════════════════════
   段 1 · 契约（Node，无浏览器）
   ══════════════════════════════════════════════════════════════════════════ */
console.log("\n-- 段 1：契约（产品真实模块） --");
const s0 = seededState();

p.assert(
  "contract.twoWindowIdsForOneApp",
  s0.windows.length === 2 && domain.windowsOfApp(s0, "browser").length === 2,
  `windows=${s0.windows.length} windowsOfApp=${JSON.stringify(domain.windowsOfApp(s0, "browser"))}`,
);
p.assert(
  "contract.idsDifferFromAppId",
  s0.windows.every((w) => w.appId === "browser" && w.id !== w.appId),
  `id/appId 被写死了同一值：${JSON.stringify(s0.windows.map((w) => [w.id, w.appId]))}`,
);
p.assert(
  "contract.bothAreNativeKind",
  s0.windows.every((w) => w.kind === domain.KIND.BROWSER && domain.isNativeKind(w.kind)),
  `kind=${JSON.stringify(s0.windows.map((w) => w.kind))}`,
);
p.assert("contract.invariantsHold", domain.invariants(s0).length === 0, `违规：${JSON.stringify(domain.invariants(s0))}`);

const intents = manager.nativeIntents(s0, HOST);
p.assert(
  "contract.oneIntentPerWindow",
  intents.length === 2 && new Set(intents.map((i) => i.windowId)).size === 2,
  `intents=${JSON.stringify(intents.map((i) => i.windowId))}`,
);
p.assert(
  "contract.viewportsAreDistinct",
  intents[0].viewport.x !== intents[1].viewport.x && intents[0].viewport.y !== intents[1].viewport.y,
  `两个窗口的视口重合了：${JSON.stringify(intents.map((i) => i.viewport))}`,
);
p.assert(
  "contract.sessionSharedPerApp",
  NativeViewController.partitionFor("browser") === NativeViewController.partitionFor("browser") &&
    NativeViewController.partitionFor("browser") !== NativeViewController.partitionFor("home"),
  `browser=${NativeViewController.partitionFor("browser")} home=${NativeViewController.partitionFor("home")}（§13 冻结：同一 App 共享 session，不同 App 不共享）`,
);

const focusedA = manager.reduce(s0, { type: "window/focus", id: "browser-a" });
const closedA = manager.reduce(focusedA, { type: "window/close", id: "browser-a" });
p.assert(
  "contract.closeOneLeavesTheOther",
  closedA.windows.length === 1 &&
    domain.byId(closedA, "browser-b") !== null &&
    domain.byId(closedA, "browser-a") === null,
  `关掉 A 之后：${JSON.stringify(closedA.windows.map((w) => w.id))}`,
);
p.assert(
  "contract.focusIsSingleValue",
  focusedA.focused === "browser-a" && typeof focusedA.focused === "string",
  `focused=${JSON.stringify(focusedA.focused)}（焦点必须是单个值，不是集合）`,
);
p.assert(
  "contract.minimizeIsPerWindow",
  (() => {
    const m = manager.reduce(focusedA, { type: "window/minimize", id: "browser-b" });
    const a = domain.byId(m, "browser-a");
    const b = domain.byId(m, "browser-b");
    return a.state === domain.WSTATE.NORMAL && b.state === domain.WSTATE.MINIMIZED;
  })(),
  "最小化 B 把 A 一起最小化了 —— 说明状态没有按窗口分开",
);
// 关掉 B 之后 A 必须是焦点，而不是留下一个指向已销毁窗口的 focused
const closedB = manager.reduce(focusedA, { type: "window/close", id: "browser-b" });
p.assert(
  "contract.focusFallsBackToSurvivor",
  closedB.focused === "browser-a" && domain.invariants(closedB).length === 0,
  `focused=${closedB.focused}（应落到唯一幸存窗口）`,
);

/* ══════════════════════════════════════════════════════════════════════════
   段 2 · 产品（真实产品页）
   ══════════════════════════════════════════════════════════════════════════ */
console.log("\n-- 段 2：产品页 --");
const server = await serveDist();
const browser = await launch();
const page = await browser.newPage({ viewport: HOST });

const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errs.push(m.text());
});

/** 预置：只在没有 oa-wins 时写入，这样 reload 之后才测得到"真的持久化了"。 */
const SEED = manager.serialize(s0);
await page.addInitScript(
  ([seed]) => {
    try {
      if (!localStorage.getItem("oa-wins")) localStorage.setItem("oa-wins", seed);
    } catch {
      /* ignore */
    }
  },
  [SEED],
);
await page.goto(appUrl());
await page.waitForSelector(".desktop", { timeout: 15000 });
await sleep(500);

/** 按 aria-label 找到窗口元素。窗口的 aria-label 是 `${title}窗口`。 */
const win = (title) => page.locator(`.window[aria-label="${title}窗口"]`);

const geom = (title) =>
  page.evaluate((t) => {
    const el = document.querySelector(`.window[aria-label="${t}窗口"]`);
    if (!el) return null;
    return {
      left: Math.round(parseFloat(el.style.left) || 0),
      top: Math.round(parseFloat(el.style.top) || 0),
      width: Math.round(parseFloat(el.style.width) || 0),
      height: Math.round(parseFloat(el.style.height) || 0),
      z: Number(el.style.zIndex || 0),
      active: el.classList.contains("active"),
      minimized: el.classList.contains("minimized"),
      url: el.querySelector(".addressbar input")?.value ?? null,
    };
  }, title);

const counts = () =>
  page.evaluate(() => ({
    windows: document.querySelectorAll(".window").length,
    active: document.querySelectorAll(".window.active").length,
  }));

p.assert("render.twoWindows", (await page.locator(".window").count()) === 2, `实测 ${await page.locator(".window").count()} 个 .window`);
p.assert("render.windowA", (await win("浏览器 A").count()) === 1, "浏览器 A 未渲染");
p.assert("render.windowB", (await win("浏览器 B").count()) === 1, "浏览器 B 未渲染");

const a0 = await geom("浏览器 A");
const b0 = await geom("浏览器 B");
p.assert(
  "render.geometryFromPersisted",
  a0.left === A_BOUNDS.x && a0.top === A_BOUNDS.y && b0.left === B_BOUNDS.x && b0.top === B_BOUNDS.y,
  `A=${JSON.stringify(a0)} B=${JSON.stringify(b0)} 期望 A=(${A_BOUNDS.x},${A_BOUNDS.y}) B=(${B_BOUNDS.x},${B_BOUNDS.y})`,
);
p.assert(
  "render.addressBarsCarryOwnUrl",
  a0.url === "https://example.com/a" && b0.url === "https://example.com/b",
  `A.url=${a0.url} B.url=${b0.url}（两个地址栏不能读同一个状态）`,
);

// 地址栏独立：改 A 不能动到 B
await win("浏览器 A").locator(".addressbar input").fill("https://example.com/typed-in-a");
await sleep(250);
p.assert(
  "state.addressBarsIndependent",
  (await geom("浏览器 A")).url === "https://example.com/typed-in-a" &&
    (await geom("浏览器 B")).url === "https://example.com/b",
  `改 A 之后 A.url=${(await geom("浏览器 A")).url} B.url=${(await geom("浏览器 B")).url}`,
);

// 焦点唯一 + 层级跟着焦点走
await win("浏览器 B").locator(".window-title").click({ position: { x: 200, y: 22 } });
await sleep(250);
p.assert("state.exactlyOneActive", (await counts()).active === 1, `active 数量=${(await counts()).active}`);
p.assert("state.focusFollowsClick", (await geom("浏览器 B")).active === true, "点击 B 之后 B 不是 active");
const z1 = { a: (await geom("浏览器 A")).z, b: (await geom("浏览器 B")).z };
p.assert("state.zOrderFollowsFocus", z1.b > z1.a, `B.z=${z1.b} 应高于 A.z=${z1.a}（层级必须由 order 决定）`);

await win("浏览器 A").locator(".window-title").click({ position: { x: 200, y: 22 } });
await sleep(250);
const z2 = { a: (await geom("浏览器 A")).z, b: (await geom("浏览器 B")).z };
p.assert("state.zOrderIsSymmetric", z2.a > z2.b && (await geom("浏览器 A")).active, `重新聚焦 A 之后 A.z=${z2.a} B.z=${z2.b}`);

// 拖动 A：只有 A 动
const before = { a: await geom("浏览器 A"), b: await geom("浏览器 B") };
const box = await win("浏览器 A").locator(".window-title").boundingBox();
await page.mouse.move(box.x + 220, box.y + 22);
await page.mouse.down();
await page.mouse.move(box.x + 220 + 70, box.y + 22 + 45, { steps: 12 });
await page.mouse.up();
await sleep(300);
const after = { a: await geom("浏览器 A"), b: await geom("浏览器 B") };
p.assert(
  "state.dragMovesOnlyDraggedWindow",
  after.a.left === before.a.left + 70 && after.b.left === before.b.left && after.b.top === before.b.top,
  `A 位移=${after.a.left - before.a.left},${after.a.top - before.a.top}；B 位移=${after.b.left - before.b.left},${after.b.top - before.b.top}`,
);

// 持久化：reload 之后两个窗口与它们各自的位置都回来
const draggedA = after.a;
await page.reload();
await page.waitForSelector(".window", { timeout: 15000 });
await sleep(500);
const rA = await geom("浏览器 A");
p.assert("persist.twoWindowsSurviveReload", (await page.locator(".window").count()) === 2, `reload 后窗口数=${await page.locator(".window").count()}`);
p.assert(
  "persist.geometrySurvivesReload",
  rA.left === draggedA.left && rA.top === draggedA.top,
  `reload 前 A=(${draggedA.left},${draggedA.top})，reload 后 A=(${rA.left},${rA.top})`,
);
p.assert(
  "persist.focusIsNotPersisted",
  (await counts()).active === 0,
  `reload 后仍有 ${(await counts()).active} 个 active 窗口 —— 上次谁在最上层不该决定这次的层级`,
);

// Dock：运行指示点按 appId → windows[] 判定
const dockDot = () =>
  page.evaluate(() => {
    const item = [...document.querySelectorAll(".dock-item")].find((b) => (b.getAttribute("aria-label") || "").includes("浏览器"));
    return item ? item.querySelector(".running-dot")?.classList.contains("running") ?? null : null;
  });
p.assert("dock.runningWhileAnyWindowExists", (await dockDot()) === true, "浏览器有两个窗口，Dock 的运行点却是灭的（§32：必须按 appId 聚合）");

/*
 * Dock 的三条路径（§32）。
 *
 * 关键点：Dock 只知道 appId，不知道 browser-a / browser-b。
 * 早先的实现无条件派发 `window/open`（按 id 幂等）—— 在 id ≠ appId 时，
 * 点 Dock 既聚焦不到任何已有窗口，还会**多开一个**。这是本探针抓到的真实缺陷。
 *
 * 正确的消费方式是拿 `appId → windowIds[]` 做判断：
 *   有可见窗口 → 聚焦最上面那个（不新建）
 *   全部最小化 → 恢复最上面那个
 *   一个都没有 → 新建
 */
const dockBrowser = page.locator('.dock-item[aria-label="打开浏览器"]');

// A 先成为焦点（也让它在最上层），再最小化它
await win("浏览器 A").locator(".window-title").click({ position: { x: 220, y: 22 } });
await sleep(250);
await win("浏览器 A").locator(".window-title .traffic .minimize").click();
await sleep(300);
const mA = await geom("浏览器 A");
const mB = await geom("浏览器 B");
p.assert(
  "state.minimizeIsPerWindowInProduct",
  mA.minimized === true && mB.minimized === false,
  `最小化 A 之后 A.minimized=${mA.minimized} B.minimized=${mB.minimized}`,
);
p.assert("state.minimizedWindowDoesNotOwnFocus", mA.active === false, "已最小化的窗口仍是 active");
p.assert("dock.runningStillOn", (await dockDot()) === true, "还有一个窗口存活，运行点不该灭");

// 路径 1：还有可见窗口 → 聚焦它，且**不得新建窗口**
await dockBrowser.click();
await sleep(400);
p.assert(
  "dock.focusesVisibleWindowWithoutOpeningNew",
  (await page.locator(".window").count()) === 2 && (await geom("浏览器 B")).active === true,
  `点 Dock 之后窗口数=${await page.locator(".window").count()}（必须仍是 2），B.active=${(await geom("浏览器 B")).active}`,
);

// 关掉 B：A 虽然最小化着，也必须还在（关一个不能带走另一个）
await win("浏览器 B").locator(".window-title .traffic .close").click();
await sleep(350);
p.assert("state.closeIsPerWindow", (await page.locator(".window").count()) === 1, `关掉 B 之后窗口数=${await page.locator(".window").count()}`);
p.assert("state.survivorIsA", (await win("浏览器 A").count()) === 1 && (await win("浏览器 B").count()) === 0, "关掉 B 却把 A 一起关掉了");
p.assert("dock.runningStillOnWithOneWindow", (await dockDot()) === true, "A 还在，运行点不该灭");

// 路径 2：全部最小化（此时只剩 A 且它是最小化的）→ 恢复它
await dockBrowser.click();
await sleep(400);
const backA = await geom("浏览器 A");
p.assert(
  "dock.restoresWhenAllWindowsMinimized",
  backA.minimized === false && backA.active === true && (await page.locator(".window").count()) === 1,
  `点 Dock 之后 A.minimized=${backA.minimized} A.active=${backA.active} 窗口数=${await page.locator(".window").count()}（期望恢复 A，且不新增）`,
);

// 路径 3：关掉最后一个窗口 → 运行点必须灭
await win("浏览器 A").locator(".window-title .traffic .close").click();
await sleep(350);
p.assert("dock.runningOffWhenNoWindow", (await dockDot()) === false, "没有窗口了，Dock 运行点还是亮的");
p.assert("state.emptyDesktop", (await page.locator(".window").count()) === 0, `全部关闭后仍有 ${await page.locator(".window").count()} 个窗口`);

p.assert("noPageErrors", errs.length === 0, `页面报错：${errs.slice(0, 3).join(" | ")}`);

await browser.close();
server.close();
const res = p.write();
console.log(`\n== ${p.id} 结论：${res.verdict} — ${JSON.stringify(res.counts)}`);
console.log(`   产物：${res.file}`);
process.exit(res.verdict === VERDICT.FAIL ? 1 : 0);
