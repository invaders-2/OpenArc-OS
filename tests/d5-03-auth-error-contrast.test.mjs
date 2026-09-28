/**
 * D5-03 第六批 · `.auth-error` 对比度静态契约（不需要浏览器 / 真机）。
 *
 * 背景（第五批真机实测，runId 20260928T070627Z-27eb，16/17，唯一 FAIL）：
 *   浅色主题 + 初始化向导的玻璃卡（full 档）浮在默认深色壁纸上时，`.auth-error` 的
 *   合成背景实测 rgb(181,181,181)，文字 --failed = rgb(215,0,21) → **2.62:1** < 4.5:1
 *   （12px / 400 = 普通文本，DESIGN_SYSTEM.md:248）。同一 --failed 落在浅色**窗口面**上
 *   实测 5.19:1 → 失败来自"错误行自己没有底"，不是文字色本身。
 *
 * 修法：只给这一条规则加一个**不透明内容底**（通道 = --content-rgb，alpha = 1），
 * 让合成背景与壁纸、玻璃档解耦，只随主题变。本文件把修法锁成四组不变量，
 * 防止后来者用"改全局状态色 / 把 --failed 换掉 / 把底做回半透明"绕过：
 *
 *   ① .auth-error 必须有不透明底：通道来自 token，alpha 必须字面为 1；不得引用
 *      --content-alpha / --surface-alpha（full 档分别是 0.94 / 0.5，会重新被壁纸拖低）；
 *      不得出现任何字面色值；不得有 transition / animation（MOTION_SYSTEM.md:145）。
 *   ② 全局状态色一个字节都不许动：--failed-rgb 浅 #d70015 / 深 #ff453a，--failed-alpha = 1；
 *      styles.css 不得重声明任何 status 语义 token（DESIGN_SYSTEM §2「组件层不得复制私有 token」）。
 *   ③ 该底 × --failed 在浅 / 深两套主题、full / reduced / solid 三档材质下都 >= 4.5:1
 *      （数值由 tokens.css 的真实 token 值现算，不是抄常量）。
 *   ④ 三个入口仍挂 role="alert"（文案与语义未动），`:empty` 仍不渲染。
 *
 * 判定基于对 CSS 文本的结构化解析（与 experiments/d2-01/01-token-contract.mjs 同口径），
 * 不是 grep 关键词。真机合成对比度的量测由 W43 按交付清单跑，本文件不代替它。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = new URL("..", import.meta.url);
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const read = (rel) => fs.readFileSync(new URL(rel, ROOT), "utf8");
const STYLES = read("src/styles.css");
const TOKENS = read("src/design-system/tokens.css");

/* ── 极简 CSS 解析（与 d2-01 的 token 契约探针同一手法）──────────────────── */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
function parseRules(css) {
  const out = [];
  const src = stripComments(css);
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    const selector = src.slice(i, open).trim();
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
const customProps = (body) => {
  const map = new Map();
  for (const m of body.matchAll(/(^|;|\{)\s*(--[a-zA-Z0-9-]+)\s*:\s*([^;}]+)/g)) map.set(m[2], m[3].trim());
  return map;
};
const decls = (body) => {
  const map = new Map();
  for (const m of stripComments(body).matchAll(/(?:^|;)\s*([a-z-]+)\s*:\s*([^;}]+)/g)) map.set(m[1], m[2].trim().replace(/\s+/g, " "));
  return map;
};
const selList = (rule) => rule.selector.split(",").map((s) => s.trim());

const styleRules = parseRules(STYLES);
const tokenRules = parseRules(TOKENS);

/** 从 tokens.css 里按"作用域"取一条原料 token 的真实值；取不到就 FAIL（token 结构变了必须重新核对）。 */
function pickToken(name, scope) {
  for (const r of tokenRules) {
    if (!selList(r).some(scope)) continue;
    const props = customProps(r.body);
    if (props.has(name)) return { value: props.get(name), selector: r.selector.trim() };
  }
  return null;
}
const rgbChannels = (value, name) => {
  const m = String(value).match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/);
  assert.notEqual(m, null, name + " 必须是三个十进制通道，实际：" + JSON.stringify(value));
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
/** WCAG 2.x 相对亮度与对比度 —— 与真机门禁（experiments/d5-03/auth-error-visual.mjs）同一公式。 */
const lum = (rgb) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
};
const contrast = (a, b) => {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/* ── 被锁的那条规则 ──────────────────────────────────────────────────────── */
const authErrorRules = styleRules.filter((r) => selList(r).includes(".auth-error"));
const authError = authErrorRules[0];
const authErrorDecls = authError ? decls(authError.body) : new Map();

test("C1 · .auth-error 只有一条规则，且仍用 --failed 当文字色（不改全局状态色、不写字面色值）", () => {
  assert.equal(authErrorRules.length, 1, "  .auth-error 只允许一条规则，实际：" + authErrorRules.map((r) => r.selector).join(" | "));
  assert.equal(authErrorDecls.get("color"), "var(--failed)", "文字色仍是既有的 --failed（第五批实测 5.19:1 的那一档），实际：" + authErrorDecls.get("color"));
  assert.equal(authErrorDecls.get("font-size"), "var(--fs-caption)", "字号不变（12px = 普通文本门槛的依据）");
  assert.equal(authErrorDecls.has("font-weight"), false, "不新声明字重：仍是继承的 400（改了就不再是普通文本口径）");

  const literal = authError.body.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*[\d.]+/g);
  assert.equal(literal, null, "组件层不得出现字面色值，通道必须来自 token： " + JSON.stringify(literal));
  assert.equal((authError.body.match(/--failed/g) || []).length, 1, "这条规则只能引用 --failed 一次（文字色），不许自己改红");
});

test("C2 · 必须有不透明内容底：通道来自 token，alpha 字面为 1，且不得随玻璃档变透明", () => {
  const bg = authErrorDecls.get("background") || authErrorDecls.get("background-color");
  assert.equal(typeof bg, "string", "必须给该行自己的底（第五批失败的直接成因就是没有底）");
  const m = bg.match(/^rgb\(\s*var\(--([a-z0-9-]+)-rgb\)\s*\/\s*([\d.]+)\s*\)$/);
  assert.notEqual(m, null, "底必须是 rgb(var(--<语义色>-rgb) / <alpha>) 形态，实际：" + JSON.stringify(bg));

  const [, channel, alpha] = m;
  assert.equal(
    ["content", "surface"].includes(channel),
    true,
    "通道只能用既有的 surface / content 语义族，不发明颜色：" + channel,
  );
  assert.equal(Number(alpha), 1, "底必须完全不透明（alpha = 1）：半透明底会重新与玻璃卡 + 壁纸合成，第五批的 2.62:1 就是这么来的");
  assert.equal(/--(content|surface)-alpha/.test(bg), false, "--content-alpha 在 full 档是 0.94（深色 0.6），引用它等于把壁纸又拉回算式里");

  // 圆角 / 内边距复用既有 token，且不得新增动效
  assert.match(authErrorDecls.get("border-radius") || "", /^var\(--radius-[a-z]+\)$/, "圆角走既有 --radius-* 刻度");
  const padding = authErrorDecls.get("padding") || "";
  assert.equal(padding.split(/\s+/).every((v) => /^var\(--space-\d\)$/.test(v)), true, "内边距只走既有 --space-* 刻度，实际：" + JSON.stringify(padding));
  for (const banned of ["transition", "animation", "backdrop-filter"]) {
    assert.equal(authErrorDecls.has(banned), false, "不得给该行加 " + banned + "（MOTION_SYSTEM.md:145：减少动态效果下即时呈现）");
  }
  const emptyRule = styleRules.find((r) => selList(r).includes(".auth-error:empty"));
  assert.notEqual(emptyRule, undefined, ":empty 不渲染的行为必须保留");
  assert.equal(decls(emptyRule.body).get("display"), "none", ":empty 仍是 display:none");
});

test("C3 · 全局状态色未动：--failed 浅 #d70015 / 深 #ff453a，且 styles.css 不重声明任何状态 token", () => {
  const lightFailed = pickToken("--failed-rgb", (s) => s === ":root");
  const darkFailed = pickToken("--failed-rgb", (s) => s === ".dark");
  assert.notEqual(lightFailed, null, ":root 必须有 --failed-rgb");
  assert.notEqual(darkFailed, null, ".dark 必须重声明 --failed-rgb");
  assert.deepEqual(rgbChannels(lightFailed.value, "--failed-rgb(:root)"), [215, 0, 21], "浅色 status.failed 仍是 #d70015（DESIGN_SYSTEM §3）");
  assert.deepEqual(rgbChannels(darkFailed.value, "--failed-rgb(.dark)"), [255, 69, 58], "深色 status.failed 仍是 #ff453a");
  assert.equal((pickToken("--failed-alpha", (s) => s === ":root") || {}).value, "1", "--failed-alpha 仍是 1");

  // styles.css 是组件层：一个 status 语义 token 都不许在这层被重声明（DESIGN_SYSTEM §2）
  const redeclared = [];
  for (const r of styleRules) {
    for (const [k, v] of customProps(r.body)) {
      if (/^--(failed|text|muted|accent|focus|line|sunken)/.test(k)) redeclared.push(r.selector + " { " + k + ": " + v + " }");
    }
  }
  assert.deepEqual(redeclared, [], "组件层不得重声明全局语义 token：" + redeclared.join("; "));
  for (const uniq of new Set(styleRules.map((r) => r.selector))) {
    assert.equal(/^\.dark\b|^:root\b/.test(uniq) && /auth-error/.test(uniq), false, "不得给 .auth-error 加主题分支（浅深只靠 token 映射）：" + uniq);
  }
});

test("C4 · 静态对比度：底 × --failed 在浅 / 深 × 三档材质下都 >= 4.5:1（真 token 值现算）", () => {
  const lightFailed = rgbChannels(pickToken("--failed-rgb", (s) => s === ":root").value, "light failed");
  const darkFailed = rgbChannels(pickToken("--failed-rgb", (s) => s === ".dark").value, "dark failed");
  const bg = authErrorDecls.get("background") || "";
  assert.match(bg, /^rgb\(var\(--[a-z0-9-]+-rgb\) \/ 1\)$/, "底必须先满足 C2（通道来自 token + alpha = 1），否则这张表算的不是真实合成值：" + JSON.stringify(bg));
  const channel = bg.match(/var\(--([a-z0-9-]+)-rgb\)/)[1];
  const token = "--" + channel + "-rgb";

  // full / reduced 档：底在消费点写死 alpha 1，所以合成值 = 通道值本身（与 --content-alpha 无关）
  const combos = [
    { key: "浅色 full（向导卡浮在深色壁纸上）", scope: (s) => s === ":root", failed: lightFailed },
    { key: "浅色 reduced（减少透明度）", scope: (s) => s === ":root", failed: lightFailed },
    { key: "浅色 solid（不透明档）", scope: (s) => s === ".opaque" || s === '[data-glass="solid"]', failed: lightFailed },
    { key: "深色 full", scope: (s) => s === ".dark", failed: darkFailed },
    { key: "深色 reduced（减少透明度）", scope: (s) => s === ".dark", failed: darkFailed },
    { key: "深色 solid（不透明档）", scope: (s) => s === ".dark.opaque" || s === '.dark[data-glass="solid"]', failed: darkFailed },
  ];
  const rows = [];
  for (const c of combos) {
    const t = pickToken(token, c.scope);
    assert.notEqual(t, null, c.key + "：tokens.css 里找不到 " + token + "（token 结构变了，必须重新核对这张表）");
    const ch = rgbChannels(t.value, token + "@" + t.selector);
    const ratio = contrast(ch, c.failed);
    rows.push({ key: c.key, scope: t.selector, bg: ch.join(","), fg: c.failed.join(","), ratio });
    assert.equal(ratio >= 4.5, true, c.key + " 对比度 " + ratio.toFixed(2) + ":1 < 4.5:1（底 " + ch.join(",") + " / 字 " + c.failed.join(",") + "）");
  }
  console.log("   静态对比度（底 = " + token + " @ alpha 1，字 = --failed）：");
  for (const r of rows) console.log("     · " + r.key.padEnd(30) + " 底 rgb(" + r.bg + ") / 字 rgb(" + r.fg + ") → " + r.ratio.toFixed(2) + ":1");

  // 反向：修前的实测合成背景必须**不达标**，否则说明这条断言锁错了对象（也证明修法针对的是真成因）
  const before = contrast([181, 181, 181], lightFailed);
  console.log("     · 修前实测（第五批 runId 27eb）       底 rgb(181,181,181) / 字 rgb(" + lightFailed.join(",") + ") → " + before.toFixed(2) + ":1  ← 不达标");
  assert.equal(before < 4.5, true, "第五批实测值应当是失败态：2.62:1");
});

test("C5 · 三个入口仍挂 role=\"alert\"（文案与语义未动），挂 .auth-error 的元素没有新增", () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx$/.test(e.name)) files.push(p);
    }
  };
  walk(SRC);
  const hits = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/<p className="auth-error"[^>]*>/g)) hits.push({ file: path.basename(f), tag: m[0] });
  }
  assert.equal(hits.length, 3, "挂 .auth-error 的只有既有的三个入口（登录/初始化、头像选择、设置），实际：" + JSON.stringify(hits.map((h) => h.file)));
  for (const h of hits) {
    assert.equal(/role="alert"/.test(h.tag), true, h.file + " 的错误行必须仍是 role=\"alert\"：" + h.tag);
  }
  const auth = read("src/identity/AuthScreens.tsx");
  assert.equal(auth.includes('className="auth-error" role="alert" data-d3-id="auth-error"'), true, "登录 / 初始化向导的错误行原样保留");
  assert.equal(auth.includes("errorText(error.code, error.detail)"), true, "文案仍走集中文案表，本批没碰");
  assert.equal(read("src/identity/AvatarPicker.tsx").includes("{localError}"), true, "头像选择的错误文案原样保留");
  const main = read("src/main.tsx");
  assert.equal(main.includes('className="auth-error" role="alert" data-d3-id="settings-error"'), true, "设置页的错误行原样保留");
  assert.equal(main.includes("errorText(identity.error.code, identity.error.detail)"), true, "设置页文案仍走集中文案表");
});
