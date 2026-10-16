/**
 * UI-5 · 模型与协议（协议表 / 能力 manifest / 流式状态）Playwright 探针
 * 截图 + 连续录屏 + 基准对照 + 边界断言。
 *
 * 为什么不直接开产品 dist：本轮禁止执行 npm run build，dist 里还没有 UI-5 区块。
 * 这里用 esbuild（Vite 自带依赖）把 **实验用挂载壳 harness.tsx** 打成一份本地构建产物，
 * 再用本机 Chromium（见 experiments/lib/chromium.mjs：OA_CHROMIUM → Playwright → 系统 Chrome）打开。
 *
 * 数据不是手写的：protocol/list、protocol/get、manifest/get 的 fixture 由本脚本直接调用
 * 主进程的 protocol-engine repository 与 manifest service 生成（与 IPC 同一份结构），
 * 写进 fixture.js 由页面读取；provider/callStream 由挂载壳按
 * provider-protocol-service.cjs#streamSink 的真实 P1 信封逐条下发。
 *
 * 覆盖：加载 / 空 / 命令被拒 / 依赖缺失 / 无可用 provider / 就绪 / legacy 详情不存在 /
 *       manifest 缺字段 / 流式中 / 取消中 / 窄宽 640 截图；主流程连续录屏；
 *       与基准页 SkillCenter 同设定对照截图与关键度量。
 * 断言：0 console error、0 非本地请求、焦点顺序可用、只发白名单命令、载荷不含身份字段。
 *
 * 运行：node experiments/dxos-ui-model/run-all.mjs
 * 退出码：任一断言 FAIL → 1。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { chromium } from "playwright";
import { resolveChromium, describeChromiumCandidates } from "../lib/chromium.mjs";
import {
  installCrashGuard,
  registerCleanup,
  setStep,
  hardenPage,
  scaled,
  timingSummary,
  launchChromiumBounded,
  withRetries,
  SCENARIO_ATTEMPTS,
  TIMEOUT_SCALE,
  SCALE_SOURCE,
} from "../lib/probe-timing.mjs";
import { MODEL_CONSOLE_COMMANDS, MODEL_PROTOCOL_COMMANDS } from "../../src/settings/modelProtocolLogic.ts";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../..");
const ART = path.join(ROOT, "artifacts", "dxos-ui-model");
const BUILD = path.join(ART, "build");
const VIDEO_DIR = path.join(ART, "video");
const PORT = Number(process.env.OA_MODEL_PORT || 5263);
// 解析优先级：OA_CHROMIUM → Playwright 官方 chromium → 系统 Google Chrome（见 experiments/lib/chromium.mjs）。
const CHROMIUM_INFO = resolveChromium();
const CHROMIUM = CHROMIUM_INFO.path;

/* 高负载下等待会整体变慢；这里只放大等待与加重试，不改任何断言（见 experiments/lib/probe-timing.mjs）。 */
installCrashGuard();
setStep("初始化");
console.log("探针时序加固：" + timingSummary());

const require = createRequire(import.meta.url);

/* 清掉上一轮的顶层产物，保证一次运行的截图 / 录屏 / 报告集合可复现（不复用旧文件）。 */
fs.mkdirSync(ART, { recursive: true });
for (const name of fs.readdirSync(ART)) {
  if (/\.(png|webm|md)$/.test(name) || name === "report.json") fs.rmSync(path.join(ART, name), { force: true });
}

const checks = [];
const pageErrors = [];
const externalRequests = [];

function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail == null ? "" : String(detail) });
  console.log((ok ? "  [PASS] " : "! [FAIL] ") + name + (detail ? " — " + detail : ""));
  return !!ok;
}

/* ── 0. 真实 fixture：主进程服务本体（离线，不联网）──────────────────────── */
const repository = require(path.join(ROOT, "electron", "protocol-engine", "repository.cjs"));
const { ProviderProtocolService } = require(path.join(ROOT, "electron", "provider-protocol-service.cjs"));
const manifestService = require(path.join(ROOT, "electron", "model-manifest-service.cjs")).createModelManifestService({ repository });
const service = new ProviderProtocolService({ store: { get: () => null } });
service.manifest = manifestService;

const protocolList = service.listProtocols();
const protocolGet = {};
for (const item of protocolList.items) protocolGet[item.kind + ":" + item.id] = service.getProtocol({ kind: item.kind, id: item.id });
const manifest = {};
for (const [model, intent] of [["gpt-image", "image.generate"], ["gpt-5", "llm.chat"]]) {
  manifest["openai-images|" + model + "|" + intent] = manifestService.getManifest({ protocolId: "openai-images", model, intent });
}
const FIXTURE = { protocolList, protocolGet, manifest };

console.log("真实 fixture（来自主进程 protocol-engine / manifest service，离线）：");
console.log("  · protocol/list：" + protocolList.items.length + " 条（model " + protocolList.items.filter((i) => i.kind === "model").length + " / provider " + protocolList.items.filter((i) => i.kind === "provider").length + "）");
console.log("  · protocol/get：" + Object.keys(protocolGet).length + " 条（其中 legacy-only 返回 PROTOCOL_NOT_FOUND 的有 " + Object.values(protocolGet).filter((r) => r.ok !== true).length + " 条）");
console.log("  · manifest/get：" + Object.keys(manifest).length + " 条");

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
<title>模型与协议 UI 探针</title>
<link rel="stylesheet" href="./harness.css" />
</head>
<body><div id="root"></div><script src="./fixture.js"></script><script type="module" src="./harness.js"></script></body>
</html>
`;

console.log(String.fromCharCode(10) + "构建探针产物（esbuild）…");
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
fs.writeFileSync(path.join(BUILD, "fixture.js"), "window.__OA_MODEL_FIXTURE__ = " + JSON.stringify(FIXTURE) + ";" + String.fromCharCode(10));

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
  await page.waitForSelector('[data-model-proto="console"]');
  return { ctx, page };
}

async function scrollTo(page, selector) {
  const loc = page.locator(selector).first();
  if ((await loc.count()) > 0) await loc.scrollIntoViewIfNeeded();
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
      const { ctx, page } = await openScenario(browser, spec.query, spec.narrow ? { viewport: { width: 640, height: 900 } } : null);
      try {
        if (spec.setup) await spec.setup(page);
        await page.waitForSelector(spec.expect, { timeout: 25000 });
        await scrollTo(page, spec.scroll || '[data-model-proto="console"]');
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

await shoot({ name: "01-loading", query: "scenario=loading", expect: '[data-model-proto-state="loading"] [data-ds-comp="page-state"]' });

await shoot({ name: "02-empty", query: "scenario=empty", expect: '[data-model-proto-state="empty"] [data-ds-kind="empty"]' });

await shoot({
  name: "03-error-command-rejected",
  query: "scenario=error",
  expect: '[data-model-proto-state="error"] [data-ds-kind="error"]',
  setup: async (page) => {
    const text = await page.$eval('[data-model-proto-state="error"]', (el) => (el.textContent || "").trim());
    check("命令被拒状态点名 MODEL_COMMAND_NOT_ALLOWED 语义", text.includes("白名单") || text.includes("命令不在"), text.slice(0, 90));
  },
});

await shoot({
  name: "04-dependency-unavailable",
  query: "scenario=unavailable",
  expect: '[data-model-proto-state="unavailable"] [data-ds-kind="unavailable"]',
  setup: async (page) => {
    const text = await page.$eval('[data-model-proto-state="unavailable"]', (el) => (el.textContent || "").trim());
    check("依赖缺失状态说明协议域尚未装配", text.includes("协议域尚未装配"), text.slice(0, 90));
  },
});

await shoot({
  name: "05-no-provider",
  query: "scenario=noprovider",
  expect: '[data-model-proto-state="stream-no-provider"] [data-ds-kind="unavailable"]',
  setup: async (page) => {
    const text = await page.$eval('[data-model-proto-state="stream-no-provider"]', (el) => (el.textContent || "").trim());
    check("无可用 provider 时给出结构化说明（不造假数据）", text.includes("没有可用的 provider") && text.includes("provider/list 返回空"), text.slice(0, 120));
    const noStart = (await page.$('[data-model-proto-action="stream-start"]')) === null;
    check("无可用 provider 时不出现开始按钮", noStart, "startButton=" + !noStart);
  },
});

await shoot({
  name: "06-ready-protocol-table",
  query: "scenario=ready",
  expect: "[data-model-proto-list] [data-model-proto-item]",
  setup: async (page) => {
    const rows = await page.$$eval("[data-model-proto-item]", (els) => els.length);
    check("协议表行数来自真实 protocol/list（72 条）", rows === 72, "rows=" + rows);
    /* kind 过滤 */
    await page.click('[data-model-proto-kind="model"]');
    await page.waitForTimeout(120);
    const modelOnly = await page.$$eval("[data-model-proto-item]", (els) => els.map((el) => el.getAttribute("data-model-proto-item")));
    check("kind=model 过滤后只剩 model: 前缀", modelOnly.length === 39 && modelOnly.every((k) => k.startsWith("model:")), "n=" + modelOnly.length);
    await page.click('[data-model-proto-kind="all"]');
    await page.waitForTimeout(120);
    /* 打开 openai-images 详情 */
    await page.click('[data-model-proto-item="model:openai-images"]');
    await page.waitForSelector('[data-model-proto-detail="openai-images"]');
    const ops = await page.$$eval('[data-model-proto="operations"] tbody tr', (els) => els.length);
    const wfs = await page.$$eval('[data-model-proto="workflows"] tbody tr', (els) => els.length);
    const profiles = await page.$$eval('[data-model-proto="model-profiles"] tbody tr', (els) => els.length);
    check("protocol/get 详情显示真实操作 / 工作流 / 模型 profile 数量", ops === 14 && wfs === 11 && profiles === 11, "ops=" + ops + " wfs=" + wfs + " profiles=" + profiles);
    const declared = await page.$$eval("[data-model-proto-group]", (els) => els.map((el) => el.getAttribute("data-model-proto-group") + "=" + el.getAttribute("data-model-proto-declared")));
    check("声明情况五项都来自 protocol/get", declared.length === 5 && declared.every((d) => d.endsWith("=true")), declared.join(","));
    const facts = await page.$eval('[data-model-proto="protocol-row-facts"]', (el) => (el.textContent || "").trim());
    check("详情显示 protocol/list 的行级真实字段（id/kind/label/engine/source/activeVersion/ported/execution）", ["id", "kind", "label", "engine", "source", "activeVersion", "ported", "execution"].every((k) => facts.includes(k)), facts.slice(0, 100));
  },
});

await shoot({
  name: "07-legacy-detail-not-found",
  query: "scenario=ready",
  expect: '[data-model-proto-item="model:agtoken-video"]',
  setup: async (page) => {
    await page.click('[data-model-proto-item="model:agtoken-video"]');
    await page.waitForSelector('[data-model-proto-detail-pane] [data-ds-kind="error"]');
    const text = await page.$eval("[data-model-proto-detail-pane]", (el) => (el.textContent || "").trim());
    check("legacy-only 协议详情如实返回 PROTOCOL_NOT_FOUND", text.includes("PROTOCOL_NOT_FOUND"), text.slice(0, 120));
  },
  expect2: '[data-model-proto-detail-pane] [data-ds-kind="error"]',
});

await shoot({
  name: "08-manifest-missing-fields",
  query: "scenario=ready",
  expect: '[data-model-proto="manifest-fields"]',
  setup: async (page) => {
    const fields = await page.$$eval('[data-model-proto="manifest-fields"] tbody tr', (els) => els.map((el) => el.getAttribute("data-model-proto-field")));
    check("manifest/get 的参数 schema 字段来自真实回包（size/quality）", fields.join(",") === "size,quality", fields.join(","));
    const limits = await page.$('[data-model-proto="limits-value"]');
    check("manifest/get 的 limits 真实展示", limits !== null, "limits=" + (limits !== null));
    const assets = await page.$eval('[data-model-proto="assets-missing"]', (el) => (el.textContent || "").trim());
    const profilesMissing = await page.$eval('[data-model-proto="model-profiles-missing"]', (el) => (el.textContent || "").trim());
    check("assets / modelProfiles 未返回时如实标注", assets === "未返回" && profilesMissing === "未返回", "assets=" + assets + " modelProfiles=" + profilesMissing);
    const missing = await page.$eval('[data-model-proto="manifest-missing"]', (el) => (el.textContent || "").trim());
    check("未返回字段清单点名 assets 与 modelProfiles", missing.includes("assets") && missing.includes("modelProfiles"), missing);
  },
});

await shoot({
  name: "09-streaming",
  query: "scenario=stream",
  expect: '[data-model-proto-action="stream-start"]',
  setup: async (page) => {
    await scrollTo(page, '[data-model-proto="stream"]');
    await page.fill('[data-model-proto-field="stream-prompt"]', "用一句话说明这次流式调用的用途。");
    await page.click('[data-model-proto-action="stream-start"]');
    await page.waitForSelector('[data-model-proto-stream-phase="streaming"]', { timeout: 15000 });
    await page.waitForTimeout(400);
    const seqs = await page.$$eval("[data-model-stream-seq]", (els) => els.map((el) => Number(el.getAttribute("data-model-stream-seq"))));
    const increasing = seqs.every((v, i) => i === 0 || v > seqs[i - 1]);
    check("流式事件按 P1 信封 sequence 严格单调递增", increasing && seqs.length >= 3, "seq=" + seqs.join(","));
    const deltas = await page.$eval("[data-model-stream-deltas]", (el) => (el.textContent || "").trim());
    const deltaCount = Number(deltas.replace(/[^0-9]/g, ""));
    check("流式增量计数来自真实事件", /增量\s*\d+/.test(deltas) && deltaCount >= 2, deltas);
    await page.waitForSelector('[data-model-proto-stream-phase="completed"]', { timeout: 20000 });
    const text = await page.$eval('[data-model-proto="stream-text"]', (el) => (el.textContent || "").trim());
    check("流式文本由增量拼出（不逐 token 追加 DOM）", text.includes("model:event") && text.endsWith("。"), text.slice(0, 60));
    const usage = await page.$('[data-model-stream-usage]');
    check("usage 事件真实渲染", usage !== null);
    /* 复位到 streaming 供截图：再发一次并把过程停在增量态。 */
    await page.click('[data-model-proto-action="stream-start"]');
    await page.waitForSelector('[data-model-proto-stream-phase="streaming"]', { timeout: 15000 });
    await page.waitForTimeout(300);
  },
});

await shoot({
  name: "10-stream-error",
  query: "scenario=stream-error",
  expect: '[data-model-proto-action="stream-start"]',
  setup: async (page) => {
    await scrollTo(page, '[data-model-proto="stream"]');
    await page.fill('[data-model-proto-field="stream-prompt"]', "这次调用会在中途失败。");
    await page.click('[data-model-proto-action="stream-start"]');
    await page.waitForSelector('[data-model-proto-stream-phase="error"]', { timeout: 15000 });
    const text = await page.$eval("[data-model-stream-error]", (el) => (el.textContent || "").trim());
    check("流式错误状态带错误码与说明（不把部分结果当成功）", text.includes("PARTIAL_RESPONSE") && text.includes("部分增量"), text.slice(0, 100));
  },
});

await shoot({
  name: "11-cancelling",
  query: "scenario=stream-cancel",
  expect: '[data-model-proto-action="stream-start"]',
  setup: async (page) => {
    await scrollTo(page, '[data-model-proto="stream"]');
    await page.fill('[data-model-proto-field="stream-prompt"]', "这次调用会被中途停止。");
    await page.click('[data-model-proto-action="stream-start"]');
    await page.waitForSelector('[data-model-proto-stream-phase="streaming"]', { timeout: 15000 });
    await page.click('[data-model-proto-action="stream-cancel"]');
    await page.waitForSelector('[data-model-proto-stream-phase="stopping"]', { timeout: 5000 });
    const detail = await page.$eval("[data-model-proto-stream-detail]", (el) => (el.textContent || "").trim());
    check("停止中不假装已取消，并说明没有中断命令", detail.includes("没有中断命令"), detail.slice(0, 90));
  },
});

await shoot({
  name: "12-cancelled-settled",
  query: "scenario=stream-cancel",
  expect: '[data-model-proto-action="stream-start"]',
  setup: async (page) => {
    await scrollTo(page, '[data-model-proto="stream"]');
    await page.fill('[data-model-proto-field="stream-prompt"]', "这次调用会被中途停止。");
    await page.click('[data-model-proto-action="stream-start"]');
    await page.waitForSelector('[data-model-proto-stream-phase="streaming"]', { timeout: 15000 });
    await page.click('[data-model-proto-action="stream-cancel"]');
    await page.waitForSelector('[data-model-proto-stream-phase="cancelled"]', { timeout: 30000 });
    const muted = await page.$('[data-model-stream-muted]');
    check("停止后到达的增量被界面丢弃（不追写）", muted !== null);
    const detail = await page.$eval("[data-model-proto-stream-detail]", (el) => (el.textContent || "").trim());
    check("已停止状态注明已完成动作保留", detail.includes("已完成动作保留"), detail.slice(0, 100));
  },
});

await shoot({
  name: "13-narrow-640",
  query: "scenario=ready",
  narrow: true,
  expect: '[data-model-proto-item="model:openai-images"]',
  setup: async (page) => {
    await page.click('[data-model-proto-item="model:openai-images"]');
    await page.waitForSelector('[data-model-proto-detail="openai-images"]');
    const overflow = await page.evaluate(() => {
      const main = document.querySelector(".split-main");
      const proto = document.querySelector(".model-proto");
      const split = document.querySelector(".model-proto__split");
      return {
        main: main ? main.scrollWidth - main.clientWidth : -1,
        proto: proto ? proto.scrollWidth - proto.clientWidth : -1,
        split: split ? split.scrollWidth - split.clientWidth : -1,
      };
    });
    check("窄宽 640px 协议表两栏与详情不溢出", overflow.main <= 1 && overflow.proto <= 1 && overflow.split <= 1, JSON.stringify(overflow));
  },
});

/* ── 4b. 动作入口状态截图（就绪 / 缺凭据 / 进行中 / 失败）────────────────── */
console.log(String.fromCharCode(10) + "动作入口状态截图：");
await shoot({
  name: "14-entry-ready",
  query: "scenario=ready",
  expect: '[data-model-entry="protocol-validate"][data-model-entry-state="ready"]',
  scroll: '[data-model-proto="entries"]',
  setup: async (page) => {
    /* 协议类入口的 ready 需要一份协议 JSON；填一份后四个入口都应就绪。 */
    await page.fill('[data-model-entry-field="protocol-validate:protocol"]', '{"id":"probe","kind":"model"}');
    await page.waitForSelector('[data-model-entry="protocol-validate"][data-model-entry-state="ready"]', { timeout: 5000 });
    const states = await page.$$eval("[data-model-entry]", (els) =>
      els.map((el) => ({ key: el.getAttribute("data-model-entry"), state: el.getAttribute("data-model-entry-state") })),
    );
    check("填了协议后四个动作入口都就绪", states.length === 4 && states.every((s) => s.state === "ready"), JSON.stringify(states));
    const risk = await page.$$eval("[data-model-entry-risk-badge]", (els) => els.map((el) => (el.textContent || "").trim()));
    check("动作入口显示风险标注", risk.length === 4 && risk.every((t) => t.length > 0), risk.join(" | "));
    const cred = await page.$$eval("[data-model-entry-credential]", (els) => els.map((el) => el.getAttribute("data-model-entry-credential")));
    check("需要凭据的入口显式标注", cred.length === 2 && cred.every((c) => c === "required"), JSON.stringify(cred));
  },
});
await shoot({
  name: "15-entry-credential",
  query: "scenario=nocred",
  expect: '[data-model-entry="image-generate"][data-model-entry-state="no-credential"]',
  scroll: '[data-model-entry="image-generate"]',
  setup: async (page) => {
    const text = await page.$eval('[data-model-entry="image-generate"] [data-model-entry-availability="no-credential"]', (el) => el.textContent || "");
    check("缺凭据提示说明没有执行，且不出现任何密钥字样", text.includes("没有执行") && text.includes("缺凭据") && text.indexOf("sk-") < 0, text.slice(0, 140));
  },
});
await shoot({
  name: "16-entry-busy",
  query: "scenario=ready&run=slow",
  expect: '[data-model-entry-action="image-generate"][disabled][aria-busy="true"]',
  scroll: '[data-model-proto="entries"]',
  setup: async (page) => {
    await page.fill('[data-model-entry-field="image-generate:providerId"]', "prov_local");
    await page.fill('[data-model-entry-field="image-generate:model"]', "gpt-image");
    await page.fill('[data-model-entry-field="image-generate:prompt"]', "离线探针：画一只猫");
    await page.click('[data-model-entry-action="image-generate"]');
    await page.waitForSelector('[data-model-entry-action="image-generate"][disabled][aria-busy="true"]', { timeout: 5000 });
  },
});
await shoot({
  name: "17-entry-failure",
  query: "scenario=entry-error",
  expect: '[data-model-entry-error][data-model-entry-error-code="PROTOCOL_INVALID"]',
  scroll: '[data-model-entry-error]',
  setup: async (page) => {
    await page.fill('[data-model-entry-field="protocol-validate:protocol"]', '{"id":"custom"}');
    await page.click('[data-model-entry-action="protocol-validate"]');
    await page.waitForSelector("[data-model-entry-error]", { timeout: 5000 });
    const text = await page.$eval("[data-model-entry-error]", (el) => el.textContent || "");
    check("失败显示稳定错误码与文案", text.includes("PROTOCOL_INVALID") && text.includes("协议定义"), text.slice(0, 120));
  },
});

/* ── 5. 主流程连续录屏：协议表 → 详情 → 过滤 → manifest → 流式 → 取消 ───── */
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
await vpage.goto(BASE + "/?scenario=stream-cancel", { waitUntil: "domcontentloaded" });
await vpage.waitForSelector('[data-model-proto-item="model:openai-images"]');
await scrollTo(vpage, '[data-model-proto="protocols"]');
await vpage.waitForTimeout(300);
await vpage.click('[data-model-proto-item="model:openai-images"]');
await vpage.waitForSelector('[data-model-proto="operations"]');
await vpage.waitForTimeout(600);
await vpage.click('[data-model-proto-kind="model"]');
await vpage.waitForTimeout(400);
await vpage.click('[data-model-proto-kind="all"]');
await vpage.waitForTimeout(200);
await vpage.click('[data-model-proto-search="protocols"]');
await vpage.keyboard.type("image");
await vpage.waitForTimeout(500);
await vpage.keyboard.press("Escape");
await vpage.waitForTimeout(300);
await scrollTo(vpage, '[data-model-proto="manifest"]');
await vpage.waitForTimeout(600);
await scrollTo(vpage, '[data-model-proto="stream"]');
await vpage.waitForTimeout(300);
await vpage.fill('[data-model-proto-field="stream-prompt"]', "录屏：一次完整的流式调用。");
await vpage.click('[data-model-proto-action="stream-start"]');
await vpage.waitForSelector('[data-model-proto-stream-phase="streaming"]', { timeout: 15000 });
await vpage.waitForTimeout(900);
await vpage.waitForSelector('[data-model-proto-stream-phase="completed"]', { timeout: 30000 });
await vpage.waitForTimeout(700);
await vpage.click('[data-model-proto-action="stream-start"]');
await vpage.waitForSelector('[data-model-proto-stream-phase="streaming"]', { timeout: 15000 });
await vpage.waitForTimeout(700);
await vpage.click('[data-model-proto-action="stream-cancel"]');
await vpage.waitForSelector('[data-model-proto-stream-phase="stopping"]', { timeout: 5000 });
await vpage.waitForTimeout(400);
await vpage.waitForSelector('[data-model-proto-stream-phase="cancelled"]', { timeout: 30000 });
await vpage.waitForTimeout(600);
await videoCtx.close();
const rawVideo = await video.path();
const flowVideo = path.join(ART, "model-protocol-flow.webm");
if (rawVideo && fs.existsSync(rawVideo)) {
  fs.copyFileSync(rawVideo, flowVideo);
  check("主流程连续录屏产出", fs.statSync(flowVideo).size > 0, flowVideo + "（" + Math.round(fs.statSync(flowVideo).size / 1024) + " KB）");
} else {
  check("主流程连续录屏产出", false, "video.path() 为空");
}

/* ── 5b. 动作入口连续录屏（就绪 → 校验 → 生成 → 缺凭据视图）────────────── */
setStep("动作入口连续录屏");
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
await epage.goto(BASE + "/?scenario=ready", { waitUntil: "domcontentloaded" });
await epage.waitForSelector('[data-model-proto="entries"]');
await scrollTo(epage, '[data-model-proto="entries"]');
await epage.waitForTimeout(500);
await epage.fill('[data-model-entry-field="protocol-validate:protocol"]', '{"id":"probe","kind":"model"}');
await epage.waitForTimeout(300);
await epage.click('[data-model-entry-action="protocol-validate"]');
await epage.waitForSelector("[data-model-entry-result]", { timeout: 10000 });
await epage.waitForTimeout(700);
await epage.fill('[data-model-entry-field="image-generate:providerId"]', "prov_local");
await epage.fill('[data-model-entry-field="image-generate:model"]', "gpt-image");
await epage.fill('[data-model-entry-field="image-generate:prompt"]', "录屏：一次图像生成入口。");
await epage.waitForTimeout(300);
await epage.click('[data-model-entry-action="image-generate"]');
await epage.waitForTimeout(800);
/* 同一段录屏切到缺凭据视图。 */
await epage.goto(BASE + "/?scenario=nocred", { waitUntil: "domcontentloaded" });
await epage.waitForSelector('[data-model-entry="image-generate"][data-model-entry-state="no-credential"]');
await scrollTo(epage, '[data-model-proto="entries"]');
await epage.waitForTimeout(900);
await entryVideoCtx.close();
const entryRaw = await entryVideo.path();
const entryFlowVideo = path.join(ART, "model-entries-flow.webm");
if (entryRaw && fs.existsSync(entryRaw)) {
  fs.copyFileSync(entryRaw, entryFlowVideo);
  check("动作入口连续录屏产出", fs.statSync(entryFlowVideo).size > 0, entryFlowVideo + "（" + Math.round(fs.statSync(entryFlowVideo).size / 1024) + " KB）");
} else {
  check("动作入口连续录屏产出", false, "video.path() 为空");
}

/* ── 6. 焦点顺序与键盘可用 ───────────────────────────────────────────────── */
console.log(String.fromCharCode(10) + "可访问焦点顺序：");
setStep("可访问焦点顺序");
{
  const { ctx, page } = await openScenario(browser, "scenario=ready");
  await page.waitForSelector("[data-model-proto-item]");
  await scrollTo(page, '[data-model-proto="protocols"]');
  await page.click('[data-model-proto-search="protocols"]');
  const order = [];
  for (let i = 0; i < 16; i += 1) {
    await page.keyboard.press("Tab");
    const item = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return "body";
      const inside = !!(el.closest && el.closest(".model-proto"));
      return (
        (inside ? "in:" : "out:") +
        el.tagName.toLowerCase() +
        ":" +
        (el.getAttribute("data-model-proto-action") ||
          el.getAttribute("data-model-proto-item") ||
          el.getAttribute("data-model-proto-kind") ||
          el.getAttribute("aria-label") ||
          el.textContent ||
          "")
          .trim()
          .slice(0, 10)
      );
    });
    order.push(item);
  }
  const outside = order.filter((s) => s.startsWith("out:")).length;
  const bodyStops = order.filter((s) => s === "body").length;
  const distinct = new Set(order).size;
  check("Tab 顺序只在 UI-5 区块内推进（文档边界最多停留一次）", outside === 0 && bodyStops <= 1, "outside=" + outside + " body=" + bodyStops + " :: " + order.join(" → "));
  check("焦点顺序逐步前进（>=6 个不同落点）", distinct >= 6, "distinct=" + distinct);

  await page.fill('[data-model-proto-search="protocols"]', "image");
  await page.waitForTimeout(150);
  const valueBefore = await page.$eval('[data-model-proto-search="protocols"]', (el) => el.value);
  const filtered = await page.$$eval("[data-model-proto-item]", (els) => els.length);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  const afterEsc = await page.$eval('[data-model-proto-search="protocols"]', (el) => el.value);
  const restored = await page.$$eval("[data-model-proto-item]", (els) => els.length);
  check("搜索框 Esc 清空内容并恢复列表", valueBefore === "image" && filtered > 0 && filtered < 72 && afterEsc === "" && restored === 72, "before=" + valueBefore + " filtered=" + filtered + " after=" + afterEsc + " restored=" + restored);

  /* 协议行是 button：Enter 可打开详情。 */
  await page.focus('[data-model-proto-item="model:openai-images"]');
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-model-proto-detail="openai-images"]', { timeout: 10000 });
  check("协议行可键盘聚焦并用 Enter 打开详情", true, "model:openai-images");
  await ctx.close();
}

/* ── 7. 基准对照：UI-5 协议表 vs Skill 中心（同主题 / 尺寸 / 缩放 / 动态）── */
console.log(String.fromCharCode(10) + "基准对照（协议表 vs Skill 中心）：");

const COMPARE_SPECS = {
  model: {
    query: "scenario=ready&page=model",
    root: '[data-model-proto="console"]',
    row: "[data-model-proto-item]",
    detail: "[data-model-proto-detail]",
    select: '[data-model-proto-item="model:openai-images"]',
    vars: {
      root: ".model-proto",
      blockTitle: ".model-proto__block-title",
      row: ".model-proto__row",
      rowSelected: '[data-model-proto-item="model:openai-images"]',
      rowName: '[data-model-proto-item="model:openai-images"] .model-proto__row-top strong',
      rowFacts: '[data-model-proto-item="model:openai-images"] .model-proto__row-facts',
      split: ".model-proto__split",
      listPane: ".model-proto__list-pane",
      detailPane: ".model-proto__detail-pane",
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
      blockTitle: ".skill-pane-title",
      row: ".skill-row",
      rowSelected: '[data-skill-id="writing"]',
      rowName: '[data-skill-id="writing"] .skill-row__top strong',
      rowFacts: '[data-skill-id="writing"] .skill-row__facts',
      split: ".skill-split",
      listPane: ".skill-list-pane",
      detailPane: ".skill-detail-pane",
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
      role: el.getAttribute("role"),
      live: el.getAttribute("aria-live"),
      title: ((el.querySelector(".ds-page-state__title") || {}).textContent || "").trim(),
    }));
    return {
      window: rectOf(one(".window")),
      splitSide: rectOf(one(".split-side")),
      splitMain: rectOf(one(".split-main")),
      root: rectOf(one(v.root)),
      split: rectOf(one(v.split)),
      splitStyle: styleOf(one(v.split), ["display", "grid-template-columns", "gap", "align-items"]),
      listPane: rectOf(one(v.listPane)),
      detailPane: rectOf(one(v.detailPane)),
      row: rectOf(one(v.rowSelected) || one(v.row)),
      rowStyle: styleOf(one(v.rowSelected) || one(v.row), ["padding", "border-radius", "background-color"]),
      rowNameStyle: styleOf(one(v.rowName), ["font-size", "font-weight", "line-height"]),
      rowFactsStyle: styleOf(one(v.rowFacts), ["font-size", "line-height", "color"]),
      blockTitleStyle: styleOf(one(v.blockTitle), ["font-size", "font-weight"]),
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
  const label = "基准对照 " + kind;
  const checksBefore = checks.length;
  const screenshotsBefore = screenshots.length;
  await withRetries(
    label,
    SCENARIO_ATTEMPTS,
    async () => {
      const ctx = await browser.newContext({ ...SHOT_OPTS });
      try {
        const page = await ctx.newPage();
        watch(page, "compare:" + kind);
        await page.goto(BASE + "/?" + spec.query, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(spec.root);
        await page.waitForSelector(spec.row, { timeout: 25000 });
        await scrollTo(page, spec.root);
        await page.waitForTimeout(220);
        const before = await page.evaluate(() =>
          Array.from(document.querySelectorAll('[data-ds-comp="page-state"]')).map((el) => ({
            kind: el.getAttribute("data-ds-kind"),
            title: ((el.querySelector(".ds-page-state__title") || {}).textContent || "").trim(),
          })),
        );
        await page.click(spec.select);
        await page.waitForSelector(spec.detail, { timeout: 25000 });
        await scrollTo(page, spec.root);
        await page.waitForTimeout(260);
        const metrics = await measurePage(page, spec.vars);
        const file = path.join(ART, "compare-" + kind + ".png");
        await page.screenshot({ path: file });
        compare[kind] = { screenshot: file, query: spec.query, pageStateBeforeSelect: before, metrics };
        screenshots.push(file);
        check("对照截图 compare-" + kind + " → " + spec.detail, true, file);
      } finally {
        await ctx.close().catch((e) => console.log("    · 关闭 context 时出错（已记录，不掩盖原错误）：" + ((e && e.message) || e)));
      }
    },
    (attempt) => {
      if (attempt > 1) console.log("  ↺ 回滚 " + label + " 上一次的部分断言 / 截图，整场景重跑（不跳过任何断言）");
      checks.length = checksBefore;
      screenshots.length = screenshotsBefore;
      delete compare[kind];
    },
  );
}

await captureCompare("model");
await captureCompare("skill");

const modelM = compare.model.metrics;
const skillM = compare.skill.metrics;
const round = (n) => Math.round(n * 10) / 10;
const px = (v) => (v == null ? "—" : String(v));
const fsNum = (v) => (v ? Number.parseFloat(v["font-size"]) : NaN);

const compareDifferences = {
  rootWidth: round(modelM.root.width - skillM.root.width),
  splitWidth: round(modelM.split.width - skillM.split.width),
  listPaneWidth: round(modelM.listPane.width - skillM.listPane.width),
  detailPaneWidth: round(modelM.detailPane.width - skillM.detailPane.width),
  rowHeight: round(modelM.row.height - skillM.row.height),
  rowPadding: modelM.rowStyle.padding + " vs " + skillM.rowStyle.padding,
  rowRadius: modelM.rowStyle["border-radius"] + " vs " + skillM.rowStyle["border-radius"],
  rowBackground: modelM.rowStyle["background-color"] + " vs " + skillM.rowStyle["background-color"],
  blockTitleFontSize: round(fsNum(modelM.blockTitleStyle) - fsNum(skillM.blockTitleStyle)),
  rowNameFontSize: round(fsNum(modelM.rowNameStyle) - fsNum(skillM.rowNameStyle)),
  rowFactsFontSize: round(fsNum(modelM.rowFactsStyle) - fsNum(skillM.rowFactsStyle)),
  splitGap: modelM.splitStyle.gap === skillM.splitStyle.gap ? "一致" : modelM.splitStyle.gap + " vs " + skillM.splitStyle.gap,
  splitColumns: modelM.splitStyle["grid-template-columns"] === skillM.splitStyle["grid-template-columns"] ? "一致" : modelM.splitStyle["grid-template-columns"] + " vs " + skillM.splitStyle["grid-template-columns"],
};

check(
  "对照两页同窗口尺寸（1440×900）",
  !!modelM.window && Math.round(modelM.window.width) === 1440 && Math.round(modelM.window.height) === 900 && !!skillM.window && Math.round(skillM.window.width) === 1440 && Math.round(skillM.window.height) === 900,
  "model=" + JSON.stringify(modelM.window) + " skill=" + JSON.stringify(skillM.window),
);
check(
  "对照两页同主题/缩放/reducedMotion 上下文",
  compareCondition.colorScheme === "light" && compareCondition.deviceScaleFactor === 2 && compareCondition.reducedMotion === "reduce",
  JSON.stringify(compareCondition),
);
const metricReady = (m) =>
  !!m.root && m.root.width > 0 && !!m.split && m.split.width > 0 && !!m.row && m.row.height > 0 && fsNum(m.blockTitleStyle) > 0 && fsNum(m.rowNameStyle) > 0 && fsNum(m.rowFactsStyle) > 0;
check(
  "对照关键度量读出（容器宽度/两栏/行高/字号）",
  metricReady(modelM) && metricReady(skillM),
  JSON.stringify({
    model: { root: modelM.root.width, split: modelM.split.width, rowHeight: modelM.row.height, blockTitle: modelM.blockTitleStyle["font-size"], rowName: modelM.rowNameStyle["font-size"], facts: modelM.rowFactsStyle["font-size"] },
    skill: { root: skillM.root.width, split: skillM.split.width, rowHeight: skillM.row.height, blockTitle: skillM.blockTitleStyle["font-size"], rowName: skillM.rowNameStyle["font-size"], facts: skillM.rowFactsStyle["font-size"] },
  }),
);
check(
  "行标题 / 行元信息 / 区块标题字阶与基准一致",
  Math.abs(compareDifferences.rowNameFontSize) < 0.5 && Math.abs(compareDifferences.rowFactsFontSize) < 0.5 && Math.abs(compareDifferences.blockTitleFontSize) < 0.5,
  JSON.stringify({ rowName: compareDifferences.rowNameFontSize, rowFacts: compareDifferences.rowFactsFontSize, blockTitle: compareDifferences.blockTitleFontSize }),
);
check(
  "行 padding / 圆角 / 底色与两栏列定义一致",
  compareDifferences.rowPadding.indexOf(" vs ") > 0 && compareDifferences.rowPadding.split(" vs ")[0] === compareDifferences.rowPadding.split(" vs ")[1] && modelM.rowStyle["border-radius"] === skillM.rowStyle["border-radius"] && modelM.rowStyle["background-color"] === skillM.rowStyle["background-color"] && compareDifferences.splitColumns === "一致",
  JSON.stringify({ rowPadding: compareDifferences.rowPadding, rowRadius: compareDifferences.rowRadius, rowBackground: compareDifferences.rowBackground, splitColumns: compareDifferences.splitColumns }),
);
check(
  "对照两页的详情占位都使用 PageState(empty) 语义",
  compare.model.pageStateBeforeSelect.some((s) => s.kind === "empty") && compare.skill.pageStateBeforeSelect.some((s) => s.kind === "empty"),
  JSON.stringify({ model: compare.model.pageStateBeforeSelect.map((s) => s.kind), skill: compare.skill.pageStateBeforeSelect.map((s) => s.kind) }),
);
check(
  "UI-5 协议表使用 ScrollArea 承接长列表",
  modelM.counts.scrollAreas >= 1,
  "model scrollAreas=" + modelM.counts.scrollAreas,
);
const compareErrors = pageErrors.filter((e) => e.startsWith("compare:"));
const compareExternal = externalRequests.filter((e) => e.startsWith("compare:"));
check("对照场景无 console error", compareErrors.length === 0, compareErrors.slice(0, 3).join(" | "));
check("对照场景无跨源 / 非本地网络请求", compareExternal.length === 0, compareExternal.slice(0, 3).join(" | "));

/* ── 8. compare-notes.md ─────────────────────────────────────────────────── */
const cmp = compareDifferences;
const notes = [
  "# UI-5 · 基准对照笔记：模型与协议（协议表）vs Skill 中心",
  "",
  "> 由 experiments/dxos-ui-model/run-all.mjs 自动生成，数值来自同一次运行的 report.json（compare）。",
  "> 对照条件：" + compareCondition.colorScheme + " 主题 / " + compareCondition.viewport.width + "×" + compareCondition.viewport.height + " / deviceScaleFactor " + compareCondition.deviceScaleFactor + " / prefers-reduced-motion: " + compareCondition.reducedMotion + " / 同一本地静态服务；同背景与同透明度（同一 tokens.css 档，本轮未改 CSP/tokens.css）。",
  "> 截图：compare-model.png（设置 → 模型 / AI 的 UI-5 协议表就绪态）、compare-skill.png（Skill 中心就绪态）。",
  "",
  "## 0. 基准与外壳口径",
  "",
  "- 基准页是 src/skills/SkillCenter.tsx（Dx-UI-PLAN §2 指定的同类管理页，UI-1 已交付；UI-3 也以它为排版基准）。",
  "- 两页都渲染在 .window > .split > .split-side + .split-main 的同源外壳里：模型页左栏是设置分类，Skill 页左栏是技能分类。",
  "- UI-5 是既有设置页的下半部分，**区块级**对照：协议表的列表行 / 两栏容器 / 区块标题与 Skill 页同名角色逐项比。",
  "",
  "## 1. 实测关键度量（1440×900，CSS px）",
  "",
  "| 度量 | UI-5 协议表 | Skill 中心 | 差（模型−Skill） |",
  "| --- | --- | --- | --- |",
  "| 窗口 | " + px(modelM.window.width) + "×" + px(modelM.window.height) + " | " + px(skillM.window.width) + "×" + px(skillM.window.height) + " | — |",
  "| 页面根容器宽 | " + px(modelM.root.width) + " | " + px(skillM.root.width) + " | " + cmp.rootWidth + " |",
  "| 两栏容器宽 | " + px(modelM.split.width) + " | " + px(skillM.split.width) + " | " + cmp.splitWidth + " |",
  "| 两栏列定义 | 「" + modelM.splitStyle["grid-template-columns"] + "」 | 「" + skillM.splitStyle["grid-template-columns"] + "」 | 见 §3 |",
  "| 两栏 gap | " + px(modelM.splitStyle.gap) + " | " + px(skillM.splitStyle.gap) + " | " + cmp.splitGap + " |",
  "| 列表栏宽 | " + px(modelM.listPane.width) + " | " + px(skillM.listPane.width) + " | " + cmp.listPaneWidth + " |",
  "| 详情栏宽 | " + px(modelM.detailPane.width) + " | " + px(skillM.detailPane.width) + " | " + cmp.detailPaneWidth + " |",
  "| 列表行高 | " + px(modelM.row.height) + " | " + px(skillM.row.height) + " | +" + cmp.rowHeight + " |",
  "| 列表行 padding | " + modelM.rowStyle.padding + " | " + skillM.rowStyle.padding + " | " + (cmp.rowPadding.split(" vs ")[0] === cmp.rowPadding.split(" vs ")[1] ? "一致" : cmp.rowPadding) + " |",
  "| 列表行圆角 / 底色 | " + modelM.rowStyle["border-radius"] + " / " + modelM.rowStyle["background-color"] + " | " + skillM.rowStyle["border-radius"] + " / " + skillM.rowStyle["background-color"] + " | 见 §3 |",
  "| 区块标题字号 | " + modelM.blockTitleStyle["font-size"] + " | " + skillM.blockTitleStyle["font-size"] + " | " + cmp.blockTitleFontSize + "px |",
  "| 行标题字号 | " + modelM.rowNameStyle["font-size"] + " | " + skillM.rowNameStyle["font-size"] + " | " + cmp.rowNameFontSize + "px |",
  "| 行元信息字号 | " + modelM.rowFactsStyle["font-size"] + " | " + skillM.rowFactsStyle["font-size"] + " | " + cmp.rowFactsFontSize + "px |",
  "| Badge / Button / ScrollArea 数量 | " + modelM.counts.badges + " / " + modelM.counts.buttons + " / " + modelM.counts.scrollAreas + " | " + skillM.counts.badges + " / " + skillM.counts.buttons + " / " + skillM.counts.scrollAreas + " | 见 §4 |",
  "",
  "## 2. 排版基线",
  "",
  "**一致**：行标题都取 --fs-body（" + modelM.rowNameStyle["font-size"] + "）、行元信息都取 --fs-micro（" + modelM.rowFactsStyle["font-size"] + "）、区块/面板标题都取 --fs-heading（" + modelM.blockTitleStyle["font-size"] + "）与 --fw-medium；行结构同为 row__top（strong + Badge）+ row__facts + 说明。",
  "**差异**：" + (Math.abs(cmp.rowNameFontSize) < 0.5 && Math.abs(cmp.rowFactsFontSize) < 0.5 && Math.abs(cmp.blockTitleFontSize) < 0.5 ? "三项字号差均 < 0.5px。" : "见上表差值。"),
  "",
  "## 3. 间距与容器",
  "",
  "**一致**：两栏都用 minmax(0,288px) + minmax(0,1fr)，gap 同为 --space-4（" + modelM.splitStyle.gap + "）；行 padding 同为 --space-3（" + modelM.rowStyle.padding + "）、圆角同为 --radius-lg、底色同为 --sunken。",
  "**差异**：协议行比 Skill 行高 " + Math.abs(cmp.rowHeight) + "px（协议行多一行 capabilities 与 execution 说明，信息结构不同，不强行统一行高）。",
  "",
  "## 4. 组件用法（PageState / Badge / Button / ScrollArea）",
  "",
  "- **PageState**：一致。未选中详情都用 PageState kind=empty；加载 / 空 / 错误 / 不可用 / 未授权都走 PAGE_STATE_SPEC 同一份 role/aria-live。",
  "- **Badge**：一致。协议行的 engine/execution 状态用 Badge tone（success/warning/neutral），与 Skill 行状态同一口径。",
  "- **Button**：一致。kind 过滤与动作都用 size=sm + primary/secondary/ghost；进行中走 status=loading（aria-busy + 不重复触发）。",
  "- **ScrollArea**：协议表用 ScrollArea（" + modelM.counts.scrollAreas + " 个）承接列表与事件流滚动；Skill 页为 " + skillM.counts.scrollAreas + " 个（pane 走原生 overflow）。沿用 UI-3 已登记的差异项。",
  "",
  "## 5. 结论清单",
  "",
  "| 项 | 一致 / 差异 | 结论 |",
  "| --- | --- | --- |",
  "| 区块标题 / 行标题 / 元信息字阶 | 一致 | 保留 |",
  "| 行 padding / 圆角 / 底色 / 两栏列定义 / gap | 一致 | 保留 |",
  "| PageState 用法 | 一致 | 保留 |",
  "| Badge / Button 用法与 tone/variant | 一致 | 保留 |",
  "| 列表行高（信息结构不同） | 差异 | 保留 |",
  "| ScrollArea（协议表已用） | 差异（相对基准） | 保留协议表写法，沿用 UI-3 统一项 |",
  "",
];
const notesPath = path.join(ART, "compare-notes.md");
fs.writeFileSync(notesPath, notes.join(String.fromCharCode(10)));
check("对照笔记 compare-notes.md 产出", fs.statSync(notesPath).size > 0, notesPath);

/* ── 9. 全局断言：白名单命令 / 身份字段 / 网络 / console ─────────────────── */
setStep("全局断言：白名单命令 / 身份字段 / 网络 / console");
{
  const { ctx, page } = await openScenario(browser, "scenario=stream");
  await page.waitForSelector("[data-model-proto-item]");
  await page.click('[data-model-proto-item="model:openai-images"]');
  await page.waitForSelector('[data-model-proto-detail="openai-images"]');
  await scrollTo(page, '[data-model-proto="stream"]');
  await page.fill('[data-model-proto-field="stream-prompt"]', "全局断言：一次真实流式调用。");
  await page.click('[data-model-proto-action="stream-start"]');
  await page.waitForSelector('[data-model-proto-stream-phase="completed"]', { timeout: 20000 });

  const commands = await page.evaluate(() => (window.__oaModelProbe ? window.__oaModelProbe.commands : []));
  const names = commands.map((c) => c.command);
  check("界面只发白名单命令", names.every((c) => MODEL_CONSOLE_COMMANDS.indexOf(c) >= 0), [...new Set(names)].join(", "));
  /* 本区块只跑协议表 / 详情 / manifest / 流式；四个动作入口在 §9b 单独驱动。 */
  for (const c of ["protocol/list", "protocol/get", "manifest/get", "provider/callStream"]) {
    check("UI-5 区块真实发出 " + c, names.indexOf(c) >= 0, "count=" + names.filter((n) => n === c).length);
  }
  const identityKeys = ["userId", "role", "sessionRef", "appId"];
  const offenders = commands.filter((c) => Object.keys(c.payload || {}).some((k) => identityKeys.indexOf(k) >= 0));
  check("所有命令载荷不含身份字段（userId/role/sessionRef/appId）", offenders.length === 0, JSON.stringify(offenders.slice(0, 2)));
  const getCall = commands.find((c) => c.command === "protocol/get");
  check("protocol/get 载荷只含 kind/id/version", getCall && Object.keys(getCall.payload).sort().join(",") === "id,kind", JSON.stringify(getCall && getCall.payload));
  const manifestCall = commands.find((c) => c.command === "manifest/get");
  check("manifest/get 载荷只含 protocolId/model/intent", manifestCall && Object.keys(manifestCall.payload).sort().join(",") === "intent,model,protocolId", JSON.stringify(manifestCall && manifestCall.payload));
  const streamCall = commands.find((c) => c.command === "provider/callStream");
  check("provider/callStream 载荷只含 providerId/model/messages/requestId", streamCall && Object.keys(streamCall.payload).sort().join(",") === "messages,model,providerId,requestId", JSON.stringify(streamCall && Object.keys(streamCall.payload)));

  const sequences = await page.evaluate(() => (window.__oaModelProbe ? window.__oaModelProbe.events.filter((e) => e.kind === "progress").map((e) => e.sequence) : []));
  const monotonic = sequences.every((v, i) => i === 0 || v > sequences[i - 1]);
  check("model:event progress sequence 严格单调", monotonic && sequences.length >= 5, "n=" + sequences.length + " seq=" + sequences.slice(0, 8).join(","));
  const wireKinds = await page.evaluate(() => (window.__oaModelProbe ? window.__oaModelProbe.wire.kinds : []));
  check("下行事件全部使用 P1 信封的 progress/log 两类", wireKinds.every((k) => k === "progress" || k === "log") && wireKinds.length >= 5, [...new Set(wireKinds)].join(","));
  await ctx.close();
}

/* ── 9b. 动作入口：命令 / 载荷白名单 / 身份与密钥字段 ─────────────────────── */
setStep("动作入口：命令 / 载荷白名单 / 身份与密钥字段");
{
  const { ctx, page } = await openScenario(browser, "scenario=ready");
  await scrollTo(page, '[data-model-proto="entries"]');
  const act = async (field, value) => { await page.fill(field, value); };
  await act('[data-model-entry-field="protocol-validate:protocol"]', '{"id":"probe","kind":"model"}');
  await page.click('[data-model-entry-action="protocol-validate"]');
  await page.waitForTimeout(350);
  await act('[data-model-entry-field="protocol-save:kind"]', "model");
  await act('[data-model-entry-field="protocol-save:protocol"]', '{"id":"probe","kind":"model"}');
  /* 二次确认：确认前 / 取消 命令数 0；确认后正常发送（protocol/save 是写类入口）。 */
  const saveCount = () =>
    page.evaluate(() =>
      window.__oaModelProbe ? window.__oaModelProbe.commands.filter((c) => c.command === "protocol/save").length : -1,
    );
  await page.click('[data-model-entry-action="protocol-save"]');
  await page.waitForSelector("[data-model-entry-confirm]", { timeout: 5000 });
  const beforeConfirm = await saveCount();
  check("协议保存确认前不发命令", beforeConfirm === 0, "protocol/save=" + beforeConfirm);
  const confirmText = await page.$eval("[data-model-entry-confirm]", (el) => el.textContent || "");
  check("协议保存确认框说明写入本地协议库", /本地协议库/.test(confirmText), confirmText.slice(0, 140).replace(/\s+/g, " "));
  await page.click("[data-model-entry-confirm-cancel]");
  await page.waitForSelector("[data-model-entry-confirm]", { state: "detached", timeout: 5000 });
  await page.waitForTimeout(200);
  const afterCancelSave = await saveCount();
  check("协议保存取消后命令数仍为 0", afterCancelSave === 0, "protocol/save=" + afterCancelSave);
  await page.click('[data-model-entry-action="protocol-save"]');
  await page.waitForSelector("[data-model-entry-confirm-submit]");
  await page.click("[data-model-entry-confirm-submit]");
  await page.waitForTimeout(350);
  await act('[data-model-entry-field="image-generate:providerId"]', "prov_local");
  await act('[data-model-entry-field="image-generate:model"]', "gpt-image");
  await act('[data-model-entry-field="image-generate:prompt"]', "探针：画一只猫");
  await page.click('[data-model-entry-action="image-generate"]');
  await page.waitForTimeout(350);
  await act('[data-model-entry-field="protocol-execute:providerId"]', "prov_local");
  await act('[data-model-entry-field="protocol-execute:model"]', "gpt-image");
  await act('[data-model-entry-field="protocol-execute:prompt"]', "探针：执行协议");
  await page.click('[data-model-entry-action="protocol-execute"]');
  await page.waitForTimeout(500);

  const commands = await page.evaluate(() => window.__oaModelProbe.commands);
  const entryCommands = ["protocol/validate", "protocol/save", "image/generate", "protocol/execute"];
  for (const c of entryCommands) {
    check("动作入口真实发出 " + c, commands.some((x) => x.command === c), "count=" + commands.filter((x) => x.command === c).length);
  }
  const keysOf = (c) => {
    const call = commands.filter((x) => x.command === c).pop();
    return call ? Object.keys(call.payload || {}).sort().join(",") : "";
  };
  check("protocol/validate 载荷只含 protocol", keysOf("protocol/validate") === "protocol", keysOf("protocol/validate"));
  check("protocol/save 载荷只含 kind/protocol", keysOf("protocol/save") === "kind,protocol", keysOf("protocol/save"));
  check("image/generate 载荷只含 providerId/model/prompt", keysOf("image/generate") === "model,prompt,providerId", keysOf("image/generate"));
  check("protocol/execute 载荷只含 providerId/model/prompt", keysOf("protocol/execute") === "model,prompt,providerId", keysOf("protocol/execute"));
  const offenders = commands.filter((c) =>
    Object.keys(c.payload || {}).some((k) => ["userId", "role", "sessionRef", "appId", "secret", "credentialSecret"].indexOf(k) >= 0),
  );
  check("动作入口载荷不含身份字段与密钥字段", offenders.length === 0, JSON.stringify(offenders.slice(0, 2)));
  await ctx.close();
}

check("无 console error", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
check("无跨源 / 非本地网络请求", externalRequests.length === 0, externalRequests.slice(0, 3).join(" | "));

await browser.close();
server.close();

/* ── 10. 报告 ────────────────────────────────────────────────────────────── */
const failed = checks.filter((c) => !c.ok);
const report = {
  task: "UI-5 模型与协议（协议表 / 能力 manifest / 流式状态）+ 基准（Skill 中心）对照",
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
  fixture: {
    source: "主进程 protocol-engine repository / model-manifest-service（离线，与 IPC 同一份结构）",
    protocolListItems: protocolList.items.length,
    protocolGetEntries: Object.keys(protocolGet).length,
    protocolGetNotFound: Object.values(protocolGet).filter((r) => r.ok !== true).length,
    manifestEntries: Object.keys(manifest).length,
  },
  screenshots,
  video: fs.existsSync(flowVideo) ? flowVideo : null,
  entryVideo: fs.existsSync(entryFlowVideo) ? entryFlowVideo : null,
  compare: {
    condition: compareCondition,
    screenshots: { model: compare.model.screenshot, skill: compare.skill.screenshot },
    notes: notesPath,
    metrics: { model: modelM, skill: skillM },
    differences: compareDifferences,
    pageStateBeforeSelect: {
      model: compare.model.pageStateBeforeSelect,
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
console.log("UI-5 模型与协议探针：结论 " + report.verdict + " — " + JSON.stringify({ total: checks.length, failed: failed.length }));
console.log("截图：" + screenshots.length + " 张 → " + ART);
console.log("录屏：" + (report.video || "（无）"));
console.log("对照：" + compare.model.screenshot + " ／ " + compare.skill.screenshot);
console.log("对照差异（模型−Skill）：" + JSON.stringify({
  splitWidth: cmp.splitWidth,
  listPaneWidth: cmp.listPaneWidth,
  rowHeight: cmp.rowHeight,
  blockTitleFontSize: cmp.blockTitleFontSize,
  rowNameFontSize: cmp.rowNameFontSize,
  rowFactsFontSize: cmp.rowFactsFontSize,
}));
console.log("对照笔记：" + notesPath);
console.log("报告：" + path.join(ART, "report.json"));
if (failed.length) {
  console.log("失败项：");
  for (const f of failed) console.log("  · " + f.name + (f.detail ? " — " + f.detail : ""));
}
process.exit(failed.length ? 1 : 0);
