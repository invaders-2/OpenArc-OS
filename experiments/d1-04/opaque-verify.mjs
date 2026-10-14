// D1-04 十三(b) 校验：opaque 模式下顶栏/Dock 是否会浮出一条与桌面不同色的带。
// 判据：顶栏内与紧邻桌面的明度差应 ≤3 级（肉眼不可辨）。
import { chromium } from "playwright";
import { resolveChromium, describeChromiumCandidates } from "../lib/chromium.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PORT = 5217;
// Chromium 解析优先级：OA_CHROMIUM → Playwright 官方 chromium → 系统 Google Chrome（见 experiments/lib/chromium.mjs）。
const CHROMIUM_INFO = resolveChromium();
const EXEC = CHROMIUM_INFO.path;
if (!EXEC) {
  console.error("找不到可用 Chromium，已按优先级尝试：" + describeChromiumCandidates(CHROMIUM_INFO.candidates) + "（设置 OA_CHROMIUM 指向可用二进制）");
  process.exit(1);
}

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
  }, dark);
  await page.reload();
  await page.waitForSelector(".dock-item");
  await page.locator(".dock-item").first().click();
  await page.waitForTimeout(500);
  const geo = await page.evaluate(() => {
    const b = (s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    return { topbar: b(".topbar"), dock: b(".dock") };
  });
  await page.addStyleTag({
    content: `* { color: transparent !important; } svg, img { visibility: hidden !important; }`,
  });
  await page.waitForTimeout(200);
  const png = path.join(ROOT, `artifacts/d1-04/opaque-verify-${dark ? "dark" : "light"}.png`);
  await page.screenshot({ path: png });
  out[dark ? "dark" : "light"] = {
    png,
    pts: {
      顶栏内: [Math.round(geo.topbar.w * 0.55), Math.round(geo.topbar.h / 2)],
      顶栏下: [Math.round(geo.topbar.w * 0.55), Math.round(geo.topbar.h + 14)],
      Dock内: [Math.round(geo.dock.x + 8), Math.round(geo.dock.y + 12)],
      Dock旁: [Math.round(geo.dock.x + geo.dock.w + 30), Math.round(geo.dock.y + 12)],
    },
  };
  await page.close();
}
await browser.close();
server.close();
fs.writeFileSync(path.join(ROOT, "artifacts/d1-04/opaque-verify.json"), JSON.stringify(out, null, 2));
console.log("ok");
