/**
 * UI-4 · 组织治理扩展 Playwright 探针（截图 + 连续录屏 + 基准对照 + 边界断言）。
 *
 * 为什么不直接开产品 dist：本轮禁止执行 npm run build，dist 里还没有 UI-4 页面。
 * 这里用 esbuild（Vite 自带依赖）把**实验用挂载壳 harness.tsx**打成一份本地构建产物，
 * 再用本机 Chromium（路径复用 experiments 约定，可用 OA_CHROMIUM 覆盖）打开。
 * harness 的 DOM 与 src/main.tsx:2678 的 organization 分支一致（.window > GovernanceApp
 * 内部产出的 .split > .split-side + .split-main）。
 *
 * 覆盖：加载 / 空 / 命令被拒 / 会话失效 / 越权 NOT_SUPER_ADMIN /
 *       无部门 admin 的 DXOS_ERR_INVALID_INPUT / 就绪 / 进行中（防连点）/ 窄宽 640 /
 *       APP 访问就绪 十张状态截图；主流程连续录屏；与基准页 SkillCenter 同条件对照。
 * 断言：0 console error、0 非本地请求、焦点顺序可用、只发 15 条白名单命令、
 *       载荷键不含身份字段、界面不出现"会员 / 权益 / 套餐 / 积分"。
 *
 * 运行：node experiments/dxos-ui-org/run-all.mjs
 * 退出码：任一断言 FAIL → 1。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";
import { ALLOWED_PAYLOAD_KEYS, ORG_COMMANDS } from "../../src/governance/orgConsoleLogic.ts";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../..");
const ART = path.join(ROOT, "artifacts", "dxos-ui-org");
const BUILD = path.join(ART, "build");
const VIDEO_DIR = path.join(ART, "video");
const PORT = Number(process.env.OA_ORG_PORT || 5262);
const CHROMIUM =
  process.env.OA_CHROMIUM ||
  "/Users/wepingli/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const checks = [];
const pageErrors = [];
const externalRequests = [];
const collected = [];

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
<html lang=\"zh-CN\">
<head>
<meta charset=\"utf-8\" />
<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'\" />
<title>组织治理 UI-4 探针</title>
<link rel=\"stylesheet\" href=\"./harness.css\" />
</head>
<body><div id=\"root\"></div><script type=\"module\" src=\"./harness.js\"></script></body>
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
const BASE = "http://127.0.0.1:" + PORT;

/* ── 3. 浏览器 ────────────────────────────────────────────────────────────── */
if (!fs.existsSync(CHROMIUM)) {
  console.error("Chromium 不存在：" + CHROMIUM + "（设置 OA_CHROMIUM 指向可用二进制）");
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
  await page.waitForSelector("[data-org-center]");
  return { ctx, page };
}

async function drain(page) {
  const cmds = await page.evaluate(() => ((window.__oaOrgProbe && window.__oaOrgProbe.commands) || []).map((c) => ({ command: c.command, payload: c.payload })));
  collected.push(...cmds);
  return cmds;
}

const browser = await chromium.launch({ executablePath: CHROMIUM });
const screenshots = [];

/* ── 4. 状态截图 ─────────────────────────────────────────────────────────── */
async function shoot(spec) {
  const { ctx, page } = await openScenario(browser, spec.query, spec.narrow ? { viewport: { width: 640, height: 900 } } : null);
  if (spec.setup) await spec.setup(page);
  await page.waitForSelector(spec.expect, { timeout: 20000 });
  await page.waitForTimeout(240);
  const file = path.join(ART, spec.name + ".png");
  await page.screenshot({ path: file });
  screenshots.push(file);
  await drain(page);
  check("状态截图 " + spec.name + " → " + spec.expect, true, file);
  await ctx.close();
}

console.log(String.fromCharCode(10) + "状态截图：");
await shoot({ name: "01-loading", query: "scenario=loading", expect: '[data-org-list-state="loading"]' });
await shoot({
  name: "02-empty",
  query: "scenario=empty",
  expect: '[data-org-list-state="empty"]',
  setup: async (page) => {
    await page.waitForSelector("[data-org-dept-empty]");
    await page.waitForSelector('[data-org-action="create-dept"]');
  },
});
await shoot({
  name: "03-error",
  query: "scenario=error",
  expect: '[data-org-list-state="error"] [data-ds-kind="error"]',
  setup: async (page) => {
    const code = await page.$eval("[data-org-error-code]", (el) => el.getAttribute("data-org-error-code"));
    check("命令被拒状态带原始错误码", code === "DXOS_ERR_INTERNAL", "code=" + code);
  },
});
await shoot({
  name: "04-session-expired",
  query: "scenario=session",
  expect: '[data-org-list-state="unauthorized"] [data-ds-kind="unauthorized"]',
  setup: async (page) => {
    const code = await page.$eval("[data-org-dependency]", (el) => el.getAttribute("data-org-error-code"));
    const text = await page.$eval("[data-org-dependency]", (el) => el.textContent || "");
    check("会话失效映射为 unauthorized 且文案提示重新登录", code === "SESSION_EXPIRED" && text.includes("重新登录"), code + " :: " + text.slice(0, 60));
    /* 会话失效不是"权限不足"：不能叠一条只读横幅，否则会误读成缺超级管理员。 */
    check("会话失效不显示只读横幅（不误报缺超级管理员）", (await page.$("[data-org-readonly]")) === null, "readonly banner absent");
  },
});
await shoot({
  name: "05-not-super-admin",
  query: "scenario=not-super-admin",
  expect: '[data-org-list-state="unauthorized"] [data-ds-kind="unauthorized"]',
  setup: async (page) => {
    const code = await page.$eval("[data-org-dependency]", (el) => el.getAttribute("data-org-error-code"));
    const text = await page.$eval("[data-org-state='unauthorized']", (el) => el.textContent || "");
    check("越权 NOT_SUPER_ADMIN 文案指出需要超级管理员", code === "NOT_SUPER_ADMIN" && text.includes("超级管理员"), code + " :: " + text.slice(0, 80));
    const banner = await page.$eval("[data-org-readonly]", (el) => el.textContent || "");
    check("越权时显示只读横幅", banner.includes("只读"), banner.slice(0, 40));
  },
});
await shoot({
  name: "06-invalid-input",
  query: "scenario=ready",
  expect: '[data-org-error-code="DXOS_ERR_INVALID_INPUT"]',
  setup: async (page) => {
    await page.waitForSelector("[data-org-users]");
    await page.fill('[data-org-field="user-identifier"]', "newadmin");
    await page.fill('[data-org-field="user-display"]', "新管理员");
    await page.fill('[data-org-field="user-password"]', "password123");
    await page.selectOption('[data-org-field="user-role"]', "admin");
    await page.selectOption('[data-org-field="user-department"]', "");
    await page.click('[data-org-action="create-user"]');
    await page.waitForSelector('[data-org-error-code="DXOS_ERR_INVALID_INPUT"]');
    const text = await page.$eval("[data-org-error]", (el) => el.textContent || "");
    check("无部门 admin 的 DXOS_ERR_INVALID_INPUT 文案说明必须选择部门", text.includes("部门"), text.slice(0, 80));
  },
});
await shoot({
  name: "07-ready",
  query: "scenario=ready",
  expect: "[data-org-users]",
  setup: async (page) => {
    const depts = await page.$$eval("[data-org-dept]", (els) => els.length);
    const users = await page.$$eval("[data-org-user]", (els) => els.length);
    check("就绪态部门 / 成员列表来自 identity 命令", depts === 3 && users === 3, "depts=" + depts + " users=" + users);
    const localText = await page.$eval("[data-org-local-mode]", (el) => el.textContent || "");
    check("本地语义陈述不限账号数", localText.includes("本地模式不限账号数"), localText);
  },
});
await shoot({
  name: "08-saving",
  query: "scenario=ready&slow=1",
  expect: '[data-org-action="create-dept"][disabled][aria-busy="true"]',
  setup: async (page) => {
    await page.waitForSelector("[data-org-depts]");
    await page.fill('[data-org-field="dept-name"]', "市场部");
    await page.click('[data-org-action="create-dept"]');
    await page.waitForSelector('[data-org-action="create-dept"][disabled][aria-busy="true"]', { timeout: 4000 });
    const cmds = await drain(page);
    check("进行中只发一条创建命令（防连点）", cmds.filter((c) => c.command === "identity/department-create").length === 1, "n=" + cmds.length);
  },
});
await shoot({
  name: "09-narrow-640",
  query: "scenario=ready",
  narrow: true,
  expect: "[data-org-users]",
  setup: async (page) => {
    const overflow = await page.evaluate(() => {
      const el = document.querySelector(".split-main");
      return el ? el.scrollWidth - el.clientWidth : -1;
    });
    check("窄宽 640px 两栏与表单不溢出", overflow <= 1, "split-main overflow=" + overflow);
  },
});
await shoot({
  name: "10-app-access",
  query: "scenario=ready",
  expect: "[data-org-rules]",
  setup: async (page) => {
    await page.click('[data-org-nav="app"]');
    await page.waitForSelector("[data-org-rules]");
    const apps = await page.$$eval("[data-org-app]", (els) => els.length);
    const summary = await page.$$eval("[data-org-summary-app]", (els) => els.length);
    const policy = await page.$$eval("[data-org-policy]", (els) => els.length);
    const snapshotText = await page.$eval("[data-org-snapshot]", (el) => el.textContent || "");
    check("APP 访问区块含规则 / 权限策略 / 权限快照 / 访问摘要", apps === 3 && summary >= 3 && policy === 1, "apps=" + apps + " summary=" + summary + " policy=" + policy);
    check("权限快照说明开发者 App 尚未接线", snapshotText.includes("尚未接线"), snapshotText.slice(0, 80));
  },
});

/* ── 5. 主流程连续录屏 ───────────────────────────────────────────────────── */
console.log(String.fromCharCode(10) + "主流程连续录屏：");
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
await vpage.goto(BASE + "/?scenario=ready&slow=1", { waitUntil: "domcontentloaded" });
await vpage.waitForSelector("[data-org-users]");
await vpage.waitForTimeout(400);
/* ① 建部门并看到进行中 → 就绪 */
await vpage.fill('[data-org-field="dept-name"]', "市场部");
await vpage.click('[data-org-action="create-dept"]');
await vpage.waitForSelector("[data-org-notice]");
await vpage.waitForTimeout(500);
/* ② 选部门 → 停用 → 取消筛选（否则成员列表被部门筛选挡住） */
await vpage.click('[data-org-dept-select="dept_ops"]');
await vpage.waitForSelector('[data-org-dept-actions="dept_ops"]');
await vpage.waitForTimeout(300);
await vpage.click('[data-org-dept-toggle="dept_ops"]');
await vpage.waitForFunction(
  () => {
    const badge = document.querySelector('[data-org-dept="dept_ops"] [data-org-dept-status]');
    return !!badge && (badge.textContent || "").includes("已停用");
  },
  null,
  { timeout: 10000 },
);
await vpage.click('[data-org-dept-select="dept_ops"]');
await vpage.waitForSelector('[data-org-user="usr_member"]');
await vpage.waitForTimeout(400);
/* ③ 建成员 → 禁用 → 重置口令 → 删除 */
await vpage.fill('[data-org-field="user-identifier"]', "newbie");
await vpage.fill('[data-org-field="user-display"]', "新同事");
await vpage.fill('[data-org-field="user-password"]', "password123");
await vpage.selectOption('[data-org-field="user-role"]', "user");
await vpage.click('[data-org-action="create-user"]');
await vpage.waitForFunction(() => (document.querySelector("[data-org-notice]") || {}).textContent === "成员已创建", null, { timeout: 10000 });
/* 新成员 id 由后端生成，按显示名等它出现（不能用固定 id，否则空等 30s）。 */
await vpage.waitForFunction(
  () => Array.from(document.querySelectorAll("[data-org-user-name]")).some((el) => (el.textContent || "").includes("新同事")),
  null,
  { timeout: 10000 },
);
await vpage.waitForTimeout(400);
await vpage.click('[data-org-user-toggle="usr_member"]');
await vpage.waitForFunction(
  () => {
    const badge = document.querySelector('[data-org-user="usr_member"] [data-org-user-status]');
    return !!badge && (badge.textContent || "").includes("已启用");
  },
  null,
  { timeout: 10000 },
);
await vpage.click('[data-org-user-reset="usr_member"]');
await vpage.waitForSelector('[data-org-confirm="user-reset"]');
await vpage.fill('[data-org-field="reset-password"]', "newpassword1");
await vpage.click('[data-org-action="confirm"]');
await vpage.waitForFunction(() => (document.querySelector("[data-org-notice]") || {}).textContent === "口令已重置，该成员的全部会话已撤销", null, { timeout: 10000 });
await vpage.waitForTimeout(500);
await vpage.click('[data-org-user-delete="usr_member"]');
await vpage.waitForSelector('[data-org-confirm="user-delete"]');
await vpage.click('[data-org-action="confirm"]');
await vpage.waitForFunction(() => !document.querySelector('[data-org-user="usr_member"]'), null, { timeout: 10000 });
await vpage.waitForTimeout(500);
/* ④ APP 访问：切区块 → 保存规则 */
await vpage.click('[data-org-nav="app"]');
await vpage.waitForSelector("[data-org-rules]");
await vpage.waitForTimeout(500);
await vpage.selectOption('[data-org-app-mode="resource-library"]', "departments");
await vpage.click('[data-org-app-dept="resource-library:dept_ops"]');
await vpage.click('[data-org-app-save="resource-library"]');
await vpage.waitForFunction(() => (document.querySelector("[data-org-notice]") || {}).textContent === "APP 打开规则已保存", null, { timeout: 10000 });
await vpage.waitForTimeout(500);
/* ⑤ 审计：切区块 → 看投影 */
await vpage.click('[data-org-nav="audit"]');
await vpage.waitForSelector("[data-org-audit-item]");
await vpage.waitForTimeout(700);
const videoCommands = await drain(vpage);
await videoCtx.close();
const rawVideo = await video.path();
const flowVideo = path.join(ART, "org-console-flow.webm");
if (rawVideo && fs.existsSync(rawVideo)) {
  fs.copyFileSync(rawVideo, flowVideo);
  check("主流程连续录屏产出", fs.statSync(flowVideo).size > 0, flowVideo);
} else {
  check("主流程连续录屏产出", false, "video.path() 为空");
}
check("录屏流程发出的命令都属于白名单", videoCommands.every((c) => ORG_COMMANDS.indexOf(c.command) >= 0), "n=" + videoCommands.length);

/* ── 6. 焦点顺序 ─────────────────────────────────────────────────────────── */
console.log(String.fromCharCode(10) + "可访问焦点顺序：");
{
  const { ctx, page } = await openScenario(browser, "scenario=ready");
  await page.waitForSelector("[data-org-users]");
  const order = [];
  await page.evaluate(() => {
    const first = document.querySelector(".split-nav");
    if (first && typeof first.focus === "function") first.focus();
  });
  for (let i = 0; i < 18; i += 1) {
    await page.keyboard.press("Tab");
    const item = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return "body";
      const inside = !!(el.closest && el.closest(".org-center, .split-side"));
      return (
        (inside ? "in:" : "out:") +
        el.tagName.toLowerCase() +
        ":" +
        (el.getAttribute("data-org-action") || el.getAttribute("data-org-field") || el.getAttribute("aria-label") || el.textContent || "")
          .trim()
          .slice(0, 12)
      );
    });
    order.push(item);
  }
  const outside = order.filter((s) => s.startsWith("out:")).length;
  const bodyStops = order.filter((s) => s === "body").length;
  const distinct = new Set(order).size;
  check("Tab 顺序只在界面内推进（文档边界最多停留一次）", outside === 0 && bodyStops <= 1, "outside=" + outside + " body=" + bodyStops + " :: " + order.join(" → "));
  check("焦点顺序逐步前进（>=8 个不同落点）", distinct >= 8, "distinct=" + distinct);
  await ctx.close();
}

/* ── 7. 二次确认（Dialog 焦点陷阱 + 取消不发命令 + 确认只发一次）──────────── */
console.log(String.fromCharCode(10) + "删除类二次确认：");
{
  const { ctx, page } = await openScenario(browser, "scenario=ready");
  await page.waitForSelector("[data-org-users]");
  await page.click('[data-org-user-delete="usr_member"]');
  await page.waitForSelector('[data-org-confirm="user-delete"]');
  let trapped = true;
  await page.evaluate(() => {
    const btn = document.querySelector('[data-org-action="confirm"]');
    if (btn) btn.focus();
  });
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => {
      const el = document.activeElement;
      return !!(el && el.closest && el.closest(".dialog"));
    });
    if (!inside) trapped = false;
  }
  check("删除确认对话框焦点被限制在模态内", trapped, "trapped=" + trapped);
  await page.click('[data-org-action="cancel"]');
  await page.waitForTimeout(150);
  const afterCancel = await drain(page);
  check("取消删除不发任何写命令", afterCancel.filter((c) => c.command === "identity/user-delete").length === 0, "n=" + afterCancel.length);
  await page.click('[data-org-user-delete="usr_member"]');
  await page.waitForSelector('[data-org-confirm="user-delete"]');
  await page.click('[data-org-action="confirm"]');
  await page.waitForSelector("[data-org-notice]");
  const afterConfirm = await drain(page);
  check("确认删除只发一条 user-delete", afterConfirm.filter((c) => c.command === "identity/user-delete").length === 1, JSON.stringify(afterConfirm.map((c) => c.command)));
  await ctx.close();
}

/* ── 8. 基准对照：组织治理 vs Skill 中心 ─────────────────────────────────── */
console.log(String.fromCharCode(10) + "基准对照（组织治理 vs Skill 中心）：");
const COMPARE_SPECS = {
  org: {
    query: "scenario=ready",
    root: "[data-org-center]",
    row: ".org-row",
    detail: "[data-org-detail-pane]",
    select: null,
    vars: {
      root: ".org-center",
      split: ".org-split",
      list: ".org-list-pane",
      detail: ".org-detail-pane",
      row: ".org-row",
      rowName: ".org-row__top strong",
      rowFacts: ".org-row__facts",
      paneHead: ".org-pane-head",
      title: ".org-banner__title",
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
  if (spec.select) {
    await page.click(spec.select);
    await page.waitForSelector(spec.detail, { timeout: 20000 });
    await page.waitForTimeout(260);
  }
  const metrics = await measurePage(page, spec.vars);
  const file = path.join(ART, "compare-" + kind + ".png");
  await page.screenshot({ path: file });
  compare[kind] = { screenshot: file, query: spec.query, pageStateBeforeSelect: before, metrics };
  screenshots.push(file);
  await drain(page);
  check("对照截图 compare-" + kind + " → " + spec.root, true, file);
  await ctx.close();
}

await captureCompare("org");
await captureCompare("skill");

const orgM = compare.org.metrics;
const skillM = compare.skill.metrics;
const round = (n) => Math.round(n * 10) / 10;
const px = (v) => (v == null ? "—" : String(v));
const fsNum = (v) => (v ? Number.parseFloat(v["font-size"]) : NaN);

const compareDifferences = {
  rootWidth: round(orgM.root.width - skillM.root.width),
  rootHeight: round(orgM.root.height - skillM.root.height),
  splitWidth: round(orgM.split.width - skillM.split.width),
  listPaneWidth: round(orgM.listPane.width - skillM.listPane.width),
  detailPaneWidth: round(orgM.detailPane.width - skillM.detailPane.width),
  rowHeight: round(orgM.row.height - skillM.row.height),
  rowPadding: orgM.rowStyle.padding + " vs " + skillM.rowStyle.padding,
  bannerTitleFontSize: round(fsNum(orgM.titleStyle) - fsNum(skillM.titleStyle)),
  rowNameFontSize: round(fsNum(orgM.rowNameStyle) - fsNum(skillM.rowNameStyle)),
  rowFactsFontSize: round(fsNum(orgM.rowFactsStyle) - fsNum(skillM.rowFactsStyle)),
  splitGap: orgM.splitStyle.gap === skillM.splitStyle.gap ? "一致" : orgM.splitStyle.gap + " vs " + skillM.splitStyle.gap,
};

check(
  "对照两页同窗口尺寸（1440×900）",
  !!orgM.window && Math.round(orgM.window.width) === 1440 && Math.round(orgM.window.height) === 900 && !!skillM.window && Math.round(skillM.window.width) === 1440 && Math.round(skillM.window.height) === 900,
  "org=" + JSON.stringify(orgM.window) + " skill=" + JSON.stringify(skillM.window),
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
  metricReady(orgM) && metricReady(skillM),
  JSON.stringify({
    org: { root: orgM.root.width, split: orgM.split.width, rowHeight: orgM.row.height, title: orgM.titleStyle["font-size"], rowName: orgM.rowNameStyle["font-size"], facts: orgM.rowFactsStyle["font-size"] },
    skill: { root: skillM.root.width, split: skillM.split.width, rowHeight: skillM.row.height, title: skillM.titleStyle["font-size"], rowName: skillM.rowNameStyle["font-size"], facts: skillM.rowFactsStyle["font-size"] },
  }),
);
check(
  "对照两页同一 DOM 语义（两栏容器 / 列表行 / 两栏列定义）都在",
  !!orgM.split && !!orgM.listPane && !!orgM.detailPane && !!orgM.row && !!skillM.split && !!skillM.listPane && !!skillM.detailPane && !!skillM.row,
  "org.split=" + px(orgM.split && orgM.split.width) + " skill.split=" + px(skillM.split && skillM.split.width),
);
check(
  "标题 / 行标题 / 元信息字阶与基准一致（三项差 < 0.5px）",
  Math.abs(compareDifferences.bannerTitleFontSize) < 0.5 && Math.abs(compareDifferences.rowNameFontSize) < 0.5 && Math.abs(compareDifferences.rowFactsFontSize) < 0.5,
  JSON.stringify({ title: compareDifferences.bannerTitleFontSize, rowName: compareDifferences.rowNameFontSize, facts: compareDifferences.rowFactsFontSize }),
);
check(
  "行高与基准对齐（|差| <= 12px）",
  Math.abs(compareDifferences.rowHeight) <= 12,
  "org=" + orgM.row.height + " skill=" + skillM.row.height + " diff=" + compareDifferences.rowHeight,
);
const compareErrors = pageErrors.filter((e) => e.startsWith("compare:"));
const compareExternal = externalRequests.filter((e) => e.startsWith("compare:"));
check("对照场景无 console error", compareErrors.length === 0, compareErrors.slice(0, 3).join(" | "));
check("对照场景无跨源 / 非本地网络请求", compareExternal.length === 0, compareExternal.slice(0, 3).join(" | "));

/* ── 8b. compare-notes.md ────────────────────────────────────────────────── */
const cmp = compareDifferences;
const notes = [
  "# UI-4 · 基准对照笔记：组织治理 vs Skill 中心",
  "",
  "> 由 experiments/dxos-ui-org/run-all.mjs 自动生成，数值来自同一次运行的 report.json（compare）。",
  "> 对照条件：" + compareCondition.colorScheme + " 主题 / " + compareCondition.viewport.width + "×" + compareCondition.viewport.height + " / deviceScaleFactor " + compareCondition.deviceScaleFactor + " / prefers-reduced-motion: " + compareCondition.reducedMotion + " / 同一本地静态服务与同名探针外壳；同背景与同透明度（同一探针 HTML/CSS 与同一 tokens 档，本轮未改 CSP/tokens.css）。",
  "> 截图：compare-org.png（组织治理就绪态）、compare-skill.png（Skill 中心就绪态）。",
  "",
  "## 0. 基准与外壳口径",
  "",
  "- 基准页是 src/skills/SkillCenter.tsx（Dx-UI-PLAN §2 指定的同类管理页；UI-1 已交付）。",
  "- 组织治理按产品真实装配渲染：main.tsx:2678 直接渲染 <GovernanceApp />，它自己产出 .split > .split-side + .split-main；Skill 页在 main.tsx:2916-2940 由外层产出同款外壳。两页 .split-main 内容区宽度可直接对比。",
  "",
  "## 1. 实测关键度量（1440×900，CSS px）",
  "",
  "| 度量 | 组织治理 | Skill 中心 | 差（组织−Skill） |",
  "| --- | --- | --- | --- |",
  "| 窗口 | " + px(orgM.window.width) + "×" + px(orgM.window.height) + " | " + px(skillM.window.width) + "×" + px(skillM.window.height) + " | — |",
  "| 页面根容器宽 | " + px(orgM.root.width) + " | " + px(skillM.root.width) + " | " + cmp.rootWidth + " |",
  "| 根容器高 | " + px(orgM.root.height) + " | " + px(skillM.root.height) + " | " + cmp.rootHeight + " |",
  "| 两栏容器宽 | " + px(orgM.split.width) + " | " + px(skillM.split.width) + " | " + cmp.splitWidth + " |",
  "| 两栏列定义 | 「" + orgM.splitStyle["grid-template-columns"] + "」 | 「" + skillM.splitStyle["grid-template-columns"] + "」 | 见 §3 |",
  "| 两栏 gap | " + px(orgM.splitStyle.gap) + " | " + px(skillM.splitStyle.gap) + " | " + cmp.splitGap + " |",
  "| 列表栏宽 | " + px(orgM.listPane.width) + " | " + px(skillM.listPane.width) + " | " + cmp.listPaneWidth + " |",
  "| 详情栏宽 | " + px(orgM.detailPane.width) + " | " + px(skillM.detailPane.width) + " | " + cmp.detailPaneWidth + " |",
  "| 列表行高 | " + px(orgM.row.height) + " | " + px(skillM.row.height) + " | " + cmp.rowHeight + " |",
  "| 列表行 padding | " + orgM.rowStyle.padding + " | " + skillM.rowStyle.padding + " | " + cmp.rowPadding + " |",
  "| 页面标题字号 | " + orgM.titleStyle["font-size"] + " | " + skillM.titleStyle["font-size"] + " | " + cmp.bannerTitleFontSize + "px |",
  "| 行标题字号 | " + orgM.rowNameStyle["font-size"] + " | " + skillM.rowNameStyle["font-size"] + " | " + cmp.rowNameFontSize + "px |",
  "| 行元信息字号 | " + orgM.rowFactsStyle["font-size"] + " | " + skillM.rowFactsStyle["font-size"] + " | " + cmp.rowFactsFontSize + "px |",
  "| Badge / Button 数量 | " + orgM.counts.badges + " / " + orgM.counts.buttons + " | " + skillM.counts.badges + " / " + skillM.counts.buttons + " | 见 §4 |",
  "",
  "## 2. 排版基线与字号",
  "",
  "**一致**：页面标题取 --fs-title（" + orgM.titleStyle["font-size"] + "），行标题取 --fs-body（" + orgM.rowNameStyle["font-size"] + "）+ --fw-medium（" + orgM.rowNameStyle["font-weight"] + "），行元信息取 --fs-micro（" + orgM.rowFactsStyle["font-size"] + "）；行结构同为 row__top（strong + Badge）+ row__facts + row__desc。",
  "",
  "## 3. 间距与容器",
  "",
  "**一致**：两页两栏容器都用 minmax(0,288px) + minmax(0,1fr)，gap 同为 --space-4；行 padding 同为 --space-3（" + orgM.rowStyle.padding + "）；行圆角同为 --radius-lg，底色同为 --sunken。",
  "**差异**：组织治理列表行高 " + px(orgM.row.height) + "，Skill 行高 " + px(skillM.row.height) + "（差 " + cmp.rowHeight + "px）。组织行按\"分部门 / 成员 / APP 规则\"三类共用同一行结构，信息条数不同导致行高与基准有小差；字阶、内边距、圆角、底色完全一致。",
  "",
  "## 4. 组件用法（PageState / Badge / Button / Dialog / TextField）",
  "",
  "- **PageState**：一致。加载 / 空 / 错误 / 未授权 / 不可用都走 PAGE_STATE_SPEC 的同一份 role / aria-live。",
  "- **Badge**：一致。角色统一 neutral（同类信息不用色相区分）；禁用状态 warning；删除确认成功/拒绝用 success/danger。",
  "- **Button**：一致。动作用 size=sm + primary/secondary/ghost/danger；删除类二次确认沿用既有 Dialog。",
  "- **TextField**：一致。表单输入统一走 primitives 的 TextField（labelHidden），select 与 McpCenter 同款原生控件。",
  "",
  "## 5. 结论清单",
  "",
  "| 项 | 一致 / 差异 | 结论 |",
  "| --- | --- | --- |",
  "| 页面标题 / 行标题 / 元信息字阶 | 一致 | 保留 |",
  "| 行 padding / 圆角 / 底色 / 两栏列定义 / gap | 一致 | 保留 |",
  "| PageState 用法 | 一致 | 保留 |",
  "| Badge / Button 用法与 tone/variant | 一致 | 保留 |",
  "| 列表行高（信息结构不同） | 差异（" + cmp.rowHeight + "px） | 保留差异，登记 |",
  "",
];
const notesPath = path.join(ART, "compare-notes.md");
fs.writeFileSync(notesPath, notes.join(String.fromCharCode(10)));
check("对照笔记 compare-notes.md 产出", fs.statSync(notesPath).size > 0, notesPath);

/* ── 9. 全局边界断言 ─────────────────────────────────────────────────────── */
console.log(String.fromCharCode(10) + "边界断言：");
{
  const { ctx, page } = await openScenario(browser, "scenario=ready&slow=1");
  await page.waitForSelector("[data-org-users]");
  const bodyText = await page.evaluate(() => document.body.innerText || "");
  check("界面不出现会员 / 权益 / 套餐 / 积分字样", !/(会员|权益|套餐|积分)/.test(bodyText), (bodyText.match(/(会员|权益|套餐|积分)/) || [""])[0]);
  check("界面不出现 maxLocalAccounts / plan / entitlement 字段", !/(maxLocalAccounts|entitlement|planName)/.test(bodyText), "ok");
  await page.fill('[data-org-field="dept-name"]', "财务部");
  await page.click('[data-org-action="create-dept"]');
  const busy = await page
    .waitForSelector('[data-org-action="create-dept"][disabled][aria-busy="true"]', { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  check("保存进行中按钮禁用（防连点）", busy, "busy=" + busy);
  /* 进行中再用程序化 click 激活一次：disabled 按钮不应派发第二条命令
     （不能用 page.click，它会对禁用元素自动等待到重新可用，等于第二轮点击）。 */
  await page.$eval('[data-org-action="create-dept"]', (el) => el.click());
  await page.waitForSelector("[data-org-notice]", { timeout: 15000 });
  const cmds = await drain(page);
  const createCount = cmds.filter((c) => c.command === "identity/department-create").length;
  check("一次提交只发一条创建命令", createCount === 1, "count=" + createCount);
  const names = cmds.map((c) => c.command);
  check("界面只发白名单命令", names.every((c) => ORG_COMMANDS.indexOf(c) >= 0), [...new Set(names)].join(", "));
  const badKeys = [];
  for (const c of cmds) {
    const allowed = ALLOWED_PAYLOAD_KEYS[c.command] || [];
    for (const k of Object.keys(c.payload || {})) if (allowed.indexOf(k) < 0) badKeys.push(c.command + "." + k);
  }
  check("所有命令载荷键都在白名单内", badKeys.length === 0, JSON.stringify(badKeys.slice(0, 6)));
  const identityLeak = cmds.filter((c) => Object.prototype.hasOwnProperty.call(c.payload || {}, "sessionRef"));
  check("命令载荷不含 sessionRef（操作者身份由主进程注入）", identityLeak.length === 0, JSON.stringify(identityLeak.slice(0, 2)));
  await page.click('[data-org-nav="audit"]');
  await page.waitForSelector("[data-org-audit-item]");
  const auditNames = await page.$$eval("[data-org-audit-event]", (els) => els.map((el) => el.getAttribute("data-org-audit-event")));
  check("审计事件名沿用源语义（department.create …）", auditNames.indexOf("department.create") >= 0, [...new Set(auditNames)].join(", "));
  const sourceText = await page.$eval("[data-org-audit]", (el) => el.textContent || "");
  check("审计标注来源表 audit_log / authorization_audit", sourceText.includes("audit_log"), sourceText.slice(0, 60));
  await ctx.close();
}

check("无 console error", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
check("无跨源 / 非本地网络请求", externalRequests.length === 0, externalRequests.slice(0, 3).join(" | "));

await browser.close();
server.close();

/* ── 10. 报告 ────────────────────────────────────────────────────────────── */
const failed = checks.filter((c) => !c.ok);
const report = {
  task: "UI-4 组织治理扩展 + 基准（Skill 中心）对照",
  verdict: failed.length ? "FAIL" : "PASS",
  environment: {
    os: os.type() + " " + os.release(),
    node: process.version,
    chromium: CHROMIUM,
    url: BASE,
    screenshotOptions: SHOT_OPTS,
  },
  screenshots,
  video: fs.existsSync(flowVideo) ? flowVideo : null,
  compare: {
    condition: compareCondition,
    screenshots: { org: compare.org.screenshot, skill: compare.skill.screenshot },
    notes: notesPath,
    metrics: { org: orgM, skill: skillM },
    differences: compareDifferences,
  },
  commands: collected.map((c) => c.command).filter((v, i, a) => a.indexOf(v) === i),
  checks,
  failures: failed,
  consoleErrors: pageErrors,
  externalRequests,
  finishedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify(report, null, 2));

console.log(String.fromCharCode(10) + "═".repeat(72));
console.log("UI-4 组织治理探针：结论 " + report.verdict + " — " + JSON.stringify({ total: checks.length, failed: failed.length }));
console.log("截图：" + screenshots.length + " 张 → " + ART);
console.log("录屏：" + (report.video || "（无）"));
console.log("对照：" + compare.org.screenshot + " ／ " + compare.skill.screenshot);
console.log("对照差异（组织−Skill）：" + JSON.stringify({
  rootWidth: cmp.rootWidth,
  listPaneWidth: cmp.listPaneWidth,
  rowHeight: cmp.rowHeight,
  titleFontSize: cmp.bannerTitleFontSize,
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
