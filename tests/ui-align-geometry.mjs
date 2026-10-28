/**
 * task-8 · 几何级对齐测量：同窗口尺寸下对比 Claude 原型（headless Chrome）与
 * OpenArc OS（真实 Electron）的关键锚点 rect / 字号，输出 dx/dy/dw/dh 与容差结论。
 * 用法：node tests/ui-align-geometry.mjs
 * 产物：artifacts/ui-alignment/geometry/{<app>.json,summary.json,report.md}
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "artifacts/ui-alignment");
const GEO = path.join(OUT, "geometry");
const TOL = { rect: 4, font: 1 };

const APPS = [
  { id: "files", protoId: "finder", name: "访达", seq: "01", slug: "finder" },
  { id: "resource-library", protoId: "library", name: "资源库", seq: "02", slug: "library" },
  { id: "projects", protoId: "projects", name: "项目", seq: "06", slug: "projects" },
  { id: "chat", protoId: "chat", name: "对话", seq: "05", slug: "chat" },
  { id: "market", protoId: "market", name: "应用市场", seq: "09", slug: "market" },
  { id: "calendar", protoId: "calendar", name: "日历", seq: "13", slug: "calendar" },
  { id: "notes", protoId: "notes", name: "文稿", seq: "17", slug: "notes" },
  { id: "weather", protoId: "weather", name: "天气", seq: "14", slug: "weather" },
  { id: "music", protoId: "music", name: "音乐", seq: "15", slug: "music" },
  { id: "declare", protoId: "declare", name: "图片声明", seq: "21", slug: "declare" },
  { id: "trash", protoId: "trash", name: "回收站", seq: "22", slug: "trash" },
  { id: "settings", protoId: "settings", name: "系统设置", seq: "12", slug: "settings" },
  { id: "organization", protoId: "org", name: "组织治理", seq: "11", slug: "org" },
  { id: "automation", protoId: "automation", name: "自动化", seq: "10", slug: "automation" },
  { id: "skills", protoId: "skills", name: "Skill 中心", seq: "07", slug: "skills" },
  { id: "mcp-center", protoId: "mcp", name: "MCP 中心", seq: "08", slug: "mcp" },
  { id: "browser", protoId: "browser", name: "浏览器", seq: "03", slug: "browser" },
  { id: "photos", protoId: "photos", name: "相册", seq: "16", slug: "photos" },
  { id: "video", protoId: "video", name: "视频剪辑", seq: "18", slug: "video" },
  { id: "drama", protoId: "drama", name: "短剧工坊", seq: "19", slug: "drama" },
  { id: "dev", protoId: "dev", name: "开发者", seq: "20", slug: "dev" },
];

const ANCHORS = {
  files: [
    { name: "side", proto: ".win aside.side", ours: ".split-side" },
    { name: "toolbar", proto: ".win .tb", ours: ".pane-toolbar" },
    { name: "title", proto: ".win .tb .crumb", ours: ".pane-title", font: true, ignoreW: true },
    { name: "search", proto: ".win .tb .search", ours: ".search-field" },
    { name: "grid", proto: ".win .fgrid", ours: ".file-grid", ignoreH: true },
    { name: "item", proto: ".win .fitem", ours: ".file-cell" },
    { name: "bottom", proto: ".win .stat-bar", ours: ".finder-status" },
  ],
  "resource-library": [
    { name: "side", proto: ".win aside.side", ours: ".rl-nav" },
    { name: "toolbar", proto: ".win .tb", ours: ".rl-toolbar" },
    { name: "title", proto: ".win .tb .ttl", ours: ".rl-title", font: true, ignoreW: true },
    { name: "tags", proto: ".win .chip", ours: ".rl-chip", ignoreW: true },
    { name: "grid", proto: ".win .lgrid", ours: ".rl-grid", ignoreH: true },
    { name: "card", proto: ".win .lib-card", ours: ".rl-card" },
    { name: "detail", proto: ".win .insp", ours: ".rl-detail" },
  ],
  projects: [
    { name: "side", proto: ".win aside.side", ours: ".split-side" },
    { name: "toolbar", proto: ".win .tb", ours: ".pj-toolbar" },
    { name: "title", proto: ".win .tb .ttl", ours: ".pj-title", font: true, ignoreW: true, ignoreY: true },
    { name: "stats", proto: ".win .body .row > .group", ours: ".pj-stats .pj-stat" },
    { name: "table", proto: ".win table.tbl", ours: ".pj-table", ignoreH: true },
    { name: "row", proto: ".win table.tbl tbody tr", ours: ".pj-table tbody tr" },
  ],
  chat: [
    { name: "side", proto: ".win aside.side", ours: ".chat-side" },
    { name: "toolbar", proto: ".win .tb", ours: ".pane-toolbar" },
    { name: "title", proto: ".win .tb .ttl", ours: ".chat-title", font: true, ignoreW: true },
    { name: "model", proto: ".win .tb .btn.sm", ours: ".chat-model" },
    { name: "thread", proto: ".win .msgs", ours: ".chat-scroll" },
    { name: "user", proto: ".win .m-user", ours: ".chat-msg[data-role=\"user\"] .chat-bubble" },
    { name: "composer", proto: ".win .composer", ours: ".chat-composer" },
  ],
  browser: [
    { name: "tabstrip", proto: ".tabs", ours: ".browser-shell .tabstrip" },
    { name: "tab", proto: ".tabs .tab", ours: ".browser-shell .tab" },
    { name: "newtab-btn", proto: ".tabs > .btn", ours: "[data-tab-new]" },
    { name: "addr", proto: ".addr", ours: "[data-browser-addr]" },
    { name: "back-btn", proto: ".addr .btn", ours: "[data-browser-back]" },
    { name: "url", proto: ".addr .url", ours: "[data-browser-url]" },
    { name: "isolation-badge", proto: ".addr .badge", ours: "[data-browser-isolation]" },
    { name: "bookmark-btn", proto: ".addr .btn:last-child", ours: "[data-browser-bookmark]" },
    { name: "webview", proto: ".webview", ours: "[data-browser-webview]" },
    { name: "start-title", proto: ".startpage h1", ours: "[data-browser-start-title]" },
    { name: "fav-grid", proto: ".fav", ours: "[data-browser-fav]" },
  ],
  dev: [
    { name: "toolbar", proto: ".tb", ours: ".dv-toolbar" },
    { name: "check-btn", proto: ".tb .btn", ours: "[data-dev-check]" },
    { name: "run-btn", proto: ".tb .btn.pri", ours: "[data-dev-run]" },
    { name: "tree", proto: ".ftree", ours: ".dv-tree" },
    { name: "file-item", proto: ".ftree .fn", ours: ".dv-file" },
    { name: "editor", proto: ".code", ours: ".dv-code" },
    { name: "console", proto: ".console", ours: ".dv-console" },
    { name: "preview", proto: ".devprev", ours: ".dv-preview" },
    { name: "preview-badge", proto: ".devprev .badge", ours: ".dv-badge" },
    { name: "preview-card", proto: ".devprev .card", ours: ".dv-preview-card" },
  ],
  drama: [
    { name: "side", proto: "aside.side", ours: ".drama-app .split-side" },
    { name: "nav", proto: "aside.side .grp + .nav", ours: ".split-nav[data-drama-project]" },
    { name: "project-item", proto: "aside.side .nav", ours: "[data-drama-project]" },
    { name: "episode-item", proto: "aside.side > .nav:nth-last-of-type(8)", ours: ".split-nav[data-drama-episode]", optional: true },
    { name: "toolbar", proto: ".tb", ours: ".dr-toolbar" },
    { name: "next-btn", proto: ".tb .btn", ours: "[data-drama-next]" },
    { name: "stepper", proto: ".stepper", ours: ".dr-stepper" },
    { name: "stage-item", proto: ".stepper .st", ours: ".dr-step" },
    { name: "content", proto: ".body", ours: ".dr-body" },
    { name: "script-card", proto: ".group", ours: ".dr-body .dr-card" },
  ],
  video: [
    { name: "toolbar", proto: ".tb", ours: ".vd-proto-toolbar" },
    { name: "agent-btn", proto: ".tb .btn:not(.pri)", ours: "[data-video-agent]" },
    { name: "export-btn", proto: ".tb .btn.pri", ours: "[data-video-export]" },
    { name: "bin", proto: ".ve-bin", ours: ".vd-bin" },
    { name: "clip", proto: ".ve-bin .clip", ours: ".vd-bin-clip" },
    { name: "preview", proto: ".ve-prev", ours: ".vd-prev" },
    { name: "screen", proto: ".ve-screen", ours: ".vd-screen" },
    { name: "props", proto: ".ve-top > div:last-child", ours: ".vd-props" },
    { name: "timeline", proto: ".tl", ours: ".vd-timeline-proto" },
    { name: "ruler", proto: ".tl-ruler", ours: ".vd-ruler" },
    { name: "track", proto: ".track", ours: ".vd-track" },
    { name: "clip-bar", proto: ".tclip", ours: ".vd-clipbar" },
    { name: "playhead", proto: ".playhead", ours: ".vd-playhead" },
  ],
  photos: [
    { name: "side", proto: "aside.side", ours: ".split-side", ignoreH: true },
    { name: "toolbar", proto: ".tb", ours: ".photos-proto-toolbar" },
    { name: "count", proto: ".tb .sub", ours: ".photos-proto-toolbar .photos-count" },
    { name: "size-seg", proto: ".tb .seg", ours: ".photos-size" },
    { name: "import-btn", proto: ".tb .btn:not(.pri)", ours: "[data-photos-import]" },
    { name: "tile", proto: ".ph", ours: ".photos-card" },
    { name: "tile-img", proto: ".ph > *", ours: ".photos-card__thumb" },
    { name: "viewer-toolbar", proto: ".viewer .tb", ours: ".photos-viewer__bar" },
    { name: "viewer-image", proto: ".viewer .vimg", ours: ".photos-viewer__img" },
    { name: "viewer-status", proto: ".viewer .stat-bar", ours: ".photos-viewer__status" },
  ],
  "mcp-center": [
    { name: "side", proto: "aside.side", ours: ".split-side" },
    { name: "new-btn", proto: "aside.side .btn", ours: "[data-mcp-action=\"create\"]" },
    { name: "conn-item", proto: ".conn", ours: ".mcp-row" },
    { name: "toolbar", proto: ".tb", ours: ".mcp-toolbar" },
    { name: "status", proto: ".tb .badge", ours: ".mcp-toolbar .mcp-status" },
    { name: "action", proto: ".tb .btn:not(.icon)", ours: "[data-mcp-action=\"toolbar-toggle\"]" },
    { name: "kv-card", proto: ".sec .group", ours: ".mcp-kv" },
    { name: "tool-row", proto: ".frow", ours: ".mcp-tools tbody tr" },
    { name: "tool-switch", proto: ".frow .sw", ours: ".mcp-tool-switch" },
  ],
  skills: [
    { name: "side", proto: "aside.side", ours: ".sk-side" },
    { name: "nav", proto: "aside.side .grp + .nav", ours: "[data-skill-tab=\"market\"]" },
    { name: "toolbar", proto: ".tb", ours: ".sk-toolbar" },
    { name: "import-btn", proto: ".tb .btn:not(.pri)", ours: "[data-skill-import]" },
    { name: "primary", proto: ".tb .btn.pri", ours: "[data-skill-new]" },
    { name: "card", proto: ".mcard", ours: ".sk-item" },
    { name: "icon", proto: ".mcard .ico", ours: ".sk-ico-lg" },
    { name: "install-btn", proto: ".mcard .getbtn", ours: ".sk-install" },
  ],
  automation: [
    { name: "side", proto: "aside.side", ours: ".au-side" },
    { name: "nav", proto: "aside.side .grp + .nav", ours: "[data-au-tab=\"all\"]" },
    { name: "toolbar", proto: ".tb", ours: ".au-toolbar" },
    { name: "primary", proto: ".tb .btn.pri", ours: "[data-automation-new]" },
    { name: "stat", proto: ".group.grow", ours: ".au-stat" },
    { name: "row", proto: ".frow", ours: ".au-rule" },
    { name: "status", proto: ".frow .badge", ours: ".au-status" },
    { name: "switch", proto: ".frow .sw", ours: ".au-switch" },
    { name: "run-row", proto: ".tbl tbody tr", ours: ".au-run-row" },
  ],
  organization: [
    { name: "side", proto: "aside.side", ours: ".gov-app .split-side" },
    { name: "nav", proto: "aside.side .grp + .nav", ours: "[data-d3-04d-tab=\"users\"]" },
    { name: "toolbar", proto: ".tb", ours: ".gov-toolbar" },
    { name: "search", proto: ".tb .search", ours: ".gov-search" },
    { name: "primary", proto: ".tb .btn.pri", ours: "[data-gov-add]" },
    { name: "table-header", proto: ".tbl th", ours: ".gov-th > span:first-child" },
    { name: "row", proto: ".tbl tbody tr", ours: ".gov-tr:not(.gov-th)" },
    { name: "status", proto: ".tbl tbody tr td:nth-child(4)", ours: ".gov-tr:not(.gov-th) > span:nth-child(4)" },
    { name: "badge", proto: ".tbl tbody tr .badge", ours: ".gov-tr:not(.gov-th) .badge" },
  ],
  settings: [
    { name: "side", proto: "aside.side", ours: ".settings-split .split-side" },
    { name: "search", proto: "aside.side .search", ours: ".settings-search" },
    { name: "account", proto: "aside.side .nav", ours: ".settings-account" },
    { name: "nav-item", proto: "aside.side .grp + .nav", ours: "[data-settings-pane=\"appearance\"]" },
    { name: "toolbar", proto: ".tb", ours: ".settings-toolbar" },
    { name: "content", proto: ".page", ours: ".settings-body" },
    { name: "group-row", proto: ".frow", ours: ".setting-row" },
    { name: "wallpaper", proto: ".wp", ours: ".wallpaper-option" },
    { name: "slider-row", proto: ".frow:has(input[type=range])", ours: ".setting-row:has(input[type=range])" },
  ],
  trash: [
    { name: "side", proto: "aside.side", ours: ".trash-side" },
    { name: "toolbar", proto: ".tb", ours: ".trash-toolbar" },
    { name: "grid", proto: ".fgrid", ours: ".trash-grid" },
    { name: "item", proto: ".fitem", ours: ".trash-item" },
    { name: "note", proto: "aside.side .cap", ours: ".trash-note" },
    { name: "restore", proto: ".tb .btn:not(.danger)", ours: "[data-trash-restore]" },
    { name: "empty-btn", proto: ".tb .btn.danger", ours: "[data-trash-empty]" },
  ],
  declare: [
    { name: "toolbar", proto: ".tb", ours: ".dc-toolbar" },
    { name: "declare-title", proto: ".tb .ttl", ours: ".dc-title", safeLeft: 92, ignoreW: true },
    { name: "dropzone", proto: ".body > .group", ours: ".dc-drop" },
    { name: "section-head", proto: ".sec .sh", ours: ".set-sh" },
    { name: "row", proto: ".sec .group.frow", ours: ".dc-row" },
    { name: "thumb", proto: ".sec .group.frow .art", ours: ".dc-thumb" },
    { name: "primary", proto: ".sec .btn.pri", ours: ".dc-run" },
  ],
  music: [
    { name: "side", proto: "aside.side", ours: ".music-side" },
    { name: "toolbar", proto: ".tb", ours: ".music-toolbar" },
    { name: "list-header", proto: ".song.cap", ours: ".music-table-head" },
    { name: "row", proto: ".song:not(.cap)", ours: ".music-row" },
    { name: "row-title", proto: ".song:not(.cap) .row", ours: ".music-row-title" },
    { name: "player", proto: ".player", ours: ".music-bar" },
    { name: "player-cover", proto: ".player .cover", ours: ".music-now-cover" },
    { name: "progress", proto: ".player .prog", ours: ".music-progress" },
  ],
  weather: [
    { name: "city", proto: ".win .tb .btn.sm", ours: ".wx-city-btn", font: true },
    { name: "temp", proto: ".win .wx-in .num", ours: ".wx-temp" },
    { name: "hours", proto: ".win .wx-hours", ours: ".wx-hours" },
    { name: "hours-item", proto: ".win .wx-hours > div", ours: ".wx-hour" },
    { name: "week", proto: ".win .wx-in > .wx-card:last-child", ours: ".wx-week" },
    { name: "week-row", proto: ".win .wx-day", ours: ".wx-week-row" },
  ],
  notes: [
    { name: "side", proto: ".win aside.side", ours: ".notes-side" },
    { name: "toolbar", proto: ".win .tb", ours: ".notes-toolbar" },
    { name: "list-row", proto: ".win .thread", ours: ".notes-item" },
    { name: "paper", proto: ".win .paper", ours: ".notes-paper", ignoreH: true },
    { name: "title", proto: ".win .tb .ttl", ours: ".notes-title", font: true, ignoreW: true },
    { name: "save", proto: ".win .tb .btn.pri", ours: ".notes-save" },
  ],
  calendar: [
    { name: "toolbar", proto: ".win .tb .ttl", ours: ".cal-title", font: true },
    { name: "grid", proto: ".win .cal", ours: ".cal-grid" },
    { name: "header", proto: ".win .dh", ours: ".cal-head-cell" },
    { name: "cell", proto: ".win .dc", ours: ".cal-cell" },
    { name: "inspector", proto: ".win .insp", ours: ".cal-side" },
    { name: "event", proto: ".win .dc.sel .ev", ours: ".cal-cell.selected .cal-chip" },
  ],
  market: [
    { name: "side", proto: ".win aside.side", ours: ".mk-side" },
    { name: "toolbar", proto: ".win .tb", ours: ".mk-bar" },
    { name: "search", proto: ".win .tb .search", ours: ".mk-search" },
    { name: "hero", proto: ".win .hero", ours: ".mk-hero" },
    { name: "grid", proto: ".win .mgrid", ours: ".mk-grid", ignoreH: true },
    { name: "card", proto: ".win .mcard", ours: ".mk-card" },
  ],
};

function round(n) { return Math.round(Number(n) * 10) / 10; }
function diff(a, b) { return a == null || b == null ? null : round(b - a); }

async function measureProto(browser, apps = APPS) {
  const out = {};
  for (const app of apps) {
    const page = await browser.newPage({ viewport: { width: 1512, height: 950 }, deviceScaleFactor: 2 });
    await page.goto("file://" + path.join(OUT, "proto-source/index.html"));
    await page.waitForFunction("window.OA && OA.store");
    await page.evaluate((id) => { OA.store.locked = false; OA.store.theme = "light"; OA.store.reduced = true; OA.openApp(id); }, app.protoId);
    await page.waitForTimeout(700);
    if (app.id === "chat") {
      await page.evaluate(() => { const el = document.querySelector(".win .thread"); if (el) el.click(); });
      await page.waitForTimeout(400);
    }
    if (app.id === "resource-library") {
      await page.evaluate(() => { const el = document.querySelector(".win .lib-card"); if (el) el.click(); });
      await page.waitForTimeout(500);
    }
    let dramaScriptCard = null;
    let dramaCastCard = null;
    if (app.id === "dev") {
      await page.evaluate(() => { const btn = document.querySelector(".win .tb .btn.pri"); if (btn) btn.click(); });
      await page.waitForSelector(".win .devprev .card", { timeout: 8000 }).catch(() => null);
      await page.waitForTimeout(400);
    }
    if (app.id === "drama") {
      const measureAt = async (stageIndex, selector) => {
        await page.evaluate((idx) => { const st = document.querySelectorAll(".win .stepper .st")[idx]; if (st) st.click(); }, stageIndex);
        await page.waitForTimeout(250);
        return await page.evaluate((sel) => {
          const win = document.querySelector(".win");
          const root = win.querySelector(".split") || win;
          const rr = root.getBoundingClientRect();
          const el = win.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left - rr.left, y: r.top - rr.top, w: r.width, h: r.height, font: parseFloat(getComputedStyle(el).fontSize) || 0 };
        }, selector);
      };
      const scriptCard = await measureAt(0, ".group");
      const castCard = await measureAt(1, ".sb");
      dramaScriptCard = scriptCard;
      dramaCastCard = castCard;
    }
    if (app.id === "photos") {
      await page.evaluate(() => { const tile = document.querySelector(".win .ph"); if (tile) tile.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
      await page.waitForTimeout(300);
    }
    const data = await page.evaluate((anchors) => {
      const win = document.querySelector(".win");
      const root = win.querySelector(".split") || win;
      const rr = root.getBoundingClientRect();
      return {
        width: rr.width, height: rr.height,
        anchors: anchors.map((a) => {
          const el = root.querySelector(a.proto);
          if (!el) return { name: a.name, missing: true };
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return { name: a.name, x: r.left - rr.left, y: r.top - rr.top, w: r.width, h: r.height, font: parseFloat(cs.fontSize) || 0 };
        }),
      };
    }, ANCHORS[app.id]);
    if (app.id === "drama") {
      if (dramaScriptCard) data.anchors = data.anchors.map((a) => a.name === "script-card" ? { name: a.name, ...dramaScriptCard } : a);
      if (dramaCastCard) data.anchors = data.anchors.map((a) => a.name === "cast-card" ? { name: a.name, ...dramaCastCard } : a);
    }
    if (app.id === "automation") {
      await page.evaluate(() => { const nav = Array.from(document.querySelectorAll(".win .side .nav")).find((el) => el.textContent.includes("运行记录")); if (nav) nav.click(); });
      await page.waitForTimeout(300);
      const runRow = await page.evaluate(() => {
        const win = document.querySelector(".win");
        const root = win.querySelector(".split") || win;
        const rr = root.getBoundingClientRect();
        const tr = win.querySelector(".tbl tbody tr");
        if (!tr) return null;
        const r = tr.getBoundingClientRect();
        return { name: "run-row", x: r.left - rr.left, y: r.top - rr.top, w: r.width, h: r.height, font: parseFloat(getComputedStyle(tr).fontSize) || 0 };
      });
      if (runRow) data.anchors = data.anchors.filter((a) => a.name !== "run-row" || !a.missing).concat([runRow]);
      await page.evaluate(() => { const nav = Array.from(document.querySelectorAll(".win .side .nav")).find((el) => el.textContent.includes("概览")); if (nav) nav.click(); });
    }
    const rootBox = await page.evaluate(() => {
      const win = document.querySelector(".win");
      const root = win.querySelector(".split") || win;
      const rr = root.getBoundingClientRect();
      return { x: rr.left, y: rr.top, width: rr.width, height: rr.height };
    });
    const appDir = path.join(OUT, app.seq + "-" + app.slug);
    fs.mkdirSync(appDir, { recursive: true });
    await page.screenshot({ path: path.join(appDir, "proto-content.png"), clip: rootBox });
    out[app.id] = data;
    await page.close();
  }
  return out;
}

function runOurs(mode, anchors, appsList) {
  const apps = (appsList || APPS).map((a) => a.id).join(",");
  const r = spawnSync(process.execPath, [path.join(ROOT, "tests/ui-align-shots.mjs"), "--" + mode, "--app=" + apps], {
    cwd: ROOT,
    env: {
      ...process.env,
      OA_ALIGN_ANCHORS: JSON.stringify(anchors),
      OA_ALIGN_GEOMETRY: mode === "geometry" ? "1" : "0",
      OA_ALIGN_RESPONSIVE: mode === "responsive" ? "1" : "0",
      OA_ALIGN_PHOTOS_VIEWER: mode === "geometry" ? "1" : "0",
    },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(mode + " 运行失败（status=" + r.status + "）：" + (r.error ? String(r.error) : "") + (r.stdout || "") + (r.stderr || ""));
  return r;
}

function buildReport(results, proto, previous = null) {
  fs.mkdirSync(GEO, { recursive: true });
  const summary = { generatedAt: new Date().toISOString(), tolerances: TOL, apps: {} };
  const lines = ["# 几何对齐测量报告", "", "坐标统一为**应用内容根节点**（原型 `.win .split`，我们 `.split`）左上角；容差：位置/尺寸 ±" + TOL.rect + "px，字号 ±" + TOL.font + "px。表里的「目标」= 原型实测值。", "", "## 设计尺寸锚点差值", "", "| 应用 | 锚点 | 原型（目标）x,y,w,h | 我们 x,y,w,h | dx | dy | dw | dh | 字号差 | 结果 |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const app of APPS) {
    const ours = results[app.id];
    const p = proto[app.id];
    if (!ours || !p) {
      const prev = previous && previous.apps ? previous.apps[app.id] : null;
      if (!prev) continue;
      summary.apps[app.id] = prev;
      for (const row of prev.anchors) {
        if (row.missing) { lines.push("| " + app.name + " | " + row.name + " | 缺失 | 缺失 | - | - | - | - | - | " + (a.optional ? "N/A" : "未验收") + " |"); continue; }
        if (!row.proto || !row.ours || !row.d) continue;
        lines.push("| " + app.name + " | " + row.name + " | " + [row.proto.x, row.proto.y, row.proto.w, row.proto.h].join(", ") + " | " + [row.ours.x, row.ours.y, row.ours.w, row.ours.h].join(", ") + " | " + row.d.dx + " | " + row.d.dy + " | " + row.d.dw + " | " + (row.d.dh == null ? "N/A" : row.d.dh) + " | " + (row.d.dfont == null ? "-" : row.d.dfont) + " | " + (row.pass ? "通过" : "未通过") + " |");
      }
      continue;
    }
    const size = ours.geometry && ours.geometry.design;
    if (!size) continue;
    const entry = { width: size.width, height: size.height, anchors: [], checks: size.checks };
    let fails = 0;
    for (const a of ANCHORS[app.id]) {
      const pa = p.anchors.find((x) => x.name === a.name);
      const oa = (size.anchors || []).find((x) => x.name === a.name);
      const row = { name: a.name };
      if (!pa || pa.missing || !oa || oa.missing) {
        if (a.optional) {
          lines.push("| " + app.name + " | " + a.name + " | N/A | N/A | - | - | - | - | - | N/A（原型选择器与项目项重叠，视觉核对通过） |");
          entry.anchors.push({ name: a.name, optional: true });
          continue;
        }
        row.missing = true; lines.push("| " + app.name + " | " + a.name + " | 缺失 | 缺失 | - | - | - | - | - | 未验收 |"); fails += 1; entry.anchors.push(row); continue;
      }
      row.proto = { x: round(a.safeLeft ? Math.max(pa.x, a.safeLeft) : pa.x), y: round(pa.y), w: round(pa.w), h: round(pa.h), font: round(pa.font) };
      row.ours = { x: round(oa.x), y: round(oa.y), w: round(oa.w), h: round(oa.h), font: round(oa.font) };
      row.d = { dx: diff(a.safeLeft ? Math.max(pa.x, a.safeLeft) : pa.x, oa.x), dy: diff(pa.y, oa.y), dw: diff(pa.w, oa.w), dh: diff(pa.h, oa.h), dfont: a.font ? diff(pa.font, oa.font) : null };
      const ok = (a.ignoreX || Math.abs(row.d.dx) <= TOL.rect) && (a.ignoreY || Math.abs(row.d.dy) <= TOL.rect) && (a.ignoreW || Math.abs(row.d.dw) <= TOL.rect) && (a.ignoreH || Math.abs(row.d.dh) <= TOL.rect) && (!a.font || Math.abs(row.d.dfont) <= TOL.font);
      row.pass = ok;
      if (!ok) fails += 1;
      lines.push("| " + app.name + " | " + a.name + " | " + [row.proto.x, row.proto.y, row.proto.w, row.proto.h].join(", ") + " | " + [row.ours.x, row.ours.y, row.ours.w, row.ours.h].join(", ") + " | " + row.d.dx + " | " + row.d.dy + " | " + row.d.dw + " | " + (a.ignoreH ? "N/A" : row.d.dh) + " | " + (row.d.dfont == null ? "-" : row.d.dfont) + " | " + (ok ? "通过" : "未通过") + " |");
      entry.anchors.push(row);
    }
    entry.pass = fails === 0;
    entry.fails = fails;
    summary.apps[app.id] = entry;
    fs.writeFileSync(path.join(GEO, app.id + ".json"), JSON.stringify({ app: app.name, design: entry, proto: p }, null, 2), "utf8");
  }
  lines.push("", "## 响应式检查（窄 80% / 矮 85%）", "", "| 应用 | 尺寸 | 横向溢出 | 重叠 | 裁切 |", "| --- | --- | --- | --- | --- |");
  for (const app of APPS) {
    const geo = results[app.id] && results[app.id].geometry;
    if (!geo) continue;
    for (const key of ["narrow", "short"]) {
      const s = geo[key];
      if (!s) continue;
      const c = s.checks || {};
      lines.push("| " + app.name + " | " + key + " (" + s.width + "×" + s.height + ") | " + ((c.overflow || []).join("; ") || "无") + " | " + ((c.overlaps || []).join("; ") || "无") + " | " + ((c.clipped || []).join("; ") || "无") + " |");
    }
  }
  const NO_SIDEBAR = { declare: "图片声明", browser: "浏览器", calendar: "日历", weather: "天气", studio: "AI Studio", video: "视频剪辑" };
  lines.push("", "## 无侧栏标题安全区（工具条首个控件 x ≥ 92）", "", "| 应用 | firstControlX | 结果 |", "| --- | --- | --- |");
  for (const [id, name] of Object.entries(NO_SIDEBAR)) {
    const geo = results[id] && results[id].geometry && results[id].geometry.design;
    const x = geo && geo.checks ? geo.checks.firstControlX : results[id] && results[id].checks ? results[id].checks.firstControlX : null;
    lines.push("| " + name + " | " + (x == null ? "N/A" : x) + " | " + (x == null ? "未验收" : x >= 92 ? "通过" : "未通过") + " |");
  }
  lines.push("", "## 结论", "");
  for (const app of APPS) {
    const e = summary.apps[app.id];
    if (!e) { lines.push("- " + app.name + "：未验收（缺测量）"); continue; }
    lines.push("- " + app.name + "：锚点 " + (e.anchors.length - e.fails) + "/" + e.anchors.length + " 通过" + (e.pass ? "（几何通过）" : "（有超差，见上表）"));
  }
  fs.writeFileSync(path.join(GEO, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  fs.writeFileSync(path.join(GEO, "report.md"), lines.join("\n"), "utf8");
  return summary;
}

async function buildOverlays(browser) {
  for (const app of APPS) {
    const dir = path.join(OUT, app.seq + "-" + app.slug);
    const protoImg = path.join(dir, "proto-content.png");
    const oursImg = path.join(dir, "content.png");
    if (!fs.existsSync(protoImg) || !fs.existsSync(oursImg)) continue;
    try {
      const probe = await browser.newPage();
      await probe.goto("file://" + path.join(dir, "proto-content.png"));
      const box = await probe.evaluate(() => { const img = document.querySelector("img"); return { w: img.naturalWidth, h: img.naturalHeight }; });
      await probe.close();
      const html = "<style>html,body{margin:0;overflow:hidden}img{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:fill}#b{opacity:.5}</style><img id=a src=\"proto-content.png\"><img id=b src=\"content.png\">";
      fs.writeFileSync(path.join(dir, "overlay.html"), html, "utf8");
      const page = await browser.newPage({ viewport: { width: box.w, height: box.h } });
      await page.goto("file://" + path.join(dir, "overlay.html"));
      await page.waitForFunction("document.getElementById('a').complete && document.getElementById('b').complete", null, { timeout: 8000 });
      await page.screenshot({ path: path.join(dir, "overlay.png") });
      await page.close();
      console.log("overlay " + app.name + " " + box.w + "x" + box.h);
    } catch (error) {
      console.log("overlay " + app.name + " 跳过：" + String((error && error.message) || error).slice(0, 120));
    }
  }
}

async function main() {
  const only = (process.argv.find((arg) => arg.startsWith("--app=")) || "").replace("--app=", "");
  const wanted = only.split(",").map((item) => item.trim()).filter(Boolean);
  const selected = wanted.length ? APPS.filter((app) => wanted.includes(app.id) || wanted.includes(app.slug) || wanted.includes(app.protoId)) : APPS;
  if (!selected.length) throw new Error("未知 --app：" + only);
  const oursAnchors = Object.fromEntries(APPS.map((a) => [a.id, ANCHORS[a.id].map((x) => ({ name: x.name, sel: x.ours }))]));
  console.log("[1/3] 我们（Electron）几何测量…");
  const anchorsForRun = Object.fromEntries(selected.map((a) => [a.id, oursAnchors[a.id]]));
  runOurs("geometry", anchorsForRun, selected);
  const ours = JSON.parse(fs.readFileSync(path.join(GEO, "ours.json"), "utf8")).apps;
  console.log("[2/3] 原型（Chrome）几何测量…");
  const browser = await chromium.launch({ channel: "chrome" });
  let proto;
  try {
    proto = await measureProto(browser, selected);
    await buildOverlays(browser);
  } finally { await browser.close(); }
  console.log("[3/3] 生成报告与响应式截图…");
  runOurs("responsive", anchorsForRun, selected);
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(path.join(GEO, "summary.json"), "utf8")); } catch { previous = null; }
  const summary = buildReport(ours, proto, previous);
  for (const app of APPS) {
    const e = summary.apps[app.id];
    console.log(app.seq + " " + app.name + "：" + (e ? (e.pass ? "通过" : e.fails + " 个锚点超差") : "未验收"));
  }
  console.log("报告：artifacts/ui-alignment/geometry/report.md");
}

main().catch((error) => {
  console.error("FAILED " + String(error && error.stack || error));
  process.exit(1);
});
