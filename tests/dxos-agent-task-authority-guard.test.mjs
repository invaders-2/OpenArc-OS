/**
 * P1-A · 任务域**方法级**单一写入口源码守卫（全离线；不联网、不新增依赖）。
 *
 * 背景：SQL 级旁路已由 tests/dxos-task-unified-views.test.mjs 守住（写六张任务表的生产文件
 * 只有两个 store 本体）。但"单一写入口"在**方法级**仍可能被绕过：
 * electron/agent-service.cjs 曾直接调 agentTaskStore.createTask / pauseTask / cancelTask /
 * resumeTask / deleteTask / answerTask / continueTask / createProject / addMemory。
 * 本测试把这类调用收口后用源码级断言钉死。
 *
 * 断言分两层：
 *   ① 命令级写方法（COMMAND_ONLY_METHODS）：production 模块里对 store 句柄的调用必须是 **0**
 *      ——这些操作一律经 electron/task-authority.cjs 的路由方法（authority 内部用
 *      resolveDxStore()/store 局部变量，不是 store 句柄，不会被本扫描命中）。
 *   ② 全量写方法：任何命中都必须落在**显式允许列表**内（文件 → 允许方法集合，含理由）；
 *      出现新文件 / 新方法 / allowlist 与实际命中失配都会失败，并打印 文件:行 句柄.方法。
 *
 * 扫描方式（可维护）：方法名白名单 + 句柄正则 + 文件允许列表；注释先按"保留换行"的方式剥离，
 * 保证行号与源码一致（断言要能指出违规文件与行）。
 */
"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SCAN_DIRS = ["electron", "src", "scripts"];

// ---------------------------------------------------------------------------
// 方法名白名单：两套 store 的**写方法**（读方法 / 常量 / 装配函数不在内）
// ---------------------------------------------------------------------------

// electron/agent-task-store.cjs 的写方法（dx 三表 + 其运行期状态机）
const DX_WRITE_METHODS = [
  "createProject", "ensureProjectMember", "createThread",
  "createTask", "recordConversation", "syncAssistantConversation", "deleteAssistantConversation",
  "importLegacyTask", "appendTaskEvent", "addCheckpoint", "updateTaskStatus", "consumeBudget",
  "appendDynamicStep", "attachStepOutput",
  "persistAgentTurn", "advanceAgentTurn", "completeAgentTurn", "appendAgentCheckpoint",
  "sealStaleReactSteps", "savePlan",
  "waitForUser", "waitForChildren", "failTaskFenced", "pauseTaskFenced", "answerTask", "continueTask",
  "refreshTaskInstruction", "pauseTask", "cancelTask", "deleteTask", "resumeTask",
  "registerWorker", "heartbeatWorker", "stopWorker", "recoverExpiredTasks", "claimNextTask", "heartbeatTask",
  "enterVerification", "completeVerifiedTask", "failVerification",
  "startStep", "requeueStep", "requeueReactStepForResume", "completeStep", "failStep",
  "beginOperation", "finishOperation", "addDeliverable", "verifyTask", "postTaskMessage",
  "addMemory", "removeMemory",
];

// electron/task-store.cjs（TaskStore 类）的写方法（core 三表 + 子表）
const CORE_WRITE_METHODS = [
  "insertTask", "updateTask", "insertStep", "updateStep", "insertCall", "updateCall", "appendEvent",
  "insertHarnessRun", "updateHarnessRun", "insertArtifact", "insertVerification", "upsertTaskBudget",
];

const WRITE_METHODS = new Set([...DX_WRITE_METHODS, ...CORE_WRITE_METHODS]);

// 命令级写方法：task-authority 已提供等价路由 API，production 里必须 0 直接调用。
const COMMAND_ONLY_METHODS = new Set([
  "createTask", "pauseTask", "cancelTask", "resumeTask", "deleteTask",
  "answerTask", "continueTask", "createProject", "updateTaskStatus", "attachStepOutput",
]);

// ---------------------------------------------------------------------------
// 文件允许列表：文件 → 允许调用的写方法（"*" = 该 store/authority 本体）
// 每条都写清为什么合法；不在表里的文件命中即违规。
// ---------------------------------------------------------------------------

const ALL = "*";
const ALLOWED = Object.freeze({
  // 两套 store 本体：状态机与全部 SQL 写都实现在这里（SQL 级守卫也以它们为白名单）。
  "agent-task-store.cjs": ALL,
  "task-store.cjs": ALL,
  // 单一写入口自身：按 source 路由，不复制状态机。
  "task-authority.cjs": ALL,
  // core 域服务：core 任务状态机、事务边界、事件/预算语义的 owner；authority 的 core 分支
  // 复用同一个 TaskStore 实例，但不复制它的事务/事件写法（见 task-authority.cjs 头注释）。
  "task-service.cjs": CORE_WRITE_METHODS,
  // core 身份桥：把 dx 审批映射成 core 的 task/step/harness_run 三行（bridge 自己就是这组行的 owner）。
  "dx-task-approval-bridge.cjs": CORE_WRITE_METHODS,
  // 副作用域：只向 core 任务追加一条审计事件（appendEvent），不碰其它写方法。
  "side-effect-authority.cjs": ["appendEvent"],
  "side-effect-runtime.cjs": ["appendEvent"],
  // dx 运行时（ReAct 循环）：任务状态机在运行期的唯一合法消费者——worker/lease/turn/step/
  // operation 这些方法就是为它设计的运行期扩展；不存在"命令层"绕过的语义。
  "agent-react-driver.cjs": [
    "consumeBudget", "savePlan", "sealStaleReactSteps", "appendTaskEvent", "persistAgentTurn",
    "completeAgentTurn", "advanceAgentTurn", "waitForChildren", "waitForUser", "postTaskMessage",
    "addMemory", "appendDynamicStep", "requeueReactStepForResume", "startStep", "beginOperation",
    "finishOperation", "completeStep", "failStep", "failTaskFenced",
  ],
  // 命令层（agent-service.cjs）：P1-A 改后**0 处直接写**；只保留读（getTask/listTasks/...）。
  // 保留空数组是为了让"扫描 0 命中"这件事有显式记录，改坏/改回都会立刻失败。
  "agent-service.cjs": [],
});

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

/** 剥离注释但保留换行，保证 line 号与源码一致。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// store 句柄：本仓里指向"任务 store 实例"的标识（含注入面与 this 面）。
const HANDLE_RE = /(agentTaskStore|effective\.taskStore|state\.taskStore|this\.taskStore|\btaskStore)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
// this.store 是通用名：只有 task-service.cjs 里它才是 core TaskStore（构造函数 this.store = taskStore）。
const THIS_STORE_FILES = new Set(["task-service.cjs"]);
const THIS_STORE_RE = /\bthis\.store\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;

function scanFile(baseName, source) {
  const hits = [];
  const lines = stripComments(source).split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let m;
    HANDLE_RE.lastIndex = 0;
    while ((m = HANDLE_RE.exec(line)) !== null) {
      if (WRITE_METHODS.has(m[2])) hits.push({ line: i + 1, handle: m[1], method: m[2] });
    }
    if (THIS_STORE_FILES.has(baseName)) {
      THIS_STORE_RE.lastIndex = 0;
      while ((m = THIS_STORE_RE.exec(line)) !== null) {
        if (WRITE_METHODS.has(m[1])) hits.push({ line: i + 1, handle: "this.store", method: m[1] });
      }
    }
  }
  return hits;
}

function collectSourceFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (!/\.(cjs|mjs|js|ts)$/.test(name)) continue;
      if (/\.test\.(cjs|mjs|js|ts)$/.test(name)) continue; // 生产模块，不含测试
      const p = path.join(abs, name);
      if (!fs.statSync(p).isFile()) continue;
      files.push({ rel: path.relative(ROOT, p), base: name, source: fs.readFileSync(p, "utf8") });
    }
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** 全量命中：{ rel, base, hits } */
function scanAll() {
  return collectSourceFiles()
    .map((f) => ({ rel: f.rel, base: f.base, hits: scanFile(f.base, f.source) }))
    .filter((f) => f.hits.length > 0);
}

function formatHit(rel, hit) {
  return rel + ":" + hit.line + " → " + hit.handle + "." + hit.method;
}

// ---------------------------------------------------------------------------
// 断言的"白名单本身"先自检：避免方法表被清空后测试静默通过
// ---------------------------------------------------------------------------

test("守卫自检：写方法与命令级方法白名单非空且包含关键方法", () => {
  assert.ok(DX_WRITE_METHODS.length >= 40, "dx 写方法白名单过短");
  assert.ok(CORE_WRITE_METHODS.length >= 10, "core 写方法白名单过短");
  for (const name of ["createTask", "pauseTask", "cancelTask", "resumeTask", "appendTaskEvent", "appendDynamicStep", "addMemory"]) {
    assert.ok(WRITE_METHODS.has(name), "写方法白名单缺少 " + name);
  }
  for (const name of COMMAND_ONLY_METHODS) assert.ok(WRITE_METHODS.has(name), "命令级方法必须属于写方法白名单：" + name);
});

// ---------------------------------------------------------------------------
// ① 命令级写方法：production 直接调用必须为 0（全部经 authority）
// ---------------------------------------------------------------------------

test("命令级写方法：production 里 0 处直接调用 store 句柄（create/pause/cancel/resume/delete/answer/continue/项目/状态/步骤产物）", () => {
  const violations = [];
  for (const file of scanAll()) {
    for (const hit of file.hits) {
      if (COMMAND_ONLY_METHODS.has(hit.method)) violations.push(formatHit(file.rel, hit));
    }
  }
  assert.deepEqual(violations, [], "命令级写操作出现方法级旁路（应改为经 electron/task-authority.cjs）：\n" + violations.join("\n"));
  const service = scanAll().find((f) => f.base === "agent-service.cjs");
  assert.equal(service, undefined, "agent-service.cjs 不应再有 store 写方法调用：" + (service ? service.hits.map((h) => formatHit(service.rel, h)).join(", ") : ""));
});

// ---------------------------------------------------------------------------
// ② 全量写方法：命中必须落在允许列表内，且与实际命中集合一致（失配也失败）
// ---------------------------------------------------------------------------

test("全量写方法：命中文件/方法必须与显式允许列表一致，违规指出 文件:行 句柄.方法", () => {
  const files = scanAll();
  const violations = [];
  for (const file of files) {
    const allowed = ALLOWED[file.base];
    if (allowed === undefined) {
      for (const hit of file.hits) violations.push(formatHit(file.rel, hit) + "（文件不在允许列表）");
      continue;
    }
    if (allowed === ALL) continue;
    for (const hit of file.hits) {
      if (!allowed.includes(hit.method)) violations.push(formatHit(file.rel, hit) + "（" + file.base + " 只允许：" + allowed.join(", ") + "）");
    }
  }
  assert.deepEqual(violations, [], "写方法命中不在允许列表内：\n" + violations.join("\n"));

  // 实际命中集合必须等于允许列表里有写入的文件集合（agent-service.cjs 记录为 0 命中）。
  const hitBases = files.map((f) => f.base).concat(["agent-service.cjs"]).sort();
  // 三个 "*" 本体（task-authority / 两个 store）内部用非句柄表达式调用，故不在命中集合里。
  const expected = Object.keys(ALLOWED)
    .filter((base) => !(base === "task-authority.cjs" || base === "agent-task-store.cjs" || base === "task-store.cjs"))
    .sort();
  assert.deepEqual(hitBases, expected, "允许列表与实际命中失配（新增或消失了调用点，需同步 allowlist 并记录理由）");
});
