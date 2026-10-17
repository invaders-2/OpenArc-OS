/**
 * task-55 实机探针：打包后的 .app（无仓库 node_modules，只有 app/node_modules DSH 闭包）
 * 真实启动 → 初始化管理员 → 配置回环假 Provider → task/run → 等终态。
 *
 * 用法：OPENARC_PACKAGED_APP="/tmp/OpenArc OS task55.app" node tests/packaged-task-run.mjs
 * 不进入 npm test（依赖已构建 .app，属于打包门禁）。
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startD4Provider } from "./fixtures/d4-04-provider.mjs";

const APP = process.env.OPENARC_PACKAGED_APP || "/Users/wepingli/Desktop/OpenArc OS.app";
const PORT = Number(process.env.OPENARC_PACKAGED_CDP || 9491);
const ADMIN = "packaged-admin@openarc.test";
const PW = "packaged-password-1";
const executable = (() => {
  const macos = path.join(APP, "Contents", "MacOS");
  if (!fs.existsSync(macos)) throw new Error("找不到打包 app: " + APP);
  const candidates = fs.readdirSync(macos).filter((name) => !name.endsWith(" Helper") && fs.statSync(path.join(macos, name)).isFile());
  const electron = candidates.find((name) => name === "Electron") || candidates[0];
  if (!electron) throw new Error("找不到 app 可执行文件");
  return path.join(macos, electron);
})();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-task55-packaged-"));
const childEnv = { ...process.env }; delete childEnv.ELECTRON_RUN_AS_NODE;
// task-66：模拟 Finder 启动的最小 PATH（没有 node/npm/homebrew）；harness 必须仍能跑 DSH。
if (process.env.OPENARC_PACKAGED_MINIMAL_PATH === "1") childEnv.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const app = spawn(executable, ["--remote-debugging-port=" + PORT, "--user-data-dir=" + userData, "--no-sandbox", "--disable-gpu-sandbox", "--in-process-gpu"], { stdio: ["ignore", "pipe", "pipe"], env: childEnv });
const log = [];
app.stdout.on("data", (d) => log.push(String(d)));
app.stderr.on("data", (d) => log.push(String(d)));

const provider = await startD4Provider();
provider.state.mode = "final";
let browser = null;
let failed = null;
try {
  let version = null;
  const deadline = Date.now() + 45000;
  while (!version && Date.now() < deadline) {
    try { version = await (await fetch("http://127.0.0.1:" + PORT + "/json/version")).json(); } catch { await sleep(300); }
  }
  if (!version) throw new Error("打包 app CDP 未就绪");
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + PORT);
  const page = await (async () => {
    for (let i = 0; i < 100; i += 1) {
      const found = browser.contexts().flatMap((ctx) => ctx.pages()).find((p) => p.url().includes("/dist/") && p.url().endsWith(".html"));
      if (found) return found;
      await sleep(200);
    }
    throw new Error("找不到产品 UI 页: " + JSON.stringify(browser.contexts().flatMap((ctx) => ctx.pages().map((p) => p.url()))));
  })();
  await page.waitForFunction(() => !!(window.openarc && window.openarc.identity && window.openarc.model && window.openarc.task), null, { timeout: 30000 });
  const identity = await page.evaluate(async ({ ADMIN, PW }) => {
    const init = await window.openarc.identity.command({ type: "identity/initialize", identifier: ADMIN, password: PW, displayName: "Packaged Admin" });
    if (!init.ok && init.error !== "ALREADY_INITIALIZED") return { init };
    const login = await window.openarc.identity.command({ type: "identity/login", identifier: ADMIN, password: PW });
    return { init, login };
  }, { ADMIN, PW });
  if (!identity.login || identity.login.ok !== true) throw new Error("登录失败: " + JSON.stringify(identity));
  await sleep(1200);

  const model = await page.evaluate(async ({ baseUrl }) => {
    const call = (command, payload = {}) => window.openarc.model.command({ type: command, ...payload });
    const provider = await call("provider/create", { displayName: "Packaged Loopback", baseUrl, allowLan: true, allowInsecureHttp: true });
    if (!provider.ok) return { stage: "provider", provider };
    const providerId = provider.provider.providerId;
    const cred = await call("credential/set", { providerId, secret: "sk-packaged-loopback" });
    if (!cred.ok) return { stage: "credential", cred, providerId };
    const created = await call("model/create", { providerId, remoteModelId: "fake-chat", displayName: "Packaged Fake", capabilities: ["chat"] });
    if (!created.ok) return { stage: "model", created, providerId };
    const configId = created.model.configId;
    const defaults = await call("defaults/set", { capability: "chat", configId, scope: "PERSONAL" });
    return { stage: "ok", providerId, configId, defaults };
  }, { baseUrl: provider.baseUrl });
  if (model.stage !== "ok") throw new Error("模型接入失败: " + JSON.stringify(model));

  const run = await page.evaluate(async () => {
    const events = [];
    const off = window.openarc.task.onEvent((event) => events.push(event));
    const started = await window.openarc.task.command({ type: "task/run", goal: "packaged dsh runtime smoke" });
    window.__packagedTaskEvents = events;
    window.__packagedTaskOff = off;
    return started;
  });
  if (!run.ok) throw new Error("task/run 未受理: " + JSON.stringify(run));
  let state = null;
  const taskDeadline = Date.now() + 90000;
  while (Date.now() < taskDeadline) {
    state = await page.evaluate(async (taskId) => window.openarc.task.command({ type: "task/get", taskId }), run.taskId);
    if (state && state.ok && state.task && ["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"].includes(state.task.status)) break;
    await sleep(500);
  }
  const events = await page.evaluate(() => window.__packagedTaskEvents || []);
  const payload = { run, task: state && state.task, error: state && state.error, events: (state && state.events) || [], pushedEvents: events };
  if (!state || !state.ok || !state.task) throw new Error("task/get 失败: " + JSON.stringify(payload));
  if (state.task.status !== "SUCCEEDED") throw new Error("task/run 未成功: " + JSON.stringify(payload).slice(0, 3000));
  const modelEvents = payload.events.filter((e) => String(e.eventType || "").startsWith("model."));
  if (!modelEvents.length) throw new Error("事件流缺模型事件: " + JSON.stringify(payload).slice(0, 2000));
  if (JSON.stringify(payload).includes("sk-packaged-loopback")) throw new Error("事件/结果泄漏密钥");
  const dshPackage = path.join(APP, "Contents", "Resources", "app", "node_modules", "@deepseek-ai", "dsh", "package.json");
  const dshPkg = JSON.parse(fs.readFileSync(dshPackage, "utf8"));
  console.log(JSON.stringify({
    ok: true,
    executable,
    appNodeModules: fs.existsSync(path.dirname(path.dirname(path.dirname(dshPackage)))), 
    dsh: dshPkg.version,
    providerRequests: provider.state.requests,
    taskStatus: state.task.status,
    taskId: state.task.taskId,
    eventTypes: [...new Set(payload.events.map((e) => e.eventType))].slice(0, 20),
    pushedTypes: [...new Set(events.map((e) => e.type))],
  }, null, 2));
} catch (error) {
  failed = error;
  console.error("PACKAGED TASK/RUN FAILED: " + ((error && error.message) || error));
  console.error("app log tail:\n" + log.join("").slice(-4000));
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  await provider.close();
  try { app.kill("SIGTERM"); } catch { /* ignore */ }
  await sleep(500);
  fs.rmSync(userData, { recursive: true, force: true });
}
if (failed) process.exit(process.exitCode || 1);
