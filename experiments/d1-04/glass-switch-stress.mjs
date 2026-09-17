// D1-04B §10：运行时材质切换压力测试。
//
// 要求：FULL→REDUCED→SOLID→FULL 循环 **至少 20 次**，并记录：
//   窗口是否丢失 / 是否闪白闪黑 / 是否残留错误 token / 是否重新布局 /
//   是否有明显长帧尖峰 / WebContentsView 状态是否变化。
//
// 走真实 UI 路径：Settings 窗口里的 .material-select（产品正式控件），
// 不是直接改 localStorage。切换过程中用持续 rAF 采样抓长帧。
//
// WebContentsView 是 Electron 独有对象，Chromium 里不存在；本脚本记录 DOM 侧的
// .web-viewport 数量作为代理，真实 WebContentsView 状态标 NOT VERIFIED。
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PORT = 5222;
const CYCLES = Number(process.env.OA_CYCLES || 21); // ≥20
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto(`http://127.0.0.1:${PORT}/`);
await page.evaluate(() => {
  localStorage.setItem("oa-dark", "true");
  localStorage.setItem("oa-motion", "false");
  localStorage.setItem("oa-glass", "full");
  localStorage.removeItem("oa-opaque");
});
await page.reload();
await page.waitForSelector(".dock-item");

// 窗口 0 / 3 是普通应用，窗口 5 是设置（.material-select 在里面）
for (const i of [0, 3, 5]) {
  await page.locator(".dock-item").nth(i).click();
  await page.waitForTimeout(180);
}
await page.waitForTimeout(400);

const READ = () => {
  const root = document.querySelector(".desktop");
  const rects = [...document.querySelectorAll(".window")].map((w) => {
    const b = w.getBoundingClientRect();
    return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
  });
  return {
    glass: root.getAttribute("data-glass"),
    cls: root.className,
    stored: localStorage.getItem("oa-glass"),
    legacy: localStorage.getItem("oa-opaque"),
    select: (() => {
      const t = document
        .querySelector('.segmented.text[aria-label="材质"] button[aria-pressed="true"]')
        ?.textContent?.trim();
      return t === "完整玻璃" ? "full" : t === "降低材质" ? "reduced" : t === "实色" ? "solid" : null;
    })(),
    winCount: document.querySelectorAll(".window").length,
    viewports: document.querySelectorAll(".web-viewport").length,
    visibleWins: [...document.querySelectorAll(".window")].filter(
      (w) => getComputedStyle(w).display !== "none" && getComputedStyle(w).visibility !== "hidden"
    ).length,
    rects,
    winBackdrop: getComputedStyle(document.querySelector(".window")).backdropFilter,
  };
};

const baseline = await page.evaluate(READ);
console.log(
  `基线：窗口 ${baseline.winCount}（可见 ${baseline.visibleWins}）/ web-viewport ${baseline.viewports} / data-glass=${baseline.glass}`
);

// 持续帧采样：整个切换过程都在记。
await page.evaluate(() => {
  window.__ft = [];
  let last = performance.now();
  const loop = (now) => {
    window.__ft.push(now - last);
    last = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});

const ORDER = ["reduced", "solid", "full"]; // 一个 cycle = 3 次切换
const checkpoints = [];
let switches = 0;
let mismatch = 0;
const burstSamples = [];

const TIER_LABEL = { full: "完整玻璃", reduced: "降低材质", solid: "实色" };
for (let c = 0; c < CYCLES; c++) {
  for (const target of ORDER) {
    await page.click(`.segmented.text[aria-label="材质"] button:has-text("${TIER_LABEL[target]}")`, { timeout: 5000 });
    switches++;
    // 切换后立刻回读：data-glass / storage / select 是否三者一致
    const s = await page.evaluate(READ);
    if (s.glass !== target || s.stored !== target || s.select !== target) {
      mismatch++;
      console.log(`  ✗ cycle${c} → ${target}: glass=${s.glass} stored=${s.stored} select=${s.select}`);
    }
    // 前 2 个 cycle 连拍 4 帧，用于肉眼/像素复核过渡期
    if (c < 2) {
      for (let i = 0; i < 4; i++) {
        burstSamples.push({
          cycle: c,
          target,
          i,
          glass: await page.evaluate(() => document.querySelector(".desktop").getAttribute("data-glass")),
          winBackdrop: await page.evaluate(() =>
            getComputedStyle(document.querySelector(".window")).backdropFilter
          ),
        });
        await page.waitForTimeout(35);
      }
    } else {
      await page.waitForTimeout(25);
    }
  }
  // 每个 cycle 结束做一次结构检查
  const cp = await page.evaluate(READ);
  const okWin = cp.winCount === baseline.winCount;
  const okRect = JSON.stringify(cp.rects) === JSON.stringify(baseline.rects);
  const okView = cp.viewports === baseline.viewports;
  checkpoints.push({
    cycle: c,
    glass: cp.glass,
    winCount: cp.winCount,
    viewports: cp.viewports,
    rectsSame: okRect,
    winSame: okWin,
    viewSame: okView,
    cls: cp.cls,
    legacy: cp.legacy,
  });
  if (!okWin || !okRect || !okView)
    console.log(
      `  ✗ cycle${c}: 窗口 ${okWin ? "保持" : "丢失"} 矩形 ${okRect ? "不变" : "变化"} viewport ${okView ? "保持" : "变化"}`
    );
}

await page.waitForTimeout(400);
const frames = await page.evaluate(() => window.__ft.slice(2));
const final = await page.evaluate(READ);

const sorted = [...frames].sort((a, b) => a - b);
const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const long = frames.filter((x) => x > 33).length;
const veryLong = frames.filter((x) => x > 100).length;

console.log(`\n=== §10 切换压力（${CYCLES} 轮 × 3 = ${switches} 次切换）===`);
console.log(`  三者一致（data-glass / storage / select）：${switches - mismatch}/${switches} 通过`);
console.log(
  `  结构检查：窗口数 ${checkpoints.every((c) => c.winSame) ? "全程保持" : "有变化"} / ` +
    `矩形 ${checkpoints.every((c) => c.rectsSame) ? "全程不变" : "有变化"} / ` +
    `web-viewport ${checkpoints.every((c) => c.viewSame) ? "全程保持" : "有变化"}`
);
console.log(
  `  末态：data-glass=${final.glass} class=${JSON.stringify(final.cls)} legacy(oa-opaque)=${final.legacy} ` +
    `窗口 ${final.winCount} 可见 ${final.visibleWins}`
);
console.log(
  `  切换期帧：p50 ${q(0.5).toFixed(1)}ms / p95 ${q(0.95).toFixed(1)}ms / max ${sorted.at(-1).toFixed(1)}ms / ` +
    `>33ms ${long} 帧 / >100ms ${veryLong} 帧（共 ${frames.length} 帧）`
);

const out = {
  tag: "D1-04C runtime switch stress (selective-glass REDUCED)",
  cycles: CYCLES,
  switches,
  baseline,
  mismatch,
  checkpoints,
  burstSamples,
  frames: {
    p50: +q(0.5).toFixed(1),
    p95: +q(0.95).toFixed(1),
    max: +sorted.at(-1).toFixed(1),
    long33: long,
    long100: veryLong,
    total: frames.length,
  },
  final,
  webContentsView: "NOT VERIFIED IN CHROMIUM（Electron 独有对象）",
};
fs.writeFileSync(
  path.join(ROOT, "artifacts/d1-04/glass-switch-stress.json"),
  JSON.stringify(out, null, 2)
);

await browser.close();
server.close();
console.log("\n产物：artifacts/d1-04/glass-switch-stress.json");
