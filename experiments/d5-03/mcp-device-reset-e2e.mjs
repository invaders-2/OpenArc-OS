/**
 * D5-03 第七批 · 安装重置后旧设备身份失效 + 配对组织归属以会话为准 —— **真机验收**。
 *
 * 被测提交：integration/ui-core HEAD（本次运行自报 testedCommit）。
 * 被验改动（提交 ed4502d，产品面只有两个文件）：
 *   ① electron/identity-store.cjs —— RESET_AUTHORIZATION_DELETE_SQL 由 4 条扩到 7 条
 *      （新增 device_credentials → device_pairing_credentials → devices，子表先删），
 *      仍在 resetInstallation **既有的那个 transactSync** 内；审计三表一行不删。
 *   ② electron/device-service.cjs —— 配对 / 设备读取的组织归属唯一来源 = 会话反查的 users.team_id；
 *      调用方自报的 context.organizationId 与会话不一致 → SESSION_ORGANIZATION_MISMATCH（明确拒绝）。
 *
 * 走的是**真实产品入口**：真实 electron .（隔离 userData oa-d503b-<runId>-*）+ 真实产品 UI
 * （三步向导 / 登录 / 系统设置 → 设备面板）+ 真实命令层（identity:command / device:command）；
 * 重置走正式命令 identity/reset-installation；查库一律 DatabaseSync readOnly。
 *
 * ── 披露：设备侧动作的真机路径（为什么需要主进程内的服务对象）──────────────────
 * 产品 IPC 的 device:command 白名单只有 10 条命令（electron/device-bootstrap.cjs:21-32），
 * **没有** consumePairing（消费配对密钥是"设备侧"动作）、没有 authenticateConnection / heartbeat
 * （TLS 后连接身份）、也没有 grantDeviceAccess（设备 ACL 写入）。而 device:command 的 context 由
 * 主进程自建（device-bootstrap.cjs:54）—— 渲染层连自报 organizationId 的字段都递不进去。
 * 因此本脚本用 **Node 主进程调试口**（electron . --inspect=PORT，只监听 127.0.0.1、端口独占）在
 * 真实主进程里做两件事，都不改任何产品文件、不写任何 SQL：
 *   · 给 DeviceService.prototype 上的公开方法装一层**只记录不改变行为**的包装，捕获产品在真实 UI
 *     路径上自己创建的那个 DeviceService 实例（__D503G__.service）与它收到的真实会话上下文（__D503G__.ctx）。
 *     会话 token 只在主进程内存里流转，**不回传探针**（回传的只有长度 + sha256 前 16 位）。
 *   · 用被捕获的**同一个实例**直接调用上面那几个没有 IPC 入口的服务方法（等价于另一台设备 / 管理端
 *     在真机上调用产品服务），参数与产品自己的调用形态一致。
 * 判定不受这条路径影响：所有断言的期望值都来自产品规格与 registry 实际状态，不来自探针自造的数据；
 * 所有行级证据都来自只读 DB 快照。
 *
 * 段：
 *   A 装配 / 隔离 / 真实 UI 初始化 + 登录 / 打开设备面板 / 真实 UI 签发配对密钥（捕获服务实例与会话上下文）
 *   B 重置前：消费密钥 → 1 设备 + 1 凭据（组织 = 会话组织）；设备 ACL 1 行；旧凭据能认证、能授权、心跳放行；
 *     设备出现在真实 UI 列表；再签发一把**未消费**密钥（重置后的"旧未使用密钥"用）
 *   C 确认词错误（缺 confirm / 大小写不符）→ INVALID_INPUT，7 张重置表 + 5 张身份表逐行不变（审计只多 2 条 DENY）
 *   D 正式重置 → 三张设备表 0 行 + 四张授权表 0 行（含 device_access 1 → 0）/ 身份五表 0 行 /
 *     审计三表既有行一行不删 / 旧未消费密钥 PAIRING_TOKEN_UNKNOWN（0 新设备 0 新凭据）/
 *     旧已消费密钥稳定拒绝 / 旧指纹 DEVICE_CREDENTIAL_UNKNOWN / 旧长连接心跳 DEVICE_CREDENTIAL_MISMATCH /
 *     渲染层回到未初始化
 *   E 重新初始化（新 admin）→ 新组织 / 新密钥 / 配对成功（新设备 + 新凭据 + 新组织）/ 旧设备对新组织 DEVICE_NOT_FOUND
 *   F 跨组织与自报组织：deviceIdentity 组织不匹配 PAIRING_TOKEN_ORGANIZATION_MISMATCH（不消耗 token）；
 *     context.organizationId 自报异组织 → SESSION_ORGANIZATION_MISMATCH（写路径 + 读路径 + 对照组）
 *   G 并发单次消费（真实两路：同进程第二个 Store/Service 连接；再补 Worker 线程真并发）→ 恰好 1 设备 / 1 凭据
 *   H 审计与秘密：device_audit 逐行不变；明文 secret 在 DB/WAL/全表 dump/审计 payload/主进程输出 0 命中，
 *     并反证库里确有 secret 的 sha256
 *   Z 收尾（主进程 stderr / 源码指纹 / 隔离与清理 / 总数）
 *
 * 硬约束（本脚本自证）：
 *   · 串行：同一时刻只有本脚本一个 Electron；每次运行独立 runId 目录 + 只追加索引 + .sha256；
 *   · 端口：CDP 与主进程调试口都从各自基址递增 acquirePort 独占；只清理本次运行 spawn 的 pid 树（pkillUsed=false）；
 *   · 临时目录：全部经 experiments/d5-03/userdata-ownership.cjs 建（owner.json 归属标记），收尾只删自己登记并确认归属的目录；
 *   · 不连真实第三方、不发用户数据、不声称插件隔离通过、不新增「创建组织」入口。
 */
import { chromium } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const RUN_ARTIFACTS = require(path.join(here, "run-artifacts.cjs"));
const OWNERSHIP = require(path.join(here, "userdata-ownership.cjs"));
const deviceDomain = require(path.join(ROOT, "electron", "device-domain.cjs"));

const CDP_PORT_BASE = Number(process.env.OA_D503H_CDP_PORT || 9831);
const INSPECT_PORT_BASE = Number(process.env.OA_D503H_INSPECT_PORT || 9311);
const USERDATA_PREFIX_BASE = OWNERSHIP.PREFIX;
const CONFIRM = "DELETE-ALL-IDENTITY-DATA";
const ADMIN = { id: "admin@d503h-reset.test", pw: "reset-admin-1" };
const ADMIN2 = { id: "admin2@d503h-reset.test", pw: "reset-admin-2" };
const FOREIGN_ORG = "team_d503h_foreign00000000001";
/** Control Service 身份（§60）：真机由 electron/main.cjs:253 从 OPENARC_SERVICE_IDENTITY 读入，产品本身不写死。 */
const SERVICE_IDENTITY = "svc_d503h_device_reset";
const DEVICE_A = { displayName: "D5-03H Pre-Reset GPU", fingerprint: "fp_d503h_pre_reset" };
const extraArgs = (process.env.OA_D503H_ELECTRON_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 重置要删的**七张表**：四张授权事实 + 三张设备身份事实（唯一权威是 identity-store.cjs 的 RESET_AUTHORIZATION_DELETE_SQL）。 */
const AUTHZ_TABLES = Object.freeze(["app_policy_provisions", "app_resource_grants", "resource_grants", "device_access"]);
const DEVICE_TABLES = Object.freeze(["devices", "device_credentials", "device_pairing_credentials"]);
const RESET_TABLES = Object.freeze([...AUTHZ_TABLES, ...DEVICE_TABLES]);
const IDENTITY_TABLES = Object.freeze(["installations", "teams", "users", "sessions", "login_attempts"]);
const AUDIT_TABLES = Object.freeze(["audit_log", "authorization_audit", "device_audit"]);
/** 主进程调试口侧的全局锚点（捕获实例、会话上下文、密钥明文都只活在主进程内存里）。 */
const CAP = "__D503G__";
const CFG_GLOBAL = "__D503G_CFG__";

/* ══════════════════════════ 记录 / 日志 ══════════════════════════ */
const CHECKS = [], NOT_VERIFIED = [], OBSERVATIONS = [], LOG_LINES = [], DEFECTS = [], STEPS = [], DB_SNAPSHOTS = {};
let passed = 0, failed = 0;
const _log = console.log.bind(console);
console.log = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); LOG_LINES.push(s); _log(s); };
const _err = console.error.bind(console);
console.error = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); LOG_LINES.push("[stderr] " + s); _err(s); };
function record(section, name, ok, expected, actual) {
  const row = { section, name, status: ok ? "PASS" : "FAIL", expected: String(expected ?? ""), actual: String(actual ?? "").slice(0, 2600), at: new Date().toISOString() };
  CHECKS.push(row);
  if (ok) passed += 1; else failed += 1;
  console.log((ok ? "  [PASS] " : "! [FAIL] ") + section + " · " + name + (ok ? "" : " — 期望 " + row.expected + "，实际 " + row.actual.slice(0, 900)));
  return ok;
}
const note = (t) => { OBSERVATIONS.push(t); console.log("   · " + t); };
const notVerified = (n, r) => { NOT_VERIFIED.push({ name: n, reason: r }); console.log("   ? [NOT VERIFIED] " + n + " — " + r); };
function step(id, title, command, request, result) {
  const row = { id, title, command, request, result, at: new Date().toISOString() };
  STEPS.push(row);
  return row;
}

/* ══════════════════════════ 通用 ══════════════════════════ */
async function waitFor(fn, timeout = 20000, intervalMs = 120) {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return true; } catch { /* retry */ }
    if (Date.now() - t0 >= timeout) return false;
    await sleep(intervalMs);
  }
}
function fileSha(rel) { try { return crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, rel))).digest("hex"); } catch { return null; } }
function gitText(args) { try { return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim(); } catch { return null; } }
const sha16 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 16);

/* ══════════════════════════ 状态 ══════════════════════════ */
let RUN = null, OUT = null, USERDATA_PREFIX = USERDATA_PREFIX_BASE;
let page = null, app = null, INSPECTOR = null;
const apps = [], dialogs = [], consoleErrors = [], SPAWNS = [];
const state = {
  firstOrgId: null, firstUser: null, secondOrgId: null, secondUser: null,
  pConsumed: null, pUnused: null, pNew: null, pCross: null, pWorker: null,
  deviceA: null, credentialA: null, deviceB: null, newFingerprint: "fp_d503h_post_reset",
  serviceIdentity: null, ctxDigest: null, uiSecretMatch: true, uiSecretChecks: [], p1SecretHashBeforeReset: null,
  resetStatus: null, foreignOrgId: FOREIGN_ORG,
};
const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const textOf = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? (el.textContent || '') : '';");
const attrOf = (sel, name) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? el.getAttribute(" + JSON.stringify(name) + ") : null;");
const waitSel = (sel, ms = 15000) => waitFor(() => has(sel), ms);
const clickSel = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const identity = (payload) => js("return await window.openarc.identity.command(" + JSON.stringify(payload) + ")");

/* ══════════════════════════ 主进程调试口 ══════════════════════════ */
async function connectInspector(port) {
  let listed = null;
  const deadline = Date.now() + 60000;
  while (!listed && Date.now() < deadline) {
    try { listed = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json(); } catch { await sleep(300); }
  }
  if (!listed || !listed.length) throw new Error("主进程调试口未就绪：" + port);
  const target = listed.find((t) => t.type === "node") || listed[0];
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); p(m); }
  });
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("主进程调试口 WebSocket 连接失败")), { once: true });
  });
  const send = (method, params) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await send("Runtime.enable", {});
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true });
    const res = r.result || {};
    if (res.exceptionDetails) throw new Error("主进程求值异常：" + JSON.stringify(res.exceptionDetails).slice(0, 700));
    return res.result ? res.result.value : undefined;
  };
  return { evaluate, send, close: () => ws.close(), target: { title: target.title, type: target.type } };
}

/** 把 ROOT / CAP 交给主进程，后续表达式只读这个全局，避免在探针侧做字符串插值。 */
function cfgExpr() {
  return "globalThis[" + JSON.stringify(CFG_GLOBAL) + "] = " + JSON.stringify({ root: ROOT, cap: CAP }) + "; true";
}

/** 安装"捕获 + 直接调用"API：不改产品文件，只给公开方法套一层记录包装。 */
function captureInstallExpr() {
  return [
    "(() => {",
    "  const CFG = globalThis[" + JSON.stringify(CFG_GLOBAL) + "];",
    "  const ROOT = CFG.root;",
    "  const g = globalThis[CFG.cap] || (globalThis[CFG.cap] = { api: null, service: null, ctx: null, pairings: {}, calls: 0, installed: false, liveConnection: null });",
    "  if (!g.installed) {",
    "    const mod = require(ROOT + '/electron/device-service.cjs');",
    "    const P = mod.DeviceService.prototype;",
    "    const METHODS = ['createPairing','revokePairing','listPairings','listDevices','getDevice','deviceAudit','disableDevice','enableDevice','revokeDevice','renameDevice','grantDeviceAccess','revokeDeviceAccess','consumePairing','authenticateConnection','heartbeat','authorizeDeviceById','authorizeDevice','authorizeExecution','markOffline','resolveResourceLocation'];",
    "    for (const name of METHODS) {",
    "      const orig = P[name];",
    "      if (typeof orig !== 'function') continue;",
    "      P[name] = function (...args) {",
    "        g.calls += 1;",
    "        if (!g.service) g.service = this;",
    "        const a0 = args[0];",
    "        if (name === 'createPairing' && a0 && a0.context && a0.context.sessionRef) g.ctx = Object.assign({}, a0.context);",
    "        const res = orig.apply(this, args);",
    "        if (name === 'createPairing' && res && res.ok && res.secret && res.pairing) {",
    "          g.pairings[res.pairing.id] = { secret: res.secret, organizationId: res.pairing.organizationId, expiresAt: res.pairing.expiresAt, capturedAt: Date.now() };",
    "        }",
    "        return res;",
    "      };",
    "    }",
    "    g.installed = true;",
    "  }",
    "  if (g.api) return { ok: true, already: true };",
    "  const crypto = require('node:crypto');",
    "  const sha16 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);",
    "  const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');",
    "  const replacer = (k, v) => (typeof v === 'bigint' ? Number(v) : v);",
    "  const J = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v, replacer));",
    "  const svc = () => g.service;",
    "  g.api = {",
    "    status: () => ({",
    "      installed: g.installed, calls: g.calls, hasService: !!g.service, hasCtx: !!g.ctx,",
    "      serviceIdentity: g.service ? g.service.serviceIdentity : null,",
    "      ctxDigest: g.ctx ? { sessionRefLen: String(g.ctx.sessionRef || '').length, sessionRefSha16: sha16(g.ctx.sessionRef), appId: g.ctx.appId, source: g.ctx.source, keys: Object.keys(g.ctx).sort() } : null,",
    "      pairings: Object.keys(g.pairings).map((id) => ({ id, organizationId: g.pairings[id].organizationId, expiresAt: g.pairings[id].expiresAt, secretSha16: sha16(g.pairings[id].secret), secretLen: String(g.pairings[id].secret).length })),",
    "    }),",
    "    digest: (s) => ({ sha16: sha16(s), len: String(s).length }),",
    "    captureState: () => ({ installed: g.installed, calls: g.calls, hasService: !!g.service, hasCtx: !!g.ctx, methodCount: g.installed ? Object.getOwnPropertyNames(g.service || {}).length : 0 }),",
    "    consumeById: (pairingId, identityArg, seen) => {",
    "      const p = g.pairings[pairingId];",
    "      if (!p) return { __err: 'PROBE_UNKNOWN_PAIRING' };",
    "      return J(svc().consumePairing({ secret: p.secret, serviceIdentitySeen: seen == null ? svc().serviceIdentity : seen, deviceIdentity: identityArg }));",
    "    },",
    "    createPairingWith: (extra, ttlMs) => J(svc().createPairing({ context: Object.assign({}, g.ctx, extra || {}), ttlMs: ttlMs || 60000 })),",
    "    readWith: (method, extra) => J(svc()[method]({ context: Object.assign({}, g.ctx, extra || {}) })),",
    "    getWith: (deviceId, extra) => J(svc().getDevice({ context: Object.assign({}, g.ctx, extra || {}), deviceId })),",
    "    auditWith: (extra) => J(svc().deviceAudit({ context: Object.assign({}, g.ctx, extra || {}) })),",
    "    authorizeById: (deviceId, action, extra) => J(svc().authorizeDeviceById({ context: Object.assign({}, g.ctx, extra || {}), deviceId, action })),",
    "    authenticate: (fingerprint) => J(svc().authenticateConnection({ fingerprint })),",
    "    captureConnection: (fingerprint) => {",
    "      const r = svc().authenticateConnection({ fingerprint });",
    "      if (!r || !r.ok) return J(r);",
    "      g.liveConnection = Object.assign({}, r, { close: () => {} });",
    "      return { ok: true, decision: r.decision, deviceId: r.deviceId, credentialId: r.credential ? r.credential.id : null, credentialVersion: r.credential ? r.credential.credential_version : null };",
    "    },",
    "    heartbeatCaptured: (deviceId) => {",
    "      if (!g.liveConnection) return { __err: 'PROBE_NO_CONNECTION' };",
    "      return J(svc().heartbeat({ connection: g.liveConnection, payload: { deviceId } }));",
    "    },",
    "    grantAccess: (deviceId, principalType, principalId, actions) => J(svc().grantDeviceAccess({ context: Object.assign({}, g.ctx), deviceId, principalType, principalId, actions })),",
    "    deviceById: (deviceId) => J(svc().store.deviceById(deviceId)),",
    "    pairingRow: (pairingId) => J(svc().store.pairingById(pairingId)),",
    "    credentialByFingerprint: (fp) => J(svc().store.credentialByFingerprint(fp)),",
    "    pairingSecretHashOf: (pairingId) => (g.pairings[pairingId] ? sha256(g.pairings[pairingId].secret) : null),",
    "    counts: () => {",
    "      const c = {};",
    "      for (const t of ['devices', 'device_credentials', 'device_pairing_credentials', 'device_access', 'device_audit']) {",
    "        c[t] = J(svc().identity.connection.prepare('SELECT COUNT(*) c FROM ' + t).get()).c;",
    "      }",
    "      return c;",
    "    },",
    "    raceTwo: async (pairingId, dir, nameA, nameB) => {",
    "      const p = g.pairings[pairingId];",
    "      if (!p) return { __err: 'PROBE_UNKNOWN_PAIRING' };",
    "      const { IdentityStore } = require(ROOT + '/electron/identity-store.cjs');",
    "      const { DeviceStore } = require(ROOT + '/electron/device-store.cjs');",
    "      const { DeviceService } = require(ROOT + '/electron/device-service.cjs');",
    "      const consume = (s, name) => {",
    "        try {",
    "          return J(s.consumePairing({ secret: p.secret, serviceIdentitySeen: svc().serviceIdentity, deviceIdentity: { displayName: name, platform: 'darwin', architecture: 'arm64', fingerprint: 'fp_' + name } }));",
    "        } catch (e) { return { ok: false, error: 'DB_BUSY', thrown: String((e && e.message) || e) }; }",
    "      };",
    "      const store2 = new IdentityStore({ path: dir + '/identity.db' }).open();",
    "      try {",
    "        const service2 = new DeviceService({ identity: store2, deviceStore: new DeviceStore({ identity: store2 }), serviceIdentity: svc().serviceIdentity });",
    "        const results = await Promise.all([",
    "          Promise.resolve().then(() => consume(svc(), nameA)),",
    "          Promise.resolve().then(() => consume(service2, nameB)),",
    "        ]);",
    "        return { ok: true, mode: 'two-connections', results };",
    "      } finally { try { store2.close(); } catch (e) { /* ignore */ } }",
    "    },",
    "    raceWorker: async (pairingId, dir, name) => {",
    "      const p = g.pairings[pairingId];",
    "      if (!p) return { __err: 'PROBE_UNKNOWN_PAIRING' };",
    "      const { Worker } = require('node:worker_threads');",
    "      const code = [",
    "        \"const { parentPort, workerData } = require('node:worker_threads');\",",
    "        'try {',",
    "        \"  const { IdentityStore } = require(workerData.root + '/electron/identity-store.cjs');\",",
    "        \"  const { DeviceStore } = require(workerData.root + '/electron/device-store.cjs');\",",
    "        \"  const { DeviceService } = require(workerData.root + '/electron/device-service.cjs');\",",
    "        \"  const store = new IdentityStore({ path: workerData.dbPath }).open();\",",
    "        \"  const service = new DeviceService({ identity: store, deviceStore: new DeviceStore({ identity: store }), serviceIdentity: workerData.serviceIdentity });\",",
    "        \"  const res = service.consumePairing({ secret: workerData.secret, serviceIdentitySeen: workerData.serviceIdentity, deviceIdentity: { displayName: workerData.name, platform: 'darwin', architecture: 'arm64', fingerprint: 'fp_' + workerData.name } });\",",
    "        '  store.close();',",
    "        \"  parentPort.postMessage({ ok: true, result: JSON.parse(JSON.stringify(res)) });\",",
    "        \"} catch (e) { parentPort.postMessage({ ok: false, error: 'WORKER_THROWN', detail: String((e && e.message) || e) }); }\",",
    "      ].join(String.fromCharCode(10));",
    "      const workerCall = () => new Promise((resolve) => {",
    "        const w = new Worker(code, { eval: true, workerData: { root: ROOT, dbPath: dir + '/identity.db', secret: p.secret, serviceIdentity: svc().serviceIdentity, name } });",
    "        w.once('message', (m) => resolve(m));",
    "        w.once('error', (e) => resolve({ ok: false, error: 'WORKER_ERROR', detail: String((e && e.message) || e) }));",
    "      });",
    "      const mainCall = () => {",
    "        try {",
    "          return { ok: true, result: J(svc().consumePairing({ secret: p.secret, serviceIdentitySeen: svc().serviceIdentity, deviceIdentity: { displayName: 'race-main', platform: 'darwin', architecture: 'arm64', fingerprint: 'fp_race_main' } })) };",
    "        } catch (e) { return { ok: false, error: 'DB_BUSY', detail: String((e && e.message) || e) }; }",
    "      };",
    "      const pair = await Promise.all([workerCall(), Promise.resolve().then(mainCall)]);",
    "      return { ok: true, mode: 'worker-thread', worker: pair[0], main: pair[1] };",
    "    },",
    "  };",
    "  return { ok: true, already: false };",
    "})()",
  ].join(String.fromCharCode(10));
}

function apiExpr(call) {
  const G = "globalThis[globalThis[" + JSON.stringify(CFG_GLOBAL) + "].cap]";
  return "(async () => JSON.stringify((" + G + " && " + G + ".api) ? (await (" + G + ".api." + call + ")) : ({ __err: 'CAPTURE_NOT_INSTALLED' }), (k, v) => (typeof v === 'bigint' ? Number(v) : v)))()";
}
async function mainApi(call) {
  const raw = await INSPECTOR.evaluate(apiExpr(call));
  const parsed = JSON.parse(raw);
  if (parsed && parsed.__err) throw new Error("主进程捕获未就绪：" + parsed.__err);
  return parsed;
}

/* ══════════════════════════ 身份（真实 UI） ══════════════════════════ */
async function login(identifier, pw) {
  await waitSel('[data-d3-id="login-identifier"]', 30000);
  await setInput('[data-d3-id="login-identifier"]', identifier);
  await setInput('[data-d3-id="login-password"]', pw);
  await clickSel('[data-d3-id="login-submit"]');
  return await waitFor(async () => (await gate()) === "ready", 60000);
}
async function setupWizard(acct, displayName) {
  await waitSel('[data-d3-id="setup-name"]', 30000);
  const next = async (stepId) => {
    const ready = await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"" + stepId + "\"]'); return !!b && !b.disabled;"), 10000);
    const clicked = await clickSel('[data-d3-id="' + stepId + '"]');
    return ready && clicked === "ok";
  };
  await setInput('[data-d3-id="setup-name"]', displayName);
  const s0 = await next("setup-next");
  await waitSel('[data-d3-id="setup-identifier"]', 10000);
  await setInput('[data-d3-id="setup-identifier"]', acct.id);
  const s1 = await next("setup-next");
  await waitSel('[data-d3-id="setup-password"]', 10000);
  await setInput('[data-d3-id="setup-password"]', acct.pw);
  await setInput('[data-d3-id="setup-confirm"]', acct.pw);
  const s2 = await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-submit\"]'); return !!b && !b.disabled;"), 10000);
  const submitted = await clickSel('[data-d3-id="setup-submit"]');
  const arrived = await waitFor(async () => ["unauthenticated", "ready"].includes(await gate()), 40000);
  return { steps: [s0, s1, s2], submitted, arrived, gate: await gate() };
}
/** 真实 UI：系统设置 → 设备面板。 */
async function openDevicePane() {
  await clickSel('[aria-label="打开系统设置"]');
  await waitSel(".settings-content", 15000);
  const clicked = await clickSel('[data-settings-pane="devices"]');
  const ready = await waitSel('[data-device-pane="devices"]', 15000);
  return { clicked, ready, available: await attrOf('[data-device-pane="devices"]', "data-device-available"), role: await attrOf('[data-device-pane="devices"]', "data-device-role") };
}
/** 真实 UI：点「开始配对」→ 读取界面显示的加入码（明文只在界面出现这一次）。 */
async function uiStartPairing() {
  const clicked = await clickSel('[data-device-action="pair"]');
  if (clicked !== "ok") return { clicked, secret: null, pairingIds: [] };
  const shown = await waitFor(() => has("[data-device-pairing-secret]"), 15000);
  const secret = shown ? String(await textOf("[data-device-pairing-secret]")).trim() : null;
  const pairingIds = JSON.parse(await js("return JSON.stringify([...document.querySelectorAll('[data-device-pairing]')].map((r) => r.getAttribute('data-device-pairing')))"));
  return { clicked, shown, secret, pairingIds, expiresText: await textOf("[data-device-pairing-expires]") };
}
/**
 * 真实 UI 的设备行。选择器只认**设备行**（article 上的 data-device-name）——
 * 行内的 rename/disable/revoke 按钮也带 data-device-id，用 [data-device-id] 会把一台设备数成 4 行。
 */
async function uiDeviceIds() {
  return JSON.parse(await js("return JSON.stringify([...document.querySelectorAll('[data-device-list] [data-device-name]')].map((r) => ({ id: r.getAttribute('data-device-id'), name: r.getAttribute('data-device-name'), status: r.getAttribute('data-device-status'), credentialVersion: r.querySelector('[data-device-credential-version]')?.textContent || null })))"));
}
const uiRefresh = () => clickSel('[data-device-action="refresh"]');
/**
 * UI 显示的 secret 必须与服务返回值逐字相同（只比 sha256 前 16 位，明文不进产物）；
 * 同时用它**反查**这把密钥的 pairing id —— 面板是列表渲染，不靠 DOM 顺序猜"哪一条是刚建的"。
 */
async function resolvePairingByUiSecret(uiPairing, label) {
  const cap = await mainApi("status()");
  const digest = uiPairing.secret ? await mainApi("digest(" + JSON.stringify(uiPairing.secret) + ")") : { sha16: null };
  const matches = (cap.pairings || []).filter((p) => digest.sha16 && p.secretSha16 === digest.sha16);
  const matched = matches.length === 1 ? matches[0] : null;
  const ok = !!matched;
  const row = { label, pairingId: matched ? matched.id : null, uiSecretLen: uiPairing.secret ? uiPairing.secret.length : 0, uiSha16: digest.sha16, serviceSha16: matched ? matched.secretSha16 : null, matchCount: matches.length, domPairingIds: uiPairing.pairingIds, equal: ok, ok };
  state.uiSecretChecks.push(row);
  if (!ok) state.uiSecretMatch = false;
  return row;
}

/* ══════════════════════════ Electron 启停（只动自己的进程树） ══════════════════════════ */
async function portFree(port) {
  try { await fetch("http://127.0.0.1:" + port + "/json/version"); return false; } catch { return true; }
}
function psRows() {
  try {
    return execFileSync("ps", ["-axo", "pid=,ppid=,stat=,command="], { encoding: "utf8" })
      .split("\n").map((l) => { const m = l.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)/); return m ? { pid: Number(m[1]), ppid: Number(m[2]), stat: m[3], cmd: m[4] } : null; })
      .filter(Boolean);
  } catch { return []; }
}
function descendantsOf(rootPid) {
  const rows = psRows();
  const byId = new Map(rows.map((r) => [r.pid, r]));
  return rows.filter((r) => {
    let p = r.ppid, hops = 0;
    while (p && hops < 14) { if (p === rootPid) return true; const pr = byId.get(p); if (!pr) return false; p = pr.ppid; hops += 1; }
    return false;
  });
}
const pidAlive = (pid) => psRows().some((r) => r.pid === pid && !r.stat.startsWith("Z"));

async function launchApp({ userDataDir = null, label = "" } = {}) {
  if (app) { const stray = await killApp(app); note("launchApp 自我保护：先杀掉仍存活的上一实例 " + JSON.stringify(stray)); }
  const dir = userDataDir || OWNERSHIP.createOwnedDir({ prefix: USERDATA_PREFIX, kind: label ? "electron-userdata/" + label : "electron-userdata", runId: RUN ? RUN.runId : null });
  const cdpRes = await RUN.acquirePort(CDP_PORT_BASE);
  const cdpPort = cdpRes.port;
  await cdpRes.release();
  if (!(await portFree(cdpPort))) throw new Error("CDP 端口 " + cdpPort + " 仍被占用，拒绝启动（避免连到别的实例）");
  const inspectRes = await RUN.acquirePort(INSPECT_PORT_BASE);
  const inspectPort = inspectRes.port;
  await inspectRes.release();
  const child = spawn(electronPath, [".", "--user-data-dir=" + dir, "--remote-debugging-port=" + cdpPort, "--inspect=" + inspectPort, ...extraArgs], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OPENARC_IDENTITY_ADMIN: "1", OPENARC_SERVICE_IDENTITY: SERVICE_IDENTITY },
  });
  SPAWNS.push({ kind: "electron", pid: child.pid, label, cdpPort, inspectPort, userDataDir: dir, at: new Date().toISOString() });
  const rec = { label, userDataDir: dir, cdpPort, inspectPort, child, pid: child.pid, browser: null, page: null, stderr: "", stdout: "", launchedAt: Date.now() };
  apps.push(rec);
  child.stdout.on("data", (d) => { rec.stdout += String(d); });
  child.stderr.on("data", (d) => { rec.stderr += String(d); });
  let version = null;
  const deadline = Date.now() + 60000;
  while (!version && Date.now() < deadline) { try { version = await (await fetch("http://127.0.0.1:" + cdpPort + "/json/version")).json(); } catch { await sleep(300); } }
  if (!version) throw new Error("CDP 未就绪：" + label + " " + dir + " port=" + cdpPort);
  INSPECTOR = await connectInspector(inspectPort);
  rec.inspectorTarget = INSPECTOR.target;
  await INSPECTOR.evaluate(cfgExpr());
  rec.captureInstalled = await INSPECTOR.evaluate(captureInstallExpr());
  rec.captureState = await INSPECTOR.evaluate(apiExpr("captureState()")).then((s) => JSON.parse(s)).catch(() => null);
  rec.browser = await chromium.connectOverCDP("http://127.0.0.1:" + cdpPort);
  const ctx = rec.browser.contexts()[0];
  const end = Date.now() + 40000;
  while (!rec.page && end > Date.now()) { rec.page = ctx.pages().find((p) => p.url().includes("dist/index.html")) || null; if (!rec.page) await sleep(300); }
  if (!rec.page) throw new Error("未找到界面页面：" + label);
  rec.page.on("dialog", (d) => { dialogs.push(String(d.message()).slice(0, 140)); void d.dismiss().catch(() => {}); });
  rec.page.on("console", (m) => { if (m.type() === "error") consoleErrors.push((label + ":" + m.text()).slice(0, 220)); });
  rec.page.on("pageerror", (e) => consoleErrors.push(label + ":pageerror:" + String(e.message).slice(0, 200)));
  app = rec; page = rec.page;
  return rec;
}
async function killApp(rec) {
  if (!rec) return null;
  const tree = [rec.child.pid, ...descendantsOf(rec.child.pid).filter((r) => !r.stat.startsWith("Z")).map((r) => r.pid)];
  try { rec.child.kill("SIGKILL"); } catch { /* ignore */ }
  await waitFor(() => !pidAlive(rec.child.pid), 15000, 100);
  for (const pid of tree) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  await waitFor(() => tree.every((p) => !pidAlive(p)), 12000, 100);
  await waitFor(() => portFree(rec.cdpPort), 10000, 200);
  const out = { pid: rec.child.pid, tree, mainGone: !pidAlive(rec.child.pid), leftovers: tree.filter(pidAlive), cdpPort: rec.cdpPort, inspectPort: rec.inspectPort };
  if (app === rec) { app = null; page = null; }
  return out;
}
async function cleanupOwnProcesses() {
  const result = { strategy: "own-pid-tree-only", pkillUsed: false, at: new Date().toISOString(), targets: [], leftovers: [] };
  for (const rec of apps) {
    const tree = [rec.child.pid, ...descendantsOf(rec.child.pid).filter((r) => !r.stat.startsWith("Z")).map((r) => r.pid)];
    for (const pid of tree) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    await waitFor(() => tree.every((pid) => !pidAlive(pid)), 12000, 100);
    result.targets.push({ kind: "electron", label: rec.label, rootPid: rec.child.pid, tree, leftovers: tree.filter(pidAlive) });
  }
  result.leftovers = [...new Set(result.targets.flatMap((t) => t.leftovers))];
  result.unregisteredSurvivors = SPAWNS.filter((s) => s.pid && pidAlive(s.pid) && !result.targets.some((t) => t.tree.includes(s.pid))).map((s) => ({ pid: s.pid, kind: s.kind, label: s.label }));
  return result;
}

/* ══════════════════════════ 只读取证 ══════════════════════════ */
function dbAll(dir, sql) {
  let db = null;
  try {
    db = new DatabaseSync(path.join(dir, "identity.db"), { readOnly: true });
    return db.prepare(sql).all();
  } catch (e) { return [{ __error: String((e && e.message) || e).slice(0, 240) }]; } finally { try { if (db) db.close(); } catch { /* ignore */ } }
}
const dbCount = (dir, table) => { const r = dbAll(dir, "SELECT COUNT(*) c FROM " + table)[0] || {}; return r.c === undefined ? -1 : Number(r.c); };
const dbCountWhere = (dir, table, where) => { const r = dbAll(dir, "SELECT COUNT(*) c FROM " + table + " WHERE " + where)[0] || {}; return r.c === undefined ? -1 : Number(r.c); };
function dumpTables(dir, tables) {
  const out = {};
  for (const t of tables) out[t] = dbAll(dir, "SELECT * FROM " + t + " ORDER BY rowid").map((r) => JSON.stringify(r));
  return out;
}
function allTableNames(dir) {
  return dbAll(dir, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
}
const sameRows = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isPrefixOf = (prefix, full) => prefix.length <= full.length && prefix.every((row, i) => row === full[i]);
const schemaVersionOf = (dir) => Number((dbAll(dir, "PRAGMA user_version")[0] || {}).user_version ?? -1);

function snapshot(dir, tag) {
  const snap = { tag, at: new Date().toISOString(), dir: path.basename(dir), schemaVersion: schemaVersionOf(dir), counts: {}, identityCounts: {}, audit: {} };
  for (const t of RESET_TABLES) snap.counts[t] = dbCount(dir, t);
  for (const t of IDENTITY_TABLES) snap.identityCounts[t] = dbCount(dir, t);
  snap.audit = dumpTables(dir, AUDIT_TABLES);
  snap.resetRows = dumpTables(dir, RESET_TABLES);
  snap.identityRows = dumpTables(dir, IDENTITY_TABLES);
  snap.deviceRows = dumpTables(dir, DEVICE_TABLES);
  DB_SNAPSHOTS[tag] = snap;
  return snap;
}
/** 明文 secret 扫描：DB 文件 + WAL + SHM + 全表逐字段 dump + 审计 payload + userData 下日志/JSON + 主进程输出。 */
function scanPlaintextSecret(secret, dir) {
  const needle = Buffer.from(secret, "utf8");
  const hits = [];
  const dbFiles = [path.join(dir, "identity.db"), path.join(dir, "identity.db-wal"), path.join(dir, "identity.db-shm")].filter((p) => fs.existsSync(p));
  for (const p of dbFiles) if (fs.readFileSync(p).includes(needle)) hits.push(path.basename(p));
  const tables = allTableNames(dir);
  const dump = JSON.stringify(dumpTables(dir, tables));
  if (dump.indexOf(secret) !== -1) hits.push("table-dump");
  const auditPayload = JSON.stringify(dbAll(dir, "SELECT * FROM device_audit")) + JSON.stringify(dbAll(dir, "SELECT * FROM audit_log")) + JSON.stringify(dbAll(dir, "SELECT * FROM authorization_audit"));
  if (auditPayload.indexOf(secret) !== -1) hits.push("audit-payload");
  const walk = (d, depth) => {
    if (depth > 3) return;
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) {
      const full = path.join(d, n);
      let st = null;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full, depth + 1); continue; }
      if (st.size > 32 * 1024 * 1024) continue;
      if (/\.(log|json|txt|ndjson)$/i.test(n) || n === "identity.db" || n === "identity.db-wal") {
        try { if (fs.readFileSync(full).includes(needle)) hits.push(path.relative(dir, full)); } catch { /* ignore */ }
      }
    }
  };
  walk(dir, 0);
  const appOutput = apps.map((a) => a.stdout + a.stderr).join(String.fromCharCode(10));
  if (appOutput.indexOf(secret) !== -1) hits.push("main-process-output");
  return { hits, scanned: { dbFiles: dbFiles.map((p) => path.basename(p)), tableCount: tables.length, userDataWalk: true, mainProcessOutput: true } };
}

/* ══════════════════════════ 主流程 ══════════════════════════ */
async function main() {
  RUN = await RUN_ARTIFACTS.createRun({ root: ROOT, script: "mcp-device-reset-e2e", basePort: CDP_PORT_BASE, envBaseVar: "OA_D503H_CDP_PORT", userDataPrefixBase: USERDATA_PREFIX_BASE });
  USERDATA_PREFIX = RUN.userDataPrefix;
  console.log("本次运行：" + RUN.runId + " → " + RUN.runDirRel + "（CDP 基址 " + CDP_PORT_BASE + "，主进程调试口基址 " + INSPECT_PORT_BASE + "，userData 前缀 " + USERDATA_PREFIX + "）");
  note("被测提交：" + (gitText(["rev-parse", "HEAD"]) || "?") + "（分支 " + (gitText(["rev-parse", "--abbrev-ref", "HEAD"]) || "?") + "）");

  /* ── A 装配：真实 electron . + 真实 UI 初始化 / 登录 / 设备面板 / 签发密钥 ── */
  const rec = await launchApp({ label: "device-reset" });
  const snapA0 = snapshot(rec.userDataDir, "A0_boot");
  const wizard = await setupWizard(ADMIN, "D5-03H Reset Admin");
  /**
   * 先经**同一张真实登录表单**故意输错一次口令：它会在 login_attempts 留下一行，
   * 让"重置后身份五表 0 行"里的 login_attempts 也是 1 → 0（否则 0 → 0 不构成该行的证据）。
   * 成功登录会把 failures 清零，但行本身保留 —— 这也正是产品自己的行为。
   */
  await waitSel('[data-d3-id="login-identifier"]', 30000);
  await setInput('[data-d3-id="login-identifier"]', ADMIN.id);
  await setInput('[data-d3-id="login-password"]', "d503h-wrong-password");
  const wrongLoginClicked = await clickSel('[data-d3-id="login-submit"]');
  const attemptRecorded = await waitFor(() => dbCount(rec.userDataDir, "login_attempts") >= 1, 15000, 200);
  const gateAfterWrong = await gate();
  const loggedIn = await login(ADMIN.id, ADMIN.pw);
  record("A1b", "真实 UI 登录表单先被错误口令拒一次（留 1 行 login_attempts），随后正确口令登录成功 —— 让身份五表在重置前全部有行",
    wrongLoginClicked === "ok" && attemptRecorded === true && gateAfterWrong !== "ready" && loggedIn === true,
    "错误口令被拒（gate != ready）+ login_attempts >= 1 + 正确口令后 gate=ready",
    JSON.stringify({ wrongLoginClicked, attemptRecorded, gateAfterWrong, loginAttempts: dbCount(rec.userDataDir, "login_attempts"), loggedIn }));
  const gateA = await gate();
  record("A1", "真实 electron .（隔离 userData + 独占 CDP / 主进程调试口）+ 真实 UI 三步向导初始化 + 登录 admin",
    !!rec.browser && !!INSPECTOR && wizard.arrived === true && loggedIn === true && gateA === "ready",
    "CDP 可用 + 主进程调试口可用 + 向导到达 + 登录后 gate=ready",
    JSON.stringify({ cdpPort: rec.cdpPort, inspectPort: rec.inspectPort, inspectorTarget: rec.inspectorTarget, captureInstalled: rec.captureInstalled, captureState: rec.captureState, userData: path.basename(rec.userDataDir), pid: rec.pid, wizard, login: loggedIn, gate: gateA, boot: { schemaVersion: snapA0.schemaVersion, counts: snapA0.counts, identityCounts: snapA0.identityCounts } }));
  step("A1.login", "登录 admin（真实 UI 表单）", "UI: [data-d3-id=login-*] → identity/login", { identifier: ADMIN.id }, { gate: gateA, wizard });

  const statusA = await identity({ type: "identity/status" });
  state.firstOrgId = (statusA && statusA.snapshot && statusA.snapshot.teamId) || null;
  state.firstUser = (statusA && statusA.snapshot && statusA.snapshot.userId) || null;
  step("A1.status", "identity/status（读组织 id / 用户 id / 安装 id）", "identity/status", {}, { ok: statusA?.ok, teamId: statusA?.snapshot?.teamId, userId: statusA?.snapshot?.userId, installationId: statusA?.installationId, initStatus: statusA?.initStatus });
  record("A2", "会话权威给出非空组织 id / 用户 id（后续所有组织归属断言以它为准）",
    !!state.firstOrgId && !!state.firstUser, "snapshot.teamId / userId 非空", JSON.stringify({ teamId: state.firstOrgId, userId: state.firstUser, installationId: statusA?.installationId }));

  const pane = await openDevicePane();
  record("A3", "真实 UI 打开「系统设置 → 设备」面板（Super Admin 身份、设备桥可用）",
    pane.clicked === "ok" && pane.ready === true && pane.available === "true" && pane.role === "ADMIN",
    "settings-pane=devices + data-device-available=true + data-device-role=ADMIN",
    JSON.stringify(pane));
  step("A3", "UI: [aria-label=打开系统设置] → [data-settings-pane=devices]", "UI 点击", {}, pane);

  const uiPair1 = await uiStartPairing();
  const secretCheckA = await resolvePairingByUiSecret(uiPair1, "P1(consumed)");
  state.pConsumed = secretCheckA.pairingId;
  const p1Hash = (state.pConsumed ? dbAll(rec.userDataDir, "SELECT secret_hash FROM device_pairing_credentials WHERE id = '" + state.pConsumed + "'")[0] : null) || {};
  state.p1SecretHashBeforeReset = p1Hash.secret_hash || null;
  const capA = await mainApi("status()");
  state.serviceIdentity = capA.serviceIdentity;
  state.ctxDigest = capA.ctxDigest;
  const p1Db = state.pConsumed ? dbAll(rec.userDataDir, "SELECT id, organization_id, status, issued_by, expires_at, secret_hash FROM device_pairing_credentials WHERE id = '" + state.pConsumed + "'") : [];
  record("A4", "真实 UI 点「开始配对」签发密钥：界面显示的加入码 = 服务返回值（sha256 逐字相等）；库里 1 行未消费密钥且组织 = 会话组织；捕获到真实主进程的 DeviceService 实例与真实会话上下文",
    uiPair1.clicked === "ok" && !!uiPair1.secret && !!state.pConsumed && capA.hasService === true && capA.hasCtx === true
      && secretCheckA.ok === true
      && p1Db.length === 1 && p1Db[0].status === "ISSUED" && p1Db[0].organization_id === state.firstOrgId
      && /^[0-9a-f]{64}$/.test(String(p1Db[0].secret_hash))
      && capA.serviceIdentity === SERVICE_IDENTITY,
    "UI secret sha256 = 服务 secret sha256 + device_pairing_credentials 1 行 ISSUED + 组织 = 会话组织 + hasService/hasCtx + serviceIdentity = OPENARC_SERVICE_IDENTITY",
    JSON.stringify({
      uiPairing: { clicked: uiPair1.clicked, shown: uiPair1.shown, pairingIds: uiPair1.pairingIds, expiresText: uiPair1.expiresText, secretLen: uiPair1.secret ? uiPair1.secret.length : 0, secretSha16: secretCheckA.svcDigest },
      service: { hasService: capA.hasService, hasCtx: capA.hasCtx, calls: capA.calls, serviceIdentity: capA.serviceIdentity, ctxDigest: capA.ctxDigest, pairingSha16: secretCheckA.serviceSha16 },
      db: p1Db.map((r) => ({ id: r.id, organization_id: r.organization_id, status: r.status, issued_by: r.issued_by, expires_at: r.expires_at, secret_hash: r.secret_hash })),
    }));
  step("A4", "真实 UI: [data-device-action=pair] → device/pairing.create", "device/pairing.create", {}, { pairingId: state.pConsumed, uiSecretLen: uiPair1.secret ? uiPair1.secret.length : 0, secretSha16: secretCheckA.svcDigest });

  /* ── B 重置前的设备事实 ── */
  const consumeB = await mainApi("consumeById(" + JSON.stringify(state.pConsumed) + ", " + JSON.stringify({ displayName: DEVICE_A.displayName, platform: "darwin", architecture: "arm64", fingerprint: DEVICE_A.fingerprint }) + ", null)");
  state.deviceA = consumeB.device ? consumeB.device.deviceId : null;
  state.credentialA = consumeB.credential ? consumeB.credential.id : null;
  const grantRes = await mainApi("grantAccess(" + JSON.stringify(state.deviceA) + ", " + JSON.stringify("USER") + ", " + JSON.stringify(state.firstUser) + ", " + JSON.stringify(["device.use"]) + ")");

  const uiPairUnused = await uiStartPairing();
  const secretCheckU = await resolvePairingByUiSecret(uiPairUnused, "P2(unused)");
  state.pUnused = secretCheckU.pairingId;
  const snapB = snapshot(rec.userDataDir, "B_before_reset");
  record("B1", "重置前消费第一把密钥：配对成功 → 1 台设备 + 1 条凭据（组织 = 会话组织 / 状态 ACTIVE / 凭据版本 1 / 令牌转 CONSUMED），设备 ACL 1 行",
    consumeB.ok === true && !!state.deviceA && !!state.credentialA
      && consumeB.device.organizationId === state.firstOrgId && consumeB.device.status === "ACTIVE"
      && consumeB.credential.credentialVersion === 1
      && snapB.counts.devices === 1 && snapB.counts.device_credentials === 1
      && snapB.counts.device_pairing_credentials === 2 && snapB.counts.device_access >= 1,
    "ok=true + devices 1 + device_credentials 1 + device_pairing_credentials 2 + device_access >= 1 + 组织 = 会话组织 + ACTIVE + credentialVersion 1",
    JSON.stringify({ consume: { ok: consumeB.ok, error: consumeB.error || null, device: consumeB.device || null, credential: consumeB.credential || null, decision: consumeB.decision || null }, grant: { ok: grantRes.ok, error: grantRes.error || null, reason: grantRes.reason || null }, counts: snapB.counts, deviceRows: snapB.deviceRows, sessionOrg: state.firstOrgId }));
  step("B1", "主进程内 consumePairing（用真实 UI 那次 createPairing 的 secret；secret 不过探针边界）", "consumePairing", { displayName: DEVICE_A.displayName, fingerprint: DEVICE_A.fingerprint }, { ok: consumeB.ok, error: consumeB.error || null, deviceId: state.deviceA, credentialId: state.credentialA, organizationId: consumeB.device ? consumeB.device.organizationId : null });
  step("B1.acl", "主进程内 grantDeviceAccess（USER × device.use；真机没有 device_access 的 IPC 入口）", "grantDeviceAccess", { deviceId: state.deviceA, principalType: "USER", principalId: state.firstUser, actions: ["device.use"] }, { ok: grantRes.ok, error: grantRes.error || null, device_access: snapB.counts.device_access });

  const authB = await mainApi("captureConnection(" + JSON.stringify(DEVICE_A.fingerprint) + ")");
  const authzB = await mainApi("authorizeById(" + JSON.stringify(state.deviceA) + ", " + JSON.stringify("device.use") + ", null)");
  const hbB = await mainApi("heartbeatCaptured(" + JSON.stringify(state.deviceA) + ")");
  record("B2", "重置前旧凭据三件事都成立：指纹认证 ALLOW、Device Gate 授权 ALLOW、长连接心跳 ALLOW（这正是重置后必须失效的那条路径）",
    authB.ok === true && authzB.ok === true && hbB.ok === true,
    "authenticateConnection / authorizeDeviceById / heartbeat 都 ok=true",
    JSON.stringify({ authenticate: authB, authorize: { ok: authzB.ok, error: authzB.error || null, source: authzB.source || null, reason: authzB.reason || null }, heartbeat: { ok: hbB.ok, error: hbB.error || null, deviceId: hbB.deviceId || null } }));

  await uiRefresh();
  await sleep(500);
  const uiListB = await uiDeviceIds();
  record("B3", "真实 UI（设备面板）列出这台已配对设备：deviceId / 名称 / 状态与后端一致",
    uiListB.length === 1 && uiListB[0].id === state.deviceA && uiListB[0].name === DEVICE_A.displayName && uiListB[0].status === "ACTIVE",
    "1 行设备且 deviceId/displayName/status 与 registry 一致",
    JSON.stringify({ ui: uiListB, expected: { deviceId: state.deviceA, displayName: DEVICE_A.displayName } }));
  record("B4", "重置前再经真实 UI 签发第二把密钥并保持**未消费**（重置后要拿它验「旧的未使用密钥」）：库里 2 行密钥（1 CONSUMED + 1 ISSUED）",
    !!state.pUnused && state.pUnused !== state.pConsumed && secretCheckU.ok === true
      && dbCountWhere(rec.userDataDir, "device_pairing_credentials", "status = 'CONSUMED'") === 1
      && dbCountWhere(rec.userDataDir, "device_pairing_credentials", "status = 'ISSUED'") === 1,
    "2 行密钥：1 CONSUMED + 1 ISSUED，且第二把的 UI secret = 服务 secret",
    JSON.stringify({ pConsumed: state.pConsumed, pUnused: state.pUnused, uiSecretCheck: secretCheckU, consumed: dbCountWhere(rec.userDataDir, "device_pairing_credentials", "status = 'CONSUMED'"), issued: dbCountWhere(rec.userDataDir, "device_pairing_credentials", "status = 'ISSUED'"), uiSecretChecks: state.uiSecretChecks }));

  /* ── C 确认词错误（产品可见的回滚路径） ── */
  /**
   * 基线快照必须取在**全部重置前的设备动作之后**：B2 的心跳会 touchDevice（改 devices.last_seen_at）
   * 并写 device_audit，B3 的会话校验会更新 sessions 行。基线取早了，"逐行不变"就会把
   * 这些**正常写入**误报成"被拒的重置改了状态"。第一次运行正是踩了这个坑（见报告 §披露）。
   */
  // §60：配对前必须能确认"这是我要加入的 Control Service"。真机身份由 OPENARC_SERVICE_IDENTITY 配置（main.cjs:253），
  // 用错身份消费必须被拒（且在读取 token 之前就被拒 —— 拒绝无副作用，token 仍是 ISSUED）。
  const wrongSvc = state.serviceIdentity
    ? await mainApi("consumeById(" + JSON.stringify(state.pUnused) + ", " + JSON.stringify({ displayName: "Wrong Svc", fingerprint: "fp_d503h_wrong_svc" }) + ", " + JSON.stringify("svc_wrong_identity") + ")")
    : { ok: null, error: "PROBE_SERVICE_IDENTITY_NOT_CONFIGURED" };
  const pUnusedAfterWrongSvc = state.pUnused ? dbAll(rec.userDataDir, "SELECT status FROM device_pairing_credentials WHERE id = '" + state.pUnused + "'") : [];
  record("B5", "§60 服务身份校验在真机上真的在跑：配对时自报错误的 Control Service 身份 → SERVICE_IDENTITY_MISMATCH，token 仍是 ISSUED、0 新设备 / 0 新凭据",
    !!state.serviceIdentity && wrongSvc.ok === false && wrongSvc.error === "SERVICE_IDENTITY_MISMATCH"
      && pUnusedAfterWrongSvc.length === 1 && pUnusedAfterWrongSvc[0].status === "ISSUED"
      && dbCount(rec.userDataDir, "devices") === 1 && dbCount(rec.userDataDir, "device_credentials") === 1,
    "ok=false / error=SERVICE_IDENTITY_MISMATCH / 未消费的 token 仍 ISSUED / devices 1 / credentials 1",
    JSON.stringify({ configuredServiceIdentity: state.serviceIdentity, wrongSvc: { ok: wrongSvc.ok, error: wrongSvc.error || null, reason: wrongSvc.reason || null }, token: pUnusedAfterWrongSvc, counts: { devices: dbCount(rec.userDataDir, "devices"), credentials: dbCount(rec.userDataDir, "device_credentials") } }));

  const snapB2 = snapshot(rec.userDataDir, "B2_baseline_before_reject");
  const beforeC = { reset: snapB2.resetRows, identity: snapB2.identityRows, audit: snapB2.audit, counts: snapB2.counts, identityCounts: snapB2.identityCounts };
  const hbAuditDelta = snapB2.audit.device_audit.slice(snapB.audit.device_audit.length).map((s) => JSON.parse(s)).map((r) => r.event);
  const deviceRowMoved = !sameRows(snapB2.resetRows.devices, snapB.resetRows.devices);
  record("B6", "基线快照取在全部设备动作**之后**：B2 的心跳造成的 device_audit 增长（DEVICE_SEEN/TLS 事件）与 devices.last_seen_at 更新都落在 snapB 与 snapB2 之间 —— 第一次运行把基线取早了，C2/C3/D5 因此把正常写入误报成「被拒的重置改了状态」（本批披露）",
    hbAuditDelta.includes("DEVICE_SEEN") && deviceRowMoved,
    "snapB → snapB2 之间出现 DEVICE_SEEN 审计且 devices 行变化（证明基线晚于设备动作）",
    JSON.stringify({ auditEventsBetween: hbAuditDelta, deviceRowMoved, baselineAt: snapB2.at, counts: snapB2.counts, identityCounts: snapB2.identityCounts, deviceAuditRows: snapB2.audit.device_audit.length }));
  const badConfirm1 = await identity({ type: "identity/reset-installation" });
  const badConfirm2 = await identity({ type: "identity/reset-installation", confirm: "delete-all-identity-data" });
  step("C1", "identity/reset-installation（缺 confirm）", "identity/reset-installation", {}, { ok: badConfirm1?.ok, error: badConfirm1?.error, detail: badConfirm1?.detail });
  step("C2", "identity/reset-installation（confirm 大小写不符）", "identity/reset-installation", { confirm: "delete-all-identity-data" }, { ok: badConfirm2?.ok, error: badConfirm2?.error, detail: badConfirm2?.detail });
  record("C1", "错误 confirm 两次都被拒（INVALID_INPUT / confirm-required），返回体不带任何状态变更",
    badConfirm1?.ok === false && badConfirm1?.error === "INVALID_INPUT" && badConfirm2?.ok === false && badConfirm2?.error === "INVALID_INPUT",
    "两次都是 ok=false / error=INVALID_INPUT",
    JSON.stringify({ first: { ok: badConfirm1?.ok, error: badConfirm1?.error, detail: badConfirm1?.detail }, second: { ok: badConfirm2?.ok, error: badConfirm2?.error, detail: badConfirm2?.detail } }));

  const snapC = snapshot(rec.userDataDir, "C_after_bad_confirm");
  const resetSame = RESET_TABLES.every((t) => sameRows(snapC.resetRows[t], beforeC.reset[t]));
  const identitySame = IDENTITY_TABLES.every((t) => sameRows(snapC.identityRows[t], beforeC.identity[t]));
  record("C2", "被拒后 7 张重置表 + 5 张身份表**逐行不变**（只读 DB 全列比对，含 devices / device_credentials / device_pairing_credentials）",
    resetSame && identitySame,
    "7 + 5 张表逐行相等",
    JSON.stringify({ resetSame, identitySame, before: beforeC.counts, after: snapC.counts, deviceRowsAfter: snapC.deviceRows }));
  record("C3", "被拒后审计：authorization_audit / device_audit 逐行不变；audit_log 既有行一行不删、恰新增 2 条 DENY 留痕",
    AUDIT_TABLES.filter((t) => t !== "audit_log").every((t) => sameRows(snapC.audit[t], beforeC.audit[t]))
      && isPrefixOf(beforeC.audit.audit_log, snapC.audit.audit_log)
      && snapC.audit.audit_log.length - beforeC.audit.audit_log.length === 2
      && snapC.audit.audit_log.slice(beforeC.audit.audit_log.length).map((s) => JSON.parse(s)).every((r) => r.event === "reset-installation" && r.result === "DENY"),
    "两审计表逐行不变 + audit_log 前缀不变 + 恰新增 2 条 reset-installation/DENY",
    JSON.stringify({ deviceAuditSame: sameRows(snapC.audit.device_audit, beforeC.audit.device_audit), authorizationAuditSame: sameRows(snapC.audit.authorization_audit, beforeC.audit.authorization_audit), logDelta: snapC.audit.audit_log.length - beforeC.audit.audit_log.length, deviceAuditRows: snapC.audit.device_audit.length }));
  const gateC = await gate();
  const statusC = await identity({ type: "identity/status" });
  const paneC = await has('[data-device-pane="devices"]');
  record("C4", "被拒后会话与界面仍然有效（错误 confirm 不能把人踢出去），设备面板仍在",
    gateC === "ready" && statusC?.ok === true && paneC === true,
    "gate=ready + identity/status ok + 设备面板仍在",
    JSON.stringify({ gate: gateC, statusOk: statusC?.ok, panePresent: paneC }));

  /* ── D 正式重置 ── */
  const resetRes = await identity({ type: "identity/reset-installation", confirm: CONFIRM });
  state.resetStatus = resetRes?.status || null;
  step("D1", "identity/reset-installation（正确 confirm = " + CONFIRM + "）", "identity/reset-installation", { confirm: CONFIRM }, { ok: resetRes?.ok, error: resetRes?.error || null, status: resetRes?.status || null });
  record("D1", "重置命令成功并回报「未初始化 + 0 用户」", resetRes?.ok === true && resetRes?.status?.initialized === false && resetRes?.status?.userCount === 0, "ok=true / initialized=false / userCount=0", JSON.stringify({ ok: resetRes?.ok, status: resetRes?.status || null }));

  const snapD = snapshot(rec.userDataDir, "D_after_reset");
  const deviceZero = DEVICE_TABLES.map((t) => ({ table: t, before: beforeC.counts[t], after: snapD.counts[t] }));
  record("D2", "重置后**三张设备身份表 0 行**（devices / device_credentials / device_pairing_credentials —— 重置前分别有 1 / 1 / 2 行）",
    deviceZero.every((r) => r.after === 0) && deviceZero.every((r) => r.before > 0),
    "三表都为 0，且重置前都 > 0",
    JSON.stringify({ deviceZero, deviceRowsAfter: snapD.deviceRows }));
  const authzZero = AUTHZ_TABLES.map((t) => ({ table: t, before: beforeC.counts[t], after: snapD.counts[t] }));
  record("D3", "重置后四张授权事实表 0 行（含 device_access 1 → 0：第五批的 0 → 0 notVerified 在本批真机补上）",
    authzZero.every((r) => r.after === 0) && authzZero.find((r) => r.table === "device_access").before >= 1,
    "四表都为 0，且 device_access 重置前 >= 1",
    JSON.stringify({ authzZero }));
  const identityZero = IDENTITY_TABLES.map((t) => ({ table: t, before: beforeC.identityCounts[t], after: snapD.identityCounts[t] }));
  record("D4", "重置后身份五表 0 行（installations / teams / users / sessions / login_attempts）",
    identityZero.every((r) => r.after === 0) && identityZero.filter((r) => r.before > 0).length === 5,
    "五表都为 0，且重置前都有行",
    JSON.stringify({ identityZero }));

  const auditSameD = AUDIT_TABLES.filter((t) => t !== "audit_log").every((t) => sameRows(snapD.audit[t], beforeC.audit[t]));
  const logPrefixD = isPrefixOf(beforeC.audit.audit_log, snapD.audit.audit_log);
  const resetEvents = snapD.audit.audit_log.map((s) => JSON.parse(s)).filter((r) => r.event === "reset-installation").map((r) => r.result);
  record("D5", "审计未被重置波及：device_audit / authorization_audit 逐行不变；audit_log 既有行一行不删，重置自身留痕 = DENY,DENY,OK_REQUESTED,OK",
    auditSameD && logPrefixD && resetEvents.join(",") === "DENY,DENY,OK_REQUESTED,OK",
    "两审计表逐行不变 + audit_log 前缀不变 + 序列 DENY,DENY,OK_REQUESTED,OK",
    JSON.stringify({ auditSameD, logPrefixD, logDelta: snapD.audit.audit_log.length - beforeC.audit.audit_log.length, resetEvents, deviceAuditRowsBefore: beforeC.audit.device_audit.length, deviceAuditRowsAfter: snapD.audit.device_audit.length }));
  note("审计行数如实记录：audit_log " + beforeC.audit.audit_log.length + " → " + snapD.audit.audit_log.length + "（+2 DENY +1 OK_REQUESTED +1 OK）；device_audit " + beforeC.audit.device_audit.length + " → " + snapD.audit.device_audit.length + "（一行不删）。");

  const reuseUnused = await mainApi("consumeById(" + JSON.stringify(state.pUnused) + ", " + JSON.stringify({ displayName: "Survivor", fingerprint: "fp_d503h_survivor" }) + ", null)");
  const afterReuse = { devices: dbCount(rec.userDataDir, "devices"), credentials: dbCount(rec.userDataDir, "device_credentials") };
  const orphanCred = await mainApi("credentialByFingerprint(" + JSON.stringify("fp_d503h_survivor") + ")");
  record("D6", "重置后**旧的未使用密钥**再消费 → PAIRING_TOKEN_UNKNOWN，且 0 个新设备 / 0 条新凭据（第五批实测的残留能力被堵死）",
    reuseUnused.ok === false && reuseUnused.error === "PAIRING_TOKEN_UNKNOWN" && afterReuse.devices === 0 && afterReuse.credentials === 0 && orphanCred === null,
    "ok=false / error=PAIRING_TOKEN_UNKNOWN / devices=0 / device_credentials=0",
    JSON.stringify({ reuse: { ok: reuseUnused.ok, error: reuseUnused.error || null, reason: reuseUnused.reason || null, decision: reuseUnused.decision || null }, after: afterReuse, credentialByFingerprint: orphanCred }));
  step("D6", "主进程内 consumePairing（重置前签发、未消费的那条 secret）", "consumePairing", { pairingId: state.pUnused }, { ok: reuseUnused.ok, error: reuseUnused.error || null, devices: afterReuse.devices, credentials: afterReuse.credentials });

  const reuseConsumed1 = await mainApi("consumeById(" + JSON.stringify(state.pConsumed) + ", " + JSON.stringify({ displayName: "x", fingerprint: "fp_x" }) + ", null)");
  const reuseConsumed2 = await mainApi("consumeById(" + JSON.stringify(state.pConsumed) + ", " + JSON.stringify({ displayName: "y", fingerprint: "fp_y" }) + ", null)");
  record("D7", "重置后**旧的已消费密钥**再消费 → 稳定拒绝（两次同码，且不留任何行）",
    reuseConsumed1.ok === false && reuseConsumed2.ok === false && reuseConsumed1.error === reuseConsumed2.error
      && dbCount(rec.userDataDir, "devices") === 0 && dbCount(rec.userDataDir, "device_credentials") === 0,
    "两次 ok=false 且同码 + devices/credentials 仍为 0",
    JSON.stringify({ first: { ok: reuseConsumed1.ok, error: reuseConsumed1.error || null }, second: { ok: reuseConsumed2.ok, error: reuseConsumed2.error || null }, unusedKeyError: reuseUnused.error, counts: { devices: dbCount(rec.userDataDir, "devices"), credentials: dbCount(rec.userDataDir, "device_credentials") } }));

  const authD = await mainApi("authenticate(" + JSON.stringify(DEVICE_A.fingerprint) + ")");
  record("D8", "旧设备指纹认证 → DEVICE_CREDENTIAL_UNKNOWN（TLS 后「这个连接是谁」的查找键已失效，不是靠授权表兜的）",
    authD.ok === false && authD.error === "DEVICE_CREDENTIAL_UNKNOWN",
    "ok=false / error=DEVICE_CREDENTIAL_UNKNOWN",
    JSON.stringify({ authenticate: { ok: authD.ok, error: authD.error || null, reason: authD.reason || null, decision: authD.decision || null } }));
  const hbD = await mainApi("heartbeatCaptured(" + JSON.stringify(state.deviceA) + ")");
  record("D9", "重置前建立、仍握在手里的**旧长连接**再发一条受保护消息（心跳）→ DEVICE_CREDENTIAL_MISMATCH",
    hbD.ok === false && hbD.error === "DEVICE_CREDENTIAL_MISMATCH",
    "ok=false / error=DEVICE_CREDENTIAL_MISMATCH",
    JSON.stringify({ heartbeat: { ok: hbD.ok, error: hbD.error || null, reason: hbD.reason || null, decision: hbD.decision || null } }));

  await page.reload().catch(() => {});
  const gateD = await waitFor(async () => ["uninitialized", "unauthenticated"].includes(await gate()), 40000, 300);
  record("D10", "重置后渲染层重新询问身份（reload 走与重启同一条启动询问路径）→ 回到未初始化向导",
    gateD === true && (await gate()) === "uninitialized",
    "gate=uninitialized",
    JSON.stringify({ gate: await gate() }));
  step("D10", "page.reload() → identity/status → identity/restore", "UI reload", {}, { gate: await gate() });

  /* ── E 重新初始化 → 新组织 → 新密钥 → 配对成功 ── */
  const wizard2 = await setupWizard(ADMIN2, "D5-03H Reset Admin 2");
  const loggedIn2 = await login(ADMIN2.id, ADMIN2.pw);
  const gateE = await gate();
  const statusE = await identity({ type: "identity/status" });
  state.secondOrgId = (statusE && statusE.snapshot && statusE.snapshot.teamId) || null;
  state.secondUser = (statusE && statusE.snapshot && statusE.snapshot.userId) || null;
  step("E1.status", "identity/status（新组织 id）", "identity/status", {}, { ok: statusE?.ok, teamId: statusE?.snapshot?.teamId, userId: statusE?.snapshot?.userId });
  record("E1", "重置后可重新初始化（真实 UI 三步向导，新管理员）并登录；新组织 id ≠ 旧组织 id",
    wizard2.arrived === true && loggedIn2 === true && gateE === "ready" && !!state.secondOrgId && state.secondOrgId !== state.firstOrgId,
    "向导到达 + 登录后 gate=ready + 新旧组织 id 不同",
    JSON.stringify({ wizard: wizard2, login: loggedIn2, gate: gateE, oldOrg: state.firstOrgId, newOrg: state.secondOrgId }));

  const paneE = await openDevicePane();
  const uiListE0 = await uiDeviceIds();
  record("E2", "新组织的设备列表为空（旧设备对新组织不存在）；设备面板恢复可用（ADMIN）",
    paneE.ready === true && paneE.role === "ADMIN" && uiListE0.length === 0,
    "面板可用 + 设备列表 0 行",
    JSON.stringify({ pane: paneE, ui: uiListE0, dbDevices: dbCount(rec.userDataDir, "devices") }));

  const uiPairNew = await uiStartPairing();
  const secretCheckNew = await resolvePairingByUiSecret(uiPairNew, "P3(new-org)");
  state.pNew = secretCheckNew.pairingId;
  const pNewDb = state.pNew ? dbAll(rec.userDataDir, "SELECT id, organization_id, status FROM device_pairing_credentials WHERE id = '" + state.pNew + "'") : [];
  const capE = await mainApi("status()");
  record("E3", "新组织经真实 UI 签发新密钥：库里 1 行 ISSUED、组织 = 新组织；主进程捕获的会话上下文已换成新会话（sha256 前 16 位与旧会话不同）",
    !!uiPairNew.secret && secretCheckNew.ok === true && pNewDb.length === 1 && pNewDb[0].organization_id === state.secondOrgId && pNewDb[0].status === "ISSUED"
      && capE.hasCtx === true && capE.ctxDigest.sessionRefSha16 !== state.ctxDigest.sessionRefSha16,
    "1 行 ISSUED + 组织 = 新组织 + 会话 digest 变化",
    JSON.stringify({ uiPairing: { shown: uiPairNew.shown, pairingIds: uiPairNew.pairingIds, expiresText: uiPairNew.expiresText, secretLen: uiPairNew.secret ? uiPairNew.secret.length : 0 }, db: pNewDb, newCtx: capE.ctxDigest, oldCtx: state.ctxDigest, newOrg: state.secondOrgId }));
  step("E3", "真实 UI: device/pairing.create（新组织）", "device/pairing.create", {}, { pairingId: state.pNew });

  const byIdOld = await mainApi("authorizeById(" + JSON.stringify(state.deviceA) + ", " + JSON.stringify("device.use") + ", null)");
  const getOld = await mainApi("getWith(" + JSON.stringify(state.deviceA) + ", null)");
  const listNew = await mainApi("readWith(" + JSON.stringify("listDevices") + ", null)");
  const rowOld = await mainApi("deviceById(" + JSON.stringify(state.deviceA) + ")");
  record("E4", "新组织对旧设备取数 / 判权：DEVICE_NOT_FOUND（对外理由 NOT_FOUND_OR_FORBIDDEN，不泄漏存在性），列表为空，registry 里也没有那行",
    byIdOld.ok === false && byIdOld.error === "DEVICE_NOT_FOUND" && byIdOld.reason === "NOT_FOUND_OR_FORBIDDEN"
      && getOld.ok === false && getOld.error === "DEVICE_NOT_FOUND"
      && listNew.ok === true && listNew.items.length === 0 && rowOld === null,
    "authorizeDeviceById DEVICE_NOT_FOUND + reason NOT_FOUND_OR_FORBIDDEN + getDevice DEVICE_NOT_FOUND + listDevices 空 + deviceById null",
    JSON.stringify({ byId: { ok: byIdOld.ok, error: byIdOld.error || null, reason: byIdOld.reason || null }, get: { ok: getOld.ok, error: getOld.error || null }, list: { ok: listNew.ok, items: listNew.items.length }, deviceRow: rowOld }));

  const consumeE = await mainApi("consumeById(" + JSON.stringify(state.pNew) + ", " + JSON.stringify({ displayName: "D5-03H Post-Reset GPU", platform: "darwin", architecture: "arm64", fingerprint: state.newFingerprint }) + ", null)");
  state.deviceB = consumeE.device ? consumeE.device.deviceId : null;
  const snapE = snapshot(rec.userDataDir, "E_after_new_pairing");
  await uiRefresh();
  await sleep(500);
  const uiListE = await uiDeviceIds();
  record("E5", "重新初始化后的**新密钥配对成功**：新设备 + 新凭据 + 组织 = 新组织；真实 UI 列出该设备",
    consumeE.ok === true && consumeE.device.organizationId === state.secondOrgId && consumeE.credential.credentialVersion === 1
      && snapE.counts.devices === 1 && snapE.counts.device_credentials === 1
      && uiListE.length === 1 && uiListE[0].id === state.deviceB,
    "ok=true + organizationId=新组织 + devices 1 + credentials 1 + UI 1 行同一 deviceId",
    JSON.stringify({ consume: { ok: consumeE.ok, error: consumeE.error || null, device: consumeE.device || null, credential: consumeE.credential || null }, counts: snapE.counts, ui: uiListE, newOrg: state.secondOrgId }));
  step("E5", "主进程内 consumePairing（新组织的密钥）", "consumePairing", { pairingId: state.pNew }, { ok: consumeE.ok, deviceId: state.deviceB, organizationId: consumeE.device ? consumeE.device.organizationId : null });

  /* ── F 跨组织与自报组织 ── */
  const uiPairCross = await uiStartPairing();
  const secretCheckCross = await resolvePairingByUiSecret(uiPairCross, "P4(cross-org+race)");
  state.pCross = secretCheckCross.pairingId;
  const crossOrg = await mainApi("consumeById(" + JSON.stringify(state.pCross) + ", " + JSON.stringify({ displayName: "Cross Org", fingerprint: "fp_d503h_cross", organizationId: FOREIGN_ORG }) + ", null)");
  const pCrossAfter = state.pCross ? dbAll(rec.userDataDir, "SELECT status, organization_id, consumed_by_device_id FROM device_pairing_credentials WHERE id = '" + state.pCross + "'") : [];
  record("F1", "deviceIdentity.organizationId = 另一个组织 → PAIRING_TOKEN_ORGANIZATION_MISMATCH；token 仍是 ISSUED（被拒的消费不消耗 token）、0 新设备 / 0 新凭据",
    secretCheckCross.ok === true && crossOrg.ok === false && crossOrg.error === "PAIRING_TOKEN_ORGANIZATION_MISMATCH"
      && pCrossAfter.length === 1 && pCrossAfter[0].status === "ISSUED" && pCrossAfter[0].consumed_by_device_id === null
      && dbCount(rec.userDataDir, "devices") === 1 && dbCount(rec.userDataDir, "device_credentials") === 1,
    "ok=false / error=PAIRING_TOKEN_ORGANIZATION_MISMATCH / status=ISSUED / devices 1 / credentials 1",
    JSON.stringify({ uiSecretCheck: secretCheckCross, crossOrg: { ok: crossOrg.ok, error: crossOrg.error || null, reason: crossOrg.reason || null, decision: crossOrg.decision || null }, pairingRow: pCrossAfter, counts: { devices: dbCount(rec.userDataDir, "devices"), credentials: dbCount(rec.userDataDir, "device_credentials") } }));
  step("F1", "主进程内 consumePairing（deviceIdentity.organizationId = " + FOREIGN_ORG + "）", "consumePairing", { pairingId: state.pCross, organizationId: FOREIGN_ORG }, { ok: crossOrg.ok, error: crossOrg.error || null });

  const spoofCreate = await mainApi("createPairingWith(" + JSON.stringify({ organizationId: FOREIGN_ORG }) + ", 60000)");
  const foreignRows = dbCountWhere(rec.userDataDir, "device_pairing_credentials", "organization_id = '" + FOREIGN_ORG + "'");
  record("F2", "调用方自报 context.organizationId = 异组织（真实会话 + 自报字段）→ SESSION_ORGANIZATION_MISMATCH，且不产生任何行",
    spoofCreate.ok === false && spoofCreate.error === "SESSION_ORGANIZATION_MISMATCH" && foreignRows === 0,
    "ok=false / error=SESSION_ORGANIZATION_MISMATCH / 异组织行 0",
    JSON.stringify({ spoofCreate: { ok: spoofCreate.ok, error: spoofCreate.error || null }, foreignOrgRows: foreignRows, totalPairings: dbCount(rec.userDataDir, "device_pairing_credentials") }));
  step("F2", "主进程内 DeviceService.createPairing（真实 sessionRef + 自报异组织）", "createPairing", { context: { organizationId: FOREIGN_ORG } }, { ok: spoofCreate.ok, error: spoofCreate.error || null });
  note("路径披露：device:command 的 context 由主进程自建（device-bootstrap.cjs:54），渲染层递不进 context.organizationId —— 这条只能在真实主进程对同一个 DeviceService 直接调（会话仍是真实 UI 登录那次注入的 sessionRef）。");

  const sameOrgCreate = await mainApi("createPairingWith(" + JSON.stringify({ organizationId: state.secondOrgId }) + ", 60000)");
  const sameOrgRow = sameOrgCreate.pairing ? dbAll(rec.userDataDir, "SELECT organization_id FROM device_pairing_credentials WHERE id = '" + sameOrgCreate.pairing.id + "'") : [];
  record("F3", "对照：自报值与会话一致时允许，且落库组织仍然是会话组织（自报值改变不了它）",
    sameOrgCreate.ok === true && sameOrgCreate.pairing.organizationId === state.secondOrgId && sameOrgRow.length === 1 && sameOrgRow[0].organization_id === state.secondOrgId,
    "ok=true + 落库 organization_id = 会话组织",
    JSON.stringify({ created: { ok: sameOrgCreate.ok, error: sameOrgCreate.error || null, pairingId: sameOrgCreate.pairing ? sameOrgCreate.pairing.id : null, organizationId: sameOrgCreate.pairing ? sameOrgCreate.pairing.organizationId : null }, db: sameOrgRow, sessionOrg: state.secondOrgId }));

  const reads = [
    ["listPairings", await mainApi("readWith(" + JSON.stringify("listPairings") + ", " + JSON.stringify({ organizationId: FOREIGN_ORG }) + ")")],
    ["listDevices", await mainApi("readWith(" + JSON.stringify("listDevices") + ", " + JSON.stringify({ organizationId: FOREIGN_ORG }) + ")")],
    ["deviceAudit", await mainApi("auditWith(" + JSON.stringify({ organizationId: FOREIGN_ORG }) + ")")],
    ["getDevice", await mainApi("getWith(" + JSON.stringify(state.deviceB) + ", " + JSON.stringify({ organizationId: FOREIGN_ORG }) + ")")],
    ["authorizeDeviceById", await mainApi("authorizeById(" + JSON.stringify(state.deviceA) + ", " + JSON.stringify("device.use") + ", " + JSON.stringify({ organizationId: FOREIGN_ORG }) + ")")],
    ["listDevices(claim=userId)", await mainApi("readWith(" + JSON.stringify("listDevices") + ", " + JSON.stringify({ userId: "usr_d503h_spoof000000000001" }) + ")")],
  ];
  record("F4", "读路径同样以会话组织为准：自报异组织的 6 个入口一律被拒（组织不匹配 → SESSION_ORGANIZATION_MISMATCH；自报 userId 不匹配 → SESSION_USER_MISMATCH，同一形态）",
    reads.every(([, r]) => r.ok === false),
    "6 个入口都是 ok=false（组织 5 条 SESSION_ORGANIZATION_MISMATCH + 用户 1 条 SESSION_USER_MISMATCH）",
    JSON.stringify(reads.map(([name, r]) => ({ name, ok: r.ok, error: r.error || null }))));
  const ctrlRead = await mainApi("readWith(" + JSON.stringify("listDevices") + ", null)");
  record("F5", "对照：不传自报组织时读路径正常（证明 F4 的拒绝来自自报值，不是路径本身坏了）",
    ctrlRead.ok === true && ctrlRead.items.length === 1,
    "listDevices ok=true + 1 行设备",
    JSON.stringify({ ok: ctrlRead.ok, items: ctrlRead.items.length, deviceIds: ctrlRead.items.map((d) => d.deviceId) }));

  /* ── G 并发单次消费 ── */
  const beforeRace = { devices: dbCount(rec.userDataDir, "devices"), credentials: dbCount(rec.userDataDir, "device_credentials"), audits: dbCount(rec.userDataDir, "device_audit") };
  const race = await mainApi("raceTwo(" + JSON.stringify(state.pCross) + ", " + JSON.stringify(rec.userDataDir) + ", " + JSON.stringify("race-a") + ", " + JSON.stringify("race-b") + ")");
  const raceResults = race.results || [];
  const raceOks = raceResults.filter((r) => r.ok);
  const raceLosers = raceResults.filter((r) => !r.ok);
  const afterRace = { devices: dbCount(rec.userDataDir, "devices"), credentials: dbCount(rec.userDataDir, "device_credentials"), audits: dbCount(rec.userDataDir, "device_audit") };
  const raceRow = state.pCross ? dbAll(rec.userDataDir, "SELECT status, consumed_by_device_id FROM device_pairing_credentials WHERE id = '" + state.pCross + "'") : [];
  const winnerDeviceId = raceOks.length === 1 ? raceOks[0].device.deviceId : null;
  record("G1", "同一密钥并发两次消费（真实两路：主进程 live service + 同进程第二个 IdentityStore / DeviceService 连接）→ 恰好 1 台设备 / 1 条凭据，输家稳定码，无半状态，token 归属赢家",
    raceOks.length === 1 && raceLosers.length === 1
      && ["PAIRING_TOKEN_ALREADY_USED", "DB_BUSY"].includes(raceLosers[0].error)
      && afterRace.devices === beforeRace.devices + 1 && afterRace.credentials === beforeRace.credentials + 1
      && raceRow.length === 1 && raceRow[0].status === "CONSUMED" && raceRow[0].consumed_by_device_id === winnerDeviceId,
    "恰好 1 个 ok + 输家 ∈ {PAIRING_TOKEN_ALREADY_USED, DB_BUSY} + 设备 / 凭据各 +1 + token 归属赢家",
    JSON.stringify({ mode: race.mode || null, results: raceResults.map((r) => ({ ok: r.ok, error: r.error || null, thrown: r.thrown || null, deviceId: r.device ? r.device.deviceId : null })), beforeRace, afterRace, token: raceRow, winnerDeviceId, secretCheck: secretCheckCross.ok }));
  step("G1", "主进程内两路并发 consumePairing（两套独立 SQLite 连接）", "consumePairing ×2", { pairingId: state.pCross }, { results: raceResults.map((r) => ({ ok: r.ok, error: r.error || null })) });

  const uiPairWorker = await uiStartPairing();
  const secretCheckWorker = await resolvePairingByUiSecret(uiPairWorker, "P5(worker-race)");
  state.pWorker = secretCheckWorker.pairingId;
  const beforeW = { devices: dbCount(rec.userDataDir, "devices"), credentials: dbCount(rec.userDataDir, "device_credentials") };
  const raceW = await mainApi("raceWorker(" + JSON.stringify(state.pWorker) + ", " + JSON.stringify(rec.userDataDir) + ", " + JSON.stringify("race-worker") + ")");
  const wRes = raceW.worker || null;
  const mRes = raceW.main || null;
  const wOk = !!(wRes && wRes.ok && wRes.result && wRes.result.ok);
  const mOk = !!(mRes && mRes.ok && mRes.result && mRes.result.ok);
  const afterW = { devices: dbCount(rec.userDataDir, "devices"), credentials: dbCount(rec.userDataDir, "device_credentials") };
  const wRow = state.pWorker ? dbAll(rec.userDataDir, "SELECT status, consumed_by_device_id FROM device_pairing_credentials WHERE id = '" + state.pWorker + "'") : [];
  const wWinner = (wOk ? wRes.result.device.deviceId : (mOk ? mRes.result.device.deviceId : null));
  if (wRes && wRes.ok === true && wRes.result && wRes.result.ok !== undefined) {
    record("G2", "真并发（Worker 线程 vs 主线程，同一 tick 抢同一 token）→ 恰好 1 台设备 / 1 条凭据，输家稳定码，无半状态",
      [wOk, mOk].filter(Boolean).length === 1
        && afterW.devices === beforeW.devices + 1 && afterW.credentials === beforeW.credentials + 1
        && wRow.length === 1 && wRow[0].status === "CONSUMED" && wRow[0].consumed_by_device_id === wWinner,
      "两路里恰好 1 个 ok + 设备 / 凭据各 +1 + token CONSUMED 且归属赢家",
      JSON.stringify({ worker: wRes, main: mRes, before: beforeW, after: afterW, token: wRow, winner: wWinner, secretCheck: secretCheckWorker.ok }));
  } else {
    notVerified("Worker 线程真并发消费（G2）", "Worker 线程未返回消费结果（" + JSON.stringify(wRes || {}).slice(0, 300) + "）—— 这是探针侧基础设施限制，不是产品判定；G1 已在真实两路连接下给出单次消费证据。");
  }
  step("G2", "主进程内 Worker 线程 + 主线程并发 consumePairing", "consumePairing ×2（跨线程）", { pairingId: state.pWorker }, { worker: wRes, main: mRes });

  /* ── H 审计与秘密 ── */
  const allSecrets = [uiPair1.secret, uiPairUnused.secret, uiPairNew.secret, uiPairCross.secret, uiPairWorker.secret].filter(Boolean);
  const uiSecretsMatch = state.uiSecretMatch === true && state.uiSecretChecks.length === 5 && state.uiSecretChecks.every((c) => c.equal === true);
  record("H1", "五把密钥的界面显示值都等于服务返回值（sha256 逐字相等；明文不进产物）——后续用它们做的消费/拒绝判定因此是「界面那一把」的判定",
    uiSecretsMatch, "5/5 相等",
    JSON.stringify({ checks: state.uiSecretChecks, allEqual: uiSecretsMatch }));

  // 重置前那一行在重置后就没了（这正是 D2 的结论），所以它的 secret_hash 必须在重置前取（A4 已取，存在 state 里）。
  const p1HashBefore = state.p1SecretHashBeforeReset;
  const p1HashSvc = state.pConsumed ? await mainApi("pairingSecretHashOf(" + JSON.stringify(state.pConsumed) + ")") : null;
  const p1RowAfterReset = state.pConsumed ? dbAll(rec.userDataDir, "SELECT id FROM device_pairing_credentials WHERE id = '" + state.pConsumed + "'") : [];
  const pWorkerRow = state.pWorker ? dbAll(rec.userDataDir, "SELECT id, secret_hash FROM device_pairing_credentials WHERE id = '" + state.pWorker + "'") : [];
  const workerHashSvc = state.pWorker ? await mainApi("pairingSecretHashOf(" + JSON.stringify(state.pWorker) + ")") : null;
  const pWorkerSecret = uiPairWorker.secret || null;
  const pWorkerRecomputed = pWorkerSecret ? deviceDomain.pairingSecretHash(pWorkerSecret) : null;
  record("H2", "反证「库里确实有 sha256 形态的 secret_hash」：重置前那行（重置后已被删除）与当前那行的 secret_hash 都是 64 位 hex，且等于 sha256(明文 secret)（明文只在内存与界面出现过）",
    /^[0-9a-f]{64}$/.test(String(p1HashBefore)) && p1HashBefore === p1HashSvc && p1RowAfterReset.length === 0
      && pWorkerRow.length === 1 && /^[0-9a-f]{64}$/.test(String(pWorkerRow[0].secret_hash)) && pWorkerRow[0].secret_hash === pWorkerRecomputed && pWorkerRecomputed === workerHashSvc,
    "重置前那行（已被重置删除）与当前那行的 secret_hash 都是 64 位 hex 且等于 sha256(明文)",
    JSON.stringify({ preResetRow: { id: state.pConsumed, secret_hashCapturedBeforeReset: p1HashBefore, sha256FromMainProcess: p1HashSvc, rowExistsAfterReset: p1RowAfterReset.length }, currentRow: { id: state.pWorker, secret_hash: pWorkerRow.length ? pWorkerRow[0].secret_hash : null, sha256RecomputedInProbe: pWorkerRecomputed, sha256FromMainProcess: workerHashSvc } }));

  const scan = allSecrets.map((s) => ({ secretLen: s.length, secretSha16: sha16(s), scan: scanPlaintextSecret(s, rec.userDataDir) }));
  record("H3", "明文 secret 扫描（5 把密钥）：DB 文件 / WAL / SHM / 全表逐字段 dump / 审计 payload / userData 下的日志与 JSON / 主进程输出 —— **0 命中**",
    scan.every((r) => r.scan.hits.length === 0),
    "每条密钥的扫描命中数都是 0",
    JSON.stringify(scan.map((r) => ({ secretLen: r.secretLen, secretSha16: r.secretSha16, hits: r.scan.hits, scanned: r.scan.scanned }))));

  const deviceAuditNow = dbAll(rec.userDataDir, "SELECT * FROM device_audit ORDER BY rowid").map((r) => JSON.stringify(r));
  const deviceAuditPrefix = isPrefixOf(beforeC.audit.device_audit, deviceAuditNow);
  const deviceAuditEvents = deviceAuditNow.map((s) => JSON.parse(s)).filter((r) => r.event).map((r) => r.event);
  record("H4", "device_audit 在重置前后**既有行逐行不变**（重置一行不删；重置后只多了设备侧动作的审计），重置自身不写 device_audit",
    deviceAuditPrefix && beforeC.audit.device_audit.length > 0 && deviceAuditNow.length >= beforeC.audit.device_audit.length,
    "前缀逐行相等 + 重置前 device_audit 非空",
    JSON.stringify({ beforeRows: beforeC.audit.device_audit.length, afterRows: deviceAuditNow.length, prefixEqual: deviceAuditPrefix, events: deviceAuditEvents.slice(0, 30) }));
  const secretInAudit = allSecrets.some((s) => JSON.stringify(dbAll(rec.userDataDir, "SELECT * FROM device_audit")).indexOf(s) !== -1);
  record("H5", "审计 payload 里没有明文 secret（负向对照：同一 payload 里能找到事件名 / reasonCode 这类排障字段）",
    secretInAudit === false && deviceAuditEvents.length > 0,
    "明文 secret 不在 device_audit；审计事件名可见",
    JSON.stringify({ plaintextInDeviceAudit: secretInAudit, events: deviceAuditEvents.slice(0, 20) }));

  const snapFinal = snapshot(rec.userDataDir, "H_final");
  const oldOrgLeft = {
    devices: dbCountWhere(rec.userDataDir, "devices", "organization_id = '" + state.firstOrgId + "'"),
    credentials: dbCountWhere(rec.userDataDir, "device_credentials", "organization_id = '" + state.firstOrgId + "'"),
    pairings: dbCountWhere(rec.userDataDir, "device_pairing_credentials", "organization_id = '" + state.firstOrgId + "'"),
  };
  record("H6", "结束时没有任何旧组织残留：旧组织在设备三表里都是 0 行，且三张表里的每一行都属于当前组织",
    oldOrgLeft.devices === 0 && oldOrgLeft.credentials === 0 && oldOrgLeft.pairings === 0
      && dbCountWhere(rec.userDataDir, "devices", "organization_id <> '" + state.secondOrgId + "'") === 0
      && dbCountWhere(rec.userDataDir, "device_credentials", "organization_id <> '" + state.secondOrgId + "'") === 0,
    "旧组织 0 行 + 所有设备行都属于当前组织",
    JSON.stringify({ counts: snapFinal.counts, oldOrgLeft, currentOrg: state.secondOrgId }));

  /* ── Z 收尾 ── */
  const ENV_NOISE = /ExperimentalWarning|SQLite is an experimental|SetApplicationIsDaemon|NSOSStatusErrorDomain|IMKCFRunLoopWakeUpReliable|In-process GPU|ERR_BLOCKED_BY_CSP|DevTools listening/;
  const appStderrs = apps.map((a) => ({ label: a.label, pid: a.pid, errors: a.stderr.split("\n").filter((l) => /error|Error|FATAL/.test(l)).filter((l) => !ENV_NOISE.test(l)).slice(0, 4) }));
  record("Z1", "全部 Electron 实例的主进程 stderr 无未处理错误", appStderrs.every((a) => a.errors.length === 0), "无错误行", JSON.stringify(appStderrs));
  note("渲染层控制台错误样本：" + JSON.stringify(consoleErrors.filter((l) => !ENV_NOISE.test(l)).slice(0, 6)));
  note("对话框样本：" + JSON.stringify(dialogs.slice(0, 5)));

  const sourceFingerprint = RUN_ARTIFACTS.collectSourceFingerprint(ROOT, RUN_ARTIFACTS.d503SourceFiles(ROOT));
  const testedCommit = process.env.OPENARC_TESTED_COMMIT || gitText(["rev-parse", "HEAD"]);
  const out = {
    phase: "D5-03 第七批",
    title: "安装重置后旧设备身份失效 + 配对组织归属以会话为准（真机，正式命令 identity/reset-installation）",
    runId: RUN.runId, runDir: RUN.runDirRel, startedAt: RUN.startedAt,
    testedCommit, openarcCommit: testedCommit, openarcBranch: gitText(["rev-parse", "--abbrev-ref", "HEAD"]),
    command: "node experiments/d5-03/mcp-device-reset-e2e.mjs",
    scriptSha256: fileSha("experiments/d5-03/mcp-device-reset-e2e.mjs"),
    confirmUsed: { rejected: [null, "delete-all-identity-data"], accepted: CONFIRM },
    orgIds: { first: state.firstOrgId, second: state.secondOrgId, foreign: FOREIGN_ORG, foreignIsRealOrg: false },
    serviceIdentity: state.serviceIdentity,
    capture: { mode: "node-inspector-main-process", ctxDigestAtA4: state.ctxDigest, finalStatus: await mainApi("status()") },
    pairings: { consumed: state.pConsumed, unused: state.pUnused, newOrg: state.pNew, crossOrgAndRaceWinner: state.pCross, workerRace: state.pWorker },
    devices: { preReset: state.deviceA, preResetCredential: state.credentialA, postReset: state.deviceB },
    steps: STEPS,
    dbSnapshots: DB_SNAPSHOTS,
    checks: CHECKS, counts: { pass: passed, fail: failed, total: CHECKS.length },
    notVerified: NOT_VERIFIED, observations: OBSERVATIONS, productDefects: DEFECTS,
    appStderrs,
    instances: apps.map((a) => ({ label: a.label, pid: a.pid, cdpPort: a.cdpPort, inspectPort: a.inspectPort, userData: path.basename(a.userDataDir), inspectorTarget: a.inspectorTarget || null, captureInstalled: a.captureInstalled || null })),
    sourceFingerprint, sourceFingerprintSetSha256: sourceFingerprint.setSha256,
    fingerprints: Object.fromEntries(Object.entries(sourceFingerprint.files).map(([f, v]) => [f, v.sha256_16])),
    env: { platform: process.platform, arch: process.arch, node: process.version, electron: require("electron/package.json").version, cdpPort: apps[0] ? apps[0].cdpPort : null, inspectPort: apps[0] ? apps[0].inspectPort : null, cdpPortProbes: RUN.portProbes, userDataPrefix: USERDATA_PREFIX, runId: RUN.runId, cdpBase: CDP_PORT_BASE, inspectBase: INSPECT_PORT_BASE },
    boundary: {
      thirdPartyServices: false, userDataSent: false, arbitraryLocalPrograms: false, pluginIsolationClaimed: false,
      databaseWritesByProbe: false, writesOnlyByProduct: true, newOrganizationEntryAdded: false, productCodeModified: false,
      note: "配对消费 / 连接认证 / 心跳 / 设备 ACL 写入都经产品服务对象在真实主进程内调用（产品 IPC 没有这些入口，披露见脚本头）；重置走正式命令 identity/reset-installation；探针对数据库**只读**（DatabaseSync readOnly），未写任何 SQL、未改任何产品文件；未连真实第三方、未发用户数据、未运行任意第三方程序、未新增「创建组织」入口；连接成功不等于插件隔离通过（D5-04 范围）。",
    },
    at: new Date().toISOString(),
  };
  OUT = out;
  out.exitCode = failed === 0 ? 0 : 1;
  console.log(String.fromCharCode(10) + "结论：" + (failed === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ pass: passed, fail: failed, total: CHECKS.length, notVerified: NOT_VERIFIED.length }));
  return failed === 0 ? 0 : 1;
}

/* ══════════════════════════ 收尾 ══════════════════════════ */
let hardExitCleanupStarted = false;
const onHardExit = (signal) => {
  if (hardExitCleanupStarted) return;
  hardExitCleanupStarted = true;
  void (async () => {
    console.error("收到 " + signal + "：按本次运行清单收尾（进程树 + 自建 userData 目录）");
    try { await cleanupOwnProcesses(); } catch (err) { console.error("硬退出收尾（进程）失败：" + String((err && err.message) || err)); }
    try { OWNERSHIP.cleanupOwnedDirs({ log: (line) => console.error("   " + line) }); } catch (err) { console.error("硬退出收尾（目录）失败：" + String((err && err.message) || err)); }
    process.exit(signal === "SIGINT" ? 130 : 143);
  })();
};
process.once("SIGINT", () => onHardExit("SIGINT"));
process.once("SIGTERM", () => onHardExit("SIGTERM"));

let exitCode = 2;
try { exitCode = await main(); } catch (e) {
  console.error("验收异常：" + String((e && e.stack) || e));
  record("Z0", "验收脚本无未捕获异常", false, "无异常", String((e && e.message) || e));
  exitCode = 2;
}
const cleanup = await cleanupOwnProcesses();
console.log("收尾：只清理本次运行 spawn 的 pid 树（" + JSON.stringify(cleanup.targets.map((t) => ({ label: t.label, rootPid: t.rootPid, leftovers: t.leftovers }))) + "），未使用 pkill");
if (INSPECTOR) { try { INSPECTOR.close(); } catch { /* ignore */ } }
// 只读快照之外的原始证据：把最终库文件复制进 run 目录（此时进程已全部退出，WAL 已收敛）。
let dbEvidence = null;
try {
  const rec0 = apps[0];
  if (RUN && rec0) {
    const src = path.join(rec0.userDataDir, "identity.db");
    if (fs.existsSync(src)) {
      const dst = path.join(RUN.runDir, "identity.db.evidence");
      fs.copyFileSync(src, dst);
      const buf = fs.readFileSync(dst);
      dbEvidence = { path: path.relative(ROOT, dst), bytes: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") };
      fs.writeFileSync(dst + ".sha256", dbEvidence.sha256 + "  identity.db.evidence" + String.fromCharCode(10));
      console.log("原始库证据：" + dbEvidence.path + "（" + dbEvidence.bytes + " bytes，sha256 " + dbEvidence.sha256.slice(0, 16) + "）");
    }
  }
} catch (e) { console.error("复制库证据失败：" + String((e && e.message) || e)); }
cleanup.userDataDirsRemoved = OWNERSHIP.cleanupOwnedDirs({ log: (line) => console.log("   " + line) });
if (RUN) {
  try {
    const fallback = {
      phase: "D5-03 第七批", title: "安装重置后旧设备身份失效 + 配对组织归属以会话为准（真机）", aborted: true,
      checks: CHECKS, counts: { pass: passed, fail: failed, total: CHECKS.length },
      notVerified: NOT_VERIFIED, observations: OBSERVATIONS, productDefects: DEFECTS, steps: STEPS, dbSnapshots: DB_SNAPSHOTS,
    };
    const out = OUT || fallback;
    out.dbEvidence = dbEvidence;
    const fin = await RUN.finalize({ out, exitCode, logLines: LOG_LINES, cleanup });
    console.log("产物：" + fin.artifactPath + "（sha256 " + fin.artifactSha256.slice(0, 16) + "）+ " + fin.logPath + "；索引 " + RUN_ARTIFACTS.RUNS_REL + "/index.json");
  } catch (e) { console.error("产物写入失败：" + String((e && e.stack) || e)); }
} else {
  console.error("未创建 run 目录（createRun 失败），本次运行无产物");
}
process.exit(exitCode);
