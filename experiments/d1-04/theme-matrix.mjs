// D1-04B §6/§8：主题矩阵探针 + 防回归断言。
//
// 这一版专门抓"合成作用域脱节"这一类错误：
//   主题原料（*-rgb）被 .dark 覆盖，但合成结果在更上层就已经算完并被继承，
//   于是 Dark 拿到 Light 的合成色。判据不靠肉眼，靠两条独立证据：
//     A. computed style 的 background-color 通道值（直接读合成结果）
//     B. 真实截图的合成后像素（防止 computed 正确但实际渲染错误）
//
// 六格矩阵：{light,dark} × {full,reduced,solid}
// 九个采样面：Desktop / Window / WindowContent / TitleBar / TopBar / Dock /
//             Menu / Search / AI
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PORT = 5222;
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

const MATRIX = [];
for (const theme of ["light", "dark"])
  for (const glass of ["full", "reduced", "solid"]) MATRIX.push([theme, glass]);

const results = {};

for (const [theme, glass] of MATRIX) {
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
  await page.waitForTimeout(250);
  await page.locator(".assistant-pill").click();
  await page.waitForTimeout(150);
  await page.keyboard.press("Meta+k");
  await page.waitForTimeout(150);
  await page.mouse.click(700, 520, { button: "right" });
  await page.waitForTimeout(200);

  const data = await page.evaluate(() => {
    const HIDE = `* { color: transparent !important; text-shadow: none !important; }
                  svg, img { visibility: hidden !important; }`;
    const st = document.createElement("style");
    st.textContent = HIDE;
    document.head.appendChild(st);
    const root = document.querySelector(".desktop");
    const cs = getComputedStyle(root);
    const read = (s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const boxOf = {
      Desktop: { x: 1380, y: 450, w: 40, h: 40 },
      Window: read(".window"),
      WindowBody: read(".window-body"),
      TitleBar: read(".window-title"),
      TopBar: read(".topbar"),
      Dock: read(".dock"),
      Menu: read(".context-menu"),
      Search: read(".search-panel"),
      AI: read(".ai-panel"),
      Card: read(".app-card"),
    };
    // 采样点：贴内侧取，避开圆角与内容
    const ptOf = (b, dx = 20, dy = -14) =>
      b ? [Math.round(b.x + dx), Math.round(b.y + b.h + dy)] : null;
    const pts = {
      Desktop: [1380, 450],
      Window: ptOf(boxOf.Window),
      // 与 D1-04 baseline 完全同一位置（窗口内容区中心偏下），
      // 否则量到的是窗口外壳而不是内容面，无法与历史值对比
      WindowContent: boxOf.Window
        ? [
            Math.round(boxOf.Window.x + boxOf.Window.w / 2),
            Math.round(boxOf.Window.y + boxOf.Window.h * 0.6),
          ]
        : null,
      TitleBar: boxOf.TitleBar
        ? [Math.round(boxOf.TitleBar.x + boxOf.TitleBar.w * 0.9), Math.round(boxOf.TitleBar.y + boxOf.TitleBar.h / 2)]
        : null,
      TopBar: boxOf.TopBar ? [Math.round(boxOf.TopBar.w * 0.55), Math.round(boxOf.TopBar.h / 2)] : null,
      Dock: boxOf.Dock ? [Math.round(boxOf.Dock.x + 8), Math.round(boxOf.Dock.y + 12)] : null,
      Menu: ptOf(boxOf.Menu),
      Search: ptOf(boxOf.Search),
      AI: ptOf(boxOf.AI),
      Card: ptOf(boxOf.Card, 12, -10),
    };
    const bgOf = {
      Desktop: null,
      Window: getComputedStyle(document.querySelector(".window")).backgroundColor,
      WindowBody: getComputedStyle(document.querySelector(".window-body")).backgroundColor,
      TitleBar: getComputedStyle(document.querySelector(".window-title")).backgroundColor,
      TopBar: getComputedStyle(document.querySelector(".topbar")).backgroundColor,
      Dock: getComputedStyle(document.querySelector(".dock")).backgroundColor,
      Menu: getComputedStyle(document.querySelector(".context-menu")).backgroundColor,
      Search: getComputedStyle(document.querySelector(".search-panel")).backgroundColor,
      AI: getComputedStyle(document.querySelector(".ai-panel")).backgroundColor,
      Card: getComputedStyle(document.querySelector(".app-card")).backgroundColor,
    };
    const filterOf = {
      Window: getComputedStyle(document.querySelector(".window")).backdropFilter,
      TopBar: getComputedStyle(document.querySelector(".topbar")).backdropFilter,
      Dock: getComputedStyle(document.querySelector(".dock")).backdropFilter,
      Menu: getComputedStyle(document.querySelector(".context-menu")).backdropFilter,
      Search: getComputedStyle(document.querySelector(".search-panel")).backdropFilter,
      AI: getComputedStyle(document.querySelector(".ai-panel")).backdropFilter,
    };
    return {
      glass: root.getAttribute("data-glass"),
      cls: root.className,
      raw: {
        surfaceRgb: cs.getPropertyValue("--surface-rgb").trim(),
        contentRgb: cs.getPropertyValue("--content-rgb").trim(),
        barRgb: cs.getPropertyValue("--bar-rgb").trim(),
        surfaceAlpha: cs.getPropertyValue("--surface-alpha").trim(),
        contentAlpha: cs.getPropertyValue("--content-alpha").trim(),
        barAlpha: cs.getPropertyValue("--bar-alpha").trim(),
      },
      bgOf,
      filterOf,
      pts,
    };
  });

  // 截图（文字与图标已被隐藏）
  const png = path.join(ROOT, `artifacts/d1-04/matrix-${theme}-${glass}.png`);
  await page.screenshot({ path: png });
  results[`${theme}-${glass}`] = { ...data, png };
  await page.close();
}

await browser.close();
server.close();
fs.writeFileSync(
  path.join(ROOT, "artifacts/d1-04/theme-matrix.json"),
  JSON.stringify(results, null, 2)
);

// ── 断言 ────────────────────────────────────────────────────────
const failures = [];
const rows = [];
for (const [theme, glass] of MATRIX) {
  const k = `${theme}-${glass}`;
  const r = results[k];
  const expTint = theme === "dark" ? [23, 23, 23] : [255, 255, 255];
  const solidTint = theme === "dark" ? { s: [12, 12, 12], c: [14, 14, 14], b: [0, 0, 0] } : { s: [245, 245, 247], c: [255, 255, 255], b: [233, 233, 236] };

  // 断言 1：主题原料必须是本主题的
  const wantSRgb = glass === "solid" ? solidTint.s.join(" ") : expTint.join(" ");
  const gotSRgb = r.raw.surfaceRgb.replace(/,/g, "");
  if (gotSRgb !== wantSRgb) failures.push(`${k}: --surface-rgb=${r.raw.surfaceRgb}，期望 ${wantSRgb}`);

  // 断言 2：各面 computed 背景通道必须是本主题的（这条直接抓原 bug）
  // 全透明背景的元素跳过——它们不承载底色，通道值无意义（会把 0,0,0 误判成深色）
  const parseBg = (css) => {
    const m = css.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    const [r, g, b] = parts;
    const alpha = parts.length > 3 ? parts[3] : 1;
    return { rgb: [r, g, b], alpha };
  };
  for (const el of ["Window", "Menu", "Search", "AI", "Card"]) {
    const p = parseBg(r.bgOf[el] ?? "");
    if (!p || p.alpha === 0) continue;
    const nearLight = p.rgb.every((v) => v > 200);
    const nearDark = p.rgb.every((v) => v < 70);
    if (theme === "dark" && nearLight) failures.push(`${k}: ${el} 背景通道 ${p.rgb} 是浅色 —— 主题合成脱节`);
    if (theme === "light" && nearDark) failures.push(`${k}: ${el} 背景通道 ${p.rgb} 是深色 —— 主题合成脱节`);
    if (glass === "solid" && p.alpha !== 1) failures.push(`${k}: SOLID 下 ${el} 背景 alpha=${p.alpha}，应为 1`);
  }

  rows.push({
    k,
    surface: r.bgOf.Window,
    menu: r.bgOf.Menu,
    bar: r.bgOf.TopBar,
    filter: r.filterOf.Window,
  });
}

// ── 像素断言（用 Python 侧比对更直观，这里先导出采样点）──────
const { default: cp } = await import("node:child_process");
const py = cp.spawnSync(
  "/Users/wepingli/.workbuddy/binaries/python/envs/default/bin/python",
  [path.join(ROOT, "experiments/d1-04/matrix_pixels.py")],
  { cwd: ROOT, encoding: "utf8" }
);
if (py.stdout) console.log(py.stdout.trim());
if (py.status !== 0) console.log("像素检查脚本报错:", py.stderr?.slice(0, 400));

console.log("\n=== 主题矩阵 · computed style ===");
console.log("格            Window 背景                       Menu 背景                          TopBar 背景                        Window 滤镜");
for (const r of rows) {
  console.log(
    `${r.k.padEnd(14)}${String(r.surface).padEnd(32)}${String(r.menu).padEnd(34)}${String(r.bar).padEnd(36)}${r.filter}`
  );
}

console.log("\n=== 断言结果 ===");
if (failures.length) {
  failures.forEach((f) => console.log("  FAIL " + f));
  console.log(`  ${failures.length} 条失败`);
} else {
  console.log("  全部通过（主题原料一致 + Window/WindowBody 通道属本主题）");
}
