/**
 * Vue「MCP 中心」+「Skill 中心」迁移验收探针（真实 Electron）。
 *
 * 与 experiments/vue-resource/main.cjs 同一手法：主进程自持窗口 + executeJavaScript，
 * 页面是 dist/vue.html，preload 是 electron/preload.cjs，身份与 MCP 装配走
 * electron/identity-bootstrap.cjs 的真实 createIdentityService / mcpService。
 *
 * 覆盖：
 *   · dock 打开 mcp-center → 18 条 data-mcp-* 契约全集逐条断言
 *   · 基本交互：新建对话（含 http 端点提示）→ 真实 mcp/create → 选中详情 →
 *     启用 → 连接（真实握手发现能力与工具）
 *   · 如实呈现"工具调用未开放"：界面无任何调用入口
 *   · dock 打开 skills → 三 tab + 空态文案 + aria-current 随 tab 切换
 *   · 全程无 console error / 无崩溃
 *
 * 需要先 npm run build。本机沙箱起不来时传：
 *   ELECTRON_EXTRA_ARGS="--no-sandbox --disable-gpu-sandbox --in-process-gpu"
 */
const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "../..");
const { createIdentityService, registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));
const { registerMcpIpc } = require(path.join(ROOT, "electron/mcp-bootstrap.cjs"));

const uiURL = pathToFileURL(path.join(ROOT, "dist/vue.html")).href;
const OUT = path.join(ROOT, "artifacts", "vue-mcp");
const IDENT = "vue-mcp@openarc.local";
const PW = "vue-mcp-password-1";
const NAME = "Vue MCP";
const MCP_URL = process.env.OA_VUE_MCP_URL || null;

/** 窗口锚点：产品常驻所有窗口 DOM（不销毁），.split-side / .split-nav / .split-main 这类
    全局查询会跨窗口串味，Skill 中心相关断言一律先锚定到它自己的窗口根。 */
const SKILL_WIN = '.window[aria-label="Skill 中心窗口"]';
const SKILL_NAVSEL = SKILL_WIN + " .split-side .split-nav";
const skillCurrentExpr = (label) =>
  "(function(){var root=document.querySelector(" + JSON.stringify(SKILL_WIN) + "); if(!root) return false; var els=Array.from(root.querySelectorAll('.split-side .split-nav')); var el=els.find(function(e){return e.textContent.indexOf(" + JSON.stringify(label) + ")>=0;}); return !!el && el.getAttribute('aria-current')==='true';})()";

/** 契约全集：grep -oE 'data-mcp-[a-z-]+=' src/mcp/McpCenter.tsx | sort -u */
const CONTRACT = [
  "data-mcp-action",
  "data-mcp-available",
  "data-mcp-capability",
  "data-mcp-center",
  "data-mcp-connection",
  "data-mcp-detail-state",
  "data-mcp-dialog",
  "data-mcp-error-code",
  "data-mcp-field",
  "data-mcp-hint",
  "data-mcp-log-index",
  "data-mcp-log-level",
  "data-mcp-log-result",
  "data-mcp-note",
  "data-mcp-role",
  "data-mcp-status",
  "data-mcp-submit",
  "data-mcp-tool",
];

const report = { checks: [], errors: [], consoleErrors: [], shots: [], versions: {}, missingContract: [] };
const SEEN = new Set();
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: !!ok, detail: String(detail == null ? "" : detail) });
  out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : ""));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win = null;
let userData = null;

const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const text = (sel) => js("return (document.querySelector(" + JSON.stringify(sel) + ") ? document.querySelector(" + JSON.stringify(sel) + ").textContent : '').trim()");
const attr = (sel, name) => js("var el = document.querySelector(" + JSON.stringify(sel) + "); return el ? el.getAttribute(" + JSON.stringify(name) + ") : null");
const count = (sel) => js("return document.querySelectorAll(" + JSON.stringify(sel) + ").length");

const setValue = (sel, value) => js(
  "const el = document.querySelector(" + JSON.stringify(sel) + ");" +
  "if (!el) return 'missing';" +
  "const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;" +
  "const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;" +
  "setter.call(el, " + JSON.stringify(value) + ");" +
  "el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));" +
  "return 'ok';"
);
const click = (sel) => js(
  "const el = document.querySelector(" + JSON.stringify(sel) + ");" +
  "if (!el) return 'missing';" +
  "if (el.disabled) return 'disabled';" +
  "el.click(); return 'ok';"
);
const clickText = (sel, label) => js(
  "const els = Array.from(document.querySelectorAll(" + JSON.stringify(sel) + "));" +
  "const el = els.find(function(e){ return e.textContent.trim().indexOf(" + JSON.stringify(label) + ") >= 0; });" +
  "if (!el) return 'missing'; el.click(); return 'ok';"
);
const navCurrent = (label) => js(
  "const root = document.querySelector(" + JSON.stringify(SKILL_WIN) + ");" +
  "if (!root) return 'missing';" +
  "const els = Array.from(root.querySelectorAll('.split-side .split-nav'));" +
  "const el = els.find(function(e){ return e.textContent.trim().indexOf(" + JSON.stringify(label) + ") >= 0; });" +
  "return el ? (el.getAttribute('aria-current') || null) : 'missing';"
);
const maximize = (sel) => js(
  "const root = document.querySelector(" + JSON.stringify(sel) + ");" +
  "if (!root) return 'missing';" +
  "const w = root.closest('.window');" +
  "if (!w) return 'no-window';" +
  "const btn = w.querySelector('.traffic .maximize');" +
  "if (!btn) return 'no-btn';" +
  "btn.click(); return 'ok';"
);

async function scanContracts() {
  const raw = await js(
    "return JSON.stringify(Array.from(document.querySelectorAll('*')).reduce(function(acc, el){" +
    "for (var i = 0; i < el.attributes.length; i++){ var n = el.attributes[i].name; if (n.indexOf('data-mcp-') === 0) acc[n] = 1; }" +
    "return acc; }, {}));"
  );
  const names = JSON.parse(raw);
  for (const n of Object.keys(names)) SEEN.add(n);
  return names;
}

async function waitGate(want, timeout) {
  const wantList = Array.isArray(want) ? want : [want];
  const t0 = Date.now();
  const limit = timeout || 30000;
  let last = "?";
  while (Date.now() - t0 < limit) {
    try {
      last = await js("return document.querySelector('.desktop') ? document.querySelector('.desktop').getAttribute('data-identity-gate') : 'no-root'");
      if (wantList.includes(last)) return last;
    } catch (e) { /* 导航中 */ }
    await sleep(120);
  }
  return "TIMEOUT(last=" + last + ")";
}
async function waitFor(sel, timeout) {
  const t0 = Date.now();
  const limit = timeout || 12000;
  while (Date.now() - t0 < limit) {
    if (await has(sel)) return true;
    await sleep(60);
  }
  return false;
}
async function waitAttr(sel, name, value, timeout) {
  const t0 = Date.now();
  const limit = timeout || 12000;
  while (Date.now() - t0 < limit) {
    if ((await attr(sel, name)) === value) return true;
    await sleep(60);
  }
  return false;
}
async function waitFn(expr, timeout) {
  const t0 = Date.now();
  const limit = timeout || 12000;
  while (Date.now() - t0 < limit) {
    if (await js("return (" + expr + ")")) return true;
    await sleep(80);
  }
  return false;
}
async function waitEnabled(sel, timeout) {
  const t0 = Date.now();
  const limit = timeout || 8000;
  while (Date.now() - t0 < limit) {
    const disabled = await js("return !!document.querySelector(" + JSON.stringify(sel) + ") && document.querySelector(" + JSON.stringify(sel) + ").disabled");
    if (disabled === false) return true;
    await sleep(80);
  }
  return false;
}

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
    if (!MCP_URL) throw new Error("缺少 OA_VUE_MCP_URL（先启动 tests/fixtures/mcp/echo-server.mjs --http）");

    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-vue-mcp-"));
    const identity = createIdentityService({ userDataDir: userData, safeStorage, allowAdmin: true });
    await identity.store.initialize({ identifier: IDENT, password: PW, displayName: NAME });
    const stubDialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };

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

    win.webContents.on("console-message", function () {
      try {
        const args = Array.prototype.slice.call(arguments);
        const first = args[0];
        let level;
        let message;
        if (first && typeof first === "object" && "level" in first) { level = first.level; message = first.message; }
        else { level = args[1]; message = args[2]; }
        if (level === "error" || level === 3 || level === "3") report.consoleErrors.push(String(message));
      } catch (e) { /* 事件形状变化不影响主流程 */ }
    });
    win.webContents.on("render-process-gone", function (_e, details) { report.errors.push("render-process-gone: " + JSON.stringify(details)); });
    win.webContents.on("did-fail-load", function (_e, code, desc) { report.errors.push("did-fail-load: " + code + " " + desc); });

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
      isTrusted: (e) => e.sender === win.webContents && e.senderFrame && e.senderFrame.url === uiURL,
      send: (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("identity:event", event); },
    });
    registerMcpIpc({
      ipcMain,
      service: identity.mcpService,
      identity: identity.service,
      isTrusted: (e) => e.sender === win.webContents && e.senderFrame && e.senderFrame.url === uiURL,
    });

    await win.loadURL(uiURL);
    await sleep(400);

    // ── 登录 ─────────────────────────────────────────────────────────────
    let g = await waitGate("unauthenticated");
    check("R0 · 进入登录页", g === "unauthenticated", "gate=" + g);
    await setValue('[data-d3-id="login-identifier"]', IDENT);
    await setValue('[data-d3-id="login-password"]', PW);
    await waitEnabled('[data-d3-id="login-submit"]');
    await click('[data-d3-id="login-submit"]');
    g = await waitGate("ready");
    check("R0b · 登录进入桌面", g === "ready", "gate=" + g);

    // ══ 1. MCP 中心 ═══════════════════════════════════════════════════════
    await click('[data-dock-id="mcp-center"]');
    const opened = await waitFor('[data-mcp-center="1"]');
    check("M1 · dock「MCP 中心」打开真实 McpCenter 页（data-mcp-center=1）", opened, "attr=" + (await attr("[data-mcp-center]", "data-mcp-center")));
    const available = await attr("[data-mcp-center]", "data-mcp-available");
    check("M2 · MCP 桥接入（data-mcp-available=true）", available === "true", "available=" + available);

    const empty = await waitFor("[data-mcp-empty]", 15000);
    if (!empty) {
      const ec = await attr("[data-mcp-error]", "data-mcp-error-code");
      check("M3 · 空态（还没有连接 + 新建连接入口）", false, "未进空态，error-code=" + ec);
    } else {
      check(
        "M3 · 空态（还没有连接 + 新建连接入口）",
        (await text(".mcp-empty .ds-page-state__title")) === "还没有连接" && (await has('[data-mcp-empty] [data-mcp-action="create"]')),
        "title=" + (await text(".mcp-empty .ds-page-state__title")),
      );
    }
    await scanContracts();

    await click('[data-mcp-empty] [data-mcp-action="create"]');
    const dialogOpen = await waitFor('[data-mcp-dialog="create"]');
    check("M4 · 新建对话打开（data-mcp-dialog=create）", dialogOpen, "");
    const submitStyle = await js("var el = document.querySelector('[data-mcp-submit]'); if (!el) return 'missing'; var s = getComputedStyle(el); var d = document.querySelector('.desktop'); return JSON.stringify({ text: el.textContent, color: s.color, bg: s.backgroundColor, cls: d ? d.className : null });");
    check("M4b · 新建提交按钮文案与配色", (await text("[data-mcp-submit]")) === "新建", submitStyle);
    await setValue('[data-mcp-field="transport"]', "http");
    const hint = await waitFor('[data-mcp-hint="endpoint"]');
    check("M5 · 切到 http 出现端点提示（data-mcp-hint=endpoint）", hint, "");
    await setValue('[data-mcp-field="location"]', "REMOTE_SERVICE");
    await waitFor('[data-mcp-field="url"]');
    await setValue('[data-mcp-field="name"]', "OpenArc Test Echo");
    await setValue('[data-mcp-field="url"]', MCP_URL);
    await scanContracts();
    await click('[data-mcp-submit="create"]');
    const rowAppear = await waitFor("[data-mcp-connection]", 15000);
    check(
      "M6 · 真实 mcp/create 后列表出现连接行",
      rowAppear,
      rowAppear ? "status=" + (await attr("[data-mcp-connection]", "data-mcp-status")) : "error-code=" + (await attr("[data-mcp-error]", "data-mcp-error-code")),
    );
    await scanContracts();

    await click("[data-mcp-connection]");
    const detailReady = await waitAttr("[data-mcp-detail-state]", "data-mcp-detail-state", "ready", 15000);
    check("M7 · 点连接行打开详情（data-mcp-detail-state=ready）", detailReady, "state=" + (await attr("[data-mcp-detail-state]", "data-mcp-detail-state")));
    await scanContracts();
    check("M7b · 停用提示（data-mcp-note=disabled）", await has('[data-mcp-note="disabled"]'), "");
    check("M7c · 测试日志出现 data-mcp-log-index", await has("[data-mcp-log-index]"), "logs=" + (await count("[data-mcp-log-index]")));

    // 启用
    await click('[data-mcp-action="toggle"]');
    const enabled = await waitFn("document.querySelector('[data-mcp-config-enabled]') && document.querySelector('[data-mcp-config-enabled]').textContent.trim() === '已启用'", 15000);
    check("M8 · 「启用」经真实 mcp/setEnabled 生效", enabled, "enabled=" + (await text("[data-mcp-config-enabled]")));

    // 连接（真实握手）
    await waitFor('[data-mcp-action="connect"]', 8000);
    await click('[data-mcp-action="connect"]');
    const discovered = await waitFor("[data-mcp-tool]", 30000);
    check("M9 · 「连接」做真实握手并发现工具（data-mcp-tool）", discovered, "tools=" + (await count("[data-mcp-tool]")));
    check("M9b · 状态落到 READY（data-mcp-status-text）", (await text("[data-mcp-status-text]")).indexOf("READY") >= 0, "status=" + (await text("[data-mcp-status-text]")));
    check("M10 · 能力表出现 data-mcp-capability", await has("[data-mcp-capability]"), "caps=" + (await count("[data-mcp-capability]")));
    await scanContracts();
    await maximize('[data-mcp-center="1"]');
    await shoot("mcp-list.png");
    const detailRect = JSON.parse(
      await js("var el = document.querySelector('.mcp-detail-pane'); if (!el) return 'null'; var r = el.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)});")
    );
    if (detailRect) await shoot("mcp-detail.png", detailRect);

    // 无工具调用入口：如实呈现"未开放"
    check(
      "M11 · 工具段只发现不调用，界面不存在任何工具调用入口",
      (await text('section[aria-label="工具"] .mcp-section-head .mcp-muted')) === "第一批只发现、不调用" &&
        (await js("return !Array.from(document.querySelectorAll('[data-mcp-action]')).some(function(e){ return /tool|invoke|call/i.test(e.getAttribute('data-mcp-action') || ''); })")),
      "note=" + (await text('section[aria-label="工具"] .mcp-section-head .mcp-muted')),
    );

    // 界面拦截：空名称错误码
    await click('.mcp-pane-head [data-mcp-action="create"]');
    await waitFor('[data-mcp-dialog="create"]');
    await click('[data-mcp-submit="create"]');
    const localErr = await waitAttr("[data-mcp-error]", "data-mcp-error-code", "LOCAL_INPUT_REQUIRED", 8000);
    check("M12 · 空名称在界面先行拦截（data-mcp-error-code=LOCAL_INPUT_REQUIRED）", localErr, "code=" + (await attr("[data-mcp-error]", "data-mcp-error-code")));
    await scanContracts();
    await shoot("mcp-dialog.png");
    await clickText(".dialog-footer .ds-btn", "取消");
    await sleep(200);

    // ── 18 条契约全集逐条断言 ─────────────────────────────────────────────
    for (const name of CONTRACT) {
      const exists = SEEN.has(name);
      if (!exists) report.missingContract.push(name);
      check("C · 契约 " + name, exists, exists ? "" : "缺失");
    }

    // ══ 2. Skill 中心（占位壳）════════════════════════════════════════════
    await click('[data-dock-id="skills"]');
    const skillsOpen = await waitFor(SKILL_NAVSEL);
    check("S1 · dock「Skill 中心」打开占位壳（.split > .split-side + .split-main > .empty-content）", skillsOpen && (await has(SKILL_WIN + " .split-main .empty-content")), "");
    check(
      "S2 · 三 tab（市场 / 我的技能 / 已安装）",
      (await count(SKILL_NAVSEL)) === 3 &&
        (await text(SKILL_NAVSEL + ":nth-of-type(1)")).indexOf("市场") >= 0 &&
        (await text(SKILL_NAVSEL + ":nth-of-type(2)")).indexOf("我的技能") >= 0 &&
        (await text(SKILL_NAVSEL + ":nth-of-type(3)")).indexOf("已安装") >= 0,
      "tabs=" + (await count(SKILL_NAVSEL)),
    );
    check(
      "S3 · 空态文案（h1 Skill 中心 + badge 尚未实现 + 两段说明）",
      (await text(SKILL_WIN + " .split-main .empty-content h1")) === "Skill 中心" &&
        (await text(SKILL_WIN + " .split-main .empty-content .badge")) === "尚未实现" &&
        (await text(SKILL_WIN + " .split-main .empty-content p:nth-of-type(1)")) === "市场、自定义技能、版本与团队分享将在后续阶段接入。" &&
        (await text(SKILL_WIN + " .split-main .empty-content p.muted")) === "当前仅验证桌面窗口生命周期，不显示模拟业务数据。",
      "h1=" + (await text(SKILL_WIN + " .split-main .empty-content h1")) + " badge=" + (await text(SKILL_WIN + " .split-main .empty-content .badge")),
    );
    check(
      "S4 · 初始 aria-current 在市场",
      (await navCurrent("市场")) === "true" && (await navCurrent("我的技能")) === null && (await navCurrent("已安装")) === null,
      "market=" + (await navCurrent("市场")),
    );
    await clickText(SKILL_NAVSEL, "我的技能");
    check(
      "S5 · 切到「我的技能」后 aria-current 正确",
      (await waitFn(skillCurrentExpr("我的技能"))) &&
        (await navCurrent("市场")) === null,
      "mine=" + (await navCurrent("我的技能")),
    );
    await clickText(SKILL_NAVSEL, "已安装");
    check(
      "S6 · 切到「已安装」后 aria-current 正确",
      (await waitFn(skillCurrentExpr("已安装"))),
      "installed=" + (await navCurrent("已安装")),
    );
    await clickText(SKILL_NAVSEL, "市场");
    await waitFn(skillCurrentExpr("市场"));
    await maximize(SKILL_WIN + " .split-side");
    await sleep(400);
    await shoot("skills.png");

    // ── 无 console error / 无崩溃 ─────────────────────────────────────────
    await sleep(400);
    check("X1 · 全程没有 console error", report.consoleErrors.length === 0, report.consoleErrors.slice(0, 4).join(" | "));
    check("X2 · 渲染进程没有崩溃 / 加载失败", report.errors.length === 0, report.errors.slice(0, 4).join(" | "));
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
    check("探针整体未抛异常", false, String(e && e.message).slice(0, 200));
  } finally {
    try { if (win) win.destroy(); } catch (e) { /* ignore */ }
    if (userData) { try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
