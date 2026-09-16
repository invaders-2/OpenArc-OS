/**
 * D4-04 Closure · ExecutorLauncher（RuntimeSupervisor 唯一的 child spawn 抽象）。
 *
 * 为什么需要单独一层：
 *   production main 是 Electron 进程，process.execPath 指向 Electron executable，
 *   不是 Node runtime。用 Node child 语义 spawn Electron executable 依赖
 *   "Electron 把脚本当成 app main 运行" 这一非契约行为 —— 每次执行都会起一个完整
 *   Electron browser 进程，且行为不在 Electron 文档保证范围内。
 *
 *   Electron 官方提供的是 utilityProcess.fork()：真正 Node-enabled 的 utility child，
 *   不依赖 ELECTRON_RUN_AS_NODE，也不依赖 runAsNode fuse。
 *
 * 生命周期 authority 仍然只有一个：RuntimeSupervisor。
 * 本模块只负责 spawn / stdio 归一化 / kill，**不做**任何 quiescence 或 death 判定，
 * 也绝不决定是否执行 write。
 *
 * 归一化事件面（两个 launcher 完全一致，且每个事件至多一次）：
 *   spawn / stdout / stderr / exit(code, signal) / close(code, signal) / error(err)
 * close 语义 = 进程已终止（或启动失败）且 stdout/stderr 已完整读取；
 * 调用方可以在 close 后安全 parse executor result。launch 失败也会产生 exit + close，
 * 因此 supervisor 的 ready handshake 永远不会悬空。
 */
"use strict";
const { spawn } = require("node:child_process");

/** 只保留字符串 env 值：Electron utilityProcess 对 undefined 会直接拒绝启动。 */
function sanitizeEnv(env) {
  const out = {};
  if (env && typeof env === "object") for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  return out;
}

/** 统一的 child handle：accumulating stdout/stderr + 最小事件面。 */
function createHandle() {
  const listeners = new Map();
  const handle = {
    stdout: "",
    stderr: "",
    // stdin 只对 Node child 有意义（gated test fixture 用）；utility child 为 null。
    stdin: null,
    pid: null,
    exitCode: null,
    signalCode: null,
    on(event, fn) {
      if (typeof fn !== "function") return handle;
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return handle;
    },
    once(event, fn) {
      const wrap = (...args) => { handle.off(event, wrap); fn(...args); };
      return handle.on(event, wrap);
    },
    off(event, fn) {
      const set = listeners.get(event);
      if (set) set.delete(fn);
      return handle;
    },
    emit(event, ...args) {
      const set = listeners.get(event);
      if (!set) return;
      for (const fn of [...set]) { try { fn(...args); } catch { /* listener 异常绝不改变进程生命周期语义 */ } }
    },
    kill() { return false; },
  };
  return handle;
}

/** 把 Node ChildProcess 归一化成 launcher contract。 */
class NodeChildProcessLauncher {
  constructor({ nodePath = process.execPath, spawnImpl = spawn } = {}) {
    this.nodePath = nodePath;
    this.spawnImpl = typeof spawnImpl === "function" ? spawnImpl : spawn;
    this.available = true;
  }
  launch({ entry, args = [], env = {} } = {}) {
    const child = this.spawnImpl(this.nodePath, [entry, ...args], { stdio: ["pipe", "pipe", "pipe"], env: sanitizeEnv(env) });
    const handle = createHandle();
    handle.pid = child.pid == null ? null : child.pid;
    handle.stdin = child.stdin || null;
    handle.kill = (signal) => { try { child.kill(signal || "SIGKILL"); return true; } catch { return false; } };
    if (child.stdout) child.stdout.on("data", (d) => { handle.stdout += String(d); handle.emit("stdout", String(d)); });
    if (child.stderr) child.stderr.on("data", (d) => { handle.stderr += String(d); handle.emit("stderr", String(d)); });
    let exited = false;
    let closed = false;
    const emitExit = (code, signal) => {
      if (exited) return;
      exited = true;
      handle.exitCode = code == null ? null : code;
      handle.signalCode = signal || null;
      handle.emit("exit", code, signal);
    };
    const emitClose = (code, signal) => {
      if (closed) return;
      closed = true;
      handle.emit("close", code, signal);
    };
    child.on("spawn", () => handle.emit("spawn"));
    // spawn 失败（ENOENT / EACCES）在 Node 里不会发 'exit'，必须归一化成 exit + close。
    child.on("error", (err) => { handle.emit("error", err); emitExit(null, null); });
    child.on("exit", (code, signal) => emitExit(code, signal));
    child.on("close", (code, signal) => { emitExit(code, signal); emitClose(code, signal); });
    return handle;
  }
}

/**
 * Electron utilityProcess launcher。
 *
 * utilityProcess 没有 Node ChildProcess 的 close 事件；这里在 exit 之后等到
 * stdout / stderr 两个 readable stream 都结束后才发 close —— 保证 executeApproved()
 * 在 parse executor result 之前 stdout 已经完整，不靠 sleep 猜 flush。
 */
class ElectronUtilityProcessLauncher {
  constructor({ utilityProcess = null, serviceName = "openarc-side-effect-executor" } = {}) {
    this.utilityProcess = utilityProcess || require("electron").utilityProcess;
    this.serviceName = serviceName;
    this.available = true;
  }
  launch({ entry, args = [], env = {} } = {}) {
    const handle = createHandle();
    let child;
    try {
      child = this.utilityProcess.fork(entry, args, { stdio: "pipe", env: sanitizeEnv(env), serviceName: this.serviceName });
    } catch (err) {
      setImmediate(() => { handle.emit("error", err); handle.emit("exit", null, null); handle.emit("close", null, null); });
      return handle;
    }
    handle.pid = child.pid == null ? null : child.pid;
    handle.stdin = child.stdin || null;
    handle.kill = () => { try { child.kill(); return true; } catch { return false; } };
    const streams = [child.stdout, child.stderr].filter((s) => s && typeof s.on === "function");
    for (const stream of streams) {
      stream.on("data", (d) => {
        const text = String(d);
        if (stream === child.stdout) { handle.stdout += text; handle.emit("stdout", text); }
        else { handle.stderr += text; handle.emit("stderr", text); }
      });
    }
    let exited = false;
    let closed = false;
    let exitCode = null;
    let exitSignal = null;
    // Electron utilityProcess 的 stdout/stderr 在 child 退出后**不会**发出 'end'/'close'
    // （readableEnded 永远为 false）。这里用 event-loop drain 正规化成 close：
    // 退出后每收到一个新 chunk 就重新排一次；只有连续两个 event-loop turn 没有新数据才发 close。
    // 这不是固定 sleep —— 有数据就一定不会提前 close，没有数据就最多两个 turn 后 close。
    let drainGen = 0;
    const scheduleClose = () => {
      if (closed) return;
      const gen = ++drainGen;
      setImmediate(() => setImmediate(() => {
        if (closed || gen !== drainGen || !exited) return;
        closed = true;
        handle.emit("close", exitCode, exitSignal);
      }));
    };
    const emitExit = (code, signal) => {
      if (exited) return;
      exited = true;
      exitCode = code == null ? null : code;
      exitSignal = signal || null;
      handle.exitCode = exitCode;
      handle.signalCode = exitSignal;
      handle.emit("exit", code, signal);
      scheduleClose();
    };
    for (const stream of streams) {
      stream.on("data", () => { if (exited) scheduleClose(); });
    }
    child.on("spawn", () => handle.emit("spawn"));
    // utilityProcess 的 fatal error 不一定伴随 'exit'；这里归一化成 exit + close，保证 fail closed。
    child.on("error", (err) => { handle.emit("error", err); if (!exited) emitExit(null, null); });
    child.on("exit", (code, signal) => emitExit(code, signal));
    return handle;
  }
}

/**
 * Electron main 里 utilityProcess 不可用时的 fail-closed launcher。
 *
 * 绝不回退到 `spawn(process.execPath, ...)`：Electron executable 不是普通 Node contract，
 * 用 Node child 语义启动它只是在"碰巧能跑"，不构成 production 保证。
 * 这里让 spawn 失败关闭：0 lease / 0 mutation，明确报 EXECUTOR_LAUNCHER_UNAVAILABLE。
 */
class UnavailableExecutorLauncher {
  constructor(reason = "EXECUTOR_LAUNCHER_UNAVAILABLE") {
    this.available = false;
    this.reason = reason;
  }
  launch() {
    const err = new Error(this.reason);
    err.code = this.reason;
    throw err;
  }
}

/**
 * launcher 选择（可注入，便于回归测试证明 fail-closed 分支）：
 *   · Electron main + utilityProcess.fork 可用 → ElectronUtilityProcessLauncher；
 *   · Electron main + 不可用               → UnavailableExecutorLauncher（fail closed）；
 *   · 纯 Node（tests / fixtures）           → NodeChildProcessLauncher。
 * Renderer / Harness / ACP / Tool args 一律无法选择或替换 launcher。
 */
function selectExecutorLauncher({ isElectronMain = false, utilityProcess = null } = {}) {
  if (!isElectronMain) return new NodeChildProcessLauncher();
  if (utilityProcess && typeof utilityProcess.fork === "function") return new ElectronUtilityProcessLauncher({ utilityProcess });
  return new UnavailableExecutorLauncher("EXECUTOR_LAUNCHER_UNAVAILABLE");
}

/** production 默认 launcher：由真实运行时事实决定（不做任何 env / Renderer 可影响的选择）。 */
function createDefaultExecutorLauncher() {
  const isElectronMain = !!(process.versions.electron && process.type === "browser");
  let utilityProcess = null;
  if (isElectronMain) {
    try { utilityProcess = require("electron").utilityProcess || null; } catch { utilityProcess = null; }
  }
  return selectExecutorLauncher({ isElectronMain, utilityProcess });
}

module.exports = { NodeChildProcessLauncher, ElectronUtilityProcessLauncher, UnavailableExecutorLauncher, selectExecutorLauncher, createDefaultExecutorLauncher, sanitizeEnv };
