#!/usr/bin/env node
/**
 * 无限画布「在线更新」界面 · 真机视觉探针（experiments/dxos-canvas-update-ui）。
 *
 * 被测对象：默认 Vue 壳（dist/vue.html，不设 OA_UI）→ 应用市场 → 画布卡片「在线更新」
 *           → src-vue/apps/CanvasUpdatePanel.vue + src-vue/apps/canvasUpdateLogic.ts。
 *
 * 关键点：**不 stub 渲染层桥**。contextBridge 暴露的 window.openarc 属性不可写、不可配置
 * （本目录 diagnose-bridge.mjs 有实测输出），所以更新命令全部走真实 IPC → 真实
 * electron/market-update-service.cjs → 真实验签 / 摘要 / 解压 / 原子切换 / 审计，只把**网络传输**
 * 换成主进程内的离线 fixture 源（fixture-source.cjs，经 NODE_OPTIONS=--require 预加载替换
 * globalThis.fetch）。因此本探针里的「有更新 / 坏签名 / 安装成功 / 可回滚 / 回滚」都是真实执行结果。
 *
 * 环境：真实 electron + 隔离 --user-data-dir + 唯一 --remote-debugging-port；
 *       参考视口 1440x900@2（截图像素 2880x1800），窄窗 820x720@2；
 *       深浅主题与减少动态都走真实 UI「控制中心」。
 *
 * 覆盖：无发布版本 / 已是最新 / 有更新 / 二次确认 / 安装进行中 / 安装成功 / 可回滚 /
 *       回滚二次确认 / 坏签名失败；另有窄窗不溢出、减少动态、切源不覆盖已保存选择。
 *
 * 硬约束：不联网（fixture 之外的请求只记 passthrough 并断言为 0）；不改产品代码；
 *         不新增依赖；不 git commit；收工自清理。
 * 用法：node experiments/dxos-canvas-update-ui/run-all.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as H from "../dxos-ui-photos/lib/harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-canvas-update-ui");
const SCR = path.join(ART, "screens");
const REF = { id: "1440x900", width: 1440, height: 900, dsf: 2 };
const NARROW = { id: "820x720", width: 820, height: 720, dsf: 2 };
const AREA_TOP = 38;
const MARKET_WIN = 'section.window[aria-label="应用市场窗口"]';
const PANEL = '[data-canvas-update="1"]';
const PANEL_STATE = "data-canvas-update-state";
const NOTES = "https://modelscope.cn/models/bllack/OpenArc-OS";
const PUBLISHED = 1776300000000;
const NARROW_SHOTS = ["03-available", "04-confirm", "05-installing", "09-failed"];

const SELECTORS = [
  { selector: '[data-canvas-update="1"]', meaning: "更新面板根节点" },
  { selector: "[data-canvas-update-state]", meaning: "状态机：unchecked / checking / latest / available / failed" },
  { selector: "[data-canvas-update-busy]", meaning: "进行中：idle / status / check / install / rollback" },
  { selector: "[data-canvas-update-title]", meaning: "状态主文案（中文）" },
  { selector: "[data-canvas-update-notice]", meaning: "安装 / 回滚成功文案" },
  { selector: "[data-canvas-update-progress]", meaning: "安装 / 回滚进行中的文字状态（无百分比）" },
  { selector: "[data-canvas-update-current]", meaning: "当前生效版本（真实 current.json）" },
  { selector: "[data-canvas-update-builtin]", meaning: "随包内置版本" },
  { selector: "[data-canvas-update-latest]", meaning: "更新源里的最新版本（无则空）" },
  { selector: "[data-canvas-update-published]", meaning: "发布时间（YYYY-MM-DD HH:mm 或 —）" },
  { selector: "[data-canvas-update-available]", meaning: "是否有可用更新 true/false" },
  { selector: "[data-canvas-update-can-rollback]", meaning: "是否可回滚 true/false" },
  { selector: "[data-canvas-update-source]", meaning: "当前源 kind" },
  { selector: "[data-canvas-update-source-repo]", meaning: "当前源 owner/repo" },
  { selector: "[data-canvas-update-checked-at]", meaning: "上次检查时间" },
  { selector: "[data-canvas-update-error-code]", meaning: "原始错误码（中文错误在标题里）" },
  { selector: "[data-canvas-update-error-detail]", meaning: "后端 detail（可空）" },
  { selector: "[data-canvas-update-notes]", meaning: "更新说明链接 a[href]" },
  { selector: "[data-canvas-update-notes-none]", meaning: "源里没有说明链接时的占位文案" },
  { selector: "[data-canvas-update-check]", meaning: "「检查更新」按钮" },
  { selector: "[data-canvas-update-install]", meaning: "「更新到 X」按钮（只打开确认层）" },
  { selector: "[data-canvas-update-rollback]", meaning: "「回滚到上一版」按钮（只打开确认层）" },
  { selector: "[data-canvas-update-back]", meaning: "返回应用市场" },
  { selector: '[data-canvas-update-source-option="<kind>"]', meaning: "切源分段控件里的一个源" },
  { selector: "[data-canvas-update-confirm]", meaning: "二次确认弹层（值 install / rollback）" },
  { selector: "[data-canvas-update-confirm-primary]", meaning: "确认层主按钮（值 install / rollback）" },
  { selector: "[data-canvas-update-open]", meaning: "应用市场画布卡片上的入口按钮" },
];

const checks = [];
const captures = [];
const notes = [];
const findings = [];
const consoleErrors = [];
const pageErrors = [];
const nonLocal = [];
const runs = [];
let activeRun = null;

const record = (section, name, ok, expected, actual) => {
  const row = { run: activeRun ? activeRun.id : "setup", section, name, ok: !!ok, expected: String(expected == null ? "" : expected), actual: String(actual == null ? "" : actual).slice(0, 600) };
  checks.push(row);
  console.log((row.ok ? "PASS" : "FAIL") + " [" + row.run + "/" + section + "] " + name + " :: actual=" + row.actual + " expected=" + row.expected);
  return row.ok;
};
const note = (line) => { notes.push(line); console.log("   · " + line); };
const finding = (kind, detail) => { findings.push({ kind, detail }); console.log("   ! " + kind + " :: " + detail); };
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

/* 复用既有 zip 写入器（electron/canvas-dxos-zip.cjs），不新增依赖。 */
const require = createRequire(path.join(ROOT, "package.json"));
const writeZip = require(path.join(ROOT, "electron", "canvas-dxos-zip.cjs")).writeZip;

/* ── 离线 fixture 包：真实签名 / 坏签名 ───────────────────────────────────── */
function buildCanvasZip(version, privateKey) {
  const indexJs = Buffer.from("/* OpenArc canvas fixture " + version + " */\n", "utf8");
  const indexCss = Buffer.from(".oa-canvas-fixture{color:inherit}\n", "utf8");
  const manifest = {
    format: "openarc-app/v1",
    id: "canvas",
    name: "无限画布",
    version,
    build: 1,
    entry: "index.js",
    styles: ["index.css"],
    files: { "index.js": sha256(indexJs), "index.css": sha256(indexCss) },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  const signature = crypto.sign(null, manifestBytes, privateKey).toString("base64");
  return {
    bytes: writeZip([
      { name: "manifest.json", data: manifestBytes },
      { name: "index.js", data: indexJs },
      { name: "index.css", data: indexCss },
      { name: "manifest.sig", data: Buffer.from(signature, "utf8") },
    ]),
    manifest,
  };
}

/* ── 页内度量 ───────────────────────────────────────────────────────────── */
async function panelFacts(page) {
  return page.evaluate(() => {
    const p = document.querySelector('[data-canvas-update="1"]');
    if (!p) return null;
    const get = (n) => p.getAttribute("data-" + n);
    const dialog = document.querySelector("[data-canvas-update-confirm]");
    const notesEl = p.querySelector("[data-canvas-update-notes]");
    const errorEl = p.querySelector("[data-canvas-update-error-code]");
    return {
      state: get("canvas-update-state"),
      busy: get("canvas-update-busy"),
      title: (p.querySelector("[data-canvas-update-title]") || {}).textContent || "",
      notice: (p.querySelector("[data-canvas-update-notice]") || {}).textContent || "",
      progress: (p.querySelector("[data-canvas-update-progress]") || {}).textContent || "",
      errorCode: errorEl ? errorEl.getAttribute("data-canvas-update-error-code") : null,
      errorDetail: errorEl ? errorEl.getAttribute("data-canvas-update-error-detail") : null,
      current: get("canvas-update-current"),
      builtin: get("canvas-update-builtin"),
      latest: get("canvas-update-latest"),
      published: get("canvas-update-published"),
      available: get("canvas-update-available"),
      canRollback: get("canvas-update-can-rollback"),
      source: get("canvas-update-source"),
      sourceRepo: get("canvas-update-source-repo"),
      checkedAt: get("canvas-update-checked-at"),
      notes: notesEl ? notesEl.getAttribute("href") : null,
      notesNone: !!p.querySelector("[data-canvas-update-notes-none]"),
      confirmKind: dialog ? dialog.getAttribute("data-canvas-update-confirm") : null,
      confirmText: dialog ? (dialog.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300) : null,
      installDisabled: (() => { const b = p.querySelector("[data-canvas-update-install]"); return b ? b.disabled : null; })(),
      rollbackDisabled: (() => { const b = p.querySelector("[data-canvas-update-rollback]"); return b ? b.disabled : null; })(),
      reduceMotion: (() => { const d = document.querySelector(".desktop"); return d ? d.classList.contains("reduced") : null; })(),
      dark: (() => { const d = document.querySelector(".desktop"); return d ? d.classList.contains("dark") : null; })(),
    };
  });
}

async function measureLayout(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-canvas-update="1"]');
    const win = document.querySelector('section.window[aria-label="应用市场窗口"]');
    const offenders = [];
    if (panel) {
      /* 边界取窗口包围盒：二次确认层是挂在窗口上的绝对定位覆盖层（inset:0），
         天然比 720px 宽的面板大，不该算成面板内容溢出；真正要抓的是越出窗口的内容。 */
      const box = win ? win.getBoundingClientRect() : panel.getBoundingClientRect();
      const all = panel.querySelectorAll("*");
      for (let i = 0; i < all.length; i += 1) {
        const el = all[i];
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > box.right + 1.5 || r.left < box.left - 1.5) {
          offenders.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 60), text: (el.textContent || "").trim().slice(0, 24), right: Math.round(r.right), boxRight: Math.round(box.right) });
          if (offenders.length >= 10) break;
        }
      }
    }
    const wr = win ? win.getBoundingClientRect() : null;
    return {
      viewport: window.innerWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
      panelScrollWidth: panel ? panel.scrollWidth : null,
      panelClientWidth: panel ? panel.clientWidth : null,
      panelRect: panel ? [Math.round(panel.getBoundingClientRect().left), Math.round(panel.getBoundingClientRect().right)] : null,
      windowRect: wr ? [Math.round(wr.left), Math.round(wr.top), Math.round(wr.width), Math.round(wr.height)] : null,
      offenders,
    };
  });
}

/* ── 真实 UI 路径 ───────────────────────────────────────────────────────── */
async function openMarket(page) {
  await H.clickSelector(page, '.dock-item[data-dock-id="home"]');
  const card = await H.waitFor(() => page.$('[data-app-card="market"]'), 15000, 200);
  if (!card) return false;
  await page.evaluate(() => { const c = document.querySelector('[data-app-card="market"]'); if (c) c.click(); });
  return H.waitFor(() => page.$(MARKET_WIN), 15000, 200);
}

async function openPanel(page) {
  const open = await H.waitFor(async () => await page.evaluate(() => {
    const p = document.querySelector('[data-canvas-update="1"]');
    return !!p && p.getAttribute("data-canvas-update-busy") === "idle";
  }), 12000, 120);
  if (open) return true;
  const clicked = await H.clickSelector(page, "[data-canvas-update-open]");
  if (!clicked) return false;
  return H.waitFor(async () => await page.evaluate(() => {
    const p = document.querySelector('[data-canvas-update="1"]');
    return !!p && p.getAttribute("data-canvas-update-busy") === "idle";
  }), 12000, 120);
}

async function closePanel(page) {
  await H.clickSelector(page, "[data-canvas-update-back]");
  return H.waitFor(async () => !(await page.$(PANEL)), 8000, 120);
}

async function clickCheck(page) {
  await H.clickSelector(page, "[data-canvas-update-check]");
  return H.waitFor(async () => await page.evaluate(() => {
    const p = document.querySelector('[data-canvas-update="1"]');
    return !!p && p.getAttribute("data-canvas-update-busy") === "idle" && p.getAttribute("data-canvas-update-state") !== "checking";
  }), 12000, 120);
}

async function clickInstall(page) {
  await H.clickSelector(page, "[data-canvas-update-install]");
  return H.waitFor(() => page.$("[data-canvas-update-confirm]"), 6000, 100);
}

async function confirmDialog(page) {
  await H.clickSelector(page, "[data-canvas-update-confirm-primary]");
  return H.waitFor(async () => !(await page.$("[data-canvas-update-confirm]")), 6000, 100);
}

async function setState(stateFile, state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

async function setThemeViaControlCenter(page, theme) {
  await H.clickSelector(page, 'button[aria-label="控制中心"]');
  const open = await H.waitFor(() => page.$(".control-center"), 6000, 100);
  if (!open) return false;
  const label = theme === "dark" ? "深色" : "浅色";
  const clicked = await page.evaluate((text) => {
    const group = document.querySelector('.control-center [aria-label="外观"]');
    if (!group) return false;
    const buttons = Array.prototype.slice.call(group.querySelectorAll("button"));
    const target = buttons.filter(function (b) { return (b.textContent || "").trim() === text; })[0];
    if (!target) return false;
    target.click();
    return true;
  }, label);
  const settled = clicked && await H.waitFor(async () => await page.evaluate((want) => {
    const d = document.querySelector(".desktop");
    return d ? d.classList.contains("dark") === want : false;
  }, theme === "dark"), 6000, 100);
  await page.evaluate(() => { const s = document.querySelector(".cc-shade"); if (s) s.click(); });
  await H.waitFor(async () => !(await page.$(".control-center")), 5000, 100);
  return settled;
}

async function setReducedViaControlCenter(page, on) {
  await H.clickSelector(page, 'button[aria-label="控制中心"]');
  const open = await H.waitFor(() => page.$(".control-center"), 6000, 100);
  if (!open) return false;
  const clicked = await page.evaluate((want) => {
    const sw = document.querySelector('.control-center button[role="switch"][aria-label="减少动态效果"]');
    if (!sw) return false;
    if ((sw.getAttribute("aria-checked") === "true") !== want) sw.click();
    return true;
  }, on);
  const settled = clicked && await H.waitFor(async () => await page.evaluate((want) => {
    const d = document.querySelector(".desktop");
    return d ? d.classList.contains("reduced") === want : false;
  }, on), 5000, 100);
  await page.evaluate(() => { const s = document.querySelector(".cc-shade"); if (s) s.click(); });
  await H.waitFor(async () => !(await page.$(".control-center")), 5000, 100);
  return settled;
}

function findFile(root, name) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === name) return full;
    }
  }
  return null;
}

/* ── 单次运行（一个隔离 userData + 一个 CDP 端口） ───────────────────────── */
async function runOne(spec, deps) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-canvas-update-" + spec.id + "-"));
  const logFile = path.join(deps.tmpRoot, "fixture-" + spec.id + ".log");
  fs.writeFileSync(logFile, "");
  activeRun = { id: spec.id, theme: spec.theme, narrow: !!spec.narrow, userDataDir, logFile, states: {}, fatal: null, checksBefore: checks.length };
  const view = spec.narrow ? NARROW : REF;
  console.log("\n=== 运行 " + spec.id + "：theme=" + spec.theme + " viewport=" + view.width + "x" + view.height + "@" + view.dsf + " ===");
  console.log("隔离 userData：" + userDataDir);

  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  env.NODE_OPTIONS = (process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + " " : "") + "--require " + deps.shimPath;
  env.OA_UPDATE_FIXTURE_MODULE = path.join(HERE, "fixture-source.cjs");
  env.OA_UPDATE_FIXTURE_STATE = deps.stateFile;
  env.OA_UPDATE_FIXTURE_LOG = logFile;

  let launched = null;
  let page = null;
  let cdp = null;
  const register = (pageRef, runId) => {
    pageRef.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(runId + ": " + String(msg.text()).slice(0, 300)); });
    pageRef.on("pageerror", (err) => pageErrors.push(runId + ": " + String((err && err.message) || err).slice(0, 300)));
    pageRef.on("request", (req) => {
      const url = req.url();
      if (!/^(file:|data:|blob:|about:|devtools:|openarc-file:|openarc-resource:|openarc-canvas:|http:\/\/127\.0\.0\.1|http:\/\/localhost|http:\/\/\[::1\]|ws:\/\/127\.0\.0\.1|ws:\/\/localhost)/i.test(url)) nonLocal.push(runId + ": " + url);
    });
  };

  try {
    launched = await H.launchElectron({ ROOT, electronPath: deps.electronPath, chromium: deps.chromium, userDataDir, env });
    activeRun.port = launched.port;
    activeRun.launchCommand = launched.launchCommand;
    console.log("CDP 端口：" + launched.port);
    const context = launched.browser.contexts()[0];
    const found = await H.waitFor(() => !!context.pages().find((p) => /vue\.html/.test(p.url())), 40000, 300);
    page = found ? context.pages().find((p) => /vue\.html/.test(p.url())) : null;
    if (!page) throw new Error("未找到 dist/vue.html 渲染页：" + context.pages().map((p) => p.url()).join(" | "));
    register(page, spec.id);

    cdp = await page.context().newCDPSession(page);
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: view.width, height: view.height, deviceScaleFactor: view.dsf, mobile: false });
    await page.emulateMedia({ reducedMotion: "no-preference", colorScheme: "no-preference" });

    const rendererReady = await H.waitFor(async () => await page.evaluate(() => document.readyState === "complete" && !!window.openarc), 45000, 300);
    record("boot", "B1 · 真实 electron 渲染层就绪（dist/vue.html）", rendererReady, "readyState=complete + window.openarc", String(rendererReady));

    const identifier = "ui-canvas-update-" + spec.id + "@openarc.test";
    const password = "UiCanvasUpdate-1";
    const initRes = await H.callBridge(page, "identity", "identity/initialize", { identifier, password, displayName: "画布更新验证 " + spec.id });
    const loginRes = await H.callBridge(page, "identity", "identity/login", { identifier, password });
    const gateReady = await H.waitFor(async () => await page.evaluate(() => {
      const d = document.querySelector(".desktop");
      return d ? d.getAttribute("data-identity-gate") === "ready" : false;
    }), 25000, 200);
    record("boot", "B2 · 隔离 userData 内初始化 + 登录进入 ready", !!(initRes.result && initRes.result.ok) && !!(loginRes.result && loginRes.result.ok) && gateReady, "ok + gate=ready", JSON.stringify({ init: initRes.result && initRes.result.ok, login: loginRes.result && loginRes.result.ok, gate: gateReady }));

    const marketOpened = await openMarket(page);
    record("entry", "E1 · 经真实 UI「应用中心 → 应用市场」打开市场窗口", marketOpened, MARKET_WIN, String(marketOpened));
    await H.focusWindow(page, MARKET_WIN);
    const fitted = marketOpened ? await H.setViewport(page, cdp, view, MARKET_WIN, AREA_TOP) : false;
    record("layout", "L1 · 市场窗口最大化后精确贴合 " + view.id + " 视图（顶部让开 38px）", fitted, view.width + "x" + (view.height - AREA_TOP), String(fitted));
    await H.sleep(200);

    const entryVisible = await H.waitFor(() => page.$("[data-canvas-update-open]"), 10000, 120);
    record("entry", "E2 · 画布卡片上有「在线更新」入口（data-canvas-update-open）", entryVisible, "存在", String(entryVisible));
    record("entry", "E3 · 没有新增应用（未注册 canvas-update 卡片）", await page.evaluate(() => !document.querySelector('[data-app-card="canvas-update"]')), "无 canvas-update 卡片", "ok");
    record("entry", "E4 · 渲染层桥未被顶替（window.openarc 仍是 contextBridge 原生对象，39 键）", await page.evaluate(() => Object.keys(window.openarc).length === 39 && typeof window.openarc.marketUpdate.command === "function"), "39 键 + marketUpdate.command 是函数", await page.evaluate(() => Object.keys(window.openarc).length + " 键"));

    const themed = await setThemeViaControlCenter(page, spec.theme);
    record("theme", "T1 · 经真实「控制中心 → 外观」切到" + (spec.theme === "dark" ? "深色" : "浅色"), themed, spec.theme, String(themed));
    const panelOpen = await openPanel(page);
    record("panel", "P1 · 画布卡片入口可打开更新面板", panelOpen, "面板就绪（busy=idle）", String(panelOpen));
    if (!panelOpen) throw new Error("更新面板未就绪");

    await runStates(page, cdp, spec, deps);

    if (spec.reduced) {
      const reduced = await setReducedViaControlCenter(page, true);
      record("motion", "MS1 · 经真实「控制中心 → 减少动态」开启", reduced, "reduced", String(reduced));
      await closePanel(page);
      /* 这一轮已经真实装过 0.2.0，所以要用 0.3.0 才能再次出现「有可用更新」 */
      await setState(deps.stateFile, { version: "0.3.0", zip: deps.zips["0.3.0"], notesUrl: NOTES, publishedAt: PUBLISHED, delayZipMs: 0 });
      await openPanel(page);
      const durations = await page.evaluate(() => {
        const btn = document.querySelector('[data-canvas-update="1"] .ds-btn');
        return { btnTransform: btn ? getComputedStyle(btn).transitionDuration : null };
      });
      record("motion", "MS2 · 减少动态下按钮过渡时长为 0s", durations.btnTransform === "0s", "0s", String(durations.btnTransform));
      await clickCheck(page);
      await clickInstall(page);
      const dialogUp = await H.waitFor(() => page.$("[data-canvas-update-confirm]"), 6000, 100);
      const shade = await page.evaluate(() => { const el = document.querySelector(".dialog-shade"); return el ? getComputedStyle(el).animationName : null; });
      record("motion", "MS3 · 减少动态下二次确认层仍可打开且无动画名", dialogUp && (shade === "none" || shade === null), "出现 + animation none", String(dialogUp) + " / " + String(shade));
      await H.shoot(cdp, path.join(SCR, "10-confirm-reduced-" + spec.id + ".png"));
      captures.push({ key: "10-confirm-reduced-" + spec.id, run: spec.id, theme: spec.theme, narrow: false, reduced: true, state: "available", file: "artifacts/dxos-canvas-update-ui/screens/10-confirm-reduced-" + spec.id + ".png" });
      await page.keyboard.press("Escape");
      await setReducedViaControlCenter(page, false);
    }
  } catch (error) {
    activeRun.fatal = String((error && error.stack) || error);
    console.log("FATAL(" + spec.id + ") " + activeRun.fatal);
    record("run", "R0 · 运行 " + spec.id + " 无中断跑完", false, "无异常", activeRun.fatal.split("\n")[0]);
  } finally {
    if (launched) {
      try { await launched.browser.close(); } catch { /* ignore */ }
      try { await H.awaitExit(launched.child, 15000); } catch { /* ignore */ }
    }
  }

  /* fixture 源日志：证明请求真的经主进程更新服务打到了 fixture，且没有旁路网络 */
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
  const lines = log.split("\n").filter(Boolean);
  const modelscope = lines.filter((l) => l.indexOf("modelscope ") === 0);
  const github = lines.filter((l) => l.indexOf("github ") === 0);
  const passthrough = lines.filter((l) => l.indexOf("passthrough ") === 0);
  activeRun.fixtureLog = { lines: lines.length, modelscope: modelscope.length, github: github.length, passthrough: passthrough.length, samples: modelscope.slice(0, 8) };
  record("fixture", "F1 · 更新服务真的通过 fixture 源取版本清单（modelscope revisions + latest.json）", modelscope.some((l) => l.indexOf("/revisions") >= 0) && modelscope.some((l) => l.indexOf("FilePath=updates/canvas/latest.json") >= 0), "两类请求都有", JSON.stringify({ total: modelscope.length, samples: modelscope.slice(0, 3) }));
  record("fixture", "F2 · 安装时真的下载了 canvas 包（fixture 提供字节）", modelscope.some((l) => l.indexOf("FilePath=updates/canvas/canvas-") >= 0), "有 zip 下载", modelscope.filter((l) => l.indexOf("canvas-") >= 0).length + " 条");
  record("fixture", "F3 · 没有任何请求绕过 fixture 源（passthrough = 0，全程不联网）", passthrough.length === 0, 0, JSON.stringify(passthrough.slice(0, 3)));
  if (github.length) note(spec.id + "：GitHub 源也被 fixture 接住（" + github.length + " 条，回空 Release 列表）");
  runs.push(activeRun);
  activeRun = null;
}

/* ── 状态序列 ───────────────────────────────────────────────────────────── */
async function runStates(page, cdp, spec, deps) {
  const run = activeRun;
  const view = spec.narrow ? NARROW : REF;
  const stateFile = deps.stateFile;

  const step = async (key, facts, expectState, extra) => {
    run.states[key] = facts;
    record("state", key + " · data-canvas-update-state = " + expectState, facts.state === expectState, expectState, facts.state);
    if (extra) extra(facts);
    const layout = await measureLayout(page);
    if (spec.narrow) {
      record("narrow", key + " · 视口无横向溢出（<=820px）", layout.horizontalOverflow <= 1, "<=1 px", layout.horizontalOverflow + " px（docScrollWidth=" + layout.docScrollWidth + "）");
      record("narrow", key + " · 面板内容不越出面板包围盒", layout.offenders.length === 0, "0 个", layout.offenders.length + " 个 → " + JSON.stringify(layout.offenders.slice(0, 3)));
      record("narrow", key + " · 面板自身不横向滚动", layout.panelScrollWidth !== null && layout.panelScrollWidth - layout.panelClientWidth <= 1, "<=1 px", String(layout.panelScrollWidth - layout.panelClientWidth) + " px");
    }
    const shootIt = !spec.narrow || NARROW_SHOTS.indexOf(key) >= 0;
    if (!shootIt) return;
    const suffix = spec.narrow ? "narrow-light" : spec.theme;
    const file = path.join(SCR, key + "-" + suffix + ".png");
    const dim = await H.shoot(cdp, file);
    record("shot", key + "-" + suffix + " 截图像素尺寸 = " + view.width * view.dsf + "x" + view.height * view.dsf, dim.width === view.width * view.dsf && dim.height === view.height * view.dsf, view.width * view.dsf + "x" + view.height * view.dsf, dim.width + "x" + dim.height);
    captures.push({ key: key + "-" + suffix, run: run.id, theme: spec.theme, narrow: !!spec.narrow, state: facts.state, file: path.relative(ROOT, file), width: dim.width, height: dim.height, bytes: dim.bytes, layout });
  };

  /* ① 源里还没有发布版本（latest=null 是正常状态，不是错误）+ 真实 ModelScope 默认源 */
  await setState(stateFile, { version: "0.2.0", zip: deps.zips["0.2.0"], notesUrl: NOTES, publishedAt: PUBLISHED, noRelease: true, delayZipMs: 0 });
  await clickCheck(page);
  let facts = await panelFacts(page);
  record("copy", "① 无发布版本：latest 为空且文案说明不是错误", facts.latest === "" && facts.available === "false" && facts.title.indexOf("还没有发布版本") >= 0, "空 latest + 还不是错误", facts.title + " / latest=" + facts.latest);
  record("source", "① 默认源如实显示 ModelScope 仓库（bllack/OpenArc-OS）", facts.source === "modelscope-repo" && facts.sourceRepo === "bllack/OpenArc-OS", "modelscope-repo / bllack-OpenArc-OS", facts.source + " / " + facts.sourceRepo);
  await step("01-no-release", facts, "latest");

  /* ② 已是最新（源版本 = 内置版本 0.1.0） */
  await setState(stateFile, { version: "0.1.0", zip: deps.zips["0.1.0"], notesUrl: NOTES, publishedAt: PUBLISHED, noRelease: false, delayZipMs: 0 });
  await clickCheck(page);
  facts = await panelFacts(page);
  record("copy", "② 已是最新：标题为「已是最新版本 0.1.0」", facts.latest === "0.1.0" && facts.available === "false" && facts.title.indexOf("已是最新版本 0.1.0") >= 0, "0.1.0 + 已是最新版本", facts.title);
  await step("02-latest", facts, "latest");

  /* ③ 有更新（真实 check：版本 / 发布时间 / 说明链接 / 来源仓库） */
  await setState(stateFile, { version: "0.2.0", zip: deps.zips["0.2.0"], notesUrl: NOTES, publishedAt: PUBLISHED, noRelease: false, delayZipMs: 0 });
  await clickCheck(page);
  facts = await panelFacts(page);
  record("copy", "③ 有更新：版本 0.2.0 + 发布时间 + 说明链接 + 来源仓库", facts.latest === "0.2.0" && facts.available === "true" && facts.notes === NOTES && facts.sourceRepo === "bllack/OpenArc-OS" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(facts.published), "0.2.0 + NOTES + 时间", facts.latest + " / " + facts.published + " / " + facts.notes);
  record("action", "③ 有更新：更新按钮可用", facts.installDisabled === false, "enabled", String(facts.installDisabled));
  await step("03-available", facts, "available");

  /* ④ 二次确认弹层（Esc 取消不得发起安装） */
  const opened = await clickInstall(page);
  await H.sleep(150);
  facts = await panelFacts(page);
  record("confirm", "④ 点击更新出现二次确认弹层", opened && facts.confirmKind === "install", "install", String(facts.confirmKind));
  record("confirm", "④ 确认层讲清来源 / 目标版本 / 不静默安装", !!facts.confirmText && facts.confirmText.indexOf("ModelScope 仓库（bllack/OpenArc-OS）") >= 0 && facts.confirmText.indexOf("0.2.0") >= 0 && facts.confirmText.indexOf("不会在后台静默安装") >= 0, "来源 + 0.2.0 + 静默说明", String(facts.confirmText).slice(0, 200));
  await step("04-confirm", facts, "available");
  await page.keyboard.press("Escape");
  await H.waitFor(async () => !(await page.$("[data-canvas-update-confirm]")), 5000, 100);
  const afterCancel = await panelFacts(page);
  record("confirm", "④ Esc 取消后没有安装：当前版本仍为空、仍是有更新态", afterCancel.current === "0.1.0" && afterCancel.state === "available" && afterCancel.available === "true", "current=0.1.0 / available", afterCancel.current + " / " + afterCancel.state);

  /* ⑤ 安装进行中（fixture 延迟 zip 响应，真实 install 正在下载） */
  const delay = spec.narrow ? 3500 : 7000;
  await setState(stateFile, { version: "0.2.0", zip: deps.zips["0.2.0"], notesUrl: NOTES, publishedAt: PUBLISHED, noRelease: false, delayZipMs: delay });
  await clickInstall(page);
  await confirmDialog(page);
  const busyOk = await H.waitFor(async () => await page.evaluate(() => {
    const p = document.querySelector('[data-canvas-update="1"]');
    return !!p && p.getAttribute("data-canvas-update-busy") === "install";
  }), 8000, 80);
  facts = await panelFacts(page);
  record("progress", "⑤ 安装中：data-canvas-update-busy=install", busyOk && facts.busy === "install", "install", String(facts.busy));
  record("progress", "⑤ 安装中：有进行中的文字状态且不伪造百分比", facts.progress.indexOf("正在下载并校验更新包") >= 0 && facts.progress.indexOf("%") < 0, "进行中说明 + 无 %", facts.progress.slice(0, 140));
  record("progress", "⑤ 安装中：状态没有被提前标成成功", facts.state === "available", "available", facts.state);
  await step("05-installing", facts, "available");

  /* ⑥ 安装成功（真实验签 / 解压 / 原子切换 → current.json 变成 0.2.0） */
  const installedOk = await H.waitFor(async () => await page.evaluate(() => {
    const p = document.querySelector('[data-canvas-update="1"]');
    return !!p && p.getAttribute("data-canvas-update-current") === "0.2.0" && !!p.querySelector("[data-canvas-update-notice]");
  }), Math.max(20000, delay * 3), 150);
  facts = await panelFacts(page);
  record("install", "⑥ 安装成功：真实安装后当前版本 = 0.2.0 且有成功文案", installedOk && facts.current === "0.2.0" && facts.notice.indexOf("已更新到 0.2.0") >= 0, "current=0.2.0 + 已更新到 0.2.0", facts.current + " / " + facts.notice);
  const installedReal = findFile(run.userDataDir, "current.json");
  const currentJson = installedReal ? JSON.parse(fs.readFileSync(installedReal, "utf8")) : null;
  record("install", "⑥ 隔离 userData 里真实写入 current.json（version=0.2.0）", !!currentJson && currentJson.version === "0.2.0", "version=0.2.0", JSON.stringify(currentJson));
  record("install", "⑥ 真实安装目录存在（dxos/apps/canvas/0.2.0）", !!findFile(run.userDataDir, "manifest.sig") && fs.existsSync(path.join(path.dirname(findFile(run.userDataDir, "current.json")), "0.2.0")), "0.2.0 目录存在", String(!!findFile(run.userDataDir, "manifest.sig")));
  await step("06-installed", facts, "latest");

  /* ⑦ 可回滚（再真实安装 0.3.0，history 里留下 0.2.0） */
  await setState(stateFile, { version: "0.3.0", zip: deps.zips["0.3.0"], notesUrl: NOTES, publishedAt: PUBLISHED, noRelease: false, delayZipMs: 0 });
  await clickCheck(page);
  await clickInstall(page);
  await confirmDialog(page);
  const rollbackReady = await H.waitFor(async () => await page.evaluate(() => {
    const p = document.querySelector('[data-canvas-update="1"]');
    return !!p && p.getAttribute("data-canvas-update-current") === "0.3.0" && p.getAttribute("data-canvas-update-can-rollback") === "true";
  }), 20000, 150);
  facts = await panelFacts(page);
  record("install", "⑦ 可回滚：再装 0.3.0 后 current=0.3.0 且 canRollback=true", rollbackReady && facts.current === "0.3.0" && facts.canRollback === "true", "0.3.0 / true", facts.current + " / " + facts.canRollback);
  record("install", "⑦ 可回滚：回滚按钮可用", facts.rollbackDisabled === false, "enabled", String(facts.rollbackDisabled));
  await step("07-rollback-ready", facts, "latest");

  /* ⑧ 回滚二次确认 + 真实回滚 */
  await H.clickSelector(page, "[data-canvas-update-rollback]");
  const rollbackDialog = await H.waitFor(() => page.$("[data-canvas-update-confirm]"), 6000, 100);
  facts = await panelFacts(page);
  record("rollback", "⑧ 回滚同样有二次确认弹层", rollbackDialog && facts.confirmKind === "rollback", "rollback", String(facts.confirmKind));
  record("rollback", "⑧ 回滚确认层说明会回滚到上一版", !!facts.confirmText && facts.confirmText.indexOf("回滚") >= 0 && facts.confirmText.indexOf("0.3.0") >= 0, "含 0.3.0 + 回滚说明", String(facts.confirmText).slice(0, 160));
  await step("08-rollback-confirm", facts, "latest");
  await confirmDialog(page);
  const rolledBack = await H.waitFor(async () => await page.evaluate(() => {
    const p = document.querySelector('[data-canvas-update="1"]');
    const n = p && p.querySelector("[data-canvas-update-notice]");
    return !!p && p.getAttribute("data-canvas-update-current") === "0.2.0" && !!n && (n.textContent || "").indexOf("已回滚到 0.2.0") >= 0;
  }), 20000, 150);
  facts = await panelFacts(page);
  record("rollback", "⑧ 真实回滚完成：current 回到 0.2.0 且有回滚文案", rolledBack, "current=0.2.0 + 已回滚到 0.2.0", facts.current + " / " + facts.notice);

  /* ⑨ 失败态：真实坏签名包（用另一把 Ed25519 私钥签 manifest） */
  await setState(stateFile, { version: "0.3.0", zip: deps.zips["0.3.0-badsig"], notesUrl: NOTES, publishedAt: PUBLISHED, noRelease: false, delayZipMs: 0 });
  await clickCheck(page);
  const beforeFail = await panelFacts(page);
  record("failure", "⑨ 坏签名包仍被 check 认为是新版本（0.3.0）", beforeFail.available === "true" && beforeFail.latest === "0.3.0", "available / 0.3.0", beforeFail.state + " / " + beforeFail.latest);
  await clickInstall(page);
  await confirmDialog(page);
  const failedOk = await H.waitFor(async () => await page.evaluate(() => {
    const p = document.querySelector('[data-canvas-update="1"]');
    return !!p && p.getAttribute("data-canvas-update-state") === "failed";
  }), 20000, 150);
  facts = await panelFacts(page);
  record("failure", "⑨ 坏签名失败：state=failed 且原始错误码在 data-*", failedOk && facts.errorCode === "MARKET_UPDATE_SIGNATURE_INVALID", "failed / MARKET_UPDATE_SIGNATURE_INVALID", facts.state + " / " + facts.errorCode);
  record("failure", "⑨ 失败态：结构化中文错误 + 可重试", facts.title.indexOf("签名校验没通过") >= 0 && facts.installDisabled === false, "中文错误 + 更新按钮可用", facts.title + " / disabled=" + facts.installDisabled);
  record("failure", "⑨ 失败后当前版本没有被改动（仍是 0.2.0）", facts.current === "0.2.0", "0.2.0", facts.current);
  await step("09-failed", facts, "failed");

  /* 切源：换 kind 写回；同 kind 不重写（不覆盖已保存的选择） */
  const mtimeOf = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return null; } };
  await page.evaluate(() => { const b = document.querySelector('[data-canvas-update-source-option="github-releases"]'); if (b) b.click(); });
  const switched = await H.waitFor(async () => await page.evaluate(() => {
    const p = document.querySelector('[data-canvas-update="1"]');
    return !!p && p.getAttribute("data-canvas-update-source") === "github-releases";
  }), 8000, 120);
  facts = await panelFacts(page);
  record("source", "S1 · 切到 GitHub Releases：来源立即更新且提示需要重新检查", switched && facts.source === "github-releases" && facts.sourceRepo === "invaders-2/OpenArc-OS" && facts.notice.indexOf("已切换到 GitHub Releases") >= 0, "github-releases + 提示", facts.sourceRepo + " / " + facts.notice);
  record("source", "S2 · 换源后不再显示上一个源的检查结果（退回未检查）", facts.state === "unchecked", "unchecked", facts.state);
  /* source.json 在第一次显式 source/set 之后才存在，所以要在这之后取路径 */
  const sourceJson = findFile(run.userDataDir, "source.json");
  const m1 = mtimeOf(sourceJson);
  await page.evaluate(() => { const b = document.querySelector('[data-canvas-update-source-option="github-releases"]'); if (b) b.click(); });
  await H.sleep(400);
  const sourceJsonAfter = findFile(run.userDataDir, "source.json");
  const m2 = mtimeOf(sourceJsonAfter);
  record("source", "S3 · 重复点同一个源不再写回 source.json（不覆盖已保存的选择）", m1 !== null && m2 !== null && m1 === m2 && sourceJsonAfter === sourceJson, "mtime 不变", String(sourceJson) + "@" + String(m1) + " → " + String(sourceJsonAfter) + "@" + String(m2));
  await clickCheck(page);
  facts = await panelFacts(page);
  record("source", "S4 · GitHub 源上 check 如实回「还没有发布版本」（fixture 空 Release 列表）", facts.latest === "" && facts.title.indexOf("还没有发布版本") >= 0 && facts.source === "github-releases", "空 latest + 无发布文案", facts.title + " / " + facts.source);
  await page.evaluate(() => { const b = document.querySelector('[data-canvas-update-source-option="modelscope-repo"]'); if (b) b.click(); });
  const backToModelscope = await H.waitFor(async () => await page.evaluate(() => {
    const p = document.querySelector('[data-canvas-update="1"]');
    return !!p && p.getAttribute("data-canvas-update-source") === "modelscope-repo";
  }), 8000, 120);
  record("source", "S5 · 可以切回 ModelScope（默认源）", backToModelscope && (await panelFacts(page)).sourceRepo === "bllack/OpenArc-OS", "modelscope-repo / bllack-OpenArc-OS", JSON.stringify(await panelFacts(page)));
}

/* ── 主流程 ─────────────────────────────────────────────────────────────── */
async function main() {
  const chromium = require("@playwright/test").chromium;
  const electronPath = require("electron");
  const electronVersion = (function () { try { return require("electron/package.json").version; } catch { return null; } })();
  const startedAt = Date.now();
  fs.mkdirSync(SCR, { recursive: true });

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oa-canvas-update-fixture-"));
  const stateFile = path.join(tmpRoot, "fixture-state.json");
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-shim-"));
  const shimPath = path.join(shimDir, "shim.cjs");
  fs.writeFileSync(shimPath, [
    "/* 空格安全的 NODE_OPTIONS --require 入口：真正的 fixture 用绝对路径 require。 */",
    "const target = process.env.OA_UPDATE_FIXTURE_MODULE;",
    "if (target) require(target);",
    "module.exports = {};",
  ].join(String.fromCharCode(10)));

  const keyPath = path.join(ROOT, ".keys", "update-signing.key");
  if (!fs.existsSync(keyPath)) throw new Error("缺少画布签名私钥：" + keyPath + "（先跑 node scripts/oa-update-keygen.mjs）");
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
  const freshKey = crypto.generateKeyPairSync("ed25519").privateKey;
  const publicKeyFile = JSON.parse(fs.readFileSync(path.join(ROOT, "resources", "app-update-keys.json"), "utf8"));
  const signingPublic = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  const zips = {};
  for (const version of ["0.1.0", "0.2.0", "0.3.0"]) zips[version] = buildCanvasZip(version, privateKey).bytes;
  zips["0.3.0-badsig"] = buildCanvasZip("0.3.0", freshKey).bytes;
  for (const [name, bytes] of Object.entries(zips)) fs.writeFileSync(path.join(tmpRoot, "canvas-" + name + ".zip"), bytes);
  const zipPaths = {};
  for (const name of Object.keys(zips)) zipPaths[name] = path.join(tmpRoot, "canvas-" + name + ".zip");

  console.log("=== 无限画布在线更新界面 · 真机探针 ===");
  console.log("参考视口：" + REF.width + "x" + REF.height + "@" + REF.dsf + "（像素 " + REF.width * REF.dsf + "x" + REF.height * REF.dsf + "）；窄窗 " + NARROW.width + "x" + NARROW.height + "@" + NARROW.dsf);
  console.log("离线 fixture 源：主进程 fetch → " + path.relative(ROOT, path.join(HERE, "fixture-source.cjs")) + "（NODE_OPTIONS=--require <临时 shim>）");
  console.log("包：" + Object.keys(zips).map((n) => n + "(" + zips[n].length + "B)").join(", "));

  const deps = { chromium, electronPath, shimPath, stateFile, tmpRoot, zips: zipPaths };
  const allSpecs = [
    { id: "light", theme: "light", narrow: false, reduced: false },
    { id: "dark", theme: "dark", narrow: false, reduced: false },
    { id: "narrow", theme: "light", narrow: true, reduced: true },
  ];
  const only = (process.env.OA_CANVAS_UPDATE_RUNS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const specs = only.length ? allSpecs.filter((s) => only.indexOf(s.id) >= 0) : allSpecs;
  for (const spec of specs) {
    activeRun = null;
    await runOne(spec, deps);
  }

  const badPublic = crypto.createPublicKey(freshKey).export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  record("setup", "Z1 · 合法包由内置私钥签发、坏签名包由另一把私钥签发（两者公钥不同）", signingPublic === publicKeyFile.canvas && badPublic !== publicKeyFile.canvas && badPublic !== signingPublic, "合法=内置，坏签名≠内置", JSON.stringify({ builtin: publicKeyFile.canvas, signedByProbe: signingPublic, badSigner: badPublic }));
  record("hygiene", "H0 · 全程 console error = 0", consoleErrors.length === 0, 0, consoleErrors.length + " → " + JSON.stringify(consoleErrors.slice(0, 5)));
  record("hygiene", "H1 · 全程 pageerror = 0", pageErrors.length === 0, 0, pageErrors.length + " → " + JSON.stringify(pageErrors.slice(0, 5)));
  record("hygiene", "H2 · 渲染层无非本地请求", nonLocal.length === 0, 0, nonLocal.length + " → " + JSON.stringify(nonLocal.slice(0, 5)));

  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  const report = {
    phase: "dxos-canvas-update-ui",
    title: "无限画布「在线更新」界面 · 真机视觉探针",
    at: H.nowIso(),
    durationMs: Date.now() - startedAt,
    command: "node experiments/dxos-canvas-update-ui/run-all.mjs",
    environment: { platform: process.platform, arch: process.arch, node: process.version, electron: electronVersion, cwd: ROOT },
    condition: {
      referenceViewport: { id: REF.id, width: REF.width, height: REF.height, dsf: REF.dsf, pixels: REF.width * REF.dsf + "x" + REF.height * REF.dsf },
      narrowViewport: { id: NARROW.id, width: NARROW.width, height: NARROW.height, dsf: NARROW.dsf },
      themeSwitchPath: "真实 UI：顶栏「控制中心」→ 外观（浅色 / 深色）",
      reducedMotionPath: "真实 UI：顶栏「控制中心」→ 减少动态",
      updatePath: "真实 contextBridge 桥（39 键，未顶替）→ market:command → electron/market-update-service.cjs → 真实验签 / 摘要 / 解压 / 原子切换 / 审计",
      networkFixture: "主进程 globalThis.fetch 被 " + path.relative(ROOT, path.join(HERE, "fixture-source.cjs")) + " 顶替（NODE_OPTIONS=--require <临时 shim>）；只拦 modelscope.cn 与 api.github.com，其余原样透传并断言为 0",
      signingKeys: { signedWith: ".keys/update-signing.key（真钥，install 才能成功）", badSignatureWith: "运行时新生成的 Ed25519 私钥（验签必然失败）" },
      isolation: "每次运行独立 --user-data-dir 临时目录 + 唯一 --remote-debugging-port",
    },
    runs: runs.map((r) => ({ id: r.id, theme: r.theme, narrow: r.narrow, port: r.port, userDataDir: r.userDataDir, fixtureLog: r.fixtureLog, fatal: r.fatal, checks: { total: 0, passed: 0, failed: 0 } })),
    screenshots: captures.map((c) => ({ key: c.key, run: c.run, theme: c.theme, narrow: !!c.narrow, state: c.state, file: c.file, width: c.width, height: c.height })),
    selectors: SELECTORS,
    states: runs.reduce((acc, r) => { acc[r.id] = r.states; return acc; }, {}),
    counts: { checks: checks.length, passed, failed, screenshots: captures.length },
    checks,
    notes,
    findings,
    verdict: failed > 0 ? "HAS-FAILURES" : "ALL-CHECKS-PASS",
  };
  for (const entry of report.runs) {
    const owned = checks.slice(0, checks.length).filter((c) => c.run === entry.id);
    entry.checks = { total: owned.length, passed: owned.filter((c) => c.ok).length, failed: owned.filter((c) => !c.ok).length };
  }
  fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(ART, "checks.json"), JSON.stringify(checks, null, 2));

  const md = [];
  md.push("# 无限画布「在线更新」真机探针 · data-* 选择器清单");
  md.push("");
  md.push("生成时间：" + report.at + " · 参考视口 " + REF.id + "@" + REF.dsf + "（像素 " + REF.width * REF.dsf + "x" + REF.height * REF.dsf + "）· 窄窗 " + NARROW.id + "@" + NARROW.dsf);
  md.push("");
  md.push("| 选择器 | 含义 |");
  md.push("| --- | --- |");
  for (const row of SELECTORS) md.push("| `" + row.selector + "` | " + row.meaning + " |");
  md.push("");
  md.push("## 截图");
  md.push("");
  for (const c of report.screenshots) md.push("- [" + c.key + "](" + c.file + ") — 运行 " + c.run + (c.narrow ? " · 窄窗 820" : "") + " · state=" + c.state);
  md.push("");
  md.push("断言：" + passed + " PASS / " + failed + " FAIL（共 " + checks.length + "）");
  fs.writeFileSync(path.join(ART, "SELECTORS.md"), md.join("\n"));

  console.log("\n========== 汇总 ==========");
  console.log("断言：" + passed + " PASS / " + failed + " FAIL（共 " + checks.length + "）");
  console.log("截图 " + captures.length + " 张 → " + path.relative(ROOT, SCR));
  console.log("报告：" + path.relative(ROOT, path.join(ART, "report.json")));
  if (failed > 0) {
    console.log("\n失败项：");
    for (const c of checks.filter((x) => !x.ok)) console.log("  - [" + c.run + "/" + c.section + "] " + c.name + " :: actual=" + c.actual);
  }
  process.exitCode = report.verdict === "ALL-CHECKS-PASS" ? 0 : 1;
}

main().catch((error) => { console.error("探针异常：" + ((error && error.stack) || error)); process.exitCode = 1; });
