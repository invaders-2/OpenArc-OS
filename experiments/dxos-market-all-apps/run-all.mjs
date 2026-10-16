#!/usr/bin/env node
/**
 * 应用商店「升级」泛化到所有应用 · 真机视觉探针（experiments/dxos-market-all-apps）。
 *
 * 被测对象：默认 Vue 壳（dist/vue.html）→ 应用市场 → 每个应用的版本条目 + 通用更新面板。
 *   · 卡片：src-vue/apps/MarketApp.vue + src-vue/apps.ts（每条 version）
 *   · 面板：src-vue/apps/CanvasUpdatePanel.vue + src-vue/apps/appUpdateLogic.ts（按 appId 驱动）
 *
 * 不 stub 渲染层桥：contextBridge 的 window.openarc 不可写，命令全部走真实 IPC →
 * electron/market-update-service.cjs（真实验签 / 摘要 / 解压 / 原子切换 / 审计），只把网络换成
 * 主进程内的离线 fixture（fixture-source.cjs，NODE_OPTIONS=--require <shim> 顶替 globalThis.fetch）。
 *
 * 场景：① 商店里每个应用都显示版本；② canvas 显示「有新版本」并真实安装成功；
 *       ③ notes 有包但暂不支持加载（如实标注、无安装按钮）；④ photos 无发布包是正常状态；
 *       ⑤ 0 console error / 0 pageerror；深浅 + 窄窗截图。
 *
 * 硬约束：不联网（fixture 之外的请求断言 passthrough=0）；不改产品代码；不新增依赖；不 commit。
 * 用法：node experiments/dxos-market-all-apps/run-all.mjs
 *      OA_MARKET_ALL_APPS_RUNS=light node experiments/dxos-market-all-apps/run-all.mjs
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
const ART = path.join(ROOT, "artifacts", "dxos-market-all-apps");
const SCR = path.join(ART, "screens");
const REF = { id: "1440x900", width: 1440, height: 900, dsf: 2 };
const NARROW = { id: "820x720", width: 820, height: 720, dsf: 2 };
const AREA_TOP = 38;
const MARKET_WIN = 'section.window[aria-label="应用市场窗口"]';
const PANEL = '[data-canvas-update="1"]';
const PUBLISHED = 1776300000000;
const NOTES_URL = "https://modelscope.cn/models/bllack/OpenArc-OS";
const EXPECTED_APP_IDS = [
  "home", "browser", "files", "resource-library", "canvas", "projects", "organization", "skills",
  "mcp-center", "protocols", "settings", "trash", "chat", "automation", "calendar", "notes",
  "photos", "music", "weather", "video", "dev", "declare", "drama",
];
const NARROW_SHOTS = ["01-market-cards", "02-canvas-available", "05-notes-unsupported"];

const SELECTORS = [
  { selector: '[data-app-card="<appId>"]', meaning: "商店里每个应用的卡片" },
  { selector: "[data-app-version]", meaning: "卡片上的随包内置版本" },
  { selector: "[data-app-update-detail]", meaning: "卡片上的更新状态（有无更新 / 能否升级）" },
  { selector: '[data-app-update-open="<appId>"]', meaning: "非画布应用的「版本与更新 / 升级」入口" },
  { selector: "[data-canvas-update-open]", meaning: "画布专用的「在线更新」入口（保留可用）" },
  { selector: "[data-canvas-update-install]", meaning: "更新面板里的安装按钮（不可加载的应用不出现）" },
  { selector: '[data-app-update="<appId>"]', meaning: "更新面板按 appId 驱动的通用根标记" },
  { selector: "[data-app-update-loadable]", meaning: "该应用是否接入安装包加载路径" },
  { selector: "[data-app-update-phase]", meaning: "通用状态机：unchecked/checking/latest/available/unsupported/failed" },
];

const checks = [];
const captures = [];
const notes = [];
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
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

const require = createRequire(path.join(ROOT, "package.json"));
const writeZip = require(path.join(ROOT, "electron", "canvas-dxos-zip.cjs")).writeZip;

function buildAppZip(appId, version, privateKey) {
  const js = Buffer.from("/* OpenArc " + appId + " fixture " + version + " */\n", "utf8");
  const css = Buffer.from("." + appId + "-fixture{color:inherit}\n", "utf8");
  const manifest = {
    format: "openarc-app/v1",
    id: appId,
    name: appId,
    version,
    build: 1,
    entry: "index.js",
    styles: ["index.css"],
    files: { "index.js": sha256(js), "index.css": sha256(css) },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  const signature = crypto.sign(null, manifestBytes, privateKey).toString("base64");
  return writeZip([
    { name: "manifest.json", data: manifestBytes },
    { name: "index.js", data: js },
    { name: "index.css", data: css },
    { name: "manifest.sig", data: Buffer.from(signature, "utf8") },
  ]);
}

/* ── 页内度量 ───────────────────────────────────────────────────────────── */
async function marketFacts(page) {
  return page.evaluate(() => {
    const win = document.querySelector('section.window[aria-label="应用市场窗口"]');
    const cards = Array.prototype.slice.call(document.querySelectorAll("[data-app-card]")).map((el) => ({
      id: el.getAttribute("data-app-card"),
      version: el.getAttribute("data-app-version"),
      detail: ((el.querySelector("[data-app-update-detail]") || {}).textContent || "").replace(/\s+/g, " ").trim(),
      rawCurrent: el.getAttribute("data-app-update-current"),
      rawLatest: el.getAttribute("data-app-update-latest"),
      rawChecked: el.getAttribute("data-app-update-checked"),
    }));
    return {
      cards,
      panelOpen: !!document.querySelector('[data-canvas-update="1"]'),
      docScrollWidth: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      winRect: win ? [Math.round(win.getBoundingClientRect().width), Math.round(win.getBoundingClientRect().height)] : null,
    };
  });
}

async function panelFacts(page) {
  return page.evaluate(() => {
    const p = document.querySelector('[data-canvas-update="1"]');
    if (!p) return null;
    const get = (n) => p.getAttribute("data-" + n);
    const dialog = document.querySelector("[data-canvas-update-confirm]");
    const errorEl = p.querySelector("[data-canvas-update-error-code]");
    return {
      state: get("canvas-update-state"),
      busy: get("canvas-update-busy"),
      title: (p.querySelector("[data-canvas-update-title]") || {}).textContent || "",
      notice: (p.querySelector("[data-canvas-update-notice]") || {}).textContent || "",
      current: get("canvas-update-current"),
      builtin: get("canvas-update-builtin"),
      latest: get("canvas-update-latest"),
      available: get("canvas-update-available"),
      canRollback: get("canvas-update-can-rollback"),
      errorCode: errorEl ? errorEl.getAttribute("data-canvas-update-error-code") : null,
      appId: p.getAttribute("data-app-update"),
      appName: p.getAttribute("data-app-update-name"),
      phase: p.getAttribute("data-app-update-phase"),
      loadable: p.getAttribute("data-app-update-loadable"),
      hasInstallButton: !!p.querySelector("[data-canvas-update-install]"),
      confirmKind: dialog ? dialog.getAttribute("data-canvas-update-confirm") : null,
      confirmText: dialog ? (dialog.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300) : null,
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

async function openPanel(page, appId) {
  const selector = appId === "canvas" ? "[data-canvas-update-open]" : '[data-app-update-open="' + appId + '"]';
  const clicked = await H.clickSelector(page, selector);
  if (!clicked) return false;
  const ready = await H.waitFor(async () => await page.evaluate(() => {
    const p = document.querySelector('[data-canvas-update="1"]');
    return !!p && p.getAttribute("data-canvas-update-busy") === "idle";
  }), 12000, 120);
  if (!ready) return false;
  const bound = await page.evaluate((id) => {
    const p = document.querySelector('[data-canvas-update="1"]');
    return !!p && p.getAttribute("data-app-update") === id;
  }, appId);
  return bound;
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

/* ── 单次运行 ───────────────────────────────────────────────────────────── */
async function runOne(spec, deps) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-market-all-apps-" + spec.id + "-"));
  const logFile = path.join(deps.tmpRoot, "fixture-" + spec.id + ".log");
  fs.writeFileSync(logFile, "");
  activeRun = { id: spec.id, theme: spec.theme, narrow: !!spec.narrow, userDataDir, logFile, states: {}, fatal: null };
  const view = spec.narrow ? NARROW : REF;
  console.log("\n=== 运行 " + spec.id + "：theme=" + spec.theme + " viewport=" + view.width + "x" + view.height + "@" + view.dsf + " ===");

  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  env.NODE_OPTIONS = (process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + " " : "") + "--require " + deps.shimPath;
  env.OA_ALL_APPS_FIXTURE_MODULE = path.join(HERE, "fixture-source.cjs");
  env.OA_ALL_APPS_FIXTURE_STATE = deps.stateFile;
  env.OA_ALL_APPS_FIXTURE_LOG = logFile;

  let launched = null;
  try {
    launched = await H.launchElectron({ ROOT, electronPath: deps.electronPath, chromium: deps.chromium, userDataDir, env });
    activeRun.port = launched.port;
    const context = launched.browser.contexts()[0];
    const found = await H.waitFor(() => !!context.pages().find((p) => /vue\.html/.test(p.url())), 40000, 300);
    const page = found ? context.pages().find((p) => /vue\.html/.test(p.url())) : null;
    if (!page) throw new Error("未找到 dist/vue.html 渲染页：" + context.pages().map((p) => p.url()).join(" | "));
    page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(spec.id + ": " + String(msg.text()).slice(0, 300)); });
    page.on("pageerror", (err) => pageErrors.push(spec.id + ": " + String((err && err.message) || err).slice(0, 300)));
    page.on("request", (req) => {
      const url = req.url();
      if (!/^(file:|data:|blob:|about:|devtools:|openarc-file:|openarc-resource:|openarc-canvas:|http:\/\/(127\.0\.0\.1|localhost|\[::1\])|ws:\/\/(127\.0\.0\.1|localhost))/i.test(url)) nonLocal.push(spec.id + ": " + url);
    });

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: view.width, height: view.height, deviceScaleFactor: view.dsf, mobile: false });
    await page.emulateMedia({ reducedMotion: "no-preference", colorScheme: "no-preference" });

    const ready = await H.waitFor(async () => await page.evaluate(() => document.readyState === "complete" && !!window.openarc), 45000, 300);
    record("boot", "B1 · 真实 electron 渲染层就绪（dist/vue.html）", ready, "readyState=complete + window.openarc", String(ready));

    const identifier = "ui-market-all-apps-" + spec.id + "@openarc.test";
    const password = "UiMarketAllApps-1";
    const initRes = await H.callBridge(page, "identity", "identity/initialize", { identifier, password, displayName: "全应用更新验证 " + spec.id });
    const loginRes = await H.callBridge(page, "identity", "identity/login", { identifier, password });
    const gateReady = await H.waitFor(async () => await page.evaluate(() => {
      const d = document.querySelector(".desktop");
      return d ? d.getAttribute("data-identity-gate") === "ready" : false;
    }), 25000, 200);
    record("boot", "B2 · 隔离 userData 内初始化 + 登录进入 ready", !!(initRes.result && initRes.result.ok) && !!(loginRes.result && loginRes.result.ok) && gateReady, "ok + gate=ready", JSON.stringify({ init: initRes.result && initRes.result.ok, login: loginRes.result && loginRes.result.ok, gate: gateReady }));

    const marketOpened = await openMarket(page);
    record("entry", "E1 · 经真实 UI「应用中心 → 应用市场」打开市场窗口", marketOpened, MARKET_WIN, String(marketOpened));
    if (!marketOpened) throw new Error("应用市场未打开");
    await H.focusWindow(page, MARKET_WIN);
    const fitted = await H.setViewport(page, cdp, view, MARKET_WIN, AREA_TOP);
    record("layout", "L1 · 市场窗口最大化后精确贴合 " + view.id + " 视图（顶部让开 38px）", fitted, view.width + "x" + (view.height - AREA_TOP), String(fitted));
    await H.sleep(200);

    const themed = await setThemeViaControlCenter(page, spec.theme);
    record("theme", "T1 · 经真实「控制中心 → 外观」切到" + (spec.theme === "dark" ? "深色" : "浅色"), themed, spec.theme, String(themed));

    // ① 每个应用都有版本条目
    const cardsReady = await H.waitFor(async () => (await marketFacts(page)).cards.length >= EXPECTED_APP_IDS.length, 15000, 200);
    let facts = await marketFacts(page);
    record("cards", "C1 · 商店列出全部 " + EXPECTED_APP_IDS.length + " 个应用（market 自身除外）", cardsReady && facts.cards.length === EXPECTED_APP_IDS.length, EXPECTED_APP_IDS.length, JSON.stringify(facts.cards.map((c) => c.id)));
    const ids = facts.cards.map((c) => c.id).sort();
    record("cards", "C2 · 应用清单与注册表一致（不多不少）", JSON.stringify(ids) === JSON.stringify(EXPECTED_APP_IDS.slice().sort()), "与 EXPECTED_APP_IDS 全等", JSON.stringify(ids));
    const missingVersion = facts.cards.filter((c) => !c.version || !/^\d+\.\d+\.\d+$/.test(c.version));
    record("cards", "C3 · 每个应用都显示版本（无缺失、无非法值）", missingVersion.length === 0, "0 个缺失", JSON.stringify(missingVersion));
    const versions = new Set(facts.cards.map((c) => c.version));
    record("cards", "C4 · 版本来自注册表随包内置版本（本期均为 0.1.0）", versions.size === 1 && versions.has("0.1.0"), "全部 0.1.0", JSON.stringify(Array.from(versions)));

    // ② canvas：有新版本 → 二次确认 → 真实安装成功
    const canvasPanel = await openPanel(page, "canvas");
    record("canvas", "V1 · 画布「在线更新」入口打开通用面板（data-app-update=canvas）", canvasPanel, "canvas", String(canvasPanel));
    await clickCheck(page);
    facts = await panelFacts(page);
    record("canvas", "V2 · 画布 check 后 state=available 且 latest=0.2.0", facts.state === "available" && facts.latest === "0.2.0" && facts.available === "true", "available / 0.2.0", facts.state + " / " + facts.latest);
    record("canvas", "V3 · 画布 loadable=true（安装会真正生效）且沿用「无限画布」称呼", facts.loadable === "true" && facts.appId === "canvas" && facts.appName === "无限画布", "true / canvas / 无限画布", facts.loadable + " / " + facts.appId + " / " + facts.appName);
    await shoot(page, cdp, spec, "02-canvas-available", facts.state);
    const confirmOpened = await clickInstall(page);
    let confirmFacts = await panelFacts(page);
    record("canvas", "V4 · 安装前有二次确认层，讲清来源 / 版本 / 不静默安装", confirmOpened && confirmFacts.confirmKind === "install" && confirmFacts.confirmText.indexOf("0.2.0") >= 0 && confirmFacts.confirmText.indexOf("不会在后台静默安装") >= 0, "install + 0.2.0 + 静默说明", String(confirmFacts.confirmText).slice(0, 160));
    await shoot(page, cdp, spec, "03-canvas-confirm", confirmFacts.state);
    await confirmDialog(page);
    const installed = await H.waitFor(async () => await page.evaluate(() => {
      const p = document.querySelector('[data-canvas-update="1"]');
      return !!p && p.getAttribute("data-canvas-update-current") === "0.2.0" && !!p.querySelector("[data-canvas-update-notice]");
    }), 20000, 150);
    facts = await panelFacts(page);
    record("canvas", "V5 · 真实安装成功：current=0.2.0 + 成功文案", installed && facts.current === "0.2.0" && facts.notice.indexOf("已更新到 0.2.0") >= 0, "current=0.2.0", facts.current + " / " + facts.notice);
    const currentJson = findFile(userDataDir, "current.json");
    const currentValue = currentJson ? JSON.parse(fs.readFileSync(currentJson, "utf8")) : null;
    record("canvas", "V6 · 隔离 userData 里真实写入 canvas current.json", !!currentValue && currentValue.version === "0.2.0" && currentJson.indexOf(path.join("apps", "canvas")) >= 0, "apps/canvas/current.json = 0.2.0", JSON.stringify(currentValue));
    await shoot(page, cdp, spec, "04-canvas-installed", facts.state);
    await closePanel(page);

    // ③ notes：有包但渲染层不支持加载 → 如实标注、无安装按钮
    const notesPanel = await openPanel(page, "notes");
    record("notes", "N1 · 非画布应用入口打开通用面板（data-app-update=notes）", notesPanel, "notes", String(notesPanel));
    await clickCheck(page);
    facts = await panelFacts(page);
    record("notes", "N2 · notes 有发布包时如实报有新版本", facts.latest === "0.2.0" && facts.available === "true", "0.2.0 / true", facts.latest + " / " + facts.available);
    record("notes", "N3 · 状态进入 unsupported，标题写明「暂不支持安装包加载」", facts.state === "unsupported" && facts.title.indexOf("暂不支持安装包加载") >= 0, "unsupported + 暂不支持安装包加载", facts.state + " / " + facts.title);
    record("notes", "N4 · notes 不出现安装按钮（不假装可升级）", facts.hasInstallButton === false, "无安装按钮", String(facts.hasInstallButton));
    record("notes", "N5 · notes loadable=false 且文案说明不会安装", facts.loadable === "false" && facts.title.indexOf("0.2.0") >= 0, "false + 0.2.0", facts.loadable + " / " + facts.title);
    await shoot(page, cdp, spec, "05-notes-unsupported", facts.state);
    await closePanel(page);

    // ④ photos：没有发布包 → 正常状态，不是错误
    const photosPanel = await openPanel(page, "photos");
    record("photos", "P0 · photos 入口打开通用面板", photosPanel, "photos", String(photosPanel));
    await clickCheck(page);
    facts = await panelFacts(page);
    record("photos", "P1 · 无发布包时 latest 为空且 state=latest（不是失败）", facts.latest === "" && facts.state === "latest" && facts.errorCode === null, "空 latest / latest", facts.latest + " / " + facts.state);
    record("photos", "P2 · 文案明确「还没有发布版本」且说明这不是错误", facts.title.indexOf("还没有发布版本") >= 0, "还没有发布版本", facts.title);
    await shoot(page, cdp, spec, "06-photos-no-release", facts.state);
    await closePanel(page);

    // 回到列表：卡片状态随检查结果刷新（关面板会重读每个应用的本机状态）
    const live = {};
    for (const id of ["canvas", "notes", "photos"]) {
      const res = await H.callBridge(page, "marketUpdate", "market/update/status", { appId: id });
      const value = res.result && res.result.value ? res.result.value : null;
      live[id] = value ? { current: value.current && value.current.version, latest: value.latest && value.latest.version, checkedAt: value.checkedAt, loadable: value.loadable } : res.result;
    }
    record("cards", "C8 · 画布卡片读到的原始状态 = 后端实际状态（current/latest 都是 0.2.0）", live.canvas && live.canvas.current === "0.2.0" && live.canvas.latest === "0.2.0", "current=0.2.0 latest=0.2.0", JSON.stringify(live.canvas));
    record("cards", "C9 · notes 卡片原始状态 = 有 0.2.0 发布包但 loadable=false", live.notes && live.notes.latest === "0.2.0" && live.notes.current === null && live.notes.loadable === false, "latest=0.2.0 current=null loadable=false", JSON.stringify(live.notes));
    record("cards", "C10 · photos 卡片原始状态 = 已检查但没有发布包（不是错误）", live.photos && live.photos.latest === null && live.photos.checkedAt != null, "latest=null checkedAt 有值", JSON.stringify(live.photos));
    const refreshed = await H.waitFor(async () => {
      const f = await marketFacts(page);
      const c = f.cards.find((x) => x.id === "canvas") || {};
      const n = f.cards.find((x) => x.id === "notes") || {};
      const p = f.cards.find((x) => x.id === "photos") || {};
      return c.detail.indexOf("已是最新") >= 0 && n.detail.indexOf("暂不支持安装包加载") >= 0 && p.detail.indexOf("无可用更新") >= 0;
    }, 15000, 200);
    facts = await marketFacts(page);
    const canvasCard = facts.cards.find((c) => c.id === "canvas") || {};
    const notesCard = facts.cards.find((c) => c.id === "notes") || {};
    const photosCard = facts.cards.find((c) => c.id === "photos") || {};
    record("cards", "C5 · 画布卡片刷新为「已是最新」（装完 0.2.0）", refreshed && canvasCard.detail.indexOf("已是最新") >= 0, "已是最新", canvasCard.detail);
    record("cards", "C6 · notes 卡片如实显示「有新版本 + 暂不支持安装包加载」", notesCard.detail.indexOf("暂不支持安装包加载") >= 0, "暂不支持安装包加载", notesCard.detail);
    record("cards", "C7 · photos 卡片如实显示「无可用更新」", photosCard.detail.indexOf("无可用更新") >= 0, "无可用更新", photosCard.detail);
    await shoot(page, cdp, spec, "01-market-cards", "cards");

    if (spec.narrow) {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      record("narrow", "NW1 · 窄窗列表无横向溢出", overflow <= 1, "<=1 px", overflow + " px");
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

  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
  const lines = log.split("\n").filter(Boolean);
  const modelscope = lines.filter((l) => l.indexOf("modelscope ") === 0);
  const passthrough = lines.filter((l) => l.indexOf("passthrough ") === 0);
  activeRun.fixtureLog = { lines: lines.length, modelscope: modelscope.length, passthrough: passthrough.length };
  record("fixture", "F1 · 按 appId 各取各的清单（canvas 与 notes 都探测到）", modelscope.some((l) => l.indexOf("FilePath=updates%2Fcanvas%2Flatest.json") >= 0 || l.indexOf("FilePath=updates/canvas/latest.json") >= 0) && modelscope.some((l) => l.indexOf("FilePath=updates%2Fnotes%2Flatest.json") >= 0 || l.indexOf("FilePath=updates/notes/latest.json") >= 0), "两个应用的清单都被读取", JSON.stringify(modelscope.slice(0, 4)));
  record("fixture", "F2 · 安装时真的下载了 canvas 包", modelscope.some((l) => l.indexOf("canvas-0.2.0.zip") >= 0), "有 canvas zip 下载", String(modelscope.filter((l) => l.indexOf("canvas-") >= 0).length));
  record("fixture", "F3 · 全程不旁路联网（passthrough=0）", passthrough.length === 0, 0, JSON.stringify(passthrough.slice(0, 3)));
  runs.push(activeRun);
  activeRun = null;
}

async function shoot(page, cdp, spec, key, state) {
  const view = spec.narrow ? NARROW : REF;
  const suffix = spec.narrow ? "narrow-light" : spec.theme;
  if (spec.narrow && NARROW_SHOTS.indexOf(key) < 0) return;
  const file = path.join(SCR, key + "-" + suffix + ".png");
  const dim = await H.shoot(cdp, file);
  record("shot", key + "-" + suffix + " 截图 = " + view.width * view.dsf + "x" + view.height * view.dsf, dim.width === view.width * view.dsf && dim.height === view.height * view.dsf, view.width * view.dsf + "x" + view.height * view.dsf, dim.width + "x" + dim.height);
  captures.push({ key: key + "-" + suffix, run: spec.id, theme: spec.theme, narrow: !!spec.narrow, state, file: path.relative(ROOT, file), width: dim.width, height: dim.height, bytes: dim.bytes });
}

async function main() {
  const chromium = require("@playwright/test").chromium;
  const electronPath = require("electron");
  const electronVersion = (function () { try { return require("electron/package.json").version; } catch { return null; } })();
  const startedAt = Date.now();
  fs.mkdirSync(SCR, { recursive: true });

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oa-market-all-apps-fixture-"));
  const stateFile = path.join(tmpRoot, "fixture-state.json");
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-shim-"));
  const shimPath = path.join(shimDir, "shim.cjs");
  fs.writeFileSync(shimPath, [
    "/* 空格安全的 NODE_OPTIONS --require 入口。 */",
    "const target = process.env.OA_ALL_APPS_FIXTURE_MODULE;",
    "if (target) require(target);",
    "module.exports = {};",
  ].join(String.fromCharCode(10)));

  const keyPath = path.join(ROOT, ".keys", "update-signing.key");
  if (!fs.existsSync(keyPath)) throw new Error("缺少签名私钥：" + keyPath + "（先跑 node scripts/oa-update-keygen.mjs）");
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
  const canvasZip = buildAppZip("canvas", "0.2.0", privateKey);
  const notesZip = buildAppZip("notes", "0.2.0", privateKey);
  const canvasZipPath = path.join(tmpRoot, "canvas-0.2.0.zip");
  const notesZipPath = path.join(tmpRoot, "notes-0.2.0.zip");
  fs.writeFileSync(canvasZipPath, canvasZip);
  fs.writeFileSync(notesZipPath, notesZip);
  fs.writeFileSync(stateFile, JSON.stringify({
    canvas: { version: "0.2.0", zip: canvasZipPath, notesUrl: NOTES_URL, publishedAt: PUBLISHED, delayZipMs: 0 },
    notes: { version: "0.2.0", zip: notesZipPath, notesUrl: NOTES_URL, publishedAt: PUBLISHED, delayZipMs: 0 },
  }, null, 2));

  console.log("=== 应用商店升级（全应用）· 真机探针 ===");
  console.log("参考视口：" + REF.width + "x" + REF.height + "@" + REF.dsf + "；窄窗 " + NARROW.width + "x" + NARROW.height + "@" + NARROW.dsf);
  console.log("离线 fixture 源：" + path.relative(ROOT, path.join(HERE, "fixture-source.cjs")));

  const deps = { chromium, electronPath, shimPath, stateFile, tmpRoot };
  const allSpecs = [
    { id: "light", theme: "light", narrow: false },
    { id: "dark", theme: "dark", narrow: false },
    { id: "narrow", theme: "light", narrow: true },
  ];
  const only = (process.env.OA_MARKET_ALL_APPS_RUNS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const specs = only.length ? allSpecs.filter((s) => only.indexOf(s.id) >= 0) : allSpecs;
  for (const spec of specs) {
    activeRun = null;
    await runOne(spec, deps);
  }

  record("hygiene", "H0 · 全程 console error = 0", consoleErrors.length === 0, 0, consoleErrors.length + " → " + JSON.stringify(consoleErrors.slice(0, 5)));
  record("hygiene", "H1 · 全程 pageerror = 0", pageErrors.length === 0, 0, pageErrors.length + " → " + JSON.stringify(pageErrors.slice(0, 5)));
  record("hygiene", "H2 · 渲染层无非本地请求", nonLocal.length === 0, 0, nonLocal.length + " → " + JSON.stringify(nonLocal.slice(0, 5)));

  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  const report = {
    phase: "dxos-market-all-apps",
    title: "应用商店升级机制泛化到所有应用 · 真机视觉探针",
    at: H.nowIso(),
    durationMs: Date.now() - startedAt,
    command: "node experiments/dxos-market-all-apps/run-all.mjs",
    environment: { platform: process.platform, arch: process.arch, node: process.version, electron: electronVersion, cwd: ROOT },
    condition: {
      referenceViewport: { id: REF.id, width: REF.width, height: REF.height, dsf: REF.dsf },
      narrowViewport: { id: NARROW.id, width: NARROW.width, height: NARROW.height, dsf: NARROW.dsf },
      themeSwitchPath: "真实 UI：顶栏「控制中心」→ 外观",
      updatePath: "真实 contextBridge 桥（未顶替）→ market:command → electron/market-update-service.cjs → 真实验签 / 摘要 / 解压 / 原子切换 / 审计",
      networkFixture: "主进程 globalThis.fetch 被 fixture-source.cjs 顶替（NODE_OPTIONS=--require <临时 shim>）",
      isolation: "每次运行独立 --user-data-dir 临时目录 + 唯一 --remote-debugging-port",
    },
    runs: runs.map((r) => ({ id: r.id, theme: r.theme, narrow: r.narrow, port: r.port, userDataDir: r.userDataDir, fixtureLog: r.fixtureLog, fatal: r.fatal })),
    screenshots: captures,
    selectors: SELECTORS,
    counts: { checks: checks.length, passed, failed, screenshots: captures.length },
    checks,
    notes,
    verdict: failed > 0 ? "HAS-FAILURES" : "ALL-CHECKS-PASS",
  };
  fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(ART, "checks.json"), JSON.stringify(checks, null, 2));

  const md = [];
  md.push("# 应用商店升级（全应用）真机探针 · 选择器清单");
  md.push("");
  md.push("生成时间：" + report.at + " · 参考视口 " + REF.id + "@" + REF.dsf + " · 窄窗 " + NARROW.id + "@" + NARROW.dsf);
  md.push("");
  md.push("| 选择器 | 含义 |");
  md.push("| --- | --- |");
  for (const row of SELECTORS) md.push("| `" + row.selector + "` | " + row.meaning + " |");
  md.push("");
  fs.writeFileSync(path.join(ART, "SELECTORS.md"), md.join(String.fromCharCode(10)));

  console.log("\n=== 结果：" + passed + " / " + checks.length + " 通过，截图 " + captures.length + " 张 → " + ART + " ===");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => { console.error("探针异常退出：" + String((error && error.stack) || error)); process.exit(1); });
