// D1-04B §10/§12：运行时材质切换正确性 + 与 Reduce Motion 解耦验证。
//
// §10 走真实 UI 路径（Settings 里的 select），不是直接改 localStorage。
//      每步连拍 4 张，用来抓过渡期的闪白/闪黑。
// §12 交叉验证 4 个组合，确认动效设置与材质档位互不影响。
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PORT = 5221;
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const setup = async (dark, motion) => {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.evaluate(
    ([d, m]) => {
      localStorage.setItem("oa-dark", String(d));
      localStorage.setItem("oa-motion", String(m));
      localStorage.setItem("oa-glass", "full");
    },
    [dark, motion]
  );
  await page.reload();
  await page.waitForSelector(".dock-item");
};

// 开 3 个窗口，其中一个是设置（select 在里面）
const openWindows = async () => {
  for (const i of [0, 3, 5]) {
    await page.locator(".dock-item").nth(i).click();
    await page.waitForTimeout(160);
  }
};

const snap = async (tag) => {
  const png = path.join(ROOT, `artifacts/d1-04/switch-${tag}.png`);
  await page.screenshot({ path: png });
  const meta = await page.evaluate(() => {
    const root = document.querySelector(".desktop");
    const r = (s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
    };
    return {
      glass: root.getAttribute("data-glass"),
      cls: root.className,
      storedGlass: localStorage.getItem("oa-glass"),
      storedOpaque: localStorage.getItem("oa-opaque"),
      select: document.querySelector(".material-select")?.value ?? null,
      winCount: document.querySelectorAll(".window").length,
      viewports: document.querySelectorAll(".web-viewport").length,
      rects: [...document.querySelectorAll(".window")].map((w) => r(".window") && [
        Math.round(w.getBoundingClientRect().x), Math.round(w.getBoundingClientRect().y),
        Math.round(w.getBoundingClientRect().width), Math.round(w.getBoundingClientRect().height),
      ]),
      topbar: r(".topbar"), dock: r(".dock"),
      win: getComputedStyle(document.querySelector(".window")).backdropFilter,
      top: getComputedStyle(document.querySelector(".topbar")).backdropFilter,
      anim: getComputedStyle(document.querySelector(".window")).animationName,
      quick: getComputedStyle(root).getPropertyValue("--quick").trim(),
    };
  });
  return { ...meta, png };
};

// ── §10 切换往返 ──────────────────────────────────────────────
await setup(true, false);
await openWindows();
const baseline = await snap("base");
console.log("基线窗口数:", baseline.winCount, "windows:", JSON.stringify(baseline.rects));

const SEQ = ["reduced", "solid", "full", "reduced", "solid", "full"];
const steps = [];
for (const target of SEQ) {
  await page.selectOption(".material-select", target);
  const burst = [];
  for (let i = 0; i < 4; i++) {
    burst.push(await snap(`t-${target}-${i}`));
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(350);
  const settled = await snap(`settled-${target}`);
  steps.push({ target, burst: burst.map((b) => ({ glass: b.glass, win: b.win, top: b.top })), settled });
}

console.log("\n=== §10 切换往返（走 Settings select）===");
for (const s of steps) {
  const b = s.burst;
  const glassSeen = [...new Set(b.map((x) => x.glass))];
  const winFilters = [...new Set(b.map((x) => x.win))];
  const okWins = s.settled.winCount === baseline.winCount;
  const okRects = JSON.stringify(s.settled.rects) === JSON.stringify(baseline.rects);
  const okSel = s.settled.select === s.target;
  const okStore = s.settled.storedGlass === s.target;
  console.log(
    `  → ${s.target.padEnd(8)} 过渡期 data-glass=${glassSeen.join("/")} | filter=${winFilters.length === 1 ? winFilters[0] : winFilters.join(" / ")} | ` +
      `窗口 ${okWins ? "保持" : "丢失!"} 矩形 ${okRects ? "不变" : "变了!"} select ${okSel ? "同步" : "失同步!"} storage ${okStore ? "同步" : "失同步!"}`
  );
}
const last = steps.at(-1).settled;
console.log("\n  末态:", last.glass, "class=", JSON.stringify(last.cls), "viewports=", last.viewports);

// ── §12 动效 × 材质 解耦 ──────────────────────────────────────
console.log("\n=== §12 Reduce Motion × 材质档位 解耦 ===");
const combos = [
  [true, true],
  [true, false],
  [false, true],
  [false, false],
];
for (const [motion, dark] of combos) {
  await setup(dark, motion);
  await openWindows();
  const a = await snap(`combo-m${motion ? 1 : 0}`);
  const b = await snap(`combo-m${motion ? 1 : 0}-l`);
  console.log(
    `  motion=${String(motion).padEnd(5)} dark=${String(dark).padEnd(5)} | --quick=${a.quick.padEnd(5)} 窗口动画=${a.anim.padEnd(8)} ` +
      `glass=${a.glass} 在动画中打开后仍需可见（截图 ${path.basename(b.png)}）`
  );
}

// motion 开 + 三档材质，确认材质切换不影响动效设置
for (const g of ["full", "reduced", "solid"]) {
  await setup(true, true);
  await page.evaluate((x) => localStorage.setItem("oa-glass", x), g);
  await page.reload();
  await page.waitForSelector(".dock-item");
  await openWindows();
  const s = await snap(`deco-m1-${g}`);
  console.log(`  motion=ON + glass=${g.padEnd(8)} | --quick=${s.quick} 动画=${s.anim} cls=${JSON.stringify(s.cls)}`);
}

await browser.close();
server.close();
fs.writeFileSync(
  path.join(ROOT, "artifacts/d1-04/glass-switch.json"),
  JSON.stringify({ baseline, steps, combos: combos.length }, null, 2)
);
console.log("\nwritten glass-switch.json");
