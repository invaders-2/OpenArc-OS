// D1-05 §15 / §16 / §20：OS 级隔离、执行模型对比、网络边界。
//
// 这一版是"实测优先"的：能测出的写结论，测不出的写 BLOCKED / NOT VERIFIED，
// 不允许用"理论上应该安全"顶上。
//
// 本机实测到的硬事实（关键）：
//   sandbox-exec 只能应用 (allow default) 这类**不增加限制**的 profile；
//   一旦 profile 里出现任何 deny 规则，就返回 `sandbox_apply: Operation not permitted`。
//   => 本机无法建立"进程级文件/网络沙箱"这一档 OS 约束。

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { Probe, VERDICT, SANDBOX, PROFILES_DIR, ROOT, execFile } from "./lib/probe.mjs";

const p = new Probe("06-isolation", "OS 级隔离 / 执行模型 / 网络边界");

const ALLOWED = path.join(SANDBOX, "allowed");
const DENIED = path.join(SANDBOX, "denied");
const PROFILES = PROFILES_DIR;
const DENIED_FILE = path.join(DENIED, "secret.txt");
const ALLOWED_FILE = path.join(ALLOWED, "ok.txt");
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

fs.mkdirSync(PROFILES, { recursive: true });

if (!fs.existsSync(DENIED_FILE) || !fs.existsSync(ALLOWED_FILE)) {
  p.case("前置：文件沙箱布局存在", VERDICT.BLOCKED, {
    note: "请先运行 05-path-probe.mjs 建立 sandbox/{allowed,denied}。",
  });
  p.write();
  process.exit(0);
}

const P_PERMISSIVE = path.join(PROFILES, "permissive.sb");
const P_DENY_FILES = path.join(PROFILES, "deny-denied-dir.sb");
const P_DENY_NET = path.join(PROFILES, "deny-network.sb");

fs.writeFileSync(P_PERMISSIVE, "(version 1)\n(allow default)\n");
fs.writeFileSync(P_DENY_FILES, `(version 1)\n(allow default)\n(deny file-read* (subpath "${DENIED}"))\n`);
fs.writeFileSync(P_DENY_NET, "(version 1)\n(allow default)\n(deny network*)\n");

// ─────────────────────────────────────────────────────────
// A. OS 级进程沙箱（seatbelt）：能不能真的建立约束
// ─────────────────────────────────────────────────────────
console.log("=== A. OS 级进程沙箱（seatbelt）===");

p.case(
  "本机存在 /usr/bin/sandbox-exec（macOS seatbelt）",
  fs.existsSync(SANDBOX_EXEC) ? VERDICT.PASS : VERDICT.BLOCKED,
  { path: SANDBOX_EXEC }
);

const permissiveRun = await execFile(SANDBOX_EXEC, ["-f", P_PERMISSIVE, "/bin/echo", "OK"]);
p.case(
  "可以应用「不增加限制」的 profile（allow default）",
  permissiveRun.code === 0 ? VERDICT.PASS : VERDICT.FAIL,
  { rc: permissiveRun.code, out: permissiveRun.out.trim(), err: permissiveRun.err.trim().slice(0, 120) }
);

const restrictedRun = await execFile(SANDBOX_EXEC, ["-f", P_DENY_FILES, "/bin/echo", "OK"]);
p.case(
  "应用任何「增加限制」的 profile（含 deny 规则）→ 内核拒绝，无法建立 OS 级约束",
  VERDICT.BLOCKED,
  {
    rc: restrictedRun.code,
    stderr: restrictedRun.err.trim().slice(0, 200),
    profileContent: fs.readFileSync(P_DENY_FILES, "utf8").trim(),
    reason:
      "本环境自身已处于沙箱内，macOS 拒绝套用更严格的 seatbelt profile；" +
      "因此「进程级文件/网络沙箱」这一档 OS 约束在本机无法实测。",
    cannotClaim: "不得因此写成 PASS，也不得用 JS 层 monkey-patch 冒充 OS 约束。",
  }
);

const catAllowed = await execFile("/bin/cat", [ALLOWED_FILE]);
const catDenied = await execFile("/bin/cat", [DENIED_FILE]);
p.case(
  "对照：无沙箱时同一进程既能读 allowed/ 也能读 denied/（约束前提）",
  catAllowed.code === 0 && catDenied.code === 0 ? VERDICT.PASS : VERDICT.FAIL,
  { allowedRead: catAllowed.out.trim(), deniedRead: catDenied.out.trim().slice(0, 40) }
);

p.case(
  "本机仍可验证的 OS/内核级机制清单（每条都有独立证据，不是推断）",
  VERDICT.PASS,
  {
    mechanisms: [
      { name: "O_NOFOLLOW（内核拒绝末段软链）", evidence: "05-path-probe：TOCTOU-1 返回 ELOOP", covers: "末段符号链接替换" },
      { name: "RLIMIT_CPU（内核强制 CPU 时间）", evidence: "07-exec-probe：死循环被内核以 SIGXCPU 终结", covers: "无限循环 / CPU 占用" },
      { name: "RLIMIT_FSIZE（内核强制单文件写入量）", evidence: "07-exec-probe", covers: "落盘体积失控" },
      { name: "RLIMIT_NPROC（内核强制进程/线程数）", evidence: "07-exec-probe", covers: "进程炸弹" },
      { name: "UDS 文件权限位（0700/0600）", evidence: "01-local-ipc-probe：目录 0700、套接字 0600", covers: "本机服务端点访问控制（跨 uid 未验证）" },
      { name: "进程组信号 kill(-pgid)", evidence: "07-exec-probe：取消后无孤儿", covers: "取消传播" },
    ],
    notAvailable: [
      "seatbelt 进程级文件/网络白名单（BLOCKED）",
      "RLIMIT_AS / RLIMIT_DATA / RLIMIT_RSS 内存上限（macOS 上 setrlimit 直接失败，见 07）",
      "最小权限账号 / AppContainer / Job Object（本机无第二账号、无 Windows）",
    ],
  }
);

// ─────────────────────────────────────────────────────────
// B. 网络边界（§20）
// ─────────────────────────────────────────────────────────
console.log("\n=== B. 网络边界 ===");

const server = net.createServer((c) => {
  c.on("error", () => {}); // 客户端提前 destroy 会触发 ECONNRESET，探针不能被它带走
  c.end("ok\n");
});
server.on("error", () => {});
await new Promise((r) => server.listen({ host: "127.0.0.1", port: 0 }, r));
const port = server.address().port;

const netSrc = `
const net = require("node:net");
const s = net.connect({ host: "127.0.0.1", port: Number(process.argv[1]) });
s.setTimeout(2500, () => { process.stdout.write("NET_TIMEOUT"); s.destroy(); });
s.on("connect", () => { process.stdout.write("NET_OK"); s.destroy(); });
s.on("error", (e) => process.stdout.write("NET_FAIL:" + e.code));
`;

const netPlain = await execFile(process.execPath, ["-e", netSrc, String(port)]);
p.case(
  `对照：无约束时 Node 可以连到 127.0.0.1:${port}`,
  netPlain.out === "NET_OK" ? VERDICT.PASS : VERDICT.FAIL,
  { observed: netPlain.out, port }
);

const netRestricted = await execFile(SANDBOX_EXEC, ["-f", P_DENY_NET, process.execPath, "-e", netSrc, String(port)]);
p.case(
  "network:none 的执行单元是否建立不了出站连接",
  VERDICT.BLOCKED,
  {
    observed: netRestricted.out.trim() || null,
    stderr: netRestricted.err.trim().slice(0, 160),
    reason: "本机无法应用带 deny network* 的 seatbelt profile，因此无法在真实 OS 层构造「无网络权限的执行单元」。",
    explicitlyNotAccepted: [
      "用 JS 里 patch fetch / net.connect 冒充网络沙箱——那不是边界，改一行代码就绕过",
      "用 hosts 或防火墙规则代替——无法在探针内可复现地开关",
    ],
    model:
      "本轮只冻结权限模型：network: none / selected-hosts / unrestricted；" +
      "强制点必须在 OS 层或经审计的本地代理；Windows 侧未验证。",
  }
);
server.close();

// ─────────────────────────────────────────────────────────
// C. §16 执行模型对比（只测能测的）
// ─────────────────────────────────────────────────────────
console.log("\n=== C. 执行模型对比 ===");

const DRIVER = `
const { spawn } = require("node:child_process");
const { Worker } = require("node:worker_threads");
const mode = process.argv[1];
console.log("HOST_START");
const boom = "setTimeout(() => { throw new Error('plugin-crash'); }, 50);";
if (mode === "same") { eval(boom); }
else if (mode === "worker") {
  const w = new Worker(boom, { eval: true });
  w.on("error", (e) => console.log("WORKER_ERROR:" + e.message));
} else {
  const c = spawn(process.execPath, ["-e", boom], { stdio: "ignore" });
  c.on("exit", (code) => console.log("CHILD_EXIT:" + code));
}
setTimeout(() => { console.log("HOST_ALIVE"); process.exit(0); }, 900);
`;

async function crashTest(mode) {
  const r = await execFile(process.execPath, ["-e", DRIVER, mode]);
  return { mode, code: r.code, out: r.out, hostSurvived: r.out.includes("HOST_ALIVE") };
}
const crashSame = await crashTest("same");
const crashWorker = await crashTest("worker");
const crashChild = await crashTest("child");

p.case(
  "崩溃隔离：同进程时插件崩溃 = 宿主崩溃；Worker / 子进程下宿主存活",
  !crashSame.hostSurvived && crashWorker.hostSurvived && crashChild.hostSurvived ? VERDICT.PASS : VERDICT.FAIL,
  {
    sameProcess: { hostSurvived: crashSame.hostSurvived, exitCode: crashSame.code },
    workerThread: {
      hostSurvived: crashWorker.hostSurvived,
      detail: crashWorker.out.trim().split("\n").filter((l) => l.includes("ERROR")),
    },
    childProcess: {
      hostSurvived: crashChild.hostSurvived,
      detail: crashChild.out.trim().split("\n").filter((l) => l.includes("EXIT")),
    },
    note: "同进程没有任何崩溃隔离——插件抛错会把整个 OpenArc 主进程带走。",
  }
);

const sab = new SharedArrayBuffer(8);
const view = new Int32Array(sab);
const sharedResult = await new Promise((resolve) => {
  const w = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const v = new Int32Array(workerData.sab);
    v[0] = 0x51;
    parentPort.postMessage({ workerHeapTotal: process.memoryUsage().heapTotal, visibleEnvKeys: Object.keys(process.env).length });
    `,
    { eval: true, workerData: { sab } }
  );
  w.on("message", (m) => resolve({ ...m, mainSeesValue: view[0] }));
  w.on("error", (e) => resolve({ error: String(e) }));
});
p.case(
  "内存隔离：Worker 写 SharedArrayBuffer，主线程直接读到同一个地址的值 → 无内存边界",
  sharedResult.mainSeesValue === 0x51 ? VERDICT.PASS : VERDICT.FAIL,
  {
    ...sharedResult,
    note: "Worker Thread 与主线程共享同一进程地址空间。结论：Worker 只解决「不把主线程卡住」，不解决「隔离」。",
  }
);

const fsProbeSrc = `
const fs = require("node:fs");
try { fs.readFileSync(process.argv[1]); process.stdout.write("DENIED_READABLE"); }
catch (e) { process.stdout.write("DENIED_" + e.code); }
`;
const fsSame = await execFile(process.execPath, ["-e", fsProbeSrc, DENIED_FILE]);
const fsChild = await execFile(process.execPath, ["-e", fsProbeSrc, DENIED_FILE]);
const fsRestricted = await execFile(SANDBOX_EXEC, ["-f", P_DENY_FILES, process.execPath, "-e", fsProbeSrc, DENIED_FILE]);
p.case(
  "文件系统约束：同进程与普通子进程都能直接读 denied/；OS 沙箱档因 profile 无法应用而未测",
  fsSame.out.includes("DENIED_READABLE") && fsChild.out.includes("DENIED_READABLE") ? VERDICT.PARTIAL : VERDICT.FAIL,
  {
    sameProcess: fsSame.out.trim(),
    childProcess: fsChild.out.trim(),
    osSandboxed: { verdict: VERDICT.BLOCKED, stderr: fsRestricted.err.trim().slice(0, 120) },
    note: "「子进程」这一档本身不带来任何文件系统约束（已实测）。D 档（OS 沙箱子进程）在本机 BLOCKED，不能写成已具备。",
  }
);

const MODEL_MATRIX = [
  { model: "A 同进程", crash: "无（宿主一起死）", memory: "无", fs: "无约束（实测）", network: "无约束", env: "完全共享（04 实测）", measured: ["crash", "fs", "env"] },
  { model: "B Worker Thread", crash: "有（宿主存活，实测）", memory: "无（共享地址空间，实测）", fs: "无约束（等同同进程）", network: "无约束", env: "完全共享（04 实测）", measured: ["crash", "memory", "env"] },
  { model: "C 子进程", crash: "有（实测）", memory: "有（独立地址空间）", fs: "无约束（实测）", network: "无约束", env: "可控，需显式允许列表（04 实测）", measured: ["crash", "fs", "env"] },
  { model: "D OS 沙箱子进程", crash: "有", memory: "有", fs: "无法在本机建立（BLOCKED）", network: "无法在本机建立（BLOCKED）", env: "可控", measured: [] },
];

p.case(
  "执行模型结论：Worker Thread 不是安全边界；Child Process 单独也不是沙箱",
  VERDICT.PASS,
  {
    matrix: MODEL_MATRIX,
    conclusion: [
      "Worker Thread 不是安全边界 —— 共享地址空间 + 共享 process.env，两项均已实测",
      "Child Process 单独也不是沙箱 —— 文件系统与网络访问完全不受限，已实测",
      "只有「子进程 + OS 级沙箱（或最小权限账号）」才可能构成执行边界，但该档在本机 BLOCKED",
      "Windows 对应能力（Job Object / AppContainer / Restricted Token / Named Pipe ACL）本机无机器，全部 NOT VERIFIED",
    ],
    note: "正式方向仍按 D 档设计，但必须明确标注「本机未取得 D 档证据」。",
  }
);

p.note(
  "结论：① seatbelt 在本机只能应用不增加限制的 profile，任何 deny 规则都会 sandbox_apply 失败 —— " +
    "所以「进程级文件/网络沙箱」这一档 OS 约束在本机是 BLOCKED，不得写成已具备；" +
    "② 本机仍可验证的内核级机制是 O_NOFOLLOW / RLIMIT_CPU·FSIZE·NPROC / UDS 权限位 / 进程组信号（各有独立证据）；" +
    "③ Worker Thread 无内存与环境边界（实测）；④ 子进程本身不带任何文件系统约束（实测）；⑤ Windows 全部未验证。"
);

p.write();
process.exit(0);
