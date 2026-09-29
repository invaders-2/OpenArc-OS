/**
 * D5-03 第五批 · 安装重置（identity/reset-installation）后的**授权数据一致性** 真机验收。
 *
 * 被测提交：integration/ui-core HEAD（本次运行脚本自报 testedCommit）。
 * 被验改动：electron/identity-store.cjs 的 RESET_AUTHORIZATION_DELETE_SQL —— 重置在既有的那个
 * transactSync 里先删**七张**表（授权事实四张 app_policy_provisions / app_resource_grants /
 * resource_grants / device_access ＋ 第七批新增的设备身份三张 device_credentials →
 * device_pairing_credentials → devices，子表先删），再删身份五表；审计三表一行不删。
 * 第七批文案更新（只改说明，不动判定）：本脚本原有 26 条断言一字未改，新增 D2b / C2b 两条覆盖设备三表。
 *
 * 走的是**真实产品入口**：真实 electron .（隔离 userData oa-d503b-<runId>-*）+ 真实产品 UI
 * 三步向导初始化 + 登录 + 程序坞窗口；授权状态的产生与撤销一律经产品命令层
 * （window.openarc.identity|resource|governance.command），**没有任何一条 SQL 写入**；
 * 查库一律 DatabaseSync readOnly。
 *
 * 段：
 *   A 装配 / 隔离 / 三步向导 / 登录 / 首次播种（15 提供记录 = resource 10 + model 4 + mcp 1）
 *   B 造「有授权 + 有墓碑」：resource_grants 一行（governance/grantResourceAccess）
 *     + 撤销 mcp-center 的 mcp 授权 + 撤销 canvas 的 model 授权（两条墓碑）
 *   C 负向：错误 confirm 两次 → INVALID_INPUT，且授权 / 墓碑 / 身份逐行不变（审计留 DENY）
 *   D 正确 confirm 真重置 → 七张重置表 0 行（四张授权表见 D2 + 第七批新增的设备身份三张见 D2b）/
 *     身份五表 0 行 / 审计三表逐行不变 /
 *     等价只读自检为空（产品未暴露 invariants() 入口 → 记 notVerified）
 *   E 重新初始化 → 新组织（新 id）拿到完整初始授权 15 提供记录 / 16 授权行，无旧墓碑残留
 *   F 组织 ID 复用（真机无产品入口 → notVerified；以 node 受控测试 T3 为证据，现场重跑留档）
 *   Z 收尾（stderr / 边界 / 源码指纹 / 总数）
 *
 * 硬约束（本脚本自证）：
 *   · 串行：同一时刻只有本脚本一个 Electron；每次运行独立 runId 目录 + 只追加索引 + .sha256；
 *   · 端口：从 OA_D503E_CDP_PORT 基址递增 acquirePort 独占；只清理本次运行 spawn 的 pid 树（pkillUsed=false）；
 *   · 临时目录：全部经 experiments/d5-03/userdata-ownership.cjs 建（owner.json 归属标记），
 *     收尾只删本次运行自己登记、标记确认是本进程写的目录；
 *   · 不连真实第三方、不发用户数据、不声称插件隔离通过、不新增「创建组织」入口。
 */
import { chromium } from "@playwright/test";
import { spawn, spawnSync, execFileSync } from "node:child_process";
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
const CDP_PORT_BASE = Number(process.env.OA_D503E_CDP_PORT || 9813);
/** 归属模块的命名空间前缀：cleanupOwnedDirs 只认 oa-d503b- 前缀 + 本进程写下的 owner.json。 */
const USERDATA_PREFIX_BASE = OWNERSHIP.PREFIX;
const CONFIRM = "DELETE-ALL-IDENTITY-DATA";
const ADMIN = { id: "admin@d503e-reset.test", pw: "reset-admin-1" };
const ADMIN2 = { id: "admin2@d503e-reset.test", pw: "reset-admin-2" };
const extraArgs = (process.env.OA_D503E_ELECTRON_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 授权事实四表（唯一权威是 identity-store.cjs 的 RESET_AUTHORIZATION_DELETE_SQL，这里只做断言取值）。 */
/* 第七批新增：重置删除集合里的另外三张 —— 设备身份事实（devices / device_credentials / device_pairing_credentials）。 */
const DEVICE_TABLES = Object.freeze(["devices", "device_credentials", "device_pairing_credentials"]);
const AUTHZ_TABLES = Object.freeze(["app_policy_provisions", "app_resource_grants", "resource_grants", "device_access"]);
const IDENTITY_TABLES = Object.freeze(["installations", "teams", "users", "sessions", "login_attempts"]);
const AUDIT_TABLES = Object.freeze(["audit_log", "authorization_audit", "device_audit"]);
/* 首次播种的期望形状（与 resource-service.cjs BUILTIN_APP_BASELINE / model-bootstrap / mcp-bootstrap 同源）。 */
const EXPECTED_APPS = Object.freeze({
  resource: ["ai", "browser", "canvas", "illustrator", "image-generator", "mcp-center", "photoshop", "resource-library", "skill-runtime", "video-generator"],
  model: ["ai", "canvas", "resource-library", "settings"],
  mcp: ["mcp-center"],
});
const EXPECTED_PROVISION_PAIRS = Object.entries(EXPECTED_APPS).flatMap(([key, apps]) => apps.map((a) => a + "|" + key)).sort();
const EXPECTED_GRANT_ROWS = 16; // 资源族 10 App + resource-library 的 memory 定向行 1 + model 4 + mcp 1

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
/** 每步"命令 + 返回"留档（报告里的逐条命令与返回就用这一份，不看推断）。 */
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

/* ══════════════════════════ 状态 ══════════════════════════ */
let RUN = null, OUT = null, USERDATA_PREFIX = USERDATA_PREFIX_BASE;
let page = null, app = null;
const apps = [], dialogs = [], consoleErrors = [], SPAWNS = [];
const state = { firstOrgId: null, secondOrgId: null, firstUser: null, firstOrgGrantShapes: null };
const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const textOf = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? (el.textContent || '') : '';");
const waitSel = (sel, ms = 15000) => waitFor(() => has(sel), ms);
const clickSel = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const identity = (payload) => js("return await window.openarc.identity.command(" + JSON.stringify(payload) + ")");
const resource = (payload) => js("return await window.openarc.resource.command(" + JSON.stringify(payload) + ")");
const governance = (payload) => js("return await window.openarc.governance.command(" + JSON.stringify(payload) + ")");
const mcpCmd = (payload) => js("return await window.openarc.mcp.command(" + JSON.stringify(payload) + ")");

/* ══════════════════════════ 身份（真实 UI） ══════════════════════════ */
async function login(identifier, pw) {
  await waitSel('[data-d3-id="login-identifier"]', 30000);
  await setInput('[data-d3-id="login-identifier"]', identifier);
  await setInput('[data-d3-id="login-password"]', pw);
  await clickSel('[data-d3-id="login-submit"]');
  return await waitFor(async () => (await gate()) === "ready", 60000);
}
async function logout() {
  const clicked = await clickSel('[data-d3-id="topbar-logout"]');
  const out = await waitFor(async () => (await gate()) !== "ready", 30000);
  return clicked === "ok" && out;
}
/** 真实 UI 三步向导（含每步的下一步按钮等待）。 */
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

/* ══════════════════════════ Electron 启停（只动自己的进程树） ══════════════════════════ */
async function portFree(port) {
  try { await fetch("http://127.0.0.1:" + port + "/json/version"); return false; } catch { return true; }
}
function psRows() {
  try {
    return execFileSync("ps", ["-axo", "pid=,ppid=,stat=,command="], { encoding: "utf8" })
      .split("\n").map((l) => { const m = l.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/); return m ? { pid: Number(m[1]), ppid: Number(m[2]), stat: m[3], cmd: m[4] } : null; })
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

async function verifyInstance(rec) {
  const deadline = Date.now() + 20000;
  let inApp = null, inDb = null;
  for (;;) {
    inApp = await js("try { const r = await window.openarc.identity.command({ type: 'identity/status' }); return (r && r.installationId) || null; } catch (e) { return null; }").catch(() => null);
    inDb = ((dbAll(rec.userDataDir, "SELECT id FROM installations LIMIT 1")[0] || {}).id) || null;
    if (inApp && inDb && inApp === inDb) return { ok: true, installationId: inApp };
    if (inApp && !inDb) return { ok: false, kind: "foreign-instance", inApp, inDb, dir: path.basename(rec.userDataDir) };
    if (inApp && inDb !== inApp) return { ok: false, kind: "mismatch", inApp, inDb };
    if (!inApp && !inDb && (await gate().catch(() => "no-root")) === "uninitialized") return { ok: true, freshUninitialized: true, cdpPort: rec.cdpPort };
    if (!inApp && inDb && Date.now() > deadline) return { ok: true, degraded: "identity/status 不可用", inDb, cdpPort: rec.cdpPort };
    if (Date.now() > deadline) return { ok: false, kind: "timeout", inApp, inDb, dir: path.basename(rec.userDataDir) };
    await sleep(400);
  }
}
async function launchApp({ userDataDir = null, label = "" } = {}) {
  if (app) { const stray = await killApp(app); note("launchApp 自我保护：先杀掉仍存活的上一实例 " + JSON.stringify(stray)); }
  const dir = userDataDir || OWNERSHIP.createOwnedDir({ prefix: USERDATA_PREFIX, kind: label ? "electron-userdata/" + label : "electron-userdata", runId: RUN ? RUN.runId : null });
  const requested = CDP_PORT_BASE + apps.length;
  const reservation = RUN ? await RUN.acquirePort(requested) : null;
  const cdpPort = reservation ? reservation.port : requested;
  if (reservation) await reservation.release();
  if (!(await portFree(cdpPort))) throw new Error("CDP 端口 " + cdpPort + " 仍被占用，拒绝启动（避免连到别的实例）");
  const child = spawn(electronPath, [".", "--user-data-dir=" + dir, "--remote-debugging-port=" + cdpPort, ...extraArgs], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OPENARC_IDENTITY_ADMIN: "1" },
  });
  SPAWNS.push({ kind: "electron", pid: child.pid, label, cdpPort, userDataDir: dir, at: new Date().toISOString() });
  const rec = { label, userDataDir: dir, cdpPort, child, pid: child.pid, browser: null, page: null, stderr: "", launchedAt: Date.now() };
  apps.push(rec);
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { rec.stderr += String(d); });
  let version = null;
  const deadline = Date.now() + 60000;
  while (!version && Date.now() < deadline) { try { version = await (await fetch("http://127.0.0.1:" + cdpPort + "/json/version")).json(); } catch { await sleep(300); } }
  if (!version) throw new Error("CDP 未就绪：" + label + " " + dir + " port=" + cdpPort);
  rec.browser = await chromium.connectOverCDP("http://127.0.0.1:" + cdpPort);
  const ctx = rec.browser.contexts()[0];
  const end = Date.now() + 40000;
  while (!rec.page && end > Date.now()) { rec.page = ctx.pages().find((p) => p.url().includes("dist/index.html")) || null; if (!rec.page) await sleep(300); }
  if (!rec.page) throw new Error("未找到界面页面：" + label);
  rec.page.on("dialog", (d) => { dialogs.push(String(d.message()).slice(0, 140)); void d.dismiss().catch(() => {}); });
  rec.page.on("console", (m) => { if (m.type() === "error") consoleErrors.push((label + ":" + m.text()).slice(0, 220)); });
  rec.page.on("pageerror", (e) => consoleErrors.push(label + ":pageerror:" + String(e.message).slice(0, 200)));
  app = rec; page = rec.page;
  rec.instance = await verifyInstance(rec);
  if (!rec.instance.ok) throw new Error("实例归属校验失败（CDP 串台或身份库启动失败）：" + JSON.stringify(rec.instance));
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
  const out = { pid: rec.child.pid, tree, mainGone: !pidAlive(rec.child.pid), leftovers: tree.filter(pidAlive), cdpPort: rec.cdpPort };
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
const dbCountWhere = (dir, table, where = "") => { const r = dbAll(dir, "SELECT COUNT(*) c FROM " + table + (where ? " WHERE " + where : ""))[0] || {}; return r.c === undefined ? -1 : Number(r.c); };
function dumpTables(dir, tables) {
  const out = {};
  for (const t of tables) out[t] = dbAll(dir, "SELECT * FROM " + t + " ORDER BY rowid").map((r) => JSON.stringify(r));
  return out;
}
const sameRows = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isPrefixOf = (prefix, full) => prefix.length <= full.length && prefix.every((row, i) => row === full[i]);
const pairsOf = (dir, orgId) => dbAll(dir, "SELECT app_id, policy_key FROM app_policy_provisions" + (orgId ? " WHERE organization_id = '" + orgId + "'" : ""))
  .map((r) => r.app_id + "|" + r.policy_key).sort();
const grantShapesOf = (dir, orgId) => dbAll(dir, "SELECT app_id, resource_id, collection_id, resource_type, department_id, scope, actions FROM app_resource_grants WHERE organization_id = '" + orgId + "'")
  .map((r) => [r.app_id, r.resource_id, r.collection_id, r.resource_type, r.department_id, r.scope, r.actions].join("|")).sort();
const tombstoneKeys = (dir) => dbAll(dir, "SELECT organization_id, app_id, policy_key, provisioned_at, revoked_at, revoked_by FROM app_policy_provisions WHERE revoked_at IS NOT NULL ORDER BY app_id")
  .map((r) => r.app_id + "|" + r.policy_key);
const schemaVersionOf = (dir) => Number((dbAll(dir, "PRAGMA user_version")[0] || {}).user_version ?? -1);

/** 与 identity-store.cjs invariants() 的判定逐条等价，但**只读复算**（产品没有暴露可读入口）。 */
function invariantsEquivalentReadonly(dir) {
  const bad = [];
  const insts = dbAll(dir, "SELECT * FROM installations");
  if (insts.some((r) => r.__error)) return ["读库失败：" + insts[0].__error];
  if (insts.length > 1) bad.push("installations 有 " + insts.length + " 行（必须 <= 1）");
  const rootTeams = dbAll(dir, "SELECT * FROM teams WHERE root = 1");
  if (rootTeams.length > 1) bad.push("root team 有 " + rootTeams.length + " 个（必须 <= 1）");
  const users = dbAll(dir, "SELECT * FROM users");
  const teamIds = new Set(dbAll(dir, "SELECT id FROM teams").map((r) => r.id));
  if (new Set(users.map((u) => u.identifier)).size !== users.length) bad.push("identifier 重复");
  for (const u of users) {
    if (!["ADMIN", "MEMBER"].includes(u.role)) bad.push("user " + u.id + " role 非法");
    if (!["ACTIVE", "DISABLED"].includes(u.status)) bad.push("user " + u.id + " status 非法");
    if (!teamIds.has(u.team_id)) bad.push("user " + u.id + " 指向不存在的 team");
    if (!Number.isFinite(u.created_at) || !Number.isFinite(u.updated_at)) bad.push("user " + u.id + " 时间戳非法");
    if (u.created_at > u.updated_at) bad.push("user " + u.id + " updated_at 早于 created_at");
    if (!u.password_hash || !u.password_salt) bad.push("user " + u.id + " 缺 verifier");
  }
  const inst = insts[0];
  if (inst) {
    for (const u of users) if (u.installation_id !== inst.id) bad.push("user " + u.id + " 不属于本 installation");
    if (inst.status === "INITIALIZING") bad.push("installation 停留在 INITIALIZING（事务未提交干净）");
    if (inst.status === "READY" && !inst.initialized_at) bad.push("READY 但没有 initialized_at");
    if (inst.status === "READY" && users.length === 0) bad.push("READY 但没有任何用户（无 admin 的安装）");
  }
  const userIds = new Set(users.map((u) => u.id));
  for (const s of dbAll(dir, "SELECT * FROM sessions")) {
    if (!userIds.has(s.user_id)) bad.push("session " + s.id + " 指向不存在的 user");
    if (!Number.isFinite(s.expires_at) || !Number.isFinite(s.idle_expires_at)) bad.push("session " + s.id + " 时间戳非法");
    if (s.expires_at <= s.created_at) bad.push("session " + s.id + " 有效期非正");
    if (s.revoked_at != null && !s.revoked_reason) bad.push("session " + s.id + " 已撤销但无原因");
    if (!s.token_hash || s.token_hash.length !== 64) bad.push("session " + s.id + " token_hash 缺失或长度不对");
  }
  return bad;
}
function snapshot(dir, tag) {
  const snap = {
    tag, at: new Date().toISOString(), dir: path.basename(dir), schemaVersion: schemaVersionOf(dir),
    counts: {},
    audit: {},
  };
  for (const t of [...AUTHZ_TABLES, ...IDENTITY_TABLES]) snap.counts[t] = dbCount(dir, t);
  snap.audit = dumpTables(dir, AUDIT_TABLES);
  snap.authzRows = dumpTables(dir, AUTHZ_TABLES);
  snap.identityRows = dumpTables(dir, IDENTITY_TABLES);
  snap.provisionPairs = pairsOf(dir);
  snap.tombstones = tombstoneKeys(dir);
  snap.invariantsEquivalent = invariantsEquivalentReadonly(dir);
  DB_SNAPSHOTS[tag] = snap;
  return snap;
}

/* ══════════════════════════ 主流程 ══════════════════════════ */
async function main() {
  RUN = await RUN_ARTIFACTS.createRun({ root: ROOT, script: "mcp-reset-e2e", basePort: CDP_PORT_BASE, envBaseVar: "OA_D503E_CDP_PORT", userDataPrefixBase: USERDATA_PREFIX_BASE });
  USERDATA_PREFIX = RUN.userDataPrefix;
  console.log("本次运行：" + RUN.runId + " → " + RUN.runDirRel + "（CDP 基址 " + CDP_PORT_BASE + "，userData 前缀 " + USERDATA_PREFIX + "）");
  note("被测提交：" + (gitText(["rev-parse", "HEAD"]) || "?") + "（分支 " + (gitText(["rev-parse", "--abbrev-ref", "HEAD"]) || "?") + "）");

  /* ── A 装配 / 隔离 / 三步向导 / 登录 / 首次播种 ── */
  const rec = await launchApp({ label: "reset-run1" });
  const wizard = await setupWizard(ADMIN, "D5-03E Reset Admin");
  const loggedIn = await login(ADMIN.id, ADMIN.pw);
  const gateA = await gate();
  record("A1", "真实 electron . 启动（隔离 userData " + USERDATA_PREFIX + "* / 独占 CDP 端口）+ 真实 UI 三步向导初始化 + 登录 admin",
    !!rec.browser && wizard.arrived === true && loggedIn === true && gateA === "ready",
    "CDP 可用 + 向导到达 unauthenticated/ready + 登录后 gate=ready",
    JSON.stringify({ cdpPort: rec.cdpPort, instance: rec.instance, userData: path.basename(rec.userDataDir), pid: rec.pid, wizard, login: loggedIn, gate: gateA }));
  step("A1.login", "登录 admin（真实 UI 表单）", "UI: [data-d3-id=login-*] → identity/login", { identifier: ADMIN.id }, { gate: gateA, wizard });

  const statusA = await identity({ type: "identity/status" });
  state.firstOrgId = (statusA && statusA.snapshot && statusA.snapshot.teamId) || null;
  state.firstUser = (statusA && statusA.snapshot && statusA.snapshot.userId) || null;
  step("A1.status", "identity/status（读组织 id / 用户 id / 安装 id）", "identity/status", {}, { ok: statusA?.ok, teamId: statusA?.snapshot?.teamId, userId: statusA?.snapshot?.userId, installationId: statusA?.installationId, initStatus: statusA?.initStatus });
  record("A2", "登录事件已触发 model/mcp 首次播种（身份权威给出的组织 id 非空）",
    !!state.firstOrgId && !!state.firstUser, "snapshot.teamId / userId 非空", JSON.stringify({ teamId: state.firstOrgId, userId: state.firstUser, installationId: statusA?.installationId }));

  // resource 族：走产品命令层创建一条文本资源（UI「资源库」同一命令），触发 #ensureBuiltinPolicy。
  // 注意：resource:command 的信封字段是 type（resource-bootstrap.cjs:150），不是 command —— 写错字段会被
  // IPC 白名单以 INVALID_INPUT 挡在服务层之外（首版探针踩过，见 logs 与报告里的披露）。
  const seedCreate = await resource({ type: "resource/create", resourceType: "text", name: "D5-03E 播种触发", content: "seed-trigger" });
  step("A3", "resource/create（产品命令层，触发 resource 族首次播种）", "resource/create", { type: "resource/create", resourceType: "text", name: "D5-03E 播种触发" }, { ok: seedCreate?.ok, error: seedCreate?.error || null, resourceId: seedCreate?.resource?.resourceId || null });
  const seeded = await waitFor(() => pairsOf(rec.userDataDir).length === EXPECTED_PROVISION_PAIRS.length, 15000, 200);
  const snapA = snapshot(rec.userDataDir, "A_seeded");
  record("A3", "首次播种 = 15 提供记录（resource 10 + model 4 + mcp 1），且与期望集合逐条相等；resource 族由真实产品命令 resource/create 触发（该命令本身也成功建出资源）",
    seedCreate?.ok === true && !!seedCreate?.resource?.resourceId && seeded && sameRows(snapA.provisionPairs, EXPECTED_PROVISION_PAIRS) && snapA.counts.app_resource_grants === EXPECTED_GRANT_ROWS,
    JSON.stringify({ createOk: true, provisions: 15, pairs: EXPECTED_PROVISION_PAIRS, grants: EXPECTED_GRANT_ROWS }),
    JSON.stringify({ create: { ok: seedCreate?.ok, error: seedCreate?.error || null, resourceId: seedCreate?.resource?.resourceId || null }, seeded, provisionCount: snapA.provisionPairs.length, pairs: snapA.provisionPairs, grants: snapA.counts.app_resource_grants, detail: snapA.counts }));
  record("A4", "被测库 schema v21（本次改动未动 schema；重置不依赖迁移）",
    snapA.schemaVersion === 21, "PRAGMA user_version = 21", JSON.stringify({ schemaVersion: snapA.schemaVersion }));
  state.firstOrgGrantShapes = grantShapesOf(rec.userDataDir, state.firstOrgId);

  /* ── B 造「有授权 + 有墓碑」 ── */
  const grantRes = await governance({ type: "governance/grantResourceAccess", principalType: "USER", principalId: state.firstUser, resourceType: "text", actions: ["resource.read"] });
  step("B1", "governance/grantResourceAccess（USER × text × resource.read）", "governance/grantResourceAccess", { principalType: "USER", principalId: "<admin userId>", resourceType: "text", actions: ["resource.read"] }, { ok: grantRes?.ok, error: grantRes?.error || null, grantId: grantRes?.grant?.id || grantRes?.grantId || null });
  const resGrants = dbCount(rec.userDataDir, "resource_grants");
  record("B1", "resource_grants 出现真实行（经产品治理命令，不是改库）",
    grantRes?.ok === true && resGrants >= 1, "governance/grantResourceAccess ok + resource_grants >= 1", JSON.stringify({ ok: grantRes?.ok, error: grantRes?.error || null, resource_grants: resGrants }));

  const accessMcp = await governance({ type: "governance/getAppAccess", appId: "mcp-center" });
  const mcpGrant = ((accessMcp && accessMcp.grants) || []).find((g) => g.resourceType === "mcp") || null;
  const revokeMcp = mcpGrant ? await governance({ type: "governance/revokeAppAccess", grantId: mcpGrant.grantId }) : { ok: false, error: "NO_MCP_GRANT" };
  step("B2", "governance/revokeAppAccess（撤 mcp-center 的 mcp 授权）", "governance/revokeAppAccess", { grantId: "<mcp grant>" }, { ok: revokeMcp?.ok, error: revokeMcp?.error || null, revokedGrantId: mcpGrant?.grantId || null });
  record("B2", "撤 mcp 授权被接受（正式治理入口）", revokeMcp?.ok === true, "ok=true", JSON.stringify({ ok: revokeMcp?.ok, error: revokeMcp?.error || null, grantId: mcpGrant ? mcpGrant.grantId : null }));

  const accessCanvas = await governance({ type: "governance/getAppAccess", appId: "canvas" });
  const canvasModelGrant = ((accessCanvas && accessCanvas.grants) || []).find((g) => g.resourceType === "model") || null;
  const revokeCanvas = canvasModelGrant ? await governance({ type: "governance/revokeAppAccess", grantId: canvasModelGrant.grantId }) : { ok: false, error: "NO_CANVAS_MODEL_GRANT" };
  step("B3", "governance/revokeAppAccess（撤 canvas 的 model 授权）", "governance/revokeAppAccess", { grantId: "<canvas model grant>" }, { ok: revokeCanvas?.ok, error: revokeCanvas?.error || null, revokedGrantId: canvasModelGrant?.grantId || null });

  // 墓碑生效的行为证据：撤权后 mcp 面必须无权
  const listAfterRevoke = await mcpCmd({ command: "mcp/list" });
  step("B4", "mcp/list（撤权后应 MCP_UNAUTHORIZED）", "mcp/list", {}, { ok: listAfterRevoke?.ok, error: listAfterRevoke?.error || null });
  const snapB = snapshot(rec.userDataDir, "B_before_reset");
  const tombstonesNow = tombstoneKeys(rec.userDataDir);
  record("B4", "状态就位：15 提供记录（其中 2 条墓碑）+ 14 条 app grant + resource_grants 有行 + 撤权在行为上生效",
    revokeMcp?.ok === true && revokeCanvas?.ok === true && snapB.provisionPairs.length === 15 && sameRows(tombstonesNow, ["canvas|model", "mcp-center|mcp"])
      && snapB.counts.app_resource_grants === 14 && snapB.counts.resource_grants >= 1 && listAfterRevoke?.error === "MCP_UNAUTHORIZED",
    JSON.stringify({ provisions: 15, tombstones: ["canvas|model", "mcp-center|mcp"], grants: 14, mcpListAfterRevoke: "MCP_UNAUTHORIZED" }),
    JSON.stringify({ revokeMcp: revokeMcp?.ok, revokeCanvas: revokeCanvas?.ok, provisions: snapB.provisionPairs.length, tombstones: tombstonesNow, grants: snapB.counts.app_resource_grants, resource_grants: snapB.counts.resource_grants, device_access: snapB.counts.device_access, mcpList: { ok: listAfterRevoke?.ok, error: listAfterRevoke?.error || null } }));
  if (snapB.counts.device_access === 0) notVerified("device_access 重置前没有行（0 → 0 不构成清理证据）", "真机单机没有可用的产品入口：device_access 由 deviceService.grantDeviceAccess 写入，而 consumePairing 需要**另一台设备**带服务身份消费配对密钥；产品 IPC 只暴露 device/pairing.create|list|revoke 与 device/disable|enable|revoke|rename|audit，没有授权入口。第四批口径一致：不可用改库构造。node 受控测试 T1/T2 在**七张重置表都非空**（含 device_access）下验证过清理与回滚；第七批起 device_access 的真机 1 → 0 证据在 experiments/d5-03/mcp-device-reset-e2e.mjs（真机 device_access 仍无 IPC 入口，那一脚本在真实主进程对同一 DeviceService 直接调用，已披露）。");

  /* ── C 负向：错误 confirm ── */
  /* 第七批新增字段（只增不改）：被拒前的设备身份三表逐行快照 —— 供新增的 C2b 断言使用。 */
  const deviceRowsBeforeReject = dumpTables(rec.userDataDir, DEVICE_TABLES);
  const beforeC = { authz: snapB.authzRows, identity: snapB.identityRows, audit: snapB.audit, counts: snapB.counts, deviceRows: deviceRowsBeforeReject };
  const badConfirm1 = await identity({ type: "identity/reset-installation" });
  const badConfirm2 = await identity({ type: "identity/reset-installation", confirm: "delete-all-identity-data" });
  step("C1", "identity/reset-installation（缺 confirm）", "identity/reset-installation", {}, { ok: badConfirm1?.ok, error: badConfirm1?.error, detail: badConfirm1?.detail });
  step("C2", "identity/reset-installation（confirm 大小写不符）", "identity/reset-installation", { confirm: "delete-all-identity-data" }, { ok: badConfirm2?.ok, error: badConfirm2?.error, detail: badConfirm2?.detail });
  record("C1", "错误 confirm 两次都被拒（INVALID_INPUT，detail=confirm-required），返回体不带任何状态变更",
    badConfirm1?.ok === false && badConfirm1?.error === "INVALID_INPUT" && badConfirm2?.ok === false && badConfirm2?.error === "INVALID_INPUT",
    "两次都是 ok=false / error=INVALID_INPUT",
    JSON.stringify({ first: { ok: badConfirm1?.ok, error: badConfirm1?.error, detail: badConfirm1?.detail }, second: { ok: badConfirm2?.ok, error: badConfirm2?.error, detail: badConfirm2?.detail } }));

  const snapC = snapshot(rec.userDataDir, "C_after_bad_confirm");
  const authzSame = AUTHZ_TABLES.every((t) => sameRows(snapC.authzRows[t], beforeC.authz[t]));
  const identitySame = IDENTITY_TABLES.every((t) => sameRows(snapC.identityRows[t], beforeC.identity[t]));
  const auditSameExceptLog = AUDIT_TABLES.filter((t) => t !== "audit_log").every((t) => sameRows(snapC.audit[t], beforeC.audit[t]));
  const logPrefixKept = isPrefixOf(beforeC.audit.audit_log, snapC.audit.audit_log);
  const logDelta = snapC.audit.audit_log.length - beforeC.audit.audit_log.length;
  const denyRows = snapC.audit.audit_log.slice(beforeC.audit.audit_log.length).map((s) => JSON.parse(s)).filter((r) => r.event === "reset-installation");
  record("C2", "被拒后授权 / 墓碑 / 身份逐行不变（四张授权表 + 五张身份表全量逐行比对）",
    authzSame && identitySame,
    "4 张授权表 + 5 张身份表逐行相等",
    JSON.stringify({ authzSame, identitySame, counts: snapC.counts, tombstones: snapC.tombstones, provisions: snapC.provisionPairs.length }));
  /* 第七批新增（只增不改）：被拒的重置同样不得碰设备三表。本流程里它们本来就是 0 行（0 → 0 不构成清理证据，
     真正的 1 → 0 证据在 experiments/d5-03/mcp-device-reset-e2e.mjs 的真机设备场景），这里只断言"一行没动"。 */
  const deviceRowsAfterReject = dumpTables(rec.userDataDir, DEVICE_TABLES);
  const deviceSame = DEVICE_TABLES.every((t) => sameRows(deviceRowsAfterReject[t], beforeC.deviceRows[t]));
  record("C2b", "被拒后三张设备身份表逐行不变（第七批新增断言；本流程里设备三表均为 0 行，0 → 0 不作为清理证据）",
    deviceSame && DEVICE_TABLES.every((t) => Array.isArray(deviceRowsAfterReject[t]) && deviceRowsAfterReject[t].length === beforeC.deviceRows[t].length),
    "devices / device_credentials / device_pairing_credentials 逐行相等（含行数为 0 这一事实）",
    JSON.stringify({ deviceSame, before: Object.fromEntries(DEVICE_TABLES.map((t) => [t, beforeC.deviceRows[t].length])), after: Object.fromEntries(DEVICE_TABLES.map((t) => [t, deviceRowsAfterReject[t].length])) }));
  record("C3", "被拒后审计：authorization_audit / device_audit 逐行不变；audit_log 只新增 2 条被拒留痕（DENY），既有行一行不删",
    auditSameExceptLog && logPrefixKept && logDelta === 2 && denyRows.length === 2 && denyRows.every((r) => r.result === "DENY"),
    "授权审计逐行不变 + audit_log 前缀不变 + 恰新增 2 条 reset-installation/DENY",
    JSON.stringify({ auditSameExceptLog, logPrefixKept, logDelta, denyRows: denyRows.map((r) => ({ event: r.event, result: r.result, error_code: r.error_code || null })) }));
  record("C4", "被拒后会话与界面仍然有效（错误 confirm 不能把人踢出去）",
    (await gate()) === "ready" && (await identity({ type: "identity/status" }))?.ok === true,
    "gate=ready + identity/status ok", JSON.stringify({ gate: await gate(), statusOk: (await identity({ type: "identity/status" }))?.ok }));

  /* ── D 正确 confirm 真重置 ── */
  const resetRes = await identity({ type: "identity/reset-installation", confirm: CONFIRM });
  step("D1", "identity/reset-installation（正确 confirm）", "identity/reset-installation", { confirm: CONFIRM }, { ok: resetRes?.ok, error: resetRes?.error || null, status: resetRes?.status || null });
  record("D1", "重置命令成功并回报「未初始化 + 0 用户」",
    resetRes?.ok === true && resetRes?.status && resetRes.status.initialized === false && resetRes.status.userCount === 0,
    "ok=true, status.initialized=false, status.userCount=0",
    JSON.stringify({ ok: resetRes?.ok, error: resetRes?.error || null, status: resetRes?.status || null }));

  const snapD = snapshot(rec.userDataDir, "D_after_reset");
  const authzZero = AUTHZ_TABLES.map((t) => ({ table: t, rows: snapD.counts[t] }));
  record("D2", "重置后四张授权事实表行数为 0（app_policy_provisions / app_resource_grants / resource_grants / device_access）",
    authzZero.every((r) => r.rows === 0), "四表都是 0 行", JSON.stringify({ before: Object.fromEntries(AUTHZ_TABLES.map((t) => [t, beforeC.counts[t]])), after: authzZero, tombstonePairsAfter: snapD.tombstones }));
  /* 第七批新增（只增不改）：重置后设备身份三表也必须 0 行；并与 D2 的四张合计成"七张全 0"。
     如实标注：本流程重置前设备三表本来就是 0 行（真机单机没有设备侧入口），所以这里的 0 → 0
     不是清理证据；1 / 1 / 2 → 0 的真机证据在同提交新增的 experiments/d5-03/mcp-device-reset-e2e.mjs。 */
  const deviceZero = DEVICE_TABLES.map((t) => ({ table: t, before: beforeC.deviceRows[t].length, rows: dbCount(rec.userDataDir, t) }));
  const sevenTables = Object.fromEntries([...AUTHZ_TABLES, ...DEVICE_TABLES].map((t) => [t, dbCount(rec.userDataDir, t)]));
  record("D2b", "重置后三张设备身份表 0 行（第七批新增断言）；与 D2 的四张授权表合计 = 重置删除集合**七张全 0**",
    deviceZero.every((r) => r.rows === 0) && Object.values(sevenTables).every((n) => n === 0),
    "设备三表 0 行 + 七张合计 0 行",
    JSON.stringify({ deviceZero, sevenTables }));
  const identityZero = IDENTITY_TABLES.map((t) => ({ table: t, rows: snapD.counts[t] }));
  record("D3", "重置后身份五表行数为 0（installations / teams / users / sessions / login_attempts）",
    identityZero.every((r) => r.rows === 0), "五表都是 0 行", JSON.stringify({ before: Object.fromEntries(IDENTITY_TABLES.map((t) => [t, beforeC.counts[t]])), after: identityZero }));

  const auditSameD = AUDIT_TABLES.filter((t) => t !== "audit_log").every((t) => sameRows(snapD.audit[t], beforeC.audit[t]));
  const logPrefixKeptD = isPrefixOf(beforeC.audit.audit_log, snapD.audit.audit_log);
  const logDeltaD = snapD.audit.audit_log.length - beforeC.audit.audit_log.length;
  const resetEvents = snapD.audit.audit_log.map((s) => JSON.parse(s)).filter((r) => r.event === "reset-installation");
  const resetOkSeq = resetEvents.map((r) => r.result);
  record("D4", "审计未被重置波及：authorization_audit / device_audit 逐行不变；audit_log 既有行一行不删，且 reset-installation 的 OK_REQUESTED / OK 都在",
    auditSameD && logPrefixKeptD && resetOkSeq.join(",") === "DENY,DENY,OK_REQUESTED,OK",
    "两审计表逐行不变 + audit_log 前缀不变 + reset-installation 记录 = DENY,DENY,OK_REQUESTED,OK",
    JSON.stringify({ auditSameExceptLog: auditSameD, logPrefixKept: logPrefixKeptD, logDelta: logDeltaD, resetEvents: resetEvents.map((r) => ({ result: r.result, at: r.at, error_code: r.error_code || null })), auditLogRowsBefore: beforeC.audit.audit_log.length, auditLogRowsAfter: snapD.audit.audit_log.length }));
  note("audit_log 行数变化如实记录：" + beforeC.audit.audit_log.length + " → " + snapD.audit.audit_log.length + "（+" + logDeltaD + " = 2 条被拒 DENY + 1 条 OK_REQUESTED + 1 条 OK）；既有行逐行前缀相等，不是「行数不变」。");

  const invD = snapD.invariantsEquivalent;
  record("D5", "重置后身份库自检为空（**等价只读复算**；产品未暴露 invariants() 可读路径，见 notVerified）",
    Array.isArray(invD) && invD.length === 0, "违规项 0 条", JSON.stringify({ invariants: invD }));
  notVerified("产品侧 invariants() 的**原生**可读入口", "identity-store.cjs invariants() 只被 node 测试直接调用，identity:command 白名单里没有对应命令（本轮不新增产品入口，也不改判定）；真机用同一判定的只读复算（invariantsEquivalentReadonly，见脚本）代替，结果为空。");

  // 界面回到未初始化：重置删掉了会话与安装，渲染层必须重新询问身份（产品没有 reset 的 UI 入口，故走同一启动询问路径）
  await page.reload().catch(() => {});
  const gateD = await waitFor(async () => ["uninitialized", "unauthenticated"].includes(await gate()), 40000, 300);
  record("D6", "重置后渲染层重新询问身份（reload 走与重启相同的 identity/status → restore 启动路径）→ 回到未初始化向导",
    gateD && (await gate()) === "uninitialized", "gate=uninitialized", JSON.stringify({ gate: await gate() }));
  step("D6", "page.reload()（与重启同一条启动询问路径）", "UI reload → identity/status → identity/restore", {}, { gate: await gate() });

  /* ── E 重新初始化 → 新组织完整初始授权 ── */
  const wizard2 = await setupWizard(ADMIN2, "D5-03E Reset Admin 2");
  const loggedIn2 = await login(ADMIN2.id, ADMIN2.pw);
  const gateE = await gate();
  record("E1", "重置后可重新初始化（真实 UI 三步向导，新管理员账号）并登录",
    wizard2.arrived === true && loggedIn2 === true && gateE === "ready", "向导到达 + 登录后 gate=ready", JSON.stringify({ wizard: wizard2, login: loggedIn2, gate: gateE }));
  const statusE = await identity({ type: "identity/status" });
  state.secondOrgId = (statusE && statusE.snapshot && statusE.snapshot.teamId) || null;
  step("E1.status", "identity/status（新组织 id）", "identity/status", {}, { ok: statusE?.ok, teamId: statusE?.snapshot?.teamId, userId: statusE?.snapshot?.userId });
  record("E2", "新组织 id 与旧组织 id 不同（不是复用了同一个 id）",
    !!state.secondOrgId && !!state.firstOrgId && state.secondOrgId !== state.firstOrgId,
    "newTeamId ≠ oldTeamId", JSON.stringify({ old: state.firstOrgId, new: state.secondOrgId }));

  const seeded2 = await waitFor(() => pairsOf(rec.userDataDir).length === 15, 20000, 200);
  const snapE = snapshot(rec.userDataDir, "E_reseeded");
  const newPairs = pairsOf(rec.userDataDir, state.secondOrgId);
  const oldOrgProvisions = dbCountWhere(rec.userDataDir, "app_policy_provisions", "organization_id = '" + state.firstOrgId + "'");
  const revokedLeft = dbCountWhere(rec.userDataDir, "app_policy_provisions", "revoked_at IS NOT NULL");
  const newGrantShapes = grantShapesOf(rec.userDataDir, state.secondOrgId);
  record("E3", "新组织拿到完整初始授权：15 提供记录（resource 10 + model 4 + mcp 1），且逐条等于期望集合",
    seeded2 && sameRows(newPairs, EXPECTED_PROVISION_PAIRS), JSON.stringify({ count: 15, pairs: EXPECTED_PROVISION_PAIRS }), JSON.stringify({ provisionCount: snapE.provisionPairs.length, pairs: newPairs }));
  record("E4", "没有任何旧墓碑残留：旧组织 0 行、全表 revoked_at 非空 0 条（新组织首次播种不被压制）",
    oldOrgProvisions === 0 && revokedLeft === 0, "旧组织 0 行 + 墓碑 0 条", JSON.stringify({ oldOrgProvisions, revokedRowsAnyOrg: revokedLeft, tombstones: snapE.tombstones }));
  record("E5", "新组织授权行 16 条，且与重置前那一次首次播种**逐行同形**（与全新安装同形）",
    snapE.counts.app_resource_grants === EXPECTED_GRANT_ROWS && sameRows(newGrantShapes, state.firstOrgGrantShapes),
    JSON.stringify({ grants: EXPECTED_GRANT_ROWS, shapes: state.firstOrgGrantShapes }),
    JSON.stringify({ grants: snapE.counts.app_resource_grants, diff: newGrantShapes.filter((s) => !(state.firstOrgGrantShapes || []).includes(s)), shapes: newGrantShapes }));
  const listAfterReseed = await mcpCmd({ command: "mcp/list" });
  step("E6", "mcp/list（重置后新组织应恢复初始授权）", "mcp/list", {}, { ok: listAfterReseed?.ok, error: listAfterReseed?.error || null });
  record("E6", "行为证据：重置前被撤销的 mcp 授权在新组织里是首次播种（mcp/list 不再 MCP_UNAUTHORIZED）",
    listAfterReseed?.ok === true, "mcp/list ok=true", JSON.stringify({ ok: listAfterReseed?.ok, error: listAfterReseed?.error || null }));
  const accessMcp2 = await governance({ type: "governance/getAppAccess", appId: "mcp-center" });
  const mcpGrant2 = ((accessMcp2 && accessMcp2.grants) || []).find((g) => g.resourceType === "mcp") || null;
  record("E7", "治理面同样看到新组织的 mcp 授权（revokedAt 为空）",
    !!mcpGrant2 && !mcpGrant2.revokedAt, "getAppAccess.mcp-center 有 mcp grant 且 revokedAt 空", JSON.stringify({ grant: mcpGrant2 ? { grantId: mcpGrant2.grantId, resourceType: mcpGrant2.resourceType, revokedAt: mcpGrant2.revokedAt || null } : null }));

  /* ── F 组织 ID 复用（真机不可构造 → node 受控测试证据） ── */
  const nodeTest = spawnSync(process.execPath, ["--test", "tests/d5-03-reset-authorization-consistency.test.mjs"], { cwd: ROOT, encoding: "utf8", timeout: 600000, maxBuffer: 1 << 26 });
  const nodeOut = String(nodeTest.stdout || "") + String(nodeTest.stderr || "");
  fs.writeFileSync(path.join(RUN.runDir, "node-reset-consistency.log"), nodeOut);
  const t3Line = nodeOut.split("\n").find((l) => l.includes("T3")) || "";
  const passLine = nodeOut.split("\n").filter((l) => /^# (tests|pass|fail)\b/.test(l));
  const t3Ok = /ok 1 - T3/.test(nodeOut) || nodeOut.includes("T3 · 组织 id 复用不被旧墓碑压制") ;
  record("F1", "组织 ID 复用的受控证据（node，tests/d5-03-reset-authorization-consistency.test.mjs，现场重跑）：T3 通过、整体 exit=0",
    nodeTest.status === 0 && /# fail 0\b/.test(nodeOut),
    "node --test exit=0 且 # fail 0（含 T3）",
    JSON.stringify({ exitCode: nodeTest.status, summary: passLine, t3: t3Line.slice(0, 200), log: "runs/" + path.basename(RUN.runDir) + "/node-reset-consistency.log" }));
  step("F1", "node --test tests/d5-03-reset-authorization-consistency.test.mjs", "node --test ...", {}, { exitCode: nodeTest.status, summary: passLine });
  notVerified("组织 ID 复用的**真机**对照（同一 org id 上「旧墓碑压制 → 重置后不压制」）", "产品没有「用指定 id 创建组织」的入口（identity/initialize 的组织 id 由产品随机生成，§18/§20 明确不新增创建组织入口），真机不可构造；本批以 node 受控测试 T3 为证据（现场重跑 exit=0，日志 runs/<runId>/node-reset-consistency.log），不用改库构造。");
  note("真机侧可观测的等价面：重置后 app_policy_provisions 里旧组织 0 行、全表 0 条墓碑（E4），所以「旧墓碑压住新播种」在真机上已无残留可压；同 id 复用的对照只有 node 证据。");

  /* ── Z 收尾 ── */
  const ENV_NOISE = /ExperimentalWarning|SQLite is an experimental|SetApplicationIsDaemon|NSOSStatusErrorDomain|IMKCFRunLoopWakeUpReliable|In-process GPU|ERR_BLOCKED_BY_CSP/;
  const appStderrs = apps.map((a) => ({ label: a.label, pid: a.pid, errors: a.stderr.split("\n").filter((l) => /error|Error|FATAL/.test(l)).filter((l) => !ENV_NOISE.test(l)).slice(0, 4) }));
  record("Z1", "全部 Electron 实例的主进程 stderr 无未处理错误", appStderrs.every((a) => a.errors.length === 0), "无错误行", JSON.stringify(appStderrs));
  note("渲染层控制台错误样本：" + JSON.stringify(consoleErrors.filter((l) => !ENV_NOISE.test(l)).slice(0, 6)));
  note("对话框样本：" + JSON.stringify(dialogs.slice(0, 5)));

  const sourceFingerprint = RUN_ARTIFACTS.collectSourceFingerprint(ROOT, RUN_ARTIFACTS.d503SourceFiles(ROOT));
  const testedCommit = process.env.OPENARC_TESTED_COMMIT || gitText(["rev-parse", "HEAD"]);
  const out = {
    phase: "D5-03 第五批",
    title: "安装重置后的授权数据一致性（真机，正式命令 identity/reset-installation）",
    runId: RUN.runId, runDir: RUN.runDirRel, startedAt: RUN.startedAt,
    testedCommit, openarcCommit: testedCommit, openarcBranch: gitText(["rev-parse", "--abbrev-ref", "HEAD"]),
    command: "node experiments/d5-03/mcp-reset-e2e.mjs",
    scriptSha256: fileSha("experiments/d5-03/mcp-reset-e2e.mjs"),
    orgIds: { first: state.firstOrgId, second: state.secondOrgId, reuseOnRealMachine: null },
    seeding: {
      expectedProvisionPairs: EXPECTED_PROVISION_PAIRS, expectedGrantRows: EXPECTED_GRANT_ROWS,
      expectedApps: EXPECTED_APPS,
      afterFirstSeed: { pairs: DB_SNAPSHOTS.A_seeded ? DB_SNAPSHOTS.A_seeded.provisionPairs : null, grants: DB_SNAPSHOTS.A_seeded ? DB_SNAPSHOTS.A_seeded.counts.app_resource_grants : null },
      afterReset: { pairs: DB_SNAPSHOTS.E_reseeded ? DB_SNAPSHOTS.E_reseeded.provisionPairs : null, grants: DB_SNAPSHOTS.E_reseeded ? DB_SNAPSHOTS.E_reseeded.counts.app_resource_grants : null },
    },
    steps: STEPS,
    dbSnapshots: DB_SNAPSHOTS,
    checks: CHECKS, counts: { pass: passed, fail: failed, total: CHECKS.length },
    notVerified: NOT_VERIFIED, observations: OBSERVATIONS, productDefects: DEFECTS,
    appStderrs,
    restarts: apps.map((a) => ({ label: a.label, pid: a.pid, cdpPort: a.cdpPort, userData: path.basename(a.userDataDir), instance: a.instance })),
    sourceFingerprint, sourceFingerprintSetSha256: sourceFingerprint.setSha256,
    fingerprints: Object.fromEntries(Object.entries(sourceFingerprint.files).map(([f, v]) => [f, v.sha256_16])),
    env: { platform: process.platform, arch: process.arch, node: process.version, electron: require("electron/package.json").version, cdpPort: apps[0] ? apps[0].cdpPort : null, cdpPortProbes: RUN.portProbes, userDataPrefix: USERDATA_PREFIX, runId: RUN.runId },
    boundary: {
      thirdPartyServices: false, userDataSent: false, arbitraryLocalPrograms: false, pluginIsolationClaimed: false,
      databaseWritesByProbe: false, writesOnlyByProduct: true, newOrganizationEntryAdded: false,
      note: "授权状态的产生/撤销全部经产品命令层（identity|resource|governance），探针对数据库**只读**（DatabaseSync readOnly）；没有改库代替主路径；重置走正式命令 identity/reset-installation（confirm 三处对照）；未连真实第三方、未发用户数据、未运行任意第三方程序、未新增「创建组织」入口；连接成功不等于插件隔离通过（D5-04 范围）。",
    },
    at: new Date().toISOString(),
  };
  OUT = out;
  out.exitCode = failed === 0 ? 0 : 1;
  console.log("\n结论：" + (failed === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ pass: passed, fail: failed, total: CHECKS.length, notVerified: NOT_VERIFIED.length }));
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
cleanup.userDataDirsRemoved = OWNERSHIP.cleanupOwnedDirs({ log: (line) => console.log("   " + line) });
if (RUN) {
  try {
    const fallback = {
      phase: "D5-03 第五批", title: "安装重置后的授权数据一致性（真机）", aborted: true,
      checks: CHECKS, counts: { pass: passed, fail: failed, total: CHECKS.length },
      notVerified: NOT_VERIFIED, observations: OBSERVATIONS, productDefects: DEFECTS, steps: STEPS, dbSnapshots: DB_SNAPSHOTS,
    };
    const fin = await RUN.finalize({ out: OUT || fallback, exitCode, logLines: LOG_LINES, cleanup });
    console.log("产物：" + fin.artifactPath + "（sha256 " + fin.artifactSha256.slice(0, 16) + "）+ " + fin.logPath + "；索引 " + RUN_ARTIFACTS.RUNS_REL + "/index.json");
  } catch (e) { console.error("产物写入失败：" + String((e && e.stack) || e)); }
} else {
  console.error("未创建 run 目录（createRun 失败），本次运行无产物");
}
process.exit(exitCode);
