import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createOpenArcRuntime } = require(path.join(ROOT, "electron/runtime-boot.cjs"));
const { registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));
const { registerCanvasIpc } = require(path.join(ROOT, "electron/canvas-bootstrap.cjs"));
const { createSkillBundle } = require(path.join(ROOT, "electron/skill-service.cjs"));
const { registerSkillIpc } = require(path.join(ROOT, "electron/skill-bootstrap.cjs"));
const skillImport = require(path.join(ROOT, "electron/skill-import.cjs"));
const { createMarketBundle } = require(path.join(ROOT, "electron/market-service.cjs"));
const { createMarketUpdateBundle } = require(path.join(ROOT, "electron/market-update-service.cjs"));
const { registerMarketIpc } = require(path.join(ROOT, "electron/plugin-bootstrap.cjs"));
const OUT = path.join(ROOT, "artifacts/canvas-skill-github-agent");
const DEV = process.env.OA_DEV_SERVER || "http://127.0.0.1:5173/";
const uiURL = new URL("vue.html", DEV).href;
const devOrigin = new URL(DEV).origin;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { checks: [], screenshots: [], errors: [], consoleErrors: [], consoleEnvironment: [], githubRequests: [], networkMode: "fixture：真实 Electron / IPC / ZIP / 存储；不冒充 GitHub 在线响应", notVerified: ["GitHub 公网在线下载单独核验，不由 fixture 结果替代", "私有仓库与任意 Git 服务不在本轮范围"] };
let runtime;
let userData;
let win;
const check = (name, ok, detail = "") => { report.checks.push({ name, ok: !!ok, detail: String(detail) }); console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " :: " + detail : "")); };
const js = (code) => win.webContents.executeJavaScript("(async()=>{" + code + "})()");
const has = (selector) => js("return !!document.querySelector(" + JSON.stringify(selector) + ")");
const click = (selector) => js("const e=document.querySelector(" + JSON.stringify(selector) + ");if(!e)return 'missing';if(e.disabled)return 'disabled';e.click();return 'ok'");
const setInput = (selector, value) => js("const e=document.querySelector(" + JSON.stringify(selector) + ");if(!e)return 'missing';const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e," + JSON.stringify(value) + ");e.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'");
async function waitFor(action, timeout = 30000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await Promise.resolve(action())) return true; await sleep(100); } return false; }
async function shot(name) { await sleep(350); const image = await win.capturePage(); const file = path.join(OUT, name + ".png"); fs.writeFileSync(file, image.toPNG()); report.screenshots.push(path.relative(ROOT, file)); }
function archive(withSkill = true) {
  return skillImport.buildZip(withSkill ? [
    { name: "repo-commit/skills/demo/SKILL.md", data: Buffer.from("---\nname: GitHub 验收 Skill\ndescription: 从固定 commit 导入的验收技能\n---\n只读取输入并输出摘要，不执行外部命令") },
    { name: "repo-commit/scripts/setup.py", data: Buffer.from("print('not executed')") },
    { name: "repo-commit/package.json", data: Buffer.from('{"scripts":{"postinstall":"not-executed"}}') },
  ] : [{ name: "repo-commit/README.md", data: Buffer.from("No skill") }]);
}
function githubFetcher() {
  return async (url) => {
    report.githubRequests.push(url);
    const noSkill = url.includes("/bad/repo");
    if (url.endsWith("/repos/good/repo") || url.endsWith("/repos/bad/repo")) return new Response(JSON.stringify({ default_branch: "main" }));
    if (url.includes("/commits/main")) return new Response(JSON.stringify({ sha: COMMIT }));
    if (url.startsWith("https://codeload.github.com/")) return new Response(archive(!noSkill));
    return new Response("not found", { status: 404 });
  };
}
async function openApp(id, windowLabel) {
  await js("document.querySelector('[data-dock-id=\"home\"]')?.click()");
  await waitFor(() => has(".apps-pop"), 5000);
  await setInput(".apps-pop .ds-search__input", id === "skills" ? "Skill" : "应用市场");
  await click('.apps-pop [data-app-card="' + id + '"]');
  return waitFor(() => has('.window[aria-label="' + windowLabel + '"]'), 15000);
}
async function openCanvas() {
  check("打开应用市场", await openApp("market", "应用市场窗口"));
  await waitFor(() => has("[data-market-apps] .mk-card"));
  await click('[data-market-tab="official"]');
  await waitFor(() => has('[data-market-entry-kind="skill"]'));
  await click('[data-market-skill-open="writing"]');
  await waitFor(() => has('[data-market-detail-kind="skill"]'));
  check("进入画布 Agent 但不自动执行", await click("[data-market-detail-primary]") === "ok" && await waitFor(() => js("return document.querySelector('#aiInput')?.value==='写作生成'"), 20000));
}
async function startRecording() {
  if (process.env.OA_RECORD !== "1") return;
  const capture = require(path.join(ROOT, "electron/canvas-desktop-input.cjs"));
  const sources = await capture.executeCanvasDesktopInput("canvas/capture/sources", {}, null);
  const selected = await capture.executeCanvasDesktopInput("canvas/capture/selectRecording", { sourceId: sources.sources[0].id }, win.webContents);
  if (!selected.ok) throw new Error(selected.error || "无法选择录屏源");
  await js("window.__githubStream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});window.__githubChunks=[];window.__githubRecorder=new MediaRecorder(window.__githubStream,{mimeType:'video/webm'});window.__githubRecorder.ondataavailable=e=>{if(e.data.size)window.__githubChunks.push(e.data)};window.__githubRecorder.start(200)");
}
async function stopRecording() {
  if (process.env.OA_RECORD !== "1" || !win || win.isDestroyed()) return;
  const bytes = await js("window.__githubRecorder.stop();await new Promise(r=>window.__githubRecorder.onstop=r);window.__githubStream.getTracks().forEach(t=>t.stop());return new Uint8Array(await new Blob(window.__githubChunks,{type:'video/webm'}).arrayBuffer())");
  fs.writeFileSync(path.join(OUT, "agent-github-motion.webm"), Buffer.from(bytes));
  const capture = require(path.join(ROOT, "electron/canvas-desktop-input.cjs"));
  await capture.executeCanvasDesktopInput("canvas/capture/stopRecording", {}, win.webContents);
  report.motion = "artifacts/canvas-skill-github-agent/agent-github-motion.webm";
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-skill-github-agent-"));
    runtime = await createOpenArcRuntime({ userDataDir: userData, safeStorage, allowAdmin: true });
    const identity = runtime.identity;
    await identity.store.initialize({ identifier: "skill-admin@openarc.test", password: "skill-password-1", displayName: "Skill Admin" });
    const skills = createSkillBundle({ userDataDir: userData, identityStore: identity.store, authorization: identity.authorization, githubFetcher: githubFetcher() });
    const update = createMarketUpdateBundle({ userDataDir: userData, appDir: ROOT, authorization: identity.authorization, fetchImpl: null });
    const market = createMarketBundle({ userDataDir: userData, appDir: ROOT, updateService: update });
    win = new BrowserWindow({ width: 1728, height: 822, useContentSize: true, show: true, webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    win.webContents.on("console-message", (_event, level, message) => { if (level === 3) report[String(message).includes("siri-blob") ? "consoleEnvironment" : "consoleErrors"].push(String(message).slice(0, 500)); });
    const trusted = (event) => event.sender === win.webContents && String(event.senderFrame?.url || "").startsWith(devOrigin + "/");
    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));
    ipcMain.handle("browser:command", async () => ({ ok: false, error: "BROWSER_UNAVAILABLE" }));
    registerIdentityIpc({ ipcMain, service: identity.service, authorization: identity.authorization, isTrusted: trusted });
    registerCanvasIpc({ ipcMain, service: identity.canvasDocService, identity: identity.service, isTrusted: trusted, extension: identity.canvasDxosExtension });
    registerSkillIpc({ ipcMain, bundle: skills, identity: identity.service, isTrusted: trusted });
    registerMarketIpc({ ipcMain, bundle: market, identity: identity.service, isTrusted: trusted });
    await win.loadURL(uiURL);
    await waitFor(() => has('[data-d3-id="login-identifier"]'));
    await setInput('[data-d3-id="login-identifier"]', "skill-admin@openarc.test");
    await setInput('[data-d3-id="login-password"]', "skill-password-1");
    await click('[data-d3-id="login-submit"]');
    check("独立账号登录真实桌面", await waitFor(() => js("return document.querySelector('.desktop')?.dataset.identityGate==='ready'")));
    await startRecording();
    await openCanvas();

    await setInput("#aiInput", "https://github.com/good/repo");
    await click("#aSend");
    check("仓库地址只生成待确认预览", await waitFor(() => has('[data-skill-install="ready"]')));
    check("预览固定 commit 并显示 Skill 与脚本风险", await js("return document.querySelector('[data-skill-install]').textContent.includes('" + COMMIT.slice(0, 12) + "') && document.querySelector('[data-skill-install-docs]').textContent.includes('GitHub 验收 Skill') && document.querySelector('.skill-install-scripts').textContent.includes('2 个脚本')"));
    check("预览阶段没有安装", await js("return window.openarc.skill.command({command:'skill/pack/list',payload:{}}).then(r=>r.value.items.length===0)"));
    await shot("agent-github-preview");

    await click('[data-skill-install-confirm]');
    check("确认后真实导入且默认停用", await waitFor(() => has('[data-skill-install="installed"]')) && await js("return window.openarc.skill.command({command:'skill/list',payload:{}}).then(r=>{const items=r.value.items.filter(s=>s.name==='GitHub 验收 Skill');return items.length===1&&items[0].enabled===false})"));
    await shot("agent-github-installed-disabled");
    await click('[data-skill-install-manage]');
    await waitFor(() => has(".skrow"));
    await shot("agent-github-manage-disabled");
    check("管理页可手动启用", await js("const row=[...document.querySelectorAll('.skrow')].find(e=>e.textContent.includes('GitHub 验收 Skill'));if(!row)return false;row.querySelector('.sw').click();return true") && await waitFor(() => js("return window.openarc.skill.command({command:'skill/list',payload:{}}).then(r=>r.value.items.find(s=>s.name==='GitHub 验收 Skill')?.enabled===true)")));
    await shot("agent-github-enabled");
    await click('.mhd [aria-label="关闭"]');
    await waitFor(() => js("return !document.querySelector('#modal')"));

    await setInput("#aiInput", "npx skills add https://github.com/good/repo");
    await click("#aSend");
    check("npx 文本同样只生成预览不执行命令", await waitFor(() => js("return document.querySelectorAll('[data-skill-install=ready]').length===1")));
    await click('[data-skill-install-cancel]');
    check("取消预览不新增技能包", await js("return window.openarc.skill.command({command:'skill/pack/list',payload:{}}).then(r=>r.value.items.length===1)"));
    await js("document.querySelector('[data-skill-install=cancelled]')?.scrollIntoView({block:'center'})");
    await shot("agent-github-cancelled");

    await setInput("#aiInput", "https://github.com/bad/repo");
    await click("#aSend");
    check("无 SKILL.md 仓库显示真实错误且不安装", await waitFor(() => has('[data-skill-install="error"]')) && await js("return document.querySelector('.skill-install-error').textContent.includes('SKILL.md') && window.openarc.skill.command({command:'skill/pack/list',payload:{}}).then(r=>r.value.items.length===1)"));
    await js("document.querySelector('[data-skill-install=error]')?.scrollIntoView({block:'center'})");
    await shot("agent-github-no-skill-error");
    check("渲染无控制台错误", report.consoleErrors.length === 0, report.consoleErrors.slice(0, 3).join(" | "));
  } catch (error) {
    report.errors.push(String(error?.stack || error));
    check("真实验收探针完成", false, String(error?.message || error));
  } finally {
    try { await stopRecording(); } catch (error) { report.errors.push("录屏停止失败：" + String(error)); }
    fs.writeFileSync(path.join(OUT, "verification.json"), JSON.stringify(report, null, 2));
    try { win?.destroy(); } catch {}
    try { runtime?.identity?.modelProxy?.stop(); } catch {}
    try { runtime?.identity?.store?.close(); } catch {}
    if (userData) fs.rmSync(userData, { recursive: true, force: true });
    app.exit(report.checks.some((item) => !item.ok) || report.errors.length ? 1 : 0);
  }
});
