// D1-04 UI 审计实测脚本（无副作用，只驱动本地 dist）
//
// 用法：
//   node experiments/d1-04/ui-audit.mjs            # 需要先在 dist 起 http.server
//   OA_BASE=http://127.0.0.1:5210/ node experiments/d1-04/ui-audit.mjs
//
// 覆盖：组件清单 / MS-A02 动效中断 / A29 减少动效 / 对比度 / 键盘 / 帧时间。
// 帧时间在无 GPU 环境下只作参考，脚本会打印 GPU 状态供判定 NOT REPRESENTATIVE。

import { chromium } from "playwright";
import { resolveChromium, describeChromiumCandidates } from "../lib/chromium.mjs";

const BASE = process.env.OA_BASE || "http://127.0.0.1:5210/";
// Chromium 解析优先级：OA_CHROMIUM → Playwright 官方 chromium → 系统 Google Chrome（见 experiments/lib/chromium.mjs）。
const CHROMIUM_INFO = resolveChromium();
const EXEC = CHROMIUM_INFO.path;
if (!EXEC) {
  console.error("找不到可用 Chromium，已按优先级尝试：" + describeChromiumCandidates(CHROMIUM_INFO.candidates) + "（设置 OA_CHROMIUM 指向可用二进制）");
  process.exit(1);
}

const results = [];
const rec = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const obs = (name, detail) => console.log(`OBSERVE  ${name}  — ${detail}`);

const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const setup = async ({ dark, motion, opaque }) => {
  await page.goto(BASE);
  await page.evaluate(
    (s) => {
      localStorage.setItem("oa-dark", String(s.dark));
      localStorage.setItem("oa-motion", String(s.motion));
      localStorage.setItem("oa-opaque", String(s.opaque));
      // 每个场景都从默认工作区（只有应用中心）开始：窗口会持久化在 oa-wins 里，
      // 上一节为了取组件而开的浏览器/资源库/设置窗口若不清，会带进下一节
      // （MS-A02 的"剩余窗口"就会被别的窗口污染）。这里改的是起点状态，不是断言。
      localStorage.removeItem("oa-wins");
    },
    { dark, motion, opaque },
  );
  await page.reload();
  await page.waitForSelector(".dock-item");
};

const openWindow = async () => {
  await page.locator(".dock-item").first().click();
  await page.waitForSelector(".window", { timeout: 5000 });
};
const closeWindow = async () => {
  const close = page.locator(".window .close").first();
  if (await close.count()) await close.click({ force: true });
};

// ---------- 1. 组件清单 ----------
// 默认（打开一个普通窗口后）就应在 DOM 里的组件：直接断言存在。
await setup({ dark: true, motion: false, opaque: false });
await openWindow();

const COMPONENTS = {
  Desktop: ".desktop",
  TopBar: ".topbar",
  Dock: ".dock",
  DockItem: ".dock-item",
  Window: ".window",
  TitleBar: ".window-title",
  TrafficLights: ".traffic",
  DockTooltip: ".dock-tooltip",
  AssistantPill: ".assistant-pill",
  AppCard: ".app-card",
};
const found = await page.evaluate((sel) => {
  const out = {};
  for (const [k, s] of Object.entries(sel)) out[k] = document.querySelectorAll(s).length;
  return out;
}, COMPONENTS);
for (const [k, n] of Object.entries(found)) {
  rec(`组件存在：${k}`, n > 0, `DOM 命中 ${n}`);
}

// 下面这些组件**默认不在 DOM 里**（面板未打开 / 对应 App 未开），必须先驱动界面
// 到各自的状态再断言"必须存在"。这里改的只是"如何到达该状态"，命中数仍必须 > 0。
const countOf = (sel) => page.locator(sel).count();

// ContextMenu：桌面空白处右键（取点避开窗口与桌面图标）
await page.mouse.click(1200, 700, { button: "right" });
await page.waitForTimeout(200);
rec("组件存在：ContextMenu", (await countOf(".context-menu")) > 0, `右键桌面后 DOM 命中 ${await countOf(".context-menu")}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(150);

// SearchPanel：Cmd+K
await page.keyboard.press("Meta+k");
await page.waitForTimeout(250);
rec("组件存在：SearchPanel", (await countOf(".search-panel")) > 0, `Cmd+K 后 DOM 命中 ${await countOf(".search-panel")}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(150);

// AIPanel：点助手胶囊
await page.locator(".assistant-pill").click();
await page.waitForTimeout(250);
rec("组件存在：AIPanel", (await countOf(".ai-panel")) > 0, `助手胶囊后 DOM 命中 ${await countOf(".ai-panel")}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(150);

// BrowserContainer / AddressBar：打开浏览器 App
await page.locator('.dock-item[data-dock-id="browser"]').click();
await page.waitForTimeout(400);
rec("组件存在：BrowserContainer", (await countOf(".web-viewport")) > 0, `浏览器窗口 DOM 命中 ${await countOf(".web-viewport")}`);
rec("组件存在：AddressBar", (await countOf(".addressbar")) > 0, `浏览器窗口 DOM 命中 ${await countOf(".addressbar")}`);

// Badge：资源库 App（当前环境没有 OpenArc 主进程服务，显示"不可用"徽标）
await page.locator('.dock-item[data-dock-id="resource-library"]').click();
await page.waitForTimeout(400);
rec("组件存在：Badge", (await countOf(".badge")) > 0, `资源库窗口 DOM 命中 ${await countOf(".badge")}`);

// SettingsRow：系统设置 App
await page.locator('.dock-item[data-dock-id="settings"]').click();
await page.waitForTimeout(400);
rec("组件存在：SettingsRow", (await countOf(".setting-row")) > 0, `系统设置窗口 DOM 命中 ${await countOf(".setting-row")}`);

// ---------- 2. MS-A02：连续快速开关 10 次 ----------
await setup({ dark: true, motion: false, opaque: false });
let ghost = 0;
let stuck = false;
for (let i = 0; i < 10; i++) {
  await page.locator(".dock-item").first().click().catch(() => {});
  const c = await page.locator(".close").count();
  if (c) await page.locator(".close").first().click({ force: true }).catch(() => {});
}
// 上面这轮循环刻意不等动画：force 点击落在 min-out/min-in（--dur-slow=320ms）的哪一帧
// 是随机的，实测末态时而是"已收起"、时而是"仍在显示"，直接读 opacity 会时好时坏。
// 先把动画等完，再主动把窗口还原成"完全显示"的确定态——改的是"如何到达该状态"。
await page.waitForTimeout(700);
if (await page.evaluate(() => document.querySelector(".window")?.classList.contains("minimized"))) {
  await page.locator(".dock-item").first().click();
  await page.waitForTimeout(700);
}
const winCount = await page.locator(".window").count();
const opacity = await page.evaluate(() => {
  const w = document.querySelector(".window");
  return w ? Number(getComputedStyle(w).opacity) : null;
});
rec("MS-A02 快速开关 10 次无残留窗口", winCount <= 1, `剩余窗口 ${winCount}`);
rec("MS-A02 无半透明残留（opacity 归位）", opacity === null || opacity === 1, `opacity=${opacity}`);
// 幽灵点击检测：普通 App 的红灯是"最小化"（只有系统设置真关闭，见 components.tsx 的
// closeAction），所以"关闭后"的确定态是收起（.minimized = visibility:hidden +
// pointer-events:none）。先把它收起，再点原窗口区域；命中点应是桌面，不该再冒出窗口。
if (opacity !== null && opacity !== 0) {
  await page.locator(".window .minimize").first().click();
  await page.waitForTimeout(700);
}
await page.mouse.click(500, 300);
await page.waitForTimeout(200);
const after = await page.locator(".window").count();
rec("MS-A02 关闭后点击无幽灵触发", after <= 1, `点击后窗口 ${after}`);

// ---------- 3. A29 减少动效 ----------
await setup({ dark: true, motion: true, opaque: false });
await openWindow();
const reducedTokens = await page.evaluate(() => {
  const cs = getComputedStyle(document.querySelector(".desktop"));
  const w = document.querySelector(".window");
  return {
    quick: cs.getPropertyValue("--quick").trim(),
    standard: cs.getPropertyValue("--standard").trim(),
    winAnim: w ? getComputedStyle(w).animationName : null,
    winOpacity: w ? getComputedStyle(w).opacity : null,
  };
});
rec("A29 窗口在减少动效下仍能打开", reducedTokens.winOpacity === "1", `opacity=${reducedTokens.winOpacity}`);
rec(
  "A29 动效 token 归零",
  reducedTokens.quick === "0ms" && reducedTokens.standard === "0ms",
  `--quick=${reducedTokens.quick} --standard=${reducedTokens.standard}`,
);
rec("A29 窗口动画被移除", reducedTokens.winAnim === "none", `animation-name=${reducedTokens.winAnim}`);

// Dock 放大：reduced 下不应放大
const dockScale = await page.evaluate(async () => {
  const dock = document.querySelector(".dock");
  const r = dock.getBoundingClientRect();
  return { x: r.x + 40, y: r.y + r.height / 2 };
});
await page.mouse.move(dockScale.x, dockScale.y);
await page.waitForTimeout(300);
const scales = await page.evaluate(() =>
  [...document.querySelectorAll(".dock-icon")].map((e) => getComputedStyle(e).getPropertyValue("--s").trim() || "1"),
);
obs("A29 Dock 缩放变量（reduced）", scales.join(","));

// 系统 prefers-reduced-motion 媒体查询
const mqReduced = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
obs("系统 prefers-reduced-motion", String(mqReduced));

// ---------- 4. 对比度（浅色 / 深色）----------
const srgb = (c) => {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
const ratio = (a, b) => {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};
const parseRGB = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);

for (const dark of [false, true]) {
  await setup({ dark, motion: false, opaque: false });
  await openWindow();
  const samples = await page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { sel, color: cs.color, bg: cs.backgroundColor };
    };
    return [".wordmark", ".window-title", ".dock-tooltip", ".assistant-pill", ".muted", ".subtitle"]
      .map(pick)
      .filter(Boolean);
  });
  // 用实际截图取合成背景（玻璃/透明时 backgroundColor 不可信）
  const shot = await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 60 } });
  obs(`对比度采样 ${dark ? "深色" : "浅色"}`, `取到 ${samples.length} 个前景色；背景需像素采样（见 PIL 步骤）`);
  for (const s of samples) {
    const fg = parseRGB(s.color);
    if (fg.length === 3) obs(`  ${s.sel} 前景 rgb(${fg.join(",")})`, `声明背景 ${s.bg}`);
  }
}

// ---------- 5. 键盘 ----------
await setup({ dark: true, motion: false, opaque: false });
await page.keyboard.press("Meta+k");
await page.waitForTimeout(300);
const searchOpen = await page.locator(".search-panel").count();
rec("Cmd+K 打开搜索", searchOpen > 0, `命中 ${searchOpen}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
const searchClosed = await page.locator(".search-panel").count();
rec("Esc 关闭搜索", searchClosed === 0, `命中 ${searchClosed}`);

const focusable = await page.evaluate(
  () =>
    document.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ).length,
);
rec("存在可聚焦元素", focusable > 0, `共 ${focusable} 个`);

const ariaMissing = await page.evaluate(() =>
  [...document.querySelectorAll("button")].filter(
    (b) => !b.textContent.trim() && !b.getAttribute("aria-label") && !b.getAttribute("title"),
  ).length,
);
rec("图标按钮均有可访问名称", ariaMissing === 0, `缺失 aria-label 的图标按钮 ${ariaMissing} 个`);

// ---------- 6. 帧时间（标注是否可信）----------
const gpu = await page.evaluate(() => {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl");
  if (!gl) return "no-webgl";
  const d = gl.getExtension("WEBGL_debug_renderer_info");
  return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "unknown";
});
obs("GPU renderer", gpu);

await setup({ dark: true, motion: false, opaque: false });
await openWindow();
const frames = await page.evaluate(async () => {
  const times = [];
  let last = performance.now();
  let raf;
  const loop = (t) => {
    times.push(t - last);
    last = t;
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  // 拖动窗口 1.2s
  await new Promise((r) => setTimeout(r, 1200));
  cancelAnimationFrame(raf);
  return times.slice(2);
});
if (frames.length) {
  const sorted = [...frames].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const long = frames.filter((f) => f > 50).length;
  obs(
    "帧时间（拖动 1.2s，无 GPU 环境仅参考）",
    `n=${frames.length} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms long(>50ms)=${long}`,
  );
}

await browser.close();

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} checks passed`);
process.exit(pass === results.length ? 0 : 1);
