/** D4-03 · Tool arguments safe projection 值级去敏：绝对路径 / capability / credential 绝不落 task_tool_proposals.arguments_safe。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
import { createTaskHarnessFixture } from "./fixtures/harness-acp/task-harness-fixture.mjs";
const require = createRequire(import.meta.url);
const { ToolFacadeBridge, redactUnsafe } = require("../electron/tool-facade-bridge.cjs");
const { buildBridgeManifest } = require("../electron/tool-registry.cjs");
const domain = require("../electron/tool-domain.cjs");
const { ControlledToolProxy } = require("../electron/controlled-tool-proxy.cjs");

const READ_TOOLS = ["resource.read.metadata", "resource.search"];
const ABS = "/Users/wepingli/Documents/very-private-notes/secret-plan.txt";
const SECRET = "sk-live-DEADBEEF-not-a-real-key";
const NESTED_TOOL_ID = "test.projection.probe";
const LONG_TOOL_ID = "test.long.message";

/** test-only contract：无长度上限的 string 参数，用于断言执行/落库解耦。 */
const LONG_CONTRACT = {
  toolId: LONG_TOOL_ID,
  version: 1,
  displayName: "Long Message Probe",
  description: "测试专用：>256 字符参数的执行入参与落库投影解耦断言。",
  inputSchema: { type: "object", additionalProperties: false, properties: { message: { type: "string", minLength: 1 } }, required: ["message"] },
  outputSchema: { type: "object", additionalProperties: false, properties: { echo: { type: "string" } }, required: ["echo"] },
  riskClass: "READ_ONLY",
  sideEffect: "READ",
  requiresApproval: false,
  requiredPermissions: [],
  resourceActions: [],
  executionProvider: "test.probe",
  enabled: true,
  expectedSideEffects: ["no side effect"],
};
const NESTED_CONTRACT = {
  toolId: NESTED_TOOL_ID,
  version: 1,
  displayName: "Projection Probe",
  description: "测试专用：验证 safe projection 对嵌套 object/array 的递归去敏。",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      filter: { type: "object", properties: { path: { type: "string" }, tags: { type: "array", items: { type: "string" } } } },
      notes: { type: "array", items: { type: "string" } },
    },
  },
  outputSchema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] },
  riskClass: "READ_ONLY",
  sideEffect: "READ",
  requiresApproval: false,
  requiredPermissions: [],
  resourceActions: [],
  executionProvider: "test",
  enabled: true,
  expectedSideEffects: ["no side effect"],
};

async function setup() {
  const fx = await createToolHarnessFixture({ withAdapters: true });
  const manifest = buildBridgeManifest(fx.toolRegistry, { readToolIds: READ_TOOLS, writeToolIds: [] });
  const bridge = new ToolFacadeBridge({ toolProxy: fx.toolProxy, manifest, clock: fx.f.clock });
  await bridge.start();
  const origClose = fx.close.bind(fx);
  fx.close = async () => { try { await bridge.stop(); } catch { /* ignore */ } await origClose(); };
  return { fx, bridge };
}
async function call(bridge, token, body) {
  const res = await fetch(bridge.baseUrl + "/tool-call", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}
function issue(bridge, fx, { maxCalls = 4, allowedTools = READ_TOOLS } = {}) {
  const run = fx.dshRunSetup();
  const cap = bridge.issueCapability({ context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, allowedTools, maxCalls });
  assert.equal(cap.ok, true, JSON.stringify(cap));
  return { run, cap };
}
function proposalRows(fx, toolId) {
  const sql = "SELECT tool_id, status, arguments_safe, arguments_hash FROM task_tool_proposals WHERE tool_id = ? ORDER BY rowid";
  return fx.f.identity.connection.prepare(sql).all(toolId);
}
/** 只读全库文本扫描（fixture identity 连接 + sqlite_master 遍历）。 */
function scanDbText(db, needles) {
  const hits = [];
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const table of tables) {
    let rows;
    try { rows = db.prepare('SELECT * FROM "' + table + '"').all(); } catch { continue; }
    for (const row of rows) for (const [column, value] of Object.entries(row)) {
      const text = typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";
      if (!text) continue;
      for (const needle of needles) if (text.includes(needle)) hits.push({ table, column, needle, sample: text.slice(0, 160) });
    }
  }
  return hits;
}

/** 只读全库正则扫描：以边界锚定的绝对路径形态（含裸单段）扫所有表文本列。 */
function scanDbTextRe(db, re) {
  const hits = [];
  const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const table of tables) {
    let rows;
    try { rows = db.prepare('SELECT * FROM "' + table + '"').all(); } catch { continue; }
    for (const row of rows) for (const [column, value] of Object.entries(row)) {
      const text = typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";
      if (!text) continue;
      rx.lastIndex = 0;
      const m = rx.exec(text);
      if (m) hits.push({ table, column, match: m[0], sample: text.slice(0, 160) });
    }
  }
  return hits;
}

test("a) 绝对路径参数仍 INVALID，但 arguments_safe 落库前已替换为 [REDACTED_PATH]", async () => {
  const { fx, bridge } = await setup();
  try {
    const { run, cap } = issue(bridge, fx);
    const r = await call(bridge, cap.capability.token, { toolId: "resource.read.metadata", callId: "redact_abs_1", arguments: { resourceRef: ABS } });
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, "TOOL_ARGUMENT_INVALID");
    const rows = proposalRows(fx, "resource.read.metadata");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "INVALID");
    const safe = String(rows[0].arguments_safe);
    assert.ok(!safe.includes("/Users/"), safe);
    assert.ok(!safe.includes(ABS), safe);
    assert.ok(safe.includes("[REDACTED_PATH]"), safe);
    const dec = fx.toolStore.decisionsOfTask(run.taskId)[0];
    assert.equal(dec.decision, "INVALID");
    assert.equal(dec.reason_code, "TOOL_ARGUMENT_INVALID");
  } finally { await fx.close(); }
});

test("b) capability / credential 形态值落库前替换为 [REDACTED_CAPABILITY] / [REDACTED_SECRET]", async () => {
  const { fx, bridge } = await setup();
  try {
    assert.equal(fx.grantTool("ai", ["tool.resource.search"]).ok, true);
    const { cap } = issue(bridge, fx);
    const token = cap.capability.token;
    const queries = ["tpx_PROBE_" + token, "mpx_" + "M".repeat(20), "api_key=" + SECRET];
    for (const [i, query] of queries.entries()) {
      const r = await call(bridge, token, { toolId: "resource.search", callId: "redact_cap_" + i, arguments: { query } });
      assert.equal(r.json.ok, true, JSON.stringify(r.json));
    }
    const rows = proposalRows(fx, "resource.search");
    assert.equal(rows.length, 3);
    const blob = rows.map((row) => String(row.arguments_safe)).join("|");
    assert.ok(!blob.includes(token), blob);
    assert.ok(!blob.includes("tpx_"), blob);
    assert.ok(!blob.includes("mpx_"), blob);
    assert.ok(!blob.includes(SECRET), blob);
    assert.ok(blob.includes("[REDACTED_CAPABILITY]"), blob);
    assert.ok(blob.includes("[REDACTED_SECRET]"), blob);
    assert.deepEqual(scanDbText(fx.f.identity.connection, ["tpx_", "mpx_", SECRET]), []);
  } finally { await fx.close(); }
});

test("c) 嵌套 object / array 的值同样去敏（test-only contract 真实 propose 落库）", async () => {
  const { fx } = await setup();
  try {
    fx.toolRegistry.register(NESTED_CONTRACT);
    const run = fx.dshRunSetup();
    const context = { sessionRef: fx.f.sessions.admin, appId: "ai", requestId: "req_projection_probe" };
    const base = { context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: NESTED_TOOL_ID, toolVersion: 1 };
    const r1 = fx.toolProxy.propose({ ...base, arguments: {
      filter: { path: ABS, tags: ["/private/var/db/secret.sqlite", "keep-tag", "tpx_PROBE_nested"], extra: { note: "api_key=" + SECRET } },
      notes: ["C:\\Users\\Public\\secret.txt", "resource://res_keep"],
    } });
    assert.equal(r1.decisionStatus, "INVALID");
    assert.equal(r1.reasonCode, "TOOL_ARGUMENT_INVALID");
    const r2 = fx.toolProxy.propose({ ...base, arguments: {
      filter: { path: "relative/ok", tags: ["keep-tag"], api_key: SECRET },
      notes: ["keep-note"],
    } });
    assert.equal(r2.decisionStatus, "INVALID");
    assert.equal(r2.reasonCode, "TOOL_ARGUMENT_FORBIDDEN_FIELD");
    const rows = proposalRows(fx, NESTED_TOOL_ID);
    assert.equal(rows.length, 2);
    const first = String(rows[0].arguments_safe);
    assert.ok(!/\/Users\/|\/private\/|tpx_|sk-live/.test(first), first);
    assert.ok(first.includes("[REDACTED_PATH]") && first.includes("[REDACTED_CAPABILITY]") && first.includes("[REDACTED_SECRET]"), first);
    const nestedArgs = JSON.parse(first);
    assert.deepEqual(Object.keys(nestedArgs), ["filter", "notes"]);
    assert.deepEqual(nestedArgs.filter.tags, ["[REDACTED_PATH]", "keep-tag", "[REDACTED_CAPABILITY]"]);
    assert.equal(nestedArgs.filter.extra.note, "[REDACTED_SECRET]");
    assert.equal(nestedArgs.notes[0], "[REDACTED_PATH]");
    assert.equal(nestedArgs.notes[1], "resource://res_keep");
    const second = JSON.parse(String(rows[1].arguments_safe));
    assert.deepEqual(Object.keys(second), ["filter", "notes"]);
    assert.equal(second.filter.api_key, "[REDACTED]");
    assert.equal(second.filter.path, "relative/ok");
    assert.deepEqual(second.notes, ["keep-note"]);
  } finally { await fx.close(); }
});

test("c2) projectArguments 保持修复前的 lossy 语义；redactProjectedArguments 才做递归值级去敏", () => {
  const deepRaw = { a: { b: { c: { d: { e: { f: { g: { h: ABS } } } } } } } };
  const projected = domain.projectArguments({ v: deepRaw, s: "k".repeat(300) }, { v: { type: "object" }, s: { type: "string" } });
  assert.equal(projected.s.length, 257);
  assert.ok(JSON.stringify(projected).includes("/Users/"), "projection 本身保持既有 lossy 语义（执行用）");
  const safe = domain.redactProjectedArguments(projected);
  assert.ok(!JSON.stringify(safe).includes("/Users/"), JSON.stringify(safe));
  const list = domain.redactProjectedArguments(domain.projectArguments({ v: [ABS, ...Array.from({ length: 63 }, (_, i) => "ok-" + i)] }, { v: { type: "array" } }));
  assert.equal(list.v.length, 32);
  assert.equal(list.v[0], "[REDACTED_PATH]");
  const long = domain.redactProjectedArguments(domain.projectArguments({ v: "x".repeat(300) }, { v: { type: "string" } }));
  assert.equal(long.v.length, 257);
});

test("d) 正对照：普通字符串逐字符不变，字段集合仍只含 schema 声明字段", async () => {
  const { fx, bridge } = await setup();
  try {
    assert.equal(fx.grantTool("ai", ["tool.resource.readMetadata", "tool.resource.search"]).ok, true);
    const { cap } = issue(bridge, fx);
    const token = cap.capability.token;
    const searched = await call(bridge, token, { toolId: "resource.search", callId: "pos_1", arguments: { query: "Vertical Smoke Resource", limit: 5, kind: "text" } });
    assert.equal(searched.json.ok, true, JSON.stringify(searched.json));
    const undeclared = await call(bridge, token, { toolId: "resource.search", callId: "pos_2", arguments: { query: "relative query term", order: "desc" } });
    assert.equal(undeclared.json.ok, false);
    assert.equal(undeclared.json.error, "TOOL_ARGUMENT_INVALID");
    const read = await call(bridge, token, { toolId: "resource.read.metadata", callId: "pos_3", arguments: { resourceRef: "resource://res_keep" } });
    assert.equal(read.json.ok, false);
    const rows = proposalRows(fx, "resource.search");
    assert.equal(rows[0].arguments_safe, JSON.stringify({ query: "Vertical Smoke Resource", limit: 5, kind: "text" }));
    assert.equal(rows[1].arguments_safe, JSON.stringify({ query: "relative query term" }));
    const readRow = proposalRows(fx, "resource.read.metadata")[0];
    assert.equal(readRow.arguments_safe, JSON.stringify({ resourceRef: "resource://res_keep" }));
    assert.deepEqual(Object.keys(JSON.parse(String(readRow.arguments_safe))), ["resourceRef"]);
  } finally { await fx.close(); }
});

test("e) 语义不变：arguments_hash 仍为 raw args fingerprint，正常 READ 仍 ALLOWED + SUCCEEDED", async () => {
  const { fx, bridge } = await setup();
  try {
    const created = await fx.createResource("Projection Positive Resource");
    assert.equal(fx.grantTool("ai", ["tool.resource.readMetadata"]).ok, true);
    const { run, cap } = issue(bridge, fx);
    const raw = { resourceRef: created.resource.resourceRef };
    const r = await call(bridge, cap.capability.token, { toolId: "resource.read.metadata", callId: "sem_1", arguments: raw });
    assert.equal(r.json.ok, true, JSON.stringify(r.json));
    assert.equal(r.json.result.resourceRef, created.resource.resourceRef);
    const row = proposalRows(fx, "resource.read.metadata")[0];
    assert.equal(row.arguments_hash, domain.fingerprint(raw));
    assert.equal(row.arguments_safe, JSON.stringify(raw));
    const dec = fx.toolStore.decisionsOfTask(run.taskId)[0];
    assert.equal(dec.decision, "ALLOWED");
    assert.equal(dec.reason_code, "ALLOW");
    assert.equal(fx.toolStore.executionsOfTask(run.taskId)[0].status, "SUCCEEDED");
  } finally { await fx.close(); }
});

test("f) 全库扫描：绝对路径 / tpx_ / mpx_ / sk-live 在所有表文本列 0 命中", async () => {
  const { fx, bridge } = await setup();
  try {
    assert.equal(fx.grantTool("ai", ["tool.resource.search"]).ok, true);
    const run = fx.dshRunSetup();
    const cap = bridge.issueCapability({ context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, allowedTools: READ_TOOLS, maxCalls: 6 });
    assert.equal(cap.ok, true, JSON.stringify(cap));
    const token = cap.capability.token;
    await call(bridge, token, { toolId: "resource.read.metadata", callId: "scan_abs", arguments: { resourceRef: ABS } });
    await call(bridge, token, { toolId: "resource.search", callId: "scan_cap", arguments: { query: "tpx_PROBE_" + token } });
    await call(bridge, token, { toolId: "resource.search", callId: "scan_secret", arguments: { query: "api_key=" + SECRET } });
    await call(bridge, token, { toolId: "resource.search", callId: "scan_mpx", arguments: { query: "mpx_" + "M".repeat(20) } });
    fx.toolRegistry.register(NESTED_CONTRACT);
    fx.toolProxy.propose({ context: { sessionRef: fx.f.sessions.admin, appId: "ai", requestId: "req_scan_nested" }, taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: NESTED_TOOL_ID, toolVersion: 1, arguments: {
      filter: { path: ABS, tags: ["/private/var/db/secret.sqlite", "tpx_PROBE_nested"] },
      notes: ["C:\\Users\\Public\\secret.txt", "api_key=" + SECRET],
    } });
    const hits = scanDbText(fx.f.identity.connection, ["/Users/", "/private/", "/var/folders", "tpx_", "mpx_", "sk-live", "Bearer "]);
    assert.deepEqual(hits, []);
  } finally { await fx.close(); }
});

test("g) 执行入参保持原始片段（不走去敏投影），同一次调用的落库投影已去敏", async () => {
  const { fx, bridge } = await setup();
  try {
    assert.equal(fx.grantTool("ai", ["tool.resource.search"]).ok, true);
    const provider = fx.adapters.providers.SearchService;
    const observed = [];
    const origExecute = provider.execute;
    provider.execute = async (ctx) => { observed.push(ctx.args); return origExecute(ctx); };
    const { cap } = issue(bridge, fx);
    const rawQuery = "notes about tpx_ABC123 and see x/Users/y";
    const r = await call(bridge, cap.capability.token, { toolId: "resource.search", callId: "exec_raw_1", arguments: { query: rawQuery } });
    assert.equal(r.json.ok, true, JSON.stringify(r.json));
    assert.equal(observed.length, 1);
    assert.equal(observed[0].query, rawQuery, "adapter 必须收到原始片段：" + JSON.stringify(observed[0]));
    const row = proposalRows(fx, "resource.search")[0];
    assert.equal(row.arguments_safe, JSON.stringify({ query: "notes about [REDACTED_CAPABILITY] and see x[REDACTED_PATH]" }));
  } finally { await fx.close(); }
});

test("h) >256 字符参数：执行侧仍是既有 256 截断（修复前逐字节一致），落库额外去敏", async () => {
  const { fx } = await setup();
  try {
    const observed = [];
    const longAdapter = {
      async prepare() { return { plan: { provider: "test.probe" } }; },
      async execute({ args }) { observed.push(args); return { ok: true, result: { echo: String((args && args.message) || "") } }; },
      async verify({ result }) { return { ok: typeof result.echo === "string" }; },
    };
    const origAdapterFor = fx.toolProxy.adapterFor;
    fx.toolProxy.adapterFor = ({ executionProvider, toolId }) => (toolId === LONG_TOOL_ID ? longAdapter : origAdapterFor({ executionProvider, toolId }));
    fx.toolRegistry.register(LONG_CONTRACT);
    const run = fx.dshRunSetup();
    const rawMessage = "tpx_ABC123 " + "m".repeat(300);
    const p = fx.toolProxy.propose({ context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: LONG_TOOL_ID, toolVersion: 1, arguments: { message: rawMessage }, proposalId: "tprop_long_probe_1" });
    assert.equal(p.decisionStatus, "ALLOWED", JSON.stringify(p));
    assert.equal(observed.length, 0);
    const exec = await fx.toolProxy.executeReadOnly({ context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, proposalId: p.proposal.proposalId, expectedRevision: fx.taskStore.taskById(run.taskId).revision });
    assert.equal(exec.ok, true, JSON.stringify(exec));
    assert.equal(observed.length, 1);
    assert.equal(observed[0].message, "tpx_ABC123 " + "m".repeat(245) + "…", "执行侧必须仍是修复前的 256 截断值");
    assert.equal(observed[0].message, domain.projectArguments({ message: rawMessage }, { message: { type: "string" } }).message);
    const row = proposalRows(fx, LONG_TOOL_ID)[0];
    assert.equal(row.arguments_hash, domain.fingerprint({ message: rawMessage }));
    const safe = JSON.parse(String(row.arguments_safe));
    assert.equal(safe.message, ("[REDACTED_CAPABILITY] " + "m".repeat(245) + "…").slice(0, 256) + "…");
  } finally { await fx.close(); }
});

test("g2) 执行入参缓存有界：最多 64 条 FIFO 淘汰，淘汰后回退 DB 仍可用", async () => {
  const { fx } = await setup();
  try {
    assert.equal(fx.grantTool("ai", ["tool.resource.search"]).ok, true);
    const run = fx.dshRunSetup();
    for (let i = 0; i < 70; i += 1) {
      const p = fx.toolProxy.propose({ context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: "resource.search", toolVersion: 1, arguments: { query: "q" + i }, proposalId: "tprop_bound_" + i });
      assert.equal(p.decisionStatus, "ALLOWED", JSON.stringify(p));
    }
    assert.equal(fx.toolProxy.executionArguments.size, 64);
    assert.equal(fx.toolProxy.executionArguments.has("tprop_bound_0"), false);
    assert.equal(fx.toolProxy.executionArguments.has("tprop_bound_69"), true);
    const fallback = await fx.toolProxy.executeReadOnly({ context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, proposalId: "tprop_bound_0", expectedRevision: fx.taskStore.taskById(run.taskId).revision });
    assert.equal(typeof fallback.ok, "boolean");
  } finally { await fx.close(); }
});

test("r1) 非 macOS 绝对路径 / 盘符 / UNC / file:// 绝不明文落库，且拒绝判据不变", async () => {
  const { fx, bridge } = await setup();
  try {
    assert.equal(fx.grantTool("ai", ["tool.resource.readMetadata", "tool.resource.search"]).ok, true);
    const { cap } = issue(bridge, fx, { maxCalls: 40 });
    const token = cap.capability.token;
    const paths = [
      "/tmp/secret-plan.txt", "/etc/passwd", "/Volumes/Backup/secret.txt", "/home/alice/.ssh/id_rsa",
      "/Library/Application Support/OpenArc OS/identity.db", "/opt/data/secret", "/root/.aws/credentials",
      "/Applications/Notes.app/secret", "/usr/local/etc/pass", "/var/log/system.log", "/mnt/data/secret",
      "/media/usb/secret", "/srv/app/secret", "/dev/shm/secret", "/proc/self/environ", "/sys/kernel/secret",
      "C:\\Users\\Public\\secret.txt", "\\\\host\\share\\secret.txt", "file:///Users/me/secret.txt",
    ];
    for (const [i, p] of paths.entries()) {
      const r = await call(bridge, token, { toolId: "resource.read.metadata", callId: "r1_" + i, arguments: { resourceRef: p } });
      assert.equal(r.json.ok, false, p);
      assert.equal(r.json.error, "TOOL_ARGUMENT_INVALID", p);
    }
    // 冻结的拒绝判据：窄形态仍 INVALID；中段路径仍 ALLOWED（只是落库去敏）
    const narrow = await call(bridge, token, { toolId: "resource.search", callId: "r1_narrow", arguments: { query: "/Users/alice" } });
    assert.equal(narrow.json.ok, false);
    assert.equal(narrow.json.error, "TOOL_ARGUMENT_INVALID");
    const mid = await call(bridge, token, { toolId: "resource.search", callId: "r1_mid", arguments: { query: "call /api/v2 now" } });
    assert.equal(mid.json.ok, true, JSON.stringify(mid.json));
    const blob = fx.f.identity.connection.prepare("SELECT arguments_safe FROM task_tool_proposals").all().map((row) => String(row.arguments_safe)).join("\n");
    for (const p of paths) assert.ok(!blob.includes(p), p + " 明文落库：" + blob);
    assert.ok(!/\/(?:etc|tmp|home|root|opt|Volumes|Library|Applications|usr|var|mnt|media|srv|dev|proc|sys)\b|C:\\\\|\\\\host|file:\/\//.test(blob), blob);
    assert.ok(blob.includes("[REDACTED_PATH]"), blob);
    assert.equal(proposalRows(fx, "resource.search")[1].arguments_safe, JSON.stringify({ query: "call [REDACTED_PATH] now" }));
    // bridge 结果侧判据保持窄口径（未扩大）
    assert.equal(redactUnsafe({ s: "/etc/passwd" }).s, "/etc/passwd");
    assert.equal(redactUnsafe({ s: "/Users/a" }).s, "[REDACTED_PATH]");
    assert.deepEqual(scanDbText(fx.f.identity.connection, ["/etc", "/tmp/", "/home/", "/root/", "/opt/", "/Volumes/", "/Library/", "/Applications/", "/usr/", "/var/", "/mnt/", "/media/", "/srv/", "/dev/", "/proc/", "/sys/", "C:\\", "\\\\host", "file://"]), []);
  } finally { await fx.close(); }
});

test("r2) 失败验证证据复用同一份持久化去敏判据（非 macOS 路径 / 深层 JSON 兜底均不再明文）", async () => {
  const fx = await createTaskHarnessFixture({ behavior: "exact" });
  try {
    const ctx = fx.ctx();
    const t = fx.taskService.createTask({ context: ctx, goal: "evidence redaction probe" });
    const taskId = t.task.taskId;
    const cases = [
      "/Users/wepingli/secret/notes.txt", "/tmp/staging/secret.txt", "/Volumes/Backup/secret.txt",
      "/Library/Application Support/OpenArc OS/identity.db", "/etc/passwd", "/home/alice/.ssh/id_rsa",
      "/opt/data/secret", "/root/.aws/credentials", "C:\\Users\\Public\\secret.txt", "\\\\host\\share\\secret.txt", "file:///tmp/x.txt",
    ];
    for (const [i, p] of cases.entries()) {
      const rec = fx.taskService.recordVerificationFailure({ context: ctx, taskId, type: "OUTPUT_SCHEMA", executionId: "exec_r2_" + i, expected: { expectedPath: p }, actual: { name: p } });
      assert.equal(rec.ok, true, JSON.stringify(rec));
    }
    const deep = fx.taskService.recordVerificationFailure({ context: ctx, taskId, type: "OUTPUT_SCHEMA", executionId: "exec_r2_deep", expected: {}, actual: { outer: { inner: { path: "/etc/shadow", ref: "resource://res_keep" } } } });
    assert.equal(deep.ok, true, JSON.stringify(deep));
    const plain = fx.taskService.recordVerificationFailure({ context: ctx, taskId, type: "OUTPUT_SCHEMA", executionId: "exec_r2_plain", expected: { note: "Vertical Smoke Resource", ref: "resource://res_keep" }, actual: { ok: false } });
    assert.equal(plain.ok, true, JSON.stringify(plain));
    const listed = fx.taskService.getVerifications({ context: ctx, taskId });
    assert.equal(listed.items.length, cases.length + 2);
    for (const [i, item] of listed.items.slice(0, cases.length).entries()) {
      assert.equal(item.expected.expectedPath, "[REDACTED_PATH]", cases[i]);
      assert.equal(item.actual.name, "[REDACTED_PATH]", cases[i]);
      assert.ok(!JSON.stringify(item).includes(cases[i]), cases[i]);
    }
    const deepItem = JSON.stringify(listed.items[cases.length]);
    assert.ok(!deepItem.includes("/etc/shadow"), deepItem);
    assert.ok(deepItem.includes("[REDACTED_PATH]"), deepItem);
    assert.ok(deepItem.includes("resource://res_keep"), deepItem);
    const plainItem = listed.items[cases.length + 1];
    assert.equal(plainItem.expected.note, "Vertical Smoke Resource");
    assert.equal(plainItem.expected.ref, "resource://res_keep");
    assert.deepEqual(scanDbText(fx.f.identity.connection, ["/etc", "/tmp/", "/home/", "/root/", "/opt/", "/Volumes/", "/Library/", "C:\\", "\\\\host", "file://"]), []);
  } finally { await fx.close(); }
});

test("r3) 截断边界不留裸路径前缀 / 半段目录 / 半截占位符", async () => {
  const { fx } = await setup();
  try {
    fx.toolRegistry.register(LONG_CONTRACT);
    const run = fx.dshRunSetup();
    const cases = [
      "p".repeat(250) + "/Users/alice",
      "p".repeat(252) + "/data/config",
      "p".repeat(250) + "/etc/passwd",
      "p".repeat(250) + "/home/alice",
      "p".repeat(250) + "/data/secret",
      "p".repeat(250) + " C:\\data",
      "p".repeat(250) + " /Users/alice/secret.txt",
    ];
    for (const [i, message] of cases.entries()) {
      const p = fx.toolProxy.propose({ context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: LONG_TOOL_ID, toolVersion: 1, arguments: { message }, proposalId: "tprop_r3_" + i });
      assert.equal(p.decisionStatus, "ALLOWED", JSON.stringify(p));
    }
    const rows = fx.f.identity.connection.prepare("SELECT arguments_safe FROM task_tool_proposals WHERE tool_id = ? ORDER BY rowid").all(LONG_TOOL_ID);
    assert.equal(rows.length, cases.length);
    for (const row of rows) {
      const safe = JSON.parse(String(row.arguments_safe)).message;
      const body = safe.endsWith("…") ? safe.slice(0, -1) : safe;
      assert.ok(!/\/[\w.@+-]+$/.test(body), "裸前缀残留：" + JSON.stringify(safe));
      assert.ok(!/\[REDACTED_[A-Z_]*$/.test(body), "半截占位符：" + JSON.stringify(safe));
      assert.ok(!/\/Users|\/data|\/etc|\/home|C:\\/.test(safe), JSON.stringify(safe));
    }
  } finally { await fx.close(); }
});

test("r5) 冷缓存 + 含去敏标记的持久化投影 → fail closed；未去敏 legacy 投影仍执行", async () => {
  const { fx } = await setup();
  try {
    const created = await fx.createResource("R5 Projection Target");
    assert.equal(fx.grantTool("ai", ["tool.resource.readMetadata"]).ok, true);
    const run = fx.dshRunSetup();
    const seed = (proposalId, resourceRef) => {
      const row = fx.toolStore.insertProposal({ proposalId, taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: "resource.read.metadata", toolVersion: 1, argumentsSafe: { resourceRef }, argumentsHash: domain.fingerprint({ resourceRef }), status: "VALIDATED", createdAt: Date.now() });
      fx.toolStore.insertDecision({ proposalId: row.proposal_id, decision: "ALLOWED", reasonCode: "ALLOW", riskClass: "READ_ONLY", approvalRequired: false, createdAt: Date.now() });
      return row.proposal_id;
    };
    const markedId = seed("tprop_r5_marked", "[REDACTED_PATH]");
    const legacyId = seed("tprop_r5_legacy", created.resource.resourceRef);
    assert.equal(fx.toolProxy.executionArguments.size, 0, "必须是冷缓存");
    let domainCalls = 0;
    const origGet = fx.f.resourceService.get.bind(fx.f.resourceService);
    fx.f.resourceService.get = (...a) => { domainCalls += 1; return origGet(...a); };
    const blocked = await fx.toolProxy.executeReadOnly({ context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, proposalId: markedId, expectedRevision: fx.taskStore.taskById(run.taskId).revision });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error, "TOOL_ARGUMENTS_PROJECTION_UNAVAILABLE");
    assert.equal(blocked.executionStatus, "NOT_EXECUTED");
    assert.equal(blocked.execution, null);
    assert.equal(blocked.result, null);
    assert.equal(domainCalls, 0, "fail closed 不得调用 Domain");
    assert.equal(fx.toolStore.executionsOfTask(run.taskId).length, 0, "fail closed 不得产生 execution record");
    const ok = await fx.toolProxy.executeReadOnly({ context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, proposalId: legacyId, expectedRevision: fx.taskStore.taskById(run.taskId).revision });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(domainCalls, 1);
    assert.equal(fx.toolStore.executionsOfTask(run.taskId).length, 1);
  } finally { await fx.close(); }
});

test("r5b) 标记被 256 截断切断时：落库必含完整标记，冷缓存执行仍 fail closed", async () => {
  const { fx } = await setup();
  try {
    const observed = [];
    const longAdapter = {
      async prepare() { return { plan: { provider: "test.probe" } }; },
      async execute({ args }) { observed.push(args); return { ok: true, result: { echo: String((args && args.message) || "") } }; },
      async verify({ result }) { return { ok: typeof result.echo === "string" }; },
    };
    fx.toolRegistry.register(LONG_CONTRACT);
    const run = fx.dshRunSetup();
    const rawMessage = "a".repeat(250) + "/tmp/secret-file.txt";
    const p = fx.toolProxy.propose({ context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: LONG_TOOL_ID, toolVersion: 1, arguments: { message: rawMessage }, proposalId: "tprop_r5b_truncated_marker" });
    assert.equal(p.decisionStatus, "ALLOWED", JSON.stringify(p));
    const row = fx.f.identity.connection.prepare("SELECT arguments_safe FROM task_tool_proposals WHERE proposal_id = ?").get("tprop_r5b_truncated_marker");
    const safeText = String(row.arguments_safe);
    assert.equal(domain.REDACTION_MARKER_RE.test(safeText), true, "落库投影必须含完整去敏标记：" + safeText);
    assert.ok(!safeText.includes("/tmp"), safeText);
    assert.ok(!safeText.includes("secret-file"), safeText);
    assert.equal(JSON.parse(safeText).message.length, 257);

    // 冷缓存：第二个 proxy 实例（与审查者 R-5' 构造一致）
    const proxy2 = new ControlledToolProxy({ registry: fx.toolRegistry, toolStore: fx.toolStore, authService: fx.f.authService, taskStore: fx.taskStore, taskService: fx.taskService, adapters: fx.adapters, clock: fx.f.clock });
    assert.equal(proxy2.executionArguments.size, 0, "必须是冷缓存");
    const origFor = proxy2.adapterFor;
    proxy2.adapterFor = ({ executionProvider, toolId }) => (toolId === LONG_TOOL_ID ? longAdapter : origFor({ executionProvider, toolId }));
    const blocked = await proxy2.executeReadOnly({ context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, proposalId: "tprop_r5b_truncated_marker", expectedRevision: fx.taskStore.taskById(run.taskId).revision });
    assert.equal(blocked.ok, false, JSON.stringify(blocked));
    assert.equal(blocked.error, "TOOL_ARGUMENTS_PROJECTION_UNAVAILABLE");
    assert.equal(blocked.execution, null);
    assert.equal(observed.length, 0, "fail closed 不得调用 adapter");
    assert.equal(fx.toolStore.executionsOfTask(run.taskId).length, 0, "fail closed 不得产生 execution record");

    // 正对照：未被去敏的 legacy 投影（冷缓存）仍可执行
    const created = await fx.createResource("R5b Legacy Target");
    assert.equal(fx.grantTool("ai", ["tool.resource.readMetadata"]).ok, true);
    const legacy = fx.toolStore.insertProposal({ proposalId: "tprop_r5b_legacy", taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: "resource.read.metadata", toolVersion: 1, argumentsSafe: { resourceRef: created.resource.resourceRef }, argumentsHash: domain.fingerprint({ resourceRef: created.resource.resourceRef }), status: "VALIDATED", createdAt: Date.now() });
    fx.toolStore.insertDecision({ proposalId: legacy.proposal_id, decision: "ALLOWED", reasonCode: "ALLOW", riskClass: "READ_ONLY", approvalRequired: false, createdAt: Date.now() });
    const okLegacy = await proxy2.executeReadOnly({ context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, proposalId: "tprop_r5b_legacy", expectedRevision: fx.taskStore.taskById(run.taskId).revision });
    assert.equal(okLegacy.ok, true, JSON.stringify(okLegacy));
    assert.equal(fx.toolStore.executionsOfTask(run.taskId).length, 1);
  } finally { await fx.close(); }
});

/** f1bff21 冻结的拒绝判据字面量（D4-03B）：本文件逐字符断言其未变。 */
const FROZEN_UNSAFE_STRING_SOURCE = "(^|\\s)(\\/Users\\/|\\/private\\/|\\/var\\/folders|C:\\\\|\\\\\\\\[^\\\\]+\\\\)";
const FROZEN_ABSOLUTE_PATH_SOURCE = "(^\\/)|(^[A-Za-z]:[\\\\/])|(^\\\\\\\\[^\\\\]+[\\\\/])";
const FROZEN_ABSOLUTE_PATH_RE = new RegExp(FROZEN_ABSOLUTE_PATH_SOURCE);

test("r1b) 裸单段绝对路径绝不落库；search 形态仍 ALLOWED + 执行成功，adapter 收到原文", async () => {
  const { fx, bridge } = await setup();
  try {
    assert.equal(fx.grantTool("ai", ["tool.resource.readMetadata", "tool.resource.search"]).ok, true);
    const provider = fx.adapters.providers.SearchService;
    const observed = [];
    const origExecute = provider.execute;
    provider.execute = async (ctx) => { observed.push(ctx.args); return origExecute(ctx); };
    const { run, cap } = issue(bridge, fx, { maxCalls: 12 });
    const token = cap.capability.token;
    const bare = ["/x", "/data", "/secret-plan.txt", "/Users-bob"];
    for (const [i, p] of bare.entries()) {
      const r = await call(bridge, token, { toolId: "resource.read.metadata", callId: "r1b_ref_" + i, arguments: { resourceRef: p } });
      assert.equal(r.json.ok, false, p + " 必须仍被拒（本次只改落库文本）");
      assert.equal(r.json.error, "TOOL_ARGUMENT_INVALID", p);
    }
    const embedded = "notes about /secret-plan.txt";
    const searched = await call(bridge, token, { toolId: "resource.search", callId: "r1b_search", arguments: { query: embedded, limit: 3 } });
    assert.equal(searched.json.ok, true, JSON.stringify(searched.json));
    const decisions = fx.toolStore.decisionsOfTask(run.taskId);
    assert.equal(decisions.length, bare.length + 1);
    assert.deepEqual([decisions[bare.length].decision, decisions[bare.length].reason_code], ["ALLOWED", "ALLOW"]);
    assert.deepEqual(fx.toolStore.executionsOfTask(run.taskId).map((e) => e.status), ["SUCCEEDED"]);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].query, embedded, "adapter 必须收到原文（落库去敏绝不回写执行入参）");
    const rows = proposalRows(fx, "resource.search");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].arguments_hash, domain.fingerprint({ query: embedded, limit: 3 }), "hash 仍取 raw args");
    assert.equal(rows[0].arguments_safe, JSON.stringify({ query: "notes about [REDACTED_PATH]", limit: 3 }));
    assert.equal(proposalRows(fx, "resource.read.metadata")[0].arguments_safe, JSON.stringify({ resourceRef: "[REDACTED_PATH]" }));
    const blob = fx.f.identity.connection.prepare("SELECT arguments_safe FROM task_tool_proposals").all().map((r) => String(r.arguments_safe)).join("\n");
    for (const p of bare) assert.ok(!blob.includes(p), p + " 明文落库：" + blob);
    assert.ok(!blob.includes(embedded), blob);
    assert.ok(blob.includes("[REDACTED_PATH]"), blob);
  } finally { await fx.close(); }
});

test("r1c) 正对照逐字符不变：URL/相对词/日期/普通文本既不改写也不误报", async () => {
  const { fx, bridge } = await setup();
  try {
    const positive = ["resource://res_keep", "s3://bucket/key", "a/b", "3/4 done", "2024/12/25", "Vertical Smoke Resource"];
    for (const s of positive) {
      const out = domain.redactProjectedArguments(domain.projectArguments({ query: s }, { query: { type: "string" } })).query;
      assert.equal(out, s, "值级去敏改写了正对照：" + s);
    }
    assert.equal(fx.grantTool("ai", ["tool.resource.readMetadata", "tool.resource.search"]).ok, true);
    const { cap } = issue(bridge, fx, { maxCalls: 12 });
    const token = cap.capability.token;
    const searched = ["s3://bucket/key", "a/b", "3/4 done", "2024/12/25", "Vertical Smoke Resource"];
    for (const [i, q] of searched.entries()) {
      const r = await call(bridge, token, { toolId: "resource.search", callId: "r1c_pos_" + i, arguments: { query: q } });
      assert.equal(r.json.ok, true, q + " " + JSON.stringify(r.json));
    }
    const rows = proposalRows(fx, "resource.search");
    for (const [i, q] of searched.entries()) assert.equal(rows[i].arguments_safe, JSON.stringify({ query: q }), q);
    const read = await call(bridge, token, { toolId: "resource.read.metadata", callId: "r1c_ref", arguments: { resourceRef: "resource://res_keep" } });
    assert.equal(read.json.ok, false, JSON.stringify(read.json));
    assert.equal(proposalRows(fx, "resource.read.metadata")[0].arguments_safe, JSON.stringify({ resourceRef: "resource://res_keep" }));
  } finally { await fx.close(); }
});

test("r1d) 拒绝语义逐字符不变：冻结判据 source 未动，决策与 f1bff21 一致", async () => {
  assert.equal(domain.UNSAFE_STRING_RE.source, FROZEN_UNSAFE_STRING_SOURCE, "拒绝判据 UNSAFE_STRING_RE 被改动");
  assert.equal(domain.ABSOLUTE_PATH_RE.source, FROZEN_ABSOLUTE_PATH_SOURCE, "拒绝判据 ABSOLUTE_PATH_RE 被改动");
  const battery = ["/Users/a/b", "/etc/passwd", "/api/v2", "see /Users/x", "/secret-plan.txt", "/x", "resource://res_keep", "a/b", "2024/12/25", ""];
  for (const v of battery) assert.equal(domain.containsAbsolutePath(v), FROZEN_ABSOLUTE_PATH_RE.test(v), "containsAbsolutePath 语义漂移：" + v);

  const { fx, bridge } = await setup();
  try {
    assert.equal(fx.grantTool("ai", ["tool.resource.search"]).ok, true);
    const { run, cap } = issue(bridge, fx, { maxCalls: 8 });
    const token = cap.capability.token;
    const cases = [["/Users/a/b", false], ["/etc/passwd", false], ["/api/v2", false], ["see /Users/x", true]];
    for (const [i, [q, allowed]] of cases.entries()) {
      const r = await call(bridge, token, { toolId: "resource.search", callId: "r1d_" + i, arguments: { query: q } });
      assert.equal(r.json.ok, allowed, q + " " + JSON.stringify(r.json));
      if (!allowed) assert.equal(r.json.error, "TOOL_ARGUMENT_INVALID", q);
    }
    assert.deepEqual(fx.toolStore.decisionsOfTask(run.taskId).map((d) => [d.decision, d.reason_code]), [
      ["INVALID", "TOOL_ARGUMENT_INVALID"], ["INVALID", "TOOL_ARGUMENT_INVALID"], ["INVALID", "TOOL_ARGUMENT_INVALID"], ["ALLOWED", "ALLOW"],
    ]);
    assert.deepEqual(fx.toolStore.executionsOfTask(run.taskId).map((e) => e.status), ["SUCCEEDED"]);
    const rows = proposalRows(fx, "resource.search");
    assert.equal(rows[3].arguments_safe, JSON.stringify({ query: "see [REDACTED_PATH]" }));
  } finally { await fx.close(); }
});

test("r1e) 投影长度上界 271 且绝不 clamp 回 256（完整去敏标记必须保住）", () => {
  const worst = domain.redactProjectedArguments(domain.projectArguments({ message: "p".repeat(255) + "/z" }, { message: { type: "string" } })).message;
  assert.equal(worst, "p".repeat(255) + "[REDACTED_PATH]…", worst.slice(-24));
  assert.equal(worst.length, 271);
  assert.equal(domain.REDACTION_MARKER_RE.test(worst), true);
  let max = 0;
  for (let n = 240; n <= 256; n += 1) for (const tail of ["/", "/x", "/" + "z".repeat(40), "/Users/alice", "/data/config"]) {
    const safe = domain.redactProjectedArguments(domain.projectArguments({ message: "p".repeat(n) + tail }, { message: { type: "string" } })).message;
    max = Math.max(max, safe.length);
    assert.ok(safe.length <= 271, JSON.stringify(safe));
  }
  assert.equal(max, 271, "上界必须是 271（256 + 去敏标记余量），clamp 会切半完整标记");
});

test("r1f) 全库扫描：裸单段/多段绝对路径、tpx_/mpx_/credential 在所有表文本列 0 命中", async () => {
  const { fx, bridge } = await setup();
  try {
    assert.equal(fx.grantTool("ai", ["tool.resource.readMetadata", "tool.resource.search"]).ok, true);
    const { cap } = issue(bridge, fx, { maxCalls: 20 });
    const token = cap.capability.token;
    const bare = ["/x", "/data", "/secret-plan.txt", "/Users-bob"];
    for (const [i, p] of bare.entries()) await call(bridge, token, { toolId: "resource.read.metadata", callId: "r1f_ref_" + i, arguments: { resourceRef: p } });
    for (const [i, q] of ["notes about /secret-plan.txt", "keep /Users-bob safe", "see /data now"].entries()) {
      await call(bridge, token, { toolId: "resource.search", callId: "r1f_q_" + i, arguments: { query: q } });
    }
    for (const [i, q] of ["//x", "//data", "///a/b", "see //notes/todo"].entries()) {
      await call(bridge, token, { toolId: "resource.search", callId: "r1f_dslash_" + i, arguments: { query: q } });
    }
    await call(bridge, token, { toolId: "resource.search", callId: "r1f_cap", arguments: { query: "tpx_PROBE_" + token } });
    await call(bridge, token, { toolId: "resource.search", callId: "r1f_mpx", arguments: { query: "mpx_" + "M".repeat(20) } });
    await call(bridge, token, { toolId: "resource.search", callId: "r1f_secret", arguments: { query: "api_key=" + SECRET } });
    // 边界锚定：绝不能用裸 /x 之类的子串扫描（resource://res_x 是合法文本）
    const BARE_ABS_PATH_RE = /(?:^|[\s"'({=:,;\[\]<>])\/[\w.@+-]+(?![\w.@+-])/;
    const DOUBLE_SLASH_ABS_PATH_RE = /(?<![\w:/])\/\/[\w.@+-]+/;
    assert.deepEqual(scanDbText(fx.f.identity.connection, [...bare, "//notes/todo", "///a/b", "/Users/", "/private/", "/var/folders", "tpx_", "mpx_", SECRET, "Bearer "]), []);
    assert.deepEqual(scanDbTextRe(fx.f.identity.connection, BARE_ABS_PATH_RE), []);
    assert.deepEqual(scanDbTextRe(fx.f.identity.connection, DOUBLE_SLASH_ABS_PATH_RE), []);
  } finally { await fx.close(); }
});

test("r1g) 双斜杠绝对路径（//x、///a/b、see //notes/todo）落库去敏；URL/相对词正对照零漂移", async () => {
  const redactQuery = (s) => domain.redactProjectedArguments(domain.projectArguments({ query: s }, { query: { type: "string" } })).query;
  for (const [raw, expected] of [["//x", "[REDACTED_PATH]"], ["//data", "[REDACTED_PATH]"], ["///a/b", "[REDACTED_PATH]"], ["see //notes/todo", "see [REDACTED_PATH]"], [String.raw`\\server\share`, "[REDACTED_PATH]"]]) {
    assert.equal(redactQuery(raw), expected, raw);
  }
  for (const s of ["resource://res_keep", "http://x.io/a", "s3://bucket/key", "a//b", "notes/todo", "a/b", "3/4 done", "2024/12/25", "Vertical Smoke Resource"]) {
    assert.equal(redactQuery(s), s, "双斜杠分支改写了正对照：" + s);
  }
  assert.equal(redactQuery("tpx_ABC123"), "[REDACTED_CAPABILITY]", "capability 不得被路径分支抢走");
  assert.equal(redactQuery("mpx_" + "M".repeat(20)), "[REDACTED_CAPABILITY]");
  // https://…/var/data 的改写来自 f1bff21 既有的系统根分支，双斜杠分支不得让它再变
  assert.equal(redactQuery("https://x.io/var/data"), "https://x.io[REDACTED_PATH]");
  // 拒绝判据（冻结）：双斜杠形态的判定与 f1bff21 逐例一致
  for (const v of ["//x", "///a/b", "see //notes/todo", "resource://res_keep", "a//b"]) {
    assert.equal(domain.containsAbsolutePath(v), FROZEN_ABSOLUTE_PATH_RE.test(v), "containsAbsolutePath 漂移：" + v);
  }

  const { fx, bridge } = await setup();
  try {
    assert.equal(fx.grantTool("ai", ["tool.resource.search"]).ok, true);
    const provider = fx.adapters.providers.SearchService;
    const observed = [];
    const origExecute = provider.execute;
    provider.execute = async (ctx) => { observed.push(ctx.args); return origExecute(ctx); };
    const { run, cap } = issue(bridge, fx, { maxCalls: 8 });
    const token = cap.capability.token;
    const rejected = await call(bridge, token, { toolId: "resource.search", callId: "r1g_abs", arguments: { query: "//x" } });
    assert.equal(rejected.json.ok, false);
    assert.equal(rejected.json.error, "TOOL_ARGUMENT_INVALID");
    const embedded = "see //notes/todo";
    const searched = await call(bridge, token, { toolId: "resource.search", callId: "r1g_embed", arguments: { query: embedded } });
    assert.equal(searched.json.ok, true, JSON.stringify(searched.json));
    assert.equal(observed.length, 1);
    assert.equal(observed[0].query, embedded, "adapter 必须收到原文");
    assert.deepEqual(fx.toolStore.decisionsOfTask(run.taskId).map((d) => [d.decision, d.reason_code]), [["INVALID", "TOOL_ARGUMENT_INVALID"], ["ALLOWED", "ALLOW"]]);
    assert.deepEqual(fx.toolStore.executionsOfTask(run.taskId).map((e) => e.status), ["SUCCEEDED"]);
    const rows = proposalRows(fx, "resource.search");
    assert.equal(rows[0].arguments_safe, JSON.stringify({ query: "[REDACTED_PATH]" }));
    assert.equal(rows[1].arguments_safe, JSON.stringify({ query: "see [REDACTED_PATH]" }));
  } finally { await fx.close(); }
});
