#!/usr/bin/env node
/**
 * dxos-gate-full · N2 / A / B 真机取证（浅/深对照截图 + DOM 事实）。
 *
 * 只读复用 experiments/dxos-design-retro/lib/harness.mjs 的启动与登录底座（不改该文件）。
 * 产物只写 artifacts/dxos-gate-full/。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as H from "../dxos-design-retro/lib/harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-gate-full");
const SHOT_DIR = path.join(ART, "shots");
fs.mkdirSync(SHOT_DIR, { recursive: true });

const checks = [];
function record(section, name, ok, expected, actual) {
  const row = { section, name, ok: !!ok, expected: String(expected == null ? "" : expected), actual: String(actual == null ? "" : actual).slice(0, 900) };
  checks.push(row);
  console.log((row.ok ? "PASS " : "FAIL ") + "[" + section + "] " + name + " :: actual=" + row.actual + "  expected=" + row.expected);
  return row.ok;
}
const sleep = H.sleep;

async function main() {
  const require = createRequire(path.join(ROOT, "package.json"));
  const chromium = require("@playwright/test").chromium;
  const electronPath = require("electron");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-gate-full-"));
  const { child, browser } = await H.launchElectron({ ROOT, electronPath, chromium, userDataDir });
  let page = null;
  const report = { n2: null, a: null, b: null, shots: [], checks };
  try {
    const ready = await H.waitFor(async () => {
      for (const p of browser.contexts().flatMap((c) => c.pages())) {
        if (p.url().includes("vue.html") && (await p.evaluate(() => !!document.querySelector(".desktop")).catch(() => false))) { page = p; return true; }
      }
      return false;
    }, 60000, 300);
    if (!ready || !page) throw new Error("没找到 dist/vue.html 桌面页");
    const cdp = await browser.contexts()[0].newCDPSession(page);
    const gateState = await H.ensureSession(page);
    record("boot", "B0 登录进入桌面", gateState === "ready", "ready", gateState);
    await H.setViewport(cdp, { width: 1440, height: 900, dsf: 2 });

    const shoot = async (name) => {
      const size = await H.shoot(cdp, path.join(SHOT_DIR, name + ".png"));
      report.shots.push({ file: "shots/" + name + ".png", width: size.width, height: size.height });
      console.log("SHOT " + name + " " + size.width + "x" + size.height);
      return size;
    };
    const frameOf = (re) => page.frames().find((f) => re.test(f.url())) || null;
    const listFrame = () => frameOf(/openarc-canvas:\/\/bundle\/static\/canvas-list\.html/);
    const canvasFrame = () => frameOf(/openarc-canvas:\/\/bundle\/static\/canvas\.html/);
    const inFrame = async (f, code) => {
      if (!f) return { __noFrame: true };
      try { return JSON.parse((await f.evaluate("(async () => { return JSON.stringify(await (async () => { " + code + " })()); })()")) || "null"); }
      catch (e) { return { __error: String(e && e.message ? e.message : e).slice(0, 240) }; }
    };
    const frameHas = async (re, sel, ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < (ms || 20000)) {
        const f = frameOf(re);
        if (f) {
          const hit = await inFrame(f, "return !!document.querySelector(" + JSON.stringify(sel) + ");");
          if (hit === true) return true;
        }
        await sleep(200);
      }
      return false;
    };
    const activePane = () => H.attr(page, "[data-settings-active]", "data-settings-active");
    const waitPane = (pane, ms) => H.waitFor(async () => (await activePane()) === pane, ms || 10000, 150);

    /* ── N2：真实引导入口（AI Studio 编辑器 ›「打开 OpenArc 总 API 设置」） ── */
    if (await H.has(page, H.SETTINGS_WIN)) await H.closeWindow(page, H.SETTINGS_WIN);
    const openedApp = await H.clickSel(page, '[aria-label="打开AI Studio"]');
    const hostUp = await H.waitForSel(page, "[data-canvas-host]", 25000);
    const listUp = hostUp && (await H.waitFor(() => !!listFrame(), 25000));
    const startReady = listUp && (await frameHas(/canvas-list\.html/, "#btnStartCreate", 25000));
    const startClick = startReady ? await inFrame(listFrame(), "const el = document.getElementById('btnStartCreate'); if (!el) return 'missing'; el.click(); return 'clicked';") : "no-list";
    const editorUp = await H.waitFor(() => !!canvasFrame(), 40000);
    const guideUp = editorUp && (await frameHas(/canvas\.html/, "[data-openarc-open-model-settings]", 30000));
    const clickGuide = guideUp ? await inFrame(canvasFrame(), "const b = document.querySelector('[data-openarc-open-model-settings]'); if (!b) return { clicked: false }; const text = String(b.textContent).trim(); b.click(); return { clicked: true, text: text };") : { clicked: false, why: "no-guide" };
    const n2Opened = await waitPane("model", 25000);
    const title = await H.text(page, "[data-settings-active] .pane-toolbar h1");
    const guideState = await inFrame(canvasFrame(), "const b = document.querySelector('[data-openarc-guide-state=opened]'); return b ? { opened: true, text: String(b.textContent).trim() } : null;");
    const shotN2 = await shoot("after-n2-guide-model-light");
    record("N2", "引导入口真实点击 → 设置窗口落在「模型与服务商」（Vue: .pane-toolbar h1）",
      clickGuide && clickGuide.clicked === true && n2Opened && (await activePane()) === "model" && title === "模型与服务商",
      "active=model + 标题=模型与服务商",
      JSON.stringify({ openedApp, hostUp, listUp, startClick, editorUp, guideUp, clickGuide, n2Opened, active: await activePane(), title, guideState }));

    /* 手动切走不被拽回：切到「外观」和「设备」各停 1.8s，仍是自己选的 pane */
    await H.clickSel(page, H.SETTINGS_WIN + ' [data-settings-pane="appearance"]');
    await waitPane("appearance", 8000);
    await sleep(1800);
    const stillAppearance = (await activePane()) === "appearance";
    await H.clickSel(page, H.SETTINGS_WIN + ' [data-settings-pane="devices"]');
    await waitPane("devices", 8000);
    await sleep(1800);
    const stillDevices = (await activePane()) === "devices";
    record("N2", "用户手动切走不会被拽回（外观 / 设备各停 1.8s 后仍是自己选的）",
      stillAppearance && stillDevices, "appearance 与 devices 都保持",
      JSON.stringify({ stillAppearance, stillDevices }));
    report.n2 = { active: "model", title, guideState, clickGuide, stillAppearance, stillDevices, shot: "shots/after-n2-guide-model-light.png" };

    /* 回到模型 pane 做 A / B 取证 */
    await H.clickSel(page, H.SETTINGS_WIN + ' [data-settings-pane="model"]');
    await H.waitForSel(page, '[data-d4-01="settings"]', 12000);

    const fillInsecure = async () => {
      await H.setInput(page, "[data-d4-01-provider-name]", "测试服务商");
      await H.setInput(page, "[data-d4-01-provider-url]", "http://8.8.8.8:8080");
      const up = await H.waitForSel(page, "[data-d4-01-provider-insecure-warning]", 10000);
      const color = await page.evaluate(() => { const el = document.querySelector(".mp2-insecure-warn"); return el ? getComputedStyle(el).color : null; });
      return { up, color };
    };
    const scrollTo = async (sel) => { await page.evaluate((s) => { const el = document.querySelector(s); if (el) el.scrollIntoView({ block: "start" }); }, sel); await sleep(700); };

    /* ── A：ProviderForm 警示色（--warning-text 回退 #a05a00 → rgb(160,90,0)） ── */
    const aLight = await fillInsecure();
    await scrollTo("[data-d4-01-provider-insecure-warning]");
    const shotALight = await shoot("after-A-providerform-warning-light");
    record("A", "明文 HTTP 警示文字颜色来自 --warning-text（回退 #a05a00 = rgb(160, 90, 0)），浅色",
      aLight.up === true && aLight.color === "rgb(160, 90, 0)", "rgb(160, 90, 0)", JSON.stringify(aLight));

    /* ── B：协议 / CLI 卡片（浅色） ── */
    await scrollTo("[data-model-settings-protocol]");
    const shotProtocolLight = await shoot("after-B-protocol-light");
    await scrollTo("[data-model-settings-cli]");
    const shotCliLight = await shoot("after-B-cli-light");
    const stylesLight = await page.evaluate(() => {
      const pick = (sel) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); return { borderTopWidth: cs.borderTopWidth, borderTopStyle: cs.borderTopStyle, borderTopColor: cs.borderTopColor, background: cs.backgroundColor, radius: cs.borderRadius }; };
      return { psetList: pick(".pset-list"), psetEditor: pick(".pset-editor"), cliCard: pick(".cli-card"), chip: pick(".pset-chip"), draft: pick(".pset-draft"), badge: pick(".cli-badge"), cap: pick(".cli-cap") };
    });
    record("B", "卡片级描边已去掉（.pset-list / .pset-editor / .cli-card 都是 0px/none），浅色",
      !!stylesLight.psetList && stylesLight.psetList.borderTopStyle === "none" && stylesLight.psetList.borderTopWidth === "0px"
      && stylesLight.psetEditor.borderTopStyle === "none" && stylesLight.psetEditor.borderTopWidth === "0px"
      && stylesLight.cliCard.borderTopStyle === "none" && stylesLight.cliCard.borderTopWidth === "0px",
      "三个卡片 0px none", JSON.stringify(stylesLight));
    record("B", "控件边界保留（.pset-chip / .pset-draft / .cli-badge / .cli-cap 仍 1px solid）",
      !!stylesLight.chip && stylesLight.chip.borderTopWidth === "1px" && stylesLight.chip.borderTopStyle === "solid"
      && !!stylesLight.draft && stylesLight.draft.borderTopWidth === "1px"
      && !!stylesLight.badge && stylesLight.badge.borderTopWidth === "1px"
      && !!stylesLight.cap && stylesLight.cap.borderTopWidth === "1px",
      "控件仍 1px", JSON.stringify({ chip: stylesLight.chip, draft: stylesLight.draft, badge: stylesLight.badge, cap: stylesLight.cap }));

    /* ── 深色 ── */
    await H.clickSel(page, H.SETTINGS_WIN + ' [data-settings-pane="appearance"]');
    await waitPane("appearance", 8000);
    await H.clickText(page, H.SETTINGS_WIN + ' [aria-label="外观"]', "深色");
    await H.waitFor(async () => (await page.evaluate(() => document.querySelector(".desktop")?.classList.contains("dark"))) === true, 6000, 120);
    await H.clickSel(page, H.SETTINGS_WIN + ' [data-settings-pane="model"]');
    await H.waitForSel(page, '[data-d4-01="settings"]', 12000);
    const aDark = await fillInsecure();
    await scrollTo("[data-d4-01-provider-insecure-warning]");
    const shotADark = await shoot("after-A-providerform-warning-dark");
    record("A", "明文 HTTP 警示文字颜色来自 --warning-text（回退 #a05a00 = rgb(160, 90, 0)），深色",
      aDark.up === true && aDark.color === "rgb(160, 90, 0)", "rgb(160, 90, 0)", JSON.stringify(aDark));
    await scrollTo("[data-model-settings-protocol]");
    const shotProtocolDark = await shoot("after-B-protocol-dark");
    await scrollTo("[data-model-settings-cli]");
    const shotCliDark = await shoot("after-B-cli-dark");
    const stylesDark = await page.evaluate(() => {
      const pick = (sel) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); return { borderTopWidth: cs.borderTopWidth, borderTopStyle: cs.borderTopStyle, background: cs.backgroundColor }; };
      return { psetList: pick(".pset-list"), psetEditor: pick(".pset-editor"), cliCard: pick(".cli-card") };
    });
    record("B", "卡片级描边已去掉（深色）",
      !!stylesDark.psetList && stylesDark.psetList.borderTopStyle === "none" && stylesDark.psetList.borderTopWidth === "0px"
      && stylesDark.psetEditor.borderTopStyle === "none" && stylesDark.psetEditor.borderTopWidth === "0px"
      && stylesDark.cliCard.borderTopStyle === "none" && stylesDark.cliCard.borderTopWidth === "0px",
      "三个卡片 0px none", JSON.stringify(stylesDark));

    report.a = { light: aLight, dark: aDark, shots: ["shots/after-A-providerform-warning-light.png", "shots/after-A-providerform-warning-dark.png"] };
    report.b = { light: stylesLight, dark: stylesDark, shots: report.shots.filter((s) => /after-B/.test(s.file)).map((s) => s.file) };
    report.shots = report.shots.map((s) => s.file);
    fs.writeFileSync(path.join(ART, "design-shots.json"), JSON.stringify(report, null, 2));
    console.log("报告 = " + path.relative(ROOT, path.join(ART, "design-shots.json")));
    return checks.every((c) => c.ok) ? 0 : 1;
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    try { await H.awaitExit(child, 8000); } catch { /* ignore */ }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().then((code) => process.exit(code)).catch((err) => { console.error("FAILED:", err && err.stack ? err.stack : err); process.exit(2); });
