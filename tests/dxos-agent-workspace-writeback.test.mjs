/**
 * P1 · 修 agent-runtime-workspace 的步骤产物写回 bug（全离线；不联网、不新增依赖）。
 *
 * 旧代码（修复前）：
 *   :322 从 dx_task_steps 读步骤，
 *   :328 却写 core 的 tasks_steps SET output_json=? WHERE id=?（core 表既没有 output_json 列，
 *        主键也叫 step_id），异常被 :329 的 catch {} 吞掉 → 提交产物从未写回步骤。
 *
 * 修复后：
 *   · 经单一写入口 task-authority 路由到 agent-task-store，写 dx_task_steps.output_json；
 *   · 移除吞异常的 catch：坏 JSON / 写回依赖缺失都抛出结构化错误。
 *
 * 三条断言：
 *   1) 提交后产物坐标确实出现在对应 dx 步骤的 output_json 里，并可读回；
 *   2) 步骤 JSON 损坏 → 提交抛 AGENT_STEP_JSON_INVALID（不是静默跳过）；
 *   3) dx 写回 store 不可用 → 提交抛 AGENT_DEPENDENCY_UNAVAILABLE（不是静默成功）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const deps = require("../electron/agent-runtime-deps.cjs");
const workspace = require("../electron/agent-runtime-workspace.cjs");
const agentTaskStore = require("../electron/agent-task-store.cjs");

let clockTick = 1_700_000_000_000;
function nextClock() { clockTick += 1; return clockTick; }

const IDs = [];
after(() => { for (const ids of IDs) { try { ids.close(); } catch { /* 已关闭 */ } } });

/** 真 IdentityStore：迁移链同时建出 core 三表与 dx 三表（修复前的错误写目标真实存在且缺列）。 */
function newDb() {
  const identity = new IdentityStore({ path: ":memory:", clock: nextClock }).open();
  IDs.push(identity);
  return identity.connection;
}

/** 注入式假虚拟文件树：满足 agent-runtime-workspace.cjs 顶部 fsAdapter 契约。 */
function createFakeFs() {
  let seq = 0;
  let tick = 0;
  const nodes = new Map();
  const blobs = new Map();
  const state = { revision: 0, lastCommitId: null };
  const control = { publishConflict: false };
  const nextId = () => "n" + (++seq);
  function mk(name, type, parentId, ownerId, extra = {}, forcedId) {
    const id = forcedId || nextId();
    const node = { id, name, type, parentId: parentId ?? null, ownerId: ownerId ?? null, content: undefined, mime: undefined, blob: undefined, trashed: false, updated_ts: ++tick, ...extra };
    nodes.set(id, node);
    return node;
  }
  const childrenOf = (parentId) => [...nodes.values()].filter((n) => n.parentId === parentId && !n.trashed);
  const systemRoot = mk("system-root", "folder", null, "system");
  function getNode(id) { return nodes.get(id) || null; }
  function listChildren(parentId) { return { nodes: childrenOf(parentId) }; }
  function ensureSystemRoot() { return systemRoot; }
  function ensureFolder(name, parentId, ownerId) {
    const found = childrenOf(parentId).find((n) => n.type === "folder" && n.name === name);
    return found || mk(name, "folder", parentId, ownerId);
  }
  function createNode({ name, type, parentId, ownerId }) { return mk(name, type, parentId, ownerId); }
  function findByPath(rootId, path) {
    const parts = String(path).split("/").filter(Boolean);
    let cur = getNode(rootId);
    for (const part of parts) { if (!cur) return null; cur = childrenOf(cur.id).find((n) => n.name === part) || null; }
    return cur;
  }
  function copyNode(nodeId, targetParentId) {
    const src = getNode(nodeId);
    if (!src) throw new Error("copyNode: 源节点不存在");
    const copy = mk(src.name, src.type, targetParentId, src.ownerId, { content: src.content, mime: src.mime, blob: src.blob });
    if (src.type === "folder") for (const child of childrenOf(src.id)) copyNode(child.id, copy.id);
    return copy;
  }
  function readBlob(nodeId) { const node = getNode(nodeId); return node && node.blob ? node.blob : null; }
  function stageContentAddressedBlob(data, sha256) {
    const hex = sha256 || createHash("sha256").update(data).digest("hex");
    blobs.set(hex, Buffer.from(data));
    return { sha256: hex };
  }
  function getFsCommitState() { return { revision: state.revision, lastCommitId: state.lastCommitId }; }
  function prepareFsArtifactBatchPlan(rootId, writes, record) {
    const baseRevision = record && Number.isFinite(Number(record.baseRevision)) ? Number(record.baseRevision) : state.revision;
    const upserts = [];
    const resultNodeIds = {};
    for (const write of writes) {
      const existing = findByPath(rootId, write.path);
      const nodeId = existing ? existing.id : nextId();
      resultNodeIds[write.path] = nodeId;
      upserts.push({ ...write, nodeId, existing: Boolean(existing) });
    }
    return { rootId, baseRevision, targetRevision: baseRevision + 1, upserts, resultNodeIds };
  }
  function serializeFsArtifactBatchPlan(plan) {
    return { rootId: plan.rootId, baseRevision: plan.baseRevision, targetRevision: plan.targetRevision, upserts: plan.upserts, resultNodeIds: plan.resultNodeIds };
  }
  function applyWrite(rootId, write) {
    const existing = findByPath(rootId, write.path);
    if (existing) {
      if (write.kind === "text") { existing.content = write.content; existing.updated_ts = ++tick; }
      else { existing.blob = blobs.get(write.blobSha256); existing.mime = write.mime; existing.updated_ts = ++tick; }
      return existing.id;
    }
    const parts = String(write.path).split("/");
    const fileName = parts.pop();
    const parent = parts.length ? findByPath(rootId, parts.join("/")) : getNode(rootId);
    if (!parent) throw new Error("missing parent for " + write.path);
    const node = write.kind === "text"
      ? mk(fileName, "file", parent.id, write.ownerId, { content: write.content }, write.nodeId)
      : mk(fileName, "file", parent.id, write.ownerId, { mime: write.mime, blob: blobs.get(write.blobSha256) }, write.nodeId);
    return node.id;
  }
  function publishFsArtifactBatchPlan(plan, commitId, onPublished) {
    if (control.publishConflict) throw Object.assign(new Error("FS 提交冲突"), { code: "FS_REVISION_CONFLICT" });
    for (const write of plan.upserts) applyWrite(plan.rootId, write);
    state.revision = plan.targetRevision;
    state.lastCommitId = commitId;
    if (onPublished) onPublished();
    return plan.resultNodeIds;
  }
  function collectOrphanContentBlobs() { return { removed: [], kept: [...blobs.keys()] }; }
  return {
    control, nodes, blobs,
    getNode, listChildren, ensureSystemRoot, ensureFolder, createNode, findByPath, copyNode,
    readBlob, stageContentAddressedBlob, getFsCommitState, prepareFsArtifactBatchPlan,
    serializeFsArtifactBatchPlan, publishFsArtifactBatchPlan, collectOrphanContentBlobs,
  };
}

function createRunStore(db) {
  return {
    getAgentRun(runId) {
      const row = db.prepare("SELECT * FROM agent_runs WHERE id=?").get(runId);
      if (!row) return undefined;
      return { id: row.id, taskId: row.task_id || undefined, projectId: row.project_id || undefined, userId: row.user_id || undefined };
    },
    appendAgentRunEvent() { return {}; },
  };
}

const RUN_ID = "run-wb";
const TASK_ID = "task-wb";
const STEP_ID = "step-wb";

/**
 * 真库 + 假文件树 + 一条属于 run.task 的 dx 步骤。
 * @param {{ stepInput?: string }} options
 */
function setup(options = {}) {
  deps.resetAgentRuntimeForTests();
  const db = newDb();
  const fsAdapter = createFakeFs();
  const projectRoot = fsAdapter.createNode({ name: "project", type: "folder", parentId: null, ownerId: "u1" });
  const fileA = fsAdapter.createNode({ name: "a.txt", type: "file", parentId: projectRoot.id, ownerId: "u1" });
  fileA.content = "v1";
  agentTaskStore.resetAgentTaskStoreForTests();
  agentTaskStore.configureAgentTaskStore({ db, clock: nextClock, idFactory: randomUUID });
  db.prepare("INSERT INTO dx_task_steps(id,task_id,ordinal,title,tool_name,input_json,status,operation_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(STEP_ID, TASK_ID, 1, "写 a.txt", "file.write", options.stepInput === undefined ? JSON.stringify({ path: "a.txt" }) : options.stepInput, "queued", TASK_ID + ":1", nextClock());
  db.prepare("INSERT INTO agent_runs(id,correlation_id,session_id,task_id,project_id,app_id,user_id,entry_point,status,goal,context_json,capability_count,created_at,updated_at,root_run_id,capability_ids_json,delegation_depth) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(RUN_ID, "corr", null, TASK_ID, "p1", "app", "u1", "desktop", "created", "g", "[]", 0, nextClock(), nextClock(), RUN_ID, "[]", 0);
  deps.configureAgentRuntime({ db, runStore: createRunStore(db), fsAdapter, clock: nextClock, idFactory: randomUUID });
  return { db, fsAdapter, projectRootId: projectRoot.id };
}

/** ensure → 改工作区副本 → stage → validate。 */
function stageAndValidate(s) {
  const ws = workspace.ensureRunWorkspace(RUN_ID, "p1", s.projectRootId, "u1");
  s.fsAdapter.findByPath(ws.workspaceRootId, "a.txt").content = "v2";
  const staged = workspace.stageRunArtifact(RUN_ID, "a.txt");
  const validated = workspace.validateRunArtifact(RUN_ID, staged.id);
  assert.equal(validated.status, "validated");
  return { ws, staged };
}

test("写回往返：提交后产物坐标写进 dx_task_steps.output_json，并可读回", () => {
  const s = setup();
  const { staged } = stageAndValidate(s);
  const committed = workspace.commitRunArtifact(RUN_ID, staged.id, "u1");
  assert.equal(committed.status, "committed");
  assert.ok(committed.committedNodeId);
  // 关键断言：旧代码写 core task_steps 的 output_json，那里根本不存在；现在必须落在 dx_task_steps。
  const step = s.db.prepare("SELECT output_json FROM dx_task_steps WHERE id=?").get(STEP_ID);
  const output = JSON.parse(step.output_json);
  assert.equal(output.nodeId, committed.committedNodeId);
  assert.equal(output.name, "a.txt");
  // 正式项目确实写入。
  assert.equal(s.fsAdapter.findByPath(s.projectRootId, "a.txt").content, "v2");
  // 佐证旧写目标是错的：core task_steps 没有 output_json 列，也没有 id 列。
  const coreColumns = s.db.prepare("PRAGMA table_info(task_steps)").all().map((column) => column.name);
  assert.equal(coreColumns.includes("output_json"), false, "core task_steps 确实没有 output_json");
  assert.equal(coreColumns.includes("id"), false, "core task_steps 主键叫 step_id，不是 id");
  assert.throws(() => s.db.prepare("UPDATE task_steps SET output_json=? WHERE id=?").run("{}", STEP_ID), /no such column/, "旧 SQL 本身就必须报错");
});

test("失败可见：步骤 input_json 损坏 → 提交抛结构化 AGENT_STEP_JSON_INVALID，不静默", () => {
  const s = setup({ stepInput: "not-json" });
  const { staged } = stageAndValidate(s);
  assert.throws(
    () => workspace.commitRunArtifact(RUN_ID, staged.id, "u1"),
    (error) => {
      assert.equal(error.code, "AGENT_STEP_JSON_INVALID");
      assert.equal(error.stepId, STEP_ID);
      assert.equal(error.column, "input_json");
      return true;
    },
  );
  // 没有静默写入。
  assert.equal(s.db.prepare("SELECT output_json FROM dx_task_steps WHERE id=?").get(STEP_ID).output_json, null);
});

test("失败可见：dx 写回 store 不可用 → 提交抛 AGENT_DEPENDENCY_UNAVAILABLE，不静默成功", () => {
  const s = setup();
  const { staged } = stageAndValidate(s);
  agentTaskStore.resetAgentTaskStoreForTests(); // 模拟写回依赖缺失
  assert.throws(
    () => workspace.commitRunArtifact(RUN_ID, staged.id, "u1"),
    (error) => error.code === "AGENT_DEPENDENCY_UNAVAILABLE" && error.dependency === "db",
  );
  assert.equal(s.db.prepare("SELECT output_json FROM dx_task_steps WHERE id=?").get(STEP_ID).output_json, null);
});
