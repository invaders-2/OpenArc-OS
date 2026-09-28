/**
 * D5-03 第六批 · .auth-error 不透明内容底的**真机渲染与对比度矩阵**（含布局 / 焦点 / 动效）。
 *
 * 由 auth-error-visual.mjs 以 require 载入并在 V7 之后调用，共用同一个 runId 目录。
 * 全部真机：真实 electron .（隔离 userData）+ 真实产品 UI；主题 / 玻璃档 / 壁纸都通过
 * **真实设置面板**切换（不是注入 class，也不是直接写 localStorage）。
 *
 * 段：
 *   V8  8+2 格矩阵（主题 {浅,深} × 玻璃档 {full, reduced} × 壁纸 {默认深色, 浅色} + solid×2）
 *       —— 每格两个真实面：初始化向导错误行 + 系统设置错误行；记录 mode 像素 / modeShare / 静态预期
 *   V9  登录页错误行（账号或密码不正确 / 第 9 次限流 尝试过于频繁）—— 第五批从未量过对比度
 *   V10 布局：错误行 ≥1 行高、消失后不留空洞、.auth-actions 按钮在卡内且与错误行不相交、
 *       100/125/150/200% 缩放 + ≥120 字长文案不横向溢出 / 不压按钮
 *   V11 焦点（DS-A05）：Tab 到「确认密码」/「创建管理员」/设置页「保存」，2px 环 + 2px 间隔，
 *       错误行出现前后各一次，焦点环矩形（外扩 4px）与错误行矩形不相交
 *   V12 减少动态效果（MS:145/177）：normal 与 reduced 下该行都 animationName=none、transitionDuration=0s，
 *       连续帧序列核对即时出现、无淡入 / 无位移
 *
 * 边界：不连真实第三方、不发用户数据、不改产品代码、不写库；查询只读；缩放用 CDP 设备指标模拟
 * （产品无缩放 UI，真实入口不存在，如实记 notVerified 说明）。
 */
"use strict";

/* ── 矩阵定义 ─────────────────────────────────────────────────────────────
   壁纸 id 取自产品内置壁纸：theme-dark = 深色主题色（默认），theme-light = 浅色主题色。
   玻璃档取自控制中心 / 设置「材质」分段控件：full 完整玻璃 / reduced 降低材质 / solid 实色。 */
const CELLS = [
  { id: "light-full-darkwp", theme: "light", glass: "full", wallpaper: "theme-dark", rowRgb: "255,255,255", covered: "第五批 light-02（向导）/ light-04（设置）同配置" },
  { id: "light-full-lightwp", theme: "light", glass: "full", wallpaper: "theme-light", rowRgb: "255,255,255", covered: "第五批未覆盖" },
  { id: "light-reduced-darkwp", theme: "light", glass: "reduced", wallpaper: "theme-dark", rowRgb: "255,255,255", covered: "第五批完全未覆盖（浅色 × reduced）" },
  { id: "light-solid-darkwp", theme: "light", glass: "solid", wallpaper: "theme-dark", rowRgb: "255,255,255", covered: "补充格（实色档）" },
  { id: "dark-full-darkwp", theme: "dark", glass: "full", wallpaper: "theme-dark", rowRgb: "23,23,23", covered: "第五批 dark-02（向导）同配置" },
  { id: "dark-full-lightwp", theme: "dark", glass: "full", wallpaper: "theme-light", rowRgb: "23,23,23", covered: "第五批未覆盖" },
  { id: "dark-reduced-darkwp", theme: "dark", glass: "reduced", wallpaper: "theme-dark", rowRgb: "23,23,23", covered: "第五批 dark-reduced-02（设置）同配置" },
  { id: "dark-reduced-lightwp", theme: "dark", glass: "reduced", wallpaper: "theme-light", rowRgb: "23,23,23", covered: "第五批未覆盖" },
  { id: "dark-solid-darkwp", theme: "dark", glass: "solid", wallpaper: "theme-dark", rowRgb: "14,14,14", covered: "补充格（实色档；dark[data-glass=solid] 的 --content-rgb 是 14 14 14）" },
  { id: "light-reduced-lightwp", theme: "light", glass: "reduced", wallpaper: "theme-light", rowRgb: "255,255,255", covered: "第五批完全未覆盖（浅色 × reduced）；排在最后，登录面 V9 也落在这一格" },
];

const THRESHOLD = 4.5;
const LOCK_BG = { light: "rgb(255,255,255)", dark: "rgb(23,23,23)" };

/* ── 纯函数 ───────────────────────────────────────────────────────────── */
const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
const lum = (r, g, b) => 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
const parseRgb = (s) => { const m = String(s).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
const wcag = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const channelTriplet = (s) => { const m = String(s).trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/); return m ? m[1] + "," + m[2] + "," + m[3] : null; };
const rectsIntersect = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const outset = (r, d) => r ? { left: r.left - d, top: r.top - d, right: r.right + d, bottom: r.bottom + d, width: r.width + 2 * d, height: r.height + 2 * d } : null;
const round = (v, n = 2) => (typeof v === "number" && Number.isFinite(v) ? Number(v.toFixed(n)) : v);
const short = (r) => (r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null);

/* ── 主入口 ───────────────────────────────────────────────────────────── */
async function runMatrix(ctx) {
  const { js, sleep, waitFor, record, note, notVerified, step, VIS, measureContrast, windowShot, clipShot } = ctx;
  const fs = require("node:fs");
  const path = require("node:path");
  /* page 指针随时可能因为重连而更换对象（见主脚本 rebindPage），所以一律走访问器。 */
  const pg = () => ctx.pageNow();
  const byId = (id) => "[data-d3-id=" + JSON.stringify(id) + "]";

  /** 元素几何 + 计算样式（矩阵每格都要用）。 */
  const probe = (sel) => js([
    "const el = document.querySelector(" + JSON.stringify(sel) + ");",
    "if (!el) return null;",
    "const cs = getComputedStyle(el); const r = el.getBoundingClientRect();",
    "return { text: (el.textContent || '').trim(), color: cs.color, backgroundColor: cs.backgroundColor, fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, borderRadius: cs.borderRadius, padding: cs.padding, marginTop: cs.marginTop, marginBottom: cs.marginBottom, display: cs.display, transitionProperty: cs.transitionProperty, transitionDuration: cs.transitionDuration, transitionDelay: cs.transitionDelay, animationName: cs.animationName, outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle, outlineOffset: cs.outlineOffset, outlineColor: cs.outlineColor, focusVisible: el.matches(':focus-visible'), durQuick: cs.getPropertyValue('--dur-quick').trim(), contentRgb: cs.getPropertyValue('--content-rgb').trim(), contentAlpha: cs.getPropertyValue('--content-alpha').trim(), failed: cs.getPropertyValue('--failed').trim(), fsCaption: cs.getPropertyValue('--fs-caption').trim(), rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }, scrollW: el.scrollWidth, clientW: el.clientWidth };",
  ].join("\n"));
  const envState = () => js("const d = document.querySelector('.desktop'); return { dark: !!d && d.classList.contains('dark'), reduced: !!d && d.classList.contains('reduced'), glass: d ? d.getAttribute('data-glass') : null, wallpaper: d ? d.getAttribute('data-wallpaper') : null, gate: d ? d.getAttribute('data-identity-gate') : null, innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: devicePixelRatio, docScrollW: document.documentElement.scrollWidth, themeLs: localStorage.getItem('oa-theme'), glassLs: localStorage.getItem('oa-glass'), wallpaperLs: localStorage.getItem('oa-wallpaper') };");
  const activeInfo = () => js("const el = document.activeElement; if (!el) return null; const cs = getComputedStyle(el); const bg = cs.backgroundColor; const r = el.getBoundingClientRect(); return { tag: el.tagName, id: el.getAttribute('data-d3-id'), cls: el.className, focusVisible: el.matches(':focus-visible'), outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle, outlineOffset: cs.outlineOffset, outlineColor: cs.outlineColor, backgroundColor: bg, boxShadow: cs.boxShadow, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } };");

  /** 真实设置面板：切换「材质」分段控件。 */
  async function setGlass(mode) {
    const label = { full: "完整玻璃", reduced: "降低材质", solid: "实色" }[mode];
    const read = () => js("const d = document.querySelector('.desktop'); return d ? d.getAttribute('data-glass') : null;");
    if ((await read()) === mode) return { changed: false, ok: true };
    const up = await ctx.openSettings();
    const clicked = up ? await js("const w = document.querySelector('[data-settings-active]')?.closest('.window'); if (!w) return 'missing'; const g = w.querySelector('[aria-label=\"材质\"]'); if (!g) return 'no-group'; const b = Array.from(g.querySelectorAll('button')).find(function (x) { return (x.textContent || '').trim() === " + JSON.stringify(label) + "; }); if (!b) return 'no-button'; b.click(); return 'ok';") : "settings-missing";
    const ok = await waitFor(async () => (await read()) === mode, 6000, 150);
    return { changed: true, clicked, ok: clicked === "ok" && ok };
  }
  /** 真实设置面板：切换壁纸格子（内置 theme-light / theme-dark）。 */
  async function setWallpaper(id) {
    const read = () => js("const d = document.querySelector('.desktop'); return d ? d.getAttribute('data-wallpaper') : null;");
    if ((await read()) === id) return { changed: false, ok: true };
    const up = await ctx.openSettings();
    const clicked = up ? await js("const w = document.querySelector('[data-settings-active]')?.closest('.window'); if (!w) return 'missing'; const b = w.querySelector('.wallpaper-option[data-wallpaper=\"' + " + JSON.stringify(id) + " + '\"]'); if (!b) return 'no-tile'; b.click(); return 'ok';") : "settings-missing";
    const ok = await waitFor(async () => (await read()) === id, 6000, 150);
    return { changed: true, clicked, ok: clicked === "ok" && ok };
  }
  async function applyCell(cell) {
    const t = await ctx.setTheme(cell.theme);
    const g = await setGlass(cell.glass);
    const w = await setWallpaper(cell.wallpaper);
    await sleep(320);
    const env = await envState();
    return { theme: t, glass: g, wallpaper: w, env, ok: env.dark === (cell.theme === "dark") && env.glass === cell.glass && env.wallpaper === cell.wallpaper };
  }
  const cellMatches = async (cell) => { const e = await envState(); return e.dark === (cell.theme === "dark") && e.glass === cell.glass && e.wallpaper === cell.wallpaper; };

  /**
   * 向导第三步：两次密码不一致 → 错误行；返回几何 + 文案。
   * **前置条件**：必须在干净向导第 1 步（[data-d3-id=setup-name] 在）。不满足就等一下再判，
   * 绝不在登录页上硬跑 —— 登录页也有同一条 .auth-error，会把两个面混成一个。
   */
  async function wizardToMismatch(acct, name) {
    const onStep1 = await ctx.has('[data-d3-id="setup-name"]') || await waitFor(() => ctx.has('[data-d3-id="setup-name"]'), 20000, 250);
    if (!onStep1) return { shown: false, surface: false, steps: [false, false, false], submitted: "not-on-wizard" };
    const res = await ctx.setupWizard(acct, name, { confirmValue: acct.pw + "-different" });
    const shown = await waitFor(async () => ((await ctx.textOf('[data-d3-id="auth-error"]')) || "").trim().length > 0, 8000, 120);
    await sleep(220);
    return { ...res, shown };
  }

  /**
   * 严格回到「干净向导第 1 步」。
   *
   * 为什么要严格：identity/reset-installation 会让**正在运行的渲染层立刻落到登录页**
   * （主进程发 LOGGED_OUT，useIdentity 把 snapshot 清空 → gate=unauthenticated），
   * 此时 status 已经是 UNINITIALIZED 但页面上还没有向导 —— 只有 reload 之后才会出现。
   * 因此判定必须是「gate=uninitialized **且** [data-d3-id=setup-name] 在」，并且 reload 失败要重试
   * （Playwright 的 reload 可能超时；超时后页面仍停在登录页，光看 gate 会误判）。
   */
  async function toWizard({ tries = 3, wantGate = "uninitialized" } = {}) {
    const attempts = [];
    for (let i = 0; i < tries; i += 1) {
      let reloadError = null, rebindError = null;
      try { await js("setTimeout(function(){ location.reload(); }, 0); return true;"); } catch (e) { reloadError = String((e && e.message) || e).slice(0, 160); }
      await sleep(1200);
      try { await ctx.rebindPage(ctx.appRec()); } catch (e) { rebindError = String((e && e.message) || e).slice(0, 160); }
      const ok = await waitFor(async () => (await ctx.gate()) === wantGate && (await ctx.has('[data-d3-id="setup-name"]')), 30000, 250);
      attempts.push({ try: i + 1, reloadError, rebindError, ok });
      if (ok) return { ok: true, tries: i + 1, attempts };
    }
    return { ok: false, tries, attempts };
  }
  const freshWizard = async () => (await toWizard()).ok;

  /* ══════════ V8 · 矩阵 ══════════ */
  const MATRIX = [];
  note("矩阵会话：新开一个 electron 实例（独立 userData、独立 CDP 端口），全部格子在同一实例内用真实设置面板切换。");

  const launch = await ctx.launchApp({ label: "matrix" });
  const env0 = await envState();
  record("V8a", "矩阵会话启动：真实 electron . + 隔离 userData + 独占 CDP 端口；窗口 1440×940、DPR2（与第一/四/五批同口径）",
    env0.innerWidth === 1440 && env0.innerHeight === 940 && env0.dpr === 2 && env0.gate === "uninitialized",
    "innerWidth=1440 / innerHeight=940 / devicePixelRatio=2 / gate=uninitialized",
    JSON.stringify({ ...env0, label: launch.label, cdpPort: launch.cdpPort }));

  const ACCT = { id: "admin@d503f-matrix.test", pw: "matrix-admin-1" };
  const ACCT2 = { id: "admin2@d503f-matrix.test", pw: "matrix-admin-2" };

  /* 起始：把第 0 格配置用真实面板落实（默认通常已是浅色 / 完整玻璃 / 深色壁纸，但以实测为准）。 */
  async function bootToCell(cell, acct, label) {
    /* 配置对不代表在向导上：reset 之后运行中的渲染层会停在登录页，必须连门禁一起判。 */
    const onWizard = (await ctx.gate()) === "uninitialized" && (await ctx.has('[data-d3-id="setup-name"]'));
    if (!onWizard || !(await cellMatches(cell))) {
      const okSetup = await ctx.setupWizard(acct, "D5-03F 矩阵 " + label);
      const okLogin = await ctx.login(acct.id, acct.pw);
      if (!okSetup.submitted || okLogin !== true) return { ok: false, why: "无法登录以切换配置", setup: okSetup, login: okLogin };
      const applied = await applyCell(cell);
      const reset = await ctx.identity({ type: "identity/reset-installation", confirm: "DELETE-ALL-IDENTITY-DATA" });
      const back = await toWizard();
      return { ok: applied.ok && reset?.ok === true && back.ok, applied, resetOk: reset?.ok, back };
    }
    return { ok: true, already: true };
  }

  /* 冒烟用：OA_D503F_CELL_LIMIT=2 只跑前两格（正式验收不设该变量，跑满 10 格）。 */
  const CELL_LIMIT = Number(process.env.OA_D503F_CELL_LIMIT || 0);
  const ACTIVE_CELLS = CELL_LIMIT > 0 ? CELLS.slice(0, CELL_LIMIT) : CELLS;
  if (CELL_LIMIT > 0) note("冒烟模式：只跑前 " + ACTIVE_CELLS.length + " 格（OA_D503F_CELL_LIMIT=" + CELL_LIMIT + "），不做正式判定用。");
  const cellKeys = ACTIVE_CELLS.map((c) => c.id);
  for (let i = 0; i < ACTIVE_CELLS.length; i += 1) {
    const cell = ACTIVE_CELLS[i];
    const next = ACTIVE_CELLS[i + 1] || null;
    const row = { index: i, ...cell, wizard: null, settings: null, config: null, errors: [] };
    try {
      /* 不变式：循环头处于「向导 + 本格配置」。 */
      const pre = await envState();
      if (pre.gate !== "uninitialized" || !(await cellMatches(cell))) {
        const boot = await bootToCell(cell, i === 0 ? ACCT : ACCT2, cell.id);
        if (!boot.ok) row.errors.push("预置失败：" + JSON.stringify(boot));
      }
      const envW = await envState();
      /* 面判据：向导面必须真的有 .auth-card + .auth-actions，否则登录页那条 .auth-error 会被误当成向导面。 */
      row.wizardSurface = await js("return { card: !!document.querySelector('.auth-card'), actions: !!document.querySelector('.auth-actions'), setupName: !!document.querySelector('[data-d3-id=\"setup-name\"]') };");
      if (!row.wizardSurface.card || !row.wizardSurface.actions) row.errors.push("向导面不在屏上（.auth-card/.auth-actions 缺失）：" + JSON.stringify(row.wizardSurface));
      const w = await wizardToMismatch(i === 0 ? ACCT : ACCT2, "D5-03F 矩阵 " + cell.id);
      const stW = await probe('[data-d3-id="auth-error"]');
      await windowShot(path.join(VIS, cell.id + "-01-wizard-window.png"));
      const cW = await measureContrast('[data-d3-id="auth-error"]', path.join(VIS, cell.id + "-02-wizard-error-row.png"), stW);
      row.wizard = { contrast: cW, style: stW, env: envW };
      row.expected = { rowRgb: cell.rowRgb, contentRgb: stW ? channelTriplet(stW.contentRgb) : null, ratio: stW && parseRgb(stW.backgroundColor) && parseRgb(stW.color) ? round(wcag(lum(...parseRgb(stW.backgroundColor)), lum(...parseRgb(stW.color)))) : null };
      row.wizard.checks = {
        surface: !!(row.wizardSurface && row.wizardSurface.card && row.wizardSurface.actions),
        text: w.shown && stW && stW.text.length > 0,
        bgIsToken: !!(stW && channelTriplet(stW.contentRgb) === cell.rowRgb.replace(/ /g, "") && parseRgb(stW.backgroundColor).join(",") === cell.rowRgb),
        modeIsToken: !!(cW && !cW.error && String(cW.modeRgb).replace(/ /g, "") === cell.rowRgb),
        ratioOk: !!(cW && !cW.error && cW.ratio >= THRESHOLD),
      };

      /* 向导 → 提交建号 → 登录 → 设置面
         注意：向导错误态停在第 3 步，必须先整页 reload 回到第 1 步才能走完整提交。 */
      const acct = i === 0 ? ACCT : ACCT2;
      const freshW = await freshWizard();
      const setupOk = await ctx.setupWizard(acct, "D5-03F 矩阵 " + cell.id);
      const loginOk = await ctx.login(acct.id, acct.pw);
      row.setupLogin = { fresh: freshW, submitted: setupOk.submitted, login: loginOk };
      if (!freshW || !setupOk.submitted || loginOk !== true) row.errors.push("向导提交或登录失败：" + JSON.stringify({ freshW, setup: setupOk, login: loginOk }));
      const up = await ctx.openSettings();
      row.settingsSurface = await js("return { win: !!document.querySelector('[data-settings-active]'), name: !!document.querySelector('[data-d3-id=\"settings-name\"]'), save: !!document.querySelector('[data-d3-id=\"settings-save\"]') };");
      if (!row.settingsSurface.win || !row.settingsSurface.name || !row.settingsSurface.save) row.errors.push("设置面不在屏上：" + JSON.stringify(row.settingsSurface));
      const longName = "很长的显示名".repeat(20) + "·".repeat(i + 1);
      await ctx.setInput('[data-d3-id="settings-name"]', longName);
      await waitFor(() => js('const b = document.querySelector("[data-d3-id=settings-save]"); return !!b && !b.disabled;'), 6000, 120);
      const clicked = await ctx.clickSel('[data-d3-id="settings-save"]');
      const shownS = await waitFor(async () => ((await ctx.textOf('[data-d3-id="settings-error"]')) || "").trim().length > 0, 8000, 120);
      await js("const el = document.querySelector('[data-d3-id=settings-error]'); if (el) el.scrollIntoView({ block: 'center' }); return true;");
      await sleep(320);
      const stS = await probe('[data-d3-id="settings-error"]');
      await windowShot(path.join(VIS, cell.id + "-03-settings-window.png"));
      const cS = await measureContrast('[data-d3-id="settings-error"]', path.join(VIS, cell.id + "-04-settings-error-row.png"), stS);
      row.settings = { contrast: cS, style: stS, loginOk, settingsUp: up, saveClicked: clicked, shown: shownS };
      row.settings.checks = {
        surface: !!(row.settingsSurface && row.settingsSurface.win && row.settingsSurface.name && row.settingsSurface.save),
        text: shownS && stS && stS.text.length > 0,
        bgIsToken: !!(stS && parseRgb(stS.backgroundColor).join(",") === cell.rowRgb),
        modeIsToken: !!(cS && !cS.error && String(cS.modeRgb).replace(/ /g, "") === cell.rowRgb),
        ratioOk: !!(cS && !cS.error && cS.ratio >= THRESHOLD),
      };

      /* 切到下一格配置（真实面板）→ 重置 → 回向导；最后一格不切（留给 V9 登录页用） */
      if (next) {
        row.config = await applyCell(next);
        const reset = await ctx.identity({ type: "identity/reset-installation", confirm: "DELETE-ALL-IDENTITY-DATA" });
        const back = await toWizard();
        row.backToWizard = back.ok;
        row.backToWizardAttempts = back.attempts;
        row.resetOk = reset?.ok === true;
        if (!back.ok) row.errors.push("换格后回不到干净向导：" + JSON.stringify(back));
      }
    } catch (e) {
      row.errors.push(String((e && e.message) || e));
    }
    MATRIX.push(row);
    const wRatio = row.wizard && row.wizard.contrast && !row.wizard.contrast.error ? round(row.wizard.contrast.ratio) : null;
    const sRatio = row.settings && row.settings.contrast && !row.settings.contrast.error ? round(row.settings.contrast.ratio) : null;
    record("V8." + cell.id, "矩阵格【" + cell.theme + " × " + cell.glass + " × " + cell.wallpaper + "】向导面 + 设置面：" + "该行底 = 自身 token 底 rgb(" + cell.rowRgb + ")、最终合成对比度 ≥ 4.5:1（mode 像素 = token 底）",
      !!(row.wizard && row.wizard.checks && row.wizard.checks.surface && row.wizard.checks.text && row.wizard.checks.bgIsToken && row.wizard.checks.modeIsToken && row.wizard.checks.ratioOk
        && row.settings && row.settings.checks && row.settings.checks.surface && row.settings.checks.text && row.settings.checks.bgIsToken && row.settings.checks.modeIsToken && row.settings.checks.ratioOk),
      "两面均：文案非空 / computed backgroundColor = rgb(" + cell.rowRgb + ") / mode 像素 = " + cell.rowRgb + " / ratio ≥ 4.5（静态预期 " + (row.expected ? row.expected.ratio : "?") + ":1）",
      JSON.stringify({ index: i, expected: row.expected, wizard: { checks: row.wizard && row.wizard.checks, ratio: wRatio, modeRgb: row.wizard && row.wizard.contrast && row.wizard.contrast.modeRgb, modeShare: row.wizard && row.wizard.contrast && round(row.wizard.contrast.modeShare, 4), textRgb: row.wizard && row.wizard.contrast && row.wizard.contrast.textRgb, bg: row.wizard && row.wizard.style && row.wizard.style.backgroundColor, clip: row.wizard && row.wizard.contrast && row.wizard.contrast.clip }, settings: { checks: row.settings && row.settings.checks, ratio: sRatio, modeRgb: row.settings && row.settings.contrast && row.settings.contrast.modeRgb, modeShare: row.settings && row.settings.contrast && round(row.settings.contrast.modeShare, 4), textRgb: row.settings && row.settings.contrast && row.settings.contrast.textRgb, bg: row.settings && row.settings.style && row.settings.style.backgroundColor, clip: row.settings && row.settings.contrast && row.settings.contrast.clip }, errors: row.errors, config: row.config }));
  }

  const cellCount = MATRIX.filter((r) => r.wizard && r.wizard.checks && r.wizard.checks.ratioOk && r.settings && r.settings.checks && r.settings.checks.ratioOk).length;
  record("V8z", "矩阵覆盖格数：" + cellKeys.length + " 格（8 格主矩阵 + 2 格 solid 补充），全部格子两面都达标",
    MATRIX.length === ACTIVE_CELLS.length && cellCount === ACTIVE_CELLS.length,
    ACTIVE_CELLS.length + " 格全部达标（向导面 + 设置面）", JSON.stringify({ cells: ACTIVE_CELLS.length, fullMatrixCells: CELLS.length, cellLimit: CELL_LIMIT || null, measured: MATRIX.length, allPass: cellCount, rows: MATRIX.map((r) => ({ id: r.id, env: r.wizard && r.wizard.env ? { dark: r.wizard.env.dark, glass: r.wizard.env.glass, wallpaper: r.wizard.env.wallpaper } : null, wizard: r.wizard && r.wizard.contrast ? { ratio: round(r.wizard.contrast.ratio), bg: r.wizard.contrast.modeRgb, share: round(r.wizard.contrast.modeShare, 4) } : null, settings: r.settings && r.settings.contrast ? { ratio: round(r.settings.contrast.ratio), bg: r.settings.contrast.modeRgb, share: round(r.settings.contrast.modeShare, 4) } : null, errors: r.errors })) }));

  /** 填到向导第 3 步但**不提交**（用来量"错误行不存在时"的基准布局）。 */
  async function fillToStep3(acct, confirmValue) {
    const ok1 = await waitFor(() => ctx.has('[data-d3-id="setup-name"]'), 20000, 200);
    if (!ok1) return { ok: false, why: "不在向导第 1 步" };
    await ctx.setInput('[data-d3-id="setup-name"]', "D5-03F 布局基准");
    await waitFor(() => js("const b = document.querySelector(" + JSON.stringify(byId("setup-next")) + "); return !!b && !b.disabled;"), 8000, 150);
    await ctx.clickSel(byId("setup-next")); await sleep(450);
    const ok2 = await waitFor(() => ctx.has(byId("setup-identifier")), 10000, 200);
    await ctx.setInput(byId("setup-identifier"), acct.id);
    await waitFor(() => js("const b = document.querySelector(" + JSON.stringify(byId("setup-next")) + "); return !!b && !b.disabled;"), 8000, 150);
    await ctx.clickSel(byId("setup-next")); await sleep(450);
    const ok3 = await waitFor(() => ctx.has(byId("setup-password")), 10000, 200);
    await ctx.setInput(byId("setup-password"), acct.pw);
    await ctx.setInput(byId("setup-confirm"), confirmValue);
    await sleep(320);
    return { ok: ok1 && ok2 && ok3, steps: [ok1, ok2, ok3] };
  }

  /* ══════════ V10 · 布局 / V11 · 焦点 / V12 · 动效 ══════════
     顺序说明：这三段必须在 V9 之前跑 —— V9 会把账号打到限流并停在登录页，
     而布局与焦点要在「向导面 + 设置面」两个真实界面上量。 */
  /**
   * 连续帧序列：核对错误行是**即时出现**、无淡入、无位移。
   * 采样方式：Playwright 连续截图（裁到错误行矩形 ±3px），页面内定时器触发状态变化
   * （避免截图循环里插入 CDP 调用扰动时序）。指标用"红色像素"（r-g）而不是"非底色像素"，
   * 因为错误行消失后下面的按钮行会上移进入同一块矩形，用底色差会被按钮文字污染。
   */
  async function captureAppearance({ tag, errSel, confirmSel, submitSel, good, bad, reduced, resetToClean }) {
    const FR = path.join(VIS, "motion-frames");
    fs.mkdirSync(FR, { recursive: true });
    /* 1) 先确保干净（错误行不在 DOM）。不能靠"把确认密码改回来"让错误行消失：
       提交失败后 identity.error 留在渲染层状态里，改输入框不会清掉它 —— 必须整页重挂载。 */
    const clean1 = await resetToClean();
    const absent1 = await errAbsent(errSel);
    /* 2) 做出错误行，量出它的矩形与样式（帧就裁这块）。
       注意：该行的文案来自一次**真实提交尝试**的结果，只改输入框不会出现 —— 必须点一次提交。 */
    await ctx.setInput(confirmSel, bad);
    await sleep(180);
    const submitClicked = await ctx.clickSel(submitSel);
    await waitFor(async () => ((await ctx.textOf(errSel)) || "").trim().length > 0, 8000, 120);
    await sleep(240);
    const rectOn = await rectOf(errSel);
    const stOn = await probe(errSel);
    await windowShot(path.join(VIS, tag + "-00-present-window.png"));
    /* 3) 再回到干净状态，然后才开始抓帧 */
    const clean2 = await resetToClean();
    const absent2 = await errAbsent(errSel);
    await sleep(240);
    /* 触发必须与真实用户路径一致：改输入框 **再点一次提交**，错误行才会出现（文案来自提交结果）。 */
    const armed = await js("const el = document.querySelector(" + JSON.stringify(confirmSel) + "); if (!el) return 'missing'; window.__oaMotion = { t0: performance.now(), t1: null }; setTimeout(function () { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, " + JSON.stringify(bad) + "); el.dispatchEvent(new Event('input', { bubbles: true })); setTimeout(function () { const b = document.querySelector(" + JSON.stringify(submitSel) + "); if (b && !b.disabled) b.click(); window.__oaMotion.t1 = performance.now(); }, 40); }, 600); return 'armed';");
    if (!rectOn) return { tag, reduced, ok: false, why: "错误行没出现，量不到矩形", clean1, clean2, absent1, absent2, submitClicked, animationName: stOn && stOn.animationName };
    const clip = { x: Math.max(0, rectOn.left - 3), y: Math.max(0, rectOn.top - 3), width: rectOn.width + 6, height: rectOn.height + 6 };
    const frames = [];
    for (let i = 0; i < 34; i += 1) {
      const file = path.join(FR, tag + "-" + String(i).padStart(2, "0") + ".png");
      const at = Date.now();
      await pg().screenshot({ path: file, clip });
      frames.push({ file, name: path.basename(file), at });
      await sleep(40);
    }
    const triggerAtPage = await js("return window.__oaMotion ? { t1: window.__oaMotion.t1, t0: window.__oaMotion.t0 } : null;");
    const rectEnd = await rectOf(errSel);
    const stEnd = await probe(errSel);
    const b64s = frames.map((fr) => fs.readFileSync(fr.file).toString("base64"));
    const stats = await pg().evaluate(async (payload) => {
      const out = [];
      for (const b64 of payload) {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = () => res(true); img.onerror = () => rej(new Error("decode")); img.src = "data:image/png;base64," + b64; });
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const cx = c.getContext("2d", { willReadFrequently: true });
        cx.drawImage(img, 0, 0);
        const d = cx.getImageData(0, 0, c.width, c.height).data;
        const total = d.length / 4;
        let red = 0, sum = 0, dark = 0;
        for (let i = 0; i < d.length; i += 4) {
          const rg = d[i] - d[i + 1];
          if (rg > 40 && d[i] > 60) red += 1;
          if (rg > 0) sum += rg;
          dark += d[i] + d[i + 1] + d[i + 2];
        }
        out.push({ w: c.width, h: c.height, totalPx: total, redPixels: red, redShare: red / total, meanRedness: sum / total, meanRgbSum: dark / total / 3 });
      }
      return out;
    }, b64s);
    const gaps = frames.slice(1).map((fr, i) => fr.at - frames[i].at);
    const maxRed = Math.max(...stats.map((s) => s.redPixels));
    const maxMean = Math.max(...stats.map((s) => s.meanRedness));
    const firstIdx = stats.findIndex((s) => s.redPixels >= 0.75 * maxRed && maxRed > 0);
    const intermediate = stats.map((s, i) => ({ i, redShare: s.redShare, meanRedness: s.meanRedness })).filter((s) => s.meanRedness > 0.05 * maxMean && s.meanRedness < 0.7 * maxMean);
    const last = stats[stats.length - 1];
    const ok = absent1 === true && absent2 === true && !!rectOn && !!rectEnd && Math.abs(rectOn.top - rectEnd.top) < 0.5 && Math.abs(rectOn.left - rectEnd.left) < 0.5
      && maxRed > 0 && firstIdx > 0 && stats[firstIdx].redPixels >= 0.75 * maxRed
      && intermediate.length === 0
      && last.redPixels >= 0.95 * maxRed
      && stOn && stOn.animationName === "none" && stOn.transitionDuration.split(",").every((d) => d.trim() === "0s")
      && stEnd && stEnd.animationName === "none" && stEnd.transitionDuration.split(",").every((d) => d.trim() === "0s");
    return {
      tag, reduced, armed, clip, frameCount: frames.length, clean1, clean2, absent1, absent2, submitClicked,
      frameIntervalMs: { min: Math.min(...gaps), max: Math.max(...gaps), median: gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] },
      triggerAtPage, rectOn: short(rectOn), rectEnd: short(rectEnd), sameRect: !!rectOn && !!rectEnd && Math.abs(rectOn.top - rectEnd.top) < 0.5 && Math.abs(rectOn.left - rectEnd.left) < 0.5,
      animationName: stOn && stOn.animationName, transitionDuration: stOn && stOn.transitionDuration, durQuick: stOn && stOn.durQuick,
      maxRedPixels: maxRed, maxMeanRedness: round(maxMean, 4), firstPresentIndex: firstIdx,
      intermediateFrames: intermediate.map((s) => ({ i: s.i, meanRedness: round(s.meanRedness, 4) })),
      profile: stats.map((s, i) => ({ i, red: s.redPixels, mean: round(s.meanRedness, 4) })),
      ok,
    };
  }

  const LAYOUT = { settings: null, wizard: null };
  const FOCUS = { settings: null, wizard: null, login: null };
  const MOTION = { normal: null, reduced: null, framesDir: null };
  const LONG_TEXT = "错误说明文本".repeat(21); // 126 字 >= 120

  const rectOf = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };");
  const childrenRects = (sel) => js("const root = document.querySelector(" + JSON.stringify(sel) + "); if (!root) return null; return Array.from(root.querySelectorAll('button')).map(function (b) { const r = b.getBoundingClientRect(); return { text: (b.textContent || '').trim().slice(0, 12), disabled: !!b.disabled, left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; });");
  const inside = (inner, outer, tol) => !!inner && !!outer && inner.left >= outer.left - tol && inner.right <= outer.right + tol && inner.top >= outer.top - tol && inner.bottom <= outer.bottom + tol;
  /** 相对滚动容器内容坐标的 Y（不受滚动位置影响），用来量"错误行占了多少垂直空间"。 */
  const contentY = (sel, containerSel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); const c = document.querySelector(" + JSON.stringify(containerSel) + "); if (!el || !c) return null; const r = el.getBoundingClientRect(); const cr = c.getBoundingClientRect(); return r.top - cr.top + c.scrollTop;");
  const errAbsent = async (sel) => !(await ctx.has(sel));

  /** 布局探针：给定「错误行 / 按钮行 / 卡片」三个选择器，返回一组可判定的几何事实。 */
  async function layoutProbe(errSel, actionsSel, cardSel) {
    const err = await rectOf(errSel);
    const actions = await rectOf(actionsSel);
    const card = await rectOf(cardSel);
    const buttons = await childrenRects(actionsSel);
    const st = await probe(errSel);
    const env = await envState();
    const lineH = st ? parseFloat(st.lineHeight) : null;
    return {
      err, actions, card, buttons, env,
      errorTextLength: st ? st.text.length : 0,
      rowHeight: err ? err.height : null,
      lineHeight: lineH,
      rowAtLeastOneLine: !!(err && lineH && err.height >= lineH),
      buttonsInsideCard: !!card && !!buttons && buttons.length > 0 && buttons.every((b) => inside(b, card, 1)),
      errorOverlapsActions: rectsIntersect(err, actions),
      docScrollW: env.docScrollW, innerWidth: env.innerWidth,
      noHorizontalOverflow: env.docScrollW <= env.innerWidth + 1,
      cardInsideViewportX: !!card && card.left >= -1 && card.right <= env.innerWidth + 1,
      errNoSelfOverflow: !!st && st.scrollW <= st.clientW + 1,
      errStyle: st ? { backgroundColor: st.backgroundColor, color: st.color, marginTop: st.marginTop, animationName: st.animationName, transitionDuration: st.transitionDuration, durQuick: st.durQuick } : null,
    };
  }

  /* ── V10a · 设置面（当前就在这个界面：已登录 + 设置窗口 + 错误行） ── */
  const SET_WIN = "[data-settings-active]";
  const SET_CARD = ".window:has([data-settings-active])";
  const SET_ACTIONS = ".profile-actions";
  const SET_ERR = '[data-d3-id="settings-error"]';
  try {
    const before = await layoutProbe(SET_ERR, SET_ACTIONS, SET_CARD);
    /* 设置面里错误行是**最后一个**元素，下面没有东西可移动 —— 所以量的是"它给内容区加了多少高度"，
       而不是某个下方元素的位置（那会恒为 0）。 */
    const hWithErr = await js("const c = document.querySelector(" + JSON.stringify(SET_WIN) + "); return c ? c.scrollHeight : null;");
    await ctx.setInput('[data-d3-id="settings-name"]', "D5-03F 矩阵");
    await waitFor(() => js('const b = document.querySelector("[data-d3-id=settings-save]"); return !!b && !b.disabled;'), 6000, 120);
    await ctx.clickSel('[data-d3-id="settings-save"]');
    const cleared = await waitFor(async () => ((await ctx.textOf(SET_ERR)) || "").trim().length === 0, 8000, 120);
    await sleep(300);
    const after = await layoutProbe(SET_ERR, SET_ACTIONS, SET_CARD);
    const hNoErr = await js("const c = document.querySelector(" + JSON.stringify(SET_WIN) + "); return c ? c.scrollHeight : null;");
    const errGoneFromDom = await errAbsent(SET_ERR);
    const holeDelta = hWithErr !== null && hNoErr !== null ? round(hWithErr - hNoErr) : null;
    const expectedDelta = before.err ? round(before.err.height + parseFloat(before.errStyle.marginTop || "0") + parseFloat(before.errStyle.marginBottom || "0")) : null;
    const residual = holeDelta !== null && expectedDelta !== null ? round(holeDelta - expectedDelta) : null;
    /* 设置面里错误行是最后一个元素，它下面没有任何元素可以「上移」，所以这里只可能量
       「内容区释放了多少高度」：要求元素整段移出 DOM，且释放量 >= 该行自身外框（多出来的部分如实记为 residual）。 */
    LAYOUT.settings = { before, after, cleared, errGoneFromDom, hWithErr, hNoErr, holeDelta, expectedDelta, residual, holeClosed: cleared && errGoneFromDom && holeDelta !== null && expectedDelta !== null && holeDelta > 0 && holeDelta >= expectedDelta - 2 };
    record("V10a", "布局 · 设置面：错误行高度 ≥ 该行自己的 line-height；消失后**从 DOM 里整个移除**（不是留个空盒），且内容区确实释放了 ≥ 该行外框的垂直空间（该面错误行是最后一个元素，下方没有元素可上移，所以量的是释放量而不是位移量）",
      before.rowAtLeastOneLine && LAYOUT.settings.holeClosed,
      "rowHeight >= 该元素 computed line-height；消失后元素整段不在 DOM；内容区 scrollHeight 减少量 > 0 且 >= 行高 + margin - 2px（该面错误行下方没有元素，无法量「上移量」，残余量如实记 residual）",
      JSON.stringify({ rowHeight: round(before.rowHeight), lineHeight: before.lineHeight, errGoneFromDom, hWithErr, hNoErr, holeDelta, expectedDelta, residual, cleared, buttons: (before.buttons || []).map((b) => b.text) }));
    if (residual !== null && Math.abs(residual) > 2) notVerified("设置面错误行消失后的空间释放量精确等于「行高 + margin」", "实测释放 " + holeDelta + "px，行高+margin = " + expectedDelta + "px，残余 " + residual + "px 成因未查明（同一判据在向导面 —— 错误行下方有 .auth-actions —— 已精确成立，见 V10d）。已确认元素整段移出 DOM 且空间确有释放；不作为产品缺陷登记。");
  } catch (e) { LAYOUT.settings = { error: String((e && e.message) || e) }; }
  record("V10b", "布局 · 设置面：保存按钮完整在窗口卡内，且与错误行矩形不相交",
    !!(LAYOUT.settings && LAYOUT.settings.before && LAYOUT.settings.before.buttonsInsideCard && !LAYOUT.settings.before.errorOverlapsActions),
    "所有按钮矩形 ⊂ 卡片矩形；errorRect ∩ actionsRect = ∅",
    JSON.stringify({ buttonsInsideCard: LAYOUT.settings && LAYOUT.settings.before && LAYOUT.settings.before.buttonsInsideCard, errorOverlapsActions: LAYOUT.settings && LAYOUT.settings.before && LAYOUT.settings.before.errorOverlapsActions, err: short(LAYOUT.settings && LAYOUT.settings.before && LAYOUT.settings.before.err), actions: short(LAYOUT.settings && LAYOUT.settings.before && LAYOUT.settings.before.actions), card: short(LAYOUT.settings && LAYOUT.settings.before && LAYOUT.settings.before.card) }));

  /* ── V10c · 缩放 × 长文案（设置面，重新把错误行做出来再量） ── */
  const ZOOMS = [1, 1.25, 1.5, 2];
  const ZOOM_ROWS = [];
  try {
    await ctx.setInput('[data-d3-id="settings-name"]', "很长的显示名".repeat(20));
    await waitFor(() => js('const b = document.querySelector("[data-d3-id=settings-save]"); return !!b && !b.disabled;'), 6000, 120);
    await ctx.clickSel('[data-d3-id="settings-save"]');
    await waitFor(async () => ((await ctx.textOf(SET_ERR)) || "").trim().length > 0, 8000, 120);
    await sleep(260);
    const original = await ctx.textOf(SET_ERR);
    for (const z of ZOOMS) {
      await setZoom(pg(), z);
      await sleep(320);
      await js("const el = document.querySelector(" + JSON.stringify(SET_ERR) + "); if (el) el.scrollIntoView({ block: 'center' }); return true;");
      await sleep(160);
      const real = await layoutProbe(SET_ERR, SET_ACTIONS, SET_CARD);
      await js("const el = document.querySelector(" + JSON.stringify(SET_ERR) + "); if (el) el.textContent = " + JSON.stringify(LONG_TEXT) + "; return true;");
      await sleep(160);
      const long = await layoutProbe(SET_ERR, SET_ACTIONS, SET_CARD);
      await js("const el = document.querySelector(" + JSON.stringify(SET_ERR) + "); if (el) el.textContent = " + JSON.stringify(original) + "; return true;");
      ZOOM_ROWS.push({ z, real, long });
    }
    await setZoom(pg(), 1);
    await sleep(300);
  } catch (e) { ZOOM_ROWS.push({ error: String((e && e.message) || e) }); }
  await setZoom(pg(), 1).catch(() => {});
  const zoomOk = ZOOM_ROWS.length === ZOOMS.length && ZOOM_ROWS.every((r) => r.real && r.long
    && r.real.noHorizontalOverflow && r.real.cardInsideViewportX && r.real.errNoSelfOverflow && !r.real.errorOverlapsActions && r.real.buttonsInsideCard && r.real.rowAtLeastOneLine
    && r.long.noHorizontalOverflow && r.long.cardInsideViewportX && r.long.errNoSelfOverflow && !r.long.errorOverlapsActions && r.long.buttonsInsideCard && r.long.rowAtLeastOneLine && r.long.errorTextLength >= 120);
  record("V10c", "布局 · 设置面 100/125/150/200% 缩放 × 长文案（" + LONG_TEXT.length + " 字）：不横向溢出、卡片不出视口、文字在自己盒内换行、不压按钮",
    zoomOk,
    "四档缩放下（真实文案 + " + LONG_TEXT.length + " 字注入文案）均：文档无横向溢出 / 卡片横向不出视口 / errorScrollW<=clientW / 错误行与按钮行不相交 / 按钮在卡内 / 行高 >= 1 行",
    JSON.stringify(ZOOM_ROWS.map((r) => r.error ? { error: r.error } : { z: r.z, real: { innerWidth: r.real.innerWidth, docScrollW: r.real.docScrollW, rowHeight: round(r.real.rowHeight), err: short(r.real.err), actions: short(r.real.actions), card: short(r.real.card), buttons: (r.real.buttons || []).map((b) => ({ t: b.text, ...short(b) })), overflow: !r.real.noHorizontalOverflow, cardOut: !r.real.cardInsideViewportX, selfOverflow: !r.real.errNoSelfOverflow, overlap: r.real.errorOverlapsActions, buttonsInCard: r.real.buttonsInsideCard }, long: { textLen: r.long.errorTextLength, rowHeight: round(r.long.rowHeight), docScrollW: r.long.docScrollW, overflow: !r.long.noHorizontalOverflow, cardOut: !r.long.cardInsideViewportX, selfOverflow: !r.long.errNoSelfOverflow, overlap: r.long.errorOverlapsActions, buttonsInCard: r.long.buttonsInsideCard, err: short(r.long.err), actions: short(r.long.actions) } })));

  /* ── V11a · 焦点（设置面「保存」DS-A05：2px 环 + 2px 间隔） ── */
  async function tabUntil(targetSel, max) {
    await js("if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); window.focus(); return true;");
    const seen = [];
    for (let i = 0; i < (max || 45); i += 1) {
      await pg().keyboard.press("Tab");
      await sleep(55);
      const a = await activeInfo();
      seen.push(a ? (a.id || a.tag) : null);
      if (await js("const el = document.activeElement; return !!el && el.matches(" + JSON.stringify(targetSel) + ");")) return { found: true, tabs: i + 1, active: a, seen };
    }
    return { found: false, tabs: max || 45, seen };
  }
  /**
   * 从**相邻控件**起按 Tab 前进到目标（模拟用户从上一个控件键盘前进）。
   * 为什么不从文档开头盲按：设置窗口里可聚焦元素很多，盲按 60 次都到不了「保存」；
   * 而从「显示名」输入框起一次 Tab 就到 —— 这是真实的键盘路径，不是把门槛放宽。
   */
  async function tabFrom(anchorSel, targetSel, max) {
    const anchored = await js("const el = document.querySelector(" + JSON.stringify(anchorSel) + "); if (!el) return false; el.focus(); return true;");
    if (!anchored) return { found: false, why: "anchor-missing", anchorSel, seen: [] };
    const seen = [];
    for (let i = 0; i < (max || 6); i += 1) {
      await pg().keyboard.press("Tab");
      await sleep(70);
      const a = await activeInfo();
      seen.push(a ? (a.id || a.tag) : null);
      if (await js("const el = document.activeElement; return !!el && el.matches(" + JSON.stringify(targetSel) + ");")) return { found: true, tabs: i + 1, active: a, seen, anchorSel, anchored };
    }
    /* 兜底：从文档开头盲按（记录用了哪条路径） */
    const blind = await tabUntil(targetSel, 60);
    return { ...blind, anchorSel, anchored, fallbackFromDocumentStart: true, firstSeen: seen };
  }
  const ringOk = (a) => !!a && a.focusVisible === true && a.outlineStyle === "solid" && parseFloat(a.outlineWidth) === 2 && parseFloat(a.outlineOffset) === 2;
  try {
    const tabSave = await tabFrom('[data-d3-id="settings-name"]', '[data-d3-id="settings-save"]', 6);
    const errRect = await rectOf(SET_ERR);
    FOCUS.settings = { tabSave, errRect, ringRect: tabSave.active ? outset(tabSave.active.rect, 4) : null, ringOk: ringOk(tabSave.active), ringVsErrorIntersect: tabSave.active ? rectsIntersect(outset(tabSave.active.rect, 4), errRect) : null };
  } catch (e) { FOCUS.settings = { error: String((e && e.message) || e) }; }
  record("V11a", "焦点（DS-A05）· 设置面 Tab 到「保存」：2px 实心焦点环 + 2px 间隔完整，且错误行出现时焦点环矩形（外扩 4px）与错误行矩形不相交",
    !!(FOCUS.settings && FOCUS.settings.ringOk && FOCUS.settings.ringVsErrorIntersect === false && FOCUS.settings.tabSave && FOCUS.settings.tabSave.found),
    "activeElement = settings-save 且 :focus-visible / outline 2px solid / outline-offset 2px；环外扩 4px ∩ 错误行 = ∅",
    JSON.stringify({ found: FOCUS.settings && FOCUS.settings.tabSave && FOCUS.settings.tabSave.found, tabs: FOCUS.settings && FOCUS.settings.tabSave && FOCUS.settings.tabSave.tabs, active: FOCUS.settings && FOCUS.settings.tabSave && FOCUS.settings.tabSave.active, ringOk: FOCUS.settings && FOCUS.settings.ringOk, ringVsErrorIntersect: FOCUS.settings && FOCUS.settings.ringVsErrorIntersect, errRect: short(FOCUS.settings && FOCUS.settings.errRect), seenTail: FOCUS.settings && FOCUS.settings.tabSave && FOCUS.settings.tabSave.seen.slice(-8) }));

  /* ── V10d/V11b/V12 · 回到向导面 ── */
  const WIZ_ERR = '[data-d3-id="auth-error"]';
  const WIZ_ACTIONS = ".auth-actions";
  const WIZ_CARD = ".auth-card";
  const ACCT_M = { id: "admin@d503f-motion.test", pw: "matrix-motion-1" };
  try {
    await ctx.setReduced(false);
    const resetW = await ctx.identity({ type: "identity/reset-installation", confirm: "DELETE-ALL-IDENTITY-DATA" });
    const backWRes = await toWizard();
    const backW = backWRes.ok;
    /* V10d · 向导面布局：先在"没有错误行"的干净第 3 步量基准，再做出错误行量同一位置 */
    const clean = await fillToStep3(ACCT_M, ACCT_M.pw);
    const cleanProbe = await layoutProbe(WIZ_ERR, WIZ_ACTIONS, WIZ_CARD);
    const errAbsentClean = await errAbsent(WIZ_ERR);
    const yClean = await contentY(WIZ_ACTIONS, WIZ_CARD);
    /* 做出错误行：把确认密码改成不一致，然后点「创建管理员」。
       注意（本轮实测口径）：只改输入框不会让错误行出现 —— 该行的文案来自一次**真实提交尝试**
       的结果（identity.error / local），所以必须真的点一次提交按钮。 */
    await ctx.setInput('[data-d3-id="setup-confirm"]', ACCT_M.pw + "-different");
    await sleep(200);
    const submitForError = await ctx.clickSel('[data-d3-id="setup-submit"]');
    const wizShown = await waitFor(async () => ((await ctx.textOf(WIZ_ERR)) || "").trim().length > 0, 8000, 120);
    await sleep(300);
    const beforeW = await layoutProbe(WIZ_ERR, WIZ_ACTIONS, WIZ_CARD);
    const yWithErr = await contentY(WIZ_ACTIONS, WIZ_CARD);
    await windowShot(path.join(VIS, "layout-01-wizard-error-window.png"));
    const holeDeltaW = yWithErr !== null && yClean !== null ? round(yWithErr - yClean) : null;
    const expectedW = beforeW.err ? round(beforeW.err.height + parseFloat(beforeW.errStyle.marginTop || "0") + parseFloat(beforeW.errStyle.marginBottom || "0")) : null;
    LAYOUT.wizard = { clean: cleanProbe, before: beforeW, cleanSteps: clean, errAbsentClean, yClean: round(yClean), yWithErr: round(yWithErr), holeDelta: holeDeltaW, expectedDelta: expectedW, holeClosed: errAbsentClean && holeDeltaW !== null && expectedW !== null && Math.abs(holeDeltaW - expectedW) <= 2, backToWizard: backW, resetOk: resetW?.ok === true, mismatchShown: wizShown };
    record("V10d", "布局 · 向导面：没有错误行时元素**不在 DOM 里**（不留空盒/不占位）；错误行出现时高度 ≥ 该行自己的 line-height，且它占掉的垂直空间 = 行高 + margin（在 .auth-card 内容坐标里量，不受卡片垂直居中影响）",
      errAbsentClean && beforeW.rowAtLeastOneLine && LAYOUT.wizard.holeClosed && wizShown,
      "无错误行时 [data-d3-id=auth-error] 不在 DOM；有错误行时 rowHeight >= computed line-height 且 .auth-actions 内容坐标下移量 = 行高 + margin（±2px）",
      JSON.stringify({ rowHeight: round(beforeW.rowHeight), lineHeight: beforeW.lineHeight, cleanSteps: clean, errAbsentClean, submitForError, yClean: round(yClean), yWithErr: round(yWithErr), holeDelta: holeDeltaW, expectedDelta: expectedW, mismatchShown: wizShown, resetOk: resetW?.ok, backToWizard: backW, backToWizardAttempts: backWRes.attempts, wizardSurface: { card: !!beforeW.card, actions: !!beforeW.actions } }));
    record("V10e", "布局 · 向导面：「创建管理员 / 上一步」按钮完整在卡内，且与错误行矩形不相交",
      !!(beforeW.card && beforeW.actions) && beforeW.buttonsInsideCard && !beforeW.errorOverlapsActions,
      "所有 .auth-actions 按钮矩形 ⊂ .auth-card；errorRect ∩ actionsRect = ∅；.auth-card 与 .auth-actions 都在屏上",
      JSON.stringify({ surface: !!(beforeW.card && beforeW.actions), buttonsInsideCard: beforeW.buttonsInsideCard, errorOverlapsActions: beforeW.errorOverlapsActions, buttons: (beforeW.buttons || []).map((b) => b.text), err: short(beforeW.err), actions: short(beforeW.actions), card: short(beforeW.card) }));

    /* V10f · 向导面缩放 × 长文案 */
    const ZOOM_W = [];
    await ctx.setInput('[data-d3-id="setup-confirm"]', ACCT_M.pw + "-different");
    await ctx.clickSel('[data-d3-id="setup-submit"]');
    await waitFor(async () => ((await ctx.textOf(WIZ_ERR)) || "").trim().length > 0, 8000, 120);
    await sleep(250);
    const originalW = await ctx.textOf(WIZ_ERR);
    for (const z of ZOOMS) {
      await setZoom(pg(), z);
      await sleep(320);
      await js("const el = document.querySelector(" + JSON.stringify(WIZ_ERR) + "); if (el) el.scrollIntoView({ block: 'center' }); return true;");
      await sleep(160);
      const real = await layoutProbe(WIZ_ERR, WIZ_ACTIONS, WIZ_CARD);
      await js("const el = document.querySelector(" + JSON.stringify(WIZ_ERR) + "); if (el) el.textContent = " + JSON.stringify(LONG_TEXT) + "; return true;");
      await sleep(160);
      const long = await layoutProbe(WIZ_ERR, WIZ_ACTIONS, WIZ_CARD);
      await js("const el = document.querySelector(" + JSON.stringify(WIZ_ERR) + "); if (el) el.textContent = " + JSON.stringify(originalW) + "; return true;");
      ZOOM_W.push({ z, real, long });
    }
    await setZoom(pg(), 1);
    await sleep(300);
    LAYOUT.zoomWizard = ZOOM_W;
    record("V10f", "布局 · 向导面 100/125/150/200% 缩放 × 长文案（" + LONG_TEXT.length + " 字）：不横向溢出、卡片不出视口、文字在自己盒内换行、不压按钮",
      ZOOM_W.length === ZOOMS.length && ZOOM_W.every((r) => r.real && r.long && r.real.noHorizontalOverflow && r.real.cardInsideViewportX && r.real.errNoSelfOverflow && !r.real.errorOverlapsActions && r.real.buttonsInsideCard && r.real.rowAtLeastOneLine && r.long.noHorizontalOverflow && r.long.cardInsideViewportX && r.long.errNoSelfOverflow && !r.long.errorOverlapsActions && r.long.buttonsInsideCard && r.long.rowAtLeastOneLine && r.long.errorTextLength >= 120),
      "四档缩放下（真实文案 + " + LONG_TEXT.length + " 字注入文案）均：无横向溢出 / 卡片不出视口 / errorScrollW<=clientW / 不相交 / 按钮在卡内 / 行高 >= 1 行",
      JSON.stringify(ZOOM_W.map((r) => ({ z: r.z, real: { innerWidth: r.real.innerWidth, docScrollW: r.real.docScrollW, rowHeight: round(r.real.rowHeight), err: short(r.real.err), actions: short(r.real.actions), card: short(r.real.card), buttons: (r.real.buttons || []).map((b) => ({ t: b.text, ...short(b) })), overflow: !r.real.noHorizontalOverflow, cardOut: !r.real.cardInsideViewportX, selfOverflow: !r.real.errNoSelfOverflow, overlap: r.real.errorOverlapsActions, buttonsInCard: r.real.buttonsInsideCard }, long: { textLen: r.long.errorTextLength, rowHeight: round(r.long.rowHeight), docScrollW: r.long.docScrollW, overflow: !r.long.noHorizontalOverflow, cardOut: !r.long.cardInsideViewportX, selfOverflow: !r.long.errNoSelfOverflow, overlap: r.long.errorOverlapsActions, buttonsInCard: r.long.buttonsInsideCard, err: short(r.long.err), actions: short(r.long.actions) } }))));

    /* V11b · 焦点：错误行出现前 / 后各一次（确认密码 → 创建管理员） */
    /* 输入框的焦点反馈：产品在 src/styles.css:1634-1639 明确写了「全应用输入框：不用任何线框/焦点环 ——
       焦点只靠填充深浅变化表达」。所以对输入框断言「:focus-visible=true 且焦点态背景确实不同于失焦态」，
       而不是 outline 环；按钮仍然按 2px 实心环 + 2px 间隔严格断言（不放宽）。 */
    const inputFocusFill = async (sel) => {
      const focused = await activeInfo();
      const bound = await js("const el = document.activeElement; return !!el && el.matches(" + JSON.stringify(sel) + ");");
      const off = await js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return null; const b = getComputedStyle(el).backgroundColor; el.blur(); const a = getComputedStyle(el).backgroundColor; el.focus(); return { whenBlurred: a };");
      return { focusedBg: focused && focused.backgroundColor, blurredBg: off && off.whenBlurred, bound, visible: !!(focused && off && focused.backgroundColor !== off.whenBlurred) };
    };
    const tabConfirmWith = await tabFrom('[data-d3-id="setup-password"]', '[data-d3-id="setup-confirm"]', 4);
    const fillWith = await inputFocusFill('[data-d3-id="setup-confirm"]');
    const tabSubmitWith = await tabFrom('[data-d3-id="setup-confirm"]', '[data-d3-id="setup-submit"]', 4);
    const errRectW = await rectOf(WIZ_ERR);
    const focusWith = {
      confirm: { ...tabConfirmWith, ringOk: ringOk(tabConfirmWith.active), inputFocusFill: fillWith, inputFocusOk: !!(fillWith.bound && fillWith.visible), outlineIsNoneByDesign: !!(tabConfirmWith.active && tabConfirmWith.active.outlineStyle === "none"), ringVsError: tabConfirmWith.active ? rectsIntersect(outset(tabConfirmWith.active.rect, 4), errRectW) : null },
      submit: { ...tabSubmitWith, ringOk: ringOk(tabSubmitWith.active), ringVsError: tabSubmitWith.active ? rectsIntersect(outset(tabSubmitWith.active.rect, 4), errRectW) : null },
    };
    /* 错误行"出现前"那一次：整页回到干净向导第 1 步，重新填到第 3 步（不提交）。
       不靠"把确认密码改回来让错误行自己消失" —— 提交失败后 identity.error 会一直挂在渲染层状态里，
       错误行不会因为改了输入框就消失（这一点本身就是本轮如实记录的观察，见报告）。 */
    const backFocus = (await toWizard()).ok;
    const cleanFocus = backFocus ? await fillToStep3(ACCT_M, ACCT_M.pw) : { ok: false, why: "回不到向导" };
    const errAbsentFocus = await errAbsent(WIZ_ERR);
    await sleep(200);
    const tabConfirmWo = await tabFrom('[data-d3-id="setup-password"]', '[data-d3-id="setup-confirm"]', 4);
    const fillWithout = await inputFocusFill('[data-d3-id="setup-confirm"]');
    const tabSubmitWo = await tabFrom('[data-d3-id="setup-confirm"]', '[data-d3-id="setup-submit"]', 4);
    const focusWithout = { confirm: { ...tabConfirmWo, inputFocusFill: fillWithout, inputFocusOk: !!(fillWithout.bound && fillWithout.visible) }, submit: { ...tabSubmitWo, ringOk: ringOk(tabSubmitWo.active) } };
    FOCUS.wizard = { withError: focusWith, withoutError: focusWithout, errRect: errRectW, backFocus, cleanFocus, errAbsentBeforeFocus: errAbsentFocus };
    record("V11b", "焦点（DS-A05）· 向导面 Tab 到「确认密码」与「创建管理员」：错误行出现前后各一次。按钮「创建管理员」= 2px 实心焦点环 + 2px 间隔；输入框「确认密码」= 产品显式不用焦点环（src/styles.css:1634-1639），改判「:focus-visible 且焦点态填充确实变化」；焦点矩形（外扩 4px）与错误行矩形不相交",
      focusWith.submit.ringOk && focusWithout.submit.ringOk && focusWith.confirm.inputFocusOk && focusWithout.confirm.inputFocusOk && focusWith.confirm.ringVsError === false && focusWith.submit.ringVsError === false && errAbsentFocus === true,
      "按钮两处：:focus-visible + outline 2px solid + offset 2px；输入框两处：:focus-visible 且焦点态 fill ≠ 失焦态 fill（outline-style 按产品设计为 none，如实记录）；两个控件外扩 4px 的焦点矩形都与错误行不相交；「出现前」那一次确认错误行确实不在 DOM",
      JSON.stringify({ withError: { confirm: { found: focusWith.confirm.found, tabs: focusWith.confirm.tabs, ringOk: focusWith.confirm.ringOk, ringVsError: focusWith.confirm.ringVsError, active: focusWith.confirm.active }, submit: { found: focusWith.submit.found, tabs: focusWith.submit.tabs, ringOk: focusWith.submit.ringOk, ringVsError: focusWith.submit.ringVsError, active: focusWith.submit.active } }, withoutError: { confirm: { found: focusWithout.confirm.found, tabs: focusWithout.confirm.tabs, ringOk: focusWithout.confirm.ringOk, active: focusWithout.confirm.active }, submit: { found: focusWithout.submit.found, tabs: focusWithout.submit.tabs, ringOk: focusWithout.submit.ringOk, active: focusWithout.submit.active } }, errRect: short(errRectW), errAbsentBeforeFocus: errAbsentFocus, backFocus, cleanFocus }));

    /* ── V12 · 动效：连续帧序列（normal） ── */
    const FRAMES_DIR = path.join(VIS, "motion-frames");
    fs.mkdirSync(FRAMES_DIR, { recursive: true });
    MOTION.framesDir = path.relative(VIS, FRAMES_DIR);
    const wizardClean = async () => { const back = await toWizard(); const filled = back.ok ? await fillToStep3(ACCT_M, ACCT_M.pw) : { ok: false }; return { back: back.ok, filled: filled.ok, absent: await errAbsent(WIZ_ERR) }; };
    MOTION.normal = await captureAppearance({ tag: "wizard-normal", errSel: WIZ_ERR, confirmSel: '[data-d3-id="setup-confirm"]', submitSel: '[data-d3-id="setup-submit"]', good: ACCT_M.pw, bad: ACCT_M.pw + "-different", reduced: false, resetToClean: wizardClean });
    record("V12a", "动效（MS:21/145/177）· 常规档：错误行 animationName=none、transitionDuration=0s；连续帧序列里 0 → 满格之间**没有中间帧**（无淡入）、末帧与首现帧矩形一致（无位移）",
      !!(MOTION.normal && MOTION.normal.ok),
      "首现帧覆盖率 >= 0.75×峰值；无 (2%,75%) 区间的中间帧；矩形不变；animationName=none / transitionDuration=0s",
      JSON.stringify(MOTION.normal));

    /* ── V12b · 减少动态效果档（真实设置面板开） ── */
    await ctx.setInput('[data-d3-id="setup-confirm"]', ACCT_M.pw);
    await waitFor(async () => ((await ctx.textOf(WIZ_ERR)) || "").trim().length === 0, 6000, 120);
    const freshM = (await toWizard()).ok;
    const setupM = await ctx.setupWizard(ACCT_M, "D5-03F 动效与布局");
    const loginM = await ctx.login(ACCT_M.id, ACCT_M.pw);
    const upM = await ctx.openSettings();
    const reducedOn = await ctx.setReduced(true);
    const resetM = await ctx.identity({ type: "identity/reset-installation", confirm: "DELETE-ALL-IDENTITY-DATA" });
    const backM = (await toWizard()).ok;
    const envReduced = await envState();
    const stReduced = await probe(WIZ_ERR);
    MOTION.reduced = await captureAppearance({ tag: "wizard-reduced", errSel: WIZ_ERR, confirmSel: '[data-d3-id="setup-confirm"]', submitSel: '[data-d3-id="setup-submit"]', good: ACCT_M.pw, bad: ACCT_M.pw + "-different", reduced: true, resetToClean: wizardClean });
    if (!freshM || !setupM.submitted || loginM !== true) note("V12b 前置（reload→建号→登录）不完全成功：" + JSON.stringify({ freshM, setup: setupM, login: loginM }));
    record("V12b", "动效（MS:21/145/177）· 减少动态效果档（真实设置面板开启 .desktop.reduced）：错误行 animationName=none、transitionDuration=0s、元素作用域 --dur-quick=0ms；帧序列同样无淡入、无位移、即时出现",
      !!(MOTION.reduced && MOTION.reduced.ok && envReduced.reduced === true && MOTION.reduced.animationName === "none" && String(MOTION.reduced.transitionDuration).split(",").every((d) => d.trim() === "0s") && MOTION.reduced.durQuick === "0ms"),
      "reduced=true；animationName=none；transitionDuration=0s；--dur-quick=0ms；帧序列无中间帧、无位移",
      JSON.stringify({ env: { dark: envReduced.dark, reduced: envReduced.reduced, glass: envReduced.glass, wallpaper: envReduced.wallpaper }, style: stReduced ? { animationName: stReduced.animationName, transitionDuration: stReduced.transitionDuration, durQuick: stReduced.durQuick } : null, setup: setupM, login: loginM, settingsUp: upM, reducedOn, resetOk: resetM?.ok, backToWizard: backM, frames: MOTION.reduced }));
    /* normal 档的 token 口径冲突：如实记（元素自身无过渡，--dur-quick 在该档是 160ms 而不是 0ms） */
    const stNormal = LAYOUT.wizard && LAYOUT.wizard.before ? LAYOUT.wizard.before.errStyle : null;
    /* computed 值可能是 ".16s" 或 "160ms"（单位由浏览器决定），先统一成 ms 再比。 */
    const durMs = (v) => { const s = String(v || "").trim(); const m = /^([\d.]+)\s*(ms|s)$/.exec(s); return m ? (m[2] === "s" ? Number(m[1]) * 1000 : Number(m[1])) : null; };
    record("V12c", "动效口径澄清 · 常规档：该行 animationName=none、transitionDuration=0s（元素自身无过渡/动画声明，即「立即出现」），但元素作用域 --dur-quick = 160ms —— 0ms 只在 .reduced 主题作用域成立（tokens.css:358）；任务口径里的「normal 与 reduced 都 --dur-quick=0ms」与实现不符，按实现如实记录",
      !!(stNormal && stNormal.animationName === "none" && stNormal.transitionDuration.split(",").every((d) => d.trim() === "0s") && durMs(stNormal.durQuick) === 160 && MOTION.reduced && durMs(MOTION.reduced.durQuick) === 0),
      "normal：animationName=none / transitionDuration=0s / --dur-quick=160ms；reduced：animationName=none / transitionDuration=0s / --dur-quick=0ms",
      JSON.stringify({ normal: stNormal, reduced: MOTION.reduced ? { animationName: MOTION.reduced.animationName, transitionDuration: MOTION.reduced.transitionDuration, durQuick: MOTION.reduced.durQuick } : null }));
    notVerified("「normal 与 reduced 下元素作用域 --dur-quick 都是 0ms」", "实现里 --dur-quick 只在 .reduced 作用域被置 0（src/design-system/tokens.css:358），常规档是 160ms（同文件 :170）。该行自身没有 transition/animation 声明，两种档位的 computed transitionDuration 都是 0s，所以「立即出现」在两种档位都成立；但任务书写的「都 0ms」与实现不符，按实现如实记录，不改成通过。");
  } catch (e) {
    FOCUS.wizard = FOCUS.wizard || { error: String((e && e.message) || e) };
    record("V10g", "布局 / 焦点 / 动效（向导面）三段未跑完", false, "四段全部完成", String((e && e.stack) || e).slice(0, 900));
  }
  await setZoom(pg(), 1).catch(() => {});

  /* ══════════ V9 · 登录页错误行（第五批从未量过对比度） ══════════ */
  const lastCell = ACTIVE_CELLS[ACTIVE_CELLS.length - 1];
  const ACCT_L = ACCT2;
  let loginInvalid = null, loginRate = null, loginEnv = null;
  try {
    /* 此刻是"已登录 + 设置窗口"，直接 reload 不会回到向导 —— 先走正式重置命令。 */
    const resetL = await ctx.identity({ type: "identity/reset-installation", confirm: "DELETE-ALL-IDENTITY-DATA" });
    const freshL = (await toWizard()).ok;
    const setupL = await ctx.setupWizard(ACCT_L, "D5-03F 登录面");
    const loginL = await ctx.login(ACCT_L.id, ACCT_L.pw);
    const out = await ctx.logout();
    loginEnv = await envState();
    const a1 = await ctx.loginAttempt(ACCT_L.id, "definitely-wrong-1");
    const st1 = await probe('[data-d3-id="auth-error"]');
    await windowShot(path.join(VIS, "login-01-invalid-credentials-window.png"));
    const c1 = await measureContrast('[data-d3-id="auth-error"]', path.join(VIS, "login-02-invalid-credentials-row.png"), st1);
    loginInvalid = { text: a1.text, style: st1, contrast: c1, resetOk: resetL?.ok === true, fresh: freshL, setup: setupL, login: loginL, logout: out };
    for (let i = 0; i < 12 && !loginRate; i += 1) {
      const a = await ctx.loginAttempt(ACCT_L.id, "definitely-wrong-" + (i + 2), { waitMs: 8000 });
      if (a.text.includes("尝试过于频繁")) { const st2 = await probe('[data-d3-id="auth-error"]'); await windowShot(path.join(VIS, "login-03-rate-limited-window.png")); const c2 = await measureContrast('[data-d3-id="auth-error"]', path.join(VIS, "login-04-rate-limited-row.png"), st2); loginRate = { attempt: i + 2, text: a.text, style: st2, contrast: c2 }; }
    }
  } catch (e) { note("登录面测量异常：" + String((e && e.message) || e)); }
  const lc = loginInvalid && loginInvalid.contrast;
  const tokenRgbL = loginInvalid && loginInvalid.style ? channelTriplet(loginInvalid.style.contentRgb) : null;
  const loginEnvOk = !!(loginEnv && loginEnv.dark === (lastCell.theme === "dark") && loginEnv.glass === lastCell.glass && loginEnv.wallpaper === lastCell.wallpaper);
  record("V9a", "登录页错误行 · 「账号或密码不正确。」：第五批从未量过对比度；该行底 = 自身 --content-rgb token 底 rgb(" + (tokenRgbL || "?") + ")、最终合成对比度 ≥ 4.5:1（配置 = " + lastCell.id + "，环境实测 " + JSON.stringify(loginEnv && { dark: loginEnv.dark, glass: loginEnv.glass, wallpaper: loginEnv.wallpaper }) + "）",
    !!(lc && !lc.error && loginInvalid.text === ctx.EXPECT.invalidCredentials && lc.ratio >= THRESHOLD && tokenRgbL && String(lc.modeRgb).replace(/ /g, "") === tokenRgbL && loginEnvOk),
    "文案 = " + ctx.EXPECT.invalidCredentials + "；mode 像素 = 该行 --content-rgb 底；ratio ≥ 4.5；环境 = 最后一格配置",
    JSON.stringify({ env: loginEnv, text: loginInvalid && loginInvalid.text, ratio: lc && round(lc.ratio), modeRgb: lc && lc.modeRgb, modeShare: lc && round(lc.modeShare, 4), textRgb: lc && lc.textRgb, bg: loginInvalid && loginInvalid.style && loginInvalid.style.backgroundColor, clip: lc && lc.clip, setup: loginInvalid && loginInvalid.setup, logout: loginInvalid && loginInvalid.logout }));
  const rc = loginRate && loginRate.contrast;
  const tokenRgbR = loginRate && loginRate.style ? channelTriplet(loginRate.style.contentRgb) : null;
  record("V9b", "登录页错误行 · 第 " + (loginRate ? loginRate.attempt : "?") + " 次限流「尝试过于频繁，请稍后再试。」：同样量对比度（RATE_LIMITED 的 detail 是对象，文案仍走白名单）",
    !!(rc && !rc.error && loginRate.text === ctx.EXPECT.rateLimited && rc.ratio >= THRESHOLD && tokenRgbR && String(rc.modeRgb).replace(/ /g, "") === tokenRgbR),
    "文案 = " + ctx.EXPECT.rateLimited + "；mode 像素 = " + lastCell.rowRgb + "；ratio ≥ 4.5",
    JSON.stringify({ attempt: loginRate && loginRate.attempt, text: loginRate && loginRate.text, ratio: rc && round(rc.ratio), modeRgb: rc && rc.modeRgb, modeShare: rc && round(rc.modeShare, 4), textRgb: rc && rc.textRgb, bg: loginRate && loginRate.style && loginRate.style.backgroundColor, clip: rc && rc.clip }));

  return { cells: MATRIX, cellsDef: CELLS, loginInvalid, loginRate, loginEnv, layout: LAYOUT, focus: FOCUS, motion: MOTION, longTextLength: LONG_TEXT.length, zooms: ZOOMS, threshold: THRESHOLD };
}

/* ── 缩放模拟：产品没有缩放 UI（菜单无 zoomIn/zoomOut 角色，渲染层也没有 zoom API），
   所以用 CDP 设备指标复现浏览器缩放的**布局效果**：CSS 视口按 1440/Z × 940/Z 缩小、
   设备像素比同步 ×Z（与真实缩放一致）。这一步如实记 notVerified 说明。 ── */
let CDP_SESSION = null, CDP_PAGE = null;
async function setZoom(pageObj, z) {
  if (CDP_PAGE !== pageObj || !CDP_SESSION) { CDP_SESSION = await pageObj.context().newCDPSession(pageObj); CDP_PAGE = pageObj; }
  const cdp = CDP_SESSION;
  if (z === 1) await cdp.send("Emulation.clearDeviceMetricsOverride");
  else await cdp.send("Emulation.setDeviceMetricsOverride", { width: Math.round(1440 / z), height: Math.round(940 / z), deviceScaleFactor: 2 * z, mobile: false });
  return true;
}

module.exports = { CELLS, runMatrix, setZoom, wcag, lum, parseRgb, channelTriplet, rectsIntersect, outset, round, short, THRESHOLD };
