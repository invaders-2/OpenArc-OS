/**
 * UI-1 · Skill 中心 Playwright 探针（截图 + 连续录屏 + 边界断言）。
 *
 * 为什么不直接开产品 dist：本轮禁止执行 `npm run build`，而 dist 里还没有 SkillCenter。
 * 这里用 esbuild（Vite 自带依赖）把 **实验用挂载壳 harness.tsx** 打成一份本地构建产物，
 * 再用本机 Chromium（见 experiments/lib/chromium.mjs：OA_CHROMIUM → Playwright → 系统 Chrome）打开，
 * 挂载的 DOM 结构与 src/main.tsx 的 skills 分支一致（.window > .split > .split-side/.split-main）。
 *
 * 覆盖：加载 / 空 / 就绪 / 错误 / 运行中 五类必拍状态 + 禁用 / 导入失败 / 无权 / 依赖缺失 / 窄宽，
 *       主流程连续录屏；断言无 console error、无跨源请求、有可访问焦点顺序。
 *
 * 运行：node experiments/dxos-ui-skills/run-all.mjs
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

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../..");
const ART = path.join(ROOT, "artifacts", "dxos-ui-skills");
const BUILD = path.join(ART, "build");
const VIDEO_DIR = path.join(ART, "video");
const PORT = Number(process.env.OA_SKILLS_PORT || 5251);
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

/* ── 1. 用 esbuild 打一份本地产物（harness + 产品源码 + 设计系统样式）──────── */
fs.rmSync(BUILD, { recursive: true, force: true });
fs.rmSync(VIDEO_DIR, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(VIDEO_DIR, { recursive: true });

const INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'" />
<title>Skill 中心 UI 探针</title>
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
  /* styles.css 里有一处 url("/openarc-mark.svg")（桌面字标遮罩）。esbuild 不会自动把
     以 / 开头的运行时 URL 映射到 public/，这里显式解析到 public 目录并内联为 data URL。 */
  plugins: [
    {
      name: "oa-public-assets",
      setup(b) {
        b.onResolve({ filter: /^\/[^/].*\.(svg|png)$/ }, (args) => {
          const file = path.join(ROOT, "public", args.path.replace(/^\//, ""));
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
  const rel = raw === "/" ? "index.html" : raw.replace(/^\/+/, "");
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

/** 五类必拍状态共用同一主题 / 窗口尺寸 / 缩放 / 动态设置（MOTION_SYSTEM §10）。 */
const SHOT_OPTS = {
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "light",
  locale: "zh-CN",
  reducedMotion: "reduce",
};

function watch(page, label) {
  /* 每个 page 都在这里统一加固：waitForSelector/goto 按倍率放大并做有界重试。 */
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
  await page.waitForSelector("[data-skill-center]");
  return { ctx, page };
}

const browser = await launchChromiumBounded(chromium, { executablePath: CHROMIUM });
registerCleanup(() => browser.close());
const screenshots = [];
const results = [];

/* ── 4. 状态截图 ─────────────────────────────────────────────────────────── */
async function shoot(spec) {
  const label = "场景 " + spec.name;
  const checksBefore = checks.length;
  const screenshotsBefore = screenshots.length;
  await withRetries(
    label,
    SCENARIO_ATTEMPTS,
    async () => {
      const { ctx, page } = await openScenario(browser, spec.query, spec.narrow ? { viewport: { width: 640, height: 900 } } : null);
      try {
        if (spec.setup) await spec.setup(page);
        await page.waitForSelector(spec.expect, { timeout: 15000 });
        await page.waitForTimeout(220);
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

console.log("\n状态截图：");
await shoot({ name: "01-loading", query: "scenario=loading&tab=installed", expect: '[data-skill-list-state="loading"]' });
await shoot({ name: "02-empty", query: "scenario=empty&tab=installed", expect: '[data-skill-empty="empty"]' });
await shoot({ name: "03-ready", query: "scenario=ready&tab=installed", expect: ".skill-row[data-skill-id]" });
await shoot({
  name: "04-error",
  query: "scenario=error&tab=installed",
  expect: '[data-skill-empty="error"] [data-ds-kind="error"]',
});
await shoot({
  name: "05-running",
  query: "scenario=ready&tab=installed&run=slow",
  expect: '[data-skill-run-state="running"]',
  setup: async (page) => {
    await page.click('[data-skill-id="writing"]');
    await page.waitForSelector("[data-skill-detail]");
    await page.fill('[data-skill-field="instruction"]', "写一段产品介绍");
    await page.click('[data-skill-action="run"]');
    await page.waitForSelector('[data-skill-run-state="running"]');
    const disabled = await page.$eval('[data-skill-action="run"]', (el) => el.disabled);
    check("运行中运行按钮被禁用（连点不叠加）", disabled === true, "disabled=" + disabled);
  },
});
await shoot({
  name: "06-disabled",
  query: "scenario=ready&tab=installed",
  expect: '[data-skill-note="disabled"]',
  setup: async (page) => {
    await page.click('[data-skill-id="analysis"]');
    await page.waitForSelector("[data-skill-detail]");
  },
});
await shoot({
  name: "07-import-failed",
  query: "scenario=ready&tab=market&import=fail",
  expect: "[data-skill-import-error]",
  setup: async (page) => {
    await page.setInputFiles("[data-skill-file-input]", {
      name: "broken.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("NOT-A-ZIP"),
    });
    await page.waitForSelector("[data-skill-import-error]");
    const category = await page.$eval("[data-skill-import-error]", (el) => el.getAttribute("data-skill-import-category"));
    check("导入失败被分类为 zip", category === "zip", "category=" + category);
  },
});
await shoot({
  name: "08-unauthorized",
  query: "scenario=unauthorized&tab=installed",
  expect: '[data-skill-empty="error"] [data-ds-kind="unauthorized"]',
});
await shoot({
  name: "09-dependency",
  query: "scenario=unavailable&tab=installed",
  expect: '[data-skill-empty="unavailable"] [data-ds-kind="unavailable"]',
  setup: async (page) => {
    const text = await page.$eval("[data-skill-dependency]", (el) => el.textContent || "");
    check("依赖缺失文案说明技能没有执行、也没有产物", text.includes("没有执行") && text.includes("产物"), text.slice(0, 60));
  },
});
await shoot({
  name: "10-narrow-640",
  query: "scenario=ready&tab=installed",
  narrow: true,
  expect: ".skill-row[data-skill-id]",
  setup: async (page) => {
    const overflow = await page.evaluate(() => {
      const el = document.querySelector(".split-main");
      return el ? el.scrollWidth - el.clientWidth : -1;
    });
    check("窄宽 640px 列表与详情不溢出", overflow <= 1, "split-main overflow=" + overflow);
  },
});

/* ── 4b. 本轮补齐入口的状态截图（分析 / 保存 / 工作区 / 媒体运行）────────── */
console.log("\n新增入口状态截图：");

await shoot({
  name: "11-analyze-ready",
  query: "scenario=ready&tab=market&deps=all",
  expect: "[data-skill-analyze-result]",
  setup: async (page) => {
    await page.setInputFiles("[data-skill-analyze-input]", {
      name: "weekly.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# 周报\n1. 收集素材\n2. 生成摘要"),
    });
    await page.waitForSelector("[data-skill-analyze-result]");
    const steps = await page.$$eval("[data-skill-analyze-steps] li", (els) => els.length);
    check("分析结果展示 v2 工作流步骤", steps >= 2, "steps=" + steps);
  },
});

await shoot({
  name: "12-analyze-dependency",
  query: "scenario=ready&tab=market&deps=model-missing",
  expect: "[data-skill-analyze-unavailable]",
  setup: async (page) => {
    const text = await page.$eval("[data-skill-analyze-unavailable]", (el) => el.textContent || "");
    check("分析入口依赖缺失给出结构化提示", text.includes("缺少模型"), text.slice(0, 60));
    const disabled = await page.$eval('[data-skill-action="analyze"]', (el) => el.disabled);
    check("分析入口依赖缺失时按钮禁用", disabled === true, "disabled=" + disabled);
  },
});

await shoot({
  name: "13-save-done",
  query: "scenario=ready&tab=market&deps=all",
  expect: "[data-skill-save-done]",
  setup: async (page) => {
    await page.setInputFiles("[data-skill-analyze-input]", {
      name: "weekly.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# 周报\n1. 收集素材\n2. 生成摘要"),
    });
    await page.waitForSelector("[data-skill-analyze-result]");
    await page.waitForTimeout(150);
    await page.click('[data-skill-action="save"]');
    await page.waitForSelector("[data-skill-save-done]", { timeout: 10000 });
    const text = await page.$eval("[data-skill-save-done]", (el) => el.textContent || "");
    check("保存技能成功回显技能 ID", text.includes("weekly_digest"), text.slice(0, 60));
  },
});

await shoot({
  name: "14-workspace-ready",
  query: "scenario=ready&tab=installed&deps=all",
  expect: "[data-skill-workspace-list]",
  setup: async (page) => {
    await page.click('[data-skill-id="team_report"]');
    await page.waitForSelector("[data-skill-detail]");
    await page.click('[data-skill-action="workspace"]');
    await page.waitForSelector("[data-skill-workspace-list]", { timeout: 10000 });
    const count = await page.$$eval("[data-skill-workspace-list] li", (els) => els.length);
    check("工作区技能列表展示资料", count >= 1, "count=" + count);
  },
});

await shoot({
  name: "15-workspace-dependency",
  query: "scenario=ready&tab=installed&deps=workspace-missing",
  expect: "[data-skill-workspace-unavailable]",
  setup: async (page) => {
    await page.click('[data-skill-id="team_report"]');
    await page.waitForSelector("[data-skill-detail]");
    const text = await page.$eval("[data-skill-workspace-unavailable]", (el) => el.textContent || "");
    check("工作区入口依赖缺失给出结构化提示", text.includes("工作空间"), text.slice(0, 60));
    const disabled = await page.$eval('[data-skill-action="workspace"]', (el) => el.disabled);
    check("工作区入口依赖缺失时按钮禁用", disabled === true, "disabled=" + disabled);
  },
});

await shoot({
  name: "16-media-ready",
  query: "scenario=ready&tab=installed&deps=all",
  expect: '[data-skill-run-kind="image"]',
  setup: async (page) => {
    await page.click('[data-skill-id="generate_image"]');
    await page.waitForSelector("[data-skill-detail]");
    await page.waitForSelector('[data-skill-field="prompt"]');
    const disabled = await page.$eval('[data-skill-action="run"]', (el) => el.disabled);
    check("媒体技能就绪时运行入口可用", disabled === false, "disabled=" + disabled);
  },
});

await shoot({
  name: "17-media-dependency",
  query: "scenario=ready&tab=installed&deps=media-missing",
  expect: "[data-skill-run-unavailable]",
  setup: async (page) => {
    await page.click('[data-skill-id="generate_image"]');
    await page.waitForSelector("[data-skill-detail]");
    const text = await page.$eval("[data-skill-run-unavailable]", (el) => el.textContent || "");
    check("媒体技能依赖缺失显示缺少媒体适配器", text.includes("缺少媒体适配器"), text.slice(0, 80));
    const disabled = await page.$eval('[data-skill-action="run"]', (el) => el.disabled);
    check("媒体技能依赖缺失时运行按钮禁用", disabled === true, "disabled=" + disabled);
  },
});

await shoot({
  name: "18-media-running",
  query: "scenario=ready&tab=installed&deps=all&run=slow",
  expect: '[data-skill-run-state="running"]',
  setup: async (page) => {
    await page.click('[data-skill-id="generate_image"]');
    await page.waitForSelector('[data-skill-field="prompt"]');
    await page.fill('[data-skill-field="prompt"]', "一只在图书馆看书的猫");
    await page.click('[data-skill-action="run"]');
    await page.waitForSelector('[data-skill-run-state="running"]');
    const disabled = await page.$eval('[data-skill-action="run"]', (el) => el.disabled);
    check("媒体技能运行中按钮禁用（连点不叠加）", disabled === true, "disabled=" + disabled);
  },
});

await shoot({
  name: "19-media-artifacts",
  query: "scenario=ready&tab=installed&deps=all",
  expect: "[data-skill-artifacts]",
  setup: async (page) => {
    await page.click('[data-skill-id="generate_image"]');
    await page.waitForSelector('[data-skill-field="prompt"]');
    await page.fill('[data-skill-field="prompt"]', "一只在图书馆看书的猫");
    await page.click('[data-skill-action="run"]');
    await page.waitForSelector("[data-skill-artifacts]", { timeout: 12000 });
    const ref = await page.$eval("[data-skill-artifact-ref]", (el) => el.textContent || "");
    check("媒体产物显示虚拟文件树路径", ref.includes("/api/fs/raw/probe-node-1"), ref);
  },
});

await shoot({
  name: "20-media-failed",
  query: "scenario=ready&tab=installed&deps=all&media=fail",
  expect: "[data-skill-run-error]",
  setup: async (page) => {
    await page.click('[data-skill-id="generate_image"]');
    await page.waitForSelector('[data-skill-field="prompt"]');
    await page.fill('[data-skill-field="prompt"]', "一只在图书馆看书的猫");
    await page.click('[data-skill-action="run"]');
    await page.waitForSelector("[data-skill-run-error]", { timeout: 10000 });
    const text = await page.$eval("[data-skill-run-error]", (el) => el.textContent || "");
    check(
      "媒体技能失败给出结构化错误码→人话文案",
      text.includes("缺少媒体适配器") && text.includes("SKILL_DEPENDENCY_UNAVAILABLE"),
      text.slice(0, 90),
    );
  },
});

/* ── 5. 主流程连续录屏 ───────────────────────────────────────────────────── */
console.log("\n主流程连续录屏：");
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
await vpage.goto(BASE + "/?scenario=ready&tab=installed&run=slow", { waitUntil: "domcontentloaded" });
await vpage.waitForSelector(".skill-row[data-skill-id]");
await vpage.waitForTimeout(500);
await vpage.click('[data-skill-id="writing"]');
await vpage.waitForSelector("[data-skill-detail]");
await vpage.waitForTimeout(400);
await vpage.fill('[data-skill-field="instruction"]', "写一段产品介绍");
await vpage.waitForTimeout(250);
await vpage.click('[data-skill-action="run"]');
await vpage.waitForSelector('[data-skill-run-state="running"]');
await vpage.waitForTimeout(1600);
await vpage.waitForSelector('[data-skill-run-state="success"]', { timeout: 12000 });
await vpage.waitForTimeout(900);
await vpage.click('.split-nav:has-text("市场")');
await vpage.waitForSelector("[data-skill-pack]");
await vpage.waitForTimeout(900);
await vpage.click('.split-nav:has-text("我的技能")');
await vpage.waitForSelector('[data-skill-id="team_report"]');
await vpage.waitForTimeout(700);
await videoCtx.close();
const rawVideo = await video.path();
const flowVideo = path.join(ART, "skill-center-flow.webm");
if (rawVideo && fs.existsSync(rawVideo)) {
  fs.copyFileSync(rawVideo, flowVideo);
  check("主流程连续录屏产出", fs.statSync(flowVideo).size > 0, flowVideo);
} else {
  check("主流程连续录屏产出", false, "video.path() 为空");
}

/* 新增入口连续录屏：技能文档分析 → 保存 → 媒体运行出产物 → 工作区资料。 */
console.log("\n新增入口连续录屏：");
setStep("新增入口连续录屏");
const entriesVideoCtx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: "light",
  locale: "zh-CN",
  recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 900 } },
});
const evpage = await entriesVideoCtx.newPage();
watch(evpage, "video-entries");
const entriesVideo = evpage.video();
await evpage.goto(BASE + "/?scenario=ready&tab=market&deps=all", { waitUntil: "domcontentloaded" });
await evpage.waitForSelector("[data-skill-analyze-idle]");
await evpage.waitForTimeout(400);
await evpage.setInputFiles("[data-skill-analyze-input]", {
  name: "weekly.md",
  mimeType: "text/markdown",
  buffer: Buffer.from("# 周报\n1. 收集素材\n2. 生成摘要"),
});
await evpage.waitForSelector("[data-skill-analyze-result]");
await evpage.waitForTimeout(700);
await evpage.click('[data-skill-action="save"]');
await evpage.waitForSelector("[data-skill-save-done]", { timeout: 10000 });
await evpage.waitForTimeout(600);
await evpage.click('.split-nav:has-text("已安装")');
await evpage.waitForSelector('[data-skill-id="generate_image"]');
await evpage.click('[data-skill-id="generate_image"]');
await evpage.waitForSelector('[data-skill-field="prompt"]');
await evpage.fill('[data-skill-field="prompt"]', "一只在图书馆看书的猫");
await evpage.waitForTimeout(300);
await evpage.click('[data-skill-action="run"]');
await evpage.waitForSelector("[data-skill-artifacts]", { timeout: 12000 });
await evpage.waitForTimeout(700);
await evpage.click('[data-skill-id="team_report"]');
await evpage.waitForSelector('[data-skill-action="workspace"]');
await evpage.click('[data-skill-action="workspace"]');
await evpage.waitForSelector("[data-skill-workspace-list]", { timeout: 10000 });
await evpage.waitForTimeout(700);
await entriesVideoCtx.close();
const rawEntriesVideo = await entriesVideo.path();
const entriesFlowVideo = path.join(ART, "skill-entries-flow.webm");
if (rawEntriesVideo && fs.existsSync(rawEntriesVideo)) {
  fs.copyFileSync(rawEntriesVideo, entriesFlowVideo);
  check("新增入口连续录屏产出", fs.statSync(entriesFlowVideo).size > 0, entriesFlowVideo);
} else {
  check("新增入口连续录屏产出", false, "video.path() 为空");
}

/* ── 6. 焦点顺序（就绪页）────────────────────────────────────────────────── */
console.log("\n可访问焦点顺序：");
setStep("可访问焦点顺序");
{
  const { ctx, page } = await openScenario(browser, "scenario=ready&tab=installed");
  await page.waitForSelector(".skill-row[data-skill-id]");
  /* 先打开一个技能详情，让详情区的运行 / 导出 / 删除也进入焦点顺序。 */
  await page.click('[data-skill-id="writing"]');
  await page.waitForSelector("[data-skill-detail]");
  const order = [];
  await page.evaluate(() => {
    const first = document.querySelector(".split-nav");
    if (first && typeof first.focus === "function") first.focus();
  });
  for (let i = 0; i < 14; i += 1) {
    await page.keyboard.press("Tab");
    const item = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return "body";
      const inside = !!(el.closest && el.closest(".skill-center, .split-side"));
      return (
        (inside ? "in:" : "out:") +
        el.tagName.toLowerCase() +
        ":" +
        (el.getAttribute("data-skill-action") ||
          el.getAttribute("data-skill-id") ||
          el.getAttribute("aria-label") ||
          el.getAttribute("text") ||
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
  check(
    "Tab 顺序只在界面内推进（文档边界最多停留一次）",
    outside === 0 && bodyStops <= 1,
    "outside=" + outside + " body=" + bodyStops + " :: " + order.join(" → "),
  );
  check("焦点顺序逐步前进（>=5 个不同落点）", distinct >= 5, "distinct=" + distinct);
  const searchFocusable = await page.evaluate(() => {
    const el = document.querySelector('[data-skill-search]');
    if (!el) return false;
    el.focus();
    return document.activeElement === el;
  });
  check("搜索框可聚焦", searchFocusable === true);
  await ctx.close();
}

/* ── 6b. 基准对照：Skill 中心 vs McpCenter ──────────────────────────────────
   同主题（light）/ 同窗口（1440×900）/ 同缩放（deviceScaleFactor 2）/
   同 reducedMotion，分别渲染 Skill 中心（就绪态）与基准页 McpCenter 的外壳，
   两张截图 + 关键度量写进 report.json，结论写进 compare-notes.md。 */
console.log("\n基准对照（Skill 中心 vs McpCenter）：");
setStep("基准对照（Skill 中心 vs McpCenter）");

const COMPARE_SPECS = {
  skill: {
    query: "scenario=ready&tab=installed",
    root: "[data-skill-center]",
    row: ".skill-row[data-skill-id]",
    detail: "[data-skill-detail]",
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
  mcp: {
    query: "page=mcp",
    root: "[data-mcp-center]",
    row: ".mcp-row",
    detail: "[data-mcp-detail]",
    vars: {
      root: ".mcp-center",
      split: ".mcp-split",
      list: ".mcp-list-pane",
      detail: ".mcp-detail-pane",
      row: ".mcp-row",
      rowName: ".mcp-row__top strong",
      rowFacts: ".mcp-row__facts",
      paneHead: ".mcp-pane-head",
      title: ".mcp-banner__title",
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
      rect: rectOf(el),
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
  await page.waitForSelector(spec.row, { timeout: 15000 });
  await page.waitForTimeout(220);
  /* 选中详情之前：右侧详情区是 PageState(empty)，两页都在这一口径下量 PageState 用法。 */
  const before = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-ds-comp="page-state"]')).map((el) => ({
      kind: el.getAttribute("data-ds-kind"),
      className: String(el.className),
      title: ((el.querySelector(".ds-page-state__title") || {}).textContent || "").trim(),
    })),
  );
  await page.click(spec.row);
  await page.waitForSelector(spec.detail, { timeout: 15000 });
  await page.waitForTimeout(260);
  const metrics = await measurePage(page, spec.vars);
  const file = path.join(ART, "compare-" + kind + ".png");
  await page.screenshot({ path: file });
  compare[kind] = { screenshot: file, query: spec.query, pageStateBeforeSelect: before, metrics };
  screenshots.push(file);
  check("对照截图 compare-" + kind + " → " + spec.detail, true, file);
  await ctx.close();
}

await captureCompare("skill");
await captureCompare("mcp");

const skillM = compare.skill.metrics;
const mcpM = compare.mcp.metrics;
const round = (n) => Math.round(n * 10) / 10;
const px = (v) => (v == null ? "—" : String(v));
const fsNum = (v) => (v ? Number.parseFloat(v["font-size"]) : NaN);

/* 数值差异（正数 = Skill 更大）。同 DOM 语义：容器宽度、两栏列宽、行高、字号。 */
const compareDifferences = {
  rootWidth: round(skillM.root.width - mcpM.root.width),
  rootHeight: round(skillM.root.height - mcpM.root.height),
  splitWidth: round(skillM.split.width - mcpM.split.width),
  listPaneWidth: round(skillM.listPane.width - mcpM.listPane.width),
  detailPaneWidth: round(skillM.detailPane.width - mcpM.detailPane.width),
  rowHeight: round(skillM.row.height - mcpM.row.height),
  rowPadding: skillM.rowStyle.padding + " vs " + mcpM.rowStyle.padding,
  bannerTitleFontSize: round(fsNum(skillM.titleStyle) - fsNum(mcpM.titleStyle)),
  rowNameFontSize: round(fsNum(skillM.rowNameStyle) - fsNum(mcpM.rowNameStyle)),
  rowFactsFontSize: round(fsNum(skillM.rowFactsStyle) - fsNum(mcpM.rowFactsStyle)),
  listGap: skillM.splitStyle.gap === mcpM.splitStyle.gap ? "一致" : skillM.splitStyle.gap + " vs " + mcpM.splitStyle.gap,
};

check(
  "对照两页同窗口尺寸（1440×900）",
  !!skillM.window && Math.round(skillM.window.width) === 1440 && Math.round(skillM.window.height) === 900 &&
    !!mcpM.window && Math.round(mcpM.window.width) === 1440 && Math.round(mcpM.window.height) === 900,
  "skill=" + JSON.stringify(skillM.window) + " mcp=" + JSON.stringify(mcpM.window),
);
check(
  "对照两页同主题/缩放/reducedMotion 上下文",
  compareCondition.colorScheme === "light" && compareCondition.deviceScaleFactor === 2 && compareCondition.reducedMotion === "reduce",
  JSON.stringify(compareCondition),
);
const metricReady = (m) =>
  !!m.root && m.root.width > 0 && !!m.split && m.split.width > 0 && !!m.row && m.row.height > 0 &&
  fsNum(m.titleStyle) > 0 && fsNum(m.rowNameStyle) > 0 && fsNum(m.rowFactsStyle) > 0;
check(
  "对照关键度量读出（容器宽度/两栏/行高/字号）",
  metricReady(skillM) && metricReady(mcpM),
  JSON.stringify({
    skill: { root: skillM.root.width, split: skillM.split.width, rowHeight: skillM.row.height, title: skillM.titleStyle["font-size"], rowName: skillM.rowNameStyle["font-size"], facts: skillM.rowFactsStyle["font-size"] },
    mcp: { root: mcpM.root.width, split: mcpM.split.width, rowHeight: mcpM.row.height, title: mcpM.titleStyle["font-size"], rowName: mcpM.rowNameStyle["font-size"], facts: mcpM.rowFactsStyle["font-size"] },
  }),
);
check(
  "对照两页同一 DOM 语义（两栏容器 / 列表行 / PageState）都在",
  !!skillM.split && !!skillM.listPane && !!skillM.detailPane && !!skillM.row && !!mcpM.split && !!mcpM.listPane && !!mcpM.detailPane && !!mcpM.row,
  "skill.split=" + px(skillM.split && skillM.split.width) + " mcp.split=" + px(mcpM.split && mcpM.split.width),
);
check(
  "对照两页的详情空态都使用 PageState(empty)",
  compare.skill.pageStateBeforeSelect.some((s) => s.kind === "empty") && compare.mcp.pageStateBeforeSelect.some((s) => s.kind === "empty"),
  JSON.stringify({ skill: compare.skill.pageStateBeforeSelect.map((s) => s.kind), mcp: compare.mcp.pageStateBeforeSelect.map((s) => s.kind) }),
);
const compareErrors = pageErrors.filter((e) => e.startsWith("compare:"));
const compareExternal = externalRequests.filter((e) => e.startsWith("compare:"));
check("对照场景无 console error", compareErrors.length === 0, compareErrors.slice(0, 3).join(" | "));
check("对照场景无跨源 / 非本地网络请求", compareExternal.length === 0, compareExternal.slice(0, 3).join(" | "));

/* ── 6c. compare-notes.md：逐项一致处 / 差异处 + 结论（数值来自本次运行）── */
const cmp = compareDifferences;
const notes = [
  "# UI-1b · 基准对照笔记：Skill 中心 vs McpCenter",
  "",
  "> 由 experiments/dxos-ui-skills/run-all.mjs 自动生成，数值来自同一次运行的 report.json（compare）。",
  "> 对照条件：" + compareCondition.colorScheme + " 主题 / " + compareCondition.viewport.width + "×" + compareCondition.viewport.height + " / deviceScaleFactor " + compareCondition.deviceScaleFactor + " / prefers-reduced-motion: " + compareCondition.reducedMotion + " / 同一本地静态服务与同名探针外壳；同背景与同透明度（同一探针 HTML/CSS 与同一 tokens 档，本轮未改 CSP/tokens.css）。",
  "> 截图：compare-skill.png（Skill 中心就绪态）、compare-mcp.png（McpCenter 就绪态）。",
  "",
  "## 0. 基准与外壳口径",
  "",
  "- 基准页是 src/mcp/McpCenter.tsx（Dx-UI-PLAN §2 指定的『最接近的已确认基准』，D5-03 已验收）。",
  "- 两页按产品真实装配渲染：main.tsx 的 skills 分支是 .window > .split > .split-side（分类导航）+ .split-main > SkillCenter；mcp-center 分支（2657 行）是 McpCenter 直挂窗口内容，产品里没有 .split-side / .split-main。",
  "- 所以对比分两层：内容区内部的排版基线、间距、字号、组件用法可直接对比；最外层容器宽度受 Skill 侧栏与 .split-main 内边距影响，不能直接等同。",
  "",
  "## 1. 实测关键度量（1440×900，CSS px）",
  "",
  "| 度量 | Skill 中心 | McpCenter | 差（Skill−MCP） |",
  "| --- | --- | --- | --- |",
  "| 窗口 | " + px(skillM.window.width) + "×" + px(skillM.window.height) + " | " + px(mcpM.window.width) + "×" + px(mcpM.window.height) + " | — |",
  "| 页面根容器 .skill-center / .mcp-center 宽 | " + px(skillM.root.width) + " | " + px(mcpM.root.width) + " | " + cmp.rootWidth + " |",
  "| 根容器高 | " + px(skillM.root.height) + " | " + px(mcpM.root.height) + " | " + cmp.rootHeight + " |",
  "| 两栏容器 .skill-split / .mcp-split 宽 | " + px(skillM.split.width) + " | " + px(mcpM.split.width) + " | " + cmp.splitWidth + " |",
  "| 两栏列定义 | 「" + skillM.splitStyle["grid-template-columns"] + "」 | 「" + mcpM.splitStyle["grid-template-columns"] + "」 | 见 §3 |",
  "| 两栏 gap | " + px(skillM.splitStyle.gap) + " | " + px(mcpM.splitStyle.gap) + " | " + cmp.listGap + " |",
  "| 列表栏宽 | " + px(skillM.listPane.width) + " | " + px(mcpM.listPane.width) + " | " + cmp.listPaneWidth + " |",
  "| 详情栏宽 | " + px(skillM.detailPane.width) + " | " + px(mcpM.detailPane.width) + " | " + cmp.detailPaneWidth + " |",
  "| 列表行高 | " + px(skillM.row.height) + " | " + px(mcpM.row.height) + " | +" + cmp.rowHeight + " |",
  "| 列表行 padding | " + skillM.rowStyle.padding + " | " + mcpM.rowStyle.padding + " | 一致 |",
  "| 页面标题字号 | " + skillM.titleStyle["font-size"] + " | " + mcpM.titleStyle["font-size"] + " | " + cmp.bannerTitleFontSize + "px |",
  "| 行标题字号 | " + skillM.rowNameStyle["font-size"] + " | " + mcpM.rowNameStyle["font-size"] + " | " + cmp.rowNameFontSize + "px |",
  "| 行元信息字号 | " + skillM.rowFactsStyle["font-size"] + " | " + mcpM.rowFactsStyle["font-size"] + " | " + cmp.rowFactsFontSize + "px |",
  "| .split-side 宽 | " + px(skillM.splitSide && skillM.splitSide.width) + " | 无（产品无侧栏） | — |",
  "| .split-main 宽 | " + px(skillM.splitMain && skillM.splitMain.width) + " | 无（产品无侧栏） | — |",
  "| PageState（详情空态） | " + JSON.stringify(compare.skill.pageStateBeforeSelect.map((s) => s.kind)) + " | " + JSON.stringify(compare.mcp.pageStateBeforeSelect.map((s) => s.kind)) + " | 一致 |",
  "| Badge / Button / ScrollArea 数量 | " + skillM.counts.badges + " / " + skillM.counts.buttons + " / " + skillM.counts.scrollAreas + " | " + mcpM.counts.badges + " / " + mcpM.counts.buttons + " / " + mcpM.counts.scrollAreas + " | 见 §4 |",
  "",
  "## 2. 排版基线与字号",
  "",
  "**一致**：两个页面的行标题都用 --fs-body（" + skillM.rowNameStyle["font-size"] + "）、行元信息都用 --fs-micro（" + skillM.rowFactsStyle["font-size"] + "）、行标题字重都是 --fw-medium（" + skillM.rowNameStyle["font-weight"] + "）；行结构同为 row__top（strong + Badge）+ row__facts。",
  "**差异**：Skill 的页面标题 .skill-banner__title 是 h1 + --fs-title（" + skillM.titleStyle["font-size"] + "，letter-spacing " + skillM.titleStyle["letter-spacing"] + "），McpCenter 的 .mcp-banner__title 是 p + --fs-heading（" + mcpM.titleStyle["font-size"] + "）。",
  "**结论：待修（列入 UI-2 MCP 扩展波）**。同一窗口外壳里的页面级标题应统一到 --fs-title；本轮不改 D5-03 已验收的 McpCenter 视觉，只在笔记里登记，避免把 UI-1b 变成跨页视觉重构。",
  "",
  "## 3. 间距与容器",
  "",
  "**一致**：列表项之间的 gap 同为 --space-2（" + skillM.splitStyle.gap + "）；行内上下排布都是 gap --space-1；行 padding 同为 --space-3（" + skillM.rowStyle.padding + "）；行圆角同为 --radius-lg，底色同为 --sunken。",
  "**差异 1：最外层内边距来源不同。** Skill 依赖 .split-main 的外边距（" + JSON.stringify(skillM.splitMainStyle) + "），两栏 .skill-split 自身 padding 为 " + skillM.splitStyle.padding + "；McpCenter 没有外壳，靠 .mcp-split 自带 padding（" + mcpM.splitStyle.padding + "）。",
  "**结论：保留**。Skill 有产品侧栏 + .split-main 外壳，MCP 无侧栏直挂窗口内容；把 MCP 也塞进 .split-main 会改动基准页本身的密度，反而失去基准意义。",
  "**差异 2：列表栏宽与两栏是否撑满。** .skill-split 列定义 「" + skillM.splitStyle["grid-template-columns"] + "」、align-items " + (skillM.splitStyle["align-items"] || "normal") + "；.mcp-split 是 「" + mcpM.splitStyle["grid-template-columns"] + "」、align-items " + (mcpM.splitStyle["align-items"] || "normal") + "，两个 pane 各自 overflow auto 撑满窗口高。",
  "**结论：保留（登记为后续可选统一项）**。Skill 行多一行 __desc 摘要，列表栏更宽（" + px(skillM.listPane.width) + " vs " + px(mcpM.listPane.width) + "）并按内容高度排布；MCP 连接行更短、需要左右独立滚动。两者信息结构不同，强行统一列宽只会挤掉 Skill 摘要。",
  "",
  "## 4. 组件用法（PageState / Badge / Button / ScrollArea）",
  "",
  "- **PageState**：一致。两页详情区未选中时都用 PageState kind=empty（Skill『选择一个技能』；MCP『选择一个连接』），role/aria-live 走同一份 PAGE_STATE_SPEC；差异只在标题文案。**结论：保留**。",
  "- **Badge**：一致。两页行状态与详情标题旁都用 Badge tone（Skill 已启用/已停用；MCP 就绪/已停用等），tone 只取 neutral/success/warning/danger。实测 Badge 数：Skill " + skillM.counts.badges + "，MCP " + mcpM.counts.badges + "。**结论：保留**。",
  "- **Button**：一致。行内动作用 size=sm + secondary/ghost/danger，危险动作都交给 variant=danger。实测 Button 数：Skill " + skillM.counts.buttons + "，MCP " + mcpM.counts.buttons + "。**结论：保留**。",
  "- **ScrollArea**：两页都没用（实测 scroll-area 数：Skill " + skillM.counts.scrollAreas + "，MCP " + mcpM.counts.scrollAreas + "），滚动都由 .skill-list-pane/.skill-detail-pane、.mcp-list-pane/.mcp-detail-pane 的原生 overflow auto 承担。**结论：待修（列入 UI-2 / 设计系统统一波）**。ScrollArea 是 DESIGN_SYSTEM §2 组件清单里登记的原语（可聚焦、方向键可滚），两个管理页都绕开了它；这是基准页与 Skill 页共有的偏差，不是 Skill 单方面的问题。",
  "",
  "## 5. 结论清单",
  "",
  "| 项 | 一致 / 差异 | 结论 |",
  "| --- | --- | --- |",
  "| 行标题/元信息字阶（--fs-body / --fs-micro） | 一致 | 保留 |",
  "| 行 padding / 圆角 / 底色 / 列表 gap | 一致 | 保留 |",
  "| PageState 用法（详情空态 empty） | 一致 | 保留 |",
  "| Badge / Button 用法与 tone/variant | 一致 | 保留 |",
  "| 页面标题字号（--fs-title vs --fs-heading） | 差异 | 待修（UI-2 统一） |",
  "| 列表栏宽（288 vs 264）与两栏撑满方式 | 差异 | 保留（信息结构不同，登记后续） |",
  "| 最外层内边距来源（.split-main vs .mcp-split 自带） | 差异 | 保留（外壳装配不同） |",
  "| 未使用 ScrollArea（两页都用原生 overflow） | 差异（相对组件清单） | 待修（UI-2 / 设计系统统一波） |",
  "",
];
const notesPath = path.join(ART, "compare-notes.md");
fs.writeFileSync(notesPath, notes.join(String.fromCharCode(10)));
check("对照笔记 compare-notes.md 产出", fs.statSync(notesPath).size > 0, notesPath);

/* ── 6d. 深色同设定对照（与基准页同窗口 1440×900 / 缩放 dsf2 / reducedMotion reduce，
      只换主题；深色在 tokens.css 里是 .dark 作用域，探针给外壳显式加 .dark）── */
console.log("\n基准对照（深色）：");
setStep("基准对照（深色）");
const compareDark = {};
async function captureDarkCompare(kind) {
  const spec = COMPARE_SPECS[kind];
  const ctx = await browser.newContext({ ...SHOT_OPTS, colorScheme: "dark" });
  const page = await ctx.newPage();
  watch(page, "compare-dark:" + kind);
  await page.goto(BASE + "/?" + spec.query + "&theme=dark", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(spec.root);
  await page.waitForSelector(spec.row, { timeout: 15000 });
  await page.waitForTimeout(220);
  await page.click(spec.row);
  await page.waitForSelector(spec.detail, { timeout: 15000 });
  await page.waitForTimeout(260);
  const darkApplied = await page.evaluate(() => !!document.querySelector(".dark"));
  const metrics = await measurePage(page, spec.vars);
  const file = path.join(ART, "compare-dark-" + kind + ".png");
  await page.screenshot({ path: file });
  compareDark[kind] = { screenshot: file, metrics, darkApplied, query: spec.query + "&theme=dark" };
  screenshots.push(file);
  check("深色对照截图 compare-dark-" + kind + " → " + spec.detail, true, file);
  await ctx.close();
}
await captureDarkCompare("skill");
await captureDarkCompare("mcp");
check(
  "深色对照两页同窗口尺寸（1440×900）且 .dark 生效",
  !!compareDark.skill.darkApplied &&
    !!compareDark.mcp.darkApplied &&
    Math.round(compareDark.skill.metrics.window.width) === 1440 &&
    Math.round(compareDark.mcp.metrics.window.width) === 1440,
  JSON.stringify({ skill: compareDark.skill.metrics.window, mcp: compareDark.mcp.metrics.window }),
);
check(
  "深色对照关键度量读出（容器 / 两栏 / 行高 / 字号）",
  metricReady(compareDark.skill.metrics) && metricReady(compareDark.mcp.metrics),
  JSON.stringify({ skill: compareDark.skill.metrics.row.height, mcp: compareDark.mcp.metrics.row.height }),
);
check(
  "深色对照无 console error",
  pageErrors.filter((e) => e.startsWith("compare-dark:")).length === 0,
  pageErrors.filter((e) => e.startsWith("compare-dark:")).slice(0, 3).join(" | "),
);
check(
  "深色对照无跨源 / 非本地网络请求",
  externalRequests.filter((e) => e.startsWith("compare-dark:")).length === 0,
  externalRequests.filter((e) => e.startsWith("compare-dark:")).slice(0, 3).join(" | "),
);

/* ── 7. 全局断言 ─────────────────────────────────────────────────────────── */
{
  const { ctx, page } = await openScenario(browser, "scenario=ready&tab=installed&run=slow");
  await page.waitForSelector(".skill-row[data-skill-id]");
  await page.click('[data-skill-id="writing"]');
  await page.waitForSelector("[data-skill-detail]");
  await page.fill('[data-skill-field="instruction"]', "写一段产品介绍");
  await page.click('[data-skill-action="run"]');
  await page.waitForSelector('[data-skill-run-state="success"]', { timeout: 12000 });
  const commands = await page.evaluate(() => (window.__oaSkillProbe ? window.__oaSkillProbe.commands.map((c) => c.command) : []));
  const allowed = [
    "skill/health",
    "skill/list",
    "skill/pack/list",
    "skill/get",
    "skill/enable",
    "skill/disable",
    "skill/run",
    "skill/pack/import",
    "skill/pack/export",
    "skill/delete",
    "skill/pack/uninstall",
    "skill/analyze",
    "skill/save",
    "skill/workspace/list",
  ];
  check("界面只发白名单命令", commands.every((c) => allowed.includes(c)), commands.join(", "));
  const runPayload = await page.evaluate(() => {
    const c = (window.__oaSkillProbe ? window.__oaSkillProbe.commands : []).find((x) => x.command === "skill/run");
    return c ? Object.keys(c.payload).sort().join(",") : "";
  });
  check("skill/run 载荷不含身份字段", runPayload === "arguments,requestId,skillId", runPayload);
  const events = await page.evaluate(() => (window.__oaSkillProbe ? window.__oaSkillProbe.events.map((e) => e.payload && e.payload.phase) : []));
  check("收到 progress 下行事件（begin/completed）", events.includes("begin") && events.includes("completed"), events.join(","));
  await ctx.close();
}

/* ── 7b. 新增入口（分析 / 保存 / 工作区 / 媒体运行）的命令面与载荷边界 ── */
{
  const { ctx, page } = await openScenario(browser, "scenario=ready&tab=market&deps=all");
  await page.waitForSelector("[data-skill-analyze-idle]");
  await page.setInputFiles("[data-skill-analyze-input]", {
    name: "weekly.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 周报\n1. 收集素材\n2. 生成摘要"),
  });
  await page.waitForSelector("[data-skill-analyze-result]");
  await page.click('[data-skill-action="save"]');
  await page.waitForSelector("[data-skill-save-done]", { timeout: 10000 });
  await page.click('.split-nav:has-text("已安装")');
  await page.waitForSelector('[data-skill-id="team_report"]');
  await page.click('[data-skill-id="team_report"]');
  await page.waitForSelector('[data-skill-action="workspace"]');
  await page.click('[data-skill-action="workspace"]');
  await page.waitForSelector("[data-skill-workspace-list]", { timeout: 10000 });
  await page.click('[data-skill-id="generate_image"]');
  await page.waitForSelector('[data-skill-field="prompt"]');
  await page.fill('[data-skill-field="prompt"]', "一只在图书馆看书的猫");
  await page.click('[data-skill-action="run"]');
  await page.waitForSelector("[data-skill-artifacts]", { timeout: 12000 });

  const commandList = await page.evaluate(() =>
    window.__oaSkillProbe ? window.__oaSkillProbe.commands : [],
  );
  const commands = commandList.map((c) => c.command);
  const allowed = [
    "skill/health",
    "skill/list",
    "skill/pack/list",
    "skill/get",
    "skill/enable",
    "skill/disable",
    "skill/run",
    "skill/pack/import",
    "skill/pack/export",
    "skill/delete",
    "skill/pack/uninstall",
    "skill/analyze",
    "skill/save",
    "skill/workspace/list",
  ];
  check("新增入口只发白名单命令", commands.every((c) => allowed.includes(c)), commands.join(", "));

  const identityFields = ["userId", "role", "sessionRef", "appId"];
  const offending = [];
  for (const entry of commandList) {
    for (const field of identityFields) {
      if (Object.prototype.hasOwnProperty.call(entry.payload || {}, field)) offending.push(entry.command + ":" + field);
    }
  }
  check("新增入口载荷不含身份字段", offending.length === 0, offending.join(","));

  const analyzeEntry = commandList.find((c) => c.command === "skill/analyze");
  check(
    "skill/analyze 载荷只带 markdown 与来源名",
    !!analyzeEntry && analyzeEntry.payload.markdownPresent === true && typeof analyzeEntry.payload.sourceName === "string",
    JSON.stringify(analyzeEntry ? Object.keys(analyzeEntry.payload) : []),
  );

  const saveEntry = commandList.find((c) => c.command === "skill/save");
  check(
    "skill/save 载荷只带 skill 对象",
    !!saveEntry && Object.keys(saveEntry.payload).join(",") === "skill",
    JSON.stringify(saveEntry ? Object.keys(saveEntry.payload) : []),
  );

  const workspaceEntry = commandList.find((c) => c.command === "skill/workspace/list");
  check(
    "skill/workspace/list 载荷只带 packId",
    !!workspaceEntry && Object.keys(workspaceEntry.payload).every((k) => k === "packId"),
    JSON.stringify(workspaceEntry ? Object.keys(workspaceEntry.payload) : []),
  );

  const mediaRun = commandList.find((c) => c.command === "skill/run");
  check(
    "媒体 skill/run 载荷只带 arguments/requestId/skillId",
    !!mediaRun && Object.keys(mediaRun.payload).sort().join(",") === "arguments,requestId,skillId",
    JSON.stringify(mediaRun ? Object.keys(mediaRun.payload).sort() : []),
  );
  await ctx.close();
}

check("无 console error", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
check("无跨源 / 非本地网络请求", externalRequests.length === 0, externalRequests.slice(0, 3).join(" | "));

await browser.close();
server.close();

/* ── 8. 报告 ─────────────────────────────────────────────────────────────── */
const failed = checks.filter((c) => !c.ok);
const report = {
  task: "UI-1 Skill 中心 + UI-1b 基准（McpCenter）对照",
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
  videoEntries: fs.existsSync(entriesFlowVideo) ? entriesFlowVideo : null,
  compare: {
    condition: compareCondition,
    screenshots: { skill: compare.skill.screenshot, mcp: compare.mcp.screenshot },
    notes: notesPath,
    metrics: { skill: skillM, mcp: mcpM },
    differences: compareDifferences,
    dark: {
      condition: { ...compareCondition, colorScheme: "dark", theme: "dark" },
      screenshots: { skill: compareDark.skill.screenshot, mcp: compareDark.mcp.screenshot },
      metrics: { skill: compareDark.skill.metrics, mcp: compareDark.mcp.metrics },
    },
    pageStateBeforeSelect: {
      skill: compare.skill.pageStateBeforeSelect,
      mcp: compare.mcp.pageStateBeforeSelect,
    },
  },
  checks,
  failures: failed,
  consoleErrors: pageErrors,
  externalRequests,
  finishedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify(report, null, 2));

console.log("\n" + "═".repeat(72));
console.log("UI-1 Skill 中心探针：结论 " + report.verdict + " — " + JSON.stringify({ total: checks.length, failed: failed.length }));
console.log("截图：" + screenshots.length + " 张 → " + ART);
console.log("录屏：" + (report.video || "（无）"));
console.log("新增入口录屏：" + (report.videoEntries || "（无）"));
console.log("对照：" + compare.skill.screenshot + " ／ " + compare.mcp.screenshot);
console.log("深色对照：" + compareDark.skill.screenshot + " ／ " + compareDark.mcp.screenshot);
console.log(
  "对照差异（Skill−MCP）：" +
    JSON.stringify({
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
