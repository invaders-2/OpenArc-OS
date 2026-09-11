// D1-04B / D1-04C 官方材质性能基准：**切换产品正式状态**，不注入任何材质值。
//
// 与 D1-04 的 perf2.mjs 的区别（D1-04B 核心要求）：
//   perf2.mjs  → page.addStyleTag 注入 `backdrop-filter: blur(...)` / `rgba(...)`，
//                三档是脚本凭空模拟的（其中 REDUCED 当时产品里并不存在）。
//   本脚本     → 只写 localStorage `oa-glass`，由产品自己把 `data-glass` 挂到
//                `.desktop` 上，材质值全部来自 src/styles.css 的产品 token。
//
// D1-04C 追加：**过滤面积度量**（measureFiltered）。
//   D1-04B 已证伪"降半径 = 降成本"，D1-04C 把 REDUCED 改成"减少被 backdrop-filter
//   覆盖的面积与面数"。因此每次测量同时记录：
//     filteredCount = 实际参与 backdrop-filter 的元素个数
//     filteredArea  = 这些元素裁剪到视口后的像素面积之和
//     coverage      = filteredArea / 视口面积（可 >1，因为面积是叠加的）
//   这三个数与 p50/p95/长帧一起写入 runs[] 与 filtered[]。
//   判据也随之改变：REDUCED 的 filteredArea 必须显著低于 FULL（第 22 节）。
//
// 测量设计（两项相对 perf2 的改进）：
//   1. **同页交错**：不再"跑完 FULL 所有层数再跑 REDUCED"。同一个页面、同一批窗口里
//      轮流切 full/reduced/solid 再各测一次，用真实 Settings select 驱动产品状态。
//      这样外部负载漂移对三档同等作用，不会伪造出档位差异。
//   2. **多轮重复 + 拉丁方轮转顺序**：每层数重复 R 轮，每轮三档顺序轮换，
//      消除"总是先测某一档"的顺序偏置。报告中位数，并给出各轮离散度。
//
// 允许注入的只有**消费方**本身（合成玻璃载荷 .oa-synth），且它只引用产品 token：
//   backdrop-filter: var(--glass-filter-large, var(--glass-filter-window));
//   background: rgb(var(--content-rgb) / var(--content-alpha));
// 脚本里没有 blur/alpha/saturate 字面量。档位一变，产品 token 一变，载荷跟着变。
// 注意载荷用的是与 .window 相同的 `--glass-filter-large` 开关——所以载荷在 REDUCED 下
// 也是实色，这正是"大面积表面转实色"策略的一部分，而不是脚本在模拟。
//
// 环境变量：
//   OA_THEME=dark|light   默认 dark
//   OA_KS=0,24,72,144     默认四档
//   OA_REPEAT=3           每层数重复轮数
//   OA_OUT=文件名          默认 perf-product.json
//   OA_TAG=标签
//
// 冻结口径：视口 1440×900、40 步正弦拖动、90 帧、丢弃前 2 帧、载荷单元 420×300。
// 结论看 p95 与 >33ms 长帧数，**不看平均 fps**（p50 被 120Hz vsync 截平）。

import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PORT = Number(process.env.OA_PORT || 5219);
const EXEC =
  process.env.OA_CHROMIUM ||
  "/Users/wepingli/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const THEME = process.env.OA_THEME === "light" ? "light" : "dark";
const KS = (process.env.OA_KS || "0,24,72,144").split(",").map(Number);
const REPEAT = Number(process.env.OA_REPEAT || 3);
const OUT = process.env.OA_OUT || "perf-product.json";
const LAYOUT = process.env.OA_LAYOUT === "grid" ? "grid" : "scatter";
// warm = 同页交错 + 预热（稳态交互）；cold = 每格独立新页面、无预热（复刻 D1-04 冻结口径）
const MODE = process.env.OA_MODE === "cold" ? "cold" : "warm";
const COLD_REPEAT = Number(process.env.OA_COLD_REPEAT || 5);
const TAG =
  process.env.OA_TAG || `D1-04C OFFICIAL CHROMIUM MEASUREMENT (${THEME})`;

const TIERS = ["full", "reduced", "solid"];

// 期待的**产品态**材质——只用于断言"产品确实切过去了"，不参与渲染。
// D1-04C 起 REDUCED 改的是**作用面**而不是半径：
//   大面积（.window / 载荷）→ none；小面积 chrome（.window-title）→ 保留薄玻璃。
const EXPECT = {
  full: {
    window: /blur\(34px\)\s*saturate\(1\.8\)/,
    title: /^none$/,
    synth: /blur\(34px\)\s*saturate\(1\.8\)/,
  },
  reduced: {
    window: /^none$/,
    title: /^blur\(10px\)$/,
    synth: /^none$/,
  },
  solid: {
    window: /^none$/,
    title: /^none$/,
    synth: /^none$/,
  },
};

const loadavg = () => os.loadavg().map((v) => +v.toFixed(2));

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
        ext === ".js"
          ? "text/javascript"
          : ext === ".css"
            ? "text/css"
            : "text/html",
    });
    fs.createReadStream(f).pipe(res);
  })
  .listen(PORT);

const electronVersion = (() => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(ROOT, "node_modules/electron/package.json"), "utf8")
    ).version;
  } catch {
    return "unknown";
  }
})();

const browser = await chromium.launch({ executablePath: EXEC });

const out = {
  tag: TAG,
  method:
    "PRODUCT STATE (data-glass via Settings select) — no injected material values",
  design:
    MODE === "cold"
      ? `fresh page per cell, no warmup (D1-04 frozen method), ${COLD_REPEAT} repeats`
      : `interleaved tiers within one page, ${REPEAT} rounds, latin-square order, warmed`,
  theme: THEME,
  viewport: "1440x900",
  kList: KS,
  repeat: REPEAT,
  measureMode: MODE,
  coldRepeat: MODE === "cold" ? COLD_REPEAT : null,
  layout: LAYOUT,
  environment: {
    os: `${os.type()} ${os.release()} / Darwin kernel ${os.version?.() ?? "n/a"}`,
    arch: os.arch(),
    cpu: os.cpus()[0]?.model ?? "unknown",
    cpuCores: os.cpus().length,
    ramGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
    browser: null,
    browserVersion: null,
    electron: electronVersion,
    devicePixelRatio: null,
    physicalDisplay: "3456x2234 Retina",
    loadavgStart: null,
    loadavgEnd: null,
    launchFlags: "--no-sandbox --disable-gpu-sandbox --in-process-gpu",
    representative: "NOT REPRESENTATIVE FOR ELECTRON",
  },
  productModes: [],
  runs: [],
  filtered: [],
  rounds: [],
};

{
  const p0 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await p0.goto(`http://127.0.0.1:${PORT}/`);
  const info = await p0.evaluate(() => {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl");
    let gpu = "no webgl";
    if (gl) {
      const d = gl.getExtension("WEBGL_debug_renderer_info");
      gpu = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "unknown";
    }
    return { gpu, dpr: window.devicePixelRatio };
  });
  const v = browser.version();
  out.environment.gpu = info.gpu;
  out.environment.browser = v.split("/")[0];
  out.environment.browserVersion = v.split(" ").slice(-1)[0] || v;
  out.environment.devicePixelRatio = info.dpr;
  out.environment.loadavgStart = loadavg();
  await p0.close();
}

const setup = async (page, tier) => {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.evaluate(
    ({ theme, tier }) => {
      localStorage.setItem("oa-dark", theme === "dark" ? "true" : "false");
      localStorage.setItem("oa-motion", "false");
      localStorage.setItem("oa-glass", tier);
      localStorage.removeItem("oa-opaque"); // 清掉旧键，避免兼容分支干扰
    },
    { theme: THEME, tier }
  );
  await page.reload();
  await page.waitForSelector(".dock-item");
  // 窗口 0 / 3 是普通应用，窗口 5 是设置（.material-select 在里面）
  for (const i of [0, 3, 5]) {
    await page.locator(".dock-item").nth(i).click();
    await page.waitForTimeout(160);
  }
  await page.waitForTimeout(350);
  await page.addStyleTag({
    content: `.oa-synth{
      backdrop-filter: var(--glass-filter-large, var(--glass-filter-window));
      background: rgb(var(--content-rgb) / var(--content-alpha));
    }`,
  });
};

const addSynth = (page, k, layout) =>
  page.evaluate(
    ({ n, layout }) => {
      // 必须挂在 .desktop 内部：token 从这里继承，SOLID 的
      // `.desktop[data-glass="solid"] *` 规则也才够得着。
      const root = document.querySelector(".desktop") || document.body;
      const host = document.createElement("div");
      host.id = "synth";
      host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:5";
      const W = 420;
      const H = 300;
      const VW = 1440;
      const VH = 900;
      for (let i = 0; i < n; i++) {
        const d = document.createElement("div");
        d.className = "oa-synth";
        // scatter：**全部落在视口内**，互质步长散列铺开，面板互相重叠。
        //   K 真正放大合成面积——这是官方基线用的布局。
        // grid：复刻 D1-04 perf2.mjs 的 8 列网格（步长 170/120）。
        //   K>24 后大量面板落到视口外被裁掉，K 与 K*3.5 的实际合成面积几乎一样
        //   （所以旧数据里 K=72 与 K=144 读数接近）。保留它是为了与历史数据
        //   做同布局 A/B，不是推荐布局。
        const pos =
          layout === "grid"
            ? `left:${(i % 8) * 170}px;top:${Math.floor(i / 8) * 120}px;`
            : `left:${(i * 173) % (VW - W)}px;top:${(i * 97) % (VH - H)}px;`;
        d.style.cssText =
          `position:absolute;width:${W}px;height:${H}px;border-radius:16px;` + pos;
        host.appendChild(d);
      }
      root.appendChild(host);
      return n;
    },
    { n: k, layout }
  );

// 切换产品档位并回读取证。任何一项对不上就直接抛错，不静默继续。
const TIER_LABEL = { full: "完整玻璃", reduced: "降低材质", solid: "实色" };
const selectTier = async (page, tier, expectSynth) => {
  await page.click(`.segmented.text[aria-label="材质"] button:has-text("${TIER_LABEL[tier]}")`, { timeout: 5000 });
  await page.waitForTimeout(220);
  const s = await page.evaluate(() => {
    const d = document.querySelector(".desktop");
    const w = document.querySelector(".window");
    const t = document.querySelector(".window-title");
    const probe = document.querySelector(".oa-synth");
    return {
      dataGlass: d?.dataset.glass ?? null,
      cls: d?.className ?? null,
      stored: localStorage.getItem("oa-glass"),
      select: (() => {
        const el = document
          .querySelector('.segmented.text[aria-label="材质"] button[aria-pressed="true"]')
          ?.textContent?.trim();
        return el === "完整玻璃" ? "full" : el === "降低材质" ? "reduced" : el === "实色" ? "solid" : null;
      })(),
      winBackdrop: w ? getComputedStyle(w).backdropFilter : null,
      titleBackdrop: t ? getComputedStyle(t).backdropFilter : null,
      synthBackdrop: probe ? getComputedStyle(probe).backdropFilter : null,
      synthBg: probe ? getComputedStyle(probe).backgroundColor : null,
      surfAlpha: getComputedStyle(d).getPropertyValue("--surface-alpha").trim(),
      winCount: document.querySelectorAll(".window").length,
    };
  });
  if (s.dataGlass !== tier || s.stored !== tier || s.select !== tier)
    throw new Error(
      `档位不同步：期望 ${tier}，实际 data-glass=${s.dataGlass} stored=${s.stored} select=${s.select}`
    );
  const nz = (v) => (v || "none").replace(/\s+/g, " ").trim();
  const E = EXPECT[tier];
  if (!E.window.test(nz(s.winBackdrop)))
    throw new Error(`窗口材质与预期不符（token 可能被改动）：${tier} → ${nz(s.winBackdrop)}`);
  if (!E.title.test(nz(s.titleBackdrop)))
    throw new Error(`窗口标题条材质与预期不符：${tier} → ${nz(s.titleBackdrop)}`);
  // K=0 时没有载荷单元，跳过载荷断言
  if (expectSynth) {
    if (!s.synthBackdrop) throw new Error(`载荷单元缺失：K>0 但找不到 .oa-synth`);
    if (!E.synth.test(nz(s.synthBackdrop)))
      throw new Error(`载荷未跟随产品档位：${tier} → ${nz(s.synthBackdrop)}`);
  }
  return s;
};

// D1-04C 核心指标：被 backdrop-filter 覆盖的**面数**与**像素面积**。
// 这是本轮的独立变量——REDUCED 的判据不再是"半径更小"，而是"过滤面积显著更小"。
const measureFiltered = (page) =>
  page.evaluate(() => {
    const VW = innerWidth;
    const VH = innerHeight;
    const hits = [];
    let area = 0;
    for (const el of document.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      const f = cs.backdropFilter || cs.webkitBackdropFilter || "none";
      if (!f || f === "none") continue;
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0")
        continue;
      const b = el.getBoundingClientRect();
      if (b.width <= 0 || b.height <= 0) continue;
      // 只计入视口内的可见部分，否则视口外的载荷会把面积虚高
      const iw = Math.max(0, Math.min(b.right, VW) - Math.max(b.left, 0));
      const ih = Math.max(0, Math.min(b.bottom, VH) - Math.max(b.top, 0));
      const a = Math.round(iw * ih);
      if (a === 0) continue;
      area += a;
      hits.push({
        sel: typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).join(".") : el.tagName.toLowerCase(),
        filter: f,
        w: Math.round(b.width),
        h: Math.round(b.height),
        area: a,
      });
    }
    return {
      filteredCount: hits.length,
      filteredArea: area,
      viewportArea: VW * VH,
      coverage: +(area / (VW * VH)).toFixed(4),
      hits,
    };
  });

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
          else res(t.slice(2)); // 丢弃前 2 帧
        });
      })
  );

const stats = (f) => {
  const s = [...f].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  const mean = f.reduce((a, b) => a + b, 0) / f.length;
  return {
    p50: +q(0.5).toFixed(1),
    p95: +q(0.95).toFixed(1),
    max: +s[s.length - 1].toFixed(1),
    long: f.filter((x) => x > 33).length,
    // 帧时间被 vsync 量化成 8.33 / 16.67 / 25 …，p95 只反映"是否跨过某个台阶"。
    // mean 与丢帧率对"错过垂直同步的比例"是线性的，方差小得多，是本报告的主指标。
    mean: +mean.toFixed(2),
    miss120: +(f.filter((x) => x > 12).length / f.length).toFixed(3),
    miss60: +(f.filter((x) => x > 16).length / f.length).toFixed(3),
    frames: f.length,
  };
};

const drag = async (page, box, timed) => {
  // 预热一遍完整轨迹：不预热会采到"首次进入拖动 + 合成器预热"的长帧，
  // 那不是材质成本而是冷启动噪声。
  await page.mouse.move(box.x + 200, box.y + 18);
  await page.mouse.down();
  for (let i = 0; i < 40; i++) {
    await page.mouse.move(
      box.x + 200 + Math.sin(i / 4) * 120,
      box.y + 18 + (i % 7) * 5
    );
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
  await page.waitForTimeout(200);

  await page.mouse.move(box.x + 200, box.y + 18);
  await page.mouse.down();
  const pr = timed ? measure(page) : null;
  for (let i = 0; i < 40; i++) {
    await page.mouse.move(
      box.x + 200 + Math.sin(i / 4) * 120,
      box.y + 18 + (i % 7) * 5
    );
    await page.waitForTimeout(12);
  }
  const frames = pr ? await pr : null;
  await page.mouse.up();
  return frames;
};

console.log(`环境：${out.environment.os}`);
console.log(
  `       ${out.environment.cpu} ×${out.environment.cpuCores} / ${out.environment.ramGB} GB / loadavg ${out.environment.loadavgStart.join(" ")}`
);
console.log(`       GPU ${out.environment.gpu}`);
console.log(
  `       ${out.environment.browser} ${out.environment.browserVersion}（非 Electron）/ Electron ${out.environment.electron} 已装但 GPU 不可用`
);
console.log(
  `主题 ${THEME} / 档位 ${TIERS.join(" / ")} / K ${KS.join(",")} / 口径 ${MODE} / 视口 1440×900\n`
);

// 拉丁方轮转：每轮把三档顺序左移一位，消除顺序偏置
const ORDER = (r) => {
  const a = ["full", "reduced", "solid"];
  return a.slice(r % 3).concat(a.slice(0, r % 3));
};

for (const k of KS) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await setup(page, "full");
  await addSynth(page, k, LAYOUT);
  await page.waitForTimeout(400);
  const box = await page.locator(".window").last().boundingBox();
  const perTier = { full: [], reduced: [], solid: [] };
  const filtByTier = {}; // D1-04C：每档的过滤面数 / 过滤面积

  if (MODE === "cold") {
    // 冷启动口径：复刻 D1-04 perf2.mjs 的采样方式——**每格独立新页面、无预热**，
    // 因此每格都包含"新图层首次光栅化 + 首次 backdrop 模糊"的一次性成本。
    // 与该历史方法的唯一区别：档位由产品 `data-glass` 决定，不注入材质值。
    // 每档重复 COLD_REPEAT 次（每次都是新页面），用中位数压单次抖动。
    await page.close();
    for (let r = 0; r < COLD_REPEAT; r++) {
      for (const tier of ORDER(r)) {
        const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        await setup(p, tier);
        await addSynth(p, k, LAYOUT);
        await p.waitForTimeout(400);
        const b = await p.locator(".window").last().boundingBox();
        const st0 = await selectTier(p, tier, k > 0);
        if (r === 0) {
          filtByTier[tier] = await measureFiltered(p);
          out.productModes.push({
            tier,
            theme: THEME,
            panes: k,
            mode: "cold",
            dataGlass: st0.dataGlass,
            winBackdrop: st0.winBackdrop,
            titleBackdrop: st0.titleBackdrop,
            synthBackdrop: st0.synthBackdrop,
            synthBg: st0.synthBg,
            surfaceAlpha: st0.surfAlpha,
          });
        }
        const frames = await drag(p, b, true);
        const st = stats(frames);
        perTier[tier].push(st);
        out.rounds.push({ panes: k, round: r, tier, mode: "cold", ...st });
        console.log(
          `  K=${String(k).padStart(3)} 冷${r} ${tier.padEnd(8)} mean ${String(st.mean).padStart(6)} p50 ${String(st.p50).padStart(5)} p95 ${String(st.p95).padStart(6)} long ${String(st.long).padStart(2)}  [${(st0.synthBackdrop || "none").replace(/\s+/g, " ")}]`
        );
        await p.close();
      }
    }
  } else {
    // 稳态口径：同一页面内交错切换三档，每轮三档顺序轮转（拉丁方），
    // 先做一轮不计分的预热拖动，剔除"图层分配 + 首次光栅化"的一次性开销。
    // 不做预热，拉丁方第 0 轮总把 FULL 排在最前，会把这份一次性开销记在 FULL 头上，
    // 伪造出档位差异（实测 K=72 首轮 mean 20.0ms、后续轮 8.3ms）。
    for (const tier of TIERS) {
      await selectTier(page, tier, k > 0);
      await drag(page, box, false);
    }
    await page.waitForTimeout(300);

    for (let r = 0; r < REPEAT; r++) {
      for (const tier of ORDER(r)) {
        const s = await selectTier(page, tier, k > 0);
        if (r === 0) {
          filtByTier[tier] = await measureFiltered(page);
          out.productModes.push({
            tier,
            theme: THEME,
            panes: k,
            mode: "warm",
            dataGlass: s.dataGlass,
            winBackdrop: s.winBackdrop,
            titleBackdrop: s.titleBackdrop,
            synthBackdrop: s.synthBackdrop,
            synthBg: s.synthBg,
            surfaceAlpha: s.surfAlpha,
          });
        }
        const frames = await drag(page, box, true);
        const st = stats(frames);
        perTier[tier].push(st);
        out.rounds.push({ panes: k, round: r, tier, mode: "warm", ...st });
        console.log(
          `  K=${String(k).padStart(3)} 轮${r} ${tier.padEnd(8)} mean ${String(st.mean).padStart(6)} 丢120Hz ${(st.miss120 * 100).toFixed(0).padStart(3)}% 丢60Hz ${(st.miss60 * 100).toFixed(0).padStart(3)}% p50 ${String(st.p50).padStart(5)} p95 ${String(st.p95).padStart(5)} long ${String(st.long).padStart(2)}  [${(s.synthBackdrop || "none").replace(/\s+/g, " ")}]`
        );
      }
    }
  }
  const med = (arr, key) => {
    const v = arr.map((x) => x[key]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  for (const tier of TIERS) {
    const a = perTier[tier];
    const f = filtByTier[tier] || null;
    const rec = {
      tier,
      panes: k,
      rounds: a.length,
      p50: med(a, "p50"),
      p95: med(a, "p95"),
      long: med(a, "long"),
      max: med(a, "max"),
      mean: +(a.reduce((s, x) => s + x.mean, 0) / a.length).toFixed(2),
      miss120: +(a.reduce((s, x) => s + x.miss120, 0) / a.length).toFixed(3),
      miss60: +(a.reduce((s, x) => s + x.miss60, 0) / a.length).toFixed(3),
      filteredCount: f ? f.filteredCount : null,
      filteredArea: f ? f.filteredArea : null,
      filteredCoverage: f ? f.coverage : null,
      p95Spread: [
        +Math.min(...a.map((x) => x.p95)),
        +Math.max(...a.map((x) => x.p95)),
      ],
      meanSpread: [
        +Math.min(...a.map((x) => x.mean)),
        +Math.max(...a.map((x) => x.mean)),
      ],
    };
    out.runs.push(rec);
    if (f)
      out.filtered.push({
        panes: k,
        tier,
        filteredCount: f.filteredCount,
        filteredArea: f.filteredArea,
        viewportArea: f.viewportArea,
        coverage: f.coverage,
        // 只留最大的 6 个面，避免产物过大
        top: f.hits.sort((x, y) => y.area - x.area).slice(0, 6),
      });
    console.log(
      `  ── K=${String(k).padStart(3)} ${tier.padEnd(8)} mean ${String(rec.mean).padStart(6)} 丢120Hz ${(rec.miss120 * 100).toFixed(0).padStart(3)}% ` +
        `| p95 ${String(rec.p95).padStart(5)}（各轮 ${rec.p95Spread.join("–")}） ` +
        `| 过滤面 ${String(rec.filteredCount).padStart(3)} 个 / 面积 ${String(rec.filteredArea).padStart(8)} px ` +
        `(${(rec.filteredCoverage * 100).toFixed(1)}% 视口)\n`
    );
  }
  await page.close();
}

out.environment.loadavgEnd = loadavg();
await browser.close();
server.close();
fs.writeFileSync(
  path.join(ROOT, "artifacts/d1-04", OUT),
  JSON.stringify(out, null, 2)
);
console.log(`产物：artifacts/d1-04/${OUT}`);
console.log(`代表性：${out.environment.representative}`);
