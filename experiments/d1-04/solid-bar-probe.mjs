// D1-04B §2：深色 SOLID 顶栏亮带 before/after 取证 + 回归面采样。
//
// 一次采样覆盖四个组合（dark/light × solid/full），每个组合取同一组固定点：
//   顶栏内 / 顶栏下 / 桌面基准 / Dock 内 / Dock 旁 / 窗口标题 / 窗口内容
// 采样前把文字与图标隐藏，保证点落在纯背景上。
//
// 用法：OA_TAG=before|after node experiments/d1-04/solid-bar-probe.mjs
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TAG = process.env.OA_TAG || "after";
const PORT = 5219;
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

const COMBOS = [
  ["dark", "solid"],
  ["dark", "full"],
  ["light", "solid"],
  ["light", "full"],
];

for (const [theme, glass] of COMBOS) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.evaluate(
    ([t, g]) => {
      localStorage.setItem("oa-dark", String(t === "dark"));
      localStorage.setItem("oa-motion", "false");
      // 双写：oa-glass 是本轮新增，oa-opaque 是兼容旧键
      localStorage.setItem("oa-glass", g);
      localStorage.setItem("oa-opaque", String(g === "solid"));
    },
    [theme, glass]
  );
  await page.reload();
  await page.waitForSelector(".dock-item");
  await page.locator(".dock-item").first().click();
  await page.waitForTimeout(700);

  const geo = await page.evaluate(() => {
    const b = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    return {
      topbar: b(".topbar"),
      dock: b(".dock"),
      title: b(".window-title"),
      win: b(".window"),
      cls: document.querySelector(".desktop").className,
      glass: document.querySelector(".desktop").getAttribute("data-glass"),
      bar: getComputedStyle(document.querySelector(".topbar")).backgroundColor,
      winFilter: getComputedStyle(document.querySelector(".window")).backdropFilter,
      topFilter: getComputedStyle(document.querySelector(".topbar")).backdropFilter,
    };
  });

  const pts = {
    顶栏内: [Math.round(geo.topbar.w * 0.55), Math.round(geo.topbar.h / 2)],
    顶栏下: [Math.round(geo.topbar.w * 0.55), Math.round(geo.topbar.h + 14)],
    桌面基准: [1400, Math.round(geo.win.y + geo.win.h / 2)],
    Dock内: [Math.round(geo.dock.x + 8), Math.round(geo.dock.y + 12)],
    Dock旁: [Math.round(geo.dock.x + geo.dock.w + 30), Math.round(geo.dock.y + 12)],
    窗口标题: [Math.round(geo.win.x + geo.win.w * 0.9), Math.round(geo.title.y + geo.title.h / 2)],
    窗口内容: [Math.round(geo.win.x + geo.win.w / 2), Math.round(geo.win.y + geo.win.h * 0.6)],
  };

  await page.addStyleTag({
    content: `* { color: transparent !important; text-shadow: none !important; }
              svg, img { visibility: hidden !important; }`,
  });
  await page.waitForTimeout(250);
  const png = path.join(ROOT, `artifacts/d1-04/solidbar-${TAG}-${theme}-${glass}.png`);
  await page.screenshot({ path: png });
  out[`${theme}-${glass}`] = { geo, pts, png };
  await page.close();
}

await browser.close();
server.close();
fs.writeFileSync(
  path.join(ROOT, `artifacts/d1-04/solidbar-${TAG}.json`),
  JSON.stringify(out, null, 2)
);
console.log("written solidbar-" + TAG + ".json");
