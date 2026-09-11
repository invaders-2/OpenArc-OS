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
 * **D3-04 变更（2026-09-12，显式登记）**：暴露面 6 → 7，新增 `files` 与通道
 *   `files:import` / `files:list` / `files:rename` / `files:remove`。
 *   新增内容 = `pathFor(file)`（Electron 44 起 File.path 已移除，必须由 webUtils 换路径）、
 *   `import(folderId, paths)`（**拷贝进** userData/files/<folderId>/）、`list` / `rename` / `remove`。
 *   **没有**暴露 fs / path / shell，也没有任意路径读取：folderId 白名单与固定根目录在
 *   electron/file-service.cjs 里收口，渲染进程只拿到条目索引（不含磁盘路径）。
 *
 * **D3-01 变更（2026-09-11，显式登记）**：暴露面 5 → 6，新增 `identity`
 * 与通道 `identity:command`。
 *   新增内容 = **两个方法**：`identity.command(cmd)` 派发领域命令、
 *   `identity.onEvent(cb)` 订阅身份事件。**没有**任何读 token 的口子 ——
 *   渲染进程因此不可能把 session token 写进 localStorage（D3-01 §10 / §11）。
 *   也没有新增 fs / shell / webContents / BrowserWindow 之类的能力。
 * 清单随之前移：现在的"上一版基线"是 D2-02 自己的 5 个成员。
 */
const { BrowserWindow, WebContentsView, session, app } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..", "..");

/** 冻结清单 —— 与 electron/preload.cjs 的现状逐字对应（D3-01 后为 6 个）。 */
const FROZEN_BRIDGE_KEYS = ["action", "files", "identity", "navigate", "onDisplay", "onNativeState", "sync"];
/**
 * 冻结的 IPC 通道。
 *
 * 注意扫描范围：`identity:command` 注册在 **electron/identity-bootstrap.cjs**
 * （与 UI 探针共用同一份装配），不在 main.cjs 里。只扫 main.cjs 会漏掉它，
 * 等于"新增通道不再受这条断言约束"——因此两个文件都要扫。
 */
const FROZEN_IPC_CHANNELS = [
  "browser:action",
  "browser:navigate",
  "files:copy",
  "files:export",
  "files:import",
  "files:list",
  "files:move",
  "files:read",
  "files:remove",
  "files:rename",
  "files:thumb",
  "identity:command",
  "windows:sync",
];
const IPC_SCAN_FILES = ["main.cjs", "identity-bootstrap.cjs"];
/** D2-02 冻结的上一版清单（5 个），用于把"发生了什么变化"讲清楚。 */
const PREV_BRIDGE_KEYS = ["action", "navigate", "onDisplay", "onNativeState", "sync"];
/** D1-05 冻结的再上一版，仅作历史留痕。 */
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
  // 暴露面的每一次扩张都必须在这里**显式登记**（D3-01 identity、D3-04 files）。
  // 断言的是"新增的键恰好是登记过的这两个、且 D2-02 的键一个没少"，
  // 因此任何未经登记的扩张都会让这条 FAIL。
  const REGISTERED_EXPANSIONS = ["files", "identity"];
  add(
    "sec.bridgeExpansionRegistered",
    REGISTERED_EXPANSIONS.every((k) => bridgeKeys.includes(k)) &&
      bridgeKeys.filter((k) => !PREV_BRIDGE_KEYS.includes(k)).sort().join() === REGISTERED_EXPANSIONS.join() &&
      PREV_BRIDGE_KEYS.every((k) => bridgeKeys.includes(k)),
    `D2-02 冻结 ${PREV_BRIDGE_KEYS.length} 个成员，现在 ${bridgeKeys.length} 个` +
      `（新增 ${JSON.stringify(bridgeKeys.filter((k) => !PREV_BRIDGE_KEYS.includes(k)).sort())}，` +
      `登记为 ${JSON.stringify(REGISTERED_EXPANSIONS)}；` +
      `移除 ${JSON.stringify(PREV_BRIDGE_KEYS.filter((k) => !bridgeKeys.includes(k)))}）`,
  );
  add(
    "sec.bridgeExposesNoRawIpc",
    !/exposeInMainWorld\([^)]*ipcRenderer\b/.test(preloadSrc.replace(/ipcRenderer\.invoke|ipcRenderer\.on|ipcRenderer\.removeListener/g, "")) &&
      !/\b(exposeInMainWorld)\(\s*"electron"/.test(preloadSrc),
    "preload 不得把 ipcRenderer / electron 模块本身暴露出去（只能暴露白名单函数）",
  );

  // 通道扫描覆盖 main.cjs **与 identity-bootstrap.cjs** —— 后者注册了 identity:command
  const ipcSrc = IPC_SCAN_FILES.map((f) => fs.readFileSync(path.join(ROOT, "electron", f), "utf8")).join("\n");
  const channels = sorted([...ipcSrc.matchAll(/ipcMain\.handle\(\s*"([^"]+)"/g)].map((m) => m[1]));
  add(
    "sec.ipcChannelsMatchFrozenList",
    JSON.stringify(channels) === JSON.stringify(FROZEN_IPC_CHANNELS),
    `注册的 IPC 通道 ${JSON.stringify(channels)}；冻结清单 ${JSON.stringify(FROZEN_IPC_CHANNELS)}`,
  );
  // 每个 handler 的第一件事都必须是信任校验。
  // 两条写法都要认：`!trusted(e)`（main.cjs）与 `isTrusted && !isTrusted(e)`（bootstrap，
  // 因为信任判据由调用方注入）。判据取"handler 开头 240 字符内出现 trusted(e)"。
  // 注意：这里**不能**让匹配本身吃掉后面 240 个字符 —— matchAll 是不重叠的，
  // 一旦吃掉，紧挨着的下一个 handler（比如 files:* 这组短 handler）会被整段跳过，
  // 表现为"明明写了 trusted(e) 却判 FAIL"。改为记住位置、用 slice 看窗口。
  const guarded = sorted(
    [...ipcSrc.matchAll(/ipcMain\.handle\(\s*"([^"]+)"/g)]
      .filter((m) => /trusted\(e\)|isTrusted\(e\)/.test(ipcSrc.slice(m.index, m.index + 260)))
      .map((m) => m[1]),
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
