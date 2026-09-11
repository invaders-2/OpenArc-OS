/**
 * D2-02B · Reduce Motion 三路径的**功能状态一致性**（§28，与 §27 成对）。
 *
 * 三路径（tokens.css 明确承诺"走同一套结果"）：
 *   ① normal —— 什么都不开
 *   ② product —— 产品内开关：localStorage["oa-motion"]="true" → 根节点 `.reduced` 类
 *   ③ system  —— 系统级设置：`@media (prefers-reduced-motion: reduce)`
 *
 * 要证明的命题不是"看起来一样"，而是：
 *   **Reduce Motion 只允许改变"看得见的过程"，不允许改变"结果"。**
 *   同一串真实交互之后，窗口的位置/尺寸/层级/焦点/最小化/缩放手柄必须逐项相同。
 *
 * 为什么这条必须有：reduced 把 transition-duration 压到 0，如果任何状态推进
 * 挂在 transitionend / animationend 上（§27 明令禁止），三路径就会分岔 ——
 * 而且分岔方向是"reduced 下功能卡死"，肉眼很难归因。差分是唯一能抓住它的判据。
 *
 * 非空验证：probe 先断言三条路径**确实是三种不同的渲染配置**
 * （normal 的 transition-duration 非 0；两条 reduced 路径为 0，且 system 路径
 * 不带 `.reduced` 类，确保走的是媒体查询而不是被类名蒙混过关）。
 * 否则"三边相等"可能只是因为三边都跑在同一个配置上 —— 那是空断言。
 */
import { createRequire } from "node:module";
import { Probe, VERDICT, appUrl, serveDist, launch, sleep } from "./lib/app.mjs";

const require = createRequire(import.meta.url);
const domain = require("../../electron/window-domain.cjs");
const manager = require("../../electron/window-manager.cjs");

const p = new Probe("motion-parity", "Reduce Motion 三路径窗口功能状态一致性");
const SEED_W = 1440;
const SEED_H = 1000;
const SETTLE = 300;

/** 预置一个窗口，让交互从确定的盘面开始（不依赖上次会话残留）。 */
const seedState = manager.applyAll(domain.createState(), [
  { type: "window/open", appId: "home", bounds: { x: 240, y: 160, w: 700, h: 500 }, meta: { title: "应用中心", icon: "apps" } },
]);
const SEED = manager.serialize(seedState);

const server = await serveDist();
const browser = await launch();

/* ══════════════════════════════════════════════════════════════════════════
   读回"功能状态" —— 只读窗口的领域可见量 + 覆盖层在场情况。
   刻意**不读**任何动画量（--s、transition 中间值、bouncing 类）：
   那些正是允许随路径不同的东西。
   ══════════════════════════════════════════════════════════════════════════ */
const readState = (page) =>
  page.evaluate(() => {
    const windows = {};
    for (const el of document.querySelectorAll(".window")) {
      const id = (el.querySelector(".window-title .traffic .close")?.getAttribute("aria-label") || "?").replace(/^关闭/, "");
      windows[id] = {
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
    return {
      windows,
      overlays: {
        search: !!document.querySelector(".search-panel"),
        ai: !!document.querySelector(".ai-panel"),
        dialog: !!document.querySelector('[role="dialog"]'),
      },
    };
  });

/** 渲染配置指纹 —— 用来证明三条路径真的不同（防止"三边相等"是空断言）。 */
const configFingerprint = (page) =>
  page.evaluate(() => {
    const d = document.querySelector(".desktop");
    const w = document.querySelector(".window");
    return {
      hasReducedClass: d?.classList.contains("reduced") ?? false,
      durStandard: getComputedStyle(d).getPropertyValue("--dur-standard").trim(),
      windowTransition: getComputedStyle(w).transitionDuration,
    };
  });

/* ── 与 window-stress 同一套真实指针手势 ── */
async function dragBy(page, title, dx, dy) {
  const box = await page.locator(`.window[aria-label="${title}窗口"] .window-title`).boundingBox();
  const x0 = Math.round(box.x) + 120;
  const y0 = Math.round(box.y) + 22;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x0 + dx, y0 + dy, { steps: 1 });
  await page.mouse.up();
}

async function resizeBy(page, title, dx, dy) {
  const box = await page.locator(`.window[aria-label="${title}窗口"] .resize`).boundingBox();
  const x0 = Math.round(box.x + box.width / 2);
  const y0 = Math.round(box.y + box.height / 2);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x0 + dx, y0 + dy, { steps: 1 });
  await page.mouse.up();
}

/**
 * 同一串交互脚本，三路径逐字重放。
 * 只包含"会推进领域状态"的动作 —— 这正是三边必须一致的部分。
 */
async function trace(page) {
  const shots = [];
  const snap = async (name) => shots.push({ name, ...(await readState(page)) });
  const click = async (sel) => {
    await page.locator(sel).click();
    await sleep(SETTLE);
  };

  // 说明：每一步都只操作**最顶层那个窗口自己的**标题栏按钮。
  // 这不是偷懒 —— 新开的窗口会压在旧窗口上，去点后台窗口的按钮会变成
  // "能不能点到"的脆弱前提；本条探针要验证的是三路径的**状态轨迹相同**，
  // 不该被点位问题污染（后台窗口按钮的可点性由 window-stress 单独覆盖）。
  await snap("00.initial");

  // Dock 打开（新建窗口路径）
  await click('.dock-item[aria-label="打开应用中心"]');
  await snap("01.dockOpensHome");

  // 拖动 + 缩放（连续指针手势）
  await dragBy(page, "应用中心", 60, 90);
  await sleep(SETTLE);
  await snap("02.dragHome");
  await resizeBy(page, "应用中心", 70, 50);
  await sleep(SETTLE);
  await snap("03.resizeHome");

  // 最小化 → 从 Dock 恢复（走的是 restore 分支，不是 focus 分支）
  await click('.window[aria-label="应用中心窗口"] .window-title .traffic .minimize');
  await snap("04.minimizeHome");
  await click('.dock-item[aria-label="打开应用中心"]');
  await snap("05.dockRestoresHome");

  // 最大化 → 双击还原
  await click('.window[aria-label="应用中心窗口"] .window-title .traffic .maximize');
  await snap("06.maximizeHome");
  await page.locator('.window[aria-label="应用中心窗口"] .window-title').dblclick({ position: { x: 320, y: 22 } });
  await sleep(SETTLE);
  await snap("07.dblclickRestoresHome");

  // 第二个窗口在场：层级 / 焦点 / 运行指示点一起被压上一层
  await click('.dock-item[aria-label="打开文件"]');
  await snap("08.dockOpensFiles");

  // 关掉它 → 焦点交还给下面那个；再关掉最后一个 → 桌面回到空盘
  await click('.window[aria-label="文件窗口"] .window-title .traffic .close');
  await snap("09.closeFiles");
  await click('.window[aria-label="应用中心窗口"] .window-title .traffic .close');
  await snap("10.closeHome");

  // 系统级覆盖层开关（覆盖层 / Dialog 不得改变窗口状态）
  await click('.topbar button[aria-label="全局搜索"]');
  await snap("11.searchOpen");
  await page.keyboard.press("Escape");
  await sleep(SETTLE);
  await snap("12.searchClosedViaEscape");
  await click('.topbar button[aria-label="全局 AI"]');
  await snap("13.aiOpen");
  await click('.ai-panel button[aria-label="关闭AI面板"]');
  await snap("14.aiClosed");

  return shots;
}

/* ══════════════════════════════════════════════════════════════════════════
   三条路径
   ══════════════════════════════════════════════════════════════════════════ */
const PATHS = [
  { id: "normal", label: "① normal（什么都不开）", init: () => {} },
  {
    id: "product",
    label: "② product（产品内开关 .reduced）",
    init: (_seed) => localStorage.setItem("oa-motion", "true"),
  },
  { id: "system", label: "③ system（@media prefers-reduced-motion）", init: () => {}, emulate: true },
];

const traces = {};
const fingerprints = {};
const pathErrors = {};

for (const path of PATHS) {
  const page = await browser.newPage({ viewport: { width: SEED_W, height: SEED_H } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  if (path.emulate) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(
    ([seed, useProductSwitch]) => {
      try {
        localStorage.setItem("oa-wins", seed);
        localStorage.removeItem("oa-folders");
        if (useProductSwitch) localStorage.setItem("oa-motion", "true");
        else localStorage.removeItem("oa-motion");
      } catch {
        /* ignore */
      }
    },
    [SEED, path.id === "product"],
  );
  await page.goto(appUrl());
  await page.waitForSelector(".desktop", { timeout: 15000 });
  await sleep(450);

  // 指纹必须在**跑脚本之前**取：脚本最后会把窗口全关掉，那时没有 .window 可量。
  fingerprints[path.id] = await configFingerprint(page);
  traces[path.id] = await trace(page);
  pathErrors[path.id] = errs;
  await page.close();
  p.note(`${path.label} 跑完：${traces[path.id].length} 步，无脚本错误=${errs.length === 0}`);
}

/* ══════════════════════════════════════════════════════════════════════════
   第 1 段：非空验证 —— 三条路径必须真是三种不同的渲染配置
   ══════════════════════════════════════════════════════════════════════════ */
const fp = fingerprints;
p.note(`配置指纹 normal=${JSON.stringify(fp.normal)}`);
p.note(`配置指纹 product=${JSON.stringify(fp.product)}`);
p.note(`配置指纹 system=${JSON.stringify(fp.system)}`);

/** transition-duration 可能是逗号分隔的多值；只要有一个非 0 就算"有动效"。 */
const animated = (v) => String(v || "").split(",").some((x) => parseFloat(x) > 0);

p.assert(
  "paths.normalIsAnimated",
  !fp.normal.hasReducedClass && animated(fp.normal.windowTransition),
  `normal 路径必须有非 0 的 transition-duration，实测 ${fp.normal.windowTransition}（--dur-standard=${fp.normal.durStandard}）`,
);
p.assert(
  "paths.productUsesReducedClass",
  fp.product.hasReducedClass,
  "product 路径应当在根节点带 .reduced 类（实测没有，说明开关没生效）",
);
p.assert(
  "paths.systemUsesMediaQueryNotClass",
  !fp.system.hasReducedClass && /^0(ms|s)$/.test(fp.system.durStandard || ""),
  `system 路径必须**不带** .reduced 类却拿到 0 时长，实测 hasReducedClass=${fp.system.hasReducedClass} --dur-standard=${fp.system.durStandard}`,
);
p.assert(
  "paths.productAndSystemBothZero",
  /^0(ms|s)$/.test(fp.product.durStandard || "") && /^0(ms|s)$/.test(fp.system.durStandard || ""),
  `两条 reduced 路径都应当把时长归零，实测 product=${fp.product.durStandard} system=${fp.system.durStandard}`,
);
p.assert(
  "paths.fingerprintsDiffer",
  new Set([JSON.stringify(fp.normal), JSON.stringify(fp.product), JSON.stringify(fp.system)]).size === 3,
  "三条路径的配置指纹必须互不相同，否则后面的相等断言是空的",
);

/* ══════════════════════════════════════════════════════════════════════════
   第 2 段：逐步差分 —— 功能状态必须逐项相同
   ══════════════════════════════════════════════════════════════════════════ */
const KEYS = ["left", "top", "width", "height", "z", "active", "minimized", "hasResizeHandle"];
const one = (a, b) => {
  const bad = [];
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[id];
    const y = b[id];
    if (!x || !y) {
      bad.push(`窗口 ${id} 只在一侧出现`);
      continue;
    }
    for (const k of KEYS) if (x[k] !== y[k]) bad.push(`${id}.${k}: ${x[k]} vs ${y[k]}`);
  }
  return bad;
};

const names = traces.normal.map((s) => s.name);
p.assert(
  "trace.sameStepNames",
  names.length === traces.product.length &&
    names.length === traces.system.length &&
    names.every((n, i) => n === traces.product[i].name && n === traces.system[i].name),
  "三条路径的步骤数/步骤名必须一致，否则比对无意义",
);

for (const name of names) {
  const get = (id) => traces[id].find((s) => s.name === name);
  const a = get("normal");
  const b = get("product");
  const c = get("system");
  const ab = one(a.windows, b.windows);
  const ac = one(a.windows, c.windows);
  const ov = JSON.stringify(a.overlays) === JSON.stringify(b.overlays) && JSON.stringify(a.overlays) === JSON.stringify(c.overlays);
  const ok = ab.length === 0 && ac.length === 0 && ov;
  p.assert(
    `parity.${name}`,
    ok,
    ok
      ? ""
      : `normal↔product: ${ab.join("；") || "无"} | normal↔system: ${ac.join("；") || "无"}` +
          (ov ? "" : ` | 覆盖层在场情况不一致：${JSON.stringify([a.overlays, b.overlays, c.overlays])}`),
  );
}

/* 允许不同、且应当不同的量：只记下来，不当断言 —— 它们是"过程"而不是"结果"。 */
p.note(
  "以下量刻意允许随路径不同（属「过程」，不属「结果」）：Dock 弹跳类 .bouncing（reduced 直接不弹）、" +
    "Dock 波浪 --s（reduced 固定为 1）、以及全部 transition/animation 时长。",
);

const anyErr = PATHS.some((x) => (pathErrors[x.id] || []).length);
p.assert("noPageErrors", !anyErr, `页面报错：${PATHS.map((x) => pathErrors[x.id]).flat().slice(0, 3).join(" | ")}`);

await browser.close();
server.close();
const res = p.write();
console.log(`\n== ${p.id} 结论：${res.verdict} — ${JSON.stringify(res.counts)}`);
console.log(`   产物：${res.file}`);
process.exit(res.verdict === VERDICT.FAIL ? 1 : 0);
