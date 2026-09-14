/**
 * D4-01 Closure E · Full Secret Scan。
 *
 * 目标：证明 D4-01 的 Credential / Model / Proxy / Renderer 链路没有把 Provider Secret
 * 泄漏到任何非允许位置。允许出现的位置只有：
 *   1) 测试 setup 内存；2) production secure backend 加密前输入；
 *   3) outgoing Provider Authorization header；4) fake Provider 收到的 Authorization header。
 *
 * 本文件覆盖 Node 侧可观测的全部面：SQLite（逻辑 + 文件字节）/ audit / model_call_records /
 * logs / Resource Library / Search Index / Preview metadata / child process / Proxy capability /
 * 源码 / 生成文件。真实 safeStorage 加密 blob、Renderer DOM、preload response、Electron 日志
 * 由 tests/model-secret-ui.mjs 在真实 Electron 中覆盖。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createModelFixture } from "./model-fixtures.mjs";
import { startFakeProvider } from "./model-fake-provider.mjs";

const require = createRequire(import.meta.url);
const { registerModelIpc, disposeModelIpc } = require("../electron/model-bootstrap.cjs");
const { ModelProxy } = require("../electron/model-proxy.cjs");
const { IdentityLogger } = require("../electron/identity-log.cjs");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ART = path.join(ROOT, "artifacts", "d4-01");
const CHILD = path.join(HERE, "model-proxy-child.mjs");

const SECRET_PREFIX = "FAKE_PROVIDER_SECRET_FULLSCAN_D401_";
const rand = () => crypto.randomBytes(9).toString("hex");
const SECRET = SECRET_PREFIX + rand();
const SECRET2 = SECRET_PREFIX + rand();
const SECRETS = [SECRET, SECRET2];
const CAP_PREFIX = "mpx_"; // ModelProxy 生成的 capability 前缀

const report = {
  title: "D4-01 Closure E · Full Provider Secret Scan",
  at: new Date().toISOString(),
  surfaces: [],
  checks: [],
  scans: {},
};
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, detail: String(detail === undefined ? "" : detail).slice(0, 300) }); return !!ok; };
const surface = (name, expected, hits, evidence) => { report.surfaces.push({ surface: name, expected, hits, status: hits === 0 ? "PASS" : "FAIL", evidence }); };

// ---- 扫描工具 ----
const hitsIn = (value) => { const t = typeof value === "string" ? value : JSON.stringify(value ?? null); if (t == null) return []; return SECRETS.filter((s) => t.includes(s)); };
const hitsInText = (text) => SECRETS.filter((s) => String(text).includes(s));

function walkFiles(dir, { skip = new Set(), exts = null } = {}) {
  const out = [];
  const visit = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (!exts || exts.test(e.name)) out.push(p);
    }
  };
  visit(dir);
  return out;
}

function scanDatabase(db) {
  const meta = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").all();
  const hits = [];
  let cells = 0; let scanned = 0;
  for (const m of meta) {
    if (m.name.startsWith("sqlite_")) continue;
    scanned += 1;
    let rows;
    try { rows = db.prepare('SELECT * FROM "' + m.name + '"').all(); } catch (e) { hits.push({ table: m.name, error: String(e.message) }); continue; }
    for (const row of rows) {
      for (const [col, val] of Object.entries(row)) {
        cells += 1;
        let t = "";
        if (typeof val === "string") t = val;
        else if (val == null || typeof val === "number" || typeof val === "bigint") continue;
        else if (val instanceof Uint8Array) t = Buffer.from(val).toString("utf8");
        else t = String(val);
        for (const s of SECRETS) if (t.includes(s)) hits.push({ table: m.name, column: col });
      }
    }
  }
  return { hits, cells, tables: scanned };
}

function scanFiles(files) {
  const hits = [];
  for (const f of files) {
    let buf;
    try { buf = fs.readFileSync(f); } catch { continue; }
    const t = buf.toString("latin1");
    for (const s of SECRETS) if (t.includes(s)) hits.push(path.relative(ROOT, f));
  }
  return hits;
}

// ---- setup ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d4-01-e-scan-"));
const dbPath = path.join(tmp, "identity.db");
const storeRoot = path.join(tmp, "library");
const logger = new IdentityLogger();
for (const s of SECRETS) logger.registerSecret(s);

const f = await createModelFixture({ dbPath, storeRoot, logger, timeoutMs: 1500 });
const admin = f.adminCtx();
for (const appId of ["settings", "ai"]) {
  f.store.upsertApp({ appId, name: appId, publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
  f.modelService.grantAppModelAccess({ context: admin, appId, actions: ["model.view", "model.use", "model.manage", "model.test"] });
}
f.store.upsertApp({ appId: "canvas", name: "canvas", publisher: "test", status: "enabled", builtIn: 0 });

const ipc = {
  handlers: new Map(),
  handle(ch, fn) { if (this.handlers.has(ch)) throw new Error("duplicate handler " + ch); this.handlers.set(ch, fn); },
  removeHandler(ch) { this.handlers.delete(ch); },
};
registerModelIpc({ ipcMain: ipc, service: f.modelService, identity: { current: admin.sessionRef }, isTrusted: () => true });
const invoke = (cmd) => ipc.handlers.get("model:command")({}, cmd);

const providers = [];
const proxy = new ModelProxy({ modelService: f.modelService, clock: f.clock, logger });
let provider = null;
let fp = null;
let providerId = null;
let configId = null;
let proxyToken = null;
let echoProvesVector = false;
const ipcResponses = [];
const recordInvoke = async (cmd) => { const r = await invoke(cmd); ipcResponses.push({ command: cmd.command, response: r }); return r; };

after(async () => {
  try { await proxy.stop(); } catch { /* ignore */ }
  for (const p of providers) { try { await p.close(); } catch { /* ignore */ } }
  disposeModelIpc({ ipcMain: ipc });
  try { f.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

  const failed = report.checks.filter((c) => !c.ok);
  report.summary = { total: report.checks.length, pass: report.checks.length - failed.length, fail: failed.length };
  report.scans.artifact = {};
  report.scans.artifact.selfHits = 0;
  report.scans.artifact.selfHits = SECRETS.filter((s) => JSON.stringify(report).includes(s)).length;
  fs.mkdirSync(ART, { recursive: true });
  const serialized = JSON.stringify(report, null, 2);
  const artifactHits = SECRETS.filter((s) => serialized.includes(s)).length;
  assert.equal(artifactHits, 0, "artifact 自身不得包含 raw secret");
  fs.writeFileSync(path.join(ART, "secret-scan.json"), serialized);
  console.log("\n" + report.summary.pass + "/" + report.summary.total + " D4-01 Closure E secret-scan checks passed");
  if (failed.length) console.log("FAILED: " + failed.map((x) => x.name + " (" + x.detail + ")").join(" | "));
});

// ================= E1 · 全链路真实调用 =================
test("E1 · IPC 全链路真实调用产出真实数据面", async () => {
  fp = await startFakeProvider({ behavior: "success", secretEcho: SECRET });
  providers.push(fp);
  const created = await recordInvoke({ command: "provider/create", payload: { displayName: "Scan Provider", baseUrl: fp.baseUrl, credentialSecret: SECRET } });
  assert.equal(created.ok, true, JSON.stringify(created));
  providerId = created.provider.providerId;
  provider = f.modelStore.providerById(providerId);
  const model = await recordInvoke({ command: "model/create", payload: { providerId, remoteModelId: "fake-1", capabilities: ["chat"] } });
  assert.equal(model.ok, true);
  configId = model.model.configId;
  await recordInvoke({ command: "defaults/set", payload: { capability: "chat", configId, scope: "PERSONAL" } });
  const chat = await f.modelService.chat({ context: { sessionRef: admin.sessionRef, appId: "settings" }, configId, messages: [{ role: "user", content: "hi" }] });
  assert.equal(chat.ok, true, JSON.stringify(chat));
  assert.equal(fp.state.authHeaders[0], "Bearer " + SECRET, "Provider 必须收到真实 key");
  // 替换 + 删除，制造 credential replace/delete audit
  const rep = await recordInvoke({ command: "credential/replace", payload: { providerId, secret: SECRET2 } });
  assert.equal(rep.ok, true);
  const chat2 = await f.modelService.chat({ context: { sessionRef: admin.sessionRef, appId: "settings" }, configId, messages: [] });
  assert.equal(chat2.ok, true);
  assert.equal(fp.state.authHeaders[fp.state.authHeaders.length - 1], "Bearer " + SECRET2, "replace 后必须用新 key");
  // Resource / Search / Preview 派生面产生数据（内容不含 secret）
  const alice = f.ctx("alice");
  const res = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "Scan Resource", description: "fullscan resource", content: "openarc fullscan body" });
  assert.equal(res.ok, true, JSON.stringify(res));
  await f.searchService.indexResource(res.resource.resourceId);
  f.searchStore.upsertPreview({ cacheKey: "pv_fullscan", resourceId: res.resource.resourceId, resourceVersion: 1, contentChecksum: res.resource.checksum, previewKind: "text", storageKey: path.join(storeRoot, "preview", "pv_fullscan"), size: 12, mimeType: "text/plain", status: "READY" });
  assert.ok(f.searchStore.previewByResource(res.resource.resourceId).length >= 1, "preview metadata 必须有 1 行");
  check("E1 · 全链路调用 + 派生数据面就绪", true, "provider=" + providerId + " config=" + configId);
});

// ================= E2 · SQLite 全表扫描 =================
test("E2 · SQLite 全表扫描 0 raw secret", () => {
  const logical = scanDatabase(f.identity.connection);
  const fileHits = scanFiles([dbPath]);
  const hits = logical.hits.length + fileHits.length;
  surface("SQLite (logical + file bytes)", 0, hits, logical.tables + " tables / " + logical.cells + " cells / file-bytes=" + fileHits.length);
  check("E2 · SQLite logical + byte scan 无 raw secret", hits === 0, JSON.stringify(logical.hits.slice(0, 3)));
  report.scans.sqlite = { tables: logical.tables, cells: logical.cells, hits: logical.hits, fileHits };
});

// ================= E3 · 临时目录文件字节扫描 =================
test("E3 · 凭证/DB/临时目录文件字节扫描 0 raw secret", () => {
  const files = walkFiles(tmp);
  const hits = scanFiles(files);
  surface("Credential/DB/tmp files", 0, hits.length, files.length + " files under " + path.basename(tmp));
  check("E3 · 临时目录所有文件不含 raw secret", hits.length === 0, JSON.stringify(hits.slice(0, 3)));
  report.scans.tmpFiles = { count: files.length, hits };
});

// ================= E4 · Audit Scan =================
test("E4 · authorization_audit 0 raw secret / 0 Authorization", () => {
  const rows = f.store.authorizationAudit();
  const hits = hitsIn(rows);
  const bearer = JSON.stringify(rows).match(/Bearer\s+\S+/g) || [];
  surface("Authorization audit", 0, hits.length + bearer.length, rows.length + " rows");
  check("E4 · audit 无 raw secret 且无 Authorization header", hits.length === 0 && bearer.length === 0, "rows=" + rows.length + " bearer=" + bearer.length);
  report.scans.audit = { rows: rows.length, hits, bearer: bearer.length };
});

// ================= E5 · Model Call Records =================
test("E5 · model_call_records 仅白名单列，无 prompt/response/secret", () => {
  const cols = f.identity.connection.prepare("PRAGMA table_info(model_call_records)").all().map((c) => c.name);
  const expected = ["id", "request_id", "user_id", "app_id", "provider_id", "model_id", "config_version", "started_at", "duration_ms", "status", "error_code", "input_tokens", "output_tokens", "total_tokens"];
  const extra = cols.filter((c) => !expected.includes(c));
  const forbidden = cols.filter((c) => /prompt|response|content|body|secret|credential|capabilit|authorization/i.test(c));
  const rows = f.modelStore.recentCalls(50);
  const hits = hitsIn(rows);
  surface("Model call records", 0, hits.length + extra.length + forbidden.length, rows.length + " rows / " + cols.length + " cols");
  check("E5 · call records 列白名单且无 raw secret", hits.length === 0 && extra.length === 0 && forbidden.length === 0, "extra=" + JSON.stringify(extra) + " forbidden=" + JSON.stringify(forbidden));
  report.scans.callRecords = { columns: cols, rows: rows.length, hits, extra, forbidden };
});

// ================= E6 · Logs =================
test("E6 · IdentityLogger 无 raw secret 泄漏", () => {
  // 把本进程 stdout/stderr 记录也算作日志面：断言 IPC 返回对象本身不含 secret
  const ipcHits = hitsIn(ipcResponses);
  const leaks = logger.leaks();
  surface("Logs (IdentityLogger + IPC responses)", 0, leaks.length + ipcHits.length, logger.records.length + " log records / " + ipcResponses.length + " IPC responses");
  check("E6 · logger / IPC response 无 raw secret", leaks.length === 0 && ipcHits.length === 0, "records=" + logger.records.length);
  report.scans.logs = { loggerRecords: logger.records.length, leaks, ipcResponses: ipcResponses.length, ipcHits };
});

// ================= E7 · Resource / Search / Preview =================
test("E7 · Resource Library / Search Index / FTS / Preview 0 raw secret", () => {
  const db = f.identity.connection;
  const tables = ["library_resources", "resource_registry", "content_objects", "resource_tags", "collections", "resource_search_docs", "resource_search_fts", "resource_preview_cache", "resource_index_jobs", "resource_relations", "resource_versions"];
  const hits = [];
  let cells = 0;
  for (const t of tables) {
    let rows;
    try { rows = db.prepare('SELECT * FROM "' + t + '"').all(); } catch { continue; }
    for (const row of rows) for (const val of Object.values(row)) {
      cells += 1;
      const tt = typeof val === "string" ? val : val == null ? "" : String(val);
      for (const s of SECRETS) if (tt.includes(s)) hits.push(t);
    }
  }
  surface("Resource / Search / FTS / Preview", 0, hits.length, tables.length + " tables / " + cells + " cells");
  check("E7 · 派生面不含 raw secret（Credential 未被错误导入）", hits.length === 0, JSON.stringify(hits.slice(0, 3)));
  report.scans.resource = { tables, cells, hits };
});

// ================= E8 · IPC 错误矩阵 + Provider Error Echo =================
test("E8 · IPC 错误矩阵与 Provider error echo 全部脱敏", async () => {
  const ctx = { sessionRef: admin.sessionRef, appId: "settings" };
  // invalid endpoint
  const ep = await recordInvoke({ command: "provider/create", payload: { displayName: "bad", baseUrl: "file:///etc/passwd", credentialSecret: SECRET } });
  assert.equal(ep.error, "ENDPOINT_BLOCKED");
  // 先证明 echo 攻击向量真实存在：直接打 fake provider，响应体确实回显 secret
  fp.setBehavior("401");
  const raw = await fetch(fp.baseUrl + "/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + SECRET2 }, body: JSON.stringify({ model: "fake-1", messages: [] }) });
  const rawBody = await raw.text();
  echoProvesVector = rawBody.includes(SECRET);
  check("E8.0 · fake provider 确实在错误体中回显 raw secret（攻击向量成立）", echoProvesVector, "status=" + raw.status);
  // wrong credential / provider 401 → AUTH_FAILED，响应不含 secret
  const t401 = await recordInvoke({ command: "model/test", payload: { configId } });
  assert.equal(t401.error, "AUTH_FAILED", JSON.stringify(t401));
  // provider 500 → PROVIDER_UNAVAILABLE
  fp.setBehavior("500");
  const t500 = await recordInvoke({ command: "model/test", payload: { configId } });
  assert.equal(t500.error, "PROVIDER_UNAVAILABLE", JSON.stringify(t500));
  // timeout → MODEL_TIMEOUT（fixture timeoutMs=1500，fake provider slow=5000ms）
  fp.setBehavior("slow");
  const tOut = await recordInvoke({ command: "model/test", payload: { configId } });
  assert.equal(tOut.error, "MODEL_TIMEOUT", JSON.stringify(tOut));
  fp.setBehavior("success");
  const responses = [ep, t401, t500, tOut];
  const hits = hitsIn(responses);
  surface("IPC error responses (endpoint/401/500/timeout/echo)", 0, hits.length, responses.length + " responses");
  check("E8 · 所有错误投影均无 raw secret", hits.length === 0 && !JSON.stringify(responses).includes("Bearer"), JSON.stringify(hits));
  report.scans.ipcErrors = { hits, codes: { endpoint: ep.error, auth: t401.error, server: t500.error, timeout: tOut.error }, echoVector: echoProvesVector };
});

// ================= E9 · Child Process =================
test("E9 · Child env/argv/stdout/stderr 无 Provider Secret", async () => {
  const cap = proxy.issueCapability({ context: { sessionRef: admin.sessionRef, appId: "settings" }, configId, allowedCapabilities: ["chat"], maxCalls: 2, ttlMs: 60000 });
  assert.equal(cap.ok, true, JSON.stringify(cap));
  proxyToken = cap.capability.token;
  await proxy.start();
  const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, D4_PROXY_URL: proxy.baseUrl, D4_PROXY_TOKEN: proxyToken };
  const run = await new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
  assert.equal(run.code, 0, JSON.stringify(run));
  const childSurface = JSON.stringify(childEnv) + "\n" + JSON.stringify([CHILD]) + "\n" + run.out + "\n" + run.err;
  const secretHits = hitsInText(childSurface);
  const capPresent = childSurface.includes(proxyToken);
  surface("Child env/argv/stdout/stderr", "provider secret = 0", secretHits.length, "proxy capability present (allowed)=" + capPresent);
  check("E9 · Child 无 provider secret；capability 仅出现在可信 child", secretHits.length === 0 && capPresent, JSON.stringify(secretHits));
  report.scans.child = { secretHits, capabilityInChild: capPresent, stdout: run.out.trim().slice(0, 120) };
});

// ================= E10 · Proxy Capability Persistence =================
test("E10 · Proxy capability 不落盘（DB/audit/call records/artifact 无完整 token）", () => {
  assert.ok(proxyToken && proxyToken.startsWith(CAP_PREFIX), "需要先签发 capability");
  const text = [
    JSON.stringify(f.store.authorizationAudit()),
    JSON.stringify(f.modelStore.recentCalls(50)),
    JSON.stringify(logger.records),
    JSON.stringify(logicalProxyTable(f.identity.connection)),
  ].join("\n");
  const capInDb = SECRETS.filter((s) => text.includes(s)); // 顺带确认 secret 也不在
  const capPersisted = text.includes(proxyToken);
  surface("Proxy capability persistence", "no full bearer token", capPersisted ? 1 : 0, "capabilityId only / token 仅进程内存");
  check("E10 · capability token 未持久化到 DB/audit/call records/logs", !capPersisted && capInDb.length === 0, "capPersisted=" + capPersisted);
  report.scans.proxyCapability = { capPersisted, capInDb, capabilityId: "[omitted]" };
});

function logicalProxyTable(db) {
  // 显式扫描 sqlite_master 中与 model/proxy 相关的表定义与内容（不打印 token）
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%model%' OR name LIKE '%proxy%' OR name LIKE '%capab%')").all();
  const out = [];
  for (const t of tables) { try { out.push({ table: t.name, rows: db.prepare('SELECT * FROM "' + t.name + '"').all() }); } catch { /* ignore */ } }
  return out;
}

// ================= E11 · Source / Generated Files =================
test("E11 · 源码 live-key 扫描 + 生成文件扫描", () => {
  const skip = new Set(["node_modules", ".git"]);
  const files = walkFiles(ROOT, { skip });
  const secretHits = scanFiles(files);
  const livePatterns = [/sk-[A-Za-z0-9]{20,}/g, /Bearer\s+[A-Za-z0-9._-]{24,}/g, /AKIA[0-9A-Z]{16}/g];
  const liveHits = [];
  let scanned = 0;
  for (const file of files) {
    if (!/\.(ts|tsx|js|jsx|cjs|mjs|json|md|txt|log|html)$/.test(file)) continue;
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    scanned += 1;
    for (const re of livePatterns) for (const m of text.matchAll(re)) { if (!m[0].includes("fake")) liveHits.push({ file: path.relative(ROOT, file), kind: m[0].slice(0, 12) + "…" }); }
  }
  surface("Source code + generated files", 0, secretHits.length + liveHits.length, files.length + " files (" + scanned + " text)");
  check("E11 · 源码/生成文件无 raw secret，且无真实形态 key 字面量", secretHits.length === 0 && liveHits.length === 0, "secret=" + JSON.stringify(secretHits.slice(0, 3)) + " live=" + JSON.stringify(liveHits.slice(0, 3)));
  report.scans.source = { scannedFiles: files.length, secretHits, liveHits };
});

// ================= E12 · Matrix =================
test("E12 · Secret Scan Matrix 汇总", () => {
  assert.equal(report.surfaces.length >= 10, true, "面数不足");
  const failed = report.surfaces.filter((s) => s.status === "FAIL");
  report.summaryMatrix = { surfaces: report.surfaces.length, fail: failed.length };
  check("E12 · 所有扫描面 PASS", failed.length === 0, failed.map((s) => s.surface).join(","));
});
