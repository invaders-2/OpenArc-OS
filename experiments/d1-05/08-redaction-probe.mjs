// D1-05 §23 / §24 / §25：日志脱敏、错误边界、副作用不确定性契约。
//
// 三条要拿到实证的结论：
//   §23  日志只允许固定字段；密钥、Authorization、文件内容、prompt 全文、不必要的私有路径
//        必须默认不落。而且"多塞一个字段"这件事本身也要被拒绝，不能靠自觉。
//   §24  错误返回给上层的只有：用户可读信息 + 机器码 + 是否可重试 + 副作用是否不确定。
//        stack / env / Authorization / 私有绝对路径一律不得出去。
//   §25  工具已执行但结果上报丢失时，状态不得 FAILED → RETRY，
//        必须有 UNKNOWN_EFFECT（或等价概念），先核对再决定。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Probe, VERDICT, TMP, fakeSecret, sha256 } from "./lib/probe.mjs";

const p = new Probe("08-redaction", "日志脱敏 / 错误边界 / 副作用不确定性");

const SECRET = fakeSecret("OPENARC_D1_05_LOGKEY").value;
const MCP_TOKEN = "mcp-fake-d105-" + "d".repeat(20);
const ADOBE_CRED = "adobe-fake-d105-" + "e".repeat(20);
for (const [v, l] of [
  [SECRET, "log-secret"],
  [MCP_TOKEN, "mcp-token"],
  [ADOBE_CRED, "adobe-cred"],
  [Buffer.from(SECRET).toString("base64"), "secret-base64"],
])
  p.registerSecret(v, l);

// ─────────────────────────────────────────────────────────
// A. §23 日志脱敏
// ─────────────────────────────────────────────────────────
console.log("=== A. 日志脱敏 ===");

const ALLOWED_LOG_FIELDS = new Set([
  "taskId",
  "callId",
  "toolId",
  "status",
  "durationMs",
  "errorCategory",
  "attempt",
  "deviceRef",
  "workspaceRef",
]);

// keep: 0 = 整段替换；1 = 保留捕获组 1（例如 "Authorization: Bearer " 前缀本身不敏感）
// 注意：无捕获组的正则用 replace 回调时，第二个参数是**匹配偏移量**而不是分组，
// 所以这里显式用 keep 标记，不靠回调参数位置判断。
const SECRET_PATTERNS = [
  { name: "openai-风格密钥", re: /sk-[A-Za-z0-9_\-]{12,}/g, keep: 0 },
  { name: "Bearer 头", re: /(Bearer\s+)[A-Za-z0-9._\-]{12,}/gi, keep: 1 },
  { name: "MCP token", re: /mcp-[A-Za-z0-9_\-]{8,}/gi, keep: 0 },
  { name: "Adobe 凭据", re: /adobe-[A-Za-z0-9_\-]{8,}/gi, keep: 0 },
  { name: "长 base64url 串", re: /[A-Za-z0-9_\-]{40,}/g, keep: 0 },
  { name: "api_key 查询参数", re: /([?&](?:api_key|token|access_token|key)=)[^&\s"']+/gi, keep: 1 },
];

/** 日志记录器原型：字段白名单 + 值脱敏 + 私有路径脱敏。 */
function makeLogger(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  const rejectedFields = [];
  const redactions = [];
  return {
    rejectedFields,
    redactions,
    log(record) {
      const unknown = Object.keys(record).filter((k) => !ALLOWED_LOG_FIELDS.has(k));
      if (unknown.length) {
        rejectedFields.push(...unknown);
        throw new Error(`LOG_FIELD_NOT_ALLOWED:${unknown.join(",")}`);
      }
      let line = JSON.stringify(record);
      for (const { name, re, keep } of SECRET_PATTERNS) {
        line = line.replace(re, (m, p1) => {
          redactions.push({ pattern: name });
          return keep === 1 ? `${p1}«REDACTED»` : "«REDACTED»";
        });
      }
      // 私有绝对路径默认脱敏（只保留 ~）
      if (line.includes(os.homedir())) {
        redactions.push({ pattern: "home-path" });
        line = line.split(os.homedir()).join("~");
      }
      fs.appendFileSync(file, line + "\n");
      return line;
    },
  };
}

const LOGFILE = path.join(TMP, "logs", "task.log");
const logger = makeLogger(LOGFILE);

// A1 合法记录
const legitLine = logger.log({
  taskId: "task-0001",
  callId: "call-0001",
  toolId: "file.read",
  status: "COMPLETED",
  durationMs: 42,
  errorCategory: null,
  attempt: 1,
  deviceRef: "device-a",
  workspaceRef: "ws-demo",
});
p.case(
  "合法日志记录通过：只含 taskId / callId / toolId / status / durationMs / errorCategory 等固定字段",
  legitLine.includes("task-0001") && legitLine.includes("file.read") ? VERDICT.PASS : VERDICT.FAIL,
  { line: legitLine }
);

// A2 额外字段必须被拒绝，而不是"静默记下来"
let extraFieldRejected = false;
try {
  logger.log({ taskId: "task-0002", prompt: "用户完整提示词内容" });
} catch (e) {
  extraFieldRejected = /LOG_FIELD_NOT_ALLOWED/.test(e.message);
}
p.case(
  "多塞一个未授权字段（如 prompt 全文）→ 直接拒绝写入，而不是静默落盘",
  extraFieldRejected ? VERDICT.PASS : VERDICT.FAIL,
  {
    rejectedFields: logger.rejectedFields,
    note: "白名单比黑名单可靠：新增字段必须显式登记，避免「顺手多打一个字段」造成泄漏。",
  }
);

// A3 各种形态的密钥都要被脱敏
const sneaky = [
  { label: "字段值直接是密钥", record: { taskId: "t1", callId: SECRET, toolId: "x", status: "FAILED", errorCategory: "AUTH" } },
  { label: "拼在 Authorization 里", record: { taskId: "t2", callId: "c", toolId: "x", status: "FAILED", errorCategory: `Authorization: Bearer ${SECRET}` } },
  { label: "作为 URL 查询参数", record: { taskId: "t3", callId: "c", toolId: `https://api.example.com/v1?api_key=${SECRET}`, status: "OK" } },
  { label: "MCP token", record: { taskId: "t4", callId: MCP_TOKEN, toolId: "mcp.call", status: "FAILED" } },
  { label: "Adobe 凭据", record: { taskId: "t5", callId: ADOBE_CRED, toolId: "adobe.ps", status: "FAILED" } },
  { label: "base64 编码后的密钥", record: { taskId: "t6", callId: Buffer.from(SECRET).toString("base64"), toolId: "x", status: "OK" } },
  { label: "私有绝对路径", record: { taskId: "t7", callId: path.join(os.homedir(), "Documents", "客户合同.docx"), toolId: "file.read", status: "OK" } },
];

const leaky = [];
for (const s of sneaky) {
  const line = logger.log(s.record).trim();
  const leaked = [SECRET, MCP_TOKEN, ADOBE_CRED, Buffer.from(SECRET).toString("base64")].some((v) => line.includes(v));
  const pathLeaked = line.includes(os.homedir());
  console.log(`  ${leaked || pathLeaked ? "[!!]" : "[ok]"} ${s.label} → ${line.slice(0, 96)}`);
  if (leaked || pathLeaked) leaky.push({ label: s.label, line });
}
p.case(
  "七种隐蔽形态（含 base64 编码与私有绝对路径）全部被脱敏后才落盘",
  leaky.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  {
    cases: sneaky.map((s) => s.label),
    leaked: leaky,
    redactionCounts: logger.redactions.reduce((acc, r) => ((acc[r.pattern] = (acc[r.pattern] || 0) + 1), acc), {}),
    note: "base64 形态也能命中，是因为长随机串本身就会被规则覆盖——单靠「匹配 sk- 前缀」是不够的。",
  }
);

const logText = fs.readFileSync(LOGFILE, "utf8");
const logSecretHits = [SECRET, MCP_TOKEN, ADOBE_CRED, Buffer.from(SECRET).toString("base64")].filter((v) => logText.includes(v));
p.case(
  "落盘后的日志文件里搜不到任何一个登记的密钥明文",
  logSecretHits.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  {
    logFile: path.relative(TMP, LOGFILE),
    logBytes: logText.length,
    plaintextHits: logSecretHits.length,
    secretFingerprints: [sha256(SECRET, 10), sha256(MCP_TOKEN, 10)],
  }
);

// ─────────────────────────────────────────────────────────
// B. §24 错误边界
// ─────────────────────────────────────────────────────────
console.log("\n=== B. 错误边界 ===");

const ERROR_CATEGORIES = ["AUTH", "PERMISSION", "NOT_FOUND", "TIMEOUT", "RESOURCE", "UPSTREAM", "INTERNAL", "CANCELLED"];

/** 把内部异常折叠成可以交给上层的安全错误。 */
function toSafeError(err, { errorCategory = "INTERNAL", retryable = false, uncertainSideEffect = false } = {}) {
  const code = ERROR_CATEGORIES.includes(errorCategory) ? errorCategory : "INTERNAL";
  const safeMessage = {
    AUTH: "凭据无效或已过期",
    PERMISSION: "当前授权范围不允许此操作",
    NOT_FOUND: "目标不存在",
    TIMEOUT: "执行超时，已中止",
    RESOURCE: "资源超过限制，已中止",
    UPSTREAM: "上游服务不可用",
    INTERNAL: "执行失败",
    CANCELLED: "已取消",
  }[code];
  return {
    ok: false,
    code,
    message: safeMessage,
    retryable: Boolean(retryable),
    uncertainSideEffect: Boolean(uncertainSideEffect),
  };
}

// 构造一个"内部很脏"的异常：stack 带密钥、attached env 带密钥、message 带私有路径与 Authorization
const dirtyErr = new Error(`读取失败：${path.join(os.homedir(), "Documents", "客户名单.xlsx")} 无法访问`);
dirtyErr.stack = `${dirtyErr.stack}\n    at /Users/private/project/src/worker.ts:42\n    Authorization: Bearer ${SECRET}`;
dirtyErr.env = { ...process.env, OPENARC_FAKE: SECRET };
dirtyErr.request = { headers: { authorization: `Bearer ${SECRET}` } };

const safe = toSafeError(dirtyErr, { errorCategory: "PERMISSION", retryable: false, uncertainSideEffect: true });
const serialized = JSON.stringify(safe);
const forbiddenLeaks = [
  { name: "stack", found: serialized.includes("worker.ts") },
  { name: "环境变量转储", found: serialized.includes("OPENARC_FAKE") },
  { name: "Authorization 头", found: /authorization/i.test(serialized) && serialized.includes(SECRET) },
  { name: "密钥明文", found: serialized.includes(SECRET) },
  { name: "私有绝对路径", found: serialized.includes(os.homedir()) || serialized.includes("客户名单") },
];
p.case(
  "错误返回只含用户可读信息 + 机器码 + 可重试 + 副作用不确定性；stack / env / Authorization / 私有路径全部不外泄",
  forbiddenLeaks.every((f) => !f.found) ? VERDICT.PASS : VERDICT.FAIL,
  {
    safeError: safe,
    forbiddenFieldChecks: forbiddenLeaks,
    note: "机器码取自固定枚举，避免把内部异常类名/文件路径带出去。",
  }
);

const shapeOk =
  typeof safe.code === "string" &&
  ERROR_CATEGORIES.includes(safe.code) &&
  typeof safe.retryable === "boolean" &&
  typeof safe.uncertainSideEffect === "boolean" &&
  typeof safe.message === "string";
p.case(
  "错误形状固定：code 命中枚举、retryable 与 uncertainSideEffect 都是布尔、message 是固定文案",
  shapeOk ? VERDICT.PASS : VERDICT.FAIL,
  { allowedCodes: ERROR_CATEGORIES, observed: { code: safe.code, retryable: safe.retryable, uncertainSideEffect: safe.uncertainSideEffect } }
);

// ─────────────────────────────────────────────────────────
// C. §25 副作用不确定性契约
// ─────────────────────────────────────────────────────────
console.log("\n=== C. 副作用不确定性契约 ===");

const STATES = {
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  UNKNOWN_EFFECT: "UNKNOWN_EFFECT",
  CANCELLED: "CANCELLED",
};

const SIDE_EFFECT_TOOLS = new Set(["model.call", "adobe.ps.export", "file.write", "mcp.call"]);

/**
 * 状态机原型：决定一次调用能否重试。
 * 硬规则：
 *   ① 结果上报丢失（执行端已开始产生副作用）→ UNKNOWN_EFFECT，不是 FAILED；
 *   ② UNKNOWN_EFFECT 只能先 VERIFY，不能直接 RETRY；
 *   ③ affected 工具在 FAILED 且 uncertainSideEffect=true 时必须先 VERIFY；
 *   ④ 无副作用的纯读调用才允许直接 RETRY。
 */
function canRetry(call) {
  const sideEffecting = SIDE_EFFECT_TOOLS.has(call.toolId);
  switch (call.state) {
    case STATES.UNKNOWN_EFFECT:
      return { allow: false, reason: "MUST_VERIFY_FIRST", detail: "副作用结果未知，必须先核对真实状态" };
    case STATES.RUNNING:
      return { allow: false, reason: "STILL_RUNNING" };
    case STATES.CANCELLED:
      return sideEffecting
        ? { allow: false, reason: "MUST_VERIFY_FIRST", detail: "取消也可能已产生副作用" }
        : { allow: true, reason: "NO_SIDE_EFFECT" };
    case STATES.FAILED:
      if (sideEffecting && call.uncertainSideEffect) {
        return { allow: false, reason: "MUST_VERIFY_FIRST", detail: "失败但副作用不确定" };
      }
      if (sideEffecting) return { allow: false, reason: "SIDE_EFFECT_TOOL_NEEDS_IDEMPOTENCY_KEY" };
      return { allow: true, reason: "NO_SIDE_EFFECT" };
    case STATES.COMPLETED:
      return { allow: false, reason: "ALREADY_COMPLETED" };
    default:
      return { allow: true, reason: "NOT_STARTED" };
  }
}

const retryCases = [
  { name: "读操作失败（无副作用）", call: { toolId: "file.read", state: STATES.FAILED, uncertainSideEffect: false }, expect: true },
  { name: "写操作失败但副作用不确定", call: { toolId: "file.write", state: STATES.FAILED, uncertainSideEffect: true }, expect: false },
  { name: "结果上报丢失（副作用可能已发生）", call: { toolId: "model.call", state: STATES.UNKNOWN_EFFECT }, expect: false },
  { name: "取消也可能已产生副作用", call: { toolId: "adobe.ps.export", state: STATES.CANCELLED }, expect: false },
  { name: "仍在运行中", call: { toolId: "model.call", state: STATES.RUNNING }, expect: false },
  { name: "已完成", call: { toolId: "mcp.call", state: STATES.COMPLETED }, expect: false },
];
const retryRows = retryCases.map((c) => ({ ...c, got: canRetry(c.call) }));
const retryFailures = retryRows.filter((r) => r.got.allow !== r.expect);
for (const r of retryRows) console.log(`  ${r.got.allow === r.expect ? "[ok]" : "[!!]"} ${r.name} → ${r.got.allow ? "ALLOW" : "DENY"} (${r.got.reason})`);
p.case(
  "任何「副作用可能已发生」的状态都不允许直接重试（UNKNOWN_EFFECT / 取消 / 失败但不确定）",
  retryFailures.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  {
    results: retryRows.map((r) => ({ case: r.name, expected: r.expect ? "ALLOW" : "DENY", got: r.got })),
    failures: retryFailures.map((r) => r.name),
  }
);

// 核对流程：UNKNOWN_EFFECT 必须先 VERIFY，再由核对结果决定下一步
function verify(call, observation) {
  if (call.state !== STATES.UNKNOWN_EFFECT && !(call.state === STATES.FAILED && call.uncertainSideEffect)) {
    throw new Error("VERIFY_NOT_APPLICABLE");
  }
  if (observation === "EFFECT_APPLIED") return { state: STATES.COMPLETED, next: "REPORT_RESULT" };
  if (observation === "EFFECT_NOT_APPLIED") return { state: STATES.FAILED, next: "RETRY_ALLOWED" };
  return { state: STATES.UNKNOWN_EFFECT, next: "ASK_HUMAN" };
}

const v1 = verify({ toolId: "file.write", state: STATES.UNKNOWN_EFFECT }, "EFFECT_APPLIED");
const v2 = verify({ toolId: "file.write", state: STATES.UNKNOWN_EFFECT }, "EFFECT_NOT_APPLIED");
const v3 = verify({ toolId: "file.write", state: STATES.UNKNOWN_EFFECT }, "CANNOT_DETERMINE");
p.case(
  "核对流程闭环：已生效→COMPLETED；未生效→允许重试；无法判定→保持 UNKNOWN_EFFECT 并转人工",
  v1.state === STATES.COMPLETED && v2.next === "RETRY_ALLOWED" && v3.next === "ASK_HUMAN" ? VERDICT.PASS : VERDICT.FAIL,
  {
    applied: v1,
    notApplied: v2,
    indeterminate: v3,
    note:
      "无法判定时必须停在 UNKNOWN_EFFECT 并给出人工核对入口，" +
      "既不能显示成功，也不能「安全重试」——因为无法证明重试是安全的。",
  }
);

p.case(
  "盲目重放被禁止：UNKNOWN_EFFECT 状态下不存在任何允许 RETRY 的路径",
  !canRetry({ toolId: "model.call", state: STATES.UNKNOWN_EFFECT }).allow ? VERDICT.PASS : VERDICT.FAIL,
  {
    contract: {
      states: Object.values(STATES),
      rule: "状态转换由服务端校验；执行端在上报结果前先落盘 callId 与已开始状态",
      unknownEffectEntry: "必须提供核对真实应用状态、相关产物、人工确认三个入口",
    },
    note: "本轮不实现完整任务系统，只把契约写进决策。",
  }
);

p.note(
  "结论：① 日志用字段白名单而非黑名单，多塞字段直接拒绝；七种隐蔽形态（含 base64 与私有路径）全部脱敏；" +
    "② 错误边界只放行用户可读文案 + 机器码 + 两个布尔；stack / env / Authorization / 私有路径实测未外泄；" +
    "③ UNKNOWN_EFFECT 契约闭环，任何「副作用可能已发生」的状态都不可直接重试。"
);

p.write();
process.exit(0);
