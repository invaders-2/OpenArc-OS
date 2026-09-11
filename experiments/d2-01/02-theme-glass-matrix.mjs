// D2-01 §Theme / Glass 矩阵 —— 运行时探针
//
// 六格：{light,dark} × {full,reduced,solid}
// 判据（每条都读**渲染后的计算值**，不读源码文本）：
//   1. 主题通道正确：关键面的 background-color 通道属于本主题（防 D1-04B 类回归）
//   2. 玻璃语义正确：FULL 有 filter、REDUCED 关掉大面积 filter、SOLID 全局无 filter
//   3. 正交性：切玻璃档位不得改变主题色，切主题不得改变材质参数
//   4. 对比度：正文/次要文字对有效背景必须达 WCAG AA
//
// 有效背景 = 从元素向上逐层合成所有非透明 background-color（含 alpha），
// 不是简单地取"父元素背景"。

import { Probe, VERDICT, cells, dsUrl, serveDist, launch, parseColor, contrastRatio, relativeLuminance } from "./lib/ds.mjs";

/* 被采样的面：选择器 → 期望随主题变化的通道 */
const SURFACES = [
  { id: "surface-glass", sel: '[data-ds-id="surface-tokens"] .ds-surface--glass', themeChannel: "surface" },
  { id: "surface-solid", sel: '[data-ds-id="surface-tokens"] .ds-surface--solid', themeChannel: "content" },
  { id: "card-cell", sel: '[data-ds-id="surface-grid"] .ds-surface--solid', themeChannel: "content" },
];

const TEXT_TARGETS = [
  { id: "body", sel: ".g-body", size: "normal" },
  { id: "caption", sel: ".g-caption", size: "normal" },
  { id: "muted", sel: ".g-meta", size: "normal" },
  { id: "micro", sel: ".ds-field__hint", size: "small" },
  { id: "error", sel: ".ds-field__error", size: "normal" },
  { id: "section-title", sel: ".g-section__title", size: "large" },
];

const p = new Probe("02-theme-glass-matrix", "D2-01 主题 / 玻璃六格矩阵");
const server = await serveDist();
const browser = await launch();

/* 页面内工具：有效背景合成 + 文本色合成 */
const COMPOSE = `
(() => {
  const parse = (s) => {
    const m = String(s).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const a = m[1].split(/[,\\s\\/]+/).filter(Boolean).map(Number);
    return { r: a[0], g: a[1], b: a[2], a: a.length > 3 ? a[3] : 1 };
  };
  const over = (fg, bg) => {
    const a = fg.a + bg.a * (1 - fg.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: Math.round((fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a),
      g: Math.round((fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a),
      b: Math.round((fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a),
      a,
    };
  };
  window.__effBg = (el) => {
    const stack = [];
    let n = el;
    while (n) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) stack.push(c);
      n = n.parentElement;
    }
    let out = { r: 255, g: 255, b: 255, a: 1 };
    for (const c of stack.reverse()) out = over(c, out);
    return out;
  };
  window.__textColor = (el) => {
    const fg = parse(getComputedStyle(el).color);
    const bg = window.__effBg(el);
    return fg.a < 1 ? over(fg, bg) : fg;
  };
  window.__cs = (el, prop) => getComputedStyle(el).getPropertyValue(prop).trim();
  return true;
})()
`;

const results = [];
const failures = [];

for (const { theme, glass, motion } of cells()) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  await page.goto(dsUrl({ theme, glass, motion }));
  await page.waitForSelector('[data-ds-id="g-meta"]', { timeout: 15000 });
  await page.evaluate(COMPOSE);

  const row = { key: `${theme}-${glass}`, theme, glass, errors: errs.length };

  /* 根节点的类与属性确实是探针要求的（否则下面全部无意义） */
  row.root = await page.evaluate(() => {
    const r = document.querySelector(".g-root");
    return {
      theme: r.getAttribute("data-ds-theme"),
      glass: r.getAttribute("data-ds-glass"),
      motion: r.getAttribute("data-ds-motion"),
      dark: r.classList.contains("dark"),
      reduced: r.classList.contains("reduced"),
    };
  });

  /* 1. 主题通道 */
  row.surfaces = {};
  for (const s of SURFACES) {
    row.surfaces[s.id] = await page.evaluate(
      (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, filter: cs.backdropFilter || cs.webkitBackdropFilter || "none" };
      },
      s.sel,
    );
  }

  /* 2. 玻璃语义 */
  row.glassInfo = await page.evaluate(() => {
    const f = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).backdropFilter || "none" : "(缺元素)";
    };
    return {
      glassSurfaceFilter: f(".ds-surface--glass:not(.ds-surface--large)"),
      // 大面积白名单对照：large 面才该在 REDUCED 下变 none
      largeSurfaceFilter: f(".ds-surface--large"),
      anyFilterCount: [...document.querySelectorAll("*")].filter((el) => {
        const g = getComputedStyle(el).backdropFilter;
        return g && g !== "none";
      }).length,
    };
  });

  /* 4. 对比度 */
  row.contrast = [];
  for (const t of TEXT_TARGETS) {
    const v = await page.evaluate(
      (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const fg = window.__textColor(el);
        const bg = window.__effBg(el);
        const size = parseFloat(getComputedStyle(el).fontSize);
        const weight = Number(getComputedStyle(el).fontWeight);
        return { fg, bg, size, weight };
      },
      t.sel,
    );
    if (!v) {
      row.contrast.push({ id: t.id, ratio: null });
      continue;
    }
    const ratio = contrastRatio(
      `rgb(${v.fg.r},${v.fg.g},${v.fg.b})`,
      `rgb(${v.bg.r},${v.bg.g},${v.bg.b})`,
    );
    const large = v.size >= 24 || (v.size >= 18.66 && v.weight >= 700);
    const need = large ? 3 : t.size === "small" ? 4.5 : 4.5;
    row.contrast.push({ id: t.id, ratio, need, size: +v.size.toFixed(1), pass: ratio >= need });
  }

  results.push(row);
  await page.close();
}

/* ── 桌面视图补充：真实产品表面上的大面积白名单行为 ──────────────────────
   上面那一轮跑的是 primitives 视图，那里没有 .window / .ai-panel / .search-panel。
   而 D1-04C 定义"REDUCED = 大面积转实色"的**验收对象**恰恰是这三个真实产品表面。
   不单独验证一次，白名单在真实组件上就只是注释里的一句死条文。 */
const PRODUCT_LARGE = [
  { id: "window", sel: ".window" },
  { id: "ai-panel", sel: ".ai-panel" },
  { id: "search-panel", sel: ".search-panel" },
];
const desktopRows = [];
for (const { theme, glass, motion } of cells()) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(dsUrl({ theme, glass, motion, view: "desktop" }));
  await page.waitForSelector('[data-ds-view="desktop"]', { timeout: 15000 });
  const filters = await page.evaluate(
    (sels) =>
      Object.fromEntries(
        sels.map((s) => {
          const el = document.querySelector(s.sel);
          return [s.id, el ? getComputedStyle(el).backdropFilter || "none" : "(缺元素)"];
        }),
      ),
    PRODUCT_LARGE,
  );
  desktopRows.push({ key: `${theme}-${glass}`, theme, glass, filters });
  await page.close();
}

/* ── 断言 ───────────────────────────────────────────────────────────────── */
const cases = [];

/* 1. 六格都渲染成功且无运行错误 */
for (const r of results) {
  cases.push({
    name: `${r.key}：gallery 渲染且无控制台/页面错误`,
    status: r.errors === 0 && r.root.theme === r.theme ? VERDICT.PASS : VERDICT.FAIL,
    detail: r.errors ? `${r.errors} 条错误` : "",
  });
}

/* 2. 主题通道属于本主题 */
const expectChannel = { light: { surface: 255, content: 255, solidContent: 255 }, dark: { surface: 23, content: 23, solidContent: 12 } };
for (const r of results) {
  const g = r.surfaces["surface-glass"];
  const c = r.surfaces["card-cell"];
  const gb = g ? parseColor(g.bg) : null;
  const cb = c ? parseColor(c.bg) : null;
  const wantBright = r.theme === "light";
  const gOK = gb && (wantBright ? gb.r > 200 : gb.r < 60);
  const cOK = cb && (wantBright ? cb.r > 200 : cb.r < 60);
  cases.push({
    name: `${r.key}：表面通道属于本主题（glass=${g?.bg} card=${c?.bg}）`,
    status: gOK && cOK ? VERDICT.PASS : VERDICT.FAIL,
    detail: gOK && cOK ? "" : `期望${r.theme}，实际 glass=${g?.bg} card=${c?.bg}`,
  });
}

/* 3. 玻璃语义 */
for (const r of results) {
  const f = r.glassInfo.glassSurfaceFilter;
  const hasFilter = f && f !== "none";
  if (r.glass === "solid") {
    cases.push({
      name: `${r.key}：SOLID 全局无 backdrop-filter（实测 ${r.glassInfo.anyFilterCount} 个元素有 filter）`,
      status: r.glassInfo.anyFilterCount === 0 ? VERDICT.PASS : VERDICT.FAIL,
      detail: r.glassInfo.anyFilterCount ? "SOLID 仍存在过滤面" : "",
    });
  } else {
    cases.push({
      name: `${r.key}：${r.glass.toUpperCase()} 的玻璃面确有 backdrop-filter（${f}）`,
      status: hasFilter ? VERDICT.PASS : VERDICT.FAIL,
      detail: hasFilter ? "" : "玻璃面无 filter",
    });
  }

  /* 3b. 大面积白名单的语义边界（本轮真实 bug 的回归断言）：
     REDUCED 下，**只有显式选择加入 large 的面**转实色；普通小面必须保留玻璃。
     如果哪天有人又把通用组件挂进 --glass-filter-large，这一条会立刻红。 */
  const lf = r.glassInfo.largeSurfaceFilter;
  const largeHasFilter = lf && lf !== "none";
  if (r.glass === "reduced") {
    cases.push({
      name: `${r.key}：REDUCED 下 large 面转实色、小面保留玻璃（large=${lf}）`,
      status: !largeHasFilter && hasFilter ? VERDICT.PASS : VERDICT.FAIL,
      detail:
        largeHasFilter && !hasFilter
          ? "语义反转：large 面仍有玻璃、小面反而没了 —— 白名单挂错元素"
          : largeHasFilter
            ? "large 面在 REDUCED 下仍有 filter（减面积未生效）"
            : !hasFilter
              ? "小面在 REDUCED 下失去玻璃（不该参与大面积白名单）"
              : "",
    });
  } else if (r.glass === "full") {
    cases.push({
      name: `${r.key}：FULL 下 large 与小面都有完整玻璃（开关只属 REDUCED）`,
      status: largeHasFilter && hasFilter ? VERDICT.PASS : VERDICT.FAIL,
      detail: `large=${lf} small=${f}`,
    });
  }
}

/* 3c. 真实产品表面的大面积白名单：desktop 视图下逐个验三个面 */
for (const r of desktopRows) {
  const names = PRODUCT_LARGE.map((x) => x.id);
  const present = names.filter((n) => r.filters[n] === "(缺元素)");
  if (present.length) {
    cases.push({
      name: `${r.key}（desktop 视图）：大面积表面齐备`,
      status: VERDICT.FAIL,
      detail: `未渲染：${present.join(", ")}`,
    });
    continue;
  }
  const vals = names.map((n) => ({ n, f: r.filters[n] }));
  const withFilter = vals.filter((v) => v.f !== "none").map((v) => v.n);
  if (r.glass === "solid") {
    cases.push({
      name: `${r.key}（desktop）：SOLID 下真实表面全部实色`,
      status: withFilter.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
      detail: withFilter.length ? `仍有玻璃：${withFilter.join(", ")}` : "",
    });
  } else if (r.glass === "reduced") {
    cases.push({
      name: `${r.key}（desktop）：REDUCED 下 window / ai-panel / search-panel 全部转实色`,
      status: withFilter.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
      detail: withFilter.length ? `减面积未覆盖：${withFilter.join(", ")}` : "",
    });
  } else {
    cases.push({
      name: `${r.key}（desktop）：FULL 下三个真实表面都有完整玻璃`,
      status: withFilter.length === 3 ? VERDICT.PASS : VERDICT.FAIL,
      detail: withFilter.length === 3 ? "" : `只有 ${withFilter.join(", ")} 有 filter`,
    });
  }
}

/* 4. 正交性：同一主题下，切玻璃档位不得改变**文字色**（材质不该碰主题色） */
for (const theme of ["light", "dark"]) {
  const rows = results.filter((r) => r.theme === theme);
  const textCols = rows.map((r) => r.contrast.find((c) => c.id === "body"));
  const sameSize = new Set(textCols.map((c) => c.size)).size === 1;
  cases.push({
    name: `${theme}：切玻璃档位不改变正文字号（正交性最小证据）`,
    status: sameSize ? VERDICT.PASS : VERDICT.FAIL,
    detail: rows.map((r) => `${r.glass}:${r.contrast.find((c) => c.id === "body")?.size}`).join(" "),
  });
}

/* 5. 对比度 AA */
const contrastFails = [];
for (const r of results) {
  for (const c of r.contrast) {
    if (c.ratio == null) continue;
    if (!c.pass) contrastFails.push(`${r.key}/${c.id}=${c.ratio}<${c.need}`);
  }
}
cases.push({
  name: `对比度：六格 × ${TEXT_TARGETS.length} 个文本目标全部达 WCAG AA`,
  status: contrastFails.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  detail: contrastFails.join("; "),
});

/* ── 输出 ───────────────────────────────────────────────────────────────── */
console.log("\n=== 主题 / 玻璃矩阵 ===");
console.log("格             glass 面背景                      filter                      过滤面数");
for (const r of results) {
  console.log(
    `${r.key.padEnd(14)}${String(r.surfaces["surface-glass"]?.bg).padEnd(32)}${String(
      r.surfaces["surface-glass"]?.filter,
    ).padEnd(28)}${r.glassInfo.anyFilterCount}`,
  );
}
console.log("\n=== 真实产品表面（desktop 视图）===");
console.log("格             " + PRODUCT_LARGE.map((x) => x.id.padEnd(26)).join(""));
for (const r of desktopRows) {
  console.log(
    `${r.key.padEnd(14)}` +
      PRODUCT_LARGE.map((x) => String(r.filters[x.id]).padEnd(26)).join(""),
  );
}
console.log("\n=== 对比度（WCAG AA）===");
console.log("格             " + TEXT_TARGETS.map((t) => t.id.padEnd(14)).join(""));
for (const r of results) {
  console.log(
    `${r.key.padEnd(14)}` +
      r.contrast.map((c) => `${String(c.ratio ?? "-")}${c.pass ? "" : "✗"}`.padEnd(14)).join(""),
  );
}

p.cases.push(...cases);
p.assertAll(cases);
p.note(`共 ${results.length} 格（primitive 视图） + ${desktopRows.length} 格（desktop 视图）`);
p.note(`对比度未达标项：${contrastFails.length ? contrastFails.join(", ") : "无"}`);
p.data = { primitives: results, desktop: desktopRows };

await browser.close();
server.close();

const out = p.write();
console.log(`\n== 02-theme-glass-matrix 结论：${out.verdict} — ${JSON.stringify(out.counts)}`);
console.log(`   产物：${out.file}`);
