// D1-04：合成后对比度实测（改口径）
// 旧口径拿「桌面背景」当所有文字的背景，会误判窗口内的文字。
// 新口径：把 color 设为 transparent 再截图，此时字心像素 = 该文字真实的合成背景。
// 流程：正常截图取前景色 -> 透明色截图取背景 -> Python 算 WCAG 对比度。
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TAG = process.env.OA_TAG || "after";
const PORT = 5214;
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
const result = {};
// D1-04C：对比度要能按材质档位跑（REDUCED 把大面转实色，字心背景会变）
const GLASS = process.env.OA_GLASS || "full";

for (const dark of [false, true]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.evaluate(
    ({ d, g }) => {
      localStorage.setItem("oa-dark", String(d));
      localStorage.setItem("oa-glass", g);
      localStorage.setItem("oa-opaque", "false");
      localStorage.setItem("oa-motion", "false");
    },
    { d: dark, g: GLASS }
  );
  await page.reload();
  await page.waitForSelector(".dock-item");
  await page.locator(".dock-item").first().click();
  await page.waitForTimeout(600);
  // 打开 AI 面板，把面板内文字也纳入
  try {
    await page.locator(".assistant-pill").click();
    await page.waitForTimeout(400);
  } catch {}

  const targets = [
    [".wordmark", "顶栏字标"],
    [".window-title", "窗口标题栏"],
    [".subtitle", "副标题"],
    [".app-card", "应用卡片"],
    [".empty-content", "空状态文案"],
    [".ai-panel", "AI 面板正文"],
    [".setting-row", "设置行"],
  ];

  const items = await page.evaluate((tg) => {
    const out = [];
    for (const [sel, label] of tg) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      out.push({
        sel,
        label,
        color: cs.color,
        fontSize: parseFloat(cs.fontSize),
        fontWeight: cs.fontWeight,
        // 取字心：文字块内部靠上的位置，避开容器边缘
        pt: [Math.round(r.x + r.width / 2), Math.round(r.y + Math.min(12, r.height / 2))],
      });
    }
    return out;
  }, targets);

  // 把所有文字变透明，再截一张，用来取字心的真实背景
  await page.addStyleTag({
    content: `* { color: transparent !important; text-shadow: none !important; }
              svg { visibility: hidden !important; }`,
  });
  await page.waitForTimeout(250);
  const png = path.join(ROOT, `artifacts/d1-04/contrast-${TAG}-${dark ? "dark" : "light"}.png`);
  await page.screenshot({ path: png });
  result[dark ? "dark" : "light"] = { items, png };
  await page.close();
}

await browser.close();
server.close();
fs.writeFileSync(
  path.join(ROOT, `artifacts/d1-04/contrast-${TAG}.json`),
  JSON.stringify(result, null, 2)
);
console.log("written contrast-" + TAG + ".json");
