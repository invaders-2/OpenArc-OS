/**
 * D1-01 桌面与原生视图实机验收（界面侧）。
 *
 * 覆盖：真实 Electron 启动与渲染进程加载、真实 WebContentsView 导航、
 * 界面覆盖网页时不穿透（A12）、不可信网页拿不到系统桥接（A13）、
 * 移除屏幕后重启恢复窗口仍可见（A05）、偏好设置与最小化恢复。
 *
 * 为什么不用 Playwright 的 _electron.launch：
 * 本环境（Electron 44.3.0 + macOS 26.6）该启动器对本项目握手超时，
 * 简单 app 可在 800 ms 内启动，故改为自行拉起应用再用 CDP 连接。
 * 主进程视角的原生视图能力由 tests/native-view.mjs 独立探针覆盖。
 *
 * 本机 Chromium 沙箱无法初始化时传：
 *   ELECTRON_EXTRA_ARGS="--no-sandbox --disable-gpu-sandbox --in-process-gpu"
 * 该情形下渲染进程沙箱的运行时强制属于 NOT VERIFIED。
 */
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "").split(" ").filter(Boolean);

const WEB_PORT = 8731;
const CDP_PORT = Number(process.env.OA_CDP_PORT || 9333);
const PROBE_PAGE = `<!doctype html><html><body><h1>openarc-d1-probe</h1>
<script>window.__probe = "probe-page";</script></body></html>`;

const web = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PROBE_PAGE);
});
await new Promise((r) => web.listen(WEB_PORT, "127.0.0.1", r));

const app = spawn(
  electronPath,
  [".", `--remote-debugging-port=${CDP_PORT}`, ...extraArgs],
  { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] },
);
const appLog = [];
app.stdout.on("data", (d) => appLog.push(String(d)));
app.stderr.on("data", (d) => appLog.push(String(d)));

const getJSON = async (path) => {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}${path}`);
  return res.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const record = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
};

let browser;
try {
  let version = null;
  const cdpDeadline = Date.now() + 40000;
  while (!version && Date.now() < cdpDeadline) {
    try {
      version = await getJSON("/json/version");
    } catch {
      await sleep(300);
    }
  }
  if (!version?.Browser) throw new Error("CDP 未就绪");
  record("Desktop: 真实 Electron 启动并暴露 CDP", true, version.Browser);

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const context = browser.contexts()[0];

  const isUI = (p) => p.url().includes("dist/index.html");
  const findUI = async (ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const p = context.pages().find(isUI);
      if (p) return p;
      await sleep(300);
    }
    return null;
  };
  const page = await findUI();
  assert.ok(
    page,
    "未找到界面页面，现有 target：" + context.pages().map((p) => p.url()).join(" | "),
  );
  await page.waitForSelector(".dock", { timeout: 20000 });
  record("Desktop: 渲染进程加载界面", true, await page.title());

  // ---------- Browser：真实导航 ----------
  await page.getByRole("button", { name: "打开浏览器", exact: true }).click();
  await page.getByLabel("网页地址").fill(`http://127.0.0.1:${WEB_PORT}/`);
  await page.getByRole("button", { name: "打开", exact: true }).click();

  const findView = async (ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const p = context.pages().find(
        (x) => !isUI(x) && x.url().includes(`127.0.0.1:${WEB_PORT}`),
      );
      if (p) return p;
      await sleep(300);
    }
    return null;
  };
  const view = await findView();
  record(
    "Browser: 原生视图完成真实 http 导航",
    !!view,
    view ? view.url() : context.pages().map((p) => p.url()).join(" | "),
  );
  assert.ok(view, "原生视图 target 未出现，无法继续 A13 断言");
  record(
    "Browser: 网页脚本在原生视图中真实执行",
    (await view.evaluate(() => window.__probe)) === "probe-page",
  );

  // ---------- A13：不可信网页拿不到系统能力 ----------
  const globals = await view.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
    module: typeof window.module,
    ipc: typeof window.ipcRenderer,
    openarc: typeof window.openarc,
  }));
  record(
    "A13: 不可信网页拿不到 Node / IPC / 系统桥接",
    Object.values(globals).every((v) => v === "undefined"),
    JSON.stringify(globals),
  );
  record(
    "A13: 网页侧 window.open 被拒绝",
    (await view.evaluate(
      () => (window.open("https://example.com") === null ? "denied" : "opened"),
    )) === "denied",
  );
  record(
    "A13: 网页读取本地文件被拒绝",
    (await view.evaluate(() =>
      fetch("file:///etc/passwd").then(() => "allowed").catch(() => "blocked"),
    )) === "blocked",
  );
  const rejected = await page.evaluate(() =>
    window.openarc.navigate("file:///etc/passwd"),
  );
  record("A13: 界面侧导航非 http(s) 被拒绝", !!rejected.error, JSON.stringify(rejected));
  record(
    "A13: 视图与界面不在同一 target（非 iframe）",
    view !== page && !isUI(view),
    `view=${view.url().slice(0, 40)} ui=${isUI(page)}`,
  );

  // ---------- A12：界面覆盖网页时不穿透 ----------
  const viewState = () => page.locator(".web-viewport p").getAttribute("data-view");
  await page.getByRole("button", { name: "全局 AI", exact: true }).click();
  record("A12: AI 面板打开时停止显示原生视图", (await viewState()) === "hidden");
  await page.getByRole("button", { name: "关闭AI面板" }).click();
  record("A12: AI 面板关闭后恢复显示", (await viewState()) === "shown");

  await page.getByRole("button", { name: "全局搜索", exact: true }).click();
  record("A12: 搜索面板打开时停止显示原生视图", (await viewState()) === "hidden");
  await page.keyboard.press("Escape");
  record("A12: 搜索关闭后恢复显示", (await viewState()) === "shown");

  await page.mouse.click(1180, 620, { button: "right" });
  const menuOpen = (await page.locator(".context-menu").count()) === 1;
  record(
    "A12: 右键菜单打开时停止显示原生视图（修复前会穿透）",
    menuOpen && (await viewState()) === "hidden",
    `menu=${menuOpen} state=${await viewState()}`,
  );
  await page.mouse.click(1180, 300);
  record(
    "A12: 菜单关闭后恢复显示",
    (await page.locator(".context-menu").count()) === 0 &&
      (await viewState()) === "shown",
  );

  // ---------- Desktop：最小化 / 恢复 ----------
  await page.getByRole("button", { name: "最小化browser", exact: true }).click();
  record("Desktop: 最小化后停止显示原生视图", (await viewState()) === "hidden");
  await page.getByRole("button", { name: "打开浏览器", exact: true }).click();
  record("Desktop: 恢复后重新显示", (await viewState()) === "shown");

  // ---------- 偏好设置 ----------
  await page.getByRole("button", { name: "打开系统设置", exact: true }).click();
  await page.getByLabel("减少动态效果", { exact: true }).check();
  await page.getByLabel("减少透明度", { exact: true }).check();
  record(
    "Preferences: 减少动态效果与减少透明度可独立生效",
    (await page.locator(".desktop.reduced.opaque").count()) === 1,
  );

  // ---------- A05：模拟"移除屏幕后重启" ----------
  await page.evaluate(() =>
    localStorage.setItem(
      "oa-wins",
      JSON.stringify([
        // 停在已被拔掉的右侧屏幕上的窗口
        { id: "home", x: 5200, y: 400, w: 900, h: 600, min: false, max: false },
        { id: "settings", x: 120, y: 140, w: 700, h: 500, min: false, max: false },
      ]),
    ),
  );
  await page.reload();
  await page.waitForSelector(".window");
  await sleep(600);
  const restored = await page.evaluate(() => {
    const vw = innerWidth,
      vh = innerHeight;
    return [...document.querySelectorAll(".window:not(.minimized)")].map((e) => {
      const r = e.getBoundingClientRect();
      return {
        left: Math.round(r.left),
        top: Math.round(r.top),
        right: Math.round(r.right),
        bottom: Math.round(r.bottom),
        inside: r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh,
      };
    });
  });
  record(
    "A05: 拔屏后重启，恢复的窗口全部位于可见区",
    restored.length === 2 && restored.every((r) => r.inside),
    JSON.stringify(restored),
  );

  await fs.mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/d1-desktop.png" });

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    console.log("FAILED: " + failed.map((f) => f.name).join(" | "));
    process.exitCode = 1;
  }
} catch (error) {
  console.log("ERROR " + String((error && error.stack) || error));
  if (appLog.length) console.log("app log:\n" + appLog.join("\n").slice(0, 2000));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  app.kill("SIGKILL");
  web.close();
}
