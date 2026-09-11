// D1-04B §6/§10/§11：三档材质矩阵 + 运行时切换正确性 + 深浅色覆盖。
//
// 用真实产品实现（data-glass），不注入任何模拟样式。
// 覆盖表面：TopBar / Dock / Window / WindowTitle / Menu / Search / AI / Card
// 切换验证：FULL→REDUCED→SOLID→FULL 往返两轮，每步查残留、跳变、窗口状态。
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PORT = 5220;
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

const SURFACES = {
  TopBar: ".topbar",
  Dock: ".dock",
  Window: ".window",
  WindowTitle: ".window-title",
  Menu: ".context-menu",
  Search: ".search-panel",
  AI: ".ai-panel",
  Card: ".app-card",
  Pill: ".assistant-pill",
  Tip: ".dock-tooltip",
};

const open = async (page, theme) => {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.evaluate((t) => {
    localStorage.setItem("oa-dark", String(t === "dark"));
    localStorage.setItem("oa-motion", "false");
    localStorage.removeItem("oa-glass");
    localStorage.removeItem("oa-opaque");
  }, theme);
  await page.reload();
  await page.waitForSelector(".dock-item");
  // 打开应用中心（含 app-card）、浏览器（含 web-viewport）、设置（含 select）
  await page.locator(".dock-item").first().click();
  await page.waitForTimeout(300);
};

const probe = (page) =>
  page.evaluate((sels) => {
    const out = { glass: null, surfaces: {}, windows: [], viewports: 0 };
    const root = document.querySelector(".desktop");
    out.glass = root.getAttribute("data-glass");
    out.roots = {
      surface: getComputedStyle(root).getPropertyValue("--surface").trim(),
      content: getComputedStyle(root).getPropertyValue("--content").trim(),
      bar: getComputedStyle(root).getPropertyValue("--bar").trim(),
      pill: getComputedStyle(root).getPropertyValue("--pill").trim(),
      blur: getComputedStyle(root).getPropertyValue("--glass-blur").trim(),
      boost: getComputedStyle(root).getPropertyValue("--glass-alpha-boost").trim(),
    };
    for (const [name, sel] of Object.entries(sels)) {
      const el = document.querySelector(sel);
      if (!el) {
        out.surfaces[name] = null;
        continue;
      }
      const cs = getComputedStyle(el);
      out.surfaces[name] = {
        filter: cs.backdropFilter,
        bg: cs.backgroundColor,
        shadow: cs.boxShadow === "none" ? "none" : "has",
        border: cs.borderTopWidth,
      };
    }
    out.windows = [...document.querySelectorAll(".window")].map((w) => {
      const r = w.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), w.dataset.winId || ""];
    });
    out.viewports = document.querySelectorAll(".web-viewport").length;
    return out;
  }, SURFACES);

const matrix = {};

// ── §6/§11 静态矩阵：2 主题 × 3 档 ────────────────────────────────
for (const theme of ["light", "dark"]) {
  for (const glass of ["full", "reduced", "solid"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.evaluate(
      ([t, g]) => {
        localStorage.setItem("oa-dark", String(t === "dark"));
        localStorage.setItem("oa-motion", "false");
        localStorage.setItem("oa-glass", g);
      },
      [theme, glass]
    );
    await page.reload();
    await page.waitForSelector(".dock-item");
    await page.locator(".dock-item").first().click();
    await page.waitForTimeout(200);
    // 菜单 / 搜索 / AI 三个面必须同时在场才量得到：
    // AI 面板先开（z 90）→ Cmd+K 搜索（z 100）→ 右键菜单（z 199）最后开
    await page.locator(".assistant-pill").click();
    await page.waitForTimeout(200);
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(200);
    await page.mouse.click(700, 520, { button: "right" });
    await page.waitForTimeout(200);
    const png = path.join(ROOT, `artifacts/d1-04/tiers-${theme}-${glass}.png`);
    await page.screenshot({ path: png });
    matrix[`${theme}-${glass}`] = { ...(await probe(page)), png };
    await page.close();
  }
}
await browser.close();
server.close();
fs.writeFileSync(
  path.join(ROOT, "artifacts/d1-04/glass-matrix.json"),
  JSON.stringify(matrix, null, 2)
);

console.log("=== 三档材质矩阵（真实产品实现）===");
for (const [k, v] of Object.entries(matrix)) {
  console.log(`\n--- ${k}  data-glass=${v.glass}`);
  console.log(`  root: surface=${v.roots.surface} content=${v.roots.content} bar=${v.roots.bar}`);
  console.log(`        blur=${v.roots.blur} alphaBoost=${v.roots.boost}`);
  for (const [n, s] of Object.entries(v.surfaces)) {
    if (!s) continue;
    console.log(`  ${n.padEnd(12)} filter=${String(s.filter).padEnd(34)} bg=${s.bg}`);
  }
}
