/**
 * D2-02B 探针 02 · A13 安全回归（§37 / §38）。
 *
 * A13（PLAN.md）：**不可信网页尝试访问系统桥接 → 无法读取凭据或调用本机执行端。**
 *
 * 这个探针打的是**真实主进程入口**（electron/main.cjs）与**真实 preload**
 * （electron/preload.cjs），不是等价物：它启动产品自己那套窗口 + 桥接，
 * 再去问"到底暴露了什么"。
 *
 * 分两段：
 *   ① 静态面 —— 直接读源码，把"暴露的键"与"注册的 IPC 通道"与**冻结清单**逐字比对。
 *      清单写在探针里：以后谁要扩大暴露面，必须同时改这里，不可能悄悄发生。
 *   ② 运行时 —— 在真实外壳页里枚举 window.openarc；再挂一个不可信 http 视图，
 *      在里面确认桥接与 Node 能力都够不着，并且伪输入被策略挡掉。
 *
 * 关于 D1-05 冻结的那份清单：本阶段**成员数没有扩大**（5 → 5），
 * 但有两处**更名/参数变化**必须被记录下来，而不是含糊地说"没变"：
 *   · layout / browser:layout  →  sync / windows:sync   （多视图需要一次结算多条意图）
 *   · onBrowser / browser:state →  onNativeState / native:state
 *   · navigate / action 增加 windowId 参数（多视图必需；§11 §12）
 * 探针因此同时断言"成员集合等于新清单"与"三条上行通道全部过 trusted()"。
 */
const { BrowserWindow, WebContentsView, session, app } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..", "..");

/** 冻结清单 —— 与 electron/preload.cjs / electron/main.cjs 的现状逐字对应。 */
const FROZEN_BRIDGE_KEYS = ["action", "navigate", "onDisplay", "onNativeState", "sync"];
const FROZEN_IPC_CHANNELS = ["browser:action", "browser:navigate", "windows:sync"];
/** D1-05 冻结的上一版清单，仅用于把"发生了什么变化"讲清楚。 */
const D1_05_BRIDGE_KEYS = ["action", "layout", "navigate", "onBrowser", "onDisplay"];

const sorted = (a) => [...a].sort();

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><meta charset='utf-8'><title>untrusted</title><body>untrusted page</body>",
      );
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const waitFor = async (fn, ms, sleep, label) => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时：" + label);
    await sleep(80);
  }
};

exports.run = async function run({ report, sleep, add, out }) {
  // ─────────────── ① 静态面 ───────────────
  const preloadSrc = fs.readFileSync(path.join(ROOT, "electron", "preload.cjs"), "utf8");
  const mainSrc = fs.readFileSync(path.join(ROOT, "electron", "main.cjs"), "utf8");

  // preload 里 exposeInMainWorld 的键
  const expose = preloadSrc.match(/exposeInMainWorld\(\s*"openarc"\s*,\s*\{([\s\S]*?)\n\}\);/);
  const bridgeKeys = expose
    ? sorted([...expose[1].matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]))
    : [];
  add(
    "sec.bridgeKeysMatchFrozenList",
    JSON.stringify(bridgeKeys) === JSON.stringify(FROZEN_BRIDGE_KEYS),
    `preload 暴露 ${JSON.stringify(bridgeKeys)}；冻结清单 ${JSON.stringify(FROZEN_BRIDGE_KEYS)}`,
  );
  add(
    "sec.bridgeKeysNotExpandedVsD1_05",
    bridgeKeys.length === D1_05_BRIDGE_KEYS.length,
    `D1-05 冻结 ${D1_05_BRIDGE_KEYS.length} 个成员，现在 ${bridgeKeys.length} 个` +
      `（新增 ${JSON.stringify(bridgeKeys.filter((k) => !D1_05_BRIDGE_KEYS.includes(k))) || "[]"}，` +
      `移除 ${JSON.stringify(D1_05_BRIDGE_KEYS.filter((k) => !bridgeKeys.includes(k)))}）`,
  );
  add(
    "sec.bridgeExposesNoRawIpc",
    !/exposeInMainWorld\([^)]*ipcRenderer\b/.test(preloadSrc.replace(/ipcRenderer\.invoke|ipcRenderer\.on|ipcRenderer\.removeListener/g, "")) &&
      !/\b(exposeInMainWorld)\(\s*"electron"/.test(preloadSrc),
    "preload 不得把 ipcRenderer / electron 模块本身暴露出去（只能暴露白名单函数）",
  );

  const channels = sorted([...mainSrc.matchAll(/ipcMain\.handle\(\s*"([^"]+)"/g)].map((m) => m[1]));
  add(
    "sec.ipcChannelsMatchFrozenList",
    JSON.stringify(channels) === JSON.stringify(FROZEN_IPC_CHANNELS),
    `注册的 IPC 通道 ${JSON.stringify(channels)}；冻结清单 ${JSON.stringify(FROZEN_IPC_CHANNELS)}`,
  );
  // 每个 handler 的第一件事都必须是 trusted(e)
  const guarded = [...mainSrc.matchAll(/ipcMain\.handle\(\s*"([^"]+)"\s*,\s*async\s*\(e[^)]*\)\s*=>\s*\{\s*\n\s*if\s*\(!trusted\(e\)\)\s*throw/g)].map(
    (m) => m[1],
  );
  add(
    "sec.everyChannelTrustsSender",
    JSON.stringify(sorted(guarded)) === JSON.stringify(FROZEN_IPC_CHANNELS),
    `过 trusted() 校验的 handler：${JSON.stringify(sorted(guarded))}，应为全部 ${JSON.stringify(FROZEN_IPC_CHANNELS)}`,
  );
  add(
    "sec.shellWebPreferencesHardened",
    /nodeIntegration:\s*false/.test(mainSrc) && /contextIsolation:\s*true/.test(mainSrc) && /sandbox:\s*true/.test(mainSrc),
    "外壳窗口必须 nodeIntegration:false + contextIsolation:true + sandbox:true",
  );

  // ─────────────── ② 运行时（真实主进程） ───────────────
  const uiURL = require("node:url").pathToFileURL(path.join(ROOT, "dist", "index.html")).href;
  require(path.join(ROOT, "electron", "main.cjs"));
  await sleep(300);
  const win = await waitFor(() => BrowserWindow.getAllWindows()[0], 8000, sleep, "外壳窗口");
  await waitFor(() => win.webContents.getURL() === uiURL && !win.webContents.isLoading(), 15000, sleep, "外壳页加载完成");
  out("外壳页已加载：" + win.webContents.getURL());

  const keysInShell = await win.webContents.executeJavaScript("Object.keys(window.openarc || {}).sort()");
  add(
    "sec.runtimeBridgeKeys",
    JSON.stringify(keysInShell) === JSON.stringify(FROZEN_BRIDGE_KEYS),
    `外壳页里 window.openarc 的键 = ${JSON.stringify(keysInShell)}`,
  );
  const leaked = await win.webContents.executeJavaScript(`({
    require: typeof window.require, process: typeof window.process,
    module: typeof window.module, Buffer: typeof window.Buffer,
    ipcRenderer: typeof window.ipcRenderer, electron: typeof window.electron,
    webContents: typeof window.webContents, openarcCtor: typeof window.openarc.constructor
  })`);
  add(
    "sec.shellHasNoNodeOrElectronGlobals",
    ["require", "process", "module", "ipcRenderer", "electron", "webContents"].every((k) => leaked[k] === "undefined"),
    `探测结果 ${JSON.stringify(leaked)}（除 openarcCtor 外都应是 undefined）`,
  );

  // 不可信视图：真实控制器用的就是这套 webPreferences（session 分区 + 关 Node 能力）
  const { server, port } = await serve();
  const untrusted = new WebContentsView({
    webPreferences: { session: session.fromPartition("openarc-sec-probe"), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  win.contentView.addChildView(untrusted);
  untrusted.setBounds({ x: 10, y: 10, width: 400, height: 300 });
  await untrusted.webContents.loadURL(`http://127.0.0.1:${port}/untrusted`);

  const inView = await untrusted.webContents.executeJavaScript(`({
    openarc: typeof window.openarc, require: typeof window.require,
    process: typeof window.process, Buffer: typeof window.Buffer,
    canInvoke: (() => { try { return typeof (window.openarc && window.openarc.sync); } catch (e) { return "throw:" + e.name; } })()
  })`);
  add(
    "sec.untrustedViewCannotSeeBridge",
    inView.openarc === "undefined" && inView.canInvoke === "undefined",
    `不可信视图内 window.openarc=${inView.openarc}、openarc.sync=${inView.canInvoke}（A13 核心断言）`,
  );
  add(
    "sec.untrustedViewHasNoNodeGlobals",
    inView.require === "undefined" && inView.process === "undefined" && inView.Buffer === "undefined",
    `不可信视图内 require=${inView.require} process=${inView.process} Buffer=${inView.Buffer}`,
  );
  const wp = untrusted.webContents.getLastWebPreferences() || {};
  add(
    "sec.untrustedViewWebPreferences",
    wp.nodeIntegration === false && wp.contextIsolation === true && wp.sandbox === true,
    `视图 webPreferences: nodeIntegration=${wp.nodeIntegration} contextIsolation=${wp.contextIsolation} sandbox=${wp.sandbox}`,
  );

  // ─────────────── ③ 伪输入必须被策略挡掉（仍在外壳页里发，走真实 IPC） ───────────────
  const badNavigate = await win.webContents.executeJavaScript(`(async () => {
    const cases = ["javascript:alert(1)", "file:///etc/passwd", "https://user:pass@example.com/", "data:text/html,<b>x</b>"];
    const out = [];
    for (const url of cases) out.push({ url, res: await window.openarc.navigate("ghost", url) });
    return out;
  })()`);
  add(
    "sec.policyRejectsNonHttpAndCredentialed",
    badNavigate.every((c) => c.res && c.res.error && !c.res.ok),
    `伪 URL 结果：${JSON.stringify(badNavigate.map((c) => [c.url.slice(0, 32), !!(c.res && c.res.error)]))}`,
  );

  const badAction = await win.webContents.executeJavaScript(`window.openarc.action("ghost", "exec")`);
  add(
    "sec.actionRejectsUnknownTarget",
    !!badAction && !!badAction.error,
    `对不存在窗口发 action("exec")：${JSON.stringify(badAction)}`,
  );

  const tooMany = await win.webContents.executeJavaScript(
    `window.openarc.sync({ intents: Array.from({ length: 64 }, (_, i) => ({ windowId: "w" + i, url: "https://example.com", present: true, viewport: { x: 0, y: 0, width: 100, height: 100 }, occluders: [] })) })`,
  );
  add(
    "sec.syncRejectsOversizedBatch",
    !!tooMany && !!tooMany.error,
    `一次投递 64 条意图（上限 32）：${JSON.stringify(tooMany)}`,
  );

  const syncOk = await win.webContents.executeJavaScript(`window.openarc.sync({ intents: [] })`);
  add(
    "sec.syncStillWorksForShell",
    !!syncOk && syncOk.ok === true,
    `外壳页合法调用仍应成功：${JSON.stringify(syncOk && { ok: syncOk.ok, results: (syncOk.results || []).length })}`,
  );

  win.contentView.removeChildView(untrusted);
  untrusted.webContents.close();
  server.close();
  report.note =
    `D1-05 冻结的桥接面 ${JSON.stringify(D1_05_BRIDGE_KEYS)} → 现在 ${JSON.stringify(bridgeKeys)}：` +
    "成员数未扩大；layout→sync、onBrowser→onNativeState 为更名，navigate/action 增加 windowId 为多视图必需。";
  return report;
};
