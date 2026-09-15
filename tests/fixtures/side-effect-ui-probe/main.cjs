/**
 * D4-03C4 UI 探针宿主：真实 Electron + 产品真实页面 / preload / Trusted Approval Gateway。
 *
 * 它验证的是产品真正跑的那条线：
 *   main process 生成 SideEffectCall(AWAITING_APPROVAL) → 推送 safe 快照 →
 *   Renderer ApprovalPrompt 渲染 → 用户点击 → sideeffect:command → trusted approval。
 *
 * 它**不**直接调用 SideEffectAuthority.approve —— 点击必须真的走 UI + IPC。
 */
const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "../../..");
const { createIdentityService, registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));

const uiURL = pathToFileURL(path.join(ROOT, "dist/index.html")).href;
const ADMIN = "admin@openarc.test";
const PW = "admin-password-1";
const TRASH = "resource.trash";

const report = { checks: [], errors: [], versions: {} };
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: !!ok, detail: String(detail === undefined ? "" : detail) });
  out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : ""));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win; let userData = null; let identity = null;
const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const text = (sel) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.textContent || ''");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const click = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");
const setInput = (sel, value) =>
  js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing';" +
     "const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;" +
     "setter.call(el, " + JSON.stringify(value) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");

async function waitGate(want, timeout = 30000) {
  const t0 = Date.now(); let last = "?";
  while (Date.now() - t0 < timeout) { try { last = await gate(); if (last === want) return last; } catch { /* navigating */ } await sleep(120); }
  return "TIMEOUT(last=" + last + ")";
}
async function waitSel(sel, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await has(sel)) return true; await sleep(100); }
  return false;
}
async function waitGone(sel, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (!(await has(sel))) return true; await sleep(100); }
  return false;
}
async function waitFor(fn, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (fn()) return true; await sleep(80); }
  return false;
}

/** 用真实 OpenArc authority 建一条待批准 write proposal（等价于 dsh WRITE proposal 落地后）。 */
async function planTrash(name) {
  const sessionRef = identity.service.current;
  const ctx = { sessionRef, appId: "ai", source: "ui" };
  // resource 创建走 resource-library 应用；WRITE 授权链走 "ai" 应用（与产品一致）。
  const created = await identity.resourceService.createResource({ context: { sessionRef, appId: "resource-library", source: "ui" }, resourceType: "text", name, content: "approval-ui-body" });
  if (!created.ok) throw new Error("createResource failed: " + JSON.stringify(created));
  const resourceId = created.resource.resourceId;
  const resourceRef = created.resource.resourceRef;
  identity.authorization.grantAppToolPermission({ context: ctx, appId: "ai", actions: ["tool.resource.trash"] });
  identity.authorization.grantAppResourcePermission({ context: ctx, appId: "ai", resourceId, actions: ["resource.delete"] });
  identity.authorization.grantResourcePermission({ context: ctx, principalType: "USER", principalId: identity.service.snapshot.userId, resourceId, actions: ["resource.delete", "resource.useByAgent"] });
  const t = identity.taskService.createTask({ context: ctx, goal: "approval ui probe" });
  const s1 = identity.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
  const step = identity.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: s1.task.revision });
  const s2 = identity.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: step.step.stepId, expectedRevision: step.task.revision });
  const run = identity.taskService.startHarnessRun({ context: ctx, taskId: t.task.taskId, stepId: step.step.stepId, expectedRevision: s2.task.revision });
  identity.taskService.markHarnessRunRunning({ context: ctx, taskId: t.task.taskId, runId: run.run.runId, expectedRevision: run.task.revision });
  const planned = await identity.sideEffectRuntime.proposeWrite({ context: ctx, taskId: t.task.taskId, stepId: step.step.stepId, runId: run.run.runId, toolId: TRASH, arguments: { resourceRef } });
  if (!planned.ok) throw new Error("proposeWrite failed: " + JSON.stringify(planned));
  return { callId: planned.approvalRequestId, resourceRef, resourceId, taskId: t.task.taskId };
}

app.whenReady().then(async () => {
  try {
    report.versions = { electron: process.versions.electron, node: process.versions.node, platform: process.platform + "/" + process.arch };
    out("VERSIONS " + JSON.stringify(report.versions));

    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d4-03c4-ui-"));
    identity = createIdentityService({ userDataDir: userData, safeStorage, allowAdmin: true });
    await identity.store.initialize({ identifier: ADMIN, password: PW, displayName: "Admin" });
    identity.authStore.upsertApp({ appId: "ai", name: "ai", publisher: "test", status: "enabled", builtIn: 0 });

    win = new BrowserWindow({
      width: 1280, height: 860, show: false,
      webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));
    registerIdentityIpc({
      ipcMain,
      service: identity.service,
      authorization: identity.authorization,
      device: identity.deviceService,
      resource: identity.resourceService,
      sideEffect: identity.sideEffectGateway,
      BrowserWindow,
      isTrusted: (e) => e.sender === win.webContents && e.senderFrame?.url === uiURL,
      send: (event) => { if (win && !win.isDestroyed()) win.webContents.send("identity:event", event); },
      sendSideEffect: (event) => { if (win && !win.isDestroyed()) win.webContents.send("sideeffect:event", event); },
    });

    await win.loadURL(uiURL);
    await sleep(500);
    let g = await waitGate("unauthenticated");
    check("A1 · 已初始化 -> 登录页", g === "unauthenticated", "gate=" + g);
    await setInput('[data-d3-id="login-identifier"]', ADMIN);
    await setInput('[data-d3-id="login-password"]', PW);
    await sleep(80);
    await click('[data-d3-id="login-submit"]');
    g = await waitGate("ready");
    check("A2 · 登录进入桌面", g === "ready", "gate=" + g);

    const surface = await js("return window.openarc && window.openarc.sideEffect ? Object.keys(window.openarc.sideEffect).sort().join(',') : 'missing'");
    check("A3 · preload sideEffect 桥只有 command,onEvent", surface === "command,onEvent", surface);
    check("A4 · Renderer 拿不到 SideEffectRuntime / observeExit", await js("return typeof window.openarc.sideEffectRuntime === 'undefined' && typeof window.observeExit === 'undefined'"), "");

    // 真实 proposal → 推送 → UI 出现。
    const first = await planTrash("Approval UI Target");
    const appeared = await waitSel('[data-approval-request-id="' + first.callId + '"]', 20000);
    check("A5 · Approval UI 出现（推送 / 拉取）", appeared, first.callId);
    const dialogText = await text(".approval");
    check("A6 · 显示 Tool 名称与风险", dialogText.includes("Trash Resource") && dialogText.includes("可逆写入"), dialogText.replace(/\s+/g, " ").slice(0, 160));
    check("A7 · 显示目标资源名与 ResourceRef", dialogText.includes("Approval UI Target") && dialogText.includes("resource://res_"), dialogText.replace(/\s+/g, " ").slice(0, 200));
    check("A8 · 显示预期效果（移入废纸篓）", dialogText.includes("废纸篓"), "");
    check("A9 · 显示前置条件版本", /版本 1/.test(dialogText), "");

    const dom = await js("return document.body.innerHTML");
    const leaks = ["/Users/", "/private/", "/var/folders", userData, identity.resourceService.store ? "" : "", "mpx_", "tpx_"].filter((s) => s && dom.includes(s));
    check("A10 · UI 不泄漏绝对路径 / store root / capability", leaks.length === 0, JSON.stringify(leaks));

    // 批准：必须经 UI 点击 → IPC → trusted approval。
    const callBefore = identity.sideEffectStore.callById(first.callId);
    check("A11 · 批准前 call = AWAITING_APPROVAL / 0 mutation", callBefore.status === "AWAITING_APPROVAL" && identity.resourceService.sideEffectPrecondition({ resourceRef: first.resourceRef }).trashed === false, callBefore.status);
    check("A12 · 点击 批准", (await click('[data-approval-action="approve"]')) === "ok", "");
    const approved = await waitFor(() => identity.sideEffectStore.callById(first.callId).status === "APPROVED", 15000);
    check("A13 · 点击后 call = APPROVED（trusted user approval）", approved, identity.sideEffectStore.callById(first.callId).status);
    const approval = identity.sideEffectStore.latestApprovalOfCall(first.callId);
    check("A14 · approval actor = 当前 authenticated session 用户", !!approval && approval.actorUserId === identity.service.snapshot.userId, approval ? approval.actorUserId : "none");
    check("A15 · approval 绑定 call 的 planHash", !!approval && approval.planHash === identity.sideEffectStore.callById(first.callId).planHash, "");
    check("A16 · 决策后 UI 关闭", await waitGone('[data-approval-request-id="' + first.callId + '"]'), "");
    check("A17 · 批准本身不执行 Domain write（0 mutation）", identity.resourceService.sideEffectPrecondition({ resourceRef: first.resourceRef }).trashed === false, "");

    // 拒绝：第二条真实请求。
    const second = await planTrash("Approval UI Deny Target");
    const appeared2 = await waitSel('[data-approval-request-id="' + second.callId + '"]', 20000);
    check("A18 · 第二条 Approval 请求出现", appeared2, second.callId);
    check("A19 · 点击 拒绝", (await click('[data-approval-action="deny"]')) === "ok", "");
    const denied = await waitFor(() => identity.sideEffectStore.callById(second.callId).status === "BLOCKED", 15000);
    check("A20 · Deny → call BLOCKED / resource 保持 active / 0 lease", denied
      && identity.resourceService.sideEffectPrecondition({ resourceRef: second.resourceRef }).trashed === false
      && identity.sideEffectStore.leasesOfCall(second.callId).length === 0, identity.sideEffectStore.callById(second.callId).status);

    // stale request：已终态的 request 即使 UI 还开着也必须 DENY。
    const stale = identity.sideEffectGateway.decideApproval({ context: { sessionRef: identity.service.current, source: "user" }, approvalRequestId: second.callId, decision: "APPROVE" });
    check("A21 · terminal call 事后 Approve 一律拒绝", stale.ok === false, JSON.stringify(stale));

    // 渲染进程自报 actor 字段被忽略。
    const third = await planTrash("Approval UI Spoof Target");
    await waitSel('[data-approval-request-id="' + third.callId + '"]', 20000);
    const spoofed = await js("return window.openarc.sideEffect.command({ type: 'sideEffect/decideApproval', approvalRequestId: " + JSON.stringify(third.callId) + ", decision: 'APPROVE', userId: 'u_attacker', role: 'ADMIN', sessionRef: 'sess_evil', riskClass: 'READ_ONLY' })");
    const spoofApproval = identity.sideEffectStore.latestApprovalOfCall(third.callId);
    check("A22 · Renderer 自报 actor/risk 被忽略", spoofed && spoofed.ok === true && spoofApproval.actorUserId === identity.service.snapshot.userId && spoofApproval.approvedEffectClass === "REVERSIBLE_WRITE", JSON.stringify({ ok: spoofed && spoofed.ok, actor: spoofApproval && spoofApproval.actorUserId }));
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
    check("探针整体未抛异常", false, String(e.message).slice(0, 200));
  } finally {
    try { win?.destroy(); } catch { /* ignore */ }
    try { identity?.store?.close(); } catch { /* ignore */ }
    if (userData) { try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
