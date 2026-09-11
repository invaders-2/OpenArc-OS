// D2-01 §Component States —— 组件状态矩阵探针
//
// 为什么不能只看源码：`:hover` / `:active` / `:focus-visible` 是**运行时**伪类，
// 源码里写没写、写了是否被更高优先级规则盖掉，只有真的把鼠标移上去、真的按下去、
// 真的 Tab 过去才知道。D1-04C 修掉的 `.search-result:hover` 回归就是这么漏过去的。
//
// 状态清单按组件族**分别定义**（详见 docs/decisions/D2-01-design-system.md §组件状态）：
//   按钮族：default / hover / active / focus-visible / disabled
//   输入族：empty / hover / filled / error / readonly / focus-visible / disabled
// 给文本输入硬塞一个 :active（"按下"）不是真实交互，属虚假完备 —— 本探针不这么干。
//
// 三个刻意的判据设计：
//  1. focus-visible 必须用**真实 Tab 键**触发。程序化 el.focus() 在 Chromium 里
//     不保证匹配 :focus-visible，用它去验焦点环等于自己骗自己。
//     Tab 只做**一次前向遍历**顺路记录所有目标，不做 N×tabbables 次。
//  2. 输入类指纹打在**外层 box**上（输入框自身透明），但 empty 与 filled 的差别
//     **不要求 box 有差异** —— 那两态本来就该由内容承载（placeholder → value）。
//     硬给 filled 加一条描边去满足测试，是"为测试而设计"。这里改为验证
//     placeholder 用 --muted 且对合成背景达 AA，这才是用户真正看到的东西。
//  3. 禁用是否"真的禁用"必须做**行为学**验证：强制点击，看计数是否被加上去。
//     视觉变灰但还能点，是这一条要抓的东西。

import { Probe, VERDICT, dsUrl, serveDist, launch, contrastRatio } from "./lib/ds.mjs";

/* 视觉指纹：只取**能表达状态**的属性，不取无关属性（否则"有差异"会退化成噪声） */
const FP = `(sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const cs = getComputedStyle(el);
  return {
    bg: cs.backgroundColor,
    color: cs.color,
    shadow: cs.boxShadow,
    opacity: cs.opacity,
    outline: [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.outlineOffset].join(" "),
  };
}`;
const sig = (f) => (f ? `${f.bg}|${f.color}|${f.shadow}|${f.opacity}|${f.outline}` : "(null)");
const fp = (page, sel) => page.evaluate(new Function("sel", `return (${FP})(sel)`), sel);

/* 页面内工具：有效背景合成（与 02 同口径） */
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
  return true;
})()
`;

/* 按钮族：需要 default / hover / active / focus-visible / disabled */
const BUTTONS = [
  { id: "button-secondary", sel: '[data-ds-id="btn-secondary"]' },
  { id: "button-primary", sel: '[data-ds-id="btn-primary"]' },
  { id: "button-ghost", sel: '[data-ds-id="btn-ghost"]' },
  { id: "button-danger", sel: '[data-ds-id="btn-danger"]' },
  { id: "icon-button", sel: '[data-ds-id="ib-ghost"]' },
];

/* 输入族：sel 用于 Tab 命中，fpS 用于取指纹（表面在 box / 槽上，不在 <input> 上） */
const INPUTS = [
  {
    id: "text-field",
    sel: '[data-ds-id="tf-empty"] input',
    fpS: '[data-ds-id="tf-empty"] .ds-field__box',
    hoverOn: '[data-ds-id="tf-empty"] .ds-field__box',
    emptyInput: '[data-ds-id="tf-empty"] input',
    filledInput: '[data-ds-id="tf-filled"] input',
    error: '[data-ds-id="tf-error"] .ds-field__box',
    readonly: '[data-ds-id="tf-readonly"] .ds-field__box',
  },
  {
    id: "search-field",
    sel: '[data-ds-id="sf-states"] input[type="search"]',
    fpS: '[data-ds-id="sf-states"] .ds-search',
    hoverOn: '[data-ds-id="sf-states"] .ds-search',
    emptyInput: '[data-ds-id="sf-states"] input[type="search"]',
    filledInput: null,
    error: null,
    readonly: null,
  },
];

/* 禁用态：原生控件与复合控件都要验 */
const DISABLED = [
  { id: "btn:native-disabled", sel: '[data-ds-id="btn-disabled-secondary"]', ref: '[data-ds-id="btn-secondary"]' },
  { id: "iconbtn:native-disabled", sel: '[data-ds-id="ib-disabled"]', ref: '[data-ds-id="ib-ghost"]' },
  { id: "textfield:native-disabled", sel: '[data-ds-id="tf-disabled"] input', ref: '[data-ds-id="tf-empty"] input' },
];

const p = new Probe("03-component-states", "D2-01 组件状态矩阵");
const server = await serveDist();
const browser = await launch();

const rows = [];

for (const theme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  await page.goto(dsUrl({ theme, glass: "full", motion: "normal", view: "primitives" }));
  await page.waitForSelector('[data-ds-id="btn-secondary"]', { timeout: 15000 });
  await page.evaluate(COMPOSE);

  const row = { theme, errors: errs.length, buttons: {}, inputs: {}, facts: {}, disabled: {}, focus: {} };

  /* ── 1. 按钮族 default / hover / active ─────────────────────────────── */
  for (const t of BUTTONS) {
    const st = {};
    await page.mouse.move(4, 4);
    await page.waitForTimeout(30);
    st.default = await fp(page, t.sel);
    await page.hover(t.sel);
    await page.waitForTimeout(40);
    st.hover = await fp(page, t.sel);
    await page.mouse.down();
    await page.waitForTimeout(40);
    st.active = await fp(page, t.sel);
    await page.mouse.up();
    await page.mouse.move(4, 4);
    row.buttons[t.id] = st;
  }

  /* ── 2. 输入族 empty / hover / error / readonly ─────────────────────── */
  for (const t of INPUTS) {
    const st = {};
    await page.mouse.move(4, 4);
    await page.waitForTimeout(30);
    st.empty = await fp(page, t.fpS);
    await page.hover(t.hoverOn);
    await page.waitForTimeout(40);
    st.hover = await fp(page, t.fpS);
    await page.mouse.move(4, 4);
    await page.waitForTimeout(30);
    st.error = t.error ? await fp(page, t.error) : null;
    st.readonly = t.readonly ? await fp(page, t.readonly) : null;
    row.inputs[t.id] = st;

    /* empty 与 filled 的**真实**差别：内容、placeholder 颜色、placeholder 可读性 */
    row.facts[t.id] = await page.evaluate(
      (o) => {
        const el = (s) => (s ? document.querySelector(s) : null);
        const ein = el(o.emptyInput);
        const fin = el(o.filledInput);
        const ph = ein ? getComputedStyle(ein, "::placeholder") : null;
        const bg = ein ? window.__effBg(ein) : null;
        const fg = ph ? ph.color : null;
        return {
          emptyValue: ein ? ein.value : null,
          filledValue: fin ? fin.value : null,
          emptyColor: ph ? ph.color : null,
          valueColor: ein ? getComputedStyle(ein).color : null,
          placeholderFg: fg,
          placeholderBg: bg ? `rgb(${bg.r},${bg.g},${bg.b})` : null,
          placeholderSize: ph ? ph.fontSize : null,
        };
      },
      {
        emptyInput: INPUTS.find((x) => x.id === t.id).emptyInput,
        filledInput: INPUTS.find((x) => x.id === t.id).filledInput,
      },
    );
  }

  /* ── 3. focus-visible：单次前向 Tab 遍历 ─────────────────────────────── */
  const focusTargets = [
    ...BUTTONS.map((t) => ({ id: t.id, sel: t.sel, ring: t.sel })),
    ...INPUTS.map((t) => ({ id: t.id, sel: t.sel, ring: t.fpS })),
  ];
  await page.mouse.move(4, 4);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  let tabs = 0;
  for (; tabs < 260 && Object.keys(row.focus).length < focusTargets.length; tabs++) {
    await page.keyboard.press("Tab");
    const hit = await page.evaluate((list) => {
      const a = document.activeElement;
      if (!a) return null;
      for (const t of list) {
        const el = document.querySelector(t.sel);
        if (el && el === a) {
          const rs = getComputedStyle(document.querySelector(t.ring) || el);
          return {
            id: t.id,
            focusVisible: el.matches(":focus-visible"),
            outlineStyle: rs.outlineStyle,
            outlineWidth: rs.outlineWidth,
            outlineColor: rs.outlineColor,
          };
        }
      }
      return null;
    }, focusTargets);
    if (hit) row.focus[hit.id] = hit;
  }
  row.tabPresses = tabs;

  /* ── 4. disabled 态：语义 + 视觉 ────────────────────────────────────── */
  for (const t of DISABLED) {
    const d = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        bg: cs.backgroundColor,
        color: cs.color,
        opacity: cs.opacity,
        cursor: cs.cursor,
        shadow: cs.boxShadow,
        disabledProp: el.disabled === true,
        ariaDisabled: el.getAttribute("aria-disabled"),
      };
    }, t.sel);
    const ref = await fp(page, t.ref);
    row.disabled[t.id] = { ...d, ref };
  }

  /* ── 5. 行为学：loading 抑制点击、disabled 真的不触发 ─────────────────── */
  await page.evaluate(() => {
    window.__clicks = {};
  });
  // 强制点击：绕过 Playwright 的"元素不可交互"保护，测产品行为而不是工具保护
  for (const s of ["btn-behave-loading", "btn-behave-disabled", "btn-behave-ok"]) {
    await page.click(`[data-ds-id="${s}"]`, { force: true, timeout: 5000 }).catch(() => {});
  }
  row.clicks = await page.evaluate(() => window.__clicks);

  /* ── 6. 原生 disabled 是否真的不可聚焦 ───────────────────────────────
     判据不能用 el.tabIndex >= 0 —— 对 <button disabled>，tabIndex 的 IDL 属性
     仍返回 0（它是内容属性的反射），不能用来判断可聚焦性。
     唯一可靠的判据是**真的试着聚焦一次**，看焦点有没有落上去。 */
  row.focusableWhenDisabled = await page.evaluate(() => {
    const ids = ["btn-behave-disabled", "btn-disabled-secondary", "ib-disabled", "tf-disabled"];
    const bad = [];
    for (const id of ids) {
      const el = document.querySelector(`[data-ds-id="${id}"]`);
      if (!el) continue;
      el.focus();
      if (document.activeElement === el) bad.push(id);
      if (document.activeElement) document.activeElement.blur();
    }
    return bad;
  });

  rows.push(row);
  await page.close();
}

/* ── 断言 ───────────────────────────────────────────────────────────────── */
const cases = [];

for (const r of rows) {
  cases.push({
    name: `${r.theme}：状态矩阵页面渲染无错误`,
    status: r.errors === 0 ? VERDICT.PASS : VERDICT.FAIL,
    detail: r.errors ? `${r.errors} 个页面错误` : "",
  });

  /* 1. 按钮三态可区分 */
  for (const t of BUTTONS) {
    const st = r.buttons[t.id];
    const problems = [];
    if (!st?.default) problems.push("元素未命中");
    else {
      if (sig(st.hover) === sig(st.default)) problems.push("hover 与 default 无差异");
      if (sig(st.active) === sig(st.hover)) problems.push("active 与 hover 无差异");
    }
    cases.push({
      name: `${r.theme}/${t.id}：default / hover / active 三态视觉可区分`,
      status: problems.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
      detail: problems.join("; "),
    });
  }

  /* 2. 输入族可区分（box 承载 empty/hover/error/readonly；内容承载 filled） */
  for (const t of INPUTS) {
    const st = r.inputs[t.id];
    const problems = [];
    if (!st?.empty) problems.push("元素未命中");
    else {
      if (sig(st.hover) === sig(st.empty)) problems.push("hover 与 empty 无差异");
      if (t.error && st.error && sig(st.error) === sig(st.empty)) problems.push("error 与 empty 视觉无差异");
      if (t.readonly && st.readonly && sig(st.readonly) === sig(st.empty)) problems.push("readonly 与 empty 视觉无差异");
    }
    cases.push({
      name: `${r.theme}/${t.id}：box 状态 empty / hover / error / readonly 视觉可区分`,
      status: problems.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
      detail: problems.join("; "),
    });
  }

  /* 3. empty / filled 的信息差 + placeholder 可读性 */
  for (const t of INPUTS) {
    const f = r.facts[t.id];
    if (!f) {
      cases.push({ name: `${r.theme}/${t.id}：empty/filled 事实可采`, status: VERDICT.FAIL, detail: "" });
      continue;
    }
    const problems = [];
    if (f.emptyValue !== "") problems.push(`empty 态 value="${f.emptyValue}"（应为空）`);
    if (t.filledInput && f.filledValue === "") problems.push("filled 态 value 为空");
    // placeholder 必须与真实值文字**视觉上不同**，否则用户分不清"提示"和"已填内容"
    if (f.placeholderFg === f.valueColor) problems.push("placeholder 与已填文字同色（提示与内容无法区分）");
    cases.push({
      name: `${r.theme}/${t.id}：empty/filled 的差别由内容承载，且 placeholder 与正文有色差`,
      status: problems.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
      detail: problems.join("; "),
    });
    // placeholder 对比度（最容易被漏掉的可读性项）
    if (f.placeholderFg && f.placeholderBg) {
      const ratio = contrastRatio(f.placeholderFg, f.placeholderBg);
      cases.push({
        name: `${r.theme}/${t.id}：placeholder 对合成背景达 WCAG AA（${ratio.toFixed(2)}:1）`,
        status: ratio >= 4.5 ? VERDICT.PASS : VERDICT.FAIL,
        detail: ratio >= 4.5 ? "" : `仅 ${ratio.toFixed(2)}:1（<4.5）`,
      });
    }
  }

  /* 4. focus-visible 可达 + 焦点环可见 */
  for (const t of [...BUTTONS, ...INPUTS]) {
    const f = r.focus[t.id];
    if (!f) {
      cases.push({
        name: `${r.theme}/${t.id}：Tab 可达且 :focus-visible 成立`,
        status: VERDICT.FAIL,
        detail: `前向 Tab ${r.tabPresses} 次未到达（键盘不可达）`,
      });
      continue;
    }
    const ringOK =
      f.outlineStyle === "solid" &&
      parseFloat(f.outlineWidth) >= 2 &&
      f.outlineColor !== "rgba(0, 0, 0, 0)";
    cases.push({
      name: `${r.theme}/${t.id}：Tab 可达 + :focus-visible 命中 + 焦点环可见（${f.outlineWidth} ${f.outlineStyle}）`,
      status: f.focusVisible && ringOK ? VERDICT.PASS : VERDICT.FAIL,
      detail: !f.focusVisible
        ? "Tab 到达但 :focus-visible 未命中"
        : !ringOK
          ? `焦点环不可见：${f.outlineWidth} ${f.outlineStyle} ${f.outlineColor}`
          : "",
    });
  }

  /* 5. disabled：语义 + 行为 + 视觉三件事都成立 */
  for (const t of DISABLED) {
    const d = r.disabled[t.id];
    if (!d) {
      cases.push({ name: `${r.theme}/${t.id}：元素存在`, status: VERDICT.FAIL, detail: "未命中" });
      continue;
    }
    const problems = [];
    // 原生控件：disabled 属性即权威（aria-disabled 冗余）；复合控件才必须补后者
    if (!d.disabledProp && d.ariaDisabled !== "true") problems.push("既无 disabled 属性也无 aria-disabled");
    if (d.cursor !== "not-allowed") problems.push(`cursor=${d.cursor}（期望 not-allowed）`);
    if (d.ref && `${d.ref.bg}|${d.ref.color}|${d.ref.opacity}` === `${d.bg}|${d.color}|${d.opacity}`) {
      problems.push("禁用态与启用态视觉无差异");
    }
    cases.push({
      name: `${r.theme}/${t.id}：禁用语义 + cursor + 视觉降级齐备`,
      status: problems.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
      detail: problems.join("; "),
    });
  }

  /* 6. 行为学：只有 ok 那一个允许计数 */
  const c = r.clicks || {};
  cases.push({
    name: `${r.theme}/行为学：loading 抑制点击、disabled 不触发、正常按钮可点（实测 ${JSON.stringify(c)}）`,
    status: !c.loading && !c.disabled && c.ok === 1 ? VERDICT.PASS : VERDICT.FAIL,
    detail: !c.loading && !c.disabled && c.ok === 1 ? "" : `期望 {ok:1}，叠加计数说明"视觉禁用但仍可点"`,
  });

  /* 7. 原生 disabled 不可聚焦 */
  cases.push({
    name: `${r.theme}：原生 disabled 元素拒绝获得焦点`,
    status: r.focusableWhenDisabled.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
    detail: r.focusableWhenDisabled.length ? `仍可聚焦：${r.focusableWhenDisabled.join(", ")}` : "",
  });
}

/* 8. 跨主题一致性：防止"只调了浅色" */
for (const t of [...BUTTONS, ...INPUTS]) {
  const missing = rows.filter((r) => !r.focus[t.id]).map((r) => r.theme);
  const stateBad = rows
    .filter((r) => {
      const st = r.buttons[t.id];
      return st && (!st.default || sig(st.hover) === sig(st.default) || sig(st.active) === sig(st.hover));
    })
    .map((r) => r.theme);
  cases.push({
    name: `${t.id}：浅色与深色状态完备一致（无"只做了浅色"）`,
    status: missing.length === 0 && stateBad.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
    detail: [
      missing.length ? `键盘不可达：${missing.join(", ")}` : "",
      stateBad.length ? `状态不全：${stateBad.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; "),
  });
}

p.cases.push(...cases);
p.note(`Tab 遍历次数：${rows.map((r) => `${r.theme}=${r.tabPresses}`).join(" / ")}`);
p.assertAll(cases);
p.data = {
  perTheme: rows.map((r) => ({
    theme: r.theme,
    tabPresses: r.tabPresses,
    focus: r.focus,
    clicks: r.clicks,
    facts: r.facts,
    disabled: r.disabled,
    buttons: Object.fromEntries(
      Object.entries(r.buttons).map(([k, v]) => [
        k,
        { default: sig(v.default), hover: sig(v.hover), active: sig(v.active) },
      ]),
    ),
    inputs: Object.fromEntries(
      Object.entries(r.inputs).map(([k, v]) => [
        k,
        { empty: sig(v.empty), hover: sig(v.hover), error: sig(v.error), readonly: sig(v.readonly) },
      ]),
    ),
  })),
};

await browser.close();
server.close();

const out = p.write();
console.log(`\n== 03-component-states 结论：${out.verdict} — ${JSON.stringify(out.counts)}`);
console.log(`   产物：${out.file}`);
