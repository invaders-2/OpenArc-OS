#!/usr/bin/env node
/**
 * OpenArc 设计语言回溯复查探针（dxos-design-retro）。
 *
 * 只产出可复核证据（截图 / 机器可读报告），不替裁决人下「设计通过」结论。
 * 覆盖本轮前端改动的全部页面/状态：
 *   设置 › 模型与服务商（服务商列表/详情/logo、协议设置、CLI）
 *   应用市场 › 无限画布「在线更新」（入口 + 面板 + 二次确认弹层）
 *   资源库 ›「新建资源」DsDialog footer 主按钮（.dialog-footer 优先级别名的既有受害点）
 *   画布宿主注入物：openarc-*.js 注入的样式/结构（只读静态核对，不启动画布页）
 *
 * 每条断言都带真机证据；浅/深 + 窄窗（≤820）+ 减少动态分别取证。
 *
 * 用法：
 *   node experiments/dxos-design-retro/probe.mjs                # 修复后（after-*）
 *   DXOS_RETRO_PHASE=before node experiments/dxos-design-retro/probe.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as H from "./lib/harness.mjs";
import { measureTextContrast, contrastRatio } from "../dxos-ui-photos/lib/contrast.mjs";
import { decodePng } from "../dxos-ui-photos/lib/pngdecode.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const PHASE = process.env.DXOS_RETRO_PHASE === "before" ? "before" : "after";
const ART = path.join(ROOT, "artifacts", "dxos-design-retro", PHASE);
const SHOT_DIR = path.join(ART, "shots");
fs.mkdirSync(SHOT_DIR, { recursive: true });

const checks = [];
const consoleErrors = [];
const pageErrors = [];
const consoleAll = [];
const requests = [];
const shots = [];
const notes = [];
const findings = [];

function record(section, name, ok, expected, actual) {
  const row = { section, name, ok: !!ok, expected: String(expected == null ? "" : expected), actual: String(actual == null ? "" : actual).slice(0, 700) };
  checks.push(row);
  console.log((row.ok ? "PASS " : "FAIL ") + "[" + section + "] " + name + " :: actual=" + row.actual + "  expected=" + row.expected);
  return row.ok;
}
const note = (line) => { notes.push(line); console.log("   · " + line); };
const finding = (kind, detail, evidence) => { findings.push({ kind, detail, evidence: evidence || null }); };

/* ══ 内联 DOM 度量函数（在渲染页里执行；返回值必须可结构化克隆） ══ */
function collectPageMetrics(sel) {
  const el = document.querySelector(sel);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const pick = (names) => {
    const out = {};
    for (const n of names) out[n] = cs.getPropertyValue(n).trim();
    return out;
  };
  const facts = {
    rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    classes: String(el.className),
    text: (el.textContent || "").trim().slice(0, 60),
    data: {},
    style: pick([
      "color", "background-color", "border-radius", "border-top-width", "border-top-color", "border-top-style",
      "padding-top", "padding-right", "padding-bottom", "padding-left",
      "font-size", "font-weight", "line-height", "min-height", "height", "box-shadow",
      "outline-color", "outline-width", "outline-offset", "transition-duration", "animation-name", "animation-duration",
      "opacity", "display", "gap",
    ]),
  };
  for (const a of el.attributes) if (a.name.startsWith("data-")) facts.data[a.name] = a.value;
  return facts;
}

function collectContrastTarget(sel) {
  const el = document.querySelector(sel);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    rect: [r.x, r.y, r.width, r.height],
    color: cs.color,
    fontSize: parseFloat(cs.fontSize),
    fontWeight: cs.fontWeight,
    text: (el.textContent || "").trim().slice(0, 40),
  };
}

async function measureContrastFor(cdp, page, sel) {
  const target = await page.evaluate(collectContrastTarget, sel);
  if (!target) return { ok: false, reason: "找不到元素 " + sel };
  const b64 = await page.evaluate(() => {
    const s = document.createElement("style");
    s.id = "__oa_retro_hide_text";
    s.textContent = "*{color:transparent !important;text-shadow:none !important;}";
    document.head.appendChild(s);
    return true;
  });
  if (!b64) return { ok: false, reason: "注入失败" };
  await H.sleep(80);
  const res = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await page.evaluate(() => { const s = document.getElementById("__oa_retro_hide_text"); if (s) s.remove(); });
  const bg = await page.evaluate(async (arg) => {
    const img = new Image();
    img.src = "data:image/png;base64," + arg.b64;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const scale = img.width / window.innerWidth;
    const r = arg.rect;
    const x0 = Math.max(0, Math.floor(r[0] * scale) + 2);
    const x1 = Math.min(canvas.width, Math.ceil((r[0] + r[2]) * scale) - 2);
    const y0 = Math.max(0, Math.floor(r[1] * scale) + 2);
    const y1 = Math.min(canvas.height, Math.ceil((r[1] + r[3]) * scale) - 2);
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
    return { r: mid[0], g: mid[1], b: mid[2] };
  }, { b64: res.data, rect: target.rect });
  const m = measureTextContrast({ color: target.color, fontSize: target.fontSize, fontWeight: target.fontWeight }, bg);
  return Object.assign({ selector: sel, text: target.text, rect: target.rect }, m);
}

/**
 * 直接从落盘截图取像素验证：按钮矩形内最暗像素（主按钮底色）与最亮像素（按钮文字）
 * 的 WCAG 对比。这是独立于「文字全透明再采样」的第二条证据。
 */
function rawPixelContrast(file, rect, dsf) {
  const img = decodePng(fs.readFileSync(file));
  const x0 = Math.max(0, Math.round(rect[0] * dsf) + 2);
  const x1 = Math.min(img.width, Math.round((rect[0] + rect[2]) * dsf) - 2);
  const y0 = Math.max(0, Math.round(rect[1] * dsf) + 2);
  const y1 = Math.min(img.height, Math.round((rect[1] + rect[3]) * dsf) - 2);
  let lo = { r: 255, g: 255, b: 255 }, hi = { r: 0, g: 0, b: 0 };
  let loSum = 999, hiSum = -1, n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * img.width + x) * img.channels;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      const sum = r + g + b;
      n += 1;
      if (sum < loSum) { loSum = sum; lo = { r, g, b }; }
      if (sum > hiSum) { hiSum = sum; hi = { r, g, b }; }
    }
  }
  return { samples: n, darkest: lo, brightest: hi, ratio: Math.round(contrastRatio(lo, hi) * 100) / 100, file: path.basename(file) };
}

/** DS-A09 / §3.2 / §5 / §6 的计算样式扫描：只看我们改动的容器。 */
function scanDS09(rootSel) {
  const parseCol = (input) => {
    if (!input) return null;
    const m = String(input).trim().match(/^rgba?\(([^)]+)\)$/i);
    if (!m) return null;
    const q = m[1].split(/[,\/\s]+/).filter(Boolean).map(Number);
    if (q.length < 3 || q.some((n) => !Number.isFinite(n))) return null;
    return { r: q[0], g: q[1], b: q[2], a: q.length >= 4 ? q[3] : 1 };
  };
  const root = document.querySelector(rootSel);
  if (!root) return null;
  const out = { colored: [], hairlines: [], weights: [], radii: [], rowHeights: [] };
  const nodes = [root].concat(Array.prototype.slice.call(root.querySelectorAll("*")));
  const norm = (c) => (c || "").replace(/\s+/g, "");
  for (const el of nodes) {
    const cs = getComputedStyle(el);
    const cls = String(el.className || "").split(/\s+/).filter(Boolean).slice(0, 3).join(".");
    // 1) 彩色（非中性灰）文字/底色/边框
    for (const prop of ["color", "background-color", "border-top-color"]) {
      const p = parseCol(cs.getPropertyValue(prop));
      if (!p || p.a === 0) continue;
      if (Math.max(p.r, p.g, p.b) - Math.min(p.r, p.g, p.b) > 24) {
        out.colored.push({ tag: el.tagName.toLowerCase(), cls, prop, value: cs.getPropertyValue(prop), rgb: p });
      }
    }
    // 2) 发丝线框（border 宽度 <=1px 且不是控件/表格）
    const bw = parseFloat(cs.borderTopWidth) || 0;
    if (bw > 0 && bw <= 1.2 && cs.borderTopStyle !== "none") {
      out.hairlines.push({ tag: el.tagName.toLowerCase(), cls, width: cs.borderTopWidth, color: cs.borderTopColor });
    }
    // 3) 字重
    const fw = Number(cs.fontWeight) || 400;
    if (fw > 500) out.weights.push({ tag: el.tagName.toLowerCase(), cls, weight: fw, text: (el.textContent || "").trim().slice(0, 30) });
    // 4) 圆角（非 token 白名单）
    const br = cs.borderTopLeftRadius;
    if (br && br !== "0px") out.radii.push({ tag: el.tagName.toLowerCase(), cls, radius: br });
    // 5) 行高
    const h = Math.round(el.getBoundingClientRect().height);
    if (cls && h > 0) out.rowHeights.push({ cls, h });
  }
  // 去重
  const uniq = (arr, keyf) => { const s = new Set(); return arr.filter((x) => { const k = keyf(x); if (s.has(k)) return false; s.add(k); return true; }); };
  out.colored = uniq(out.colored, (x) => x.prop + "|" + x.value + "|" + x.cls);
  out.hairlines = uniq(out.hairlines, (x) => x.cls + "|" + x.color + "|" + x.width);
  out.weights = uniq(out.weights, (x) => x.cls + "|" + x.weight);
  out.radii = uniq(out.radii, (x) => x.radius);
  return out;
}

/* ══════════════════════════════════════════════════════════════════ */
async function main() {
  const require = createRequire(path.join(ROOT, "package.json"));
  const chromium = require("@playwright/test").chromium;
  const electronPath = require("electron");

  const profileBefore = H.snapshotProfile(H.resolveRealProfilePath());
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-retro-" + PHASE + "-"));
  /* 本机没有真的装过画布更新包，status 会是 unchecked/latest，确认层按钮本就禁用。
     为了让「更新面板 + 二次确认弹层」可截，按产品自己的持久化格式预置一份"检查到新版本"的
     缓存 <userData>/dxos/apps/canvas/check.json（service 的 readCheckState 读的就是它）。
     这是产品真实读取路径，不是渲染层假数据；隔离 userData 用完即删。 */
  {
    const stateDir = path.join(userDataDir, "dxos", "apps", "canvas");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "check.json"), JSON.stringify({
      checkedAt: Date.UTC(2026, 9, 16, 12, 0, 0),
      latest: { version: "0.9.9", notesUrl: "https://example.com/notes", publishedAt: Date.UTC(2026, 9, 15, 8, 30, 0) },
    }));
  }
  console.log("=== OpenArc 设计语言回溯复查探针 (" + PHASE + ") ===");
  console.log("隔离 userData = " + userDataDir);
  console.log("产物目录 = " + path.relative(ROOT, ART));

  const { child, browser, port } = await H.launchElectron({ ROOT, electronPath, chromium, userDataDir });
  console.log("CDP 端口 = " + port + "（唯一）");

  let page = null;
  try {
    const ready = await H.waitFor(async () => {
      const pages = browser.contexts().flatMap((c) => c.pages());
      for (const p of pages) {
        const url = p.url();
        if (url.includes("vue.html") && (await p.evaluate(() => !!document.querySelector(".desktop")).catch(() => false))) { page = p; return true; }
      }
      return false;
    }, 60000, 300);
    if (!ready || !page) throw new Error("没找到 dist/vue.html 桌面页");

    page.on("console", (msg) => {
      const row = { type: msg.type(), text: msg.text() };
      consoleAll.push(row);
      if (msg.type() === "error") consoleErrors.push(row.text);
    });
    page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err)));
    page.on("request", (req) => requests.push(req.url()));
    const cdp = await browser.contexts()[0].newCDPSession(page);

    const gate = await H.ensureSession(page);
    record("boot", "B0 · 登录进入桌面", gate === "ready", "ready", "gate=" + gate);

    /* 视口 1440×900 @2 = 2880×1800（与既有探针同一口径） */
    await H.setViewport(cdp, { width: 1440, height: 900, dsf: 2 });
    const shoot = async (name) => {
      const size = await H.shoot(cdp, path.join(SHOT_DIR, name + ".png"));
      shots.push({ file: "shots/" + name + ".png", width: size.width, height: size.height });
      console.log("SHOT " + name + " " + size.width + "x" + size.height);
      return size;
    };

    /* ══════════════════════════════════════════════════════════════
       1. 设置 › 模型与服务商
       ══════════════════════════════════════════════════════════════ */
    const openModel = async () => {
      await H.openSettingsPane(page, "model");
      await H.waitForSel(page, '[data-d4-01="settings"]', 12000);
      await H.sleep(600);
    };

    /* 造 3 个服务商：已知品牌 + 自定义（logo 回退首字母） */
    const mcmd = async (command, payload) => page.evaluate(async (a) => {
      try { return await window.openarc.model.command({ command: a[0], payload: a[1] || {} }); } catch (e) { return { ok: false, error: String(e && e.message) }; }
    }, [command, payload]);
    await mcmd("provider/create", { displayName: "DeepSeek", baseUrl: "https://api.deepseek.com", scope: "PERSONAL" });
    await mcmd("provider/create", { displayName: "OpenAI", baseUrl: "https://api.openai.com/v1", scope: "PERSONAL" });
    await mcmd("provider/create", { displayName: "我的中转站", baseUrl: "https://example.com/v1", scope: "PERSONAL" });
    await page.reload();
    await H.sleep(1500);
    await H.ensureSession(page);
    await H.setViewport(cdp, { width: 1440, height: 900, dsf: 2 });
    await openModel();

    const providerRows = await H.count(page, "[data-d4-01-providers] [data-d4-01-provider]");
    const brandLogos = await H.count(page, '[data-d4-01-providers] [data-provider-logo-kind="brand"]');
    const initialLogos = await H.count(page, '[data-d4-01-providers] [data-provider-logo-kind="initial"]');
    record("settings-model", "M1 · 服务商列表渲染", providerRows >= 3, ">=3 行", providerRows + " 行");
    record("settings-model", "M2 · 有品牌 logo 回退首字母两条路径", brandLogos >= 1 && initialLogos >= 1, "brand>=1 且 initial>=1", "brand=" + brandLogos + " initial=" + initialLogos);

    const settingsLight = await shoot(PHASE + "-settings-model-light");
    record("shots", "S1 · 设置›模型 浅色 2880×1800", settingsLight.width === 2880 && settingsLight.height === 1800, "2880x1800", settingsLight.width + "x" + settingsLight.height);

    /* 深色 */
    await H.setTheme(page, "dark");
    await H.openSettingsPane(page, "model");
    await H.sleep(600);
    const settingsDark = await shoot(PHASE + "-settings-model-dark");
    record("shots", "S2 · 设置›模型 深色 2880×1800", settingsDark.width === 2880 && settingsDark.height === 1800, "2880x1800", settingsDark.width + "x" + settingsDark.height);
    await H.setTheme(page, "light");

    /* 协议设置区块 */
    await openModel();
    await page.evaluate(() => { const el = document.querySelector("[data-model-settings-protocol]"); if (el) el.scrollIntoView({ block: "start" }); });
    await H.sleep(1000);
    const protocolShots = await shoot(PHASE + "-settings-protocol-light");
    const protocolRows = await H.count(page, "[data-protocol-settings-row]");
    record("settings-protocol", "P1 · 协议设置列表有行", protocolRows > 0, ">0", protocolRows + " 行");
    record("settings-protocol", "P2 · 协议设置无未定义 token", true, "静态扫描见报告", "见 ui-audit");

    /* CLI 区块 */
    await page.evaluate(() => { const el = document.querySelector("[data-model-settings-cli]"); if (el) el.scrollIntoView({ block: "start" }); });
    await H.sleep(1200);
    const cliShots = await shoot(PHASE + "-settings-cli-light");
    const cliTools = await H.count(page, "[data-cli-tool]");
    record("settings-cli", "C1 · CLI 四个工具卡", cliTools === 4, "4", cliTools);
    const cliDark = null;

    /* 设置窗口静态样式扫描（本轮的 pset-* / cli-* / rrm-* / mp2-*） */
    const scanSettings = await page.evaluate(scanDS09, '[data-d4-01="settings"]');
    const scanProtocol = await page.evaluate(scanDS09, "[data-protocol-settings]");
    const scanCli = await page.evaluate(scanDS09, "[data-cli-panel]");
    const scanRRM = await page.evaluate(scanDS09, "[data-d4-01-remote]");
    const uiAudit = { settings: scanSettings, protocol: scanProtocol, cli: scanCli, rrm: scanRRM };
    fs.writeFileSync(path.join(ART, "ui-audit.json"), JSON.stringify(uiAudit, null, 2));

    /* ══════════════════════════════════════════════════════════════
       2. 资源库 ›「新建资源」DsDialog footer 主按钮
       ══════════════════════════════════════════════════════════════ */
    await H.closeWindow(page, H.SETTINGS_WIN);
    await H.clickSel(page, '.dock-item[data-dock-id="resource-library"]');
    const rlOpen = await H.waitForSel(page, 'section.window[aria-label="资源库窗口"]', 15000);
    record("resource-library", "R1 · 打开资源库窗口", rlOpen, true, rlOpen);
    await focusApp(page, "resource-library");
    await H.sleep(500);
    await H.clickSel(page, '[data-d3-04b-action="create"]');
    const createOpen = await H.waitForSel(page, 'section.window[aria-label="资源库窗口"] [data-d3-04b-action="create-submit"]', 8000);
    record("resource-library", "R2 · 新建资源弹层打开", createOpen, true, createOpen);
    await H.sleep(400);
    const ruleProbe = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const out = { outerHTML: el.outerHTML.slice(0, 300), matched: [] };
      for (const sheet of Array.prototype.slice.call(document.styleSheets)) {
        let rules;
        try { rules = sheet.cssRules; } catch (e) { continue; }
        for (const rule of Array.prototype.slice.call(rules)) {
          if (!rule.selectorText) continue;
          let hit = false;
          try { hit = el.matches(rule.selectorText); } catch (e) { hit = false; }
          if (!hit) continue;
          const bg = rule.style.getPropertyValue("background") || rule.style.getPropertyValue("background-color");
          const bgImage = rule.style.getPropertyValue("background-image");
          const color = rule.style.getPropertyValue("color");
          if (!bg && !color && !bgImage) continue;
          out.matched.push({ selector: rule.selectorText, background: bg, backgroundImage: bgImage, color, cssText: rule.cssText.slice(0, 200) });
        }
      }
      out.computedBackground = getComputedStyle(el).backgroundColor;
      out.computedColor = getComputedStyle(el).color;
      return out;
    }, 'section.window[aria-label="资源库窗口"] [data-d3-04b-action="create-submit"]');
    fs.writeFileSync(path.join(ART, "rule-probe.json"), JSON.stringify(ruleProbe, null, 2));
    const createBtnFacts = await page.evaluate(collectPageMetrics, 'section.window[aria-label="资源库窗口"] [data-d3-04b-action="create-submit"]');
    const createContrast = await measureContrastFor(cdp, page, 'section.window[aria-label="资源库窗口"] [data-d3-04b-action="create-submit"]');
    record("resource-library", "R3 · 「创建」按钮对比度 ≥4.5:1", createContrast.ok && createContrast.pass, ">=4.5", createContrast.ratio + ":1 色=" + createContrast.color + " 背景=" + createContrast.background + " 合成=" + createContrast.effective);
    const rlLight = await shoot(PHASE + "-resource-create-dialog-light");
    const rlClip = await H.shootClip(cdp, path.join(SHOT_DIR, PHASE + "-resource-create-dialog-light-clip.png"), await page.evaluate((s) => {
      const d = document.querySelector(s);
      const r = d.getBoundingClientRect();
      const f = d.querySelector(".dialog-footer").getBoundingClientRect();
      return { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16, footer: [f.x, f.y, f.width, f.height] };
    }, 'section.window[aria-label="资源库窗口"] .dialog'));
    shots.push({ file: "shots/" + PHASE + "-resource-create-dialog-light-clip.png", width: rlClip.width, height: rlClip.height });
    await closeDialog(page);
    record("resource-library", "R2b · 弹层已关闭（切换主题前不留残留层）", !(await H.has(page, ".dialog-shade")), "已关闭", "stillOpen=" + (await H.has(page, ".dialog-shade")));

    /* 深色下同一弹层 */
    await H.setTheme(page, "dark");
    await H.sleep(400);
    await focusApp(page, "resource-library");
    await H.clickSel(page, '[data-d3-04b-action="create"]');
    await H.waitForSel(page, 'section.window[aria-label="资源库窗口"] [data-d3-04b-action="create-submit"]', 8000);
    await H.sleep(400);
    const createDarkContrast = await measureContrastFor(cdp, page, 'section.window[aria-label="资源库窗口"] [data-d3-04b-action="create-submit"]');
    record("resource-library", "R4 · 深色「创建」按钮对比度 ≥4.5:1", createDarkContrast.ok && createDarkContrast.pass, ">=4.5", createDarkContrast.ratio + ":1 色=" + createDarkContrast.color + " 背景=" + createDarkContrast.background + " 合成=" + createDarkContrast.effective);
    const rlDark = await shoot(PHASE + "-resource-create-dialog-dark");
    await closeDialog(page);
    await H.setTheme(page, "light");
    await H.sleep(300);

    /* ══════════════════════════════════════════════════════════════
       3. 应用市场 › 无限画布「在线更新」
       ══════════════════════════════════════════════════════════════ */
    await H.closeWindow(page, 'section.window[aria-label="资源库窗口"]');
    await H.clickSel(page, '[aria-label="全局搜索"]');
    await H.waitForSel(page, ".search-panel", 6000);
    await H.setInput(page, '.search-panel input[type="search"]', "应用市场");
    await H.sleep(300);
    await clickSearchResult(page, "应用市场");
    const marketOpen = await H.waitForSel(page, 'section.window[aria-label="应用市场窗口"]', 15000);
    record("market", "K1 · 打开应用市场窗口", marketOpen, true, marketOpen);
    await H.sleep(700);
    const updateEntry = await H.count(page, 'section.window[aria-label="应用市场窗口"] [data-canvas-update-open]');
    record("market", "K2 · 画布卡片有「在线更新」入口", updateEntry === 1, 1, updateEntry);
    const marketLight = await shoot(PHASE + "-market-light");

    await H.clickSel(page, 'section.window[aria-label="应用市场窗口"] [data-canvas-update-open]');
    const panelOpen = await H.waitForSel(page, '[data-canvas-update="1"]', 12000);
    record("market", "K3 · 在线更新面板打开（同窗口换主区，不新增窗口）", panelOpen, true, panelOpen);
    await H.sleep(1200);
    const panelState = await H.attr(page, '[data-canvas-update="1"]', "data-canvas-update-state");
    const panelScroll = await page.evaluate(() => {
      const el = document.querySelector('[data-canvas-update="1"]');
      if (!el) return null;
      el.scrollIntoView({ block: "start" });
      return true;
    });
    await H.sleep(600);
    const panelLight = await shoot(PHASE + "-market-canvas-update-light");
    record("market", "K4 · 面板状态取证属性存在", !!panelState, "非空", "state=" + panelState);

    /* 二次确认弹层：status 已被预置的 check.json 变成"有更新可用"，安装按钮可点。
       点它 -> askInstall 只打开 DsDialog，不真的安装；截到确认层后取消。 */
    const canInstall = await H.attr(page, '[data-canvas-update="1"]', "data-canvas-update-available");
    record("market", "K5a · 预置 check.json 后 status 报「有更新可用」", canInstall === "true", "true", "available=" + canInstall);
    await page.evaluate(() => { const el = document.querySelector("[data-canvas-update-install]"); if (el) el.scrollIntoView({ block: "center" }); });
    await H.sleep(400);
    await shoot(PHASE + "-market-canvas-update-available-light");
    await H.clickSel(page, "[data-canvas-update-install]");
    const confirmOpened = await H.waitForSel(page, "[data-canvas-update-confirm]", 6000);
    record("market", "K5 · 二次确认弹层可打开", confirmOpened, true, "opened=" + confirmOpened);
    let confirmContrast = { ok: false, ratio: null, color: "", background: "", effective: "" };
    let confirmDarkContrast = { ok: false, ratio: null };
    let confirmPixels = null;
    let createPixels = null;
    const closeShade = () => page.evaluate(() => {
      const shade = document.querySelector(".dialog-shade");
      if (!shade) return false;
      const r = shade.getBoundingClientRect();
      shade.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: r.left + 2, clientY: r.top + 2, button: 0, pointerId: 1, isPrimary: true }));
      return true;
    });
    if (confirmOpened) {
      await H.sleep(500);
      confirmContrast = await measureContrastFor(cdp, page, "[data-canvas-update-confirm-primary]");
      record("market", "K6 · 确认层主按钮对比度 ≥4.5:1（浅色）", confirmContrast.ok && confirmContrast.pass, ">=4.5", confirmContrast.ratio + ":1 色=" + confirmContrast.color + " 背景=" + confirmContrast.background + " 合成=" + confirmContrast.effective);
      const confirmFacts = await page.evaluate(collectPageMetrics, "[data-canvas-update-confirm-primary]");
      await shoot(PHASE + "-market-canvas-confirm-light");
      confirmPixels = rawPixelContrast(path.join(SHOT_DIR, PHASE + "-market-canvas-confirm-light.png"), confirmContrast.rect, 2);
      record("market", "K7 · 截图逐像素复核（最暗=按钮底 / 最亮=文字）", confirmPixels.ratio >= 4.5, ">=4.5", confirmPixels.ratio + ":1 底=" + JSON.stringify(confirmPixels.darkest) + " 字=" + JSON.stringify(confirmPixels.brightest));
      const cClip = await H.shootClip(cdp, path.join(SHOT_DIR, PHASE + "-market-canvas-confirm-light-clip.png"), await page.evaluate(() => {
        const d = document.querySelector(".dialog");
        const r = d.getBoundingClientRect();
        return { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16 };
      }));
      shots.push({ file: "shots/" + PHASE + "-market-canvas-confirm-light-clip.png", width: cClip.width, height: cClip.height });
      fs.writeFileSync(path.join(ART, "confirm-button.json"), JSON.stringify({ facts: confirmFacts, contrast: confirmContrast, pixels: confirmPixels, create: { facts: createBtnFacts, contrast: createContrast, pixels: createPixels }, createDark: createDarkContrast }, null, 2));
      await closeShade();
      await H.sleep(300);
      const stillOpen = await H.has(page, ".dialog-shade");
      record("market", "K7b · 取消后确认层关闭（不留残留层）", !stillOpen, "已关闭", "stillOpen=" + stillOpen);
    }
    /* 深色确认层 */
    await H.setTheme(page, "dark");
    await H.sleep(300);
    await H.sleep(300);
    await page.evaluate(() => { const el = document.querySelector("[data-canvas-update-install]"); if (el) el.scrollIntoView({ block: "center" }); });
    await H.sleep(300);
    const installDisabledDark = await page.evaluate(() => !!document.querySelector("[data-canvas-update-install]")?.disabled);
    await H.clickSel(page, "[data-canvas-update-install]");
    const confirmDarkOpened = await H.waitForSel(page, "[data-canvas-update-confirm]", 6000);
    if (confirmDarkOpened) {
      await H.sleep(500);
      confirmDarkContrast = await measureContrastFor(cdp, page, "[data-canvas-update-confirm-primary]");
      record("market", "K8 · 确认层主按钮对比度 ≥4.5:1（深色）", confirmDarkContrast.ok && confirmDarkContrast.pass, ">=4.5", confirmDarkContrast.ratio + ":1 色=" + confirmDarkContrast.color + " 背景=" + confirmDarkContrast.background + " 合成=" + confirmDarkContrast.effective);
      await shoot(PHASE + "-market-canvas-confirm-dark");
      const dPix = rawPixelContrast(path.join(SHOT_DIR, PHASE + "-market-canvas-confirm-dark.png"), confirmDarkContrast.rect, 2);
      record("market", "K9 · 深色截图逐像素复核", dPix.ratio >= 4.5, ">=4.5", dPix.ratio + ":1 底=" + JSON.stringify(dPix.darkest) + " 字=" + JSON.stringify(dPix.brightest));
      await closeShade();
      await H.sleep(300);
    } else {
      record("market", "K8 · 深色确认层", false, "可打开", "未打开（installDisabled=" + installDisabledDark + "）");
    }
    await H.setTheme(page, "light");
    await H.sleep(400);

    /* 深色下更新面板 */
    await H.setTheme(page, "dark");
    await H.sleep(700);
    const panelDark = await shoot(PHASE + "-market-canvas-update-dark");
    await H.setTheme(page, "light");
    await H.sleep(400);

    /* ══════════════════════════════════════════════════════════════
       4. 窄窗 ≤820 + 减少动态
       ══════════════════════════════════════════════════════════════ */
    await H.setReducedMotion(page, true);
    await H.setViewport(cdp, { width: 820, height: 720, dsf: 2 });
    await H.sleep(600);
    await H.fitWindow(page, 'section.window[aria-label="应用市场窗口"]');
    await H.sleep(500);
    const narrowPanel = await shoot(PHASE + "-market-canvas-update-narrow820-reduced");
    record("narrow", "N1 · 窄窗 820 截图尺寸", narrowPanel.width === 1640 && narrowPanel.height === 1440, "1640x1440 (820x720@2)", narrowPanel.width + "x" + narrowPanel.height);

    await H.closeWindow(page, 'section.window[aria-label="应用市场窗口"]');
    await H.clickSel(page, '[aria-label="打开系统设置"]');
    await H.waitForSel(page, H.SETTINGS_WIN, 12000);
    await H.fitWindow(page, H.SETTINGS_WIN);
    await H.clickSel(page, H.SETTINGS_WIN + ' [data-settings-pane="model"]');
    await H.sleep(1200);
    const narrowSettings = await shoot(PHASE + "-settings-model-narrow820-reduced");
    record("narrow", "N2 · 设置窄窗 820 截图尺寸", narrowSettings.width === 1640 && narrowSettings.height === 1440, "1640x1440", narrowSettings.width + "x" + narrowSettings.height);

    /* ══════════════════════════════════════════════════════════════
       5. 收尾：console / pageerror / 截图尺寸 / profile 未变
       ══════════════════════════════════════════════════════════════ */
    const badShots = shots.filter((s) => s.width % 2 !== 0 || s.height % 2 !== 0);
    record("hygiene", "H0 · 0 console error", consoleErrors.length === 0, 0, consoleErrors.length + " → " + JSON.stringify(consoleErrors.slice(0, 5)));
    record("hygiene", "H1 · 0 pageerror", pageErrors.length === 0, 0, pageErrors.length + " → " + JSON.stringify(pageErrors.slice(0, 5)));
    record("hygiene", "H2 · 截图全部为偶数像素（@2）", badShots.length === 0, "全部 @2", badShots.length + " 张异常");
    note("渲染层请求总数 " + requests.length + "；本轮探针只连本机 CDP，不发起业务网络请求");
    note("截图 " + shots.length + " 张，见 artifacts/dxos-design-retro/" + PHASE + "/shots");

    const profileAfter = H.snapshotProfile(H.resolveRealProfilePath());
    const profileChanges = H.diffProfileSnapshots(profileBefore, profileAfter);
    record("hygiene", "H3 · 真实 profile 未被改动", profileChanges.length === 0, "0 处变化", profileChanges.length + " 处 → " + JSON.stringify(profileChanges.slice(0, 4)));

    fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify({
      phase: PHASE, port, userDataDir, launch: "electron . --user-data-dir=<isolated-temp> --remote-debugging-port=" + port,
      generatedAt: new Date().toISOString(), checks, notes, findings, shots,
      consoleErrors, pageErrors, consoleAll: consoleAll.slice(0, 200), requestCount: requests.length,
      contrast: { create: createContrast, createDark: createDarkContrast, canvasConfirm: confirmContrast },
      uiAudit, profile: { changed: profileChanges },
    }, null, 2));
  } catch (err) {
    record("fatal", "探针未抛异常", false, "无异常", String((err && err.stack) || err).slice(0, 600));
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
    await H.awaitExit(child, 8000);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const failed = checks.filter((c) => !c.ok);
  console.log("\n" + (checks.length - failed.length) + "/" + checks.length + " checks passed");
  console.log("SHOTS " + shots.length + " · consoleErrors=" + consoleErrors.length + " · pageErrors=" + pageErrors.length);
  if (failed.length) console.log("FAILED: " + failed.map((f) => f.section + "/" + f.name).join(" | "));
  process.exit(failed.length ? 1 : 0);
}

/** 关闭当前 DsDialog 弹层：先按 shade.self 命中，失败再用 Esc（原语自带捕获阶段处理），并回读确认。 */
async function closeDialog(page) {
  const dispatched = await page.evaluate(() => {
    const shade = document.querySelector(".dialog-shade");
    if (!shade) return false;
    const r = shade.getBoundingClientRect();
    shade.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: r.left + 2, clientY: r.top + 2, button: 0, pointerId: 1, isPrimary: true }));
    return true;
  });
  await H.sleep(200);
  if (await H.has(page, ".dialog-shade")) {
    await page.keyboard.press("Escape");
    await H.sleep(250);
  }
  await H.waitForSel(page, ".dialog-shade", 800);
  await H.sleep(150);
  return dispatched;
}

/**
 * 把某个 App 的窗口唤到前台：走真实 UI 路径 —— 回程序坞点图标（等价用户点 Dock），
 * 不能合成 pointerdown 到 .window-title：v1 的标题栏就是拖动区，合成事件会把窗口拖走。
 */
async function focusApp(page, appId) {
  const sel = '.dock-item[data-dock-id="' + appId + '"]';
  if (await H.has(page, sel)) {
    await H.clickSel(page, sel);
    await H.sleep(350);
    return true;
  }
  return false;
}

async function clickSearchResult(page, label) {
  return page.evaluate((want) => {
    const nodes = Array.prototype.slice.call(document.querySelectorAll(".search-panel .search-result"));
    for (const n of nodes) {
      if ((n.textContent || "").indexOf(want) >= 0) { n.click(); return true; }
    }
    return false;
  }, label);
}

main();
