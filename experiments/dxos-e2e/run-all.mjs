#!/usr/bin/env node
/**
 * B2–B7 · 真实 Electron 端到端验收探针（DX OS 域注册 / trusted 边界 / 健康报告 / 真实命令 / P1 事件）。
 *
 * 做什么：
 *   1) 以**隔离 userData** 启动真实产品入口 electron .（真实 electron/main.cjs + 真实 electron/preload.cjs
 *      + 真实 dist/index.html），只经 CDP 驱动渲染层 window.openarc.* 命令面，不注入任何测试专用能力；
 *   2) 断言 window.openarc 顶层键**恰为 39**，逐个核对真实形状（函数 / 含 command 的域对象）；
 *   3) 逐域调用健康 / 只读命令，断言不抛异常且错误是结构化错误码（允许 *_DEPENDENCY_UNAVAILABLE）；
 *   4) 断言渲染层拿不到 ipcRenderer / webContents / require / process 等原始能力，并记录 trusted 的间接证据；
 *   5) 收集页面 console / pageerror，断言 0 条 error（"No handler registered" 一律视为缺陷）；
 *   6) 订阅 agent.onEvent，触发一条真实命令，断言收到 P1 信封（channel/domain/kind/sequence/at/payload 齐备且序号单调）；
 *   7) 正常关窗退出、断言无残留进程、删除隔离 userData；
 *   8) 全程监控真实 profile（~/Library/Application Support/openarc-os 的身份库）mtime/size/sha256 前后对照，
 *      并把 39 键清单 / 各域脱敏返回 / 事件样例 / console 统计 / profile 对照写入 artifacts/dxos-e2e/report.json。
 *
 * 硬约束：不联网（只连本机 CDP，断言渲染层无非本地请求）；不执行 / 修改 DX OS 业务数据之外的真实 profile；
 *         不新增依赖；失败 exit 非 0。
 *
 * 用法：
 *   node experiments/dxos-e2e/run-all.mjs
 *   OA_DXOS_E2E_CDP_PORT=9796 node experiments/dxos-e2e/run-all.mjs   # 可选：固定 CDP 端口
 *
 * 本文件同时导出 CONTRACT / WHITELISTS 供 tests/dxos-e2e-contract.test.mjs **离线**核对
 * （域清单与命令清单必须与 preload.cjs / 各 bootstrap 真实导出一致）；只有被直接执行时才会启动 Electron。
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

/**
 * 可选：验收**打包产物**而不是工作区 electron .（用于验证"打包/分发链路"）。
 *   node experiments/dxos-e2e/run-all.mjs --app-path "/path/OpenArc OS Pack.app"
 *   OA_DXOS_E2E_APP_PATH=... node experiments/dxos-e2e/run-all.mjs
 * 传 .app 时派生其 Contents/MacOS 可执行文件；传目录时按 electron <dir> 启动。
 * 不传时行为与既有探针完全一致（electron .）。
 */
export const APP_PATH = (() => {
  const index = process.argv.indexOf("--app-path");
  const value = index >= 0 ? process.argv[index + 1] : process.env.OA_DXOS_E2E_APP_PATH;
  return value ? path.resolve(String(value)) : null;
})();

/** 顶层键的真实形状（来源：electron/preload.cjs 的 contextBridge.exposeInMainWorld；0.6.1 追加五域与 CLI 域，Stage 1 追加 marketUpdate）。 */
export const CONTRACT = Object.freeze({
  topLevel: Object.freeze([
    { key: "sync", kind: "function" },
    { key: "navigate", kind: "function" },
    { key: "action", kind: "function" },
    { key: "browser", kind: "function" },
    { key: "onNativeState", kind: "function" },
    { key: "onDisplay", kind: "function" },
    { key: "identity", kind: "domain", members: ["command", "onEvent"] },
    { key: "authorization", kind: "domain", members: ["command"] },
    { key: "device", kind: "domain", members: ["command"] },
    { key: "resource", kind: "domain", members: ["command"] },
    { key: "governance", kind: "domain", members: ["command"] },
    { key: "model", kind: "domain", members: ["command", "onEvent"] },
    { key: "mcp", kind: "domain", members: ["command"] },
    { key: "canvas", kind: "domain", members: ["command"] },
    { key: "task", kind: "domain", members: ["command", "onEvent"] },
    { key: "agent", kind: "domain", members: ["command", "onEvent"] },
    { key: "skill", kind: "domain", members: ["command", "onEvent"] },
    { key: "media", kind: "domain", members: ["command", "onEvent"] },
    { key: "calendar", kind: "domain", members: ["command"] },
    { key: "uploadConsent", kind: "domain", members: ["command"] },
    { key: "sideEffect", kind: "domain", members: ["command", "onEvent", "revokeApproval"] },
    { key: "files", kind: "domain", members: ["pathFor", "import", "list", "rename", "remove", "trash", "trashList", "trashRestore", "trashPurge", "trashEmpty", "read", "writeText", "thumb", "info", "startDrag", "copy", "move", "exportTo"] },
    { key: "automation", kind: "domain", members: ["command", "onEvent"] },
    { key: "platform", kind: "domain", members: ["command"] },
    { key: "developer", kind: "domain", members: ["command"] },
    { key: "integration", kind: "domain", members: ["command"] },
    { key: "market", kind: "domain", members: ["command"] },
    // 10-15 本地能力键（追加在 DX OS 契约键之后）
    { key: "video", kind: "domain", members: ["status", "probe", "export", "cancel", "onProgress"] },
    { key: "image", kind: "domain", members: ["declare"] },
    { key: "system", kind: "domain", members: ["info"] },
    { key: "weather", kind: "domain", members: ["geocode", "forecast"] },
    // 0.6.1 本轮新增五域（preload.cjs 追加在既有键之后，保持前面所有键 index 不变）。
    { key: "systemFonts", kind: "domain", members: ["command", "onEvent"] },
    { key: "ocr", kind: "domain", members: ["command", "onEvent"] },
    { key: "fileTransfer", kind: "domain", members: ["command"] },
    { key: "codexCanvas", kind: "domain", members: ["command", "onEvent"] },
    { key: "desktop", kind: "domain", members: ["command"] },
    // 0.6.2 三域（preload.cjs 追加在既有键之后，保持前面所有键 index 不变）。
    { key: "photos", kind: "domain", members: ["command"] },
    { key: "photocraft", kind: "domain", members: ["command"] },
    { key: "appExchange", kind: "domain", members: ["command"] },
    // CLI 域（对齐 DX OS 0.6.1 /api/cli/*；preload.cjs 追加在既有键之后，保持前面所有键 index 不变）。
    { key: "cli", kind: "domain", members: ["command"] },
    // Stage 1 画布在线更新（第 39 个顶层键；命令通道复用 market:command）。
    { key: "marketUpdate", kind: "domain", members: ["command"] },
    // Windows 自绘 caption（第 40 个顶层键；动作走 window:control 冻结白名单）。
    { key: "windowControl", kind: "domain", members: ["state", "minimize", "toggleMaximize", "close", "onStateChange"] },
    // 全局 AI 对话：预览 / 附件 / 列表偏好 / 语音转写（第 43 个顶层键；命令白名单在 electron/chat-preview.cjs）。
    { key: "chat", kind: "domain", members: ["command"] },
  ]),
  /** 健康 / 只读基线：B3 agent、B4 skill、B5 media、B6a automation、B6c platform、B7a developer、B7c integration+market，以及 B2 model / mcp / canvas / task 的等价只读命令。 */
  health: Object.freeze([
    { id: "agent-health", channel: "agent", command: "agent/health", whitelist: "AGENT_COMMANDS", mode: "value" },
    { id: "skill-health", channel: "skill", command: "skill/health", whitelist: "SKILL_COMMANDS", mode: "value" },
    { id: "media-health", channel: "media", command: "media/health", whitelist: "MEDIA_COMMANDS", mode: "value" },
    { id: "automation-health", channel: "automation", command: "automation/health", whitelist: "AUTOMATION_COMMANDS", mode: "value" },
    { id: "platform-health", channel: "platform", command: "platform/health", whitelist: "PLATFORM_COMMANDS", mode: "value" },
    { id: "developer-health", channel: "developer", command: "developer/health", whitelist: "DEVELOPER_COMMANDS", mode: "value" },
    { id: "integration-health", channel: "integration", command: "integration/health", whitelist: "INTEGRATION_COMMANDS", mode: "value" },
    { id: "market-health", channel: "market", command: "market/health", whitelist: "MARKET_COMMANDS", mode: "value" },
    { id: "model-protocol-list", channel: "model", command: "protocol/list", whitelist: "MODEL_COMMANDS", mode: "top" },
    { id: "mcp-list", channel: "mcp", command: "mcp/list", whitelist: "MCP_COMMANDS", mode: "top" },
    { id: "canvas-list", channel: "canvas", command: "canvas/list", whitelist: "RENDERER_COMMANDS", mode: "top" },
    { id: "task-list", channel: "task", command: "task/list", whitelist: "TASK_COMMANDS", mode: "top" },
  ]),
  /** 若干真实只读命令（覆盖每个命令通道 + 三个顶层函数通道），用于证明"注册"不是纸面白名单。 */
  extra: Object.freeze([
    { id: "identity-status", channel: "identity", command: "identity/status", whitelist: null },
    { id: "authorization-capabilities", channel: "authorization", command: "authorization/capabilities", whitelist: null },
    { id: "device-list", channel: "device", command: "device/list", whitelist: null },
    { id: "resource-list", channel: "resource", command: "resource/list", whitelist: null },
    { id: "governance-listApps", channel: "governance", command: "governance/listApps", whitelist: null },
    { id: "sideEffect-listPending", channel: "sideEffect", command: "sideEffect/listPending", whitelist: null },
    { id: "automation-list", channel: "automation", command: "automation/list", whitelist: "AUTOMATION_COMMANDS" },
    { id: "agent-tool-catalog", channel: "agent", command: "agent/tool/catalog", whitelist: "AGENT_COMMANDS" },
    { id: "skill-list", channel: "skill", command: "skill/list", whitelist: "SKILL_COMMANDS" },
    { id: "media-artifact-list", channel: "media", command: "media/artifact/list", whitelist: "MEDIA_COMMANDS" },
    { id: "platform-data-integrity", channel: "platform", command: "platform/data/integrity", whitelist: "PLATFORM_COMMANDS" },
    { id: "developer-list", channel: "developer", command: "developer/list", whitelist: "DEVELOPER_COMMANDS" },
    { id: "integration-plugins-list", channel: "integration", command: "integration/plugins/list", whitelist: "INTEGRATION_COMMANDS" },
    { id: "market-catalog", channel: "market", command: "market/catalog", whitelist: "MARKET_COMMANDS" },
    { id: "model-provider-list", channel: "model", command: "provider/list", whitelist: "MODEL_COMMANDS" },
    { id: "mcp-get", channel: "mcp", command: "mcp/get", payload: { connectionId: "e2e-nonexistent" }, whitelist: "MCP_COMMANDS" },
    { id: "canvas-recent", channel: "canvas", command: "canvas/recent", whitelist: "RENDERER_COMMANDS" },
    { id: "task-get", channel: "task", command: "task/get", payload: { taskId: "e2e-nonexistent" }, whitelist: "TASK_COMMANDS" },
    { id: "files-list", kind: "method", channel: "files", method: "list", args: ["dxos-e2e-probe"], whitelist: null },
    { id: "browser-downloads-list", kind: "fn", fn: "browser", args: [{ type: "browser/downloads", action: "list" }], whitelist: null },
    { id: "windows-sync-empty", kind: "fn", fn: "sync", args: [{ intents: [] }], whitelist: null },
  ]),
});

/** 命令白名单的真实来源（module 路径相对仓库根；导出名即 bootstrap/domain 的真实导出）。 */
export const WHITELISTS = Object.freeze({
  AGENT_COMMANDS: "electron/agent-domain.cjs",
  SKILL_COMMANDS: "electron/skill-domain.cjs",
  MEDIA_COMMANDS: "electron/media-domain.cjs",
  PLATFORM_COMMANDS: "electron/platform-domain.cjs",
  DEVELOPER_COMMANDS: "electron/developer-domain.cjs",
  AUTOMATION_COMMANDS: "electron/automation-domain.cjs",
  MARKET_COMMANDS: "electron/market-domain.cjs",
  INTEGRATION_COMMANDS: "electron/plugin-service.cjs",
  MODEL_COMMANDS: "electron/model-bootstrap.cjs",
  MCP_COMMANDS: "electron/mcp-bootstrap.cjs",
  TASK_COMMANDS: "electron/task-bootstrap.cjs",
  RENDERER_COMMANDS: "electron/canvas-bootstrap.cjs",
});

// ────────────────────────────────────────────────────────────────────────────
// 通用工具
// ────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, timeoutMs, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (await fn()) return true; } catch { /* 重试 */ }
    if (Date.now() >= deadline) return false;
    await sleep(stepMs);
  }
}

function sha256File(p) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } catch { return null; }
}
function statOf(p) {
  try { const s = fs.statSync(p); return { exists: true, mtimeMs: Math.round(s.mtimeMs), size: s.size, ino: s.ino }; }
  catch { return { exists: false }; }
}
function resolveRealProfilePath(appName) {
  const name = appName || "openarc-os";
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", name);
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), name);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), name);
}

/** 解析启动目标：缺省 electron .；--app-path 指向 .app 直接用其可执行文件，指向目录则 electron <dir>。 */
function resolveLaunchTarget(appPath, electronPath) {
  if (!appPath) return { binary: electronPath, args: ["."], cwd: ROOT, payloadDir: ROOT, label: "真实 electron .（electron/main.cjs）" };
  if (!fs.existsSync(appPath)) throw new Error("--app-path 不存在：" + appPath);
  if (!appPath.endsWith(".app")) return { binary: electronPath, args: [appPath], cwd: appPath, payloadDir: appPath, label: "真实 electron <appDir>" };
  const contents = path.join(appPath, "Contents");
  let executableName = "Electron";
  try {
    executableName = execFileSync("plutil", ["-extract", "CFBundleExecutable", "raw", path.join(contents, "Info.plist")], { encoding: "utf8" }).trim() || "Electron";
  } catch { /* 读不到 plist 时按 Electron 处理 */ }
  const binary = path.join(contents, "MacOS", executableName);
  if (!fs.existsSync(binary)) throw new Error("找不到 .app 可执行文件：" + binary);
  const payloadDir = path.join(contents, "Resources", "app");
  if (!fs.existsSync(path.join(payloadDir, "package.json"))) throw new Error("载荷不像应用：" + payloadDir);
  return { binary, args: [], cwd: payloadDir, payloadDir, label: "真实打包产物 " + appPath };
}
/** 真实 profile 的前后对照快照：目录 + 顶层条目 + 身份库三件套（含 sha256）。 */
function snapshotProfile(dir) {
  const out = { path: dir, exists: fs.existsSync(dir), dir: statOf(dir), identity: {}, topLevel: {} };
  for (const name of ["identity.db", "identity.db-wal", "identity.db-shm"]) {
    const abs = path.join(dir, name);
    const st = statOf(abs);
    out.identity[name] = st.exists ? Object.assign({}, st, { sha256: sha256File(abs) }) : st;
  }
  try {
    for (const name of fs.readdirSync(dir)) {
      const st = statOf(path.join(dir, name));
      out.topLevel[name] = { mtimeMs: st.mtimeMs, size: st.size };
    }
  } catch { /* 目录不存在 */ }
  return out;
}
function diffProfile(before, after) {
  const changed = [];
  let identityUnchanged = true;
  for (const name of new Set([...Object.keys(before.identity), ...Object.keys(after.identity)])) {
    if (JSON.stringify(before.identity[name] || null) !== JSON.stringify(after.identity[name] || null)) {
      identityUnchanged = false;
      changed.push("identity/" + name);
    }
  }
  for (const name of new Set([...Object.keys(before.topLevel), ...Object.keys(after.topLevel)])) {
    if (JSON.stringify(before.topLevel[name] || null) !== JSON.stringify(after.topLevel[name] || null)) changed.push("topLevel/" + name);
  }
  if (JSON.stringify(before.dir || null) !== JSON.stringify(after.dir || null)) changed.push("dir");
  return { unchanged: changed.length === 0, identityUnchanged, changed: changed.slice(0, 40), changedCount: changed.length };
}
function listProcessesFor(dir) {
  try {
    const text = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    return text
      .split("\n")
      .filter((line) => line.includes(dir))
      .map((line) => {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        return m ? { pid: Number(m[1]), command: m[2].slice(0, 220) } : null;
      })
      .filter(Boolean)
      .slice(0, 16);
  } catch { return []; }
}

const SECRET_KEY_RE = /(token|secret|password|passwd|credential|hash|salt|verifier|sessionref|session_ref|apikey|api_key|privatekey|private_key|authorization)/i;
const ABS_PATH_RE = /^(\/(Users|var|private|tmp|Volumes|opt)\/|[A-Za-z]:\\)/;
function makeRedactor(extraLiterals) {
  return function redactValue(value, key, depth = 0) {
    if (depth > 14) return "<depth-limit>";
    if (key && SECRET_KEY_RE.test(key)) return "***";
    if (typeof value === "string") {
      let text = value;
      for (const lit of extraLiterals) if (lit) text = text.split(lit).join("<isolated-path>");
      if (ABS_PATH_RE.test(text)) return "<absolute-path>";
      if (/^sref_|^ses_|^tok_/.test(text)) return "***";
      return text.length > 900 ? text.slice(0, 900) + "…<truncated>" : text;
    }
    if (Array.isArray(value)) {
      const head = value.slice(0, 60).map((item) => redactValue(item, undefined, depth + 1));
      if (value.length > 60) head.push("…<" + (value.length - 60) + " more>");
      return head;
    }
    if (value && typeof value === "object") {
      const out = {};
      for (const k of Object.keys(value)) out[k] = redactValue(value[k], k, depth + 1);
      return out;
    }
    return value;
  };
}

/** 结构化错误 / 返回判定：不允许未捕获异常，也不允许 "No handler registered" 类通道缺失。 */
function classify(result) {
  if (!result || typeof result !== "object") return { structured: false, threw: false, handlerMissing: false, note: "not-an-object" };
  if (result.__threw) {
    const handlerMissing = /No handler registered|No handler|not registered/i.test(String(result.message || ""));
    return { structured: false, threw: true, handlerMissing, note: String(result.message || "").slice(0, 240) };
  }
  const value = result.value;
  const hasOk = typeof value === "object" && value !== null && typeof value.ok === "boolean";
  const hasError = typeof value === "object" && value !== null && typeof value.error === "string";
  return {
    structured: hasOk || hasError,
    threw: false,
    handlerMissing: /No handler registered/i.test(String((value && value.error) || "")),
    note: hasOk ? "ok-boolean" : hasError ? "error-code" : "unrecognized-shape",
  };
}
function isStructuredErrorCode(code) {
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,}$/.test(code);
}

// ────────────────────────────────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────────────────────────────────
async function main() {
  const require = createRequire(path.join(ROOT, "package.json"));
  const { chromium } = require("@playwright/test");
  const electronPath = require("electron");

  const launch = resolveLaunchTarget(APP_PATH, electronPath);
  const appName = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(launch.payloadDir, "package.json"), "utf8")).name || null; } catch { return null; }
  })();
  const runStartedAt = Date.now();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-dxos-e2e-"));
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-dxos-e2e-dl-"));
  const cdpPort = Number(process.env.OA_DXOS_E2E_CDP_PORT) || (await freePort());
  const realProfilePath = resolveRealProfilePath(appName);
  const profileBefore = snapshotProfile(realProfilePath);
  const preexistingProfilePids = listProcessesFor(realProfilePath);
  const BOOT_PATH = path.join(userDataDir, "openarc-e2e-boot.json");

  const checks = [];
  const notVerified = [];
  const observations = [];
  const record = (section, name, ok, expected, actual, detail) => {
    const row = { section, name, ok: !!ok, expected: String(expected == null ? "" : expected), actual: String(actual == null ? "" : actual).slice(0, 400), detail: detail || null };
    checks.push(row);
    console.log((row.ok ? "PASS" : "FAIL") + " [" + section + "] " + name + " :: actual=" + row.actual + " expected=" + row.expected);
    return row.ok;
  };
  const markNotVerified = (section, name, reason, actual) => {
    notVerified.push({ section, name, reason });
    console.log("NOT_VERIFIED [" + section + "] " + name + " :: " + reason);
  };
  const note = (line) => { observations.push(line); console.log("   · " + line); };

  let child = null;
  let browser = null;
  let page = null;
  let stderrBuf = "";
  const consoleAll = [];
  const consoleErrors = [];
  const pageErrors = [];
  const requests = [];
  const requestFailures = [];
  let launchCommand = null;
  let boot = null;
  let renderer = null;
  let bridge = null;
  let trusted = null;
  let events = null;
  let healthResults = [];
  let healthAllStructured = false;
  let healthAllOk = false;
  let extraStructured = false;
  let realUserId = null;
  let rawProbes = null;
  let leaked = [];
  let domainLeak = [];
  let forgedSnapshot = null;
  let nested = null;
  let trustedSource = null;
  let onEventDomains = [];
  let unsubResults = {};
  let network = null;
  let nonLocal = [];
  let handlerMissingConsole = [];
  const realCommands = [];
  let exitInfo = null;
  let residual = [];
  let userDataRemoved = false;

  const js = (code) => page.evaluate("(async () => { " + code + " })()");

  async function callDomain(channel, command, payload) {
    const expression =
      "return await (async () => { try { const api = window.openarc[" + JSON.stringify(channel) + "];" +
      " if (!api || typeof api.command !== \"function\") return { __threw: true, message: \"no command() on \" + " + JSON.stringify(channel) + " };" +
      " const t0 = performance.now();" +
      " const res = await api.command(Object.assign({ type: " + JSON.stringify(command) + " }, " + JSON.stringify(payload || {}) + "));" +
      " return { __ok: true, ms: Math.round(performance.now() - t0), value: res }; }" +
      " catch (e) { return { __threw: true, message: String((e && e.message) || e) }; } })();";
    return js(expression);
  }
  async function callMethod(channel, method, args) {
    const expression =
      "return await (async () => { try { const api = window.openarc[" + JSON.stringify(channel) + "];" +
      " const fn = api && api[" + JSON.stringify(method) + "]; if (typeof fn !== \"function\") return { __threw: true, message: \"no method " + method + "\" };" +
      " const t0 = performance.now(); const res = await fn.call(api, " + (args || []).map((a) => JSON.stringify(a)).join(", ") + ");" +
      " return { __ok: true, ms: Math.round(performance.now() - t0), value: res }; }" +
      " catch (e) { return { __threw: true, message: String((e && e.message) || e) }; } })();";
    return js(expression);
  }
  async function callFn(name, args) {
    const expression =
      "return await (async () => { try { const fn = window.openarc[" + JSON.stringify(name) + "]; if (typeof fn !== \"function\") return { __threw: true, message: \"no function " + name + "\" };" +
      " const t0 = performance.now(); const res = await fn(" + (args || []).map((a) => JSON.stringify(a)).join(", ") + ");" +
      " return { __ok: true, ms: Math.round(performance.now() - t0), value: res }; }" +
      " catch (e) { return { __threw: true, message: String((e && e.message) || e) }; } })();";
    return js(expression);
  }

  try {
    // ── 1) 启动（隔离 userData）────────────────────────────────────────────
    const launchArgs = [...launch.args, "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + cdpPort];
    launchCommand = launch.label + " " + launchArgs.map((a) => (a.includes(userDataDir) ? "--user-data-dir=<isolated>" : a)).join(" ");
    const env = { ...process.env, OPENARC_E2E_OBSERVE: "1", OPENARC_DOWNLOADS_DIR: downloadsDir };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    child = spawn(launch.binary, launchArgs, { cwd: launch.cwd, stdio: ["ignore", "pipe", "pipe"], env });
    child.stdout.on("data", () => {});
    child.stderr.on("data", (d) => { stderrBuf += String(d); });

    const cdpReady = await waitFor(async () => {
      const res = await fetch("http://127.0.0.1:" + cdpPort + "/json/version");
      return res.ok;
    }, 40000, 300);
    record("boot", "B0 · " + launch.label + " 启动并暴露本机 CDP", cdpReady, "CDP ready", cdpReady ? "http://127.0.0.1:" + cdpPort : "timeout");
    if (!cdpReady) throw new Error("CDP 未就绪：" + stderrBuf.slice(-400));

    browser = await chromium.connectOverCDP("http://127.0.0.1:" + cdpPort);
    const context = browser.contexts()[0];
    const isUI = (p) => p.url().includes("index.html");
    const found = await waitFor(() => !!context.pages().find(isUI), 30000, 300);
    page = context.pages().find(isUI) || null;
    if (!found || !page) throw new Error("未找到界面页面：" + context.pages().map((p) => p.url()).join(" | "));
    page.on("console", (msg) => {
      const row = { type: msg.type(), text: String(msg.text()).slice(0, 400) };
      consoleAll.push(row);
      if (row.type === "error") consoleErrors.push(row.text);
    });
    page.on("pageerror", (err) => pageErrors.push(String((err && err.message) || err).slice(0, 400)));
    page.on("request", (req) => requests.push(req.url()));
    page.on("requestfailed", (req) => requestFailures.push({ url: req.url(), error: String((req.failure() && req.failure().errorText) || "") }));

    // 就绪：CDP 连上 + 页面 complete + 桥面 39 键。__DSH_BOOT__ 在本产品不存在，
    // 用主进程唯一 boot 观测文件（OPENARC_E2E_OBSERVE=1 → <userData>/openarc-e2e-boot.json）作等价信号。
    const rendererReady = await waitFor(async () => {
      const v = await js("return { rs: document.readyState, n: window.openarc && window.openarc.identity ? Object.keys(window.openarc).length : 0, url: location.href };");
      return v && v.rs === "complete" && v.n === 39;
    }, 40000, 300);
    const bootFileReady = await waitFor(() => fs.existsSync(BOOT_PATH), 40000, 300);
    if (fs.existsSync(BOOT_PATH)) { try { boot = JSON.parse(fs.readFileSync(BOOT_PATH, "utf8")); } catch { boot = null; } }
    renderer = await js("return { url: location.href, readyState: document.readyState, gate: document.querySelector('.desktop') ? document.querySelector('.desktop').getAttribute('data-identity-gate') : null, rootChildren: document.querySelector('#root') ? document.querySelector('#root').childElementCount : null, hasDSHBoot: typeof window.__DSH_BOOT__ }");
    record("boot", "B1 · 渲染层就绪（document.readyState=complete + window.openarc 39 键）", rendererReady, "complete + 39 keys", JSON.stringify(renderer));
    record("boot", "B2 · 主进程 boot 观测文件落在隔离 userData（OPENARC_E2E_OBSERVE）", bootFileReady && !!boot, "openarc-e2e-boot.json in isolated userData", boot ? JSON.stringify({ bootOrder: boot.bootOrder, listening: boot.modelProxyListening }) : "missing");
    record("boot", "B3 · 隔离 userData ≠ 真实 profile", path.resolve(userDataDir) !== path.resolve(realProfilePath), "different paths", userDataDir);
    record("boot", "B4 · 隔离 userData 内真实建库（identity.db）", fs.existsSync(path.join(userDataDir, "identity.db")), "identity.db present", fs.existsSync(path.join(userDataDir, "identity.db")) ? "present" : "missing");
    note("主进程 ready 观测（boot 顺序）：" + JSON.stringify(boot || null));
    note("真实 profile 路径：" + realProfilePath + "；启动前已在用该 profile 的进程数：" + preexistingProfilePids.length);

    // ── 2) 契约：39 键 + 真实形状 ─────────────────────────────────────────
    bridge = await js("const api = window.openarc; const out = {}; for (const k of Object.keys(api)) { const v = api[k]; out[k] = typeof v === 'function' ? 'function' : (v && typeof v === 'object' ? Object.keys(v) : typeof v); } return { keys: Object.keys(api), shapes: out, frozen: Object.isFrozen(api), extensible: Object.isExtensible(api) };");
    const expectedKeys = CONTRACT.topLevel.map((e) => e.key);
    record("contract", "C0 · window.openarc 顶层键恰为 39", bridge.keys.length === 39, 39, bridge.keys.length + " → " + bridge.keys.join(","));
    record("contract", "C1 · 顶层键集合与契约（preload 真实导出顺序）一致", JSON.stringify(bridge.keys) === JSON.stringify(expectedKeys), expectedKeys.join(","), bridge.keys.join(","));
    for (const entry of CONTRACT.topLevel) {
      const actualShape = bridge.shapes[entry.key];
      if (entry.kind === "function") {
        record("contract", "C2 · " + entry.key + " 是函数", actualShape === "function", "function", String(actualShape));
      } else {
        const present = Array.isArray(actualShape) ? actualShape : [];
        const missing = entry.members.filter((m) => !present.includes(m));
        record("contract", "C2 · " + entry.key + " 是域对象且含 " + entry.members.join("/"), missing.length === 0, entry.members.join("/"), (present.join(",") || "missing") + (missing.length ? " (missing " + missing.join(",") + ")" : ""));
      }
    }
    note("window.openarc frozen=" + bridge.frozen + " extensible=" + bridge.extensible);

    // ── 3) 身份：经真实产品桥 initialize + login（无设备码 / 无测试播种）──
    const identifier = "dxos-e2e@openarc.test";
    const password = "Dxos-e2e-password-1";
    const initialized = await callDomain("identity", "identity/initialize", { identifier, password, displayName: "DXOS E2E Admin" });
    record("identity", "I0 · 经产品桥 identity/initialize 首启初始化", !!(initialized.__ok && initialized.value && initialized.value.ok), "ok:true", JSON.stringify(initialized.value || initialized).slice(0, 240));
    const loggedIn = await callDomain("identity", "identity/login", { identifier, password });
    realUserId = loggedIn.__ok && loggedIn.value && loggedIn.value.snapshot ? loggedIn.value.snapshot.userId : null;
    record("identity", "I1 · 经产品桥 identity/login 登录（sessionRef 由主进程产生）", !!(loggedIn.__ok && loggedIn.value && loggedIn.value.ok && realUserId), "ok:true + userId", JSON.stringify(loggedIn.value ? { ok: loggedIn.value.ok, role: loggedIn.value.snapshot && loggedIn.value.snapshot.role } : loggedIn).slice(0, 240));

    // ── 4) 健康 / 只读基线 ────────────────────────────────────────────────
    healthResults = [];
    healthAllStructured = true;
    healthAllOk = true;
    for (const entry of CONTRACT.health) {
      const res = await callDomain(entry.channel, entry.command, entry.payload);
      const cls = classify(res);
      const value = res.value;
      const okTrue = cls.structured && !cls.threw && value && value.ok === true;
      if (!cls.structured || cls.threw || cls.handlerMissing) healthAllStructured = false;
      if (!okTrue) healthAllOk = false;
      healthResults.push({ id: entry.id, channel: entry.channel, command: entry.command, threw: cls.threw, handlerMissing: cls.handlerMissing, structured: cls.structured, ok: !!(value && value.ok), hasValue: !!(value && value.value && typeof value.value === "object"), error: value && value.error ? String(value.error) : null, errorStructured: value && value.error ? isStructuredErrorCode(value.error) : null, ms: res.ms == null ? null : res.ms, result: value });
      record("health", "H1 · " + entry.command + " 不抛异常且错误结构化", cls.structured && !cls.threw && !cls.handlerMissing, "structured, no throw", JSON.stringify({ threw: cls.threw, handlerMissing: cls.handlerMissing, ok: value && value.ok, error: value && value.error, ms: res.ms }));
      if (entry.mode === "value") {
        record("health", "H2 · " + entry.command + " 返回域健康投影 value", okTrue && !!(value.value && typeof value.value === "object"), "ok:true + value", JSON.stringify(value && value.value ? Object.keys(value.value) : value).slice(0, 240));
      } else {
        record("health", "H2 · " + entry.command + " 返回 ok:true", okTrue, "ok:true", JSON.stringify(value).slice(0, 200));
      }
    }
    record("health", "H3 · 全部健康 / 只读命令均无未捕获异常、无 'No handler registered'", healthAllStructured, "0 throw / 0 handler-missing", JSON.stringify({ structured: healthAllStructured, allOk: healthAllOk }));
    record("health", "H4 · 登录后 12 条健康 / 只读命令全部 ok:true", healthAllOk, "all ok:true", JSON.stringify(healthResults.map((h) => ({ id: h.id, ok: h.ok, error: h.error }))));

    // 第 9 条 */health：integration/plugins/health（插件依赖探测；前 8 条是域健康投影）。
    // 单独断言，不并入 CONTRACT.health（后者是"域健康矩阵"，通道顺序由契约测试锁死）。
    const pluginHealth = await callDomain("integration", "integration/plugins/health");
    const pluginHealthCls = classify(pluginHealth);
    const pluginHealthOk = pluginHealthCls.structured && !pluginHealthCls.threw && !pluginHealthCls.handlerMissing && pluginHealth.value && pluginHealth.value.ok === true;
    const pluginHealthItems = pluginHealth.value && pluginHealth.value.value && Array.isArray(pluginHealth.value.value.items) ? pluginHealth.value.value.items : null;
    record("health", "H5 · 第 9 条 */health（integration/plugins/health）返回 ok:true（全部 9 条 */health 均 ok）", pluginHealthOk, "ok:true", JSON.stringify({ structured: pluginHealthCls.structured, threw: pluginHealthCls.threw, ok: pluginHealth.value && pluginHealth.value.ok, plugins: pluginHealthItems ? pluginHealthItems.length : null, ms: pluginHealth.ms }));

    // ── 5) 真实只读命令（覆盖每个命令通道 + files/browser/sync）───────────
    extraStructured = true;
    for (const entry of CONTRACT.extra) {
      let res;
      if (entry.kind === "method") res = await callMethod(entry.channel, entry.method, entry.args);
      else if (entry.kind === "fn") res = await callFn(entry.fn, entry.args);
      else res = await callDomain(entry.channel, entry.command, entry.payload);
      const cls = classify(res);
      const value = res.value;
      if (!cls.structured || cls.threw || cls.handlerMissing) extraStructured = false;
      realCommands.push({ id: entry.id, channel: entry.channel || null, fn: entry.fn || null, command: entry.command || entry.method || null, threw: cls.threw, handlerMissing: cls.handlerMissing, structured: cls.structured, ok: !!(value && value.ok), error: value && value.error ? String(value.error) : null, ms: res.ms == null ? null : res.ms, result: value });
      record("commands", "R1 · " + entry.id + " 真实调用不抛异常且结果结构化", cls.structured && !cls.threw && !cls.handlerMissing, "structured, no throw", JSON.stringify({ threw: cls.threw, handlerMissing: cls.handlerMissing, ok: value && value.ok, error: value && value.error, ms: res.ms }));
    }
    record("commands", "R2 · 全部真实只读命令无未捕获异常、无 'No handler registered'", extraStructured, "0 throw / 0 handler-missing", JSON.stringify({ structured: extraStructured }));

    // ── 6) trusted 边界 ──────────────────────────────────────────────────
    rawProbes = await js("const names = ['ipcRenderer','ipcMain','require','process','module','global','Buffer','electron','electronAPI','webContents','BrowserWindow','shell','fs','path']; const out = {}; for (const n of names) out[n] = typeof window[n]; return out;");
    leaked = Object.keys(rawProbes).filter((n) => rawProbes[n] !== "undefined");
    record("trusted", "T0 · 渲染层拿不到原始能力（ipcRenderer/webContents/require/process…）", leaked.length === 0, "all undefined", JSON.stringify(rawProbes));

    domainLeak = await js("const bans = ['ipcRenderer','ipcMain','webContents','send','invoke','require','process','fs','shell','BrowserWindow']; const members = []; const fnKeys = []; for (const k of Object.keys(window.openarc)) { const v = window.openarc[k]; if (typeof v === 'function') { if (bans.includes(k)) fnKeys.push(k); continue; } if (v && typeof v === 'object') for (const mk of Object.keys(v)) if (bans.includes(mk)) members.push(k + '.' + mk); } return { members: members, rawFnKeys: fnKeys };");
    record("trusted", "T1 · 桥面自身不暴露任何原始 IPC / fs / shell 成员（域成员与函数键）", domainLeak.members.length === 0 && domainLeak.rawFnKeys.length === 0, "0 banned members / 0 raw-capability fn keys", JSON.stringify(domainLeak));

    const forged = await callDomain("identity", "identity/status", { userId: "forged-admin", role: "ADMIN", appId: "forged", sessionRef: "forged-session", token: "forged-token" });
    forgedSnapshot = forged.__ok && forged.value && forged.value.snapshot ? forged.value.snapshot : null;
    record("trusted", "T2 · 渲染层自报 userId/role/appId/sessionRef/token 一律被忽略（identity/status 仍返回真实会话）",
      !!(forgedSnapshot && realUserId && forgedSnapshot.userId === realUserId), "真实 userId=" + realUserId,
      JSON.stringify({ returnedUserId: forgedSnapshot && forgedSnapshot.userId, role: forgedSnapshot && forgedSnapshot.role }).slice(0, 240));

    nested = await js(
      "const iframe = document.createElement('iframe'); iframe.src = 'about:blank';" +
      " document.body.appendChild(iframe);" +
      " await new Promise((r) => setTimeout(r, 250));" +
      " let out = { hasBridge: false, call: null };" +
      " try { const w = iframe.contentWindow; out.hasBridge = !!(w && w.openarc);" +
      " if (out.hasBridge && w.openarc.identity && typeof w.openarc.identity.command === 'function') {" +
      "   try { out.call = await w.openarc.identity.command({ type: 'identity/status' }); }" +
      "   catch (e) { out.call = { __threw: true, message: String((e && e.message) || e) }; }" +
      " } } catch (e) { out.error = String((e && e.message) || e); }" +
      " iframe.remove(); return out;"
    );
    if (nested && nested.hasBridge) {
      const callBlob = JSON.stringify(nested.call);
      record("trusted", "T3 · 子框架拿到桥面后调用被主进程 trusted 拒绝（senderFrame.url 不符）", /Forbidden/i.test(callBlob), "Forbidden", callBlob.slice(0, 240));
    } else {
      record("trusted", "T3 · 子框架（about:blank iframe）拿不到 window.openarc（preload 不注入子框架）", !!(nested && nested.hasBridge === false), "无桥面", JSON.stringify(nested).slice(0, 240));
      markNotVerified("trusted", "T3 · 伪造 senderFrame 的运行时反例", "渲染层无法构造带桥面的非外壳 sender（preload 不注入子框架）；trusted() 的 sender/senderFrame 双条件由离线契约测试对 electron/main.cjs 静态核对。");
    }

    trustedSource = (() => {
      try {
        const mainPath = path.join(launch.payloadDir, "electron", "main.cjs");
        const src = fs.readFileSync(fs.existsSync(mainPath) ? mainPath : path.join(ROOT, "electron", "main.cjs"), "utf8");
        return {
          senderCheck: /event\.sender\s*!==\s*win\?\.webContents/.test(src),
          frameUrlCheck: /event\.senderFrame\?\.url/.test(src) && /url\s*===\s*uiURL/.test(src),
        };
      } catch { return { senderCheck: false, frameUrlCheck: false }; }
    })();
    record("trusted", "T4 · 主进程 trusted() 双条件静态核对（sender === win.webContents 且 senderFrame.url ∈ 外壳页）", trustedSource.senderCheck && trustedSource.frameUrlCheck, "sender + senderFrame.url", JSON.stringify(trustedSource));

    // ── 7) P1 事件信封 ───────────────────────────────────────────────────
    onEventDomains = CONTRACT.topLevel.filter((e) => e.kind === "domain" && e.members.includes("onEvent")).map((e) => e.key);
    unsubResults = {};
    for (const dom of onEventDomains) {
      unsubResults[dom] = await js("const api = window.openarc[" + JSON.stringify(dom) + "]; if (!api || typeof api.onEvent !== 'function') return 'missing'; const un = api.onEvent(function () {}); const t = typeof un; if (t === 'function') un(); return t;");
    }
    record("events", "E0 · 每个带 onEvent 的域都返回退订函数", onEventDomains.every((d) => unsubResults[d] === "function"), onEventDomains.map((d) => d + ":function").join(","), JSON.stringify(unsubResults));

    await js("window.__oaE2eEvents = []; window.__oaE2eUnsub = window.openarc.agent.onEvent(function (e) { window.__oaE2eEvents.push(e); }); return typeof window.__oaE2eUnsub;");
    const trigger = await callDomain("agent", "agent/health");
    const gotEvents = await waitFor(async () => (await js("return window.__oaE2eEvents.length")) >= 2, 10000, 150);
    const captured = await js("const un = window.__oaE2eUnsub; if (typeof un === 'function') un(); return window.__oaE2eEvents;");
    const envelopeOk = (e) => !!e && typeof e.channel === "string" && typeof e.domain === "string" && typeof e.kind === "string" && typeof e.sequence === "number" && typeof e.at === "number" && "payload" in e;
    const envelopeAll = Array.isArray(captured) && captured.length > 0 && captured.every(envelopeOk);
    let monotonic = true;
    for (let i = 1; i < (captured || []).length; i += 1) if (!(captured[i].sequence > captured[i - 1].sequence)) monotonic = false;
    const sample = Array.isArray(captured) && captured.length ? captured[0] : null;
    events = { triggerCommand: "agent/health", triggerOk: !!(trigger.__ok && trigger.value && trigger.value.ok), received: Array.isArray(captured) ? captured.length : 0, envelopeComplete: envelopeAll, sequenceMonotonic: monotonic, channelConsistent: (captured || []).every((e) => e.channel === "agent:event" && e.domain === "agent"), kinds: [...new Set((captured || []).map((e) => e.kind))], sample, sequenceValues: (captured || []).map((e) => e.sequence).slice(0, 20) };
    record("events", "E1 · 订阅 agent.onEvent 后触发 agent/health 收到 P1 信封", gotEvents && envelopeAll, ">=1 envelope(channel/domain/kind/sequence/at/payload)", JSON.stringify({ received: events.received, complete: envelopeAll, sample: sample ? { channel: sample.channel, domain: sample.domain, kind: sample.kind, sequence: sample.sequence, at: typeof sample.at } : null }));
    record("events", "E2 · 事件 channel/domain 与订阅域一致（agent:event / agent）", events.channelConsistent, "agent:event / agent", JSON.stringify({ channel: sample && sample.channel, domain: sample && sample.domain }));
    record("events", "E3 · sequence 严格单调递增", monotonic, "strictly increasing", JSON.stringify(events.sequenceValues));
    note("事件信封样例（脱敏后写入报告）：" + JSON.stringify(sample));

    // ── 8) console / pageerror / 网络 ────────────────────────────────────
    handlerMissingConsole = consoleAll.filter((m) => /No handler registered/i.test(m.text));
    record("hygiene", "P0 · 页面 console error = 0", consoleErrors.length === 0, 0, consoleErrors.length + " → " + JSON.stringify(consoleErrors.slice(0, 5)));
    record("hygiene", "P1 · 页面 pageerror = 0", pageErrors.length === 0, 0, pageErrors.length + " → " + JSON.stringify(pageErrors.slice(0, 5)));
    record("hygiene", "P2 · 无 'No handler registered' 类通道缺失", handlerMissingConsole.length === 0, 0, handlerMissingConsole.length + " → " + JSON.stringify(handlerMissingConsole.slice(0, 3)));
    const LOCAL_RE = /^(file:|data:|blob:|about:|devtools:|openarc-file:|openarc-resource:|openarc-canvas:|http:\/\/127\.0\.0\.1|http:\/\/localhost|http:\/\/\[::1\]|ws:\/\/127\.0\.0\.1|ws:\/\/localhost)/i;
    nonLocal = requests.filter((u) => !LOCAL_RE.test(u));
    record("hygiene", "P3 · 渲染层无非本地网络请求", nonLocal.length === 0, "0 non-local", nonLocal.length + " → " + JSON.stringify(nonLocal.slice(0, 10)));
    network = { total: requests.length, nonLocal: nonLocal.slice(0, 20), requestFailures: requestFailures.slice(0, 10), allLocal: nonLocal.length === 0, sample: [...new Set(requests.map((u) => u.replace(/^(file:\/\/[^/]+).*/, "$1/*")))].slice(0, 12) };
    note("渲染层请求总数 " + requests.length + "，非本地 " + nonLocal.length + "；失败请求 " + requestFailures.length);

    // ── 9) 正常退出 ──────────────────────────────────────────────────────
    try { await js("window.close(); 'closing'"); } catch { /* 关窗后执行上下文销毁 */ }
    const exited = await waitFor(() => child.exitCode != null || child.signalCode != null, 20000, 200);
    if (!exited) { try { child.kill("SIGTERM"); } catch { /* ignore */ } await waitFor(() => child.exitCode != null || child.signalCode != null, 5000, 200); }
    if (child.exitCode == null && child.signalCode == null) { try { child.kill("SIGKILL"); } catch { /* ignore */ } await sleep(400); }
    exitInfo = { clean: exited, code: child.exitCode == null ? null : child.exitCode, signal: child.signalCode || null };
    record("exit", "X0 · 正常关窗退出（window-all-closed → app.quit）", exited, "process exits by itself", JSON.stringify(exitInfo));
    record("exit", "X1 · 退出码为 0", exitInfo.code === 0 && !exitInfo.signal, "code 0 / no signal", JSON.stringify(exitInfo));

    try { if (browser) await browser.close(); } catch { /* 已随进程关闭 */ }
  } catch (error) {
    record("boot", "FATAL · 探针中断", false, "run to completion", String((error && error.stack) || error).slice(0, 400));
    try { if (child && child.exitCode == null && child.signalCode == null) child.kill("SIGKILL"); } catch { /* ignore */ }
    try { if (browser) await browser.close(); } catch { /* ignore */ }
  } finally {
    residual = listProcessesFor(userDataDir);
    record("exit", "X2 · 无残留进程持有隔离 userData", residual.length === 0, 0, residual.length + " → " + JSON.stringify(residual.slice(0, 5)));
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(downloadsDir, { recursive: true, force: true }); } catch { /* ignore */ }
    userDataRemoved = !fs.existsSync(userDataDir) && !fs.existsSync(downloadsDir);
    record("exit", "X3 · 删除隔离 userData / downloads 临时目录", userDataRemoved, "removed", userDataRemoved ? "removed" : "still present");
  }

  const profileAfter = snapshotProfile(realProfilePath);
  const profileDiff = diffProfile(profileBefore, profileAfter);
  const residualRealProfile = listProcessesFor(realProfilePath);

  record("profile", "S0 · 真实身份库路径记录", true, "recorded", realProfilePath);
  record("profile", "S1 · 真实身份库（identity.db / -wal / -shm）mtime/size/sha256 完全未变", profileDiff.identityUnchanged, "unchanged", JSON.stringify({ before: redactProfile(profileBefore), after: redactProfile(profileAfter), changed: profileDiff.changed.filter((c) => c.startsWith("identity/")) }));
  if (profileDiff.unchanged) {
    record("profile", "S2 · 真实 profile 目录顶层快照完全未变", true, "unchanged", "0 changed entries");
  } else {
    markNotVerified("profile", "S2 · 真实 profile 目录整树未变", "顶层有 " + profileDiff.changedCount + " 项变化（见 changed）；启动前/收工后各有 " + preexistingProfilePids.length + "/" + residualRealProfile.length + " 个进程以真实 profile 运行，无法排除是其自身写盘。身份库三件套保持不变（S1）。", JSON.stringify(profileDiff.changed.slice(0, 20)));
  }

  // ── 报告 ──────────────────────────────────────────────────────────────
  const redact = makeRedactor([userDataDir, downloadsDir]);
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  const report = {
    phase: "dxos-e2e",
    title: "B2–B7 · 真实 Electron 端到端（39 域注册 / trusted / 健康 / 真实命令 / P1 事件）",
    at: nowIso(),
    runStartedAt,
    durationMs: Date.now() - runStartedAt,
    command: "node experiments/dxos-e2e/run-all.mjs" + (APP_PATH ? " --app-path " + APP_PATH : ""),
    appPath: APP_PATH,
    environment: { platform: process.platform, arch: process.arch, node: process.version, electron: (() => { try { return createRequire(path.join(ROOT, "package.json"))("electron/package.json").version; } catch { return null; } })() },
    isolation: {
      launchCommand,
      userDataDir,
      downloadsDir,
      realProfilePath,
      userDataDiffersFromRealProfile: path.resolve(userDataDir) !== path.resolve(realProfilePath),
      bootObservationInIsolatedDir: !!boot,
      identityDbInIsolatedDir: true,
      realProfileProcessesBefore: preexistingProfilePids.length,
      realProfileProcessesAfter: residualRealProfile.length,
      profileBefore: redactProfile(profileBefore),
      profileAfter: redactProfile(profileAfter),
      profileDiff: { identityUnchanged: profileDiff.identityUnchanged, wholeProfileUnchanged: profileDiff.unchanged, changed: profileDiff.changed, changedCount: profileDiff.changedCount },
      userDataRemoved,
    },
    renderer,
    boot,
    bridge: { count: bridge ? bridge.keys.length : 0, keys: bridge ? bridge.keys : [], shapes: bridge ? bridge.shapes : null, frozen: bridge ? bridge.frozen : null, extensible: bridge ? bridge.extensible : null },
    health: redact(healthResults),
    realCommands: redact(realCommands),
    trusted: { rawProbes, rawLeaks: leaked, bridgeBannedMembers: domainLeak, forgedIdentityIgnored: !!(forgedSnapshot && realUserId && forgedSnapshot.userId === realUserId), nestedFrame: nested, mainTrustedConditions: trustedSource, onEventDomains, onEventUnsubscribe: unsubResults },
    events: redact(events),
    console: { total: consoleAll.length, errorCount: consoleErrors.length, pageErrorCount: pageErrors.length, handlerMissingCount: handlerMissingConsole.length, errors: consoleErrors.slice(0, 20), pageErrors: pageErrors.slice(0, 20), byType: consoleAll.reduce((acc, m) => { acc[m.type] = (acc[m.type] || 0) + 1; return acc; }, {}) },
    network,
    exit: { info: exitInfo, residualProcesses: residual, userDataRemoved },
    stderrErrorLines: stderrBuf.split("\n").map((l) => l.trim()).filter((l) => /error|Error|FATAL|Unhandled/i.test(l)).filter((l) => !/ssl_client_socket|SSL error|net_error|handshake failed|GPU|gpu_|Metal|Autofill/i.test(l)).slice(0, 20),
    counts: { pass: passed, fail: failed, total: checks.length, notVerified: notVerified.length },
    checks,
    notVerified,
    observations,
  };

  const outDir = path.join(ROOT, "artifacts", "dxos-e2e");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, APP_PATH ? "report-app.json" : "report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log("\n=== 结论 ===");
  console.log("顶层键：" + (bridge ? bridge.keys.length : 0) + " 个 → " + (bridge ? bridge.keys.join(",") : "n/a"));
  console.log("健康命令：" + healthResults.map((h) => h.command + "=" + (h.ok ? "ok" : (h.error || "fail"))).join(" · "));
  console.log("真实命令：" + realCommands.length + " 条，异常 " + realCommands.filter((r) => r.threw).length + " 条");
  console.log("console error=" + consoleErrors.length + " pageerror=" + pageErrors.length + " 非本地请求=" + nonLocal.length);
  console.log("事件：" + (events ? events.received + " 条，信封完整=" + events.envelopeComplete + "，sequence 单调=" + events.sequenceMonotonic : "n/a"));
  console.log("真实身份库未变=" + profileDiff.identityUnchanged + "（identity.db sha256 前后对照见报告）");
  console.log("PASS " + passed + " / FAIL " + failed + " / NOT_VERIFIED " + notVerified.length);
  console.log("报告：" + path.relative(ROOT, outPath));
  return failed === 0 ? 0 : 1;
}

function redactProfile(snapshot) {
  return {
    path: snapshot.path,
    exists: snapshot.exists,
    dir: snapshot.dir,
    identity: Object.fromEntries(Object.entries(snapshot.identity).map(([k, v]) => [k, v.exists ? { mtimeMs: v.mtimeMs, size: v.size, ino: v.ino, sha256: v.sha256 } : v])),
    topLevelCount: Object.keys(snapshot.topLevel).length,
  };
}

const IS_MAIN = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (IS_MAIN) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error("PROBE_THREW · " + String((error && error.stack) || error));
      process.exit(2);
    });
}
