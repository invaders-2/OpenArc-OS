/**
 * D4-03C3 Closure · Runtime Quiescence / Liveness Authority（trusted）。
 *
 * 永久规则：**different runtime instance != proof that the previous runtime is dead**。
 * 只有本 Authority 真正观测到某个 runtime instance 的进程退出（supervisor-level liveness），
 * 才允许把它标记为 quiesced；否则一律 fail closed。
 *
 * 本 Authority 只回答一个问题：
 *   "Can an operation owned by <instanceId> still produce a late effect?"
 * 它 **不是** 第二套 side-effect state machine，不保存任何 side-effect 状态。
 *
 * 只保存 safe identifier（instanceId / status / exitCode / timestamps）；绝不存
 * PID secret / absolute path / token / credential / raw payload。
 */
"use strict";
const crypto = require("node:crypto");

const RUNTIME_STATUS = Object.freeze({ ACTIVE: "ACTIVE", EXITED: "EXITED" });

class RuntimeLifecycleAuthority {
  constructor({ clock = null, authorityId = null } = {}) {
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.authorityId = authorityId || "rla_" + crypto.randomBytes(6).toString("base64url");
    this.runtimes = new Map();
  }

  #now() { return this.clock(); }

  #proofFor(row) {
    return {
      type: "SUPERVISOR_OBSERVED_EXIT",
      instanceId: row.instanceId,
      endedAt: row.endedAt,
      exitCode: row.exitCode == null ? null : row.exitCode,
      signal: row.signal || null,
      authorityId: this.authorityId,
      observedAt: this.#now(),
    };
  }

  /** 注册一个 runtime instance（由 supervisor / 启动器调用）。 */
  registerRuntime(instanceId, { self = false, startedAt = null } = {}) {
    const id = String(instanceId || "");
    if (!id) return { ok: false, error: "INVALID_INPUT" };
    const row = { instanceId: id, status: RUNTIME_STATUS.ACTIVE, self: !!self, startedAt: startedAt == null ? this.#now() : Number(startedAt), endedAt: null, exitCode: null, signal: null };
    this.runtimes.set(id, row);
    return { ok: true, runtime: { ...row } };
  }

  /** 真实观测到进程退出（waitpid / child 'exit'）后调用。 */
  observeExit(instanceId, { exitCode = null, signal = null } = {}) {
    const id = String(instanceId || "");
    const row = this.runtimes.get(id);
    if (!row) return { ok: false, error: "UNKNOWN_RUNTIME" };
    row.status = RUNTIME_STATUS.EXITED;
    row.endedAt = this.#now();
    row.exitCode = exitCode == null ? null : Number(exitCode);
    row.signal = signal || null;
    return { ok: true, proof: this.#proofFor(row) };
  }

  /**
   * 唯一判定入口。只有真正观测到进程退出（EXITED）才 quiesced=true；
   * 未注册 / 仍 ACTIVE / self 一律 quiesced=false（fail closed）。
   */
  isQuiesced(instanceId) {
    const id = String(instanceId || "");
    if (!id) return { quiesced: false, reason: "NO_ORIGIN_RUNTIME", proof: { type: "NO_ORIGIN_RUNTIME" } };
    const row = this.runtimes.get(id);
    if (!row) return { quiesced: false, reason: "UNKNOWN_RUNTIME", proof: { type: "UNKNOWN_RUNTIME", instanceId: id } };
    if (row.status === RUNTIME_STATUS.EXITED) return { quiesced: true, reason: null, proof: this.#proofFor(row) };
    return { quiesced: false, reason: "RUNTIME_STILL_ACTIVE", proof: { type: "RUNTIME_STILL_ACTIVE", instanceId: id } };
  }

  snapshot() {
    return [...this.runtimes.values()].map((r) => ({ instanceId: r.instanceId, status: r.status, self: r.self, startedAt: r.startedAt, endedAt: r.endedAt, exitCode: r.exitCode }));
  }
}

module.exports = { RuntimeLifecycleAuthority, RUNTIME_STATUS };
