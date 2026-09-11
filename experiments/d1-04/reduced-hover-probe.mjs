// D1-04C 取证：REDUCED 把"大面积面板"转实色后，行级 hover 还能不能看出来。
//
// 背景：`.search-result:hover` 原本用 `rgb(var(--content-rgb) / var(--content-alpha))`。
// 这招在 FULL 下成立——面板是半透明玻璃，行底色叠上去会变亮/变暗。
// 但 REDUCED 下搜索面板已经转成实色，且 `--content-rgb` 与面板底色是**同一个颜色**，
// 于是 rgba(23,23,23,α) 叠在 #171717 上合成结果还是 #171717 —— hover 视觉上消失。
// 这是一条真实的层级回归（不是性能问题），必须修掉并留下证据。
//
// 做法：每个主题 × 每档，打开 Cmd+K 搜索面板，对第一条结果截图两次：
//   ① 未 hover   ② hover。交给 Python 采样行中心像素，报出明度差与对比度。
// 修复后 REDUCED 应重新出现可测的 hover 差；FULL 原本就有；SOLID 原本就有。
//
// 采样区域取行**右侧留白**（图标与文字左侧之外），避免文字像素污染读数。

import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PORT = 5224;
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

    // 打开搜索面板
    await page.keyboard.press("Meta+k");
    await page.waitForSelector(".search-result");
    // 保证没有残留 hover
    await page.mouse.move(10, 880);
    await page.waitForTimeout(250);

    const box = await page.evaluate(() => {
      const el = document.querySelector(".search-result");
      if (!el) return null;
      const b = el.getBoundingClientRect();
      const p = el.closest(".search-panel")?.getBoundingClientRect();
      return {
        row: { x: b.x, y: b.y, w: b.width, h: b.height },
        panel: p ? { x: p.x, y: p.y, w: p.width, h: p.height } : null,
      };
    });
    if (!box?.row) throw new Error(`${theme}/${glass}: 没有 .search-result`);

    const restShot = path.join(ROOT, `artifacts/d1-04/hover-${theme}-${glass}-rest.png`);
    const overShot = path.join(ROOT, `artifacts/d1-04/hover-${theme}-${glass}-over.png`);
    await page.screenshot({ path: restShot });

    // hover 到"行右侧留白"（x = 行右缘 − 12px），避开文字
    await page.mouse.move(box.row.x + box.row.w - 12, box.row.y + box.row.h / 2);
    await page.waitForTimeout(300);
    await page.screenshot({ path: overShot });

    out.samples.push({
      theme,
      glass,
      row: box.row,
      panel: box.panel,
      rest: path.basename(restShot),
      over: path.basename(overShot),
    });
    await page.close();
  }
}

await browser.close();
server.close();
fs.writeFileSync(
  path.join(ROOT, "artifacts/d1-04/hover-probe.json"),
  JSON.stringify(out, null, 2)
);
console.log("产物：artifacts/d1-04/hover-probe.json");
for (const s of out.samples) console.log(`  ${s.theme}/${s.glass} → ${s.rest} / ${s.over}`);
