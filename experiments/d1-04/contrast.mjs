// D1-04 对比度与组件覆盖补测
// 打开各应用后再判组件是否真的存在（避免把"未触发"误判为 MISSING），
// 并导出元素坐标 + 截图，交给 Python 用合成像素算真实对比度。
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.OA_BASE || "http://127.0.0.1:5210/";
const EXEC =
  process.env.OA_CHROMIUM ||
  "/Users/wepingli/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const OUT = "artifacts/d1-04";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const setup = async (dark) => {
  await page.goto(BASE);
  await page.evaluate((d) => {
    localStorage.setItem("oa-dark", String(d));
    localStorage.setItem("oa-motion", "false");
    localStorage.setItem("oa-opaque", "false");
  }, dark);
  await page.reload();
  await page.waitForSelector(".dock-item");
};

// ---------- 打开各应用，判组件真实覆盖 ----------
const byLabel = async (name) => {
  const item = page.locator(`.dock-item[aria-label*="${name}"], .dock-item[title*="${name}"]`).first();
  if (await item.count()) await item.click();
  else await page.locator(".dock-item").nth(name === "设置" ? 5 : 1).click().catch(() => {});
  await page.waitForTimeout(500);
};

await setup(true);
const dockLabels = await page.evaluate(() =>
  [...document.querySelectorAll(".dock-item")].map((e) => e.getAttribute("aria-label") || e.getAttribute("title") || e.textContent.trim()),
);
console.log("Dock 项：", JSON.stringify(dockLabels));

const coverage = {};
// 逐个点 Dock 打开应用，记录出现的组件
for (let i = 0; i < dockLabels.length; i++) {
  await setup(true);
  await page.locator(".dock-item").nth(i).click();
  await page.waitForTimeout(500);
  const hits = await page.evaluate(() => {
    const sel = {
      WebViewport: ".web-viewport",
      AddressBar: ".addressbar",
      SettingsRow: ".setting-row",
      AppGrid: ".app-grid",
      AppCard: ".app-card",
      Badge: ".badge",
      EmptyContent: ".empty-content",
      ConnectionCard: ".connection-card",
      AdobeRow: ".adobe-row",
    };
    const o = {};
    for (const [k, s] of Object.entries(sel)) o[k] = document.querySelectorAll(s).length;
    return o;
  });
  coverage[dockLabels[i] || `dock-${i}`] = hits;
}
console.log("\n=== 各应用组件覆盖 ===");
for (const [app, hits] of Object.entries(coverage)) {
  const found = Object.entries(hits).filter(([, n]) => n > 0).map(([k]) => k);
  console.log(`  ${app}: ${found.length ? found.join(", ") : "（无匹配组件）"}`);
}

// 右键菜单 / AI 面板
await setup(true);
await page.mouse.click(700, 500, { button: "right" });
await page.waitForTimeout(300);
console.log("右键菜单 DOM：", await page.locator(".context-menu").count());
await page.keyboard.press("Escape");

await page.locator(".assistant-pill").click();
await page.waitForTimeout(400);
console.log("AI 面板 DOM：", await page.locator(".ai-panel").count());

// ---------- 导出坐标 + 截图，供 Python 算对比度 ----------
for (const dark of [false, true]) {
  await setup(dark);
  await page.locator(".dock-item").first().click();
  await page.waitForTimeout(600);
  const items = await page.evaluate(() => {
    const targets = [
      [".wordmark", "顶栏字标"],
      [".window-title", "窗口标题栏"],
      [".subtitle", "副标题"],
      [".app-card", "应用卡片"],
      [".dock-tooltip", "Dock 提示"],
      [".empty-content", "空状态文案"],
    ];
    const out = [];
    for (const [sel, label] of targets) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      out.push({
        sel,
        label,
        color: cs.color,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      });
    }
    return out;
  });
  const name = dark ? "dark" : "light";
  writeFileSync(`${OUT}/coords-${name}.json`, JSON.stringify(items, null, 2));
  await page.screenshot({ path: `${OUT}/shot-${name}.png` });
  console.log(`\n${name}: 导出 ${items.length} 个元素 -> ${OUT}/coords-${name}.json`);
}

await browser.close();
