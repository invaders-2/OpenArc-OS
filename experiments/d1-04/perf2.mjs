// D1-04 性能基准 v2：把帧率压出垂直同步余量，玻璃成本才可分辨。
//
// ⚠️ 历史口径（HISTORICAL REFERENCE，D1-04B 起降级）
//    本脚本用 page.addStyleTag **注入 CSS 模拟**三档材质，其中 REDUCED 在当时的
//    产品代码里并不存在。它记录的是"REDUCED 值多少钱"这一早期判断。
//    D1-04B 起 REDUCED 已真实进入产品代码，官方性能验收改用：
//        experiments/d1-04/perf-product.mjs   （切换 data-glass，不注入材质值）
//    本文件保留不删，作为回归对照的历史数据来源。
//
// v1 的问题：120Hz vsync 下 p50 恒为 8.3ms，FULL 与 SOLID 完全一致，
// 于是"玻璃不花钱"是个假结论——实际是测量被 vsync 截断了。
// v2 做法：注入 K 个与 .window 同材质的合成玻璃层，K 递增直到掉帧，
// 三档材质各测一遍，用"能撑住多少层"和"掉到多少 fps"来量化成本。

import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PORT = 5218;
const EXEC =
  process.env.OA_CHROMIUM ||
  "/Users/wepingli/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const TIERS = {
  FULL: `backdrop-filter: blur(34px) saturate(1.8); background: rgba(23,23,23,0.5);`,
  REDUCED: `backdrop-filter: blur(12px); background: rgba(23,23,23,0.72);`,
  SOLID: `backdrop-filter: none; background: #171717;`,
};

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
const out = { gpu: null, machine: null, runs: [] };

{
  const p0 = await browser.newPage();
  await p0.goto(`http://127.0.0.1:${PORT}/`);
  out.gpu = await p0.evaluate(() => {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl");
    if (!gl) return "no webgl";
    const d = gl.getExtension("WEBGL_debug_renderer_info");
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  await p0.close();
}

const setup = async (page, tierCss) => {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.evaluate(() => {
    localStorage.setItem("oa-dark", "true");
    localStorage.setItem("oa-motion", "false");
    localStorage.setItem("oa-opaque", "false");
  });
  await page.reload();
  await page.waitForSelector(".dock-item");
  for (let i = 0; i < 4; i++) {
    await page.locator(".dock-item").nth(i).click();
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(300);
  if (tierCss) {
    await page.addStyleTag({
      content: `.window, .topbar, .dock { ${tierCss} }
                .oa-synth { ${tierCss} }`,
    });
  }
};

const addSynth = (page, k) =>
  page.evaluate((n) => {
    const host = document.createElement("div");
    host.id = "synth";
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:5";
    for (let i = 0; i < n; i++) {
      const d = document.createElement("div");
      d.className = "oa-synth";
      d.style.cssText =
        `position:absolute;width:420px;height:300px;border-radius:16px;` +
        `left:${(i % 8) * 170}px;top:${Math.floor(i / 8) * 120}px;`;
      host.appendChild(d);
    }
    document.body.appendChild(host);
    return n;
  }, k);

const measure = (page) =>
  page.evaluate(
    () =>
      new Promise((res) => {
        const t = [];
        let last = performance.now();
        const raf = requestAnimationFrame(function loop(now) {
          t.push(now - last);
          last = now;
          if (t.length < 90) requestAnimationFrame(loop);
          else res(t.slice(2));
        });
      })
  );

const stats = (f) => {
  const s = [...f].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return {
    p50: +q(0.5).toFixed(1),
    p95: +q(0.95).toFixed(1),
    max: +s[s.length - 1].toFixed(1),
    long: f.filter((x) => x > 33).length,
    fps: +(1000 / q(0.5)).toFixed(1),
  };
};

for (const [name, css] of Object.entries(TIERS)) {
  for (const k of [0, 24, 72, 144]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await setup(page, css);
    await addSynth(page, k);
    await page.waitForTimeout(400);
    const box = await page.locator(".window").last().boundingBox();
    let frames;
    if (box) {
      await page.mouse.move(box.x + 200, box.y + 18);
      await page.mouse.down();
      const pr = measure(page);
      for (let i = 0; i < 40; i++) {
        await page.mouse.move(box.x + 200 + Math.sin(i / 4) * 120, box.y + 18 + (i % 7) * 5);
        await page.waitForTimeout(12);
      }
      frames = await pr;
      await page.mouse.up();
    } else {
      frames = await measure(page);
    }
    const r = { tier: name, panes: k, ...stats(frames) };
    out.runs.push(r);
    console.log(`${name.padEnd(8)} 玻璃层 ${String(k).padStart(3)}  ${JSON.stringify(r)}`);
    await page.close();
  }
}

await browser.close();
server.close();
fs.writeFileSync(path.join(ROOT, "artifacts/d1-04/perf2.json"), JSON.stringify(out, null, 2));
console.log("\nGPU:", out.gpu);
