"use strict";
/**
 * task-34 F03 · 项目 Agent 后台 worker。
 *
 * 持久队列（project_agent_jobs）+ 租约/心跳 + checkpoint。恢复语义：
 *   · lease 过期且没有回填结果 → attempts+1 回到 queued；已执行副作用不会自动重试（由 runJob 自己按 checkpoint 判定）；
 *   · 失败/取消落 finished_at，状态可查。
 * 本模块不自己跑模型；runJob 由宿主注入（与 agent-service 的 project agent mode 同一路径）。
 */
const crypto = require("node:crypto");
const { dxosDdl } = require("./dxos-foundation-schema.cjs");

const LEASE_MS = 5 * 60 * 1000;

function ensureProjectAgentJobTable(db) {
  for (const statement of dxosDdl()) if (/project_agent_jobs/.test(statement)) db.exec(statement);
  return true;
}

function createProjectAgentWorker({ db, runJob = null, clock = () => Date.now(), leaseMs = LEASE_MS, idFactory = () => crypto.randomUUID() } = {}) {
  if (!db || typeof db.prepare !== "function") throw new Error("createProjectAgentWorker 需要 sqlite 连接");
  ensureProjectAgentJobTable(db);
  const now = () => Number(clock());

  function enqueue({ projectId, taskId = null, userId, instruction, runAt = null } = {}) {
    const id = "paj_" + idFactory();
    const ts = runAt == null ? now() : Number(runAt);
    db.prepare("INSERT INTO project_agent_jobs(id,project_id,task_id,user_id,status,instruction,attempts,created_at,updated_at) VALUES (?,?,?,?, 'queued', ?,0,?,?)")
      .run(id, String(projectId), taskId == null ? null : String(taskId), String(userId), String(instruction), ts, ts);
    return jobById(id);
  }

  function jobById(id) { return db.prepare("SELECT * FROM project_agent_jobs WHERE id=?").get(String(id)) || null; }
  function listJobs({ status = null, limit = 100 } = {}) {
    if (status) return db.prepare("SELECT * FROM project_agent_jobs WHERE status=? ORDER BY created_at,id LIMIT ?").all(String(status), Number(limit) || 100);
    return db.prepare("SELECT * FROM project_agent_jobs ORDER BY created_at,id LIMIT ?").all(Number(limit) || 100);
  }

  function claimNext(workerId) {
    const id = "wk_" + String(workerId || idFactory());
    const ts = now();
    return db.transaction ? (() => {
      const row = db.prepare("SELECT * FROM project_agent_jobs WHERE status='queued' AND created_at<=? ORDER BY created_at,id LIMIT 1").get(ts);
      if (!row) return null;
      db.prepare("UPDATE project_agent_jobs SET status='running',worker_id=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='queued'").run(id, ts + Number(leaseMs), ts, row.id);
      return jobById(row.id);
    })() : (() => {
      const row = db.prepare("SELECT * FROM project_agent_jobs WHERE status='queued' AND created_at<=? ORDER BY created_at,id LIMIT 1").get(ts);
      if (!row) return null;
      db.prepare("UPDATE project_agent_jobs SET status='running',worker_id=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='queued'").run(id, ts + Number(leaseMs), ts, row.id);
      return jobById(row.id);
    })();
  }

  function heartbeat(id, workerId) {
    const ts = now();
    const result = db.prepare("UPDATE project_agent_jobs SET lease_until=?,updated_at=? WHERE id=? AND status='running' AND worker_id=?").run(ts + Number(leaseMs), ts, String(id), String(workerId));
    return Number(result.changes) > 0 ? jobById(id) : null;
  }

  function saveCheckpoint(id, checkpoint) {
    const ts = now();
    db.prepare("UPDATE project_agent_jobs SET checkpoint_json=?,updated_at=? WHERE id=?").run(JSON.stringify(checkpoint == null ? null : checkpoint), ts, String(id));
    return jobById(id);
  }

  function finish(id, { status = "completed", result = null, error = null } = {}) {
    if (!["completed", "failed", "cancelled", "waiting"].includes(String(status))) throw new Error("非法 job 状态：" + status);
    const ts = now();
    db.prepare("UPDATE project_agent_jobs SET status=?,result_json=?,error_message=?,lease_until=NULL,finished_at=?,updated_at=? WHERE id=?")
      .run(String(status), result == null ? null : JSON.stringify(result), error == null ? null : String(error), status === "waiting" ? null : ts, ts, String(id));
    return jobById(id);
  }

  /** lease 过期：已执行副作用不自动重试，标记 failed 供人工恢复；无副作用才回 queued 由调用方决定。 */
  function recoverExpired({ retry = false } = {}) {
    const ts = now();
    const expired = db.prepare("SELECT * FROM project_agent_jobs WHERE status='running' AND lease_until IS NOT NULL AND lease_until < ?").all(ts);
    let recovered = 0;
    for (const job of expired) {
      if (retry && job.attempts < 3) {
        db.prepare("UPDATE project_agent_jobs SET status='queued',worker_id=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(ts, job.id);
      } else {
        db.prepare("UPDATE project_agent_jobs SET status='failed',error_message=COALESCE(error_message,'LEASE_EXPIRED'),worker_id=NULL,lease_until=NULL,finished_at=?,updated_at=? WHERE id=?").run(ts, ts, job.id);
      }
      recovered += 1;
    }
    return recovered;
  }

  async function runOnce(workerId) {
    if (typeof runJob !== "function") throw new Error("project agent worker 未注入 runJob");
    const job = claimNext(workerId);
    if (!job) return null;
    try {
      const result = await runJob(job, { heartbeat: () => heartbeat(job.id, job.worker_id), saveCheckpoint: (checkpoint) => saveCheckpoint(job.id, checkpoint) });
      if (result && result.waitingForUser === true) return finish(job.id, { status: "waiting", result });
      return finish(job.id, { status: "completed", result });
    } catch (error) {
      return finish(job.id, { status: "failed", error: String((error && error.message) || error) });
    }
  }

  return { enqueue, claimNext, heartbeat, saveCheckpoint, finish, recoverExpired, runOnce, jobById, listJobs };
}

module.exports = { createProjectAgentWorker, ensureProjectAgentJobTable, LEASE_MS };
