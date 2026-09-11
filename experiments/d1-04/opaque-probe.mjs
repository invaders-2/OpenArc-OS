// D1-04 十三(b)：测 opaque（关闭模糊）模式下，顶栏/Dock 应取的实色兜底值。
// 做法：临时隐藏 .topbar / .dock，直接读它们覆盖区域的真实桌面像素。
// opaque 模式没有模糊，所以 --bar 必须等于该处的桌面合成值，否则会浮出一条亮/暗带。
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PORT = 5216;
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
    localStorage.setItem("oa-opaque", "true");
    localStorage.setItem("oa-motion", "false");
  }, dark);
  await page.reload();
  await page.waitForSelector(".dock-item");
  await page.locator(".dock-item").first().click();
  await page.waitForTimeout(500);

  const geo = await page.evaluate(() => {
    const b = (s) => {
      const el = document.querySelector(s);
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    return { topbar: b(".topbar"), dock: b(".dock") };
  });
  // 记下当前 --bar 实色值，再隐藏两条，读它们压着的桌面
  const barVal = await page.evaluate(() =>
    getComputedStyle(document.querySelector(".topbar")).backgroundColor
  );
  await page.addStyleTag({
    content: `.topbar, .dock { visibility: hidden !important; }
              * { color: transparent !important; } svg, img { visibility: hidden !important; }`,
  });
  await page.waitForTimeout(250);
  const png = path.join(ROOT, `artifacts/d1-04/opaque-probe-${dark ? "dark" : "light"}.png`);
  await page.screenshot({ path: png });

  // 沿顶栏长度取 9 点，沿 Dock 长度取 9 点
  const pts = { 顶栏: [], Dock: [] };
  for (let i = 1; i <= 9; i++) {
    pts.顶栏.push([Math.round((geo.topbar.w * i) / 10), Math.round(geo.topbar.h / 2)]);
    pts.Dock.push([Math.round(geo.dock.x + (geo.dock.w * i) / 10), Math.round(geo.dock.y + geo.dock.h / 2)]);
  }
  out[dark ? "dark" : "light"] = { barVal, pts, png };
  await page.close();
}

await browser.close();
server.close();
fs.writeFileSync(path.join(ROOT, "artifacts/d1-04/opaque-probe.json"), JSON.stringify(out, null, 2));
console.log("ok");
