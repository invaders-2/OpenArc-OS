/**
 * D4-03C4 · Side-effect Runtime Supervisor（trusted，OpenArc-owned）。
 *
 * 唯一职责：**真实拥有 side-effect executor runtime 的生命周期**，并在真实观测到
 * 进程退出后自动生成 quiescence proof。
 *
 * 永久规则（C3 Closure）：
 *   different runtime instance != proof that the previous runtime is dead。
 *
 * 永久规则（D4-03C4 Closure）：
 *   **Probe failure is not death proof.**
 *
 * 永久规则（D4-03C4 Closure-2）：
 *   **Unix socket pathname existence != process lifetime。**
 *   pathname has been unlinked != bound/open socket process is dead。
 *   因此 filesystem unix-socket probe 只回答 ALIVE / UNKNOWN，绝不回答 PROCESS_DEAD；
 *   ENOENT 也不是 executor death proof。
 *
 * 永久规则（D4-03C4 Closure-3）：
 *   **persisted runtime lifecycle record 不是 process-death authority。**
 *   普通 durable JSON 字段（status / reason / exitCode / signal / endedAt）本身没有资格让
 *   quiesced=true；字符串 "SUPERVISOR_OBSERVED_EXIT" 只是一条 audit label，不是 trusted proof。
 *   cold restart 只能把 persisted record 当 safe recovery/audit hint，**绝不 observeExit**。
 *   真正的 cross-restart authenticated durable lifecycle proof = DEFERRED / NOT VERIFIED；
 *   在它存在之前，cold restart 一律 fail closed（quiesced=false）。
 *
 * 当前阶段唯一允许产生 trusted death proof 的来源：
 *   **本 supervisor lifetime 内真实的 child process 'exit' event**。
 *
 * 因此 persisted executor record 只保存 safe binding（instanceId / status / timestamps /
 * exitCode / signal / reason / callId / holderId），**不保存 socketPath**：
 * probe path 是 derived runtime implementation detail，每次都由 validated instanceId 重新派生。
 *
 * 本 Supervisor 是 **唯一** 调用 RuntimeLifecycleAuthority.observeExit / registerRuntime 的
 * OpenArc production 代码。这两个入口不导出给 Renderer / IPC / ACP / Harness / Tool Facade。
 * 绝不使用 heartbeat / timer / instanceId 差异 / lease 状态推测死亡。
 * 只保存 safe identifier；绝不保存 PID secret / absolute path / token / credential。
 */
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { RuntimeLifecycleAuthority } = require("./runtime-lifecycle-authority.cjs");

const EXECUTOR_ENTRY = path.join(__dirname, "side-effect-executor.cjs");

const EXECUTOR_STATUS = Object.freeze({ ACTIVE: "ACTIVE", EXITED: "EXITED" });

const newId = (prefix) => prefix + "_" + crypto.randomBytes(6).toString("base64url");

/**
 * Liveness 二态：filesystem unix-socket probe 只能证明 reachability。
 * 它没有 PROCESS_DEAD 结论 —— endpoint unreachable != execution quiesced。
 */
const LIVENESS = Object.freeze({ ALIVE: "ALIVE", UNKNOWN: "UNKNOWN" });

/**
 * persisted record 的 EXITED / reason 只是 audit hint，没有任何 death authority：
 * 这里刻意不保留 reason 白名单 —— 命中任何字符串都不得让 quiesced=true。
 */
const UNVERIFIED_PERSISTED_EXIT = "UNVERIFIED_PERSISTED_EXIT";

/** 真实 production executor instanceId 形态（newId("exe")）——probe path 由它派生。 */
const INSTANCE_ID_RE = /^exe_[A-Za-z0-9_-]{1,64}$/;
function isValidInstanceId(value) {
  const id = value == null ? "" : String(value);
  return INSTANCE_ID_RE.test(id);
}

/** 归一化任意 probe 返回值；未知形态一律 fail closed 成 UNKNOWN。 */
function normalizeProbeResult(raw) {
  if (raw === true) return { state: LIVENESS.ALIVE, reason: "CONNECTED", errno: null };
  if (raw && typeof raw === "object" && typeof raw.state === "string" && LIVENESS[raw.state] === raw.state) {
    return { state: raw.state, reason: typeof raw.reason === "string" ? raw.reason.slice(0, 64) : null, errno: raw.errno == null ? null : String(raw.errno) };
  }
  if (typeof raw === "string" && LIVENESS[raw] === raw) return { state: raw, reason: null, errno: null };
  // 任何非 ALIVE/UNKNOWN 结果（含旧 boolean false / 旧 DEFINITELY_GONE 形态）都不是死亡证明。
  return { state: LIVENESS.UNKNOWN, reason: "PROBE_RESULT_UNRECOGNIZED", errno: null };
}

/** 归一化为 safe reason，绝不含绝对路径。 */
function safeProbeReason(code) {
  const c = String(code || "");
  return c ? c.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 48) : "UNEXPECTED_OS_ERROR";
}

/**
 * Reachability probe（二态）。
 *
 * · connect 成功                          → ALIVE
 * · timeout                               → UNKNOWN
 * · 任意 socket error（含 ENOENT）        → UNKNOWN
 * · probe 自身抛异常 / 不可信 socket 形态 → UNKNOWN
 *
 * Unix pathname 的消失无法证明持有该 endpoint 的进程已死（unlink != death），
 * 所以 error 分支绝不产生 death proof。
 *
 * @param opts.connectImpl test-only socket factory seam（production 默认 net.connect）。
 *                         它不导出给 Renderer / IPC / ACP / Harness / Tool Facade，也不落盘。
 */
function probeUnixSocket(socketPath, { timeoutMs = 1500, connectImpl = null } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    const finish = (state, reason, errno = null) => {
      if (settled) return;
      settled = true;
      try { socket && socket.destroy && socket.destroy(); } catch { /* ignore */ }
      resolve({ state, reason, errno });
    };
    try {
      socket = (typeof connectImpl === "function" ? connectImpl : net.connect)(socketPath);
    } catch {
      return finish(LIVENESS.UNKNOWN, "PROBE_EXCEPTION");
    }
    if (!socket || typeof socket.on !== "function" || typeof socket.setTimeout !== "function") {
      return finish(LIVENESS.UNKNOWN, "PROBE_EXCEPTION");
    }
    try { socket.setTimeout(Math.max(1, Number(timeoutMs) || 1500)); } catch { return finish(LIVENESS.UNKNOWN, "PROBE_EXCEPTION"); }
    socket.on("connect", () => finish(LIVENESS.ALIVE, "CONNECTED"));
    // timeout 永远不能成为 death proof。
    socket.on("timeout", () => finish(LIVENESS.UNKNOWN, "PROBE_TIMEOUT"));
    // 任意 OS error（含 ENOENT）都不是 death proof：endpoint unreachable != execution quiesced。
    socket.on("error", (err) => {
      const code = err && err.code != null ? String(err.code) : "";
      return finish(LIVENESS.UNKNOWN, "UNCERTAIN_LIVENESS:" + safeProbeReason(code), code || null);
    });
  });
}

class RuntimeSupervisor {
  #lifecycle;
  #records = new Map();
  #children = new Map();
  #rehydratePromise = null;
  #rehydrated = false;
  /** instanceId -> safe probe reason：liveness 未定（UNKNOWN）的既有 executor runtime。 */
  #uncertain = new Map();

  constructor({ runtimeDir, lifecycle = null, clock = null, logger = null, executorEntry = null, nodePath = null, spawnImpl = null, probeImpl = null, probeTimeoutMs = 1500 } = {}) {
    if (!runtimeDir) throw new Error("RuntimeSupervisor 需要 runtimeDir");
    this.runtimeDir = String(runtimeDir);
    this.executorDir = path.join(this.runtimeDir, "executors");
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.logger = logger;
    this.executorEntry = executorEntry || EXECUTOR_ENTRY;
    this.nodePath = nodePath || process.execPath;
    this.spawnImpl = typeof spawnImpl === "function" ? spawnImpl : spawn;
    // test-only seam：默认（null）用真实 OS probe；不做 IPC / Renderer / Harness 暴露，也不落盘。
    this.probeImpl = typeof probeImpl === "function" ? probeImpl : null;
    this.probeTimeoutMs = Math.max(1, Number(probeTimeoutMs) || 1500);
    // 唯一 trusted lifecycle authority（私有）：外部只能经 isQuiesced() 查询。
    this.#lifecycle = lifecycle && typeof lifecycle.registerRuntime === "function"
      ? lifecycle
      : new RuntimeLifecycleAuthority({ clock: this.clock });
    this.instanceId = newId("oart");
    fs.mkdirSync(this.executorDir, { recursive: true, mode: 0o700 });
  }

  #now() { return this.clock(); }
  /** 真实 OS probe（production 默认）；probeImpl 仅测试注入。 */
  #probe(socketPath) {
    if (this.probeImpl) {
      try { return Promise.resolve(this.probeImpl(socketPath)).then((r) => normalizeProbeResult(r)); }
      catch { return Promise.resolve({ state: LIVENESS.UNKNOWN, reason: "PROBE_EXCEPTION", errno: null }); }
    }
    return probeUnixSocket(socketPath, { timeoutMs: this.probeTimeoutMs });
  }
  #recordPath(instanceId) { return path.join(this.executorDir, String(instanceId) + ".json"); }
  /** probe path 永远从 validated instanceId 重新派生；persisted record 里的 socketPath 一律忽略。 */
  socketPath(instanceId) { return path.join(this.executorDir, String(instanceId) + ".sock"); }

  #persist(rec) {
    try { fs.writeFileSync(this.#recordPath(rec.instanceId), JSON.stringify(rec), { mode: 0o600 }); } catch { /* record 只用于 cross-restart liveness，写失败不改变安全语义（fail closed） */ }
  }
  #load() {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(this.executorDir); } catch { return out; }
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(this.executorDir, name), "utf8"));
        if (rec && rec.instanceId != null) out.push(rec);
      } catch { /* ignore corrupt */ }
    }
    return out;
  }
  /** durable runtime record 契约：只含 safe binding；legacy socketPath / 未知字段一律丢弃。 */
  #sanitize(rec, instanceId) {
    const r = rec && typeof rec === "object" ? rec : {};
    return {
      instanceId,
      status: r.status === EXECUTOR_STATUS.EXITED ? EXECUTOR_STATUS.EXITED : EXECUTOR_STATUS.ACTIVE,
      startedAt: r.startedAt == null ? null : Number(r.startedAt),
      callId: r.callId == null ? null : String(r.callId).slice(0, 128),
      holderId: r.holderId == null ? null : String(r.holderId).slice(0, 128),
      endedAt: r.endedAt == null ? null : Number(r.endedAt),
      exitCode: r.exitCode == null ? null : Number(r.exitCode),
      signal: r.signal == null ? null : String(r.signal).slice(0, 32),
      reason: r.reason == null ? null : String(r.reason).slice(0, 64),
    };
  }
  #safeRecord(rec) {
    return { instanceId: rec.instanceId, status: rec.status, startedAt: rec.startedAt == null ? null : rec.startedAt, endedAt: rec.endedAt == null ? null : rec.endedAt, exitCode: rec.exitCode == null ? null : rec.exitCode, signal: rec.signal || null, reason: rec.reason || null, callId: rec.callId || null };
  }
  /** liveness 未定的 runtime：只记 safe 事件（instanceId + 归一化 reason），绝不记录路径。 */
  #noteUnknown(instanceId, reason) {
    this.#uncertain.set(instanceId, reason || "UNKNOWN");
    this.logger?.log?.({ event: "runtime-supervisor", result: "BLOCK", error_code: null, detail: "runtime_liveness_unknown", instanceId, reason: safeProbeReason(reason) });
  }

  /** 注册一个由本 Supervisor 拥有 / 继承的 runtime instance。只写 ACTIVE，绝不猜测死亡。 */
  registerExecutor(instanceId, { callId = null, holderId = null } = {}) {
    const id = instanceId == null ? "" : String(instanceId);
    // instanceId 派生 probe path：非法标识绝不参与 probe / persist / observeExit。
    if (!isValidInstanceId(id)) return { ok: false, error: "INVALID_INSTANCE_ID" };
    const startedAt = this.#now();
    this.#uncertain.delete(id);
    this.#lifecycle.registerRuntime(id, { self: false, startedAt });
    const rec = this.#sanitize({ callId, holderId }, id);
    rec.status = EXECUTOR_STATUS.ACTIVE;
    rec.startedAt = startedAt;
    this.#records.set(id, rec);
    this.#persist(rec);
    this.logger?.log?.({ event: "runtime-supervisor", result: "ALLOW", detail: "executor_registered" });
    return { ok: true, instanceId: id };
  }

  /**
   * 唯一允许标记死亡的地方（private）。
   * 只有真实观测到进程退出（同一 supervisor lifetime 的 child 'exit'）才到达这里。
   */
  #observeExit(instanceId, { exitCode = null, signal = null, reason = null } = {}) {
    const id = String(instanceId || "");
    if (!isValidInstanceId(id)) return { ok: false, error: "INVALID_INSTANCE_ID" };
    const rec = this.#records.get(id);
    const verdict = this.#lifecycle.observeExit(id, { exitCode, signal });
    if (!verdict || verdict.ok !== true) return verdict || { ok: false, error: "UNKNOWN_RUNTIME" };
    const ended = { ...(rec || this.#sanitize({}, id)), status: EXECUTOR_STATUS.EXITED, endedAt: this.#now(), exitCode: exitCode == null ? null : Number(exitCode), signal: signal || null, reason: reason || "SUPERVISOR_OBSERVED_EXIT" };
    this.#records.set(id, ended);
    this.#persist(ended);
    this.logger?.log?.({ event: "runtime-supervisor", result: "BLOCK", error_code: null, detail: "executor_exited", reason: ended.reason });
    return verdict;
  }

  /**
   * 由 production supervisor 真实拥有的一次 side-effect executor runtime。
   * instanceId 由 Supervisor 生成并注入 child；child 在自己的生命周期内独占 bind socket。
   */
  spawnExecutor({ instanceId = null, callId, holderId, dbPath, storeRoot = null, timeoutMs = 15000, now = null } = {}) {
    const id = instanceId || newId("exe");
    const reg = this.registerExecutor(id, { callId, holderId });
    if (!reg.ok) return { ok: false, error: reg.error };
    const args = { runtimeDir: this.runtimeDir, dbPath, storeRoot, instanceId: id, callId, holderId, timeoutMs, now };
    let child;
    try {
      child = this.spawnImpl(this.nodePath, [this.executorEntry, JSON.stringify(args)], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, HOME: process.env.HOME, ...(process.env.OPENARC_EXECUTOR_FAULT ? { OPENARC_EXECUTOR_FAULT: process.env.OPENARC_EXECUTOR_FAULT } : {}) } });
    } catch (e) {
      this.#observeExit(id, { reason: "EXECUTOR_SPAWN_FAILED" });
      return { ok: false, error: "EXECUTOR_SPAWN_FAILED", detail: String((e && e.message) || e).slice(0, 120) };
    }
    const box = { instanceId: id, child, stdout: "", stderr: "" };
    child.stdout.on("data", (d) => { box.stdout += String(d); });
    child.stderr.on("data", (d) => { box.stderr += String(d); });
    this.#children.set(id, child);
    box.exited = new Promise((resolve) => {
      child.on("exit", (code, signal) => {
        this.#children.delete(id);
        // 真实 child lifecycle event 驱动的自动 observation —— 测试不得自行调用 observeExit。
        this.#observeExit(id, { exitCode: code, signal, reason: "SUPERVISOR_OBSERVED_EXIT" });
        resolve({ code, signal });
      });
    });
    // done 等到 stdio 全部关闭，保证 box.stdout 已完整；observeExit 已在 'exit' 时完成。
    box.done = new Promise((resolve) => { child.on("close", (code, signal) => resolve({ code, signal })); });
    // 必须返回同一个对象：spread 会复制 stdout 快照，导致后续 data 事件写不回调用方。
    box.ok = true;
    return box;
  }

  /** 从一个已写好的 executor 结果行里取 safe 结果。 */
  static parseExecutorMessage(text, type) {
    for (const line of String(text || "").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { const m = JSON.parse(t); if (m && m.type === type) return m; } catch { /* ignore */ }
    }
    return null;
  }

  /**
   * Cold restart rehydrate：**绝不用内存中的旧 authority 自我证明**。
   * 逐条读取上一次进程持久化的 executor record（全部只是 hint）：
   *   · invalid instanceId → ignore（绝不参与 probe / persist / observeExit）；
   *   · EXITED → 绝不 observeExit；quiesced=false（UNVERIFIED_PERSISTED_EXIT）；
   *   · ACTIVE → 用从 validated instanceId 重新派生的 path 做 reachability probe。
   */
  rehydrate() {
    if (this.#rehydratePromise) return this.#rehydratePromise;
    this.#rehydratePromise = (async () => {
      const records = this.#load();
      let alive = 0; let dead = 0; let unknown = 0; let invalid = 0; let unverifiedExit = 0;
      for (const raw of records) {
        const instanceId = raw && raw.instanceId != null ? String(raw.instanceId) : "";
        if (!isValidInstanceId(instanceId)) {
          // pathname 由 instanceId 派生；不可信标识只记 safe 事件，绝不带进 probe / persist。
          invalid += 1;
          this.logger?.log?.({ event: "runtime-supervisor", result: "BLOCK", error_code: null, detail: "runtime_record_invalid" });
          continue;
        }
        const safe = this.#sanitize(raw, instanceId);
        this.#lifecycle.registerRuntime(instanceId, { self: false, startedAt: safe.startedAt });
        if (safe.status === EXECUTOR_STATUS.EXITED) {
          // persisted EXITED（含 reason=SUPERVISOR_OBSERVED_EXIT）没有 death authority：
          // 绝不 observeExit / 绝不 quiesced，只在内存里当作 fail-closed 的 ACTIVE。
          this.#records.set(instanceId, { ...safe, status: EXECUTOR_STATUS.ACTIVE, endedAt: null, exitCode: null, signal: null });
          unknown += 1;
          unverifiedExit += 1;
          this.#noteUnknown(instanceId, UNVERIFIED_PERSISTED_EXIT);
          continue;
        }
        this.#records.set(instanceId, safe);
        // persisted socketPath 一律忽略：probe path 永远从 validated instanceId 重新派生。
        const probe = await this.#probe(this.socketPath(instanceId));
        if (probe.state === LIVENESS.ALIVE) {
          // 旧 runtime 仍存活：绝不写 EXITED / 绝不改 persisted record / 绝不 observeExit。
          alive += 1;
          continue;
        }
        // UNKNOWN：fail closed。runtime 保持 ACTIVE、persisted record 保持原样，
        // 绝不生成退出证据、绝不 quiesced。只记录 safe 事件 + probe reason。
        unknown += 1;
        this.#noteUnknown(instanceId, probe.reason);
      }
      this.#rehydrated = true;
      return { ok: true, records: records.length, alive, dead, unknown, invalid, unverifiedExit };
    })();
    return this.#rehydratePromise;
  }
  whenReady() { return this.rehydrate(); }

  /**
   * 唯一对外 quiescence 查询入口（SideEffectAuthority.lifecycle 就是本对象）。
   * 只有 RuntimeLifecycleAuthority 观测到 trusted EXITED 才 quiesced=true；
   * 其余一律 false —— 其中 liveness 未定的 runtime 额外报告 LIVENESS_UNKNOWN。
   */
  isQuiesced(instanceId) {
    const id = instanceId ? String(instanceId) : "";
    if (!id) return { quiesced: false, reason: "NO_ORIGIN_RUNTIME", proof: { type: "NO_ORIGIN_RUNTIME" } };
    if (!this.#rehydrated) return { quiesced: false, reason: "LIFECYCLE_NOT_READY", proof: { type: "LIFECYCLE_NOT_READY", instanceId: id } };
    const verdict = this.#lifecycle.isQuiesced(id);
    if (verdict.quiesced === true) return verdict;
    const uncertain = this.#uncertain.get(id);
    if (uncertain) return { quiesced: false, reason: "LIVENESS_UNKNOWN", proof: { type: "PROBE_UNCERTAIN", instanceId: id, probeReason: uncertain } };
    return verdict;
  }

  stopExecutor(instanceId) {
    const child = this.#children.get(String(instanceId || ""));
    if (!child) return { ok: true, changed: false };
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    return { ok: true, changed: true };
  }
  stop() {
    for (const child of this.#children.values()) { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
    this.#children.clear();
    return { ok: true };
  }
  snapshot() { return [...this.#records.values()].map((r) => this.#safeRecord(r)); }
}

module.exports = { RuntimeSupervisor, EXECUTOR_STATUS, EXECUTOR_ENTRY, probeUnixSocket, normalizeProbeResult, LIVENESS, UNVERIFIED_PERSISTED_EXIT, isValidInstanceId };
