/**
 * Vue「访达(files)」+「资源库(resource-library)」迁移探针
 * （真实 Electron + 产品真实页面 / preload / 身份与 ResourceService 装配）。
 *
 * 与 experiments/vue-settings/main.cjs 同一手法：主进程自持窗口 + executeJavaScript，
 * 页面是 dist/vue.html，preload 是 electron/preload.cjs，Resource IPC 走
 * electron/resource-bootstrap.cjs 的真实 ResourceService / SearchService / PreviewService。
 *
 * 覆盖：
 *   · dock 打开 files → [data-d3-04d="files"] 及其全部契约
 *   · dock 打开 resource-library → [data-d3-04a/b/c] 契约全集逐条存在
 *   · 基本交互：新建 / 打开 inspector / 编辑版本 / 加标签 / 切 view-mode / 点 nav
 *   · 全程没有 console error / 渲染进程崩溃
 *   · files 窗口 + 资源库三栏各一张截图到 artifacts/vue-resource/
 */
const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "../..");
const { createIdentityService, registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));

const uiURL = pathToFileURL(path.join(ROOT, "dist/vue.html")).href;
const OUT = path.join(ROOT, "artifacts", "vue-resource");
const IDENT = "vue-resource@openarc.local";
const PW = "vue-resource-password-1";
const NAME = "Vue Resource";

/** 访达页 <p class="subtitle"> 的文案（与 src/governance/FilesApp.tsx 的 meta 同一份）。 */
const FILES_META = "File Manager 管理普通文件；Resource Library 管理 OpenArc Resource Object。这里是受控的 Add to Library / Export 入口。";
/** 访达窗口锚点：产品常驻所有窗口 DOM，全局 .split-main 会跨窗口串味，断言必须限定到窗口根。 */
const FILES_WIN = '.window[aria-label="访达窗口"]';

/** 契约全集：由 `grep -oE 'data-d3-04[a-d][a-z-]*=' src/resource/ResourceLibraryApp.tsx | sort -u` 得到。 */
const CONTRACT = [
  "data-d3-04a",
  "data-d3-04a-item",
  "data-d3-04a-action",
  "data-d3-04b",
  "data-d3-04b-nav",
  "data-d3-04b-item",
  "data-d3-04b-action",
  "data-d3-04b-cap",
  "data-d3-04b-inspector-ref",
  "data-d3-04b-restore-version",
  "data-d3-04b-tag",
  "data-d3-04b-view",
  "data-d3-04b-view-mode",
  "data-d3-04c-preview",
  "data-d3-04c-action",
];

const report = { checks: [], errors: [], consoleErrors: [], shots: [], versions: {}, missingContract: [] };
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok: !!ok, detail: String(detail) });
  out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : ""));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win;
let userData = null;

const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const has = (sel) => js(`return !!document.querySelector(${JSON.stringify(sel)})`);
const text = (sel) => js(`return (document.querySelector(${JSON.stringify(sel)})?.textContent || '').trim()`);
const attr = (sel, name) => js(`return document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(name)}) || null`);
const count = (sel) => js(`return document.querySelectorAll(${JSON.stringify(sel)}).length`);

async function waitGate(want, timeout = 30000) {
  const wantList = Array.isArray(want) ? want : [want];
  const t0 = Date.now();
  let last = "?";
  while (Date.now() - t0 < timeout) {
    try {
      last = await gate();
      if (wantList.includes(last)) return last;
    } catch {
      /* 导航中 */
    }
    await sleep(120);
  }
  return "TIMEOUT(last=" + last + ")";
}
async function waitFor(sel, timeout = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await has(sel)) return true;
    await sleep(60);
  }
  return false;
}
async function waitGone(sel, timeout = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (!(await has(sel))) return true;
    await sleep(80);
  }
  return false;
}
async function waitAttr(sel, name, value, timeout = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if ((await attr(sel, name)) === value) return true;
    await sleep(60);
  }
  return false;
}
async function waitFn(expr, timeout = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await js("return (" + expr + ")")) return true;
    await sleep(80);
  }
  return false;
}
async function waitEnabled(sel, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const disabled = await js(`return !!document.querySelector(${JSON.stringify(sel)})?.disabled`);
    if (disabled === false) return true;
    await sleep(80);
  }
  return false;
}
const setValue = (sel, value) =>
  js(`
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'missing';
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    return 'ok';
  `);
const click = (sel) =>
  js(`
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'missing';
    if (el.disabled) return 'disabled';
    el.click();
    return 'ok';
  `);
const maximize = (sel) =>
  js(`
    const root = document.querySelector(${JSON.stringify(sel)});
    if (!root) return 'missing';
    const w = root.closest('.window');
    if (!w) return 'no-window';
    const btn = w.querySelector('.traffic .maximize');
    if (!btn) return 'no-btn';
    btn.click();
    return 'ok';
  `);

async function shoot(name, rect) {
  await sleep(450);
  const image = rect ? await win.webContents.capturePage(rect) : await win.webContents.capturePage();
  const file = path.join(OUT, name);
  fs.writeFileSync(file, image.toPNG());
  report.shots.push(file);
  out("SHOT " + file + " " + image.getSize().width + "x" + image.getSize().height);
}

app.whenReady().then(async () => {
  try {
    report.versions = { electron: process.versions.electron, node: process.versions.node, platform: process.platform + "/" + process.arch };
    out("VERSIONS " + JSON.stringify(report.versions));
    fs.mkdirSync(OUT, { recursive: true });

    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-vue-resource-"));
    const identity = createIdentityService({ userDataDir: userData, safeStorage, allowAdmin: true });
    await identity.store.initialize({ identifier: IDENT, password: PW, displayName: NAME });

    const fixtureFile = path.join(userData, "probe-import.txt");
    fs.writeFileSync(fixtureFile, "imported via vue probe");
    const stubDialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [fixtureFile] }) };

    win = new BrowserWindow({
      width: 1400,
      height: 900,
      show: false,
      webPreferences: {
        preload: path.join(ROOT, "electron/preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    win.webContents.on("console-message", (...args) => {
      try {
        const first = args[0];
        let level;
        let message;
        if (first && typeof first === "object" && "level" in first) {
          level = first.level;
          message = first.message;
        } else {
          level = args[1];
          message = args[2];
        }
        if (level === "error" || level === 3 || level === "3") report.consoleErrors.push(String(message));
      } catch {
        /* 事件形状变化不影响主流程 */
      }
    });
    win.webContents.on("render-process-gone", (_e, details) => {
      report.errors.push("render-process-gone: " + JSON.stringify(details));
    });
    win.webContents.on("did-fail-load", (_e, code, desc) => {
      report.errors.push("did-fail-load: " + code + " " + desc);
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
      resourceSearch: identity.searchService,
      resourcePreview: identity.previewService,
      dialog: stubDialog,
      BrowserWindow,
      isTrusted: (e) => e.sender === win.webContents && e.senderFrame?.url === uiURL,
      send: (event) => {
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("identity:event", event);
      },
    });

    await win.loadURL(uiURL);
    await sleep(400);

    // ── 登录（已初始化，直接走登录页）──────────────────────────────────────
    let g = await waitGate("unauthenticated");
    check("R0 · 进入登录页", g === "unauthenticated", "gate=" + g);
    await setValue('[data-d3-id="login-identifier"]', IDENT);
    await setValue('[data-d3-id="login-password"]', PW);
    await waitEnabled('[data-d3-id="login-submit"]');
    await click('[data-d3-id="login-submit"]');
    g = await waitGate("ready");
    check("R0b · 登录进入桌面", g === "ready", "gate=" + g);

    // ══ 1. 访达（files）═══════════════════════════════════════════════════
    await click('[data-dock-id="files"]');
    const filesOpen = await waitFor('[data-d3-04d="files"]');
    check("F1 · dock「访达」打开真实 Files 页（[data-d3-04d=files]）", filesOpen, "");
    check(
      "F2 · 结构与契约齐全（.split-main > h1 / .split-main > .subtitle / 两个动作按钮 / 列表 / 导出区）",
      (await text(FILES_WIN + " .split-main > h1")) === "文件" &&
        (await text(FILES_WIN + " .split-main > .subtitle")) === FILES_META &&
        (await has("[data-d3-04d-files-import]")) &&
        (await has("[data-d3-04d-files-link]")) &&
        (await has("ul[data-d3-04d-files-items]")) &&
        (await has("[data-d3-04d-files-ref]")) &&
        (await has("[data-d3-04d-files-export]")) &&
        (await has("[data-d3-04d-files-reveal]")),
      "h1=" + (await text(FILES_WIN + " .split-main > h1")) + " subtitle=" + (await text(FILES_WIN + " .split-main > .subtitle")).slice(0, 24),
    );
    check(
      "F3 · 两个动作按钮是真实 ds-btn（primary/secondary）",
      (await attr("[data-d3-04d-files-import]", "data-ds-variant")) === "primary" &&
        (await attr("[data-d3-04d-files-link]", "data-ds-variant")) === "secondary",
      "",
    );
    // 真实 IPC：pickImport 经主进程 dialog 与 ResourceService
    await click("[data-d3-04d-files-import]");
    const added = await waitFor("[data-d3-04d-file]");
    check("F4 · 点「添加到资源库」走真实 resource/pickImport 并出现条目", added && (await count("[data-d3-04d-file]")) === 1, "items=" + (await count("[data-d3-04d-file]")));
    check("F5 · 成功后有 notice、无 error", (await has("[data-d3-04d-files-notice]")) && !(await has("[data-d3-04d-files-error]")), await text("[data-d3-04d-files-notice]"));
    await maximize('[data-d3-04d="files"]');
    await shoot("files.png");

    // ══ 2. 资源库（resource-library）═══════════════════════════════════════
    await click('[data-dock-id="resource-library"]');
    const rlOpen = await waitFor('[data-d3-04a="resource-library"]');
    check("L1 · dock「资源库」打开真实三栏页（data-d3-04a=resource-library + data-d3-04b=app）", rlOpen && (await attr("[data-d3-04b]", "data-d3-04b")) === "app", "");
    check(
      "L2 · 三栏齐备（.rl-nav / .rl-content / .rl-inspector）",
      (await has(".rl-nav")) && (await has(".rl-content")) && (await has(".rl-inspector")),
      "",
    );
    check(
      "L3 · Navigation 含 12 个固定分类 + unfiled + 新建 Collection 动作",
      (await count("[data-d3-04b-nav]")) >= 13 && (await has('[data-d3-04b-nav="trash"]')) && (await has('[data-d3-04b-action="new-collection"]')),
      "nav=" + (await count("[data-d3-04b-nav]")),
    );

    // 基本交互 · 切 view-mode
    await click('[data-d3-04b-view="list"]');
    const listMode = await waitAttr("[data-d3-04b-view-mode]", "data-d3-04b-view-mode", "list");
    check("L4 · 切 view-mode（grid→list）后 data-d3-04b-view-mode=list", listMode, "mode=" + (await attr("[data-d3-04b-view-mode]", "data-d3-04b-view-mode")));
    await click('[data-d3-04b-view="grid"]');
    check("L4b · 切回 grid", await waitAttr("[data-d3-04b-view-mode]", "data-d3-04b-view-mode", "grid"), "");

    // 基本交互 · 点 nav
    await click('[data-d3-04b-nav="memory"]');
    const navMemory = await waitAttr('[data-d3-04b-nav="memory"]', "aria-current", "page");
    check("L5 · 点 nav「Memory」后 aria-current=page", navMemory, "current=" + (await attr('[data-d3-04b-nav="memory"]', "aria-current")));
    await click('[data-d3-04b-nav="all"]');
    check("L5b · 点回 nav「全部」", await waitAttr('[data-d3-04b-nav="all"]', "aria-current", "page"), "");

    // 基本交互 · 新建一条资源
    await click('[data-d3-04b-action="create"]');
    await waitFor("[data-d3-04b-create-name]");
    await setValue("[data-d3-04b-create-name]", "探针记忆");
    await setValue("[data-d3-04b-create-content]", "probe content v1");
    await click('[data-d3-04b-action="create-submit"]');
    const created = await waitFn("Array.from(document.querySelectorAll('[data-d3-04a-item]')).some(function(e){return e.textContent.indexOf('探针记忆')>=0;})");
    check("L6 · 新建资源经真实 resource/create 后出现在列表", created, "");

    // 基本交互 · 打开 inspector
    await js("const els=Array.from(document.querySelectorAll('[data-d3-04a-item]')); const el=els.find(function(e){return e.textContent.indexOf('探针记忆')>=0;}); if(el) el.click(); return el?'ok':'missing';");
    const inspectorOpen = await waitFor("[data-d3-04b-inspector-ref]");
    check("L7 · 点条目打开 inspector（data-d3-04b-inspector-ref + inspector-name）", inspectorOpen && (await text("[data-d3-04b-inspector-name]")) === "探针记忆", "name=" + (await text("[data-d3-04b-inspector-name]")));

    // 编辑形成新版本（供 restore-version 契约）
    await click('[data-d3-04b-action="edit"]');
    await waitFor("[data-d3-04b-editor]");
    await setValue("[data-d3-04b-editor]", "probe content v2");
    await click("[data-d3-04b-save]");
    const versioned = await waitFn("!document.querySelector('[data-d3-04b-editor]') && document.body.innerText.indexOf('v2')>=0");
    check("L8 · 编辑内容保存为新版本（编辑器关闭且 inspector 出现 v2）", versioned, "");
    check("L9 · 版本历史出现 data-d3-04b-restore-version", await waitFor("[data-d3-04b-restore-version]"), "");

    // 加标签（供 data-d3-04b-tag 契约）
    await setValue("[data-d3-04b-tag-input]", "探针标签");
    await click("[data-d3-04b-tag-add]");
    const tagged = await waitFor("[data-d3-04b-tag]");
    check("L10 · 添加标签后导航出现 data-d3-04b-tag", tagged, "");

    // ── 契约全集逐条断言 ─────────────────────────────────────────────────
    for (const name of CONTRACT) {
      const exists = await has("[" + name + "]");
      if (!exists) report.missingContract.push(name);
      check("C · 契约 " + name, exists, exists ? "" : "缺失");
    }

    // ── 三栏截图 ─────────────────────────────────────────────────────────
    await maximize('[data-d3-04a="resource-library"]');
    await sleep(400);
    await shoot("resource-library.png");
    const rects = JSON.parse(
      await js(
        "const q=(s)=>{const el=document.querySelector(s); if(!el) return null; const r=el.getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};}; return JSON.stringify({nav:q('.rl-nav'),content:q('.rl-content'),inspector:q('.rl-inspector')});",
      ),
    );
    if (rects.nav) await shoot("resource-library-nav.png", rects.nav);
    if (rects.content) await shoot("resource-library-content.png", rects.content);
    if (rects.inspector) await shoot("resource-library-inspector.png", rects.inspector);
    check("L11 · 三栏各自可定位并截图（nav / content / inspector）", !!(rects.nav && rects.content && rects.inspector), JSON.stringify(rects));

    // ── 无 console error / 无崩溃 ─────────────────────────────────────────
    await sleep(400);
    check("X1 · 全程没有 console error", report.consoleErrors.length === 0, report.consoleErrors.slice(0, 4).join(" | "));
    check("X2 · 渲染进程没有崩溃 / 加载失败", report.errors.length === 0, report.errors.slice(0, 4).join(" | "));
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
    check("探针整体未抛异常", false, String(e.message).slice(0, 200));
  } finally {
    try {
      win?.destroy();
    } catch {
      /* ignore */
    }
    if (userData) {
      try {
        fs.rmSync(userData, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
