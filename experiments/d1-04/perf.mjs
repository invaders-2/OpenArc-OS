// D1-04 性能基准：固定场景 + 真实拖动，比较玻璃档位
//
// 场景：桌面 + 5 个 DOM 窗口 + Dock + 顶栏 + 1000 个压力节点 + 搜索浮层
// 档位：FULL（默认玻璃） / SOLID（opaque 关闭 backdrop-filter）
//       REDUCED（降 blur）当前产品未实现，脚本只记录"缺失"
//
// 注意：本机 Chromium 有 GPU（ANGLE Metal），但 Electron 在此环境 GPU 进程不可用，
// 因此本组数据**不代表 Electron 真实表现**，只用于冻结测量方法。

import { chromium } from "playwright";

const BASE = process.env.OA_BASE || "http://127.0.0.1:5210/";
const EXEC =
  process.env.OA_CHROMIUM ||
  "/Users/wepingli/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const setup = async (opaque) => {
  await page.goto(BASE);
  await page.evaluate((o) => {
    localStorage.setItem("oa-dark", "true");
    localStorage.setItem("oa-motion", "false");
    localStorage.setItem("oa-opaque", String(o));
  }, opaque);
  await page.reload();
  await page.waitForSelector(".dock-item");
};

const openWindows = async (n) => {
  const items = await page.locator(".dock-item").count();
  for (let i = 0; i < n; i++) {
    await page.locator(".dock-item").nth(i % items).click();
    await page.waitForTimeout(120);
  }
  return page.locator(".window").count();
};

const stress = async (nodes) => {
  await page.evaluate((n) => {
    const host = document.createElement("div");
    host.id = "stress";
    host.style.cssText =
      "position:fixed;left:-9999px;top:0;width:10px;height:10px;overflow:hidden";
    for (let i = 0; i < n; i++) {
      const d = document.createElement("div");
      d.textContent = "n" + i;
      host.appendChild(d);
    }
    document.body.appendChild(host);
  }, nodes);
};

const measureDrag = async () => {
  return page.evaluate(async () => {
    const times = [];
    let last = performance.now();
    let raf = requestAnimationFrame(function loop(t) {
      times.push(t - last);
      last = t;
      raf = requestAnimationFrame(loop);
    });
    await new Promise((r) => setTimeout(r, 1500));
    cancelAnimationFrame(raf);
    return times.slice(2);
  });
};

const stats = (f) => {
  if (!f.length) return null;
  const s = [...f].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return {
    n: f.length,
    p50: +q(0.5).toFixed(1),
    p95: +q(0.95).toFixed(1),
    max: +s[s.length - 1].toFixed(1),
    long: f.filter((x) => x > 50).length,
    fps: +(1000 / q(0.5)).toFixed(1),
  };
};

console.log("=== 固定场景性能测试（Chromium + ANGLE Metal；不代表 Electron）===\n");

for (const [label, opaque] of [
  ["A. FULL（默认玻璃）", false],
  ["C. SOLID（opaque，关闭 backdrop-filter）", true],
]) {
  await setup(opaque);
  const winCount = await openWindows(5);
  await stress(1000);
  await page.waitForTimeout(500);

  const memBefore = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);

  // 真实拖动最上层窗口
  const box = await page.locator(".window").last().boundingBox();
  if (box) {
    await page.mouse.move(box.x + 200, box.y + 20);
    await page.mouse.down();
    const drag = measureDrag();
    for (let i = 0; i < 30; i++) {
      await page.mouse.move(box.x + 200 + i * 8, box.y + 20 + (i % 5) * 4);
      await page.waitForTimeout(16);
    }
    const frames = await drag;
    await page.mouse.up();

    const memAfter = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
    const nodes = await page.evaluate(() => document.querySelectorAll("*").length);

    console.log(`${label}`);
    console.log(`  窗口数 ${winCount}，DOM 节点 ${nodes}`);
    console.log(`  拖动帧时间：${JSON.stringify(stats(frames))}`);
    console.log(
      `  JS 堆：${memBefore ? (memBefore / 1048576).toFixed(1) : "?"}MB → ${memAfter ? (memAfter / 1048576).toFixed(1) : "?"}MB`,
    );
  }
  await page.evaluate(() => document.getElementById("stress")?.remove());
}

// 无拖动基线
await setup(false);
await openWindows(5);
await stress(1000);
await page.waitForTimeout(600);
const idle = await measureDrag();
console.log(`\nA. FULL 空闲基线：${JSON.stringify(stats(idle))}`);

// REDUCED 档位是否存在
await setup(false);
const hasReducedTier = await page.evaluate(() => {
  const el = document.querySelector(".window");
  return {
    backdrop: getComputedStyle(el).backdropFilter,
    opaqueClass: document.querySelector(".desktop").className,
  };
});
console.log(`\nREDUCED 档位检查：window backdrop=${hasReducedTier.backdrop}`);
console.log(`  （产品当前只有 FULL / SOLID 两档，REDUCED 未实现）`);

await browser.close();
