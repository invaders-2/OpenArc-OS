// D1-04C 取证：REDUCED 下"窗口正文实色"该取什么值。
//
// 背景：FULL 的窗口填充来自 .window（玻璃）。REDUCED 把玻璃从容器下沉到标题条后，
// 容器必须透明，正文必须自己承载实色。这条实色不能拍脑袋填——它必须等于
// **FULL 玻璃窗口合成出来的实际颜色**，这样切档只去掉模糊、不改窗口明度，
// 层级（窗口 / 正文面 / 卡片）不被拉平。
//
// 做法：在每个主题下开 4 个窗口，取第一个窗口正文区域的像素网格，
// 用**众数**（出现最多的颜色）当背景色 —— 比取单点稳，不会被文字/图标带偏。
//
// 采样点同时覆盖：窗口正文 / 标题条 / 窗口外桌面 / 顶栏 / Dock，用于层级差对照。

import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PORT = 5223;
const EXEC =
  process.env.OA_CHROMIUM ||
  "/Users/wepingli/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const server = http
  .createServer((req, res) => {
    const p = path.join(ROOT, "dist", (req.url || "/").split("?")[0]);
    const f =
      fs.existsSync(p) && fs.statSync(p).isFile()
        ? p
        : path.join(ROOT, "dist", "index.html");
    const ext = path.extname(f);
    res.writeHead(200, {
      "content-type":
        ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "text/html",
    });
    fs.createReadStream(f).pipe(res);
  })
  .listen(PORT);

const browser = await chromium.launch({ executablePath: EXEC });
const out = { generatedAt: new Date().toISOString(), samples: [] };

for (const theme of ["light", "dark"]) {
  for (const glass of ["full", "reduced", "solid"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.evaluate(
      ({ theme, glass }) => {
        localStorage.setItem("oa-dark", theme === "dark" ? "true" : "false");
        localStorage.setItem("oa-motion", "false");
        localStorage.setItem("oa-glass", glass);
        localStorage.removeItem("oa-opaque");
      },
      { theme, glass }
    );
    await page.reload();
    await page.waitForSelector(".dock-item");
    for (let i = 0; i < 4; i++) {
      await page.locator(".dock-item").nth(i).click();
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(400);

    // 窗口矩形 + 各面几何
    const geo = await page.evaluate(() => {
      const r = (s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      };
      const w = document.querySelectorAll(".window")[0];
      const wb = w ? w.getBoundingClientRect() : null;
      return {
        window: wb ? { x: wb.x, y: wb.y, w: wb.width, h: wb.height } : null,
        title: 44,
        topbar: r(".topbar"),
        dock: r(".dock"),
        menuOpen: !!document.querySelector(".context-menu"),
      };
    });

    // 截图后交给 Python 采样（Node 侧不装图像库）
    const shot = path.join(ROOT, `artifacts/d1-04/reduced-probe-${theme}-${glass}.png`);
    await page.screenshot({ path: shot });
    out.samples.push({ theme, glass, geo, shot: path.basename(shot) });
    await page.close();
  }
}

await browser.close();
server.close();
fs.writeFileSync(
  path.join(ROOT, "artifacts/d1-04/reduced-probe.json"),
  JSON.stringify(out, null, 2)
);
console.log("产物：artifacts/d1-04/reduced-probe.json");
for (const s of out.samples) console.log(`  ${s.theme}/${s.glass} → ${s.shot}`);
