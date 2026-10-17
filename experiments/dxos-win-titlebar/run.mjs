#!/usr/bin/env node
/**
 * Windows 自绘 caption（方案 B）· 真机验收
 *
 * 启动**真实** electron/main.cjs + preload.cjs + dist/vue.html，用隔离 userData 与唯一 CDP 端口，
 * 经真实产品桥完成首启 + 登录，然后：
 *
 *   win32 布局（OA_FORCE_PLATFORM=win32，在 macOS 上模拟 Windows chrome）：
 *     · 三枚 46×38 满高 caption 贴右上角；右侧入口整体左移；
 *     · 浅 / 深两套外观的常态与最大化截图；
 *     · hover 6% 中性、close hover #c42b1c + 白字形、键盘焦点环；
 *     · 真的点击最大化 → 主进程 isMaximized() 为真 + 图标切「还原」→ 再点还原；
 *     · 真的点击关闭 → 主进程日志留证 + 进程退出（exit 0）。
 *
 *   win32 最小化（第二次独立启动，避免"最小化后无法再点击"污染测量）：
 *     · 真的点击最小化 → 主进程 isMinimized() 为真（窗口不可见）。
 *
 *   darwin 真实平台（不设环境变量，macOS 原生红绿灯）：
 *     · 0 枚自绘 caption、顶栏左侧 92px 预留、顶栏高度 / 右侧起点逐字不变；
 *     · 浅 / 深截图 + 左右两端裁切对照。
 *
 * 截图只覆盖渲染内容；macOS 红绿灯是系统绘制、不在 WebContents 里，因此
 * 零回归的证据是「窗口选项未变 + DOM/CSS 未变 + 截图无重复按钮」，不假装截到了红绿灯。
 *
 * 用法：
 *   npm run build                                  # 主进程加载 dist/vue.html
 *   node experiments/dxos-win-titlebar/run.mjs     # 跑全部三个 phase
 *   node experiments/dxos-win-titlebar/run.mjs --phase=win32
 *   OA_WIN_TITLEBAR_CDP_PORT=9417 node experiments/dxos-win-titlebar/run.mjs
 *
 * 依赖：仓库已有的 electron 44 + @playwright/test（connectOverCDP，不额外下载浏览器）。
 * 本脚本不联网、不改真实 profile、不 git commit。
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-win-titlebar");
const SHOTS = path.join(ART, "shots");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "").split(" ").filter(Boolean);

fs.mkdirSync(SHOTS, { recursive: true });

const checks = [];
function record(run, id, ok, expected, actual) {
  checks.push({ run, id, ok: !!ok, expected: String(expected), actual: String(actual) });
  console.log((ok ? "PASS " : "FAIL ") + "[" + run + "] " + id + " :: " + String(actual).slice(0, 300));
  return !!ok;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, timeoutMs = 15000, stepMs = 150) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (await fn()) return true; } catch { /* 继续等 */ }
    if (Date.now() >= deadline) return false;
    await sleep(stepMs);
  }
}

function childEnv(forcePlatform) {
  const env = { ...process.env };
  // 本机（以及部分 CI）在 shell 里设了 ELECTRON_RUN_AS_NODE=1；带进子进程会让 electron 以纯 Node 启动。
  delete env.ELECTRON_RUN_AS_NODE;
  env.OPENARC_IDENTITY_ADMIN = "1";
  if (forcePlatform) env.OA_FORCE_PLATFORM = forcePlatform;
  else delete env.OA_FORCE_PLATFORM;
  return env;
}

function pngSize(file) {
  const buf = fs.readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** 启动一次真实应用；返回 { child, logs }。 */
function launch(forcePlatform, port, userDataDir) {
  const logs = [];
  const child = spawn(
    electronPath,
    [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + String(port), ...extraArgs],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: childEnv(forcePlatform) },
  );
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));
  return { child, logs };
}

async function connect(port, label) {
  let browser = null;
  const deadline = Date.now() + 45000;
  while (!browser && Date.now() < deadline) {
    try {
      const res = await fetch("http://127.0.0.1:" + port + "/json/version");
      if (res.ok) browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
    } catch { /* 还没起来 */ }
    if (!browser) await sleep(300);
  }
  if (!browser) throw new Error("[" + label + "] CDP 45 秒内未就绪");
  const context = browser.contexts()[0];
  const isUI = (p) => p.url().includes("vue.html");
  const found = await waitFor(() => !!context.pages().find(isUI), 30000, 300);
  if (!found) throw new Error("[" + label + "] 未找到界面页面：" + context.pages().map((p) => p.url()).join(" | "));
  const page = context.pages().find(isUI);
  return { browser, context, page };
}

async function bootstrap(page) {
  const res = await page.evaluate(async () => {
    const identifier = "win-titlebar-probe@openarc.test";
    const password = "WinTitlebar-probe-1";
    const init = await window.openarc.identity.command({ type: "identity/initialize", identifier, password, displayName: "窗口 chrome 探针管理员" });
    const login = await window.openarc.identity.command({ type: "identity/login", identifier, password });
    return { init, login };
  });
  return res;
}

const stateOf = async (page) => page.evaluate(() => window.openarc.windowControl.state());

async function setTheme(page, theme) {
  const isDark = () => page.evaluate(() => !!document.querySelector(".desktop.dark"));
  if ((theme === "dark") === (await isDark())) return;
  await page.locator(".topbar .bar-menu", { hasText: "显示" }).first().click();
  const label = theme === "dark" ? "深色外观" : "浅色外观";
  await page.locator(".context-menu button", { hasText: label }).first().click();
  await waitFor(async () => (theme === "dark") === (await isDark()), 5000);
}

async function shot(page, name, clip) {
  const file = path.join(SHOTS, name);
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  return file;
}

async function measure(page) {
  return page.evaluate(() => {
    const topbar = document.querySelector(".topbar");
    const menus = document.querySelector(".topbar-menus");
    const right = document.querySelector(".topbar-right");
    const caption = document.querySelector(".topbar-caption");
    const buttons = Array.from(document.querySelectorAll(".bar-caption"));
    const rect = (el) => (el ? el.getBoundingClientRect().toJSON() : null);
    const style = topbar ? getComputedStyle(topbar) : null;
    return {
      platform: topbar ? topbar.getAttribute("data-platform") : null,
      isWin: topbar ? topbar.classList.contains("is-win") : false,
      paddingLeft: style ? style.paddingLeft : null,
      paddingRight: style ? style.paddingRight : null,
      height: topbar ? topbar.getBoundingClientRect().height : null,
      topbar: rect(topbar),
      menus: rect(menus),
      right: rect(right),
      caption: rect(caption),
      innerWidth,
      innerHeight,
      buttons: buttons.map((b) => ({
        caption: b.dataset.caption,
        label: b.getAttribute("aria-label"),
        state: b.dataset.captionState || null,
        tabIndex: b.tabIndex,
        rect: b.getBoundingClientRect().toJSON(),
      })),
    };
  });
}

async function captionStyles(page) {
  return page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const s = getComputedStyle(el);
      return { background: s.backgroundColor, color: s.color, outlineWidth: s.outlineWidth, outlineStyle: s.outlineStyle, outlineOffset: s.outlineOffset, transition: s.transitionDuration };
    };
    return {
      close: pick('[data-caption="close"]'),
      minimize: pick('[data-caption="minimize"]'),
      hovered: document.querySelector('[data-caption="close"]:hover') ? "close" : document.querySelector('[data-caption="minimize"]:hover') ? "minimize" : null,
    };
  });
}

async function runWin32Screens(report) {
  const label = "win32-screens";
  const port = Number(process.env.OA_WIN_TITLEBAR_CDP_PORT || 0) || (await freePort());
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-win-titlebar-win32-"));
  const { child, logs } = launch("win32", port, userDataDir);
  let browser = null;
  try {
    const session = await connect(port, label);
    browser = session.browser;
    const page = session.page;
    await page.bringToFront();
    await waitFor(() => page.evaluate(() => !!window.openarc && Object.keys(window.openarc).length === 40), 30000);
    const boot = await bootstrap(page);
    record(label, "boot.identity", boot.init && boot.init.ok === true && boot.login && boot.login.ok === true, "initialize+login ok", JSON.stringify({ init: boot.init && boot.init.ok, login: boot.login && boot.login.ok }));
    await page.waitForSelector(".topbar.is-win", { timeout: 20000 });
    await page.waitForSelector(".topbar-caption", { timeout: 10000 });
    const info = await page.evaluate(() => window.openarc.system.info());
    record(label, "platform.forced", info.platform === "win32", "system.info().platform = win32", info.platform);

    await setTheme(page, "light");
    const m = await measure(page);
    const close = m.buttons.find((b) => b.caption === "close");
    const maxBtn = m.buttons.find((b) => b.caption === "maximize");
    const minBtn = m.buttons.find((b) => b.caption === "minimize");
    record(label, "layout.three-buttons", m.buttons.length === 3, 3, m.buttons.map((b) => b.caption).join(","));
    record(label, "layout.order", m.buttons.map((b) => b.caption).join(",") === "minimize,maximize,close", "minimize,maximize,close", m.buttons.map((b) => b.caption).join(","));
    record(label, "layout.46x38", m.buttons.every((b) => Math.abs(b.rect.width - 46) < 0.6 && Math.abs(b.rect.height - 38) < 0.6), "46x38", m.buttons.map((b) => b.rect.width + "x" + b.rect.height).join(" "));
    record(label, "layout.flush-right", close && Math.abs(close.rect.right - m.innerWidth) < 0.6, "close.right = innerWidth", close ? close.rect.right + " / " + m.innerWidth : "missing");
    record(label, "layout.top-flush", m.buttons.every((b) => Math.abs(b.rect.y) < 0.6), "y = 0", m.buttons.map((b) => b.rect.y).join(","));
    record(label, "layout.left-16", m.paddingLeft === "16px" && Math.abs(m.menus.left - 16) < 1, "padding-left 16 + menus.left 16", m.paddingLeft + " / " + m.menus.left);
    record(label, "layout.right-group-shifted", Math.abs(m.right.right - (m.innerWidth - 138 - 9)) < 1.5, "right.right = innerWidth - 147", m.right.right + " / " + (m.innerWidth - 147));
    record(label, "layout.bar-38", Math.abs(m.height - 38) < 0.6, 38, m.height);
    record(label, "a11y.tabindex", m.buttons.every((b) => b.tabIndex === 0), "tabIndex 0", m.buttons.map((b) => b.tabIndex).join(","));
    record(label, "a11y.labels", minBtn && minBtn.label === "最小化" && maxBtn && maxBtn.label === "最大化" && close && close.label === "关闭窗口", "最小化 / 最大化 / 关闭窗口", m.buttons.map((b) => b.label).join(","));

    const files = [];
    files.push(await shot(page, "win32-light-normal.png"));
    files.push(await shot(page, "win32-light-caption.png", { x: m.innerWidth - 240, y: 0, width: 240, height: 56 }));

    // hover 6% 中性
    await page.hover('[data-caption="minimize"]');
    await sleep(250);
    const hover = await captionStyles(page);
    record(label, "hover.neutral-6", /0\.06\)/.test(hover.minimize.background), "rgba(...,0.06)", hover.minimize.background);
    await page.mouse.move(10, m.innerHeight - 10);

    // close hover：Windows caption 红 + 白字形
    await page.hover('[data-caption="close"]');
    await sleep(250);
    const closeHover = await captionStyles(page);
    record(label, "hover.close-red", closeHover.close.background === "rgb(196, 43, 28)", "rgb(196, 43, 28)", closeHover.close.background);
    record(label, "hover.close-white", closeHover.close.color === "rgb(255, 255, 255)", "rgb(255, 255, 255)", closeHover.close.color);
    files.push(await shot(page, "win32-light-close-hover.png", { x: m.innerWidth - 240, y: 0, width: 240, height: 56 }));
    await page.mouse.move(10, m.innerHeight - 10);

    // 键盘焦点环：Tab 走到最小化按钮（真键盘事件，:focus-visible 才成立）
    let focusedCaption = null;
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press("Tab");
      focusedCaption = await page.evaluate(() => document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.caption || null : null);
      if (focusedCaption === "minimize") break;
    }
    record(label, "a11y.keyboard-reachable", focusedCaption === "minimize", "Tab 可到最小化按钮", String(focusedCaption));
    const focusStyle = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const s = getComputedStyle(el);
      return { outlineWidth: s.outlineWidth, outlineStyle: s.outlineStyle, outlineOffset: s.outlineOffset, outlineColor: s.outlineColor };
    });
    record(label, "a11y.focus-ring", focusStyle && focusStyle.outlineWidth === "2px" && focusStyle.outlineStyle === "solid" && focusStyle.outlineOffset === "-4px", "2px solid + offset -4px", JSON.stringify(focusStyle));
    files.push(await shot(page, "win32-light-focus.png", { x: m.innerWidth - 240, y: 0, width: 240, height: 56 }));
    await page.evaluate(() => document.activeElement && document.activeElement.blur());

    // 最大化 → 主进程状态 + 图标变「还原」
    await page.click('[data-caption="maximize"]');
    const maxed = await waitFor(async () => {
      const s = await stateOf(page);
      return !!(s && s.ok && s.value && s.value.maximized === true);
    }, 8000);
    const stateMax = await stateOf(page);
    record(label, "maximize.main-state", maxed, "isMaximized() = true", JSON.stringify(stateMax));
    const restoredIcon = await page.evaluate(() => {
      const b = document.querySelector('[data-caption="maximize"]');
      return { state: b && b.dataset.captionState, label: b && b.getAttribute("aria-label") };
    });
    record(label, "maximize.icon-restore", restoredIcon.state === "restore" && restoredIcon.label === "还原", "data-caption-state=restore / aria-label=还原", JSON.stringify(restoredIcon));
    files.push(await shot(page, "win32-light-maximized.png"));

    await page.click('[data-caption="maximize"]');
    const unmaxed = await waitFor(async () => {
      const s = await stateOf(page);
      return !!(s && s.ok && s.value && s.value.maximized === false);
    }, 8000);
    const stateUnmax = await stateOf(page);
    record(label, "restore.main-state", unmaxed, "isMaximized() = false", JSON.stringify(stateUnmax));
    const backIcon = await page.evaluate(() => document.querySelector('[data-caption="maximize"]').dataset.captionState);
    record(label, "restore.icon-maximize", backIcon === "maximize", "data-caption-state=maximize", backIcon);

    // 深色
    await setTheme(page, "dark");
    await sleep(300);
    files.push(await shot(page, "win32-dark-normal.png"));
    files.push(await shot(page, "win32-dark-caption.png", { x: m.innerWidth - 240, y: 0, width: 240, height: 56 }));
    await page.click('[data-caption="maximize"]');
    await waitFor(async () => {
      const s = await stateOf(page);
      return !!(s && s.ok && s.value && s.value.maximized === true);
    }, 8000);
    files.push(await shot(page, "win32-dark-maximized.png"));
    await page.hover('[data-caption="close"]');
    await sleep(250);
    // 最大化后窗口宽度已变（macOS 上是屏幕工作区），裁切必须按当前 innerWidth 取，不能用未最大化时的值。
    const maxWidth = await page.evaluate(() => innerWidth);
    files.push(await shot(page, "win32-dark-close-hover.png", { x: maxWidth - 240, y: 0, width: 240, height: 56 }));
    await page.click('[data-caption="maximize"]');
    await waitFor(async () => {
      const s = await stateOf(page);
      return !!(s && s.ok && s.value && s.value.maximized === false);
    }, 8000);

    // 减少动态（MOTION §8）：caption 的过渡时长必须归零，而不是换一套动效
    await page.locator(".topbar .bar-menu", { hasText: "显示" }).first().click();
    await page.locator(".context-menu button", { hasText: "减少动态效果" }).first().click();
    await page.waitForSelector(".desktop.reduced", { timeout: 5000 });
    const reduced = await page.evaluate(() => {
      const b = document.querySelector('[data-caption="minimize"]');
      return { duration: getComputedStyle(b).transitionDuration, reduced: !!document.querySelector(".desktop.reduced") };
    });
    record(label, "motion.reduced", reduced.reduced && /^0s/.test(reduced.duration), "transition-duration 0s", JSON.stringify(reduced));

    // 关闭：真的点关闭按钮 → 进程退出
    const exitCode = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    await page.click('[data-caption="close"]').catch(() => {});
    const exited = await Promise.race([exitCode, sleep(25000).then(() => "timeout")]);
    record(label, "close.process-exit", exited === 0, "exit code 0", String(exited));
    const logText = logs.join("");
    record(label, "close.main-log", logText.includes("窗口命令 close"), "主进程日志含 窗口命令 close", logText.includes("窗口命令 close"));
    record(label, "maximize.main-log", logText.includes("窗口命令 toggleMaximize"), "主进程日志含 窗口命令 toggleMaximize", logText.includes("窗口命令 toggleMaximize"));
    record(label, "forced.warning", logText.includes("OA_FORCE_PLATFORM=win32"), "主进程打印测试覆盖告警", logText.includes("OA_FORCE_PLATFORM=win32"));

    report.runs.push({
      label,
      forced: "win32",
      realPlatform: process.platform,
      userData: userDataDir,
      measurements: m,
      screenshots: files.map((f) => ({ file: path.relative(ROOT, f), ...pngSize(f), sha256: sha256(f) })),
      mainLogTail: logs.join("").slice(-4000),
    });
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    try { if (child.exitCode == null) child.kill("SIGKILL"); } catch { /* ignore */ }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function runWin32Minimize(report) {
  const label = "win32-minimize";
  const port = Number(process.env.OA_WIN_TITLEBAR_CDP_PORT || 0) || (await freePort());
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-win-titlebar-min-"));
  const { child, logs } = launch("win32", port, userDataDir);
  let browser = null;
  try {
    const session = await connect(port, label);
    browser = session.browser;
    const page = session.page;
    await page.bringToFront();
    await waitFor(() => page.evaluate(() => !!window.openarc && Object.keys(window.openarc).length === 40), 30000);
    await bootstrap(page);
    await page.waitForSelector(".topbar-caption", { timeout: 20000 });
    const before = await stateOf(page);
    record(label, "minimize.before", !!(before && before.ok && before.value && before.value.minimized === false), "isMinimized() = false", JSON.stringify(before));
    await page.click('[data-caption="minimize"]');
    const minimized = await waitFor(async () => {
      const s = await stateOf(page);
      return !!(s && s.ok && s.value && s.value.minimized === true);
    }, 8000);
    const after = await stateOf(page);
    record(label, "minimize.main-state", minimized, "isMinimized() = true（窗口不可见）", JSON.stringify(after));
    record(label, "minimize.main-log", logs.join("").includes("窗口命令 minimize"), "主进程日志含 窗口命令 minimize", logs.join("").includes("窗口命令 minimize"));
    // 最小化后无法再点窗口：经桥关闭，确保进程干净退出（关闭路径与按钮完全同一条）。
    const exitCode = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    await page.evaluate(() => window.openarc.windowControl.close()).catch(() => {});
    const exited = await Promise.race([exitCode, sleep(25000).then(() => "timeout")]);
    record(label, "minimize.clean-exit", exited === 0, "exit code 0", String(exited));
    report.runs.push({ label, forced: "win32", realPlatform: process.platform, userData: userDataDir, mainLogTail: logs.join("").slice(-3000) });
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    try { if (child.exitCode == null) child.kill("SIGKILL"); } catch { /* ignore */ }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function runDarwin(report) {
  const label = "darwin";
  const port = Number(process.env.OA_WIN_TITLEBAR_CDP_PORT || 0) || (await freePort());
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-win-titlebar-darwin-"));
  const { child, logs } = launch("", port, userDataDir);
  let browser = null;
  try {
    const session = await connect(port, label);
    browser = session.browser;
    const page = session.page;
    await page.bringToFront();
    await waitFor(() => page.evaluate(() => !!window.openarc && Object.keys(window.openarc).length === 40), 30000);
    await bootstrap(page);
    await page.waitForSelector(".topbar", { timeout: 20000 });
    const info = await page.evaluate(() => window.openarc.system.info());
    record(label, "platform.real", info.platform === process.platform, "system.info().platform = " + process.platform, info.platform);
    const m = await measure(page);
    record(label, "no-caption-buttons", m.buttons.length === 0, 0, m.buttons.length);
    record(label, "no-caption-container", m.caption === null, "null", JSON.stringify(m.caption));
    record(label, "not-win-class", m.isWin === false, "false", String(m.isWin));
    record(label, "left-92", m.paddingLeft === "92px" && Math.abs(m.menus.left - 84) < 1, "padding-left 92 / menus.left 84", m.paddingLeft + " / " + (m.menus && m.menus.left));
    record(label, "right-23", m.paddingRight === "23px" && Math.abs(m.right.right - (m.innerWidth - 23)) < 1.5, "padding-right 23 / right.right = innerWidth-23", m.paddingRight + " / " + (m.right && m.right.right) + " vs " + (m.innerWidth - 23));
    record(label, "bar-38", Math.abs(m.height - 38) < 0.6, 38, m.height);
    await setTheme(page, "light");
    await sleep(300);
    const files = [];
    files.push(await shot(page, "darwin-light-normal.png"));
    files.push(await shot(page, "darwin-light-left.png", { x: 0, y: 0, width: 240, height: 56 }));
    files.push(await shot(page, "darwin-light-right.png", { x: m.innerWidth - 240, y: 0, width: 240, height: 56 }));
    await setTheme(page, "dark");
    await sleep(300);
    files.push(await shot(page, "darwin-dark-normal.png"));
    files.push(await shot(page, "darwin-dark-right.png", { x: m.innerWidth - 240, y: 0, width: 240, height: 56 }));
    report.runs.push({
      label,
      forced: "",
      realPlatform: process.platform,
      userData: userDataDir,
      measurements: m,
      screenshots: files.map((f) => ({ file: path.relative(ROOT, f), ...pngSize(f), sha256: sha256(f) })),
      mainLogTail: logs.join("").slice(-3000),
    });
    record(label, "forced.absent", !logs.join("").includes("OA_FORCE_PLATFORM"), "主进程没有测试覆盖告警", logs.join("").includes("OA_FORCE_PLATFORM"));
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    try { if (child.exitCode == null) child.kill("SIGKILL"); } catch { /* ignore */ }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const phases = (process.argv.find((a) => a.startsWith("--phase=")) || "").split("=")[1] || "all";
const report = { generatedAt: new Date().toISOString(), host: { platform: process.platform, node: process.version }, checks, runs: [] };

try {
  if (phases === "all" || phases === "win32") await runWin32Screens(report);
  if (phases === "all" || phases === "minimize") await runWin32Minimize(report);
  if (phases === "all" || phases === "darwin") await runDarwin(report);
} catch (error) {
  record("harness", "exception", false, "无异常", String((error && error.stack) || error));
}

report.checks = checks;
report.summary = {
  total: checks.length,
  passed: checks.filter((c) => c.ok).length,
  failed: checks.filter((c) => !c.ok).length,
};
fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(ART, "manifest.json"), JSON.stringify({ generatedAt: report.generatedAt, screenshots: report.runs.flatMap((r) => r.screenshots || []) }, null, 2));
console.log("");
console.log("checks: " + report.summary.passed + "/" + report.summary.total + " passed, " + report.summary.failed + " failed");
console.log("report: " + path.relative(ROOT, path.join(ART, "report.json")));
process.exit(report.summary.failed === 0 ? 0 : 1);
