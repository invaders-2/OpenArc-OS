// D2-01 §Motion —— 动效矩阵探针
//
// 动效这一维的判据只有三条，但每条都容易做成"看起来对了"：
//   1. **只改时长**。reduced 只把时长归零，**终点值必须与 normal 完全相同**。
//      如果 reduced 下 hover 的结束颜色变了，那它就不只是"减少动效"，而是在偷偷改设计。
//      验证方式：等足够长时间（超过最长 transition）后再取指纹，两边必须逐字节相同。
//   2. **两条触发路径结果一致**。产品内 `.reduced` 类与系统级
//      `prefers-reduced-motion` 必须走同一套结果 —— 这是 tokens.css 的明文承诺。
//      系统级路径用 Playwright 的 emulateMedia 真实模拟，不是读源码猜。
//   3. **功能不能依赖动画结束**。reduced 下状态必须在 0ms 内到达终态；
//      如果哪个实现把 transitionend 当作状态推进的唯一路径，reduced 下就会卡死。
//      验证方式：切换后**立即**取指纹（不等待）就应当已是终态。
//
// 另外验证"reduced ≠ 禁用"：点击、焦点环、可读性在 reduced 下必须照旧成立。

import { Probe, VERDICT, dsUrl, serveDist, launch } from "./lib/ds.mjs";

/* 参与动效判定的交互组件（覆盖按钮族与输入族） */
const TARGETS = [
  { id: "button-secondary", sel: '[data-ds-id="btn-secondary"]' },
  { id: "button-primary", sel: '[data-ds-id="btn-primary"]' },
  { id: "icon-button", sel: '[data-ds-id="ib-ghost"]' },
  { id: "text-field-box", sel: '[data-ds-id="tf-empty"] .ds-field__box' },
  { id: "search-field", sel: '[data-ds-id="sf-states"] .ds-search' },
];

/* 主题色 / 玻璃材质取样点（用于正交性：切动效不得碰这两维） */
const ORTHO = [
  { id: "text", sel: '[data-ds-id="g-meta"]', props: ["color"] },
  { id: "body-bg", sel: '[data-ds-id="g-meta"]', props: ["fontSize", "lineHeight"] },
  {
    id: "glass-surface",
    sel: '[data-ds-id="surface-tokens"] .ds-surface--glass',
    props: ["backgroundColor", "backdropFilter"],
  },
];

const p = new Probe("05-motion-matrix", "D2-01 动效矩阵");
const server = await serveDist();
const browser = await launch();

/* 取一个元素的动效 + 视觉指纹 */
const SNAP = `(sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const cs = getComputedStyle(el);
  return {
    transitionDuration: cs.transitionDuration,
    transitionProperty: cs.transitionProperty,
    animationName: cs.animationName,
    animationDuration: cs.animationDuration,
    bg: cs.backgroundColor,
    color: cs.color,
    shadow: cs.boxShadow,
    outline: [cs.outlineStyle, cs.outlineWidth, cs.outlineColor].join(" "),
  };
}`;
const snap = (page, sel) => page.evaluate(new Function("sel", `return (${SNAP})(sel)`), sel);
const visual = (s) => (s ? `${s.bg}|${s.color}|${s.shadow}|${s.outline}` : "(null)");

/** 在指定动效条件下，对一个目标做"等足够的 hover 终态"采样 */
const results = {};

for (const label of ["normal", "reduced-class", "reduced-os"]) {
  const osReduce = label === "reduced-os";
  /* 关键：系统级路径必须**隔离**验证 —— URL 用 motion=normal（不挂 .reduced 类），
     只靠 emulateMedia 模拟系统设置。第一版这里写了 motion=reduced，结果
     .reduced 类把系统级路径整个遮住，"两条路径一致"的断言变成空转，
     连"系统级下 spinner 是卡住的半圈"这个真 bug 都测不出来。 */
  const motion = label === "reduced-class" ? "reduced" : "normal";
  const url = { href: dsUrl({ theme: "light", glass: "full", motion, view: "primitives" }), osReduce };
  const row = { label, osReduce, urlMotion: motion, states: {}, hoverTerminal: {}, reducedTiming: {}, spinner: null, toastBar: null };
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  if (osReduce) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(url.href);
  await page.waitForSelector('[data-ds-id="btn-secondary"]', { timeout: 15000 });

  /* 隔离守卫：系统级路径那一格必须**没有** .reduced 类，否则测的不是系统级路径 */
  row.rootGuard = await page.evaluate(() => {
    const r = document.querySelector(".g-root");
    return {
      hasReducedClass: r?.classList.contains("reduced") ?? null,
      dataMotion: r?.getAttribute("data-ds-motion") ?? null,
    };
  });

  // 1. 各目标的动效参数
  for (const t of TARGETS) row.states[t.id] = await snap(page, t.sel);

  // 2. hover 终态（等 500ms，超过最长 320ms 的 slow 档）
  for (const t of TARGETS) {
    await page.mouse.move(4, 4);
    await page.waitForTimeout(60);
    const before = await snap(page, t.sel);
    await page.hover(t.sel);
    await page.waitForTimeout(500);
    const after = await snap(page, t.sel);
    row.hoverTerminal[t.id] = { before: visual(before), after: visual(after), changed: visual(before) !== visual(after) };
  }

  // 3. reduced 是否**立即**到达终态（0ms 后即终态 → 功能不依赖动画结束）
  if (!osReduce && motion === "reduced") {
    for (const t of TARGETS) {
      await page.mouse.move(4, 4);
      await page.waitForTimeout(60);
      await page.hover(t.sel);
      const immediate = await snap(page, t.sel); // 不等
      const settled = row.hoverTerminal[t.id].after;
      row.reducedTiming[t.id] = { immediate: visual(immediate), settled, equal: visual(immediate) === settled };
    }
  }

  // 4. spinner / 进度条的结构性静态替代
  const spin = await page.evaluate(() => {
    const el = document.querySelector('[data-ds-id="btn-behave-loading"] .ds-spinner')
      || document.querySelector(".ds-spinner");
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      animationName: cs.animationName,
      animationDuration: cs.animationDuration,
      borderTopColor: cs.borderTopColor,
      borderRightColor: cs.borderRightColor,
      borderBottomColor: cs.borderBottomColor,
      borderLeftColor: cs.borderLeftColor,
      w: cs.width,
      h: cs.height,
    };
  });
  row.spinner = spin;

  // 5. 点击 / 焦点在 reduced 下仍然工作
  await page.evaluate(() => {
    window.__clicks = {};
  });
  await page.click('[data-ds-id="btn-behave-ok"]', { timeout: 5000 }).catch(() => {});
  row.clickWorks = await page.evaluate(() => window.__clicks?.ok === 1);

  /* 焦点环：必须用**真实 Tab** 触发。程序化 el.focus() 在 Chromium 里
     不匹配 :focus-visible，用它验焦点环会得到"none"的假阴性（本探针第一版就踩了）。 */
  await page.mouse.move(4, 4);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  let hit = false;
  for (let i = 0; i < 60 && !hit; i++) {
    await page.keyboard.press("Tab");
    hit = await page.evaluate(
      () => document.activeElement?.getAttribute("data-ds-id") === "btn-secondary",
    );
  }
  row.focusRing = await page.evaluate(() => {
    const el = document.querySelector('[data-ds-id="btn-secondary"]');
    const cs = getComputedStyle(el);
    return {
      ring: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
      focusVisible: el.matches(":focus-visible"),
    };
  });

  results[label] = row;
  await page.close();
}

/* ── 正交性：切动效档不得改变主题色 / 材质 / 排版 ───────────────────────── */
const ortho = {};
for (const motion of ["normal", "reduced"]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(dsUrl({ theme: "light", glass: "full", motion, view: "primitives" }));
  await page.waitForSelector('[data-ds-id="g-meta"]', { timeout: 15000 });
  ortho[motion] = await page.evaluate(
    (list) =>
      Object.fromEntries(
        list.map((o) => {
          const el = document.querySelector(o.sel);
          const cs = el ? getComputedStyle(el) : null;
          return [o.id, cs ? o.props.map((pr) => cs[pr]).join("|") : "(缺元素)"];
        }),
      ),
    ORTHO,
  );
  await page.close();
}

/* ── 断言 ───────────────────────────────────────────────────────────────── */
const cases = [];
const C = (name, ok, detail = "") =>
  cases.push({ name, status: ok ? VERDICT.PASS : VERDICT.FAIL, detail: ok ? "" : detail });

const norm = results["normal"];
const redC = results["reduced-class"];
const redO = results["reduced-os"];

/* 0. 隔离守卫（先验证探针本身没走错路径，再看后面所有结论） */
C(
  "隔离守卫：normal 格无 .reduced 类；产品内开关格有 .reduced 类；系统级格无 .reduced 类",
  norm.rootGuard.hasReducedClass === false &&
    redC.rootGuard.hasReducedClass === true &&
    redO.rootGuard.hasReducedClass === false,
  `normal=${norm.rootGuard.hasReducedClass} 开关=${redC.rootGuard.hasReducedClass} 系统=${redO.rootGuard.hasReducedClass}`,
);

/* 1. normal 有时长、reduced 归零 */
for (const t of TARGETS) {
  const n = norm.states[t.id]?.transitionDuration ?? "?";
  const c = redC.states[t.id]?.transitionDuration ?? "?";
  const o = redO.states[t.id]?.transitionDuration ?? "?";
  const nz = (v) => v !== "0s" && !/^(0s)(,\s*0s)*$/.test(v);
  C(
    `${t.id}：normal 有过渡时长（${n}），两条 reduced 路径都归零（类=${c} / 系统=${o}）`,
    nz(n) && /^0s(,\s*0s)*$/.test(c) && /^0s(,\s*0s)*$/.test(o),
    `normal=${n} 类路径=${c} 系统路径=${o}`,
  );
}

/* 2. 两条触发路径结果一致：组件动效参数逐项相同 */
const pathDiffs = [];
for (const t of TARGETS) {
  const c = redC.states[t.id];
  const o = redO.states[t.id];
  for (const k of ["transitionDuration", "animationName", "animationDuration"]) {
    if (c?.[k] !== o?.[k]) pathDiffs.push(`${t.id}.${k}: 类=${c?.[k]} vs 系统=${o?.[k]}`);
  }
}
C(
  "两条 reduced 路径（产品内开关 / 系统级设置）的动效参数逐项一致",
  pathDiffs.length === 0,
  pathDiffs.join("; "),
);

/* 3. reduced 只改时长、不改终点：normal 与两条 reduced 的 hover 终态必须完全相同 */
const endpointDiffs = [];
for (const t of TARGETS) {
  const n = norm.hoverTerminal[t.id]?.after;
  const c = redC.hoverTerminal[t.id]?.after;
  const o = redO.hoverTerminal[t.id]?.after;
  if (n !== c) endpointDiffs.push(`${t.id}: normal=${n} vs 类路径=${c}`);
  if (n !== o) endpointDiffs.push(`${t.id}: normal=${n} vs 系统路径=${o}`);
}
C(
  "reduced 只改时长不改终点：normal 与 reduced 的 hover 终态逐项相同（否则是在偷偷改设计）",
  endpointDiffs.length === 0,
  endpointDiffs.join("; "),
);

/* 4. hover 在三种条件下都真的改变了视觉（reduced ≠ 禁用） */
const noChange = TARGETS.filter((t) => !norm.hoverTerminal[t.id]?.changed).map((t) => t.id);
C(
  "hover 在 normal 下确实产生视觉变化（对照组）",
  noChange.length === 0,
  `${noChange.join(", ")} 在 normal 下 hover 无变化`,
);
const redNoChange = TARGETS.filter((t) => !redC.hoverTerminal[t.id]?.changed).map((t) => t.id);
C(
  `reduced 下 hover 仍然产生视觉变化（reduced ≠ 禁用）；实测无变化项 ${redNoChange.length} 个`,
  redNoChange.length === 0,
  redNoChange.join(", "),
);

/* 5. reduced 下状态立即到达终态（功能不依赖动画结束） */
const notImmediate = Object.entries(redC.reducedTiming || {})
  .filter(([, v]) => !v.equal)
  .map(([k]) => k);
C(
  "reduced 下状态在 0ms 内即到达终态（没有任何状态推进依赖 transitionend）",
  notImmediate.length === 0,
  `未立即到达：${notImmediate.join(", ")}`,
);

/* 6. spinner 的静态替代 */
const spinOK = (s) =>
  s &&
  s.animationName === "none" &&
  s.borderTopColor === s.borderRightColor &&
  s.borderRightColor === s.borderBottomColor &&
  s.borderBottomColor === s.borderLeftColor;
C(
  `normal 下 spinner 是转动的（animation=${norm.spinner?.animationName}）`,
  norm.spinner?.animationName === "ds-spin",
  `animationName=${norm.spinner?.animationName}`,
);
C(
  "reduced（产品内开关）下 spinner 停转且是四边同色的完整圆环（不是卡住的半圈）",
  spinOK(redC.spinner),
  JSON.stringify(redC.spinner),
);
const spinSig = (s) =>
  s ? `${s.animationName}|${s.animationDuration}|${s.borderTopColor}|${s.borderRightColor}|${s.borderBottomColor}|${s.borderLeftColor}|${s.w}|${s.h}` : "(null)";
C(
  "reduced（系统级设置）下 spinner 与产品内开关结果一致 —— 这是曾经漏掉的一侧",
  spinOK(redO.spinner) && spinSig(redO.spinner) === spinSig(redC.spinner),
  `系统级：${JSON.stringify(redO.spinner)}`,
);

/* 7. 正交性：切动效档不得改主题色 / 材质 / 排版 */
const orthoDiff = Object.keys(ortho.normal).filter((k) => ortho.normal[k] !== ortho.reduced[k]);
C(
  "正交性：切动效档不改变主题色 / 玻璃材质 / 排版（改一维不得顺手改另一维）",
  orthoDiff.length === 0,
  orthoDiff.map((k) => `${k}: normal=${ortho.normal[k]} vs reduced=${ortho.reduced[k]}`).join("; "),
);

/* 8. reduced 下点击与焦点环照旧 */
C("reduced 下点击仍然生效（动效降级不等于功能降级）", redC.clickWorks === true, "点击未生效");
C(
  `reduced 下焦点环仍然可见（${redC.focusRing?.ring}）`,
  redC.focusRing?.focusVisible === true &&
    /^solid 2px/.test(redC.focusRing.ring || "") &&
    !/rgba\(0, 0, 0, 0\)/.test(redC.focusRing.ring || ""),
  JSON.stringify(redC.focusRing),
);

p.cases.push(...cases);
p.assertAll(cases);
p.data = {
  byPath: results,
  orthogonality: ortho,
};

await browser.close();
server.close();

const out = p.write();
console.log(`\n== 05-motion-matrix 结论：${out.verdict} — ${JSON.stringify(out.counts)}`);
console.log(`   产物：${out.file}`);
