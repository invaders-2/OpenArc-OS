#!/usr/bin/env node
/**
 * B2-B7 · 真实 Electron **写链路** 端到端验收探针（任务 / 技能 / 开发者平台 / 媒体 / 自动化 / 平台快照 / 集成插件 + 重启持久化 + 拒绝路径）。
 *
 * 与只读探针 experiments/dxos-e2e/run-all.mjs 的分工：
 *   · 只读探针证明"命令注册 + 健康 + trusted + 事件 + 只读返回"；
 *   · 本探针只做一件事：把**每一条写链路**真的跑一遍 —— 真实命令 -> 真实落库/落盘 -> 读回断言 -> 事件断言。
 *
 * 隔离（最高优先级安全约束）：
 *   · 真实 profile（~/Library/Application Support/openarc-os）**只读**：开工前 / 收工后各做一次
 *     stat + sha256 快照（含 identity.db/-wal/-shm 与顶层目录），全程只用 fs 的 stat/read，**绝不用 SQLite 打开真实库**；
 *   · 应用本身用 --user-data-dir=<mkdtemp 临时目录> 启动（注入点与 scripts/dev-app.mjs 完全一致：
 *     该脚本把 --user-data-dir 透传给 electron，主进程 electron/main.cjs 用 app.getPath("userData") 取路径）；
 *   · 所有写入只落隔离 userData；收工后删除隔离目录并断言无残留进程。
 *
 * 覆盖（每条：真实命令 -> 真实落库/落盘 -> 读回断言 -> 事件断言）：
 *   1) 任务域    agent/project/create -> agent/task/create -> get -> events(sequence 单调) -> pause -> list -> answer(冲突拒绝)
 *   2) 技能域    skill/list -> enable -> run(文本分支) -> 读 skills.json -> disable
 *   3) 开发者平台 临时目录自造最小 dx-app/v2 包 -> validate -> install -> enable -> disable -> (升级后)rollback -> uninstall
 *                + 三个非法包（缺字段 / 危险权限 / 入口越界）被拒且无残留；app_runtime_events 记录逐条断言
 *   4) 媒体域    project/ensure -> asset/save -> render/submit -> render/run(真实 ffmpeg) -> 产物落盘 + ffprobe 可读
 *                + 第二条作业 render/cancel 取消路径
 *   5) 自动化    create -> enable -> runNow（含失败重试与取消各一条）-> automation_runs 落行、终态正确
 *   6) 平台      data/snapshot/create -> list -> verify -> restore（隔离目录内往返）+ 快照内不含凭据文件
 *   7) 集成插件  integration/plugins/enable(天气) -> integrations.json 落盘 -> 重启后仍为启用（持久化）
 *   8) 重启持久化 关闭应用 -> 同一隔离 userData 重启 -> 读回 1/2/3/5/7 状态并与关闭前对照一致
 *   9) 拒绝路径  未认证 / 伪造身份 / 未白名单命令 / 越权(网络白名单拒绝) / 依赖缺失，各断言结构化错误码且无副作用
 *  10) 证据      artifacts/dxos-e2e-write/report.json（原始返回 / 落盘路径 / 事件样例 / 重启前后对照 / 真实 profile 零改动 / console+pageerror 统计）
 *
 * 硬约束：不联网（只连本机 CDP；并断言渲染层无非本地请求）；不执行 / 修改 DX OS 业务数据之外的真实 profile；
 *         不新增依赖；不改产品代码；失败 exit 非 0。
 *
 * 用法：
 *   OA_DXOS_WRITE_CDP_PORT=9796 node experiments/dxos-e2e-write/run-all.mjs
 *
 * 本文件导出 WHITELISTS / WRITE_CONTRACT / REPORT_REL 供 tests/dxos-e2e-write-contract.test.mjs
 * **离线**核对（不启动 Electron）；只有被直接执行时才会启动 Electron。
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
export const REPORT_REL = "artifacts/dxos-e2e-write/report.json";

/** 命令白名单的真实来源（module 路径相对仓库根；导出名即 domain / bootstrap 的真实导出）。 */
export const WHITELISTS = Object.freeze({
  AGENT_COMMANDS: "electron/agent-domain.cjs",
  SKILL_COMMANDS: "electron/skill-domain.cjs",
  MEDIA_COMMANDS: "electron/media-domain.cjs",
  AUTOMATION_COMMANDS: "electron/automation-domain.cjs",
  PLATFORM_COMMANDS: "electron/platform-domain.cjs",
  DEVELOPER_COMMANDS: "electron/developer-domain.cjs",
  INTEGRATION_COMMANDS: "electron/plugin-service.cjs",
});

/**
 * 写链路契约（探针运行时的唯一驱动清单；离线契约测试逐条与真实白名单对齐）。
 *   kind:   write（会产生落库/落盘副作用）| read | reject（预期结构化拒绝）
 *   expect: ok（预期 ok:true）| error（预期 ok:false）| ok-or-structured
 */
export const WRITE_CONTRACT = Object.freeze([
  // ---- 1) 任务域 ----
  { id: "task-project-create", section: "task", channel: "agent", command: "agent/project/create", whitelist: "AGENT_COMMANDS", kind: "write", expect: "ok" },
  { id: "task-create", section: "task", channel: "agent", command: "agent/task/create", whitelist: "AGENT_COMMANDS", kind: "write", expect: "ok" },
  { id: "task-get", section: "task", channel: "agent", command: "agent/task/get", whitelist: "AGENT_COMMANDS", kind: "read", expect: "ok" },
  { id: "task-events", section: "task", channel: "agent", command: "agent/task/events", whitelist: "AGENT_COMMANDS", kind: "read", expect: "ok" },
  { id: "task-answer-conflict", section: "task", channel: "agent", command: "agent/task/answer", whitelist: "AGENT_COMMANDS", kind: "reject", expect: "error" },
  { id: "task-pause", section: "task", channel: "agent", command: "agent/task/pause", whitelist: "AGENT_COMMANDS", kind: "write", expect: "ok" },
  { id: "task-list", section: "task", channel: "agent", command: "agent/task/list", whitelist: "AGENT_COMMANDS", kind: "read", expect: "ok" },
  { id: "task-cancel", section: "task", channel: "agent", command: "agent/task/cancel", whitelist: "AGENT_COMMANDS", kind: "write", expect: "ok" },

  // ---- 2) 技能域 ----
  { id: "skill-list", section: "skill", channel: "skill", command: "skill/list", whitelist: "SKILL_COMMANDS", kind: "read", expect: "ok" },
  { id: "skill-get", section: "skill", channel: "skill", command: "skill/get", whitelist: "SKILL_COMMANDS", kind: "read", expect: "ok" },
  { id: "skill-enable", section: "skill", channel: "skill", command: "skill/enable", whitelist: "SKILL_COMMANDS", kind: "write", expect: "ok" },
  { id: "skill-run-text", section: "skill", channel: "skill", command: "skill/run", whitelist: "SKILL_COMMANDS", kind: "write", expect: "ok-or-structured" },
  { id: "skill-disable", section: "skill", channel: "skill", command: "skill/disable", whitelist: "SKILL_COMMANDS", kind: "write", expect: "ok" },

  // ---- 3) 开发者平台 ----
  { id: "developer-health", section: "developer", channel: "developer", command: "developer/health", whitelist: "DEVELOPER_COMMANDS", kind: "read", expect: "ok" },
  { id: "developer-validate", section: "developer", channel: "developer", command: "developer/validate", whitelist: "DEVELOPER_COMMANDS", kind: "read", expect: "ok" },
  { id: "developer-install", section: "developer", channel: "developer", command: "developer/install", whitelist: "DEVELOPER_COMMANDS", kind: "write", expect: "ok" },
  { id: "developer-get", section: "developer", channel: "developer", command: "developer/get", whitelist: "DEVELOPER_COMMANDS", kind: "read", expect: "ok" },
  { id: "developer-enable", section: "developer", channel: "developer", command: "developer/enable", whitelist: "DEVELOPER_COMMANDS", kind: "write", expect: "ok" },
  { id: "developer-disable", section: "developer", channel: "developer", command: "developer/disable", whitelist: "DEVELOPER_COMMANDS", kind: "write", expect: "ok" },
  { id: "developer-install-upgrade", section: "developer", channel: "developer", command: "developer/install", whitelist: "DEVELOPER_COMMANDS", kind: "write", expect: "ok" },
  { id: "developer-history", section: "developer", channel: "developer", command: "developer/history", whitelist: "DEVELOPER_COMMANDS", kind: "read", expect: "ok" },
  { id: "developer-rollback", section: "developer", channel: "developer", command: "developer/rollback", whitelist: "DEVELOPER_COMMANDS", kind: "write", expect: "ok" },
  { id: "developer-runtime-report", section: "developer", channel: "developer", command: "developer/runtime/report", whitelist: "DEVELOPER_COMMANDS", kind: "write", expect: "ok" },
  { id: "developer-uninstall", section: "developer", channel: "developer", command: "developer/uninstall", whitelist: "DEVELOPER_COMMANDS", kind: "write", expect: "ok" },
  { id: "developer-list", section: "developer", channel: "developer", command: "developer/list", whitelist: "DEVELOPER_COMMANDS", kind: "read", expect: "ok" },
  { id: "developer-reinstall", section: "developer", channel: "developer", command: "developer/install", whitelist: "DEVELOPER_COMMANDS", kind: "write", expect: "ok" },
  { id: "developer-network-reject", section: "developer", channel: "developer", command: "developer/network/request", whitelist: "DEVELOPER_COMMANDS", kind: "reject", expect: "error" },

  // ---- 4) 媒体域 ----
  { id: "media-health", section: "media", channel: "media", command: "media/health", whitelist: "MEDIA_COMMANDS", kind: "read", expect: "ok" },
  { id: "media-project-ensure", section: "media", channel: "media", command: "media/project/ensure", whitelist: "MEDIA_COMMANDS", kind: "write", expect: "ok" },
  { id: "media-asset-save", section: "media", channel: "media", command: "media/asset/save", whitelist: "MEDIA_COMMANDS", kind: "write", expect: "ok" },
  { id: "media-asset-list", section: "media", channel: "media", command: "media/asset/list", whitelist: "MEDIA_COMMANDS", kind: "read", expect: "ok" },
  { id: "media-render-submit", section: "media", channel: "media", command: "media/render/submit", whitelist: "MEDIA_COMMANDS", kind: "write", expect: "ok" },
  { id: "media-render-run", section: "media", channel: "media", command: "media/render/run", whitelist: "MEDIA_COMMANDS", kind: "write", expect: "ok" },
  { id: "media-render-get", section: "media", channel: "media", command: "media/render/get", whitelist: "MEDIA_COMMANDS", kind: "read", expect: "ok" },
  { id: "media-artifact-list", section: "media", channel: "media", command: "media/artifact/list", whitelist: "MEDIA_COMMANDS", kind: "read", expect: "ok" },
  { id: "media-render-cancel", section: "media", channel: "media", command: "media/render/cancel", whitelist: "MEDIA_COMMANDS", kind: "write", expect: "ok" },

  // ---- 5) 自动化 ----
  { id: "automation-health", section: "automation", channel: "automation", command: "automation/health", whitelist: "AUTOMATION_COMMANDS", kind: "read", expect: "ok" },
  { id: "automation-create", section: "automation", channel: "automation", command: "automation/create", whitelist: "AUTOMATION_COMMANDS", kind: "write", expect: "ok" },
  { id: "automation-list", section: "automation", channel: "automation", command: "automation/list", whitelist: "AUTOMATION_COMMANDS", kind: "read", expect: "ok" },
  { id: "automation-get", section: "automation", channel: "automation", command: "automation/get", whitelist: "AUTOMATION_COMMANDS", kind: "read", expect: "ok" },
  { id: "automation-enable", section: "automation", channel: "automation", command: "automation/enable", whitelist: "AUTOMATION_COMMANDS", kind: "write", expect: "ok" },
  { id: "automation-run-now", section: "automation", channel: "automation", command: "automation/runNow", whitelist: "AUTOMATION_COMMANDS", kind: "write", expect: "ok-or-structured" },
  { id: "automation-runs", section: "automation", channel: "automation", command: "automation/runs", whitelist: "AUTOMATION_COMMANDS", kind: "read", expect: "ok" },
  { id: "automation-cancel", section: "automation", channel: "automation", command: "automation/cancel", whitelist: "AUTOMATION_COMMANDS", kind: "write", expect: "ok" },
  { id: "automation-disable", section: "automation", channel: "automation", command: "automation/disable", whitelist: "AUTOMATION_COMMANDS", kind: "write", expect: "ok" },

  // ---- 6) 平台 ----
  { id: "platform-integrity", section: "platform", channel: "platform", command: "platform/data/integrity", whitelist: "PLATFORM_COMMANDS", kind: "read", expect: "ok" },
  { id: "platform-snapshot-create", section: "platform", channel: "platform", command: "platform/data/snapshot/create", whitelist: "PLATFORM_COMMANDS", kind: "write", expect: "ok" },
  { id: "platform-snapshot-list", section: "platform", channel: "platform", command: "platform/data/snapshot/list", whitelist: "PLATFORM_COMMANDS", kind: "read", expect: "ok" },
  { id: "platform-snapshot-verify", section: "platform", channel: "platform", command: "platform/data/snapshot/verify", whitelist: "PLATFORM_COMMANDS", kind: "read", expect: "ok" },
  { id: "platform-snapshot-restore", section: "platform", channel: "platform", command: "platform/data/snapshot/restore", whitelist: "PLATFORM_COMMANDS", kind: "write", expect: "ok" },

  // ---- 7) 集成插件 ----
  { id: "integration-plugins-list", section: "integration", channel: "integration", command: "integration/plugins/list", whitelist: "INTEGRATION_COMMANDS", kind: "read", expect: "ok" },
  { id: "integration-plugins-enable", section: "integration", channel: "integration", command: "integration/plugins/enable", whitelist: "INTEGRATION_COMMANDS", kind: "write", expect: "ok" },
  { id: "integration-plugins-get", section: "integration", channel: "integration", command: "integration/plugins/get", whitelist: "INTEGRATION_COMMANDS", kind: "read", expect: "ok" },
  { id: "integration-plugins-disable", section: "integration", channel: "integration", command: "integration/plugins/disable", whitelist: "INTEGRATION_COMMANDS", kind: "write", expect: "ok" },
  { id: "integration-dingtalk-status", section: "integration", channel: "integration", command: "integration/dingtalk/status", whitelist: "INTEGRATION_COMMANDS", kind: "read", expect: "ok" },
  { id: "integration-dingtalk-channel-save", section: "integration", channel: "integration", command: "integration/dingtalk/channels/save", whitelist: "INTEGRATION_COMMANDS", kind: "write", expect: "ok-or-structured" },

  // ---- 9) 拒绝路径 ----
  { id: "reject-agent-unauthenticated", section: "reject", channel: "agent", command: "agent/task/create", whitelist: "AGENT_COMMANDS", kind: "reject", expect: "error" },
  { id: "reject-agent-unknown", section: "reject", channel: "agent", command: "agent/probe/nonexistent", whitelist: null, kind: "reject", expect: "error" },
  { id: "reject-dependency-missing", section: "reject", channel: "automation", command: "automation/runNow", whitelist: "AUTOMATION_COMMANDS", kind: "reject", expect: "error" },
  { id: "reject-media-dependency", section: "reject", channel: "media", command: "media/figma-preview/build", whitelist: "MEDIA_COMMANDS", kind: "reject", expect: "error" },
]);

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------
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
async function waitFor(fn, timeoutMs, stepMs = 200) {
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
function resolveRealProfilePath() {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "openarc-os");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "openarc-os");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "openarc-os");
}
/** 真实 profile 的前后对照快照：目录 + 顶层条目 + 身份库三件套（含 sha256）。只读 stat/hash，绝不开库。 */
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
function redactProfile(snapshot) {
  return {
    path: snapshot.path,
    exists: snapshot.exists,
    dir: snapshot.dir,
    identity: Object.fromEntries(Object.entries(snapshot.identity).map(([k, v]) => [k, v.exists ? { mtimeMs: v.mtimeMs, size: v.size, ino: v.ino, sha256: v.sha256 } : v])),
    topLevelCount: Object.keys(snapshot.topLevel).length,
  };
}
function listProcessesFor(dir) {
  try {
    const text = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    return text.split("\n").filter((line) => line.includes(dir)).map((line) => {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      return m ? { pid: Number(m[1]), command: m[2].slice(0, 200) } : null;
    }).filter(Boolean).slice(0, 16);
  } catch { return []; }
}

/**
 * B7j：本机 loopback Webhook 夹具（只监听 127.0.0.1，不连外网）。
 * 用于给「钉钉群机器人」一个真实可达的发送目标，从而验证 automation 动作能走到真实成功终态。
 * 返回 { server, port, received }；received 记录每次 POST 的 url 与 body。
 */
function startWebhookFixture() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, body: body.slice(0, 4000), at: Date.now() });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ errcode: 0, errmsg: "ok" }));
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, received }));
  });
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

function classify(result) {
  if (!result || typeof result !== "object") return { structured: false, threw: false, handlerMissing: false, note: "not-an-object" };
  if (result.__threw) {
    return { structured: false, threw: true, handlerMissing: /No handler registered|No handler|not registered/i.test(String(result.message || "")), note: String(result.message || "").slice(0, 240) };
  }
  const value = result.value;
  const hasOk = typeof value === "object" && value !== null && typeof value.ok === "boolean";
  const hasError = typeof value === "object" && value !== null && typeof value.error === "string";
  return { structured: hasOk || hasError, threw: false, handlerMissing: /No handler registered/i.test(String((value && value.error) || "")), note: hasOk ? "ok-boolean" : hasError ? "error-code" : "unrecognized-shape" };
}
function isStructuredErrorCode(code) {
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,}$/.test(code);
}
function okValue(result) { return !!(result && result.__ok && result.value && result.value.ok === true); }
function errValue(result) { return result && result.value && typeof result.value.error === "string" ? result.value.error : null; }

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const require = createRequire(path.join(ROOT, "package.json"));
  const { chromium } = require("@playwright/test");
  const electronPath = require("electron");
  const { writeZip } = require(path.join(ROOT, "electron", "canvas-dxos-zip.cjs"));

  const runStartedAt = Date.now();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-dxos-write-"));
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-dxos-write-src-"));
  const realProfilePath = resolveRealProfilePath();
  const profileBefore = snapshotProfile(realProfilePath);
  const realProfilePidsBefore = listProcessesFor(realProfilePath);
  // B7j：本机 loopback Webhook 夹具（automation 的钉钉成功路径用）。
  const webhookFixture = await startWebhookFixture();

  const checks = [];
  const notVerified = [];
  const observations = [];
  const commands = [];
  const consoleAll = [];
  const consoleErrors = [];
  const pageErrors = [];
  const requests = [];
  const requestFailures = [];

  const record = (section, name, ok, expected, actual, detail) => {
    const row = { section, name, ok: !!ok, expected: String(expected == null ? "" : expected), actual: String(actual == null ? "" : actual).slice(0, 500), detail: detail || null };
    checks.push(row);
    console.log((row.ok ? "PASS" : "FAIL") + " [" + section + "] " + name + " :: actual=" + row.actual + " expected=" + row.expected);
    return row.ok;
  };
  const markNotVerified = (section, name, reason, repro) => {
    notVerified.push({ section, name, reason, repro: repro || null });
    console.log("NOT_VERIFIED [" + section + "] " + name + " :: " + reason);
  };
  const note = (line) => { observations.push(line); console.log("   · " + line); };
  const scenario = async (name, fn) => {
    try { await fn(); }
    catch (error) { record(name, "SCENARIO_THREW", false, "no throw", String((error && error.stack) || error).slice(0, 500)); }
  };

  // 隔离库读取（node:sqlite 只读；只用于隔离目录，绝不指向真实 profile）
  function openIsolatedDb() {
    const dbPath = path.join(userDataDir, "identity.db");
    if (!fs.existsSync(dbPath)) return null;
    const { DatabaseSync } = require("node:sqlite");
    try { return new DatabaseSync(dbPath, { readOnly: true }); } catch { return null; }
  }
  function dbAll(db, sql, ...params) {
    if (!db) return { error: "no-db" };
    try { return db.prepare(sql).all(...params); } catch (error) { return { error: String((error && error.message) || error) }; }
  }
  function dbGet(db, sql, ...params) {
    if (!db) return { error: "no-db" };
    try { return db.prepare(sql).get(...params); } catch (error) { return { error: String((error && error.message) || error) }; }
  }
  const DB_TABLES = ["dx_tasks", "dx_task_events", "dx_project_roots", "projects", "project_members", "video_render_jobs", "video_assets", "automations", "automation_runs", "app_market_releases", "user_installed_apps", "app_runtime_events", "app_network_audit"];
  function dbTableCounts(db) {
    const out = {};
    for (const t of DB_TABLES) {
      const row = dbGet(db, "SELECT COUNT(*) AS c FROM " + t);
      out[t] = row && typeof row.c === "number" ? row.c : (row && row.error ? "error" : null);
    }
    return out;
  }

  /** 隔离目录下 dxos/ 的文件清单（相对路径 + size + mtime + 小文件 sha256）；用于拒绝路径的"无副作用"对照。 */
  function snapshotIsolatedDxos() {
    const root = path.join(userDataDir, "dxos");
    const out = { db: statOf(path.join(userDataDir, "identity.db")), files: {} };
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(abs); continue; }
        if (!entry.isFile()) continue;
        const rel = path.relative(root, abs).split(path.sep).join("/");
        const st = statOf(abs);
        out.files[rel] = { size: st.size, mtimeMs: st.mtimeMs, sha256: st.size <= 512 * 1024 ? sha256File(abs) : null };
      }
    };
    walk(root);
    return out;
  }
  function diffIsolated(before, after, dbBefore, dbAfter) {
    const changedFiles = [];
    for (const rel of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
      if (JSON.stringify(before.files[rel] || null) !== JSON.stringify(after.files[rel] || null)) changedFiles.push(rel);
    }
    const changedTables = [];
    if (dbBefore && dbAfter) {
      for (const t of Object.keys(dbAfter)) if (dbBefore[t] !== dbAfter[t]) changedTables.push(t + ":" + dbBefore[t] + "->" + dbAfter[t]);
    }
    return { changedFiles: changedFiles.slice(0, 30), changedTables: changedTables.slice(0, 30), unchanged: changedFiles.length === 0 && changedTables.length === 0 };
  }

  // 测试素材：真实 ffmpeg 生成一段 2s 小视频
  const mp4Path = path.join(scratchDir, "probe-input.mp4");
  let mp4Generated = false;
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=320x240:r=24:d=2", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-t", "2", "-y", mp4Path], { stdio: "pipe" });
    mp4Generated = fs.existsSync(mp4Path) && fs.statSync(mp4Path).size > 0;
  } catch (error) { mp4Generated = false; note("ffmpeg 生成测试素材失败：" + String((error && error.message) || error)); }
  const mp4Base64 = mp4Generated ? fs.readFileSync(mp4Path).toString("base64") : "";

  // 自造 dx-app/v2 包（写进临时目录，再 base64 上传）
  const packagesDir = path.join(scratchDir, "packages");
  fs.mkdirSync(packagesDir, { recursive: true });
  function buildDevPackage(name, manifest, entries) {
    const zip = writeZip([{ name: "dx-app.json", data: Buffer.from(JSON.stringify(manifest)) }, ...(entries || [{ name: "index.html", data: Buffer.from("<html><head><title>probe</title></head><body>probe app</body></html>") }])]);
    const abs = path.join(packagesDir, name + ".zip");
    fs.writeFileSync(abs, zip);
    return { abs, base64: zip.toString("base64"), bytes: zip.length };
  }
  const APP_ID = "probe-app";
  const APP_RUNTIME_ID = "dev-" + APP_ID;
  const legalManifestV1 = { format: "dx-app/v2", id: APP_ID, name: "Probe App", description: "DXOS E2E probe developer application", version: "1.0.0", build: 1, permissions: ["project.read"], network: { domains: ["api.example.com"] } };
  const legalManifestV2 = { format: "dx-app/v2", id: APP_ID, name: "Probe App", description: "DXOS E2E probe developer application", version: "1.0.1", build: 2, permissions: ["project.read"], network: { domains: ["api.example.com"] } };
  const pkgV1 = buildDevPackage("probe-app-1.0.0", legalManifestV1);
  const pkgV2 = buildDevPackage("probe-app-1.0.1", legalManifestV2);
  const badMissing = buildDevPackage("probe-app-bad-missing", { format: "dx-app/v2", id: "bad-missing", name: "Bad Missing", version: "1.0.0", build: 1 });
  const badPermission = buildDevPackage("probe-app-bad-permission", { format: "dx-app/v2", id: "bad-permission", name: "Bad Permission", description: "dangerous permission probe package", version: "1.0.0", build: 1, permissions: ["system.exec"] });
  const badEntry = buildDevPackage("probe-app-bad-entry", { format: "dx-app/v2", id: "bad-entry", name: "Bad Entry", description: "entry escape probe package", version: "1.0.0", build: 1, entry: "../escape.html" });

  // 启动 / 关闭
  let page = null;
  let browser = null;
  let child = null;
  let stderrBuf = "";
  const launches = [];
  const js = (code) => page.evaluate("(async () => { " + code + " })()");

  async function startApp(tag) {
    const cdpPort = Number(process.env.OA_DXOS_WRITE_CDP_PORT) || (await freePort());
    const args = [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + cdpPort];
    const env = { ...process.env, OPENARC_E2E_OBSERVE: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.OA_DEV_SERVER;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    child = spawn(electronPath, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
    child.stdout.on("data", () => {});
    child.stderr.on("data", (d) => { stderrBuf += String(d); });
    const cdpReady = await waitFor(async () => {
      try { const res = await fetch("http://127.0.0.1:" + cdpPort + "/json/version"); return res.ok; } catch { return false; }
    }, 45000, 300);
    if (!cdpReady) throw new Error("CDP 未就绪（" + tag + "）：" + stderrBuf.slice(-500));
    browser = await chromium.connectOverCDP("http://127.0.0.1:" + cdpPort);
    const context = browser.contexts()[0];
    const isUI = (p) => p.url().includes("index.html");
    const found = await waitFor(() => !!context.pages().find(isUI), 30000, 300);
    page = context.pages().find(isUI) || null;
    if (!found || !page) throw new Error("未找到界面页面（" + tag + "）：" + context.pages().map((p) => p.url()).join(" | "));
    page.on("console", (msg) => {
      const row = { type: msg.type(), text: String(msg.text()).slice(0, 400) };
      consoleAll.push(row);
      if (row.type === "error") consoleErrors.push(row.text);
    });
    page.on("pageerror", (err) => pageErrors.push(String((err && err.message) || err).slice(0, 400)));
    page.on("request", (req) => requests.push(req.url()));
    page.on("requestfailed", (req) => requestFailures.push({ url: req.url(), error: String((req.failure() && req.failure().errorText) || "") }));
    const rendererReady = await waitFor(async () => {
      try { return (await js("return document.readyState === 'complete' && !!(window.openarc && window.openarc.agent)")) === true; } catch { return false; }
    }, 45000, 300);
    if (!rendererReady) throw new Error("渲染层未就绪（" + tag + "）");
    launches.push({ tag, cdpPort, bootObservation: fs.existsSync(path.join(userDataDir, "openarc-e2e-boot.json")) });
    return { tag, cdpPort };
  }

  async function closeApp(tag) {
    let exited = false;
    if (page) {
      try { await js("window.close(); return 'closing'"); } catch { /* 关窗后执行上下文销毁 */ }
      exited = await waitFor(() => child && (child.exitCode != null || child.signalCode != null), 20000, 200);
    }
    if (!exited && child) { try { child.kill("SIGTERM"); } catch { /* ignore */ } exited = await waitFor(() => child.exitCode != null || child.signalCode != null, 6000, 200); }
    if (child && child.exitCode == null && child.signalCode == null) { try { child.kill("SIGKILL"); } catch { /* ignore */ } await sleep(600); }
    const info = { tag, exited, code: child ? child.exitCode : null, signal: child ? child.signalCode : null };
    try { if (browser) await browser.close(); } catch { /* 已随进程关闭 */ }
    browser = null; page = null; child = null;
    return info;
  }

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
  function shrinkPayload(payload) {
    if (!payload || typeof payload !== "object") return payload || null;
    const out = {};
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === "string" && v.length > 160) out[k] = "<string:" + v.length + ">";
      else if (k === "timeline") out[k] = "<timeline>";
      else out[k] = v;
    }
    return out;
  }
  async function call(section, id, channel, command, payload) {
    const res = await callDomain(channel, command, payload);
    const cls = classify(res);
    commands.push({
      section, id, channel, command,
      payload: shrinkPayload(payload),
      threw: cls.threw, handlerMissing: cls.handlerMissing, structured: cls.structured,
      ms: res.ms == null ? null : res.ms,
      ok: res.value && typeof res.value.ok === "boolean" ? res.value.ok : null,
      error: res.value && typeof res.value.error === "string" ? res.value.error : null,
      value: res.value === undefined ? null : res.value,
    });
    return res;
  }
  async function installEventCollectors() {
    return js("window.__ev = { agent: [], skill: [], media: [], automation: [] }; const unsubs = {}; for (const d of ['agent','skill','media','automation']) { const api = window.openarc[d]; if (api && typeof api.onEvent === 'function') unsubs[d] = api.onEvent(function (e) { window.__ev[d].push(e); }); } return Object.keys(unsubs);");
  }
  async function drainEvents(domain) {
    const expr = "const list = (window.__ev && window.__ev[" + JSON.stringify(domain) + "]) || []; if (window.__ev) window.__ev[" + JSON.stringify(domain) + "] = []; return list;";
    try { return await js(expr); } catch { return []; }
  }
  function envelopesValid(list) {
    return Array.isArray(list) && list.length > 0 && list.every((e) => e && typeof e.channel === "string" && typeof e.domain === "string" && typeof e.kind === "string" && typeof e.sequence === "number" && typeof e.at === "number" && "payload" in e);
  }
  function monotonic(list) {
    for (let i = 1; i < (list || []).length; i += 1) if (!(list[i].sequence > list[i - 1].sequence)) return false;
    return true;
  }

  const result = {
    unauthorized: [], task: {}, skill: {}, developer: { installs: [], invalid: [], events: [] }, media: {}, automation: { runs: [], events: [] },
    integration: {}, persistence: { before: null, after: null, matches: null }, platform: {}, rejection: {}, db: {}, events: {}, launches, exit: [],
  };
  let taskId = null;
  let projectId = null;
  let cancelledTaskId = null;
  let assetId = null;
  let renderJobId = null;
  let cancelledJobId = null;
  let automationFailedId = null;
  let automationRetryId = null;
  let automationCancelId = null;
  let snapshotId = null;

  const isolation = {
    launchCommand: "electron . --user-data-dir=<isolated> --remote-debugging-port=<free>",
    userDataDir,
    scratchDir,
    realProfilePath,
    userDataDiffersFromRealProfile: path.resolve(userDataDir) !== path.resolve(realProfilePath),
    realProfileProcessesBefore: realProfilePidsBefore.length,
    injectionPoint: "scripts/dev-app.mjs 的 spawn(electron, [\".\", \"--user-data-dir=\" + userDataDir, ...]) 与 electron/main.cjs 的 app.getPath(\"userData\")",
    mp4Generated,
  };

  try {
    // ================= APP #1 =================
    await startApp("app1");
    record("boot", "B0 · 隔离 userData 启动真实 Electron（app1）", true, "CDP ready", launches[0].cdpPort + " / boot=" + launches[0].bootObservation);
    record("boot", "B1 · 隔离 userData ≠ 真实 profile", path.resolve(userDataDir) !== path.resolve(realProfilePath), "different", userDataDir);
    await installEventCollectors();
    await drainEvents("agent"); await drainEvents("skill"); await drainEvents("media"); await drainEvents("automation");

    // 9a) 未认证拒绝（登录前）
    await scenario("reject", async () => {
      for (const [section, channel, command, payload] of [
        ["agent", "agent", "agent/task/create", { projectId: "p", instruction: "x" }],
        ["skill", "skill", "skill/enable", { skillId: "chat" }],
        ["developer", "developer", "developer/list", {}],
        ["media", "media", "media/project/ensure", { projectId: "00000000-0000-4000-8000-000000000000" }],
        ["automation", "automation", "automation/list", {}],
        ["platform", "platform", "platform/data/snapshot/list", {}],
      ]) {
        const res = await call("reject", "pre-login-" + section + "-" + command, channel, command, payload);
        const code = errValue(res);
        result.unauthorized.push({ section, channel, command, ok: res.value && res.value.ok, error: code, structured: isStructuredErrorCode(code) });
        record("reject", "R0 · 登录前 " + command + " 被结构化拒绝", res.value && res.value.ok === false && isStructuredErrorCode(code), "ok:false + *_UNAUTHENTICATED", String(code || JSON.stringify(res.value || res).slice(0, 200)));
      }
    });

    // 身份
    const identifier = "dxos-e2e-write@openarc.test";
    const password = "Dxos-write-password-1";
    const initialized = await call("boot", "identity-initialize", "identity", "identity/initialize", { identifier, password, displayName: "DXOS Write Probe" });
    const loggedIn = await call("boot", "identity-login", "identity", "identity/login", { identifier, password });
    const realUserId = loggedIn.__ok && loggedIn.value && loggedIn.value.snapshot ? loggedIn.value.snapshot.userId : null;
    record("boot", "B2 · 首启初始化 + 登录（sessionRef 由主进程注入）", !!realUserId, "userId", String(realUserId));
    if (!realUserId) throw new Error("登录失败，后续写链路无法继续：" + JSON.stringify(loggedIn.value || loggedIn).slice(0, 300));

    // === 1) 任务域 ===
    await scenario("task", async () => {
      const proj = await call("task", "task-project-create", "agent", "agent/project/create", { name: "E2E 写链路项目", rootNodeId: "root-" + Date.now() });
      projectId = proj.value && proj.value.value && proj.value.value.project ? proj.value.value.project.id : null;
      record("task", "T1 · agent/project/create 真实建项目", okValue(proj) && !!projectId, "ok:true + projectId", String(projectId));

      const created = await call("task", "task-create", "agent", "agent/task/create", { projectId, instruction: "端到端写链路：创建任务", title: "E2E 写链路任务" });
      taskId = created.value && created.value.value && created.value.value.task ? created.value.value.task.taskId : null;
      record("task", "T2 · agent/task/create 真实落库并返回 taskId", okValue(created) && !!taskId, "ok:true + taskId", String(taskId));

      const got = await call("task", "task-get", "agent", "agent/task/get", { taskId });
      const gotStatus = got.value && got.value.value && got.value.value.task ? got.value.value.task.status : null;
      record("task", "T3 · agent/task/get 读回该任务", okValue(got) && gotStatus === "queued", "ok:true + status=queued", String(gotStatus));

      const ev1 = await call("task", "task-events", "agent", "agent/task/events", { taskId, afterSequence: 0 });
      const items1 = ev1.value && ev1.value.value && Array.isArray(ev1.value.value.items) ? ev1.value.value.items : [];
      const seqs1 = items1.map((it) => it.sequence);
      record("task", "T4 · agent/task/events 返回事件且 sequence 严格单调", items1.length > 0 && monotonic(seqs1.map((s) => ({ sequence: s }))), ">=1 event + monotonic", JSON.stringify(seqs1));

      const answer = await call("task", "task-answer-conflict", "agent", "agent/task/answer", { taskId, answer: "不应答（任务不在等待提问）" });
      result.task.answerReject = { ok: answer.value && answer.value.ok, error: errValue(answer) };
      record("task", "T5 · agent/task/answer 在非等待态被结构化拒绝（无副作用）", answer.value && answer.value.ok === false && isStructuredErrorCode(errValue(answer)), "ok:false + 结构化码", String(errValue(answer)));

      const paused = await call("task", "task-pause", "agent", "agent/task/pause", { taskId });
      const pausedStatus = paused.value && paused.value.value && paused.value.value.task ? paused.value.value.task.status : null;
      record("task", "T6 · agent/task/pause 落库 status=paused", okValue(paused) && pausedStatus === "paused", "ok:true + paused", String(pausedStatus));

      const ev2 = await call("task", "task-events-after", "agent", "agent/task/events", { taskId, afterSequence: 0 });
      const items2 = ev2.value && ev2.value.value && Array.isArray(ev2.value.value.items) ? ev2.value.value.items : [];
      const seqs2 = items2.map((it) => it.sequence);
      record("task", "T7 · 暂停后事件追加且 sequence 仍严格单调", items2.length > seqs1.length && monotonic(seqs2.map((s) => ({ sequence: s }))), "更多事件 + monotonic", JSON.stringify(seqs2));
      result.task = Object.assign(result.task, { projectId, taskId, eventCountAfterPause: items2.length, sequences: seqs2, statusAfterPause: pausedStatus });

      const list = await call("task", "task-list", "agent", "agent/task/list", { projectId });
      const listItems = list.value && list.value.value && Array.isArray(list.value.value.items) ? list.value.value.items : [];
      record("task", "T8 · agent/task/list 可见该任务", okValue(list) && listItems.some((it) => it.taskId === taskId), "含 taskId", JSON.stringify(listItems.map((it) => it.taskId)));

      const created2 = await call("task", "task-create-cancel", "agent", "agent/task/create", { projectId, instruction: "端到端写链路：取消任务", title: "E2E 取消任务" });
      cancelledTaskId = created2.value && created2.value.value && created2.value.value.task ? created2.value.value.task.taskId : null;
      const cancelled = await call("task", "task-cancel", "agent", "agent/task/cancel", { taskId: cancelledTaskId });
      const cancelledStatus = cancelled.value && cancelled.value.value && cancelled.value.value.task ? cancelled.value.value.task.status : null;
      record("task", "T9 · agent/task/cancel 落库 status=cancelled", okValue(cancelled) && cancelledStatus === "cancelled", "ok:true + cancelled", String(cancelledStatus));

      const taskEvents = await drainEvents("agent");
      result.events.agent = {
        received: taskEvents.length,
        envelopesComplete: envelopesValid(taskEvents),
        sequenceMonotonic: monotonic(taskEvents),
        kinds: [...new Set(taskEvents.map((e) => e.kind))],
        channels: [...new Set(taskEvents.map((e) => e.channel))],
        sample: taskEvents[0] || null,
      };
      record("task", "T10 · agent.onEvent 收到 P1 信封（channel/domain/kind/sequence/at/payload）", envelopesValid(taskEvents) && monotonic(taskEvents), ">=1 envelope + monotonic", JSON.stringify({ received: taskEvents.length, kinds: result.events.agent.kinds }));
    });

    // === 2) 技能域 ===
    await scenario("skill", async () => {
      const skillList = await call("skill", "skill-list", "skill", "skill/list", {});
      const skills = skillList.value && skillList.value.value && Array.isArray(skillList.value.value.items) ? skillList.value.value.items : [];
      const textSkill = skills.find((s) => s.kind === "text" && typeof s.id === "string");
      const skillId = textSkill ? textSkill.id : "chat";
      result.skill.skillId = skillId;
      result.skill.total = skills.length;
      record("skill", "S1 · skill/list 返回内置技能目录", okValue(skillList) && skills.length > 0, ">=1 skill", skills.length + " 条，选择 " + skillId);

      const enable = await call("skill", "skill-enable", "skill", "skill/enable", { skillId });
      const enabledFlag = enable.value && enable.value.value && enable.value.value.skill ? enable.value.value.skill.enabled : null;
      record("skill", "S2 · skill/enable 置 enabled=true", okValue(enable) && enabledFlag === true, "ok:true + enabled", String(enabledFlag));

      const skillsJsonPath = path.join(userDataDir, "dxos", "skills.json");
      const persistedAfterEnable = fs.existsSync(skillsJsonPath) ? JSON.parse(fs.readFileSync(skillsJsonPath, "utf8")) : null;
      const enableOverride = persistedAfterEnable && persistedAfterEnable.enabled ? persistedAfterEnable.enabled[skillId] : undefined;
      record("skill", "S3 · 落盘 <userData>/dxos/skills.json 且记录该技能启用", !!persistedAfterEnable && enableOverride === true, "skills.json.enabled[" + skillId + "]=true", JSON.stringify({ path: "dxos/skills.json", override: enableOverride, keys: persistedAfterEnable ? Object.keys(persistedAfterEnable) : null }));

      const run = await call("skill", "skill-run-text", "skill", "skill/run", { skillId, arguments: { instruction: "用一句话说明这是一个离线探针。" } });
      const runOk = okValue(run);
      const runErr = errValue(run);
      const runText = run.value && run.value.value && typeof run.value.value.text === "string" ? run.value.value.text : null;
      result.skill.run = { ok: runOk, error: runErr, textLength: runText ? runText.length : 0 };
      if (runOk) {
        record("skill", "S4 · skill/run 文本分支真实执行并返回文本", !!runText && runText.length > 0, "ok:true + text", JSON.stringify({ length: runText ? runText.length : 0, model: run.value.value.meta ? run.value.value.meta.model : null }));
      } else {
        record("skill", "S4 · skill/run 返回结构化错误（非未捕获异常）", isStructuredErrorCode(runErr), "结构化错误码", String(runErr));
        markNotVerified("skill", "S4 · skill/run 文本分支成功产出文本",
          "离线环境下没有可用模型站点：resolveChatTarget 在 provider-protocol 无启用 provider 时抛错，归一到 " + String(runErr || "结构化错误") + "。本探针不联网、不注入假模型，故不伪造成功。",
          "登录后执行 window.openarc.skill.command({ type: 'skill/run', skillId: '" + skillId + "', arguments: { instruction: 'hi' } })；先经 model:command 的 provider/create + model/create 装配可达模型站点即可成功。");
      }
      result.skill.runErrorCode = runErr;

      const get = await call("skill", "skill-get", "skill", "skill/get", { skillId });
      record("skill", "S5 · skill/get 读回技能详情", okValue(get) && !!(get.value.value && get.value.value.skill), "ok:true", JSON.stringify(Object.keys((get.value.value && get.value.value.skill) || {})));

      const disable = await call("skill", "skill-disable", "skill", "skill/disable", { skillId });
      const disabledFlag = disable.value && disable.value.value && disable.value.value.skill ? disable.value.value.skill.enabled : null;
      const persistedAfterDisable = fs.existsSync(skillsJsonPath) ? JSON.parse(fs.readFileSync(skillsJsonPath, "utf8")) : null;
      const disableOverride = persistedAfterDisable && persistedAfterDisable.enabled ? persistedAfterDisable.enabled[skillId] : undefined;
      record("skill", "S6 · skill/disable 落库 + skills.json 记录停用", okValue(disable) && disabledFlag === false && disableOverride === false, "enabled=false + skills.json false", JSON.stringify({ flag: disabledFlag, override: disableOverride }));

      await call("skill", "skill-enable-persist", "skill", "skill/enable", { skillId });
      const persistedFinal = fs.existsSync(skillsJsonPath) ? JSON.parse(fs.readFileSync(skillsJsonPath, "utf8")) : null;
      record("skill", "S7 · 为重启持久化留启用态（再次 enable）", !!(persistedFinal && persistedFinal.enabled && persistedFinal.enabled[skillId] === true), "skills.json.enabled=true", JSON.stringify(persistedFinal && persistedFinal.enabled));
      result.skill.skillsJsonPath = "dxos/skills.json";
    });

    // === 3) 开发者平台 ===
    await scenario("developer", async () => {
      const health = await call("developer", "developer-health", "developer", "developer/health", {});
      record("developer", "D1 · developer/health ok", okValue(health), "ok:true", JSON.stringify(health.value && health.value.value ? { ok: health.value.value.ok, tablesReady: health.value.value.tablesReady, commands: health.value.value.commands } : health.value));

      const validate = await call("developer", "developer-validate", "developer", "developer/validate", { packageBase64: pkgV1.base64, sourceName: "probe-app-1.0.0.zip" });
      record("developer", "D2 · developer/validate 离线校验合法包", okValue(validate) && !!(validate.value.value && validate.value.value.appId), "ok:true + appId", JSON.stringify(validate.value && validate.value.value).slice(0, 220));

      const packagesRoot = path.join(userDataDir, "dxos", "developer-apps", "packages");
      const install1 = await call("developer", "developer-install", "developer", "developer/install", { packageBase64: pkgV1.base64, sourceName: "probe-app-1.0.0.zip" });
      const installedVersion = install1.value && install1.value.value ? install1.value.value.version : null;
      record("developer", "D3 · developer/install 装载 v1.0.0", okValue(install1) && installedVersion === "1.0.0", "ok:true + 1.0.0", String(installedVersion));
      record("developer", "D4 · 包字节落盘 <userData>/dxos/developer-apps/packages/" + APP_RUNTIME_ID, fs.existsSync(path.join(packagesRoot, APP_RUNTIME_ID)), "dir exists", fs.existsSync(path.join(packagesRoot, APP_RUNTIME_ID)) ? "present" : "missing");

      const get = await call("developer", "developer-get", "developer", "developer/get", { appId: APP_RUNTIME_ID });
      record("developer", "D5 · developer/get 读回装载态", okValue(get) && get.value.value.version === "1.0.0", "ok:true + version 1.0.0", JSON.stringify(get.value.value && { appId: get.value.value.appId, version: get.value.value.version, enabled: get.value.value.enabled }));

      const enable = await call("developer", "developer-enable", "developer", "developer/enable", { appId: APP_RUNTIME_ID });
      record("developer", "D6 · developer/enable 启用", okValue(enable), "ok:true", JSON.stringify(enable.value.value).slice(0, 160));

      const disable = await call("developer", "developer-disable", "developer", "developer/disable", { appId: APP_RUNTIME_ID });
      record("developer", "D7 · developer/disable 停用（保留安装文件）", okValue(disable) && fs.existsSync(path.join(packagesRoot, APP_RUNTIME_ID)), "ok:true + 包目录保留", JSON.stringify(disable.value.value).slice(0, 160));

      const enableAgain = await call("developer", "developer-enable-again", "developer", "developer/enable", { appId: APP_RUNTIME_ID });
      record("developer", "D7b · 停用后再次 enable（产生 app.enable 事件）", okValue(enableAgain) && enableAgain.value.value.enabled === true, "ok:true + enabled", JSON.stringify({ changed: enableAgain.value.value.changed, enabled: enableAgain.value.value.enabled }));

      const install2 = await call("developer", "developer-install-upgrade", "developer", "developer/install", { packageBase64: pkgV2.base64, sourceName: "probe-app-1.0.1.zip" });
      const upgraded = install2.value && install2.value.value ? install2.value.value.version : null;
      record("developer", "D8 · developer/install 升级到 v1.0.1（保留回滚点）", okValue(install2) && upgraded === "1.0.1", "ok:true + 1.0.1", String(upgraded));

      const history = await call("developer", "developer-history", "developer", "developer/history", { appId: APP_RUNTIME_ID });
      const historyItems = history.value && history.value.value && Array.isArray(history.value.value.history) ? history.value.value.history : [];
      record("developer", "D9 · developer/history 含可回滚的 1.0.0", okValue(history) && historyItems.some((h) => h.version === "1.0.0"), "history 含 1.0.0", JSON.stringify(historyItems.map((h) => h.version)));

      const rollback = await call("developer", "developer-rollback", "developer", "developer/rollback", { appId: APP_RUNTIME_ID });
      const rolledBack = rollback.value && rollback.value.value ? rollback.value.value.version : null;
      record("developer", "D10 · developer/rollback 回到 v1.0.0", okValue(rollback) && rolledBack === "1.0.0", "ok:true + 1.0.0", String(rolledBack));

      const runtimeReport = await call("developer", "developer-runtime-report", "developer", "developer/runtime/report", { appId: APP_RUNTIME_ID, eventType: "e2e.probe", detail: { step: "write-chain" } });
      record("developer", "D11 · developer/runtime/report 写入 app_runtime_events", okValue(runtimeReport), "ok:true", JSON.stringify(runtimeReport.value.value).slice(0, 160));

      const uninstall = await call("developer", "developer-uninstall", "developer", "developer/uninstall", { appId: APP_RUNTIME_ID });
      record("developer", "D12 · developer/uninstall 卸载（清安装目录）", okValue(uninstall) && !fs.existsSync(path.join(packagesRoot, APP_RUNTIME_ID)), "ok:true + 目录清理", JSON.stringify(uninstall.value.value).slice(0, 160));

      const listAfterUninstall = await call("developer", "developer-list", "developer", "developer/list", {});
      const apps = listAfterUninstall.value && listAfterUninstall.value.value && Array.isArray(listAfterUninstall.value.value.apps) ? listAfterUninstall.value.value.apps : [];
      record("developer", "D13 · 卸载后 developer/list 不含该应用", okValue(listAfterUninstall) && !apps.some((a) => a.appId === APP_RUNTIME_ID), "不含 appId", JSON.stringify(apps.map((a) => a.appId)));

      const reinstall = await call("developer", "developer-reinstall", "developer", "developer/install", { packageBase64: pkgV1.base64, sourceName: "probe-app-1.0.0-reinstall.zip" });
      const reinstalledVersion = reinstall.value && reinstall.value.value ? reinstall.value.value.version : null;
      record("developer", "D14 · 重新装载并启用 v1.0.0（留作重启持久化）", okValue(reinstall) && reinstalledVersion === "1.0.0", "ok:true + 1.0.0", String(reinstalledVersion));

      const invalid = [
        { id: "bad-missing", pkg: badMissing, section: "缺字段（description < 8）", allowCodes: ["DEVELOPER_MANIFEST_INVALID", "DEVELOPER_PACKAGE_INVALID", "DEVELOPER_INVALID_INPUT"] },
        { id: "bad-permission", pkg: badPermission, section: "危险权限（system.exec）", allowCodes: ["DEVELOPER_PERMISSION_REJECTED", "DEVELOPER_MANIFEST_INVALID"] },
        { id: "bad-entry", pkg: badEntry, section: "入口越界（../escape.html）", allowCodes: ["DEVELOPER_MANIFEST_INVALID", "DEVELOPER_PATH_ESCAPE", "DEVELOPER_PACKAGE_INVALID"] },
      ];
      for (const item of invalid) {
        const res = await call("developer", "developer-install-" + item.id, "developer", "developer/install", { packageBase64: item.pkg.base64, sourceName: item.id + ".zip" });
        const code = errValue(res);
        const rejected = res.value && res.value.ok === false && isStructuredErrorCode(code) && item.allowCodes.includes(code);
        const runtimeId = "dev-" + item.id;
        const residueDir = fs.existsSync(path.join(packagesRoot, runtimeId));
        const listRes = await call("developer", "developer-list-after-" + item.id, "developer", "developer/list", {});
        const appIds = (listRes.value && listRes.value.value && listRes.value.value.apps || []).map((a) => a.appId);
        const noResidue = !residueDir && !appIds.includes(runtimeId);
        result.developer.invalid.push({ id: item.id, section: item.section, error: code, rejected, residueDir, listedAfter: appIds.includes(runtimeId) });
        record("developer", "D15 · 非法包被拒（" + item.section + "）", rejected, item.allowCodes.join("|"), String(code || JSON.stringify(res.value || res).slice(0, 160)));
        record("developer", "D16 · 非法包无残留（" + item.section + "）", noResidue, "无包目录 + developer/list 不含", JSON.stringify({ residueDir, listed: appIds.includes(runtimeId) }));
      }

      const runtimeDiag = await call("developer", "developer-runtime-events", "platform", "platform/diagnostics/app", { appId: APP_RUNTIME_ID });
      const diagRuntime = runtimeDiag.value && runtimeDiag.value.value && runtimeDiag.value.value.runtime ? runtimeDiag.value.value.runtime : null;
      const diagTypes = diagRuntime && Array.isArray(diagRuntime.summary) ? diagRuntime.summary.map((s) => s.eventType) : [];
      result.developer.runtimeEventTypesInProcess = diagTypes;
      record("developer", "D17 · platform/diagnostics/app 读到 app_runtime_events 记录", okValue(runtimeDiag) && diagTypes.length > 0, ">=1 runtime event", JSON.stringify(diagTypes));
    });

    // === 4) 媒体域 ===
    await scenario("media", async () => {
      const health = await call("media", "media-health", "media", "media/health", {});
      record("media", "M1 · media/health ok（ffmpeg/ffprobe 就绪）", okValue(health), "ok:true", JSON.stringify(health.value && health.value.value ? { ok: health.value.value.ok, dependencies: health.value.value.dependencies } : health.value).slice(0, 300));

      projectId = crypto.randomUUID();
      const ensure = await call("media", "media-project-ensure", "media", "media/project/ensure", { projectId, projectName: "E2E 媒体项目" });
      record("media", "M2 · media/project/ensure 建视频项目", okValue(ensure) && ensure.value.value.projectId === projectId, "ok:true + projectId", String(ensure.value.value && ensure.value.value.projectId));

      const save = await call("media", "media-asset-save", "media", "media/asset/save", { projectId, name: "probe-input.mp4", mime: "video/mp4", base64: mp4Base64 });
      assetId = save.value && save.value.value && save.value.value.asset ? save.value.value.asset.id : null;
      const assetKind = save.value && save.value.value && save.value.value.asset ? save.value.value.asset.kind : null;
      record("media", "M3 · media/asset/save 落盘素材 + ffprobe 探测元数据", okValue(save) && !!assetId && assetKind === "video", "ok:true + asset(kind=video)", JSON.stringify(save.value && save.value.value ? save.value.value.asset : save.value).slice(0, 300));

      const assetList = await call("media", "media-asset-list", "media", "media/asset/list", { projectId });
      const assets = assetList.value && assetList.value.value && Array.isArray(assetList.value.value.assets) ? assetList.value.value.assets : [];
      record("media", "M4 · media/asset/list 读回素材", okValue(assetList) && assets.some((a) => a.id === assetId), "含 assetId", JSON.stringify(assets.map((a) => a.id)));

      const timeline = {
        schemaVersion: "1.0", version: 1, timebase: 1000, durationMs: 1000,
        canvas: { width: 320, height: 240, fps: 24 }, outputProfileId: "probe-320p",
        tracks: [{ id: "track-video", name: "视频", type: "video", order: 0, clips: [{ id: "clip-1", trackId: "track-video", assetId, name: "clip-1", timelineStartMs: 0, durationMs: 1000, sourceInMs: 0, sourceOutMs: 1000 }] }],
      };
      const submit = await call("media", "media-render-submit", "media", "media/render/submit", { projectId, projectName: "E2E 媒体项目", timeline });
      renderJobId = submit.value && submit.value.value && submit.value.value.job ? submit.value.value.job.id : null;
      record("media", "M5 · media/render/submit 作业入队", okValue(submit) && !!renderJobId, "ok:true + jobId", String(renderJobId));

      const run = await call("media", "media-render-run", "media", "media/render/run", { workerId: "e2e-worker" });
      const ranJob = run.value && run.value.value && run.value.value.job ? run.value.value.job : null;
      record("media", "M6 · media/render/run 真实 ffmpeg 渲染完成", okValue(run) && ranJob && ranJob.status === "completed", "ok:true + completed", JSON.stringify(ranJob).slice(0, 300));

      const get = await call("media", "media-render-get", "media", "media/render/get", { jobId: renderJobId });
      const job = get.value && get.value.value && get.value.value.job ? get.value.value.job : null;
      const outputRel = job ? job.outputRelativePath : null;
      const outputAbs = outputRel ? path.join(userDataDir, "dxos", "media", "renders", outputRel) : null;
      record("media", "M7 · media/render/get 读回 completed + hasOutput", okValue(get) && job && job.status === "completed" && job.hasOutput === true, "completed + hasOutput:true", JSON.stringify(job).slice(0, 300));
      record("media", "M8 · 真实产物落 <userData>/dxos/media/renders", !!outputAbs && fs.existsSync(outputAbs), "file exists", outputAbs ? path.basename(outputAbs) + " size=" + statOf(outputAbs).size : "missing");
      let probeOut = null;
      if (outputAbs && fs.existsSync(outputAbs)) {
        try {
          const dur = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", outputAbs], { encoding: "utf8" }).trim();
          probeOut = { durationSec: Number(dur), bytes: fs.statSync(outputAbs).size };
        } catch (error) { probeOut = { error: String((error && error.message) || error) }; }
      }
      record("media", "M9 · ffprobe 可读真实产物（时长≈1s）", !!probeOut && Number.isFinite(probeOut.durationSec) && probeOut.durationSec > 0.5 && probeOut.durationSec < 2.5, "0.5<duration<2.5", JSON.stringify(probeOut));
      result.media = Object.assign(result.media, { projectId, assetId, renderJobId, outputRelativePath: outputRel, outputBytes: probeOut && probeOut.bytes, ffprobe: probeOut, workerId: "e2e-worker" });

      const artifacts = await call("media", "media-artifact-list", "media", "media/artifact/list", {});
      const artifactItems = artifacts.value && artifacts.value.value && Array.isArray(artifacts.value.value.artifacts) ? artifacts.value.value.artifacts : [];
      record("media", "M10 · media/artifact/list 列出落盘产物", okValue(artifacts) && artifactItems.length > 0, ">=1 artifact", JSON.stringify(artifactItems.slice(0, 6)));

      const submit2 = await call("media", "media-render-submit-cancel", "media", "media/render/submit", { projectId, projectName: "E2E 媒体项目", timeline });
      cancelledJobId = submit2.value && submit2.value.value && submit2.value.value.job ? submit2.value.value.job.id : null;
      const cancel = await call("media", "media-render-cancel", "media", "media/render/cancel", { jobId: cancelledJobId });
      const cancelStatus = cancel.value && cancel.value.value && cancel.value.value.job ? cancel.value.value.job.status : null;
      const cancelOutput = cancelledJobId ? path.join(userDataDir, "dxos", "media", "renders", cancelledJobId + ".mp4") : null;
      record("media", "M11 · media/render/cancel 取消排队作业", okValue(cancel) && cancelStatus === "cancelled", "ok:true + cancelled", String(cancelStatus));
      record("media", "M12 · 取消的作业无产物落盘", !!cancelOutput && !fs.existsSync(cancelOutput), "无 <jobId>.mp4", cancelOutput ? path.basename(cancelOutput) + " exists=" + fs.existsSync(cancelOutput) : "n/a");
      const mediaEvents = await drainEvents("media");
      result.events.media = { received: mediaEvents.length, envelopesComplete: envelopesValid(mediaEvents), sequenceMonotonic: monotonic(mediaEvents), kinds: [...new Set(mediaEvents.map((e) => e.kind))], sample: mediaEvents[0] || null };
      record("media", "M13 · media.onEvent 收到渲染进度信封", envelopesValid(mediaEvents), ">=1 envelope", JSON.stringify(result.events.media.kinds));
    });

    // === 5) 自动化 ===
    await scenario("automation", async () => {
      const health = await call("automation", "automation-health", "automation", "automation/health", {});
      record("automation", "A1 · automation/health ok", okValue(health), "ok:true", JSON.stringify(health.value && health.value.value ? { status: health.value.value.status, dependencies: health.value.value.dependencies } : health.value).slice(0, 300));
      // B7j：health 必须如实列出每个适配器的注入状态与缺失原因（不只布尔）。
      const depDetails = health.value && health.value.value && Array.isArray(health.value.value.dependencyDetails) ? health.value.value.dependencyDetails : [];
      const depByName = Object.fromEntries(depDetails.map((item) => [item.name, item]));
      record("automation", "A1b · automation/health 列出每个适配器注入状态与缺失原因", !!(depByName.developerApps && depByName.developerApps.injected === true && depByName.toolCatalog && depByName.toolCatalog.injected === true && depByName.agent && depByName.agent.injected === true && depByName.integrations && depByName.integrations.injected === true && depByName.desktop && depByName.desktop.injected === false && /桌面执行端/.test(String(depByName.desktop.reason || ""))), "developerApps/integrations/toolCatalog/agent=true，desktop=false + 原因", JSON.stringify(depDetails).slice(0, 500));

      const createFailed = await call("automation", "automation-create", "automation", "automation/create", {
        title: "E2E 依赖缺失动作", instruction: "运行 music_play（桌面适配器未装配）",
        schedule: { type: "interval", everyMs: 3600000 }, action: { type: "music_play", args: { track: "probe" } },
      });
      automationFailedId = createFailed.value && createFailed.value.value && createFailed.value.value.automation ? createFailed.value.value.automation.id : null;
      record("automation", "A2 · automation/create 建定义", okValue(createFailed) && !!automationFailedId, "ok:true + automationId", String(automationFailedId));

      const list = await call("automation", "automation-list", "automation", "automation/list", {});
      const automations = list.value && list.value.value && Array.isArray(list.value.value.automations) ? list.value.value.automations : [];
      record("automation", "A3 · automation/list 读回定义", okValue(list) && automations.some((a) => a.id === automationFailedId), "含 automationId", JSON.stringify(automations.map((a) => a.id)));

      const get = await call("automation", "automation-get", "automation", "automation/get", { automationId: automationFailedId });
      record("automation", "A4 · automation/get 读回定义", okValue(get) && !!(get.value.value && get.value.value.automation), "ok:true", JSON.stringify(get.value.value && get.value.value.automation).slice(0, 200));

      const enable = await call("automation", "automation-enable", "automation", "automation/enable", { automationId: automationFailedId });
      const enabledFlag = enable.value && enable.value.value && enable.value.value.automation ? enable.value.value.automation.enabled : null;
      record("automation", "A5 · automation/enable 启用", okValue(enable) && enabledFlag === true, "enabled=true", String(enabledFlag));

      // ---- B7j 真实成功路径：启用钉钉插件 + 把群机器人 Webhook 指向本机 loopback 夹具 ----
      const dingtalkEnable = await call("automation", "automation-dingtalk-enable", "integration", "integration/plugins/enable", { id: "dingtalk" });
      const dingtalkStatus = await call("automation", "automation-dingtalk-status", "integration", "integration/dingtalk/status", {});
      const dtStatus = dingtalkStatus.value && dingtalkStatus.value.value ? dingtalkStatus.value.value : null;
      const dtReady = !!(okValue(dingtalkEnable) && dtStatus && dtStatus.safeStorageAvailable === true && dtStatus.fetchInjected === true);
      record("automation", "A0a · 钉钉集成就绪（插件启用 + safeStorage + 注入 fetch）", dtReady, "enabled + safeStorageAvailable + fetchInjected", JSON.stringify(dtStatus || dingtalkStatus.value).slice(0, 300));
      // 无论插件是否可用都调用一次（WRITE_CONTRACT 自驱动）；不可用时如实记录结构化失败。
      const save = await call("automation", "automation-dingtalk-channel-save", "integration", "integration/dingtalk/channels/save", { name: "E2E 探针群", webhook: "http://127.0.0.1:" + webhookFixture.port + "/robot/send" });
      const dingtalkChannelId = okValue(save) && save.value.value && save.value.value.id ? save.value.value.id : null;
      if (dtReady) {
        record("automation", "A0b · 钉钉群机器人 Webhook 落安全存储（指向本机夹具）", !!dingtalkChannelId, "ok:true + channelId", String(dingtalkChannelId));
      } else {
        markNotVerified("automation", "A0b · 钉钉群机器人 Webhook 落安全存储", "钉钉插件未启用或 safeStorage 不可用（命令已调用，返回 " + String(errValue(save)) + "）", "integration/plugins/enable {id:'dingtalk'} -> integration/dingtalk/status.safeStorageAvailable");
      }

      await drainEvents("automation");
      const runNow = await call("automation", "automation-run-now", "automation", "automation/runNow", { automationId: automationFailedId, await: true });
      const runNowCode = errValue(runNow);
      record("automation", "A6 · automation/runNow 真实执行（依赖缺失 -> 结构化终态）", runNow.value && runNow.value.ok === false && isStructuredErrorCode(runNowCode), "结构化依赖缺失码", String(runNowCode));
      result.automation.runNowError = runNowCode;

      const runs = await call("automation", "automation-runs", "automation", "automation/runs", { automationId: automationFailedId });
      const runRows = runs.value && runs.value.value && Array.isArray(runs.value.value.runs) ? runs.value.value.runs : [];
      const failedRun = runRows[0] || null;
      record("automation", "A7 · automation/runs 落一行且终态 failed", okValue(runs) && failedRun && failedRun.status === "failed", "1 run + status=failed", JSON.stringify(runRows.slice(0, 3)).slice(0, 300));
      result.automation.runs.push({ automationId: automationFailedId, runs: runRows });

      const createRetry = await call("automation", "automation-create-retry", "automation", "automation/create", {
        title: "E2E 失败重试", instruction: "music_play 重试 3 次",
        schedule: { type: "interval", everyMs: 3600000 }, action: { type: "music_play", args: { track: "probe" }, retry: { maxAttempts: 3, delayMs: 10 } },
      });
      automationRetryId = createRetry.value && createRetry.value.value && createRetry.value.value.automation ? createRetry.value.value.automation.id : null;
      await drainEvents("automation");
      await call("automation", "automation-run-now-retry", "automation", "automation/runNow", { automationId: automationRetryId, await: true });
      await waitFor(async () => {
        const r = await call("automation", "automation-runs-retry", "automation", "automation/runs", { automationId: automationRetryId });
        const rows = r.value && r.value.value && Array.isArray(r.value.value.runs) ? r.value.value.runs : [];
        return rows.length > 0 && rows[0].status !== "running";
      }, 8000, 200);
      const retryEvents = await drainEvents("automation");
      const attemptFailed = retryEvents.filter((e) => e.kind === "progress" && e.payload && e.payload.phase === "attempt-failed");
      const retryRuns = await call("automation", "automation-runs-retry-final", "automation", "automation/runs", { automationId: automationRetryId });
      const retryRows = retryRuns.value && retryRuns.value.value && Array.isArray(retryRuns.value.value.runs) ? retryRuns.value.value.runs : [];
      record("automation", "A8 · 失败重试真实发生 3 次（automation:event attempt-failed×3）", attemptFailed.length === 3, "3 attempt-failed", JSON.stringify(attemptFailed.map((e) => e.payload && e.payload.attempt)));
      record("automation", "A9 · 重试后仍落一行 failed", retryRows.length >= 1 && retryRows[0].status === "failed", "1 run + failed", JSON.stringify(retryRows.slice(0, 2)).slice(0, 240));
      result.automation.retry = { automationId: automationRetryId, attemptFailedCount: attemptFailed.length, runs: retryRows };
      result.automation.events = { received: retryEvents.length, kinds: [...new Set(retryEvents.map((e) => e.kind))], phases: [...new Set(retryEvents.map((e) => e.payload && e.payload.phase).filter(Boolean))] };

      // ---- B7j 真实成功终态：dingtalk_group_notify 打到本机夹具（不连外网）----
      if (dingtalkChannelId) {
        const createSuccess = await call("automation", "automation-create-success", "automation", "automation/create", {
          title: "E2E 自动化真实通知", instruction: "运行 dingtalk_group_notify（本机 loopback 夹具）",
          schedule: { type: "interval", everyMs: 3600000 },
          action: { type: "dingtalk_group_notify", args: { channelId: dingtalkChannelId, content: "E2E 自动化真实通知内容" } },
        });
        const successAutomationId = createSuccess.value && createSuccess.value.value && createSuccess.value.value.automation ? createSuccess.value.value.automation.id : null;
        const successRun = await call("automation", "automation-run-now-success", "automation", "automation/runNow", { automationId: successAutomationId, await: true });
        const successStatus = successRun.value && successRun.value.value && successRun.value.value.run ? successRun.value.value.run.status : null;
        const successText = successRun.value && successRun.value.value && successRun.value.value.result ? successRun.value.value.result.result : null;
        record("automation", "A13 · automation/runNow 走到真实成功终态（dingtalk_group_notify）", okValue(successRun) && successStatus === "success", "ok:true + status=success", JSON.stringify({ status: successStatus, text: successText }).slice(0, 300));
        const delivered = webhookFixture.received.filter((item) => item.url.includes("/robot/send"));
        record("automation", "A14 · 本机夹具收到真实钉钉群消息且内容正确", delivered.length === 1 && delivered[0].body.includes("E2E 自动化真实通知内容"), "1 次 POST + 内容命中", JSON.stringify(delivered.slice(0, 2)).slice(0, 400));
        result.automation.success = { automationId: successAutomationId, runStatus: successStatus, runText: successText, webhookPosts: delivered.length, channelId: dingtalkChannelId };
      } else {
        markNotVerified("automation", "A13 · 自动化动作真实成功终态", "钉钉通道未能建立；desktop 无实现、领星/紫鸟需外网 transport、agent_instruction 需模型站点，本机无其它可成功路径", "配置本机 loopback Webhook 后重试");
      }

      const createCancel = await call("automation", "automation-create-cancel", "automation", "automation/create", {
        title: "E2E 取消运行", instruction: "music_play 长重试窗口内取消",
        schedule: { type: "interval", everyMs: 3600000 }, action: { type: "music_play", args: { track: "probe" }, retry: { maxAttempts: 5, delayMs: 1500 } },
      });
      automationCancelId = createCancel.value && createCancel.value.value && createCancel.value.value.automation ? createCancel.value.value.automation.id : null;
      // B7j：字段缺失 / 把定义 id 当运行 id → 结构化 AUTOMATION_INVALID_INPUT 且提示 runId。
      const cancelMissing = await call("automation", "automation-cancel-missing-field", "automation", "automation/cancel", {});
      record("automation", "A10a · automation/cancel 缺 runId 时结构化拒绝并指明字段", cancelMissing.value && cancelMissing.value.ok === false && errValue(cancelMissing) === "AUTOMATION_INVALID_INPUT" && /runId/.test(String(cancelMissing.value.message || "")), "AUTOMATION_INVALID_INPUT + runId", JSON.stringify({ error: errValue(cancelMissing), message: cancelMissing.value && cancelMissing.value.message }).slice(0, 240));
      const cancelWrongId = await call("automation", "automation-cancel-wrong-id", "automation", "automation/cancel", { automationId: automationCancelId });
      record("automation", "A10b · automationId 传定义 id（非运行记录）结构化拒绝", cancelWrongId.value && cancelWrongId.value.ok === false && errValue(cancelWrongId) === "AUTOMATION_INVALID_INPUT", "AUTOMATION_INVALID_INPUT", JSON.stringify({ error: errValue(cancelWrongId), message: cancelWrongId.value && cancelWrongId.value.message }).slice(0, 240));

      const startCancel = await call("automation", "automation-run-now-cancel", "automation", "automation/runNow", { automationId: automationCancelId });
      const startedRunId = startCancel.value && startCancel.value.value && startCancel.value.value.run ? startCancel.value.value.run.id : null;
      await sleep(120);
      // B7j：自然字段 runId 成功取消运行中的执行记录。
      const cancel = await call("automation", "automation-cancel", "automation", "automation/cancel", { runId: startedRunId });
      const cancelStatus = cancel.value && cancel.value.value ? cancel.value.value.status : null;
      record("automation", "A10 · automation/cancel {runId} 取消运行中的执行记录", okValue(cancel) && (cancelStatus === "cancelling" || cancelStatus === "cancelled"), "cancelling|cancelled", String(cancelStatus));
      const terminal = await waitFor(async () => {
        const r = await call("automation", "automation-runs-cancel", "automation", "automation/runs", { automationId: automationCancelId });
        const rows = r.value && r.value.value && Array.isArray(r.value.value.runs) ? r.value.value.runs : [];
        return rows.length > 0 && rows[0].status === "cancelled";
      }, 8000, 200);
      const cancelRuns = await call("automation", "automation-runs-cancel-final", "automation", "automation/runs", { automationId: automationCancelId });
      const cancelRows = cancelRuns.value && cancelRuns.value.value && Array.isArray(cancelRuns.value.value.runs) ? cancelRuns.value.value.runs : [];
      record("automation", "A11 · 取消终态落库 status=cancelled（绝不伪造 success）", terminal && cancelRows[0] && cancelRows[0].status === "cancelled", "cancelled", JSON.stringify(cancelRows.slice(0, 2)).slice(0, 240));

      // B7j：automationId 作为历史别名传"运行记录 id"仍兼容（先按真实语义解析到运行记录）。
      const createCancel2 = await call("automation", "automation-create-cancel2", "automation", "automation/create", {
        title: "E2E 取消运行（别名字段）", instruction: "music_play 长重试窗口内以 automationId 别名取消",
        schedule: { type: "interval", everyMs: 3600000 }, action: { type: "music_play", args: { track: "probe" }, retry: { maxAttempts: 5, delayMs: 1500 } },
      });
      const cancelAliasAutomationId = createCancel2.value && createCancel2.value.value && createCancel2.value.value.automation ? createCancel2.value.value.automation.id : null;
      const startCancel2 = await call("automation", "automation-run-now-cancel2", "automation", "automation/runNow", { automationId: cancelAliasAutomationId });
      const startedRunId2 = startCancel2.value && startCancel2.value.value && startCancel2.value.value.run ? startCancel2.value.value.run.id : null;
      await sleep(120);
      const aliasCancel = await call("automation", "automation-cancel-alias", "automation", "automation/cancel", { automationId: startedRunId2 });
      const aliasStatus = aliasCancel.value && aliasCancel.value.value ? aliasCancel.value.value.status : null;
      record("automation", "A10c · automation/cancel {automationId: <runId>} 别名兼容成功", okValue(aliasCancel) && (aliasStatus === "cancelling" || aliasStatus === "cancelled"), "cancelling|cancelled", String(aliasStatus));
      const aliasTerminal = await waitFor(async () => {
        const r = await call("automation", "automation-runs-cancel2", "automation", "automation/runs", { automationId: cancelAliasAutomationId });
        const rows = r.value && r.value.value && Array.isArray(r.value.value.runs) ? r.value.value.runs : [];
        return rows.length > 0 && rows[0].status === "cancelled";
      }, 8000, 200);
      record("automation", "A11b · 别名取消同样落终态 cancelled", aliasTerminal, "cancelled", String(aliasTerminal));
      result.automation.cancel = { automationId: automationCancelId, runId: startedRunId, missingFieldError: errValue(cancelMissing), wrongIdError: errValue(cancelWrongId), aliasStatus, status: cancelRows[0] ? cancelRows[0].status : null, runs: cancelRows };

      const disable = await call("automation", "automation-disable", "automation", "automation/disable", { automationId: automationFailedId });
      record("automation", "A12 · automation/disable 停用（保留历史）", okValue(disable), "ok:true", JSON.stringify(disable.value.value).slice(0, 160));

      note("自动化动作可达性（B7j 接线后）：desktop(music_play/music_control/open_app)=本仓无实现，保持 AGENT_DEPENDENCY_UNAVAILABLE；integrations 的领星/紫鸟=需注入 transport，未注入即结构化依赖缺失；agent_instruction=需要可用模型站点；dingtalk_group_notify=经本机 loopback 夹具真实成功；app_action=developer-domain 不接受清单 automation 声明，无可执行动作。");
    });

    // === 7) 集成插件 ===
    await scenario("integration", async () => {
      const listBefore = await call("integration", "integration-plugins-list", "integration", "integration/plugins/list", {});
      const pluginsBefore = listBefore.value && listBefore.value.value && Array.isArray(listBefore.value.value.items) ? listBefore.value.value.items : [];
      const weatherBefore = pluginsBefore.find((p) => p.id === "weather");
      record("integration", "I1 · integration/plugins/list 返回插件目录（weather 存在）", okValue(listBefore) && !!weatherBefore, "ok:true + weather 存在", JSON.stringify(pluginsBefore.map((p) => ({ id: p.id, enabled: p.enabled }))));

      const enable = await call("integration", "integration-plugins-enable", "integration", "integration/plugins/enable", { id: "weather" });
      record("integration", "I2 · weather 启用（离线仅可选网络依赖）", okValue(enable) && enable.value.value.enabled === true, "ok:true + enabled", JSON.stringify(enable.value.value).slice(0, 200));

      const integrationsJson = path.join(userDataDir, "dxos", "integrations.json");
      const state = fs.existsSync(integrationsJson) ? JSON.parse(fs.readFileSync(integrationsJson, "utf8")) : null;
      const weatherEnabled = state && state.plugins && state.plugins.weather ? state.plugins.weather.enabled === true : null;
      record("integration", "I3 · 开关落盘 <userData>/dxos/integrations.json", weatherEnabled === true, "integrations.json.plugins.weather.enabled=true", JSON.stringify({ path: "dxos/integrations.json", enabled: weatherEnabled }));

      const get = await call("integration", "integration-plugins-get", "integration", "integration/plugins/get", { id: "weather" });
      record("integration", "I4 · integration/plugins/get 读回启用态", okValue(get) && get.value.value.plugin && get.value.value.plugin.enabled === true, "enabled=true", JSON.stringify(get.value.value && get.value.value.plugin));
      result.integration = { pluginId: "weather", enabledBeforeClose: weatherEnabled, statePath: "dxos/integrations.json" };
    });

    // APP #1 关闭前状态快照（供重启对照）
    await scenario("persistence", async () => {
      const t = await call("persistence", "before-close-task-get", "agent", "agent/task/get", { taskId });
      const te = await call("persistence", "before-close-task-events", "agent", "agent/task/events", { taskId, afterSequence: 0 });
      const s = await call("persistence", "before-close-skill-get", "skill", "skill/get", { skillId: result.skill.skillId });
      const d = await call("persistence", "before-close-developer-get", "developer", "developer/get", { appId: APP_RUNTIME_ID });
      const a = await call("persistence", "before-close-automation-runs", "automation", "automation/runs", {});
      const i = await call("persistence", "before-close-integration-list", "integration", "integration/plugins/list", {});
      const taskStatus = t.value && t.value.value && t.value.value.task ? t.value.value.task.status : null;
      const events = te.value && te.value.value && Array.isArray(te.value.value.items) ? te.value.value.items : [];
      const skill = s.value && s.value.value ? s.value.value.skill : null;
      const dev = d.value && d.value.value ? d.value.value : null;
      const runs = a.value && a.value.value && Array.isArray(a.value.value.runs) ? a.value.value.runs : [];
      const plugins = i.value && i.value.value && Array.isArray(i.value.value.items) ? i.value.value.items : [];
      const weather = plugins.find((p) => p.id === "weather");
      result.persistence.before = {
        task: { taskId, status: taskStatus, eventCount: events.length, lastSequence: events.length ? events[events.length - 1].sequence : null },
        skill: { skillId: result.skill.skillId, enabled: skill ? skill.enabled : null },
        developer: { appId: APP_RUNTIME_ID, version: dev ? dev.version : null, installed: !!(dev && dev.enabled) },
        automation: { runs: runs.map((r) => ({ id: r.id, status: r.status })).sort((x, y) => String(x.id).localeCompare(String(y.id))) },
        integration: { weatherEnabled: weather ? weather.enabled === true : null },
      };
      const sane = !!result.persistence.before.task.taskId && result.persistence.before.task.status === "paused" && result.persistence.before.developer.installed === true && result.persistence.before.skill.enabled === true && result.persistence.before.integration.weatherEnabled === true;
      record("persistence", "P0 · 关闭前读回 1/2/3/5/7 状态", true, "captured", JSON.stringify(result.persistence.before).slice(0, 500));
      record("persistence", "P0a · 关闭前状态读取有效（防 null 误报）", sane, "taskId+paused+installed+skill+weather", JSON.stringify(result.persistence.before).slice(0, 500));
    });

    const exit1 = await closeApp("app1");
    result.exit.push(exit1);
    record("boot", "B3 · app1 正常关窗退出（window-all-closed -> app.quit）", exit1.exited && exit1.code === 0 && !exit1.signal, "code 0 / no signal", JSON.stringify(exit1));
    await waitFor(() => listProcessesFor(userDataDir).length === 0, 8000, 250);

    // 落库断言（隔离身份库只读；应用已退出）
    await scenario("db", async () => {
      const db = openIsolatedDb();
      if (!db) { record("db", "DB0 · 打开隔离 identity.db（只读）", false, "open", "cannot open"); return; }
      try {
        result.db.tables = dbTableCounts(db);
        const taskRow = dbGet(db, "SELECT id,project_id,status,instruction,created_by FROM dx_tasks WHERE id=?", taskId);
        record("db", "DB1 · dx_tasks 落库且该行可读", !!taskRow && !taskRow.error && taskRow.status === "paused", "row(status=paused)", JSON.stringify(taskRow).slice(0, 240));
        const evRows = dbAll(db, "SELECT sequence,type FROM dx_task_events WHERE task_id=? ORDER BY sequence ASC", taskId);
        const seqs = Array.isArray(evRows) ? evRows.map((r) => r.sequence) : [];
        let dbMonotonic = true;
        for (let i = 1; i < seqs.length; i += 1) if (!(seqs[i] > seqs[i - 1])) dbMonotonic = false;
        record("db", "DB2 · dx_task_events 落库且 sequence 单调", seqs.length > 0 && dbMonotonic, ">0 rows + monotonic", JSON.stringify(seqs));
        const rootRow = dbGet(db, "SELECT project_id,root_node_id FROM dx_project_roots WHERE project_id=?", result.task.projectId);
        record("db", "DB3b · dx_project_roots 落库项目根映射", !!rootRow && !rootRow.error && !!rootRow.root_node_id, "row exists", JSON.stringify(rootRow));
        const projectRow = dbGet(db, "SELECT id,name FROM projects WHERE id=?", result.task.projectId);
        record("db", "DB3c · projects 落库项目行", !!projectRow && !projectRow.error, "row exists", JSON.stringify(projectRow));
        const cancelledRow = dbGet(db, "SELECT id,status FROM dx_tasks WHERE id=?", cancelledTaskId);
        record("db", "DB3 · 取消任务落库 status=cancelled", !!cancelledRow && cancelledRow.status === "cancelled", "cancelled", JSON.stringify(cancelledRow));

        const jobRow = dbGet(db, "SELECT id,status,output_path FROM video_render_jobs WHERE id=?", renderJobId);
        record("db", "DB4 · video_render_jobs 落库 completed", !!jobRow && jobRow.status === "completed", "completed", JSON.stringify(jobRow).slice(0, 240));
        const assetRow = dbGet(db, "SELECT id,kind,name FROM video_assets WHERE id=?", assetId);
        record("db", "DB5 · video_assets 落库 video", !!assetRow && assetRow.kind === "video", "video", JSON.stringify(assetRow));

        const autoRows = dbAll(db, "SELECT id,status,error FROM automation_runs ORDER BY created_at ASC");
        record("db", "DB6 · automation_runs 至少落 3 行（failed / 重试 / 取消）", Array.isArray(autoRows) && autoRows.length >= 3, ">=3 rows", JSON.stringify(Array.isArray(autoRows) ? autoRows.map((r) => r.status) : autoRows));
        const autoDef = dbGet(db, "SELECT id,title,enabled FROM automations WHERE id=?", automationFailedId);
        record("db", "DB7 · automations 落库（disable 后 enabled=0）", !!autoDef && autoDef.enabled === 0, "enabled=0", JSON.stringify(autoDef));

        const runtimeEvents = dbAll(db, "SELECT event_type,version,build FROM app_runtime_events WHERE app_id=? ORDER BY created_at ASC", APP_RUNTIME_ID);
        const types = Array.isArray(runtimeEvents) ? runtimeEvents.map((r) => r.event_type) : [];
        result.developer.events = types;
        record("db", "DB8 · app_runtime_events 覆盖 install/enable/disable/upgrade/rollback/uninstall", ["app.install", "app.enable", "app.disable", "app.upgrade", "app.rollback", "app.uninstall"].every((t) => types.includes(t)), "全部事件类型", JSON.stringify(types));
        const badRelease = dbAll(db, "SELECT app_id FROM app_market_releases WHERE app_id IN ('dev-bad-missing','dev-bad-permission','dev-bad-entry')");
        record("db", "DB9 · 非法包未写入 app_market_releases", Array.isArray(badRelease) && badRelease.length === 0, "0 rows", JSON.stringify(badRelease));
        const installedRow = dbGet(db, "SELECT app_id FROM user_installed_apps WHERE app_id=?", APP_RUNTIME_ID);
        record("db", "DB10 · user_installed_apps 落库该应用（重启持久化前提）", !!installedRow && !installedRow.error, "row exists", JSON.stringify(installedRow));
        const releaseRow = dbGet(db, "SELECT app_id,version,build,sha256 FROM app_market_releases WHERE app_id=? AND version='1.0.0'", APP_RUNTIME_ID);
        record("db", "DB11 · app_market_releases 保留可用版本行", !!releaseRow && !releaseRow.error, "row exists", JSON.stringify(releaseRow).slice(0, 240));
        result.db.assertions = { taskRow, seqs, jobRow, assetRow, autoRunStatuses: Array.isArray(autoRows) ? autoRows.map((r) => r.status) : autoRows, runtimeEventTypes: types };
      } finally { try { db.close(); } catch { /* ignore */ } }
    });

    // ================= APP #2 · 重启持久化 =================
    await startApp("app2");
    record("persistence", "P1 · 同一隔离 userData 重启真实 Electron（app2）", true, "CDP ready", launches[1].cdpPort + " / boot=" + launches[1].bootObservation);
    const loggedIn2 = await call("boot", "identity-login-2", "identity", "identity/login", { identifier, password });
    record("persistence", "P2 · 重启后重新登录（身份库持久）", okValue(loggedIn2), "ok:true", JSON.stringify(loggedIn2.value && loggedIn2.value.snapshot ? { role: loggedIn2.value.snapshot.role } : loggedIn2.value).slice(0, 200));

    await scenario("persistence", async () => {
      const t = await call("persistence", "after-restart-task-get", "agent", "agent/task/get", { taskId });
      const te = await call("persistence", "after-restart-task-events", "agent", "agent/task/events", { taskId, afterSequence: 0 });
      const s = await call("persistence", "after-restart-skill-get", "skill", "skill/get", { skillId: result.skill.skillId });
      const d = await call("persistence", "after-restart-developer-get", "developer", "developer/get", { appId: APP_RUNTIME_ID });
      const a = await call("persistence", "after-restart-automation-runs", "automation", "automation/runs", {});
      const i = await call("persistence", "after-restart-integration-list", "integration", "integration/plugins/list", {});
      const taskStatus = t.value && t.value.value && t.value.value.task ? t.value.value.task.status : null;
      const events = te.value && te.value.value && Array.isArray(te.value.value.items) ? te.value.value.items : [];
      const skill = s.value && s.value.value ? s.value.value.skill : null;
      const dev = d.value && d.value.value ? d.value.value : null;
      const runs = a.value && a.value.value && Array.isArray(a.value.value.runs) ? a.value.value.runs : [];
      const plugins = i.value && i.value.value && Array.isArray(i.value.value.items) ? i.value.value.items : [];
      const weather = plugins.find((p) => p.id === "weather");
      result.persistence.after = {
        task: { taskId, status: taskStatus, eventCount: events.length, lastSequence: events.length ? events[events.length - 1].sequence : null },
        skill: { skillId: result.skill.skillId, enabled: skill ? skill.enabled : null },
        developer: { appId: APP_RUNTIME_ID, version: dev ? dev.version : null, installed: !!(dev && dev.enabled) },
        automation: { runs: runs.map((r) => ({ id: r.id, status: r.status })).sort((x, y) => String(x.id).localeCompare(String(y.id))) },
        integration: { weatherEnabled: weather ? weather.enabled === true : null },
      };
      const before = result.persistence.before;
      const after = result.persistence.after;
      const same = JSON.stringify(before) === JSON.stringify(after);
      result.persistence.matches = same;
      record("persistence", "P3 · 重启前后 1/2/3/5/7 状态完全一致", same, "identical", JSON.stringify({ before, after }).slice(0, 700));
      if (!same) result.persistence.diff = { before, after };
    });

    // === 6) 平台快照（重启后跑，避免影响 P3 断言）===
    await scenario("platform", async () => {
      const integrity = await call("platform", "platform-integrity", "platform", "platform/data/integrity", {});
      record("platform", "F1 · platform/data/integrity ok", okValue(integrity) && integrity.value.value.ok === true, "ok:true", JSON.stringify(integrity.value.value));

      const credentialsDir = path.join(userDataDir, "dxos", "credentials");
      fs.mkdirSync(credentialsDir, { recursive: true });
      const sentinelPath = path.join(credentialsDir, "e2e-sentinel.json");
      fs.writeFileSync(sentinelPath, JSON.stringify({ note: "probe credential sentinel - must never enter snapshots" }), "utf8");

      const created = await call("platform", "platform-snapshot-create", "platform", "platform/data/snapshot/create", { reason: "e2e-write-probe" });
      snapshotId = created.value && created.value.value && created.value.value.manifest ? created.value.value.manifest.id : null;
      record("platform", "F2 · platform/data/snapshot/create 建快照", okValue(created) && !!snapshotId, "ok:true + snapshot id", String(snapshotId));

      const list = await call("platform", "platform-snapshot-list", "platform", "platform/data/snapshot/list", {});
      const snapshots = list.value && list.value.value && Array.isArray(list.value.value.snapshots) ? list.value.value.snapshots : [];
      record("platform", "F3 · platform/data/snapshot/list 列出该快照", okValue(list) && snapshots.some((s) => s.id === snapshotId), "含 snapshotId", JSON.stringify(snapshots.map((s) => ({ id: s.id, fileCount: s.fileCount }))).slice(0, 300));

      const verify = await call("platform", "platform-snapshot-verify", "platform", "platform/data/snapshot/verify", { id: snapshotId });
      record("platform", "F4 · platform/data/snapshot/verify 校验通过", okValue(verify) && verify.value.value.valid === true, "valid:true", JSON.stringify(verify.value.value).slice(0, 200));

      const manifestPath = path.join(userDataDir, "dxos", "backups", snapshotId, "manifest.json");
      const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
      const paths = manifest && Array.isArray(manifest.files) ? manifest.files.map((f) => f.path) : [];
      const credentialPaths = paths.filter((p) => /(^|\/)credentials(\/|$)/.test(p));
      record("platform", "F5 · 快照清单不含凭据文件", !!manifest && credentialPaths.length === 0 && !paths.includes("credentials/e2e-sentinel.json"), "0 credential paths", JSON.stringify({ fileCount: paths.length, credentialPaths }));
      record("platform", "F6 · 快照确实包含业务数据（integrations.json / skills.json）", paths.includes("integrations.json") || paths.includes("skills.json"), "含业务 json", JSON.stringify(paths.filter((p) => /\.json$/.test(p)).slice(0, 10)));

      const integrationsJson = path.join(userDataDir, "dxos", "integrations.json");
      const beforeDisable = JSON.parse(fs.readFileSync(integrationsJson, "utf8"));
      await call("platform", "platform-disable-weather", "integration", "integration/plugins/disable", { id: "weather" });
      const afterDisable = JSON.parse(fs.readFileSync(integrationsJson, "utf8"));
      const changed = beforeDisable.plugins.weather.enabled !== afterDisable.plugins.weather.enabled;

      const restore = await call("platform", "platform-snapshot-restore", "platform", "platform/data/snapshot/restore", { id: snapshotId, databasesClosed: true });
      const afterRestore = fs.existsSync(integrationsJson) ? JSON.parse(fs.readFileSync(integrationsJson, "utf8")) : null;
      const restoredEnabled = afterRestore && afterRestore.plugins && afterRestore.plugins.weather ? afterRestore.plugins.weather.enabled : null;
      record("platform", "F7 · restore 前先制造差异（weather 被停用）", changed && afterDisable.plugins.weather.enabled === false, "enabled true->false", JSON.stringify({ before: beforeDisable.plugins.weather.enabled, after: afterDisable.plugins.weather.enabled }));
      record("platform", "F8 · platform/data/snapshot/restore 往返恢复 integrations.json", okValue(restore) && restoredEnabled === true, "ok:true + enabled=true", JSON.stringify({ restore: restore.value.value, restoredEnabled }));

      const verify2 = await call("platform", "platform-snapshot-verify-after-restore", "platform", "platform/data/snapshot/verify", { id: snapshotId });
      record("platform", "F9 · restore 后快照仍可校验", okValue(verify2) && verify2.value.value.valid === true, "valid:true", JSON.stringify(verify2.value.value).slice(0, 160));

      result.platform = { snapshotId, manifestFileCount: paths.length, credentialPaths, integrationsJsonRoundTrip: { before: beforeDisable.plugins.weather.enabled, afterDisable: afterDisable.plugins.weather.enabled, afterRestore: restoredEnabled }, restoreResult: restore.value.value, credentialsDirAfterRestoreExists: fs.existsSync(credentialsDir) };
    });

    // === 9) 拒绝路径 + 无副作用 ===
    await scenario("reject", async () => {
      const dbBefore = openIsolatedDb();
      const countsBefore = dbTableCounts(dbBefore);
      if (dbBefore) dbBefore.close();
      const filesBefore = snapshotIsolatedDxos();

      const unknown = await call("reject", "reject-agent-unknown", "agent", "agent/probe/nonexistent", {});
      const unknownCode = errValue(unknown);
      record("reject", "R1 · 未白名单命令被结构化拒绝", unknown.value && unknown.value.ok === false && unknownCode === "AGENT_COMMAND_NOT_ALLOWED", "AGENT_COMMAND_NOT_ALLOWED", String(unknownCode));

      const networkReject = await call("reject", "developer-network-reject", "developer", "developer/network/request", { appId: APP_RUNTIME_ID, method: "GET", url: "https://evil.example.org/probe" });
      const networkCode = errValue(networkReject);
      record("reject", "R2 · 越权/策略拒绝：App 白名单外主机被拒", networkReject.value && networkReject.value.ok === false && ["DEVELOPER_NETWORK_BLOCKED", "DEVELOPER_NETWORK_NOT_DECLARED", "DEVELOPER_FORBIDDEN"].includes(networkCode), "DEVELOPER_NETWORK_BLOCKED|NOT_DECLARED", String(networkCode));

      const depMissing = await call("reject", "reject-dependency-missing", "automation", "automation/runNow", { automationId: automationFailedId, await: true });
      const depCode = errValue(depMissing);
      record("reject", "R3 · 依赖缺失命令返回结构化依赖码", depMissing.value && depMissing.value.ok === false && depCode === "AGENT_DEPENDENCY_UNAVAILABLE", "AGENT_DEPENDENCY_UNAVAILABLE", String(depCode));
      const mediaDep = await call("reject", "reject-media-dependency", "media", "media/figma-preview/build", {});
      const mediaDepCode = errValue(mediaDep);
      record("reject", "R4 · 媒体域未装配能力结构化不可用", mediaDep.value && mediaDep.value.ok === false && isStructuredErrorCode(mediaDepCode), "结构化 MEDIA_*", String(mediaDepCode));

      const forged = await call("reject", "forged-identity-task-get", "agent", "agent/task/get", { taskId, userId: "forged-admin", role: "ADMIN", sessionRef: "forged-session", appId: "forged" });
      const forgedTask = forged.value && forged.value.value && forged.value.value.task ? forged.value.value.task : null;
      record("reject", "R5 · 伪造 userId/sessionRef/role 被忽略（仍按真实会话返回本用户任务）", okValue(forged) && !!forgedTask, "ok:true（伪造字段无效）", JSON.stringify({ returned: !!forgedTask, error: errValue(forged) }));

      const dbAfter = openIsolatedDb();
      const countsAfter = dbTableCounts(dbAfter);
      if (dbAfter) dbAfter.close();
      const filesAfter = snapshotIsolatedDxos();
      const diff = diffIsolated(filesBefore, filesAfter, countsBefore, countsAfter);
      result.rejection = { unknownCommand: unknownCode, networkReject: networkCode, dependencyMissing: depCode, mediaDependency: mediaDepCode, tableCountsBefore: countsBefore, tableCountsAfter: countsAfter, fileDiff: diff };
      // R3 会真实执行一次自动化（automation_runs 合法 +1）；其余表与 dxos 文件必须零变化。
      const unexpectedTables = diff.changedTables.filter((entry) => !entry.startsWith("automation_runs:"));
      record("reject", "R6 · 拒绝路径无副作用（隔离库关键表除合法 automation_runs 增量外零变化）", unexpectedTables.length === 0, "0 unexpected table deltas", JSON.stringify({ changedTables: diff.changedTables, unexpectedTables }));
      record("reject", "R7 · 拒绝路径无文件副作用（dxos 文件清单哈希一致）", diff.changedFiles.length === 0, "0 changed files", JSON.stringify(diff.changedFiles));

      const logout = await call("reject", "identity-logout", "identity", "identity/logout", {});
      const afterLogout = await call("reject", "post-logout-forged-create", "agent", "agent/task/create", { projectId, instruction: "x", sessionRef: "forged-session", userId: "forged" });
      const afterLogoutCode = errValue(afterLogout);
      record("reject", "R8 · 登出后（含伪造 sessionRef）写命令被拒 UNAUTHENTICATED", afterLogout.value && afterLogout.value.ok === false && /UNAUTHENTICATED$/.test(String(afterLogoutCode)), "*_UNAUTHENTICATED", String(afterLogoutCode));
      result.rejection.afterLogout = afterLogoutCode;
    });

    const exit2 = await closeApp("app2");
    result.exit.push(exit2);
    record("boot", "B4 · app2 正常关窗退出", exit2.exited && exit2.code === 0 && !exit2.signal, "code 0 / no signal", JSON.stringify(exit2));
  } catch (error) {
    record("boot", "FATAL · 探针中断", false, "run to completion", String((error && error.stack) || error).slice(0, 500));
    try { if (child && child.exitCode == null && child.signalCode == null) child.kill("SIGKILL"); } catch { /* ignore */ }
    try { if (browser) await browser.close(); } catch { /* ignore */ }
  } finally {
    try { await new Promise((resolve) => webhookFixture.server.close(resolve)); } catch { /* 夹具已关 */ }
    const residual = listProcessesFor(userDataDir);
    record("exit", "X1 · 无残留进程持有隔离 userData", residual.length === 0, 0, residual.length + " -> " + JSON.stringify(residual.slice(0, 5)));
    const realProfileResidual = listProcessesFor(realProfilePath);
    const LOCAL_RE = /^(file:|data:|blob:|about:|devtools:|openarc-file:|openarc-resource:|openarc-canvas:|chrome-extension:|http:\/\/127\.0\.0\.1|http:\/\/localhost|http:\/\/\[::1\]|ws:\/\/127\.0\.0\.1|ws:\/\/localhost)/i;
    const nonLocal = requests.filter((u) => !LOCAL_RE.test(u));
    record("hygiene", "H1 · 渲染层无非本地网络请求", nonLocal.length === 0, "0 non-local", nonLocal.length + " -> " + JSON.stringify(nonLocal.slice(0, 10)));
    record("hygiene", "H2 · 页面 console error = 0", consoleErrors.length === 0, 0, consoleErrors.length + " -> " + JSON.stringify(consoleErrors.slice(0, 5)));
    record("hygiene", "H3 · 页面 pageerror = 0", pageErrors.length === 0, 0, pageErrors.length + " -> " + JSON.stringify(pageErrors.slice(0, 5)));
    const handlerMissing = consoleAll.filter((m) => /No handler registered/i.test(m.text));
    record("hygiene", "H4 · 无 'No handler registered' 通道缺失", handlerMissing.length === 0, 0, handlerMissing.length + " -> " + JSON.stringify(handlerMissing.slice(0, 3)));

    const profileAfter = snapshotProfile(realProfilePath);
    const profileDiff = diffProfile(profileBefore, profileAfter);
    record("profile", "S1 · 真实身份库 identity.db/-wal/-shm mtime/size/sha256 完全未变", profileDiff.identityUnchanged, "unchanged", JSON.stringify({ before: redactProfile(profileBefore).identity, after: redactProfile(profileAfter).identity }));
    if (profileDiff.unchanged) record("profile", "S2 · 真实 profile 顶层快照完全未变", true, "unchanged", "0 changed entries");
    else markNotVerified("profile", "S2 · 真实 profile 整树未变", "顶层有 " + profileDiff.changedCount + " 项变化（可能来自启动前已在使用该 profile 的其他进程）", JSON.stringify(profileDiff.changed.slice(0, 20)));

    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const removed = !fs.existsSync(userDataDir) && !fs.existsSync(scratchDir);
    record("exit", "X2 · 删除隔离 userData / 临时素材目录", removed, "removed", removed ? "removed" : "still present");

    // 探针自驱动契约：WRITE_CONTRACT 的每条命令都必须被真实调用过（按 channel+command 去重）
    const invoked = new Set(commands.map((c) => c.channel + ":" + c.command));
    const missingContract = [...new Set(WRITE_CONTRACT.filter((e) => !invoked.has(e.channel + ":" + e.command)).map((e) => e.channel + ":" + e.command))];
    record("contract", "C0 · WRITE_CONTRACT 每条命令都被真实调用", commands.length > 0 && missingContract.length === 0, "all " + WRITE_CONTRACT.length + " contract commands invoked", JSON.stringify({ invoked: invoked.size, missing: missingContract }));
    record("contract", "C1 · 全部命令无未捕获异常 / 无 No handler registered", commands.every((c) => !c.threw && !c.handlerMissing), "0 throw / 0 handler-missing", JSON.stringify({ threw: commands.filter((c) => c.threw).length, handlerMissing: commands.filter((c) => c.handlerMissing).length }));

    const redact = makeRedactor([userDataDir, scratchDir]);
    const passed = checks.filter((c) => c.ok).length;
    const failed = checks.length - passed;
    const report = {
      phase: "dxos-e2e-write",
      title: "B2-B7 · 真实 Electron 写链路端到端（任务/技能/开发者/媒体/自动化/平台/集成 + 重启持久化 + 拒绝路径）",
      at: nowIso(),
      runStartedAt,
      durationMs: Date.now() - runStartedAt,
      command: "node experiments/dxos-e2e-write/run-all.mjs",
      environment: {
        platform: process.platform, arch: process.arch, node: process.version,
        electron: (() => { try { return createRequire(path.join(ROOT, "package.json"))("electron/package.json").version; } catch { return null; } })(),
        ffmpeg: (() => { try { return execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0]; } catch { return null; } })(),
      },
      isolation: Object.assign({}, isolation, {
        profileBefore: redactProfile(profileBefore),
        profileAfter: redactProfile(profileAfter),
        profileDiff: { identityUnchanged: profileDiff.identityUnchanged, wholeProfileUnchanged: profileDiff.unchanged, changed: profileDiff.changed, changedCount: profileDiff.changedCount },
        realProfileProcessesBefore: realProfilePidsBefore.length,
        realProfileProcessesAfter: realProfileResidual.length,
        userDataRemoved: removed,
      }),
      writeChain: {
        task: redact(result.task),
        skill: redact(result.skill),
        developer: redact(result.developer),
        media: redact(result.media),
        automation: redact(result.automation),
        integration: redact(result.integration),
      },
      persistence: redact(result.persistence),
      platform: redact(result.platform),
      rejection: redact(result.rejection),
      unauthorized: redact(result.unauthorized),
      db: redact(result.db),
      events: redact(result.events),
      commands: commands.map((entry) => redact(entry)),
      console: { total: consoleAll.length, errorCount: consoleErrors.length, pageErrorCount: pageErrors.length, handlerMissingCount: handlerMissing.length, errors: consoleErrors.slice(0, 20), pageErrors: pageErrors.slice(0, 20), byType: consoleAll.reduce((acc, m) => { acc[m.type] = (acc[m.type] || 0) + 1; return acc; }, {}) },
      network: { total: requests.length, nonLocal: nonLocal.slice(0, 20), requestFailures: requestFailures.slice(0, 10), allLocal: nonLocal.length === 0, sample: [...new Set(requests.map((u) => u.replace(/^(file:\/\/[^/]+).*/, "$1/*")))].slice(0, 12) },
      stderrErrorLines: stderrBuf.split("\n").map((l) => l.trim()).filter((l) => /error|Error|FATAL|Unhandled/i.test(l)).filter((l) => !/ssl_client_socket|SSL error|net_error|handshake failed|GPU|gpu_|Metal|Autofill/i.test(l)).slice(0, 24),
      counts: { pass: passed, fail: failed, total: checks.length, notVerified: notVerified.length },
      checks,
      notVerified,
      observations,
    };
    const outDir = path.join(ROOT, "artifacts", "dxos-e2e-write");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "report.json");
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

    console.log("\n=== 结论 ===");
    console.log("写命令：" + commands.filter((c) => c.section !== "persistence").length + " 条；未捕获异常 " + commands.filter((c) => c.threw).length + " 条");
    console.log("重启持久化一致=" + result.persistence.matches);
    console.log("console error=" + consoleErrors.length + " pageerror=" + pageErrors.length + " 非本地请求=" + nonLocal.length);
    console.log("真实身份库未变=" + profileDiff.identityUnchanged);
    console.log("PASS " + passed + " / FAIL " + failed + " / NOT_VERIFIED " + notVerified.length);
    console.log("报告：" + path.relative(ROOT, outPath));
    return failed === 0 ? 0 : 1;
  }
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
