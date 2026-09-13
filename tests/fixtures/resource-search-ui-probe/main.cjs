/**
 * D3-04C 搜索 UI 探针宿主（真实 Electron + 产品真实页面 / preload / SearchService）。
 * 验证：中文全文搜索（鞋子 / 详情页 / 生成提示）、snippet <mark>、命中字段、索引状态。
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

const report = { checks: [], errors: [], versions: {} };
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, detail: String(detail === undefined ? "" : detail) }); out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
let userData = null;

const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const txt = (sel) => js("return (document.querySelector(" + JSON.stringify(sel) + ")?.textContent || '').trim()");

async function waitGate(want, timeout = 30000) {
  const t0 = Date.now();
  let last = "?";
  while (Date.now() - t0 < timeout) { try { last = await gate(); if (last === want) return last; } catch { /* navigating */ } await sleep(120); }
  return "TIMEOUT(last=" + last + ")";
}
async function waitSel(sel, timeout = 15000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await has(sel)) return true; await sleep(100); } return false; }
async function waitFn(expr, timeout = 20000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await js("return (" + expr + ")")) return true; } catch { /* ignore */ } await sleep(100); } return false; }
const setValue = (sel, value) =>
  js(
    "const el = document.querySelector(" + JSON.stringify(sel) + ");" +
      "if (!el) return 'missing';" +
      "const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;" +
      "const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;" +
      "setter.call(el, " + JSON.stringify(value) + ");" +
      "el.dispatchEvent(new Event('input', { bubbles: true }));" +
      "return 'ok';",
  );
const click = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");

app.whenReady().then(async () => {
  try {
    report.versions = { electron: process.versions.electron, node: process.versions.node, platform: process.platform + "/" + process.arch };
    out("VERSIONS " + JSON.stringify(report.versions));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d3-04c-search-ui-"));
    const identity = createIdentityService({ userDataDir: userData, safeStorage, allowAdmin: true, nativeImage: require("electron").nativeImage });
    await identity.store.initialize({ identifier: ADMIN, password: PW, displayName: "Admin" });

    const cnFile = path.join(userData, "中文资料.txt");
    fs.writeFileSync(cnFile, "红色鞋子 详情页 生成提示词 本地全文检索");
    const stubDialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [cnFile] }) };

    win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));
    registerIdentityIpc({
      ipcMain, service: identity.service, authorization: identity.authorization, device: identity.deviceService,
      resource: identity.resourceService, resourceSearch: identity.searchService, resourcePreview: identity.previewService,
      dialog: stubDialog, BrowserWindow, isTrusted: (e) => e.sender === win.webContents && e.senderFrame?.url === uiURL,
      send: (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("identity:event", event); },
    });

    await win.loadURL(uiURL);
    await sleep(500);
    let g = await waitGate("unauthenticated");
    check("C1 · 登录页", g === "unauthenticated", "gate=" + g);
    await setValue('[data-d3-id="login-identifier"]', ADMIN);
    await setValue('[data-d3-id="login-password"]', PW);
    await sleep(80);
    await click('[data-d3-id="login-submit"]');
    g = await waitGate("ready");
    check("C2 · 登录进入桌面", g === "ready", "gate=" + g);

    await click('[data-app-id="resource-library"]');
    check("C3 · 打开资源库 App", await waitSel('[data-d3-04b="app"]'), "app");

    // 导入中文文本
    await click('[data-d3-04a-action="import"]');
    check("C4 · 导入中文资料后出现在列表", await waitFn("Array.from(document.querySelectorAll('[data-d3-04a-item]')).some(function(e){return e.textContent.indexOf('中文资料')>=0;})"), "");

    // 中文全文搜索：鞋子
    await setValue('input[aria-label="全文搜索"]', "鞋子");
    const shoeMode = await waitFn("!!document.querySelector('[data-d3-04c-search-mode]')");
    check("C5 · 进入全文搜索模式（显示授权结果数）", shoeMode, await txt('[data-d3-04c-search-mode]'));
    check("C6 · 中文「鞋子」命中 1 条", await waitFn("document.querySelectorAll('[data-d3-04a-item]').length===1"), await js("return document.querySelectorAll('[data-d3-04a-item]').length"));
    check("C7 · snippet 以结构化 <mark> 高亮，且无 innerHTML 注入", await waitFn("document.querySelector('[data-d3-04c-snippet] mark') && document.querySelector('[data-d3-04c-snippet]').innerHTML.indexOf('<script')<0"), "");
    check("C8 · 命中字段显示 content", await waitFn("document.querySelector('[data-d3-04c-fields]') && document.querySelector('[data-d3-04c-fields]').textContent.indexOf('content')>=0"), await txt('[data-d3-04c-fields]'));

    // 详情页 / 生成提示
    await setValue('input[aria-label="全文搜索"]', "详情页");
    check("C9 · 中文「详情页」命中", await waitFn("document.querySelectorAll('[data-d3-04a-item]').length===1"), await js("return document.querySelectorAll('[data-d3-04a-item]').length"));
    await setValue('input[aria-label="全文搜索"]', "生成提示");
    check("C10 · 中文「生成提示」命中（跨字 bigram）", await waitFn("document.querySelectorAll('[data-d3-04a-item]').length===1"), await js("return document.querySelectorAll('[data-d3-04a-item]').length"));

    // 不存在的词 -> 0
    await setValue('input[aria-label="全文搜索"]', "不存在的词zzz");
    check("C11 · 不存在的词 0 结果（空态）", await waitFn("!!document.querySelector('[data-d3-04a-empty]') && document.querySelectorAll('[data-d3-04a-item]').length===0"), await txt('[data-d3-04a-empty]'));

    // 清空 -> 回结构化浏览
    await setValue('input[aria-label="全文搜索"]', "");
    check("C12 · 清空搜索回到结构化浏览", await waitFn("!document.querySelector('[data-d3-04c-search-mode]') && document.querySelectorAll('[data-d3-04a-item]').length>=1"), "");

    // 选中 -> Inspector 显示 index status
    await js("const el=document.querySelector('[data-d3-04a-item]'); if(el) el.click(); return 'ok';");
    check("C13 · Inspector 显示 Index Status = READY", await waitFn("document.querySelector('[data-d3-04c-index-status]') && document.querySelector('[data-d3-04c-index-status]').textContent.indexOf('READY')>=0"), await txt('[data-d3-04c-index-status]'));
    check("C14 · Inspector 显示 Indexed/Resource Version", await waitFn("document.querySelector('[data-d3-04c-index-version]') && document.querySelector('[data-d3-04c-index-version]').textContent.indexOf('v1')>=0"), await txt('[data-d3-04c-index-version]'));

    // 主进程交叉验证：中文检索确实由本地索引提供
    const mainSearch = await identity.searchService.search({ context: { sessionRef: identity.service.current, appId: "resource-library" }, query: "鞋子", limit: 10 });
    check("C15 · 主进程交叉验证：鞋子 -> 1（本地 FTS）", mainSearch.ok && mainSearch.total === 1, "total=" + mainSearch.total);

    check("C16 · DOM 不泄漏本地存储路径", !(await js("return document.body.innerHTML")).includes(userData), "");
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
    check("探针整体未抛异常", false, String(e.message).slice(0, 200));
  } finally {
    try { win?.destroy(); } catch { /* ignore */ }
    if (userData) { try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
