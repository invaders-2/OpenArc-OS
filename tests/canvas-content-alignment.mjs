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
const { createMarketBundle } = require(path.join(ROOT, "electron/market-service.cjs"));
const { createMarketUpdateBundle } = require(path.join(ROOT, "electron/market-update-service.cjs"));
const { registerMarketIpc } = require(path.join(ROOT, "electron/plugin-bootstrap.cjs"));
const OUT = path.join(ROOT, "artifacts/canvas-tapnow-compare-20261027/apps-templates-skills");
const DEV = process.env.OA_DEV_SERVER || "http://127.0.0.1:5173/";
const uiURL = new URL("vue.html", DEV).href;
const devOrigin = new URL(DEV).origin;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { checks: [], screenshots: [], errors: [], consoleErrors: [], consoleEnvironment: [], notVerified: ["ModelScope 实际联网安装未执行（探针不注入安装器）；TapNow 付费生成未执行", "探针未注册桌面壁纸协议，壁纸 CORS 单独记为环境项"] };
let runtime;
let userData;
let win;
const check = (name, ok, detail = "") => { report.checks.push({ name, ok: !!ok, detail: String(detail) }); console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " :: " + detail : "")); };
const js = (code) => win.webContents.executeJavaScript("(async()=>{" + code + "})()");
const has = (selector) => js("return !!document.querySelector(" + JSON.stringify(selector) + ")");
const click = async (selector) => { const result = await js("const e=document.querySelector(" + JSON.stringify(selector) + ");if(!e)return 'missing';if(e.disabled)return 'disabled';e.click();return 'ok'"); if (result !== "ok") console.log("CLICK " + result + " " + selector); return result; };
const text = (selector) => js("return document.querySelector(" + JSON.stringify(selector) + ")?.textContent||''");
const setInput = (selector, value) => js("const e=document.querySelector(" + JSON.stringify(selector) + ");if(!e)return 'missing';const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e," + JSON.stringify(value) + ");e.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'");
async function waitFor(action, timeout = 30000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await Promise.resolve(action())) return true; await sleep(100); } return false; }
async function shot(name) { await sleep(300); const image = await win.capturePage(); const file = path.join(OUT, name + ".png"); fs.writeFileSync(file, image.toPNG()); report.screenshots.push(path.relative(ROOT, file)); }
async function startRecording() {
  if (process.env.OA_RECORD !== "1") return;
  const capture = require(path.join(ROOT, "electron/canvas-desktop-input.cjs"));
  const sources = await capture.executeCanvasDesktopInput("canvas/capture/sources", {}, null);
  const selected = await capture.executeCanvasDesktopInput("canvas/capture/selectRecording", { sourceId: sources.sources[0].id }, win.webContents);
  if (!selected.ok) throw new Error(selected.error || "无法选择录屏源");
  await js("window.__contentStream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});window.__contentChunks=[];window.__contentRecorder=new MediaRecorder(window.__contentStream,{mimeType:'video/webm'});window.__contentRecorder.ondataavailable=e=>{if(e.data.size)window.__contentChunks.push(e.data)};window.__contentRecorder.start(200)");
}
async function stopRecording() {
  if (process.env.OA_RECORD !== "1" || !win || win.isDestroyed()) return;
  const bytes = await js("window.__contentRecorder.stop();await new Promise(r=>window.__contentRecorder.onstop=r);window.__contentStream.getTracks().forEach(t=>t.stop());return new Uint8Array(await new Blob(window.__contentChunks,{type:'video/webm'}).arrayBuffer())");
  fs.writeFileSync(path.join(OUT, "openarc-content-motion.webm"), Buffer.from(bytes));
  const capture = require(path.join(ROOT, "electron/canvas-desktop-input.cjs"));
  await capture.executeCanvasDesktopInput("canvas/capture/stopRecording", {}, win.webContents);
  report.motion = "artifacts/canvas-tapnow-compare-20261027/apps-templates-skills/openarc-content-motion.webm";
}
async function openApp(id, windowLabel) {
  await js("document.querySelector('[data-dock-id=\"home\"]')?.click()");
  await waitFor(() => has(".apps-pop"), 5000);
  await setInput(".apps-pop .ds-search__input", id === "skills" ? "Skill" : "应用市场");
  await click('.apps-pop [data-app-card="' + id + '"]');
  return waitFor(() => has('.window[aria-label="' + windowLabel + '"]'), 15000);
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-content-alignment-"));
    runtime = await createOpenArcRuntime({ userDataDir: userData, safeStorage, allowAdmin: true });
    const identity = runtime.identity;
    await identity.store.initialize({ identifier: "content-admin@openarc.test", password: "content-password-1", displayName: "Content Admin" });
    const creatorModel = {
      resolveChatTarget: () => ({ model: "creator-test-model", provider: { id: "creator-test-provider", name: "Creator Test" } }),
      call: async ({ messages }) => {
        const compact = JSON.stringify(messages);
        const steps = compact.includes("只保留两个步骤")
          ? [{ title: "检查输入", detail: "检查缺失字段", uses: "analysis" }, { title: "生成周报", detail: "输出结论与下周动作", uses: "writing" }]
          : [{ title: "整理输入", detail: "整理销售数据", uses: "analysis" }, { title: "检查异常", detail: "标记缺失和异常", uses: "analysis" }, { title: "生成周报", detail: "输出周报与下周动作", uses: "writing" }];
        return { ok: true, toolCalls: [{ name: "submit_skill_analysis", arguments: JSON.stringify({ id: "skill_creator_demo", name: "销售周报", description: "把门店销售数据整理成周报", triggers: ["生成本周销售周报"], inputs: ["门店销售数据"], steps, allowedTools: ["analysis", "writing"], output: "销售周报文本", checks: ["不修改原始数据"] }) }] };
      },
    };
    const skills = createSkillBundle({ userDataDir: userData, identityStore: identity.store, authorization: identity.authorization, providerAdapter: creatorModel, modelAdapter: creatorModel });
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
    await setInput('[data-d3-id="login-identifier"]', "content-admin@openarc.test");
    await setInput('[data-d3-id="login-password"]', "content-password-1");
    await click('[data-d3-id="login-submit"]');
    check("独立账号登录真实桌面", await waitFor(() => js("return document.querySelector('.desktop')?.dataset.identityGate==='ready'")));
    await startRecording();

    check("打开应用市场", await openApp("market", "应用市场窗口"));
    await waitFor(() => has("[data-market-apps] .mk-card"));
    await shot("openarc-market");
    check("市场分类切换到真实目录", await click('[data-market-tab="cat:brand-design"]') === "ok" && await waitFor(() => has('[data-market-category="brand-design"] [data-market-entry]')));
    await shot("openarc-market-category");
    await click('[data-market-tab="official"]');
    await waitFor(() => has('[data-market-entry-kind="skill"]'));
    await click('[data-market-skill-open="writing"]');
    await waitFor(() => has('[data-market-detail-kind="skill"]'));
    await shot("openarc-market-skill-detail");
    check("市场 Skill 主按钮进入画布 Agent", await click("[data-market-detail-primary]") === "ok" && await waitFor(() => js("return document.querySelector('#aiInput')?.value==='写作生成'"), 20000));
    await shot("openarc-skill-agent-draft");
    check("试用只填草稿没有自动提交任务", await js("return document.querySelectorAll('[data-task-id]').length===0"));

    await click('[data-drawer="templates"]');
    await waitFor(() => has("[data-tpl-panel]"));
    await shot("openarc-template-public");
    await click('[data-tpl-card] [data-tpl-hit]');
    check("公共模板实际生成节点", await waitFor(() => js("return window.__cn?.state.doc.nodes.length > 0")));
    const originalNodeCount = await js("return window.__cn.state.doc.nodes.length");
    await click('[data-drawer="templates"]');
    await waitFor(() => has("[data-tpl-panel]"));
    await click('[data-tpl-tab="mine"]');
    await shot("openarc-template-mine-empty");
    await click('[data-tpl-create]');
    await waitFor(() => has("[data-tpl-create-dialog]"));
    await shot("openarc-template-create");
    check("个人模板真实保存", await click("[data-tpl-create-save]") === "ok" && await waitFor(() => has('[data-tpl-card][data-tpl-id]')));
    const personalCount = await js("return window.openarc.canvas.command({type:'canvas/assetLibrary/list'}).then(async r=>{const lib=r.libraries.find(x=>x.access==='owner'&&x.visibility==='PRIVATE');const got=await window.openarc.canvas.command({type:'canvas/assetLibrary/get',libraryId:lib.id});return got.items.filter(x=>x.kind==='workflow').length})");
    check("资产库 workflow 已持久化", personalCount === 1, String(personalCount));
    await shot("openarc-template-personal");
    await click('[data-tpl-card] [data-tpl-hit]');
    await sleep(600);
    const reapplied = await js("return {count:window.__cn.state.doc.nodes.length,ids:window.__cn.state.doc.nodes.map(n=>n.id),text:document.body.innerText.slice(-1000)}");
    check("个人模板以新节点再次应用", reapplied.count === originalNodeCount * 2, JSON.stringify(reapplied));
    await shot("openarc-template-reapplied");
    await click('[data-drawer="templates"]');
    await waitFor(() => has("[data-tpl-panel]"));
    await click('[data-tpl-all]');
    await waitFor(() => has("[data-tpl-lib]"));
    await click('[data-tpl-lib-scope="recent"]');
    await shot("openarc-template-recent");
    await click('[data-tpl-lib-scope="mine"]');
    await js("document.querySelector('[data-tpl-lib-grid] [data-tpl-card]').dispatchEvent(new PointerEvent('pointerover',{bubbles:true}))");
    await click('[data-tpl-lib-grid] [data-tpl-act="view"]');
    await waitFor(() => has("[data-tpl-detail]"));
    await js("window.confirm=()=>true");
    await click('[data-tpl-dt-delete]');
    check("删除个人模板并保留原画布", await waitFor(() => js("return !document.querySelector('[data-tpl-lib-grid] [data-tpl-card]')")) && await js("return window.__cn.state.doc.nodes.length===4"));
    await shot("openarc-template-deleted");
    await click('[data-tpl-default-create]');
    check("创建工作流生成 Text → Video 且不入个人库", await waitFor(() => js("return window.__cn.state.doc.nodes.length===6 && window.__cn.state.doc.nodes.slice(-2).map(n=>n.kind).join(',')==='text,video'")));
    await shot("openarc-template-default-workflow");

    await openApp("skills", "Skill 中心窗口");
    await waitFor(() => has("[data-skill-center]"));
    await shot("openarc-skills");
    await click('[data-skill-category="写作"]');
    check("Skill 分类和搜索真实过滤", await waitFor(() => js("return [...document.querySelectorAll('[data-skill-id]')].every(e=>['chat','writing','rewrite'].includes(e.dataset.skillId))")));
    await setInput("[data-skill-search]", "写作生成");
    await shot("openarc-skills-filtered");
    check("搜索结果只保留目标技能", await js("return [...document.querySelectorAll('[data-skill-id]')].map(e=>e.dataset.skillId).join(',')==='writing'"));
    await click('[data-skill-online-open]');
    await shot("openarc-skill-online-source");
    await setInput("[data-skill-online-input]", "not-a-valid-source");
    await click("[data-skill-online-save]");
    check("非法在线来源被真实后端拒绝", await waitFor(() => has("[data-skill-online-error]")));
    await shot("openarc-skill-online-error");
    await click('[data-skill-online-close]');
    await click('[data-skill-tab="mine"]');
    await click('[data-skill-new]');
    await waitFor(() => has(".sk-form"));
    await js("const fields=document.querySelectorAll('.sk-form input');const values=['验收技能','skill_alignment_test','验证本地创建和启停'];fields.forEach((e,i)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,values[i]);e.dispatchEvent(new Event('input',{bubbles:true}))});const area=document.querySelector('.sk-form textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,'只返回验收文本，不调用外部工具');area.dispatchEvent(new Event('input',{bubbles:true}))");
    await shot("openarc-skill-create");
    await click('[data-skill-save]');
    check("Skill 新建持久化", await waitFor(() => has('[data-skill-detail="skill_alignment_test"]')));
    await shot("openarc-skill-created");
    await click('[data-skill-toggle]');
    check("Skill 可停用", await waitFor(() => js("return document.querySelector('[data-skill-toggle]')?.getAttribute('aria-checked')==='false'")));
    await click('[data-skill-toggle]');
    check("Skill 可重新启用", await waitFor(() => js("return document.querySelector('[data-skill-toggle]')?.getAttribute('aria-checked')==='true'")));
    await click('[data-skill-creator-open]');
    await waitFor(() => has("[data-skill-creator]"));
    await shot("openarc-skill-creator-initial");
    await setInput("[data-skill-creator-input]", "把门店销售数据整理成周报，先检查缺失字段，不修改原始数据");
    await click('[data-skill-creator-analyze]');
    check("助手返回真实结构化工作流", await waitFor(() => has("[data-skill-creator-draft]") && js("return document.querySelectorAll('.sk-creator-steps li').length===3")));
    await shot("openarc-skill-creator-preview");
    await click('[data-skill-creator-save]');
    check("助手保存首版 Skill", await waitFor(() => has('[data-skill-detail="skill_creator_demo"]')));
    await shot("openarc-skill-creator-saved");
    await click('[data-skill-iterate]');
    await waitFor(() => has("[data-skill-creator]"));
    await setInput("[data-skill-creator-input]", "只保留两个步骤");
    await click('[data-skill-creator-analyze]');
    check("继续迭代为第二版两步工作流", await waitFor(() => js("return document.querySelectorAll('.sk-creator-steps li').length===2 && document.querySelector('.sk-creator-intro').textContent.includes('第 2 版')")));
    await shot("openarc-skill-creator-iterated");
    await click('[data-skill-creator-save]');
    check("第二版保存成功", await waitFor(() => has('[data-skill-detail="skill_creator_demo"]') && js("return document.querySelectorAll('.sk-steps-ro li').length===2")));
    await shot("openarc-skill-creator-v2");
    const savedVersion = await js("return window.openarc.skill.command({command:'skill/get',payload:{skillId:'skill_creator_demo'}}).then(r=>r.value.skill.v2.version)");
    check("后端版本确实递增为 2", savedVersion === 2, String(savedVersion));
    check("渲染无控制台错误", report.consoleErrors.length === 0, report.consoleErrors.slice(0, 3).join(" | "));
  } catch (error) {
    report.errors.push(String(error?.stack || error));
    check("真实验收探针完成", false, String(error?.message || error));
  } finally {
    try { await stopRecording(); } catch (error) { report.errors.push("录屏停止失败：" + String(error)); }
    fs.writeFileSync(path.join(OUT, "openarc-verification.json"), JSON.stringify(report, null, 2));
    try { win?.destroy(); } catch {}
    try { runtime?.identity?.modelProxy?.stop(); } catch {}
    try { runtime?.identity?.store?.close(); } catch {}
    if (userData) fs.rmSync(userData, { recursive: true, force: true });
    app.quit();
  }
});
