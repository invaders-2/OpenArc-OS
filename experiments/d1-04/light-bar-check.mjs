// D1-04 十三：feature/ui-light-bar-zero 的采纳前/后实测
// 量的是"合成后像素"，不是 CSS 声明值——顶栏透明度归零后，
// 字标实际压在桌面渐变上，对比度必须重新用像素验。
// 输出：artifacts/d1-04/lightbar-{light,dark}.{json,png}
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PORT = 5213;
const EXEC =
  process.env.OA_CHROMIUM ||
  "/Users/wepingli/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const server = http
  .createServer((req, res) => {
    const p = path.join(ROOT, "dist", (req.url || "/").split("?")[0]);
    const f = fs.existsSync(p) && fs.statSync(p).isFile() ? p : path.join(ROOT, "dist", "index.html");
    const ext = path.extname(f);
    const type = ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "text/html";
    res.writeHead(200, { "content-type": type });
    fs.createReadStream(f).pipe(res);
  })
  .listen(PORT);

const browser = await chromium.launch({ executablePath: EXEC });
const out = {};

for (const theme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.evaluate((t) => {
    localStorage.setItem("oa-dark", String(t === "dark"));
    localStorage.setItem("oa-opaque", "false");
    localStorage.setItem("oa-motion", "false");
  }, theme);
  await page.reload();
  await page.waitForSelector(".dock-item");
  await page.locator(".dock-item").first().click();
  await page.waitForSelector(".window-title");
  await page.waitForTimeout(700);

  const styles = await page.evaluate(() => {
    const get = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        background: cs.backgroundColor,
        backdrop: cs.backdropFilter,
        shadow: cs.boxShadow,
        box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      };
    };
    return {
      topbar: get(".topbar"),
      dock: get(".dock"),
      title: get(".window-title"),
      win: get(".window"),
      desktop: get(".desktop"),
    };
  });

  const png = path.join(ROOT, "artifacts/d1-04/lightbar-" + theme + ".png");
  await page.screenshot({ path: png });
  out[theme] = { styles, png };
  await page.close();
}

await browser.close();
server.close();
fs.writeFileSync(
  path.join(ROOT, "artifacts/d1-04/lightbar-styles.json"),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify(out, null, 2));
