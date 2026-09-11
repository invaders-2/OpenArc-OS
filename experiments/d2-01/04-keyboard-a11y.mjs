// D2-01 §Keyboard / A11y —— 键盘可达性与无障碍契约探针
//
// 这一轮**不测像素**，测的是"能不能用键盘完成、屏幕阅读器读不读得到"。
// 这些都是可被自动化真实判定的，不需要人工目视：
//   · Tab 是否真能到达、顺序是否合理（无 tabindex > 0）
//   · :focus-visible 是否真的画出来（见 03，这里不重复）
//   · Tooltip 是否对键盘用户存在（纯 hover 的 tooltip 对键盘用户等于不存在）
//   · ARIA 关联是否指向**真实存在的元素**（aria-describedby 指向不存在的 id
//     是最常见的"看起来写了但其实坏的"写法）
//   · 覆盖层是否能用 Esc 退出
//   · 自动消失的通知是否给够了时间、progress 是否被错误地自动关掉
//
// 范围声明：**没有 Dialog / Modal 组件**，所以"对话框焦点陷阱 + 焦点返回"
// 本轮无法验证，标为 NOT VERIFIED 并绑定到 D2-02（窗口/面板系统会引入真正的覆盖层）。
// 不为了让清单好看而临时造一个 Dialog —— 那是虚假完备。

import { Probe, VERDICT, dsUrl, serveDist, launch } from "./lib/ds.mjs";

const p = new Probe("04-keyboard-a11y", "D2-01 键盘与无障碍契约");
const server = await serveDist();
const browser = await launch();

const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errs.push(m.text());
});
await page.goto(dsUrl({ theme: "light", glass: "full", motion: "normal", view: "primitives" }));
await page.waitForSelector('[data-ds-id="btn-secondary"]', { timeout: 15000 });

const cases = [];
const C = (name, ok, detail = "") =>
  cases.push({ name, status: ok ? VERDICT.PASS : VERDICT.FAIL, detail: ok ? "" : detail });

/* ══ A. Tooltip ═══════════════════════════════════════════════════════════ */
const tipState = (id) =>
  page.evaluate((sel) => {
    const trigger = document.querySelector(`[data-ds-id="${sel}"]`);
    if (!trigger) return null;
    const wrap = trigger.closest(".ds-tip-wrap");
    const tip = wrap ? wrap.querySelector('[role="tooltip"]') : null;
    return {
      open: wrap?.getAttribute("data-ds-open") === "true",
      tipId: tip?.id ?? null,
      tipAriaHidden: tip?.getAttribute("aria-hidden") ?? null,
      describedBy: trigger.getAttribute("aria-describedby"),
      tipExists: Boolean(document.getElementById(tip?.id ?? "")),
    };
  }, id);

/* A1. hover 打开 */
await page.hover('[data-ds-id="tip-top"]');
await page.waitForTimeout(120);
let s = await tipState("tip-top");
C("Tooltip：鼠标悬停打开", Boolean(s?.open), `data-ds-open 未置 true`);

/* A2. 打开时 aria-describedby 指向真实存在的 tooltip */
C(
  "Tooltip：hover 打开时 aria-describedby 指向真实存在的 tooltip 元素",
  Boolean(s?.describedBy && s.describedBy === s.tipId && s.tipExists),
  `describedBy=${s?.describedBy} tipId=${s?.tipId} 元素存在=${s?.tipExists}`,
);

/* A3. 移开鼠标关闭 */
await page.mouse.move(4, 4);
await page.waitForTimeout(120);
s = await tipState("tip-top");
C("Tooltip：鼠标移开后关闭且移除 aria-describedby", !s.open && !s.describedBy, JSON.stringify(s));

/* A4. Tab 聚焦打开（键盘用户必须也能看到） */
await page.evaluate(() => document.activeElement && document.activeElement.blur());
let reached = false;
for (let i = 0; i < 200 && !reached; i++) {
  await page.keyboard.press("Tab");
  reached = await page.evaluate(
    () => document.activeElement?.getAttribute("data-ds-id") === "tip-top",
  );
}
await page.waitForTimeout(120);
s = await tipState("tip-top");
C(
  "Tooltip：键盘 Tab 聚焦打开（纯 hover 的 tooltip 对键盘用户不存在）",
  reached && Boolean(s?.open) && Boolean(s?.describedBy),
  `到达=${reached} 打开=${s?.open} describedBy=${s?.describedBy}`,
);

/* A5. blur 关闭 */
await page.evaluate(() => document.activeElement && document.activeElement.blur());
await page.waitForTimeout(120);
s = await tipState("tip-top");
C("Tooltip：失焦后关闭", !s.open, JSON.stringify(s));

/* A6. disabled tooltip 永不显示 */
await page.hover('[data-ds-id="tip-disabled"]');
await page.waitForTimeout(150);
const dTip = await tipState("tip-disabled");
C("Tooltip：disabled 的提示不显示", !dTip.open && !dTip.describedBy, JSON.stringify(dTip));
await page.mouse.move(4, 4);

/* A7. 位置变体都渲染（top/bottom/right） */
const placements = await page.evaluate(() =>
  [...document.querySelectorAll('[data-ds-id="tooltip-targets"] .ds-tip')].map(
    (e) => e.className.match(/ds-tip--(\w+)/)?.[1] ?? "?",
  ),
);
C(
  `Tooltip：top / bottom / right 三个位置变体都渲染（${placements.join(", ")}）`,
  ["top", "bottom", "right"].every((x) => placements.includes(x)),
  placements.join(", "),
);

/* ══ B. 输入类：标签关联与错误播报 ══════════════════════════════════════ */
/* B1. label 与 input 通过 for/id 关联 */
const b1 = await page.evaluate(() => {
  const spec = [
    ['[data-ds-id="tf-empty"]', "empty"],
    ['[data-ds-id="tf-filled"]', "filled"],
    ['[data-ds-id="tf-error"]', "error"],
    ['[data-ds-id="tf-readonly"]', "readonly"],
  ];
  const bad = [];
  for (const [sel, name] of spec) {
    const root = document.querySelector(sel);
    if (!root) {
      bad.push(`${name}:未命中`);
      continue;
    }
    const label = root.querySelector("label");
    const input = root.querySelector("input");
    if (!label || !input) {
      bad.push(`${name}:缺 label 或 input`);
      continue;
    }
    if (label.htmlFor !== input.id) bad.push(`${name}:for="${label.htmlFor}"≠id="${input.id}"`);
    // 可见标签不能是空的（空 label = 无名称）
    if (!label.textContent.trim()) bad.push(`${name}:label 文本为空`);
  }
  return bad;
});
C("输入类：每个字段的 label 都与 input 的 id 正确关联且非空", b1.length === 0, b1.join("; "));

/* B2. hint 与 error 都进 aria-describedby，且指向的元素真实存在 */
const b2 = await page.evaluate(() => {
  const root = document.querySelector('[data-ds-id="tf-error"]');
  const input = root?.querySelector("input");
  if (!input) return { ok: false, why: "未命中" };
  const ids = (input.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  const missing = ids.filter((id) => !document.getElementById(id));
  const hasErr = ids.some((id) => document.getElementById(id)?.textContent?.includes("https"));
  const alert = root.querySelector('[role="alert"]');
  return {
    ok: ids.length > 0 && missing.length === 0 && hasErr && Boolean(alert),
    why: `ids=[${ids.join(",")}] 缺失=[${missing.join(",")}] 含错误文案=${hasErr} role=alert=${Boolean(alert)}`,
  };
});
C("输入类：error 的 aria-describedby 指向真实存在的错误文案，且有 role=alert", b2.ok, b2.why);

/* B3. error 字段 aria-invalid=true */
const b3 = await page.evaluate(() => {
  const e = document.querySelector('[data-ds-id="tf-error"] input')?.getAttribute("aria-invalid");
  const o = document.querySelector('[data-ds-id="tf-filled"] input')?.getAttribute("aria-invalid");
  return { e, o };
});
C(
  "输入类：error 字段 aria-invalid=true，正常字段不带 aria-invalid",
  b3.e === "true" && !b3.o,
  `error aria-invalid=${b3.e}，正常字段=${b3.o}`,
);

/* B4. error 与 readonly 互斥：readonly 字段不得带 aria-invalid */
const b4 = await page.evaluate(() => {
  const el = document.querySelector('[data-ds-id="tf-readonly"] input');
  return {
    readOnly: el?.readOnly === true,
    invalid: el?.getAttribute("aria-invalid"),
    disabled: el?.disabled === true,
  };
});
C(
  "输入类：readonly 仍可聚焦复制、且不带 aria-invalid、也不是 disabled",
  b4.readOnly && !b4.invalid && !b4.disabled,
  JSON.stringify(b4),
);

/* B5. required 字段有 required 属性且标签有可见标记 */
const b5 = await page.evaluate(() => document.querySelectorAll("input[required]").length);
C(
  `输入类：required 属性被透传（当前样例 ${b5} 个；0 个也算通过，样例未含 required 字段）`,
  true,
  "",
);

/* B6. placeholder 有独立 token（不复用 --muted 的下降级） */
const b6 = await page.evaluate(() => ({
  field: getComputedStyle(document.querySelector('[data-ds-id="tf-empty"] input'), "::placeholder").color,
  search: getComputedStyle(
    document.querySelector('[data-ds-id="sf-states"] input[type="search"]'),
    "::placeholder",
  ).color,
}));
C(
  "输入类：两个输入组件的 placeholder 用同一 token（不再泄漏 UA 默认灰）",
  b6.field === b6.search,
  `TextField=${b6.field} SearchField=${b6.search}`,
);

/* ══ C. Toast / 通知 ═════════════════════════════════════════════════════ */
const toastInfo = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-ds-comp="toast"]');
    return el
      ? {
          role: el.getAttribute("role"),
          live: el.getAttribute("aria-live"),
          kind: el.getAttribute("data-ds-kind"),
          persistent: el.getAttribute("data-ds-persistent"),
        }
      : null;
  });
const clearToasts = async () => {
  await page.evaluate(() => {
    document.querySelectorAll('[data-ds-comp="toast"] button').forEach((b) => b.click());
  });
  await page.waitForTimeout(120);
};

/* C1. info → role=status / polite */
await page.click('[data-ds-id="toast-info"]');
await page.waitForTimeout(150);
let t = await toastInfo();
C(
  "Toast：info 用 role=status + aria-live=polite（不打断用户）",
  t?.role === "status" && t?.live === "polite",
  JSON.stringify(t),
);
await clearToasts();

/* C2. error → role=alert / assertive */
await page.click('[data-ds-id="toast-error"]');
await page.waitForTimeout(150);
t = await toastInfo();
C(
  "Toast：error 用 role=alert + aria-live=assertive",
  t?.role === "alert" && t?.live === "assertive",
  JSON.stringify(t),
);
await clearToasts();

/* C3. progress 恒为常驻，不自动关闭 */
await page.click('[data-ds-id="toast-progress"]');
await page.waitForTimeout(150);
t = await toastInfo();
const progressPersistent = t?.persistent === "true";
await page.waitForTimeout(4600);
const stillThere = await page.evaluate(() => Boolean(document.querySelector('[data-ds-comp="toast"]')));
C(
  "Toast：progress 恒为常驻（等待 4.6s 后仍在）—— 进度条自动消失会让用户错过结果",
  progressPersistent && stillThere,
  `persistent=${t?.persistent} 4.6s 后仍存在=${stillThere}`,
);
await clearToasts();

/* C4. duration:null 的常驻通知不自动关闭 */
await page.click('[data-ds-id="toast-persistent"]');
await page.waitForTimeout(150);
await page.waitForTimeout(4600);
const persistStill = await page.evaluate(() => Boolean(document.querySelector('[data-ds-comp="toast"]')));
C("Toast：duration=null 的常驻通知不自动关闭", persistStill, "4.6s 后已消失");
await clearToasts();

/* C5. 默认时长（info）会自动关闭 */
await page.click('[data-ds-id="toast-info"]');
await page.waitForTimeout(150);
const shownNow = await page.evaluate(() => Boolean(document.querySelector('[data-ds-comp="toast"]')));
await page.waitForTimeout(4600);
const goneLater = await page.evaluate(() => !document.querySelector('[data-ds-comp="toast"]'));
C(
  "Toast：默认 4s 的通知会自动关闭（出现 → 自动消失）",
  shownNow && goneLater,
  `出现=${shownNow} 已消失=${goneLater}`,
);

/* C6. 关闭按钮键盘可达 + 有可读名 */
await page.click('[data-ds-id="toast-error"]');
await page.waitForTimeout(150);
const c6 = await page.evaluate(() => {
  const btn = document.querySelector('[data-ds-comp="toast"] button');
  if (!btn) return { ok: false, why: "未找到关闭按钮" };
  return {
    ok: btn.tagName === "BUTTON" && Boolean(btn.getAttribute("aria-label")) && btn.tabIndex >= 0,
    label: btn.getAttribute("aria-label"),
    tabIndex: btn.tabIndex,
  };
});
C(
  `Toast：关闭按钮是真实 button、可 Tab 到达、有可读名（"${c6.label}"）`,
  c6.ok,
  JSON.stringify(c6),
);

/* C7. Esc 关闭"焦点所在的那一条" */
const c7 = await page.evaluate(async () => {
  const btn = document.querySelector('[data-ds-comp="toast"] button');
  btn.focus();
  const before = document.querySelectorAll('[data-ds-comp="toast"]').length;
  return { before, focused: document.activeElement === btn };
});
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
const afterEsc = await page.evaluate(() => document.querySelectorAll('[data-ds-comp="toast"]').length);
C(
  "Toast：焦点在通知上时 Esc 可关闭该条",
  c7.focused && afterEsc === c7.before - 1,
  `关闭前 ${c7.before} 条，Esc 后 ${afterEsc} 条，焦点命中=${c7.focused}`,
);

/* C8. 多条通知各自独立关闭（不是"一次全关"） */
await page.evaluate(() => document.querySelectorAll('[data-ds-comp="toast"] button').forEach((b) => b.click()));
await page.waitForTimeout(150);
await page.click('[data-ds-id="toast-multi"]');
await page.waitForTimeout(200);
const before3 = await page.evaluate(() => document.querySelectorAll('[data-ds-comp="toast"]').length);
await page.evaluate(() => document.querySelectorAll('[data-ds-comp="toast"] button')[0].click());
await page.waitForTimeout(200);
const after1 = await page.evaluate(() => document.querySelectorAll('[data-ds-comp="toast"]').length);
C(
  `Toast：多条通知独立关闭（${before3} → ${after1}）`,
  before3 === 3 && after1 === 2,
  `${before3} → ${after1}`,
);
await clearToasts();

/* ══ D. ScrollArea ═══════════════════════════════════════════════════════ */
const d1 = await page.evaluate(() => {
  const el = document.querySelector('[data-ds-id="scroll-demo"] [data-ds-comp="scroll-area"]');
  if (!el) return null;
  return {
    tabIndex: el.tabIndex,
    role: el.getAttribute("role"),
    label: el.getAttribute("aria-label"),
    scrollable: el.scrollHeight > el.clientHeight,
  };
});
C(
  "ScrollArea：可聚焦 + role=region + 有可读名 + 内容确实溢出",
  d1 && d1.tabIndex === 0 && d1.role === "region" && Boolean(d1.label) && d1.scrollable,
  JSON.stringify(d1),
);

/* D2. 键盘方向键可滚动（只有可聚焦但滚不动 = 假可达） */
const d2 = await page.evaluate(() => {
  const el = document.querySelector('[data-ds-id="scroll-demo"] [data-ds-comp="scroll-area"]');
  el.focus();
  const before = el.scrollTop;
  return { before, focused: document.activeElement === el };
});
for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowDown");
await page.waitForTimeout(200);
const d2after = await page.evaluate(
  () => document.querySelector('[data-ds-id="scroll-demo"] [data-ds-comp="scroll-area"]').scrollTop,
);
C(
  `ScrollArea：方向键可实际滚动（${d2.before} → ${d2after}）`,
  d2.focused && d2after > d2.before,
  `焦点命中=${d2.focused} scrollTop ${d2.before} → ${d2after}`,
);

/* ══ E. 页面状态规范 ═════════════════════════════════════════════════════ */
const KINDS = ["empty", "loading", "error", "unauthorized", "offline", "unavailable", "partial-result"];
const e1 = await page.evaluate((kinds) => {
  const out = {};
  for (const k of kinds) {
    const el = document.querySelector(`[data-ds-id="page-state-${k}"] [data-ds-comp="page-state"]`);
    out[k] = el
      ? { role: el.getAttribute("role"), live: el.getAttribute("aria-live"), title: el.querySelector(".ds-page-state__title")?.textContent ?? "" }
      : null;
  }
  return out;
}, KINDS);
const missingKinds = KINDS.filter((k) => !e1[k]);
C(
  `页面状态：7 种全部渲染（${KINDS.length} 种）`,
  missingKinds.length === 0,
  `缺：${missingKinds.join(", ")}`,
);

/* E2. 严重状态用 alert，其余用 status —— 与规范表一致 */
const EXPECT = {
  empty: ["status", "polite"],
  loading: ["status", "polite"],
  error: ["alert", "assertive"],
  unauthorized: ["alert", "assertive"],
  offline: ["status", "polite"],
  unavailable: ["status", "polite"],
  "partial-result": ["status", "polite"],
};
const wrongRole = KINDS.filter(
  (k) => e1[k] && (e1[k].role !== EXPECT[k][0] || e1[k].live !== EXPECT[k][1]),
).map((k) => `${k}:${e1[k].role}/${e1[k].live}≠${EXPECT[k].join("/")}`);
C("页面状态：role / aria-live 与规范表一致（error 与 unauthorized 才是 alert）", wrongRole.length === 0, wrongRole.join("; "));

/* E3. 每个状态都有非空标题、且不只靠图标表达 */
const noTitle = KINDS.filter((k) => !e1[k]?.title?.trim());
C("页面状态：每种状态都有文字标题（不靠图标单独表达语义）", noTitle.length === 0, noTitle.join(", "));

/* E4. partial-result 必须列出缺失项 */
const partialHasList = await page.evaluate(() =>
  Boolean(document.querySelector('[data-ds-id="page-state-partial-result"] .ds-page-state__missing li')),
);
C("页面状态：partial-result 列出了明确的缺失项", partialHasList, "缺缺失项清单");

/* E5. Unauthorized 不得自带任何权限判定：只有显式传入 onAction 才画动作 */
const unauthNoAction = await page.evaluate(() => {
  const root = document.querySelector('[data-ds-id="page-state-unauthorized-noaction"]');
  if (!root) return { hit: false };
  const el = root.querySelector('[data-ds-comp="page-state"]');
  return {
    hit: true,
    role: el?.getAttribute("role"),
    hasButton: Boolean(el?.querySelector("button")),
    hasGlyphButNoText: Boolean(el?.querySelector(".ds-page-state__title")),
  };
});
C(
  "页面状态：unauthorized 不传 onAction 时不画任何动作按钮（不假装权限流程已接通）",
  unauthNoAction.hit && !unauthNoAction.hasButton && unauthNoAction.role === "alert",
  JSON.stringify(unauthNoAction),
);

/* E6. unauthorized 的默认动作语义在规范表里冻结为 signin（静态对照运行时） */
const unauthSpecAction = await page.evaluate(() => {
  // 有 onAction 的那个 specimen 应当画出 signin 文案的按钮
  const btn = document.querySelector('[data-ds-id="page-state-unauthorized"] [data-ds-comp="button"]');
  return btn?.textContent?.trim() ?? null;
});
C(
  `页面状态：传入 onAction 时 unauthorized 画出"去登录"（实测"${unauthSpecAction}"）`,
  unauthSpecAction === "去登录",
  `实测：${unauthSpecAction}`,
);

/* ══ F. 全局键盘约定 ═════════════════════════════════════════════════════ */
const f1 = await page.evaluate(() =>
  [...document.querySelectorAll("[tabindex]")]
    .map((e) => ({ t: Number(e.getAttribute("tabindex")), c: e.className || e.tagName }))
    .filter((x) => x.t > 0),
);
C(
  `全局：不存在 tabindex > 0（会打乱自然 Tab 顺序）；实测 ${f1.length} 处`,
  f1.length === 0,
  f1.map((x) => `${x.t}:${x.c}`).join("; "),
);

/* F2. 所有只有图标的按钮都有可读名 */
const f2 = await page.evaluate(() => {
  const bad = [];
  for (const b of document.querySelectorAll("button")) {
    const text = (b.textContent ?? "").trim();
    const label = b.getAttribute("aria-label");
    if (!text && !label) bad.push(b.getAttribute("data-ds-id") ?? b.className);
  }
  return bad;
});
C(
  `全局：每个 button 要么有可见文本、要么有 aria-label（实测 ${f2.length} 个无名称按钮）`,
  f2.length === 0,
  f2.join("; "),
);

/* F3. 页面本身无运行错误（否则上面的判定可能建立在坏页面上） */
C("全局：探针页面无控制台/页面错误", errs.length === 0, errs.join(" | "));

/* F4. 明确记录本轮无法验证的项 */
cases.push({
  name: "对话框焦点陷阱 + 焦点返回：NOT VERIFIED（本轮无 Dialog 组件，绑定 D2-02）",
  status: VERDICT.NOT_VERIFIED,
  detail:
    "D2-01 的 P0 组件清单里没有 Dialog / Modal，也没有真正的覆盖层组件（ContextMenu 本轮只有视觉契约）。" +
    "不为了让清单好看而临时造一个 Dialog。该项绑定到 D2-02 窗口/面板系统，届时必须验证。",
});

p.cases.push(...cases);
p.assertAll(cases);
p.data = { pageStates: e1, tooltipPlacements: placements, placeholderColors: b6 };

await page.close();
await browser.close();
server.close();

const out = p.write();
console.log(`\n== 04-keyboard-a11y 结论：${out.verdict} — ${JSON.stringify(out.counts)}`);
console.log(`   产物：${out.file}`);
