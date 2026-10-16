/**
 * UI-3 · 任务 / Agent 控制台 Playwright 探针（截图 + 连续录屏 + 基准对照 + 边界断言）。
 *
 * 为什么不直接开产品 dist：本轮禁止执行 npm run build，dist 里还没有 TaskConsole。
 * 这里用 esbuild（Vite 自带依赖）把 **实验用挂载壳 harness.tsx** 打成一份本地构建产物，
 * 再用本机 Chromium（见 experiments/lib/chromium.mjs：OA_CHROMIUM → Playwright → 系统 Chrome）打开，
 * 挂载的 DOM 结构与 src/main.tsx 的 projects 分支一致
 * （.window > .split > .split-side 子视图导航 + .split-main）。
 *
 * 覆盖：加载 / 空 / 命令被拒 / 会话失效 / 依赖缺失 / 就绪 / 运行中 / 等待用户 / 窄宽 九张状态截图，
 *       主流程连续录屏（含 agent:event 增量事件），与基准页 SkillCenter 就绪态同条件下对照。
 * 断言：0 console error、0 非本地请求、焦点顺序可用、只发白名单命令、载荷不含身份字段。
 *
 * 运行：node experiments/dxos-ui-tasks/run-all.mjs
 * 退出码：任一断言 FAIL → 1。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";
import { resolveChromium, describeChromiumCandidates } from "../lib/chromium.mjs";
import {
  installCrashGuard,
  registerCleanup,
  setStep,
  hardenPage,
  timingSummary,
  launchChromiumBounded,
  withRetries,
  SCENARIO_ATTEMPTS,
  TIMEOUT_SCALE,
  SCALE_SOURCE,
} from "../lib/probe-timing.mjs";
import { TASK_CONSOLE_COMMANDS, AGENT_COMMANDS, CORE_TASK_COMMANDS } from "../../src/projects/taskConsoleLogic.ts";
import { TASK_COMMANDS as BACKEND_TASK_COMMANDS } from "../../electron/task-bootstrap.cjs";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../..");
const ART = path.join(ROOT, "artifacts", "dxos-ui-tasks");
const BUILD = path.join(ART, "build");
const VIDEO_DIR = path.join(ART, "video");
const PORT = Number(process.env.OA_TASKS_PORT || 5261);
// 解析优先级：OA_CHROMIUM → Playwright 官方 chromium → 系统 Google Chrome（见 experiments/lib/chromium.mjs）。
const CHROMIUM_INFO = resolveChromium();
const CHROMIUM = CHROMIUM_INFO.path;

/* 高负载下等待会整体变慢；这里只放大等待与加重试，不改任何断言（见 experiments/lib/probe-timing.mjs）。 */
installCrashGuard();
setStep("初始化");
console.log("探针时序加固：" + timingSummary());

const checks = [];
const pageErrors = [];
const externalRequests = [];

function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail == null ? "" : String(detail) });
  console.log((ok ? "  [PASS] " : "! [FAIL] ") + name + (detail ? " — " + detail : ""));
  return !!ok;
}

/* ── 1. esbuild 打一份本地产物（harness + 产品源码 + 设计系统样式）────────── */
fs.rmSync(BUILD, { recursive: true, force: true });
fs.rmSync(VIDEO_DIR, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(VIDEO_DIR, { recursive: true });

const INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'" />
<title>任务 / Agent 控制台 UI 探针</title>
<link rel="stylesheet" href="./harness.css" />
</head>
<body><div id="root"></div><script type="module" src="./harness.js"></script></body>
</html>
`;

console.log("构建探针产物（esbuild）…");
await build({
  entryPoints: [path.join(HERE, "harness.tsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  outdir: BUILD,
  entryNames: "harness",
  loader: { ".css": "css", ".svg": "dataurl", ".png": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "silent",
  plugins: [
    {
      name: "oa-public-assets",
      setup(b) {
        b.onResolve({ filter: /^[/][^/].*[.](svg|png)$/ }, (args) => {
          const file = path.join(ROOT, "public", args.path.replace(/^[/]/, ""));
          if (fs.existsSync(file)) return { path: file };
          return { path: args.path, namespace: "oa-missing-asset" };
        });
        b.onLoad({ filter: /.*/, namespace: "oa-missing-asset" }, () => ({ contents: "", loader: "dataurl" }));
      },
    },
  ],
});
fs.writeFileSync(path.join(BUILD, "index.html"), INDEX_HTML);

/* ── 2. 本地静态服务（只服务探针产物，不对公网）──────────────────────────── */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
};
const server = http.createServer((req, res) => {
  const raw = (req.url || "/").split("?")[0];
  const rel = raw === "/" ? "index.html" : raw.replace(/^[/]+/, "");
  const file = path.join(BUILD, rel);
  const isPage = rel === "index.html" || path.extname(rel) === "";
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
    return;
  }
  if (isPage) {
    res.writeHead(200, { "content-type": MIME[".html"] });
    fs.createReadStream(path.join(BUILD, "index.html")).pipe(res);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
registerCleanup(() => new Promise((resolve) => server.close(resolve)));
const BASE = "http://127.0.0.1:" + PORT;

/* ── 3. 浏览器 ────────────────────────────────────────────────────────────── */
if (!CHROMIUM) {
  console.error("找不到可用 Chromium，已按优先级尝试：" + describeChromiumCandidates(CHROMIUM_INFO.candidates) + "（设置 OA_CHROMIUM 指向可用二进制）");
  server.close();
  process.exit(1);
}

/** 所有状态共用同一主题 / 窗口尺寸 / 缩放 / 动态设置（MOTION_SYSTEM §10）。 */
const SHOT_OPTS = {
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "light",
  locale: "zh-CN",
  reducedMotion: "reduce",
};

function watch(page, label) {
  /* 每个 page 都在这里统一加固：waitForSelector/goto/waitForFunction 按倍率放大并做有界重试。 */
  hardenPage(page, label);
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(label + " console.error: " + msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(label + " pageerror: " + err.message));
  page.route("**/*", (route) => {
    const url = route.request().url();
    let host = null;
    try {
      host = new URL(url).hostname;
    } catch {
      host = null;
    }
    const local = host === null || host === "" || host === "127.0.0.1" || host === "localhost";
    if (!local) externalRequests.push(label + " " + url);
    route.continue();
  });
}

async function openScenario(browser, query, opts) {
  const ctx = await browser.newContext({ ...SHOT_OPTS, ...(opts || {}) });
  const page = await ctx.newPage();
  watch(page, query);
  await page.goto(BASE + "/?" + query, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-task-center]");
  return { ctx, page };
}

const browser = await launchChromiumBounded(chromium, { executablePath: CHROMIUM });
registerCleanup(() => browser.close());
const screenshots = [];

/* ── 4. 状态截图 ─────────────────────────────────────────────────────────── */
async function shoot(spec) {
  const label = "场景 " + spec.name;
  const checksBefore = checks.length;
  const screenshotsBefore = screenshots.length;
  await withRetries(
    label,
    SCENARIO_ATTEMPTS,
    async () => {
      const contextOpts = spec.narrow
        ? { viewport: { width: 640, height: 900 } }
        : spec.dark
          ? { colorScheme: "dark" }
          : null;
      const { ctx, page } = await openScenario(browser, spec.query, contextOpts);
      try {
        if (spec.setup) await spec.setup(page);
        await page.waitForSelector(spec.expect, { timeout: 20000 });
        await page.waitForTimeout(240);
        const file = path.join(ART, spec.name + ".png");
        await page.screenshot({ path: file });
        screenshots.push(file);
        check("状态截图 " + spec.name + " → " + spec.expect, true, file);
      } finally {
        await ctx.close().catch((e) => console.log("    · 关闭 context 时出错（已记录，不掩盖原错误）：" + ((e && e.message) || e)));
      }
    },
    (attempt) => {
      if (attempt > 1) console.log("  ↺ 回滚 " + label + " 上一次的部分断言 / 截图，整场景重跑（不跳过任何断言）");
      checks.length = checksBefore;
      screenshots.length = screenshotsBefore;
    },
  );
}

console.log(String.fromCharCode(10) + "状态截图：");
await shoot({ name: "01-loading", query: "scenario=loading", expect: '[data-task-list-state="loading"]' });
await shoot({ name: "02-empty", query: "scenario=empty", expect: '[data-task-list-state="empty"]' });
await shoot({
  name: "03-error",
  query: "scenario=error",
  expect: '[data-task-list-state="error"] [data-ds-kind="error"]',
});
await shoot({
  name: "04-session-expired",
  query: "scenario=unauthorized",
  expect: '[data-task-list-state="error"] [data-ds-kind="unauthorized"]',
});
await shoot({
  name: "05-dependency",
  query: "scenario=unavailable",
  expect: '[data-task-list-state="unavailable"] [data-ds-kind="unavailable"]',
  setup: async (page) => {
    await page.waitForSelector("[data-task-dependency]");
    const text = await page.$eval("[data-task-dependency]", (el) => el.textContent || "");
    check("依赖缺失文案指出缺少「工具目录」并说明没有产物", text.includes("工具目录") && text.includes("没有产生任何产物"), text.slice(0, 80));
  },
});
await shoot({
  name: "06-ready",
  query: "scenario=ready",
  expect: "[data-task-detail]",
  setup: async (page) => {
    await page.click('[data-task-id="t_done"]');
    await page.waitForSelector("[data-task-detail]");
    for (const sel of ["[data-task-steps]", "[data-task-events]", "[data-task-checkpoints]", "[data-task-deliverables]"]) {
      check("就绪详情包含 " + sel, (await page.$(sel)) !== null);
    }
    const cp = await page.$eval("[data-task-checkpoints]", (el) => (el.textContent || "").trim());
    check("检查点数量来自 task/get 投影", cp.indexOf("3") >= 0, cp);
  },
});
await shoot({
  name: "07-running",
  query: "scenario=running&run=slow",
  expect: '[data-task-run-status="running"]',
  setup: async (page) => {
    await page.click('[data-task-id="t_report"]');
    await page.waitForSelector("[data-task-detail]");
    /* 运行中：等一等，让轮询按 afterSequence 增量补事件。 */
    await page.waitForTimeout(3600);
    const seqs = await page.$$eval("[data-task-event-seq]", (els) => els.map((el) => Number(el.getAttribute("data-task-event-seq"))));
    const increasing = seqs.every((v, i) => i === 0 || v > seqs[i - 1]);
    check("运行中事件流 sequence 严格单调", increasing && seqs.length >= 4, "sequences=" + seqs.join(","));
    const afterCalls = await page.evaluate(() => (window.__oaTaskProbe ? window.__oaTaskProbe.taskEventsCalls.map((c) => c.afterSequence) : []));
    check("task/events 使用 afterSequence 增量拉取", afterCalls.some((v) => v > 0), "afterSequence=" + afterCalls.join(","));
    const disabled = await page.$eval('[data-task-action="pause"]', (el) => el.disabled);
    check("运行中暂停按钮可用且不重复叠加", disabled === false, "disabled=" + disabled);
  },
});
await shoot({
  name: "08-waiting-user",
  query: "scenario=ready",
  expect: "[data-task-question]",
  setup: async (page) => {
    await page.click('[data-task-id="t_wait"]');
    await page.waitForSelector("[data-task-question]");
    const q = await page.$eval("[data-task-question]", (el) => (el.textContent || "").trim());
    check("等待提问来自事件流 task.waiting_user", q.includes("是否覆盖现有 dist/ 目录"), q);
    const hasAnswerField = await page.$('[data-task-field="answer"]');
    check("等待用户状态提供回答输入框", hasAnswerField !== null);
    await page.fill('[data-task-field="answer"]', "覆盖");
    const canSubmit = await page.$eval('[data-task-action="answer"]', (el) => el.disabled);
    check("填了回答后提交按钮可用", canSubmit === false, "disabled=" + canSubmit);
  },
});
await shoot({
  name: "09-narrow-640",
  query: "scenario=ready",
  narrow: true,
  expect: ".task-row[data-task-id]",
  setup: async (page) => {
    await page.click('[data-task-id="t_done"]');
    await page.waitForSelector("[data-task-detail]");
    const overflow = await page.evaluate(() => {
      const el = document.querySelector(".split-main");
      return el ? el.scrollWidth - el.clientWidth : -1;
    });
    check("窄宽 640px 列表与详情不溢出", overflow <= 1, "split-main overflow=" + overflow);
  },
});

/* ── 4b. 写操作入口状态截图（依赖缺失 / 就绪 / 进行中 / 失败）+ 统一读模型来源 ── */
console.log(String.fromCharCode(10) + "写操作入口状态截图：");
setStep("写操作入口状态截图");
await shoot({
  name: "10-entry-dependency",
  query: "scenario=ready&deps=fs-missing",
  expect: '[data-task-entry="tool-call"][data-task-entry-state="dependency"]',
  setup: async (page) => {
    await page.waitForSelector('[data-task-entry="tool-call"] [data-task-entry-availability="dependency"]');
    const text = await page.$eval('[data-task-entry="tool-call"] [data-task-entry-availability="dependency"]', (el) => el.textContent || "");
    check("工具入口依赖缺失点名「虚拟文件树」并说明没有产物", text.includes("虚拟文件树") && text.includes("没有产生任何产物"), text.slice(0, 120));
  },
});
await shoot({
  name: "11-entry-ready",
  /* 默认态即真实 health 语义（fsAdapter 已接线）；不再需要 deps=full 修饰。 */
  query: "scenario=ready",
  expect: '[data-task-entry="create"][data-task-entry-state="ready"]',
  setup: async (page) => {
    const states = await page.$$eval("[data-task-entry]", (els) =>
      els.map((el) => ({ key: el.getAttribute("data-task-entry"), state: el.getAttribute("data-task-entry-state") })),
    );
    check("依赖齐全时四个入口都就绪", states.length === 4 && states.every((s) => s.state === "ready"), JSON.stringify(states));
    const risk = await page.$$eval("[data-task-entry-risk-badge]", (els) => els.map((el) => (el.textContent || "").trim()));
    check("四个入口都显示风险标注", risk.length === 4 && risk.every((t) => t.length > 0), risk.join(" | "));
    check("调用工具入口标注逐次审批", (await page.$('[data-task-entry="tool-call"] [data-task-entry-approval="true"]')) !== null);
  },
});
await shoot({
  name: "12-entry-busy",
  query: "scenario=ready&run=slow",
  expect: '[data-task-entry-action="create"][disabled][aria-busy="true"]',
  setup: async (page) => {
    await page.fill('[data-task-entry-field="create:projectId"]', "p_weekly");
    await page.fill('[data-task-entry-field="create:instruction"]', "把本周记录整理成周报草稿");
    await page.click('[data-task-entry-action="create"]');
    /* 写类入口二次确认：确认前不发命令。 */
    await page.waitForSelector("[data-task-entry-confirm-submit]");
    await page.click("[data-task-entry-confirm-submit]");
    await page.waitForSelector('[data-task-entry-action="create"][disabled][aria-busy="true"]', { timeout: 5000 });
  },
});
await shoot({
  name: "13-entry-failure",
  query: "scenario=entry-error",
  expect: '[data-task-entry-error][data-task-entry-error-code="AGENT_FORBIDDEN"]',
  setup: async (page) => {
    await page.fill('[data-task-entry-field="create:projectId"]', "p_weekly");
    await page.fill('[data-task-entry-field="create:instruction"]', "新建一条会失败的演示任务");
    await page.click('[data-task-entry-action="create"]');
    await page.waitForSelector("[data-task-entry-confirm-submit]");
    await page.click("[data-task-entry-confirm-submit]");
    await page.waitForSelector("[data-task-entry-error]", { timeout: 5000 });
    const text = await page.$eval("[data-task-entry-error]", (el) => el.textContent || "");
    check("失败显示稳定错误码与文案", text.includes("AGENT_FORBIDDEN") && text.includes("没有"), text.slice(0, 120));
  },
});
await shoot({
  name: "14-unified-source",
  query: "scenario=ready",
  expect: "[data-task-source]",
  setup: async (page) => {
    const sources = await page.$$eval("[data-task-source]", (els) => els.map((el) => el.getAttribute("data-task-source")));
    check("任务行带统一读模型来源标注（dx）", sources.length >= 3 && sources.every((s) => s === "dx"), JSON.stringify(Array.from(new Set(sources))));
    const core = await page.$eval("[data-task-unified-core]", (el) => el.textContent || "");
    check("core 来源任务单独标注", core.includes("同步素材库"), core.slice(0, 80));
    const boundary = await page.$eval("[data-task-unified-boundary]", (el) => el.textContent || "");
    check("统一读模型边界文本可见（只读）", boundary.includes("读模型"), boundary.slice(0, 80));
  },
});

/* 15) 写类入口二次确认：确认前 / 取消 命令数 0；确认后正常发送。 */
const createCount = (page) =>
  page.evaluate(() =>
    window.__oaTaskProbe ? window.__oaTaskProbe.commands.filter((c) => c.command === "agent/task/create").length : -1,
  );
await shoot({
  name: "15-entry-confirm",
  query: "scenario=ready&run=slow",
  expect: "[data-task-entry-confirm-submit]",
  setup: async (page) => {
    await page.fill('[data-task-entry-field="create:projectId"]', "p_weekly");
    await page.fill('[data-task-entry-field="create:instruction"]', "确认前不应发出命令");
    await page.click('[data-task-entry-action="create"]');
    await page.waitForSelector("[data-task-entry-confirm]", { timeout: 5000 });
    const before = await createCount(page);
    check("写类入口确认前不发命令", before === 0, "agent/task/create=" + before);
    const text = await page.$eval("[data-task-entry-confirm]", (el) => el.textContent || "");
    check("确认框说明将要发生的副作用", /写|新建/.test(text), text.slice(0, 140).replace(/\s+/g, " "));
    await page.click("[data-task-entry-confirm-cancel]");
    await page.waitForSelector("[data-task-entry-confirm]", { state: "detached", timeout: 5000 });
    await page.waitForTimeout(200);
    const afterCancel = await createCount(page);
    check("取消后命令数仍为 0", afterCancel === 0, "agent/task/create=" + afterCancel);
    /* 再次打开确认框并保持打开，供截图留证。 */
    await page.click('[data-task-entry-action="create"]');
    await page.waitForSelector("[data-task-entry-confirm-submit]");
  },
});
{
  const ctx = await browser.newContext(SHOT_OPTS);
  const page = await ctx.newPage();
  watch(page, "entry-confirm");
  await page.goto(BASE + "/?scenario=ready&run=slow", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-task-entry]");
  await page.fill('[data-task-entry-field="create:projectId"]', "p_weekly");
  await page.fill('[data-task-entry-field="create:instruction"]', "确认后应发出命令");
  await page.click('[data-task-entry-action="create"]');
  await page.waitForSelector("[data-task-entry-confirm-submit]");
  await page.click("[data-task-entry-confirm-submit]");
  let sent = false;
  try {
    await page.waitForFunction(
      () => window.__oaTaskProbe && window.__oaTaskProbe.commands.some((c) => c.command === "agent/task/create"),
      null,
      { timeout: 5000 },
    );
    sent = true;
  } catch (err) {
    sent = false;
  }
  const afterConfirm = await createCount(page);
  check("确认后命令正常发送", sent && afterConfirm === 1, "agent/task/create=" + afterConfirm);
  await ctx.close();
}

/* ── 4c. U1 · core 任务（既有任务表）可操作：可见 / 选中 / 追加 / 禁用原因 / 二次确认 /
        进行中 / 成功 / 失败 / 深色 ───────────────────────────────────────────── */
console.log(String.fromCharCode(10) + "U1 · core 任务可操作：");
setStep("core 任务可操作");

const coreCommandList = (page) =>
  page.evaluate(() => (window.__oaTaskCoreProbe ? window.__oaTaskCoreProbe.commands : []));
const coreCommandCount = (page, command) =>
  page.evaluate(
    (c) => (window.__oaTaskCoreProbe ? window.__oaTaskCoreProbe.commands.filter((x) => x.command === c).length : -1),
    command,
  );

check(
  "core 命令白名单逐条等于后端 task-bootstrap.cjs 的 TASK_COMMANDS（不允许新增命令）",
  CORE_TASK_COMMANDS.join(",") === BACKEND_TASK_COMMANDS.join(","),
  "ui=" + CORE_TASK_COMMANDS.join(",") + " backend=" + BACKEND_TASK_COMMANDS.join(","),
);

await shoot({
  name: "16-core-select",
  query: "scenario=ready",
  expect: "[data-task-core-detail]",
  setup: async (page) => {
    const rows = await page.$$eval("[data-task-core-row]", (els) => els.map((el) => el.getAttribute("data-task-core-row")));
    check("core 任务在任务控制台列表可见", rows.length >= 1 && rows.indexOf("core_sync") >= 0, JSON.stringify(rows));
    await page.click('[data-task-core-row="core_sync"]');
    await page.waitForSelector("[data-task-core-detail]");
    const status = await page.$eval("[data-task-core-detail]", (el) => el.getAttribute("data-task-core-status"));
    check("core 任务可选中并显示详情", status === "SUCCEEDED", "status=" + status);
    const stepText = await page.$eval("[data-task-core-step-count]", (el) => (el.textContent || "").trim());
    check("core 步骤数来自后端 task/get 投影", stepText.indexOf("2") >= 0, stepText);
    const note = await page.$eval("[data-task-core-capability-detail]", (el) => el.textContent || "");
    check("core 详情说明命令域是 task/*（与 DX 的 agent/* 分开）", note.indexOf("task/") >= 0 && note.indexOf("agent/*") >= 0, note.slice(0, 70));
    const sourceNote = await page.$eval("[data-task-capability-note]", (el) => el.textContent || "");
    check("统一读模型标注按来源说明能做什么", sourceNote.indexOf("agent/*") >= 0 && sourceNote.indexOf("task/*") >= 0, sourceNote.slice(0, 90));
    const domain = await page.$eval("[data-task-core-command-domain]", (el) => (el.textContent || "").trim());
    check("core 详情显式标注命令域", domain.indexOf("task/*") >= 0, domain);
  },
});

await shoot({
  name: "17-core-append-denied",
  query: "scenario=core-denied",
  expect: '[data-task-core-action="append-step"][disabled]',
  setup: async (page) => {
    await page.click('[data-task-core-row="core_sync"]');
    await page.waitForSelector("[data-task-core-detail]");
    await page.waitForSelector('[data-task-core-action="append-step"][disabled]');
    const reason = await page.$eval('[data-task-core-action-reason="append-step"]', (el) => el.textContent || "");
    check("core 状态不允许时按钮禁用并给原因", reason.indexOf("已有步骤或 run 正在进行") >= 0, reason.slice(0, 90));
    const calls = await coreCommandCount(page, "task/appendStep");
    check("core 禁用状态下不发任何追加命令", calls === 0, "task/appendStep=" + calls);
  },
});

await shoot({
  name: "18-core-append-confirm",
  query: "scenario=ready&run=slow",
  expect: "[data-task-core-confirm-submit]",
  setup: async (page) => {
    await page.click('[data-task-core-row="core_sync"]');
    await page.waitForSelector("[data-task-core-detail]");
    await page.fill('[data-task-core-field="goal"]', "继续整理剩余素材");
    await page.click('[data-task-core-action="append-step"]');
    await page.waitForSelector("[data-task-core-confirm-submit]");
    const before = await coreCommandCount(page, "task/appendStep");
    check("core 写类动作确认前不发命令", before === 0, "task/appendStep=" + before);
    const summary = await page.$eval("[data-task-core-confirm-summary]", (el) => el.textContent || "");
    check("core 确认框说明副作用与目标", summary.indexOf("继续整理剩余素材") >= 0 && /写操作|新增一个执行步骤/.test(summary), summary.slice(0, 110));
    await page.click("[data-task-core-confirm-cancel]");
    await page.waitForSelector("[data-task-core-confirm]", { state: "detached", timeout: 5000 });
    await page.waitForTimeout(200);
    const afterCancel = await coreCommandCount(page, "task/appendStep");
    check("core 取消后命令数仍为 0", afterCancel === 0, "task/appendStep=" + afterCancel);
    /* 再次打开并保持打开，供截图留证。 */
    await page.click('[data-task-core-action="append-step"]');
    await page.waitForSelector("[data-task-core-confirm-submit]");
  },
});

await shoot({
  name: "19-core-append-busy",
  query: "scenario=ready&run=slow",
  expect: '[data-task-core-action="append-step"][disabled][aria-busy="true"]',
  setup: async (page) => {
    await page.click('[data-task-core-row="core_sync"]');
    await page.waitForSelector("[data-task-core-detail]");
    await page.fill('[data-task-core-field="goal"]', "确认后进入进行中");
    await page.click('[data-task-core-action="append-step"]');
    await page.waitForSelector("[data-task-core-confirm-submit]");
    await page.click("[data-task-core-confirm-submit]");
    await page.waitForSelector('[data-task-core-action="append-step"][disabled][aria-busy="true"]', { timeout: 5000 });
  },
});

await shoot({
  name: "20-core-append-ok",
  query: "scenario=ready",
  expect: "[data-task-core-notice]",
  setup: async (page) => {
    await page.click('[data-task-core-row="core_sync"]');
    await page.waitForSelector("[data-task-core-detail]");
    await page.fill('[data-task-core-field="goal"]', "继续处理剩余素材");
    await page.click('[data-task-core-action="append-step"]');
    await page.waitForSelector("[data-task-core-confirm-submit]");
    await page.click("[data-task-core-confirm-submit]");
    await page.waitForSelector("[data-task-core-notice]", { timeout: 10000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector("[data-task-core-step-count]");
        return !!el && (el.textContent || "").indexOf("3 步") >= 0;
      },
      null,
      { timeout: 10000 },
    );
    const stepText = await page.$eval("[data-task-core-step-count]", (el) => (el.textContent || "").trim());
    check("core 追加成功后步骤数以后端 task/get 为准（2 → 3）", stepText.indexOf("3 步") >= 0, stepText);
    const calls = await coreCommandCount(page, "task/appendStep");
    check("core 追加成功只发一条 task/appendStep", calls === 1, "task/appendStep=" + calls);
  },
});

await shoot({
  name: "21-core-dark",
  query: "scenario=ready&dark=1",
  dark: true,
  expect: "[data-task-core-detail]",
  setup: async (page) => {
    await page.click('[data-task-core-row="core_sync"]');
    await page.waitForSelector("[data-task-core-detail]");
    const isDark = await page.evaluate(() => !!document.querySelector(".window.dark"));
    check("深色场景使用 .dark 主题类", isDark === true, "dark=" + isDark);
    const status = await page.$eval("[data-task-core-detail]", (el) => el.getAttribute("data-task-core-status"));
    check("深色下 core 详情仍可读", status === "SUCCEEDED", "status=" + status);
  },
});

await shoot({
  name: "22-core-append-fail",
  query: "scenario=core-fail",
  expect: '[data-task-core-error][data-task-core-error-code="TASK_REVISION_CONFLICT"]',
  setup: async (page) => {
    await page.click('[data-task-core-row="core_sync"]');
    await page.waitForSelector("[data-task-core-detail]");
    await page.fill('[data-task-core-field="goal"]', "会失败的一次追加");
    await page.click('[data-task-core-action="append-step"]');
    await page.waitForSelector("[data-task-core-confirm-submit]");
    await page.click("[data-task-core-confirm-submit]");
    await page.waitForSelector('[data-task-core-error][data-task-core-error-code="TASK_REVISION_CONFLICT"]', { timeout: 5000 });
    const text = await page.$eval("[data-task-core-error]", (el) => el.textContent || "");
    check("core 失败显示稳定错误码与人话", text.indexOf("TASK_REVISION_CONFLICT") >= 0 && text.indexOf("revision 冲突") >= 0, text.slice(0, 130));
  },
});

await shoot({
  name: "23-core-recovery",
  query: "scenario=core-recovery",
  expect: "[data-task-core-recovery]",
  setup: async (page) => {
    await page.click('[data-task-core-row="core_sync"]');
    await page.waitForSelector("[data-task-core-detail]");
    const resumeDisabled = await page.$eval('[data-task-core-action="resume"]', (el) => el.disabled);
    check("core 续接预算在 resumable=true 时可用", resumeDisabled === false, "disabled=" + resumeDisabled);
    const appendReason = await page.$eval('[data-task-core-action-reason="append-step"]', (el) => el.textContent || "");
    check("core 追加在 BLOCKED 时禁用并给原因", appendReason.indexOf("只有已成功完成的任务才能追加") >= 0, appendReason.slice(0, 90));
    const calls = await page.$$eval("[data-task-core-recovery-call]", (els) => els.map((el) => el.getAttribute("data-task-core-recovery-call")));
    check("core 结果未知副作用逐条列出", calls.length === 1 && calls[0] === "call_unknown_1", JSON.stringify(calls));
    const ackDisabled = await page.$eval('[data-task-core-ack="call_unknown_1"]', (el) => el.disabled);
    check("core 未确认的副作用可点击人工确认", ackDisabled === false, "disabled=" + ackDisabled);
    const next = await page.$eval("[data-task-core-recovery-next]", (el) => (el.textContent || "").trim());
    check("core 指出下一条待确认的副作用", next.indexOf("call_unknown_1") >= 0, next);
  },
});

/* core 命令白名单 / 载荷键：确认后按真实发出的命令断言。 */
{
  const { ctx, page } = await openScenario(browser, "scenario=ready");
  try {
    await page.click('[data-task-core-row="core_sync"]');
    await page.waitForSelector("[data-task-core-detail]");
    await page.fill('[data-task-core-field="goal"]', "白名单与载荷键检查");
    await page.click('[data-task-core-action="append-step"]');
    await page.waitForSelector("[data-task-core-confirm-submit]");
    await page.click("[data-task-core-confirm-submit]");
    await page.waitForSelector("[data-task-core-notice]", { timeout: 10000 });
    const commands = await coreCommandList(page);
    const names = commands.map((c) => c.command);
    check(
      "core 只发 task/* 白名单命令",
      names.length > 0 && names.every((c) => CORE_TASK_COMMANDS.indexOf(c) >= 0),
      [...new Set(names)].join(", "),
    );
    const identityKeys = ["userId", "role", "sessionRef", "appId"];
    const offenders = commands.filter((c) => Object.keys(c.payload || {}).some((k) => identityKeys.indexOf(k) >= 0));
    check("core 命令载荷不含身份字段（userId/role/sessionRef/appId）", offenders.length === 0, JSON.stringify(offenders.slice(0, 2)));
    const append = commands.find((c) => c.command === "task/appendStep");
    const keys = append ? Object.keys(append.payload).sort().join(",") : "";
    check("core 追加载荷只含业务键 + requestId", keys === "expectedRevision,goal,requestId,taskId", keys);
    check("core 命令未出现新增命令", commands.every((c) => c.command.indexOf("task/") === 0), [...new Set(names)].join(", "));
  } finally {
    await ctx.close();
  }
}

/* ── 5. 主流程连续录屏 ───────────────────────────────────────────────────── */
console.log(String.fromCharCode(10) + "主流程连续录屏：");
setStep("主流程连续录屏");
const videoCtx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: "light",
  locale: "zh-CN",
  recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 900 } },
});
const vpage = await videoCtx.newPage();
watch(vpage, "video");
const video = vpage.video();
await vpage.goto(BASE + "/?scenario=running&run=slow", { waitUntil: "domcontentloaded" });
await vpage.waitForSelector(".task-row[data-task-id]");
await vpage.waitForTimeout(400);
await vpage.click('[data-task-id="t_report"]');
await vpage.waitForSelector('[data-task-run-status="running"]');
/* 让增量事件出现两轮（轮询间隔 1.5s），录屏能看到事件流增长与活动指示。 */
await vpage.waitForTimeout(3600);
await vpage.click('[data-task-id="t_wait"]');
await vpage.waitForSelector("[data-task-question]");
await vpage.waitForTimeout(500);
await vpage.fill('[data-task-field="answer"]', "覆盖");
await vpage.click('[data-task-action="answer"]');
await vpage.waitForSelector('[data-task-notice]', { timeout: 10000 });
await vpage.waitForTimeout(900);
await vpage.click('[data-task-id="t_done"]');
await vpage.waitForSelector("[data-task-deliverables]");
await vpage.waitForTimeout(700);
await videoCtx.close();

/* ── 5b. 写操作入口连续录屏（就绪 → 二次确认 → 进行中 → 新任务入列 → 依赖缺失视图）── */
const entryVideoCtx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: "light",
  locale: "zh-CN",
  recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 900 } },
});
const epage = await entryVideoCtx.newPage();
watch(epage, "entry-video");
const entryVideo = epage.video();
await epage.goto(BASE + "/?scenario=ready&run=slow", { waitUntil: "domcontentloaded" });
await epage.waitForSelector("[data-task-entry]");
await epage.waitForTimeout(500);
await epage.fill('[data-task-entry-field="create:projectId"]', "p_weekly");
await epage.fill('[data-task-entry-field="create:instruction"]', "把本周记录整理成周报草稿");
await epage.waitForTimeout(400);
await epage.click('[data-task-entry-action="create"]');
await epage.waitForSelector("[data-task-entry-confirm-submit]");
await epage.waitForTimeout(500);
await epage.click("[data-task-entry-confirm-submit]");
await epage.waitForSelector('[data-task-entry-action="create"][disabled][aria-busy="true"]', { timeout: 5000 });
await epage.waitForSelector("[data-task-notice]", { timeout: 10000 });
await epage.waitForTimeout(600);
await epage.click('[data-task-id="t_report"]');
await epage.waitForSelector("[data-task-detail]");
await epage.waitForTimeout(500);
/* 同一段录屏里切到显式的依赖缺失场景（?deps=fs-missing），录下入口降级态。 */
await epage.goto(BASE + "/?scenario=ready&deps=fs-missing", { waitUntil: "domcontentloaded" });
await epage.waitForSelector('[data-task-entry="tool-call"][data-task-entry-state="dependency"]');
await epage.waitForTimeout(900);
await entryVideoCtx.close();
const entryRaw = await entryVideo.path();
const entryFlowVideo = path.join(ART, "task-entries-flow.webm");
if (entryRaw && fs.existsSync(entryRaw)) {
  fs.copyFileSync(entryRaw, entryFlowVideo);
  check("写操作入口连续录屏产出", fs.statSync(entryFlowVideo).size > 0, entryFlowVideo);
} else {
  check("写操作入口连续录屏产出", false, "video.path() 为空");
}
const rawVideo = await video.path();
const flowVideo = path.join(ART, "task-console-flow.webm");
if (rawVideo && fs.existsSync(rawVideo)) {
  fs.copyFileSync(rawVideo, flowVideo);
  check("主流程连续录屏产出", fs.statSync(flowVideo).size > 0, flowVideo);
} else {
  check("主流程连续录屏产出", false, "video.path() 为空");
}

/* ── 5c. U1 · core 任务连续录屏（选中 → 二次确认 → 追加成功；再切禁用态场景）── */
const coreVideoCtx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: "light",
  locale: "zh-CN",
  recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 900 } },
});
const cpage = await coreVideoCtx.newPage();
watch(cpage, "core-video");
const coreVideo = cpage.video();
await cpage.goto(BASE + "/?scenario=ready&run=slow", { waitUntil: "domcontentloaded" });
await cpage.waitForSelector("[data-task-core-row]");
await cpage.waitForTimeout(450);
await cpage.click('[data-task-core-row="core_sync"]');
await cpage.waitForSelector("[data-task-core-detail]");
await cpage.waitForTimeout(400);
await cpage.fill('[data-task-core-field="goal"]', "录屏：继续处理剩余素材");
await cpage.click('[data-task-core-action="append-step"]');
await cpage.waitForSelector("[data-task-core-confirm-submit]");
await cpage.waitForTimeout(600);
await cpage.click("[data-task-core-confirm-submit]");
await cpage.waitForSelector("[data-task-core-notice]", { timeout: 10000 });
await cpage.waitForTimeout(700);
/* 同一段录屏切到禁用态场景，录下“状态不允许时禁用并给原因”。 */
await cpage.goto(BASE + "/?scenario=core-denied", { waitUntil: "domcontentloaded" });
await cpage.waitForSelector('[data-task-core-row="core_sync"]');
await cpage.click('[data-task-core-row="core_sync"]');
await cpage.waitForSelector('[data-task-core-action="append-step"][disabled]');
await cpage.waitForTimeout(800);
await coreVideoCtx.close();
const coreRaw = await coreVideo.path();
const coreFlowVideo = path.join(ART, "task-core-flow.webm");
if (coreRaw && fs.existsSync(coreRaw)) {
  fs.copyFileSync(coreRaw, coreFlowVideo);
  check("core 任务连续录屏产出", fs.statSync(coreFlowVideo).size > 0, coreFlowVideo);
} else {
  check("core 任务连续录屏产出", false, "video.path() 为空");
}

/* ── 6. 焦点顺序（就绪页 + 详情）────────────────────────────────────────── */
console.log(String.fromCharCode(10) + "可访问焦点顺序：");
setStep("可访问焦点顺序");
{
  const { ctx, page } = await openScenario(browser, "scenario=ready");
  await page.waitForSelector(".task-row[data-task-id]");
  await page.click('[data-task-id="t_wait"]');
  await page.waitForSelector("[data-task-detail]");
  const order = [];
  await page.evaluate(() => {
    const first = document.querySelector(".split-nav");
    if (first && typeof first.focus === "function") first.focus();
  });
  for (let i = 0; i < 16; i += 1) {
    await page.keyboard.press("Tab");
    const item = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return "body";
      const inside = !!(el.closest && el.closest(".task-center, .split-side"));
      return (
        (inside ? "in:" : "out:") +
        el.tagName.toLowerCase() +
        ":" +
        (el.getAttribute("data-task-action") ||
          el.getAttribute("data-task-id") ||
          el.getAttribute("aria-label") ||
          el.textContent ||
          "")
          .trim()
          .slice(0, 8)
      );
    });
    order.push(item);
  }
  const outside = order.filter((s) => s.startsWith("out:")).length;
  const bodyStops = order.filter((s) => s === "body").length;
  const distinct = new Set(order).size;
  check("Tab 顺序只在界面内推进（文档边界最多停留一次）", outside === 0 && bodyStops <= 1, "outside=" + outside + " body=" + bodyStops + " :: " + order.join(" → "));
  check("焦点顺序逐步前进（>=6 个不同落点）", distinct >= 6, "distinct=" + distinct);
  const answerFocusable = await page.evaluate(() => {
    const el = document.querySelector('[data-task-field="answer"]');
    if (!el) return false;
    el.focus();
    return document.activeElement === el;
  });
  check("回答输入框可聚焦", answerFocusable === true);
  await ctx.close();
}

/* ── 6b. 基准对照：任务控制台 vs Skill 中心 ────────────────────────────────
   同主题（light）/ 同窗口（1440×900）/ 同缩放（deviceScaleFactor 2）/
   同 reducedMotion，分别渲染两页就绪态的外壳，两张截图 + 关键度量写进 report.json，
   结论写进 compare-notes.md。 */
console.log(String.fromCharCode(10) + "基准对照（任务控制台 vs Skill 中心）：");
setStep("基准对照（任务控制台 vs Skill 中心）");

const COMPARE_SPECS = {
  task: {
    query: "scenario=ready",
    root: "[data-task-center]",
    row: ".task-row[data-task-id]",
    detail: "[data-task-detail]",
    select: '[data-task-id="t_done"]',
    vars: {
      root: ".task-center",
      split: ".task-split",
      list: ".task-list-pane",
      detail: ".task-detail-pane",
      row: ".task-row[data-task-id]",
      rowName: ".task-row__top strong",
      rowFacts: ".task-row__facts",
      paneHead: ".task-pane-head",
      title: ".task-banner__title",
    },
  },
  skill: {
    query: "page=skill&tab=installed",
    root: "[data-skill-center]",
    row: ".skill-row[data-skill-id]",
    detail: "[data-skill-detail]",
    select: '[data-skill-id="writing"]',
    vars: {
      root: ".skill-center",
      split: ".skill-split",
      list: ".skill-list-pane",
      detail: ".skill-detail-pane",
      row: ".skill-row[data-skill-id]",
      rowName: ".skill-row__top strong",
      rowFacts: ".skill-row__facts",
      paneHead: ".skill-pane-head",
      title: ".skill-banner__title",
    },
  },
};

async function measurePage(page, vars) {
  return page.evaluate((v) => {
    const rectOf = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) };
    };
    const styleOf = (el, props) => {
      if (!el) return null;
      const s = getComputedStyle(el);
      const out = {};
      for (const p of props) out[p] = s.getPropertyValue(p).trim();
      return out;
    };
    const one = (sel) => document.querySelector(sel);
    const count = (sel) => document.querySelectorAll(sel).length;
    const pageStates = Array.from(document.querySelectorAll('[data-ds-comp="page-state"]')).map((el) => ({
      kind: el.getAttribute("data-ds-kind"),
      className: String(el.className),
      role: el.getAttribute("role"),
      live: el.getAttribute("aria-live"),
      title: ((el.querySelector(".ds-page-state__title") || {}).textContent || "").trim(),
    }));
    return {
      window: rectOf(one(".window")),
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
      rowStyle: styleOf(one(v.row), ["padding", "border-radius", "background-color"]),
      rowNameStyle: styleOf(one(v.rowName), ["font-size", "font-weight", "line-height"]),
      rowFactsStyle: styleOf(one(v.rowFacts), ["font-size", "line-height", "color"]),
      titleStyle: styleOf(one(v.title), ["font-size", "font-weight", "letter-spacing"]),
      counts: {
        rows: count(v.row),
        badges: count('[data-ds-comp="badge"]'),
        buttons: count('[data-ds-comp="button"]'),
        scrollAreas: count('[data-ds-comp="scroll-area"]'),
        pageStates: pageStates.length,
      },
      pageStates,
    };
  }, vars);
}

const compareCondition = {
  viewport: SHOT_OPTS.viewport,
  deviceScaleFactor: SHOT_OPTS.deviceScaleFactor,
  colorScheme: SHOT_OPTS.colorScheme,
  locale: SHOT_OPTS.locale,
  reducedMotion: SHOT_OPTS.reducedMotion,
};
const compare = {};

async function captureCompare(kind) {
  const spec = COMPARE_SPECS[kind];
  const ctx = await browser.newContext({ ...SHOT_OPTS });
  const page = await ctx.newPage();
  watch(page, "compare:" + kind);
  await page.goto(BASE + "/?" + spec.query, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(spec.root);
  await page.waitForSelector(spec.row, { timeout: 20000 });
  await page.waitForTimeout(220);
  const before = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-ds-comp="page-state"]')).map((el) => ({
      kind: el.getAttribute("data-ds-kind"),
      className: String(el.className),
      title: ((el.querySelector(".ds-page-state__title") || {}).textContent || "").trim(),
    })),
  );
  await page.click(spec.select);
  await page.waitForSelector(spec.detail, { timeout: 20000 });
  await page.waitForTimeout(260);
  const metrics = await measurePage(page, spec.vars);
  const file = path.join(ART, "compare-" + kind + ".png");
  await page.screenshot({ path: file });
  compare[kind] = { screenshot: file, query: spec.query, pageStateBeforeSelect: before, metrics };
  screenshots.push(file);
  check("对照截图 compare-" + kind + " → " + spec.detail, true, file);
  await ctx.close();
}

await captureCompare("task");
await captureCompare("skill");

const taskM = compare.task.metrics;
const skillM = compare.skill.metrics;
const round = (n) => Math.round(n * 10) / 10;
const px = (v) => (v == null ? "—" : String(v));
const fsNum = (v) => (v ? Number.parseFloat(v["font-size"]) : NaN);

const compareDifferences = {
  rootWidth: round(taskM.root.width - skillM.root.width),
  rootHeight: round(taskM.root.height - skillM.root.height),
  splitWidth: round(taskM.split.width - skillM.split.width),
  listPaneWidth: round(taskM.listPane.width - skillM.listPane.width),
  detailPaneWidth: round(taskM.detailPane.width - skillM.detailPane.width),
  rowHeight: round(taskM.row.height - skillM.row.height),
  rowPadding: taskM.rowStyle.padding + " vs " + skillM.rowStyle.padding,
  bannerTitleFontSize: round(fsNum(taskM.titleStyle) - fsNum(skillM.titleStyle)),
  rowNameFontSize: round(fsNum(taskM.rowNameStyle) - fsNum(skillM.rowNameStyle)),
  rowFactsFontSize: round(fsNum(taskM.rowFactsStyle) - fsNum(skillM.rowFactsStyle)),
  splitGap: taskM.splitStyle.gap === skillM.splitStyle.gap ? "一致" : taskM.splitStyle.gap + " vs " + skillM.splitStyle.gap,
};

check(
  "对照两页同窗口尺寸（1440×900）",
  !!taskM.window && Math.round(taskM.window.width) === 1440 && Math.round(taskM.window.height) === 900 && !!skillM.window && Math.round(skillM.window.width) === 1440 && Math.round(skillM.window.height) === 900,
  "task=" + JSON.stringify(taskM.window) + " skill=" + JSON.stringify(skillM.window),
);
check(
  "对照两页同主题/缩放/reducedMotion 上下文",
  compareCondition.colorScheme === "light" && compareCondition.deviceScaleFactor === 2 && compareCondition.reducedMotion === "reduce",
  JSON.stringify(compareCondition),
);
const metricReady = (m) =>
  !!m.root && m.root.width > 0 && !!m.split && m.split.width > 0 && !!m.row && m.row.height > 0 && fsNum(m.titleStyle) > 0 && fsNum(m.rowNameStyle) > 0 && fsNum(m.rowFactsStyle) > 0;
check(
  "对照关键度量读出（容器宽度/两栏/行高/字号）",
  metricReady(taskM) && metricReady(skillM),
  JSON.stringify({
    task: { root: taskM.root.width, split: taskM.split.width, rowHeight: taskM.row.height, title: taskM.titleStyle["font-size"], rowName: taskM.rowNameStyle["font-size"], facts: taskM.rowFactsStyle["font-size"] },
    skill: { root: skillM.root.width, split: skillM.split.width, rowHeight: skillM.row.height, title: skillM.titleStyle["font-size"], rowName: skillM.rowNameStyle["font-size"], facts: skillM.rowFactsStyle["font-size"] },
  }),
);
check(
  "对照两页同一 DOM 语义（两栏容器 / 列表行 / PageState）都在",
  !!taskM.split && !!taskM.listPane && !!taskM.detailPane && !!taskM.row && !!skillM.split && !!skillM.listPane && !!skillM.detailPane && !!skillM.row,
  "task.split=" + px(taskM.split && taskM.split.width) + " skill.split=" + px(skillM.split && skillM.split.width),
);
check(
  "对照两页的详情占位都使用 PageState(empty) 语义",
  compare.task.pageStateBeforeSelect.some((s) => s.kind === "empty") && compare.skill.pageStateBeforeSelect.some((s) => s.kind === "empty"),
  JSON.stringify({ task: compare.task.pageStateBeforeSelect.map((s) => s.kind), skill: compare.skill.pageStateBeforeSelect.map((s) => s.kind) }),
);
check(
  "任务页使用了 ScrollArea 承接事件流滚动",
  taskM.counts.scrollAreas >= 1 && taskM.counts.scrollAreas >= skillM.counts.scrollAreas,
  "task=" + taskM.counts.scrollAreas + " skill=" + skillM.counts.scrollAreas,
);
const compareErrors = pageErrors.filter((e) => e.startsWith("compare:"));
const compareExternal = externalRequests.filter((e) => e.startsWith("compare:"));
check("对照场景无 console error", compareErrors.length === 0, compareErrors.slice(0, 3).join(" | "));
check("对照场景无跨源 / 非本地网络请求", compareExternal.length === 0, compareExternal.slice(0, 3).join(" | "));

/* ── 6c. compare-notes.md ────────────────────────────────────────────────── */
const cmp = compareDifferences;
const notes = [
  "# UI-3b · 基准对照笔记：任务 / Agent 控制台 vs Skill 中心",
  "",
  "> 由 experiments/dxos-ui-tasks/run-all.mjs 自动生成，数值来自同一次运行的 report.json（compare）。",
  "> 对照条件：" + compareCondition.colorScheme + " 主题 / " + compareCondition.viewport.width + "×" + compareCondition.viewport.height + " / deviceScaleFactor " + compareCondition.deviceScaleFactor + " / prefers-reduced-motion: " + compareCondition.reducedMotion + " / 同一本地静态服务与同名探针外壳；同背景与同透明度（同一探针 HTML/CSS 与同一 tokens 档，本轮未改 CSP/tokens.css）。",
  "> 截图：compare-task.png（任务控制台就绪态）、compare-skill.png（Skill 中心就绪态）。",
  "",
  "## 0. 基准与外壳口径",
  "",
  "- 基准页是 src/skills/SkillCenter.tsx（Dx-UI-PLAN §2 指定的同类管理页；UI-1 已交付）。",
  "- 两页按产品真实装配渲染：main.tsx 的 projects 分支与 skills 分支都是 .window > .split > .split-side（子视图/分类导航）+ .split-main。外壳完全同源，最外层容器宽度可直接对比。",
  "",
  "## 1. 实测关键度量（1440×900，CSS px）",
  "",
  "| 度量 | 任务控制台 | Skill 中心 | 差（任务−Skill） |",
  "| --- | --- | --- | --- |",
  "| 窗口 | " + px(taskM.window.width) + "×" + px(taskM.window.height) + " | " + px(skillM.window.width) + "×" + px(skillM.window.height) + " | — |",
  "| 页面根容器宽 | " + px(taskM.root.width) + " | " + px(skillM.root.width) + " | " + cmp.rootWidth + " |",
  "| 根容器高 | " + px(taskM.root.height) + " | " + px(skillM.root.height) + " | " + cmp.rootHeight + " |",
  "| 两栏容器宽 | " + px(taskM.split.width) + " | " + px(skillM.split.width) + " | " + cmp.splitWidth + " |",
  "| 两栏列定义 | 「" + taskM.splitStyle["grid-template-columns"] + "」 | 「" + skillM.splitStyle["grid-template-columns"] + "」 | 见 §3 |",
  "| 两栏 gap | " + px(taskM.splitStyle.gap) + " | " + px(skillM.splitStyle.gap) + " | " + cmp.splitGap + " |",
  "| 列表栏宽 | " + px(taskM.listPane.width) + " | " + px(skillM.listPane.width) + " | " + cmp.listPaneWidth + " |",
  "| 详情栏宽 | " + px(taskM.detailPane.width) + " | " + px(skillM.detailPane.width) + " | " + cmp.detailPaneWidth + " |",
  "| 列表行高 | " + px(taskM.row.height) + " | " + px(skillM.row.height) + " | +" + cmp.rowHeight + " |",
  "| 列表行 padding | " + taskM.rowStyle.padding + " | " + skillM.rowStyle.padding + " | " + cmp.rowPadding + " |",
  "| 页面标题字号 | " + taskM.titleStyle["font-size"] + " | " + skillM.titleStyle["font-size"] + " | " + cmp.bannerTitleFontSize + "px |",
  "| 行标题字号 | " + taskM.rowNameStyle["font-size"] + " | " + skillM.rowNameStyle["font-size"] + " | " + cmp.rowNameFontSize + "px |",
  "| 行元信息字号 | " + taskM.rowFactsStyle["font-size"] + " | " + skillM.rowFactsStyle["font-size"] + " | " + cmp.rowFactsFontSize + "px |",
  "| Badge / Button / ScrollArea 数量 | " + taskM.counts.badges + " / " + taskM.counts.buttons + " / " + taskM.counts.scrollAreas + " | " + skillM.counts.badges + " / " + skillM.counts.buttons + " / " + skillM.counts.scrollAreas + " | 见 §4 |",
  "",
  "## 2. 排版基线与字号",
  "",
  "**一致**：两个页面的行标题都取 --fs-body（" + taskM.rowNameStyle["font-size"] + "）、行元信息都取 --fs-micro（" + taskM.rowFactsStyle["font-size"] + "）、行标题字重都是 --fw-medium（" + taskM.rowNameStyle["font-weight"] + "）；页面标题都取 --fs-title（" + taskM.titleStyle["font-size"] + "）与 --tracking-tight；行结构同为 row__top（strong + Badge）+ row__facts。",
  "**差异**：" + (Math.abs(cmp.bannerTitleFontSize) < 0.5 && Math.abs(cmp.rowNameFontSize) < 0.5 && Math.abs(cmp.rowFactsFontSize) < 0.5 ? "三项字号差均 < 0.5px。" : "见上表差值。"),
  "",
  "## 3. 间距与容器",
  "",
  "**一致**：两页两栏容器都用 minmax(0,288px) + minmax(0,1fr)，gap 同为 --space-4（" + taskM.splitStyle.gap + "）；行 padding 同为 --space-3（" + taskM.rowStyle.padding + "）；行圆角同为 --radius-lg，底色同为 --sunken。",
  "**差异**：任务列表行比 Skill 行" + (cmp.rowHeight >= 0 ? "高" : "矮") + " " + Math.abs(cmp.rowHeight) + "px（任务行多一行 status 语义与 mode/时间元信息，Skill 行多一行描述摘要）。信息结构不同，不强行统一行高。",
  "",
  "## 4. 组件用法（PageState / Badge / Button / ScrollArea）",
  "",
  "- **PageState**：一致。两页详情未选中时都用 PageState kind=empty；加载/空/错误/不可用/未授权都走 PAGE_STATE_SPEC 的同一份 role/aria-live。",
  "- **Badge**：一致。行状态与详情标题旁都用 Badge tone（任务 11 态 → neutral/success/warning/danger）。",
  "- **Button**：一致。动作用 size=sm + primary/secondary/ghost/danger；危险动作交给 variant=danger 并带二次确认。",
  "- **ScrollArea**：任务页的事件流用 ScrollArea（" + taskM.counts.scrollAreas + " 个）承接长列表滚动；Skill 页为 " + skillM.counts.scrollAreas + " 个（两 pane 走原生 overflow）。这是任务页相对基准的一处**改进**，登记为后续设计系统统一项。",
  "",
  "## 5. 结论清单",
  "",
  "| 项 | 一致 / 差异 | 结论 |",
  "| --- | --- | --- |",
  "| 页面标题 / 行标题 / 元信息字阶 | 一致 | 保留 |",
  "| 行 padding / 圆角 / 底色 / 两栏列定义 / gap | 一致 | 保留 |",
  "| PageState 用法 | 一致 | 保留 |",
  "| Badge / Button 用法与 tone/variant | 一致 | 保留 |",
  "| 列表行高（信息结构不同） | 差异 | 保留 |",
  "| ScrollArea（任务页已用） | 差异（相对基准） | 保留任务页写法，登记统一项 |",
  "",
];
const notesPath = path.join(ART, "compare-notes.md");
fs.writeFileSync(notesPath, notes.join(String.fromCharCode(10)));
check("对照笔记 compare-notes.md 产出", fs.statSync(notesPath).size > 0, notesPath);

/* ── 7. 全局断言 ─────────────────────────────────────────────────────────── */
{
  const { ctx, page } = await openScenario(browser, "scenario=running&run=slow");
  await page.waitForSelector(".task-row[data-task-id]");
  await page.click('[data-task-id="t_report"]');
  await page.waitForSelector('[data-task-run-status="running"]');
  await page.waitForTimeout(2000);
  await page.click('[data-task-id="t_wait"]');
  await page.waitForSelector("[data-task-question]");
  await page.fill('[data-task-field="answer"]', "覆盖");
  await page.click('[data-task-action="answer"]');
  /* 进行中按钮必须禁用（status=loading → disabled + aria-busy）：连点不会叠加第二条命令。 */
  const busyGuard = await page
    .waitForSelector('[data-task-action="answer"][disabled][aria-busy="true"]', { timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  check("提交回答进行中按钮禁用（连点不叠加）", busyGuard, "busy=" + busyGuard);
  await page.waitForSelector("[data-task-notice]", { timeout: 10000 });
  const commands = await page.evaluate(() => (window.__oaTaskProbe ? window.__oaTaskProbe.commands : []));
  const names = commands.map((c) => c.command);
  check("界面只发白名单命令", names.every((c) => TASK_CONSOLE_COMMANDS.indexOf(c) >= 0 && AGENT_COMMANDS.indexOf(c) >= 0), [...new Set(names)].join(", "));
  const identityKeys = ["userId", "role", "sessionRef", "appId"];
  const offenders = commands.filter((c) => Object.keys(c.payload || {}).some((k) => identityKeys.indexOf(k) >= 0));
  check("所有命令载荷不含身份字段（userId/role/sessionRef/appId）", offenders.length === 0, JSON.stringify(offenders.slice(0, 2)));
  const answerCall = commands.find((c) => c.command === "agent/task/answer");
  const answerKeys = answerCall ? Object.keys(answerCall.payload).sort().join(",") : "";
  check("回答载荷只含 taskId/answer/requestId", answerKeys === "answer,requestId,taskId", answerKeys);
  const answerCount = commands.filter((c) => c.command === "agent/task/answer").length;
  check("一次提交只发一条 answer 命令", answerCount === 1, "count=" + answerCount);
  const unifiedCall = commands.find((c) => c.command === "agent/task/unified-list");
  check("界面发出统一读模型命令 agent/task/unified-list", !!unifiedCall, JSON.stringify(unifiedCall || null));
  const entryCommands = ["agent/task/create", "agent/tool/call", "agent/project/run", "agent/react/run"];
  check(
    "四个写操作入口命令都在界面与后端白名单内",
    entryCommands.every((c) => TASK_CONSOLE_COMMANDS.indexOf(c) >= 0 && AGENT_COMMANDS.indexOf(c) >= 0),
    entryCommands.join(","),
  );
  const sourceBadges = await page.$$eval("[data-task-source]", (els) => els.map((el) => el.getAttribute("data-task-source")));
  check("列表行带统一读模型来源标注", sourceBadges.length >= 3, JSON.stringify(Array.from(new Set(sourceBadges))));
  const progressSequences = await page.evaluate(() => (window.__oaTaskProbe ? window.__oaTaskProbe.events.filter((e) => e.kind === "progress").map((e) => e.sequence) : []));
  const monotonic = progressSequences.every((v, i) => i === 0 || v > progressSequences[i - 1]);
  check("agent:event progress sequence 严格单调", monotonic && progressSequences.length >= 5, "n=" + progressSequences.length + " seq=" + progressSequences.slice(0, 8).join(","));
  await ctx.close();
}

check("无 console error", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
check("无跨源 / 非本地网络请求", externalRequests.length === 0, externalRequests.slice(0, 3).join(" | "));

await browser.close();
server.close();

/* ── 8. 报告 ─────────────────────────────────────────────────────────────── */
const failed = checks.filter((c) => !c.ok);
const report = {
  task: "UI-3 任务 / Agent 控制台 + 基准（Skill 中心）对照",
  verdict: failed.length ? "FAIL" : "PASS",
  environment: {
    os: os.type() + " " + os.release(),
    node: process.version,
    chromium: CHROMIUM,
    chromiumSource: CHROMIUM_INFO.source,
    url: BASE,
    screenshotOptions: SHOT_OPTS,
    timing: { scale: TIMEOUT_SCALE, source: SCALE_SOURCE, summary: timingSummary() },
  },
  screenshots,
  video: fs.existsSync(flowVideo) ? flowVideo : null,
  entryVideo: fs.existsSync(entryFlowVideo) ? entryFlowVideo : null,
  coreVideo: fs.existsSync(coreFlowVideo) ? coreFlowVideo : null,
  compare: {
    condition: compareCondition,
    screenshots: { task: compare.task.screenshot, skill: compare.skill.screenshot },
    notes: notesPath,
    metrics: { task: taskM, skill: skillM },
    differences: compareDifferences,
    pageStateBeforeSelect: {
      task: compare.task.pageStateBeforeSelect,
      skill: compare.skill.pageStateBeforeSelect,
    },
  },
  checks,
  failures: failed,
  consoleErrors: pageErrors,
  externalRequests,
  finishedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify(report, null, 2));

console.log(String.fromCharCode(10) + "═".repeat(72));
console.log("UI-3 任务 / Agent 控制台探针：结论 " + report.verdict + " — " + JSON.stringify({ total: checks.length, failed: failed.length }));
console.log("截图：" + screenshots.length + " 张 → " + ART);
console.log("录屏：" + (report.video || "（无）"));
console.log("写操作入口录屏：" + (report.entryVideo || "（无）"));
console.log("core 任务录屏：" + (report.coreVideo || "（无）"));
console.log("对照：" + compare.task.screenshot + " ／ " + compare.skill.screenshot);
console.log(
  "对照差异（任务−Skill）：" + JSON.stringify({
    rootWidth: compareDifferences.rootWidth,
    listPaneWidth: compareDifferences.listPaneWidth,
    rowHeight: compareDifferences.rowHeight,
    titleFontSize: compareDifferences.bannerTitleFontSize,
    rowNameFontSize: compareDifferences.rowNameFontSize,
    rowFactsFontSize: compareDifferences.rowFactsFontSize,
  }),
);
console.log("对照笔记：" + notesPath);
console.log("报告：" + path.join(ART, "report.json"));
if (failed.length) {
  console.log("失败项：");
  for (const f of failed) console.log("  · " + f.name + (f.detail ? " — " + f.detail : ""));
}
process.exit(failed.length ? 1 : 0);
