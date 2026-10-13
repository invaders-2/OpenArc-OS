"use strict";
/**
 * B3c · Run 工作区隔离与产物提交。
 *
 * 逐字移植 server/agent-runtime/workspaceStore.ts:1-469：
 *   getRunWorkspace / requireRunWorkspace / assertRunWorkspaceWrite / abandonRunWorkspace /
 *   ensureRunWorkspace / listRunArtifacts / artifactReviewState / recordReviewerDecision /
 *   stageRunArtifact / stageRunArtifactNode / validateRunArtifact / recoverAgentCommitJournals /
 *   collectOrphanAgentContentBlobs / commitRunArtifact / validateRunArtifacts /
 *   validateAndCommitRunArtifacts / setAgentCommitJournalFaultInjector
 *
 * 依赖替换：
 *   · 源 import { ccsDb }        -> 注入 db
 *   · 源 import fs.ts 全部函数   -> 注入 fsAdapter（B6 虚拟文件树）
 *   · 源 import runStore         -> 注入 taskStore（getAgentRun / appendAgentRunEvent）
 *
 * ---- fsAdapter 契约（B6 提供；未注入时本文件所有触盘能力抛 AGENT_DEPENDENCY_UNAVAILABLE）----
 *   FsNode = { id, name, type:'file'|'folder', parentId, ownerId?, content?, mime?, trashed?, updated_ts }
 *   getNode(id) -> FsNode|null
 *   listChildren(parentId) -> { nodes: FsNode[] }
 *   findByPath(rootId, path) -> FsNode|null
 *   ensureSystemRoot() -> FsNode
 *   ensureFolder(name, parentId, ownerId?) -> FsNode
 *   createNode({ name, type, parentId, ownerId }) -> FsNode
 *   copyNode(nodeId, targetParentId) -> FsNode
 *   readBlob(nodeId) -> Buffer|null
 *   stageContentAddressedBlob(data, sha256) -> { sha256 }
 *   getFsCommitState() -> { revision, lastCommitId }
 *   prepareFsArtifactBatchPlan(rootId, writes, record?) -> FsArtifactBatchPlan
 *   serializeFsArtifactBatchPlan(plan) -> FsArtifactBatchPlanRecord
 *   publishFsArtifactBatchPlan(plan, commitId, onPublished) -> void
 *   collectOrphanContentBlobs({ minAgeMs, dryRun, protectedHashes }) -> result
 */
const { createHash } = require("node:crypto");
const { requireDependency, runStoreFunction, transactImmediate } = require("./agent-runtime-deps.cjs");

function db() {
  return requireDependency("db");
}
function fs() {
  return requireDependency("fsAdapter");
}
function clock() {
  return requireDependency("clock")();
}
function idFactory() {
  return requireDependency("idFactory")();
}
function getAgentRun(runId) {
  return runStoreFunction("getAgentRun")(runId);
}
function appendAgentRunEvent(runId, type, data) {
  return runStoreFunction("appendAgentRunEvent")(runId, type, data);
}

/** 源 workspaceStore.ts:4-22 的路径守卫。 */
function safePath(value) {
  const path = String(value || "").replace(/\\/g, "/").trim();
  const parts = path.split("/");
  if (!path || path.startsWith("/") || /^[a-zA-Z]:/.test(path) || parts.some((part) => !part || part === "." || part === "..")) {
    throw Object.assign(new Error("Artifact 路径必须是 Workspace 内的规范相对路径"), { statusCode: 400 });
  }
  if (parts.some((part) => part === ".ccs-ai" || part === ".agent-workspaces")) throw Object.assign(new Error("Artifact 不能写入系统保留目录"), { statusCode: 400 });
  return path;
}

/** 源 workspaceStore.ts:24-29。 */
function fileData(node) {
  if (node.type !== "file") return Buffer.alloc(0);
  if (node.content !== undefined) return Buffer.from(node.content, "utf8");
  const blob = fs().readBlob(node.id);
  if (!blob) throw new Error("二进制文件内容缺失：" + node.name);
  return blob;
}

function sha(node) {
  return node.type === "file" ? createHash("sha256").update(fileData(node)).digest("hex") : undefined;
}

/** 源 workspaceStore.ts:35-47：遍历源根生成基线清单，跳过系统保留目录 .ccs-ai。 */
function manifest(rootId) {
  const result = {};
  const walk = (parentId, prefix) => {
    for (const node of fs().listChildren(parentId).nodes) {
      if (!prefix && node.name === ".ccs-ai") continue;
      const path = prefix ? prefix + "/" + node.name : node.name;
      result[path] = { type: node.type, sha256: sha(node), updatedTs: node.updated_ts };
      if (node.type === "folder") walk(node.id, path);
    }
  };
  walk(rootId, "");
  return result;
}

function workspaceRow(runId) {
  return db().prepare("SELECT run_id AS runId,project_id AS projectId,source_root_id AS sourceRootId,workspace_root_id AS workspaceRootId,user_id AS userId,status,base_manifest_json AS baseManifest,created_at AS createdAt,updated_at AS updatedAt,committed_at AS committedAt FROM agent_workspaces WHERE run_id=?").get(runId);
}

function publicWorkspace(row) {
  if (!row) return null;
  return { ...row, baseManifest: JSON.parse(row.baseManifest || "{}"), committedAt: row.committedAt || undefined };
}

/** 源 workspaceStore.ts:86-88。 */
function getRunWorkspace(runId) {
  return publicWorkspace(workspaceRow(runId));
}

/** 源 workspaceStore.ts:90-99。userId 与 active 双重守卫。 */
function requireRunWorkspace(runId, userId, active = false) {
  const workspace = getRunWorkspace(runId);
  if (!workspace) throw Object.assign(new Error("Agent Workspace 不存在，请重新创建开发任务"), { statusCode: 404 });
  if (userId !== undefined && workspace.userId !== userId) throw Object.assign(new Error("没有该 Workspace 的访问或提交权限"), { statusCode: 403 });
  if (active && workspace.status !== "active") throw Object.assign(new Error("Agent Workspace 已关闭（" + workspace.status + "），请重新创建开发任务"), { statusCode: 409 });
  const root = fs().getNode(workspace.workspaceRootId);
  if (!root || root.type !== "folder" || root.trashed) throw Object.assign(new Error("Agent Workspace 根目录不存在或已删除"), { statusCode: 404 });
  return workspace;
}

/** 源 workspaceStore.ts:101-106：写越界（根不属于本 Run / 路径非法）在这里被拒绝。 */
function assertRunWorkspaceWrite(runId, userId, rootNodeId, path) {
  const workspace = requireRunWorkspace(runId, userId, true);
  if (workspace.workspaceRootId !== rootNodeId) throw Object.assign(new Error("文件工具根目录不属于当前 Run Workspace"), { statusCode: 403 });
  if (path !== undefined) safePath(path);
  return workspace;
}

/** 源 workspaceStore.ts:108-111。只改状态，不触盘。 */
function abandonRunWorkspace(runId) {
  db().prepare("UPDATE agent_workspaces SET status='abandoned',updated_at=? WHERE run_id=? AND status='active'").run(clock(), runId);
  return getRunWorkspace(runId);
}

/** 源 workspaceStore.ts:113-153：复制源项目到 .agent-workspaces/<userId>/<runId>，并落基线清单。 */
function ensureRunWorkspace(runId, projectId, sourceRootId, userId, seedRunId) {
  const existing = getRunWorkspace(runId);
  const run = getAgentRun(runId);
  if (!run || run.projectId !== projectId || run.userId !== userId) throw Object.assign(new Error("Agent Run 不属于当前 Workspace 范围"), { statusCode: 403 });
  if (existing) {
    if (existing.projectId !== projectId || existing.sourceRootId !== sourceRootId) throw Object.assign(new Error("Agent Workspace 不属于当前项目范围"), { statusCode: 403 });
    return requireRunWorkspace(runId, userId, true);
  }
  const source = fs().getNode(sourceRootId);
  if (!source || source.type !== "folder" || source.trashed) throw new Error("Workspace 源项目不存在");
  const seed = seedRunId ? getRunWorkspace(seedRunId) : null;
  const seedRun = seedRunId ? getAgentRun(seedRunId) : null;
  if (seedRunId && (!seed || !seedRun
    || seed.projectId !== projectId || seed.sourceRootId !== sourceRootId || seed.userId !== userId
    || seedRun.appId !== run.appId || seedRun.sessionId !== run.sessionId
    || (seedRun.rootRunId || seedRun.id) !== (run.rootRunId || run.id)
    || seedRun.parentRunId !== run.parentRunId)) {
    throw Object.assign(new Error("纠正 Workspace 来源不属于当前 Run 范围"), { statusCode: 403 });
  }
  const copyRootId = seed?.workspaceRootId || sourceRootId;
  const systemRoot = fs().ensureSystemRoot();
  const workspaceContainer = fs().ensureFolder(".agent-workspaces", systemRoot.id);
  const userContainer = fs().ensureFolder(userId, workspaceContainer, userId);
  const workspaceRoot = fs().createNode({ name: runId, type: "folder", parentId: userContainer, ownerId: userId });
  for (const node of fs().listChildren(copyRootId).nodes) if (node.name !== ".ccs-ai") fs().copyNode(node.id, workspaceRoot.id);
  const ts = clock();
  // 纠正 Run 必须沿用原 Producer 启动时的项目基线，不能把审查期间的并发修改误当作新基线。
  const base = seed?.baseManifest || manifest(sourceRootId);
  db().prepare("INSERT INTO agent_workspaces(run_id,project_id,source_root_id,workspace_root_id,user_id,status,base_manifest_json,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,?)")
    .run(runId, projectId, sourceRootId, workspaceRoot.id, userId, JSON.stringify(base), ts, ts);
  if (seedRunId) for (const artifact of listRunArtifacts(seedRunId)) {
    if (artifact.status === "committed") continue;
    // 新 ID、新哈希和 produced 状态；绝不继承旧审批、验证或提交节点。
    stageRunArtifact(runId, artifact.path);
  }
  return getRunWorkspace(runId);
}

function artifactRow(row) {
  return {
    id: String(row.id), runId: String(row.run_id), path: String(row.path), kind: row.kind === "binary" ? "binary" : "text",
    bytes: Number(row.bytes), sha256: String(row.sha256), baseSha256: row.base_sha256 ? String(row.base_sha256) : undefined, mime: row.mime ? String(row.mime) : undefined,
    status: row.status, validation: row.validation_json ? JSON.parse(String(row.validation_json)) : undefined,
    committedNodeId: row.committed_node_id ? String(row.committed_node_id) : undefined,
    errorMessage: row.error_message ? String(row.error_message) : undefined,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

/** 源 workspaceStore.ts:166-168。 */
function listRunArtifacts(runId) {
  return db().prepare("SELECT * FROM agent_artifacts WHERE run_id=? ORDER BY created_at,path").all(runId).map(artifactRow);
}

/** 源 workspaceStore.ts:170-190：Reviewer Gate 状态；哈希与当前产物不一致判 stale。 */
function artifactReviewState(runId) {
  const run = getAgentRun(runId);
  if (!run?.taskId) return { required: false, status: "not_required", decision: undefined };
  const reviewer = db().prepare("SELECT d.child_run_id AS reviewerRunId FROM agent_delegations d, json_each(d.depends_on_json) dependency WHERE d.agent_profile_id='reviewer' AND dependency.value=? ORDER BY d.created_at DESC LIMIT 1").get(run.taskId);
  if (!reviewer) return { required: false, status: "not_required", decision: undefined };
  const review = db().prepare("SELECT decision,artifact_hashes_json AS hashes,feedback,created_at AS reviewedAt FROM agent_artifact_reviews WHERE producer_run_id=? AND reviewer_run_id=?").get(runId, reviewer.reviewerRunId);
  if (!review) return { required: true, status: "pending", reviewerRunId: reviewer.reviewerRunId, decision: undefined };
  const currentHashes = JSON.stringify(listRunArtifacts(runId).map((item) => ({ id: item.id, sha256: item.sha256 })));
  if (review.hashes !== currentHashes) return {
    required: true, status: "stale", reviewerRunId: reviewer.reviewerRunId,
    decision: undefined, feedback: review.feedback || undefined, reviewedAt: review.reviewedAt,
  };
  return {
    required: true, status: review.decision, reviewerRunId: reviewer.reviewerRunId,
    decision: review.decision, feedback: review.feedback || undefined, reviewedAt: review.reviewedAt,
  };
}

/** 源 workspaceStore.ts:192-225：Reviewer 结论一次性写入，复审必须新 Run。 */
function recordReviewerDecision(reviewerRunId, output, userId) {
  const reviewer = getAgentRun(reviewerRunId);
  if (!reviewer?.taskId || reviewer.agentProfileId !== "reviewer" || reviewer.userId !== userId) throw Object.assign(new Error("无效的 Reviewer Run"), { statusCode: 403 });
  const decision = output && typeof output === "object" && output.approved === true ? "approved" : "rejected";
  const feedback = String((output && output.feedback) || "").slice(0, 4000);
  const task = db().prepare("SELECT depends_on_json FROM dx_tasks WHERE id=?").get(reviewer.taskId);
  const dependencies = task ? JSON.parse(task.depends_on_json || "[]") : [];
  const producerRuns = [];
  for (const taskId of dependencies) {
    const producer = db().prepare("SELECT id FROM agent_runs WHERE task_id=?").get(taskId);
    if (!producer) continue;
    const hashes = JSON.stringify(listRunArtifacts(producer.id).map((item) => ({ id: item.id, sha256: item.sha256 })));
    const existing = db().prepare("SELECT decision,artifact_hashes_json AS hashes,feedback FROM agent_artifact_reviews WHERE producer_run_id=? AND reviewer_run_id=?").get(producer.id, reviewerRunId);
    if (existing && (existing.decision !== decision || existing.hashes !== hashes || (existing.feedback || "") !== feedback)) {
      throw Object.assign(new Error("Reviewer 结论已经写入且不可改判；复审必须创建新的 Reviewer Run"), { statusCode: 409 });
    }
    if (!existing) db().prepare("INSERT INTO agent_artifact_reviews(id,producer_run_id,reviewer_run_id,decision,artifact_hashes_json,feedback,reviewed_by,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(idFactory(), producer.id, reviewerRunId, decision, hashes, feedback, userId, clock());
    if (decision === "rejected") db().prepare("UPDATE agent_artifacts SET status='rejected',error_message=?,updated_at=? WHERE run_id=? AND status!='committed'").run(feedback || "Reviewer 拒绝产物", clock(), producer.id);
    producerRuns.push(producer.id);
  }
  appendAgentRunEvent(reviewerRunId, decision === "approved" ? "review.approved" : "review.rejected", { producerRuns, feedback });
  return { reviewerRunId, decision, feedback, producerRuns };
}

/** 源 workspaceStore.ts:227-246：从 Workspace 文件节点登记产物（produced）。 */
function stageRunArtifact(runId, rawPath) {
  const workspace = requireRunWorkspace(runId, undefined, true);
  const path = safePath(rawPath);
  const node = fs().findByPath(workspace.workspaceRootId, path);
  if (!node || node.type !== "file") throw new Error("Workspace 中不存在产物：" + path);
  const data = fileData(node);
  const digest = createHash("sha256").update(data).digest("hex");
  const baseSha256 = workspace.baseManifest[path]?.sha256;
  const ts = clock();
  const existing = db().prepare("SELECT id,created_at FROM agent_artifacts WHERE run_id=? AND path=?").get(runId, path);
  const id = existing?.id || idFactory();
  db().prepare("INSERT INTO agent_artifacts(id,run_id,path,kind,mime,bytes,sha256,base_sha256,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'produced',?,?) ON CONFLICT(run_id,path) DO UPDATE SET kind=excluded.kind,mime=excluded.mime,bytes=excluded.bytes,sha256=excluded.sha256,base_sha256=excluded.base_sha256,status='produced',validation_json=NULL,committed_node_id=NULL,error_message=NULL,updated_at=excluded.updated_at")
    .run(id, runId, path, node.content !== undefined ? "text" : "binary", node.mime || null, data.byteLength, digest, baseSha256 || null, existing?.created_at || ts, ts);
  appendAgentRunEvent(runId, "artifact.created", { artifactId: id, path, bytes: data.byteLength, sha256: digest });
  return listRunArtifacts(runId).find((item) => item.id === id);
}

/** 源 workspaceStore.ts:248-260。 */
function stageRunArtifactNode(runId, nodeId) {
  const workspace = getRunWorkspace(runId);
  if (!workspace) throw new Error("Agent Workspace 不存在");
  const parts = [];
  let node = fs().getNode(nodeId);
  while (node && node.id !== workspace.workspaceRootId) {
    parts.unshift(node.name);
    node = node.parentId ? fs().getNode(node.parentId) : null;
  }
  if (!node || node.id !== workspace.workspaceRootId) throw Object.assign(new Error("Artifact 节点不属于当前 Run Workspace"), { statusCode: 403 });
  return stageRunArtifact(runId, parts.join("/"));
}

/** 源 workspaceStore.ts:262-273：哈希 / 大小 / mime 三重校验，产出 validated 或 rejected。 */
function validateRunArtifact(runId, artifactId) {
  const workspace = getRunWorkspace(runId);
  const artifact = listRunArtifacts(runId).find((item) => item.id === artifactId);
  if (!workspace || !artifact) throw Object.assign(new Error("Artifact 不存在"), { statusCode: 404 });
  const node = fs().findByPath(workspace.workspaceRootId, artifact.path);
  let digest;
  try {
    digest = node?.type === "file" ? sha(node) : undefined;
  } catch {
    digest = undefined;
  }
  const sizeLimit = artifact.kind === "binary" ? 512 * 1024 * 1024 : 10 * 1024 * 1024;
  const ok = Boolean(node?.type === "file" && digest === artifact.sha256 && artifact.bytes <= sizeLimit && (artifact.kind === "text" || node?.mime === artifact.mime));
  const validation = { pathSafe: true, fileExists: Boolean(node), hashMatches: digest === artifact.sha256, mimeMatches: artifact.kind === "text" || node?.mime === artifact.mime, sizeAllowed: artifact.bytes <= sizeLimit };
  db().prepare("UPDATE agent_artifacts SET status=?,validation_json=?,error_message=?,updated_at=? WHERE id=? AND run_id=?")
    .run(ok ? "validated" : "rejected", JSON.stringify(validation), ok ? null : "Artifact 完整性或大小校验失败", clock(), artifactId, runId);
  return listRunArtifacts(runId).find((item) => item.id === artifactId);
}

// ---------------------------------------------------------------------------
// Commit Journal（源 workspaceStore.ts:275-378）
// ---------------------------------------------------------------------------

let commitJournalFaultInjector;

/** 仅供 crash-window smoke 注入；生产代码不设置此钩子。 */
function setAgentCommitJournalFaultInjector(injector) {
  commitJournalFaultInjector = injector;
}

function journalRow(row) {
  return {
    id: String(row.id), runId: String(row.run_id), projectId: String(row.project_id), userId: String(row.user_id),
    status: row.status, baseRevision: Number(row.base_revision), targetRevision: Number(row.target_revision),
    artifactIds: String(row.artifact_ids_json), planJson: String(row.plan_json),
  };
}

function finalizeCommitJournal(journal) {
  const artifactIds = JSON.parse(journal.artifactIds);
  const plan = JSON.parse(journal.planJson);
  const workspace = getRunWorkspace(journal.runId);
  if (!workspace || workspace.projectId !== journal.projectId || workspace.userId !== journal.userId) throw new Error("Commit Journal 的 Workspace 范围已失效");
  const run = getAgentRun(journal.runId);
  const ts = clock();
  transactImmediate(db(), () => {
    for (const artifactId of artifactIds) {
      const artifact = listRunArtifacts(journal.runId).find((item) => item.id === artifactId);
      if (!artifact) throw new Error("Commit Journal Artifact 不存在：" + artifactId);
      const nodeId = plan.resultNodeIds[artifact.path];
      if (!nodeId) throw new Error("Commit Journal 缺少目标节点：" + artifact.path);
      db().prepare("UPDATE agent_artifacts SET status='committed',committed_node_id=?,error_message=NULL,updated_at=? WHERE id=? AND run_id=?").run(nodeId, ts, artifactId, journal.runId);
      if (run?.taskId) {
        const source = fs().findByPath(workspace.workspaceRootId, artifact.path);
        const steps = db().prepare("SELECT id,input_json,output_json FROM dx_task_steps WHERE task_id=?").all(run.taskId);
        for (const step of steps) {
          try {
            const input = JSON.parse(step.input_json || "{}");
            const output = JSON.parse(step.output_json || "{}");
            if (output.nodeId !== source?.id && safePath(String(input.path || "")) !== artifact.path) continue;
            db().prepare("UPDATE task_steps SET output_json=? WHERE id=?").run(JSON.stringify({ ...output, nodeId, name: artifact.path.split("/").at(-1) }), step.id);
          } catch {
            /* non-file step */
          }
        }
        if (source) db().prepare("UPDATE deliverables SET node_id=?,updated_at=? WHERE task_id=? AND node_id=?").run(nodeId, ts, run.taskId, source.id);
      }
    }
    if (!db().prepare("SELECT 1 FROM agent_artifacts WHERE run_id=? AND status!='committed'").get(journal.runId)) {
      db().prepare("UPDATE agent_workspaces SET status='committed',committed_at=?,updated_at=? WHERE run_id=?").run(ts, ts, journal.runId);
    }
    db().prepare("UPDATE agent_commit_journals SET status='completed',published_at=COALESCE(published_at,?),completed_at=?,updated_at=?,error_message=NULL WHERE id=?").run(ts, ts, ts, journal.id);
  });
}

function markJournalConflict(journal, message) {
  const ts = clock();
  const artifactIds = JSON.parse(journal.artifactIds);
  transactImmediate(db(), () => {
    db().prepare("UPDATE agent_commit_journals SET status='conflicted',error_message=?,updated_at=? WHERE id=? AND status IN ('prepared','published')").run(message, ts, journal.id);
    for (const artifactId of artifactIds) db().prepare("UPDATE agent_artifacts SET status='conflicted',error_message=?,updated_at=? WHERE id=? AND status!='committed'").run(message, ts, artifactId);
    db().prepare("UPDATE agent_workspaces SET status='conflicted',updated_at=? WHERE run_id=? AND status='active'").run(ts, journal.runId);
  });
}

/** 源 workspaceStore.ts:306-329：崩溃窗口恢复；只有已知冲突码才降级为 conflicted。 */
function recoverAgentCommitJournals() {
  const rows = db().prepare("SELECT * FROM agent_commit_journals WHERE status IN ('prepared','published') ORDER BY created_at,id").all().map(journalRow);
  const recovered = [];
  const conflicted = [];
  for (const journal of rows) {
    const record = JSON.parse(journal.planJson);
    const fsState = fs().getFsCommitState();
    try {
      let plan;
      if (fsState.revision === journal.targetRevision && fsState.lastCommitId === journal.id) plan = { ...record, targetNodes: [] };
      else if (fsState.revision === journal.baseRevision) plan = fs().prepareFsArtifactBatchPlan(record.rootId, [], record);
      else throw Object.assign(new Error("Commit Journal 恢复冲突：基线 " + journal.baseRevision + "，当前 " + fsState.revision), { code: "FS_REVISION_CONFLICT" });
      fs().publishFsArtifactBatchPlan(plan, journal.id, () => finalizeCommitJournal(journal));
      recovered.push(journal.id);
    } catch (error) {
      if (!["FS_REVISION_CONFLICT", "FS_PUBLISHED_MISMATCH", "BLOB_MISSING", "BLOB_INVALID"].includes(String(error?.code || ""))) throw error;
      markJournalConflict(journal, error instanceof Error ? error.message : String(error));
      conflicted.push(journal.id);
    }
  }
  return { recovered, conflicted };
}

/** 源 workspaceStore.ts:331-341。 */
function collectOrphanAgentContentBlobs(options = {}) {
  const protectedHashes = new Set();
  const rows = db().prepare("SELECT plan_json FROM agent_commit_journals WHERE status IN ('prepared','published')").all();
  for (const row of rows) {
    try {
      const plan = JSON.parse(row.plan_json);
      for (const node of plan.upserts || []) if (node.blobSha256) protectedHashes.add(node.blobSha256);
    } catch {
      /* malformed Journal will be handled by recovery, not GC */
    }
  }
  return fs().collectOrphanContentBlobs({ ...options, protectedHashes });
}

/** 源 workspaceStore.ts:343-378。 */
function commitArtifactsWithJournal(runId, artifactIds, userId) {
  recoverAgentCommitJournals();
  const workspace = requireRunWorkspace(runId, userId);
  const artifacts = artifactIds.map((id) => listRunArtifacts(runId).find((item) => item.id === id));
  if (artifacts.some((artifact) => !artifact)) throw Object.assign(new Error("Artifact 不存在"), { statusCode: 404 });
  const pending = artifacts.filter((artifact) => artifact.status !== "committed");
  if (!pending.length) return artifactIds.map((id) => listRunArtifacts(runId).find((item) => item.id === id));
  requireRunWorkspace(runId, userId, true);
  if (pending.some((artifact) => artifact.status !== "validated")) throw Object.assign(new Error("只有通过验证的 Artifact 才能提交"), { statusCode: 409 });
  const review = artifactReviewState(runId);
  if (review.required && review.decision !== "approved") throw Object.assign(new Error(review.decision === "rejected" ? "Reviewer 已拒绝该 Artifact" : "Artifact 尚未通过 Reviewer Gate"), { statusCode: 409 });
  const writes = pending.map((artifact) => {
    const source = fs().findByPath(workspace.workspaceRootId, artifact.path);
    if (!source || source.type !== "file" || sha(source) !== artifact.sha256) throw Object.assign(new Error("Workspace Artifact 已变化：" + artifact.path), { statusCode: 409 });
    const current = fs().findByPath(workspace.sourceRootId, artifact.path);
    const base = workspace.baseManifest[artifact.path];
    const currentSha = current?.type === "file" ? sha(current) : undefined;
    if ((base && (current?.type !== "file" || currentSha !== base.sha256)) || (!base && current)) throw Object.assign(new Error("正式项目中的 " + artifact.path + " 已在 Run 执行期间变化，整批提交已取消"), { statusCode: 409 });
    if (artifact.kind === "text") {
      if (source.content === undefined) throw Object.assign(new Error("Workspace 文本 Artifact 存储形式已变化：" + artifact.path), { statusCode: 409 });
      return { kind: "text", path: artifact.path, content: source.content, ownerId: userId };
    }
    const data = fs().readBlob(source.id);
    if (!data) throw Object.assign(new Error("Workspace 二进制 Artifact 缺失：" + artifact.path), { statusCode: 409 });
    const staged = fs().stageContentAddressedBlob(data, artifact.sha256);
    return { kind: "binary", path: artifact.path, blobSha256: staged.sha256, mime: artifact.mime || source.mime || "application/octet-stream", bytes: data.byteLength, ownerId: userId };
  });
  commitJournalFaultInjector?.("after_blob_prepare");
  const plan = fs().prepareFsArtifactBatchPlan(workspace.sourceRootId, writes);
  const id = idFactory();
  const ts = clock();
  db().prepare("INSERT INTO agent_commit_journals(id,run_id,project_id,user_id,status,base_revision,target_revision,artifact_ids_json,plan_json,created_at,updated_at) VALUES (?,?,?,?,'prepared',?,?,?,?,?,?)")
    .run(id, runId, workspace.projectId, userId, plan.baseRevision, plan.targetRevision, JSON.stringify(pending.map((item) => item.id)), JSON.stringify(fs().serializeFsArtifactBatchPlan(plan)), ts, ts);
  const journal = journalRow(db().prepare("SELECT * FROM agent_commit_journals WHERE id=?").get(id));
  commitJournalFaultInjector?.("after_prepare");
  try {
    fs().publishFsArtifactBatchPlan(plan, id, () => {
      commitJournalFaultInjector?.("after_publish");
      finalizeCommitJournal(journal);
    });
  } catch (error) {
    if (["FS_REVISION_CONFLICT", "FS_PUBLISHED_MISMATCH", "BLOB_MISSING", "BLOB_INVALID"].includes(String(error?.code || ""))) markJournalConflict(journal, error instanceof Error ? error.message : String(error));
    throw error;
  }
  return artifactIds.map((artifactId) => listRunArtifacts(runId).find((item) => item.id === artifactId));
}

/** 源 workspaceStore.ts:380-386。 */
function commitRunArtifact(runId, artifactId, userId) {
  requireRunWorkspace(runId, userId);
  const artifact = listRunArtifacts(runId).find((item) => item.id === artifactId);
  if (!artifact) throw Object.assign(new Error("Artifact 不存在"), { statusCode: 404 });
  if (artifact.status === "committed") return artifact;
  return commitArtifactsWithJournal(runId, [artifactId], userId)[0];
}

/** 源 workspaceStore.ts:388-409：验证 + 冲突探测（源项目在 Run 期间被改动即整批取消）。 */
function validateRunArtifacts(runId, userId) {
  const workspace = requireRunWorkspace(runId, userId);
  if (listRunArtifacts(runId).some((artifact) => artifact.status !== "committed")) requireRunWorkspace(runId, userId, true);
  const validated = listRunArtifacts(runId).map((artifact) => artifact.status === "produced" ? validateRunArtifact(runId, artifact.id) : artifact);
  for (const artifact of validated) {
    if (artifact.status === "rejected") throw new Error("Artifact 验证失败：" + artifact.path);
    if (artifact.status === "committed") continue;
    if (artifact.status !== "validated") throw new Error("Artifact 尚未通过验证：" + artifact.path);
    const source = fs().findByPath(workspace.workspaceRootId, artifact.path);
    if (!source || source.type !== "file" || sha(source) !== artifact.sha256) throw new Error("Artifact 完整性已变化：" + artifact.path);
    const current = fs().findByPath(workspace.sourceRootId, artifact.path);
    const base = workspace.baseManifest[artifact.path];
    const currentSha = current?.type === "file" ? sha(current) : undefined;
    if ((base && (current?.type !== "file" || currentSha !== base.sha256)) || (!base && current)) {
      throw Object.assign(new Error("正式项目中的 " + artifact.path + " 已在 Run 执行期间变化，整批提交已取消"), { statusCode: 409 });
    }
  }
  return validated;
}

/** 源 workspaceStore.ts:411-415。 */
function validateAndCommitRunArtifacts(runId, userId) {
  const validated = validateRunArtifacts(runId, userId);
  commitArtifactsWithJournal(runId, validated.map((artifact) => artifact.id), userId);
  return validated.map((artifact) => listRunArtifacts(runId).find((current) => current.id === artifact.id));
}

module.exports = {
  safePath,
  getRunWorkspace,
  requireRunWorkspace,
  assertRunWorkspaceWrite,
  abandonRunWorkspace,
  ensureRunWorkspace,
  listRunArtifacts,
  artifactReviewState,
  recordReviewerDecision,
  stageRunArtifact,
  stageRunArtifactNode,
  validateRunArtifact,
  recoverAgentCommitJournals,
  collectOrphanAgentContentBlobs,
  commitRunArtifact,
  validateRunArtifacts,
  validateAndCommitRunArtifacts,
  setAgentCommitJournalFaultInjector,
};
