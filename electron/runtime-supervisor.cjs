/**
 * D4-03C4 · Side-effect Runtime Supervisor（trusted，OpenArc-owned）。
 *
 * 唯一职责：**真实拥有 side-effect executor runtime 的生命周期**，并在真实观测到
 * 进程退出后自动生成 quiescence proof。
 *
 * 永久规则（C3 Closure 的延续）：
 *   different runtime instance != proof that the previous runtime is dead。
 *
 * 本 Supervisor 是 **唯一** 调用 RuntimeLifecycleAuthority.observeExit / registerRuntime 的
 * OpenArc production 代码。这两个入口不导出给 Renderer / IPC / ACP / Harness / Tool Facade；
 * 调用只由真实 runtime lifecycle event 驱动：
 *   · child process 'exit' 事件（同一 supervisor lifetime）；
 *   · cold restart 后对持久 executor record 的 OS-backed liveness probe
 *     （每个 executor runtime 在自己的整个生命周期内独占 bind 一个 unix socket；
 *      bind 成功 / connect 被拒 = 该 runtime 的进程已不存在）。
 *
 * 绝不使用 heartbeat / timer / instanceId 差异 / lease 状态推测死亡。
 * 只保存 safe identifier；绝不保存 PID secret / absolute path（除运行目录）/ token / credential。
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

/** OC-backed liveness probe：connect 成功 = 仍存活；ENOENT / ECONNREFUSED = 进程已不存在。 */
function probeUnixSocket(socketPath, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; try { socket.destroy(); } catch { /* ignore */ } resolve(v); };
    const socket = net.connect(socketPath);
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

class RuntimeSupervisor {
  #lifecycle;
  #records = new Map();
  #children = new Map();
  #rehydratePromise = null;
  #rehydrated = false;

  constructor({ runtimeDir, lifecycle = null, clock = null, logger = null, executorEntry = null, nodePath = null, spawnImpl = null } = {}) {
    if (!runtimeDir) throw new Error("RuntimeSupervisor 需要 runtimeDir");
    this.runtimeDir = String(runtimeDir);
    this.executorDir = path.join(this.runtimeDir, "executors");
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.logger = logger;
    this.executorEntry = executorEntry || EXECUTOR_ENTRY;
    this.nodePath = nodePath || process.execPath;
    this.spawnImpl = typeof spawnImpl === "function" ? spawnImpl : spawn;
    // 唯一 trusted lifecycle authority（私有）：外部只能经 isQuiesced() 查询。
    this.#lifecycle = lifecycle && typeof lifecycle.registerRuntime === "function"
      ? lifecycle
      : new RuntimeLifecycleAuthority({ clock: this.clock });
    this.instanceId = newId("oart");
    fs.mkdirSync(this.executorDir, { recursive: true, mode: 0o700 });
  }

  #now() { return this.clock(); }
  #recordPath(instanceId) { return path.join(this.executorDir, String(instanceId) + ".json"); }
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
      try { const rec = JSON.parse(fs.readFileSync(path.join(this.executorDir, name), "utf8")); if (rec && rec.instanceId) out.push(rec); } catch { /* ignore corrupt */ }
    }
    return out;
  }
  #safeRecord(rec) {
    return { instanceId: rec.instanceId, status: rec.status, startedAt: rec.startedAt == null ? null : rec.startedAt, endedAt: rec.endedAt == null ? null : rec.endedAt, exitCode: rec.exitCode == null ? null : rec.exitCode, signal: rec.signal || null, reason: rec.reason || null, callId: rec.callId || null };
  }

  /** 注册一个由本 Supervisor 拥有 / 继承的 runtime instance。只写 ACTIVE，绝不猜测死亡。 */
  registerExecutor(instanceId, { callId = null, holderId = null } = {}) {
    const id = String(instanceId || "");
    if (!id) return { ok: false, error: "INVALID_INPUT" };
    const startedAt = this.#now();
    this.#lifecycle.registerRuntime(id, { self: false, startedAt });
    const rec = { instanceId: id, status: EXECUTOR_STATUS.ACTIVE, socketPath: this.socketPath(id), startedAt, callId, holderId, endedAt: null, exitCode: null, signal: null, reason: null };
    this.#records.set(id, rec);
    this.#persist(rec);
    this.logger?.log?.({ event: "runtime-supervisor", result: "ALLOW", detail: "executor_registered" });
    return { ok: true, instanceId: id };
  }

  /**
   * 唯一允许标记死亡的地方（private）。
   * 只有真实观测到进程退出（child 'exit' / OS-backed socket 消失）才到达这里。
   */
  #observeExit(instanceId, { exitCode = null, signal = null, reason = null } = {}) {
    const id = String(instanceId || "");
    if (!id) return { ok: false, error: "INVALID_INPUT" };
    const rec = this.#records.get(id);
    const verdict = this.#lifecycle.observeExit(id, { exitCode, signal });
    if (!verdict || verdict.ok !== true) return verdict || { ok: false, error: "UNKNOWN_RUNTIME" };
    const ended = { ...(rec || { instanceId: id, startedAt: null, callId: null }), status: EXECUTOR_STATUS.EXITED, endedAt: this.#now(), exitCode: exitCode == null ? null : Number(exitCode), signal: signal || null, reason: reason || "SUPERVISOR_OBSERVED_EXIT" };
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
      child = this.spawnImpl(this.nodePath, [this.executorEntry, JSON.stringify(args)], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, HOME: process.env.HOME } });
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
   * 逐条读取上一次进程持久化的 executor record，并用 OS-backed socket probe 重新判定。
   */
  rehydrate() {
    if (this.#rehydratePromise) return this.#rehydratePromise;
    this.#rehydratePromise = (async () => {
      const records = this.#load();
      let alive = 0; let dead = 0;
      for (const rec of records) {
        if (!rec || !rec.instanceId) continue;
        this.#records.set(rec.instanceId, rec);
        if (rec.status !== EXECUTOR_STATUS.EXITED) {
          const stillAlive = await probeUnixSocket(rec.socketPath || this.socketPath(rec.instanceId));
          if (stillAlive) { this.#lifecycle.registerRuntime(rec.instanceId, { self: false, startedAt: rec.startedAt }); alive += 1; continue; }
          this.#lifecycle.registerRuntime(rec.instanceId, { self: false, startedAt: rec.startedAt });
          this.#observeExit(rec.instanceId, { exitCode: rec.exitCode, signal: rec.signal, reason: "OS_EXECUTOR_SOCKET_GONE" });
          dead += 1;
          continue;
        }
        this.#lifecycle.registerRuntime(rec.instanceId, { self: false, startedAt: rec.startedAt });
        this.#lifecycle.observeExit(rec.instanceId, { exitCode: rec.exitCode, signal: rec.signal });
      }
      this.#rehydrated = true;
      return { ok: true, records: records.length, alive, dead };
    })();
    return this.#rehydratePromise;
  }
  whenReady() { return this.rehydrate(); }

  /** 唯一对外 quiescence 查询入口（SideEffectAuthority.lifecycle 就是本对象）。 */
  isQuiesced(instanceId) {
    const id = instanceId ? String(instanceId) : "";
    if (!id) return { quiesced: false, reason: "NO_ORIGIN_RUNTIME", proof: { type: "NO_ORIGIN_RUNTIME" } };
    if (!this.#rehydrated) return { quiesced: false, reason: "LIFECYCLE_NOT_READY", proof: { type: "LIFECYCLE_NOT_READY", instanceId: id } };
    return this.#lifecycle.isQuiesced(id);
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

module.exports = { RuntimeSupervisor, EXECUTOR_STATUS, EXECUTOR_ENTRY, probeUnixSocket };
