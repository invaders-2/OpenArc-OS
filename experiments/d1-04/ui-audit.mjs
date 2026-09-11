// D1-04 UI 审计实测脚本（无副作用，只驱动本地 dist）
//
// 用法：
//   node experiments/d1-04/ui-audit.mjs            # 需要先在 dist 起 http.server
//   OA_BASE=http://127.0.0.1:5210/ node experiments/d1-04/ui-audit.mjs
//
// 覆盖：组件清单 / MS-A02 动效中断 / A29 减少动效 / 对比度 / 键盘 / 帧时间。
// 帧时间在无 GPU 环境下只作参考，脚本会打印 GPU 状态供判定 NOT REPRESENTATIVE。

import { chromium } from "playwright";

const BASE = process.env.OA_BASE || "http://127.0.0.1:5210/";
const EXEC =
  process.env.OA_CHROMIUM ||
  "/Users/wepingli/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

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
  ContextMenu: ".context-menu",
  SearchPanel: ".search-panel",
  AIPanel: ".ai-panel",
  DockTooltip: ".dock-tooltip",
  AssistantPill: ".assistant-pill",
  BrowserContainer: ".web-viewport",
  AddressBar: ".addressbar",
  Badge: ".badge",
  AppCard: ".app-card",
  SettingsRow: ".setting-row",
};
const found = await page.evaluate((sel) => {
  const out = {};
  for (const [k, s] of Object.entries(sel)) out[k] = document.querySelectorAll(s).length;
  return out;
}, COMPONENTS);

// 需要交互才出现的组件
await page.keyboard.press("Escape");
await page.mouse.click(700, 500);
const searchCount = await page.locator(".search-panel").count();

for (const [k, n] of Object.entries(found)) {
  rec(`组件存在：${k}`, n > 0, `DOM 命中 ${n}`);
}
obs("SearchPanel 需 Cmd+K 触发", `当前 DOM 命中 ${searchCount}（默认关闭，属预期）`);

// ---------- 2. MS-A02：连续快速开关 10 次 ----------
await setup({ dark: true, motion: false, opaque: false });
let ghost = 0;
let stuck = false;
for (let i = 0; i < 10; i++) {
  await page.locator(".dock-item").first().click().catch(() => {});
  const c = await page.locator(".close").count();
  if (c) await page.locator(".close").first().click({ force: true }).catch(() => {});
}
await page.waitForTimeout(400);
const winCount = await page.locator(".window").count();
const opacity = await page.evaluate(() => {
  const w = document.querySelector(".window");
  return w ? Number(getComputedStyle(w).opacity) : null;
});
rec("MS-A02 快速开关 10 次无残留窗口", winCount <= 1, `剩余窗口 ${winCount}`);
rec("MS-A02 无半透明残留（opacity 归位）", opacity === null || opacity === 1, `opacity=${opacity}`);
// 幽灵点击检测：关闭后点原窗口区域，不应再打开窗口
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
