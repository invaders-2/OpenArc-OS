// D2-01 §Token Contract —— 静态契约探针（不需要浏览器）
//
// 为什么静态也要探针：D1-04B 的 bug（深色拿到浅色合成色）在源码里完全"看起来对"，
// 只有在运行时会炸。把它的**成因**（合成作用域脱节）写成静态不变量，
// 就能在改动 token 文件的那一刻拦住它，而不是等六格矩阵跑完。
//
// 全部判定基于对 CSS 文本的结构化解析，不是 grep 关键词。

import fs from "node:fs";
import path from "node:path";
import { Probe, VERDICT, ROOT, ensureDirs } from "./lib/ds.mjs";

const TOKENS = path.join(ROOT, "src/design-system/tokens.css");
const PRIM = path.join(ROOT, "src/design-system/primitives.css");
const PAGES = path.join(ROOT, "src/design-system/page-states.css");
const GALLERY = path.join(ROOT, "src/design-system/gallery.css");
const STYLES = path.join(ROOT, "src/styles.css");

const read = (p) => fs.readFileSync(p, "utf8");

/* ── 极简 CSS 解析：抽出「选择器 → 自定义属性声明」与「选择器 → 普通声明」 ── */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 返回 [{ selector, body, index }]，按出现顺序；忽略 @media 等 at-rule 的嵌套层。
 *  对 @media 块做一次展开：把内部规则也提上来，但 selector 前缀标记为 at:<cond>。 */
function parseRules(css) {
  const out = [];
  const src = stripComments(css);
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    const selector = src.slice(i, open).trim();
    // 找匹配的闭合括号
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === "{") depth += 1;
      else if (src[j] === "}") depth -= 1;
      j += 1;
    }
    const body = src.slice(open + 1, j - 1);
    if (selector.startsWith("@media")) {
      for (const r of parseRules(body)) out.push({ selector: r.selector, body: r.body, at: selector });
    } else if (selector.startsWith("@")) {
      out.push({ selector, body, at: selector, isAtRule: true });
    } else {
      out.push({ selector, body });
    }
    i = j;
  }
  return out;
}

function customProps(body) {
  const map = new Map();
  for (const m of body.matchAll(/(^|;|\{)\s*(--[a-zA-Z0-9-]+)\s*:\s*([^;}]+)/g)) {
    map.set(m[2], m[3].trim());
  }
  return map;
}

function pickRules(rules, predicate) {
  return rules.filter((r) => predicate(r));
}

const p = new Probe("01-token-contract", "D2-01 Token 静态契约");
const tokenRules = parseRules(read(TOKENS));
const primRules = parseRules(read(PRIM));
const pageRules = parseRules(read(PAGES));
const galleryRules = parseRules(read(GALLERY));
const styleRules = parseRules(read(STYLES));

const rootProps = customProps(
  pickRules(tokenRules, (r) => r.selector.split(",").map((x) => x.trim()).includes(":root"))
    .map((r) => r.body)
    .join(";"),
);
const darkProps = customProps(
  pickRules(tokenRules, (r) => r.selector.split(",").map((x) => x.trim()).includes(".dark"))
    .map((r) => r.body)
    .join(";"),
);

const cases = [];

/* ── 1. 语义色原料齐备 ─────────────────────────────────────────────────── */
const REQUIRED_RAW = [
  "text",
  "muted",
  "placeholder",
  "surface",
  "content",
  "sunken",
  "bar",
  "pill",
  "line",
  "accent",
  "on-accent",
  "focus",
  "failed",
];
const missingRaw = REQUIRED_RAW.filter((n) => !rootProps.has(`--${n}-rgb`));
cases.push({
  name: `语义色原料齐备（${REQUIRED_RAW.length} 项：${REQUIRED_RAW.join(" / ")}）`,
  status: missingRaw.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  detail: missingRaw.length ? `缺：${missingRaw.join(", ")}` : "",
});

/* ── 2. Contract T3：重定义原料的作用域必须同时重声明合成值 ────────────── */
// 哪些 token 是"主题作用域合成"（有别名、且其原料会在 .dark 被覆盖）
const ALIASED = ["text", "muted", "placeholder", "sunken", "line", "accent", "on-accent", "focus", "failed"];
const t3Violations = [];
for (const name of ALIASED) {
  const rawInRoot = rootProps.has(`--${name}-rgb`);
  const rawInDark = darkProps.has(`--${name}-rgb`);
  const aliasInRoot = rootProps.has(`--${name}`);
  const aliasInDark = darkProps.has(`--${name}`);
  if (rawInRoot && !aliasInRoot) t3Violations.push(`:root 有 --${name}-rgb 但缺 --${name}`);
  if (rawInDark && !aliasInDark) t3Violations.push(`.dark 覆盖 --${name}-rgb 但未重声明 --${name}`);
}
cases.push({
  name: "Contract T3：重定义主题原料的作用域同时重声明合成值（D1-04B bug 的静态拦截）",
  status: t3Violations.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  detail: t3Violations.join("; "),
});

/* ── 3. 随玻璃档位变化的 alpha 只能"消费点合成" ─────────────────────────
   判据：tokens.css 中任何 --x-rgb / --x-alpha 的**组合**都不得出现在自定义属性值里。
   例如 `--surface: rgb(var(--surface-rgb) / var(--surface-alpha))` 就是违规。 */
const consumed = ["surface", "content", "bar", "pill"];
const t2Violations = [];
for (const r of tokenRules) {
  for (const [k, v] of customProps(r.body)) {
    for (const n of consumed) {
      if (v.includes(`--${n}-rgb`) || v.includes(`--${n}-alpha`)) {
        t2Violations.push(`${r.selector} { ${k}: ${v} }`);
      }
    }
  }
}
cases.push({
  name: "Contract T2：随玻璃档位变化的表面 token 不在 token 层合成",
  status: t2Violations.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  detail: t2Violations.join("; "),
});

/* ── 4. token 单一权威：组件层不得**重声明 token 名** ────────────────────
   组件层允许有自己的**局部变量**（如 `.dock-item { --s: 1 }` 这种按元素缩放系数），
   但不得重声明任何 token 名 —— 否则同一个名字有两个权威，改 token 不会生效。 */
const tokenNames = new Set();
for (const r of tokenRules) for (const [k] of customProps(r.body)) tokenNames.add(k);

const declaredElsewhere = [];
const localVars = [];
for (const [file, rules] of [
  ["styles.css", styleRules],
  ["primitives.css", primRules],
  ["page-states.css", pageRules],
  ["gallery.css", galleryRules],
]) {
  for (const r of rules) {
    for (const [k, v] of customProps(r.body)) {
      if (tokenNames.has(k)) declaredElsewhere.push(`${file} ${r.selector} { ${k}: ${v} }`);
      else localVars.push(`${file} ${r.selector} { ${k}: ${v} }`);
    }
  }
}
cases.push({
  name: `token 单一权威：组件层不得重声明 token 名（共 ${tokenNames.size} 个 token 名受保护）`,
  status: declaredElsewhere.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  detail: declaredElsewhere.join("; "),
});
cases.push({
  name: `组件层局部变量（非 token 名）允许存在，仅登记（共 ${localVars.length} 处）`,
  status: VERDICT.PASS,
  detail: localVars.join("; "),
});

/* ── 5. Radius：有限级别，组件层不得出现字面 px 圆角 ───────────────────── */
const RADIUS = ["xs", "sm", "md", "lg", "xl", "window", "pill"];
const missingRadius = RADIUS.filter((n) => !rootProps.has(`--radius-${n}`));
cases.push({
  name: `Radius 刻度齐备（${RADIUS.join(" / ")}）`,
  status: missingRadius.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  detail: missingRadius.length ? `缺：${missingRadius.join(", ")}` : "",
});

const literalRadius = [];
for (const [file, rules] of [
  ["primitives.css", primRules],
  ["page-states.css", pageRules],
  ["gallery.css", galleryRules],
]) {
  for (const r of rules) {
    for (const m of r.body.matchAll(/border-radius\s*:\s*([^;}]+)/g)) {
      const v = m[1].trim();
      if (/\d+(\.\d+)?(px|rem|em)/.test(v)) literalRadius.push(`${file} ${r.selector} → ${v}`);
    }
  }
}
cases.push({
  name: "组件层 border-radius 只用 token（不得新建 17px / 19px / 23px 类 magic radius）",
  status: literalRadius.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  detail: literalRadius.join("; "),
});

/* ── 6. Spacing：4pt scale 齐备 ────────────────────────────────────────── */
const SPACE = ["1", "2", "3", "4", "5", "6", "8"];
const missingSpace = SPACE.filter((n) => !rootProps.has(`--space-${n}`));
cases.push({
  name: `Spacing 4pt scale 齐备（--space-${SPACE.join(" / --space-")}）`,
  status: missingSpace.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  detail: missingSpace.length ? `缺：${missingSpace.join(", ")}` : "",
});

/* ── 7. Typography：系统字体栈，且**品牌字体不得进系统 UI** ─────────────── */
const fontUI = rootProps.get("--font-ui") || "";
const BRAND_FONTS = ["Space Grotesk", "Inter", "Roboto", "Poppins", "Montserrat"];
const leakedFonts = BRAND_FONTS.filter((f) => fontUI.includes(f));
const fontTokens = ["--fs-display", "--fs-title", "--fs-heading", "--fs-body", "--fs-secondary", "--fs-caption", "--fs-micro", "--fs-eyebrow"];
const missingFont = fontTokens.filter((t) => !rootProps.has(t));
cases.push({
  name: "Typography：系统 UI 字体栈，品牌字体未扩散到系统 UI",
  status: leakedFonts.length === 0 && missingFont.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  detail: [
    leakedFonts.length ? `混入品牌字体：${leakedFonts.join(", ")}` : "",
    missingFont.length ? `缺：${missingFont.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; "),
});

/* ── 8. Motion：三档时长 + reduced 必须归零三档 ────────────────────────── */
const durTokens = ["--dur-quick", "--dur-standard", "--dur-slow"];
const missingDur = durTokens.filter((t) => !rootProps.has(t));
const reducedRules = pickRules(tokenRules, (r) => r.selector.split(",").map((x) => x.trim()).includes(".reduced"));
const reducedProps = customProps(reducedRules.map((r) => r.body).join(";"));
const reducedNotZeroed = durTokens.filter((t) => reducedProps.get(t) !== "0ms");
const prmRules = pickRules(tokenRules, (r) => (r.at || "").includes("prefers-reduced-motion"));
const prmProps = customProps(prmRules.map((r) => r.body).join(";"));
const prmNotZeroed = durTokens.filter((t) => prmProps.get(t) !== "0ms");
cases.push({
  name: "Motion：quick / standard / slow 三档齐备",
  status: missingDur.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  detail: missingDur.join(", "),
});
cases.push({
  name: "Motion：.reduced 与 prefers-reduced-motion 都把三档时长归零",
  status: reducedNotZeroed.length === 0 && prmNotZeroed.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  detail: [
    reducedNotZeroed.length ? `.reduced 未归零：${reducedNotZeroed.join(", ")}` : "",
    prmNotZeroed.length ? `prefers-reduced-motion 未归零：${prmNotZeroed.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; "),
});

/* ── 8b. Reduce Motion 的**结构性静态替代**必须在两条触发路径上逐条一致 ──
   背景：只把 --dur-* 归零不够。spinner 与进度条的可见性靠 animation 而非
   transition-duration；只停动画不做结构性替代，用户看到的是"卡住的半圈"
   和"永远填不满的进度条"。tokens.css 明确承诺产品内开关与系统级设置
   "走同一套结果"，所以两条路径的声明必须逐条对齐。
   媒体查询里没法加类 → 同一组声明必须写两遍 → 这里用静态断言锁住一致性，
   不靠人记。这条断言是**从真实遗漏反推**出来的（曾只写了 .reduced 一侧）。 */
function declarationsFor(rules, pred) {
  const map = new Map();
  for (const r of rules) {
    if (!pred(r)) continue;
    for (const m of r.body.matchAll(/([a-z-]+)\s*:\s*([^;}]+)/g)) {
      const key = `${r.selector.trim()}|${m[1]}`;
      map.set(key, m[2].trim().replace(/\s+/g, " "));
    }
  }
  return map;
}
/* ① 产品内开关：选择器以 .reduced 开头 */
const reducedStruct = declarationsFor(
  primRules,
  (r) => /^\.reduced\s+\S/.test(r.selector.trim()) && !r.selector.includes("*"),
);
/* ② 系统级设置：位于 prefers-reduced-motion 媒体查询块内 */
const prmStruct = declarationsFor(
  primRules,
  (r) => (r.at || "").includes("prefers-reduced-motion"),
);
/* 归一化：把 ① 的 ".reduced " 前缀去掉后应当与 ② 完全同键同值 */
const normalize = (map, stripPrefix) => {
  const out = new Map();
  for (const [k, v] of map) {
    const [sel, prop] = k.split("|");
    const s = stripPrefix ? sel.replace(/^\.reduced\s+/, "") : sel;
    out.set(`${s}|${prop}`, v);
  }
  return out;
};
const a = normalize(reducedStruct, true);
const b = normalize(prmStruct, false);
const onlyA = [...a.keys()].filter((k) => !b.has(k)).map((k) => `${k} = ${a.get(k)}`);
const onlyB = [...b.keys()].filter((k) => !a.has(k)).map((k) => `${k} = ${b.get(k)}`);
const differing = [...a.keys()]
  .filter((k) => b.has(k) && b.get(k) !== a.get(k))
  .map((k) => `${k}: 开关=${a.get(k)} vs 系统=${b.get(k)}`);
const parityBad = [...onlyA, ...onlyB, ...differing];
cases.push({
  name: `Motion：.reduced 与 prefers-reduced-motion 的结构性替代逐条一致（各 ${a.size} / ${b.size} 条声明）`,
  status: parityBad.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  detail: parityBad.join("; "),
});
// 反向：两侧都必须真的存在，防止"两边都空"这种假绿
cases.push({
  name: "Motion：两条路径的结构性替代都非空（防止两侧同为空的假一致）",
  status: a.size > 0 && b.size > 0 ? VERDICT.PASS : VERDICT.FAIL,
  detail: a.size > 0 && b.size > 0 ? "" : `开关侧 ${a.size} 条 / 系统侧 ${b.size} 条`,
});

/* ── 8c. 兜底清零（`*` 级 !important）也必须两条路径一致 ──────────────────
   只把 --dur-* 归零治不了**硬编码时长**的 transition。产品内开关靠
   `.reduced * { transition-duration: 0ms !important }` 压住它；系统级路径
   若少了这一条，同一个系统设置在两个入口下表现就不同 —— 而 tokens.css 明文
   承诺"走同一套结果"。05-motion-matrix 在运行时也直接比较两条路径的
   computed transition-duration（曾经这里是 0s vs 0s,0s,0s）。
   这条断言 = 数量与取值都对齐，避免只对齐一半。 */
const starSwitch = normalize(declarationsFor(tokenRules, (r) => r.selector.trim() === ".reduced *"), true);
const starSystem = normalize(
  declarationsFor(
    tokenRules,
    (r) => (r.at || "").includes("prefers-reduced-motion") && r.selector.trim() === "*",
  ),
  false,
);
const starOnlyA = [...starSwitch.keys()].filter((k) => !starSystem.has(k));
const starOnlyB = [...starSystem.keys()].filter((k) => !starSwitch.has(k));
const starDiff = [...starSwitch.keys()]
  .filter((k) => starSystem.has(k) && starSystem.get(k) !== starSwitch.get(k))
  .map((k) => `${k}: 开关=${starSwitch.get(k)} vs 系统=${starSystem.get(k)}`);
const starBad = [...starOnlyA, ...starOnlyB, ...starDiff];
cases.push({
  name: `Motion：兜底清零（* 级 !important）两条路径一致（各 ${starSwitch.size} / ${starSystem.size} 条）`,
  status: starBad.length === 0 && starSwitch.size > 0 ? VERDICT.PASS : VERDICT.FAIL,
  detail:
    starSwitch.size === 0
      ? "开关侧没有任何 * 级兜底规则"
      : starBad.join("; "),
});

/* ── 9. Elevation：极轻 + 两个主题都定义 ──────────────────────────────── */
const elevTokens = ["--elevation-0", "--elevation-1", "--elevation-2", "--elevation-3", "--elevation-4", "--elevation-5"];
const missingElev = elevTokens.filter((t) => !rootProps.has(t));
const darkElev = elevTokens.filter((t) => t !== "--elevation-0").filter((t) => !darkProps.has(t));
cases.push({
  name: `Elevation：${elevTokens.length} 档齐备，且深色逐档重定义`,
  status: missingElev.length === 0 && darkElev.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  detail: [missingElev.length ? `缺：${missingElev.join(", ")}` : "", darkElev.length ? `深色未定义：${darkElev.join(", ")}` : ""]
    .filter(Boolean)
    .join("; "),
});
// 极轻：不得出现重投影（模糊半径 > 80px 或 alpha > 0.5）
const heavy = [];
for (const [k, v] of rootProps) {
  if (!k.startsWith("--elevation") && k !== "--shadow") continue;
  for (const m of v.matchAll(/(\d+)px\s+(\d+)px\s+([\d.]+)px\s+rgb\(([^)]*)\)/g)) {
    const blur = Number(m[2]);
    const alpha = Number((m[4].split("/")[1] || "1").trim());
    if (blur > 80) heavy.push(`${k} blur=${blur}px`);
    if (alpha > 0.5 && !v.includes("inset")) heavy.push(`${k} alpha=${alpha}`);
  }
}
cases.push({
  name: "Elevation：保持极轻（无 >80px 模糊、无 >0.5 的非 inset 投影）",
  status: heavy.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  detail: heavy.join("; "),
});

/* ── 10. Glass：三档语义齐备，且 REDUCED 仍是"减面积"而不是"减半径" ───── */
const solidRules = pickRules(tokenRules, (r) => r.selector.includes('data-glass="solid"') && !r.selector.includes("*"));
const solidProps = customProps(solidRules.map((r) => r.body).join(";"));
const redRules = pickRules(tokenRules, (r) => r.selector.includes('data-glass="reduced"'));
const redProps = customProps(redRules.map((r) => r.body).join(";"));
const redLarge = redProps.get("--glass-filter-large");

cases.push({
  name: "Glass SOLID：覆盖 surface / content / bar 三组原料（唯一允许改通道的档位）",
  status: ["--surface-rgb", "--content-rgb", "--bar-rgb"].every((t) => solidProps.has(t)) ? VERDICT.PASS : VERDICT.FAIL,
  detail: ["--surface-rgb", "--content-rgb", "--bar-rgb"].filter((t) => !solidProps.has(t)).join(", "),
});
cases.push({
  name: 'Glass REDUCED：以"大面积转实色"为机制（--glass-filter-large 必须存在且为 none）',
  status: redLarge === "none" ? VERDICT.PASS : VERDICT.FAIL,
  detail: redLarge === "none" ? "" : `实际值：${redLarge ?? "(未定义)"} —— REDUCED 不得回退成"只调小半径"`,
});
cases.push({
  name: "Glass REDUCED：开关 token 不得泄漏到 FULL 基线（:root 不得定义 --glass-filter-large）",
  status: rootProps.has("--glass-filter-large") ? VERDICT.FAIL : VERDICT.PASS,
  detail: rootProps.get("--glass-filter-large") ?? "",
});

// 禁止用全局规则实现 reduced（D1-04C 明确禁止）
const redGlobal = tokenRules.concat(styleRules).filter((r) =>
  /data-glass="reduced"\s*\*/.test(r.selector),
);
cases.push({
  name: 'Glass REDUCED：不得用 `.desktop[data-glass="reduced"] *` 这类全局规则',
  status: redGlobal.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  detail: redGlobal.map((r) => r.selector).join("; "),
});

/* ── 10b. 大面积白名单：引用 --glass-filter-large 的选择器必须逐个显式登记 ──
   这是一条**从真实 bug 反推**出来的不变量：
   REDUCED 的性能杠杆是"减少被 backdrop-filter 覆盖的面积"，机制是让大面积表面
   转实色。判据是"引用 --glass-filter-large 的选择器 = 大面积白名单"（见 tokens.css 注释）。
   我之前写 primitives 时把通用小 Surface 与 Toast 也挂了进去，结果这两个小元素
   在 REDUCED 下失去玻璃 —— 而它们本不属于大面积家族。
   白名单必须显式列出：新增一条就要求改这里，从而强迫作者回答"它真的是大面积吗"。 */
const LARGE_WHITELIST = [
  ".window", // 窗口外壳（D1-04 既有）
  ".ai-panel", // AI 侧栏面板（D1-04 既有）
  ".search-panel", // 全局搜索面板（D1-04 既有）
  ".ds-surface--large", // D2-01 显式选择加入的大面积 Surface
];
const largeRefs = [];
for (const [file, rules] of [
  ["tokens.css", tokenRules],
  ["primitives.css", primRules],
  ["page-states.css", pageRules],
  ["gallery.css", galleryRules],
  ["styles.css", styleRules],
]) {
  for (const r of rules) {
    // 只看**值**里的引用（注释已被 stripComments 去掉），不看声明 --glass-filter-large 本身
    for (const m of r.body.matchAll(/(-webkit-)?backdrop-filter\s*:\s*([^;}]+)/g)) {
      if (!m[2].includes("--glass-filter-large")) continue;
      const unknown = !LARGE_WHITELIST.includes(r.selector);
      largeRefs.push({ file, sel: r.selector, unknown });
    }
  }
}
const largeUnlisted = largeRefs.filter((x) => x.unknown);
cases.push({
  name: `Glass REDUCED：大面积白名单受控（${LARGE_WHITELIST.join(" / ")}）`,
  status: largeUnlisted.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  detail: largeUnlisted.length
    ? `未登记的大面积引用：${largeUnlisted.map((x) => `${x.file} ${x.sel}`).join("; ")}`
    : `已登记引用 ${largeRefs.length} 处`,
});
// 反向断言：白名单里每一项都必须真的在用这个开关（防止白名单腐烂成一串死名字）
const largeMissing = LARGE_WHITELIST.filter(
  (sel) => !largeRefs.some((x) => x.sel === sel),
);
cases.push({
  name: "Glass REDUCED：大面积白名单无死条目（每条都真的引用了开关）",
  status: largeMissing.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  detail: largeMissing.length ? `白名单里已无人引用：${largeMissing.join(", ")}` : "",
});

/* ── 11. 组件层不得出现颜色字面值（十六进制 / 裸 rgb 通道） ─────────────── */
const colorLiterals = [];
for (const [file, rules] of [
  ["primitives.css", primRules],
  ["page-states.css", pageRules],
  // gallery.css 也纳入：它是"回归面"，回归面自己违反规范会让规范失去说服力
  ["gallery.css", galleryRules],
]) {
  for (const r of rules) {
    for (const m of r.body.matchAll(/(#[0-9a-fA-F]{3,8}\b|rgba?\(\s*[\d.]+)/g)) {
      colorLiterals.push(`${file} ${r.selector} → ${m[1]}`);
    }
  }
}
cases.push({
  name: "组件层（含 gallery）不得出现颜色字面值，通道必须来自 token",
  status: colorLiterals.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  detail: colorLiterals.slice(0, 8).join("; "),
});

/* ── 11b. 页面 / 桌面基底色必须是 token，不得写死 ──────────────────────────
   补这两个 token 之前，#f5f5f7 与 #000 同时出现在 tokens.css 与 gallery.css，
   同一个语义两个权威。基底色不参与玻璃叠加，所以它是"原料"不是"合成值"。 */
cases.push({
  name: "基底色走 token：--base-rgb / --base-dark-rgb 齐备，且各消费点不再写字面值",
  status:
    rootProps.has("--base-rgb") && rootProps.has("--base-dark-rgb") && colorLiterals.length === 0
      ? VERDICT.PASS
      : VERDICT.FAIL,
  detail: [
    rootProps.has("--base-rgb") ? "" : "缺 --base-rgb",
    rootProps.has("--base-dark-rgb") ? "" : "缺 --base-dark-rgb",
    colorLiterals.length ? `仍有字面值 ${colorLiterals.length} 处` : "",
  ]
    .filter(Boolean)
    .join("; "),
});

/* ── 12. 禁止发丝线：不得用 border 作为分层手段 ────────────────────────── */
const hairline = [];
for (const [file, rules] of [
  ["primitives.css", primRules],
  ["page-states.css", pageRules],
]) {
  for (const r of rules) {
    for (const m of r.body.matchAll(/border\s*:\s*([^;}]+)/g)) {
      const v = m[1].trim();
      if (/^(1px|0\.5px|thin)\b/.test(v) && !v.includes("transparent") && !v.includes("0")) {
        hairline.push(`${file} ${r.selector} → ${v}`);
      }
    }
  }
}
cases.push({
  name: "禁止发丝线：组件层不得用 1px border 作为分层手段（改用 inset shadow / alpha）",
  status: hairline.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  detail: hairline.join("; "),
});

/* ── 13. 1px inset 描边必须真的只有 1px（防止悄悄变成 2px 边框） ────────── */
const insetBorders = [];
for (const r of primRules) {
  for (const m of r.body.matchAll(/box-shadow\s*:\s*inset\s+0\s+0\s+0\s+(\d+(?:\.\d+)?)px/g)) {
    insetBorders.push({ sel: r.selector, w: Number(m[1]) });
  }
}
const wrongWidth = insetBorders.filter((b) => b.w !== 1);
cases.push({
  name: `inset 描边宽度必须为 1px（共 ${insetBorders.length} 处）`,
  status: wrongWidth.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  detail: wrongWidth.map((b) => `${b.sel} → ${b.w}px`).join("; "),
});

p.cases.push(...cases);
p.note(`token 文件：tokens.css ${tokenRules.length} 条规则 / primitives.css ${primRules.length} 条`);
p.note(`导出 token 数：:root ${rootProps.size} 个，.dark 覆盖 ${darkProps.size} 个`);
p.assertAll(cases);

const r = p.write();
console.log(`\n== 01-token-contract 结论：${r.verdict} — ${JSON.stringify(r.counts)}`);
console.log(`   产物：${r.file}`);
