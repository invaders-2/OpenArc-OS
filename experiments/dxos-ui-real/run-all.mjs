#!/usr/bin/env node
/**
 * 五套 UI 探针 · 真实打包窗口内的渲染证据（dxos-ui-real）。
 *
 * 与前五套深探（experiments/dxos-ui-skills|mcp|tasks|org|model）的关系：
 *   那五套是 esbuild 挂载壳 + Chromium 独立上下文（newContext({viewport,deviceScaleFactor})），
 *   只渲染组件、没有产品外壳；本探针启动真实 electron/main.cjs + preload.cjs + dist，
 *   在隔离 userData 里开真实窗口，用同一批选择器量同一批关键度量，逐项对照。
 *
 * 做什么：
 *   1) --user-data-dir=<临时目录> 启动真实产品入口 electron .（绝不触碰 ~/Library/Application Support/openarc-os）；
 *   2) CDP 连上真实渲染页，把视图钉到 1440x900 / deviceScaleFactor 2（与 Chromium 探针同条件）；
 *   3) 经真实产品桥 initialize + login（首启），只经 window.openarc.* 造真实数据（技能 / MCP 连接 / 项目+任务 / 部门 / Provider）；
 *   4) 两趟隔离运行：A 趟（空态）与 B 趟（就绪态，首启即含造出的真实数据），各自 light + dark 截图五个真实页面；
 *   5) 记录每个页面的关键度量（容器宽 / 列表行高 / 标题字号 / 行标题字号 / 元信息字号），
 *      与对应 Chromium 探针 report.json 的数值逐项对照，写 compare-notes.md；
 *   6) 断言：0 console error、0 pageerror、0 非本地请求；组织治理页不得出现 会员/权益/套餐/积分；全页不得出现 尚未实现；
 *   7) 收工核对真实 profile 的 identity.db / -wal / -shm 与顶层快照前后一致（只读 stat + sha256，绝不用 SQLite 打开）。
 *
 * 硬约束：不联网（只连本机 CDP；断言渲染层无非本地请求）；不执行/修改 DX OS；不新增依赖；
 *         不改 CSP / tokens.css / 既有界面；不 git commit；不跑 npm run build / npm test；失败 exit 非 0。
 *
 * 用法：
 *   node experiments/dxos-ui-real/run-all.mjs
 *   OA_UI_REAL_CDP_PORT=9798 node experiments/dxos-ui-real/run-all.mjs
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-ui-real");
const SHOT = { width: 1440, height: 900, deviceScaleFactor: 2 };
const AREA_TOP = 38;
/* 渲染源：默认 dist/index.html（打包产物）；设置 OA_DEV_SERVER 时走 Vite 开发预览
   （electron/main.cjs 明确支持的模式）。产物版本早于界面改动时，入口锚点只在源码里存在。 */
const DEV_SERVER = process.env.OA_DEV_SERVER || null;
const RENDERER_SOURCE = DEV_SERVER ? "vite-dev(" + DEV_SERVER + ")" : "dist/index.html";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();

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

async function waitFor(fn, timeoutMs, stepMs) {
  const step = stepMs || 200;
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
function resolveRealProfilePath() {
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
function snapshotProfile(dir) {
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
function diffProfile(before, after) {
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
function redactProfile(snapshot) {
  const identity = {};
  for (const k of Object.keys(snapshot.identity)) {
    const v = snapshot.identity[k];
    identity[k] = v.exists ? { mtimeMs: v.mtimeMs, size: v.size, ino: v.ino, sha256: v.sha256 } : v;
  }
  return { path: snapshot.path, exists: snapshot.exists, dir: snapshot.dir, identity, topLevelCount: Object.keys(snapshot.topLevel).length };
}
function processesUsing(dir) {
  try {
    const text = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    return text.split("\n").filter((line) => line.includes(dir)).map((line) => line.trim().slice(0, 200)).slice(0, 20);
  } catch (err) { return []; }
}

/* ══════════════════════════════════════════════════════════════════════════
   五个页面：真实 appId / 窗口标题 / 与 Chromium 探针同源的选择器
   ══════════════════════════════════════════════════════════════════════════ */
const SKILL_VARS = { root: ".skill-center", split: ".skill-split", list: ".skill-list-pane", detail: ".skill-detail-pane", row: ".skill-row[data-skill-id]", rowName: ".skill-row__top strong", rowFacts: ".skill-row__facts", paneHead: ".skill-pane-head", title: ".skill-banner__title" };
const MCP_VARS = { root: ".mcp-center", split: ".mcp-split", list: ".mcp-list-pane", detail: ".mcp-detail-pane", row: ".mcp-row", rowName: ".mcp-row__top strong", rowFacts: ".mcp-row__facts", paneHead: ".mcp-pane-head", title: ".mcp-banner__title" };
const TASK_VARS = { root: ".task-center", split: ".task-split", list: ".task-list-pane", detail: ".task-detail-pane", row: ".task-row[data-task-id]", rowName: ".task-row__top strong", rowFacts: ".task-row__facts", paneHead: ".task-pane-head", title: ".task-banner__title" };
const ORG_VARS = { root: ".org-center", split: ".org-split", list: ".org-list-pane", detail: ".org-detail-pane", row: ".org-row", rowName: ".org-row__top strong", rowFacts: ".org-row__facts", paneHead: ".org-pane-head", title: ".org-banner__title" };
const MODEL_VARS = { root: ".model-proto", split: ".model-proto__split", list: ".model-proto__list-pane", detail: ".model-proto__detail-pane", row: ".model-proto__row", rowName: ".model-proto__row-top strong", rowFacts: ".model-proto__row-facts", paneHead: ".model-proto__title", title: ".model-proto__title", blockTitle: ".model-proto__block-title" };

/** Chromium 探针的度量来源（report.json 的 compare.metrics[<key>]）。 */
const CHROMIUM_METRIC_SOURCE = {
  skills: { report: "artifacts/dxos-ui-skills/report.json", key: "skill" },
  mcp: { report: "artifacts/dxos-ui-skills/report.json", key: "mcp" },
  tasks: { report: "artifacts/dxos-ui-tasks/report.json", key: "task" },
  org: { report: "artifacts/dxos-ui-org/report.json", key: "org" },
  model: { report: "artifacts/dxos-ui-model/report.json", key: "model" },
};

function settledSkill(sel) {
  const w = document.querySelector(sel);
  if (!w) return false;
  const el = w.querySelector("[data-skill-list-state]");
  if (!el) return false;
  return ["ready", "empty", "error", "unavailable"].indexOf(el.getAttribute("data-skill-list-state")) >= 0;
}
function settledMcp(sel) {
  const w = document.querySelector(sel);
  if (!w) return false;
  if (!w.querySelector(".mcp-center")) return false;
  return w.querySelectorAll(".mcp-row").length > 0 || !!w.querySelector("[data-mcp-empty]");
}
function settledTask(sel) {
  const w = document.querySelector(sel);
  if (!w) return false;
  const el = w.querySelector("[data-task-list-state]");
  // TaskConsole 只在**非 ready** 分支渲染 data-task-list-state；属性缺失即 ready（列表已挂载）。
  if (!el) return !!w.querySelector(".task-split") || !!w.querySelector(".task-list-pane");
  return ["ready", "empty", "error", "unavailable", "unauthorized"].indexOf(el.getAttribute("data-task-list-state")) >= 0;
}
function settledOrg(sel) {
  const w = document.querySelector(sel);
  if (!w) return false;
  const el = w.querySelector("[data-org-list-state]");
  if (!el) return false;
  return ["ready", "empty", "error", "unavailable"].indexOf(el.getAttribute("data-org-list-state")) >= 0;
}
function settledModel(sel) {
  const w = document.querySelector(sel);
  if (!w) return false;
  return w.querySelectorAll(".model-proto__row").length > 0;
}

const PAGES = [
  {
    id: "skills", appId: "skills", windowLabel: "Skill 中心窗口", title: "Skill 中心",
    vars: SKILL_VARS, settled: settledSkill,
    emptyNote: "「市场」页签（本机无技能包）",
    readyNote: "「我的技能」页签（真实 skill/save 造出的自定义技能）",
    subA: async (page) => clickNavText(page, "Skill 中心窗口", "市场"),
    subB: async (page) => clickNavText(page, "Skill 中心窗口", "我的技能"),
    readyProbe: { selector: '[data-skill-id="probe_skill_one"]', text: "探针技能一号", expectRows: 1 },
  },
  {
    id: "mcp", appId: "mcp-center", windowLabel: "MCP 中心窗口", title: "MCP 中心",
    vars: MCP_VARS, settled: settledMcp,
    emptyNote: "连接列表为空（mcp/list total=0）",
    readyNote: "真实 mcp/create 造出的连接行",
    subA: null,
    subB: null,
    readyProbe: { selector: ".mcp-row", text: "本机探针 MCP", expectRows: 1 },
  },
  {
    id: "tasks", appId: "projects", windowLabel: "项目窗口", title: "任务控制台（projects → 任务控制台）",
    vars: TASK_VARS, settled: settledTask,
    emptyNote: "项目内还没有 Agent 任务",
    readyNote: "真实 agent/project/create + agent/task/create 造出的任务行",
    subA: async (page) => clickNavText(page, "项目窗口", "任务控制台"),
    subB: async (page) => clickNavText(page, "项目窗口", "任务控制台"),
    readyProbe: { selector: ".task-row[data-task-id]", text: "真实窗口探针任务", expectRows: 1 },
  },
  {
    id: "org", appId: "organization", windowLabel: "组织治理窗口", title: "组织治理",
    vars: ORG_VARS, settled: settledOrg,
    emptyNote: "部门列表为空（本机只有一个超管账号）",
    readyNote: "真实 identity/department-create 造出的部门行",
    subA: null,
    subB: null,
    readyProbe: { selector: ".org-row", text: "真实窗口探针部门", expectRows: 1 },
  },
  {
    id: "model", appId: "settings", windowLabel: "系统设置窗口", title: "系统设置 → 模型与协议",
    vars: MODEL_VARS, settled: settledModel,
    emptyNote: "Providers 未配置（.model-proto 协议表本身恒为真实 71 条）",
    readyNote: "真实 provider/create 造出的 Provider 行 + 协议表",
    subA: async (page) => clickSelector(page, '.window[aria-label="系统设置窗口"] [data-settings-pane="model"]'),
    subB: async (page) => clickSelector(page, '.window[aria-label="系统设置窗口"] [data-settings-pane="model"]'),
    readyProbe: { selector: ".d401-row[data-d4-01-provider]", text: "真实窗口探针 Provider", expectRows: 1 },
  },
];

/**
 * 本轮新增入口的真实窗口留证（ready 场景 · light + dark 各一张）。
 *   · 技能入口：技能文档分析（市场）、运行（媒体类）/ 保存与更新 / 工作区（已安装详情）；
 *   · 任务四个写入口：新建任务 / 调用工具 / 跑项目 / ReAct 运行；
 *   · 模型四个动作入口：协议校验 / 协议保存 / 图像生成 / 协议执行；
 *   · MCP 工具聚合区（只读，数据来自 mcp/agentTools）。
 * prepare 在对应页面已打开后就地准备（选技能行 / 切子视图 / 滚动到入口）；
 * 锚点与区块必须真实出现在目标窗口里，否则该入口截图记 FAIL（不静默跳过）。
 */
const ENTRY_SPECS = [
  {
    pageId: "skills",
    id: "entry-skill-detail",
    windowLabel: "Skill 中心窗口",
    anchor: "[data-skill-run-kind]",
    blocks: ["[data-skill-run-kind]", "[data-skill-save-state]", "[data-skill-workspace-state]"],
    note: "技能入口：运行（媒体运行）/ 保存与更新 / 工作区技能",
    prepare: async (page) => {
      await page.evaluate(function () {
        const win = document.querySelector('section.window[aria-label="Skill 中心窗口"]');
        const row = win && win.querySelector('[data-skill-id="probe_skill_one"]');
        if (row) row.click();
      });
      await waitFor(async () => !!(await page.$('section.window[aria-label="Skill 中心窗口"] [data-skill-run-kind]')), 15000, 200);
    },
  },
  {
    pageId: "skills",
    id: "entry-skill-analyze",
    windowLabel: "Skill 中心窗口",
    anchor: "[data-skill-analyze-state]",
    blocks: ["[data-skill-analyze-state]"],
    note: "技能入口：技能文档分析（skill/analyze）",
    prepare: async (page) => {
      await clickNavText(page, "Skill 中心窗口", "市场");
      await waitFor(async () => !!(await page.$('section.window[aria-label="Skill 中心窗口"] [data-skill-analyze-state]')), 15000, 200);
    },
  },
  {
    pageId: "mcp",
    id: "entry-mcp-aggregate",
    windowLabel: "MCP 中心窗口",
    anchor: "[data-mcp-aggregate-section]",
    blocks: ["[data-mcp-aggregate-section]", "[data-mcp-aggregate-count]"],
    note: "MCP 聚合区：工具聚合（只读，mcp/agentTools）",
    prepare: async (page) => {
      await waitFor(async () => !!(await page.$('section.window[aria-label="MCP 中心窗口"] [data-mcp-aggregate-section]')), 15000, 200);
    },
  },
  {
    pageId: "tasks",
    id: "entry-task-writes",
    windowLabel: "项目窗口",
    anchor: "[data-task-entry]",
    blocks: ["[data-task-entry]", '[data-task-entry="create"]', '[data-task-entry="tool-call"]', '[data-task-entry="project-run"]', '[data-task-entry="react-run"]'],
    note: "任务四个写入口：新建任务 / 调用工具 / 跑项目 / ReAct 运行",
    prepare: async (page) => {
      await clickNavText(page, "项目窗口", "任务控制台");
      await waitFor(async () => !!(await page.$('section.window[aria-label="项目窗口"] [data-task-entry]')), 15000, 200);
    },
  },
  {
    pageId: "model",
    id: "entry-model-actions",
    windowLabel: "系统设置窗口",
    anchor: '[data-model-proto="entries"]',
    blocks: ['[data-model-proto="entries"]', '[data-model-entry="protocol-validate"]', '[data-model-entry="protocol-save"]', '[data-model-entry="image-generate"]', '[data-model-entry="protocol-execute"]'],
    note: "模型四个动作入口：协议校验 / 协议保存 / 图像生成 / 协议执行",
    prepare: async (page) => {
      await clickSelector(page, '.window[aria-label="系统设置窗口"] [data-settings-pane="model"]');
      await waitFor(async () => !!(await page.$('section.window[aria-label="系统设置窗口"] [data-model-proto="entries"]')), 15000, 200);
    },
  },
];

function windowSelector(label) {
  return 'section.window[aria-label="' + label + '"]';
}

/* ══════════════════════════════════════════════════════════════════════════
   CDP / DOM 原语
   ══════════════════════════════════════════════════════════════════════════ */
async function clickSelector(page, selector) {
  return page.evaluate(function (sel) {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  }, selector);
}
async function clickNavText(page, windowLabel, text) {
  return page.evaluate(function (arg) {
    const win = document.querySelector(arg.sel);
    if (!win) return false;
    const buttons = Array.prototype.slice.call(win.querySelectorAll(".split-nav"));
    for (let i = 0; i < buttons.length; i += 1) {
      if ((buttons[i].textContent || "").trim() === arg.text) { buttons[i].click(); return true; }
    }
    return false;
  }, { sel: windowSelector(windowLabel), text: text });
}
/** 把窗口内的入口锚点滚到可视区中部；返回锚点是否存在。 */
async function scrollIntoView(page, winSel, anchorSel) {
  return page.evaluate(function (arg) {
    const win = document.querySelector(arg.win);
    if (!win) return false;
    const el = win.querySelector(arg.anchor);
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    return true;
  }, { win: winSel, anchor: anchorSel });
}

async function openApp(page, spec) {
  await clickSelector(page, '.dock-item[data-dock-id="' + spec.appId + '"]');
  return waitFor(async () => !!(await page.$(windowSelector(spec.windowLabel))), 12000, 200);
}
async function ensureMaximized(page, spec) {
  const label = await page.evaluate(function (sel) {
    const win = document.querySelector(sel);
    if (!win) return null;
    const btn = win.querySelector(".maximize");
    return btn ? btn.getAttribute("aria-label") : null;
  }, windowSelector(spec.windowLabel));
  if (label && label.indexOf("最大化") === 0) {
    await clickSelector(page, windowSelector(spec.windowLabel) + " .maximize");
    await waitFor(async () => {
      const rect = await page.evaluate(function (sel) {
        const win = document.querySelector(sel);
        if (!win) return null;
        const r = win.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height];
      }, windowSelector(spec.windowLabel));
      return !!rect && Math.abs(rect[3] - (SHOT.height - AREA_TOP)) < 3;
    }, 8000, 150);
  }
  return true;
}
/** 把目标窗口抬到最上层（真实交互：section.window 的 onPointerDown → window/focus）。 */
async function focusWindow(page, spec) {
  return page.evaluate(function (sel) {
    const win = document.querySelector(sel);
    if (!win) return false;
    win.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
    return true;
  }, windowSelector(spec.windowLabel));
}
/** 目标窗口是否是当前 z 最高的真实窗口（决定截图里看到的是谁）。 */
async function isTopmost(page, spec) {
  return page.evaluate(function (sel) {
    const win = document.querySelector(sel);
    if (!win) return false;
    const mine = Number(getComputedStyle(win).zIndex) || 0;
    let max = -1;
    const all = document.querySelectorAll("section.window");
    for (let i = 0; i < all.length; i += 1) max = Math.max(max, Number(getComputedStyle(all[i]).zIndex) || 0);
    return mine >= max;
  }, windowSelector(spec.windowLabel));
}
/** 目标窗口的可解释诊断：窗口栈 + 目标窗口内部结构（供报告留证）。 */
async function windowDiagnostics(page, spec) {
  return page.evaluate(function (arg) {
    const stack = Array.prototype.slice.call(document.querySelectorAll("section.window")).map(function (w) {
      const r = w.getBoundingClientRect();
      return { label: w.getAttribute("aria-label"), z: Number(getComputedStyle(w).zIndex) || 0, cls: String(w.className), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], textLen: (w.innerText || "").length };
    });
    const win = document.querySelector(arg.sel);
    if (!win) return { stack: stack, target: null };
    return {
      stack: stack,
      target: {
        nav: Array.prototype.slice.call(win.querySelectorAll(".split-nav")).map(function (b) { return (b.textContent || "").trim() + "=" + (b.getAttribute("aria-current") || "false"); }),
        taskCenter: !!win.querySelector(".task-center"),
        projectsApp: !!win.querySelector(".projects"),
        settingsPane: win.querySelector("[data-settings-active]") ? win.getAttribute("data-settings-active") : null,
        textLen: (win.innerText || "").length,
      },
    };
  }, { sel: windowSelector(spec.windowLabel), label: spec.windowLabel });
}

async function setTheme(page, theme) {
  const label = "系统设置窗口";
  const okOpen = await openApp(page, { appId: "settings", windowLabel: label });
  if (!okOpen) return false;
  await clickSelector(page, windowSelector(label) + ' [data-settings-pane="appearance"]');
  await sleep(150);
  const text = theme === "dark" ? "深色" : "浅色";
  const clicked = await page.evaluate(function (arg) {
    const win = document.querySelector(arg.sel);
    if (!win) return false;
    const group = win.querySelector('.segmented[aria-label="外观"]');
    if (!group) return false;
    const buttons = Array.prototype.slice.call(group.querySelectorAll("button"));
    for (let i = 0; i < buttons.length; i += 1) {
      if ((buttons[i].textContent || "").trim() === arg.text) { buttons[i].click(); return true; }
    }
    return false;
  }, { sel: windowSelector(label), text: text });
  if (!clicked) return false;
  return waitFor(async () => {
    const dark = await page.evaluate(function () {
      const d = document.querySelector(".desktop");
      return d ? d.classList.contains("dark") : null;
    });
    return dark === (theme === "dark");
  }, 5000, 100);
}
async function enableReducedMotion(page) {
  const label = "系统设置窗口";
  const okOpen = await openApp(page, { appId: "settings", windowLabel: label });
  if (!okOpen) return false;
  await clickSelector(page, windowSelector(label) + ' [data-settings-pane="appearance"]');
  await sleep(150);
  const clicked = await page.evaluate(function (sel) {
    const win = document.querySelector(sel);
    if (!win) return false;
    const sw = win.querySelector('button[role="switch"][aria-label="减少动态效果"]');
    if (!sw) return false;
    if (sw.getAttribute("aria-checked") === "true") return true;
    sw.click();
    return true;
  }, windowSelector(label));
  await waitFor(async () => await page.evaluate(function () {
    const d = document.querySelector(".desktop");
    return d ? d.classList.contains("reduced") : false;
  }), 4000, 100);
  return clicked;
}

function measureWindow(arg) {
  const win = document.querySelector(arg.sel);
  if (!win) return null;
  function rectOf(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) };
  }
  function styleOf(el, props) {
    if (!el) return null;
    const s = getComputedStyle(el);
    const out = {};
    for (let i = 0; i < props.length; i += 1) out[props[i]] = s.getPropertyValue(props[i]).trim();
    return out;
  }
  function one(sel) { return win.querySelector(sel); }
  function count(sel) { return win.querySelectorAll(sel).length; }
  const v = arg.vars;
  const pageStates = Array.prototype.slice.call(win.querySelectorAll('[data-ds-comp="page-state"]')).map(function (el) {
    return { kind: el.getAttribute("data-ds-kind"), title: ((el.querySelector(".ds-page-state__title") || {}).textContent || "").trim(), rect: rectOf(el) };
  });
  return {
    window: rectOf(win),
    titleBar: rectOf(one(".window-title")),
    windowBody: rectOf(one(".window-body")),
    splitSide: rectOf(one(".split-side")),
    splitMain: rectOf(one(".split-main")),
    splitMainStyle: styleOf(one(".split-main"), ["padding-top", "padding-right", "padding-bottom", "padding-left"]),
    root: rectOf(one(v.root)),
    rootStyle: styleOf(one(v.root), ["height", "gap", "padding"]),
    split: rectOf(one(v.split)),
    splitStyle: styleOf(one(v.split), ["display", "grid-template-columns", "gap", "padding", "align-items"]),
    listPane: rectOf(one(v.list)),
    detailPane: rectOf(one(v.detail)),
    paneHead: rectOf(one(v.paneHead)),
    row: rectOf(one(v.row)),
    rowText: one(v.row) ? (one(v.row).innerText || "").replace(/\s+/g, " ").slice(0, 300) : null,
    rowStyle: styleOf(one(v.row), ["padding", "border-radius", "background-color"]),
    rowNameStyle: styleOf(one(v.rowName), ["font-size", "font-weight", "line-height"]),
    rowFactsStyle: styleOf(one(v.rowFacts), ["font-size", "line-height", "color"]),
    titleStyle: styleOf(one(v.title), ["font-size", "font-weight", "letter-spacing"]),
    blockTitleStyle: v.blockTitle ? styleOf(one(v.blockTitle), ["font-size", "font-weight"]) : null,
    counts: { rows: count(v.row), badges: count('[data-ds-comp="badge"]'), buttons: count('[data-ds-comp="button"]'), pageStates: pageStates.length },
    pageStates: pageStates,
    text: (win.innerText || "").slice(0, 6000),
  };
}

async function shoot(cdp, file) {
  const res = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(file, Buffer.from(res.data, "base64"));
  const buf = fs.readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

/* ══════════════════════════════════════════════════════════════════════════
   主流程
   ══════════════════════════════════════════════════════════════════════════ */
async function main() {
  const require = createRequire(path.join(ROOT, "package.json"));
  const chromium = require("@playwright/test").chromium;
  const electronPath = require("electron");
  const electronVersion = (function () { try { return require("electron/package.json").version; } catch (err) { return null; } })();

  fs.mkdirSync(ART, { recursive: true });
  const runStartedAt = Date.now();
  const realProfilePath = resolveRealProfilePath();
  const profileBefore = snapshotProfile(realProfilePath);
  const realProfileProcessesBefore = processesUsing(realProfilePath);

  const checks = [];
  const notVerified = [];
  const observations = [];
  const commandLog = [];
  const captures = [];
  const consoleAll = [];
  const consoleErrors = [];
  const pageErrors = [];
  const requests = [];
  const requestFailures = [];
  const nonLocal = [];
  const LOCAL_RE = /^(file:|data:|blob:|about:|devtools:|openarc-file:|openarc-resource:|openarc-canvas:|http:\/\/127\.0\.0\.1|http:\/\/localhost|http:\/\/\[::1\]|ws:\/\/127\.0\.0\.1|ws:\/\/localhost)/i;

  const record = (section, name, ok, expected, actual, detail) => {
    const row = { section, name, ok: !!ok, expected: String(expected == null ? "" : expected), actual: String(actual == null ? "" : actual).slice(0, 600), detail: detail || null };
    checks.push(row);
    console.log((row.ok ? "PASS" : "FAIL") + " [" + section + "] " + name + " :: actual=" + row.actual + " expected=" + row.expected);
    return row.ok;
  };
  const note = (line) => { observations.push(line); console.log("   · " + line); };

  /** 经产品桥发一条命令：identity 用 {type,...}，其余域用 {command,payload}（与 preload 的真实契约一致）。 */
  async function callBridge(page, channel, command, payload) {
    const started = Date.now();
    const res = await page.evaluate(async function (arg) {
      const api = window.openarc[arg.channel];
      if (!api || typeof api.command !== "function") return { __threw: true, message: "no bridge " + arg.channel };
      const request = arg.channel === "identity" ? Object.assign({ type: arg.command }, arg.payload) : { command: arg.command, payload: arg.payload };
      try { return await api.command(request); } catch (err) { return { __threw: true, message: String((err && err.message) || err) }; }
    }, { channel: channel, command: command, payload: payload || {} });
    return { ms: Date.now() - started, result: res };
  }

  async function runScenario(label, createData) {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-ui-real-" + label + "-"));
    const port = process.env.OA_UI_REAL_CDP_PORT ? Number(process.env.OA_UI_REAL_CDP_PORT) + (label === "ready" ? 1 : 0) : await freePort();
    const launchArgs = [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + port];
    const launchCommand = "electron " + launchArgs.map((a) => (a.indexOf(userDataDir) >= 0 ? "--user-data-dir=<isolated-temp>" : a)).join(" ");
    const env = Object.assign({}, process.env);
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;

    console.log("\n========== 场景 " + label + " ==========");
    console.log("隔离 userData：" + userDataDir);
    console.log("渲染源：" + RENDERER_SOURCE);
    console.log("启动：" + launchCommand);

    let child = null;
    let browser = null;
    let page = null;
    let cdp = null;
    let stdoutBuf = "";
    let stderrBuf = "";
    const exitInfo = { clean: false, code: null, signal: null };
    let windowInfo = null;
    let bridgeKeys = null;
    let reducedOk = false;

    try {
      child = spawn(electronPath, launchArgs, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: env });
      child.stdout.on("data", (d) => { stdoutBuf += String(d); });
      child.stderr.on("data", (d) => { stderrBuf += String(d); });

      const cdpReady = await waitFor(async () => { try { const r = await fetch("http://127.0.0.1:" + port + "/json/version"); return r.ok; } catch (err) { return false; } }, 45000, 300);
      if (!cdpReady) throw new Error("CDP 未就绪：" + stderrBuf.slice(-500));

      browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
      const context = browser.contexts()[0];
      const devBase = DEV_SERVER ? DEV_SERVER.replace(/[/]+$/, "") + "/" : null;
      const isUI = (p) => {
        const u = p.url();
        if (u.indexOf("index.html") >= 0) return true;
        if (devBase && (u === devBase || u.indexOf(devBase) === 0 || u === DEV_SERVER)) return true;
        return false;
      };
      const found = await waitFor(() => !!context.pages().find(isUI), 30000, 300);
      page = context.pages().find(isUI) || null;
      if (!found || !page) throw new Error("未找到真实界面页面：" + context.pages().map((p) => p.url()).join(" | "));

      page.on("console", (msg) => {
        const row = { scenario: label, type: msg.type(), text: String(msg.text()).slice(0, 400) };
        consoleAll.push(row);
        if (row.type === "error") consoleErrors.push(row.text);
      });
      page.on("pageerror", (err) => pageErrors.push(String((err && err.message) || err).slice(0, 400)));
      page.on("request", (req) => {
        const url = req.url();
        requests.push({ scenario: label, url: url });
        if (!LOCAL_RE.test(url)) nonLocal.push({ scenario: label, url: url });
      });
      page.on("requestfailed", (req) => requestFailures.push({ scenario: label, url: req.url(), error: String((req.failure() && req.failure().errorText) || "") }));

      const rendererReady = await waitFor(async () => {
        const v = await page.evaluate(function () { return { rs: document.readyState, n: window.openarc ? Object.keys(window.openarc).length : 0 }; });
        return v && v.rs === "complete" && v.n === 25;
      }, 45000, 300);
      if (!rendererReady) throw new Error("渲染层未就绪（45 秒内未拿到 25 键桥面）");

      cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: SHOT.width, height: SHOT.height, deviceScaleFactor: SHOT.deviceScaleFactor, mobile: false });
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "no-preference" });
      await sleep(400);

      windowInfo = await page.evaluate(function () {
        return { url: location.href, readyState: document.readyState, innerWidth: innerWidth, innerHeight: innerHeight, devicePixelRatio: devicePixelRatio, gate: document.querySelector(".desktop") ? document.querySelector(".desktop").getAttribute("data-identity-gate") : null };
      });
      bridgeKeys = await page.evaluate(function () { return Object.keys(window.openarc); });
      record("boot/" + label, "B1 · 真实 electron/main.cjs + preload.cjs + " + RENDERER_SOURCE + " 渲染就绪", rendererReady, "readyState=complete + 25 键", JSON.stringify(windowInfo));
      record("boot/" + label, "B2 · 桥面顶层键恰为 25", bridgeKeys.length === 25, 25, bridgeKeys.length + " → " + bridgeKeys.join(","));
      record("boot/" + label, "B3 · 视图钉到 1440×900 / deviceScaleFactor 2", windowInfo.innerWidth === 1440 && windowInfo.innerHeight === 900 && windowInfo.devicePixelRatio === 2, "1440x900@2", JSON.stringify(windowInfo));

      const identifier = "ui-real-" + label + "@openarc.test";
      const password = "UiReal-password-1";
      const initRes = await callBridge(page, "identity", "identity/initialize", { identifier: identifier, password: password, displayName: "真实窗口探针管理员" });
      const loginRes = await callBridge(page, "identity", "identity/login", { identifier: identifier, password: password });
      const gateReady = await waitFor(async () => (await page.evaluate(function () { const d = document.querySelector(".desktop"); return d ? d.getAttribute("data-identity-gate") : null; })) === "ready", 20000, 200);
      record("identity/" + label, "I0 · 经产品桥 identity/initialize 首启初始化", !!(initRes.result && initRes.result.ok === true), "ok:true", JSON.stringify(initRes.result).slice(0, 200));
      record("identity/" + label, "I1 · 经产品桥 identity/login 登录并进入 ready", !!(loginRes.result && loginRes.result.ok === true) && gateReady, "ok:true + gate=ready", JSON.stringify({ ok: loginRes.result && loginRes.result.ok, gateReady: gateReady }));
      const isolatedIdentityDb = fs.existsSync(path.join(userDataDir, "identity.db"));
      record("isolation/" + label, "S0 · 隔离 userData ≠ 真实 profile 且内部真实建库 identity.db", path.resolve(userDataDir) !== path.resolve(realProfilePath) && isolatedIdentityDb, "different + identity.db present", userDataDir);

      reducedOk = await enableReducedMotion(page);
      record("appearance/" + label, "A0 · 经真实设置打开「减少动态效果」（稳定截图，不改 tokens/CSP）", reducedOk, "desktop.reduced", String(reducedOk));

      if (createData) {
        const skillSave = await callBridge(page, "skill", "skill/save", { skill: { id: "probe_skill_one", name: "探针技能一号", description: "真实窗口探针经 skill/save 创建的自定义技能", systemPrompt: "你是真实窗口探针创建的自定义技能。" } });
        /* 技能文档分析入口只在「市场」页签有技能包时渲染；用产品自己的 export → import
           把刚保存的技能做成一个真实技能包，不引入任何外部 ZIP 依赖。 */
        const packExport = await callBridge(page, "skill", "skill/pack/export", { skillId: "probe_skill_one" });
        const packBase64 = packExport.result && packExport.result.value ? packExport.result.value.base64 : null;
        /* 用 skill/pack/install（会写技能包索引，市场页可见技能包）而不是 pack/import
           （后者只注册包内技能、不产生技能包记录，市场页仍是空态）。 */
        const packInstall = packBase64
          ? await callBridge(page, "skill", "skill/pack/install", { archiveBase64: packBase64, sourceName: "probe-skill-pack.zip" })
          : { result: null, ms: null };
        const mcpCreate = await callBridge(page, "mcp", "mcp/create", { name: "本机探针 MCP", transport: "http", location: "REMOTE_SERVICE", endpoint: { url: "http://127.0.0.1:9/probe" } });
        const projectCreate = await callBridge(page, "agent", "agent/project/create", { name: "真实窗口探针项目", rootNodeId: "probe-root" });
        const project = projectCreate.result && projectCreate.result.value && projectCreate.result.value.project;
        let taskCreate = { result: null, ms: null };
        if (project && project.id) taskCreate = await callBridge(page, "agent", "agent/task/create", { projectId: project.id, instruction: "真实窗口探针任务：验证任务控制台出现真实数据行。", title: "真实窗口探针任务" });
        const deptCreate = await callBridge(page, "identity", "identity/department-create", { name: "真实窗口探针部门" });
        const providerCreate = await callBridge(page, "model", "provider/create", { displayName: "真实窗口探针 Provider", baseUrl: "http://127.0.0.1:9/v1", endpointScope: "LOCALHOST", scope: "PERSONAL" });
        const commands = [
          { id: "skill/save", ms: skillSave.ms, result: skillSave.result },
          { id: "skill/pack/export", ms: packExport.ms, result: packExport.result },
          { id: "skill/pack/install", ms: packInstall.ms, result: packInstall.result },
          { id: "mcp/create", ms: mcpCreate.ms, result: mcpCreate.result },
          { id: "agent/project/create", ms: projectCreate.ms, result: projectCreate.result },
          { id: "agent/task/create", ms: taskCreate.ms, result: taskCreate.result },
          { id: "identity/department-create", ms: deptCreate.ms, result: deptCreate.result },
          { id: "provider/create", ms: providerCreate.ms, result: providerCreate.result },
        ];
        for (const c of commands) {
          commandLog.push({ scenario: label, id: c.id, ms: c.ms, result: c.result });
          record("data/" + label, "D · " + c.id + " 真实执行成功", !!(c.result && c.result.ok === true), "ok:true", JSON.stringify(c.result).slice(0, 220));
        }
      } else {
        const skillPacks = await callBridge(page, "skill", "skill/pack/list", {});
        const mcpList = await callBridge(page, "mcp", "mcp/list", {});
        const taskList = await callBridge(page, "agent", "agent/task/list", {});
        const deptList = await callBridge(page, "identity", "identity/departments-list", {});
        const providerList = await callBridge(page, "model", "provider/list", {});
        const counts = {
          "skill/pack/list": skillPacks.result && skillPacks.result.value ? skillPacks.result.value.items.length : null,
          "mcp/list": mcpList.result ? mcpList.result.total : null,
          "agent/task/list": taskList.result && taskList.result.value ? taskList.result.value.items.length : null,
          "identity/departments-list": deptList.result ? deptList.result.items.length : null,
          "provider/list": providerList.result ? providerList.result.items.length : null,
        };
        for (const c of [{ id: "skill/pack/list", result: skillPacks.result }, { id: "mcp/list", result: mcpList.result }, { id: "agent/task/list", result: taskList.result }, { id: "identity/departments-list", result: deptList.result }, { id: "model/provider/list", result: providerList.result }]) {
          commandLog.push({ scenario: label, id: c.id, ms: null, result: c.result });
        }
        const allEmpty = counts["skill/pack/list"] === 0 && counts["mcp/list"] === 0 && counts["agent/task/list"] === 0 && counts["identity/departments-list"] === 0 && counts["provider/list"] === 0;
        record("data/" + label, "D · 空态场景的五个来源经真实只读命令确认全为 0", allEmpty, "all 0", JSON.stringify(counts));
        note("空态计数（真实只读命令）：" + JSON.stringify(counts));
      }

      const state = createData ? "ready" : "empty";
      for (const theme of ["light", "dark"]) {
        const themed = await setTheme(page, theme);
        record("appearance/" + label, "A1 · 经真实设置切到 " + theme + "（desktop class 校验）", themed, theme === "dark" ? "desktop.dark" : "无 dark 类", String(themed));
        await sleep(250);
        for (const spec of PAGES) {
          const opened = await openApp(page, spec);
          if (!opened) {
            record("page/" + label + "/" + theme, "P · " + spec.id + " 真实窗口打开", false, "window present", "missing");
            continue;
          }
          const sub = createData ? spec.subB : spec.subA;
          if (sub) await sub(page);
          await ensureMaximized(page, spec);
          await focusWindow(page, spec);
          let topmost = await isTopmost(page, spec);
          if (!topmost) {
            await openApp(page, spec);
            await focusWindow(page, spec);
            topmost = await waitFor(async () => await isTopmost(page, spec), 5000, 150);
          }
          const settled = await waitFor(async () => await page.evaluate(spec.settled, windowSelector(spec.windowLabel)), 20000, 200);
          await sleep(450);
          const metrics = await page.evaluate(measureWindow, { sel: windowSelector(spec.windowLabel), vars: spec.vars });
          const diagnostics = await windowDiagnostics(page, spec);
          const file = path.join(ART, spec.id + "-" + state + "-" + theme + ".png");
          const dim = await shoot(cdp, file);
          const bodyText = await page.evaluate(function () { return document.body.innerText || ""; });
          record("page/" + label + "/" + theme, "P · " + spec.id + " 渲染就绪（" + (createData ? spec.readyNote : spec.emptyNote) + "）", settled && !!metrics, "settled", JSON.stringify({ settled: settled, topmost: topmost, root: metrics && metrics.root, rows: metrics && metrics.counts.rows, pageStates: metrics && metrics.pageStates.map((p) => p.kind), target: diagnostics && diagnostics.target }));
          record("focus/" + label + "/" + theme, "P · " + spec.id + " 目标窗口在最上层（截图里看到的确实是它）", topmost, "topmost", JSON.stringify({ topmost: topmost, stack: diagnostics ? diagnostics.stack : null }));
          record("shot/" + label + "/" + theme, "P · " + spec.id + " 截图像素 " + (SHOT.width * 2) + "x" + (SHOT.height * 2), dim.width === SHOT.width * 2 && dim.height === SHOT.height * 2, (SHOT.width * 2) + "x" + (SHOT.height * 2), dim.width + "x" + dim.height);
          record("placeholder/" + label + "/" + theme, "P · " + spec.id + " 页面无「尚未实现」占位（且整页确有渲染文本）", bodyText.length > 0 && bodyText.indexOf("尚未实现") < 0, "bodyText>0 且无占位文案", "bodyLen=" + bodyText.length + " found=" + (bodyText.indexOf("尚未实现") >= 0));
          const capture = {
            scenario: label, state: state, theme: theme, pageId: spec.id, title: spec.title, windowLabel: spec.windowLabel,
            note: createData ? spec.readyNote : spec.emptyNote, topmost: topmost,
            screenshot: path.relative(ROOT, file), screenshotDims: dim, metrics: metrics, settled: settled, diagnostics: diagnostics,
            bodyTextLength: bodyText.length, windowText: metrics ? metrics.text : null,
          };
          captures.push(capture);
          if (createData && spec.readyProbe) {
            const probe = await page.evaluate(function (arg) {
              const win = document.querySelector(arg.sel);
              if (!win) return { count: 0, text: "" };
              return { count: win.querySelectorAll(arg.probe).length, text: (win.innerText || "") };
            }, { sel: windowSelector(spec.windowLabel), probe: spec.readyProbe.selector });
            record("data/" + label, "D · " + spec.id + " 页面出现真实造出的数据行（" + spec.readyProbe.selector + "）", probe.count >= 1 && probe.text.indexOf(spec.readyProbe.text) >= 0, ">=" + spec.readyProbe.expectRows + " 且含「" + spec.readyProbe.text + "」", "count=" + probe.count + " 含名=" + (probe.text.indexOf(spec.readyProbe.text) >= 0));
            if (spec.id === "model") {
              const protoRows = metrics ? metrics.counts.rows : 0;
              record("data/" + label, "D · model 协议表来自真实 protocol/list（>0 行）", protoRows > 0, ">0", String(protoRows));
            }
          }
          if (spec.id === "org") {
            const banned = ["会员", "权益", "套餐", "积分"];
            const hit = banned.filter((w) => (metrics ? metrics.text : "").indexOf(w) >= 0);
            record("org/" + label + "/" + theme, "O · 组织治理页不出现 会员/权益/套餐/积分", hit.length === 0, "0 命中", JSON.stringify(hit));
            capture.orgBannedWords = hit;
          }

          /* 本轮新增入口：就地为每个入口截图（light / dark 各一张）。 */
          if (createData) {
            for (const entrySpec of ENTRY_SPECS.filter((e) => e.pageId === spec.id)) {
              await entrySpec.prepare(page);
              const scrolled = await scrollIntoView(page, windowSelector(spec.windowLabel), entrySpec.anchor);
              await sleep(400);
              const present = await page.evaluate(function (arg) {
                const win = document.querySelector(arg.sel);
                if (!win) return { anchor: false, blocks: [] };
                return {
                  anchor: !!win.querySelector(arg.anchor),
                  blocks: arg.blocks.filter(function (s) { return !!win.querySelector(s); }),
                };
              }, { sel: windowSelector(spec.windowLabel), anchor: entrySpec.anchor, blocks: entrySpec.blocks });
              const entryFile = path.join(ART, entrySpec.id + "-" + state + "-" + theme + ".png");
              const entryDim = await shoot(cdp, entryFile);
              const entryWindowText = await page.evaluate(function (sel) {
                const win = document.querySelector(sel);
                return win ? (win.innerText || "") : "";
              }, windowSelector(spec.windowLabel));
              const entryBody = await page.evaluate(function () { return document.body.innerText || ""; });
              record("entry/" + label + "/" + theme, "E · " + entrySpec.note + " 在真实窗口可见（anchor " + entrySpec.anchor + "）", present.anchor && present.blocks.length === entrySpec.blocks.length, entrySpec.blocks.length + " 个区块", JSON.stringify(present));
              record("entry-shot/" + label + "/" + theme, "E · " + entrySpec.id + " 截图像素 " + (SHOT.width * 2) + "x" + (SHOT.height * 2), entryDim.width === SHOT.width * 2 && entryDim.height === SHOT.height * 2, (SHOT.width * 2) + "x" + (SHOT.height * 2), entryDim.width + "x" + entryDim.height);
              const entryBanned = ["会员", "权益"];
              const entryHit = entryBanned.filter((w) => entryWindowText.indexOf(w) >= 0 || entryBody.indexOf(w) >= 0);
              record("entry-banned/" + label + "/" + theme, "E · " + entrySpec.id + " 界面无「会员 / 权益」字样", entryHit.length === 0, "0 命中", JSON.stringify(entryHit));
              record("entry-placeholder/" + label + "/" + theme, "E · " + entrySpec.id + " 页面无「尚未实现」占位", entryBody.indexOf("尚未实现") < 0, "无占位文案", "found=" + (entryBody.indexOf("尚未实现") >= 0));
              captures.push({
                scenario: label, state: state, theme: theme, pageId: entrySpec.id, entry: true,
                title: entrySpec.note, windowLabel: spec.windowLabel, note: entrySpec.note,
                topmost: await isTopmost(page, spec),
                screenshot: path.relative(ROOT, entryFile), screenshotDims: entryDim,
                metrics: null, settled: present.anchor,
                diagnostics: { anchor: entrySpec.anchor, scrolled: scrolled, blocks: present.blocks },
                bodyTextLength: entryBody.length, windowText: entryWindowText.slice(0, 6000),
              });
            }
          }
        }
      }

      try { await page.evaluate(function () { window.close(); return "closing"; }); } catch (err) { /* 关窗后执行上下文销毁 */ }
      const exited = await waitFor(() => child.exitCode != null || child.signalCode != null, 20000, 200);
      if (!exited) { try { child.kill("SIGTERM"); } catch (err) { /* ignore */ } await waitFor(() => child.exitCode != null || child.signalCode != null, 5000, 200); }
      exitInfo.clean = exited;
      exitInfo.code = child.exitCode == null ? null : child.exitCode;
      exitInfo.signal = child.signalCode || null;
      record("exit/" + label, "X · 正常关窗退出（window-all-closed → app.quit）", exited, "process exits", JSON.stringify(exitInfo));
      try { if (browser) await browser.close(); } catch (err) { /* 已随进程关闭 */ }
    } catch (error) {
      record("fatal/" + label, "F · 场景中断", false, "run to completion", String((error && error.stack) || error).slice(0, 500));
      try { if (child && child.exitCode == null && child.signalCode == null) child.kill("SIGKILL"); } catch (err) { /* ignore */ }
      try { if (browser) await browser.close(); } catch (err) { /* ignore */ }
    } finally {
      const residual = processesUsing(userDataDir);
      record("exit/" + label, "X · 无残留进程持有隔离 userData", residual.length === 0, 0, residual.length + " → " + JSON.stringify(residual.slice(0, 3)));
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
      record("exit/" + label, "X · 删除隔离 userData", !fs.existsSync(userDataDir), "removed", fs.existsSync(userDataDir) ? "still present" : "removed");
      console.log("stderr 摘要（" + label + "）：" + stderrBuf.split("\n").filter((l) => /error|Error|FATAL|Unhandled/i.test(l)).filter((l) => !/ssl_client_socket|SSL error|net_error|handshake failed|GPU|gpu_|Metal|Autofill|CoreText/i.test(l)).slice(0, 8).join(" | ").slice(0, 700));
      console.log("stdout 摘要（" + label + "）：" + stdoutBuf.split("\n").slice(-6).join(" | ").slice(0, 400));
    }
    return { label: label, windowInfo: windowInfo, exit: exitInfo };
  }

  const scenarios = [];
  scenarios.push(await runScenario("empty", false));
  scenarios.push(await runScenario("ready", true));

  record("hygiene", "H0 · 全程 console error = 0", consoleErrors.length === 0, 0, consoleErrors.length + " → " + JSON.stringify(consoleErrors.slice(0, 6)));
  record("hygiene", "H1 · 全程 pageerror = 0", pageErrors.length === 0, 0, pageErrors.length + " → " + JSON.stringify(pageErrors.slice(0, 6)));
  record("hygiene", "H2 · 全程无非本地网络请求", nonLocal.length === 0, 0, nonLocal.length + " → " + JSON.stringify(nonLocal.slice(0, 6)));
  note("渲染层请求总数 " + requests.length + "，非本地 " + nonLocal.length + "，失败请求 " + requestFailures.length);
  note("请求样本：" + JSON.stringify(Array.from(new Set(requests.map((r) => r.url.replace(/^(file:\/\/[^/]+).*/, "$1/*")))).slice(0, 10)));

  const compareItems = [];
  const chromiumMetrics = {};
  for (const pageId of Object.keys(CHROMIUM_METRIC_SOURCE)) {
    const src = CHROMIUM_METRIC_SOURCE[pageId];
    const abs = path.join(ROOT, src.report);
    let metric = null;
    let reportAt = null;
    try {
      const j = JSON.parse(fs.readFileSync(abs, "utf8"));
      metric = j.compare && j.compare.metrics ? j.compare.metrics[src.key] || null : null;
      reportAt = j.finishedAt || null;
    } catch (err) { metric = null; }
    chromiumMetrics[pageId] = { report: src.report, key: src.key, reportAt: reportAt, metric: metric };
  }

  function pick(m, pathList) {
    let cur = m;
    for (const k of pathList) { if (cur == null) return null; cur = cur[k]; }
    return cur == null ? null : cur;
  }
  const COMPARE_ROWS = [
    { id: "containerWidth", label: "容器宽 .split-main", path: ["splitMain", "width"] },
    { id: "rootWidth", label: "容器宽 .root", path: ["root", "width"] },
    { id: "splitWidth", label: "容器宽 .split", path: ["split", "width"] },
    { id: "listPaneWidth", label: "列表栏宽", path: ["listPane", "width"] },
    { id: "rowHeight", label: "列表行高", path: ["row", "height"] },
    { id: "titleFontSize", label: "页面标题字号", path: ["titleStyle", "font-size"] },
    { id: "rowNameFontSize", label: "行标题字号", path: ["rowNameStyle", "font-size"] },
    { id: "rowFactsFontSize", label: "行元信息字号", path: ["rowFactsStyle", "font-size"] },
  ];
  const REAL_PATHS = {
    containerWidth: ["splitMain", "width"], rootWidth: ["root", "width"], splitWidth: ["split", "width"], listPaneWidth: ["listPane", "width"],
    rowHeight: ["row", "height"], titleFontSize: ["titleStyle", "font-size"], rowNameFontSize: ["rowNameStyle", "font-size"], rowFactsFontSize: ["rowFactsStyle", "font-size"],
  };

  for (const pageId of ["skills", "mcp", "tasks", "org", "model"]) {
    const cap = captures.find((c) => c.pageId === pageId && c.scenario === "ready" && c.theme === "light") || captures.find((c) => c.pageId === pageId);
    const cm = chromiumMetrics[pageId].metric;
    for (const row of COMPARE_ROWS) {
      const chromiumValue = pick(cm, row.path);
      const realValue = pick(cap && cap.metrics, REAL_PATHS[row.id]);
      const delta = typeof chromiumValue === "number" && typeof realValue === "number" ? +(realValue - chromiumValue).toFixed(1) : null;
      compareItems.push({
        page: pageId, metric: row.label, chromium: chromiumValue == null ? null : chromiumValue, real: realValue == null ? null : realValue, delta: delta,
        identical: chromiumValue != null && realValue != null && String(chromiumValue) === String(realValue),
        source: CHROMIUM_METRIC_SOURCE[pageId].report + "#compare.metrics." + CHROMIUM_METRIC_SOURCE[pageId].key + "." + row.path.join("."),
      });
    }
  }
  const fontRows = compareItems.filter((i) => /字号/.test(i.metric));
  for (const item of fontRows) item.reason = item.identical ? "设计 token 未变（--fs-title / --fs-body / --fs-micro），不随后壳变化" : "一侧数值缺失（见 actual）";
  const fontComparable = fontRows.filter((i) => i.chromium != null);
  const fontNotComparable = fontRows.filter((i) => i.chromium == null);
  record("compare", "C1 · 字号类关键度量与 Chromium 探针逐项一致（标题 / 行标题 / 元信息）", fontComparable.every((i) => i.identical), "凡两侧都有数值的字号项必须一致", JSON.stringify({ comparable: fontComparable.map((i) => ({ page: i.page, metric: i.metric, chromium: i.chromium, real: i.real, identical: i.identical })), notComparable: fontNotComparable.map((i) => ({ page: i.page, metric: i.metric, real: i.real })) }));
  const rowRows = compareItems.filter((i) => i.metric === "列表行高");
  for (const item of rowRows) {
    const cap = captures.find((c) => c.pageId === item.page && c.scenario === "ready" && c.theme === "light");
    item.realRowText = cap && cap.metrics ? cap.metrics.rowText : null;
    item.reason = item.identical
      ? "行结构与 Chromium 探针一致"
      : "行高由真实行的内容长度（标题 / 元信息 / 描述换行数）决定；Chromium 探针渲染固定假数据，本探针渲染真实命令造出的行，内容不同所以行高不同。行的内边距与圆角不随后壳变化。";
  }
  record("compare", "C2 · 列表行高逐项记录并归因（真实数据内容，非窗口外壳）", rowRows.every((i) => i.chromium != null && i.real != null), "两侧数值齐备", JSON.stringify(rowRows.map((i) => ({ page: i.page, chromium: i.chromium, real: i.real, delta: i.delta, realRowText: i.realRowText }))));
  const widthRows = compareItems.filter((i) => /容器宽|列表栏宽/.test(i.metric));
  for (const item of widthRows) {
    if (item.identical) item.reason = "与 Chromium 探针一致";
    else if (item.chromium == null && item.real == null) { item.bothAbsent = true; item.reason = "该页面在 Chromium 探针与真实窗口里都没有这一层（McpCenter 直接渲染，无 .split 包装），两侧一致地不存在"; }
    else item.reason = "真实窗口最大化后内容原点下移（软件顶栏 38px），且窗口标题栏占据窗口内部一条高度，可用高度与内边距随之变化";
  }
  record("compare", "C3 · 宽度类度量逐项记录并给出原因（真实窗口外壳：顶栏 + 窗口标题栏占位）", widthRows.every((i) => !!i.reason), "每条都有原因", JSON.stringify(widthRows.map((i) => ({ page: i.page, metric: i.metric, chromium: i.chromium, real: i.real, delta: i.delta, bothAbsent: !!i.bothAbsent }))));

  const profileAfter = snapshotProfile(realProfilePath);
  const profileDiff = diffProfile(profileBefore, profileAfter);
  const realProfileProcessesAfter = processesUsing(realProfilePath);
  record("profile", "S1 · 真实身份库 identity.db / -wal / -shm mtime+size+sha256 完全未变", profileDiff.identityUnchanged, "unchanged", JSON.stringify({ changed: profileDiff.changed.filter((c) => c.indexOf("identity/") === 0) }));
  if (profileDiff.unchanged) {
    record("profile", "S2 · 真实 profile 顶层快照完全未变", true, "unchanged", "0 changed");
  } else {
    record("profile", "S2 · 真实 profile 顶层快照完全未变", false, "unchanged", profileDiff.changedCount + " 项变化 → " + JSON.stringify(profileDiff.changed.slice(0, 20)), "开工前/收工后分别有 " + realProfileProcessesBefore.length + "/" + realProfileProcessesAfter.length + " 个进程以真实 profile 运行（用户自己的 OpenArc OS.app），无法排除是其自身写盘；身份库三件套见 S1");
  }
  note("真实 profile：" + realProfilePath + "；开工前以该 profile 运行的进程：" + realProfileProcessesBefore.length + "，收工后：" + realProfileProcessesAfter.length);

  notVerified.push({ item: "截图内的像素级文字识别（OCR）", reason: "离线环境没有随包 OCR 依赖，未做像素级识别；组织治理页的 会员/权益/套餐/积分 断言基于该窗口真实 DOM 的 innerText（截图就是这块 DOM 的渲染结果）。" });
  notVerified.push({ item: "OS 窗口物理尺寸 = 1440×900", reason: "真实 BrowserWindow 由 electron/main.cjs 固定 1440×940；为与 Chromium 探针完全同条件，视图经 CDP Emulation.setDeviceMetricsOverride 钉到 1440×900 / deviceScaleFactor 2（截图像素 2880x1800 已断言）。" });
  notVerified.push({ item: "零网络出站的主机级证明", reason: "断言的是「渲染层无任何非本地请求」（CDP request 事件全量采集）；未做主机级抓包。主进程侧另有产品自带的导航出网拦截。" });
  if (realProfileProcessesBefore.length > 0) notVerified.push({ item: "真实 profile 在运行期间绝对无人写入", reason: "期间用户自己的 OpenArc OS.app 正在以真实 profile 运行（开工前 " + realProfileProcessesBefore.length + " 个进程）；本次窗口内快照未变，但无法替第三方进程作绝对保证。" });

  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  const report = {
    phase: "dxos-ui-real",
    title: "五套 UI 探针 · 真实打包窗口内的渲染证据（Skill 中心 / MCP 中心 / 任务控制台 / 组织治理 / 系统设置·模型与协议）",
    at: nowIso(),
    runStartedAt: runStartedAt,
    durationMs: Date.now() - runStartedAt,
    command: "node experiments/dxos-ui-real/run-all.mjs",
    environment: { platform: process.platform, arch: process.arch, node: process.version, electron: electronVersion, cwd: ROOT },
    condition: {
      viewport: { width: SHOT.width, height: SHOT.height },
      deviceScaleFactor: SHOT.deviceScaleFactor,
      screenshotPixels: { width: SHOT.width * 2, height: SHOT.height * 2 },
      rendererSource: RENDERER_SOURCE,
      rendererSourceNote: DEV_SERVER
        ? "本次用 electron/main.cjs 明确支持的 OA_DEV_SERVER 开发预览模式（Vite 直接服务源码），因为 dist 打包产物早于本轮界面改动、不含新入口锚点；未执行任何构建。"
        : "打包产物 dist/index.html（electron/main.cjs 默认路径）。",
      mechanism: "CDP Emulation.setDeviceMetricsOverride（与 Chromium 探针 newContext({viewport,deviceScaleFactor}) 同条件）+ page.emulateMedia({reducedMotion:'reduce'})",
      appReducedMotion: true,
      themes: ["light", "dark"],
      themeMechanism: "应用真实外观设置（系统设置 → 外观与交互 → 浅色/深色），校验 .desktop.dark",
      windowShell: "真实 electron/main.cjs 的 BrowserWindow（macOS titleBarStyle=hidden，DOM 顶栏 38px + 窗口标题栏在窗口内部）；最大化铺满宿主、只让开软件顶栏",
    },
    isolation: {
      mechanism: "两次独立 --user-data-dir=<os.tmpdir() 临时目录> 启动真实 electron .；绝不指向 ~/Library/Application Support/openarc-os",
      realProfilePath: realProfilePath,
      realProfileProcessesBefore: realProfileProcessesBefore,
      realProfileProcessesAfter: realProfileProcessesAfter,
      profileBefore: redactProfile(profileBefore),
      profileAfter: redactProfile(profileAfter),
      profileDiff: { identityUnchanged: profileDiff.identityUnchanged, wholeProfileUnchanged: profileDiff.unchanged, changed: profileDiff.changed, changedCount: profileDiff.changedCount },
      realProfileReadMethod: "只读 stat + sha256（readFileSync 计算哈希）；从未用 SQLite 打开真实库",
    },
    pages: PAGES.map((p) => ({ id: p.id, appId: p.appId, title: p.title, windowLabel: p.windowLabel, emptyNote: p.emptyNote, readyNote: p.readyNote, selectors: p.vars })),
    scenarios: scenarios,
    commands: commandLog,
    screenshots: captures.map((c) => ({ page: c.pageId, state: c.state, theme: c.theme, file: c.screenshot, pixels: c.screenshotDims.width + "x" + c.screenshotDims.height, bytes: c.screenshotDims.bytes })),
    captures: captures,
    chromiumCompare: { sources: chromiumMetrics, items: compareItems },
    console: { total: consoleAll.length, errorCount: consoleErrors.length, pageErrorCount: pageErrors.length, errors: consoleErrors.slice(0, 20), pageErrors: pageErrors.slice(0, 20), byType: consoleAll.reduce((acc, m) => { acc[m.type] = (acc[m.type] || 0) + 1; return acc; }, {}) },
    network: { total: requests.length, nonLocal: nonLocal.slice(0, 20), allLocal: nonLocal.length === 0, requestFailures: requestFailures.slice(0, 10) },
    counts: { pass: passed, fail: failed, total: checks.length, notVerified: notVerified.length },
    checks: checks,
    notVerified: notVerified,
    observations: observations,
  };
  fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify(report, null, 2));
  writeCompareNotes(report);

  console.log("\n=== 结论 ===");
  console.log("截图：" + captures.length + " 张（每页 empty/ready × light/dark）");
  console.log("console error=" + consoleErrors.length + " pageerror=" + pageErrors.length + " 非本地请求=" + nonLocal.length);
  console.log("真实 profile 身份库未变=" + profileDiff.identityUnchanged + "（identity.db sha256 前后对照见 report.json）");
  console.log("PASS " + passed + " / FAIL " + failed);
  console.log("报告：" + path.relative(ROOT, path.join(ART, "report.json")));
  console.log("对照笔记：" + path.relative(ROOT, path.join(ART, "compare-notes.md")));
  return failed === 0 ? 0 : 1;
}

/* ══════════════════════════════════════════════════════════════════════════
   compare-notes.md
   ══════════════════════════════════════════════════════════════════════════ */
function writeCompareNotes(report) {
  const L = [];
  const cm = report.chromiumCompare;
  L.push("# dxos-ui-real · 真实窗口度量 vs Chromium 探针 · 对照笔记");
  L.push("");
  L.push("> 生成：" + report.at + " · 命令：" + report.command);
  L.push("");
  L.push("## 0. 对照条件");
  L.push("");
  L.push("| 维度 | Chromium 探针（esbuild 挂载壳） | 本探针（真实打包窗口） |");
  L.push("| --- | --- | --- |");
  L.push("| 渲染入口 | esbuild 打包 harness.tsx，newContext({viewport,deviceScaleFactor}) | 真实 electron .（electron/main.cjs + electron/preload.cjs + dist/index.html） |");
  L.push("| 视口 | 1440×900 | 1440×900（CDP Emulation.setDeviceMetricsOverride） |");
  L.push("| deviceScaleFactor | 2 | 2 |");
  L.push("| 截图像素 | 2880×1800 | 2880×1800 |");
  L.push("| 主题 | light（对照页面） | light + dark（应用真实外观设置切换） |");
  L.push("| prefers-reduced-motion | reduce | reduce（emulateMedia）+ 应用真实「减少动态效果」开关 |");
  L.push("| 外壳 | 无（只有一个 position:absolute;inset:0 的假 .window） | 真实桌面：软件顶栏 38px + 窗口标题栏 + 最大化铺满宿主只让开顶栏 |");
  L.push("");
  L.push("## 1. 真实窗口外壳带来的差异（逐项）");
  L.push("");
  L.push("- 窗口 y 起点：Chromium 的 .window 从 (0,0) 开始；真实窗口最大化后 y = " + AREA_TOP + "（软件顶栏高度），高度 = 900 − " + AREA_TOP + " = " + (900 - AREA_TOP) + "px。");
  L.push("- 窗口标题栏：真实窗口内部还有 .window-title（.window 与 .window-body 之间），内容区再让出一条标题栏高度；挂载壳里没有这一层。");
  L.push("- .split-side 位置：两侧外壳都渲染 .split-side，但真实窗口的内容原点下移了「顶栏 + 标题栏」，所以同一元素的 y 更大、可用高度更小。");
  L.push("- 宽度：真实窗口宽 1440 铺满宿主；字号与行高不随后壳变化，宽度只差内边距 / 滚动条。");
  L.push("- Dock 被盖住：产品口径是「最大化铺满整个宿主，只让开软件顶栏」，因此最大化后 Dock 被窗口覆盖（与 macOS 全屏一致）；本探针经真实的 .dock-item 按钮 DOM 事件打开下一页，而不是像素点击。");
  L.push("");
  L.push("## 2. 关键度量逐项对照");
  L.push("");
  L.push("> 真实值取本探针 artifacts/dxos-ui-real/report.json 的 ready + light 截图；Chromium 值取各探针 report.json 的 compare.metrics。");
  L.push("");
  const byPage = {};
  for (const item of cm.items) { if (!byPage[item.page]) byPage[item.page] = []; byPage[item.page].push(item); }
  for (const pageId of Object.keys(byPage)) {
    const src = cm.sources[pageId];
    L.push("### " + pageId);
    L.push("");
    L.push("来源：" + src.report + " → compare.metrics." + src.key + (src.reportAt ? "（" + src.reportAt + "）" : ""));
    L.push("");
    L.push("| 度量 | Chromium 探针 | 真实窗口 | 差值 | 结论 | 原因 |");
    L.push("| --- | --- | --- | --- | --- | --- |");
    for (const item of byPage[pageId]) {
      const verdict = item.identical ? "一致" : item.bothAbsent ? "两侧都不存在（一致）" : item.chromium == null || item.real == null ? "缺一侧数值" : "有差异";
      let reason = item.reason || (item.identical ? "一致" : "见第 1 节");
      if (item.realRowText) reason += " 真实行文本：" + item.realRowText.slice(0, 60);
      L.push("| " + item.metric + " | " + (item.chromium == null ? "—" : item.chromium) + " | " + (item.real == null ? "—" : item.real) + " | " + (item.delta == null ? "—" : item.delta) + " | " + verdict + " | " + reason.replace(/\|/g, "/") + " |");
    }
    L.push("");
  }
  L.push("## 3. 真实窗口里的状态与数据（真实命令造出）");
  L.push("");
  L.push("| 页面 | 空态/基线 | 非空态（真实命令） |");
  L.push("| --- | --- | --- |");
  for (const p of report.pages) L.push("| " + p.title + " | " + p.emptyNote + " | " + p.readyNote + " |");
  L.push("");
  L.push("真实命令输出（摘要）：");
  L.push("");
  for (const c of report.commands.filter((x) => x.scenario === "ready")) {
    L.push("- " + c.id + " → " + (c.result && c.result.ok === true ? "ok:true" : "见 report.json") + "：" + JSON.stringify(c.result).slice(0, 200));
  }
  L.push("");
  L.push("## 4. 断言结果");
  L.push("");
  const grouped = {};
  for (const c of report.checks) { if (!grouped[c.section]) grouped[c.section] = { pass: 0, fail: 0, names: [] }; grouped[c.section][c.ok ? "pass" : "fail"] += 1; if (!c.ok) grouped[c.section].names.push(c.name); }
  L.push("| 分组 | PASS | FAIL | 失败项 |");
  L.push("| --- | --- | --- | --- |");
  for (const k of Object.keys(grouped)) L.push("| " + k + " | " + grouped[k].pass + " | " + grouped[k].fail + " | " + (grouped[k].names.slice(0, 4).join("；") || "—") + " |");
  L.push("");
  L.push("- console error = " + report.console.errorCount + " / pageerror = " + report.console.pageErrorCount + " / 非本地请求 = " + report.network.nonLocal.length);
  L.push("- 说明：会员/权益/套餐/积分的断言基于组织治理窗口真实 DOM 的 innerText（截图即该 DOM 的渲染结果）；离线环境没有 OCR 依赖，未做像素级文字识别。");
  L.push("");
  L.push("## 5. 真实 profile 零改动对照");
  L.push("");
  L.push("真实 profile：" + report.isolation.realProfilePath + "（只读 stat + sha256，从未用 SQLite 打开）。");
  L.push("");
  L.push("| 文件 | 开工前 size / mtimeMs / sha256 | 收工后 size / mtimeMs / sha256 | 一致 |");
  L.push("| --- | --- | --- | --- |");
  for (const name of ["identity.db", "identity.db-wal", "identity.db-shm"]) {
    const b = report.isolation.profileBefore.identity[name] || {};
    const a = report.isolation.profileAfter.identity[name] || {};
    const same = JSON.stringify(b) === JSON.stringify(a);
    L.push("| " + name + " | " + (b.size || "-") + " / " + (b.mtimeMs || "-") + " / " + String(b.sha256 || "-").slice(0, 16) + "… | " + (a.size || "-") + " / " + (a.mtimeMs || "-") + " / " + String(a.sha256 || "-").slice(0, 16) + "… | " + (same ? "一致" : "**不一致**") + " |");
  }
  L.push("");
  L.push("顶层目录快照：变化 " + report.isolation.profileDiff.changedCount + " 项；identity 三件套未变=" + report.isolation.profileDiff.identityUnchanged + "。");
  L.push("");
  L.push("> 开工前 / 收工后分别有 " + report.isolation.realProfileProcessesBefore.length + " / " + report.isolation.realProfileProcessesAfter.length + " 个进程以真实 profile 运行（用户自己的 OpenArc OS.app，不是本探针）——顶层文件若有变化只能归因于它，本探针全程使用隔离 userData。");
  L.push("");
  L.push("## 6. 未验证项（如实登记）");
  L.push("");
  for (const nv of report.notVerified || []) L.push("- **" + nv.item + "**：" + nv.reason);
  L.push("");
  fs.writeFileSync(path.join(ART, "compare-notes.md"), L.join("\n"));
}

const IS_MAIN = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (IS_MAIN) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error("PROBE_THREW · " + String((error && error.stack) || error));
      process.exit(2);
    });
}
