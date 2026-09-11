// D1-04：玻璃层级差实测。
// 采样点由元素自身的 bounding box 推导，保证 before/after 可比。
// 文字与图标先隐藏，采样点落在纯背景上，避免量到字形。
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TAG = process.env.OA_TAG || "after";
const PORT = 5215;
const EXEC =
  process.env.OA_CHROMIUM ||
  "/Users/wepingli/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const server = http
  .createServer((req, res) => {
    const p = path.join(ROOT, "dist", (req.url || "/").split("?")[0]);
    const f = fs.existsSync(p) && fs.statSync(p).isFile() ? p : path.join(ROOT, "dist", "index.html");
    const ext = path.extname(f);
    res.writeHead(200, {
      "content-type": ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "text/html",
    });
    fs.createReadStream(f).pipe(res);
  })
  .listen(PORT);

const browser = await chromium.launch({ executablePath: EXEC });
const out = {};

for (const dark of [false, true]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.evaluate((d) => {
    localStorage.setItem("oa-dark", String(d));
    localStorage.setItem("oa-opaque", "false");
    localStorage.setItem("oa-motion", "false");
  }, dark);
  await page.reload();
  await page.waitForSelector(".dock-item");
  await page.locator(".dock-item").first().click();
  await page.waitForTimeout(600);

  const geo = await page.evaluate(() => {
    const b = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    return { topbar: b(".topbar"), dock: b(".dock"), title: b(".window-title"), win: b(".window") };
  });

  // 推导采样点：都取元素内部的空白处
  const pts = {
    桌面背景: [1400, Math.round(geo.win.y + geo.win.h / 2)],
    顶栏内: [Math.round(geo.topbar.w * 0.55), Math.round(geo.topbar.h / 2)],
    标题栏内: [Math.round(geo.win.x + geo.win.w * 0.9), Math.round(geo.title.y + geo.title.h / 2)],
    窗口内容: [Math.round(geo.win.x + geo.win.w / 2), Math.round(geo.win.y + geo.win.h * 0.6)],
    Dock内: [Math.round(geo.dock.x + 8), Math.round(geo.dock.y + 12)],
    Dock外同高: [Math.round(geo.dock.x + geo.dock.w + 40), Math.round(geo.dock.y + 12)],
    顶栏下8px: [Math.round(geo.topbar.w * 0.55), Math.round(geo.topbar.y + geo.topbar.h + 8)],
    顶栏下24px: [Math.round(geo.topbar.w * 0.55), Math.round(geo.topbar.y + geo.topbar.h + 24)],
  };

  await page.addStyleTag({
    content: `* { color: transparent !important; text-shadow: none !important; }
              svg, img { visibility: hidden !important; }`,
  });
  await page.waitForTimeout(250);
  const png = path.join(ROOT, `artifacts/d1-04/hier-${TAG}-${dark ? "dark" : "light"}.png`);
  await page.screenshot({ path: png });
  out[dark ? "dark" : "light"] = { geo, pts, png };
  await page.close();
}

await browser.close();
server.close();
fs.writeFileSync(path.join(ROOT, `artifacts/d1-04/hier-${TAG}.json`), JSON.stringify(out, null, 2));
console.log("written hier-" + TAG + ".json");
