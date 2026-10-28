/**
 * Windows 自绘 caption（方案 B）· 离线契约测试（不启动 Electron、不新增依赖）。
 *
 * 覆盖四件事：
 *   1) preload 真实暴露的 windowControl：成员集合、上行通道 / 动作、下行订阅与退订；
 *   2) main.cjs 的 window:control：trusted 边界、冻结动作白名单、关闭与既有路径等价、
 *      状态推送事件集合；
 *   3) OA_FORCE_PLATFORM 只影响「窗口 chrome + 上报平台」，不碰菜单角色 / 玻璃材质；
 *      不设置时等于真实平台（生产默认不变）；
 *   4) TopBar.vue 编译产物与 styles.css 契约：只有 isWin 才渲染三枚按钮、
 *      46×38 满高、hover 6%、close 红、焦点环、减少动态。
 *
 * 真实 Electron 里的点击 / 截图证据在 experiments/dxos-win-titlebar/run.mjs，
 * 本文件只锁静态与桥接契约（两层证据互补，互不替代）。
 *
 * 运行：node --test tests/win-titlebar.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const requireFromRoot = createRequire(path.join(ROOT, "package.json"));
const PRELOAD_PATH = path.join(ROOT, "electron", "preload.cjs");
const MAIN_PATH = path.join(ROOT, "electron", "main.cjs");
const WINDOW_IPC_PATH = path.join(ROOT, "electron", "window-browser-ipc.cjs");
const LIFECYCLE_PATH = path.join(ROOT, "electron", "app-lifecycle.cjs");
const FILES_IPC_PATH = path.join(ROOT, "electron", "files-ipc.cjs");
const TOPBAR_PATH = path.join(ROOT, "src-vue", "shell", "TopBar.vue");
const STYLES_PATH = path.join(ROOT, "src", "styles.css");
const TYPES_PATH = path.join(ROOT, "src", "types", "openarc-ipc.d.ts");
const VUE_TYPES_PATH = path.join(ROOT, "src-vue", "env.d.ts");

/** 在 vm 沙箱里执行真实 preload.cjs（假 electron），返回 contextBridge 真实暴露的 openarc 对象。 */
function loadExposedPreload() {
  const source = fs.readFileSync(PRELOAD_PATH, "utf8");
  const exposed = {};
  const calls = { invoke: [], on: [], removeListener: [] };
  const listeners = new Map();
  const ipcRenderer = {
    invoke: (...args) => { calls.invoke.push(args); return Promise.resolve({ ok: true, value: {} }); },
    on: (channel, listener) => { calls.on.push([channel, listener]); listeners.set(channel, listener); },
    removeListener: (channel, listener) => { calls.removeListener.push([channel, listener]); listeners.delete(channel); },
    send: (...args) => calls.push(["send", args]),
  };
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer,
    webUtils: { getPathForFile: () => "" },
  };
  const sandboxRequire = (id) => (id === "electron" ? electron : requireFromRoot(id));
  const moduleShim = { exports: {} };
  const context = vm.createContext({
    require: sandboxRequire,
    module: moduleShim,
    exports: moduleShim.exports,
    console,
    process,
    __dirname: path.dirname(PRELOAD_PATH),
    __filename: PRELOAD_PATH,
  });
  vm.runInContext(source, context, { filename: PRELOAD_PATH });
  return { api: exposed.openarc, calls, listeners };
}

const WINDOW_MEMBERS = ["state", "minimize", "toggleMaximize", "close", "onStateChange"];

test("preload · windowControl 追加在既有键之后（之后只有 chat），且只有五个成员", () => {
  const { api } = loadExposedPreload();
  const keys = Object.keys(api);
  assert.equal(keys.length, 43, "顶层键必须恰为 43（当前 " + keys.length + "）");
  assert.equal(keys.indexOf("windowControl"), 41, "windowControl 必须追加在末尾，前面键序不变");
  assert.deepEqual(keys.slice(42), ["chat"], "windowControl 之后只追加了全局 AI 对话键");
  assert.deepEqual(Object.keys(api.windowControl).sort(), WINDOW_MEMBERS.slice().sort(), "成员集合必须逐字一致");
  for (const member of WINDOW_MEMBERS) {
    assert.equal(typeof api.windowControl[member], "function", "windowControl." + member + " 必须是函数");
  }
  assert.deepEqual(
    ["ipcRenderer", "webContents", "BrowserWindow", "require", "process"].filter((k) => k in api.windowControl),
    [],
    "桥面不得暴露原始能力",
  );
});

test("preload · 四个动作只走 window:control，动作名逐字一致", async () => {
  const { api, calls } = loadExposedPreload();
  await api.windowControl.state();
  await api.windowControl.minimize();
  await api.windowControl.toggleMaximize();
  await api.windowControl.close();
  // 只取通道 + action 的字符串投影：vm 里创建的对象跨 realm，直接 deepEqual 会因原型不同而失败。
  assert.deepEqual(
    calls.invoke.map(([channel, payload]) => [String(channel), String(payload && payload.action)]),
    [
      ["window:control", "state"],
      ["window:control", "minimize"],
      ["window:control", "toggleMaximize"],
      ["window:control", "close"],
    ],
    "动作必须逐一对应 window:control 的 payload.action",
  );
});

test("preload · 状态订阅走 window:state，且能原样退订", () => {
  const { api, calls, listeners } = loadExposedPreload();
  const seen = [];
  const off = api.windowControl.onStateChange((state) => seen.push(state));
  assert.equal(typeof off, "function", "onStateChange 必须返回退订函数");
  assert.deepEqual(calls.on.map((c) => c[0]), ["window:state"], "订阅通道必须是 window:state");
  const listener = listeners.get("window:state");
  assert.equal(typeof listener, "function");
  listener({}, { maximized: true, fullScreen: false, minimized: false, focused: true });
  assert.deepEqual(seen, [{ maximized: true, fullScreen: false, minimized: false, focused: true }]);
  off();
  assert.deepEqual(calls.removeListener.map((c) => c[0]), ["window:state"], "退订必须移除同一个通道");
  assert.equal(calls.removeListener[0][1], listener, "退订必须移除同一个监听器");
});

/** 从 main.cjs 里截出 window:control 的 handler 源码（到该 handle 调用结束）。 */
function windowControlHandlerSource() {
  const source = fs.readFileSync(WINDOW_IPC_PATH, "utf8");
  const at = source.indexOf('ipcMain.handle("window:control"');
  assert.ok(at > 0, "main.cjs 必须注册 window:control");
  const end = source.indexOf("\n  });", at);
  assert.ok(end > at, "找不到 window:control handler 的结束位置");
  return source.slice(at, end + 6);
}

test("window IPC · window:control 过 trusted 且动作是冻结白名单", () => {
  const handler = windowControlHandlerSource();
  assert.match(handler, /if \(!trusted\((?:event|e)\)\) throw Error\("Forbidden"\);/, "第一道必须用当前事件做 trusted 校验并返回 Forbidden");
  assert.match(handler, /WINDOW_CONTROL_ACTIONS\.includes\(action\)/, "动作必须走白名单校验");
  assert.match(handler, /WINDOW_CONTROL_UNKNOWN_ACTION/, "未知动作必须返回稳定错误码");
  assert.match(handler, /WINDOW_CONTROL_UNAVAILABLE/, "窗口不可用必须返回稳定错误码");
  const source = fs.readFileSync(WINDOW_IPC_PATH, "utf8");
  assert.ok(
    source.includes('const WINDOW_CONTROL_ACTIONS = Object.freeze(["state", "minimize", "toggleMaximize", "close"]);'),
    "动作白名单必须冻结且恰为四项",
  );
});

test("main · 关闭与既有路径完全等价：win.close()，没有 close 拦截 / 确认框", () => {
  const handler = windowControlHandlerSource();
  assert.match(handler, /win\.close\(\)/, "关闭必须调 win.close()");
  assert.doesNotMatch(handler, /preventDefault|dialog|confirm|showMessageBox/, "关闭路径不得引入拦截 / 确认框");
  const source = fs.readFileSync(WINDOW_IPC_PATH, "utf8");
  assert.doesNotMatch(source, /win\.on\(\s*["']close["']/, "main.cjs 不得监听 close 并拦截");
  const lifecycle = fs.readFileSync(LIFECYCLE_PATH, "utf8");
  assert.match(lifecycle, /win\.on\("closed", \(\) => \{/, "既有的 closed 清理路径必须保留");
  assert.match(lifecycle, /app\.on\("window-all-closed", \(\) => app\.quit\(\)\);/, "关闭后仍走既有退出路径");
});

test("window IPC · 最大化 / 全屏 / 最小化 / 焦点变化都主动推 window:state", () => {
  const source = fs.readFileSync(WINDOW_IPC_PATH, "utf8");
  assert.match(source, /win\.webContents\.send\("window:state", state\)/, "状态必须经 window:state 下行");
  const events = source.match(/for \(const event of \[([^\]]+)\]\)\s*\{\s*win\.on\(event, pushWindowState\);/);
  assert.ok(events, "必须订阅窗口事件并推状态");
  const names = events[1].split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean);
  for (const required of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen", "minimize", "restore", "focus", "blur"]) {
    assert.ok(names.includes(required), "缺少窗口状态事件 " + required);
  }
});

/** 用真实 main.cjs 源码片段跑平台覆盖判定（不是复制一份逻辑）。 */
function loadPlatformConstants(platform, env) {
  const source = fs.readFileSync(MAIN_PATH, "utf8");
  const start = source.indexOf('const isMac = process.platform === "darwin";');
  const end = source.indexOf("const glass = isMac", start);
  assert.ok(start > 0 && end > start, "找不到平台常量段落");
  const warns = [];
  const sandbox = {
    process: { platform, env },
    console: { warn: (line) => warns.push(String(line)), log: () => {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    source.slice(start, end) + "\n;globalThis.__platform = { isMac, FORCED_PLATFORM, uiPlatform, isMacChrome };",
    sandbox,
    { filename: "main.cjs#platform" },
  );
  return { ...sandbox.__platform, warns };
}

test("main · OA_FORCE_PLATFORM 只影响 chrome 与上报平台，不设置时等于真实平台", () => {
  const real = loadPlatformConstants("darwin", {});
  assert.deepEqual(
    { isMac: real.isMac, forced: real.FORCED_PLATFORM, ui: real.uiPlatform, macChrome: real.isMacChrome, warns: real.warns.length },
    { isMac: true, forced: "", ui: "darwin", macChrome: true, warns: 0 },
    "生产默认（不设变量）必须逐项等于真实平台，且不产生任何告警",
  );

  const forcedWin = loadPlatformConstants("darwin", { OA_FORCE_PLATFORM: "win32" });
  assert.equal(forcedWin.uiPlatform, "win32", "覆盖后上报平台为 win32");
  assert.equal(forcedWin.isMacChrome, false, "覆盖后窗口 chrome 走 Windows 分支");
  assert.equal(forcedWin.isMac, true, "应用菜单角色仍跟随真实 OS（macOS）");
  assert.equal(forcedWin.warns.length, 1, "测试覆盖必须留下一条可见告警");

  const forcedMac = loadPlatformConstants("linux", { OA_FORCE_PLATFORM: "darwin" });
  assert.equal(forcedMac.uiPlatform, "darwin");
  assert.equal(forcedMac.isMacChrome, true);
  assert.equal(forcedMac.isMac, false, "非 macOS 宿主上覆盖为 darwin 也不改菜单角色");

  const bogus = loadPlatformConstants("linux", { OA_FORCE_PLATFORM: "linux" });
  assert.equal(bogus.FORCED_PLATFORM, "", "非 win32 / darwin 的值必须忽略");
  assert.equal(bogus.uiPlatform, "linux");
  assert.equal(bogus.warns.length, 0, "非法值不得改变生产行为");

  const source = fs.readFileSync(MAIN_PATH, "utf8");
  assert.equal((source.match(/process\.env\.OA_FORCE_PLATFORM/g) || []).length, 3, "OA_FORCE_PLATFORM 只允许在两个字面值判定与三元的取值处读取");
  const filesIpc = fs.readFileSync(FILES_IPC_PATH, "utf8");
  assert.match(filesIpc, /platform: uiPlatform,/, "system:info 必须上报覆盖后的平台");
  assert.doesNotMatch(filesIpc, /platform: process\.platform,/, "system:info 不得再直接上报真实平台（否则测试覆盖无效）");
  const lifecycle = fs.readFileSync(LIFECYCLE_PATH, "utf8");
  assert.match(lifecycle, /\.\.\.\(isMacChrome/, "窗口 chrome 必须走 isMacChrome");
  assert.match(lifecycle, /titleBarStyle: "hidden", trafficLightPosition: \{ x: 20, y: 12 \}/, "macOS 红绿灯位置必须逐字不变");
  assert.match(source, /const glass = isMac/, "玻璃材质必须仍按真实平台（mica 只有 Windows 有）");
  const menuAt = lifecycle.indexOf("function installApplicationMenu(");
  const menuBody = lifecycle.slice(menuAt, menuAt + 600);
  assert.match(menuBody, /isMac \? \{ role: "appMenu" \}/, "应用菜单角色必须仍按真实 isMac");
});

function sfcParts() {
  const { parse, compileScript, compileTemplate } = requireFromRoot("@vue/compiler-sfc");
  const filename = TOPBAR_PATH;
  const source = fs.readFileSync(filename, "utf8");
  const parsed = parse(source, { filename });
  assert.deepEqual(parsed.errors, [], "TopBar.vue 必须是合法 SFC");
  const script = compileScript(parsed.descriptor, { id: "topbar-win-test" });
  assert.ok(script.content.includes("windowControl"), "脚本必须接 windowControl 桥");
  const template = compileTemplate({
    source: parsed.descriptor.template.content,
    filename,
    id: "topbar-win-test",
    compilerOptions: { bindingMetadata: script.bindings },
  });
  assert.deepEqual(template.errors, [], "TopBar.vue 模板必须能编译");
  return { ast: template.ast, code: template.code, script: script.content };
}

function walk(node, visit) {
  if (!node) return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
  // v-if 的编译产物是 IfNode（type 9）：元素在 branches[].children 里。
  for (const branch of node.branches || []) for (const child of branch.children || []) walk(child, visit);
}

test("TopBar · 编译产物只有 isWin 分支渲染三枚 caption（darwin 不渲染）", () => {
  const { ast } = sfcParts();
  const elements = [];
  walk(ast, (node) => { if (node.type === 1) elements.push(node); });

  const header = elements.find((el) => el.tag === "header" && el.props.some((p) => p.type === 6 && p.name === "class" && p.value && p.value.content === "topbar"));
  assert.ok(header, "必须仍是一个 .topbar <header>");
  const exprSource = (prop) => String((prop.exp && ((prop.exp.loc && prop.exp.loc.source) || prop.exp.content)) || "");
  const headerClassBind = header.props.find((p) => p.type === 7 && p.name === "bind" && p.arg && p.arg.content === "class");
  assert.ok(headerClassBind, "header 必须有动态 class");
  assert.match(exprSource(headerClassBind), /is-win/, "Windows 修饰类必须是 is-win");

  const caption = elements.find((el) => el.props.some((p) => p.type === 6 && p.name === "class" && p.value && String(p.value.content).includes("topbar-caption")));
  assert.ok(caption, "必须有 .topbar-caption 容器");

  // v-if 编译成 IfNode（type 9）；条件在 branch.condition 上，不在元素 props 里。
  let captionCondition = null;
  walk(ast, (node) => {
    if (node.type !== 9 || !node.branches) return;
    for (const branch of node.branches) {
      let hit = false;
      for (const child of branch.children || []) walk(child, (n) => { if (n === caption) hit = true; });
      if (hit) captionCondition = branch.condition ? String((branch.condition.loc && branch.condition.loc.source) || branch.condition.content || "") : null;
    }
  });
  assert.equal(String(captionCondition || "").trim(), "isWin", "caption 容器只能在 isWin 时渲染");

  const buttons = elements.filter((el) => el.tag === "button" && el.props.some((p) => p.type === 6 && p.name === "data-caption"));
  assert.equal(buttons.length, 3, "必须恰有三枚 caption 按钮");
  const roles = buttons.map((el) => el.props.find((p) => p.type === 6 && p.name === "data-caption").value.content).sort();
  assert.deepEqual(roles, ["close", "maximize", "minimize"], "按钮必须是最小化 / 最大化 / 关闭");
  for (const el of buttons) {
    const label = el.props.find((p) => p.type === 6 && p.name === "aria-label");
    const labelBind = el.props.find((p) => p.type === 7 && p.name === "bind" && p.arg && p.arg.content === "aria-label");
    assert.ok(label || labelBind, "每枚 caption 必须有可访问名称");
  }
  const max = buttons.find((el) => el.props.find((p) => p.type === 6 && p.name === "data-caption").value.content === "maximize");
  const maxLabel = max.props.find((p) => p.type === 7 && p.name === "bind" && p.arg && p.arg.content === "aria-label");
  assert.ok(maxLabel && /maxed/.test(exprSource(maxLabel)) && /还原/.test(exprSource(maxLabel)), "最大化按钮的可访问名称必须随状态切换为「还原」");
  assert.ok(caption.children.some((c) => c.type === 1 && c.tag === "button"), "三枚按钮必须在 caption 容器内");
});

test("styles · 46×38 满高、hover 6%、close 红、焦点环、减少动态", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");
  const blockOf = (selector, mustInclude) => {
    let at = css.indexOf("\n" + selector + " {");
    while (at >= 0) {
      const end = css.indexOf("}", at);
      const body = css.slice(at, end + 1);
      if (!mustInclude || body.includes(mustInclude)) return body;
      at = css.indexOf("\n" + selector + " {", at + 1);
    }
    assert.fail("缺少规则 " + selector + (mustInclude ? "（且包含 " + mustInclude + "）" : ""));
  };
  const block = (selector) => blockOf(selector);

  const base = block(".topbar");
  assert.match(base, /height: 38px/, "顶栏仍必须是 38px");
  assert.match(base, /padding: 0 23px 0 92px/, "macOS 红绿灯预留（92px）必须逐字保留");
  assert.match(base, /-webkit-app-region: drag/, "顶栏仍必须整条可拖动");

  const win = block(".topbar.is-win");
  assert.match(win, /padding: 0 0 0 16px/, "Windows 左侧必须从 16px 起（取消红绿灯预留）");
  assert.match(win, /gap: 0/, "Windows 顶栏不得再用 26px gap 推开 caption");
  assert.match(win, /--caption-close: #c42b1c/, "close hover 必须是 Windows caption 红");
  assert.match(win, /--caption-close-active: #b32a1c/, "close 按下必须更深一档");

  const caption = block(".topbar.is-win .bar-caption");
  assert.match(caption, /width: 46px/, "按钮宽必须 46px");
  assert.match(caption, /height: 100%/, "按钮高必须满高（顶栏 38px）");
  assert.match(caption, /border-radius: 0/, "caption 必须直角");
  assert.match(caption, /background var\(--dur-feedback\)/, "transition 必须走 --dur-feedback（减少动态下 0ms）");

  assert.match(blockOf(".topbar.is-win .bar-caption:hover", "background"), /rgb\(var\(--text-rgb\) \/ 0\.06\)/, "hover 必须是 6% 中性底色");
  assert.match(blockOf(".topbar.is-win .bar-caption:active", "background"), /rgb\(var\(--text-rgb\) \/ 0\.1\)/, "按下必须是 10% 中性底色");
  const closeAt = css.indexOf(".topbar.is-win .bar-caption.caption-close:hover,");
  assert.ok(closeAt >= 0, "缺少 close hover / 按下规则");
  const closeHover = css.slice(closeAt, css.indexOf("}", closeAt) + 1);
  assert.match(closeHover, /background: var\(--caption-close\)/, "close hover 必须用 caption 红做底");
  assert.match(closeHover, /color: #ffffff/, "close hover 必须是白字形");
  const focus = block(".topbar.is-win .bar-caption:focus-visible");
  assert.match(focus, /outline: 2px solid var\(--focus\)/, "焦点环必须是 2px 中性色");
  assert.match(focus, /outline-offset: -4px/, "满高按钮的焦点环必须收在窗口内侧（2px 环 + 2px 间隔）");
});

test("types · openarc-ipc.d.ts 与 env.d.ts 都登记了 windowControl，且成员一致", () => {
  const types = fs.readFileSync(TYPES_PATH, "utf8");
  assert.match(types, /windowControl\?: OpenArcWindowControlBridge;/, "共享类型必须登记 windowControl");
  const iface = types.slice(types.indexOf("export interface OpenArcWindowControlBridge"), types.indexOf("export interface OpenArcWindowControlBridge") + 700);
  for (const member of ["state", "minimize", "toggleMaximize", "close", "onStateChange"]) {
    assert.ok(iface.includes(member + ":"), "共享类型缺少 " + member);
  }
  assert.match(types, /window:state/, "类型注释必须说明 window:state 下行");
  const vueTypes = fs.readFileSync(VUE_TYPES_PATH, "utf8");
  assert.match(vueTypes, /windowControl\?: OpenArcWindowControlBridge;/, "Vue 壳类型必须登记 windowControl");
  assert.ok(vueTypes.includes("OpenArcWindowState"), "Vue 壳类型必须声明窗口状态形状");
});
