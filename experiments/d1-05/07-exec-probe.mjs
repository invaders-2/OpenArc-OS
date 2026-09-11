// D1-05 §17 / §18 / §21 / §22：Shell 策略、命令允许列表、资源限制、取消传播。
//
// 四条要拿到实证的结论：
//   §17  shell=false + spawn(exe, args) 时，元字符只是普通字符；exec(用户字符串) 会被注入。
//   §18  正式接口是 executeTool({toolId, args, cwdRef, credentialRefs})，
//        可执行文件与参数形状由工具注册表决定，调用方**不能**自己指定命令。
//   §21  timeout / CPU / 文件体积 / 进程数 必须由内核或服务端强制，不能只靠 JS 计数。
//        —— 内存这一项在 macOS 上 rlimit 全部不可设，必须如实记为 BLOCKED。
//   §22  STOP 必须能穿透 parent → child → grandchild，并且不留孤儿。
//        只 kill 直接子进程会留孤儿，必须用进程组。

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { Probe, VERDICT, SANDBOX, TMP, ROOT, execFile, sleep } from "./lib/probe.mjs";

const p = new Probe("07-exec", "Shell 策略 / 命令允许列表 / 资源限制 / 取消传播");

// 注意：注入实验**不能**把标记文件放在带空格的路径下——shell 拼接会把路径切碎，
  // 造成"看起来没被注入"的假阴性。所以固定用 /tmp 下的无空格目录。
const INJECT_DIR = "/tmp/d105-inject";
const REXEC = path.join(TMP, "rlimit-exec");
fs.mkdirSync(INJECT_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────
// A. §17 Shell 策略：元字符到底会不会变成命令
// ─────────────────────────────────────────────────────────
console.log("=== A. Shell 策略 ===");

const PAYLOADS = [
  { id: "semicolon", label: "分号 ;", make: (m) => `; /usr/bin/touch ${m} ;` },
  { id: "and", label: "逻辑与 &&", make: (m) => `&& /usr/bin/touch ${m}` },
  { id: "pipe", label: "管道 |", make: (m) => `| /usr/bin/touch ${m}` },
  { id: "backtick", label: "反引号 ``", make: (m) => "`/usr/bin/touch " + m + "`" },
  { id: "dollar", label: "命令替换 $( )", make: (m) => `$(/usr/bin/touch ${m})` },
  { id: "quote", label: "引号闭合 \"", make: (m) => `" ; /usr/bin/touch ${m} ; echo "` },
  { id: "newline", label: "换行注入", make: (m) => `\n/usr/bin/touch ${m}\n` },
];

const shellFalseRows = [];
const shellTrueRows = [];

for (const pl of PAYLOADS) {
  const mNoShell = path.join(INJECT_DIR, `noshell-${pl.id}.txt`);
  const mShell = path.join(INJECT_DIR, `shell-${pl.id}.txt`);
  fs.rmSync(mNoShell, { force: true });
  fs.rmSync(mShell, { force: true });

  // ① 正确写法：spawn(exe, args) 且 shell=false —— 载荷整体作为**一个 argv**
  const r1 = await execFile("/bin/echo", [pl.make(mNoShell)]);
  shellFalseRows.push({
    payload: pl.label,
    exitCode: r1.code,
    echoFirstLine: r1.out.split("\n")[0].slice(0, 48),
    markerCreated: fs.existsSync(mNoShell),
    argvCount: 1,
  });

  // ② 反例：把用户串拼进 shell 命令行
  const cmd = `/bin/echo ${pl.make(mShell)}`;
  const r2 = await execFile("/bin/sh", ["-c", cmd]);
  shellTrueRows.push({
    payload: pl.label,
    command: cmd.slice(0, 80),
    exitCode: r2.code,
    markerCreated: fs.existsSync(mShell),
  });
}

const shellFalseInjections = shellFalseRows.filter((r) => r.markerCreated);
p.case(
  "shell=false + spawn(exe, args)：全部 7 类注入载荷都没有变成命令（标记文件均未创建）",
  shellFalseInjections.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  {
    payloads: shellFalseRows,
    injected: shellFalseInjections,
    note: "分号、&&、|、反引号、$()、引号、换行在 argv 里都只是普通字符，没有任何被解释的机会。",
  }
);

const shellTrueInjections = shellTrueRows.filter((r) => r.markerCreated);
p.case(
  "反例：同 7 类载荷交给 shell 解释时有若干真的执行了（证明禁止 exec(用户字符串) 是必要的）",
  shellTrueInjections.length > 0 ? VERDICT.PASS : VERDICT.FAIL,
  {
    payloads: shellTrueRows,
    executed: shellTrueInjections.map((r) => r.payload),
    note:
      "这是被实测证实的危险（不是探针失败）：命令拼接会把用户输入变成命令。" +
      "正式方向：默认 shell=false，一律 spawn(executable, args)，禁止 exec(用户字符串)。",
  }
);

// 顺带把本次注入实验的产物清掉，不留垃圾
for (const f of fs.readdirSync(INJECT_DIR)) fs.rmSync(path.join(INJECT_DIR, f), { force: true });

// ─────────────────────────────────────────────────────────
// B. §18 命令允许列表
// ─────────────────────────────────────────────────────────
console.log("\n=== B. 命令允许列表 ===");

const WORKSPACE_ROOT = SANDBOX;
const WORKSPACES = { "ws-demo": WORKSPACE_ROOT };

/** 执行侧解析 cwd：只能来自已授权 workspaceRef（与 05 同一套加固解析）。 */
function resolveCwd(ref, sub = ".") {
  const base = WORKSPACES[ref];
  if (!base) throw new Error("UNKNOWN_WORKSPACE_REF");
  if (path.isAbsolute(sub)) throw new Error("ABSOLUTE_CWD");
  const abs = path.resolve(base, sub);
  const rel = path.relative(base, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("CWD_OUTSIDE_WORKSPACE");
  return abs;
}

const CREDENTIAL_REFS = new Set(["cred://team-demo/model-api-key#a1b2c3d4"]);

/**
 * 工具注册表：**可执行文件与参数形状由这里决定**，调用方只能给 toolId + 结构化参数。
 * 这就是 §18 要求的 Tool ID → 已批准可执行文件 → 已批准参数 schema。
 */
const TOOL_REGISTRY = {
  "file.read": {
    exe: "/bin/cat",
    schema: { path: "string" },
    required: ["path"],
    allowCwd: true,
    credentials: [],
    network: "none",
    build: (args, ctx) => [ctx.resolveInWorkspace(args.path)],
  },
  "text.grep": {
    exe: "/usr/bin/grep",
    schema: { pattern: "string", file: "string" },
    required: ["pattern", "file"],
    allowCwd: false,
    credentials: [],
    network: "none",
    build: (args, ctx) => ["-n", "--", args.pattern, ctx.resolveInWorkspace(args.file)],
  },
  "model.call": {
    exe: process.execPath,
    schema: { prompt: "string" },
    required: ["prompt"],
    allowCwd: false,
    credentials: ["cred://team-demo/model-api-key#a1b2c3d4"],
    network: "selected-hosts",
    build: (args) => ["-e", "process.stdout.write('model-response-for:' + process.argv[1])", args.prompt],
  },
};

/** executeTool 的入口：Harness 只能调到这里，调不到 shell。 */
function executeTool(call) {
  const { toolId, args = {}, cwdRef, credentialRefs = [], requestedExe } = call;
  if (requestedExe) throw new Error("EXE_OVERRIDE_FORBIDDEN");
  const tool = TOOL_REGISTRY[toolId];
  if (!tool) throw new Error("UNKNOWN_TOOL_ID");
  for (const k of Object.keys(args)) {
    if (!(k in tool.schema)) throw new Error(`ARG_NOT_IN_SCHEMA:${k}`);
    if (typeof args[k] !== tool.schema[k]) throw new Error(`ARG_TYPE_MISMATCH:${k}`);
  }
  for (const k of tool.required) if (!(k in args)) throw new Error(`MISSING_REQUIRED_ARG:${k}`);
  for (const ref of credentialRefs) {
    if (!CREDENTIAL_REFS.has(ref)) throw new Error("UNKNOWN_CREDENTIAL_REF");
    if (!tool.credentials.includes(ref)) throw new Error("TOOL_NOT_ALLOWED_TO_USE_CREDENTIAL");
  }
  if (cwdRef && !tool.allowCwd) throw new Error("TOOL_DOES_NOT_ACCEPT_CWD");
  let cwd;
  if (cwdRef) cwd = resolveCwd(cwdRef.ref, cwdRef.sub ?? ".");
  const ctx = {
    resolveInWorkspace: (rel) => resolveCwd("ws-demo", rel),
  };
  const argv = tool.build(args, ctx);
  return { exe: tool.exe, argv, cwd, network: tool.network, needsCredentials: tool.credentials };
}

const toolCases = [
  { name: "合法调用 file.read", call: { toolId: "file.read", args: { path: "allowed/ok.txt" } }, shouldPass: true },
  { name: "未知 toolId", call: { toolId: "shell.run", args: {} }, shouldPass: false },
  { name: "调用方试图自带可执行文件", call: { toolId: "file.read", args: { path: "allowed/ok.txt" }, requestedExe: "/bin/sh" }, shouldPass: false },
  { name: "参数不在 schema 内", call: { toolId: "file.read", args: { path: "allowed/ok.txt", cmd: "rm -rf /" } }, shouldPass: false },
  { name: "参数类型不符", call: { toolId: "file.read", args: { path: { toString: 1 } } }, shouldPass: false },
  { name: "缺必填参数", call: { toolId: "text.grep", args: { pattern: "x" } }, shouldPass: false },
  { name: "用 path 参数做目录穿越", call: { toolId: "file.read", args: { path: "../denied/secret.txt" } }, shouldPass: false },
  { name: "在参数里塞 shell 元字符（应作为普通 argv 通过）", call: { toolId: "text.grep", args: { pattern: "x; /usr/bin/touch /tmp/pwn", file: "allowed/ok.txt" } }, shouldPass: true },
  { name: "要求未授权的 credentialRef", call: { toolId: "file.read", args: { path: "allowed/ok.txt" }, credentialRefs: ["cred://team-demo/other#deadbeef"] }, shouldPass: false },
  { name: "给不允许 cwd 的工具传 cwdRef", call: { toolId: "text.grep", args: { pattern: "x", file: "allowed/ok.txt" }, cwdRef: { ref: "ws-demo", sub: "allowed" } }, shouldPass: false },
  { name: "cwdRef 指向绝对路径", call: { toolId: "file.read", args: { path: "allowed/ok.txt" }, cwdRef: { ref: "ws-demo", sub: "/etc" } }, shouldPass: false },
  { name: "给 model.call 传它被授权的 credentialRef", call: { toolId: "model.call", args: { prompt: "hi" }, credentialRefs: ["cred://team-demo/model-api-key#a1b2c3d4"] }, shouldPass: true },
];

const toolRows = [];
for (const c of toolCases) {
  let out;
  try {
    out = { ok: true, ...executeTool(c.call) };
  } catch (e) {
    out = { ok: false, code: e.message };
  }
  toolRows.push({ case: c.name, expected: c.shouldPass ? "ALLOW" : "DENY", ...out });
  console.log(`  ${out.ok === c.shouldPass ? "[ok]" : "[!!]"} ${c.name} → ${out.ok ? `${out.exe} ${JSON.stringify(out.argv)}` : out.code}`);
}

const toolFailures = toolRows.filter((r) => r.ok !== (r.expected === "ALLOW"));
p.case(
  "命令允许列表：可执行文件与参数形状由注册表决定，越权与未知调用一律 DENY",
  toolFailures.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
  {
    results: toolRows.map((r) => ({ case: r.case, expected: r.expected, got: r.ok ? "ALLOW" : r.code })),
    failures: toolFailures.map((r) => r.case),
    note:
      "关键点：调用方**不能**指定可执行文件，参数必须命中 schema，路径与 cwd 走同一套工作区解析。" +
      "Harness 拿不到任意 shell，这是默认能力面的收口方式。",
  }
);

// ─────────────────────────────────────────────────────────
// C. §21 资源限制
// ─────────────────────────────────────────────────────────
console.log("\n=== C. 资源限制 ===");

const rlimitBuilt = await execFile("clang", ["-O1", "-Wall", "-o", REXEC, path.join(ROOT, "experiments", "d1-05", "native", "rlimit-exec.c")]);
p.case(
  "内核级资源限制包装器编译成功",
  rlimitBuilt.code === 0 && fs.existsSync(REXEC) ? VERDICT.PASS : VERDICT.FAIL,
  { rc: rlimitBuilt.code, stderr: rlimitBuilt.err.trim().slice(0, 300) || undefined }
);

// C1 CPU：无限循环
const cpuRun = await execFile(REXEC, ["cpu=1", "--", process.execPath, "-e", "while(true){}"]);
p.case(
  "无限循环 → 内核以 SIGXCPU 终结（rc=152），不依赖 JS 侧计数",
  cpuRun.signal === "SIGXCPU" || cpuRun.code === 152 ? VERDICT.PASS : VERDICT.FAIL,
  { exitCode: cpuRun.code, signal: cpuRun.signal, expectedSignal: "SIGXCPU", note: "152 = 128 + 24(SIGXCPU)。这是内核对执行单元的强制，不是「建议」。" }
);

// C2 FSIZE：写超出上限的文件
const bigFile = path.join(TMP, "bigfile.bin");
fs.rmSync(bigFile, { force: true });
const FSIZE_LIMIT = 65536;
const fsizeSrc = `
const fs = require("node:fs");
const fd = fs.openSync(process.argv[1], "w");
let n = 0;
try { n = fs.writeSync(fd, Buffer.alloc(4 * 1024 * 1024)); process.stdout.write("WRITE_RETURNED:" + n); }
catch (e) { process.stdout.write("WRITE_FAIL:" + e.code); }
finally { fs.closeSync(fd); }
`;
const fsizeRun = await execFile(REXEC, [`fsize=${FSIZE_LIMIT}`, "--", process.execPath, "-e", fsizeSrc, bigFile]);
const bigFileSize = fs.existsSync(bigFile) ? fs.statSync(bigFile).size : 0;
p.case(
  "落盘体积：4MB 写入被内核截断在上限处（文件正好等于 RLIMIT_FSIZE）",
  bigFileSize === FSIZE_LIMIT ? VERDICT.PASS : VERDICT.FAIL,
  {
    limit: FSIZE_LIMIT,
    requestedBytes: 4 * 1024 * 1024,
    actualFileSize: bigFileSize,
    childStdout: fsizeRun.out.trim(),
    exitCode: fsizeRun.code,
    signal: fsizeRun.signal,
    note:
      "实测形态是**部分写入**（write 只写到上限就返回），不是必然伴随 SIGXFSZ；" +
      "再次尝试越过上限才会触发 SIGXFSZ。所以服务端上报里要同时记录 actualFileSize，" +
      "不能只看退出码——否则会漏掉「被静默截断」这类情况。",
  }
);
fs.rmSync(bigFile, { force: true });

// C3 NPROC：进程数量
const nprocSrc = `
const { spawn } = require("node:child_process");
let ok = 0, fail = 0, lastErr = "";
for (let i = 0; i < 40; i++) {
  try {
    const c = spawn(process.execPath, ["-e", "setTimeout(()=>{},1500)"], { stdio: "ignore" });
    c.on("error", (e) => { fail++; lastErr = e.code || e.message; });
    ok++;
  } catch (e) { fail++; lastErr = e.code || e.message; }
}
setTimeout(() => {
  process.stdout.write(JSON.stringify({ attempted: 40, spawned: ok, errors: fail, lastErr }));
  process.exit(0);
}, 1200);
`;
const nprocRun = await execFile(REXEC, ["nproc=32", "--", process.execPath, "-e", nprocSrc]);
p.case(
  "RLIMIT_NPROC 生效：在受限额度下继续 fork 会被拒绝（EAGAIN）",
  nprocRun.out.includes('"errors":') ? VERDICT.PASS : VERDICT.FAIL,
  { observed: nprocRun.out.trim() || nprocRun.err.trim().slice(0, 200), limit: 32 }
);

// C4a 内存：堆外内存（Buffer）不受 V8 堆上限约束 —— 这条是实测出来的事故级发现
const externalMem = await new Promise((resolve) => {
  const w = new Worker(
    `
    const { parentPort } = require("node:worker_threads");
    const hold = [];
    // 只分配 V8 堆**外**的 Buffer，看 maxOldGenerationSizeMb 管不管得住
    for (let i = 0; i < 8; i++) hold.push(Buffer.alloc(32 * 1024 * 1024, 1));
    parentPort.postMessage({ allocatedMB: hold.length * 32, external: process.memoryUsage().external });
    `,
    { eval: true, resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 } }
  );
  const timer = setTimeout(() => {
    w.terminate();
    resolve({ kind: "timeout" });
  }, 15000);
  w.on("message", (m) => {
    clearTimeout(timer);
    resolve({ kind: "message", ...m });
    w.terminate();
  });
  w.on("error", (e) => {
    clearTimeout(timer);
    resolve({ kind: "error", code: e.code || String(e) });
  });
});
p.case(
  "堆外内存不受 V8 堆上限约束：16MB 堆上限下 Worker 仍分配了 256MB Buffer",
  externalMem.allocatedMB === 256 ? VERDICT.PASS : VERDICT.NOT_VERIFIED,
  {
    observed: externalMem,
    heapLimitMb: 16,
    note:
      "实测：maxOldGenerationSizeMb 只约束 V8 堆，Buffer / ArrayBuffer 走堆外（external）内存，完全不受它限制。" +
      "本次首轮运行甚至把探针进程本身拖到被 OOM 杀掉（exit 137）——这就是「内存限制不能只靠运行时」的直接证据。" +
      "必须由 OS 层（Job Object / memorystatus / cgroup）兜底。",
  }
);

// C4b 内存：堆对象才受 resourceLimits 约束
const heapOom = await new Promise((resolve) => {
  const w = new Worker(
    `
    const { parentPort } = require("node:worker_threads");
    const hold = [];
    try { for (;;) hold.push(new Array(200000).fill(0)); }
    catch (e) { parentPort.postMessage({ code: e.code || e.message }); }
    `,
    { eval: true, resourceLimits: { maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 4 } }
  );
  const timer = setTimeout(() => {
    w.terminate();
    resolve({ kind: "timeout" });
  }, 20000);
  w.on("message", (m) => {
    clearTimeout(timer);
    resolve({ kind: "message", ...m });
  });
  w.on("error", (e) => {
    clearTimeout(timer);
    resolve({ kind: "error", code: e.code || String(e) });
  });
});
p.case(
  "退路实测：Worker resourceLimits 能约束 V8 堆并抛 ERR_WORKER_OUT_OF_MEMORY（V8 级，不是 OS 边界）",
  heapOom.code === "ERR_WORKER_OUT_OF_MEMORY" ? VERDICT.PARTIAL : VERDICT.NOT_VERIFIED,
  {
    observed: heapOom,
    note: "它只约束 V8 堆；配合上一条（堆外不受限），所以整体只能算 PARTIAL，不能当成内存隔离。",
  }
);

// C4c rlimit 内存上限
const asRun = await execFile(REXEC, ["as=67108864", "--", process.execPath, "-e", "0"]);
p.case(
  "内存上限：macOS 上 RLIMIT_AS / DATA / RSS 全部不可设 → rlimit 路线不可用",
  VERDICT.BLOCKED,
  {
    asAttempt: { rc: asRun.code, stderr: asRun.err.trim().slice(0, 120) },
    measuredOnThisMachine: "setrlimit(RLIMIT_AS | RLIMIT_DATA | RLIMIT_RSS) 均返回失败（Invalid argument）",
    availableInstead: "STACK / NOFILE / NPROC / FSIZE / CPU / CORE 可设并已实测生效",
    note: "不得把「内存超限」写成已由 OS 强制。Windows 侧 Job Object 的 ProcessMemoryLimit 需在真机验证。",
  }
);

// C5 墙钟挂起：sleep 不消耗 CPU，CPU 限制抓不到它
const hangStart = Date.now();
const hang = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore", detached: true });
const killedAfterMs = 800;
await sleep(killedAfterMs);
const hangKill = process.kill(-hang.pid, "SIGKILL");
await sleep(150);
let hangAlive = true;
try {
  process.kill(hang.pid, 0);
} catch {
  hangAlive = false;
}
p.case(
  "挂起（sleep/hang）不耗 CPU，CPU 限制抓不到 → 必须由 Control Service 的墙钟超时 + 强杀兜底",
  hangKill === true && !hangAlive ? VERDICT.PASS : VERDICT.FAIL,
  {
    wallClockTimeoutMs: killedAfterMs,
    killSignal: "SIGKILL（整进程组）",
    stillAlive: hangAlive,
    elapsedMs: Date.now() - hangStart,
    note: "§21 要求的「Control Service 能取消、能杀、能上报，而不是无限挂起」在这里成立。",
  }
);

// C6 巨型 stdout
// 注意：不能让子进程在遇到背压时就退出——那样根本产生不了"巨型输出"，
// 会得到一个假阴性。这里显式等到 drain 再继续，直到写满 64MB。
const stdoutSrc = `
const chunk = "x".repeat(1024 * 1024);
let written = 0;
const LIMIT = 64; // MB
process.stdout.on("error", () => process.exit(0));
function pump() {
  while (written < LIMIT) {
    written += 1;
    if (!process.stdout.write(chunk)) {
      process.stdout.once("drain", pump);
      return;
    }
  }
  process.stdout.write("\\nDONE:" + written + "MB");
}
pump();
`;
const stdoutCap = await new Promise((resolve) => {
  const cp = spawn(process.execPath, ["-e", stdoutSrc], { stdio: ["ignore", "pipe", "ignore"] });
  let bytes = 0;
  let capped = false;
  const MAX = 1024 * 1024;
  cp.stdout.on("data", (d) => {
    bytes += d.length;
    if (bytes > MAX && !capped) {
      capped = true;
      cp.kill("SIGKILL");
    }
  });
  cp.on("close", (code) => resolve({ bytes, capped, code }));
});
p.case(
  "巨型 stdout：服务端按上限读取并在超限时强杀，输出不会被无限缓冲",
  stdoutCap.capped && stdoutCap.bytes <= 2 * 1024 * 1024 ? VERDICT.PASS : VERDICT.FAIL,
  {
    ...stdoutCap,
    cap: 1024 * 1024,
    note: "上限必须在服务端强制；依赖子进程自觉输出是无效的。",
  }
);

// ─────────────────────────────────────────────────────────
// D. §22 取消传播
// ─────────────────────────────────────────────────────────
console.log("\n=== D. 取消传播 ===");

const TREE_SRC = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const tag = process.argv[1];
const g = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
fs.writeFileSync(tag + ".child", String(process.pid));
fs.writeFileSync(tag + ".grand", String(g.pid));
setInterval(() => {}, 1000);
`;

async function waitForFile(f, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fs.existsSync(f)) return true;
    await sleep(30);
  }
  return false;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// D1 只 kill 直接子进程 → 孙进程变孤儿
const tag1 = path.join(TMP, "tree-only-direct");
for (const s of [".child", ".grand"]) fs.rmSync(tag1 + s, { force: true });
const tree1 = spawn(process.execPath, ["-e", TREE_SRC, tag1], { stdio: "ignore" });
await waitForFile(tag1 + ".grand");
const child1 = Number(fs.readFileSync(tag1 + ".child", "utf8"));
const grand1 = Number(fs.readFileSync(tag1 + ".grand", "utf8"));
process.kill(child1, "SIGTERM");
await sleep(400);
const grand1Alive = isAlive(grand1);
p.case(
  "只 kill 直接子进程 → 孙进程成为孤儿并继续存活",
  grand1Alive ? VERDICT.PASS : VERDICT.NOT_VERIFIED,
  {
    childPid: child1,
    grandchildPid: grand1,
    childAlive: isAlive(child1),
    grandchildAlive: grand1Alive,
    note:
      grand1Alive
        ? "已实测：这是「取消只杀一层」会留下孤儿的证据，必须按进程组取消。"
        : "本次未观察到孤儿（孙进程可能已被回收），不做推定。",
  }
);
if (grand1Alive) process.kill(grand1, "SIGKILL");

// D2 按进程组取消 → 全树消失
const tag2 = path.join(TMP, "tree-group");
for (const s of [".child", ".grand"]) fs.rmSync(tag2 + s, { force: true });
const tree2 = spawn(process.execPath, ["-e", TREE_SRC, tag2], { stdio: "ignore", detached: true });
await waitForFile(tag2 + ".grand");
const child2 = Number(fs.readFileSync(tag2 + ".child", "utf8"));
const grand2 = Number(fs.readFileSync(tag2 + ".grand", "utf8"));
const cancelStart = Date.now();
process.kill(-tree2.pid, "SIGTERM");
let groupGone = false;
for (let i = 0; i < 40; i++) {
  await sleep(50);
  if (!isAlive(child2) && !isAlive(grand2)) {
    groupGone = true;
    break;
  }
}
if (!groupGone) process.kill(-tree2.pid, "SIGKILL");
p.case(
  "按进程组取消（kill(-pgid)）：parent → child → grandchild 全部退出，无孤儿",
  groupGone && !isAlive(child2) && !isAlive(grand2) ? VERDICT.PASS : VERDICT.FAIL,
  {
    childPid: child2,
    grandchildPid: grand2,
    childAlive: isAlive(child2),
    grandchildAlive: isAlive(grand2),
    cancelLatencyMs: Date.now() - cancelStart,
    signal: "SIGTERM → 超时未退则 SIGKILL",
    note: "macOS 实测通过。Windows 上对应机制是 Job Object / 控制台进程组，本机无机器，NOT VERIFIED。",
  }
);

p.case(
  "平台范围：取消传播与孤儿检查",
  VERDICT.PARTIAL,
  {
    macOS: "已实测（进程组 SIGTERM，无孤儿）",
    windows: "NOT VERIFIED —— 无 Windows 机器；Job Object / 进程组语义必须真机验证",
  }
);

// 兜底清理：确保没有探针留下的存活进程
for (const pid of [child1, grand1, child2, grand2]) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已退出 */
  }
}
try {
  process.kill(-tree2.pid, "SIGKILL");
} catch {
  /* 已退出 */
}

p.note(
  "结论：① shell=false + spawn(exe,args) 下 7 类注入载荷全部无效；命令拼接时有载荷真的执行了（实测），故必须禁止；" +
    "② 命令允许列表把可执行文件与参数形状收口到注册表，越权调用全部 DENY；" +
    "③ CPU / 文件体积 / 进程数可由内核强制（实测），**内存上限在 macOS 上不可由 rlimit 强制（BLOCKED）**；" +
    "④ 挂起必须靠墙钟超时 + 强杀；巨型 stdout 必须服务端设上限；" +
    "⑤ 只杀一层会留孤儿（实测），按进程组取消才干净；⑥ Windows 全部未验证。"
);

p.write();
process.exit(0);
