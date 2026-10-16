/**
 * 照片应用视觉/动效探针 · 真实 electron + 隔离 userData + CDP 的公共底座。
 *
 * 方法与断言口径照搬 experiments/dxos-ui-real/run-all.mjs（绝不修改该文件）：
 *   · --user-data-dir=<临时目录> 启动真实产品入口，绝不动 ~/Library/Application Support/openarc-os；
 *   · CDP Emulation.setDeviceMetricsOverride 把视图钉到目标尺寸 + deviceScaleFactor 2；
 *   · 外观（主题 / 减少动态 / 材质）一律走真实设置面板，并校验 .desktop 的 dark/reduced/data-glass；
 *   · 每张截图都断言像素尺寸；收工快照比对真实 profile（只读 stat + sha256）。
 *
 * 与 ui-real 的差异只有一处，且是必须的：当前 electron/main.cjs 默认加载 dist/vue.html
 * （Vue 壳），而 appId=photos 的「照片」双视图（图库 / 图像工坊）只存在于 dist/index.html
 * （React 入口，electron/main.cjs:192 的 OA_UI=react）。本底座按 OA_PHOTOS_UI_ENTRY
 * 选择入口，默认 react；默认壳的观察另有专项探针（见 run-all.mjs）。
 *
 * 硬约束：不联网（只连本机 CDP）；不改产品代码；每步失败都记成 FAIL 而不是静默跳过。
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const nowIso = () => new Date().toISOString();

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

export async function waitFor(fn, timeoutMs, stepMs) {
  const step = stepMs || 150;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (await fn()) return true; } catch (err) { /* 重试 */ }
    if (Date.now() >= deadline) return false;
    await sleep(step);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   真实 profile 只读快照（绝不打开 SQLite）
   ══════════════════════════════════════════════════════════════════════════ */
export function resolveRealProfilePath() {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "openarc-os");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "openarc-os");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "openarc-os");
}
function statOf(p) {
  try { const s = fs.statSync(p); return { exists: true, mtimeMs: Math.round(s.mtimeMs), size: s.size, ino: s.ino }; }
  catch (err) { return { exists: false }; }
}
function sha256File(p) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } catch (err) { return null; }
}
export function snapshotProfile(dir) {
  const out = { path: dir, exists: fs.existsSync(dir), dir: statOf(dir), identity: {}, topLevel: {} };
  for (const name of ["identity.db", "identity.db-wal", "identity.db-shm"]) {
    const abs = path.join(dir, name);
    const st = statOf(abs);
    out.identity[name] = st.exists ? Object.assign({}, st, { sha256: sha256File(abs) }) : st;
  }
  try {
    for (const name of fs.readdirSync(dir)) {
      const st = statOf(path.join(dir, name));
      out.topLevel[name] = { mtimeMs: st.mtimeMs, size: st.size };
    }
  } catch (err) { /* 目录不存在 */ }
  return out;
}
export function diffProfile(before, after) {
  const changed = [];
  let identityUnchanged = true;
  for (const name of new Set(Object.keys(before.identity).concat(Object.keys(after.identity)))) {
    if (JSON.stringify(before.identity[name] || null) !== JSON.stringify(after.identity[name] || null)) {
      identityUnchanged = false;
      changed.push("identity/" + name);
    }
  }
  for (const name of new Set(Object.keys(before.topLevel).concat(Object.keys(after.topLevel)))) {
    if (JSON.stringify(before.topLevel[name] || null) !== JSON.stringify(after.topLevel[name] || null)) changed.push("topLevel/" + name);
  }
  if (JSON.stringify(before.dir || null) !== JSON.stringify(after.dir || null)) changed.push("dir");
  return { identityUnchanged, unchanged: changed.length === 0, changed, changedCount: changed.length };
}
export function processesUsing(dir) {
  try {
    const text = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    return text.split("\n").filter((line) => line.includes(dir)).map((line) => line.trim().slice(0, 200)).slice(0, 20);
  } catch (err) { return []; }
}

/* ══════════════════════════════════════════════════════════════════════════
   截图原语
   ══════════════════════════════════════════════════════════════════════════ */
export async function shoot(cdp, file) {
  const res = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(res.data, "base64"));
  const buf = fs.readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}
export async function shootClip(cdp, file, rect, scale) {
  const res = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    clip: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.max(1, rect.width), height: Math.max(1, rect.height), scale: scale || 1 },
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(res.data, "base64"));
  const buf = fs.readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

/* ══════════════════════════════════════════════════════════════════════════
   DOM / 桥原语
   ══════════════════════════════════════════════════════════════════════════ */
export function windowSelector(label) {
  return 'section.window[aria-label="' + label + '"]';
}

export async function callBridge(page, channel, command, payload) {
  const started = Date.now();
  const res = await page.evaluate(async (arg) => {
    const api = window.openarc[arg.channel];
    if (!api || typeof api.command !== "function") return { __threw: true, message: "no bridge " + arg.channel };
    /* identity 域用 {type,...}，其余域用 {command,payload}（与 preload 的真实契约一致）。 */
    const request = arg.channel === "identity" ? Object.assign({ type: arg.command }, arg.payload) : { command: arg.command, payload: arg.payload };
    try { return await api.command(request); } catch (err) { return { __threw: true, message: String((err && err.message) || err) }; }
  }, { channel: channel, command: command, payload: payload || {} });
  return { ms: Date.now() - started, result: res };
}

export async function clickSelector(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  }, selector);
}

/** 按可见文本点击某容器内的按钮（照片子视图切换 / 设置分段控件都用它）。 */
export async function clickText(page, containerSel, text, tagName) {
  return page.evaluate((arg) => {
    const scope = document.querySelector(arg.sel);
    if (!scope) return false;
    const nodes = Array.prototype.slice.call(scope.querySelectorAll(arg.tag || "button"));
    for (let i = 0; i < nodes.length; i += 1) {
      if ((nodes[i].textContent || "").trim() === arg.text) { nodes[i].click(); return true; }
    }
    return false;
  }, { sel: containerSel, text: text, tag: tagName || "button" });
}

/* ══════════════════════════════════════════════════════════════════════════
   外观切换：全部走真实设置面板
   ══════════════════════════════════════════════════════════════════════════ */
export const SETTINGS_LABEL = "系统设置窗口";
export async function openSettings(page) {
  await clickSelector(page, '.dock-item[data-dock-id="settings"]');
  const ok = await waitFor(() => page.$(windowSelector(SETTINGS_LABEL)), 12000, 200);
  if (!ok) return false;
  await clickSelector(page, windowSelector(SETTINGS_LABEL) + ' [data-settings-pane="appearance"]');
  await sleep(150);
  return true;
}
export async function closeSettings(page) {
  await clickSelector(page, windowSelector(SETTINGS_LABEL) + " .close");
  await waitFor(async () => !(await page.$(windowSelector(SETTINGS_LABEL))), 5000, 150);
}

export async function setTheme(page, theme) {
  const okOpen = await openSettings(page);
  if (!okOpen) return false;
  const text = theme === "dark" ? "深色" : "浅色";
  const clicked = await clickText(page, windowSelector(SETTINGS_LABEL) + ' [aria-label="外观"]', text);
  const themed = clicked && await waitFor(async () => await page.evaluate(() => {
    const d = document.querySelector(".desktop");
    return d ? d.classList.contains("dark") : null;
  }) === (theme === "dark"), 5000, 100);
  await closeSettings(page);
  return themed;
}

/** reduced = 应用内「减少动态效果」开关（与系统 prefers-reduced-motion 独立，见 MOTION §8）。 */
export async function setReduced(page, on) {
  const okOpen = await openSettings(page);
  if (!okOpen) return false;
  const clicked = await page.evaluate((arg) => {
    const win = document.querySelector(arg.sel);
    if (!win) return false;
    const sw = win.querySelector('button[role="switch"][aria-label="减少动态效果"]');
    if (!sw) return false;
    const checked = sw.getAttribute("aria-checked") === "true";
    if (checked !== arg.on) sw.click();
    return true;
  }, { sel: windowSelector(SETTINGS_LABEL), on: on });
  const settled = clicked && await waitFor(async () => await page.evaluate((want) => {
    const d = document.querySelector(".desktop");
    return d ? d.classList.contains("reduced") === want : false;
  }, on) , 4000, 100);
  await closeSettings(page);
  return settled;
}

/** 材质三档：完整玻璃 / 降低材质 / 实色（实色 = 原「减少透明度」，MOTION §8）。 */
export const GLASS_TEXT = { full: "完整玻璃", reduced: "降低材质", solid: "实色" };
export async function setGlass(page, mode) {
  const okOpen = await openSettings(page);
  if (!okOpen) return false;
  const clicked = await clickText(page, windowSelector(SETTINGS_LABEL) + ' [aria-label="材质"]', GLASS_TEXT[mode]);
  const settled = clicked && await waitFor(async () => await page.evaluate((want) => {
    const d = document.querySelector(".desktop");
    return d ? d.getAttribute("data-glass") === want : false;
  }, mode), 4000, 100);
  await closeSettings(page);
  return settled;
}

/* ══════════════════════════════════════════════════════════════════════════
   视口 / 窗口
   ══════════════════════════════════════════════════════════════════════════ */
export async function setViewport(page, cdp, size, winSel, areaTop) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: size.dsf, mobile: false });
  await sleep(120);
  /* 真实窗口用显式 px 边界（components.tsx: style={{width: w.bounds.w}}），
     缩小视图后必须重新最大化才会按新视图重算边界，否则右侧被裁掉。 */
  const label = await page.evaluate((sel) => {
    const b = document.querySelector(sel + " .maximize");
    return b ? b.getAttribute("aria-label") : null;
  }, winSel);
  if (label && label.indexOf("还原") === 0) {
    await clickSelector(page, winSel + " .maximize");
    await sleep(220);
  }
  await clickSelector(page, winSel + " .maximize");
  const fitted = await waitFor(async () => {
    const r = await page.evaluate((sel) => {
      const w = document.querySelector(sel);
      if (!w) return null;
      const b = w.getBoundingClientRect();
      return [b.x, b.y, b.width, b.height];
    }, winSel);
    return !!r && Math.abs(r[2] - size.width) < 4 && Math.abs(r[3] - (size.height - areaTop)) < 8;
  }, 6000, 150);
  await sleep(180);
  return fitted;
}

export async function focusWindow(page, winSel) {
  return page.evaluate((sel) => {
    const win = document.querySelector(sel);
    if (!win) return false;
    win.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
    return true;
  }, winSel);
}

export async function isTopmost(page, winSel) {
  return page.evaluate((sel) => {
    const win = document.querySelector(sel);
    if (!win) return false;
    const mine = Number(getComputedStyle(win).zIndex) || 0;
    let max = -1;
    const all = document.querySelectorAll("section.window");
    for (let i = 0; i < all.length; i += 1) max = Math.max(max, Number(getComputedStyle(all[i]).zIndex) || 0);
    return mine >= max;
  }, winSel);
}

/* ══════════════════════════════════════════════════════════════════════════
   被测应用内的度量 / 扫描
   ══════════════════════════════════════════════════════════════════════════ */
export const APP_SEL = '[data-photos-app="1"]';

export async function measureApp(page, viewport) {
  return page.evaluate((arg) => {
    const app = document.querySelector(arg.app);
    if (!app) return null;
    const rectOf = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    };
    const win = app.closest("section.window");
    const root = app.querySelector("[data-photos-lib]") || app.querySelector("[data-photos-studio]");
    const pageStates = Array.prototype.slice.call(app.querySelectorAll('[data-ds-comp="page-state"]')).map((el) => ({
      kind: el.getAttribute("data-ds-kind"),
      title: ((el.querySelector(".ds-page-state__title") || {}).textContent || "").trim(),
      rect: rectOf(el),
    }));
    const badges = Array.prototype.slice.call(app.querySelectorAll('[data-ds-comp="badge"]')).map((el) => (el.textContent || "").trim());
    /* 窄窗证据：只统计「真正被裁」的两类，避免把滚动容器里正常超出一屏的内容误判成裁切。
       a) 水平越界：叶子元素右边缘超出视口，且祖先里没有任何横向可滚动容器；
       b) 容器横向裁断：容器 scrollWidth > clientWidth 且 overflow-x 不是 auto/scroll（内容被 hidden/visible 切掉）。 */
    const vw = arg.viewport.width;
    const isHorizScrollable = (el) => {
      let p = el.parentElement;
      while (p && p !== document.body) {
        const cs = getComputedStyle(p);
        if (cs.overflowX === "auto" || cs.overflowX === "scroll") return true;
        p = p.parentElement;
      }
      return false;
    };
    const horizontalClipped = [];
    const all = app.querySelectorAll("*");
    for (let i = 0; i < all.length; i += 1) {
      const el = all[i];
      if (el.children.length) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.right > vw + 1.5 && !isHorizScrollable(el)) {
        horizontalClipped.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 60), text: (el.textContent || "").trim().slice(0, 40), right: Math.round(r.right), bottom: Math.round(r.bottom) });
        if (horizontalClipped.length >= 25) break;
      }
    }
    /* 三栏骨架是否在窄窗里互相压叠：相邻 pane 的包围盒同时横向/纵向重叠 > 1px。 */
    const paneOverlaps = [];
    for (const rootSel of [".photos-lib", ".photos-studio"]) {
      const root = app.querySelector(rootSel);
      if (!root) continue;
      const kids = Array.prototype.slice.call(root.children)
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0);
      for (let i = 1; i < kids.length; i += 1) {
        const a = kids[i - 1];
        const b = kids[i];
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapX > 1 && overlapY > 1) {
          paneOverlaps.push({
            root: rootSel, pair: (i - 1) + "->" + i,
            overlapX: Math.round(overlapX), overlapY: Math.round(overlapY),
            a: [Math.round(a.left), Math.round(a.top), Math.round(a.width), Math.round(a.height)],
            b: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
          });
        }
      }
    }
    /* 原始证据：越过视口右缘的叶子元素（不做可用性判断，只记录是否有可横滚祖先）。 */
    const overflowBeyondViewport = [];
    for (let i = 0; i < all.length; i += 1) {
      const el = all[i];
      if (el.children.length) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.right > vw + 1.5) {
        overflowBeyondViewport.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 50), text: (el.textContent || "").trim().slice(0, 30), right: Math.round(r.right), scrollableAncestor: isHorizScrollable(el) });
        if (overflowBeyondViewport.length >= 25) break;
      }
    }
    /* 真正的内容溢出：叶子元素越出所属 pane 的包围盒，且它到 pane 之间没有任何可滚动祖先
       （有滚动祖先的越界是滚动内容，不算缺陷）。窄窗 1 列布局下 side pane 有 max-height，
       面板外的提示段会落进这一条。 */
    const realOverflow = [];
    for (const rootSel of [".photos-lib", ".photos-studio"]) {
      const root = app.querySelector(rootSel);
      if (!root) continue;
      for (let pi = 0; pi < root.children.length; pi += 1) {
        const pane = root.children[pi];
        const pr = pane.getBoundingClientRect();
        if (pr.width <= 0 || pr.height <= 0) continue;
        const leaves = pane.querySelectorAll("*");
        for (let li = 0; li < leaves.length; li += 1) {
          const el = leaves[li];
          if (el.children.length) continue;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          let scrollable = false;
          let p = el.parentElement;
          while (p && p !== root.parentElement) {
            const cs = getComputedStyle(p);
            if (cs.overflowY === "auto" || cs.overflowY === "scroll" || cs.overflowX === "auto" || cs.overflowX === "scroll") { scrollable = true; break; }
            p = p.parentElement;
          }
          if (scrollable) continue;
          if (r.right > pr.right + 1.5 || r.left < pr.left - 1.5 || r.bottom > pr.bottom + 1.5 || r.top < pr.top - 1.5) {
            realOverflow.push({
              root: rootSel, paneIndex: pi, paneCls: String(pane.className).slice(0, 60),
              tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 50), text: (el.textContent || "").trim().slice(0, 30),
              sides: { top: r.top < pr.top - 1.5, left: r.left < pr.left - 1.5, right: r.right > pr.right + 1.5, bottom: r.bottom > pr.bottom + 1.5 },
              rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
              paneRect: [Math.round(pr.left), Math.round(pr.top), Math.round(pr.width), Math.round(pr.height)],
              escapePx: Math.round(Math.max(r.right - pr.right, pr.left - r.left, r.bottom - pr.bottom, pr.top - r.top)),
            });
            if (realOverflow.length >= 30) break;
          }
        }
        if (realOverflow.length >= 30) break;
      }
    }
    const containerCut = [];
    const verticalCut = [];
    const containers = app.querySelectorAll(".photos-view, .photos-lib, .photos-studio, .photos-pane, .photos-scroll, .photos-grid, .photos-studio-detail, .photos-inspector");
    for (let i = 0; i < containers.length; i += 1) {
      const c = containers[i];
      const cs = getComputedStyle(c);
      const cutX = c.scrollWidth - c.clientWidth;
      if (cutX > 2 && cs.overflowX !== "auto" && cs.overflowX !== "scroll") {
        containerCut.push({ cls: String(c.className).slice(0, 70), overflowX: cs.overflowX, scrollWidth: c.scrollWidth, clientWidth: c.clientWidth, cutPx: cutX });
      }
      const cutY = c.scrollHeight - c.clientHeight;
      if (cutY > 2 && cs.overflowY !== "auto" && cs.overflowY !== "scroll") {
        verticalCut.push({ cls: String(c.className).slice(0, 70), overflowY: cs.overflowY, scrollHeight: c.scrollHeight, clientHeight: c.clientHeight, cutPx: cutY });
      }
    }
    return {
      windowLabel: win ? win.getAttribute("aria-label") : null,
      windowRect: rectOf(win),
      appRect: rectOf(app),
      tab: app.querySelector("[data-photos-tab]") ? app.querySelector("[data-photos-tab]").getAttribute("data-photos-tab") : null,
      state: root ? root.getAttribute("data-photos-state") : null,
      rootKind: root ? (root.hasAttribute("data-photos-lib") ? "library" : "studio") : null,
      counts: {
        sources: app.querySelectorAll(".photos-lib-side .photos-row").length,
        cards: app.querySelectorAll(".photos-card").length,
        projects: app.querySelectorAll(".photos-project").length,
        trashRows: app.querySelectorAll(".photos-trash-row").length,
        treeRows: app.querySelectorAll(".photos-list > .photos-row").length,
        buttons: app.querySelectorAll("button").length,
        badges: badges.length,
      },
      badges: badges.slice(0, 20),
      pageStates: pageStates,
      texts: {
        count: (app.querySelector(".photos-count") || {}).textContent || "",
        errorCode: app.querySelector("[data-photos-error-code]") ? app.querySelector("[data-photos-error-code]").getAttribute("data-photos-error-code") : null,
        errorText: (app.querySelector("[data-photos-error-code]") || {}).textContent || "",
        visionUnavailable: !!app.querySelector("[data-photos-vision-unavailable]"),
        removalError: app.querySelector("[data-photos-removal-error]") ? app.querySelector("[data-photos-removal-error]").getAttribute("data-photos-removal-error") : null,
        promptError: app.querySelector("[data-photos-prompt-error]") ? app.querySelector("[data-photos-prompt-error]").getAttribute("data-photos-prompt-error") : null,
        readonly: !!app.querySelector("[data-photos-readonly]"),
        targetsState: app.querySelector("[data-photos-targets-state]") ? app.querySelector("[data-photos-targets-state]").getAttribute("data-photos-targets-state") : null,
        detail: app.querySelector("[data-photos-detail]") ? "photo" : app.querySelector("[data-photos-project-detail]") ? "project" : null,
      },
      horizontalClipped: horizontalClipped,
      horizontalClippedCount: horizontalClipped.length,
      paneOverlaps: paneOverlaps,
      paneOverlapCount: paneOverlaps.length,
      realOverflow: realOverflow,
      realOverflowCount: realOverflow.length,
      overflowBeyondViewport: overflowBeyondViewport,
      overflowBeyondViewportCount: overflowBeyondViewport.length,
      containerCut: containerCut,
      containerCutCount: containerCut.length,
      verticalCut: verticalCut,
      verticalCutCount: verticalCut.length,
      text: (app.innerText || "").replace(/\s*\n\s*/g, " | ").slice(0, 900),
    };
  }, { app: APP_SEL, viewport: viewport });
}

/** DS-A09：计算样式扫描（彩色强调 / 发丝线框 / 品牌蓝）。 */
export async function scanDS09(page) {
  return page.evaluate((appSel) => {
    const app = document.querySelector(appSel);
    if (!app) return null;
    const MONO = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/;
    function rgb(text) {
      if (!text || text === "transparent") return null;
      const m = String(text).match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const parts = m[1].split(/[,\/\s]+/).filter(Boolean).map(Number);
      if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length >= 4 ? parts[3] : 1 };
    }
    function hsl(c) {
      const r = c.r / 255, g = c.g / 255, b = c.b / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const l = (max + min) / 2;
      const d = max - min;
      if (d === 0) return { h: 0, s: 0, l: l };
      const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      let h;
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
      return { h: h * 360, s: s, l: l };
    }
    const colorBuckets = {};
    const saturated = [];
    const hairlines = [];
    const shadows = [];
    const all = app.querySelectorAll("*");
    for (let i = 0; i < all.length; i += 1) {
      const el = all[i];
      const cs = getComputedStyle(el);
      const desc = el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(/\s+/).slice(0, 3).join(".") : "") + (el.getAttribute("aria-label") ? '["' + el.getAttribute("aria-label") + '"]' : "");
      const props = { color: cs.color, "background-color": cs.backgroundColor, "border-top-color": cs.borderTopColor, "border-left-color": cs.borderLeftColor, "border-right-color": cs.borderRightColor, "border-bottom-color": cs.borderBottomColor, outlineColor: cs.outlineColor, "text-decoration-color": cs.textDecorationColor };
      for (const key of Object.keys(props)) {
        const raw = props[key];
        const c = rgb(raw);
        if (!c || c.a < 0.06) continue;
        const h = hsl(c);
        const bucket = Math.round(h.h / 15) * 15 + "|" + key;
        colorBuckets[bucket] = colorBuckets[bucket] || { count: 0, sample: raw, hue: Math.round(h.h), sat: Math.round(h.s * 100), light: Math.round(h.l * 100) };
        colorBuckets[bucket].count += 1;
        if (h.s > 0.25 && h.l > 0.08 && h.l < 0.94) {
          saturated.push({ desc: desc, prop: key, value: raw, hue: Math.round(h.h), sat: Math.round(h.s * 100), light: Math.round(h.l * 100) });
        }
      }
      const widths = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map((w) => parseFloat(w) || 0);
      const sides = ["border-top-color", "border-right-color", "border-bottom-color", "border-left-color"];
      for (let k = 0; k < 4; k += 1) {
        if (widths[k] > 0 && widths[k] <= 1.2) {
          const c = rgb(props[sides[k]]);
          if (c && c.a > 0.02) { hairlines.push({ desc: desc, side: sides[k], width: widths[k], color: props[sides[k]] }); break; }
        }
      }
      if (cs.boxShadow && cs.boxShadow !== "none" && /(^|,)\s*(rgb|rgba)\(/.test(cs.boxShadow) && / 0px 0px 0px 1px | 0 0 0 1px /.test(cs.boxShadow)) {
        shadows.push({ desc: desc, shadow: cs.boxShadow.slice(0, 120) });
      }
    }
    const buckets = Object.keys(colorBuckets).map((k) => Object.assign({ bucket: k }, colorBuckets[k])).sort((a, b) => b.count - a.count);
    const blue = saturated.filter((s) => s.hue >= 180 && s.hue <= 260);
    return {
      scannedElements: all.length,
      distinctColorBuckets: buckets.length,
      saturatedCount: saturated.length,
      saturatedSamples: saturated.slice(0, 30),
      blueCount: blue.length,
      blueSamples: blue.slice(0, 20),
      hairlineCount: hairlines.length,
      hairlineSamples: hairlines.slice(0, 30),
      hairlineBuckets: (function () {
        const m = {};
        for (const h of hairlines) { m[h.color] = (m[h.color] || 0) + 1; }
        return Object.keys(m).map((k) => ({ color: k, count: m[k] })).sort((a, b) => b.count - a.count);
      })(),
      boxShadowHairlineCount: shadows.length,
      boxShadowHairlineSamples: shadows.slice(0, 10),
      topColorBuckets: buckets.slice(0, 20),
    };
  }, APP_SEL);
}

/** 主题 token 在读值（DS-A01 的映射证据）。 */
export async function dumpTokens(page) {
  return page.evaluate(() => {
    const el = document.querySelector(".desktop") || document.documentElement;
    const cs = getComputedStyle(el);
    const names = ["--text", "--muted", "--placeholder", "--accent", "--on-accent", "--focus", "--failed", "--line", "--surface", "--content", "--sunken", "--success", "--warning", "--base"];
    const out = {};
    for (const n of names) out[n] = cs.getPropertyValue(n).trim();
    const body = getComputedStyle(document.body);
    out["body-background"] = body.backgroundColor;
    out["body-color"] = body.color;
    out["desktop-dark"] = el.classList.contains("dark");
    out["desktop-reduced"] = el.classList.contains("reduced");
    out["desktop-glass"] = el.getAttribute("data-glass");
    return out;
  });
}

export async function activeElementInfo(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    const inApp = !!el.closest('[data-photos-app="1"]');
    const dialog = el.closest('[role="dialog"]');
    const app = document.querySelector('[data-photos-app="1"]');
    const appRect = app ? app.getBoundingClientRect() : null;
    return {
      tag: el.tagName.toLowerCase(),
      cls: String(el.className).slice(0, 90),
      aria: el.getAttribute("aria-label") || "",
      role: el.getAttribute("role") || "",
      type: el.getAttribute("type") || "",
      text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 50),
      inPhotos: inApp,
      inDialog: !!dialog,
      dialogLabel: dialog ? dialog.getAttribute("aria-label") : null,
      inViewport: !!(el.getBoundingClientRect && el.getBoundingClientRect().width > 0),
      appPresent: !!app,
      appRect: appRect ? [Math.round(appRect.x), Math.round(appRect.y), Math.round(appRect.width), Math.round(appRect.height)] : null,
    };
  });
}

/** 采样「最终合成背景」并测文本对比（DS-A04）。 */
export async function sampleContrast(page, cdp, opts) {
  const candidates = await page.evaluate((arg) => {
    const app = document.querySelector(arg.app);
    if (!app) return [];
    const out = [];
    const seen = new Set();
    const nodes = app.querySelectorAll("h1,h2,h3,p,span,dt,dd,button,label,strong,li");
    for (let i = 0; i < nodes.length; i += 1) {
      const el = nodes[i];
      const text = (el.textContent || "").trim();
      if (!text || text.length > 90) continue;
      const childText = Array.prototype.some.call(el.children, (c) => (c.textContent || "").trim().length > 0);
      if (childText) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.height < 9) continue;
      if (r.bottom < 0 || r.top > arg.viewport.height) continue;
      if (r.right < 0 || r.left > arg.viewport.width) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      if (parseFloat(cs.opacity || "1") < 0.55) continue;
      const key = Math.round(r.x) + "," + Math.round(r.y) + "," + Math.round(r.width);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        rect: [r.x, r.y, r.width, r.height],
        text: text.slice(0, 40),
        color: cs.color,
        fontSize: parseFloat(cs.fontSize),
        fontWeight: cs.fontWeight,
        tag: el.tagName.toLowerCase(),
        cls: String(el.className).slice(0, 70),
        aria: el.getAttribute("aria-label") || "",
      });
      if (out.length >= 26) break;
    }
    return out;
  }, { app: APP_SEL, viewport: opts.viewport });
  if (!candidates.length) return { candidates: [], backgrounds: [], rows: [] };
  await page.evaluate(() => {
    const s = document.createElement("style");
    s.id = "__oa_hide_text";
    s.textContent = "*{color:transparent !important;text-shadow:none !important;}";
    document.head.appendChild(s);
  });
  await sleep(80);
  const res = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await page.evaluate(() => { const s = document.getElementById("__oa_hide_text"); if (s) s.remove(); });
  const backgrounds = await page.evaluate(async (arg) => {
    const img = new Image();
    img.src = "data:image/png;base64," + arg.b64;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const scale = img.width / arg.viewport.width;
    return arg.candidates.map((c) => {
      const x0 = Math.max(0, Math.floor(c.rect[0] * scale) + 2);
      const x1 = Math.min(canvas.width, Math.ceil((c.rect[0] + c.rect[2]) * scale) - 2);
      const y0 = Math.max(0, Math.floor(c.rect[1] * scale) + 2);
      const y1 = Math.min(canvas.height, Math.ceil((c.rect[1] + c.rect[3]) * scale) - 2);
      const pts = [];
      const nx = Math.max(2, Math.min(5, x1 - x0));
      const ny = Math.max(2, Math.min(3, y1 - y0));
      for (let i = 0; i < nx; i += 1) {
        for (let j = 0; j < ny; j += 1) {
          const x = Math.round(x0 + ((x1 - x0) * i) / (nx - 1));
          const y = Math.round(y0 + ((y1 - y0) * j) / (ny - 1));
          const d = ctx.getImageData(x, y, 1, 1).data;
          pts.push([d[0], d[1], d[2]]);
        }
      }
      pts.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
      const mid = pts[Math.floor(pts.length / 2)];
      return { bg: { r: mid[0], g: mid[1], b: mid[2] }, scale: Math.round(scale * 100) / 100 };
    });
  }, { b64: res.data, candidates: candidates, viewport: opts.viewport });
  return { candidates: candidates, backgrounds: backgrounds };
}

/**
 * 动效帧序列：Page.startScreencast 连续取帧 + 页内 rAF 记录被跟踪元素的位置。
 * 返回 { frames, intervals, tracker }。帧间隔在断言里必须 <= 50ms。
 */
export async function captureMotionFrames(cdp, page, outDir, trackedSelectors, actionFn, totalMs) {
  fs.mkdirSync(outDir, { recursive: true });
  const frames = [];
  let triggerAt = null;
  const started = Date.now();
  const onFrame = async (f) => {
    const t = Date.now() - started;
    frames.push({ index: frames.length, t: t, ts: f.metadata && f.metadata.timestamp, file: null });
    const file = path.join(outDir, "frame-" + String(frames.length - 1).padStart(3, "0") + ".png");
    try { fs.writeFileSync(file, Buffer.from(f.data, "base64")); } catch (err) { /* 磁盘失败不中断取帧 */ }
    frames[frames.length - 1].file = path.relative(path.dirname(outDir), file);
    try { await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }); } catch (err) { /* 已停止 */ }
  };
  cdp.on("Page.screencastFrame", onFrame);
  await page.evaluate((sels) => {
    window.__oaMotion = null;
    const samples = [];
    const t0 = performance.now();
    const rectOf = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return [Math.round(r.x * 10) / 10, Math.round(r.y * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10];
    };
    const tick = () => {
      const row = { t: Math.round(performance.now() - t0) };
      for (const s of sels) row[s] = rectOf(s);
      samples.push(row);
      window.__oaMotion = samples;
      if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, trackedSelectors);
  /* CDP screencast 是「有损坏才出帧」：页面静止时（尤其是减少动态效果下）会掉到几帧、
     间隔几百毫秒，无法满足 <=50ms 的连续帧要求。这里注入一个 1x1、pointer-events:none 的
     心跳元素，每帧在 #000 与 #010101 之间切换（肉眼不可见的 1 级差）制造合成器损坏，
     让取帧稳定在刷新率；取完即移除。它只存在于动效取证窗口，静态截图不受影响。 */
  await page.evaluate(() => {
    let el = document.getElementById("__oa_heartbeat");
    if (!el) {
      el = document.createElement("div");
      el.id = "__oa_heartbeat";
      el.setAttribute("aria-hidden", "true");
      el.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;z-index:2147483647;background:#000;";
      document.body.appendChild(el);
    }
    window.__oaHeartbeatStop = false;
    let on = false;
    const tick = () => {
      if (window.__oaHeartbeatStop) return;
      on = !on;
      el.style.backgroundColor = on ? "#000000" : "#010101";
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: 720, maxHeight: 450, quality: 90 });
  await sleep(350);
  triggerAt = Date.now() - started;
  if (actionFn) await actionFn();
  await sleep(Math.max(200, totalMs - 350));
  await cdp.send("Page.stopScreencast");
  try { cdp.off("Page.screencastFrame", onFrame); } catch (err) { /* ignore */ }
  try { await page.evaluate(() => { window.__oaHeartbeatStop = true; const el = document.getElementById("__oa_heartbeat"); if (el) el.remove(); }); } catch (err) { /* ignore */ }
  await sleep(120);
  const tracker = await page.evaluate(() => window.__oaMotion);
  const intervals = [];
  for (let i = 1; i < frames.length; i += 1) intervals.push(frames[i].t - frames[i - 1].t);
  const sorted = intervals.slice().sort((a, b) => a - b);
  const over50 = intervals.filter((v) => v > 50);
  const withFiles = frames.filter((f) => f.file);
  return {
    frames: withFiles,
    frameCount: withFiles.length,
    triggerAt: triggerAt,
    intervals: intervals,
    maxIntervalMs: intervals.length ? Math.max.apply(null, intervals) : null,
    p95IntervalMs: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null,
    over50Count: over50.length,
    over50Ratio: intervals.length ? over50.length / intervals.length : null,
    over50Samples: over50.slice(0, 8),
    meanIntervalMs: intervals.length ? Math.round((intervals.reduce((a, b) => a + b, 0) / intervals.length) * 100) / 100 : null,
    tracker: tracker || null,
  };
}

/** 从 rAF 采样推导是否出现布局补间（同一元素出现 >=3 个不同位置且逐步过渡）。 */
export function analyzeTween(tracker, selectors) {
  const out = {};
  if (!Array.isArray(tracker)) return out;
  for (const sel of selectors) {
    const positions = [];
    for (const row of tracker) {
      const v = row[sel];
      if (!v) continue;
      const key = v.join(",");
      if (!positions.length || positions[positions.length - 1].key !== key) positions.push({ key: key, t: row.t, rect: v });
    }
    let maxStep = 0;
    for (let i = 1; i < positions.length; i += 1) {
      const a = positions[i - 1].rect;
      const b = positions[i].rect;
      maxStep = Math.max(maxStep, Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2]), Math.abs(b[3] - a[3]));
    }
    out[sel] = {
      distinctPositions: positions.length,
      moving: positions.length >= 2,
      tween: positions.length >= 3,
      maxStepPx: Math.round(maxStep * 10) / 10,
      positions: positions.slice(0, 24).map((p) => ({ t: p.t, rect: p.rect })),
    };
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   真实 electron 启动 / 连接 / 收工
   ══════════════════════════════════════════════════════════════════════════ */
export async function launchElectron(opts) {
  const { ROOT, electronPath, chromium, userDataDir, env } = opts;
  const port = await freePort();
  const launchArgs = [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + port];
  const launchCommand = "electron . --user-data-dir=<isolated-temp> --remote-debugging-port=" + port + (env.OA_UI ? " (OA_UI=" + env.OA_UI + ")" : " (默认壳)");
  const child = spawn(electronPath, launchArgs, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += String(d); });
  child.stderr.on("data", (d) => { stderr += String(d); });
  const ready = await waitFor(async () => { try { const r = await fetch("http://127.0.0.1:" + port + "/json/version"); return r.ok; } catch (err) { return false; } }, 60000, 300);
  if (!ready) {
    try { child.kill("SIGKILL"); } catch (err) { /* ignore */ }
    throw new Error("CDP 未就绪：" + stderr.slice(-500));
  }
  const browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
  return { child: child, browser: browser, port: port, launchCommand: launchCommand, out: () => ({ stdout: stdout, stderr: stderr }) };
}

export async function awaitExit(child, timeoutMs) {
  const ended = await waitFor(() => child.exitCode != null || child.signalCode != null, timeoutMs || 20000, 200);
  if (!ended) {
    try { child.kill("SIGTERM"); } catch (err) { /* ignore */ }
    await waitFor(() => child.exitCode != null || child.signalCode != null, 5000, 200);
  }
  return { exited: ended, code: child.exitCode == null ? null : child.exitCode, signal: child.signalCode || null };
}

export function findThumbCacheDirs(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6 || found.length > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name === "photo-thumbnails") { found.push(full); continue; }
      walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}
