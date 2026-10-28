const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "../../..");
const { createOpenArcRuntime } = require(path.join(ROOT, "electron/runtime-boot.cjs"));
const { createDefaultExecutorLauncher } = require(path.join(ROOT, "electron/executor-launcher.cjs"));
const { registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));
const { registerCanvasIpc } = require(path.join(ROOT, "electron/canvas-bootstrap.cjs"));
const { registerTaskIpc } = require(path.join(ROOT, "electron/task-bootstrap.cjs"));
const { createSkillBundle } = require(path.join(ROOT, "electron/skill-service.cjs"));
const { registerSkillIpc } = require(path.join(ROOT, "electron/skill-bootstrap.cjs"));
const uiURL = pathToFileURL(path.join(ROOT, "dist/index.html")).href;
const PROVIDER_URL = process.env.OPENARC_D4_PROVIDER_URL || "";
const CONTROL_URL = PROVIDER_URL.replace(/\/v1\/?$/, "") + "/__plan";
const BODIES_URL = PROVIDER_URL.replace(/\/v1\/?$/, "") + "/__bodies";
const RESTART = process.env.OPENARC_AGENT_RESTART === "1";
const PERSIST = !!process.env.OPENARC_AGENT_USER_DATA;
const report = { checks: [], errors: [], screenshots: [] };
let win; let runtime; let userData;
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail = "") => { report.checks.push({ name, ok: !!ok, detail: String(detail) }); out((ok ? "PASS " : "FAIL ") + name + (detail ? " :: " + detail : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const click = (sel) => js("const el=document.querySelector(" + JSON.stringify(sel) + ");if(!el)return 'missing';if(el.disabled)return 'disabled';el.click();return 'ok'");
const setInput = (sel, value) => js("const el=document.querySelector(" + JSON.stringify(sel) + ");if(!el)return 'missing';const p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(el," + JSON.stringify(value) + ");el.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'");
const text = (sel) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.textContent || ''");
const attr = (sel, name) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.getAttribute(" + JSON.stringify(name) + ") || ''");
async function waitFor(fn, timeout = 30000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await Promise.resolve(fn())) return true; await sleep(80); } return false; }
const ctx = () => ({ sessionRef: runtime.identity.service.current, appId: "ai", source: "probe" });
const taskByGoal = (goal) => runtime.identity.taskStore.allTasks().find((t) => t.goal === goal && t.app_id === "ai");
const doc = (canvasId) => runtime.identity.canvasDocService.getCanvas({ context: ctx(), canvasId }).canvas;
async function plan(steps, sequential = false) { const body = steps.length ? { plan: steps, sequential } : { mode: "final" }; const res = await fetch(CONTROL_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!res.ok) throw new Error("plan failed"); }
async function submit(goal) { if (!(await waitFor(async () => (await has("#aSend")) && !(await attr("#aSend", "class")).includes("busy")))) throw new Error("Agent send not ready"); await setInput("#aiInput", goal); await click("#aSend"); const ok = await waitFor(() => !!taskByGoal(goal)); if (!ok) throw new Error("task not created: " + goal); return taskByGoal(goal).task_id; }
async function waitCall(taskId, index = 0) { const ok = await waitFor(() => runtime.identity.sideEffectStore.callsOfTask(taskId).length > index, 60000); if (!ok) throw new Error("side effect call missing"); return runtime.identity.sideEffectStore.callsOfTask(taskId)[index]; }
async function approve(call) {
  const ok = await waitFor(async () => (await attr(`[data-approval-request-id="${call.callId}"]`, "data-approval-request-id")) === call.callId);
  if (!ok) {
    const pending = await js("return window.openarc.sideEffect.command({type:'sideEffect/listPending'})");
    const visible = await js("return Array.from(document.querySelectorAll('[data-approval-request-id]')).map((e) => e.getAttribute('data-approval-request-id'))");
    const calls = runtime.identity.taskStore.allTasks().map((t) => ({ goal: t.goal, status: t.status, calls: runtime.identity.sideEffectStore.callsOfTask(t.task_id).map((c) => ({ id: c.callId, status: c.status })) }));
    throw new Error("approval missing: " + call.callId + " visible=" + JSON.stringify(visible) + " pending=" + JSON.stringify(pending) + " calls=" + JSON.stringify(calls));
  }
  await click(`[data-approval-request-id="${call.callId}"] [data-approval-action="approve"], [data-approval-action="approve"]`);
}
async function waitStatus(taskId, status) { const ok = await waitFor(() => runtime.identity.taskStore.taskById(taskId)?.status === status, 60000); if (!ok) throw new Error("status timeout: " + taskId + " wanted " + status + " actual " + runtime.identity.taskStore.taskById(taskId)?.status); }
async function screenshot(name) { const file = path.join(ROOT, "artifacts/canvas-agent-gate", name); fs.mkdirSync(path.dirname(file), { recursive: true }); const image = await win.webContents.capturePage(); fs.writeFileSync(file, image.toPNG()); report.screenshots.push(file); }
async function login(identifier, password) {
  await waitFor(async () => (await has('[data-d3-id="login-identifier"]')) || (await js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate')")) === "ready");
  if ((await js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate')")) === "ready") return;
  if (!(await has('[data-d3-id="login-identifier"]'))) throw new Error("login form missing");
  await setInput('[data-d3-id="login-identifier"]', identifier);
  await setInput('[data-d3-id="login-password"]', password);
  await click('[data-d3-id="login-submit"]');
  if (!(await waitFor(async () => (await js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate')")) === "ready"))) throw new Error("login failed: " + identifier);
}
async function logout() {
  const result = await js("return window.openarc.identity.command({type:'identity/logout'})");
  if (!result.ok) throw new Error("logout failed: " + JSON.stringify(result));
  if (!(await waitFor(() => has('[data-d3-id="login-identifier"]')))) throw new Error("logout form missing");
}
async function accountSnapshot() {
  return js("return Promise.all([window.openarc.resource.command({type:'resource/query',filter:{resourceType:'memory'},limit:100}),window.openarc.skill.command({command:'skill/list',payload:{}}),window.openarc.task.command({command:'task/list',payload:{}})]).then(([memories,skills,tasks])=>({memories,skills,tasks}))");
}
async function openMemory() {
  await sleep(600);
  await click("#aMore");
  const clicked = await js("const el=Array.from(document.querySelectorAll('#pop .mi')).find((e)=>e.textContent.startsWith('记忆'));if(!el)return false;el.click();return true");
  if (!clicked || !(await waitFor(async () => (await has("#modal #memIn")) && !(await has("#pop"))))) throw new Error("memory modal missing");
  await sleep(350);
}
async function reducedMotion() {
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  if (!(await js("return matchMedia('(prefers-reduced-motion: reduce)').matches"))) throw new Error("reduced motion not active");
}

app.whenReady().then(async () => {
  try {
    userData = process.env.OPENARC_AGENT_USER_DATA || fs.mkdtempSync(path.join(os.tmpdir(), "oa-canvas-agent-electron-"));
    runtime = await createOpenArcRuntime({ userDataDir: userData, safeStorage, allowAdmin: true, executorLauncher: createDefaultExecutorLauncher() });
    const identity = runtime.identity;
    if (!RESTART) {
      await identity.store.initialize({ identifier: "admin@openarc.test", password: "admin-password-1", displayName: "Admin" });
      const adminUser = identity.store.allUsers().find((u) => u.role === "ADMIN");
      const second = await identity.store.createUser({ identifier: "second@openarc.test", password: "second-password-1", displayName: "Second", teamId: adminUser.team_id });
      if (!second.ok) throw new Error("second user: " + JSON.stringify(second));
    }
    for (const appId of ["ai", "settings", "resource-library"]) if (!identity.authStore.appById(appId)) identity.authStore.upsertApp({ appId, name: appId, publisher: "probe", status: "enabled", builtIn: 1 });
    const admin = identity.store.allUsers().find((u) => u.role === "ADMIN");
    identity.authStore.upsertAppGrant({ appId: "ai", resourceType: "model", actions: ["model.view", "model.use", "model.test"], grantedBy: "probe", organizationId: admin.team_id });
    identity.authStore.upsertAppGrant({ appId: "settings", resourceType: "model", actions: ["model.view", "model.use", "model.test", "model.manage"], grantedBy: "probe", organizationId: admin.team_id });
    win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    const trusted = (e) => e.sender === win.webContents && e.senderFrame?.url === uiURL;
    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));
    ipcMain.handle("browser:command", async (_event, command) => command && command.type === "browser/downloads" && command.action === "list" ? { ok: true, items: [] } : { ok: false, error: "BROWSER_UNAVAILABLE" });
    ipcMain.handle("files:list", async () => ({ ok: true, entries: [] }));
    ipcMain.handle("files:trashList", async () => ({ ok: true, entries: [] }));
    registerIdentityIpc({ ipcMain, service: identity.service, authorization: identity.authorization, device: identity.deviceService, resource: identity.resourceService, resourceSearch: identity.searchService, governance: identity.governanceService, model: identity.modelService, sideEffect: identity.sideEffectGateway, BrowserWindow, isTrusted: trusted, send: (event) => { if (win && !win.isDestroyed()) win.webContents.send("identity:event", event); }, sendSideEffect: (event) => { if (win && !win.isDestroyed()) win.webContents.send("sideeffect:event", event); } });
    registerCanvasIpc({ ipcMain, service: identity.canvasDocService, identity: identity.service, isTrusted: trusted });
    registerTaskIpc({ ipcMain, taskService: identity.taskService, orchestrator: identity.orchestrator, identity: identity.service, canvasService: identity.canvasDocService, isTrusted: trusted, send: (event) => { if (win && !win.isDestroyed()) win.webContents.send("task:event", event); } });
    const skillBundle = createSkillBundle({ userDataDir: userData, identityStore: identity.store, authorization: identity.authorization });
    registerSkillIpc({ ipcMain, bundle: skillBundle, identity: identity.service, isTrusted: trusted });
    await win.loadURL(uiURL);
    await login("admin@openarc.test", "admin-password-1");
    if (!RESTART) {
      const settings = { sessionRef: identity.service.current, appId: "settings", source: "probe" };
      const provider = identity.modelService.createProvider({ context: settings, displayName: "Canvas Agent Provider", baseUrl: PROVIDER_URL, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: "canvas-agent-credential" });
      if (!provider.ok) throw new Error(JSON.stringify(provider));
      const model = identity.modelService.createModel({ context: settings, providerId: provider.provider.providerId, remoteModelId: "d4-04-local", displayName: "D4 Local", capabilities: ["chat"], scope: "ORGANIZATION" });
      if (!model.ok) throw new Error(JSON.stringify(model));
      const def = identity.modelService.setDefault({ context: settings, capability: "chat", configId: model.model.configId, scope: "ORGANIZATION" });
      if (!def.ok) throw new Error(JSON.stringify(def));
      const grant = identity.authorization.grantAppToolPermission({ context: ctx(), appId: "ai", actions: ["tool.canvas.read", "tool.canvas.edit"] });
      if (!grant.ok) throw new Error(JSON.stringify(grant));
      const created = identity.canvasDocService.createCanvas({ context: ctx(), title: "Canvas Agent Gate" });
      if (!created.ok) throw new Error(JSON.stringify(created));
      var canvasId = created.canvas.canvasId;
    } else {
      const canvases = identity.canvasDocService.listCanvases({ context: ctx() });
      const existing = canvases.items.find((canvas) => canvas.title === "Canvas Agent Gate");
      if (!existing) throw new Error("persisted canvas missing: " + JSON.stringify(canvases));
      canvasId = existing.canvasId;
    }
    await click('[aria-label="打开AI Studio"], [aria-label="打开无限画布"]');
    if (!(await waitFor(() => has(`[data-canvas="${canvasId}"]`)))) throw new Error("canvas card missing");
    await click(`[data-canvas="${canvasId}"]`);
    if (!(await waitFor(() => has("#aiInput")))) throw new Error("Agent input missing");
    if (await has("#agent.closed")) await click("[data-orb]");
    if (!RESTART) {
    check("默认模型只读展示后端配置", (await text("#aModel")).includes("D4 Local"), await text("#aModel"));
    check("Agent 不展示未生效 effort 选择", !(await text("#aiBox")).includes("思考强度"), await text("#aiBox"));

    const goal1 = "添加一个经批准的 Agent 节点";
    await plan([{ name: "canvas_read", args: { canvasId } }, { name: "canvas_edit", args: { canvasId, command: { type: "node.add", node: { id: "agent_node", type: "prompt", text: "approved agent node" } } } }]);
    const task1 = await submit(goal1);
    const call1 = await waitCall(task1);
    check("提案 0 mutation / 等待可信批准", doc(canvasId).revision === 1 && doc(canvasId).doc.nodes.length === 0 && call1.status === "AWAITING_APPROVAL", JSON.stringify({ revision: doc(canvasId).revision, call: call1.status }));
    await approve(call1);
    await waitStatus(task1, "SUCCEEDED");
    check("批准后官方 Harness→CanvasControl→权威读回成功", doc(canvasId).revision === 2 && doc(canvasId).doc.nodes.some((n) => n.id === "agent_node"), JSON.stringify({ revision: doc(canvasId).revision, nodes: doc(canvasId).doc.nodes.map((n) => n.id) }));
    check("画布任务冻结模型来自后端", (await text("#aModel")).includes("D4 Local"), await text("#aModel"));
    await reducedMotion();
    await waitFor(async () => (await js("return document.body.innerText")).includes("approved agent node"), 10000);
    await screenshot("01-approved-reduced-motion.png");

    const goal2 = "旧 revision 不得覆盖用户编辑";
    await plan([{ name: "canvas_edit", args: { canvasId, command: { type: "node.add", node: { id: "stale_agent_node", type: "prompt", text: "must not land" } } } }]);
    const task2 = await submit(goal2);
    const call2 = await waitCall(task2);
    const userEdit = identity.canvasDocService.applyCommand({ context: ctx(), canvasId, baseRevision: 2, command: { type: "node.add", node: { id: "user_node", type: "prompt", text: "user edit preserved" } }, actorKind: "USER" });
    if (!userEdit.ok) throw new Error(JSON.stringify(userEdit));
    await approve(call2);
    await waitStatus(task2, "BLOCKED");
    await waitFor(async () => (await attr(`[data-task-id="${task2}"]`, "data-task-status")) === "BLOCKED");
    check("baseRevision 冲突保留用户编辑且 UI 收敛", doc(canvasId).revision === 3 && doc(canvasId).doc.nodes.some((n) => n.id === "user_node") && !doc(canvasId).doc.nodes.some((n) => n.id === "stale_agent_node") && (await attr(`[data-task-id="${task2}"]`, "data-task-status")) === "BLOCKED", JSON.stringify({ revision: doc(canvasId).revision, status: runtime.identity.taskStore.taskById(task2).status, uiStatus: await attr(`[data-task-id="${task2}"]`, "data-task-status"), nodes: doc(canvasId).doc.nodes.map((n) => n.id) }));
    check("BLOCKED 后 Agent 可继续输入", await js("return !document.querySelector('#aSend').classList.contains('busy')"), await attr("#aSend", "class"));
    await screenshot("02-conflict-reduced-motion.png");

    const goal3 = "第一步完成后停止后续步骤";
    await sleep(2500);
    await plan([{ name: "canvas_edit", args: { canvasId, command: { type: "node.add", node: { id: "first_agent_node", type: "prompt", text: "first retained" } } } }, { name: "canvas_edit", args: { canvasId, command: { type: "node.add", node: { id: "second_agent_node", type: "prompt", text: "must stop" } } } }], true);
    const task3 = await submit(goal3);
    const first = await waitCall(task3, 0);
    await approve(first);
    if (!(await waitFor(() => runtime.identity.sideEffectStore.callById(first.callId)?.status === "SUCCEEDED", 60000))) throw new Error("first canvas edit did not complete");
    const second = await waitCall(task3, 1);
    check("停止前第一步已执行且第二步等待审批", runtime.identity.sideEffectStore.callById(first.callId).status === "SUCCEEDED" && second.status === "AWAITING_APPROVAL" && doc(canvasId).doc.nodes.some((n) => n.id === "first_agent_node"), JSON.stringify({ first: runtime.identity.sideEffectStore.callById(first.callId).status, second: second.status }));
    await click("#aSend.busy");
    await waitStatus(task3, "CANCELLED");
    await waitFor(() => runtime.identity.sideEffectStore.callById(second.callId)?.status !== "AWAITING_APPROVAL");
    await waitFor(async () => !(await has(".approval")));
    check("停止后续步骤且保留已完成副作用", doc(canvasId).revision === 4 && doc(canvasId).doc.nodes.some((n) => n.id === "first_agent_node") && !doc(canvasId).doc.nodes.some((n) => n.id === "second_agent_node"), JSON.stringify({ revision: doc(canvasId).revision, nodes: doc(canvasId).doc.nodes.map((n) => n.id) }));
    check("停止后审批卡关闭且第二步不可再批准", !(await has(".approval")) && runtime.identity.sideEffectStore.callById(second.callId).status !== "AWAITING_APPROVAL", runtime.identity.sideEffectStore.callById(second.callId).status);
    await screenshot("03-stopped-reduced-motion.png");

    const memoryToken = "ACCOUNT_A_MEMORY_2A_91f7";
    await reducedMotion();
    await openMemory();
    await setInput("#memIn", memoryToken + " account isolation memory probe preference");
    await click("#memAdd");
    const memoryVisible = await waitFor(async () => (await text(".memlist")).includes(memoryToken));
    check("A 通过记忆弹层写入后端 Resource", memoryVisible, await text(".memlist"));
    await screenshot("04-account-a-memory-reduced-motion.png");
    await click('#modal [aria-label="关闭"]');
    await waitFor(async () => !(await has("#modal")));
    const savedSkill = await js("return window.openarc.skill.command({command:'skill/save',payload:{skill:{id:'account_a_skill_2a',name:'Account A Skill',description:'Account only',systemPrompt:'Account A only'}}})");
    check("A 自定义 Skill 写入真实 SkillService", savedSkill.ok === true, JSON.stringify(savedSkill));

    const memoryGrant = identity.authorization.grantAppResourcePermission({ context: ctx(), appId: "ai", resourceType: "memory", actions: ["resource.search", "resource.read"] });
    if (!memoryGrant.ok) throw new Error("memory grant: " + JSON.stringify(memoryGrant));
    const memoryGoal = "account isolation memory probe";
    await plan([]);
    const memoryTask = await submit(memoryGoal);
    await waitStatus(memoryTask, "SUCCEEDED");
    const beforeBodies = JSON.stringify((await (await fetch(BODIES_URL)).json()).bodies);
    check("撤权前 MemoryContext 注入 A 记忆", beforeBodies.includes(memoryToken) && !memoryGoal.includes(memoryToken));
    const revoked = identity.authorization.revokeAppResourcePermission({ context: ctx(), grantId: memoryGrant.grant.id });
    if (!revoked.ok) throw new Error("memory revoke: " + JSON.stringify(revoked));
    await plan([]);
    const revokedTask = await submit("account isolation memory probe after revoke");
    await waitStatus(revokedTask, "SUCCEEDED");
    const afterBodies = JSON.stringify((await (await fetch(BODIES_URL)).json()).bodies);
    check("撤权后真实 provider 请求不再含 A 记忆", !afterBodies.includes(memoryToken));

    await logout();
    await login("second@openarc.test", "second-password-1");
    const secondSnapshot = await accountSnapshot();
    const secondSerialized = JSON.stringify(secondSnapshot);
    check("B 登录不可见 A 的记忆、Skill 与画布 Task", !secondSerialized.includes(memoryToken) && !secondSerialized.includes("account_a_skill_2a") && !secondSerialized.includes(memoryGoal), secondSerialized.slice(0, 600));
    const secondMemory = await js("return window.openarc.resource.command({type:'resource/create',resourceType:'memory',name:'B memory',content:'ACCOUNT_B_MEMORY_2A',memorySubtype:'personal-preference',attributes:{scope:'user',canvasId:null}})");
    const secondSkill = await js("return window.openarc.skill.command({command:'skill/save',payload:{skill:{id:'account_b_skill_2a',name:'Account B Skill',description:'B only',systemPrompt:'B only'}}})");
    check("B 可创建自己的记忆与 Skill", secondMemory.ok === true && secondSkill.ok === true, JSON.stringify({ secondMemory, secondSkill }).slice(0, 500));
    const secondCanvas = identity.canvasDocService.createCanvas({ context: ctx(), title: "Canvas Agent B" });
    if (!secondCanvas.ok) throw new Error("B canvas: " + JSON.stringify(secondCanvas));
    await click('[aria-label="打开AI Studio"], [aria-label="打开无限画布"]');
    await click(`[data-canvas="${secondCanvas.canvas.canvasId}"]`);
    await waitFor(() => has("#aiInput"));
    await reducedMotion();
    await openMemory();
    const secondMemoryText = await text(".memlist");
    check("B 记忆 UI 只显示 B 数据", secondMemoryText.includes("ACCOUNT_B_MEMORY_2A") && !secondMemoryText.includes(memoryToken), secondMemoryText);
    await screenshot("05-account-b-isolated-reduced-motion.png");
    await click('#modal [aria-label="关闭"]');
    await waitFor(async () => !(await has("#modal")));
    await logout();
    await login("admin@openarc.test", "admin-password-1");
    const restored = await accountSnapshot();
    const restoredSerialized = JSON.stringify(restored);
    check("A 恢复登录只恢复 A 的记忆、Skill 与 Task", restoredSerialized.includes(memoryToken) && restoredSerialized.includes("account_a_skill_2a") && restoredSerialized.includes(memoryGoal) && !restoredSerialized.includes("ACCOUNT_B_MEMORY_2A") && !restoredSerialized.includes("account_b_skill_2a"), restoredSerialized.slice(0, 600));
    await click('[aria-label="打开AI Studio"], [aria-label="打开无限画布"]');
    await click(`[data-canvas="${canvasId}"]`);
    await waitFor(() => has("#aiInput"));
    await click("#aConv");
    check("A 历史对话由 Task 还原", (await text("#pop")).includes("添加一个经批准的 Agent 节点"), await text("#pop"));
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await sleep(180);
    await reducedMotion();
    await openMemory();
    check("A 恢复后的记忆弹层显示后端数据", (await text(".memlist")).includes(memoryToken), await text(".memlist"));
    await screenshot("05-account-a-restored-reduced-motion.png");
    } else {
      const restarted = await accountSnapshot();
      const serialized = JSON.stringify(restarted);
      check("第二进程重启后 A 的记忆、Skill 与 Task 仍在", serialized.includes("ACCOUNT_A_MEMORY_2A_91f7") && serialized.includes("account_a_skill_2a") && serialized.includes("account isolation memory probe"), serialized.slice(0, 600));
      check("重启不复活已撤销的 memory App grant", !identity.authStore.allAppGrants().some((grant) => grant.app_id === "ai" && grant.resource_type === "memory" && !grant.resource_id));
      await reducedMotion();
      await openMemory();
      check("重启后的记忆 UI 与 Resource 一致", (await text(".memlist")).includes("ACCOUNT_A_MEMORY_2A_91f7"), await text(".memlist"));
      await screenshot("06-account-a-restart-reduced-motion.png");
      await click('#modal [aria-label="关闭"]');
      await waitFor(async () => !(await has("#modal")));
      await click("#aConv");
      check("重启后的历史对话仍由 Task 还原", (await text("#pop")).includes("添加一个经批准的 Agent 节点"), await text("#pop"));
    }
    } catch (error) {
    report.errors.push(String(error && error.stack || error));
    check("探针整体未抛异常", false, String(error && error.message || error));
  } finally {
    try { win?.destroy(); } catch {}
    try { await runtime?.identity?.modelProxy?.stop(); } catch {}
    try { runtime?.identity?.store?.close(); } catch {}
    if (userData && !PERSIST) fs.rmSync(userData, { recursive: true, force: true });
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
