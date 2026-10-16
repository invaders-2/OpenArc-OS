/**
 * P1 · DX OS 地基：受监督子进程封装。
 *
 * 为什么复用 executor-launcher 而不是自己 spawn：仓库里 spawn 的唯一抽象已经是
 * executor-launcher.cjs（Node child 与 Electron utilityProcess 两条实现，事件面归一化成
 * spawn/stdout/stderr/exit/close/error，且 close 保证在 stdout/stderr 读完之后才发）。
 * runtime-supervisor.cjs 也是这一套。再写一个 spawn 只会多出第三条生命周期语义。
 * 本模块只加"业务侧"的四件事：超时、输出上限、取消、事件回推。
 */
"use strict";

const { createDefaultExecutorLauncher } = require("./executor-launcher.cjs");
const {
  normalizeError,
  DXOS_ERR_INVALID_INPUT,
  DXOS_ERR_TIMEOUT,
  DXOS_ERR_CANCELLED,
  DXOS_ERR_CHILD_FAILED,
} = require("./dxos-foundation-errors.cjs");

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
/** kill 之后仍等不到 close 的兜底：保证 run() 的 promise 一定有界地 settle。 */
const FORCE_SETTLE_GRACE_MS = 5000;

/** 按 UTF-8 字节截断，不切坏多字节字符。 */
function truncateUtf8(text, maxBytes) {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let out = "";
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
}

function appendChunk(state, stream, text, maxBytes) {
  if (state.truncated[stream]) return;
  const next = state[stream] + text;
  if (Buffer.byteLength(next, "utf8") > maxBytes) {
    state[stream] = truncateUtf8(next, maxBytes);
    state.truncated[stream] = true;
    return;
  }
  state[stream] = next;
}

function createSupervisedRunner(options = {}) {
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const setTimeoutImpl = typeof options.setTimeoutImpl === "function" ? options.setTimeoutImpl : setTimeout;
  const clearTimeoutImpl = typeof options.clearTimeoutImpl === "function" ? options.clearTimeoutImpl : clearTimeout;
  const maxStdoutBytes = Number.isFinite(options.maxStdoutBytes) ? options.maxStdoutBytes : DEFAULT_MAX_OUTPUT_BYTES;
  const maxStderrBytes = Number.isFinite(options.maxStderrBytes) ? options.maxStderrBytes : DEFAULT_MAX_OUTPUT_BYTES;
  const defaultTimeoutMs = Number.isFinite(options.defaultTimeoutMs) ? options.defaultTimeoutMs : DEFAULT_TIMEOUT_MS;
  const runnerOnEvent = typeof options.onEvent === "function" ? options.onEvent : null;
  const launcher = options.launcher && typeof options.launcher.launch === "function" ? options.launcher : createDefaultExecutorLauncher();
  const active = new Set();

  function failureRecord(code, message, detail) {
    const at = clock();
    const error = { ok: false, error: code, message };
    if (detail !== undefined) error.detail = detail;
    const result = Promise.resolve(Object.freeze({
      ok: false,
      code: null,
      signal: null,
      stdout: "",
      stderr: "",
      truncated: Object.freeze({ stdout: false, stderr: false }),
      timedOut: false,
      cancelled: false,
      error: Object.freeze(error),
      startedAt: at,
      endedAt: at,
      durationMs: 0,
      pid: null,
    }));
    return { pid: null, result, cancel: () => false, state: Object.freeze({ settled: true }) };
  }

  function start(spec = {}) {
    if (typeof spec.entry !== "string" || spec.entry === "") return failureRecord(DXOS_ERR_INVALID_INPUT, "runner entry 必须是非空字符串");
    if (spec.args != null && (!Array.isArray(spec.args) || spec.args.some((arg) => typeof arg !== "string"))) {
      return failureRecord(DXOS_ERR_INVALID_INPUT, "runner args 必须是字符串数组");
    }
    const timeoutMs = Number.isFinite(spec.timeoutMs) ? Math.max(0, spec.timeoutMs) : defaultTimeoutMs;
    const stdoutCap = Number.isFinite(spec.maxStdoutBytes) ? Math.max(0, spec.maxStdoutBytes) : maxStdoutBytes;
    const stderrCap = Number.isFinite(spec.maxStderrBytes) ? Math.max(0, spec.maxStderrBytes) : maxStderrBytes;
    const startedAt = clock();
    const state = { code: null, signal: null, timedOut: false, cancelled: false, cancelReason: null, error: null, stdout: "", stderr: "", truncated: { stdout: false, stderr: false }, settled: false };
    let handle = null;
    let timer = null;
    let graceTimer = null;
    let resolveResult = null;
    const result = new Promise((resolve) => { resolveResult = resolve; });

    const emit = (event) => {
      const payload = Object.freeze({ at: clock(), ...event });
      for (const listener of [spec.onEvent, runnerOnEvent]) {
        if (typeof listener === "function") {
          try { listener(payload); } catch { /* 事件监听器异常不得改变子进程生命周期 */ }
        }
      }
    };

    const finish = () => {
      if (state.settled) return;
      state.settled = true;
      if (timer) clearTimeoutImpl(timer);
      if (graceTimer) clearTimeoutImpl(graceTimer);
      if (spec.signal && typeof spec.signal.removeEventListener === "function") {
        try { spec.signal.removeEventListener("abort", onAbort); } catch { /* ignore */ }
      }
      active.delete(record);
      const endedAt = clock();
      let error = null;
      if (state.timedOut) error = { ok: false, error: DXOS_ERR_TIMEOUT, message: "子进程在 " + timeoutMs + "ms 内未退出", detail: { timeoutMs } };
      else if (state.cancelled) error = { ok: false, error: DXOS_ERR_CANCELLED, message: "子进程已取消", detail: { reason: state.cancelReason } };
      else if (state.error) error = normalizeError(state.error);
      else if (state.code !== 0) error = { ok: false, error: DXOS_ERR_CHILD_FAILED, message: "子进程退出码 " + state.code, detail: { code: state.code, signal: state.signal } };
      emit({ type: "settle", ok: !error, code: state.code, signal: state.signal });
      resolveResult(Object.freeze({
        ok: !error,
        code: state.code,
        signal: state.signal,
        stdout: state.stdout,
        stderr: state.stderr,
        truncated: Object.freeze({ stdout: state.truncated.stdout, stderr: state.truncated.stderr }),
        timedOut: state.timedOut,
        cancelled: state.cancelled,
        error: error ? Object.freeze(error) : null,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        pid: state.pid == null ? null : state.pid,
      }));
    };

    const terminate = (reason) => {
      emit({ type: "kill", reason });
      try { if (handle) handle.kill(); } catch { /* 已退出 */ }
      if (!graceTimer) graceTimer = setTimeoutImpl(finish, FORCE_SETTLE_GRACE_MS);
    };

    const cancel = (reason) => {
      if (state.settled || state.cancelled) return false;
      state.cancelled = true;
      state.cancelReason = reason == null ? "CANCELLED" : String(reason);
      emit({ type: "cancel", reason: state.cancelReason });
      terminate(state.cancelReason);
      return true;
    };

    function onAbort() { cancel("ABORTED"); }

    const record = {
      get pid() { return state.pid == null ? null : state.pid; },
      get state() { return state; },
      cancel,
      result,
    };
    active.add(record);

    try {
      handle = launcher.launch({ entry: spec.entry, args: spec.args || [], env: spec.env || {} });
    } catch (err) {
      state.error = err;
      finish();
      return record;
    }
    state.pid = handle.pid == null ? null : handle.pid;
    handle.on("spawn", () => emit({ type: "spawn", pid: state.pid }));
    handle.on("stdout", (text) => {
      const chunk = String(text);
      appendChunk(state, "stdout", chunk, stdoutCap);
      emit({ type: "stdout", text: chunk, truncated: state.truncated.stdout });
    });
    handle.on("stderr", (text) => {
      const chunk = String(text);
      appendChunk(state, "stderr", chunk, stderrCap);
      emit({ type: "stderr", text: chunk, truncated: state.truncated.stderr });
    });
    handle.on("error", (err) => {
      state.error = err;
      emit({ type: "error", code: err && err.code ? String(err.code) : null });
    });
    handle.on("exit", (code, signal) => {
      state.code = code == null ? null : code;
      state.signal = signal || null;
      emit({ type: "exit", code: state.code, signal: state.signal });
    });
    handle.on("close", (code, signal) => {
      if (state.code == null && code != null) state.code = code;
      if (!state.signal && signal) state.signal = signal;
      emit({ type: "close", code: state.code, signal: state.signal });
      finish();
    });

    if (timeoutMs > 0) {
      timer = setTimeoutImpl(() => {
        if (state.settled || state.timedOut) return;
        state.timedOut = true;
        emit({ type: "timeout", timeoutMs });
        terminate("TIMEOUT");
      }, timeoutMs);
    }
    if (spec.signal) {
      if (spec.signal.aborted) cancel("ABORTED");
      else if (typeof spec.signal.addEventListener === "function") spec.signal.addEventListener("abort", onAbort, { once: true });
    }

    return record;
  }

  function run(spec) {
    return start(spec).result;
  }

  function cancelAll(reason) {
    let count = 0;
    for (const record of [...active]) if (record.cancel(reason || "SHUTDOWN")) count += 1;
    return count;
  }

  return { start, run, cancelAll, get activeCount() { return active.size; } };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  FORCE_SETTLE_GRACE_MS,
  truncateUtf8,
  createSupervisedRunner,
};
