/**
 * UI-2 · MCP 中心（B4 工具聚合 + 设计系统一致性修正）Playwright 探针。
 *
 * 复用 UI-1（experiments/dxos-ui-skills）的 harness 方式：esbuild 打本地探针产物 →
 * 本地静态服务 → Playwright（Chromium 按 experiments/lib/chromium.mjs 解析：OA_CHROMIUM → Playwright → 系统 Chrome）→ 截图 / 连续录屏 / 断言。
 * 探针全程离线：假 mcp 桥只做内存 switch，不发网络请求、不读凭据、不写 localStorage。
 *
 * 覆盖：加载 / 空 / 错误 / 就绪 + 工具清单非空 + 长列表滚动（ScrollArea 生效）
 *       + 窄宽不溢出 + 焦点顺序 + 产品边界（无调用入口）+ 改前/改后同设定对照。
 *
 * 运行：node experiments/dxos-ui-mcp/run-all.mjs
 * 退出码：任一断言 FAIL → 1。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { execFileSync } from "node:child_process";
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
const ART = path.join(ROOT, "artifacts", "dxos-ui-mcp");
const BUILD = path.join(ART, "build");
const BEFORE_DIR = path.join(BUILD, "before");
const VIDEO_DIR = path.join(ART, "video");
const PORT = Number(process.env.OA_MCP_PORT || 5252);
// 解析优先级：OA_CHROMIUM → Playwright 官方 chromium → 系统 Google Chrome（见 experiments/lib/chromium.mjs）。
const CHROMIUM_INFO = resolveChromium();
const CHROMIUM = CHROMIUM_INFO.path;
/* UI-2 起点的基线提交：改前源码与基线 CSS 都从这里取，保证改前/改后同设定可复现。 */
const BASELINE_SHA = process.env.OA_MCP_BASELINE_SHA || "d805943";
const NL = String.fromCharCode(10);

/* 高负载下等待会整体变慢；这里只放大等待与加重试，不改任何断言（见 experiments/lib/probe-timing.mjs）。 */
installCrashGuard();
setStep("初始化");
console.log("探针时序加固：" + timingSummary());

const checks = [];
const screenshots = [];
const pageErrors = [];
const externalRequests = [];

function check(name, ok, detail) {
  checks.push({ name: name, ok: !!ok, detail: detail == null ? "" : String(detail) });
  console.log((ok ? "  [PASS] " : "! [FAIL] ") + name + (detail ? " — " + detail : ""));
  return !!ok;
}

/* ── 0. 改前基线源码（用于同设定对照）──────────────────────────────────── */
let beforeSource = null;
let beforeCss = null;
let beforeProvenance = "";
try {
  beforeSource = execFileSync("git", ["show", BASELINE_SHA + ":src/mcp/McpCenter.tsx"], { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  beforeCss = execFileSync("git", ["show", BASELINE_SHA + ":src/styles.css"], { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  beforeProvenance = "git show " + BASELINE_SHA + ":src/mcp/McpCenter.tsx + :src/styles.css";
} catch (e) {
  beforeProvenance = "不可用：" + String((e && e.message) || e);
}
check("改前基线源码可从 git 取出（" + BASELINE_SHA + "）", !!beforeSource && !!beforeCss, beforeProvenance);

/* ── 1. 挂载壳：假 mcp 桥 + 场景数据（改前 / 改后共用同一份）────────────── */
const ENTRY = `import React from "react";
import { createRoot } from "react-dom/client";
import { McpCenter } from "__MCP_IMPORT__";
import "../../src/design-system/tokens.css";
import "../../src/design-system/primitives.css";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") || "ready";
const many = params.get("tools") === "many";
/* 只读聚合的三个探针开关：全部走内存 switch，不碰网络。 */
const toolsError = params.get("toolsError") === "1";
const toolsLoading = params.get("toolsLoading") === "1";
const toolsEnabled = params.get("toolsEnabled") === "1";
/* UI-3 工具调用开关：读侧场景（switchRead=denied）与写侧场景（switchWrite=slow|fail|deny|unavailable）。
   开关状态是**页面级可变值**：假后端在 mcp/toolInvocation/set 成功后改它，mcp/agentTools 再读回来。 */
const switchRead = params.get("switchRead") || "none";
const switchWrite = params.get("switchWrite") || "none";
const dark = params.get("dark") === "1";
let invocationEnabled = toolsEnabled;
const NOW = Date.parse("2026-01-05T09:00:00Z");

const BASE_TOOLS = [
  { name: "echo", description: "回显输入文本", inputSchemaSummary: "type=object; properties: text:string(required)" },
  { name: "sum", description: "整数求和", inputSchemaSummary: "type=object; properties: a:number(required), b:number(required)" },
  { name: "noop", description: "不接收参数的空操作", inputSchemaSummary: "type=object; properties: none" },
  { name: "blank", description: "服务端没有提供参数 schema 的工具" },
];

function readyTools() {
  const list = BASE_TOOLS.slice();
  const target = many ? 28 : 6;
  for (let i = list.length; i < target; i += 1) {
    list.push({
      name: "tool_" + String(i).padStart(2, "0"),
      description: "批量工具 " + String(i) + "：用于验证长清单滚动",
      inputSchemaSummary: "type=object; properties: q:string(required)",
    });
  }
  return list;
}

const CONNECTIONS = [
  {
    connectionId: "conn_local_echo",
    name: "本机回显服务",
    transport: "stdio",
    location: "LOCAL_DEVICE",
    endpoint: { serverKey: "openarc-test-echo" },
    authMode: "NONE",
    credentialConfigured: false,
    enabled: true,
    status: "READY",
    lastErrorCode: null,
    protocolVersion: "2025-06-18",
    serverName: "openarc-test-echo",
    serverVersion: "1.0.0",
    capabilities: { tools: { listChanged: true }, resources: {}, logging: {} },
    tools: readyTools(),
    toolsHash: "sha256:5c1f0a7e9b2d",
    visibility: "PERSONAL",
    access: { canView: true, canUse: true, canManage: true, isOwner: true, connectionScope: "USER" },
    createdAt: NOW,
    updatedAt: NOW,
    lastConnectedAt: NOW,
  },
  {
    connectionId: "conn_remote_docs",
    name: "团队文档服务",
    transport: "http",
    location: "REMOTE_SERVICE",
    endpoint: { url: "https://mcp.example.invalid/rpc", endpointScope: "REMOTE_HTTPS" },
    authMode: "BEARER",
    credentialConfigured: true,
    enabled: true,
    status: "READY",
    lastErrorCode: null,
    protocolVersion: "2025-06-18",
    serverName: "docs-mcp",
    serverVersion: "2.1.0",
    capabilities: { tools: {} },
    tools: [
      { name: "docs_search", description: "在团队文档中检索", inputSchemaSummary: "type=object; properties: query:string(required)" },
      { name: "docs_read", description: "读取一篇文档", inputSchemaSummary: "type=object; properties: id:string(required)" },
    ],
    toolsHash: "sha256:aa11bb22",
    visibility: "ORGANIZATION",
    access: { canView: true, canUse: true, canManage: true, isOwner: true, connectionScope: "ORG" },
    createdAt: NOW,
    updatedAt: NOW,
    lastConnectedAt: NOW,
  },
  {
    connectionId: "conn_disabled",
    name: "停用的实验服务",
    transport: "stdio",
    location: "LOCAL_DEVICE",
    endpoint: { serverKey: "openarc-test-echo" },
    enabled: false,
    status: "DISABLED",
    tools: [
      { name: "disabled_probe", description: "不该出现在聚合里", inputSchemaSummary: "type=object; properties: none" },
    ],
    visibility: "PERSONAL",
    access: { canView: true, canUse: true, canManage: true, isOwner: true },
    createdAt: NOW,
    updatedAt: NOW,
    lastConnectedAt: null,
  },
  {
    connectionId: "conn_error",
    name: "握手失败的服务",
    transport: "http",
    location: "REMOTE_SERVICE",
    endpoint: { url: "https://mcp.example.invalid/broken", endpointScope: "REMOTE_HTTPS" },
    enabled: true,
    status: "ERROR",
    lastErrorCode: "MCP_UNREACHABLE",
    tools: [
      { name: "ghost_tool", description: "不该出现在聚合里", inputSchemaSummary: "type=object; properties: none" },
    ],
    visibility: "PERSONAL",
    access: { canView: true, canUse: true, canManage: true, isOwner: true },
    createdAt: NOW,
    updatedAt: NOW,
    lastConnectedAt: null,
  },
  {
    connectionId: "conn_hidden",
    name: "无权查看工具的服务",
    transport: "http",
    location: "REMOTE_SERVICE",
    endpoint: { url: "https://mcp.example.invalid/hidden", endpointScope: "REMOTE_HTTPS" },
    enabled: true,
    status: "READY",
    toolsHidden: true,
    tools: [],
    visibility: "ORGANIZATION",
    access: { canView: true, canUse: false, canManage: false, isOwner: false, connectionScope: "ORG" },
    createdAt: NOW,
    updatedAt: NOW,
    lastConnectedAt: NOW,
  },
  {
    connectionId: "conn_org",
    name: "组织共享服务",
    transport: "http",
    location: "REMOTE_SERVICE",
    endpoint: { url: "https://mcp.example.invalid/org", endpointScope: "REMOTE_HTTPS" },
    authMode: "BEARER",
    credentialConfigured: false,
    enabled: true,
    status: "AUTH_REQUIRED",
    lastErrorCode: "MCP_AUTH_REQUIRED",
    tools: [],
    visibility: "ORGANIZATION",
    access: { canView: true, canUse: true, canManage: false, isOwner: false, connectionScope: "ORG" },
    createdAt: NOW,
    updatedAt: NOW,
    lastConnectedAt: null,
  },
];

const LOGS = [
  { at: NOW, level: "INFO", event: "initialize", detail: "协议版本 2025-06-18" },
  { at: NOW, level: "INFO", event: "tools/list", detail: "发现 " + String(CONNECTIONS[0].tools.length) + " 个工具" },
  { at: NOW, level: "WARN", event: "resources/list", detail: "服务端未声明 resources" },
];

const probe = { page: "mcp", scenario: scenario, many: many, commands: [] };
window.__oaMcpProbe = probe;

/* ── 假后端：mcp/agentTools 的聚合（镜像 electron/mcp-agent-tools.cjs + mcp-bootstrap.cjs）──
   界面这一轮不再派生聚合，所以探针必须在**假后端**里算出与主进程相同的字段契约。 */
function safeName(v) { return String(v == null ? "" : v).replace(/[^a-zA-Z0-9_-]/g, "_"); }
function paramSummary(summary) {
  const text = typeof summary === "string" ? summary.trim() : "";
  if (!text) return "未返回参数摘要（服务端未提供 inputSchema）";
  if (/properties:\\s*none/.test(text)) return text + "（参数为空对象）";
  return text;
}
function collectAgentTools(serverId) {
  const seen = new Set();
  const tools = [];
  let connectedServers = 0;
  for (const c of CONNECTIONS) {
    if (c.enabled === false) continue;
    if (c.status !== "READY" && c.status !== "connected") continue;
    connectedServers += 1;
    if (serverId && String(c.connectionId) !== String(serverId)) continue;
    for (const t of (Array.isArray(c.tools) ? c.tools : [])) {
      if (!t || !t.name) continue;
      const fname = "mcp__" + safeName(c.connectionId) + "__" + safeName(t.name);
      if (seen.has(fname)) continue;
      seen.add(fname);
      tools.push({
        fname: fname,
        serverId: String(c.connectionId),
        serverName: String(c.name || ""),
        toolName: String(t.name),
        status: String(c.status || ""),
        description: typeof t.description === "string" ? t.description : "",
        paramText: paramSummary(t.inputSchemaSummary),
        riskClass: "EXTERNAL_SIDE_EFFECT",
        requiresApproval: true,
      });
    }
  }
  return { tools: tools, connectedServers: connectedServers };
}

async function command(raw) {
  const cmd = raw && raw.command;
  const payload = (raw && raw.payload) || {};
  probe.commands.push({ command: cmd, payload: payload });
  if (cmd === "mcp/list") {
    if (scenario === "loading") return new Promise(function () {});
    if (scenario === "empty") return { ok: true, items: [] };
    if (scenario === "error") return { ok: false, error: "MCP_COMMAND_NOT_ALLOWED" };
    return { ok: true, items: CONNECTIONS };
  }
  if (cmd === "mcp/get") {
    if (scenario === "unauthorized") return { ok: false, error: "MCP_UNAUTHORIZED" };
    const found = CONNECTIONS.filter(function (x) { return x.connectionId === payload.connectionId; })[0] || null;
    return found ? { ok: true, connection: found } : { ok: false, error: "MCP_CONNECTION_NOT_FOUND" };
  }
  if (cmd === "mcp/testLog") return { ok: true, items: LOGS };
  if (cmd === "mcp/agentTools") {
    if (toolsLoading) return new Promise(function () {});
    /* UI-3：读侧越权场景（与 mcp/get 的 unauthorized 场景同口径）。 */
    if (switchRead === "denied") return { ok: false, error: "MCP_UNAUTHORIZED" };
    if (toolsError) {
      return { ok: false, error: "MCP_TOOL_DISCOVERY_FAILED", detail: "mcp-agent-tools-unavailable", tools: [], count: 0, connectedServers: 0, enabled: false, truncated: false };
    }
    const all = collectAgentTools(null);
    const scoped = payload && payload.serverId ? collectAgentTools(payload.serverId) : all;
    return { ok: true, enabled: invocationEnabled, count: scoped.tools.length, connectedServers: all.connectedServers, truncated: false, tools: scoped.tools };
  }
  /* UI-3：开关写命令。假后端镜像 electron/mcp-bootstrap.cjs 的四个分支：
     slow=在途（截图用，永不解析）/ fail=审计不可用 / deny=越权 / unavailable=开关端口缺失；
     其余按真实语义写内存并回 { ok, enabled, persisted, audited }。 */
  if (cmd === "mcp/toolInvocation/set") {
    if (switchWrite === "slow") return new Promise(function () {});
    if (switchWrite === "deny") return { ok: false, error: "MCP_UNAUTHORIZED" };
    if (switchWrite === "fail") return { ok: false, error: "MCP_AUDIT_UNAVAILABLE", detail: "审计端口未注入：拒绝无审计的开关变更" };
    if (switchWrite === "unavailable") return { ok: false, error: "MCP_SWITCH_UNAVAILABLE", detail: "缺少 userDataDir：开关无法持久化", enabled: false };
    if (typeof (payload && payload.enabled) !== "boolean") return { ok: false, error: "MCP_INVALID_INPUT", detail: "enabled" };
    invocationEnabled = payload.enabled === true;
    return { ok: true, enabled: invocationEnabled, persisted: true, audited: true };
  }
  return { ok: false, error: "MCP_COMMAND_NOT_ALLOWED" };
}

if (scenario !== "nobridge") {
  window.openarc = { mcp: { command: command } };
}

createRoot(document.getElementById("root")).render(
  <div className={"window" + (dark ? " dark" : "")} style={{ position: "absolute", inset: 0 }}>
    <McpCenter role="ADMIN" />
  </div>
);
`;

const entryFor = function (mcpImport) {
  return ENTRY.replace("__MCP_IMPORT__", mcpImport);
};

/* ── 2. esbuild：改后（当前源码）与改前（基线源码 + 基线 CSS）两份产物 ── */
fs.rmSync(BUILD, { recursive: true, force: true });
fs.rmSync(VIDEO_DIR, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(BEFORE_DIR, { recursive: true });
fs.mkdirSync(VIDEO_DIR, { recursive: true });

const DEFINE = {};
DEFINE["process.env.NODE_ENV"] = JSON.stringify("production");

const PUBLIC_ASSETS = {
  name: "oa-public-assets",
  setup: function (b) {
    b.onResolve({ filter: new RegExp("^/[^/].*[.](svg|png)$") }, function (args) {
      const file = path.join(ROOT, "public", args.path.replace(new RegExp("^[/]+"), ""));
      if (fs.existsSync(file)) return { path: file };
      return { path: args.path, namespace: "oa-missing-asset" };
    });
    b.onLoad({ filter: /.*/, namespace: "oa-missing-asset" }, function () {
      return { contents: "", loader: "dataurl" };
    });
  },
};

async function buildHarness(entry, outdir, plugins) {
  await build({
    stdin: { contents: entry, resolveDir: HERE, loader: "tsx", sourcefile: "harness.tsx" },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    outdir: outdir,
    entryNames: "harness",
    loader: { ".css": "css", ".svg": "dataurl", ".png": "dataurl" },
    define: DEFINE,
    logLevel: "silent",
    plugins: plugins,
  });
}

console.log("构建探针产物（esbuild，改后 + 改前）…");
await buildHarness(entryFor("../../src/mcp/McpCenter"), BUILD, [PUBLIC_ASSETS]);

if (beforeSource && beforeCss) {
  const BEFORE_PLUGINS = [
    {
      name: "oa-before-mcp",
      setup: function (b) {
        b.onResolve({ filter: new RegExp("^[.]/McpCenter[.]before$") }, function () {
          return { path: "McpCenter.before", namespace: "oa-before" };
        });
        b.onLoad({ filter: /.*/, namespace: "oa-before" }, function () {
          return { contents: beforeSource, loader: "tsx", resolveDir: path.join(ROOT, "src", "mcp") };
        });
      },
    },
    {
      name: "oa-before-css",
      setup: function (b) {
        b.onResolve({ filter: new RegExp("styles[.]css$") }, function () {
          return { path: "baseline-styles", namespace: "oa-before-css" };
        });
        b.onLoad({ filter: /.*/, namespace: "oa-before-css" }, function () {
          return { contents: beforeCss, loader: "css" };
        });
      },
    },
    PUBLIC_ASSETS,
  ];
  await buildHarness(entryFor("./McpCenter.before"), BEFORE_DIR, BEFORE_PLUGINS);
}

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'";
const htmlFor = function (title) {
  return "<!doctype html>" + NL +
    '<html lang="zh-CN">' + NL +
    "<head>" + NL +
    '<meta charset="utf-8" />' + NL +
    '<meta http-equiv="Content-Security-Policy" content="' + CSP + '" />' + NL +
    "<title>" + title + "</title>" + NL +
    '<link rel="stylesheet" href="./harness.css" />' + NL +
    "</head>" + NL +
    '<body><div id="root"></div><script type="module" src="./harness.js"></script></body>' + NL +
    "</html>" + NL;
};
fs.writeFileSync(path.join(BUILD, "index.html"), htmlFor("MCP 中心 UI 探针（改后）"));
if (beforeSource && beforeCss) fs.writeFileSync(path.join(BEFORE_DIR, "index.html"), htmlFor("MCP 中心 UI 探针（改前基线）"));

/* ── 3. 本地静态服务（只服务探针产物，不对公网）────────────────────────── */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
};
const server = http.createServer(function (req, res) {
  const raw = (req.url || "/").split("?")[0];
  const rel = raw === "/" ? "index.html" : raw.replace(new RegExp("^[/]+"), "");
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
await new Promise(function (resolve) { server.listen(PORT, "127.0.0.1", resolve); });
registerCleanup(() => new Promise((resolve) => server.close(resolve)));
const BASE = "http://127.0.0.1:" + PORT;

/* ── 4. 浏览器 ──────────────────────────────────────────────────────────── */
if (!CHROMIUM) {
  console.error("找不到可用 Chromium，已按优先级尝试：" + describeChromiumCandidates(CHROMIUM_INFO.candidates) + "（设置 OA_CHROMIUM 指向可用二进制）");
  server.close();
  process.exit(1);
}

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
  page.on("console", function (msg) {
    if (msg.type() === "error") pageErrors.push(label + " console.error: " + msg.text());
  });
  page.on("pageerror", function (err) {
    pageErrors.push(label + " pageerror: " + err.message);
  });
  page.route("**/*", function (route) {
    const url = route.request().url();
    let host = null;
    try {
      host = new URL(url).hostname;
    } catch (e) {
      host = null;
    }
    const local = host === null || host === "" || host === "127.0.0.1" || host === "localhost";
    if (!local) externalRequests.push(label + " " + url);
    route.continue();
  });
}

const browser = await launchChromiumBounded(chromium, { executablePath: CHROMIUM });
registerCleanup(() => browser.close());

async function openProbe(opts) {
  const ctxOpts = Object.assign({}, SHOT_OPTS, opts.opts || {});
  /* 深色对照：harness 根节点加 .dark（产品用类名切主题，不是媒体查询），
     同时把 context 的 colorScheme 也切到 dark（滚动条 / 原生控件）。 */
  if (opts.dark) ctxOpts.colorScheme = "dark";
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  watch(page, (opts.before ? "before:" : "") + opts.query);
  const url = opts.before ? BASE + "/before/index.html?" + opts.query : BASE + "/?" + opts.query;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-mcp-center]");
  return { ctx: ctx, page: page };
}

async function shoot(name, spec) {
  const label = "场景 " + name;
  const checksBefore = checks.length;
  const screenshotsBefore = screenshots.length;
  await withRetries(
    label,
    SCENARIO_ATTEMPTS,
    async () => {
      const opened = await openProbe({
        query: spec.query,
        before: !!spec.before,
        dark: !!spec.dark,
        opts: spec.narrow ? { viewport: { width: 640, height: 900 } } : null,
      });
      try {
        const page = opened.page;
        if (spec.setup) await spec.setup(page);
        await page.waitForSelector(spec.expect, { timeout: 15000 });
        await page.waitForTimeout(220);
        const file = path.join(ART, name + ".png");
        await page.screenshot({ path: file });
        screenshots.push(file);
        check("状态截图 " + name + " → " + spec.expect, true, file);
      } finally {
        await opened.ctx.close().catch((e) => console.log("    · 关闭 context 时出错（已记录，不掩盖原错误）：" + ((e && e.message) || e)));
      }
    },
    (attempt) => {
      if (attempt > 1) console.log("  ↺ 回滚 " + label + " 上一次的部分断言 / 截图，整场景重跑（不跳过任何断言）");
      checks.length = checksBefore;
      screenshots.length = screenshotsBefore;
    },
  );
}

/* UI-3：把开关区块的所有可见/可访问事实一次性读出来，供各状态断言共用。 */
async function readToolSwitch(page) {
  return await page.evaluate(function () {
    const section = document.querySelector("[data-mcp-toolswitch-section]");
    const toggle = document.querySelector("[data-mcp-toolswitch-toggle]");
    const stateText = document.querySelector("[data-mcp-toolswitch-state-text]");
    const error = document.querySelector("[data-mcp-toolswitch-error]");
    const readError = document.querySelector("[data-mcp-toolswitch-read-error]");
    return {
      state: section ? section.getAttribute("data-mcp-toolswitch-state") : null,
      comp: toggle ? toggle.getAttribute("data-ds-comp") : null,
      role: toggle ? toggle.getAttribute("role") : null,
      checked: toggle ? toggle.getAttribute("aria-checked") : null,
      label: toggle ? toggle.getAttribute("aria-label") : null,
      disabled: toggle ? toggle.disabled === true : null,
      busy: toggle ? toggle.getAttribute("aria-busy") : null,
      text: stateText ? (stateText.textContent || "").trim() : "",
      errorCode: error ? error.getAttribute("data-mcp-toolswitch-error-code") : null,
      errorText: error ? (error.textContent || "").trim() : "",
      readErrorCode: readError ? readError.getAttribute("data-mcp-toolswitch-error-code") : null,
      readErrorText: readError ? (readError.textContent || "").trim() : "",
      unauthorized: !!document.querySelector("[data-mcp-toolswitch-unauthorized]"),
      riskText: (document.querySelector("[data-mcp-toolswitch-risk]") || {}).textContent || "",
      boundary: (document.querySelector("[data-mcp-toolswitch-boundary]") || {}).textContent || "",
    };
  });
}

/* ── 5. 状态截图（同一主题 / 窗口 / 缩放 / reducedMotion）───────────────── */
console.log(NL + "状态截图：");
await shoot("01-loading", { query: "scenario=loading", expect: '[data-mcp-available="true"] [data-ds-kind="loading"]' });
await shoot("02-empty", { query: "scenario=empty", expect: '[data-mcp-empty] [data-ds-kind="empty"]' });
await shoot("03-error", { query: "scenario=error", expect: '[data-mcp-error][data-mcp-error-code]' });
await shoot("04-ready", { query: "scenario=ready", expect: "[data-mcp-aggregate-row]" });
await shoot("05-unavailable", { query: "scenario=nobridge", expect: '[data-mcp-available="false"] [data-ds-kind="unavailable"]' });
await shoot("06-tools-many", { query: "scenario=ready&tools=many", expect: "[data-mcp-aggregate-row]" });
await shoot("07-narrow-640", { query: "scenario=ready", narrow: true, expect: "[data-mcp-aggregate-row]" });
await shoot("08-detail-ready", {
  query: "scenario=ready",
  expect: "[data-mcp-aggregate-row]",
  setup: async function (page) {
    await page.click('.mcp-row[data-mcp-connection="conn_local_echo"]');
    await page.waitForSelector("[data-mcp-detail]");
  },
});

/* ── 6. 工具聚合正确性 + 产品边界 ──────────────────────────────────────── */
console.log(NL + "工具聚合与产品边界：");
setStep("工具聚合与产品边界");
const fnameRe = new RegExp("^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$");
{
  const opened = await openProbe({ query: "scenario=ready" });
  const page = opened.page;
  await page.waitForSelector("[data-mcp-aggregate-row]");
  const rows = await page.evaluate(function () {
    return Array.prototype.slice.call(document.querySelectorAll("[data-mcp-aggregate-row]")).map(function (r) {
      return {
        fname: r.getAttribute("data-mcp-aggregate-tool"),
        server: r.getAttribute("data-mcp-aggregate-server"),
        status: r.getAttribute("data-mcp-aggregate-status"),
        name: (r.querySelector("[data-mcp-aggregate-name]") || {}).textContent,
        desc: (r.querySelector("[data-mcp-aggregate-desc]") || {}).textContent,
        params: (r.querySelector("[data-mcp-aggregate-params]") || {}).textContent,
        risk: r.getAttribute("data-mcp-aggregate-risk"),
        approval: r.getAttribute("data-mcp-aggregate-approval"),
      };
    });
  });
  const names = rows.map(function (r) { return r.fname; });
  check("工具清单非空（就绪）", rows.length > 0, "rows=" + rows.length + " :: " + names.slice(0, 5).join(", "));
  const nsOk = rows.every(function (r) {
    return fnameRe.test(r.fname) && r.fname.indexOf("mcp__" + r.server + "__") === 0;
  });
  check("命名空间 mcp__<server>__<tool> 与来源一致", nsOk, names.join(", "));
  check("包含两个 READY 服务的工具", names.indexOf("mcp__conn_local_echo__echo") >= 0 && names.indexOf("mcp__conn_remote_docs__docs_search") >= 0, names.slice(0, 6).join(", "));
  check("停用 / 未连接的服务不参与聚合", rows.every(function (r) { return r.server !== "conn_disabled" && r.server !== "conn_error"; }) && names.indexOf("mcp__conn_disabled__disabled_probe") < 0 && names.indexOf("mcp__conn_error__ghost_tool") < 0, "servers=" + JSON.stringify(Array.from(new Set(rows.map(function (r) { return r.server; })))));
  check("每条聚合行带连接状态", rows.every(function (r) { return r.status === "READY"; }), JSON.stringify(Array.from(new Set(rows.map(function (r) { return r.status; })))));
  const noop = rows.filter(function (r) { return r.fname === "mcp__conn_local_echo__noop"; })[0] || null;
  const blank = rows.filter(function (r) { return r.fname === "mcp__conn_local_echo__blank"; })[0] || null;
  check("参数摘要为空对象时如实标注", !!noop && String(noop.params).indexOf("参数为空对象") >= 0, noop ? noop.params : "缺 noop");
  check("未返回参数摘要时如实标注", !!blank && String(blank.params).indexOf("未返回参数摘要") >= 0, blank ? blank.params : "缺 blank");
  const echoRow = rows.filter(function (r) { return r.fname === "mcp__conn_local_echo__echo"; })[0] || null;
  check(
    "参数摘要原文逐字透传（第三种文案）",
    !!echoRow && String(echoRow.params) === "type=object; properties: text:string(required)",
    echoRow ? echoRow.params : "缺 echo",
  );
  const boundary = await page.$eval("[data-mcp-aggregate-boundary]", function (el) { return el.textContent || ""; });
  check("产品边界显式标注（不提供调用入口 / 调用走审批）", boundary.indexOf("不提供") >= 0 && boundary.indexOf("审批") >= 0, boundary.slice(0, 80));
  check(
    "每条聚合行带外部风险等级与审批要求（字段来自主进程）",
    rows.every(function (r) { return r.risk === "EXTERNAL_SIDE_EFFECT" && r.approval === "true"; }),
    JSON.stringify(rows.slice(0, 2).map(function (r) { return { risk: r.risk, approval: r.approval }; })),
  );
  const invocation = await page.$eval("[data-mcp-aggregate-invocation]", function (el) {
    return { text: el.textContent || "", enabled: el.getAttribute("data-mcp-aggregate-enabled") };
  });
  check(
    "默认关闭时明确提示“工具调用默认关闭”及其含义",
    invocation.enabled === "false" && invocation.text.indexOf("工具调用默认关闭") >= 0 && invocation.text.indexOf("审批") >= 0,
    JSON.stringify(invocation).slice(0, 180),
  );
  const invoke = await page.evaluate(function () {
    const re = new RegExp("调用工具|运行工具|执行工具|调用$");
    const els = Array.prototype.slice.call(document.querySelectorAll('button, [role="button"], a'));
    const bad = els.filter(function (el) { return re.test((el.textContent || "").trim()); });
    return { total: els.length, bad: bad.map(function (el) { return (el.textContent || "").trim(); }), dataInvoke: document.querySelectorAll("[data-mcp-invoke]").length };
  });
  check("界面没有工具调用入口", invoke.bad.length === 0 && invoke.dataInvoke === 0, "buttons=" + invoke.total + " bad=" + JSON.stringify(invoke.bad));
  const countText = await page.$eval("[data-mcp-aggregate-count]", function (el) { return el.textContent || ""; });
  check("聚合计数可见", countText.indexOf("个工具") >= 0, countText);
  await page.click('.mcp-row[data-mcp-connection="conn_local_echo"]');
  await page.waitForSelector("[data-mcp-detail]");
  const cmds = await page.evaluate(function () { return window.__oaMcpProbe.commands.map(function (c) { return c.command; }); });
  const allowed = ["mcp/list", "mcp/get", "mcp/testLog", "mcp/agentTools", "mcp/toolInvocation/set"];
  check("界面只发白名单命令", cmds.every(function (c) { return allowed.indexOf(c) >= 0; }), cmds.join(","));
  const payloadKeys = await page.evaluate(function () {
    return window.__oaMcpProbe.commands.reduce(function (acc, c) { return acc.concat(Object.keys(c.payload || {})); }, []);
  });
  check("上行载荷不含身份字段", payloadKeys.every(function (k) { return ["userId", "role", "sessionRef", "appId"].indexOf(k) < 0; }), payloadKeys.join(","));
  const lsLen = await page.evaluate(function () { return localStorage.length; });
  check("未写 localStorage", lsLen === 0, "length=" + lsLen);
  const aggCalls = await page.evaluate(function () {
    return window.__oaMcpProbe.commands.filter(function (c) { return c.command === "mcp/agentTools"; });
  });
  check(
    "聚合命令载荷只含 serverId / search",
    aggCalls.length >= 1 && aggCalls.every(function (c) {
      return Object.keys(c.payload || {}).every(function (k) { return k === "serverId" || k === "search"; });
    }),
    JSON.stringify(aggCalls.slice(0, 2)),
  );
  const scopeBtn = await page.$("[data-mcp-aggregate-scope]");
  check("选中连接后提供“只看该连接”的范围入口", scopeBtn !== null);
  if (scopeBtn) {
    await page.click("[data-mcp-aggregate-scope]");
    await page.waitForSelector("[data-mcp-aggregate-scope-label]");
    const scopeCalls = await page.evaluate(function () {
      return window.__oaMcpProbe.commands.filter(function (c) {
        return c.command === "mcp/agentTools" && c.payload && c.payload.serverId;
      });
    });
    check(
      "范围查询用 serverId（agentToolsForServer）",
      scopeCalls.length >= 1 && scopeCalls[scopeCalls.length - 1].payload.serverId === "conn_local_echo",
      JSON.stringify(scopeCalls.slice(-1)),
    );
    const scopedServers = await page.$$eval("[data-mcp-aggregate-row]", function (els) {
      return els.map(function (el) { return el.getAttribute("data-mcp-aggregate-server"); });
    });
    check(
      "范围结果只含该连接的工具",
      scopedServers.length > 0 && scopedServers.every(function (s) { return s === "conn_local_echo"; }),
      JSON.stringify(Array.from(new Set(scopedServers))),
    );
  }
  await opened.ctx.close();
}

/* ── 6b. 新增入口的状态截图（默认关闭 / 开关开启 / 依赖缺失 / 进行中 / 范围）── */
console.log(NL + "工具聚合入口状态截图：");
setStep("工具聚合入口状态截图");
await shoot("09-aggregate-tools-off", { query: "scenario=ready", expect: '[data-mcp-aggregate-invocation][data-mcp-aggregate-enabled="false"]' });
await shoot("10-aggregate-tools-on", { query: "scenario=ready&toolsEnabled=1", expect: '[data-mcp-aggregate-invocation][data-mcp-aggregate-enabled="true"]' });
await shoot("11-aggregate-dependency", { query: "scenario=ready&toolsError=1", expect: '[data-mcp-aggregate-error][data-mcp-aggregate-error-code="MCP_TOOL_DISCOVERY_FAILED"]' });
await shoot("12-aggregate-loading", { query: "scenario=ready&toolsLoading=1", expect: '[data-mcp-aggregate-section][data-mcp-aggregate-state="loading"]' });
await shoot("13-aggregate-scope", {
  query: "scenario=ready",
  expect: "[data-mcp-aggregate-scope-label]",
  setup: async function (page) {
    await page.click('.mcp-row[data-mcp-connection="conn_local_echo"]');
    await page.waitForSelector("[data-mcp-aggregate-scope]");
    await page.click("[data-mcp-aggregate-scope]");
  },
});

/* ── 6c. 工具调用开关：状态截图（关闭 / 开启 / 写入中 / 失败 / 越权 / 依赖缺失 / 深色）── */
console.log(NL + "工具调用开关状态截图：");
setStep("工具调用开关状态截图");
await shoot("14-toolswitch-off", { query: "scenario=ready", expect: '[data-mcp-toolswitch-toggle][aria-checked="false"]' });
await shoot("15-toolswitch-on", { query: "scenario=ready&toolsEnabled=1", expect: '[data-mcp-toolswitch-toggle][aria-checked="true"]' });
await shoot("16-toolswitch-writing", {
  query: "scenario=ready&switchWrite=slow",
  expect: '[data-mcp-toolswitch-toggle][aria-busy="true"]',
  setup: async function (page) {
    await page.waitForSelector("[data-mcp-toolswitch-toggle]");
    await page.click("[data-mcp-toolswitch-toggle]");
  },
});
await shoot("17-toolswitch-write-failed", {
  query: "scenario=ready&switchWrite=fail",
  expect: '[data-mcp-toolswitch-error][data-mcp-toolswitch-error-code="MCP_AUDIT_UNAVAILABLE"]',
  setup: async function (page) {
    await page.waitForSelector("[data-mcp-toolswitch-toggle]");
    await page.click("[data-mcp-toolswitch-toggle]");
  },
});
await shoot("18-toolswitch-write-unauthorized", {
  query: "scenario=ready&switchWrite=deny",
  expect: '[data-mcp-toolswitch-unauthorized="true"]',
  setup: async function (page) {
    await page.waitForSelector("[data-mcp-toolswitch-toggle]");
    await page.click("[data-mcp-toolswitch-toggle]");
  },
});
await shoot("19-toolswitch-read-unauthorized", { query: "scenario=ready&switchRead=denied", expect: '[data-mcp-toolswitch-state="unauthorized"]' });
await shoot("20-toolswitch-dependency", { query: "scenario=ready&toolsError=1", expect: '[data-mcp-toolswitch-state="unavailable"]' });
await shoot("21-toolswitch-dark-off", { query: "scenario=ready&dark=1", dark: true, expect: '[data-mcp-toolswitch-toggle][aria-checked="false"]' });
await shoot("22-toolswitch-dark-on", { query: "scenario=ready&toolsEnabled=1&dark=1", dark: true, expect: '[data-mcp-toolswitch-toggle][aria-checked="true"]' });

/* ── 6d. 工具调用开关：结构与功能（默认关闭 → 打开 → 关闭往返）──────────── */
console.log(NL + "工具调用开关：结构与功能：");
setStep("工具调用开关：结构与功能");
{
  const opened = await openProbe({ query: "scenario=ready" });
  const page = opened.page;
  await page.waitForSelector("[data-mcp-toolswitch-toggle]");
  const s0 = await readToolSwitch(page);
  check("开关区块存在且读到默认关闭", s0.state === "ready" && s0.checked === "false", JSON.stringify({ state: s0.state, checked: s0.checked, text: s0.text }).slice(0, 180));
  check("开关控件来自 primitives Button（data-ds-comp=button）", s0.comp === "button", String(s0.comp));
  check(
    "开关用文本 + role=switch/aria-checked 表达状态（不只靠颜色）",
    s0.role === "switch" && !!s0.label && s0.label.indexOf("工具调用开关") >= 0 && s0.text.indexOf("已关闭") >= 0,
    JSON.stringify({ role: s0.role, label: s0.label, text: s0.text }).slice(0, 180),
  );
  check(
    "开关文案讲清默认关闭 / 逐次审批 / 定时任务未开放",
    s0.riskText.indexOf("默认关闭") >= 0 && s0.riskText.indexOf("审批") >= 0 && s0.riskText.indexOf("定时任务暂不开放") >= 0,
    s0.riskText.slice(0, 160),
  );
  check(
    "开关区块重申没有直接调用入口（不提供 + 审批）",
    s0.boundary.indexOf("不提供") >= 0 && s0.boundary.indexOf("审批") >= 0,
    s0.boundary.slice(0, 160),
  );

  await page.click("[data-mcp-toolswitch-toggle]");
  await page.waitForSelector('[data-mcp-toolswitch-toggle][aria-checked="true"]');
  const on = await readToolSwitch(page);
  const wrote = await page.evaluate(function () {
    return {
      cmds: window.__oaMcpProbe.commands.map(function (c) { return c.command; }),
      writes: window.__oaMcpProbe.commands.filter(function (c) { return c.command === "mcp/toolInvocation/set"; }).map(function (c) { return c.payload; }),
    };
  });
  check("打开后 aria-checked=true 且状态文案同步", on.checked === "true" && on.text.indexOf("已打开") >= 0, JSON.stringify({ checked: on.checked, text: on.text }).slice(0, 180));
  check("开关写命令载荷只含 enabled", wrote.writes.length === 1 && Object.keys(wrote.writes[0]).every(function (k) { return k === "enabled"; }), JSON.stringify(wrote.writes));
  check(
    "界面只发白名单命令（含 mcp/toolInvocation/set）",
    wrote.cmds.every(function (c) { return ["mcp/list", "mcp/get", "mcp/testLog", "mcp/agentTools", "mcp/toolInvocation/set"].indexOf(c) >= 0; }),
    wrote.cmds.join(","),
  );
  check(
    "开关写命令上行载荷不含身份字段",
    Object.keys(wrote.writes[0] || {}).every(function (k) { return ["userId", "role", "sessionRef", "appId"].indexOf(k) < 0; }),
    JSON.stringify(wrote.writes),
  );
  await page.click("[data-mcp-toolswitch-toggle]");
  await page.waitForSelector('[data-mcp-toolswitch-toggle][aria-checked="false"]');
  const off = await readToolSwitch(page);
  check("关闭后回到 aria-checked=false（往返可逆）", off.checked === "false" && off.text.indexOf("已关闭") >= 0, JSON.stringify({ checked: off.checked, text: off.text }).slice(0, 180));
  await opened.ctx.close();
}

/* ── 6e. 工具调用开关：写入中 / 写入失败 / 写入越权 ───────────────────── */
console.log(NL + "工具调用开关：写入中 / 失败 / 越权：");
setStep("工具调用开关：写入中 / 失败 / 越权");
{
  const writing = await openProbe({ query: "scenario=ready&switchWrite=slow" });
  await writing.page.waitForSelector("[data-mcp-toolswitch-toggle]");
  await writing.page.click("[data-mcp-toolswitch-toggle]");
  await writing.page.waitForSelector('[data-mcp-toolswitch-toggle][aria-busy="true"]');
  const w = await readToolSwitch(writing.page);
  check("写入中：控件 disabled + aria-busy 防连点", w.disabled === true && w.busy === "true", JSON.stringify({ disabled: w.disabled, busy: w.busy }));
  await writing.ctx.close();

  const failedOpen = await openProbe({ query: "scenario=ready&switchWrite=fail" });
  const fpage = failedOpen.page;
  await fpage.waitForSelector('[data-mcp-toolswitch-toggle][aria-checked="false"]');
  await fpage.click("[data-mcp-toolswitch-toggle]");
  await fpage.waitForSelector('[data-mcp-toolswitch-error][data-mcp-toolswitch-error-code="MCP_AUDIT_UNAVAILABLE"]');
  const f = await readToolSwitch(fpage);
  check(
    "写入失败：结构化错误码 → 文案（说清状态没有改变）",
    f.errorCode === "MCP_AUDIT_UNAVAILABLE" && f.errorText.indexOf("状态没有改变") >= 0,
    f.errorText.slice(0, 140),
  );
  check("写入失败后开关回到真实状态（仍为关闭，不乐观切换）", f.checked === "false" && f.disabled === false, JSON.stringify({ checked: f.checked, disabled: f.disabled }));
  await failedOpen.ctx.close();

  const deniedOpen = await openProbe({ query: "scenario=ready&switchWrite=deny" });
  const dpage = deniedOpen.page;
  await dpage.waitForSelector('[data-mcp-toolswitch-toggle][aria-checked="false"]');
  await dpage.click("[data-mcp-toolswitch-toggle]");
  await dpage.waitForSelector('[data-mcp-toolswitch-unauthorized="true"]');
  const d = await readToolSwitch(dpage);
  check(
    "写入越权：结构化提示（MCP_UNAUTHORIZED）且状态不变",
    d.unauthorized === true && d.errorCode === "MCP_UNAUTHORIZED" && d.checked === "false",
    JSON.stringify({ unauthorized: d.unauthorized, code: d.errorCode, checked: d.checked }),
  );
  await deniedOpen.ctx.close();
}

/* ── 6f. 工具调用开关：读侧越权 / 依赖缺失 ─────────────────────────────── */
console.log(NL + "工具调用开关：读侧越权 / 依赖缺失：");
setStep("工具调用开关：读侧越权 / 依赖缺失");
{
  const deniedOpen = await openProbe({ query: "scenario=ready&switchRead=denied" });
  await deniedOpen.page.waitForSelector('[data-mcp-toolswitch-state="unauthorized"]');
  const r = await readToolSwitch(deniedOpen.page);
  check(
    "读取越权：结构化提示 + 控件禁用且不谎报开关状态",
    r.state === "unauthorized" && r.readErrorCode === "MCP_UNAUTHORIZED" && r.disabled === true && r.checked === null,
    JSON.stringify({ state: r.state, code: r.readErrorCode, disabled: r.disabled, checked: r.checked }),
  );
  await deniedOpen.ctx.close();

  const depOpen = await openProbe({ query: "scenario=ready&toolsError=1" });
  await depOpen.page.waitForSelector('[data-mcp-toolswitch-state="unavailable"]');
  const dep = await readToolSwitch(depOpen.page);
  check(
    "依赖缺失（工具聚合端口未注入）明确提示且控件禁用",
    dep.state === "unavailable" && dep.readErrorCode === "MCP_TOOL_DISCOVERY_FAILED" && dep.disabled === true && String(dep.readErrorText).indexOf("依赖缺失") >= 0,
    JSON.stringify({ state: dep.state, code: dep.readErrorCode, disabled: dep.disabled }),
  );
  await depOpen.ctx.close();
}

/* ── 6g. 工具调用开关：深色对照（与浅色同设定）─────────────────────────── */
console.log(NL + "工具调用开关：深色对照：");
setStep("工具调用开关：深色对照");
{
  const lightOpen = await openProbe({ query: "scenario=ready" });
  await lightOpen.page.waitForSelector("[data-mcp-toolswitch-toggle]");
  const light = await readToolSwitch(lightOpen.page);
  const lightDarkClass = await lightOpen.page.evaluate(function () { return !!document.querySelector(".window.dark"); });
  await lightOpen.ctx.close();

  const darkOpen = await openProbe({ query: "scenario=ready&dark=1", dark: true });
  await darkOpen.page.waitForSelector("[data-mcp-toolswitch-toggle]");
  const darkSnap = await readToolSwitch(darkOpen.page);
  const darkDarkClass = await darkOpen.page.evaluate(function () { return !!document.querySelector(".window.dark"); });
  await darkOpen.ctx.close();

  check(
    "深色对照：.dark 生效，且开关状态文案 / aria 与浅色一致（状态信息不靠主题色）",
    darkDarkClass === true && lightDarkClass === false && darkSnap.text === light.text && darkSnap.checked === light.checked && darkSnap.role === light.role,
    JSON.stringify({ lightDarkClass: lightDarkClass, darkDarkClass: darkDarkClass, light: { text: light.text, checked: light.checked }, dark: { text: darkSnap.text, checked: darkSnap.checked } }).slice(0, 220),
  );
}

/* ── 7. ScrollArea（设计系统一致性修正 b）与滚动能力 ───────────────────── */
console.log(NL + "ScrollArea（一致性修正 b）与长列表滚动：");
setStep("ScrollArea（一致性修正 b）与长列表滚动");
{
  const opened = await openProbe({ query: "scenario=ready&tools=many" });
  const page = opened.page;
  await page.waitForSelector("[data-mcp-aggregate-row]");
  const info = await page.evaluate(function () {
    const pick = function (sel) {
      const el = document.querySelector(sel);
      if (!el) return null;
      return {
        comp: el.getAttribute("data-ds-comp"),
        tabIndex: el.tabIndex,
        role: el.getAttribute("role"),
        label: el.getAttribute("aria-label"),
        overflowY: getComputedStyle(el).overflowY,
      };
    };
    return {
      list: pick(".mcp-list-pane"),
      detail: pick(".mcp-detail-pane"),
      count: document.querySelectorAll('[data-ds-comp="scroll-area"]').length,
    };
  });
  check("列表栏就是 primitives 的 ScrollArea", !!info.list && info.list.comp === "scroll-area" && info.list.tabIndex === 0 && info.list.overflowY === "auto", JSON.stringify(info.list));
  check("详情栏就是 primitives 的 ScrollArea", !!info.detail && info.detail.comp === "scroll-area" && info.detail.tabIndex === 0 && info.detail.overflowY === "auto", JSON.stringify(info.detail));
  check("ScrollArea 总数 >= 3（聚合 / 列表 / 详情）", info.count >= 3, "count=" + info.count);

  const aggScroll = await page.evaluate(function () {
    const el = document.querySelector(".mcp-aggregate__scroll");
    const before = el.scrollTop;
    el.scrollTop = el.scrollHeight;
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, before: before, after: el.scrollTop };
  });
  check("长工具聚合清单在 ScrollArea 内滚动", aggScroll.scrollHeight > aggScroll.clientHeight + 4 && aggScroll.after > aggScroll.before, JSON.stringify(aggScroll));

  const listScroll = await page.evaluate(function () {
    const el = document.querySelector(".mcp-list-pane");
    const before = el.scrollTop;
    el.scrollTop = el.scrollHeight;
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, before: before, after: el.scrollTop };
  });
  check("连接长列表在 ScrollArea 内滚动", listScroll.scrollHeight > listScroll.clientHeight + 4 && listScroll.after > listScroll.before, JSON.stringify(listScroll));

  await page.click('.mcp-row[data-mcp-connection="conn_local_echo"]');
  await page.waitForSelector("[data-mcp-detail]");
  await page.evaluate(function () { const el = document.querySelector(".mcp-detail-pane"); el.scrollTop = 0; });
  const detailScroll = await page.evaluate(function () {
    const el = document.querySelector(".mcp-detail-pane");
    const before = el.scrollTop;
    el.scrollTop = el.scrollHeight;
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, before: before, after: el.scrollTop };
  });
  check("长详情在 ScrollArea 内滚动", detailScroll.scrollHeight > detailScroll.clientHeight + 4 && detailScroll.after > detailScroll.before, JSON.stringify(detailScroll));
  await opened.ctx.close();
}

/* ── 8. 窄宽 640 不溢出 ────────────────────────────────────────────────── */
console.log(NL + "窄宽 640：");
setStep("窄宽 640");
{
  const opened = await openProbe({ query: "scenario=ready", opts: { viewport: { width: 640, height: 900 } } });
  const page = opened.page;
  await page.waitForSelector("[data-mcp-aggregate-row]");
  const m = await page.evaluate(function () {
    const de = document.documentElement;
    const center = document.querySelector(".mcp-center");
    const scroll = document.querySelector(".mcp-aggregate__scroll");
    const items = Array.prototype.slice.call(document.querySelectorAll(".mcp-aggregate__item"));
    return {
      docOverflow: de.scrollWidth - de.clientWidth,
      centerOverflow: center ? center.scrollWidth - center.clientWidth : -1,
      scrollOverflow: scroll ? scroll.scrollWidth - scroll.clientWidth : -1,
      itemOverflow: items.map(function (el) { return el.scrollWidth - el.clientWidth; }),
    };
  });
  check("窄宽 640 页面无横向溢出", m.docOverflow <= 1 && m.centerOverflow <= 1, JSON.stringify({ doc: m.docOverflow, center: m.centerOverflow }));
  check("窄宽 640 聚合清单内部无横向溢出", m.scrollOverflow <= 1 && m.itemOverflow.every(function (n) { return n <= 1; }), JSON.stringify({ scroll: m.scrollOverflow, items: m.itemOverflow.slice(0, 8) }));
  const swNarrow = await page.evaluate(function () {
    const row = document.querySelector(".mcp-toolswitch__row");
    const section = document.querySelector("[data-mcp-toolswitch-section]");
    return {
      row: row ? row.scrollWidth - row.clientWidth : -1,
      section: section ? section.scrollWidth - section.clientWidth : -1,
    };
  });
  check("窄宽 640 开关区块内部无横向溢出", swNarrow.row <= 1 && swNarrow.section <= 1, JSON.stringify(swNarrow));
  await opened.ctx.close();
}

/* ── 9. 可访问焦点顺序 ────────────────────────────────────────────────── */
console.log(NL + "可访问焦点顺序：");
setStep("可访问焦点顺序");
{
  const opened = await openProbe({ query: "scenario=ready" });
  const page = opened.page;
  await page.waitForSelector("[data-mcp-aggregate-row]");
  await page.evaluate(function () { document.body.focus(); });
  const order = [];
  for (let i = 0; i < 16; i += 1) {
    await page.keyboard.press("Tab");
    order.push(await page.evaluate(function () {
      const el = document.activeElement;
      if (!el || el === document.body) return "body";
      const inside = !!(el.closest && el.closest(".mcp-center"));
      const label = el.getAttribute("data-ds-comp") || el.getAttribute("data-mcp-connection") || el.getAttribute("data-mcp-action") || el.getAttribute("aria-label") || (el.textContent || "").trim();
      return (inside ? "in:" : "out:") + el.tagName.toLowerCase() + ":" + String(label).slice(0, 22);
    }));
  }
  const outside = order.filter(function (s) { return s.indexOf("out:") === 0; }).length;
  const bodyStops = order.filter(function (s) { return s === "body"; }).length;
  const distinct = new Set(order).size;
  check("Tab 顺序只在 MCP 中心内推进", outside === 0 && bodyStops <= 1, "outside=" + outside + " body=" + bodyStops + " :: " + order.join(" -> "));
  check("焦点逐步前进（>=5 个不同落点）", distinct >= 5, "distinct=" + distinct);
  check("滚动区域键盘可达", order.some(function (s) { return s.indexOf("scroll-area") >= 0; }), order.join(" -> "));
  const focusable = await page.evaluate(function () {
    const el = document.querySelector(".mcp-list-pane");
    if (!el || typeof el.focus !== "function") return false;
    el.focus();
    return document.activeElement === el;
  });
  check("列表 ScrollArea 可直接聚焦", focusable === true);
  await opened.ctx.close();
}

/* ── 9b. 减少动态效果（MOTION_SYSTEM §8）──────────────────────────────── */
console.log(NL + "减少动态效果：");
setStep("减少动态效果");
{
  const opened = await openProbe({ query: "scenario=ready" });
  const page = opened.page;
  await page.waitForSelector("[data-mcp-aggregate-row]");
  await page.click('.mcp-row[data-mcp-connection="conn_local_echo"]');
  await page.waitForSelector("[data-mcp-detail]");
  const motion = await page.evaluate(function () {
    const pick = function (sel) {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { animationName: cs.animationName, animationDuration: cs.animationDuration, transitionDuration: cs.transitionDuration };
    };
    return { detail: pick(".mcp-detail"), row: pick(".mcp-row"), aggItem: pick(".mcp-aggregate__item") };
  });
  check("减少动态效果下既有动效被关掉（animation: none）", !!motion.detail && motion.detail.animationName === "none" && motion.row.animationName === "none", JSON.stringify(motion));
  check("工具聚合未新增动效（animation: none / 0s）", !!motion.aggItem && motion.aggItem.animationName === "none" && motion.aggItem.animationDuration === "0s", JSON.stringify(motion.aggItem));
  const swMotion = await page.evaluate(function () {
    const el = document.querySelector("[data-mcp-toolswitch-toggle]");
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { animationName: cs.animationName, transitionDuration: cs.transitionDuration };
  });
  check("工具调用开关未新增动效（animation: none / 0s）", !!swMotion && swMotion.animationName === "none" && swMotion.transitionDuration === "0s", JSON.stringify(swMotion));
  await opened.ctx.close();
}

/* ── 10. 设计系统一致性修正：改前 / 改后同设定对照 ─────────────────────── */
console.log(NL + "设计系统一致性修正：改前 / 改后同设定对照：");
setStep("设计系统一致性修正：改前 / 改后同设定对照");
async function capture(before) {
  const opened = await openProbe({ query: "scenario=ready", before: before });
  const page = opened.page;
  await page.waitForSelector("[data-mcp-list] .mcp-row");
  await page.waitForTimeout(220);
  const metric = await page.evaluate(function () {
    const title = document.querySelector(".mcp-banner__title");
    const ts = title ? getComputedStyle(title) : null;
    const win = document.querySelector(".window");
    const scrollers = Array.prototype.slice.call(document.querySelectorAll('[data-ds-comp="scroll-area"]'));
    return {
      titleTag: title ? title.tagName.toLowerCase() : null,
      titleFontSize: ts ? ts.fontSize : null,
      titleLetterSpacing: ts ? ts.letterSpacing : null,
      tokenTitle: win ? getComputedStyle(win).getPropertyValue("--fs-title").trim() : null,
      tokenHeading: win ? getComputedStyle(win).getPropertyValue("--fs-heading").trim() : null,
      scrollAreas: scrollers.length,
      scrollAreaClasses: scrollers.map(function (el) { return String(el.className); }),
      aggregatePresent: !!document.querySelector("[data-mcp-aggregate-section]"),
      aggregateHeadingFontSize: (function () {
        const el = document.querySelector("[data-mcp-aggregate-section] .mcp-section-head h4");
        return el ? getComputedStyle(el).fontSize : null;
      })(),
      aggregateReloadHeight: (function () {
        const el = document.querySelector("[data-mcp-aggregate-reload]");
        return el ? Math.round(el.getBoundingClientRect().height) : null;
      })(),
      /* UI-3：开关区块的同设定度量（与既有聚合区块比字阶 / 控件高度，不比绝对像素） */
      toolswitch: {
        present: !!document.querySelector("[data-mcp-toolswitch-section]"),
        headingFontSize: (function () {
          const el = document.querySelector("[data-mcp-toolswitch-section] .mcp-section-head h4");
          return el ? getComputedStyle(el).fontSize : null;
        })(),
        toggleHeight: (function () {
          const el = document.querySelector("[data-mcp-toolswitch-toggle]");
          return el ? Math.round(el.getBoundingClientRect().height) : null;
        })(),
        stateText: (function () {
          const el = document.querySelector("[data-mcp-toolswitch-state-text]");
          return el ? (el.textContent || "").trim() : null;
        })(),
      },
      rows: document.querySelectorAll(".mcp-row").length,
      window: win ? { w: Math.round(win.getBoundingClientRect().width), h: Math.round(win.getBoundingClientRect().height) } : null,
    };
  });
  const file = path.join(ART, (before ? "before" : "after") + "-mcp-center.png");
  await page.screenshot({ path: file });
  screenshots.push(file);
  check("改" + (before ? "前" : "后") + "对照截图", fs.statSync(file).size > 0, file);
  await opened.ctx.close();
  return { file: file, metric: metric };
}
let beforeCap = null;
if (beforeSource && beforeCss) beforeCap = await capture(true);
const afterCap = await capture(false);

if (beforeCap) {
  check("(a) 主标题字号：改前 --fs-heading / 改后 --fs-title", beforeCap.metric.titleFontSize === beforeCap.metric.tokenHeading && afterCap.metric.titleFontSize === afterCap.metric.tokenTitle && afterCap.metric.titleFontSize !== beforeCap.metric.titleFontSize, "before=" + beforeCap.metric.titleFontSize + " after=" + afterCap.metric.titleFontSize + " tokenTitle=" + afterCap.metric.tokenTitle);
  check("(a) 主标题使用负字距（DESIGN_SYSTEM §5）", afterCap.metric.titleLetterSpacing !== "normal" && parseFloat(afterCap.metric.titleLetterSpacing) < 0, "after=" + afterCap.metric.titleLetterSpacing + " before=" + beforeCap.metric.titleLetterSpacing);
  check("(b) ScrollArea：改前 0 个 / 改后 >= 3 个", beforeCap.metric.scrollAreas === 0 && afterCap.metric.scrollAreas >= 3, "before=" + beforeCap.metric.scrollAreas + " after=" + afterCap.metric.scrollAreas);
  check("(b) 改后列表 / 详情栏就是 ScrollArea", afterCap.metric.scrollAreaClasses.some(function (c) { return c.indexOf("mcp-list-pane") >= 0; }) && afterCap.metric.scrollAreaClasses.some(function (c) { return c.indexOf("mcp-detail-pane") >= 0; }), afterCap.metric.scrollAreaClasses.join(" | "));
  check("改前 / 改后同窗口同设定", !!beforeCap.metric.window && !!afterCap.metric.window && beforeCap.metric.window.w === afterCap.metric.window.w && beforeCap.metric.window.h === afterCap.metric.window.h, JSON.stringify({ before: beforeCap.metric.window, after: afterCap.metric.window }));
  check("改前没有工具聚合区块（对照成立）", beforeCap.metric.aggregatePresent === false, "before=" + beforeCap.metric.aggregatePresent);
  check("改前没有工具调用开关区块（对照成立）", beforeCap.metric.toolswitch.present === false, "before=" + beforeCap.metric.toolswitch.present);
} else {
  check("改前基线可用", false, beforeProvenance);
}
check("改后新增 B4 工具聚合区块", afterCap.metric.aggregatePresent === true, "aggregatePresent=" + afterCap.metric.aggregatePresent);
check("改后新增工具调用开关区块", afterCap.metric.toolswitch.present === true, "toolswitchPresent=" + afterCap.metric.toolswitch.present);
check(
  "开关区块标题与既有聚合区块同字阶（同设定对照）",
  !!afterCap.metric.toolswitch.headingFontSize && afterCap.metric.toolswitch.headingFontSize === afterCap.metric.aggregateHeadingFontSize,
  "switch=" + afterCap.metric.toolswitch.headingFontSize + " aggregate=" + afterCap.metric.aggregateHeadingFontSize,
);
check(
  "开关按钮与既有 sm Button 同高（复用 primitives，无新尺寸）",
  !!afterCap.metric.toolswitch.toggleHeight && afterCap.metric.toolswitch.toggleHeight === afterCap.metric.aggregateReloadHeight,
  "toggle=" + afterCap.metric.toolswitch.toggleHeight + " reload=" + afterCap.metric.aggregateReloadHeight,
);

/* ── 11. 主流程连续录屏 ───────────────────────────────────────────────── */
console.log(NL + "主流程连续录屏：");
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
await vpage.goto(BASE + "/?scenario=ready&tools=many", { waitUntil: "domcontentloaded" });
await vpage.waitForSelector("[data-mcp-aggregate-row]");
await vpage.waitForTimeout(600);
await vpage.evaluate(function () { const el = document.querySelector(".mcp-aggregate__scroll"); el.scrollTop = el.scrollHeight; });
await vpage.waitForTimeout(700);
await vpage.click('.mcp-row[data-mcp-connection="conn_local_echo"]');
await vpage.waitForSelector("[data-mcp-detail]");
await vpage.waitForTimeout(700);
await vpage.evaluate(function () { const el = document.querySelector(".mcp-detail-pane"); el.scrollTop = el.scrollHeight; });
await vpage.waitForTimeout(700);
await vpage.click('.mcp-row[data-mcp-connection="conn_remote_docs"]');
await vpage.waitForSelector("[data-mcp-detail-name]");
await vpage.waitForTimeout(700);
/* 新增入口：刷新聚合 → 只看该连接 → 回到全部。 */
await vpage.click("[data-mcp-aggregate-reload]");
await vpage.waitForTimeout(500);
await vpage.click("[data-mcp-aggregate-scope]");
await vpage.waitForSelector("[data-mcp-aggregate-scope-label]");
await vpage.waitForTimeout(700);
await vpage.click("[data-mcp-aggregate-scope-clear]");
await vpage.waitForSelector("[data-mcp-aggregate-scope]", { timeout: 10000 }).catch(function () {});
await vpage.waitForTimeout(600);
await videoCtx.close();
const rawVideo = await video.path();
const flowVideo = path.join(ART, "mcp-center-flow.webm");
if (rawVideo && fs.existsSync(rawVideo)) {
  fs.copyFileSync(rawVideo, flowVideo);
  check("主流程连续录屏产出", fs.statSync(flowVideo).size > 0, flowVideo);
} else {
  check("主流程连续录屏产出", false, "video.path() 为空");
}

/* ── 11b. 工具聚合入口连续录屏（默认关闭 → 刷新 → 范围 → 开关开启 → 依赖缺失）── */
const aggVideoCtx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: "light",
  locale: "zh-CN",
  recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 900 } },
});
const apage = await aggVideoCtx.newPage();
watch(apage, "aggregate-video");
const aggVideo = apage.video();
await apage.goto(BASE + "/?scenario=ready", { waitUntil: "domcontentloaded" });
await apage.waitForSelector("[data-mcp-aggregate-invocation]");
await apage.waitForTimeout(600);
await apage.click("[data-mcp-aggregate-reload]");
await apage.waitForTimeout(500);
await apage.click('.mcp-row[data-mcp-connection="conn_local_echo"]');
await apage.waitForSelector("[data-mcp-aggregate-scope]");
await apage.click("[data-mcp-aggregate-scope]");
await apage.waitForSelector("[data-mcp-aggregate-scope-label]");
await apage.waitForTimeout(700);
/* 同一段录屏切到「开关开启」与「依赖缺失」两个入口状态。 */
await apage.goto(BASE + "/?scenario=ready&toolsEnabled=1", { waitUntil: "domcontentloaded" });
await apage.waitForSelector('[data-mcp-aggregate-enabled="true"]');
await apage.waitForTimeout(700);
await apage.goto(BASE + "/?scenario=ready&toolsError=1", { waitUntil: "domcontentloaded" });
await apage.waitForSelector("[data-mcp-aggregate-error]");
await apage.waitForTimeout(900);
await aggVideoCtx.close();
const aggRaw = await aggVideo.path();
const aggFlowVideo = path.join(ART, "mcp-entries-flow.webm");
if (aggRaw && fs.existsSync(aggRaw)) {
  fs.copyFileSync(aggRaw, aggFlowVideo);
  check("工具聚合入口连续录屏产出", fs.statSync(aggFlowVideo).size > 0, aggFlowVideo);
} else {
  check("工具聚合入口连续录屏产出", false, "video.path() 为空");
}

/* ── 11c. 工具调用开关连续录屏（默认关闭 → 打开 → 关闭 → 写入失败 → 越权）── */
const swVideoCtx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: "light",
  locale: "zh-CN",
  recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 900 } },
});
const spage = await swVideoCtx.newPage();
watch(spage, "toolswitch-video");
const swVideo = spage.video();
await spage.goto(BASE + "/?scenario=ready", { waitUntil: "domcontentloaded" });
await spage.waitForSelector("[data-mcp-toolswitch-toggle]");
await spage.waitForTimeout(600);
await spage.click("[data-mcp-toolswitch-toggle]");
await spage.waitForSelector('[data-mcp-toolswitch-toggle][aria-checked="true"]');
await spage.waitForTimeout(700);
await spage.click("[data-mcp-toolswitch-toggle]");
await spage.waitForSelector('[data-mcp-toolswitch-toggle][aria-checked="false"]');
await spage.waitForTimeout(700);
await spage.goto(BASE + "/?scenario=ready&switchWrite=fail", { waitUntil: "domcontentloaded" });
await spage.waitForSelector("[data-mcp-toolswitch-toggle]");
await spage.click("[data-mcp-toolswitch-toggle]");
await spage.waitForSelector("[data-mcp-toolswitch-error]");
await spage.waitForTimeout(900);
await spage.goto(BASE + "/?scenario=ready&switchWrite=deny", { waitUntil: "domcontentloaded" });
await spage.waitForSelector("[data-mcp-toolswitch-toggle]");
await spage.click("[data-mcp-toolswitch-toggle]");
await spage.waitForSelector('[data-mcp-toolswitch-unauthorized="true"]');
await spage.waitForTimeout(900);
await swVideoCtx.close();
const swRaw = await swVideo.path();
const swFlowVideo = path.join(ART, "mcp-toolswitch-flow.webm");
if (swRaw && fs.existsSync(swRaw)) {
  fs.copyFileSync(swRaw, swFlowVideo);
  check("工具调用开关连续录屏产出", fs.statSync(swFlowVideo).size > 0, swFlowVideo);
} else {
  check("工具调用开关连续录屏产出", false, "video.path() 为空");
}

/* ── 12. 全局断言 ─────────────────────────────────────────────────────── */
check("无 console error", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
check("无跨源 / 非本地网络请求", externalRequests.length === 0, externalRequests.slice(0, 3).join(" | "));

await browser.close();
server.close();

/* ── 13. 报告 ─────────────────────────────────────────────────────────── */
let failed = checks.filter(function (c) { return !c.ok; });
const report = {
  task: "UI-2 MCP 中心扩展（B4 工具聚合）+ UI-3 工具调用开关 + 设计系统一致性修正",
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
  dataSource: {
    bridge: "window.openarc.mcp.command（只读 mcp/list | mcp/get | mcp/testLog | mcp/agentTools + 唯一写 mcp/toolInvocation/set）",
    aggregateRule: "主进程 mcp/agentTools（electron/mcp-bootstrap.cjs:115-172）；渲染层不再派生聚合规则（见 src/mcp/mcpCenterLogic.ts）",
    toolSwitch: "读 mcp/agentTools.enabled；写 mcp/toolInvocation/set（trusted + risk=mcp.manage + 审计，落 <userData>/dxos/mcp.json，默认关闭）。界面不做乐观切换：写完重新读取真实状态。",
    invocationBoundary: "无直接调用入口；调用命令 mcp/toolInvocation/call 不在界面白名单内，调用一律走既有审批链（未批准 0 传输）",
  },
  designSystemFixes: {
    scope: "仅两项：(a) .mcp-banner__title 字号 -> --fs-title（+负字距）；(b) 列表/详情滚动容器改用 primitives ScrollArea。未改配色 / 圆角 / 毛玻璃 / 布局结构 / 信息密度。",
    baseline: beforeProvenance,
    before: beforeCap ? beforeCap.metric : null,
    after: afterCap.metric,
    screenshots: { before: beforeCap ? beforeCap.file : null, after: afterCap.file },
    impacted: [".mcp-banner__title", ".mcp-list-pane", ".mcp-detail-pane", "McpCenter 渲染结构：详情区新增 .mcp-detail-host 包裹层承载 data-mcp-detail-state"],
  },
  screenshots: screenshots,
  video: fs.existsSync(flowVideo) ? flowVideo : null,
  entryVideo: fs.existsSync(aggFlowVideo) ? aggFlowVideo : null,
  toolSwitchVideo: fs.existsSync(swFlowVideo) ? swFlowVideo : null,
  checks: checks,
  failures: failed,
  consoleErrors: pageErrors,
  externalRequests: externalRequests,
  finishedAt: new Date().toISOString(),
};
/* report.json 在所有 check 之后落盘：检查总数与失败项要包含 compare-fixes 那条。 */

const fixNotes = [
  "# UI-2 · 设计系统一致性修正：改前 / 改后同设定对照",
  "",
  "> 由 experiments/dxos-ui-mcp/run-all.mjs 自动生成，数值来自 report.json（designSystemFixes）。",
  "> 条件：light 主题 / 1440×900 / deviceScaleFactor 2 / prefers-reduced-motion: reduce / 同一探针外壳与同一假桥数据。",
  "> 改前源码与 CSS 取自 " + beforeProvenance + "；改后为当前工作树。",
  "> 截图：before-mcp-center.png（改前）、after-mcp-center.png（改后）。",
  "",
  "## 1. 两项修正（只改这两项）",
  "",
  "| 项 | 改前 | 改后 | 依据 |",
  "| --- | --- | --- | --- |",
  "| (a) 页面主标题字号 | " + (beforeCap ? beforeCap.metric.titleFontSize : "不可用") + " / " + (beforeCap ? beforeCap.metric.titleTag : "-") + " / letter-spacing " + (beforeCap ? beforeCap.metric.titleLetterSpacing : "-") + " | " + afterCap.metric.titleFontSize + " / " + afterCap.metric.titleTag + " / letter-spacing " + afterCap.metric.titleLetterSpacing + " | DESIGN_SYSTEM §5 字阶（页面主标题） |",
  "| (b) 滚动容器 | ScrollArea 数量 " + (beforeCap ? beforeCap.metric.scrollAreas : "-") + "（原生 overflow） | ScrollArea 数量 " + afterCap.metric.scrollAreas + "：列表栏 .mcp-list-pane、详情栏 .mcp-detail-pane、聚合清单 .mcp-aggregate__scroll | DESIGN_SYSTEM §2 组件清单（ScrollArea） |",
  "",
  "## 2. 影响面（本次改动只落在这几处）",
  "",
  "- styles.css：.mcp-banner__title（font-size / letter-spacing）、.mcp-list-pane / .mcp-detail-pane（去掉本地 overflow，改由 .ds-scroll 提供）、新增 .mcp-aggregate* 区块样式。",
  "- McpCenter.tsx：列表栏 / 详情栏改用 ScrollArea；详情区新增 .mcp-detail-host 包裹层承载 data-mcp-detail-state；新增工具聚合区块与派生函数。",
  "- 未改：配色、圆角、毛玻璃、两栏布局结构、连接列表行密度、既有交互入口。",
  "",
  "## 3. 未改的其他差异（登记，不在本波处理）",
  "",
  "- 页面标题元素仍是 p（Skill 中心是 h1）：本波只按任务要求改字号，不顺手改语义标签。",
  "- 列表栏宽（MCP 264 vs Skill 288）、.split-main 外壳差异：UI-1b 已登记为保留项。",
  "",
];
const fixesPath = path.join(ART, "compare-fixes.md");
fs.writeFileSync(fixesPath, fixNotes.join(NL));
check("对照笔记 compare-fixes.md 产出", fs.statSync(fixesPath).size > 0, fixesPath);
failed = checks.filter(function (c) { return !c.ok; });
report.verdict = failed.length ? "FAIL" : "PASS";
report.failures = failed;
fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify(report, null, 2));

console.log(NL + "═".repeat(72));
console.log("UI-2 MCP 中心探针：结论 " + report.verdict + " — " + JSON.stringify({ total: checks.length, failed: failed.length }));
console.log("截图：" + screenshots.length + " 张 → " + ART);
console.log("录屏：" + (report.video || "（无）"));
console.log("录屏（工具调用开关）：" + (report.toolSwitchVideo || "（无）"));
console.log("对照：改前 " + (beforeCap ? beforeCap.file : "（无）") + " ／ 改后 " + afterCap.file);
console.log("对照笔记：" + fixesPath);
console.log("报告：" + path.join(ART, "report.json"));
if (failed.length) {
  console.log("失败项：");
  for (const f of failed) console.log("  · " + f.name + (f.detail ? " — " + f.detail : ""));
}
process.exit(failed.length ? 1 : 0);
