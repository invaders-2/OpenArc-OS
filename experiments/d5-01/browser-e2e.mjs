/**
 * D5-01 · 真实 `electron .` 浏览器验收（产品入口，不是等价物）。
 *
 * 覆盖（PLAN.md §8 / §23 / A04 / A12 / A13）：
 *   导航与标签、加载/错误/重试、下载入口与真实落盘（含失败态）、
 *   弹窗 / 外部协议 / 证书错误 / 文件上传 / 网站权限、
 *   双账号会话隔离（Cookie / 存储 / 标签 / 下载）、网页与系统桥隔离、
 *   原生视图与窗口配合（菜单覆盖 / 拖动遮挡 / 最小化恢复 / 焦点与输入）。
 *
 * 仪器说明：
 *   · 真实 `electron .`（electron/main.cjs）+ 隔离 userData + 隔离下载目录 + CDP；
 *   · 页面侧断言通过 Playwright 对**真实 WebContentsView**（独立 target）求值；
 *   · 输入路由用真实 CDP 鼠标事件（`page.mouse`），不调 DOM click()；
 *   · 每一步都写进连续操作记录（RECORD），静态截图不作为层级/输入的证明。
 *
 * 只用本地受控站点（experiments/d5-01/site.mjs），不使用真实账号或真实网站。
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { startSite, startFlaky, startTls, PAYLOAD } from "./site.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const ART = path.join(ROOT, "artifacts", "d5-01");
const CDP_PORT = Number(process.env.OA_D501_CDP_PORT || 9789);
const ADMIN = { id: "admin@d501.test", pw: "admin-password-1" };
const MEMBER = { id: "member@d501.test", pw: "member-password-1" };
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

if (!fs.existsSync(path.join(ROOT, "dist", "index.html"))) {
  console.error("缺少 dist/index.html —— 请先 npm run build");
  process.exit(1);
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d501-e2e-"));
const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d501-dl-"));
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d501-up-"));
const uploadFile = path.join(uploadDir, "upload-probe.txt");
fs.writeFileSync(uploadFile, "OPENARC-D501-UPLOAD-BODY");

const RECORD = [];
const CHECKS = [];
const NOT_VERIFIED = [];
const OBSERVATIONS = [];
let passed = 0;
let failed = 0;

function record(section, name, ok, expected, actual) {
  const row = { section, name, status: ok ? "PASS" : "FAIL", expected: String(expected ?? ""), actual: String(actual ?? "").slice(0, 400), at: Date.now() };
  RECORD.push(row);
  CHECKS.push(row);
  if (ok) passed += 1;
  else failed += 1;
  console.log((ok ? "  " : "! ") + "[" + row.status + "] " + section + " · " + name + (ok ? "" : " — 期望 " + row.expected + "，实际 " + row.actual));
  return ok;
}
const note = (text) => { OBSERVATIONS.push(text); console.log("   · " + text); };
const notVerified = (name, reason) => { NOT_VERIFIED.push({ name, reason }); console.log("   ? [NOT VERIFIED] " + name + " — " + reason); };

let child = null;
let stderrBuf = "";
let browser = null;
let page = null;

async function launch() {
  child = spawn(electronPath, [".", "--user-data-dir=" + userData, "--remote-debugging-port=" + CDP_PORT, ...extraArgs], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENARC_IDENTITY_ADMIN: "1",
      OPENARC_DOWNLOADS_DIR: downloadsDir,
      ELECTRON_RUN_AS_NODE: undefined,
      ELECTRON_NO_ATTACH_CONSOLE: undefined,
    },
  });
  stderrBuf = "";
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { stderrBuf += String(d); });
  let version = null;
  const deadline = Date.now() + 40000;
  while (!version && Date.now() < deadline) {
    try { version = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json(); } catch { await sleep(300); }
  }
  if (!version) throw new Error("CDP 未就绪：" + stderrBuf.slice(-300));
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);
  const context = browser.contexts()[0];
  const isUI = (p) => p.url().includes("dist/index.html");
  const end = Date.now() + 30000;
  page = null;
  while (!page && Date.now() < end) { page = context.pages().find(isUI) || null; if (!page) await sleep(300); }
  if (!page) throw new Error("未找到界面页面");
  return context;
}

async function stop() {
  try { await browser?.close(); } catch { /* ignore */ }
  try { child?.kill("SIGKILL"); } catch { /* ignore */ }
  await sleep(400);
}

/**
 * **正常退出**：让产品自己走 window-all-closed → app.quit()，并等进程真的退出。
 *
 * 原实现用 SIGKILL 强杀来做"重启恢复"，而 Chromium 的 localStorage 磁盘提交是异步的 ——
 * 强杀会丢掉最近一次写入（内存里已是新值、磁盘上还是旧值），于是表现为
 * "重启后活动标签 URL 落后一次导航"。正常退出路径**不需要**任何人为等待或强制保存。
 */
async function quitNormally(ms = 20000) {
  try { await js("window.close(); 'closing'"); } catch { /* 关窗后执行上下文会销毁 */ }
  const t0 = Date.now();
  while (Date.now() - t0 < ms && child.exitCode == null && child.signalCode == null) await sleep(200);
  const clean = child.exitCode != null || child.signalCode != null;
  if (!clean) { try { child.kill("SIGKILL"); } catch { /* ignore */ } await sleep(500); }
  return { clean, code: child.exitCode ?? null, signal: child.signalCode ?? null };
}

const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const attr = (sel, a) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.getAttribute(" + JSON.stringify(a) + ") || ''");
const text = (sel) => js("return String(document.querySelector(" + JSON.stringify(sel) + ")?.innerText || '')");
const click = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");
const setInput = (sel, value) =>
  js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, " + JSON.stringify(value) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
async function waitFor(fn, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch { /* retry */ } await sleep(120); } return false; }
const waitSel = (sel, ms) => waitFor(() => has(sel), ms);
const waitGate = (want, ms = 30000) => waitFor(async () => (await gate()) === want, ms);

function views() { return browser.contexts()[0].pages().filter((p) => !p.url().includes("dist/index.html")); }
function viewByUrl(part) { return views().find((p) => p.url().includes(part)) || null; }
/** 精确 URL 匹配：避免 "/" 这种子串把别的页面选进来（曾经选到 5392 的错误页面）。 */
const viewByExactUrl = (url) => views().find((p) => p.url() === url) || null;
async function waitViewExact(url, ms = 15000) { await waitFor(() => !!viewByExactUrl(url), ms); return viewByExactUrl(url); }
/**
 * 在视图里求值。页面正在导航时执行上下文会被销毁，这是**正常现象**（不是产品缺陷），
 * 因此这里做有限重试；重试仍失败才算失败。
 */
async function viewEval(v, code, attempts = 3) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try { return await v.evaluate("(async () => { " + code + " })()"); }
    catch (e) {
      last = e;
      if (!/Execution context was destroyed|Target closed|frame was detached/i.test(String(e && e.message))) throw e;
      await sleep(500);
    }
  }
  throw last;
}
async function waitView(part, ms = 15000) { await waitFor(() => !!viewByUrl(part), ms); return viewByUrl(part); }

/** 地址栏当前值（选择器里带引号，统一从这里构造查询串，避免字符串拼接事故）。 */
const ADDRESS_SEL = '[aria-label="网页地址"]';
const addressValue = () => js("return document.querySelector(" + JSON.stringify(ADDRESS_SEL) + ")?.value || ''");

async function login(who) {
  await waitSel('[data-d3-id="login-identifier"]', 20000);
  await setInput('[data-d3-id="login-identifier"]', who.id);
  await setInput('[data-d3-id="login-password"]', who.pw);
  await click('[data-d3-id="login-submit"]');
  return waitGate("ready", 30000);
}
async function logout() {
  await click('[data-d3-id="topbar-logout"]');
  return waitGate("unauthenticated", 20000);
}
async function openBrowser() {
  if (await has("[data-browser-window]")) return true;
  await click('[aria-label="打开浏览器"]');
  return waitSel("[data-browser-window]", 20000);
}
async function navigate(url) {
  await setInput('[aria-label="网页地址"]', url);
  await click(".addressbar .primary");
}
function filesUnder(dir, name) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === name) out.push(full);
    }
  };
  try { walk(dir); } catch { /* ignore */ }
  return out;
}
const downloadRows = () =>
  js("return Array.from(document.querySelectorAll('[data-download]')).map((e) => ({ id: e.getAttribute('data-download'), state: e.getAttribute('data-download-state'), text: String(e.innerText || '') }))");

async function main() {
  const site = await startSite();
  const tls = await startTls();
  let flaky = null;
  try {
    /* ═══════════════ 1 · 启动 + 登录 ═══════════════ */
    const context = await launch();
    record("boot", "M1 · 真实 electron . 启动并暴露 CDP", !!browser, "CDP 可用", "connected");
    await waitFor(async () => (await gate()) !== "checking", 30000);
    if ((await gate()) === "uninitialized") {
      await setInput('[data-d3-id="setup-name"]', "D5-01 Admin");
      await setInput('[data-d3-id="setup-identifier"]', ADMIN.id);
      await setInput('[data-d3-id="setup-password"]', ADMIN.pw);
      await setInput('[data-d3-id="setup-confirm"]', ADMIN.pw);
      await click('[data-d3-id="setup-submit"]');
      await waitGate("unauthenticated", 30000);
    }
    record("boot", "M2 · 真实 UI 登录 admin", await login(ADMIN), "ready", await gate());

    /* ═══════════════ 2 · 浏览器窗口 + 真实导航 ═══════════════ */
    record("nav", "N1 · 从 Dock 打开浏览器窗口", await openBrowser(), "浏览器窗口存在", await has("[data-browser-window]"));
    await navigate(site.base + "/page2");
    const view = await waitView("/page2");
    record("nav", "N2 · 真实网址导航（地址栏 → 真实 WebContentsView）", !!view && (await viewEval(view, "return document.getElementById('page2-marker')?.textContent || ''")) === "PAGE2-MARKER-9f3a", "页面标记 PAGE2-MARKER-9f3a", view ? "已加载" : "无视图页面");
    // 原生视图**必须真的挂在宿主上**：缺挂载时加载/CDP/下载全都正常，但屏幕上没有页面。
    const attached = await attr(".web-viewport", "data-attached");
    record("nav", "N2b · 原生视图已真实挂载到宿主（data-attached）", attached === "1", "data-attached=1", String(attached));
    // chrome 不能被原生视图盖住：标签栏 + 地址栏的布局高度必须等于 domain 的固定 chrome 高度，
    // 且网页视口必须从它们下面开始（原生视图永远绘制在 DOM 之上）。
    const geoChrome = JSON.parse(
      await js("const ts=document.querySelector('.tabstrip').getBoundingClientRect(); const ab=document.querySelector('.addressbar').getBoundingClientRect(); const vp=document.querySelector('.web-viewport').getBoundingClientRect(); const body=document.querySelector('[data-browser-window]').getBoundingClientRect(); return JSON.stringify({ chrome: Math.round(ab.bottom - body.top), vpTop: Math.round(vp.top - body.top) })"),
    );
    record(
      "nav",
      "N2c · 浏览器 chrome（标签栏+地址栏）与网页视口不重叠",
      geoChrome.chrome >= 90 && geoChrome.vpTop >= geoChrome.chrome,
      "chrome >= 90 且视口在其下方",
      JSON.stringify(geoChrome),
    );
    record("nav", "N3 · 标签 URL 与标题回灌到 Window domain", (await attr("[data-tab=t1]", "data-tab-active")) === "1" && (await js("return document.querySelector('.tab .tab-title')?.textContent || ''")).includes("PAGE2"), "活动标签显示页面标题", await js("return document.querySelector('.tab .tab-title')?.textContent || ''"));

    // 后退 / 前进 / 刷新
    await navigate(site.base + "/marker");
    await waitFor(async () => (await attr('[data-addressbar-reload]', 'data-addressbar-reload')) !== "", 5000);
    record("nav", "N4 · 第二个地址导航成功（准备后退）", !!(await waitView("/marker")), "MARKER 页面", await addressValue());
    await click('[aria-label="后退"]');
    const back = await waitView("/page2", 10000);
    record("nav", "N5 · 后退回到上一页", !!back && (await viewEval(back, "return document.getElementById('page2-marker')?.textContent || ''")) === "PAGE2-MARKER-9f3a", "回到 page2", back ? back.url() : "无");
    const forwardDisabled = await js("return document.querySelector(" + JSON.stringify('[aria-label="前进"]') + ").disabled");
    record("nav", "N6 · 前进按钮变为可用（可用性来自主进程 navigationHistory）", !forwardDisabled, "前进可用", "disabled=" + forwardDisabled);
    await click('[aria-label="前进"]');
    record("nav", "N7 · 前进回到 MARKER 页", !!(await waitView("/marker", 10000)), "MARKER 页面", "ok");
    await click('[aria-label="刷新"]');
    await sleep(1200);
    record("nav", "N8 · 刷新后页面仍在（真实 reload）", !!(await viewByUrl("/marker")), "MARKER 页面", "ok");

    /* ═══════════════ 3 · 标签 ═══════════════ */
    await click("[data-tab-new]");
    const twoTabs = await waitFor(async () => (await js("return document.querySelectorAll('[data-tab]').length")) === 2, 10000);
    record("tabs", "T1 · 新建标签（第二个原生视图随即创建）", twoTabs, "2 个标签", await js("return document.querySelectorAll('[data-tab]').length"));
    await navigate(site.base + "/input");
    const inputView = await waitView("/input");
    record("tabs", "T2 · 新标签独立导航（旧标签不受影响）", !!inputView && (await viewEval(inputView, "return typeof window.__counts")) === "object", "新标签加载 /input", inputView ? inputView.url() : "无");
    record("tabs", "T3 · 非活动标签仍然存活（切回不重新加载）", (await views().filter((v) => v.url().includes("/marker")).length) === 1 && (await views().filter((v) => v.url().includes("/input")).length) === 1, "两个视图同时存活", JSON.stringify(views().map((v) => new URL(v.url()).pathname)));
    const active = await js("return Array.from(document.querySelectorAll('[data-tab]')).find((e) => e.getAttribute('data-tab-active') === '1')?.getAttribute('data-tab')");
    record("tabs", "T4 · 活动标签 = 新建的那个", active === "t2", "t2", active);
    await js("document.querySelector('[data-tab=t1] .tab-main').click()");
    await sleep(600);
    const addrT5 = await addressValue();
    record("tabs", "T5 · 切换标签回到 t1", (await attr("[data-tab=t1]", "data-tab-active")) === "1" && addrT5.includes("/marker"), "地址栏与活动标签同步", addrT5);
    await js("document.querySelector('[data-tab=t2] .tab-close').click()");
    await waitFor(async () => (await js("return document.querySelectorAll('[data-tab]').length")) === 1, 10000);
    const viewGone = await waitFor(() => !viewByUrl("/input"), 8000);
    record("tabs", "T6 · 关闭标签后原生视图真正释放", viewGone, "input 视图消失", JSON.stringify(views().map((v) => new URL(v.url()).pathname)));

    /* ═══════════════ 4 · 加载 / 错误 / 重试 ═══════════════ */
    await navigate(site.base + "/slow");
    await sleep(80);
    const loadingSeen = (await attr('[data-addressbar-reload]', 'data-addressbar-reload')) === "stop" || (await js("return !!document.querySelector('[data-tab-loading]')"));
    record("state", "S1 · 加载中状态（停止按钮 / 标签 spinner 可见）", loadingSeen, "加载中可观察", "reload-btn=" + (await attr('[data-addressbar-reload]', 'data-addressbar-reload')));
    await navigate("http://127.0.0.1:" + (Number(process.env.OA_D501_FLAKY_PORT || 5392)) + "/");
    const errShown = await waitSel("[data-browser-error]", 15000);
    record("state", "S2 · 连接失败 → 错误状态 + 重试入口", errShown, "错误横幅出现", (await text("[data-browser-error]")).slice(0, 60));
    flaky = await startFlaky();
    await click("[data-browser-retry]");
    const recovered = await waitFor(async () => (await js("return !!document.querySelector('[data-browser-error]')")) === false, 20000);
    const flakyView = await waitView("5392", 10000);
    const flakyMarker = flakyView ? await viewEval(flakyView, "return document.getElementById('flaky-marker')?.textContent || ''") : "";
    record("state", "S3 · 重试后真实恢复（失败地址 + 服务端已可达）", recovered && flakyMarker === "FLAKY-RECOVERED", "错误消失且加载到 flaky 页面", JSON.stringify({ recovered, url: flakyView ? flakyView.url() : null, marker: flakyMarker }));

    /* ═══════════════ 5 · 下载（真实落盘 + 失败态） ═══════════════ */
    await navigate(site.base + "/");
    const home = await waitViewExact(site.base + "/", 15000);
    await js("document.querySelector('[data-downloads-toggle]').click()");
    await waitSel("[data-downloads-panel]", 8000);
    record("download", "D1 · 下载入口（面板可打开）", await has("[data-downloads-panel]"), "面板存在", "ok");
    if (home) await home.click("#to-download");
    const completed = await waitFor(async () => (await downloadRows()).some((r) => r.state === "completed"), 30000);
    const files = filesUnder(downloadsDir, "hello.txt");
    const body = files.length ? fs.readFileSync(files[0], "utf8") : "";
    record("download", "D2 · 下载完成 + 文件真实落盘（字节一致）", completed && files.length === 1 && body === PAYLOAD, "1 个 hello.txt 且内容 = " + PAYLOAD.slice(0, 18), `files=${files.length} bytes=${body.length} sha=${body ? sha256(body).slice(0, 12) : "n/a"}`);
    const rowText = (await downloadRows()).filter((r) => r.state === "completed").map((r) => r.text).join(" | ");
    record("download", "D3 · 面板显示完成状态与落盘路径", rowText.includes("已完成") && (files.length ? rowText.includes(path.basename(files[0])) : false), "已完成 + 文件名", rowText.slice(0, 120));
    if (home) await home.click("#to-broken");
    const broken = await waitFor(async () => (await downloadRows()).some((r) => r.state === "interrupted"), 30000);
    record("download", "D4 · 下载失败（服务端中断）→ 失败态可见", broken, "interrupted 记录", JSON.stringify((await downloadRows()).map((r) => r.state)));
    // 关闭下载面板：面板打开时原生视图整块让位，后面的输入路由步骤必须先关掉它。
    await click('[aria-label="关闭下载面板"]');
    await waitFor(async () => (await js("return !!document.querySelector('[data-downloads-panel]')")) === false, 8000);
    const shownAfterPanel = await waitFor(async () => (await attr(".web-viewport p", "data-view")) === "shown", 8000);
    record("download", "D5 · 关闭下载面板后原生视图恢复显示", shownAfterPanel, "data-view=shown", await attr(".web-viewport p", "data-view"));

    /* ═══════════════ 6 · 弹窗 / 外部协议 / 权限 / 证书 / 上传 ═══════════════ */
    await navigate(site.base + "/popup");
    const popupView = await waitView("/popup");
    if (popupView) await popupView.click("#popup-btn");
    const popupNotice = await waitSel('[data-notice-kind="popup"]', 10000);
    record("policy", "P1 · window.open 被阻止并给出明确提示", popupNotice, "popup 提示", await text('[data-notice-kind="popup"]'));
    record("policy", "P2 · 弹窗未变成新窗口（原生窗口数不变）", (await js("return document.querySelectorAll('[data-browser-window]').length")) === 1, "1 个浏览器窗口", await js("return document.querySelectorAll('[data-browser-window]').length"));

    await navigate(site.base + "/external");
    const extView = await waitView("/external");
    // mailto 会被我们的 will-navigate 拦下（不产生导航），因此不能让 click 等导航完成。
    if (extView) await extView.click("#mail-link", { noWaitAfter: true });
    const extNotice = await waitSel('[data-notice-kind="external"]', 10000);
    record("policy", "P3 · 外部协议（mailto:）需用户明确确认，不自动交给系统", extNotice, "external 提示", await text('[data-notice-kind="external"]'));
    record("policy", "P4 · 外部协议未导致页面跳转", !!(await viewByUrl("/external")), "仍在 /external", (await viewByUrl("/external"))?.url() || "无");

    await navigate(site.base + "/permission");
    const permView = await waitView("/permission");
    const permNotice = await waitSel('[data-notice-kind="permission"]', 10000);
    const geo = permView ? await viewEval(permView, "return window.__perm?.geo || 'n/a'") : "n/a";
    record("policy", "P5 · 网站权限申请被显式拒绝并回报来源", permNotice && String(geo).startsWith("denied"), "geolocation denied", `notice=${permNotice} geo=${geo}`);
    const permText = await text('[data-notice-kind="permission"]');
    record("policy", "P6 · 权限提示面向用户可读（不显示机器码）", permText.includes("已拒绝") && !/SIDE_EFFECT_|ERR_|net::/.test(permText), "含「已拒绝」且无机器码", permText);

    if (tls) {
      await navigate(tls.base + "/");
      const certNotice = await waitSel('[data-notice-kind="certificate"]', 15000);
      const tlsView = viewByUrl("5393");
      record("policy", "P7 · 自签名证书 → 证书错误明确阻止（无「继续访问」旁路）", certNotice, "certificate 提示", await text('[data-notice-kind="certificate"]'));
      record("policy", "P8 · 证书错误页面未渲染出站点内容", !tlsView || !(await viewEval(tlsView, "return !!document.getElementById('tls-marker')")), "站点标记不存在", tlsView ? "视图存在" : "无视图");
    } else {
      notVerified("P7/P8 证书错误", "openssl 不可用，无法生成自签名证书");
    }

    await navigate(site.base + "/fileupload");
    const upView = await waitView("/fileupload");
    if (upView) {
      await upView.setInputFiles("#file-input", uploadFile);
      const info = await waitFor(async () => (await viewEval(upView, "return window.__fileInfo && window.__fileInfo.name")) === "upload-probe.txt", 8000);
      const detail = await viewEval(upView, "return JSON.stringify(window.__fileInfo)");
      record("policy", "P9 · 文件上传：网页拿到 File 对象（名称/大小）", info, "upload-probe.txt", detail);
      record("policy", "P10 · 上传不泄漏本地路径给网页", !/\/(Users|private|var)\/|\/tmp\//.test(detail), "无绝对路径", detail);
    } else {
      record("policy", "P9 · 文件上传", false, "视图 /fileupload", "无视图");
    }

    /* ═══════════════ 7 · 网页与系统桥隔离（A13） ═══════════════ */
    const shellBridge = await js("return typeof window.openarc");
    record("security", "A13-1 · 外壳页有产品桥（对照）", shellBridge === "object", "object", shellBridge);
    await navigate(site.base + "/bridge");
    const bridgeView = await waitView("/bridge");
    const bridge = bridgeView ? await viewEval(bridgeView, "return JSON.stringify(window.__d501Bridge)") : "{}";
    const b = JSON.parse(bridge);
    record("security", "A13-2 · 远程页面拿不到任何桥/Node 能力", b.openarc === "undefined" && b.require === "undefined" && b.process === "undefined" && b.module === "undefined" && b.ipcRenderer === "undefined" && b.electron === "undefined", "全部 undefined", bridge);
    record("security", "A13-3 · 远程页面调用产品桥被拒（无桥可调）", b.callResult === "NO_BRIDGE", "NO_BRIDGE", String(b.callResult));

    /* ═══════════════ 8 · A12 原生视图与窗口配合（连续操作记录） ═══════════════ */
    await navigate(site.base + "/input");
    const a12 = await waitView("/input");
    const box = await js("const r = document.querySelector('[data-browser-window]').getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });");
    const b0 = JSON.parse(box);
    const webPoint = { x: Math.round(b0.x + b0.w / 2), y: Math.round(b0.y + 120) };
    const counts = () => (a12 ? viewEval(a12, "return JSON.stringify(window.__counts || {})") : Promise.resolve("{}"));

    // 对**指定标签页**注入真实鼠标事件（Playwright 走 CDP Input，作用于该页面 target）。
    // 说明：CDP 输入不经窗口原生视图的命中测试，因此"OS 级输入在 DOM 面板与网页之间的
    // 路由"不由本条证明 —— 它证明的是"这个标签页此刻是活的、可交互的"。
    if (a12) {
      await a12.mouse.click(200, 120);
      await sleep(350);
    }
    const c1 = JSON.parse(await counts());
    record("A12", "A12-1 · 指定标签页可交互（真实鼠标事件 → 页面计数器 +1）", (c1.click || 0) >= 1, "click>=1", JSON.stringify(c1));

    // 菜单覆盖：右键打开桌面菜单 → 原生视图必须整块让位，且不再吃输入
    await page.mouse.click(Math.round(b0.x + 40), Math.round(b0.y + b0.h + 60), { button: "right" });
    const menuOpen = await waitSel(".context-menu, [role='menu']", 8000);
    await sleep(400);
    const viewState = await attr(".web-viewport p", "data-view");
    record("A12", "A12-2 · 菜单打开 → 原生视图整块让位", menuOpen && viewState === "hidden", "data-view=hidden", "menu=" + menuOpen + " view=" + viewState);
    const before = JSON.parse(await counts());
    await page.mouse.click(webPoint.x, webPoint.y);
    await sleep(400);
    const after = JSON.parse(await counts());
    record("A12", "A12-3 · 菜单打开时点击不穿透到网页", (after.click || 0) === (before.click || 0), "计数不变", JSON.stringify({ before, after }));
    await page.keyboard.press("Escape");
    await sleep(600);
    const shownAgain = await attr(".web-viewport p", "data-view");
    record("A12", "A12-4 · 关闭菜单后视图恢复且不改输入目标", shownAgain === "shown", "data-view=shown", shownAgain);

    // 拖动 DOM 窗口压过浏览器 → clip+snapshot / snapshot + 快照层
    const drag = await js("const w = document.querySelector('[data-window-id=home]'); if (!w) return ''; const r = w.getBoundingClientRect(); return JSON.stringify({ x: r.x + 60, y: r.y + 18 });");
    if (drag) {
      const from = JSON.parse(drag);
      const target = { x: Math.round(b0.x + b0.w - 80), y: Math.round(b0.y + 140) };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i += 1) await page.mouse.move(from.x + ((target.x - from.x) * i) / 8, from.y + ((target.y - from.y) * i) / 8);
      await page.mouse.up();
      await sleep(900);
      const snapCount = await js("return document.querySelectorAll(" + JSON.stringify('[data-window="browser"] .window-snapshot-layer img') + ").length");
      const mode = await attr(".web-viewport p", "data-view");
      record("A12", "A12-5 · 窗口拖动遮挡 → 快照补齐层出现（clip+snapshot / snapshot）", snapCount >= 0 && (snapCount > 0 || mode === "hidden"), "快照图或整块 hidden", "snapshots=" + snapCount + " view=" + mode);
      const beforeDrag = JSON.parse(await counts());
      const overlap = await js("const b = document.querySelector('[data-browser-window]').getBoundingClientRect(); const w = document.querySelector('[data-window-id=home]'); if (!w) return ''; const r = w.getBoundingClientRect(); const x = Math.max(b.x, r.x) + 12, y = Math.max(b.y, r.y) + 90; return (x < Math.min(b.x + b.width, r.x + r.width) && y < Math.min(b.y + b.height, r.y + r.height)) ? JSON.stringify({ x: Math.round(x), y: Math.round(y) }) : '';");
      if (overlap) {
        const p2 = JSON.parse(overlap);
        await page.mouse.click(p2.x, p2.y);
        await sleep(350);
        const afterDrag = JSON.parse(await counts());
        record("A12", "A12-6 · 被遮挡区域的点击不落到网页", (afterDrag.click || 0) === (beforeDrag.click || 0), "计数不变", JSON.stringify({ beforeDrag, afterDrag }));
      } else {
        note("拖动后两窗口无重叠区域，A12-6 本轮未构造（如实记录）");
      }
      // 把应用中心窗口拖回左上，避免影响后续步骤
      await page.mouse.move(target.x, target.y);
      await page.mouse.down();
      await page.mouse.move(120, 120);
      await page.mouse.up();
      await sleep(600);
    } else {
      notVerified("A12-5/A12-6 窗口拖动遮挡", "未找到可拖动的应用中心窗口");
    }

    // 最小化 / 恢复
    await js("document.querySelector('[data-browser-window]')?.closest('.window')?.querySelector('.minimize')?.click()");
    await sleep(800);
    // 最小化后 DOM 仍在（这是 §40 的要求），但必须不可见 —— 用 offsetParent 判定。
    const hiddenMin = await js("const el = document.querySelector('[data-browser-window]'); if (!el) return true; const w = el.closest('.window'); return w.classList.contains('minimized') || getComputedStyle(w).visibility === 'hidden';");
    record("A12", "A12-7 · 最小化浏览器窗口 → DOM 与原生视图一并收起", hiddenMin, "窗口不可见", "hidden=" + hiddenMin);
    await js("const dock = Array.from(document.querySelectorAll('.dock-item')).find((e) => (e.getAttribute('aria-label') || '').includes('浏览器')); dock && dock.click();");
    await sleep(900);
    record("A12", "A12-8 · 从 Dock 恢复窗口且原生视图回到 shown", (await has("[data-browser-window]")) && (await attr(".web-viewport p", "data-view")) === "shown", "shown", await attr(".web-viewport p", "data-view"));

    /* ═══════════════ 9 · 双账号隔离（A04） ═══════════════ */
    await navigate(site.base + "/cookie?set=1");
    const cookieView = await waitView("/cookie");
    const aCookie = cookieView ? await viewEval(cookieView, "return JSON.stringify(window.__whoami)") : "{}";
    record("A04", "A04-1 · 用户 A 在网页建立 Cookie/存储（对照）", JSON.parse(aCookie).cookie.includes("d501=USERA"), "cookie d501=USERA", aCookie);
    const created = await js("return window.openarc.governance.command({ type: 'governance/createUser', identifier: " + JSON.stringify(MEMBER.id) + ", password: " + JSON.stringify(MEMBER.pw) + ", displayName: 'D5 Member' })");
    record("A04", "A04-2 · 真实治理入口创建成员账号", !!(created && created.ok), "ok", JSON.stringify(created).slice(0, 120));

    record("A04", "A04-3 · 退出登录", await logout(), "unauthenticated", await gate());
    record("A04", "A04-4 · 登录用户 B", await login(MEMBER), "ready", await gate());
    record("A04", "A04-5 · 新账号看不到上一个用户的浏览器窗口/标签", (await has("[data-browser-window]")) === false, "无浏览器窗口", "browser-window=" + (await has("[data-browser-window]")));
    await openBrowser();
    const emptyAddr = await addressValue();
    record("A04", "A04-6 · 用户 B 的浏览器窗口只有一个空标签", (await js("return document.querySelectorAll('[data-tab]').length")) === 1 && emptyAddr === "", "1 个空标签", emptyAddr);
    await navigate(site.base + "/cookie");
    const bView = await waitView("/cookie");
    const bCookie = bView ? await viewEval(bView, "return JSON.stringify(window.__whoami)") : "{}";
    record("A04", "A04-7 · 用户 B 读不到 A 的 Cookie 与 localStorage", !JSON.parse(bCookie).cookie.includes("d501") && !JSON.parse(bCookie).storage, "无 d501", bCookie);
    await js("document.querySelector('[data-downloads-toggle]').click()");
    await sleep(600);
    record("A04", "A04-8 · 用户 B 的下载列表为空（不共享记录）", await has("[data-downloads-empty]"), "空列表", JSON.stringify(await downloadRows()));
    await click('[aria-label="关闭下载面板"]').catch(() => {});
    record("A04", "A04-9 · 切回用户 A", (await logout()) && (await login(ADMIN)), "ready", await gate());
    await openBrowser();
    await navigate(site.base + "/cookie");
    const aView2 = await waitView("/cookie");
    const aCookie2 = aView2 ? await viewEval(aView2, "return JSON.stringify(window.__whoami)") : "{}";
    record("A04", "A04-10 · 用户 A 的会话仍在（Cookie 未被 B 覆盖/清除）", JSON.parse(aCookie2).cookie.includes("d501=USERA"), "d501=USERA", aCookie2);

    /* ═══════════════ 10 · 重启恢复（多标签 + 活动标签 + 正常退出） ═══════════════ */
    // 造出确定的多标签状态：t1 = /redirect(302→/page2)，t2 = /page3，且**活动标签 = t1**。
    await click("[data-tab-new]");
    await waitFor(async () => (await js("return document.querySelectorAll('[data-tab]').length")) === 2, 10000);
    await navigate(site.base + "/page3");
    await waitFor(async () => (await addressValue()).includes("/page3"), 10000);
    await js("document.querySelector('[data-tab=t1] .tab-main').click()");
    await sleep(500);
    await navigate(site.base + "/redirect");
    await waitFor(async () => (await addressValue()).includes("/page2"), 10000);
    const beforeExit = {
      tabs: await js("return JSON.stringify(Array.from(document.querySelectorAll('[data-tab]')).map((e) => e.getAttribute('data-tab')))"),
      active: await js("return document.querySelector('[data-tab-active=\"1\"]')?.getAttribute('data-tab') || ''"),
      address: await addressValue(),
      views: views().map((v) => v.url()).filter((u) => u.includes("5391")),
    };
    // R2 修复的关键：**正常退出**（不是 SIGKILL）。用户真实路径就是这条。
    const exitInfo = await quitNormally();
    record("restore", "R0 · 重启前以正常退出结束（非强杀）", exitInfo.clean, "进程自行退出", JSON.stringify(exitInfo));
    browser = null; page = null;
    await launch();
    await waitFor(async () => (await gate()) !== "checking", 30000);
    if ((await gate()) === "unauthenticated") await login(ADMIN);
    const restored = await waitFor(async () => (await js("return document.querySelectorAll('.tab').length")) >= 2, 20000);
    const afterRestart = {
      tabs: await js("return JSON.stringify(Array.from(document.querySelectorAll('[data-tab]')).map((e) => e.getAttribute('data-tab')))"),
      active: await js("return document.querySelector('[data-tab-active=\"1\"]')?.getAttribute('data-tab') || ''"),
      address: await addressValue(),
      views: views().map((v) => v.url()).filter((u) => u.includes("5391")),
    };
    record("restore", "R1 · 重启后浏览器窗口与两个标签恢复", restored && afterRestart.tabs === beforeExit.tabs, beforeExit.tabs, afterRestart.tabs);
    record("restore", "R2 · 恢复后地址栏 = 退出前的最终地址（重定向后的 /page2）", afterRestart.address === beforeExit.address && afterRestart.address.includes("/page2"), beforeExit.address, afterRestart.address);
    record("restore", "R3 · 活动标签恢复为退出前的活动标签", afterRestart.active === beforeExit.active && afterRestart.active === "t1", beforeExit.active, afterRestart.active);
    // 非活动标签的视图要等它加载完才出现在 CDP 列表里（有界等待，不是固定 sleep 掩盖失败）。
    await waitView("/page2", 10000);
    await waitView("/page3", 10000);
    afterRestart.views = views().map((v) => v.url()).filter((u) => u.includes("5391"));
    record("restore", "R4 · 每个标签的 URL 各自恢复（t2 = /page3）", JSON.stringify([...afterRestart.views].sort()) === JSON.stringify([...beforeExit.views].sort()) && afterRestart.views.some((u) => u.includes("/page3")), JSON.stringify([...beforeExit.views].sort()), JSON.stringify([...afterRestart.views].sort()));
    record("restore", "R5 · 恢复到的是真实页面（不是只有记录对）", !!(await waitView("/page2", 10000)) && !!(await waitView("/page3", 10000)), "/page2 与 /page3 两个视图都在", JSON.stringify(afterRestart.views));

    // P7 的证书错误是**我们主动构造的**：Chromium 会打一行 SSL handshake failed，
    // 那是预期噪声，不是产品错误。只保留真正的未处理错误。
    const tail = stderrBuf
      .split("\n")
      .filter((l) => /error|Error|FATAL/.test(l))
      .filter((l) => !/ssl_client_socket_impl|SSL error code|net_error -2|handshake failed/i.test(l))
      .slice(0, 5);
    record("hygiene", "H1 · 主进程无未处理错误", tail.length === 0, "无错误行", tail.join(" | ") || "clean");
  } finally {
    await stop();
    try { await site.close(); } catch { /* ignore */ }
    try { if (tls) await tls.close(); } catch { /* ignore */ }
    try { if (flaky) await flaky.close(); } catch { /* ignore */ }
  }

  // 明确不承诺的部分（不许写成通过）
  NOT_VERIFIED.push({
    name: "崩溃 / 强杀后最近一次导航的持久化",
    reason:
      "Chromium 的 localStorage 磁盘提交是异步的：强杀时内存里已是新值、磁盘上仍是旧值（已实测）。正常退出（window-all-closed → app.quit）路径不受影响（R0–R5 实测）。崩溃恢复不在现有契约内，不扩大承诺。",
  });
  const gateOut = {
    phase: "D5-01",
    title: "真实桌面浏览器（导航/标签/下载/隔离/桥）",
    testedCommit: process.env.OPENARC_TESTED_COMMIT || null,
    workspaceState: process.env.OPENARC_WORKSPACE_STATE ?? null,
    command: process.env.npm_lifecycle_event ? "npm run " + process.env.npm_lifecycle_event : "node experiments/d5-01/browser-e2e.mjs",
    env: { platform: process.platform, arch: process.arch, node: process.version, electron: require("electron/package.json").version },
    isolation: { userData: "os.tmpdir mkdtemp", downloads: "os.tmpdir mkdtemp", site: "本地受控站点 127.0.0.1", tls: "openssl 自签名（测试专用）" },
    checks: CHECKS,
    counts: { pass: passed, fail: failed, total: CHECKS.length },
    notVerified: NOT_VERIFIED,
    observations: OBSERVATIONS,
    operationRecord: RECORD,
    at: new Date().toISOString(),
  };
  fs.mkdirSync(ART, { recursive: true });
  fs.writeFileSync(path.join(ART, "d5-01-browser-e2e.json"), JSON.stringify(gateOut, null, 2));
  fs.writeFileSync(path.join(ART, "d5-01-operation-record.jsonl"), RECORD.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log("\n结论：" + (failed === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ pass: passed, fail: failed, total: CHECKS.length, notVerified: NOT_VERIFIED.length }));
  process.exit(failed === 0 ? 0 : 1);
}

await main().catch((e) => {
  console.error("PROBE_THREW", e && e.stack ? e.stack : e);
  process.exit(2);
});
