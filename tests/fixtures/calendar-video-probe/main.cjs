const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const ROOT = path.resolve(__dirname, "../../..");
const { createOpenArcRuntime } = require(path.join(ROOT, "electron/runtime-boot.cjs"));
const { registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));
const { createCalendarBundle } = require(path.join(ROOT, "electron/calendar-service.cjs"));
const { registerCalendarIpc } = require(path.join(ROOT, "electron/calendar-bootstrap.cjs"));
const { createMediaBundle } = require(path.join(ROOT, "electron/media-service.cjs"));
const { registerMediaIpc } = require(path.join(ROOT, "electron/media-bootstrap.cjs"));
const uiURL = pathToFileURL(path.join(ROOT, "dist/vue.html")).href;
const RESTART = process.env.OA_2B_RESTART === "1";
const PERSIST = !!process.env.OA_2B_USER_DATA;
const OUT = path.join(ROOT, "artifacts/calendar-video-2b");
const report = { checks: [], errors: [], screenshots: [], functional: "pending", visual: "pending", motion: "pending" };
let win; let runtime; let userData; let calendarBundle; let mediaBundle;
let delayedCalendar = null; let delayedMedia = null;
let calendarDelayStarted = false; let mediaDelayStarted = false;
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail = "") => { report.checks.push({ name, ok: !!ok, detail: String(detail) }); out((ok ? "PASS " : "FAIL ") + name + (detail ? " :: " + detail : "")); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
const has = (sel) => js("return Array.from(document.querySelectorAll(" + JSON.stringify(sel) + ")).some((el)=>el.getClientRects().length>0)");
const text = (sel) => js("const el=Array.from(document.querySelectorAll(" + JSON.stringify(sel) + ")).find((el)=>el.getClientRects().length>0);return el?.textContent || ''");
const click = (sel) => js("const el=Array.from(document.querySelectorAll(" + JSON.stringify(sel) + ")).find((el)=>el.getClientRects().length>0);if(!el)return 'missing';if(el.disabled)return 'disabled';el.click();return 'ok'");
const setInput = (sel, value) => js("const el=Array.from(document.querySelectorAll(" + JSON.stringify(sel) + ")).find((el)=>el.getClientRects().length>0);if(!el)return 'missing';const p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(el," + JSON.stringify(value) + ");el.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'");
async function waitFor(fn, timeout = 30000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await Promise.resolve(fn())) return true; await sleep(80); } return false; }
async function login(identifier, password) {
  await waitFor(async () => (await has('[data-d3-id="login-identifier"]')) || (await js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate')")) === "ready");
  if ((await js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate')")) === "ready") return;
  await setInput('[data-d3-id="login-identifier"]', identifier);
  await setInput('[data-d3-id="login-password"]', password);
  await click('[data-d3-id="login-submit"]');
  if (!(await waitFor(async () => (await js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate')")) === "ready"))) throw new Error("login failed");
}
async function logout() {
  const result = await js("return window.openarc.identity.command({type:'identity/logout'})");
  if (!result.ok) throw new Error("logout failed");
  await waitFor(() => has('[data-d3-id="login-identifier"]'));
}
async function openApp(id, ready) {
  const viaDock = await click(`[data-dock-id="${id}"]`);
  if (viaDock !== "ok") {
    await click('[data-dock-id="home"]');
    await waitFor(() => has(`[data-app-card="${id}"]`));
    await click(`[data-app-card="${id}"]`);
  }
  if (!(await waitFor(() => has(ready)))) throw new Error("app not ready: " + id);
  if (id === "calendar" && !(await waitFor(async () => !(await has("[data-cal-loading]"))))) throw new Error("calendar load did not settle");
  if (id === "video" && !(await waitFor(async () => !(await text("[data-video-draft-status]")).includes("正在读取")))) throw new Error("video draft load did not settle");
  await sleep(450);
}
async function reducedMotion() {
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  if (!(await js("return matchMedia('(prefers-reduced-motion: reduce)').matches"))) throw new Error("reduced motion inactive");
}
async function screenshot(name) {
  fs.mkdirSync(OUT, { recursive: true });
  await sleep(300);
  const image = await win.webContents.capturePage();
  const file = path.join(OUT, name);
  fs.writeFileSync(file, image.toPNG());
  report.screenshots.push(file);
}
async function seedLegacy() {
  await js(`
    localStorage.setItem('oa-calendar-events', JSON.stringify([{id:'legacy-calendar',date:new Date().toISOString().slice(0,10),time:'09:30',title:'Legacy Calendar A',reminderMinutes:10}]));
    localStorage.setItem('oa-video-project', JSON.stringify({name:'Legacy Video A',resolution:'1080p',clips:[]}));
    localStorage.setItem('oa-video-media-project', JSON.stringify({timeline:{schemaVersion:'1.0',version:4,timebase:1000,canvas:{width:1920,height:1080,fps:30},durationMs:2000,tracks:[{id:'tv',type:'video',name:'主视频',order:0,locked:false,muted:false,hidden:false,clips:[{id:'legacy-clip',trackId:'tv',name:'Legacy Clip',timelineStartMs:0,durationMs:2000,sourceInMs:0,sourceOutMs:2000,volume:1}]}],transitions:[]},sources:{}}));
  `);
}
async function theme(value) {
  await js("localStorage.setItem('oa-theme'," + JSON.stringify(value) + ");localStorage.setItem('oa-motion','true')");
  await win.webContents.executeJavaScript("location.reload()");
  await waitFor(async () => (await js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate')")) === "ready");
  await reducedMotion();
}

app.whenReady().then(async () => {
  try {
    userData = process.env.OA_2B_USER_DATA || fs.mkdtempSync(path.join(os.tmpdir(), "oa-calendar-video-2b-"));
    runtime = await createOpenArcRuntime({ userDataDir: userData, safeStorage, allowAdmin: true });
    const identity = runtime.identity;
    if (!RESTART) {
      await identity.store.initialize({ identifier: "admin@openarc.test", password: "admin-password-1", displayName: "Admin" });
      const admin = identity.store.allUsers().find((user) => user.role === "ADMIN");
      const second = await identity.store.createUser({ identifier: "second@openarc.test", password: "second-password-1", displayName: "Second", teamId: admin.team_id });
      if (!second.ok) throw new Error(JSON.stringify(second));
    }
    for (const appId of ["ai", "settings", "resource-library", "calendar", "video"]) if (!identity.authStore.appById(appId)) identity.authStore.upsertApp({ appId, name: appId, publisher: "probe", status: "enabled", builtIn: 1 });
    win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    win.webContents.on("console-message", (_event, level, message) => { if (level >= 2) out("RENDERER " + level + " " + message); });
    const trusted = (event) => event.sender === win.webContents && event.senderFrame?.url === uiURL;
    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("system:info", async () => ({ ok: true, platform: process.platform, arch: process.arch }));
    ipcMain.handle("integration:command", async (_event, raw) => raw?.command === "integration/plugins/list" ? { ok: true, value: { items: [{ id: "almanac", enabled: false }] } } : { ok: false, error: "INTEGRATION_UNAVAILABLE", message: "离线探针未启用黄历" });
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));
    ipcMain.handle("browser:command", async () => ({ ok: false, error: "BROWSER_UNAVAILABLE" }));
    ipcMain.handle("files:list", async () => ({ ok: true, entries: [] }));
    ipcMain.handle("files:trashList", async () => ({ ok: true, entries: [] }));
    ipcMain.handle("video:status", async () => ({ ok: true, available: false, error: "FFMPEG_MISSING" }));
    registerIdentityIpc({ ipcMain, service: identity.service, authorization: identity.authorization, device: identity.deviceService, resource: identity.resourceService, resourceSearch: identity.searchService, governance: identity.governanceService, model: identity.modelService, sideEffect: identity.sideEffectGateway, BrowserWindow, isTrusted: trusted, send: (event) => { if (win && !win.isDestroyed()) win.webContents.send("identity:event", event); }, sendSideEffect: (event) => { if (win && !win.isDestroyed()) win.webContents.send("sideeffect:event", event); } });
    const rawCalendar = createCalendarBundle({ identityStore: identity.store, authorization: identity.authorization });
    const isAdminContext = (context) => identity.authorization.resolveActor({ context }).user?.id === identity.store.allUsers().find((user) => user.role === "ADMIN")?.id;
    calendarBundle = { execute: async (command, payload, context) => {
      if (delayedCalendar && command === "calendar/event/list") out("TRACE calendar list admin=" + isAdminContext(context));
      if (delayedCalendar && command === "calendar/event/list" && isAdminContext(context)) { const gate = delayedCalendar; delayedCalendar = null; calendarDelayStarted = true; await gate.promise; }
      return rawCalendar.execute(command, payload, context);
    } };
    mediaBundle = createMediaBundle({ userDataDir: userData, identityStore: identity.store, authorization: identity.authorization });
    const rawMediaExecute = mediaBundle.execute;
    mediaBundle.execute = async (command, payload, context) => {
      if (delayedMedia && command === "media/draft/get" && isAdminContext(context)) { const gate = delayedMedia; delayedMedia = null; mediaDelayStarted = true; await gate.promise; }
      return rawMediaExecute(command, payload, context);
    };
    registerCalendarIpc({ ipcMain, bundle: calendarBundle, identity: identity.service, isTrusted: trusted });
    registerMediaIpc({ ipcMain, bundle: mediaBundle, identity: identity.service, isTrusted: trusted });
    await win.loadURL(uiURL);
    await login("admin@openarc.test", "admin-password-1");
    await theme("light");
    check("生产 schema 为 v30", identity.store.schemaVersion === 30, String(identity.store.schemaVersion));

    if (!RESTART) {
      const seeded = await calendarBundle.execute("calendar/event/create", { event: { id: "race-a", date: "2026-10-28", time: "", title: "Race A" } }, { sessionRef: identity.service.current });
      if (!seeded.ok) throw new Error(JSON.stringify(seeded));
      await seedLegacy();
      delayedCalendar = Promise.withResolvers();
      delayedMedia = Promise.withResolvers();
      const calendarGate = delayedCalendar;
      const mediaGate = delayedMedia;
      await click('[data-dock-id="home"]');
      await waitFor(() => has('[data-app-card="calendar"]'));
      const openCalendar = await click('[data-app-card="calendar"]');
      if (openCalendar !== "ok") throw new Error("open A calendar: " + openCalendar);
      if (!(await waitFor(() => calendarDelayStarted, 10000))) throw new Error("A calendar delayed request did not start");
      await click('[data-dock-id="home"]');
      await waitFor(() => has('[data-app-card="video"]'));
      const openVideo = await click('[data-app-card="video"]');
      if (openVideo !== "ok") throw new Error("open A video: " + openVideo);
      if (!(await waitFor(() => mediaDelayStarted, 10000))) throw new Error("A media delayed request did not start");
      await logout();
      await login("second@openarc.test", "second-password-1");
      await openApp("calendar", "[data-calendar-app]");
      await openApp("video", "[data-video-draft-status]");
      calendarGate.resolve(); mediaGate.resolve();
      await sleep(700);
      check("延迟 A 响应不覆盖 B 日历和视频", !(await text("[data-cal-agenda]")).includes("Race A") && !(await text(".vd-title")).includes("Legacy Video A"), (await text("[data-cal-agenda]")) + " / " + (await text(".vd-title")));
      await screenshot("01-b-race-light.png");
      await logout();
      await login("admin@openarc.test", "admin-password-1");

      await openApp("calendar", "[data-calendar-app]");
      check("旧日历键不被自动读取", !(await text("[data-cal-agenda]")).includes("Legacy Calendar A"), await text("[data-cal-agenda]"));
      await click("[data-cal-new]");
      await setInput("[data-cal-new-title]", "A Calendar");
      await click("[data-cal-new-submit]");
      await waitFor(async () => (await text("[data-cal-agenda]")).includes("A Calendar"));
      await click("[data-cal-legacy-import]");
      await waitFor(async () => (await text("[data-cal-agenda]")).includes("Legacy Calendar A"));
      check("A 日历创建与显式导入成功", (await text("[data-cal-agenda]")).includes("A Calendar") && (await text("[data-cal-agenda]")).includes("Legacy Calendar A"), await text("[data-cal-agenda]"));
      await screenshot("02-a-calendar-light.png");

      await openApp("video", "[data-video-draft-status]");
      check("旧视频键不被自动读取", (await text(".vd-title")).includes("未命名剪辑"), await text(".vd-title"));
      await click("[data-video-legacy-import]");
      await waitFor(async () => (await text(".vd-title")).includes("Legacy Video A"));
      await js("document.querySelector('[data-video-mode-multi]').click()");
      await waitFor(() => has('[data-clip-id="legacy-clip"]'));
      check("quick/multi 草稿经 media import 恢复", (await text(".vd-title")).includes("Legacy Video A") && (await has('[data-clip-id="legacy-clip"]')));
      await screenshot("03-a-video-multi-light.png");
      const project = identity.store.connection.prepare("SELECT id FROM video_projects WHERE name='Legacy Video A'").get();
      const currentDraft = await mediaBundle.execute("media/draft/get", { projectId: project.id }, { sessionRef: identity.service.current });
      const external = await mediaBundle.execute("media/draft/save", { projectId: project.id, quick: { ...currentDraft.value.draft.quick, name: "Other Window" }, timeline: currentDraft.value.draft.timeline, sources: currentDraft.value.draft.sources, expectedVersion: 1 }, { sessionRef: identity.service.current });
      if (!external.ok) throw new Error(JSON.stringify(external));
      await js("const el=document.querySelector('.notes-title');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'Stale Renderer');el.dispatchEvent(new Event('input',{bubbles:true}))");
      await waitFor(() => has("[data-video-draft-error]"));
      check("视频并发版本冲突可见且不被覆盖", (await text("[data-video-draft-error]")).includes("MEDIA_CONFLICT"), await text("[data-video-draft-error]"));
      await screenshot("04-video-conflict-light.png");
      await click("[data-video-draft-reload]");
      await waitFor(async () => (await text(".vd-title")).includes("Other Window"));
      await theme("dark");
      await openApp("calendar", "[data-calendar-app]");
      await screenshot("05-a-calendar-dark.png");
      await openApp("video", "[data-video-draft-status]");
      await screenshot("06-a-video-dark.png");

      await logout();
      await login("second@openarc.test", "second-password-1");
      await openApp("calendar", "[data-calendar-app]");
      check("B 不见 A 日程，旧键仍不自动归属", !(await text("[data-cal-agenda]")).includes("A Calendar") && !(await text("[data-cal-agenda]")).includes("Legacy Calendar A"), await text("[data-cal-agenda]"));
      await openApp("video", "[data-video-draft-status]");
      check("B 不见 A 视频草稿", (await text(".vd-title")).includes("未命名剪辑"), await text(".vd-title"));
      check("B 桌面通知不残留 A 日程标题", !(await js("return document.body.innerText")).includes("日程提醒：Legacy Calendar A"));
      await screenshot("07-b-empty-dark.png");
      await logout();
      await login("admin@openarc.test", "admin-password-1");
      await openApp("calendar", "[data-calendar-app]");
      await openApp("video", "[data-video-draft-status]");
      check("A 恢复日程与视频草稿", (await text("[data-cal-agenda]")).includes("A Calendar") && (await text(".vd-title")).includes("Other Window"), (await text("[data-cal-agenda]")) + " / " + (await text(".vd-title")));
      const calendarKeys = await js("return [localStorage.getItem('oa-calendar-events')!==null,localStorage.getItem('oa-video-project')!==null,localStorage.getItem('oa-video-media-project')!==null]");
      check("显式导入成功前不删除且完成后仍保留旧键", calendarKeys.every(Boolean), JSON.stringify(calendarKeys));
    } else {
      await openApp("calendar", "[data-calendar-app]");
      await openApp("video", "[data-video-draft-status]");
      check("第二进程重启恢复 A 日程与草稿", (await text("[data-cal-agenda]")).includes("A Calendar") && (await text(".vd-title")).includes("Other Window"), (await text("[data-cal-agenda]")) + " / " + (await text(".vd-title")));
      check("重启后 draft/timeline 与提醒版本均保留", identity.store.connection.prepare("SELECT version FROM video_project_drafts").get().version === 2 && identity.store.connection.prepare("SELECT json_extract(timeline_json,'$.version') AS version FROM video_project_drafts").get().version === 4 && identity.store.connection.prepare("SELECT version FROM calendar_events WHERE id='legacy-calendar'").get().version >= 1);
      await screenshot("08-a-restart-dark.png");
    }
    report.functional = report.checks.every((item) => item.ok) ? "passed" : "failed";
    report.visual = "captured";
    report.motion = "reduced-motion matchMedia verified; no animation code changed";
  } catch (error) {
    report.errors.push(String(error && error.stack || error));
    try { await screenshot("debug-failure.png"); } catch {}
    check("探针整体未抛异常", false, String(error && error.message || error));
    report.functional = "failed";
  } finally {
    try { win?.destroy(); } catch {}
    try { await runtime?.identity?.modelProxy?.stop(); } catch {}
    try { runtime?.identity?.store?.close(); } catch {}
    if (userData && !PERSIST) fs.rmSync(userData, { recursive: true, force: true });
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
